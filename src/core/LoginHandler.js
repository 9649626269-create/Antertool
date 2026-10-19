'use strict';
/**
 * LoginHandler — toàn bộ logic đăng nhập thành công, chờ tin server, tiếp tục vào menu.
 */
const { nowMs, normalizeSmallCaps } = require('./utils');
const { dbg } = require('./debug');

class LoginHandler {
  /**
   * @param {import('./BotSession')} session
   */
  constructor(session) {
    this.s = session;
  }

  /**
   * Kiểm tra text server có phải tin "đăng nhập thành công" không.
   */
  isLoginSuccessText(text) {
    const s = this.s;
    const t = normalizeSmallCaps(String(text || '')).normalize('NFC');
    if (s.loginSuccessPattern) {
      try { return new RegExp(s.loginSuccessPattern, 'i').test(t); }
      catch (e) {
        if (!s._loginPatWarned) {
          s._loginPatWarned = true;
          s.log('warn', `loginSuccessPattern không hợp lệ (${e.message}) — dùng câu mặc định`);
        }
      }
    }
    return /đăng\s*nhập\s*thành\s*công|đã\s*đăng\s*nhập|dang\s*nhap\s*thanh\s*cong|logged\s*in\s*successfully|successfully\s*logged\s*in/i.test(t);
  }

  /**
   * Gọi khi nhận được tin xác nhận đăng nhập.
   */
  onLoginConfirmed() {
    const s = this.s;
    if (s._loginConfirmed) return;
    s._loginConfirmed = true;
    s._clearTimer('loginConfirmWait');
    s.log('ok', 'Server xác nhận đăng nhập thành công — tiếp tục vào menu');
    this.continueAfterLogin();
  }

  /**
   * Gọi lại được nhiều lần (spawn, sau /dn, khi nhận tin xác nhận...).
   * Chỉ chạy tiếp khi đủ điều kiện, và chỉ 1 lần.
   */
  continueAfterLogin() {
    const s = this.s;
    if (!s.isOnline || s._disabled || s._menuFlowStarted || s._menuDoneAt) return;
    if (!s._loginCmdDone) return;
    if (s.cfg.botPassword && !s._loginConfirmed) {
      if (!s._timers.has('loginConfirmWait')) {
        const ms = s.loginConfirmTimeoutMs;
        s.log('sys', 'Đã gửi lệnh đăng nhập — chờ server báo "Đăng nhập thành công" rồi mới vào menu...');
        s._setTimer('loginConfirmWait', () => {
          if (!s.isOnline || s._loginConfirmed) return;
          s._loginConfirmed = true;
          s.log('warn', `Quá ${Math.round(ms / 1000)}s chưa thấy tin "Đăng nhập thành công" — vẫn đi tiếp (server dùng câu khác? đặt loginSuccessPattern trong config.json)`);
          this.continueAfterLogin();
        }, ms);
      }
      return;
    }
    s._clearTimer('loginConfirmWait');
    s._menuFlowStarted = true;
    if (s.cfg.autoMenu && s.cfg.menuCommand) {
      s.log('sys', 'Login hoàn tất — bắt đầu menu retry...');
      s._menuRetryCount = 0;
      s._menuSuccess = false;
      s._scheduleMenuRetry();
    } else {
      s._onMenuDone('autoMenu tắt');
    }
  }
}

module.exports = LoginHandler;
