'use strict';
const BotSession = require('../core/BotSession');
const ProxyManager = require('../core/ProxyManager');
const EnvironmentDetector = require('../core/EnvironmentDetector');
const Persistence = require('../core/Persistence');
const SharedPool = require('../core/SharedPool');
const Notifier = require('../core/Notifier');
const RevenueTracker = require('../core/RevenueTracker');
const { pickTheme, TIMING, CS, CAPACITY } = require('../core/constants');
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
    this.dashboard = null;
    this._config = null;
    this._poolPruneInterval = setInterval(() => this.sharedPool.pruneCache(), 10 * 60 * 1000);
    this._inRest = false;
    this._scheduleInterval = setInterval(() => this._scheduleTick(), 20000);
  }
  async init() {
    this._config = this.persistence.load();
    this.notifier.configure(this._config.webhookUrl, this._config.webhookEvents);
    this.revenueNotifier.configure(this._config.revenueWebhookUrl, ['all']);
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
      version: cfg.version || this._config.version,
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
      proxyAutoRotate: cfg.proxyAutoRotate ?? this._config.proxyAutoRotate ?? false,
      proxyRotateMinMinutes: cfg.proxyRotateMinMinutes ?? this._config.proxyRotateMinMinutes ?? 1,
      proxyRotateMaxMinutes: cfg.proxyRotateMaxMinutes ?? this._config.proxyRotateMaxMinutes ?? 10,
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
      version: data.version || this._config.version,
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
      proxyAutoRotate: data.proxyAutoRotate ?? this._config.proxyAutoRotate ?? false,
      proxyRotateMinMinutes: data.proxyRotateMinMinutes ?? this._config.proxyRotateMinMinutes ?? 1,
      proxyRotateMaxMinutes: data.proxyRotateMaxMinutes ?? this._config.proxyRotateMaxMinutes ?? 10,
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
    this.sharedPool.reset();
    this.bots = [];
  }
}
module.exports = BotManager;
