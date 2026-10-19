'use strict';
// Spawner Protect: cường độ (4 mức + chỉnh tay), phát hiện (đào bề mặt/TNT/wither/đập block), xác minh cất đồ trước khi thoát.
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
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return {};
  if (request === 'vec3') return V;
  if (request === 'express') { const f = () => ({}); f.static = () => (() => { }); f.json = () => (() => { }); return f; }
  return origLoad.call(this, request, ...rest);
};
const SG = require('../src/core/SpawnerGuard');
const BotSession = require('../src/core/BotSession');
const { CS } = require('../src/core/constants');
const { anglesTo } = require('../src/core/AimUtil');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const key = p => `${p.x},${p.y},${p.z}`;

// ---------- 1) bảng mức & chỉnh tay ----------
{
  const lv = SG.LEVELS;
  assert.deepStrictEqual(Object.keys(lv), ['1', '2', '3', '4']);
  for (const n of [1, 2, 3, 4]) for (const k of SG.KEYS) assert.notStrictEqual(lv[n].s[k], undefined, `mức ${n} thiếu ${k}`);
  // càng cao càng mạnh: quét xa hơn, nhịp nhanh hơn, vùng nguy hiểm rộng hơn
  for (const n of [1, 2, 3]) {
    assert(lv[n + 1].s.range > lv[n].s.range);
    assert(lv[n + 1].s.scanTicks < lv[n].s.scanTicks);
    assert(lv[n + 1].s.threatRadius > lv[n].s.threatRadius);
  }
  assert.strictEqual(lv[1].s.autoMine, false, 'mức 1 chỉ cảnh báo');
  assert.strictEqual(lv[2].s.autoMine, true);
  assert.strictEqual(SG.clampLevel(9), 2); assert.strictEqual(SG.clampLevel('3'), 3);
  assert.strictEqual(SG.coerce('range', 9999), 128); assert.strictEqual(SG.coerce('range', 'abc'), undefined);
  assert.strictEqual(SG.coerce('wither', 'off'), false); assert.strictEqual(SG.coerce('wither', 'zzz'), undefined);
  const eff = SG.resolveSettings(3, { range: 50, bogus: 1, scanTicks: 'x' });
  assert.strictEqual(eff.range, 50); assert.strictEqual(eff.scanTicks, lv[3].s.scanTicks); assert(!('bogus' in eff));
  // khoá trùng preset không bị "ghim"
  assert.deepStrictEqual(SG.diffFromPreset(2, { ...lv[2].s, range: 20, wither: false }), { wither: false });
}

// ---------- 2) hàm thuần ----------
{
  const dp = new SG.DigPattern();
  assert.strictEqual(dp.removed(5, 70, 5, 1000, 2), false);
  assert.strictEqual(dp.removed(5, 69, 5, 1500, 2), true, '2 block liên tiếp xuống dưới');
  const d2 = new SG.DigPattern();
  assert.strictEqual(d2.removed(5, 70, 5, 0, 2), false);
  assert.strictEqual(d2.removed(5, 68, 5, 100, 2), false, 'nhảy cách 2 block không phải đào liên tiếp');
  assert.strictEqual(d2.removed(5, 67, 5, 200, 2), true);
  const d3 = new SG.DigPattern();
  d3.removed(1, 70, 1, 0, 2);
  assert.strictEqual(d3.removed(1, 69, 1, 6000, 2), false, 'quá 5s thì quên');
  assert.strictEqual(new SG.DigPattern().removed(1, 1, 1, 0, 1), true, 'ngưỡng 1 = nhạy nhất');

  assert(SG.isDigEligible({ name: 'stone', boundingBox: 'block' }));
  for (const n of ['oak_leaves', 'sand', 'red_sand', 'gravel', 'water', 'air', 'white_concrete_powder', 'anvil'])
    assert(!SG.isDigEligible({ name: n, boundingBox: 'block' }), n);
  assert(!SG.isDigEligible({ name: 'short_grass', boundingBox: 'empty' }));

  assert.strictEqual(SG.threatLabel('tnt', { explosive: false }), null);
  assert.strictEqual(SG.threatLabel('tnt', { explosive: true }), 'TNT đã châm');
  assert.strictEqual(SG.threatLabel('tnt_cart', { explosive: true, tntCarts: false }), null);
  assert.strictEqual(SG.threatLabel('tnt_cart', { explosive: true, tntCarts: true }), 'TNT minecart');
  assert.strictEqual(SG.threatLabel('wither', { wither: true }), 'Wither');
  assert.strictEqual(SG.threatLabel('skull', { wither: true, charged: true }), 'sọ wither xanh');
  assert.strictEqual(SG.entityKind('wither_skull'), 'skull'); assert.strictEqual(SG.entityKind('zombie'), null);

  assert.strictEqual(SG.threatDistance(3, 100, 4, true), 5, 'ngang bỏ qua độ cao');
  assert.strictEqual(SG.threatDistance(3, 4, 0, false), 5);
  assert(SG.insideRange(10, 8, 3)); assert(!SG.insideRange(12, 8, 3)); assert(!SG.insideRange(NaN, 8, 3));

  assert(SG.depositVerified({ snapshot: true, chestCount: 5, expectedChest: 5, playerCount: 0 }));
  assert(!SG.depositVerified({ snapshot: true, chestCount: 4, expectedChest: 5, playerCount: 0 }));
  assert(!SG.depositVerified({ snapshot: true, chestCount: 5, expectedChest: 5, playerCount: 1 }));
  assert(!SG.depositVerified({ snapshot: false, chestCount: 5, expectedChest: 5, playerCount: 0 }));
  const base = { stored: true, carried: 0, ground: 0, remaining: 0, failed: false };
  assert(SG.mayLogout(base));
  for (const bad of [{ stored: false }, { carried: 1 }, { ground: 1 }, { remaining: 1 }, { failed: true }])
    assert(!SG.mayLogout({ ...base, ...bad }), JSON.stringify(bad));
}

// ---------- 3) BotSession: mức, chỉnh tay, lưu/nạp ----------
const SPAWNER = { x: 3, y: 64, z: 0 };
const CHEST = { x: 3, y: 64, z: 2 };
function mkBot(cfg = {}, { chestKeeps = true } = {}) {
  const events = [], logs = [];
  const bot = new BotSession({ id: 't', host: 'h', port: 25565, username: 'u', autoSellSpawnRevenue: false, spawnerRequireSilk: false, ...cfg }, 'teal', null);
  bot.state.connState = CS.ONLINE;
  bot._notify = () => { };
  bot.on('log', e => logs.push(e.msg));
  const world = new Map([[key(SPAWNER), 'spawner'], [key(CHEST), 'ender_chest']]);
  const invItems = [];
  const chestStore = { count: 0 };
  const FULL = [[0, 0, 0, 1, 1, 1]];
  const mc = new EventEmitter();
  Object.assign(mc, {
    entity: { position: V(0, 63, 0), yaw: 0, pitch: 0 },
    entities: {}, players: {},
    registry: { blocksByName: { spawner: { id: 1 }, ender_chest: { id: 2 } } },
    currentWindow: null, heldItem: { name: 'diamond_pickaxe' },
    inventory: { items: () => invItems },
    blockAt: p => (world.has(key(p)) ? { name: world.get(key(p)), position: V(p.x, p.y, p.z), shapes: FULL } : null),
    async look(yaw, pitch) {
      mc.entity.yaw = yaw; mc.entity.pitch = pitch;
      const eye = { x: 0, y: 63 + 1.62, z: 0 };
      for (const k of world.keys()) {
        const [x, y, z] = k.split(',').map(Number);
        const a = anglesTo(eye, { x: x + 0.5, y: y + 0.5, z: z + 0.5 });
        if (Math.abs(a.yaw - yaw) < 1e-6 && Math.abs(a.pitch - pitch) < 1e-6) { events.push(`look ${k}`); return; }
      }
      events.push('look ?');
    },
    async equip() { }, setControlState(n, v) { events.push(`${n}=${v}`); }, getControlState: () => false, stopDigging() { }, canDigBlock: () => true,
    async dig(b) { events.push(`dig ${key(b.position)}`); world.set(key(b.position), 'air'); invItems.push({ name: 'spawner', slot: 30, count: 1 }); },
    async clickWindow(slot, btn, mode) {
      events.push(`click ${slot},${btn},${mode}`);
      if (mode === 1) { if (chestKeeps) chestStore.count += invItems.filter(i => i.name === 'spawner').reduce((n, i) => n + i.count, 0); invItems.splice(0, invItems.length, ...invItems.filter(i => i.name !== 'spawner')); }
    },
    closeWindow() { }, chat() { },
    findBlock: () => ({ name: 'ender_chest', position: V(CHEST.x, CHEST.y, CHEST.z) }),
    async openContainer(b) {
      events.push(`open ${key(b.position)}`);
      const slots = Array(63).fill(null);
      invItems.forEach(it => { if (it.name === 'spawner') slots[40] = it; });
      if (chestStore.count) slots[0] = { name: 'spawner', count: chestStore.count };
      return { inventoryStart: 27, slots, title: 'Ender Chest' };
    },
  });
  bot.mc = mc;
  bot.protectedSpawners = [{ ...SPAWNER }];
  bot._spawnerProtectOn = true;
  bot._spawnerZone = 'in'; bot._spawnerArmedSince = 1; // đã đứng cạnh lồng đủ lâu
  return { bot, mc, events, logs, world, invItems, chestStore };
}

{
  const { bot } = mkBot();
  assert.strictEqual(bot.spawnerLevel, 2, 'mặc định mức 2');
  assert.strictEqual(bot.spawnerProtectRange, 20); assert.strictEqual(bot.spawnerAutoMine, true);
  bot.setSpawnerLevel(4);
  assert.strictEqual(bot.spawnerProtectRange, 48); assert.strictEqual(bot._sp.digThreshold, 1); assert.strictEqual(bot._spTickMs(), 50);
  assert.strictEqual(bot.cfg.spawnerProtectLevel, 4, 'lưu vào cfg để ghi config.json');
  bot.setSpawnerTune({ range: 60, wither: false });
  assert.deepStrictEqual(bot.cfg.spawnerProtectTune, { range: 60, wither: false });
  bot.setSpawnerTune({ range: 'auto' });
  assert.deepStrictEqual(bot.cfg.spawnerProtectTune, { wither: false }, 'auto = bỏ chỉnh tay');
  bot.setSpawnerLevel(1);
  assert.deepStrictEqual(bot._spTune, {}, 'đổi mức xoá chỉnh tay');
  assert.strictEqual(bot._sp.autoMine, false);
  bot.setSpawnerTune({ range: 999 }); assert.strictEqual(bot._sp.range, 128, 'kẹp trong giới hạn');
  // đổi mức khi đang chạy -> timer đổi nhịp quét
  bot._startSpawnerProtect(); // không có blockAt spawner gần -> vẫn bật vì protectedSpawners có sẵn
  bot.setSpawnerLevel(3);
  assert.strictEqual(bot._timers.get('spawnerProtect').repeat, true);
  bot._stopSpawnerProtect();
  // nạp lại từ config đã lưu
  const again = new BotSession({ id: 't2', host: 'h', port: 1, username: 'u', spawnerProtectLevel: 3, spawnerProtectTune: { wither: false, bogus: 5 } }, 'teal', null);
  assert.strictEqual(again.spawnerLevel, 3); assert.strictEqual(again._sp.wither, false); assert.strictEqual(again._sp.range, 32);
  // config cũ (chưa có mức): giữ giá trị đã đặt
  const legacy = new BotSession({ id: 't3', host: 'h', port: 1, username: 'u', spawnerProtectRange: 35, spawnerAutoMine: false }, 'teal', null);
  assert.strictEqual(legacy.spawnerLevel, 2); assert.strictEqual(legacy.spawnerProtectRange, 35); assert.strictEqual(legacy.spawnerAutoMine, false);
  const legacy20 = new BotSession({ id: 't4', host: 'h', port: 1, username: 'u', spawnerProtectRange: 20, spawnerAutoMine: true }, 'teal', null);
  assert.deepStrictEqual(legacy20._spTune, {});
}

// ---------- 4) lệnh ----------
{
  const { bot, logs } = mkBot();
  assert.strictEqual(bot.cmdRegistry.run('spawnerprotect level 3'), 'system');
  assert.strictEqual(bot.spawnerLevel, 3);
  bot.cmdRegistry.run('spawnerprotect set range 40');
  assert.strictEqual(bot._sp.range, 40);
  bot.cmdRegistry.run('spawnerprotect set range auto');
  assert.strictEqual(bot._sp.range, 32);
  bot.cmdRegistry.run('spawnerprotect set wither maybe');
  assert(logs.some(l => l.includes('không hợp lệ')));
  bot.cmdRegistry.run('spawnerprotect level 9');
  assert.strictEqual(bot.spawnerLevel, 3, 'mức sai thì giữ nguyên');
  logs.length = 0; bot.cmdRegistry.run('spawnerprotect status');
  assert(logs.some(l => l.includes('threatRadius')) && logs.some(l => l.includes('mức 3')));
}

// ---------- 5) phát hiện theo mức ----------
function spy(bot) { const got = []; bot._onSpawnerThreat = async t => { got.push(t); }; return got; }
const tick = () => sleep(5);
(async () => {
  // đào bề mặt: mức 2 cần 2 block liên tiếp; mức 1 tắt; mức 4 chỉ cần 1
  {
    const { bot } = mkBot(); const got = spy(bot);
    const solid = (y) => ({ name: 'stone', boundingBox: 'block', position: V(5, y, 0) });
    const air = (y) => ({ name: 'air', boundingBox: 'empty', position: V(5, y, 0) });
    bot._spOnBlockUpdate(solid(70), air(70)); await tick();
    assert.strictEqual(got.length, 0, '1 block chưa đủ ở mức 2');
    bot._spOnBlockUpdate(solid(69), air(69)); await tick();
    assert.strictEqual(got.length, 1); assert(got[0][0].label.includes('đào bề mặt'));
    // xa hơn threatRadius (32) -> bỏ qua
    const far = mkBot(); const g2 = spy(far.bot);
    far.bot._spOnBlockUpdate({ name: 'stone', boundingBox: 'block', position: V(300, 70, 0) }, { name: 'air', position: V(300, 70, 0) });
    far.bot._spOnBlockUpdate({ name: 'stone', boundingBox: 'block', position: V(300, 69, 0) }, { name: 'air', position: V(300, 69, 0) }); await tick();
    assert.strictEqual(g2.length, 0);
    // mức 1: tắt hẳn
    const l1 = mkBot(); l1.bot.setSpawnerLevel(1); const g1 = spy(l1.bot);
    l1.bot._spOnBlockUpdate(solid(70), air(70)); l1.bot._spOnBlockUpdate(solid(69), air(69)); await tick();
    assert.strictEqual(g1.length, 0, 'mức 1 không bật đào bề mặt');
    // mức 4: 1 block là đủ
    const l4 = mkBot(); l4.bot.setSpawnerLevel(4); const g4 = spy(l4.bot);
    l4.bot._spOnBlockUpdate(solid(70), air(70)); await tick();
    assert.strictEqual(g4.length, 1, 'mức 4: 1 block là báo');
    // cát/lá không tính
    const sand = mkBot(); sand.bot.setSpawnerLevel(4); const gs = spy(sand.bot);
    sand.bot._spOnBlockUpdate({ name: 'sand', boundingBox: 'block', position: V(5, 70, 0) }, air(70)); await tick();
    assert.strictEqual(gs.length, 0);
  }

  // TNT / wither / nổ theo mức
  {
    const tnt = { name: 'tnt', position: V(10, 64, 0), isValid: true };
    const cart = { name: 'tnt_minecart', position: V(10, 64, 0), isValid: true };
    const wither = { name: 'wither', position: V(20, 64, 0), isValid: true };
    const l2 = mkBot(); const g2 = spy(l2.bot);
    l2.bot._spOnEntity(tnt); await tick(); l2.bot._spOnEntity(wither); await tick(); l2.bot._spOnEntity(cart); await tick();
    assert.strictEqual(g2.length, 2, 'mức 2: TNT + wither, KHÔNG tính minecart đậu yên');
    // mức 3 tính cả minecart
    const l3 = mkBot(); l3.bot.setSpawnerLevel(3); const g3 = spy(l3.bot);
    l3.bot._spOnEntity(cart); await tick(); assert.strictEqual(g3.length, 1);
    // mức 1: tắt hết
    const l1 = mkBot(); l1.bot.setSpawnerLevel(1); const g1 = spy(l1.bot);
    l1.bot._spOnEntity(tnt); await tick(); l1.bot._spOnEntity(wither); await tick(); l1.bot._spOnExplode(V(5, 64, 0), 4); await tick();
    assert.strictEqual(g1.length, 0);
    // chỉnh tay: mức 1 + bật explosive
    l1.bot.setSpawnerTune({ explosive: true }); l1.bot._spOnEntity(tnt); await tick(); assert.strictEqual(g1.length, 1);
    // ngoài bán kính -> không báo; vụ nổ tính cả bán kính nổ
    const far = mkBot(); const gf = spy(far.bot);
    far.bot._spOnEntity({ name: 'tnt', position: V(100, 64, 0) });
    far.bot._spOnExplode(V(36, 64, 0), 0); await tick(); assert.strictEqual(gf.length, 0, '33 block > 32');
    far.bot._spOnExplode(V(36, 64, 0), 4); await tick(); assert.strictEqual(gf.length, 1, 'bán kính nổ cộng vào tầm');
    // quét định kỳ cũng bắt entity đã có sẵn (đi vào vùng nguy hiểm)
    const sc = mkBot(); const gsc = spy(sc.bot);
    sc.mc.entities[1] = { name: 'wither_skull', position: V(8, 64, 0), isValid: true };
    sc.bot._spawnerProtectTick(); await tick();
    assert.strictEqual(gsc.length, 1); assert(gsc[0].some(t => t.label.includes('sọ wither')));
  }

  // người chơi đập block gần lồng; người được tin bị bỏ qua
  {
    const { bot, mc } = mkBot({ ownerUsername: 'chu' }); const got = spy(bot);
    mc.entities[7] = { type: 'player', username: 'ke_la', position: V(8, 64, 0) };
    mc.entities[8] = { type: 'player', username: 'chu', position: V(8, 64, 1) };
    bot._spOnBreakAnim({ entityId: 7, location: { x: 6, y: 64, z: 0 }, destroyStage: 3 }); await tick();
    assert.strictEqual(got.length, 1); assert(got[0][0].label.includes('ke_la'));
    bot._spOnBreakAnim({ entityId: 8, location: { x: 6, y: 64, z: 0 }, destroyStage: 3 }); await tick();
    assert.strictEqual(got.length, 1, 'owner không bị coi là kẻ lạ');
    bot._spOnBreakAnim({ entityId: 7, location: { x: 6, y: 64, z: 0 }, destroyStage: -1 }); await tick();
    assert.strictEqual(got.length, 1, 'stage -1 = ngừng đập');
  }

  // cổng "đứng cạnh lồng": chưa armed thì không báo gì
  {
    const { bot } = mkBot(); const got = spy(bot);
    bot._spawnerZone = 'out'; bot.mc.blockAt = () => null; // không có lồng cạnh bot
    bot._spOnEntity({ name: 'tnt', position: V(10, 64, 0) }); await tick();
    assert.strictEqual(got.length, 0);
  }

  // ---------- 6) xử lý: chỉ thoát khi ĐÃ xác minh ----------
  {
    const a = mkBot({ spawnerAutoDisconnect: true }); let down = 0; a.bot.shutdown = () => { down++; };
    a.invItems.push({ name: 'diamond_pickaxe', slot: 36, count: 1 });
    await a.bot._onSpawnerThreat([{ name: 'ke_la', dist: 4 }]);
    assert.strictEqual(down, 1, 'cất xong + xác minh -> thoát');
    assert(a.logs.some(l => l.includes('đã xác minh việc cất 1/1')));
    assert(a.events.indexOf('sneak=true') >= 0 && a.events.indexOf('dig 3,64,0') > a.events.indexOf('sneak=true'), 'giữ shift rồi mới đào');

    const b = mkBot({ spawnerAutoDisconnect: true }, { chestKeeps: false }); let down2 = 0; b.bot.shutdown = () => { down2++; };
    b.invItems.push({ name: 'diamond_pickaxe', slot: 36, count: 1 });
    await b.bot._onSpawnerThreat([{ name: 'ke_la', dist: 4 }]);
    assert.strictEqual(down2, 0, 'snapshot server không thấy lồng trong rương -> KHÔNG thoát');
    assert(b.logs.some(l => l.includes('CHƯA xác minh')));
    assert(b.logs.some(l => l.includes('KHÔNG ngắt kết nối')));
  }

  // mức 1 (chỉ báo): không đào, không mở rương
  {
    const { bot, events } = mkBot(); bot.setSpawnerLevel(1);
    await bot._onSpawnerThreat([{ name: 'ke_la', dist: 4 }]);
    assert(!events.some(e => e.startsWith('dig') || e.startsWith('open')));
  }

  // nhả shift giữa các đợt khi stack còn dư; nghỉ đúng pauseTicks
  {
    const { bot, mc, events, world, invItems } = mkBot(); bot.setSpawnerTune({ pauseTicks: 2 });
    invItems.push({ name: 'diamond_pickaxe', slot: 36, count: 1 });
    let left = 2; // stack 3: 2 lần đầu lồng vẫn còn
    mc.dig = async b => { events.push('dig'); invItems.push({ name: 'spawner', slot: 30, count: 1 }); if (--left < 0) world.set(key(b.position), 'air'); };
    const t0 = Date.now();
    await bot._onSpawnerThreat([{ name: 'ke_la', dist: 4 }]);
    const digs = events.filter(e => e === 'dig').length;
    assert.strictEqual(digs, 3);
    const rel = events.filter(e => e === 'sneak=false').length;
    assert(rel >= 2, 'nhả shift sau mỗi đợt còn dư');
    assert(Date.now() - t0 >= 2 * (150 + 100), 'có nghỉ giữa các đợt');
  }

  // ---------- 7) dashboard: getSpawnerProtect / setSpawnerProtect ----------
  {
    const WebDashboard = require('../src/web/WebDashboard');
    const { bot } = mkBot();
    bot.cfg.id = 'b1';
    const saved = { bots: [{ id: 'b1' }] };
    const stub = () => new Proxy(function () { return []; }, { get: (t, k) => (k === 'then' ? undefined : (k === 'enabled' ? false : (k === 'events' ? [] : stub()))), apply: () => [] });
    const mgr = new Proxy({ findBot: id => (id === 'b1' ? bot : null), _config: saved, bots: [bot], persistence: { markDirty() { }, saveSync() { } }, env: {} },
      { get: (t, k) => (k in t ? t[k] : stub()) });
    const handlers = {}, conn = [];
    const noop = () => { };
    const dash = new WebDashboard(mgr, { expressApp: new Proxy({}, { get: () => noop }), io: { on: (ev, fn) => { if (ev === 'connection') conn.push(fn); }, use: noop }, expressServer: {} });
    dash._setup();
    conn[0]({ handshake: {}, conn: {}, emit: noop, join: noop, leave: noop, on: (ev, fn) => { handlers[ev] = fn; } });
    const call = (ev, data) => { let r; handlers[ev](data, x => { r = x; }); return r; };
    let r = call('getSpawnerProtect', { id: 'b1' });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.level, 2); assert.strictEqual(r.settings.range, 20);
    assert.deepStrictEqual(Object.keys(r.guard.levels), ['1', '2', '3', '4']); assert(r.guard.spec.range.label);
    r = call('setSpawnerProtect', { id: 'b1', level: 4 });
    assert.strictEqual(r.level, 4); assert.strictEqual(bot.spawnerProtectRange, 48);
    assert.strictEqual(saved.bots[0].spawnerProtectLevel, 4, 'ghi vào config.json');
    r = call('setSpawnerProtect', { id: 'b1', tune: { range: 70, wither: false, evil: 1 } });
    assert.deepStrictEqual(r.tune, { range: 70, wither: false });
    assert.deepStrictEqual(saved.bots[0].spawnerProtectTune, { range: 70, wither: false });
    r = call('setSpawnerProtect', { id: 'b1', level: 1 });
    assert.deepStrictEqual(r.tune, {}); assert.strictEqual(r.settings.autoMine, false);
    r = call('setSpawnerProtect', { id: 'nope', level: 1 }); assert.strictEqual(r.ok, false);
  }

  // ---------- 8) giao diện: vẽ 4 nút mức + ô chỉnh chi tiết, gửi đúng tune ----------
  {
    const vm = require('vm'), fs = require('fs'), path = require('path');
    const app = fs.readFileSync(path.join(__dirname, '../src/web/public/app.js'), 'utf8');
    const grab = name => { const m = new RegExp(`function ${name}\\([^)]*\\) ?\\{[\\s\\S]*?\\n\\}`).exec(app); assert.ok(m, 'thiếu ' + name); return m[0]; };
    const els = { 'sp-levels': { innerHTML: '' }, 'sp-level-desc': {}, 'sp-tune-count': {}, 'sp-adv-body': { innerHTML: '', contains: () => false } };
    const sent = [];
    const inputs = [{ dataset: { sp: 'range' }, value: '55' }, { dataset: { sp: 'wither' }, checked: false }];
    const ctx = {
      $: id => els[id], esc: x => String(x), ST: { activeId: 'b1' }, document: { activeElement: null, querySelectorAll: () => inputs },
      toast: () => { }, loadSpawnerList: () => { }, SOCK: { emit: (ev, d, cb) => { sent.push([ev, d]); if (cb) cb({ ok: true }); } },
    };
    vm.createContext(ctx);
    vm.runInContext('let SP_GUARD=null;\n' + grab('renderSpawnerLevels') + grab('setSpawnerLevelUI') + grab('saveSpawnerTune') + '\nthis.R=renderSpawnerLevels;this.L=setSpawnerLevelUI;this.S=saveSpawnerTune;', ctx);
    const { bot } = mkBot();
    ctx.R({ level: 3, settings: bot._sp, tune: { wither: false }, guard: SG.describe() });
    assert.strictEqual((els['sp-levels'].innerHTML.match(/<button/g) || []).length, 4);
    assert(els['sp-levels'].innerHTML.includes('btn-primary') && els['sp-level-desc'].textContent.includes('Mạnh'));
    assert.strictEqual(els['sp-tune-count'].textContent, '(1 chỉnh tay)');
    assert(els['sp-adv-body'].innerHTML.includes('data-sp="digThreshold"') && els['sp-adv-body'].innerHTML.includes('type="checkbox"'));
    ctx.L(4); assert.strictEqual(JSON.stringify(sent.pop()), JSON.stringify(['setSpawnerProtect', { id: 'b1', level: 4 }]));
    ctx.S(); assert.strictEqual(JSON.stringify(sent.pop()), JSON.stringify(['setSpawnerProtect', { id: 'b1', tune: { range: 55, wither: false } }]));
  }

  console.log('spawner-guard.test OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
