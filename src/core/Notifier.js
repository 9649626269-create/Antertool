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
};
const DEFAULT_EVENTS = Object.keys(EVENT_LABELS);

class Notifier {
  constructor(cfg = {}) {
    this.url = cfg.webhookUrl || null;
    this.events = new Set(Array.isArray(cfg.webhookEvents) && cfg.webhookEvents.length ? cfg.webhookEvents : DEFAULT_EVENTS);
    this._queue = Promise.resolve();
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
  send(eventKey, embed) {
    if (!this.isEventOn(eventKey)) return Promise.resolve(false);
    this._queue = this._queue.then(() => this._post(embed)).catch(() => false);
    return this._queue;
  }
  test(embed) {
    return this._post(embed || {
      title: '✅ Test webhook thành công',
      description: 'Anter đã kết nối được tới webhook này.',
      color: 0x22d3ee,
      timestamp: new Date().toISOString(),
    });
  }
  _post(embed) {
    if (!this.url) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const u = new URL(this.url);
        const lib = u.protocol === 'http:' ? http : https;
        const data = JSON.stringify({ embeds: [embed] });
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
