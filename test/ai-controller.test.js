'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const AiController = require('../src/core/AiController');
const TelegramControl = require('../src/core/TelegramControl');
const TelegramLogger = require('../src/core/TelegramLogger');
const DiscordTheme = require('../src/core/DiscordTheme');
const { redactSecretsInText } = require('../src/ui/text');
const { validateConfig } = require('../src/core/ConfigValidator');

function createMockFleet() {
  const makeBot = (id, username) => {
    const cmds = [];
    let started = false;
    let stopped = false;
    let reconnected = false;
    return {
      cfg: { id, username },
      state: { connState: 'DISCONNECTED', reconnects: 0, money: 1000, shard: 5 },
      isConnected: false,
      isReconnecting: false,
      isOnline: false,
      _disabled: true,
      get started() { return started; },
      get stopped() { return stopped; },
      get reconnected() { return reconnected; },
      get cmds() { return cmds; },
      start() {
        started = true;
        this.isConnected = true;
        this.isOnline = true;
        this.state.connState = 'ONLINE';
      },
      shutdown() {
        stopped = true;
        this.isConnected = false;
        this.isOnline = false;
        this.state.connState = 'DISCONNECTED';
      },
      forceReconnect() {
        reconnected = true;
      },
      cmd(c) {
        cmds.push(c);
      },
    };
  };

  const bots = [
    makeBot('bot-1', 'Anter01'),
    makeBot('bot-2', 'Anter02'),
    makeBot('bot-3', 'Anter03'),
  ];

  const logs = [];
  const mgr = {
    bots,
    _config: {
      telegramAdmins: ['1001'],
      telegramControlEnabled: true,
    },
    runtimeLog(level, msg) {
      logs.push({ level, msg });
    },
    askAi(prompt, opts) {
      return this.ai.ask(prompt, opts);
    },
  };
  mgr.ai = new AiController(mgr);
  return { mgr, bots, logs };
}

test('AiController: xử lý câu lệnh mẫu "Dev: khởi động 2 bot số 1 và 2"', async () => {
  const { mgr, bots } = createMockFleet();
  const res = await mgr.askAi('Dev: khởi động 2 bot số 1 và 2');

  assert.equal(res.ok, true);
  assert.equal(bots[0].started, true, 'bot số 1 phải được khởi động');
  assert.equal(bots[1].started, true, 'bot số 2 phải được khởi động');
  assert.equal(bots[2].started, false, 'bot số 3 không được khởi động');
  assert.match(res.reply, /^AI-Anter:\s*Đã nhận đang làm/i);
  assert.match(res.reply, /bot-1 \(#1\)/);
  assert.match(res.reply, /bot-2 \(#2\)/);
});

test('AiController: hỗ trợ các lệnh tự nhiên bật bán lồng, bảo vệ lồng, về home, macro và dừng bot', async () => {
  const { mgr, bots } = createMockFleet();

  const rSell = await mgr.askAi('bật bán lồng cho tất cả bot');
  assert.equal(rSell.ok, true);
  for (const b of bots) {
    assert.ok(b.cmds.includes('autosell_spawn on'));
  }

  const rProtect = await mgr.askAi('bật protect cho bot số 1 và 3');
  assert.equal(rProtect.ok, true);
  assert.ok(bots[0].cmds.includes('spawnerprotect on'));
  assert.ok(!bots[1].cmds.includes('spawnerprotect on'));
  assert.ok(bots[2].cmds.includes('spawnerprotect on'));

  const rHome = await mgr.askAi('cho bot 2 về home');
  assert.equal(rHome.ok, true);
  assert.ok(bots[1].cmds.includes('spawnhome now'));

  const rMacro = await mgr.askAi('chạy macro mualong trên bot số 1');
  assert.equal(rMacro.ok, true);
  assert.ok(bots[0].cmds.includes('macro mualong'));

  const rStop = await mgr.askAi('dừng bot số 2');
  assert.equal(rStop.ok, true);
  assert.equal(bots[1].stopped, true);
});

test('AiController: gọi OmniRouter /v1/chat/completions với Bearer API key và thực thi JSON actions trả về', async () => {
  const { mgr, bots } = createMockFleet();
  let capturedAuth = '';
  let capturedBody = null;

  const server = http.createServer((req, res) => {
    capturedAuth = req.headers.authorization || '';
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: 'AI-Anter: Đã nhận đang làm — khởi động ngay 2 bot số 1 và 2 cho Dev!',
                actions: [
                  { type: 'start', targets: ['1', '2'] },
                ],
              }),
            },
          },
        ],
      }));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    mgr.ai.configure({
      apiKey: 'sk-omnirouter-test-secret-9999',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'gpt-4o-mini',
    });

    const res = await mgr.askAi('Dev: khởi động 2 bot số 1 và 2');
    assert.equal(res.ok, true);
    assert.equal(res.via, 'omnirouter');
    assert.equal(capturedAuth, 'Bearer sk-omnirouter-test-secret-9999');
    assert.equal(capturedBody.model, 'gpt-4o-mini');
    assert.equal(bots[0].started, true);
    assert.equal(bots[1].started, true);
    assert.equal(bots[2].started, false);
    assert.match(res.reply, /^AI-Anter: Đã nhận đang làm/);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('AiController: chặn lệnh nhạy cảm (/login, /pay, /changepassword) và che khoá omniRouterApiKey', () => {
  const { mgr, bots } = createMockFleet();
  const res = mgr.ai.executeActions([
    { type: 'cmd', targets: ['1'], arg: '/login secretpass' },
    { type: 'cmd', targets: ['1'], arg: '/pay Steve 999999' },
  ]);
  assert.equal(res[0].ok, false);
  assert.equal(res[1].ok, false);
  assert.equal(bots[0].cmds.length, 0);

  const sampleJson = '{"omniRouterApiKey": "sk-omni-secret-1234567890"}';
  assert.ok(!TelegramLogger.redactStatic(sampleJson).includes('sk-omni-secret-1234567890'));
  assert.ok(!DiscordTheme.redactSecrets(sampleJson).includes('sk-omni-secret-1234567890'));
  assert.ok(!redactSecretsInText(sampleJson).includes('sk-omni-secret-1234567890'));
  assert.ok(!redactSecretsInText('Authorization: Bearer sk-omni-secret-1234567890').includes('sk-omni-secret-1234567890'));

  const vOk = validateConfig({
    omniRouterApiKey: 'sk-omni-key',
    omniRouterBaseUrl: 'https://omnirouter.li/v1',
    omniRouterModel: 'gpt-4o-mini',
    bots: [{ id: 'bot-1' }],
  });
  assert.equal(vOk.ok, true);
});

test('TelegramControl: lệnh /ai cho phép admin điều khiển bot qua AI-Anter', async () => {
  const { mgr, bots } = createMockFleet();
  const tc = new TelegramControl(mgr);
  const res = await tc.handleEvent({
    type: 'command',
    cmd: 'ai',
    arg: 'khởi động 2 bot số 1 và 2',
    fromId: '1001',
    chatId: '-100123',
    isPrivate: true,
  });
  assert.equal(res.code, 'OK');
  assert.equal(bots[0].started, true);
  assert.equal(bots[1].started, true);
  assert.equal(bots[2].started, false);
  assert.match(res.text, /AI-Anter:\s*Đã nhận đang làm/);
});
