'use strict';
// Kiểm tra toàn diện hệ thống thông báo Discord Webhook Hybrid v2 (DiscordTheme + Notifier + BotSession + BotManager):
// - Bảng chủ đề DiscordTheme phủ kín mọi eventKey (Notifier.EVENT_LABELS + NotificationCenter.EVENT_CATALOG + livePanel + digest)
// - Bố cục chuẩn: tiêu đề Title Case kèm emoji, author (tên bot + icon mc-heads), thumbnail, inline fields, footer "Antertool", ISO timestamp
// - Định dạng phong phú: <t:unix:R>, blockquote lý do kick, code block lệnh/log, thanh tiến độ (▰▰▰▱▱ 60%), tiền tệ ($41.35K)
// - Giới hạn ký tự Discord (256/4096/1024/25/6000/1900), cắt an toàn theo code point (không vỡ surrogate pair), che bí mật
// - Giữ nguyên 100% logic allowed_mentions, mentionEvents, và đầu ra Telegram (telegramAlert byte-identical)
// - Kiểm tra cơ chế Hybrid v2:
//     • Bảng Trạng Thái & Doanh Thu Trực Tiếp (Live Dashboard) tự động sửa tại chỗ (PATCH /messages/:id) mỗi 10s
//     • Gộp chung 1 Webhook duy nhất (revenueNotifier hợp nhất vào notifier)
//     • Upsert tại chỗ cho các báo cáo doanh thu / sự kiện định kỳ (không tạo tin mới làm tràn kênh)
//     • Gộp tin cảnh báo trùng (Dedup in-place: ×N lần)
//     • Tự hồi phục (Auto-Resolve): khi reconnectRecovered tự động sửa (PATCH) ngay trên tin báo kick trước đó
//     • Tự động gửi lại tin mới nếu tin nhắn cũ bị xoá trên Discord (HTTP 404 Unknown Message)
//     • Chống bão thông báo (Storm Control / Digest)
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

const DiscordTheme = require('../src/core/DiscordTheme');
const Notifier = require('../src/core/Notifier');
const { EVENT_CATALOG } = require('../src/core/NotificationCenter');
const RevenueTracker = require('../src/core/RevenueTracker');
const BotSession = require('../src/core/BotSession');
const BotManager = require('../src/services/BotManager');
const { CS } = require('../src/core/constants');

// Kiểm tra nghiêm ngặt mọi giới hạn embed của Discord + không có lone surrogate
function checkLimits(e) {
  let total = 0;
  const checkNoLoneSurrogates = (s, what) => {
    const str = String(s || '');
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF) {
        const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        assert.ok(next >= 0xDC00 && next <= 0xDFFF, `${what} chứa high surrogate lẻ tại vị trí ${i}`);
        i++;
      } else if (code >= 0xDC00 && code <= 0xDFFF) {
        assert.fail(`${what} chứa low surrogate lẻ tại vị trí ${i}`);
      }
    }
  };
  const lim = (t, n, what) => {
    checkNoLoneSurrogates(t, what);
    const l = [...String(t || '')].length;
    assert.ok(l <= n, `${what} dài ${l} > ${n}`);
    total += l;
  };
  lim(e.title, 256, 'title');
  lim(e.description, 4096, 'description');
  lim(e.author?.name, 256, 'author.name');
  lim(e.footer?.text, 2048, 'footer');
  assert.ok(e.author && e.author.name, 'mọi embed phải có author.name');
  assert.ok(e.footer && e.footer.text, 'mọi embed phải có footer.text');
  assert.ok((e.fields || []).length <= 25, 'tối đa 25 field');
  for (const f of e.fields || []) {
    assert.ok(f.name && f.value, 'field không được rỗng');
    lim(f.name, 256, 'field.name');
    lim(f.value, 1024, 'field.value');
  }
  assert.ok(total <= 6000, `embed tổng ${total} > 6000`);
  assert.ok(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff, 'color phải là số nguyên 24-bit');
  assert.ok(!Number.isNaN(Date.parse(e.timestamp)), 'timestamp ISO hợp lệ');
}

const F = (e, name) => (e.fields.find(f => f.name === name) || {}).value;

// Mock Discord Webhook Server hỗ trợ đầy đủ POST ?wait=true, PATCH /messages/:id, DELETE /messages/:id và mô phỏng 404
function startHook() {
  const got = [];
  const messages = new Map();
  const deletedIds = new Set();
  let seq = 1000;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const u = new URL(req.url, 'http://127.0.0.1');
      const patchMatch = /\/messages\/([^/]+)$/.exec(u.pathname);

      if (req.method === 'POST') {
        const id = String(++seq);
        const record = { ...body, _method: 'POST', _id: id, _url: req.url };
        messages.set(id, record);
        got.push(record);
        if (u.searchParams.get('wait') === 'true') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id, channel_id: '1' }));
        } else {
          res.statusCode = 204;
          res.end();
        }
        return;
      }

      if (req.method === 'PATCH' && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        if (deletedIds.has(id) || !messages.has(id)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: 'Unknown Message', code: 10008 }));
          return;
        }
        const record = { ...body, _method: 'PATCH', _id: id, _url: req.url };
        messages.set(id, record);
        got.push(record);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id, channel_id: '1' }));
        return;
      }

      if (req.method === 'DELETE' && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        deletedIds.add(id);
        messages.delete(id);
        got.push({ _method: 'DELETE', _id: id, _url: req.url });
        res.statusCode = 204;
        res.end();
        return;
      }

      res.statusCode = 204;
      res.end();
    });
  });

  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    server,
    got,
    messages,
    deletedIds,
    url: `http://127.0.0.1:${server.address().port}/api/webhooks/1/x`,
  })));
}

(async () => {
  // 1) Định dạng tiền / giờ / thanh tiến độ / timestamp / blockquote / codeBlock
  const R = RevenueTracker;
  assert.strictEqual(R.formatMoneyDollar(41350), '$41.35K');
  assert.strictEqual(R.formatMoneyDollar(4450000), '$4.45M');
  assert.strictEqual(R.formatMoneyDollar(950), '$950');
  assert.strictEqual(R.formatMoneyDollar(0), '$0');
  assert.strictEqual(R.formatMoneyDollar(2.5e9), '$2.50B');
  assert.strictEqual(DiscordTheme.formatMoney(41350), '$41.35K');
  assert.strictEqual(R.formatClock(33000), '00:00:33');
  assert.strictEqual(R.formatClock(3725000), '01:02:05');
  assert.strictEqual(R.formatClock(100 * 3600000), '100:00:00');
  assert.strictEqual(R.formatClock(-5), '00:00:00');

  assert.strictEqual(DiscordTheme.progressBar(3, 5), '▰▰▰▱▱ 60%');
  assert.strictEqual(DiscordTheme.progressBar(5, 5), '▰▰▰▰▰ 100%');
  assert.strictEqual(DiscordTheme.progressBar(0, 5), '▱▱▱▱▱ 0%');
  assert.strictEqual(DiscordTheme.discordTimestamp(1700000000000, 'R'), '<t:1700000000:R>');
  assert.strictEqual(DiscordTheme.blockquote('Lỗi kết nối\nDòng 2'), '> Lỗi kết nối\n> Dòng 2');
  assert.strictEqual(DiscordTheme.codeBlock('/home treolong'), '```\n/home treolong\n```');

  // 2) Kiểm tra mọi eventKey trong Notifier.EVENT_LABELS và NotificationCenter.EVENT_CATALOG đều có theme hợp lệ
  const allEventKeys = new Set([
    ...Object.keys(Notifier.EVENT_LABELS),
    ...Object.keys(EVENT_CATALOG),
    'test', 'testMention', 'revenueMacro', 'revenueSummary', 'scheduleOut', 'scheduleIn', 'livePanel', 'digest',
  ]);
  for (const key of allEventKeys) {
    const entry = DiscordTheme.EVENT_THEMES[key];
    assert.ok(entry, `Thiếu cấu hình DiscordTheme cho sự kiện "${key}"`);
    assert.ok(entry.emoji && entry.emoji.length > 0, `Sự kiện "${key}" phải có emoji`);
    assert.ok(['success', 'info', 'warning', 'critical', 'report'].includes(entry.severity), `Severity không hợp lệ cho "${key}"`);
    assert.strictEqual(entry.color, DiscordTheme.SEVERITY_COLORS[entry.severity], `Màu của "${key}" phải khớp với severity "${entry.severity}"`);
  }
  assert.strictEqual(Notifier.COLOR.ok, 0x6ef16f, 'Giữ nguyên màu xanh chuẩn 0x6ef16f');
  assert.strictEqual(Notifier.COLOR.report, 0xcf8338, 'Giữ nguyên màu cam báo cáo chuẩn 0xcf8338');

  // 3) Kiểm tra kết nối webhook (test)
  const hook = await startHook();
  const n = new Notifier({ webhookUrl: hook.url });
  assert.strictEqual(await n.test(), true);
  let e = hook.got.at(-1).embeds[0];
  assert.strictEqual(e.title, '✅ Kiểm Tra Kết Nối Webhook');
  assert.strictEqual(e.description, 'Antertool đã kết nối thành công tới Discord!');
  assert.strictEqual(F(e, 'Trạng thái'), 'Hoạt động bình thường');
  assert.ok(F(e, 'Nguồn').includes('Antertool'));
  assert.ok(F(e, 'Thời gian').startsWith('<t:'));
  assert.ok(e.fields.every(f => f.inline));
  assert.strictEqual(e.author.name, 'Antertool');
  assert.strictEqual(e.footer.text, 'Antertool');
  assert.strictEqual(e.color, Notifier.COLOR.ok);
  checkLimits(e);

  // embed tự đặt footer/timestamp/author thì không bị ghi đè; embed trần được bổ sung đầy đủ
  const fin = Notifier.finish({ title: 't', author: { name: 'CustomBot' }, footer: { text: 'X' }, timestamp: '2026-01-01T00:00:00.000Z', color: 1 });
  assert.strictEqual(fin.footer.text, 'X');
  assert.strictEqual(fin.author.name, 'CustomBot');
  assert.strictEqual(fin.timestamp, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(Notifier.finish({ title: 't' }).footer.text, 'Antertool');
  assert.strictEqual(Notifier.finish({ title: 't' }).author.name, 'Antertool');

  // 4) Báo cáo doanh thu của 1 bot (spawn & macro) + Gộp chung 1 Webhook + Cập nhật tại chỗ (In-place Upsert)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ bots: [] }));
  const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
  await mgr.init();
  assert.strictEqual(mgr.revenueNotifier, mgr.notifier, 'revenueNotifier phải được gộp chung vào mgr.notifier');
  assert.strictEqual(mgr.getDiscordRefreshSec(), 10, 'Mặc định tự động cập nhật bảng trực tiếp mỗi 10s');
  mgr.setWebhookUrl(hook.url, ['all']);
  const bot = new BotSession({ id: 'bot-1', host: 'donutsmp.net', port: 25565, username: 'Steve_01', autoSellSpawnRevenue: false }, 'teal', null);
  bot._manager = mgr;
  bot.state.connState = CS.ONLINE;
  mgr.bots.push(bot);
  const t0 = Date.now(), M = 60000;
  mgr.revenue.markOnline('bot-1', t0 - 33000);
  mgr.revenue.record('bot-1', 38e3, { now: t0 - 10 * M, intervalMs: 5 * M, hits: 5 });
  mgr.revenue.record('bot-1', 3350, { now: t0 - 5 * M, intervalMs: 5 * M, hits: 5 });

  e = bot._buildRevenueEmbed({ sum: 3350, done: 4, total: 5, hits: 4 });
  assert.strictEqual(e.title, '💰 Báo Cáo Tổng Kết Auto-Sell Spawn');
  assert.deepStrictEqual(e.fields.map(f => f.name), ['Người chơi', 'Server', 'Thời gian treo', 'Tổng thu nhập', 'Tốc độ trung bình', 'Số lượt bán', 'Trạng thái']);
  assert.deepStrictEqual(e.fields.map(f => !!f.inline), [true, true, true, true, true, true, false], '3 field/hàng rồi tới Trạng thái cả hàng');
  assert.strictEqual(F(e, 'Người chơi'), 'Steve_01 (bot-1)');
  assert.strictEqual(F(e, 'Server'), 'donutsmp.net');
  assert.ok(/^00:00:3\d$/.test(F(e, 'Thời gian treo')), F(e, 'Thời gian treo'));
  assert.strictEqual(F(e, 'Tổng thu nhập'), '$41.35K');
  assert.ok(/^\$[\d.]+[KMB]?\/h$/.test(F(e, 'Tốc độ trung bình')), F(e, 'Tốc độ trung bình'));
  assert.strictEqual(F(e, 'Số lượt bán'), '2');
  const st = F(e, 'Trạng thái');
  assert.ok(st.startsWith('Đang hoạt động'), st);
  assert.ok(st.includes('+$3.35K') && st.includes('4/5 lồng') && st.includes('▰▰▰▰▱ 80%') && st.includes('1 lồng lỗi'), st);
  assert.strictEqual(e.color, Notifier.COLOR.report);
  assert.strictEqual(e.author.name, 'Steve_01 (bot-1)');
  assert.strictEqual(e.author.icon_url, 'https://mc-heads.net/avatar/Steve_01/100');
  assert.strictEqual(e.thumbnail.url, 'https://mc-heads.net/avatar/Steve_01/100');
  assert.strictEqual(e.footer.text, 'Antertool');
  checkLimits(e);

  // chưa có dữ liệu / offline / tên lạ: không vỡ, không gắn ảnh đầu
  const bot2 = new BotSession({ id: 'b2', host: 'h.example', port: 25570, username: 'tên có dấu', autoSellSpawnRevenue: false }, 'teal', null);
  e = bot2._buildRevenueEmbed(null);
  assert.strictEqual(F(e, 'Tổng thu nhập'), '$0');
  assert.strictEqual(F(e, 'Tốc độ trung bình'), '—');
  assert.strictEqual(F(e, 'Server'), 'h.example:25570');
  assert.ok(F(e, 'Trạng thái').startsWith('Ngoại tuyến'));
  assert.strictEqual(e.thumbnail, undefined, 'tên không hợp lệ thì không gắn ảnh đầu');
  assert.strictEqual(e.author.icon_url, undefined, 'tên không hợp lệ thì không gắn icon_url');
  checkLimits(e);

  // Gửi thật qua Notifier: lần 1 là POST ?wait=true, lần 2 là PATCH trên cùng messageId (không làm tràn kênh!)
  hook.got.length = 0;
  assert.strictEqual(bot._sendRevenueReport({ sum: 3350, done: 5, total: 5, hits: 5 }), true);
  await mgr.notifier._queue;
  const revMsg1 = hook.got.at(-1);
  assert.strictEqual(revMsg1._method, 'POST', 'Lần báo cáo đầu tiên phải POST để tạo tin');
  assert.strictEqual(revMsg1.embeds[0].title, '💰 Báo Cáo Tổng Kết Auto-Sell Spawn');
  checkLimits(revMsg1.embeds[0]);

  mgr.revenue.record('bot-1', 5000, { now: t0 - 1 * M, intervalMs: 5 * M, hits: 5 });
  assert.strictEqual(bot._sendRevenueReport({ sum: 5000, done: 5, total: 5, hits: 5 }), true);
  await mgr.notifier._queue;
  const revMsg2 = hook.got.at(-1);
  assert.strictEqual(revMsg2._method, 'PATCH', 'Lần báo cáo thứ 2 phải PATCH sửa tại chỗ, không tạo tin mới');
  assert.strictEqual(revMsg2._id, revMsg1._id, 'Phải sửa đúng trên messageId của lần 1');
  assert.strictEqual(F(revMsg2.embeds[0], 'Tổng thu nhập'), '$46.35K');
  checkLimits(revMsg2.embeds[0]);

  // Nếu người dùng xoá tin nhắn trên Discord (404 Unknown Message), lần tiếp theo tự động POST tạo lại
  hook.deletedIds.add(revMsg1._id);
  assert.strictEqual(bot._sendRevenueReport({ sum: 2000, done: 5, total: 5, hits: 5 }), true);
  await mgr.notifier._queue;
  const revMsg3 = hook.got.at(-1);
  assert.strictEqual(revMsg3._method, 'POST', 'Khi tin cũ bị xoá (404), phải tự động POST lại tin mới');
  assert.notStrictEqual(revMsg3._id, revMsg1._id);

  // macro revenue report
  bot._macroRevPending = { amount: 0, cycles: 0 };
  mgr.revenue.record('bot-1#macro', 1200000, { now: t0, intervalMs: 5 * M, hits: 1 });
  e = bot._buildRevenueEmbed({ sum: 1200000, hits: 1, macro: 'sell', viaBalance: false }, 'macro');
  assert.strictEqual(e.title, '📈 Báo Cáo Tổng Kết Auto-Sell (Macro)');
  assert.strictEqual(F(e, 'Tổng thu nhập'), '$1.20M');
  assert.ok(F(e, 'Trạng thái').includes('macro "sell"'));
  checkLimits(e);

  // 5) Cảnh báo & sự kiện bot + Dedup tại chỗ + Auto-Resolve khi kết nối lại
  e = bot._alertEmbed('🟠 bot-1: bị kick', 'Bạn đã bị kick khỏi server\n⏰ 10:00:00 PM\n🔄 Reconnecting in 15s... (lần thứ 2/5)', 0xf97316, 'disconnect');
  assert.strictEqual(e.title, '🔌 Bị Kick');
  assert.strictEqual(e.color, DiscordTheme.COLOR.critical);
  assert.strictEqual(F(e, 'Người chơi'), 'Steve_01 (bot-1)');
  assert.strictEqual(F(e, 'Server'), 'donutsmp.net');
  assert.ok(F(e, 'Thời gian treo'), 'có field Thời gian treo');
  assert.ok(F(e, 'Lần thử').includes('▰▰▱▱▱ 40%'));
  assert.ok(F(e, 'Kết nối lại').startsWith('<t:'));
  assert.ok(e.description.includes('> Bạn đã bị kick khỏi server'), 'lý do kick nằm trong blockquote');
  assert.ok(e.description.includes('<t:'), 'có Discord relative timestamp');
  assert.strictEqual(e.author.name, 'Steve_01 (bot-1)');
  assert.strictEqual(e.footer.text, 'Antertool');
  checkLimits(e);

  assert.strictEqual(bot._alertEmbed('⚠️ bot-1: đã bật spawnerprotect + autosell_spawn', 'x', 1).title, '✅ Đã Bật spawnerprotect + autosell_spawn');
  assert.strictEqual(bot._alertEmbed('Cảnh báo lạ không có id', 'x', 1).title, 'ℹ️ Cảnh Báo Lạ Không Có Id');

  // Kiểm tra _notify giữ nguyên 100% đầu ra Telegram (byte-identical) đồng thời hỗ trợ Dedup + Auto-Resolve trên Discord
  const tgCaptured = [];
  const origTgAlert = mgr.telegramAlert.bind(mgr);
  mgr.telegramAlert = (b, key, title, desc, hl) => {
    tgCaptured.push({ id: b.cfg.id, key, title, desc, hl });
    return origTgAlert(b, key, title, desc, hl);
  };

  hook.got.length = 0;
  mgr.notifier.setMention('123456789012345678');
  bot._notify('disconnect', '🟠 bot-1: bị kick', 'Mất kết nối máy chủ\n⏰ 10:00:00 PM', 0xf97316, '❌ BOT BỊ KICK');
  await mgr.notifier._queue;
  const k = hook.got.at(-1);
  assert.strictEqual(k._method, 'POST');
  assert.strictEqual(k.content, '❌ BOT BỊ KICK <@123456789012345678>');
  assert.deepStrictEqual(k.allowed_mentions, { parse: [], users: ['123456789012345678'], roles: [] });
  assert.strictEqual(k.embeds[0].title, '🔌 Bị Kick');
  assert.strictEqual(tgCaptured.at(-1).title, '🟠 bot-1: bị kick', 'Telegram nhận nguyên vẹn chuỗi title gốc');
  assert.strictEqual(tgCaptured.at(-1).desc, 'Mất kết nối máy chủ\n⏰ 10:00:00 PM', 'Telegram nhận nguyên vẹn chuỗi description gốc');
  assert.strictEqual(tgCaptured.at(-1).hl, '❌ BOT BỊ KICK', 'Telegram nhận nguyên vẹn chuỗi headline gốc');

  // Bắn tiếp 1 sự kiện disconnect trùng cho cùng bot-1 trong cửa sổ dedup -> phải PATCH sửa tại chỗ kèm ×2
  bot._notify('disconnect', '🟠 bot-1: bị kick', 'Mất kết nối máy chủ (lần 2)\n⏰ 10:00:05 PM', 0xf97316, '❌ BOT BỊ KICK');
  await mgr.notifier._queue;
  const kDedup = hook.got.at(-1);
  assert.strictEqual(kDedup._method, 'PATCH', 'Cảnh báo kick lặp lại trong cửa sổ dedup phải PATCH tại chỗ');
  assert.strictEqual(kDedup._id, k._id, 'Phải sửa đúng trên tin nhắn kick ban đầu');
  assert.ok(kDedup.embeds[0].description.includes('×2 lần'), 'Phải hiển thị bộ đếm ×2 lần');
  checkLimits(kDedup.embeds[0]);

  // Khi bot kết nối lại ổn định (reconnectRecovered) -> phải tự động PATCH ngay tin báo kick đó thành 🟢 Đã Kết Nối Lại Ổn Định (Auto-Resolve!)
  bot._notify('reconnectRecovered', '🟢 bot-1: đã kết nối lại ổn định', 'Sau 2 lần thử.', 0x22c55e);
  await mgr.notifier._queue;
  const kResolved = hook.got.at(-1);
  assert.strictEqual(kResolved._method, 'PATCH', 'reconnectRecovered phải tự động PATCH lên tin báo kick trước đó');
  assert.strictEqual(kResolved._id, k._id, 'Phải sửa đúng trên messageId của tin báo kick');
  assert.strictEqual(kResolved.embeds[0].title, '🟢 Đã Kết Nối Lại Ổn Định');
  assert.strictEqual(kResolved.content, '', 'Khi đã hồi phục thì xoá dòng headline báo động đỏ phía trên');
  checkLimits(kResolved.embeds[0]);

  // Kiểm tra tất cả các loại sự kiện khác qua _alertEmbed
  const sampleAlerts = [
    ['reconnectFailed', '🔴 bot-1: hết lượt reconnect', 'Đã thử 5 lần không thành công (lý do gần nhất: ECONNREFUSED). Sẽ tự thử lại sau 15 phút.', 0xef4444],
    ['reconnectRecovered', '🟢 bot-1: đã kết nối lại ổn định', 'Sau 2 lần thử.', 0x22c55e],
    ['moneyGoal', '🎯 bot-1: đã đủ tiền', 'Mục tiêu 50,000,000, hiện có 52,000,000. Tự chạy macro "chuyen_tien".', 0xfbbf24],
    ['autoSell', '🎒 bot-1: túi đồ đầy', '33/36 ô (92%) — tự chạy macro "autosell".', 0x38bdf8],
    ['spawnerThreat', '⚠️ bot-1: người lạ gần lồng', 'Người lạ: Alex_VN (4.2m)\nĐang bảo vệ 5 lồng.', 0xf59e0b],
    ['protectResult', '✅ bot-1: xử lý bảo vệ lồng', 'Người lạ: Alex_VN\nĐã đập 5/5 lồng.', 0x22c55e],
    ['featuresReady', '✅ bot-1: đã bật spawnerprotect + autosell_spawn', '✅ spawnerprotect: 5 lồng\n⏱️ 4s sau khi vào menu', 0x22c55e],
    ['homeReturn', '🏠 bot-1: lệch khỏi vị trí treo lồng — gõ /home treolong', 'Bot không còn ở gần lồng.\nĐã tự gõ /home treolong để quay về.', 0x38bdf8],
    ['sellFailed', '🚨 bot-1: autosell_spawn thất bại sau 10 lần gõ /home treolong', 'Đã gõ /home treolong 10 lần, sau mỗi lần đều bán lại nhưng vẫn không xong (3/5 lồng).', 0xef4444],
    ['autoOrder', '📦 bot-1: AutoOrder', 'blaze_rod: 12 stack · 5.4M · 01:12:00 · giao hàng', 0x55ffaa],
  ];
  for (const [evKey, rawT, rawD, rawC] of sampleAlerts) {
    const emb = bot._alertEmbed(rawT, rawD, rawC, evKey);
    checkLimits(emb);
    assert.strictEqual(emb.color, DiscordTheme.getTheme(evKey).color, `Màu của ${evKey} phải chuẩn theo theme`);
    assert.ok(emb.title.startsWith(DiscordTheme.getTheme(evKey).emoji), `Tiêu đề của ${evKey} phải bắt đầu bằng emoji theme`);
  }

  // 6) Bảng Trạng Thái & Doanh Thu Trực Tiếp (Live Dashboard 10s) + Báo cáo tổng hợp cả dàn
  const bot3 = new BotSession({ id: 'bot-2', host: 'donutsmp.net', port: 25565, username: 'Alex_02', autoSellSpawnRevenue: false }, 'teal', null);
  bot3._manager = mgr;
  bot3.state.connState = CS.ONLINE;
  mgr.bots.push(bot3);
  mgr.revenue.markOnline('bot-2', t0 - 3600000);
  mgr.revenue.record('bot-2', 5e6, { now: t0 - 10 * M, intervalMs: 5 * M, hits: 3 });
  mgr.revenue.record('bot-2', 4e6, { now: t0 - 5 * M, intervalMs: 5 * M, hits: 3 });

  hook.got.length = 0;
  await mgr.sendDiscordPanel();
  const panel1 = hook.got.at(-1);
  assert.strictEqual(panel1._method, 'POST', 'Lần đầu gửi Bảng Trực Tiếp phải là POST');
  assert.strictEqual(panel1.embeds[0].title, '📡 Bảng Trạng Thái & Doanh Thu Trực Tiếp (2 Bot)');
  assert.ok(panel1.embeds[0].description.includes('bot-1') && panel1.embeds[0].description.includes('bot-2'));
  assert.ok(panel1.embeds[0].footer.text.includes('10s'));
  checkLimits(panel1.embeds[0]);

  await mgr.sendDiscordPanel();
  const panel2 = hook.got.at(-1);
  assert.strictEqual(panel2._method, 'PATCH', 'Lần cập nhật Bảng Trực Tiếp tiếp theo phải là PATCH tại chỗ');
  assert.strictEqual(panel2._id, panel1._id, 'Phải sửa đúng trên messageId của Bảng Trực Tiếp');
  checkLimits(panel2.embeds[0]);

  e = mgr.buildRevenueSummaryEmbed(t0);
  assert.strictEqual(e.title, '📊 Báo Cáo Tổng Kết Doanh Thu (2 Bot)');
  assert.deepStrictEqual(e.fields.map(f => f.name), ['Số bot', 'Server', 'Thời gian treo', 'Tổng thu nhập', 'Tốc độ trung bình', 'Số lượt bán', 'Trạng thái']);
  assert.strictEqual(F(e, 'Server'), 'donutsmp.net');
  assert.ok(F(e, 'Tổng thu nhập').startsWith('$') && F(e, 'Tổng thu nhập').endsWith('M'), F(e, 'Tổng thu nhập'));
  assert.strictEqual(F(e, 'Trạng thái').split('\n')[0], '2/2 bot đang hoạt động');
  assert.ok(F(e, 'Trạng thái').includes('▰▰▰▰▰ 100%'));
  assert.ok(e.description.startsWith('```') && e.description.includes('$'));
  checkLimits(e);

  // 7) Lịch nghỉ (_notifyRest & _doScheduledIn) cập nhật tại chỗ trên cùng slot 'schedule:main'
  hook.got.length = 0;
  mgr._notifyRest({ outTime: '02:00', inTime: '08:00' }, 2);
  mgr._doScheduledIn({ inTime: '08:00' });
  await mgr.notifier._queue;
  const [restMsg, backMsg] = hook.got;
  assert.strictEqual(restMsg._method, 'POST');
  assert.strictEqual(backMsg._method, 'PATCH', 'Hết giờ nghỉ tự động sửa đè trên tin Bắt Đầu Giờ Nghỉ để không làm rác kênh');
  assert.strictEqual(backMsg._id, restMsg._id);
  const rest = restMsg.embeds[0];
  const back = backMsg.embeds[0];
  assert.strictEqual(rest.title, '🌙 Bắt Đầu Giờ Nghỉ');
  assert.strictEqual(rest.color, DiscordTheme.COLOR.warning);
  assert.strictEqual(F(rest, 'Số bot'), '2');
  checkLimits(rest);
  assert.strictEqual(back.title, '☀️ Hết Giờ Nghỉ');
  assert.strictEqual(back.color, DiscordTheme.COLOR.success);
  checkLimits(back);

  // 8) Kiểm tra tin thử mention (testMention)
  hook.got.length = 0;
  mgr.notifier.setMention('123456789012345678');
  assert.strictEqual(await mgr.notifier.testMention(), true);
  const mentionPayload = hook.got.at(-1);
  assert.strictEqual(mentionPayload.content, '❌ BOT BỊ KICK (test) <@123456789012345678>');
  assert.strictEqual(mentionPayload.embeds[0].title, '🔔 Bot Bị Kick (Tin Thử)');
  checkLimits(mentionPayload.embeds[0]);

  // 9) Kiểm tra cắt chuỗi an toàn theo code point (surrogate-safe) & giới hạn 6000 ký tự + che thông tin nhạy cảm (secrets)
  const astralPair = '🔥'.repeat(300) + '\uD800' + 'Lý do rất dài ';
  const hugeFields = Array.from({ length: 30 }, (_, i) => ({
    name: `Trường số ${i} ` + '🚀'.repeat(150),
    value: `Giá trị ${i}: https://discord.com/api/webhooks/999888777/SecretWebhookToken_1234567890 socks5://admin:SuperPass@1.2.3.4:1080 /login MyPass999 ` + '💎'.repeat(600),
    inline: true,
  }));
  const clamped = Notifier.finish({
    title: '🚨 ' + astralPair,
    description: astralPair.repeat(20) + '\n{"botPassword":"HiddenBotPassword123"}',
    fields: hugeFields,
  });
  checkLimits(clamped);
  const clampedJson = JSON.stringify(clamped);
  assert.ok(!clampedJson.includes('SecretWebhookToken_1234567890'), 'Không được lộ Discord webhook token');
  assert.ok(!clampedJson.includes('admin:SuperPass'), 'Không được lộ thông tin xác thực proxy');
  assert.ok(!clampedJson.includes('MyPass999'), 'Không được lộ mật khẩu sau /login');
  assert.ok(!clampedJson.includes('HiddenBotPassword123'), 'Không được lộ botPassword');

  // 10) Kiểm tra lệnh `webhook preview` (Notifier.preview)
  hook.got.length = 0;
  const prevSingle = await mgr.notifier.preview({ onlyKey: 'disconnect' });
  assert.strictEqual(prevSingle.ok, true);
  assert.strictEqual(prevSingle.sent, 1);
  checkLimits(hook.got.at(-1).embeds[0]);

  hook.got.length = 0;
  const prevAll = await mgr.notifier.preview();
  assert.strictEqual(prevAll.ok, true);
  assert.ok(prevAll.sent >= 13, `Phải gửi đủ các mẫu sự kiện kể cả livePanel (đã gửi ${prevAll.sent})`);
  for (const item of hook.got) {
    checkLimits(item.embeds[0]);
  }

  hook.server.close();
  try { mgr.shutdown(); } catch { }
  console.log('discord-embed.test.js: OK');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
