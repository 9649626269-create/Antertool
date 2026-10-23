'use strict';
// Bộ mô phỏng tự động (Section 14 Acceptance):
// - Đẩy một phiên bot giả qua đủ 5 giai đoạn (1: đăng nhập -> 2: vào server -> 3: đang bán lồng i/N -> 4: chờ vòng bán kế tiếp -> 5: bị kick và tự kết nối lại)
// - Gửi và sửa bảng trên server Telegram giả ở từng giai đoạn, in bảng ra console và kiểm tra nội dung
// - Chạy toàn bộ các lệnh trong mục 9 qua cả 2 đường: gõ lệnh (/command) và bấm nút (button callback)
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return {};
  if (request === 'vec3') return { Vec3: class { } };
  return origLoad.call(this, request, ...rest);
};

const BotManager = require('../src/services/BotManager');
const BotActivity = require('../src/core/BotActivity');
const P = require('../src/core/TelegramPanel');
const { RESULT_CODES } = require('../src/core/TelegramControl');
const { sym, setSymbolSet } = require('../src/core/Symbols');

function startSimServer() {
  const calls = [];
  let nextId = 500;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Date', new Date().toUTCString());
      if (method === 'sendMessage') return res.end(JSON.stringify({ ok: true, result: { message_id: nextId++ } }));
      if (method === 'editMessageText') return res.end(JSON.stringify({ ok: true, result: { message_id: body.message_id } }));
      if (method === 'answerCallbackQuery') return res.end(JSON.stringify({ ok: true, result: true }));
      if (method === 'setMyCommands') return res.end(JSON.stringify({ ok: true, result: true }));
      if (method === 'getUpdates') return res.end(JSON.stringify({ ok: true, result: [] }));
      res.end(JSON.stringify({ ok: true, result: true }));
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    server,
    calls,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

(async () => {
  setSymbolSet('unicode');
  const sim = await startSimServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sim-'));
  const cfgPath = path.join(tmpDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    bots: [],
    telegramToken: '123456789:' + 'S'.repeat(35),
    telegramChatId: '555',
    telegramAdmins: ['555'],
    telegramCommands: false,
    telegramRefreshSec: 0,
    telegramMinGapSec: 0,
    telegramTimezone: 'Asia/Ho_Chi_Minh',
  }));

  const mgr = new BotManager({ configPath: cfgPath });
  await mgr.init();
  mgr.telegram.apiBase = sim.base;

  const now0 = 1700000000000;
  const bot = {
    cfg: { id: 'bot-1', username: 'Steve', macros: { afk_jump: { steps: 'chat /afk' } } },
    state: { connState: 'CONNECTING', reconnects: 0, ping: 42, dimension: 'overworld', position: { x: 120, y: 64, z: -48 }, afk: null },
    isOnline: false,
    isConnected: false,
    isReconnecting: false,
    _disabled: false,
    _sellSpawnOn: true,
    _sellSpawnBusy: false,
    _spawnerProtectOn: true,
    spawnerLevel: 2,
    protectedSpawners: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }],
    sellSpawnList: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }],
    _sellIntervalMs: 300000,
    _sellSpawnIntervalMs() { return this._sellIntervalMs; },
    _fmtDuration: (ms) => P.fmtDuration(ms, { sec: true }),
    _nextSellAt: 0,
    mc: {
      entity: { position: { x: 120, y: 64, z: -48 } },
      inventory: {
        slots: Array(45).fill(null),
        items: () => [{ name: 'rotten_flesh', displayName: 'Rotten Flesh', count: 64 }],
      },
      scoreboard: {
        1: { title: 'KINGMC', items: [{ displayName: 'Money: 12.4M', value: 1 }] },
      },
    },
    scriptRunner: {
      running: false,
      currentMacro: null,
      list: () => ['afk_jump'],
      async run(name) { this.running = true; this.currentMacro = name; },
      stop() { this.running = false; this.currentMacro = null; },
    },
    reconnectHandler: { attempt: 0, maxRetries: 5, nextAttemptAt: 0, lastError: '' },
    start() { this._disabled = false; this.isOnline = true; this.isConnected = true; this.state.connState = 'ONLINE'; },
    shutdown() { this._disabled = true; this.isOnline = false; this.isConnected = false; this.state.connState = 'DISCONNECTED'; },
    forceReconnect() { this.state.connState = 'RECONNECTING'; this.isReconnecting = true; },
    cmd() {},
    afkJump() { this.state.afk = 'jump'; },
    afkWalk() { this.state.afk = 'walk'; },
    afkStop() { this.state.afk = null; },
    configureSellSpawn(o = {}) {
      if (o.on !== undefined) this._sellSpawnOn = !!o.on;
      if (o.enabled !== undefined) this._sellSpawnOn = !!o.enabled;
      if (o.hour !== undefined || o.minute !== undefined || o.second !== undefined) {
        const sec = (o.hour || 0) * 3600 + (o.minute || 0) * 60 + (o.second || 0);
        this._sellIntervalMs = sec * 1000;
      }
      return { ok: true, on: this._sellSpawnOn };
    },
    runSellSpawnNow() { this._sellSpawnBusy = true; return true; },
    getSellSpawnInfo() { return { on: this._sellSpawnOn, busy: this._sellSpawnBusy, list: this.sellSpawnList, slot: 24, intervalText: '5m' }; },
    _startSpawnerProtect() { this._spawnerProtectOn = true; return true; },
    _stopSpawnerProtect() { this._spawnerProtectOn = false; },
    setSpawnerLevel(n) { this.spawnerLevel = n; },
    getSpawnerLevelInfo() {
      const names = { 1: 'Nhẹ', 2: 'Cân bằng', 3: 'Chặt', 4: 'Tối đa' };
      return { level: this.spawnerLevel, name: names[this.spawnerLevel] || 'Cân bằng', settings: { range: 16 } };
    },
    getProtectStatus() { return { on: this._spawnerProtectOn, level: this.spawnerLevel, name: 'Cân bằng', threats: 0, lastScanAt: now0 }; },
  };
  BotActivity.initSessionActivity(bot);
  mgr.bots.push(bot);

  const printedPanels = [];
  const renderAndSendPhase = async (phaseName, tNow) => {
    await mgr.sendTelegramPanel(bot, { now: tNow });
    const lastCall = sim.calls.at(-1);
    const text = lastCall.body.text;
    printedPanels.push({ phase: phaseName, text });
    console.log(`\n=== [SIMULATION PHASE: ${phaseName}] ===\n${text}`);
    return text;
  };

  // Giai đoạn 1: Đăng nhập (Login)
  bot.state.connState = 'AUTHENTICATING';
  BotActivity.setActivity(bot, 'login', 'Đăng nhập: gõ /login', { now: now0 });
  const p1 = await renderAndSendPhase('1. Đăng nhập', now0 + 1000);
  assert.ok(p1.includes('đang kết nối') && p1.includes('Đăng nhập: gõ /login'));

  // Giai đoạn 2: Đã vào server (In server)
  bot.state.connState = 'ONLINE';
  bot.isOnline = true;
  bot.isConnected = true;
  mgr.revenue.markOnline('bot-1', now0);
  BotActivity.endActivity(bot, 'login', 'Đã vào server thành công', { level: 'ok', now: now0 + 3000 });
  const p2 = await renderAndSendPhase('2. Đã vào server', now0 + 5000);
  assert.ok(p2.includes('ổn định') && p2.includes('Đã vào server thành công'));

  // Giai đoạn 3: Đang bán lồng i/N (Selling spawner 3/5)
  bot._sellSpawnBusy = true;
  BotActivity.setActivity(bot, 'sell', 'Bán lồng 3/5 (vòng #128)', {
    progress: { done: 3, total: 5 },
    now: now0 + 6000,
  });
  const p3 = await renderAndSendPhase('3. Đang bán lồng 3/5', now0 + 20000);
  assert.ok(p3.includes('Bán lồng 3/5 (vòng #128) ▰▰▰▱▱'));

  // Giai đoạn 4: Xong vòng bán, chờ vòng bán tiếp theo (Waiting for next cycle)
  bot._sellSpawnBusy = false;
  bot._nextSellAt = now0 + 185000;
  mgr.revenue.record('bot-1', 250000, { now: now0 + 25000, intervalMs: 300000, hits: 5 });
  BotActivity.endActivity(bot, 'sell', 'Bán xong 5/5 lồng +250K', { level: 'ok', now: now0 + 25000 });
  const p4 = await renderAndSendPhase('4. Chờ vòng bán tiếp theo', now0 + 25000);
  assert.ok(p4.includes('Kế tiếp: vòng bán sau 02:40') && p4.includes('+<b>250K</b>'));

  // Giai đoạn 5: Bị kick và tự kết nối lại (Kick & Reconnect)
  BotActivity.setActivity(bot, 'sell', 'Bán lồng 2/5 (vòng #129)', { progress: { done: 2, total: 5 }, now: now0 + 30000 });
  BotActivity.clearActivities(bot, 'Bị kick khỏi server', now0 + 35000);
  bot.isOnline = false;
  bot.isConnected = false;
  bot.state.connState = 'RECONNECTING';
  bot.state.reconnects = 1;
  bot.reconnectHandler = { attempt: 1, maxRetries: 5, nextAttemptAt: now0 + 50000, lastError: 'Internal Exception' };
  const p5 = await renderAndSendPhase('5. Bị kick & Kết nối lại', now0 + 35000);
  assert.ok(p5.includes(`${sym('retry')} Tình trạng: <b>kết nối lại (lần 1)</b>`));
  assert.ok(p5.includes('Kết nối lại lần 1/5, chờ 15s'));

  // Đưa bot về trạng thái online để kiểm tra toàn bộ lệnh điều khiển qua cả /command và nút bấm
  bot.start();
  bot._sellSpawnBusy = false;
  const bid = P.botShortId('bot-1', ['bot-1']);
  const mid = P.macroShortId('afk_jump', ['afk_jump']);
  let stepTime = now0 + 60000;

  const runCmd = async (rawText) => {
    stepTime += 15000;
    mgr.telegramControl.resetSecurityState();
    return mgr.telegramControl.handleEvent({
      type: 'command',
      rawText,
      from: { id: 555, first_name: 'Operator' },
      chat: { id: 555, type: 'private' },
      now: stepTime,
    });
  };

  const runBtn = async (data) => {
    stepTime += 15000;
    mgr.telegramControl.resetSecurityState();
    return mgr.telegramControl.handleEvent({
      type: 'button',
      data,
      from: { id: 555, first_name: 'Operator' },
      chat: { id: 555, type: 'private' },
      messageId: 500,
      now: stepTime,
    });
  };

  // Kiểm tra mọi lệnh trong mục 9 qua đường /command
  const commandCases = [
    '/start', '/help', '/whoami', '/diag', '/status', '/bots',
    '/bot bot-1', '/panel bot-1', '/activity bot-1 5',
    '/inv bot-1', '/pos bot-1', '/board bot-1', '/ping bot-1',
    '/sell bot-1 status', '/sell bot-1 off', '/sell bot-1 on', '/sell bot-1 every 5m', '/sell bot-1 now',
    '/sellall on', '/sellall now',
    '/protect bot-1 status', '/protect bot-1 on', '/protect bot-1 level 2',
    '/home bot-1', '/afk bot-1', '/stopafk bot-1',
    '/macro bot-1', '/macro bot-1 afk_jump', '/stopmacro bot-1',
    '/events', '/mute 30m', '/mute off', '/refresh 5s',
    '/reconnect bot-1', '/stopbot bot-1', '/startbot bot-1',
  ];
  for (const cText of commandCases) {
    bot._sellSpawnBusy = false;
    bot.isOnline = true;
    bot.state.connState = 'ONLINE';
    if (cText.startsWith('/startbot')) {
      bot._disabled = true;
      bot.isOnline = false;
      bot.state.connState = 'DISCONNECTED';
    }
    const res = await runCmd(cText);
    assert.ok(
      [RESULT_CODES.OK, RESULT_CODES.NOOP].includes(res.code),
      `Command "${cText}" failed with code=${res.code}: ${res.text}`
    );
  }

  // Kiểm tra đường bấm nút (button path) cho mọi tác vụ cố định trên bảng & menu bot
  bot.start();
  bot._sellSpawnBusy = false;
  const buttonCases = [
    `p:${bid}:r`,
    `p:${bid}:m`,
    `p:${bid}:s0`,
    `p:${bid}:s1`,
    `p:${bid}:sn`,
    `p:${bid}:ev:300`,
    `p:${bid}:p1`,
    `p:${bid}:pl2`,
    `p:${bid}:h`,
    `p:${bid}:a1`,
    `p:${bid}:a0`,
    `p:${bid}:mc:${mid}`,
    `p:${bid}:ms`,
    `p:${bid}:iv`,
    `p:${bid}:ps`,
    `p:${bid}:bd`,
    `p:${bid}:ac`,
    `p:${bid}:rc`,
    `p:${bid}:b0`,
    `p:${bid}:b1`,
    `e:disconnect:en:1`,
    `e:disconnect:lo:1`,
  ];
  for (const bData of buttonCases) {
    bot._sellSpawnBusy = false;
    if (bData.endsWith(':b1')) {
      bot._disabled = true;
      bot.isOnline = false;
      bot.state.connState = 'DISCONNECTED';
    } else {
      bot._disabled = false;
      bot.isOnline = true;
      bot.state.connState = 'ONLINE';
    }
    const res = await runBtn(bData);
    assert.ok(
      [RESULT_CODES.OK, RESULT_CODES.NOOP].includes(res.code),
      `Button "${bData}" failed with code=${res.code}: ${res.text}`
    );
  }

  await mgr.flushGracefulShutdown(1000);
  mgr.shutdown();
  sim.server.close();
  console.log('\nsimulation.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
