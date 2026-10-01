'use strict';
const EventEmitter = require('events');
const path = require('path');
const mineflayer = require('mineflayer');
const { CS, TIMING, IGNORED_ERRORS, DEFAULTS } = require('./constants');
const { rand, jit, clamp, nowMs, sleep, resolveText, parseShardNum, safeJsonStringify, parseReasonText, normalizeSmallCaps } = require('./utils');
const PacketMonitor = require('./PacketMonitor');
const CommandRegistry = require('./CommandRegistry');
const HelpCatalog = require('./HelpCatalog');
const { WindowRouter } = require('./WindowRouter');
const RingBuffer = require('./RingBuffer');
const SharedPool = require('./SharedPool');
const RevenueTracker = require('./RevenueTracker');
const MacroEngine = require('./MacroEngine');
const vec3lib = require('vec3');
const makeVec3 = (x, y, z) => (typeof vec3lib === 'function' ? vec3lib(x, y, z) : new vec3lib.Vec3(x, y, z));
class BotSession extends EventEmitter {
  constructor(cfg, theme, proxyManager, socketRooms = null) {
    super();
    this.cfg = cfg;
    this.theme = theme;
    this.proxyManager = proxyManager;
    this.socketRooms = socketRooms;
    this.proxy = null;
    this.mc = null;
    this.packetMgr = new PacketMonitor(cfg.id);
    this.cmdRegistry = new CommandRegistry(this);
    this.macroEngine = new MacroEngine(this);
    this._logBuffer = new RingBuffer(800);
    this.settings = { ...DEFAULTS };
    this.state = {
      connState: CS.DISCONNECTED,
      afk: null,
      intendedAfk: null,
      shard: 0,
      money: 0,
      reconnects: 0,
      ping: -1,
      position: null,
      health: 20,
      food: 20,
      loginTime: null,
      inventory: [],
      tshard: false,
      autoStats: false,
      autoShard: false,
      autoEat: false,
    };
    this._timers = new Map();
    this._disabled = false;
    this._connectCompleted = false;
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._firstSpawn = true;
    this._spawnTime = 0;
    this._fastKicks = 0;
    this._reconnectScheduled = false;
    this._isEating = false;
    this._isCleanedUp = false;
    this._wasKicked = false;       
    this._loginCmdDone = false;    
    this._lastReconnectTime = 0;
    this._reconnectTimestamps = [];
    this._healthProbed = false;
    this._consecutiveProxyFails = 0;
    this._proxyDisabledByFallback = false;
    this._sharedPool = SharedPool.global();
    this._packetTimeout = cfg.packetTimeout || TIMING.PACKET_TIMEOUT;
    this._entityTimeout = cfg.entityTimeout || TIMING.ENTITY_TIMEOUT;
    this._reconnectBaseDelay = cfg.reconnectBaseDelay || 1000;
    this._reconnectMaxDelay = cfg.reconnectMaxDelay || 60000;
    this._reconnectJitter = cfg.reconnectJitter ?? true;
    this._reconnectMaxRetries = cfg.reconnectMaxRetries || TIMING.MAX_RECONNECT;
    // "Money goal" — tự động chạy 1 macro ngay khi tiền đạt ngưỡng, thay vì
    // phải tự canh/đoán lúc nào đủ tiền. Reset lại khi tiền rớt dưới ngưỡng
    // (vd sau khi mua) nên sẽ tự lặp lại mỗi khi gom đủ tiền lần tiếp theo.
    this.moneyGoal = cfg.moneyGoal || null;
    this.moneyGoalMacro = cfg.moneyGoalMacro || null;
    this._moneyGoalFired = false;
    // Auto-sell khi đầy túi đồ — cùng cơ chế với Money Goal: tới ngưỡng %
    // đầy thì tự chạy 1 macro do bạn định nghĩa (vì cách bán tuỳ server,
    // không đoán bừa lệnh /sell). Có độ trễ reset (hysteresis) để tránh bắn
    // lặp lại liên tục nếu số ô dao động ngay sát ngưỡng.
    this.autoSellMacro = cfg.autoSellMacro || null;
    this.autoSellThreshold = cfg.autoSellThreshold ?? 90;
    this._autoSellFired = false;
    // Bảo vệ Lồng Spawn — khi BẬT: tự lưu toạ độ lồng trong spawnerSaveRange (5)
    // block quanh bot; cứ 5 tick quét người lạ trong spawnerProtectRange (20)
    // block; thấy người lạ -> lấy cúp (túi đồ, không có thì ender chest), giữ
    // shift đập hết lồng, cất item "lồng"/"spawn" vào ender chest. Không có cúp
    // ở cả 2 nơi -> gửi cảnh báo webhook liên tục.
    this.spawnerProtectRange = cfg.spawnerProtectRange || 20;
    this.spawnerSaveRange = cfg.spawnerSaveRange || 5;
    // Chỉ "canh gác" khi THỰC SỰ đang đứng cạnh lồng: phải có ít nhất 1 lồng đã lưu nằm trong
    // spawnerArmRange block quanh bot (và chunk đã tải, đúng là block lồng), liên tục ít nhất
    // spawnerArmDelayMs. Nhờ vậy lúc vừa đăng nhập ở khu spawn (chưa được chuyển về chỗ cũ)
    // có người chơi đứng gần cũng KHÔNG bị báo nhầm là có người cạnh lồng.
    this.spawnerArmRange = cfg.spawnerArmRange || 8;
    this.spawnerArmDelayMs = cfg.spawnerArmDelayMs ?? 3000;
    this._spawnerZone = 'unknown'; // 'in' = đang cạnh lồng | 'out' = không có lồng quanh bot
    this._spawnerArmedSince = 0;
    this.spawnerAutoDisconnect = cfg.spawnerAutoDisconnect ?? false;
    this.spawnerAutoMine = cfg.spawnerAutoMine ?? true;
    this.spawnerRequireSilk = cfg.spawnerRequireSilk ?? true; // đào không Silk Touch thì lồng bị phá mất, không rơi ra
    this.enderChestCommand = cfg.enderChestCommand ?? '/ec';  // lệnh mở ender chest khi không có rương thật gần đó
    this.spawnerAlertIntervalMs = cfg.spawnerAlertIntervalMs || 5000;
    this.spawnerWhitelist = (cfg.spawnerWhitelist || []).map(n => String(n).toLowerCase());
    this.protectedSpawners = (cfg.protectedSpawners || []).map(p => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }));
    this._spawnerProtectOn = !!cfg.spawnerProtectOn; // ý định bật — thực sự khởi động ở _resumeIntendedStates() khi online
    this._spawnerAlertedAt = new Map();
    this._spawnerBusy = false;
    this._spawnerRetryAt = 0;
    this._spawnerNoPickUntil = 0;
    // Auto-sell Spawn — định kỳ (giờ/phút/giây tuỳ chỉnh): với từng lồng trong danh sách
    // chuột phải vào lồng (mở GUI, KHÔNG đập block) -> click 1 ô trong GUI (mặc định 51)
    // -> đóng GUI -> sang lồng kế tiếp. Bot không tự đi tới lồng: phải đứng trong tầm với.
    this._sellSpawnOn = !!cfg.autoSellSpawnOn;
    this.sellSpawnList = (cfg.autoSellSpawnList || []).map(p => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }));
    this.autoSellSpawnSlot = Number.isInteger(cfg.autoSellSpawnSlot) && cfg.autoSellSpawnSlot >= 0 ? cfg.autoSellSpawnSlot : 51;
    this.autoSellSpawnButton = cfg.autoSellSpawnButton === 1 ? 1 : 0; // 0 = chuột trái, 1 = chuột phải
    this.autoSellSpawnSecond = Math.max(0, Number(cfg.autoSellSpawnSecond) || 0);
    this.autoSellSpawnMinute = Math.max(0, Number(cfg.autoSellSpawnMinute) || 0);
    this.autoSellSpawnHour = Math.max(0, Number(cfg.autoSellSpawnHour) || 0);
    if (['autoSellSpawnSecond', 'autoSellSpawnMinute', 'autoSellSpawnHour'].every(k => cfg[k] === undefined || cfg[k] === null)) {
      this.autoSellSpawnMinute = 5; // chưa cấu hình gì -> mặc định 5 phút/lần
    }
    this.autoSellSpawnRange = cfg.autoSellSpawnRange || 5; // bán kính tự quét lồng quanh bot khi bật
    this._sellSpawnBusy = false;
    this._sellSpawnAbort = false;
    // Doanh thu: server báo số tiền bán được (vd 1.25k / 2.4m / 1.1b) vào chat của chính bot.
    // Trong lúc chạy vòng bán (+ vài giây sau) bot đọc các tin đó, cộng lại, ghi vào RevenueTracker
    // rồi gửi báo cáo (doanh thu/giờ, /ngày) qua webhook.
    this.autoSellSpawnRevenue = cfg.autoSellSpawnRevenue ?? true;
    this.autoSellSpawnMsgKeyword = String(cfg.autoSellSpawnMsgKeyword || ''); // chỉ tính tin chứa chữ này (nhiều chữ ngăn bằng |)
    this.autoSellSpawnMsgPattern = String(cfg.autoSellSpawnMsgPattern || ''); // regex tuỳ chọn (nhóm 1 = số tiền) — chỉ đặt trong config.json
    this.autoSellSpawnIgnoreChat = cfg.autoSellSpawnIgnoreChat ?? true;       // bỏ qua chat của người chơi (position 'chat')
    this.autoSellSpawnReportMin = Math.max(0, Number(cfg.autoSellSpawnReportMin) || 0); // khoảng cách tối thiểu giữa 2 báo cáo (phút), 0 = mỗi vòng 1 báo cáo
    this._sellCap = null;
    this._revLastReportAt = 0;
    this._revPending = { amount: 0, cycles: 0 };
    // Doanh thu của AUTO-SELL MACRO (autosell <%đầy> <macro>): đo tiền server báo vào chat trong lúc macro
    // bán chạy (+ vài giây sau), ghi vào RevenueTracker (khoá "<id>#macro") rồi gửi báo cáo qua webhook.
    this.autoSellRevenue = cfg.autoSellRevenue ?? true;
    this.autoSellMsgKeyword = String(cfg.autoSellMsgKeyword || '');   // chỉ tính tin chứa chữ này (nhiều chữ ngăn bằng |)
    this.autoSellMsgPattern = String(cfg.autoSellMsgPattern || '');   // regex tuỳ chọn (nhóm 1 = số tiền)
    this.autoSellIgnoreChat = cfg.autoSellIgnoreChat ?? true;         // bỏ qua chat của người chơi
    this.autoSellReportMin = Math.max(0, Number(cfg.autoSellReportMin) || 0); // giãn cách tối thiểu giữa 2 báo cáo (phút), 0 = mỗi lần bán 1 báo cáo
    this._macroSellCap = null;
    this._macroRevLastReportAt = 0;
    this._macroRevPending = { amount: 0, cycles: 0 };
    // Xoay proxy tự động — mỗi lần cách nhau ngẫu nhiên (không phải chu kỳ
    // cố định, để tránh tạo pattern dễ nhận ra) trong khoảng min~max phút.
    this.proxyAutoRotate = !!cfg.proxyAutoRotate;
    this.proxyRotateMinMs = Math.max(1, cfg.proxyRotateMinMinutes ?? 1) * 60000;
    this.proxyRotateMaxMs = Math.max(this.proxyRotateMinMs, (cfg.proxyRotateMaxMinutes ?? 10) * 60000);
    this.packetMgr.on('anomaly', data => {
      this.emit('packetAnomaly', data);
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('packetAnomaly', data);
      }
    });
    this._registerCommands();
  }
  log(level, msg) {
    const entry = { id: this.cfg.id, time: nowMs(), level, msg };
    this._logBuffer.push(entry);
    this.emit('log', { level, id: this.cfg.id, msg, theme: this.theme, entry });
    if (this.socketRooms?.io) {
      this.socketRooms.io.to(`bot:${this.cfg.id}`).emit('log', entry);
    }
  }
  getLogs() {
    return this._logBuffer.toArray();
  }
  _setTimer(key, fn, delay, repeat = false) {
    this._clearTimer(key);
    let handle;
    if (repeat) {
      handle = setInterval(fn, delay);
    } else {
      handle = setTimeout(() => {
        this._timers.delete(key);
        fn();
      }, delay);
    }
    this._timers.set(key, { handle, repeat });
    return handle;
  }
  _clearTimer(key) {
    const t = this._timers.get(key);
    if (!t) return;
    t.repeat ? clearInterval(t.handle) : clearTimeout(t.handle);
    this._timers.delete(key);
  }
  _clearAllTimers() {
    for (const [key] of this._timers) this._clearTimer(key);
  }
  // Gửi thông báo Discord webhook (dùng chung, cấu hình ở BotManager) —
  // im lặng bỏ qua nếu chưa cấu hình webhook hoặc loại sự kiện này bị tắt.
  _notify(eventKey, title, description, color = 0x64748b) {
    const n = this._manager?.notifier;
    if (!n?.isEventOn(eventKey)) return;
    n.send(eventKey, {
      title, description, color,
      footer: { text: this.cfg.id },
      timestamp: new Date().toISOString(),
    });
  }
  static _VALID_TRANSITIONS = new Map([
    [CS.DISCONNECTED, new Set([CS.CONNECTING, CS.STOPPING])],
    [CS.CONNECTING, new Set([CS.AUTHENTICATING, CS.SPAWNING, CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING])],
    [CS.AUTHENTICATING, new Set([CS.SPAWNING, CS.ONLINE, CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING])],
    [CS.SPAWNING, new Set([CS.ONLINE, CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING])],
    [CS.ONLINE, new Set([CS.RECONNECTING, CS.DISCONNECTED, CS.STOPPING, CS.CONNECTING])],
    [CS.RECONNECTING, new Set([CS.DISCONNECTED, CS.CONNECTING, CS.STOPPING])],
    [CS.STOPPING, new Set([CS.DISCONNECTED])],
  ]);
  _setState(newState) {
    const prev = this.state.connState;
    if (prev === newState) return;
    const allowed = BotSession._VALID_TRANSITIONS.get(prev);
    if (allowed && !allowed.has(newState) && prev !== newState) {
      if (!(this._disabled && newState === CS.DISCONNECTED) && !(prev === CS.STOPPING && newState === CS.DISCONNECTED)) {
        this.emit('invalidTransition', { prev, attempted: newState, id: this.cfg.id });
      }
    }
    this.state.connState = newState;
    this.emit('stateChange', { prev, now: newState, id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('botState', { id: this.cfg.id, state: newState });
    }
  }
  get isOnline()        { return this.state.connState === CS.ONLINE; }
  get isConnected()     { return [CS.ONLINE, CS.SPAWNING, CS.AUTHENTICATING].includes(this.state.connState); }
  get isStopping()      { return this.state.connState === CS.STOPPING; }
  get isReconnecting()  { return this.state.connState === CS.RECONNECTING; }
  get isOffline()       { return this.state.connState === CS.DISCONNECTED; }
  requireOnline(cmdName = '') {
    if (!this.isOnline) {
      this.log('warn', `Bot chưa ONLINE${cmdName ? ' — lệnh "' + cmdName + '" bị bỏ qua' : ''}`);
      return false;
    }
    return true;
  }
  _updateShard(n) {
    if (n === null || n === this.state.shard) return;
    const prev = this.state.shard;
    this.state.shard = n;
    this.emit('shard', { prev, now: n, id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('shard', { id: this.cfg.id, shard: n });
    }
  }
  _updateMoney(n) {
    if (n === null || n === this.state.money) return;
    const prev = this.state.money;
    this.state.money = n;
    this.emit('money', { prev, now: n, id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('money', { id: this.cfg.id, money: n });
    }
    if (this.moneyGoal) {
      if (n >= this.moneyGoal && !this._moneyGoalFired) {
        this._moneyGoalFired = true;
        this.log('ok', `🎯 Đã đủ ${this.moneyGoal.toLocaleString()} (hiện có ${n.toLocaleString()})${this.moneyGoalMacro ? ` — tự chạy macro "${this.moneyGoalMacro}"` : ''}`);
        this._notify('moneyGoal', `🎯 ${this.cfg.id}: đã đủ tiền`, `Mục tiêu ${this.moneyGoal.toLocaleString()}, hiện có ${n.toLocaleString()}.${this.moneyGoalMacro ? ` Tự chạy macro "${this.moneyGoalMacro}".` : ''}`, 0xfbbf24);
        if (this.moneyGoalMacro) {
          this.macroEngine.run(this.moneyGoalMacro).catch(e => this.log('err', `Goal macro lỗi: ${e.message}`));
        }
      } else if (n < this.moneyGoal) {
        this._moneyGoalFired = false; // sẵn sàng bắn lại lần kế tiếp gom đủ tiền
      }
    }
  }
  _updateInventory() {
    if (!this.mc?.inventory) return;
    try {
      const inv = [];
      const items = this.mc.inventory.items();
      for (const item of items) {
        if (!item) continue;
        inv.push({
          slot: item.slot,
          name: resolveText(item.customName || item.displayName || item.name || 'Unknown'),
          type: item.name || item.type,
          count: item.count,
          lore: item.customLore ? safeJsonStringify(item.customLore).substring(0, 200) : '',
          stackId: item.stackId,
        });
      }
      this.state.inventory = inv;
      this.emit('inventory', { id: this.cfg.id, items: inv });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('inventory', { id: this.cfg.id, items: inv });
      }
      this._checkAutoSell(items.length);
    } catch (e) {
      this.log('err', 'Lỗi đọc inventory: ' + e.message);
    }
  }
  // 36 = 27 ô chính + 9 ô hotbar (Window.items() của mineflayer với inventory
  // của chính bot chỉ trả về đúng vùng này, không tính giáp/offhand/crafting).
  _checkAutoSell(usedSlots) {
    if (!this.autoSellMacro) return;
    const TOTAL = 36;
    const highSlots = Math.ceil(TOTAL * this.autoSellThreshold / 100);
    const lowSlots = Math.max(0, highSlots - 4);
    if (usedSlots >= highSlots && !this._autoSellFired) {
      this._autoSellFired = true;
      const pct = Math.round((usedSlots / TOTAL) * 100);
      this.log('ok', `🎒 Túi đồ đầy ${pct}% (${usedSlots}/${TOTAL}) — tự chạy macro "${this.autoSellMacro}"`);
      this._notify('autoSell', `🎒 ${this.cfg.id}: túi đồ đầy`, `${usedSlots}/${TOTAL} ô (${pct}%) — tự chạy macro "${this.autoSellMacro}".`, 0x38bdf8);
      const cap = this.autoSellRevenue ? this._beginMacroSellCapture(this.autoSellMacro) : null; // bắt đầu đo TRƯỚC khi macro chạy
      this.macroEngine.run(this.autoSellMacro)
        .then(ok => { if (cap) this._onMacroSellDone(cap, ok); })
        .catch(e => { this.log('err', `Auto-sell macro lỗi: ${e.message}`); if (cap) this._onMacroSellDone(cap, false); });
    } else if (usedSlots <= lowSlots) {
      this._autoSellFired = false;
    }
  }
  _cleanupOnDisconnect() {
    if (this._macroSellCap) { try { this._finalizeMacroSellRevenue(true); } catch { } }
    if (this._sellCap) { try { this._finalizeSellRevenue(true); } catch { } } // còn doanh thu đang gom dở -> ghi nốt trước khi mất kết nối
    this._clearAllTimers();
    this._spawnerBusy = false;
    this._sellSpawnAbort = true; // vòng auto-sell spawn đang chạy (nếu có) sẽ tự thoát và tự trả cờ busy
    this.packetMgr.detach();
    this.afkStop();
    this.state.afk = null;
    this.state.intendedAfk = null;
    this.state.ping = -1;
    this.state.loginTime = null;
    this._firstSpawn = true;
    this._spawnTime = 0;
    this._isCleanedUp = true;
  }
  _destroyMc() {
    if (!this.mc) return;
    const mc = this.mc;
    this.mc = null;
    try {
      const c = mc._client;
      if (c) {
        c.removeAllListeners();
        if (this.packetMgr._origWrite && c.write === this.packetMgr._boundWrite) {
          c.write = this.packetMgr._origWrite;
        }
        c.end = () => {};
      }
    } catch { }
    try { mc.removeAllListeners(); } catch { }
    try { mc.end('cleanup'); } catch { }
    this._isCleanedUp = true;
  }
  scheduleReconnect(reason) {
    if (this._disabled || this.isStopping) return;
    if (this._reconnectScheduled) return;
    if (this.isReconnecting) return;
    const now = nowMs();
    const sinceLast = now - this._lastReconnectTime;
    const cooldownMs = this._wasKicked ? TIMING.RECONNECT_COOLDOWN_KICK_MS : TIMING.RECONNECT_COOLDOWN_MS;
    this._wasKicked = false;
    if (this._lastReconnectTime > 0 && sinceLast < cooldownMs) {
      const waitMs = cooldownMs - sinceLast;
      this.log('warn', `Reconnect bị chặn (cooldown ${Math.ceil(waitMs / 1000)}s)${reason ? ' — ' + reason : ''}`);
      this._setTimer('reconnect_cooldown', () => this.scheduleReconnect(reason), waitMs + 500);
      return;
    }
    const windowStart = now - TIMING.RECONNECT_WINDOW_MS;
    this._reconnectTimestamps = this._reconnectTimestamps.filter(t => t > windowStart);
    if (this._reconnectTimestamps.length >= TIMING.RECONNECT_MAX_IN_WINDOW) {
      this._reconnectScheduled = true;
      this.log('err', `Quá ${TIMING.RECONNECT_MAX_IN_WINDOW} lần reconnect trong ${TIMING.RECONNECT_WINDOW_MS / 60000}ph — tạm dừng 5 phút`);
      this._setState(CS.DISCONNECTED);
      this._setTimer('reconnect_rate_limited', () => {
        if (this._disabled) return;
        this._reconnectTimestamps = [];
        this._lastReconnectTime = 0;
        this.log('warn', 'Hết thời gian chờ rate-limit, thử lại...');
        this._reconnectScheduled = false;
        this.start();
      }, 5 * 60 * 1000);
      return;
    }
    this._reconnectTimestamps.push(now);
    this._lastReconnectTime = now;
    if (this._manager && this._manager._activeConnects >= TIMING.MAX_CONCURRENT_CONNECTS) {
      this._setTimer('reconnect_queued', () => this.scheduleReconnect(reason), 3000);
      return;
    }
    this._reconnectScheduled = true;
    this._setState(CS.RECONNECTING);
    const spawnAge = this._spawnTime > 0 ? nowMs() - this._spawnTime : Infinity;
    const savedFastKicks = this._fastKicks;
    this._cleanupOnDisconnect();
    this._destroyMc();
    if (this.state.reconnects >= this._reconnectMaxRetries) {
      this.log('err', `Đã đạt giới hạn ${this._reconnectMaxRetries} reconnect — thử lại sau 15 phút`);
      this._notify('reconnectFailed', `🔴 ${this.cfg.id}: hết lượt reconnect`,
        `Đã thử ${this._reconnectMaxRetries} lần không thành công${reason ? ` (lý do gần nhất: ${reason})` : ''}. Sẽ tự thử lại sau 15 phút.`, 0xef4444);
      this._setState(CS.DISCONNECTED);
      this._reconnectScheduled = false;
      this._setTimer('reconnect_longwait', () => {
        if (this._disabled) return;
        this.log('warn', 'Thử kết nối lại sau giới hạn reconnect...');
        this.state.reconnects = 0;
        this._fastKicks = 0;
        this._reconnectScheduled = false;
        this.start();
      }, 15 * 60 * 1000);
      return;
    }
    const fastKick = spawnAge < 10000;
    if (fastKick) {
      this._fastKicks = savedFastKicks + 1;
    } else {
      this._fastKicks = 0;
    }
    const retries = Math.min(this.state.reconnects, 12);
    const expBackoff = Math.min(
      this._reconnectBaseDelay * Math.pow(2, retries),
      this._reconnectMaxDelay
    );
    const extraDelay = fastKick ? Math.min(this._fastKicks * TIMING.FAST_KICK_EXTRA_MS, TIMING.FAST_KICK_EXTRA_MAX) : 0;
    const base = expBackoff + extraDelay;
    const delay = this._reconnectJitter ? jit(base, Math.round(base * 0.3)) : base;
    this.state.reconnects++;
    const maxRetryStr = this._reconnectMaxRetries >= 999 ? '∞' : String(this._reconnectMaxRetries);
    this.log('warn', `Mất kết nối${reason ? ' (' + reason + ')' : ''}${fastKick ? ' [FAST KICK x' + this._fastKicks + ']' : ''} — thử lại lần ${this.state.reconnects}/${maxRetryStr} sau ${(delay / 1000).toFixed(1)}s (backoff)`);
    this.emit('disconnectReason', { id: this.cfg.id, reason, fastKick, retry: this.state.reconnects });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('disconnectReason', { id: this.cfg.id, reason, fastKick, retry: this.state.reconnects });
    }
    this._setTimer('reconnect', () => {
      this._reconnectScheduled = false;
      if (this._disabled || this.isStopping) return;
      this.start();
    }, delay);
  }
  cancelReconnect() {
    this._clearTimer('reconnect');
    this._clearTimer('reconnect_longwait');
    this._clearTimer('reconnect_queued');
    this._clearTimer('reconnect_cooldown');
    this._clearTimer('reconnect_rate_limited');
    this._clearTimer('start_queued');
    this._reconnectScheduled = false;
    this._reconnectTimestamps = [];
    this._lastReconnectTime = 0;
    if (this.isReconnecting) this._setState(CS.DISCONNECTED);
  }
  _disableProxyFallback() {
    if (this._proxyDisabledByFallback) return;
    this._proxyDisabledByFallback = true;
    this.proxy = null;
    this.cfg.useProxy = false;
    if (this._manager?.dashboard?._syncBotToConfig) {
      this._manager.dashboard._syncBotToConfig(this);
    }
    this.log('warn', `⚠️ Proxy đã bị tắt tự động sau ${TIMING.PROXY_FAIL_THRESHOLD} lần fail liên tiếp — chuyển sang kết nối thẳng`);
    this.emit('proxyFallback', { id: this.cfg.id });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('proxyFallback', { id: this.cfg.id });
    }
  }
  forceReconnect() {
    this.log('sys', 'Force reconnect...');
    this.cancelReconnect();
    this._onConnectComplete();
    this.state.reconnects = 0;
    this._fastKicks = 0;
    this._setState(CS.DISCONNECTED);
    this._cleanupOnDisconnect();
    this._destroyMc();
    this._lastReconnectTime = nowMs();
    this._reconnectScheduled = true;
    this._setTimer('reconnect', () => {
      this._reconnectScheduled = false;
      this.start();
    }, 500);
  }
  async start() {
    if (this._disabled || this.isStopping) return;
    if (this.isConnected) {
      this.log('warn', 'start() gọi khi bot đã kết nối — bỏ qua');
      return;
    }
    if (this._manager && this._manager._activeConnects >= TIMING.MAX_CONCURRENT_CONNECTS) {
      this._setTimer('start_queued', () => this.start(), 3000);
      return;
    }
    this._destroyMc();
    this._clearAllTimers();
    this._reconnectScheduled = false;
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._firstSpawn = true;
    this._spawnTime = 0;
    this._healthProbed = false;
    this._loginCmdDone = false;    
    this._wasKicked = false;       
    this._proxyDisabledByFallback = false;  
    this._setState(CS.CONNECTING);
    this._connectCompleted = false;
    if (this._manager) this._manager._activeConnects = (this._manager._activeConnects || 0) + 1;
    const { cfg } = this;
    const proxy = this.proxy || (cfg.useProxy === true ? this.proxyManager.next(cfg.id) : null);
    let proxySocket = null;
    if (proxy) {
      this.log('proxy', `Kết nối qua ${proxy.type}://${proxy.host}:${proxy.port}`);
      try {
        proxySocket = await this.proxyManager.connect(proxy, cfg.host, cfg.port);
        proxySocket.on('error', () => {});
      } catch (e) {
        this._consecutiveProxyFails++;
        this.log('err', `Proxy lỗi: ${e.message} (fail ${this._consecutiveProxyFails}/${TIMING.PROXY_FAIL_THRESHOLD}) — thử kết nối thẳng`);
        if (proxySocket) { try { proxySocket.destroy(); } catch {} proxySocket = null; }
        if (this._consecutiveProxyFails >= TIMING.PROXY_FAIL_THRESHOLD) {
          this._disableProxyFallback();
        }
      }
    }
    if (this._disabled || this.isStopping) {
      if (proxySocket) { try { proxySocket.destroy(); } catch {} }
      this._onConnectComplete();
      this._setState(CS.DISCONNECTED);
      return;
    }
    try { await this._sharedPool.resolveDns(cfg.host); } catch { }
    if (proxySocket) this._sharedPool.optimizeSocket(proxySocket);
    const botOpts = {
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      version: cfg.version,
      respawn: false,
      hideErrors: true,
      ...(proxySocket ? { stream: proxySocket } : {}),
      noDelay: true,               
      ...(cfg.skipValidation ? { skipValidation: true } : {}),
      ...(cfg.viewDistance ? { viewDistance: cfg.viewDistance } : {}),
      ...(cfg.authMode === 'microsoft' ? {
        auth: 'microsoft',
        // Mỗi bot 1 thư mục cache token riêng — nhiều acc premium trên cùng
        // máy sẽ không bị đè token của nhau, và không phải đăng nhập lại
        // qua trình duyệt mỗi lần reconnect (chỉ lần đầu).
        profilesFolder: path.join(process.cwd(), 'auth_cache', String(cfg.id)),
      } : {}),
    };
    if (cfg.authMode === 'microsoft' && !this._msAuthNoticeShown) {
      this._msAuthNoticeShown = true;
      this.log('sys', `Acc Premium (Microsoft) — nếu là lần đầu, link + mã xác thực sẽ hiện ra dưới dạng chữ thô (không có màu) ngay bên dưới, mở trình duyệt máy khác để đăng nhập. Token sau đó được lưu lại, các lần sau tự kết nối không cần đăng nhập lại.`);
    }
    let mc;
    try {
      mc = mineflayer.createBot(botOpts);
    } catch (e) {
      this.log('err', 'Không tạo được bot: ' + e.message);
      if (proxySocket) { try { proxySocket.destroy(); } catch {} }
      this._onConnectComplete();
      this._setState(CS.DISCONNECTED);
      this.scheduleReconnect('createBot failed');
      return;
    }
    this.mc = mc;
    this.packetMgr.attach(mc);
    this._bindEvents(mc, proxy);
  }
  _onConnectComplete() {
    if (this._connectCompleted) return;
    this._connectCompleted = true;
    if (this._manager) this._manager._activeConnects = Math.max(0, (this._manager._activeConnects || 1) - 1);
  }
  _bindEvents(mc, proxy) {
    const { cfg, state: s } = this;
    mc.setMaxListeners(50);
    if (mc._client) mc._client.setMaxListeners(50);
    mc.once('login', () => {
      this._setState(CS.AUTHENTICATING);
      s.loginTime = nowMs();
      this.log('ok', `Đã đăng nhập → ${cfg.host}:${cfg.port}` +
        (proxy ? ` [${proxy.type}://${proxy.host}:${proxy.port}]` : ''));
      if (mc._client?.socket) {
        this._sharedPool.optimizeSocket(mc._client.socket);
      }
      if (cfg.sendClientSettings !== false && mc._client && !mc._client.ended) {
        try {
          mc._client.write('settings', cfg.clientSettings || {
            locale: 'en_US',
            viewDistance: 2,
            chatMode: 0,
            chatColors: true,
            displayedSkinParts: 255,
            mainHand: 1,
            enableTextFiltering: false,
            allowServerListings: true,
          });
          this.log('sys', 'Đã gửi client settings (vanilla profile)');
        } catch (e) {
          this.log('err', 'Lỗi settings: ' + e.message);
        }
      }
      this._setTimer('loginCmd', () => {
        if (!this.isConnected) return;
        try {
          if (!cfg.botPassword) { this._loginCmdDone = true; return; }
          if (cfg.registered === false) {
            mc.chat(`/dk ${cfg.botPassword}`);
            cfg.registered = true;
            this.log('ok', 'Đã gửi /dk');
            this._setTimer('loginDn', () => {
              if (!this.isConnected) return;
              try {
                mc.chat(`/dn ${cfg.botPassword}`);
                this.log('ok', 'Đã gửi /dn');
                this._loginCmdDone = true;
                this._startMenuIfPending();
              } catch (e) {
                this.log('err', 'Lỗi gửi /dn: ' + e.message);
                this._loginCmdDone = true;
              }
            }, rand(1500, 2500));
          } else {
            mc.chat(`/dn ${cfg.botPassword}`);
            this.log('ok', 'Đã gửi /dn');
            this._loginCmdDone = true;
            this._setTimer('loginDnDelay', () => {
              if (!this.isConnected) return;
              this._startMenuIfPending();
            }, rand(1500, 2500));
          }
        } catch (e) {
          this.log('err', 'Lỗi gửi auth cmd: ' + e.message);
        }
      }, rand(4000, 8000));
    });
    let _usedProxy = !!proxy;
    mc.on('spawn', () => {
      this._spawnerZone = 'unknown'; // vào/đổi khu vực -> tính lại việc có lồng cạnh bot không
      this._spawnerArmedSince = 0;
      if (this._firstSpawn) {
        this._firstSpawn = false;
        this._onConnectComplete();
        this._setState(CS.ONLINE);
        this._spawnTime = nowMs();
        this.log('ok', 'Spawn thành công');
        if (_usedProxy && this._consecutiveProxyFails > 0) {
          this._consecutiveProxyFails = 0;
          this.log('sys', 'Proxy hoạt động — reset fail counter');
        }
        this._setTimer('stable', () => {
          if (this.isOnline) {
            if (s.reconnects > 0) this._notify('reconnectRecovered', `🟢 ${this.cfg.id}: đã kết nối lại ổn định`, `Sau ${s.reconnects} lần thử.`, 0x22c55e);
            s.reconnects = 0; this._fastKicks = 0; this._reconnectScheduled = false; this.log('sys', 'Kết nối ổn định');
          }
        }, TIMING.STABLE_TIME);
        this._setTimer('poll', () => this._pollTick(),
          jit(this.settings.pollInterval, this.settings.pollJitter / 2));
        this._setTimer('healthStart', () => this._startHealthCheck(), TIMING.HEALTH_GRACE_MS);
        this._setTimer('invUpdate', () => this._updateInventory(), 3000);
        if (cfg.autoMenu && cfg.menuCommand) {
          if (!cfg.botPassword || (cfg.registered && this._loginCmdDone)) {
            this._menuRetryCount = 0;
            this._menuSuccess = false;
            this._scheduleMenuRetry();
          }
        } else {
          this._resumeIntendedStates();
        }
      } else {
        this.log('sys', 'Đã hồi sinh (respawn)');
        this._resumeIntendedStates();
      }
    });
    mc.on('death', () => {
      const d = rand(2500, 8000);
      this.log('warn', `Chết — respawn sau ${d}ms`);
      this._setTimer('respawn', () => {
        if (this.isOnline) try { mc.respawn(); } catch { }
      }, d);
    });
    mc.on('ping', p => {
      s.ping = typeof p === 'number' ? p : -1;
      this.emit('ping', { id: cfg.id, ping: s.ping });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('ping', { id: cfg.id, ping: s.ping });
      }
    });
    mc.on('move', () => {
      if (mc.entity?.position) {
        s.position = { x: mc.entity.position.x, y: mc.entity.position.y, z: mc.entity.position.z };
      }
    });
    mc.on('health', () => {
      s.health = mc.health ?? 20;
      s.food = mc.food ?? 20;
      if (s.autoEat && mc.food !== undefined && mc.food < (this.settings.eatThreshold || 15) && !this._isEating) {
        this._eatFood().catch(() => {});
      }
      this.emit('health', { id: cfg.id, health: s.health, food: s.food });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('health', { id: cfg.id, health: s.health, food: s.food });
      }
    });
    const scheduleInvUpdate = (delay) =>
      this._setTimer('invDebounce', () => this._updateInventory(), delay);
    mc.on('playerCollect', () => scheduleInvUpdate(500));
    mc.on('windowClose', () => scheduleInvUpdate(300));
    mc.on('setSlot', () => scheduleInvUpdate(200));
    mc.on('message', (json, pos) => {
      try {
        const text = resolveText(json?.json ?? json);
        if (!text.trim()) return;
        if (pos === 'game_info' || pos === 'action_bar') {
          this.tryChatShard(text);
          return;
        }
        if (this._sellCap) this._captureSellRevenue(text, pos);
        if (this._macroSellCap) this._captureMacroSellRevenue(text, pos);
        this.log('chat', text);
        this.tryChatShard(text);
      } catch (e) {
        this.log('err', 'Lỗi message: ' + e.message);
      }
    });
    mc.on('messagestr', (msg, pos) => {
      try { if (pos === 'gameInfo') this.tryChatShard(msg); } catch { }
    });
    mc.on('scoreboardUpdated', () => {
      try {
        this._updateShard(this.readShard());
        const board = this.readBoard();
        const money = this._extractBoardStat(board, ['MONEY', 'TIỀN', 'TIEN', 'XU', 'COIN']);
        if (money !== null) this._updateMoney(money);
      } catch { }
    });
    mc.on('windowOpen', win => {
      if (this._spawnerBusy) return; // routine bảo vệ lồng đang tự điều khiển ender chest
      if (this._sellSpawnBusy) return; // routine auto-sell spawn đang tự điều khiển GUI lồng
      if (this.macroEngine?._running) {
        // Macro đang chạy (winclick) — không để WindowRouter tự động
        // click/đóng GUI đè lên, nhường toàn quyền điều khiển cho macro.
        this.log('sys', `Macro đang điều khiển GUI [${resolveText(win.title || '').substring(0, 40)}] — bỏ qua auto-xử lý`);
        return;
      }
      this._setTimer('winOpen_' + win.id, () => {
        if (!this.isOnline) return;
        try {
          const title = resolveText(win.title || '').toUpperCase();
          if (cfg.autoMenu && cfg.menuCommand && !this._menuSuccess) {
            if (title.includes('MENU') || title.includes('LOBBY') || title.includes('HUB') ||
                title.includes('CHỌN') || title.includes('KHU') || title.includes('WORLD')) {
              this._menuSuccess = true;
              this._clearTimer('menuRetry');
              this.log('ok', `Đã vào server thành công qua menu: [${title.substring(0, 40)}]`);
              WindowRouter.route(this, win);
              this._resumeIntendedStates();
              return;
            }
          }
          WindowRouter.route(this, win);
        } catch (e) {
          this.log('err', 'Lỗi windowOpen: ' + e.message);
        }
      }, jit(2000, 600));
    });
    mc.on('kicked', reason => {
      this._wasKicked = true;  
      let m = parseReasonText(reason);
      if (!m) {
        try { m = JSON.stringify(reason).substring(0, 120); } catch { m = String(reason).substring(0, 80); }
      }
      const kickMsg = m || '(không rõ lý do)';
      this.log('warn', 'Bị kick: ' + kickMsg);
      this._notify('disconnect', `🟠 ${this.cfg.id}: bị kick`, kickMsg, 0xf97316);
      this.emit('kicked', { id: this.cfg.id, reason: kickMsg, raw: reason });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('kicked', { id: this.cfg.id, reason: kickMsg });
      }
    });
    mc.once('end', reason => {
      this._onConnectComplete();
      const m = parseReasonText(reason);
      const endReason = m || 'connection ended';
      this.emit('disconnected', { id: this.cfg.id, reason: endReason });
      if (this.socketRooms?.io) {
        this.socketRooms.io.emit('botDisconnected', { id: this.cfg.id, reason: endReason });
      }
      if (_usedProxy && this._spawnTime === 0) {
        this._consecutiveProxyFails++;
        if (this._consecutiveProxyFails >= TIMING.PROXY_FAIL_THRESHOLD) {
          this._disableProxyFallback();
        }
      }
      if (this.isStopping || this.isReconnecting || !this.mc || this.mc !== mc) return;
      this.scheduleReconnect(endReason);
    });
    mc.on('error', err => {
      const m = err?.message || String(err);
      if (IGNORED_ERRORS.some(k => m.includes(k))) return;
      this.log('err', m);
      this.emit('botError', { id: this.cfg.id, error: m });
    });
  }
  _startHealthCheck() {
    this._clearTimer('health');
    this._healthProbed = false;
    const check = () => {
      if (!this.isOnline) return;
      const mc = this.mc;
      try {
        const onlineFor = this._spawnTime > 0 ? nowMs() - this._spawnTime : 0;
        if (onlineFor < TIMING.HEALTH_GRACE_MS) return;
        const client = mc?._client;
        const socketAlive = client && !client.ended && (
          (client.socket && !client.socket.destroyed && client.socket.writable) ||
          (client.stream && !client.stream.destroyed && client.stream.writable)
        );
        const packetAge = this.packetMgr.lastPacketAt ? nowMs() - this.packetMgr.lastPacketAt : Infinity;
        const halfTimeout = this._packetTimeout / 2;
        if (!socketAlive && packetAge > 15000) {
          this.log('health', 'Socket chết + không packet — reconnect');
          this.scheduleReconnect('socket dead');
          return;
        }
        if (packetAge > this._packetTimeout) {
          this.log('health', `Không nhận packet trong ${Math.round(packetAge / 1000)}s — reconnect`);
          this.scheduleReconnect('packet timeout');
          return;
        }
        if (packetAge > halfTimeout && socketAlive && !this._healthProbed) {
          this._healthProbed = true;
          this.log('health', `Không packet ${Math.round(packetAge / 1000)}s — gửi probe...`);
          try {
            if (mc._client && !mc._client.ended) {
              if (this.cfg.sendClientSettings !== false && mc._client && !mc._client.ended) {
                mc._client.write('settings', {
                  locale: 'en_US',
                  viewDistance: 2,
                  chatMode: 0,
                  chatColors: true,
                  displayedSkinParts: 255,
                  mainHand: 1,
                  enableTextFiltering: false,
                  allowServerListings: true,
                });
              } else {
                mc._client.write('tab_complete', { text: '/', assumeCommand: false });
              }
            }
          } catch (e) {
            this.log('health', 'Probe thất bại: ' + e.message);
          }
          return; 
        }
        if (packetAge > halfTimeout && this._healthProbed) {
          this.log('health', `Đã probe nhưng không phản hồi sau ${Math.round(packetAge / 1000)}s — reconnect`);
          this.scheduleReconnect('no response to probe');
          return;
        }
        if (packetAge < halfTimeout) {
          this._healthProbed = false;
        }
        if (!mc?.entity && onlineFor > this._entityTimeout && packetAge > 30000) {
          this.log('health', `Entity null sau ${Math.round(onlineFor / 1000)}s + không packet — reconnect`);
          this.scheduleReconnect('entity null + no packets');
          return;
        }
      } catch (e) {
        this.log('err', 'Lỗi health check: ' + e.message);
      }
    };
    this._setTimer('health', check, jit(TIMING.HEALTH_INTERVAL, TIMING.HEALTH_JITTER), true);
  }
  _pollTick() {
    if (!this.isOnline) return;
    this._updateShard(this.readShard());
    this._updateInventory();
    this._setTimer('poll', () => this._pollTick(),
      jit(this.settings.pollInterval, this.settings.pollJitter));
  }
  _startAutoStats() {
    this._clearTimer('autoStatsLoop');
    const loop = () => {
      if (!this.isOnline || !this.state.autoStats) return;
      try { this.mc.chat('/stats'); } catch (e) {
        this.log('err', 'Auto stats lỗi: ' + e.message);
      }
      this._setTimer('autoStatsLoop', loop, 60000);
    };
    this._setTimer('autoStatsLoop', loop, 5000);
  }
  _startAutoShard() {
    this._clearTimer('autoShardLoop');
    const loop = () => {
      if (!this.isOnline || !this.state.autoShard) return;
      try {
        const n = this.readShard();
        if (n !== null) this._updateShard(n);
      } catch (e) {
        this.log('err', 'Auto shard lỗi: ' + e.message);
      }
      this._setTimer('autoShardLoop', loop, 30000);
    };
    this._setTimer('autoShardLoop', loop, 3000);
  }
  _resumeIntendedStates() {
    if (!this.isOnline) return;
    if (this.state.intendedAfk) {
      this._setTimer('resumeAfk', () => {
        if (!this.isOnline) return;
        if (this.state.intendedAfk === 'jump') this.afkJump();
        else if (this.state.intendedAfk === 'walk') this.afkWalk();
        this.log('sys', `Đã tự động khôi phục AFK: ${this.state.intendedAfk}`);
      }, 3000);
    }
    if (this.state.tshard) {
      this._setTimer('resumeTshard', () => {
        if (!this.isOnline || !this.state.tshard) return;
        try {
          this.mc.chat('/warp afk');
          this.log('sys', 'Tự động gửi /warp afk (Treo Shard)');
        } catch (e) {
          this.log('err', 'Lỗi tự động Treo Shard: ' + e.message);
        }
      }, 5000);
    }
    if (this.state.autoStats) this._startAutoStats();
    if (this.state.autoShard) this._startAutoShard();
    if (this._spawnerProtectOn) this._startSpawnerProtect();
    if (this._sellSpawnOn && !this._timers.has('sellSpawn') && !this._sellSpawnBusy) this._startSellSpawn(true);
    if (this.proxyAutoRotate) this._scheduleProxyRotate();
  }
  // ===== Doanh thu Auto-sell Spawn =====
  get _rev() {
    const m = this._manager?.revenue;
    if (m) return m;
    if (!this._revFallback) this._revFallback = new RevenueTracker(null, () => this._manager?._scheduleTz?.() || 'Asia/Ho_Chi_Minh');
    return this._revFallback;
  }
  _beginSellCapture(total) {
    if (this._sellCap) this._finalizeSellRevenue(false); // vòng trước còn chưa chốt (vd chạy "now" liên tiếp)
    this._clearTimer('sellRevFinalize');
    this._sellCap = { start: nowMs(), total, done: 0, sum: 0, hits: 0, lines: [], ignored: [], ignoredCount: 0 };
  }
  // Trích số tiền từ 1 dòng chat. Mặc định: số có hậu tố k/m/b/t (1.25k, 2,4m, 3b) hoặc có ký hiệu $.
  // Có autoSellSpawnMsgPattern thì dùng regex đó (nhóm 1 = số tiền, không có nhóm thì lấy cả đoạn khớp).
  _extractSellAmount(text, patOverride) {
    const pat = patOverride !== undefined ? patOverride : this.autoSellSpawnMsgPattern;
    if (pat) {
      try {
        const m = new RegExp(pat, 'i').exec(text);
        if (!m) return null;
        return RevenueTracker.parseMoneyToken(m[1] ?? m[0]);
      } catch (e) {
        if (!this._revPatWarned) { this._revPatWarned = true; this.log('warn', `Auto-sell Spawn: autoSellSpawnMsgPattern không hợp lệ (${e.message}) — dùng cách đọc mặc định`); }
      }
    }
    const re = /(?:\$\s*|(?<![a-z0-9.,]))(\d+(?:[.,]\d+)*)\s*([kmbt])?(?![a-z0-9])/gi;
    for (const m of text.matchAll(re)) {
      const hasDollar = m[0].trimStart().startsWith('$');
      if (!m[2] && !hasDollar) continue; // số trần (64, 12...) không phải tiền
      const v = RevenueTracker.parseMoneyToken((hasDollar ? '$' : '') + m[1] + (m[2] || ''));
      if (v !== null && v > 0) return v;
    }
    return null;
  }
  _sellMsgMatchesKeyword(text, kwOverride) {
    const kw = String(kwOverride !== undefined ? kwOverride : this.autoSellSpawnMsgKeyword).trim();
    if (!kw) return true;
    const norm = s => normalizeSmallCaps(String(s)).normalize('NFC').toLowerCase();
    const t = norm(text);
    return kw.split('|').map(s => norm(s.trim())).filter(Boolean).some(k => t.includes(k));
  }
  _captureSellRevenue(text, pos) {
    const cap = this._sellCap;
    if (!cap) return;
    const amount = this._extractSellAmount(text);
    if (amount === null) return;
    const isPlayerChat = pos === 'chat';
    if ((this.autoSellSpawnIgnoreChat && isPlayerChat) || !this._sellMsgMatchesKeyword(text)) {
      cap.ignoredCount++;
      if (cap.ignored.length < 3) cap.ignored.push(`${isPlayerChat ? '[chat] ' : ''}${text.substring(0, 90)}`);
      return;
    }
    cap.sum += amount;
    cap.hits++;
    if (cap.lines.length < 40) cap.lines.push(text.substring(0, 90));
    this.log('sys', `Doanh thu: +${RevenueTracker.formatMoney(amount)} ← "${text.substring(0, 80)}"`);
  }
  // Chốt vòng: ghi vào tracker + gửi báo cáo webhook (quiet = chỉ ghi, không gửi — dùng khi đang mất kết nối)
  _finalizeSellRevenue(quiet = false) {
    const cap = this._sellCap;
    if (!cap) return null;
    this._sellCap = null;
    this._clearTimer('sellRevFinalize');
    if (!cap.done) return null; // không click được lồng nào -> không tính (tránh kéo loãng trung bình)
    const fmt = RevenueTracker.formatMoney;
    if (!cap.hits && cap.ignoredCount) {
      this.log('warn', `Doanh thu: không đọc được tin bán nào, nhưng có ${cap.ignoredCount} tin chứa số tiền bị bỏ qua (vd: "${cap.ignored[0]}"). Nếu đó là tin bán: autosell_spawn ignorechat off / autosell_spawn msg off`);
    } else if (!cap.hits) {
      this.log('warn', 'Doanh thu: vòng này không thấy tin báo tiền nào (hoặc server dùng định dạng khác — đặt autoSellSpawnMsgPattern trong config.json)');
    }
    const interval = this._sellSpawnIntervalMs();
    this._rev.record(this.cfg.id, cap.sum, { intervalMs: interval, hits: cap.hits });
    this._revPending.amount += cap.sum;
    this._revPending.cycles += 1;
    this.log('ok', `Doanh thu vòng này: ${fmt(cap.sum)} (${cap.hits} tin / ${cap.done} lồng)`);
    if (quiet) return cap;
    const gapMs = this.autoSellSpawnReportMin * 60000;
    if (gapMs && nowMs() - this._revLastReportAt < gapMs) return cap; // chưa tới lúc báo — số liệu vẫn được cộng dồn cho lần báo sau
    this._sendRevenueReport(cap);
    return cap;
  }
  getRevenueStats() { return this._rev.stats(this.cfg.id); }
  getRevenueText() {
    const s = this.getRevenueStats();
    if (!s) return 'Chưa có dữ liệu doanh thu';
    const fmt = RevenueTracker.formatMoney;
    const est = s.avgPerHour == null ? ' (cần ≥2 vòng liên tiếp để tính tốc độ)' : (s.observedMs < 3600000 ? ' (ước tính — mới đo ' + this._fmtDuration(s.observedMs) + ')' : '');
    return `1h qua: ${fmt(s.last1h)} | TB/giờ: ${s.avgPerHour == null ? '—' : fmt(s.avgPerHour)} | ~/ngày: ${s.perDayEst == null ? '—' : fmt(s.perDayEst)}${est} | hôm nay: ${fmt(s.today)} | 24h: ${fmt(s.last24h)} | tổng: ${fmt(s.total)} (${s.cycles} vòng)`;
  }
  _buildRevenueEmbed(cap, kind = 'spawn') {
    const macro = kind === 'macro';
    const fmt = RevenueTracker.formatMoney;
    const s = macro ? this.getMacroRevenueStats() : this.getRevenueStats();
    const id = this.cfg.id;
    const noRate = !s || s.avgPerHour == null;
    const est = s && !noRate && s.observedMs < 3600000;
    const estNote = noRate ? '\n_(cần ≥2 vòng bán liên tiếp để tính tốc độ — vòng đầu là hàng dồn nên không tính)_' : (est ? '\n_(ước tính — mới đo ' + this._fmtDuration(s.observedMs) + ')_' : '');
    const pend = macro ? this._macroRevPending : this._revPending;
    const fields = [];
    if (cap) fields.push({ name: macro ? '💰 Lần bán này' : '💰 Vòng này', value: macro
      ? `**+${fmt(cap.sum)}**\n${cap.viaBalance ? 'đo theo số dư tăng' : cap.hits + ' tin bán'} · macro "${cap.macro}"`
      : `**+${fmt(cap.sum)}**\n${cap.hits} tin bán / ${cap.done} lồng`, inline: true });
    if (pend.cycles > 1) fields.push({ name: '🧾 Từ báo cáo trước', value: `**+${fmt(pend.amount)}**\n${pend.cycles} vòng`, inline: true });
    if (s) {
      fields.push({ name: '⏱ Doanh thu / giờ', value: `**${noRate ? '—' : fmt(s.avgPerHour)}**\n1 giờ qua thực tế: ${fmt(s.last1h)}${estNote}`, inline: true });
      fields.push({ name: '📅 Doanh thu / ngày', value: `**${noRate ? '—' : '~' + fmt(s.perDayEst)}**${noRate ? '' : ' (ước tính)'}\nHôm nay: ${fmt(s.today)} · Hôm qua: ${fmt(s.yesterday)}\n24 giờ qua: ${fmt(s.last24h)}`, inline: true });
      const pad = (str, n) => String(str).padStart(n, ' ');
      const hours = s.hourly.slice(-6).map(h => `${h.label} ${pad(fmt(h.amount), 8)}`).join('\n');
      const days = s.daily.map(d => `${d.label} ${pad(fmt(d.amount), 8)}`).join('\n');
      fields.push({ name: '🕒 6 giờ gần nhất', value: '```\n' + hours + '\n```', inline: true });
      fields.push({ name: '🗓 7 ngày gần nhất', value: '```\n' + days + '\n```', inline: true });
      fields.push({ name: '📊 Tổng cộng', value: `${fmt(s.total)} trong ${s.cycles} vòng`, inline: false });
    }
    return {
      title: macro ? `💸 ${id}: báo cáo doanh thu Auto-sell (macro)` : `💸 ${id}: báo cáo doanh thu Auto-sell Spawn`,
      description: cap ? `${macro ? 'Lần bán vừa xong' : 'Vòng bán vừa xong'}: **+${fmt(cap.sum)}**` : 'Báo cáo tổng hợp doanh thu.',
      color: 0x22c55e,
      fields,
      footer: { text: id },
      timestamp: new Date().toISOString(),
    };
  }
  // Gửi qua webhook RIÊNG nếu có, không thì qua webhook chung (sự kiện "revenue")
  _sendRevenueReport(cap, kind = 'spawn') {
    const embed = this._buildRevenueEmbed(cap, kind);
    const rn = this._manager?.revenueNotifier;
    let via = null;
    if (rn?.enabled) { rn.send(null, embed); via = 'webhook doanh thu riêng'; }
    else if (this._manager?.notifier?.isEventOn('revenue')) { this._manager.notifier.send('revenue', embed); via = 'webhook chung'; }
    if (kind === 'macro') { this._macroRevLastReportAt = nowMs(); this._macroRevPending = { amount: 0, cycles: 0 }; }
    else { this._revLastReportAt = nowMs(); this._revPending = { amount: 0, cycles: 0 }; }
    if (via) this.log('sys', `Đã gửi báo cáo doanh thu (${via})`);
    else this.log('sys', 'Doanh thu đã ghi nhận — chưa cấu hình webhook nên không gửi Discord (webhook revenue set <url>)');
    return !!via;
  }
  sendRevenueReportNow() {
    if (!this.getRevenueStats()) return { ok: false, message: 'Chưa có dữ liệu doanh thu để báo cáo' };
    const sent = this._sendRevenueReport(null);
    return sent ? { ok: true } : { ok: false, message: 'Chưa cấu hình webhook (webhook revenue set <url> hoặc webhook set <url>)' };
  }
  resetRevenue() {
    this._rev.reset(this.cfg.id);
    this._revPending = { amount: 0, cycles: 0 };
    this.log('sys', 'Đã xoá toàn bộ dữ liệu doanh thu của bot này');
  }
  // Sau khi người dùng BẬT autosell / autosell_spawn bằng lệnh: hỏi 1 lần xem có muốn liên kết webhook Discord
  // để nhận báo cáo doanh thu không. Không trả lời gì / Enter = bỏ qua, bot vẫn chạy bình thường.
  _askRevenueWebhook() {
    try { this._manager?.askRevenueWebhook?.(this.cfg.id); } catch { }
  }
  // ===== Doanh thu AUTO-SELL MACRO (autosell <%đầy> <macro>) =====
  get _macroRevKey() { return `${this.cfg.id}#macro`; }
  _beginMacroSellCapture(macroName) {
    if (this._macroSellCap) this._finalizeMacroSellRevenue(false); // lần trước chưa chốt
    this._clearTimer('macroSellFinalize');
    const m0 = Number(this.state?.money);
    this._macroSellCap = { start: nowMs(), macro: macroName, ran: false, sum: 0, hits: 0, ignored: [], ignoredCount: 0, money0: Number.isFinite(m0) ? m0 : null };
    return this._macroSellCap;
  }
  // Macro chạy xong (ok=false: không chạy được / hỏng). Chờ thêm 5s cho tin "bán được" cuối kịp về rồi chốt.
  _onMacroSellDone(cap, ok) {
    if (this._macroSellCap !== cap) return;
    if (ok === false && !cap.hits) { this._macroSellCap = null; return; } // macro không chạy / hỏng trước khi bán -> không tính
    cap.ran = true;
    this._setTimer('macroSellFinalize', () => this._finalizeMacroSellRevenue(false), 5000);
  }
  _captureMacroSellRevenue(text, pos) {
    const cap = this._macroSellCap;
    if (!cap) return;
    const amount = this._extractSellAmount(text, this.autoSellMsgPattern);
    if (amount === null) return;
    const isPlayerChat = pos === 'chat';
    if ((this.autoSellIgnoreChat && isPlayerChat) || !this._sellMsgMatchesKeyword(text, this.autoSellMsgKeyword)) {
      cap.ignoredCount++;
      if (cap.ignored.length < 3) cap.ignored.push(`${isPlayerChat ? '[chat] ' : ''}${text.substring(0, 90)}`);
      return;
    }
    cap.sum += amount;
    cap.hits++;
    this.log('sys', `Doanh thu auto-sell: +${RevenueTracker.formatMoney(amount)} ← "${text.substring(0, 80)}"`);
  }
  // Chốt 1 lần bán: ghi vào tracker + gửi báo cáo (quiet = chỉ ghi, không gửi)
  _finalizeMacroSellRevenue(quiet = false) {
    const cap = this._macroSellCap;
    if (!cap) return null;
    this._macroSellCap = null;
    this._clearTimer('macroSellFinalize');
    if (!cap.ran && !cap.hits) return null;
    const fmt = RevenueTracker.formatMoney;
    let amount = cap.sum;
    if (!cap.hits) {
      // Không đọc được tin bán nào -> thử dùng số dư (bảng điểm) tăng lên trong lúc bán
      const m1 = Number(this.state?.money);
      const delta = Number.isFinite(m1) && cap.money0 > 0 ? m1 - cap.money0 : 0;
      if (delta > 0) {
        amount = delta;
        cap.viaBalance = true;
        this.log('warn', `Doanh thu auto-sell: không đọc được tin bán nào — tạm tính theo số dư tăng ${fmt(delta)} (có thể lẫn khoản thu khác). Muốn chính xác: autosell revenue keyword <chữ trong tin bán>`);
      } else {
        if (cap.ignoredCount) this.log('warn', `Doanh thu auto-sell: không tính được — có ${cap.ignoredCount} tin chứa số tiền bị bỏ qua (vd: "${cap.ignored[0]}"). Nếu đó là tin bán: autosell revenue ignorechat off, hoặc đặt từ khoá: autosell revenue keyword <chữ>`);
        else this.log('warn', 'Doanh thu auto-sell: lần này không thấy tin báo tiền nào (server dùng định dạng khác? đặt autoSellMsgPattern trong config.json)');
        return cap;
      }
    }
    cap.sum = amount;
    // intervalMs 6h: auto-sell macro chạy không đều (khi túi đầy) nên cho phép khoảng cách giữa 2 lần lên tới ~12h mà vẫn tính tốc độ/giờ
    this._rev.record(this._macroRevKey, amount, { intervalMs: 6 * 3600000, hits: cap.hits });
    this._macroRevPending.amount += amount;
    this._macroRevPending.cycles += 1;
    this.log('ok', `Doanh thu auto-sell lần này: ${fmt(amount)} (macro "${cap.macro}")`);
    if (quiet) return cap;
    const gapMs = this.autoSellReportMin * 60000;
    if (gapMs && nowMs() - this._macroRevLastReportAt < gapMs) return cap; // chưa tới lúc báo — số liệu vẫn cộng dồn cho lần báo sau
    this._sendRevenueReport(cap, 'macro');
    return cap;
  }
  getMacroRevenueStats() { return this._rev.stats(this._macroRevKey); }
  getMacroRevenueText() {
    const s = this.getMacroRevenueStats();
    if (!s) return 'Chưa có dữ liệu doanh thu auto-sell';
    const fmt = RevenueTracker.formatMoney;
    const est = s.avgPerHour == null ? ' (cần ≥2 lần bán để tính tốc độ)' : '';
    return `1h qua: ${fmt(s.last1h)} | TB/giờ: ${s.avgPerHour == null ? '—' : fmt(s.avgPerHour)} | ~/ngày: ${s.perDayEst == null ? '—' : fmt(s.perDayEst)}${est} | hôm nay: ${fmt(s.today)} | 24h: ${fmt(s.last24h)} | tổng: ${fmt(s.total)} (${s.cycles} lần)`;
  }
  sendMacroRevenueReportNow() {
    if (!this.getMacroRevenueStats()) return { ok: false, message: 'Chưa có dữ liệu doanh thu auto-sell để báo cáo' };
    const sent = this._sendRevenueReport(null, 'macro');
    return sent ? { ok: true } : { ok: false, message: 'Chưa cấu hình webhook (webhook revenue set <url> hoặc webhook set <url>)' };
  }
  resetMacroRevenue() {
    this._rev.reset(this._macroRevKey);
    this._macroRevPending = { amount: 0, cycles: 0 };
    this.log('sys', 'Đã xoá dữ liệu doanh thu auto-sell (macro) của bot này');
  }
  _persistMacroSellCfg() {
    const data = {
      autoSellMacro: this.autoSellMacro, autoSellThreshold: this.autoSellThreshold,
      autoSellRevenue: this.autoSellRevenue, autoSellMsgKeyword: this.autoSellMsgKeyword,
      autoSellMsgPattern: this.autoSellMsgPattern, autoSellIgnoreChat: this.autoSellIgnoreChat,
      autoSellReportMin: this.autoSellReportMin,
    };
    Object.assign(this.cfg, data);
    const mgr = this._manager;
    const list = mgr?._config?.bots;
    if (!list) return;
    const c = list.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) Object.assign(c, data);
    mgr.persistence?.markDirty();
  }
  // ===== Auto-sell Spawn =====
  _sellSpawnIntervalMs() {
    const raw = Math.round((this.autoSellSpawnSecond || 0) * 1000 + (this.autoSellSpawnMinute || 0) * 60000 + (this.autoSellSpawnHour || 0) * 3600000);
    if (!raw) return 300000; // cả 3 ô đều 0 -> mặc định 5 phút
    return Math.max(5000, raw); // tối thiểu 5 giây
  }
  _fmtDuration(ms) {
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    const out = [];
    if (h) out.push(`${h} giờ`);
    if (m) out.push(`${m} phút`);
    if (sec || !out.length) out.push(`${sec} giây`);
    return out.join(' ');
  }
  // "30s", "5m", "2h", "1h30m", "1h 30m 20s" -> { hour, minute, second } | null
  _parseDuration(text) {
    const src = String(text || '').toLowerCase();
    const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/g;
    const out = { hour: 0, minute: 0, second: 0 };
    let hit = false;
    for (const m of src.matchAll(re)) {
      hit = true;
      const k = m[2][0] === 'h' ? 'hour' : m[2][0] === 'm' ? 'minute' : 'second';
      out[k] += parseFloat(m[1]);
    }
    if (!hit) return null;
    if (/\d/.test(src.replace(re, ''))) return null; // còn số lẻ loi không có đơn vị -> sai cú pháp
    return out;
  }
  _persistSellSpawnState() {
    const data = {
      autoSellSpawnOn: this._sellSpawnOn,
      autoSellSpawnList: this.sellSpawnList,
      autoSellSpawnSlot: this.autoSellSpawnSlot,
      autoSellSpawnButton: this.autoSellSpawnButton,
      autoSellSpawnSecond: this.autoSellSpawnSecond,
      autoSellSpawnMinute: this.autoSellSpawnMinute,
      autoSellSpawnHour: this.autoSellSpawnHour,
      autoSellSpawnRange: this.autoSellSpawnRange,
      autoSellSpawnRevenue: this.autoSellSpawnRevenue,
      autoSellSpawnMsgKeyword: this.autoSellSpawnMsgKeyword,
      autoSellSpawnMsgPattern: this.autoSellSpawnMsgPattern,
      autoSellSpawnIgnoreChat: this.autoSellSpawnIgnoreChat,
      autoSellSpawnReportMin: this.autoSellSpawnReportMin,
    };
    Object.assign(this.cfg, data);
    const mgr = this._manager;
    const list = mgr?._config?.bots;
    if (!list) return;
    const c = list.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) Object.assign(c, data);
    mgr.persistence?.markDirty();
  }
  // Quét lồng trong autoSellSpawnRange block quanh bot, thêm vào danh sách (không xoá gì)
  _scanSellSpawns() {
    const mc = this.mc;
    const ids = this._spawnerBlockIds();
    if (!mc?.entity?.position || !ids.length) return 0;
    let found = [];
    try { found = mc.findBlocks({ matching: ids, maxDistance: this.autoSellSpawnRange, count: 128 }); }
    catch (e) { this.log('warn', 'Quét lồng lỗi: ' + e.message); }
    let added = 0;
    for (const p of found) {
      if (!this.sellSpawnList.some(q => q.x === p.x && q.y === p.y && q.z === p.z)) {
        this.sellSpawnList.push({ x: p.x, y: p.y, z: p.z });
        added++;
      }
    }
    if (added) this._persistSellSpawnState();
    return added;
  }
  _startSellSpawn(resume = false) {
    if (!this.isOnline) { this.log('warn', 'Auto-sell Spawn: bot offline — chưa bật được'); return false; }
    if (!resume) {
      const added = this._scanSellSpawns();
      if (added) this.log('ok', `Auto-sell Spawn: tự lưu ${added} lồng trong ${this.autoSellSpawnRange} block quanh bot`);
    }
    if (!this.sellSpawnList.length) {
      if (resume) { this.log('warn', 'Auto-sell Spawn: danh sách lồng trống — chưa chạy được (giữ trạng thái BẬT)'); return false; }
      this._sellSpawnOn = false;
      this._clearTimer('sellSpawn');
      this._persistSellSpawnState();
      this.log('warn', `Auto-sell Spawn: không có lồng nào — đứng sát lồng (≤${this.autoSellSpawnRange} block) rồi bật lại, hoặc: autosell_spawn add <x> <y> <z>`);
      return false;
    }
    this._sellSpawnOn = true;
    this._persistSellSpawnState();
    this._scheduleSellSpawn(resume ? 8000 : 3000);
    this.log('sys', `Auto-sell Spawn: BẬT — ${this.sellSpawnList.length} lồng, click ô ${this.autoSellSpawnSlot}, lặp mỗi ${this._fmtDuration(this._sellSpawnIntervalMs())}`);
    return true;
  }
  _stopSellSpawn() {
    this._sellSpawnOn = false;
    this._sellSpawnAbort = true;
    this._clearTimer('sellSpawn');
    this._persistSellSpawnState();
    this.log('sys', 'Auto-sell Spawn: TẮT');
  }
  _scheduleSellSpawn(ms) {
    if (!this._sellSpawnOn || !this.isOnline) return;
    this._setTimer('sellSpawn', () => this._sellSpawnTick(), Math.max(500, ms));
  }
  async _sellSpawnTick() {
    if (!this._sellSpawnOn || !this.isOnline) return;
    // đang bận việc khác (bảo vệ lồng / macro / vòng trước) -> hẹn lại vài giây sau
    if (this._spawnerBusy || this._sellSpawnBusy || this.macroEngine.running) { this._scheduleSellSpawn(5000); return; }
    const t0 = nowMs();
    try { await this._runSellSpawnCycle(); }
    catch (e) { this.log('err', 'Auto-sell Spawn lỗi: ' + e.message); }
    this._scheduleSellSpawn(this._sellSpawnIntervalMs() - (nowMs() - t0));
  }
  runSellSpawnNow() {
    if (!this.isOnline) { this.log('warn', 'Auto-sell Spawn: bot offline'); return false; }
    if (this._sellSpawnBusy) { this.log('warn', 'Auto-sell Spawn: đang chạy một vòng rồi'); return false; }
    if (this._spawnerBusy || this.macroEngine.running) { this.log('warn', 'Auto-sell Spawn: bot đang bận (bảo vệ lồng/macro) — thử lại sau'); return false; }
    this._runSellSpawnCycle().catch(e => this.log('err', 'Auto-sell Spawn lỗi: ' + e.message));
    return true;
  }
  _withTimeout(p, ms) {
    const pr = Promise.resolve(p);
    pr.catch(() => { }); // tránh unhandled rejection nếu promise lỗi sau khi đã hết giờ chờ
    return Promise.race([pr, sleep(ms)]);
  }
  _waitWindowOpen(mc, ms) {
    return new Promise(resolve => {
      let done = false, t = null;
      const finish = w => { if (done) return; done = true; clearTimeout(t); mc.removeListener('windowOpen', onOpen); resolve(w); };
      const onOpen = w => finish(w);
      t = setTimeout(() => finish(null), ms);
      mc.on('windowOpen', onOpen);
    });
  }
  async _runSellSpawnCycle() {
    const mc = this.mc;
    if (!this.isOnline || !mc?.entity?.position || this._sellSpawnBusy) return { done: 0, total: 0 };
    const list = this.sellSpawnList.slice();
    if (!list.length) { this.log('warn', 'Auto-sell Spawn: danh sách lồng trống'); return { done: 0, total: 0 }; }
    this._sellSpawnBusy = true;
    this._sellSpawnAbort = false;
    if (this.autoSellSpawnRevenue) this._beginSellCapture(list.length);
    const stop = () => this._sellSpawnAbort || !this.isOnline || this.mc !== mc;
    let wasSneak = false;
    try { wasSneak = !!mc.getControlState?.('sneak'); if (wasSneak) mc.setControlState('sneak', false); } catch { } // đang shift thì chuột phải không mở được GUI
    let done = 0;
    this.log('sys', `Auto-sell Spawn: bắt đầu vòng bán (${list.length} lồng)`);
    try {
      for (let i = 0; i < list.length; i++) {
        if (stop()) { this.log('warn', 'Auto-sell Spawn: bị ngắt giữa chừng (bảo vệ lồng/macro/tắt/mất kết nối)'); break; }
        let ok = false;
        try { ok = await this._sellOneSpawn(mc, list[i], `${i + 1}/${list.length}`, stop); }
        catch (e) { this.log('err', `Auto-sell Spawn [${i + 1}/${list.length}] lỗi: ${e.message}`); }
        if (ok) done++;
        if (i < list.length - 1 && !stop()) await sleep(jit(900, 300));
      }
    } finally {
      try { if (this.mc === mc && mc.currentWindow) mc.closeWindow(mc.currentWindow); } catch { }
      try { if (wasSneak && this.mc === mc) mc.setControlState('sneak', true); } catch { }
      this._sellSpawnBusy = false;
    }
    this.log(done === list.length ? 'ok' : 'warn', `Auto-sell Spawn: xong ${done}/${list.length} lồng${this._sellSpawnOn ? ` — vòng kế tiếp sau ~${this._fmtDuration(this._sellSpawnIntervalMs())}` : ''}`);
    if (this._sellCap) { this._sellCap.done = done; this._setTimer('sellRevFinalize', () => this._finalizeSellRevenue(false), 4000); } // chờ 4s cho tin "bán được" của lồng cuối kịp về
    return { done, total: list.length };
  }
  // 1 lồng: chuột phải mở GUI -> click slot -> đóng GUI. Trả về true nếu đã click được.
  async _sellOneSpawn(mc, p, tag, stop) {
    const block = mc.blockAt(this._vec(p));
    const at = `(${p.x},${p.y},${p.z})`;
    if (!block) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: chunk chưa tải — bỏ qua`); return false; }
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: không có block ở đây — bỏ qua`); return false; }
    const center = makeVec3(p.x + 0.5, p.y + 0.5, p.z + 0.5);
    const dist = mc.entity.position.offset(0, 1.62, 0).distanceTo(center);
    if (dist > 6) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: quá xa (${dist.toFixed(1)} block) — bot không tự di chuyển, bỏ qua`); return false; }
    if (mc.currentWindow) { try { mc.closeWindow(mc.currentWindow); } catch { } await sleep(300); }
    try { await mc.lookAt(center, true); } catch { }
    await sleep(jit(250, 80));
    if (stop()) return false;
    // đăng ký chờ GUI TRƯỚC khi click để không lỡ sự kiện windowOpen
    const winP = this._waitWindowOpen(mc, 6000);
    try { await this._withTimeout(mc.activateBlock(block), 2500); }
    catch (e) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: click chuột phải lỗi: ${e.message}`); }
    const win = await winP;
    if (!win) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: GUI không mở sau 6s`); return false; }
    try {
      await sleep(jit(650, 150)); // đợi server gửi đủ ô đồ
      const slot = this.autoSellSpawnSlot;
      const start = win.inventoryStart ?? Math.max(0, win.slots.length - 36);
      if (slot >= start) {
        this.log('warn', `Auto-sell Spawn [${tag}] ${at}: GUI chỉ có ${start} ô — slot ${slot} nằm ngoài GUI (là túi đồ của bot), KHÔNG click. Kiểm tra lại số slot`);
        return false;
      }
      let it = win.slots[slot];
      for (let k = 0; !it && k < 3; k++) { await sleep(500); it = win.slots[slot]; }
      if (!it) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: ô ${slot} trống — không click`); return false; }
      if (stop()) return false;
      const name = resolveText(it.customName || it.displayName || it.name || '').substring(0, 40);
      const title = resolveText(win.title || '').substring(0, 30);
      this.log('sys', `Auto-sell Spawn [${tag}] ${at}: GUI [${title}] — click ô ${slot} "${name}"`);
      try { await this._withTimeout(mc.clickWindow(slot, this.autoSellSpawnButton, 0), 3000); }
      catch (e) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: click ô ${slot} lỗi: ${e.message}`); }
      await sleep(jit(700, 200));
      return true;
    } finally {
      try { const cur = this.mc === mc ? mc.currentWindow : null; if (cur) mc.closeWindow(cur); } catch { }
      await sleep(jit(350, 100));
    }
  }
  // Dùng chung cho lệnh CLI + web. Trả về { ok, on, message }
  configureSellSpawn(o = {}) {
    if (o.slot !== undefined) {
      const n = parseInt(o.slot, 10);
      if (!Number.isInteger(n) || n < 0 || n > 200) return { ok: false, message: 'Slot không hợp lệ (0-200)' };
      this.autoSellSpawnSlot = n;
    }
    if (o.button !== undefined) this.autoSellSpawnButton = Number(o.button) === 1 ? 1 : 0;
    let ivChanged = false;
    for (const [k, f] of [['second', 'Second'], ['minute', 'Minute'], ['hour', 'Hour']]) {
      if (o[k] === undefined) continue;
      const v = Number(o[k]);
      if (!Number.isFinite(v) || v < 0) return { ok: false, message: `Giá trị ${k} không hợp lệ` };
      this['autoSellSpawn' + f] = v;
      ivChanged = true;
    }
    if (o.revenue !== undefined) this.autoSellSpawnRevenue = !!o.revenue;
    if (o.msgKeyword !== undefined) this.autoSellSpawnMsgKeyword = String(o.msgKeyword || '').trim();
    if (o.ignoreChat !== undefined) this.autoSellSpawnIgnoreChat = !!o.ignoreChat;
    if (o.reportMin !== undefined) {
      const v = Number(o.reportMin);
      if (!Number.isFinite(v) || v < 0) return { ok: false, message: 'Khoảng cách báo cáo không hợp lệ (phút, >= 0)' };
      this.autoSellSpawnReportMin = v;
    }
    if (o.range !== undefined) {
      const r = Number(o.range);
      if (!Number.isFinite(r) || r < 1 || r > 6) return { ok: false, message: 'Bán kính quét phải từ 1 đến 6 block' };
      this.autoSellSpawnRange = r;
    }
    this._persistSellSpawnState();
    let message = null;
    if (o.on === true) {
      if (!this._startSellSpawn()) return { ok: true, on: this._sellSpawnOn, message: 'Không bật được — bot offline hoặc chưa có lồng nào trong danh sách' };
    } else if (o.on === false) {
      this._stopSellSpawn();
    } else if (ivChanged && this._sellSpawnOn && !this._sellSpawnBusy) {
      this._scheduleSellSpawn(this._sellSpawnIntervalMs());
    }
    if (ivChanged && this._sellSpawnIntervalMs() === 5000 && (this.autoSellSpawnSecond + this.autoSellSpawnMinute * 60 + this.autoSellSpawnHour * 3600) < 5) message = 'Khoảng thời gian tối thiểu là 5 giây (đã tự nâng lên 5s)';
    return { ok: true, on: this._sellSpawnOn, message };
  }
  getSellSpawnInfo() {
    return {
      on: this._sellSpawnOn, busy: this._sellSpawnBusy, slot: this.autoSellSpawnSlot, button: this.autoSellSpawnButton,
      second: this.autoSellSpawnSecond, minute: this.autoSellSpawnMinute, hour: this.autoSellSpawnHour,
      intervalText: this._fmtDuration(this._sellSpawnIntervalMs()), range: this.autoSellSpawnRange, list: this.sellSpawnList,
      revenue: this.autoSellSpawnRevenue, msgKeyword: this.autoSellSpawnMsgKeyword, ignoreChat: this.autoSellSpawnIgnoreChat, reportMin: this.autoSellSpawnReportMin,
    };
  }
  // ===== Bảo vệ Lồng Spawn =====
  _spawnerBlockIds() {
    const by = this.mc?.registry?.blocksByName;
    if (!by) return [];
    return ['spawner', 'mob_spawner'].map(n => by[n]?.id).filter(id => id !== undefined);
  }
  _isSpawnerBlock(block) { return !!block && /spawner/.test(block.name || ''); }
  _vec(p) { return makeVec3(p.x, p.y, p.z); }
  _persistSpawnerState() {
    this.cfg.protectedSpawners = this.protectedSpawners;
    this.cfg.spawnerProtectOn = this._spawnerProtectOn;
    const mgr = this._manager;
    const list = mgr?._config?.bots;
    if (!list) return;
    const c = list.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) { c.protectedSpawners = this.protectedSpawners; c.spawnerProtectOn = this._spawnerProtectOn; }
    mgr.persistence?.markDirty();
  }
  // Lưu toạ độ mọi lồng trong spawnerSaveRange block quanh bot; dọn toạ độ
  // cũ mà chunk đã tải và không còn là lồng nữa.
  _autoSaveSpawners() {
    const mc = this.mc;
    const ids = this._spawnerBlockIds();
    let added = 0, removed = 0;
    if (mc?.entity?.position && ids.length) {
      let found = [];
      try { found = mc.findBlocks({ matching: ids, maxDistance: this.spawnerSaveRange, count: 128 }); } catch (e) { this.log('warn', 'Quét lồng lỗi: ' + e.message); }
      for (const p of found) {
        const x = p.x, y = p.y, z = p.z;
        if (!this.protectedSpawners.some(q => q.x === x && q.y === y && q.z === z)) {
          this.protectedSpawners.push({ x, y, z });
          added++;
        }
      }
      const before = this.protectedSpawners.length;
      const me = mc.entity.position;
      this.protectedSpawners = this.protectedSpawners.filter(p => {
        // Chỉ kết luận "lồng đã mất" khi bot đang đứng gần toạ độ đó — tránh xoá nhầm khi
        // bot đang ở khu spawn/thế giới khác (chunk đã tải nhưng không phải nơi đặt lồng).
        if (me.distanceTo(makeVec3(p.x + .5, p.y + .5, p.z + .5)) > 16) return true;
        const b = mc.blockAt(this._vec(p));
        return !b || this._isSpawnerBlock(b); // b=null: chunk chưa tải -> giữ lại
      });
      removed = before - this.protectedSpawners.length;
    }
    if (added || removed) this._persistSpawnerState();
    return { added, removed };
  }
  _startSpawnerProtect() {
    if (!this.isOnline) { this.log('warn', 'Bảo vệ Lồng Spawn: bot offline — chưa bật được'); return false; }
    const { added, removed } = this._autoSaveSpawners();
    if (added) this.log('ok', `Bảo vệ Lồng Spawn: tự lưu ${added} lồng trong ${this.spawnerSaveRange} block quanh bot`);
    if (removed) this.log('sys', `Bảo vệ Lồng Spawn: bỏ ${removed} toạ độ không còn là lồng`);
    if (!this.protectedSpawners.length) {
      this._spawnerProtectOn = false;
      this._clearTimer('spawnerProtect');
      this._persistSpawnerState();
      this.log('warn', `Bảo vệ Lồng Spawn: không thấy lồng nào trong ${this.spawnerSaveRange} block — đứng sát lồng rồi bật lại`);
      return false;
    }
    this._spawnerProtectOn = true;
    this._spawnerRetryAt = 0;
    this._spawnerNoPickUntil = 0;
    // 5 tick game = 5 × 50ms = 250ms
    this._setTimer('spawnerProtect', () => this._spawnerProtectTick(), 250, true);
    this._persistSpawnerState();
    this.log('sys', `Bảo vệ Lồng Spawn: BẬT (${this.protectedSpawners.length} lồng, quét người lạ trong ${this.spawnerProtectRange} block mỗi 5 tick)`);
    return true;
  }
  _stopSpawnerProtect() {
    this._spawnerProtectOn = false;
    this._clearTimer('spawnerProtect');
    this._persistSpawnerState();
    this.log('sys', 'Bảo vệ Lồng Spawn: TẮT');
  }
  // Người được tin: whitelist, owner, và các bot khác trong dàn
  _spawnerTrusted(uname) {
    const l = String(uname).toLowerCase();
    if (this.spawnerWhitelist.includes(l)) return true;
    if (String(this.cfg.ownerUsername || '').toLowerCase() === l) return true;
    return !!this._manager?.bots?.some(b => String(b.cfg?.username || '').toLowerCase() === l);
  }
  _nearbyStrangers() {
    const mc = this.mc;
    const me = mc.entity.position;
    const out = [];
    for (const uname in mc.players) {
      const e = mc.players[uname]?.entity;
      if (!uname || !e?.position || e === mc.entity) continue;
      if (this._spawnerTrusted(uname)) continue;
      const d = e.position.distanceTo(me);
      if (d <= this.spawnerProtectRange) out.push({ name: uname, dist: d });
    }
    return out.sort((a, b) => a.dist - b.dist);
  }
  // Các lồng đã lưu đang nằm sát bot: trong spawnerArmRange, chunk đã tải và block đúng là lồng
  _spawnersNearBot() {
    const mc = this.mc;
    const me = mc?.entity?.position;
    if (!me) return [];
    const out = [];
    for (const p of this.protectedSpawners) {
      if (me.distanceTo(makeVec3(p.x + .5, p.y + .5, p.z + .5)) > this.spawnerArmRange) continue;
      let b = null;
      try { b = mc.blockAt(this._vec(p)); } catch { }
      if (this._isSpawnerBlock(b)) out.push(p);
    }
    return out;
  }
  // true = được phép quét người lạ. Log đúng 1 lần mỗi khi trạng thái đổi (không spam).
  _spawnerArmed() {
    const now = nowMs();
    if (!this._spawnersNearBot().length) {
      if (this._spawnerZone !== 'out') this.log('sys', 'Bảo vệ Lồng Spawn: không có lồng bên cạnh bot (đang ở khu spawn/khu khác?) — tạm nghỉ, không cảnh báo');
      this._spawnerZone = 'out';
      this._spawnerArmedSince = 0;
      return false;
    }
    if (this._spawnerZone !== 'in') {
      this._spawnerZone = 'in';
      this._spawnerArmedSince = now;
      if (this.spawnerArmDelayMs > 0) this.log('sys', `Bảo vệ Lồng Spawn: đã ở cạnh lồng — bắt đầu canh sau ${(this.spawnerArmDelayMs / 1000).toFixed(1)}s`);
    }
    return now - this._spawnerArmedSince >= this.spawnerArmDelayMs;
  }
  _spawnerProtectTick() {
    if (!this.isOnline || !this.mc?.entity?.position) return;
    if (this._spawnerBusy || !this.protectedSpawners.length) return;
    if (nowMs() < this._spawnerRetryAt) return;
    if (!this._spawnerArmed()) return; // không có lồng cạnh bot -> không báo, không đập
    const strangers = this._nearbyStrangers();
    if (!strangers.length) return;
    // Bảo vệ lồng có ưu tiên cao hơn: ngắt vòng auto-sell spawn, tick 250ms sau sẽ xử lý
    if (this._sellSpawnBusy) { this._sellSpawnAbort = true; return; }
    this._spawnerBusy = true;
    this._onSpawnerThreat(strangers)
      .catch(e => this.log('err', 'Bảo vệ Lồng Spawn lỗi: ' + e.message))
      .finally(() => {
        this._spawnerBusy = false;
        try { this.mc?.setControlState('sneak', false); this.mc?.setControlState('forward', false); } catch { }
      });
  }
  // Gửi webhook có giới hạn tần suất theo từng loại cảnh báo
  _spawnerAlert(key, minMs, title, desc, color) {
    const now = nowMs();
    if (now - (this._spawnerAlertedAt.get(key) || 0) < minMs) return false;
    this._spawnerAlertedAt.set(key, now);
    this._notify('spawnerThreat', title, desc, color);
    return true;
  }
  _itemHasSilk(item) {
    try { if (Array.isArray(item.enchants) && item.enchants.some(e => /silk_touch/i.test(e?.name || ''))) return true; } catch { }
    try { return /silk_touch/i.test(`${safeJsonStringify(item.nbt, '')}${safeJsonStringify(item.components, '')}`); } catch { return false; }
  }
  // entries: [{ item, slot }] -> cúp tốt nhất (Silk Touch trước, rồi tới chất liệu)
  _rankPickaxes(entries) {
    const TIER = { netherite: 6, diamond: 5, iron: 4, stone: 3, golden: 2, wooden: 1 };
    let list = entries
      .filter(e => e.item && /_pickaxe$/.test(e.item.name || ''))
      .map(e => ({ ...e, silk: this._itemHasSilk(e.item), tier: TIER[e.item.name.replace('_pickaxe', '')] || 0 }));
    if (this.spawnerRequireSilk) list = list.filter(e => e.silk);
    list.sort((a, b) => (b.silk - a.silk) || (b.tier - a.tier));
    return list[0] || null;
  }
  _invPickaxe() {
    return this._rankPickaxes(this.mc.inventory.items().map(i => ({ item: i, slot: i.slot })))?.item || null;
  }
  // Ender chest: ưu tiên rương thật trong tầm với, không có thì gõ lệnh (mặc định /ec)
  async _openEnderChest() {
    const mc = this.mc;
    if (mc.currentWindow) { try { mc.closeWindow(mc.currentWindow); } catch { } await sleep(250); }
    const ecId = mc.registry?.blocksByName?.ender_chest?.id;
    if (ecId !== undefined) {
      const blk = mc.findBlock({ matching: ecId, maxDistance: 4.5 });
      if (blk) {
        try { const w = await mc.openContainer(blk); await sleep(450); return w; }
        catch (e) { this.log('warn', 'Mở ender chest (rương thật) lỗi: ' + e.message); }
      }
    }
    const cmd = String(this.enderChestCommand || '').trim();
    if (!cmd) return null;
    return new Promise(resolve => {
      let done = false;
      const finish = w => { if (done) return; done = true; clearTimeout(t); mc.removeListener('windowOpen', onOpen); resolve(w); };
      const onOpen = w => setTimeout(() => finish(w), 500); // chờ server gửi đủ ô đồ
      const t = setTimeout(() => finish(null), 6000);
      mc.on('windowOpen', onOpen);
      try { mc.chat(cmd.startsWith('/') ? cmd : `/${cmd}`); } catch { finish(null); }
    });
  }
  async _fetchPickaxeFromEnderChest() {
    const mc = this.mc;
    const win = await this._openEnderChest();
    if (!win) { this.log('warn', 'Không mở được ender chest để lấy cúp'); return null; }
    try {
      const start = win.inventoryStart ?? Math.max(0, win.slots.length - 36);
      const entries = [];
      for (let i = 0; i < start; i++) if (win.slots[i]) entries.push({ item: win.slots[i], slot: i });
      const best = this._rankPickaxes(entries);
      if (!best) { this.log('warn', `Ender chest không có cúp${this.spawnerRequireSilk ? ' Silk Touch' : ''}`); return null; }
      this.log('sys', `Ender chest: lấy ${best.item.name}${best.silk ? ' (Silk Touch)' : ''} ở ô ${best.slot}`);
      await mc.clickWindow(best.slot, 0, 1); // shift-click -> chuyển sang túi đồ
      await sleep(500);
    } finally {
      try { mc.closeWindow(win); } catch { }
    }
    for (let i = 0; i < 3; i++) { // server gửi lại túi đồ sau khi đóng rương
      await sleep(600);
      const got = this._invPickaxe();
      if (got) return got;
    }
    this.log('warn', 'Không thấy cúp trong túi đồ sau khi lấy từ ender chest');
    return null;
  }
  _isSpawnerItem(item) {
    if (!item) return false;
    if (String(item.name || '').toLowerCase().includes('spawn')) return true; // spawner, *_spawn_egg
    let lore = '';
    try { lore = (item.customLore || []).map(l => resolveText(l)).join(' '); } catch { }
    const txt = normalizeSmallCaps(`${resolveText(item.customName || '')} ${item.displayName || ''} ${lore}`)
      .normalize('NFC').toLowerCase();
    return txt.includes('lồng') || txt.includes('spawn');
  }
  async _stashSpawnerItems() {
    const mc = this.mc;
    const has = () => mc.inventory.items().filter(i => this._isSpawnerItem(i));
    const before = has();
    if (!before.length) return { found: 0, left: 0, failed: false };
    const win = await this._openEnderChest();
    if (!win) return { found: before.length, left: before.length, failed: true };
    try {
      const start = win.inventoryStart ?? Math.max(0, win.slots.length - 36);
      for (let i = start; i < win.slots.length; i++) {
        const it = win.slots[i];
        if (!it || !this._isSpawnerItem(it)) continue;
        await mc.clickWindow(i, 0, 1); // shift-click -> vào ender chest
        await sleep(250);
      }
    } finally {
      try { mc.closeWindow(win); } catch { }
    }
    await sleep(900);
    const left = has().length;
    return { found: before.length, left, failed: false };
  }
  // Nhặt item rơi quanh chỗ vừa đào (nếu server không tự cho vào túi)
  async _collectDrops(points) {
    const mc = this.mc;
    await sleep(700);
    for (let round = 0; round < 8; round++) {
      if (!this.isOnline || !this._spawnerProtectOn) return;
      const me = mc.entity.position;
      const drops = Object.values(mc.entities || {}).filter(e =>
        (e.name === 'item' || e.objectType === 'Item') && e.position && e.isValid !== false &&
        Math.abs(e.position.y - me.y) <= 1.2 && e.position.distanceTo(me) <= 7 &&
        points.some(p => e.position.distanceTo(makeVec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= 3));
      if (!drops.length) return;
      drops.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
      const target = drops[0];
      const t0 = Date.now();
      mc.setControlState('sneak', false);
      mc.setControlState('forward', true);
      try {
        while (Date.now() - t0 < 2500 && target.isValid !== false && target.position.distanceTo(mc.entity.position) > 0.8) {
          await mc.lookAt(target.position, true);
          await sleep(100);
        }
      } finally { mc.setControlState('forward', false); }
      await sleep(250);
    }
  }
  async _breakSpawners(pick, targets) {
    const mc = this.mc;
    const broken = [];
    await mc.equip(pick, 'hand');
    mc.setControlState('sneak', true); // giữ shift: plugin gộp lồng sẽ cho đào cả stack trong 1 lần
    await sleep(200);
    try {
      for (const p of targets) {
        let outOfReach = false;
        for (let i = 0; i < 12; i++) { // stack còn dư thì đập tiếp
          if (!this.isOnline) throw new Error('bot offline');
          if (!this._spawnerProtectOn) throw new Error('đã tắt bảo vệ giữa chừng');
          const block = mc.blockAt(this._vec(p));
          if (!this._isSpawnerBlock(block)) break;
          if (!mc.heldItem || !/_pickaxe$/.test(mc.heldItem.name || '')) { // cúp hỏng giữa chừng
            const alt = this._invPickaxe();
            if (!alt) throw new Error('cúp đã hỏng, không còn cúp khác');
            await mc.equip(alt, 'hand');
          }
          if (!mc.canDigBlock(block)) { outOfReach = true; break; }
          try { mc.stopDigging(); } catch { }
          try { await mc.dig(block, true); }
          catch (e) { this.log('warn', `Đào lỗi (${p.x},${p.y},${p.z}): ${e.message}`); await sleep(300); }
        }
        const after = mc.blockAt(this._vec(p));
        if (after && !this._isSpawnerBlock(after)) {
          broken.push(p);
          this.protectedSpawners = this.protectedSpawners.filter(q => !(q.x === p.x && q.y === p.y && q.z === p.z));
          this.log('ok', `Đã đập lồng tại (${p.x},${p.y},${p.z})`);
        } else if (outOfReach) {
          this.log('warn', `Lồng (${p.x},${p.y},${p.z}) ngoài tầm với — bot không tự di chuyển`);
        }
      }
    } finally {
      try { mc.setControlState('sneak', false); } catch { }
      this._persistSpawnerState();
    }
    return broken;
  }
  async _onSpawnerThreat(strangers) {
    const names = strangers.map(s => `${s.name} (${s.dist.toFixed(1)}m)`).join(', ');
    const id = this.cfg.id;
    if (this._spawnerAlert('threat', 15000, `⚠️ ${id}: người lạ gần lồng`, `Người lạ: ${names}\nĐang bảo vệ ${this.protectedSpawners.length} lồng.`, 0xf59e0b)) {
      this.log('warn', `⚠️ Bảo vệ Lồng Spawn: người lạ ${names}`);
    }
    if (!this.spawnerAutoMine) {
      if (this.spawnerAutoDisconnect) { this.log('warn', 'Bảo vệ Lồng Spawn: auto-disconnect'); this.shutdown(); }
      return;
    }
    const targets = this.protectedSpawners
      .filter(p => this._isSpawnerBlock(this.mc.blockAt(this._vec(p))))
      .sort((a, b) => {
        const me = this.mc.entity.position;
        return me.distanceTo(makeVec3(a.x + .5, a.y + .5, a.z + .5)) - me.distanceTo(makeVec3(b.x + .5, b.y + .5, b.z + .5));
      });
    if (!targets.length) { this._autoSaveSpawners(); this._spawnerRetryAt = nowMs() + 3000; return; }
    // routine cần toàn quyền điều khiển GUI/chuột
    if (this.macroEngine.running) { this.log('warn', 'Bảo vệ Lồng Spawn: dừng macro đang chạy để xử lý lồng'); this.macroEngine.stop(); await sleep(400); }
    // 1) cúp trong túi đồ; 2) không có thì lấy ở ender chest (kiểm tra lại mỗi 30s)
    let pick = this._invPickaxe();
    if (!pick && nowMs() >= this._spawnerNoPickUntil) {
      this.log('sys', 'Bảo vệ Lồng Spawn: túi đồ không có cúp — mở ender chest tìm');
      pick = await this._fetchPickaxeFromEnderChest();
      if (!pick) this._spawnerNoPickUntil = nowMs() + 30000;
    }
    if (!pick) {
      // 3) không có cúp ở đâu -> báo webhook liên tục (mỗi spawnerAlertIntervalMs), bot ở lại để tiếp tục báo
      this._spawnerAlert('nopick', 0, `🚨 ${id}: KHÔNG CÓ CÚP${this.spawnerRequireSilk ? ' SILK TOUCH' : ''} — không đào được lồng`,
        `Người lạ: ${names}\n${targets.length} lồng đang gặp nguy hiểm, vd (${targets[0].x}, ${targets[0].y}, ${targets[0].z}).\nCả túi đồ lẫn ender chest đều không có cúp — hãy vào xử lý gấp!`, 0xef4444);
      this.log('warn', '🚨 Bảo vệ Lồng Spawn: không có cúp ở túi đồ lẫn ender chest — đang báo webhook liên tục');
      this._spawnerRetryAt = nowMs() + this.spawnerAlertIntervalMs;
      return;
    }
    this.log('sys', `Bảo vệ Lồng Spawn: dùng ${pick.name} đập ${targets.length} lồng (giữ shift)`);
    const broken = await this._breakSpawners(pick, targets);
    if (broken.length) await this._collectDrops(broken);
    const stash = await this._stashSpawnerItems();
    const stashed = stash.found - stash.left;
    const remaining = this.protectedSpawners.length;
    const lines = [`Người lạ: ${names}`, `Đã đập ${broken.length}/${targets.length} lồng.`];
    if (stash.found) lines.push(stash.failed ? '⚠️ Không mở được ender chest — item lồng vẫn nằm trong túi.' : `Đã cất ${stashed}/${stash.found} stack item lồng/spawn vào ender chest${stash.left ? ` (còn ${stash.left} trong túi — ender chest đầy?)` : ''}.`);
    else if (broken.length) lines.push('Không thấy item lồng trong túi (rơi dưới đất/server không trả item?).');
    if (remaining) lines.push(`⚠️ Còn ${remaining} lồng chưa đập được (ngoài tầm với).`);
    const ok = broken.length > 0 && !stash.failed && !stash.left && !remaining;
    this._notify('spawnerThreat', `${ok ? '✅' : '⚠️'} ${id}: xử lý bảo vệ lồng`, lines.join('\n'), ok ? 0x22c55e : 0xf59e0b);
    this.log(ok ? 'ok' : 'warn', 'Bảo vệ Lồng Spawn: ' + lines.join(' | '));
    if (!this.protectedSpawners.length) this._stopSpawnerProtect();
    else this._spawnerRetryAt = nowMs() + 4000;
    if (this.spawnerAutoDisconnect && broken.length) {
      this.log('warn', 'Bảo vệ Lồng Spawn: auto-disconnect — ngắt kết nối để bảo toàn tài khoản/đồ đạc');
      this.shutdown();
    }
  }
  // ===== Xoay Proxy Tự Động =====
  _startProxyRotate() {
    if (!this.cfg.useProxy) { this.log('warn', 'Xoay proxy cần bật useProxy trong config trước'); return; }
    this.proxyAutoRotate = true;
    this._scheduleProxyRotate();
    this.log('sys', `Xoay proxy tự động: BẬT (mỗi ${Math.round(this.proxyRotateMinMs / 60000)}-${Math.round(this.proxyRotateMaxMs / 60000)} phút, ngẫu nhiên)`);
  }
  _stopProxyRotate() {
    this.proxyAutoRotate = false;
    this._clearTimer('proxyRotate');
    this.log('sys', 'Xoay proxy tự động: TẮT');
  }
  _scheduleProxyRotate() {
    const delay = rand(this.proxyRotateMinMs, this.proxyRotateMaxMs);
    this._setTimer('proxyRotate', () => this._doProxyRotate(), delay);
  }
  _doProxyRotate() {
    if (!this.proxyAutoRotate) return;
    if (!this.isOnline) { this._scheduleProxyRotate(); return; } // bỏ lượt này, hẹn vòng sau
    const pm = this.proxyManager;
    const current = this.proxy;
    const live = pm._getLiveProxies();
    const others = live.filter(p => !current || p.id !== current.id);
    const pool = others.length ? others : live;
    if (!pool.length) {
      this.log('warn', 'Xoay proxy: không có proxy live nào khác để đổi — bỏ qua vòng này');
      this._scheduleProxyRotate();
      return;
    }
    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.log('sys', `Xoay proxy: ${current ? current.type + '://' + current.host + ':' + current.port : '(trực tiếp)'} → ${pick.type}://${pick.host}:${pick.port}`);
    pm.assignBot(this.cfg.id, pick.id);
    this.proxy = null; // để start() lấy lại proxy theo assignment mới thay vì tái dùng cái cũ
    this.forceReconnect();
    this._scheduleProxyRotate();
  }
  _startMenuIfPending() {
    if (!this.isOnline || this._menuSuccess) return;
    if (!this.cfg.autoMenu || !this.cfg.menuCommand) return;
    if (!this._loginCmdDone) return;
    this.log('sys', 'Login hoàn tất — bắt đầu menu retry...');
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._scheduleMenuRetry();
  }
  _scheduleMenuRetry() {
    const MAX_MENU_RETRIES = 100;
    const BASE_DELAY = 8000;
    const retry = () => {
      if (!this.isOnline || this._menuSuccess || this._disabled) return;
      if (this._menuRetryCount >= MAX_MENU_RETRIES) {
        this.log('warn', `Đã thử menu ${MAX_MENU_RETRIES} lần — dừng`);
        return;
      }
      this._menuRetryCount++;
      const delay = this._menuRetryCount <= 3 ? BASE_DELAY : jit(BASE_DELAY * 2, 3000);
      this.log('sys', `Gửi menu lần ${this._menuRetryCount}: ${this.cfg.menuCommand}`);
      try {
        this.mc.chat(this.cfg.menuCommand);
      } catch (e) {
        this.log('err', 'Lỗi gửi menu: ' + e.message);
      }
      if (!this._menuSuccess) {
        this._setTimer('menuRetry', retry, delay);
      }
    };
    this._setTimer('menuRetry', retry, rand(5000, 8000));
  }
  // Đọc toàn bộ bảng điểm (scoreboard sidebar) hiện tại của server — dùng để
  // xem Money/Shards/... hiển thị bên phải màn hình, không chỉ 1 số đơn lẻ.
  readBoard() {
    const mc = this.mc;
    if (!mc?.scoreboards) return null;
    try {
      // đa số server chỉ bật 1 sidebar tại 1 thời điểm — lấy objective có
      // nhiều dòng nhất để tránh dính các scoreboard ẩn/không hiển thị
      let best = null;
      for (const name in mc.scoreboards) {
        const sb = mc.scoreboards[name];
        const count = sb?.itemsMap ? Object.keys(sb.itemsMap).length : 0;
        if (count > 0 && (!best || count > best.count)) best = { sb, count };
      }
      if (!best) return null;
      const sb = best.sb;
      const lines = [];
      for (const entry in sb.itemsMap) {
        const item = sb.itemsMap[entry];
        let text = entry;
        if (mc.teamMap) {
          const team = Object.values(mc.teamMap).find(t => t.members?.includes(entry));
          if (team) text = resolveText(team.prefix) + entry + resolveText(team.suffix);
        }
        if (item?.displayName) {
          const dn = resolveText(item.displayName);
          if (dn) text = dn;
        }
        lines.push({ text: text.trim(), score: item?.value ?? 0 });
      }
      lines.sort((a, b) => b.score - a.score);
      return { title: resolveText(sb.name || sb.title || sb.displayName || ''), lines };
    } catch (e) {
      this.log('err', 'Lỗi đọc board: ' + e.message);
      return null;
    }
  }
  // Tìm dòng khớp từ khóa trong board rồi lấy số ra khỏi dòng đó
  // (nhiều server viết số ngay trong displayName thay vì dùng score thật)
  _extractBoardStat(board, keywords) {
    if (!board?.lines) return null;
    const re = new RegExp(keywords.join('|'), 'i');
    for (const line of board.lines) {
      if (!re.test(line.text)) continue;
      const m = line.text.match(/(\d[\d,.]*)\s*(k|K|M)?/);
      if (m) {
        let n = parseFloat(m[1].replace(/[,.]/g, ''));
        if (!isNaN(n)) {
          if (m[2] === 'k' || m[2] === 'K') n *= 1e3;
          if (m[2] === 'M') n *= 1e6;
          return Math.round(n);
        }
      }
      if (line.score) return line.score;
    }
    return null;
  }
  // Parse "1500", "1.5k", "2M" ... thành số nguyên — dùng cho lệnh "goal"
  _parseAmount(str) {
    const m = String(str || '').trim().match(/^(\d[\d,.]*)\s*(k|K|M)?$/);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(n)) return null;
    if (m[2] === 'k' || m[2] === 'K') n *= 1e3;
    if (m[2] === 'M') n *= 1e6;
    return Math.round(n);
  }
  readShard() {
    const mc = this.mc;
    if (!mc?.scoreboards) return null;
    try {
      for (const name in mc.scoreboards) {
        const sb = mc.scoreboards[name];
        if (!sb?.itemsMap) continue;
        for (const entry in sb.itemsMap) {
          let parts = [entry];
          if (mc.teamMap) {
            const team = Object.values(mc.teamMap).find(t => t.members?.includes(entry));
            if (team) parts = [resolveText(team.prefix), entry, resolveText(team.suffix)];
          }
          if (sb.itemsMap[entry]?.displayName) {
            parts.push(resolveText(sb.itemsMap[entry].displayName));
          }
          const n = parseShardNum(parts.join(' '));
          if (n !== null) {
            this.log('shard', 'Scoreboard → ' + n.toLocaleString());
            return n;
          }
        }
      }
    } catch (e) {
      this.log('err', 'Lỗi scoreboard: ' + e.message);
    }
    return null;
  }
  tryChatShard(raw) {
    try {
      const text = typeof raw === 'string' ? raw : resolveText(raw);
      const n = parseShardNum(text);
      if (n !== null) this._updateShard(n);
    } catch { }
  }
  afkJump() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this.state.afk = 'jump';
    this.state.intendedAfk = 'jump';
    const mc = this.mc;
    const tick = () => {
      if (!this.isOnline || this.state.afk !== 'jump') return;
      try {
        mc.setControlState('jump', true);
        this._setTimer('afkJumpOff', () => {
          try { if (this.isOnline) mc.setControlState('jump', false); } catch { }
        }, rand(100, 450));
        if (Math.random() < 0.30) {
          const yaw = (mc.entity?.yaw || 0) + (Math.random() - 0.5) * 1.0;
          const pitch = (mc.entity?.pitch || 0) + (Math.random() - 0.5) * 0.4;
          mc.look(yaw, clamp(pitch, -1.4, 1.4), true);
        }
        if (Math.random() < 0.06) mc.swingArm();
        if (Math.random() < 0.03) {
          mc.setControlState('sneak', true);
          this._setTimer('afkSneak', () => {
            try { if (this.isOnline) mc.setControlState('sneak', false); } catch { }
          }, rand(300, 900));
        }
        if (Math.random() < 0.02 && mc._client) {
          try { mc._client.write('tab_complete', { text: '/', assumeCommand: false }); } catch { }
        }
        if (Math.random() < 0.03) {
          try { mc.setQuickBarSlot(rand(0, 8)); } catch { }
        }
      } catch (e) {
        this.log('err', 'AFK jump lỗi: ' + e.message);
      }
      this._setTimer('afk', tick, jit(4800, 2000));
    };
    this._setTimer('afk', tick, jit(700, 200));
    this.log('afk', 'Jump AFK bật');
    this.emit('afk', { id: this.cfg.id, mode: 'jump' });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('afk', { id: this.cfg.id, mode: 'jump' });
    }
  }
  afkWalk() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this.state.afk = 'walk';
    this.state.intendedAfk = 'walk';
    const mc = this.mc;
    let yaw = mc.entity?.yaw || 0;
    let dir = 1;
    let step = 0;
    let lastPos = null;
    let stuckTicks = 0;
    const tick = () => {
      if (!this.isOnline || this.state.afk !== 'walk') return;
      try {
        if (Math.random() < 0.06) dir = -dir;
        yaw += rand(2, 10) * 0.09 * dir;
        mc.look(yaw, (Math.random() - 0.5) * 0.25, true);
        if (++step > rand(8, 20)) {
          step = 0;
          const keys = ['forward', 'back', 'left', 'right'];
          const k = keys[rand(0, 3)];
          mc.setControlState(k, true);
          this._setTimer('wafkKey', () => {
            try { if (this.isOnline) mc.setControlState(k, false); } catch { }
          }, rand(200, 950));
        }
        if (Math.random() < 0.04) {
          mc.setControlState('jump', true);
          this._setTimer('wafkJump', () => {
            try { if (this.isOnline) mc.setControlState('jump', false); } catch { }
          }, rand(100, 300));
        }
        if (Math.random() < 0.05) mc.swingArm();
        if (Math.random() < 0.02 && mc._client) {
          try { mc._client.write('tab_complete', { text: '/', assumeCommand: false }); } catch { }
        }
        if (Math.random() < 0.03) {
          try { mc.setQuickBarSlot(rand(0, 8)); } catch { }
        }
        const currPos = mc.entity?.position;
        if (lastPos && currPos) {
          const dist = Math.sqrt(
            Math.pow(currPos.x - lastPos.x, 2) +
            Math.pow(currPos.y - lastPos.y, 2) +
            Math.pow(currPos.z - lastPos.z, 2)
          );
          if (dist < 0.1) {
            stuckTicks++;
            if (stuckTicks > 4) { dir = -dir; yaw += Math.PI; stuckTicks = 0; }
          } else {
            stuckTicks = 0;
          }
        }
        if (currPos) lastPos = { x: currPos.x, y: currPos.y, z: currPos.z };
      } catch (e) {
        this.log('err', 'AFK walk lỗi: ' + e.message);
      }
      this._setTimer('wafk', tick, jit(480, 150));
    };
    this._setTimer('wafk', tick, jit(400, 100));
    this.log('afk', 'Walk AFK bật');
    this.emit('afk', { id: this.cfg.id, mode: 'walk' });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('afk', { id: this.cfg.id, mode: 'walk' });
    }
  }
  afkStop() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this._clearTimer('afkJumpOff');
    this._clearTimer('afkSneak');
    this._clearTimer('wafkKey');
    this._clearTimer('wafkJump');
    this._clearTimer('resumeAfk');
    try {
      if (this.mc?.entity) {
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) {
          this.mc.setControlState(k, false);
        }
      }
    } catch { }
    this.state.afk = null;
    this.state.intendedAfk = null;
    this.log('sys', 'AFK đã dừng');
    this.emit('afk', { id: this.cfg.id, mode: null });
    if (this.socketRooms?.io) {
      this.socketRooms.io.emit('afk', { id: this.cfg.id, mode: null });
    }
  }
  static FOODS = [
    'golden_apple', 'enchanted_golden_apple', 'cooked_beef', 'cooked_porkchop',
    'cooked_mutton', 'cooked_chicken', 'cooked_rabbit', 'cooked_salmon',
    'cooked_cod', 'steak', 'porkchop', 'mutton', 'beef', 'chicken',
    'rabbit', 'salmon', 'cod', 'bread', 'apple', 'mushroom_stew',
    'beetroot_soup', 'rabbit_stew', 'suspicious_stew', 'carrot',
    'baked_potato', 'potato', 'pumpkin_pie', 'cookie', 'melon_slice',
    'dried_kelp', 'sweet_berries', 'glow_berries', 'chorus_fruit',
    'tropical_fish', 'honey_bottle',
  ];
  async _eatFood() {
    if (this._isEating || !this.mc?.entity) return;
    const mc = this.mc;
    try {
      const items = mc.inventory.items();
      if (!items.length) return;
      let foodItem = null;
      for (const name of BotSession.FOODS) {
        foodItem = items.find(i => i.name === name);
        if (foodItem) break;
      }
      if (!foodItem) {
        this.log('warn', 'Không tìm thấy thức ăn trong túi!');
        return;
      }
      this._isEating = true;
      await mc.equip(foodItem, 'hand');
      await mc.consume();
      this.log('ok', `Đã ăn: ${(foodItem.name || '?').replace(/_/g, ' ')}`);
    } catch (e) {
      this.log('err', 'Lỗi khi ăn: ' + (e?.message || String(e)));
    } finally {
      this._isEating = false;
    }
  }
  hardReset() {
    this.log('sys', 'Hard reset initiated...');
    this.cancelReconnect();
    this._cleanupOnDisconnect();
    this._onConnectComplete();
    this._destroyMc();
    this.state.reconnects = 0;
    this._fastKicks = 0;
    this._menuRetryCount = 0;
    this._menuSuccess = false;
    this._connectCompleted = false;
    this._disabled = false;
    this._isEating = false;
    this._lastReconnectTime = 0;
    this._reconnectTimestamps = [];
    this._healthProbed = false;
    this._consecutiveProxyFails = 0;
    this._proxyDisabledByFallback = false;
    this._setState(CS.DISCONNECTED);
    this.log('sys', 'Hard reset — khởi động lại sau 1.5s...');
    this._setTimer('hard_reset_start', () => {
      this.start();
    }, 1500);
  }
  shutdown() {
    this._disabled = true;
    this._setState(CS.STOPPING);
    this._cleanupOnDisconnect();
    this._onConnectComplete();
    try { this.afkStop(); } catch { }
    this._destroyMc();
    this._setState(CS.DISCONNECTED);
    this.log('sys', 'Bot đã tắt');
  }
  cmd(input) {
    const trimmed = String(input).trim();
    const parts = trimmed.split(/\s+/);
    const key = parts[0].toLowerCase();
    if (this.cmdRegistry._customCommands.has(key)) {
      if (!this.isOnline) {
        this.log('warn', 'Bot offline — không gửi được chat');
        return;
      }
      try {
        const c = this.cmdRegistry._customCommands.get(key);
        this.mc.chat(c.startsWith('/') ? c : `/${c}`);
        this.log('sys', `Custom cmd "${key}" → ${c}`);
      } catch (e) {
        this.log('err', 'Lỗi custom cmd: ' + e.message);
      }
      return;
    }
    if (!this.cmdRegistry.run(trimmed)) {
      if (!this.isOnline) {
        this.log('warn', 'Bot offline — không gửi được chat');
        return;
      }
      try {
        this.mc.chat(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
      } catch (e) {
        this.log('err', 'Lỗi gửi chat: ' + e.message);
      }
    }
  }
  _registerCommands() {
    const r = this.cmdRegistry;
    // help chia theo phân khu: help | help <phân khu> | help all | help <lệnh>   (alias: h)
    const helpFn = (args) => {
      const { lines } = HelpCatalog.buildHelp({
        scope: 'bot', query: args.join(' '), registry: r.list(), customs: r.getCustomCmds(),
      });
      for (const l of lines) {
        if (l.t === 'title') this.log('sys', `— ${l.text} —`);
        else if (l.t === 'menu') this.log('sys', `help ${l.key.padEnd(8)} ${l.text}`);
        else if (l.t === 'head') this.log('sys', `» ${l.text}`);
        else if (l.t === 'cmd') this.log('sys', `${l.usage}  —  ${l.desc}`);
        else if (l.t === 'warn') this.log('warn', l.text);
        else if (l.t === 'note') this.log('sys', l.text);
      }
    };
    r.register('help', 'Trợ giúp theo phân khu: help | help <phân khu> | help all | help <lệnh>', helpFn);
    r.register('h', 'Như help', helpFn);
    r.register('shard', 'Bật/Tắt Auto Shard', () => {
      if (!this.requireOnline('shard')) return;
      this.state.autoShard = !this.state.autoShard;
      this.log('sys', `Tự động đọc Shard: ${this.state.autoShard ? 'BẬT' : 'TẮT'}`);
      if (this.state.autoShard) this._startAutoShard();
      else this._clearTimer('autoShardLoop');
    });
    r.register('stats', 'Bật/Tắt Auto Stats', () => {
      if (!this.requireOnline('stats')) return;
      this.state.autoStats = !this.state.autoStats;
      this.log('sys', `Tự động stats: ${this.state.autoStats ? 'BẬT' : 'TẮT'}`);
      if (this.state.autoStats) this._startAutoStats();
      else this._clearTimer('autoStatsLoop');
    });
    r.register('tshard', 'Gửi /warp afk (Treo Shard)', () => {
      if (!this.requireOnline('tshard')) return;
      try { this.mc.chat('/warp afk'); this.log('sys', 'Đã gửi /warp afk'); }
      catch (e) { this.log('err', e.message); }
    });
    r.register('afk', 'Bật/Tắt AFK jump', () => {
      if (!this.requireOnline('afk')) return;
      if (this.state.afk === 'jump') this.afkStop();
      else this.afkJump();
    });
    r.register('wafk', 'Bật/Tắt AFK walk', () => {
      if (!this.requireOnline('wafk')) return;
      if (this.state.afk === 'walk') this.afkStop();
      else this.afkWalk();
    });
    r.register('stop', 'Dừng AFK', () => this.afkStop());
    r.register('autoeat', 'Bật/Tắt Tự động ăn', () => {
      if (!this.requireOnline('autoeat')) return;
      this.state.autoEat = !this.state.autoEat;
      this.log('sys', `Tự động ăn: ${this.state.autoEat ? 'BẬT' : 'TẮT'} (ngưỡng: ${this.settings.eatThreshold || 15})`);
    });
    r.register('tpa', 'TPA tới owner (tự click đồng ý)', () => {
      if (!this.requireOnline('tpa')) return;
      const TPA_CONFIRM_SLOT = 16;  
      const TPA_GUI_TIMEOUT = 10000; 
      try {
        this.mc.chat(`/tpa ${this.cfg.ownerUsername}`);
        this.log('sys', `TPA → ${this.cfg.ownerUsername} — chờ GUI xác nhận...`);
      } catch (e) { this.log('err', e.message); return; }
      let tpaGuiTimer = null;
      const onTpaWindow = (win) => {
        if (tpaGuiTimer) { clearTimeout(tpaGuiTimer); tpaGuiTimer = null; }
        this.mc.removeListener('windowOpen', onTpaWindow);
        this._setTimer('tpaConfirm', () => {
          if (!this.isOnline) return;
          try {
            if (!win.slots || win.slots.length <= TPA_CONFIRM_SLOT) {
              this.log('warn', `GUI TPA không đủ slot (có ${win.slots?.length ?? 0}, cần >${TPA_CONFIRM_SLOT})`);
              try { this.mc.closeWindow(win); } catch { }
              return;
            }
            const sl = win.slots[TPA_CONFIRM_SLOT];
            const slotName = sl ? resolveText(sl.customName || sl.displayName || sl.name || '') : '(trống)';
            this.mc.clickWindow(TPA_CONFIRM_SLOT, 0, 0);
            this.log('ok', `Đã click slot ${TPA_CONFIRM_SLOT + 1} (ô thứ ${TPA_CONFIRM_SLOT + 1}): "${slotName}" — Đồng ý TPA`);
          } catch (e) { this.log('err', 'Lỗi click TPA GUI: ' + e.message); }
        }, jit(1800, 500));
      };
      this.mc.once('windowOpen', onTpaWindow);
      tpaGuiTimer = setTimeout(() => {
        if (this.mc) this.mc.removeListener('windowOpen', onTpaWindow);
        this.log('warn', 'TPA: GUI xác nhận không xuất hiện sau 10s');
      }, TPA_GUI_TIMEOUT);
    });
    r.register('order', 'Xem chi tiết thô 1 dòng đơn hàng vừa quét: order raw <số thứ tự>', (args) => {
      if ((args[0] || '').toLowerCase() !== 'raw' || !args[1]) {
        this.log('warn', 'Cú pháp: order raw <số thứ tự> (dùng sau khi lệnh /order đã hiện bảng)');
        return;
      }
      const list = this._lastOrderEntries || [];
      if (!list.length) { this.log('warn', 'Chưa có dữ liệu — gửi /order <item> trước'); return; }
      const idx = parseInt(args[1], 10) - 1;
      const e = list[idx];
      if (!e) { this.log('warn', `Không có mục #${args[1]} (tổng ${list.length} mục)`); return; }
      this.log('sys', `— #${args[1]} ${e.item} (slot ${e.slot}) —`);
      (e.raw.length ? e.raw : ['(không có lore)']).forEach(l => this.log('sys', `  ${l}`));
    });
    r.register('autosell', 'Tự chạy macro khi đầy túi đồ: autosell <%đầy> <macro> | autosell off | autosell | autosell revenue ...', (args) => {
      const sub0 = String(args[0] || '').toLowerCase();
      if (sub0 === 'revenue' || sub0 === 'rev' || sub0 === 'doanhthu') {
        const a1 = String(args[1] || '').toLowerCase();
        if (a1 === 'report' || a1 === 'send') { const rr = this.sendMacroRevenueReportNow(); this.log(rr.ok ? 'ok' : 'warn', rr.ok ? 'Đã gửi báo cáo doanh thu auto-sell' : rr.message); return; }
        if (a1 === 'reset') { this.resetMacroRevenue(); return; }
        if (a1 === 'on' || a1 === 'off') {
          this.autoSellRevenue = a1 === 'on';
          if (!this.autoSellRevenue) { this._macroSellCap = null; this._clearTimer('macroSellFinalize'); }
          this._persistMacroSellCfg();
          this.log('ok', `Báo cáo doanh thu auto-sell: ${this.autoSellRevenue ? 'BẬT' : 'TẮT'}`);
          return;
        }
        if (a1 === 'every') {
          const v = String(args[2] || '').toLowerCase();
          if (v === 'off' || v === '0') { this.autoSellReportMin = 0; this._persistMacroSellCfg(); this.log('ok', 'Báo cáo doanh thu auto-sell: gửi sau MỖI lần bán'); return; }
          const d = this._parseDuration(args.slice(2).join(' '));
          if (!d) { this.log('warn', 'Cú pháp: autosell revenue every <thời gian> | off — vd: 30m, 1h'); return; }
          const min = d.hour * 60 + d.minute + d.second / 60;
          this.autoSellReportMin = min;
          this._persistMacroSellCfg();
          this.log('ok', `Báo cáo doanh thu auto-sell: tối đa 1 báo cáo / ${this._fmtDuration(min * 60000)} (các lần bán ở giữa được cộng dồn)`);
          return;
        }
        if (a1 === 'keyword' || a1 === 'kw') {
          const v = args.slice(2).join(' ').trim();
          this.autoSellMsgKeyword = (!v || v.toLowerCase() === 'off') ? '' : v;
          this._persistMacroSellCfg();
          this.log('ok', this.autoSellMsgKeyword ? `Chỉ tính tin bán chứa: "${this.autoSellMsgKeyword}"` : 'Đã bỏ lọc từ khoá (tính mọi tin có số tiền)');
          return;
        }
        if (a1 === 'ignorechat') {
          const v = String(args[2] || '').toLowerCase();
          if (v !== 'on' && v !== 'off') { this.log('warn', 'Cú pháp: autosell revenue ignorechat on|off'); return; }
          this.autoSellIgnoreChat = v === 'on';
          this._persistMacroSellCfg();
          this.log('ok', `Bỏ qua chat người chơi khi đo doanh thu: ${this.autoSellIgnoreChat ? 'BẬT' : 'TẮT'}`);
          return;
        }
        this.log('sys', `Doanh thu auto-sell [${this.autoSellRevenue ? 'BẬT' : 'TẮT'}]: ${this.getMacroRevenueText()}`);
        this.log('sys', 'Lệnh: autosell revenue [report|reset|on|off|every <30m>|keyword <chữ|off>|ignorechat on|off]');
        return;
      }
      if (!args[0]) {
        if (!this.autoSellMacro) { this.log('sys', 'Chưa đặt auto-sell. Cú pháp: autosell <%đầy, vd 90> <tên macro>'); return; }
        const used = this.state.inventory?.length || 0;
        this.log('sys', `Auto-sell: ${this.autoSellThreshold}% đầy → macro "${this.autoSellMacro}" (hiện ${used}/36 ô)${this._autoSellFired ? ' [đã bắn, chờ dọn bớt để reset]' : ''}`);
        return;
      }
      if (args[0].toLowerCase() === 'off') {
        this.autoSellMacro = null;
        this._autoSellFired = false;
        this._persistMacroSellCfg();
        this.log('sys', 'Đã tắt auto-sell');
        return;
      }
      const pct = parseInt(args[0], 10);
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) { this.log('warn', 'Auto-sell: % không hợp lệ (1-100)'); return; }
      const macroName = args[1];
      if (!macroName) { this.log('warn', 'Cú pháp: autosell <%đầy> <tên macro>'); return; }
      if (!this.macroEngine.list().some(n => n.toLowerCase() === macroName.toLowerCase())) {
        this.log('warn', `Auto-sell: macro "${macroName}" không tồn tại (xem: listmacro)`);
        return;
      }
      this.autoSellThreshold = pct;
      this.autoSellMacro = macroName;
      this._autoSellFired = false;
      this._persistMacroSellCfg();
      this.log('ok', `Đã đặt auto-sell: ${pct}% đầy → macro "${macroName}"`);
      this._askRevenueWebhook(); // bật xong -> hỏi liên kết webhook Discord (bỏ trống = bỏ qua)
    });
    r.register('goal', 'Đặt/xem mục tiêu tiền để tự chạy macro: goal <số> <macro> | goal off | goal', (args) => {
      if (!args[0]) {
        if (!this.moneyGoal) { this.log('sys', 'Chưa đặt goal. Cú pháp: goal <số như 1.5k/1500> <tên macro>'); return; }
        this.log('sys', `Goal: ${this.moneyGoal.toLocaleString()} (hiện có ${this.state.money.toLocaleString()}) → macro "${this.moneyGoalMacro || '(không có)'}"${this._moneyGoalFired ? ' [đã bắn, chờ rớt dưới ngưỡng để reset]' : ''}`);
        return;
      }
      if (args[0].toLowerCase() === 'off') {
        this.moneyGoal = null;
        this.moneyGoalMacro = null;
        this._moneyGoalFired = false;
        this.log('sys', 'Đã tắt goal');
        return;
      }
      const amount = this._parseAmount(args[0]);
      if (!amount || amount <= 0) { this.log('warn', `Goal: số không hợp lệ "${args[0]}" (vd: 1500, 1.5k, 2M)`); return; }
      const macroName = args[1] || null;
      if (macroName && !this.macroEngine.list().some(n => n.toLowerCase() === macroName.toLowerCase())) {
        this.log('warn', `Goal: macro "${macroName}" không tồn tại (xem: listmacro)`);
        return;
      }
      this.moneyGoal = amount;
      this.moneyGoalMacro = macroName;
      this._moneyGoalFired = this.state.money >= amount;
      this.log('ok', `Đã đặt goal: ${amount.toLocaleString()} → macro "${macroName || '(không có, chỉ báo)'}"${this._moneyGoalFired ? ' (đã đủ ngay bây giờ, sẽ bắn ở lần cập nhật tiền tiếp theo)' : ''}`);
    });
    r.register('proxyrotate', 'Bật/tắt xoay proxy tự động (1-10 phút/lần, ngẫu nhiên): proxyrotate on|off', (args) => {
      const want = (args[0] || '').toLowerCase();
      if (want === 'off') { this._stopProxyRotate(); return; }
      if (want === 'on' || !want) { this._startProxyRotate(); return; }
      this.log('warn', 'Cú pháp: proxyrotate on|off');
    });
    r.register('spawnerprotect', 'Bật/Tắt bảo vệ lồng spawn (bật = tự lưu lồng trong 5 block quanh bot): spawnerprotect on|off', (args) => {
      if (!this.requireOnline('spawnerprotect')) return;
      const want = (args[0] || '').toLowerCase();
      if (want === 'off') { this._stopSpawnerProtect(); return; }
      if (want === 'on' || !want) { this._startSpawnerProtect(); return; }
      this.log('warn', 'Cú pháp: spawnerprotect on|off');
    });
    r.register('addspawner', 'Thêm toạ độ lồng cần bảo vệ: addspawner [x y z] (bỏ trống = vị trí hiện tại)', (args) => {
      if (!this.requireOnline('addspawner')) return;
      let x, y, z;
      if (args.length >= 3) {
        [x, y, z] = args.slice(0, 3).map(Number);
        if ([x, y, z].some(Number.isNaN)) { this.log('warn', 'Toạ độ không hợp lệ'); return; }
      } else if (this.mc.entity?.position) {
        ({ x, y, z } = this.mc.entity.position);
      } else {
        this.log('warn', 'Chưa rõ vị trí hiện tại — cú pháp: addspawner <x> <y> <z>');
        return;
      }
      x = Math.round(x); y = Math.round(y); z = Math.round(z);
      if (this.protectedSpawners.some(p => p.x === x && p.y === y && p.z === z)) {
        this.log('warn', `Đã có trong danh sách: (${x},${y},${z})`);
        return;
      }
      this.protectedSpawners.push({ x, y, z });
      this.log('ok', `Đã thêm lồng cần bảo vệ: (${x},${y},${z}) — tổng ${this.protectedSpawners.length}`);
    });
    r.register('removespawner', 'Bỏ toạ độ khỏi danh sách bảo vệ: removespawner <x> <y> <z>', (args) => {
      const [x, y, z] = args.slice(0, 3).map(Number);
      if ([x, y, z].some(Number.isNaN)) { this.log('warn', 'Cú pháp: removespawner <x> <y> <z>'); return; }
      const before = this.protectedSpawners.length;
      this.protectedSpawners = this.protectedSpawners.filter(p => !(p.x === Math.round(x) && p.y === Math.round(y) && p.z === Math.round(z)));
      this.log(this.protectedSpawners.length < before ? 'ok' : 'warn',
        this.protectedSpawners.length < before ? `Đã bỏ (${x},${y},${z})` : `Không tìm thấy (${x},${y},${z})`);
    });
    r.register('listspawners', 'Xem danh sách lồng đang bảo vệ', () => {
      if (!this.protectedSpawners.length) { this.log('sys', 'Chưa có lồng nào'); return; }
      this.log('sys', `— Đang bảo vệ ${this.protectedSpawners.length} lồng (quét người lạ ${this.spawnerProtectRange} block, ${this._spawnerProtectOn ? 'BẬT' : 'TẮT'}${this.spawnerAutoMine ? '' : ', chỉ cảnh báo'}) —`);
      this.protectedSpawners.forEach(p => this.log('sys', `  (${p.x}, ${p.y}, ${p.z})`));
      if (this.spawnerWhitelist.length) this.log('sys', `Whitelist: ${this.spawnerWhitelist.join(', ')}`);
    });
    r.register('board', 'Xem Board server (Money, Shards, ...)', () => {
      if (!this.requireOnline('board')) return;
      const board = this.readBoard();
      if (!board || !board.lines.length) { this.log('warn', 'Chưa đọc được board (chưa có scoreboard hoặc chưa bật)'); return; }
      const money = this._extractBoardStat(board, ['MONEY', 'TIỀN', 'TIEN', 'XU', 'COIN']);
      const shard = this._extractBoardStat(board, ['SHARD', 'MẢNH', 'MANH']);
      if (money !== null) this._updateMoney(money);
      if (shard !== null) this._updateShard(shard);
      this.log('sys', `— Board${board.title ? ': ' + board.title : ''} —`);
      board.lines.forEach(l => this.log('sys', `  ${l.text}`));
      if (money !== null) this.log('ok', `💰 Money: ${money.toLocaleString()}`);
      if (shard !== null) this.log('ok', `✨ Shards: ${shard.toLocaleString()}`);
    });
    r.register('ping', 'Hiện ping', () => {
      this.log('sys', `Ping: ${this.state.ping >= 0 ? this.state.ping + 'ms' : 'N/A'}`);
    });
    r.register('pos', 'Hiện tọa độ', () => {
      const p = this.state.position;
      if (!p) { this.log('warn', 'Chưa có tọa độ'); return; }
      this.log('sys', `Vị trí: X=${p.x?.toFixed(2)} Y=${p.y?.toFixed(2)} Z=${p.z?.toFixed(2)}`);
    });
    r.register('inv', 'Xem inventory', () => {
      this._updateInventory();
      const inv = this.state.inventory;
      if (!inv.length) { this.log('warn', 'Túi đồ trống'); return; }
      inv.forEach(item => this.log('sys', `[${item.slot}] ${item.name} x${item.count}`));
    });
    r.register('status', 'Hiện trạng thái', () => this.emit('status'));
    r.register('reconnect', 'Force reconnect', () => this.forceReconnect());
    r.register('menu', 'Gửi menu command thủ công', () => {
      if (!this.requireOnline('menu')) return;
      if (!this.cfg.menuCommand) { this.log('warn', 'Chưa có menuCommand'); return; }
      try {
        this.mc.chat(this.cfg.menuCommand);
        this.log('sys', `Gửi menu: ${this.cfg.menuCommand}`);
      } catch (e) { this.log('err', e.message); }
    });
    r.register('addcmd', 'Thêm custom command: addcmd <tên> <lệnh MC>', (args) => {
      if (args.length < 2) { this.log('warn', 'Cú pháp: addcmd <tên> <lệnh>'); return; }
      const name = args[0].toLowerCase();
      const cmd = args.slice(1).join(' ');
      this.cmdRegistry.addCustom(name, cmd);
      this.log('ok', `Đã thêm lệnh "${name}" → "${cmd}"`);
    });
    r.register('delcmd', 'Xóa custom command: delcmd <tên>', (args) => {
      if (!args[0]) { this.log('warn', 'Cú pháp: delcmd <tên>'); return; }
      const name = args[0].toLowerCase();
      if (this.cmdRegistry.deleteCustom(name)) {
        this.log('ok', `Đã xóa lệnh "${name}"`);
      } else {
        this.log('warn', `Không tìm thấy lệnh "${name}"`);
      }
    });
    r.register('macro', 'Chạy macro (chat/delay/winclick/ask/confirm...): macro <tên>', (args) => {
      if (!this.requireOnline('macro')) return;
      if (!args[0]) { this.log('warn', 'Cú pháp: macro <tên>'); return; }
      this.macroEngine.run(args[0]).catch(e => this.log('err', `Macro lỗi: ${e.message}`));
    });
    r.register('answer', 'Trả lời câu hỏi macro đang chờ (ask/askmap/confirm): answer <nội dung>', (args) => {
      const text = args.join(' ');
      if (!text) { this.log('warn', 'Cú pháp: answer <nội dung>'); return; }
      if (!this.macroEngine.answer(text)) {
        this.log('warn', 'Không có câu hỏi nào đang chờ trả lời');
      }
    });
    const sellSpawnCmd = (args) => {
      const sub = (args[0] || 'status').toLowerCase();
      const coords = () => {
        const [x, y, z] = args.slice(1, 4).map(Number);
        return (args.length >= 4 && ![x, y, z].some(Number.isNaN)) ? { x: Math.round(x), y: Math.round(y), z: Math.round(z) } : null;
      };
      if (sub === 'on') {
        if (!this.requireOnline('autosell_spawn')) return;
        const r = this.configureSellSpawn({ on: true });
        if (!r || r.ok !== false) this._askRevenueWebhook(); // bật xong -> hỏi liên kết webhook Discord (bỏ trống = bỏ qua)
        return;
      }
      if (sub === 'off') { this._stopSellSpawn(); return; }
      if (sub === 'now') { if (!this.requireOnline('autosell_spawn')) return; this.runSellSpawnNow(); return; }
      if (sub === 'scan') {
        if (!this.requireOnline('autosell_spawn')) return;
        const n = this._scanSellSpawns();
        this.log(n ? 'ok' : 'sys', n ? `Auto-sell Spawn: thêm ${n} lồng mới (tổng ${this.sellSpawnList.length})` : `Auto-sell Spawn: không thấy lồng mới trong ${this.autoSellSpawnRange} block`);
        return;
      }
      if (sub === 'every') {
        const d = this._parseDuration(args.slice(1).join(' '));
        if (!d) { this.log('warn', 'Cú pháp: autosell_spawn every <thời gian> — vd: 30s | 5m | 2h | 1h30m'); return; }
        const r = this.configureSellSpawn({ hour: d.hour, minute: d.minute, second: d.second });
        this.log(r.ok ? 'ok' : 'warn', r.ok ? `Auto-sell Spawn: lặp mỗi ${this._fmtDuration(this._sellSpawnIntervalMs())}${r.message ? ' — ' + r.message : ''}` : r.message);
        return;
      }
      if (sub === 'slot') {
        if (args[1] === undefined) { this.log('warn', 'Cú pháp: autosell_spawn slot <số ô> [0=trái|1=phải]'); return; }
        const r = this.configureSellSpawn({ slot: args[1], button: args[2] });
        this.log(r.ok ? 'ok' : 'warn', r.ok ? `Auto-sell Spawn: click ô ${this.autoSellSpawnSlot} (chuột ${this.autoSellSpawnButton ? 'phải' : 'trái'})` : r.message);
        return;
      }
      if (sub === 'add') {
        const c = coords();
        if (!c) { this.log('warn', 'Cú pháp: autosell_spawn add <x> <y> <z> (toạ độ block lồng) — hoặc dùng: autosell_spawn scan'); return; }
        if (this.sellSpawnList.some(p => p.x === c.x && p.y === c.y && p.z === c.z)) { this.log('warn', `Đã có trong danh sách: (${c.x},${c.y},${c.z})`); return; }
        this.sellSpawnList.push(c);
        this._persistSellSpawnState();
        this.log('ok', `Auto-sell Spawn: đã thêm (${c.x},${c.y},${c.z}) — tổng ${this.sellSpawnList.length}`);
        return;
      }
      if (sub === 'remove' || sub === 'del') {
        const c = coords();
        if (!c) { this.log('warn', 'Cú pháp: autosell_spawn remove <x> <y> <z>'); return; }
        const before = this.sellSpawnList.length;
        this.sellSpawnList = this.sellSpawnList.filter(p => !(p.x === c.x && p.y === c.y && p.z === c.z));
        this._persistSellSpawnState();
        this.log(this.sellSpawnList.length < before ? 'ok' : 'warn', this.sellSpawnList.length < before ? `Đã bỏ (${c.x},${c.y},${c.z})` : `Không tìm thấy (${c.x},${c.y},${c.z})`);
        return;
      }
      if (sub === 'clear') { this.sellSpawnList = []; this._persistSellSpawnState(); this.log('sys', 'Auto-sell Spawn: đã xoá hết danh sách lồng'); return; }
      if (sub === 'revenue' || sub === 'rev' || sub === 'doanhthu') {
        const a1 = (args[1] || '').toLowerCase();
        if (a1 === 'reset') { this.resetRevenue(); return; }
        if (a1 === 'report' || a1 === 'send') { const r = this.sendRevenueReportNow(); this.log(r.ok ? 'ok' : 'warn', r.ok ? 'Đã gửi báo cáo doanh thu' : r.message); return; }
        if (a1 === 'on' || a1 === 'off') { this.configureSellSpawn({ revenue: a1 === 'on' }); this.log('ok', `Báo cáo doanh thu: ${this.autoSellSpawnRevenue ? 'BẬT' : 'TẮT'}`); return; }
        if (a1 === 'every') {
          const v = (args[2] || '').toLowerCase();
          if (v === 'off' || v === '0') { this.configureSellSpawn({ reportMin: 0 }); this.log('ok', 'Báo cáo doanh thu: gửi sau MỖI vòng bán'); return; }
          const d = this._parseDuration(args.slice(2).join(' '));
          if (!d) { this.log('warn', 'Cú pháp: autosell_spawn revenue every <thời gian> | off — vd: 30m, 1h'); return; }
          const min = d.hour * 60 + d.minute + d.second / 60;
          this.configureSellSpawn({ reportMin: min });
          this.log('ok', `Báo cáo doanh thu: tối đa 1 báo cáo / ${this._fmtDuration(min * 60000)} (doanh thu các vòng ở giữa được cộng dồn)`);
          return;
        }
        this.log('sys', `Doanh thu [${this.autoSellSpawnRevenue ? 'BẬT' : 'TẮT'}]: ${this.getRevenueText()}`);
        return;
      }
      if (sub === 'msg') {
        const kw = args.slice(1).join(' ').trim();
        if (!kw) { this.log('sys', `Lọc tin doanh thu: ${this.autoSellSpawnMsgKeyword ? `"${this.autoSellSpawnMsgKeyword}"` : '(không lọc — mọi tin có số tiền k/m/b trong lúc bán đều được tính)'}`); return; }
        this.configureSellSpawn({ msgKeyword: kw === 'off' ? '' : kw });
        this.log('ok', kw === 'off' ? 'Đã bỏ lọc tin doanh thu' : `Chỉ tính tin có chứa: "${kw}" (nhiều chữ ngăn bằng |)`);
        return;
      }
      if (sub === 'ignorechat') {
        const v = (args[1] || '').toLowerCase();
        if (v !== 'on' && v !== 'off') { this.log('sys', `Bỏ qua chat người chơi: ${this.autoSellSpawnIgnoreChat ? 'BẬT' : 'TẮT'} — đổi: autosell_spawn ignorechat on|off`); return; }
        this.configureSellSpawn({ ignoreChat: v === 'on' });
        this.log('ok', `Bỏ qua chat người chơi: ${v === 'on' ? 'BẬT' : 'TẮT (tin ở kênh chat cũng được tính — dễ đếm nhầm)'}`);
        return;
      }
      if (sub === 'status' || sub === 'list') {
        this.log('sys', `Auto-sell Spawn: ${this._sellSpawnOn ? 'BẬT' : 'TẮT'} — ${this.sellSpawnList.length} lồng | click ô ${this.autoSellSpawnSlot} (chuột ${this.autoSellSpawnButton ? 'phải' : 'trái'}) | mỗi ${this._fmtDuration(this._sellSpawnIntervalMs())}${this._sellSpawnBusy ? ' [đang chạy]' : ''}`);
        this.sellSpawnList.slice(0, 30).forEach(p => this.log('sys', `  (${p.x}, ${p.y}, ${p.z})`));
        if (this.sellSpawnList.length > 30) this.log('sys', `  ... và ${this.sellSpawnList.length - 30} lồng nữa`);
        return;
      }
      this.log('warn', 'Cú pháp: autosell_spawn on|off|now|scan|status | every <30s|5m|2h|1h30m> | slot <n> [0|1] | add/remove <x> <y> <z> | clear | revenue [report|reset|on|off|every <30m>] | msg <chữ|off> | ignorechat on|off');
    };
    r.register('autosell_spawn', 'Tự bán ở lồng: chuột phải lồng -> click ô (mặc định 51) -> đóng GUI, lặp mỗi giờ/phút/giây tuỳ chỉnh + báo cáo doanh thu qua webhook: autosell_spawn on|off|now|scan|every 5m|slot 51|add x y z|revenue', sellSpawnCmd);
    r.register('autosellspawn', 'Như autosell_spawn (tên viết liền)', sellSpawnCmd);
    r.register('stopmacro', 'Dừng macro đang chạy', () => {
      this.macroEngine.stop();
      this.log('sys', 'Đã gửi yêu cầu dừng macro');
    });
    r.register('listmacro', 'Xem danh sách macro (config.json > macros)', () => {
      const names = this.macroEngine.list();
      if (!names.length) { this.log('sys', 'Chưa có macro nào trong config.json'); return; }
      names.forEach(n => this.log('sys', `- ${n}${this.cfg.macros[n].next ? ' → next: ' + this.cfg.macros[n].next : ''}`));
    });
    r.register('listcmd', 'Xem danh sách custom commands', () => {
      const cmds = this.cmdRegistry.getCustomCmds();
      if (!cmds.length) { this.log('sys', 'Chưa có custom command nào'); return; }
      cmds.forEach(c => this.log('sys', `  ${c.name} → ${c.cmd}`));
    });
  }
  getSummary() {
    const s = this.state;
    const pm = this.packetMgr;
    return {
      id: this.cfg.id,
      username: this.cfg.username,
      host: this.cfg.host,
      port: this.cfg.port,
      version: this.cfg.version,
      state: s.connState,
      afk: s.afk,
      shard: s.shard,
      money: s.money,
      moneyGoal: this.moneyGoal,
      spawnerProtect: this._spawnerProtectOn ? this.protectedSpawners.length : 0,
      autoSellSpawn: this._sellSpawnOn ? this.sellSpawnList.length : 0,
      ping: s.ping,
      reconnects: s.reconnects,
      health: s.health,
      food: s.food,
      position: s.position,
      tshard: s.tshard,
      autoStats: s.autoStats,
      autoShard: s.autoShard,
      autoEat: s.autoEat,
      eatThreshold: this.settings.eatThreshold || 15,
      proxy: this.proxy ? `${this.proxy.type}://${this.proxy.host}:${this.proxy.port}` : null,
      proxyId: this.proxy?.id || null,
      ppsIn: pm?.ppsIn ?? 0,
      ppsOut: pm?.ppsOut ?? 0,
      lastPacket: pm?.lastPacketAt ?? null,
      loginTime: s.loginTime,
      menuRetries: this._menuRetryCount ?? 0,
      menuSuccess: this._menuSuccess ?? false,
      registered: this.cfg.registered,
      cfg: {
        autoMenu: this.cfg.autoMenu,
        menuCommand: this.cfg.menuCommand,
        respawn: this.cfg.respawn,
        ownerUsername: this.cfg.ownerUsername,
        useProxy: this.cfg.useProxy,
        autoEat: this.state.autoEat,
      },
    };
  }
}
module.exports = BotSession;
