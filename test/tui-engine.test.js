'use strict';
const assert = require('assert');
const TuiEngine = require('../src/core/TuiEngine');
const CliUtils = require('../src/core/CliUtils');
const HelpCatalog = require('../src/core/HelpCatalog');

// 1. Environment & Capability Detection
{
  assert.strictEqual(TuiEngine.detectColorSupport({ isTTY: true }, { NO_COLOR: '1' }), false, 'NO_COLOR=1 must disable color');
  assert.strictEqual(TuiEngine.detectColorSupport({ isTTY: true }, { FORCE_COLOR: '1', NO_COLOR: '1' }), false, 'NO_COLOR takes precedence over FORCE_COLOR');
  assert.strictEqual(TuiEngine.detectColorSupport({ isTTY: false }, { FORCE_COLOR: '1' }), true, 'FORCE_COLOR=1 enables color on non-TTY');
  assert.strictEqual(TuiEngine.detectColorSupport({ isTTY: true }, { TERM: 'dumb' }), false, 'TERM=dumb disables color');
  assert.strictEqual(TuiEngine.detectColorSupport({ isTTY: false }, {}), false, 'non-TTY defaults to no color');
  assert.strictEqual(TuiEngine.detectColorSupport({ isTTY: true }, {}), true, 'TTY defaults to color enabled');
}

// 2. ANSI-Safe Width Calculation & String Manipulation
{
  const colorStyler = TuiEngine.createStyler(() => true);
  const plainStyler = TuiEngine.createStyler(() => false);

  const colored = colorStyler.successBold('[OK]') + ' ' + colorStyler.primary('Hello');
  assert.strictEqual(TuiEngine.visibleLength(colored), 10, 'visibleLength strips ANSI sequences');
  assert.strictEqual(TuiEngine.stripAnsi(colored), '[OK] Hello');
  assert.strictEqual(plainStyler.successBold('[OK]'), '[OK]', 'plain styler emits zero ANSI codes');

  const padded = TuiEngine.padAnsi(colored, 16, 'right');
  assert.strictEqual(TuiEngine.visibleLength(padded), 16, 'padAnsi pads to exact visible width');

  const truncated = TuiEngine.truncateAnsi(colorStyler.info('This is a very long diagnostic message'), 15);
  assert.strictEqual(TuiEngine.visibleLength(truncated), 15, 'truncateAnsi respects max visible width');
  assert.ok(TuiEngine.stripAnsi(truncated).endsWith('…'), 'truncateAnsi appends ellipsis');
}

// 3. Structured Colored Logging System
{
  const colorStyler = TuiEngine.createStyler(() => true);
  const plainStyler = TuiEngine.createStyler(() => false);
  const fixedTime = Date.UTC(2026, 9, 20, 12, 25, 10);

  const infoLog = TuiEngine.formatLogEntry({
    time: fixedTime,
    level: 'info',
    scope: 'bot-1',
    msg: 'Connected to upstream server (latency: 38ms) config/settings.json',
    tz: 'UTC',
  }, colorStyler);
  assert.ok(TuiEngine.stripAnsi(infoLog).startsWith('[12:25:10] [INFO   ] [bot-1] Connected to upstream server (latency: 38ms) config/settings.json'));
  assert.ok(infoLog.includes('\x1b['), 'Color log contains ANSI escape codes');

  const errLogPlain = TuiEngine.formatLogEntry({
    time: fixedTime,
    level: 'error',
    msg: 'Failed to initialize plugin "vision-core"\nCaused by: TimeoutError after 5000ms',
    tz: 'UTC',
  }, plainStyler);
  assert.strictEqual(errLogPlain.includes('\x1b['), false, 'Plain log must not contain ANSI escape codes');
  const errLines = errLogPlain.split('\n');
  assert.strictEqual(errLines.length, 2);
  assert.strictEqual(errLines[0], '[12:25:10] [ERROR  ] Failed to initialize plugin "vision-core"');
  assert.strictEqual(errLines[1], '           │ Caused by: TimeoutError after 5000ms');

  const aiLogPlain = TuiEngine.formatLogEntry({
    time: fixedTime,
    level: 'ai',
    msg: 'Analyzing diagnostic telemetry...',
    tz: 'UTC',
  }, plainStyler);
  assert.strictEqual(aiLogPlain, '[12:25:10] [AI     ] ✦ Analyzing diagnostic telemetry...');
}

// 4. ANSI-Aware Table Formatting Engine & Narrow Terminal (COLUMNS=80)
{
  const colorStyler = TuiEngine.createStyler(() => true);
  const tbl = TuiEngine.renderTable({
    title: 'MODULE DIAGNOSTICS',
    columns: [
      { key: 'name', header: 'MODULE', align: 'left', minWidth: 10 },
      { key: 'status', header: 'STATUS', align: 'left', minWidth: 10 },
      { key: 'latency', header: 'LATENCY', align: 'right', minWidth: 8 },
      { key: 'notes', header: 'NOTES', align: 'left', minWidth: 15 },
    ],
    rows: [
      { name: colorStyler.primary('spawner-guard'), status: TuiEngine.formatStatusPill('ONLINE', colorStyler), latency: '12ms', notes: null },
      { name: 'vision-core', status: TuiEngine.formatStatusPill('ERROR', colorStyler), latency: '5000ms', notes: 'Timeout', _rowRole: 'error' },
    ],
    footer: 'Total: 2 modules',
    maxWidth: 80,
    styler: colorStyler,
  });

  const lines = tbl.split('\n');
  const firstLineWidth = TuiEngine.visibleLength(lines[0]);
  assert.ok(firstLineWidth <= 80, `Table width (${firstLineWidth}) must fit within 80 columns`);
  for (const line of lines) {
    assert.strictEqual(TuiEngine.visibleLength(line), firstLineWidth, `Every table row must align to exact width (${firstLineWidth}): ${TuiEngine.stripAnsi(line)}`);
  }
  assert.ok(TuiEngine.stripAnsi(tbl).includes('╞'), 'Table uses distinct header separator ╞═╪═╡');
  assert.ok(TuiEngine.stripAnsi(tbl).includes('—'), 'Null values render as em-dash');
}

// 5. Dashboard & Startup Table Rendering at COLUMNS=80
{
  const fakeManager = {
    bots: [
      {
        getSummary: () => ({
          id: 'bot-alpha',
          username: 'AlphaUser',
          host: 'play.example.vn',
          port: 25565,
          state: 'ONLINE',
          ping: 38,
          money: 125000,
          shard: 450,
          afk: 'jump',
          spawnerProtect: 4,
          autoSellSpawn: 4,
          reconnects: 0,
        }),
      },
    ],
    getSummary: () => ({
      total: 1,
      counts: { ONLINE: 1, DISCONNECTED: 0 },
      totalPpsIn: 24,
      totalPpsOut: 12,
      avgPing: 38,
      systemMetrics: {
        procHeap: 48 * 1024 * 1024,
        procRss: 85 * 1024 * 1024,
        totalMem: 8 * 1024 * 1024 * 1024,
        memPercent: 32,
        cpuModel: 'AMD EPYC',
        cpuCount: 4,
        uptime: 7200,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
      },
    }),
    getBotCapacity: () => ({ currentBots: 1, maxRecommended: 50, maxAbsolute: 120, isWarning: false }),
    dashboard: { isRunning: true, port: 3000 },
    telegram: { enabled: true },
    notifier: { enabled: false },
    revenueNotifier: { enabled: true },
    proxyManager: { getSummaries: () => [{ type: 'socks5', host: '10.0.0.1', port: 1080, status: 'live', ping: 22 }] },
    getSchedule: () => ({ enabled: true, outTime: '23:00', inTime: '06:00' }),
  };

  const dash80 = TuiEngine.renderDashboard(fakeManager, { maxWidth: 80 });
  for (const line of dash80.split('\n')) {
    const w = TuiEngine.visibleLength(line);
    assert.ok(w <= 80, `Dashboard line width ${w} exceeds 80 chars: ${TuiEngine.stripAnsi(line)}`);
  }

  const botList80 = CliUtils.formatBotListTable(fakeManager.bots, { maxWidth: 80 });
  for (const line of botList80.split('\n')) {
    const w = TuiEngine.visibleLength(line);
    assert.ok(w <= 80, `Bot list table line width ${w} exceeds 80 chars`);
  }

  const helpOut = CliUtils.formatHelpOutput(HelpCatalog.buildHelp({ scope: 'console', query: '' }), { maxWidth: 80 });
  for (const line of helpOut.split('\n')) {
    if (!line) continue;
    const w = TuiEngine.visibleLength(line);
    assert.ok(w <= 80, `Help table line width ${w} exceeds 80 chars`);
  }
}

console.log('tui-engine.test OK');
