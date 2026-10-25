'use strict';
const assert = require('assert');
const Module = require('module');
const EventEmitter = require('events');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'mineflayer') return { createBot() { return new EventEmitter(); } };
  if (request === 'vec3') return function (x, y, z) { return { x: x || 0, y: y || 0, z: z || 0 }; };
  return origLoad.call(this, request, ...rest);
};

const {
  isGlassOrDecoration,
  parseShardShopItems,
  formatShopItemList,
  isShortageMessage,
  isTeleportSuccessMessage,
  stripDiacritics,
  ShardShopBuyer,
} = require('../src/core/ShardShopBuyer');
const BotSession = require('../src/core/BotSession');

// ══════════════════════════════════════════════════════════════════════════════
// 0. UNIT TEST: stripDiacritics
// ══════════════════════════════════════════════════════════════════════════════
console.log('Testing stripDiacritics...');
assert.strictEqual(stripDiacritics('Lồng Bò'), 'long bo');
assert.strictEqual(stripDiacritics('Lồng Gà'), 'long ga');
assert.strictEqual(stripDiacritics('Duy nhất'), 'duy nhat');
assert.strictEqual(stripDiacritics('Liên tục'), 'lien tuc');
assert.strictEqual(stripDiacritics('Đồng ý'), 'dong y');
assert.strictEqual(stripDiacritics(''), '');
assert.strictEqual(stripDiacritics(null), '');

// ══════════════════════════════════════════════════════════════════════════════
// 1. UNIT TEST: isGlassOrDecoration
// ══════════════════════════════════════════════════════════════════════════════
console.log('Testing isGlassOrDecoration...');

// Kính và kính tấm phải bị lọc bỏ
assert.strictEqual(isGlassOrDecoration(null), true, 'null slot must be filtered');
assert.strictEqual(isGlassOrDecoration(undefined), true, 'undefined slot must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'air' }), true, 'air must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'barrier' }), true, 'barrier must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'glass_pane' }), true, 'glass_pane must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'stained_glass_pane' }), true, 'stained_glass_pane must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'black_stained_glass_pane' }), true, 'black_stained_glass_pane must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'white_stained_glass_pane' }), true, 'white_stained_glass_pane must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'gray_stained_glass_pane' }), true, 'gray_stained_glass_pane must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'glass' }), true, 'glass block must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'stained_glass' }), true, 'stained_glass block must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'black_stained_glass' }), true, 'black_stained_glass block must be filtered');
assert.strictEqual(isGlassOrDecoration({ name: 'tinted_glass' }), true, 'tinted_glass block must be filtered');

// Vật phẩm hợp lệ (spawner, vật phẩm shop) phải được giữ lại
assert.strictEqual(
  isGlassOrDecoration({ name: 'spawner', customName: '{"text":"§eLồng Heo"}' }),
  false,
  'spawner must NOT be filtered'
);
assert.strictEqual(
  isGlassOrDecoration({ name: 'spawner', customName: '§6Lồng Quỷ Lửa' }),
  false,
  'spawner with raw color code must NOT be filtered'
);
assert.strictEqual(
  isGlassOrDecoration({ name: 'trial_spawner', displayName: 'Lồng Skeleton' }),
  false,
  'trial_spawner must NOT be filtered'
);
assert.strictEqual(
  isGlassOrDecoration({ name: 'spawner' }),
  false,
  'spawner without custom display name must NOT be filtered'
);
assert.strictEqual(
  isGlassOrDecoration({ name: 'mob_spawner' }),
  false,
  'mob_spawner must NOT be filtered'
);
assert.strictEqual(
  isGlassOrDecoration({ name: 'blaze_rod', displayName: 'Gậy Quỷ Lửa' }),
  false,
  'shop item must NOT be filtered'
);

// ══════════════════════════════════════════════════════════════════════════════
// 2. UNIT TEST: parseShardShopItems & formatShopItemList
// ══════════════════════════════════════════════════════════════════════════════
console.log('Testing parseShardShopItems & formatShopItemList...');

// Mock Window với các ô kính trang trí xen kẽ lồng spawner
const mockWindow = {
  title: '{"text":"§8Shard Shop"}',
  inventoryStart: 27,
  slots: new Array(63).fill(null),
};

// Viền kính trang trí (slots 0..9)
mockWindow.slots[0] = { name: 'black_stained_glass_pane', customName: ' ' };
mockWindow.slots[1] = { name: 'black_stained_glass_pane', customName: ' ' };
mockWindow.slots[2] = { name: 'gray_stained_glass', customName: ' ' };
mockWindow.slots[9] = { name: 'glass_pane' };

// Lồng spawner tại các slot thực tế
mockWindow.slots[10] = {
  name: 'spawner',
  customName: '{"text":"§a§lLồng Heo"}',
  customLore: ['{"text":"§7Giá: §b100 Shards"}'],
};
mockWindow.slots[11] = {
  name: 'spawner',
  customName: '§e§lLồng Bò',
  customLore: ['§7Giá: 150 Shards'],
};

// Kính trang trí xen giữa
mockWindow.slots[12] = { name: 'white_stained_glass_pane', customName: ' ' };
mockWindow.slots[13] = { name: 'tinted_glass', customName: ' ' };

mockWindow.slots[14] = {
  name: 'spawner',
  customName: '{"text":"§c§lLồng Zombie"}',
};
mockWindow.slots[15] = {
  name: 'trial_spawner',
  displayName: 'Lồng Skeleton',
};

// Slot ngoài container (thuộc túi đồ player: slot >= 27)
mockWindow.slots[30] = {
  name: 'spawner',
  customName: 'Lồng trong túi đồ (KHÔNG ĐƯỢC QUÉT)',
};

const parsed = parseShardShopItems(mockWindow);

// Kiểm tra số lượng item hợp lệ
assert.strictEqual(parsed.length, 4, 'Should parse exactly 4 valid spawner items');

// Kiểm tra đánh số tuần tự [1], [2], [3], [4] và giữ nguyên slot thực tế
assert.deepStrictEqual(
  parsed.map(i => ({ index: i.index, slot: i.slot, displayName: i.displayName })),
  [
    { index: 1, slot: 10, displayName: 'Lồng Heo' },
    { index: 2, slot: 11, displayName: 'Lồng Bò' },
    { index: 3, slot: 14, displayName: 'Lồng Zombie' },
    { index: 4, slot: 15, displayName: 'Lồng Skeleton' },
  ],
  'Items must have sequential 1-based index and preserve actual window slot'
);

// Kiểm tra formatShopItemList
const formatted = formatShopItemList(parsed);
assert.deepStrictEqual(formatted, [
  '[1] Lồng Heo',
  '[2] Lồng Bò',
  '[3] Lồng Zombie',
  '[4] Lồng Skeleton',
]);

// ══════════════════════════════════════════════════════════════════════════════
// 3. UNIT TEST: isShortageMessage (chat detection logic)
// ══════════════════════════════════════════════════════════════════════════════
console.log('Testing isShortageMessage...');

// Phải nhận diện đúng mọi dạng thông báo thiếu tiền / shard
assert.strictEqual(isShortageMessage('Bạn cần có 500 Shards để mua vật phẩm này!'), true);
assert.strictEqual(isShortageMessage('§c[Shop] §fBạn cần thêm 20 shards!'), true);
assert.strictEqual(isShortageMessage('bạn cần có đủ shard để tiếp tục'), true);
assert.strictEqual(isShortageMessage('BẠN CẦN THÊM SHARDS'), true);
assert.strictEqual(isShortageMessage('ban can co 100 shard'), true);
assert.strictEqual(isShortageMessage('You need 100 shards to purchase this spawner.'), true);
assert.strictEqual(isShortageMessage('§eYou need more currency!'), true);
assert.strictEqual(isShortageMessage('you need at least 50 shards'), true);
assert.strictEqual(isShortageMessage('Bạn không đủ shards để mua vật phẩm này!'), true);
assert.strictEqual(isShortageMessage('§cKhong du shard de mua!'), true);
assert.strictEqual(isShortageMessage('Bạn còn thiếu 50 Shards nữa'), true);
assert.strictEqual(isShortageMessage('ban con thieu shard'), true);
assert.strictEqual(isShortageMessage('Not enough shards to buy this spawner!'), true);
assert.strictEqual(isShortageMessage('Insufficient balance/shards!'), true);

// KHÔNG được trigger nhầm với các tin nhắn khác
assert.strictEqual(isShortageMessage('Dịch chuyển thành công!'), false);
assert.strictEqual(isShortageMessage('Đã mua thành công 1 Lồng Heo!'), false);
assert.strictEqual(isShortageMessage('Chào mừng bạn đến với KingMC'), false);
assert.strictEqual(isShortageMessage('Số dư hiện tại: 1,200 shards'), false);
assert.strictEqual(isShortageMessage(''), false);
assert.strictEqual(isShortageMessage(null), false);
assert.strictEqual(isShortageMessage(undefined), false);

// ══════════════════════════════════════════════════════════════════════════════
// 4. UNIT TEST: isTeleportSuccessMessage
// ══════════════════════════════════════════════════════════════════════════════
console.log('Testing isTeleportSuccessMessage...');

assert.strictEqual(isTeleportSuccessMessage('Dịch chuyển thành công!'), true);
assert.strictEqual(isTeleportSuccessMessage('dich chuyen thanh cong'), true);
assert.strictEqual(isTeleportSuccessMessage('§aTeleport thành công tới Steve'), true);
assert.strictEqual(isTeleportSuccessMessage('Successfully teleported to player'), true);
assert.strictEqual(isTeleportSuccessMessage('Đang đếm ngược 5s...'), false);

// ══════════════════════════════════════════════════════════════════════════════
// 5. INTEGRATION & MOCK SESSION TEST: ShardShopBuyer Workflows
// ══════════════════════════════════════════════════════════════════════════════
console.log('Testing ShardShopBuyer workflows...');

(async () => {
  // Helper tạo mock session
  function createMockSession() {
    const logs = [];
    const chats = [];
    const clicks = [];
    const events = new (require('events').EventEmitter)();

    const session = {
      isOnline: true,
      cfg: { id: 'bot-test', ownerUsername: 'TesterOwner' },
      log: (level, msg) => logs.push({ level, msg, time: Date.now() }),
      getLogs: () => logs,
      on: (ev, fn) => events.on(ev, fn),
      emit: (ev, ...args) => events.emit(ev, ...args),
      removeListener: (ev, fn) => events.removeListener(ev, fn),
      mc: {
        chat: (msg) => chats.push(msg),
        clickWindow: (slot, button, mode) => clicks.push({ slot, button, mode }),
        closeWindow: () => { session.mc.currentWindow = null; },
        currentWindow: null,
        on: (ev, fn) => events.on(ev, fn),
        once: (ev, fn) => events.once(ev, fn),
        removeListener: (ev, fn) => events.removeListener(ev, fn),
      },
      chats,
      clicks,
      events,
    };
    return session;
  }

  // ── 5.1: Mode 1 (Single Purchase) ──
  {
    console.log('Testing Mode 1 (Single Purchase)...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ owner: 'TesterOwner' });

    // Step 1: Check /tpa sent
    assert.deepStrictEqual(s.chats, ['/tpa TesterOwner'], 'Should send /tpa TesterOwner');
    assert.strictEqual(buyer.ownsWindows(), true, 'Should own windows while running');

    // Simulate TPA confirmation window open
    const tpaGui = { id: 1, title: 'TPA Confirm', slots: new Array(27).fill(null) };
    s.events.emit('windowOpen', tpaGui);

    // Wait short time for tpa winclick delay (1000ms in implementation)
    // Fast-forward or await next tick
    await new Promise(r => setTimeout(r, 1200));

    // Verify click slot 16 button 1
    assert.ok(
      s.clicks.some(c => c.slot === 16 && c.button === 1),
      'Should click slot 16 button 1 for TPA confirm'
    );

    // Simulate teleport success message
    buyer.onMessage('Dịch chuyển thành công');

    // Wait for step 2: /shard
    await new Promise(r => setTimeout(r, 200));
    assert.ok(s.chats.includes('/shard'), 'Should send /shard');

    // Simulate /shard window open with mock items
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    // Buyer is now at step 4: waiting for choice
    assert.strictEqual(buyer.hasPendingQuestion, true, 'Should have pending choice question');

    // Answer choice: select item 1 (Lồng Heo, slot 10)
    assert.strictEqual(buyer.answer('1'), true, 'Should accept choice answer 1');

    await new Promise(r => setTimeout(r, 50));

    // Now at step 4.5: waiting for mode
    assert.strictEqual(buyer.hasPendingQuestion, true, 'Should have pending mode question');

    // Answer mode: 1 (Single purchase)
    assert.strictEqual(buyer.answer('1'), true, 'Should accept mode answer 1');

    const result = await startPromise;
    assert.strictEqual(result, true, 'Macro should complete successfully');

    // Check slot 10 was clicked with button 1
    assert.ok(
      s.clicks.some(c => c.slot === 10 && c.button === 1),
      'Should click slot 10 with button 1 for Single Purchase'
    );
    assert.strictEqual(buyer.running, false, 'Buyer should be idle after completion');
  }

  // ── 5.2: Mode 2 (Continuous Purchase with Shortage Chat Detection) ──
  {
    console.log('Testing Mode 2 (Continuous Purchase & Shortage Termination)...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    // Start with skipTpa to test shop loop directly
    const startPromise = buyer.start({ skipTpa: true });

    // Open shard window
    await new Promise(r => setTimeout(r, 50));
    assert.ok(s.chats.includes('/shard'), 'Should send /shard');
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    // Select item 2 (Lồng Bò, slot 11)
    assert.strictEqual(buyer.answer('2'), true);
    await new Promise(r => setTimeout(r, 50));

    // Select mode 2 (Continuous purchase)
    assert.strictEqual(buyer.answer('2'), true);

    // Allow purchase loop to run 2 iterations
    await new Promise(r => setTimeout(r, 600));
    assert.ok(s.clicks.filter(c => c.slot === 11).length >= 1, 'Should have clicked slot 11 at least once');

    // Simulate server shortage message
    buyer.onMessage('Bạn cần có 150 Shards để mua vật phẩm này!');

    // Await loop termination
    const result = await startPromise;
    assert.strictEqual(result, true, 'Macro should terminate cleanly on shortage');
    assert.strictEqual(buyer.running, false, 'Buyer should stop running after shortage');

    // Check that warning log was recorded
    const logs = s.getLogs();
    assert.ok(
      logs.some(l => l.level === 'warn' && l.msg.includes('thiếu shard')),
      'Should log shortage warning'
    );
  }

  // ── 5.3: Manual Stop ──
  {
    console.log('Testing Manual Stop...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ skipTpa: true });
    await new Promise(r => setTimeout(r, 50));
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    assert.strictEqual(buyer.hasPendingQuestion, true);
    // User stops macro
    assert.strictEqual(buyer.stop(), true);
    assert.strictEqual(buyer.running, false);
    assert.strictEqual(buyer.hasPendingQuestion, false);

    const result = await startPromise;
    assert.strictEqual(result, false, 'Stopped macro should return false');
  }

  // ── 5.3b: Invalid Choice Re-prompting ──
  {
    console.log('Testing Invalid Choice Re-prompting...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ skipTpa: true });
    await new Promise(r => setTimeout(r, 50));
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    assert.strictEqual(buyer.hasPendingQuestion, true);
    // Invalid numeric choice (999 doesn't exist)
    assert.strictEqual(buyer.answer('999'), false, 'Should reject invalid choice 999');
    assert.strictEqual(buyer.hasPendingQuestion, true, 'Question should still be pending after invalid input');

    // Valid choice afterwards
    assert.strictEqual(buyer.answer('1'), true, 'Should accept valid choice 1');
    await new Promise(r => setTimeout(r, 50));

    // Invalid mode (mode 9 doesn't exist)
    assert.strictEqual(buyer.answer('9'), false, 'Should reject invalid mode 9');
    assert.strictEqual(buyer.hasPendingQuestion, true, 'Mode question should still be pending');

    // Valid mode 1
    assert.strictEqual(buyer.answer('1'), true, 'Should accept valid mode 1');
    const result = await startPromise;
    assert.strictEqual(result, true, 'Macro should complete after valid inputs');
  }

  // ── 5.3c: Window Closed During Mode 2 ──
  {
    console.log('Testing Window Closed During Mode 2...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ skipTpa: true });
    await new Promise(r => setTimeout(r, 50));
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    buyer.answer('1'); // Choice 1
    await new Promise(r => setTimeout(r, 50));
    buyer.answer('2'); // Mode 2

    await new Promise(r => setTimeout(r, 200));
    // Window is closed by server
    s.mc.currentWindow = null;
    await new Promise(r => setTimeout(r, 1600));

    const result = await startPromise;
    assert.strictEqual(result, true, 'Macro should terminate cleanly when window is closed');
    assert.strictEqual(buyer.running, false);
    const logs = s.getLogs();
    assert.ok(logs.some(l => l.level === 'warn' && l.msg.includes('Cửa sổ GUI đã đóng')));
  }

  // ── 5.4: BotSession Command Integration ──
  {
    console.log('Testing BotSession Command Integration...');
    const fakeCfg = { id: 'bot-1', username: 'Test', ownerUsername: 'Owner1' };
    const session = new BotSession(fakeCfg, 'teal', null);

    // Check command registration
    const cmdList = session.cmdRegistry.list().map(c => c.name);
    assert.ok(cmdList.includes('buyspawner'), 'buyspawner command should be registered');
    assert.ok(cmdList.includes('mualong'), 'mualong alias should be registered');
    assert.ok(cmdList.includes('tpashard'), 'tpashard alias should be registered');

    // Test answering via session 'answer' command
    session.shardShopBuyer._pendingPrompt = {
      resolve: (text) => { session.testAnswer = text; return true; },
      question: 'Test?',
    };
    session.cmd('answer 42');
    assert.strictEqual(session.testAnswer, '42', 'Session answer command should route to shardShopBuyer');

    // Test stop via session 'stopmacro' command
    session.shardShopBuyer.running = true;
    session.cmd('stopmacro');
    assert.strictEqual(session.shardShopBuyer.running, false, 'stopmacro should stop shardShopBuyer');
  }

  // ── 5.5: Unaccented Spawner Search & Accented Mode ──
  {
    console.log('Testing Unaccented Spawner Search & Accented Mode...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ skipTpa: true });
    await new Promise(r => setTimeout(r, 50));
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    // Choose spawner using unaccented name "bo" (should find "Lồng Bò", slot 11)
    assert.strictEqual(buyer.answer('bo'), true, 'Should match "bo" to "Lồng Bò"');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(buyer.selectedItem.slot, 11);

    // Choose mode using accented Vietnamese string "duy nhất" (Mode 1)
    assert.strictEqual(buyer.answer('duy nhất'), true, 'Should match "duy nhất" to mode 1');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(buyer.mode, 1);

    const result = await startPromise;
    assert.strictEqual(result, true);
    assert.ok(s.clicks.some(c => c.slot === 11 && c.button === 1));
  }

  // ── 5.6: Bracketed Input & Title Shortage Notification ──
  {
    console.log('Testing Bracketed Input & Title Shortage Notification...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ skipTpa: true });
    await new Promise(r => setTimeout(r, 50));
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    // Choose item using bracket format "[3]" (Lồng Zombie, slot 14)
    assert.strictEqual(buyer.answer('[3]'), true, 'Should accept "[3]" as choice 3');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(buyer.selectedItem.slot, 14);

    // Choose mode using bracket format "[2]" (Continuous)
    assert.strictEqual(buyer.answer('[2]'), true, 'Should accept "[2]" as mode 2');
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(buyer.mode, 2);

    await new Promise(r => setTimeout(r, 600));
    assert.ok(s.clicks.some(c => c.slot === 14));

    // Simulate shortage delivered via Title/Subtitle
    buyer.onMessage('§cBạn không đủ shard để mua!');

    const result = await startPromise;
    assert.strictEqual(result, true);
    assert.strictEqual(buyer.running, false);
  }

  // ── 5.7: Prompt Cancellation / Abort via Keywords ──
  {
    console.log('Testing Prompt Cancellation / Abort via Keywords...');
    const s = createMockSession();
    const buyer = new ShardShopBuyer(s);

    const startPromise = buyer.start({ skipTpa: true });
    await new Promise(r => setTimeout(r, 50));
    s.events.emit('windowOpen', mockWindow);
    await new Promise(r => setTimeout(r, 500));

    assert.strictEqual(buyer.hasPendingQuestion, true);
    // User types "huy" or "cancel" or "stop"
    assert.strictEqual(buyer.answer('huy'), true, 'Should accept "huy" to cancel');
    assert.strictEqual(buyer.hasPendingQuestion, false);
    assert.strictEqual(buyer.running, false);

    const result = await startPromise;
    assert.strictEqual(result, false, 'Cancelled macro should return false');
  }

  // ── 5.8: Multi-Word buyspawner Argument Parsing ──
  {
    console.log('Testing Multi-Word buyspawner Argument Parsing...');
    const fakeCfg = { id: 'bot-1', username: 'Test', ownerUsername: 'Owner1' };
    const session = new BotSession(fakeCfg, 'teal', null);
    Object.defineProperty(session, 'isOnline', { get: () => true, configurable: true });
    session.shardShopBuyer.start = async (opts) => {
      session.capturedOpts = opts;
      return true;
    };

    // Case 1: buyspawner lồng bò 2
    session.cmd('buyspawner lồng bò 2');
    assert.deepStrictEqual(session.capturedOpts, { choice: 'lồng bò', mode: 2 });

    // Case 2: buyspawner long heo 1
    session.cmd('buyspawner long heo 1');
    assert.deepStrictEqual(session.capturedOpts, { choice: 'long heo', mode: 1 });

    // Case 3: buyspawner 1 2
    session.cmd('buyspawner 1 2');
    assert.deepStrictEqual(session.capturedOpts, { choice: 1, mode: 2 });
  }

  console.log('\n✔ All ShardShopBuyer tests passed successfully!');
  process.exit(0);
})().catch(err => {
  console.error('\n✘ Test failed:', err);
  process.exit(1);
});
