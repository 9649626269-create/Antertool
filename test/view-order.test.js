'use strict';
// Thứ tự "nhìn rồi mới làm":
//  - autosell_spawn: BẬT -> chỉnh góc nhìn về lồng NGAY; mỗi lồng: nhìn vào lồng (+ kiểm tra tia ngắm) -> chuột phải -> click ô
//  - spawnerprotect: nhìn vào lồng -> đào -> nhìn vào ender chest -> mở rương -> bỏ lồng vào
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

const SPAWNER = { x: 1, y: 64, z: 0 };
const CHEST = { x: 3, y: 64, z: 0 };
const key = p => `${p.x},${p.y},${p.z}`;

function mkBot(cfg = {}) {
  const events = [];
  const logs = [];
  const bot = new BotSession({ id: 't', host: 'h', port: 25565, username: 'u', autoSellSpawnRevenue: false, spawnerRequireSilk: false, ...cfg }, 'teal', null);
  bot.state.connState = CS.ONLINE;
  bot._notify = () => { };
  bot.on('log', e => logs.push(e.msg));

  const world = new Map([[key(SPAWNER), 'spawner'], [key(CHEST), 'ender_chest']]);
  const invItems = [];
  const sellWin = { title: '{"text":"SHOP"}', inventoryStart: 54, slots: Array.from({ length: 90 }, (_, i) => (i === 51 ? { name: 'emerald', count: 1 } : null)) };
  const mc = new EventEmitter();
  let aim = null;
  Object.assign(mc, {
    entity: { position: V(0, 63, 0), yaw: 0, pitch: 0 },
    registry: { blocksByName: { spawner: { id: 1 }, ender_chest: { id: 2 } } },
    currentWindow: null,
    heldItem: { name: 'diamond_pickaxe' },
    cursorOverride: null, // đặt = block bất kỳ để giả lập "tia ngắm bị block khác che"
    inventory: { items: () => invItems },
    blockAt: p => (world.has(key(p)) ? { name: world.get(key(p)), position: V(p.x, p.y, p.z) } : null),
    blockAtCursor() {
      if (mc.cursorOverride) return mc.cursorOverride;
      return aim && world.has(key(aim)) ? { name: world.get(key(aim)), position: V(aim.x, aim.y, aim.z) } : null;
    },
    async lookAt(pt) { aim = { x: Math.floor(pt.x), y: Math.floor(pt.y), z: Math.floor(pt.z) }; events.push(`look ${key(aim)}`); },
    async equip() { }, setControlState() { }, getControlState: () => false, stopDigging() { }, canDigBlock: () => true,
    async dig(b) { events.push(`dig ${key(b.position)}`); world.set(key(b.position), 'air'); invItems.push({ name: 'spawner', slot: 30, count: 1 }); },
    async activateBlock(b) { events.push(`activate ${key(b.position)}`); setImmediate(() => mc.emit('windowOpen', sellWin)); },
    async clickWindow(slot, btn, mode) { events.push(`click ${slot},${btn},${mode}`); if (mode === 1) invItems.splice(0, invItems.length, ...invItems.filter(i => i.name !== 'spawner')); },
    closeWindow() { }, chat() { },
    findBlock: () => ({ name: 'ender_chest', position: V(CHEST.x, CHEST.y, CHEST.z) }),
    async openContainer(b) {
      events.push(`open ${key(b.position)}`);
      const slots = Array(63).fill(null); // 27 ô rương + 36 ô túi đồ; lồng nằm ở ô 40
      invItems.forEach(it => { if (it.name === 'spawner') slots[40] = it; });
      return { inventoryStart: 27, slots, title: 'Ender Chest' };
    },
  });
  bot.mc = mc;
  return { bot, mc, events, logs };
}
const idx = (events, s) => events.findIndex(e => e.startsWith(s));

(async () => {
  // 1) _faceBlock: tia ngắm trúng -> true (nhìn 1 lần); bị che -> false (thử lại đủ 2 lần)
  {
    const { bot, mc, events } = mkBot();
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    assert.deepStrictEqual(events, ['look 1,64,0']);
    events.length = 0;
    mc.cursorOverride = { name: 'stone', position: V(2, 64, 0) };
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), false);
    assert.deepStrictEqual(events, ['look 1,64,0', 'look 1,64,0']);
    // dừng giữa chừng -> không xoay nữa
    events.length = 0;
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER, { stop: () => true }), false);
    assert.strictEqual(events.length, 0);
  }

  // 2) autosell_spawn BẬT: chỉnh góc nhìn về lồng ngay, CHƯA chuột phải
  {
    const { bot, events, logs } = mkBot();
    bot.sellSpawnList = [{ ...SPAWNER }];
    assert.strictEqual(bot._startSellSpawn(true), true);
    await sleep(700);
    assert.deepStrictEqual(events, ['look 1,64,0'], 'bật xong chỉ xoay đầu, chưa bán');
    assert(logs.some(l => l.includes('đã chỉnh góc nhìn về lồng')), 'phải log đã chỉnh góc nhìn');
    bot._stopSellSpawn();
  }

  // 3) vòng bán: nhìn lồng -> chuột phải -> click ô 51 (đúng thứ tự)
  {
    const { bot, events } = mkBot();
    bot.sellSpawnList = [{ ...SPAWNER }];
    const r = await bot._runSellSpawnCycle();
    assert.deepStrictEqual(r, { done: 1, total: 1 });
    const iLook = idx(events, 'look 1,64,0'), iAct = idx(events, 'activate'), iClick = idx(events, 'click 51');
    assert(iLook >= 0 && iLook < iAct && iAct < iClick, `sai thứ tự: ${events.join(' | ')}`);
  }

  // 4) tia ngắm bị che: vẫn bán như cũ nhưng có cảnh báo
  {
    const { bot, mc, events, logs } = mkBot();
    bot.sellSpawnList = [{ ...SPAWNER }];
    mc.cursorOverride = { name: 'stone', position: V(2, 64, 0) };
    const r = await bot._runSellSpawnCycle();
    assert.strictEqual(r.done, 1);
    assert(idx(events, 'activate') > idx(events, 'look'));
    assert(logs.some(l => l.includes('tia ngắm chưa trúng lồng')));
  }

  // 5) spawnerprotect: nhìn lồng -> đào -> nhìn ender chest -> mở rương -> bỏ lồng vào
  {
    const { bot, events, logs } = mkBot();
    bot.protectedSpawners = [{ ...SPAWNER }];
    bot._spawnerProtectOn = true;
    bot.mc.inventory.items().push({ name: 'diamond_pickaxe', slot: 36, count: 1 });
    await bot._onSpawnerThreat([{ name: 'ke_la', dist: 4 }]);
    const order = ['look 1,64,0', 'dig 1,64,0', 'look 3,64,0', 'open 3,64,0', 'click 40,0,1'].map(s => idx(events, s));
    assert(order.every(i => i >= 0), `thiếu bước: ${events.join(' | ')}`);
    assert.deepStrictEqual(order, [...order].sort((a, b) => a - b), `sai thứ tự: ${events.join(' | ')}`);
    assert(logs.some(l => l.includes('nhìn vào lồng (1,64,0) → đào')));
    assert(logs.some(l => l.includes('nhìn vào ender chest (3,64,0) → mở rương')));
    assert(logs.some(l => l.includes('bỏ 1 stack lồng vào')));
  }

  console.log('view-order.test OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
