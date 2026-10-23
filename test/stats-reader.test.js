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

// ── làm sạch & Small Caps Unicode của KingMC ──
assert.strictEqual(R.cleanMinecraftText('§a§lMoney §r&7x&#ff00ff!'), 'Money x!');
assert.strictEqual(R.cleanMinecraftText('§x§f§f§0§0§0§0Red'), 'Red');
assert.strictEqual(R.smallCapsToUpper('ᴍᴏɴᴇʏ'), 'MONEY');
assert.strictEqual(R.smallCapsToUpper('ꜱʜᴀʀᴅꜱ'), 'SHARDS');
assert.strictEqual(R.smallCapsToUpper('ꜱʜᴀƦᴅꜱ'), 'SHARDS'); // \u01A6
assert.strictEqual(R.smallCapsToUpper('ᴋɪʟʟꜱ'), 'KILLS');
assert.strictEqual(R.smallCapsToUpper('ᴋꞮʟʟꜱ'), 'KILLS'); // \uA7AE
assert.strictEqual(R.smallCapsToUpper('ᴅᴇᴀᴛʜꜱ'), 'DEATHS');
assert.strictEqual(R.smallCapsToUpper('ᴘʟᴀʏᴇᴅ ᴛɪᴍᴇ'), 'PLAYED TIME');
assert.strictEqual(R.smallCapsToUpper('ᴍᴏʙ ᴋɪʟʟꜱ'), 'MOB KILLS');
assert.strictEqual(R.smallCapsToUpper('ʙʟᴏᴄᴋꜱ ᴍɪɴᴇᴅ'), 'BLOCKS MINED');
assert.strictEqual(R.smallCapsToUpper('ᴀɴɪᴍᴀʟꜱ ʙʀᴇᴇᴅ'), 'ANIMALS BREED');
assert.strictEqual(R.smallCapsToUpper('ʙʟᴏᴄᴋꜱ ᴘʟᴀᴄᴇᴅ'), 'BLOCKS PLACED');

// ── phân loại nhãn stats (đủ 8 chỉ số chính của KingMC) ──
assert.strictEqual(R.statsLabel({ displayName: '§6Money' }), 'Tài chính');
assert.strictEqual(R.statsLabel({ displayName: 'Shards' }), 'Shards');
assert.strictEqual(R.statsLabel({ displayName: 'Playtime' }), 'Thời gian chơi');
assert.strictEqual(R.statsLabel({ displayName: 'Blocks Mined' }), 'Blocks Mined');
assert.strictEqual(R.statsLabel({ displayName: 'Mob Kills' }), 'Mob Kills');
assert.strictEqual(R.statsLabel({ displayName: 'Animals Breed' }), 'Animals Breed');
assert.strictEqual(R.statsLabel({ displayName: 'Blocks Placed' }), 'Blocks Placed');
assert.strictEqual(R.statsLabel({ displayName: 'ᴋɪʟʟꜱ' }), 'Kills');
assert.strictEqual(R.statsLabel({ displayName: 'ᴅᴇᴀᴛʜꜱ' }), 'Deaths');
assert.strictEqual(R.statsLabel({ displayName: '' }), 'Thông tin');

// ── từ điển tiếng Việt & format vật phẩm ──
assert.strictEqual(R.getVietnameseName('emerald'), 'Ngọc lục bảo');
assert.strictEqual(R.getVietnameseName('diamond_sword'), 'Kiếm kim cương');
assert.strictEqual(R.getVietnameseName('amethyst_shard'), 'Mảnh thạch anh tím');
assert.strictEqual(R.formatItemName('iron_chestplate'), 'Iron Chestplate');
assert.strictEqual(R.getStatsLabelVi('Kills'), 'Hạ gục (PvP)');
assert.strictEqual(R.getStatsLabelVi('Mob Kills'), 'Quái đã diệt');
assert.strictEqual(R.getStatsLabelVi('Blocks Mined'), 'Khối đã đào');

// ── phân tích số dư /bal từ tin nhắn chat (parseBalanceMessage) ──
const bal1 = R.parseBalanceMessage('Số dư của Steve: $1,250,000', 'Steve');
assert.ok(bal1);
assert.strictEqual(bal1.player, 'Steve');
assert.strictEqual(bal1.balance, '$1,250,000');
assert.strictEqual(bal1.amount, 1250000);

const bal2 = R.parseBalanceMessage('Balance of Steve: $1,250,000.50', 'Steve');
assert.ok(bal2);
assert.strictEqual(bal2.balance, '$1,250,000.50');
assert.strictEqual(bal2.amount, 1250000.5);

const bal3 = R.parseBalanceMessage('Số dư của Steve là 50,000 Xu', 'Steve');
assert.ok(bal3);
assert.strictEqual(bal3.balance, '50,000 Xu');
assert.strictEqual(bal3.amount, 50000);

const bal4 = R.parseBalanceMessage("Steve's balance: $999", 'Steve');
assert.ok(bal4);
assert.strictEqual(bal4.balance, '$999');

const bal5 = R.parseBalanceMessage('Steve có $500,000', 'Steve');
assert.ok(bal5);
assert.strictEqual(bal5.balance, '$500,000');

const bal6 = R.parseBalanceMessage('[KingMC] Số dư của Steve: $1,250,000.', 'Steve');
assert.ok(bal6);
assert.strictEqual(bal6.balance, '$1,250,000');

// Bỏ qua nếu tin nhắn số dư thuộc về người khác
assert.strictEqual(R.parseBalanceMessage('Số dư của Alex: $200', 'Steve'), null);
// Bỏ qua tin nhắn chat của người chơi
assert.strictEqual(R.parseBalanceMessage('<Alex> Số dư của Steve: $1,000,000', 'Steve'), null);

// ── item trang trí / dòng lore ──
assert.ok(R.isDecorationItem({ name: 'gray_stained_glass_pane', displayName: ' ', lore: [] }));
assert.ok(R.isDecorationItem({ name: 'barrier', displayName: 'x' }));
assert.ok(R.isDecorationItem({ name: 'paper', displayName: '' }));
assert.ok(!R.isDecorationItem({ name: 'emerald', displayName: 'Money', lore: ['1'] }));
assert.deepStrictEqual(R.cleanLoreLines(['§7------', '§a$1,250', '', 'Nhấp để mở', 'Click here', '====']), ['$1,250']);

// ── quét cửa sổ & bóc tách đủ 8 chỉ số chính KingMC ──
const it = (name, display, lore) => ({ name, customName: display, customLore: lore });
const mkWin = slots => ({ title: '{"text":"Stats của Steve"}', inventoryStart: 27, slots: [...slots, ...new Array(Math.max(0, 63 - slots.length)).fill(null)] });
const win = mkWin([
  it('gray_stained_glass_pane', ' ', []),
  it('emerald', '{"text":"ᴍᴏɴᴇʏ"}', ['{"text":"§a$1,250"}', '{"text":"Nhấp để xem"}']),
  null,
  it('amethyst_shard', { type: 'compound', value: { text: { type: 'string', value: 'Shards' } } }, ['{"text":"3,400"}']),
  it('netherite_sword', 'Kills', []), // không có lore → bỏ
]);
win.slots[40] = it('emerald', 'Túi đồ', ['KHÔNG ĐƯỢC ĐỌC']); // ngoài container
const items = R.buildItems(R.scanWindow(win));
assert.deepStrictEqual(items.map(i => [i.slot, i.title, i.value, i.label]), [
  [1, 'MONEY', '$1,250', 'Tài chính'],
  [3, 'SHARDS', '3,400', 'Shards'],
]);
assert.deepStrictEqual(items.map(R.formatLine), ['MONEY | $1,250', 'SHARDS | 3,400']);

// Kiểm tra toàn bộ 8 chỉ số chính cùng lúc
const fullWin = mkWin([
  it('emerald', '{"text":"ᴍᴏɴᴇʏ"}', ['{"text":"§a$1,250"}']),
  it('amethyst_shard', '{"text":"ꜱʜᴀƦᴅꜱ"}', ['{"text":"3,400"}']),
  it('netherite_sword', '{"text":"ᴋɪʟʟꜱ"}', ['{"text":"42"}']),
  it('skeleton_skull', '{"text":"ᴅᴇᴀᴛʜꜱ"}', ['{"text":"10"}']),
  it('clock', '{"text":"ᴘʟᴀʏᴇᴅ ᴛɪᴍᴇ"}', ['{"text":"15h 30m"}']),
  it('zombie_head', '{"text":"ᴍᴏʙ ᴋɪʟʟꜱ"}', ['{"text":"320"}']),
  it('diamond_pickaxe', '{"text":"ʙʟᴏᴄᴋꜱ ᴍɪɴᴇᴅ"}', ['{"text":"1,500"}']),
  it('wheat', '{"text":"ᴀɴɪᴍᴀʟꜱ ʙʀᴇᴇᴅ"}', ['{"text":"25"}']),
]);
const fullItems = R.buildItems(R.scanWindow(fullWin));
assert.strictEqual(fullItems.length, 8);
assert.deepStrictEqual(fullItems.map(i => [i.title, i.value, i.label]), [
  ['MONEY', '$1,250', 'Tài chính'],
  ['SHARDS', '3,400', 'Shards'],
  ['KILLS', '42', 'Kills'],
  ['DEATHS', '10', 'Deaths'],
  ['PLAYED TIME', '15h 30m', 'Thời gian chơi'],
  ['MOB KILLS', '320', 'Mob Kills'],
  ['BLOCKS MINED', '1,500', 'Blocks Mined'],
  ['ANIMALS BREED', '25', 'Animals Breed'],
]);

// ── tin báo không tìm thấy ──
assert.ok(R.isNotFoundMessage('Không tìm thấy người chơi Steve', 'Steve'));
assert.ok(!R.isNotFoundMessage('Không tìm thấy người chơi Alex', 'Steve'));
assert.ok(!R.isNotFoundMessage('xin chào Steve', 'Steve'));

// ── luồng request với session giả ──
(async () => {
  const chats = [];
  const mkSession = () => {
    const s = {
      isOnline: true,
      _isBusy: false,
      mc: {
        chat: m => chats.push(m),
        closeWindow() { this.closed = true; }
      },
    };
    s.statsReader = new StatsReader(s);
    s.checkStats = (player, timeoutMs) => s.statsReader.request(player, timeoutMs);
    s.checkBal = (player, timeoutMs) => s.statsReader.requestBal(player, timeoutMs);
    return s;
  };

  // 1) thành công: GUI mở nhưng item nạp muộn
  {
    chats.length = 0;
    const s = mkSession(); const r = s.statsReader;
    const p = r.request('Steve', 5000);
    assert.deepStrictEqual(chats, ['/stats Steve']);
    assert.ok(r.pending);
    await assert.rejects(r.request('Alex'), /khác/); // đang bận yêu cầu stats khác
    const w = mkWin([]);
    assert.strictEqual(r.handleWindow(w), true);
    setTimeout(() => { w.slots[1] = it('emerald', 'Money', ['$5']); }, 300);
    const res = await p;
    assert.strictEqual(res.player, 'Steve');
    assert.deepStrictEqual(res.lines, ['MONEY | $5']);
    assert.ok(s.mc.closed); assert.ok(!r.pending);
    assert.strictEqual(r.handleWindow(w), false); // không còn chờ → không nhận cửa sổ
  }

  // 2) server báo không tìm thấy khi request stats
  {
    const r = new StatsReader(mkSession());
    const p = r.request('Ghost', 5000);
    r.onMessage('Không tìm thấy người chơi Ghost');
    await assert.rejects(p, /Không tìm thấy/);
  }

  // 3) timeout stats
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

  // 5) từ chối stats: offline / bận / tên sai / mất kết nối giữa chừng
  {
    const s = mkSession(); const r = s.statsReader;
    s.isOnline = false; await assert.rejects(r.request('A'), /chưa online/);
    s.isOnline = true; s._isBusy = true; await assert.rejects(r.request('A'), /bận/);
    s._isBusy = false; await assert.rejects(r.request('bad name!'), /không hợp lệ/);
    const p = r.request('Steve', 5000); r.reset();
    await assert.rejects(p, /ngắt kết nối/);
  }

  // 6) race: GUI trễ sau timeout không được gán cho yêu cầu mới
  {
    const s = mkSession(); const r = s.statsReader;
    await assert.rejects(r.request('Slow', 50), /Timeout/);
    await assert.rejects(r.request('Next', 50), /vừa timeout/);
    assert.strictEqual(r.handleWindow(mkWin([it('emerald', 'Money', ['$9'])])), true);
    assert.ok(s.mc.closed); assert.ok(!r.pending);
    const p = r.request('Next', 5000);
    const w1 = mkWin([it('emerald', 'Money', ['$1'])]);
    assert.strictEqual(r.handleWindow(w1), true);
    assert.strictEqual(r.handleWindow(mkWin([it('emerald', 'Money', ['$2'])])), false);
    assert.deepStrictEqual((await p).lines, ['MONEY | $1']);
  }

  // 7) requestBal thành công
  {
    chats.length = 0;
    const s = mkSession(); const r = s.statsReader;
    const p = r.requestBal('Steve', 5000);
    assert.deepStrictEqual(chats, ['/bal Steve']);
    assert.ok(r.pendingBal);
    await assert.rejects(r.requestBal('Alex'), /khác/); // đang bận yêu cầu balance khác
    r.onBalMessage('Số dư của Steve: $1,250,000');
    const res = await p;
    assert.strictEqual(res.player, 'Steve');
    assert.strictEqual(res.balance, '$1,250,000');
    assert.strictEqual(res.amount, 1250000);
    assert.ok(!r.pendingBal);
  }

  // 8) requestBal không tìm thấy người chơi
  {
    const s = mkSession(); const r = s.statsReader;
    const p = r.requestBal('Ghost', 5000);
    r.onBalMessage('Không tìm thấy người chơi Ghost');
    await assert.rejects(p, /Không tìm thấy/);
    assert.ok(!r.pendingBal);
  }

  // 9) requestBal timeout
  {
    const s = mkSession(); const r = s.statsReader;
    await assert.rejects(r.requestBal('Slow', 60), /Timeout/);
    assert.ok(!r.pendingBal);
  }

  // 10) requestBal từ chối: offline / bận / tên sai / mất kết nối
  {
    const s = mkSession(); const r = s.statsReader;
    s.isOnline = false; await assert.rejects(r.requestBal('A'), /chưa online/);
    s.isOnline = true; s._isBusy = true; await assert.rejects(r.requestBal('A'), /bận/);
    s._isBusy = false; await assert.rejects(r.requestBal('invalid name!'), /không hợp lệ/);
    const p = r.requestBal('Steve', 5000); r.reset();
    await assert.rejects(p, /ngắt kết nối/);
  }

  // 11) kiểm thử phương thức tiện ích checkStats và checkBal trên BotSession
  {
    chats.length = 0;
    const s = mkSession();
    // checkBal qua session
    const pBal = s.checkBal('Steve', 5000);
    assert.deepStrictEqual(chats, ['/bal Steve']);
    s.statsReader.onBalMessage('Balance of Steve: $5,000,000');
    const balRes = await pBal;
    assert.strictEqual(balRes.balance, '$5,000,000');
    assert.strictEqual(balRes.amount, 5000000);

    // checkStats qua session
    chats.length = 0;
    const pStats = s.checkStats('Steve', 5000);
    assert.deepStrictEqual(chats, ['/stats Steve']);
    const w = mkWin([it('emerald', 'Money', ['$100'])]);
    s.statsReader.handleWindow(w);
    const statsRes = await pStats;
    assert.strictEqual(statsRes.player, 'Steve');
    assert.deepStrictEqual(statsRes.lines, ['MONEY | $100']);
  }

  console.log('stats-reader OK (all tests passed!)');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
