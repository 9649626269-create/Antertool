'use strict';
/**
 * BeggarGuard — tự CHẶN người chơi "ăn xin" (xin tiền / xin đồ / "em là newbie"...) trong chat của server.
 *
 * Cách hoạt động (mỗi bot có một bản riêng, vì danh sách chặn của server là theo từng tài khoản):
 *   1. Mỗi tin chat/hệ thống đi qua onMessage(): chuẩn hoá (bỏ dấu, chữ thường) rồi chấm điểm bằng các mẫu "xin xỏ".
 *        - mẫu MẠNH (2 điểm): "xin tiền", "cho em xin", "ai cho em ...", "give me money"...
 *        - mẫu YẾU  (1 điểm): "em là newbie / mới chơi / nghèo / hết tiền", "i am new"...
 *      Đủ minScore (mặc định 1) mới coi là ăn xin. Đặt minScore = 2 nếu muốn chỉ chặn khi xin rõ ràng.
 *   2. Tìm NGƯỜI GỬI: lấy phần trước dấu » : > › ➤ → rồi tìm tên người chơi đang online (mc.players) trong đó. Không tìm được
 *      người chơi thật thì KHÔNG làm gì (tin hệ thống/quảng cáo không bị chặn nhầm).
 *   3. Bỏ qua: chính bot, chủ bot, các bot khác trong dàn, whitelist spawner và danh sách trắng riêng (beggarGuard.whitelist).
 *   4. Chặn bằng lệnh server (mặc định "/block {player}") — mỗi người CHỈ MỘT LẦN (lưu vào beggars.json) vì nhiều plugin
 *      coi /block là công tắc: gõ lần hai có thể BỎ chặn. Có giới hạn tốc độ + khoảng nghỉ giữa các lệnh để không bị server phạt spam.
 *
 * Mặc định BẬT. Tắt: lệnh `beggar off` hoặc "beggarGuard": {"enabled": false}. Thử không cần server: `beggar test <tin nhắn>`.
 *
 * config.json (tuỳ chọn, cấp bot hoặc toàn cục):
 *   "beggarGuard": { "enabled": true, "action": "block", "commands": ["/block {player}"], "minScore": 1,
 *                    "whitelist": ["TenBanBe"], "extraPatterns": ["xin\\s+shard"], "senderPattern": "", "delayMs": 2500,
 *                    "maxPerMinute": 4, "cooldownSameMs": 60000 }
 *   action: "block" = gõ commands; "notify" = chỉ ghi log (không chặn).
 *   senderPattern: regex tuỳ chọn, nhóm 1 = tên người gửi (nếu chat của server có định dạng lạ).
 */
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');
const { normalizeVi } = require('./PremiumLogic');

// Mẫu chạy trên văn bản ĐÃ chuẩn hoá (không dấu, chữ thường). Ranh giới từ bằng \b — đã bỏ dấu nên "bạn" -> "ban" không còn là vấn đề
// vì mẫu luôn đi theo cụm (xin + tiền, cho + em + xin...) chứ không khớp từ lẻ.
const MONEY = '(?:tien|money|xu|coin|coins|vnd|trieu|ty|dong|cash)';
const THING = '(?:do|item|items|vat pham|kim cuong|diamond|diamonds|netherite|giap|armor|armour|kiem|sword|spawner|shard|tai nguyen|pickaxe|cuoc|gold|vang|emerald|ngoc|rank|vip)';
const ME = '(?:em|minh|toi|tui|to|mik|anh|chi|tao|i|me)';
const FILL = '(?:it\\s+|chut\\s+|mot\\s+it\\s+|cai\\s+|ban\\s+|anh\\s+|chi\\s+)?';
const STRONG = [
  new RegExp(`\\bxin\\s+${FILL}${MONEY}\\b`),                                  // xin tiền / xin ít tiền / xin chút money
  new RegExp(`\\bxin\\s+${FILL}${THING}\\b`),                                  // xin đồ / xin kim cương / xin shard
  /\bxin\s+\d+\s*(?:k|tr|m|trieu|ty|tien|\$)(?!\w)/,                           // xin 100k / xin 5tr
  /\b(?:cho|tang|donate|ung ho|cuu tro)\s+(?:em|minh|toi|tui|to|mik)\s+(?:xin|it|chut|mot it|tien|item)\b/,
  /\b(?:ai|bac|anh|chi|ban|admin|op|mod|dai gia|dai ca)\s+(?:nao\s+)?(?:cho|tang|donate|ung ho)\s+(?:em|minh|toi|tui|to|mik)\b/,
  /\b(?:cho|giup)\s+(?:em|minh|toi|tui|to|mik)\s+xin\b/,                       // cho em xin ...
  /\bcho\s+xin\b/,
  /\b(?:can|could|may)\s+i\s+(?:have|get|borrow)\s+(?:some\s+)?(?:money|coins?|items?|diamonds?|op|rank|vip)\b/,
  /\b(?:pls|plz|please)\s+(?:give|donate|help)\b.*\b(?:me|money|coins?|items?|diamonds?|rank|vip)\b/,
  /\b(?:give|donate|send|lend)\s+me\s+(?:some\s+|any\s+)?(?:money|coins?|items?|diamonds?|op|rank|vip|stuff)\b/,
  /\b(?:i\s+need|need)\s+(?:some\s+)?(?:money|coins?)\b/,
  /\bxin\s+(?:duoc\s+)?(?:ung ho|donate|giup do|cuu tro)\b/,
  new RegExp(`\\bvay\\s+(?:em\\s+|minh\\s+|toi\\s+|tui\\s+|to\\s+|mik\\s+)?${FILL}${MONEY}\\b`),   // vay ít tiền
];
const WEAK = [
  new RegExp(`\\b${ME}\\s+(?:la\\s+|dang\\s+)?(?:nguoi\\s+)?(?:newbie|new\\s*bie|nub|noob|new|tan thu|moi choi|moi vao|moi tham gia|moi vo|nguoi moi)\\b`),
  new RegExp(`\\b${ME}\\s+(?:dang\\s+|rat\\s+|dang rat\\s+)?(?:ngheo|ngheo lam|het tien|het sach tien|khong co tien|ko co tien|chua co tien|chua co gi|khong co gi|ko co gi|kho khan|tay trang)\\b`),
  /\b(?:i\s*am|im|i'm)\s+(?:a\s+)?(?:new|newbie|noob|poor|broke)\b/,
  /\b(?:newbie|tan thu)\s+(?:xin|can|can giup|ngheo|ne)\b/,
  /\bnghe+o\s+(?:qua|lam|ne|nen)\b.*\b(?:xin|cho|giup)\b/,
];

/** Chấm điểm 1 tin: { score, hits[] }. Điểm = tổng (mạnh 2, yếu 1), mỗi mẫu tính một lần. */
function scoreBegging(text, extraPatterns = []) {
  const t = normalizeVi(String(text || '')).replace(/[​-‏﻿]/g, '').replace(/\s+/g, ' ').trim();
  const hits = [];
  let score = 0;
  if (!t) return { score, hits, text: t };
  for (const re of STRONG) { const m = re.exec(t); if (m) { score += 2; hits.push(m[0].trim()); } }
  for (const re of WEAK) { const m = re.exec(t); if (m) { score += 1; hits.push(m[0].trim()); } }
  for (const re of extraPatterns) { const m = re.exec(t); if (m) { score += 2; hits.push(m[0].trim()); } }
  return { score, hits, text: t };
}

const SEP_RE = /[»›:➤➜→⮞>]|(?:\s-\s)|(?:\s\|\s)/;
const NAME_RE = /[A-Za-z0-9_]{3,16}/g;

/**
 * Tìm người gửi trong 1 dòng chat. players = mảng tên người chơi đang online.
 * Chỉ nhìn phần TRƯỚC dấu phân cách đầu tiên, và chỉ chấp nhận tên có thật trong players (so khớp không phân biệt hoa/thường).
 * Trả về { name, body } hoặc null. senderRe (RegExp, nhóm 1 = tên) được ưu tiên nếu có.
 */
function findSender(text, players, senderRe = null) {
  const raw = String(text || '').replace(/§./g, '').trim();
  if (!raw || !players || !players.length) return null;
  const byLower = new Map(players.map(n => [String(n).toLowerCase(), String(n)]));
  if (senderRe) {
    const m = senderRe.exec(raw);
    if (m && m[1] && byLower.has(String(m[1]).toLowerCase())) return { name: byLower.get(String(m[1]).toLowerCase()), body: raw.slice(m.index + m[0].length) || raw };
  }
  const sep = SEP_RE.exec(raw);
  if (!sep) return null;                             // không có dấu phân cách => không phải dạng "người: nội dung"
  const prefix = raw.slice(0, sep.index + (sep[0] === '>' ? 1 : 0));
  const body = raw.slice(sep.index + sep[0].length);
  if (!body.trim()) return null;
  let found = null;
  for (const m of prefix.matchAll(NAME_RE)) {       // lấy tên xuất hiện CUỐI trong phần đầu (bỏ qua rank/tag đứng trước)
    const hit = byLower.get(m[0].toLowerCase());
    if (hit) found = hit;
  }
  return found ? { name: found, body } : null;
}

const DEFAULTS = Object.freeze({
  enabled: true, action: 'block', commands: ['/block {player}'], minScore: 1, whitelist: [], extraPatterns: [], senderPattern: '',
  delayMs: 2500, maxPerMinute: 4, cooldownSameMs: 60000,
});
const numOr = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const safeRe = (src, flags) => { try { return new RegExp(src, flags); } catch (e) { dbg('BeggarGuard', e); return null; } };

function resolveOptions(user = {}) {
  const u = user && typeof user === 'object' ? user : {};
  const cmds = (Array.isArray(u.commands) ? u.commands : (typeof u.commands === 'string' ? [u.commands] : DEFAULTS.commands))
    .map(c => String(c).trim()).filter(Boolean);
  return {
    enabled: u.enabled !== false,
    action: String(u.action || DEFAULTS.action).toLowerCase() === 'notify' ? 'notify' : 'block',
    commands: (cmds.length ? cmds : DEFAULTS.commands.slice()).slice(0, 3),
    minScore: Math.floor(numOr(u.minScore, DEFAULTS.minScore, 1, 6)),
    whitelist: [].concat(u.whitelist || []).map(x => String(x).toLowerCase().trim()).filter(Boolean),
    extraPatterns: [].concat(u.extraPatterns || []).map(x => safeRe(normalizeVi(String(x)), '')).filter(Boolean),
    senderRe: u.senderPattern ? safeRe(String(u.senderPattern), '') : null,
    delayMs: numOr(u.delayMs, DEFAULTS.delayMs, 800, 60000),
    maxPerMinute: Math.floor(numOr(u.maxPerMinute, DEFAULTS.maxPerMinute, 1, 30)),
    cooldownSameMs: numOr(u.cooldownSameMs, DEFAULTS.cooldownSameMs, 0, 3600000),
  };
}

class BeggarGuard {
  /** @param session BotSession (cần: cfg, mc, isOnline, log, _setTimer, _spawnerTrusted, _loginConfirmed) */
  constructor(session, opts = {}) {
    this.s = session;
    this.o = resolveOptions(session.cfg?.beggarGuard);
    this._file = opts.file !== undefined ? opts.file : path.join(process.cwd(), 'beggars.json');
    this._now = opts.now || Date.now;
    this._blocked = new Set();       // tên (chữ thường) đã chặn bởi bot này
    this._queue = [];                // { name, body }
    this._sentTimes = [];            // thời điểm các lệnh gần nhất (giới hạn/phút)
    this._lastSeen = new Map();      // tên -> lần phát hiện gần nhất (cooldownSameMs)
    this._timer = null;
    this.stats = { detected: 0, blocked: 0, skipped: 0 };
    this._load();
  }

  reload() { this.o = resolveOptions(this.s.cfg?.beggarGuard); }
  get enabled() { return !!this.o.enabled; }
  setEnabled(v) { this.s.cfg.beggarGuard = { ...(this.s.cfg.beggarGuard || {}), enabled: !!v }; this.reload(); if (!v) this._queue.length = 0; }

  get _botId() { return String(this.s.cfg?.id ?? ''); }
  _load() {
    try {
      if (!this._file) return;
      const j = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      for (const n of (j && j[this._botId]) || []) this._blocked.add(String(n).toLowerCase());
    } catch (e) { /* chưa có file */ }
  }
  _save() {
    try {
      if (!this._file) return;
      let j = {};
      try { j = JSON.parse(fs.readFileSync(this._file, 'utf8')) || {}; } catch (e) { /* tạo mới */ }
      j[this._botId] = [...this._blocked].sort();
      fs.writeFileSync(this._file, JSON.stringify(j, null, 2));
    } catch (e) { dbg('BeggarGuard', e); }
  }

  list() { return [...this._blocked].sort(); }
  forget(name) { const had = this._blocked.delete(String(name).toLowerCase()); if (had) this._save(); return had; }

  status() {
    const o = this.o;
    return `BeggarGuard: ${o.enabled ? 'BẬT' : 'TẮT'} | hành động ${o.action === 'block' ? 'chặn bằng ' + o.commands.join(' + ') : 'chỉ thông báo'} | ngưỡng ${o.minScore} | `
      + `đã chặn ${this._blocked.size} người (phiên này: phát hiện ${this.stats.detected}, chặn ${this.stats.blocked})`;
  }

  _onlinePlayers() {
    const pl = this.s.mc && this.s.mc.players;
    return pl ? Object.keys(pl) : [];
  }

  _exempt(name) {
    const l = String(name).toLowerCase();
    if (l === String(this.s.cfg?.username || '').toLowerCase() || l === String(this.s.mc?.username || '').toLowerCase()) return true;
    if (this.o.whitelist.includes(l)) return true;
    try { if (this.s._spawnerTrusted && this.s._spawnerTrusted(name)) return true; } catch (e) { dbg('BeggarGuard', e); }
    return false;
  }

  /**
   * Phân tích 1 tin (dùng cả cho `beggar test`). Trả về { beggar, score, hits, sender, reason }:
   * reason = lý do không chặn (nếu có) để hiển thị khi test.
   */
  evaluate(text, players = this._onlinePlayers()) {
    const sc = scoreBegging(text, this.o.extraPatterns);
    const out = { beggar: false, score: sc.score, hits: sc.hits, sender: null, reason: '' };
    if (sc.score < this.o.minScore) { out.reason = sc.score ? `điểm ${sc.score} < ngưỡng ${this.o.minScore}` : 'không có mẫu xin xỏ'; return out; }
    const snd = findSender(text, players, this.o.senderRe);
    if (!snd) { out.reason = 'không xác định được người gửi (không phải chat của người chơi đang online)'; return out; }
    out.sender = snd.name;
    // chấm điểm lại trên PHẦN NỘI DUNG (tên người chơi trong tiền tố không được làm khớp mẫu)
    const body = scoreBegging(snd.body, this.o.extraPatterns);
    if (body.score < this.o.minScore) { out.reason = 'mẫu xin xỏ nằm ở tên/tiền tố, không phải nội dung'; return out; }
    out.score = body.score; out.hits = body.hits;
    if (this._exempt(snd.name)) { out.reason = `${snd.name} nằm trong danh sách được tin (chủ/bot/whitelist)`; return out; }
    out.beggar = true;
    return out;
  }

  /** Gọi từ BotSession cho mỗi tin chat/hệ thống. Không bao giờ ném lỗi. */
  onMessage(text, pos) {
    try {
      if (!this.o.enabled || pos === 'game_info' || pos === 'action_bar') return;
      if (!text || text.length > 400) return;
      const ev = this.evaluate(text);
      if (!ev.beggar) return;
      const key = ev.sender.toLowerCase();
      const now = this._now();
      const last = this._lastSeen.get(key);
      this._lastSeen.set(key, now);
      if (this._lastSeen.size > 300) { for (const [k, t] of this._lastSeen) if (now - t > 600000) this._lastSeen.delete(k); }
      if (this._blocked.has(key)) return;                                  // đã chặn: không gõ lại (tránh công tắc /ignore bật-tắt)
      if (last !== undefined && now - last < this.o.cooldownSameMs && this._queue.some(q => q.key === key)) return;
      this.stats.detected++;
      const shown = String(text).replace(/\s+/g, ' ').slice(0, 120);
      if (this.o.action === 'notify') {
        this._blocked.add(key); this._save();
        this.s.log('warn', `Ăn xin: ${ev.sender} — "${shown}" (điểm ${ev.score}: ${ev.hits.join(' | ')}) — chế độ chỉ thông báo, không chặn`);
        return;
      }
      if (this._queue.some(q => q.key === key)) return;
      this._queue.push({ name: ev.sender, key, shown, score: ev.score });
      this.s.log('warn', `Ăn xin: ${ev.sender} — "${shown}" (điểm ${ev.score}: ${ev.hits.join(' | ')}) → sẽ chặn`);
      this._arm();
    } catch (e) { dbg('BeggarGuard', e); }
  }

  _arm() {
    if (this._timer || !this._queue.length) return;
    const d = this.o.delayMs;
    const wait = d + Math.floor(Math.random() * d * 0.4);
    this._timer = setTimeout(() => { this._timer = null; this._flush(); }, wait);
    if (this._timer.unref) this._timer.unref();
  }

  _flush() {
    try {
      if (!this.o.enabled || !this._queue.length) { this._queue.length = 0; return; }
      const s = this.s;
      if (!s.isOnline || !s._loginConfirmed || !s.mc) { this._queue.length = 0; return; }   // chưa đăng nhập xong: bỏ, họ xin lại sẽ bắt lại
      if (s.autoLogin?.inFlow) { this._arm(); return; }                    // đang đăng nhập/antibot: chờ
      const now = this._now();
      this._sentTimes = this._sentTimes.filter(t => now - t < 60000);
      if (this._sentTimes.length >= this.o.maxPerMinute) { this._arm(); return; }
      const item = this._queue.shift();
      if (!item) return;
      this._sentTimes.push(now);
      let sent = 0;
      for (const tpl of this.o.commands) {
        const cmd = tpl.replace(/\{player\}/g, item.name);
        try { s.mc.chat(cmd.startsWith('/') ? cmd : `/${cmd}`); sent++; } catch (e) { dbg('BeggarGuard', e); }
      }
      if (sent) {
        this._blocked.add(item.key); this._save(); this.stats.blocked++;
        s.log('ok', `Đã chặn người ăn xin: ${item.name} (${this.o.commands.join(' + ').replace(/\{player\}/g, item.name)})`);
      }
    } catch (e) { dbg('BeggarGuard', e); }
    this._arm();
  }

  dispose() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } this._queue.length = 0; }
}

module.exports = BeggarGuard;
module.exports.BeggarGuard = BeggarGuard;
module.exports.scoreBegging = scoreBegging;
module.exports.findSender = findSender;
module.exports.resolveOptions = resolveOptions;
