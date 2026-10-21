'use strict';
// Kiểm tra mô hình hoạt động (BotActivity.js), bảng (TelegramPanel.js) và golden snapshots (Section 13 mục 1, 2, 11).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BotActivity = require('../src/core/BotActivity');
const P = require('../src/core/TelegramPanel');
const { sym, setSymbolSet } = require('../src/core/Symbols');

function makeFakeSession(overrides = {}) {
  const s = {
    cfg: { id: 'bot-1', username: 'Steve' },
    state: { connState: 'ONLINE', reconnects: 0, ping: 42, position: { x: 120, y: 64, z: -48 } },
    isOnline: true,
    _disabled: false,
    _sellSpawnOn: true,
    _sellSpawnBusy: false,
    _sellRecovering: false,
    _spawnerBusy: false,
    _posLost: false,
    _sellSpawnIntervalMs: () => 300000,
    scriptRunner: { running: false, currentMacro: null, _currentStep: 0, _totalSteps: 0 },
    autoLogin: { inFlow: false, state: 'IDLE', o: { loginCommand: '/login' } },
    autoOrder: { active: false, item: 'iron_ingot', state: 'đang chạy' },
    reconnectHandler: { attempt: 0, maxRetries: 5, nextAttemptAt: 0, lastError: '' },
    emit() {},
    ...overrides,
  };
  BotActivity.initSessionActivity(s);
  return s;
}

(async () => {
  setSymbolSet('unicode');
  const now = 1700000000000;

  // ---------- 1) describeActivity: thứ tự ưu tiên, mâu thuẫn cờ, độ trễ treo (stale), hoạt động chồng nhau, snapshot ----------
  // 1. disabled (_disabled: true với connState DISCONNECTED)
  let s = makeFakeSession({ _disabled: true, isOnline: false, state: { connState: 'DISCONNECTED' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đã dừng');
  s = makeFakeSession({ _disabled: true, _scheduledOut: true, isOnline: false, state: { connState: 'DISCONNECTED' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đang nghỉ theo lịch');

  // 2. STOPPING / DISCONNECTED
  s = makeFakeSession({ isOnline: false, state: { connState: 'STOPPING' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đang dừng bot');
  s = makeFakeSession({ isOnline: false, state: { connState: 'DISCONNECTED' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Mất kết nối');

  // 3. RECONNECTING (kèm lần thử k/max và thời gian chờ)
  s = makeFakeSession({
    isOnline: false,
    state: { connState: 'RECONNECTING', reconnects: 2 },
    reconnectHandler: { attempt: 2, maxRetries: 5, nextAttemptAt: now + 15000 },
  });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Kết nối lại lần 2/5, chờ 15s');

  // 4. CONNECTING / AUTHENTICATING / SPAWNING
  s = makeFakeSession({ isOnline: false, state: { connState: 'CONNECTING' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đang kết nối tới server');
  s = makeFakeSession({ isOnline: false, state: { connState: 'AUTHENTICATING' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đăng nhập: xác thực tài khoản');
  s = makeFakeSession({ isOnline: false, state: { connState: 'SPAWNING' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đang tải thế giới (spawn)');

  // 5. login / antibot / menu đang chạy
  s = makeFakeSession({ autoLogin: { inFlow: true, state: 'WAITING_LOGIN_SUCCESS', o: { loginCommand: '/login' } } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đăng nhập: gõ /login');

  // 6. spawner protection handling (_spawnerBusy)
  s = makeFakeSession({ _spawnerBusy: true, protectedSpawners: [{}, {}, {}] });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Xử lý mối đe dọa: đào lồng (3 lồng)');

  // 7. macro running (scriptRunner.running)
  s = makeFakeSession({ scriptRunner: { running: true, currentMacro: 'afk', _currentStep: 3, _totalSteps: 8 } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Chạy macro "afk" bước 3/8');

  // 8. sell cycle running (_sellSpawnBusy)
  s = makeFakeSession({ _sellSpawnBusy: true, sellSpawnList: [{}, {}, {}, {}, {}], _sellCurrentIdx: 2, _sellCycleCount: 128 });
  const sellDerived = BotActivity.describeActivity(s, now);
  assert.strictEqual(sellDerived.text, 'Bán lồng 3/5 (vòng #128)');
  assert.deepStrictEqual(sellDerived.progress, { done: 3, total: 5 });

  // 9. /home treolong recovery (_sellRecovering)
  s = makeFakeSession({ _sellRecovering: true, _sellRecoveryAttempt: 2, sellFailMaxHome: 10, spawnHomeCommand: '/home treolong' });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Gõ /home treolong phục hồi bán (lần 2/10)');

  // 10. position lost (_posLost)
  s = makeFakeSession({ _posLost: true, spawnHomeCommand: '/home treolong' });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Lệch vị trí treo lồng (chờ gõ /home treolong)');

  // 11. AutoOrder
  s = makeFakeSession({ autoOrder: { active: true, item: 'iron_ingot', state: 'đang giao' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'AutoOrder iron_ingot: đang giao');

  // 12. AFK / shard
  s = makeFakeSession({ state: { connState: 'ONLINE', afk: 'jump' } });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Treo AFK nhảy');

  // 13. Idle, chờ vòng bán tiếp theo (countdown)
  s = makeFakeSession({ _sellSpawnOn: true, _nextSellAt: now + 160000 });
  assert.strictEqual(BotActivity.describeActivity(s, now).text, 'Đứng canh lồng, chờ vòng bán kế tiếp (còn 02:40)');

  // Cờ mâu thuẫn (vd: DISCONNECTED nhưng _sellSpawnBusy = true, hoặc _disabled nhưng ONLINE) -> trả về "Không xác định", không bao giờ đoán "rảnh"
  s = makeFakeSession({ state: { connState: 'DISCONNECTED' }, _sellSpawnBusy: true });
  const contrad = BotActivity.describeActivity(s, now);
  assert.strictEqual(contrad.kind, 'unknown');
  assert.strictEqual(contrad.text, 'Không xác định');

  // Hoạt động chồng nhau (overlapping activities): kết thúc 1 kind không xoá kind khác; ưu tiên cao hơn thắng
  s = makeFakeSession();
  BotActivity.setActivity(s, 'macro', 'Chạy macro "afk" bước 2/5', { now: now - 5000 });
  BotActivity.setActivity(s, 'protect', 'Xử lý mối đe dọa: đào lồng 3', { now: now - 2000 });
  assert.strictEqual(BotActivity.describeActivity(s, now).kind, 'protect', 'protect có ưu tiên cao hơn macro');
  BotActivity.endActivity(s, 'protect', 'Đã bảo vệ xong lồng 3', { level: 'ok', now });
  assert.strictEqual(BotActivity.describeActivity(s, now).kind, 'macro', 'kết thúc protect vẫn giữ nguyên macro');
  assert.strictEqual(s.history.length, 1);
  assert.ok(s.history.toArray()[0].text.includes('Đã bảo vệ xong lồng 3'));

  // Cập nhật tiến độ không giữ lại lịch sử thừa và giữ nguyên mốc since trừ khi restart: true
  const sProg = makeFakeSession();
  BotActivity.setActivity(sProg, 'sell', 'Bán lồng 1/5 (vòng #10)', { progress: { done: 1, total: 5 }, now: now - 10000 });
  const since0 = sProg.activities.get('sell').since;
  BotActivity.setActivity(sProg, 'sell', 'Bán lồng 2/5 (vòng #10)', { progress: { done: 2, total: 5 }, now: now - 5000 });
  assert.strictEqual(sProg.activities.get('sell').since, since0, 'cập nhật tiến độ giữ nguyên since');
  assert.strictEqual(sProg.history.length, 0, 'cập nhật tiến độ không ghi vào lịch sử');

  // Kiểm tra phát hiện treo (staleAfterMs: sell cycle 10m)
  const staleAct = BotActivity.describeActivity(sProg, since0 + 11 * 60000);
  assert.strictEqual(staleAct.stale, true);

  // clearActivities khi mất kết nối: chụp lại activitySnapshot trong 60s
  BotActivity.clearActivities(sProg, 'Mất kết nối', now);
  assert.strictEqual(sProg.activities.size, 0);
  const snap = BotActivity.getActivitySnapshot(sProg, now + 30000);
  assert.ok(snap && snap.text.includes('Bán lồng 2/5 (vòng #10)'), 'giữ snapshot trong 60s sau khi mất kết nối');
  assert.strictEqual(BotActivity.getActivitySnapshot(sProg, now + 61000), null, 'quá 60s thì xoá snapshot');

  // ---------- 2) buildPanel: giới hạn 4096 ký tự, các nút theo trạng thái, mã định danh ổn định ----------
  const sPanel = makeFakeSession();
  BotActivity.setActivity(sPanel, 'sell', 'Bán lồng 3/5 (vòng #128)', {
    progress: { done: 3, total: 5 },
    now: now - 14000,
  });
  BotActivity.pushHistory(sPanel, '/home treolong (lệch vị trí) → đã về', 'warn', now - 175000);
  BotActivity.pushHistory(sPanel, 'Lồng 4/5 OK', 'ok', now - 7000);
  BotActivity.pushHistory(sPanel, 'Bán xong 5/5 lồng +250K', 'ok', now - 3000);

  const infoBase = {
    botId: 'bot-1',
    allBotIds: ['bot-1', 'bot-2'],
    account: 'Steve',
    connState: 'ONLINE',
    sellOn: true,
    sellBusy: true,
    intervalMs: 300000,
    now,
    tz: 'Asia/Ho_Chi_Minh',
    stats: {
      total: 12400000,
      last1h: 250000,
      avgPerHour: 45833.33,
      perDayEst: 1100000,
      observedMs: 7200000,
      lastAt: now - 12000,
      lastAmount: 250000,
    },
    totalUptimeMs: 3 * 3600000 + 12 * 60000,
    sessionMs: 3 * 3600000 + 12 * 60000,
    session: sPanel,
    nextSellAt: now + 160000,
    protect: { on: true, level: 2, name: 'Cân bằng', threats: 0, lastScanAt: now - 3000 },
    pos: { x: 120, y: 64, z: -48 },
    ping: 42,
    proxy: true,
    proxyStatus: 'có',
  };

  const renderedPanel = P.buildPanel(infoBase);
  assert.ok(renderedPanel.text.includes('Đang làm: Bán lồng 3/5 (vòng #128) ▰▰▰▱▱ · 14s'));
  assert.ok(renderedPanel.text.includes('Kế tiếp: vòng bán sau 02:40'));
  assert.ok(renderedPanel.text.includes('Protect: mức 2 Cân bằng · 0 mối đe dọa · quét 3s trước'));
  assert.ok(renderedPanel.text.includes('x:120 y:64 z:-48 · ping 42ms · proxy: có'));
  assert.ok(renderedPanel.text.includes('Gần đây'));
  assert.ok(renderedPanel.text.includes('Cập nhật '));

  // Kiểm tra trạng thái stale trên bảng
  const stalePanel = P.buildPanel({ ...infoBase, now: now + 15 * 60000 });
  assert.ok(stalePanel.text.includes('(quá lâu, có thể bị treo)'));

  // Kiểm tra cắt bớt khi có 30 dòng lịch sử dài + tên thù địch: luôn <= 4096 ký tự và giữ nguyên tiêu đề/trạng thái/đang làm
  const bigHistory = Array.from({ length: 30 }, (_, i) => ({
    ts: now - i * 1000,
    level: 'info',
    text: `Dòng lịch sử rất dài số #${i} `.repeat(8) + '<tag> & "quote"',
  }));
  const bigPanel = P.buildPanel({ ...infoBase, recentLimit: 30, history: bigHistory });
  assert.ok(Array.from(bigPanel.text).length <= 4096, `Expected <= 4096 code points, got ${Array.from(bigPanel.text).length}`);
  assert.ok(bigPanel.text.includes('Auto sell spawner'));
  assert.ok(bigPanel.text.includes('Tình trạng:'));
  assert.ok(bigPanel.text.includes('Đang làm:'));
  assert.ok(bigPanel.text.includes('Cập nhật '));

  // Kiểm tra các nút bấm theo đúng bảng trạng thái mục 7
  const flatLabels = (kb) => kb.flat().map(b => b.text);
  // 1. stopped
  const kbStopped = P.buildPanelKeyboard({ ...infoBase, connState: 'DISCONNECTED', sellBusy: false });
  assert.deepStrictEqual(flatLabels(kbStopped), [`${sym('retry')} Làm mới`, `${sym('now')} Khởi động`]);
  // 2. connecting / reconnecting
  const kbReconn = P.buildPanelKeyboard({ ...infoBase, connState: 'RECONNECTING', sellBusy: false });
  assert.deepStrictEqual(flatLabels(kbReconn), [`${sym('retry')} Làm mới`, `${sym('stop')} Dừng bot`]);
  // 3. online, sell off
  const kbSellOff = P.buildPanelKeyboard({ ...infoBase, connState: 'ONLINE', sellOn: false, sellBusy: false, activity: { kind: 'idle' } });
  assert.deepStrictEqual(flatLabels(kbSellOff), [`${sym('retry')} Làm mới`, `${sym('on')} Bật bán`, `${sym('guard')} Protect`, `${sym('log')} Menu bot`]);
  // 4. online, sell on, idle
  const kbSellIdle = P.buildPanelKeyboard({ ...infoBase, connState: 'ONLINE', sellOn: true, sellBusy: false, activity: { kind: 'idle' } });
  assert.deepStrictEqual(flatLabels(kbSellIdle), [`${sym('retry')} Làm mới`, `${sym('now')} Bán ngay`, `${sym('stop')} Tắt bán`, `${sym('guard')} Protect`, `${sym('log')} Menu bot`]);
  // 5. online, sell cycle running (không có nút "Bán ngay")
  const kbSellBusy = P.buildPanelKeyboard({ ...infoBase, connState: 'ONLINE', sellOn: true, sellBusy: true, activity: { kind: 'sell' } });
  assert.deepStrictEqual(flatLabels(kbSellBusy), [`${sym('retry')} Làm mới`, `${sym('stop')} Tắt bán`, `${sym('guard')} Protect`, `${sym('log')} Menu bot`]);

  // Kiểm tra shortId ổn định, duy nhất và <= 64 bytes với ID tiếng Việt hoặc rất dài
  const weirdIds = ['bot_việt_nam_rất_dài_1234567890_abcdef', 'bot_việt_nam_rất_dài_1234567890_abcdeg', 'bot-1'];
  const shortSet = new Set(weirdIds.map(id => P.botShortId(id, weirdIds)));
  assert.strictEqual(shortSet.size, weirdIds.length, 'mỗi bot có shortId duy nhất');
  assert.strictEqual(P.botShortId('bot-1', weirdIds), P.botShortId('bot-1', weirdIds), 'shortId cố định qua các lần khởi động');
  for (const id of weirdIds) {
    const bid = P.botShortId(id, weirdIds);
    assert.strictEqual(P.resolveByShortId(bid, weirdIds), id);
  }
  assert.strictEqual(P.resolveByShortId('zzzzz', weirdIds), null);

  // ---------- 3) Golden Snapshots trong test/fixtures/ (Mục 13.11) ----------
  const fixturesDir = path.join(__dirname, 'fixtures');
  fs.mkdirSync(fixturesDir, { recursive: true });
  const goldenPanelPath = path.join(fixturesDir, 'panel-golden.json');
  const goldenData = {
    text: renderedPanel.text,
    keyboard: renderedPanel.keyboard,
  };
  if (!fs.existsSync(goldenPanelPath)) {
    fs.writeFileSync(goldenPanelPath, JSON.stringify(goldenData, null, 2) + '\n', 'utf8');
  }
  const savedGolden = JSON.parse(fs.readFileSync(goldenPanelPath, 'utf8'));
  assert.deepStrictEqual(goldenData, savedGolden, 'Panel output matches golden snapshot in test/fixtures/panel-golden.json');

  console.log('activity-panel.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
