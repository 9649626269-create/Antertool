'use strict';
const { resolveVersion } = require('./src/core/constants');
const { dbg } = require('./src/core/debug');
const http = require('http');
const path = require('path');
const readline = require('readline');
const BotManager = require('./src/services/BotManager');
const Notifier = require('./src/core/Notifier');
const TelegramNotifier = require('./src/core/TelegramNotifier');
const HelpCatalog = require('./src/core/HelpCatalog');
const ChatFilter = require('./src/core/ChatFilter');
const FileLogger = require('./src/core/FileLogger');
const {
  parseAddBotArgs,
  ADDBOT_USAGE,
  theme,
  formatLogEntry,
  formatBadge,
  formatStatusPill,
  renderTable,
  renderDashboard,
  renderStartupBanner,
  renderStartupTable,
  Spinner,
  cleanupAllSpinners,
  renderErrorBlock,
  formatBotListTable,
  formatSysInfoTable,
  formatProxyTable,
  formatHelpOutput,
  SYMBOLS,
} = require('./src/core/CliUtils');

const bootStartMs = Date.now();
const startupChecks = [];

let config;
let configLoadMs = 0;
{
  const t0 = Date.now();
  try {
    // đọc từ thư mục dữ liệu (cwd) — khi chạy qua load.js, code nằm ở .anter/code còn config.json nằm cạnh load.js
    config = JSON.parse(require('fs').readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'));
    configLoadMs = Date.now() - t0;
  } catch {
    config = {};
    configLoadMs = Date.now() - t0;
  }
}

const AUTO_EXE = process.env.AUTO_EXE === '1' || config.autoExe === true;
let expressApp, expressServer, io;
{
  const t0 = Date.now();
  try {
    const express = require('express');
    const socketIo = require('socket.io');
    expressApp = express();
    expressServer = http.createServer(expressApp);
    const security = require('./src/web/security');
    const corsOrigins = security.allowedOrigins();
    io = new socketIo.Server(expressServer, {
      ...(corsOrigins.length ? { cors: { origin: corsOrigins } } : {}), // mặc định: chỉ cùng nguồn (trước đây '*' -> trang web bất kỳ điều khiển được bot)
      allowRequest: security.allowSocketRequest,
      transports: ['websocket', 'polling'],
      pingTimeout: 20000,
      pingInterval: 10000,
      maxHttpBufferSize: 1e6,
      connectTimeout: 30000,
      allowEIO3: true,
    });
    startupChecks.push({
      step: 'Network & Socket Engine',
      status: 'READY',
      detail: `Express + Socket.IO initialized (${corsOrigins.length ? corsOrigins.length + ' CORS origins' : 'same-origin'})`,
      durationMs: Date.now() - t0,
      role: 'success',
    });
  } catch (e) {
    console.error(renderErrorBlock('FATAL: EXPRESS / SOCKET.IO INITIALIZATION FAILED', e));
    process.exit(1);
  }
}

let rl = null; // gán khi CLI tương tác khởi động (TTY)
const chatFilter = new ChatFilter({
  enabled: config.chatLog !== false,
  mode: config.chatLogMode || 'smart',
});

function emitTerminalLine(text, isError = false) {
  cleanupAllSpinners();
  const stream = isError ? process.stderr : process.stdout;
  if (rl && stream.isTTY) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    if (isError) console.error(text);
    else console.log(text);
    rl.prompt(true);
  } else {
    if (isError) console.error(text);
    else console.log(text);
  }
}

function logCli(level, msg, scope = null) {
  const formatted = formatLogEntry({
    time: Date.now(),
    level,
    scope,
    msg,
    tz: manager ? manager._scheduleTz() : undefined,
  });
  emitTerminalLine(formatted, level === 'err' || level === 'error' || level === 'fatal');
}

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

// Nhận diện chat người chơi ("<Tên> nội dung" hoặc "[Rank] Tên » nội dung") để tô màu riêng,
// đồng thời gộp/ẩn thông báo server lặp lại khi chạy nhiều bot.
function formatChatLine(botId, msg, dec) {
  if (dec && dec.kind === 'player' && dec.sender) {
    return {
      scope: botId,
      body: `${theme.key('<' + dec.sender + '>')} ${theme.white(dec.content)}`,
    };
  }
  if (dec && dec.kind === 'broadcast' && dec.isServerWide) {
    return {
      scope: 'Server',
      body: `${theme.ai('»')} ${theme.white(dec.clean || msg || '')}`,
    };
  }
  return {
    scope: botId,
    body: `${theme.ai('»')} ${theme.white(msg || '')}`,
  };
}

function printBotLog(botId, entry) {
  const level = entry.level || 'sys';
  const tz = manager ? manager._scheduleTz() : undefined;
  let line;
  if (level === 'chat') {
    const { players, onlineBotCount } = collectOnlinePlayers();
    const dec = chatFilter.decide(botId, entry.msg, {
      time: entry.time || Date.now(),
      onlinePlayers: players,
      onlineBotCount,
    });
    if (!dec.show) return;
    const chat = formatChatLine(botId, entry.msg, dec);
    line = formatLogEntry({
      time: entry.time || Date.now(),
      level: 'info',
      scope: chat.scope,
      msg: chat.body,
      tz,
      rawAnsiAllowed: true,
    });
  } else {
    line = formatLogEntry({
      time: entry.time || Date.now(),
      level,
      scope: botId,
      msg: entry.msg || '',
      tz,
    });
  }
  emitTerminalLine(line, false);
}

const manager = new BotManager({
  configPath: path.join(process.cwd(), 'config.json'),
  autoExe: AUTO_EXE,
  io,
  onBotLog: printBotLog,
});

const WebDashboard = require('./src/web/WebDashboard');
const dashboard = new WebDashboard(manager, {
  expressApp,
  io,
  expressServer,
  port: process.env.PORT || (config.settings && config.settings.webPort) || 3000,
  autoExe: AUTO_EXE,
});
manager.dashboard = dashboard;

function showBanner() {
  const mode = AUTO_EXE ? 'AUTO-EXE' : (process.stdout.isTTY ? 'INTERACTIVE TUI' : 'HEADLESS');
  emitTerminalLine('\n' + renderStartupBanner({
    appName: 'ANTERTOOL PREMIUM V2',
    subtitle: 'Antares Mine Bot Manager • Developer Terminal UI',
    version: 'v2.0',
    mode,
  }));
}

function showDashboard() {
  emitTerminalLine('\n' + renderDashboard(manager));
  if (manager.bots.length > 0) {
    emitTerminalLine(formatBotListTable(manager.bots));
  }
}

function showHelp(query = '') {
  const reg = manager.bots[0] ? manager.bots[0].cmdRegistry.list() : null;
  const res = HelpCatalog.buildHelp({ scope: 'console', query, registry: reg, customs: [] });
  emitTerminalLine(formatHelpOutput(res));
}

function showBotList(bots) {
  emitTerminalLine(formatBotListTable(bots));
}

function showSysInfo(m) {
  emitTerminalLine(formatSysInfoTable(m, manager.getBotCapacity()));
}

// ===== addbot / delbot / web (localhost) cho CLI =====
function cliAddBot(args) {
  const printUsage = () => {
    logCli('info', `Usage: ${ADDBOT_USAGE}\nvd: addbot 123 mk 123\n    addbot 123 mk 123 play.abc.vn 25565 1.21.1 Steve\n    addbot 123 mk 123 ip=play.abc.vn ver=1.21.1     (dấu - = bỏ qua, lấy mặc định)`, 'CLI');
  };
  if (!args.length) { printUsage(); return null; }
  const r = parseAddBotArgs(args);
  if (!r.ok) { logCli('err', r.error, 'addbot'); printUsage(); return null; }
  const { id, username, password, host: hostArg, port: portArg, version: verArg, owner: ownerArg } = r.data;
  if (manager.findBot(id)) { logCli('err', `ID "${id}" đã tồn tại`, 'addbot'); return null; }
  const dup = manager.bots.find(b => String(b.cfg.username).toLowerCase() === username.toLowerCase());
  if (dup) { logCli('err', `Tên "${username}" đã được bot "${dup.cfg.id}" dùng`, 'addbot'); return null; }
  const tpl = (manager.bots[0] && manager.bots[0].cfg) || {};
  const root = manager._config || {};
  const host = hostArg || tpl.host || root.host;
  const port = portArg || parseInt(tpl.port || root.port || 25565, 10);
  const version = resolveVersion(verArg, tpl.version, root.version);
  const owner = ownerArg || tpl.ownerUsername || root.ownerUsername || '';
  if (!host) { logCli('err', `Chưa biết IP server — thêm vào cuối lệnh, vd: addbot ${username} mk ${password} play.abc.vn`, 'addbot'); return null; }
  const bot = manager.createBot({ id, host, port, version, username, password, ownerUsername: owner });
  try { if (manager.io) manager.io.emit('botAdded', bot.getSummary()); } catch (e) { dbg('main', e); }
  logCli('ok', `Đã thêm bot "${id}" (server=${host}:${port}, ver=${version || 'default'}, owner=${owner || 'none'})\nChạy bot: start ${id} (lần đầu bot tự gửi /dk rồi /dn)`, 'addbot');
  return bot;
}

function cliDelBot(args) {
  if (!args[0]) { logCli('info', 'Usage: delbot <id>', 'delbot'); return; }
  const bot = manager.removeBot(args[0]);
  if (!bot) { logCli('err', `Bot not found: ${args[0]}`, 'delbot'); return; }
  try { if (manager.io) manager.io.emit('botRemoved', { id: bot.cfg.id }); } catch (e) { dbg('main', e); }
  logCli('ok', `Đã xoá bot "${bot.cfg.id}"`, 'delbot');
}

async function webCommand(sub) {
  sub = String(sub || 'status').toLowerCase();
  const url = `http://localhost:${dashboard.port}`;
  if (/^(on|bat|bật)$/.test(sub)) {
    if (dashboard.isRunning) { logCli('warn', `Web đang BẬT sẵn: ${url}`, 'web'); return; }
    const sp = new Spinner(`Starting Web Dashboard on ${url}...`).start();
    const ok = await dashboard.start();
    if (ok) {
      manager.persistence.set('webDashboard', true);
      sp.succeed(`Web BẬT → ${url}`);
    } else {
      sp.fail(`Không bật được web (${dashboard.lastError || 'xem lỗi ở trên'})`);
    }
  } else if (/^(off|tat|tắt)$/.test(sub)) {
    if (!dashboard.isRunning) { logCli('warn', 'Web đang TẮT sẵn', 'web'); return; }
    const sp = new Spinner('Stopping Web Dashboard...').start();
    await dashboard.stop();
    manager.persistence.set('webDashboard', false);
    sp.succeed('Web TẮT — bot vẫn chạy bình thường (bật lại: web on)');
  } else if (sub === 'status') {
    logCli(dashboard.isRunning ? 'ok' : 'warn', dashboard.isRunning ? `Web: BẬT → ${url}` : 'Web: TẮT (bật: web on)', 'web');
  } else {
    logCli('info', 'Usage: web on | web off | web status', 'web');
  }
}

let _shuttingDown = false;
async function shutdown(code = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  cleanupAllSpinners();
  console.log('\n' + formatLogEntry({ level: 'info', scope: 'System', msg: code === 42 ? 'Shutting down for update...' : 'Shutting down gracefully...' }));
  const watchdog = setTimeout(() => process.exit(code), 5000); // không để treo nếu đóng cổng chậm
  if (watchdog.unref) watchdog.unref();
  try { manager.runtimeLog('sys', code === 42 ? 'Antertool đang tắt để cập nhật bản mới...' : 'Antertool đang tắt...'); } catch (e) { dbg('main', e); }
  try { if (dashboard) dashboard.shutdown(); } catch (e) { dbg('main', e); }
  try { if (manager) manager.shutdown(); } catch (e) { dbg('main', e); }
  try { if (dashboard) await dashboard.stop(); } catch (e) { dbg('main', e); }
  try { await manager.flushTelegramLogs(3000); } catch (e) { dbg('main', e); } // đẩy nốt log runtime lên Telegram trước khi thoát
  process.exit(code);
}

(async () => {
  try {
    showBanner();

    const initSpinner = new Spinner('Initializing BotManager, configuration & modules...').start();
    const tMgr = Date.now();
    await manager.init();
    const mgrMs = Date.now() - tMgr;
    initSpinner.stop();

    // Record real initialization results for Startup Sequence Table
    const val = manager.persistence.lastValidation || { ok: true, errors: [] };
    startupChecks.unshift({
      step: 'Configuration Schema',
      status: val.ok ? 'OK' : 'WARN',
      detail: val.ok
        ? (val.missingFile ? 'Created default empty configuration' : 'Validated config.json schema')
        : `${val.errors.length} schema warning(s) detected`,
      durationMs: configLoadMs,
      role: val.ok ? 'success' : 'warning',
    });

    const envInfo = manager.env || {};
    const envTags = [
      envInfo.platform || process.platform,
      envInfo.isTermux ? 'Termux' : null,
      envInfo.isDocker ? 'Docker' : null,
      `${envInfo.cpuCount || 1} CPU`,
      `${envInfo.totalMemMB || 0}MB RAM`,
    ].filter(Boolean).join(' · ');
    startupChecks.push({
      step: 'Adaptive Environment',
      status: envInfo.isLowResource ? 'WARN' : 'OK',
      detail: envTags,
      durationMs: 1,
      role: envInfo.isLowResource ? 'warning' : 'success',
    });

    const proxiesCount = manager.proxyManager.list.length;
    startupChecks.push({
      step: 'Bot & Proxy Loader',
      status: manager.bots.length > 0 ? 'READY' : 'OK',
      detail: `${manager.bots.length} bot(s) loaded · ${proxiesCount} proxy(s) configured`,
      durationMs: mgrMs,
      role: 'success',
    });

    startupChecks.push({
      step: 'Smart & Guard Engines',
      status: 'AI',
      detail: '✦ SpawnerProtect, AutoSell, BeggarGuard & SessionVerifier ready',
      durationMs: 1,
      role: 'ai',
    });

    // File Logger probe
    let logErr = null;
    const tFl = Date.now();
    if (manager.fileLogs.enabled) {
      logErr = manager.fileLogs.probe();
      startupChecks.push({
        step: 'Runtime File Logger',
        status: logErr ? 'WARN' : 'OK',
        detail: logErr
          ? `Cannot write to ${manager.fileLogs.dir} (${logErr})`
          : `Active → ${path.basename(manager.fileLogs.currentFile)}`,
        durationMs: Date.now() - tFl,
        role: logErr ? 'warning' : 'success',
      });
    } else {
      startupChecks.push({
        step: 'Runtime File Logger',
        status: 'SKIPPED',
        detail: 'Disabled via configuration (filelog off)',
        durationMs: 0,
        role: 'warning',
      });
    }

    // Telegram & Discord Integrations
    const tgOn = manager.telegram.enabled;
    const whOn = manager.notifier.enabled || manager.revenueNotifier.enabled;
    startupChecks.push({
      step: 'Telemetry Integrations',
      status: (tgOn || whOn) ? 'CONNECTED' : 'SKIPPED',
      detail: `Telegram: ${tgOn ? 'ON' : 'OFF'} · Discord Webhook: ${whOn ? 'ON' : 'OFF'}`,
      durationMs: 1,
      role: (tgOn || whOn) ? 'success' : 'warning',
    });

    // Web Dashboard startup
    const webWanted = AUTO_EXE || !process.stdin.isTTY || manager._config.webDashboard !== false;
    const tWeb = Date.now();
    let webOk = false;
    if (webWanted) {
      const webSpinner = new Spinner(`Binding Web Dashboard on port ${dashboard.port}...`).start();
      webOk = await dashboard.start();
      webSpinner.stop();
      startupChecks.push({
        step: 'Web Dashboard Server',
        status: webOk ? 'ONLINE' : 'WARN',
        detail: webOk
          ? `Listening at http://localhost:${dashboard.port}`
          : `Port ${dashboard.port} busy/failed (${dashboard.lastError || 'check logs'})`,
        durationMs: Date.now() - tWeb,
        role: webOk ? 'success' : 'warning',
      });
    } else {
      startupChecks.push({
        step: 'Web Dashboard Server',
        status: 'SKIPPED',
        detail: 'Disabled via config (run "web on" to start)',
        durationMs: 0,
        role: 'warning',
      });
    }

    const totalBootMs = Date.now() - bootStartMs;
    const warnCount = startupChecks.filter(c => c.role === 'warning' && c.status !== 'SKIPPED').length;
    const skipCount = startupChecks.filter(c => c.status === 'SKIPPED').length;
    const errCount = startupChecks.filter(c => c.role === 'error').length;

    // Render Startup Initialization Checklist Table
    emitTerminalLine(renderStartupTable(startupChecks, {
      totalBots: manager.bots.length,
      warnings: warnCount,
      skipped: skipCount,
      errors: errCount,
      bootMs: totalBootMs,
      ready: errCount === 0,
    }));

    // Render Complete Multi-Panel TUI Dashboard
    emitTerminalLine('\n' + renderDashboard(manager));

    logCli('ok', `Antares Manager started — ${manager.bots.length} bots loaded, none auto-started (boot: ${totalBootMs}ms)`, 'System');
    manager.runtimeLog('ok', `Antertool khởi động — ${manager.bots.length} bot đã nạp (chưa tự chạy) · Node ${process.version} · ${process.platform}/${process.arch}`);

    if (logErr) {
      logCli('warn', `Log file: KHÔNG ghi được vào ${manager.fileLogs.dir} (${logErr}). Termux: chạy "termux-setup-storage" để cấp quyền /sdcard, hoặc đổi "fileLogDir"/ANTER_LOG_DIR.`, 'FileLogger');
    }

    if (!AUTO_EXE && process.stdin.isTTY) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: theme.aiBold(`${SYMBOLS.prompt} `) + theme.info('anter') + theme.muted(' › '),
        terminal: true,
      });
      manager.cliAsk = (msg) => logCli('ai', msg, 'Prompt');
      rl.on('line', line => {
        const input = String(line || '').trim();
        if (manager.hasWebhookPrompt && manager.answerWebhookPrompt(input)) { rl.prompt(); return; } // trả lời câu hỏi liên kết webhook
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
            case 'dash':
            case 'status':
            case 'tui':
              showDashboard();
              break;
            case 'list':
            case 'ls':
              showBotList(manager.bots);
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
            case 'web':
            case 'localhost':
            case 'lochost':
            case 'dashboard':
              webCommand(args[0])
                .catch(e => logCli('err', `Error: ${e.message}`, 'web'))
                .then(() => { if (rl) { readline.cursorTo(process.stdout, 0); readline.clearLine(process.stdout, 0); rl.prompt(true); } });
              return;
            case 'update': {
              if (!process.env.ANTER_LOADER) { logCli('warn', 'Cần chạy bằng load.js: node load.js (hoặc npm start) mới dùng được lệnh update', 'update'); break; }
              const sp = new Spinner('Đang kiểm tra bản cập nhật trên GitHub...').start();
              require(process.env.ANTER_LOADER).checkForUpdate().then(info => {
                if (!info.available) {
                  sp.succeed('Đang là bản mới nhất');
                } else {
                  sp.succeed(`Có bản mới: ${info.message} — đang thoát để cập nhật...`);
                  shutdown(42);
                  return;
                }
                if (rl) rl.prompt(true);
              }).catch(e => {
                sp.fail(`Không kiểm tra được: ${e.message}`);
                if (rl) rl.prompt(true);
              });
              return;
            }
            case 'start': {
              if (!args[0]) { logCli('info', 'Usage: start <id>', 'start'); break; }
              const b = manager.findBot(args[0]);
              if (!b) { logCli('err', `Bot not found: ${args[0]}`, 'start'); break; }
              if (b.isConnected || b.isReconnecting) { logCli('warn', `Bot "${args[0]}" already running`, 'start'); break; }
              b._disabled = false; b.state.reconnects = 0; b.start();
              logCli('ok', `Started bot "${args[0]}"`, 'start');
              break;
            }
            case 'stop': {
              if (!args[0]) { logCli('info', 'Usage: stop <id>', 'stop'); break; }
              const b = manager.findBot(args[0]);
              if (!b) { logCli('err', `Bot not found: ${args[0]}`, 'stop'); break; }
              b.shutdown();
              logCli('warn', `Stopped bot "${args[0]}"`, 'stop');
              break;
            }
            case 'cmd': {
              if (args.length < 2) { logCli('info', 'Usage: cmd <id> <command>', 'cmd'); break; }
              const b = manager.findBot(args[0]);
              if (!b) { logCli('err', `Bot not found: ${args[0]}`, 'cmd'); break; }
              b.cmd(args.slice(1).join(' '));
              break;
            }
            case 'cmdall': {
              if (!args.length) { logCli('info', 'Usage: cmdall <command> (vd: cmdall macro tpa_dahas)', 'cmdall'); break; }
              const cmdText = args.join(' ');
              const online = manager.bots.filter(b => b.isOnline);
              if (!online.length) { logCli('warn', 'Không có bot nào đang ONLINE', 'cmdall'); break; }
              logCli('info', `Executing "${cmdText}" across ${online.length} bot(s): ${online.map(b => b.cfg.id).join(', ')}`, 'cmdall');
              online.forEach(b => b.cmd(cmdText));
              break;
            }
            case 'schedule': {
              if (args[0] === 'on' && args[1] && args[2]) {
                const timeRe = /^([01]?\d|2[0-3]):([0-5]\d)$/;
                if (!timeRe.test(args[1]) || !timeRe.test(args[2])) {
                  logCli('warn', 'Giờ không hợp lệ — dùng dạng HH:MM (24h), vd 23:00', 'schedule');
                  break;
                }
                const s = manager.setSchedule(true, args[1], args[2]);
                logCli('ok', `Lịch nghỉ: out lúc ${s.outTime}, vô lại lúc ${s.inTime} (múi giờ ${manager._scheduleTz()})`, 'schedule');
              } else if (args[0] === 'off') {
                manager.setSchedule(false, null, null);
                logCli('ok', 'Đã tắt lịch tự out/vào', 'schedule');
              } else {
                const s = manager.getSchedule();
                logCli('info', `${s.enabled ? `Đang bật: out ${s.outTime} — vô lại ${s.inTime}` : 'Đang tắt'}\nUsage: schedule on <HH:MM out> <HH:MM in> | schedule off`, 'schedule');
              }
              break;
            }
            case 'telegram':
            case 'tg': {
              const tg = manager.telegram;
              const sub = String(args[0] || '').toLowerCase();
              const tgUsage = () => {
                logCli('info', 'Usage: telegram set <token> [chatId] | chatid | test | panel | off\n       telegram every <1s|10s|10m|off>  (nhịp cập nhật bảng) | mode edit|new | events [a,b,c] | commands on|off\n       telegram logs [on|off|level|chat|bots|every|keep|now|silent|send|test]  (log runtime gửi lên Telegram — gõ: telegram logs)', 'telegram');
              };
              if (sub === 'set' && args[1]) {
                if (!TelegramNotifier.looksLikeToken(args[1])) { logCli('warn', 'Token không đúng dạng — lấy từ @BotFather (vd 123456789:AAH...)', 'telegram'); break; }
                manager.setTelegram(args[1], args[2] !== undefined ? args[2] : undefined);
                if (tg.enabled) {
                  const sp = new Spinner('Testing Telegram connection...').start();
                  tg.test().then(r => r.ok ? sp.succeed(r.message) : sp.fail(r.message));
                } else {
                  logCli('ok', 'Đã lưu token\nBước tiếp: mở Telegram, nhắn /start cho bot của bạn, rồi gõ: telegram chatid', 'telegram');
                }
              } else if (sub === 'chatid') {
                if (!tg.hasToken) { logCli('warn', 'Chưa có token — dùng: telegram set <token>', 'telegram'); break; }
                const sp = new Spinner('Đang dò chat_id từ Telegram...').start();
                tg.discoverChats().then(r => {
                  sp.stop();
                  if (!r.ok) return logCli('err', r.message, 'telegram');
                  if (!r.chats.length) return logCli('warn', 'Chưa thấy tin nhắn nào gửi cho bot — mở Telegram, nhắn /start cho bot rồi gõ lại: telegram chatid', 'telegram');
                  if (r.chats.length === 1 || args[1]) {
                    const pick = args[1] ? r.chats.find(c => c.id === String(args[1])) : r.chats[0];
                    if (!pick) return logCli('warn', 'Không thấy chat_id đó. Có: ' + r.chats.map(c => `${c.id} (${c.title})`).join(', '), 'telegram');
                    manager.setTelegram(undefined, pick.id);
                    logCli('ok', `Đã lưu chat_id ${pick.id} (${pick.title})`, 'telegram');
                    tg.test().then(t => logCli(t.ok ? 'ok' : 'err', t.message, 'telegram'));
                  } else {
                    emitTerminalLine(renderTable({
                      title: '📱 DISCOVERED TELEGRAM CHATS',
                      columns: [
                        { key: 'id', header: 'CHAT ID', minWidth: 12 },
                        { key: 'title', header: 'CHAT TITLE / USER', minWidth: 20 },
                      ],
                      rows: r.chats.map(c => ({ id: theme.key(String(c.id)), title: theme.white(c.title) })),
                      footer: `Select with: ${theme.key('telegram chatid <id>')}`,
                    }));
                  }
                });
              } else if (sub === 'off') {
                manager.setTelegram(null, null);
                logCli('ok', 'Đã tắt Telegram (xoá token + chat_id khỏi config)', 'telegram');
              } else if (sub === 'test') {
                if (!tg.hasToken) { logCli('warn', 'Chưa cấu hình — dùng: telegram set <token>', 'telegram'); break; }
                const sp = new Spinner('Sending test message to Telegram...').start();
                tg.test().then(r => r.ok ? sp.succeed(r.message) : sp.fail(r.message));
              } else if (sub === 'panel' || sub === 'send') {
                if (!tg.enabled) { logCli('warn', 'Chưa cấu hình Telegram — dùng: telegram set <token>', 'telegram'); break; }
                const n = manager.refreshTelegramPanels({ fresh: true });
                logCli(n ? 'ok' : 'warn', n ? `Đã gửi ${n} bảng Auto sell spawner` : 'Chưa có bot nào bật autosell_spawn / có doanh thu để lập bảng', 'telegram');
              } else if (sub === 'every') {
                const v = String(args[1] || '').toLowerCase();
                const sec = (v === 'off' || v === '0') ? 0 : manager.constructor.parseEverySec(args.slice(1).join(''));
                if (sec === null || sec === undefined) { logCli('warn', 'Cú pháp: telegram every <1s|10s|10m|off>  (số trần = giây)', 'telegram'); break; }
                manager.setTelegramOption('telegramRefreshSec', sec);
                logCli('ok', sec ? `Bảng cập nhật mỗi ${sec} giây${manager._config?.telegramMode === 'new' ? '  (chú ý: mode new không cập nhật theo nhịp — gõ: telegram mode edit)' : ''}` : 'Tắt cập nhật theo nhịp (vẫn cập nhật sau mỗi vòng bán / khi đổi trạng thái)', 'telegram');
                if (sec && sec < 3 && manager.bots.length > 1) logCli('info', `Lưu ý: Telegram chỉ cho ~1 lần sửa/giây/chat → ${manager.bots.length} bot sẽ được sửa xoay vòng (mỗi bảng ~${manager.bots.length * sec}s/lần)`, 'telegram');
              } else if (sub === 'mode') {
                const m = String(args[1] || '').toLowerCase();
                if (m !== 'edit' && m !== 'new') { logCli('warn', 'Cú pháp: telegram mode edit|new  (edit = 1 bảng/bot sửa tại chỗ, new = mỗi lần 1 tin mới có thông báo)', 'telegram'); break; }
                manager.setTelegramOption('telegramMode', m);
                logCli('ok', `Chế độ bảng: ${m}`, 'telegram');
              } else if (sub === 'logs' || sub === 'log') {
                manager.telegramLogsCommand(args.slice(1)).then(lines => {
                  for (const [kind, text] of lines) {
                    const lvl = kind === 'ok' ? 'ok' : (kind === 'warn' ? 'warn' : (kind === 'err' ? 'err' : 'info'));
                    logCli(lvl, String(text || '').trim(), 'tg:logs');
                  }
                });
              } else if (sub === 'events') {
                if (!args[1]) {
                  logCli('info', `Đang bật: ${[...tg.events].join(', ')}\nTất cả loại: ${Object.keys(TelegramNotifier.EVENT_LABELS).join(', ')}`, 'telegram');
                } else {
                  const list = args[1].split(',').map(x => x.trim()).filter(Boolean);
                  manager.setTelegramOption('telegramEvents', list);
                  logCli('ok', `Đã đặt loại sự kiện: ${list.join(', ')}`, 'telegram');
                }
              } else if (sub === 'commands') {
                const on = String(args[1] || '').toLowerCase();
                if (on !== 'on' && on !== 'off') { logCli('warn', 'Cú pháp: telegram commands on|off  (nhận lệnh /status /panel từ Telegram)', 'telegram'); break; }
                manager.setTelegramOption('telegramCommands', on === 'on');
                logCli('ok', `Nhận lệnh Telegram: ${on === 'on' ? 'BẬT' : 'TẮT'}`, 'telegram');
              } else {
                tgUsage();
                logCli('info', 'Trạng thái: ' + (tg.enabled ? 'BẬT' : (tg.hasToken ? 'có token, thiếu chat_id (gõ: telegram chatid)' : 'TẮT'))
                  + (tg.enabled ? ` · chế độ ${manager._config?.telegramMode === 'new' ? 'new' : 'edit'} · cập nhật mỗi ${manager._config?.telegramRefreshSec ?? 1}s` : ''), 'telegram');
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
                  logCli('ok', 'Đã lưu webhook doanh thu (riêng)', 'webhook');
                } else if (args[1] === 'off') {
                  rn.configure(null, ['all']);
                  manager.persistence.set('revenueWebhookUrl', null);
                  logCli('ok', 'Đã tắt webhook doanh thu riêng — báo cáo sẽ đi qua webhook chung (nếu có)', 'webhook');
                } else if (args[1] === 'report' || args[1] === 'send') {
                  const r = manager.sendRevenueSummary();
                  logCli(r.ok ? 'ok' : 'warn', r.ok ? `Đã gửi báo cáo tổng hợp doanh thu (${r.via})` : r.message, 'webhook');
                } else if (args[1] === 'every') {
                  const v = String(args[2] || '').toLowerCase();
                  const min = (v === 'off' || v === '0') ? 0 : manager.constructor.parseEveryMin(args.slice(2).join(''));
                  if (min === null || min === undefined) { logCli('warn', 'Cú pháp: webhook revenue every <30m|1h|1h30m|off>', 'webhook'); break; }
                  manager.setRevenueSummaryEvery(min);
                  logCli('ok', min ? `Tự gửi báo cáo tổng hợp mỗi ${min >= 60 && min % 60 === 0 ? (min / 60) + ' giờ' : min + ' phút'} (chỉ gửi khi có vòng bán mới)` : 'Đã tắt tự gửi báo cáo tổng hợp', 'webhook');
                } else if (args[1] === 'test') {
                  if (!rn.enabled) { logCli('warn', 'Chưa đặt webhook doanh thu riêng — dùng: webhook revenue set <url>', 'webhook'); break; }
                  const sp = new Spinner('Sending test payload to Discord revenue webhook...').start();
                  rn.test().then(ok => ok ? sp.succeed('Đã gửi test, kiểm tra kênh Discord') : sp.fail('Gửi thất bại — kiểm tra lại URL'));
                } else {
                  logCli('info', `Usage: webhook revenue set <url> | test | off | report | every <30m|1h|off>\nTự gửi tổng hợp: ${manager._config?.revenueSummaryEveryMin ? `mỗi ${manager._config.revenueSummaryEveryMin} phút` : 'TẮT'}\nTrạng thái: ${rn.enabled ? 'BẬT (webhook riêng)' : (notifier.enabled ? 'dùng webhook chung' : 'TẮT')}`, 'webhook');
                }
                break;
              }
              if (args[0] === 'set' && args[1]) {
                notifier.configure(args[1], [...notifier.events]);
                manager.persistence.set('webhookUrl', args[1]);
                logCli('ok', 'Đã lưu webhook', 'webhook');
              } else if (args[0] === 'off') {
                notifier.configure(null, [...notifier.events]);
                manager.persistence.set('webhookUrl', null);
                logCli('ok', 'Đã tắt webhook', 'webhook');
              } else if (args[0] === 'test') {
                if (!notifier.enabled) { logCli('warn', 'Chưa cấu hình webhook — dùng: webhook set <url>', 'webhook'); break; }
                const sp = new Spinner('Sending test payload to Discord webhook...').start();
                notifier.test().then(ok => ok ? sp.succeed('Đã gửi test, kiểm tra kênh Discord') : sp.fail('Gửi thất bại — kiểm tra lại URL'));
              } else if (args[0] === 'mention' || args[0] === 'tag') {
                const v = args.slice(1).join(' ').trim();
                if (!v) {
                  logCli('info', `Tag hiện tại: ${notifier.mention || '(chưa đặt)'} — áp dụng cho: ${[...notifier.mentionEvents].join(', ')}\nUsage: webhook mention <ID Discord | @tên | off> | webhook mention test\nMuốn PING thật phải dùng ID số (Discord: Cài đặt > Nâng cao > Chế độ nhà phát triển, rồi chuột phải tên > Sao chép ID). @tên chỉ hiện chữ.`, 'webhook');
                } else if (v.toLowerCase() === 'test') {
                  if (!notifier.enabled) { logCli('warn', 'Chưa cấu hình webhook — dùng: webhook set <url>', 'webhook'); break; }
                  const sp = new Spinner('Sending test mention to Discord webhook...').start();
                  notifier.testMention().then(ok => ok ? sp.succeed('Đã gửi tin thử, kiểm tra kênh Discord') : sp.fail('Gửi thất bại — kiểm tra lại URL'));
                } else {
                  notifier.setMention(v);
                  manager.persistence.set('webhookMention', v);
                  logCli('ok', notifier.mention ? `Đã đặt tag: ${notifier.mention}${/^<@/.test(notifier.mention) || /^@(everyone|here)$/.test(notifier.mention) ? '' : '  (chỉ hiện chữ, không ping — muốn ping hãy dùng ID số)'}` : 'Đã tắt tag', 'webhook');
                }
              } else if (args[0] === 'events') {
                if (!args[1]) {
                  logCli('info', `Đang bật: ${[...notifier.events].join(', ')}\nTất cả loại: ${Object.keys(Notifier.EVENT_LABELS).join(', ')}`, 'webhook');
                } else {
                  const list = args[1].split(',').map(s => s.trim()).filter(Boolean);
                  notifier.configure(notifier.url, list);
                  manager.persistence.set('webhookEvents', list);
                  logCli('ok', `Đã đặt loại sự kiện: ${list.join(', ')}`, 'webhook');
                }
              } else {
                logCli('info', `Usage: webhook set <url> | webhook test | webhook off | webhook events [a,b,c]\nTrạng thái: ${notifier.enabled ? 'BẬT' : 'TẮT'}`, 'webhook');
              }
              break;
            }
            case 'proxy':
              if (args[0] === 'list' || args[0] === 'ls') {
                const list = manager.proxyManager.getSummaries();
                emitTerminalLine(formatProxyTable(list));
              } else if (args[0] === 'add' && args[1]) {
                const r = manager.proxyManager.add(args.slice(1).join(' '));
                logCli(r.ok ? 'ok' : 'err', r.ok ? `Added: ${r.msg}` : `Error: ${r.msg}`, 'proxy');
              } else if (args[0] === 'addfile' && args[1]) {
                const r = manager.proxyManager.addFile(args.slice(1).join(' '));
                logCli(r.ok ? 'ok' : 'err', r.msg, 'proxy');
              } else {
                logCli('info', 'Usage: proxy list | proxy add <proxy-string> | proxy addfile <path>', 'proxy');
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
                logCli(chatFilter.enabled ? 'ok' : 'warn', chatFilter.enabled ? chatFilter.statusText() : 'Hiển thị chat: TẮT', 'chatlog');
              } else if (sub === 'status') {
                logCli('info', `${chatFilter.statusText()}\nUsage: chatlog [on|off|smart|player|all|clear|status]`, 'chatlog');
              } else if (sub === 'clear' || sub === 'reset') {
                chatFilter.reset();
                logCli('ok', 'Đã làm mới bộ nhớ lọc trùng chat', 'chatlog');
              } else if (chatFilter.setMode(sub)) {
                logCli(chatFilter.enabled ? 'ok' : 'warn', chatFilter.enabled ? chatFilter.statusText() : 'Hiển thị chat: TẮT', 'chatlog');
              } else {
                logCli('info', 'Usage: chatlog [on|off|smart|player|all|clear|status]\n• smart  (mặc định): gộp tin trùng giữa các bot + ẩn thông báo server lặp lại\n• player           : chỉ hiện chat người chơi & phản hồi lệnh, ẩn toàn bộ thông báo server\n• all              : hiện toàn bộ tin nhắn thô của từng bot', 'chatlog');
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
                  logCli(err ? 'warn' : 'ok', err ? `Không ghi được vào ${fl.dir}: ${err}` : `Đã BẬT ghi log runtime → ${fl.currentFile}`, 'filelog');
                } else {
                  logCli('warn', 'Đã TẮT ghi log runtime ra file', 'filelog');
                }
              } else if (sub === 'dir' && args[1]) {
                const rawPath = args.slice(1).join(' ');
                const normPath = FileLogger.normalizeLogDir(rawPath, path.dirname(manager.configPath));
                manager.setFileLogOption('fileLogDir', normPath);
                const err = fl.probe();
                logCli(err ? 'warn' : 'ok', err
                  ? `Đã đổi thư mục sang ${fl.dir} nhưng chưa ghi được (${err}). Trên Termux hãy chạy: termux-setup-storage`
                  : `Đã tạo và ghi log runtime vào: ${fl.currentFile}`, 'filelog');
              } else if (sub === 'chat') {
                const v = String(args[1] || '').toLowerCase();
                if (v !== 'on' && v !== 'off') {
                  logCli('info', 'Usage: filelog chat on|off', 'filelog');
                  break;
                }
                manager.setFileLogOption('fileLogChat', v === 'on');
                logCli('ok', `Ghi chat người chơi vào file log: ${v === 'on' ? 'BẬT' : 'TẮT'}`, 'filelog');
              } else {
                const err = fl.enabled ? fl.probe() : null;
                emitTerminalLine(renderTable({
                  title: '📂 RUNTIME FILE LOGGER DIAGNOSTICS',
                  columns: [
                    { key: 'k', header: 'PROPERTY', minWidth: 16 },
                    { key: 'v', header: 'VALUE / STATUS', minWidth: 28 },
                  ],
                  rows: [
                    { k: theme.muted('State'), v: fl.enabled ? (err ? formatBadge('ERROR', 'error') + ' ' + theme.error(err) : formatStatusPill('ONLINE')) : formatStatusPill('OFF') },
                    { k: theme.muted('Log Directory'), v: theme.path(fl.dir) },
                    { k: theme.muted('Active File'), v: theme.path(fl.currentFile) },
                    { k: theme.muted('Player Chat Log'), v: fl.levels.has('chat') ? formatBadge('ON', 'success') : formatBadge('OFF', 'muted') },
                    { k: theme.muted('Retention Policy'), v: `${fl.keepDays} days` },
                  ],
                  footer: `Usage: ${theme.key('filelog [status|on|off|dir <path>|chat on|off]')}`,
                }));
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
              logCli('warn', `Unknown command "${cmd}". Type "help" for commands or "dash" for TUI dashboard.`, 'CLI');
          }
        } catch (err) {
          logCli('err', err, 'CLI');
        }
        rl.prompt();
      });
      rl.prompt(true);
    } else if (!AUTO_EXE) {
      logCli('info', 'Running in non-TTY / headless mode — Web Dashboard active, interactive CLI prompt disabled.', 'System');
    }
  } catch (e) {
    cleanupAllSpinners();
    console.error(renderErrorBlock('FATAL RUNTIME STARTUP FAILURE', e));
    try { manager.runtimeLog('err', '[FATAL] ' + (e && e.stack ? e.stack : e)); await manager.flushTelegramLogs(2500); } catch (e2) { dbg('main', e2); }
    process.exit(1);
  }
})();

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('uncaughtException', err => {
  cleanupAllSpinners();
  console.error(formatLogEntry({ level: 'fatal', scope: 'uncaughtException', msg: err }));
  try { manager.runtimeLog('err', '[UNCAUGHT] ' + ((err && err.stack) || err)); } catch (e) { dbg('main', e); }
});
process.on('unhandledRejection', (reason) => {
  cleanupAllSpinners();
  console.error(formatLogEntry({ level: 'err', scope: 'unhandledRejection', msg: reason instanceof Error ? reason : String(reason?.message || reason) }));
  try { manager.runtimeLog('err', '[UNHANDLED] ' + ((reason && reason.stack) || reason)); } catch (e) { dbg('main', e); }
});
