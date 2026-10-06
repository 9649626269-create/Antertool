const assert = require('assert');
const { resolveText, parseReasonText, nbtSimplify } = require('../src/core/utils');
// kick dạng NBT thật từ log (1.20.3+)
const kick = JSON.stringify({ type: 'compound', value: { color: { type: 'string', value: 'red' }, text: { type: 'string', value: 'Đã xảy ra lỗi nội bộ, vui lòng thử lại' } } });
assert.strictEqual(parseReasonText(kick), 'Đã xảy ra lỗi nội bộ, vui lòng thử lại');
// có extra là list compound
const withExtra = { type: 'compound', value: { text: { type: 'string', value: 'A ' }, extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'B' } }, { text: { type: 'string', value: 'C' } }] } } } };
assert.strictEqual(resolveText(withExtra), 'A BC');
// JSON thường & chuỗi vẫn như cũ
assert.strictEqual(resolveText({ text: 'x', extra: [{ text: 'y' }] }), 'xy');
assert.strictEqual(resolveText('plain'), 'plain');
assert.deepStrictEqual(nbtSimplify({ type: 'int', value: 5 }), 5);
console.log('utils OK');
