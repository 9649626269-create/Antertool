'use strict';
const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const BeggarGuard = require('../src/core/BeggarGuard');
const { scoreBegging, findSender } = BeggarGuard;

// ===== chấm điểm: xin xỏ =====
const beg = [
  'cho em xin ít tiền', 'Xin tiền với', 'xin ít tiền đi mọi người', 'em là newbie', 'em mới chơi', 'Em là newbie, cho em xin chút đồ',
  'ai cho em xin ít money', 'xin 100k', 'xin kim cương', 'cho em xin', 'bác nào tặng em ít tiền', 'em nghèo quá cho em xin',
  'give me money pls', 'can i have some diamonds', 'i am new', 'pls give me rank', 'EM LÀ NEWBIE', 'vay em ít tiền', 'xin shard',
  'cho mình xin ít xu', 'Tôi hết tiền rồi',
];
for (const m of beg) assert.ok(scoreBegging(m).score >= 1, 'phải bắt: ' + m);
// KHÔNG phải xin xỏ: chat thường / thông báo hệ thống / chữ "bạn" (ban) / "new" lẻ
const ok = [
  'Bạn đã nhận được 5 shard', 'bán tất cả ở ô 50', 'Server sẽ bảo trì lúc 22:00', 'cho em hỏi cách vào khu afk', 'giúp em với',
  'mình đang farm spawner', 'hello mọi người', 'new update tonight', 'Đã bán 64 Creeper +$ 1.51M', 'xin chào mọi người', 'tiền của bạn: 1.5m',
  'xin lỗi nhé', 'anh bán giá bao nhiêu', 'ai biết /home treolong không',
];
for (const m of ok) assert.strictEqual(scoreBegging(m).score, 0, 'KHÔNG được bắt: ' + m + ' → ' + JSON.stringify(scoreBegging(m).hits));
assert.ok(scoreBegging('cho em xin ít tiền, em là newbie').score >= 3);   // mạnh + yếu cộng điểm

// ===== tìm người gửi =====
const players = ['Steve', 'Alex_01', 'Notch', 'bot_S1'];
const f = (t, re) => findSender(t, players, re);
assert.strictEqual(f('<Steve> cho em xin ít tiền').name, 'Steve');
assert.strictEqual(f('Steve: cho em xin tiền').name, 'Steve');
assert.strictEqual(f('[VIP] Alex_01 » xin tiền').name, 'Alex_01');
assert.strictEqual(f('[Newbie] VIP steve ➤ hi').name, 'Steve');          // không phân biệt hoa/thường, bỏ qua rank
assert.strictEqual(f('[Notch -> me] cho em xin').name, 'Notch');          // tin nhắn riêng
assert.strictEqual(f('Quảng cáo: mua bán rẻ'), null);                      // 'Quảng cáo' không phải người chơi
assert.strictEqual(f('Server thông báo xin tiền'), null);                  // không có dấu phân cách
assert.strictEqual(f('Ghost: xin tiền'), null);                            // không online => không hành động
assert.strictEqual(f('Steve: '), null);                                      // không có nội dung
assert.strictEqual(f('Nội dung lạ ## Alex_01 ## xin tiền', /##\s*(\w+)\s*##/).name, 'Alex_01');   // senderPattern tuỳ chọn

// ===== phiên bot giả =====
function mkSession(cfg = {}, extra = {}) {
  const sent = []; const logs = [];
  const s = {
    cfg: { id: 'bot-1', username: 'bot_S1', ownerUsername: 'Notch', ...cfg },
    isOnline: true, _loginConfirmed: true, autoLogin: { inFlow: false },
    mc: { username: 'bot_S1', players: { Steve: {}, Alex_01: {}, Notch: {}, bot_S1: {}, Friend: {} }, chat: m => sent.push(m) },
    log: (l, m) => logs.push([l, m]),
    _spawnerTrusted: n => String(n).toLowerCase() === 'notch',
    ...extra,
  };
  return { s, sent, logs };
}
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'beg-')), 'beggars.json');
let now = 1_000_000;
const wait = ms => new Promise(r => setTimeout(r, ms));
const fast = { delayMs: 800 };

(async () => {
  // mặc định: BẬT, lệnh /block {player}
  const A = mkSession({ beggarGuard: { ...fast } });
  const g = new BeggarGuard(A.s, { file: tmp, now: () => now });
  assert.strictEqual(g.enabled, true);
  assert.deepStrictEqual(g.o.commands, ['/block {player}']);
  g.onMessage('Steve: cho em xin ít tiền với em là newbie', 'chat');
  g.onMessage('Steve: xin tiền đi mà', 'chat');                  // cùng người, đang chờ => không xếp thêm
  g.onMessage('Notch: cho em xin tiền', 'chat');                  // chủ bot => bỏ qua
  g.onMessage('bot_S1: cho em xin tiền', 'chat');                 // chính bot => bỏ qua
  g.onMessage('Ghost: cho em xin tiền', 'chat');                  // không online => bỏ qua
  g.onMessage('Bạn đã nhận 5 shard', 'system');                   // không phải xin xỏ
  g.onMessage('Steve: cho em xin ít tiền', 'game_info');         // action bar => bỏ qua
  assert.strictEqual(A.sent.length, 0);                           // chưa gõ ngay (chờ delay ngẫu nhiên)
  await wait(1300);
  assert.deepStrictEqual(A.sent, ['/block Steve']);
  assert.ok(A.logs.some(l => l[0] === 'ok' && l[1].includes('Steve')));
  // đã chặn rồi: tuyệt đối không gõ lần hai (nhiều plugin coi lệnh là công tắc)
  now += 3_600_000;
  g.onMessage('Steve: cho em xin tiền', 'chat');
  await wait(1300);
  assert.strictEqual(A.sent.length, 1);
  // lưu file + nạp lại sau khi khởi động lại tool
  const g2 = new BeggarGuard(mkSession({ beggarGuard: fast }).s, { file: tmp });
  assert.deepStrictEqual(g2.list(), ['steve']);
  // mỗi bot có danh sách riêng
  const B = mkSession({ id: 'bot-2', beggarGuard: fast });
  const gB = new BeggarGuard(B.s, { file: tmp });
  assert.deepStrictEqual(gB.list(), []);
  gB.onMessage('Steve: xin tiền', 'chat'); await wait(1300);
  assert.deepStrictEqual(B.sent, ['/block Steve']);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(tmp, 'utf8'))).sort(), ['bot-1', 'bot-2']);
  // forget
  assert.strictEqual(g.forget('STEVE'), true); assert.strictEqual(g.forget('steve'), false);

  // whitelist riêng + chủ bot
  const C = mkSession({ beggarGuard: { ...fast, whitelist: ['Friend'] } });
  const gC = new BeggarGuard(C.s, { file: null });
  gC.onMessage('Friend: cho em xin tiền', 'chat'); await wait(1300);
  assert.strictEqual(C.sent.length, 0);
  assert.strictEqual(gC.evaluate('Friend: cho em xin tiền').reason.includes('được tin'), true);

  // chưa đăng nhập xong / offline => không gõ lệnh
  const D = mkSession({ beggarGuard: fast }, { _loginConfirmed: false });
  const gD = new BeggarGuard(D.s, { file: null });
  gD.onMessage('Alex_01: xin tiền', 'chat'); await wait(1300);
  assert.strictEqual(D.sent.length, 0);

  // đang chạy luồng đăng nhập/antibot => chờ, xong mới chặn
  const E = mkSession({ beggarGuard: fast }); E.s.autoLogin.inFlow = true;
  const gE = new BeggarGuard(E.s, { file: null });
  gE.onMessage('Alex_01: xin tiền', 'chat'); await wait(1300);
  assert.strictEqual(E.sent.length, 0);
  E.s.autoLogin.inFlow = false; await wait(1500);
  assert.deepStrictEqual(E.sent, ['/block Alex_01']); gE.dispose();

  // giới hạn tốc độ: maxPerMinute = 1 => người thứ hai phải chờ
  const F = mkSession({ beggarGuard: { ...fast, maxPerMinute: 1 } });
  const gF = new BeggarGuard(F.s, { file: null });
  gF.onMessage('Steve: xin tiền', 'chat'); gF.onMessage('Alex_01: xin tiền', 'chat'); await wait(1500);
  assert.strictEqual(F.sent.length, 1); gF.dispose();

  // chế độ notify: chỉ ghi log, không gõ lệnh
  const H = mkSession({ beggarGuard: { ...fast, action: 'notify' } });
  const gH = new BeggarGuard(H.s, { file: null });
  gH.onMessage('Steve: xin tiền', 'chat'); await wait(1300);
  assert.strictEqual(H.sent.length, 0); assert.ok(H.logs.some(l => l[1].includes('chỉ thông báo')));

  // tắt: không làm gì; lệnh tuỳ chỉnh & nhiều lệnh; minScore = 2 bỏ qua tin yếu
  const I = mkSession({ beggarGuard: { ...fast, enabled: false } });
  const gI = new BeggarGuard(I.s, { file: null });
  gI.onMessage('Steve: xin tiền', 'chat'); await wait(1300);
  assert.strictEqual(I.sent.length, 0); assert.strictEqual(gI.enabled, false);
  gI.setEnabled(true); assert.strictEqual(gI.enabled, true);
  const J = mkSession({ beggarGuard: { ...fast, commands: ['block {player}', '/mute {player}'], minScore: 2 } });
  const gJ = new BeggarGuard(J.s, { file: null });
  gJ.onMessage('Steve: em là newbie', 'chat'); await wait(1300);      // chỉ 1 điểm => không chặn
  assert.strictEqual(J.sent.length, 0);
  gJ.onMessage('Alex_01: cho em xin tiền', 'chat'); await wait(1300);
  assert.deepStrictEqual(J.sent, ['/block Alex_01', '/mute Alex_01']);

  // extraPatterns tự thêm
  const K = mkSession({ beggarGuard: { ...fast, extraPatterns: ['nhan\\s+qua\\s+mien\\s+phi'] } });
  const gK = new BeggarGuard(K.s, { file: null });
  assert.strictEqual(gK.evaluate('Steve: ai muốn nhận quà miễn phí').beggar, true);

  // lỗi bất ngờ không làm hỏng bot
  const L = mkSession({ beggarGuard: fast }, { mc: null });
  assert.doesNotThrow(() => new BeggarGuard(L.s, { file: null }).onMessage('Steve: xin tiền', 'chat'));
  console.log('beggar-guard.test OK');
})().catch(e => { console.error(e); process.exit(1); });
