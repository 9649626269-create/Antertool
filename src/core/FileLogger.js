'use strict';
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');

/**
 * FileLogger — ghi LOG RUNTIME (log từng bot + log hệ thống) ra file trên máy, để còn đọc được sau khi tool sập/tắt.
 *
 *  - Mỗi ngày một file: logs/runtime-YYYY-MM-DD.log (cùng 1 file cho mọi bot, mỗi dòng ghi rõ bot nào). Quá maxMB thì sang
 *    runtime-YYYY-MM-DD.1.log, .2.log... Tự xoá file cũ hơn keepDays ngày (khi khởi động và khi sang ngày mới).
 *  - Dòng text:  2026-10-17 23:45:01.123 [WARN ] [bot-1] nội dung      (xuống dòng -> các dòng sau thụt vào 4 khoảng trắng)
 *    format "json": mỗi dòng 1 JSON {t, level, bot, msg} -> file .jsonl, dễ lọc bằng jq / công cụ khác.
 *  - Che mật khẩu/token bằng hàm redact do chủ tool đưa vào (dùng chung bộ lọc của TelegramLogger).
 *  - Ghi BẤT ĐỒNG BỘ theo lô (mỗi ~1s) nên không làm chậm bot; thoát tiến trình thì tự ghi nốt đồng bộ.
 *    Lỗi ghi file (hết ổ đĩa, thiếu quyền...) chỉ im lặng bỏ qua (ANTER_DEBUG=1 để thấy) — không bao giờ làm hỏng bot.
 *  - Mặc định không ghi chat của người chơi (riêng tư + rất nhiều); bật bằng includeChat.
 */
const DAY_MS = 86400000;
const MAX_LINE = 8000;
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MC_RE = /[§§][0-9a-fk-or]/gi;
const LEVELS = ['sys', 'ok', 'warn', 'err', 'afk', 'shard', 'proxy', 'health', 'chat'];

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

class FileLogger {
  /** opts: { dir, tz: () => 'Asia/Ho_Chi_Minh', redact: s => s, now: () => Date.now() } */
  constructor(opts = {}) {
    this.dir = opts.dir || path.join(process.cwd(), 'logs');
    this._tz = typeof opts.tz === 'function' ? opts.tz : () => 'Asia/Ho_Chi_Minh';
    this._redact = typeof opts.redact === 'function' ? opts.redact : s => s;
    this._now = opts.now || Date.now;
    this.enabled = true; this.format = 'text'; this.keepDays = 7; this.maxBytes = 10 * 1024 * 1024;
    this.levels = new Set(LEVELS.filter(l => l !== 'chat'));
    this._q = [];            // dòng chờ ghi: { day, text }
    this._busy = false; this._timer = null;
    this._cur = null;        // { day, part, size, file }
    this._pruned = '';       // ngày đã dọn file cũ gần nhất
    this._onExit = () => this.flushSync();
    process.on('exit', this._onExit);
  }
  configure(c = {}) {
    if (c.enabled !== undefined) this.enabled = c.enabled !== false;
    if (c.dir) { this.dir = c.dir; this._cur = null; }
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
  // File đang ghi cho ngày `day`: chọn phần (part) cuối cùng còn chỗ
  _open(day) {
    const ext = this.ext;
    if (!this._cur || this._cur.day !== day || this._cur.ext !== ext || this._cur.dir !== this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      let part = 0, size = 0;
      const name = p => path.join(this.dir, `runtime-${day}${p ? '.' + p : ''}.${ext}`);
      while (true) {
        try { size = fs.statSync(name(part)).size; } catch (e) { size = 0; break; }
        if (size < this.maxBytes) break;
        part++;
      }
      this._cur = { day, ext, dir: this.dir, part, size, name };
      if (this._pruned !== day) { this._pruned = day; this._prune(day); }
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
        try { for (const w of this._plan(b.day, b.entries)) await fs.promises.appendFile(w.file, w.text); }
        catch (e) { dbg('FileLogger', e); this._cur = null; }
      }
    })().finally(() => { this._busy = false; if (this._q.length) this._arm(); });
  }
  /** Ghi hết ngay, đồng bộ (dùng khi thoát tiến trình / sập) */
  flushSync() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    for (const b of this._take()) {
      try { for (const w of this._plan(b.day, b.entries)) fs.appendFileSync(w.file, w.text); }
      catch (e) { dbg('FileLogger', e); this._cur = null; }
    }
  }
  async flush() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } await this._flush(); this.flushSync(); }
  close() { this.flushSync(); process.removeListener('exit', this._onExit); }
}
FileLogger.LEVELS = LEVELS;
module.exports = FileLogger;
