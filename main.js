'use strict';
const { resolveVersion } = require('./src/core/constants');
const { dbg } = require('./src/core/debug');
const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const Notifier = require('./src/core/Notifier');
const TelegramNotifier = require('./src/core/TelegramNotifier');
const HelpCatalog = require('./src/core/HelpCatalog');
const ChatFilter = require('./src/core/ChatFilter');
const FileLogger = require('./src/core/FileLogger');
const EnvironmentDetector = require('./src/core/EnvironmentDetector');
const WebDashboard = require('./src/web/WebDashboard');
const { parseAddBotArgs, ADDBOT_USAGE } = require('./src/core/CliUtils');
const {
  createUIRuntime,
  setDefaultRuntime,
  renderBotListView,
  renderSysInfoView,
  renderProxyListView,
  renderHelpView,
  maskSecret,
} = require('./src/ui');

let config = {};
let configLoadError = null;
try {
  // đọc từ thư mục dữ liệu (cwd) — khi chạy qua load.js, code nằm ở .anter/code còn config.json nằm cạnh load.js
  config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
} catch (e) {
  if (e && e.code !== 'ENOENT') configLoadError = e;
  config = {};
}

const AUTO_EXE = process.env.AUTO_EXE === '1' || config.autoExe === true;
const envDetector = new EnvironmentDetector(AUTO_EXE);

let manager = null;
let dashboard = null;
let rl = null;

const ui = createUIRuntime({
  config,
  getSecrets: () => {
    const list = [];
    if (config && config.botPassword) list.push(config.botPassword);
    if (config && config.dashboardToken) list.push(config.dashboardToken);
    if (manager && Array.isArray(manager.bots)) {
      for (const b of manager.bots) {
        if (b?.cfg?.botPassword) list.push(b.cfg.botPassword);
      }
    }
    return list;
  },
  getTz: () => (manager && typeof manager._scheduleTz === 'function' ? manager._scheduleTz() : (config.timezone || process.env.BOT_TZ || null)),
});
setDefaultRuntime(ui);

const { logger, writer, caps, theme } = ui;
const cliSpinner = ui.createSpinner();
let dashCtrl = null;

const chatFilter = new ChatFilter({
  enabled: config.chatLog !== false,
  mode: config.chatLogMode || 'smart',
});

function collectOnlinePlayers() {
  if (!manager || !Array.isArray(manager.bots)) return { players: [], onlineBotCount: 0 };
  const seen = new Set();
  const players = [];
  let onlineBotCount = 0;
  for (const b of manager.bots) {
    if (!b.isOnline) continue;
    onlineBotCount++;
    const pl = b.mc && b.mc.players;
    if (pl) {
      for (const name of Object.keys(pl)) {
        const low = name.toLowerCase();
        if (!seen.has(low)) { seen.add(low); players.push(name); }
      }
    }
  }
  return { players, onlineBotCount };
}

function printBotLog(botId, entry) {
  const level = (entry && entry.level) || 'sys';
  const time = (entry && entry.time) || Date.now();
  if (level === 'chat') {
    const { players, onlineBotCount } = collectOnlinePlayers();
    const dec = chatFilter.decide(botId, entry.msg, {
      time,
      onlinePlayers: players,
      onlineBotCount,
    });
    if (!dec.show) return;
    logger.server(entry.msg || '', { botId, time, serverChat: dec });
  } else {
    logger.log(level, (entry && entry.msg) || '', { botId, time });
  }
}

function wireBotEvents(bot) {
  if (!bot || bot._uiWired) return;
  bot._uiWired = true;
  bot.on('status', () => {
    writer.writeLines(renderBotListView([bot], caps, theme));
  });
}

function showHelp(query = '') {
  const reg = manager && manager.bots[0] ? manager.bots[0].cmdRegistry.list() : null;
  const helpData = HelpCatalog.buildHelp({ scope: 'console', query, registry: reg, customs: [] });
  writer.writeLines(renderHelpView(helpData, caps, theme));
}

function showBotList(bots) {
  writer.writeLines(renderBotListView(bots, caps, theme));
}

function showSysInfo(m) {
  const cap = manager && typeof manager.getBotCapacity === 'function' ? manager.getBotCapacity() : null;
  writer.writeLines(renderSysInfoView(m, cap, caps, theme));
}

// ===== addbot / delbot / web (localhost) cho CLI =====
function cliAddBot(args) {
  const printUsage = () => {
    logger.info('Usage: ' + ADDBOT_USAGE);
    logger.info('  vd: addbot 123 mk 123');
    logger.info('      addbot 123 mk 123 play.abc.vn 25565 1.21.1 Steve');
    logger.info('      addbot 123 mk 123 ip=play.abc.vn ver=1.21.1     (dấu - = bỏ qua, lấy mặc định)');
  };
  if (!args.length) { printUsage(); return null; }
  const r = parseAddBotArgs(args);
  if (!r.ok) { logger.error(r.error); printUsage(); return null; }
  const { id, username, password, host: hostArg, port: portArg, version: verArg, owner: ownerArg } = r.data;
  if (manager.findBot(id)) { logger.error(`ID "${id}" đã tồn tại`); return null; }
  const dup = manager.bots.find(b => String(b.cfg.username).toLowerCase() === username.toLowerCase());
  if (dup) { logger.error(`Tên "${username}" đã được bot "${dup.cfg.id}" dùng`); return null; }
  const tpl = (manager.bots[0] && manager.bots[0].cfg) || {};
  const root = manager._config || {};
  const host = hostArg || tpl.host || root.host;
  const port = portArg || parseInt(tpl.port || root.port || 25565, 10);
  const version = resolveVersion(verArg, tpl.version, root.version);
  const owner = ownerArg || tpl.ownerUsername || root.ownerUsername || '';
  if (!host) {
    logger.error(`Chưa biết IP server — thêm vào cuối lệnh, vd: addbot ${username} mk ${maskSecret(password)} play.abc.vn`);
    return null;
  }
  const bot = manager.createBot({ id, host, port, version, username, password, ownerUsername: owner });
  wireBotEvents(bot);
  try { if (manager.io) manager.io.emit('botAdded', bot.getSummary()); } catch (e) { dbg('main', e); }
  logger.success(`Đã thêm bot "${id}" (server ${host}:${port} | ver ${version || '(mặc định)'} | owner ${owner || '(chưa đặt)'})`);
  logger.info(`Chạy bot: start ${id}   (lần đầu bot tự gửi /dk rồi /dn)`);
  return bot;
}

function cliDelBot(args) {
  if (!args[0]) { logger.info('Usage: delbot <id>'); return; }
  const bot = manager.removeBot(args[0]);
  if (!bot) { logger.error('Bot not found: ' + args[0]); return; }
  try { if (manager.io) manager.io.emit('botRemoved', { id: bot.cfg.id }); } catch (e) { dbg('main', e); }
  logger.success('Đã xoá bot: ' + bot.cfg.id);
}

async function webCommand(sub) {
  sub = String(sub || 'status').toLowerCase();
  const url = `http://localhost:${dashboard.port}`;
  if (/^(on|bat|bật)$/.test(sub)) {
    if (dashboard.isRunning) { logger.warn('Web đang BẬT sẵn: ' + url); return; }
    cliSpinner.start(`Starting Web Dashboard on ${url}...`);
    const ok = await dashboard.start();
    cliSpinner.stop();
    if (ok) {
      manager.persistence.set('webDashboard', true);
      logger.success('Web BẬT → ' + url);
    } else {
      logger.error('Không bật được web (xem lỗi ở trên)');
    }
  } else if (/^(off|tat|tắt)$/.test(sub)) {
    if (!dashboard.isRunning) { logger.warn('Web đang TẮT sẵn'); return; }
    await dashboard.stop();
    manager.persistence.set('webDashboard', false);
    logger.success('Web TẮT — bot vẫn chạy bình thường (bật lại: web on)');
  } else if (sub === 'status') {
    if (dashboard.isRunning) logger.success('Web: BẬT → ' + url);
    else logger.warn('Web: TẮT (bật: web on)');
  } else {
    logger.info('Usage: web on | web off | web status');
  }
}

function dashCommand(args = []) {
  const sub = String(args[0] || '').toLowerCase();
  if (sub === 'live' || sub === 'watch') {
    if (dashCtrl) {
      const started = dashCtrl.startLive();
      if (!started && caps.interactive) {
        logger.info('Live dashboard is already active.');
      }
    }
    return;
  }
  if (sub === 'off' || sub === 'stop' || sub === 'close') {
    if (dashCtrl && dashCtrl.stopLive()) {
      logger.info('Đã đóng Live Dashboard.');
    } else {
      logger.info('Live Dashboard đang không bật.');
    }
    return;
  }
  if (dashCtrl) {
    dashCtrl.printSnapshot({ live: false });
  }
}

let _shuttingDown = false;
async function shutdown(code = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { cliSpinner.stop(); } catch { /* ignore */ }
  try { if (dashCtrl) dashCtrl.stopLive(); } catch { /* ignore */ }
  try { writer.restoreTerminal(); } catch { /* ignore */ }
  logger.info('Shutting down...');
  const watchdog = setTimeout(() => process.exit(code), 5000);
  if (watchdog.unref) watchdog.unref();
  try { if (manager) manager.runtimeLog('sys', code === 42 ? 'Antertool đang tắt để cập nhật bản mới...' : 'Antertool đang tắt...'); } catch (e) { dbg('main', e); }
  try { if (dashboard) dashboard.shutdown(); } catch (e) { dbg('main', e); }
  try { if (manager) manager.shutdown(); } catch (e) { dbg('main', e); }
  try { if (dashboard) await dashboard.stop(); } catch (e) { dbg('main', e); }
  try { if (manager) await manager.flushTelegramLogs(3000); } catch (e) { dbg('main', e); }
  try { writer.destroy(); caps.destroy(); } catch { /* ignore */ }
  process.exit(code);
}

(async () => {
  const startup = ui.createStartupTracker();
  let expressApp, expressServer, io;
  let webWanted = false;
  let webOk = false;

  try {
    // Step 1: Environment & Runtime check (tái sử dụng envDetector chung với BotManager)
    await startup.runStep('Environment', (ctx) => {
      const env = envDetector.detect();
      ctx.ok(`Node ${env.nodeVersion} · ${env.platform}/${env.arch} · ${env.cpuCount} cores, ${env.totalMemMB}MB RAM`);
    });

    // Step 2: Configuration check
    await startup.runStep('Configuration', (ctx) => {
      if (configLoadError) {
        ctx.warn(`config.json parse warning: ${configLoadError.message}`, 'Check config.json syntax');
        return;
      }
      const { validateConfig } = require('./src/core/ConfigValidator');
      const v = validateConfig(config);
      const botCount = Array.isArray(config.bots) ? config.bots.length : 0;
      const hostInfo = config.host ? `${config.host}:${config.port || 25565}` : 'default host';
      if (!v.ok) {
        ctx.warn(`${botCount} bots (${hostInfo}) · ${v.errors.length} schema warning(s)`, v.errors[0]);
      } else {
        ctx.ok(`${botCount} bots configured (${hostInfo})`);
      }
    });

    // Step 3: Dependencies & Web Socket Server
    await startup.runStep('Web Socket Server', (ctx) => {
      let express, socketIo;
      try {
        express = require('express');
        socketIo = require('socket.io');
      } catch (e) {
        const err = new Error(`express/socket.io required: ${e.message}`);
        err.hint = 'Run "npm ci" or "npm install" to install required dependencies.';
        throw err;
      }
      expressApp = express();
      expressServer = http.createServer(expressApp);
      const security = require('./src/web/security');
      const corsOrigins = security.allowedOrigins();
      io = new socketIo.Server(expressServer, {
        ...(corsOrigins.length ? { cors: { origin: corsOrigins } } : {}),
        allowRequest: security.allowSocketRequest,
        transports: ['websocket', 'polling'],
        pingTimeout: 20000,
        pingInterval: 10000,
        maxHttpBufferSize: 1e6,
        connectTimeout: 30000,
        allowEIO3: true,
      });
      ctx.ok(`Express + Socket.IO ready (${corsOrigins.length ? `${corsOrigins.length} CORS origin(s)` : 'same-origin'})`);
    });

    // Step 4: Core Modules & BotManager initialization
    await startup.runStep('Core Modules', async (ctx) => {
      const BotManager = require('./src/services/BotManager');
      const prevSilent = process.env.SILENT_CONFIG;
      process.env.SILENT_CONFIG = '1'; // tránh log trùng cảnh báo config lần 2 vì Step 2 đã kiểm tra
      try {
        manager = new BotManager({
          configPath: path.join(process.cwd(), 'config.json'),
          autoExe: AUTO_EXE,
          envDetector,
          io,
          onBotLog: printBotLog,
        });
        await manager.init();
      } finally {
        if (prevSilent === undefined) delete process.env.SILENT_CONFIG;
        else process.env.SILENT_CONFIG = prevSilent;
      }
      for (const b of manager.bots) wireBotEvents(b);

      const proxyCount = manager.proxyManager && Array.isArray(manager.proxyManager.list)
        ? manager.proxyManager.list.length
        : 0;
      if (manager.fileLogs.enabled) {
        const logErr = manager.fileLogs.probe();
        if (logErr) {
          ctx.warn(
            `${manager.bots.length} bots, ${proxyCount} proxies · FileLog error: ${logErr}`,
            'Termux: run "termux-setup-storage" or change "fileLogDir"/ANTER_LOG_DIR'
          );
          return;
        }
        ctx.ok(`${manager.bots.length} bots, ${proxyCount} proxies · Log: ${manager.fileLogs.currentFile}`);
      } else {
        ctx.ok(`${manager.bots.length} bots, ${proxyCount} proxies · FileLog disabled`);
      }
    });

    // Step 5: Web Dashboard
    await startup.runStep('Web Dashboard', async (ctx) => {
      dashboard = new WebDashboard(manager, {
        expressApp,
        io,
        expressServer,
        port: process.env.PORT || (config.settings && config.settings.webPort) || 3000,
        autoExe: AUTO_EXE,
      });
      manager.dashboard = dashboard;
      webWanted = AUTO_EXE || !process.stdin.isTTY || manager._config.webDashboard !== false;
      if (!webWanted) {
        ctx.skip('Disabled in config — type "web on" to enable');
        return;
      }
      webOk = await dashboard.start();
      if (webOk) {
        ctx.connected(`http://localhost:${dashboard.port}`);
      } else {
        ctx.warn(
          `Port ${dashboard.port} unavailable — CLI remains active`,
          'Type "web on" later or check if another instance is using the port'
        );
      }
    }, { required: false });

    const readyText = `Antares Manager started — ${manager.bots.length} bots loaded, none auto-started${webOk ? ` · Web: http://localhost:${dashboard.port}` : ''}`;
    startup.print({ readyText });

    manager.runtimeLog('ok', `Antertool khởi động — ${manager.bots.length} bot đã nạp (chưa tự chạy) · Node ${process.version} · ${process.platform}/${process.arch}`);

    dashCtrl = ui.createDashboardController(manager, { chatFilter });
    if ((caps.flags && caps.flags.dashboard) || /^(1|true|on)$/i.test(String(process.env.ANTER_TUI || ''))) {
      dashCtrl.startLive();
    }

    if (!AUTO_EXE && process.stdin.isTTY) {
      const promptSymbol = caps.unicode ? '⬡ ' : '> ';
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: theme.accent(promptSymbol),
        terminal: true,
      });
      writer.setReadline(rl);
      manager.cliAsk = (msg) => logger.info(msg);
      rl.on('line', line => {
        const input = String(line || '').trim();
        if (manager.hasWebhookPrompt && manager.answerWebhookPrompt(input)) { rl.prompt(); return; }
        if (!input) { rl.prompt(); return; }
        const parts = input.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        try {
          switch (cmd) {
            case 'help':
            case 'h':
            case '?':
              showHelp(args.join(' '));
              break;
            case 'list':
            case 'ls':
              showBotList(manager.bots);
              break;
            case 'dash':
            case 'status':
            case 'tui':
              dashCommand(args);
              break;
            case 'addbot':
            case 'add':
              cliAddBot(args);
              break;
            case 'delbot':
            case 'rmbot':
            case 'removebot':
              cliDelBot(args);
              break;
            case 'dashboard': {
              const sub0 = String(args[0] || '').toLowerCase();
              if (!sub0 || sub0 === 'live' || sub0 === 'watch' || (sub0 === 'off' && dashCtrl && dashCtrl.isActive)) {
                dashCommand(args);
                break;
              }
              webCommand(args[0])
                .catch(e => logger.error('Error: ' + e.message))
                .then(() => { if (rl) rl.prompt(true); });
              return;
            }
            case 'web':
            case 'localhost':
            case 'lochost':
              webCommand(args[0])
                .catch(e => logger.error('Error: ' + e.message))
                .then(() => { if (rl) rl.prompt(true); });
              return;
            case 'update': {
              if (!process.env.ANTER_LOADER) { logger.warn('Cần chạy bằng load.js: node load.js (hoặc npm start) mới dùng được lệnh update'); break; }
              logger.info('Đang kiểm tra GitHub...');
              cliSpinner.start('Đang kiểm tra cập nhật trên GitHub...');
              require(process.env.ANTER_LOADER).checkForUpdate().then(info => {
                cliSpinner.stop();
                if (!info.available) logger.success('Đang là bản mới nhất');
                else { logger.success(`Có bản mới: ${info.message} — đang thoát để cập nhật...`); shutdown(42); return; }
                if (rl) rl.prompt(true);
              }).catch(e => {
                cliSpinner.stop();
                logger.error('Không kiểm tra được: ' + e.message);
                if (rl) rl.prompt(true);
              });
              return;
            }
            case 'start': {
              if (!args[0]) { logger.info('Usage: start <id>'); break; }
              const b = manager.findBot(args[0]);
              if (!b) { logger.error('Bot not found: ' + args[0]); break; }
              if (b.isConnected || b.isReconnecting) { logger.warn('Bot already running'); break; }
              b._disabled = false; b.state.reconnects = 0; b.start();
              logger.success('Started: ' + args[0]);
              break;
            }
            case 'stop': {
              if (!args[0]) { logger.info('Usage: stop <id>'); break; }
              const b = manager.findBot(args[0]);
              if (!b) { logger.error('Bot not found: ' + args[0]); break; }
              b.shutdown();
              logger.warn('Stopped: ' + args[0]);
              break;
            }
            case 'cmd': {
              if (args.length < 2) { logger.info('Usage: cmd <id> <command>'); break; }
              const b = manager.findBot(args[0]);
              if (!b) { logger.error('Bot not found: ' + args[0]); break; }
              b.cmd(args.slice(1).join(' '));
              break;
            }
            case 'cmdall': {
              if (!args.length) { logger.info('Usage: cmdall <command> (vd: cmdall macro tpa_dahas)'); break; }
              const cmdText = args.join(' ');
              const online = manager.bots.filter(b => b.isOnline);
              if (!online.length) { logger.warn('Không có bot nào đang ONLINE'); break; }
              logger.info(`"${cmdText}" → ${online.length} bot: ${online.map(b => b.cfg.id).join(', ')}`);
              online.forEach(b => b.cmd(cmdText));
              break;
            }
            case 'schedule': {
              if (args[0] === 'on' && args[1] && args[2]) {
                const timeRe = /^([01]?\d|2[0-3]):([0-5]\d)$/;
                if (!timeRe.test(args[1]) || !timeRe.test(args[2])) {
                  logger.warn('Giờ không hợp lệ — dùng dạng HH:MM (24h), vd 23:00');
                  break;
                }
                const s = manager.setSchedule(true, args[1], args[2]);
                logger.success(`Lịch nghỉ: out lúc ${s.outTime}, vô lại lúc ${s.inTime} (múi giờ ${manager._scheduleTz()})`);
              } else if (args[0] === 'off') {
                manager.setSchedule(false, null, null);
                logger.success('Đã tắt lịch tự out/vào');
              } else {
                const s = manager.getSchedule();
                logger.info(s.enabled ? `Đang bật: out ${s.outTime} — vô lại ${s.inTime}` : 'Đang tắt');
                logger.info('Usage: schedule on <HH:MM out> <HH:MM in> | schedule off');
              }
              break;
            }
            case 'telegram':
            case 'tg': {
              const tg = manager.telegram;
              const sub = String(args[0] || '').toLowerCase();
              const tgUsage = () => {
                logger.info('Usage: telegram set <token> [chatId] | chatid | test | panel | off');
                logger.info('       telegram every <1s|10s|10m|off>  (nhịp cập nhật bảng) | mode edit|new | events [a,b,c] | commands on|off');
                logger.info('       telegram users [add|remove] [admin|viewer] <userId> | mute <30m|1h|off> | control on|off | symbols unicode|ascii');
                logger.info('       telegram logs [on|off|level|chat|bots|every|keep|now|silent|send|test]  (log runtime gửi lên Telegram — gõ: telegram logs)');
              };
              if (sub === 'set' && args[1]) {
                if (!TelegramNotifier.looksLikeToken(args[1])) { logger.warn('Token không đúng dạng — lấy từ @BotFather (vd 123456789:AAH...)'); break; }
                manager.setTelegram(args[1], args[2] !== undefined ? args[2] : undefined);
                if (tg.enabled) {
                  cliSpinner.start('Đang kiểm tra kết nối Telegram...');
                  tg.test().then(r => {
                    cliSpinner.stop();
                    if (r.ok) logger.success(r.message); else logger.error(r.message);
                  });
                } else {
                  logger.success('Đã lưu token');
                  logger.info('Bước tiếp: mở Telegram, nhắn /start cho bot của bạn, rồi gõ: telegram chatid');
                }
              } else if (sub === 'chatid') {
                if (!tg.hasToken) { logger.warn('Chưa có token — dùng: telegram set <token>'); break; }
                cliSpinner.start('Đang dò chat_id từ Telegram...');
                tg.discoverChats().then(r => {
                  cliSpinner.stop();
                  if (!r.ok) return logger.error(r.message);
                  if (!r.chats.length) return logger.warn('Chưa thấy tin nhắn nào gửi cho bot — mở Telegram, nhắn /start cho bot rồi gõ lại: telegram chatid');
                  if (r.chats.length === 1 || args[1]) {
                    const pick = args[1] ? r.chats.find(c => c.id === String(args[1])) : r.chats[0];
                    if (!pick) return logger.warn('Không thấy chat_id đó. Có: ' + r.chats.map(c => `${c.id} (${c.title})`).join(', '));
                    manager.setTelegram(undefined, pick.id);
                    logger.success(`Đã lưu chat_id ${pick.id} (${pick.title})`);
                    tg.test().then(t => { if (t.ok) logger.success(t.message); else logger.error(t.message); });
                  } else {
                    logger.info('Thấy nhiều chat — chọn bằng: telegram chatid <id>');
                    for (const c of r.chats) logger.info(`  ${c.id}  ${c.title}`);
                  }
                });
              } else if (sub === 'off') {
                manager.setTelegram(null, null);
                logger.success('Đã tắt Telegram (xoá token + chat_id khỏi config)');
              } else if (sub === 'test') {
                if (!tg.hasToken) { logger.warn('Chưa cấu hình — dùng: telegram set <token>'); break; }
                cliSpinner.start('Đang gửi tin thử tới Telegram...');
                tg.test().then(r => {
                  cliSpinner.stop();
                  if (r.ok) logger.success(r.message); else logger.error(r.message);
                });
              } else if (sub === 'panel' || sub === 'send') {
                if (!tg.enabled) { logger.warn('Chưa cấu hình Telegram — dùng: telegram set <token>'); break; }
                const n = manager.refreshTelegramPanels({ fresh: true });
                if (n) logger.success(`Đã gửi ${n} bảng Auto sell spawner`);
                else logger.warn('Chưa có bot nào bật autosell_spawn / có doanh thu để lập bảng');
              } else if (sub === 'every') {
                const v = String(args[1] || '').toLowerCase();
                const sec = (v === 'off' || v === '0') ? 0 : manager.constructor.parseEverySec(args.slice(1).join(''));
                if (sec === null || sec === undefined) { logger.warn('Cú pháp: telegram every <1s|10s|10m|off>  (số trần = giây)'); break; }
                manager.setTelegramOption('telegramRefreshSec', sec);
                logger.success(sec ? `Bảng cập nhật mỗi ${sec} giây${manager._config?.telegramMode === 'new' ? '  (chú ý: mode new không cập nhật theo nhịp — gõ: telegram mode edit)' : ''}` : 'Tắt cập nhật theo nhịp (vẫn cập nhật sau mỗi vòng bán / khi đổi trạng thái)');
                if (sec && sec < 3 && manager.bots.length > 1) logger.info(`Lưu ý: Telegram chỉ cho ~1 lần sửa/giây/chat → ${manager.bots.length} bot sẽ được sửa xoay vòng (mỗi bảng ~${manager.bots.length * sec}s/lần)`);
              } else if (sub === 'mode') {
                const m = String(args[1] || '').toLowerCase();
                if (m !== 'edit' && m !== 'new') { logger.warn('Cú pháp: telegram mode edit|new  (edit = 1 bảng/bot sửa tại chỗ, new = mỗi lần 1 tin mới có thông báo)'); break; }
                manager.setTelegramOption('telegramMode', m);
                logger.success('Chế độ bảng: ' + m);
              } else if (sub === 'logs' || sub === 'log') {
                const levelByKind = { ok: 'SUCCESS', warn: 'WARNING', err: 'ERROR', muted: 'INFO' };
                manager.telegramLogsCommand(args.slice(1)).then(lines => {
                  for (const [kind, text] of lines) {
                    logger.log(levelByKind[kind] || 'INFO', String(text || '').trim());
                  }
                  if (rl) rl.prompt(true);
                });
              } else if (sub === 'events') {
                if (!args[1]) {
                  logger.info('Đang bật: ' + [...tg.events].join(', '));
                  logger.info('Tất cả loại: ' + Object.keys(TelegramNotifier.EVENT_LABELS).join(', '));
                } else {
                  const list = args[1].split(',').map(x => x.trim()).filter(Boolean);
                  manager.setTelegramOption('telegramEvents', list);
                  logger.success('Đã đặt loại sự kiện: ' + list.join(', '));
                }
              } else if (sub === 'commands') {
                const on = String(args[1] || '').toLowerCase();
                if (on !== 'on' && on !== 'off') { logger.warn('Cú pháp: telegram commands on|off  (nhận lệnh từ Telegram)'); break; }
                manager.setTelegramOption('telegramCommands', on === 'on');
                logger.success('Nhận lệnh Telegram: ' + (on === 'on' ? 'BẬT' : 'TẮT'));
              } else if (sub === 'control') {
                const on = String(args[1] || '').toLowerCase();
                if (on !== 'on' && on !== 'off') { logger.warn('Cú pháp: telegram control on|off  (bật/tắt quyền điều khiển bot qua Telegram)'); break; }
                manager.setTelegramOption('telegramControlEnabled', on === 'on');
                logger.success('Điều khiển bot từ Telegram: ' + (on === 'on' ? 'BẬT' : 'TẮT'));
              } else if (sub === 'symbols') {
                const mode = String(args[1] || '').toLowerCase();
                if (mode !== 'unicode' && mode !== 'ascii') { logger.warn('Cú pháp: telegram symbols unicode|ascii'); break; }
                manager.setTelegramOption('telegramSymbols', mode);
                logger.success('Bộ ký hiệu Telegram: ' + mode);
              } else if (sub === 'mute') {
                const v = String(args[1] || '').toLowerCase();
                if (!v) {
                  const until = Number(manager._config?.telegramMuteUntil || 0);
                  logger.info(until > Date.now() ? `Đang tắt tiếng tới ${new Date(until).toLocaleTimeString()}` : 'Đang bật âm báo bình thường');
                  logger.info('Cú pháp: telegram mute <30m|1h|off>');
                } else if (v === 'off' || v === '0') {
                  manager.setTelegramOption('telegramMuteUntil', 0);
                  logger.success('Đã bật lại âm báo Telegram');
                } else {
                  const sec = manager.constructor.parseEverySec(args.slice(1).join(''));
                  if (!sec || sec <= 0) { logger.warn('Cú pháp: telegram mute <30m|1h|off>'); break; }
                  const until = Date.now() + sec * 1000;
                  manager.setTelegramOption('telegramMuteUntil', until);
                  logger.success(`Đã tắt tiếng thông báo Telegram trong ${sec}s`);
                }
              } else if (sub === 'users' || sub === 'user') {
                const act = String(args[1] || '').toLowerCase();
                const role = String(args[2] || '').toLowerCase();
                const uid = String(args[3] || '').trim();
                const admins = Array.isArray(manager._config?.telegramAdmins) ? [...manager._config.telegramAdmins] : [];
                const viewers = Array.isArray(manager._config?.telegramAllowedUsers) ? [...manager._config.telegramAllowedUsers] : [];
                if (!act) {
                  logger.info(`Admins (${admins.length}): ${admins.join(', ') || '(trống)'}`);
                  logger.info(`Viewers (${viewers.length}): ${viewers.join(', ') || '(mặc định: mọi thành viên trong chat)'}`);
                  logger.info('Cú pháp: telegram users add|remove admin|viewer <userId>');
                } else if ((act === 'add' || act === 'remove' || act === 'del') && (role === 'admin' || role === 'viewer') && uid) {
                  const key = role === 'admin' ? 'telegramAdmins' : 'telegramAllowedUsers';
                  const list = new Set((role === 'admin' ? admins : viewers).map(String));
                  if (act === 'add') list.add(uid); else list.delete(uid);
                  manager.setTelegramOption(key, [...list]);
                  manager.telegramControl?.resetSecurityState?.();
                  logger.success(`Đã ${act === 'add' ? 'thêm' : 'xoá'} ${role} ${uid} (${key}: ${[...list].join(', ') || 'trống'})`);
                } else {
                  logger.warn('Cú pháp: telegram users [add|remove] [admin|viewer] <userId>');
                }
              } else {
                tgUsage();
                logger.info('Trạng thái: ' + (tg.enabled ? 'BẬT' : (tg.hasToken ? 'có token, thiếu chat_id (gõ: telegram chatid)' : 'TẮT'))
                  + (tg.enabled ? ` · chế độ ${manager._config?.telegramMode === 'new' ? 'new' : 'edit'} · cập nhật mỗi ${manager._config?.telegramRefreshSec ?? 1}s` : ''));
              }
              break;
            }
            case 'webhook': {
              const notifier = manager.notifier;
              if (args[0] === 'revenue') {
                const rn = manager.revenueNotifier;
                if (args[1] === 'set' && args[2]) {
                  rn.configure(args[2], ['all']);
                  manager.persistence.set('revenueWebhookUrl', args[2]);
                  logger.success('Đã lưu webhook doanh thu (riêng)');
                } else if (args[1] === 'off') {
                  rn.configure(null, ['all']);
                  manager.persistence.set('revenueWebhookUrl', null);
                  logger.success('Đã tắt webhook doanh thu riêng — báo cáo sẽ đi qua webhook chung (nếu có)');
                } else if (args[1] === 'report' || args[1] === 'send') {
                  const r = manager.sendRevenueSummary();
                  if (r.ok) logger.success(`Đã gửi báo cáo tổng hợp doanh thu (${r.via})`);
                  else logger.warn(r.message);
                } else if (args[1] === 'every') {
                  const v = String(args[2] || '').toLowerCase();
                  const min = (v === 'off' || v === '0') ? 0 : manager.constructor.parseEveryMin(args.slice(2).join(''));
                  if (min === null || min === undefined) { logger.warn('Cú pháp: webhook revenue every <30m|1h|1h30m|off>'); break; }
                  manager.setRevenueSummaryEvery(min);
                  logger.success(min ? `Tự gửi báo cáo tổng hợp mỗi ${min >= 60 && min % 60 === 0 ? (min / 60) + ' giờ' : min + ' phút'} (chỉ gửi khi có vòng bán mới)` : 'Đã tắt tự gửi báo cáo tổng hợp');
                } else if (args[1] === 'test') {
                  if (!rn.enabled) { logger.warn('Chưa đặt webhook doanh thu riêng — dùng: webhook revenue set <url>'); break; }
                  cliSpinner.start('Đang gửi test webhook doanh thu...');
                  rn.test().then(ok => {
                    cliSpinner.stop();
                    if (ok) logger.success('Đã gửi test, kiểm tra kênh Discord');
                    else logger.error('Gửi thất bại — kiểm tra lại URL');
                  });
                } else {
                  logger.info('Usage: webhook revenue set <url> | test | off | report | every <30m|1h|off>');
                  logger.info('Tự gửi tổng hợp: ' + (manager._config?.revenueSummaryEveryMin ? `mỗi ${manager._config.revenueSummaryEveryMin} phút` : 'TẮT'));
                  logger.info('Trạng thái: ' + (rn.enabled ? 'BẬT (webhook riêng)' : (notifier.enabled ? 'dùng webhook chung' : 'TẮT')));
                }
                break;
              }
              if (args[0] === 'set' && args[1]) {
                notifier.configure(args[1], [...notifier.events]);
                manager.persistence.set('webhookUrl', args[1]);
                logger.success('Đã lưu webhook');
              } else if (args[0] === 'off') {
                notifier.configure(null, [...notifier.events]);
                manager.persistence.set('webhookUrl', null);
                logger.success('Đã tắt webhook');
              } else if (args[0] === 'test') {
                if (!notifier.enabled) { logger.warn('Chưa cấu hình webhook — dùng: webhook set <url>'); break; }
                cliSpinner.start('Đang gửi test webhook Discord...');
                notifier.test().then(ok => {
                  cliSpinner.stop();
                  if (ok) logger.success('Đã gửi test, kiểm tra kênh Discord');
                  else logger.error('Gửi thất bại — kiểm tra lại URL');
                });
              } else if (args[0] === 'preview') {
                if (!notifier.enabled) { logger.warn('Chưa cấu hình webhook — dùng: webhook set <url>'); break; }
                const onlyKey = args[1] ? String(args[1]).trim() : null;
                cliSpinner.start('Đang gửi bộ mẫu preview Discord...');
                notifier.preview({ onlyKey }).then(res => {
                  cliSpinner.stop();
                  if (res && res.total > 0 && res.sent > 0) logger.success(`Đã gửi ${res.sent}/${res.total} mẫu embed lên kênh Discord`);
                  else if (onlyKey) logger.warn(`Không tìm thấy mẫu cho sự kiện "${onlyKey}"`);
                  else logger.error('Gửi preview thất bại — kiểm tra lại URL webhook');
                });
              } else if (args[0] === 'mention' || args[0] === 'tag') {
                const v = args.slice(1).join(' ').trim();
                if (!v) {
                  logger.info('Tag hiện tại: ' + (notifier.mention || '(chưa đặt)') + ' — áp dụng cho: ' + [...notifier.mentionEvents].join(', '));
                  logger.info('Usage: webhook mention <ID Discord | @tên | off> | webhook mention test');
                  logger.info('Muốn PING thật phải dùng ID số (Discord: Cài đặt > Nâng cao > Chế độ nhà phát triển, rồi chuột phải tên > Sao chép ID). @tên chỉ hiện chữ.');
                } else if (v.toLowerCase() === 'test') {
                  if (!notifier.enabled) { logger.warn('Chưa cấu hình webhook — dùng: webhook set <url>'); break; }
                  cliSpinner.start('Đang gửi tin thử mention Discord...');
                  notifier.testMention().then(ok => {
                    cliSpinner.stop();
                    if (ok) logger.success('Đã gửi tin thử, kiểm tra kênh Discord');
                    else logger.error('Gửi thất bại — kiểm tra lại URL');
                  });
                } else {
                  notifier.setMention(v);
                  manager.persistence.set('webhookMention', v);
                  logger.success(notifier.mention ? 'Đã đặt tag: ' + notifier.mention + (/^<@/.test(notifier.mention) || /^@(everyone|here)$/.test(notifier.mention) ? '' : '  (chỉ hiện chữ, không ping — muốn ping hãy dùng ID số)') : 'Đã tắt tag');
                }
              } else if (args[0] === 'events') {
                if (!args[1]) {
                  logger.info('Đang bật: ' + [...notifier.events].join(', '));
                  logger.info('Tất cả loại: ' + Object.keys(Notifier.EVENT_LABELS).join(', '));
                } else {
                  const list = args[1].split(',').map(s => s.trim()).filter(Boolean);
                  notifier.configure(notifier.url, list);
                  manager.persistence.set('webhookEvents', list);
                  logger.success('Đã đặt loại sự kiện: ' + list.join(', '));
                }
              } else {
                logger.info('Usage: webhook set <url> | webhook test | webhook preview [sự_kiện] | webhook off | webhook events [a,b,c]');
                logger.info('Trạng thái: ' + (notifier.enabled ? 'BẬT' : 'TẮT'));
              }
              break;
            }
            case 'proxy':
              if (args[0] === 'list' || args[0] === 'ls') {
                const list = manager.proxyManager.getSummaries();
                writer.writeLines(renderProxyListView(list, caps, theme));
              } else if (args[0] === 'add' && args[1]) {
                const r = manager.proxyManager.add(args.slice(1).join(' '));
                if (r.ok) logger.success('Added: ' + r.msg);
                else logger.error('Error: ' + r.msg);
              } else if (args[0] === 'addfile' && args[1]) {
                const r = manager.proxyManager.addFile(args.slice(1).join(' '));
                if (r.ok) logger.success(r.msg);
                else logger.error(r.msg);
              } else {
                logger.info('Usage: proxy list | proxy add <proxy-string> | proxy addfile <path>');
              }
              break;
            case 'sys':
            case 'system':
              showSysInfo(manager.getSystemMetrics());
              break;
            case 'chatlog': {
              const sub = String(args[0] || '').toLowerCase().trim();
              if (!sub) {
                chatFilter.enabled = !chatFilter.enabled;
                if (chatFilter.enabled) logger.success(chatFilter.statusText());
                else logger.warn('Hiển thị chat: TẮT');
              } else if (sub === 'status') {
                logger.info(chatFilter.statusText());
                logger.info('Usage: chatlog [on|off|smart|player|all|clear|status]');
              } else if (sub === 'clear' || sub === 'reset') {
                chatFilter.reset();
                logger.success('Đã làm mới bộ nhớ lọc trùng chat');
              } else if (chatFilter.setMode(sub)) {
                if (chatFilter.enabled) logger.success(chatFilter.statusText());
                else logger.warn('Hiển thị chat: TẮT');
              } else {
                logger.info('Usage: chatlog [on|off|smart|player|all|clear|status]');
                logger.info('  • smart  (mặc định): gộp tin trùng giữa các bot + ẩn thông báo server lặp lại');
                logger.info('  • player           : chỉ hiện chat người chơi & phản hồi lệnh, ẩn toàn bộ thông báo server');
                logger.info('  • all              : hiện toàn bộ tin nhắn thô của từng bot');
              }
              break;
            }
            case 'filelog':
            case 'logdir': {
              const fl = manager.fileLogs;
              const sub = String(args[0] || 'status').toLowerCase().trim();
              if (sub === 'on' || sub === 'off') {
                manager.setFileLogOption('fileLogs', sub === 'on');
                if (fl.enabled) {
                  const err = fl.probe();
                  if (err) logger.warn('Không ghi được vào ' + fl.dir + ': ' + err);
                  else logger.success('Đã BẬT ghi log runtime → ' + fl.currentFile);
                } else {
                  logger.warn('Đã TẮT ghi log runtime ra file');
                }
              } else if (sub === 'dir' && args[1]) {
                const rawPath = args.slice(1).join(' ');
                const normPath = FileLogger.normalizeLogDir(rawPath, path.dirname(manager.configPath));
                manager.setFileLogOption('fileLogDir', normPath);
                const err = fl.probe();
                if (err) {
                  logger.warn('Đã đổi thư mục sang ' + fl.dir + ' nhưng chưa ghi được (' + err + '). Trên Termux hãy chạy: termux-setup-storage');
                } else {
                  logger.success('Đã tạo và ghi log runtime vào: ' + fl.currentFile);
                }
              } else if (sub === 'chat') {
                const v = String(args[1] || '').toLowerCase();
                if (v !== 'on' && v !== 'off') {
                  logger.info('Usage: filelog chat on|off');
                  break;
                }
                manager.setFileLogOption('fileLogChat', v === 'on');
                logger.success('Ghi chat người chơi vào file log: ' + (v === 'on' ? 'BẬT' : 'TẮT'));
              } else {
                const err = fl.enabled ? fl.probe() : null;
                logger.info('Log runtime ra file: ' + (fl.enabled ? (err ? 'LỖI (' + err + ')' : 'BẬT') : 'TẮT'));
                logger.info('Thư mục: ' + fl.dir);
                logger.info('File hiện tại: ' + fl.currentFile);
                logger.info('Ghi chat: ' + (fl.levels.has('chat') ? 'BẬT' : 'TẮT') + ' · Giữ: ' + fl.keepDays + ' ngày');
                logger.info('Usage: filelog [status|on|off|dir <đường_dẫn>|chat on|off]');
              }
              break;
            }
            case 'exit':
            case 'quit':
            case 'q':
            case 'e':
              shutdown();
              return;
            default:
              logger.info('Unknown command. Type "help" for commands.');
          }
        } catch (err) {
          logger.error('Error: ' + err.message, { err, stderr: true });
        }
        rl.prompt();
      });
      rl.prompt(true);
    } else if (!AUTO_EXE) {
      logger.info('(non-TTY mode — dashboard running, CLI disabled)');
    }
  } catch (e) {
    try {
      startup.print({ showBanner: true });
    } catch { /* ignore */ }
    logger.error('[FATAL] ' + (e && e.message ? e.message : String(e)), { err: e instanceof Error ? e : null, stderr: true });
    try {
      if (manager) {
        manager.runtimeLog('err', '[FATAL] ' + (e && e.stack ? e.stack : e));
        await manager.flushTelegramLogs(2500);
      }
    } catch (e2) { dbg('main', e2); }
    try { writer.restoreTerminal(); } catch { /* ignore */ }
    process.exit(1);
  }
})();

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('uncaughtException', err => {
  try { writer.restoreTerminal(); } catch { /* ignore */ }
  logger.error('[UNCAUGHT] ' + (err && err.message ? err.message : String(err)), { err: err instanceof Error ? err : null, stderr: true });
  try { if (manager) manager.runtimeLog('err', '[UNCAUGHT] ' + ((err && err.stack) || err)); } catch (e) { dbg('main', e); }
});
process.on('unhandledRejection', (reason) => {
  logger.error('[UNHANDLED] ' + (reason?.message || String(reason)), { err: reason instanceof Error ? reason : null, stderr: true });
  try { if (manager) manager.runtimeLog('err', '[UNHANDLED] ' + ((reason && reason.stack) || reason)); } catch (e) { dbg('main', e); }
});
