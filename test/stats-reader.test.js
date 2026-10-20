'use strict';
const assert = require('assert');
const StatsReader = require('../src/core/StatsReader');
const R = StatsReader;

// ── component / NBT / lore ──
assert.strictEqual(R.componentText('{"text":"Tiền","extra":[{"text":": 5"}]}'), 'Tiền: 5');
assert.strictEqual(R.componentText({ type: 'compound', value: { text: { type: 'string', value: 'Kills' } } }), 'Kills');
assert.strictEqual(R.componentText([{ text: 'a' }, { text: 'b' }]), 'ab');
assert.strictEqual(R.componentText(null), '');
assert.strictEqual(R.componentText({ '': 'x', extra: [{ text: 'y' }] }), 'xy');

// lore dạng component mới (minecraft:lore) và NBT cũ (display.Lore)
const nbtNew = { type: 'compound', value: { 'minecraft:lore': { type: 'list', value: { type: 'string', value: ['{"text":"§a$1,250"}', '{"text":"Nhấp để xem"}'] } } } };
assert.deepStrictEqual(R.loreFromNbt(nbtNew.value), ['§a$1,250', 'Nhấp để xem']);
const nbtOld = { display: { value: { Lore: { value: { value: ['{"text":"42 kills"}'] } } } } };
assert.deepStrictEqual(R.loreFromNbt(nbtOld), ['42 kills']);
assert.deepStrictEqual(R.loreFromNbt(null), []);

// ── làm sạch ──
assert.strictEqual(R.cleanMinecraftText('§a§lMoney §r&7x&#ff00ff!'), 'Money x!');
assert.strictEqual(R.cleanMinecraftText('§x§f§f§0§0§0§0Red'), 'Red');
assert.strictEqual(R.smallCapsToUpper('ᴍᴏɴᴇʏ'), 'MONEY');
assert.strictEqual(R.smallCapsToUpper('ᴋɪʟʟꜱ'), 'KILLS');
assert.strictEqual(R.smallCapsToUpper('ᴀɴɪᴍᴀʟꜱ ʙʀᴇᴇᴅ'), 'ANIMALS BREED');
assert.strictEqual(R.statsLabel({ displayName: '§6Money' }), 'Tài chính');
assert.strictEqual(R.statsLabel({ displayName: 'Shards' }), 'Shards');
assert.strictEqual(R.statsLabel({ displayName: 'Playtime' }), 'Thời gian chơi');
assert.strictEqual(R.statsLabel({ displayName: 'Blocks Mined' }), 'Blocks Mined');
assert.strictEqual(R.statsLabel({ displayName: '' }), 'Thông tin');

// ── item trang trí / dòng lore ──
assert.ok(R.isDecorationItem({ name: 'gray_stained_glass_pane', displayName: ' ', lore: [] }));
assert.ok(R.isDecorationItem({ name: 'barrier', displayName: 'x' }));
assert.ok(R.isDecorationItem({ name: 'paper', displayName: '' }));
assert.ok(!R.isDecorationItem({ name: 'emerald', displayName: 'Money', lore: ['1'] }));
assert.deepStrictEqual(R.cleanLoreLines(['§7------', '§a$1,250', '', 'Nhấp để mở', 'Click here', '====']), ['$1,250']);

// ── quét cửa sổ ──
const it = (name, display, lore) => ({ name, customName: display, customLore: lore });
const mkWin = slots => ({ title: '{"text":"Stats của Steve"}', inventoryStart: 27, slots: [...slots, ...new Array(Math.max(0, 63 - slots.length)).fill(null)] });
const win = mkWin([
  it('gray_stained_glass_pane', ' ', []),
  it('emerald', '{"text":"ᴍᴏɴᴇʏ"}', ['{"text":"§a$1,250"}', '{"text":"Nhấp để xem"}']),
  null,
  it('amethyst_shard', { type: 'compound', value: { text: { type: 'string', value: 'Shards' } } }, ['{"text":"3,400"}']),
  it('netherite_sword', 'Kills', []),                       // không có lore → bỏ
]);
win.slots[40] = it('emerald', 'Túi đồ', ['KHÔNG ĐƯỢC ĐỌC']); // ngoài phần container
const items = R.buildItems(R.scanWindow(win));
assert.deepStrictEqual(items.map(i => [i.slot, i.title, i.value, i.label]), [
  [1, 'MONEY', '$1,250', 'Tài chính'],
  [3, 'SHARDS', '3,400', 'Shards'],
]);
assert.deepStrictEqual(items.map(R.formatLine), ['MONEY | $1,250', 'SHARDS | 3,400']);

// ── tin báo không tìm thấy ──
assert.ok(R.isNotFoundMessage('Không tìm thấy người chơi Steve', 'Steve'));
assert.ok(!R.isNotFoundMessage('Không tìm thấy người chơi Alex', 'Steve'));
assert.ok(!R.isNotFoundMessage('xin chào Steve', 'Steve'));

// ── luồng request với session giả ──
(async () => {
  const chats = [];
  const mkSession = () => ({
    isOnline: true, _isBusy: false,
    mc: { chat: m => chats.push(m), closeWindow() { this.closed = true; } },
  });

  // 1) thành công: GUI mở nhưng item nạp muộn
  {
    const s = mkSession(); const r = new StatsReader(s);
    const p = r.request('Steve', 5000);
    assert.deepStrictEqual(chats, ['/stats Steve']);
    assert.ok(r.pending);
    await assert.rejects(r.request('Alex'), /khác/);              // đang bận yêu cầu khác
    const w = mkWin([]);
    assert.strictEqual(r.handleWindow(w), true);
    setTimeout(() => { w.slots[1] = it('emerald', 'Money', ['$5']); }, 300);
    const res = await p;
    assert.strictEqual(res.player, 'Steve');
    assert.deepStrictEqual(res.lines, ['MONEY | $5']);
    assert.ok(s.mc.closed); assert.ok(!r.pending);
    assert.strictEqual(r.handleWindow(w), false);                  // không còn chờ → không nhận cửa sổ
  }
  // 2) server báo không tìm thấy
  {
    const r = new StatsReader(mkSession());
    const p = r.request('Ghost', 5000);
    r.onMessage('Không tìm thấy người chơi Ghost');
    await assert.rejects(p, /Không tìm thấy/);
  }
  // 3) timeout
  {
    const r = new StatsReader(mkSession());
    await assert.rejects(r.request('Slow', 80), /Timeout/);
    assert.ok(!r.pending);
  }
  // 4) GUI rỗng
  {
    const r = new StatsReader(mkSession());
    const p = r.request('Empty', 8000);
    r.handleWindow(mkWin([]));
    await assert.rejects(p, /Không có stats/);
  }
  // 5) từ chối: offline / bận / tên sai / mất kết nối giữa chừng
  {
    const s = mkSession(); const r = new StatsReader(s);
    s.isOnline = false; await assert.rejects(r.request('A'), /chưa online/);
    s.isOnline = true; s._isBusy = true; await assert.rejects(r.request('A'), /bận/);
    s._isBusy = false; await assert.rejects(r.request('bad name!'), /không hợp lệ/);
    const p = r.request('Steve', 5000); r.reset();
    await assert.rejects(p, /ngắt kết nối/);
  }
  console.log('stats-reader OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
