'use strict';
/**
 * NotificationCenter.js — Trung tâm sự kiện thông báo duy nhất cho cả Telegram và Discord (Section 6 & 8).
 *
 *  - emit(evt) đồng bộ, nhẹ, không bao giờ throw.
 *  - Gating tách biệt từng kênh: telegramEvents[key] (hoặc telegramSellCycleNotify cho sellCycle) và webhookEvents[key].
 *  - Chính sách riêng cho Telegram:
 *      • Gộp tin trùng (dedup): cùng key|bot|fingerprint trong cửa sổ (mặc định 30s) -> sửa tin đầu thành "×N · lần cuối HH:MM:SS" (im lặng).
 *      • Rung vs im lặng (loud/quiet) và Mute (telegramMuteUntil, telegramMuteCrit).
 *      • Chống bão tin (storm control): tối đa 6 tin loud non-crit / 60s (crit miễn trừ tới 15 tin / 60s), vượt ngưỡng gộp vào 1 bản tin digest sửa tại chỗ.
 *      • Hàng đợi ưu tiên P2 (crit) / P3 (sự kiện khác) có giới hạn kích thước và gắn nhãn "(trễ Xm)" nếu chờ quá maxAgeSec.
 *  - Discord giữ nguyên 100% hành vi và cấu trúc payload của Notifier hiện tại.
 */
const { sym, replaceLegacyEmoji } = require('./Symbols');
const { sanitizeExternal, escapeHtml } = require('./TextSafe');
const { describeActivity, getActivitySnapshot, fmtShortCountdown } = require('./BotActivity');
const { fmtClock, fmtDuration, fmtMoney, botShortId } = require('./TelegramPanel');
const { DEFAULT_CRIT_EVENTS } = require('./ConfigValidator');
const { dbg } = require('./debug');

/**
 * Danh mục sự kiện chuẩn (Section 8).
 */
const EVENT_CATALOG = Object.freeze({
  disconnect: {
    level: 'crit',
    title: 'Mất kết nối',
    label: 'Ngắt kết nối / bị kick',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: (bid) => [[
      { text: `${sym('retry')} Kết nối lại`, callback_data: `p:${bid}:rc` },
      { text: `${sym('stop')} Dừng bot`, callback_data: `p:${bid}:b0` },
    ]],
  },
  reconnectFailed: {
    level: 'crit',
    title: 'Hết lượt kết nối lại',
    label: 'Hết lượt kết nối lại',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: (bid) => [[
      { text: `${sym('retry')} Thử lại`, callback_data: `p:${bid}:rc` },
      { text: 'Đổi proxy', callback_data: `p:${bid}:px` },
    ]],
  },
  reconnectRecovered: {
    level: 'ok',
    title: 'Đã kết nối lại ổn định',
    label: 'Đã kết nối lại ổn định',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  connected: {
    level: 'ok',
    title: 'Đã vào server',
    label: 'Đã vào server (xong đăng nhập/menu)',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  featuresReady: {
    level: 'ok',
    title: 'Tính năng sẵn sàng',
    label: 'Đã bật bảo vệ lồng + tự bán lồng',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: (bid) => [[
      { text: `${sym('now')} Bán ngay`, callback_data: `p:${bid}:sn` },
    ]],
  },
  sellCycle: {
    level: 'info',
    title: 'Xong vòng bán',
    label: 'Báo mỗi khi xong 1 vòng bán lồng',
    defaultOn: false,
    gatedBySellCycleFlag: true,
    dedupWindowMs: 15000,
    cooldownMs: 0,
    buttons: () => null,
  },
  sellFailed: {
    level: 'crit',
    title: 'Bán lồng thất bại',
    label: 'Bán lồng lỗi sau N lần /home',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0, // call-site _sellFailAlertedAt đã giới hạn
    buttons: (bid) => [[
      { text: `${sym('now')} Thử bán lại`, callback_data: `p:${bid}:sn` },
      { text: `${sym('stop')} Dừng bán`, callback_data: `p:${bid}:s0` },
    ]],
  },
  homeReturn: {
    level: 'warn',
    title: 'Lệch vị trí / đã về home',
    label: 'Lệch vị trí treo lồng / đã về home',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: (bid) => [[
      { text: `${sym('now')} Gõ /home ngay`, callback_data: `p:${bid}:h` },
    ]],
  },
  spawnerThreat: {
    level: 'crit',
    title: 'Mối đe dọa gần lồng',
    label: 'Cảnh báo mối đe dọa gần lồng spawn',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0, // call-site _spawnerAlertedAt đã giới hạn
    buttons: (bid) => [[
      { text: `${sym('guard')} Nâng mức bảo vệ`, callback_data: `p:${bid}:pu` },
      { text: `${sym('log')} Xem trạng thái`, callback_data: `p:${bid}:r` },
    ]],
  },
  protectResult: {
    level: 'ok',
    title: 'Kết quả bảo vệ lồng',
    label: 'Kết quả xử lý bảo vệ lồng',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  autoSell: {
    level: 'info',
    title: 'Túi đầy',
    label: 'Đầy túi đồ (Auto-sell macro)',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  moneyGoal: {
    level: 'ok',
    title: 'Đủ mục tiêu tiền',
    label: 'Đạt mục tiêu tiền (Money Goal)',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  autoOrder: {
    level: 'info',
    title: 'Báo cáo AutoOrder',
    label: 'Báo cáo định kỳ AutoOrder',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  schedule: {
    level: 'info',
    title: 'Lịch tự out/vào',
    label: 'Lịch tự nghỉ / vào lại',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => [[
      { text: `${sym('fail')} Huỷ lịch`, callback_data: 'p:all:sc0' },
    ]],
  },
  macro: {
    level: 'info',
    title: 'Macro',
    label: 'Chạy / kết thúc / lỗi Macro',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: (bid) => [[
      { text: `${sym('stop')} Dừng macro`, callback_data: `p:${bid}:ms` },
    ]],
  },
  proxy: {
    level: 'warn',
    title: 'Proxy',
    label: 'Xoay proxy / lỗi proxy',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  posLost: {
    level: 'warn',
    title: 'Mất vị trí treo',
    label: 'Mất vị trí treo lồng',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: (bid) => [[
      { text: `${sym('now')} Gõ /home`, callback_data: `p:${bid}:h` },
    ]],
  },
  system: {
    level: 'info',
    title: 'Hệ thống',
    label: 'Khởi động / tắt / lỗi hệ thống',
    defaultOn: true,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
  revenue: {
    level: 'info',
    title: 'Doanh thu',
    label: 'Báo cáo doanh thu',
    defaultOn: false,
    dedupWindowMs: 30000,
    cooldownMs: 0,
    buttons: () => null,
  },
});

const EVENT_LABELS = Object.freeze(
  Object.fromEntries(Object.entries(EVENT_CATALOG).map(([k, v]) => [k, v.label]))
);

function levelGlyph(level) {
  if (level === 'crit') return sym('fail');
  if (level === 'warn') return sym('warn');
  if (level === 'ok') return sym('ok');
  return sym('info');
}

function cleanDiscordLineForTelegram(line) {
  let s = String(line ?? '');
  // Bỏ tag Discord (<@123>, <@&123>, @everyone, @here)
  s = s.replace(/ ?<@[!&]?\d+>/g, '').replace(/ ?@(everyone|here)\b/g, '');
  // Đổi emoji quen thuộc sang token bảng ký hiệu trước khi làm sạch
  s = replaceLegacyEmoji(s);
  // Tách định dạng **bold** và `code` an toàn
  const tokens = [];
  s = s.replace(/\*\*(.+?)\*\*/g, (_, inner) => {
    const id = `@@B${tokens.length}@@`;
    tokens.push({ id, tag: 'b', text: sanitizeExternal(inner, { max: 200 }) });
    return id;
  });
  s = s.replace(/`([^`\n]+)`/g, (_, inner) => {
    const id = `@@C${tokens.length}@@`;
    tokens.push({ id, tag: 'code', text: sanitizeExternal(inner, { max: 200 }) });
    return id;
  });
  let out = escapeHtml(sanitizeExternal(s, { max: 300 }));
  for (const t of tokens) {
    out = out.replace(t.id, `<${t.tag}>${escapeHtml(t.text)}</${t.tag}>`);
  }
  return out.trim();
}

/**
 * Hàm thuần dựng tin nhắn sự kiện cho Telegram (Appendix B).
 * @param {object} evt
 * @param {{now?: number, tz?: string, allBotIds?: string[], dedupCount?: number, lastTs?: number, lateMinutes?: number, redact?: (s:string)=>string}} [opts]
 * @returns {{text: string, keyboard: Array|null, level: string}}
 */
function renderEventMessage(evt = {}, opts = {}) {
  const now = opts.now ?? evt.now ?? evt.ts ?? Date.now();
  const tz = opts.tz || 'Asia/Ho_Chi_Minh';
  const redact = typeof opts.redact === 'function' ? opts.redact : (x => x);
  const sep = sym('sep');
  const spec = EVENT_CATALOG[evt.key] || { level: 'info', title: 'Thông báo', buttons: () => null };
  const level = evt.level || spec.level || 'info';
  const glyph = levelGlyph(level);

  const botName = evt.bot ? sanitizeExternal(redact(String(evt.bot)), { max: 40 }) : '';
  let rawTitle = spec.title || evt.title || 'Thông báo';
  if (evt.customTitle && evt.title) {
    let t = replaceLegacyEmoji(String(evt.title));
    if (botName && t.toLowerCase().startsWith(botName.toLowerCase() + ':')) {
      t = t.slice(botName.length + 1).trim();
    }
    rawTitle = sanitizeExternal(redact(t), { max: 80 }) || spec.title;
  }

  const clockStr = fmtClock(evt.ts || evt.now || now, tz, true);
  const lateTag = opts.lateMinutes && opts.lateMinutes > 0 ? ` (trễ ${opts.lateMinutes}m)` : '';
  const botHeader = botName ? ` ${sep} <b>${escapeHtml(botName)}</b>` : '';
  const header = `${glyph} <b>${escapeHtml(rawTitle)}</b>${botHeader} ${sep} ${escapeHtml(clockStr)}${escapeHtml(lateTag)}`;

  const lines = [header];

  if (evt.headline) {
    const hl = cleanDiscordLineForTelegram(redact(evt.headline));
    if (hl && !hl.toLowerCase().includes(rawTitle.toLowerCase())) {
      lines.push(`<b>${hl}</b>`);
    }
  }

  const rawCause = evt.cause || evt.reason;
  if (rawCause) {
    const cleanCause = sanitizeExternal(redact(rawCause), { max: 300 });
    if (cleanCause) lines.push(`Lý do: "${escapeHtml(cleanCause)}"`);
  }
  if (evt.uptimeText && evt.nextPlan) {
    lines.push(`Đã online: ${escapeHtml(sanitizeExternal(evt.uptimeText, { max: 40 }))} ${sep} Kế hoạch: ${escapeHtml(sanitizeExternal(evt.nextPlan, { max: 120 }))}`);
  }

  const hasFieldLabel = new Set();
  if (Array.isArray(evt.fields)) {
    for (const pair of evt.fields) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const k = sanitizeExternal(redact(pair[0]), { max: 60 });
      const v = sanitizeExternal(redact(pair[1]), { max: 300 });
      if (!k || !v) continue;
      hasFieldLabel.add(k.toLowerCase());
      lines.push(`${escapeHtml(k)}: ${escapeHtml(v)}`);
    }
  }

  if (evt.description) {
    const descLines = String(redact(evt.description)).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const dl of descLines) {
      const cleaned = cleanDiscordLineForTelegram(dl);
      if (cleaned) lines.push(cleaned);
    }
  }

  let actTextToRender = evt.activityText;
  if (!actTextToRender && evt.botSession) {
    if (evt.key === 'disconnect') {
      const snap = getActivitySnapshot(evt.botSession, now) || evt.botSession._lastDisconnectActivity;
      if (snap && snap.text) actTextToRender = snap.text;
      else {
        const cur = describeActivity(evt.botSession, now);
        if (cur && cur.text && cur.kind !== 'disconnected') actTextToRender = cur.text;
      }
    } else {
      const cur = describeActivity(evt.botSession, now);
      if (cur && cur.text) actTextToRender = cur.text;
    }
  }
  if (actTextToRender) {
    const actClean = sanitizeExternal(redact(actTextToRender), { max: 120 });
    const labelKey = evt.key === 'disconnect' ? 'đang làm lúc đó' : 'bot đang';
    if (actClean && !hasFieldLabel.has(labelKey)) {
      const prefix = evt.key === 'disconnect' ? 'Đang làm lúc đó' : 'Bot đang';
      lines.push(`${prefix}: ${escapeHtml(actClean)}`);
    }
  }

  const dedupCount = Number(opts.dedupCount || evt.dedupCount || 1);
  if (dedupCount > 1) {
    const lastClock = fmtClock(opts.lastTs || now, tz, true);
    lines.push(`${sym('mult')}${dedupCount} ${sep} lần cuối ${escapeHtml(lastClock)}`);
  }

  let keyboard = null;
  if (evt.keyboard !== undefined) {
    keyboard = evt.keyboard;
  } else if (typeof spec.buttons === 'function') {
    const bid = botName ? (evt.shortId || botShortId(botName, opts.allBotIds || [botName])) : 'all';
    keyboard = spec.buttons(bid);
  }

  const fullText = lines.join('\n');
  return { text: fullText, keyboard, level };
}

class NotificationCenter {
  /**
   * @param {object} opts
   * @param {import('./TelegramNotifier')} [opts.telegram]
   * @param {import('./Notifier')} [opts.discord]
   * @param {() => object} [opts.getConfig]
   * @param {() => string} [opts.getTz]
   * @param {(s:string) => string} [opts.redact]
   * @param {() => string[]} [opts.getBotIds]
   * @param {(botId:string) => any} [opts.findBot]
   * @param {(bot:any) => void} [opts.onIncidentPanelRefresh]
   * @param {() => number} [opts.nowFn]
   */
  constructor(opts = {}) {
    this._telegram = opts.telegram || null;
    this._getTelegram = typeof opts.getTelegram === 'function' ? opts.getTelegram : null;
    this._discord = opts.discord || null;
    this._getDiscord = typeof opts.getDiscord === 'function' ? opts.getDiscord : null;
    this._getConfig = typeof opts.getConfig === 'function' ? opts.getConfig : () => ({});
    this._getTz = typeof opts.getTz === 'function' ? opts.getTz : () => (this._getConfig()?.telegramTimezone || 'Asia/Ho_Chi_Minh');
    this._redact = typeof opts.redact === 'function' ? opts.redact : (s => String(s ?? ''));
    const getBots = typeof opts.getBots === 'function' ? opts.getBots : null;
    this._getBotIds = typeof opts.getBotIds === 'function'
      ? opts.getBotIds
      : (getBots ? () => (getBots() || []).map(b => String(b.cfg?.id || '')) : () => []);
    this._findBot = typeof opts.findBot === 'function'
      ? opts.findBot
      : (getBots ? (id) => (getBots() || []).find(b => String(b.cfg?.id) === String(id)) || null : () => null);
    this._onIncidentPanelRefresh = typeof opts.onIncidentPanelRefresh === 'function' ? opts.onIncidentPanelRefresh : null;
    this._now = typeof opts.nowFn === 'function' ? opts.nowFn : () => Date.now();

    this.dedupWindowByKey = { ...(opts.dedupWindowByKey || {}) };
    this.cooldownByKey = { ...(opts.cooldownByKey || {}) };
    this.stormMaxNonCritPerMin = opts.stormMaxNonCritPerMin ?? 6;
    this.stormMaxCritPerMin = opts.stormMaxCritPerMin ?? 15;
    this.maxAgeSec = opts.maxAgeSec ?? 600;
    this.incidentPanelDelayMs = opts.incidentPanelDelayMs ?? 1500;

    this._dedupMap = new Map();     // fpKey -> { count, firstTs, lastTs, msgId, pendingPromise, evt, rendered }
    this._cooldownMap = new Map();  // key|bot -> lastTs
    this._nonCritSentAt = [];       // timestamps in last 60s
    this._critSentAt = [];          // timestamps in last 60s
    this._digest = null;            // { windowStart, count, items: [], msgId, promise }
  }

  get telegram() {
    return this._getTelegram ? this._getTelegram() : this._telegram;
  }
  set telegram(v) {
    this._telegram = v;
  }

  get discord() {
    return this._getDiscord ? this._getDiscord() : this._discord;
  }
  set discord(v) {
    this._discord = v;
  }

  resetState() {
    this._dedupMap.clear();
    this._cooldownMap.clear();
    this._nonCritSentAt = [];
    this._critSentAt = [];
    this._digest = null;
  }

  getDedupWindowMs(key) {
    if (this.dedupWindowByKey[key] !== undefined) return Number(this.dedupWindowByKey[key]);
    return EVENT_CATALOG[key]?.dedupWindowMs ?? 30000;
  }

  getCooldownMs(key) {
    if (this.cooldownByKey[key] !== undefined) return Number(this.cooldownByKey[key]);
    return EVENT_CATALOG[key]?.cooldownMs ?? 0;
  }

  isTelegramEventEnabled(key) {
    const tg = this.telegram;
    if (!tg || !tg.enabled) return false;
    const cfg = this._getConfig() || {};
    if (key === 'sellCycle') {
      return cfg.telegramSellCycleNotify === true;
    }
    return tg.isEventOn(key);
  }

  isLoudEvent(key, level, explicitSilent = false, now = this._now()) {
    if (explicitSilent) return false;
    const cfg = this._getConfig() || {};
    const loudList = Array.isArray(cfg.telegramLoudEvents) ? cfg.telegramLoudEvents : DEFAULT_CRIT_EVENTS;
    const loudSet = new Set(loudList);
    const isCrit = level === 'crit';
    const baseLoud = isCrit || loudSet.has(key);
    if (!baseLoud) return false;

    const muteUntil = Number(cfg.telegramMuteUntil || 0);
    const isMuted = muteUntil > now;
    if (!isMuted) return true;
    if (isCrit && cfg.telegramMuteCrit !== true) return true;
    return false;
  }

  _enrichEventFromBot(evt, now) {
    const botObj = evt.botSession || (evt.bot ? this._findBot(evt.bot) : null);
    if (!botObj) return evt;
    const out = { ...evt, bot: evt.bot || String(botObj.cfg?.id || '') };
    if (!out.activityText) {
      if (out.key === 'disconnect') {
        const snap = getActivitySnapshot(botObj, now);
        if (snap && snap.text) out.activityText = snap.text;
        else {
          const cur = describeActivity(botObj, now);
          if (cur && cur.text && cur.kind !== 'disconnected') out.activityText = cur.text;
        }
      } else {
        const cur = describeActivity(botObj, now);
        if (cur && cur.text) out.activityText = cur.text;
      }
    }
    return out;
  }

  /**
   * Phát 1 sự kiện thông báo. Đồng bộ, không bao giờ throw.
   */
  emit(rawEvt) {
    try {
      if (!rawEvt || !rawEvt.key) return false;
      const now = Number(rawEvt.ts) || this._now();
      const spec = EVENT_CATALOG[rawEvt.key] || { level: 'info', title: 'Thông báo' };
      const level = rawEvt.level || spec.level || 'info';
      const evt = this._enrichEventFromBot({ ...rawEvt, level, ts: now }, now);

      // 1. Kênh Discord (giữ nguyên hành vi & payload của Notifier)
      if (evt.discord && this.discord && this.discord.isEventOn(evt.key)) {
        try {
          this.discord.send(evt.key, evt.discord.embed, evt.discord.headline);
        } catch (e) {
          dbg('NotificationCenter', e);
        }
      }

      // 2. Kênh Telegram
      if (!this.isTelegramEventEnabled(evt.key)) return true;

      // Cooldown riêng nếu có cấu hình
      const cdMs = this.getCooldownMs(evt.key);
      const cdKey = `${evt.key}|${evt.bot || ''}`;
      if (cdMs > 0) {
        const lastCd = this._cooldownMap.get(cdKey) || 0;
        if (now - lastCd < cdMs) return true;
        this._cooldownMap.set(cdKey, now);
      }

      // Dedup theo key|bot|fingerprint trong cửa sổ dedupWindowMs
      const fp = evt.fingerprint !== undefined
        ? String(evt.fingerprint)
        : `${evt.cause || ''}|${evt.description || ''}|${evt.title || ''}|${JSON.stringify(evt.fields || [])}`;
      const dedupKey = `${evt.key}|${evt.bot || ''}|${fp}`;
      const winMs = this.getDedupWindowMs(evt.key);

      if (winMs > 0) {
        const existing = this._dedupMap.get(dedupKey);
        if (existing && (now - existing.firstTs <= winMs)) {
          existing.count++;
          existing.lastTs = now;
          this._scheduleDedupEdit(existing, now);
          return true;
        }
      }

      // Kiểm tra Storm Control
      const loud = this.isLoudEvent(evt.key, level, evt.silent === true, now);
      const isCrit = level === 'crit';
      if (this._shouldCollapseIntoDigest(isCrit, loud, now)) {
        this._addToDigest(evt, now);
        return true;
      }

      const entry = {
        key: dedupKey,
        evt,
        count: 1,
        firstTs: now,
        lastTs: now,
        msgId: null,
        chain: Promise.resolve(),
      };
      if (winMs > 0) {
        this._dedupMap.set(dedupKey, entry);
        if (this._dedupMap.size > 300) {
          for (const [k, v] of this._dedupMap) {
            if (now - v.lastTs > Math.max(winMs, 120000)) this._dedupMap.delete(k);
          }
        }
      }

      this._dispatchTelegramNew(entry, loud, isCrit, now);
      return true;
    } catch (e) {
      dbg('NotificationCenter', e);
      return false;
    }
  }

  _shouldCollapseIntoDigest(isCrit, loud, now) {
    this._nonCritSentAt = this._nonCritSentAt.filter(t => now - t < 60000);
    this._critSentAt = this._critSentAt.filter(t => now - t < 60000);
    if (isCrit) {
      if (this._critSentAt.length >= this.stormMaxCritPerMin) return true;
      this._critSentAt.push(now);
      return false;
    }
    if (loud) {
      if (this._nonCritSentAt.length >= this.stormMaxNonCritPerMin) return true;
      this._nonCritSentAt.push(now);
      return false;
    }
    return false;
  }

  _addToDigest(evt, now) {
    const tz = this._getTz();
    if (!this._digest || now - this._digest.windowStart >= 60000) {
      this._digest = {
        windowStart: now,
        count: 0,
        items: [],
        msgId: null,
        chain: Promise.resolve(),
      };
    }
    const d = this._digest;
    d.count++;
    const spec = EVENT_CATALOG[evt.key] || { title: evt.key };
    const botLabel = evt.bot ? `${sanitizeExternal(evt.bot, { max: 24 })}: ` : '';
    const summary = `${botLabel}${sanitizeExternal(spec.title || evt.title || evt.key, { max: 50 })}`;
    if (d.items.length < 8) d.items.push(summary);

    const clockStr = fmtClock(now, tz, true);
    const lines = [
      `${sym('warn')} <b>${d.count} sự kiện đã được gộp trong 60s</b> ${sym('sep')} ${escapeHtml(clockStr)}`,
      ...d.items.map(it => ` ${sym('bullet')} ${escapeHtml(it)}`),
    ];
    if (d.count > d.items.length) {
      lines.push(` ${sym('ellipsis')} và ${d.count - d.items.length} sự kiện khác`);
    }
    const text = lines.join('\n');

    d.chain = d.chain.then(async () => {
      if (!this.telegram || !this.telegram.enabled) return;
      if (d.msgId) {
        await this.telegram.edit(d.msgId, text, { silent: true, priority: 3 });
      } else {
        const mid = await this.telegram.send(text, { silent: true, priority: 3 });
        if (mid) d.msgId = mid;
      }
    }).catch(e => dbg('NotificationCenter', e));
  }

  _dispatchTelegramNew(entry, loud, isCrit, now) {
    const evt = entry.evt;
    const renderOpts = {
      now,
      tz: this._getTz(),
      allBotIds: this._getBotIds(),
      dedupCount: 1,
      lastTs: now,
      redact: this._redact,
    };
    const rendered = renderEventMessage(evt, renderOpts);
    const priority = isCrit ? 2 : 3;

    entry.chain = entry.chain.then(async () => {
      if (!this.telegram || !this.telegram.enabled) return;
      const mid = await this.telegram.send(rendered.text, {
        keyboard: rendered.keyboard,
        silent: !loud,
        priority,
        crit: isCrit,
        enqueuedAt: now,
        maxAgeSec: this.maxAgeSec,
        onStaleCrit: (lateMinutes) => {
          const reRendered = renderEventMessage(evt, { ...renderOpts, lateMinutes });
          return reRendered.text;
        },
      });
      if (mid) entry.msgId = mid;
    }).catch(e => dbg('NotificationCenter', e));

    // Sự kiện làm đổi trạng thái bot -> hẹn sửa bảng sau ~1.5s
    if (['disconnect', 'reconnectFailed', 'reconnectRecovered', 'sellFailed', 'spawnerThreat', 'protectResult', 'featuresReady', 'connected'].includes(evt.key)) {
      const botObj = evt.botSession || (evt.bot ? this._findBot(evt.bot) : null);
      if (botObj && this._onIncidentPanelRefresh) {
        const t = setTimeout(() => {
          try { this._onIncidentPanelRefresh(botObj); } catch (e) { dbg('NotificationCenter', e); }
        }, this.incidentPanelDelayMs);
        if (t.unref) t.unref();
      }
    }
  }

  _scheduleDedupEdit(entry, now) {
    const evt = entry.evt;
    const count = entry.count;
    const lastTs = entry.lastTs;
    entry.chain = entry.chain.then(async () => {
      if (!this.telegram || !this.telegram.enabled || !entry.msgId) return;
      const rendered = renderEventMessage(evt, {
        now,
        tz: this._getTz(),
        allBotIds: this._getBotIds(),
        dedupCount: count,
        lastTs,
        redact: this._redact,
      });
      await this.telegram.edit(entry.msgId, rendered.text, {
        keyboard: rendered.keyboard,
        silent: true,
        priority: 3,
      });
    }).catch(e => dbg('NotificationCenter', e));
  }
}

module.exports = NotificationCenter;
module.exports.NotificationCenter = NotificationCenter;
module.exports.EVENT_CATALOG = EVENT_CATALOG;
module.exports.EVENT_LABELS = EVENT_LABELS;
module.exports.renderEventMessage = renderEventMessage;
module.exports.cleanDiscordLineForTelegram = cleanDiscordLineForTelegram;
