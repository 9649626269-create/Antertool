'use strict';
/**
 * StatsReader — port phần "đọc dữ liệu stats" của CheckStatsKingMC (mc-bot.js + commands/stats.js + helpers/utils.js).
 *
 * Luồng: gõ `/stats <người chơi>` → server mở GUI → đọc từng ô phần container (tên + lore, kể cả NBT/component)
 * → làm sạch mã màu / chữ small-caps → bỏ item trang trí (kính, barrier...) → trả về danh sách
 *   [{ slot, name, label, title, lore[], value }]. Đóng GUI sau khi đọc.
 *
 * Dùng:  const r = await session.statsReader.request('Notch');   // { title, items, lines }
 * Lệnh:  checkstats <người chơi>
 *
 * Khác bản Discord: không cần queue/Master-Worker — chạy thẳng trên bot đang online, mỗi bot 1 yêu cầu một lúc.
 */
const { dbg } = require('./debug');
const { nbtSimplify, sleep, nowMs } = require('./utils');

const LATE_WINDOW_MS = 4000;

// ── logic thuần (có test) ─────────────────────────────────────────────────────

/** Component / NBT / chuỗi JSON → chữ thường (đệ quy). Port từ parseMinecraftJSON. */
function componentText(x, depth = 0) {
  if (x === null || x === undefined || depth > 12) return '';
  const t = typeof x;
  if (t === 'number' || t === 'boolean') return String(x);
  if (t === 'string') {
    const s = x.trim();
    if (s[0] === '{' || s[0] === '[') {
      try { return componentText(JSON.parse(s), depth + 1); } catch { /* không phải JSON — giữ chuỗi */ }
    }
    return s.replace(/\{"color".*?\}/gi, '').trim();
  }
  if (Array.isArray(x)) return x.map(i => componentText(i, depth + 1)).join('');
  if (t === 'object') {
    // NBT bọc kiểu {type:'compound'|'list'|'string', value:...}
    if (typeof x.type === 'string' && 'value' in x) {
      if (x.type === 'compound' || x.type === 'list') return componentText(nbtSimplify(x), depth + 1);
      return componentText(x.value, depth + 1);
    }
    let out = '';
    if (x[''] !== undefined) out += componentText(x[''], depth + 1);
    if (x.text !== undefined) out += componentText(x.text, depth + 1);
    if (x.translate !== undefined && x.text === undefined) out += componentText(x.translate, depth + 1);
    if (x.extra !== undefined) out += componentText(x.extra, depth + 1);
    return out.trim();
  }
  return '';
}

/** Lore nằm trong NBT cũ (display.Lore) hoặc component mới (minecraft:lore / lore). Port từ extractLoreFromNbt. */
function loreFromNbt(nbt) {
  if (!nbt) return [];
  const root = nbt.value || nbt;
  let raw = null;
  if (root.display) {
    const d = root.display.value || root.display;
    if (d) raw = d.lore || d.Lore;
  }
  if (!raw && root['minecraft:lore']) raw = root['minecraft:lore'];
  if (!raw && root.lore) raw = root.lore;
  if (!raw) return [];
  let lines = raw.value !== undefined ? raw.value : raw;
  if (lines && lines.value !== undefined) lines = lines.value;
  if (typeof lines === 'string') lines = [lines];
  if (!Array.isArray(lines)) return [];
  return lines.map(l => componentText(l && typeof l === 'object' && l.value !== undefined ? l.value : l)).filter(Boolean);
}

/** Bỏ mã màu §/&, hex §x§r§r..., &#RRGGBB, ký tự vô hình. Port từ cleanMinecraftText. */
function cleanMinecraftText(text) {
  if (!text) return '';
  return String(text)
    .replace(/§x(§[0-9a-f]){6}/gi, '')
    .replace(/&x(&[0-9a-f]){6}/gi, '')
    .replace(/&#[0-9a-f]{6}/gi, '')
    .replace(/§#[0-9a-f]{6}/gi, '')
    .replace(/§[0-9a-fk-or]/gi, '')
    .replace(/&[0-9a-fk-or]/gi, '')
    .replace(/§./g, '')
    .replace(/[\u00A0\u200B\uFEFF]/g, ' ')
    .normalize('NFC')
    .trim();
}

// Chữ "hoa nhỏ" Unicode mà GUI KingMC dùng cho tiêu đề (ᴍᴏɴᴇʏ, ꜱʜᴀʀᴅꜱ, ᴋɪʟʟꜱ…). Viết bằng mã \u để không nhầm các ký tự na ná nhau.
const SMALL_CAPS = {
  '\u1D00': 'A', '\u0299': 'B', '\u1D04': 'C', '\u1D05': 'D', '\u1D07': 'E', '\uA730': 'F', '\u0493': 'F',
  '\u0262': 'G', '\u029C': 'H', '\u026A': 'I', '\u0196': 'I', '\uA7AE': 'I', '\u1D0A': 'J', '\u1D0B': 'K',
  '\u029F': 'L', '\u1D0D': 'M', '\u0274': 'N', '\u1D0F': 'O', '\u1D18': 'P', '\u01EB': 'Q', '\u0280': 'R',
  '\u01A6': 'R', '\uA731': 'S', '\u1D1B': 'T', '\u1D1C': 'U', '\u1D20': 'V', '\u1D21': 'W', '\u028F': 'Y',
  '\u1D22': 'Z', '\u0111': 'D', '\u0110': 'D',
};
const SMALL_CAPS_RE = new RegExp('[' + Object.keys(SMALL_CAPS).join('') + ']', 'gu');
/** ᴍᴏɴᴇʏ → MONEY. Port từ smallCapsToStandardUpper. */
function smallCapsToUpper(str) {
  if (!str) return '';
  return String(str).replace(SMALL_CAPS_RE, m => SMALL_CAPS[m] || m).toUpperCase().trim();
}

/** Nhãn nhóm theo tên hiển thị. Port từ getStatsLabel. */
function statsLabel(item) {
  // đổi chữ hoa nhỏ về Latin (giữ đ/Đ để không làm hỏng tiếng Việt) rồi mới so khớp từ khoá
  const d = cleanMinecraftText(item.displayName || '')
    .replace(SMALL_CAPS_RE, m => (m === '\u0111' || m === '\u0110') ? m : SMALL_CAPS[m])
    .toLowerCase();
  if (/tiền|\bxu\b|money|coin/.test(d)) return 'Tài chính';
  if (/shard|ngôi sao|\bsao\b|★/.test(d)) return 'Shards';
  if (/kill|giết|hạ gục/.test(d)) return 'Kills';
  if (/death|chết|bị giết/.test(d)) return 'Deaths';
  if (/thời gian|time|giờ|playtime/.test(d)) return 'Thời gian chơi';
  if (/rank|danh hiệu|cấp|level/.test(d)) return 'Rank/Cấp độ';
  return cleanMinecraftText(item.displayName || '') || 'Thông tin';
}

/** Item trang trí không mang dữ liệu. Port từ isDecorationItem. */
function isDecorationItem(item) {
  const n = String(item.name || '').toLowerCase();
  const d = cleanMinecraftText(item.displayName || '');
  if (n.includes('glass_pane') || n === 'air' || n === 'barrier') return true;
  if (!d) return true;
  if ((!item.lore || !item.lore.length) && (n.includes('pane') || n.includes('stained'))) return true;
  return false;
}

/** Lọc dòng lore: bỏ dòng kẻ ngang và dòng hướng dẫn "nhấp/click". Port từ commands/stats.js. */
function cleanLoreLines(lore) {
  return (lore || [])
    .map(cleanMinecraftText)
    .filter(line => {
      if (!line) return false;
      if (/^[_\-+=*~]*$/.test(line)) return false;
      if (line.includes('------') || line.includes('======') || line.includes('______')) return false;
      const l = line.toLowerCase();
      return !(l.includes('nhấp') || l.includes('click'));
    });
}

/** Một ô mineflayer → bản ghi thô { slot, name, displayName, lore[] } */
function rawEntry(it, slot) {
  const name = it.name || '';
  const displayName = componentText(it.customName || it.displayName || '');
  let lore = [];
  try {
    if (it.customLore) lore = (Array.isArray(it.customLore) ? it.customLore : [it.customLore]).map(l => componentText(l));
    else lore = loreFromNbt(it.nbt);
  } catch (e) { dbg('StatsReader', e); }
  return { slot, name, displayName, lore: lore.filter(Boolean) };
}

/** Quét phần container của cửa sổ → danh sách bản ghi thô (chưa lọc). */
function scanWindow(win) {
  const out = [];
  if (!win?.slots) return out;
  const lim = Number.isInteger(win.inventoryStart) ? win.inventoryStart : win.slots.length;
  for (let i = 0; i < lim; i++) {
    const it = win.slots[i];
    if (it) out.push(rawEntry(it, i));
  }
  return out;
}

/** Bản ghi thô → mục stats đã làm sạch, bỏ trang trí và mục không có giá trị. */
function buildItems(raws) {
  const items = [];
  for (const r of raws) {
    if (isDecorationItem(r)) continue;
    const lines = cleanLoreLines(r.lore);
    if (!lines.length) continue;
    const label = statsLabel(r);
    const title = smallCapsToUpper(cleanMinecraftText(r.displayName)) || label.toUpperCase();
    items.push({ slot: r.slot, name: r.name, label, title, lore: lines, value: lines.join(', ') });
  }
  return items;
}
const formatLine = it => `${it.title} | ${it.value}`;

/** Tin chat báo không có người chơi / chưa từng đăng nhập */
function isNotFoundMessage(text, player) {
  const t = String(text || '').toLowerCase();
  if (player && !t.includes(String(player).toLowerCase())) return false;
  return /không tìm thấy|khong tim thay|not found|never joined|chưa từng|chua tung|không tồn tại|khong ton tai|unknown player/.test(t);
}

// ── lấy dữ liệu từ bot đang online ───────────────────────────────────────────
class StatsReader {
  /** @param {import('./BotSession')} session */
  constructor(session) {
    this.s = session;
    this._p = null; // { player, resolve, reject, timer, startedAt, win }
    this._lateUntil = 0; // sau timeout: GUI trễ của yêu cầu cũ còn có thể tới — chặn để không gán nhầm cho yêu cầu mới
  }

  get pending() { return !!this._p; }

  /**
   * Gõ /stats <player> và chờ GUI.
   * @returns {Promise<{player:string,title:string,items:object[],lines:string[]}>}
   */
  request(player, timeoutMs = 15000) {
    const s = this.s;
    const name = String(player || '').trim();
    if (!/^[A-Za-z0-9_.*]{1,32}$/.test(name)) return Promise.reject(new Error('Tên người chơi không hợp lệ'));
    if (!s.isOnline || !s.mc) return Promise.reject(new Error('Bot chưa online'));
    if (this._p) return Promise.reject(new Error('Đang xử lý một yêu cầu stats khác'));
    if (s._isBusy) return Promise.reject(new Error('Bot đang bận (macro / bảo vệ lồng / đăng nhập) — thử lại sau'));
    if (nowMs() < this._lateUntil) return Promise.reject(new Error('Yêu cầu stats trước vừa timeout — đợi vài giây rồi thử lại'));
    return new Promise((resolve, reject) => {
      const p = { player: name, resolve, reject, timer: null, startedAt: nowMs(), win: null };
      p.timer = setTimeout(() => {
        if (this._p !== p) return; // đã xong/bị thay trước khi timer chạy
        this._lateUntil = nowMs() + LATE_WINDOW_MS;
        this._finish(new Error(`Timeout: không mở được bảng stats sau ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this._p = p;
      try { s.mc.chat(`/stats ${name}`); } catch (e) { this._finish(e); }
    });
  }

  // owner: nếu truyền vào, chỉ chốt khi yêu cầu hiện tại đúng là owner (tránh lỗi trễ của vòng đọc cũ huỷ nhầm yêu cầu mới)
  _finish(err, value, owner) {
    const p = this._p;
    if (!p || (owner && owner !== p)) return;
    this._p = null;
    clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve(value);
  }

  /** Gọi từ handler windowOpen. @returns {boolean} true = đã nhận cửa sổ này (BotSession không xử lý thêm) */
  handleWindow(win) {
    const p = this._p;
    if (!p) {
      // GUI của yêu cầu vừa timeout mới tới: đóng và nuốt, không để rơi sang WindowRouter/StatsParser
      if (nowMs() < this._lateUntil) { this._lateUntil = 0; try { this.s.mc?.closeWindow(win); } catch (e) { dbg('StatsReader', e); } return true; }
      return false;
    }
    if (p.win) return false; // mỗi yêu cầu chỉ nhận cửa sổ đầu tiên — cửa sổ thứ hai không được tạo vòng đọc song song
    p.win = win;
    this._read(win, p).catch(e => this._finish(e, undefined, p));
    return true;
  }

  async _read(win, p) {
    const title = componentText(win.title || '');
    // windowOpen đến trước window_items → chờ item nạp (tối đa ~3s)
    let raws = [];
    for (let i = 0; i < 12; i++) {
      if (this._p !== p) return;
      raws = scanWindow(win);
      if (raws.length) { await sleep(150); raws = scanWindow(win); break; } // nạp thêm nhịp cuối cho đủ ô
      await sleep(250);
    }
    if (this._p !== p) return;
    try { this.s.mc?.closeWindow(win); } catch (e) { dbg('StatsReader', e); }
    const items = buildItems(raws);
    if (!items.length) return this._finish(new Error('Không có stats hữu ích (người chơi chưa từng đăng nhập hoặc GUI rỗng)'), undefined, p);
    this._finish(null, { player: p.player, title: cleanMinecraftText(title), items, lines: items.map(formatLine) }, p);
  }

  /** Gọi từ handler chat: server trả lời "không tìm thấy người chơi" thay vì mở GUI */
  onMessage(text) {
    const p = this._p;
    if (!p) return;
    if (isNotFoundMessage(text, p.player)) this._finish(new Error(`Không tìm thấy người chơi ${p.player} hoặc chưa từng đăng nhập`));
  }

  /** Mất kết nối */
  reset() { this._lateUntil = 0; this._finish(new Error('Bot bị ngắt kết nối khi đang lấy stats')); }
}

module.exports = StatsReader;
module.exports.StatsReader = StatsReader;
Object.assign(module.exports, {
  componentText, loreFromNbt, cleanMinecraftText, smallCapsToUpper, statsLabel, isDecorationItem,
  cleanLoreLines, rawEntry, scanWindow, buildItems, formatLine, isNotFoundMessage,
});
