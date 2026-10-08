'use strict';
// Bán lồng lỗi -> gõ /home treolong -> bán lại; lặp tối đa N lần (mặc định 10); vẫn lỗi thì báo webhook + tag người nhận.
// Chạy với mineflayer/vec3 giả (không cần cài thư viện, không cần server).
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');

class Vec3 {
  constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
  offset(a, b, c) { return new Vec3(this.x + a, this.y + b, this.z + c); }
  minus(o) { return new Vec3(this.x - o.x, this.y - o.y, this.z - o.z); }
  clone() { return new Vec3(this.x, this.y, this.z); }
  distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); }
}
const V = (x, y, z) => new Vec3(x, y, z);
V.Vec3 = Vec3;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return {};
  if (request === 'vec3') return V;
  return origLoad.call(this, request, ...rest);
};
const BotSession = require('../src/core/BotSession');
const { CS } = require('../src/core/constants');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SPAWNER = { x: 3, y: 64, z: 0 };
const key = p => `${p.x},${p.y},${p.z}`;

// startFar: bot đang đứng xa lồng (chunk chưa tải -> bán lỗi); gõ /home thì được đưa về cạnh lồng (healOnHome) hoặc không đổi gì (always fail)
function mkBot({ healOnHome = false, startFar = true, ...cfg } = {}) {
  const chats = [];
  const notified = [];
  const logs = [];
  const bot = new BotSession({
    id: 't', host: 'h', port: 25565, username: 'u', autoSellSpawnRevenue: false,
    spawnHomeWarmupMs: 100, spawnHomeMarginMs: 100, sellHomeChunkWaitMs: 100, ...cfg,
  }, 'teal', null);
  bot.state.connState = CS.ONLINE;
  bot._tp.settleMs = 100;
  bot._notify = (...a) => notified.push(a);
  bot._manager = { notifier: { isEventOn: () => true } };
  bot.on('log', e => logs.push(e.msg));
  bot.sellSpawnList = [{ ...SPAWNER }];

  let loaded = !startFar;
  const sellWin = { title: '{"text":"SHOP"}', inventoryStart: 54, slots: Array.from({ length: 90 }, (_, i) => (i === 51 ? { name: 'emerald', count: 1 } : null)) };
  const mc = new EventEmitter();
  Object.assign(mc, {
    entity: { position: startFar ? V(200, 63, 0) : V(0, 63, 0), yaw: 0, pitch: 0 },
    currentWindow: null,
    blockAt: p => (loaded && key(p) === key(SPAWNER) ? { name: 'spawner', position: V(p.x, p.y, p.z), shapes: [[0, 0, 0, 1, 1, 1]] } : null),
    async look(yaw, pitch) { mc.entity.yaw = yaw; mc.entity.pitch = pitch; },
    setControlState() { }, getControlState: () => false,
    async activateBlock() { setImmediate(() => mc.emit('windowOpen', sellWin)); },
    async clickWindow() { },
    closeWindow() { },
    chat(cmd) {
      chats.push(cmd);
      if (healOnHome) setTimeout(() => { loaded = true; mc.entity.position = V(0, 63, 0); }, 50); // server đưa bot về cạnh lồng
    },
  });
  bot.mc = mc;
  return { bot, mc, chats, notified, logs };
}

(async () => {
  // 1) lần đầu lỗi -> gõ /home treolong 1 lần -> bán lại được -> KHÔNG báo webhook
  {
    const { bot, chats, notified, logs } = mkBot({ healOnHome: true });
    const r = await bot._runSellWithRecovery();
    assert.strictEqual(r.ok, true, 'sau /home phải bán được');
    assert.deepStrictEqual(chats, ['/home treolong']);
    assert.strictEqual(notified.length, 0, 'bán được thì không báo thất bại');
    assert(logs.some(l => l.includes('bán được 1/1 lồng sau khi gõ /home treolong 1 lần')));
    assert.strictEqual(bot._sellRecovering, false);
  }

  // 2) lỗi hoài: gõ /home đúng N lần (N=3 ở test) rồi báo webhook, tag đúng người
  {
    const { bot, chats, notified } = mkBot({ sellFailMaxHome: 3 });
    const r = await bot._runSellWithRecovery();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(chats.length, 3, `phải gõ /home đúng 3 lần, thực tế ${chats.length}`);
    assert(chats.every(c => c === '/home treolong'));
    assert.strictEqual(notified.length, 1, 'phải báo webhook đúng 1 lần');
    const [ev, title, desc, , headline] = notified[0];
    assert.strictEqual(ev, 'sellFailed');
    assert(headline.includes('<@1413104059333873764>'), `headline phải tag người nhận: ${headline}`);
    assert(title.includes('3 lần') && desc.includes('0/1'), `${title} | ${desc}`);
    assert.strictEqual(bot._sellRecovering, false);
  }

  // 3) mặc định tối đa 10 lần
  {
    const { bot } = mkBot();
    assert.strictEqual(bot.sellFailMaxHome, 10);
    assert.strictEqual(bot.sellFailMention, '1413104059333873764');
  }

  // 4) báo thất bại có giãn cách (không spam mỗi chu kỳ) + đổi/tắt tag bằng cấu hình
  {
    const { bot, notified } = mkBot({ sellFailMaxHome: 1, sellFailMention: '@999999999999999999' });
    await bot._runSellWithRecovery();
    await bot._runSellWithRecovery();
    assert.strictEqual(notified.length, 1, 'lần thất bại thứ 2 trong 10 phút không báo lại');
    assert(notified[0][4].includes('<@999999999999999999>'));
    const b2 = mkBot({ sellFailMaxHome: 1, sellFailMention: 'off' });
    await b2.bot._runSellWithRecovery();
    assert(!b2.notified[0][4].includes('<@'), 'mention=off thì không tag');
  }

  // 5) bị ngắt giữa chừng (bảo vệ lồng/tắt autosell) -> dừng thử lại, không báo thất bại
  {
    const { bot, mc, chats, notified } = mkBot({ sellFailMaxHome: 5 });
    const origChat = mc.chat;
    mc.chat = c => { origChat(c); bot._sellSpawnAbort = true; };
    const r = await bot._runSellWithRecovery();
    assert.strictEqual(chats.length, 1, 'bị ngắt thì không gõ /home thêm');
    assert.strictEqual(r.aborted, true);
    assert.strictEqual(notified.length, 0);
    assert.strictEqual(bot._sellRecovering, false);
  }

  // 6) sellFailMaxHome = 0 -> tắt hẳn chuỗi thử lại (hành vi cũ)
  {
    const { bot, chats, notified } = mkBot({ sellFailMaxHome: 0 });
    const r = await bot._runSellWithRecovery();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(chats.length, 0);
    assert.strictEqual(notified.length, 0);
  }

  // 7) đang trong chuỗi thử lại: canh-vị-trí/AFK không được chen vào
  {
    const { bot } = mkBot({ healOnHome: true });
    const p = bot._runSellWithRecovery();
    await sleep(50);
    assert.strictEqual(bot._isBusy, true);
    assert.strictEqual(bot._afkPaused(), true);
    assert.strictEqual(bot.runSellSpawnNow(), false, 'không cho chạy chồng khi đang thử lại');
    await p;
    assert.strictEqual(bot._isBusy, false);
  }

  console.log('sell-recovery.test OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
