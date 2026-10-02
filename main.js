'use strict';
const http = require('http');
const path = require('path');
const chalk = require('chalk');
const BotManager = require('./src/services/BotManager');
const Notifier = require('./src/core/Notifier');
const HelpCatalog = require('./src/core/HelpCatalog');
const { parseAddBotArgs, ADDBOT_USAGE } = require('./src/core/CliUtils');
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
// Trợ giúp chia phân khu: help | help <phân khu> | help <lệnh> | help all
// Màn hẹp (điện thoại/Termux): usage 1 dòng, mô tả xuống dòng dưới và tự ngắt dòng cho vừa màn.
function showHelp(query = '') {
  const reg = manager.bots[0] ? manager.bots[0].cmdRegistry.list() : null;
  const { lines } = HelpCatalog.buildHelp({ scope: 'console', query, registry: reg, customs: [] });
  const cols = process.stdout.columns || 80;
  const wide = cols >= 100;
  const uw = Math.min(46, Math.max(8, ...lines.filter(l => l.t === 'cmd').map(l => l.usage.length)));
  const bar = colors.border('│ ');
  let open = false;
  const close = () => { if (open) { console.log(colors.border('╰' + '─'.repeat(10))); open = false; } };
  const wrapText = (text, width) => {
    const out = []; let cur = '';
    for (const w of String(text).split(' ')) {
      if (cur && (cur + ' ' + w).length > width) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
    }
    if (cur) out.push(cur);
    return out;
  };
  const put = (indent, text, color) => {
    const rows = wide ? [text] : wrapText(text, Math.max(20, cols - 3 - indent.length));
    for (const r of rows) console.log(bar + indent + color(r));
  };
  for (const l of lines) {
    if (l.t === 'title') {
      close();
      const [head, ...rest] = l.text.split(' — ');
      const shown = wide ? l.text : head;
      console.log(colors.border('╭─ ') + colors.accent(shown) + ' ' + colors.border('─'.repeat(Math.max(2, Math.min(cols - shown.length - 6, 24)))));
      open = true;
      if (!wide && rest.length) put('', rest.join(' — '), colors.muted);
    } else if (l.t === 'menu') {
      const k = 'help ' + l.key;
      if (wide) console.log(bar + colors.key(k.padEnd(13)) + colors.muted(l.text));
      else { console.log(bar + colors.key(k)); put('    ', l.text, colors.muted); }
    } else if (l.t === 'head') {
      put('', l.text, colors.title);
    } else if (l.t === 'cmd') {
      if (wide && l.usage.length <= uw) {
        console.log(bar + '  ' + colors.key(l.usage.padEnd(uw)) + colors.muted('  — ' + l.desc));
      } else {
        put('  ', l.usage, colors.key);
        put('      ', l.desc, colors.muted);
      }
    } else if (l.t === 'note') {
      put('', l.text, colors.muted);
    } else if (l.t === 'warn') {
      if (!open) { console.log(colors.border('╭─ ') + colors.warn('Trợ giúp')); open = true; }
      put('', l.text, colors.warn);
    }
  }
  close();
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
// ===== addbot / delbot / web (localhost) cho CLI =====
// addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]   (hoặc dạng ip=.. port=.. ver=.. owner=.. id=..)
// Cái nào bỏ trống thì lấy theo bot đầu tiên (hoặc config gốc nếu chưa có bot).
function cliAddBot(args) {
  const printUsage = () => {
    console.log(colors.muted('  Usage: ' + ADDBOT_USAGE));
    console.log(colors.muted('    vd: addbot 123 mk 123'));
    console.log(colors.muted('        addbot 123 mk 123 play.abc.vn 25565 1.21.1 Steve'));
    console.log(colors.muted('        addbot 123 mk 123 ip=play.abc.vn ver=1.21.1     (dấu - = bỏ qua, lấy mặc định)'));
  };
  if (!args.length) { printUsage(); return null; }
  const r = parseAddBotArgs(args);
  if (!r.ok) { console.log(colors.err('  ✗ ' + r.error)); printUsage(); return null; }
  const { id, username, password, host: hostArg, port: portArg, version: verArg, owner: ownerArg } = r.data;
  if (manager.findBot(id)) { console.log(colors.err(`  ✗ ID "${id}" đã tồn tại`)); return null; }
  const dup = manager.bots.find(b => String(b.cfg.username).toLowerCase() === username.toLowerCase());
  if (dup) { console.log(colors.err(`  ✗ Tên "${username}" đã được bot "${dup.cfg.id}" dùng`)); return null; }
  const tpl = (manager.bots[0] && manager.bots[0].cfg) || {};
  const root = manager._config || {};
  const host = hostArg || tpl.host || root.host;
  const port = portArg || parseInt(tpl.port || root.port || 25565, 10);
  const version = verArg || tpl.version || root.version;
  const owner = ownerArg || tpl.ownerUsername || root.ownerUsername || '';
  if (!host) { console.log(colors.err('  ✗ Chưa biết IP server — thêm vào cuối lệnh, vd: addbot ' + username + ' mk ' + password + ' play.abc.vn')); return null; }
  const bot = manager.createBot({ id, host, port, version, username, password, ownerUsername: owner });
  try { if (manager.io) manager.io.emit('botAdded', bot.getSummary()); } catch { }
  console.log(colors.ok(`  ✓ Đã thêm bot "${id}"`));
  console.log(colors.muted(`    server ${host}:${port}  |  ver ${version || '(mặc định)'}  |  owner ${owner || '(chưa đặt)'}`));
  console.log(colors.muted(`    Chạy bot: start ${id}   (lần đầu bot tự gửi /dk rồi /dn)`));
  return bot;
}
function cliDelBot(args) {
  if (!args[0]) { console.log(colors.muted('  Usage: delbot <id>')); return; }
  const bot = manager.removeBot(args[0]);
  if (!bot) { console.log(colors.err('  Bot not found: ' + args[0])); return; }
  try { if (manager.io) manager.io.emit('botRemoved', { id: bot.cfg.id }); } catch { }
  console.log(colors.ok('  ✓ Đã xoá bot: ' + bot.cfg.id));
}
async function webCommand(sub) {
  sub = String(sub || 'status').toLowerCase();
  const url = `http://localhost:${dashboard.port}`;
  if (/^(on|bat|bật)$/.test(sub)) {
    if (dashboard.isRunning) { console.log(colors.warn('  Web đang BẬT sẵn: ' + url)); return; }
    const ok = await dashboard.start();
    if (ok) {
      manager.persistence.set('webDashboard', true);
      console.log(colors.ok('  ✓ Web BẬT → ' + url));
    } else {
      console.log(colors.err('  ✗ Không bật được web (xem lỗi ở trên)'));
    }
  } else if (/^(off|tat|tắt)$/.test(sub)) {
    if (!dashboard.isRunning) { console.log(colors.warn('  Web đang TẮT sẵn')); return; }
    await dashboard.stop();
    manager.persistence.set('webDashboard', false);
    console.log(colors.ok('  ✓ Web TẮT — bot vẫn chạy bình thường (bật lại: web on)'));
  } else if (sub === 'status') {
    console.log(dashboard.isRunning ? colors.ok('  Web: BẬT → ' + url) : colors.warn('  Web: TẮT (bật: web on)'));
  } else {
    console.log(colors.muted('  Usage: web on | web off | web status'));
  }
}
let _shuttingDown = false;
async function shutdown(code = 0) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(chalk.cyan('\n  Shutting down...'));
  const watchdog = setTimeout(() => process.exit(code), 5000); // không để treo nếu đóng cổng chậm
  if (watchdog.unref) watchdog.unref();
  try { if (dashboard) dashboard.shutdown(); } catch { }
  try { if (manager) manager.shutdown(); } catch { }
  try { if (dashboard) await dashboard.stop(); } catch { }
  process.exit(code);
}
(async () => {
  try {
    showBanner();
    await manager.init();
    // config.webDashboard=false (lệnh "web off") -> không mở web khi khởi động.
    // Luôn mở web nếu chạy AUTO_EXE (Render/Docker) hoặc không có CLI để bật lại.
    const webWanted = AUTO_EXE || !process.stdin.isTTY || manager._config.webDashboard !== false;
    const webOk = webWanted ? await dashboard.start() : false;
    console.log(colors.accent(`⬡  Antares Manager started — ${manager.bots.length} bots loaded, none auto-started`));
    if (webOk) console.log(colors.accent(`   Dashboard: http://localhost:${dashboard.port}`));
    else if (!webWanted) console.log(colors.muted('   Dashboard: TẮT — gõ "web on" để bật'));
    else console.log(colors.warn('   Dashboard: không mở được (xem lỗi phía trên) — CLI vẫn dùng bình thường, thử "web on" sau'));
    console.log('');
    if (!AUTO_EXE && process.stdin.isTTY) {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: colors.border('⬡ '),
        terminal: true,
      });
      manager.cliAsk = (msg) => console.log(colors.accent('  ' + msg));
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
                .catch(e => console.log(colors.err('  Error: ' + e.message)))
                .then(() => { if (rl) { readline.cursorTo(process.stdout, 0); readline.clearLine(process.stdout, 0); rl.prompt(true); } });
              return;
            case 'update': {
              if (!process.env.ANTER_LAUNCHER) { console.log(colors.warn('  Cần chạy bằng launcher: npm start (hoặc node launcher.js) mới dùng được lệnh update')); break; }
              console.log(colors.muted('  Đang kiểm tra GitHub...'));
              require('./updater').checkForUpdate().then(info => {
                if (info.firstRun) console.log(colors.muted('  Chưa có mốc phiên bản — khởi động lại bằng launcher để khởi tạo'));
                else if (!info.available) console.log(colors.ok('  ✓ Đang là bản mới nhất'));
                else { console.log(colors.ok(`  Có bản mới: ${info.message} — đang thoát để cập nhật...`)); shutdown(42); return; }
                if (rl) rl.prompt(true);
              }).catch(e => { console.log(colors.err('  Không kiểm tra được: ' + e.message)); if (rl) rl.prompt(true); });
              return;
            }
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
                } else if (args[1] === 'report' || args[1] === 'send') {
                  const r = manager.sendRevenueSummary();
                  console.log(r.ok ? colors.ok(`  ✓ Đã gửi báo cáo tổng hợp doanh thu (${r.via})`) : colors.warn('  ' + r.message));
                } else if (args[1] === 'every') {
                  const v = String(args[2] || '').toLowerCase();
                  const min = (v === 'off' || v === '0') ? 0 : manager.constructor.parseEveryMin(args.slice(2).join(''));
                  if (min === null || min === undefined) { console.log(colors.warn('  Cú pháp: webhook revenue every <30m|1h|1h30m|off>')); break; }
                  manager.setRevenueSummaryEvery(min);
                  console.log(colors.ok(min ? `  ✓ Tự gửi báo cáo tổng hợp mỗi ${min >= 60 && min % 60 === 0 ? (min / 60) + ' giờ' : min + ' phút'} (chỉ gửi khi có vòng bán mới)` : '  ✓ Đã tắt tự gửi báo cáo tổng hợp'));
                } else if (args[1] === 'test') {
                  if (!rn.enabled) { console.log(colors.warn('  Chưa đặt webhook doanh thu riêng — dùng: webhook revenue set <url>')); break; }
                  rn.test().then(ok => console.log(ok ? colors.ok('  ✓ Đã gửi test, kiểm tra kênh Discord') : colors.err('  ✗ Gửi thất bại — kiểm tra lại URL')));
                } else {
                  console.log(colors.muted('  Usage: webhook revenue set <url> | test | off | report | every <30m|1h|off>'));
                  console.log(colors.muted('  Tự gửi tổng hợp: ' + (manager._config?.revenueSummaryEveryMin ? `mỗi ${manager._config.revenueSummaryEveryMin} phút` : 'TẮT')));
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
              } else if (args[0] === 'mention' || args[0] === 'tag') {
                const v = args.slice(1).join(' ').trim();
                if (!v) {
                  console.log(colors.muted('  Tag hiện tại: ' + (notifier.mention || '(chưa đặt)') + ' — áp dụng cho: ' + [...notifier.mentionEvents].join(', ')));
                  console.log(colors.muted('  Usage: webhook mention <ID Discord | @tên | off> | webhook mention test'));
                  console.log(colors.muted('  Muốn PING thật phải dùng ID số (Discord: Cài đặt > Nâng cao > Chế độ nhà phát triển, rồi chuột phải tên > Sao chép ID). @tên chỉ hiện chữ.'));
                } else if (v.toLowerCase() === 'test') {
                  if (!notifier.enabled) { console.log(colors.warn('  Chưa cấu hình webhook — dùng: webhook set <url>')); break; }
                  notifier.testMention().then(ok => console.log(ok ? colors.ok('  ✓ Đã gửi tin thử, kiểm tra kênh Discord') : colors.err('  ✗ Gửi thất bại — kiểm tra lại URL')));
                } else {
                  notifier.setMention(v);
                  manager.persistence.set('webhookMention', v);
                  console.log(notifier.mention ? colors.ok('  ✓ Đã đặt tag: ' + notifier.mention + (/^<@/.test(notifier.mention) || /^@(everyone|here)$/.test(notifier.mention) ? '' : '  (chỉ hiện chữ, không ping — muốn ping hãy dùng ID số)')) : colors.ok('  ✓ Đã tắt tag'));
                }
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
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('uncaughtException', err => {
  console.error(colors.err('[UNCAUGHT]'), err.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error(colors.err('[UNHANDLED]'), reason?.message || reason);
});
