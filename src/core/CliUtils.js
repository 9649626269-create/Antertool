'use strict';
const {
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
  renderProgressBar,
  renderErrorBlock,
  getTerminalWidth,
  visibleLength,
  truncateAnsi,
  padAnsi,
  wrapAnsi,
  stripAnsi,
  BOX,
  SYMBOLS,
} = require('./TuiEngine');

// Parser cho lệnh CLI "addbot".
//
//   addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]
//   addbot 123 mk 123
//   addbot 123 mk 123 play.example.vn 25565 1.21.1 Steve
//   addbot 123 mk 123 play.example.vn:25565 1.21.1        (ip:port viết liền)
//   addbot 123 mk 123 - - 1.21.1                          ("-" = bỏ qua, lấy mặc định)
//   addbot 123 mk 123 ip=play.example.vn port=25565 ver=1.21.1 owner=Steve id=acc1
//
// Hàm này chỉ đọc + kiểm tra cú pháp. Giá trị bỏ trống để undefined, nơi gọi tự điền mặc định.

const USAGE = 'addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]';
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const OWNER_RE = /^[A-Za-z0-9_]{1,16}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const KV_RE = /^(id|host|ip|server|port|ver|version|owner)=(.*)$/i;
const isSkip = t => t === '-' || t === '_';

function fail(error) { return { ok: false, error }; }

function parseAddBotArgs(args) {
  const kv = {};
  const pos = [];
  for (const a of args || []) {
    const m = KV_RE.exec(a);
    if (m) {
      const k = m[1].toLowerCase();
      kv[k === 'ip' || k === 'server' ? 'host' : k === 'ver' ? 'version' : k] = m[2];
    } else pos.push(a);
  }

  const username = pos.shift();
  if (!username) return fail('Thiếu tên bot');
  if (pos.length && /^(mk|pass|password|pw|matkhau)$/i.test(pos[0])) pos.shift();
  const password = pos.shift();
  if (!password) return fail('Thiếu mật khẩu (addbot <tên> mk <mật khẩu>)');

  // Các tham số vị trí còn lại: host -> port -> ver -> owner. Thiếu cái nào thì bỏ qua cái đó
  // (vd "host 1.21.1" hiểu là host + ver, port lấy mặc định).
  let host, port, version, owner;
  let slot = 0;
  while (pos.length) {
    const t = pos[0];
    if (slot === 0) {
      pos.shift(); slot = 1;
      if (isSkip(t)) continue;
      const i = t.lastIndexOf(':');
      if (i > 0) {                       // ip:port viết liền
        host = t.slice(0, i);
        const p = t.slice(i + 1);
        if (!/^\d{1,5}$/.test(p)) return fail(`Port không hợp lệ trong "${t}"`);
        port = p; slot = 2;
      } else host = t;
    } else if (slot === 1) {
      if (/^\d{1,5}$/.test(t)) { port = t; pos.shift(); }
      else if (isSkip(t)) pos.shift();
      slot = 2;                          // không phải số -> coi như bỏ port, xét token này ở ô ver
    } else if (slot === 2) {
      if (VERSION_RE.test(t)) { version = t; pos.shift(); }
      else if (isSkip(t)) pos.shift();
      slot = 3;
    } else if (slot === 3) {
      pos.shift(); slot = 4;
      if (!isSkip(t)) owner = t;
    } else {
      return fail(`Dư tham số: ${pos.join(' ')}`);
    }
  }

  // key=value ghi đè giá trị vị trí
  if (kv.host !== undefined) host = kv.host;
  if (kv.port !== undefined) port = kv.port;
  if (kv.version !== undefined) version = kv.version;
  if (kv.owner !== undefined) owner = kv.owner;

  if (!USER_RE.test(username)) return fail(`Tên bot phải 3-16 ký tự (chữ, số, dấu _): ${username}`);
  const id = kv.id !== undefined ? kv.id : username;
  if (!ID_RE.test(id)) return fail('id chỉ gồm chữ, số, _ . - (tối đa 32 ký tự)');
  if (host !== undefined && !HOST_RE.test(host)) return fail(`IP/host server không hợp lệ: ${host}`);
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return fail(`Port không hợp lệ (1-65535): ${port}`);
    port = n;
  }
  if (version !== undefined && !VERSION_RE.test(version)) return fail(`Version phải dạng 1.21.1 (nhận được: ${version})`);
  if (owner !== undefined && !OWNER_RE.test(owner)) return fail(`Tên owner không hợp lệ (chữ, số, _ tối đa 16 ký tự): ${owner}`);

  return { ok: true, data: { id, username, password, host, port, version, owner } };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI Table Views (Bot List, System Diagnostics, Proxies, Help)
// ─────────────────────────────────────────────────────────────────────────────

function formatBotListTable(bots = [], options = {}) {
  const styler = options.styler || theme;
  const maxWidth = options.maxWidth || getTerminalWidth();
  if (!bots.length) {
    return renderTable({
      title: '🤖 CONFIGURED BOT SESSIONS (0)',
      columns: [
        { key: 'id', header: 'BOT ID', minWidth: 10 },
        { key: 'state', header: 'STATUS', minWidth: 12 },
        { key: 'server', header: 'SERVER ENDPOINT', minWidth: 18 },
        { key: 'account', header: 'ACCOUNT', minWidth: 12 },
      ],
      rows: [],
      footer: `${formatBadge('IDLE', 'muted', styler)}  No bots configured — run ${styler.key('addbot <name> mk <pass> <ip>')} to add one.`,
      maxWidth,
      styler,
    });
  }

  let online = 0;
  let totalMoney = 0;
  let totalShard = 0;

  const rows = bots.map((b) => {
    const s = typeof b.getSummary === 'function' ? b.getSummary() : b;
    if (s.state === 'ONLINE') online++;
    totalMoney += s.money || 0;
    totalShard += s.shard || 0;

    const features = [];
    if (s.afk) features.push(styler.success(`AFK:${s.afk}`));
    if (s.autoSellSpawn) features.push(styler.ai(`Sell:${s.autoSellSpawn}`));
    if (s.spawnerProtect) features.push(styler.info(`Guard:${s.spawnerProtect}`));

    return {
      id: styler.primary(s.id || '—'),
      state: formatStatusPill(s.state || 'DISCONNECTED', styler),
      server: styler.info(`${s.host || '—'}:${s.port || 25565}`),
      username: styler.white(s.username || '—'),
      ping: s.ping >= 0 ? styler.duration(`${s.ping}ms`) : styler.muted('—'),
      money: s.money ? styler.key(`$${Number(s.money).toLocaleString()}`) : styler.muted('—'),
      shard: s.shard ? styler.ai(`✦ ${Number(s.shard).toLocaleString()}`) : styler.muted('—'),
      tasks: features.length ? features.join(' ') : styler.muted('—'),
    };
  });

  const footer = `${formatBadge(online > 0 ? 'ONLINE' : 'STANDBY', online > 0 ? 'success' : 'muted', styler)}  Active: ${styler.primary(`${online}/${bots.length}`)}  •  Total Money: ${styler.key('$' + totalMoney.toLocaleString())}  •  Total Shards: ${styler.ai('✦ ' + totalShard.toLocaleString())}`;

  return renderTable({
    title: `🤖 BOT SESSIONS & RUNTIME TELEMETRY (${bots.length})`,
    columns: [
      { key: 'id', header: 'BOT ID', align: 'left', minWidth: 8, maxWidth: 16 },
      { key: 'state', header: 'STATUS', align: 'left', minWidth: 12, maxWidth: 16 },
      { key: 'server', header: 'ENDPOINT', align: 'left', minWidth: 14, maxWidth: 24 },
      { key: 'username', header: 'ACCOUNT', align: 'left', minWidth: 8, maxWidth: 16 },
      { key: 'ping', header: 'PING', align: 'right', minWidth: 5, maxWidth: 8 },
      { key: 'money', header: 'MONEY', align: 'right', minWidth: 7, maxWidth: 14 },
      { key: 'shard', header: 'SHARDS', align: 'right', minWidth: 7, maxWidth: 12 },
      { key: 'tasks', header: 'MODULES', align: 'left', minWidth: 8, maxWidth: 22 },
    ],
    rows,
    footer,
    maxWidth,
    styler,
  });
}

function formatSysInfoTable(m = {}, cap = null, options = {}) {
  const styler = options.styler || theme;
  const maxWidth = options.maxWidth || getTerminalWidth();
  const heapMB = ((m.procHeap || 0) / 1024 / 1024).toFixed(1);
  const rssMB = ((m.procRss || 0) / 1024 / 1024).toFixed(1);
  const totalGB = ((m.totalMem || 0) / 1024 / 1024 / 1024).toFixed(2);
  const memPct = m.memPercent || 0;
  const upH = Math.floor((m.uptime || 0) / 3600);
  const upM = Math.floor(((m.uptime || 0) % 3600) / 60);

  const rows = [
    {
      metric: styler.primary('Memory (Heap / RSS)'),
      value: `${styler.duration(heapMB + ' MB')} heap · ${styler.info(rssMB + ' MB')} RSS / ${totalGB} GB total`,
      status: `${renderProgressBar(memPct, 100, { width: 10, styler })}`,
    },
    {
      metric: styler.primary('CPU Architecture'),
      value: `${styler.white(m.cpuModel || 'Unknown')} (${m.cpuCount || 1} cores)`,
      status: formatBadge('OK', 'success', styler),
    },
    {
      metric: styler.primary('Host Uptime'),
      value: styler.duration(`${upH}h ${upM}m`),
      status: formatStatusPill('ONLINE', styler),
    },
    {
      metric: styler.primary('Node.js Runtime'),
      value: `${styler.info(m.nodeVersion || process.version)} · ${m.platform || process.platform}/${m.arch || process.arch}`,
      status: formatBadge('READY', 'info', styler),
    },
  ];

  if (cap && typeof cap.maxRecommended === 'number') {
    rows.push({
      metric: styler.primary('Bot Capacity Est.'),
      value: `${cap.currentBots || 0} loaded / ${cap.maxRecommended} rec (${cap.maxAbsolute} max)`,
      status: cap.isWarning ? formatBadge('WARN', 'warning', styler) : formatBadge('HEALTHY', 'success', styler),
    });
  }

  return renderTable({
    title: '⚙ SYSTEM TELEMETRY & RESOURCE DIAGNOSTICS',
    columns: [
      { key: 'metric', header: 'METRIC', align: 'left', minWidth: 16, maxWidth: 24 },
      { key: 'value', header: 'TELEMETRY VALUE', align: 'left', minWidth: 24, maxWidth: 46 },
      { key: 'status', header: 'STATE / LOAD', align: 'left', minWidth: 12, maxWidth: 20 },
    ],
    rows,
    maxWidth,
    styler,
  });
}

function formatProxyTable(list = [], options = {}) {
  const styler = options.styler || theme;
  const maxWidth = options.maxWidth || getTerminalWidth();
  const rows = list.map((p, idx) => ({
    idx: String(idx + 1),
    type: styler.info(String(p.type || 'socks5').toUpperCase()),
    endpoint: styler.primary(`${p.host}:${p.port}`),
    status: formatStatusPill(["dead", "die", "auth_fail", "timeout"].includes(p.status) ? "OFFLINE" : (p.status === "live" ? "ONLINE" : (p.status || "READY")), styler),
    ping: p.ping >= 0 ? styler.duration(`${p.ping}ms`) : styler.muted('—'),
    tag: p.tag ? styler.key(p.tag) : styler.muted('—'),
  }));

  return renderTable({
    title: `🌐 PROXY POOL DIRECTORY (${list.length})`,
    columns: [
      { key: 'idx', header: '#', align: 'right', minWidth: 2, maxWidth: 5 },
      { key: 'type', header: 'PROTOCOL', align: 'left', minWidth: 6, maxWidth: 10 },
      { key: 'endpoint', header: 'HOST:PORT', align: 'left', minWidth: 15, maxWidth: 28 },
      { key: 'status', header: 'STATUS', align: 'left', minWidth: 10, maxWidth: 14 },
      { key: 'ping', header: 'LATENCY', align: 'right', minWidth: 6, maxWidth: 10 },
      { key: 'tag', header: 'TAG / GEO', align: 'left', minWidth: 6, maxWidth: 18 },
    ],
    rows,
    maxWidth,
    styler,
  });
}

function formatHelpOutput(helpResult, options = {}) {
  const styler = options.styler || theme;
  const maxWidth = options.maxWidth || getTerminalWidth();
  const lines = (helpResult && helpResult.lines) || [];

  const blocks = [];
  let curTitle = '📖 COMMAND REFERENCE';
  let curRows = [];
  let curNotes = [];

  const flushSection = () => {
    if (!curRows.length && !curNotes.length) return;
    if (curRows.length) {
      blocks.push(renderTable({
        title: `✦ ${curTitle}`,
        columns: [
          { key: 'cmd', header: 'COMMAND / SYNTAX', align: 'left', minWidth: 18, maxWidth: Math.max(22, Math.floor(maxWidth * 0.42)) },
          { key: 'desc', header: 'DESCRIPTION & USAGE', align: 'left', minWidth: 20, maxWidth: Math.max(26, Math.floor(maxWidth * 0.52)) },
        ],
        rows: curRows,
        footer: curNotes.length ? curNotes.join('  •  ') : null,
        maxWidth,
        styler,
      }));
    } else if (curNotes.length) {
      for (const n of curNotes) {
        blocks.push(formatLogEntry({ level: 'warn', msg: n }, styler));
      }
    }
    curRows = [];
    curNotes = [];
  };

  for (const l of lines) {
    if (l.t === 'title') {
      flushSection();
      curTitle = l.text;
    } else if (l.t === 'menu') {
      curRows.push({
        cmd: styler.key(`help ${l.key}`),
        desc: styler.white(l.text),
      });
    } else if (l.t === 'head') {
      curRows.push({
        cmd: styler.infoBold(`▸ ${l.text}`),
        desc: styler.muted('─'.repeat(16)),
      });
    } else if (l.t === 'cmd') {
      curRows.push({
        cmd: styler.key(l.usage),
        desc: styler.white(l.desc),
      });
    } else if (l.t === 'note') {
      curNotes.push(styler.muted(l.text));
    } else if (l.t === 'warn') {
      curNotes.push(styler.warning(l.text));
    }
  }
  flushSection();
  return blocks.join('\n\n');
}

module.exports = {
  parseAddBotArgs,
  ADDBOT_USAGE: USAGE,
  // Re-export TUI utilities for convenient centralized access
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
  renderProgressBar,
  renderErrorBlock,
  formatBotListTable,
  formatSysInfoTable,
  formatProxyTable,
  formatHelpOutput,
  getTerminalWidth,
  visibleLength,
  truncateAnsi,
  padAnsi,
  wrapAnsi,
  stripAnsi,
  BOX,
  SYMBOLS,
};
