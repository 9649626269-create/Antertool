'use strict';
// Log runtime -> Telegram: 1 FILE chung cho mọi bot, sửa tại chỗ theo chu kỳ, lọc mức/bot, gộp dòng lặp, che mật khẩu/token,
// chống 429/giới hạn nhịp, gửi lỗi không mất log, gửi nốt khi tắt, lệnh CLI "telegram logs ..." và lệnh /logs trong Telegram.
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

const mock = { editError: null }; // editError = { code, description } -> editMessageMedia trả lỗi đó
function startMock() {
  const calls = [];
  let nextId = 500;
  const server = http.createServer((req, res) => {
    const bufs = [];
    req.on('data', c => bufs.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(bufs).toString('utf8');
      const method = req.url.split('/').pop();
      let body = {};
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) { // sendDocument: dựng lại { chat_id, caption, ..., filename, text }
        for (const part of raw.split('--' + ct.split('boundary=')[1])) {
          const mm = /Content-Disposition: form-data; name="(\w+)"(?:; filename="([^"]*)")?\r\n(?:Content-Type: [^\r]*\r\n)?\r\n([\s\S]*?)\r\n$/.exec(part);
          if (!mm) continue;
          if (mm[2] !== undefined) { body.filename = mm[2]; body.text = mm[3]; } else body[mm[1]] = mm[3];
        }
        if (body.disable_notification === 'true') body.disable_notification = true;
        if (method === 'editMessageMedia' && body.media) { // editMessageMedia: chú thích nằm trong JSON "media"
          try { const mj = JSON.parse(body.media); body.caption = mj.caption; body.mediaType = mj.type; } catch { }
        }
      } else if (raw) body = JSON.parse(raw);
      calls.push({ method, body });
      const out = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (method === 'editMessageMedia' && mock.editError) return out({ ok: false, error_code: mock.editError.code || 400, description: mock.editError.description });
      if (method === 'editMessageMedia') return out({ ok: true, result: { message_id: Number(body.message_id) } });
      if (method === 'sendMessage' || method === 'sendDocument') return out({ ok: true, result: { message_id: nextId++ } });
      if (method === 'getUpdates') return out({ ok: true, result: [] });
      out({ ok: true, result: true });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}
// log gửi dạng FILE .txt: sendDocument (tạo file) + editMessageMedia (sửa file tại chỗ); body.filename, body.text = nội dung file
const sent = (m) => m.calls.filter(c => c.method === 'sendDocument' || c.method === 'editMessageMedia');
const created = (m) => m.calls.filter(c => c.method === 'sendDocument');
const edited = (m) => m.calls.filter(c => c.method === 'editMessageMedia');

(async () => {
  Object.assign(mock, await startMock());
  const tg = new TelegramNotifier({ apiBase: mock.base, token: TOKEN, chatId: '555' });
  // logger mới cho mỗi tình huống (khỏi lẫn trạng thái). Chu kỳ dài (60s) để không có lần tự cập nhật xen vào — test gọi flush() tay;
  // riêng mục 3 / 3c dùng chu kỳ ngắn để kiểm tra đúng việc hẹn giờ.
  const mk = (cfg = {}, opts = {}) => {
    const l = new TelegramLogger(opts.tg || tg, { tz: () => 'Asia/Ho_Chi_Minh', ...opts });
    l.configure(cfg);
    l.intervalMs = 60000;
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
  assert.strictEqual(TelegramLogger.parseSeconds('30s'), 30);
  assert.strictEqual(TelegramLogger.parseSeconds('1h'), 3600);
  assert.strictEqual(TelegramLogger.parseSeconds('1h30m'), 5400);
  assert.strictEqual(TelegramLogger.fmtSeconds(10), '10s');
  assert.strictEqual(TelegramLogger.fmtSeconds(60), '1m');
  assert.strictEqual(TelegramLogger.fmtSeconds(3600), '1h');
  assert.strictEqual(TelegramLogger.fmtSeconds(90), '1m30s');

  // ---------- 2) chưa cấu hình Telegram -> im lặng, không tốn bộ nhớ ----------
  const off = new TelegramLogger(new TelegramNotifier({ apiBase: mock.base }));
  off.push('bot-1', { level: 'err', msg: 'x' });
  assert.strictEqual(off.buffered, 0);
  assert.strictEqual(off.recent.length, 0);
  assert.strictEqual(off.active, false);

  // ---------- 3) MỘT file chung cho mọi bot, chạy theo chu kỳ, sửa tại chỗ ----------
  let L = mk();
  L.intervalMs = 100;
  const T0 = Date.UTC(2026, 0, 1, 0, 0, 5); // 07:00:05 giờ VN
  L.push('bot-1', { level: 'ok', msg: 'Đã đăng nhập', time: T0 });
  L.push('bot-2', { level: 'warn', msg: 'Mất kết nối', time: T0 + 1000 });
  L.push('bot-1', { level: 'sys', msg: 'Click slot 24', time: T0 + 2000 });
  assert.strictEqual(L.buffered, 3);
  assert.strictEqual(sent(mock).length, 0, 'chưa tới nhịp thì chưa gửi');
  await sleep(450); // tới nhịp
  assert.strictEqual(sent(mock).length, 1, '3 dòng của 2 bot -> ĐÚNG 1 file (không còn file riêng từng bot)');
  assert.strictEqual(mock.calls.filter(c => c.method === 'sendMessage').length, 0, 'không gửi dạng tin văn bản');
  let m = sent(mock)[0].body;
  assert.strictEqual(sent(mock)[0].method, 'sendDocument', 'lần đầu: tạo file');
  assert.strictEqual(m.filename, 'log_all.txt');
  assert.strictEqual(m.disable_notification, true, 'tin đầu im lặng (không rung)');
  assert.strictEqual(m.chat_id, '555');
  assert.ok(m.caption.includes('2 bot') && m.caption.includes('3 dòng') && m.caption.includes('⚠️ 1'), m.caption);
  assert.ok(m.reply_markup && m.reply_markup.includes('lg:now'), 'có nút 🔄 Cập nhật ngay: ' + m.reply_markup);
  assert.ok(m.text.includes('07:00:05 [OK    ] bot-1: Đã đăng nhập'), m.text);
  assert.ok(m.text.includes('07:00:06 [WARN  ] bot-2: Mất kết nối'), 'log của bot-2 nằm cùng file');
  assert.ok(m.text.includes('07:00:07 [SYS   ] bot-1: Click slot 24'));
  assert.ok(m.text.indexOf('Đã đăng nhập') < m.text.indexOf('Mất kết nối') && m.text.indexOf('Mất kết nối') < m.text.indexOf('Click slot'), 'xếp theo thứ tự thời gian, xen kẽ giữa các bot');
  assert.ok(m.text.includes('── 01/01/2026 ──'), 'có dòng ngăn ngày');
  assert.ok(!m.text.includes('STATS SERVER'), 'không có nguồn stats thì không có phần stats');
  assert.strictEqual(L.buffered, 0);
  assert.strictEqual(L.status().created, 1);
  assert.strictEqual(L.status().lines, 3);
  assert.strictEqual(L.status().hasMessage, true);
  const firstId = L._msgId;
  assert.ok(firstId >= 500);

  // 3b) log mới -> SỬA đúng tin đó (editMessageMedia), file chứa cả log cũ lẫn mới, không tạo tin mới
  mock.calls.length = 0;
  L.push('bot-2', { level: 'err', msg: 'Lỗi mới', time: T0 + 5000 });
  L.push('bot-3', { level: 'ok', msg: 'Bot thứ ba', time: T0 + 6000 });
  await L.flush();
  assert.strictEqual(created(mock).length, 0, 'không tạo tin mới');
  assert.strictEqual(edited(mock).length, 1, 'sửa tại chỗ');
  m = edited(mock)[0].body;
  assert.strictEqual(String(m.message_id), String(firstId), 'sửa đúng tin đã tạo');
  assert.strictEqual(m.mediaType, 'document');
  assert.strictEqual(m.filename, 'log_all.txt');
  assert.ok(m.text.includes('Đã đăng nhập') && m.text.includes('Mất kết nối') && m.text.includes('Lỗi mới') && m.text.includes('Bot thứ ba'), 'file = toàn bộ log của mọi bot: ' + m.text);
  assert.ok(m.caption.includes('3 bot') && m.caption.includes('5 dòng') && m.caption.includes('❌ 1'), m.caption);
  assert.ok(m.reply_markup && m.reply_markup.includes('lg:now'), 'nút 🔄 giữ nguyên sau khi sửa');
  assert.strictEqual(L.status().updates, 1);
  assert.strictEqual(L.status().created, 1);
  // không có gì mới -> khỏi gọi Telegram
  mock.calls.length = 0;
  await L.flush();
  assert.strictEqual(sent(mock).length, 0, 'log + stats y hệt -> bỏ qua');
  // làm mới tay (nút 🔄): cập nhật cả khi không có gì mới (làm mới giờ)
  const rf = await L.refresh();
  assert.strictEqual(rf.ok, true, rf.message);
  assert.strictEqual(edited(mock).length, 1, 'refresh sửa file ngay');
  assert.ok((await mk().refresh()).ok === false, 'chưa có log -> báo, không gửi');
  // tin im lặng chỉ áp cho lần tạo; silent=false -> tin đầu có rung
  mock.calls.length = 0;
  const Ls = mk({ silent: false });
  Ls.push('bot-1', { level: 'ok', msg: 'a' });
  await Ls.flush();
  assert.strictEqual(created(mock)[0].body.disable_notification, undefined, 'silent=false -> tin đầu có rung');
  Ls.push('bot-1', { level: 'ok', msg: 'b' });
  await Ls.flush();
  assert.strictEqual(edited(mock)[0].body.disable_notification, undefined, 'sửa file thì không bao giờ rung');

  // 3c) chạy theo chu kỳ: stats đổi (không có log mới) vẫn được cập nhật ở nhịp kế; stats y hệt thì không gọi Telegram
  mock.calls.length = 0;
  let money = 100;
  const Lp = mk({}, { stats: () => ({ title: 'sb', lines: [`MONEY ${money}`] }), botIds: () => ['bot-1', 'bot-idle'] });
  Lp.intervalMs = 100;
  Lp.push('bot-1', { level: 'ok', msg: 'x', time: T0 });
  await sleep(350);
  assert.strictEqual(created(mock).length, 1, 'tạo file ở nhịp đầu');
  assert.ok(created(mock)[0].body.text.includes('MONEY 100'));
  assert.ok(created(mock)[0].body.text.includes('[bot-idle]'), 'stats cả bot chưa có log nào');
  await sleep(350);
  assert.strictEqual(sent(mock).length, 1, 'không đổi gì -> các nhịp sau không gọi Telegram');
  money = 250;
  await sleep(350);
  assert.strictEqual(edited(mock).length, 1, 'stats đổi -> nhịp kế sửa file dù không có log mới');
  assert.ok(edited(mock)[0].body.text.includes('MONEY 250'));
  Lp.stop();
  assert.strictEqual(Lp._timer, null, 'stop() gỡ hẹn giờ');

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
  // chu kỳ do bạn chọn: dòng err cũng chờ đúng chu kỳ (muốn xem ngay: telegram logs now / nút 🔄)
  L = mk(); L.intervalMs = 30000;
  L.push('bot-1', { level: 'ok', msg: 'bình thường' });
  assert.ok(L._dueAt - Date.now() > 20000, 'dòng thường chờ hết chu kỳ');
  L.push('bot-1', { level: 'err', msg: 'lỗi!' });
  assert.ok(L._dueAt - Date.now() > 20000, 'err cũng theo chu kỳ đã chọn (vd 1h thì 1h)');
  L.configure({ intervalSec: 5 });
  assert.ok(L._dueAt - Date.now() <= 5100, 'đổi chu kỳ ngắn lại -> áp dụng ngay');
  L.configure({ intervalSec: 99999999 });
  assert.strictEqual(L.status().intervalSec, 86400, 'tối đa 24h');
  L.configure({ intervalSec: 1 });
  assert.strictEqual(L.status().intervalSec, 2, 'tối thiểu 2s');
  L._clearBuffer();
  // lọc áp dụng cả lúc dựng file: đổi mức SAU khi log đã vào thì file chỉ còn mức mới
  mock.calls.length = 0;
  L = mk();
  L.push('bot-1', { level: 'ok', msg: 'dòng-ok' });
  L.push('bot-1', { level: 'err', msg: 'dòng-err' });
  L.configure({ levels: ['err'] });
  await L.flush();
  assert.ok(sent(mock)[0].body.text.includes('dòng-err') && !sent(mock)[0].body.text.includes('dòng-ok'), 'đổi mức -> file dựng lại theo mức mới');
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
  assert.ok(m.includes('bot-1: lặp (×3)'), m);
  assert.strictEqual((m.match(/\(×/g) || []).length, 1);
  assert.ok(m.includes('a <b>&</b> đỏ ansi'), 'file văn bản thuần (không escape HTML), bỏ §c và mã ANSI: ' + m);
  assert.ok(m.includes('bảng:\n           ↳ hàng 1\n           ↳ hàng 2'), 'log nhiều dòng thụt vào');
  // lặp kéo dài > 1 phút: ghi thêm giờ lặp gần nhất (và gộp cả khi dòng đã nằm trên file)
  mock.calls.length = 0;
  const Lr = mk();
  Lr.push('bot-1', { level: 'ok', msg: 'nhịp tim', time: T0 });
  await Lr.flush();
  Lr.push('bot-1', { level: 'ok', msg: 'nhịp tim', time: T0 + 5 * 60000 });
  assert.strictEqual(Lr.buffered, 0, 'dòng lặp gộp vào dòng cũ, không thêm mục');
  await Lr.flush();
  assert.ok(edited(mock)[0].body.text.includes('nhịp tim (×2 · tới 07:05:05)'), edited(mock)[0].body.text);
  // mục quá dài bị cắt, nhiều dòng quá bị cắt
  mock.calls.length = 0;
  L = mk();
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
  assert.ok(m.includes('<telegram-token>') && !m.includes('AAHxxx'), m);
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
  assert.ok(sent(mock)[0].body.text.includes('00:00:05 [OK'), 'theo múi giờ cấu hình');
  L = mk({}, { tz: () => 'Not/AZone' });
  L.push('bot-1', { level: 'ok', msg: 'giờ', time: T0 });
  await L.flush();
  assert.ok(/\d\d:\d\d:\d\d \[OK/.test(sent(mock).at(-1).body.text), 'múi giờ sai không làm hỏng việc gửi');

  // ---------- 8) file chỉ giữ N dòng mới nhất ----------
  mock.calls.length = 0;
  L = mk({ keepLines: 50 });
  assert.strictEqual(L.keepLines, 50);
  for (let i = 0; i < 120; i++) L.push('bot-1', { level: 'sys', msg: `dòng số ${i} ` + 'z'.repeat(60) });
  assert.strictEqual(L.status().lines, 50, 'file giữ đúng 50 dòng mới nhất');
  assert.strictEqual(L.status().dropped, 70);
  await L.flush();
  assert.strictEqual(sent(mock).length, 1, 'vẫn 1 file');
  const all = sent(mock)[0].body.text;
  assert.ok(all.includes('đã bỏ qua 70 dòng cũ'), 'báo số dòng bị bỏ');
  assert.ok(all.includes('dòng số 119 ') && all.includes('dòng số 70 ') && !all.includes('dòng số 69 '), 'bỏ dòng CŨ nhất, giữ dòng mới');
  L.configure({ keepLines: 1 });
  assert.strictEqual(L.keepLines, 50, 'tối thiểu 50 dòng');
  L.configure({ keepLines: 999999 });
  assert.strictEqual(L.keepLines, 5000, 'tối đa 5000 dòng');
  // mặc định 1000 dòng: nhiều bot cùng đẩy log vẫn là 1 file
  mock.calls.length = 0;
  L = mk();
  assert.strictEqual(L.keepLines, 1000);
  for (let i = 0; i < 300; i++) L.push(`bot-${i % 3}`, { level: 'sys', msg: `d${i} ` + 'z'.repeat(60) });
  await L.flush();
  assert.strictEqual(sent(mock).length, 1);
  assert.ok(sent(mock)[0].body.text.length > 20000 && sent(mock)[0].body.text.includes('bot-0:') && sent(mock)[0].body.text.includes('bot-2:'), 'đủ log của cả 3 bot trong 1 file');

  // ---------- 9) giới hạn nhịp (lần cập nhật/phút) ----------
  mock.calls.length = 0;
  L = mk({ maxPerMin: 2 });
  L.push('bot-1', { level: 'ok', msg: 'A' }); await L.flush();
  L.push('bot-1', { level: 'ok', msg: 'B' }); await L.flush();
  L.push('bot-1', { level: 'ok', msg: 'C' }); await L.flush();
  assert.strictEqual(sent(mock).length, 2, 'đủ 2 lần/phút thì giữ lại');
  assert.strictEqual(L.buffered, 1);
  assert.ok(L._dueAt - Date.now() > 50000, 'hẹn cập nhật lại sau khi hết cửa sổ 1 phút');
  L._sentAt = [];
  await L.flush();
  assert.strictEqual(sent(mock).length, 3, 'hết giới hạn thì cập nhật tiếp');
  assert.ok(sent(mock)[2].body.text.includes('C') && sent(mock)[2].body.text.includes('A'), 'file có đủ A, B, C');
  // flush(true) (tắt tool) bỏ qua giới hạn nhịp
  L.push('bot-1', { level: 'ok', msg: 'D' });
  await L.flush(true);
  assert.strictEqual(sent(mock).length, 4);
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

  // ---------- 11) gửi lỗi: KHÔNG mất log, thử lại thưa dần, khi nối lại thì cập nhật đủ ----------
  const tgDown = new TelegramNotifier({ apiBase: 'http://127.0.0.1:1', token: TOKEN, chatId: '555' });
  L = mk({}, { tg: tgDown });
  L.push('bot-1', { level: 'err', msg: 'không gửi được' });
  await L.flush(true);
  assert.strictEqual(L.buffered, 1, 'lần 1 lỗi -> vẫn còn mục chưa lên file');
  assert.strictEqual(L.status().failed, 1);
  assert.ok(L._dueAt - Date.now() > 10000, 'lỗi mạng: thử lại thưa (≥15s), không dội');
  await L.flush(true);
  await L.flush(true);
  assert.strictEqual(L.buffered, 1, 'lỗi nhiều lần vẫn không bỏ log');
  assert.strictEqual(L.status().failed, 3);
  L.push('bot-2', { level: 'ok', msg: 'thêm trong lúc mất mạng' });
  L.tg = tg; // mạng có lại
  mock.calls.length = 0;
  await L.flush(true);
  assert.strictEqual(L.buffered, 0);
  assert.ok(sent(mock)[0].body.text.includes('không gửi được') && sent(mock)[0].body.text.includes('thêm trong lúc mất mạng'), 'có lại mạng -> file đủ log của cả lúc mất mạng');
  L._clearBuffer();
  // sửa file lỗi tạm thời (Telegram 5xx/429): giữ tin cũ, KHÔNG tạo tin trùng, thử lại sau
  mock.calls.length = 0;
  L = mk();
  L.push('bot-1', { level: 'ok', msg: 'v1' }); await L.flush();
  const keepId = L._msgId;
  mock.editError = { code: 502, description: 'Bad Gateway' };
  L.push('bot-1', { level: 'ok', msg: 'v2' }); await L.flush();
  assert.strictEqual(created(mock).length, 1, 'lỗi tạm thời -> không tạo tin mới');
  assert.strictEqual(L._msgId, keepId, 'giữ nguyên tin đang cập nhật');
  assert.strictEqual(L.status().failed, 1);
  assert.strictEqual(L.buffered, 1);
  // tin cũ bị xoá -> tự gửi lại file mới (im lặng) và dùng tin mới từ đó
  mock.editError = { code: 400, description: 'Bad Request: message to edit not found' };
  await L.flush(true);
  assert.strictEqual(created(mock).length, 2, 'tin bị xoá -> gửi file mới');
  assert.ok(created(mock)[1].body.text.includes('v1') && created(mock)[1].body.text.includes('v2'));
  assert.notStrictEqual(L._msgId, keepId);
  assert.strictEqual(L.buffered, 0);
  // nội dung y hệt (Telegram báo "not modified") -> coi như xong
  mock.editError = { code: 400, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' };
  L.push('bot-1', { level: 'ok', msg: 'v3' }); await L.flush();
  assert.strictEqual(L.buffered, 0, 'not modified = ok');
  mock.editError = null;
  // đổi token/chat -> tạo file mới
  L.resetMessage();
  mock.calls.length = 0;
  L.push('bot-1', { level: 'ok', msg: 'v4' }); await L.flush();
  assert.strictEqual(created(mock).length, 1, 'resetMessage -> lần sau tạo file mới');
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
  assert.deepStrictEqual(sent(mock).map(x => x.body.filename), ['log_all.txt'], 'không chọn bot -> 1 file chứa tất cả bot + hệ thống');
  assert.ok(sent(mock)[0].body.text.includes('system: sys-line') && sent(mock)[0].body.text.includes('bot-2: b2-x') && sent(mock)[0].body.text.includes('bot-1: b1-1'));
  assert.strictEqual(L._msgId, null, '/logs gửi file RIÊNG, không đụng file đang cập nhật');
  mock.calls.length = 0;
  r = await L.sendRecent({ bot: 'system', n: 5 });
  assert.strictEqual(r.count, 1);
  assert.strictEqual(sent(mock)[0].body.filename, 'log_system.txt');
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
  mgr.telegramLogs.intervalMs = 60000; // test tự gọi flush(); không để hẹn giờ xen vào
  assert.strictEqual(mgr.telegramLogs.enabled, true, 'mặc định BẬT khi Telegram đã cấu hình');
  assert.strictEqual(mgr.telegramLogs.keepLines, 1000);
  assert.strictEqual(TelegramLogger.presetOf(mgr.telegramLogs.levels), 'all');
  // log của bot (sự kiện 'log' y hệt BotSession.log) đi vào Telegram, và console vẫn nhận như cũ
  const bot = new EventEmitter();
  bot.cfg = { id: 'bot-1', botPassword: 'SuperSecret1' };
  bot.shutdown = () => { };
  bot.state = { connState: 'online', ping: 23, money: 0, shard: 0 };
  bot.readBoard = () => ({ title: 'kingmcxxx', lines: [{ text: 'MONEY 832.5M', score: 5 }, { text: 'SHARD 1045', score: 4 }, { text: 'KILLS 67', score: 3 }] });
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
  m = sent(mock)[0].body;
  assert.strictEqual(m.filename, 'log_all.txt');
  assert.ok(m.text.includes('[WARN  ] bot-1: Mất kết nối (***)'), 'mật khẩu của bot bị che: ' + m.text);
  assert.ok(m.text.includes('===== STATS SERVER =====') && m.text.includes('[bot-1]') && m.text.includes('Scoreboard: kingmcxxx') && m.text.includes('MONEY 832.5M') && m.text.includes('SHARD 1045') && m.text.includes('KILLS 67'), 'stats server ở đầu file: ' + m.text);
  assert.ok(m.text.indexOf('STATS SERVER') < m.text.indexOf('===== LOG'), 'stats nằm trước phần log');
  assert.ok(m.text.includes('Trạng thái: online · ping 23ms'));
  // bot chưa có bảng điểm -> dùng money/shard đã đọc
  bot.readBoard = () => null; bot.state.money = 1500000; bot.state.shard = 12;
  assert.deepStrictEqual(mgr._serverStats('bot-1'), ['Trạng thái: online · ping 23ms', 'Money: 1,500,000', 'Shard: 12']);
  assert.strictEqual(mgr._serverStats('ghost'), null);
  bot.readBoard = () => { throw new Error('boom'); }; // đọc stats lỗi không được làm hỏng việc gửi log
  mgr.telegramLogs.push('bot-1', { level: 'ok', msg: 'vẫn gửi' });
  mock.calls.length = 0;
  await mgr.telegramLogs.flush();
  assert.ok(sent(mock)[0].body.text.includes('vẫn gửi') && !sent(mock)[0].body.text.includes('STATS SERVER'));
  bot.readBoard = () => ({ title: 'kingmcxxx', lines: [{ text: 'MONEY 832.5M', score: 5 }] });
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
  assert.strictEqual(sent(mock)[0].body.filename, 'log_all.txt');
  assert.strictEqual(sent(mock)[0].method, 'editMessageMedia', 'log hệ thống đi cùng file với log bot (sửa tại chỗ)');
  assert.ok(sent(mock)[0].body.text.includes('[ERR   ] system: [UNCAUGHT] boom') && sent(mock)[0].body.text.includes('bot-1: Mất kết nối'), 'cùng 1 file: log hệ thống + log bot');
  // nhiều bot: stats từng bot ở đầu file, log của tất cả xen kẽ theo giờ
  const botB = new EventEmitter();
  botB.cfg = { id: 'bot-2' }; botB.shutdown = () => { }; botB.state = { connState: 'online', ping: 40, money: 0, shard: 0 };
  botB.readBoard = () => ({ title: 'kingmc2', lines: [{ text: 'MONEY 5M', score: 1 }] });
  mgr.bots.push(botB); mgr._wireBotLog(botB);
  const emitB = (level, msg) => botB.emit('log', { level, id: 'bot-2', msg, theme: null, entry: { id: 'bot-2', time: Date.now(), level, msg } });
  emitB('ok', 'bot hai đã vào');
  mock.calls.length = 0;
  await mgr.telegramLogs.flush();
  assert.strictEqual(sent(mock).length, 1);
  const two = sent(mock)[0].body.text;
  assert.ok(two.includes('[bot-1]') && two.includes('[bot-2]') && two.includes('MONEY 5M') && two.includes('MONEY 832.5M'), 'stats của cả 2 bot: ' + two);
  assert.ok(two.includes('bot-2: bot hai đã vào') && two.includes('bot-1: Mất kết nối'), 'log của cả 2 bot trong 1 file');
  mgr.bots.splice(mgr.bots.indexOf(botB), 1);

  // CLI "telegram logs ..."
  const cli = async (...a) => (await mgr.telegramLogsCommand(a)).map(([k, t]) => `${k}:${t.trim()}`);
  let out = await cli();
  assert.ok(out[0].startsWith('ok:Log runtime → Telegram: BẬT'), out[0]);
  assert.ok(out.some(l => l.includes('cập nhật tại chỗ mỗi 1m') && l.includes('log_all.txt')) && out.some(l => l.includes('chat người chơi: tắt')), out.join('\n'));
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
  assert.ok(out[0].startsWith('ok:✓ File log tự cập nhật mỗi 30s'), out[0]);
  assert.ok((await cli('every', '1s'))[0].startsWith('warn:'), 'tối thiểu 2s');
  assert.ok((await cli('every', 'abc'))[0].startsWith('warn:'));
  assert.ok((await cli('every', '25h'))[0].startsWith('warn:'), 'tối đa 24h');
  assert.strictEqual(mgr.persistence.get('telegramLogEverySec'), 30);
  out = await cli('every', '1h');
  assert.strictEqual(mgr.persistence.get('telegramLogEverySec'), 3600);
  assert.strictEqual(mgr.telegramLogs.status().intervalSec, 3600, 'đặt 1h áp dụng ngay');
  assert.ok(out[0].includes('mỗi 1h'), out[0]);
  await cli('every', '1m');
  assert.strictEqual(mgr.telegramLogs.status().intervalSec, 60);
  // keep
  assert.ok((await cli('keep'))[0].includes('1000'), 'xem số dòng đang giữ');
  await cli('keep', '300');
  assert.strictEqual(mgr.persistence.get('telegramLogKeepLines'), 300);
  assert.strictEqual(mgr.telegramLogs.keepLines, 300);
  assert.ok((await cli('keep', '10'))[0].startsWith('warn:'));
  assert.ok((await cli('keep', '99999'))[0].startsWith('warn:'));
  assert.strictEqual(mgr.telegramLogs.keepLines, 300);
  await cli('keep', '1000');
  // now: cập nhật file ngay
  mock.calls.length = 0;
  out = await cli('now');
  assert.ok(out[0].startsWith('ok:✓ Đã cập nhật file log'), out[0]);
  assert.strictEqual(edited(mock).length, 1);
  await cli('silent', 'off');
  assert.strictEqual(mgr.telegramLogs.silent, false);
  await cli('silent', 'on');
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
  assert.strictEqual(sent(mock)[0].body.filename, 'log_bot-1.txt');
  // /logs now + nút 🔄 trên file log -> cập nhật file ngay (tắt/bật ở trên đã xoá bộ nhớ -> cho 1 dòng log mới)
  mgr.runtimeLog('ok', 'log sau khi bật lại');
  await mgr.telegramLogs.flush(true);
  mock.calls.length = 0;
  await mgr._onTelegramEvent({ type: 'command', cmd: 'logs', arg: 'now', reply });
  assert.strictEqual(edited(mock).length, 1, '/logs now sửa file tại chỗ');
  mock.calls.length = 0;
  const answers = [];
  await mgr._onTelegramEvent({ type: 'button', cmd: 'lg', arg: 'now', messageId: 1, reply, answer: (t) => answers.push(t) });
  assert.strictEqual(edited(mock).length, 1, 'nút 🔄 sửa file tại chỗ');
  assert.deepStrictEqual(answers, ['Đã cập nhật file log']);
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
  writeCfg({ telegramLogs: false, telegramLogLevels: 'warn', telegramLogEverySec: 20, telegramLogBots: ['x'], telegramLogSilent: false, telegramLogMaxPerMin: 3, telegramLogKeepLines: 300 });
  const mgr3 = new BotManager({ configPath: cfgPath });
  await mgr3.init();
  assert.deepStrictEqual(mgr3.telegramLogs.status(), { ...mgr3.telegramLogs.status(), enabled: false, intervalSec: 20, silent: false, maxPerMin: 3, keepLines: 300, bots: ['x'], levels: ['warn', 'err', 'health'], preset: 'warn' });
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
