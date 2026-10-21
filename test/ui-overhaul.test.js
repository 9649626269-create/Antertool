'use strict';

/**
 * Comprehensive verification suite for Antertool Premium v2 Terminal UI Overhaul.
 */

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

class Vec3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
const V = (x, y, z) => new Vec3(x, y, z); V.Vec3 = Vec3;
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') {
    return {
      createBot() {
        const mc = new EventEmitter();
        mc._client = new EventEmitter();
        mc._client.socket = { destroy() {} };
        mc._client.write = () => {};
        mc._client.end = () => {};
        return mc;
      },
    };
  }
  if (request === 'vec3') return V;
  return origLoad.call(this, request, ...rest);
};

const BotManager = require('../src/services/BotManager');
const ChatFilter = require('../src/core/ChatFilter');
const HelpCatalog = require('../src/core/HelpCatalog');
const ui = require('../src/ui');

function makeCaptureStream({ isTTY = true, columns = 80, rows = 24 } = {}) {
  const emitter = new EventEmitter();
  const chunks = [];
  emitter.isTTY = isTTY;
  emitter.columns = columns;
  emitter.rows = rows;
  emitter.write = (str) => { chunks.push(String(str)); return true; };
  emitter.getOutput = () => chunks.join('');
  emitter.getLines = () => chunks.join('').split('\n').filter((l, idx, arr) => !(idx === arr.length - 1 && l === ''));
  emitter.clear = () => { chunks.length = 0; };
  return emitter;
}

(async () => {
  // ── 1. Logging: exact format, SERVER label, multiline gutter, nested exceptions, no duplicates ──
  {
    const stream = makeCaptureStream({ isTTY: true, columns: 100 });
    const rt = ui.createUIRuntime({
      stream,
      env: { FORCE_COLOR: '1' },
      argv: [],
      registerCleanup: false,
      getSecrets: () => ['my-bot-secret-pw'],
      getTz: () => 'UTC',
    });

    const fixedTime = Date.UTC(2026, 9, 20, 19, 25, 10);
    rt.logger.info('Connected to server successfully.', { time: fixedTime });
    rt.logger.success('Configuration loaded.', { time: fixedTime + 1000 });
    rt.logger.warn('Retry attempt 2/5.', { time: fixedTime + 2000 });
    rt.logger.error('Failed to initialize module.', { time: fixedTime + 3000 });
    rt.logger.ai('Analyzing diagnostic information...', { time: fixedTime + 4000 });
    rt.logger.setMinLevel('DEBUG');
    rt.logger.debug('Module initialization completed.', { time: fixedTime + 5000 });
    rt.logger.server('§a<Steve> §fHello world!', {
      botId: 'bot-1',
      time: fixedTime + 6000,
      serverChat: { kind: 'player', sender: 'Steve', content: 'Hello world!' },
    });

    const plainLines = stream.getLines().map(ui.stripAnsi);
    assert.strictEqual(plainLines.length, 7, 'Each log call must emit exactly 1 line (no duplicate handlers)');
    assert.strictEqual(plainLines[0], '[19:25:10] [INFO]    Connected to server successfully.');
    assert.strictEqual(plainLines[1], '[19:25:11] [SUCCESS] Configuration loaded.');
    assert.strictEqual(plainLines[2], '[19:25:12] [WARNING] Retry attempt 2/5.');
    assert.strictEqual(plainLines[3], '[19:25:13] [ERROR]   Failed to initialize module.');
    assert.strictEqual(plainLines[4], '[19:25:14] [AI]      Analyzing diagnostic information...');
    assert.strictEqual(plainLines[5], '[19:25:15] [DEBUG]   Module initialization completed.');
    assert.strictEqual(plainLines[6], '[19:25:16] [SERVER]  [bot-1] <Steve> Hello world!');

    stream.clear();
    rt.logger.info('Line one\nLine two\nLine three', { time: fixedTime });
    const mlPlain = stream.getLines().map(ui.stripAnsi);
    assert.strictEqual(mlPlain.length, 3);
    assert.strictEqual(mlPlain[0].indexOf('Line one'), 21);
    assert.strictEqual(mlPlain[1].indexOf('Line two'), 21, 'Continuation line must align under column 21');
    assert.ok(mlPlain[1].includes('│ Line two'));

    stream.clear();
    const rootCause = new Error('ECONNREFUSED 127.0.0.1:25565 with my-bot-secret-pw');
    const topErr = new Error('Connection failed', { cause: rootCause });
    rt.logger.error('Bot failed', { err: topErr, botId: 'bot-1', time: fixedTime });
    const errOut = ui.stripAnsi(stream.getOutput());
    assert.ok(errOut.includes('Connection failed'));
    assert.ok(errOut.includes('Caused by: Error: ECONNREFUSED 127.0.0.1:25565 with ***'), 'Nested cause must be shown and secrets masked');
    assert.ok(!errOut.includes('my-bot-secret-pw'));
  }

  // ── 2. Redirected / Piped / Plain output: ZERO escape sequences ──
  {
    for (const envCase of [{}, { NO_COLOR: '1' }, { TERM: 'dumb' }]) {
      const pipeStream = makeCaptureStream({ isTTY: false, columns: 80 });
      const rt = ui.createUIRuntime({
        stream: pipeStream,
        env: envCase,
        argv: [],
        registerCleanup: false,
      });
      rt.logger.info('Piped info line');
      rt.logger.error('Piped error line');
      const tracker = rt.createStartupTracker();
      await tracker.runStep('Config', () => 'Loaded 2 bots');
      tracker.print({ readyText: 'Ready in pipe' });

      const rawOut = pipeStream.getOutput();
      assert.ok(!rawOut.includes('\x1b'), `Expected zero ANSI sequences for env=${JSON.stringify(envCase)}, got: ${JSON.stringify(rawOut)}`);
    }
  }

  // ── 3. Tables & Widths (120, 80, 60, 40) in both Unicode and ASCII modes ──
  {
    const sampleCols = [
      { key: 'id', label: 'Bot ID', align: 'left', minWidth: 6, maxWidth: 16, priority: 1 },
      { key: 'status', label: 'Status', align: 'left', minWidth: 8, maxWidth: 14, priority: 1, status: true },
      { key: 'ping', label: 'Ping', align: 'right', minWidth: 4, maxWidth: 8, priority: 2 },
      { key: 'server', label: 'Server', align: 'left', minWidth: 8, maxWidth: 24, priority: 3 },
      { key: 'details', label: 'Details', align: 'left', minWidth: 10, maxWidth: 40, flex: true, priority: 1 },
    ];
    const sampleRows = [
      { id: 'bot-alpha', status: 'ONLINE', ping: '42ms', server: 'java.kingmc.vn:25565', details: 'Selling 12 spawners at /home treolong' },
      { id: 'bot-beta', status: 'RECONNECTING', ping: null, server: 'java.kingmc.vn:25565', details: 'Retry 3/10 after kick ( Tiếng Việt / 中文 )' },
      { id: 'bot-gamma', status: 'DISCONNECTED', ping: null, server: null, details: null },
    ];

    for (const unicode of [true, false]) {
      for (const color of [true, false]) {
        for (const width of [120, 80, 60, 40]) {
          const caps = ui.detectCapabilities({ width, color, unicode, interactive: false, listenResize: false });
          const theme = ui.createTheme(caps);
          const lines = ui.renderTable(sampleCols, sampleRows, { maxWidth: width }, caps, theme);
          assert.ok(lines.length > 0);

          const widths = lines.map(l => ui.visibleWidth(l));
          for (let i = 0; i < lines.length; i++) {
            assert.ok(widths[i] <= width, `Line ${i} width ${widths[i]} exceeds terminal width ${width}: ${ui.stripAnsi(lines[i])}`);
            if (!color) {
              assert.ok(!lines[i].includes('\x1b'), 'Plain mode must contain zero ANSI sequences');
            }
            if (!unicode) {
              assert.ok(!/[╭╮╰╯─│┬┴├┤┼✔✖▲●…]/.test(ui.stripAnsi(lines[i])), `ASCII mode must not contain Unicode box/symbol chars: ${ui.stripAnsi(lines[i])}`);
            }
          }
          if (width >= 60) {
            const firstW = widths[0];
            assert.ok(widths.every(w => w === firstW), `All table rows at width ${width} must have identical visible width (${widths.join(',')})`);
          }
        }
      }
    }
  }

  // ── 4. Startup sequence: OK, WARN, SKIP, and forced FAIL (re-throws original exception + subprocess exit code 1) ──
  {
    const stream = makeCaptureStream({ isTTY: true, columns: 90 });
    const rt = ui.createUIRuntime({ stream, env: { FORCE_COLOR: '1' }, registerCleanup: false });
    const tracker = rt.createStartupTracker();

    await tracker.runStep('Environment', (ctx) => ctx.ok('Node v18.20.4 · linux/x64'));
    await tracker.runStep('Configuration', (ctx) => ctx.warn('1 schema warning', 'Check bots[0].port'));
    await tracker.runStep('Web Dashboard', (ctx) => ctx.skip('Disabled via config'), { required: false });

    let caught = null;
    const customErr = new Error('Simulated fatal module failure');
    customErr.code = 'ESIMFAIL';
    try {
      await tracker.runStep('Core Modules', async () => {
        throw customErr;
      });
    } catch (e) {
      caught = e;
    }
    assert.strictEqual(caught, customErr, 'StartupTracker must re-throw the exact original exception');

    const rendered = tracker.print({ readyText: 'Should not appear on failure' }).map(ui.stripAnsi).join('\n');
    assert.ok(rendered.includes('OK: 1') && rendered.includes('WARN: 1') && rendered.includes('SKIP: 1') && rendered.includes('FAIL: 1'), rendered);
    assert.ok(rendered.includes('Simulated fatal module failure'), rendered);
    assert.ok(!rendered.includes('Should not appear on failure'), 'Ready line must NOT be shown when a required step failed');

    const proc = spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js'), '--plain'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 10000,
    });
    assert.strictEqual(proc.status, 1, 'main.js must exit with code 1 when required dependency express/socket.io is missing');
    const combinedOut = (proc.stdout || '') + (proc.stderr || '');
    assert.ok(!combinedOut.includes('\x1b'), 'Plain/non-TTY subprocess output must contain zero escape sequences');
    assert.ok(combinedOut.includes('express/socket.io required'), combinedOut);
    assert.ok(combinedOut.includes('FAIL: 1'), combinedOut);
  }

  // ── 5. Dashboard Rebuild: parity checklist, live updates, resize, and all width tiers (120, 80, 60, 40, 36) ──
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-ui-dash-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      host: 'java.kingmc.vn',
      port: 25565,
      version: '1.21.11',
      webhookUrl: 'https://discord.com/api/webhooks/123456789/secretWebhookToken9876',
      schedule: { enabled: true, outTime: '23:00', inTime: '06:00' },
      bots: [
        {
          id: 'bot-1',
          username: 'MinerOne',
          host: 'java.kingmc.vn',
          port: 25565,
          botPassword: 'secretBotPassword123',
          spawnerProtectOn: true,
          protectedSpawners: [{ x: 100, y: 64, z: -200 }, { x: 102, y: 64, z: -200 }],
          autoSellSpawnOn: true,
          autoSellSpawnList: [{ x: 100, y: 64, z: -200 }],
          moneyGoal: 5000000,
          moneyGoalMacro: 'mualong',
        },
        {
          id: 'bot-2',
          username: 'MinerTwo',
          host: 'java.kingmc.vn',
          port: 25565,
        },
      ],
    }));

    const mgr = new BotManager({ configPath: path.join(dir, 'config.json') });
    await mgr.init();

    const b1 = mgr.findBot('bot-1');
    b1.state.connState = 'ONLINE';
    b1.state.ping = 38;
    b1.state.money = 1250000;
    b1.state.shard = 450;
    b1.state.position = { x: 100.4, y: 64, z: -199.8 };
    b1.state.afk = 'jump';
    b1._featuresActive = true;
    b1.state.inventory = [{ slot: 0, name: 'diamond_pickaxe', count: 1 }, { slot: 1, name: 'cobblestone', count: 64 }];
    mgr.revenue.record('bot-1', 500000, { intervalMs: 300000 });
    mgr.revenue.record('bot-1', 750000, { intervalMs: 300000 });

    const b2 = mgr.findBot('bot-2');
    b2.state.connState = 'RECONNECTING';
    b2.state.reconnects = 3;
    b2._sellRecovering = true;
    b2._sellHomeTries = 2;
    b2.log('warn', 'Bị kick khi đang bán — thử lại /home treolong 2/10');

    const stream = makeCaptureStream({ isTTY: true, columns: 120, rows: 40 });
    const rt = ui.createUIRuntime({ stream, env: { FORCE_COLOR: '1' }, registerCleanup: false });
    const chatFilter = new ChatFilter({ enabled: true, mode: 'smart' });
    const dashCtrl = rt.createDashboardController(mgr, { chatFilter });

    for (const width of [120, 80, 60, 40, 36]) {
      stream.columns = width;
      rt.caps.refresh();
      const lines = dashCtrl.renderSnapshot({ width });
      assert.ok(lines.length > 0);
      for (const l of lines) {
        const w = ui.visibleWidth(l);
        assert.ok(w <= width, `Dashboard line width ${w} exceeds tier width ${width}: ${ui.stripAnsi(l)}`);
      }

      if (width === 120) {
        const fullText = lines.map(ui.stripAnsi).join('\n');
        assert.ok(fullText.includes('Antertool Premium v2'), 'Header name');
        assert.ok(fullText.includes('bot-1') && fullText.includes('MinerOne'), 'Bot 1 row');
        assert.ok(fullText.includes('bot-2'), 'Bot 2 row');
        assert.ok(fullText.includes('HOME (/home treolong)'), 'Home status');
        assert.ok(fullText.includes('Spawner Protect') && fullText.includes('2 spawners'), 'Spawner Protect module');
        assert.ok(fullText.includes('Auto-Sell Spawn') && fullText.includes('Retry 2/10'), 'Auto-Sell Spawn & retry counter');
        assert.ok(fullText.includes('Reconnect Guard') && fullText.includes('3/10'), 'Reconnect retry counter');
        assert.ok(fullText.includes('Discord Webhook') && fullText.includes('****9876'), 'Masked webhook status');
        assert.ok(!fullText.includes('secretWebhookToken9876'), 'Raw webhook secret must never leak');
        assert.ok(!fullText.includes('secretBotPassword123'), 'Raw bot password must never leak');
        assert.ok(fullText.includes('Tasks & Progress') && fullText.includes('2/36 slots'), 'Tasks & Progress bar');
        assert.ok(fullText.includes('Revenue') && fullText.includes('$1.25M') && fullText.includes('2 cycles'), 'Revenue statistics');
        assert.ok(fullText.includes('Recent Warnings & Errors') && fullText.includes('Bị kick khi đang bán'), 'Recent warnings/errors buffer');
        assert.ok(fullText.includes('Controls:'), 'Footer controls');
      }
      if (width === 36) {
        assert.strictEqual(lines.length, 1, 'Under 40 cols must render a single-line status summary');
      }
    }

    stream.columns = 100;
    rt.caps.refresh();
    dashCtrl.startLive();
    assert.strictEqual(dashCtrl.isActive, true);
    assert.strictEqual(rt.writer._cursorHidden, true, 'Cursor must be hidden while live dashboard is active');
    stream.columns = 70;
    rt.caps.refresh();
    dashCtrl.stopLive();
    assert.strictEqual(dashCtrl.isActive, false);
    assert.strictEqual(rt.writer._cursorHidden, false, 'Cursor must be restored when live dashboard stops');

    const botListLines = ui.renderBotListView(mgr.bots, rt.caps, rt.theme);
    assert.ok(botListLines.map(ui.stripAnsi).join('\n').includes('bot-1'));
    const sysLines = ui.renderSysInfoView(mgr.getSystemMetrics(), mgr.getBotCapacity(), rt.caps, rt.theme);
    assert.ok(sysLines.map(ui.stripAnsi).join('\n').includes('Memory'));
    mgr.proxyManager.add('socks5://1.2.3.4:1080', 'VN-1');
    const proxyLines = ui.renderProxyListView(mgr.proxyManager.getSummaries(), rt.caps, rt.theme);
    assert.ok(proxyLines.map(ui.stripAnsi).join('\n').includes('1.2.3.4:1080'));
    const helpLines = ui.renderHelpView(HelpCatalog.buildHelp({ scope: 'console', query: '' }), rt.caps, rt.theme);
    assert.ok(helpLines.map(ui.stripAnsi).join('\n').includes('help spawn'));

    mgr.shutdown();
    mgr.fileLogs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('ui-overhaul.test OK');
  process.exit(0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
