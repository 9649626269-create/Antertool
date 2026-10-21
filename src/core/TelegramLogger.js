'use strict';
const { escapeHtml } = require('./TelegramNotifier');
const { dbg } = require('./debug');
const RingBuffer = require('./RingBuffer');

/**
 * TelegramLogger — đẩy LOG RUNTIME (log của từng bot + log hệ thống của tool) lên Telegram.
 * Các ký hiệu trong mã nguồn được viết dưới dạng escape \u{...} để giữ mã nguồn thuần ASCII.
 */
const LEVELS = ['sys', 'ok', 'warn', 'err', 'afk', 'shard', 'proxy', 'health', 'chat'];
const PRESETS = {
  all: ['sys', 'ok', 'warn', 'err', 'afk', 'shard', 'proxy', 'health'],
  info: ['ok', 'warn', 'err', 'proxy', 'health'],
  warn: ['warn', 'err', 'health'],
  err: ['err'],
};
const ALIASES = { error: 'err', errors: 'err', warning: 'warn', warnings: 'warn', system: 'sys', debug: 'sys' };
const ICONS = {
  sys: '\u{2699}\u{FE0F}',
  ok: '\u{2705}',
  warn: '\u{26A0}\u{FE0F}',
  err: '\u{274C}',
  afk: '\u{1F4A4}',
  shard: '\u{2728}',
  proxy: '\u{1F310}',
  health: '\u{1FA7A}',
  chat: '\u{1F4AC}',
};
const SYSTEM = 'system';
const LABELS = { sys: 'SYS', ok: 'OK', warn: 'WARN', err: 'ERR', afk: 'AFK', shard: 'SHARD', proxy: 'PROXY', health: 'HEALTH', chat: 'CHAT' };

const DEFAULTS = { enabled: true, intervalSec: 10, silent: true, maxPerMin: 10, keepLines: 1000 };
const MIN_INTERVAL_SEC = 2;
const MAX_INTERVAL_SEC = 86400; // 24h
const MIN_KEEP = 50;
const MAX_KEEP = 5000;
const MAX_MSG = 500;
const MAX_MSG_LINES = 6;
const MAX_STAT_LINES = 40;
const FILE_NAME = 'log_all.txt';
const REFRESH_DATA = 'lg:now';
const KEYBOARD = [[{ text: '\u{1F504} Cập nhật ngay', callback_data: REFRESH_DATA }]];

// ----- che thông tin nhạy cảm -----
const REDACTIONS = [
  [/\b\d{6,12}:[\w-]{30,}/g, '<telegram-token>'],
  [/(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1***'],
  [/(\/(?:dn|dk|login|register|log|reg|l|changepassword|cp)\s+)\S+(?:\s+\S+)?/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1***@'],
  [/("(?:botPassword|password|telegramToken|dashboardToken|webhookUrl|revenueWebhookUrl)"\s*:\s*")[^"]*(")/gi, '$1***$2'],
];
const STATIC_REDACTIONS = [
  [/(https?:\/\/api\.telegram\.org\/bot)\d{6,12}:[\w-]{20,}/gi, '$1<telegram-token>'],
  [/\b\d{6,12}:[\w-]{30,}/g, '<telegram-token>'],
  [/(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1***'],
  [/(\/(?:dn|dk|login|register|log|reg|l|changepassword|cp)\s+)\S+(?:\s+\S+)?/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1***:***@'],
  [/("(?:botPassword|password|telegramToken|dashboardToken|webhookUrl|revenueWebhookUrl)"\s*:\s*")[^"]*(")/gi, '$1***$2'],
];
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const MC_COLOR_RE = /§[0-9a-fk-orx]/gi;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const validId = (id) => id !== null && id !== undefined && typeof id !== 'object';

class TelegramLogger {
  constructor(notifier, opts = {}) {
    this.tg = notifier;
    this._tz = typeof opts.tz === 'function' ? opts.tz : () => 'Asia/Ho_Chi_Minh';
    this._secrets = typeof opts.secrets === 'function' ? opts.secrets : () => [];
    this._stats = typeof opts.stats === 'function' ? opts.stats : () => null;
    this._botIds = typeof opts.botIds === 'function' ? opts.botIds : () => [];
    this.recent = new RingBuffer(opts.recentSize || 500);
    this._feed = [];
    this._seen = new Set();
    this._dropped = 0;
    this._pending = 0;
    this._ver = 0;
    this._sigSent = null;
    this._msgId = null;
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

  static redactStatic(raw, secrets = []) {
    let s = String(raw ?? '');
    for (const [re, rep] of STATIC_REDACTIONS) s = s.replace(re, rep);
    for (const sec of secrets || []) {
      const v = String(sec ?? '');
      if (v.length >= 6) s = s.replace(new RegExp(`(?<![\\w])${escRe(v)}(?![\\w])`, 'g'), '***');
    }
    return s;
  }

  static parseLevels(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return { ok: false, error: 'Thiếu mức log' };
    const tokens = t.split(/[\s,]+/).filter(Boolean);
    if (tokens.length === 1 && PRESETS[ALIASES[tokens[0]] || tokens[0]]) return { ok: true, levels: [...PRESETS[ALIASES[tokens[0]] || tokens[0]]] };
    const out = [];
    for (const raw of tokens) {
      const k = ALIASES[raw] || raw;
      if (LEVELS.includes(k)) { out.push(k); continue; }
      if (PRESETS[k]) { out.push(...PRESETS[k]); continue; }
      return { ok: false, error: `Mức "${raw}" không có. Mức: ${LEVELS.join(', ')} · mẫu: ${Object.keys(PRESETS).join(', ')}` };
    }
    return { ok: true, levels: [...new Set(out)] };
  }

  static presetOf(levels) {
    const s = [...levels].sort().join(',');
    return Object.keys(PRESETS).find(k => [...PRESETS[k]].sort().join(',') === s) || null;
  }

  static parseSeconds(text) {
    const t = String(text ?? '').trim().toLowerCase();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  static fmtSeconds(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return `${h ? h + 'h' : ''}${m ? m + 'm' : ''}${s || (!h && !m) ? s + 's' : ''}`;
  }

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
      if (this._feed.length && this.enabled) this._arm(this.intervalMs);
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
    if (changed && this._feed.length) this._touch();
    if (!this.enabled) this._clearBuffer();
    return this;
  }

  get active() { return !!(this.enabled && this.tg && this.tg.enabled); }
  get buffered() { return this._pending; }

  status() {
    return {
      enabled: this.enabled, telegramReady: !!(this.tg && this.tg.enabled),
      levels: [...this.levels], preset: TelegramLogger.presetOf(this.levels),
      bots: this.bots ? [...this.bots] : null,
      intervalSec: Math.round(this.intervalMs / 1000), silent: this.silent, maxPerMin: this.maxPerMin, keepLines: this.keepLines,
      buffered: this._pending, lines: this._feed.reduce((t, r) => t + r.n, 0), hasMessage: !!this._msgId, ...this.stats,
    };
  }

  resetMessage() { this._msgId = null; this._sigSent = null; this._ver++; }
  stop() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
  }

  push(bot, entry) {
    if (!entry || !this.tg || !this.tg.enabled) return;
    const msg = this._clean(entry.msg);
    if (!msg) return;
    const level = ALIASES[String(entry.level || 'sys').toLowerCase()] || String(entry.level || 'sys').toLowerCase();
    const t = Number(entry.time) || Date.now();
    const botId = String(bot ?? SYSTEM);
    this.recent.push({ t, bot: botId, level, msg, n: 1 });
    if (!this.enabled) return;
    const rec = { t, last: t, bot: botId, level, msg, n: 1, gone: false };
    if (!this._passes(rec)) return;
    const last = this._lastByBot.get(botId);
    if (last && !last.gone && last.level === level && last.msg === msg) { last.n++; last.last = t; this._touch(); return; }
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
    try { secrets = this._secrets() || []; } catch (e) { dbg('TelegramLogger', e); }
    for (const sec of secrets) {
      const v = String(sec ?? '');
      if (v.length >= 6) s = s.replace(new RegExp(`(?<![\\w])${escRe(v)}(?![\\w])`, 'g'), '***');
    }
    return s;
  }

  _arm(ms) {
    const hold = this._holdUntil - Date.now();
    if (hold > ms) ms = hold;
    const due = Date.now() + ms;
    if (this._timer && this._dueAt <= due) return;
    if (this._timer) clearTimeout(this._timer);
    this._dueAt = due;
    this._timer = setTimeout(() => { this._timer = null; this._dueAt = 0; this.flush().catch(() => { }); }, ms);
    if (this._timer.unref) this._timer.unref();
  }
  _defer(ms) {
    this._holdUntil = Date.now() + ms;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; this._dueAt = 0; }
    this._arm(ms);
  }
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

  async flush(force = false, always = false) {
    if (this._flushing) return this._flushPromise;
    if (!this._feed.length && !this._dropped) return;
    if (!this.active) { this._clearBuffer(); return; }
    if (!force) {
      if (this.tg.paused || this.tg.pending > 3) { this._defer(2000); return; }
      const wait = this._rateWaitMs();
      if (wait > 0) { this._defer(wait); return; }
    }
    const blocks = this._statsBlocks();
    const sig = this._ver + '|' + blocks.map(b => b.bot + '\n' + b.lines.join('\n')).join('\u0001');
    if (!always && sig === this._sigSent) { this._arm(this.intervalMs); return; }
    this._flushing = true;
    this._flushPromise = this._update(blocks, sig).finally(() => {
      this._flushing = false;
      this._flushPromise = null;
      if (this._feed.length && !this._timer) this._arm(this.intervalMs);
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
        this._defer(Math.min(300000, Math.max(this.intervalMs, 15000) * Math.min(this._failStreak, 20)));
      }
    } catch { /* gửi log không được làm hỏng bot */ }
  }
  async flushNow(timeoutMs = 3000) {
    let t;
    const work = (async () => {
      if (this._flushPromise) { try { await this._flushPromise; } catch (e) { dbg('TelegramLogger', e); } }
      await this.flush(true);
    })();
    try {
      await Promise.race([work, new Promise(r => { t = setTimeout(r, timeoutMs); if (t.unref) t.unref(); })]);
    } catch (e) { dbg('TelegramLogger', e); } finally { clearTimeout(t); }
  }
  async refresh() {
    if (!this.tg || !this.tg.enabled) return { ok: false, message: 'Telegram chưa cấu hình (telegram set <token> → telegram chatid)' };
    if (!this.enabled) return { ok: false, message: 'Log runtime đang TẮT (telegram logs on)' };
    if (!this._feed.length) return { ok: false, message: 'Chưa có log nào để cập nhật' };
    if (this._flushPromise) { try { await this._flushPromise; } catch (e) { dbg('TelegramLogger', e); } }
    const failed0 = this.stats.failed;
    await this.flush(true, true);
    if (this.stats.failed > failed0) return { ok: false, message: `Cập nhật thất bại: ${this.tg.lastError || 'không rõ lý do'}` };
    return { ok: true, message: 'Đã cập nhật file log' };
  }

  async test() {
    if (!this.tg || !this.tg.enabled) return { ok: false, message: 'Telegram chưa cấu hình (telegram set <token> → telegram chatid)' };
    const rec = { t: Date.now(), last: Date.now(), bot: SYSTEM, level: 'ok', msg: 'Kiểm tra log runtime — thấy file này nghĩa là log đã gửi được lên Telegram', n: 1 };
    let id = null;
    try { const f = this._build([rec], [], 0, { live: false }); id = await this.tg.sendDocument(f.name, f.text, { caption: f.caption, silent: this.silent }); } catch (e) { dbg('TelegramLogger', e); }
    return validId(id) ? { ok: true, message: 'Đã gửi file log thử' } : { ok: false, message: `Gửi thất bại: ${this.tg.lastError || 'không rõ lý do'}` };
  }

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

  _timeFmt() {
    let tz = 'Asia/Ho_Chi_Minh';
    try { tz = this._tz() || tz; } catch (e) { dbg('TelegramLogger', e); }
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
    try { tz = this._tz() || tz; } catch (e) { dbg('TelegramLogger', e); }
    const key = 'd|' + tz;
    let f = this._fmtCache.get(key);
    if (!f) {
      try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }); }
      catch { f = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
      this._fmtCache.set(key, f);
    }
    return f;
  }
  _line(r, fmt = this._timeFmt()) {
    const at = (ms) => { try { return fmt.format(new Date(ms)); } catch { return '--:--:--'; } };
    const [first, ...rest] = r.msg.split('\n');
    let s = `${at(r.t)} [${(LABELS[r.level] || r.level.toUpperCase()).padEnd(6)}] ${r.bot}: ${first}`;
    for (const x of rest) s += `\n           ↳ ${x}`;
    if (r.n > 1) s += (r.last || r.t) - r.t >= 60000 ? ` (×${r.n} · tới ${at(r.last)})` : ` (×${r.n})`;
    return s;
  }
  _statsLines(bot) {
    if (bot === SYSTEM) return [];
    let st = null;
    try { st = this._stats(bot); } catch { st = null; }
    if (!st) return [];
    const raw = Array.isArray(st) ? st : [...(st.title ? [`Scoreboard: ${st.title}`] : []), ...(st.lines || [])];
    return raw.map(x => this._clean(x).replace(/\n+/g, ' ')).filter(Boolean).slice(0, MAX_STAT_LINES);
  }
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
  _build(recs, blocks, dropped, { live = false, bot = null } = {}) {
    const fmt = this._timeFmt(), dfmt = this._dateFmt();
    const now = new Date();
    let nowText, clock = '';
    try { nowText = now.toLocaleString('en-GB', { timeZone: this._tz() || 'Asia/Ho_Chi_Minh', hour12: false }); } catch { nowText = now.toISOString(); }
    try { clock = fmt.format(now); } catch (e) { dbg('TelegramLogger', e); }
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
      try { d = dfmt.format(new Date(r.t)); } catch (e) { dbg('TelegramLogger', e); }
      if (d && d !== day) { day = d; out.push(`── ${d} ──`); }
      out.push(this._line(r, fmt));
    }
    const errs = recs.filter(r => r.level === 'err').reduce((t, r) => t + r.n, 0);
    const warns = recs.filter(r => r.level === 'warn').reduce((t, r) => t + r.n, 0);
    let caption = live
      ? `\u{1F4DC} <b>Log runtime</b> · ${nBots} bot${hasSys ? ' + hệ thống' : ''} · ${lines} dòng · \u{1F504} mỗi ${every} · ${clock}`
      : `\u{1F4DC} <b>${escapeHtml(bot || 'Log runtime')}</b> · ${lines} dòng · ${clock}`;
    if (errs) caption += ` · \u{274C} ${errs}`;
    if (warns) caption += ` · \u{26A0}\u{FE0F} ${warns}`;
    return { name: this._fileName(bot), text: out.join('\n') + '\n', caption };
  }
}

module.exports = TelegramLogger;
