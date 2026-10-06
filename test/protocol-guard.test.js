const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs'), os = require('os'), path = require('path');
const ProtocolGuard = require('../src/core/ProtocolGuard');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
const logs = [];
const g = new ProtocolGuard({ botId: 'bot-1', log: (l, m) => logs.push([l, m]), logDir: tmp });

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
