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

  fs.rmSync(dir, { recursive: true, force: true });
  mgr.fileLogs.close();
  console.log('runtime-log-file.test OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
