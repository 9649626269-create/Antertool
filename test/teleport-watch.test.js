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
console.log('teleport-watch OK');
