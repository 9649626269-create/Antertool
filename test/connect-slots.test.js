'use strict';
// BUG-002: bộ đếm kết nối đồng thời (_activeConnects) không được rò rỉ -> restart/start lặp/shutdown bot chưa chạy không làm kẹt cả dàn bot.
// BUG-004: "Start All" phải bật lại được bot đã Stop (bot nghỉ theo lịch thì để lịch lo).
// Chạy với BotManager/BotSession thật + mineflayer/vec3 giả (không cần cài thư viện, không cần server).
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const created = []; // mọi "kết nối mineflayer" đã được tạo
const fakeMineflayer = {
  createBot() {
    const mc = new EventEmitter();
    mc._client = new EventEmitter();
    mc._client.socket = { destroy() { } };
    mc._client.write = () => { };
    mc._client.end = function () { this.ended = true; };
    created.push(mc);
    return mc;
  },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return fakeMineflayer;
  if (request === 'vec3') return V;
  return origLoad.call(this, request, ...rest);
};
const BotManager = require('../src/services/BotManager');
const { CS, TIMING } = require('../src/core/constants');
const sleep = ms => new Promise(r => setTimeout(r, ms));
assert.strictEqual(TIMING.MAX_CONCURRENT_CONNECTS, 5, 'test giả định tối đa 5 kết nối đồng thời');

async function newManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slots-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 25565, version: '1.20.4', bots: [] }));
  const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
  await mgr.init();
  const add = n => mgr.createBot({ id: 'b' + n, username: 'u' + n, host: '127.0.0.1', port: 25565 });
  return { mgr, add };
}
const stop = mgr => { for (const b of mgr.bots) { try { b.shutdown(); } catch { } } clearInterval(mgr._poolPruneInterval); clearInterval(mgr._scheduleInterval); clearInterval(mgr._beatInterval); };

(async () => {
  // ---- BUG-002 (1) start() 2 lần khi đang CONNECTING: sau shutdown() bộ đếm phải về 0 ----
  {
    const { mgr, add } = await newManager();
    const b = add(1);
    b.start();
    assert.strictEqual(b.state.connState, CS.CONNECTING);
    assert.strictEqual(mgr._activeConnects, 1);
    b.start();
    assert.strictEqual(mgr._activeConnects, 1, 'start() lần 2 phải trả slot của lần 1 trước khi lấy slot mới');
    b.shutdown();
    assert.strictEqual(mgr._activeConnects, 0, 'sau shutdown() không còn slot nào bị giữ');
    stop(mgr);
  }

  // ---- BUG-002 (2) 5 bot đang CONNECTING rồi restartAll: phải kết nối lại đủ 5 bot, bộ đếm về 0 khi tắt ----
  {
    const { mgr, add } = await newManager();
    for (let i = 1; i <= 5; i++) add(i);
    mgr.startAll();
    await sleep(1400); // stagger 250ms/bot
    assert.strictEqual(created.length >= 5, true);
    assert.strictEqual(mgr._activeConnects, 5);
    assert.ok(mgr.bots.every(b => b.state.connState === CS.CONNECTING));
    const before = created.length;
    mgr.restartAll();
    await sleep(1600);
    assert.strictEqual(created.length - before, 5, 'restartAll phải tạo lại kết nối cho cả 5 bot (trước đây kẹt ở 5/5, không tạo thêm kết nối nào)');
    assert.strictEqual(mgr._activeConnects, 5, 'đúng 5 kết nối đang chờ, không tích luỹ thêm');
    // bot thứ 6 không bị kẹt vĩnh viễn: ngay khi có slot trống nó được vào
    const b6 = add(6);
    b6.start();
    assert.strictEqual(created.length - before, 5, 'còn đủ 5 slot nên bot 6 xếp hàng');
    mgr.bots[0].shutdown();
    assert.strictEqual(mgr._activeConnects, 4);
    await sleep(3300); // start_queued thử lại sau 3s
    assert.strictEqual(created.length - before, 6, 'bot 6 vào được sau khi có slot trống');
    stop(mgr);
    assert.strictEqual(mgr._activeConnects, 0, 'tắt hết thì bộ đếm về 0 (không kẹt tới khi khởi động lại tiến trình)');
  }

  // ---- BUG-002 (3) shutdown() bot chưa từng chạy không được trừ nhầm slot của bot khác ----
  {
    const { mgr, add } = await newManager();
    const a = add(1), idle = add(2);
    a.start();
    assert.strictEqual(mgr._activeConnects, 1);
    idle.shutdown();
    assert.strictEqual(mgr._activeConnects, 1, 'bot chưa chạy không giữ slot nên shutdown không được trừ');
    a.shutdown();
    assert.strictEqual(mgr._activeConnects, 0);
    stop(mgr);
  }

  // ---- BUG-002 (4) hardReset() không để lại cờ "đang giữ slot" giả (làm shutdown sau đó trừ nhầm bot khác) ----
  {
    const { mgr, add } = await newManager();
    const a = add(1), c = add(2);
    a.start(); c.start();
    assert.strictEqual(mgr._activeConnects, 2);
    a.hardReset();
    assert.strictEqual(mgr._activeConnects, 1, 'hardReset trả slot của a, còn slot của c');
    a.shutdown(); // trước khi timer 1.5s của hardReset chạy
    assert.strictEqual(mgr._activeConnects, 1, 'a không giữ slot nào nữa -> không được trừ slot của c');
    stop(mgr);
  }

  // ---- BUG-002 (5) không hồi quy: mất kết nối bình thường chỉ trả slot đúng 1 lần ----
  {
    const { mgr, add } = await newManager();
    const a = add(1), c = add(2);
    a.start(); c.start();
    const mcA = created[created.length - 2];
    mcA.emit('end', 'connection reset');
    assert.strictEqual(mgr._activeConnects, 1, "sự kiện 'end' trả slot của a; _destroyMc sau đó không trả thêm lần 2");
    stop(mgr);
    assert.strictEqual(mgr._activeConnects, 0);
  }

  // ---- BUG-004 Start All phải bật lại bot đã Stop ----
  {
    const { mgr, add } = await newManager();
    for (let i = 1; i <= 3; i++) add(i);
    mgr.startAll();
    await sleep(800);
    assert.ok(mgr.bots.every(b => b.state.connState === CS.CONNECTING), 'startAll lần đầu');
    mgr.stopAll();
    assert.ok(mgr.bots.every(b => b.state.connState === CS.DISCONNECTED && b._disabled === true), 'stopAll');
    const before = created.length;
    mgr.startAll();
    await sleep(800);
    assert.ok(mgr.bots.every(b => b.state.connState === CS.CONNECTING && b._disabled === false), 'startAll sau Stop phải bật lại (trước đây vẫn DISCONNECTED)');
    assert.strictEqual(created.length - before, 3);
    // bot đang chạy không bị start lại
    const n = created.length;
    mgr.bots[0].state.connState = CS.ONLINE;
    mgr.startAll();
    await sleep(300);
    assert.ok(created.length - n <= 2 && mgr.bots[0].state.connState === CS.ONLINE, 'bot ONLINE không bị đụng');
    stop(mgr);
  }

  // ---- BUG-004 bot đang nghỉ theo lịch thì Start All bỏ qua (lịch sẽ tự cho vô lại) ----
  {
    const { mgr, add } = await newManager();
    const rest = add(1), normal = add(2);
    rest.start(); normal.start();
    rest._scheduledOut = true; rest.shutdown(); // giống _doScheduledOut
    normal.shutdown();
    const before = created.length;
    mgr.startAll();
    await sleep(500);
    assert.strictEqual(rest.state.connState, CS.DISCONNECTED);
    assert.strictEqual(rest._disabled, true, 'bot nghỉ theo lịch phải giữ nguyên trạng thái tắt');
    assert.strictEqual(normal.state.connState, CS.CONNECTING);
    assert.strictEqual(created.length - before, 1);
    stop(mgr);
  }

  console.log('CONNECT SLOTS TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
