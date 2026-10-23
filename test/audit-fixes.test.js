'use strict';
// Test hồi quy cho các lỗi trong báo cáo kiểm toán (BUG-03/04/07/14 + Logic Audit v2).
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return {};
  if (request === 'vec3') return { Vec3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } } };
  return origLoad.call(this, request, ...rest);
};

const { parseShardNum } = require('../src/core/utils');

// BUG-07: số thập phân đi cùng hậu tố k/M không bị nhân 10 lần
assert.strictEqual(parseShardNum('Shard: 1.5k'), 1500);
assert.strictEqual(parseShardNum('Shard: 3.25M'), 3250000);
assert.strictEqual(parseShardNum('Shard: 1,234'), 1234);
assert.strictEqual(parseShardNum('Shard: 12.250.000'), 12250000);
assert.strictEqual(parseShardNum('Shard: 500'), 500);

// BUG-03: StatsParser không được ném lỗi khi slot.type là số
const { StatsParser } = require('../src/core/WindowRouter');
const logs = [];
let stats = null, shardSeen = 0;
const bot = { mc: { entity: null }, state: {}, emit: (ev, d) => { if (ev === 'stats') stats = d; }, _updateShard: n => { shardSeen = n; }, log: (...a) => logs.push(a.join(' ')) };
StatsParser.parse(bot, { slots: [{ type: 388, name: 'emerald', count: 10 }, { type: 999, name: 'amethyst_shard', count: 7 }] });
assert.ok(!logs.some(l => /Lỗi StatsParser/.test(l)), 'StatsParser bị lỗi: ' + logs.join('|'));
assert.ok(stats && stats.money === 10 && stats.shard === 7 && shardSeen === 7, 'StatsParser đọc sai: ' + JSON.stringify(stats));

// BUG-04: proxy dạng user:pass@host:port parse được (autoAdd đổi ip:port:user:pass sang dạng này)
const PM = require('../src/core/ProxyManager');
const pm = new (PM.ProxyManager || PM)();
const p = pm.parse('http://alice:s%40cret@1.2.3.4:8080');
assert.ok(p && p.host === '1.2.3.4' && p.port === 8080 && p.user === 'alice' && p.pass === 's@cret');

// BUG-14: thiếu config.json không làm sập
const Persistence = require('../src/core/Persistence');
const P = Persistence.Persistence || Persistence;
assert.deepStrictEqual(new P(path.join(os.tmpdir(), 'no-such-dir-' + process.pid, 'config.json')).load(), { bots: [] });

// LOGIC-01: CommandRegistry.run gửi trực tiếp custom command lên mc.chat khi bot online
const CommandRegistry = require('../src/core/CommandRegistry');
const chatSent = [];
const mockBot = {
  isOnline: true,
  mc: { chat: (c) => chatSent.push(c) },
  log: () => {},
};
const reg = new CommandRegistry(mockBot);
reg.addCustom('ve', 'home treolong');
assert.strictEqual(reg.run('ve'), 'custom');
assert.deepStrictEqual(chatSent, ['/home treolong']);

// LOGIC-02: AutoOrder.isWorking phân biệt giữa đang chờ item (không khoá GUI/AFK) và đang giao dịch
const AutoOrder = require('../src/core/AutoOrder');
const ao = new AutoOrder({ cfg: {}, log: () => {}, isOnline: true });
ao.running = true;
ao.state = 'chờ item';
assert.strictEqual(ao.active, true);
assert.strictEqual(ao.isWorking, false, 'Đang chờ item không được chặn GUI/AFK');
ao.state = 'tìm đơn';
assert.strictEqual(ao.isWorking, true, 'Đang tìm đơn phải giữ quyền GUI');

// LOGIC-03: BotSession có getProtectStatus(), uỷ quyền TeleportHandler, và _cleanupOnDisconnect xoá cờ busy tránh mâu thuẫn trạng thái
const BotSession = require('../src/core/BotSession');
const BotActivity = require('../src/core/BotActivity');
const sess = new BotSession({ id: 'b1', username: 'Steve', host: 'localhost', port: 25565, spawnerProtectOn: true, protectedSpawners: [{ x: 1, y: 64, z: 1 }] }, { name: 'teal' }, pm);
const protStatus = sess.getProtectStatus();
assert.strictEqual(protStatus.on, true);
assert.strictEqual(protStatus.level, 2);
assert.strictEqual(protStatus.count, 1);

// Giả lập bot bị ngắt kết nối đột ngột giữa vòng bán (_sellSpawnBusy = true)
sess._sellSpawnBusy = true;
sess._sellRecovering = true;
sess._spawnerBusy = true;
sess._cleanupOnDisconnect();
assert.strictEqual(sess._sellSpawnBusy, false);
assert.strictEqual(sess._sellRecovering, false);
assert.strictEqual(sess._spawnerBusy, false);
assert.strictEqual(BotActivity.checkContradictions(sess), null, 'Sau _cleanupOnDisconnect không được còn cờ busy mâu thuẫn với trạng thái offline');

// LOGIC-04: BotManager._onTelegramEvent đấu nối đầy đủ với TelegramControl v2 (cả lệnh v2 và nút p:<bid>:m)
const BotManager = require('../src/services/BotManager');
const TelegramPanel = require('../src/core/TelegramPanel');
(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-audit-'));
  const mgr = new BotManager({ configPath: path.join(tmpDir, 'config.json') });
  await mgr.init();
  const botInst = mgr.createBot({ id: 'bot-1', username: 'Steve', host: 'play.example.vn', port: 25565 });
  assert.strictEqual(botInst.cfg.respawn, true, '_buildBotConfig phải gán mặc định respawn: true cho cả createBot');

  const replies = [];
  await mgr._onTelegramEvent({
    type: 'command',
    cmd: 'whoami',
    arg: '',
    from: { id: 555, first_name: 'Admin' },
    chat: { id: 555, type: 'private' },
    reply: (text, opts) => replies.push({ text, opts }),
  });
  assert.strictEqual(replies.length, 1);
  assert.ok(replies[0].text.includes('555') && replies[0].text.includes('admin'), 'Lệnh /whoami phải hoạt động qua _onTelegramEvent');

  const bid = TelegramPanel.botShortId('bot-1', ['bot-1']);
  let cbAnswered = null;
  let edited = null;
  mgr.telegram.edit = async (msgId, text, opts) => { edited = { msgId, text, opts }; return msgId; };
  await mgr._onTelegramEvent({
    type: 'button',
    cmd: 'p',
    arg: `${bid}:m`,
    data: `p:${bid}:m`,
    messageId: 999,
    from: { id: 555, first_name: 'Admin' },
    chat: { id: 555, type: 'private' },
    answer: (t) => { cbAnswered = t; },
  });
  assert.ok(edited && edited.msgId === 999 && edited.text.includes('Menu điều khiển: bot-1'), 'Nút p:<bid>:m phải mở menu điều khiển bot');
  assert.strictEqual(cbAnswered, 'Menu bot-1');

  mgr.shutdown();
  console.log('audit-fixes OK');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
