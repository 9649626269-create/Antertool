'use strict';
// AimUtil: chỉ khối đặc nguyên khối mới che tia ngắm; block nửa khối (chồi thạch anh tím, nến, thảm, rào...) bỏ qua.
const assert = require('assert');
const { isFullCube, anglesTo, aimCheck } = require('../src/core/AimUtil');

const FULL = [[0, 0, 0, 1, 1, 1]];
const blk = (name, shapes) => ({ name, shapes });

// --- isFullCube theo hình dạng thật (shapes) ---
assert.strictEqual(isFullCube(blk('stone', FULL)), true);
assert.strictEqual(isFullCube(blk('spawner', FULL)), true);
assert.strictEqual(isFullCube(blk('small_amethyst_bud', [[0.25, 0, 0.25, 0.75, 0.25, 0.75]])), false);
assert.strictEqual(isFullCube(blk('medium_amethyst_bud', [[0.25, 0, 0.25, 0.75, 0.5, 0.75]])), false);
assert.strictEqual(isFullCube(blk('large_amethyst_bud', [[0.1875, 0, 0.1875, 0.8125, 0.75, 0.8125]])), false);
assert.strictEqual(isFullCube(blk('amethyst_cluster', [[0.1875, 0, 0.1875, 0.8125, 0.875, 0.8125]])), false);
assert.strictEqual(isFullCube(blk('oak_slab', [[0, 0, 0, 1, 0.5, 1]])), false);
assert.strictEqual(isFullCube(blk('short_grass', [])), false);
assert.strictEqual(isFullCube(blk('air', [])), false);
assert.strictEqual(isFullCube(null), false);
// không có shapes -> dựa tên / boundingBox
assert.strictEqual(isFullCube({ name: 'small_amethyst_bud' }), false);
assert.strictEqual(isFullCube({ name: 'candle' }), false);
assert.strictEqual(isFullCube({ name: 'stone', boundingBox: 'block' }), true);
assert.strictEqual(isFullCube({ name: 'poppy', boundingBox: 'empty' }), false);

// --- aimCheck ---
const world = new Map();
const put = (x, y, z, b) => world.set(`${x},${y},${z}`, b);
const getBlock = q => world.get(`${q.x},${q.y},${q.z}`) || null;
const eye = { x: 0.5, y: 64.62, z: 0.5 };
const target = { x: 4, y: 64, z: 0 };
put(4, 64, 0, blk('spawner', FULL));
const a = anglesTo(eye, { x: 4.5, y: 64.5, z: 0.5 });
const run = () => aimCheck({ eye, yaw: a.yaw, pitch: a.pitch, target, maxDist: 7, getBlock });

assert.strictEqual(run().hit, true, 'không có gì chắn -> trúng');
put(2, 64, 0, blk('small_amethyst_bud', [[0.25, 0, 0.25, 0.75, 0.25, 0.75]]));
put(3, 64, 0, blk('amethyst_cluster', [[0.1875, 0, 0.1875, 0.8125, 0.875, 0.8125]]));
assert.strictEqual(run().hit, true, 'chồi/cụm thạch anh tím không được che tia');
put(1, 64, 0, blk('oak_slab', [[0, 0, 0, 1, 0.5, 1]]));
assert.strictEqual(run().hit, true, 'phiến nửa khối không che tia');
put(3, 64, 0, blk('stone', FULL));
const r = run();
assert.strictEqual(r.hit, false, 'khối đặc nguyên khối phải che tia');
assert.deepStrictEqual(r.blocker, { name: 'stone', x: 3, y: 64, z: 0 });
// ngoài tầm
assert.strictEqual(aimCheck({ eye, yaw: a.yaw, pitch: a.pitch, target, maxDist: 2, getBlock: () => null }).hit, false);
// chunk chưa tải (getBlock null) -> coi là thoáng
world.delete('3,64,0');
assert.strictEqual(run().hit, true);

console.log('aim-util.test OK');
