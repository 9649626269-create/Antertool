'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dbg } = require('./debug');

/**
 * FileLogger — ghi LOG RUNTIME (log từng bot + log hệ thống) ra file trên máy, để còn đọc được sau khi tool sập/tắt.
 *
 *  - Mặc định trên Android/Termux ghi vào `/sdcard/bot/log/runtime-YYYY-MM-DD.log` (nếu chưa có thư mục hoặc file thì tự tạo).
 *  - Mỗi ngày một file: runtime-YYYY-MM-DD.log (cùng 1 file cho mọi bot, mỗi dòng ghi rõ bot nào). Quá maxMB thì sang
 *    runtime-YYYY-MM-DD.1.log, .2.log... Tự xoá file cũ hơn keepDays ngày (khi khởi động và khi sang ngày mới).
 *  - Dòng text:  2026-10-17 23:45:01.123 [WARN  ] [bot-1] nội dung      (xuống dòng -> các dòng sau thụt vào 4 khoảng trắng)
 *    format "json": mỗi dòng 1 JSON {t, level, bot, msg} -> file .jsonl, dễ lọc bằng jq / công cụ khác.
 *  - Che mật khẩu/token bằng hàm redact do chủ tool đưa vào (dùng chung bộ lọc của TelegramLogger).
 *  - Ghi BẤT ĐỒNG BỘ theo lô (mỗi ~1s) nên không làm chậm bot; thoát tiến trình thì tự ghi nốt đồng bộ.
 *    Nếu thư mục hoặc file log chưa có (hoặc bị xoá khi đang chạy), tự động tạo lại thư mục và file ngay lập tức.
 */
const DAY_MS = 86400000;
const MAX_LINE = 8000;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MC_RE = /[§§][0-9a-fk-or]/gi;
const LEVELS = ['sys', 'ok', 'warn', 'err', 'afk', 'shard', 'proxy', 'health', 'chat'];
const SDCARD_LOG_DIR = '/sdcard/bot/log';

function fmtTime(ms, tz) {
  const d = new Date(ms);
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}.${String(d.getMilliseconds()).padStart(3, '0')}` };
  } catch (e) { // tz sai -> dùng giờ UTC
    const iso = d.toISOString();
    return { day: iso.slice(0, 10), time: iso.slice(0, 10) + ' ' + iso.slice(11, 23) };
  }
}

/**
 * Chuẩn hoá đường dẫn thư mục log:
 *  - Hỗ trợ cả khi người dùng nhập "cd /sdcard/bot/log", "cd/sdcard/bot/log", "sdcard/bot/log" -> "/sdcard/bot/log"
 *  - Đường dẫn tương đối khác sẽ tính từ baseDir (thư mục chứa config.json).
 */
function normalizeLogDir(raw, baseDir = process.cwd()) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^cd(?:\s+|\/+)(?=\/?(?:sdcard|storage)\b)/i, '').trim();
  if (/^(?:sdcard|storage\/emulated\/0)(?:\/|$)/i.test(s)) s = '/' + s;
  return path.resolve(baseDir, s);
}

/**
 * Chọn thư mục log mặc định khi chưa cấu hình ANTER_LOG_DIR / fileLogDir:
 *  - Trong môi trường test (os.tmpdir): dùng <baseDir>/logs.
 *  - Trên Termux / Android (hoặc khi có /sdcard hoặc tạo được /sdcard/bot/log): dùng /sdcard/bot/log.
 *  - Các môi trường PC/VPS không có /sdcard: dùng <baseDir>/logs.
 */
function resolveDefaultLogDir(baseDir = process.cwd()) {
  const tmp = os.tmpdir();
  if (tmp && path.resolve(baseDir).startsWith(path.resolve(tmp))) {
    return path.join(baseDir, 'logs');
  }
  const isAndroid = process.platform === 'android'
    || !!process.env.TERMUX_VERSION
    || String(process.env.PREFIX || '').includes('com.termux');
  if (isAndroid || path.resolve(baseDir).startsWith('/sdcard') || fs.existsSync('/sdcard')) {
    return SDCARD_LOG_DIR;
  }
  try {
    fs.mkdirSync(SDCARD_LOG_DIR, { recursive: true });
    return SDCARD_LOG_DIR;
  } catch (e) {
    return path.join(baseDir, 'logs');
  }
}

class FileLogger {
  /** opts: { dir, tz: () => 'Asia/Ho_Chi_Minh', redact: s => s, now: () => Date.now() } */
  constructor(opts = {}) {
    this.dir = opts.dir ? normalizeLogDir(opts.dir) : path.join(process.cwd(), 'logs');
    this._tz = typeof opts.tz === 'function' ? opts.tz : () => 'Asia/Ho_Chi_Minh';
    this._redact = typeof opts.redact === 'function' ? opts.redact : s => s;
    this._now = opts.now || Date.now;
    this.enabled = true; this.format = 'text'; this.keepDays = 7; this.maxBytes = 10 * 1024 * 1024;
    this.levels = new Set(LEVELS.filter(l => l !== 'chat'));
    this._q = [];            // dòng chờ ghi: { day, text }
    this._busy = false; this._timer = null;
    this._cur = null;        // { day, part, size, file }
    this._pruned = '';       // ngày đã dọn file cũ gần nhất
    this._lastErr = '';      // lỗi ghi file đã báo gần nhất (chỉ báo lại khi lỗi/thư mục đổi)
    this.onError = typeof opts.onError === 'function' ? opts.onError : (msg => { try { console.error('\x1b[33m[FileLogger]\x1b[0m ' + msg); } catch (e) { /* bỏ qua */ } });
    this._onExit = () => this.flushSync();
    process.on('exit', this._onExit);
  }
  configure(c = {}) {
    if (c.enabled !== undefined) this.enabled = c.enabled !== false;
    if (c.dir) { this.dir = normalizeLogDir(c.dir, c.baseDir); this._cur = null; }
    if (c.format !== undefined) this.format = String(c.format).toLowerCase() === 'json' ? 'json' : 'text';
    if (c.keepDays !== undefined) this.keepDays = Math.min(3650, Math.max(1, Math.floor(Number(c.keepDays)) || 7));
    if (c.maxMB !== undefined) this.maxBytes = Math.min(1024, Math.max(0.1, Number(c.maxMB) || 10)) * 1024 * 1024;
    if (c.levels !== undefined || c.includeChat !== undefined) {
      let lv = c.levels === undefined || c.levels === 'all' || c.levels === null ? LEVELS.filter(l => l !== 'chat') : [].concat(c.levels).map(String);
      lv = lv.filter(l => LEVELS.includes(l));
      if (c.includeChat && !lv.includes('chat')) lv.push('chat');
      this.levels = new Set(lv);
    }
    return this;
  }
  // Lỗi ghi file (thiếu quyền /sdcard, ổ đầy...): báo ra console ĐÚNG 1 lần cho mỗi lỗi — trước đây im lặng nên không biết vì sao không có file log
  _fail(e) {
    dbg('FileLogger', e);
    this._cur = null;
    const key = this.dir + '|' + (e && (e.code || e.message));
    if (key === this._lastErr) return;
    this._lastErr = key;
    try { this.onError(`Không ghi được log vào "${this.dir}": ${e && e.code ? e.code + ' — ' : ''}${(e && e.message) || e}`); } catch (e2) { dbg('FileLogger', e2); }
  }
  // Đảm bảo thư mục (vd /sdcard/bot/log) và file log của ngày hiện tại tồn tại trên ổ đĩa; chưa có thì tạo ngay.
  ensureFile(ms = this._now()) {
    if (!this.enabled) return null;
    const { day } = fmtTime(ms, this._tz());
    const c = this._open(day);
    return c.name(c.part);
  }
  get currentFile() {
    if (this._cur) return this._cur.name(this._cur.part);
    const { day } = fmtTime(this._now(), this._tz());
    return path.join(this.dir, `runtime-${day}.${this.ext}`);
  }
  // Thử tạo thư mục + tạo sẵn file log thực tế + đẩy hàng đợi đang chờ. Trả về null nếu ổn, hoặc chuỗi lỗi.
  probe() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = path.join(this.dir, '.write-test-' + process.pid);
      fs.writeFileSync(f, 'ok'); fs.unlinkSync(f);
      if (this.enabled) {
        this.ensureFile();
        if (this._q.length) {
          for (const b of this._take()) {
            for (const w of this._plan(b.day, b.entries)) fs.appendFileSync(w.file, w.text);
          }
        }
      }
      return null;
    } catch (e) { return `${e.code ? e.code + ' — ' : ''}${e.message}`; }
  }
  get ext() { return this.format === 'json' ? 'jsonl' : 'log'; }

  /** Ghi 1 dòng log. bot: id bot hoặc 'system'. entry: { level, msg, time } */
  write(bot, entry) {
    if (!this.enabled || !entry) return;
    try {
      const level = String(entry.level || 'sys').toLowerCase();
      if (!this.levels.has(level)) return;
      let msg = entry.msg;
      msg = msg === undefined || msg === null ? '' : (msg instanceof Error ? (msg.stack || msg.message) : (typeof msg === 'string' ? msg : (() => { try { return typeof msg === 'object' ? JSON.stringify(msg) : String(msg); } catch (e) { return String(msg); } })()));
      msg = this._redact(String(msg).replace(ANSI_RE, '').replace(MC_RE, '').replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
      if (msg.length > MAX_LINE) msg = msg.slice(0, MAX_LINE) + '…(cắt)';
      const t = Number(entry.time) || this._now();
      const { day, time } = fmtTime(t, this._tz());
      const who = String(bot == null ? 'system' : bot);
      const text = this.format === 'json'
        ? JSON.stringify({ t: new Date(t).toISOString(), level, bot: who, msg }) + '\n'
        : `${time} [${level.toUpperCase().padEnd(6)}] [${who}] ${msg.replace(/\n/g, '\n    ')}\n`;
      this._q.push({ day, text });
      if (this._q.length > 20000) this._q.splice(0, this._q.length - 20000); // ổ đĩa kẹt: không để hàng đợi phình vô hạn
      this._arm();
    } catch (e) { dbg('FileLogger', e); }
  }

  _arm() {
    if (this._timer || this._busy) return;
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, 1000);
    if (this._timer.unref) this._timer.unref();
  }
  // File đang ghi cho ngày `day`: luôn đảm bảo thư mục & file tồn tại (nếu bị xoá giữa chừng thì tự tạo lại)
  _open(day) {
    const ext = this.ext;
    fs.mkdirSync(this.dir, { recursive: true });
    if (!this._cur || this._cur.day !== day || this._cur.ext !== ext || this._cur.dir !== this.dir) {
      let part = 0, size = 0;
      const name = p => path.join(this.dir, `runtime-${day}${p ? '.' + p : ''}.${ext}`);
      while (true) {
        try { size = fs.statSync(name(part)).size; } catch (e) { size = 0; break; }
        if (size < this.maxBytes) break;
        part++;
      }
      this._cur = { day, ext, dir: this.dir, part, size, name };
      if (this._pruned !== day) { this._pruned = day; this._prune(day); }
    } else {
      try {
        this._cur.size = fs.statSync(this._cur.name(this._cur.part)).size;
      } catch (e) {
        this._cur.size = 0;
      }
    }
    const target = this._cur.name(this._cur.part);
    if (!fs.existsSync(target)) {
      fs.appendFileSync(target, '');
    }
    return this._cur;
  }
  // Chia các dòng của 1 ngày thành các khối [{ file, text }] sao cho mỗi file không vượt maxBytes (không cắt giữa 1 mục log)
  _plan(day, entries) {
    const c = this._open(day), out = [];
    let text = '';
    for (const e of entries) {
      const n = Buffer.byteLength(e);
      if (c.size > 0 && c.size + n > this.maxBytes) {
        if (text) { out.push({ file: c.name(c.part), text }); text = ''; }
        c.part++; c.size = 0;
      }
      text += e; c.size += n;
    }
    if (text) out.push({ file: c.name(c.part), text });
    return out;
  }
  _prune(today) {
    try {
      const limit = Date.parse(today + 'T00:00:00Z') - this.keepDays * DAY_MS;
      for (const f of fs.readdirSync(this.dir)) {
        const m = /^runtime-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.(?:log|jsonl)$/.exec(f);
        if (m && Date.parse(m[1] + 'T00:00:00Z') < limit) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { dbg('FileLogger', e); } }
      }
    } catch (e) { dbg('FileLogger', e); }
  }
  // Gom các mục log liên tiếp cùng ngày: [{ day, entries: [text, ...] }]
  _take() {
    const out = [];
    for (const r of this._q.splice(0)) {
      const last = out[out.length - 1];
      if (last && last.day === r.day) last.entries.push(r.text); else out.push({ day: r.day, entries: [r.text] });
    }
    return out;
  }
  _flush() {
    if (this._busy || !this._q.length) return Promise.resolve();
    this._busy = true;
    const blocks = this._take();
    return (async () => {
      for (const b of blocks) {
        try {
          for (const w of this._plan(b.day, b.entries)) {
            await fs.promises.mkdir(path.dirname(w.file), { recursive: true });
            await fs.promises.appendFile(w.file, w.text);
          }
        } catch (e) { this._fail(e); }
      }
    })().finally(() => { this._busy = false; if (this._q.length) this._arm(); });
  }
  /** Ghi hết ngay, đồng bộ (dùng khi thoát tiến trình / sập / khởi động) */
  flushSync() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const b of this._take()) {
      try {
        for (const w of this._plan(b.day, b.entries)) {
          fs.mkdirSync(path.dirname(w.file), { recursive: true });
          fs.appendFileSync(w.file, w.text);
        }
      } catch (e) { this._fail(e); }
    }
  }
  async flush() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } await this._flush(); this.flushSync(); }
  close() { this.flushSync(); process.removeListener('exit', this._onExit); }
}
FileLogger.LEVELS = LEVELS;
FileLogger.SDCARD_LOG_DIR = SDCARD_LOG_DIR;
FileLogger.normalizeLogDir = normalizeLogDir;
FileLogger.resolveDefaultLogDir = resolveDefaultLogDir;
module.exports = FileLogger;
