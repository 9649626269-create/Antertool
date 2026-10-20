'use strict';
const assert = require('assert');
const { validateConfig } = require('../src/core/ConfigValidator');
const errs = macros => validateConfig({ macros }).errors;

assert.deepStrictEqual(errs({ a: { steps: 'chat /shop\ndelay 1000\nwinclick $answer 1\nloop 5\nchat /buy\nuntil Bạn cần có', next: 'B' }, b: { steps: 'closewin' } }), []);
const bad = errs({ a: { steps: 'foo\ndelay x\nwinclick -1\nuntil hi\naskmap q', next: 'zz' }, b: { steps: 5 }, c: 3 });
for (const re of [/lệnh "foo"/, /delay cần số/, /winclick cần slot/, /until cần có "loop"/, /askmap thiếu/, /"zz" không tồn tại/, /b\.steps phải là string/, /macros\.c phải là object/]) {
  assert.ok(bad.some(e => re.test(e)), String(re));
}
console.log('config-validator OK');
