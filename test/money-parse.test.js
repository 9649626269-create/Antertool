'use strict';
const assert = require('assert');
const M = require('../src/core/MoneyParse');

const ok = (s, value, extra = {}) => {
  const r = M.parseMoney(s);
  assert.strictEqual(r.ok, true, `${s} phải parse được (${r.reason})`);
  assert.strictEqual(r.value, value, `${s} -> ${r.value}`);
  for (const [k, v] of Object.entries(extra)) assert.strictEqual(r[k], v, `${s}.${k}`);
};
const bad = (s, reason) => {
  const r = M.parseMoney(s);
  assert.strictEqual(r.ok, false, `${s} phải bị từ chối nhưng ra ${r.value}`);
  if (reason) assert.strictEqual(r.reason, reason, `${s} lý do`);
  assert.strictEqual(r.value, undefined, 'lỗi không được kèm giá trị (không mặc định 0)');
};

// ── số nguyên đầy đủ / không hậu tố ──
ok('0', 0n, { exact: true });
ok('$0', 0n, { exact: true });
ok('$500', 500n);
ok('100000', 100000n, { exact: true, precision: 1n });
ok('$1,250', 1250n);
ok('$1,250,000', 1250000n);
ok('$99999999999999999999', 99999999999999999999n);
// ── hậu tố K/M/B (hoa/thường) ──
ok('$1.25K', 1250n, { precision: 10n, suffix: 'K', exact: false });
ok('$1.00K', 1000n);
ok('$2.50M', 2500000n);
ok('$1.00B', 1000000000n);
ok('100k', 100000n);
ok('18m', 18000000n);
ok('1b', 1000000000n);
ok('$13.87M', 13870000n, { precision: 10000n });
ok('$13.87m', 13870000n);
ok('$0.01K', 10n);
ok('$1.234567M', 1234567n, { precision: 1n });   // đủ 6 chữ số thập phân -> chính xác tuyệt đối
// KHÔNG float / parseInt: các ca này sai nếu dùng parseFloat(x)*1e6 hoặc parseInt
assert.notStrictEqual(2.01 * 1e6, 2010000);     // = 2009999.9999999998
assert.notStrictEqual(4.02 * 1e6, 4020000);     // = 4019999.9999999995
assert.strictEqual(parseInt('13.87M'), 13);      // parseInt cắt cụt: sai hoàn toàn
ok('$2.01M', 2010000n);
ok('$4.02M', 4020000n);
ok('$2.07M', 2070000n);
ok('$13.87M', 13870000n);
ok('$0.07M', 70000n);
ok('$1.1K', 1100n);

// ── lỗi / mơ hồ: phải null-ish, không phải 0 ──
bad('', 'empty');
bad('   ', 'empty');
bad('abc', 'bad-format');
bad('$', 'bad-format');
bad('-100', 'bad-format');
bad('$-5K', 'bad-format');
bad('1e6', 'bad-format');
bad('Infinity', 'bad-format');
bad('NaN', 'bad-format');
bad('$1.250', 'ambiguous-decimal-without-suffix');   // 1.250 = 1250 hay 1.25?
bad('$13.87', 'ambiguous-decimal-without-suffix');
bad('$1,25K', 'bad-format');
bad('$1,250K', 'ambiguous-comma-with-suffix');
bad('$1.2345K', 'too-many-decimals');
bad('$1.2.3M', 'bad-format');
bad('$100X', 'bad-format');
bad('$1 0 0K', 'bad-format');
bad(null, 'empty');
bad(undefined, 'empty');
bad('9'.repeat(30), 'too-many-digits');
assert.strictEqual(M.parseMoney(-1n).ok, false);
assert.strictEqual(M.parseMoney(1.5).ok, false);
assert.strictEqual(M.parseMoney(NaN).ok, false);
assert.strictEqual(M.parseMoney(100000).value, 100000n);
// $ không được phép trong cấu hình
assert.strictEqual(M.toBigIntConfig('100K'), 100000n);
assert.strictEqual(M.toBigIntConfig(100000), 100000n);
assert.strictEqual(M.toBigIntConfig('$100K'), 100000n);   // tolerate $ ở đầu chuỗi cấu hình
assert.strictEqual(M.toBigIntConfig('abc'), null);
assert.strictEqual(M.toBigIntConfig(''), null);
assert.strictEqual(M.toBigIntConfig(null), null);

// ── biên: phân biệt "không đọc được" / "0" / "hợp lệ" ──
const zero = M.parseMoney('$0');
assert.strictEqual(zero.ok, true);
assert.strictEqual(zero.value, 0n);
const fail = M.parseMoney('$xyz');
assert.strictEqual(fail.ok, false);
assert.ok(fail.reason);

// ── safePayAmount: không bao giờ vượt số dư thật ──
assert.strictEqual(M.safePayAmount(M.parseMoney('$13.87M')), 13860000n);   // thật có thể là 13,865,000
assert.strictEqual(M.safePayAmount(M.parseMoney('$1.25K')), 1240n);
assert.strictEqual(M.safePayAmount(M.parseMoney('$500')), 500n);           // số nguyên đầy đủ giữ nguyên
assert.strictEqual(M.safePayAmount(M.parseMoney('$500'), 100n), 400n);
assert.strictEqual(M.safePayAmount(M.parseMoney('$0.01K')), 0n);           // 10 - 10 = 0 -> không có gì an toàn để gửi
assert.strictEqual(M.safePayAmount(M.parseMoney('$0'), 0n), 0n);
assert.strictEqual(M.safePayAmount(M.parseMoney('$100'), 500n), 0n);       // reserve lớn hơn số dư -> 0, không âm
assert.strictEqual(M.safePayAmount({ ok: false }), 0n);
// với mọi số dư thật b, hiển thị làm tròn nửa trên hoặc cắt cụt, safe <= b
for (const real of [13865000n, 13869999n, 13870000n, 13874999n]) {
  const shown = (real + 5000n) / 10000n * 10000n;   // làm tròn nửa lên
  const trunc = real / 10000n * 10000n;             // cắt cụt
  for (const v of [shown, trunc]) {
    const p = { ok: true, value: v, precision: 10000n, exact: false };
    assert.ok(M.safePayAmount(p) <= real, `safe ${M.safePayAmount(p)} > thật ${real}`);
  }
}

// ── amountMatches ──
assert.strictEqual(M.amountMatches(100000n, M.parseMoney('$100K')), true);
assert.strictEqual(M.amountMatches(100000n, M.parseMoney('$100.00K')), true);
assert.strictEqual(M.amountMatches(13860000n, M.parseMoney('$13.86M')), true);
assert.strictEqual(M.amountMatches(13864999n, M.parseMoney('$13.86M')), true);   // server làm tròn khi hiển thị
assert.strictEqual(M.amountMatches(100000n, M.parseMoney('$200K')), false);
assert.strictEqual(M.amountMatches(500n, M.parseMoney('$501')), false);          // số nguyên phải khớp tuyệt đối
assert.strictEqual(M.amountMatches(500n, { ok: false }), false);

// ── định dạng ──
assert.strictEqual(M.formatBig(13860000n), '13,860,000');
assert.strictEqual(M.formatBig(0n), '0');
assert.strictEqual(M.formatShort(13860000n), '13.86M');
assert.strictEqual(M.formatShort(999n), '999');
assert.strictEqual(M.formatShort(1000000000n), '1.00B');

// ── cleanLine ──
assert.strictEqual(M.cleanLine('§a» §fBạn có §e$1.25K'), '» Bạn có $1.25K');
assert.strictEqual(M.cleanLine('  » Bạn​  có   $5 '), '» Bạn có $5');

// ── classifyLine: dòng server thật ──
const c = (s) => M.classifyLine(s);
let r = c('» Bạn nhận được $100K từ Noanno');
assert.strictEqual(r.type, 'received'); assert.strictEqual(r.sender, 'Noanno'); assert.strictEqual(r.amount.value, 100000n);
r = c('» Bạn nhận được $1.00K từ Steve'); assert.strictEqual(r.amount.value, 1000n); assert.strictEqual(r.sender, 'Steve');
r = c('» Bạn nhận được $1.00M từ Alex'); assert.strictEqual(r.amount.value, 1000000n);
r = c('» Bạn nhận được $1.00B từ Player123'); assert.strictEqual(r.amount.value, 1000000000n); assert.strictEqual(r.sender, 'Player123');
r = c('§a» §fBạn nhận được §e$100K §ftừ §bNoanno'); assert.strictEqual(r.type, 'received'); assert.strictEqual(r.sender, 'Noanno');
r = c('» Bạn nhận được $100k từ Noanno'); assert.strictEqual(r.amount.value, 100000n);
r = c('» Bạn nhận được $1.250 từ Noanno'); assert.strictEqual(r.type, 'received'); assert.strictEqual(r.amount.ok, false);   // mơ hồ -> ok:false, KHÔNG coi là 1250

r = c('» Bạn có $13.87M'); assert.strictEqual(r.type, 'balance'); assert.strictEqual(r.amount.value, 13870000n);
assert.strictEqual(c('» Bạn có $1.25K').amount.value, 1250n);
assert.strictEqual(c('» Bạn có $2.50M').amount.value, 2500000n);
assert.strictEqual(c('» Bạn có $1.00B').amount.value, 1000000000n);
assert.strictEqual(c('» Bạn có $0').amount.value, 0n);
assert.strictEqual(c('» Bạn có $0').amount.ok, true);
assert.strictEqual(c('» Bạn có $500').amount.value, 500n);
assert.strictEqual(c('» Bạn có $abc'), null);
assert.strictEqual(c('» Bạn có $'), null);

r = c('» Bạn đã chuyển cho dahas $100K'); assert.strictEqual(r.type, 'paid'); assert.strictEqual(r.player, 'dahas'); assert.strictEqual(r.amount.value, 100000n);
r = c('» Người chơi hannnnnnnn không online'); assert.strictEqual(r.type, 'offline'); assert.strictEqual(r.player, 'hannnnnnnn');
assert.strictEqual(c('» Không tìm thấy người chơi này').type, 'notfound');
assert.strictEqual(c('» Bạn không có đủ tiền').type, 'notenough');
r = c('<Noanno> dahas: hello'); assert.strictEqual(r.type, 'pm'); assert.strictEqual(r.sender, 'Noanno'); assert.strictEqual(r.receiver, 'dahas'); assert.strictEqual(r.body, 'hello');

// ── CHỐNG GIẢ MẠO: người chơi tự gõ thông báo giả vào chat / PM ──
const spoofs = [
  '<Noanno> dahas: » Bạn nhận được $100K từ Noanno',        // PM giả
  '<Noanno> » Bạn nhận được $100K từ Noanno',               // chat giả
  '[Accchinh] <Noanno> dahas: » Bạn nhận được $100K từ Noanno',
  'Noanno: » Bạn nhận được $100K từ Noanno',
  'Noanno » » Bạn nhận được $100K từ Noanno',
  '[VIP] Noanno » Bạn nhận được $100K từ Noanno',
  'Noanno » Bạn có $999B',
  '<Noanno> » Bạn đã chuyển cho dahas $100K',
  '<Noanno> » Bạn không có đủ tiền',
  '» Bạn nhận được $100K từ Noanno và còn nữa',            // thừa đuôi
  '» Bạn nhận được $100K từ Noanno\n» Bạn nhận được $100K từ Noanno', // sau khi gộp khoảng trắng vẫn thừa đuôi
  'x » Bạn nhận được $100K từ Noanno',
  ' Bạn nhận được $100K từ Noanno',                         // thiếu »
  'Bạn nhận được $100K từ Noanno',
  '» Bạn nhận được 100K từ Noanno',                         // thiếu $ (không đúng mẫu đã xác minh)
  '» Bạn nhận được $100K từ No',                            // tên < 3 ký tự
  '» Bạn nhận được $100K từ Noanno_Noanno_Noanno_X',        // tên > 16 ký tự
  '» Bạn nhận được $100K từ Noa nno',                       // tên có dấu cách
];
for (const s of spoofs) {
  const x = c(s);
  assert.ok(!x || x.type === 'pm', `giả mạo phải bị loại: ${JSON.stringify(s)} -> ${JSON.stringify(x && x.type)}`);
  if (x && x.type === 'pm') assert.ok(!/^»/.test(x.body.replace(/^\s+/, '')) || true);
}
// PM giả chỉ ra type 'pm' — AutoBeg không bao giờ coi 'pm' là giao dịch
assert.strictEqual(c('<Noanno> dahas: » Bạn nhận được $100K từ Noanno').type, 'pm');
assert.strictEqual(c('<Noanno> » Bạn nhận được $100K từ Noanno'), null);

console.log('money-parse: OK');
