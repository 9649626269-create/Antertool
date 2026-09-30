'use strict';
const http = require('http');
const path = require('path');
const chalk = require('chalk');
const BotManager = require('./src/services/BotManager');
const Notifier = require('./src/core/Notifier');
let config;
try {
  config = require('./config.json');
} catch {
  config = {};
}
const AUTO_EXE = process.env.AUTO_EXE === '1' || config.autoExe === true;
let expressApp, expressServer, io;
try {
  const express = require('express');
  const socketIo = require('socket.io');
  expressApp = express();
  expressServer = http.createServer(expressApp);
  io = new socketIo.Server(expressServer, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    pingTimeout: 20000,
    pingInterval: 10000,
    maxHttpBufferSize: 1e6,
    connectTimeout: 30000,
    allowEIO3: true,
  });
} catch (e) {
  console.error(chalk.red('[FATAL] express/socket.io required:'), e.message);
  process.exit(1);
}
const colors = {
  border: chalk.hex('#a78bfa'),
  accent: chalk.hex('#22d3ee'),
  title: chalk.hex('#e2e8f0'),
  muted: chalk.hex('#94a3b8'),
  key: chalk.hex('#fbbf24'),
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
};
const readline = require('readline');
let rl = null; // gán khi CLI tương tác khởi động (TTY)
let _showChatLog = true; // bật/tắt hiển thị chat qua lệnh "chatlog"
const LEVEL_COLORS = {
  sys: chalk.hex('#64748b'),
  ok: chalk.green,
  warn: chalk.yellow,
  err: chalk.red,
  afk: chalk.hex('#34d399'),
  shard: chalk.hex('#c084fc'),
  proxy: chalk.hex('#fb923c'),
  health: chalk.hex('#f87171'),
};
function timeStr(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString('vi-VN', { hour12: false });
}
// Nhận diện chat người chơi "<Tên> nội dung" để tô màu riêng, khác với
// thông báo hệ thống/server (join/leave, broadcast, tpa request, v.v.)
function formatChatLine(botId, msg) {
  const tag = chalk.hex('#38bdf8')(`[${botId}]`);
  const playerMatch = /^<\s*([^>]+?)\s*>\s?(.*)$/s.exec(msg || '');
  if (playerMatch) {
    const [, name, content] = playerMatch;
    return `${tag} ${chalk.hex('#facc15').bold('<' + name + '>')} ${chalk.whiteBright(content)}`;
  }
  return `${tag} ${chalk.hex('#a78bfa')('»')} ${chalk.hex('#e2e8f0')(msg || '')}`;
}
function printBotLog(botId, entry) {
  const level = entry.level || 'sys';
  if (level === 'chat' && !_showChatLog) return;
  const time = colors.muted(timeStr(entry.time));
  let line;
  if (level === 'chat') {
    line = `  ${time} ${formatChatLine(botId, entry.msg)}`;
  } else {
    const c = LEVEL_COLORS[level] || chalk.white;
    line = `  ${time} ${chalk.hex('#38bdf8')(`[${botId}]`)} ${c(`[${level.toUpperCase()}]`)} ${c(entry.msg || '')}`;
  }
  if (rl) {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(line);
    rl.prompt(true);
  } else {
    console.log(line);
  }
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
function centerLine(text, width, color = colors.title) {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return colors.border('║') + ' '.repeat(left) + color(text) + ' '.repeat(right) + colors.border('║');
}
function showBanner() {
  const width = 44;
  console.log('');
  console.log(colors.border('╔' + '═'.repeat(width) + '╗'));
  console.log(centerLine('✦  A N T A R E S  ✦', width, colors.accent));
  console.log(centerLine('Mine Bot Manager  •  v2.0', width, colors.title));
  console.log(colors.border('╠' + '═'.repeat(width) + '╣'));
  console.log(centerLine('Made By Antares', width, colors.muted));
  console.log(colors.border('╚' + '═'.repeat(width) + '╝'));
  console.log('');
}
function showHelp() {
  const cmds = [
    ['help, h', 'hiển thị trợ giúp này'],
    ['list', 'liệt kê tất cả bot'],
    ['start <id>', 'khởi động một bot'],
    ['stop <id>', 'dừng một bot'],
    ['cmd <id> <cmd>', 'gửi lệnh tới bot'],
    ['cmdall <cmd>', 'gửi lệnh tới TẤT CẢ bot đang online'],
    ['webhook set/test/off/events', 'cấu hình thông báo Discord'],
    ['webhook revenue set/test/off', 'webhook RIÊNG cho báo cáo doanh thu autosell_spawn'],
    ['schedule on <out> <in>', 'lịch tự out/vào bot theo giờ (HH:MM), vd 23:00 06:00'],
    ['cmd <id> autosell <%> <macro>', 'tự chạy macro khi túi đồ đầy %'],
    ['cmd <id> autosell_spawn on|off|every 5m|slot 51|now', 'tự click lồng → bấm ô bán → đóng GUI, lặp theo giờ/phút/giây'],
    ['cmd <id> help', 'xem tất cả lệnh của bot (tpa, macro, afk...)'],
    ['chatlog', 'bật/tắt hiển thị chat server/player'],
    ['proxy list', 'liệt kê proxy'],
    ['proxy add <raw>', 'thêm proxy'],
    ['proxy addfile <path>', 'thêm nhiều proxy từ file .txt (mỗi dòng 1 proxy)'],
    ['cmd <id> proxyrotate on|off', 'tự xoay proxy 1-10 phút/lần (ngẫu nhiên)'],
    ['sys', 'thông số hệ thống'],
    ['exit, q, e', 'thoát chương trình'],
  ];
  const labelW = Math.max(...cmds.map(([l]) => l.length));
  const innerW = labelW + 4 + Math.max(...cmds.map(([, d]) => d.length));
  console.log(colors.border('╭─ Commands ' + '─'.repeat(Math.max(0, innerW - 9)) + '╮'));
  for (const [label, desc] of cmds) {
    console.log(
      colors.border('│ ') + colors.key(label.padEnd(labelW)) + colors.muted('  — ' + desc)
    );
  }
  console.log(colors.border('╰' + '─'.repeat(innerW + 2) + '╯'));
}
function statusIcon(state) {
  if (state === 'ONLINE') return colors.ok('●');
  if (['RECONNECTING', 'CONNECTING', 'SPAWNING', 'AUTHENTICATING'].includes(state)) return colors.warn('●');
  return colors.err('●');
}
function showBotList(bots) {
  if (!bots.length) {
    console.log(colors.muted('  No bots configured.'));
    return;
  }
  const idW = Math.max(2, ...bots.map(b => b.getSummary().id.length));
  const stateW = Math.max(5, ...bots.map(b => b.getSummary().state.length));
  for (const b of bots) {
    const s = b.getSummary();
    const stats = (s.money || s.shard)
      ? `  ${chalk.hex('#facc15')('💰' + (s.money || 0).toLocaleString())} ${chalk.hex('#c084fc')('✨' + (s.shard || 0).toLocaleString())}`
      : '';
    console.log(
      `  ${statusIcon(s.state)} ${colors.title(s.id.padEnd(idW))}  ` +
      `${colors.muted(s.state.padEnd(stateW))}  ` +
      `${colors.accent(s.host + ':' + s.port)}  ${colors.muted(s.username)}${stats}`
    );
  }
}
function showSysInfo(m) {
  console.log(
    colors.border('  ┌ System ──────────────────────────────') + '\n' +
    `  ${colors.muted('Memory')}   ${colors.title((m.procHeap / 1024 / 1024).toFixed(0) + 'MB')} / ${colors.muted((m.totalMem / 1024 / 1024 / 1024).toFixed(1) + 'GB')}  ${colors.accent('(' + m.memPercent + '%)')}\n` +
    `  ${colors.muted('CPU')}      ${colors.title(m.cpuModel)} ${colors.muted('(' + m.cpuCount + ' cores)')}\n` +
    `  ${colors.muted('Uptime')}   ${colors.title(Math.floor(m.uptime / 3600) + 'h ' + Math.floor((m.uptime % 3600) / 60) + 'm')}\n` +
    `  ${colors.muted('Node')}     ${colors.title(m.nodeVersion)} ${colors.muted('| ' + m.platform + ' ' + m.arch)}\n` +
    colors.border('  └──────────────────────────────────────')
  );
}
let _shuttingDown = false;
function shutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(chalk.cyan('\n  Shutting down...'));
  if (dashboard) dashboard.shutdown();
  if (manager) manager.shutdown();
  if (expressServer && expressServer.listening) {
    expressServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000);
  } else {
    process.exit(0);
  }
}
(async () => {
  try {
    showBanner();
    await manager.init();
    dashboard.start();
    if (!expressServer.listening) {
      await new Promise((resolve) => {
        expressServer.once('listening', resolve);
        setTimeout(resolve, 5000);
      });
    }
    console.log(colors.accent(`⬡  Antares Manager started — ${manager.bots.length} bots loaded, none auto-started`));
    console.log(colors.accent(`   Dashboard: http://localhost:${dashboard.port}`));
    console.log('');
    if (!AUTO_EXE && process.stdin.isTTY) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colors.border('⬡ '),
        terminal: true,
      });
      rl.on('line', line => {
        const input = String(line || '').trim();
        if (!input) { rl.prompt(); return; }
        const parts = input.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const args = parts.slice(1);
        try {
          switch (cmd) {
            case 'help':
            case 'h':
              showHelp();
              break;
            case 'list':
            case 'ls':
              showBotList(manager.bots);
              break;
            case 'start': {
              if (!args[0]) { console.log(colors.muted('  Usage: start <id>')); break; }
              const b = manager.findBot(args[0]);
              if (!b) { console.log(colors.err('  Bot not found: ' + args[0])); break; }
              if (b.isConnected || b.isReconnecting) { console.log(colors.warn('  Bot already running')); break; }
              b._disabled = false; b.state.reconnects = 0; b.start();
              console.log(colors.ok('  ✓ Started: ' + args[0]));
              break;
            }
            case 'stop': {
              if (!args[0]) { console.log(colors.muted('  Usage: stop <id>')); break; }
              const b = manager.findBot(args[0]);
              if (!b) { console.log(colors.err('  Bot not found: ' + args[0])); break; }
              b.shutdown();
              console.log(colors.err('  ✓ Stopped: ' + args[0]));
              break;
            }
            case 'cmd': {
              if (args.length < 2) { console.log(colors.muted('  Usage: cmd <id> <command>')); break; }
              const b = manager.findBot(args[0]);
              if (!b) { console.log(colors.err('  Bot not found: ' + args[0])); break; }
              b.cmd(args.slice(1).join(' '));
              break;
            }
            case 'cmdall': {
              if (!args.length) { console.log(colors.muted('  Usage: cmdall <command> (vd: cmdall macro tpa_dahas)')); break; }
              const cmdText = args.join(' ');
              const online = manager.bots.filter(b => b.isOnline);
              if (!online.length) { console.log(colors.warn('  Không có bot nào đang ONLINE')); break; }
              console.log(colors.accent(`  → "${cmdText}" → ${online.length} bot: ${online.map(b => b.cfg.id).join(', ')}`));
              online.forEach(b => b.cmd(cmdText));
              break;
            }
            case 'schedule': {
              if (args[0] === 'on' && args[1] && args[2]) {
                const timeRe = /^([01]?\d|2[0-3]):([0-5]\d)$/;
                if (!timeRe.test(args[1]) || !timeRe.test(args[2])) {
                  console.log(colors.warn('  Giờ không hợp lệ — dùng dạng HH:MM (24h), vd 23:00'));
                  break;
                }
                const s = manager.setSchedule(true, args[1], args[2]);
                console.log(colors.ok(`  ✓ Lịch nghỉ: out lúc ${s.outTime}, vô lại lúc ${s.inTime} (múi giờ ${manager._scheduleTz()})`));
              } else if (args[0] === 'off') {
                manager.setSchedule(false, null, null);
                console.log(colors.ok('  ✓ Đã tắt lịch tự out/vào'));
              } else {
                const s = manager.getSchedule();
                console.log(colors.muted(s.enabled ? `  Đang bật: out ${s.outTime} — vô lại ${s.inTime}` : '  Đang tắt'));
                console.log(colors.muted('  Usage: schedule on <HH:MM out> <HH:MM in> | schedule off'));
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
                  console.log(colors.ok('  ✓ Đã lưu webhook doanh thu (riêng)'));
                } else if (args[1] === 'off') {
                  rn.configure(null, ['all']);
                  manager.persistence.set('revenueWebhookUrl', null);
                  console.log(colors.ok('  ✓ Đã tắt webhook doanh thu riêng — báo cáo sẽ đi qua webhook chung (nếu có)'));
                } else if (args[1] === 'test') {
                  if (!rn.enabled) { console.log(colors.warn('  Chưa đặt webhook doanh thu riêng — dùng: webhook revenue set <url>')); break; }
                  rn.test().then(ok => console.log(ok ? colors.ok('  ✓ Đã gửi test, kiểm tra kênh Discord') : colors.err('  ✗ Gửi thất bại — kiểm tra lại URL')));
                } else {
                  console.log(colors.muted('  Usage: webhook revenue set <url> | webhook revenue test | webhook revenue off'));
                  console.log(colors.muted('  Trạng thái: ' + (rn.enabled ? 'BẬT (webhook riêng)' : (notifier.enabled ? 'dùng webhook chung' : 'TẮT'))));
                }
                break;
              }
              if (args[0] === 'set' && args[1]) {
                notifier.configure(args[1], [...notifier.events]);
                manager.persistence.set('webhookUrl', args[1]);
                console.log(colors.ok('  ✓ Đã lưu webhook'));
              } else if (args[0] === 'off') {
                notifier.configure(null, [...notifier.events]);
                manager.persistence.set('webhookUrl', null);
                console.log(colors.ok('  ✓ Đã tắt webhook'));
              } else if (args[0] === 'test') {
                if (!notifier.enabled) { console.log(colors.warn('  Chưa cấu hình webhook — dùng: webhook set <url>')); break; }
                notifier.test().then(ok => console.log(ok ? colors.ok('  ✓ Đã gửi test, kiểm tra kênh Discord') : colors.err('  ✗ Gửi thất bại — kiểm tra lại URL')));
              } else if (args[0] === 'events') {
                if (!args[1]) {
                  console.log(colors.muted('  Đang bật: ' + [...notifier.events].join(', ')));
                  console.log(colors.muted('  Tất cả loại: ' + Object.keys(Notifier.EVENT_LABELS).join(', ')));
                } else {
                  const list = args[1].split(',').map(s => s.trim()).filter(Boolean);
                  notifier.configure(notifier.url, list);
                  manager.persistence.set('webhookEvents', list);
                  console.log(colors.ok('  ✓ Đã đặt loại sự kiện: ' + list.join(', ')));
                }
              } else {
                console.log(colors.muted('  Usage: webhook set <url> | webhook test | webhook off | webhook events [a,b,c]'));
                console.log(colors.muted('  Trạng thái: ' + (notifier.enabled ? 'BẬT' : 'TẮT')));
              }
              break;
            }
            case 'proxy':
              if (args[0] === 'list' || args[0] === 'ls') {
                const list = manager.proxyManager.getSummaries();
                if (!list.length) { console.log(colors.muted('  No proxies')); break; }
                for (const p of list) {
                  console.log(`  ${colors.accent(p.type.padEnd(7))} ${p.host}:${p.port}  ${colors.muted(p.status)}  ${p.ping >= 0 ? p.ping + 'ms' : '-'}`);
                }
              } else if (args[0] === 'add' && args[1]) {
                const r = manager.proxyManager.add(args.slice(1).join(' '));
                console.log(r.ok ? colors.ok('  ✓ Added: ' + r.msg) : colors.err('  ✗ Error: ' + r.msg));
              } else if (args[0] === 'addfile' && args[1]) {
                const r = manager.proxyManager.addFile(args.slice(1).join(' '));
                console.log(r.ok ? colors.ok('  ✓ ' + r.msg) : colors.err('  ✗ ' + r.msg));
              } else {
                console.log(colors.muted('  Usage: proxy list | proxy add <proxy-string> | proxy addfile <path>'));
              }
              break;
            case 'sys':
            case 'system':
              showSysInfo(manager.getSystemMetrics());
              break;
            case 'chatlog':
              _showChatLog = !_showChatLog;
              console.log(_showChatLog ? colors.ok('  ✓ Hiển thị chat: BẬT') : colors.warn('  ✓ Hiển thị chat: TẮT'));
              break;
            case 'exit':
            case 'quit':
            case 'q':
            case 'e':
              shutdown();
              return;
            default:
              console.log(colors.muted('  Unknown command. Type "help" for commands.'));
          }
        } catch (err) {
          console.error(colors.err('  Error:'), err.message);
        }
        rl.prompt();
      });
      rl.prompt(true);
    } else if (!AUTO_EXE) {
      console.log(colors.muted('   (non-TTY mode — dashboard running, CLI disabled)'));
    }
  } catch (e) {
    console.error(colors.err('[FATAL]'), e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', err => {
  console.error(colors.err('[UNCAUGHT]'), err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error(colors.err('[UNHANDLED]'), reason?.message || reason);
});
