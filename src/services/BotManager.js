'use strict';
const path = require('path');
const os = require('os');
const BotSession = require('../core/BotSession');
const { dbg } = require('../core/debug');
const ProxyManager = require('../core/ProxyManager');
const EnvironmentDetector = require('../core/EnvironmentDetector');
const Persistence = require('../core/Persistence');
const SharedPool = require('../core/SharedPool');
const Notifier = require('../core/Notifier');
const DiscordTheme = require('../core/DiscordTheme');
const { describeActivity } = require('../core/BotActivity');
const TelegramControl = require('../core/TelegramControl');
const NotificationCenter = require('../core/NotificationCenter');
const RevenueTracker = require('../core/RevenueTracker');
const TelegramNotifier = require('../core/TelegramNotifier');
const TelegramPanel = require('../core/TelegramPanel');
const TelegramLogger = require('../core/TelegramLogger');
const FileLogger = require('../core/FileLogger');
const AiController = require('../core/AiController');
const { migrateTelegramConfig, normalizeTelegramConfig } = require('../core/ConfigValidator');
const { setSymbolSet } = require('../core/Symbols');
const { readDotEnv } = require('../core/dotenv');
const { resolveBotPassword } = require('../core/secrets');
const { pickTheme, TIMING, CS, CAPACITY, resolveVersion } = require('../core/constants');

class BotManager {
  constructor(options = {}) {
    this.configPath = options.configPath || path.join(process.cwd(), 'config.json');
    this.autoExe = options.autoExe || false;
    this.io = options.io || null;
    this.onBotLog = typeof options.onBotLog === 'function' ? options.onBotLog : null;
    this.bots = [];
    this._activeConnects = 0;
    this.envDetector = options.envDetector || new EnvironmentDetector(this.autoExe);
    this.persistence = new Persistence(this.configPath);
    this.proxyManager = new ProxyManager(this.io, this.persistence);
    this.sharedPool = SharedPool.global();
    this.notifier = new Notifier({
      onMessagesChange: (msgs) => {
        if (this._config) {
          this._config.webhookMessages = msgs;
          this.persistence.set('webhookMessages', msgs);
        }
      },
    });
    // Gộp chung 1 Webhook duy nhất: revenueNotifier trỏ thẳng về this.notifier (giữ tương thích ngược)
    this.revenueNotifier = this.notifier;
    this._discordPanelTimer = null;
    this.revenue = new RevenueTracker(path.join(path.dirname(this.configPath), 'revenue.json'), () => this._scheduleTz());
    this.telegram = new TelegramNotifier({}); // bảng Auto sell spawner + cảnh báo qua Telegram (không đặt token thì không làm gì)
    this._tgMsgs = {};                        // botId -> message_id của bảng (để sửa tại chỗ, khỏi spam)
    this._tgLastAt = new Map();               // botId -> lần gửi bảng gần nhất (chống dội)
    this._tgChain = new Map();                // botId -> chuỗi gửi bảng đang chờ (tránh tạo 2 bảng trùng)
    this._tgBusy = new Set();                 // bot đang có lần gửi/sửa bảng chưa xong (nhịp 1s bỏ qua bot này)
    this._tgSig = new Map();                  // botId -> "chữ ký" trạng thái bảng gửi gần nhất (bot offline chỉ sửa khi chữ ký đổi)
    this._tgRR = 0;                           // vòng xoay: mỗi nhịp sửa 1 bảng
    // Log runtime (log từng bot + log hệ thống) -> Telegram: 1 FILE chung cho tất cả bot, sửa tại chỗ theo chu kỳ; gộp dòng lặp, che mật khẩu/token
    this.telegramLogs = new TelegramLogger(this.telegram, {
      tz: () => this._scheduleTz(),
      secrets: () => [...this.bots.map(b => b?.cfg?.botPassword), this._config?.omniRouterApiKey, this.ai?.apiKey].filter(Boolean),
      botIds: () => this.bots.map(b => b?.cfg?.id).filter(x => x !== undefined && x !== null),
      stats: (id) => this._serverStats(id),
    });
    // Log runtime -> FILE trên máy (/sdcard/bot/log/runtime-YYYY-MM-DD.log)
    this.fileLogs = new FileLogger({
      dir: this._envLogDir() || FileLogger.resolveDefaultLogDir(path.dirname(this.configPath)),
      tz: () => this._scheduleTz(),
      redact: s => this.telegramLogs._redact(s),
    });
    this.ai = new AiController(this);
    this.telegramControl = new TelegramControl(this);
    this.notifications = new NotificationCenter({
      getTelegram: () => this.telegram,
      getDiscord: () => this.notifier,
      getConfig: () => this._config || {},
      getTz: () => this._scheduleTz(),
      redact: s => this.telegramLogs._redact(s),
      getBots: () => this.bots,
      onIncidentPanelRefresh: b => {
        if (this._panelRelevant(b)) this.sendTelegramPanel(b);
        this.markDiscordPanelDirty();
      },
    });
    this.dashboard = null;
    this._config = null;
    this._poolPruneInterval = setInterval(() => this.sharedPool.pruneCache(), 10 * 60 * 1000);
    this._inRest = false;
    this._scheduleInterval = setInterval(() => this._scheduleTick(), 20000);
    this._beatInterval = setInterval(() => { for (const b of this.bots) { if (b.isOnline) this.revenue.touch(b.cfg.id); } }, 5 * 60000);
    if (this._beatInterval.unref) this._beatInterval.unref();
  }

  async init() {
    this._config = this.persistence.load();
    this._migrateWebhookEvents();
    this._applyFileLogConfig();
    // Gộp chung 1 Webhook: nếu chưa có webhookUrl nhưng có revenueWebhookUrl cũ thì tự động gộp sang webhookUrl
    const unifiedUrl = this._config.webhookUrl || this._config.revenueWebhookUrl || null;
    if (!this._config.webhookUrl && this._config.revenueWebhookUrl) {
      this._config.webhookUrl = this._config.revenueWebhookUrl;
      this.persistence.set('webhookUrl', unifiedUrl);
    }
    this.notifier.configure(unifiedUrl, this._config.webhookEvents, {
      mode: this._config.webhookMode || 'hybrid',
      webhookMessages: this._config.webhookMessages,
    });
    this.notifier.setMention(this._config.webhookMention, this._config.webhookMentionEvents);
    this.revenueNotifier = this.notifier;
    this._armRevenueSummary();
    this._armDiscordPanel();
    this._initTelegram();
    this._initAi();
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

  _envLogDir() {
    const base = path.dirname(this.configPath);
    const v = process.env.ANTER_LOG_DIR || readDotEnv(base).ANTER_LOG_DIR;
    return v ? FileLogger.normalizeLogDir(v, base) : '';
  }

  _applyFileLogConfig() {
    const c = this._config || {};
    const base = path.dirname(this.configPath);
    const fl = {
      enabled: c.fileLogs !== false,
      levels: c.fileLogLevels ?? 'all',
      includeChat: c.fileLogChat === true,
      keepDays: c.fileLogKeepDays ?? 7,
      maxMB: c.fileLogMaxMB ?? 10,
      format: c.fileLogFormat ?? 'text',
      baseDir: base,
    };
    const envDir = this._envLogDir();
    if (envDir) fl.dir = envDir;
    else if (c.fileLogDir) fl.dir = FileLogger.normalizeLogDir(c.fileLogDir, base);
    else fl.dir = FileLogger.resolveDefaultLogDir(base);
    this.fileLogs.configure(fl);
    try { if (this.fileLogs.enabled) this.fileLogs.ensureFile(); } catch (e) { dbg('BotManager', e); }
  }

  setFileLogOption(key, value) {
    if (!this._config) this._config = {};
    this._config[key] = value;
    this.persistence.set(key, value);
    this._applyFileLogConfig();
  }

  _wireBotLog(bot) {
    bot.on('log', ev => {
      try { this.fileLogs.write(bot.cfg.id, ev && ev.entry ? ev.entry : ev); } catch (e) { dbg('BotManager', e); }
      try { this.telegramLogs.push(bot.cfg.id, ev && ev.entry ? ev.entry : ev); } catch (e) { dbg('BotManager', e); }
      if (this.onBotLog) {
        try { this.onBotLog(bot.cfg.id, ev); } catch (e) { dbg('BotManager', e); }
      }
    });
  }

  runtimeLog(level, msg) {
    try { this.fileLogs.write(TelegramLogger.SYSTEM, { level, msg, time: Date.now() }); if (level === 'err') this.fileLogs.flushSync(); } catch (e) { dbg('BotManager', e); }
    try { this.telegramLogs.push(TelegramLogger.SYSTEM, { level, msg, time: Date.now() }); } catch (e) { dbg('BotManager', e); }
  }

  _serverStats(id) {
    const b = this.findBot(id);
    if (!b) return null;
    const lines = [`Trạng thái: ${b.state.connState}${b.state.ping >= 0 ? ` · ping ${b.state.ping}ms` : ''}`];
    const board = b.readBoard();
    if (board && board.lines.length) {
      for (const l of board.lines) lines.push(l.text);
      return { title: board.title, lines };
    }
    if (b.state.money) lines.push(`Money: ${b.state.money.toLocaleString('en-US')}`);
    if (b.state.shard) lines.push(`Shard: ${b.state.shard.toLocaleString('en-US')}`);
    return lines;
  }

  flushTelegramLogs(timeoutMs = 3000) { return this.telegramLogs.flushNow(timeoutMs); }

  /** Hợp nhất việc xây dựng cấu hình bot cho cả load từ file và tạo mới qua CLI/Web */
  _buildBotConfig(src = {}) {
    const root = this._config || {};
    const cfgWithPw = src.password && !src.botPassword ? { ...src, botPassword: src.password } : src;
    return {
      id: src.id,
      host: src.host || root.host,
      port: src.port || root.port,
      version: resolveVersion(src.version, root.version),
      username: src.username,
      ownerUsername: src.ownerUsername || root.ownerUsername,
      registered: src.registered !== undefined ? src.registered : false,
      botPassword: resolveBotPassword(cfgWithPw, root),
      respawn: src.respawn !== undefined ? src.respawn : (root.respawn !== undefined ? root.respawn : true),
      useProxy: src.useProxy !== undefined ? src.useProxy : (root.useProxy !== undefined ? root.useProxy : false),
      autoMenu: src.autoMenu !== undefined ? src.autoMenu : (root.autoMenu !== undefined ? root.autoMenu : true),
      menuCommand: src.menuCommand || root.menuCommand || '/menu',
      clientSettings: src.clientSettings || null,
      sendClientSettings: src.sendClientSettings !== undefined ? src.sendClientSettings : true,
      skipValidation: src.skipValidation !== undefined ? src.skipValidation : false,
      viewDistance: src.viewDistance || null,
      autoLogin: src.autoLogin || root.autoLogin || null,
      beggarGuard: src.beggarGuard || root.beggarGuard || null,
      autoBeg: src.autoBeg || root.autoBeg || null,
      theme: src.theme || 'teal',
      authMode: src.authMode || 'offline',
      macros: src.macros || root.macros || {},
      moneyGoal: src.moneyGoal ?? root.moneyGoal ?? null,
      moneyGoalMacro: src.moneyGoalMacro || root.moneyGoalMacro || null,
      autoSellMacro: src.autoSellMacro || null,
      autoSellThreshold: src.autoSellThreshold ?? 90,
      autoSellRevenue: src.autoSellRevenue ?? true,
      autoSellMsgKeyword: src.autoSellMsgKeyword || '',
      autoSellMsgPattern: src.autoSellMsgPattern || '',
      autoSellIgnoreChat: src.autoSellIgnoreChat ?? true,
      autoSellReportMin: src.autoSellReportMin ?? 0,
      spawnerProtectOn: src.spawnerProtectOn ?? root.spawnerProtectOn ?? false,
      spawnerProtectRange: src.spawnerProtectRange ?? root.spawnerProtectRange ?? null,
      spawnerProtectLevel: src.spawnerProtectLevel ?? root.spawnerProtectLevel,
      spawnerProtectTune: src.spawnerProtectTune ?? root.spawnerProtectTune,
      spawnerAutoDisconnect: src.spawnerAutoDisconnect ?? root.spawnerAutoDisconnect ?? false,
      spawnerAutoMine: src.spawnerAutoMine ?? root.spawnerAutoMine ?? true,
      spawnerRequireSilk: src.spawnerRequireSilk ?? root.spawnerRequireSilk ?? true,
      spawnerSaveRange: src.spawnerSaveRange ?? root.spawnerSaveRange ?? 5,
      enderChestCommand: src.enderChestCommand ?? root.enderChestCommand ?? '/ec',
      spawnerWhitelist: src.spawnerWhitelist || root.spawnerWhitelist || [],
      protectedSpawners: src.protectedSpawners || [],
      autoSellSpawnOn: src.autoSellSpawnOn ?? false,
      autoSellSpawnList: src.autoSellSpawnList || [],
      autoSellSpawnSlot: src.autoSellSpawnSlot ?? 51,
      autoSellSpawnButton: src.autoSellSpawnButton ?? 0,
      autoSellSpawnSecond: src.autoSellSpawnSecond,
      autoSellSpawnMinute: src.autoSellSpawnMinute,
      autoSellSpawnHour: src.autoSellSpawnHour,
      autoSellSpawnRange: src.autoSellSpawnRange ?? 5,
      autoSellSpawnRevenue: src.autoSellSpawnRevenue ?? true,
      autoSellSpawnMsgKeyword: src.autoSellSpawnMsgKeyword || '',
      autoSellSpawnMsgPattern: src.autoSellSpawnMsgPattern || '',
      autoSellSpawnIgnoreChat: src.autoSellSpawnIgnoreChat ?? true,
      autoSellSpawnReportMin: src.autoSellSpawnReportMin ?? 0,
      sellFailMention: src.sellFailMention ?? root.sellFailMention,
      sellFailMaxHome: src.sellFailMaxHome ?? root.sellFailMaxHome,
      nameProtect: src.nameProtect || root.nameProtect || null,
      afkTabNoise: src.afkTabNoise ?? root.afkTabNoise ?? false,
      settingsProfile: src.settingsProfile ?? root.settingsProfile ?? 'vanilla',
      pingServerInfo: src.pingServerInfo ?? root.pingServerInfo ?? null,
      proxyAutoRotate: src.proxyAutoRotate ?? root.proxyAutoRotate ?? false,
      proxyRotateMinMinutes: src.proxyRotateMinMinutes ?? root.proxyRotateMinMinutes ?? 1,
      proxyRotateMaxMinutes: src.proxyRotateMaxMinutes ?? root.proxyRotateMaxMinutes ?? 10,
      ...this._startupFields(src),
    };
  }

  _instantiateBot(mergedCfg, index) {
    const theme = pickTheme(mergedCfg.theme, index);
    const bot = new BotSession(mergedCfg, theme, this.proxyManager, { io: this.io });
    bot._manager = this;
    this._wireBotLog(bot);
    if (this._config?.settings) {
      Object.assign(bot.settings, this._config.settings);
    }
    return bot;
  }

  _createBotFromConfig(cfg, index) {
    return this._instantiateBot(this._buildBotConfig(cfg), index);
  }

  _createBotFromData(data) {
    const index = this.bots.length;
    const cfg = this._buildBotConfig(data);
    const bot = this._instantiateBot(cfg, index);
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
      if (!bot.isConnected && !bot.isReconnecting && !bot._scheduledOut) {
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
    const totalMemMB = os.totalmem() / (1024 * 1024);
    const freeMemMB = os.freemem() / (1024 * 1024);
    const procMem = process.memoryUsage();
    const usedByProcessMB = procMem.rss / (1024 * 1024);
    const availableMB = Math.max(0, freeMemMB - CAPACITY.RESERVED_OS_MB);
    const safeMB = Math.max(0, availableMB - CAPACITY.RESERVED_SYSTEM_MB);
    const afkCount = this.bots.filter(b => b.state.afk).length;
    const activeCount = this.bots.filter(b => b.isOnline && !b.state.afk).length;
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

  _normHM(v) {
    const m = /^\s*([01]?\d|2[0-3])\s*[:hH.]\s*([0-5]\d)\s*$/.exec(String(v ?? ''));
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  }
  _hmToMin(hm) { const [h, m] = hm.split(':').map(Number); return h * 60 + m; }
  _scheduleTz() { return this._config?.timezone || this._config?.telegramTimezone || process.env.BOT_TZ || 'Asia/Ho_Chi_Minh'; }

  askRevenueWebhook(botId) {
    if (typeof this.cliAsk !== 'function') return;
    if (this._webhookPrompt) return;
    if (this.notifier?.enabled) return;
    this._webhookPrompt = { botId };
    this.cliAsk('🔗 Liên kết webhook Discord (dùng chung cho cả cảnh báo, doanh thu & bảng trực tiếp 10s)? Dán link vào đây rồi Enter — hoặc Enter trống để bỏ qua (tool vẫn chạy bình thường).');
  }
  get hasWebhookPrompt() { return !!this._webhookPrompt; }
  answerWebhookPrompt(input) {
    if (!this._webhookPrompt) return false;
    this._webhookPrompt = null;
    const text = String(input || '').trim();
    if (!text) { this.cliAsk?.('Đã bỏ qua — chạy bình thường. Muốn liên kết sau: webhook set <url>'); return true; }
    if (/^https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i.test(text)) {
      this.setWebhookUrl(text);
      this.cliAsk?.('✓ Đã liên kết webhook Discord (tự động cập nhật bảng trạng thái & doanh thu mỗi 10s). Thử: webhook test');
      return true;
    }
    return false;
  }

  // ===== Discord Hybrid v2: Gộp 1 Webhook + Bảng Live Dashboard tự động cập nhật mỗi 10s =====
  setWebhookUrl(url, events) {
    if (!this._config) this._config = {};
    const clean = url ? String(url).trim() : null;
    this.notifier.configure(clean, Array.isArray(events) ? events : [...this.notifier.events]);
    this._config.webhookUrl = clean;
    this.persistence.set('webhookUrl', clean);
    if (this._config.revenueWebhookUrl) {
      this._config.revenueWebhookUrl = null;
      this.persistence.set('revenueWebhookUrl', null);
    }
    if (Array.isArray(events)) {
      this._config.webhookEvents = events;
      this.persistence.set('webhookEvents', events);
    }
    this._armDiscordPanel();
  }

  setDiscordRefreshSec(sec) {
    if (!this._config) this._config = {};
    const n = Math.max(0, Number(sec) || 0);
    this._config.webhookRefreshSec = n;
    this.persistence.set('webhookRefreshSec', n);
    this._armDiscordPanel();
    return n;
  }

  getDiscordRefreshSec() {
    const v = this._config?.webhookRefreshSec;
    return v === undefined || v === null ? 10 : Math.max(0, Number(v) || 0);
  }

  _armDiscordPanel() {
    if (this._discordPanelTimer) {
      clearInterval(this._discordPanelTimer);
      this._discordPanelTimer = null;
    }
    if (!this.notifier?.enabled) return;
    const sec = this.getDiscordRefreshSec();
    if (sec <= 0 || this.notifier.mode === 'new') return;
    this._discordPanelTimer = setInterval(() => {
      try {
        this._discordPanelTick();
      } catch (e) {
        dbg('BotManager', e);
      }
    }, Math.max(2, sec) * 1000);
    if (this._discordPanelTimer.unref) this._discordPanelTimer.unref();
  }

  _buildDiscordPanelSnapshot(now = Date.now()) {
    const bots = this.bots.map(b => {
      const id = String(b.cfg.id);
      const up = this.revenue.uptime(id, now);
      const list = [this.revenue.stats(id, now), this.revenue.stats(id + '#macro', now)].filter(Boolean);
      const stats = list.length ? this._mergeRevStats(list) : null;
      const act = describeActivity(b, now);
      const protect = typeof b.getProtectStatus === 'function' ? b.getProtectStatus() : undefined;
      return {
        botId: id,
        account: b.cfg.username || '',
        host: b.cfg.host || '',
        connState: b.state.connState,
        disabled: !!b._disabled,
        scheduledOut: !!b._scheduledOut,
        reconnects: b.state?.reconnects || 0,
        sellOn: !!b._sellSpawnOn,
        sellBusy: !!b._sellSpawnBusy,
        nextSellAt: b._nextSellAt || 0,
        activityText: act?.text || '',
        totalUptimeMs: up.totalMs,
        protect,
        stats,
      };
    });
    return {
      now,
      refreshSec: this.getDiscordRefreshSec() || 10,
      bots,
      recentEvents: this.notifier.getRecentEvents(6),
    };
  }

  _discordPanelTick() {
    if (!this.notifier?.enabled || this.notifier.mode === 'new') return;
    if (this.bots.length === 0 && !this.notifier.getSlotMessageId('panel:main')) return;
    const snap = this._buildDiscordPanelSnapshot(Date.now());
    this.notifier.updateLivePanel(snap);
  }

  sendDiscordPanel(opts = {}) {
    if (!this.notifier?.enabled) return Promise.resolve(false);
    const snap = this._buildDiscordPanelSnapshot(opts.now ?? Date.now());
    return this.notifier.updateLivePanel(snap, { force: true, fresh: !!opts.fresh });
  }

  markDiscordPanelDirty() {
    if (!this.notifier?.enabled || this.notifier.mode === 'new') return;
    // Chỉ tự động đồng bộ lại bảng khi bảng Live Panel đã từng được khởi tạo (tránh bắn tin thừa trong bài test đơn lẻ)
    if (!this.notifier.getSlotMessageId('panel:main')) return;
    const snap = this._buildDiscordPanelSnapshot(Date.now());
    this.notifier.updateLivePanel(snap);
  }

  // ===== Telegram v2: bảng Auto sell spawner + cảnh báo + điều khiển từ xa =====
  _initAi() {
    if (!this._config) this._config = {};
    const base = path.dirname(this.configPath);
    const dot = readDotEnv(base);
    const apiKey = process.env.OMNIROUTER_API_KEY || dot.OMNIROUTER_API_KEY || this._config.omniRouterApiKey || '';
    const baseUrl = process.env.OMNIROUTER_BASE_URL || dot.OMNIROUTER_BASE_URL || this._config.omniRouterBaseUrl || AiController.DEFAULT_BASE_URL;
    const model = process.env.OMNIROUTER_MODEL || dot.OMNIROUTER_MODEL || this._config.omniRouterModel || AiController.DEFAULT_MODEL;
    this.ai.configure({ apiKey, baseUrl, model });
  }

  setAiConfig({ apiKey, baseUrl, model } = {}) {
    if (!this._config) this._config = {};
    if (apiKey !== undefined) {
      this._config.omniRouterApiKey = apiKey || '';
      this.persistence.set('omniRouterApiKey', apiKey || '');
    }
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== '') {
      this._config.omniRouterBaseUrl = String(baseUrl).trim();
      this.persistence.set('omniRouterBaseUrl', this._config.omniRouterBaseUrl);
    }
    if (model !== undefined && model !== null && model !== '') {
      this._config.omniRouterModel = String(model).trim();
      this.persistence.set('omniRouterModel', this._config.omniRouterModel);
    }
    this._initAi();
    return this.ai.getStatus();
  }

  async askAi(prompt, opts = {}) {
    return this.ai.ask(prompt, opts);
  }

  _initTelegram() {
    if (!this._config) this._config = {};
    const hadExplicitRefresh = this._config.telegramRefreshSec !== undefined || process.env.TELEGRAM_REFRESH_SEC !== undefined;
    const hadExplicitMode = this._config.telegramMode !== undefined;
    const hadExplicitEvents = Array.isArray(this._config.telegramEvents) && this._config.telegramEvents.length > 0;
    const norm = normalizeTelegramConfig(this._config, process.env);
    // Chỉ đồng bộ các khoá Telegram v2 vào bộ nhớ runtime nếu chưa có (tránh làm bẩn file config.json khi chưa dùng)
    for (const [k, v] of Object.entries(norm)) {
      if (k.startsWith('telegram') && this._config[k] === undefined) {
        if (k === 'telegramRefreshSec' && !hadExplicitRefresh) continue;
        if (k === 'telegramMode' && !hadExplicitMode) continue;
        if (k === 'telegramEvents' && !hadExplicitEvents) continue;
        this._config[k] = v;
      }
    }
    if (this._config.telegramSymbols) {
      setSymbolSet(this._config.telegramSymbols);
    }
    const c = this._config;
    const token = c.telegramToken || process.env.TELEGRAM_BOT_TOKEN || null;
    const chatId = c.telegramChatId ?? process.env.TELEGRAM_CHAT_ID ?? null;
    const events = hadExplicitEvents ? c.telegramEvents : undefined;
    this.telegram.discardBacklog = c.telegramDiscardBacklog === true && hadExplicitEvents;
    this.telegram.commandTtlSec = c.telegramCommandTtlSec ?? 120;
    this.telegram.configure(token, chatId, events);
    this._tgMsgs = (c.telegramMessages && typeof c.telegramMessages === 'object') ? { ...c.telegramMessages } : {};
    this.telegramLogs.resetMessage();
    this._applyTelegramLogConfig();
    this._armTelegram();
  }

  _applyTelegramLogConfig() {
    const c = this._config || {};
    this.telegramLogs.configure({
      enabled: c.telegramLogs !== false,
      levels: c.telegramLogLevels ?? 'all',
      bots: c.telegramLogBots ?? [],
      intervalSec: c.telegramLogEverySec ?? 10,
      silent: c.telegramLogSilent !== false,
      maxPerMin: c.telegramLogMaxPerMin ?? 10,
      keepLines: c.telegramLogKeepLines ?? 1000,
    });
  }

  _armTelegram() {
    if (this._tgTimer) { clearInterval(this._tgTimer); this._tgTimer = null; }
    const c = this._config || {};
    if (!this.telegram.enabled) { this.telegram.stopPolling(); return; }
    if (c.telegramCommands !== false) this.telegram.startPolling((ev) => this._onTelegramEvent(ev));
    else this.telegram.stopPolling();
    const sec = c.telegramRefreshSec === undefined ? 1 : Math.max(0, Number(c.telegramRefreshSec) || 0);
    if (sec > 0 && c.telegramMode !== 'new') {
      this._tgTimer = setInterval(() => { try { this._tgTick(); } catch (e) { dbg('BotManager', e); } }, Math.max(1, sec) * 1000);
      if (this._tgTimer.unref) this._tgTimer.unref();
    }
  }

  _tgTick() {
    const tg = this.telegram;
    if (!tg.enabled || this._config?.telegramMode === 'new') return;
    if (tg.paused || tg.pending > 2) return;
    const cands = [];
    for (const b of this.bots) {
      if (!this._panelRelevant(b)) continue;
      const id = String(b.cfg.id);
      if (this._tgBusy.has(id)) continue;
      if (!this._tgMsgs[id] || b.isOnline || TelegramPanel.panelSig(this._botPanelInfo(b)) !== this._tgSig.get(id)) cands.push(b);
    }
    if (cands.length) this.sendTelegramPanel(cands[this._tgRR++ % cands.length]);
  }

  static parseEverySec(text) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    if (/^\d+$/.test(t)) return Number(t);
    const m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
    if (!m || (!m[1] && !m[2] && !m[3])) return null;
    return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
  }

  setTelegram(token, chatId) {
    if (token !== undefined) { this._config.telegramToken = token || null; this.persistence.set('telegramToken', token || null); }
    if (chatId !== undefined) { this._config.telegramChatId = chatId ?? null; this.persistence.set('telegramChatId', chatId ?? null); }
    this._initTelegram();
    this._initAi();
  }

  setTelegramOption(key, value) {
    this._config[key] = value;
    this.persistence.set(key, value);
    if (key === 'telegramEvents') this.telegram.configure(this.telegram.token, this.telegram.chatId, value);
    if (key === 'telegramSymbols') setSymbolSet(value);
    if (key.startsWith('telegramLog')) this._applyTelegramLogConfig();
    this._armTelegram();
  }

  _panelRelevant(bot) { return !!(bot._sellSpawnOn || this.revenue.stats(bot.cfg.id)); }

  _botPanelInfo(bot, now = Date.now()) {
    const id = bot.cfg.id;
    const up = this.revenue.uptime(id, now);
    const allBotIds = this.bots.map(b => String(b.cfg.id));
    const tz = this._scheduleTz();
    const pos = bot.mc?.entity?.position || bot.state?.position || null;
    const protect = typeof bot.getProtectStatus === 'function' ? bot.getProtectStatus() : undefined;
    const hasProxy = !!(bot.proxy || bot.cfg?.useProxy);
    return {
      botId: id,
      allBotIds,
      shortId: TelegramPanel.botShortId(id, allBotIds),
      account: bot.cfg.username || '',
      connState: bot.state.connState,
      disabled: !!bot._disabled,
      scheduledOut: !!bot._scheduledOut,
      reconnects: bot.state?.reconnects || 0,
      sellOn: !!bot._sellSpawnOn,
      sellBusy: !!bot._sellSpawnBusy,
      intervalMs: bot._sellSpawnIntervalMs(),
      now,
      tz,
      stats: this.revenue.stats(id, now),
      totalUptimeMs: up.totalMs,
      sessionMs: up.sessionMs,
      session: bot,
      nextSellAt: bot._nextSellAt || 0,
      protect,
      pos,
      ping: bot.state?.ping,
      proxy: hasProxy,
      proxyStatus: hasProxy ? 'có' : 'không',
      macros: bot.scriptRunner?.list?.() || [],
      sellFailAgoMs: bot._sellFailAlertedAt ? now - bot._sellFailAlertedAt : null,
      recentLimit: this._config?.telegramRecentLimit || 8,
      clock: TelegramPanel.fmtClock(now, tz, true),
    };
  }

  markPanelDirty(botId) {
    const bot = this.findBot(botId);
    if (bot && this._panelRelevant(bot)) this.sendTelegramPanel(bot);
  }

  sendTelegramPanel(bot, opts = {}) {
    if (!this.telegram.enabled) return Promise.resolve(false);
    const id = String(bot.cfg.id);
    const nowOverride = opts.now;
    const run = async () => {
      this._tgBusy.add(id);
      try {
        const info = this._botPanelInfo(bot, nowOverride ?? Date.now());
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

  onSellCycle(bot) {
    this.markDiscordPanelDirty();
    if (!this.telegram.enabled) return;
    if ((this._tgTimer && this._config?.telegramMode !== 'new')) return;
    const gap = Math.max(0, Number(this._config?.telegramMinGapSec ?? 30)) * 1000;
    if (Date.now() - (this._tgLastAt.get(String(bot.cfg.id)) || 0) < gap) return;
    this.sendTelegramPanel(bot);
  }

  // Giữ nguyên định dạng cảnh báo Telegram (vẫn đồng bộ bảng khi sự cố xảy ra)
  telegramAlert(bot, eventKey, title, description, headline) {
    if (!this.telegram.isEventOn(eventKey)) return;
    const h = (t) => TelegramNotifier.discordToHtml(t);
    const text = [headline ? h(headline) : null, `<b>${h(title)}</b>`, description ? h(description) : null].filter(Boolean).join('\n');
    const silent = this.notifications ? !this.notifications.isLoudEvent(eventKey, undefined, false) : false;
    this.telegram.send(text, silent ? { silent: true } : undefined);
    if (['disconnect', 'reconnectFailed', 'reconnectRecovered', 'sellFailed'].includes(eventKey) && this._panelRelevant(bot)) {
      setTimeout(() => { try { this.sendTelegramPanel(bot); } catch (e) { dbg('BotManager', e); } }, 1500);
    }
  }

  /**
   * Đấu nối đầy đủ mọi sự kiện Telegram (cả command /... và nút bấm p:/c:/e:/r:/lg:)
   * qua TelegramControl v2 (RBAC, rate-limit, xác nhận 30s, 24 lệnh & menu điều khiển).
   */
  async _onTelegramEvent(ev) {
    if (!ev) return null;
    const res = await this.telegramControl.handleEvent(ev);
    if (!res || res.silentIgnore) return res;

    if (ev.type === 'button') {
      if (res.editMessage && res.text && ev.messageId) {
        await this.telegram.edit(ev.messageId, res.text, { keyboard: res.keyboard, priority: 1 });
      } else if (res.text && !res.noReply && !res.editMessage) {
        if (typeof ev.reply === 'function') {
          await ev.reply(res.text, res.keyboard ? { keyboard: res.keyboard } : undefined);
        } else {
          await this.telegram.send(res.text, { keyboard: res.keyboard, priority: 1 });
        }
      }
      if (Array.isArray(res.refresh)) {
        for (const id of res.refresh) this.markPanelDirty(id);
      }
      if (typeof ev.answer === 'function') {
        await ev.answer(res.callbackText || '');
      }
      return res;
    }

    if (ev.type === 'command') {
      if (res.text && !res.noReply) {
        if (typeof ev.reply === 'function') {
          await ev.reply(res.text, res.keyboard ? { keyboard: res.keyboard } : undefined);
        } else {
          await this.telegram.send(res.text, { keyboard: res.keyboard, priority: 1 });
        }
      }
      if (Array.isArray(res.refresh)) {
        for (const id of res.refresh) this.markPanelDirty(id);
      }
    }
    return res;
  }

  // ===== Log runtime -> Telegram: lệnh =====
  _parseLogsTarget(parts) {
    const rest = parts.filter(Boolean);
    let id = null, n = 25;
    if (rest.length && (!/^\d+$/.test(rest[0]) || this.findBot(rest[0]))) id = rest.shift();
    if (rest.length && /^\d+$/.test(rest[0])) n = Number(rest[0]);
    if (id && id.toLowerCase() === 'system') id = TelegramLogger.SYSTEM;
    return { id, n };
  }

  _logsStatusLines() {
    const s = this.telegramLogs.status();
    const lv = s.preset ? `${s.preset} (${s.levels.join(', ')})` : s.levels.join(', ');
    return [
      `Log runtime → Telegram: ${s.enabled ? (s.telegramReady ? 'BẬT' : 'BẬT nhưng Telegram chưa cấu hình (telegram set <token> → telegram chatid)') : 'TẮT'}`,
      `Mức: ${lv}${s.levels.includes('chat') ? '' : '  — chat người chơi: tắt'}`,
      `Bot: ${s.bots ? s.bots.join(', ') : 'tất cả'}  (+ log hệ thống)`,
      `1 file ${TelegramLogger.FILE_NAME} chứa log của tất cả bot — cập nhật tại chỗ mỗi ${TelegramLogger.fmtSeconds(s.intervalSec)} · giữ ${s.keepLines} dòng mới nhất · tối đa ${s.maxPerMin} lần/phút`,
      `Tin đầu tiên: ${s.silent ? 'im lặng (không rung)' : 'CÓ rung điện thoại'} · các lần sửa không rung`,
      `Đã tạo ${s.created} file · cập nhật ${s.updates} lần · file có ${s.lines} dòng · bỏ ${s.dropped} dòng cũ · gửi lỗi ${s.failed} lần · chờ ${s.buffered} mục mới`,
    ];
  }

  async telegramLogsCommand(args = []) {
    const out = [];
    const say = (kind, text) => out.push([kind, '  ' + text]);
    const L = this.telegramLogs;
    const sub = String(args[0] || 'status').toLowerCase();
    const val = String(args[1] || '').toLowerCase();
    const onOff = (v) => (v === 'on' || v === 'bat' || v === 'bật' ? true : (v === 'off' || v === 'tat' || v === 'tắt' ? false : null));
    const usage = () => {
      say('muted', 'Usage: telegram logs on|off | level <all|info|warn|err|a,b,c> | chat on|off | bots <all|id1,id2>');
      say('muted', '       telegram logs every <10s|30s|1m|1h> | keep <số dòng> | now | silent on|off | send [id] [n] | test');
    };
    try {
      if (sub === 'status') {
        const lines = this._logsStatusLines();
        say(L.enabled && L.tg.enabled ? 'ok' : 'warn', lines[0]);
        for (const l of lines.slice(1)) say('muted', l);
        usage();
      } else if (sub === 'on' || sub === 'off') {
        this.setTelegramOption('telegramLogs', sub === 'on');
        say('ok', sub === 'on' ? '✓ Đã BẬT gửi log runtime lên Telegram' : '✓ Đã TẮT gửi log runtime lên Telegram (/logs trong Telegram vẫn xem lại được)');
        if (sub === 'on' && !this.telegram.enabled) say('warn', 'Telegram chưa cấu hình — dùng: telegram set <token>, rồi telegram chatid');
      } else if (sub === 'level' || sub === 'levels' || sub === 'muc') {
        if (!args[1]) {
          say('muted', 'Đang gửi: ' + [...L.levels].join(', '));
          say('muted', 'Mức có: ' + TelegramLogger.LEVELS.join(', '));
          say('muted', 'Mẫu: all (mọi mức trừ chat) · info (ok,warn,err,proxy,health) · warn (warn,err,health) · err — hoặc liệt kê: warn,err,sys · thêm chat: all,chat');
        } else {
          const r = TelegramLogger.parseLevels(args.slice(1).join(','));
          if (!r.ok) say('warn', r.error);
          else { this.setTelegramOption('telegramLogLevels', r.levels); say('ok', '✓ Mức log gửi lên Telegram: ' + r.levels.join(', ')); }
        }
      } else if (sub === 'chat') {
        const on = onOff(val);
        if (on === null) { say('warn', 'Cú pháp: telegram logs chat on|off  (gửi cả chat của người chơi/server — rất nhiều tin)'); }
        else {
          const set = new Set(L.levels);
          if (on) set.add('chat'); else set.delete('chat');
          if (!set.size) set.add('err');
          this.setTelegramOption('telegramLogLevels', [...set]);
          say('ok', '✓ Chat người chơi trong log Telegram: ' + (on ? 'BẬT' : 'TẮT'));
        }
      } else if (sub === 'bots' || sub === 'bot') {
        if (!args[1]) {
          say('muted', 'Đang lọc bot: ' + (L.bots ? [...L.bots].join(', ') : 'tất cả') + '   (đổi: telegram logs bots <all|id1,id2>)');
        } else if (val === 'all' || val === '*') {
          this.setTelegramOption('telegramLogBots', null);
          say('ok', '✓ Gửi log của tất cả bot');
        } else {
          const list = args.slice(1).join(',').split(/[\s,]+/).map(x => x.trim()).filter(Boolean);
          this.setTelegramOption('telegramLogBots', list);
          say('ok', '✓ Chỉ gửi log của: ' + list.join(', ') + '  (log hệ thống vẫn gửi)');
          const unknown = list.filter(x => !this.findBot(x));
          if (unknown.length) say('warn', 'Chưa có bot tên: ' + unknown.join(', ') + ' (vẫn lưu — bot thêm sau sẽ được tính)');
        }
      } else if (sub === 'every' || sub === 'interval') {
        const sec = TelegramLogger.parseSeconds(args.slice(1).join(''));
        if (sec === null) say('warn', 'Cú pháp: telegram logs every <10s|30s|1m|1h|90>  (chu kỳ cập nhật file log, tối thiểu 2s, tối đa 24h)');
        else if (sec < TelegramLogger.MIN_INTERVAL_SEC) say('warn', 'Tối thiểu 2 giây (Telegram chỉ cho ~1 lần sửa/giây/chat)');
        else if (sec > TelegramLogger.MAX_INTERVAL_SEC) say('warn', 'Tối đa 24 giờ (24h)');
        else {
          this.setTelegramOption('telegramLogEverySec', sec);
          say('ok', `✓ File log tự cập nhật mỗi ${TelegramLogger.fmtSeconds(sec)} (chỉ sửa khi có log/stats mới; "telegram logs now" để cập nhật ngay)`);
          if (sec * (this.telegramLogs.maxPerMin) < 60) say('muted', `Lưu ý: đang giới hạn tối đa ${this.telegramLogs.maxPerMin} lần/phút (telegramLogMaxPerMin) nên thực tế không nhanh hơn ${Math.ceil(60 / this.telegramLogs.maxPerMin)}s/lần`);
        }
      } else if (sub === 'keep' || sub === 'lines') {
        const n = /^\d+$/.test(val) ? Number(val) : null;
        if (n === null) say('muted', `Đang giữ ${L.keepLines} dòng mới nhất trong file  (đổi: telegram logs keep <${TelegramLogger.MIN_KEEP}-${TelegramLogger.MAX_KEEP}>)`);
        else if (n < TelegramLogger.MIN_KEEP || n > TelegramLogger.MAX_KEEP) say('warn', `Số dòng giữ trong file: ${TelegramLogger.MIN_KEEP}–${TelegramLogger.MAX_KEEP}`);
        else { this.setTelegramOption('telegramLogKeepLines', n); say('ok', `✓ File log giữ ${n} dòng mới nhất (dòng cũ hơn bị bỏ, có ghi số dòng bỏ ở đầu phần LOG)`); }
      } else if (sub === 'now' || sub === 'refresh') {
        const r = await L.refresh();
        say(r.ok ? 'ok' : 'warn', (r.ok ? '✓ ' : '') + r.message);
      } else if (sub === 'silent') {
        const on = onOff(val);
        if (on === null) say('warn', 'Cú pháp: telegram logs silent on|off  (on = tin log không rung điện thoại)');
        else { this.setTelegramOption('telegramLogSilent', on); say('ok', '✓ Tin log: ' + (on ? 'im lặng (không rung)' : 'có rung điện thoại')); }
      } else if (sub === 'send') {
        if (!this.telegram.enabled) say('warn', 'Chưa cấu hình Telegram — dùng: telegram set <token>');
        else {
          const { id, n } = this._parseLogsTarget(args.slice(1));
          const r = await L.sendRecent({ bot: id, n });
          if (!r.count) say('warn', id ? `Chưa có log nào của "${id}"` : 'Chưa có log nào để gửi');
          else say(r.messages ? 'ok' : 'err', r.messages ? `✓ Đã gửi ${r.count} dòng log gần nhất${id ? ' của ' + id : ''} (${r.messages} tin)` : '✗ Gửi thất bại: ' + (this.telegram.lastError || 'không rõ lý do'));
        }
      } else if (sub === 'test') {
        const r = await L.test();
        say(r.ok ? 'ok' : 'err', (r.ok ? '✓ ' : '✗ ') + r.message);
      } else {
        usage();
      }
    } catch (e) {
      say('err', 'Lỗi: ' + (e && e.message || e));
    }
    return out;
  }

  async _tgLogsCommand(ev) {
    const L = this.telegramLogs;
    const e = TelegramNotifier.escapeHtml;
    const parts = String(ev.arg || '').split(/\s+/).filter(Boolean);
    const sub = (parts[0] || '').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      this.setTelegramOption('telegramLogs', sub === 'on');
      ev.reply(`📜 Gửi log runtime tự động: <b>${sub === 'on' ? 'BẬT' : 'TẮT'}</b>`);
      return;
    }
    if (sub === 'status') {
      ev.reply('📜 <b>Log runtime</b>\n' + this._logsStatusLines().map(l => e(l)).join('\n'));
      return;
    }
    if (sub === 'now' || sub === 'refresh') {
      const r = await L.refresh();
      if (!r.ok) ev.reply(`📜 ${e(r.message)}`);
      return;
    }
    const { id, n } = this._parseLogsTarget(parts);
    const r = await L.sendRecent({ bot: id, n });
    if (!r.count) ev.reply(id ? `Chưa có log nào của "${e(id)}".` : 'Chưa có log nào.');
  }

  // ===== Báo cáo doanh thu TỔNG HỢP (gộp chung vào 1 Webhook) =====
  _revenueSink() {
    if (this.notifier?.isEventOn('revenue')) return { n: this.notifier, ev: 'revenue', via: 'webhook chung (cập nhật tại chỗ)' };
    if (this.revenueNotifier?.enabled) return { n: this.revenueNotifier, ev: null, via: 'webhook chung (cập nhật tại chỗ)' };
    return null;
  }

  _revenueTotalCycles() {
    let c = 0;
    for (const b of this.bots) c += (this.revenue.stats(b.cfg.id)?.cycles || 0) + (this.revenue.stats(b.cfg.id + '#macro')?.cycles || 0);
    return c;
  }

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

  _discordPrimaryUsername() {
    for (const b of this.bots) {
      const u = String(b?.cfg?.username || '');
      if (/^\w{1,16}$/.test(u)) return u;
    }
    return '';
  }

  _discordAuthor(label = Notifier.BRAND) {
    return DiscordTheme.buildAuthor(label, this._discordPrimaryUsername());
  }

  _discordThumb() {
    return DiscordTheme.buildThumbnail(this._discordPrimaryUsername());
  }

  buildRevenueSummaryEmbed(now = Date.now()) {
    const money = RevenueTracker.formatMoneyDollar;
    const rows = [];
    for (const b of this.bots) {
      const list = [this.revenue.stats(b.cfg.id, now), this.revenue.stats(b.cfg.id + '#macro', now)].filter(Boolean);
      if (list.length) rows.push({ id: String(b.cfg.id), username: String(b.cfg.username || ''), s: this._mergeRevStats(list) });
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
    const lines = [`${cut('Bot', idW)} ${pad('1h', 8)} ${pad('Hôm nay', 9)} ${pad('/giờ', 8)}`];
    for (const r of rows.slice(0, MAX)) {
      lines.push(`${cut(r.id, idW)} ${pad(money(r.s.last1h), 8)} ${pad(money(r.s.today), 9)} ${pad(r.s.avgPerHour == null ? '—' : money(r.s.avgPerHour), 8)}`);
    }
    if (rows.length > MAX) lines.push(`… và ${rows.length - MAX} bot khác`);
    const hosts = [...new Set(this.bots.map(b => String(b.cfg.host || '').trim()).filter(Boolean))];
    const server = hosts.length === 1 ? hosts[0] : (hosts.length ? `${hosts.length} server` : '—');
    const upMs = Math.max(0, ...this.bots.map(b => this.revenue.uptime(b.cfg.id, now).totalMs));
    const online = this.bots.filter(b => b.isOnline).length;
    const topUser = rows.find(r => /^\w{1,16}$/.test(r.username))?.username || this._discordPrimaryUsername();
    const status = [
      `${online}/${this.bots.length} bot đang hoạt động`,
      `Tiến độ dàn: ${DiscordTheme.progressBar(online, Math.max(1, this.bots.length))} • ${DiscordTheme.discordTimestamp(now, 'R')}`,
    ];
    if (avgH == null) status.push('Cần ≥2 vòng bán liên tiếp để tính tốc độ');
    return Notifier.finish({
      title: DiscordTheme.formatEmbedTitle(`Báo Cáo Tổng Kết Doanh Thu (${rows.length} Bot)`, 'revenueSummary'),
      description: DiscordTheme.codeBlock(lines.join('\n')),
      color: DiscordTheme.COLOR.report,
      author: DiscordTheme.buildAuthor(`${Notifier.BRAND} • ${this.bots.length} Bot`, topUser),
      thumbnail: DiscordTheme.buildThumbnail(topUser),
      fields: [
        { name: 'Số bot', value: String(this.bots.length), inline: true },
        { name: 'Server', value: server, inline: true },
        { name: 'Thời gian treo', value: RevenueTracker.formatClock(upMs), inline: true },
        { name: 'Tổng thu nhập', value: money(sum(s => s.total)), inline: true },
        { name: 'Tốc độ trung bình', value: avgH == null ? '—' : `${money(avgH)}/h`, inline: true },
        { name: 'Số lượt bán', value: String(sum(s => s.cycles)), inline: true },
        { name: 'Trạng thái', value: status.join('\n'), inline: false },
      ],
      timestamp: new Date(now).toISOString(),
    }, 'revenueSummary');
  }

  sendRevenueSummary() {
    const embed = this.buildRevenueSummaryEmbed();
    if (!embed) return { ok: false, message: 'Chưa có dữ liệu doanh thu của bot nào' };
    const sink = this._revenueSink();
    if (!sink) return { ok: false, message: 'Chưa cấu hình webhook (dùng: webhook set <url>)' };
    sink.n.send(sink.ev, embed, null, { slotKey: 'rev:summary' });
    this._revSummaryLastCycles = this._revenueTotalCycles();
    return { ok: true, via: sink.via };
  }

  _armRevenueSummary() {
    if (this._revSummaryTimer) { clearInterval(this._revSummaryTimer); this._revSummaryTimer = null; }
    const min = Number(this._config?.revenueSummaryEveryMin) || 0;
    if (min <= 0) return;
    this._revSummaryTimer = setInterval(() => {
      try {
        if (this._revenueTotalCycles() === this._revSummaryLastCycles) return;
        this.sendRevenueSummary();
      } catch (e) { dbg('BotManager', e); }
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
      if (bot._disabled && bot.state.connState === CS.DISCONNECTED) continue;
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
    const theme = DiscordTheme.getTheme('scheduleOut');
    const tot = Math.max(1, this.bots.length || count || 1);
    this.notifier?.send('schedule', Notifier.finish({
      title: DiscordTheme.formatEmbedTitle('Bắt Đầu Giờ Nghỉ', 'scheduleOut'),
      description: `Đã out ${count} bot (${DiscordTheme.progressBar(count, tot)}). Sẽ tự vô lại lúc \`${sched.inTime}\`.`,
      color: theme.color,
      author: this._discordAuthor(),
      thumbnail: this._discordThumb(),
      fields: [
        { name: 'Giờ nghỉ', value: String(sched.outTime), inline: true },
        { name: 'Vô lại lúc', value: String(sched.inTime), inline: true },
        { name: 'Số bot', value: String(count), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }, 'scheduleOut'));
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
    const theme = DiscordTheme.getTheme('scheduleIn');
    const tot = Math.max(1, this.bots.length || count || 1);
    this.notifier?.send('schedule', Notifier.finish({
      title: DiscordTheme.formatEmbedTitle('Hết Giờ Nghỉ', 'scheduleIn'),
      description: `Đang vô lại ${count} bot (${DiscordTheme.progressBar(count, tot)}) • ${DiscordTheme.discordTimestamp(Date.now(), 'R')}.`,
      color: theme.color,
      author: this._discordAuthor(),
      thumbnail: this._discordThumb(),
      fields: [
        { name: 'Vô lại lúc', value: String(sched.inTime), inline: true },
        { name: 'Số bot', value: String(count), inline: true },
        { name: 'Trạng thái', value: 'Đang kết nối lại', inline: true },
      ],
      timestamp: new Date().toISOString(),
    }, 'scheduleIn'));
  }

  async flushGracefulShutdown(timeoutMs = 3000) {
    let timer;
    try {
      await Promise.race([
        Promise.allSettled([this.telegram?._queue, this.notifier?._queue]),
        new Promise(r => { timer = setTimeout(r, timeoutMs); if (timer.unref) timer.unref(); }),
      ]);
    } catch (e) { dbg('BotManager', e); } finally { clearTimeout(timer); }
    try { this.fileLogs.flushSync(); } catch (e) { dbg('BotManager', e); }
  }

  shutdown() {
    for (const bot of this.bots) bot.shutdown();
    try { this.revenue.flush(); } catch (e) { dbg('BotManager', e); }
    this.persistence.shutdown();
    if (this._poolPruneInterval) clearInterval(this._poolPruneInterval);
    if (this._scheduleInterval) clearInterval(this._scheduleInterval);
    if (this._revSummaryTimer) clearInterval(this._revSummaryTimer);
    if (this._discordPanelTimer) clearInterval(this._discordPanelTimer);
    if (this._tgTimer) clearInterval(this._tgTimer);
    try { this.telegramLogs.stop(); } catch (e) { dbg('BotManager', e); }
    try { this.fileLogs.flushSync(); } catch (e) { dbg('BotManager', e); }
    if (this._beatInterval) clearInterval(this._beatInterval);
    try { this.telegram.stopPolling(); } catch (e) { dbg('BotManager', e); }
    this.sharedPool.reset();
    this.bots = [];
  }
}

module.exports = BotManager;
