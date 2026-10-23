'use strict';
/**
 * TelegramControl.js — Lõi xử lý lệnh và nút bấm điều khiển bot qua Telegram (Section 9, 10, Appendix C & D).
 *
 *  - Hàm thuần / điều phối tách biệt khỏi I/O mạng của TelegramNotifier.
 *  - Kiểm tra quyền (viewer / admin), nhóm chưa cấu hình admin -> từ chối mọi lệnh điều khiển.
 *  - Giới hạn tốc độ 5 lệnh / 10s / người; từ chối 5 lần / 60s -> khoá 10 phút.
 *  - Xác nhận hành động nguy hiểm bằng token ngẫu nhiên 12 hex, dùng 1 lần, hết hạn sau 30s, gắn chặt với userId + chatId.
 *  - Chặn danh sách đen cho /cmd và /cmdall (login, register, changepassword, pay...).
 */
const crypto = require('crypto');
const { sym, ruleLine } = require('./Symbols');
const { sanitizeExternal, escapeHtml, truncateCodePoints } = require('./TextSafe');
const { describeActivity } = require('./BotActivity');
const {
  buildPanel,
  buildStatusList,
  buildBotsPage,
  buildBotMenu,
  buildTelegramHelpText,
  fmtClock,
  fmtDuration,
  fmtMoney,
  botShortId,
  macroShortId,
  resolveByShortId,
} = require('./TelegramPanel');
const { EVENT_CATALOG } = require('./NotificationCenter');
const { DEFAULT_CMD_DENYLIST, DEFAULT_CRIT_EVENTS } = require('./ConfigValidator');
const { CS } = require('./constants');
const TelegramLogger = require('./TelegramLogger');

const CONFIRM_TTL_MS = 30000;
const RATE_WINDOW_MS = 10000;
const RATE_MAX_CMDS = 5;
const DENY_WINDOW_MS = 60000;
const DENY_MAX_COUNT = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

const VIEW_COMMANDS = new Set([
  'start', 'help', 'status', 'bots', 'bot', 'panel',
  'activity', 'inv', 'pos', 'board', 'ping', 'logs', 'log', 'whoami',
]);

const VIEW_BUTTON_ACTS = new Set([
  'r', 'm', 'bp', 'iv', 'ps', 'bd', 'ac',
]);

function foldVi(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

/**
 * Tìm bot theo tên chính xác -> số thứ tự 1-based -> tiền tố duy nhất (không phân biệt hoa/thường & dấu).
 */
function resolveBot(bots = [], token = '', allowAll = false) {
  const raw = String(token ?? '').trim();
  const safeTok = sanitizeExternal(raw, { max: 40 });
  if (!raw) {
    return { status: 'INVALID_ARG', bot: null, text: 'Thiếu tên hoặc số thứ tự bot. Dùng /bots.' };
  }
  if (allowAll && raw.toLowerCase() === 'all') {
    return { status: 'ALL', bot: null, bots: [...bots] };
  }
  if (!Array.isArray(bots) || !bots.length) {
    return { status: 'NOT_FOUND', bot: null, text: `Không có bot "${safeTok}". Dùng /bots.` };
  }

  // 1. Khớp tên chính xác (không phân biệt hoa/thường)
  const lower = raw.toLowerCase();
  const exact = bots.find(b => String(b.cfg?.id || '').toLowerCase() === lower);
  if (exact) return { status: 'OK', bot: exact };

  // 2. Khớp mã ngắn 5 ký tự (shortId)
  const allIds = bots.map(b => String(b.cfg?.id || ''));
  const byShort = bots.find(b => botShortId(b.cfg?.id, allIds) === lower);
  if (byShort) return { status: 'OK', bot: byShort };

  // 3. Số thứ tự 1-based (theo thứ tự /bots)
  if (/^\d+$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < bots.length) {
      return { status: 'OK', bot: bots[idx] };
    }
  }

  // 4. Tiền tố không phân biệt dấu
  const folded = foldVi(raw);
  if (folded) {
    const matches = bots.filter(b => foldVi(b.cfg?.id).startsWith(folded));
    if (matches.length === 1) return { status: 'OK', bot: matches[0] };
    if (matches.length > 1) {
      const names = matches.map(b => sanitizeExternal(b.cfg?.id, { max: 30 }));
      return {
        status: 'AMBIGUOUS',
        bot: null,
        matches,
        text: `"${safeTok}" khớp: ${names.join(', ')}. Gõ rõ hơn hoặc dùng số thứ tự.`,
      };
    }
  }

  return { status: 'NOT_FOUND', bot: null, text: `Không có bot "${safeTok}". Dùng /bots.` };
}

function parseDurationSec(text) {
  const src = String(text || '').trim().toLowerCase();
  if (!src) return null;
  if (/^\d+$/.test(src)) return Number(src);
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/g;
  let totalSec = 0;
  let hit = false;
  for (const m of src.matchAll(re)) {
    hit = true;
    const val = parseFloat(m[1]);
    const unit = m[2][0];
    if (unit === 'h') totalSec += val * 3600;
    else if (unit === 'm') totalSec += val * 60;
    else totalSec += val;
  }
  if (!hit) return null;
  if (/\d/.test(src.replace(re, ''))) return null;
  return Math.round(totalSec);
}

function secToHmsObj(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const hour = Math.floor(sec / 3600);
  const minute = Math.floor((sec % 3600) / 60);
  const second = sec % 60;
  return { hour, minute, second };
}

function isCredentialLikeCmd(cmdText, denylist = DEFAULT_CMD_DENYLIST) {
  const trimmed = String(cmdText || '').trim().replace(/^\/+/, '');
  const first = (trimmed.split(/\s+/)[0] || '').toLowerCase();
  const denySet = new Set((denylist || DEFAULT_CMD_DENYLIST).map(x => String(x).replace(/^\/+/, '').toLowerCase()));
  if (denySet.has(first)) return true;
  if (/^(dn|dk|login|register|log|reg|l|changepassword|cp|unregister|pay)$/i.test(first)) return true;
  return false;
}

function maskCommandForLog(cmdText, denylist = DEFAULT_CMD_DENYLIST) {
  const trimmed = String(cmdText || '').trim();
  if (!trimmed) return '';
  if (isCredentialLikeCmd(trimmed, denylist)) {
    const first = trimmed.split(/\s+/)[0];
    return `${first} ***`;
  }
  return trimmed;
}

function describeOfflineReason(bot, actionVerb = 'thực hiện lệnh') {
  const id = sanitizeExternal(bot.cfg?.id || 'bot', { max: 40 });
  const st = bot.state?.connState || CS.DISCONNECTED;
  if (bot._disabled || st === CS.STOPPING) {
    return `${id} đang dừng, chưa thể ${actionVerb}.`;
  }
  if (st === CS.RECONNECTING) {
    const k = bot.state?.reconnects || 1;
    return `${id} đang kết nối lại (lần ${k}), chưa thể ${actionVerb}.`;
  }
  if (st === CS.CONNECTING || st === CS.AUTHENTICATING || st === CS.SPAWNING) {
    return `${id} đang vào server (${st}), chưa thể ${actionVerb}.`;
  }
  return `${id} đang mất kết nối, chưa thể ${actionVerb}.`;
}

function describeBusyReason(bot) {
  const id = sanitizeExternal(bot.cfg?.id || 'bot', { max: 40 });
  const act = describeActivity(bot);
  return `${id} đang ${act.text.toLowerCase()}, lệnh không chen ngang.`;
}

function formatCallerSuffix(ev) {
  const chatType = ev?.chat?.type;
  if (chatType !== 'group' && chatType !== 'supergroup') return '';
  const from = ev?.from;
  if (!from) return '';
  const rawName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id || '');
  const clean = sanitizeExternal(rawName, { max: 32 });
  return clean ? ` (${escapeHtml(clean)})` : '';
}

const RESULT_CODES = Object.freeze({
  OK: 'OK',
  NOOP: 'NOOP',
  NOT_FOUND: 'NOT_FOUND',
  AMBIGUOUS: 'AMBIGUOUS',
  OFFLINE: 'OFFLINE',
  BUSY: 'BUSY',
  DENIED: 'DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_ARG: 'INVALID_ARG',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
});

class TelegramControl {
  constructor(managerOrOpts, opts = {}) {
    if (managerOrOpts && managerOrOpts.manager && !Array.isArray(managerOrOpts.bots)) {
      this.mgr = managerOrOpts.manager;
      opts = managerOrOpts;
    } else {
      this.mgr = managerOrOpts;
    }
    this._now = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();
    this._rateMap = new Map();     // userId -> number[]
    this._denyMap = new Map();     // userId -> { times: number[], lockedUntil: number, loggedLock: boolean }
    this._confirmMap = new Map();  // token -> { token, fromId, chatId, createdAt, expiresAt, summary, execute }
    this._groupEmptyAdminWarned = false;
  }

  resolveBot(token, allowAll = false) {
    const r = resolveBot(this.mgr?.bots || [], token, allowAll);
    return { ...r, code: r.status };
  }

  resetSecurityState() {
    this._rateMap.clear();
    this._denyMap.clear();
    this._confirmMap.clear();
  }

  _config() {
    return this.mgr?._config || {};
  }

  _tz() {
    return this._config().telegramTimezone || this.mgr?._scheduleTz?.() || 'Asia/Ho_Chi_Minh';
  }

  _purgeState(now = this._now()) {
    for (const [uid, times] of this._rateMap) {
      const kept = times.filter(t => now - t < RATE_WINDOW_MS);
      if (kept.length) this._rateMap.set(uid, kept);
      else this._rateMap.delete(uid);
    }
    for (const [uid, rec] of this._denyMap) {
      rec.times = rec.times.filter(t => now - t < DENY_WINDOW_MS);
      if (!rec.times.length && now >= rec.lockedUntil) this._denyMap.delete(uid);
    }
    for (const [tok, item] of this._confirmMap) {
      if (now > item.expiresAt) this._confirmMap.delete(tok);
    }
  }

  /**
   * Kiểm tra quyền của người gọi: 'anyone' | 'viewer' | 'admin'
   */
  resolveRole(ev) {
    const cfg = this._config();
    const chatId = String(ev?.chat?.id ?? this.mgr?.telegram?.chatId ?? '');
    const from = ev?.from;
    if (!from || from.id === undefined || from.id === null) {
      // Cho phép các test nội bộ cũ gọi trực tiếp _onTelegramEvent mà không truyền `from`
      return { role: 'admin', fromId: 'local', isGroup: false };
    }
    const fromId = String(from.id);
    const chatType = ev?.chat?.type || (chatId.startsWith('-') ? 'group' : 'private');
    const isGroup = chatType === 'group' || chatType === 'supergroup';
    const isPrivate = !isGroup && fromId === chatId;

    const admins = new Set((cfg.telegramAdmins || []).map(String));
    const viewers = new Set((cfg.telegramAllowedUsers || []).map(String));

    if (isGroup && admins.size === 0 && !this._groupEmptyAdminWarned) {
      this._groupEmptyAdminWarned = true;
      const warnMsg = 'Cảnh báo Telegram: đang ở nhóm chat nhưng telegramAdmins đang trống — mọi lệnh điều khiển đều bị từ chối. Dùng /whoami rồi chạy: telegram users add admin <id>';
      this.mgr?.runtimeLog?.('warn', warnMsg);
      if (this.mgr?.telegram?.onWarn) {
        try { this.mgr.telegram.onWarn(warnMsg); } catch { /* ignore */ }
      }
    }

    const isAdmin = admins.has(fromId) || (isPrivate && fromId === chatId);
    const isViewer = isAdmin || viewers.has(fromId) || viewers.size === 0;
    const role = isAdmin ? 'admin' : (isViewer ? 'viewer' : 'none');
    return { role, fromId, isGroup };
  }

  _recordDenied(fromId, reasonLog, now = this._now()) {
    this.mgr?.runtimeLog?.('warn', reasonLog);
    if (!fromId || fromId === 'local') return;
    let rec = this._denyMap.get(fromId);
    if (!rec) {
      rec = { times: [], lockedUntil: 0, loggedLock: false };
      this._denyMap.set(fromId, rec);
    }
    rec.times = rec.times.filter(t => now - t < DENY_WINDOW_MS);
    rec.times.push(now);
    if (rec.times.length >= DENY_MAX_COUNT) {
      rec.lockedUntil = now + LOCKOUT_MS;
      if (!rec.loggedLock) {
        rec.loggedLock = true;
        this.mgr?.runtimeLog?.('warn', `Telegram: khoá tạm 10 phút user ${fromId} vì bị từ chối ${rec.times.length} lần trong 60s`);
      }
    }
  }

  _isLockedOut(fromId, now = this._now()) {
    if (!fromId || fromId === 'local') return false;
    const rec = this._denyMap.get(fromId);
    if (!rec) return false;
    if (now < rec.lockedUntil) return true;
    rec.loggedLock = false;
    return false;
  }

  _checkRateLimit(fromId, now = this._now()) {
    if (!fromId || fromId === 'local') return { ok: true, waitSec: 0 };
    const times = (this._rateMap.get(fromId) || []).filter(t => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX_CMDS) {
      const waitMs = Math.max(1000, times[0] + RATE_WINDOW_MS - now);
      return { ok: false, waitSec: Math.ceil(waitMs / 1000) };
    }
    times.push(now);
    this._rateMap.set(fromId, times);
    return { ok: true, waitSec: 0 };
  }

  _audit(ev, role, actionDesc, targetBot = '') {
    const from = ev?.from;
    const userLabel = from
      ? sanitizeExternal(from.username ? `@${from.username} (${from.id})` : `${from.first_name || ''} (${from.id})`.trim(), { max: 48 })
      : 'operator';
    const rawLine = `Telegram: ${userLabel} [${role}] → ${actionDesc}${targetBot ? ' ' + targetBot : ''}`;
    const cleanLine = this.mgr?.telegramLogs ? this.mgr.telegramLogs._redact(rawLine) : rawLine;
    this.mgr?.runtimeLog?.('sys', cleanLine);
  }

  _createConfirmation(ev, summaryText, executeFn, now = this._now()) {
    this._purgeState(now);
    const token = crypto.randomBytes(6).toString('hex');
    const fromId = String(ev?.from?.id ?? 'local');
    const chatId = String(ev?.chat?.id ?? this.mgr?.telegram?.chatId ?? '');
    this._confirmMap.set(token, {
      token,
      fromId,
      chatId,
      createdAt: now,
      expiresAt: now + CONFIRM_TTL_MS,
      summary: summaryText,
      execute: executeFn,
    });
    const text = [
      `${sym('warn')} <b>Xác nhận hành động nguy hiểm</b>`,
      summaryText,
    ].join('\n');
    const keyboard = [[
      { text: `${sym('ok')} Xác nhận (30s)`, callback_data: `c:${token}:y` },
      { text: `${sym('fail')} Huỷ`, callback_data: `c:${token}:n` },
    ]];
    return {
      code: 'CONFIRM_REQUIRED',
      token,
      confirm: { token, summary: summaryText },
      text,
      keyboard,
    };
  }

  /**
   * Điểm vào chính cho cả command (/...) và button callback_query.
   * Trả về { code, text?, keyboard?, editMessage?, callbackText?, refresh?: string[], silentIgnore?: boolean }
   */
  async handleEvent(ev) {
    if (!ev) return { code: 'INVALID_ARG', silentIgnore: true };
    const now = ev.now !== undefined ? Number(ev.now) : this._now();
    this._purgeState(now);

    // Chặn tin sửa, bài kênh, sender_chat ẩn danh, tin từ bot hoặc sai chatId
    if (ev.isEdited || ev.isChannelPost || ev.senderChat || ev.from?.is_bot) {
      return { code: 'DENIED', silentIgnore: true };
    }
    const expectedChatId = this.mgr?.telegram?.chatId || this._config().telegramChatId;
    if (expectedChatId && ev.chat?.id !== undefined && String(ev.chat.id) !== String(expectedChatId)) {
      return { code: 'DENIED', silentIgnore: true };
    }

    // Chuẩn hoá rawText / data nếu gọi trực tiếp trong test
    let normEv = ev;
    if (ev.type === 'command' && !ev.cmd && typeof ev.rawText === 'string') {
      const m = /^\/([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(ev.rawText.trim());
      if (!m) return { code: 'INVALID_ARG', silentIgnore: true };
      const targetBotUser = m[2];
      const ownBotUser = this.mgr?.telegram?.botUsername;
      if (targetBotUser && ownBotUser && targetBotUser.toLowerCase() !== ownBotUser.toLowerCase()) {
        return { code: 'DENIED', silentIgnore: true };
      }
      normEv = { ...ev, cmd: m[1].toLowerCase(), arg: (m[3] || '').trim() };
    } else if (ev.type === 'button' && !ev.cmd && typeof ev.data === 'string') {
      const i = ev.data.indexOf(':');
      normEv = {
        ...ev,
        cmd: i < 0 ? ev.data : ev.data.slice(0, i),
        arg: i < 0 ? '' : ev.data.slice(i + 1),
      };
    }

    const { role, fromId } = this.resolveRole(normEv);

    if (this._isLockedOut(fromId, now)) {
      return { code: 'DENIED', silentIgnore: true };
    }

    if (normEv.type === 'button') {
      return this._handleButton(normEv, role, fromId, now);
    }
    if (normEv.type === 'command') {
      return this._handleCommand(normEv, role, fromId, now);
    }
    return { code: 'INVALID_ARG', silentIgnore: true };
  }

  async _handleCommand(ev, role, fromId, now) {
    const cmd = String(ev.cmd || '').toLowerCase();
    const arg = String(ev.arg || '').trim();
    const parts = arg ? arg.split(/\s+/).filter(Boolean) : [];
    const cfg = this._config();

    // /whoami cho phép mọi người trong đúng chatId
    if (cmd === 'whoami') {
      const rl = this._checkRateLimit(fromId, now);
      if (!rl.ok) return { code: 'RATE_LIMITED', text: `${sym('warn')} Quá nhanh, thử lại sau ${rl.waitSec}s.` };
      const uid = ev.from?.id ?? 'không rõ';
      const cid = ev.chat?.id ?? this.mgr?.telegram?.chatId ?? 'không rõ';
      const uName = sanitizeExternal([ev.from?.first_name, ev.from?.last_name].filter(Boolean).join(' ') || ev.from?.username || '—', { max: 40 });
      return {
        code: 'OK',
        text: [
          `${sym('info')} <b>Thông tin định danh Telegram</b>`,
          `Người dùng: <b>${escapeHtml(uName)}</b>`,
          `User ID: <code>${escapeHtml(String(uid))}</code>`,
          `Chat ID: <code>${escapeHtml(String(cid))}</code>`,
          `Quyền hiện tại: <b>${escapeHtml(role)}</b>`,
        ].join('\n'),
      };
    }

    const isView = VIEW_COMMANDS.has(cmd)
      || (cmd === 'sell' && String(parts[1] || '').toLowerCase() === 'status')
      || (cmd === 'protect' && String(parts[1] || '').toLowerCase() === 'status');

    const neededRole = isView ? 'viewer' : 'admin';

    if (neededRole === 'viewer' && role === 'none') {
      this._recordDenied(fromId, `Telegram: từ chối quyền xem /${cmd} từ user ${fromId}`, now);
      return { code: 'DENIED', text: 'Không có quyền.' };
    }
    if (neededRole === 'admin') {
      if (role !== 'admin') {
        this._recordDenied(fromId, `Telegram: từ chối quyền admin /${cmd} từ user ${fromId} (role=${role})`, now);
        return { code: 'DENIED', text: 'Không có quyền.' };
      }
      if (cfg.telegramControlEnabled === false) {
        return { code: 'DENIED', text: `${sym('warn')} Điều khiển qua Telegram đang TẮT. Bật tại console: <code>telegram control on</code>.` };
      }
    }

    const rl = this._checkRateLimit(fromId, now);
    if (!rl.ok) {
      return { code: 'RATE_LIMITED', text: `${sym('warn')} Quá nhanh, thử lại sau ${rl.waitSec}s.` };
    }

    switch (cmd) {
      case 'start':
        return {
          code: 'OK',
          text: `${sym('title')} <b>Antertool đã kết nối Telegram.</b>\nDùng /status để xem toàn dàn, /bots để mở menu từng bot, hoặc /help để xem mọi lệnh.`,
        };
      case 'help':
        return { code: 'OK', text: buildTelegramHelpText() };
      case 'status': {
        const infos = this.mgr.bots.map(b => this.mgr._botPanelInfo(b, now));
        return { code: 'OK', text: buildStatusList(infos, fmtClock(now, this._tz(), true), this._tz()) };
      }
      case 'bots': {
        const page = parts[0] && /^\d+$/.test(parts[0]) ? Number(parts[0]) : 1;
        const infos = this.mgr.bots.map(b => this.mgr._botPanelInfo(b, now));
        const res = buildBotsPage(infos, page, 8);
        return { code: 'OK', text: res.text, keyboard: res.keyboard };
      }
      case 'bot': {
        const r = resolveBot(this.mgr.bots, parts[0]);
        if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
        const menu = buildBotMenu(this.mgr._botPanelInfo(r.bot, now));
        return { code: 'OK', text: menu.text, keyboard: menu.keyboard };
      }
      case 'panel': {
        if (parts[0]) {
          const r = resolveBot(this.mgr.bots, parts[0]);
          if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
          await this.mgr.sendTelegramPanel(r.bot, { fresh: true });
          return { code: 'OK', noReply: true };
        }
        const list = this.mgr.bots.filter(b => this.mgr._panelRelevant(b));
        if (!list.length) return { code: 'NOT_FOUND', text: 'Chưa có bot nào bật autosell_spawn.' };
        for (const b of list) this.mgr.sendTelegramPanel(b, { fresh: true });
        return { code: 'OK', noReply: true };
      }
      case 'activity':
        return this._cmdActivity(parts, now);
      case 'inv':
        return this._cmdInv(parts[0]);
      case 'pos':
        return this._cmdPos(parts[0]);
      case 'board':
        return this._cmdBoard(parts[0]);
      case 'ping':
        return this._cmdPing(parts[0]);
      case 'logs':
      case 'log': {
        const sub = (parts[0] || '').toLowerCase();
        if ((sub === 'on' || sub === 'off') && role !== 'admin') {
          this._recordDenied(fromId, `Telegram: từ chối /logs ${sub} từ viewer ${fromId}`, now);
          return { code: 'DENIED', text: 'Không có quyền.' };
        }
        await this.mgr._tgLogsCommand(ev);
        return { code: 'OK', noReply: true };
      }
      case 'startbot':
        return this._cmdStartBot(ev, role, parts[0]);
      case 'stopbot':
        return this._cmdStopBot(ev, role, parts[0], now);
      case 'reconnect':
        return this._cmdReconnect(ev, role, parts[0]);
      case 'sell':
        return this._cmdSell(ev, role, parts[0], parts.slice(1));
      case 'sellall':
        return this._cmdSellAll(ev, role, parts[0], now);
      case 'protect':
        return this._cmdProtect(ev, role, parts[0], parts.slice(1), now);
      case 'home':
        return this._cmdHome(ev, role, parts[0]);
      case 'afk':
        return this._cmdAfk(ev, role, parts[0], parts[1] || 'jump');
      case 'stopafk':
        return this._cmdStopAfk(ev, role, parts[0]);
      case 'macro':
        return this._cmdMacro(ev, role, parts[0], parts.slice(1).join(' '));
      case 'stopmacro':
        return this._cmdStopMacro(ev, role, parts[0]);
      case 'events':
        return this._cmdEvents(parts[0] ? Number(parts[0]) : 1);
      case 'mute':
        return this._cmdMute(ev, role, parts[0], now);
      case 'refresh':
        return this._cmdRefresh(ev, role, parts.join(' '));
      case 'cmd':
        return this._cmdRaw(ev, role, parts[0], parts.slice(1).join(' '), now);
      case 'cmdall':
        return this._cmdRawAll(ev, role, parts.join(' '), now);
      case 'diag':
        return this._cmdDiag(now);
      default:
        return { code: 'INVALID_ARG', text: `${sym('warn')} Không rõ lệnh <code>/${escapeHtml(sanitizeExternal(cmd, { max: 32 }))}</code>. Gõ /help để xem danh sách lệnh.` };
    }
  }

  async _handleButton(ev, role, fromId, now) {
    const ns = ev.cmd;
    const rest = String(ev.arg || '').split(':');

    // Legacy buttons: lg:now and r:<botId>
    if (ns === 'lg') {
      if (role === 'none') {
        this._recordDenied(fromId, `Telegram: từ chối nút lg từ user ${fromId}`, now);
        return { code: 'DENIED', callbackText: 'Không có quyền.' };
      }
      const r = await this.mgr.telegramLogs.refresh();
      return { code: r.ok ? 'OK' : 'FAILED', callbackText: r.ok ? 'Đã cập nhật file log' : r.message };
    }
    if (ns === 'r') {
      if (role === 'none') {
        this._recordDenied(fromId, `Telegram: từ chối nút r từ user ${fromId}`, now);
        return { code: 'DENIED', callbackText: 'Không có quyền.' };
      }
      const targetId = ev.arg;
      const bot = targetId === '*' ? null : this.mgr.bots.find(b => String(b.cfg.id) === targetId);
      if (targetId !== '*' && !bot) {
        return { code: 'NOT_FOUND', callbackText: 'Nút đã cũ, bấm ↻' };
      }
      if (bot) await this.mgr.sendTelegramPanel(bot, { editId: ev.messageId });
      else this.mgr.refreshTelegramPanels();
      return { code: 'OK', callbackText: 'Đã làm mới' };
    }

    // Confirmation buttons: c:<token>:y | c:<token>:n
    if (ns === 'c') {
      const [token, decision] = rest;
      return this._handleConfirmCallback(ev, role, fromId, token, decision, now);
    }

    // Events toggle buttons: e:<key>:<en|dis|lo|qu>[:<page>]
    if (ns === 'e') {
      if (role !== 'admin') {
        this._recordDenied(fromId, `Telegram: từ chối nút /events từ user ${fromId}`, now);
        return { code: 'DENIED', callbackText: 'Không có quyền.' };
      }
      if (this._config().telegramControlEnabled === false) {
        return { code: 'DENIED', callbackText: 'Điều khiển từ Telegram đang TẮT.' };
      }
      const rl = this._checkRateLimit(fromId, now);
      if (!rl.ok) return { code: 'RATE_LIMITED', callbackText: `Quá nhanh, thử lại sau ${rl.waitSec}s.` };
      const [key, op, pageStr] = rest;
      return this._handleEventToggleCallback(ev, role, key, op, Number(pageStr) || 1);
    }

    // Panel & bot menu actions: p:<bid>:<act>[:<arg>]
    if (ns === 'p') {
      const [bid, act, arg] = rest;
      const isViewAct = VIEW_BUTTON_ACTS.has(act);
      if (isViewAct && role === 'none') {
        this._recordDenied(fromId, `Telegram: từ chối nút p:${act} từ user ${fromId}`, now);
        return { code: 'DENIED', callbackText: 'Không có quyền.' };
      }
      if (!isViewAct) {
        if (role !== 'admin') {
          this._recordDenied(fromId, `Telegram: từ chối nút điều khiển p:${act} từ user ${fromId}`, now);
          return { code: 'DENIED', callbackText: 'Không có quyền.' };
        }
        if (this._config().telegramControlEnabled === false) {
          return { code: 'DENIED', callbackText: 'Điều khiển từ Telegram đang TẮT.' };
        }
      }
      const rl = this._checkRateLimit(fromId, now);
      if (!rl.ok) return { code: 'RATE_LIMITED', callbackText: `Quá nhanh, thử lại sau ${rl.waitSec}s.` };

      if (bid === 'all') {
        if (act === 'bp') {
          const infos = this.mgr.bots.map(b => this.mgr._botPanelInfo(b, now));
          const pageObj = buildBotsPage(infos, Number(arg) || 1, 8);
          return { code: 'OK', editMessage: true, text: pageObj.text, keyboard: pageObj.keyboard, callbackText: 'Đã chuyển trang' };
        }
        if (act === 'sc0') {
          return this._handleCancelScheduleButton(ev, role, now);
        }
        return { code: 'NOT_FOUND', callbackText: `Nút đã cũ, bấm ${sym('retry')}` };
      }

      const bot = resolveByShortId(bid, this.mgr.bots, b => String(b.cfg?.id || ''), 5);
      if (!bot) {
        return { code: 'NOT_FOUND', callbackText: `Nút đã cũ, bấm ${sym('retry')}` };
      }

      return this._dispatchBotButtonAction(ev, role, bot, act, arg, now);
    }

    return { code: 'NOT_FOUND', callbackText: `Nút đã cũ, bấm ${sym('retry')}` };
  }

  async _dispatchBotButtonAction(ev, role, bot, act, arg, now) {
    const id = String(bot.cfg.id);
    switch (act) {
      case 'r': {
        await this.mgr.sendTelegramPanel(bot, { editId: ev.messageId });
        return { code: 'OK', callbackText: 'Đã làm mới' };
      }
      case 'm': {
        const menu = buildBotMenu(this.mgr._botPanelInfo(bot, now));
        return { code: 'OK', editMessage: true, text: menu.text, keyboard: menu.keyboard, callbackText: `Menu ${id}` };
      }
      case 's1': {
        const r = this._cmdSell(ev, role, id, ['on']);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 's0': {
        const r = this._cmdSell(ev, role, id, ['off']);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'sn': {
        const r = this._cmdSell(ev, role, id, ['now']);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'ev': {
        const sec = Number(arg) || 300;
        const r = this._cmdSell(ev, role, id, ['every', `${sec}s`]);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'p1': {
        const r = this._cmdProtect(ev, role, id, ['on'], now);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'p0': {
        const r = this._cmdProtect(ev, role, id, ['off'], now);
        return { ...r, callbackText: r.code === 'CONFIRM_REQUIRED' ? 'Xác nhận tắt bảo vệ' : stripForCallback(r.text), refresh: [id] };
      }
      case 'pl1':
      case 'pl2':
      case 'pl3':
      case 'pl4': {
        const lvl = act.slice(2);
        const r = this._cmdProtect(ev, role, id, ['level', lvl], now);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'pu': {
        const curLvl = bot.spawnerLevel || 2;
        const nextLvl = Math.min(4, curLvl + 1);
        const r = this._cmdProtect(ev, role, id, ['level', String(nextLvl)], now);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'h': {
        const r = this._cmdHome(ev, role, id);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'a1': {
        const r = this._cmdAfk(ev, role, id, 'jump');
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'a0': {
        const r = this._cmdStopAfk(ev, role, id);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'b1': {
        const r = this._cmdStartBot(ev, role, id);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'b0': {
        const r = this._cmdStopBot(ev, role, id, now);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'rc': {
        const r = this._cmdReconnect(ev, role, id);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'px': {
        this._audit(ev, role, 'proxy rotate', id);
        if (!bot.cfg.useProxy) {
          return { code: 'FAILED', text: `${sym('warn')} ${escapeHtml(id)}: chưa bật useProxy trong cấu hình.`, callbackText: 'Chưa bật useProxy' };
        }
        bot._doProxyRotate();
        return { code: 'OK', text: `${sym('ok')} Đã yêu cầu đổi proxy và kết nối lại cho <b>${escapeHtml(id)}</b>.`, callbackText: 'Đã đổi proxy', refresh: [id] };
      }
      case 'mc': {
        const macros = bot.scriptRunner?.list?.() || [];
        const matched = resolveByShortId(arg, macros, m => m, 4);
        if (!matched) return { code: 'NOT_FOUND', callbackText: `Nút đã cũ, bấm ${sym('retry')}` };
        const r = this._cmdMacro(ev, role, id, matched);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'ms': {
        const r = this._cmdStopMacro(ev, role, id);
        return { ...r, callbackText: stripForCallback(r.text), refresh: [id] };
      }
      case 'iv': {
        const r = this._cmdInv(id);
        return { ...r, callbackText: `Túi đồ ${id}` };
      }
      case 'ps': {
        const r = this._cmdPos(id);
        return { ...r, callbackText: `Toạ độ ${id}` };
      }
      case 'bd': {
        const r = this._cmdBoard(id);
        return { ...r, callbackText: `Bảng điểm ${id}` };
      }
      case 'ac': {
        const r = this._cmdActivity([id, '10'], now);
        return { ...r, callbackText: `Hoạt động ${id}` };
      }
      default:
        return { code: 'NOT_FOUND', callbackText: `Nút đã cũ, bấm ${sym('retry')}` };
    }
  }

  _handleConfirmCallback(ev, role, fromId, token, decision, now) {
    const entry = this._confirmMap.get(String(token || ''));
    if (!entry) {
      return {
        code: 'EXPIRED',
        editMessage: true,
        text: `${sym('warn')} Yêu cầu xác nhận đã hết hạn hoặc đã được sử dụng.`,
        keyboard: [],
        callbackText: 'Yêu cầu xác nhận đã hết hạn.',
      };
    }
    const chatId = String(ev?.chat?.id ?? this.mgr?.telegram?.chatId ?? '');
    if (entry.chatId !== chatId || (entry.fromId !== 'local' && entry.fromId !== fromId)) {
      this._recordDenied(fromId, `Telegram: user ${fromId} bấm xác nhận của user ${entry.fromId}`, now);
      return { code: 'DENIED', callbackText: 'Không có quyền.' };
    }
    if (role !== 'admin') {
      this._confirmMap.delete(entry.token);
      this._recordDenied(fromId, `Telegram: user ${fromId} mất quyền admin khi bấm xác nhận`, now);
      return {
        code: 'DENIED',
        editMessage: true,
        text: `${sym('fail')} Không có quyền.`,
        keyboard: [],
        callbackText: 'Không có quyền.',
      };
    }
    if (now > entry.expiresAt) {
      this._confirmMap.delete(entry.token);
      return {
        code: 'EXPIRED',
        editMessage: true,
        text: `${sym('warn')} Yêu cầu xác nhận đã hết hạn.`,
        keyboard: [],
        callbackText: 'Yêu cầu xác nhận đã hết hạn.',
      };
    }

    // Xoá token TRƯỚC khi thực thi (single-use)
    this._confirmMap.delete(entry.token);

    if (decision !== 'y') {
      return {
        code: 'OK',
        editMessage: true,
        text: `${sym('off')} Đã huỷ thao tác: ${entry.summary}`,
        keyboard: [],
        callbackText: 'Đã huỷ',
      };
    }

    try {
      const res = entry.execute();
      return {
        code: res.code || 'OK',
        editMessage: true,
        text: res.text || `${sym('ok')} Đã thực hiện.`,
        keyboard: [],
        callbackText: stripForCallback(res.text || 'Đã xác nhận'),
        refresh: res.refresh || [],
      };
    } catch (e) {
      return {
        code: 'FAILED',
        editMessage: true,
        text: `${sym('fail')} Không thực hiện được: ${escapeHtml(sanitizeExternal(e.message || String(e), { max: 120 }))}`,
        keyboard: [],
        callbackText: 'Lỗi khi thực hiện',
      };
    }
  }

  // ===== Các lệnh xem (Viewer) =====

  _cmdActivity(parts, now) {
    let bot = null;
    let n = 10;
    if (!parts.length) {
      if (this.mgr.bots.length === 1) bot = this.mgr.bots[0];
      else if (!this.mgr.bots.length) return { code: 'NOT_FOUND', text: `${sym('log')} Chưa có bot nào.` };
      else bot = this.mgr.bots[0];
    } else if (parts.length === 1 && /^\d+$/.test(parts[0]) && !this.mgr.findBot(parts[0]) && this.mgr.bots.length === 1) {
      bot = this.mgr.bots[0];
      n = Number(parts[0]);
    } else {
      const r = resolveBot(this.mgr.bots, parts[0]);
      if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
      bot = r.bot;
      if (parts[1] && /^\d+$/.test(parts[1])) n = Number(parts[1]);
    }
    n = Math.max(1, Math.min(30, Math.floor(n) || 10));
    const cur = describeActivity(bot, now);
    const hist = (bot.history?.toArray?.() || []).slice(-n).reverse();
    const tz = this._tz();
    const safeId = escapeHtml(sanitizeExternal(bot.cfg.id, { max: 40 }));
    const lines = [
      `${sym('title')} <b>Hoạt động của ${safeId}</b>`,
      `${sym('now')} Hiện tại: <b>${escapeHtml(sanitizeExternal(cur.text, { max: 120 }))}</b>${cur.stale ? ' (quá lâu, có thể bị treo)' : ''}`,
      ruleLine(18),
    ];
    if (!hist.length) {
      lines.push('Chưa có lịch sử hoạt động.');
    } else {
      for (const h of hist) {
        const lSym = h.level === 'ok' ? sym('ok') : (h.level === 'warn' ? sym('warn') : (h.level === 'err' ? sym('fail') : sym('info')));
        lines.push(`${fmtClock(h.ts, tz, true)} ${lSym} ${escapeHtml(sanitizeExternal(h.text, { max: 120 }))}`);
      }
    }
    return { code: 'OK', text: lines.join('\n') };
  }

  _cmdInv(token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const safeId = escapeHtml(sanitizeExternal(bot.cfg.id, { max: 40 }));
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'xem túi đồ'))}` };
    }
    const items = Array.isArray(bot.state?.inventory) && bot.state.inventory.length
      ? bot.state.inventory
      : (bot.mc?.inventory?.items?.() || []).map(it => ({
          slot: it.slot,
          name: it.customName || it.displayName || it.name || 'Unknown',
          count: it.count || 1,
        }));
    const usedSlots = items.length;
    const freeSlots = Math.max(0, 36 - usedSlots);
    const byName = new Map();
    for (const it of items) {
      const k = sanitizeExternal(it.name || it.type || 'Unknown', { max: 50 });
      byName.set(k, (byName.get(k) || 0) + (Number(it.count) || 1));
    }
    const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 23);
    const lines = [
      `${sym('title')} <b>Túi đồ: ${safeId}</b>`,
      `Ô đã dùng: <b>${usedSlots}/36</b> ${sym('sep')} Ô trống: <b>${freeSlots}</b>`,
    ];
    if (!sorted.length) {
      lines.push('Túi đồ trống.');
    } else {
      for (const [name, count] of sorted) {
        lines.push(`${sym('bullet')} ${escapeHtml(name)} ${sym('mult')}${count}`);
      }
    }
    return { code: 'OK', text: lines.slice(0, 25).join('\n') };
  }

  _cmdPos(token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const safeId = escapeHtml(sanitizeExternal(bot.cfg.id, { max: 40 }));
    const pos = bot.mc?.entity?.position || bot.state?.position;
    if (!pos || !Number.isFinite(Number(pos.x))) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${safeId}: chưa có dữ liệu toạ độ (bot chưa spawn).` };
    }
    const dim = sanitizeExternal(bot.mc?.game?.dimension || 'overworld', { max: 40 });
    const cageDesc = typeof bot._describeCageDistance === 'function' ? sanitizeExternal(bot._describeCageDistance(), { max: 120 }) : '';
    const lines = [
      `${sym('pos')} <b>Toạ độ: ${safeId}</b>`,
      `X: <b>${pos.x.toFixed(1)}</b> ${sym('sep')} Y: <b>${pos.y.toFixed(1)}</b> ${sym('sep')} Z: <b>${pos.z.toFixed(1)}</b>`,
      `Chiều không gian: <code>${escapeHtml(dim)}</code>`,
    ];
    if (cageDesc) lines.push(`So với lồng: ${escapeHtml(cageDesc)}`);
    else if (bot._posLost) lines.push(`Trạng thái vị trí: ${sym('warn')} Đang lệch khỏi vị trí treo lồng`);
    return { code: 'OK', text: lines.join('\n') };
  }

  _cmdBoard(token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const safeId = escapeHtml(sanitizeExternal(bot.cfg.id, { max: 40 }));
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'đọc bảng điểm'))}` };
    }
    const board = typeof bot.readBoard === 'function' ? bot.readBoard() : null;
    if (!board || !Array.isArray(board.lines) || !board.lines.length) {
      return { code: 'OK', text: `${sym('info')} <b>${safeId}</b>: hiện chưa có dữ liệu bảng điểm (scoreboard).` };
    }
    const title = sanitizeExternal(board.title || 'Scoreboard', { max: 50 });
    const cleanLines = board.lines
      .slice(0, 15)
      .map(l => escapeHtml(sanitizeExternal(l.text || '', { max: 80 })))
      .filter(Boolean);
    return {
      code: 'OK',
      text: `${sym('title')} <b>Bảng điểm ${safeId}: ${escapeHtml(title)}</b>\n<pre>${cleanLines.join('\n')}</pre>`,
    };
  }

  _cmdPing(token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const safeId = escapeHtml(sanitizeExternal(bot.cfg.id, { max: 40 }));
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'đo ping'))}` };
    }
    const p = bot.state?.ping;
    return {
      code: 'OK',
      text: `${sym('pos')} <b>${safeId}</b> ${sym('sep')} Ping: <b>${typeof p === 'number' && p >= 0 ? `${p}ms` : '—'}</b>`,
    };
  }

  // ===== Các lệnh điều khiển (Admin) =====

  _cmdStartBot(ev, role, token) {
    const r = resolveBot(this.mgr.bots, token, true);
    if (r.status === 'ALL') {
      const stopped = this.mgr.bots.filter(b => !b.isConnected && !b.isReconnecting && b.state?.connState !== CS.CONNECTING);
      if (!stopped.length) {
        return { code: 'NOOP', text: `${sym('info')} Tất cả bot đã đang chạy hoặc đang kết nối sẵn.` };
      }
      this._audit(ev, role, 'startbot', 'all');
      if (typeof this.mgr.startAll === 'function') this.mgr.startAll(); else for (const b of stopped) { b._disabled = false; b._scheduledOut = false; b.state.reconnects = 0; b.start(); }
      const names = stopped.map(b => sanitizeExternal(b.cfg.id, { max: 30 }));
      return {
        code: 'OK',
        text: `${sym('ok')} Đã khởi động ${stopped.length} bot: <b>${escapeHtml(names.join(', '))}</b>${formatCallerSuffix(ev)}.`,
        refresh: stopped.map(b => String(b.cfg.id)),
      };
    }
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (bot.isConnected || bot.isReconnecting || bot.state?.connState === CS.CONNECTING) {
      return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bot đang chạy sẵn (${escapeHtml(bot.state.connState)}).` };
    }
    this._audit(ev, role, 'startbot', id);
    bot._disabled = false;
    bot._scheduledOut = false;
    bot.state.reconnects = 0;
    bot.start();
    return {
      code: 'OK',
      text: `${sym('ok')} Đã khởi động <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdStopBot(ev, role, token, now) {
    const r = resolveBot(this.mgr.bots, token, true);
    if (r.status === 'ALL') {
      const running = this.mgr.bots.filter(b => !b._disabled || b.state?.connState !== CS.DISCONNECTED);
      if (!running.length) {
        return { code: 'NOOP', text: `${sym('info')} Tất cả bot đã dừng sẵn.` };
      }
      const names = running.map(b => sanitizeExternal(b.cfg.id, { max: 30 }));
      const execAll = () => {
        this._audit(ev, role, 'stopbot', 'all');
        if (typeof this.mgr.stopAll === 'function') this.mgr.stopAll(); else for (const b of this.mgr.bots) b.shutdown();
        return {
          code: 'OK',
          text: `${sym('ok')} Đã dừng tất cả bot (${running.length}): <b>${escapeHtml(names.join(', '))}</b>${formatCallerSuffix(ev)}.`,
          refresh: running.map(b => String(b.cfg.id)),
        };
      };
      if (this._config().telegramConfirmDanger !== false) {
        return this._createConfirmation(
          ev,
          `Dừng TẤT CẢ bot: <b>${escapeHtml(names.join(', '))}</b>`,
          execAll,
          now
        );
      }
      return execAll();
    }
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (bot._disabled && bot.state?.connState === CS.DISCONNECTED) {
      return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bot đã dừng sẵn.` };
    }
    this._audit(ev, role, 'stopbot', id);
    bot.shutdown();
    return {
      code: 'OK',
      text: `${sym('ok')} Đã dừng <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdReconnect(ev, role, token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    this._audit(ev, role, 'reconnect', id);
    bot._disabled = false;
    bot.forceReconnect();
    return {
      code: 'OK',
      text: `${sym('retry')} Đã yêu cầu kết nối lại cho <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdSell(ev, role, token, subArgs = []) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    const sub = String(subArgs[0] || 'status').toLowerCase();

    if (sub === 'status') {
      const info = bot.getSellSpawnInfo();
      return {
        code: 'OK',
        text: [
          `${sym('title')} <b>Auto-sell Spawn: ${escapeHtml(id)}</b>`,
          `Trạng thái: <b>${info.on ? 'BẬT' : 'TẮT'}</b>${info.busy ? ' (đang chạy vòng bán)' : ''}`,
          `Số lồng: <b>${info.list.length}</b> ${sym('sep')} Click ô: <b>${info.slot}</b> ${sym('sep')} Chu kỳ: <b>${escapeHtml(info.intervalText)}</b>`,
        ].join('\n'),
      };
    }

    if (sub === 'on') {
      if (bot._sellSpawnOn) {
        return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bán đã bật sẵn.` };
      }
      if (!bot.isOnline) {
        return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'bán'))}` };
      }
      this._audit(ev, role, 'sell on', id);
      const res = bot.configureSellSpawn({ on: true });
      if (!res.on) {
        return { code: 'FAILED', text: `${sym('fail')} Không thực hiện được: ${escapeHtml(sanitizeExternal(res.message || 'danh sách lồng trống', { max: 120 }))}` };
      }
      return {
        code: 'OK',
        text: `${sym('ok')} Đã bật bán cho <b>${escapeHtml(id)}</b> (${bot.sellSpawnList.length} lồng, mỗi ${escapeHtml(bot._fmtDuration(bot._sellSpawnIntervalMs()))})${formatCallerSuffix(ev)}.`,
        refresh: [id],
      };
    }

    if (sub === 'off') {
      if (!bot._sellSpawnOn) {
        return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bán đã tắt sẵn.` };
      }
      this._audit(ev, role, 'sell off', id);
      bot.configureSellSpawn({ on: false });
      return {
        code: 'OK',
        text: `${sym('ok')} Đã tắt bán cho <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
        refresh: [id],
      };
    }

    if (sub === 'now') {
      if (!bot.isOnline) {
        return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'bán'))}` };
      }
      if (bot._sellSpawnBusy || bot._sellRecovering || bot._spawnerBusy || bot.scriptRunner?.running) {
        return { code: 'BUSY', text: `${sym('warn')} ${escapeHtml(describeBusyReason(bot))}` };
      }
      if (!bot.sellSpawnList?.length) {
        return { code: 'FAILED', text: `${sym('fail')} Không thực hiện được: danh sách lồng của ${escapeHtml(id)} đang trống.` };
      }
      this._audit(ev, role, 'sell now', id);
      const started = bot.runSellSpawnNow();
      if (!started) {
        return { code: 'BUSY', text: `${sym('warn')} ${escapeHtml(describeBusyReason(bot))}` };
      }
      return {
        code: 'OK',
        text: `${sym('now')} Đã bắt đầu vòng bán ngay cho <b>${escapeHtml(id)}</b> (${bot.sellSpawnList.length} lồng)${formatCallerSuffix(ev)}.`,
        refresh: [id],
      };
    }

    if (sub === 'every') {
      const durText = subArgs.slice(1).join(' ');
      const sec = parseDurationSec(durText);
      if (sec === null || sec <= 0) {
        return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Dùng: <code>/sell &lt;bot&gt; every &lt;thời gian&gt;</code> (vd 30s, 5m).` };
      }
      this._audit(ev, role, `sell every ${sec}s`, id);
      const hms = secToHmsObj(sec);
      const res = bot.configureSellSpawn(hms);
      if (!res.ok) {
        return { code: 'INVALID_ARG', text: `${sym('warn')} ${escapeHtml(res.message || 'Thời gian không hợp lệ.')}` };
      }
      const note = res.message ? ` (${escapeHtml(res.message)})` : '';
      return {
        code: 'OK',
        text: `${sym('ok')} Đã đặt chu kỳ bán cho <b>${escapeHtml(id)}</b>: mỗi <b>${escapeHtml(bot._fmtDuration(bot._sellSpawnIntervalMs()))}</b>${note}${formatCallerSuffix(ev)}.`,
        refresh: [id],
      };
    }

    return {
      code: 'INVALID_ARG',
      text: `${sym('warn')} Sai tham số. Dùng: <code>/sell &lt;id&gt; on|off|now|status|every &lt;30s|5m&gt;</code>`,
    };
  }

  _cmdSellAll(ev, role, subArg, now) {
    const sub = String(subArg || '').toLowerCase();
    if (!['on', 'off', 'now'].includes(sub)) {
      return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Dùng: <code>/sellall on|off|now</code>` };
    }
    if (!this.mgr.bots.length) {
      return { code: 'NOT_FOUND', text: `${sym('warn')} Chưa có bot nào.` };
    }

    if (sub === 'off') {
      const active = this.mgr.bots.filter(b => b._sellSpawnOn);
      if (!active.length) {
        return { code: 'NOOP', text: `${sym('info')} Tất cả bot đã tắt bán sẵn.` };
      }
      const names = active.map(b => sanitizeExternal(b.cfg.id, { max: 30 }));
      const execOff = () => {
        this._audit(ev, role, 'sellall off', 'all');
        for (const b of active) b.configureSellSpawn({ on: false });
        return {
          code: 'OK',
          text: `${sym('ok')} Đã tắt bán cho ${active.length} bot: <b>${escapeHtml(names.join(', '))}</b>${formatCallerSuffix(ev)}.`,
          refresh: active.map(b => String(b.cfg.id)),
        };
      };
      if (this._config().telegramConfirmDanger !== false) {
        return this._createConfirmation(
          ev,
          `Tắt tự bán lồng cho TẤT CẢ bot đang bật (${active.length}): <b>${escapeHtml(names.join(', '))}</b>`,
          execOff,
          now
        );
      }
      return execOff();
    }

    if (sub === 'on') {
      const online = this.mgr.bots.filter(b => b.isOnline && !b._sellSpawnOn);
      if (!online.length) {
        const allOn = this.mgr.bots.some(b => b._sellSpawnOn);
        return {
          code: allOn ? 'NOOP' : 'OFFLINE',
          text: allOn ? `${sym('info')} Các bot online đều đã bật bán sẵn.` : `${sym('warn')} Không có bot nào đang online để bật bán.`,
        };
      }
      this._audit(ev, role, 'sellall on', 'all');
      const turnedOn = [];
      for (const b of online) {
        const res = b.configureSellSpawn({ on: true });
        if (res.on) turnedOn.push(String(b.cfg.id));
      }
      if (!turnedOn.length) {
        return { code: 'FAILED', text: `${sym('fail')} Không thực hiện được: các bot online chưa có lồng nào trong danh sách.` };
      }
      return {
        code: 'OK',
        text: `${sym('ok')} Đã bật bán cho ${turnedOn.length} bot: <b>${escapeHtml(turnedOn.join(', '))}</b>${formatCallerSuffix(ev)}.`,
        refresh: turnedOn,
      };
    }

    // sub === 'now'
    const eligible = this.mgr.bots.filter(b => b.isOnline && !b._isBusy && b.sellSpawnList?.length > 0);
    if (!eligible.length) {
      return { code: 'OFFLINE', text: `${sym('warn')} Không có bot nào đang online, rảnh và có danh sách lồng để bán ngay.` };
    }
    this._audit(ev, role, 'sellall now', 'all');
    const ran = [];
    for (const b of eligible) {
      if (b.runSellSpawnNow()) ran.push(String(b.cfg.id));
    }
    return {
      code: 'OK',
      text: `${sym('now')} Đã chạy vòng bán ngay cho ${ran.length} bot: <b>${escapeHtml(ran.join(', '))}</b>${formatCallerSuffix(ev)}.`,
      refresh: ran,
    };
  }

  _cmdProtect(ev, role, token, subArgs = [], now = this._now()) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    const sub = String(subArgs[0] || 'status').toLowerCase();

    if (sub === 'status') {
      const info = bot.getSpawnerLevelInfo();
      return {
        code: 'OK',
        text: [
          `${sym('guard')} <b>Bảo vệ lồng: ${escapeHtml(id)}</b>`,
          `Trạng thái: <b>${bot._spawnerProtectOn ? 'BẬT' : 'TẮT'}</b> ${sym('sep')} Số lồng: <b>${bot.protectedSpawners?.length || 0}</b>`,
          `Cường độ: <b>mức ${info.level} (${escapeHtml(info.name)})</b> ${sym('sep')} Quét: <b>${info.settings.range} block</b>`,
        ].join('\n'),
      };
    }

    if (sub === 'on') {
      if (bot._spawnerProtectOn) {
        return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bảo vệ lồng đã bật sẵn.` };
      }
      if (!bot.isOnline) {
        return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'bật bảo vệ lồng'))}` };
      }
      this._audit(ev, role, 'protect on', id);
      const ok = bot._startSpawnerProtect();
      if (!ok) {
        return { code: 'FAILED', text: `${sym('fail')} Không thực hiện được: không thấy lồng nào quanh <b>${escapeHtml(id)}</b>.` };
      }
      return {
        code: 'OK',
        text: `${sym('ok')} Đã bật bảo vệ lồng cho <b>${escapeHtml(id)}</b> (${bot.protectedSpawners.length} lồng)${formatCallerSuffix(ev)}.`,
        refresh: [id],
      };
    }

    if (sub === 'off') {
      if (!bot._spawnerProtectOn) {
        return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bảo vệ lồng đã tắt sẵn.` };
      }
      const execOff = () => {
        this._audit(ev, role, 'protect off', id);
        bot._stopSpawnerProtect();
        return {
          code: 'OK',
          text: `${sym('ok')} Đã tắt bảo vệ lồng cho <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
          refresh: [id],
        };
      };
      if (this._config().telegramConfirmDanger !== false) {
        return this._createConfirmation(
          ev,
          `Tắt bảo vệ lồng (spawnerprotect) của bot <b>${escapeHtml(id)}</b>`,
          execOff,
          now
        );
      }
      return execOff();
    }

    if (sub === 'level') {
      const n = Number(subArgs[1]);
      if (![1, 2, 3, 4].includes(n)) {
        return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Dùng: <code>/protect &lt;bot&gt; level &lt;1-4&gt;</code>` };
      }
      if (bot.spawnerLevel === n) {
        return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: bảo vệ lồng đã ở mức ${n} sẵn.` };
      }
      this._audit(ev, role, `protect level ${n}`, id);
      bot.setSpawnerLevel(n);
      const info = bot.getSpawnerLevelInfo();
      return {
        code: 'OK',
        text: `${sym('ok')} Đã đặt cường độ bảo vệ lồng của <b>${escapeHtml(id)}</b>: <b>mức ${info.level} (${escapeHtml(info.name)})</b>${formatCallerSuffix(ev)}.`,
        refresh: [id],
      };
    }

    return {
      code: 'INVALID_ARG',
      text: `${sym('warn')} Sai tham số. Dùng: <code>/protect &lt;id&gt; on|off|status|level &lt;1-4&gt;</code>`,
    };
  }

  _cmdHome(ev, role, token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'gõ /home'))}` };
    }
    if (bot._isBusy) {
      return { code: 'BUSY', text: `${sym('warn')} ${escapeHtml(describeBusyReason(bot))}` };
    }
    this._audit(ev, role, 'home', id);
    const homeCmd = sanitizeExternal(bot.spawnHomeCommand || '/home treolong', { max: 40 });
    bot.cmd('spawnhome now');
    return {
      code: 'OK',
      text: `${sym('ok')} Đã yêu cầu <b>${escapeHtml(id)}</b> gõ <code>${escapeHtml(homeCmd)}</code>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdAfk(ev, role, token, mode = 'jump') {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'bật AFK'))}` };
    }
    const wantMode = String(mode || 'jump').toLowerCase() === 'walk' ? 'walk' : 'jump';
    if (bot.state?.afk === wantMode) {
      return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: AFK ${wantMode} đã bật sẵn.` };
    }
    this._audit(ev, role, `afk ${wantMode}`, id);
    if (wantMode === 'walk') bot.afkWalk();
    else bot.afkJump();
    return {
      code: 'OK',
      text: `${sym('ok')} Đã bật AFK ${wantMode === 'walk' ? 'đi bộ' : 'nhảy'} cho <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdStopAfk(ev, role, token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (!bot.state?.afk) {
      return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: AFK đang tắt sẵn.` };
    }
    this._audit(ev, role, 'stopafk', id);
    bot.afkStop();
    return {
      code: 'OK',
      text: `${sym('ok')} Đã dừng AFK cho <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdMacro(ev, role, token, macroNameRaw = '') {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    const allowedMacros = bot.scriptRunner?.list?.() || [];
    const want = String(macroNameRaw || '').trim();

    if (!want) {
      if (!allowedMacros.length) {
        return { code: 'OK', text: `${sym('info')} <b>${escapeHtml(id)}</b>: chưa có macro nào trong cấu hình.` };
      }
      const bid = botShortId(id, this.mgr.bots.map(b => String(b.cfg.id)));
      const lines = [
        `${sym('title')} <b>Danh sách macro của ${escapeHtml(id)}</b>`,
        ...allowedMacros.map(m => `${sym('bullet')} <code>${escapeHtml(sanitizeExternal(m, { max: 40 }))}</code>`),
      ];
      const keyboard = [];
      let row = [];
      for (const m of allowedMacros.slice(0, 12)) {
        const mid = macroShortId(m, allowedMacros);
        row.push({ text: `${sym('now')} ${truncateCodePoints(sanitizeExternal(m, { max: 16 }), 16)}`, callback_data: `p:${bid}:mc:${mid}` });
        if (row.length >= 2) { keyboard.push(row); row = []; }
      }
      if (row.length) keyboard.push(row);
      return { code: 'OK', text: lines.join('\n'), keyboard };
    }

    // Kiểm tra allow-list (tuyệt đối không dùng tên macro làm đường dẫn file)
    const squash = v => String(v).toLowerCase().replace(/[\s_\-]+/g, '');
    const matched = allowedMacros.find(k => k.toLowerCase() === want.toLowerCase())
      || allowedMacros.find(k => squash(k) === squash(want));
    if (!matched) {
      const safeWant = escapeHtml(sanitizeExternal(want, { max: 40 }));
      return { code: 'NOT_FOUND', text: `${sym('warn')} Không có macro "${safeWant}". Dùng <code>/macro ${escapeHtml(id)}</code> để xem danh sách.` };
    }
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, `chạy macro "${matched}"`))}` };
    }
    if (bot.scriptRunner?.running) {
      const cur = sanitizeExternal(bot.scriptRunner.currentMacro || 'macro', { max: 40 });
      if (cur.toLowerCase() === matched.toLowerCase()) {
        return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: macro "${escapeHtml(cur)}" đang chạy sẵn.` };
      }
      return { code: 'BUSY', text: `${sym('warn')} <b>${escapeHtml(id)}</b> đang chạy macro "${escapeHtml(cur)}", lệnh không chen ngang.` };
    }
    if (bot._spawnerBusy) {
      return { code: 'BUSY', text: `${sym('warn')} ${escapeHtml(describeBusyReason(bot))}` };
    }
    this._audit(ev, role, `macro ${matched}`, id);
    bot.scriptRunner.run(matched).catch(e => bot.log('err', `Macro lỗi: ${e.message}`));
    return {
      code: 'OK',
      text: `${sym('now')} Đã bắt đầu chạy macro <code>${escapeHtml(sanitizeExternal(matched, { max: 40 }))}</code> trên <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdStopMacro(ev, role, token) {
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (!bot.scriptRunner?.running) {
      return { code: 'NOOP', text: `${sym('info')} <b>${escapeHtml(id)}</b>: hiện không có macro nào đang chạy.` };
    }
    const cur = sanitizeExternal(bot.scriptRunner.currentMacro || 'macro', { max: 40 });
    this._audit(ev, role, `stopmacro ${cur}`, id);
    bot.scriptRunner.stop();
    return {
      code: 'OK',
      text: `${sym('ok')} Đã dừng macro <code>${escapeHtml(cur)}</code> trên <b>${escapeHtml(id)}</b>${formatCallerSuffix(ev)}.`,
      refresh: [id],
    };
  }

  _cmdEvents(page = 1) {
    const keys = Object.keys(EVENT_CATALOG);
    const pageSize = 6;
    const totalPages = Math.max(1, Math.ceil(keys.length / pageSize));
    const curPage = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));
    const slice = keys.slice((curPage - 1) * pageSize, curPage * pageSize);

    const cfg = this._config();
    const tgEvents = this.mgr.telegram.events || new Set();
    const allOn = tgEvents.has('all');
    const loudSet = new Set(Array.isArray(cfg.telegramLoudEvents) ? cfg.telegramLoudEvents : DEFAULT_CRIT_EVENTS);

    const lines = [
      `${sym('title')} <b>Cấu hình thông báo sự kiện (trang ${curPage}/${totalPages})</b>`,
      `Bấm nút bên dưới để đặt trạng thái Bật/Tắt và Rung/Im lặng cho từng loại:`,
    ];
    const keyboard = [];

    for (const k of slice) {
      const spec = EVENT_CATALOG[k];
      const isEnabled = k === 'sellCycle' ? cfg.telegramSellCycleNotify === true : (allOn || tgEvents.has(k));
      const isLoud = spec.level === 'crit' ? (loudSet.has(k) || !Array.isArray(cfg.telegramLoudEvents)) : loudSet.has(k);
      lines.push(`${isEnabled ? sym('on') : sym('off')} <b>${escapeHtml(spec.title)}</b> (<code>${escapeHtml(k)}</code>): ${isEnabled ? 'BẬT' : 'TẮT'} ${sym('sep')} ${isLoud ? 'Rung' : 'Im lặng'}`);
      const enOp = isEnabled ? 'dis' : 'en';
      const loOp = isLoud ? 'qu' : 'lo';
      keyboard.push([
        {
          text: `${isEnabled ? sym('on') : sym('off')} ${truncateCodePoints(spec.title, 14)}: ${isEnabled ? 'Tắt' : 'Bật'}`,
          callback_data: `e:${k}:${enOp}:${curPage}`,
        },
        {
          text: `${isLoud ? sym('warn') : sym('info')} ${isLoud ? 'Đặt im lặng' : 'Đặt rung'}`,
          callback_data: `e:${k}:${loOp}:${curPage}`,
        },
      ]);
    }

    if (totalPages > 1) {
      const nav = [];
      if (curPage > 1) nav.push({ text: `${sym('back')} Trang ${curPage - 1}`, callback_data: `e:_page:nav:${curPage - 1}` });
      if (curPage < totalPages) nav.push({ text: `Trang ${curPage + 1} ${sym('arrow')}`, callback_data: `e:_page:nav:${curPage + 1}` });
      if (nav.length) keyboard.push(nav);
    }

    return { code: 'OK', text: lines.join('\n'), keyboard };
  }

  _handleEventToggleCallback(ev, role, key, op, page = 1) {
    if (key === '_page') {
      const view = this._cmdEvents(page);
      return { code: 'OK', editMessage: true, text: view.text, keyboard: view.keyboard, callbackText: `Trang ${page}` };
    }
    if (!EVENT_CATALOG[key]) {
      return { code: 'NOT_FOUND', callbackText: `Nút đã cũ, bấm ${sym('retry')}` };
    }

    const cfg = this._config();
    this._audit(ev, role, `events ${key} ${op}`);

    if (op === 'en' || op === 'dis') {
      const wantOn = op === 'en';
      if (key === 'sellCycle') {
        const cur = cfg.telegramSellCycleNotify === true;
        if (cur === wantOn) {
          const view = this._cmdEvents(page);
          return { code: 'NOOP', editMessage: true, text: view.text, keyboard: view.keyboard, callbackText: `${key}: đã ${wantOn ? 'bật' : 'tắt'} sẵn.` };
        }
        this.mgr.setTelegramOption('telegramSellCycleNotify', wantOn);
      } else {
        const curSet = new Set(this.mgr.telegram.events);
        if (curSet.has('all')) {
          curSet.delete('all');
          for (const k of Object.keys(EVENT_CATALOG)) if (k !== 'sellCycle') curSet.add(k);
        }
        const curOn = curSet.has(key);
        if (curOn === wantOn) {
          const view = this._cmdEvents(page);
          return { code: 'NOOP', editMessage: true, text: view.text, keyboard: view.keyboard, callbackText: `${key}: đã ${wantOn ? 'bật' : 'tắt'} sẵn.` };
        }
        if (wantOn) curSet.add(key);
        else curSet.delete(key);
        this.mgr.setTelegramOption('telegramEvents', [...curSet]);
      }
      const view = this._cmdEvents(page);
      return {
        code: 'OK',
        editMessage: true,
        text: view.text,
        keyboard: view.keyboard,
        callbackText: `Đã ${wantOn ? 'bật' : 'tắt'} ${EVENT_CATALOG[key].title}`,
      };
    }

    if (op === 'lo' || op === 'qu') {
      const wantLoud = op === 'lo';
      const loudSet = new Set(Array.isArray(cfg.telegramLoudEvents) ? cfg.telegramLoudEvents : DEFAULT_CRIT_EVENTS);
      const curLoud = loudSet.has(key);
      if (curLoud === wantLoud) {
        const view = this._cmdEvents(page);
        return { code: 'NOOP', editMessage: true, text: view.text, keyboard: view.keyboard, callbackText: `${key}: đã ở chế độ ${wantLoud ? 'rung' : 'im lặng'} sẵn.` };
      }
      if (wantLoud) loudSet.add(key);
      else loudSet.delete(key);
      this.mgr.setTelegramOption('telegramLoudEvents', [...loudSet]);
      const view = this._cmdEvents(page);
      return {
        code: 'OK',
        editMessage: true,
        text: view.text,
        keyboard: view.keyboard,
        callbackText: `Đã đặt ${wantLoud ? 'rung' : 'im lặng'} cho ${EVENT_CATALOG[key].title}`,
      };
    }

    return { code: 'INVALID_ARG', callbackText: 'Tham số không hợp lệ' };
  }

  _cmdMute(ev, role, arg, now) {
    const v = String(arg || '').trim().toLowerCase();
    if (!v) {
      const until = Number(this._config().telegramMuteUntil || 0);
      if (until > now) {
        return { code: 'OK', text: `${sym('info')} Đang tắt tiếng thông báo tới <b>${escapeHtml(fmtClock(until, this._tz(), true))}</b> (còn ${fmtDuration(until - now)}). Gõ <code>/mute off</code> để bật lại.` };
      }
      return { code: 'OK', text: `${sym('info')} Thông báo đang ở chế độ bình thường. Dùng <code>/mute 30m</code>, <code>/mute 1h</code> hoặc <code>/mute off</code>.` };
    }
    if (v === 'off' || v === '0') {
      const until = Number(this._config().telegramMuteUntil || 0);
      if (until <= now) {
        return { code: 'NOOP', text: `${sym('info')} Chế độ tắt tiếng đã tắt sẵn.` };
      }
      this._audit(ev, role, 'mute off');
      this.mgr.setTelegramOption('telegramMuteUntil', 0);
      return { code: 'OK', text: `${sym('ok')} Đã bật lại âm báo Telegram${formatCallerSuffix(ev)}.` };
    }
    const sec = parseDurationSec(v);
    if (sec === null || sec <= 0 || sec > 7 * 86400) {
      return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Dùng: <code>/mute &lt;30m|1h|off&gt;</code>` };
    }
    const until = now + sec * 1000;
    this._audit(ev, role, `mute ${sec}s`);
    this.mgr.setTelegramOption('telegramMuteUntil', until);
    return {
      code: 'OK',
      text: `${sym('ok')} Đã tắt tiếng thông báo trong <b>${fmtDuration(sec * 1000)}</b> (tới ${escapeHtml(fmtClock(until, this._tz(), true))})${formatCallerSuffix(ev)}.`,
    };
  }

  _cmdRefresh(ev, role, arg) {
    const v = String(arg || '').trim().toLowerCase();
    if (!v) {
      const cur = this._config().telegramRefreshSec ?? 1;
      return { code: 'OK', text: `${sym('info')} Chu kỳ làm mới bảng hiện tại: <b>${cur ? `${cur}s` : 'TẮT'}</b>. Dùng: <code>/refresh &lt;1s..1h|off&gt;</code>` };
    }
    if (v === 'off' || v === '0') {
      if (this._config().telegramRefreshSec === 0) {
        return { code: 'NOOP', text: `${sym('info')} Tự làm mới bảng đã tắt sẵn.` };
      }
      this._audit(ev, role, 'refresh off');
      this.mgr.setTelegramOption('telegramRefreshSec', 0);
      return { code: 'OK', text: `${sym('ok')} Đã tắt làm mới bảng theo nhịp${formatCallerSuffix(ev)}.` };
    }
    const sec = parseDurationSec(v);
    if (sec === null || sec < 1 || sec > 3600) {
      return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Chu kỳ làm mới phải từ <code>1s</code> đến <code>1h</code>.` };
    }
    if (this._config().telegramRefreshSec === sec) {
      return { code: 'NOOP', text: `${sym('info')} Chu kỳ làm mới bảng đã là ${sec}s sẵn.` };
    }
    this._audit(ev, role, `refresh ${sec}s`);
    this.mgr.setTelegramOption('telegramRefreshSec', sec);
    return {
      code: 'OK',
      text: `${sym('ok')} Đã đặt chu kỳ làm mới bảng: mỗi <b>${fmtDuration(sec * 1000, { sec: true })}</b>${formatCallerSuffix(ev)}.`,
    };
  }

  _cmdRaw(ev, role, token, rawCmdText, now) {
    if (!token || !rawCmdText) {
      return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Dùng: <code>/cmd &lt;bot&gt; &lt;lệnh&gt;</code>` };
    }
    const denylist = this._config().telegramCmdDenylist || DEFAULT_CMD_DENYLIST;
    if (isCredentialLikeCmd(rawCmdText, denylist)) {
      if (typeof ev.deleteTriggerMessage === 'function') {
        try { Promise.resolve(ev.deleteTriggerMessage()).catch(() => {}); } catch { /* ignore */ }
      } else if (ev.messageId && typeof this.mgr?.telegram?.deleteMessage === 'function') {
        try { Promise.resolve(this.mgr.telegram.deleteMessage(ev.messageId)).catch(() => {}); } catch { /* ignore */ }
      }
      this._recordDenied(String(ev.from?.id || 'local'), `Telegram: chặn lệnh nhạy cảm /cmd ${maskCommandForLog(rawCmdText, denylist)}`, now);
      return { code: 'DENIED', text: 'Lệnh này bị chặn qua Telegram.' };
    }
    const r = resolveBot(this.mgr.bots, token);
    if (r.status !== 'OK') return { code: r.status, text: `${sym('warn')} ${escapeHtml(r.text)}` };
    const bot = r.bot;
    const id = String(bot.cfg.id);
    if (!bot.isOnline) {
      return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'gửi lệnh'))}` };
    }
    const safeCmd = sanitizeExternal(rawCmdText, { max: 200 });
    return this._createConfirmation(
      ev,
      `Gửi lệnh cho <b>${escapeHtml(id)}</b>:\n<code>${escapeHtml(safeCmd)}</code>`,
      () => {
        if (!bot.isOnline) {
          return { code: 'OFFLINE', text: `${sym('warn')} ${escapeHtml(describeOfflineReason(bot, 'gửi lệnh'))}` };
        }
        this._audit(ev, role, `cmd ${maskCommandForLog(safeCmd, denylist)}`, id);
        bot.cmd(safeCmd);
        return {
          code: 'OK',
          text: `${sym('ok')} Đã gửi lệnh tới <b>${escapeHtml(id)}</b>: <code>${escapeHtml(safeCmd)}</code>${formatCallerSuffix(ev)}.`,
          refresh: [id],
        };
      },
      now
    );
  }

  _cmdRawAll(ev, role, rawCmdText, now) {
    if (!rawCmdText) {
      return { code: 'INVALID_ARG', text: `${sym('warn')} Sai tham số. Dùng: <code>/cmdall &lt;lệnh&gt;</code>` };
    }
    const denylist = this._config().telegramCmdDenylist || DEFAULT_CMD_DENYLIST;
    if (isCredentialLikeCmd(rawCmdText, denylist)) {
      if (typeof ev.deleteTriggerMessage === 'function') {
        try { Promise.resolve(ev.deleteTriggerMessage()).catch(() => {}); } catch { /* ignore */ }
      } else if (ev.messageId && typeof this.mgr?.telegram?.deleteMessage === 'function') {
        try { Promise.resolve(this.mgr.telegram.deleteMessage(ev.messageId)).catch(() => {}); } catch { /* ignore */ }
      }
      this._recordDenied(String(ev.from?.id || 'local'), `Telegram: chặn lệnh nhạy cảm /cmdall ${maskCommandForLog(rawCmdText, denylist)}`, now);
      return { code: 'DENIED', text: 'Lệnh này bị chặn qua Telegram.' };
    }
    const online = this.mgr.bots.filter(b => b.isOnline);
    if (!online.length) {
      return { code: 'OFFLINE', text: `${sym('warn')} Không có bot nào đang online để gửi lệnh.` };
    }
    const safeCmd = sanitizeExternal(rawCmdText, { max: 200 });
    const names = online.map(b => sanitizeExternal(b.cfg.id, { max: 30 }));
    return this._createConfirmation(
      ev,
      `Gửi lệnh cho TẤT CẢ bot đang online (${online.length}: <b>${escapeHtml(names.join(', '))}</b>):\n<code>${escapeHtml(safeCmd)}</code>`,
      () => {
        const curOnline = this.mgr.bots.filter(b => b.isOnline);
        if (!curOnline.length) {
          return { code: 'OFFLINE', text: `${sym('warn')} Không còn bot nào online.` };
        }
        this._audit(ev, role, `cmdall ${maskCommandForLog(safeCmd, denylist)}`, 'all');
        for (const b of curOnline) b.cmd(safeCmd);
        return {
          code: 'OK',
          text: `${sym('ok')} Đã gửi lệnh <code>${escapeHtml(safeCmd)}</code> tới ${curOnline.length} bot${formatCallerSuffix(ev)}.`,
          refresh: curOnline.map(b => String(b.cfg.id)),
        };
      },
      now
    );
  }

  _handleCancelScheduleButton(ev, role, now) {
    const sched = this.mgr.getSchedule();
    if (!sched?.enabled) {
      return { code: 'NOOP', text: `${sym('info')} Lịch tự out/vào đã tắt sẵn.`, callbackText: 'Lịch đã tắt sẵn' };
    }
    return this._createConfirmation(
      ev,
      `Huỷ lịch tự out/vào (${escapeHtml(sched.outTime || '')} ${sym('arrow')} ${escapeHtml(sched.inTime || '')})`,
      () => {
        this._audit(ev, role, 'schedule off', 'all');
        this.mgr.setSchedule(false, null, null);
        return {
          code: 'OK',
          text: `${sym('ok')} Đã huỷ lịch tự out/vào${formatCallerSuffix(ev)}.`,
        };
      },
      now
    );
  }

  _cmdDiag(now) {
    const d = this.mgr.telegram.getDiag();
    const tz = this._tz();
    const sep = sym('sep');
    const pauseUntil = d.pauseUntil ?? d.pausedUntil ?? 0;
    const isPaused = (d.paused || pauseUntil > now) && pauseUntil > now;
    const pauseStr = isPaused
      ? `Đang tạm dừng (còn ${fmtDuration(pauseUntil - now, { sec: true })})`
      : 'Hoạt động bình thường';
    const lastOk = d.lastSuccessAt ? `${fmtClock(d.lastSuccessAt, tz, true)} (${fmtDuration(now - d.lastSuccessAt, { sec: true })} trước)` : '—';
    const rawErr = d.lastError ? TelegramLogger.redactStatic(String(d.lastError)) : '';
    const lastErr = rawErr ? sanitizeExternal(rawErr, { max: 120 }) : 'không có';
    const qLen = d.queueLength ?? d.queueLen ?? 0;
    const pend = d.pending ?? 0;
    const sent = d.sent ?? 0;
    const edited = d.edited ?? 0;
    const c429 = d.rateLimited429 ?? d.count429 ?? 0;
    const dropped = d.dropped ?? d.droppedCount ?? 0;
    return {
      code: 'OK',
      text: [
        `${sym('title')} <b>Chẩn đoán Telegram Notifier</b>`,
        `Trạng thái: <b>${escapeHtml(pauseStr)}</b>`,
        `Hàng đợi: <b>${qLen}</b> chờ (${pend} đang xử lý)`,
        `Đã gửi: <b>${sent}</b> ${sep} Đã sửa: <b>${edited}</b>`,
        `Giới hạn 429: <b>${c429}</b> lần ${sep} Đã bỏ qua (quá tải/trễ): <b>${dropped}</b>`,
        `Lần thành công cuối: <b>${escapeHtml(lastOk)}</b>`,
        `Lỗi gần nhất: <code>${escapeHtml(lastErr)}</code>`,
      ].join('\n'),
    };
  }
}

function stripForCallback(htmlText) {
  const plain = String(htmlText || '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return truncateCodePoints(plain, 180);
}

module.exports = TelegramControl;
module.exports.TelegramControl = TelegramControl;
module.exports.RESULT_CODES = RESULT_CODES;
module.exports.resolveBot = resolveBot;
module.exports.parseDurationSec = parseDurationSec;
module.exports.isCredentialLikeCmd = isCredentialLikeCmd;
module.exports.maskCommandForLog = maskCommandForLog;
