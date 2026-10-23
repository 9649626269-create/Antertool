'use strict';
/**
 * TeleportHandler — điều phối teleport (/home), giữ đứng yên trước khi gửi lệnh, và lọc thông báo HUD.
 * this._tp (TeleportWatch) thuộc về BotSession; handler này quản lý việc thả phím và ghi nhận HUD.
 */
const { TP } = require('./constants');
const { nowMs } = require('./utils');
const { dbg } = require('./debug');

class TeleportHandler {
  /**
   * @param {import('./BotSession')} session
   */
  constructor(session) {
    this.s = session;
  }

  /** Thả hết phím AFK + giữ đứng yên trước khi gõ lệnh teleport */
  holdBeforeSend(now = nowMs()) {
    const s = this.s;
    s._tp.hold(now, TP.PRESEND_MS + 400);
    for (const k of ['afkJumpOff', 'afkSneak', 'wafkKey', 'wafkJump']) s._clearTimer(k);
    try {
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
        s.mc?.setControlState(k, false);
      }
    } catch (e) {
      dbg('TeleportHandler', e);
    }
  }

  /** Ghi nhận và hiển thị tin action bar / title liên quan teleport (chống lặp trong 4s) */
  noteHud(text, label = 'ActionBar', now = nowMs()) {
    const s = this.s;
    const t = String(text || '').trim();
    if (!t) return false;
    s._tp.note(t, now);
    if (!(s._tp.active || s._tp.frozen(now) || TP.HUD_RE.test(t))) return false;
    if (s._hudLast && s._hudLast.text === t && now - s._hudLast.at < 4000) return false;
    s._hudLast = { text: t, at: now };
    s.log('chat', `[${label}] ${t}`);
    return true;
  }

  isFrozen(now = nowMs()) {
    return this.s._tp.frozen(now);
  }

  isActive() {
    return this.s._tp.active;
  }
}

module.exports = TeleportHandler;
