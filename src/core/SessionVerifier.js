'use strict';
/**
 * SessionVerifier — tự động vượt hệ thống anti-bot của các server Minecraft.
 *
 * Hỗ trợ:
 *  1. Math captcha  — server gửi phép tính, bot tự giải và gửi đáp án
 *  2. Click captcha — GUI yêu cầu click đúng slot / phân loại đồ vật
 *  3. Move verify   — server yêu cầu bot di chuyển (W/S/jump) để chứng minh không AFK
 *  4. Pattern rules — danh sách regex tùy chỉnh + command phản hồi
 *  5. Cooldown      — tránh spam lệnh khi cùng trigger nhiều lần
 *
 * Dùng:
 *   const SessionVerifier = require('./SessionVerifier');
 *   // trong constructor BotSession:
 *   this.sessionVerifier = new SessionVerifier(this, cfg.sessionCheck || {});
 *   // trong message handler:
 *   this.sessionVerifier.onMessage(text, pos);
 *   // trong windowOpen handler:
 *   if (this.sessionVerifier.onWindowOpen(win)) return;
 *   // trong _cleanupOnDisconnect:
 *   this.sessionVerifier.reset();
 */

const { dbg } = require('./debug');

// ─── hằng số ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,

  // ── Math captcha ──────────────────────────────────────────────────────────
  // Các pattern nhận dạng phép tính từ server.
  // Mỗi entry: { pattern: RegExp, captureGroup: 1 }
  // captureGroup = chỉ số nhóm regex chứa toàn bộ biểu thức (vd "5 + 3")
  mathCaptcha: {
    enabled: true,
    delayMs: [800, 2000],           // random delay trước khi trả lời (ms)
    maxAttempts: 5,                 // bỏ qua sau n lần thử (tránh vòng lặp sai)
    // Lệnh để gửi đáp án: "{answer}" sẽ được thay bằng kết quả
    answerCommand: '/captcha {answer}',
    patterns: [
      // KingMC / NiteMinecraft / MaxSMP: "Giải phép tính: 5 + 3 = ?"
      {
        regex: /gi[aả]i\s+ph[eé]p\s+t[íi]nh[:\s]+(.+?)\s*=\s*\?/i,
        captureGroup: 1,
      },
      // "Nhập kết quả: 12 * 7"
      {
        regex: /nh[aậ]p\s+k[eế]t\s+qu[aả][:\s]+(.+)/i,
        captureGroup: 1,
      },
      // "[SessionCheck] 9 - 4 = ?"
      {
        regex: /\[sessioncheck\][^0-9]*([0-9\s+\-*/^%()]+)\s*=\s*\?/i,
        captureGroup: 1,
      },
      // Generic: "8 + 6 = ?" hoặc "8+6=?"
      {
        regex: /([0-9\s+\-*/^%()]{3,})\s*=\s*\?/,
        captureGroup: 1,
      },
    ],
  },

  // ── Move verify ───────────────────────────────────────────────────────────
  moveVerify: {
    enabled: true,
    delayMs: [500, 1500],
    // Mẫu chat server gửi yêu cầu di chuyển
    patterns: [
      /di\s*chuy[eể]n/i,
      /move|walk|step/i,
      /\[sessioncheck\].*move/i,
      /nh[aấ]n\s+phím/i,
      /press\s+(w|s|a|d|space)/i,
    ],
    // Chuỗi thao tác: 'forward' | 'back' | 'left' | 'right' | 'jump' | 'sneak'
    // mỗi bước cách nhau stepDelayMs ms
    moveSequence: ['forward', 'jump', 'back'],
    stepDelayMs: 300,
  },

  // ── Click captcha (GUI) ───────────────────────────────────────────────────
  clickCaptcha: {
    enabled: true,
    // Tiêu đề GUI kích hoạt anti-bot click
    titlePatterns: [
      /sessioncheck/i,
      /captcha/i,
      /xác\s*minh/i,
      /verify/i,
      /ch[uứ]ng\s*minh/i,
    ],
    // Từ khóa trong tên item → slot cần click (index 0-based trong slots[])
    // Ưu tiên item CÓ tên khớp pattern. Nếu không khớp → click slot đầu tiên không phải air.
    targetItemPatterns: [
      /\bclick\b/i,
      /\bchọn\b/i,
      /\bcorrect\b/i,
      /\bđúng\b/i,
      /green|lime/i,         // màu xanh lá thường là "đúng"
    ],
    delayMs: [600, 1800],
  },

  // ── Pattern rules tùy chỉnh ───────────────────────────────────────────────
  // Mảng { match: RegExp|string, command: string, delayMs?: [min,max] }
  // "command" hỗ trợ {1}, {2}... = capture group từ regex
  customRules: [
    // VD server yêu cầu gõ /xacminh
    // { match: /xác minh danh tính/i, command: '/xacminh', delayMs: [1000, 2000] },
    // VD server bắt nhập mã OTP từ chat: "Mã xác nhận: 4829"
    // { match: /Mã xác nhận[:\s]+(\d+)/i, command: '/otp {1}', delayMs: [500, 1000] },
  ],

  // ── Connection-level anti-bot block ──────────────────────────────────────
  // Server block kết nối ngay khi login (trước khi vào game).
  // Detect qua kick message, tự tính delay reconnect dài hơn để thoát cooldown.
  connectionBlock: {
    enabled: true,
    // Patterns của kick message báo bị block bởi anti-bot
    kickPatterns: [
      /ch[oặ]ng\s*bot/i,
      /anti[\s\-_]?bot/i,
      /b[iị]\s*ch[aặ]n/i,
      /t[aạ]m\s*th[oờ]i\s*b[iị]\s*ch[aặ]n/i,
      /temporarily\s*blocked/i,
      /blocked.*bot/i,
      /bot.*block/i,
      /connection.*blocked/i,
    ],
    // Delay reconnect khi bị block (ms). Random giữa min và max.
    // Server thông báo "thử lại sau 10 phút" → dùng 10-12 phút + jitter
    reconnectDelayMs: [600000, 720000],   // 10–12 phút
    // Nếu muốn ngắn hơn để test: [30000, 60000]
    // Log thông báo đặc biệt khi detect
    logOnDetect: true,
  },

  // ── Cooldown chung (ms) ───────────────────────────────────────────────────
  globalCooldownMs: 3000,
};

// ─── helper ───────────────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Giải phép tính cơ bản từ string.
 * Hỗ trợ: +, -, *, /, %, ^ (lũy thừa), dấu ngoặc.
 * Trả về số nguyên hoặc null nếu parse lỗi.
 */
function solveMath(expr) {
  try {
    // Sanitize: chỉ cho phép số, toán tử, dấu cách, ngoặc
    const clean = expr
      .replace(/[^0-9+\-*/^%().\s]/g, '')
      .replace(/\^/g, '**')   // ^ → ** (JS exponentiation)
      .trim();
    if (!clean || clean.length > 80) return null;
    // eslint-disable-next-line no-new-func
    const result = Function('"use strict"; return (' + clean + ')')();
    if (typeof result !== 'number' || !isFinite(result)) return null;
    // Trả về số nguyên nếu không có phần thập phân đáng kể
    return Math.abs(result - Math.round(result)) < 1e-9 ? Math.round(result) : result;
  } catch (e) {
    return null;
  }
}

// ─── class ────────────────────────────────────────────────────────────────────

class SessionVerifier {
  /**
   * @param {object} session  — BotSession instance
   * @param {object} userCfg  — cfg.sessionCheck từ config.json
   */
  constructor(session, userCfg = {}) {
    this._session = session;
    this._cfg = this._merge(DEFAULTS, userCfg);
    this._lastTrigger = 0;      // timestamp lần verify cuối
    this._mathAttempts = 0;
    this._processing = false;    // đang trong luồng verify
    this._active = true;
    this._pendingReconnectDelay = 0;  // override delay cho lần reconnect kế tiếp (ms)
  }

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Gọi từ message handler của BotSession.
   * @returns {boolean} true nếu đã xử lý (caller nên return sớm)
   */
  onMessage(text, pos) {
    if (!this._cfg.enabled || !this._active) return false;
    try {
      // Math captcha
      if (this._cfg.mathCaptcha.enabled && this._tryMathCaptcha(text)) return true;
      // Move verify
      if (this._cfg.moveVerify.enabled && this._tryMoveVerify(text)) return true;
      // Custom pattern rules
      if (this._tryCustomRules(text)) return true;
    } catch (e) {
      dbg('SessionVerifier', e);
    }
    return false;
  }

  /**
   * Gọi từ windowOpen handler.
   * @returns {boolean} true nếu module đã nhận xử lý GUI này
   */
  onWindowOpen(win) {
    if (!this._cfg.enabled || !this._active) return false;
    if (!this._cfg.clickCaptcha.enabled) return false;
    try {
      return this._tryClickCaptcha(win);
    } catch (e) {
      dbg('SessionVerifier', e);
      return false;
    }
  }

  /**
   * Gọi từ kicked handler của BotSession.
   * Detect connection-level anti-bot block và set delay reconnect dài hơn.
   * @param {string} kickMsg  — text của kick reason (đã strip màu)
   * @returns {boolean} true nếu là anti-bot kick
   */
  onKick(kickMsg) {
    if (!this._cfg.enabled || !this._active) return false;
    const cbCfg = this._cfg.connectionBlock;
    if (!cbCfg?.enabled) return false;
    const msg = String(kickMsg);
    const matched = cbCfg.kickPatterns.some(p => msg.match(p));
    if (!matched) return false;
    const delay = rand(cbCfg.reconnectDelayMs[0], cbCfg.reconnectDelayMs[1]);
    this._pendingReconnectDelay = delay;
    if (cbCfg.logOnDetect) {
      this._log('warn',
        `SessionCheck: phát hiện connection-level block ("${msg.substring(0, 80)}") — ` +
        `delay reconnect ${(delay / 60000).toFixed(1)} phút để thoát cooldown server`
      );
    }
    return true;
  }

  /**
   * BotSession gọi method này trong scheduleReconnect để lấy override delay.
   * Trả về delay ms nếu có, 0 nếu không.
   * Tự reset sau khi đọc (one-shot).
   */
  getPendingReconnectDelay() {
    const d = this._pendingReconnectDelay;
    this._pendingReconnectDelay = 0;
    return d;
  }

  /** Reset state khi bot ngắt kết nối / reconnect */
  reset() {
    this._mathAttempts = 0;
    this._processing = false;
    this._lastTrigger = 0;
    // _pendingReconnectDelay KHÔNG reset ở đây — scheduleReconnect cần đọc nó SAU cleanup
  }

  /** Tắt/bật verify trong runtime */
  setEnabled(v) {
    this._active = !!v;
    this._log('sys', `SessionCheck verify: ${this._active ? 'BẬT' : 'TẮT'}`);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  _tryMathCaptcha(text) {
    const mcfg = this._cfg.mathCaptcha;
    if (this._mathAttempts >= mcfg.maxAttempts) return false;
    if (!this._cooldownOk()) return false;

    for (const p of mcfg.patterns) {
      const m = text.match(p.regex);
      if (!m) continue;
      const expr = m[p.captureGroup || 1];
      if (!expr) continue;
      const answer = solveMath(expr);
      if (answer === null) {
        this._log('warn', `SessionCheck: nhận captcha toán học nhưng không giải được: "${expr}"`);
        return false;
      }
      this._mathAttempts++;
      this._markTrigger();
      const cmd = mcfg.answerCommand.replace('{answer}', answer);
      this._log('ok', `SessionCheck math captcha: "${expr}" = ${answer} → gửi: ${cmd}`);
      this._sendDelayed(cmd, mcfg.delayMs);
      return true;
    }
    return false;
  }

  _tryMoveVerify(text) {
    const mcfg = this._cfg.moveVerify;
    if (!this._cooldownOk()) return false;

    for (const p of mcfg.patterns) {
      if (!text.match(p)) continue;
      this._markTrigger();
      this._log('ok', `SessionCheck move verify triggered: "${text.substring(0, 60)}"`);
      this._doMoveSequence(mcfg).catch(e => dbg('SessionVerifier.move', e));
      return true;
    }
    return false;
  }

  async _doMoveSequence(mcfg) {
    const mc = this._session.mc;
    if (!mc) return;
    const delay = rand(mcfg.delayMs[0], mcfg.delayMs[1]);
    await sleep(delay);
    for (const move of mcfg.moveSequence) {
      if (!this._session.isOnline) break;
      try {
        if (move === 'jump') {
          mc.setControlState('jump', true);
          await sleep(mcfg.stepDelayMs);
          mc.setControlState('jump', false);
        } else if (move === 'sneak') {
          mc.setControlState('sneak', true);
          await sleep(mcfg.stepDelayMs * 2);
          mc.setControlState('sneak', false);
        } else {
          mc.setControlState(move, true);
          await sleep(mcfg.stepDelayMs);
          mc.setControlState(move, false);
        }
        await sleep(100);
      } catch (e) {
        dbg('SessionVerifier.move', e);
      }
    }
    this._log('ok', 'SessionCheck move sequence done');
  }

  _tryClickCaptcha(win) {
    const ccfg = this._cfg.clickCaptcha;
    if (!this._cooldownOk()) return false;

    // Kiểm tra tiêu đề GUI
    const { resolveText } = require('./utils');
    const title = resolveText(win.title || '').toLowerCase();
    const matched = ccfg.titlePatterns.some(p => title.match(p));
    if (!matched) return false;

    this._markTrigger();
    this._log('ok', `SessionCheck click captcha GUI: "${title.substring(0, 50)}"`);
    this._doClickCaptcha(win, ccfg).catch(e => dbg('SessionVerifier.click', e));
    return true;
  }

  async _doClickCaptcha(win, ccfg) {
    const mc = this._session.mc;
    if (!mc) return;
    const delay = rand(ccfg.delayMs[0], ccfg.delayMs[1]);
    await sleep(delay);
    if (!this._session.isOnline || !mc.currentWindow) return;

    const slots = mc.currentWindow.slots || [];
    let targetSlot = -1;

    // Tìm slot khớp target pattern (tên item)
    for (let i = 0; i < slots.length; i++) {
      const item = slots[i];
      if (!item || item.type === 0 || item.type === -1) continue;
      const name = (item.displayName || item.name || '').toLowerCase();
      const matched = ccfg.targetItemPatterns.some(p => name.match(p));
      if (matched) { targetSlot = i; break; }
    }

    // Fallback: click item đầu tiên không phải air
    if (targetSlot === -1) {
      for (let i = 0; i < slots.length; i++) {
        const item = slots[i];
        if (item && item.type > 0) { targetSlot = i; break; }
      }
    }

    if (targetSlot === -1) {
      this._log('warn', 'SessionCheck click captcha: không tìm được slot để click');
      return;
    }

    try {
      await mc.clickWindow(targetSlot, 0, 0);
      this._log('ok', `SessionCheck click captcha: đã click slot ${targetSlot}`);
    } catch (e) {
      this._log('warn', `SessionCheck click captcha: lỗi click slot ${targetSlot}: ${e.message}`);
    }
  }

  _tryCustomRules(text) {
    for (const rule of this._cfg.customRules) {
      const pattern = rule.match instanceof RegExp ? rule.match : new RegExp(rule.match, 'i');
      const m = text.match(pattern);
      if (!m) continue;
      if (!this._cooldownOk()) return false;
      this._markTrigger();

      let cmd = rule.command;
      // Thay {1}, {2}, ... bằng capture group
      for (let i = 1; i < m.length; i++) {
        cmd = cmd.replace(new RegExp(`\\{${i}\\}`, 'g'), m[i] || '');
      }
      const delay = rule.delayMs || [500, 1500];
      this._log('ok', `SessionCheck custom rule match: "${text.substring(0, 60)}" → ${cmd}`);
      this._sendDelayed(cmd, delay);
      return true;
    }
    return false;
  }

  // ── utils ──────────────────────────────────────────────────────────────────

  _cooldownOk() {
    return (Date.now() - this._lastTrigger) >= this._cfg.globalCooldownMs;
  }

  _markTrigger() {
    this._lastTrigger = Date.now();
  }

  _sendDelayed(cmd, delayRange) {
    const ms = Array.isArray(delayRange)
      ? rand(delayRange[0], delayRange[1])
      : (delayRange || 500);
    setTimeout(() => {
      try {
        if (this._session.isOnline && this._session.mc) {
          this._session.mc.chat(cmd);
        }
      } catch (e) {
        this._log('warn', `SessionCheck: lỗi gửi "${cmd}": ${e.message}`);
      }
    }, ms);
  }

  _log(level, msg) {
    try { this._session.log(level, msg); } catch (e) { /* session dead */ }
  }

  // ── deep merge config ──────────────────────────────────────────────────────

  _merge(defaults, override) {
    const out = { ...defaults };
    for (const k of Object.keys(override)) {
      if (
        override[k] !== null &&
        typeof override[k] === 'object' &&
        !Array.isArray(override[k]) &&
        typeof defaults[k] === 'object' &&
        !Array.isArray(defaults[k])
      ) {
        out[k] = this._merge(defaults[k], override[k]);
      } else {
        out[k] = override[k];
      }
    }
    return out;
  }
}

module.exports = SessionVerifier;
