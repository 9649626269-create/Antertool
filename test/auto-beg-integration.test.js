'use strict';
// Tích hợp AutoBeg với BotSession THẬT (lệnh `cmd <id> msg|autobeg`, hook tin nhắn, config, shutdown) — mineflayer/vec3/express giả.
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');

class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } offset(a, b, c) { return new Vec3(this.x + a, this.y + b, this.z + c); } clone() { return new Vec3(this.x, this.y, this.z); } distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); } }
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return {};
  if (request === 'vec3') return V;
  if (request === 'express') { const f = () => ({}); f.static = () => (() => { }); f.json = () => (() => { }); return f; }
  return origLoad.call(this, request, ...rest);
};
const BotSession = require('../src/core/BotSession');
const { CS } = require('../src/core/constants');
const { validateConfig } = require('../src/core/ConfigValidator');
const HelpCatalog = require('../src/core/HelpCatalog');
const { BegLedger } = require('../src/core/AutoBeg');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FAST = { messageDelayMs: 0, responseTimeoutMs: 0, roundCooldownMs: 0, maxMessagesPerMinute: 1, dedupWindowMs: 0 };

function mkBot(autoBeg = {}) {
  const bot = new BotSession({ id: 'b1', host: 'h', port: 25565, username: 'Noanno', botPassword: '',
    autoBeg: { owner: 'dahas', allowedRecipients: ['Steve'], messageDelayMs: 0, responseTimeoutMs: 100, maxMessagesPerMinute: 30, maxRounds: 1, roundCooldownMs: 0, ...autoBeg } }, 'teal', null);
  const logs = []; bot.on('log', e => logs.push([e.level, e.msg]));
  const chats = [];
  const mc = new EventEmitter();
  mc.username = 'Noanno'; mc.players = { Steve: {}, Noanno: {}, dahas: {} }; mc.chat = m => chats.push(m); mc.setMaxListeners(50);
  bot.mc = mc; bot.state.connState = CS.ONLINE; bot._menuDoneAt = 1; bot._loginConfirmed = true;
  bot._bindEvents(mc, null);                         // gắn listener 'message' thật của BotSession
  bot.autoBeg.ledger = new BegLedger(null);
  bot.autoBeg._floors = FAST;
  const dirty = []; bot._manager = { bots: [bot], _config: { bots: [{ id: 'b1' }] }, persistence: { markDirty: () => dirty.push(1) } };
  const say = (text, pos = 'system') => mc.emit('message', { text }, pos);
  return { bot, logs, chats, mc, say, dirty };
}

(async () => {
  // lệnh đã đăng ký + có trong help
  {
    const { bot } = mkBot();
    const names = bot.cmdRegistry.list().map(c => c.name);
    assert.ok(names.includes('msg') && names.includes('autobeg'));
    const help = HelpCatalog.buildHelp({ scope: 'bot', query: 'all', registry: bot.cmdRegistry.list(), customs: [] });
    const text = JSON.stringify(help);
    assert.ok(text.includes('autobeg') && text.includes('msg <người chơi>'));
    assert.strictEqual(bot.autoBeg.state, 'OFF');            // mặc định TẮT
    bot.autoBeg.estop();
  }

  // msg: phân tích đúng tên + nội dung nhiều dấu cách; dùng cơ chế chat hiện có
  {
    const { bot, chats, logs, say } = mkBot();
    bot.cmd('msg Steve Em là newbie ạ, anh/chị cho em xin 100k mua giáp khởi nghiệp với huhu');
    await sleep(60);
    assert.deepStrictEqual(chats, ['/msg Steve Em là newbie ạ, anh/chị cho em xin 100k mua giáp khởi nghiệp với huhu']);
    bot.cmd('msg');  bot.cmd('msg Steve'); bot.cmd('msg ab hi'); bot.cmd('msg Steve ' + 'a'.repeat(300));
    await sleep(60);
    assert.strictEqual(chats.length, 1, 'cú pháp sai không được gửi gì');
    assert.ok(logs.filter(([l]) => l === 'warn').length >= 4);
    // lỗi offline do server báo được bắt qua listener của chính bot này
    bot.cmd('msg Alexx hello'); await sleep(40);
    say('» Người chơi Alexx không online'); await sleep(20);
    assert.ok(logs.some(([, m]) => /Alexx không online/.test(m)));
    // cmd /msg thô vẫn đi đường cũ
    bot.cmd('/msg Steve raw'); assert.strictEqual(chats[chats.length - 1], '/msg Steve raw');
    // bot offline
    bot.state.connState = CS.DISCONNECTED; const n = chats.length; bot.cmd('msg Steve hi'); await sleep(40); assert.strictEqual(chats.length, n);
  }

  // autobeg: bật không có owner -> báo lỗi rõ, không bật, không đoán
  {
    const { bot, logs } = mkBot({ owner: '' });
    bot.cmd('autobeg on');
    assert.strictEqual(bot.autoBeg.state, 'OFF');
    assert.ok(logs.some(([l, m]) => l === 'warn' && /owner/.test(m)));
    assert.ok(!bot.cfg.autoBeg.enabled, 'bật thất bại thì không được ghi enabled:true vào config');
  }

  // autobeg dry: chạy qua listener thật, parser /bal, ghi ý định, KHÔNG gửi /pay; lưu enabled không đụng cấu hình khác
  {
    const { bot, chats, say, dirty } = mkBot({ responseTimeoutMs: 100 });
    const before = JSON.stringify(bot.cfg.autoBeg);
    bot.mc.chat = m => { chats.push(m); if (m === '/bal') setImmediate(() => say('» Bạn có $13.87M')); };
    bot.cmd('autobeg on dry');
    assert.strictEqual(bot.cfg.autoBeg.enabled, true);
    assert.ok(dirty.length >= 1);
    assert.strictEqual(bot._manager._config.bots[0].autoBeg.owner, 'dahas');
    for (let i = 0; i < 400 && bot.autoBeg.state !== 'OFF'; i++) await sleep(10);
    assert.strictEqual(bot.autoBeg.state, 'OFF');
    assert.ok(chats.some(c => /^\/msg Steve Em là newbie/.test(c)));
    assert.ok(!chats.some(c => /^\/pay/.test(c)), 'dry-run không được /pay');
    assert.strictEqual(bot.autoBeg.ledger.data.tx[0].status, 'DRYRUN');
    assert.strictEqual(bot.autoBeg.ledger.data.tx[0].amount, '13860000');
    const after = JSON.parse(JSON.stringify(bot.cfg.autoBeg)); const b = JSON.parse(before);
    for (const k of Object.keys(b)) if (k !== 'enabled') assert.deepStrictEqual(after[k], b[k], `config ${k} bị đổi`);
  }

  // live qua listener thật + nhận diện chống giả mạo ở tầng BotSession
  {
    const { bot, chats, say } = mkBot();
    let balance = '$2.50M';
    bot.mc.chat = m => {
      chats.push(m);
      if (m === '/bal') setImmediate(() => say(`» Bạn có ${balance}`));
      const x = /^\/pay (\S+) (\d+)$/.exec(m);
      if (x) setImmediate(() => { balance = '$10'; say(`» Bạn đã chuyển cho ${x[1]} $2.49M`); });
    };
    // giả mạo trước khi chạy: không có tác dụng
    bot.cmd('autobeg on live');
    say('<Steve> » Bạn có $999B', 'chat'); say('<Steve> Noanno: » Bạn nhận được $1.00M từ Steve');
    for (let i = 0; i < 600 && bot.autoBeg.state !== 'OFF'; i++) await sleep(10);
    assert.strictEqual(bot.autoBeg.state, 'OFF');
    assert.ok(chats.includes('/pay dahas 2490000'), chats.join('|'));
    assert.strictEqual(chats.filter(c => /^\/pay/.test(c)).length, 1);
    assert.strictEqual(bot.autoBeg.stats.receivedCount, 0);
  }

  // estop qua cmd: dừng ngay, lưu enabled:false; hết gửi
  {
    const { bot, chats, dirty } = mkBot({ allowedRecipients: ['Steve'], messageDelayMs: 0 });
    bot.mc.players = { Steve: {}, Noanno: {}, dahas: {}, A_1x: {}, B_2x: {}, C_3x: {} };
    bot.cfg.autoBeg.allowedRecipients = ['Steve', 'A_1x', 'B_2x', 'C_3x'];
    bot.cmd('autobeg on'); await sleep(40);
    bot.cmd('autobeg estop');
    const n = chats.length; await sleep(250);
    assert.strictEqual(chats.length, n); assert.strictEqual(bot.autoBeg.state, 'OFF');
    assert.strictEqual(bot.cfg.autoBeg.enabled, false);
  }

  // test lệnh: autobeg test <dòng>  (không tác dụng phụ)
  {
    const { bot, logs, chats } = mkBot();
    bot.cmd('autobeg test » Bạn nhận được $1.00K từ Steve');
    bot.cmd('autobeg test <Steve> » Bạn nhận được $1.00K từ Steve');
    assert.ok(logs.some(([, m]) => /loại received.*Steve.*1,000/.test(m)), JSON.stringify(logs.slice(-3)));
    assert.ok(logs.some(([, m]) => /KHÔNG phải dòng hệ thống/.test(m)));
    assert.strictEqual(chats.length, 0);
    bot.cmd('autobeg status'); assert.ok(logs.some(([, m]) => /AutoBeg: OFF/.test(m)));
  }

  // shutdown(): dừng ngay, không gửi thêm; không lưu enabled:false (đây không phải lệnh tắt của người dùng)
  {
    const { bot, chats } = mkBot({ allowedRecipients: ['Steve', 'A_1x', 'B_2x'] });
    bot.mc.players = { Steve: {}, Noanno: {}, A_1x: {}, B_2x: {} };
    bot.cmd('autobeg on'); await sleep(40);
    try { bot.shutdown(); } catch (e) { /* các phần không liên quan của shutdown dùng mc giả */ }
    assert.strictEqual(bot.autoBeg.state, 'OFF');
    const n = chats.length; await sleep(200); assert.strictEqual(chats.length, n);
    assert.strictEqual(bot.cfg.autoBeg.enabled, true, 'shutdown không được ghi đè cấu hình enabled');
  }

  // cấu hình: validator + BotManager chuyển autoBeg xuống bot
  {
    assert.deepStrictEqual(validateConfig({ bots: [{ id: 'a', autoBeg: { enabled: false } }] }).errors, []);
    let v = validateConfig({ bots: [{ id: 'a', autoBeg: { enabled: true } }] });
    assert.ok(v.errors.some(e => /owner/.test(e)), v.errors.join('|'));
    v = validateConfig({ autoBeg: { messageDelayMs: 'x', minBalanceThreshold: '12abc' } });
    assert.ok(v.errors.length >= 2);
    v = validateConfig({ autoBeg: { enabled: true, owner: 'dahas', minBalanceThreshold: '100K' } });
    assert.deepStrictEqual(v.errors, []);
    v = validateConfig({ bots: [{ id: 'a', autoBeg: 5 }] }); assert.ok(v.errors.some(e => /object/.test(e)));
    const ex = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'config.example.json'), 'utf8'));
    assert.deepStrictEqual(validateConfig(ex).errors, [], 'config.example.json phải hợp lệ');
    assert.strictEqual(ex.autoBeg.enabled, false);
    const BotManager = require('../src/services/BotManager');
    const cfg = BotManager.prototype._buildBotConfig.call(Object.assign(Object.create(BotManager.prototype), { _config: { autoBeg: { owner: 'root' } } }), { id: 'x', username: 'u' });
    assert.deepStrictEqual(cfg.autoBeg, { owner: 'root' });
    const cfg2 = BotManager.prototype._buildBotConfig.call(Object.assign(Object.create(BotManager.prototype), { _config: {} }), { id: 'x', username: 'u', autoBeg: { owner: 'o2' } });
    assert.deepStrictEqual(cfg2.autoBeg, { owner: 'o2' });
  }

  console.log('auto-beg-integration: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
