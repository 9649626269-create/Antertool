'use strict';
const { escapeHtml } = require('./TelegramNotifier');
const RingBuffer = require('./RingBuffer');

/**
 * TelegramLogger — đẩy LOG RUNTIME (log của từng bot + log hệ thống của tool) lên Telegram.
 *
 *  - Không gửi từng dòng: gom theo lô (mặc định 10s) rồi gửi 1 tin gộp; lỗi (err) gửi nhanh hơn (≤2s).
 *  - Tin log gửi IM LẶNG (không rung điện thoại) — cảnh báo kick/hết reconnect... vẫn là tin riêng có thông báo đẩy.
 *  - Chống dội: dòng y hệt liên tiếp của cùng 1 bot gộp thành "(×N)"; tối đa N tin/phút; hàng đợi Telegram bận
 *    hoặc đang bị 429 thì GIỮ log lại gửi sau (bộ đệm giới hạn 400 dòng, tràn thì bỏ dòng cũ nhất và báo số dòng bỏ).
 *  - Gửi lỗi (mạng/Telegram) thì xếp lại gửi sau, tối đa 3 lần/dòng — không bao giờ làm bot chậm hay chết.
 *  - Tự che thông tin nhạy cảm: token Telegram, webhook Discord, mật khẩu trong /dn /dk /login..., user:pass@ của proxy,
 *    và mật khẩu bot đang cấu hình (nếu xuất hiện nguyên văn trong log).
 *  - Giữ 500 dòng gần nhất (mọi mức) để lệnh /logs xem lại theo yêu cầu.
 *
 * Chỉ dùng TelegramNotifier.send (đã có hàng đợi tuần tự + nghỉ khi 429). Không tự in ra console/log của bot
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

const DEFAULTS = { enabled: true, intervalSec: 10, silent: true, maxPerMin: 10 };
const MAX_BUFFER = 400;      // dòng chờ gửi tối đa
const MAX_MSG = 500;         // ký tự tối đa của 1 dòng log
const MAX_MSG_LINES = 6;     // số dòng tối đa của 1 mục log nhiều dòng (bảng, stack trace)
const CHUNK_LIMIT = 3600;    // ký tự (đã gồm thẻ HTML) tối đa của 1 tin — Telegram cho 4096, notifier cắt ở 4000
const MAX_TRIES = 3;         // gửi lỗi quá chừng này lần thì bỏ dòng đó
const ERR_FLUSH_MS = 2000;   // có lỗi (err) thì không chờ hết nhịp gom

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

class TelegramLogger {
  /**
   * @param notifier  TelegramNotifier (send, enabled, paused, pending)
   * @param opts      { tz: () => 'Asia/Ho_Chi_Minh', secrets: () => ['mật khẩu bot', ...], recentSize }
   */
  constructor(notifier, opts = {}) {
    this.tg = notifier;
    this._tz = typeof opts.tz === 'function' ? opts.tz : () => 'Asia/Ho_Chi_Minh';
    this._secrets = typeof opts.secrets === 'function' ? opts.secrets : () => [];
    this.recent = new RingBuffer(opts.recentSize || 500);
    this._buf = [];
    this._dropped = 0;
    this._lastByBot = new Map();
    this._timer = null;
    this._dueAt = 0;
    this._holdUntil = 0;
    this._flushing = false;
    this._flushPromise = null;
    this._sentAt = [];
    this._fmtCache = new Map();
    this.stats = { messages: 0, lines: 0, dropped: 0, failed: 0 };
    this.enabled = DEFAULTS.enabled;
    this.levels = new Set(PRESETS.all);
    this.bots = null;
    this.intervalMs = DEFAULTS.intervalSec * 1000;
    this.silent = DEFAULTS.silent;
    this.maxPerMin = DEFAULTS.maxPerMin;
    this.configure(opts);
  }

  static get LEVELS() { return LEVELS; }
  static get PRESETS() { return PRESETS; }
  static get SYSTEM() { return SYSTEM; }
  static get ICONS() { return ICONS; }

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
  // "10s" | "2m" | "90" (số trần = giây) -> giây (null nếu không hiểu)
  static parseSeconds(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  // cfg: { enabled, levels (mảng | chuỗi), bots (mảng | null), intervalSec, silent, maxPerMin } — thiếu thì dùng mặc định
  configure(cfg = {}) {
    if (cfg.enabled !== undefined) this.enabled = cfg.enabled !== false;
    if (cfg.levels !== undefined && cfg.levels !== null) {
      let list = null;
      if (typeof cfg.levels === 'string') { const r = TelegramLogger.parseLevels(cfg.levels); if (r.ok) list = r.levels; }
      else if (cfg.levels instanceof Set || Array.isArray(cfg.levels)) {
        list = [...cfg.levels].map(x => ALIASES[String(x).toLowerCase()] || String(x).toLowerCase()).filter(x => LEVELS.includes(x));
      }
      this.levels = new Set(list && list.length ? list : PRESETS.all);
    }
    if (cfg.bots !== undefined) {
      const list = Array.isArray(cfg.bots) ? cfg.bots.map(x => String(x).trim().toLowerCase()).filter(Boolean) : [];
      this.bots = list.length ? new Set(list) : null;
    }
    if (cfg.intervalSec !== undefined && cfg.intervalSec !== null) {
      const s = Number(cfg.intervalSec);
      this.intervalMs = Math.min(3600, Math.max(2, Number.isFinite(s) ? s : DEFAULTS.intervalSec)) * 1000;
    }
    if (cfg.silent !== undefined) this.silent = cfg.silent !== false;
    if (cfg.maxPerMin !== undefined && cfg.maxPerMin !== null) {
      const n = Math.floor(Number(cfg.maxPerMin));
      this.maxPerMin = Math.min(20, Math.max(1, Number.isFinite(n) ? n : DEFAULTS.maxPerMin));
    }
    if (!this.enabled) this._clearBuffer();
    return this;
  }

  get active() { return !!(this.enabled && this.tg && this.tg.enabled); }
  get buffered() { return this._buf.length; }

  status() {
    return {
      enabled: this.enabled, telegramReady: !!(this.tg && this.tg.enabled),
      levels: [...this.levels], preset: TelegramLogger.presetOf(this.levels),
      bots: this.bots ? [...this.bots] : null,
      intervalSec: Math.round(this.intervalMs / 1000), silent: this.silent, maxPerMin: this.maxPerMin,
      buffered: this._buf.length, ...this.stats,
    };
  }

  // ===== nhận log =====
  // bot: id bot (hoặc 'system'); entry: { level, msg, time }
  push(bot, entry) {
    if (!entry || !this.tg || !this.tg.enabled) return;
    const msg = this._clean(entry.msg);
    if (!msg) return;
    const level = ALIASES[String(entry.level || 'sys').toLowerCase()] || String(entry.level || 'sys').toLowerCase();
    const rec = { t: Number(entry.time) || Date.now(), bot: String(bot ?? SYSTEM), level, msg, n: 1, tries: 0 };
    this.recent.push(rec); // luôn nhớ (để /logs xem lại), kể cả khi mức này không được gửi tự động
    if (!this.enabled || !this.levels.has(level)) return;
    if (this.bots && rec.bot !== SYSTEM && !this.bots.has(rec.bot.toLowerCase())) return;
    const last = this._lastByBot.get(rec.bot);
    if (last && last.level === level && last.msg === msg && this._buf.includes(last)) { last.n++; return; } // y hệt dòng trước của bot này -> (×N)
    this._buf.push(rec);
    this._lastByBot.set(rec.bot, rec);
    if (this._buf.length > MAX_BUFFER) this._trim();
    this._arm(level === 'err' ? Math.min(this.intervalMs, ERR_FLUSH_MS) : this.intervalMs);
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

  // ===== gom lô + gửi =====
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
  // Hoãn hẳn lần gửi kế tiếp tới sau ms (thay hẹn giờ cũ)
  _defer(ms) {
    this._holdUntil = Date.now() + ms;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
    this._arm(ms);
  }
  _trim() {
    const over = this._buf.length - MAX_BUFFER;
    if (over <= 0) return;
    const gone = this._buf.splice(0, over);
    const n = gone.reduce((t, r) => t + r.n, 0);
    this._dropped += n; this.stats.dropped += n;
  }
  _clearBuffer() {
    this._buf = []; this._dropped = 0; this._lastByBot.clear();
    this._holdUntil = 0;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
  }
  _rateWaitMs(now = Date.now()) {
    this._sentAt = this._sentAt.filter(t => now - t < 60000);
    if (this._sentAt.length < this.maxPerMin) return 0;
    return this._sentAt[0] + 60000 - now + 50;
  }

  /**
   * Gửi các dòng đang chờ. force=true (lúc tắt tool / lệnh test): bỏ qua giới hạn nhịp, gửi hết ngay.
   * Không bao giờ throw.
   */
  async flush(force = false) {
    if (this._flushing) return this._flushPromise;
    if (!this._buf.length && !this._dropped) return;
    if (!this.active) { this._clearBuffer(); return; }
    if (!force) {
      if (this.tg.paused || this.tg.pending > 3) { this._defer(2000); return; } // Telegram đang bận / bị 429 -> giữ log, gửi sau
      const wait = this._rateWaitMs();
      if (wait > 0) { this._defer(wait); return; }
    }
    this._flushing = true;
    const recs = this._buf, dropped = this._dropped;
    this._buf = []; this._dropped = 0; this._lastByBot.clear();
    this._flushPromise = this._sendBatch(recs, dropped, force).finally(() => {
      this._flushing = false;
      this._flushPromise = null;
      if (this._buf.length && !this._timer) this._arm(this.intervalMs); // đã hẹn giờ (vd _requeue sau lỗi mạng) thì giữ nguyên, không kéo sớm lại
    });
    return this._flushPromise;
  }
  async _sendBatch(recs, dropped, force) {
    try {
      const chunks = this._chunk(recs, dropped);
      for (let i = 0; i < chunks.length; i++) {
        if (!force && i > 0) { // nhiều tin liên tiếp: vẫn tôn trọng giới hạn nhịp
          const wait = this._rateWaitMs();
          if (wait > 0 || this.tg.paused) { this._requeue(chunks.slice(i)); break; }
        }
        this._sentAt.push(Date.now());
        let id = null;
        try { id = await this.tg.send(chunks[i].text, { silent: this.silent }); } catch { id = null; }
        if (id) { this.stats.messages++; this.stats.lines += chunks[i].recs.length; continue; }
        this.stats.failed++;
        this._requeue(chunks.slice(i));
        break;
      }
    } catch { /* gửi log không được làm hỏng bot */ }
  }
  // Xếp lại các dòng chưa gửi được lên đầu bộ đệm (tối đa MAX_TRIES lần/dòng)
  _requeue(chunks) {
    const back = [];
    for (const c of chunks) for (const r of c.recs) { if (++r.tries < MAX_TRIES) back.push(r); }
    if (!back.length) return;
    this._buf = back.concat(this._buf);
    this._lastByBot.clear();
    if (this._buf.length > MAX_BUFFER) this._trim();
    this._defer(Math.max(this.intervalMs, 15000)); // lỗi mạng: thử lại thưa hơn
  }
  // Gửi nốt khi tool tắt: tối đa timeoutMs
  async flushNow(timeoutMs = 3000) {
    let t;
    const work = (async () => {
      if (this._flushPromise) { try { await this._flushPromise; } catch { } } // đang gửi dở thì đợi xong rồi gửi phần còn lại
      await this.flush(true);
    })();
    try {
      await Promise.race([work, new Promise(r => { t = setTimeout(r, timeoutMs); if (t.unref) t.unref(); })]);
    } catch { } finally { clearTimeout(t); }
  }

  // Gửi 1 dòng log thử qua đúng đường gửi thật (kiểm tra Telegram + định dạng; không phụ thuộc bộ lọc mức)
  async test() {
    if (!this.tg || !this.tg.enabled) return { ok: false, message: 'Telegram chưa cấu hình (telegram set <token> → telegram chatid)' };
    const rec = { t: Date.now(), bot: SYSTEM, level: 'ok', msg: 'Kiểm tra log runtime — thấy dòng này nghĩa là log đã gửi được lên Telegram', n: 1 };
    let id = null;
    try { id = await this.tg.send(this._chunk([rec])[0].text, { silent: this.silent }); } catch { }
    return id ? { ok: true, message: 'Đã gửi dòng log thử' } : { ok: false, message: `Gửi thất bại: ${this.tg.lastError || 'không rõ lý do'}` };
  }

  // ===== xem lại theo yêu cầu (/logs, "telegram logs send") =====
  // Mọi mức (trừ chat người chơi nếu chưa bật), lọc theo bot, n dòng cuối. -> { count, messages }
  async sendRecent({ bot = null, n = 25 } = {}) {
    if (!this.tg || !this.tg.enabled) return { count: 0, messages: 0 };
    n = Math.max(1, Math.min(150, Math.floor(Number(n)) || 25));
    const want = bot ? String(bot).toLowerCase() : null;
    const tail = this.recent.toArray()
      .filter(r => (!want || r.bot.toLowerCase() === want) && (r.level !== 'chat' || this.levels.has('chat')))
      .slice(-n);
    if (!tail.length) return { count: 0, messages: 0 };
    let messages = 0;
    for (const c of this._chunk(tail.map(r => ({ ...r, n: 1 })), 0)) {
      if (await this.tg.send(c.text, { silent: true })) messages++;
    }
    return { count: tail.length, messages };
  }

  // ===== dựng tin =====
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
  // "<code>14:05:09</code> <b>bot-1</b> ⚠️ nội dung (×3)"  — chữ thường (không <pre>) để điện thoại tự xuống dòng, khỏi phải cuộn ngang
  _line(r, fmt = this._timeFmt()) {
    let time;
    try { time = fmt.format(new Date(r.t)); } catch { time = '--:--:--'; }
    const [first, ...rest] = r.msg.split('\n');
    let s = `<code>${time}</code> <b>${escapeHtml(r.bot)}</b> ${ICONS[r.level] || '•'} ${escapeHtml(first)}`;
    for (const x of rest) s += `\n   ↳ ${escapeHtml(x)}`;
    if (r.n > 1) s += ` <i>(×${r.n})</i>`;
    return s;
  }
  // -> [{ text, recs }]  mỗi tin ≤ CHUNK_LIMIT ký tự; dòng "bỏ qua N dòng" (nếu có) nằm đầu tin đầu tiên
  _chunk(recs, dropped = 0) {
    const fmt = this._timeFmt();
    const out = [];
    let cur = [], size = 0;
    const close = () => { if (cur.length) { out.push({ text: cur.map(x => x.s).join('\n'), recs: cur.map(x => x.r).filter(Boolean) }); cur = []; size = 0; } };
    const items = recs.map(r => ({ r, s: this._line(r, fmt) }));
    if (dropped) items.unshift({ r: null, s: `<i>… đã bỏ qua ${dropped} dòng (log tới quá nhanh — lọc bớt bằng "telegram logs level" hoặc tăng "telegram logs every")</i>` });
    for (const it of items) {
      if (cur.length && size + it.s.length + 1 > CHUNK_LIMIT) close();
      cur.push(it); size += it.s.length + 1;
    }
    close();
    return out;
  }
}

module.exports = TelegramLogger;
