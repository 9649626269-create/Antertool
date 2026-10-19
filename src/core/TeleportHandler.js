'use strict';
/**
 * TeleportHandler — tách logic teleport (/home), đứng yên chờ, HUD filter từ BotSession.
 * this._tp (TeleportWatch) vẫn thuộc session; handler điều phối.
 */
const { TP } = require('./constants');
const { nowMs, sleep } = require('./utils');
const { dbg } = require('./debug');

class TeleportHandler {
  /**
   * @param {import('./BotSession')} session
   */
  constructor(session) {
    this.s = session;
  }

  /** Thả phím + giữ đứng yên trước khi gõ lệnh teleport */
  holdBeforeSend(now = nowMs()) {
    const s = this.s;
    s._tp.hold(now, TP.PRESEND_MS + 400);
  }

  /** Ghi nhận tin action bar / title liên quan teleport */
  noteHud(text, now = nowMs()) {
    const s = this.s;
    const t = String(text || '');
    s._tp.note(t, now);
    if (!(s._tp.active || s._tp.frozen(now) || TP.HUD_RE.test(t))) return false;
    return true;
  }

  isFrozen(now = nowMs()) {
    return this.s._tp.frozen(now);
  }

  isActive() {
    return this.s._tp.active;
  }

  // TODO: chuyển _homeAndWait, _faceBlock, _aimCheckBlock sang đây.
}

module.exports = TeleportHandler;
