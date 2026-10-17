'use strict';
const assert = require('assert');
const { resolveBotPassword, envKey } = require('../src/core/secrets');
assert.strictEqual(envKey('bot-1'), 'BOT_PASSWORD_BOT_1');
const g = { botPassword: 'global-cfg' };
assert.strictEqual(resolveBotPassword({ id: 'bot-1', botPassword: 'cfg' }, g, {}), 'cfg');
assert.strictEqual(resolveBotPassword({ id: 'bot-1', botPassword: 'cfg' }, g, { BOT_PASSWORD_BOT_1: 'envbot' }), 'envbot');
assert.strictEqual(resolveBotPassword({ id: 'bot-1', botPassword: 'cfg' }, g, { BOT_PASSWORD: 'envall' }), 'cfg');
assert.strictEqual(resolveBotPassword({ id: 'x' }, g, { BOT_PASSWORD: 'envall' }), 'envall');
assert.strictEqual(resolveBotPassword({ id: 'x' }, g, {}), 'global-cfg');
assert.strictEqual(resolveBotPassword({ id: 'x' }, {}, {}), undefined);
// dbg: im lặng mặc định, in khi ANTER_DEBUG=1
const { dbg } = require('../src/core/debug');
const logs = []; const orig = console.log; console.log = m => logs.push(m);
delete process.env.ANTER_DEBUG; dbg('t', new Error('a'));
process.env.ANTER_DEBUG = '1'; dbg('t', new Error('b'));
console.log = orig;
assert.strictEqual(logs.length, 1); assert.ok(logs[0].includes('debug:t') && logs[0].includes('b'));
console.log('secrets.test OK');
