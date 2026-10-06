'use strict';
const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const jit = (base, s) => Math.max(0, base + Math.round((Math.random() * 2 - 1) * s));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const nowMs = () => Date.now();
function stripMc(s) {
  return String(s)
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/\u00a7[0-9a-fk-or]/gi, '')
    .replace(/\\u[0-9a-fA-F]{4}/g, '');
}
function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}
function _unwrapList(listLike) {
  if (!listLike) return [];
  if (Array.isArray(listLike)) return listLike;
  if (typeof listLike === 'object') {
    const v = listLike.value;
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      if (Array.isArray(v.value)) return v.value;
      return Object.values(v);
    }
    return Object.values(listLike);
  }
  return [];
}
// Từ 1.20.3 server gửi Component (kick, title...) dạng NBT: {type:'compound', value:{text:{type:'string', value:'...'}}}.
// Đổi về JSON thường {text:'...'} để resolveText đọc được (trước đây kick bị in ra thành chuỗi JSON thô và bị cắt cụt).
function nbtSimplify(n) {
  if (!n || typeof n !== 'object' || !('type' in n) || !('value' in n)) return n;
  const v = n.value;
  if (n.type === 'compound') {
    const o = {};
    for (const k of Object.keys(v || {})) o[k] = nbtSimplify(v[k]);
    return o;
  }
  if (n.type === 'list') {
    const t = v && v.type;
    const arr = Array.isArray(v && v.value) ? v.value : [];
    return arr.map(x => (t === 'compound' || t === 'list') ? nbtSimplify({ type: t, value: x }) : x);
  }
  return v;
}
function resolveText(raw) {
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return stripMc(raw);
  try {
    let o = typeof raw === 'object' ? raw : JSON.parse(raw);
    if (o && o.type === 'compound' && o.value && typeof o.value === 'object') o = nbtSimplify(o);
    if (o.type === 'string' && typeof o.value === 'string') {
      return stripMc(o.value);
    }
    let out = typeof o.text === 'string' ? o.text : (o.text ? resolveText(o.text) : '');
    out += _unwrapList(o.extra).map(resolveText).join('');
    out += _unwrapList(o.with).map(resolveText).join('');
    return stripMc(out);
  } catch { return stripMc(String(raw)); }
}
function parseShardNum(text) {
  if (!text) return null;
  const up = text.toUpperCase();
  if (!up.includes('SHARD') && !up.includes('MẢNH')) return null;
  for (const m of text.matchAll(/(\d[\d,.]*)\s*(k|K|M)?/g)) {
    let n = parseFloat(m[1].replace(/[,.]/g, ''));
    if (isNaN(n)) continue;
    if (m[2] === 'k' || m[2] === 'K') n *= 1e3;
    if (m[2] === 'M') n *= 1e6;
    if (n >= 1) return Math.round(n);
  }
  return null;
}
function safeJsonStringify(obj, fallback = '{}') {
  try { return JSON.stringify(obj); } catch { return fallback; }
}
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
function ts() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// Nhiều server MC dùng font "chữ hoa nhỏ" Unicode cho tiêu đề GUI (vd
// "ĐƠɴ ʜÀɴɢ" thay vì "ĐƠN HÀNG") — các ký tự này KHÔNG được .toUpperCase()
// chuyển đổi vì Unicode không coi chúng là dạng thường của chữ Latin. Hàm
// này đưa chúng về lại chữ Latin thường để so khớp tiêu đề không bị trượt.
const SMALL_CAPS_MAP = {
  'ᴀ': 'A', 'ʙ': 'B', 'ᴄ': 'C', 'ᴅ': 'D', 'ᴇ': 'E', 'ꜰ': 'F', 'ɢ': 'G', 'ʜ': 'H',
  'ɪ': 'I', 'ᴊ': 'J', 'ᴋ': 'K', 'ʟ': 'L', 'ᴍ': 'M', 'ɴ': 'N', 'ᴏ': 'O', 'ᴘ': 'P',
  'ʀ': 'R', 'ꜱ': 'S', 'ᴛ': 'T', 'ᴜ': 'U', 'ᴠ': 'V', 'ᴡ': 'W', 'ʏ': 'Y', 'ᴢ': 'Z',
};
function normalizeSmallCaps(s) {
  return String(s).replace(/[ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ]/g, c => SMALL_CAPS_MAP[c] || c);
}
// Lý do kick/disconnect từ mineflayer thường là 1 CHUỖI đã JSON.stringify
// sẵn (vd '{"text":"§c§lKINGMC.VN §7đang bảo trì..."}') chứ không phải
// object — nếu chỉ kiểm tra typeof==='string' rồi dùng thẳng (bug cũ) thì
// mã màu § và cả dấu ngoặc JSON lọt nguyên xi ra log/webhook. Hàm này thử
// parse JSON trước, sau đó luôn đưa qua resolveText() để có text sạch.
function parseReasonText(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = raw; } // không phải JSON thì giữ nguyên chuỗi thường
  }
  return resolveText(obj);
}
module.exports = {
  rand, jit, sleep, clamp, nowMs,
  stripMc, stripAnsi, resolveText, nbtSimplify, parseShardNum, safeJsonStringify,
  formatUptime, formatBytes, ts, normalizeSmallCaps, parseReasonText,
};
