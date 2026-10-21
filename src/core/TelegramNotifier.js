'use strict';
const https = require('https');
const http = require('http');
const { dbg } = require('./debug');
const { sym } = require('./Symbols');

/**
 * TelegramNotifier — gửi / sửa tin nhắn qua Telegram Bot API, nhận lệnh bằng long polling.
 * Chỉ dùng https/http có sẵn của Node, không phụ thuộc thư viện ngoài.
 *
 *  - Hàng đợi ưu tiên P0..P5 (số nhỏ ưu tiên cao hơn), giới hạn kích thước (mặc định 200).
 *  - Xử lý bảng mã lỗi Telegram (400 entity fallback, 400 migrate_to_chat_id, 401/403 disable, 409 backoff, 429 retry_after).
 *  - Lọc backlog lúc khởi động và kiểm tra TTL lệnh theo Date header của server Telegram.
 */
const EVENT_LABELS = {
  disconnect: 'Ngắt kết nối / bị kick',
  reconnectFailed: 'Hết lượt reconnect',
  reconnectRecovered: 'Đã kết nối lại ổn định',
  connected: 'Đã vào server',
  featuresReady: 'Đã bật spawnerprotect + autosell_spawn',
  sellCycle: 'Xong vòng bán lồng',
  sellFailed: 'autosell_spawn bán lỗi sau N lần /home',
  homeReturn: 'Lệch vị trí treo lồng / đã về',
  spawnerThreat: 'Cảnh báo Bảo vệ Lồng Spawn',
  protectResult: 'Kết quả xử lý bảo vệ lồng',
  autoSell: 'Đầy túi đồ (Auto-sell)',
  moneyGoal: 'Đủ tiền (Money Goal)',
  autoOrder: 'Báo cáo định kỳ AutoOrder',
  schedule: 'Lịch tự out/vào',
  macro: 'Chạy / kết thúc / lỗi Macro',
  proxy: 'Xoay proxy / lỗi proxy',
  posLost: 'Mất vị trí treo lồng',
  system: 'Khởi động / tắt / lỗi hệ thống',
  revenue: 'Báo cáo doanh thu',
};
const DEFAULT_EVENTS = ['disconnect', 'reconnectFailed', 'reconnectRecovered', 'sellFailed', 'spawnerThreat'];

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtmlTags(s) {
  return String(s ?? '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
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
    this.botUsername = cfg.botUsername || null;
    this.apiBase = cfg.apiBase || 'https://api.telegram.org';
    this.events = new Set(DEFAULT_EVENTS);
    this._now = typeof cfg.nowFn === 'function' ? cfg.nowFn : () => Date.now();
    this.maxQueue = cfg.maxQueue ?? 200;
    this.maxAgeSec = cfg.maxAgeSec ?? 600;
    this.discardBacklog = cfg.discardBacklog === true;
    this.commandTtlSec = cfg.commandTtlSec ?? 120;
    this._onMigrateChat = typeof cfg.onMigrateChat === 'function' ? cfg.onMigrateChat : null;

    this._pq = [];
    this._seq = 0;
    this._workerRunning = false;
    this._queue = Promise.resolve();
    this.pending = 0;
    this._pauseUntil = 0;
    this._disabledByAuth = false;
    this._polling = false;
    this._offset = 0;
    this._pollReq = null;
    this._onCommand = null;
    this._backlogCleared = !this.discardBacklog;
    this._serverClockOffsetMs = 0;

    this.lastError = null;
    this._lastSuccessAt = 0;
    this._sentCount = 0;
    this._editedCount = 0;
    this._count429 = 0;
    this._droppedCount = 0;

    this.configure(cfg.token, cfg.chatId, cfg.events);
  }

  configure(token, chatId, events) {
    this.token = token ? String(token).trim() : null;
    this.chatId = chatId !== undefined && chatId !== null && chatId !== '' ? String(chatId).trim() : null;
    this._disabledByAuth = false;
    if (Array.isArray(events) && events.length) this.events = new Set(events);
  }

  get enabled() { return !!(this.token && this.chatId && !this._disabledByAuth); }
  get hasToken() { return !!this.token; }
  get paused() { return Date.now() < this._pauseUntil; }
  isEventOn(key) { return this.enabled && (!key || this.events.has(key) || this.events.has('all')); }
  static get EVENT_LABELS() { return EVENT_LABELS; }
  static get DEFAULT_EVENTS() { return DEFAULT_EVENTS; }
  static escapeHtml(s) { return escapeHtml(s); }
  static discordToHtml(s) { return discordToHtml(s); }
  static looksLikeToken(t) { return /^\d{6,12}:[\w-]{30,}$/.test(String(t || '').trim()); }

  getDiag() {
    return {
      queueLen: this._pq.length,
      queueLength: this._pq.length,
      pending: this.pending,
      paused: this.paused,
      pauseUntil: this._pauseUntil,
      pausedUntil: this._pauseUntil,
      lastSuccessAt: this._lastSuccessAt,
      lastError: this.lastError,
      sent: this._sentCount,
      edited: this._editedCount,
      count429: this._count429,
      rateLimited429: this._count429,
      dropped: this._droppedCount,
      droppedCount: this._droppedCount,
    };
  }

  _call(method, payload = {}, timeoutMs = 10000, raw = null) {
    if (!this.token) return Promise.resolve({ ok: false, description: 'chưa có token' });
    return new Promise((resolve) => {
      let done = false;
      const fin = (r) => { if (!done) { done = true; resolve(r); } };
      try {
        const u = new URL(`${this.apiBase}/bot${this.token}/${method}`);
        const lib = u.protocol === 'http:' ? http : https;
        const data = raw ? raw.body : JSON.stringify(payload);
        const req = lib.request(u, {
          method: 'POST',
          headers: { 'Content-Type': raw ? raw.type : 'application/json', 'Content-Length': Buffer.byteLength(data) },
          timeout: timeoutMs,
        }, (res) => {
          const dateHdr = res.headers?.date;
          let serverNow = null;
          if (dateHdr) {
            const parsed = Date.parse(dateHdr);
            if (!Number.isNaN(parsed)) {
              serverNow = parsed;
              this._serverClockOffsetMs = parsed - Date.now();
            }
          }
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try {
              const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (serverNow !== null && j && typeof j === 'object') j.serverNow = serverNow;
              if (j && j.ok) {
                this._lastSuccessAt = this._now();
              } else if (j && j.ok === false) {
                const code = j.error_code || res.statusCode;
                if (code === 429) {
                  this._count429++;
                  const retrySec = (j.parameters && j.parameters.retry_after) || 5;
                  this._pauseUntil = Date.now() + retrySec * 1000 + 200;
                } else if (code === 401 || code === 403) {
                  this._disabledByAuth = true;
                  this.lastError = j.description || `HTTP ${code}`;
                }
              }
              fin(j);
            } catch {
              fin({ ok: false, error_code: res.statusCode, description: `HTTP ${res.statusCode}` });
            }
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

  _enqueue(fn, priority = 3) {
    if (this._pq.length >= this.maxQueue) {
      let worstIdx = -1;
      let worstPrio = -1;
      for (let i = 0; i < this._pq.length; i++) {
        if (this._pq[i].priority >= worstPrio) {
          worstPrio = this._pq[i].priority;
          worstIdx = i;
        }
      }
      if (worstIdx >= 0 && worstPrio >= priority) {
        const [dropped] = this._pq.splice(worstIdx, 1);
        this._droppedCount++;
        try { dropped.resolve(null); } catch { /* ignore */ }
      } else {
        this._droppedCount++;
        return Promise.resolve(null);
      }
    }

    this.pending++;
    return new Promise((resolve) => {
      const item = { fn, priority: Number(priority) || 3, seq: ++this._seq, resolve };
      this._pq.push(item);
      this._pq.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
      this._drainQueue();
    });
  }

  _drainQueue() {
    if (this._workerRunning) return;
    this._workerRunning = true;
    const step = async () => {
      while (this._pq.length > 0) {
        const item = this._pq.shift();
        let res = null;
        try {
          res = await item.fn();
        } catch {
          res = null;
        } finally {
          this.pending = Math.max(0, this.pending - 1);
          try { item.resolve(res); } catch { /* ignore */ }
        }
      }
      this._workerRunning = false;
    };
    this._queue = step();
  }

  _body(text, { keyboard, silent, plain = false } = {}) {
    const b = {
      chat_id: this.chatId,
      text: String(text).substring(0, 4096),
      disable_web_page_preview: true,
    };
    if (!plain) b.parse_mode = 'HTML';
    if (silent !== undefined) b.disable_notification = !!silent;
    if (keyboard) b.reply_markup = { inline_keyboard: keyboard };
    return b;
  }

  send(text, opts = {}) {
    if (!this.enabled) return Promise.resolve(null);
    const prio = opts.priority !== undefined ? Number(opts.priority) : 3;
    const enqueuedAt = opts.enqueuedAt !== undefined ? Number(opts.enqueuedAt) : null;
    const isCrit = !!(opts.crit || opts.isCrit);
    const maxAgeSec = opts.maxAgeSec !== undefined ? Number(opts.maxAgeSec) : this.maxAgeSec;

    return this._enqueue(async () => {
      if (!this.enabled) return null;
      if (enqueuedAt !== null && maxAgeSec > 0) {
        const ageMs = this._now() - enqueuedAt;
        if (ageMs > maxAgeSec * 1000) {
          if (!isCrit) {
            this._droppedCount++;
            return null;
          }
          const lateMinutes = Math.max(1, Math.round(ageMs / 60000));
          if (typeof opts.onStaleCrit === 'function') {
            text = opts.onStaleCrit(lateMinutes);
          } else {
            text = `${text} (trễ ${lateMinutes}m)`;
          }
        }
      }

      const wait = Math.min(30000, this._pauseUntil - Date.now());
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      if (!this.enabled) return null;

      let r = await this._call('sendMessage', this._body(text, opts));
      if (!r.ok && r.error_code === 400) {
        const desc = String(r.description || '');
        if (r.parameters && r.parameters.migrate_to_chat_id) {
          const newId = String(r.parameters.migrate_to_chat_id);
          this.chatId = newId;
          if (this._onMigrateChat) {
            try { this._onMigrateChat(newId); } catch (e) { dbg('TelegramNotifier', e); }
          }
          r = await this._call('sendMessage', this._body(text, opts));
        } else if (/can't parse entities/i.test(desc)) {
          const plainText = stripHtmlTags(text);
          r = await this._call('sendMessage', this._body(plainText, { ...opts, plain: true }));
        }
      }

      this.lastError = r.ok ? null : (r.description || 'lỗi');
      if (r.ok) this._sentCount++;
      return r.ok ? r.result.message_id : null;
    }, prio);
  }

  deleteMessage(messageId) {
    if (!this.enabled || !messageId) return Promise.resolve(false);
    return this._enqueue(async () => {
      if (!this.enabled) return false;
      const r = await this._call('deleteMessage', { chat_id: this.chatId, message_id: messageId });
      return !!r.ok;
    }, 1);
  }

  _docFields(opts = {}) {
    const fields = { chat_id: this.chatId };
    if (opts.caption) { fields.caption = String(opts.caption).substring(0, 1000); fields.parse_mode = 'HTML'; }
    if (opts.silent) fields.disable_notification = 'true';
    if (opts.keyboard) fields.reply_markup = JSON.stringify({ inline_keyboard: opts.keyboard });
    return fields;
  }

  sendDocument(filename, content, opts = {}) {
    if (!this.enabled) return Promise.resolve(null);
    return this._enqueue(async () => {
      const wait = Math.min(30000, this._pauseUntil - Date.now());
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      const r = await this._call('sendDocument', null, 30000, TelegramNotifier.multipart(this._docFields(opts), 'document', filename, content));
      this.lastError = r.ok ? null : (r.description || 'lỗi');
      return r.ok ? r.result.message_id : null;
    }, opts.priority ?? 5);
  }

  editDocument(messageId, filename, content, opts = {}) {
    const bad = { ok: false, id: messageId || null };
    if (!this.enabled) return Promise.resolve(bad);
    if (!messageId) return this.sendDocument(filename, content, opts).then(id => (id && typeof id !== 'object' ? { ok: true, id } : bad));
    return this._enqueue(async () => {
      const wait = Math.min(30000, this._pauseUntil - Date.now());
      if (wait > 0) await new Promise(res => setTimeout(res, wait));
      const media = { type: 'document', media: 'attach://file' };
      if (opts.caption) { media.caption = String(opts.caption).substring(0, 1000); media.parse_mode = 'HTML'; }
      const fields = { chat_id: this.chatId, message_id: messageId, media: JSON.stringify(media) };
      if (opts.keyboard) fields.reply_markup = JSON.stringify({ inline_keyboard: opts.keyboard });
      const r = await this._call('editMessageMedia', null, 30000, TelegramNotifier.multipart(fields, 'file', filename, content));
      if (r.ok) { this.lastError = null; return { ok: true, id: messageId }; }
      const d = String(r.description || '');
      if (/not modified/i.test(d)) return { ok: true, id: messageId };
      if (!/message to edit not found|message can't be edited|MESSAGE_ID_INVALID|message identifier is not specified/i.test(d)) {
        this.lastError = d || 'lỗi';
        return { ok: false, id: messageId };
      }
      const r2 = await this._call('sendDocument', null, 30000, TelegramNotifier.multipart(this._docFields({ ...opts, silent: true }), 'document', filename, content));
      this.lastError = r2.ok ? null : (r2.description || d || 'lỗi');
      return r2.ok ? { ok: true, id: r2.result.message_id } : { ok: false, id: messageId };
    }, opts.priority ?? 5).then(r => (r && typeof r.ok === 'boolean' ? r : bad));
  }

  static multipart(fields, fileField, filename, content) {
    const boundary = '----antertool' + Math.random().toString(16).slice(2) + Date.now().toString(16);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
    }
    const safe = String(filename).replace(/[^\w.-]/g, '_');
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${safe}"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`, 'utf8'));
    parts.push(Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8'));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
  }

  edit(messageId, text, opts = {}) {
    if (!this.enabled) return Promise.resolve(null);
    if (!messageId) return this.send(text, opts);
    if (this.paused) return Promise.resolve(messageId);
    const prio = opts.priority !== undefined ? Number(opts.priority) : 4;
    return this._enqueue(async () => {
      if (!this.enabled) return null;
      if (this.paused) return messageId;
      const r = await this._call('editMessageText', { ...this._body(text, opts), message_id: messageId });
      if (r.ok) { this.lastError = null; this._editedCount++; return messageId; }
      const d = String(r.description || '');
      if (/not modified/i.test(d)) return messageId;
      if (!/message to edit not found|message can't be edited|MESSAGE_ID_INVALID|message identifier is not specified/i.test(d)) {
        this.lastError = d || 'lỗi';
        return messageId;
      }
      const r2 = await this._call('sendMessage', this._body(text, opts));
      this.lastError = r2.ok ? null : (r2.description || d || 'lỗi');
      if (r2.ok) this._sentCount++;
      return r2.ok ? r2.result.message_id : null;
    }, prio);
  }

  /**
   * Đăng ký danh sách gợi ý lệnh khi gõ '/' trên Telegram (setMyCommands + nút Menu).
   */
  async syncCommands(commands = []) {
    if (!this.hasToken) return { ok: false, description: 'chưa có token' };
    const clean = [];
    for (const item of commands || []) {
      if (!item || typeof item !== 'object') continue;
      const command = String(item.command || '').trim().toLowerCase().replace(/^\/+/, '');
      const description = String(item.description || '').trim().slice(0, 256);
      if (/^[a-z0-9_]{1,32}$/.test(command) && description.length >= 3) {
        clean.push({ command, description });
      }
      if (clean.length >= 100) break;
    }
    if (!clean.length) return { ok: false, description: 'danh sách lệnh trống' };
    const r = await this._call('setMyCommands', { commands: clean });
    if (this.chatId) {
      await this._call('setMyCommands', {
        commands: clean,
        scope: { type: 'chat', chat_id: this.chatId },
      }).catch(() => {});
      await this._call('setChatMenuButton', {
        chat_id: this.chatId,
        menu_button: { type: 'commands' },
      }).catch(() => {});
    }
    await this._call('setChatMenuButton', {
      menu_button: { type: 'commands' },
    }).catch(() => {});
    return r;
  }

  async clearCommands() {
    if (!this.hasToken) return { ok: false, description: 'chưa có token' };
    const r = await this._call('deleteMyCommands', {});
    if (this.chatId) {
      await this._call('deleteMyCommands', {
        scope: { type: 'chat', chat_id: this.chatId },
      }).catch(() => {});
    }
    return r;
  }

  async test() {
    if (!this.hasToken) return { ok: false, message: 'Chưa có token' };
    const me = await this._call('getMe');
    if (!me.ok) return { ok: false, message: `Token sai hoặc không gọi được Telegram (${me.description})` };
    if (me.result?.username) this.botUsername = me.result.username;
    if (!this.chatId) return { ok: false, message: `Token đúng (bot @${me.result.username}) nhưng chưa có chat_id — nhắn /start cho bot rồi gõ: telegram chatid` };
    const id = await this.send(`${sym('ok')} <b>Antertool</b> đã kết nối Telegram (bot @${escapeHtml(me.result.username)}).`, { priority: 1 });
    return id ? { ok: true, message: `Đã gửi tin thử qua @${me.result.username}` } : { ok: false, message: `Gửi thất bại: ${this.lastError || 'không rõ lý do'} (kiểm tra chat_id; nhớ nhắn /start cho bot trước)` };
  }

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

  startPolling(onCommand) {
    this._onCommand = onCommand;
    if (this._polling || !this.hasToken) return;
    this._polling = true;
    this._backlogCleared = !this.discardBacklog;
    this._pollLoop();
  }

  stopPolling() {
    this._polling = false;
    try { this._pollReq?.destroy(); } catch (e) { dbg('TelegramNotifier', e); }
    this._pollReq = null;
  }

  async _pollLoop() {
    let backoff = 2000;
    while (this._polling) {
      const isInitialDrain = !this._backlogCleared;
      const r = await this._call(
        'getUpdates',
        { offset: this._offset, timeout: isInitialDrain ? 0 : 25, allowed_updates: ['message', 'callback_query'] },
        35000
      );
      if (!this._polling) break;
      if (!r.ok) {
        const waitMs = r.error_code === 409 ? 30000 : backoff;
        await new Promise(res => { const t = setTimeout(res, waitMs); if (t.unref) t.unref(); });
        backoff = r.error_code === 409 ? 30000 : Math.min(60000, backoff * 2);
        continue;
      }
      backoff = 2000;
      const list = r.result || [];
      if (isInitialDrain) {
        for (const u of list) {
          this._offset = Math.max(this._offset, u.update_id + 1);
        }
        this._backlogCleared = true;
        continue;
      }
      const refNowMs = r.serverNow || (Date.now() + this._serverClockOffsetMs);
      for (const u of list) {
        this._offset = Math.max(this._offset, u.update_id + 1);
        try { await this._handleUpdate(u, refNowMs); } catch { /* lệnh lỗi không được làm chết vòng polling */ }
      }
    }
  }

  async _handleUpdate(u, refNowMs = Date.now()) {
    if (u.edited_message || u.channel_post || u.edited_channel_post) return;
    const cb = u.callback_query;
    const msg = u.message;
    const chat = cb ? cb.message?.chat : msg?.chat;
    const from = cb ? cb.from : msg?.from;
    const senderChat = cb ? cb.message?.sender_chat : msg?.sender_chat;
    if (senderChat || from?.is_bot) return;
    if (!chat || String(chat.id) !== this.chatId) return;
    if (!this._onCommand) return;

    if (msg && msg.date && this.commandTtlSec > 0) {
      const ageSec = (refNowMs / 1000) - Number(msg.date);
      if (ageSec > this.commandTtlSec) return;
    }

    const reply = (text, opts) => this.send(text, { priority: 1, ...(opts || {}) });
    if (cb) {
      const [cmd, ...rest] = String(cb.data || '').split(':');
      await this._onCommand({
        type: 'button',
        cmd,
        arg: rest.join(':'),
        data: String(cb.data || ''),
        from,
        chat,
        messageId: cb.message?.message_id,
        reply,
        answer: (t) => this._call('answerCallbackQuery', { callback_query_id: cb.id, text: t ? String(t).substring(0, 180) : undefined }),
      });
      return;
    }
    const text = String(msg?.text || '').trim();
    const m = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(text);
    if (!m) return;
    if (m[2] && this.botUsername && m[2].toLowerCase() !== this.botUsername.toLowerCase()) return;
    await this._onCommand({
      type: 'command',
      cmd: m[1].toLowerCase(),
      arg: (m[3] || '').trim(),
      rawText: text,
      from,
      chat,
      messageId: msg?.message_id,
      reply,
      answer: () => {},
    });
  }
}

module.exports = TelegramNotifier;
