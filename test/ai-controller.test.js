'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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

    const res = await mgr.askAi('Dev: sao 2 bot số 1 và 2 chưa vào được vậy, khởi động giùm đi?');
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

test('AiController: chặn lệnh nhạy cảm (/login, /pay, /changepassword) và che khoá omniRouterApiKey', async () => {
  const { mgr, bots } = createMockFleet();
  const res = await mgr.ai.executeActions([
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

test('AiController: hỗ trợ các hành động inv, pos, activity, ping', async () => {
  const { mgr, bots } = createMockFleet();
  bots[0].isOnline = true;
  bots[0].state.inventory = [{ name: 'Diamond', count: 5 }, { name: 'Iron Ingot', count: 64 }];
  bots[0].mc = {
    entity: { position: { x: 100.5, y: 64, z: -200.2 } },
    game: { dimension: 'overworld' },
    player: { ping: 45 },
  };

  const rInv = await mgr.askAi('xem túi đồ bot 1');
  assert.equal(rInv.ok, true);
  assert.ok(rInv.reply.includes('Diamond x5'));

  const rPos = await mgr.askAi('tọa độ bot 1');
  assert.equal(rPos.ok, true);
  assert.ok(rPos.reply.includes('101') || rPos.reply.includes('100'));

  const rPing = await mgr.askAi('ping bot 1');
  assert.equal(rPing.ok, true);
  assert.ok(rPing.reply.includes('45ms'));
});

test('AiController & TelegramControl: nhận diện và thực thi checkstats và bal của người chơi', async () => {
  const { mgr, bots } = createMockFleet();
  bots[0].isOnline = true;
  bots[0].mc = { player: { ping: 30 } };
  bots[0].checkStats = async (player, timeout) => {
    return {
      player,
      title: 'KingMC Stats',
      items: [
        { labelVi: 'Giết người chơi', value: '25' },
        { labelVi: 'Số lần chết', value: '4' },
        { labelVi: 'Thời gian đã chơi', value: '12h 45m' },
        { labelVi: 'Shards', value: '350' },
        { labelVi: 'Tiền', value: '$2,500,000' },
      ],
      lines: [
        'Giết người chơi | 25',
        'Số lần chết | 4',
        'Thời gian đã chơi | 12h 45m',
        'Shards | 350',
        'Tiền | $2,500,000',
      ],
    };
  };
  bots[0].checkBal = async (player, timeout) => {
    return {
      player,
      balance: '$2,500,000',
      amount: 2500000,
      raw: `Số dư của ${player}: $2,500,000`,
    };
  };

  // 1. AI: Nhận diện "check stats <player>"
  const rStats1 = await mgr.askAi('check stats Steve');
  assert.equal(rStats1.ok, true);
  assert.equal(rStats1.actions[0].type, 'checkstats');
  assert.equal(rStats1.actions[0].arg, 'Steve');
  assert.ok(rStats1.reply.includes('Steve'));
  assert.ok(rStats1.reply.includes('25'));

  // 2. AI: Nhận diện "xem stats của <player>"
  const rStats2 = await mgr.askAi('xem stats của Alex');
  assert.equal(rStats2.ok, true);
  assert.equal(rStats2.actions[0].type, 'checkstats');
  assert.equal(rStats2.actions[0].arg, 'Alex');

  // 3. AI: Nhận diện "chỉ số của <player>", "thống kê <player>", "stats player <player>"
  const rStats3 = await mgr.askAi('chỉ số của Steve');
  assert.equal(rStats3.ok, true);
  assert.equal(rStats3.actions[0].type, 'checkstats');

  const rStats4 = await mgr.askAi('thống kê Steve');
  assert.equal(rStats4.ok, true);
  assert.equal(rStats4.actions[0].type, 'checkstats');

  const rStats5 = await mgr.askAi('stats player Steve');
  assert.equal(rStats5.ok, true);
  assert.equal(rStats5.actions[0].type, 'checkstats');

  // 4. AI: Nhận diện "check bal <player>"
  const rBal1 = await mgr.askAi('check bal Steve');
  assert.equal(rBal1.ok, true);
  assert.equal(rBal1.actions[0].type, 'bal');
  assert.equal(rBal1.actions[0].arg, 'Steve');
  assert.ok(rBal1.reply.includes('$2,500,000'));

  // 5. AI: Nhận diện "số dư của <player>", "xem tiền của <player>", "bal <player>", "<player> có bao nhiêu tiền", "tiền của <player>"
  const rBal2 = await mgr.askAi('số dư của Alex');
  assert.equal(rBal2.ok, true);
  assert.equal(rBal2.actions[0].type, 'bal');
  assert.equal(rBal2.actions[0].arg, 'Alex');

  const rBal3 = await mgr.askAi('xem tiền của Steve');
  assert.equal(rBal3.ok, true);
  assert.equal(rBal3.actions[0].type, 'bal');

  const rBal4 = await mgr.askAi('bal Steve');
  assert.equal(rBal4.ok, true);
  assert.equal(rBal4.actions[0].type, 'bal');

  const rBal5 = await mgr.askAi('Steve có bao nhiêu tiền');
  assert.equal(rBal5.ok, true);
  assert.equal(rBal5.actions[0].type, 'bal');
  assert.equal(rBal5.actions[0].arg, 'Steve');

  const rBal6 = await mgr.askAi('tiền của Steve');
  assert.equal(rBal6.ok, true);
  assert.equal(rBal6.actions[0].type, 'bal');

  // 6. Trường hợp không có bot nào online
  bots[0].isOnline = false;
  const rFail = await mgr.askAi('check stats Steve');
  assert.equal(rFail.ok, false);
  assert.ok(rFail.reply.includes('online'));

  // 7. TelegramControl: lệnh /checkstats <player> và /bal <player>
  bots[0].isOnline = true;
  const tc = new TelegramControl(mgr);
  const tgStats = await tc.handleEvent({
    type: 'command',
    cmd: 'checkstats',
    arg: 'Steve',
    fromId: '1001',
    chatId: '-100123',
    isPrivate: true,
  });
  assert.equal(tgStats.code, 'OK');
  assert.ok(tgStats.text.includes('Steve'));
  assert.ok(tgStats.text.includes('Giết người chơi'));

  const tgBal = await tc.handleEvent({
    type: 'command',
    cmd: 'bal',
    arg: 'Steve',
    fromId: '1001',
    chatId: '-100123',
    isPrivate: true,
  });
  assert.equal(tgBal.code, 'OK');
  assert.ok(tgBal.text.includes('Steve'));
  assert.ok(tgBal.text.includes('$2,500,000'));
});

test('AiController: nhớ ngữ cảnh hội thoại, đại từ "nó/con đó", tiếp nối "còn bot 2?", và lưu vào disk file', async () => {
  const tmpFile = path.join(os.tmpdir(), `ai_mem_test_${Date.now()}.json`);
  try {
    const { mgr, bots } = createMockFleet();
    bots[0].isOnline = true;
    bots[1].isOnline = true;
    bots[0].state.inventory = [{ name: 'Emerald', count: 10 }];
    bots[1].state.inventory = [{ name: 'Gold Ingot', count: 32 }];
    bots[0].mc = { entity: { position: { x: 50, y: 70, z: -80 } } };
    bots[1].mc = { entity: { position: { x: 120, y: 65, z: 240 } } };

    const ai = new AiController(mgr, { historyFile: tmpFile });
    mgr.askAi = (prompt, opts) => ai.ask(prompt, opts);

    // Lượt 1: Hỏi túi đồ bot 1
    const t1 = await mgr.askAi('xem túi đồ bot 1');
    assert.equal(t1.ok, true);
    assert.ok(t1.reply.includes('Emerald x10'));

    // Lượt 2: Dùng đại từ "nó" -> phải nhớ bot 1
    const t2 = await mgr.askAi('nó đang ở đâu?');
    assert.equal(t2.ok, true);
    assert.equal(t2.actions[0].type, 'pos');
    assert.deepEqual(t2.actions[0].targets, ['bot-1']);
    assert.ok(t2.reply.includes('50') && t2.reply.includes('70') && t2.reply.includes('-80'));

    // Lượt 3: Ra lệnh "cho nó về home" -> nhớ bot 1
    const t3 = await mgr.askAi('cho nó về home');
    assert.equal(t3.ok, true);
    assert.equal(t3.actions[0].type, 'home');
    assert.deepEqual(t3.actions[0].targets, ['bot-1']);
    assert.equal(bots[0].cmds.includes('spawnhome now'), true);

    // Lượt 4: Câu hỏi tiếp nối "còn bot 2?" -> kế thừa hành động "home" cho bot 2
    const t4 = await mgr.askAi('còn bot 2?');
    assert.equal(t4.ok, true);
    assert.equal(t4.actions[0].type, 'home');
    assert.deepEqual(t4.actions[0].targets, ['bot-2']);
    assert.equal(bots[1].cmds.includes('spawnhome now'), true);

    // Lượt 5: Lưu disk và nạp lại vào instance mới
    ai.flushHistoryToDisk();
    assert.equal(fs.existsSync(tmpFile), true);

    const ai2 = new AiController(mgr, { historyFile: tmpFile });
    // Instance mới vẫn nhớ lượt vừa rồi tác động lên bot 2
    const t5 = await ai2.ask('nó đang ở đâu?');
    assert.equal(t5.ok, true);
    assert.equal(t5.actions[0].type, 'pos');
    assert.deepEqual(t5.actions[0].targets, ['bot-2']);
    assert.ok(t5.reply.includes('120') && t5.reply.includes('65') && t5.reply.includes('240'));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('AiController: ghi nhớ tên người dùng (user memory) và tiếp tục duy trì qua instance mới', async () => {
  const tmpFile = path.join(os.tmpdir(), `ai_user_mem_${Date.now()}.json`);
  try {
    const { mgr } = createMockFleet();
    const ai = new AiController(mgr, { historyFile: tmpFile });

    // 1. Người dùng giới thiệu tên
    const r1 = await ai.ask('mình tên là Tuấn');
    assert.equal(r1.ok, true);
    assert.ok(r1.reply.includes('Tuấn'));

    // 2. Hỏi lại tên
    const r2 = await ai.ask('tôi tên là gì?');
    assert.equal(r2.ok, true);
    assert.ok(r2.reply.includes('Tuấn'));

    // 3. Khởi tạo instance AI mới nạp cùng file
    ai.flushHistoryToDisk();
    const ai2 = new AiController(mgr, { historyFile: tmpFile });
    const r3 = await ai2.ask('bạn có nhớ tôi là ai không?');
    assert.equal(r3.ok, true);
    assert.ok(r3.reply.includes('Tuấn'));
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('AiController: gửi đầy đủ lịch sử hội thoại nhiều lượt cho OmniRouter LLM và Narration', async () => {
  const { mgr, bots } = createMockFleet();
  bots[0].isOnline = true;
  bots[0].state.inventory = [{ name: 'Diamond', count: 3 }];

  const recordedCalls = [];
  const fakeHttpPost = async (url, headers, body) => {
    recordedCalls.push({ url, headers, body });
    if (body.response_format?.type === 'json_object') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({
                reply: '',
                actions: [{ type: 'inv', targets: ['1'] }],
                clarify: '',
              }),
            },
          }],
        }),
      };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        choices: [{
          message: {
            content: 'Bot 1 hiện có 3 kim cương trong túi đồ.',
          },
        }],
      }),
    };
  };

  const ai = new AiController(mgr, {
    apiKey: 'sk-test-token-12345',
    httpPost: fakeHttpPost,
    historyFile: null,
  });

  // Lượt 1
  await ai.ask('cho mình xem túi đồ bot 1 với');
  // Lượt 2
  await ai.ask('nó có nhiều đồ không?');

  assert.ok(recordedCalls.length >= 2);
  const planCall = recordedCalls.find(c => c.body?.response_format?.type === 'json_object');
  assert.ok(planCall, 'Phải có cuộc gọi plan với LLM');
  const msgs = planCall.body.messages;
  assert.ok(msgs.some(m => m.role === 'user' && m.content.includes('túi đồ bot 1')));
  assert.ok(msgs.some(m => m.role === 'user' && m.content.includes('nó có nhiều đồ không')));

  const narrateCall = recordedCalls.find(c => !c.body?.response_format);
  assert.ok(narrateCall, 'Phải có cuộc gọi narrate với LLM');
  const narrateMsgs = narrateCall.body.messages;
  assert.ok(narrateMsgs.some(m => m.role === 'user' && m.content.includes('túi đồ bot 1')));
});

test('TelegramControl & AiController: hội thoại nhiều lượt qua Telegram giữ trọn ngữ cảnh', async () => {
  const { mgr, bots } = createMockFleet();
  bots[0].isOnline = true;
  bots[1].isOnline = true;
  bots[0].state.inventory = [{ name: 'Diamond', count: 5 }];
  bots[0].mc = { entity: { position: { x: 10, y: 20, z: 30 } } };
  bots[1].mc = { entity: { position: { x: 40, y: 50, z: 60 } } };

  const tc = new TelegramControl(mgr);
  const ev = (text) => ({
    type: 'command',
    cmd: 'ai',
    arg: text,
    fromId: '1001',
    chatId: '-100123',
    isPrivate: true,
  });

  // Lượt 1: Xem túi đồ bot 1 qua Telegram
  const r1 = await tc.handleEvent(ev('xem túi đồ bot 1'));
  assert.equal(r1.code, 'OK');
  assert.ok(r1.text.includes('Diamond x5'));

  // Lượt 2: Hỏi vị trí của "nó" qua Telegram -> nhận diện đúng bot 1
  const r2 = await tc.handleEvent(ev('nó đang ở đâu?'));
  assert.equal(r2.code, 'OK');
  assert.ok(r2.text.includes('bot-1'));
  assert.ok(r2.text.includes('10') && r2.text.includes('20') && r2.text.includes('30'));

  // Lượt 3: Tiếp nối "còn bot 2?" qua Telegram -> xem vị trí bot 2
  const r3 = await tc.handleEvent(ev('còn bot 2?'));
  assert.equal(r3.code, 'OK');
  assert.ok(r3.text.includes('bot-2'));
  assert.ok(r3.text.includes('40') && r3.text.includes('50') && r3.text.includes('60'));
});
