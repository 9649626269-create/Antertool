'use strict';
// VectorUtil: chỉ khối đặc nguyên khối mới che tia ngắm; block nửa khối (chồi thạch anh tím, nến, thảm, rào...) bỏ qua.
const assert = require('assert');
const { isFullCube, anglesTo, aimCheck, eyeHeightFor } = require('../src/core/VectorUtil');

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

// --- Lỗi thực tế (log Auto-sell Spawn): bot đứng trong khe cao 1 block sát bedrock, mắt 1.62 lọt vào bedrock ngay trên đầu ---
// chân (-6902.51, -63.00, -17574.69), lồng (-6903,-63,-17574), bedrock (-6903,-62,-17575) = ô chứa "mắt đứng" (floor(-63+1.62) = -62)
{
  const w2 = new Map();
  const put2 = (x, y, z, b) => w2.set(`${x},${y},${z}`, b);
  const get2 = q => w2.get(`${q.x},${q.y},${q.z}`) || null;
  const feet = { x: -6902.51, y: -63.0, z: -17574.69 };
  const cage = { x: -6903, y: -63, z: -17574 };
  put2(cage.x, cage.y, cage.z, blk('spawner', FULL));
  put2(-6903, -62, -17575, blk('bedrock', FULL)); // trần khe ngay trên đầu bot
  const center = { x: cage.x + 0.5, y: cage.y + 0.5, z: cage.z + 0.5 };

  // cách cũ (mắt cố định 1.62): tia bị CHÍNH khối bedrock chứa mắt che -> đúng như log "bị bedrock (-6903,-62,-17575) che"
  const eyeOld = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  const aOld = anglesTo(eyeOld, center);
  const rOld = aimCheck({ eye: eyeOld, yaw: aOld.yaw, pitch: aOld.pitch, target: cage, maxDist: 7, getBlock: get2 });
  assert.strictEqual(rOld.hit, false);
  assert.deepStrictEqual(rOld.blocker, { name: 'bedrock', x: -6903, y: -62, z: -17575 });

  // cách mới: nhận ra ô mắt đứng bị đặc -> dùng tư thế thấp hơn (bò 0.4) -> tia tới lồng
  const h = eyeHeightFor({ pos: feet, base: 1.62, getBlock: get2 });
  assert.strictEqual(h, 0.4, 'khe 1 block -> mắt ở tư thế bò');
  const eyeNew = { x: feet.x, y: feet.y + h, z: feet.z };
  const aNew = anglesTo(eyeNew, center);
  const rNew = aimCheck({ eye: eyeNew, yaw: aNew.yaw, pitch: aNew.pitch, target: cage, maxDist: 7, getBlock: get2 });
  assert.strictEqual(rNew.hit, true, 'đúng chiều cao mắt thì tia tới lồng, không còn báo bị bedrock che');

  // đứng thẳng bình thường (trên đầu thoáng) -> giữ nguyên 1.62
  w2.delete('-6903,-62,-17575');
  assert.strictEqual(eyeHeightFor({ pos: feet, base: 1.62, getBlock: get2 }), 1.62);
  // trần cao 2 block: ngồi (1.27) đủ -> không tụt xuống bò
  put2(-6903, -61, -17575, blk('stone', FULL));
  assert.strictEqual(eyeHeightFor({ pos: { x: -6902.5, y: -63, z: -17574.5 }, base: 1.62, getBlock: get2 }), 1.62, 'ô mắt 1.62 là y=-62 (thoáng) nên vẫn đứng thẳng');
  put2(-6903, -62, -17575, blk('stone', FULL));
  assert.strictEqual(eyeHeightFor({ pos: feet, base: 1.62, getBlock: get2 }), 0.4);
  // dữ liệu bất thường: ô chân cũng đặc -> không có mức nào thoáng -> giữ base như cũ (không đoán bừa)
  put2(-6903, -63, -17575, blk('stone', FULL));
  assert.strictEqual(eyeHeightFor({ pos: feet, base: 1.62, getBlock: get2 }), 1.62);
  // chunk chưa tải (getBlock null) -> coi là thoáng
  assert.strictEqual(eyeHeightFor({ pos: feet, base: 1.62, getBlock: () => null }), 1.62);
  // getBlock ném lỗi -> không văng
  assert.strictEqual(eyeHeightFor({ pos: feet, base: 1.62, getBlock: () => { throw new Error('x'); } }), 1.62);
}

console.log('aim-util.test OK');
