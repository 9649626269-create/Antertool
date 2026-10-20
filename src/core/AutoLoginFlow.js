'use strict';
/**
 * AutoLoginFlow — port từ premium/AliceAutoReconnect.java ("Auto Login & Antibot & Auto Join") sang mineflayer.
 *
 * Luồng (máy trạng thái, tick 250ms):
 *   server báo "đăng nhập bằng lệnh /dn" → gửi `/l <mật khẩu>` → chờ tin xác nhận
 *   → gửi `/menu` → mở GUI:
 *        • thấy ô antibot (tên chứa "xác minh" / "là người" / "verify") → click ô đó tới khi server báo "xác minh thành công"
 *        • sau đó click ô vào server (mặc định ô 24 = settings.kingSmpSlot) → chờ GUI đóng → xong (auto join)
 *   Trong lúc chạy: tạm dừng AutoOrder / spawnerprotect / việc tự về home (qua session._isBusy), xong thì bật lại.
 *
 * Khác bản Java (cải tiến an toàn):
 *   - Giới hạn số lần gửi lại lệnh đăng nhập (sai mật khẩu không bị lặp vô tận).
 *   - Chờ GUI nạp đủ item rồi mới quyết định antibot/click (mineflayer báo windowOpen trước window_items).
 *   - Cooldown cho tin kích hoạt menu để không lặp /menu liên tục.
 *   - Timeout tổng 3 phút áp dụng cho cả luồng khởi động bằng tin menu.
 *   - Fallback auto-join: không thấy tin login/menu nào sau N giây thì tự mở menu.
 *
 * Mặc định TẮT (cfg.autoLogin.enabled). Khi BẬT, nó thay luồng /dn + menuRetry cũ của BotSession.
 */
const { dbg } = require('./debug');
const { resolveText, nowMs, jit } = require('./utils');
const { normalizeVi } = require('./PremiumLogic');

const ST = Object.freeze({
  IDLE: 'IDLE',
  WAITING_TO_SEND_LOGIN: 'WAITING_TO_SEND_LOGIN',
  WAITING_LOGIN_SUCCESS: 'WAITING_LOGIN_SUCCESS',
  SENDING_MENU: 'SENDING_MENU',
  WAIT_FOR_MENU_GUI: 'WAIT_FOR_MENU_GUI',
  ANTIBOT_VERIFY: 'ANTIBOT_VERIFY',
  WAIT_AFTER_VERIFY: 'WAIT_AFTER_VERIFY',
  CLICKING_FINAL_SLOT: 'CLICKING_FINAL_SLOT',
  WAITING_TO_RESTORE: 'WAITING_TO_RESTORE',
});
const MENU_STATES = new Set([ST.SENDING_MENU, ST.WAIT_FOR_MENU_GUI, ST.ANTIBOT_VERIFY, ST.WAIT_AFTER_VERIFY, ST.CLICKING_FINAL_SLOT]);

const DEFAULTS = Object.freeze({
  enabled: false,
  password: '',                 // trống = dùng botPassword của bot (hoặc biến môi trường BOT_PASSWORD_<ID>)
  loginCommand: '/l',
  registerCommand: '/dk',       // chỉ gửi khi cfg.registered === false
  menuCommand: '',              // trống = cfg.menuCommand || '/menu'
  finalSlot: 0,                 // 0 = settings.kingSmpSlot (mặc định 24)
  actionDelayMs: 750,           // 15 tick như bản Java; kẹp 750–2000
  loginPrompt: ['dang nhap bang lenh', '/dn'],   // TẤT CẢ cụm phải có trong tin (đã bỏ dấu, chữ thường)
  menuTriggers: [
    'dang nhap thanh cong, neu chua tao ma pin, hay vao',
    'server con moi nen neu co',
    'khong duoc phep ban cac vat pham',
  ],
  antibotItemNames: ['xac minh', 'la nguoi', 'verify'],
  antibotSuccess: ['xac minh thanh cong'],
  menuSendDelayMs: 2500,
  menuTimeoutMs: 8000,
  antibotTimeoutMs: 20000,
  postVerifyWaitMs: 1500,
  restoreSettleMs: 2000,
  globalTimeoutMs: 180000,
  maxLoginAttempts: 5,
  triggerCooldownMs: 15000,
  startFallbackMs: 20000,       // 0 = tắt fallback auto-join
  pauseFeatures: true,
});

// ── logic thuần (có test) ─────────────────────────────────────────────────────
const normList = (v, fallback) => {
  const a = Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v] : null);
  const out = (a || fallback).map(x => normalizeVi(x).trim()).filter(Boolean);
  return out.length ? out : fallback.slice();
};
const numOr = (v, d, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(hi, Math.max(lo, n));
};

function resolveOptions(user = {}) {
  const u = user && typeof user === 'object' ? user : {};
  return {
    enabled: u.enabled === true,
    password: typeof u.password === 'string' ? u.password : '',
    loginCommand: String(u.loginCommand || DEFAULTS.loginCommand).trim(),
    registerCommand: String(u.registerCommand || DEFAULTS.registerCommand).trim(),
    menuCommand: String(u.menuCommand || '').trim(),
    finalSlot: Math.floor(numOr(u.finalSlot, 0, 0, 255)),
    actionDelayMs: numOr(u.actionDelayMs, DEFAULTS.actionDelayMs, 750, 2000),
    loginPrompt: normList(u.loginPrompt, DEFAULTS.loginPrompt),
    menuTriggers: normList(u.menuTriggers, DEFAULTS.menuTriggers),
    antibotItemNames: normList(u.antibotItemNames, DEFAULTS.antibotItemNames),
    antibotSuccess: normList(u.antibotSuccess, DEFAULTS.antibotSuccess),
    menuSendDelayMs: numOr(u.menuSendDelayMs, DEFAULTS.menuSendDelayMs, 500, 30000),
    menuTimeoutMs: numOr(u.menuTimeoutMs, DEFAULTS.menuTimeoutMs, 2000, 60000),
    antibotTimeoutMs: numOr(u.antibotTimeoutMs, DEFAULTS.antibotTimeoutMs, 3000, 120000),
    postVerifyWaitMs: numOr(u.postVerifyWaitMs, DEFAULTS.postVerifyWaitMs, 0, 30000),
    restoreSettleMs: numOr(u.restoreSettleMs, DEFAULTS.restoreSettleMs, 0, 30000),
    globalTimeoutMs: numOr(u.globalTimeoutMs, DEFAULTS.globalTimeoutMs, 20000, 1800000),
    maxLoginAttempts: Math.floor(numOr(u.maxLoginAttempts, DEFAULTS.maxLoginAttempts, 1, 20)),
    triggerCooldownMs: numOr(u.triggerCooldownMs, DEFAULTS.triggerCooldownMs, 0, 600000),
    startFallbackMs: numOr(u.startFallbackMs, DEFAULTS.startFallbackMs, 0, 600000),
    pauseFeatures: u.pauseFeatures !== false,
  };
}

/** Tin server yêu cầu đăng nhập? (mọi cụm trong `prompt` đều có mặt) */
function isLoginPrompt(text, prompt = DEFAULTS.loginPrompt) {
  const n = normalizeVi(text);
  return prompt.length > 0 && prompt.every(p => n.includes(p));
}
/** Trả về cụm kích hoạt menu khớp đầu tiên, hoặc null */
function matchMenuTrigger(text, triggers = DEFAULTS.menuTriggers) {
  const n = normalizeVi(text);
  return triggers.find(t => n.includes(t)) || null;
}
function isAntibotSuccess(text, list = DEFAULTS.antibotSuccess) {
  const n = normalizeVi(text);
  return list.some(p => n.includes(p));
}
function isAntibotItemName(name, list = DEFAULTS.antibotItemNames) {
  const n = normalizeVi(name);
  return !!n && list.some(p => n.includes(p));
}
const itemLabel = it => {
  try { return resolveText(it?.customName || it?.displayName || ''); } catch { return String(it?.displayName || ''); }
};
/** Số ô thuộc phần container của cửa sổ (không tính túi đồ người chơi), tối đa 54 */
function containerSize(win) {
  const n = Number.isInteger(win?.inventoryStart) ? win.inventoryStart : (win?.slots?.length || 0);
  return Math.min(n, 54);
}
/** Cửa sổ đã nhận item chưa (windowOpen đến trước window_items) */
function isPopulated(win) {
  const lim = containerSize(win);
  for (let i = 0; i < lim; i++) if (win.slots[i]) return true;
  return false;
}
/** Chỉ số ô antibot trong cửa sổ, -1 nếu không có */
function findAntibotSlot(win, names = DEFAULTS.antibotItemNames) {
  if (!win?.slots) return -1;
  const lim = containerSize(win);
  for (let i = 0; i < lim; i++) {
    const it = win.slots[i];
    if (it && isAntibotItemName(itemLabel(it), names)) return i;
  }
  return -1;
}

// ── máy trạng thái ────────────────────────────────────────────────────────────
class AutoLoginFlow {
  /** @param {import('./BotSession')} session */
  constructor(session) {
    this.s = session;
    this.o = resolveOptions(session.cfg?.autoLogin);
    this.state = ST.IDLE;
    this._resetFields();
  }

  _resetFields() {
    this.state = ST.IDLE;
    this._enteredAt = 0;
    this._flowStartedAt = 0;
    this._verifySuccess = false;
    this._lastClickAt = 0;
    this._lastMenuSentAt = 0;
    this._lastMenuBeginAt = 0;
    this._loginSentAt = 0;
    this._loginAttempts = 0;
    this._restoreAt = 0;
    this._joinedOnce = false;
    this._pausedAutoOrder = false;
    this._gap = this.o.actionDelayMs;
  }

  /** Đọc lại cfg.autoLogin (sau khi đổi lệnh / dashboard) */
  reload() { this.o = resolveOptions(this.s.cfg?.autoLogin); }

  get enabled() { return !!this.o.enabled; }
  get inFlow() { return this.enabled && this.state !== ST.IDLE; }
  /** true = flow đang tự điều khiển GUI → BotSession không cho WindowRouter/SessionVerifier đụng vào */
  ownsWindows() { return this.enabled && (MENU_STATES.has(this.state) || this.state === ST.WAITING_TO_RESTORE); }

  setEnabled(v) {
    this.s.cfg.autoLogin = { ...(this.s.cfg.autoLogin || {}), enabled: !!v };
    this.reload();
    if (!v) this.reset();
    try { this.s._persistAutoLoginCfg?.(); } catch { /* lưu cấu hình không được làm hỏng bot */ }
  }

  status() {
    const o = this.o;
    return `AutoLogin: ${o.enabled ? 'BẬT' : 'TẮT'} | trạng thái ${this.state} | login ${o.loginCommand} | ô vào server ${this._finalSlot()} | `
      + `fallback join ${o.startFallbackMs ? Math.round(o.startFallbackMs / 1000) + 's' : 'tắt'} | mật khẩu ${this._password() ? 'đã có' : 'CHƯA CÓ'}`;
  }

  // ── vòng đời ──
  /** Gọi khi mc phát 'login' (đã vào server, chưa chắc đã spawn) */
  onConnected() {
    if (!this.enabled) return;
    this._resetFields();
    const s = this.s;
    s._setTimer('autoLoginTick', () => { try { this._tick(); } catch (e) { dbg('AutoLoginFlow', e); } }, 250, true);
    if (this.o.startFallbackMs > 0) {
      s._setTimer('autoLoginFallback', () => {
        if (!this.enabled || this.state !== ST.IDLE || this._joinedOnce || !s.isOnline) return;
        this._log('sys', `Không thấy tin đăng nhập/menu sau ${Math.round(this.o.startFallbackMs / 1000)}s — tự mở menu (auto join). Nếu server cần đăng nhập mà không tự chạy, chỉnh autoLogin.loginPrompt.`);
        this._beginMenuFlow('fallback');
      }, this.o.startFallbackMs);
    }
  }

  /** Gọi khi mất kết nối */
  reset() {
    try { this.s._clearTimer('autoLoginTick'); this.s._clearTimer('autoLoginFallback'); } catch (e) { dbg('AutoLoginFlow', e); }
    this._resumeFeatures();
    this._resetFields();
  }

  // ── sự kiện chat ──
  /** @returns {boolean} true nếu tin này đã kích hoạt/xử lý một bước */
  onMessage(text) {
    if (!this.enabled) return false;
    const o = this.o;
    const n = normalizeVi(text);
    if (!n) return false;

    const trig = o.menuTriggers.find(t => n.includes(t));
    if (trig) return this._beginMenuFlow(trig);

    if (this.state === ST.ANTIBOT_VERIFY && o.antibotSuccess.some(p => n.includes(p))) {
      this._verifySuccess = true;
      this._set(ST.WAIT_AFTER_VERIFY);
      this._log('ok', 'Xác minh antibot thành công.');
      return true;
    }
    if (this.state === ST.WAITING_LOGIN_SUCCESS) {
      if (this.s._isLoginSuccessText?.(text)) return this._beginMenuFlow('login-success');
      if (n.includes('/dn') && nowMs() - this._loginSentAt >= Math.max(1500, this._gap)) {
        if (this._sendLogin()) this._log('sys', 'Server nhắc /dn lại — đã gửi lại lệnh đăng nhập.');
        return true;
      }
      return false;
    }
    if (this.state !== ST.IDLE) return false;
    if (o.loginPrompt.every(p => n.includes(p))) { this._startLogin(); return true; }
    return false;
  }

  /** Lệnh `autologin now` / `join`: mở menu + vào server ngay */
  joinNow() {
    if (!this.enabled) return false;
    if (!this.s.isOnline) return false;
    return this._beginMenuFlow('manual');
  }

  // ── nội bộ ──
  _log(level, msg) { this.s.log(level, `[AutoLogin] ${msg}`); }
  _set(st) {
    this.state = st;
    this._enteredAt = nowMs();
    this._gap = jit(this.o.actionDelayMs, Math.round(this.o.actionDelayMs * 0.2));
  }
  _password() { return String(this.o.password || this.s.cfg?.botPassword || '').trim(); }
  _finalSlot() { return this.o.finalSlot || this.s.settings?.kingSmpSlot || 24; }
  _menuCmd() { return this.o.menuCommand || this.s.cfg?.menuCommand || '/menu'; }
  _canChat() { const s = this.s; return !!(s.mc && s.mc.entity && s.isConnected); }
  _win() { return this.s.mc?.currentWindow || null; }
  _closeWin() { try { const w = this._win(); if (w) this.s.mc.closeWindow(w); } catch (e) { dbg('AutoLoginFlow', e); } }
  _click(slot) {
    try { Promise.resolve(this.s.mc.clickWindow(slot, 0, 0)).catch(e => dbg('AutoLoginFlow', e)); } catch (e) { dbg('AutoLoginFlow', e); }
    this._lastClickAt = nowMs();
    this._gap = jit(this.o.actionDelayMs, Math.round(this.o.actionDelayMs * 0.2));
  }

  _pauseFeatures() {
    if (!this.o.pauseFeatures) return;
    try {
      if (this.s.autoOrder?.suspend()) { this._pausedAutoOrder = true; this._log('sys', 'Đã tạm dừng AutoOrder.'); }
    } catch (e) { dbg('AutoLoginFlow', e); }
  }
  _resumeFeatures() {
    if (!this._pausedAutoOrder) return;
    this._pausedAutoOrder = false;
    try { if (this.s.autoOrder?.resume()) this._log('sys', 'Đã bật lại AutoOrder.'); } catch (e) { dbg('AutoLoginFlow', e); }
  }

  _startLogin() {
    this._verifySuccess = false;
    this._lastClickAt = 0;
    this._flowStartedAt = nowMs();
    this._pauseFeatures();
    this._set(ST.WAITING_TO_SEND_LOGIN);
    this._log('sys', 'Đã phát hiện yêu cầu đăng nhập — chờ gửi lệnh.');
  }

  _beginMenuFlow(label) {
    if (MENU_STATES.has(this.state)) return false;
    const now = nowMs();
    const forced = label === 'manual' || label === 'fallback';
    if (!forced && this._lastMenuBeginAt && now - this._lastMenuBeginAt < this.o.triggerCooldownMs) return false;
    this._pauseFeatures();
    this._verifySuccess = false;
    this._lastClickAt = 0;
    this._lastMenuBeginAt = now;
    if (this.state === ST.IDLE) this._flowStartedAt = now;
    this._set(ST.SENDING_MENU);
    this._log('sys', `Bắt đầu mở menu (${label}).`);
    return true;
  }

  /** Gửi lệnh đăng nhập. false = không gửi được (flow đã được huỷ nếu hết lượt/không có mật khẩu) */
  _sendLogin() {
    const pw = this._password();
    if (!pw) { this._abort('chưa có mật khẩu — đặt botPassword hoặc autoLogin.password'); return false; }
    if (this._loginAttempts >= this.o.maxLoginAttempts) {
      this._abort(`đã gửi lệnh đăng nhập ${this._loginAttempts} lần mà server vẫn đòi — kiểm tra mật khẩu`);
      return false;
    }
    this._loginAttempts++;
    try { this.s.mc.chat(`${this.o.loginCommand} ${pw}`); } catch (e) { this._log('err', 'Lỗi gửi lệnh đăng nhập: ' + e.message); return false; }
    this._loginSentAt = nowMs();
    return true;
  }

  _abort(reason) {
    this._log('warn', `Dừng luồng: ${reason}.`);
    this._closeWin();
    this._resumeFeatures();
    this._flowStartedAt = 0;
    this._set(ST.IDLE);
  }

  _complete() {
    const s = this.s;
    this._resumeFeatures();
    this._joinedOnce = true;
    this._loginAttempts = 0;
    this._flowStartedAt = 0;
    this._set(ST.IDLE);
    this._log('ok', 'Hoàn tất flow đăng nhập + vào server.');
    // Đồng bộ với trình tự khởi động của BotSession (cổng vị trí → bật tính năng)
    try {
      s._loginConfirmed = true; s._loginCmdDone = true; s._menuFlowStarted = true;
      s._clearTimer('loginConfirmWait'); s._clearTimer('menuRetry');
      s._menuSuccess = true;
      s._onMenuDone('AutoLogin');
    } catch (e) { dbg('AutoLoginFlow', e); }
  }

  _tick() {
    if (!this.enabled || this.state === ST.IDLE) return;
    const now = nowMs();
    if (this._flowStartedAt && now - this._flowStartedAt >= this.o.globalTimeoutMs) {
      this._abort(`quá ${Math.round(this.o.globalTimeoutMs / 1000)}s chưa xong`);
      return;
    }
    const since = now - this._enteredAt;
    const o = this.o;
    const win = this._win();
    const canChat = this._canChat();

    switch (this.state) {
      case ST.WAITING_TO_SEND_LOGIN: {
        if (!canChat || since < this._gap) return;
        // Tài khoản mới: đăng ký trước (giống luồng /dk cũ), rồi mới đăng nhập sau 1 nhịp nữa
        if (this.s.cfg.registered === false && this._password()) {
          try { this.s.mc.chat(`${o.registerCommand} ${this._password()}`); } catch (e) { dbg('AutoLoginFlow', e); }
          this.s.cfg.registered = true;
          this._log('ok', `Đã gửi ${o.registerCommand}.`);
          this._set(ST.WAITING_TO_SEND_LOGIN);
          return;
        }
        if (!this._sendLogin()) return;
        this._set(ST.WAITING_LOGIN_SUCCESS);
        this._log('ok', `Đã gửi ${o.loginCommand}.`);
        return;
      }
      case ST.WAITING_LOGIN_SUCCESS:
        return; // chờ tin chat (onMessage)
      case ST.SENDING_MENU: {
        if (!canChat || since < o.menuSendDelayMs) return;
        try { this.s.mc.chat(this._menuCmd()); } catch (e) { this._log('err', 'Lỗi gửi menu: ' + e.message); return; }
        this._verifySuccess = false;
        this._lastMenuSentAt = now;
        this._lastClickAt = 0;
        this._set(ST.WAIT_FOR_MENU_GUI);
        this._log('sys', `Đã gửi ${this._menuCmd()}.`);
        return;
      }
      case ST.WAIT_FOR_MENU_GUI: {
        if (!win) { if (now - this._lastMenuSentAt >= o.menuTimeoutMs) this._set(ST.SENDING_MENU); return; }
        if (!isPopulated(win)) { if (since >= o.menuTimeoutMs) { this._closeWin(); this._set(ST.SENDING_MENU); } return; }
        this._lastClickAt = 0;
        if (findAntibotSlot(win, o.antibotItemNames) >= 0) {
          this._set(ST.ANTIBOT_VERIFY);
          this._log('sys', 'Phát hiện antibot, bắt đầu xác minh.');
        } else {
          this._set(ST.CLICKING_FINAL_SLOT);
        }
        return;
      }
      case ST.ANTIBOT_VERIFY: {
        if (this._verifySuccess) { this._set(ST.WAIT_AFTER_VERIFY); return; }
        if (since >= o.antibotTimeoutMs) {
          this._closeWin();
          this._set(ST.SENDING_MENU);
          this._log('warn', 'Timeout antibot, thử lại /menu.');
          return;
        }
        if (!win) { if (since >= o.menuTimeoutMs) this._set(ST.SENDING_MENU); return; }
        if (!canChat || now - this._lastClickAt < this._gap) return;
        const slot = findAntibotSlot(win, o.antibotItemNames);
        if (slot < 0) return;
        this._click(slot);
        return;
      }
      case ST.WAIT_AFTER_VERIFY: {
        if (since < o.postVerifyWaitMs) return;
        this._lastClickAt = 0;
        // GUI đã đóng sau khi xác minh → mở lại menu luôn thay vì chờ timeout
        this._set(win ? ST.CLICKING_FINAL_SLOT : ST.SENDING_MENU);
        return;
      }
      case ST.CLICKING_FINAL_SLOT: {
        if (!win) { if (since >= o.menuTimeoutMs) this._set(ST.SENDING_MENU); return; }
        if (!this._verifySuccess && findAntibotSlot(win, o.antibotItemNames) >= 0) { this._set(ST.ANTIBOT_VERIFY); return; }
        if (!canChat || now - this._lastClickAt < this._gap) return;
        const slot = this._finalSlot();
        if (!(win.slots?.length > slot) || !win.slots[slot]) {
          if (since >= o.menuTimeoutMs) { this._closeWin(); this._set(ST.SENDING_MENU); }
          return;
        }
        this._click(slot);
        this._verifySuccess = false;
        this._set(ST.WAITING_TO_RESTORE);
        this._restoreAt = now + o.restoreSettleMs;
        this._log('sys', `Đã click ô ${slot}.`);
        return;
      }
      case ST.WAITING_TO_RESTORE: {
        if (now < this._restoreAt) return;
        if (win) { if (since >= o.menuTimeoutMs) this._closeWin(); return; }
        if (!canChat) return;
        this._complete();
        return;
      }
      default:
        return;
    }
  }
}

module.exports = AutoLoginFlow;
module.exports.AutoLoginFlow = AutoLoginFlow;
module.exports.ST = ST;
module.exports.DEFAULTS = DEFAULTS;
module.exports.resolveOptions = resolveOptions;
module.exports.isLoginPrompt = isLoginPrompt;
module.exports.matchMenuTrigger = matchMenuTrigger;
module.exports.isAntibotSuccess = isAntibotSuccess;
module.exports.isAntibotItemName = isAntibotItemName;
module.exports.findAntibotSlot = findAntibotSlot;
module.exports.isPopulated = isPopulated;
