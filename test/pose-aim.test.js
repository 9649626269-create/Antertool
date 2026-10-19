'use strict';
// Xoay về lồng theo TƯ THẾ THẬT của bot (đứng/ngồi/bò) + chờ cơ thể ổn định (đang nhảy/rơi/trượt, server chưa cập nhật tư thế).
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
const { anglesTo } = require('../src/core/VectorUtil');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = p => `${p.x},${p.y},${p.z}`;
const FULL = [[0, 0, 0, 1, 1, 1]];
const SPAWNER = { x: 2, y: 64, z: 0 };

function mkBot({ entity = {}, sneak = false, extraBlocks = [] } = {}) {
  const logs = [];
  const looks = [];
  const bot = new BotSession({ id: 't', host: 'h', port: 25565, username: 'u', autoSellSpawnRevenue: false, spawnerRequireSilk: false }, 'teal', null);
  bot.state.connState = CS.ONLINE;
  bot._notify = () => { };
  bot.on('log', e => logs.push(e.msg));
  const world = new Map([[key(SPAWNER), 'spawner'], ...extraBlocks]);
  const mc = new EventEmitter();
  const ctl = { sneak };
  Object.assign(mc, {
    version: '1.21.1',
    entity: { position: V(0.5, 64, 0.5), yaw: 0, pitch: 0, ...entity },
    blockAt: p => (world.has(key(p)) ? { name: world.get(key(p)), position: V(p.x, p.y, p.z), shapes: FULL } : null),
    async look(yaw, pitch) { mc.entity.yaw = yaw; mc.entity.pitch = pitch; looks.push({ yaw, pitch, at: Date.now() }); },
    getControlState: k => !!ctl[k],
    setControlState(k, v) { ctl[k] = v; },
    closeWindow() { },
  });
  bot.mc = mc;
  return { bot, mc, logs, looks, world, ctl };
}
const eyeOf = (mc, h) => ({ x: mc.entity.position.x, y: mc.entity.position.y + h, z: mc.entity.position.z });
const center = { x: SPAWNER.x + 0.5, y: SPAWNER.y + 0.5, z: SPAWNER.z + 0.5 };

(async () => {
  // 1) đứng: mắt 1.62 (như cũ)
  {
    const { bot, mc, looks } = mkBot();
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    const a = anglesTo(eyeOf(mc, 1.62), center);
    assert.ok(Math.abs(looks.at(-1).pitch - a.pitch) < 1e-9 && Math.abs(looks.at(-1).yaw - a.yaw) < 1e-9);
    assert.strictEqual(bot._lastBody.key, 'standing');
  }

  // 2) server báo đang ngồi (metadata[6]=5): góc tính theo mắt 1.27
  {
    const { bot, mc, looks } = mkBot({ entity: { metadata: { 6: 5 }, onGround: true }, sneak: true });
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    const a = anglesTo(eyeOf(mc, 1.27), center);
    assert.ok(Math.abs(looks.at(-1).pitch - a.pitch) < 1e-9, 'pitch phải tính theo mắt lúc ngồi');
    assert.strictEqual(bot._lastBody.key, 'crouching');
  }

  // 3) server báo đang bò (metadata[6]=3): mắt 0.4; tính như đứng thì sẽ trượt lồng
  {
    const { bot, mc, looks } = mkBot({ entity: { metadata: { 6: 3 }, onGround: true } });
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    const a = anglesTo(eyeOf(mc, 0.4), center);
    assert.ok(Math.abs(looks.at(-1).pitch - a.pitch) < 1e-9);
    const wrong = anglesTo(eyeOf(mc, 1.62), center);
    assert.ok(Math.abs(looks.at(-1).pitch - wrong.pitch) > 0.3, 'phải khác hẳn góc tính theo tư thế đứng');
  }

  // 4) khe thấp sát trần (metadata còn báo đứng): tự kẹp theo trần -> bò, không bị "bedrock che"
  {
    const { bot, mc } = mkBot({ entity: { metadata: { 6: 0 }, onGround: true }, extraBlocks: [[key({ x: 0, y: 65, z: 0 }), 'bedrock']] });
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    assert.strictEqual(bot._lastBody.key, 'swimming');
    assert.strictEqual(bot._lastBody.source, 'ceiling');
  }

  // 5) đang nhảy: chờ đáp đất rồi mới tính góc (tính lúc đang lơ lửng là lệch cả block)
  {
    const { bot, mc, looks } = mkBot({ entity: { onGround: false, position: V(0.5, 64.9, 0.5) } });
    setTimeout(() => { mc.entity.position = V(0.5, 64, 0.5); mc.entity.onGround = true; }, 250);
    const t0 = Date.now();
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    assert.ok(looks[0].at - t0 >= 200, `phải chờ đáp đất trước khi xoay (xoay sau ${looks[0].at - t0}ms)`);
    const a = anglesTo({ x: 0.5, y: 64 + 1.62, z: 0.5 }, center);
    assert.ok(Math.abs(looks[0].pitch - a.pitch) < 1e-9, 'góc phải tính theo chỗ ĐÁP ĐẤT, không phải lúc lơ lửng');
  }

  // 6) vừa bấm shift nhưng server chưa cập nhật tư thế: chờ metadata rồi mới tính
  {
    const { bot, mc, looks } = mkBot({ entity: { metadata: { 6: 0 }, onGround: true }, sneak: true });
    setTimeout(() => { mc.entity.metadata = { 6: 5 }; }, 200);
    const t0 = Date.now();
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), true);
    assert.ok(looks[0].at - t0 >= 150, 'phải chờ server báo tư thế ngồi');
    const a = anglesTo(eyeOf(mc, 1.27), center);
    assert.ok(Math.abs(looks[0].pitch - a.pitch) < 1e-9, 'góc theo mắt ngồi 1.27');
  }

  // 7) đang trượt sau khi thả phím đi: chờ đứng yên
  {
    const { bot, mc, looks } = mkBot({ entity: { onGround: true, velocity: { x: 0.15, y: 0, z: 0 } } });
    setTimeout(() => { mc.entity.velocity = { x: 0, y: -0.0784, z: 0 }; }, 200);
    const t0 = Date.now();
    await bot._faceBlock(mc, SPAWNER);
    assert.ok(looks[0].at - t0 >= 150, 'phải chờ hết trượt');
  }

  // 8) không ổn định mãi (băng chuyền/dòng nước đẩy): hết giờ chờ thì vẫn xoay, không treo
  {
    const { bot, mc, looks } = mkBot({ entity: { onGround: true, velocity: { x: 0.2, y: 0, z: 0 } } });
    const t0 = Date.now();
    const ok = await bot._faceBlock(mc, SPAWNER);
    assert.ok(Date.now() - t0 < 2500, 'không được chờ vô hạn');
    assert.ok(looks.length >= 1, 'vẫn phải xoay');
    assert.strictEqual(typeof ok, 'boolean');
  }

  // 9) dừng giữa chừng khi đang chờ ổn định -> không xoay
  {
    const { bot, mc, looks } = mkBot({ entity: { onGround: false } });
    let stopNow = false;
    setTimeout(() => { stopNow = true; }, 150);
    const ok = await bot._faceBlock(mc, SPAWNER, { stop: () => stopNow });
    assert.strictEqual(ok, false);
    assert.strictEqual(looks.length, 0);
  }

  // 10) _aimWhy kèm tư thế khi trượt; log "đã chỉnh góc nhìn" kèm tư thế
  {
    const { bot, mc, world } = mkBot({ entity: { metadata: { 6: 5 }, onGround: true } });
    world.set(key({ x: 1, y: 64, z: 0 }), 'stone');
    assert.strictEqual(await bot._faceBlock(mc, SPAWNER), false);
    const why = bot._aimWhy();
    assert.ok(why.includes('stone') && why.includes('tư thế ngồi (shift)'), why);
  }
  {
    const { bot, mc, logs } = mkBot({ entity: { metadata: { 6: 5 }, onGround: true } });
    bot.sellSpawnList = [{ ...SPAWNER }];
    assert.strictEqual(await bot._alignViewToSellSpawn(mc), true);
    assert.ok(logs.some(l => l.includes('đã chỉnh góc nhìn về lồng') && l.includes('ngồi (shift)') && l.includes('1.27')), logs.join(' | '));
  }

  // 11) AFK đang giữ shift (sắp tự nhả): nhả luôn trước khi nhắm — không để nó đổi tư thế giữa lúc nhắm
  {
    const { bot, mc, ctl } = mkBot();
    ctl.sneak = true;
    bot._setTimer('afkSneak', () => { ctl.sneak = false; }, 5000);
    bot._releaseAfkKeys();
    assert.strictEqual(ctl.sneak, false);
    assert.strictEqual(bot._timers.has('afkSneak'), false);
    await bot._faceBlock(mc, SPAWNER);
    assert.strictEqual(bot._lastBody.key, 'standing');
  }
  // ...nhưng shift CÓ CHỦ ĐÍCH của routine đập lồng thì giữ nguyên
  {
    const { bot, ctl } = mkBot();
    ctl.sneak = true;
    bot._spawnerBusy = true;
    bot._setTimer('afkSneak', () => { ctl.sneak = false; }, 5000);
    bot._releaseAfkKeys();
    assert.strictEqual(ctl.sneak, true, 'đang đập lồng: shift phải giữ');
    bot._clearTimer('afkSneak');
  }
  // shift do người dùng/routine giữ (không có timer AFK) không bị nhả
  {
    const { bot, ctl } = mkBot();
    ctl.sneak = true;
    bot._releaseAfkKeys();
    assert.strictEqual(ctl.sneak, true);
  }

  console.log('pose-aim.test OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
