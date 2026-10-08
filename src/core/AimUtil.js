'use strict';
// Kiểm tra "tia ngắm có tới được block đích không" — KHÔNG phụ thuộc mineflayer/vec3 nên test được riêng.
//
// Quy tắc: chỉ block đặc nguyên khối (1x1x1) mới tính là vật cản. Mọi block nửa khối / nhỏ / không đặc —
// chồi & cụm thạch anh tím (small/medium/large_amethyst_bud, amethyst_cluster), nến, thảm, nút bấm, ray, đuốc,
// cỏ, hoa, rào, kính tấm, bậc thang, phiến... — tia ngắm đi xuyên qua (người vẫn chui vô được thì bot cũng bỏ qua).
const EPS = 0.001;

// Chỉ dùng khi block KHÔNG có `shapes` (thư viện cũ / dữ liệu thiếu). Có `shapes` thì dựa hoàn toàn vào hình dạng thật.
const AIRLIKE_RE = /^(air|cave_air|void_air|light|structure_void)$/;
const PARTIAL_NAME_RE = /(amethyst_bud|amethyst_cluster|candle|carpet|button|pressure_plate|_rail$|^rail$|torch|lantern|chain$|_bars$|_pane$|fence|_wall$|stairs|_slab$|trapdoor|_door$|sign|banner|_head$|_skull$|sapling|^grass$|tall_grass|fern|vine|lichen|sculk_vein|dripstone|cobweb|lever|tripwire|ladder|scaffolding|coral_fan|end_rod|lightning_rod|flower|mushroom|pot$)/;

// true = block đặc nguyên khối, che được tia ngắm
function isFullCube(block) {
  if (!block) return false;
  const name = String(block.name || '');
  if (AIRLIKE_RE.test(name)) return false;
  const shapes = block.shapes;
  if (Array.isArray(shapes)) {
    return shapes.some(s => Array.isArray(s) && s.length >= 6 &&
      s[0] <= EPS && s[1] <= EPS && s[2] <= EPS && s[3] >= 1 - EPS && s[4] >= 1 - EPS && s[5] >= 1 - EPS);
  }
  if (block.boundingBox === 'empty') return false;
  if (PARTIAL_NAME_RE.test(name)) return false;
  return true; // không biết hình dạng -> coi như khối đặc (an toàn như cách cũ)
}

// Hướng nhìn theo quy ước mineflayer (yaw = atan2(-dx,-dz), pitch = atan2(dy, khoảng cách ngang))
function viewDir(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

// Góc (yaw, pitch) để mắt `eye` nhìn thẳng vào điểm `pt`
function anglesTo(eye, pt) {
  const dx = pt.x - eye.x, dy = pt.y - eye.y, dz = pt.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

// Đi dọc tia ngắm từ mắt; tới đúng block `target` ({x,y,z} nguyên) trước khi gặp khối đặc nào -> hit.
//   getBlock({x,y,z}) -> block | null (null = chunk chưa tải -> coi là thoáng)
// Trả về { hit, dist, blocker? } — blocker = { name, x, y, z } của khối đặc đầu tiên chắn tia.
function aimCheck({ eye, yaw, pitch, target, maxDist = 7, getBlock, step = 0.05 }) {
  const d = viewDir(yaw, pitch);
  let lx = NaN, ly = NaN, lz = NaN;
  for (let t = 0; t <= maxDist + 1e-9; t += step) {
    const bx = Math.floor(eye.x + d.x * t), by = Math.floor(eye.y + d.y * t), bz = Math.floor(eye.z + d.z * t);
    if (bx === target.x && by === target.y && bz === target.z) return { hit: true, dist: t };
    if (bx === lx && by === ly && bz === lz) continue; // vẫn trong block vừa kiểm tra
    lx = bx; ly = by; lz = bz;
    let b = null;
    try { b = getBlock({ x: bx, y: by, z: bz }); } catch { }
    if (b && isFullCube(b)) return { hit: false, dist: t, blocker: { name: String(b.name || '?'), x: bx, y: by, z: bz } };
  }
  return { hit: false, dist: maxDist };
}

module.exports = { isFullCube, viewDir, anglesTo, aimCheck };
