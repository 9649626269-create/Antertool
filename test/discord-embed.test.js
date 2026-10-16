'use strict';
// Embed Discord theo mẫu: "Kiểm Tra Kết Nối Webhook" (xanh) + "Báo Cáo Tổng Kết ..." (cam) với field ngang,
// chân "Antertool • giờ". Dùng webhook GIẢ chạy trên localhost + mineflayer/vec3 giả — không cần mạng.
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
const Notifier = require('../src/core/Notifier');
const RevenueTracker = require('../src/core/RevenueTracker');
const BotSession = require('../src/core/BotSession');
const BotManager = require('../src/services/BotManager');
const { CS } = require('../src/core/constants');

// Giới hạn embed của Discord
function checkLimits(e) {
  let total = 0;
  const lim = (t, n, what) => { const l = [...String(t || '')].length; assert.ok(l <= n, `${what} dài ${l} > ${n}`); total += l; };
  lim(e.title, 256, 'title'); lim(e.description, 4096, 'description'); lim(e.footer?.text, 2048, 'footer');
  assert.ok((e.fields || []).length <= 25, 'tối đa 25 field');
  for (const f of e.fields || []) { assert.ok(f.name && f.value, 'field không được rỗng'); lim(f.name, 256, 'field.name'); lim(f.value, 1024, 'field.value'); }
  assert.ok(total <= 6000, `embed tổng ${total} > 6000`);
  assert.ok(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff);
  assert.ok(!Number.isNaN(Date.parse(e.timestamp)), 'timestamp ISO hợp lệ');
}
const F = (e, name) => (e.fields.find(f => f.name === name) || {}).value;

function startHook() {
  const got = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c);
    req.on('end', () => { got.push(JSON.parse(raw)); res.statusCode = 204; res.end(); });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, got, url: `http://127.0.0.1:${server.address().port}/api/webhooks/1/x` })));
}

(async () => {
  // 1) định dạng tiền / giờ
  const R = RevenueTracker;
  assert.strictEqual(R.formatMoneyDollar(41350), '$41.35K');
  assert.strictEqual(R.formatMoneyDollar(4450000), '$4.45M');
  assert.strictEqual(R.formatMoneyDollar(950), '$950');
  assert.strictEqual(R.formatMoneyDollar(0), '$0');
  assert.strictEqual(R.formatMoneyDollar(2.5e9), '$2.50B');
  assert.strictEqual(R.formatClock(33000), '00:00:33');
  assert.strictEqual(R.formatClock(3725000), '01:02:05');
  assert.strictEqual(R.formatClock(100 * 3600000), '100:00:00');
  assert.strictEqual(R.formatClock(-5), '00:00:00');

  // 2) test webhook: đúng như mẫu
  const hook = await startHook();
  const n = new Notifier({ webhookUrl: hook.url });
  assert.strictEqual(await n.test(), true);
  let e = hook.got.at(-1).embeds[0];
  assert.strictEqual(e.title, 'Kiểm Tra Kết Nối Webhook');
  assert.strictEqual(e.description, 'Antertool đã kết nối thành công tới Discord!');
  assert.strictEqual(F(e, 'Trạng thái'), 'Hoạt động bình thường');
  assert.ok(F(e, 'Nguồn').includes('Antertool'));
  assert.ok(e.fields.every(f => f.inline));
  assert.strictEqual(e.footer.text, 'Antertool');
  assert.strictEqual(e.color, Notifier.COLOR.ok);
  checkLimits(e);

  // embed tự đặt footer/timestamp thì không bị ghi đè; embed trần được bổ sung
  const fin = Notifier.finish({ title: 't', footer: { text: 'X' }, timestamp: '2026-01-01T00:00:00.000Z', color: 1 });
  assert.strictEqual(fin.footer.text, 'X'); assert.strictEqual(fin.timestamp, '2026-01-01T00:00:00.000Z');
  assert.strictEqual(Notifier.finish({ title: 't' }).footer.text, 'Antertool');

  // 3) báo cáo doanh thu của 1 bot
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dce-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ bots: [] }));
  const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
  await mgr.init();
  mgr.notifier.configure(hook.url, ['all']);
  const bot = new BotSession({ id: 'bot-1', host: 'donutsmp.net', port: 25565, username: 'Steve_01', autoSellSpawnRevenue: false }, 'teal', null);
  bot._manager = mgr;
  bot.state.connState = CS.ONLINE;
  mgr.bots.push(bot);
  const t0 = Date.now(), M = 60000;
  mgr.revenue.markOnline('bot-1', t0 - 33000);
  mgr.revenue.record('bot-1', 38e3, { now: t0 - 10 * M, intervalMs: 5 * M, hits: 5 });
  mgr.revenue.record('bot-1', 3350, { now: t0 - 5 * M, intervalMs: 5 * M, hits: 5 });

  e = bot._buildRevenueEmbed({ sum: 3350, done: 4, total: 5, hits: 4 });
  assert.strictEqual(e.title, 'Báo Cáo Tổng Kết Auto-Sell Spawn');
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
  assert.ok(st.includes('+$3.35K') && st.includes('4/5 lồng') && st.includes('1 lồng lỗi'), st);
  assert.strictEqual(e.color, Notifier.COLOR.report);
  assert.strictEqual(e.thumbnail.url, 'https://mc-heads.net/avatar/Steve_01/100');
  assert.strictEqual(e.footer.text, 'Antertool');
  checkLimits(e);

  // chưa có dữ liệu / offline / tên lạ: không vỡ
  const bot2 = new BotSession({ id: 'b2', host: 'h.example', port: 25570, username: 'tên có dấu', autoSellSpawnRevenue: false }, 'teal', null);
  e = bot2._buildRevenueEmbed(null);
  assert.strictEqual(F(e, 'Tổng thu nhập'), '$0'); assert.strictEqual(F(e, 'Tốc độ trung bình'), '—');
  assert.strictEqual(F(e, 'Server'), 'h.example:25570'); assert.ok(F(e, 'Trạng thái').startsWith('Ngoại tuyến'));
  assert.strictEqual(e.thumbnail, undefined, 'tên không hợp lệ thì không gắn ảnh đầu');
  checkLimits(e);

  // gửi thật qua Notifier: payload tới webhook đúng cấu trúc
  hook.got.length = 0;
  assert.strictEqual(bot._sendRevenueReport({ sum: 3350, done: 5, total: 5, hits: 5 }), true);
  await mgr.notifier._queue;
  const sent = hook.got.at(-1).embeds[0];
  assert.strictEqual(sent.title, 'Báo Cáo Tổng Kết Auto-Sell Spawn'); checkLimits(sent);

  // macro
  bot._macroRevPending = { amount: 0, cycles: 0 };
  mgr.revenue.record('bot-1#macro', 1200000, { now: t0, intervalMs: 5 * M, hits: 1 });
  e = bot._buildRevenueEmbed({ sum: 1200000, hits: 1, macro: 'sell', viaBalance: false }, 'macro');
  assert.strictEqual(e.title, 'Báo Cáo Tổng Kết Auto-Sell (Macro)');
  assert.strictEqual(F(e, 'Tổng thu nhập'), '$1.20M'); assert.ok(F(e, 'Trạng thái').includes('macro "sell"'));
  checkLimits(e);

  // 4) cảnh báo (kick, ...): bỏ emoji + id khỏi tiêu đề, có người chơi/server, màu giữ nguyên
  e = bot._alertEmbed('🟠 bot-1: bị kick', 'lý do\n⏰ 10:00:00 PM', 0xf97316);
  assert.strictEqual(e.title, 'Bị kick'); assert.strictEqual(e.color, 0xf97316);
  assert.strictEqual(F(e, 'Người chơi'), 'Steve_01 (bot-1)'); assert.strictEqual(F(e, 'Server'), 'donutsmp.net');
  assert.strictEqual(e.footer.text, 'Antertool'); checkLimits(e);
  assert.strictEqual(bot._alertEmbed('⚠️ bot-1: đã bật spawnerprotect + autosell_spawn', 'x', 1).title, 'Đã bật spawnerprotect + autosell_spawn');
  assert.strictEqual(bot._alertEmbed('Cảnh báo lạ không có id', 'x', 1).title, 'Cảnh báo lạ không có id');
  // _notify đi tới webhook với headline (tag) giữ nguyên
  hook.got.length = 0;
  mgr.notifier.setMention('123456789012345678');
  bot._notify('disconnect', '🟠 bot-1: bị kick', 'x', 0xf97316, '❌ BOT BỊ KICK');
  await mgr.notifier._queue;
  const k = hook.got.at(-1);
  assert.strictEqual(k.content, '❌ BOT BỊ KICK <@123456789012345678>');
  assert.strictEqual(k.embeds[0].title, 'Bị kick');

  // 5) tổng hợp cả dàn
  const bot3 = new BotSession({ id: 'bot-2', host: 'donutsmp.net', port: 25565, username: 'Alex_02', autoSellSpawnRevenue: false }, 'teal', null);
  bot3._manager = mgr; bot3.state.connState = CS.ONLINE; mgr.bots.push(bot3);
  mgr.revenue.markOnline('bot-2', t0 - 3600000);
  mgr.revenue.record('bot-2', 5e6, { now: t0 - 10 * M, intervalMs: 5 * M, hits: 3 });
  mgr.revenue.record('bot-2', 4e6, { now: t0 - 5 * M, intervalMs: 5 * M, hits: 3 });
  e = mgr.buildRevenueSummaryEmbed(t0);
  assert.strictEqual(e.title, 'Báo Cáo Tổng Kết Doanh Thu (2 Bot)');
  assert.deepStrictEqual(e.fields.map(f => f.name), ['Số bot', 'Server', 'Thời gian treo', 'Tổng thu nhập', 'Tốc độ trung bình', 'Số lượt bán', 'Trạng thái']);
  assert.strictEqual(F(e, 'Server'), 'donutsmp.net');
  assert.ok(F(e, 'Tổng thu nhập').startsWith('$') && F(e, 'Tổng thu nhập').endsWith('M'), F(e, 'Tổng thu nhập'));
  assert.strictEqual(F(e, 'Trạng thái').split('\n')[0], '2/2 bot đang hoạt động');
  assert.ok(e.description.startsWith('```'));
  checkLimits(Notifier.finish(e));

  // 6) lịch nghỉ
  hook.got.length = 0;
  mgr._notifyRest({ outTime: '02:00', inTime: '08:00' }, 2);
  mgr._doScheduledIn({ inTime: '08:00' });
  await mgr.notifier._queue;
  const [rest, back] = hook.got.map(x => x.embeds[0]);
  assert.strictEqual(rest.title, 'Bắt Đầu Giờ Nghỉ'); assert.strictEqual(F(rest, 'Số bot'), '2'); checkLimits(rest);
  assert.strictEqual(back.title, 'Hết Giờ Nghỉ'); checkLimits(back);

  // 7) test tag
  hook.got.length = 0;
  mgr.notifier.setMention('123456789012345678');
  assert.strictEqual(await mgr.notifier.testMention(), true);
  checkLimits(hook.got.at(-1).embeds[0]);

  hook.server.close();
  try { mgr.shutdown(); } catch { }
  console.log('discord-embed.test.js: OK');
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
