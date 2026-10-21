'use strict';
// Test hồi quy cho các lỗi trong báo cáo kiểm toán (BUG-03/04/07/14).
const assert = require('assert');
const os = require('os');
const path = require('path');
const { parseShardNum } = require('../src/core/utils');

// BUG-07: số thập phân đi cùng hậu tố k/M không bị nhân 10 lần
assert.strictEqual(parseShardNum('Shard: 1.5k'), 1500);
assert.strictEqual(parseShardNum('Shard: 3.25M'), 3250000);
assert.strictEqual(parseShardNum('Shard: 1,234'), 1234);
assert.strictEqual(parseShardNum('Shard: 12.250.000'), 12250000);
assert.strictEqual(parseShardNum('Shard: 500'), 500);

// BUG-03: StatsParser không được ném lỗi khi slot.type là số
const { StatsParser } = require('../src/core/WindowRouter');
const logs = [];
let stats = null, shardSeen = 0;
const bot = { mc: { entity: null }, state: {}, emit: (ev, d) => { if (ev === 'stats') stats = d; }, _updateShard: n => { shardSeen = n; }, log: (...a) => logs.push(a.join(' ')) };
StatsParser.parse(bot, { slots: [{ type: 388, name: 'emerald', count: 10 }, { type: 999, name: 'amethyst_shard', count: 7 }] });
assert.ok(!logs.some(l => /Lỗi StatsParser/.test(l)), 'StatsParser bị lỗi: ' + logs.join('|'));
assert.ok(stats && stats.money === 10 && stats.shard === 7 && shardSeen === 7, 'StatsParser đọc sai: ' + JSON.stringify(stats));

// BUG-04: proxy dạng user:pass@host:port parse được (autoAdd đổi ip:port:user:pass sang dạng này)
const PM = require('../src/core/ProxyManager');
const pm = new (PM.ProxyManager || PM)();
const p = pm.parse('http://alice:s%40cret@1.2.3.4:8080');
assert.ok(p && p.host === '1.2.3.4' && p.port === 8080 && p.user === 'alice' && p.pass === 's@cret');

// BUG-14: thiếu config.json không làm sập
const Persistence = require('../src/core/Persistence');
const P = Persistence.Persistence || Persistence;
assert.deepStrictEqual(new P(path.join(os.tmpdir(), 'no-such-dir-' + process.pid, 'config.json')).load(), { bots: [] });
console.log('audit-fixes OK');
