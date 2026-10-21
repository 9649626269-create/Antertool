'use strict';
// Kiểm tra điều khiển từ xa TelegramControl, phân quyền RBAC, bảo mật redaction & chaos testing (Section 9, 10 & Section 13 mục 4, 5, 10).
const assert = require('assert');
const http = require('http');

const { TelegramControl, RESULT_CODES } = require('../src/core/TelegramControl');
const TelegramNotifier = require('../src/core/TelegramNotifier');
const TelegramLogger = require('../src/core/TelegramLogger');
const P = require('../src/core/TelegramPanel');
const BotActivity = require('../src/core/BotActivity');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function createMockBot(id, overrides = {}) {
  const calls = [];
  const bot = {
    cfg: {
      id,
      username: `acc_${id}`,
      macros: {
        afk_jump: { steps: 'chat /afk' },
        mualong: { steps: 'chat /shop' },
      },
    },
    state: {
      connState: 'ONLINE',
      reconnects: 0,
      ping: 38,
      dimension: 'overworld',
      position: { x: 100, y: 64, z: -50 },
      afk: null,
    },
    isOnline: true,
    isConnected: true,
    isReconnecting: false,
    _disabled: false,
    _sellSpawnOn: false,
    _sellSpawnBusy: false,
    _spawnerBusy: false,
    _spawnerProtectOn: false,
    spawnerLevel: 2,
    protectedSpawners: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }],
    sellSpawnList: [{ x: 1, y: 64, z: 1 }, { x: 2, y: 64, z: 2 }],
    _sellIntervalMs: 300000,
    _calls: calls,
    mc: {
      entity: { position: { x: 100, y: 64, z: -50 } },
      inventory: {
        slots: Array(45).fill(null),
        items: () => [
          { name: 'iron_ingot', displayName: 'Iron Ingot', count: 64 },
          { name: 'gold_ingot', displayName: 'Gold Ingot', count: 32 },
        ],
      },
      scoreboard: {
        1: {
          title: '§a§lKINGMC',
          items: [
            { displayName: '§fXu: §e12.4M', value: 2 },
            { displayName: '§fShard: §b450', value: 1 },
          ],
        },
      },
    },
    scriptRunner: {
      running: false,
      currentMacro: null,
      list: () => ['afk_jump', 'mualong'],
      async run(name) { calls.push(['macro.run', name]); this.running = true; this.currentMacro = name; },
      stop() { calls.push(['macro.stop']); this.running = false; this.currentMacro = null; },
    },
    start() { calls.push(['start']); this._disabled = false; this.isOnline = true; this.isConnected = true; this.state.connState = 'ONLINE'; },
    shutdown() { calls.push(['shutdown']); this._disabled = true; this.isOnline = false; this.isConnected = false; this.state.connState = 'DISCONNECTED'; },
    forceReconnect(r) { calls.push(['forceReconnect', r]); },
    cmd(text) { calls.push(['cmd', text]); },
    afkJump() { calls.push(['afkJump']); this.state.afk = 'jump'; },
    afkWalk() { calls.push(['afkWalk']); this.state.afk = 'walk'; },
    afkStop() { calls.push(['afkStop']); this.state.afk = null; },
    _fmtDuration: (ms) => P.fmtDuration(ms, { sec: true }),
    _sellSpawnIntervalMs() { return this._sellIntervalMs; },
    configureSellSpawn(opts = {}) {
      calls.push(['configureSellSpawn', opts]);
      if (opts.on !== undefined) this._sellSpawnOn = !!opts.on;
      if (opts.enabled !== undefined) this._sellSpawnOn = !!opts.enabled;
      if (opts.hour !== undefined || opts.minute !== undefined || opts.second !== undefined) {
        const sec = (opts.hour || 0) * 3600 + (opts.minute || 0) * 60 + (opts.second || 0);
        this._sellIntervalMs = sec * 1000;
        this._sellIntervalSec = sec;
      }
      return { ok: true, on: this._sellSpawnOn };
    },
    runSellSpawnNow() { calls.push(['runSellSpawnNow']); return true; },
    getSellSpawnInfo() {
      return {
        on: this._sellSpawnOn,
        busy: this._sellSpawnBusy,
        list: this.sellSpawnList,
        slot: 24,
        intervalText: P.fmtDuration(this._sellIntervalMs),
      };
    },
    _startSpawnerProtect() { this._spawnerProtectOn = true; return true; },
    _stopSpawnerProtect() { this._spawnerProtectOn = false; },
    setSpawnerLevel(n) { this.spawnerLevel = n; },
    getSpawnerLevelInfo() {
      const names = { 1: 'Nhẹ', 2: 'Cân bằng', 3: 'Chặt', 4: 'Tối đa' };
      return { level: this.spawnerLevel, name: names[this.spawnerLevel] || 'Cân bằng', settings: { range: 16 } };
    },
    getProtectStatus() {
      return { on: this._spawnerProtectOn, level: this.spawnerLevel, name: 'Cân bằng', threats: 0, lastScanAt: Date.now() - 2000 };
    },
    ...overrides,
  };
  BotActivity.initSessionActivity(bot);
  return bot;
}

(async () => {
  let now = 1700000000000;
  const auditLogs = [];
  const dirtyBots = [];
  const deletedMessages = [];

  const b1 = createMockBot('bot-1');
  const b2 = createMockBot('bot-2');
  const bots = [b1, b2];

  const config = {
    telegramChatId: '555',
    telegramAdmins: ['1001'],
    telegramAllowedUsers: ['2002'],
    telegramControlEnabled: true,
    telegramConfirmDanger: true,
    telegramCommandTtlSec: 120,
    telegramTimezone: 'Asia/Ho_Chi_Minh',
    telegramRefreshSec: 1,
    telegramMuteUntil: 0,
    telegramEvents: ['disconnect', 'sellFailed'],
    telegramLoudEvents: ['disconnect', 'sellFailed'],
    telegramSellCycleNotify: false,
    telegramCmdDenylist: ['login', 'l', 'register', 'reg', 'changepassword', 'cp', 'unregister', 'pay'],
  };

  const fakeManager = {
    bots,
    _config: config,
    findBot: (id) => bots.find(b => b.cfg.id === id) || null,
    telegram: {
      chatId: '555',
      botUsername: 'anter_bot',
      events: new Set(['disconnect', 'sellFailed']),
      getDiag: () => ({
        queueLen: 0,
        pausedUntil: 0,
        lastSuccessAt: now - 5000,
        lastError: 'HTTP 500 tại https://api.telegram.org/bot123456789:ABCDEF1234567890abcdef1234567890abc/sendMessage',
        count429: 1,
        droppedCount: 0,
      }),
      deleteMessage: async (mid) => { deletedMessages.push(mid); return true; },
    },
    revenue: {
      stats: () => ({ total: 1000000, last1h: 100000, avgPerHour: 100000, perDayEst: 2400000, observedMs: 3600000 }),
      uptime: () => ({ totalMs: 3600000, sessionMs: 3600000, online: true }),
    },
    _botPanelInfo: (b) => ({
      botId: b.cfg.id,
      allBotIds: bots.map(x => x.cfg.id),
      shortId: P.botShortId(b.cfg.id, bots.map(x => x.cfg.id)),
      account: b.cfg.username,
      connState: b.state.connState,
      disabled: b._disabled,
      sellOn: b._sellSpawnOn,
      sellBusy: b._sellSpawnBusy,
      protect: b.getProtectStatus(),
      macros: b.scriptRunner.list(),
      now,
    }),
    _panelRelevant: () => true,
    markPanelDirty: (id) => dirtyBots.push(id),
    setTelegramOption: (k, v) => { config[k] = v; },
    getSchedule: () => ({ enabled: true, outTime: '23:00', inTime: '06:00' }),
    setSchedule: (en, o, i) => { config.schedule = { enabled: en, outTime: o, inTime: i }; return config.schedule; },
    runtimeLog: (lvl, msg) => auditLogs.push({ lvl, msg }),
    sendTelegramPanel: async () => true,
    refreshTelegramPanels: () => 2,
    _tgLogsCommand: async () => {},
  };

  const ctrl = new TelegramControl({
    manager: fakeManager,
    nowFn: () => now,
  });

  const adminCtx = (text) => ({
    type: 'command',
    rawText: text,
    from: { id: 1001, first_name: 'AdminUser' },
    chat: { id: 555, type: 'supergroup' },
    messageId: 901,
    now,
  });

  const viewerCtx = (text) => ({
    type: 'command',
    rawText: text,
    from: { id: 2002, first_name: 'ViewerUser' },
    chat: { id: 555, type: 'supergroup' },
    messageId: 902,
    now,
  });

  // ---------- 1) resolveBot: khớp chính xác, số thứ tự 1-based, tiền tố không dấu, mơ hồ, không tìm thấy ----------
  assert.strictEqual(ctrl.resolveBot('bot-1').code, RESULT_CODES.OK);
  assert.strictEqual(ctrl.resolveBot('1').bot.cfg.id, 'bot-1');
  assert.strictEqual(ctrl.resolveBot('2').bot.cfg.id, 'bot-2');
  assert.strictEqual(ctrl.resolveBot('bo').code, RESULT_CODES.AMBIGUOUS);
  assert.strictEqual(ctrl.resolveBot('xyz').code, RESULT_CODES.NOT_FOUND);

  // ---------- 2) Phân quyền RBAC: viewer xem được nhưng bị chặn điều khiển; nhóm rỗng admin -> không ai là admin ----------
  for (const vCmd of ['/status', '/bots', '/inv bot-1', '/pos bot-1', '/board bot-1', '/ping bot-1', '/activity bot-1 5', '/whoami', '/help']) {
    now += 3000;
    assert.strictEqual((await ctrl.handleEvent(viewerCtx(vCmd))).code, RESULT_CODES.OK, `Viewer cmd ${vCmd} should succeed`);
  }

  now += 15000;
  const deniedView = await ctrl.handleEvent(viewerCtx('/sell bot-1 on'));
  assert.strictEqual(deniedView.code, RESULT_CODES.DENIED);
  assert.strictEqual(deniedView.text, 'Không có quyền.');

  // Nhóm có telegramAdmins = [] -> không ai là admin
  config.telegramAdmins = [];
  const deniedEmptyGroup = await ctrl.handleEvent(adminCtx('/sell bot-1 on'));
  assert.strictEqual(deniedEmptyGroup.code, RESULT_CODES.DENIED);
  config.telegramAdmins = ['1001'];

  // Chat lạ, tin từ bot, edited_message, channel_post, sender_chat -> bị bỏ qua hoàn toàn
  assert.strictEqual((await ctrl.handleEvent({ ...adminCtx('/status'), chat: { id: 999, type: 'private' } })).silentIgnore, true);
  assert.strictEqual((await ctrl.handleEvent({ ...adminCtx('/status'), from: { id: 1001, is_bot: true } })).silentIgnore, true);
  assert.strictEqual((await ctrl.handleEvent({ ...adminCtx('/status'), isEdited: true })).silentIgnore, true);
  assert.strictEqual((await ctrl.handleEvent({ ...adminCtx('/status'), isChannelPost: true })).silentIgnore, true);
  assert.strictEqual((await ctrl.handleEvent({ ...adminCtx('/status'), senderChat: { id: -1001 } })).silentIgnore, true);

  // @botname: chấp nhận @anter_bot, bỏ qua @other_bot
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/status@anter_bot'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/status@other_bot'))).silentIgnore, true);

  // ---------- 3) Mọi lệnh điều khiển & tính chất idempotent (NOOP), OFFLINE, BUSY ----------
  ctrl.resetSecurityState();
  // /sell on -> OK, gọi lại /sell on -> NOOP
  let r = await ctrl.handleEvent(adminCtx('/sell bot-1 on'));
  assert.strictEqual(r.code, RESULT_CODES.OK);
  assert.strictEqual(b1._sellSpawnOn, true);
  r = await ctrl.handleEvent(adminCtx('/sell bot-1 on'));
  assert.strictEqual(r.code, RESULT_CODES.NOOP);
  assert.ok(r.text.includes('đã bật sẵn'));

  // /sell every 5m
  now += 15000;
  r = await ctrl.handleEvent(adminCtx('/sell bot-1 every 5m'));
  assert.strictEqual(r.code, RESULT_CODES.OK);
  assert.strictEqual(b1._sellIntervalSec, 300);

  // /sell now khi đang bận -> BUSY
  b1._sellSpawnBusy = true;
  r = await ctrl.handleEvent(adminCtx('/sell bot-1 now'));
  assert.strictEqual(r.code, RESULT_CODES.BUSY);
  b1._sellSpawnBusy = false;

  // /sell now khi offline -> OFFLINE
  b1.isOnline = false;
  b1.state.connState = 'RECONNECTING';
  b1.state.reconnects = 2;
  r = await ctrl.handleEvent(adminCtx('/sell bot-1 now'));
  assert.strictEqual(r.code, RESULT_CODES.OFFLINE);
  b1.isOnline = true;
  b1.state.connState = 'ONLINE';

  // /protect, /home, /afk, /stopafk, /macro, /stopmacro, /mute, /refresh, /events, /diag
  now += 15000;
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/protect bot-1 on'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/protect bot-1 level 3'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/home bot-1'))).code, RESULT_CODES.OK);
  now += 15000;
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/afk bot-1'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/stopafk bot-1'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/macro bot-1'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/macro bot-1 mualong'))).code, RESULT_CODES.OK);
  now += 15000;
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/macro bot-1 ../etc/passwd'))).code, RESULT_CODES.NOT_FOUND, 'macro chỉ cho phép theo allow-list');
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/stopmacro bot-1'))).code, RESULT_CODES.OK);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/mute 30m'))).code, RESULT_CODES.OK);
  assert.ok(config.telegramMuteUntil > now);
  now += 15000;
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/mute off'))).code, RESULT_CODES.OK);
  assert.strictEqual(config.telegramMuteUntil, 0);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/refresh 10s'))).code, RESULT_CODES.OK);
  assert.strictEqual(config.telegramRefreshSec, 10);
  assert.strictEqual((await ctrl.handleEvent(adminCtx('/events'))).code, RESULT_CODES.OK);
  const diagRes = await ctrl.handleEvent(adminCtx('/diag'));
  assert.strictEqual(diagRes.code, RESULT_CODES.OK);
  assert.ok(!diagRes.text.includes('ABCDEF1234567890'), '/diag phải che bot token trong lỗi gần nhất');

  // ---------- 4) Xác nhận hành động nguy hiểm (30s, 1 lần, gắn với user + chat) ----------
  now += 15000;
  const askStopAll = await ctrl.handleEvent(adminCtx('/stopbot all'));
  assert.strictEqual(askStopAll.code, RESULT_CODES.CONFIRM_REQUIRED);
  assert.ok(askStopAll.confirm && askStopAll.confirm.token);
  const token = askStopAll.confirm.token;
  assert.strictEqual(token.length, 12);

  // Người khác bấm xác nhận -> bị từ chối
  const wrongUserConfirm = await ctrl.handleEvent({
    type: 'button',
    data: `c:${token}:y`,
    from: { id: 9999, first_name: 'OtherAdmin' },
    chat: { id: 555, type: 'supergroup' },
    now,
  });
  assert.strictEqual(wrongUserConfirm.code, RESULT_CODES.DENIED);

  // Đúng người bấm xác nhận -> thực thi
  const okConfirm = await ctrl.handleEvent({
    type: 'button',
    data: `c:${token}:y`,
    from: { id: 1001, first_name: 'AdminUser' },
    chat: { id: 555, type: 'supergroup' },
    now,
  });
  assert.strictEqual(okConfirm.code, RESULT_CODES.OK);
  assert.strictEqual(b1.isOnline, false);
  assert.strictEqual(b2.isOnline, false);

  // Bấm lại cùng token lần 2 (replay) -> EXPIRED
  const replayConfirm = await ctrl.handleEvent({
    type: 'button',
    data: `c:${token}:y`,
    from: { id: 1001, first_name: 'AdminUser' },
    chat: { id: 555, type: 'supergroup' },
    now,
  });
  assert.strictEqual(replayConfirm.code, RESULT_CODES.EXPIRED);

  // Khởi động lại cả dàn
  now += 15000;
  await ctrl.handleEvent(adminCtx('/startbot all'));
  assert.strictEqual(b1.isOnline, true);
  assert.strictEqual(b2.isOnline, true);

  // Token quá 30s -> EXPIRED
  b1._sellSpawnOn = true;
  const askSellAllOff = await ctrl.handleEvent(adminCtx('/sellall off'));
  assert.strictEqual(askSellAllOff.code, RESULT_CODES.CONFIRM_REQUIRED);
  now += 31000;
  const expiredRes = await ctrl.handleEvent({
    type: 'button',
    data: `c:${askSellAllOff.confirm.token}:y`,
    from: { id: 1001, first_name: 'AdminUser' },
    chat: { id: 555, type: 'supergroup' },
    now,
  });
  assert.strictEqual(expiredRes.code, RESULT_CODES.EXPIRED);

  // ---------- 5) /cmd & /cmdall: chặn denylist, luôn bắt xác nhận kể cả khi telegramConfirmDanger: false ----------
  for (const blocked of ['/login pass123', 'l pass123', '/register p p', '/changepassword a b', '/pay Alex 1000']) {
    now += 15000;
    const rBlocked = await ctrl.handleEvent(adminCtx(`/cmd bot-1 ${blocked}`));
    assert.strictEqual(rBlocked.code, RESULT_CODES.DENIED, `Command "${blocked}" must be blocked by denylist`);
    assert.ok(rBlocked.text.includes('Lệnh này bị chặn qua Telegram'));
  }
  assert.ok(deletedMessages.includes(901), 'tự động gọi deleteMessage khi phát hiện lệnh nhạy cảm trên Telegram');

  ctrl.resetSecurityState();
  config.telegramConfirmDanger = false;
  now += 15000;
  const askCmd = await ctrl.handleEvent(adminCtx('/cmd bot-1 /spawn'));
  assert.strictEqual(askCmd.code, RESULT_CODES.CONFIRM_REQUIRED);
  assert.ok(askCmd.confirm && askCmd.confirm.token, '/cmd luôn yêu cầu xác nhận kể cả khi telegramConfirmDanger = false');
  config.telegramConfirmDanger = true;

  // ---------- 6) Giới hạn tốc độ (5 lệnh / 10s) & Khoá tạm thời 10 phút sau 5 lần bị từ chối ----------
  ctrl.resetSecurityState();
  now += 20000;
  for (let i = 0; i < 5; i++) {
    assert.strictEqual((await ctrl.handleEvent(adminCtx('/ping bot-1'))).code, RESULT_CODES.OK);
  }
  const rateLimited = await ctrl.handleEvent(adminCtx('/ping bot-1'));
  assert.strictEqual(rateLimited.code, RESULT_CODES.RATE_LIMITED);
  assert.ok(rateLimited.text.includes('Quá nhanh, thử lại sau'));

  // 5 lần bị từ chối quyền trong 60s -> khoá 10 phút (silentIgnore)
  ctrl.resetSecurityState();
  for (let i = 0; i < 5; i++) {
    now += 3000;
    const dRes = await ctrl.handleEvent(viewerCtx('/stopbot bot-1'));
    assert.strictEqual(dRes.code, RESULT_CODES.DENIED);
  }
  const lockedOut = await ctrl.handleEvent(viewerCtx('/status'));
  assert.strictEqual(lockedOut.silentIgnore, true, 'user bị khoá tạm thời 10 phút sau 5 lần bị từ chối');

  // ---------- 7) Bỏ qua backlog khi khởi động & kiểm tra TTL theo giờ server Telegram ----------
  const updates = [
    { update_id: 50, message: { message_id: 1, date: Math.floor(now / 1000) - 500, chat: { id: 555 }, text: '/status' } },
  ];
  const srv = http.createServer((req, res) => {
    const method = req.url.split('/').pop();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Date', new Date(now).toUTCString());
    if (method === 'getUpdates') {
      return res.end(JSON.stringify({ ok: true, result: updates.splice(0) }));
    }
    res.end(JSON.stringify({ ok: true, result: true }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const receivedAfterBacklog = [];
  const tgBacklog = new TelegramNotifier({
    apiBase: `http://127.0.0.1:${port}`,
    token: '123456789:' + 'Z'.repeat(35),
    chatId: '555',
    discardBacklog: true,
    commandTtlSec: 120,
  });
  tgBacklog.startPolling(ev => receivedAfterBacklog.push(ev));
  await sleep(120);
  assert.strictEqual(receivedAfterBacklog.length, 0, 'update tồn đọng lúc khởi động bị bỏ qua');
  updates.push(
    { update_id: 51, message: { message_id: 2, date: Math.floor(now / 1000) - 300, chat: { id: 555 }, text: '/status' } },
    { update_id: 52, message: { message_id: 3, date: Math.floor(now / 1000) + 1, chat: { id: 555 }, text: '/panel' } }
  );
  await sleep(220);
  tgBacklog.stopPolling();
  srv.close();
  assert.deepStrictEqual(receivedAfterBacklog.map(e => e.cmd), ['panel'], 'chỉ nhận lệnh còn hạn TTL');

  // ---------- 8) Kiểm tra Redaction (Mục 10.5 & 13.5) ----------
  const rawDirty = [
    'Token URL: https://api.telegram.org/bot123456789:AAH_secret_token_12345678901234567890/sendMessage',
    'Proxy: socks5://myuser:superSecretPass@10.20.30.40:1080 lỗi kết nối',
    'Discord: https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'Game login: /login MatKhauCucManh123',
    'JSON: {"botPassword":"MySecretPassword999","telegramToken":"987654321:BBH_another_secret_token_123456789012"}',
  ].join('\n');

  const redacted = TelegramLogger.redactStatic(rawDirty, ['CustomPass777']);
  assert.ok(!redacted.includes('AAH_secret_token'), 'phải che Telegram token trong URL');
  assert.ok(!redacted.includes('myuser:superSecretPass'), 'phải che user:pass@ của proxy');
  assert.ok(redacted.includes('socks5://***:***@10.20.30.40:1080'), 'giữ đúng mẫu scheme://***:***@');
  assert.ok(!redacted.includes('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'), 'phải che Discord webhook token');
  assert.ok(!redacted.includes('MatKhauCucManh123'), 'phải che mật khẩu sau /login');
  assert.ok(!redacted.includes('MySecretPassword999'), 'phải che botPassword trong JSON');

  for (const entry of auditLogs) {
    assert.ok(!/pass123|MatKhau|AAH_secret/i.test(entry.msg), `Audit log leaked secret: ${entry.msg}`);
  }

  // ---------- 9) Chaos Testing (Mục 13.10): hook hoặc notifier ném lỗi / treo không làm vỡ luồng bot ----------
  const chaosSession = createMockBot('chaos-bot');
  chaosSession.emit = () => { throw new Error('Simulated listener crash'); };
  assert.doesNotThrow(() => {
    BotActivity.setActivity(chaosSession, 'sell', 'Bán lồng 1/5', { progress: { done: 1, total: 5 } });
    BotActivity.endActivity(chaosSession, 'sell', 'Xong vòng bán');
    BotActivity.clearActivities(chaosSession, 'Ngắt kết nối');
  }, 'setActivity / endActivity / clearActivities phải nuốt mọi ngoại lệ từ listener');

  console.log('telegram-control.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
