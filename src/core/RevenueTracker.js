'use strict';
const fs = require('fs');
const path = require('path');

/**
 * RevenueTracker — gom doanh thu auto-sell spawn theo từng bot.
 *
 * Mỗi vòng bán xong ghi 1 bản ghi [t, amount, dt, hits, backlog]:
 *   t       thời điểm kết thúc vòng (ms)
 *   amount  tổng tiền server báo trong vòng đó
 *   dt      khoảng thời gian (ms) mà vòng này "phủ" — dùng để tính tốc độ/giờ
 *   hits    số tin nhắn bán đã đọc được
 *   backlog 1 = vòng ĐẦU TIÊN (hoặc vòng đầu sau lúc bot offline): tiền này là hàng dồn
 *           từ trước khi bắt đầu đo nên vẫn cộng vào tổng/hôm nay, nhưng KHÔNG đưa vào
 *           tốc độ/giờ (nếu không con số sẽ bị thổi phồng). Cần >= 2 vòng liên tiếp mới có tốc độ.
 *
 * Giữ bản ghi chi tiết 48h (để chia theo giờ); tổng theo ngày giữ 60 ngày.
 * Giờ/ngày tính theo múi giờ config (tzFn), lưu file JSON riêng (revenue.json)
 * để không làm phình config.json.
 */
const H = 3600000;
const SUFFIX = [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']];

// 1250 -> "1.25k", 3400000 -> "3.4m", 950 -> "950"
function formatMoney(n) {
  n = Number(n) || 0;
  const neg = n < 0; const a = Math.abs(n);
  for (const [v, s] of SUFFIX) {
    if (a >= v) return (neg ? '-' : '') + (a / v).toFixed(2).replace(/\.?0+$/, '') + s;
  }
  return (neg ? '-' : '') + String(Math.round(a));
}

// Như formatMoney nhưng luôn 2 số lẻ cho gọn mắt khi đặt cạnh nhau: 2010000 -> "2.01m", 31200000 -> "31.20m", 0 -> "0"
function formatMoneyFixed(n) {
  n = Number(n) || 0;
  const neg = n < 0; const a = Math.abs(n);
  for (const [v, s] of SUFFIX) {
    if (a >= v) return (neg ? '-' : '') + (a / v).toFixed(2) + s;
  }
  return (neg ? '-' : '') + String(Math.round(a));
}

// "1.25k" | "2,5m" | "3b" | "$1,250" -> số. Không hiểu thì trả null.
function parseMoneyToken(tok) {
  const m = /^\s*\$?\s*(\d+(?:[.,]\d+)*)\s*([kmbt])?\s*$/i.exec(String(tok || ''));
  if (!m) return null;
  let s = m[1];
  const suf = (m[2] || '').toLowerCase();
  let num;
  if (suf) {
    s = s.replace(/,/g, '.');
    const parts = s.split('.');
    if (parts.length > 2) s = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1];
    num = parseFloat(s);
  } else if (/^\d{1,3}([.,]\d{3})+$/.test(s)) {
    num = parseFloat(s.replace(/[.,]/g, '')); // 1,250 / 1.250 = một nghìn hai trăm năm mươi
  } else {
    num = parseFloat(s.replace(',', '.'));
  }
  if (!Number.isFinite(num)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[suf] || 1;
  return Math.round(num * mult);
}

class RevenueTracker {
  constructor(file, tzFn) {
    this.file = file || null;
    this.tzFn = typeof tzFn === 'function' ? tzFn : () => 'Asia/Ho_Chi_Minh';
    this.data = { bots: {} };
    this._timer = null;
    this._load();
  }
  _load() {
    if (!this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j === 'object' && j.bots) this.data = j;
    } catch { /* chưa có file / file hỏng -> bắt đầu mới */ }
    // Lần chạy trước tắt đột ngột (đang online mà chưa kịp ghi offline) -> chốt phiên ở nhịp tim cuối cùng
    for (const b of Object.values(this.data.bots || {})) {
      if (b && b.upSince != null) { b.upMs = (b.upMs || 0) + Math.max(0, (b.upBeat || b.upSince) - b.upSince); b.upSince = null; b.upBeat = null; }
    }
  }
  _save() {
    if (!this.file) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch { /* ghi lỗi thì thôi, dữ liệu vẫn còn trong RAM */ }
  }
  _scheduleSave() {
    if (!this.file || this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._save(); }, 1500);
    if (this._timer.unref) this._timer.unref();
  }
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._save();
  }
  _bot(id) {
    const k = String(id);
    if (!this.data.bots[k]) this.data.bots[k] = { since: null, last: null, total: 0, cycles: 0, entries: [], days: {}, upMs: 0, upSince: null, upBeat: null };
    return this.data.bots[k];
  }
  // --- thời gian theo múi giờ ---
  _fmt(ts, opts) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: this.tzFn(), hourCycle: 'h23', ...opts }).formatToParts(new Date(ts)); }
    catch { return new Intl.DateTimeFormat('en-CA', { hourCycle: 'h23', ...opts }).formatToParts(new Date(ts)); }
  }
  dayKey(ts) {
    const p = this._fmt(ts, { year: 'numeric', month: '2-digit', day: '2-digit' });
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')}`;
  }
  // "02:15" theo múi giờ config
  clock(ts, withSec = false) {
    const p = this._fmt(ts, withSec ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
    const g = t => p.find(x => x.type === t).value;
    return `${String(Number(g('hour')) % 24).padStart(2, '0')}:${g('minute')}${withSec ? ':' + g('second') : ''}`;
  }
  hourKey(ts) {
    const p = this._fmt(ts, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
    const g = t => p.find(x => x.type === t).value;
    return `${g('year')}-${g('month')}-${g('day')} ${String(Number(g('hour')) % 24).padStart(2, '0')}`;
  }

  /**
   * Ghi 1 vòng. intervalMs = chu kỳ cấu hình (dùng làm dt khi vòng đầu tiên / sau lúc offline).
   */
  record(botId, amount, { now = Date.now(), intervalMs = 300000, hits = 0 } = {}) {
    const b = this._bot(botId);
    amount = Math.max(0, Math.round(Number(amount) || 0));
    let dt = 0, backlog = 1;
    if (b.last != null && now - b.last > 0 && now - b.last <= intervalMs * 2 + 60000) { dt = now - b.last; backlog = 0; }
    if (b.since == null) b.since = now;
    b.last = now;
    b.total += amount;
    b.cycles += 1;
    b.entries.push([now, amount, dt, hits, backlog]);
    const dk = this.dayKey(now);
    b.days[dk] = (b.days[dk] || 0) + amount;
    this._prune(b, now);
    this._scheduleSave();
    return { amount, dt };
  }
  _prune(b, now) {
    const cut = now - 48 * H;
    if (b.entries.length && b.entries[0][0] < cut) b.entries = b.entries.filter(e => e[0] >= cut);
    const keys = Object.keys(b.days).sort();
    while (keys.length > 60) delete b.days[keys.shift()];
  }
  reset(botId) {
    const k = String(botId);
    const old = this.data.bots[k];
    delete this.data.bots[k];
    // Thời gian hoạt động không phải doanh thu -> xoá doanh thu nhưng giữ bộ đếm giờ chạy
    if (old && ((old.upMs || 0) > 0 || old.upSince != null)) {
      const b = this._bot(k);
      b.upMs = old.upMs || 0; b.upSince = old.upSince ?? null; b.upBeat = old.upBeat ?? null;
    }
    this._scheduleSave();
  }

  // ===== Thời gian hoạt động (cộng dồn qua các lần vào/ra server) =====
  markOnline(id, now = Date.now()) {
    const b = this._bot(id);
    if (b.upSince == null) b.upSince = now;
    b.upBeat = now;
    this._scheduleSave();
  }
  markOffline(id, now = Date.now()) {
    const b = this.data.bots[String(id)];
    if (!b || b.upSince == null) return;
    b.upMs = (b.upMs || 0) + Math.max(0, now - b.upSince);
    b.upSince = null; b.upBeat = null;
    this._scheduleSave();
  }
  // Nhịp tim: đánh dấu "còn online tới giờ" để lỡ tắt đột ngột vẫn tính đúng gần đúng
  touch(id, now = Date.now()) {
    const b = this.data.bots[String(id)];
    if (b && b.upSince != null) { b.upBeat = now; this._scheduleSave(); }
  }
  // { totalMs: tổng cộng dồn, sessionMs: phiên online hiện tại, online }
  uptime(id, now = Date.now()) {
    const b = this.data.bots[String(id)];
    if (!b) return { totalMs: 0, sessionMs: 0, online: false };
    const sessionMs = b.upSince != null ? Math.max(0, now - b.upSince) : 0;
    return { totalMs: (b.upMs || 0) + sessionMs, sessionMs, online: b.upSince != null };
  }

  /**
   * Thống kê cho 1 bot. null nếu chưa có dữ liệu.
   *   last1h / last24h  tổng thật trong 60 phút / 24 giờ gần nhất
   *   avgPerHour        trung bình/giờ trong 24h gần nhất, chỉ tính thời gian bot THỰC SỰ chạy
   *   perDayEst         avgPerHour × 24 (ước tính — chỉ tin được khi observedMs đủ dài)
   *   today/yesterday   tổng thật theo ngày (múi giờ config)
   *   hourly            12 giờ gần nhất  [{ label:'14h', amount }]
   *   daily             7 ngày gần nhất  [{ label:'09-30', amount }]
   */
  stats(botId, now = Date.now()) {
    const b = this.data.bots[String(botId)];
    if (!b || !b.cycles) return null;
    const inWin = (ms) => b.entries.filter(e => e[0] > now - ms && e[0] <= now);
    const sum = (arr, i = 1) => arr.reduce((s, e) => s + e[i], 0);
    const w1 = inWin(H), w24 = inWin(24 * H);
    const rated = w24.filter(e => !e[4]); // bỏ vòng "hàng dồn" khỏi tốc độ
    const observedMs = sum(rated, 2);
    const avgPerHour = observedMs > 0 ? sum(rated) / (observedMs / H) : null;
    const hourMap = {};
    for (const e of b.entries) { const k = this.hourKey(e[0]); hourMap[k] = (hourMap[k] || 0) + e[1]; }
    const hourly = [];
    for (let i = 11; i >= 0; i--) {
      const k = this.hourKey(now - i * H);
      hourly.push({ label: k.slice(-2) + 'h', amount: hourMap[k] || 0 });
    }
    const daily = [];
    for (let i = 6; i >= 0; i--) {
      const k = this.dayKey(now - i * 24 * H);
      daily.push({ label: k.slice(5), amount: b.days[k] || 0 });
    }
    const le = b.entries.length ? b.entries[b.entries.length - 1] : null;
    return {
      total: b.total, cycles: b.cycles, since: b.since, last: b.last,
      lastAmount: le ? le[1] : 0, lastAt: le ? le[0] : null, // vòng bán gần nhất

      last1h: sum(w1), last24h: sum(w24),
      observedMs, avgPerHour, perDayEst: avgPerHour == null ? null : avgPerHour * 24,
      today: b.days[this.dayKey(now)] || 0,
      yesterday: b.days[this.dayKey(now - 24 * H)] || 0,
      hourly, daily,
    };
  }
}
RevenueTracker.formatMoney = formatMoney;
RevenueTracker.formatMoneyFixed = formatMoneyFixed;
RevenueTracker.parseMoneyToken = parseMoneyToken;
module.exports = RevenueTracker;
