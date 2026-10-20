'use strict';
/**
 * ReconnectHandler — tách logic reconnect / rate-limit / cooldown / force / proxy-fallback từ BotSession.
 * Nhận session (BotSession) để truy cập state, log, timer, cleanup, sessionVerifier.
 */
const { CS, TIMING } = require('./constants');
const { nowMs, jit } = require('./utils');
const { dbg } = require('./debug');

class ReconnectHandler {
  /**
   * @param {import('./BotSession')} session
   */
  constructor(session) {
    this.s = session;
  }

  schedule(reason) {
    const s = this.s;
    if (s._shouldNotRun) return;
    if (s._reconnectScheduled) return;
    if (s.isReconnecting) return;
    const now = nowMs();
    const sinceLast = now - s._lastReconnectTime;
    const cooldownMs = s._wasKicked ? TIMING.RECONNECT_COOLDOWN_KICK_MS : TIMING.RECONNECT_COOLDOWN_MS;
    s._wasKicked = false;
    if (s._lastReconnectTime > 0 && sinceLast < cooldownMs) {
      const waitMs = cooldownMs - sinceLast;
      s.log('warn', `Reconnect bị chặn (cooldown ${Math.ceil(waitMs / 1000)}s)${reason ? ' — ' + reason : ''}`);
      s._setTimer('reconnect_cooldown', () => this.schedule(reason), waitMs + 500);
      return;
    }
    const windowStart = now - TIMING.RECONNECT_WINDOW_MS;
    s._reconnectTimestamps = s._reconnectTimestamps.filter(t => t > windowStart);
    if (s._reconnectTimestamps.length >= TIMING.RECONNECT_MAX_IN_WINDOW) {
      s._reconnectScheduled = true;
      s.log('err', `Quá ${TIMING.RECONNECT_MAX_IN_WINDOW} lần reconnect trong ${TIMING.RECONNECT_WINDOW_MS / 60000}ph — tạm dừng 5 phút`);
      s._setState(CS.DISCONNECTED);
      s._setTimer('reconnect_rate_limited', () => {
        if (s._disabled) return;
        s._reconnectTimestamps = [];
        s._lastReconnectTime = 0;
        s.log('warn', 'Hết thời gian chờ rate-limit, thử lại...');
        s._reconnectScheduled = false;
        s.start();
      }, 5 * 60 * 1000);
      return;
    }
    if (s._manager && s._manager._activeConnects >= TIMING.MAX_CONCURRENT_CONNECTS) {
      s._setTimer('reconnect_queued', () => this.schedule(reason), 3000);
      return; // chưa kết nối thật -> không tính vào cooldown/rate-limit
    }
    s._reconnectTimestamps.push(now);
    s._lastReconnectTime = now;
    s._reconnectScheduled = true;
    s._setState(CS.RECONNECTING);
    const spawnAge = s._spawnTime > 0 ? nowMs() - s._spawnTime : Infinity;
    const savedFastKicks = s._fastKicks;
    s._cleanupOnDisconnect();
    s._destroyMc();
    if (s.state.reconnects >= s._reconnectMaxRetries) {
      s.log('err', `Đã đạt giới hạn ${s._reconnectMaxRetries} reconnect — thử lại sau 15 phút`);
      s._flushKickNotify(null);
      s._notify('reconnectFailed', `🔴 ${s.cfg.id}: hết lượt reconnect`,
        `Đã thử ${s._reconnectMaxRetries} lần không thành công${reason ? ` (lý do gần nhất: ${reason})` : ''}. Sẽ tự thử lại sau 15 phút.`, 0xef4444, '🔴 BOT HẾT LƯỢT RECONNECT');
      s._setState(CS.DISCONNECTED);
      s._reconnectScheduled = false;
      s._setTimer('reconnect_longwait', () => {
        if (s._disabled) return;
        s.log('warn', 'Thử kết nối lại sau giới hạn reconnect...');
        s.state.reconnects = 0;
        s._fastKicks = 0;
        s._reconnectScheduled = false;
        s.start();
      }, 15 * 60 * 1000);
      return;
    }
    const fastKick = spawnAge < 10000;
    if (fastKick) {
      s._fastKicks = savedFastKicks + 1;
    } else {
      s._fastKicks = 0;
    }
    const retries = Math.min(s.state.reconnects, 12);
    const expBackoff = Math.min(
      s._reconnectBaseDelay * Math.pow(2, retries),
      s._reconnectMaxDelay
    );
    const extraDelay = fastKick ? Math.min(s._fastKicks * TIMING.FAST_KICK_EXTRA_MS, TIMING.FAST_KICK_EXTRA_MAX) : 0;
    const base = expBackoff + extraDelay;
    // SessionCheck: nếu bị block connection-level, override delay tối thiểu
    const antiBotDelay = s.sessionVerifier.getPendingReconnectDelay();
    const delay = antiBotDelay > 0
      ? antiBotDelay
      : (s._reconnectJitter ? jit(base, Math.round(base * 0.3)) : base);
    s.state.reconnects++;
    const maxRetryStr = s._reconnectMaxRetries >= 999 ? '∞' : String(s._reconnectMaxRetries);
    s._flushKickNotify({ delay, attempt: s.state.reconnects, max: maxRetryStr });
    s.log('warn', `Mất kết nối${reason ? ' (' + reason + ')' : ''}${fastKick ? ' [FAST KICK x' + s._fastKicks + ']' : ''} — thử lại lần ${s.state.reconnects}/${maxRetryStr} sau ${(delay / 1000).toFixed(1)}s (backoff)`);
    s.emit('disconnectReason', { id: s.cfg.id, reason, fastKick, retry: s.state.reconnects });
    s._emitIO('disconnectReason', { id: s.cfg.id, reason, fastKick, retry: s.state.reconnects });
    s._setTimer('reconnect', () => {
      s._reconnectScheduled = false;
      if (s._shouldNotRun) return;
      s.start();
    }, delay);
  }

  cancel() {
    const s = this.s;
    s._clearTimer('reconnect');
    s._clearTimer('reconnect_longwait');
    s._clearTimer('reconnect_queued');
    s._clearTimer('reconnect_cooldown');
    s._clearTimer('reconnect_rate_limited');
    s._clearTimer('start_queued');
    s._reconnectScheduled = false;
    s._reconnectTimestamps = [];
    s._lastReconnectTime = 0;
    if (s.isReconnecting) s._setState(CS.DISCONNECTED);
  }

  force() {
    const s = this.s;
    s.log('sys', 'Force reconnect...');
    this.cancel();
    s._onConnectComplete();
    s.state.reconnects = 0;
    s._fastKicks = 0;
    s._setState(CS.DISCONNECTED);
    s._cleanupOnDisconnect();
    s._destroyMc();
    s._lastReconnectTime = nowMs();
    s._reconnectScheduled = true;
    s._setTimer('reconnect', () => {
      s._reconnectScheduled = false;
      s.start();
    }, 500);
  }

  disableProxyFallback() {
    const s = this.s;
    if (s._proxyDisabledByFallback) return;
    s._proxyDisabledByFallback = true;
    s.proxy = null;
    s.cfg.useProxy = false;
    if (s._manager?.dashboard?._syncBotToConfig) {
      s._manager.dashboard._syncBotToConfig(s);
    }
    s.log('warn', `⚠️ Proxy đã bị tắt tự động sau ${TIMING.PROXY_FAIL_THRESHOLD} lần fail liên tiếp — chuyển sang kết nối thẳng`);
    s.emit('proxyFallback', { id: s.cfg.id });
    s._emitIO('proxyFallback', { id: s.cfg.id });
  }
}

module.exports = ReconnectHandler;
