'use strict';
/**
 * autosell.js — Auto-sell khi đầy túi đồ, bán qua GUI /sell. KHÔNG cần macro, KHÔNG cần sửa config.json.
 * (Cách bán tham khảo tool HEXTEKO: mở /sell → shift-click các item đã chọn vào GUI → click 2 ô xác nhận.)
 *
 * Dùng:   cmd <id> autosell <%đầy> <item1,item2,...>     vd: cmd s1 autosell 50 cobblestone
 *         cmd <id> autosell off | autosell on | autosell
 * Cài đặt từng bot lưu ở file RIÊNG autosell.json (cạnh config.json, giống revenue.json — update không đụng tới).
 *
 * Mỗi lần bán:
 *   1. Túi đạt ngưỡng % đầy (BotSession._checkAutoSell gọi vào đây).
 *   2. Gõ lệnh mở shop (mặc định /sell), chờ GUI mở.
 *   3. Shift-click mọi stack khớp TÊN CHÍNH XÁC trong danh sách items sang GUI (không khớp "một phần": ghi
 *      "sword" sẽ KHÔNG bán diamond_sword — muốn bán gì phải ghi đúng tên item đó).
 *   4. Click ô xác nhận thứ 1, chờ 0.5s, click ô xác nhận thứ 2 (mặc định: ô cuối GUI rồi ô trái-cuối;
 *      số âm = đếm ngược từ cuối GUI: -1 = ô cuối, -9 = đầu hàng cuối).
 *   5. Còn đồ khớp thì lặp lại (tối đa MAX_ROUNDS lần), xong thì đóng GUI.
 */
const fs = require('fs');
const path = require('path');
const { sleep, jit } = require('./utils');

// Mặc định — muốn đổi riêng từng bot thì sửa "command" / "clicks" trong autosell.json
const DEFAULTS = { command: '/sell', clicks: [-1, -9] };
const OPEN_TIMEOUT_MS = 6000;   // chờ GUI mở sau khi gõ lệnh
const OPEN_SETTLE_MS = 650;     // chờ server gửi đủ ô đồ
const MOVE_GAP_MS = 60;         // nghỉ giữa 2 lần shift-click
const CONFIRM_GAP_MS = 500;     // nghỉ giữa 2 click xác nhận
const CLICK_TIMEOUT_MS = 3000;
const MAX_ROUNDS = 20;
const MAX_ITEMS = 30;
const ITEM_RE = /^[a-z0-9_]{2,40}$/;

const normItem = s => String(s ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');

// "cobblestone, stone" | ['cobblestone','stone'] -> { items: [...hợp lệ, không trùng], bad: [...tên sai dạng] }
function parseItems(input) {
  const raw = (Array.isArray(input) ? input.join(',') : String(input ?? '')).split(/[,;|\s]+/);
  const items = [], bad = [];
  for (const r of raw) {
    const n = normItem(r);
    if (!n) continue;
    if (!ITEM_RE.test(n)) bad.push(String(r));
    else if (!items.includes(n)) items.push(n);
  }
  return { items: items.slice(0, MAX_ITEMS), bad };
}

// Khớp tên chính xác (tên item trong game hoặc tên hiển thị), không khớp một phần
function matches(item, items) {
  if (!item || !items?.length) return false;
  return items.includes(normItem(item.name)) || items.includes(normItem(item.displayName));
}

// Số ô của phần GUI (shop) — phần còn lại là túi đồ của bot
function guiSize(win) {
  if (!win) return 0;
  if (Number.isInteger(win.inventoryStart) && win.inventoryStart > 0) return win.inventoryStart;
  return Math.max(0, (win.slots?.length || 0) - 36);
}

// n < 0: đếm ngược từ cuối GUI. Ngoài GUI -> null (không click bậy vào túi đồ)
function resolveSlot(n, size) {
  const v = Number(n);
  if (!Number.isInteger(v)) return null;
  const s = v < 0 ? size + v : v;
  return s >= 0 && s < size ? s : null;
}

const countTop = (win, size) => { let n = 0; for (let i = 0; i < size; i++) if (win.slots?.[i]) n++; return n; };
const matchingSlots = (win, size, items) => { const out = []; for (let i = size; i < (win.slots?.length || 0); i++) if (matches(win.slots[i], items)) out.push(i); return out; };

// Chuẩn hoá 1 mục cài đặt đọc từ autosell.json (hoặc từ người dùng)
function sanitize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const { items } = parseItems(r.items);
  let threshold = parseInt(r.threshold, 10);
  if (!(threshold >= 1 && threshold <= 100)) threshold = null;
  let command = String(r.command || '').trim() || DEFAULTS.command;
  if (!command.startsWith('/')) command = '/' + command;
  const clicks = Array.isArray(r.clicks) && r.clicks.length === 2 && r.clicks.every(Number.isInteger) ? r.clicks.slice() : DEFAULTS.clicks.slice();
  return { enabled: r.enabled === true && items.length > 0, threshold, items, command, clicks };
}

// autosell.json: { "<id bot>": { enabled, threshold, items, command, clicks } }
class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j === 'object' && !Array.isArray(j)) this.data = j;
    } catch { /* chưa có file / file hỏng -> bắt đầu trống */ }
  }
  _key(id) {
    const low = String(id).toLowerCase();
    return Object.keys(this.data).find(k => k.toLowerCase() === low) || String(id);
  }
  get(id) { return sanitize(this.data[this._key(id)]); }
  save(id, cfg) {
    this.data[this._key(id)] = sanitize(cfg);
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (e) {
      if (!process.env.SILENT_CONFIG) console.error('[autosell] Không lưu được autosell.json:', e.message);
    }
  }
}
Store.pathNextTo = configPath => path.join(path.dirname(configPath), 'autosell.json');

// Bot đang rảnh để bán? (không tranh GUI với bảo vệ lồng / auto-sell spawn / macro)
function canRun(bot) {
  return !!bot.isOnline && !bot._autoSellBusy && !bot._spawnerBusy && !bot._sellSpawnBusy && !bot.macroEngine?.running;
}

async function openGui(bot, mc, command) {
  const winP = bot._waitWindowOpen(mc, OPEN_TIMEOUT_MS); // đăng ký chờ TRƯỚC khi gõ lệnh để không lỡ sự kiện
  try { mc.chat(command); } catch (e) { bot.log('err', `Auto-sell: lỗi gửi ${command}: ${e.message}`); }
  const w = await winP;
  if (!w) return null;
  await sleep(jit(OPEN_SETTLE_MS, 150));
  return mc.currentWindow || w;
}

/**
 * Chạy 1 lượt bán. cfg = { items, command, clicks }.
 * Trả về { status, sold, moved }:
 *   'sold'    đã bán ít nhất 1 lần
 *   'nothing' túi không có item nào trong danh sách (không mở /sell)
 *   'busy'    bot đang bận việc khác (chưa làm gì)
 *   'fail'    không bán được (GUI không mở / bị ngắt / shop không nhận đồ)
 */
async function run(bot, cfg) {
  const mc = bot.mc;
  const log = (lvl, msg) => bot.log(lvl, `Auto-sell: ${msg}`);
  if (!bot.isOnline || !mc?.entity?.position) return { status: 'fail', sold: 0, moved: 0 };
  if (!canRun(bot)) return { status: 'busy', sold: 0, moved: 0 };
  const names = cfg.items.join(', ');
  if (!(mc.inventory?.items?.() || []).some(it => matches(it, cfg.items))) {
    log('warn', `túi không có [${names}] để bán`);
    return { status: 'nothing', sold: 0, moved: 0 };
  }
  bot._autoSellBusy = true;
  const stop = () => !bot.isOnline || bot.mc !== mc || bot._spawnerBusy || !!bot.macroEngine?.running;
  let lastWin = null, sold = 0, moved = 0;
  const cur = () => { const w = bot.mc === mc ? mc.currentWindow : null; if (w) lastWin = w; return w; };
  const click = async (slot, mode) => { try { await bot._withTimeout(mc.clickWindow(slot, 0, mode), CLICK_TIMEOUT_MS); return true; } catch { return false; } };
  try {
    bot._releaseAfkKeys?.(); // đang đi AFK thì đứng yên rồi mới mở shop
    if (mc.currentWindow) { try { mc.closeWindow(mc.currentWindow); } catch { } await sleep(300); }
    log('sys', `túi đầy — gõ ${cfg.command} để bán [${names}]`);
    if (!(await openGui(bot, mc, cfg.command))) { log('warn', `${cfg.command} không mở GUI sau ${OPEN_TIMEOUT_MS / 1000}s`); return { status: 'fail', sold, moved }; }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (stop()) { log('warn', 'bị ngắt giữa chừng (bảo vệ lồng/macro/mất kết nối)'); break; }
      let win = cur();
      if (!win) { // server tự đóng GUI sau khi bán -> còn đồ thì mở lại
        if (!(mc.inventory?.items?.() || []).some(it => matches(it, cfg.items))) break;
        if (!(await openGui(bot, mc, cfg.command))) { log('warn', `GUI đã đóng và ${cfg.command} không mở lại được`); break; }
        win = cur();
        if (!win) break;
      }
      const size = guiSize(win);
      if (size <= 9) { log('warn', `GUI chỉ có ${size} ô — không phải shop, dừng`); break; }
      const todo = matchingSlots(win, size, cfg.items);
      if (!todo.length) break; // hết đồ để bán
      const before = countTop(win, size);
      let n = 0;
      for (const i of todo) {
        if (stop()) break;
        if (await click(i, 1)) { n++; moved++; } // shift-click: túi -> GUI shop
        await sleep(MOVE_GAP_MS);
      }
      await sleep(250);
      const w2 = cur() || win;
      if (countTop(w2, guiSize(w2)) <= before) { log('warn', `shift-click ${n} stack mà GUI không nhận thêm đồ (đầy/không cho chuyển) — dừng`); break; }
      if (stop()) break;
      const s1 = resolveSlot(cfg.clicks[0], guiSize(w2));
      if (s1 === null) { log('warn', `ô xác nhận ${cfg.clicks[0]} nằm ngoài GUI (${guiSize(w2)} ô) — sửa "clicks" trong autosell.json`); break; }
      await click(s1, 0);
      await sleep(CONFIRM_GAP_MS);
      const w3 = cur();
      if (w3) {
        const s2 = resolveSlot(cfg.clicks[1], guiSize(w3));
        if (s2 === null) { log('warn', `ô xác nhận ${cfg.clicks[1]} nằm ngoài GUI (${guiSize(w3)} ô) — sửa "clicks" trong autosell.json`); break; }
        await click(s2, 0);
      }
      sold++;
      log('sys', `lần bán ${sold}: chuyển ${n} stack, đã click ô ${s1}${w3 ? ` rồi ô ${resolveSlot(cfg.clicks[1], guiSize(w3))}` : ' (GUI tự đóng)'}`);
      await sleep(jit(700, 200));
    }
  } finally {
    try { const w = bot.mc === mc ? mc.currentWindow : null; if (w && w === lastWin) mc.closeWindow(w); } catch { } // chỉ đóng đúng GUI của mình
    bot._autoSellBusy = false;
  }
  if (sold) log('ok', `xong ${sold} lần bán (chuyển ${moved} stack)`);
  return { status: sold ? 'sold' : 'fail', sold, moved };
}

module.exports = { DEFAULTS, normItem, parseItems, matches, guiSize, resolveSlot, sanitize, Store, canRun, run };
