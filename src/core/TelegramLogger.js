'use strict';
const { escapeHtml } = require('./TelegramNotifier');
const RingBuffer = require('./RingBuffer');

/**
 * TelegramLogger — đẩy LOG RUNTIME (log của từng bot + log hệ thống của tool) lên Telegram.
 *
 *  - MỘT FILE DUY NHẤT (log_all.txt) chứa log của TẤT CẢ bot (+ log hệ thống), xếp theo thời gian, mỗi dòng ghi rõ bot nào.
 *    Đầu file có STATS SERVER (scoreboard: money, shard, kills...) của từng bot.
 *  - File được CẬP NHẬT TẠI CHỖ (sửa đúng 1 tin trong chat, không đẻ tin mới) theo chu kỳ tuỳ chọn: 10s / 30s / 1m / 1h...
 *    (telegram logs every <thời gian>). Chu kỳ chỉ là nhịp sửa file; không có gì mới (log + stats y hệt) thì bỏ qua, không gọi Telegram.
 *    File giữ N dòng mới nhất (mặc định 1000; telegram logs keep <n>) nên chu kỳ dài vẫn không mất log ở giữa.
 *  - Mỗi lần chạy tool tạo 1 file mới (file của lần chạy trước giữ nguyên làm lịch sử). Tin bị xoá thì tự gửi lại file mới.
 *  - Tin đầu tiên gửi IM LẶNG (không rung); các lần sửa không bao giờ rung — cảnh báo kick/hết reconnect... vẫn là tin riêng có thông báo đẩy.
 *  - Chống dội: dòng y hệt liên tiếp của cùng 1 bot gộp thành "(×N)"; tối đa N lần cập nhật/phút; hàng đợi Telegram bận
 *    hoặc đang bị 429 thì giữ lại, cập nhật sau. Gửi lỗi (mạng/Telegram) thì thử lại thưa dần — log nằm sẵn trong bộ nhớ nên không mất;
 *    không bao giờ làm bot chậm hay chết.
 *  - Tự che thông tin nhạy cảm: token Telegram, webhook Discord, mật khẩu trong /dn /dk /login..., user:pass@ của proxy,
 *    và mật khẩu bot đang cấu hình (nếu xuất hiện nguyên văn trong log).
 *  - Giữ 500 dòng gần nhất (mọi mức) để lệnh /logs xem lại theo yêu cầu (gửi file riêng, không đụng file chính).
 *
 * Chỉ dùng TelegramNotifier (sendDocument / editDocument: hàng đợi tuần tự + nghỉ khi 429). Không tự in ra console/log của bot
 * (tránh vòng lặp: lỗi gửi Telegram -> log -> gửi Telegram).
 */
const LEVELS = ['sys', 'ok', 'warn', 'err', 'afk', 'shard', 'proxy', 'health', 'chat'];
const PRESETS = {
  all: ['sys', 'ok', 'warn', 'err', 'afk', 'shard', 'proxy', 'health'], // mặc định — mọi thứ trừ chat của người chơi
  info: ['ok', 'warn', 'err', 'proxy', 'health'],                       // bỏ log thủ tục (sys/afk/shard)
  warn: ['warn', 'err', 'health'],
  err: ['err'],
};
const ALIASES = { error: 'err', errors: 'err', warning: 'warn', warnings: 'warn', system: 'sys', debug: 'sys' };
const ICONS = { sys: '⚙️', ok: '✅', warn: '⚠️', err: '❌', afk: '💤', shard: '✨', proxy: '🌐', health: '🩺', chat: '💬' };
const SYSTEM = 'system'; // nguồn log không thuộc bot nào (khởi động, tắt, lỗi chưa bắt được...)
const LABELS = { sys: 'SYS', ok: 'OK', warn: 'WARN', err: 'ERR', afk: 'AFK', shard: 'SHARD', proxy: 'PROXY', health: 'HEALTH', chat: 'CHAT' };

const DEFAULTS = { enabled: true, intervalSec: 10, silent: true, maxPerMin: 10, keepLines: 1000 };
const MIN_INTERVAL_SEC = 2;
const MAX_INTERVAL_SEC = 86400; // 24h
const MIN_KEEP = 50;
const MAX_KEEP = 5000;         // 5000 dòng ≈ 700KB — còn xa giới hạn 50MB của Telegram
const MAX_MSG = 500;           // ký tự tối đa của 1 dòng log
const MAX_MSG_LINES = 6;       // số dòng tối đa của 1 mục log nhiều dòng (bảng, stack trace)
const MAX_STAT_LINES = 40;     // số dòng stats server tối đa của mỗi bot
const FILE_NAME = 'log_all.txt';
const REFRESH_DATA = 'lg:now'; // callback_data của nút "Cập nhật ngay" (BotManager xử lý cmd 'lg')
const KEYBOARD = [[{ text: '🔄 Cập nhật ngay', callback_data: REFRESH_DATA }]];

// ----- che thông tin nhạy cảm -----
const REDACTIONS = [
  [/\b\d{6,12}:[\w-]{30,}/g, '<telegram-token>'],
  [/(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi, '$1***'],
  [/(\/(?:dn|dk|login|register|log|reg|l|changepassword|cp)\s+)\S+(?:\s+\S+)?/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1***@'],
];
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const MC_COLOR_RE = /§[0-9a-fk-orx]/gi;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Telegram trả message_id (số) khi thành công; null/đối tượng lỗi là thất bại
const validId = (id) => id !== null && id !== undefined && typeof id !== 'object';

class TelegramLogger {
  /**
   * @param notifier  TelegramNotifier (sendDocument, editDocument, enabled, paused, pending)
   * @param opts      { tz: () => 'Asia/Ho_Chi_Minh', secrets: () => ['mật khẩu bot', ...], recentSize,
   *                    botIds: () => ['bot-1', ...]  — danh sách bot hiện có (để ghi stats cả bot chưa có log),
   *                    stats: (botId) => { title, lines: ['MONEY 832.5M', ...] } | ['dòng', ...] | null  — stats server ghi đầu file }
   */
  constructor(notifier, opts = {}) {
    this.tg = notifier;
    this._tz = typeof opts.tz === 'function' ? opts.tz : () => 'Asia/Ho_Chi_Minh';
    this._secrets = typeof opts.secrets === 'function' ? opts.secrets : () => [];
    this._stats = typeof opts.stats === 'function' ? opts.stats : () => null;
    this._botIds = typeof opts.botIds === 'function' ? opts.botIds : () => [];
    this.recent = new RingBuffer(opts.recentSize || 500);
    this._feed = [];            // log trong file chính (đã qua bộ lọc), cũ -> mới
    this._seen = new Set();     // id các bot đã có log trong file (để ghi stats)
    this._dropped = 0;          // số dòng cũ đã bỏ vì file giữ tối đa keepLines dòng
    this._pending = 0;          // số mục log mới chưa lên file
    this._ver = 0;              // tăng mỗi khi log đổi -> so chữ ký để bỏ qua lần sửa thừa
    this._sigSent = null;       // chữ ký (log + stats) của lần cập nhật thành công gần nhất
    this._msgId = null;         // message_id của file đang cập nhật tại chỗ
    this._failStreak = 0;
    this._lastByBot = new Map();
    this._timer = null;
    this._dueAt = 0;
    this._holdUntil = 0;
    this._flushing = false;
    this._flushPromise = null;
    this._sentAt = [];
    this._fmtCache = new Map();
    this.stats = { created: 0, updates: 0, failed: 0, dropped: 0 };
    this.enabled = DEFAULTS.enabled;
    this.levels = new Set(PRESETS.all);
    this.bots = null;
    this.intervalMs = DEFAULTS.intervalSec * 1000;
    this.silent = DEFAULTS.silent;
    this.maxPerMin = DEFAULTS.maxPerMin;
    this.keepLines = DEFAULTS.keepLines;
    this.configure(opts);
  }

  static get LEVELS() { return LEVELS; }
  static get PRESETS() { return PRESETS; }
  static get SYSTEM() { return SYSTEM; }
  static get ICONS() { return ICONS; }
  static get FILE_NAME() { return FILE_NAME; }
  static get MIN_INTERVAL_SEC() { return MIN_INTERVAL_SEC; }
  static get MAX_INTERVAL_SEC() { return MAX_INTERVAL_SEC; }
  static get MIN_KEEP() { return MIN_KEEP; }
  static get MAX_KEEP() { return MAX_KEEP; }

  // "all" | "info" | "warn" | "err" | "warn,err,sys" | "all,chat"  ->  { ok, levels[] } | { ok:false, error }
  static parseLevels(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return { ok: false, error: 'Thiếu mức log' };
    const tokens = t.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 1 && PRESETS[ALIASES[tokens[0]] || tokens[0]]) return { ok: true, levels: [...PRESETS[ALIASES[tokens[0]] || tokens[0]]] }; // "warn" (một mình) = mẫu warn,err,health
    const out = [];
    for (const raw of tokens) {
      const k = ALIASES[raw] || raw;
      if (LEVELS.includes(k)) { out.push(k); continue; }   // trong danh sách, "warn"/"err" là đúng mức đó
      if (PRESETS[k]) { out.push(...PRESETS[k]); continue; } // "all", "info" mở rộng thành cả mẫu (vd all,chat)
      return { ok: false, error: `Mức "${raw}" không có. Mức: ${LEVELS.join(', ')} · mẫu: ${Object.keys(PRESETS).join(', ')}` };
    }
    return { ok: true, levels: [...new Set(out)] };
  }
  // Tên mẫu nếu tập mức khớp đúng 1 mẫu (để hiển thị), không thì null
  static presetOf(levels) {
    const s = [...levels].sort().join(',');
    return Object.keys(PRESETS).find(k => [...PRESETS[k]].sort().join(',') === s) || null;
  }
  // "10s" | "30s" | "2m" | "1h" | "1h30m" | "90" (số trần = giây) -> giây (null nếu không hiểu)
  static parseSeconds(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }
  // 10 -> "10s" · 60 -> "1m" · 3600 -> "1h" · 90 -> "1m30s"
  static fmtSeconds(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h ? h + 'h' : ''}${m ? m + 'm' : ''}${s || (!h && !m) ? s + 's' : ''}`;
  }

  // cfg: { enabled, levels (mảng | chuỗi), bots (mảng | null), intervalSec, silent, maxPerMin, keepLines } — thiếu thì dùng mặc định
  configure(cfg = {}) {
    let changed = false;
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled !== false;
    if (cfg.levels !== undefined && cfg.levels !== null) {
      let list = null;
      if (typeof cfg.levels === 'string') { const r = TelegramLogger.parseLevels(cfg.levels); if (r.ok) list = r.levels; }
      else if (cfg.levels instanceof Set || Array.isArray(cfg.levels)) {
        list = [...cfg.levels].map(x => ALIASES[String(x).toLowerCase()] || String(x).toLowerCase()).filter(x => LEVELS.includes(x));
      }
      this.levels = new Set(list && list.length ? list : PRESETS.all);
      changed = true;
    }
    if (cfg.bots !== undefined) {
      const list = Array.isArray(cfg.bots) ? cfg.bots.map(x => String(x).trim().toLowerCase()).filter(Boolean) : [];
      this.bots = list.length ? new Set(list) : null;
      changed = true;
    }
    if (cfg.intervalSec !== undefined && cfg.intervalSec !== null) {
      const s = Number(cfg.intervalSec);
      this.intervalMs = Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Number.isFinite(s) ? s : DEFAULTS.intervalSec)) * 1000;
      if (this._feed.length && this.enabled) this._arm(this.intervalMs); // đổi chu kỳ thì áp dụng ngay (đổi ngắn lại -> hẹn sớm hơn)
    }
    if (cfg.silent !== undefined) this.silent = cfg.silent !== false;
    if (cfg.maxPerMin !== undefined && cfg.maxPerMin !== null) {
      const n = Math.floor(Number(cfg.maxPerMin));
      this.maxPerMin = Math.min(20, Math.max(1, Number.isFinite(n) ? n : DEFAULTS.maxPerMin));
    }
    if (cfg.keepLines !== undefined && cfg.keepLines !== null) {
      const n = Math.floor(Number(cfg.keepLines));
      this.keepLines = Math.min(MAX_KEEP, Math.max(MIN_KEEP, Number.isFinite(n) ? n : DEFAULTS.keepLines));
      this._trim();
      changed = true;
    }
    if (changed && this._feed.length) this._touch(); // mức/bot/số dòng giữ đổi -> dựng lại file ở nhịp tới
    if (!this.enabled) this._clearBuffer();
    return this;
  }

  get active() { return !!(this.enabled && this.tg && this.tg.enabled); }
  get buffered() { return this._pending; } // số mục log mới chưa lên file

  status() {
    return {
      enabled: this.enabled, telegramReady: !!(this.tg && this.tg.enabled),
      levels: [...this.levels], preset: TelegramLogger.presetOf(this.levels),
      bots: this.bots ? [...this.bots] : null,
      intervalSec: Math.round(this.intervalMs / 1000), silent: this.silent, maxPerMin: this.maxPerMin, keepLines: this.keepLines,
      buffered: this._pending, lines: this._feed.reduce((t, r) => t + r.n, 0), hasMessage: !!this._msgId, ...this.stats,
    };
  }

  // Quên tin đang cập nhật (đổi token/chat Telegram): lần cập nhật tới sẽ tạo file mới
  resetMessage() { this._msgId = null; this._sigSent = null; this._ver++; }
  // Dừng hẹn giờ (tắt tool)
  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
  }

  // ===== nhận log =====
  // bot: id bot (hoặc 'system'); entry: { level, msg, time }
  push(bot, entry) {
    if (!entry || !this.tg || !this.tg.enabled) return;
    const msg = this._clean(entry.msg);
    if (!msg) return;
    const level = ALIASES[String(entry.level || 'sys').toLowerCase()] || String(entry.level || 'sys').toLowerCase();
    const t = Number(entry.time) || Date.now();
    const botId = String(bot ?? SYSTEM);
    this.recent.push({ t, bot: botId, level, msg, n: 1 }); // luôn nhớ (để /logs xem lại), kể cả khi mức này không được gửi tự động
    if (!this.enabled) return;
    const rec = { t, last: t, bot: botId, level, msg, n: 1, gone: false };
    if (!this._passes(rec)) return;
    const last = this._lastByBot.get(botId);
    if (last && !last.gone && last.level === level && last.msg === msg) { last.n++; last.last = t; this._touch(); return; } // y hệt dòng trước của bot này -> (×N)
    this._feed.push(rec);
    this._lastByBot.set(botId, rec);
    if (botId !== SYSTEM) this._seen.add(botId);
    this._pending++;
    if (this._feed.length > this.keepLines) this._trim();
    this._touch();
  }
  _passes(r) {
    if (!this.levels.has(r.level)) return false;
    if (this.bots && r.bot !== SYSTEM && !this.bots.has(r.bot.toLowerCase())) return false;
    return true;
  }
  _touch() {
    this._ver++;
    this._arm(this.intervalMs);
  }

  // ===== làm sạch + che bí mật =====
  _clean(raw) {
    if (raw === undefined || raw === null) return '';
    let s = typeof raw === 'string' ? raw : (raw instanceof Error ? (raw.stack || raw.message) : String(raw));
    s = s.replace(ANSI_RE, '').replace(MC_COLOR_RE, '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    s = s.split('\n').map(x => x.replace(/\s+$/, '')).filter((x, i, a) => x || (i > 0 && a[i - 1])).slice(0, MAX_MSG_LINES).join('\n').trim();
    s = this._redact(s);
    return s.length > MAX_MSG ? s.slice(0, MAX_MSG - 1) + '…' : s;
  }
  _redact(s) {
    for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
    let secrets = [];
    try { secrets = this._secrets() || []; } catch { }
    for (const sec of secrets) {
      const v = String(sec ?? '');
      if (v.length >= 6) s = s.replace(new RegExp(`(?<![\\w])${escRe(v)}(?![\\w])`, 'g'), '***'); // chỉ che khi đứng riêng (không cắt giữa từ/số)
    }
    return s;
  }

  // ===== hẹn giờ + cập nhật file =====
  // Hẹn lần cập nhật kế tiếp sau ms (lần hẹn sớm hơn được giữ). Sau mỗi lần cập nhật tự hẹn tiếp -> chạy theo chu kỳ.
  _arm(ms) {
    const hold = this._holdUntil - Date.now();
    if (hold > ms) ms = hold; // đang hoãn (429 / quá nhịp / lỗi mạng) thì dòng mới tới cũng không kéo sớm lại
    const due = Date.now() + ms;
    if (this._timer && this._dueAt <= due) return;
    if (this._timer) clearTimeout(this._timer);
    this._dueAt = due;
    this._timer = setTimeout(() => { this._timer = null; this._dueAt = 0; this.flush().catch(() => { }); }, ms);
    if (this._timer.unref) this._timer.unref();
  }
  // Hoãn hẳn lần cập nhật kế tiếp tới sau ms (thay hẹn giờ cũ)
  _defer(ms) {
    this._holdUntil = Date.now() + ms;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
    this._arm(ms);
  }
  // File chỉ giữ keepLines dòng mới nhất: bỏ dòng cũ nhất, ghi lại số dòng bỏ
  _trim() {
    const over = this._feed.length - this.keepLines;
    if (over <= 0) return;
    const gone = this._feed.splice(0, over);
    let n = 0;
    for (const r of gone) { r.gone = true; n += r.n; }
    this._dropped += n; this.stats.dropped += n;
  }
  _clearBuffer() {
    for (const r of this._feed) r.gone = true;
    this._feed = []; this._dropped = 0; this._pending = 0; this._lastByBot.clear(); this._seen.clear();
    this._holdUntil = 0; this._failStreak = 0;
    this._msgId = null; this._sigSent = null; this._ver++;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
  }
  _rateWaitMs(now = Date.now()) {
    this._sentAt = this._sentAt.filter(t => now - t < 60000);
    if (this._sentAt.length < this.maxPerMin) return 0;
    return this._sentAt[0] + 60000 - now + 50;
  }

  /**
   * Cập nhật file lên Telegram (tạo lần đầu, sau đó sửa tại chỗ). Gọi theo nhịp hẹn giờ.
   *  force  = true (lúc tắt tool / nút "Cập nhật ngay"): bỏ qua giới hạn nhịp + hàng đợi bận
   *  always = true: cập nhật cả khi log + stats không đổi (chỉ để làm mới giờ "Cập nhật lúc")
   * Không bao giờ throw.
   */
  async flush(force = false, always = false) {
    if (this._flushing) return this._flushPromise;
    if (!this._feed.length && !this._dropped) return;
    if (!this.active) { this._clearBuffer(); return; }
    if (!force) {
      if (this.tg.paused || this.tg.pending > 3) { this._defer(2000); return; } // Telegram đang bận / bị 429 -> giữ log, cập nhật sau
      const wait = this._rateWaitMs();
      if (wait > 0) { this._defer(wait); return; }
    }
    const blocks = this._statsBlocks();
    const sig = this._ver + '|' + blocks.map(b => b.bot + '\n' + b.lines.join('\n')).join('\u0001');
    if (!always && sig === this._sigSent) { this._arm(this.intervalMs); return; } // không có gì mới -> khỏi sửa, chờ nhịp sau
    this._flushing = true;
    this._flushPromise = this._update(blocks, sig).finally(() => {
      this._flushing = false;
      this._flushPromise = null;
      if (this._feed.length && !this._timer) this._arm(this.intervalMs); // hẹn nhịp kế (đã hẹn sẵn sau lỗi thì giữ nguyên, không kéo sớm lại)
    });
    return this._flushPromise;
  }
  async _update(blocks, sig) {
    const pendingBefore = this._pending;
    try {
      const f = this._build(this._feed.filter(r => this._passes(r)), blocks, this._dropped, { live: true });
      this._sentAt.push(Date.now());
      const had = this._msgId;
      let res = null;
      try {
        if (had) res = await this.tg.editDocument(had, f.name, f.text, { caption: f.caption, keyboard: KEYBOARD });
        else { const id = await this.tg.sendDocument(f.name, f.text, { caption: f.caption, silent: this.silent, keyboard: KEYBOARD }); res = validId(id) ? { ok: true, id } : null; }
      } catch { res = null; }
      if (res && res.ok && validId(res.id)) {
        if (!had || res.id !== had) this.stats.created++; else this.stats.updates++;
        this._msgId = res.id; this._sigSent = sig; this._failStreak = 0;
        this._pending = Math.max(0, this._pending - pendingBefore);
      } else {
        this.stats.failed++;
        this._failStreak++;
        this._defer(Math.min(300000, Math.max(this.intervalMs, 15000) * Math.min(this._failStreak, 20))); // lỗi mạng: thử lại thưa dần (log vẫn nằm trong bộ nhớ)
      }
    } catch { /* gửi log không được làm hỏng bot */ }
  }
  // Cập nhật nốt khi tool tắt: tối đa timeoutMs
  async flushNow(timeoutMs = 3000) {
    let t;
    const work = (async () => {
      if (this._flushPromise) { try { await this._flushPromise; } catch { } } // đang gửi dở thì đợi xong rồi cập nhật phần còn lại
      await this.flush(true);
    })();
    try {
      await Promise.race([work, new Promise(r => { t = setTimeout(r, timeoutMs); if (t.unref) t.unref(); })]);
    } catch { } finally { clearTimeout(t); }
  }
  // Làm mới file NGAY (nút 🔄, "telegram logs now", "/logs now") -> { ok, message }
  async refresh() {
    if (!this.tg || !this.tg.enabled) return { ok: false, message: 'Telegram chưa cấu hình (telegram set <token> → telegram chatid)' };
    if (!this.enabled) return { ok: false, message: 'Log runtime đang TẮT (telegram logs on)' };
    if (!this._feed.length) return { ok: false, message: 'Chưa có log nào để cập nhật' };
    if (this._flushPromise) { try { await this._flushPromise; } catch { } }
    const failed0 = this.stats.failed;
    await this.flush(true, true);
    if (this.stats.failed > failed0) return { ok: false, message: `Cập nhật thất bại: ${this.tg.lastError || 'không rõ lý do'}` };
    return { ok: true, message: 'Đã cập nhật file log' };
  }

  // Gửi 1 file log thử (tin riêng, không đụng file đang cập nhật) qua đúng đường gửi thật — kiểm tra Telegram + định dạng
  async test() {
    if (!this.tg || !this.tg.enabled) return { ok: false, message: 'Telegram chưa cấu hình (telegram set <token> → telegram chatid)' };
    const rec = { t: Date.now(), last: Date.now(), bot: SYSTEM, level: 'ok', msg: 'Kiểm tra log runtime — thấy file này nghĩa là log đã gửi được lên Telegram', n: 1 };
    let id = null;
    try { const f = this._build([rec], [], 0, { live: false }); id = await this.tg.sendDocument(f.name, f.text, { caption: f.caption, silent: this.silent }); } catch { }
    return validId(id) ? { ok: true, message: 'Đã gửi file log thử' } : { ok: false, message: `Gửi thất bại: ${this.tg.lastError || 'không rõ lý do'}` };
  }

  // ===== xem lại theo yêu cầu (/logs, "telegram logs send") =====
  // Mọi mức (trừ chat người chơi nếu chưa bật), lọc theo bot, n dòng cuối, gửi thành 1 file RIÊNG (tin mới). -> { count, messages }
  async sendRecent({ bot = null, n = 25 } = {}) {
    if (!this.tg || !this.tg.enabled) return { count: 0, messages: 0 };
    n = Math.max(1, Math.min(150, Math.floor(Number(n)) || 25));
    const want = bot ? String(bot).toLowerCase() : null;
    const tail = this.recent.toArray()
      .filter(r => (!want || r.bot.toLowerCase() === want) && (r.level !== 'chat' || this.levels.has('chat')))
      .slice(-n);
    if (!tail.length) return { count: 0, messages: 0 };
    const f = this._build(tail.map(r => ({ ...r, last: r.t, n: 1 })), this._statsBlocks(want), 0, { live: false, bot: want ? tail[0].bot : null });
    const id = await this.tg.sendDocument(f.name, f.text, { caption: f.caption, silent: true });
    return { count: tail.length, messages: validId(id) ? 1 : 0 };
  }

  // ===== dựng file =====
  _timeFmt() {
    let tz = 'Asia/Ho_Chi_Minh';
    try { tz = this._tz() || tz; } catch { }
    let f = this._fmtCache.get(tz);
    if (!f) {
      try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
      catch { f = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }); }
      this._fmtCache.set(tz, f);
    }
    return f;
  }
  _dateFmt() {
    let tz = 'Asia/Ho_Chi_Minh';
    try { tz = this._tz() || tz; } catch { }
    const key = 'd|' + tz;
    let f = this._fmtCache.get(key);
    if (!f) {
      try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }); }
      catch { f = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
      this._fmtCache.set(key, f);
    }
    return f;
  }
  // "14:05:09 [WARN  ] bot-1: nội dung (×3)" — văn bản thuần trong file .txt; mục nhiều dòng thụt vào dưới
  _line(r, fmt = this._timeFmt()) {
    const at = (ms) => { try { return fmt.format(new Date(ms)); } catch { return '--:--:--'; } };
    const [first, ...rest] = r.msg.split('\n');
    let s = `${at(r.t)} [${(LABELS[r.level] || r.level.toUpperCase()).padEnd(6)}] ${r.bot}: ${first}`;
    for (const x of rest) s += `\n           ↳ ${x}`;
    if (r.n > 1) s += (r.last || r.t) - r.t >= 60000 ? ` (×${r.n} · tới ${at(r.last)})` : ` (×${r.n})`; // lặp kéo dài: ghi cả giờ lặp gần nhất
    return s;
  }
  // Stats server (scoreboard) của 1 bot, đã làm sạch + che bí mật. [] nếu không có.
  _statsLines(bot) {
    if (bot === SYSTEM) return [];
    let st = null;
    try { st = this._stats(bot); } catch { st = null; }
    if (!st) return [];
    const raw = Array.isArray(st) ? st : [...(st.title ? [`Scoreboard: ${st.title}`] : []), ...(st.lines || [])];
    return raw.map(x => this._clean(x).replace(/\n+/g, ' ')).filter(Boolean).slice(0, MAX_STAT_LINES);
  }
  // Stats của mọi bot (hoặc chỉ bot `only`): [{ bot, lines }] — bot hiện có (botIds) + bot đã có log trong file; bỏ bot ngoài bộ lọc
  _statsBlocks(only = null) {
    let ids = [];
    try { ids = (this._botIds() || []).filter(x => x !== undefined && x !== null).map(String); } catch { ids = []; }
    const have = new Set(ids);
    for (const id of this._seen) if (!have.has(id)) ids.push(id);
    const out = [];
    for (const id of ids) {
      if (id === SYSTEM) continue;
      if (only && id.toLowerCase() !== only) continue;
      if (this.bots && !this.bots.has(id.toLowerCase())) continue;
      const lines = this._statsLines(id);
      if (lines.length) out.push({ bot: id, lines });
    }
    return out;
  }
  _fileName(bot) { return bot ? `log_${String(bot).replace(/[^\w.-]+/g, '_').slice(0, 60) || SYSTEM}.txt` : FILE_NAME; }
  // -> { name, text, caption }.  live=true: file chính (ghi chu kỳ tự cập nhật + dòng đã bỏ); live=false: ảnh chụp theo yêu cầu (/logs, test)
  _build(recs, blocks, dropped, { live = false, bot = null } = {}) {
    const fmt = this._timeFmt(), dfmt = this._dateFmt();
    const now = new Date();
    let nowText, clock = '';
    try { nowText = now.toLocaleString('en-GB', { timeZone: this._tz() || 'Asia/Ho_Chi_Minh', hour12: false }); } catch { nowText = now.toISOString(); }
    try { clock = fmt.format(now); } catch { }
    const sources = [...new Set(recs.map(r => r.bot))];
    const nBots = sources.filter(s => s !== SYSTEM).length;
    const hasSys = sources.includes(SYSTEM);
    const lines = recs.reduce((t, r) => t + r.n, 0);
    const every = TelegramLogger.fmtSeconds(this.intervalMs / 1000);
    const out = [`Antertool — log runtime: ${bot || 'tất cả bot'}`, `${live ? 'Cập nhật lúc' : 'Xuất lúc'}: ${nowText}${live ? ` · tự cập nhật mỗi ${every}` : ''}`];
    if (sources.length) out.push(`Gồm: ${sources.join(', ')} · ${lines} dòng`);
    if (blocks.length) {
      out.push('', '===== STATS SERVER =====');
      for (const b of blocks) out.push(`[${b.bot}]`, ...b.lines.map(l => '  ' + l));
    }
    out.push('', `===== LOG (${recs.length} mục) =====`);
    if (dropped) out.push(`… đã bỏ qua ${dropped} dòng cũ hơn (file chỉ giữ ${this.keepLines} dòng mới nhất — tăng bằng "telegram logs keep <số>", hoặc lọc bớt bằng "telegram logs level")`);
    let day = null;
    for (const r of recs) {
      let d = '';
      try { d = dfmt.format(new Date(r.t)); } catch { }
      if (d && d !== day) { day = d; out.push(`── ${d} ──`); }
      out.push(this._line(r, fmt));
    }
    const errs = recs.filter(r => r.level === 'err').reduce((t, r) => t + r.n, 0);
    const warns = recs.filter(r => r.level === 'warn').reduce((t, r) => t + r.n, 0);
    let caption = live
      ? `📜 <b>Log runtime</b> · ${nBots} bot${hasSys ? ' + hệ thống' : ''} · ${lines} dòng · 🔄 mỗi ${every} · ${clock}`
      : `📜 <b>${escapeHtml(bot || 'Log runtime')}</b> · ${lines} dòng · ${clock}`;
    if (errs) caption += ` · ❌ ${errs}`;
    if (warns) caption += ` · ⚠️ ${warns}`;
    return { name: this._fileName(bot), text: out.join('\n') + '\n', caption };
  }
}

module.exports = TelegramLogger;
