'use strict';
const EventEmitter = require('events');
const { dbg } = require('./debug');
const path = require('path');
const mineflayer = require('mineflayer');
const { CS, TIMING, IGNORED_ERRORS, DEFAULTS, SELL, TP } = require('./constants');
const { rand, jit, clamp, nowMs, sleep, resolveText, parseShardNum, safeJsonStringify, parseReasonText, normalizeSmallCaps } = require('./utils');
const TrafficWatcher = require('./TrafficWatcher');
const PacketFilter = require('./PacketFilter');
const CommandRegistry = require('./CommandRegistry');
const HelpCatalog = require('./HelpCatalog');
const { WindowRouter } = require('./WindowRouter');
const RingBuffer = require('./RingBuffer');
const SharedPool = require('./SharedPool');
const RevenueTracker = require('./RevenueTracker');
const TeleportWatch = require('./TeleportWatch');
const ScriptRunner = require('./ScriptRunner');
const Notifier = require('./Notifier');
const { anglesTo, aimCheck, EYE_STAND } = require('./VectorUtil');
const { resolvePlayerPose, describePose, supportsPoseMeta } = require('./MotionUtil');
const SG = require('./SpawnMonitor');
const { SpawnerTracker } = require('./SpawnerTracker');
const vec3lib = require('vec3');
const SessionVerifier = require('./SessionVerifier');
const ReconnectHandler = require('./ReconnectHandler');
const AutoSellHandler = require('./AutoSellHandler');
const TeleportHandler = require('./TeleportHandler');
const LoginHandler = require('./LoginHandler');
const AutoLoginFlow = require('./AutoLoginFlow');
const StatsReader = require('./StatsReader');
const AutoOrder = require('./AutoOrder');
const { protectNames } = require('./PremiumLogic');
const makeVec3 = (x, y, z) => (typeof vec3lib === 'function' ? vec3lib(x, y, z) : new vec3lib.Vec3(x, y, z));
// SELL.* và TP.* lấy từ constants.js — loại bỏ magic number và hardcoded Discord ID
// ReconnectHandler (đã chuyển body) / AutoSellHandler / TeleportHandler / LoginHandler (skeleton + delegate)
class BotSession extends EventEmitter {
  constructor(cfg, theme, proxyManager, socketRooms = null) {
    super();
    this.cfg = cfg;
    this.theme = theme;
    this.proxyManager = proxyManager;
    this.socketRooms = socketRooms;
    this.proxy = null;
    this.mc = null;
    this._spawnerTracker = null;
    this.packetMgr = new TrafficWatcher(cfg.id);
    this.packetFilter = new PacketFilter({
      botId: cfg.id,
      log: (lvl, m) => this.log(lvl, m),
      skipBadPackets: cfg.skipBadPackets !== false,   // gói parse lỗi -> bỏ riêng gói đó, KHÔNG để luồng đọc chết (xem PacketFilter.js)
      onDead: () => { if (this.isOnline) this.scheduleReconnect('protocol stream dead'); },
    });
    this.cmdRegistry = new CommandRegistry(this);
    this.scriptRunner = new ScriptRunner(this);
    this.sessionVerifier = new SessionVerifier(this, cfg.sessionCheck || {});
    this.reconnectHandler = new ReconnectHandler(this);
    this.autoSellHandler = new AutoSellHandler(this);
    this.autoOrder = new AutoOrder(this);
    this.teleportHandler = new TeleportHandler(this);
    this.loginHandler = new LoginHandler(this);
    this.statsReader = new StatsReader(this);   // đọc /stats <người chơi> (port từ CheckStatsKingMC)
    this.autoLogin = new AutoLoginFlow(this);   // Auto Login & Antibot & Auto Join (cfg.autoLogin, mặc định tắt)
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
    // true = bot không đang giữ slot kết nối nào. Chỉ start() mới đặt false (cùng lúc tăng _activeConnects),
    // nếu không thì shutdown() của bot chưa từng chạy sẽ trừ nhầm slot của bot khác.
    this._connectCompleted = true;
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
    // block quanh bot; canh người lạ (spawnerProtectRange) + đập block gần lồng, đào bề mặt,
    // TNT, wither (port từ mod "Spawner Protect" của Alatic); thấy nguy hiểm -> lấy cúp (túi đồ,
    // không có thì ender chest), giữ shift đập hết lồng theo từng đợt, cất item "lồng"/"spawn"
    // vào ender chest rồi MỞ LẠI để xác minh. Không có cúp ở cả 2 nơi -> cảnh báo liên tục.
    // CƯỜNG ĐỘ PROTECT: spawnerProtectLevel (1-4) = bộ thông số dựng sẵn (xem SpawnMonitor.js);
    // spawnerProtectTune = các thông số bạn chỉnh tay, đè lên mức đang chọn.
    this._initSpawnerLevel(cfg);
    this.spawnerSaveRange = cfg.spawnerSaveRange || 5;
    // Chỉ "canh gác" khi THỰC SỰ đang đứng cạnh lồng: phải có ít nhất 1 lồng đã lưu nằm trong
    // spawnerArmRange block quanh bot (và chunk đã tải, đúng là block lồng), liên tục ít nhất
    // spawnerArmDelayMs. Nhờ vậy lúc vừa đăng nhập ở khu spawn (chưa được chuyển về chỗ cũ)
    // có người chơi đứng gần cũng KHÔNG bị báo nhầm là có người cạnh lồng.
    this.spawnerArmRange = cfg.spawnerArmRange || 8;
    this._spawnerZone = 'unknown'; // 'in' = đang cạnh lồng | 'out' = không có lồng quanh bot
    this._spawnerArmedSince = 0;
    this.spawnerAutoDisconnect = cfg.spawnerAutoDisconnect ?? false;
    this.spawnerRequireSilk = cfg.spawnerRequireSilk ?? true; // đào không Silk Touch thì lồng bị phá mất, không rơi ra
    this.enderChestCommand = cfg.enderChestCommand ?? '/ec';  // lệnh mở ender chest khi không có rương thật gần đó
    this.spawnerAlertIntervalMs = cfg.spawnerAlertIntervalMs || 5000;
    this.spawnerWhitelist = (cfg.spawnerWhitelist || []).map(n => String(n).toLowerCase());
    this.protectedSpawners = (cfg.protectedSpawners || []).map(p => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) }));
    // SpawnerESP: quét lồng đang được tải, phân loại NATURAL/SMP.
    this.spawnerEspOn = cfg.spawnerEspOn ?? false;
    this.spawnerEspRadiusChunks = Math.max(1, Math.min(8, Number(cfg.spawnerEspRadiusChunks) || 4));
    this.spawnerEspScanTicks = Math.max(5, Math.min(200, Number(cfg.spawnerEspScanTicks) || 20));
    this.spawnerEspFilter = ['BOTH', 'NATURAL', 'SMP'].includes(String(cfg.spawnerEspFilter || 'BOTH').toUpperCase()) ? String(cfg.spawnerEspFilter || 'BOTH').toUpperCase() : 'BOTH';
    this._spawnerProtectOn = !!cfg.spawnerProtectOn; // ý định bật — thực sự khởi động ở _resumeIntendedStates() khi online
    this._spawnerAlertedAt = new Map();
    this._spawnerBusy = false;
    this._spawnerRetryAt = 0;
    this._spawnerNoPickUntil = 0;
    this._spawnerDeadline = 0;
    this._spStashAgg = null;
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
    // Bán lỗi (chưa click đủ lồng) -> gõ spawnHomeCommand (/home treolong) rồi bán lại; lặp tối đa N lần, vẫn lỗi thì báo webhook + tag.
    this._sellRecovering = false;
    this.sellFailMaxHome = Number.isInteger(cfg.sellFailMaxHome) && cfg.sellFailMaxHome >= 0 ? cfg.sellFailMaxHome : 10;
    this.sellFailMention = String(cfg.sellFailMention ?? '').trim().replace(/^@/, ''); // ID Discord (hoặc role:<id>); rỗng/off = không tag. Không còn hardcoded default.
    this.sellFailAlertMinMs = cfg.sellFailAlertMinMs ?? 600000; // báo webhook thất bại tối đa 1 lần / chừng này (tránh spam mỗi chu kỳ)
    this._sellFailAlertedAt = 0;
    this.sellHomeChunkWaitMs = cfg.sellHomeChunkWaitMs ?? 6000; // sau /home chờ tối đa chừng này cho chunk chỗ lồng tải xong rồi mới bán lại
    this._lastSellHomeAt = 0;
    this._sellWhy = '';
    this._viewLockUntil = 0;       // đang nhắm lồng/rương: AFK không được xoay đầu/đi/nhảy cho tới mốc này
    this._lastAim = null;
    this._lastBody = null;         // trạng thái cơ thể lần tính gần nhất (tư thế đứng/ngồi/bò, độ cao mắt) — xem _bodyState
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
    // ===== Trình tự khởi động =====
    // 1) chờ server báo "SẢNH ➞ Đăng nhập thành công…"  2) gửi /menu + click ô vào server  3) chờ bot đứng đúng chỗ
    // cạnh lồng (nếu lệch thì tự gõ spawnHomeCommand)  4) MỚI bật spawnerprotect + autosell_spawn + autosell macro
    // và gửi webhook báo đã bật. Sau đó vẫn canh vị trí: lệch khỏi chỗ treo lồng là tự gõ lại spawnHomeCommand.
    this.loginSuccessPattern = String(cfg.loginSuccessPattern || '');         // regex tuỳ chọn; mặc định nhận "đăng nhập thành công" / "đã đăng nhập"
    this.loginConfirmTimeoutMs = cfg.loginConfirmTimeoutMs ?? 45000;          // quá lâu không thấy tin xác nhận thì vẫn đi tiếp (kèm cảnh báo)
    this.spawnHomeEnabled = cfg.spawnHomeEnabled ?? true;                     // tự về home khi lệch khỏi vị trí treo lồng
    this.spawnHomeCommand = String(cfg.spawnHomeCommand || '/home treolong').trim() || '/home treolong';
    this.spawnHomeGraceMs = cfg.spawnHomeGraceMs ?? 12000;                    // sau khi vào menu, chờ chừng này cho server tự đưa bot về chỗ cũ rồi mới gõ lệnh
    this.spawnHomeConfirmMs = cfg.spawnHomeConfirmMs ?? 4000;                 // phải lệch liên tục chừng này mới coi là "đã rời vị trí" (tránh nhầm lúc chunk nháy)
    this.spawnHomeCooldownMs = cfg.spawnHomeCooldownMs ?? 20000;              // giãn cách giữa 2 lần gõ lệnh (đợi teleport xong)
    this.spawnHomeMaxTries = cfg.spawnHomeMaxTries ?? 5;                      // quá số lần này vẫn chưa về -> báo webhook + thử thưa dần
    this.spawnHomeSlowMs = cfg.spawnHomeSlowMs ?? 300000;                     // giãn cách thử lại sau khi quá số lần (5 phút)
    this.spawnHomeWarmupMs = cfg.spawnHomeWarmupMs ?? 5000;                   // server đếm ngược chừng này trước khi teleport — bot đứng yên hoàn toàn (không nhảy/đi/AFK)
    this.spawnHomeMarginMs = cfg.spawnHomeMarginMs ?? 3000;                   // chờ thêm sau đếm ngược cho gói teleport + tải chunk, quá mà vẫn đứng nguyên thì báo "teleport không xảy ra"
    this._tp = new TeleportWatch({ warmupMs: this.spawnHomeWarmupMs, marginMs: this.spawnHomeMarginMs });
    this._hudLast = { text: '', at: 0 };
    this.spawnPositionSettleMs = cfg.spawnPositionSettleMs ?? 2500;           // phải thấy lồng cạnh bot + đứng yên chừng này mới bật tính năng
    this.spawnGateTimeoutMs = cfg.spawnGateTimeoutMs ?? 180000;               // quá lâu chưa về được vị trí -> báo webhook + vẫn bật autosell macro
    this._loginConfirmed = false;
    this._menuFlowStarted = false;
    this._menuDoneAt = 0;
    this._manualMenuUntil = 0;
    this._featuresActive = false;   // đã qua cổng vị trí và bật spawnerprotect/autosell_spawn
    this._autoSellArmed = false;    // autosell macro (túi đầy) chỉ chạy sau khi vào server xong
    this._gateStartedAt = 0;
    this._gateTimedOut = false;
    this._posNearSince = 0;
    this._posAwaySince = 0;
    this._posLastPos = null;
    this._posLost = false;          // đang lệch khỏi vị trí treo lồng
    this._homeOutage = null;        // { since, tries, notified } của lần lệch hiện tại
    this._homeNextAt = 0;
    // Xoay proxy tự động — mỗi lần cách nhau ngẫu nhiên (không phải chu kỳ
    // cố định, để tránh tạo pattern dễ nhận ra) trong khoảng min~max phút.
    this.proxyAutoRotate = !!cfg.proxyAutoRotate;
    this.proxyRotateMinMs = Math.max(1, cfg.proxyRotateMinMinutes ?? 1) * 60000;
    this.proxyRotateMaxMs = Math.max(this.proxyRotateMinMs, (cfg.proxyRotateMaxMinutes ?? 10) * 60000);
    this.packetMgr.on('anomaly', data => {
      this.emit('packetAnomaly', data);
      this._emitIO('packetAnomaly', data);
    });
    this._registerCommands();
  }
  log(level, msg) {
    // NameProtect: config "nameProtect": {"tênThật": "bíDanh"} -> che tên trong mọi log/webhook từ log()
    const np = this.cfg.nameProtect;
    if (np && typeof np === 'object' && typeof msg === 'string') msg = protectNames(msg, Object.entries(np));
    const entry = { id: this.cfg.id, time: nowMs(), level, msg };
    this._logBuffer.push(entry);
    this.emit('log', { level, id: this.cfg.id, msg, theme: this.theme, entry });
    this._emitIO('log', entry, `bot:${this.cfg.id}`);
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
  _notify(eventKey, title, description, color = 0x64748b, headline = null) {
    try { this._manager?.telegramAlert?.(this, eventKey, title, description, headline); } catch { /* Telegram lỗi không được làm hỏng bot */ }
    const n = this._manager?.notifier;
    if (!n?.isEventOn(eventKey)) return;
    n.send(eventKey, this._alertEmbed(title, description, color), headline);
  }
  // ----- Phong cách embed Discord (người chơi / server / ảnh đầu / chân "Antertool • giờ") -----
  _playerLabel() {
    const id = String(this.cfg.id), name = String(this.cfg.username || id);
    return name.toLowerCase() === id.toLowerCase() ? name : `${name} (${id})`;
  }
  _serverLabel() {
    const port = Number(this.cfg.port);
    return `${this.cfg.host || '—'}${port && port !== 25565 ? ':' + port : ''}`;
  }
  // Ảnh đầu nhân vật làm thumbnail; tên không hợp lệ (vd. có dấu cách) thì bỏ qua cho khỏi lỗi
  _headThumb() {
    const name = String(this.cfg.username || '');
    return /^\w{1,16}$/.test(name) ? { url: `https://mc-heads.net/avatar/${name}/100` } : undefined;
  }
  // Tiêu đề call-site dạng "🟠 bot-1: bị kick" -> "Bị kick" (emoji + id đã có trong màu / field "Người chơi")
  _alertTitle(title) {
    let t = String(title || '').replace(/^[^\p{L}\p{N}]+/u, '');
    const pre = `${this.cfg.id}: `;
    if (t.startsWith(pre)) t = t.slice(pre.length);
    return t ? t.charAt(0).toLocaleUpperCase('vi') + t.slice(1) : String(title || '');
  }
  _alertEmbed(title, description, color) {
    return Notifier.finish({
      title: this._alertTitle(title),
      description,
      color,
      fields: [
        { name: 'Người chơi', value: this._playerLabel(), inline: true },
        { name: 'Server', value: this._serverLabel(), inline: true },
      ],
      thumbnail: this._headThumb(),
      timestamp: new Date().toISOString(),
    });
  }
  // Thông báo kick kiểu: "❌ BOT BỊ KICK @tag" + lý do + ⏰ giờ + 🔄 sắp reconnect sau bao lâu (lần mấy).
  // Chờ tối đa 2.5s để biết thời gian reconnect (do scheduleReconnect tính) rồi mới gửi 1 tin duy nhất.
  _queueKickNotify(kickMsg) {
    this._flushKickNotify(null);
    const pend = { kickMsg, at: Date.now(), timer: null };
    pend.timer = setTimeout(() => this._flushKickNotify(null), 2500);
    if (pend.timer.unref) pend.timer.unref();
    this._kickPending = pend;
  }
  _flushKickNotify(info) {
    const pend = this._kickPending;
    if (!pend) return;
    this._kickPending = null;
    clearTimeout(pend.timer);
    let tz = 'Asia/Ho_Chi_Minh';
    try { tz = this._manager?._scheduleTz?.() || tz; } catch (e) { dbg('BotSession', e); }
    let when;
    try { when = new Date(pend.at).toLocaleTimeString('en-US', { timeZone: tz }); } catch { when = new Date(pend.at).toLocaleTimeString('en-US'); }
    const lines = [String(pend.kickMsg).replace(/§[0-9a-fk-orx#]/gi, ''), `⏰ ${when}`]; // bỏ mã màu Minecraft (§c, §7...) cho dễ đọc
    if (info) lines.push(`🔄 Reconnecting in ${Math.round(info.delay / 1000)}s... (lần thứ ${info.attempt}/${info.max})`);
    this._notify('disconnect', `🟠 ${this.cfg.id}: bị kick`, lines.join('\n'), 0xf97316, '❌ BOT BỊ KICK');
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
    try { // đếm tổng thời gian hoạt động (cộng dồn qua các lần vào/ra) — dùng cho bảng Telegram
      if (newState === CS.ONLINE) this._rev.markOnline(this.cfg.id);
      else if (prev === CS.ONLINE) this._rev.markOffline(this.cfg.id);
    } catch { /* đếm giờ lỗi thì thôi, không ảnh hưởng bot */ }
    this.emit('stateChange', { prev, now: newState, id: this.cfg.id });
    this._emitIO('botState', { id: this.cfg.id, state: newState });
  }
  // Phát sự kiện socket.io (bỏ qua nếu chưa có socket). room: chỉ gửi cho 1 room.
  _emitIO(event, data, room) {
    const io = this.socketRooms?.io;
    if (!io) return;
    (room ? io.to(room) : io).emit(event, data);
  }
  // B1: bot đã bị tắt / đang dừng -> mọi luồng start/reconnect phải bỏ qua
  get _shouldNotRun() { return this._disabled || this.isStopping; }
  // A1: đang có routine khác chiếm quyền điều khiển (macro / bảo vệ lồng / auto-sell spawn)
  get _isBusy() { return !!(this.scriptRunner?.running || this._spawnerBusy || this._sellSpawnBusy || this._sellRecovering || this.autoLogin?.inFlow); }
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
    this._emitIO('shard', { id: this.cfg.id, shard: n });
  }
  _updateMoney(n) {
    if (n === null || n === this.state.money) return;
    const prev = this.state.money;
    this.state.money = n;
    this.emit('money', { prev, now: n, id: this.cfg.id });
    this._emitIO('money', { id: this.cfg.id, money: n });
    if (this.moneyGoal) {
      if (n >= this.moneyGoal && !this._moneyGoalFired) {
        this._moneyGoalFired = true;
        this.log('ok', `🎯 Đã đủ ${this.moneyGoal.toLocaleString()} (hiện có ${n.toLocaleString()})${this.moneyGoalMacro ? ` — tự chạy macro "${this.moneyGoalMacro}"` : ''}`);
        this._notify('moneyGoal', `🎯 ${this.cfg.id}: đã đủ tiền`, `Mục tiêu ${this.moneyGoal.toLocaleString()}, hiện có ${n.toLocaleString()}.${this.moneyGoalMacro ? ` Tự chạy macro "${this.moneyGoalMacro}".` : ''}`, 0xfbbf24);
        if (this.moneyGoalMacro) {
          this.scriptRunner.run(this.moneyGoalMacro).catch(e => this.log('err', `Goal macro lỗi: ${e.message}`));
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
      this._emitIO('inventory', { id: this.cfg.id, items: inv });
      this._checkAutoSell(items.length);
    } catch (e) {
      this.log('err', 'Lỗi đọc inventory: ' + e.message);
    }
  }
  // 36 = 27 ô chính + 9 ô hotbar (Window.items() của mineflayer với inventory
  // của chính bot chỉ trả về đúng vùng này, không tính giáp/offhand/crafting).
  _checkAutoSell(usedSlots) {
    if (!this.autoSellMacro) return;
    if (!this._autoSellArmed) return; // chưa đăng nhập/vào menu/vào đúng vị trí xong thì chưa chạy macro bán
    const TOTAL = 36;
    const highSlots = Math.ceil(TOTAL * this.autoSellThreshold / 100);
    const lowSlots = Math.max(0, highSlots - 4);
    if (usedSlots >= highSlots && !this._autoSellFired) {
      this._autoSellFired = true;
      const pct = Math.round((usedSlots / TOTAL) * 100);
      this.log('ok', `🎒 Túi đồ đầy ${pct}% (${usedSlots}/${TOTAL}) — tự chạy macro "${this.autoSellMacro}"`);
      this._notify('autoSell', `🎒 ${this.cfg.id}: túi đồ đầy`, `${usedSlots}/${TOTAL} ô (${pct}%) — tự chạy macro "${this.autoSellMacro}".`, 0x38bdf8);
      const cap = this.autoSellRevenue ? this._beginMacroSellCapture(this.autoSellMacro) : null; // bắt đầu đo TRƯỚC khi macro chạy
      this.scriptRunner.run(this.autoSellMacro)
        .then(ok => { if (cap) this._onMacroSellDone(cap, ok); })
        .catch(e => { this.log('err', `Auto-sell macro lỗi: ${e.message}`); if (cap) this._onMacroSellDone(cap, false); });
    } else if (usedSlots <= lowSlots) {
      this._autoSellFired = false;
    }
  }
  _startSpawnerEsp() {
    if (!this.mc || !this.spawnerEspOn) return false;
    if (this._spawnerTracker && this._spawnerTracker.bot === this.mc) return true;
    this._stopSpawnerEsp();
    const tracker = new SpawnerTracker(this.mc, {
      scanRadiusChunks: this.spawnerEspRadiusChunks,
      scanTickInterval: this.spawnerEspScanTicks,
      filter: this.spawnerEspFilter,
      mergeEnabled: true,
    });
    tracker.on('spawner_found', ({ spawner }) => {
      const p = spawner.pos;
      this.log('ok', `SpawnerESP: ${spawner.isSMP ? 'SMP' : 'NATURAL/không xác định'} ${spawner.mobLabel} tại ${p.x} ${p.y} ${p.z} — cách ${spawner.distanceBlocks.toFixed(1)} block`);
      this.emit('spawnerEspFound', { botId: this.cfg.id, spawner });
    });
    tracker.on('scan_error', e => this.log('warn', `SpawnerESP: quét lỗi: ${e.message}`));
    tracker.start();
    this._spawnerTracker = tracker;
    this.log('sys', `SpawnerESP đã bật (bán kính ${this.spawnerEspRadiusChunks * 16} block, bộ lọc ${this.spawnerEspFilter}).`);
    return true;
  }
  _stopSpawnerEsp() {
    if (!this._spawnerTracker) return;
    try { this._spawnerTracker.stop(); } catch (e) { dbg('SpawnerTracker', e); }
    this._spawnerTracker.removeAllListeners();
    this._spawnerTracker = null;
  }
  _spawnerEspCommand(args = []) {
    const sub = String(args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'bật' || sub === 'bat') {
      this.spawnerEspOn = true; this.cfg.spawnerEspOn = true;
      this._persistSpawnerEsp();
      if (!this.isOnline || !this.mc) { this.log('warn', 'SpawnerESP đã lưu BẬT; sẽ chạy khi bot online.'); return; }
      this._startSpawnerEsp(); return;
    }
    if (sub === 'off' || sub === 'tắt' || sub === 'tat') {
      this.spawnerEspOn = false; this.cfg.spawnerEspOn = false; this._stopSpawnerEsp(); this._persistSpawnerEsp();
      this.log('sys', 'SpawnerESP đã TẮT.'); return;
    }
    if (sub === 'filter') {
      const f = String(args[1] || '').toUpperCase();
      if (!['BOTH', 'NATURAL', 'SMP'].includes(f)) { this.log('warn', 'Dùng: spawneresp filter BOTH|NATURAL|SMP'); return; }
      this.spawnerEspFilter = f; this.cfg.spawnerEspFilter = f; this._persistSpawnerEsp();
      if (this._spawnerTracker) { this._stopSpawnerEsp(); this._startSpawnerEsp(); }
      this.log('sys', `SpawnerESP bộ lọc: ${f}`); return;
    }
    if (sub === 'list') {
      const list = this._spawnerTracker?.getSpawners();
      if (!list?.size) { this.log('sys', 'SpawnerESP: chưa phát hiện lồng nào trong vùng đang tải.'); return; }
      for (const sp of list.values()) this.log('sys', `${sp.isSMP ? 'SMP' : 'NATURAL/không xác định'} ${sp.mobLabel} @ ${sp.pos.x} ${sp.pos.y} ${sp.pos.z} (${sp.distanceBlocks.toFixed(1)} block)`);
      return;
    }
    this.log('sys', `SpawnerESP: ${this.spawnerEspOn ? 'BẬT' : 'TẮT'}; tracker ${this._spawnerTracker ? 'đang chạy' : 'đang dừng'}; bán kính ${this.spawnerEspRadiusChunks * 16} block; filter ${this.spawnerEspFilter}.`);
    this.log('sys', 'Lệnh: spawneresp on|off|status|list|filter BOTH|NATURAL|SMP');
  }
  _persistSpawnerEsp() {
    const mgr = this._manager;
    const list = mgr?._config?.bots;
    const c = list?.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) { c.spawnerEspOn = this.spawnerEspOn; c.spawnerEspFilter = this.spawnerEspFilter; }
    if (mgr?.persistence) mgr.persistence.markDirty();
  }
  _cleanupOnDisconnect() {
    this._stopSpawnerEsp();
    try { this.autoOrder?.stop(true); } catch (e) { dbg('BotSession', e); }
    if (this._macroSellCap) { try { this._finalizeMacroSellRevenue(true); } catch (e) { dbg('BotSession', e); } }
    if (this._sellCap) { try { this._finalizeSellRevenue(true); } catch (e) { dbg('BotSession', e); } } // còn doanh thu đang gom dở -> ghi nốt trước khi mất kết nối
    try { this.sessionVerifier.reset(); } catch (e) { dbg('BotSession', e); }
    try { this.autoLogin?.reset(); } catch (e) { dbg('BotSession', e); }
    try { this.statsReader?.reset(); } catch (e) { dbg('BotSession', e); }
    this._clearAllTimers();
    this._featuresActive = false;
    this._autoSellArmed = false;
    this._spawnerBusy = false;
    this._sellSpawnAbort = true; // vòng auto-sell spawn đang chạy (nếu có) sẽ tự thoát và tự trả cờ busy
    this.packetMgr.detach();
    this.packetFilter.detach();
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
    // Huỷ kết nối = trả slot đồng thời (nếu còn giữ). Phải làm TRƯỚC dòng return: mc có thể còn null (đang chờ proxy)
    // hoặc listener 'end' đã bị gỡ bên dưới, khi đó không còn ai trả slot -> _activeConnects kẹt, cả dàn bot không vào được nữa.
    this._onConnectComplete();
    if (!this.mc) return;
    const mc = this.mc;
    this.mc = null;
    const c = mc._client;
    try { this._tp.cancel(); this._clearTimer('tpSend'); } catch (e) { dbg('BotSession', e); } // bỏ theo dõi teleport dở dang (reconnect)
    try { this.packetMgr.detach(); } catch (e) { dbg('BotSession', e); }
    try { this.packetFilter.detach(); } catch (e) { dbg('BotSession', e); }
    // Gỡ listener để 'end'/'error' đến muộn không kích hoạt reconnect; giữ 1 handler 'error' rỗng để không văng uncaught.
    try { mc.removeAllListeners(); mc.on('error', () => { }); } catch (e) { dbg('BotSession', e); }
    try { if (c) { c.removeAllListeners(); c.on('error', () => { }); } } catch (e) { dbg('BotSession', e); }
    // PHẢI đóng socket thật. Bản cũ gán c.end = () => {} rồi mới gọi mc.end() nên socket cũ bị bỏ lại mở:
    // rò rỉ kết nối, server vẫn thấy bot online -> lần reconnect sau dễ bị "already logged in"/kick.
    try { if (c && !c.ended) c.end('cleanup'); } catch (e) { dbg('BotSession', e); }
    try { c?.socket?.destroy(); } catch (e) { dbg('BotSession', e); }
    try { c?.stream?.destroy?.(); } catch (e) { dbg('BotSession', e); }
    this._isCleanedUp = true;
  }
  scheduleReconnect(reason) { return this.reconnectHandler.schedule(reason); }
  cancelReconnect() { return this.reconnectHandler.cancel(); }
  _disableProxyFallback() { return this.reconnectHandler.disableProxyFallback(); }
  forceReconnect() { return this.reconnectHandler.force(); }
  async start() {
    if (this._shouldNotRun) return;
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
    this._resetStartupState();
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
        if (proxySocket) { try { proxySocket.destroy(); } catch (e) { dbg('BotSession', e); } proxySocket = null; }
        if (this._consecutiveProxyFails >= TIMING.PROXY_FAIL_THRESHOLD) {
          this._disableProxyFallback();
        }
      }
    }
    if (this._shouldNotRun) {
      if (proxySocket) { try { proxySocket.destroy(); } catch (e) { dbg('BotSession', e); } }
      this._onConnectComplete();
      this._setState(CS.DISCONNECTED);
      return;
    }
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
      if (proxySocket) { try { proxySocket.destroy(); } catch (e) { dbg('BotSession', e); } }
      this._onConnectComplete();
      this._setState(CS.DISCONNECTED);
      this.scheduleReconnect('createBot failed');
      return;
    }
    this.mc = mc;
    this.packetMgr.attach(mc);
    this.packetFilter.attach(mc);
    this._bindEvents(mc, proxy);
    this._bindSpawnerEvents(mc);
    try { mc.once('login', () => this._logVersionInfo(mc)); } catch (e) { dbg('BotSession', e); }
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
      if (cfg.sendClientSettings !== false && this._sendClientSettings(mc)) {
        this.log('sys', 'Đã gửi client settings (vanilla profile)');
      }
      if (this.autoLogin.enabled) {
        // AutoLoginFlow thay luồng /dn + menuRetry cũ: tự bắt tin yêu cầu đăng nhập / menu / antibot
        this._loginCmdDone = true;
        this.autoLogin.onConnected();
        this.log('sys', `AutoLogin BẬT — chờ server yêu cầu đăng nhập (${this.autoLogin.o.loginCommand}), antibot và vào server tự động`);
        return;
      }
      this._setTimer('loginCmd', () => {
        if (!this.isConnected) return;
        try {
          if (!cfg.botPassword) { this._loginCmdDone = true; this._continueAfterLogin(); return; }
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
                this._continueAfterLogin();
              } catch (e) {
                this.log('err', 'Lỗi gửi /dn: ' + e.message);
                this._loginCmdDone = true;
                this._continueAfterLogin();
              }
            }, rand(1500, 2500));
          } else {
            mc.chat(`/dn ${cfg.botPassword}`);
            this.log('ok', 'Đã gửi /dn');
            this._loginCmdDone = true;
            this._setTimer('loginDnDelay', () => {
              if (!this.isConnected) return;
              this._continueAfterLogin();
            }, rand(1500, 2500));
          }
        } catch (e) {
          this.log('err', 'Lỗi gửi auth cmd: ' + e.message);
        }
      }, rand(4000, 8000));
    });
    let _usedProxy = !!proxy;
    mc.on('spawn', () => {
      if (this.spawnerEspOn) this._startSpawnerEsp();
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
        // Không còn bật tính năng ngay lúc spawn: đi tuần tự đăng nhập -> menu -> đúng vị trí -> bật (xem _continueAfterLogin)
        if (!cfg.botPassword) this._loginCmdDone = true; // không có mật khẩu thì không có bước /dn để chờ
        this._continueAfterLogin();
      } else {
        this.log('sys', 'Đã hồi sinh (respawn)');
        this._resumeIntendedStates();
      }
    });
    mc.on('death', () => {
      const d = rand(2500, 8000);
      this.log('warn', `Chết — respawn sau ${d}ms`);
      this._setTimer('respawn', () => {
        if (this.isOnline) try { mc.respawn(); } catch (e) { dbg('BotSession', e); }
      }, d);
    });
    mc.on('ping', p => {
      s.ping = typeof p === 'number' ? p : -1;
      this.emit('ping', { id: cfg.id, ping: s.ping });
      this._emitIO('ping', { id: cfg.id, ping: s.ping });
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
      this._emitIO('health', { id: cfg.id, health: s.health, food: s.food });
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
          this._logHud(text, 'ActionBar');
          return;
        }
        // ── SessionCheck verify: xử lý trước, nhưng KHÔNG return — vẫn log chat bình thường ──
        this.sessionVerifier.onMessage(text, pos);
        this.autoLogin.onMessage(text);
        this.statsReader.onMessage(text);
        if (this._sellCap) this._captureSellRevenue(text, pos);
        if (this._macroSellCap) this._captureMacroSellRevenue(text, pos);
        if (this.autoOrder?.active) this.autoOrder.onMessage(text);
        this.log('chat', text);
        if (pos !== 'chat') this._tp.note(text, nowMs()); // tin hệ thống trong lúc chờ teleport (không tính chat người chơi)
        if (!this._loginConfirmed && this._isLoginSuccessText(text)) this._onLoginConfirmed();
        this.tryChatShard(text);
      } catch (e) {
        this.log('err', 'Lỗi message: ' + e.message);
      }
    });
    mc.on('messagestr', (msg, pos) => {
      try { if (pos === 'gameInfo') this.tryChatShard(msg); } catch (e) { dbg('BotSession', e); }
    });
    // Title / subtitle: nhiều server báo "Teleport bị hủy / Đừng di chuyển" bằng title chứ không phải chat
    mc.on('title', (text, type) => {
      try {
        const t = typeof text === 'string' ? text : resolveText(text?.json ?? text);
        this._logHud(t, type === 'subtitle' ? 'Subtitle' : 'Title');
      } catch (e) { dbg('BotSession', e); }
    });
    mc.on('scoreboardUpdated', () => {
      try {
        this._updateShard(this.readShard());
        const board = this.readBoard();
        const money = this._extractBoardStat(board, ['MONEY', 'TIỀN', 'TIEN', 'XU', 'COIN']);
        if (money !== null) this._updateMoney(money);
      } catch (e) { dbg('BotSession', e); }
    });
    mc.on('windowOpen', win => {
      if (this.statsReader.handleWindow(win)) return; // đang chờ GUI /stats <người chơi> — không để WindowRouter/StatsParser ghi đè shard của chính bot
      if (this.autoLogin?.ownsWindows()) return; // AutoLoginFlow đang tự click menu/antibot — không cho WindowRouter/SessionVerifier đè
      if (this._spawnerBusy || this._sellSpawnBusy || this.autoOrder?.active) return; // routine bảo vệ lồng / auto-sell spawn đang tự điều khiển GUI
      if (this.scriptRunner?._running) {
        // Macro đang chạy (winclick) — không để WindowRouter tự động
        // click/đóng GUI đè lên, nhường toàn quyền điều khiển cho macro.
        this.log('sys', `Macro đang điều khiển GUI [${resolveText(win.title || '').substring(0, 40)}] — bỏ qua auto-xử lý`);
        return;
      }
      this._setTimer('winOpen_' + win.id, () => {
        if (!this.isOnline) return;
        try {
          // ── SessionCheck verify: kiểm tra GUI captcha trước WindowRouter ──
          if (this.sessionVerifier.onWindowOpen(win)) return;
          const title = resolveText(win.title || '').toUpperCase();
          if (cfg.autoMenu && cfg.menuCommand && !this._menuSuccess) {
            if (title.includes('MENU') || title.includes('LOBBY') || title.includes('HUB') ||
                title.includes('CHỌN') || title.includes('KHU') || title.includes('WORLD')) {
              // KHÔNG đặt _menuSuccess ở đây: WindowRouter._handleUnknown chỉ click ô vào server khi _menuSuccess còn false
              // (bước menu). Đặt trước khi route thì GUI bị ĐÓNG mà không click => bot kẹt ở sảnh, phải gõ tay "menu".
              // _menuSuccess + _onMenuDone sẽ do _handleUnknown đặt sau khi click; menuRetry vẫn chạy để mở lại menu nếu chưa click được.
              this.log('ok', `Đã mở GUI menu: [${title.substring(0, 40)}] — click ô vào server`);
              const routed = WindowRouter.route(this, win);
              if (routed && !this._menuSuccess) this._onMenuDone(`GUI [${title.substring(0, 30)}]`); // route đăng ký sẵn đã xử lý
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
        try { m = JSON.stringify(reason).substring(0, 400); } catch { m = String(reason).substring(0, 200); }
      }
      const kickMsg = m || '(không rõ lý do)';
      this.log('warn', 'Bị kick: ' + kickMsg);
      // ── SessionCheck: detect connection-level block, set delay override ──
      this.sessionVerifier.onKick(kickMsg);
      this._onKickedDuringSell(kickMsg);
      this._queueKickNotify(kickMsg);
      this.emit('kicked', { id: this.cfg.id, reason: kickMsg, raw: reason });
      this._emitIO('kicked', { id: this.cfg.id, reason: kickMsg });
    });
    mc.once('end', reason => {
      this._onConnectComplete();
      const m = parseReasonText(reason);
      const endReason = m || 'connection ended';
      this.emit('disconnected', { id: this.cfg.id, reason: endReason });
      this._emitIO('botDisconnected', { id: this.cfg.id, reason: endReason });
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
      if (this.packetFilter.handleError(err)) return; // lỗi parse gói tin: gộp + chẩn đoán, không coi là lỗi kết nối
      if (IGNORED_ERRORS.some(k => m.includes(k))) return;
      this.log('err', m);
      this.emit('botError', { id: this.cfg.id, error: m });
    });
  }
  // Gửi client settings bằng API của mineflayer (tự dùng đúng tên trường theo từng phiên bản MC:
  // chatFlags/skinParts/enableServerListing/particleStatus...). Bản cũ ghi tay chatMode/displayedSkinParts/
  // allowServerListings -> sai tên trường nên bị gửi toàn số 0. cfg.clientSettings (nếu có) vẫn được ghi nguyên văn.
  // Dựng gói `settings` theo ĐÚNG tên trường của phiên bản đang dùng (đọc từ minecraft-data), điền giá trị theo ý nghĩa.
  // profile 'vanilla' (mặc định) = như client thật (skinParts=127, serverListing=true).
  // profile 'legacy' = byte mà fix2 gửi (skinParts=0, serverListing=false). Đã kiểm chứng: KHÔNG liên quan tới lỗi kick autosell.
  _buildSettingsPacket(mc) {
    const t = mc?.registry?.protocol?.play?.toServer?.types?.packet_settings;
    if (!Array.isArray(t) || t[0] !== 'container' || !Array.isArray(t[1])) return null;
    const vd = Number(this.cfg.viewDistance);
    const vanilla = this.cfg.settingsProfile !== 'legacy';
    const val = {
      locale: 'en_US',
      viewDistance: Number.isFinite(vd) && vd > 0 ? vd : 2,
      chatFlags: 0, chatMode: 0,
      chatColors: true, colorsEnabled: true,
      skinParts: vanilla ? 127 : 0, displayedSkinParts: vanilla ? 127 : 0,
      mainHand: 1,
      enableTextFiltering: false,
      enableServerListing: vanilla, allowServerListings: vanilla,
      particleStatus: 0,
    };
    const pkt = {};
    for (const f of t[1]) {
      if (!f || !f.name) continue;
      pkt[f.name] = f.name in val ? val[f.name] : (/bool|flag/i.test(JSON.stringify(f.type)) ? false : 0);
    }
    return pkt;
  }
  _sendClientSettings(mc) {
    const client = mc?._client;
    if (!client || client.ended) return false;
    try {
      const cs = this.cfg.clientSettings;
      if (cs && typeof cs === 'object') { client.write('settings', cs); return true; }
      const pkt = this._buildSettingsPacket(mc);
      if (pkt) { client.write('settings', pkt); return true; }
      if (typeof mc.setSettings === 'function') {   // không đọc được định nghĩa gói -> để mineflayer tự gửi
        const vd = Number(this.cfg.viewDistance);
        mc.setSettings({ chat: 'enabled', colorsEnabled: true, viewDistance: Number.isFinite(vd) && vd > 0 ? vd : 2, mainHand: 'right', enableTextFiltering: false, enableServerListing: this.cfg.settingsProfile !== 'legacy' });
        return true;
      }
      return false;
    } catch (e) {
      this.log('err', 'Lỗi settings: ' + e.message);
      return false;
    }
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
              // gửi lại client settings: gói hợp lệ, nhẹ, không bắt server trả về danh sách lớn
              this._sendClientSettings(mc);
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
    // spawnerprotect / autosell_spawn / autosell macro KHÔNG bật ở đây: chúng chỉ được bật 1 lần ở
    // _activateGatedFeatures() sau khi đã đăng nhập + vào menu + đứng đúng cạnh lồng. Ở đây (vd sau khi chết/hồi sinh)
    // chỉ dựng lại những timer đã mất nếu các tính năng đó đã được bật rồi.
    if (this._featuresActive) {
      if (this._spawnerProtectOn && !this._timers.has('spawnerProtect') && this.protectedSpawners.length) this._startSpawnerProtect();
      if (this._sellSpawnOn && !this._timers.has('sellSpawn') && !this._sellSpawnBusy) this._startSellSpawn(true);
    }
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
  // Ghi nhận 1 tin "bán được" vào cap (dùng chung cho auto-sell spawn và auto-sell macro)
  // `... revenue every <thời gian>|off` -> số phút, 'off' (hoặc 0) = gửi mỗi lần, null = sai cú pháp
  _parseEveryMinutes(args) {
    const v = String(args[2] || '').toLowerCase();
    if (v === 'off' || v === '0') return 'off';
    const d = this._parseDuration(args.slice(2).join(' '));
    return d ? d.hour * 60 + d.minute + d.second / 60 : null;
  }
  // Hành vi "nhiễu" chung của cả jump-AFK và walk-AFK
  _afkNoise(mc) {
    // tab_complete "/" khiến server trả về TOÀN BỘ danh sách lệnh (hàng trăm mục + tooltip): tốn băng thông/CPU
    // và là thủ phạm hay gặp của lỗi "array size is abnormally large". Mặc định TẮT; bật bằng cfg.afkTabNoise=true.
    if (this.cfg.afkTabNoise === true && Math.random() < 0.02 && mc._client && !mc._client.ended) {
      try {
        const legacy = mc.registry?.isOlderThan?.('1.13');
        mc._client.write('tab_complete', legacy
          ? { text: '/', assumeCommand: false, lookedAtBlock: undefined }
          : { transactionId: rand(1, 65535), text: '/' });
      } catch (e) { dbg('BotSession', e); }
    }
    if (Math.random() < 0.03) {
      try { mc.setQuickBarSlot(rand(0, 8)); } catch (e) { dbg('BotSession', e); }
    }
  }
  _captureRevenueInto(cap, text, pos, { pattern, keyword, ignoreChat, label, keepLines }) {
    const amount = this._extractSellAmount(text, pattern);
    if (amount === null) return;
    const isPlayerChat = pos === 'chat';
    if ((ignoreChat && isPlayerChat) || !this._sellMsgMatchesKeyword(text, keyword)) {
      cap.ignoredCount++;
      if (cap.ignored.length < 3) cap.ignored.push(`${isPlayerChat ? '[chat] ' : ''}${text.substring(0, 90)}`);
      return;
    }
    cap.sum += amount;
    cap.hits++;
    if (keepLines && cap.lines.length < 40) cap.lines.push(text.substring(0, 90));
    this.log('sys', `${label}: +${RevenueTracker.formatMoney(amount)} ← "${text.substring(0, 80)}"`);
  }
  _captureSellRevenue(text, pos) {
    const cap = this._sellCap;
    if (!cap) return;
    this._captureRevenueInto(cap, text, pos, { ignoreChat: this.autoSellSpawnIgnoreChat, label: 'Doanh thu', keepLines: true });
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
    this.log('ok', `Doanh thu vòng này: ${fmt(cap.sum)} (${cap.hits} tin / ${cap.done}/${cap.total} lồng)`);
    if (quiet) return cap;
    try { this._manager?.onSellCycle?.(this); } catch { /* Telegram lỗi không được làm hỏng vòng bán */ }
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
  // Embed báo cáo doanh thu — bố cục: [Người chơi | Server | Thời gian treo] / [Tổng thu nhập | Tốc độ trung bình | Số lượt bán] / Trạng thái
  _buildRevenueEmbed(cap, kind = 'spawn') {
    const macro = kind === 'macro';
    const money = RevenueTracker.formatMoneyDollar; // $41.35K, $4.45M
    const s = macro ? this.getMacroRevenueStats() : this.getRevenueStats();
    const noRate = !s || s.avgPerHour == null;
    const up = this._rev.uptime(this.cfg.id); // thời gian online cộng dồn (cùng nguồn với bảng Telegram)
    // Trạng thái: dòng đầu = bot đang chạy hay không; các dòng sau = vòng vừa xong (giữ cảnh báo lồng lỗi) / ghi chú
    const status = [this.isOnline ? 'Đang hoạt động' : 'Ngoại tuyến'];
    if (cap) {
      if (macro) {
        status.push(`Lần bán vừa xong: +${money(cap.sum)} · macro "${cap.macro}"${cap.viaBalance ? ' (đo theo số dư)' : ''}`);
      } else {
        const total = cap.total || cap.done;
        const fail = Math.max(0, total - cap.done);
        status.push(`Vòng vừa xong: +${money(cap.sum)} (${cap.done}/${total} lồng)`);
        if (fail) status.push(`⚠️ ${fail} lồng lỗi`);
      }
    }
    if (noRate) status.push('Cần ≥2 vòng bán liên tiếp để tính tốc độ');
    else if (s.observedMs < 3600000) status.push(`Tốc độ là ước tính — mới đo ${this._fmtDuration(s.observedMs)}`);
    return Notifier.finish({
      title: macro ? 'Báo Cáo Tổng Kết Auto-Sell (Macro)' : 'Báo Cáo Tổng Kết Auto-Sell Spawn',
      color: Notifier.COLOR.report,
      fields: [
        { name: 'Người chơi', value: this._playerLabel(), inline: true },
        { name: 'Server', value: this._serverLabel(), inline: true },
        { name: 'Thời gian treo', value: RevenueTracker.formatClock(up.totalMs), inline: true },
        { name: 'Tổng thu nhập', value: money(s ? s.total : 0), inline: true },
        { name: 'Tốc độ trung bình', value: noRate ? '—' : `${money(s.avgPerHour)}/h`, inline: true },
        { name: 'Số lượt bán', value: String(s ? s.cycles : 0), inline: true },
        { name: 'Trạng thái', value: status.join('\n'), inline: false },
      ],
      thumbnail: this._headThumb(),
      timestamp: new Date().toISOString(),
    });
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
    try { this._manager?.askRevenueWebhook?.(this.cfg.id); } catch (e) { dbg('BotSession', e); }
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
    this._captureRevenueInto(cap, text, pos, { pattern: this.autoSellMsgPattern, keyword: this.autoSellMsgKeyword, ignoreChat: this.autoSellIgnoreChat, label: 'Doanh thu auto-sell' });
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
    // Bật là chỉnh góc nhìn về lồng NGAY (chưa bán). Vòng bán đầu tiên chạy sau đó vài giây và còn xoay lại + kiểm tra tia ngắm trước khi chuột phải từng lồng.
    this._alignViewToSellSpawn(this.mc).catch(e => this.log('warn', 'Auto-sell Spawn: chỉnh góc nhìn lỗi: ' + e.message));
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
  // Bị kick ĐÚNG LÚC đang chuột phải/click lồng (vòng bán đang chạy) 2 lần liên tiếp => gần như chắc chắn chính thao tác đó làm
  // server (hoặc proxy) văng bot (vd gói block_place không khớp phiên bản). Tự TẮT autosell_spawn để khỏi kick lặp vô hạn / bị ban.
  _onKickedDuringSell(kickMsg) {
    if (!this._sellSpawnOn || !this._sellSpawnBusy) return;
    this._sellKickStrikes = (this._sellKickStrikes || 0) + 1;
    this.log('warn', `Bị kick khi đang chạy vòng auto-sell spawn (lần ${this._sellKickStrikes}/2): "${String(kickMsg).substring(0, 80)}"`);
    try { this.log('sys', 'Gói bot gửi ngay trước khi bị kick: ' + this.packetMgr.recentOut(8).join(' | ')); } catch (e) { dbg('BotSession', e); }
    if (this._sellKickStrikes >= 2) {
      this._sellKickStrikes = 0;
      this._stopSellSpawn();
      this.log('err', 'autosell_spawn bị kick 2 lần liên tiếp ngay lúc chuột phải lồng → đã tự TẮT. Nguyên nhân hay gặp nhất: bot đang nói giao thức KHÁC bản server thật (proxy Velocity dịch phiên bản làm hỏng gói chuột phải). Xem dòng \"Giao thức\" lúc kết nối; đặt \"version\" của bot đúng bản bạn dùng để chơi thật (vd \"1.21.11\") trong config.json rồi khởi động lại; bật lại bằng: autosell_spawn on');
    }
  }
  // Ghi rõ bot đang nói chuyện bằng giao thức nào + server tự báo phiên bản gì (lệch phiên bản là nguyên nhân hay gặp của lỗi parse/kick lạ)
  _logVersionInfo(mc) {
    try {
      let mfv = '?', mpv = '?';
      try { mfv = require('mineflayer/package.json').version; } catch (e) { dbg('BotSession', e); }
      try { mpv = require('minecraft-protocol/package.json').version; } catch (e) { dbg('BotSession', e); }
      let bp = null;
      try {
        const t = mc.registry?.protocol?.play?.toServer?.types?.packet_block_place;
        if (Array.isArray(t) && t[0] === 'container') bp = t[1].map(f => f.name).join(',');
      } catch (e) { dbg('BotSession', e); }
      this.log('sys', `Giao thức: bot dùng MC ${mc.version || '?'} (protocol ${mc.protocolVersion ?? mc.registry?.version?.version ?? '?'}), config version=${this.cfg.version ? `"${this.cfg.version}"` : 'tự dò'} | mineflayer ${mfv}, minecraft-protocol ${mpv}${bp ? ` | block_place: ${bp}` : ''}`);
    } catch (e) { dbg('BotSession', e); }
    if (this._pingLogged || this.proxy) return;
    if (!(this.cfg.pingServerInfo === true || (!this.cfg.version && this.cfg.pingServerInfo !== false))) return; // mặc định chỉ ping khi version để tự dò
    this._pingLogged = true;
    try {
      const mp = require('minecraft-protocol');
      mp.ping({ host: this.cfg.host, port: this.cfg.port }, (err, r) => {
        if (err || !r) return;
        const v = r.version || {};
        this.log('sys', `Server tự báo: "${String(v.name || '?').substring(0, 60)}" (protocol ${v.protocol ?? '?'}) — nếu protocol này khác protocol bot đang dùng thì server đang dịch phiên bản (ViaVersion/proxy); khi đó nên đặt "version" của bot đúng bản server gốc hoặc cập nhật thư viện`);
      });
    } catch (e) { dbg('BotSession', e); }
  }
  async _sellSpawnTick() {
    if (!this._sellSpawnOn || !this.isOnline) return;
    // đang bận việc khác (bảo vệ lồng / macro / vòng trước) -> hẹn lại vài giây sau
    // (_posLost: đang lệch khỏi chỗ treo lồng, đang chờ /home — không bán lúc này kẻo spam "quá xa/chunk chưa tải")
    if (this._isBusy || this._posLost) { this._scheduleSellSpawn(5000); return; }
    const t0 = nowMs();
    try { await this._runSellWithRecovery(); }
    catch (e) { this.log('err', 'Auto-sell Spawn lỗi: ' + e.message); }
    this._scheduleSellSpawn(this._sellSpawnIntervalMs() - (nowMs() - t0));
  }
  runSellSpawnNow() {
    if (!this.isOnline) { this.log('warn', 'Auto-sell Spawn: bot offline'); return false; }
    if (this._sellSpawnBusy || this._sellRecovering) { this.log('warn', 'Auto-sell Spawn: đang chạy một vòng rồi'); return false; }
    if (this._spawnerBusy || this.scriptRunner.running) { this.log('warn', 'Auto-sell Spawn: bot đang bận (bảo vệ lồng/macro) — thử lại sau'); return false; }
    this._runSellWithRecovery().catch(e => this.log('err', 'Auto-sell Spawn lỗi: ' + e.message));
    return true;
  }
  // Trạng thái cơ thể của bot: tư thế (đứng / ngồi=shift / bò / bơi...), đang nhảy-rơi, đang trượt, server đã cập nhật tư thế chưa.
  // Tư thế lấy từ SERVER (metadata) rồi mới tới phím shift / hình dạng khe quanh đầu — xem MotionUtil. null = chưa có vị trí.
  _bodyState(mc) {
    const e = mc?.entity;
    if (!e?.position) return null;
    let sneak = false;
    try { sneak = !!mc.getControlState?.('sneak'); } catch (e) { dbg('BotSession', e); }
    let st = null;
    try {
      const ver = mc.version || mc.registry?.version?.minecraftVersion || this.cfg.version;
      st = resolvePlayerPose({ entity: e, sneak, hasPoseMeta: supportsPoseMeta(ver), getBlock: q => mc.blockAt(this._vec(q)) });
    } catch (e) { dbg('BotSession', e); }
    if (!st) st = { key: 'standing', label: 'đứng', eye: typeof e.eyeHeight === 'number' ? e.eyeHeight : EYE_STAND, source: 'assumed', headroom: null, settled: true, why: null };
    this._lastBody = st;
    return st;
  }
  // Mắt bot (toạ độ thế giới) — độ cao mắt theo TƯ THẾ THẬT của bot (đứng 1.62 / ngồi 1.27 / bò 0.4). Lồng treo sát bedrock: server ép bot
  // ngồi/bò nhưng mineflayer vẫn có thể báo 1.62 -> mắt lọt vào khối đặc trên đầu, tia ngắm luôn "bị bedrock che".
  _eyePos(mc) {
    const p = mc.entity.position;
    const st = this._bodyState(mc);
    return { x: p.x, y: p.y + (st ? st.eye : EYE_STAND), z: p.z };
  }
  // Chờ cơ thể ổn định trước khi tính góc nhìn: đang nhảy/rơi (chân sắp đổi độ cao), đang trượt sau khi thả phím đi,
  // hoặc vừa đổi shift mà server chưa cập nhật tư thế (đứng <-> ngồi) — tính lúc đó là lệch, về tới lồng thì nhìn trượt.
  // Chờ tối đa ~1.2s (tư thế: ~0.7s) rồi tính tiếp bằng trạng thái hiện có. Đã ổn định thì trả về ngay, không sleep.
  async _settleBody(mc, { stop = null } = {}) {
    const t0 = nowMs();
    let st = this._bodyState(mc);
    while (st && !st.settled) {
      const limit = st.why === 'pose' ? 700 : 1200;
      if (nowMs() - t0 >= limit) break;
      if ((stop && stop()) || !this.isOnline || this.mc !== mc || !mc.entity?.position) break;
      await sleep(80);
      st = this._bodyState(mc);
    }
    return st;
  }
  // Tia ngắm HIỆN TẠI (yaw/pitch của bot) có tới được block p không? Chỉ khối đặc nguyên khối mới che tia —
  // block nửa khối/nhỏ (chồi thạch anh tím, nến, thảm, rào, bậc thang...) tia đi xuyên qua (xem VectorUtil.js).
  _aimCheckBlock(mc, p, reach = SELL.SPAWN_REACH) {
    const e = mc?.entity;
    if (!e?.position || !Number.isFinite(e.yaw) || !Number.isFinite(e.pitch)) return { hit: false };
    return aimCheck({ eye: this._eyePos(mc), yaw: e.yaw, pitch: e.pitch, target: p, maxDist: reach + 1, getBlock: q => mc.blockAt(this._vec(q)) });
  }
  _aimWhy() {
    const b = this._lastAim?.blocker;
    const st = this._lastAim?.pose;
    const parts = [];
    if (b) parts.push(`bị ${b.name} (${b.x},${b.y},${b.z}) che`);
    if (st) parts.push(`tư thế ${describePose(st)}`);
    return parts.length ? ` — ${parts.join(', ')}` : '';
  }
  // Giữ nguyên góc nhìn: AFK không được xoay đầu/đi/nhảy trong `ms` tới. (Lỗi cũ: AFK walk/jump gọi look() ngẫu nhiên mỗi ~0.5–5s,
  // đè lên góc nhìn vừa chỉnh về lồng ngay trước lúc chuột phải/đào nên "góc nhìn không đổi".)
  _holdView(ms) { this._viewLockUntil = Math.max(this._viewLockUntil || 0, nowMs() + ms); }
  _afkPaused(now = nowMs()) {
    return this._tp.frozen(now) || this._sellSpawnBusy || this._sellRecovering || this._spawnerBusy || now < (this._viewLockUntil || 0);
  }
  // Thả các phím AFK đang giữ (đi/nhảy) để bot đứng im khi cần nhắm
  _releaseAfkKeys() {
    for (const k of ['afkJumpOff', 'wafkKey', 'wafkJump']) this._clearTimer(k);
    try { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) this.mc?.setControlState(k, false); } catch (e) { dbg('BotSession', e); }
    // AFK đang giữ shift (nhả sau 0.3-0.9s): nhả luôn — để nó tự nhả GIỮA lúc nhắm thì tư thế đổi, mắt đổi độ cao, góc nhìn lệch.
    // Không đụng tới shift có chủ đích của routine đập lồng (_spawnerBusy).
    if (this._timers.has('afkSneak')) {
      this._clearTimer('afkSneak');
      if (!this._spawnerBusy) { try { this.mc?.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); } }
    }
  }
  // Xoay đầu nhìn thẳng vào tâm block p rồi KIỂM TRA tia ngắm tới được block đó (bỏ qua block nửa khối); lệch/bị đè thì xoay lại, tối đa `tries` lần.
  // true = tia ngắm tới block. false = đã xoay nhưng bị khối đặc che / ngoài tầm (người gọi vẫn quyết định có làm tiếp hay không).
  async _faceBlock(mc, p, { reach = SELL.SPAWN_REACH, tries = 3, stop = null, holdMs = 4000 } = {}) {
    this._holdView(holdMs + 2000);
    this._releaseAfkKeys();
    this._lastAim = null;
    await this._settleBody(mc, { stop }); // đứng yên + biết đúng tư thế (đứng/ngồi/bò) rồi mới tính góc
    for (let i = 0; i < tries; i++) {
      if ((stop && stop()) || !this.isOnline || this.mc !== mc || !mc.entity?.position) return false;
      const a = anglesTo(this._eyePos(mc), { x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 });
      try { await this._withTimeout(mc.look(a.yaw, a.pitch, true), 1500); } catch (e) { dbg('BotSession', e); } // có timeout: look() chỉ xong khi gói xoay đã gửi
      await sleep(jit(250, 80)); // chờ gói xoay đầu tới server trước khi click/đào
      const r = this._aimCheckBlock(mc, p, reach);
      r.pose = this._lastBody || null; // tư thế lúc kiểm tra (để log chẩn đoán khi trượt)
      this._lastAim = r;
      if (r.hit) { this._holdView(holdMs); return true; }
      if (i < tries - 1) await this._settleBody(mc, { stop }); // trượt: có thể tư thế vừa đổi giữa chừng -> chờ ổn định rồi tính lại
    }
    return false;
  }
  // Lúc BẬT autosell_spawn: xoay đầu về lồng đầu tiên trong tầm (AFK/teleport có thể đã xoay bot đi hướng khác) rồi mới tới vòng bán.
  async _alignViewToSellSpawn(mc) {
    if (!this.isOnline || !mc?.entity?.position) return false;
    // vừa teleport xong: đợi hết thời gian đứng yên (tối đa 10s) rồi mới xoay — trước đây bỏ qua âm thầm nên bật xong góc nhìn không đổi
    for (let w = 0; w < 20 && this._tp.frozen(nowMs()); w++) {
      await sleep(500);
      if (!this.isOnline || this.mc !== mc) return false;
    }
    if (this._tp.frozen(nowMs())) { this.log('warn', 'Auto-sell Spawn: bot vẫn đang chờ teleport — chưa chỉnh được góc nhìn (vòng bán sẽ tự nhìn lồng trước khi chuột phải)'); return false; }
    if (this._isBusy) { this.log('sys', 'Auto-sell Spawn: bot đang bận việc khác — vòng bán sẽ tự nhìn lồng trước khi chuột phải'); return false; }
    await this._settleBody(mc); // đang nhảy/trượt/vừa đổi shift: chờ ổn định để độ cao mắt đúng
    const eye = this._eyePos(mc);
    const p = this.sellSpawnList.find(q => Math.hypot(eye.x - (q.x + 0.5), eye.y - (q.y + 0.5), eye.z - (q.z + 0.5)) <= SELL.SPAWN_REACH);
    if (!p) { this.log('warn', `Auto-sell Spawn: chưa có lồng nào trong tầm để chỉnh góc nhìn — ${describePose(this._lastBody)}`); return false; }
    const ok = await this._faceBlock(mc, p);
    this.log(ok ? 'sys' : 'warn', `Auto-sell Spawn: ${ok ? `đã chỉnh góc nhìn về lồng — tư thế ${describePose(this._lastBody)}` : `đã xoay về lồng nhưng tia ngắm chưa tới${this._aimWhy()}`} (${p.x},${p.y},${p.z})`);
    return ok;
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
    const none = { done: 0, total: 0, ok: false, aborted: false, skipped: true, reasons: [] };
    if (!this.isOnline || !mc?.entity?.position || this._sellSpawnBusy) return none;
    const list = this.sellSpawnList.slice();
    if (!list.length) { this.log('warn', 'Auto-sell Spawn: danh sách lồng trống'); return none; }
    this._sellSpawnBusy = true;
    this._sellSpawnAbort = false;
    this._releaseAfkKeys(); // AFK walk đang giữ phím đi thì thả ra: đứng im rồi mới nhắm lồng
    if (this.autoSellSpawnRevenue) this._beginSellCapture(list.length);
    const stop = () => this._sellSpawnAbort || !this.isOnline || this.mc !== mc;
    let wasSneak = false;
    try { wasSneak = !!mc.getControlState?.('sneak'); if (wasSneak) mc.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); } // đang shift thì chuột phải không mở được GUI
    let done = 0, aborted = false;
    const reasons = [];
    this.log('sys', `Auto-sell Spawn: bắt đầu vòng bán (${list.length} lồng)`);
    try {
      for (let i = 0; i < list.length; i++) {
        if (stop()) { this.log('warn', 'Auto-sell Spawn: bị ngắt giữa chừng (bảo vệ lồng/macro/tắt/mất kết nối)'); break; }
        let ok = false;
        this._sellWhy = '';
        try { ok = await this._sellOneSpawn(mc, list[i], `${i + 1}/${list.length}`, stop); }
        catch (e) { this._sellWhy = `lỗi: ${e.message}`; this.log('err', `Auto-sell Spawn [${i + 1}/${list.length}] lỗi: ${e.message}`); }
        if (ok) done++;
        else if (!stop()) reasons.push(`(${list[i].x},${list[i].y},${list[i].z}) ${this._sellWhy || 'không rõ lý do'}`);
        if (i < list.length - 1 && !stop()) await sleep(jit(900, 300));
      }
      aborted = stop();
    } finally {
      try { if (this.mc === mc && mc.currentWindow) mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); }
      try { if (wasSneak && this.mc === mc) mc.setControlState('sneak', true); } catch (e) { dbg('BotSession', e); }
      this._sellSpawnBusy = false;
    }
    this.log(done === list.length ? 'ok' : 'warn', `Auto-sell Spawn: xong ${done}/${list.length} lồng${this._sellSpawnOn ? ` — vòng kế tiếp sau ~${this._fmtDuration(this._sellSpawnIntervalMs())}` : ''}`);
    if (this._sellCap) { this._sellCap.done = done; this._setTimer('sellRevFinalize', () => this._finalizeSellRevenue(false), 4000); } // chờ 4s cho tin "bán được" của lồng cuối kịp về
    return { done, total: list.length, ok: !aborted && done === list.length, aborted, skipped: false, reasons };
  }
  _sellFail(tag, at, msg) {
    this._sellWhy = msg;
    this.log('warn', `Auto-sell Spawn [${tag}] ${at}: ${msg}`);
    return false;
  }
  // 1 lồng: chuột phải mở GUI -> click slot -> đóng GUI. Trả về true nếu đã click được.
  async _sellOneSpawn(mc, p, tag, stop) {
    const block = mc.blockAt(this._vec(p));
    const at = `(${p.x},${p.y},${p.z})`;
    if (!block) return this._sellFail(tag, at, 'chunk chưa tải — bỏ qua');
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return this._sellFail(tag, at, 'không có block ở đây — bỏ qua');
    const eye = this._eyePos(mc);
    const dist = Math.hypot(eye.x - (p.x + 0.5), eye.y - (p.y + 0.5), eye.z - (p.z + 0.5));
    if (dist > SELL.SPAWN_REACH) return this._sellFail(tag, at, `quá xa (${dist.toFixed(1)} block) — bot không tự di chuyển, bỏ qua`);
    if (mc.currentWindow) { try { mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); } await sleep(300); }
    // nhìn thẳng vào lồng + kiểm tra tia ngắm tới lồng (bỏ qua block nửa khối) rồi MỚI chuột phải
    let aimed = await this._faceBlock(mc, p, { stop });
    if (stop()) return false;
    if (aimed && !this._aimCheckBlock(mc, p).hit) aimed = await this._faceBlock(mc, p, { stop }); // góc nhìn bị đổi sát lúc click -> nhắm lại
    if (stop()) return false;
    if (!aimed) this.log('warn', `Auto-sell Spawn [${tag}] ${at}: tia ngắm chưa trúng lồng${this._aimWhy()} — vẫn thử chuột phải`);
    // Chuột phải tối đa SELL.GUI_CLICKS lần: lần đầu GUI không mở thì nhắm lại + chuột phải thêm 1 lần TRƯỚC khi báo lỗi
    // (báo lỗi = cả chuỗi gõ /home rồi bán lại, tốn ~15s mỗi lần).
    let win = null, waited = 0;
    for (let attempt = 1; attempt <= SELL.GUI_CLICKS && !win; attempt++) {
      const waitMs = attempt < SELL.GUI_CLICKS ? SELL.GUI_FIRST_WAIT_MS : SELL.GUI_LAST_WAIT_MS;
      // đăng ký chờ GUI TRƯỚC khi click để không lỡ sự kiện windowOpen
      const winP = this._waitWindowOpen(mc, waitMs);
      try { await this._withTimeout(mc.activateBlock(block), 2500); }
      catch (e) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: click chuột phải lỗi: ${e.message}`); }
      win = await winP;
      waited += waitMs;
      if (!win && this.mc === mc && mc.currentWindow) win = mc.currentWindow; // GUI mở trễ đúng lúc hết giờ chờ
      if (win || stop()) break;
      if (attempt < SELL.GUI_CLICKS) {
        this.log('warn', `Auto-sell Spawn [${tag}] ${at}: GUI chưa mở sau ${(waitMs / 1000).toFixed(1)}s — nhắm lại rồi chuột phải lần ${attempt + 1}/${SELL.GUI_CLICKS}`);
        await this._faceBlock(mc, p, { stop });
        if (stop()) return false;
      }
    }
    if (!win) {
      if (stop()) return false; // vòng thuộc kết nối cũ (đã mất kết nối/bị ngắt) — không báo lỗi giả
      return this._sellFail(tag, at, `GUI không mở sau ${(waited / 1000).toFixed(0)}s`);
    }
    try {
      await sleep(jit(650, 150)); // đợi server gửi đủ ô đồ
      const slot = this.autoSellSpawnSlot;
      const start = win.inventoryStart ?? Math.max(0, win.slots.length - 36);
      if (slot >= start) return this._sellFail(tag, at, `GUI chỉ có ${start} ô — slot ${slot} nằm ngoài GUI (là túi đồ của bot), KHÔNG click. Kiểm tra lại số slot`);
      let it = win.slots[slot];
      for (let k = 0; !it && k < 3; k++) { await sleep(500); it = win.slots[slot]; }
      if (!it) return this._sellFail(tag, at, `ô ${slot} trống — không click`);
      if (stop()) return false;
      const name = resolveText(it.customName || it.displayName || it.name || '').substring(0, 40);
      const title = resolveText(win.title || '').substring(0, 30);
      this.log('sys', `Auto-sell Spawn [${tag}] ${at}: GUI [${title}] — click ô ${slot} "${name}"`);
      try { await this._withTimeout(mc.clickWindow(slot, this.autoSellSpawnButton, 0), 3000); }
      catch (e) { this.log('warn', `Auto-sell Spawn [${tag}] ${at}: click ô ${slot} lỗi: ${e.message}`); }
      await sleep(jit(700, 200));
      this._sellKickStrikes = 0; // click xong mà không bị kick => cơ chế chuột phải ổn
      return true;
    } finally {
      try { const cur = this.mc === mc ? mc.currentWindow : null; if (cur) mc.closeWindow(cur); } catch (e) { dbg('BotSession', e); }
      await sleep(jit(350, 100));
    }
  }
  // ===== Bán lỗi -> /home treolong -> bán lại (tối đa sellFailMaxHome lần) -> vẫn lỗi thì báo webhook + tag =====
  _sellHomeCmd() {
    const c = String(this.spawnHomeCommand || '/home treolong').trim() || '/home treolong';
    return c.startsWith('/') ? c : `/${c}`;
  }
  async _runSellWithRecovery() {
    const mc = this.mc;
    this._sellRecovering = true; // giữ cờ bận suốt chuỗi: không cho canh-vị-trí tự gõ /home chen vào, AFK đứng yên
    try {
      let res = await this._runSellSpawnCycle();
      if (res.ok || res.aborted || res.skipped) return res;
      const max = this.sellFailMaxHome;
      if (!(max > 0)) return res;
      const cmd = this._sellHomeCmd();
      const stopRec = () => !this.isOnline || this.mc !== mc || this._spawnerBusy || this._sellSpawnAbort;
      for (let n = 1; n <= max; n++) {
        if (stopRec()) { this.log('warn', 'Auto-sell Spawn: ngắt chuỗi thử lại (bảo vệ lồng/tắt/mất kết nối)'); return { ...res, aborted: true }; }
        this.log('warn', `Auto-sell Spawn: bán chưa xong (${res.done}/${res.total}${res.reasons.length ? `: ${res.reasons[0]}` : ''}) → gõ ${cmd} rồi bán lại (lần ${n}/${max})`);
        await this._sellGoHome(mc, n, stopRec);
        if (stopRec()) { this.log('warn', 'Auto-sell Spawn: ngắt chuỗi thử lại (bảo vệ lồng/tắt/mất kết nối)'); return { ...res, aborted: true }; }
        res = await this._runSellSpawnCycle();
        if (res.ok) { this.log('ok', `Auto-sell Spawn: bán được ${res.done}/${res.total} lồng sau khi gõ ${cmd} ${n} lần`); return res; }
        if (res.aborted || res.skipped) return res;
      }
      this._onSellRecoveryFailed(res, max, cmd);
      return res;
    } finally {
      this._sellRecovering = false;
    }
  }
  // Gõ /home treolong, đứng yên chờ teleport xong (đã ở sẵn chỗ treo thì server vẫn đếm ngược rồi "dịch chuyển" tại chỗ — không sao), chờ chunk lồng tải.
  async _sellGoHome(mc, n, stop) {
    const cmd = this._sellHomeCmd();
    const minGap = TP.PRESEND_MS + this._tp.deadlineMs + this._tp.settleMs + 1000; // không gõ dồn khi lần trước chưa xong (server còn đếm ngược/cooldown)
    while (nowMs() < (this._lastSellHomeAt || 0) + minGap) { if (stop()) return false; await sleep(500); }
    try { if (mc.currentWindow) mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); }
    this._tpHoldStill(nowMs());
    await sleep(TP.PRESEND_MS);
    if (stop()) return false;
    try { mc.chat(cmd); } catch (e) { this.log('err', `Lỗi gửi ${cmd}: ${e.message}`); return false; }
    this._lastSellHomeAt = nowMs();
    this._tp.begin({ cmd, pos: mc.entity?.position, now: nowMs() });
    this.log('sys', `Auto-sell Spawn: đã gõ ${cmd} (lần ${n}) — đứng yên chờ teleport ${(this.spawnHomeWarmupMs / 1000).toFixed(0)}s...`);
    const t0 = nowMs();
    const limit = this._tp.deadlineMs + this._tp.settleMs + 2000;
    while (nowMs() - t0 < limit) {
      await sleep(500);
      if (stop()) return false;
      const ev = this._tp.tick(mc.entity?.position, nowMs()); // posKeeper cũng tick: ai lấy được sự kiện trước thì log, sự kiện chỉ trả 1 lần
      if (ev) this._onTeleportEvent(ev);
      if (!this._tp.active && !this._tp.frozen(nowMs())) break;
    }
    const first = this.sellSpawnList[0];
    const chunkUntil = nowMs() + this.sellHomeChunkWaitMs;
    while (first && nowMs() < chunkUntil) { // chờ chunk chỗ lồng tải xong sau teleport
      let b = null;
      try { b = mc.blockAt(this._vec(first)); } catch (e) { dbg('BotSession', e); }
      if (b && this._isSpawnerBlock(b)) break;
      await sleep(250);
      if (stop()) return false;
    }
    await sleep(jit(500, 150));
    return true;
  }
  _onSellRecoveryFailed(res, max, cmd) {
    const id = this.cfg.id;
    const pos = this._fmtXYZ(this.mc?.entity?.position);
    this.log('err', `Auto-sell Spawn: đã gõ ${cmd} ${max} lần mà vẫn không bán được (${res.done}/${res.total} lồng) → báo webhook`);
    const now = nowMs();
    if (now - this._sellFailAlertedAt < this.sellFailAlertMinMs) { this.log('sys', 'Auto-sell Spawn: vừa báo webhook thất bại gần đây — bỏ qua tin trùng'); return; }
    const n = this._manager?.notifier;
    if (!n?.isEventOn('sellFailed') && !this._manager?.telegram?.isEventOn('sellFailed')) { this.log('warn', 'Auto-sell Spawn: chưa cấu hình webhook (webhook set <url>) / Telegram (telegram set <token>) hoặc sự kiện sellFailed đang tắt — không gửi được tin thất bại'); return; }
    this._sellFailAlertedAt = now;
    const tag = Notifier.formatMention(this.sellFailMention);
    const cage = this._describeCageDistance();
    const lines = [
      `Đã gõ ${cmd} ${max} lần, sau mỗi lần đều bán lại nhưng vẫn không xong (${res.done}/${res.total} lồng).`,
      res.reasons.length ? `Lý do lần cuối:\n${res.reasons.slice(0, 5).map(r => `• ${r}`).join('\n')}` : null,
      `📍 Vị trí: ${pos}${cage ? ` — ${cage}` : ''}`,
      `⚙️ Click ô ${this.autoSellSpawnSlot}, ${this.sellSpawnList.length} lồng. Chu kỳ kế tiếp vẫn tự chạy lại.`,
    ].filter(Boolean);
    this._notify('sellFailed', `🚨 ${id}: autosell_spawn thất bại sau ${max} lần gõ ${cmd}`, lines.join('\n'), 0xef4444, `🚨 KHÔNG BÁN ĐƯỢC LỒNG${tag ? ' ' + tag : ''}`);
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
    this.cfg.spawnerProtectLevel = this._spLevel;
    this.cfg.spawnerProtectTune = this._spTune;
    const mgr = this._manager;
    const list = mgr?._config?.bots;
    if (!list) return;
    const c = list.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) { c.protectedSpawners = this.protectedSpawners; c.spawnerProtectOn = this._spawnerProtectOn; c.spawnerProtectLevel = this._spLevel; c.spawnerProtectTune = this._spTune; }
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
  // ===== Cường độ protect =====
  _initSpawnerLevel(cfg) {
    const hasLevel = cfg.spawnerProtectLevel !== undefined && cfg.spawnerProtectLevel !== null;
    this._spLevel = SG.clampLevel(hasLevel ? cfg.spawnerProtectLevel : SG.DEFAULT_LEVEL);
    let tune = cfg.spawnerProtectTune;
    if (!hasLevel && !tune) { // config cũ (trước khi có cường độ): giữ các giá trị đã đặt
      tune = {};
      if (Number(cfg.spawnerProtectRange) > 0) tune.range = Number(cfg.spawnerProtectRange);
      if (cfg.spawnerAutoMine === false) tune.autoMine = false;
      if (cfg.spawnerArmDelayMs !== undefined && cfg.spawnerArmDelayMs !== null) tune.armDelayMs = cfg.spawnerArmDelayMs;
    }
    this._spTune = SG.diffFromPreset(this._spLevel, SG.resolveSettings(this._spLevel, tune));
    this._spRefresh();
    this._spawnerDig = new SG.DigPattern();
  }
  _spRefresh() { this._sp = SG.resolveSettings(this._spLevel, this._spTune); }
  _spTickMs() { return Math.max(1, this._sp.scanTicks) * 50; }
  get spawnerProtectRange() { return this._sp.range; }
  set spawnerProtectRange(v) { this.setSpawnerTune({ range: v }); }
  get spawnerArmDelayMs() { return this._sp.armDelayMs; }
  set spawnerArmDelayMs(v) { this.setSpawnerTune({ armDelayMs: v }); }
  get spawnerAutoMine() { return this._sp.autoMine; }
  set spawnerAutoMine(v) { this.setSpawnerTune({ autoMine: v }); }
  get spawnerLevel() { return this._spLevel; }
  // Chọn mức 1-4: áp cả bộ thông số của mức đó (xoá các chỉnh tay, trừ khi keepTune)
  setSpawnerLevel(n, keepTune = false) {
    this._spLevel = SG.clampLevel(n);
    this._spTune = keepTune ? SG.diffFromPreset(this._spLevel, SG.resolveSettings(this._spLevel, this._spTune)) : {};
    return this._spApply();
  }
  // Chỉnh tay từng thông số. Giá trị null / 'auto' = bỏ chỉnh, quay về giá trị của mức.
  setSpawnerTune(patch) {
    const next = { ...this._spTune };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!SG.SPEC[k]) continue;
      if (v === null || v === 'auto') { delete next[k]; continue; }
      const c = SG.coerce(k, v);
      if (c !== undefined) next[k] = c;
    }
    this._spTune = SG.diffFromPreset(this._spLevel, SG.resolveSettings(this._spLevel, next));
    return this._spApply();
  }
  _spApply() {
    this._spRefresh();
    this._spawnerDig?.clear();
    if (this._timers.has('spawnerProtect')) this._setTimer('spawnerProtect', () => this._spawnerProtectTick(), this._spTickMs(), true);
    this._persistSpawnerState();
    return this._sp;
  }
  getSpawnerLevelInfo() {
    return { level: this._spLevel, name: SG.LEVELS[this._spLevel].name, settings: { ...this._sp }, tune: { ...this._spTune } };
  }
  _spSummary() {
    const L = SG.LEVELS[this._spLevel];
    const e = this._sp;
    return `${L.icon} mức ${this._spLevel} "${L.name}"${Object.keys(this._spTune).length ? ` (+${Object.keys(this._spTune).length} chỉnh tay)` : ''}: người lạ ${e.range}b/${e.scanTicks}tick, nguy hiểm ${e.threatRadius}b`
      + `${e.explosive ? ', TNT' : ''}${e.wither ? ', Wither' : ''}${e.surfaceDig ? `, đào bề mặt(${e.digThreshold})` : ''}${e.autoMine ? ', tự đập' : ', CHỈ báo'}`;
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
    this._spawnerDig.clear();
    this._setTimer('spawnerProtect', () => this._spawnerProtectTick(), this._spTickMs(), true);
    this._persistSpawnerState();
    this.log('sys', `Bảo vệ Lồng Spawn: BẬT (${this.protectedSpawners.length} lồng) — ${this._spSummary()}`);
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
      try { b = mc.blockAt(this._vec(p)); } catch (e) { dbg('BotSession', e); }
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
  // Gửi cảnh báo + xử lý (đập lồng) khi có mối nguy. Dùng chung cho quét định kỳ và các sự kiện.
  _spawnerDispatch(threats) {
    if (!this._spawnerProtectOn || this._spawnerBusy || !this.protectedSpawners.length) return false;
    if (!this.isOnline || !this.mc?.entity?.position) return false;
    if (nowMs() < this._spawnerRetryAt) return false;
    if (!this._spawnerArmed()) return false; // không có lồng cạnh bot -> không báo, không đập
    // Bảo vệ lồng có ưu tiên cao hơn: ngắt vòng auto-sell spawn, lần quét sau sẽ xử lý
    if (this._sellSpawnBusy || this._sellRecovering) { this._sellSpawnAbort = true; return false; }
    this._spawnerBusy = true;
    this._onSpawnerThreat(threats)
      .catch(e => this.log('err', 'Bảo vệ Lồng Spawn lỗi: ' + e.message))
      .finally(() => {
        this._spawnerBusy = false;
        try { this.mc?.setControlState('sneak', false); this.mc?.setControlState('forward', false); } catch (e) { dbg('BotSession', e); }
      });
    return true;
  }
  _spawnerProtectTick() {
    if (!this.isOnline || !this.mc?.entity?.position) return;
    if (this._spawnerBusy || !this.protectedSpawners.length) return;
    if (this.autoLogin?.inFlow) return; // đang đăng nhập/antibot: không quét người lạ (như SpawnerProtect.isInLoginFlow bên Java)
    if (nowMs() < this._spawnerRetryAt) return;
    if (!this._spawnerArmed()) return;
    const threats = [...this._nearbyStrangers(), ...this._spawnerScanEntities()];
    if (threats.length) this._spawnerDispatch(threats);
  }
  // Khoảng cách từ 1 điểm tới lồng gần nhất (full = chỉ tính ngang)
  _spNearestDist(pos, full) {
    let best = Infinity;
    for (const p of this.protectedSpawners) best = Math.min(best, SG.threatDistance(p.x + .5 - pos.x, p.y + .5 - pos.y, p.z + .5 - pos.z, full));
    return best;
  }
  // TNT / TNT minecart / Wither / sọ wither đang ở trong tầm nguy hiểm quanh lồng
  _spEntityThreat(e) {
    const kind = SG.entityKind(e?.name);
    if (!kind || !e.position || e.isValid === false) return null;
    const label = SG.threatLabel(kind, { ...this._sp, charged: /dangerous/.test(e.name) });
    if (!label) return null;
    const d = this._spNearestDist(e.position, this._sp.fullHeight);
    if (!SG.insideRange(d, this._sp.threatRadius)) return null;
    return { name: label, dist: d, kind, label: `${label} cách lồng ${d.toFixed(1)}m` };
  }
  _spawnerScanEntities() {
    const e = this._sp;
    if (!e.explosive && !e.wither) return [];
    const out = [];
    for (const ent of Object.values(this.mc?.entities || {})) {
      const t = this._spEntityThreat(ent);
      if (t) { out.push(t); if (out.length >= 5) break; }
    }
    return out;
  }
  _bindSpawnerEvents(mc) {
    const safe = fn => (...a) => { try { fn(...a); } catch { /* phát hiện lỗi không được làm hỏng bot */ } };
    mc.on('blockUpdate', safe((o, n) => this._spOnBlockUpdate(o, n)));
    mc.on('entitySpawn', safe(e => this._spOnEntity(e)));
    mc.on('explode', safe((pos, power) => this._spOnExplode(pos, power)));
    try { mc._client?.on?.('block_break_animation', safe(p => this._spOnBreakAnim(p))); } catch (e) { dbg('BotSession', e); }
  }
  // Đào bề mặt (heuristic của mod gốc): block đặc ở trong bán kính ngang bị mất, N lần liên tiếp xuống dưới trong 1 cột / 5s
  _spOnBlockUpdate(oldB, newB) {
    if (!this._spawnerProtectOn || !this._sp.surfaceDig || this._spawnerBusy || !oldB || !newB) return;
    if (!/^(air|cave_air|void_air)$/.test(newB.name || '')) return;
    if (!SG.isDigEligible(oldB)) return;
    const pos = newB.position || oldB.position;
    if (!pos) return;
    const d = this._spNearestDist({ x: pos.x + .5, y: pos.y + .5, z: pos.z + .5 }, true);
    if (!(d <= this._sp.threatRadius)) return;
    const td = this.mc?.targetDigBlock?.position; // chính bot đang đào thì bỏ qua
    if (td && td.x === pos.x && td.y === pos.y && td.z === pos.z) return;
    if (!this._spawnerDig.removed(pos.x, pos.y, pos.z, nowMs(), this._sp.digThreshold)) return;
    this._spawnerDispatch([{ name: 'đào bề mặt', dist: d, kind: 'dig', label: `đào bề mặt (${oldB.name}) cách lồng ${d.toFixed(1)}m ngang` }]);
  }
  _spOnEntity(e) {
    if (!this._spawnerProtectOn || !e?.position) return;
    const t = this._spEntityThreat(e);
    if (t) this._spawnerDispatch([t]);
  }
  _spOnExplode(pos, power) {
    if (!this._spawnerProtectOn || !this._sp.explosive || !pos) return;
    const d = this._spNearestDist(pos, this._sp.fullHeight);
    if (!SG.insideRange(d, this._sp.threatRadius, Number(power) || 0)) return;
    this._spawnerDispatch([{ name: 'vụ nổ', dist: d, kind: 'explosion', label: `vụ nổ cách lồng ${d.toFixed(1)}m` }]);
  }
  // Người chơi lạ đang đập block (block_break_animation) trong bán kính nguy hiểm quanh lồng
  _spOnBreakAnim(p) {
    if (!this._spawnerProtectOn || !this._sp.players || !p || !this.mc) return;
    if (!(p.destroyStage >= 0 && p.destroyStage <= 9)) return;
    const ent = this.mc.entities?.[p.entityId];
    if (!ent || ent === this.mc.entity || ent.type !== 'player') return;
    const uname = ent.username || ent.name;
    if (!uname || this._spawnerTrusted(uname)) return;
    const loc = p.location;
    if (!loc) return;
    const d = this._spNearestDist({ x: loc.x + .5, y: loc.y + .5, z: loc.z + .5 }, this._sp.fullHeight);
    if (!SG.insideRange(d, this._sp.threatRadius)) return;
    let bn = 'block';
    try { bn = this.mc.blockAt(this._vec(loc))?.name || bn; } catch (e) { dbg('BotSession', e); }
    this._spawnerDispatch([{ name: uname, dist: d, kind: 'player_break', label: `${uname} đang đập ${bn} cách lồng ${d.toFixed(1)}m` }]);
  }
  // Gửi webhook có giới hạn tần suất theo từng loại cảnh báo
  _spawnerAlert(key, minMs, title, desc, color) {
    const now = nowMs();
    if (now - (this._spawnerAlertedAt.get(key) || 0) < minMs) return false;
    this._spawnerAlertedAt.set(key, now);
    this._notify('spawnerThreat', title, desc, color, '🚨 CẢNH BÁO LỒNG SPAWN');
    return true;
  }
  _itemHasSilk(item) {
    try { if (Array.isArray(item.enchants) && item.enchants.some(e => /silk_touch/i.test(e?.name || ''))) return true; } catch (e) { dbg('BotSession', e); }
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
    if (mc.currentWindow) { try { mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); } await sleep(250); }
    const ecId = mc.registry?.blocksByName?.ender_chest?.id;
    if (ecId !== undefined) {
      const blk = mc.findBlock({ matching: ecId, maxDistance: 4.5 });
      if (blk) {
        // nhìn thẳng vào ender chest (kiểm tra tia ngắm trúng rương) rồi MỚI mở rương
        const aimed = await this._faceBlock(mc, blk.position, { reach: 5 });
        this.log('sys', `Bảo vệ Lồng Spawn: nhìn vào ender chest (${blk.position.x},${blk.position.y},${blk.position.z}) → mở rương${aimed ? '' : ` (tia ngắm chưa trúng rương${this._aimWhy()})`}`);
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
      try { mc.closeWindow(win); } catch (e) { dbg('BotSession', e); }
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
    try { lore = (item.customLore || []).map(l => resolveText(l)).join(' '); } catch (e) { dbg('BotSession', e); }
    const txt = normalizeSmallCaps(`${resolveText(item.customName || '')} ${item.displayName || ''} ${lore}`)
      .normalize('NFC').toLowerCase();
    return txt.includes('lồng') || txt.includes('spawn');
  }
  _spCountIn(slots, from, to) {
    let n = 0;
    for (let i = from; i < to; i++) { const it = slots[i]; if (it && this._isSpawnerItem(it)) n += it.count || 1; }
    return n;
  }
  _countSpawnerItems() { return this.mc.inventory.items().filter(i => this._isSpawnerItem(i)).reduce((n, i) => n + (i.count || 1), 0); }
  _spEmptySlots() {
    const inv = this.mc.inventory;
    if (typeof inv.emptySlotCount === 'function') return inv.emptySlotCount();
    return Math.max(0, 36 - inv.items().length);
  }
  // Bỏ MỌI item lồng trong túi vào ender chest rồi MỞ LẠI rương 1 lần để xác minh bằng snapshot của server
  // (rương có ≥ dự kiến, túi không còn lồng) — theo cách của mod gốc. verified=false -> KHÔNG được thoát game.
  async _stashSpawnerItems() {
    const mc = this.mc;
    const has = () => mc.inventory.items().filter(i => this._isSpawnerItem(i));
    const agg = this._spStashAgg || (this._spStashAgg = { found: 0, moved: 0, left: 0, failed: false, unverified: false });
    const before = has();
    if (!before.length) return { found: 0, left: 0, failed: false, verified: false, moved: 0 };
    const total = before.reduce((n, i) => n + (i.count || 1), 0);
    const win = await this._openEnderChest();
    if (!win) { agg.found += before.length; agg.left = before.length; agg.failed = true; return { found: before.length, left: before.length, failed: true, verified: false, moved: 0 }; }
    this.log('sys', `Bảo vệ Lồng Spawn: đã mở ender chest — bỏ ${before.length} stack lồng vào`);
    const rate = this._sp.depositPerTick;
    let chestBefore = 0, clicks = 0;
    try {
      const start = win.inventoryStart ?? Math.max(0, win.slots.length - 36);
      chestBefore = this._spCountIn(win.slots, 0, start);
      for (let i = start; i < win.slots.length; i++) {
        const it = win.slots[i];
        if (!it || !this._isSpawnerItem(it)) continue;
        await mc.clickWindow(i, 0, 1); // shift-click -> vào ender chest
        if (++clicks % rate === 0) await sleep(50); // depositPerTick thao tác mỗi tick (50ms)
      }
    } finally {
      try { mc.closeWindow(win); } catch (e) { dbg('BotSession', e); }
    }
    await sleep(900);
    const leftItems = has();
    const leftCount = leftItems.reduce((n, i) => n + (i.count || 1), 0);
    const moved = Math.max(0, total - leftCount);
    // Mở lại 1 lần cho cả đợt (không mở lại theo từng stack) để lấy snapshot chắc chắn từ server
    let verified = false;
    const win2 = await this._openEnderChest();
    if (win2) {
      try {
        const start2 = win2.inventoryStart ?? Math.max(0, win2.slots.length - 36);
        verified = SG.depositVerified({
          snapshot: true,
          chestCount: this._spCountIn(win2.slots, 0, start2),
          expectedChest: chestBefore + moved,
          playerCount: this._spCountIn(win2.slots, start2, win2.slots.length),
        }) && leftCount === 0;
      } finally { try { mc.closeWindow(win2); } catch (e) { dbg('BotSession', e); } }
    }
    agg.found += before.length; agg.moved += moved; agg.left = leftItems.length;
    if (!verified) agg.unverified = true;
    this.log(verified ? 'ok' : 'warn', `Bảo vệ Lồng Spawn: ${verified ? 'đã xác minh' : 'CHƯA xác minh được'} việc cất ${moved}/${total} item lồng (mở lại ender chest kiểm tra)`);
    return { found: before.length, left: leftItems.length, failed: false, verified, moved };
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
  _spawnerExpired() { return this._spawnerDeadline > 0 && nowMs() > this._spawnerDeadline; }
  // Chờ server giao item lồng vào túi sau mỗi đợt đào (true = đã thấy tăng)
  async _waitSpawnerDelivery(before, maxMs = 2500) {
    const t0 = nowMs();
    while (nowMs() - t0 < maxMs) {
      if (this._countSpawnerItems() > before) return true;
      await sleep(50);
    }
    return this._countSpawnerItems() > before;
  }
  _spDropIsSpawner(e) { try { const it = e.getDroppedItem?.(); return it ? this._isSpawnerItem(it) : false; } catch { return false; } }
  // Item lồng còn nằm dưới đất quanh chỗ vừa đào (chưa nhặt) — chặn việc thoát game
  _spawnerGroundDrops(points) {
    const mc = this.mc;
    const me = mc?.entity?.position;
    if (!me) return [];
    return Object.values(mc.entities || {}).filter(e =>
      (e.name === 'item' || e.objectType === 'Item') && e.position && e.isValid !== false &&
      e.position.distanceTo(me) <= 16 && this._spDropIsSpawner(e) &&
      (!points.length || points.some(p => e.position.distanceTo(makeVec3(p.x + 0.5, p.y + 0.5, p.z + 0.5)) <= 8)));
  }
  // Đập từng lồng theo ĐỢT như mod gốc: giữ shift -> đào -> chờ item vào túi -> nhả shift -> nghỉ pauseTicks -> shift lại.
  // Túi gần đầy (< reserveSlots ô trống) thì cất vào ender chest giữa chừng rồi đào tiếp.
  async _breakSpawners(pick, targets) {
    const mc = this.mc;
    const broken = [];
    let timedOut = false;
    const pauseMs = this._sp.pauseTicks * 50;
    await mc.equip(pick, 'hand');
    mc.setControlState('sneak', true); // giữ shift: plugin gộp lồng sẽ cho đào cả stack trong 1 lần
    await sleep(200);
    try {
      for (const p of targets) {
        if (this._spawnerExpired()) { timedOut = true; break; }
        let outOfReach = false;
        // nhìn thẳng vào lồng (kiểm tra tia ngắm trúng lồng) rồi MỚI đào
        const aimed = await this._faceBlock(mc, p, { reach: 6, stop: () => !this._spawnerProtectOn });
        if (this.isOnline && this._spawnerProtectOn) this.log(aimed ? 'sys' : 'warn', `Bảo vệ Lồng Spawn: nhìn vào lồng (${p.x},${p.y},${p.z}) → đào${aimed ? '' : ` (tia ngắm chưa trúng lồng${this._aimWhy()})`}`);
        for (let i = 0; i < 12; i++) { // stack còn dư thì đập tiếp
          if (!this.isOnline) throw new Error('bot offline');
          if (!this._spawnerProtectOn) throw new Error('đã tắt bảo vệ giữa chừng');
          if (this._spawnerExpired()) { timedOut = true; break; }
          const block = mc.blockAt(this._vec(p));
          if (!this._isSpawnerBlock(block)) break;
          if (!mc.heldItem || !/_pickaxe$/.test(mc.heldItem.name || '')) { // cúp hỏng giữa chừng
            const alt = this._invPickaxe();
            if (!alt) throw new Error('cúp đã hỏng, không còn cúp khác');
            await mc.equip(alt, 'hand');
          }
          if (!mc.canDigBlock(block)) { outOfReach = true; break; }
          // túi gần đầy -> cất giữa chừng rồi đào tiếp (cần còn chỗ cho 1 đợt item mới)
          if (this._spEmptySlots() < this._sp.reserveSlots) {
            if (!this._countSpawnerItems()) throw new Error('túi đầy item khác (không phải lồng) — cần dọn chỗ trống');
            this.log('sys', `Bảo vệ Lồng Spawn: túi còn < ${this._sp.reserveSlots} ô trống — cất vào ender chest rồi đào tiếp`);
            try { mc.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); }
            const mid = await this._stashSpawnerItems();
            if (mid.failed) throw new Error('không mở được ender chest để cất giữa chừng');
            await mc.equip(pick, 'hand');
            mc.setControlState('sneak', true);
            await sleep(200);
            await this._faceBlock(mc, p, { reach: 6, stop: () => !this._spawnerProtectOn });
          }
          const before = this._countSpawnerItems();
          try { mc.stopDigging(); } catch (e) { dbg('BotSession', e); }
          try { await mc.dig(block, true); }
          catch (e) { this.log('warn', `Đào lỗi (${p.x},${p.y},${p.z}): ${e.message}`); await sleep(300); }
          const got = await this._waitSpawnerDelivery(before);
          const after = mc.blockAt(this._vec(p));
          if (after && this._isSpawnerBlock(after)) {
            // còn dư stack: nhả shift, nghỉ, shift lại rồi mới đợt kế (giống mod gốc)
            if (!got) this.log('warn', 'Bảo vệ Lồng Spawn: chưa thấy item vào túi sau đợt đào — nghỉ rồi thử tiếp');
            try { mc.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); }
            await sleep(150 + pauseMs);
            mc.setControlState('sneak', true);
            await sleep(100);
          }
        }
        const after = mc.blockAt(this._vec(p));
        if (after && !this._isSpawnerBlock(after)) {
          broken.push(p);
          this.protectedSpawners = this.protectedSpawners.filter(q => !(q.x === p.x && q.y === p.y && q.z === p.z));
          this.log('ok', `Đã đập lồng tại (${p.x},${p.y},${p.z})`);
        } else if (outOfReach) {
          this.log('warn', `Lồng (${p.x},${p.y},${p.z}) ngoài tầm với — bot không tự di chuyển`);
        }
        if (timedOut) break;
      }
    } finally {
      try { mc.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); }
      this._persistSpawnerState();
    }
    return { broken, timedOut };
  }
  _spFmt(t) { return t.label || `${t.name} (${Number(t.dist).toFixed(1)}m)`; }
  async _onSpawnerThreat(threats) {
    const names = threats.map(t => this._spFmt(t)).join(', ');
    const onlyPlayers = threats.every(t => !t.kind || t.kind === 'player_break');
    const tag = onlyPlayers ? 'Người lạ' : 'Mối nguy';
    const id = this.cfg.id;
    if (this._spawnerAlert('threat', this._sp.alertCooldownMs, `⚠️ ${id}: ${onlyPlayers ? 'người lạ gần lồng' : 'nguy hiểm gần lồng'}`, `${tag}: ${names}\nĐang bảo vệ ${this.protectedSpawners.length} lồng (${this._spSummary()}).`, 0xf59e0b)) {
      this.log('warn', `⚠️ Bảo vệ Lồng Spawn: ${tag.toLowerCase()} ${names}`);
    }
    if (!this._sp.autoMine) {
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
    if (this.scriptRunner.running) { this.log('warn', 'Bảo vệ Lồng Spawn: dừng macro đang chạy để xử lý lồng'); this.scriptRunner.stop(); await sleep(400); }
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
        `${tag}: ${names}\n${targets.length} lồng đang gặp nguy hiểm, vd (${targets[0].x}, ${targets[0].y}, ${targets[0].z}).\nCả túi đồ lẫn ender chest đều không có cúp — hãy vào xử lý gấp!`, 0xef4444);
      this.log('warn', '🚨 Bảo vệ Lồng Spawn: không có cúp ở túi đồ lẫn ender chest — đang báo webhook liên tục');
      this._spawnerRetryAt = nowMs() + this.spawnerAlertIntervalMs;
      return;
    }
    this._spawnerDeadline = nowMs() + this._sp.timeoutSec * 1000;
    this._spStashAgg = { found: 0, moved: 0, left: 0, failed: false, unverified: false };
    this.log('sys', `Bảo vệ Lồng Spawn: dùng ${pick.name} đập ${targets.length} lồng (giữ shift, nghỉ ${this._sp.pauseTicks} tick giữa các đợt, giới hạn ${this._sp.timeoutSec}s)`);
    let broken = [], timedOut = false, ground = 0;
    try {
      ({ broken, timedOut } = await this._breakSpawners(pick, targets));
      if (timedOut) { // hết giờ: cho thêm 30s để cất số đã đào được
        this._spawnerDeadline = nowMs() + 30000;
        this.log('warn', 'Bảo vệ Lồng Spawn: hết thời gian xử lý — cất số lồng đã đào được');
      }
      if (broken.length) await this._collectDrops(broken);
      await this._stashSpawnerItems();
      ground = this._spawnerGroundDrops(broken).length;
      if (ground && broken.length) { // còn item rơi chưa nhặt: nhặt + cất thêm 1 vòng
        await this._collectDrops(broken);
        await this._stashSpawnerItems();
        ground = this._spawnerGroundDrops(broken).length;
      }
    } finally { this._spawnerDeadline = 0; }
    const agg = this._spStashAgg;
    const carried = this._countSpawnerItems();
    const remaining = this.protectedSpawners.length;
    const lines = [`${tag}: ${names}`, `Đã đập ${broken.length}/${targets.length} lồng.`];
    if (agg.found) lines.push(agg.failed ? '⚠️ Không mở được ender chest — item lồng vẫn nằm trong túi.'
      : `Đã cất ${agg.moved} item lồng/spawn vào ender chest — ${agg.unverified ? '⚠️ CHƯA xác minh được bằng snapshot server' : 'đã xác minh ✅'}${carried ? ` (còn ${carried} trong túi — ender chest đầy?)` : ''}.`);
    else if (broken.length) lines.push('⚠️ Không thấy item lồng trong túi (rơi dưới đất/server không trả item?).');
    if (ground) lines.push(`⚠️ Còn ${ground} item lồng dưới đất chưa nhặt được.`);
    if (timedOut) lines.push('⚠️ Hết thời gian xử lý khẩn cấp.');
    if (remaining) lines.push(`⚠️ Còn ${remaining} lồng chưa đập được (ngoài tầm với).`);
    const stored = agg.found > 0 && !agg.failed && !agg.unverified;
    const ok = SG.mayLogout({ stored, carried, ground, remaining, failed: timedOut || broken.length === 0 });
    this._notify('spawnerThreat', `${ok ? '✅' : '⚠️'} ${id}: xử lý bảo vệ lồng`, lines.join('\n'), ok ? 0x22c55e : 0xf59e0b);
    this.log(ok ? 'ok' : 'warn', 'Bảo vệ Lồng Spawn: ' + lines.join(' | '));
    if (!this.protectedSpawners.length) this._stopSpawnerProtect();
    else this._spawnerRetryAt = nowMs() + 4000;
    if (this.spawnerAutoDisconnect) {
      if (ok) {
        this.log('warn', 'Bảo vệ Lồng Spawn: đã xác minh cất xong — ngắt kết nối để bảo toàn tài khoản/đồ đạc');
        this.shutdown();
      } else if (broken.length) {
        this.log('warn', 'Bảo vệ Lồng Spawn: KHÔNG ngắt kết nối vì chưa xác minh được việc cất đồ/còn lồng — bot ở lại để bạn xử lý');
      }
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
  // ===== Trình tự khởi động: đăng nhập -> menu -> đúng vị trí -> bật tính năng =====
  _resetStartupState() {
    this._clearTimer('loginConfirmWait');
    this._clearTimer('posKeeper');
    this._loginConfirmed = false;
    this._menuFlowStarted = false;
    this._menuDoneAt = 0;
    this._featuresActive = false;
    this._autoSellArmed = false;
    this._gateStartedAt = 0;
    this._gateTimedOut = false;
    this._posNearSince = 0;
    this._posAwaySince = 0;
    this._posLastPos = null;
    this._posLost = false;
    this._homeOutage = null;
    this._homeNextAt = 0;
    this._gateWaitLogAt = 0;
  }
  // Delegate sang LoginHandler
  _isLoginSuccessText(text) { return this.loginHandler.isLoginSuccessText(text); }
  _onLoginConfirmed() { return this.loginHandler.onLoginConfirmed(); }
  _continueAfterLogin() { return this.loginHandler.continueAfterLogin(); }
  // Bước menu xong (đã click vào server). Từ đây mới bắt đầu canh vị trí để bật spawnerprotect/autosell.
  _onMenuDone(src = '') {
    this._menuSuccess = true;
    this._clearTimer('menuRetry');
    if (this._menuDoneAt) return;
    this._menuDoneAt = nowMs();
    this.log('ok', `Menu xong${src ? ` (${src})` : ''} — chờ bot đứng đúng cạnh lồng rồi mới bật spawnerprotect / autosell`);
    this._resumeIntendedStates();
    this._beginFeatureGate();
  }
  _beginFeatureGate() {
    if (this._timers.has('posKeeper')) return;
    this._gateStartedAt = nowMs();
    this._gateTimedOut = false;
    this._posNearSince = 0;
    this._posAwaySince = 0;
    this._posLastPos = null;
    const want = [this._spawnerProtectOn && 'spawnerprotect', this._sellSpawnOn && 'autosell_spawn', this.autoSellMacro && 'autosell macro'].filter(Boolean);
    this.log('sys', want.length
      ? `Cổng vị trí: sẽ bật ${want.join(' + ')} khi bot ở gần lồng spawn${this.spawnHomeEnabled ? ` (lệch vị trí → tự gõ ${this.spawnHomeCommand})` : ''}`
      : 'Cổng vị trí: chưa có tính năng lồng/autosell nào đang BẬT — chỉ canh vị trí khi bạn bật chúng');
    this._setTimer('posKeeper', () => this._posKeeperTick(), 1000, true);
  }
  // Số lồng nằm trong tầm so với bot. Lồng nào đã bị phá (chunk tải rồi, bot đứng trong 16 block mà block không còn là spawner)
  // thì bỏ qua — không coi là "bot đi lạc". Chunk chưa tải / block khác ở xa = đang ở chỗ khác.
  _checkSpawnPosition() {
    const mc = this.mc;
    const me = mc?.entity?.position;
    const out = { hasTargets: false, ok: false, sell: null, prot: null };
    if (!me) return out;
    const scan = (list, base, reach) => {
      let total = 0, near = 0, gone = 0;
      for (const p of list) {
        let b = null;
        try { b = mc.blockAt(this._vec(p)); } catch (e) { dbg('BotSession', e); }
        const d = base.distanceTo(makeVec3(p.x + .5, p.y + .5, p.z + .5));
        if (b && !this._isSpawnerBlock(b) && d <= 16) { gone++; continue; }
        total++;
        if (b && this._isSpawnerBlock(b) && d <= reach) near++;
      }
      return { total, near, gone, listed: list.length };
    };
    if (this._sellSpawnOn) out.sell = scan(this.sellSpawnList, me.offset(0, 1.62, 0), SELL.SPAWN_REACH);
    if (this._spawnerProtectOn) out.prot = scan(this.protectedSpawners, me, this.spawnerArmRange);
    out.hasTargets = !!((out.sell && out.sell.total) || (out.prot && out.prot.total));
    out.ok = !!((out.sell && out.sell.near) || (out.prot && out.prot.near));
    return out;
  }
  // Hiện tin action bar/title của server. Chỉ khi đang chờ teleport hoặc khớp TP.HUD_RE; cùng 1 tin lặp lại trong 4s thì bỏ.
  _logHud(text, label) {
    const t = String(text || '').trim();
    if (!t) return;
    const now = nowMs();
    this._tp.note(t, now);
    if (!(this._tp.active || this._tp.frozen(now) || TP.HUD_RE.test(t))) return;
    if (this._hudLast.text === t && now - this._hudLast.at < 4000) return;
    this._hudLast = { text: t, at: now };
    this.log('chat', `[${label}] ${t}`);
  }
  // Thả hết phím + huỷ các timer AFK còn treo để bot đứng im (teleport bị hủy nếu bot di chuyển/nhảy).
  _tpHoldStill(now = nowMs()) {
    this._tp.hold(now, TP.PRESEND_MS + 400);
    for (const k of ['afkJumpOff', 'afkSneak', 'wafkKey', 'wafkJump']) this._clearTimer(k);
    try { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) this.mc?.setControlState(k, false); } catch (e) { dbg('BotSession', e); }
  }
  // Lồng gần nhất + trạng thái block đó: phân biệt "chunk chưa tải" / "toạ độ lồng lưu sai" / "bot đứng quá xa".
  _describeCageDistance() {
    const mc = this.mc;
    const me = mc?.entity?.position;
    if (!me) return '';
    const lists = [];
    if (this._sellSpawnOn) lists.push(...this.sellSpawnList);
    if (this._spawnerProtectOn) lists.push(...this.protectedSpawners);
    let best = null;
    for (const p of lists) {
      const d = me.distanceTo(makeVec3(p.x + .5, p.y + .5, p.z + .5));
      if (!best || d < best.d) best = { p, d };
    }
    if (!best) return '';
    let st = 'chunk chưa tải';
    try {
      const b = mc.blockAt(this._vec(best.p));
      if (b) st = this._isSpawnerBlock(b) ? 'spawner OK' : `không phải spawner, đang là ${b.name}`;
    } catch (e) { dbg('BotSession', e); }
    return `lồng gần nhất ${this._fmtXYZ(best.p)} cách ${best.d.toFixed(1)} block (${st})`;
  }
  _onTeleportEvent(ev) {
    const pos = this.mc?.entity?.position;
    const said = ev.msgs.length ? ` Server nói: ${ev.msgs.map(m => `"${m}"`).join(' | ')}.` : '';
    const cage = this._describeCageDistance();
    if (ev.type === 'arrived' && ev.inPlace) {
      // bot đã đứng sẵn ở home: server vẫn đếm ngược rồi "dịch chuyển" tại chỗ nên vị trí không đổi — đây là thành công, không phải lỗi
      this.log('ok', `Server báo ${ev.cmd} thành công sau ${(ev.ms / 1000).toFixed(1)}s (bot đã ở sẵn chỗ treo nên vị trí không đổi) → ${this._fmtXYZ(pos)}.${said}${cage ? ' ' + cage : ''}`);
      return;
    }
    if (ev.type === 'arrived') {
      this.log('ok', `Đã dịch chuyển ${ev.dist.toFixed(0)} block sau ${(ev.ms / 1000).toFixed(1)}s (${ev.cmd}) → ${this._fmtXYZ(pos)}.${said}${cage ? ' ' + cage : ''}`);
      return;
    }
    const secs = (ev.ms / 1000).toFixed(0);
    let why;
    if (ev.selfMoved) why = `Bot bị xê dịch ${ev.drift.toFixed(1)} block trong lúc chờ → nhiều khả năng teleport bị HỦY vì bot di chuyển (hoặc bị đẩy).`;
    else if (this.packetMgr.isStale(5000)) why = `Bot KHÔNG nhận được gói nào từ server trong ${Math.round((nowMs() - (this.packetMgr.lastPacketAt || 0)) / 1000)}s qua → kết nối đang "câm" (thường do lỗi đọc gói tin), không phải lỗi lệnh /home.`;
    else if (!ev.msgs.length) why = 'Server KHÔNG trả lời gì → kiểm tra: home "treolong" còn tồn tại không, có đang cooldown/bị chặn lệnh không, bot có quyền dùng /home không.';
    else why = 'Bot đứng yên nhưng server vẫn không teleport — xem tin server ở trên.';
    this.log('warn', `Gõ ${ev.cmd} đã ${secs}s mà KHÔNG bị dịch chuyển.${said} ${why}`);
  }
  _fmtPosCheck(chk) {
    const parts = [];
    if (chk.sell) parts.push(`autosell_spawn ${chk.sell.near}/${chk.sell.total} lồng trong tầm`);
    if (chk.prot) parts.push(`spawnerprotect ${chk.prot.near}/${chk.prot.total} lồng cạnh bot`);
    return parts.join(', ') || 'không có lồng để đối chiếu';
  }
  _fmtXYZ(p) { return p ? `${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}` : '?'; }
  // 1 timer duy nhất, 1 giây/lần, chạy suốt phiên: trước khi bật = cổng vị trí; sau khi bật = canh vị trí + tự về home.
  _posKeeperTick() {
    const mc = this.mc;
    if (!this.isOnline || this._disabled || !mc?.entity?.position) return;
    if (this.cfg.botPassword && !this._loginConfirmed) return; // giữ đúng thứ tự: đăng nhập trước, rồi mới tới đây
    try {
      const chk = this._checkSpawnPosition();
      const now = nowMs();
      const tpEv = this._tp.tick(mc.entity.position, now);
      if (tpEv) this._onTeleportEvent(tpEv);
      if (!this._featuresActive) this._gateTick(chk, now);
      else this._watchTick(chk, now);
    } catch (e) {
      this.log('err', 'Canh vị trí lỗi: ' + e.message);
    }
  }
  _gateTick(chk, now) {
    const pos = this.mc.entity.position;
    const moved = !!this._posLastPos && pos.distanceTo(this._posLastPos) > 1.5; // vừa bị teleport/đẩy đi -> chưa tính là đứng yên
    this._posLastPos = pos.clone();
    const settle = this.spawnPositionSettleMs;
    if (!chk.hasTargets) {
      // không có toạ độ lồng nào để đối chiếu (đều tắt hoặc danh sách trống) -> chỉ chờ ổn định rồi bật
      if (!this._posNearSince) this._posNearSince = now;
      if (now - this._posNearSince >= Math.max(settle, 5000)) this._activateGatedFeatures(chk, 'không có lồng để đối chiếu vị trí');
      return;
    }
    if (chk.ok && !moved) {
      if (!this._posNearSince) {
        this._posNearSince = now;
        this.log('sys', `Cổng vị trí: đã thấy lồng cạnh bot (${this._fmtPosCheck(chk)}) — xác nhận đứng yên ${(settle / 1000).toFixed(1)}s`);
      }
      if (now - this._posNearSince >= settle) this._activateGatedFeatures(chk);
      return;
    }
    this._posNearSince = 0;
    if (chk.ok) return; // đang ở gần nhưng còn bị dịch chuyển — chờ tick sau
    if (!this._gateWaitLogAt || now - this._gateWaitLogAt >= 15000) {
      this._gateWaitLogAt = now;
      const cageInfo = this._describeCageDistance();
      this.log('sys', `Cổng vị trí: bot CHƯA ở gần lồng (${this._fmtPosCheck(chk)}${cageInfo ? '; ' + cageInfo : ''}) — chưa bật spawnerprotect/autosell`);
    }
    this._tryGoHome('gate', chk, now);
    if (!this._gateTimedOut && now - this._gateStartedAt >= this.spawnGateTimeoutMs) this._onGateTimeout(chk);
  }
  _onGateTimeout(chk) {
    this._gateTimedOut = true;
    const secs = Math.round(this.spawnGateTimeoutMs / 1000);
    const tries = this._homeOutage?.tries || 0;
    this.log('warn', `Cổng vị trí: ${secs}s vẫn chưa về được chỗ treo lồng (${this._fmtPosCheck(chk)}${tries ? `, đã gõ ${this.spawnHomeCommand} ${tries} lần` : ''}) — spawnerprotect/autosell_spawn vẫn CHỜ; bật autosell macro trước`);
    this._spawnerAlert('gateTimeout', 600000, `⚠️ ${this.cfg.id}: chưa về được vị trí treo lồng`,
      `Sau ${secs}s kể từ lúc vào menu bot vẫn không ở gần lồng (${this._fmtPosCheck(chk)}).\n${this.spawnHomeEnabled ? `Đã gõ ${this.spawnHomeCommand} ${tries} lần.` : 'Tự về home đang TẮT (spawnhome on).'}\nspawnerprotect/autosell_spawn chưa bật — sẽ tự bật khi bot về tới nơi.`, 0xf59e0b);
    this._armAutoSell();
  }
  _armAutoSell(results = null) {
    if (this._autoSellArmed) return;
    this._autoSellArmed = true;
    if (!this.autoSellMacro) return;
    this.log('ok', `Đã bật autosell macro: túi đầy ${this.autoSellThreshold}% → macro "${this.autoSellMacro}"`);
    if (results) results.push({ name: 'autosell macro', ok: true, detail: `túi đầy ${this.autoSellThreshold}% → macro "${this.autoSellMacro}"` });
    this._autoSellFired = false;
    this._setTimer('autoSellFirstCheck', () => this._updateInventory(), 1500); // túi đã đầy sẵn thì chạy luôn, khỏi chờ lần quét túi sau
  }
  // Bot đã đứng đúng chỗ: bật spawnerprotect -> autosell_spawn -> autosell macro, rồi báo webhook.
  _activateGatedFeatures(chk, note = '') {
    if (this._featuresActive) return;
    this._featuresActive = true;
    this._posNearSince = 0;
    const outage = this._homeOutage;
    this._homeOutage = null; this._posLost = false; this._homeNextAt = 0;
    const results = [];
    if (this._spawnerProtectOn) {
      let ok = false, detail;
      if (!this.protectedSpawners.length) detail = 'danh sách lồng trống — đứng sát lồng rồi gõ: spawnerprotect on';
      else { ok = this._startSpawnerProtect(); detail = ok ? `${this.protectedSpawners.length} lồng, quét người lạ ${this.spawnerProtectRange} block` : 'không bật được (không thấy lồng quanh bot)'; }
      results.push({ name: 'spawnerprotect', ok, detail });
    }
    if (this._sellSpawnOn) {
      const ok = this._startSellSpawn(true);
      results.push({ name: 'autosell_spawn', ok, detail: ok ? `${this.sellSpawnList.length} lồng, click ô ${this.autoSellSpawnSlot}, mỗi ${this._fmtDuration(this._sellSpawnIntervalMs())}` : 'danh sách lồng trống — đứng sát lồng rồi gõ: autosell_spawn on' });
    }
    this._armAutoSell(results);
    const names = results.filter(r => r.name !== 'autosell macro');
    const allOk = results.every(r => r.ok);
    this.log(allOk ? 'ok' : 'warn', `Đã bật: ${results.map(r => `${r.ok ? '✓' : '✗'} ${r.name}`).join(' | ') || '(không có tính năng nào cần bật)'}${note ? ` — ${note}` : ''}`);
    if (!names.length) return;
    const pos = this.mc?.entity?.position;
    const lines = results.map(r => `${r.ok ? '✅' : '⚠️'} ${r.name}: ${r.detail}`);
    lines.push(`📍 Vị trí: ${this._fmtXYZ(pos)} (${this._fmtPosCheck(chk)})`);
    if (outage?.tries) lines.push(`🏠 Đã gõ ${this.spawnHomeCommand} ${outage.tries} lần để về vị trí treo lồng`);
    if (this._menuDoneAt) lines.push(`⏱️ ${Math.round((nowMs() - this._menuDoneAt) / 1000)}s sau khi vào menu`);
    this._notify('featuresReady', `${allOk ? '✅' : '⚠️'} ${this.cfg.id}: đã bật ${names.map(r => r.name).join(' + ')}`, lines.join('\n'), allOk ? 0x22c55e : 0xf59e0b);
  }
  // Sau khi đã bật: canh vị trí. Lệch khỏi chỗ treo lồng -> báo + tự gõ spawnHomeCommand; về tới nơi -> báo lại.
  _watchTick(chk, now) {
    if (!chk.hasTargets) { this._posAwaySince = 0; return; }
    if (chk.ok) {
      this._posAwaySince = 0;
      if (this._posLost) this._onPositionRestored(chk, now);
      return;
    }
    if (this._isBusy) { this._posAwaySince = 0; return; } // đang làm việc khác (macro/bảo vệ lồng/bán) — không can thiệp
    if (!this._posAwaySince) this._posAwaySince = now;
    if (now - this._posAwaySince < this.spawnHomeConfirmMs) return;
    if (!this._posLost) {
      this._posLost = true;
      this._homeOutage = this._homeOutage || { since: this._posAwaySince, tries: 0, notified: false };
      this.log('warn', `Phát hiện bot KHÔNG còn ở gần vị trí treo lồng (${this._fmtPosCheck(chk)}) tại ${this._fmtXYZ(this.mc.entity.position)}${this.spawnHomeEnabled ? ` — tự gõ ${this.spawnHomeCommand}` : ' — tự về home đang TẮT (spawnhome on)'}`);
    }
    this._tryGoHome('watch', chk, now);
  }
  _onPositionRestored(chk, now) {
    const o = this._homeOutage;
    this._posLost = false;
    this._homeOutage = null;
    this._homeNextAt = 0;
    const secs = o ? Math.max(1, Math.round((now - o.since) / 1000)) : 0;
    this.log('ok', `Đã về lại vị trí treo lồng${o ? ` sau ${secs}s${o.tries ? ` (đã gõ ${this.spawnHomeCommand} ${o.tries} lần)` : ''}` : ''} (${this._fmtPosCheck(chk)})`);
    if (o?.notified) {
      this._notify('homeReturn', `✅ ${this.cfg.id}: đã về lại vị trí treo lồng`,
        `Vị trí: ${this._fmtXYZ(this.mc?.entity?.position)}\n${o.tries ? `Đã gõ ${this.spawnHomeCommand} ${o.tries} lần, ` : ''}mất ${secs}s.\nautosell_spawn / spawnerprotect tiếp tục chạy.`, 0x22c55e);
    }
  }
  // Gõ spawnHomeCommand (mặc định "/home treolong") để quay về chỗ treo lồng. Có giãn cách, giới hạn số lần, không can thiệp khi đang bận.
  _tryGoHome(phase, chk, now = nowMs()) {
    if (!this.spawnHomeEnabled || !this.spawnHomeCommand) return false;
    const mc = this.mc;
    if (!mc || now < this._homeNextAt) return false;
    if (mc.isAlive === false || (mc.health ?? 20) <= 0) return false; // đang chết, chờ hồi sinh
    if (this._isBusy) return false;
    if (phase === 'gate' && now - this._menuDoneAt < this.spawnHomeGraceMs) return false; // cho server tự đưa bot về chỗ cũ trước đã
    if (this._tp.active || this._tp.frozen(now)) return false; // lần teleport trước còn đang đếm ngược — gõ thêm sẽ làm đếm lại từ đầu
    const o = this._homeOutage || (this._homeOutage = { since: now, tries: 0, notified: false });
    o.tries++;
    const slow = o.tries > this.spawnHomeMaxTries;
    const minGap = TP.PRESEND_MS + this._tp.deadlineMs + this._tp.settleMs + 1000; // không bao giờ gõ lại khi lần trước chưa kết thúc
    this._homeNextAt = now + Math.max(minGap, slow ? this.spawnHomeSlowMs : this.spawnHomeCooldownMs);
    const cmd = this.spawnHomeCommand.startsWith('/') ? this.spawnHomeCommand : `/${this.spawnHomeCommand}`;
    try { if (mc.currentWindow) mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); }
    // 1) đứng yên hoàn toàn  2) sau TP.PRESEND_MS mới gõ lệnh  3) giữ yên suốt thời gian đếm ngược (AFK nhảy/đi bị chặn bởi _tp.frozen)
    this._tpHoldStill(now);
    this._setTimer('tpSend', () => {
      if (!this.isOnline || this.mc !== mc) return;
      try {
        mc.chat(cmd);
        this._tp.begin({ cmd, pos: mc.entity?.position, now: nowMs() });
        this.log('sys', `Không ở gần vị trí treo lồng — đã gõ ${cmd} (lần ${o.tries}${slow ? ', thử thưa' : ''}) — đứng yên chờ teleport ${(this.spawnHomeWarmupMs / 1000).toFixed(0)}s...`);
      } catch (e) {
        this.log('err', `Lỗi gửi ${cmd}: ${e.message}`);
      }
    }, TP.PRESEND_MS);
    if (phase === 'watch' && !o.notified) {
      o.notified = true;
      this._notify('homeReturn', `🏠 ${this.cfg.id}: lệch khỏi vị trí treo lồng — gõ ${cmd}`,
        `Bot không còn ở gần lồng (${this._fmtPosCheck(chk)}).\nVị trí hiện tại: ${this._fmtXYZ(mc.entity?.position)}\nĐã tự gõ ${cmd} để quay về.`, 0x38bdf8);
    }
    if (o.tries === this.spawnHomeMaxTries + 1) {
      this._spawnerAlert('homeFail', 600000, `🚨 ${this.cfg.id}: gõ ${cmd} nhiều lần vẫn không về được vị trí treo lồng`,
        `Đã gõ ${o.tries - 1} lần, bot vẫn không ở gần lồng (${this._fmtPosCheck(chk)}).\nVị trí hiện tại: ${this._fmtXYZ(mc.entity?.position)}\nKiểm tra home "${cmd}" còn tồn tại không / bot có bị kẹt ở khu khác không. Bot sẽ thử lại thưa dần (${Math.round(this.spawnHomeSlowMs / 60000)} phút/lần).`, 0xef4444);
    }
    return true;
  }
  _persistAutoLoginCfg() {
    const data = { autoLogin: this.cfg.autoLogin };
    const mgr = this._manager;
    const c = mgr?._config?.bots?.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) Object.assign(c, data);
    mgr?.persistence?.markDirty();
  }
  _persistSpawnHomeCfg() {
    const data = { spawnHomeEnabled: this.spawnHomeEnabled, spawnHomeCommand: this.spawnHomeCommand };
    Object.assign(this.cfg, data);
    const mgr = this._manager;
    const list = mgr?._config?.bots;
    if (!list) return;
    const c = list.find(x => String(x.id).toLowerCase() === String(this.cfg.id).toLowerCase());
    if (c) Object.assign(c, data);
    mgr.persistence?.markDirty();
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
    } catch (e) { dbg('BotSession', e); }
  }
  afkJump() {
    this._clearTimer('afk');
    this._clearTimer('wafk');
    this.state.afk = 'jump';
    this.state.intendedAfk = 'jump';
    const mc = this.mc;
    const tick = () => {
      if (!this.isOnline || this.state.afk !== 'jump') return;
      if (this._afkPaused(nowMs())) { this._setTimer('afk', tick, 500); return; } // đang chờ teleport / đang bán / đang nhắm lồng: không nhảy/xoay
      try {
        mc.setControlState('jump', true);
        this._setTimer('afkJumpOff', () => {
          try { if (this.isOnline) mc.setControlState('jump', false); } catch (e) { dbg('BotSession', e); }
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
            try { if (this.isOnline) mc.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); }
          }, rand(300, 900));
        }
        this._afkNoise(mc);
      } catch (e) {
        this.log('err', 'AFK jump lỗi: ' + e.message);
      }
      this._setTimer('afk', tick, jit(4800, 2000));
    };
    this._setTimer('afk', tick, jit(700, 200));
    this.log('afk', 'Jump AFK bật');
    this.emit('afk', { id: this.cfg.id, mode: 'jump' });
    this._emitIO('afk', { id: this.cfg.id, mode: 'jump' });
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
      if (this._afkPaused(nowMs())) { lastPos = null; stuckTicks = 0; this._setTimer('wafk', tick, 500); return; } // đang chờ teleport / đang bán / đang nhắm lồng: không đi/xoay
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
            try { if (this.isOnline) mc.setControlState(k, false); } catch (e) { dbg('BotSession', e); }
          }, rand(200, 950));
        }
        if (Math.random() < 0.04) {
          mc.setControlState('jump', true);
          this._setTimer('wafkJump', () => {
            try { if (this.isOnline) mc.setControlState('jump', false); } catch (e) { dbg('BotSession', e); }
          }, rand(100, 300));
        }
        if (Math.random() < 0.05) mc.swingArm();
        this._afkNoise(mc);
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
    this._emitIO('afk', { id: this.cfg.id, mode: 'walk' });
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
    } catch (e) { dbg('BotSession', e); }
    this.state.afk = null;
    this.state.intendedAfk = null;
    this.log('sys', 'AFK đã dừng');
    this.emit('afk', { id: this.cfg.id, mode: null });
    this._emitIO('afk', { id: this.cfg.id, mode: null });
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
    try { this.afkStop(); } catch (e) { dbg('BotSession', e); }
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
    r.register('sessioncheck', 'Quản lý SessionCheck verify: sessioncheck on|off|status', (args) => {
      const sub = (args[0] || 'status').toLowerCase();
      if (sub === 'on') {
        this.sessionVerifier.setEnabled(true);
      } else if (sub === 'off') {
        this.sessionVerifier.setEnabled(false);
      } else {
        const on = this.sessionVerifier._active;
        this.log('sys', `SessionCheck verify: ${on ? 'BẬT' : 'TẮT'} | Lệnh: sessioncheck on|off`);
      }
    });
    r.register('checkstats', 'Xem stats của người chơi khác (đọc GUI /stats <tên>): checkstats <người chơi>', (args) => {
      const name = String(args[0] || '').trim();
      if (!name) { this.log('warn', 'Cú pháp: checkstats <người chơi>'); return; }
      if (!this.requireOnline('checkstats')) return;
      this.statsReader.request(name).then(r => {
        this.log('ok', `Stats của ${r.player}${r.title ? ` [${r.title}]` : ''}:`);
        for (const l of r.lines) this.log('sys', `  ${l}`);
        this.emit('playerStats', { id: this.cfg.id, ...r });
        this._emitIO('playerStats', { id: this.cfg.id, ...r });
      }).catch(e => this.log('warn', `checkstats ${name}: ${e.message}`));
    });
    r.register('autologin', 'Auto Login & Antibot & Auto Join: autologin on|off|status|now', (args) => {
      const sub = String(args[0] || 'status').toLowerCase();
      const al = this.autoLogin;
      if (sub === 'on' || sub === 'off') {
        al.setEnabled(sub === 'on');
        this._persistAutoLoginCfg();
        this.log('ok', `AutoLogin ${sub === 'on' ? 'BẬT' : 'TẮT'} — có hiệu lực từ lần kết nối kế tiếp (gõ "reconnect" để áp dụng ngay)`);
      } else if (sub === 'now' || sub === 'join') {
        if (!al.enabled) this.log('warn', 'AutoLogin đang tắt — gõ: autologin on');
        else if (!this.isOnline) this.log('warn', 'Bot chưa online');
        else if (!al.joinNow()) this.log('warn', 'AutoLogin đang chạy dở — chờ xong rồi thử lại');
      } else {
        this.log('sys', al.status() + ' | Lệnh: autologin on|off|now');
      }
    });
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
              try { this.mc.closeWindow(win); } catch (e) { dbg('BotSession', e); }
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
          const min = this._parseEveryMinutes(args);
          if (min === null) { this.log('warn', 'Cú pháp: autosell revenue every <thời gian> | off — vd: 30m, 1h'); return; }
          if (min === 'off') { this.autoSellReportMin = 0; this._persistMacroSellCfg(); this.log('ok', 'Báo cáo doanh thu auto-sell: gửi sau MỖI lần bán'); return; }
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
      if (!this.scriptRunner.list().some(n => n.toLowerCase() === macroName.toLowerCase())) {
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
    r.register('autoorder', 'Tự giao đơn /order giá cao nhất cho 1 vật phẩm: autoorder <item> | autoorder off | autoorder status', (args) => {
      const sub = String(args[0] || '').toLowerCase();
      if (!sub || sub === 'status') { this.log('sys', this.autoOrder.active ? `AutoOrder [${this.autoOrder.item}]: ${this.autoOrder.summary()}` : 'AutoOrder đang tắt. Cú pháp: autoorder <item, vd blaze_rod>'); return; }
      if (sub === 'off' || sub === 'stop') { if (this.autoOrder.active) this.autoOrder.stop(); else this.log('sys', 'AutoOrder đang tắt'); return; }
      if (!this.isOnline) { this.log('warn', 'Bot chưa online'); return; }
      if (!this.autoOrder.start(args.join(' '))) this.log('warn', 'Cú pháp: autoorder <item>');
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
      if (macroName && !this.scriptRunner.list().some(n => n.toLowerCase() === macroName.toLowerCase())) {
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
    r.register('spawnerprotect', 'Bảo vệ lồng spawn: spawnerprotect on|off | level [1-4] | set <khoá> <giá trị|auto> | status', (args) => {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'level' || sub === 'muc' || sub === 'mức') {
        if (args[1] === undefined) { this.log('sys', `Cường độ hiện tại: ${this._spSummary()}`); for (const n of [1, 2, 3, 4]) this.log('sys', `  ${SG.LEVELS[n].icon} ${n} ${SG.LEVELS[n].name} — ${SG.LEVELS[n].desc}`); return; }
        const n = Number(args[1]);
        if (!SG.LEVELS[n]) { this.log('warn', 'Cú pháp: spawnerprotect level <1|2|3|4> [keep]  (keep = giữ các thông số đã chỉnh tay)'); return; }
        this.setSpawnerLevel(n, String(args[2] || '').toLowerCase() === 'keep');
        this.log('ok', `Bảo vệ Lồng Spawn: ${this._spSummary()}`);
        return;
      }
      if (sub === 'set') {
        const key = args[1], val = args[2];
        if (!key || !SG.SPEC[key] || val === undefined) { this.log('warn', `Cú pháp: spawnerprotect set <khoá> <giá trị|auto>. Khoá: ${SG.KEYS.join(', ')}`); return; }
        if (val !== 'auto' && SG.coerce(key, val) === undefined) { this.log('warn', `Giá trị không hợp lệ cho ${key} (${SG.SPEC[key].type === 'bool' ? 'on/off' : `${SG.SPEC[key].min}-${SG.SPEC[key].max}`})`); return; }
        this.setSpawnerTune({ [key]: val });
        this.log('ok', `Đã đặt ${key} = ${this._sp[key]}${key in this._spTune ? ' (chỉnh tay)' : ' (theo mức)'} — ${this._spSummary()}`);
        return;
      }
      if (sub === 'status' || sub === 'info') {
        this.log('sys', `— ${this._spSummary()} — ${this._spawnerProtectOn ? 'BẬT' : 'TẮT'}, ${this.protectedSpawners.length} lồng`);
        for (const k of SG.KEYS) this.log('sys', `  ${k} = ${this._sp[k]}${SG.SPEC[k].unit ? ' ' + SG.SPEC[k].unit : ''}${k in this._spTune ? '  *chỉnh tay' : ''}  — ${SG.SPEC[k].label}`);
        return;
      }
      if (!this.requireOnline('spawnerprotect')) return;
      if (sub === 'off') { this._stopSpawnerProtect(); return; }
      if (sub === 'on' || !sub) { this._startSpawnerProtect(); return; }
      this.log('warn', 'Cú pháp: spawnerprotect on|off | level [1-4] | set <khoá> <giá trị|auto> | status');
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
      this.log('sys', `— Đang bảo vệ ${this.protectedSpawners.length} lồng (${this._spawnerProtectOn ? 'BẬT' : 'TẮT'}) — ${this._spSummary()} —`);
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
    r.register('spawneresp', 'SpawnerESP: quét/phân loại lồng spawn — spawneresp on|off|status|list|filter BOTH|NATURAL|SMP', args => this._spawnerEspCommand(args));
    r.register('reconnect', 'Force reconnect', () => this.forceReconnect());
    r.register('menu', 'Gửi menu command thủ công', () => {
      if (!this.requireOnline('menu')) return;
      if (!this.cfg.menuCommand) { this.log('warn', 'Chưa có menuCommand'); return; }
      try {
        this._manualMenuUntil = nowMs() + 20000; // cho phép WindowRouter tự click ô menu cho lần gõ tay này (sau khi vào server, GUI lạ mặc định bị đóng chứ không click)
        this.mc.chat(this.cfg.menuCommand);
        this.log('sys', `Gửi menu: ${this.cfg.menuCommand}`);
      } catch (e) { this.log('err', e.message); }
    });
    r.register('spawnhome', 'Tự gõ /home treolong khi bot không còn ở gần lồng spawn: spawnhome on|off|now|status|cmd <lệnh>', (args) => {
      const sub = (args[0] || 'status').toLowerCase();
      if (sub === 'on' || sub === 'off') {
        this.spawnHomeEnabled = sub === 'on';
        this._persistSpawnHomeCfg();
        this.log('ok', `Tự về vị trí treo lồng: ${this.spawnHomeEnabled ? `BẬT (gõ ${this.spawnHomeCommand} khi không còn ở gần lồng)` : 'TẮT'}`);
        return;
      }
      if (sub === 'cmd' || sub === 'command') {
        const c = args.slice(1).join(' ').trim();
        if (!c) { this.log('sys', `Lệnh về vị trí treo lồng: ${this.spawnHomeCommand} — đổi: spawnhome cmd /home <tên>`); return; }
        this.spawnHomeCommand = c.startsWith('/') ? c : `/${c}`;
        this._persistSpawnHomeCfg();
        this.log('ok', `Lệnh về vị trí treo lồng: ${this.spawnHomeCommand}`);
        return;
      }
      if (sub === 'now') {
        if (!this.requireOnline('spawnhome')) return;
        const cmd = this.spawnHomeCommand.startsWith('/') ? this.spawnHomeCommand : `/${this.spawnHomeCommand}`;
        // Cùng quy trình với tự về home: thả phím -> gõ lệnh -> đứng yên suốt thời gian đếm ngược -> báo kết quả
        const mc = this.mc;
        this._tpHoldStill();
        this._setTimer('tpSend', () => {
          if (!this.isOnline || this.mc !== mc) return;
          try {
            mc.chat(cmd);
            this._tp.begin({ cmd, pos: mc.entity?.position, now: nowMs() });
            this.log('ok', `Đã gõ ${cmd} — đứng yên chờ teleport ${(this.spawnHomeWarmupMs / 1000).toFixed(0)}s...`);
          } catch (e) { this.log('err', `Lỗi gửi ${cmd}: ${e.message}`); }
        }, TP.PRESEND_MS);
        return;
      }
      if (sub === 'status') {
        const chk = this.isOnline && this.mc?.entity?.position ? this._checkSpawnPosition() : null;
        this.log('sys', `Tự về vị trí treo lồng: ${this.spawnHomeEnabled ? 'BẬT' : 'TẮT'} — lệnh ${this.spawnHomeCommand} | tính năng lồng: ${this._featuresActive ? 'ĐÃ bật (đang canh vị trí)' : 'chưa bật (đang chờ vào đúng vị trí / chưa xong menu)'}`);
        if (chk) this.log('sys', `Vị trí ${this._fmtXYZ(this.mc.entity.position)}: ${chk.hasTargets ? (chk.ok ? 'ĐANG ở gần lồng' : 'KHÔNG ở gần lồng') : 'không có lồng để đối chiếu'} (${this._fmtPosCheck(chk)})${this._homeOutage ? ` | đã gõ lệnh ${this._homeOutage.tries} lần cho lần lệch này` : ''}`);
        return;
      }
      this.log('warn', 'Cú pháp: spawnhome on|off|now|status | spawnhome cmd </home tên>');
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
      this.scriptRunner.run(args[0]).catch(e => this.log('err', `Macro lỗi: ${e.message}`));
    });
    r.register('answer', 'Trả lời câu hỏi macro đang chờ (ask/askmap/confirm): answer <nội dung>', (args) => {
      const text = args.join(' ');
      if (!text) { this.log('warn', 'Cú pháp: answer <nội dung>'); return; }
      if (!this.scriptRunner.answer(text)) {
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
          const min = this._parseEveryMinutes(args);
          if (min === null) { this.log('warn', 'Cú pháp: autosell_spawn revenue every <thời gian> | off — vd: 30m, 1h'); return; }
          if (min === 'off') { this.configureSellSpawn({ reportMin: 0 }); this.log('ok', 'Báo cáo doanh thu: gửi sau MỖI vòng bán'); return; }
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
      this.scriptRunner.stop();
      this.log('sys', 'Đã gửi yêu cầu dừng macro');
    });
    r.register('listmacro', 'Xem danh sách macro (config.json > macros)', () => {
      const names = this.scriptRunner.list();
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
      loginConfirmed: this._loginConfirmed,
      spawnFeaturesActive: this._featuresActive,
      spawnPositionLost: this._posLost,
      spawnHome: this.spawnHomeEnabled ? this.spawnHomeCommand : null,
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
