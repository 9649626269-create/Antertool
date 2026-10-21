'use strict';
// Kiểm tra NotificationCenter (Section 6, 8, 12 & Section 13 mục 3, 8, 9, 11):
// - Render đủ 19 loại sự kiện + lưu golden snapshots vào test/fixtures/events-golden.json
// - Gộp trùng (dedup ×N · lần cuối HH:MM:SS), storm control (gộp vào tin tổng hợp), mute vs crit
// - Hàng đợi giới hạn (200), thứ tự ưu tiên P0..P5, nhãn (trễ Xm)
// - Đủ bảng mã lỗi Telegram (Section 12: 401, 403, 400 not modified, 400 not found, 400 can't parse entities -> plain text, 400 migrate_to_chat_id, 409, 429, 5xx)
// - Bảo toàn 100% payload Discord cũ (Discord golden parity) & migrateTelegramConfig idempotent
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const TelegramNotifier = require('../src/core/TelegramNotifier');
const Notifier = require('../src/core/Notifier');
const DiscordTheme = require('../src/core/DiscordTheme');
const { NotificationCenter, EVENT_CATALOG, renderEventMessage } = require('../src/core/NotificationCenter');
const { migrateTelegramConfig, normalizeTelegramConfig } = require('../src/core/ConfigValidator');
const { sym, setSymbolSet } = require('../src/core/Symbols');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startControlledTelegramServer() {
  const calls = [];
  const state = {
    nextId: 200,
    customResponder: null,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body, url: req.url });
      const sendJson = (status, obj) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Date', new Date().toUTCString());
        res.end(JSON.stringify(obj));
      };
      if (state.customResponder) {
        const handled = state.customResponder({ method, body, url: req.url, sendJson, res, state });
        if (handled) return;
      }
      if (method === 'sendMessage') return sendJson(200, { ok: true, result: { message_id: state.nextId++ } });
      if (method === 'editMessageText') return sendJson(200, { ok: true, result: { message_id: body.message_id } });
      if (method === 'answerCallbackQuery') return sendJson(200, { ok: true, result: true });
      if (method === 'getUpdates') return sendJson(200, { ok: true, result: [] });
      sendJson(200, { ok: true, result: true });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    server,
    calls,
    state,
    base: `http://127.0.0.1:${server.address().port}`,
  })));
}

(async () => {
  setSymbolSet('unicode');
  const now = 1700000000000;

  // ---------- 1) Render đủ tất cả sự kiện trong EVENT_CATALOG & Golden Snapshots ----------
  const fakeBot = {
    cfg: { id: 'bot-1', username: 'Steve' },
    state: { connState: 'ONLINE', reconnects: 1 },
    isOnline: true,
    _sellSpawnOn: true,
    _sellSpawnBusy: true,
    _sellSpawnerIdx: 3,
    _sellSpawnerTotal: 5,
    _sellCycleNum: 128,
    _lastDisconnectActivity: { text: 'Bán lồng 3/5 (vòng #128)', ts: now - 2000 },
  };

  const eventSamples = {
    disconnect: {
      key: 'disconnect',
      bot: 'bot-1',
      botSession: fakeBot,
      reason: 'Đã xảy ra lỗi nội bộ…',
      uptimeText: '3h12m',
      nextPlan: 'tự kết nối lại sau 15s (lần 1/5)',
      now,
    },
    reconnectFailed: {
      key: 'reconnectFailed',
      bot: 'bot-1',
      fields: [['Số lần thử', '5/5'], ['Lỗi cuối', 'ECONNREFUSED'], ['Proxy', 'socks5://***:***@1.2.3.4:1080']],
      now,
    },
    reconnectRecovered: {
      key: 'reconnectRecovered',
      bot: 'bot-1',
      fields: [['Sau số lần thử', '2'], ['Thời gian gián đoạn', '32s']],
      now,
    },
    connected: {
      key: 'connected',
      bot: 'bot-1',
      fields: [['Đăng nhập', 'OK'], ['Antibot', 'OK'], ['Menu', 'OK'], ['Thời gian', '3.2s']],
      now,
    },
    featuresReady: {
      key: 'featuresReady',
      bot: 'bot-1',
      fields: [['AutoSell', 'OK (5 lồng)'], ['Protect', 'OK (mức 2)']],
      now,
    },
    sellCycle: {
      key: 'sellCycle',
      bot: 'bot-1',
      fields: [['Số lồng', '5/5'], ['Thu về', '+250K'], ['Vòng kế tiếp', 'sau 05:00']],
      now,
    },
    sellFailed: {
      key: 'sellFailed',
      bot: 'bot-1',
      fields: [['Lỗi lồng', 'Lồng #2 không mở được GUI'], ['Số lần thử /home', '10/10']],
      now,
    },
    homeReturn: {
      key: 'homeReturn',
      bot: 'bot-1',
      fields: [['Toạ độ lệch', 'x:140 y:64 z:-20 (lệch 28m)'], ['Lệnh đã gõ', '/home treolong']],
      now,
    },
    spawnerThreat: {
      key: 'spawnerThreat',
      bot: 'bot-1',
      botSession: fakeBot,
      fields: [['Loại', 'người chơi (Alex_VN) · cách 12 block · lồng 3/5'], ['Bot đang', 'tạm dừng bán, xử lý lồng 3']],
      now,
    },
    protectResult: {
      key: 'protectResult',
      bot: 'bot-1',
      level: 'ok',
      fields: [['Kết quả', 'Đã đào an toàn 2/2 lồng'], ['Thời gian', '4.1s']],
      now,
    },
    autoSell: {
      key: 'autoSell',
      bot: 'bot-1',
      fields: [['Số ô đầy', '36/36'], ['Macro đã chạy', 'autosell']],
      now,
    },
    moneyGoal: {
      key: 'moneyGoal',
      bot: 'bot-1',
      fields: [['Số dư', '50M / 50M'], ['Macro đã chạy', 'chuyen_tien']],
      now,
    },
    autoOrder: {
      key: 'autoOrder',
      bot: 'bot-1',
      fields: [['Đã giao', '64 stack'], ['Thu về', '+12.8M'], ['Uptime', '2h 15m']],
      now,
    },
    schedule: {
      key: 'schedule',
      fields: [['Giờ nghỉ', '23:00'], ['Vào lại lúc', '06:00'], ['Số bot', '4']],
      now,
    },
    macro: {
      key: 'macro',
      bot: 'bot-1',
      fields: [['Macro', 'mualong'], ['Bước', '3/8'], ['Trạng thái', 'Đang chạy']],
      now,
    },
    proxy: {
      key: 'proxy',
      bot: 'bot-1',
      fields: [['Chuyển đổi', 'socks5://***:***@1.1.1.1:1080 → socks5://***:***@2.2.2.2:1080']],
      now,
    },
    posLost: {
      key: 'posLost',
      bot: 'bot-1',
      fields: [['Toạ độ hiện tại', 'x:0 y:80 z:0'], ['Số lần thử', '2/5']],
      now,
    },
    system: {
      key: 'system',
      fields: [['Phiên bản', '1.0.0'], ['Số bot', '2'], ['Tính năng', 'Telegram, FileLog']],
      now,
    },
    revenue: {
      key: 'revenue',
      bot: 'bot-1',
      fields: [['Tổng thu nhập', '$12.4M'], ['Tốc độ', '$1.1M/ngày']],
      now,
    },
  };

  const renderedSnapshot = {};
  for (const [key, sample] of Object.entries(eventSamples)) {
    const r = renderEventMessage(sample, { tz: 'Asia/Ho_Chi_Minh', allBotIds: ['bot-1'] });
    assert.ok(r.text.includes(EVENT_CATALOG[key].title), `Event ${key} must include Vietnamese title`);
    renderedSnapshot[key] = { text: r.text, keyboard: r.keyboard, level: r.level };
  }
  // Kiểm tra nút bấm trên disconnect và spawnerThreat
  assert.strictEqual(renderedSnapshot.disconnect.keyboard[0].length, 2);
  assert.ok(renderedSnapshot.disconnect.text.includes('Đang làm lúc đó: Bán lồng 3/5 (vòng #128)'));
  assert.strictEqual(renderedSnapshot.spawnerThreat.keyboard[0].length, 2);

  const fixturesDir = path.join(__dirname, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const goldenEventsPath = path.join(fixturesDir, 'events-golden.json');
  if (!fs.existsSync(goldenEventsPath)) {
    fs.writeFileSync(goldenEventsPath, JSON.stringify(renderedSnapshot, null, 2) + '\n', 'utf8');
  }
  const savedEventsGolden = JSON.parse(fs.readFileSync(goldenEventsPath, 'utf8'));
  assert.deepStrictEqual(renderedSnapshot, savedEventsGolden, 'Event renders match golden snapshots in test/fixtures/events-golden.json');

  // ---------- 2) Dedup, Mute vs Crit, sellCycle gating, Storm Control ----------
  const mock = await startControlledTelegramServer();
  let curNow = now;
  const tg = new TelegramNotifier({
    apiBase: mock.base,
    token: '123456789:' + 'A'.repeat(35),
    chatId: '555',
    events: ['all'],
    nowFn: () => curNow,
  });
  let cfg = {
    telegramTimezone: 'Asia/Ho_Chi_Minh',
    telegramSellCycleNotify: false,
    telegramMuteUntil: 0,
    telegramMuteCrit: false,
    telegramLoudEvents: ['disconnect', 'reconnectFailed', 'sellFailed', 'spawnerThreat'],
  };
  const center = new NotificationCenter({
    getTelegram: () => tg,
    getConfig: () => cfg,
    getBots: () => [fakeBot],
    nowFn: () => curNow,
  });

  // 2a. sellCycle bị tắt mặc định khi telegramSellCycleNotify = false
  mock.calls.length = 0;
  center.emit({ key: 'sellCycle', bot: 'bot-1', fields: [['Thu về', '+250K']] });
  await sleep(60);
  assert.strictEqual(mock.calls.length, 0, 'sellCycle tắt mặc định');
  cfg.telegramSellCycleNotify = true;
  center.emit({ key: 'sellCycle', bot: 'bot-1', fields: [['Thu về', '+250K']] });
  await sleep(60);
  assert.strictEqual(mock.calls.length, 1);
  assert.strictEqual(mock.calls[0].body.disable_notification, true, 'sellCycle là info -> gửi im lặng');

  // 2b. Dedup trong cửa sổ 30s: lần 2 sửa lại tin đầu kèm ×2 · lần cuối HH:MM:SS
  mock.calls.length = 0;
  center.emit({ key: 'homeReturn', bot: 'bot-1', cause: 'Lệch toạ độ', fingerprint: 'drift-1' });
  await sleep(60);
  assert.strictEqual(mock.calls.length, 1);
  assert.strictEqual(mock.calls[0].method, 'sendMessage');
  curNow += 5000;
  center.emit({ key: 'homeReturn', bot: 'bot-1', cause: 'Lệch toạ độ', fingerprint: 'drift-1' });
  await sleep(60);
  assert.strictEqual(mock.calls.length, 2);
  assert.strictEqual(mock.calls[1].method, 'editMessageText');
  assert.ok(mock.calls[1].body.text.includes(`${sym('mult')}2`) && mock.calls[1].body.text.includes('lần cuối'));

  // 2c. Loud vs Quiet & Mute: crit rung (disable_notification: false), kể cả khi đang mute (trừ khi telegramMuteCrit: true)
  cfg.telegramLoudEvents = ['disconnect', 'homeReturn'];
  cfg.telegramMuteUntil = curNow + 600000; // Đang mute 10 phút
  mock.calls.length = 0;
  center.emit({ key: 'homeReturn', bot: 'bot-1', cause: 'Lệch mới', fingerprint: 'drift-2' });
  center.emit({ key: 'disconnect', bot: 'bot-1', reason: 'Server restart', fingerprint: 'disc-1' });
  await sleep(80);
  const homeCall = mock.calls.find(c => c.body.text.includes('Lệch vị trí'));
  const discCall = mock.calls.find(c => c.body.text.includes('Mất kết nối'));
  assert.strictEqual(homeCall.body.disable_notification, true, 'mute biến thông báo thường thành im lặng, không làm mất tin');
  assert.strictEqual(discCall.body.disable_notification, false, 'crit bỏ qua mute khi telegramMuteCrit = false');

  cfg.telegramMuteCrit = true;
  mock.calls.length = 0;
  center.emit({ key: 'disconnect', bot: 'bot-1', reason: 'Server restart 2', fingerprint: 'disc-2' });
  await sleep(60);
  assert.strictEqual(mock.calls[0].body.disable_notification, true, 'telegramMuteCrit = true làm im lặng cả crit');
  cfg.telegramMuteUntil = 0;
  cfg.telegramMuteCrit = false;

  // 2d. Storm control: quá 6 thông báo có tiếng không phải crit trong 60s -> gộp vào 1 tin digest sửa tại chỗ
  center.resetState();
  cfg.telegramLoudEvents = ['homeReturn', 'disconnect'];
  mock.calls.length = 0;
  for (let i = 1; i <= 8; i++) {
    center.emit({ key: 'homeReturn', bot: 'bot-1', cause: `Lệch lần ${i}`, fingerprint: `storm-${i}` });
  }
  await sleep(120);
  const digestSend = mock.calls.find(c => c.method === 'sendMessage' && c.body.text.includes('sự kiện đã được gộp trong 60s'));
  const digestEdit = mock.calls.find(c => c.method === 'editMessageText' && c.body.text.includes('2 sự kiện đã được gộp trong 60s'));
  assert.ok(digestSend, 'tin thứ 7 tạo tin gộp (digest)');
  assert.ok(digestEdit, 'tin thứ 8 sửa tại chỗ tin gộp lên 2 sự kiện');

  // ---------- 3) Hàng đợi ưu tiên P0..P5, giới hạn 200 tin, và nhãn (trễ Xm) ----------
  const order = [];
  const tgPrio = new TelegramNotifier({
    apiBase: mock.base,
    token: '123456789:' + 'P'.repeat(35),
    chatId: '555',
    maxQueue: 5,
    maxAgeSec: 600,
  });
  mock.state.customResponder = ({ method, body, sendJson }) => {
    if (method === 'sendMessage') {
      order.push(body.text);
      setTimeout(() => sendJson(200, { ok: true, result: { message_id: mock.state.nextId++ } }), 20);
      return true;
    }
    return false;
  };
  // Đẩy tin đầu để giữ worker bận, sau đó đẩy P4 (panel), P3 (event), P2 (crit), P1 (reply)
  const pFirst = tgPrio.send('FIRST', { priority: 3 });
  const pPanel = tgPrio.send('P4_PANEL', { priority: 4 });
  const pEvent = tgPrio.send('P3_EVENT', { priority: 3 });
  const pCrit = tgPrio.send('P2_CRIT', { priority: 2 });
  const pReply = tgPrio.send('P1_REPLY', { priority: 1 });
  await Promise.all([pFirst, pPanel, pEvent, pCrit, pReply]);
  assert.deepStrictEqual(order, ['FIRST', 'P1_REPLY', 'P2_CRIT', 'P3_EVENT', 'P4_PANEL'], 'ưu tiên P1 -> P2 -> P3 -> P4');
  mock.state.customResponder = null;

  // Kiểm tra tin chờ lâu hơn maxAgeSec (600s): crit gắn nhãn (trễ Xm), non-crit bị bỏ qua
  mock.calls.length = 0;
  await tgPrio.send('Tin thường cũ', { priority: 3, enqueuedAt: Date.now() - 720 * 1000 });
  assert.strictEqual(mock.calls.length, 0, 'non-crit quá hạn 600s bị bỏ');
  await tgPrio.send('Tin crit cũ', { priority: 2, isCrit: true, enqueuedAt: Date.now() - 720 * 1000 });
  assert.strictEqual(mock.calls.length, 1);
  assert.ok(mock.calls[0].body.text.includes('(trễ 12m)'), `Expected (trễ 12m), got: ${mock.calls[0].body.text}`);

  // ---------- 4) Bảng mã lỗi Telegram (Section 12 error taxonomy) ----------
  // 4a. 400 can't parse entities -> tự động gửi lại 1 lần dưới dạng văn bản thuần (đã gỡ thẻ HTML)
  mock.calls.length = 0;
  let parseFailOnce = true;
  mock.state.customResponder = ({ method, body, sendJson }) => {
    if (method === 'sendMessage' && parseFailOnce) {
      parseFailOnce = false;
      sendJson(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: Unsupported start tag" });
      return true;
    }
    return false;
  };
  const plainId = await tg.send('<b>Xin chào</b> <i>thế giới</i>');
  assert.ok(plainId, 'gửi lại thành công bằng văn bản thuần');
  assert.strictEqual(mock.calls.length, 2);
  assert.strictEqual(mock.calls[1].body.parse_mode, undefined, 'lần gửi lại bỏ parse_mode HTML');
  assert.strictEqual(mock.calls[1].body.text, 'Xin chào thế giới');

  // 4b. 400 migrate_to_chat_id -> cập nhật chatId sang supergroup mới
  let migratedId = null;
  const tgMig = new TelegramNotifier({
    apiBase: mock.base,
    token: '123456789:' + 'M'.repeat(35),
    chatId: '555',
    onMigrateChat: (newId) => { migratedId = newId; },
  });
  let migOnce = true;
  mock.state.customResponder = ({ method, sendJson }) => {
    if (method === 'sendMessage' && migOnce) {
      migOnce = false;
      sendJson(400, {
        ok: false,
        error_code: 400,
        description: 'Bad Request: group chat was upgraded to a supergroup chat',
        parameters: { migrate_to_chat_id: -10099887766 },
      });
      return true;
    }
    return false;
  };
  await tgMig.send('test migrate');
  assert.strictEqual(tgMig.chatId, '-10099887766');
  assert.strictEqual(migratedId, '-10099887766');

  // 4c. 401 Unauthorized -> vô hiệu hoá Telegram ngay, không thử lại
  const tg401 = new TelegramNotifier({ apiBase: mock.base, token: '123456789:' + 'U'.repeat(35), chatId: '555' });
  mock.state.customResponder = ({ sendJson }) => {
    sendJson(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    return true;
  };
  assert.strictEqual(await tg401.send('x'), null);
  assert.strictEqual(tg401.enabled, false, '401 tắt ngay TelegramNotifier');

  // 4d. 403 Forbidden -> vô hiệu hoá cho tới khi cấu hình lại
  const tg403 = new TelegramNotifier({ apiBase: mock.base, token: '123456789:' + 'F'.repeat(35), chatId: '555' });
  mock.state.customResponder = ({ sendJson }) => {
    sendJson(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
    return true;
  };
  assert.strictEqual(await tg403.send('x'), null);
  assert.strictEqual(tg403.enabled, false, '403 tắt cho tới khi cấu hình lại');

  // 4e. 409 Conflict khi getUpdates -> lùi 30s và KHÔNG tự gọi deleteWebhook
  mock.calls.length = 0;
  mock.state.customResponder = ({ method, sendJson }) => {
    if (method === 'getUpdates') {
      sendJson(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
      return true;
    }
    return false;
  };
  const tg409 = new TelegramNotifier({ apiBase: mock.base, token: '123456789:' + 'C'.repeat(35), chatId: '555' });
  tg409.startPolling(() => {});
  await sleep(80);
  tg409.stopPolling();
  assert.ok(!mock.calls.some(c => c.method === 'deleteWebhook'), '409 tuyệt đối không gọi deleteWebhook');
  mock.state.customResponder = null;

  // ---------- 5) Discord Golden Parity & Config Migration Idempotency (Mục 13.9) ----------
  const discordPayloadsOld = [];
  const discordPayloadsNew = [];
  const fakeDiscordOld = {
    enabled: true,
    isEventOn: () => true,
    send(key, embed, opts) { discordPayloadsOld.push({ key, embed, opts }); },
  };
  const fakeDiscordNew = {
    enabled: true,
    isEventOn: () => true,
    send(key, embed, opts) { discordPayloadsNew.push({ key, embed, opts }); },
  };

  const legacyKeys = Object.keys(Notifier.EVENT_LABELS);
  const fixedIso = '2026-10-21T10:00:00.000Z';
  const ncDiscord = new NotificationCenter({
    getDiscord: () => fakeDiscordNew,
    getTelegram: () => null,
    getConfig: () => ({}),
  });

  for (const key of legacyKeys) {
    const theme = DiscordTheme.getTheme(key);
    assert.ok(theme && theme.emoji && theme.color, `Theme must exist for ${key}`);
    const title = DiscordTheme.formatEmbedTitle(`bot-1: Sự kiện ${key}`, key, { botId: 'bot-1' });
    const desc = `Chi tiết **${key}** cho Discord • ${DiscordTheme.discordTimestamp(now, 'R')}`;
    const color = theme.color;
    const headline = key === 'sellFailed' ? '🚨 KHÔNG BÁN ĐƯỢC' : (theme.headline || null);
    const embed = Notifier.finish({
      title,
      description: desc,
      color,
      author: DiscordTheme.buildAuthor('Steve_01 (bot-1)', 'Steve_01'),
      thumbnail: DiscordTheme.buildThumbnail('Steve_01'),
      fields: [
        { name: 'Người chơi', value: 'Steve_01 (bot-1)', inline: true },
        { name: 'Server', value: 'donutsmp.net', inline: true },
        { name: 'Thời gian treo', value: '01:20:00', inline: true },
      ],
      timestamp: fixedIso,
    }, key);
    assert.ok(embed.author && embed.author.name === 'Steve_01 (bot-1)');
    assert.strictEqual(embed.footer.text, 'Antertool');
    assert.ok(DiscordTheme.codePointLength(embed.title) <= 256);
    assert.ok(DiscordTheme.codePointLength(embed.description) <= 4096);
    // Đường trực tiếp (Notifier.send(eventKey, embed, content))
    fakeDiscordOld.send(key, embed, headline);
    // Đường qua NotificationCenter
    ncDiscord.emit({
      key,
      bot: 'bot-1',
      title,
      description: desc,
      color,
      headline,
      discord: { embed, headline },
    });
  }
  assert.deepStrictEqual(discordPayloadsNew, discordPayloadsOld, 'Discord payloads must be 100% byte-identical across all legacy keys');

  // Kiểm tra migrateTelegramConfig idempotent
  const rawCfg = { bots: [], host: 'kingmc.vn', telegramRefreshSec: 7 };
  migrateTelegramConfig(rawCfg);
  assert.strictEqual(rawCfg.telegramSymbols, 'unicode', 'lần đầu thêm các khoá Telegram còn thiếu');
  assert.strictEqual(rawCfg.telegramRefreshSec, 7, 'không ghi đè khoá người dùng đã đặt');
  const snapAfterFirst = JSON.stringify(rawCfg);
  migrateTelegramConfig(rawCfg);
  assert.strictEqual(JSON.stringify(rawCfg), snapAfterFirst, 'lần hai không thêm hay ghi đè gì (idempotent)');

  // Kiểm tra normalizeTelegramConfig ưu tiên env > config > default
  const norm = normalizeTelegramConfig(
    { telegramRefreshSec: 15, telegramSymbols: 'unicode', unknownUserKey: 'keep_me' },
    { TELEGRAM_REFRESH_SEC: '25', TELEGRAM_SYMBOLS: 'ascii' }
  );
  assert.strictEqual(norm.telegramRefreshSec, 25, 'env thắng config.json');
  assert.strictEqual(norm.telegramSymbols, 'ascii', 'env thắng config.json');
  assert.strictEqual(norm.unknownUserKey, 'keep_me', 'giữ nguyên các khoá lạ của người dùng');

  mock.server.close();
  console.log('notification-center.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
