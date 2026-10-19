'use strict';
// Nhận diện TƯ THẾ / TRẠNG THÁI của bot (đứng, ngồi=shift, bò, bơi, đang nhảy/rơi...) để tính đúng chiều cao mắt
// -> xoay về lồng đúng góc. KHÔNG phụ thuộc mineflayer/vec3 nên test được riêng.
//
// Vì sao cần: góc nhìn (yaw/pitch) tới lồng phụ thuộc độ cao mắt. Đứng 1.62, ngồi (shift) 1.27, bò 0.4 — lệch tới 1.2 block;
// lồng cách 1-2 block thì pitch sai 30-50° (nhìn trượt lồng). Bản cũ chỉ đoán tư thế từ hình dạng block quanh đầu.
// Nay lấy theo thứ tự tin cậy:
//   1. Tư thế SERVER báo (metadata[6], MC >= 1.14)   2. cờ metadata[0] (ngồi/bơi/lướt)   3. entity.eyeHeight của mineflayer (nếu khác 1.62)
//   4. phím shift bot đang giữ   5. mặc định đứng
// rồi kẹp theo TRẦN thực tế (khe thấp bị ép ngồi/bò), cuối cùng kiểm tra mắt không lọt vào khối đặc.
const { EYE_STAND, EYE_SNEAK, EYE_CRAWL, isFullCube, eyeHeightFor } = require('./VectorUtil');
const { dbg } = require('./debug');

// h = chiều cao hitbox, eye = độ cao mắt tính từ chân (MC 1.14+)
const POSES = {
  standing: { eye: EYE_STAND, h: 1.8, vi: 'đứng' },
  crouching: { eye: EYE_SNEAK, h: 1.5, vi: 'ngồi (shift)' },
  swimming: { eye: EYE_CRAWL, h: 0.6, vi: 'bò/bơi' },
  fall_flying: { eye: EYE_CRAWL, h: 0.6, vi: 'bay lượn (elytra)' },
  spin_attack: { eye: EYE_CRAWL, h: 0.6, vi: 'xoay (trident)' },
  sleeping: { eye: 0.2, h: 0.2, vi: 'đang ngủ' },
  dying: { eye: 0.2, h: 0.2, vi: 'đã chết' },
  long_jumping: { eye: EYE_STAND, h: 1.8, vi: 'đứng' }, // chỉ mob (ếch...), người chơi không có
};
// thứ tự id của enum Pose (metadata[6]) từ MC 1.14
const POSE_IDS = ['standing', 'fall_flying', 'sleeping', 'swimming', 'spin_attack', 'crouching', 'long_jumping', 'dying'];
const ALIAS = { sneaking: 'crouching', sneak: 'crouching', crouch: 'crouching', sitting: 'crouching', crawling: 'swimming', crawl: 'swimming', gliding: 'fall_flying', elytra: 'fall_flying' };
const RANK = { standing: 3, long_jumping: 3, crouching: 2, swimming: 1 };
const SRC_VI = { server: 'server báo', flags: 'cờ server', mineflayer: 'mineflayer', control: 'phím shift', assumed: 'mặc định', ceiling: 'trần thấp ép' };
const EPS = 1e-3;

// Metadata[6] chỉ là Pose từ 1.14 (bản cũ: máu) -> chỉ đọc khi version >= 1.14
function supportsPoseMeta(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m) return true; // không biết version: bot đang chạy 1.21.x nên coi là có
  return +m[1] > 1 || +m[2] >= 14;
}

// số (id enum) | chuỗi (tên) -> khoá tư thế; không nhận ra -> null
function normalizePose(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return POSE_IDS[v] || null;
  if (typeof v === 'string') {
    const k = v.trim().toLowerCase().replace(/[\s-]+/g, '_');
    const a = ALIAS[k] || k;
    return POSES[a] ? a : null;
  }
  return null;
}

// Tư thế do SERVER báo cho chính bot (entity_metadata). { key, source } | null
function readReportedPose(entity, { hasPoseMeta = true } = {}) {
  const md = entity?.metadata;
  if (md && hasPoseMeta) {
    const k = normalizePose(md[6]);
    if (k) return { key: k, source: 'server' };
  }
  if (md && typeof md[0] === 'number') { // cờ entity: 0x02 ngồi, 0x10 bơi, 0x80 lướt elytra
    const f = md[0];
    if (f & 0x80) return { key: 'fall_flying', source: 'flags' };
    if (f & 0x10) return { key: 'swimming', source: 'flags' };
    if (f & 0x02) return { key: 'crouching', source: 'flags' };
    return { key: 'standing', source: 'flags' };
  }
  const k = normalizePose(entity?.pose);
  if (k) return { key: k, source: 'server' };
  return null;
}

// Chiều cao trống phía trên chân (tối đa 1.8): đi dọc 5 cột của hitbox (giữa + 4 góc, rộng 0.6), lấy đáy thấp nhất của khối đặc
// nằm phía trên chân. Dùng `shapes` nếu có (phiến/bậc thang...), không thì chỉ tính khối đặc nguyên khối.
//   getBlock({x,y,z}) -> block | null (null = chunk chưa tải -> coi là thoáng)
function headroomAbove({ pos, getBlock, max = 1.8 }) {
  if (!pos || typeof getBlock !== 'function') return max;
  const H = 0.29; // hitbox rộng 0.6: mép trừ chút để không dính khối kế bên
  const cols = [[0, 0], [H, H], [H, -H], [-H, H], [-H, -H]];
  const y0 = Math.floor(pos.y + EPS);
  let best = max; // chiều cao trống nhỏ nhất đã thấy (tính thẳng theo chiều cao để không dính sai số số học)
  for (const [dx, dz] of cols) {
    const px = pos.x + dx, pz = pos.z + dz;
    const bx = Math.floor(px), bz = Math.floor(pz);
    for (let by = y0; by <= Math.floor(pos.y + max); by++) {
      let b = null;
      try { b = getBlock({ x: bx, y: by, z: bz }); } catch (e) { dbg('MotionUtil', e); }
      if (!b) continue;
      let bottom = null;
      if (Array.isArray(b.shapes)) {
        const fx = px - bx, fz = pz - bz;
        for (const s of b.shapes) {
          if (!Array.isArray(s) || s.length < 6) continue;
          if (fx < s[0] - EPS || fx > s[3] + EPS || fz < s[2] - EPS || fz > s[5] + EPS) continue; // hình này không nằm trên cột đang xét
          const bt = by + s[1];
          if (bt >= pos.y - EPS && (bottom === null || bt < bottom)) bottom = bt; // chỉ tính đáy nằm trên chân (bỏ sàn/khối đang đứng trong)
        }
      } else if (isFullCube(b) && by >= pos.y - EPS) bottom = by;
      if (bottom !== null && bottom - pos.y < best) best = bottom - pos.y;
    }
  }
  return Math.max(0, best);
}

// Tư thế CAO NHẤT mà khe trống còn cho phép (vanilla: không vừa thì ép ngồi 1.5, không vừa nữa thì bò 0.6)
function maxPoseForHeadroom(h) {
  if (h >= POSES.standing.h - 0.01) return 'standing';
  if (h >= POSES.crouching.h - 0.01) return 'crouching';
  return 'swimming';
}

// eyeHeight bất thường của mineflayer (khác 1.62) -> tư thế gần nhất; không khớp -> null
function poseFromEyeHeight(h) {
  if (typeof h !== 'number' || !Number.isFinite(h) || Math.abs(h - EYE_STAND) < 0.01) return null;
  for (const k of ['crouching', 'swimming', 'sleeping']) if (Math.abs(POSES[k].eye - h) < 0.02) return k;
  return null;
}

// Gom mọi thứ lại. Tham số:
//   entity = mc.entity | sneak = phím shift đang giữ | hasPoseMeta | getBlock
// Trả về { key, label, eye, source, reported, headroom, clamped, adjusted, onGround, inFluid, speed, settled, why }
//   settled=false -> cơ thể CHƯA ổn định (đang nhảy/rơi, đang trượt, server chưa cập nhật tư thế): chờ rồi hãy tính góc nhìn.
function resolvePlayerPose({ entity, sneak = false, hasPoseMeta = true, getBlock } = {}) {
  const pos = entity?.position;
  const reported = readReportedPose(entity, { hasPoseMeta });
  let key, source;
  const mf = reported ? null : poseFromEyeHeight(entity?.eyeHeight);
  if (reported) { key = reported.key; source = reported.source; }
  else if (mf) { key = mf; source = 'mineflayer'; }
  else if (sneak) { key = 'crouching'; source = 'control'; }
  else { key = 'standing'; source = 'assumed'; }

  // kẹp theo trần: khe thấp thì server ép ngồi/bò dù đang không giữ shift (metadata trễ/thiếu thì vẫn tính đúng)
  let headroom = null, clamped = false;
  if (pos && typeof getBlock === 'function') {
    try { headroom = headroomAbove({ pos, getBlock }); } catch { headroom = null; }
    if (headroom !== null && RANK[key]) {
      const cap = maxPoseForHeadroom(headroom);
      if (RANK[key] > RANK[cap]) { key = cap; clamped = true; source = 'ceiling'; }
    }
  }
  let eye = POSES[key].eye;
  // chốt chặn cuối: ô chứa mắt vẫn là khối đặc -> hạ tiếp (xem eyeHeightFor)
  let adjusted = false;
  if (pos && typeof getBlock === 'function') {
    try {
      const h = eyeHeightFor({ pos, base: eye, getBlock });
      if (h < eye - EPS) { eye = h; adjusted = true; key = h <= EYE_CRAWL + 0.01 ? 'swimming' : 'crouching'; }
    } catch (e) { dbg('MotionUtil', e); }
  }

  const onGround = typeof entity?.onGround === 'boolean' ? entity.onGround : null;
  const inFluid = !!(entity?.isInWater || entity?.isInLava);
  const v = entity?.velocity;
  const speed = v && Number.isFinite(v.x) && Number.isFinite(v.z) ? Math.hypot(v.x, v.z) : 0;
  const flying = !!entity?.flying;

  let settled = true, why = null;
  if (onGround === false && !inFluid && !flying) { settled = false; why = 'air'; }          // đang nhảy/rơi: chân sắp đổi độ cao
  else if (speed > 0.01 && !inFluid) { settled = false; why = 'moving'; }                   // đang đi/trượt sau khi thả phím
  else if (reported?.source === 'server' && RANK[reported.key] && RANK[reported.key] >= 2 && !flying) {
    // server chưa cập nhật kịp sau khi đổi shift (đứng <-> ngồi): chờ 1-2 tick
    let want = sneak ? 'crouching' : 'standing';
    if (headroom !== null && RANK[want] > RANK[maxPoseForHeadroom(headroom)]) want = maxPoseForHeadroom(headroom);
    if (reported.key !== want && RANK[want] >= 2) { settled = false; why = 'pose'; }
  }
  return { key, label: POSES[key].vi, eye, source, reported: reported?.key || null, headroom, clamped, adjusted, onGround, inFluid, speed, settled, why };
}

// "đứng (mắt +1.62)" / "ngồi (shift) (mắt +1.27, server báo)" — để ghi log chẩn đoán
function describePose(st) {
  if (!st) return 'tư thế chưa rõ';
  const bits = [`mắt +${st.eye.toFixed(2)}`];
  if (st.source && st.source !== 'assumed') bits.push(SRC_VI[st.source] || st.source);
  if (st.adjusted) bits.push('mắt lọt khối đặc nên hạ thấp');
  if (st.headroom !== null && st.headroom < POSES.standing.h - 0.01) bits.push(`trần cao ${st.headroom.toFixed(2)}`);
  return `${st.label} (${bits.join(', ')})`;
}

module.exports = { POSES, POSE_IDS, supportsPoseMeta, normalizePose, readReportedPose, headroomAbove, maxPoseForHeadroom, poseFromEyeHeight, resolvePlayerPose, describePose };
