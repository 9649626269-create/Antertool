const assert = require('assert');
const TeleportWatch = require('../src/core/TeleportWatch');
const P = (x, y, z) => ({ x, y, z });

// 1) đứng yên -> timeout, không có tin server => selfMoved=false, msgs rỗng
{
  const w = new TeleportWatch({ warmupMs: 5000, marginMs: 3000 });
  w.hold(0, 1000);
  assert.strictEqual(w.frozen(500), true);
  w.begin({ cmd: '/home treolong', pos: P(0, 64, 0), now: 1000 });
  assert.strictEqual(w.frozen(6000), true, 'phải đứng yên suốt lúc đếm ngược');
  assert.strictEqual(w.tick(P(0, 64, 0), 5000), null);
  const ev = w.tick(P(0, 64, 0), 9000);
  assert.strictEqual(ev.type, 'timeout');
  assert.strictEqual(ev.selfMoved, false);
  assert.deepStrictEqual(ev.msgs, []);
  assert.strictEqual(w.active, false);
  assert.strictEqual(w.frozen(9001), false, 'xong thì cho AFK chạy lại');
}
// 2) bot tự đi (xê dịch 1.2 block) -> timeout + selfMoved (teleport bị hủy vì di chuyển)
{
  const w = new TeleportWatch();
  w.begin({ cmd: '/home x', pos: P(0, 64, 0), now: 0 });
  w.note('Teleport bị hủy vì bạn di chuyển', 1000);
  w.note('Teleport bị hủy vì bạn di chuyển', 1500); // trùng -> bỏ
  w.tick(P(1.2, 64, 0), 2000);
  const ev = w.tick(P(0.1, 64, 0), 8500);
  assert.strictEqual(ev.type, 'timeout');
  assert.strictEqual(ev.selfMoved, true);
  assert.strictEqual(ev.msgs.length, 1);
}
// 3) teleport thành công -> arrived, vẫn đứng yên settleMs rồi mới nhả
{
  const w = new TeleportWatch({ settleMs: 2000 });
  w.begin({ cmd: '/home x', pos: P(0, 64, 0), now: 0 });
  const ev = w.tick(P(500, 70, -300), 5200);
  assert.strictEqual(ev.type, 'arrived');
  assert(ev.dist > 100);
  assert.strictEqual(w.frozen(6000), true);
  assert.strictEqual(w.tick(P(500, 70, -300), 7300), null);
  assert.strictEqual(w.active, false);
  assert.strictEqual(w.frozen(7301), false);
}
// 4) cancel (reconnect) -> không bắn timeout giả
{
  const w = new TeleportWatch();
  w.begin({ cmd: '/home x', pos: P(0, 0, 0), now: 0 });
  w.cancel();
  assert.strictEqual(w.tick(P(0, 0, 0), 99999), null);
  assert.strictEqual(w.frozen(1), false);
}
// 5) LỖI THỰC TẾ: đã đứng sẵn ở home -> server đếm ngược rồi báo "Dịch chuyển thành công" nhưng vị trí không đổi
//    => trước đây báo timeout giả "KHÔNG bị dịch chuyển"; nay phải coi là tới nơi (inPlace)
{
  const w = new TeleportWatch({ warmupMs: 5000, marginMs: 3000, settleMs: 2000 });
  w.begin({ cmd: '/home treolong', pos: P(-6902.51, -63, -17574.69), now: 0 });
  w.note('Đang dịch chuyển đến home treolong', 100); // tin ĐẾM NGƯỢC không được tính là xong
  assert.strictEqual(w.tick(P(-6902.51, -63, -17574.69), 4000), null);
  w.note('Dịch chuyển thành công tới home treolong', 5000);
  assert.strictEqual(w.tick(P(-6902.51, -63, -17574.69), 5200), null, 'chờ chút cho gói vị trí mới (nếu có) kịp về');
  const ev = w.tick(P(-6902.51, -63, -17574.69), 6100);
  assert.strictEqual(ev.type, 'arrived');
  assert.strictEqual(ev.inPlace, true);
  assert.deepStrictEqual(ev.msgs, ['Đang dịch chuyển đến home treolong', 'Dịch chuyển thành công tới home treolong']);
  assert.strictEqual(w.frozen(6200), true, 'vẫn đứng yên settleMs sau khi xong');
  assert.strictEqual(w.tick(P(-6902.51, -63, -17574.69), 8200), null);
  assert.strictEqual(w.active, false);
}
// 6) chỉ có tin đếm ngược, KHÔNG có tin thành công + đứng yên -> vẫn là timeout như cũ (không che lỗi thật)
{
  const w = new TeleportWatch();
  w.begin({ cmd: '/home x', pos: P(0, 64, 0), now: 0 });
  w.note('Đang dịch chuyển đến home x', 100);
  w.note('Teleporting to home x...', 200);
  assert.strictEqual(w.tick(P(0, 64, 0), 7000), null);
  const ev = w.tick(P(0, 64, 0), 8500);
  assert.strictEqual(ev.type, 'timeout');
}
// 7) tin thành công nhưng bot cũng tự xê dịch (>= 0.5 block) -> không được coi là teleport tại chỗ
{
  const w = new TeleportWatch();
  w.begin({ cmd: '/home x', pos: P(0, 64, 0), now: 0 });
  w.tick(P(1.0, 64, 0), 1000);
  w.note('Teleport successful', 2000);
  const ev = w.tick(P(0.9, 64, 0), 9000);
  assert.strictEqual(ev.type, 'timeout');
  assert.strictEqual(ev.selfMoved, true);
}
// 8) teleport thật (dịch xa) + có tin thành công -> arrived thường, không có cờ inPlace
{
  const w = new TeleportWatch();
  w.begin({ cmd: '/home x', pos: P(0, 64, 0), now: 0 });
  w.note('Teleported to home x', 4900);
  const ev = w.tick(P(500, 70, -300), 5200);
  assert.strictEqual(ev.type, 'arrived');
  assert.notStrictEqual(ev.inPlace, true);
  assert(ev.dist > 100);
}
// 9) tin thành công đến sát hạn chót (doneAt trong grace) -> vẫn không bị báo timeout giả
{
  const w = new TeleportWatch({ warmupMs: 5000, marginMs: 3000 });
  w.begin({ cmd: '/home x', pos: P(0, 64, 0), now: 0 });
  w.note('Teleport thành công', 7900);
  const ev = w.tick(P(0, 64, 0), 8000);
  assert.strictEqual(ev.type, 'arrived');
  assert.strictEqual(ev.inPlace, true);
}
console.log('teleport-watch OK');
