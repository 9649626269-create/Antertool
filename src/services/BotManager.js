'use strict';
const BotSession = require('../core/BotSession');
const ProxyManager = require('../core/ProxyManager');
const EnvironmentDetector = require('../core/EnvironmentDetector');
const Persistence = require('../core/Persistence');
const SharedPool = require('../core/SharedPool');
const Notifier = require('../core/Notifier');
const RevenueTracker = require('../core/RevenueTracker');
const TelegramNotifier = require('../core/TelegramNotifier');
const TelegramPanel = require('../core/TelegramPanel');
const { pickTheme, TIMING, CS, CAPACITY, resolveVersion } = require('../core/constants');
class BotManager {
  constructor(options = {}) {
    this.configPath = options.configPath || require('path').join(process.cwd(), 'config.json');
    this.autoExe = options.autoExe || false;
    this.io = options.io || null;
    this.onBotLog = typeof options.onBotLog === 'function' ? options.onBotLog : null;
    this.bots = [];
    this._activeConnects = 0;
    this.envDetector = new EnvironmentDetector(this.autoExe);
    this.persistence = new Persistence(this.configPath);
    this.proxyManager = new ProxyManager(this.io, this.persistence);
    this.sharedPool = SharedPool.global();
    this.notifier = new Notifier({});
    this.revenueNotifier = new Notifier({}); // webhook RIÊNG cho báo cáo doanh thu (không đặt thì dùng webhook chung)
    this.revenue = new RevenueTracker(require('path').join(require('path').dirname(this.configPath), 'revenue.json'), () => this._scheduleTz());
    this.telegram = new TelegramNotifier({}); // bảng Auto sell spawner + cảnh báo qua Telegram (không đặt token thì không làm gì)
    this._tgMsgs = {};                        // botId -> message_id của bảng (để sửa tại chỗ, khỏi spam)
    this._tgLastAt = new Map();               // botId -> lần gửi bảng gần nhất (chống dội)
    this._tgChain = new Map();                // botId -> chuỗi gửi bảng đang chờ (tránh tạo 2 bảng trùng)
    this._tgBusy = new Set();                 // bot đang có lần gửi/sửa bảng chưa xong (nhịp 1s bỏ qua bot này)
    this._tgSig = new Map();                  // botId -> "chữ ký" trạng thái bảng gửi gần nhất (bot offline chỉ sửa khi chữ ký đổi)
    this._tgRR = 0;                           // vòng xoay: mỗi nhịp sửa 1 bảng
    this.dashboard = null;
    this._config = null;
    this._poolPruneInterval = setInterval(() => this.sharedPool.pruneCache(), 10 * 60 * 1000);
    this._inRest = false;
    this._scheduleInterval = setInterval(() => this._scheduleTick(), 20000);
    this._beatInterval = setInterval(() => { for (const b of this.bots) { if (b.isOnline) this.revenue.touch(b.cfg.id); } }, 5 * 60000); // nhịp tim đếm giờ chạy
    if (this._beatInterval.unref) this._beatInterval.unref();
  }
  async init() {
    this._config = this.persistence.load();
    this._migrateWebhookEvents();
    this.notifier.configure(this._config.webhookUrl, this._config.webhookEvents);
    this.notifier.setMention(this._config.webhookMention, this._config.webhookMentionEvents);
    this.revenueNotifier.configure(this._config.revenueWebhookUrl, ['all']);
    this._armRevenueSummary();
    this._initTelegram();
    this.autoExe = this._config.autoExe === true || this.autoExe;
    const { env, profile } = this.envDetector.getAdaptiveProfile();
    this.env = env;
    this.profile = profile;
    if (Array.isArray(this._config.proxies) || this._config.proxyAssignments) {
      this.proxyManager.loadFromConfig(this._config.proxies || [], this._config.proxyAssignments || {});
    }
    const botCfgs = this._config.bots || [];
    for (let i = 0; i < botCfgs.length; i++) {
      const cfg = botCfgs[i];
      const bot = this._createBotFromConfig(cfg, i);
      this.bots.push(bot);
    }
    return this;
  }
  // Các cài đặt của trình tự khởi động / tự về home (đọc từ bot, không có thì lấy ở cấp toàn cục config.json, không có nữa thì dùng mặc định của BotSession)
  static STARTUP_KEYS = [
    'loginSuccessPattern', 'loginConfirmTimeoutMs',
    'spawnHomeEnabled', 'spawnHomeCommand', 'spawnHomeGraceMs', 'spawnHomeConfirmMs', 'spawnHomeCooldownMs', 'spawnHomeMaxTries', 'spawnHomeSlowMs',
    'spawnPositionSettleMs', 'spawnGateTimeoutMs',
  ];
  _startupFields(src) {
    const out = {};
    for (const k of BotManager.STARTUP_KEYS) {
      const v = src?.[k] !== undefined ? src[k] : this._config?.[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
    return out;
  }
  // Danh sách loại sự kiện webhook người dùng đã lưu từ trước chưa có các loại mới -> thêm 1 lần cho mỗi loại mới
  // (sau đó bạn tắt bớt bằng "webhook events ..." thì giữ nguyên, không tự thêm lại).
  _migrateWebhookEvents() {
    const c = this._config;
    if (!c) return;
    const done = new Set(Array.isArray(c.webhookEventsMigrated) ? c.webhookEventsMigrated : []);
    const add = Notifier.NEW_EVENTS.filter(k => !done.has(k));
    if (!add.length) return;
    c.webhookEventsMigrated = [...done, ...add];
    this.persistence.set('webhookEventsMigrated', c.webhookEventsMigrated);
    if (Array.isArray(c.webhookEvents) && c.webhookEvents.length && !c.webhookEvents.includes('all')) {
      c.webhookEvents = [...new Set([...c.webhookEvents, ...add])];
      this.persistence.set('webhookEvents', c.webhookEvents);
    }
  }
  _wireBotLog(bot) {
    if (this.onBotLog) {
      bot.on('log', entry => {
        try { this.onBotLog(bot.cfg.id, entry); } catch { }
      });
    }
  }
  _createBotFromConfig(cfg, index) {
    const merged = {
      host: cfg.host || this._config.host,
      port: cfg.port || this._config.port,
      version: resolveVersion(cfg.version, this._config.version),
      username: cfg.username,
      ownerUsername: cfg.ownerUsername || this._config.ownerUsername,
      registered: cfg.registered !== undefined ? cfg.registered : false,
      botPassword: cfg.botPassword || this._config.botPassword,
      respawn: cfg.respawn !== undefined ? cfg.respawn : (this._config.respawn !== undefined ? this._config.respawn : true),
      useProxy: cfg.useProxy !== undefined ? cfg.useProxy : (this._config.useProxy !== undefined ? this._config.useProxy : false),
      autoMenu: cfg.autoMenu !== undefined ? cfg.autoMenu : (this._config.autoMenu !== undefined ? this._config.autoMenu : true),
      menuCommand: cfg.menuCommand || this._config.menuCommand || '/menu',
      clientSettings: cfg.clientSettings || null,
      sendClientSettings: cfg.sendClientSettings !== undefined ? cfg.sendClientSettings : true,
      skipValidation: cfg.skipValidation !== undefined ? cfg.skipValidation : false,
      viewDistance: cfg.viewDistance || null,
      id: cfg.id,
      theme: cfg.theme || 'teal',
      authMode: cfg.authMode || 'offline', // 'offline' (mặc định, /dn qua chat) hoặc 'microsoft' (acc Premium thật)
      macros: cfg.macros || this._config.macros || {},
      moneyGoal: cfg.moneyGoal ?? this._config.moneyGoal ?? null,
      moneyGoalMacro: cfg.moneyGoalMacro || this._config.moneyGoalMacro || null,
      autoSellMacro: cfg.autoSellMacro || null,
      autoSellThreshold: cfg.autoSellThreshold ?? 90,
      autoSellRevenue: cfg.autoSellRevenue ?? true,
      autoSellMsgKeyword: cfg.autoSellMsgKeyword || '',
      autoSellMsgPattern: cfg.autoSellMsgPattern || '',
      autoSellIgnoreChat: cfg.autoSellIgnoreChat ?? true,
      autoSellReportMin: cfg.autoSellReportMin ?? 0,
      spawnerProtectOn: cfg.spawnerProtectOn ?? this._config.spawnerProtectOn ?? false,
      spawnerProtectRange: cfg.spawnerProtectRange ?? this._config.spawnerProtectRange ?? null,
      spawnerAutoDisconnect: cfg.spawnerAutoDisconnect ?? this._config.spawnerAutoDisconnect ?? false,
      spawnerAutoMine: cfg.spawnerAutoMine ?? this._config.spawnerAutoMine ?? true,
      spawnerRequireSilk: cfg.spawnerRequireSilk ?? this._config.spawnerRequireSilk ?? true,
      spawnerSaveRange: cfg.spawnerSaveRange ?? this._config.spawnerSaveRange ?? 5,
      enderChestCommand: cfg.enderChestCommand ?? this._config.enderChestCommand ?? '/ec',
      spawnerWhitelist: cfg.spawnerWhitelist || this._config.spawnerWhitelist || [],
      protectedSpawners: cfg.protectedSpawners || [],
      autoSellSpawnOn: cfg.autoSellSpawnOn ?? false,
      autoSellSpawnList: cfg.autoSellSpawnList || [],
      autoSellSpawnSlot: cfg.autoSellSpawnSlot ?? 51,
      autoSellSpawnButton: cfg.autoSellSpawnButton ?? 0,
      autoSellSpawnSecond: cfg.autoSellSpawnSecond,
      autoSellSpawnMinute: cfg.autoSellSpawnMinute,
      autoSellSpawnHour: cfg.autoSellSpawnHour,
      autoSellSpawnRange: cfg.autoSellSpawnRange ?? 5,
      autoSellSpawnRevenue: cfg.autoSellSpawnRevenue ?? true,
      autoSellSpawnMsgKeyword: cfg.autoSellSpawnMsgKeyword || '',
      autoSellSpawnMsgPattern: cfg.autoSellSpawnMsgPattern || '',
      autoSellSpawnIgnoreChat: cfg.autoSellSpawnIgnoreChat ?? true,
      autoSellSpawnReportMin: cfg.autoSellSpawnReportMin ?? 0,
      afkTabNoise: cfg.afkTabNoise ?? this._config.afkTabNoise ?? false,
      settingsProfile: cfg.settingsProfile ?? this._config.settingsProfile ?? 'vanilla',
      pingServerInfo: cfg.pingServerInfo ?? this._config.pingServerInfo ?? null,
      proxyAutoRotate: cfg.proxyAutoRotate ?? this._config.proxyAutoRotate ?? false,
      proxyRotateMinMinutes: cfg.proxyRotateMinMinutes ?? this._config.proxyRotateMinMinutes ?? 1,
      proxyRotateMaxMinutes: cfg.proxyRotateMaxMinutes ?? this._config.proxyRotateMaxMinutes ?? 10,
      ...this._startupFields(cfg),
    };
    const theme = pickTheme(merged.theme, index);
    const bot = new BotSession(merged, theme, this.proxyManager, { io: this.io });
    bot._manager = this;
    this._wireBotLog(bot);
    if (this._config.settings) {
      Object.assign(bot.settings, this._config.settings);
    }
    return bot;
  }
  _createBotFromData(data) {
    const index = this.bots.length;
    const cfg = {
      id: data.id,
      host: data.host || this._config.host,
      port: data.port || this._config.port,
      version: resolveVersion(data.version, this._config.version),
      username: data.username,
      ownerUsername: data.ownerUsername || this._config.ownerUsername,
      botPassword: data.password || data.botPassword || this._config.botPassword,
      registered: data.registered !== undefined ? data.registered : false,
      useProxy: data.useProxy !== undefined ? data.useProxy : false,
      autoMenu: data.autoMenu !== undefined ? data.autoMenu : true,
      menuCommand: data.menuCommand || '/menu',
      clientSettings: data.clientSettings || null,
      sendClientSettings: data.sendClientSettings !== undefined ? data.sendClientSettings : true,
      skipValidation: data.skipValidation !== undefined ? data.skipValidation : false,
      viewDistance: data.viewDistance || null,
      authMode: data.authMode || 'offline',
      theme: data.theme || 'teal',
      macros: data.macros || this._config.macros || {},
      moneyGoal: data.moneyGoal ?? this._config.moneyGoal ?? null,
      moneyGoalMacro: data.moneyGoalMacro || this._config.moneyGoalMacro || null,
      autoSellMacro: data.autoSellMacro || null,
      autoSellThreshold: data.autoSellThreshold ?? 90,
      autoSellRevenue: data.autoSellRevenue ?? true,
      autoSellMsgKeyword: data.autoSellMsgKeyword || '',
      autoSellMsgPattern: data.autoSellMsgPattern || '',
      autoSellIgnoreChat: data.autoSellIgnoreChat ?? true,
      autoSellReportMin: data.autoSellReportMin ?? 0,
      spawnerProtectOn: data.spawnerProtectOn ?? this._config.spawnerProtectOn ?? false,
      spawnerProtectRange: data.spawnerProtectRange ?? this._config.spawnerProtectRange ?? null,
      spawnerAutoDisconnect: data.spawnerAutoDisconnect ?? this._config.spawnerAutoDisconnect ?? false,
      spawnerAutoMine: data.spawnerAutoMine ?? this._config.spawnerAutoMine ?? true,
      spawnerRequireSilk: data.spawnerRequireSilk ?? this._config.spawnerRequireSilk ?? true,
      spawnerSaveRange: data.spawnerSaveRange ?? this._config.spawnerSaveRange ?? 5,
      enderChestCommand: data.enderChestCommand ?? this._config.enderChestCommand ?? '/ec',
      spawnerWhitelist: data.spawnerWhitelist || this._config.spawnerWhitelist || [],
      protectedSpawners: data.protectedSpawners || [],
      autoSellSpawnOn: data.autoSellSpawnOn ?? false,
      autoSellSpawnList: data.autoSellSpawnList || [],
      autoSellSpawnSlot: data.autoSellSpawnSlot ?? 51,
      autoSellSpawnButton: data.autoSellSpawnButton ?? 0,
      autoSellSpawnSecond: data.autoSellSpawnSecond,
      autoSellSpawnMinute: data.autoSellSpawnMinute,
      autoSellSpawnHour: data.autoSellSpawnHour,
      autoSellSpawnRange: data.autoSellSpawnRange ?? 5,
      autoSellSpawnRevenue: data.autoSellSpawnRevenue ?? true,
      autoSellSpawnMsgKeyword: data.autoSellSpawnMsgKeyword || '',
      autoSellSpawnMsgPattern: data.autoSellSpawnMsgPattern || '',
      autoSellSpawnIgnoreChat: data.autoSellSpawnIgnoreChat ?? true,
      autoSellSpawnReportMin: data.autoSellSpawnReportMin ?? 0,
      afkTabNoise: data.afkTabNoise ?? this._config.afkTabNoise ?? false,
      settingsProfile: data.settingsProfile ?? this._config.settingsProfile ?? 'vanilla',
      pingServerInfo: data.pingServerInfo ?? this._config.pingServerInfo ?? null,
      proxyAutoRotate: data.proxyAutoRotate ?? this._config.proxyAutoRotate ?? false,
      proxyRotateMinMinutes: data.proxyRotateMinMinutes ?? this._config.proxyRotateMinMinutes ?? 1,
      proxyRotateMaxMinutes: data.proxyRotateMaxMinutes ?? this._config.proxyRotateMaxMinutes ?? 10,
      ...this._startupFields(data),
    };
    const theme = pickTheme(cfg.theme, index);
    const bot = new BotSession(cfg, theme, this.proxyManager, { io: this.io });
    bot._manager = this;
    this._wireBotLog(bot);
    if (this._config.settings) {
      Object.assign(bot.settings, this._config.settings);
    }
    if (typeof data.proxyIdx === 'number') {
      bot.proxy = this.proxyManager.list[data.proxyIdx] || null;
      if (bot.proxy) {
        this.proxyManager.assignBot(cfg.id, data.proxyIdx);
      }
    } else if (data.proxyId) {
      bot.proxy = this.proxyManager.list.find(p => p.id === data.proxyId) || null;
      if (bot.proxy) {
        this.proxyManager.assignBot(cfg.id, data.proxyId);
      }
    }
    const savedProxy = this.proxyManager.getAssignment(cfg.id);
    if (savedProxy) {
      bot.proxy = savedProxy;
    }
    if (!this._config.bots) this._config.bots = [];
    this._config.bots.push(cfg);
    this.persistence.markDirty();
    this.persistence.saveSync();
    return bot;
  }
  createBot(data) {
    const bot = this._createBotFromData(data);
    this.bots.push(bot);
    return bot;
  }
  removeBot(id) {
    const idx = this.bots.findIndex(b => b.cfg.id.toLowerCase() === id.toLowerCase());
    if (idx === -1) return null;
    const bot = this.bots[idx];
    const actualId = bot.cfg.id;
    bot.shutdown();
    this.bots.splice(idx, 1);
    this.proxyManager.unassignBot(actualId);
    if (this._config.bots) {
      this._config.bots = this._config.bots.filter(c => c.id.toLowerCase() !== actualId.toLowerCase());
      this.persistence.markDirty();
      this.persistence.saveSync();
    }
    return bot;
  }
  findBot(id) {
    return this.bots.find(b => b.cfg.id.toLowerCase() === (id || '').toLowerCase());
  }
  startAll(filterFn = null) {
    const targets = filterFn ? this.bots.filter(filterFn) : this.bots;
    let stagger = 0;
    for (const bot of targets) {
      if (!bot.isConnected && !bot.isReconnecting && !bot._disabled) {
        bot._disabled = false;
        bot.state.reconnects = 0;
        if (stagger > 0) {
          setTimeout(() => bot.start(), stagger);
        } else {
          bot.start();
        }
        stagger += TIMING.CONNECT_STAGGER_MS || 250;
      }
    }
    return targets.length;
  }
  stopAll(filterFn = null) {
    const targets = filterFn ? this.bots.filter(filterFn) : this.bots;
    for (const bot of targets) bot.shutdown();
    return targets.length;
  }
  restartAll(filterFn = null) {
    const targets = filterFn ? this.bots.filter(filterFn) : this.bots;
    let stagger = 0;
    for (const bot of targets) {
      bot.cancelReconnect();
      bot._cleanupOnDisconnect();
      bot._destroyMc();
      bot.state.reconnects = 0;
      bot._fastKicks = 0;
      bot._disabled = false;
      bot._setState(CS.DISCONNECTED);
      if (stagger > 0) {
        setTimeout(() => bot.start(), stagger);
      } else {
        bot.start();
      }
      stagger += TIMING.CONNECT_STAGGER_MS || 250;
    }
    return targets.length;
  }
  getSummary() {
    const counts = { ONLINE: 0, CONNECTING: 0, AUTHENTICATING: 0, SPAWNING: 0, RECONNECTING: 0, DISCONNECTED: 0, STOPPING: 0 };
    let totalPpsIn = 0;
    let totalPpsOut = 0;
    let totalPing = 0;
    let pingCount = 0;
    for (const bot of this.bots) {
      const s = bot.getSummary();
      counts[s.state] = (counts[s.state] || 0) + 1;
      totalPpsIn += s.ppsIn || 0;
      totalPpsOut += s.ppsOut || 0;
      if (s.ping >= 0) {
        totalPing += s.ping;
        pingCount++;
      }
    }
    return {
      total: this.bots.length,
      counts,
      totalPpsIn,
      totalPpsOut,
      avgPing: pingCount > 0 ? Math.round(totalPing / pingCount) : -1,
      systemMetrics: this.getSystemMetrics(),
    };
  }
  getSystemMetrics() {
    const os = require('os');
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpus = os.cpus();
    const procMem = process.memoryUsage();
    return {
      totalMem, freeMem, usedMem,
      memPercent: Math.round((usedMem / totalMem) * 100),
      procHeap: procMem.heapUsed,
      procHeapTotal: procMem.heapTotal,
      procRss: procMem.rss,
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'Unknown',
      loadAvg: os.loadavg(),
      uptime: os.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
    };
  }
  getBotCapacity() {
    const os = require('os');
    const totalMemMB = os.totalmem() / (1024 * 1024);
    const freeMemMB = os.freemem() / (1024 * 1024);
    const procMem = process.memoryUsage();
    const usedByProcessMB = procMem.rss / (1024 * 1024);
    const availableMB = freeMemMB - CAPACITY.RESERVED_OS_MB;
    const safeMB = Math.max(0, availableMB - CAPACITY.RESERVED_SYSTEM_MB);
    const afkCount = this.bots.filter(b => b.state.afk).length;
    const activeCount = this.bots.filter(b => b.isOnline && !b.state.afk).length;
    const idleCount = this.bots.length - afkCount - activeCount;
    const avgRAMPerBot = this.bots.length > 0
      ? Math.round(usedByProcessMB / this.bots.length)
      : CAPACITY.RAM_PER_BOT_IDLE_MB;
    const maxBotsRecommended = Math.floor(safeMB / CAPACITY.RAM_PER_BOT_ACTIVE_MB);
    const maxBotsAbsolute = Math.floor(availableMB / CAPACITY.RAM_PER_BOT_IDLE_MB);
    const currentCount = this.bots.length;
    const capacityPercent = maxBotsRecommended > 0 ? Math.min(999, Math.round((currentCount / maxBotsRecommended) * 100)) : 100;
    const isWarning = capacityPercent >= CAPACITY.WARN_THRESHOLD_PCT;
    return {
      totalMemMB: Math.round(totalMemMB),
      freeMemMB: Math.round(freeMemMB),
      availableMB: Math.round(availableMB),
      safeMB: Math.round(safeMB),
      usedByProcessMB: Math.round(usedByProcessMB),
      avgRAMPerBot,
      currentBots: currentCount,
      afkBots: afkCount,
      activeBots: activeCount,
      maxRecommended: maxBotsRecommended,
      maxAbsolute: maxBotsAbsolute,
      capacityPercent,
      isWarning,
      perBotEstimate: {
        idle: CAPACITY.RAM_PER_BOT_IDLE_MB,
        afk: CAPACITY.RAM_PER_BOT_AFK_MB,
        active: CAPACITY.RAM_PER_BOT_ACTIVE_MB,
      },
      warnThresholdPct: CAPACITY.WARN_THRESHOLD_PCT,
    };
  }
  // ===== Lịch nghỉ: tự out trong khung giờ nghỉ, hết khung thì tự vô lại =====
  // Chạy theo KHUNG GIỜ (không phải bắn đúng 1 phút) nên không bị trượt khi
  // tick lệch / process restart giữa đêm; khung có thể qua nửa đêm (23:00→06:00).
  // Giờ tính theo múi giờ config.timezone (mặc định Asia/Ho_Chi_Minh) — không
  // phụ thuộc giờ của máy chủ (Render mặc định UTC nên trước đây bị lệch 7 tiếng).
  _normHM(v) {
    const m = /^\s*([01]?\d|2[0-3])\s*[:hH.]\s*([0-5]\d)\s*$/.exec(String(v ?? ''));
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  }
  _hmToMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
  _scheduleTz() { return this._config?.timezone || process.env.BOT_TZ || 'Asia/Ho_Chi_Minh'; }

  // ===== Hỏi liên kết webhook Discord sau khi bật autosell / autosell_spawn (chỉ khi dùng CLI) =====
  // Không chặn: bot vẫn chạy bình thường. Dòng kế tiếp người dùng gõ là link webhook -> lưu;
  // Enter trống -> bỏ qua; gõ lệnh khác -> huỷ câu hỏi và chạy lệnh đó như bình thường.
  askRevenueWebhook(botId) {
    if (typeof this.cliAsk !== 'function') return;                      // không có CLI tương tác (dashboard/AUTO_EXE) -> không hỏi
    if (this._webhookPrompt) return;                                    // đang hỏi rồi (vd cmdall nhiều bot)
    if (this.revenueNotifier?.enabled || this.notifier?.isEventOn('revenue')) return; // đã liên kết rồi
    this._webhookPrompt = { botId };
    this.cliAsk('🔗 Liên kết webhook Discord để nhận báo cáo doanh thu? Dán link vào đây rồi Enter — hoặc Enter trống để bỏ qua (tool vẫn chạy bình thường).');
  }
  get hasWebhookPrompt() { return !!this._webhookPrompt; }
  // true = dòng này đã được xử lý (là link hoặc Enter trống); false = là lệnh khác, để CLI xử lý tiếp
  answerWebhookPrompt(input) {
    if (!this._webhookPrompt) return false;
    this._webhookPrompt = null;
    const text = String(input || '').trim();
    if (!text) { this.cliAsk?.('Đã bỏ qua — chạy bình thường. Muốn liên kết sau: webhook revenue set <url>'); return true; }
    if (/^https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i.test(text)) {
      this.revenueNotifier.configure(text, ['all']);
      this.persistence.set('revenueWebhookUrl', text);
      this.cliAsk?.('✓ Đã liên kết webhook Discord cho báo cáo doanh thu. Thử: webhook revenue test');
      return true;
    }
    return false; // không phải link Discord -> coi là lệnh bình thường
  }

  // ===== Telegram: bảng Auto sell spawner + cảnh báo + lệnh /status /panel =====
  // Cấu hình (config.json hoặc biến môi trường — tiện cho Render/Docker):
  //   telegramToken | TELEGRAM_BOT_TOKEN, telegramChatId | TELEGRAM_CHAT_ID
  //   telegramEvents (mặc định disconnect,reconnectFailed,reconnectRecovered,sellFailed,spawnerThreat)
  //   telegramMode 'edit' (mặc định: 1 bảng/bot sửa tại chỗ) | 'new' (mỗi vòng 1 tin mới)
  //   telegramRefreshSec (mặc định 1 = bảng cập nhật mỗi giây; 0 = chỉ khi có vòng bán/sự kiện; chỉ chạy ở mode 'edit'),
  //   telegramMinGapSec (30, chống dội cho cập nhật sau vòng bán), telegramCommands (true)
  _initTelegram() {
    const c = this._config || {};
    this.telegram.configure(c.telegramToken || process.env.TELEGRAM_BOT_TOKEN || null, c.telegramChatId ?? process.env.TELEGRAM_CHAT_ID ?? null, c.telegramEvents);
    this._tgMsgs = (c.telegramMessages && typeof c.telegramMessages === 'object') ? { ...c.telegramMessages } : {};
    this._armTelegram();
  }
  _armTelegram() {
    if (this._tgTimer) { clearInterval(this._tgTimer); this._tgTimer = null; }
    const c = this._config || {};
    if (!this.telegram.enabled) { this.telegram.stopPolling(); return; }
    if (c.telegramCommands !== false) this.telegram.startPolling((ev) => this._onTelegramEvent(ev));
    else this.telegram.stopPolling();
    const sec = c.telegramRefreshSec === undefined ? 1 : Math.max(0, Number(c.telegramRefreshSec) || 0);
    if (sec > 0 && c.telegramMode !== 'new') { // mode 'new' mà sửa liên tục thì thành spam tin mới -> chỉ chạy ở mode 'edit'
      this._tgTimer = setInterval(() => { try { this._tgTick(); } catch { } }, Math.max(1, sec) * 1000);
      if (this._tgTimer.unref) this._tgTimer.unref();
    }
  }
  // Nhịp cập nhật bảng. Telegram chỉ cho ~1 lệnh/giây/chat -> mỗi nhịp sửa ĐÚNG 1 bảng, xoay vòng giữa các bot
  // (1 bot = mỗi giây, N bot = mỗi N giây/bảng). Bot offline không sửa liên tục — chỉ sửa khi trạng thái/thu nhập đổi.
  _tgTick() {
    const tg = this.telegram;
    if (!tg.enabled || this._config?.telegramMode === 'new') return;
    if (tg.paused || tg.pending > 2) return; // đang bị 429 hoặc hàng đợi chưa kịp xử lý -> bỏ nhịp này
    const cands = [];
    for (const b of this.bots) {
      if (!this._panelRelevant(b)) continue;
      const id = String(b.cfg.id);
      if (this._tgBusy.has(id)) continue;
      if (!this._tgMsgs[id] || b.isOnline || TelegramPanel.panelSig(this._botPanelInfo(b)) !== this._tgSig.get(id)) cands.push(b);
    }
    if (cands.length) this.sendTelegramPanel(cands[this._tgRR++ % cands.length]);
  }
  static parseEverySec(text) { // "1s", "30s", "10m", "1h30m", "90" (số trần = giây) -> số giây; null nếu không hiểu
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }
  // Lưu token/chat id (CLI `telegram set`) rồi bật lại polling/hẹn giờ
  setTelegram(token, chatId) {
    if (token !== undefined) { this._config.telegramToken = token || null; this.persistence.set('telegramToken', token || null); }
    if (chatId !== undefined) { this._config.telegramChatId = chatId ?? null; this.persistence.set('telegramChatId', chatId ?? null); }
    this._initTelegram();
  }
  setTelegramOption(key, value) {
    this._config[key] = value;
    this.persistence.set(key, value);
    if (key === 'telegramEvents') this.telegram.configure(this.telegram.token, this.telegram.chatId, value);
    this._armTelegram();
  }
  _panelRelevant(bot) { return !!(bot._sellSpawnOn || this.revenue.stats(bot.cfg.id)); }
  _botPanelInfo(bot, now = Date.now()) {
    const id = bot.cfg.id;
    const up = this.revenue.uptime(id, now);
    return {
      botId: id, account: bot.cfg.username || '', connState: bot.state.connState, disabled: !!bot._disabled,
      sellOn: !!bot._sellSpawnOn, intervalMs: bot._sellSpawnIntervalMs(), now,
      stats: this.revenue.stats(id, now), totalUptimeMs: up.totalMs, sessionMs: up.sessionMs,
      sellFailAgoMs: bot._sellFailAlertedAt ? now - bot._sellFailAlertedAt : null,
      clock: this.revenue.clock(now, true),
    };
  }
  // Gửi/sửa bảng của 1 bot. opts.editId = sửa đúng tin đó (nút Làm mới); opts.fresh = luôn gửi tin mới.
  sendTelegramPanel(bot, opts = {}) {
    if (!this.telegram.enabled) return Promise.resolve(false);
    const id = String(bot.cfg.id);
    // Xếp hàng theo từng bot: 2 yêu cầu sát nhau không tạo ra 2 bảng trùng (cái sau thấy message_id của cái trước)
    const run = async () => {
      this._tgBusy.add(id);
      try {
        const info = this._botPanelInfo(bot);
        const { text, keyboard } = TelegramPanel.buildPanel(info);
        const editMode = this._config?.telegramMode !== 'new';
        const prev = opts.editId || (editMode && !opts.fresh ? this._tgMsgs[id] : null);
        this._tgLastAt.set(id, Date.now());
        this._tgSig.set(id, TelegramPanel.panelSig(info));
        const mid = await (prev ? this.telegram.edit(prev, text, { keyboard }) : this.telegram.send(text, { keyboard }));
        if (mid && editMode && !opts.editId && this._tgMsgs[id] !== mid) {
          this._tgMsgs[id] = mid;
          this.persistence.set('telegramMessages', { ...this._tgMsgs });
        }
        return !!mid;
      } finally { this._tgBusy.delete(id); }
    };
    const chained = (this._tgChain.get(id) || Promise.resolve()).then(run, run).catch(() => false);
    this._tgChain.set(id, chained);
    return chained;
  }
  refreshTelegramPanels(opts = {}) {
    let n = 0;
    for (const b of this.bots) {
      if (!this._panelRelevant(b)) continue;
      this.sendTelegramPanel(b, opts); n++;
    }
    return n;
  }
  // BotSession gọi sau mỗi vòng bán xong: cập nhật bảng (chống dội: tối thiểu telegramMinGapSec giây/bot)
  onSellCycle(bot) {
    if (!this.telegram.enabled) return;
    if ((this._tgTimer && this._config?.telegramMode !== 'new')) return; // đang cập nhật theo nhịp giây -> bảng đã tự mới, khỏi sửa thêm
    const gap = Math.max(0, Number(this._config?.telegramMinGapSec ?? 30)) * 1000;
    if (Date.now() - (this._tgLastAt.get(String(bot.cfg.id)) || 0) < gap) return;
    this.sendTelegramPanel(bot);
  }
  // BotSession._notify gọi cho MỌI sự kiện (kick, hết reconnect, bán lỗi...) -> Telegram nếu sự kiện đó đang bật
  telegramAlert(bot, eventKey, title, description, headline) {
    if (!this.telegram.isEventOn(eventKey)) return;
    const h = (t) => TelegramNotifier.discordToHtml(t);
    const text = [headline ? h(headline) : null, `<b>${h(title)}</b>`, description ? h(description) : null].filter(Boolean).join('\n');
    this.telegram.send(text); // tin mới -> có thông báo đẩy trên điện thoại
    if (['disconnect', 'reconnectFailed', 'reconnectRecovered', 'sellFailed'].includes(eventKey) && this._panelRelevant(bot)) {
      setTimeout(() => { try { this.sendTelegramPanel(bot); } catch { } }, 1500); // trạng thái đổi -> sửa bảng cho khớp
    }
  }
  async _onTelegramEvent(ev) {
    if (ev.type === 'button' && ev.cmd === 'r') {
      const bot = ev.arg === '*' ? null : this.bots.find(b => String(b.cfg.id) === ev.arg);
      if (bot) await this.sendTelegramPanel(bot, { editId: ev.messageId });
      else this.refreshTelegramPanels();
      ev.answer('Đã làm mới');
      return;
    }
    if (ev.type !== 'command') return;
    const now = Date.now();
    if (ev.cmd === 'start' || ev.cmd === 'help') { ev.reply(TelegramPanel.HELP_TEXT); return; }
    if (ev.cmd === 'status') {
      ev.reply(TelegramPanel.buildStatusList(this.bots.map(b => this._botPanelInfo(b, now)), this.revenue.clock(now)));
      return;
    }
    if (ev.cmd === 'panel') {
      const list = ev.arg ? this.bots.filter(b => String(b.cfg.id) === ev.arg) : this.bots.filter(b => this._panelRelevant(b));
      if (!list.length) { ev.reply(ev.arg ? `Không có bot "${TelegramNotifier.escapeHtml(ev.arg)}".` : 'Chưa có bot nào bật autosell_spawn.'); return; }
      for (const b of list) this.sendTelegramPanel(b, { fresh: true }); // gửi bảng mới (và nhớ làm bảng chính)
    }
  }

  // ===== Báo cáo doanh thu TỔNG HỢP (gộp tất cả bot) =====
  // Webhook riêng (webhook revenue set <url>) nếu có, không thì webhook chung (sự kiện "revenue").
  _revenueSink() {
    if (this.revenueNotifier?.enabled) return { n: this.revenueNotifier, ev: null, via: 'webhook doanh thu riêng' };
    if (this.notifier?.isEventOn('revenue')) return { n: this.notifier, ev: 'revenue', via: 'webhook chung' };
    return null;
  }
  _revenueTotalCycles() {
    let c = 0;
    for (const b of this.bots) c += (this.revenue.stats(b.cfg.id)?.cycles || 0) + (this.revenue.stats(b.cfg.id + '#macro')?.cycles || 0);
    return c;
  }
  // Gộp thống kê auto-sell spawn + auto-sell macro của cùng 1 bot
  _mergeRevStats(list) {
    if (list.length === 1) return list[0];
    const sum = f => list.reduce((t, s) => t + (f(s) || 0), 0);
    const rated = list.filter(s => s.avgPerHour != null);
    const avg = rated.length ? rated.reduce((t, s) => t + s.avgPerHour, 0) : null;
    return {
      total: sum(s => s.total), cycles: sum(s => s.cycles), last1h: sum(s => s.last1h), last24h: sum(s => s.last24h),
      today: sum(s => s.today), yesterday: sum(s => s.yesterday),
      avgPerHour: avg, perDayEst: avg == null ? null : avg * 24, observedMs: Math.max(...list.map(s => s.observedMs || 0)),
      hourly: list[0].hourly.map((h, i) => ({ label: h.label, amount: sum(s => s.hourly[i]?.amount) })),
      daily: list[0].daily.map((d, i) => ({ label: d.label, amount: sum(s => s.daily[i]?.amount) })),
    };
  }
  buildRevenueSummaryEmbed(now = Date.now()) {
    const fmt = RevenueTracker.formatMoney;
    const rows = [];
    for (const b of this.bots) {
      const list = [this.revenue.stats(b.cfg.id, now), this.revenue.stats(b.cfg.id + '#macro', now)].filter(Boolean);
      if (list.length) rows.push({ id: String(b.cfg.id), s: this._mergeRevStats(list) });
    }
    if (!rows.length) return null;
    rows.sort((a, b) => b.s.today - a.s.today);
    const sum = f => rows.reduce((t, r) => t + (f(r.s) || 0), 0);
    const rated = rows.filter(r => r.s.avgPerHour != null);
    const avgH = rated.length ? rated.reduce((t, r) => t + r.s.avgPerHour, 0) : null;
    const pad = (v, n) => String(v).padStart(n, ' ');
    const MAX = 25;
    const idW = Math.min(14, Math.max(4, ...rows.slice(0, MAX).map(r => r.id.length)));
    const cut = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n, ' '));
    const lines = [`${cut('Bot', idW)} ${pad('1h', 7)} ${pad('Hôm nay', 8)} ${pad('/giờ', 7)}`];
    for (const r of rows.slice(0, MAX)) {
      lines.push(`${cut(r.id, idW)} ${pad(fmt(r.s.last1h), 7)} ${pad(fmt(r.s.today), 8)} ${pad(r.s.avgPerHour == null ? '—' : fmt(r.s.avgPerHour), 7)}`);
    }
    if (rows.length > MAX) lines.push(`… và ${rows.length - MAX} bot khác`);
    const hourly = rows[0].s.hourly.map((h, i) => ({ label: h.label, amount: rows.reduce((t, r) => t + (r.s.hourly[i]?.amount || 0), 0) }));
    const daily = rows[0].s.daily.map((d, i) => ({ label: d.label, amount: rows.reduce((t, r) => t + (r.s.daily[i]?.amount || 0), 0) }));
    const hrs = hourly.slice(-6).map(h => `${h.label} ${pad(fmt(h.amount), 8)}`).join('\n');
    const dys = daily.map(d => `${d.label} ${pad(fmt(d.amount), 8)}`).join('\n');
    const est = avgH == null ? '\n_(cần ≥2 vòng bán liên tiếp để tính tốc độ)_' : '';
    return {
      title: `📊 Tổng hợp doanh thu Auto-sell (${rows.length} bot)`,
      description: '```\n' + lines.join('\n') + '\n```',
      color: 0x22c55e,
      fields: [
        { name: '💰 Hôm nay', value: `**${fmt(sum(s => s.today))}**\nHôm qua: ${fmt(sum(s => s.yesterday))}`, inline: true },
        { name: '⏱ 1 giờ qua', value: `**${fmt(sum(s => s.last1h))}**\nTB/giờ: ${avgH == null ? '—' : fmt(avgH)}${est}`, inline: true },
        { name: '📅 24 giờ qua', value: `**${fmt(sum(s => s.last24h))}**\n~/ngày: ${avgH == null ? '—' : '~' + fmt(avgH * 24)}`, inline: true },
        { name: '🕒 6 giờ gần nhất (cả dàn)', value: '```\n' + hrs + '\n```', inline: true },
        { name: '🗓 7 ngày gần nhất (cả dàn)', value: '```\n' + dys + '\n```', inline: true },
        { name: '📊 Tổng cộng', value: `${fmt(sum(s => s.total))} trong ${sum(s => s.cycles)} vòng`, inline: false },
      ],
      footer: { text: 'Tổng hợp tất cả bot (auto-sell macro + auto-sell spawn)' },
      timestamp: new Date(now).toISOString(),
    };
  }
  sendRevenueSummary() {
    const embed = this.buildRevenueSummaryEmbed();
    if (!embed) return { ok: false, message: 'Chưa có dữ liệu doanh thu của bot nào' };
    const sink = this._revenueSink();
    if (!sink) return { ok: false, message: 'Chưa cấu hình webhook (webhook revenue set <url> hoặc webhook set <url>)' };
    sink.n.send(sink.ev, embed);
    this._revSummaryLastCycles = this._revenueTotalCycles();
    return { ok: true, via: sink.via };
  }
  // Hẹn giờ gửi định kỳ (phút, 0 = tắt). Tới hạn mà không có vòng bán mới nào thì bỏ qua, khỏi gửi trùng.
  _armRevenueSummary() {
    if (this._revSummaryTimer) { clearInterval(this._revSummaryTimer); this._revSummaryTimer = null; }
    const min = Number(this._config?.revenueSummaryEveryMin) || 0;
    if (min <= 0) return;
    this._revSummaryTimer = setInterval(() => {
      try {
        if (this._revenueTotalCycles() === this._revSummaryLastCycles) return;
        this.sendRevenueSummary();
      } catch { }
    }, Math.max(1, min) * 60000);
    if (this._revSummaryTimer.unref) this._revSummaryTimer.unref();
  }
  setRevenueSummaryEvery(min) {
    min = Math.max(0, Number(min) || 0);
    this._config.revenueSummaryEveryMin = min;
    this.persistence.set('revenueSummaryEveryMin', min);
    this._armRevenueSummary();
    return min;
  }
  // "30m", "1h", "1h30m", "90" (số trần = phút) -> số phút; null nếu không hiểu
  static parseEveryMin(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/.exec(t);
    if (!m || (!m[1] && !m[2])) return null;
    return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  }
  _nowMinutes() {
    const tz = this._scheduleTz();
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    } catch {
      parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    }
    const h = Number(parts.find(p => p.type === 'hour').value) % 24;
    const m = Number(parts.find(p => p.type === 'minute').value);
    return h * 60 + m;
  }
  setSchedule(enabled, outTime, inTime) {
    const out = this._normHM(outTime), inn = this._normHM(inTime);
    const sched = { enabled: !!enabled && !!out && !!inn && out !== inn, outTime: out, inTime: inn };
    const wasEnabled = !!this._config?.schedule?.enabled;
    this._config.schedule = sched;
    this.persistence.set('schedule', sched);
    // tắt lịch giữa lúc đang nghỉ -> cho bot vô lại luôn, đừng để kẹt offline
    if (!sched.enabled && (wasEnabled || this._inRest)) {
      if (this._inRest) this._doScheduledIn({ inTime: 'ngay (đã tắt lịch)' });
      this._inRest = false;
    }
    if (sched.enabled) setTimeout(() => this._scheduleTick(), 500);
    return sched;
  }
  getSchedule() {
    return this._config?.schedule || { enabled: false, outTime: null, inTime: null };
  }
  _scheduleTick() {
    const sched = this._config?.schedule;
    if (!sched?.enabled) return;
    const out = this._normHM(sched.outTime), inn = this._normHM(sched.inTime);
    if (!out || !inn || out === inn) return;
    const o = this._hmToMin(out), i = this._hmToMin(inn), n = this._nowMinutes();
    const inRest = o < i ? (n >= o && n < i) : (n >= o || n < i);
    const s = { ...sched, outTime: out, inTime: inn };
    if (inRest) {
      // Trong giờ nghỉ: bot nào còn chạy (kể cả bot vừa được start muộn sau
      // khi khởi động) thì out; chỉ báo Discord ở lần chuyển trạng thái đầu.
      const count = this._doScheduledOut(s);
      if (!this._inRest) {
        this._inRest = true;
        this._notifyRest(s, count);
      }
    } else if (this._inRest) {
      this._inRest = false;
      this._doScheduledIn(s);
    }
  }
  _doScheduledOut(sched) {
    let count = 0;
    for (const bot of this.bots) {
      if (bot._disabled && bot.state.connState === CS.DISCONNECTED) continue; // đã tắt sẵn
      if (bot.state.connState !== CS.DISCONNECTED || bot.isOnline) {
        bot._scheduledOut = true;
        bot.log('sys', `Lịch nghỉ: tự out (sẽ vô lại lúc ${sched.inTime})`);
        try { bot.shutdown(); } catch (e) { bot.log('err', 'Lịch nghỉ: lỗi khi out — ' + e.message); }
        count++;
      }
    }
    return count;
  }
  _notifyRest(sched, count) {
    this.notifier?.send('schedule', {
      title: `😴 Lịch nghỉ (${sched.outTime})`,
      description: `Đã out ${count} bot. Sẽ tự vô lại lúc ${sched.inTime}.`,
      color: 0xfacc15,
      timestamp: new Date().toISOString(),
    });
  }
  _doScheduledIn(sched) {
    let count = 0;
    for (const bot of this.bots) {
      if (bot._scheduledOut) {
        bot._scheduledOut = false;
        bot._disabled = false;
        bot.log('sys', 'Lịch nghỉ: hết giờ, tự vô lại');
        bot.start();
        count++;
      }
    }
    this.notifier?.send('schedule', {
      title: `⏰ Hết giờ nghỉ (${sched.inTime})`,
      description: `Đang vô lại ${count} bot.`,
      color: 0x4ade80,
      timestamp: new Date().toISOString(),
    });
  }
  shutdown() {
    for (const bot of this.bots) bot.shutdown();
    try { this.revenue.flush(); } catch { }
    this.persistence.shutdown();
    if (this._poolPruneInterval) clearInterval(this._poolPruneInterval);
    if (this._scheduleInterval) clearInterval(this._scheduleInterval);
    if (this._revSummaryTimer) clearInterval(this._revSummaryTimer);
    if (this._tgTimer) clearInterval(this._tgTimer);
    if (this._beatInterval) clearInterval(this._beatInterval);
    try { this.telegram.stopPolling(); } catch { }
    this.sharedPool.reset();
    this.bots = [];
  }
}
module.exports = BotManager;
