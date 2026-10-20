'use strict';
// Spawner Protect — phần "não" (không đụng tới mineflayer, test được độc lập).
// Port từ mod Meteor "Spawner Protect" của Alatic (MIT): ThreatPolicy, ThreatRange, DigPattern,
// RecoveryChecks + thêm hệ thống CƯỜNG ĐỘ PROTECT (4 mức + chỉnh từng thông số).

// ---- Định nghĩa từng thông số có thể chỉnh ----
// type: 'int' | 'float' | 'bool'; unit chỉ để hiển thị.
const SPEC = {
  range:          { type: 'int',   min: 4,  max: 128,   unit: 'block',  label: 'Quét người lạ quanh bot' },
  scanTicks:      { type: 'int',   min: 1,  max: 40,    unit: 'tick',   label: 'Nhịp quét (20 tick = 1s)' },
  threatRadius:   { type: 'int',   min: 4,  max: 256,   unit: 'block',  label: 'Bán kính nguy hiểm quanh lồng (đào/TNT/wither)' },
  fullHeight:     { type: 'bool',                                       label: 'Chỉ tính khoảng cách ngang (bỏ qua độ cao)' },
  players:        { type: 'bool',                                       label: 'Phát hiện người chơi đang đập block gần lồng' },
  explosive:      { type: 'bool',                                       label: 'Phát hiện TNT / TNT minecart / vụ nổ' },
  tntCarts:       { type: 'bool',                                       label: 'Coi cả TNT minecart đậu yên là nguy hiểm' },
  wither:         { type: 'bool',                                       label: 'Phát hiện Wither / sọ wither' },
  surfaceDig:     { type: 'bool',                                       label: 'Phát hiện đào xuống bề mặt (heuristic)' },
  digThreshold:   { type: 'int',   min: 1,  max: 8,     unit: 'block',  label: 'Số block đào liên tiếp để báo (1 = nhạy nhất)' },
  autoMine:       { type: 'bool',                                       label: 'Tự đập lồng + cất ender chest (tắt = chỉ cảnh báo)' },
  armDelayMs:     { type: 'int',   min: 0,  max: 30000, unit: 'ms',     label: 'Chờ sau khi đứng cạnh lồng mới canh' },
  pauseTicks:     { type: 'int',   min: 1,  max: 200,   unit: 'tick',   label: 'Nghỉ giữa các đợt đào' },
  depositPerTick: { type: 'int',   min: 1,  max: 9,     unit: 'stack/tick', label: 'Tốc độ bỏ đồ vào ender chest' },
  reserveSlots:   { type: 'int',   min: 1,  max: 10,    unit: 'ô',      label: 'Ô trống tối thiểu trước khi đào tiếp' },
  timeoutSec:     { type: 'int',   min: 10, max: 600,   unit: 's',      label: 'Giới hạn thời gian xử lý khẩn cấp' },
  alertCooldownMs:{ type: 'int',   min: 1000, max: 600000, unit: 'ms',   label: 'Giãn cách cảnh báo webhook' },
};
const KEYS = Object.keys(SPEC);

// ---- 4 mức cường độ ----
// 2 = hành vi gần giống bản cũ (quét 20 block/5 tick, tự đập) + thêm phát hiện mới của mod gốc.
const LEVELS = {
  1: {
    name: 'Nhẹ', icon: '🟢',
    desc: 'Chỉ cảnh báo, không tự đập lồng. Ít báo nhầm nhất.',
    s: { range: 12, scanTicks: 10, threatRadius: 16, fullHeight: false, players: true, explosive: false, tntCarts: false,
         wither: false, surfaceDig: false, digThreshold: 2, autoMine: false, armDelayMs: 3000, pauseTicks: 12,
         depositPerTick: 2, reserveSlots: 2, timeoutSec: 120, alertCooldownMs: 30000 },
  },
  2: {
    name: 'Cân bằng', icon: '🟡',
    desc: 'Mặc định. Người lạ 20 block, TNT/Wither, đào bề mặt (2 block liên tiếp). Tự đập + cất.',
    s: { range: 20, scanTicks: 5, threatRadius: 32, fullHeight: false, players: true, explosive: true, tntCarts: false,
         wither: true, surfaceDig: true, digThreshold: 2, autoMine: true, armDelayMs: 3000, pauseTicks: 8,
         depositPerTick: 4, reserveSlots: 2, timeoutSec: 90, alertCooldownMs: 15000 },
  },
  3: {
    name: 'Mạnh', icon: '🟠',
    desc: 'Quét rộng 32 block mỗi 2 tick, tính cả TNT minecart đậu yên, canh ngay khi tới lồng.',
    s: { range: 32, scanTicks: 2, threatRadius: 48, fullHeight: false, players: true, explosive: true, tntCarts: true,
         wither: true, surfaceDig: true, digThreshold: 2, autoMine: true, armDelayMs: 1500, pauseTicks: 6,
         depositPerTick: 6, reserveSlots: 2, timeoutSec: 90, alertCooldownMs: 8000 },
  },
  4: {
    name: 'Tối đa', icon: '🔴',
    desc: 'Nhạy nhất: 48 block mỗi tick, đào bề mặt chỉ cần 1 block, tính khoảng cách ngang, đập nhanh. Dễ báo nhầm.',
    s: { range: 48, scanTicks: 1, threatRadius: 64, fullHeight: true, players: true, explosive: true, tntCarts: true,
         wither: true, surfaceDig: true, digThreshold: 1, autoMine: true, armDelayMs: 0, pauseTicks: 4,
         depositPerTick: 9, reserveSlots: 3, timeoutSec: 60, alertCooldownMs: 4000 },
  },
};
const DEFAULT_LEVEL = 2;

function clampLevel(n) {
  n = Math.round(Number(n));
  return LEVELS[n] ? n : DEFAULT_LEVEL;
}

// Chuẩn hoá 1 giá trị theo SPEC; trả về undefined nếu không hợp lệ.
function coerce(key, v) {
  const sp = SPEC[key];
  if (!sp || v === null || v === undefined) return undefined;
  if (sp.type === 'bool') {
    if (typeof v === 'boolean') return v;
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'on', 'yes', 'bat', 'bật'].includes(s)) return true;
    if (['0', 'false', 'off', 'no', 'tat', 'tắt'].includes(s)) return false;
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  const r = sp.type === 'int' ? Math.round(n) : n;
  return Math.min(sp.max, Math.max(sp.min, r));
}

// Chỉ giữ khoá hợp lệ + giá trị hợp lệ
function normalizeTune(tune) {
  const out = {};
  if (!tune || typeof tune !== 'object') return out;
  for (const k of KEYS) {
    if (!(k in tune)) continue;
    const v = coerce(k, tune[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Cài đặt hiệu lực = preset của mức, đè bởi tune (người dùng chỉnh tay)
function resolveSettings(level, tune) {
  return { ...LEVELS[clampLevel(level)].s, ...normalizeTune(tune) };
}

// Chỉ giữ những khoá KHÁC preset (đổi mức thì các khoá trùng preset mới không bị "ghim" nhầm)
function diffFromPreset(level, settings) {
  const base = LEVELS[clampLevel(level)].s;
  const out = {};
  for (const k of KEYS) {
    const v = coerce(k, settings[k]);
    if (v !== undefined && v !== base[k]) out[k] = v;
  }
  return out;
}

// Cho giao diện / lệnh: bảng mức + thông số
function describe() {
  return {
    spec: SPEC,
    levels: Object.fromEntries(Object.entries(LEVELS).map(([n, l]) => [n, { name: l.name, icon: l.icon, desc: l.desc, settings: l.s }])),
  };
}

// ---- ThreatPolicy (port) ----
// kind: 'tnt' | 'tnt_cart' | 'wither' | 'skull'. Trả về nhãn hoặc null nếu cấu hình không bật loại này.
function threatLabel(kind, { explosive, wither, tntCarts, charged = false, primed = false } = {}) {
  switch (kind) {
    case 'tnt': return explosive ? 'TNT đã châm' : null;
    case 'tnt_cart': return explosive && (primed || tntCarts) ? (primed ? 'TNT minecart đã châm' : 'TNT minecart') : null;
    case 'wither': return wither ? 'Wither' : null;
    case 'skull': return wither ? (charged ? 'sọ wither xanh' : 'sọ wither') : null;
    default: return null;
  }
}
const ENTITY_KIND = { tnt: 'tnt', primed_tnt: 'tnt', tnt_minecart: 'tnt_cart', minecart_tnt: 'tnt_cart', wither: 'wither', wither_skull: 'skull', wither_skull_dangerous: 'skull' };
function entityKind(name) { return ENTITY_KIND[String(name || '').toLowerCase()] || null; }

// ---- ThreatRange (port) ----
function threatDistance(dx, dy, dz, fullHeight) {
  return Math.sqrt(dx * dx + dz * dz + (fullHeight ? 0 : dy * dy));
}
function insideRange(distance, radius, blast = 0) {
  return Number.isFinite(distance) && Number.isFinite(blast) && distance <= radius + Math.max(0, blast);
}

// ---- DigPattern (port): các lần đào liên tiếp xuống dưới trong 1 cột (x,z) ----
class DigPattern {
  constructor(windowMs = 5000) { this.windowMs = windowMs; this.cols = new Map(); }
  clear() { this.cols.clear(); }
  // true khi đã đủ `threshold` lần bị mất block liên tiếp, mỗi lần thấp hơn lần trước đúng 1
  removed(x, y, z, now, threshold) {
    for (const [k, s] of this.cols) if (now - s.t > this.windowMs) this.cols.delete(k);
    const key = `${x},${z}`;
    const prev = this.cols.get(key);
    const count = prev && y === prev.y - 1 ? prev.count + 1 : 1;
    if (this.cols.size >= 1024 && !prev) this.cols.clear();
    this.cols.set(key, { y, t: now, count });
    return count >= threshold;
  }
}

// ---- RecoveryChecks (port) ----
// Chỉ coi là đã gửi đồ xong khi snapshot server xác nhận: rương có ≥ dự kiến, túi không còn lồng
function depositVerified({ snapshot, chestCount, expectedChest, playerCount }) {
  return !!snapshot && chestCount >= expectedChest && playerCount === 0;
}
// Chỉ được thoát khi đã xác minh cất đồ, không còn gì trong túi/dưới đất/chưa đập, không có lỗi
function mayLogout({ stored, carried, ground, remaining, failed }) {
  return !!stored && carried === 0 && ground === 0 && remaining === 0 && !failed;
}

// Block rơi (cát, sỏi…) và lá không tính là "đào" khi phát hiện đào bề mặt
const FALLING_RE = /(^|_)(sand|gravel|concrete_powder|anvil|dragon_egg|scaffolding)$|^suspicious_/;
function isDigEligible(block) {
  if (!block) return false;
  const n = String(block.name || '');
  if (!n || n === 'air' || n === 'cave_air' || n === 'void_air') return false;
  if (/leaves$/.test(n) || FALLING_RE.test(n)) return false;
  if (/water|lava|bubble_column/.test(n)) return false;
  return block.boundingBox === 'block'; // chỉ block đặc (mineflayer: 'block' | 'empty')
}

module.exports = {
  SPEC, KEYS, LEVELS, DEFAULT_LEVEL, clampLevel, coerce, normalizeTune, resolveSettings, diffFromPreset, describe,
  threatLabel, entityKind, threatDistance, insideRange, DigPattern, depositVerified, mayLogout, isDigEligible,
};
