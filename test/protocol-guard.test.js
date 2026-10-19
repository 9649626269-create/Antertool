const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs'), os = require('os'), path = require('path');
const ProtocolGuard = require('../src/core/ProtocolGuard');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
const logs = [];
const g = new ProtocolGuard({ botId: 'bot-1', log: (l, m) => logs.push([l, m]), logDir: tmp, skipBadPackets: false }); // test đường cũ (ném lỗi)

const mkDes = () => ({ parsePacketBuffer() { throw new Error('Read error for undefined : array size is abnormally large, not reading: 210986572'); } });
const client = new EventEmitter();
client.state = 'play';
client.deserializer = mkDes();
const mc = { _client: client, version: '1.21.1', registry: {
  version: { version: 767, minecraftVersion: '1.21.1' },
  protocol: { play: { toClient: { types: { packet: ['container', [{ name: 'name', type: ['mapper', { type: 'varint', mappings: { '0x0e': 'tab_complete', '0x2b': 'window_items' } }] }]] } } } } } };
g.attach(mc);

// 1) gói lỗi id 0x2b -> phải nhận ra tên
try { client.deserializer.parsePacketBuffer(Buffer.from([0x2b, 1, 2, 3])); } catch (e) { assert(/abnormally/.test(e.message)); }
assert.strictEqual(g.handleError(new Error('Parse error for play.toClient: Read error for undefined : array size is abnormally large, not reading: 210986572')), true);
assert(/play\.window_items/.test(logs[0][1]), logs[0][1]);
assert.strictEqual(logs[0][0], 'warn');

// 2) lỗi lặp cùng gói -> không spam
for (let i = 0; i < 10; i++) {
  try { client.deserializer.parsePacketBuffer(Buffer.from([0x2b, 9])); } catch {}
  g.handleError(new Error('Parse error for play.toClient: x array size is abnormally large'));
}
assert.strictEqual(logs.length, 1, 'không được log lặp trong 60s: ' + logs.length);

// 3) dồn dập -> đúng 1 cảnh báo lệch phiên bản
for (let i = 0; i < 30; i++) g.handleError(new Error('Deserialization error for play.toClient : array size is abnormally large'));
const floods = logs.filter(l => l[0] === 'err');
assert.strictEqual(floods.length, 1);
assert(/npm i mineflayer@latest/.test(floods[0][1]));

// 4) lỗi không phải parse -> false
assert.strictEqual(g.handleError(new Error('read ECONNRESET')), false);
assert.strictEqual(g.handleError('Disconnected'), false);

// 5) đổi state -> deserializer mới được hook lại
const d2 = mkDes();
client.deserializer = d2;
client.state = 'play';
client.emit('state', 'play', 'configuration');
assert.strictEqual(d2.__protocolGuard, true);

// 6) PartialReadError không bị ghi nhớ
const d3 = { parsePacketBuffer() { const e = new Error('partial'); e.partialReadError = true; throw e; } };
client.deserializer = d3; client.emit('state');
g._last = null;
try { d3.parsePacketBuffer(Buffer.from([0x0e])); } catch {}
assert.strictEqual(g._last, null);

// 7) file log có JSON hợp lệ, có hex
setTimeout(() => {
  const f = path.join(tmp, 'protocol-errors.log');
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
  assert(lines.length >= 1 && lines.length <= 6, 'lines=' + lines.length);
  assert.strictEqual(lines[0].key, 'play.window_items');
  assert.strictEqual(lines[0].hexHead, '2b010203');
  assert.strictEqual(lines[0].mcVersion, '1.21.1');
  // 8) detach gỡ listener
  g.detach();
  assert.strictEqual(client.listenerCount('state'), 0);
  // 9) varint nhiều byte & buffer rỗng
  const { readVarInt } = ProtocolGuard;
  assert.deepStrictEqual(readVarInt(Buffer.from([0xac, 0x02])), { value: 300, size: 2 });
  assert.strictEqual(readVarInt(Buffer.alloc(0)), null);
  assert.strictEqual(readVarInt(Buffer.from([0x80, 0x80])), null);
  // 10) attach với mc không có _client không ném lỗi
  g.attach({}); g.attach(null);
  console.log('ALL ProtocolGuard TESTS PASSED');
}, 100);

// ===== 5) Mô phỏng FullPacketParser của minecraft-protocol: lỗi parse -> cb(err) -> luồng bị huỷ (bot điếc) =====
const { Transform } = require('stream');
class FakeFullPacketParser extends Transform {
  constructor() { super({ readableObjectMode: true }); }
  parsePacketBuffer(buf) {
    if (buf[0] === 0x77) throw new Error('Read error for undefined : array size is abnormally large, not reading: 210986572');
    return { data: { name: 'ok_' + buf[0], params: {} }, metadata: { name: 'ok_' + buf[0], size: buf.length }, buffer: buf, fullBuffer: buf };
  }
  _transform(chunk, enc, cb) {
    let packet;
    try { packet = this.parsePacketBuffer(chunk); } catch (e) { if (e.partialReadError) return cb(); return cb(e); }
    this.push(packet); cb();
  }
}
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pg2-'));
const run = (skip, label) => new Promise(resolve => {
  const glogs = [];
  const guard = new ProtocolGuard({ botId: 'b', log: (l, m) => glogs.push([l, m]), logDir: tmp2, skipBadPackets: skip, onDead: () => glogs.push(['dead-cb', '']) });
  const des = new FakeFullPacketParser();
  const cl = new EventEmitter(); cl.state = 'play'; cl.deserializer = des;
  const got = [];
  des.on('data', p => got.push(p.data.name));
  des.on('error', () => { /* client.js phát lại thành sự kiện 'error' của mc */ });
  guard.attach({ _client: cl, version: '1.21.1', registry: {} });
  des.write(Buffer.from([0x01])); des.write(Buffer.from([0x77, 1, 2, 3])); des.write(Buffer.from([0x02])); des.write(Buffer.from([0x03]));
  if (!skip) setImmediate(() => guard.handleError(new Error('Parse error for play.toClient: array size is abnormally large')));
  setTimeout(() => resolve({ got, glogs, guard, des, label }), 30);
});
(async () => {
  // 5a) KHÔNG bỏ qua: sau gói lỗi luồng chết, gói 0x02/0x03 không bao giờ tới nơi — đúng triệu chứng "client timed out"
  const a = await run(false);
  assert.deepStrictEqual(a.got, ['ok_1'], 'đường cũ: các gói sau gói lỗi bị mất');
  assert.strictEqual(a.des.destroyed, true);
  assert(a.glogs.some(l => l[0] === 'dead-cb'), 'phải báo luồng đã chết để reconnect ngay');
  assert(a.glogs.some(l => l[0] === 'err' && /bị huỷ/.test(l[1])));
  // 5b) BỎ QUA gói lỗi: luồng sống, gói sau vẫn tới, có gói giả 'unparsed_packet'
  const b = await run(true);
  assert.deepStrictEqual(b.got, ['ok_1', 'unparsed_packet', 'ok_2', 'ok_3']);
  assert.strictEqual(b.des.destroyed, false);
  assert.strictEqual(b.guard.skipped, 1);
  assert(!b.glogs.some(l => l[0] === 'dead-cb' || l[0] === 'err'));
  assert(/BỎ QUA riêng gói này/.test(b.glogs[0][1]), b.glogs[0][1]);
  // 5c) gói lỗi lặp 50 lần vẫn không spam log và luồng vẫn sống
  const c = await run(true);
  for (let i = 0; i < 50; i++) c.des.write(Buffer.from([0x77, i]));
  c.des.write(Buffer.from([0x09]));
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(c.des.destroyed, false);
  assert.strictEqual(c.got[c.got.length - 1], 'ok_9');
  assert.strictEqual(c.glogs.filter(l => l[0] === 'warn').length, 1);
  console.log('ProtocolGuard SKIP-MODE TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
