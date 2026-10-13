'use strict';
// Log runtime -> Telegram: gom lô, lọc mức/bot, gộp dòng lặp, che mật khẩu/token, chống 429/giới hạn nhịp, gửi lỗi,
// gửi nốt khi tắt, lệnh CLI "telegram logs ..." và lệnh /logs trong Telegram.
// Dùng server Telegram GIẢ trên localhost + mineflayer/vec3 giả — không cần mạng, không cần cài thư viện.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const EventEmitter = require('events');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return {};
  if (request === 'vec3') return { Vec3: class { } };
  return origLoad.call(this, request, ...rest);
};
const TelegramNotifier = require('../src/core/TelegramNotifier');
const TelegramLogger = require('../src/core/TelegramLogger');
const BotManager = require('../src/services/BotManager');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = '123456789:' + 'L'.repeat(35);

function startMock() {
  const calls = [];
  let nextId = 500;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ method, body });
      const out = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (method === 'sendMessage') return out({ ok: true, result: { message_id: nextId++ } });
      if (method === 'getUpdates') return out({ ok: true, result: [] });
      out({ ok: true, result: true });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}
const sent = (mock) => mock.calls.filter(c => c.method === 'sendMessage');
const balanced = (t) => ['code', 'b', 'i'].every(k => (t.match(new RegExp(`<${k}>`, 'g')) || []).length === (t.match(new RegExp(`</${k}>`, 'g')) || []).length);

(async () => {
  const mock = await startMock();
  const tg = new TelegramNotifier({ apiBase: mock.base, token: TOKEN, chatId: '555' });
  // logger mới cho mỗi tình huống (khỏi lẫn trạng thái); nhịp gom rút ngắn để test nhanh
  const mk = (cfg = {}, opts = {}) => {
    const l = new TelegramLogger(opts.tg || tg, { tz: () => 'Asia/Ho_Chi_Minh', ...opts });
    l.configure(cfg);
    l.intervalMs = 100;
    return l;
  };

  // ---------- 1) hàm tĩnh ----------
  assert.deepStrictEqual(TelegramLogger.parseLevels('warn').levels, ['warn', 'err', 'health']);
  assert.deepStrictEqual(TelegramLogger.parseLevels('err').levels, ['err']);
  assert.ok(TelegramLogger.parseLevels('all').levels.includes('sys') && !TelegramLogger.parseLevels('all').levels.includes('chat'), 'all = mọi mức trừ chat');
  assert.ok(TelegramLogger.parseLevels('all,chat').levels.includes('chat'));
  assert.deepStrictEqual(TelegramLogger.parseLevels('Error, warning').levels, ['err', 'warn'], 'đồng nghĩa + không phân biệt hoa/thường');
  assert.strictEqual(TelegramLogger.parseLevels('foo').ok, false);
  assert.strictEqual(TelegramLogger.parseLevels('').ok, false);
  assert.strictEqual(TelegramLogger.presetOf(['err', 'warn', 'health']), 'warn');
  assert.strictEqual(TelegramLogger.presetOf(['sys']), null);
  assert.strictEqual(TelegramLogger.parseSeconds('10s'), 10);
  assert.strictEqual(TelegramLogger.parseSeconds('2m'), 120);
  assert.strictEqual(TelegramLogger.parseSeconds('90'), 90);
  assert.strictEqual(TelegramLogger.parseSeconds('abc'), null);

  // ---------- 2) chưa cấu hình Telegram -> im lặng, không tốn bộ nhớ ----------
  const off = new TelegramLogger(new TelegramNotifier({ apiBase: mock.base }));
  off.push('bot-1', { level: 'err', msg: 'x' });
  assert.strictEqual(off.buffered, 0);
  assert.strictEqual(off.recent.length, 0);
  assert.strictEqual(off.active, false);

  // ---------- 3) gom lô: nhiều dòng, nhiều bot -> 1 tin im lặng ----------
  let L = mk();
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 5); // 07:00:05 giờ VN
  L.push('bot-1', { level: 'ok', msg: 'Đã đăng nhập', time: T0 });
  L.push('bot-2', { level: 'warn', msg: 'Mất kết nối', time: T0 + 1000 });
  L.push('bot-1', { level: 'sys', msg: 'Click slot 24', time: T0 + 2000 });
  assert.strictEqual(L.buffered, 3);
  assert.strictEqual(sent(mock).length, 0, 'chưa tới nhịp gom thì chưa gửi');
  await sleep(450); // tới nhịp gom
  assert.strictEqual(sent(mock).length, 1, '3 dòng -> đúng 1 tin');
  let m = sent(mock)[0].body;
  assert.strictEqual(m.parse_mode, 'HTML');
  assert.strictEqual(m.disable_notification, true, 'tin log im lặng (không rung)');
  assert.strictEqual(m.chat_id, '555');
  assert.ok(m.text.includes('<code>07:00:05</code> <b>bot-1</b> ✅ Đã đăng nhập'), m.text);
  assert.ok(m.text.includes('<b>bot-2</b> ⚠️ Mất kết nối') && m.text.includes('<code>07:00:07</code> <b>bot-1</b> ⚙️ Click slot 24'));
  assert.ok(m.text.indexOf('Đã đăng nhập') < m.text.indexOf('Mất kết nối') && m.text.indexOf('Mất kết nối') < m.text.indexOf('Click slot'), 'đúng thứ tự thời gian');
  assert.strictEqual(L.buffered, 0);
  assert.strictEqual(L.status().messages, 1);
  assert.strictEqual(L.status().lines, 3);
  // tin im lặng có thể tắt
  mock.calls.length = 0;
  L.configure({ silent: false });
  L.push('bot-1', { level: 'ok', msg: 'a' });
  await L.flush();
  assert.strictEqual(sent(mock)[0].body.disable_notification, undefined, 'silent=false -> tin có rung');

  // ---------- 4) lọc mức / bot ----------
  mock.calls.length = 0;
  L = mk();
  L.push('bot-1', { level: 'chat', msg: '<Steve> chào' });          // chat người chơi: mặc định KHÔNG gửi
  L.push('bot-1', { level: 'shard', msg: 'Scoreboard → 5' });
  assert.strictEqual(L.buffered, 1, 'chat bị lọc, shard được gửi');
  assert.strictEqual(L.recent.length, 2, 'nhưng cả hai đều được nhớ để /logs xem lại');
  L.configure({ levels: ['warn', 'err'] });
  L.push('bot-1', { level: 'ok', msg: 'bị lọc' });
  L.push('bot-1', { level: 'warn', msg: 'qua' });
  assert.strictEqual(L.buffered, 2);
  L.configure({ levels: 'all,chat' });
  L.push('bot-1', { level: 'chat', msg: '<Steve> hi' });
  assert.strictEqual(L.buffered, 3, 'bật chat thì gửi cả chat');
  L.configure({ levels: ['bogus'] });
  assert.deepStrictEqual([...L.levels].sort(), [...TelegramLogger.PRESETS.all].sort(), 'mức rác -> về mặc định');
  L.configure({ levels: ['sys', 'ok', 'warn', 'err'], bots: ['BOT-1'] });
  L._clearBuffer();
  L.push('bot-1', { level: 'ok', msg: 'của bot-1' });
  L.push('bot-2', { level: 'ok', msg: 'của bot-2' });
  L.push('system', { level: 'ok', msg: 'của hệ thống' });
  assert.strictEqual(L.buffered, 2, 'lọc bot (không phân biệt hoa/thường); log hệ thống luôn qua');
  L.configure({ bots: [] });
  L.push('bot-2', { level: 'ok', msg: 'giờ qua' });
  assert.strictEqual(L.buffered, 3, 'bots rỗng = tất cả');
  L.configure({ enabled: false });
  assert.strictEqual(L.buffered, 0, 'tắt thì bỏ bộ đệm');
  L.push('bot-1', { level: 'err', msg: 'x' });
  assert.strictEqual(L.buffered, 0);
  L.configure({ enabled: true });
  // err gửi nhanh hơn nhịp gom
  L = mk(); L.intervalMs = 30000;
  L.push('bot-1', { level: 'ok', msg: 'bình thường' });
  assert.ok(L._dueAt - Date.now() > 20000, 'dòng thường chờ hết nhịp');
  L.push('bot-1', { level: 'err', msg: 'lỗi!' });
  assert.ok(L._dueAt - Date.now() <= 2100, 'có err thì gửi trong ≤2s');
  L._clearBuffer();

  // ---------- 5) gộp dòng lặp, nhiều dòng, escape, mã màu ----------
  mock.calls.length = 0;
  L = mk();
  L.push('bot-1', { level: 'warn', msg: 'lặp' });
  L.push('bot-2', { level: 'warn', msg: 'khác bot' });
  L.push('bot-1', { level: 'warn', msg: 'lặp' });       // xen kẽ bot khác vẫn gộp theo từng bot
  L.push('bot-1', { level: 'warn', msg: 'lặp' });
  L.push('bot-1', { level: 'warn', msg: 'khác' });
  L.push('bot-1', { level: 'warn', msg: 'lặp' });       // không liên tiếp -> dòng mới
  assert.strictEqual(L.buffered, 4);
  L.push('bot-1', { level: 'sys', msg: 'a <b>&</b> §cđỏ\x1b[31m ansi\x1b[0m' });
  L.push('bot-1', { level: 'sys', msg: 'bảng:\nhàng 1\nhàng 2' });
  await L.flush();
  m = sent(mock)[0].body.text;
  assert.ok(m.includes('lặp <i>(×3)</i>'), m);
  assert.strictEqual((m.match(/\(×/g) || []).length, 1);
  assert.ok(m.includes('a &lt;b&gt;&amp;&lt;/b&gt; đỏ ansi'), 'escape HTML, bỏ §c và mã ANSI: ' + m);
  assert.ok(m.includes('bảng:\n   ↳ hàng 1\n   ↳ hàng 2'), 'log nhiều dòng thụt vào');
  assert.ok(balanced(m));
  // mục quá dài bị cắt, nhiều dòng quá bị cắt
  mock.calls.length = 0;
  L.push('bot-1', { level: 'err', msg: 'x'.repeat(5000) });
  L.push('bot-1', { level: 'err', msg: Array.from({ length: 30 }, (_, i) => 'd' + i).join('\n') });
  await L.flush();
  m = sent(mock)[0].body.text;
  assert.ok(m.length < 1800 && m.includes('…'), 'dòng dài bị cắt ' + m.length);
  assert.ok(m.includes('d5') && !m.includes('d6'), 'tối đa 6 dòng cho mỗi mục');

  // ---------- 6) che thông tin nhạy cảm ----------
  mock.calls.length = 0;
  L = mk({}, { secrets: () => ['MyBotPass99', '123', null] });
  L.push('bot-1', { level: 'err', msg: `token ${'123456789:AAH' + 'x'.repeat(33)} lộ` });
  L.push('bot-1', { level: 'err', msg: 'webhook https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-123 lộ' });
  L.push('bot-1', { level: 'err', msg: 'Gõ /dn hunter2pass rồi /dk pw1 pw1' });
  L.push('bot-1', { level: 'err', msg: 'proxy socks5://user:p4ss@1.2.3.4:1080 lỗi' });
  L.push('bot-1', { level: 'err', msg: 'sai mật khẩu MyBotPass99! thử MyBotPass99x' });
  L.push('bot-1', { level: 'err', msg: 'toạ độ 123 64 -123' });
  L.push('bot-1', { level: 'ok', msg: 'Đã gửi /dn' });
  L.push('bot-1', { level: 'err', msg: 'Lỗi gửi /dn: boom — /home treolong' });
  await L.flush();
  m = sent(mock)[0].body.text;
  assert.ok(m.includes('&lt;telegram-token&gt;') && !m.includes('AAHxxx'), m);
  assert.ok(m.includes('webhooks/123456789012345678/***') && !m.includes('abcDEF'));
  assert.ok(m.includes('/dn ***') && m.includes('/dk ***') && !m.includes('hunter2pass') && !m.includes('pw1'));
  assert.ok(m.includes('socks5://user:***@1.2.3.4:1080') && !m.includes('p4ss'));
  assert.ok(m.includes('sai mật khẩu ***! thử MyBotPass99x'), 'che mật khẩu bot đứng riêng, không cắt giữa từ: ' + m);
  assert.ok(m.includes('toạ độ 123 64 -123'), 'bí mật ngắn (<6 ký tự) không che — khỏi làm hỏng số/toạ độ');
  assert.ok(m.includes('Đã gửi /dn\n') || m.includes('Đã gửi /dn '), 'lệnh không có đối số giữ nguyên');
  assert.ok(m.includes('Lỗi gửi /dn: boom — /home treolong'));
  // bản ghi nhớ (cho /logs) cũng đã được che
  assert.ok(!JSON.stringify(L.recent.toArray()).includes('hunter2pass'));

  // ---------- 7) múi giờ ----------
  mock.calls.length = 0;
  L = mk({}, { tz: () => 'UTC' });
  L.push('bot-1', { level: 'ok', msg: 'giờ', time: T0 });
  await L.flush();
  assert.ok(sent(mock)[0].body.text.includes('<code>00:00:05</code>'), 'theo múi giờ cấu hình');
  L = mk({}, { tz: () => 'Not/AZone' });
  L.push('bot-1', { level: 'ok', msg: 'giờ', time: T0 });
  await L.flush();
  assert.ok(/<code>\d\d:\d\d:\d\d<\/code>/.test(sent(mock).at(-1).body.text), 'múi giờ sai không làm hỏng việc gửi');

  // ---------- 8) tràn bộ đệm + chia tin ----------
  mock.calls.length = 0;
  L = mk({}, {}); L.configure({ maxPerMin: 20 });
  for (let i = 0; i < 450; i++) L.push('bot-1', { level: 'sys', msg: `dòng số ${i} ` + 'z'.repeat(60) });
  assert.strictEqual(L.buffered, 400, 'bộ đệm giới hạn 400 dòng');
  assert.strictEqual(L.status().dropped, 50);
  await L.flush();
  const msgs = sent(mock);
  assert.ok(msgs.length >= 5, 'nhiều dòng -> chia nhiều tin: ' + msgs.length);
  assert.ok(msgs.every(x => x.body.text.length < 4000 && balanced(x.body.text)), 'mỗi tin < 4000 ký tự, thẻ HTML đóng đủ');
  assert.ok(msgs[0].body.text.includes('đã bỏ qua 50 dòng'), 'báo số dòng bị bỏ');
  const all = msgs.map(x => x.body.text).join('\n');
  assert.ok(all.includes('dòng số 449') && all.includes('dòng số 50 ') && !all.includes('dòng số 49 '), 'bỏ dòng CŨ nhất, giữ dòng mới');
  assert.strictEqual(L.buffered, 0);

  // ---------- 9) giới hạn nhịp (tin/phút) ----------
  mock.calls.length = 0;
  L = mk({ maxPerMin: 2 });
  L.push('bot-1', { level: 'ok', msg: 'A' }); await L.flush();
  L.push('bot-1', { level: 'ok', msg: 'B' }); await L.flush();
  L.push('bot-1', { level: 'ok', msg: 'C' }); await L.flush();
  assert.strictEqual(sent(mock).length, 2, 'đủ 2 tin/phút thì giữ lại');
  assert.strictEqual(L.buffered, 1);
  assert.ok(L._dueAt - Date.now() > 50000, 'hẹn gửi lại sau khi hết cửa sổ 1 phút');
  L._sentAt = [];
  await L.flush();
  assert.strictEqual(sent(mock).length, 3, 'hết giới hạn thì gửi tiếp');
  assert.ok(sent(mock)[2].body.text.includes('C'));
  // nhiều tin trong 1 lần gửi cũng không vượt giới hạn: phần còn lại xếp lại
  mock.calls.length = 0;
  L = mk({ maxPerMin: 2 });
  for (let i = 0; i < 300; i++) L.push('bot-1', { level: 'sys', msg: `n${i} ` + 'z'.repeat(60) });
  await L.flush();
  assert.strictEqual(sent(mock).length, 2);
  assert.ok(L.buffered > 0, 'phần chưa gửi được giữ lại');
  L._clearBuffer();

  // ---------- 10) Telegram đang 429 / bận -> giữ log, không gọi API ----------
  mock.calls.length = 0;
  L = mk();
  L.push('bot-1', { level: 'ok', msg: 'giữ lại' });
  tg._pauseUntil = Date.now() + 5000;
  await L.flush();
  assert.strictEqual(sent(mock).length, 0);
  assert.strictEqual(L.buffered, 1);
  tg._pauseUntil = 0;
  const realPending = Object.getOwnPropertyDescriptor(TelegramNotifier.prototype, 'pending');
  tg.pending = 9; // hàng đợi Telegram đang dồn (bảng + cảnh báo)
  await L.flush();
  assert.strictEqual(sent(mock).length, 0, 'hàng đợi bận -> nhường');
  tg.pending = 0;
  await L.flush();
  assert.strictEqual(sent(mock).length, 1);
  assert.ok(realPending === undefined, 'pending là thuộc tính thường');

  // ---------- 11) gửi lỗi: xếp lại, tối đa 3 lần rồi bỏ ----------
  const tgDown = new TelegramNotifier({ apiBase: 'http://127.0.0.1:1', token: TOKEN, chatId: '555' });
  L = mk({}, { tg: tgDown });
  L.push('bot-1', { level: 'err', msg: 'không gửi được' });
  await L.flush(true);
  assert.strictEqual(L.buffered, 1, 'lần 1 lỗi -> giữ lại');
  assert.strictEqual(L.status().failed, 1);
  assert.ok(L._dueAt - Date.now() > 10000, 'lỗi mạng: thử lại thưa (≥15s), không dội');
  await L.flush(true);
  await L.flush(true);
  assert.strictEqual(L.buffered, 0, 'quá 3 lần thì bỏ, không kẹt mãi');
  L._clearBuffer();

  // ---------- 12) gửi nốt khi tắt tool ----------
  mock.calls.length = 0;
  L = mk(); L.intervalMs = 60000;
  L.push('bot-1', { level: 'sys', msg: 'Antertool đang tắt' });
  await L.flushNow(2000);
  assert.strictEqual(sent(mock).length, 1, 'flushNow gửi ngay, không chờ nhịp');
  assert.ok(sent(mock)[0].body.text.includes('Antertool đang tắt'));
  // flushNow có giới hạn thời gian (Telegram treo cũng không giữ tool lại)
  const hang = http.createServer(() => { /* không bao giờ trả lời */ });
  await new Promise(r => hang.listen(0, '127.0.0.1', r));
  const tgHang = new TelegramNotifier({ apiBase: `http://127.0.0.1:${hang.address().port}`, token: TOKEN, chatId: '555' });
  L = mk({}, { tg: tgHang });
  L.push('bot-1', { level: 'err', msg: 'treo' });
  const t0 = Date.now();
  await L.flushNow(400);
  assert.ok(Date.now() - t0 < 1500, 'flushNow bị chặn ≤ timeout');
  hang.closeAllConnections && hang.closeAllConnections();
  hang.close();

  // ---------- 13) xem lại theo yêu cầu ----------
  mock.calls.length = 0;
  L = mk({ levels: ['err'] });
  for (let i = 1; i <= 6; i++) L.push('bot-1', { level: 'ok', msg: `b1-${i}` });
  L.push('bot-2', { level: 'warn', msg: 'b2-x' });
  L.push('bot-1', { level: 'chat', msg: '<Steve> secret chat' });
  L.push('system', { level: 'ok', msg: 'sys-line' });
  assert.strictEqual(L.buffered, 0, 'mức err thì không tự gửi gì');
  let r = await L.sendRecent({ bot: 'bot-1', n: 3 });
  assert.strictEqual(r.count, 3);
  m = sent(mock).at(-1).body;
  assert.ok(m.text.includes('b1-4') && m.text.includes('b1-6') && !m.text.includes('b1-3') && !m.text.includes('b2-x'), 'n dòng cuối của đúng bot');
  assert.ok(!m.text.includes('secret chat'), 'chat người chơi không gửi nếu chưa bật');
  assert.strictEqual(m.disable_notification, true);
  mock.calls.length = 0;
  r = await L.sendRecent({ n: 100 });
  assert.strictEqual(r.count, 9 - 1, 'không chỉ mức err: mọi mức trừ chat');
  assert.ok(sent(mock)[0].body.text.includes('sys-line') && sent(mock)[0].body.text.includes('b2-x'));
  r = await L.sendRecent({ bot: 'system', n: 5 });
  assert.strictEqual(r.count, 1);
  r = await L.sendRecent({ bot: 'khong-co' });
  assert.strictEqual(r.count, 0);
  L.configure({ levels: ['err', 'chat'] });
  mock.calls.length = 0;
  await L.sendRecent({ bot: 'bot-1', n: 1 });
  assert.ok(sent(mock)[0].body.text.includes('secret chat'), 'bật chat thì /logs có cả chat');
  // test()
  mock.calls.length = 0;
  assert.strictEqual((await L.test()).ok, true);
  assert.ok(sent(mock)[0].body.text.includes('Kiểm tra log runtime'));
  assert.strictEqual((await mk({}, { tg: tgDown }).test()).ok, false);
  assert.strictEqual((await mk({}, { tg: new TelegramNotifier({}) }).test()).ok, false);

  // ---------- 14) tích hợp BotManager ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgl-'));
  const cfgPath = path.join(dir, 'config.json');
  const writeCfg = (extra = {}) => fs.writeFileSync(cfgPath, JSON.stringify({
    bots: [], telegramToken: TOKEN, telegramChatId: '555', telegramCommands: false, telegramRefreshSec: 0, ...extra,
  }));
  writeCfg();
  const seen = [];
  const mgr = new BotManager({ configPath: cfgPath, onBotLog: (id, e) => seen.push([id, e]) });
  await mgr.init();
  mgr.telegram.apiBase = mock.base;
  mgr.telegramLogs.intervalMs = 100;
  assert.strictEqual(mgr.telegramLogs.enabled, true, 'mặc định BẬT khi Telegram đã cấu hình');
  assert.strictEqual(TelegramLogger.presetOf(mgr.telegramLogs.levels), 'all');
  // log của bot (sự kiện 'log' y hệt BotSession.log) đi vào Telegram, và console vẫn nhận như cũ
  const bot = new EventEmitter();
  bot.cfg = { id: 'bot-1', botPassword: 'SuperSecret1' };
  bot.shutdown = () => { };
  mgr.bots.push(bot);
  mgr._wireBotLog(bot);
  const emitLog = (level, msg) => { const entry = { id: 'bot-1', time: Date.now(), level, msg }; bot.emit('log', { level, id: 'bot-1', msg, theme: null, entry }); };
  mock.calls.length = 0;
  emitLog('warn', 'Mất kết nối (SuperSecret1)');
  emitLog('chat', '<Steve> hi');
  assert.strictEqual(seen.length, 2, 'onBotLog (console) vẫn nhận mọi log như trước');
  assert.strictEqual(seen[0][0], 'bot-1');
  assert.strictEqual(mgr.telegramLogs.buffered, 1, 'Telegram nhận log (chat bị lọc)');
  await mgr.telegramLogs.flush();
  assert.ok(sent(mock)[0].body.text.includes('<b>bot-1</b> ⚠️ Mất kết nối (***)'), 'mật khẩu của bot bị che: ' + sent(mock)[0].body.text);
  // không có onBotLog (Render/Docker, không console tương tác) thì log vẫn lên Telegram
  const mgr2 = new BotManager({ configPath: cfgPath });
  await mgr2.init();
  mgr2.telegram.apiBase = mock.base;
  const bot2 = new EventEmitter(); bot2.cfg = { id: 'b2' };
  mgr2._wireBotLog(bot2);
  bot2.emit('log', { level: 'err', id: 'b2', msg: 'x', entry: { id: 'b2', time: Date.now(), level: 'err', msg: 'x' } });
  assert.strictEqual(mgr2.telegramLogs.buffered, 1);
  mgr2.shutdown();
  // log hệ thống
  mgr.runtimeLog('err', '[UNCAUGHT] boom');
  assert.strictEqual(mgr.telegramLogs.buffered, 1);
  mock.calls.length = 0;
  await mgr.flushTelegramLogs(2000);
  assert.ok(sent(mock)[0].body.text.includes('<b>system</b> ❌ [UNCAUGHT] boom'));

  // CLI "telegram logs ..."
  const cli = async (...a) => (await mgr.telegramLogsCommand(a)).map(([k, t]) => `${k}:${t.trim()}`);
  let out = await cli();
  assert.ok(out[0].startsWith('ok:Log runtime → Telegram: BẬT'), out[0]);
  assert.ok(out.some(l => l.includes('Gộp mỗi')) && out.some(l => l.includes('chat người chơi: tắt')));
  out = await cli('level', 'warn');
  assert.ok(out[0].startsWith('ok:✓ Mức log'));
  assert.deepStrictEqual(mgr.persistence.get('telegramLogLevels'), ['warn', 'err', 'health']);
  assert.deepStrictEqual([...mgr.telegramLogs.levels], ['warn', 'err', 'health'], 'áp dụng ngay, không cần khởi động lại');
  out = await cli('level', 'bogus');
  assert.ok(out[0].startsWith('warn:') && out[0].includes('không có'));
  assert.deepStrictEqual(mgr.persistence.get('telegramLogLevels'), ['warn', 'err', 'health'], 'mức sai không làm đổi cấu hình');
  out = await cli('level');
  assert.ok(out.some(l => l.includes('Đang gửi: warn, err, health')));
  await cli('chat', 'on');
  assert.ok(mgr.telegramLogs.levels.has('chat') && mgr.persistence.get('telegramLogLevels').includes('chat'));
  await cli('chat', 'off');
  assert.ok(!mgr.telegramLogs.levels.has('chat'));
  assert.ok((await cli('chat', 'maybe'))[0].startsWith('warn:'));
  await cli('level', 'all');
  out = await cli('bots', 'bot-1,ghost');
  assert.deepStrictEqual(mgr.persistence.get('telegramLogBots'), ['bot-1', 'ghost']);
  assert.ok(out.some(l => l.startsWith('warn:') && l.includes('ghost')), 'cảnh báo id chưa có');
  assert.deepStrictEqual([...mgr.telegramLogs.bots], ['bot-1', 'ghost']);
  await cli('bots', 'all');
  assert.strictEqual(mgr.telegramLogs.bots, null);
  assert.strictEqual(mgr.persistence.get('telegramLogBots'), null);
  out = await cli('every', '30s');
  assert.strictEqual(mgr.persistence.get('telegramLogEverySec'), 30);
  assert.strictEqual(mgr.telegramLogs.status().intervalSec, 30);
  assert.ok((await cli('every', '1s'))[0].startsWith('warn:'), 'tối thiểu 2s');
  assert.ok((await cli('every', 'abc'))[0].startsWith('warn:'));
  assert.strictEqual(mgr.persistence.get('telegramLogEverySec'), 30);
  await cli('silent', 'off');
  assert.strictEqual(mgr.telegramLogs.silent, false);
  await cli('silent', 'on');
  mgr.telegramLogs.intervalMs = 100;
  // send / test
  mock.calls.length = 0;
  out = await cli('send', 'bot-1', '5');
  assert.ok(out[0].startsWith('ok:✓ Đã gửi') && out[0].includes('bot-1'), out[0]);
  assert.ok(sent(mock)[0].body.text.includes('Mất kết nối'));
  out = await cli('send', 'ghost');
  assert.ok(out[0].startsWith('warn:'));
  mock.calls.length = 0;
  out = await cli('test');
  assert.ok(out[0].startsWith('ok:✓'));
  assert.ok(sent(mock)[0].body.text.includes('Kiểm tra log runtime'));
  assert.ok((await cli('lung-tung')).some(l => l.includes('Usage')));
  // tắt / bật
  out = await cli('off');
  assert.strictEqual(mgr.telegramLogs.enabled, false);
  assert.strictEqual(mgr.persistence.get('telegramLogs'), false);
  mgr.runtimeLog('err', 'không gửi');
  assert.strictEqual(mgr.telegramLogs.buffered, 0);
  out = await cli('on');
  assert.strictEqual(mgr.telegramLogs.enabled, true);

  // /logs trong Telegram
  const replies = [];
  const reply = (t) => { replies.push(t); return tg.send(t); };
  mock.calls.length = 0;
  await mgr._onTelegramEvent({ type: 'command', cmd: 'logs', arg: 'bot-1 2', reply });
  assert.strictEqual(sent(mock).length, 1);
  assert.ok(sent(mock)[0].body.text.includes('<b>bot-1</b>'));
  await mgr._onTelegramEvent({ type: 'command', cmd: 'logs', arg: 'ghost', reply });
  assert.ok(replies.at(-1).includes('Chưa có log nào của "ghost"'));
  await mgr._onTelegramEvent({ type: 'command', cmd: 'logs', arg: 'off', reply });
  assert.strictEqual(mgr.telegramLogs.enabled, false);
  assert.ok(replies.at(-1).includes('TẮT'));
  await mgr._onTelegramEvent({ type: 'command', cmd: 'logs', arg: 'on', reply });
  assert.strictEqual(mgr.telegramLogs.enabled, true);
  await mgr._onTelegramEvent({ type: 'command', cmd: 'logs', arg: 'status', reply });
  assert.ok(replies.at(-1).includes('Log runtime') && replies.at(-1).includes('Mức'));
  // "/logs 123": số trần là SỐ DÒNG, trừ khi có bot tên đúng như vậy
  assert.deepStrictEqual(mgr._parseLogsTarget(['123']), { id: null, n: 123 });
  assert.deepStrictEqual(mgr._parseLogsTarget(['bot-1']), { id: 'bot-1', n: 25 });
  assert.deepStrictEqual(mgr._parseLogsTarget(['bot-1', '40']), { id: 'bot-1', n: 40 });
  assert.deepStrictEqual(mgr._parseLogsTarget(['System', '7']), { id: 'system', n: 7 });
  bot.cfg.id = '123';
  assert.deepStrictEqual(mgr._parseLogsTarget(['123']), { id: '123', n: 25 });
  assert.deepStrictEqual(mgr._parseLogsTarget(['123', '9']), { id: '123', n: 9 });
  bot.cfg.id = 'bot-1';
  // /help liệt kê lệnh mới
  assert.ok(require('../src/core/TelegramPanel').HELP_TEXT.includes('/logs'));

  // đọc cấu hình từ config.json
  writeCfg({ telegramLogs: false, telegramLogLevels: 'warn', telegramLogEverySec: 20, telegramLogBots: ['x'], telegramLogSilent: false, telegramLogMaxPerMin: 3 });
  const mgr3 = new BotManager({ configPath: cfgPath });
  await mgr3.init();
  assert.deepStrictEqual(mgr3.telegramLogs.status(), { ...mgr3.telegramLogs.status(), enabled: false, intervalSec: 20, silent: false, maxPerMin: 3, bots: ['x'], levels: ['warn', 'err', 'health'], preset: 'warn' });
  mgr3.shutdown();
  // tắt Telegram (telegram off) thì log im lặng hoàn toàn
  mgr.setTelegram(null, null);
  mock.calls.length = 0;
  emitLog('err', 'x');
  mgr.runtimeLog('err', 'y');
  assert.strictEqual(mgr.telegramLogs.buffered, 0);
  await mgr.flushTelegramLogs(500);
  assert.strictEqual(sent(mock).length, 0);

  mgr.shutdown();
  mock.server.close();
  console.log('telegram-logs.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
