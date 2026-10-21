'use strict';
const https = require('https');
const http = require('http');
let DiscordTheme;
try {
  DiscordTheme = require('./DiscordTheme');
} catch {
  const RevenueTracker = require('./RevenueTracker');
  const BRAND_FB = 'Antertool';
  const SEV = Object.freeze({ success: 0x6ef16f, info: 0x38bdf8, warning: 0xf59e0b, critical: 0xef4444, report: 0xcf8338 });
  const COL = Object.freeze({ ok: SEV.success, report: SEV.report, ...SEV });
  const THEMES = Object.freeze({
    disconnect: { emoji: '🔌', severity: 'critical', color: SEV.critical, label: 'Ngắt Kết Nối / Bị Kick', headline: '❌ BOT BỊ KICK' },
    reconnectFailed: { emoji: '🛑', severity: 'critical', color: SEV.critical, label: 'Hết Lượt Reconnect', headline: '🔴 BOT HẾT LƯỢT RECONNECT' },
    reconnectRecovered: { emoji: '🟢', severity: 'success', color: SEV.success, label: 'Đã Kết Nối Lại Ổn Định' },
    moneyGoal: { emoji: '🎯', severity: 'success', color: SEV.success, label: 'Đạt Mục Tiêu Tiền' },
    spawnerThreat: { emoji: '🚨', severity: 'critical', color: SEV.critical, label: 'Cảnh Báo Bảo Vệ Lồng Spawn', headline: '🚨 CẢNH BÁO LỒNG SPAWN' },
    protectResult: { emoji: '🛡️', severity: 'success', color: SEV.success, label: 'Kết Quả Bảo Vệ Lồng' },
    autoSell: { emoji: '🎒', severity: 'info', color: SEV.info, label: 'Túi Đồ Đầy (Auto-Sell)' },
    schedule: { emoji: '🗓️', severity: 'info', color: SEV.info, label: 'Lịch Tự Out/Vào' },
    scheduleOut: { emoji: '🌙', severity: 'warning', color: SEV.warning, label: 'Bắt Đầu Giờ Nghỉ' },
    scheduleIn: { emoji: '☀️', severity: 'success', color: SEV.success, label: 'Hết Giờ Nghỉ' },
    revenue: { emoji: '💰', severity: 'report', color: SEV.report, label: 'Báo Cáo Tổng Kết Auto-Sell Spawn' },
    revenueMacro: { emoji: '📈', severity: 'report', color: SEV.report, label: 'Báo Cáo Tổng Kết Auto-Sell (Macro)' },
    revenueSummary: { emoji: '📊', severity: 'report', color: SEV.report, label: 'Báo Cáo Tổng Kết Doanh Thu' },
    featuresReady: { emoji: '✅', severity: 'success', color: SEV.success, label: 'Đã Bật Tính Năng' },
    homeReturn: { emoji: '🏠', severity: 'warning', color: SEV.warning, label: 'Vị Trí Treo Lồng' },
    autoOrder: { emoji: '📦', severity: 'report', color: SEV.report, label: 'Báo Cáo AutoOrder' },
    sellFailed: { emoji: '🚨', severity: 'critical', color: SEV.critical, label: 'Auto-Sell Spawn Thất Bại', headline: '🚨 KHÔNG BÁN ĐƯỢC LỒNG' },
    connected: { emoji: '✨', severity: 'success', color: SEV.success, label: 'Đã Vào Server' },
    sellCycle: { emoji: '🔄', severity: 'info', color: SEV.info, label: 'Xong Vòng Bán' },
    macro: { emoji: '⚙️', severity: 'info', color: SEV.info, label: 'Chạy Macro' },
    proxy: { emoji: '🌐', severity: 'warning', color: SEV.warning, label: 'Xoay Proxy' },
    posLost: { emoji: '🧭', severity: 'warning', color: SEV.warning, label: 'Lệch Vị Trí Treo Lồng' },
    system: { emoji: '🖥️', severity: 'info', color: SEV.info, label: 'Hệ Thống' },
    test: { emoji: '✅', severity: 'success', color: SEV.success, label: 'Kiểm Tra Kết Nối Webhook' },
    testMention: { emoji: '🔔', severity: 'warning', color: SEV.warning, label: 'Bot Bị Kick (Tin Thử)', headline: '❌ BOT BỊ KICK (test)' },
  });
  const DEF_T = Object.freeze({ emoji: 'ℹ️', severity: 'info', color: SEV.info, label: 'Thông Báo' });
  const trunc = (s, m = 1024) => { const a = Array.from(String(s ?? '')); return a.length <= m ? String(s ?? '') : a.slice(0, Math.max(0, m - 1)).join('') + '…'; };
  DiscordTheme = {
    BRAND: BRAND_FB, SEVERITY_COLORS: SEV, COLOR: COL, EVENT_THEMES: THEMES, DEFAULT_THEME: DEF_T,
    getTheme: (k) => THEMES[k] || DEF_T,
    inferEventKey: (t, fb) => fb || 'system',
    formatEmbedTitle: (t, k) => trunc(`${(THEMES[k] || DEF_T).emoji} ${String(t || '').replace(/^[^\p{L}\p{N}/]+/u, '')}`.trim(), 256),
    buildAuthor: (n, u) => (/^\w{1,16}$/.test(String(u || '')) ? { name: trunc(n || BRAND_FB, 256), icon_url: `https://mc-heads.net/avatar/${u}/100` } : { name: trunc(n || BRAND_FB, 256) }),
    buildThumbnail: (u) => (/^\w{1,16}$/.test(String(u || '')) ? { url: `https://mc-heads.net/avatar/${u}/100` } : undefined),
    progressBar: (c, t, w = 5) => { const r = t > 0 ? Math.max(0, Math.min(1, c / t)) : 0; const f = Math.round(r * w); return '▰'.repeat(f) + '▱'.repeat(w - f) + ` ${Math.round(r * 100)}%`; },
    discordTimestamp: (ms = Date.now(), st = 'R') => `<t:${Math.floor((Number(ms) || Date.now()) / 1000)}:${st}>`,
    formatMoney: (n) => RevenueTracker.formatMoneyDollar(n),
    blockquote: (t) => String(t || '').split(/\r?\n/).filter(Boolean).map(l => `> ${l}`).join('\n'),
    codeBlock: (t, l = '') => `\`\`\`${l}\n${String(t || '').trim()}\n\`\`\``,
    redactSecrets: (s) => String(s ?? ''),
    truncateCodePoints: trunc,
    codePointLength: (s) => Array.from(String(s ?? '')).length,
    enforceEmbedLimits: (e) => ({ ...e, author: e.author || { name: BRAND_FB }, footer: e.footer?.text ? e.footer : { text: BRAND_FB }, timestamp: e.timestamp || new Date().toISOString() }),
    buildPreviewPayloads: () => [],
  };
}

/**
 * Notifier — gửi thông báo tới 1 Discord webhook dùng chung cho cả dàn bot.
 * Chỉ dùng https/http có sẵn của Node, theo đúng định dạng embed công khai
 * của Discord (POST {embeds:[...]}) — không phụ thuộc thư viện ngoài.
 *
 * Việc gửi được xếp hàng tuần tự (this._queue) để tránh bắn nhiều request
 * cùng lúc khi nhiều bot có sự kiện gần như đồng thời — hạn chế bị Discord
 * rate-limit và giữ đúng thứ tự thời gian của các thông báo.
 */
const EVENT_LABELS = {
  disconnect: 'Ngắt kết nối / bị kick',
  reconnectFailed: 'Hết lượt reconnect',
  reconnectRecovered: 'Đã kết nối lại ổn định',
  moneyGoal: 'Đủ tiền (Money Goal)',
  spawnerThreat: 'Cảnh báo Bảo vệ Lồng Spawn',
  autoSell: 'Đầy túi đồ (Auto-sell)',
  schedule: 'Lịch tự out/vào',
  revenue: 'Báo cáo doanh thu Auto-sell Spawn',
  featuresReady: 'Đã bật spawnerprotect + autosell_spawn (sau đăng nhập/menu, đúng vị trí)',
  homeReturn: 'Lệch vị trí treo lồng → tự gõ /home treolong (và khi đã về)',
  autoOrder: 'Báo cáo định kỳ AutoOrder (stack / tiền / uptime)',
  sellFailed: 'autosell_spawn bán lỗi, gõ /home treolong tối đa N lần vẫn không bán được (có tag người nhận)',
};
// Các loại sự kiện thêm sau này — BotManager tự thêm 1 lần vào danh sách đã lưu của người dùng (xem migrateWebhookEvents)
const NEW_EVENTS = ['featuresReady', 'homeReturn', 'sellFailed', 'autoOrder'];
const DEFAULT_EVENTS = Object.keys(EVENT_LABELS);
// Các sự kiện "báo động" có dòng tiêu đề + tag người nhận (kiểu: ❌ BOT BỊ KICK @ai-đó)
const DEFAULT_MENTION_EVENTS = ['disconnect', 'reconnectFailed', 'spawnerThreat'];

const BRAND = DiscordTheme.BRAND;
const COLOR = DiscordTheme.COLOR;

class Notifier {
  constructor(cfg = {}) {
    this.url = cfg.webhookUrl || null;
    this.events = new Set(Array.isArray(cfg.webhookEvents) && cfg.webhookEvents.length ? cfg.webhookEvents : DEFAULT_EVENTS);
    this._queue = Promise.resolve();
    this.mention = '';
    this.mentionEvents = new Set(DEFAULT_MENTION_EVENTS);
    this.setMention(cfg.webhookMention, cfg.webhookMentionEvents);
  }
  // raw: ID số (ping thật) | <@id> | <@&roleId> | @everyone | @here | @tên (chỉ hiện chữ, KHÔNG ping được) | rỗng/off = tắt
  static formatMention(raw) {
    const t = String(raw || '').trim();
    if (!t || /^(off|none|0)$/i.test(t)) return '';
    if (/^\d{15,25}$/.test(t)) return `<@${t}>`;
    if (/^role:\d{15,25}$/i.test(t)) return `<@&${t.split(':')[1]}>`;
    if (/^<@[!&]?\d+>$/.test(t) || t === '@everyone' || t === '@here') return t;
    return t.startsWith('@') ? t : '@' + t;
  }
  setMention(raw, events) {
    this.mention = Notifier.formatMention(raw);
    if (Array.isArray(events) && events.length) this.mentionEvents = new Set(events);
  }
  // Chỉ cho Discord ping đúng những người/role/@everyone có trong tag (an toàn, không ping lung tung theo nội dung embed)
  _allowedMentions(content) {
    const users = [...content.matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
    const roles = [...content.matchAll(/<@&(\d+)>/g)].map(m => m[1]);
    const parse = /@everyone|@here/.test(content) ? ['everyone'] : [];
    return { parse, users, roles };
  }
  configure(url, events) {
    this.url = url || null;
    if (Array.isArray(events)) this.events = new Set(events);
  }
  get enabled() { return !!this.url; }
  isEventOn(eventKey) {
    return this.enabled && (!eventKey || this.events.has(eventKey) || this.events.has('all'));
  }
  static get EVENT_LABELS() { return EVENT_LABELS; }
  static get NEW_EVENTS() { return NEW_EVENTS; }
  static get BRAND() { return BRAND; }
  static get COLOR() { return COLOR; }
  static get THEME() { return DiscordTheme; }

  // Mọi embed đều có author, chân "Antertool" + timestamp, và kiểm tra giới hạn an toàn theo code point.
  // Không ghi đè nếu embed đã tự đặt footer/timestamp/author.
  static finish(embed, eventKey = null) {
    const e = { ...(embed || {}) };
    const inferredKey = DiscordTheme.inferEventKey(e.title, eventKey);
    const theme = DiscordTheme.getTheme(inferredKey);
    if (e.title && !DiscordTheme.formatEmbedTitle) {
      e.title = String(e.title);
    }
    if (!e.author || !e.author.name) {
      e.author = DiscordTheme.buildAuthor(BRAND);
    }
    if (!e.footer || !e.footer.text) {
      e.footer = { ...(e.footer || {}), text: BRAND };
    }
    if (!e.timestamp) {
      e.timestamp = new Date().toISOString();
    }
    if (e.color === undefined || e.color === null) {
      e.color = theme.color;
    }
    return DiscordTheme.enforceEmbedLimits(e);
  }

  // headline (tuỳ chọn): dòng chữ nằm TRÊN embed, ví dụ "❌ BOT BỊ KICK"; sự kiện nằm trong mentionEvents thì thêm tag phía sau.
  send(eventKey, embed, headline) {
    if (!this.isEventOn(eventKey)) return Promise.resolve(false);
    let content = '';
    if (headline) content = [headline, this.mentionEvents.has(eventKey) ? this.mention : ''].filter(Boolean).join(' ');
    const finished = Notifier.finish(embed, eventKey);
    this._queue = this._queue.then(() => this._post(finished, content)).catch(() => false);
    return this._queue;
  }

  testMention() {
    const now = Date.now();
    const theme = DiscordTheme.getTheme('testMention');
    return this._post({
      title: DiscordTheme.formatEmbedTitle('Bot Bị Kick (Tin Thử)', 'testMention'),
      description: [
        DiscordTheme.blockquote('Server đang bảo trì định kỳ (tin thử nghiệm)'),
        `Đây là tin thử — xem dòng tiêu đề phía trên có tag đúng người chưa (${DiscordTheme.discordTimestamp(now, 'R')}).`,
      ].join('\n'),
      color: theme.color,
      author: DiscordTheme.buildAuthor(BRAND),
      fields: [
        { name: 'Trạng thái', value: 'Tin thử, không phải sự cố thật', inline: true },
        { name: 'Tag người nhận', value: this.mention || '(chưa đặt)', inline: true },
        { name: 'Nguồn', value: BRAND, inline: true },
      ],
    }, ['❌ BOT BỊ KICK (test)', this.mention].filter(Boolean).join(' '));
  }

  test(embed) {
    const theme = DiscordTheme.getTheme('test');
    return this._post(embed || {
      title: DiscordTheme.formatEmbedTitle('Kiểm Tra Kết Nối Webhook', 'test'),
      description: `${BRAND} đã kết nối thành công tới Discord!`,
      color: theme.color,
      author: DiscordTheme.buildAuthor(BRAND),
      fields: [
        { name: 'Trạng thái', value: 'Hoạt động bình thường', inline: true },
        { name: 'Nguồn', value: `Minecraft ${BRAND}`, inline: true },
        { name: 'Thời gian', value: DiscordTheme.discordTimestamp(Date.now(), 'R'), inline: true },
      ],
    });
  }

  // Gửi lần lượt các mẫu embed thử nghiệm qua hàng đợi tuần tự (dùng cho lệnh console `webhook preview`)
  preview(opts = {}) {
    if (!this.url) return Promise.resolve({ ok: false, sent: 0, total: 0 });
    const items = DiscordTheme.buildPreviewPayloads(opts);
    if (!items.length) return Promise.resolve({ ok: false, sent: 0, total: 0 });
    let sent = 0;
    for (const item of items) {
      this._queue = this._queue
        .then(() => this._post(item.embed, item.content))
        .then(ok => { if (ok) sent++; return ok; })
        .catch(() => false);
    }
    return this._queue.then(() => ({ ok: sent === items.length, sent, total: items.length }));
  }

  _post(embed, content = '') {
    if (!this.url) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const u = new URL(this.url);
        const lib = u.protocol === 'http:' ? http : https;
        const body = { embeds: [Notifier.finish(embed)] };
        if (content) {
          const safeContent = DiscordTheme.truncateCodePoints(DiscordTheme.redactSecrets(content), 1900, '…');
          body.content = safeContent;
          body.allowed_mentions = this._allowedMentions(body.content);
        }
        const data = JSON.stringify(body);
        const req = lib.request(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: 8000,
        }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write(data);
        req.end();
      } catch { resolve(false); }
    });
  }
}

module.exports = Notifier;
