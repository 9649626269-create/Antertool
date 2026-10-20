'use strict';
// Auto menu: GUI "MENU" mở ra thì bot phải CLICK ô vào server (24), không được đóng GUI rồi báo "xong".
const assert = require('assert');
const WindowRouter = require('../src/core/WindowRouter');
const WR = WindowRouter.WindowRouter || WindowRouter;

function mkBot(over = {}) {
  const calls = { click: [], close: 0, done: [] , logs: []};
  const bot = {
    cfg: { autoMenu: true, menuCommand: '/menu' }, settings: {}, isOnline: true,
    _menuSuccess: false, _manualMenuUntil: 0,
    log: (l, m) => calls.logs.push(m), _clearTimer() { }, _setTimer() { },
    _onMenuDone(src) { calls.done.push(src); },
    mc: { clickWindow: (...a) => { calls.click.push(a); return Promise.resolve(); }, closeWindow: () => { calls.close++; } },
    ...over,
  };
  return { bot, calls };
}
const win = { title: JSON.stringify({ text: 'MENU' }), type: 'minecraft:generic_9x6', slots: Array.from({ length: 90 }, (_, i) => (i === 0 || i === 24) ? { name: 'x', count: 1 } : null) };

// 1) đường đúng (sau fix): _menuSuccess còn false khi route -> click ô 24 + báo menu xong
{
  const { bot, calls } = mkBot();
  const handled = WR.route(bot, win);
  assert.strictEqual(handled, false, 'GUI lạ -> route trả false');
  assert.deepStrictEqual(calls.click, [[24, 0, 0]], 'phải click ô 24');
  assert.strictEqual(calls.close, 0);
  assert.strictEqual(bot._menuSuccess, true);
  assert.strictEqual(calls.done.length, 1);
}
// 2) đường lỗi cũ (ghi lại lý do): nếu _menuSuccess đã bị đặt true TRƯỚC khi route => GUI bị đóng, không click
{
  const { bot, calls } = mkBot({ _menuSuccess: true });
  WR.route(bot, win);
  assert.strictEqual(calls.click.length, 0); assert.strictEqual(calls.close, 1);
}
// 3) gõ tay "menu" (_manualMenuUntil) vẫn click như cũ
{
  const { bot, calls } = mkBot({ _menuSuccess: true, _manualMenuUntil: Date.now() + 5000 });
  WR.route(bot, win);
  assert.deepStrictEqual(calls.click, [[24, 0, 0]]);
}
console.log('menu-click.test OK');
