'use strict';
const assert = require('assert');
const { validateConfig } = require('../src/core/ConfigValidator');
const errs = macros => validateConfig({ macros }).errors;

assert.deepStrictEqual(errs({ a: { steps: 'chat /shop\ndelay 1000\nwinclick $answer 1\nloop 5\nchat /buy\nuntil Bạn cần có', next: 'B' }, b: { steps: 'closewin' } }), []);
const bad = errs({ a: { steps: 'foo\ndelay x\nwinclick -1\nuntil hi\naskmap q', next: 'zz' }, b: { steps: 5 }, c: 3 });
for (const re of [/lệnh "foo"/, /delay cần số/, /winclick cần slot/, /until cần có "loop"/, /askmap thiếu/, /"zz" không tồn tại/, /b\.steps phải là string/, /macros\.c phải là object/]) {
  assert.ok(bad.some(e => re.test(e)), String(re));
}
// Phân loại lỗi nghiêm trọng / cảnh báo + Persistence dừng khởi động khi lỗi nghiêm trọng
{
  const v = c => validateConfig(c);
  assert.strictEqual(v({ bots: [{ id: 'a' }], proxies: [{ host: '1.2.3.4', port: 8080 }] }).ok, true);
  assert.ok(v({ bots: [{ username: 'x' }] }).fatal.some(e => /\.id bắt buộc/.test(e)), 'thiếu id bot');
  assert.ok(v({ bots: [{ id: 'a' }, { id: 'a' }] }).fatal.some(e => /duy nhất/.test(e)), 'id trùng');
  assert.ok(v({ port: '25565' }).fatal.some(e => /^port/.test(e)), 'sai kiểu port');
  assert.ok(v({ proxies: [{ host: '', port: 1 }, 'x', { host: 'h', port: 99999 }] }).fatal.length === 3, 'proxy sai định dạng');
  const w = v({ bots: [{ id: 'a', theme: 5 }] });
  assert.strictEqual(w.fatal.length, 0); assert.strictEqual(w.warnings.length, 1); // chỉ cảnh báo
  const fs = require('fs'), os = require('os'), path = require('path');
  const Persistence = require('../src/core/Persistence');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-')), 'config.json');
  process.env.SILENT_CONFIG = '1';
  fs.writeFileSync(f, JSON.stringify({ bots: [{ username: 'x' }] }));
  assert.throws(() => new Persistence(f).load(), /Config không hợp lệ/);
  process.env.ALLOW_INVALID_CONFIG = '1';
  assert.doesNotThrow(() => new Persistence(f).load());
  delete process.env.ALLOW_INVALID_CONFIG;
  fs.writeFileSync(f, JSON.stringify({ bots: [{ id: 'a', theme: 5 }] }));
  assert.doesNotThrow(() => new Persistence(f).load(), 'chỉ cảnh báo thì vẫn chạy');
}
console.log('config-validator OK');
