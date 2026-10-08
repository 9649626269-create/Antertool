'use strict';
// Bảng Telegram "Auto sell spawner": định dạng, trạng thái 🟢/🟡/🔴, đếm giờ chạy, gửi/sửa tin, nhận lệnh, tích hợp BotManager.
// Dùng server Telegram GIẢ chạy trên localhost + mineflayer/vec3 giả — không cần mạng, không cần cài thư viện.
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
const TelegramNotifier = require('../src/core/TelegramNotifier');
const P = require('../src/core/TelegramPanel');
const RevenueTracker = require('../src/core/RevenueTracker');
const BotManager = require('../src/services/BotManager');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const H = 3600000, M = 60000;

// ---------- server Telegram giả ----------
function startMock() {
  const calls = []; // { method, body }
  const state = { nextId: 100, editError: null, editResp: null, updates: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body, url: req.url });
      const out = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (method === 'sendMessage') return out({ ok: true, result: { message_id: state.nextId++ } });
      if (method === 'editMessageText' && state.editResp) return out(state.editResp);
      if (method === 'editMessageText') return state.editError ? out({ ok: false, error_code: 400, description: state.editError }) : out({ ok: true, result: { message_id: body.message_id } });
      if (method === 'getMe') return out({ ok: true, result: { username: 'anter_bot' } });
      if (method === 'answerCallbackQuery') return out({ ok: true, result: true });
      if (method === 'getUpdates') {
        const give = state.updates.splice(0);
        if (give.length || !body.timeout) return out({ ok: true, result: give });
        return setTimeout(() => out({ ok: true, result: state.updates.splice(0) }), 150); // giả lập long polling
      }
      out({ ok: false, description: 'unknown' });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, state, base: `http://127.0.0.1:${server.address().port}` })));
}

(async () => {
  // ---------- 1) định dạng ----------
  assert.strictEqual(P.fmtMoney(950), '950');
  assert.strictEqual(P.fmtMoney(1250), '1.25K');
  assert.strictEqual(P.fmtMoney(31200000), '31.2M');
  assert.strictEqual(P.fmtMoney(2.5e9), '2.5B');
  assert.strictEqual(P.fmtMoney(1e6), '1M');
  assert.strictEqual(P.fmtMoney(0), '0');
  assert.strictEqual(P.fmtDuration(30 * 1000), '<1m');
  assert.strictEqual(P.fmtDuration(12 * M), '12m');
  assert.strictEqual(P.fmtDuration(4 * H + 12 * M), '4h 12m');
  assert.strictEqual(P.fmtDuration(3 * 24 * H + 4 * H + 5 * M), '3d 04h 05m');
  assert.strictEqual(P.fmtDuration(35 * 1000, { sec: true }), '35s');
  assert.strictEqual(P.fmtDuration(12 * M + 5000, { sec: true }), '12m 05s');
  assert.strictEqual(P.fmtDuration(4 * H + 12 * M + 9000, { sec: true }), '4h 12m 09s');
  assert.strictEqual(P.fmtDuration(3 * 24 * H + 4 * H + 12 * M + 35000, { sec: true }), '3d 04h 12m 35s');
  assert.strictEqual(P.fmtAgo(1000), 'vừa xong');
  assert.strictEqual(P.fmtAgo(42 * 1000), '42s trước');
  assert.strictEqual(P.fmtAgo(2 * M + 5000), '2m 05s trước');
  assert.strictEqual(BotManager.parseEverySec('1s'), 1);
  assert.strictEqual(BotManager.parseEverySec('30'), 30);
  assert.strictEqual(BotManager.parseEverySec('10m'), 600);
  assert.strictEqual(BotManager.parseEverySec('1h30m'), 5400);
  assert.strictEqual(BotManager.parseEverySec('2m30s'), 150);
  assert.strictEqual(BotManager.parseEverySec('abc'), null);
  assert.strictEqual(P.sparkline([0, 0, 0]), '▁▁▁');
  assert.strictEqual(P.sparkline([0, 5, 10]).length, 3);
  assert.strictEqual(P.sparkline([0, 5, 10])[2], '█');

  // ---------- 2) trạng thái ----------
  const now = 10 * H;
  const base = { botId: 'bot-1', account: 'acc', connState: 'ONLINE', sellOn: true, intervalMs: 5 * M, now, sessionMs: 2 * H, stats: { last: now - 2 * M }, totalUptimeMs: 3 * H };
  assert.strictEqual(P.computeStatus(base).icon, '🟢');
  assert.strictEqual(P.computeStatus(base).label, 'ổn định');
  assert.strictEqual(P.computeStatus({ ...base, connState: 'DISCONNECTED' }).icon, '🔴');
  assert.strictEqual(P.computeStatus({ ...base, connState: 'RECONNECTING' }).icon, '🟠');
  assert.strictEqual(P.computeStatus({ ...base, connState: 'SPAWNING' }).icon, '🟡');
  assert.strictEqual(P.computeStatus({ ...base, disabled: true }).icon, '⚫');
  assert.strictEqual(P.computeStatus({ ...base, sellOn: false }).icon, '⚪');
  assert.strictEqual(P.computeStatus({ ...base, sellFailAgoMs: 5 * M }).icon, '🟡');
  assert.strictEqual(P.computeStatus({ ...base, sellFailAgoMs: 2 * H }).icon, '🟢', 'lỗi cũ hơn 30 phút không còn tính');
  assert.strictEqual(P.computeStatus({ ...base, stats: { last: now - 30 * M } }).icon, '🟡', 'quá lâu không có vòng bán mới');
  assert.strictEqual(P.computeStatus({ ...base, stats: { last: now - 30 * M }, sessionMs: 3 * M }).icon, '🟢', 'mới vào server thì chưa kết luận chậm');
  assert.strictEqual(P.computeStatus({ ...base, stats: null }).icon, '🟡', 'online lâu mà chưa có vòng bán nào');
  assert.strictEqual(P.computeStatus({ ...base, stats: null, sessionMs: 2 * M }).icon, '🟢');

  // ---------- 3) nội dung bảng ----------
  const stats = {
    total: 1.25e9, last1h: 1.3e6, avgPerHour: 1.3e6, perDayEst: 31.2e6, observedMs: 5 * H,
    last: now - 2 * M, lastAt: now - 2 * M, lastAmount: 2.01e6, today: 12.3e6, yesterday: 30e6,
    hourly: Array.from({ length: 12 }, (_, i) => ({ label: `${i}h`, amount: i * 1e5 })),
  };
  const panel = P.buildPanel({ ...base, stats, clock: '14:05' });
  const lines = panel.text.split('\n');
  assert.ok(panel.text.includes('Auto sell spawner'));
  assert.ok(panel.text.includes('Tên Bot: <b>bot-1</b>'));
  assert.ok(panel.text.includes('Tên Acc: <b>acc</b>'));
  assert.ok(panel.text.includes('Tình Trạng : <b>ổn định</b> 🟢'));
  assert.ok(panel.text.includes('Tổng Thu Nhập: <b>1.25B</b>'));
  assert.ok(panel.text.includes('<b>31.2M</b>/day'));
  assert.ok(panel.text.includes('1h/<b>1.3M</b>'));
  assert.ok(panel.text.includes('Thu nhập vừa qua: <b>2.01M</b> <i>(2m 00s trước)</i>'));
  assert.ok(panel.text.includes('Tổng Thời Gian Hoạt Động: <b>3h 00m 00s</b>'));
  assert.ok(panel.text.includes('Hôm nay <b>12.3M</b>'));
  assert.strictEqual(lines.filter(l => /^─+$/.test(l)).length, 2, 'đúng 2 đường kẻ như mẫu');
  assert.strictEqual(panel.keyboard[0][0].callback_data, 'r:bot-1');
  // chưa có doanh thu: không vỡ, có placeholder
  const empty = P.buildPanel({ ...base, stats: null, clock: '14:05' });
  assert.ok(empty.text.includes('Tổng Thu Nhập: <b>0</b>'));
  assert.ok(empty.text.includes('chờ vòng bán đầu tiên'));
  // tên có ký tự HTML phải được escape (không làm Telegram từ chối tin)
  assert.ok(P.buildPanel({ ...base, botId: 'a<b>&c', account: '<x>' }).text.includes('a&lt;b&gt;&amp;c'));
  // id quá dài -> nút làm mới tất cả
  assert.strictEqual(P.buildPanel({ ...base, botId: 'x'.repeat(80) }).keyboard[0][0].callback_data, 'r:*');
  // /status
  const list = P.buildStatusList([{ ...base, stats }, { ...base, botId: 'bot-2', connState: 'DISCONNECTED', stats: null }], '14:05');
  assert.ok(list.includes('🟢 <b>bot-1</b>') && list.includes('🔴 <b>bot-2</b>') && list.includes('Σ cả dàn'));

  // ---------- 4) đếm giờ chạy + vòng bán gần nhất ----------
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-')), 'revenue.json');
  let rt = new RevenueTracker(f);
  rt.markOnline('b', 1000);
  assert.deepStrictEqual(rt.uptime('b', 1000 + 2 * H), { totalMs: 2 * H, sessionMs: 2 * H, online: true });
  rt.markOnline('b', 1000 + H); // gọi lại khi đang online: không reset phiên
  assert.strictEqual(rt.uptime('b', 1000 + 2 * H).sessionMs, 2 * H);
  rt.markOffline('b', 1000 + 2 * H);
  assert.deepStrictEqual(rt.uptime('b', 1000 + 5 * H), { totalMs: 2 * H, sessionMs: 0, online: false });
  rt.markOnline('b', 1000 + 6 * H); // phiên 2 cộng dồn
  assert.strictEqual(rt.uptime('b', 1000 + 7 * H).totalMs, 3 * H);
  assert.strictEqual(rt.stats('b'), null, 'chỉ có giờ chạy, chưa có doanh thu -> stats null');
  rt.record('b', 500000, { now: 5e9, intervalMs: 300000, hits: 3 });
  rt.record('b', 700000, { now: 5e9 + 5 * M, intervalMs: 300000, hits: 3 });
  const st = rt.stats('b', 5e9 + 6 * M);
  assert.strictEqual(st.lastAmount, 700000);
  assert.strictEqual(st.lastAt, 5e9 + 5 * M);
  // reset doanh thu giữ bộ đếm giờ chạy
  rt.reset('b');
  assert.strictEqual(rt.stats('b'), null);
  assert.ok(rt.uptime('b', 1000 + 7 * H).totalMs >= 3 * H - 1);
  // tắt đột ngột: lần chạy sau chốt phiên ở nhịp tim cuối
  rt.touch('b', 1000 + 8 * H);
  rt.flush();
  rt = new RevenueTracker(f);
  const u = rt.uptime('b', 1000 + 100 * H);
  assert.strictEqual(u.online, false);
  assert.strictEqual(u.totalMs, 2 * H + 2 * H, 'phiên 1 (2h) + phiên 2 chốt ở nhịp tim (6h→8h = 2h)');

  // ---------- 5) TelegramNotifier với server giả ----------
  const mock = await startMock();
  const tg = new TelegramNotifier({ apiBase: mock.base });
  assert.strictEqual(tg.enabled, false);
  assert.strictEqual(await tg.send('x'), null, 'chưa cấu hình thì im lặng');
  tg.configure('123456789:' + 'A'.repeat(35), '555');
  assert.strictEqual(tg.enabled, true);
  assert.ok(TelegramNotifier.looksLikeToken('123456789:' + 'A'.repeat(35)));
  assert.ok(!TelegramNotifier.looksLikeToken('abc'));
  const id1 = await tg.send('<b>hi</b>', { keyboard: [[{ text: 'a', callback_data: 'r:x' }]] });
  assert.strictEqual(id1, 100);
  let c = mock.calls.at(-1);
  assert.strictEqual(c.method, 'sendMessage');
  assert.strictEqual(c.body.chat_id, '555');
  assert.strictEqual(c.body.parse_mode, 'HTML');
  assert.ok(c.url.includes('/bot123456789:'), 'token nằm trong đường dẫn API');
  assert.ok(c.body.reply_markup.inline_keyboard);
  // sửa tại chỗ
  assert.strictEqual(await tg.edit(id1, 'v2'), 100);
  assert.strictEqual(mock.calls.at(-1).method, 'editMessageText');
  assert.strictEqual(mock.calls.at(-1).body.message_id, 100);
  // nội dung y hệt -> vẫn coi là xong, không gửi tin mới
  mock.state.editError = 'Bad Request: message is not modified';
  const before = mock.calls.length;
  assert.strictEqual(await tg.edit(id1, 'v2'), 100);
  assert.strictEqual(mock.calls.length, before + 1);
  // tin bị xoá -> gửi bảng mới, trả message_id mới
  mock.state.editError = 'Bad Request: message to edit not found';
  const id2 = await tg.edit(id1, 'v3');
  assert.strictEqual(id2, 101);
  assert.strictEqual(mock.calls.at(-1).method, 'sendMessage');
  mock.state.editError = null;
  // lỗi tạm thời (mạng) KHÔNG được đẻ ra bảng mới: giữ nguyên message_id
  const tgDown = new TelegramNotifier({ apiBase: 'http://127.0.0.1:1', token: '123456789:' + 'D'.repeat(35), chatId: '555' });
  assert.strictEqual(await tgDown.edit(77, 'x'), 77);
  // 429 (gửi quá nhanh): giữ bảng cũ, nghỉ đúng retry_after, trong lúc nghỉ bỏ qua lần sửa, cảnh báo (send) thì chờ rồi vẫn gửi
  mock.state.editResp = { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } };
  mock.calls.length = 0;
  assert.strictEqual(await tg.edit(id1, 'v4'), id1);
  assert.deepStrictEqual(mock.calls.map(x => x.method), ['editMessageText'], '429 không được fallback sang gửi tin mới');
  assert.strictEqual(tg.paused, true);
  assert.strictEqual(await tg.edit(id1, 'v5'), id1);
  assert.strictEqual(mock.calls.length, 1, 'đang bị giới hạn tốc độ: không gọi API nữa');
  const tStart = Date.now();
  const alertId = await tg.send('cảnh báo quan trọng');
  assert.ok(alertId && Date.now() - tStart >= 900, 'cảnh báo chờ hết giờ nghỉ rồi vẫn gửi');
  assert.strictEqual(tg.paused, false);
  mock.state.editResp = null;
  assert.strictEqual(await tg.edit(id1, 'v6'), id1);
  assert.strictEqual(mock.calls.at(-1).method, 'editMessageText');
  assert.strictEqual(tg.pending, 0);
  // test() + discoverChats
  assert.strictEqual((await tg.test()).ok, true);
  mock.state.updates.push({ update_id: 1, message: { chat: { id: 777, first_name: 'An' }, text: '/start' } });
  const d = await tg.discoverChats();
  assert.deepStrictEqual(d.chats, [{ id: '777', title: 'An' }]);
  // chuyển Discord -> HTML Telegram, bỏ tag @
  assert.strictEqual(TelegramNotifier.discordToHtml('**đậm** <@123456789012345678> a<b'), '<b>đậm</b> a&lt;b');
  // chỉ gửi sự kiện đang bật
  tg.configure(tg.token, tg.chatId, ['sellFailed']);
  assert.strictEqual(tg.isEventOn('sellFailed'), true);
  assert.strictEqual(tg.isEventOn('disconnect'), false);
  tg.configure(tg.token, tg.chatId, ['all']);
  assert.strictEqual(tg.isEventOn('moneyGoal'), true);

  // ---------- 6) nhận lệnh: chỉ đúng chat ----------
  const got = [];
  const tg2 = new TelegramNotifier({ apiBase: mock.base, token: '123456789:' + 'B'.repeat(35), chatId: '555' });
  mock.state.updates.push(
    { update_id: 10, message: { chat: { id: 999 }, text: '/status' } },                 // người lạ: bị bỏ qua
    { update_id: 11, message: { chat: { id: 555 }, text: '/status@anter_bot' } },        // đúng chat, có đuôi @bot
    { update_id: 12, message: { chat: { id: 555 }, text: '/panel bot-1' } },
    { update_id: 13, message: { chat: { id: 555 }, text: 'chào' } },                     // không phải lệnh
    { update_id: 14, callback_query: { id: 'cb1', data: 'r:bot-1', message: { chat: { id: 555 }, message_id: 42 } } },
    { update_id: 15, callback_query: { id: 'cb2', data: 'r:bot-1', message: { chat: { id: 999 }, message_id: 43 } } }, // nút của chat lạ
  );
  tg2.startPolling(async (ev) => { got.push(ev); if (ev.type === 'button') await ev.answer('ok'); });
  await sleep(400);
  tg2.stopPolling();
  assert.deepStrictEqual(got.map(e => `${e.type}:${e.cmd}:${e.arg}`), ['command:status:', 'command:panel:bot-1', 'button:r:bot-1']);
  assert.strictEqual(got[2].messageId, 42);
  assert.ok(mock.calls.some(x => x.method === 'answerCallbackQuery' && x.body.callback_query_id === 'cb1'));
  assert.ok(!mock.calls.some(x => x.method === 'answerCallbackQuery' && x.body.callback_query_id === 'cb2'));

  // ---------- 7) tích hợp BotManager ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgm-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    bots: [], telegramToken: '123456789:' + 'C'.repeat(35), telegramChatId: '555', telegramCommands: false, telegramRefreshSec: 0, telegramMinGapSec: 0,
  }));
  const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
  await mgr.init();
  mgr.telegram.apiBase = mock.base;
  assert.strictEqual(mgr.telegram.enabled, true);
  const fake = (id, o = {}) => ({ cfg: { id, username: 'acc_' + id }, state: { connState: 'ONLINE' }, _sellSpawnOn: true, _sellSpawnIntervalMs: () => 5 * M, isOnline: true, shutdown() { }, ...o });
  const b1 = fake('bot-1'), b2 = fake('bot-2', { _sellSpawnOn: false });
  mgr.bots.push(b1, b2);
  const t0 = Date.now();
  mgr.revenue.markOnline('bot-1', t0 - 2 * H);
  mgr.revenue.record('bot-1', 4e6, { now: t0 - 10 * M, intervalMs: 5 * M });
  mgr.revenue.record('bot-1', 2.5e6, { now: t0 - 5 * M, intervalMs: 5 * M });

  mock.calls.length = 0;
  assert.strictEqual(await mgr.sendTelegramPanel(b1), true);
  assert.strictEqual(mock.calls.at(-1).method, 'sendMessage', 'lần đầu: gửi bảng mới');
  const txt = mock.calls.at(-1).body.text;
  assert.ok(txt.includes('Tên Bot: <b>bot-1</b>') && txt.includes('Tên Acc: <b>acc_bot-1</b>') && txt.includes('ổn định</b> 🟢'));
  assert.ok(txt.includes('Tổng Thu Nhập: <b>6.5M</b>'));
  assert.ok(txt.includes('Thu nhập vừa qua: <b>2.5M</b>'));
  assert.ok(/Tổng Thời Gian Hoạt Động: <b>2h 0\dm \d\ds<\/b>/.test(txt), txt);
  const mid = mgr._tgMsgs['bot-1'];
  assert.ok(mid, 'nhớ message_id của bảng');
  assert.strictEqual(mgr.persistence.get('telegramMessages')['bot-1'], mid, 'lưu vào config để lần chạy sau còn sửa đúng bảng');
  await mgr.sendTelegramPanel(b1);
  assert.strictEqual(mock.calls.at(-1).method, 'editMessageText', 'lần sau: sửa tại chỗ, không spam');
  assert.strictEqual(mock.calls.at(-1).body.message_id, mid);
  // 2 yêu cầu sát nhau khi chưa có bảng -> chỉ 1 tin mới
  mgr._tgMsgs = {}; mock.calls.length = 0;
  await Promise.all([mgr.sendTelegramPanel(b1), mgr.sendTelegramPanel(b1)]);
  assert.deepStrictEqual(mock.calls.map(x => x.method), ['sendMessage', 'editMessageText']);
  // chế độ new: mỗi lần 1 tin mới
  mgr._config.telegramMode = 'new'; mock.calls.length = 0;
  await mgr.sendTelegramPanel(b1); await mgr.sendTelegramPanel(b1);
  assert.deepStrictEqual(mock.calls.map(x => x.method), ['sendMessage', 'sendMessage']);
  mgr._config.telegramMode = 'edit';
  // bot không bật autosell_spawn và chưa có doanh thu -> không lập bảng
  assert.strictEqual(mgr._panelRelevant(b2), false);
  mock.calls.length = 0;
  assert.strictEqual(mgr.refreshTelegramPanels(), 1);
  await sleep(100);
  assert.strictEqual(mock.calls.filter(x => x.method !== 'getUpdates').length, 1);
  // cảnh báo: gửi tin mới + tag Discord bị bỏ
  mock.calls.length = 0;
  mgr.telegramAlert(b1, 'sellFailed', '🚨 bot-1: lỗi', 'Vị trí **x**', '🚨 KHÔNG BÁN ĐƯỢC <@123456789012345678>');
  mgr.telegramAlert(b1, 'moneyGoal', 'không nằm trong sự kiện mặc định', 'x');
  await sleep(1800);
  const alert = mock.calls.find(x => x.method === 'sendMessage');
  assert.ok(alert.body.text.startsWith('🚨 KHÔNG BÁN ĐƯỢC'));
  assert.ok(!alert.body.text.includes('<@') && alert.body.text.includes('<b>x</b>'));
  assert.strictEqual(mock.calls.filter(x => x.method === 'sendMessage' && x.body.text.includes('không nằm trong')).length, 0, 'sự kiện đang tắt thì không gửi');
  assert.ok(mock.calls.some(x => x.method === 'editMessageText'), 'sau cảnh báo bảng được sửa lại cho khớp trạng thái');
  // lệnh /status, nút làm mới
  mock.calls.length = 0;
  await mgr._onTelegramEvent({ type: 'command', cmd: 'status', arg: '', reply: (t) => tg.send(t) });
  await sleep(100); // reply là fire-and-forget (không chặn bot)
  assert.ok(mock.calls.at(-1).body.text.includes('Trạng thái 2 bot'));
  mock.calls.length = 0;
  let answered = null;
  await mgr._onTelegramEvent({ type: 'button', cmd: 'r', arg: 'bot-1', messageId: 4242, answer: (t) => { answered = t; } });
  assert.strictEqual(mock.calls.at(-1).method, 'editMessageText');
  assert.strictEqual(mock.calls.at(-1).body.message_id, 4242, 'nút Làm mới sửa đúng tin chứa nút');
  assert.ok(answered);
  // nhịp 1 giây: mỗi nhịp sửa ĐÚNG 1 bảng, xoay vòng giữa các bot online
  const b3 = fake('bot-3'); mgr.bots.push(b3);
  mgr._tgMsgs = {}; mgr._tgSig.clear(); mgr._tgRR = 0; mock.calls.length = 0;
  const tick = async () => { mgr._tgTick(); await sleep(80); };
  await tick(); await tick(); await tick();
  assert.deepStrictEqual(mock.calls.map(x => x.method), ['sendMessage', 'sendMessage', 'editMessageText']);
  assert.ok(mock.calls[0].body.text.includes('bot-1') && mock.calls[1].body.text.includes('bot-3') && mock.calls[2].body.text.includes('bot-1'), 'xoay vòng bot-1, bot-3, bot-1');
  // mỗi lần sửa có giây chạy (bảng "sống")
  assert.ok(/\d\d:\d\d:\d\d/.test(mock.calls[2].body.text), 'dòng cập nhật có giây');
  // bot đang bận (lần gửi trước chưa xong) thì nhịp này bỏ qua nó
  mgr._tgBusy.add('bot-1'); mock.calls.length = 0;
  await tick();
  assert.ok(mock.calls.length === 1 && mock.calls[0].body.text.includes('bot-3'));
  mgr._tgBusy.delete('bot-1');
  // đang bị 429 -> không gọi API
  mgr.telegram._pauseUntil = Date.now() + 5000; mock.calls.length = 0;
  await tick();
  assert.strictEqual(mock.calls.length, 0);
  mgr.telegram._pauseUntil = 0;
  // bot offline: chỉ sửa 1 lần khi trạng thái đổi, rồi thôi (không sửa liên tục)
  for (const b of [b1, b3]) { b.isOnline = false; b.state.connState = 'DISCONNECTED'; }
  mock.calls.length = 0;
  await tick(); await tick();
  assert.strictEqual(mock.calls.length, 2, 'mỗi bot offline sửa đúng 1 lần để hiện 🔴');
  assert.ok(mock.calls.every(x => x.body.text.includes('🔴')));
  await tick(); await tick();
  assert.strictEqual(mock.calls.length, 2, 'đã hiện 🔴 rồi thì không sửa nữa');
  for (const b of [b1, b3]) { b.isOnline = true; b.state.connState = 'ONLINE'; }
  // mode new: không chạy nhịp (tránh spam tin mới)
  mgr._config.telegramMode = 'new'; mock.calls.length = 0;
  await tick();
  assert.strictEqual(mock.calls.length, 0);
  mgr._config.telegramMode = 'edit';
  // đang chạy nhịp giây thì cập nhật sau vòng bán không sửa thêm
  mgr._tgTimer = {}; mock.calls.length = 0; mgr._tgLastAt.clear();
  mgr.onSellCycle(b1); await sleep(80);
  assert.strictEqual(mock.calls.length, 0);
  mgr._tgTimer = null;
  mgr.onSellCycle(b1); await sleep(80);
  assert.strictEqual(mock.calls.length, 1, 'không chạy nhịp giây thì vẫn cập nhật sau vòng bán');
  mgr.bots = mgr.bots.filter(b => b !== b3);
  // tắt Telegram thì im lặng hoàn toàn
  mgr.setTelegram(null, null);
  mock.calls.length = 0;
  assert.strictEqual(await mgr.sendTelegramPanel(b1), false);
  mgr.telegramAlert(b1, 'sellFailed', 't', 'd');
  assert.strictEqual(mock.calls.length, 0);

  mgr.shutdown();
  mock.server.close();
  console.log('telegram.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
