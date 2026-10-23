'use strict';
const https = require('https');
const http = require('http');
const DiscordTheme = require('./DiscordTheme');

/**
 * Notifier — Hệ thống thông báo Discord Webhook Hybrid v2 (Live Update + Anti-Spam) cho cả dàn bot.
 *
 * Kiến trúc mới (Hybrid):
 *  1. Gộp chung 1 Webhook duy nhất cho cả cảnh báo, báo cáo doanh thu và Bảng Trạng Thái Trực Tiếp (Live Dashboard).
 *  2. Hỗ trợ cập nhật tại chỗ (in-place edit) qua REST API chuẩn của Discord Webhook:
 *     - Tạo tin nhắn có lấy ID: `POST <webhookUrl>?wait=true` -> trả về JSON `{ id: "..." }`
 *     - Sửa tin nhắn tại chỗ:   `PATCH <webhookUrl>/messages/<messageId>` -> không đẩy thông báo mới, không làm tràn kênh!
 *     - Xoá tin nhắn:           `DELETE <webhookUrl>/messages/<messageId>`
 *     - Tự động fallback: nếu tin nhắn cũ đã bị xoá trên Discord (HTTP 404 Unknown Message), tự động gửi lại tin mới và cập nhật ID.
 *  3. Phân tầng chống tràn thông báo (Anti-Flood & Coalescing):
 *     - **Upsert theo Slot (`slotKey`)**: Bảng Live Panel (`panel:main`), báo cáo doanh thu (`rev:<botId>`, `rev:summary`),
 *       lịch nghỉ (`schedule`), AutoOrder (`autoOrder:<botId>`) luôn sửa đè trên đúng 1 tin nhắn cố định của slot đó.
 *     - **Gộp tin trùng (Dedup in-place)**: Cùng `eventKey + botId` lặp lại trong cửa sổ chống trùng (`dedupWindowMs`, mặc định 60s)
 *       sẽ tự động sửa (PATCH) tin nhắn vừa gửi kèm bộ đếm `🔄 Đã lặp lại ×N lần • lần cuối <t:unix:R>` thay vì bắn tin mới.
 *     - **Tự hồi phục thông minh (Auto-Resolve)**: Khi bot `reconnectRecovered` (đã kết nối lại ổn định), hệ thống tự động
 *       sửa (PATCH) ngay trên chính tin nhắn báo `disconnect` / `reconnectFailed` trước đó của bot đó thành trạng thái xanh ổn định!
 *     - **Chống bão thông báo (Storm Control / Digest)**: Nếu có quá nhiều sự kiện không khẩn cấp dồn dập trong 60s,
 *       tự động gộp vào 1 bản tin Digest duy nhất và sửa tại chỗ.
 *     - **Nhật ký sự kiện gần đây (`recentEvents`)**: Lưu vòng lặp các sự kiện vừa diễn ra để hiển thị trực tiếp trên Bảng Live Dashboard 10s.
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
const DEFAULT_MENTION_EVENTS = ['disconnect', 'reconnectFailed', 'spawnerThreat', 'sellFailed'];
// Các sự kiện định kỳ/trạng thái luôn cập nhật tại chỗ (in-place upsert) theo bot/nhóm để không bao giờ làm tràn kênh
const UPSERT_EVENTS = new Set([
  'revenue',
  'revenueMacro',
  'revenueSummary',
  'autoOrder',
  'featuresReady',
  'homeReturn',
  'autoSell',
  'moneyGoal',
  'schedule',
  'scheduleOut',
  'scheduleIn',
  'protectResult',
]);
// Các sự kiện khẩn cấp (Critical)
const CRITICAL_EVENTS = new Set(['disconnect', 'reconnectFailed', 'spawnerThreat', 'sellFailed']);

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

    // Chế độ Hybrid: 'hybrid' (mặc định: sửa tại chỗ + gộp tin + auto-resolve) | 'new' (luôn gửi tin mới kiểu cũ)
    this.mode = cfg.webhookMode || 'hybrid';
    this.dedupWindowMs = cfg.dedupWindowMs ?? 60000;
    this.stormMaxPerMin = cfg.stormMaxPerMin ?? 8;
    this._onMessagesChange = typeof cfg.onMessagesChange === 'function' ? cfg.onMessagesChange : null;

    // Lưu trữ messageId theo slotKey (bền vững qua config.json nếu có onMessagesChange)
    // Ví dụ slotKey: 'panel:main', 'rev:bot-1', 'rev:summary', 'inc:bot-1', 'state:bot-1:featuresReady'
    this._slots = new Map();
    if (cfg.webhookMessages && typeof cfg.webhookMessages === 'object') {
      for (const [k, v] of Object.entries(cfg.webhookMessages)) {
        if (v) this._slots.set(String(k), String(v));
      }
    }

    // Trạng thái Dedup & Auto-Resolve & Storm Control trong bộ nhớ
    this._dedupState = new Map();     // dedupKey -> { count, firstTs, lastTs, messageId, slotKey }
    this._activeIncidents = new Map(); // botKey -> { eventKey, messageId, ts }
    this._recentSentAt = [];          // timestamps gửi tin mới trong 60s gần nhất
    this._digestState = null;         // { windowStart, count, items: [], messageId }
    this._recentEvents = [];          // [{ key, botId, summary, ts, lastTs, count }] tối đa 25 mục cho Bảng Live Panel
    this._lastPanelSig = '';          // chữ ký Bảng Live Panel gần nhất để tránh PATCH thừa

    // Chẩn đoán & Rate-limit
    this._pauseUntil = 0;
    this._sentCount = 0;
    this._editedCount = 0;
    this._count429 = 0;
    this.lastError = null;
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
    const users = [...String(content || '').matchAll(/<@!?(\d+)>/g)].map(m => m[1]);
    const roles = [...String(content || '').matchAll(/<@&(\d+)>/g)].map(m => m[1]);
    const parse = /@everyone|@here/.test(String(content || '')) ? ['everyone'] : [];
    return { parse, users, roles };
  }

  configure(url, events, extra = {}) {
    const nextUrl = url ? String(url).trim() : null;
    const urlChanged = this.url && nextUrl && this.url !== nextUrl;
    this.url = nextUrl;
    if (Array.isArray(events)) this.events = new Set(events);
    if (extra.mode) this.mode = extra.mode;
    if (extra.webhookMessages && typeof extra.webhookMessages === 'object') {
      this._slots.clear();
      for (const [k, v] of Object.entries(extra.webhookMessages)) {
        if (v) this._slots.set(String(k), String(v));
      }
    } else if (urlChanged || !nextUrl) {
      // Đổi sang webhook khác -> xoá các messageId cũ vì không thuộc webhook mới
      this.resetSlots();
    }
  }

  resetSlots() {
    this._slots.clear();
    this._dedupState.clear();
    this._activeIncidents.clear();
    this._digestState = null;
    this._lastPanelSig = '';
    this._persistSlots();
  }

  _persistSlots() {
    if (typeof this._onMessagesChange === 'function') {
      try {
        this._onMessagesChange(Object.fromEntries(this._slots.entries()));
      } catch { /* ignore */ }
    }
  }

  getSlotMessageId(slotKey) {
    return this._slots.get(String(slotKey)) || null;
  }

  setSlotMessageId(slotKey, messageId) {
    const k = String(slotKey);
    if (!messageId) {
      if (this._slots.has(k)) {
        this._slots.delete(k);
        this._persistSlots();
      }
      return;
    }
    const v = String(messageId);
    if (this._slots.get(k) !== v) {
      this._slots.set(k, v);
      this._persistSlots();
    }
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

  getDiag() {
    return {
      enabled: this.enabled,
      mode: this.mode,
      sent: this._sentCount,
      edited: this._editedCount,
      count429: this._count429,
      activeSlots: this._slots.size,
      recentEvents: this._recentEvents.length,
      lastError: this.lastError,
    };
  }

  getRecentEvents(limit = 8) {
    return this._recentEvents.slice(0, Math.max(1, Number(limit) || 8));
  }

  /**
   * Ghi nhận sự kiện vào bộ nhớ vòng (hiển thị trên Bảng Live Dashboard 10s).
   */
  recordActivityEvent(eventKey, embed, botId = '') {
    if (!eventKey || eventKey === 'livePanel' || eventKey === 'test' || eventKey === 'testMention') return;
    const now = Date.now();
    const resolvedBot = botId || Notifier._extractBotIdFromEmbed(embed);
    const rawTitle = String(embed?.title || '').replace(/^[^\p{L}\p{N}/]+/u, '').trim();
    let summary = rawTitle || DiscordTheme.getTheme(eventKey).label || eventKey;

    if (eventKey === 'revenue' || eventKey === 'revenueMacro') {
      const stField = (embed?.fields || []).find(f => f.name === 'Trạng thái')?.value || '';
      const mLine = /Vòng vừa xong:\s*([^\n•]+)|Lần bán vừa xong:\s*([^\n•]+)/i.exec(stField);
      const totField = (embed?.fields || []).find(f => f.name === 'Tổng thu nhập')?.value || '';
      if (mLine) summary = `${(mLine[1] || mLine[2]).trim()}${totField ? ` • Tổng ${totField}` : ''}`;
      else if (totField) summary = `Tổng thu nhập ${totField}`;
    } else if (embed?.description) {
      const firstLine = String(embed.description)
        .split(/\r?\n/)
        .map(l => l.replace(/^>\s*/, '').trim())
        .find(l => l && !l.startsWith('```') && !l.startsWith('⏰'));
      if (firstLine) summary = `${summary} — ${DiscordTheme.truncateCodePoints(firstLine, 55)}`;
    }

    const head = this._recentEvents[0];
    if (head && head.key === eventKey && head.botId === resolvedBot && (now - head.lastTs < 120000)) {
      head.count = (head.count || 1) + 1;
      head.lastTs = now;
      head.summary = summary;
      return;
    }

    this._recentEvents.unshift({
      key: eventKey,
      botId: resolvedBot,
      summary,
      ts: now,
      lastTs: now,
      count: 1,
    });
    if (this._recentEvents.length > 25) this._recentEvents.length = 25;
  }

  static _extractBotIdFromEmbed(embed) {
    if (!embed || typeof embed !== 'object') return '';
    const playerField = (embed.fields || []).find(f => f.name === 'Người chơi')?.value || '';
    const m = /\(([^)]+)\)\s*$/.exec(playerField);
    if (m) return m[1].trim();
    if (playerField) return playerField.trim();
    const aName = embed.author?.name || '';
    const ma = /\(([^)]+)\)\s*$/.exec(aName);
    if (ma) return ma[1].trim();
    return '';
  }

  static _annotateDedupEmbed(embed, count, lastTs) {
    if (!count || count <= 1) return embed;
    const e = { ...embed };
    const badge = `🔄 **Đã lặp lại ×${count} lần** • Lần gần nhất ${DiscordTheme.discordTimestamp(lastTs, 'R')}`;
    e.description = e.description ? `${e.description}\n\n${badge}` : badge;
    return Notifier.finish(e);
  }

  // Mọi embed đều có author, chân "Antertool" + timestamp, và kiểm tra giới hạn an toàn theo code point.
  // Không ghi đè nếu embed đã tự đặt footer/timestamp/author.
  static finish(embed, eventKey = null) {
    const e = { ...(embed || {}) };
    const inferredKey = DiscordTheme.inferEventKey(e.title, eventKey);
    const theme = DiscordTheme.getTheme(inferredKey);
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

  /**
   * Gửi hoặc cập nhật thông báo Discord theo cơ chế Hybrid thông minh:
   *  - Ghi nhận sự kiện vào nhật ký cho Bảng Live Dashboard 10s.
   *  - Với sự kiện định kỳ/doanh thu/trạng thái (`revenue`, `autoOrder`, `featuresReady`, `homeReturn`, `schedule`...):
   *    tự động cập nhật tại chỗ (PATCH) trên slot cố định của bot đó để không đẻ thêm tin nhắn mới.
   *  - Với sự kiện `reconnectRecovered`: nếu bot đó đang có tin nhắn báo `disconnect` / `reconnectFailed` trước đó,
   *    tự động sửa (PATCH) ngay tin báo động đó thành trạng thái Đã Kết Nối Lại Ổn Định (Auto-Resolve).
   *  - Với cảnh báo lặp lại trong cửa sổ `dedupWindowMs`: tự động sửa (PATCH) tin nhắn trước đó kèm số lần lặp `×N`.
   *  - Có thể truyền `opts.slotKey` để chỉ định vị trí sửa tại chỗ hoặc `opts.forceNew = true` để buộc gửi tin mới.
   */
  send(eventKey, embed, headline, opts = {}) {
    const inferredKey = DiscordTheme.inferEventKey(embed?.title, eventKey);
    const checkKey = eventKey || (inferredKey && EVENT_LABELS[inferredKey] ? inferredKey : null);
    if (!this.isEventOn(checkKey)) return Promise.resolve(false);

    let content = '';
    if (headline) {
      const shouldMention = (checkKey && this.mentionEvents.has(checkKey)) || (inferredKey && this.mentionEvents.has(inferredKey));
      content = [headline, shouldMention ? this.mention : ''].filter(Boolean).join(' ');
    }

    const effectiveKey = inferredKey || checkKey || 'info';
    const finished = Notifier.finish(embed, effectiveKey);
    const botId = opts.botId || Notifier._extractBotIdFromEmbed(finished);

    // Luôn ghi nhận vào lịch sử sự kiện gần đây của Bảng Live Dashboard
    this.recordActivityEvent(effectiveKey, finished, botId);

    // Nếu người dùng cấu hình chế độ 'new' (cũ) hoặc yêu cầu forceNew rõ ràng
    if (this.mode === 'new' || opts.forceNew === true) {
      this._queue = this._queue.then(() => this._post(finished, content)).catch(() => false);
      return this._queue;
    }

    // 1. Tự hồi phục (Auto-Resolve): khi bot kết nối lại ổn định, sửa ngay tin nhắn báo kick/mất kết nối trước đó của bot đó!
    if (effectiveKey === 'reconnectRecovered' && botId && this._activeIncidents.has(botId)) {
      const inc = this._activeIncidents.get(botId);
      this._activeIncidents.delete(botId);
      // Xoá luôn trạng thái dedup của lần disconnect đó để lần kick sau (nếu có) tạo cảnh báo mới
      this._dedupState.delete(`disconnect|${botId}`);
      this._dedupState.delete(`reconnectFailed|${botId}`);
      if (inc && inc.messageId) {
        const resolvedEmbed = Notifier.finish({
          ...finished,
          description: `${finished.description || ''}\n✅ *Đã tự động khắc phục sự cố mất kết nối trước đó.*`.trim(),
        }, 'reconnectRecovered');
        this._queue = this._queue
          .then(() => this._editOrPost(inc.messageId, resolvedEmbed, '', `inc:${botId}`))
          .then(res => {
            this.setSlotMessageId(`inc:${botId}`, null);
            return !!res.ok;
          })
          .catch(() => false);
        return this._queue;
      }
    }

    // 2. Xác định Slot Upsert cho các sự kiện trạng thái / báo cáo định kỳ (không bao giờ làm tràn kênh)
    let slotKey = opts.slotKey || null;
    if (!slotKey && UPSERT_EVENTS.has(effectiveKey)) {
      if (effectiveKey === 'revenueSummary') slotKey = 'rev:summary';
      else if (effectiveKey === 'revenue' || effectiveKey === 'revenueMacro') slotKey = `rev:${botId || 'all'}:${effectiveKey}`;
      else if (effectiveKey === 'schedule' || effectiveKey === 'scheduleOut' || effectiveKey === 'scheduleIn') slotKey = 'schedule:main';
      else slotKey = `state:${botId || 'all'}:${effectiveKey}`;
    }

    if (slotKey) {
      this._queue = this._queue
        .then(() => this._upsertSlot(slotKey, finished, content))
        .catch(() => false);
      return this._queue;
    }

    // 3. Gộp tin trùng (Dedup in-place) cho các sự kiện cảnh báo cùng loại trên cùng 1 bot
    const now = Date.now();
    const dedupKey = `${effectiveKey}|${botId || ''}`;
    const existing = this._dedupState.get(dedupKey);
    if (existing && existing.messageId && (now - existing.firstTs <= this.dedupWindowMs)) {
      existing.count += 1;
      existing.lastTs = now;
      const countSnap = existing.count;
      const lastTsSnap = existing.lastTs;
      const msgIdSnap = existing.messageId;
      const annotated = Notifier._annotateDedupEmbed(finished, countSnap, lastTsSnap);
      this._queue = this._queue
        .then(async () => {
          const r = await this._patchMessage(msgIdSnap, annotated, content);
          if (r.ok) return true;
          if (r.notFound) {
            const p = await this._postWithWait(annotated, content);
            if (p.ok && p.id) {
              existing.messageId = p.id;
              if (CRITICAL_EVENTS.has(effectiveKey) && botId) {
                this._activeIncidents.set(botId, { eventKey: effectiveKey, messageId: p.id, ts: now });
              }
            }
            return !!p.ok;
          }
          return false;
        })
        .catch(() => false);
      return this._queue;
    }

    // 4. Kiểm tra chống bão tin (Storm Control) cho các sự kiện không khẩn cấp
    if (!CRITICAL_EVENTS.has(effectiveKey) && this._shouldCollapseIntoDigest(now)) {
      return this._enqueueDigest(effectiveKey, finished, botId, now);
    }

    // 5. Gửi tin nhắn mới (kèm ?wait=true để lưu messageId phục vụ Dedup và Auto-Resolve)
    const entry = {
      count: 1,
      firstTs: now,
      lastTs: now,
      messageId: null,
    };
    this._dedupState.set(dedupKey, entry);
    if (this._dedupState.size > 200) {
      for (const [k, v] of this._dedupState) {
        if (now - v.lastTs > Math.max(this.dedupWindowMs, 120000)) this._dedupState.delete(k);
      }
    }

    this._queue = this._queue
      .then(async () => {
        const res = await this._postWithWait(finished, content);
        if (res.ok && res.id) {
          entry.messageId = res.id;
          if ((effectiveKey === 'disconnect' || effectiveKey === 'reconnectFailed') && botId) {
            this._activeIncidents.set(botId, { eventKey: effectiveKey, messageId: res.id, ts: now });
          }
        }
        return !!res.ok;
      })
      .catch(() => false);
    return this._queue;
  }

  /**
   * Cập nhật tại chỗ (Upsert) Bảng Trạng Thái & Doanh Thu Trực Tiếp (Live Dashboard) mỗi 10s.
   *  - Nếu `opts.force !== true` và chữ ký dữ liệu (`livePanelSig`) không đổi khi toàn bộ bot đều đang nghỉ/offline,
   *    bỏ qua lệnh gọi mạng để tránh hao phí rate-limit.
   *  - Nếu `opts.fresh === true`: gửi bảng mới và lưu lại ID mới.
   */
  updateLivePanel(snapshot = {}, opts = {}) {
    if (!this.enabled) return Promise.resolve(false);
    const sig = DiscordTheme.livePanelSig(snapshot);
    const anyOnline = Array.isArray(snapshot.bots) && snapshot.bots.some(b => b.connState === 'ONLINE' || b.connState === 'RECONNECTING');
    const prevId = this.getSlotMessageId('panel:main');

    if (!opts.force && !opts.fresh && prevId && sig === this._lastPanelSig && !anyOnline) {
      return Promise.resolve(true);
    }
    this._lastPanelSig = sig;
    const embed = DiscordTheme.buildLivePanelEmbed({
      ...snapshot,
      recentEvents: snapshot.recentEvents || this.getRecentEvents(6),
    });

    if (opts.fresh) {
      this.setSlotMessageId('panel:main', null);
    }
    this._queue = this._queue
      .then(() => this._upsertSlot('panel:main', embed, ''))
      .catch(() => false);
    return this._queue;
  }

  _shouldCollapseIntoDigest(now = Date.now()) {
    this._recentSentAt = this._recentSentAt.filter(t => now - t < 60000);
    if (this._recentSentAt.length >= this.stormMaxPerMin) return true;
    this._recentSentAt.push(now);
    return false;
  }

  _enqueueDigest(eventKey, embed, botId, now = Date.now()) {
    if (!this._digestState || (now - this._digestState.windowStart >= 60000)) {
      this._digestState = {
        windowStart: now,
        count: 0,
        items: [],
        messageId: null,
      };
    }
    const d = this._digestState;
    d.count += 1;
    const rawTitle = String(embed?.title || '').replace(/^[^\p{L}\p{N}/]+/u, '').trim();
    const existingItem = d.items.find(it => it.key === eventKey && it.botId === botId);
    if (existingItem) {
      existingItem.count += 1;
      existingItem.lastTs = now;
    } else {
      d.items.push({
        key: eventKey,
        botId,
        summary: rawTitle || DiscordTheme.getTheme(eventKey).label,
        count: 1,
        lastTs: now,
      });
    }
    const digestEmbed = DiscordTheme.buildDigestEmbed(d, now);
    this._queue = this._queue
      .then(async () => {
        if (d.messageId) {
          const r = await this._patchMessage(d.messageId, digestEmbed, '');
          if (r.ok) return true;
          if (!r.notFound) return false;
        }
        const p = await this._postWithWait(digestEmbed, '');
        if (p.ok && p.id) d.messageId = p.id;
        return !!p.ok;
      })
      .catch(() => false);
    return this._queue;
  }

  async _upsertSlot(slotKey, embed, content = '') {
    const prevId = this.getSlotMessageId(slotKey);
    if (prevId) {
      const r = await this._patchMessage(prevId, embed, content);
      if (r.ok) return true;
      if (!r.notFound) return false;
      this.setSlotMessageId(slotKey, null);
    }
    const p = await this._postWithWait(embed, content);
    if (p.ok && p.id) {
      this.setSlotMessageId(slotKey, p.id);
    }
    return !!p.ok;
  }

  async _editOrPost(messageId, embed, content = '', slotKey = null) {
    if (messageId) {
      const r = await this._patchMessage(messageId, embed, content);
      if (r.ok) return { ok: true, id: messageId, edited: true };
      if (!r.notFound) return { ok: false, id: messageId, edited: false };
    }
    const p = await this._postWithWait(embed, content);
    if (p.ok && p.id && slotKey) this.setSlotMessageId(slotKey, p.id);
    return p;
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

  _buildRequestBody(embed, content = '') {
    const body = { embeds: [Notifier.finish(embed)] };
    if (content) {
      const safeContent = DiscordTheme.truncateCodePoints(DiscordTheme.redactSecrets(content), 1900, '…');
      body.content = safeContent;
      body.allowed_mentions = this._allowedMentions(body.content);
    } else {
      body.content = '';
      body.allowed_mentions = { parse: [], users: [], roles: [] };
    }
    return body;
  }

  async _waitRateLimit() {
    const waitMs = Math.min(30000, this._pauseUntil - Date.now());
    if (waitMs > 0) {
      await new Promise(r => { const t = setTimeout(r, waitMs); if (t.unref) t.unref(); });
    }
  }

  /**
   * Gửi HTTP request cấp thấp tới Discord Webhook (hỗ trợ POST ?wait=true, PATCH /messages/:id, DELETE /messages/:id).
   * Tự động đọc `retry_after` khi gặp HTTP 429 và thử lại 1 lần.
   */
  async _request(method, targetUrl, bodyObj = null, retryCount = 0) {
    if (!this.url) return { ok: false, statusCode: 0, data: null };
    await this._waitRateLimit();

    const res = await new Promise((resolve) => {
      try {
        const u = new URL(targetUrl);
        const lib = u.protocol === 'http:' ? http : https;
        const payloadStr = bodyObj !== null ? JSON.stringify(bodyObj) : '';
        const headers = {};
        if (bodyObj !== null) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payloadStr);
        }
        const req = lib.request(u, {
          method,
          headers,
          timeout: 8000,
        }, (httpRes) => {
          const chunks = [];
          httpRes.on('data', c => chunks.push(c));
          httpRes.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            if (raw) {
              try { parsed = JSON.parse(raw); } catch { parsed = null; }
            }
            resolve({
              ok: httpRes.statusCode >= 200 && httpRes.statusCode < 300,
              statusCode: httpRes.statusCode || 0,
              headers: httpRes.headers || {},
              data: parsed,
            });
          });
          httpRes.on('error', () => resolve({ ok: false, statusCode: 0, data: null }));
        });
        req.on('error', (e) => {
          this.lastError = e.message;
          resolve({ ok: false, statusCode: 0, data: null });
        });
        req.on('timeout', () => {
          this.lastError = 'timeout';
          req.destroy();
          resolve({ ok: false, statusCode: 0, data: null });
        });
        if (bodyObj !== null) req.write(payloadStr);
        req.end();
      } catch (e) {
        this.lastError = e.message;
        resolve({ ok: false, statusCode: 0, data: null });
      }
    });

    if (res.statusCode === 429) {
      this._count429 += 1;
      const retryAfterSec = Number(res.data?.retry_after ?? res.headers?.['retry-after'] ?? 2) || 2;
      const waitMs = Math.min(15000, Math.ceil(retryAfterSec * 1000) + 150);
      this._pauseUntil = Date.now() + waitMs;
      if (retryCount < 1) {
        await this._waitRateLimit();
        return this._request(method, targetUrl, bodyObj, retryCount + 1);
      }
    }

    if (res.ok) this.lastError = null;
    else if (res.statusCode) this.lastError = `HTTP ${res.statusCode}`;
    return res;
  }

  async _postWithWait(embed, content = '') {
    if (!this.url) return { ok: false, id: null };
    try {
      const u = new URL(this.url);
      u.searchParams.set('wait', 'true');
      const body = this._buildRequestBody(embed, content);
      // Nếu không có content, xóa trường content rỗng khi POST mới để payload gọn chuẩn như cũ
      if (!content) {
        delete body.content;
        delete body.allowed_mentions;
      }
      const res = await this._request('POST', u.toString(), body);
      if (res.ok) this._sentCount += 1;
      const id = res.data && res.data.id ? String(res.data.id) : null;
      return { ok: res.ok, id };
    } catch {
      return { ok: false, id: null };
    }
  }

  async _patchMessage(messageId, embed, content = '') {
    if (!this.url || !messageId) return { ok: false, notFound: true };
    try {
      const u = new URL(this.url);
      u.pathname = u.pathname.replace(/\/+$/, '') + `/messages/${encodeURIComponent(String(messageId))}`;
      const body = this._buildRequestBody(embed, content);
      const res = await this._request('PATCH', u.toString(), body);
      if (res.ok) {
        this._editedCount += 1;
        return { ok: true, id: String(messageId), notFound: false };
      }
      const notFound = res.statusCode === 404 || (res.data && Number(res.data.code) === 10008);
      return { ok: false, notFound };
    } catch {
      return { ok: false, notFound: false };
    }
  }

  async deleteMessage(messageId) {
    if (!this.url || !messageId) return false;
    try {
      const u = new URL(this.url);
      u.pathname = u.pathname.replace(/\/+$/, '') + `/messages/${encodeURIComponent(String(messageId))}`;
      const res = await this._request('DELETE', u.toString(), null);
      return res.ok || res.statusCode === 404;
    } catch {
      return false;
    }
  }

  _post(embed, content = '') {
    if (!this.url) return Promise.resolve(false);
    return this._postWithWait(embed, content).then(r => !!r.ok);
  }
}

Notifier.UPSERT_EVENTS = UPSERT_EVENTS;
Notifier.CRITICAL_EVENTS = CRITICAL_EVENTS;
module.exports = Notifier;
