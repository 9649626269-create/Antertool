'use strict';
const https = require('https');
const http = require('http');

/**
 * TelegramNotifier — gửi / sửa tin nhắn qua Telegram Bot API, nhận lệnh bằng long polling.
 * Chỉ dùng https/http có sẵn của Node, không phụ thuộc thư viện ngoài.
 *
 *  - Mọi lệnh gọi API xếp hàng tuần tự (this._queue) → đúng thứ tự, không dội request.
 *  - Chỉ nhận lệnh/nút bấm từ ĐÚNG chatId đã cấu hình (người khác nhắn bot thì bị bỏ qua).
 *  - Polling dùng getUpdates (không cần mở cổng/webhook) — chạy được trên Codespaces, Render, Docker.
 *  - apiBase đổi được (dùng cho test với server giả).
 */
const EVENT_LABELS = {
  disconnect: 'Ngắt kết nối / bị kick',
  reconnectFailed: 'Hết lượt reconnect',
  reconnectRecovered: 'Đã kết nối lại ổn định',
  sellFailed: 'autosell_spawn bán lỗi sau N lần /home',
  spawnerThreat: 'Cảnh báo Bảo vệ Lồng Spawn',
  moneyGoal: 'Đủ tiền (Money Goal)',
  autoSell: 'Đầy túi đồ (Auto-sell)',
  featuresReady: 'Đã bật spawnerprotect + autosell_spawn',
  homeReturn: 'Lệch vị trí treo lồng / đã về',
  schedule: 'Lịch tự out/vào',
};
const DEFAULT_EVENTS = ['disconnect', 'reconnectFailed', 'reconnectRecovered', 'sellFailed', 'spawnerThreat'];

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Chữ kiểu Discord (**đậm**, `mã`) -> HTML của Telegram. Bỏ tag Discord (<@id>, @everyone).
function discordToHtml(s) {
  let t = String(s ?? '').replace(/ ?<@[!&]?\d+>/g, '').replace(/ ?@(everyone|here)\b/g, '');
  t = escapeHtml(t);
  t = t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return t.replace(/[ \t]+\n/g, '\n').trim();
}

class TelegramNotifier {
  constructor(cfg = {}) {
    this.token = null;
    this.chatId = null;
    this.apiBase = cfg.apiBase || 'https://api.telegram.org';
    this.events = new Set(DEFAULT_EVENTS);
    this._queue = Promise.resolve();
    this.pending = 0;          // số lệnh gọi API đang chờ trong hàng đợi
    this._pauseUntil = 0;      // Telegram báo 429 (gửi quá nhanh) -> tạm dừng tới mốc này
    this._polling = false;
    this._offset = 0;
    this._pollReq = null;
    this._onCommand = null;
    this.lastError = null;
    this.configure(cfg.token, cfg.chatId, cfg.events);
  }
  configure(token, chatId, events) {
    this.token = token ? String(token).trim() : null;
    this.chatId = chatId !== undefined && chatId !== null && chatId !== '' ? String(chatId).trim() : null;
    if (Array.isArray(events) && events.length) this.events = new Set(events);
  }
  get enabled() { return !!(this.token && this.chatId); }
  get hasToken() { return !!this.token; }
  get paused() { return Date.now() < this._pauseUntil; }
  isEventOn(key) { return this.enabled && (!key || this.events.has(key) || this.events.has('all')); }
  static get EVENT_LABELS() { return EVENT_LABELS; }
  static get DEFAULT_EVENTS() { return DEFAULT_EVENTS; }
  static escapeHtml(s) { return escapeHtml(s); }
  static discordToHtml(s) { return discordToHtml(s); }
  static looksLikeToken(t) { return /^\d{6,12}:[\w-]{30,}$/.test(String(t || '').trim()); }

  // Gọi 1 method của Bot API. Trả về { ok, result, description, error_code } — không bao giờ throw.
  _call(method, payload = {}, timeoutMs = 10000) {
    if (!this.token) return Promise.resolve({ ok: false, description: 'chưa có token' });
    return new Promise((resolve) => {
      let done = false;
      const fin = (r) => { if (!done) { done = true; resolve(r); } };
      try {
        const u = new URL(`${this.apiBase}/bot${this.token}/${method}`);
        const lib = u.protocol === 'http:' ? http : https;
        const data = JSON.stringify(payload);
        const req = lib.request(u, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: timeoutMs,
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try {
              const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (j && j.ok === false && j.error_code === 429) { // gửi quá nhanh -> nghỉ đúng số giây Telegram yêu cầu
                this._pauseUntil = Date.now() + ((j.parameters && j.parameters.retry_after) || 5) * 1000 + 200;
              }
              fin(j);
            }
            catch { fin({ ok: false, description: `HTTP ${res.statusCode}` }); }
          });
          res.on('error', () => fin({ ok: false, description: 'lỗi đọc phản hồi' }));
        });
        req.on('error', (e) => fin({ ok: false, description: e.message }));
        req.on('timeout', () => { req.destroy(); fin({ ok: false, description: 'timeout' }); });
        if (method === 'getUpdates') this._pollReq = req;
        req.write(data);
        req.end();
      } catch (e) { fin({ ok: false, description: e.message }); }
    });
  }
  _enqueue(fn) {
    this.pending++;
    const p = this._queue.then(fn).catch(() => ({ ok: false }));
    this._queue = p.then(() => { this.pending--; }, () => { this.pending--; });
    return p;
  }
  _body(text, { keyboard, silent } = {}) {
    const b = {
      chat_id: this.chatId, text: String(text).substring(0, 4000), parse_mode: 'HTML',
      disable_web_page_preview: true,
    };
    if (silent) b.disable_notification = true;
    if (keyboard) b.reply_markup = { inline_keyboard: keyboard };
    return b;
  }
  // Gửi tin mới. Trả về message_id (hoặc null nếu lỗi).
  send(text, opts = {}) {
    if (!this.enabled) return Promise.resolve(null);
    return this._enqueue(async () => {
      const wait = Math.min(30000, this._pauseUntil - Date.now()); // đang bị giới hạn tốc độ -> chờ rồi gửi (cảnh báo không được mất)
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      const r = await this._call('sendMessage', this._body(text, opts));
      this.lastError = r.ok ? null : (r.description || 'lỗi');
      return r.ok ? r.result.message_id : null;
    });
  }
  // Sửa tin đã gửi (bảng cập nhật tại chỗ, không ting ting). Tin bị xoá/không sửa được -> gửi tin mới.
  // Trả về message_id đang dùng (có thể khác messageId cũ).
  edit(messageId, text, opts = {}) {
    if (!this.enabled) return Promise.resolve(null);
    if (!messageId) return this.send(text, opts);
    if (this.paused) return Promise.resolve(messageId); // đang bị giới hạn tốc độ: bỏ qua lần sửa này (lần sau sửa tiếp)
    return this._enqueue(async () => {
      if (this.paused) return messageId;
      const r = await this._call('editMessageText', { ...this._body(text, opts), message_id: messageId });
      if (r.ok) { this.lastError = null; return messageId; }
      const d = String(r.description || '');
      if (/not modified/i.test(d)) return messageId; // nội dung y hệt -> coi như xong
      // Chỉ gửi bảng mới khi tin cũ thật sự không còn sửa được. Lỗi tạm thời (429, mạng, timeout) -> giữ bảng cũ, tránh đẻ bảng trùng
      if (!/message to edit not found|message can't be edited|MESSAGE_ID_INVALID|message identifier is not specified/i.test(d)) {
        this.lastError = d || 'lỗi';
        return messageId;
      }
      const r2 = await this._call('sendMessage', this._body(text, opts)); // tin cũ bị xoá / quá cũ -> gửi lại
      this.lastError = r2.ok ? null : (r2.description || d || 'lỗi');
      return r2.ok ? r2.result.message_id : null;
    });
  }
  // Gửi thử — trả về { ok, message }
  async test() {
    if (!this.hasToken) return { ok: false, message: 'Chưa có token' };
    const me = await this._call('getMe');
    if (!me.ok) return { ok: false, message: `Token sai hoặc không gọi được Telegram (${me.description})` };
    if (!this.chatId) return { ok: false, message: `Token đúng (bot @${me.result.username}) nhưng chưa có chat_id — nhắn /start cho bot rồi gõ: telegram chatid` };
    const id = await this.send(`✅ <b>Antertool</b> đã kết nối Telegram (bot @${escapeHtml(me.result.username)}).`);
    return id ? { ok: true, message: `Đã gửi tin thử qua @${me.result.username}` } : { ok: false, message: `Gửi thất bại: ${this.lastError || 'không rõ lý do'} (kiểm tra chat_id; nhớ nhắn /start cho bot trước)` };
  }
  // Tìm chat_id từ những tin gần nhất gửi cho bot — [{ id, title }]
  async discoverChats() {
    const r = await this._call('getUpdates', { timeout: 0, limit: 50, allowed_updates: ['message', 'callback_query'] });
    if (!r.ok) return { ok: false, message: r.description || 'lỗi', chats: [] };
    const seen = new Map();
    for (const u of r.result || []) {
      const c = u.message?.chat || u.callback_query?.message?.chat;
      if (!c) continue;
      seen.set(String(c.id), c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id));
    }
    return { ok: true, chats: [...seen].map(([id, title]) => ({ id, title })) };
  }

  // ===== Nhận lệnh (long polling) =====
  // onCommand({ type:'command'|'button', cmd, arg, reply(text, opts), answer(text) })
  startPolling(onCommand) {
    this._onCommand = onCommand;
    if (this._polling || !this.hasToken) return;
    this._polling = true;
    this._pollLoop();
  }
  stopPolling() {
    this._polling = false;
    try { this._pollReq?.destroy(); } catch { }
    this._pollReq = null;
  }
  async _pollLoop() {
    let backoff = 2000;
    while (this._polling) {
      const r = await this._call('getUpdates', { offset: this._offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35000);
      if (!this._polling) break;
      if (!r.ok) {
        // 409 = có nơi khác đang getUpdates cùng token; lỗi mạng -> lùi dần rồi thử lại
        await new Promise(res => { const t = setTimeout(res, backoff); if (t.unref) t.unref(); });
        backoff = Math.min(60000, backoff * 2);
        continue;
      }
      backoff = 2000;
      for (const u of r.result || []) {
        this._offset = Math.max(this._offset, u.update_id + 1);
        try { await this._handleUpdate(u); } catch { /* lệnh lỗi không được làm chết vòng polling */ }
      }
    }
  }
  async _handleUpdate(u) {
    const cb = u.callback_query;
    const msg = u.message;
    const chat = cb ? cb.message?.chat : msg?.chat;
    if (!chat || String(chat.id) !== this.chatId) return; // chỉ phục vụ đúng chat đã cấu hình
    if (!this._onCommand) return;
    const reply = (text, opts) => this.send(text, opts);
    if (cb) {
      const [cmd, ...rest] = String(cb.data || '').split(':');
      await this._onCommand({ type: 'button', cmd, arg: rest.join(':'), messageId: cb.message.message_id, reply,
        answer: (t) => this._call('answerCallbackQuery', { callback_query_id: cb.id, text: t ? String(t).substring(0, 180) : undefined }) });
      return;
    }
    const text = String(msg?.text || '').trim();
    const m = /^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/.exec(text);
    if (!m) return;
    await this._onCommand({ type: 'command', cmd: m[1].toLowerCase(), arg: (m[2] || '').trim(), reply, answer: () => { } });
  }
}
module.exports = TelegramNotifier;
