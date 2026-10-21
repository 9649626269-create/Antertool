'use strict';

/**
 * Rebuilt Terminal Dashboard & Shared CLI Views.
 * - Step 1: Parity inventory covering accounts, spawner protection, auto-sell spawn,
 *   /home treolong AFK position, retry counters, webhooks/Telegram, tasks/progress,
 *   real statistics, and recent warnings/errors.
 * - Step 2: Pure read-only data collector `collectDashboardState(manager, options)`.
 * - Step 3: Pure renderer `renderDashboard(state, caps, theme, options)` with 4 width tiers:
 *   >= 100 cols (full tables), 60-99 cols (compact tables), 40-59 cols (stacked key-value blocks),
 *   < 40 cols (single-line status summary).
 * - Live in-place controller throttled to <= 2 redraws/sec and only when state changes.
 */

const { renderTable, renderStackedBlocks } = require('./table');
const { renderProgressBar } = require('./progress');
const { visibleWidth, truncate, pad, sanitizeUntrusted, maskSecret, redactSecretsInText } = require('./text');
const { readAppMeta } = require('./startup');
const { formatTimestamp } = require('./logger');

function fmtDurationSec(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtAgeMs(ageMs) {
  if (ageMs === null || ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return null;
  const sec = Math.floor(ageMs / 1000);
  if (sec < 2) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m ago`;
}

function fmtCompactNum(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return null;
  const num = Number(n);
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2).replace(/\.?0+$/, '')}T`;
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2).replace(/\.?0+$/, '')}K`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * Step 2: Read-only data contract collector.
 * Collects dashboard state from BotManager, BotSession, RevenueTracker, ProxyManager,
 * Notifier, TelegramNotifier, FileLogger, ChatFilter, and WebDashboard without mutating anything.
 */
function collectDashboardState(manager, options = {}) {
  const now = options.now || Date.now();
  const meta = readAppMeta(options.pkgPath);
  const bots = (manager && Array.isArray(manager.bots)) ? manager.bots : [];
  const secrets = bots.map(b => b?.cfg?.botPassword).filter(Boolean);
  if (manager && manager._config && manager._config.botPassword) secrets.push(manager._config.botPassword);
  if (manager && manager._config && manager._config.dashboardToken) secrets.push(manager._config.dashboardToken);

  const sys = (manager && typeof manager.getSystemMetrics === 'function')
    ? manager.getSystemMetrics()
    : null;
  const cap = (manager && typeof manager.getBotCapacity === 'function')
    ? manager.getBotCapacity()
    : null;

  let onlineCount = 0;
  let connectingCount = 0;
  let reconnectingCount = 0;
  let offlineCount = 0;
  let totalPpsIn = 0;
  let totalPpsOut = 0;
  let pingSum = 0;
  let pingCount = 0;

  const accounts = [];
  const tasks = [];
  const botEvents = [];

  for (const bot of bots) {
    const s = typeof bot.getSummary === 'function' ? bot.getSummary() : {};
    const st = String(s.state || bot.state?.connState || 'DISCONNECTED').toUpperCase();
    if (st === 'ONLINE') onlineCount++;
    else if (st === 'RECONNECTING') reconnectingCount++;
    else if (['CONNECTING', 'AUTHENTICATING', 'SPAWNING'].includes(st)) connectingCount++;
    else offlineCount++;

    totalPpsIn += Number(s.ppsIn) || 0;
    totalPpsOut += Number(s.ppsOut) || 0;
    const ping = typeof s.ping === 'number' && s.ping >= 0 ? s.ping : null;
    if (ping !== null) {
      pingSum += ping;
      pingCount++;
    }

    // Position and /home treolong status
    const pos = s.position && typeof s.position.x === 'number'
      ? `${Math.round(s.position.x)},${Math.round(s.position.y)},${Math.round(s.position.z)}`
      : null;
    const homeCmd = bot.spawnHomeEnabled !== false ? (bot.spawnHomeCommand || '/home treolong') : null;
    const homeTries = bot._homeOutage && typeof bot._homeOutage.tries === 'number' ? bot._homeOutage.tries : 0;
    const homeMaxTries = typeof bot.spawnHomeMaxTries === 'number' ? bot.spawnHomeMaxTries : 5;
    let homeStatus = null;
    if (st === 'ONLINE') {
      if (bot._posLost) {
        homeStatus = `AWAY (${homeCmd || '/home'} ${homeTries}/${homeMaxTries})`;
      } else if (bot._featuresActive) {
        homeStatus = `HOME (${homeCmd || '/home'})`;
      } else if (homeCmd) {
        homeStatus = 'GATE WAIT';
      } else {
        homeStatus = 'ONLINE';
      }
    }

    // Spawner protection & Auto-sell spawn status per bot
    const spOn = Boolean(bot._spawnerProtectOn);
    const spCount = Array.isArray(bot.protectedSpawners) ? bot.protectedSpawners.length : (s.spawnerProtect || 0);
    const spLevel = bot._spLevel || 2;
    const sellOn = Boolean(bot._sellSpawnOn);
    const sellCount = Array.isArray(bot.sellSpawnList) ? bot.sellSpawnList.length : (s.autoSellSpawn || 0);
    const sellMaxHome = typeof bot.sellFailMaxHome === 'number' ? bot.sellFailMaxHome : 10;
    const sellTries = typeof bot._sellHomeTries === 'number' ? bot._sellHomeTries : 0;

    // Last packet / event age
    const lastPacketAt = typeof s.lastPacket === 'number' && s.lastPacket > 0 ? s.lastPacket : null;
    const lastPacketAgeMs = lastPacketAt ? Math.max(0, now - lastPacketAt) : null;
    const lastPacketStale = lastPacketAgeMs !== null && lastPacketAgeMs > 30000;

    const logs = typeof bot.getLogs === 'function' ? bot.getLogs() : [];
    const lastLog = logs.length ? logs[logs.length - 1] : null;
    const lastEventAt = lastLog && lastLog.time ? lastLog.time : lastPacketAt;
    const lastEventAgeMs = lastEventAt ? Math.max(0, now - lastEventAt) : null;
    const lastEventStale = lastEventAgeMs !== null && lastEventAgeMs > 60000;
    const lastEventText = lastLog && lastLog.msg
      ? redactSecretsInText(sanitizeUntrusted(String(lastLog.msg).split('\n')[0]), secrets)
      : null;

    // Collect recent warn/err events from bot log buffer
    for (let i = Math.max(0, logs.length - 15); i < logs.length; i++) {
      const entry = logs[i];
      if (!entry) continue;
      const lvl = String(entry.level || '').toLowerCase();
      if (lvl === 'warn' || lvl === 'err' || lvl === 'health') {
        botEvents.push({
          time: entry.time || now,
          level: lvl === 'err' ? 'ERROR' : 'WARNING',
          botId: s.id || bot.cfg?.id || 'bot',
          msg: redactSecretsInText(sanitizeUntrusted(String(entry.msg || '').split('\n')[0]), secrets),
        });
      }
    }

    // Current activity summary
    const actParts = [];
    if (bot._spawnerBusy) actParts.push('Mining Spawners');
    else if (bot._sellRecovering) actParts.push(`Sell Retry ${sellTries}/${sellMaxHome}`);
    else if (bot._sellSpawnBusy) actParts.push('Selling Spawners');
    else if (bot.scriptRunner && bot.scriptRunner.running) actParts.push(`Macro: ${bot.scriptRunner.currentMacro || 'run'}`);
    else if (bot.autoOrder && bot.autoOrder.active) actParts.push(`Order: ${bot.autoOrder.item}`);
    else if (s.afk) actParts.push(`AFK:${s.afk}`);
    if (spOn) actParts.push(`Prot:${spCount}(L${spLevel})`);
    if (sellOn) actParts.push(`Sell:${sellCount}`);

    const maxRec = typeof bot._reconnectMaxRetries === 'number' ? bot._reconnectMaxRetries : 10;
    const recCount = Number(s.reconnects) || 0;
    if (recCount > 0) {
      actParts.push(`Retry:${recCount}/${maxRec}`);
    }

    // Real measurable tasks/progress for this bot
    const invCount = Array.isArray(bot.state?.inventory) ? bot.state.inventory.length : 0;
    if (st === 'ONLINE' || bot.autoSellMacro || invCount > 0) {
      tasks.push({
        id: `${s.id || bot.cfg?.id}:inv`,
        label: `${s.id || bot.cfg?.id} Inventory`,
        current: invCount,
        total: 36,
        unit: 'slots',
      });
    }
    if (bot.moneyGoal && Number(bot.moneyGoal) > 0) {
      tasks.push({
        id: `${s.id || bot.cfg?.id}:goal`,
        label: `${s.id || bot.cfg?.id} Money Goal`,
        current: Math.min(Number(bot.moneyGoal), Number(s.money) || 0),
        total: Number(bot.moneyGoal),
        unit: '$',
      });
    }
    if (recCount > 0 && maxRec > 0 && maxRec < 999) {
      tasks.push({
        id: `${s.id || bot.cfg?.id}:reconnect`,
        label: `${s.id || bot.cfg?.id} Reconnect`,
        current: recCount,
        total: maxRec,
        unit: 'tries',
      });
    }
    if (homeTries > 0 && homeMaxTries > 0) {
      tasks.push({
        id: `${s.id || bot.cfg?.id}:home`,
        label: `${s.id || bot.cfg?.id} Home Retry`,
        current: homeTries,
        total: homeMaxTries,
        unit: 'tries',
      });
    }

    accounts.push({
      id: s.id || bot.cfg?.id || '-',
      username: s.username || bot.cfg?.username || null,
      state: st,
      server: (s.host || bot.cfg?.host) ? `${s.host || bot.cfg.host}:${s.port || bot.cfg.port || 25565}` : null,
      version: s.version || bot.cfg?.version || null,
      position: pos,
      homeStatus,
      homeCmd,
      homeTries,
      homeMaxTries,
      ping,
      money: typeof s.money === 'number' ? s.money : null,
      shard: typeof s.shard === 'number' ? s.shard : null,
      health: typeof s.health === 'number' ? s.health : null,
      food: typeof s.food === 'number' ? s.food : null,
      reconnects: recCount,
      maxReconnects: maxRec,
      spawnerProtectOn: spOn,
      spawnerProtectCount: spCount,
      spawnerProtectLevel: spLevel,
      autoSellSpawnOn: sellOn,
      autoSellSpawnCount: sellCount,
      sellTries,
      sellMaxHome,
      activity: actParts.length ? actParts.join(' · ') : (lastEventText || null),
      lastEventText,
      lastEventAt,
      lastEventAgeMs,
      lastEventStale,
      lastPacketAgeMs,
      lastPacketStale,
    });
  }

  if (bots.length > 0) {
    tasks.unshift({
      id: 'fleet:online',
      label: 'Fleet Online',
      current: onlineCount,
      total: bots.length,
      unit: 'bots',
    });
  }

  // Revenue statistics across all bots
  let revTotal = 0;
  let revToday = 0;
  let rev1h = 0;
  let rev24h = 0;
  let revCycles = 0;
  let revRateSum = 0;
  let revHasRate = false;
  let revLastAt = null;

  if (manager && manager.revenue && typeof manager.revenue.stats === 'function') {
    for (const b of bots) {
      const id = b.cfg?.id;
      if (!id) continue;
      for (const key of [id, `${id}#macro`]) {
        const st = manager.revenue.stats(key, now);
        if (!st) continue;
        revTotal += Number(st.total) || 0;
        revToday += Number(st.today) || 0;
        rev1h += Number(st.last1h) || 0;
        rev24h += Number(st.last24h) || 0;
        revCycles += Number(st.cycles) || 0;
        if (st.avgPerHour != null) {
          revRateSum += Number(st.avgPerHour) || 0;
          revHasRate = true;
        }
        if (st.lastAt && (!revLastAt || st.lastAt > revLastAt)) {
          revLastAt = st.lastAt;
        }
      }
    }
  }

  // Features & Modules summary
  const spEnabledBots = accounts.filter(a => a.spawnerProtectOn);
  const spTotalSpawners = accounts.reduce((acc, a) => acc + (a.spawnerProtectCount || 0), 0);
  const sellEnabledBots = accounts.filter(a => a.autoSellSpawnOn);
  const sellTotalSpawners = accounts.reduce((acc, a) => acc + (a.autoSellSpawnCount || 0), 0);
  const homeEnabledBots = bots.filter(b => b.spawnHomeEnabled !== false);
  const homeCmdSample = (homeEnabledBots[0] && homeEnabledBots[0].spawnHomeCommand) || '/home treolong';
  const totalHomeRetries = accounts.reduce((acc, a) => acc + (a.homeTries || 0), 0);
  const maxHomeRetries = accounts.reduce((acc, a) => Math.max(acc, a.homeMaxTries || 5), 5);
  const totalSellRetries = accounts.reduce((acc, a) => acc + (a.sellTries || 0), 0);
  const maxSellRetries = accounts.reduce((acc, a) => Math.max(acc, a.sellMaxHome || 10), 10);
  const totalReconnects = accounts.reduce((acc, a) => acc + (a.reconnects || 0), 0);
  const maxReconnects = accounts.reduce((acc, a) => Math.max(acc, a.maxReconnects || 10), 10);

  const wh = manager && manager.notifier;
  const revWh = manager && manager.revenueNotifier;
  const tg = manager && manager.telegram;
  const tgLogs = manager && manager.telegramLogs;
  const fl = manager && manager.fileLogs;
  const sched = (manager && typeof manager.getSchedule === 'function') ? manager.getSchedule() : null;
  const webDash = (manager && manager.dashboard) || options.webDashboard || null;
  const chatFilter = options.chatFilter || null;
  const proxies = (manager && manager.proxyManager && typeof manager.proxyManager.getSummaries === 'function')
    ? manager.proxyManager.getSummaries()
    : [];

  const liveProxies = proxies.filter(p => p.status === 'live').length;
  const deadProxies = proxies.filter(p => p.status === 'die' || p.status === 'auth_fail' || p.status === 'timeout').length;

  const modules = [
    {
      module: 'Spawner Protect',
      status: spEnabledBots.length > 0 ? 'ENABLED' : 'DISABLED',
      details: `${spEnabledBots.length}/${bots.length} bots · ${spTotalSpawners} spawners`,
    },
    {
      module: 'Auto-Sell Spawn',
      status: sellEnabledBots.length > 0 ? 'ENABLED' : 'DISABLED',
      details: `${sellEnabledBots.length}/${bots.length} bots · ${sellTotalSpawners} spawners · Retry ${totalSellRetries}/${maxSellRetries}`,
    },
    {
      module: 'AFK Home Guard',
      status: homeEnabledBots.length > 0 ? 'ENABLED' : 'DISABLED',
      details: `${homeCmdSample} · ${homeEnabledBots.length}/${bots.length} bots · Retry ${totalHomeRetries}/${maxHomeRetries}`,
    },
    {
      module: 'Reconnect Guard',
      status: reconnectingCount > 0 ? 'RETRYING' : 'OK',
      details: `Active retries: ${totalReconnects}/${maxReconnects} · Reconnecting: ${reconnectingCount}`,
    },
    {
      module: 'Discord Webhook',
      status: (wh && wh.enabled) || (revWh && revWh.enabled) ? 'ENABLED' : 'DISABLED',
      details: [
        wh && wh.enabled ? `Alerts: ${maskSecret(wh.url)}` : 'Alerts: off',
        revWh && revWh.enabled ? `Rev: ${maskSecret(revWh.url)}` : (wh && wh.enabled ? 'Rev: shared' : 'Rev: off'),
      ].join(' · '),
    },
    {
      module: 'Telegram & Logs',
      status: tg && tg.enabled ? 'ENABLED' : (tg && tg.hasToken ? 'WARN' : 'DISABLED'),
      details: tg && tg.enabled
        ? `Mode: ${manager._config?.telegramMode || 'edit'} · Logs: ${tgLogs && tgLogs.enabled ? 'on' : 'off'}`
        : (tg && tg.hasToken ? 'Token set, missing chat_id' : 'Not configured'),
    },
    {
      module: 'Web & FileLog',
      status: (webDash && webDash.isRunning) || (fl && fl.enabled) ? 'OK' : 'DISABLED',
      details: [
        webDash && webDash.isRunning ? `Web: http://localhost:${webDash.port}` : 'Web: off',
        fl && fl.enabled ? `Log: ${fl.currentFile}` : 'Log: off',
        sched && sched.enabled ? `Rest: ${sched.outTime}->${sched.inTime}` : null,
        proxies.length ? `Proxies: ${liveProxies}/${proxies.length} live` : null,
      ].filter(Boolean).join(' · '),
    },
  ];

  if (chatFilter) {
    modules.push({
      module: 'Chat Filter',
      status: chatFilter.enabled ? 'ENABLED' : 'DISABLED',
      details: `Mode: ${chatFilter.mode} · Shown: ${chatFilter.stats?.shown || 0} · Dedup: ${(chatFilter.stats?.dedupCrossBot || 0) + (chatFilter.stats?.dedupBroadcast || 0)}`,
    });
  }

  // Merge recent events from logger and bot buffers, sorted chronologically, bounded to last 6
  const loggerEvents = (options.logger && typeof options.logger.getRecentEvents === 'function')
    ? options.logger.getRecentEvents(10)
    : [];
  const mergedEvents = [...loggerEvents, ...botEvents]
    .sort((a, b) => (a.time || 0) - (b.time || 0));
  // Deduplicate identical consecutive events
  const dedupedEvents = [];
  for (const ev of mergedEvents) {
    const prev = dedupedEvents[dedupedEvents.length - 1];
    if (prev && prev.botId === ev.botId && prev.level === ev.level && prev.msg === ev.msg && Math.abs((ev.time || 0) - (prev.time || 0)) < 2000) {
      continue;
    }
    const ageMs = ev.time ? Math.max(0, now - ev.time) : null;
    dedupedEvents.push({
      ...ev,
      ageMs,
      ageText: fmtAgeMs(ageMs),
      stale: ageMs !== null && ageMs > 300000,
    });
  }
  const recentEvents = dedupedEvents.slice(-6);

  // Overall status
  let overallStatus = 'IDLE';
  if (manager && manager._inRest) overallStatus = 'RESTING';
  else if (onlineCount > 0 && reconnectingCount === 0) overallStatus = 'ONLINE';
  else if (reconnectingCount > 0 || connectingCount > 0) overallStatus = 'WARN';
  else if (bots.length > 0 && onlineCount === 0) overallStatus = 'OFFLINE';

  return {
    now,
    meta,
    uptimeSec: typeof options.uptimeSec === 'number' ? options.uptimeSec : process.uptime(),
    overallStatus,
    counts: {
      total: bots.length,
      online: onlineCount,
      connecting: connectingCount,
      reconnecting: reconnectingCount,
      offline: offlineCount,
    },
    accounts,
    modules,
    tasks,
    statistics: {
      revTotal: revCycles > 0 || revTotal > 0 ? revTotal : null,
      revToday: revCycles > 0 || revToday > 0 ? revToday : null,
      rev1h: revCycles > 0 || rev1h > 0 ? rev1h : null,
      rev24h: revCycles > 0 || rev24h > 0 ? rev24h : null,
      revRatePerHour: revHasRate ? revRateSum : null,
      revCycles,
      revLastAt,
      revLastAgeMs: revLastAt ? Math.max(0, now - revLastAt) : null,
      ppsIn: totalPpsIn,
      ppsOut: totalPpsOut,
      avgPing: pingCount > 0 ? Math.round(pingSum / pingCount) : null,
      heapMB: sys ? Math.round((sys.procHeap || 0) / 1048576) : null,
      rssMB: sys ? Math.round((sys.procRss || 0) / 1048576) : null,
      totalMemGB: sys ? Number(((sys.totalMem || 0) / 1073741824).toFixed(1)) : null,
      memPercent: sys ? sys.memPercent : null,
      cpuModel: sys ? sys.cpuModel : null,
      cpuCount: sys ? sys.cpuCount : null,
      nodeVersion: sys ? sys.nodeVersion : process.version,
      platform: sys ? `${sys.platform}/${sys.arch}` : `${process.platform}/${process.arch}`,
      capacityBots: cap ? `${cap.currentBots}/${cap.maxRecommended}` : null,
      capacityPct: cap ? cap.capacityPercent : null,
      proxiesTotal: proxies.length,
      proxiesLive: liveProxies,
      proxiesDead: deadProxies,
    },
    recentEvents,
    controls: [
      'list',
      'status',
      'dash live',
      'start <id>',
      'stop <id>',
      'cmd <id> <cmd>',
      'web on|off',
      'help',
      'exit',
    ],
  };
}

/**
 * Compute a state signature (excluding sub-second clock jitter) so the live dashboard
 * redraws only when displayed data or terminal width actually changed.
 */
function computeStateSignature(state, width = 80) {
  if (!state) return '';
  const upBucket = Math.floor((state.uptimeSec || 0));
  const accSig = (state.accounts || []).map(a =>
    `${a.id}:${a.state}:${a.ping}:${a.position}:${a.homeStatus}:${a.money}:${a.shard}:${a.activity}:${a.reconnects}`
  ).join('|');
  const modSig = (state.modules || []).map(m => `${m.module}:${m.status}:${m.details}`).join('|');
  const statSig = `${state.statistics?.revTotal}:${state.statistics?.revCycles}:${state.statistics?.ppsIn}:${state.statistics?.ppsOut}:${state.statistics?.heapMB}`;
  const evSig = (state.recentEvents || []).map(e => `${e.time}:${e.level}:${e.botId}:${e.msg}`).join('|');
  return `${width}#${upBucket}#${state.overallStatus}#${accSig}#${modSig}#${statSig}#${evSig}`;
}

/**
 * Step 3: Pure function that turns collected dashboard state + terminal capabilities into lines of text.
 * Supports 4 layout tiers by terminal width:
 * - >= 100 columns: full tables
 * - 60 to 99 columns: compact tables with fewer columns
 * - 40 to 59 columns: key-value blocks, one section per account
 * - < 40 columns: single-line status summary
 */
function renderDashboard(state, caps = null, theme = null, options = {}) {
  const width = Math.max(16, Number(options.width || (caps && caps.width) || 80));
  const ascii = !(caps && caps.unicode);
  const sym = (caps && caps.symbols) || { ok: 'OK', fail: 'X', warn: '!', bullet: '*', dash: '-' };
  const b = (caps && caps.borders) || { horizontal: '-', vertical: '|' };

  const titleFn = theme ? theme.title : (s => s);
  const mutedFn = theme ? theme.muted : (s => s);
  const keyFn = theme ? theme.key : (s => s);
  const borderFn = theme ? theme.border : (s => s);

  const c = state.counts || { total: 0, online: 0, connecting: 0, reconnecting: 0, offline: 0 };
  const st = state.statistics || {};
  const upStr = fmtDurationSec(state.uptimeSec || 0);

  // Tier 4: Under 40 columns -> single-line status summary
  if (width < 40) {
    const revStr = st.revTotal != null ? `$${fmtCompactNum(st.revTotal)}` : '-';
    const warnErr = (state.recentEvents || []).length;
    const statusBadge = theme ? theme.formatStatus(state.overallStatus || 'IDLE', { symbol: false }).text : (state.overallStatus || 'IDLE');
    const summary = `Antertool v${state.meta?.version || '1.0.0'} | ${statusBadge} ${c.online}/${c.total} | ${revStr} | E:${warnErr} | ${upStr}`;
    return [truncate(summary, width, { ascii })];
  }

  const lines = [];
  const sectionRule = (label) => {
    const prefix = `${b.horizontal}${b.horizontal} `;
    const title = titleFn(label);
    const used = visibleWidth(prefix) + visibleWidth(label) + 1;
    const tail = b.horizontal.repeat(Math.max(2, width - used));
    return truncate(`${borderFn(prefix)}${title} ${borderFn(tail)}`, width, { ascii });
  };

  // 1. Header
  const statusObj = theme ? theme.formatStatus(state.overallStatus || 'IDLE') : { text: state.overallStatus || 'IDLE' };
  const hdrLeft = `${titleFn(state.meta?.displayName || 'Antertool Premium v2')} ${mutedFn('v' + (state.meta?.version || '1.0.0'))}`;
  const hdrMid = `Status: ${statusObj.text} (${keyFn(`${c.online}/${c.total}`)} online)`;
  const hdrRight = `Uptime: ${keyFn(upStr)}`;
  lines.push(truncate(`${hdrLeft}  ${mutedFn('|')}  ${hdrMid}  ${mutedFn('|')}  ${hdrRight}`, width, { ascii }));
  lines.push(borderFn(b.horizontal.repeat(width)));

  // 2. Accounts / Sessions
  lines.push(sectionRule(`Accounts & Sessions (${c.online}/${c.total} online)`));
  const accountRows = (state.accounts || []).map(a => {
    const nameLabel = a.username && a.username.toLowerCase() !== String(a.id).toLowerCase()
      ? `${a.id} (${a.username})`
      : a.id;
    const posHome = [a.position, a.homeStatus].filter(Boolean).join(' ') || null;
    const balParts = [];
    if (a.money !== null && a.money !== undefined) balParts.push(`$${fmtCompactNum(a.money)}`);
    if (a.shard !== null && a.shard !== undefined && a.shard > 0) balParts.push(`${fmtCompactNum(a.shard)} sh`);
    const bal = balParts.length ? balParts.join(' / ') : null;
    const ageSuffix = a.lastEventAgeMs != null
      ? ` (${fmtAgeMs(a.lastEventAgeMs)}${a.lastEventStale ? ' STALE' : ''})`
      : '';
    const act = a.activity ? `${a.activity}${ageSuffix}` : null;
    return {
      id: a.id,
      name: nameLabel,
      username: a.username || null,
      state: a.state,
      server: a.server || null,
      posHome,
      ping: a.ping !== null && a.ping !== undefined ? `${a.ping}ms` : null,
      balance: bal,
      activity: act,
    };
  });

  if (width >= 100) {
    // Tier 1: >= 100 cols -> Full Accounts Table
    const accCols = [
      { key: 'name', label: 'Account', align: 'left', minWidth: 10, maxWidth: 22, priority: 1 },
      { key: 'state', label: 'State', align: 'left', minWidth: 10, maxWidth: 16, priority: 1, status: true },
      { key: 'posHome', label: 'Position / Home', align: 'left', minWidth: 34, maxWidth: 40, priority: 2 },
      { key: 'ping', label: 'Ping', align: 'right', minWidth: 4, maxWidth: 7, priority: 2 },
      { key: 'balance', label: 'Balance', align: 'right', minWidth: 7, maxWidth: 16, priority: 2 },
      { key: 'activity', label: 'Activity / Last Event', align: 'left', minWidth: 16, maxWidth: 44, flex: true, priority: 1 },
    ];
    lines.push(...renderTable(accCols, accountRows, { maxWidth: width, emptyText: 'No bots configured (use: addbot <name> mk <pass> <host>)' }, caps, theme));
  } else if (width >= 60) {
    // Tier 2: 60 to 99 cols -> Compact Accounts Table
    const compactCols = [
      { key: 'id', label: 'Bot', align: 'left', minWidth: 5, maxWidth: 14, priority: 1 },
      { key: 'state', label: 'State', align: 'left', minWidth: 8, maxWidth: 14, priority: 1, status: true },
      { key: 'ping', label: 'Ping', align: 'right', minWidth: 4, maxWidth: 7, priority: 2 },
      { key: 'posHome', label: 'Pos / Home', align: 'left', minWidth: 10, maxWidth: 22, priority: 2 },
      { key: 'activity', label: 'Activity', align: 'left', minWidth: 10, maxWidth: 30, flex: true, priority: 1 },
    ];
    lines.push(...renderTable(compactCols, accountRows, { maxWidth: width, emptyText: 'No bots configured' }, caps, theme));
  } else {
    // Tier 3: 40 to 59 cols -> Stacked Key-Value blocks per account
    const kvCols = [
      { key: 'name', label: 'Account' },
      { key: 'state', label: 'State', status: true },
      { key: 'ping', label: 'Ping' },
      { key: 'posHome', label: 'Home' },
      { key: 'balance', label: 'Balance' },
      { key: 'activity', label: 'Activity' },
    ];
    lines.push(...renderStackedBlocks(kvCols, accountRows, { emptyText: 'No bots configured' }, { ...caps, width }, theme));
  }

  // 3. Features & Modules
  lines.push(sectionRule('Features & Modules'));
  if (width >= 60) {
    const modCols = [
      { key: 'module', label: 'Module', align: 'left', minWidth: 14, maxWidth: 20, priority: 1 },
      { key: 'status', label: 'Status', align: 'left', minWidth: 9, maxWidth: 14, priority: 1, status: true },
      { key: 'details', label: 'Details', align: 'left', minWidth: 16, maxWidth: 68, flex: true, priority: 1 },
    ];
    lines.push(...renderTable(modCols, state.modules || [], { maxWidth: width, stackedThreshold: 58 }, caps, theme));
  } else {
    for (const m of state.modules || []) {
      const stTxt = theme ? theme.formatStatus(m.status).text : m.status;
      lines.push(truncate(`  ${keyFn(m.module)}: ${stTxt} · ${mutedFn(m.details || '-')}`, width, { ascii }));
    }
  }

  // 4. Tasks & Progress (only real counters with known totals)
  if (state.tasks && state.tasks.length > 0) {
    lines.push(sectionRule('Tasks & Progress'));
    const barWidth = width >= 80 ? 12 : 8;
    for (const t of state.tasks.slice(0, 5)) {
      const bar = renderProgressBar(t.current, t.total, { width: barWidth, unit: t.unit }, caps, theme);
      if (bar) {
        const lbl = pad(truncate(t.label, 22, { ascii }), Math.min(22, Math.floor(width * 0.38)), 'left');
        lines.push(truncate(`  ${mutedFn(lbl)} ${bar}`, width, { ascii }));
      }
    }
  }

  // 5. Statistics (real counters with units; unknown values as dimmed dash)
  lines.push(sectionRule('Statistics & System'));
  const dash = mutedFn('-');
  const revTotalStr = st.revTotal != null ? keyFn(`$${fmtCompactNum(st.revTotal)}`) : dash;
  const revTodayStr = st.revToday != null ? keyFn(`$${fmtCompactNum(st.revToday)}`) : dash;
  const rev1hStr = st.rev1h != null ? keyFn(`$${fmtCompactNum(st.rev1h)}`) : dash;
  const revRateStr = st.revRatePerHour != null ? keyFn(`$${fmtCompactNum(st.revRatePerHour)}/h`) : dash;
  const revCyclesStr = keyFn(`${st.revCycles || 0} cycles`);
  const revAgeStr = st.revLastAgeMs != null ? mutedFn(`(last: ${fmtAgeMs(st.revLastAgeMs)})`) : '';

  const ppsStr = `${keyFn(`${st.ppsIn || 0} pps`)} in / ${keyFn(`${st.ppsOut || 0} pps`)} out`;
  const avgPingStr = st.avgPing != null ? keyFn(`${st.avgPing} ms`) : dash;
  const memStr = st.heapMB != null && st.totalMemGB != null
    ? `${keyFn(`${st.heapMB} MB`)} heap / ${st.totalMemGB} GB RAM (${st.memPercent ?? 0}%)`
    : dash;
  const capStr = st.capacityBots != null ? `${keyFn(`${st.capacityBots} bots`)} (${st.capacityPct ?? 0}%)` : dash;

  if (width >= 60) {
    lines.push(truncate(`  ${mutedFn('Revenue  :')} Total ${revTotalStr} · Today ${revTodayStr} · 1h ${rev1hStr} · Rate ${revRateStr} · ${revCyclesStr} ${revAgeStr}`, width, { ascii }));
    lines.push(truncate(`  ${mutedFn('Network  :')} Traffic ${ppsStr} · Avg Ping ${avgPingStr} · Proxies ${keyFn(`${st.proxiesLive || 0}/${st.proxiesTotal || 0} live`)}`, width, { ascii }));
    lines.push(truncate(`  ${mutedFn('System   :')} ${memStr} · Capacity ${capStr} · Node ${keyFn(st.nodeVersion || process.version)}`, width, { ascii }));
  } else {
    lines.push(truncate(`  ${mutedFn('Rev :')} ${revTotalStr} (1h: ${rev1hStr}, ${revCyclesStr})`, width, { ascii }));
    lines.push(truncate(`  ${mutedFn('Net :')} ${ppsStr} · Ping ${avgPingStr}`, width, { ascii }));
    lines.push(truncate(`  ${mutedFn('Sys :')} ${st.heapMB != null ? keyFn(st.heapMB + 'MB') : dash} · Cap ${capStr}`, width, { ascii }));
  }

  // 6. Recent Events (last few warnings/errors from bounded buffer)
  lines.push(sectionRule('Recent Warnings & Errors'));
  if (!state.recentEvents || !state.recentEvents.length) {
    lines.push(truncate(`  ${mutedFn('No recent warnings or errors.')}`, width, { ascii }));
  } else {
    for (const ev of state.recentEvents) {
      const tStr = mutedFn(`[${formatTimestamp(ev.time)}]`);
      const lvlBadge = ev.level === 'ERROR'
        ? (theme ? theme.errorBold(`[${sym.fail} ERR]`) : '[X ERR]')
        : (theme ? theme.warning(`[${sym.warn} WARN]`) : '[! WARN]');
      const botLbl = keyFn(`[${ev.botId || 'system'}]`);
      const ageLbl = ev.ageText ? mutedFn(` (${ev.ageText}${ev.stale ? ', stale' : ''})`) : '';
      lines.push(truncate(`  ${tStr} ${lvlBadge} ${botLbl} ${ev.msg}${ageLbl}`, width, { ascii }));
    }
  }

  // 7. Footer (hints only for controls that exist)
  lines.push(borderFn(b.horizontal.repeat(width)));
  const controlsText = (state.controls || []).join(' · ');
  const footerHint = options.live
    ? `Live View (updates <= 2/s) — Type "dash off" or press Enter/command to control · ${controlsText}`
    : `Controls: ${controlsText}`;
  lines.push(truncate(`  ${mutedFn(footerHint)}`, width, { ascii }));

  return lines;
}

/**
 * Shared Table View for `list` / `ls` CLI command.
 */
function renderBotListView(bots, caps = null, theme = null) {
  const list = Array.isArray(bots) ? bots : [];
  if (!list.length) {
    return [theme ? theme.muted('  No bots configured.') : '  No bots configured.'];
  }
  const cols = [
    { key: 'id', label: 'ID', align: 'left', minWidth: 6, maxWidth: 18, priority: 1 },
    { key: 'state', label: 'State', align: 'left', minWidth: 10, maxWidth: 16, priority: 1, status: true },
    { key: 'server', label: 'Server', align: 'left', minWidth: 10, maxWidth: 24, priority: 2 },
    { key: 'username', label: 'Username', align: 'left', minWidth: 6, maxWidth: 18, priority: 2 },
    { key: 'ping', label: 'Ping', align: 'right', minWidth: 5, maxWidth: 8, priority: 3 },
    { key: 'money', label: 'Money', align: 'right', minWidth: 6, maxWidth: 14, priority: 2 },
    { key: 'shard', label: 'Shards', align: 'right', minWidth: 6, maxWidth: 12, priority: 3 },
  ];
  const rows = list.map(b => {
    const s = typeof b.getSummary === 'function' ? b.getSummary() : b;
    return {
      id: s.id || '-',
      state: s.state || 'DISCONNECTED',
      server: s.host ? `${s.host}:${s.port || 25565}` : null,
      username: s.username || null,
      ping: typeof s.ping === 'number' && s.ping >= 0 ? `${s.ping}ms` : null,
      money: s.money ? `$${Number(s.money).toLocaleString('en-US')}` : null,
      shard: s.shard ? Number(s.shard).toLocaleString('en-US') : null,
    };
  });
  return renderTable(cols, rows, { emptyText: 'No bots configured.' }, caps, theme);
}

/**
 * Shared Table View for `sys` / `system` CLI command.
 */
function renderSysInfoView(m, cap = null, caps = null, theme = null) {
  if (!m) return [];
  const cols = [
    { key: 'metric', label: 'System Metric', align: 'left', minWidth: 10, maxWidth: 20, priority: 1 },
    { key: 'value', label: 'Value', align: 'left', minWidth: 16, maxWidth: 56, flex: true, priority: 1 },
  ];
  const rows = [
    {
      metric: 'Memory',
      value: `${((m.procHeap || 0) / 1048576).toFixed(0)} MB heap / ${((m.totalMem || 0) / 1073741824).toFixed(1)} GB total (${m.memPercent ?? 0}%)`,
    },
    {
      metric: 'CPU',
      value: `${m.cpuModel || 'Unknown'} (${m.cpuCount || 1} cores)`,
    },
    {
      metric: 'Uptime',
      value: `${Math.floor((m.uptime || 0) / 3600)}h ${Math.floor(((m.uptime || 0) % 3600) / 60)}m`,
    },
    {
      metric: 'Node / OS',
      value: `${m.nodeVersion || process.version} | ${m.platform || process.platform} ${m.arch || process.arch}`,
    },
  ];
  if (cap) {
    rows.push({
      metric: 'Bot Capacity',
      value: `${cap.currentBots}/${cap.maxRecommended} recommended (${cap.capacityPercent}%) · max ${cap.maxAbsolute} idle`,
    });
  }
  return renderTable(cols, rows, {}, caps, theme);
}

/**
 * Shared Table View for `proxy list` CLI command.
 */
function renderProxyListView(proxies, caps = null, theme = null) {
  const list = Array.isArray(proxies) ? proxies : [];
  if (!list.length) {
    return [theme ? theme.muted('  No proxies') : '  No proxies'];
  }
  const cols = [
    { key: 'idx', label: '#', align: 'right', minWidth: 2, maxWidth: 5, priority: 2 },
    { key: 'type', label: 'Type', align: 'left', minWidth: 6, maxWidth: 10, priority: 1 },
    { key: 'endpoint', label: 'Host:Port', align: 'left', minWidth: 12, maxWidth: 28, priority: 1 },
    { key: 'status', label: 'Status', align: 'left', minWidth: 8, maxWidth: 14, priority: 1, status: true },
    { key: 'ping', label: 'Ping', align: 'right', minWidth: 5, maxWidth: 9, priority: 2 },
    { key: 'tag', label: 'Tag', align: 'left', minWidth: 4, maxWidth: 16, priority: 3 },
  ];
  const rows = list.map((p, idx) => ({
    idx: String(idx + 1),
    type: String(p.type || 'socks5').toUpperCase(),
    endpoint: `${p.host}:${p.port}`,
    status: String(p.status || 'unknown').toUpperCase(),
    ping: typeof p.ping === 'number' && p.ping >= 0 ? `${p.ping}ms` : null,
    tag: p.tag || null,
  }));
  return renderTable(cols, rows, { emptyText: 'No proxies' }, caps, theme);
}

/**
 * Shared View for `help` CLI command using shared table/borders.
 */
function renderHelpView(helpData, caps = null, theme = null) {
  const rawLines = (helpData && Array.isArray(helpData.lines)) ? helpData.lines : [];
  const width = Math.max(20, (caps && caps.width) || 80);
  const ascii = !(caps && caps.unicode);
  const b = (caps && caps.borders) || { horizontal: '-', vertical: '|', topLeft: '+', bottomLeft: '+' };
  const borderFn = theme ? theme.border : (s => s);
  const accentFn = theme ? theme.accent : (s => s);
  const titleFn = theme ? theme.title : (s => s);
  const keyFn = theme ? theme.key : (s => s);
  const mutedFn = theme ? theme.muted : (s => s);
  const warnFn = theme ? theme.warning : (s => s);

  const out = [];
  let cmdBatch = [];

  const flushCmdBatch = () => {
    if (!cmdBatch.length) return;
    const cols = [
      { key: 'usage', label: 'Command / Usage', align: 'left', minWidth: 12, maxWidth: 44, priority: 1, format: (v) => keyFn(v) },
      { key: 'desc', label: 'Description', align: 'left', minWidth: 16, maxWidth: 72, flex: true, wrap: true, priority: 1, format: (v) => mutedFn(v) },
    ];
    out.push(...renderTable(cols, cmdBatch, { maxWidth: width, stackedThreshold: 52 }, caps, theme));
    cmdBatch = [];
  };

  for (const l of rawLines) {
    if (l.t === 'cmd') {
      cmdBatch.push({ usage: l.usage, desc: l.desc });
      continue;
    }
    if (l.t === 'menu') {
      cmdBatch.push({ usage: `help ${l.key}`, desc: l.text });
      continue;
    }
    flushCmdBatch();
    if (l.t === 'title') {
      const rule = b.horizontal.repeat(Math.max(2, Math.min(width - visibleWidth(l.text) - 5, 20)));
      out.push(truncate(`${borderFn(b.topLeft + b.horizontal + ' ')}${accentFn(l.text)} ${borderFn(rule)}`, width, { ascii }));
    } else if (l.t === 'head') {
      out.push(truncate(`  ${titleFn(l.text)}`, width, { ascii }));
    } else if (l.t === 'note') {
      out.push(truncate(`  ${mutedFn(l.text)}`, width, { ascii }));
    } else if (l.t === 'warn') {
      out.push(truncate(`  ${warnFn(l.text)}`, width, { ascii }));
    } else if (l.t === 'gap') {
      out.push('');
    }
  }
  flushCmdBatch();
  return out;
}

/**
 * Live Dashboard Controller: redraws in place at most twice per second (500ms)
 * and only when state or terminal dimensions change.
 */
class LiveDashboardController {
  constructor(options = {}) {
    this.manager = options.manager;
    this.writer = options.writer;
    this.caps = options.caps || (this.writer && this.writer.caps);
    this.theme = options.theme || (this.writer && this.writer.theme);
    this.logger = options.logger || null;
    this.chatFilter = options.chatFilter || null;
    this.intervalMs = Math.max(500, Number(options.intervalMs) || 500); // at most twice per second
    this._active = false;
    this._timer = null;
    this._lastSig = '';
    this._unsubResize = null;
  }

  get isActive() {
    return this._active;
  }

  collectState(now = Date.now()) {
    return collectDashboardState(this.manager, {
      now,
      logger: this.logger,
      chatFilter: this.chatFilter,
    });
  }

  renderSnapshot(opts = {}) {
    const state = this.collectState(opts.now);
    return renderDashboard(state, this.caps, this.theme, { live: Boolean(opts.live), width: opts.width });
  }

  printSnapshot(opts = {}) {
    const lines = this.renderSnapshot(opts);
    if (this.writer) {
      this.writer.writeLines(lines);
    }
    return lines;
  }

  startLive() {
    if (this._active) return true;
    if (!this.caps || !this.caps.interactive || !this.writer) {
      // Non-interactive fallback: print a single plain snapshot without cursor control
      this.printSnapshot({ live: false });
      return false;
    }
    this._active = true;
    this._lastSig = '';
    this._tick(true);

    this._timer = setInterval(() => {
      if (!this._active) return;
      this._tick(false);
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref();

    if (this.caps && typeof this.caps.onResize === 'function') {
      this._unsubResize = this.caps.onResize(() => {
        if (this._active) this._tick(true);
      });
    }
    return true;
  }

  _tick(force = false) {
    if (!this._active || !this.writer) return;
    const state = this.collectState();
    const width = (this.caps && this.caps.width) || 80;
    const sig = computeStateSignature(state, width);
    if (!force && sig === this._lastSig) return;
    this._lastSig = sig;
    const lines = renderDashboard(state, this.caps, this.theme, { live: true, width });
    this.writer.renderLiveFrame(lines);
  }

  stopLive() {
    if (!this._active) return false;
    this._active = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._unsubResize) {
      this._unsubResize();
      this._unsubResize = null;
    }
    this._lastSig = '';
    if (this.writer) {
      this.writer.stopLiveFrame();
    }
    return true;
  }
}

module.exports = {
  fmtDurationSec,
  fmtAgeMs,
  fmtCompactNum,
  collectDashboardState,
  computeStateSignature,
  renderDashboard,
  renderBotListView,
  renderSysInfoView,
  renderProxyListView,
  renderHelpView,
  LiveDashboardController,
};
