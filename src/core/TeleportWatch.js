'use strict';
// Theo dõi 1 lần gõ lệnh teleport (vd "/home treolong"): server đếm ngược ~5s, trong lúc đó bot PHẢI đứng yên
// (di chuyển/nhảy là plugin hủy teleport). Module này không phụ thuộc mineflayer nên test được riêng.
//
//   hold(now, ms)        giữ bot đứng yên trước khi gõ lệnh (để vận tốc về 0)
//   begin({cmd,pos,now}) vừa gõ lệnh -> bắt đầu đếm
//   frozen(now)          true = KHÔNG được cho bot đi/nhảy/xoay (AFK, macro nhẹ...)
//   note(text, now)      ghi lại tin server trong lúc chờ (để báo lại khi lỗi)
//   tick(pos, now)       gọi ~1s/lần -> trả về null | {type:'arrived'|'timeout', ...}
//                        arrived + inPlace=true: server báo teleport thành công nhưng vị trí gần như không đổi (đã ở sẵn home)
// Tin server báo teleport XONG (khác tin đang đếm ngược "Đang dịch chuyển đến ..."). Dùng cho trường hợp bot đã đứng sẵn ở home:
// server vẫn đếm ngược rồi "dịch chuyển" tại chỗ => vị trí không đổi, không thể dựa vào khoảng dịch để biết đã tới nơi.
const TP_DONE_RE = /(?:dịch chuyển|dich chuyen|teleport|tp)\s+thành công|(?:dịch chuyển|dich chuyen|teleport|tp)\s+thanh cong|successfully\s+teleported|teleported\s+(?:to|successfully)|đã\s+(?:dịch chuyển|teleport)\b/i;
const dist3 = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

class TeleportWatch {
  constructor(opts = {}) {
    this.warmupMs = opts.warmupMs ?? 5000;   // server đếm ngược bao lâu
    this.marginMs = opts.marginMs ?? 3000;   // chờ thêm cho gói teleport + tải chunk
    this.settleMs = opts.settleMs ?? 2000;   // sau khi tới nơi vẫn đứng yên chừng này
    this.minJump = opts.minJump ?? 3;        // dịch ≥ chừng này block mới coi là đã teleport
    this.confirmGraceMs = opts.confirmGraceMs ?? 1000; // server báo \"thành công\" rồi mà vị trí vẫn không đổi quá chừng này => teleport tại chỗ
    this.holdUntil = 0;
    this.s = null;
  }
  get deadlineMs() { return this.warmupMs + this.marginMs; }
  hold(now, ms) { this.holdUntil = Math.max(this.holdUntil, now + ms); }
  begin({ cmd, pos, now }) {
    this.s = {
      cmd, sentAt: now,
      start: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
      deadline: now + this.deadlineMs,
      freezeUntil: now + this.deadlineMs,
      arrived: false, maxDrift: 0, msgs: [], doneAt: 0,
    };
    return this.s;
  }
  cancel() { this.s = null; this.holdUntil = 0; }
  get active() { return !!this.s; }
  frozen(now) { return now < this.holdUntil || (!!this.s && now < this.s.freezeUntil); }
  note(text, now) {
    const s = this.s;
    if (!s || s.arrived) return;
    const t = String(text || '').trim().replace(/\s+/g, ' ').substring(0, 120);
    if (!t) return;
    if (!s.doneAt && TP_DONE_RE.test(t)) s.doneAt = now; // ghi thời điểm server báo xong (kể cả khi tin trùng đã có trong msgs)
    if (s.msgs.includes(t)) return;
    if (s.msgs.length < 8) s.msgs.push(t);
  }
  tick(pos, now) {
    const s = this.s;
    if (!s || !pos) return null;
    const d = s.start ? dist3(pos, s.start) : 0;
    if (!s.arrived) {
      s.maxDrift = Math.max(s.maxDrift, d);
      if (s.start && d >= this.minJump) {
        s.arrived = true;
        s.freezeUntil = now + this.settleMs;
        return { type: 'arrived', cmd: s.cmd, dist: d, ms: now - s.sentAt, msgs: s.msgs.slice() };
      }
      // server đã báo teleport thành công mà bot không xê dịch (đã đứng sẵn ở home) -> coi là tới nơi, KHÔNG báo timeout giả.
      // Chờ confirmGraceMs để gói vị trí mới (nếu có) kịp về; nếu bot lại tự xê dịch (>= 0.5) thì vẫn để nhánh timeout/selfMoved xử lý.
      if (s.doneAt && s.maxDrift < 0.5 && (now - s.doneAt >= this.confirmGraceMs || now >= s.deadline)) {
        s.arrived = true;
        s.freezeUntil = now + this.settleMs;
        return { type: 'arrived', inPlace: true, cmd: s.cmd, dist: d, ms: now - s.sentAt, msgs: s.msgs.slice() };
      }
      if (now >= s.deadline) {
        this.s = null;
        return {
          type: 'timeout', cmd: s.cmd, ms: now - s.sentAt, drift: s.maxDrift, msgs: s.msgs.slice(),
          selfMoved: s.maxDrift >= 0.5,   // bị xê dịch nhưng không phải teleport => hầu như chắc chắn bot tự đi/nhảy hoặc bị đẩy
        };
      }
      return null;
    }
    if (now >= s.freezeUntil) this.s = null; // đã tới nơi + đứng yên đủ lâu
    return null;
  }
}
module.exports = TeleportWatch;
