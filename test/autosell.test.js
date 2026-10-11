'use strict';
// Auto-sell tích hợp (src/core/autosell.js): bán qua /sell theo danh sách item, cài đặt ở autosell.json (KHÔNG nằm trong config.json, KHÔNG cần macro).
// Chạy với BotSession/BotManager thật + mineflayer/vec3/express giả (không cần cài thư viện, không cần server).
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const vm = require('vm');
const noop = () => { };
const fakeExpress = { static: () => noop, json: () => noop };
const fakeMineflayer = { createBot() { const mc = new EventEmitter(); mc._client = new EventEmitter(); mc._client.socket = { destroy() { } }; mc._client.write = () => { }; mc._client.end = () => { }; return mc; } };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return fakeMineflayer;
  if (request === 'vec3') return V;
  if (request === 'express') return fakeExpress;
  return origLoad.call(this, request, ...rest);
};
const AutoSell = require('../src/core/autosell');
const BotSession = require('../src/core/BotSession');
const BotManager = require('../src/services/BotManager');
const WebDashboard = require('../src/web/WebDashboard');
const { CS } = require('../src/core/constants');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

const cobble = n => ({ name: 'cobblestone', displayName: 'Cobblestone', count: n || 64 });
const pane = () => ({ name: 'black_stained_glass_pane', displayName: 'Glass Pane', count: 1 });

// Thế giới giả: shop /sell = rương `size` ô (ô cuối 2 hàng là nút), túi đồ 36 ô.
// shift-click túi -> ô trống đầu tiên của vùng hàng hoá; click ô (size-1) rồi (size-9) = bán (xoá hàng hoá).
function mkWorld({ size = 54, inv = [], opensGui = true, shopFull = false, bot: botCfg = {} } = {}) {
  const chats = [], clicks = [], logs = [];
  const bot = new BotSession({ id: 't', host: 'h', port: 25565, username: 'u', autoSellRevenue: false, autosell: { enabled: true, threshold: 50, items: ['cobblestone'] }, ...botCfg }, 'teal', null);
  bot.state.connState = CS.ONLINE;
  bot.on('log', e => logs.push(e.msg));
  const goods = size - 9; // ô 0..goods-1 là chỗ để hàng, hàng cuối là nút
  const win = { id: 1, title: '{"text":"SELL"}', inventoryStart: size, slots: Array.from({ length: size + 36 }, () => null) };
  for (let i = goods; i < size; i++) win.slots[i] = pane();
  if (shopFull) for (let i = 0; i < goods; i++) win.slots[i] = { name: 'dirt', count: 1 };
  inv.forEach((it, k) => { win.slots[size + k] = it; });
  const state = { closed: 0, sold: 0, firstClicked: false };
  const mc = new EventEmitter();
  Object.assign(mc, {
    entity: { position: V(0, 64, 0), yaw: 0, pitch: 0 },
    currentWindow: null,
    registry: { itemsByName: { cobblestone: {}, stone: {}, iron_ingot: {} } },
    inventory: { items: () => win.slots.slice(size).filter(Boolean) },
    setControlState() { }, getControlState: () => false,
    chat(c) { chats.push(c); if (opensGui) setImmediate(() => { mc.currentWindow = win; mc.emit('windowOpen', win); }); },
    closeWindow(w) { if (mc.currentWindow === w) { mc.currentWindow = null; state.closed++; } },
    async clickWindow(slot, btn, mode) {
      clicks.push([slot, mode]);
      if (mode === 1 && slot >= size) { // shift-click: túi -> ô trống đầu tiên của vùng hàng hoá
        const dst = win.slots.slice(0, goods).findIndex(s => !s);
        if (dst >= 0) { win.slots[dst] = win.slots[slot]; win.slots[slot] = null; }
      } else if (mode === 0 && slot === size - 1) state.firstClicked = true;
      else if (mode === 0 && slot === size - 9 && state.firstClicked) { // click xác nhận thứ 2 -> bán
        state.firstClicked = false;
        for (let i = 0; i < goods; i++) if (win.slots[i]) { win.slots[i] = null; state.sold++; }
      }
    },
  });
  bot.mc = mc;
  return { bot, mc, win, chats, clicks, logs, state };
}

(async () => {
  // ---------- 1) hàm thuần ----------
  {
    assert.deepStrictEqual(AutoSell.parseItems('cobblestone, Stone;minecraft:iron_ingot  cobblestone'), { items: ['cobblestone', 'stone', 'iron_ingot'], bad: [] }, 'tách theo , ; khoảng trắng, bỏ tiền tố minecraft:, bỏ trùng');
    assert.deepStrictEqual(AutoSell.parseItems(['cobblestone,stone', 'dirt']).items, ['cobblestone', 'stone', 'dirt'], 'mảng token từ CLI cũng nhận dấu phẩy');
    assert.deepStrictEqual(AutoSell.parseItems('cobble$tone x').bad, ['cobble$tone', 'x'], 'tên sai dạng (ký tự lạ / quá ngắn) bị báo');
    assert.strictEqual(AutoSell.matches({ name: 'cobblestone' }, ['cobblestone']), true);
    assert.strictEqual(AutoSell.matches({ name: 'mossy_cobblestone', displayName: 'Mossy Cobblestone' }, ['cobblestone']), false, 'KHÔNG khớp một phần');
    assert.strictEqual(AutoSell.matches({ name: 'diamond_sword' }, ['sword']), false, 'ghi "sword" không được bán diamond_sword');
    assert.strictEqual(AutoSell.matches({ name: 'x', displayName: 'Iron Ingot' }, ['iron_ingot']), true, 'khớp cả tên hiển thị');
    assert.strictEqual(AutoSell.resolveSlot(-1, 54), 53);
    assert.strictEqual(AutoSell.resolveSlot(-9, 54), 45);
    assert.strictEqual(AutoSell.resolveSlot(20, 54), 20);
    assert.strictEqual(AutoSell.resolveSlot(60, 54), null, 'ngoài GUI -> không click (tránh click vào túi đồ)');
    assert.strictEqual(AutoSell.resolveSlot(-99, 54), null);
    assert.strictEqual(AutoSell.guiSize({ inventoryStart: 27, slots: new Array(63) }), 27);
    assert.strictEqual(AutoSell.guiSize({ slots: new Array(90) }), 54, 'không có inventoryStart -> tổng ô trừ 36');
    const s = AutoSell.sanitize({ enabled: true, threshold: '50%', items: 'cobblestone', command: 'sell', clicks: [1, 2] });
    assert.deepStrictEqual(s, { enabled: true, threshold: 50, items: ['cobblestone'], command: '/sell', clicks: [1, 2] });
    assert.strictEqual(AutoSell.sanitize({ enabled: true, items: [] }).enabled, false, 'bật mà không có item -> coi như tắt');
    assert.deepStrictEqual(AutoSell.sanitize(null), { enabled: false, threshold: null, items: [], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(AutoSell.sanitize({ threshold: 500 }).threshold, null);
  }

  // ---------- 2) autosell.json: lưu/nạp, không phân biệt hoa thường, file hỏng không làm sập ----------
  {
    const dir = tmp('as-store-');
    const f = path.join(dir, 'autosell.json');
    assert.strictEqual(AutoSell.Store.pathNextTo(path.join(dir, 'config.json')), f);
    const st = new AutoSell.Store(f);
    assert.strictEqual(st.get('bot1').enabled, false, 'chưa có file -> tắt');
    st.save('Bot1', { enabled: true, threshold: 60, items: ['stone'] });
    const st2 = new AutoSell.Store(f);
    assert.deepStrictEqual(st2.get('bot1').items, ['stone'], 'id không phân biệt hoa/thường');
    st2.save('BOT1', { enabled: false, threshold: 60, items: ['stone'] });
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))), ['Bot1'], 'không tạo mục trùng khác hoa/thường');
    fs.writeFileSync(f, '{hỏng');
    assert.strictEqual(new AutoSell.Store(f).get('x').enabled, false);
  }

  // ---------- 3) bán thật: chỉ item trong danh sách, đúng thứ tự click, đóng GUI ----------
  {
    const inv = [cobble(), { name: 'diamond_pickaxe', count: 1 }, cobble(), { name: 'stone', displayName: 'Stone', count: 64 }, cobble()];
    const w = mkWorld({ inv });
    const r = await AutoSell.run(w.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(r.status, 'sold', w.logs.join('\n'));
    assert.deepStrictEqual(w.chats, ['/sell']);
    const shift = w.clicks.filter(c => c[1] === 1).map(c => c[0]);
    assert.deepStrictEqual(shift, [54, 56, 58], 'chỉ shift-click 3 stack cobblestone (ô 54,56,58), không đụng cúp/stone');
    const confirm = w.clicks.filter(c => c[1] === 0).map(c => c[0]);
    assert.deepStrictEqual(confirm, [53, 45], 'click ô cuối rồi ô trái-cuối');
    assert.strictEqual(w.state.sold, 3, 'cả 3 stack đã bị bán');
    assert.strictEqual(w.win.slots[55].name, 'diamond_pickaxe', 'cúp vẫn còn trong túi');
    assert.strictEqual(w.win.slots[57].name, 'stone', 'item không nằm trong danh sách không bị bán');
    assert.strictEqual(w.state.closed, 1, 'bán xong đóng GUI');
    assert.strictEqual(w.bot._autoSellBusy, false);
  }

  // ---------- 4) nhiều stack hơn sức chứa shop -> nhiều lượt trong cùng 1 lần mở ----------
  {
    const w = mkWorld({ size: 27, inv: Array.from({ length: 20 }, () => cobble()) }); // chỗ để hàng = 18 ô
    const r = await AutoSell.run(w.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(r.status, 'sold');
    assert.strictEqual(r.sold, 2, `20 stack / 18 ô = 2 lượt, thực tế ${r.sold}`);
    assert.strictEqual(w.state.sold, 20);
    assert.strictEqual(w.chats.length, 1, 'chỉ gõ /sell 1 lần');
    assert(!w.win.slots.slice(27).some(Boolean), 'túi không còn cobblestone');
  }

  // ---------- 5) không có item nào để bán -> không gõ /sell ----------
  {
    const w = mkWorld({ inv: [{ name: 'diamond_pickaxe', count: 1 }] });
    const r = await AutoSell.run(w.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(r.status, 'nothing');
    assert.deepStrictEqual(w.chats, []);
  }

  // ---------- 6) /sell không mở GUI -> fail, nhả cờ bận ----------
  {
    const w = mkWorld({ inv: [cobble()] });
    w.bot._waitWindowOpen = async () => null; // thay cho chờ 6s thật
    const r = await AutoSell.run(w.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(r.status, 'fail');
    assert.deepStrictEqual(w.chats, ['/sell']);
    assert.strictEqual(w.bot._autoSellBusy, false);
  }

  // ---------- 7) shop đầy không nhận thêm -> fail (không click xác nhận bừa), vẫn đóng GUI ----------
  {
    const w = mkWorld({ inv: [cobble()], shopFull: true });
    const r = await AutoSell.run(w.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(w.clicks.filter(c => c[1] === 0).length, 0, 'không có gì chuyển vào thì không click xác nhận');
    assert.strictEqual(w.state.closed, 1);
  }

  // ---------- 8) bận (bảo vệ lồng / bán lồng / macro) -> không chạy; bị ngắt giữa chừng không đóng GUI của routine khác ----------
  {
    const w = mkWorld({ inv: [cobble()] });
    w.bot._sellSpawnBusy = true;
    assert.strictEqual((await AutoSell.run(w.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] })).status, 'busy');
    assert.deepStrictEqual(w.chats, []);
    const w2 = mkWorld({ inv: [cobble()] });
    const origChat = w2.mc.chat;
    const other = { id: 9 };
    w2.mc.chat = c => { origChat(c); setTimeout(() => { w2.bot._spawnerBusy = true; w2.mc.currentWindow = other; }, 100); }; // bảo vệ lồng chen vào và mở GUI của nó
    const r = await AutoSell.run(w2.bot, { items: ['cobblestone'], command: '/sell', clicks: [-1, -9] });
    assert.strictEqual(r.status, 'fail');
    assert.strictEqual(w2.mc.currentWindow, other, 'không được đóng GUI không phải của auto-sell');
    assert.strictEqual(w2.bot._autoSellBusy, false);
  }

  // ---------- 9) trigger khi túi đầy (_checkAutoSell) ----------
  {
    const realRun = AutoSell.run;
    try {
      let calls = 0, status = 'sold';
      AutoSell.run = async () => { calls++; return { status, sold: 1, moved: 1 }; };
      const { bot } = mkWorld();
      bot._autoSellArmed = true;
      assert.strictEqual(bot._autoSellBuiltin(), true);
      assert.strictEqual(bot._autoSellPct(), 50);
      bot._checkAutoSell(17); await sleep(5);
      assert.strictEqual(calls, 0, '17/36 < 50% chưa bán');
      bot._checkAutoSell(18); await sleep(5);
      assert.strictEqual(calls, 1, '18/36 = 50% -> bán');
      bot._checkAutoSell(25); await sleep(5);
      assert.strictEqual(calls, 1, 'đã bắn thì không bắn lại khi túi còn đầy');
      bot._checkAutoSell(14); bot._checkAutoSell(18); await sleep(5);
      assert.strictEqual(calls, 2, 'túi vơi ≤ 14 thì reset, đầy lại bán tiếp');
      // chưa vào đúng vị trí treo -> không bán
      bot._autoSellArmed = false; bot._checkAutoSell(30); await sleep(5);
      assert.strictEqual(calls, 2);
      // bận -> chưa bắn, thử lại sau 10s
      bot._autoSellArmed = true; bot._checkAutoSell(14);
      bot._spawnerBusy = true; bot._checkAutoSell(20); await sleep(5);
      assert.strictEqual(calls, 2, 'đang bận thì không chạy');
      assert.strictEqual(bot._autoSellFired, false, 'bận thì chưa đánh dấu đã bắn');
      assert(bot._timers.has('autoSellRetry'), 'phải hẹn thử lại');
      bot._spawnerBusy = false; bot._checkAutoSell(20); await sleep(5);
      assert.strictEqual(calls, 3);
      // lỗi liên tiếp -> thử lại tối đa 5 lần rồi thôi (không spam /sell mãi)
      status = 'fail'; bot._checkAutoSell(14); bot._autoSellFails = 0;
      for (let i = 0; i < 7; i++) { bot._checkAutoSell(20); await sleep(5); }
      assert.strictEqual(calls, 3 + 5, `lỗi: đúng 5 lần thử rồi dừng, thực tế ${calls - 3}`);
      bot._checkAutoSell(10); status = 'sold'; bot._checkAutoSell(20); await sleep(5);
      assert.strictEqual(calls, 3 + 5 + 1, 'túi vơi thì bắt đầu lại bình thường');
      bot._clearAllTimers();
    } finally { AutoSell.run = realRun; }
  }

  // ---------- 10) lệnh autosell: lưu vào autosell.json, KHÔNG đụng config.json ----------
  {
    const dir = tmp('as-cmd-');
    const store = new AutoSell.Store(path.join(dir, 'autosell.json'));
    const config = { bots: [{ id: 't' }] };
    let dirty = 0;
    const { bot, logs } = mkWorld({ bot: { autosell: undefined, macros: { foo: { steps: 'delay 1' } } } });
    bot._manager = { autoSellStore: store, _config: config, persistence: { markDirty() { dirty++; } } };
    assert.strictEqual(bot._autoSellOn(), false);
    bot.cmd('autosell'); assert(logs.at(-1).includes('Chưa đặt auto-sell'));
    bot.cmd('autosell 50'); assert(logs.at(-1).includes('Cú pháp'), logs.at(-1));
    bot.cmd('autosell on'); assert(logs.at(-1).includes('Chưa có danh sách item'), logs.at(-1));
    bot.cmd('autosell 50 cobbstone');
    assert(logs.at(-1).includes('không phải tên item'), 'gõ nhầm tên item phải bị từ chối: ' + logs.at(-1));
    assert.strictEqual(bot._autoSellOn(), false);
    bot.cmd('autosell 50 on'); assert(logs.at(-1).includes('không phải tên item'), logs.at(-1));
    bot.cmd('autosell 150 cobblestone'); assert(logs.at(-1).includes('1-100'));
    bot.cmd('autosell 50% cobblestone,stone');
    assert(logs.some(l => l.includes('Đã đặt auto-sell: 50% đầy → bán [cobblestone, stone] qua /sell')), logs.slice(-3).join(' | '));
    assert.strictEqual(bot._autoSellBuiltin(), true);
    assert.deepStrictEqual(store.get('t'), { enabled: true, threshold: 50, items: ['cobblestone', 'stone'], command: '/sell', clicks: [-1, -9] });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'autosell.json'), 'utf8')).t.items, ['cobblestone', 'stone'], 'đã ghi ra file autosell.json');
    assert.strictEqual('autosell' in config, false, 'config.json không có mục autosell');
    bot.cmd('autosell'); assert(logs.at(-1).includes('50% đầy → bán [cobblestone, stone] qua /sell'), logs.at(-1));
    bot.cmd('autosell off');
    assert.strictEqual(bot._autoSellOn(), false);
    assert.strictEqual(store.get('t').enabled, false);
    bot.cmd('autosell on');
    assert.strictEqual(bot._autoSellBuiltin(), true, 'autosell on bật lại đúng danh sách cũ');
    assert.deepStrictEqual(store.get('t').items, ['cobblestone', 'stone']);
    // kiểu macro cũ vẫn dùng được và tắt kiểu tích hợp
    bot.cmd('autosell 70 macro nope'); assert(logs.at(-1).includes('không tồn tại'), logs.at(-1));
    assert.strictEqual(bot._autoSellBuiltin(), true, 'macro không tồn tại thì giữ nguyên cài đặt cũ');
    bot.cmd('autosell 70 macro foo');
    assert.strictEqual(bot.autoSellMacro, 'foo');
    assert.strictEqual(bot._autoSellBuiltin(), false);
    assert.strictEqual(store.get('t').enabled, false);
    assert.strictEqual(bot._autoSellPct(), 70);
    bot.cmd('autosell 40 cobblestone');
    assert.strictEqual(bot.autoSellMacro, null, 'đặt kiểu tích hợp thì bỏ macro');
    assert.strictEqual(bot._autoSellPct(), 40);
    assert(dirty > 0);
    bot._clearAllTimers();
  }

  // ---------- 11) BotManager nạp autosell.json cho bot (không phân biệt hoa/thường), config.json không cần mục nào ----------
  {
    const dir = tmp('as-mgr-');
    const cfgFile = path.join(dir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ host: '127.0.0.1', port: 25565, version: '1.20.4', bots: [{ id: 'Autosell', username: 'u1' }, { id: 'other', username: 'u2' }] }));
    fs.writeFileSync(path.join(dir, 'autosell.json'), JSON.stringify({ autosell: { enabled: true, threshold: 55, items: ['cobblestone'], command: '/sell', clicks: [-1, -9] } }));
    const mgr = new BotManager({ configPath: cfgFile });
    await mgr.init();
    const b = mgr.findBot('autosell'), o = mgr.findBot('other');
    assert.strictEqual(b._autoSellBuiltin(), true);
    assert.strictEqual(b._autoSellPct(), 55);
    assert.deepStrictEqual(b.autoSellItems, ['cobblestone']);
    assert.strictEqual(o._autoSellOn(), false, 'bot khác không bị ảnh hưởng');
    // đặt qua lệnh -> ghi autosell.json, config.json không đổi
    const before = fs.readFileSync(cfgFile, 'utf8');
    o.cmd('autosell 30 stone');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'autosell.json'), 'utf8')).other.items, ['stone']);
    mgr.persistence.saveSync(); await sleep(1100);
    assert(!('autosell' in JSON.parse(fs.readFileSync(cfgFile, 'utf8'))), 'config.json không bị thêm mục autosell');
    assert.strictEqual(typeof before, 'string');
    for (const x of mgr.bots) { try { x.shutdown(); } catch { } x._clearAllTimers?.(); }
    clearInterval(mgr._poolPruneInterval); clearInterval(mgr._scheduleInterval); clearInterval(mgr._beatInterval);
    mgr.persistence.shutdown();
  }

  // ---------- 12) web: handler socket setAutoSell + hàm saveAutoSell của giao diện ----------
  {
    const dir = tmp('as-web-');
    const cfgFile = path.join(dir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ host: '127.0.0.1', port: 25565, version: '1.20.4', bots: [{ id: 'w1', username: 'w1' }] }));
    const mgr = new BotManager({ configPath: cfgFile });
    await mgr.init();
    const handlers = {}, connHandlers = [];
    const io = { on: (ev, fn) => { if (ev === 'connection') connHandlers.push(fn); }, use: noop };
    const dash = new WebDashboard(mgr, { expressApp: new Proxy({}, { get: () => noop }), io, expressServer: {} });
    dash._setup();
    connHandlers[0]({ handshake: {}, conn: {}, emit: noop, join: noop, leave: noop, on: (ev, fn) => { handlers[ev] = fn; } });
    const call = (ev, data) => new Promise(res => handlers[ev](data, res));
    const b = mgr.findBot('w1');
    let r = await call('setAutoSell', { id: 'w1', threshold: '60', items: 'cobblestone, stone' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(b._autoSellBuiltin(), true);
    assert.strictEqual(b._autoSellPct(), 60);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'autosell.json'), 'utf8')).w1.items, ['cobblestone', 'stone']);
    r = await call('setAutoSell', { id: 'w1', threshold: '60', items: 'cobblestone, $$' });
    assert.strictEqual(r.ok, false, 'tên sai dạng bị từ chối');
    assert.strictEqual(b._autoSellBuiltin(), true, 'bị từ chối thì giữ nguyên cài đặt cũ');
    r = await call('setAutoSell', { id: 'w1', macro: null }); // nút "Tắt"
    assert.strictEqual(r.ok, true);
    assert.strictEqual(b._autoSellOn(), false);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'autosell.json'), 'utf8')).w1.enabled, false);
    r = await call('setAutoSell', { id: 'nope', items: 'stone' });
    assert.strictEqual(r.ok, false);
    // giao diện: ô "Item bán" ưu tiên hơn ô macro; để trống cả hai thì báo lỗi, không gửi gì
    const appJs = fs.readFileSync(path.join(__dirname, '../src/web/public/app.js'), 'utf8');
    const m = /function saveAutoSell\(\) \{[\s\S]*?\n\}/.exec(appJs);
    assert.ok(m, 'không tìm thấy saveAutoSell trong app.js');
    const sent = [], toasts = [];
    const vals = { 'as-pct': { value: '50' }, 'as-macro': { value: '' }, 'as-items': { value: 'cobblestone' } };
    const ctx = { ST: { activeId: 'w1' }, $: id => vals[id], toast: (msg, kind) => toasts.push([msg, kind]), SOCK: { emit: (ev, d, cb) => { sent.push([ev, d]); cb && cb({ ok: true }); } } };
    vm.createContext(ctx);
    vm.runInContext(m[0] + '\nthis.saveAutoSell = saveAutoSell;', ctx);
    ctx.saveAutoSell();
    assert.strictEqual(JSON.stringify(sent[0]), JSON.stringify(['setAutoSell', { id: 'w1', threshold: '50', items: 'cobblestone' }])); // JSON: đối tượng từ vm khác realm nên không so sâu trực tiếp
    vals['as-items'].value = ''; vals['as-macro'].value = 'foo';
    ctx.saveAutoSell();
    assert.strictEqual(JSON.stringify(sent[1]), JSON.stringify(['setAutoSell', { id: 'w1', threshold: '50', macro: 'foo' }]));
    vals['as-macro'].value = '';
    ctx.saveAutoSell();
    assert.strictEqual(sent.length, 2, 'trống cả hai thì không gửi');
    assert.strictEqual(toasts.at(-1)[1], 'error');
    for (const x of mgr.bots) { try { x.shutdown(); } catch { } x._clearAllTimers?.(); }
    clearInterval(mgr._poolPruneInterval); clearInterval(mgr._scheduleInterval); clearInterval(mgr._beatInterval);
    mgr.persistence.shutdown();
  }

  console.log('autosell.test.js: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
