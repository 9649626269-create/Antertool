'use strict';
/**
 * MoneyParse — parser tiền tệ + bộ nhận dạng dòng phản hồi của server cho AutoBeg.
 * Logic thuần (không đụng mạng/bot) để test được. Toàn bộ phép tính dùng BigInt, KHÔNG dùng float / parseInt trên chuỗi rút gọn.
 *
 * Mẫu dòng server đã xác minh (xem task Antertool):
 *   » Bạn có $13.87M                          (/bal)
 *   » Bạn đã chuyển cho dahas $100K           (/pay — phía người gửi)
 *   » Bạn nhận được $100K từ Noanno           (/pay — phía người nhận)
 *   » Người chơi hannnnnnnn không online      (/msg tới người không online)
 *   » Không tìm thấy người chơi này           (/pay tới người không tồn tại / offline)
 *   » Bạn không có đủ tiền                    (/pay vượt số dư)
 *
 * Mọi mẫu bắt buộc KHỚP TOÀN DÒNG và bắt đầu bằng "»" — tin người chơi tự chat ("<Steve> » Bạn nhận được ...") có tiền tố
 * "<tên>" / "tên:" nên không bao giờ khớp. Ngoài ra lớp gọi (AutoBeg) còn bắt buộc position của tin là "system".
 */

const SUFFIX_EXP = Object.freeze({ K: 3, M: 6, B: 9, T: 12 });
const MAX_DIGITS = 24;
const NAME = '[A-Za-z0-9_]{3,16}';
const AMT = '[0-9][0-9.,]*[KMBTkmbt]?';

const pow10 = n => 10n ** BigInt(n);

/**
 * Làm sạch 1 dòng chat: bỏ mã màu §x / ANSI / ký tự điều khiển + zero-width, NFC, gộp khoảng trắng.
 */
function cleanLine(text) {
  return String(text == null ? '' : text)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/§x(?:§[0-9a-fA-F]){6}/g, '')
    .replace(/§[0-9a-fk-orA-FK-OR]/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁩﻿]/g, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * parseMoney("$13.87M") -> { ok:true, value:13870000n, precision:10000n, suffix:'M', exact:false }
 *   value     giá trị hiển thị quy ra đơn vị nhỏ nhất (BigInt)
 *   precision độ phân giải của chữ số cuối đang hiển thị (số thật nằm trong khoảng ±precision quanh value)
 *   exact     true khi không có hậu tố (số nguyên đầy đủ, ví dụ "$500" hoặc "100000")
 * Thất bại -> { ok:false, reason } — KHÔNG BAO GIỜ trả 0 khi lỗi.
 * Mơ hồ bị từ chối: số thập phân không hậu tố ("1.250"), dấu phẩy cùng hậu tố ("1,25K"), quá nhiều chữ số thập phân.
 */
function parseMoney(input, { allowDollar = true } = {}) {
  if (typeof input === 'bigint') return input >= 0n ? { ok: true, value: input, precision: 1n, suffix: '', exact: true } : { ok: false, reason: 'negative' };
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input) || input < 0) return { ok: false, reason: 'number-not-safe-integer' };
    return { ok: true, value: BigInt(input), precision: 1n, suffix: '', exact: true };
  }
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (s.startsWith('$')) {
    if (!allowDollar) return { ok: false, reason: 'dollar-not-allowed' };
    s = s.slice(1).trim();
  }
  const m = /^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?\s*([KMBTkmbt])?$/.exec(s);
  if (!m) return { ok: false, reason: 'bad-format' };
  const intPart = m[1];
  const frac = m[2] || '';
  const suffix = (m[3] || '').toUpperCase();
  if ((intPart.replace(/,/g, '').length + frac.length) > MAX_DIGITS) return { ok: false, reason: 'too-many-digits' };
  if (!suffix) {
    if (frac) return { ok: false, reason: 'ambiguous-decimal-without-suffix' };
    return { ok: true, value: BigInt(intPart.replace(/,/g, '')), precision: 1n, suffix: '', exact: true };
  }
  if (intPart.includes(',')) return { ok: false, reason: 'ambiguous-comma-with-suffix' };
  const exp = SUFFIX_EXP[suffix];
  if (frac.length > exp) return { ok: false, reason: 'too-many-decimals' };
  const value = BigInt(intPart) * pow10(exp) + (frac ? BigInt(frac.padEnd(exp, '0')) : 0n);
  return { ok: true, value, precision: pow10(exp - frac.length), suffix, exact: false };
}

/** Cấu hình ("100K" | 100000 | "100000" | 100000n) -> BigInt, hoặc null nếu không hợp lệ. */
function toBigIntConfig(v) {
  const r = parseMoney(typeof v === 'string' ? v.replace(/^\s*\$/, '') : v, { allowDollar: false });
  return r.ok ? r.value : null;
}

/** BigInt -> "13,860,000" (chỉ để log, không dùng để tính). */
function formatBig(v) {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + s;
}

/** BigInt -> "13.86M" gọn cho log (cắt xuống 2 số lẻ, tính bằng BigInt). */
function formatShort(v) {
  const neg = v < 0n; const a = neg ? -v : v;
  for (const [suf, exp] of [['B', 9], ['M', 6], ['K', 3]]) {
    const unit = pow10(exp);
    if (a >= unit) {
      const whole = a / unit; const hund = (a % unit) * 100n / unit;
      return `${neg ? '-' : ''}${whole}.${hund.toString().padStart(2, '0')}${suf}`;
    }
  }
  return `${neg ? '-' : ''}${a}`;
}

/**
 * Số tiền CHẮC CHẮN không vượt số dư thật.
 * "$13.87M" có thể là làm tròn của 13,865,000..13,874,999 -> gửi 13,870,000 có thể bị "không đủ tiền".
 * Nên với số rút gọn trừ đi 1 đơn vị hiển thị (13,860,000); số nguyên đầy đủ giữ nguyên. Trừ thêm reserve (giữ lại) nếu có.
 */
function safePayAmount(parsed, reserve = 0n) {
  if (!parsed || !parsed.ok) return 0n;
  let v = parsed.exact ? parsed.value : parsed.value - parsed.precision;
  v -= (typeof reserve === 'bigint' && reserve > 0n) ? reserve : 0n;
  return v > 0n ? v : 0n;
}

/** Số tiền server in ra có khớp số tiền ta gửi không (cho phép sai lệch làm tròn của phần hiển thị). */
function amountMatches(expected, shown) {
  if (typeof expected !== 'bigint' || !shown || !shown.ok) return false;
  const diff = shown.value > expected ? shown.value - expected : expected - shown.value;
  return shown.exact ? diff === 0n : diff < shown.precision;
}

// ── Nhận dạng dòng server (neo toàn dòng, bắt đầu bằng "») ──
const RE_RECEIVED = new RegExp(`^»\\s*Bạn nhận được\\s+\\$(${AMT})\\s+từ\\s+(${NAME})\\s*\\.?$`);
const RE_BALANCE = new RegExp(`^»\\s*Bạn có\\s+\\$(${AMT})\\s*\\.?$`);
const RE_PAID = new RegExp(`^»\\s*Bạn đã chuyển cho\\s+(${NAME})\\s+\\$(${AMT})\\s*\\.?$`);
const RE_OFFLINE = new RegExp(`^»\\s*Người chơi\\s+(${NAME})\\s+không online\\s*\\.?$`);
const RE_NOTFOUND = /^»\s*Không tìm thấy người chơi này\s*\.?$/;
const RE_NOTENOUGH = /^»\s*Bạn không có đủ tiền\s*\.?$/;
// Tin nhắn riêng nhận được: "<Sender> Receiver: nội dung"
const RE_PM = new RegExp(`^<(${NAME})>\\s+(${NAME}):\\s*(.*)$`);

/**
 * Phân loại 1 dòng (đã/chưa làm sạch). Trả null nếu không phải dòng hệ thống đã biết.
 *   { type:'received', sender, amount }   amount = kết quả parseMoney (có thể ok:false nếu số mơ hồ)
 *   { type:'balance', amount }
 *   { type:'paid', player, amount }
 *   { type:'offline', player } | { type:'notfound' } | { type:'notenough' }
 *   { type:'pm', sender, receiver, body }
 */
function classifyLine(text) {
  const t = cleanLine(text);
  if (!t) return null;
  let m;
  if ((m = RE_RECEIVED.exec(t))) return { type: 'received', sender: m[2], amount: parseMoney(m[1]), line: t };
  if ((m = RE_BALANCE.exec(t))) return { type: 'balance', amount: parseMoney(m[1]), line: t };
  if ((m = RE_PAID.exec(t))) return { type: 'paid', player: m[1], amount: parseMoney(m[2]), line: t };
  if ((m = RE_OFFLINE.exec(t))) return { type: 'offline', player: m[1], line: t };
  if (RE_NOTFOUND.test(t)) return { type: 'notfound', line: t };
  if (RE_NOTENOUGH.test(t)) return { type: 'notenough', line: t };
  if ((m = RE_PM.exec(t))) return { type: 'pm', sender: m[1], receiver: m[2], body: m[3], line: t };
  return null;
}

module.exports = {
  SUFFIX_EXP, NAME_PATTERN: NAME, cleanLine, parseMoney, toBigIntConfig, formatBig, formatShort,
  safePayAmount, amountMatches, classifyLine,
};
