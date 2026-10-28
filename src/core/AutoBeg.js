'use strict';
/**
 * AutoBeg — Auto Xin Tiền / Auto Thu Tiền cho MỘT bot (mỗi BotSession có một bản riêng, mặc định TẮT).
 *
 * "Clone" = một bot đã có trong config.json (thêm bằng `addbot`, đăng nhập bằng quy trình hiện có: /dn, AutoLogin, menu...).
 * Module KHÔNG tự tạo tài khoản, KHÔNG vượt xác thực / giới hạn tài khoản / chống spam của server.
 *
 * Vòng đời (state machine, mọi chuyển trạng thái đều được kiểm tra — xem TRANSITIONS):
 *   OFF → STARTING → CONNECTING → READY → REQUESTING → CHECKING_BALANCE → TRANSFERRING → VERIFYING → READY ...
 *   PAUSED (lỗi/giới hạn) · STOPPING (dừng có kiểm soát). Mỗi bot chỉ có MỘT vòng chạy (generation counter `_gen`).
 *
 * Lệnh server đã xác minh: /msg <player> <text> · /bal · /pay <player> <amount> (1 lần, không /pay confirm).
 * Phản hồi server chỉ được nhận qua listener 'message' CỦA CHÍNH BOT NÀY (BotSession gọi onMessage) — không đọc log hiển thị.
 * Nhãn [Server]/[S1] trong console chỉ là kết quả của ChatFilter/logger (main.js) khi hiển thị; sự kiện luôn thuộc đúng bot đã nhận.
 *
 * Nguyên tắc tiền bạc:
 *   - /pay KHÔNG bao giờ kích hoạt từ tin "Bạn nhận được" (có thể bị giả mạo); chỉ từ số dư đọc được qua /bal do chính bot hỏi.
 *   - Mọi dòng server chỉ được tin khi: khớp toàn dòng, bắt đầu bằng "»", position = 'system' (trustedPositions), và đang chờ đúng loại phản hồi.
 *   - Ghi "ý định giao dịch" xuống đĩa (đồng bộ) TRƯỚC khi gửi /pay. Gửi đúng 1 lần. Không có phản hồi = UNKNOWN → tạm dừng cứng, KHÔNG gửi lại.
 *   - Không coi là thành công nếu thiếu bằng chứng từ server (dòng "Bạn đã chuyển cho..." khớp owner + số tiền,
 *     hoặc bot Owner cùng hệ thống báo "Bạn nhận được ... từ <bot>").
 */
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');
const { normalizeVi } = require('./PremiumLogic');
const M = require('./MoneyParse');

const ST = Object.freeze({
  OFF: 'OFF', STARTING: 'STARTING', CONNECTING: 'CONNECTING', READY: 'READY', REQUESTING: 'REQUESTING',
  CHECKING_BALANCE: 'CHECKING_BALANCE', TRANSFERRING: 'TRANSFERRING', VERIFYING: 'VERIFYING', PAUSED: 'PAUSED', STOPPING: 'STOPPING',
});

const TRANSITIONS = Object.freeze({
  OFF: [ST.STARTING],
  STARTING: [ST.CONNECTING, ST.READY, ST.PAUSED, ST.STOPPING, ST.OFF],
  CONNECTING: [ST.READY, ST.PAUSED, ST.STOPPING],
  READY: [ST.REQUESTING, ST.CHECKING_BALANCE, ST.CONNECTING, ST.PAUSED, ST.STOPPING],
  REQUESTING: [ST.CHECKING_BALANCE, ST.READY, ST.CONNECTING, ST.PAUSED, ST.STOPPING],
  CHECKING_BALANCE: [ST.TRANSFERRING, ST.READY, ST.CONNECTING, ST.PAUSED, ST.STOPPING],
  TRANSFERRING: [ST.VERIFYING, ST.READY, ST.CONNECTING, ST.PAUSED, ST.STOPPING],
  VERIFYING: [ST.READY, ST.PAUSED, ST.STOPPING],
  PAUSED: [ST.READY, ST.CONNECTING, ST.STOPPING],
  STOPPING: [ST.OFF],
});

const RS = Object.freeze({ PENDING: 'PENDING', SENT: 'SENT', CONFIRMED: 'CONFIRMED', FAILED: 'FAILED', SKIPPED: 'SKIPPED' });
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MC_CHAT_MAX = 256;

// Sàn an toàn (test có thể hạ xuống bằng opts.floors). Không cho cấu hình gửi nhanh hơn mức này.
const FLOORS = Object.freeze({ messageDelayMs: 1500, responseTimeoutMs: 2000, roundCooldownMs: 30000, maxMessagesPerMinute: 1, dedupWindowMs: 0 });

const DEFAULTS = Object.freeze({
  enabled: false,
  autoTransfer: true,
  dryRun: false,
  owner: '',
  minBalanceThreshold: '100K',
  reserve: '0',
  maxTransferAmount: '',
  requestMessageTemplate: 'Em là newbie ạ, anh/chị cho em xin 100k mua giáp khởi nghiệp với huhu',
  thankMessageTemplate: 'Cảm ơn anh/chị nhiều ạ ❤',
  thankEnabled: true,
  thankCooldownMs: 60000,
  recipientMode: 'allowlist',          // 'allowlist' = chỉ allowedRecipients · 'online' = mọi người online trừ blacklist
  allowedRecipients: [],
  blacklistRecipients: [],
  messageDelayMs: 3000,
  responseTimeoutMs: 5000,
  maxMessagesPerMinute: 12,
  maxRecipientsPerRound: 20,
  maxRounds: 3,
  roundCooldownMs: 600000,
  askCooldownMs: 86400000,
  dedupWindowMs: 1000,
  verifyWithBalance: true,
  balanceRetries: 1,
  readyTimeoutMs: 600000,
  trustedPositions: ['system'],
  declinePatterns: [],
  rateLimitPatterns: [],
  payFailurePatterns: [],
});

const DEFAULT_DECLINE = [
  /\b(?:dung|ngung|thoi|dung co|khong|ko|dung\s+co)\s+(?:nhan\s*tin|xin|spam|quay|nhan)\b/,
  /\b(?:spam|stop|leave me alone|do not message|don'?t message|dont message|stop messaging)\b/,
  /\b(?:biet roi|bien di|cut di|di cho khac)\b/,
];
const DEFAULT_RATELIMIT = [/\b(?:qua nhanh|cham lai|slow down|too fast|dung spam|vui long cho)\b/];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const safeRe = (src) => { try { return new RegExp(normalizeVi(String(src)), ''); } catch { return null; } };
const uniqLower = arr => [...new Set(arr.map(x => String(x).trim().toLowerCase()).filter(Boolean))];

function sanitizeText(s) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').replace(/§./g, '').replace(/\s+/g, ' ').trim();
}
function render(tpl, vars = {}) {
  return sanitizeText(String(tpl).replace(/\{(player|amount|owner)\}/g, (_, k) => String(vars[k] ?? '')));
}

/**
 * Kiểm tra & chuẩn hoá cấu hình autoBeg. Trả { o, errors[], warnings[] }.
 *  - errors: cấu hình sai kiểu / không hợp lệ -> KHÔNG cho bật (không tự đoán giá trị)
 *  - warnings: số ngoài khoảng -> kẹp về giới hạn an toàn và báo
 * Thiếu owner chỉ là lỗi khi bật chuyển tiền (autoTransfer).
 */
function resolveOptions(user, floors = FLOORS) {
  const u = isObj(user) ? user : {};
  const errors = []; const warnings = [];
  const D = DEFAULTS;
  const bool = (k) => {
    if (u[k] === undefined || u[k] === null) return D[k];
    if (typeof u[k] !== 'boolean') { errors.push(`autoBeg.${k} phải là true/false`); return D[k]; }
    return u[k];
  };
  const num = (k, lo, hi, floor = null) => {
    if (u[k] === undefined || u[k] === null) return Math.max(D[k], floor ?? -Infinity);
    const n = u[k];
    if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push(`autoBeg.${k} phải là số`); return D[k]; }
    let v = n; const min = Math.max(lo, floor ?? -Infinity);
    if (v < min) { warnings.push(`autoBeg.${k}=${n} thấp hơn mức an toàn, dùng ${min}`); v = min; }
    if (v > hi) { warnings.push(`autoBeg.${k}=${n} cao hơn giới hạn, dùng ${hi}`); v = hi; }
    return Math.floor(v);
  };
  const str = (k) => {
    if (u[k] === undefined || u[k] === null) return D[k];
    if (typeof u[k] !== 'string') { errors.push(`autoBeg.${k} phải là chuỗi`); return D[k]; }
    return u[k];
  };
  const big = (k, allowEmpty) => {
    const raw = u[k] === undefined || u[k] === null ? D[k] : u[k];
    if (raw === '' && allowEmpty) return null;
    const b = M.toBigIntConfig(raw);
    if (b === null) { errors.push(`autoBeg.${k}="${raw}" không phải số tiền hợp lệ (ví dụ "100K", 100000)`); return null; }
    return b;
  };
  const list = (k, lower = true) => {
    if (u[k] === undefined || u[k] === null) return [];
    if (!Array.isArray(u[k])) { errors.push(`autoBeg.${k} phải là mảng tên người chơi`); return []; }
    const out = [];
    for (const x of u[k]) {
      const nm = String(x).trim();
      if (!NAME_RE.test(nm)) { warnings.push(`autoBeg.${k}: bỏ qua tên không hợp lệ "${nm}"`); continue; }
      out.push(lower ? nm.toLowerCase() : nm);
    }
    return [...new Set(out)];
  };
  const regs = (k) => {
    if (u[k] === undefined || u[k] === null) return [];
    if (!Array.isArray(u[k])) { errors.push(`autoBeg.${k} phải là mảng regex`); return []; }
    const out = [];
    for (const x of u[k]) { const r = safeRe(x); if (r) out.push(r); else errors.push(`autoBeg.${k}: regex không hợp lệ "${x}"`); }
    return out;
  };

  const o = {
    enabled: bool('enabled'), autoTransfer: bool('autoTransfer'), dryRun: bool('dryRun'),
    thankEnabled: bool('thankEnabled'), verifyWithBalance: bool('verifyWithBalance'),
    owner: str('owner').trim(),
    requestMessageTemplate: str('requestMessageTemplate'), thankMessageTemplate: str('thankMessageTemplate'),
    messageDelayMs: num('messageDelayMs', 0, 600000, floors.messageDelayMs),
    responseTimeoutMs: num('responseTimeoutMs', 0, 120000, floors.responseTimeoutMs),
    maxMessagesPerMinute: num('maxMessagesPerMinute', 1, 30, floors.maxMessagesPerMinute),
    maxRecipientsPerRound: num('maxRecipientsPerRound', 0, 500, 0),
    maxRounds: num('maxRounds', 1, 100, 1),
    roundCooldownMs: num('roundCooldownMs', 0, 86400000, floors.roundCooldownMs),
    askCooldownMs: num('askCooldownMs', 0, 30 * 86400000, 0),
    dedupWindowMs: num('dedupWindowMs', 0, 60000, floors.dedupWindowMs),
    thankCooldownMs: num('thankCooldownMs', 0, 86400000, 0),
    balanceRetries: num('balanceRetries', 0, 5, 0),
    readyTimeoutMs: num('readyTimeoutMs', 1000, 86400000, 1000),
    allowedRecipients: list('allowedRecipients'), blacklistRecipients: list('blacklistRecipients'),
    minBalance: big('minBalanceThreshold', false), reserve: big('reserve', false), maxTransfer: big('maxTransferAmount', true),
    declinePatterns: regs('declinePatterns'), rateLimitPatterns: regs('rateLimitPatterns'), payFailurePatterns: regs('payFailurePatterns'),
  };
  const mode = u.recipientMode === undefined || u.recipientMode === null ? D.recipientMode : u.recipientMode;
  if (mode !== 'allowlist' && mode !== 'online') { errors.push('autoBeg.recipientMode phải là "allowlist" hoặc "online"'); o.recipientMode = D.recipientMode; } else o.recipientMode = mode;
  if (u.trustedPositions === undefined || u.trustedPositions === null) o.trustedPositions = [...D.trustedPositions];
  else if (!Array.isArray(u.trustedPositions) || !u.trustedPositions.length || !u.trustedPositions.every(x => typeof x === 'string')) {
    errors.push('autoBeg.trustedPositions phải là mảng chuỗi không rỗng (ví dụ ["system"])'); o.trustedPositions = [...D.trustedPositions];
  } else o.trustedPositions = u.trustedPositions.map(x => x.trim()).filter(Boolean);
  o.minBalance = o.minBalance === null ? M.toBigIntConfig(D.minBalanceThreshold) : o.minBalance;
  o.reserve = o.reserve === null ? 0n : o.reserve;

  // owner (không tự đoán): chỉ kiểm tra hình dạng; "không trùng tên bot" kiểm khi bật vì cần biết tên bot
  o.ownerValid = NAME_RE.test(o.owner);
  // mẫu tin: không rỗng, đủ ngắn cho /msg <tên 16 ký tự> <nội dung> <= 256 ký tự
  for (const [k, vars] of [['requestMessageTemplate', { player: 'x'.repeat(16) }], ['thankMessageTemplate', { player: 'x'.repeat(16), amount: '999.99B' }]]) {
    const rendered = render(o[k], vars);
    if (!rendered) errors.push(`autoBeg.${k} không được rỗng`);
    else if (`/msg ${'x'.repeat(16)} ${rendered}`.length > MC_CHAT_MAX) errors.push(`autoBeg.${k} quá dài (lệnh /msg tối đa ${MC_CHAT_MAX} ký tự)`);
    o[k] = String(o[k]);
  }
  return { o, errors, warnings };
}

/** Kiểm tra đối số lệnh `msg <player> <tin nhắn>` (dùng cả cho lệnh tay). */
function parseMsgArgs(args, selfName = '') {
  const list = Array.isArray(args) ? args : [];
  const name = String(list[0] || '').trim();
  if (!name) return { ok: false, error: 'Thiếu tên người nhận. Cú pháp: msg <người chơi> <tin nhắn>' };
  if (!NAME_RE.test(name)) return { ok: false, error: `Tên người chơi không hợp lệ: "${name.slice(0, 24)}" (3-16 ký tự chữ/số/_)` };
  if (selfName && name.toLowerCase() === String(selfName).toLowerCase()) return { ok: false, error: 'Không thể nhắn cho chính bot' };
  const text = sanitizeText(list.slice(1).join(' '));
  if (!text) return { ok: false, error: 'Thiếu nội dung tin nhắn. Cú pháp: msg <người chơi> <tin nhắn>' };
  const cmd = `/msg ${name} ${text}`;
  if (cmd.length > MC_CHAT_MAX) return { ok: false, error: `Tin nhắn quá dài (${cmd.length}/${MC_CHAT_MAX} ký tự gồm cả "/msg ${name} ")` };
  return { ok: true, name, text, cmd };
}

/**
 * BegLedger — sổ ghi chung (autobeg.json) cho mọi bot: người đã xin, người từ chối, nhật ký giao dịch /pay.
 * Ghi file nguyên tử (tmp + rename). File hỏng không bị ghi đè: đổi tên thành .corrupt-<time> rồi bắt đầu sổ mới.
 */
class BegLedger {
  constructor(file, now = Date.now) {
    this.file = file || null; this._now = now; this._timer = null;
    this.data = { asked: {}, declined: {}, tx: [] };
    this._load();
  }
  _load() {
    if (!this.file) return;
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    try {
      const j = JSON.parse(raw);
      if (!isObj(j)) throw new Error('not-object');
      this.data.asked = isObj(j.asked) ? j.asked : {};
      this.data.declined = isObj(j.declined) ? j.declined : {};
      this.data.tx = Array.isArray(j.tx) ? j.tx.filter(isObj) : [];
    } catch (e) {
      try { fs.renameSync(this.file, `${this.file}.corrupt-${this._now()}`); } catch (e2) { dbg('BegLedger', e2); }
      dbg('BegLedger', e);
    }
    const cut = this._now() - 30 * 86400000;
    for (const [k, v] of Object.entries(this.data.asked)) if (!v || !(v.at > cut)) delete this.data.asked[k];
  }
  _save() {
    if (!this.file) return;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try {
      this.data.tx = this.data.tx.slice(-100);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) { dbg('BegLedger', e); }
  }
  _later() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._save(); }, 1000);
    if (this._timer.unref) this._timer.unref();
  }
  askedRecently(lower, cooldownMs) { const a = this.data.asked[lower]; return !!a && this._now() - a.at < cooldownMs; }
  /** Đánh dấu "bot này đang xin người này" nếu chưa ai xin trong cooldown. Trả false nếu đã có người xin (tránh nhiều clone cùng xin 1 người). */
  claim(lower, botId, cooldownMs) {
    if (this.askedRecently(lower, cooldownMs)) return false;
    this.data.asked[lower] = { at: this._now(), by: botId }; this._later(); return true;
  }
  release(lower, botId) { const a = this.data.asked[lower]; if (a && a.by === botId) { delete this.data.asked[lower]; this._later(); } }
  isDeclined(lower) { return !!this.data.declined[lower]; }
  markDeclined(lower) { this.data.declined[lower] = { at: this._now() }; this._save(); }
  forget(lower) { const had = !!(this.data.asked[lower] || this.data.declined[lower]); delete this.data.asked[lower]; delete this.data.declined[lower]; if (had) this._save(); return had; }
  addTx(rec) { this.data.tx.push(rec); this._save(); }       // ĐỒNG BỘ: phải xuống đĩa trước khi gửi /pay
  updateTx(id, patch) { const t = this.data.tx.find(x => x.id === id); if (t) { Object.assign(t, patch); this._save(); } return t || null; }
  unresolved(botId) { return this.data.tx.filter(t => t.botId === botId && ['INTENT', 'SENT', 'UNKNOWN'].includes(t.status)); }
}

class AutoBeg {
  constructor(session, opts = {}) {
    this.s = session;
    this._now = opts.now || Date.now;
    this._floors = opts.floors || FLOORS;
    this.ledger = opts.ledger !== undefined ? opts.ledger
      : AutoBeg.ledgerFor(opts.file !== undefined ? opts.file : path.join(process.cwd(), 'autobeg.json'), this._now);
    this.state = ST.OFF;
    this._gen = 0;
    this._hard = false; this._pauseReason = '';
    this._stopRequested = false; this._completed = false;
    this._txBusy = false; this._payCtx = null; this._balCtx = null;
    this.unknownTx = null; this._reconciled = false;
    this.roundsDone = 0; this.round = null; this._roundSeq = 0;
    this._inflight = new Map();
    this._thankQ = []; this._thanked = new Map(); this._seen = new Map(); this._evSeq = 0;
    this._sentTimes = []; this._nextSendAt = 0; this._backoffUntil = 0; this._rlHits = []; this._kicks = [];
    this._balFailures = 0; this._ownerMisses = 0; this._notReadySince = 0;
    this._warned = new Set();
    this.stats = { asked: 0, confirmed: 0, failed: 0, skipped: 0, received: 0n, receivedCount: 0, duplicates: 0, thanked: 0, thankSuppressed: 0, pays: 0, paid: 0n };
    this.reload();
  }

  static ledgerFor(file, now = Date.now) {
    if (!AutoBeg._ledgers) AutoBeg._ledgers = new Map();
    const key = file || ':memory:';
    if (!AutoBeg._ledgers.has(key)) AutoBeg._ledgers.set(key, new BegLedger(file, now));
    return AutoBeg._ledgers.get(key);
  }
  /** Bằng chứng "X vừa nhận tiền từ Y" công bố cho mọi bot cùng hệ thống (xác nhận chéo khi Owner cũng là bot của Antertool). */
  static _publishReceipt(r) { (AutoBeg._receipts || (AutoBeg._receipts = [])).push(r); if (AutoBeg._receipts.length > 100) AutoBeg._receipts.shift(); }
  static findReceipt(toLower, fromLower, expected, sinceMs) {
    return (AutoBeg._receipts || []).find(r => r.to === toLower && r.from === fromLower && r.at >= sinceMs && M.amountMatches(expected, r.amount)) || null;
  }

  reload() {
    const r = resolveOptions(this.s.cfg?.autoBeg, this._floors);
    this.o = r.o; this.errors = r.errors; this.warnings = r.warnings;
  }
  get botId() { return String(this.s.cfg?.id ?? ''); }
  get myName() { return String(this.s.mc?.username || this.s.cfg?.username || ''); }
  get active() { return this.state !== ST.OFF && this.state !== ST.STOPPING; }
  get enabled() { return this.state !== ST.OFF; }
  log(level, msg) { try { this.s.log(level, `AutoBeg: ${msg}`); } catch (e) { dbg('AutoBeg', e); } }

  // ───────────────────────── state machine ─────────────────────────
  _to(next, why = '') {
    if (this.state === next) return true;
    if (!(TRANSITIONS[this.state] || []).includes(next)) { this.log('warn', `chuyển trạng thái không hợp lệ ${this.state} -> ${next} (bỏ qua)`); return false; }
    const prev = this.state; this.state = next;
    this.log('sys', `${prev} -> ${next}${why ? ` (${why})` : ''}`);
    return true;
  }
  _alive(gen) { return gen === this._gen && this.state !== ST.OFF && !this.s._disabled; }
  _pause(reason, hard) {
    this._hard = !!hard; this._pauseReason = reason;
    if (this._to(ST.PAUSED)) this.log(hard ? 'err' : 'warn', `TẠM DỪNG${hard ? ' (cần "autobeg resume")' : ' (tự tiếp tục khi sẵn sàng)'}: ${reason}`);
  }
  async _sleep(ms, gen) {
    const end = this._now() + ms;
    while (this._now() < end) {
      if (gen !== undefined && !this._alive(gen)) return false;
      await new Promise(r => setTimeout(r, Math.max(1, Math.min(200, end - this._now()))));
    }
    return gen === undefined ? true : this._alive(gen);
  }
  _isReady() {
    const s = this.s;
    return !!(s.isOnline && !s._disabled && s.mc && s._menuDoneAt && (!s.cfg?.botPassword || s._loginConfirmed) && !s.autoLogin?.inFlow);
  }

  /** Chờ tới khi bot thực sự đã vào server (đăng nhập + menu xong). false = vòng đã bị dừng. */
  async _gate(gen) {
    for (;;) {
      if (!this._alive(gen) || this._stopRequested) return false;
      if (this._hard) { await this._maybeReconcile(gen); await this._sleep(300, gen); continue; }
      if (this._isReady()) {
        this._notReadySince = 0;
        if ([ST.CONNECTING, ST.PAUSED, ST.STARTING].includes(this.state)) { this._pauseReason = ''; this._to(ST.READY); }
        return true;
      }
      const now = this._now();
      if (!this._notReadySince) this._notReadySince = now;
      if (![ST.PAUSED, ST.CONNECTING].includes(this.state)) this._to(ST.CONNECTING, 'bot chưa sẵn sàng hoặc mất kết nối — chính sách reconnect hiện có sẽ lo kết nối lại');
      else if (this.state === ST.CONNECTING && now - this._notReadySince > this.o.readyTimeoutMs) this._pause(`bot không sẵn sàng sau ${Math.round(this.o.readyTimeoutMs / 1000)}s`, false);
      await this._sleep(300, gen);
    }
  }

  // ───────────────────────── bật / tắt ─────────────────────────
  /** Bật. Trả { ok, reason }. Không bao giờ chạy hai vòng trên cùng một tài khoản. */
  enable({ dry = null, manual = true } = {}) {
    if (this.state !== ST.OFF) return { ok: false, reason: `đang chạy (${this.state})` };
    if (!manual && this._completed) return { ok: false, reason: 'đã hoàn tất maxRounds ở phiên này' };
    this.reload();
    if (dry !== null) this.o.dryRun = !!dry;
    if (this.errors.length) return { ok: false, reason: `cấu hình autoBeg không hợp lệ: ${this.errors.join(' | ')}` };
    if (this.o.autoTransfer) {
      if (!this.o.ownerValid) return { ok: false, reason: 'thiếu/sai autoBeg.owner (tên người nhận tiền, 3-16 ký tự). Không tự đoán — đặt owner trong config.json, hoặc đặt autoTransfer:false để chỉ xin tiền' };
      if (this.o.owner.toLowerCase() === this.myName.toLowerCase()) return { ok: false, reason: 'owner trùng tên chính bot này' };
    }
    if (this.o.recipientMode === 'allowlist' && !this.o.allowedRecipients.length) this.log('warn', 'recipientMode="allowlist" nhưng allowedRecipients trống — sẽ KHÔNG gửi tin xin tiền cho ai (đặt allowedRecipients, hoặc recipientMode:"online")');
    for (const w of this.warnings) this.log('warn', w);
    this._completed = false; this._stopRequested = false; this._hard = false; this._pauseReason = '';
    if (manual) this._userOff = false;
    this.roundsDone = 0; this._balFailures = 0; this._ownerMisses = 0; this._reconciled = false;
    const gen = ++this._gen;
    this._to(ST.STARTING);
    this.log('ok', `BẬT — chế độ ${this.o.dryRun ? 'DRY-RUN (không gửi /pay thật)' : 'LIVE'} · owner ${this.o.autoTransfer ? this.o.owner : '(không chuyển)'} · ngưỡng ${M.formatShort(this.o.minBalance)} · ${this.o.recipientMode}`);
    this._run(gen).catch(e => { this.log('err', `lỗi nội bộ: ${e.message}`); if (gen === this._gen && this.state !== ST.OFF) this._pause(`lỗi nội bộ: ${e.message}`, true); });
    this._thankLoop(gen).catch(e => dbg('AutoBeg', e));
    return { ok: true };
  }

  /** Gọi từ BotSession khi bot vào game: tự bật theo config (enabled:true) mà không ghi đè gì. */
  autoStartIfConfigured() {
    try {
      this.reload();
      if (this.o.enabled && this.state === ST.OFF && !this._completed && !this._userOff) {
        const r = this.enable({ manual: false });
        if (!r.ok) this.log('warn', `không tự bật được: ${r.reason}`);
      }
    } catch (e) { dbg('AutoBeg', e); }
  }

  /** Dừng có kiểm soát: không tạo tin/giao dịch mới; nếu đang chờ xác minh /pay thì chờ xong rồi mới tắt. */
  stop(reason = 'người dùng', { user = true } = {}) {
    if (this.state === ST.OFF) return false;
    this._userOff = !!user;
    this._clearQueues();
    if ([ST.TRANSFERRING, ST.VERIFYING].includes(this.state) || this._payCtx) {
      this._stopRequested = true; this._to(ST.STOPPING, `${reason}; chờ xác minh /pay đang dở`); return true;
    }
    this._hardOff(reason); return true;
  }
  /** Dừng KHẨN CẤP: ngay lập tức, không gửi thêm gì. Giao dịch /pay đã gửi mà chưa xác minh bị đánh dấu UNKNOWN. */
  estop(reason = 'dừng khẩn cấp', { user = true } = {}) {
    if (this.state === ST.OFF) return false;
    this._userOff = !!user;
    this._clearQueues();
    this._hardOff(reason, true); return true;
  }
  _clearQueues() { this._thankQ.length = 0; this._inflight.clear(); }
  _hardOff(reason, emergency = false) {
    this._gen++;                       // mọi vòng/loop đang chạy sẽ tự thoát ở lần kiểm tra kế tiếp
    if (this._payCtx) {                // đã gửi /pay mà chưa có kết quả
      const t = this._payCtx.tx;
      this._payCtx = null;
      if (t && t.status === 'SENT') { this.ledger.updateTx(t.id, { status: 'UNKNOWN', note: `dừng (${reason}) khi chưa xác minh` }); this.unknownTx = this.ledger.data.tx.find(x => x.id === t.id) || t; }
    }
    this._resolveBal({ ok: false, reason: 'stopped' });
    this._txBusy = false; this._stopRequested = false;
    const prev = this.state;
    this.state = ST.OFF;               // chủ ý bỏ qua bảng chuyển trạng thái: dừng luôn hợp lệ từ mọi trạng thái
    this.log(emergency ? 'warn' : 'sys', `${prev} -> OFF (${reason})`);
  }
  pause(reason = 'người dùng') { if (!this.active) return false; this._pause(reason, true); return true; }
  resume() {
    if (this.state !== ST.PAUSED) return { ok: false, reason: 'không ở trạng thái PAUSED' };
    if (this.unknownTx) {
      this.ledger.updateTx(this.unknownTx.id, { status: 'UNKNOWN_ACK', note: `operator xác nhận đã kiểm tra lúc ${new Date(this._now()).toISOString()}` });
      this.log('warn', `đã ghi nhận bạn kiểm tra giao dịch ${this.unknownTx.id} (không tự gửi lại). Tiếp tục.`);
      this.unknownTx = null;
    }
    this._hard = false; this._pauseReason = ''; this._rlHits.length = 0; this._balFailures = 0; this._ownerMisses = 0;
    this._to(this._isReady() ? ST.READY : ST.CONNECTING, 'resume');
    return { ok: true };
  }

  // ───────────────────────── vòng chính ─────────────────────────
  async _run(gen) {
    const un = this.ledger.unresolved(this.botId);
    if (un.length) {
      this.unknownTx = un[un.length - 1];
      for (const t of un) if (t.status !== 'UNKNOWN') this.ledger.updateTx(t.id, { status: 'UNKNOWN', note: 'bị ngắt giữa chừng lần chạy trước (INTENT/SENT chưa có kết quả)' });
      this._pause(`có giao dịch /pay chưa rõ kết quả từ lần chạy trước (${this.unknownTx.id}: ${this.unknownTx.amount} cho ${this.unknownTx.owner}). Kiểm tra số dư rồi gõ "autobeg resume"`, true);
    }
    for (;;) {
      if (!(await this._gate(gen))) return this._afterGateFalse(gen);
      if (this.roundsDone >= this.o.maxRounds) return this._finish(gen, `đã đủ ${this.o.maxRounds} vòng`);
      const done = await this._doRound(gen);
      if (!this._alive(gen)) return;
      if (this._stopRequested) return this._hardOff('dừng có kiểm soát');
      // Đang tạm dừng cứng (UNKNOWN/CONFLICT/spam...): KHÔNG được coi vòng là xong rồi tự tắt/nghỉ — phải chờ người vận hành "autobeg resume"
      if (this._hard && !(await this._gate(gen))) return this._afterGateFalse(gen);
      if (done) this.roundsDone++;
      if (this.roundsDone >= this.o.maxRounds) return this._finish(gen, `đã đủ ${this.o.maxRounds} vòng`);
      if (this.state !== ST.PAUSED) this._to(ST.READY);
      this.log('sys', `nghỉ ${Math.round(this.o.roundCooldownMs / 1000)}s trước vòng kế tiếp (${this.roundsDone}/${this.o.maxRounds})`);
      if (!(await this._sleep(this.o.roundCooldownMs, gen))) return this._afterGateFalse(gen);
    }
  }
  _afterGateFalse(gen) { if (gen === this._gen && this._stopRequested) this._hardOff('dừng có kiểm soát'); }
  _finish(gen, why) {
    if (gen !== this._gen) return;
    this._completed = true;
    this._to(ST.STOPPING, why);
    this._clearQueues();
    this._hardOff(`hoàn tất: ${why}`);
  }

  _newRound() {
    this._roundSeq++;
    return { id: `${this.botId}-${this._now().toString(36)}-${this._roundSeq}`, startedAt: this._now(), recipients: new Map() };
  }
  _siblings() {
    const out = new Set();
    try { for (const b of (this.s._manager?.bots || [])) { for (const n of [b?.cfg?.username, b?.mc?.username]) if (n) out.add(String(n).toLowerCase()); } } catch (e) { dbg('AutoBeg', e); }
    return out;
  }
  _pickRecipients() {
    const o = this.o;
    const online = Object.keys((this.s.mc && this.s.mc.players) || {});
    const me = this.myName.toLowerCase();
    const sib = this._siblings();
    const owner = o.owner.toLowerCase();
    const black = new Set(o.blacklistRecipients);
    const allow = new Set(o.allowedRecipients);
    const out = []; const seen = new Set();
    for (const name of online) {
      const l = String(name).toLowerCase();
      if (seen.has(l)) continue; seen.add(l);
      if (!NAME_RE.test(name)) continue;
      if (l === me || sib.has(l) || (owner && l === owner) || black.has(l)) continue;
      if (this.ledger.isDeclined(l)) continue;
      if (o.recipientMode === 'allowlist' && !allow.has(l)) continue;
      if (this.ledger.askedRecently(l, o.askCooldownMs)) continue;
      out.push({ name, lower: l });
      if (out.length >= o.maxRecipientsPerRound) break;
    }
    return out;
  }

  async _doRound(gen) {
    const round = this._newRound(); this.round = round;
    this._to(ST.REQUESTING);
    const picked = this._pickRecipients();
    for (const p of picked) round.recipients.set(p.lower, { name: p.name, status: RS.PENDING, at: 0, note: '' });
    this.log('ok', `vòng ${round.id}: ${picked.length} người nhận hợp lệ (tối đa ${this.o.maxRecipientsPerRound}/vòng)`);
    for (const rec of round.recipients.values()) {
      if (!(await this._gate(gen))) return false;
      if (this.state !== ST.REQUESTING) this._to(ST.REQUESTING);
      const r = await this._sendBeg(gen, rec);
      if (r === 'stopped') return false;
    }
    if (!(await this._settleInflight(gen))) return false;
    this._summarizeRound(round);
    await this._balanceAndTransfer(gen);
    return this._alive(gen);
  }

  async _sendBeg(gen, rec) {
    const lower = rec.name.toLowerCase();
    if (!this.ledger.claim(lower, this.botId, this.o.askCooldownMs)) { rec.status = RS.SKIPPED; rec.note = 'đã có bot/vòng khác xin gần đây'; this.stats.skipped++; return 'skipped'; }
    const text = render(this.o.requestMessageTemplate, { player: rec.name });
    const cmd = `/msg ${rec.name} ${text}`;
    for (;;) {
      if (!(await this._gate(gen))) { this.ledger.release(lower, this.botId); return 'stopped'; }
      const acq = await this._acquire(gen);
      if (acq === 'stopped') { this.ledger.release(lower, this.botId); return 'stopped'; }
      if (acq === 'notready') continue;                    // chưa gửi gì -> an toàn để thử lại sau khi sẵn sàng
      try {
        this.s.mc.chat(cmd);                              // GỬI ĐÚNG MỘT LẦN
      } catch (e) {
        rec.status = RS.FAILED; rec.note = `lỗi gửi: ${e.message}`; this.stats.failed++; this.ledger.release(lower, this.botId);
        this.log('warn', `không gửi được /msg tới ${rec.name}: ${e.message}`); return 'failed';
      }
      rec.status = RS.SENT; rec.at = this._now(); this.stats.asked++;
      this._inflight.set(`beg:${lower}`, { kind: 'beg', name: rec.name, lower, sentAt: rec.at, rec });
      this.log('sys', `đã gửi tin xin tiền tới ${rec.name} (chưa có bằng chứng server chấp nhận — chờ ${this.o.responseTimeoutMs}ms xem có báo lỗi)`);
      return 'sent';
    }
  }

  _summarizeRound(round) {
    const c = { PENDING: 0, SENT: 0, CONFIRMED: 0, FAILED: 0, SKIPPED: 0 };
    for (const r of round.recipients.values()) c[r.status]++;
    this.log('ok', `xong danh sách vòng ${round.id}: SENT ${c.SENT}, CONFIRMED ${c.CONFIRMED}, FAILED ${c.FAILED}, SKIPPED ${c.SKIPPED}`);
  }

  /** Chờ các tin đã gửi qua khoảng kiểm tra lỗi (offline...). Hết hạn mà không có lỗi = vẫn chỉ là SENT, không phải CONFIRMED. */
  async _settleInflight(gen) {
    for (;;) {
      this._expireInflight();
      if (!this._inflight.size) return true;
      if (!(await this._sleep(100, gen))) return false;
    }
  }
  _expireInflight() {
    const now = this._now();
    for (const [k, v] of this._inflight) if (now - v.sentAt >= this.o.responseTimeoutMs) this._inflight.delete(k);
  }

  // ───────────────────────── tốc độ gửi ─────────────────────────
  _waitMs(now) {
    this._sentTimes = this._sentTimes.filter(t => now - t < 60000);
    let w = Math.max(0, this._nextSendAt - now, this._backoffUntil - now);
    if (this._sentTimes.length >= this.o.maxMessagesPerMinute) w = Math.max(w, this._sentTimes[0] + 60000 - now);
    return w;
  }
  /**
   * Xin một "suất gửi". Trả 'ok' (đã giữ chỗ, phải gửi NGAY, đồng bộ), 'notready' (chưa gửi gì), 'stopped'.
   * tx=true: lệnh tài chính của chính giao dịch đang chạy (không bị chặn bởi _txBusy).
   */
  async _acquire(gen, { tx = false } = {}) {
    for (;;) {
      if (gen !== undefined && gen !== null && !this._alive(gen)) return 'stopped';
      if (this._stopRequested && !tx) return 'stopped';
      if (!this._isReady()) return 'notready';
      const now = this._now();
      const blocked = (!tx && this._txBusy) || (this._hard && !tx && gen !== undefined && gen !== null);
      const w = blocked ? 150 : this._waitMs(now);
      if (w <= 0) {
        const d = this.o.messageDelayMs;
        this._nextSendAt = now + Math.round(d * (0.85 + Math.random() * 0.4));
        this._sentTimes.push(now);
        return 'ok';
      }
      await new Promise(r => setTimeout(r, Math.min(w, 250)));
    }
  }

  // ───────────────────────── cảm ơn ─────────────────────────
  _maybeThank(ev) {
    const o = this.o;
    if (!o.thankEnabled) return;
    const lower = ev.sender.toLowerCase();
    if (lower === this.myName.toLowerCase() || this._siblings().has(lower)) return;
    const last = this._thanked.get(lower);
    if (last !== undefined && this._now() - last < o.thankCooldownMs) { this.stats.thankSuppressed++; this.log('sys', `đã cảm ơn ${ev.sender} cách đây chưa lâu — không cảm ơn lại cho khoản ${M.formatShort(ev.amount.value)}`); return; }
    this._thanked.set(lower, this._now());
    if (this._thanked.size > 300) for (const [k, t] of this._thanked) if (this._now() - t > 3600000) this._thanked.delete(k);
    if (this._thankQ.length >= 20) { this._thankQ.shift(); this.log('warn', 'hàng đợi cảm ơn đầy — bỏ lời cảm ơn cũ nhất'); }
    this._thankQ.push({ eventId: ev.id, name: ev.sender, cmd: `/msg ${ev.sender} ${render(o.thankMessageTemplate, { player: ev.sender, amount: M.formatShort(ev.amount.value) })}` });
  }
  async _thankLoop(gen) {
    while (this._alive(gen)) {
      const item = this._thankQ[0];
      if (!item || this._txBusy || this._hard || !this._isReady()) { if (!(await this._sleep(250, gen))) return; continue; }
      const acq = await this._acquire(gen);
      if (acq === 'stopped') return;
      if (acq !== 'ok') { await this._sleep(250, gen); continue; }
      if (this._thankQ[0] !== item || !this._alive(gen)) continue;     // hàng đợi đã bị xoá (dừng khẩn cấp)
      this._thankQ.shift();
      try {
        this.s.mc.chat(item.cmd);
        this.stats.thanked++;
        this._inflight.set(`thank:${item.name.toLowerCase()}`, { kind: 'thank', name: item.name, lower: item.name.toLowerCase(), sentAt: this._now() });
        this.log('ok', `đã cảm ơn ${item.name}`);
      } catch (e) { this.log('warn', `không gửi được lời cảm ơn tới ${item.name}: ${e.message}`); }
    }
  }

  // ───────────────────────── /bal ─────────────────────────
  _mkCtx() { const c = { done: false, result: null }; return c; }
  _resolveBal(res) { if (this._balCtx && !this._balCtx.done) { this._balCtx.done = true; this._balCtx.result = res; } }

  /** Gửi /bal (chỉ đọc nên được thử lại tối đa balanceRetries lần). Kết quả { ok:true, ...parseMoney } hoặc { ok:false, reason }. */
  async _queryBalance(gen) {
    let guard = 0;
    for (let attempt = 0; attempt <= this.o.balanceRetries; attempt++) {
      if (++guard > 60) return { ok: false, reason: 'acquire-failed' };
      if (!(await this._waitReadyQuiet(gen))) return { ok: false, reason: this._alive(gen) ? 'not-ready' : 'stopped' };
      const ctx = this._mkCtx(); this._balCtx = ctx;
      const acq = await this._acquire(gen, { tx: true });
      if (acq !== 'ok') { this._balCtx = null; if (acq === 'stopped') return { ok: false, reason: 'stopped' }; attempt--; await this._sleep(300, gen); continue; }
      try { this.s.mc.chat('/bal'); } catch (e) { this._balCtx = null; return { ok: false, reason: `send-error: ${e.message}` }; }
      const end = this._now() + this.o.responseTimeoutMs;
      while (!ctx.done && this._now() < end) { if (!this._alive(gen)) break; await new Promise(r => setTimeout(r, 25)); }
      this._balCtx = null;
      if (ctx.done) return ctx.result;
      if (!this._alive(gen)) return { ok: false, reason: 'stopped' };
      if (!this.s.isOnline) return { ok: false, reason: 'disconnect' };
    }
    return { ok: false, reason: 'timeout' };
  }
  // chờ sẵn sàng nhưng KHÔNG đổi state (đang ở giữa CHECKING/VERIFYING); mất kết nối khi VERIFYING -> trả false để caller xử lý UNKNOWN
  async _waitReadyQuiet(gen) {
    const since = this._now();
    for (;;) {
      if (!this._alive(gen)) return false;
      if (this._isReady()) return true;
      if (this.state === ST.VERIFYING) return false;
      if (this._now() - since > this.o.readyTimeoutMs) return false;
      if (!(await this._sleep(300, gen))) return false;
    }
  }

  async _balanceAndTransfer(gen) {
    this._txBusy = true;                     // dừng gửi tin mới để phản hồi không lẫn giữa /msg và /bal /pay
    try {
      if (!(await this._settleInflight(gen))) return;
      let bal = { ok: false, reason: 'not-ready' };
      for (let i = 0; i < 5; i++) {          // mất kết nối giữa chừng: chờ vào lại rồi hỏi /bal lại (/bal chỉ đọc nên an toàn)
        if (!(await this._gate(gen))) return;
        this._to(ST.CHECKING_BALANCE);
        bal = await this._queryBalance(gen);
        if (!this._alive(gen)) return;
        if (bal.ok || !['not-ready', 'disconnect'].includes(bal.reason)) break;
      }
      if (!bal.ok) {
        if (['not-ready', 'disconnect'].includes(bal.reason)) { this.log('warn', `bot mất kết nối khi kiểm tra số dư (${bal.reason}) — bỏ qua chuyển tiền ở vòng này`); return; }
        this._balFailures++;
        this.log('warn', `không đọc được số dư (${bal.reason}) lần ${this._balFailures} — KHÔNG chuyển tiền, KHÔNG mặc định số dư bằng 0`);
        if (this._balFailures >= 3) this._pause('không đọc được số dư 3 lần liên tiếp (định dạng /bal có thể khác mẫu đã xác minh)', true);
        return;
      }
      this._balFailures = 0;
      this.log('ok', `số dư đọc được: $${M.formatShort(bal.value)}${bal.exact ? '' : ` (hiển thị rút gọn, sai số +-${M.formatBig(bal.precision)})`}`);
      await this._transferStep(gen, bal);
    } finally {
      this._txBusy = false;
      if (![ST.PAUSED, ST.STOPPING, ST.OFF].includes(this.state) && this._isReady()) this._to(ST.READY);
    }
  }

  // ───────────────────────── /pay ─────────────────────────
  _skipTransfer(why) { this.log('sys', `không chuyển tiền: ${why}`); return { sent: false, why }; }

  async _transferStep(gen, bal) {
    const o = this.o;
    if (!o.autoTransfer) return this._skipTransfer('autoTransfer đang tắt');
    if (this.unknownTx) return this._skipTransfer('còn giao dịch chưa xác định kết quả (UNKNOWN)');
    if (!o.ownerValid) return this._skipTransfer('owner không hợp lệ');
    const owner = o.owner;
    if (owner.toLowerCase() === this.myName.toLowerCase()) return this._skipTransfer('owner trùng tên chính bot');
    if (bal.value < o.minBalance) return this._skipTransfer(`số dư $${M.formatShort(bal.value)} dưới ngưỡng $${M.formatShort(o.minBalance)} — vòng sau sẽ xin tiếp`);
    let amount = M.safePayAmount(bal, o.reserve);
    if (o.maxTransfer !== null && amount > o.maxTransfer) { this.log('warn', `số tiền ${M.formatBig(amount)} vượt maxTransferAmount — chuyển ${M.formatBig(o.maxTransfer)}`); amount = o.maxTransfer; }
    if (amount <= 0n) return this._skipTransfer('không còn số tiền an toàn để chuyển (sau khi trừ sai số hiển thị/reserve)');
    if (amount > bal.value) return this._skipTransfer('số tiền tính được vượt số dư (lỗi logic) — dừng');
    if (!this._isReady()) return this._skipTransfer('bot không còn sẵn sàng');

    const tx = {
      id: `tx-${this.botId}-${this._now().toString(36)}`, botId: this.botId, owner, amount: amount.toString(),
      balShown: bal.value.toString(), balPrecision: bal.precision.toString(), status: 'INTENT', at: this._now(), dry: !!o.dryRun,
    };
    this.ledger.addTx(tx);                                   // ghi ý định xuống đĩa TRƯỚC khi gửi lệnh
    this.log('ok', `ý định giao dịch ${tx.id}: /pay ${owner} ${amount} (số dư hiển thị ${M.formatBig(bal.value)}, ngưỡng ${M.formatBig(o.minBalance)})`);
    if (o.dryRun) { this.ledger.updateTx(tx.id, { status: 'DRYRUN' }); this.log('warn', `DRY-RUN: KHÔNG gửi /pay ${owner} ${amount}`); return { sent: false, why: 'dryRun' }; }

    this._to(ST.TRANSFERRING);
    const acq = await this._acquire(gen, { tx: true });
    if (acq !== 'ok') { this.ledger.updateTx(tx.id, { status: 'FAILED', note: `chưa gửi (${acq})` }); return this._skipTransfer(`không gửi được (${acq}) — chưa có lệnh nào được gửi`); }
    const ctx = { tx, amount, owner, result: null, sentAt: 0 };
    this._payCtx = ctx;
    try {
      this.s.mc.chat(`/pay ${owner} ${amount}`);            // GỬI ĐÚNG MỘT LẦN — không bao giờ tự gửi lại
    } catch (e) {
      this._payCtx = null; this.ledger.updateTx(tx.id, { status: 'FAILED', note: `lỗi gửi: ${e.message}` });
      return this._skipTransfer(`lỗi gửi /pay: ${e.message}`);
    }
    ctx.sentAt = this._now();
    this.ledger.updateTx(tx.id, { status: 'SENT', sentAt: ctx.sentAt });
    this._to(ST.VERIFYING);
    const outcome = await this._awaitPay(gen, ctx);
    this._payCtx = null;
    await this._settlePay(gen, tx, outcome, amount, bal);
    if (this._stopRequested) this._hardOff('dừng có kiểm soát (đã xác minh xong /pay)');
    return { sent: true, outcome: outcome.kind };
  }

  async _awaitPay(gen, ctx) {
    const end = ctx.sentAt + this.o.responseTimeoutMs;
    const me = this.myName.toLowerCase();
    while (this._now() <= end) {
      if (ctx.result) return ctx.result;
      const rc = AutoBeg.findReceipt(ctx.owner.toLowerCase(), me, ctx.amount, ctx.sentAt);
      if (rc) return { kind: 'success', via: 'owner-bot-receipt', line: `${rc.from} -> ${rc.to}` };
      if (!this.s.isOnline) return { kind: 'unknown', reason: 'mất kết nối sau khi gửi /pay' };
      if (gen !== this._gen) return { kind: 'unknown', reason: 'bị dừng khi chưa xác minh' };
      await new Promise(r => setTimeout(r, 20));
    }
    return ctx.result || { kind: 'unknown', reason: `không có phản hồi trong ${this.o.responseTimeoutMs}ms` };
  }

  async _settlePay(gen, tx, out, amount, balBefore) {
    if (gen !== this._gen) {                 // đã bị dừng khẩn cấp trong lúc chờ: chỉ ghi nhận bằng chứng chắc chắn, không đụng state
      if (out.kind === 'success' || out.kind === 'fail') {
        this.ledger.updateTx(tx.id, { status: out.kind === 'success' ? 'SUCCESS' : 'FAILED', via: out.via, note: out.reason, doneAt: this._now() });
        if (this.unknownTx && this.unknownTx.id === tx.id) this.unknownTx = null;
        if (out.kind === 'success') { this.stats.pays++; this.stats.paid += amount; }
      }
      return;
    }
    if (out.kind === 'success') {
      let cross = 'skipped';
      if (this.o.verifyWithBalance && this._isReady() && gen === this._gen) {
        const after = await this._queryBalance(gen);
        if (after.ok) {
          if (after.value < balBefore.value) cross = 'ok';
          else {
            this.ledger.updateTx(tx.id, { status: 'CONFLICT', note: `server báo đã chuyển nhưng số dư không giảm (${balBefore.value} -> ${after.value})` });
            this.unknownTx = this.ledger.data.tx.find(x => x.id === tx.id);
            this._pause(`dòng xác nhận /pay có nhưng số dư KHÔNG giảm (${M.formatShort(balBefore.value)} -> ${M.formatShort(after.value)}) — kiểm tra thủ công, không gửi lại`, true);
            return;
          }
        } else cross = `inconclusive(${after.reason})`;
      }
      this.ledger.updateTx(tx.id, { status: 'SUCCESS', via: out.via || 'pay-line', crossCheck: cross, doneAt: this._now() });
      this.stats.pays++; this.stats.paid += amount; this._ownerMisses = 0;
      this.log('ok', `CHUYỂN TIỀN THÀNH CÔNG: ${M.formatBig(amount)} cho ${tx.owner} (bằng chứng: ${out.via || 'dòng "Bạn đã chuyển cho"'}; đối chiếu số dư: ${cross})`);
      return;
    }
    if (out.kind === 'fail') {
      this.ledger.updateTx(tx.id, { status: 'FAILED', note: out.reason, doneAt: this._now() });
      this.log('warn', `/pay bị server từ chối: ${out.reason} — KHÔNG coi là đã chuyển, KHÔNG gửi lại ngay`);
      if (out.reason === 'owner-not-found') { if (++this._ownerMisses >= 3) this._pause('Owner "không tìm thấy" 3 lần liên tiếp (offline hoặc sai tên owner?)', true); }
      return;
    }
    this.ledger.updateTx(tx.id, { status: 'UNKNOWN', note: out.reason });
    this.unknownTx = this.ledger.data.tx.find(x => x.id === tx.id) || tx;
    this._reconciled = false;
    this._pause(`giao dịch ${tx.id} UNKNOWN (${out.reason}). KHÔNG tự gửi lại. Khi bot online lại sẽ đọc /bal để bạn đối chiếu; sau đó gõ "autobeg resume"`, true);
  }

  /** Khi đang tạm dừng cứng vì UNKNOWN: chạy 1 lần /bal chỉ-đọc để operator thấy số dư biến động. Không đổi trạng thái. */
  async _maybeReconcile(gen) {
    const t = this.unknownTx;
    if (!t || this._reconciled || !this._isReady()) return;
    this._reconciled = true;
    const was = this._txBusy; this._txBusy = true;
    try {
      const bal = await this._queryBalance(gen);
      if (!bal.ok) { this.log('warn', `không đọc được /bal để đối chiếu giao dịch ${t.id} (${bal.reason})`); return; }
      const before = BigInt(t.balShown || '0'); const amt = BigInt(t.amount || '0'); const tol = BigInt(t.balPrecision || '1') + bal.precision;
      const drop = before - bal.value;
      const verdict = drop + tol >= amt ? 'số dư GIẢM tương đương số tiền định chuyển -> nhiều khả năng /pay ĐÃ thực hiện'
        : (drop <= tol ? 'số dư KHÔNG giảm -> nhiều khả năng /pay CHƯA thực hiện (có thể do có người khác chuyển vào làm số dư tăng, hãy tự kiểm tra)' : 'số dư giảm một phần — không rõ');
      this.log('warn', `ĐỐI CHIẾU ${t.id}: trước ${M.formatBig(before)}, nay ${M.formatBig(bal.value)}, định chuyển ${M.formatBig(amt)} => ${verdict}. Gõ "autobeg resume" sau khi bạn đã kiểm tra.`);
    } finally { this._txBusy = was; }
  }

  // ───────────────────────── nhận tin từ server ─────────────────────────
  _trustedPos(pos) { return this.o.trustedPositions.includes(String(pos || '')); }
  _warnOnce(key, msg) { if (this._warned.has(key)) return; this._warned.add(key); this.log('warn', msg); }

  /** Gọi từ BotSession cho mọi tin 'message' của CHÍNH bot này. Không bao giờ ném lỗi. */
  onMessage(text, pos) {
    try {
      const ev = M.classifyLine(text);
      if (!ev) { this._noteOther(text, pos); return; }
      if (ev.type === 'pm') { this._onPm(ev); return; }
      if (!this._trustedPos(pos)) {
        this._warnOnce(`pos:${ev.type}:${pos}`, `dòng "${ev.type}" khớp mẫu server nhưng position="${pos}" không thuộc trustedPositions [${this.o.trustedPositions.join(',')}] — BỎ QUA (có thể là người chơi giả mạo; nếu server gửi tin này qua kênh khác, đặt autoBeg.trustedPositions)`);
        return;
      }
      switch (ev.type) {
        case 'received': this._onReceived(ev); break;
        case 'balance': this._onBalance(ev); break;
        case 'paid': this._onPaid(ev); break;
        case 'offline': this._onOffline(ev); break;
        case 'notfound': case 'notenough': this._onPayFailure(ev); break;
        default: break;
      }
    } catch (e) { dbg('AutoBeg', e); }
  }

  _onReceived(ev) {
    if (!ev.amount.ok) { this.log('warn', `dòng nhận tiền có số tiền mơ hồ (${ev.amount.reason}): "${ev.line}" — bỏ qua, không cảm ơn`); return; }
    const now = this._now();
    const key = `${ev.sender.toLowerCase()}|${ev.amount.value}`;
    const last = this._seen.get(key);
    if (last !== undefined && now - last < this.o.dedupWindowMs) { this.stats.duplicates++; this.log('sys', `bỏ qua tin nhận tiền lặp trong ${this.o.dedupWindowMs}ms (${ev.sender} ${M.formatShort(ev.amount.value)})`); return; }
    this._seen.set(key, now);
    if (this._seen.size > 400) for (const [k, t] of this._seen) if (now - t > 60000) this._seen.delete(k);
    const event = { id: ++this._evSeq, sender: ev.sender, amount: ev.amount, at: now };
    AutoBeg._publishReceipt({ to: this.myName.toLowerCase(), from: ev.sender.toLowerCase(), amount: ev.amount, at: now });
    if (!this.active) return;                                  // đang tắt: chỉ công bố bằng chứng cho bot khác, không cảm ơn
    this.stats.received += ev.amount.value; this.stats.receivedCount++;
    this.log('ok', `NHẬN TIỀN: $${M.formatShort(ev.amount.value)} từ ${ev.sender} (xác nhận bởi dòng hệ thống của server)`);
    const rec = this.round && this.round.recipients.get(ev.sender.toLowerCase());
    if (rec && rec.status === RS.SENT) { rec.status = RS.CONFIRMED; this.stats.confirmed++; }
    this._maybeThank(event);
  }
  _onBalance(ev) {
    if (!this._balCtx || this._balCtx.done) return;           // chỉ nhận khi ĐANG chờ phản hồi /bal của chính mình
    let amt = ev.amount;
    // "$0.2": số thập phân không hậu tố có phần nguyên = 0 thì chắc chắn < $1 (không thể là 200) -> coi như dưới ngưỡng, không phải lỗi mơ hồ
    if (!amt.ok && amt.reason === 'ambiguous-decimal-without-suffix' && /»\s*Bạn có\s+\$0[.,]\d+\s*\.?$/.test(String(ev.line || ''))) {
      amt = { ok: true, value: 0n, precision: 1n, suffix: '', exact: false };
    }
    this._resolveBal(amt.ok ? { ok: true, ...amt } : { ok: false, reason: `ambiguous: ${amt.reason}` });
  }
  _onPaid(ev) {
    const c = this._payCtx;
    if (!c || c.result) return;
    if (ev.player.toLowerCase() !== c.owner.toLowerCase() || !M.amountMatches(c.amount, ev.amount)) {
      this.log('warn', `dòng chuyển tiền KHÔNG khớp giao dịch đang chờ (owner ${c.owner}, ${M.formatBig(c.amount)}): "${ev.line}" — bỏ qua`); return;
    }
    c.result = { kind: 'success', via: 'dòng "Bạn đã chuyển cho"', line: ev.line };
  }
  _onPayFailure(ev) {
    const c = this._payCtx;
    if (!c) { this.log('sys', `dòng "${ev.line}" không thuộc giao dịch nào đang chờ — bỏ qua`); return; }
    if (c.result) return;
    c.result = { kind: 'fail', reason: ev.type === 'notfound' ? 'owner-not-found' : 'insufficient-funds', line: ev.line };
  }
  _onOffline(ev) {
    this._expireInflight();
    const lower = ev.player.toLowerCase();
    for (const key of [`beg:${lower}`, `thank:${lower}`, `manual:${lower}`]) {
      const it = this._inflight.get(key);
      if (!it) continue;
      this._inflight.delete(key);
      if (it.rec) { it.rec.status = RS.FAILED; it.rec.note = 'offline'; this.stats.failed++; this.ledger.release(lower, this.botId); }
      this.log('warn', `${ev.player} không online — tin ${it.kind === 'beg' ? 'xin tiền' : it.kind === 'thank' ? 'cảm ơn' : 'thủ công'} không tới (server báo)`);
      return;
    }
  }
  _onPm(ev) {
    if (ev.receiver.toLowerCase() !== this.myName.toLowerCase() || !this.active) return;
    const t = normalizeVi(ev.body);
    const pats = [...DEFAULT_DECLINE, ...this.o.declinePatterns];
    if (pats.some(re => re.test(t))) {
      this.ledger.markDeclined(ev.sender.toLowerCase());
      const rec = this.round && this.round.recipients.get(ev.sender.toLowerCase());
      if (rec && rec.status === RS.PENDING) { rec.status = RS.SKIPPED; rec.note = 'từ chối'; }
      this.log('warn', `${ev.sender} có vẻ không muốn nhận tin ("${ev.body.slice(0, 60)}") — sẽ không nhắn nữa`);
    }
  }
  /** Dòng không thuộc mẫu đã biết: chỉ dùng để nhận ra server giới hạn tốc độ chat / lỗi /pay tuỳ chỉnh. Chỉ xét dòng hệ thống bắt đầu bằng "»". */
  _noteOther(text, pos) {
    if (!this.active || !this._trustedPos(pos)) return;
    const clean = M.cleanLine(text);
    if (!clean.startsWith('»')) return;
    const t = normalizeVi(clean);
    if (this._payCtx && !this._payCtx.result && this.o.payFailurePatterns.some(re => re.test(t))) {
      this._payCtx.result = { kind: 'fail', reason: `server từ chối: ${clean.slice(0, 80)}`, line: clean }; return;
    }
    if (this._sentTimes.length && this._now() - this._sentTimes[this._sentTimes.length - 1] < 10000
      && [...DEFAULT_RATELIMIT, ...this.o.rateLimitPatterns].some(re => re.test(t))) this._onRateLimited(clean);
  }
  _onRateLimited(line) {
    const now = this._now();
    this._rlHits = this._rlHits.filter(t => now - t < 600000); this._rlHits.push(now);
    const ms = Math.min(600000, 30000 * 2 ** (this._rlHits.length - 1));
    this._backoffUntil = now + ms;
    this.log('warn', `server có vẻ giới hạn tốc độ chat ("${line.slice(0, 60)}") — lùi ${Math.round(ms / 1000)}s`);
    if (this._rlHits.length >= 3) this._pause('server giới hạn tốc độ nhiều lần — kiểm tra messageDelayMs / maxMessagesPerMinute', true);
  }

  /** BotSession gọi khi bị kick. Kick ngay sau khi gửi tin hai lần liên tiếp -> dừng hẳn chờ người xem (nghi bị phạt spam). */
  onKicked(reason) {
    try {
      if (!this.active) return;
      const now = this._now();
      const afterSend = this._sentTimes.length && now - this._sentTimes[this._sentTimes.length - 1] < 30000;
      this._kicks = this._kicks.filter(t => now - t < 1800000);
      if (afterSend) this._kicks.push(now);
      if (this._kicks.length >= 2) this._pause(`bị kick ${this._kicks.length} lần ngay sau khi gửi tin (${String(reason).slice(0, 60)}) — nghi bị phạt spam; tăng messageDelayMs rồi "autobeg resume"`, true);
    } catch (e) { dbg('AutoBeg', e); }
  }
  /** BotSession gọi khi mất kết nối: các tin đang chờ phản hồi không còn đường trả lời -> coi là chưa rõ, KHÔNG gửi lại. */
  onDisconnect() {
    try {
      for (const it of this._inflight.values()) if (it.rec && it.rec.status === RS.SENT) it.rec.note = 'mất kết nối trước khi biết kết quả (không gửi lại)';
      this._inflight.clear();
      this._resolveBal({ ok: false, reason: 'disconnect' });
    } catch (e) { dbg('AutoBeg', e); }
  }

  // ───────────────────────── lệnh `msg` thủ công ─────────────────────────
  /** Gửi /msg theo lệnh tay, đi qua cùng bộ giới hạn tốc độ. Trả Promise<{ok, error?}>. */
  async sendManualMsg(name, cmd) {
    if (!this._isReady()) return { ok: false, error: 'bot chưa sẵn sàng (chưa đăng nhập/vào server xong)' };
    const acq = await this._acquire(null);
    if (acq !== 'ok') return { ok: false, error: acq === 'notready' ? 'bot mất sẵn sàng' : 'đã dừng' };
    try { this.s.mc.chat(cmd); } catch (e) { return { ok: false, error: e.message }; }
    this._inflight.set(`manual:${name.toLowerCase()}`, { kind: 'manual', name, lower: name.toLowerCase(), sentAt: this._now() });
    return { ok: true };
  }

  status() {
    const o = this.o; const st = this.stats;
    const parts = [
      `AutoBeg: ${this.state}${this.state === ST.PAUSED ? ` (${this._hard ? 'cứng' : 'mềm'}: ${this._pauseReason})` : ''}`,
      `chế độ ${o.dryRun ? 'DRY-RUN' : 'LIVE'}`,
      `owner ${o.autoTransfer ? (o.owner || '(chưa đặt)') : '(không chuyển)'}`,
      `người nhận ${o.recipientMode}`,
      `vòng ${this.roundsDone}/${o.maxRounds}`,
      `xin ${st.asked} (xác nhận ${st.confirmed}, lỗi ${st.failed}, bỏ qua ${st.skipped})`,
      `nhận ${M.formatShort(st.received)} (${st.receivedCount} lần, trùng bỏ ${st.duplicates})`,
      `cảm ơn ${st.thanked}`,
      `/pay OK ${st.pays} (${M.formatShort(st.paid)})`,
    ];
    if (this.unknownTx) parts.push(`GIAO DỊCH CHƯA RÕ: ${this.unknownTx.id}`);
    if (this.errors.length) parts.push(`CẤU HÌNH LỖI: ${this.errors.join('; ')}`);
    return parts.join(' | ');
  }
}

module.exports = AutoBeg;
module.exports.AutoBeg = AutoBeg;
module.exports.BegLedger = BegLedger;
module.exports.resolveOptions = resolveOptions;
module.exports.parseMsgArgs = parseMsgArgs;
module.exports.STATES = ST;
module.exports.TRANSITIONS = TRANSITIONS;
module.exports.RECIPIENT_STATUS = RS;
module.exports.FLOORS = FLOORS;
module.exports.NAME_RE = NAME_RE;
