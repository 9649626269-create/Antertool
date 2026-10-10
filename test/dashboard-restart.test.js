'use strict';
// BUG-003: nút "Restart" ở thanh chọn nhiều bot chỉ được restart các bot đã chọn (trước đây gửi {filterFn:null} -> restart TẤT CẢ).
// Kiểm cả 2 phía: hàm bulkRestart() của giao diện (app.js) và handler socket 'restartAll' của server.
// Chạy với BotManager/BotSession thật + mineflayer/vec3/express giả (không cần cài thư viện).
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const created = [];
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
const noop = () => { };
const fakeExpress = { static: () => noop, json: () => noop };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return fakeMineflayer;
  if (request === 'vec3') return V;
  if (request === 'express') return fakeExpress;
  return origLoad.call(this, request, ...rest);
};
const BotManager = require('../src/services/BotManager');
const WebDashboard = require('../src/web/WebDashboard');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------- 1) giao diện: bulkRestart gửi đúng danh sách id đã chọn ----------
  const appJs = fs.readFileSync(path.join(__dirname, '../src/web/public/app.js'), 'utf8');
  const m = /function bulkRestart\(\) \{[\s\S]*?\n\}/.exec(appJs);
  assert.ok(m, 'không tìm thấy bulkRestart trong app.js');
  const emitted = [], toasts = [];
  const ctx = {
    ST: { _selectedBots: new Set(['b2', 'b4']) },
    SOCK: { emit: (ev, data, cb) => { emitted.push([ev, data]); if (cb) setImmediate(() => cb({ ok: true })); } },
    confirm: () => true, renderSB: noop, toast: (msg) => toasts.push(msg),
  };
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\nthis.bulkRestart = bulkRestart;', ctx);
  ctx.bulkRestart();
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0][0], 'restartAll');
  assert.deepStrictEqual([...emitted[0][1].ids], ['b2', 'b4'],'phải gửi id các bot đã chọn (trước đây gửi {filterFn:null} không có id nào)');
  assert.strictEqual(ctx.ST._selectedBots.size, 0, 'bỏ chọn sau khi gửi');
  await sleep(20);
  assert.ok(toasts[0].includes('2 bot'), 'thông báo phải ghi đúng số bot đã chọn, không phải 0: ' + toasts[0]);

  // ---------- 2) server: handler socket 'restartAll' ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 25565, version: '1.20.4', bots: [] }));
  const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
  await mgr.init();
  for (let i = 1; i <= 4; i++) mgr.createBot({ id: 'Bot' + i, username: 'u' + i, host: '127.0.0.1', port: 25565 });
  mgr.startAll();
  await sleep(1200); // stagger 250ms/bot
  const mcOf = new Map(); // bot -> mc hiện tại
  const snapshot = () => Object.fromEntries(mgr.bots.map(b => [b.cfg.id, b.mc]));

  const handlers = {}, connHandlers = [];
  const app = new Proxy({}, { get: () => noop });
  const io = { on: (ev, fn) => { if (ev === 'connection') connHandlers.push(fn); }, use: noop };
  const dash = new WebDashboard(mgr, { expressApp: app, io, expressServer: {} });
  dash._setup();
  assert.strictEqual(connHandlers.length, 1);
  const sock = { handshake: {}, conn: {}, emit: noop, join: noop, leave: noop, on: (ev, fn) => { handlers[ev] = fn; } };
  connHandlers[0](sock);
  assert.strictEqual(typeof handlers.restartAll, 'function');

  const restart = async (data) => {
    const before = snapshot();
    let res; handlers.restartAll(data, r => { res = r; });
    await sleep(1400);
    const after = snapshot();
    return { res, changed: Object.keys(before).filter(id => before[id] !== after[id]).sort() };
  };

  let r = await restart({ ids: ['Bot2', 'bot4'] }); // id không phân biệt hoa thường như findBot
  assert.deepStrictEqual(r.changed, ['Bot2', 'Bot4'], 'chỉ 2 bot đã chọn được restart');
  assert.strictEqual(r.res.count, 2);

  r = await restart({ ids: ['Bot1'] });
  assert.deepStrictEqual(r.changed, ['Bot1']);

  r = await restart({ ids: [] }); // chọn rỗng = không bot nào, KHÔNG được hiểu là tất cả
  assert.deepStrictEqual(r.changed, []);
  assert.strictEqual(r.res.count, 0);

  r = await restart({ ids: ['khong-co'] });
  assert.deepStrictEqual(r.changed, []);

  r = await restart({ filterFn: null }); // không có ids -> giữ hành vi cũ: restart tất cả
  assert.deepStrictEqual(r.changed, ['Bot1', 'Bot2', 'Bot3', 'Bot4']);

  r = await restart(undefined); // gọi trống cũng không văng
  assert.deepStrictEqual(r.changed, ['Bot1', 'Bot2', 'Bot3', 'Bot4']);

  for (const b of mgr.bots) b.shutdown();
  clearInterval(mgr._poolPruneInterval); clearInterval(mgr._scheduleInterval); clearInterval(mgr._beatInterval);
  console.log('DASHBOARD RESTART TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
