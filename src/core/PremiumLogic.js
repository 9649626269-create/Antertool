'use strict';
/**
 * PremiumLogic — logic thuần (không phụ thuộc mineflayer) port từ gói premium (Java):
 * AutoOrderLogic, OrderDropperLogic, SpawnerDropperLogic, BlazeShopDroperLogic,
 * SetupModuleLogic, NameProtectLogic, AutoSellLogic.
 */
const { normalizeSmallCaps } = require('./utils');

// ── Chuẩn hoá tiếng Việt: bỏ small-caps, bỏ dấu, đ→d, chữ thường ──
function normalizeVi(s) {
  return normalizeSmallCaps(String(s ?? ''))
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/Đ/g, 'D').replace(/đ/g, 'd')
    .toLowerCase();
}

// ── Số rút gọn: 1.5K / 2M / 3B ──
function compactNumber(num, suffix) {
  const v = parseFloat(num);
  if (!Number.isFinite(v)) return 0;
  switch (String(suffix || '').toUpperCase()) {
    case 'K': return v * 1e3;
    case 'M': return v * 1e6;
    case 'B': return v * 1e9;
    default: return v;
  }
}
function formatMoney(v) {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
  return `$${Math.round(v)}`;
}
const progressPercent = (cur, target) => (target <= 0 ? 100 : Math.min(100, Math.max(0, cur * 100 / target)));

// ── AutoOrder ──
const PROGRESS_RE = /(\d+)\s*\/\s*(\d+)/;
const MONEY_RE = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*([KMBkmb]?)/;
const DELIVERY_RE = /ban da giao\s+(\d+)\b.*?nhan duoc\s*:?\s*\+\s*\$\s*([0-9]+(?:\.[0-9]+)?)\s*([KMB]?)/i;

/** "minecraft:blaze_rod" -> "blaze rod" (đối số của /order) */
function orderCommandName(itemName) {
  const s = String(itemName || '');
  return s.slice(s.indexOf(':') + 1).replace(/_/g, ' ').trim();
}
/** Số còn thiếu từ lore "done/total"; -1 nếu không đọc được */
function orderRemaining(lore) {
  for (const line of lore || []) {
    const m = PROGRESS_RE.exec(line);
    if (m) return Math.max(0, parseInt(m[2], 10) - parseInt(m[1], 10));
  }
  return -1;
}
function orderPricePerItem(lore) {
  for (const line of lore || []) {
    const m = MONEY_RE.exec(line);
    if (m) return compactNumber(m[1], m[2]);
  }
  return 0;
}
/** candidates: [{slot, remaining, price}] -> slot giá cao nhất còn >= minRemaining (mặc định 64); -1 nếu không có */
function bestOrderSlot(candidates, minRemaining = 64) {
  let best = -1, bestPrice = -1;
  for (const c of candidates) {
    if (c.remaining < minRemaining || c.price <= bestPrice) continue;
    best = c.slot; bestPrice = c.price;
  }
  return best;
}
/** "Bạn đã giao 64 ... nhận được: +$1.5K" -> {items, money} | null */
function parseDelivery(message) {
  if (!message) return null;
  const m = DELIVERY_RE.exec(normalizeVi(message));
  if (!m) return null;
  return { items: parseInt(m[1], 10), money: compactNumber(m[2], m[3]) };
}

// Đếm stack theo số vật phẩm đã được server xác nhận
class StackCounter {
  constructor() { this.reset(); }
  addConfirmedItems(n) {
    if (!(n > 0)) return;
    const combined = this.remainder + n;
    this.stacks += Math.floor(combined / 64);
    this.remainder = combined % 64;
  }
  reset() { this.stacks = 0; this.remainder = 0; }
}
// Hẹn giờ theo phút (báo cáo định kỳ)
class MinuteSchedule {
  constructor() { this.nextAt = 0; }
  reset(now, minutes) { this.nextAt = now + Math.max(1, minutes) * 60000; }
  takeIfDue(now, minutes) {
    if (this.nextAt <= 0) this.reset(now, minutes);
    if (now < this.nextAt) return false;
    this.reset(now, minutes);
    return true;
  }
}
// Chỉ tính vật phẩm khi slot THỰC SỰ giảm theo cập nhật từ server
class ConfirmedTransfer {
  constructor(beforeBySlot) {
    this.before = new Map(beforeBySlot instanceof Map ? beforeBySlot : Object.entries(beforeBySlot).map(([k, v]) => [Number(k), v]));
    this.counted = new Map();
    this.observed = new Set();
  }
  hasSlot(slot) { return this.before.has(slot); }
  slots() { return [...this.before.keys()]; }
  reconcileSlot(slot, currentCount) {
    if (!this.before.has(slot)) return 0;
    const before = this.before.get(slot);
    this.observed.add(slot);
    const decrease = Math.max(0, Math.min(before, before - Math.max(0, currentCount)));
    const counted = this.counted.get(slot) || 0;
    if (decrease <= counted) return 0;
    this.counted.set(slot, decrease);
    return decrease - counted;
  }
  reconcileAll(currentBySlot) {
    let n = 0;
    for (const slot of this.before.keys()) n += this.reconcileSlot(slot, currentBySlot.get(slot) || 0);
    return n;
  }
  allObserved() { return this.slots().every(s => this.observed.has(s)); }
}

// ── OrderDropper / BlazeShop ──
const isOutOfStockMessage = m => /\bkhong\s+co\s+vat\s+pham(?:\s+nao)?\s+de\s+nhan\b/.test(normalizeVi(m));
const isOutOfMoneyMessage = m => normalizeVi(m).includes('de mua vat pham nay');
const BLAZE_ROD_PRICE = 150;
function moneyLimit(millions) {
  const v = Number(millions);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1e6) : 0;
}
const moneyForItems = items => (items > 0 ? items * BLAZE_ROD_PRICE : 0);
const batchTotals = fortyFiveStacks => { const stacks = fortyFiveStacks ? 45 : 1; return { stacks, items: stacks * 64 }; };
const isWithinDropRadius = sqDist => sqDist <= 4.0;
/** Tìm slot đầu tiên (không bị loại) thỏa matches(slot) */
function findFirstAvailableSlot(first, last, exhausted, matches) {
  for (let s = first; s <= last; s++) if (!exhausted.has(s) && matches(s)) return s;
  return -1;
}
// Cổng xác nhận: chỉ tính 1 lần khi vật phẩm rơi đúng loại & trong bán kính
class ConfirmationGate {
  constructor() { this.awaiting = false; }
  open() { this.awaiting = true; }
  clear() { this.awaiting = false; }
  confirm(matchingItem, withinRadius) {
    if (!this.awaiting || !matchingItem || !withinRadius) return false;
    this.awaiting = false; return true;
  }
}

// ── SpawnerDropper ──
/** slots: [{slot,item,count}]; selected: Set tên item được phép. Có item ngoài danh sách -> 'junk' */
function classifyPage(slots, selected) {
  for (const s of slots) if (s.count > 0 && !selected.has(s.item)) return 'junk';
  return 'selectedOrEmpty';
}
const nextPhase = p => (p === 'dropAll' ? 'sellAll' : 'dropAll');
const actionFor = (phase, pageKind) => (pageKind === 'junk' ? 'startJunkDrop' : phase);
/** Yaw tương đương gần nhất với yaw tham chiếu (tránh xoay 350°) */
function nearestEquivalentYaw(ref, target) {
  let d = (target - ref) % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return ref + d;
}
// Kế toán theo slot: số item/stack giảm thực sự
class PendingAccounting {
  constructor(slots) {
    this.before = new Map();
    for (const s of slots) if (s.count > 0) this.before.set(s.slot, s);
    this.counted = new Map();
    this.stackSlots = new Set();
  }
  _one(slot, item, count) {
    const b = this.before.get(slot);
    if (!b) return { items: 0, stacks: 0 };
    const remain = item === b.item ? Math.max(0, count) : 0;
    const dec = Math.max(0, Math.min(b.count, b.count - remain));
    const done = this.counted.get(slot) || 0;
    if (dec <= done) return { items: 0, stacks: 0 };
    this.counted.set(slot, dec);
    const first = !this.stackSlots.has(slot);
    this.stackSlots.add(slot);
    return { items: dec - done, stacks: first ? 1 : 0 };
  }
  reconcileSlot(cur) { return this._one(cur.slot, cur.item, cur.count); }
  reconcile(current) {
    const by = new Map(current.map(s => [s.slot, s]));
    const out = { items: 0, stacks: 0 };
    for (const b of this.before.values()) {
      const n = by.get(b.slot);
      const r = this._one(b.slot, n ? n.item : null, n ? n.count : 0);
      out.items += r.items; out.stacks += r.stacks;
    }
    return out;
  }
}

// ── AutoSell: whitelist/blacklist ──
const shouldSell = (mode, listed) => (String(mode).toLowerCase() === 'whitelist' ? !!listed : !listed);

// ── Setup modules ──
function requiredTransfer(destEmpty, destMatches, destCount, configured, maxStack) {
  if (!destEmpty && !destMatches) return 0;
  const target = Math.max(1, Math.min(configured, maxStack));
  const cur = destEmpty ? 0 : Math.max(0, destCount);
  return Math.max(0, target - cur);
}
const patternMask = disabled => { let m = 0; for (let i = 0; i < Math.min(disabled.length, 9); i++) if (disabled[i]) m |= 1 << i; return m; };

// ── NameProtect: thay tên (không phân biệt hoa/thường), an toàn khi thay thế chồng nhau ──
function protectNames(text, replacements) {
  if (!text || !replacements || !replacements.length) return text;
  const ph = i => `\u0000${i}\u0000`;
  let out = String(text);
  replacements.forEach(([from], i) => {
    if (!from) return;
    out = out.replace(new RegExp(String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ph(i));
  });
  replacements.forEach(([, to], i) => { out = out.split(ph(i)).join(to); });
  return out;
}

// ── Độ trễ thích ứng theo ping (port smartDelay: tick -> ms) ──
function smartDelayMs(ping) {
  const p = Number.isFinite(ping) && ping >= 0 ? ping : 100;
  const ticks = p < 50 ? 2 : p < 100 ? 3 : p < 200 ? 5 : p < 300 ? 8 : 12;
  return ticks * 50;
}

module.exports = {
  normalizeVi, compactNumber, formatMoney, progressPercent,
  orderCommandName, orderRemaining, orderPricePerItem, bestOrderSlot, parseDelivery,
  StackCounter, MinuteSchedule, ConfirmedTransfer,
  isOutOfStockMessage, isOutOfMoneyMessage, BLAZE_ROD_PRICE, moneyLimit, moneyForItems, batchTotals,
  isWithinDropRadius, findFirstAvailableSlot, ConfirmationGate,
  classifyPage, nextPhase, actionFor, nearestEquivalentYaw, PendingAccounting,
  shouldSell, requiredTransfer, patternMask, protectNames, smartDelayMs,
};
