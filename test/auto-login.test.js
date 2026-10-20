'use strict';
const assert = require('assert');
const AutoLoginFlow = require('../src/core/AutoLoginFlow');
const { ST, DEFAULTS, resolveOptions, isLoginPrompt, matchMenuTrigger, isAntibotSuccess, isAntibotItemName, findAntibotSlot, isPopulated } = AutoLoginFlow;

// ── logic thuần ──
const o = resolveOptions({ enabled: true });
assert.strictEqual(o.enabled, true);
assert.strictEqual(resolveOptions({}).enabled, false);
assert.strictEqual(resolveOptions({ actionDelayMs: 10 }).actionDelayMs, 750);       // kẹp tối thiểu
assert.strictEqual(resolveOptions({ actionDelayMs: 99999 }).actionDelayMs, 2000);   // kẹp tối đa
assert.deepStrictEqual(resolveOptions({ antibotItemNames: ['XÁC MINH'] }).antibotItemNames, ['xac minh']);
assert.deepStrictEqual(resolveOptions({ loginPrompt: [] }).loginPrompt, DEFAULTS.loginPrompt);

assert.ok(isLoginPrompt('§eVui lòng ĐĂNG NHẬP bằng lệnh /dn <mật khẩu>'));
assert.ok(!isLoginPrompt('Hãy đăng nhập'));
assert.ok(isLoginPrompt('ᴅᴀɴɢ nhap bang lenh /dn', ['dang nhap bang lenh', '/dn']));
assert.strictEqual(matchMenuTrigger('Đăng nhập thành công, nếu chưa tạo mã PIN, hãy vào /menu'), 'dang nhap thanh cong, neu chua tao ma pin, hay vao');
assert.strictEqual(matchMenuTrigger('Server còn mới nên nếu có lỗi hãy báo'), 'server con moi nen neu co');
assert.strictEqual(matchMenuTrigger('xin chào'), null);
assert.ok(isAntibotSuccess('Xác minh thành công!'));
assert.ok(!isAntibotSuccess('Xác minh thất bại'));
assert.ok(isAntibotItemName('§aXác Minh Bạn Là Người'));
assert.ok(isAntibotItemName('Click to VERIFY'));
assert.ok(!isAntibotItemName('Kim cương'));
assert.ok(!isAntibotItemName(''));

const mkWin = () => ({ slots: new Array(63).fill(null), inventoryStart: 54 });
const item = name => ({ name: 'paper', displayName: name, count: 1 });
{
  const w = mkWin();
  assert.ok(!isPopulated(w)); assert.strictEqual(findAntibotSlot(w), -1);
  w.slots[60] = item('Xác minh'); // ô trong túi đồ người chơi — không tính
  assert.ok(!isPopulated(w)); assert.strictEqual(findAntibotSlot(w), -1);
  w.slots[13] = item('Bạn là người?');
  assert.ok(isPopulated(w)); assert.strictEqual(findAntibotSlot(w), 13);
}

// ── mô phỏng toàn bộ luồng với session giả + đồng hồ giả ──
let T = 1_000_000;
const realNow = Date.now;
Date.now = () => T;
const adv = ms => { T += ms; };

function mkSession(cfgAutoLogin, extra = {}) {
  const logs = [], chats = [], clicks = [];
  const timers = new Map();
  const s = {
    cfg: { id: 'bot-1', botPassword: 'secret123', menuCommand: '/menu', registered: true, autoLogin: cfgAutoLogin },
    settings: { kingSmpSlot: 24 },
    isOnline: true, isConnected: true,
    log: (lvl, msg) => logs.push([lvl, msg]),
    _setTimer: (k, fn) => timers.set(k, fn),
    _clearTimer: k => timers.delete(k),
    _isLoginSuccessText: () => false,
    menuDone: 0, _onMenuDone() { this.menuDone++; },
    autoOrder: extra.autoOrder,
    mc: {
      entity: {}, currentWindow: null,
      chat: m => chats.push(m),
      clickWindow: async slot => { clicks.push(slot); },
      closeWindow() { s.mc.currentWindow = null; },
    },
  };
  return { s, logs, chats, clicks, timers };
}

// 1) đường đi đầy đủ: login → menu → antibot → click ô 24 → xong
{
  const calls = [];
  let running = true;
  const autoOrder = { suspend: () => { if (!running) return false; running = false; calls.push('suspend'); return true; }, resume: () => { running = true; calls.push('resume'); return true; } };
  const { s, chats, clicks, timers } = mkSession({ enabled: true }, { autoOrder });
  const f = new AutoLoginFlow(s);
  assert.ok(f.enabled && !f.inFlow);
  f.onConnected();
  assert.ok(timers.has('autoLoginTick') && timers.has('autoLoginFallback'));

  assert.strictEqual(f.onMessage('xin chào mọi người'), false);
  assert.strictEqual(f.onMessage('Vui lòng đăng nhập bằng lệnh /dn <mật khẩu>'), true);
  assert.strictEqual(f.state, ST.WAITING_TO_SEND_LOGIN);
  assert.ok(f.inFlow && !f.ownsWindows());
  assert.deepStrictEqual(calls, ['suspend']);

  f._tick(); assert.deepStrictEqual(chats, []);          // chưa đủ delay
  adv(1200); f._tick();
  assert.deepStrictEqual(chats, ['/l secret123']);
  assert.strictEqual(f.state, ST.WAITING_LOGIN_SUCCESS);

  // server nhắc /dn lại → gửi lại (sau ≥1.5s)
  adv(500); assert.strictEqual(f.onMessage('Bạn cần đăng nhập: /dn'), false); assert.strictEqual(chats.length, 1);
  adv(1500); assert.strictEqual(f.onMessage('Bạn cần đăng nhập: /dn'), true); assert.strictEqual(chats.length, 2);

  assert.strictEqual(f.onMessage('Đăng nhập thành công, nếu chưa tạo mã PIN, hãy vào /menu'), true);
  assert.strictEqual(f.state, ST.SENDING_MENU);
  assert.ok(f.ownsWindows());
  adv(1000); f._tick(); assert.strictEqual(chats.length, 2); // chưa đủ 2.5s
  adv(2000); f._tick();
  assert.strictEqual(chats[2], '/menu');
  assert.strictEqual(f.state, ST.WAIT_FOR_MENU_GUI);

  // GUI mở nhưng chưa có item → chưa kết luận
  s.mc.currentWindow = mkWin();
  adv(300); f._tick(); assert.strictEqual(f.state, ST.WAIT_FOR_MENU_GUI);
  s.mc.currentWindow.slots[13] = item('Xác minh bạn là người');
  s.mc.currentWindow.slots[24] = item('KingSMP');
  adv(300); f._tick(); assert.strictEqual(f.state, ST.ANTIBOT_VERIFY);
  adv(1000); f._tick(); assert.deepStrictEqual(clicks, [13]);
  adv(1000); f._tick(); assert.deepStrictEqual(clicks, [13, 13]);   // chưa có xác nhận → click lại

  assert.strictEqual(f.onMessage('Xác minh thành công!'), true);
  assert.strictEqual(f.state, ST.WAIT_AFTER_VERIFY);
  adv(500); f._tick(); assert.strictEqual(f.state, ST.WAIT_AFTER_VERIFY);
  adv(1500); f._tick(); assert.strictEqual(f.state, ST.CLICKING_FINAL_SLOT);
  adv(1000); f._tick();
  assert.deepStrictEqual(clicks, [13, 13, 24]);
  assert.strictEqual(f.state, ST.WAITING_TO_RESTORE);

  adv(2500); f._tick(); assert.strictEqual(f.state, ST.WAITING_TO_RESTORE); // GUI chưa đóng
  s.mc.currentWindow = null;
  adv(300); f._tick();
  assert.strictEqual(f.state, ST.IDLE);
  assert.strictEqual(s.menuDone, 1);
  assert.ok(s._loginConfirmed && s._menuSuccess);
  assert.deepStrictEqual(calls, ['suspend', 'resume']);
  assert.ok(!f.inFlow);

  // cooldown: tin kích hoạt lặp lại ngay sau đó bị bỏ qua
  adv(1000);
  assert.strictEqual(f.onMessage('Server còn mới nên nếu có lỗi hãy báo'), false);
  assert.strictEqual(f.state, ST.IDLE);
  adv(20000);
  assert.strictEqual(f.onMessage('Server còn mới nên nếu có lỗi hãy báo'), true);
  f.reset(); assert.strictEqual(f.state, ST.IDLE); assert.ok(!timers.has('autoLoginTick'));
}

// 2) không có antibot: GUI hiện thẳng ô vào server
{
  const { s, clicks } = mkSession({ enabled: true });
  const f = new AutoLoginFlow(s); f.onConnected();
  assert.strictEqual(f.joinNow(), true);
  adv(3000); f._tick();
  s.mc.currentWindow = mkWin(); s.mc.currentWindow.slots[24] = item('KingSMP'); s.mc.currentWindow.slots[10] = item('Spawn');
  adv(300); f._tick(); assert.strictEqual(f.state, ST.CLICKING_FINAL_SLOT);
  adv(1000); f._tick(); assert.deepStrictEqual(clicks, [24]);
}

// 3) antibot hiện muộn khi đang ở bước click cuối → quay lại xác minh, không click bừa ô 24
{
  const { s, clicks } = mkSession({ enabled: true });
  const f = new AutoLoginFlow(s); f.onConnected(); f.joinNow();
  adv(3000); f._tick();
  s.mc.currentWindow = mkWin(); s.mc.currentWindow.slots[24] = item('KingSMP');
  adv(300); f._tick(); assert.strictEqual(f.state, ST.CLICKING_FINAL_SLOT);
  s.mc.currentWindow.slots[13] = item('Verify');
  adv(1000); f._tick(); assert.strictEqual(f.state, ST.ANTIBOT_VERIFY); assert.deepStrictEqual(clicks, []);
}

// 4) timeout antibot → thử lại /menu
{
  const { s, chats } = mkSession({ enabled: true });
  const f = new AutoLoginFlow(s); f.onConnected(); f.joinNow();
  adv(3000); f._tick();
  s.mc.currentWindow = mkWin(); s.mc.currentWindow.slots[13] = item('Xác minh');
  adv(300); f._tick(); assert.strictEqual(f.state, ST.ANTIBOT_VERIFY);
  adv(21000); f._tick();
  assert.strictEqual(f.state, ST.SENDING_MENU);
  assert.strictEqual(s.mc.currentWindow, null);
  adv(3000); f._tick(); assert.strictEqual(chats.filter(c => c === '/menu').length, 2);
}

// 5) sai mật khẩu: không lặp vô tận
{
  const { s, chats } = mkSession({ enabled: true, maxLoginAttempts: 3 });
  const f = new AutoLoginFlow(s); f.onConnected();
  f.onMessage('đăng nhập bằng lệnh /dn');
  adv(1200); f._tick();                                   // lần 1
  for (let i = 0; i < 5 && f.state !== ST.IDLE; i++) { adv(2000); f.onMessage('Sai mật khẩu! /dn'); }
  assert.strictEqual(f.state, ST.IDLE);
  assert.strictEqual(chats.filter(c => c.startsWith('/l ')).length, 3);
}

// 6) không có mật khẩu → huỷ, không gửi lệnh rỗng
{
  const { s, chats } = mkSession({ enabled: true });
  s.cfg.botPassword = '';
  const f = new AutoLoginFlow(s); f.onConnected();
  f.onMessage('đăng nhập bằng lệnh /dn');
  adv(1200); f._tick();
  assert.strictEqual(f.state, ST.IDLE); assert.deepStrictEqual(chats, []);
}

// 7) tài khoản mới: /dk trước rồi /l; và mật khẩu riêng trong autoLogin.password ưu tiên
{
  const { s, chats } = mkSession({ enabled: true, password: 'pw-riêng' });
  s.cfg.registered = false;
  const f = new AutoLoginFlow(s); f.onConnected();
  f.onMessage('đăng nhập bằng lệnh /dn');
  adv(1200); f._tick(); assert.deepStrictEqual(chats, ['/dk pw-riêng']);
  adv(1200); f._tick(); assert.deepStrictEqual(chats, ['/dk pw-riêng', '/l pw-riêng']);
}

// 8) timeout tổng → huỷ và bật lại tính năng đã tạm dừng
{
  const calls = [];
  const autoOrder = { suspend: () => { calls.push('s'); return true; }, resume: () => { calls.push('r'); return true; } };
  const { s } = mkSession({ enabled: true, globalTimeoutMs: 30000 }, { autoOrder });
  const f = new AutoLoginFlow(s); f.onConnected();
  f.onMessage('đăng nhập bằng lệnh /dn'); adv(1200); f._tick();
  adv(31000); f._tick();
  assert.strictEqual(f.state, ST.IDLE); assert.deepStrictEqual(calls, ['s', 'r']);
}

// 9) tắt = không phản ứng; fallback auto-join
{
  const { s, timers } = mkSession({ enabled: false });
  const f = new AutoLoginFlow(s); f.onConnected();
  assert.strictEqual(f.onMessage('đăng nhập bằng lệnh /dn'), false);
  assert.ok(!timers.has('autoLoginTick'));
  const m = mkSession({ enabled: true, startFallbackMs: 5000 });
  const g = new AutoLoginFlow(m.s); g.onConnected();
  m.timers.get('autoLoginFallback')();
  assert.strictEqual(g.state, ST.SENDING_MENU);
  const m2 = mkSession({ enabled: true });
  const h = new AutoLoginFlow(m2.s); h.onConnected(); h._joinedOnce = true;
  m2.timers.get('autoLoginFallback')();
  assert.strictEqual(h.state, ST.IDLE);
}

// 10) AutoOrder.suspend/resume giữ nguyên bộ đếm
{
  const AutoOrder = require('../src/core/AutoOrder');
  const logs = [];
  const sess = { cfg: {}, isOnline: true, mc: null, log: (...a) => logs.push(a), _isBusy: true };
  const ao = new AutoOrder(sess);
  ao.start('blaze_rod'); ao.money = 1234; ao.stacks.addConfirmedItems(128);
  assert.strictEqual(ao.suspend(), true); assert.ok(!ao.active);
  assert.strictEqual(ao.suspend(), false);
  assert.strictEqual(ao.resume(), true); assert.ok(ao.active);
  assert.strictEqual(ao.money, 1234); assert.strictEqual(ao.stacks.stacks, 2);
  ao.stop(true);
  assert.strictEqual(ao.resume(), false);
  ao.start('blaze_rod'); ao.suspend(); ao.stop(true); assert.strictEqual(ao.resume(), false); // stop() huỷ trạng thái tạm dừng
}

Date.now = realNow;
console.log('auto-login OK');
process.exit(0);
