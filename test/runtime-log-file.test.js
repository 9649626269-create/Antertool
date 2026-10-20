'use strict';
// Log runtime ra file: BotManager thật (mineflayer/vec3 giả) -> log hệ thống + log từng bot đều xuống logs/runtime-*.log, đã che mật khẩu.
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return { createBot() { const mc = new EventEmitter(); mc._client = new EventEmitter(); mc._client.socket = { destroy() { } }; mc._client.write = () => { }; mc._client.end = () => { }; return mc; } };
  if (request === 'vec3') return V;
  return origLoad.call(this, request, ...rest);
};
const BotManager = require('../src/services/BotManager');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtlog-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 25565, version: '1.20.4', bots: [], botPassword: 'matkhau-bi-mat' }));
  const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
  await mgr.init();
  const bot = mgr.createBot({ id: 'bot-1', username: 'u1', host: '127.0.0.1', port: 25565, botPassword: 'matkhau-bi-mat' });

  mgr.runtimeLog('ok', 'Antertool khởi động');
  bot.log('warn', 'Bị kick, thử đăng nhập lại bằng matkhau-bi-mat');
  bot.log('chat', 'Người chơi X: chào');
  mgr.runtimeLog('err', '[UNCAUGHT] Error: sập'); // mức err -> ghi ngay, kể cả khi tiến trình chết liền sau đó

  const logs = path.join(dir, 'logs');
  const file = () => fs.readdirSync(logs).filter(f => /^runtime-\d{4}-\d{2}-\d{2}\.log$/.test(f)).map(f => fs.readFileSync(path.join(logs, f), 'utf8')).join('');
  assert.ok(/\[ERR   \] \[system\] \[UNCAUGHT\] Error: sập/.test(file()), 'lỗi nặng phải xuống file ngay: ' + file());
  mgr.shutdown(); // shutdown ghi nốt phần còn lại
  const txt = file();
  assert.ok(/\[OK    \] \[system\] Antertool khởi động/.test(txt), txt);
  assert.ok(/\[WARN  \] \[bot-1\] Bị kick, thử đăng nhập lại bằng \*\*\*/.test(txt), txt);
  assert.ok(!txt.includes('matkhau-bi-mat') && !txt.includes('Người chơi X'), 'không lộ mật khẩu / không ghi chat mặc định');

  // ANTER_LOG_DIR đặt trong .env cạnh config.json phải được dùng (trước đây bị bỏ qua)
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rtlog-env-'));
  fs.writeFileSync(path.join(dir2, 'config.json'), JSON.stringify({ bots: [] }));
  fs.writeFileSync(path.join(dir2, '.env'), 'ANTER_LOG_DIR=outlogs\n');
  const mgr2 = new BotManager({ configPath: path.join(dir2, 'config.json') });
  await mgr2.init();
  assert.strictEqual(mgr2.fileLogs.dir, path.join(dir2, 'outlogs'), 'ANTER_LOG_DIR trong .env');
  mgr2.runtimeLog('err', 'tu .env');
  assert.ok(fs.readdirSync(path.join(dir2, 'outlogs')).length === 1, 'file log nằm ở thư mục từ .env');
  assert.strictEqual(mgr2.fileLogs.probe(), null, 'probe ổn khi ghi được');
  // thư mục không ghi được -> probe trả lỗi + ghi file báo lỗi đúng 1 lần
  const blocker = path.join(dir2, 'la-file'); fs.writeFileSync(blocker, 'x');
  const errs = [];
  mgr2.fileLogs.onError = m => errs.push(m);
  mgr2.fileLogs.configure({ dir: path.join(blocker, 'sub') });
  assert.ok(mgr2.fileLogs.probe(), 'probe báo lỗi khi không tạo được thư mục');
  mgr2.runtimeLog('err', 'a'); mgr2.runtimeLog('err', 'b');
  assert.strictEqual(errs.length, 1, 'báo lỗi ghi file 1 lần: ' + errs.join('|'));
  assert.ok(errs[0].includes(blocker), errs[0]);
  mgr2.fileLogs.close();
  fs.rmSync(dir2, { recursive: true, force: true });

  fs.rmSync(dir, { recursive: true, force: true });
  mgr.fileLogs.close();
  console.log('runtime-log-file.test OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
