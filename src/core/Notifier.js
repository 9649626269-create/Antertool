'use strict';
const https = require('https');
const http = require('http');

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
// Phong cách embed: tiêu đề Viết Hoa Từng Chữ, field nằm ngang (inline), chân embed "Antertool • Hôm nay lúc HH:mm"
// (Discord tự ghép timestamp vào cạnh footer.text). Màu lấy theo mẫu: xanh = kết nối/ổn, cam = báo cáo tổng kết.
const BRAND = 'Antertool';
const COLOR = { ok: 0x6ef16f, report: 0xcf8338 };

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
  // Mọi embed đều có chân "Antertool" + timestamp (Discord hiện "Antertool • Hôm nay lúc 00:13"); không ghi đè nếu embed đã tự đặt.
  static finish(embed) {
    const e = { ...embed };
    if (!e.footer || !e.footer.text) e.footer = { ...(e.footer || {}), text: BRAND };
    if (!e.timestamp) e.timestamp = new Date().toISOString();
    return e;
  }
  // headline (tuỳ chọn): dòng chữ nằm TRÊN embed, ví dụ "❌ BOT BỊ KICK"; sự kiện nằm trong mentionEvents thì thêm tag phía sau.
  send(eventKey, embed, headline) {
    if (!this.isEventOn(eventKey)) return Promise.resolve(false);
    let content = '';
    if (headline) content = [headline, this.mentionEvents.has(eventKey) ? this.mention : ''].filter(Boolean).join(' ');
    this._queue = this._queue.then(() => this._post(embed, content)).catch(() => false);
    return this._queue;
  }
  testMention() {
    return this._post({
      title: 'Bot Bị Kick (Tin Thử)', description: 'Đây là tin thử — xem dòng tiêu đề phía trên có tag đúng người chưa.',
      color: 0xf97316,
      fields: [{ name: 'Trạng thái', value: 'Tin thử, không phải sự cố thật', inline: true }, { name: 'Nguồn', value: BRAND, inline: true }],
    }, ['❌ BOT BỊ KICK (test)', this.mention].filter(Boolean).join(' '));
  }
  test(embed) {
    return this._post(embed || {
      title: 'Kiểm Tra Kết Nối Webhook',
      description: `${BRAND} đã kết nối thành công tới Discord!`,
      color: COLOR.ok,
      fields: [
        { name: 'Trạng thái', value: 'Hoạt động bình thường', inline: true },
        { name: 'Nguồn', value: `Minecraft ${BRAND}`, inline: true },
      ],
    });
  }
  _post(embed, content = '') {
    if (!this.url) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const u = new URL(this.url);
        const lib = u.protocol === 'http:' ? http : https;
        const body = { embeds: [Notifier.finish(embed)] };
        if (content) { body.content = content.substring(0, 1900); body.allowed_mentions = this._allowedMentions(body.content); }
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
