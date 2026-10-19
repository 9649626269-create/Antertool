'use strict';
// MotionUtil: nhận diện tư thế (đứng/ngồi/bò...) + trạng thái cơ thể (đang nhảy/trượt/server chưa cập nhật tư thế) để tính đúng độ cao mắt.
const assert = require('assert');
const { normalizePose, supportsPoseMeta, readReportedPose, headroomAbove, maxPoseForHeadroom, poseFromEyeHeight, resolvePlayerPose, describePose } = require('../src/core/MotionUtil');
const { anglesTo, aimCheck } = require('../src/core/VectorUtil');

const FULL = [[0, 0, 0, 1, 1, 1]];
const blk = (name, shapes = FULL) => ({ name, shapes });
const mkWorld = () => {
  const w = new Map();
  return { put: (x, y, z, b) => w.set(`${x},${y},${z}`, b), get: q => w.get(`${q.x},${q.y},${q.z}`) || null };
};

// --- normalizePose / version ---
assert.strictEqual(normalizePose(0), 'standing');
assert.strictEqual(normalizePose(5), 'crouching');
assert.strictEqual(normalizePose(3), 'swimming');
assert.strictEqual(normalizePose(2), 'sleeping');
assert.strictEqual(normalizePose(99), null);
assert.strictEqual(normalizePose(2.5), null);
assert.strictEqual(normalizePose('Sneaking'), 'crouching');
assert.strictEqual(normalizePose('crawling'), 'swimming');
assert.strictEqual(normalizePose('fall_flying'), 'fall_flying');
assert.strictEqual(normalizePose('???'), null);
assert.strictEqual(normalizePose(undefined), null);
assert.strictEqual(supportsPoseMeta('1.21.1'), true);
assert.strictEqual(supportsPoseMeta('1.14'), true);
assert.strictEqual(supportsPoseMeta('1.13.2'), false);
assert.strictEqual(supportsPoseMeta('1.8.9'), false);
assert.strictEqual(supportsPoseMeta(undefined), true);

// --- readReportedPose ---
assert.deepStrictEqual(readReportedPose({ metadata: { 6: 5 } }), { key: 'crouching', source: 'server' });
assert.deepStrictEqual(readReportedPose({ metadata: [0, 300, null, false, false, false, 3] }), { key: 'swimming', source: 'server' });
assert.strictEqual(readReportedPose({ metadata: { 6: 20 } }), null, 'bản cũ: metadata[6] là máu, không phải tư thế');
assert.deepStrictEqual(readReportedPose({ metadata: { 6: 5 } }, { hasPoseMeta: false }), null, 'MC < 1.14 không đọc metadata[6]');
assert.deepStrictEqual(readReportedPose({ metadata: { 0: 0x02 } }, { hasPoseMeta: false }), { key: 'crouching', source: 'flags' });
assert.deepStrictEqual(readReportedPose({ metadata: { 0: 0x10 } }, { hasPoseMeta: false }), { key: 'swimming', source: 'flags' });
assert.deepStrictEqual(readReportedPose({ metadata: { 0: 0x80 } }, { hasPoseMeta: false }), { key: 'fall_flying', source: 'flags' });
assert.deepStrictEqual(readReportedPose({ metadata: { 0: 0 } }, { hasPoseMeta: false }), { key: 'standing', source: 'flags' });
assert.strictEqual(readReportedPose({}), null);
assert.strictEqual(readReportedPose(null), null);
assert.strictEqual(poseFromEyeHeight(1.62), null);
assert.strictEqual(poseFromEyeHeight(1.27), 'crouching');
assert.strictEqual(poseFromEyeHeight(0.4), 'swimming');
assert.strictEqual(poseFromEyeHeight(1.0), null);

// --- headroomAbove: khoảng trống phía trên chân ---
{
  const f = { x: 10.5, y: 64, z: 10.5 };
  let w = mkWorld();
  assert.strictEqual(headroomAbove({ pos: f, getBlock: w.get }), 1.8, 'không có gì -> 1.8');
  w.put(10, 63, 10, blk('stone'));        // sàn dưới chân: không tính
  assert.strictEqual(headroomAbove({ pos: f, getBlock: w.get }), 1.8, 'sàn dưới chân không phải trần');
  w.put(10, 65, 10, blk('bedrock'));      // trần ngay sau 1 block
  assert.ok(Math.abs(headroomAbove({ pos: f, getBlock: w.get }) - 1.0) < 1e-9);
  w = mkWorld();
  w.put(10, 65, 10, blk('oak_slab', [[0, 0.5, 0, 1, 1, 1]])); // phiến trên: đáy ở +1.5
  assert.ok(Math.abs(headroomAbove({ pos: f, getBlock: w.get }) - 1.5) < 1e-9);
  w = mkWorld();
  w.put(10, 65, 10, blk('oak_slab', [[0, 0, 0, 1, 0.5, 1]])); // phiến dưới: đáy ở +1.0
  assert.ok(Math.abs(headroomAbove({ pos: f, getBlock: w.get }) - 1.0) < 1e-9);
  w = mkWorld();
  w.put(10, 65, 10, blk('small_amethyst_bud', [[0.25, 0, 0.25, 0.75, 0.25, 0.75]])); // chồi nhỏ ở giữa ô
  assert.ok(Math.abs(headroomAbove({ pos: f, getBlock: w.get }) - 1.0) < 1e-9, 'khối nhỏ nằm trên cột giữa của hitbox vẫn chắn');
  w = mkWorld();
  w.put(11, 65, 10, blk('stone'));        // ô kế bên, ngoài hitbox 0.6 (x 10.2..10.8) -> không chắn
  assert.strictEqual(headroomAbove({ pos: f, getBlock: w.get }), 1.8);
  w = mkWorld();
  w.put(10, 65, 10, null);
  assert.strictEqual(headroomAbove({ pos: f, getBlock: () => null }), 1.8, 'chunk chưa tải -> coi là thoáng');
  assert.strictEqual(headroomAbove({ pos: f, getBlock: () => { throw new Error('x'); } }), 1.8);
  // đứng sát mép: góc hitbox lọt vào ô kế bên có trần thấp
  w = mkWorld();
  w.put(11, 65, 10, blk('stone'));
  assert.ok(Math.abs(headroomAbove({ pos: { x: 10.9, y: 64, z: 10.5 }, getBlock: w.get }) - 1.0) < 1e-9, 'mép hitbox (x 10.6..11.2) chạm ô x=11');
  // đứng trên phiến: phiến dưới chân không tính
  w = mkWorld();
  w.put(10, 64, 10, blk('oak_slab', [[0, 0, 0, 1, 0.5, 1]]));
  assert.strictEqual(headroomAbove({ pos: { x: 10.5, y: 64.5, z: 10.5 }, getBlock: w.get }), 1.8);
}
assert.strictEqual(maxPoseForHeadroom(1.8), 'standing');
assert.strictEqual(maxPoseForHeadroom(1.7), 'crouching');
assert.strictEqual(maxPoseForHeadroom(1.5), 'crouching');
assert.strictEqual(maxPoseForHeadroom(1.49), 'crouching', 'dung sai 0.01 cho sai số số học');
assert.strictEqual(maxPoseForHeadroom(1.45), 'swimming');
assert.strictEqual(maxPoseForHeadroom(1.0), 'swimming');

// --- resolvePlayerPose: nguồn tư thế ---
const feet = { x: 10.5, y: 64, z: 10.5 };
const open = () => null;
{
  let st = resolvePlayerPose({ entity: { position: feet }, getBlock: open });
  assert.strictEqual(st.key, 'standing'); assert.strictEqual(st.eye, 1.62); assert.strictEqual(st.source, 'assumed'); assert.strictEqual(st.settled, true);
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 5 }, onGround: true }, getBlock: open, sneak: true });
  assert.strictEqual(st.key, 'crouching'); assert.strictEqual(st.eye, 1.27); assert.strictEqual(st.source, 'server'); assert.strictEqual(st.settled, true);
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 3 } }, getBlock: open });
  assert.strictEqual(st.key, 'swimming'); assert.strictEqual(st.eye, 0.4);
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 2 } }, getBlock: open });
  assert.strictEqual(st.key, 'sleeping'); assert.strictEqual(st.eye, 0.2);
  st = resolvePlayerPose({ entity: { position: feet }, getBlock: open, sneak: true });
  assert.strictEqual(st.key, 'crouching', 'không có metadata nhưng đang giữ shift'); assert.strictEqual(st.source, 'control');
  st = resolvePlayerPose({ entity: { position: feet, eyeHeight: 1.27 }, getBlock: open });
  assert.strictEqual(st.key, 'crouching'); assert.strictEqual(st.source, 'mineflayer');
  st = resolvePlayerPose({ entity: { position: feet, eyeHeight: 1.62 }, getBlock: open });
  assert.strictEqual(st.key, 'standing', 'eyeHeight 1.62 mặc định của mineflayer không phải bằng chứng gì');
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 0 }, eyeHeight: 1.27 }, getBlock: open, sneak: true });
  assert.strictEqual(st.source, 'server', 'tư thế server báo ưu tiên hơn mineflayer/shift');
  assert.strictEqual(st.key, 'standing');
  assert.strictEqual(resolvePlayerPose({ entity: { position: feet, metadata: { 6: 5 } }, getBlock: open, hasPoseMeta: false }).source, 'assumed', 'MC<1.14: metadata[6] bị bỏ qua');
}

// --- kẹp theo trần (khe thấp): server ép ngồi/bò dù metadata còn báo đứng ---
{
  const w = mkWorld();
  w.put(10, 65, 10, blk('bedrock')); // trần cách chân 1.0
  let st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 0 } }, getBlock: w.get });
  assert.strictEqual(st.key, 'swimming'); assert.strictEqual(st.eye, 0.4); assert.strictEqual(st.clamped, true); assert.strictEqual(st.source, 'ceiling');
  st = resolvePlayerPose({ entity: { position: feet }, getBlock: w.get });
  assert.strictEqual(st.key, 'swimming', 'không có metadata cũng kẹp theo trần');

  const w2 = mkWorld();
  w2.put(10, 65, 10, blk('oak_slab', [[0, 0.5, 0, 1, 1, 1]])); // trần cách chân 1.5 -> vừa ngồi
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 0 } }, getBlock: w2.get });
  assert.strictEqual(st.key, 'crouching'); assert.strictEqual(st.eye, 1.27); assert.strictEqual(st.clamped, true);
  const w3 = mkWorld();
  w3.put(10, 66, 10, blk('stone')); // trần cách chân 2.0 -> thoải mái
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 0 } }, getBlock: w3.get });
  assert.strictEqual(st.key, 'standing'); assert.strictEqual(st.clamped, false);
  // đang bò sẵn mà trần cao rồi: tin server (có thể vừa chui ra, hoặc bơi) — không tự nâng lên
  st = resolvePlayerPose({ entity: { position: feet, metadata: { 6: 3 } }, getBlock: w3.get });
  assert.strictEqual(st.key, 'swimming');
}

// --- ca thật (log Auto-sell Spawn): khe cao 1 block sát bedrock, mineflayer báo 1.62 ---
{
  const w = mkWorld();
  const f = { x: -6902.51, y: -63.0, z: -17574.69 };
  const cage = { x: -6903, y: -63, z: -17574 };
  w.put(cage.x, cage.y, cage.z, blk('spawner'));
  w.put(-6903, -62, -17575, blk('bedrock'));
  const center = { x: cage.x + 0.5, y: cage.y + 0.5, z: cage.z + 0.5 };
  const st = resolvePlayerPose({ entity: { position: f, eyeHeight: 1.62, metadata: { 6: 0 }, onGround: true, velocity: { x: 0, y: -0.0784, z: 0 } }, getBlock: w.get });
  assert.strictEqual(st.eye, 0.4);
  assert.strictEqual(st.settled, true, 'đứng yên trên đất (vận tốc y âm nhẹ do trọng lực) là ổn định');
  const eye = { x: f.x, y: f.y + st.eye, z: f.z };
  const a = anglesTo(eye, center);
  const r = aimCheck({ eye, yaw: a.yaw, pitch: a.pitch, target: cage, maxDist: 7, getBlock: w.get });
  assert.strictEqual(r.hit, true, 'đúng tư thế bò -> tia ngắm trúng lồng');
}

// --- tư thế sai làm lệch góc: bò (mắt 0.4) mà tính như đứng (1.62) thì trượt lồng ---
{
  const w = mkWorld();
  const f = { x: 0.5, y: 64, z: 0.5 };
  const cage = { x: 2, y: 64, z: 0 };
  w.put(2, 64, 0, blk('spawner'));
  const center = { x: 2.5, y: 64.5, z: 0.5 };
  const trueEye = { x: f.x, y: f.y + 0.4, z: f.z };
  const wrong = anglesTo({ x: f.x, y: f.y + 1.62, z: f.z }, center);
  const right = anglesTo(trueEye, center);
  assert.strictEqual(aimCheck({ eye: trueEye, yaw: wrong.yaw, pitch: wrong.pitch, target: cage, maxDist: 7, getBlock: w.get }).hit, false, 'tính như đứng -> trượt');
  assert.strictEqual(aimCheck({ eye: trueEye, yaw: right.yaw, pitch: right.pitch, target: cage, maxDist: 7, getBlock: w.get }).hit, true);
}

// --- settled: đang nhảy/rơi, đang trượt, server chưa cập nhật tư thế ---
{
  const base = { position: feet, metadata: { 6: 0 } };
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: false }, getBlock: open }).why, 'air');
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: false, isInWater: true }, getBlock: open }).settled, true, 'đang ở trong nước thì không có "đáp đất"');
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: true, velocity: { x: 0.12, y: 0, z: 0.05 } }, getBlock: open }).why, 'moving');
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: true, velocity: { x: 0.002, y: 0, z: 0 } }, getBlock: open }).settled, true);
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: undefined }, getBlock: open }).settled, true, 'không biết onGround -> không chặn');
  // vừa bấm shift, server vẫn báo đứng
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: true }, getBlock: open, sneak: true }).why, 'pose');
  // vừa nhả shift, server vẫn báo ngồi
  assert.strictEqual(resolvePlayerPose({ entity: { position: feet, metadata: { 6: 5 }, onGround: true }, getBlock: open, sneak: false }).why, 'pose');
  // khớp nhau -> ổn
  assert.strictEqual(resolvePlayerPose({ entity: { position: feet, metadata: { 6: 5 }, onGround: true }, getBlock: open, sneak: true }).settled, true);
  assert.strictEqual(resolvePlayerPose({ entity: { ...base, onGround: true }, getBlock: open, sneak: false }).settled, true);
  // báo ngồi dù không giữ shift vì khe chỉ cao 1.5 (bị ép) -> KHÔNG chờ vô ích
  const w = mkWorld();
  w.put(10, 65, 10, blk('oak_slab', [[0, 0.5, 0, 1, 1, 1]]));
  assert.strictEqual(resolvePlayerPose({ entity: { position: feet, metadata: { 6: 5 }, onGround: true }, getBlock: w.get, sneak: false }).settled, true);
}

// --- describePose ---
assert.strictEqual(describePose(null), 'tư thế chưa rõ');
assert.strictEqual(describePose(resolvePlayerPose({ entity: { position: feet }, getBlock: open })), 'đứng (mắt +1.62)');
{
  const s = describePose(resolvePlayerPose({ entity: { position: feet, metadata: { 6: 5 } }, getBlock: open }));
  assert(s.startsWith('ngồi (shift)') && s.includes('1.27') && s.includes('server báo'), s);
  const w = mkWorld(); w.put(10, 65, 10, blk('bedrock'));
  const t = describePose(resolvePlayerPose({ entity: { position: feet }, getBlock: w.get }));
  assert(t.includes('bò') && t.includes('0.40') && t.includes('trần cao 1.00'), t);
}

console.log('pose-util.test OK');
