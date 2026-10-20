const assert = require('assert');
const L = require('../src/core/PremiumLogic');
// lore
assert.strictEqual(L.orderRemaining(['x', 'Đã giao: 100 / 1000']), 900);
assert.strictEqual(L.orderRemaining(['none']), -1);
assert.strictEqual(L.orderPricePerItem(['Giá: $1.5K mỗi cái']), 1500);
assert.strictEqual(L.bestOrderSlot([{ slot: 1, remaining: 100, price: 5 }, { slot: 2, remaining: 10, price: 99 }, { slot: 3, remaining: 64, price: 7 }]), 3);
assert.strictEqual(L.bestOrderSlot([{ slot: 1, remaining: 63, price: 5 }]), -1);
// delivery (có dấu, K/M/B)
assert.deepStrictEqual(L.parseDelivery('Bạn đã giao 64 blaze rod, nhận được: +$2.5K'), { items: 64, money: 2500 });
assert.strictEqual(L.parseDelivery('hello'), null);
assert.strictEqual(L.compactNumber('3', 'b'), 3e9);
// stack counter
const sc = new L.StackCounter(); sc.addConfirmedItems(40); sc.addConfirmedItems(40);
assert.deepStrictEqual([sc.stacks, sc.remainder], [1, 16]);
// confirmed transfer: không đếm trùng
const ct = new L.ConfirmedTransfer(new Map([[10, 64], [11, 32]]));
assert.strictEqual(ct.reconcileSlot(10, 0), 64);
assert.strictEqual(ct.reconcileSlot(10, 0), 0);
assert.strictEqual(ct.reconcileSlot(11, 20), 12);
assert.strictEqual(ct.reconcileSlot(11, 0), 20);
assert.strictEqual(ct.reconcileSlot(99, 0), 0);
// schedule
const ms = new L.MinuteSchedule();
assert.strictEqual(ms.takeIfDue(0 + 1, 1), false);
assert.strictEqual(ms.takeIfDue(61000, 1), true);
assert.strictEqual(ms.takeIfDue(62000, 1), false);
// messages
assert.ok(L.isOutOfStockMessage('Không có vật phẩm nào để nhận'));
assert.ok(L.isOutOfMoneyMessage('Bạn cần $150 để mua vật phẩm này'));
assert.ok(!L.isOutOfMoneyMessage('xin chào'));
assert.strictEqual(L.moneyLimit(2.5), 2500000);
assert.strictEqual(L.moneyLimit(-1), 0);
assert.strictEqual(L.moneyForItems(10), 1500);
// small caps title
assert.ok(L.normalizeVi('ʙỏ ᴠậᴛ ᴘʜẩᴍ ᴠàᴏ để ɢɪᴀᴏ').includes('bo vat pham vao de giao'));
// spawner dropper
const sel = new Set(['blaze_rod']);
assert.strictEqual(L.classifyPage([{ slot: 0, item: 'dirt', count: 1 }], sel), 'junk');
assert.strictEqual(L.classifyPage([{ slot: 0, item: 'blaze_rod', count: 5 }], sel), 'selectedOrEmpty');
assert.strictEqual(L.actionFor('dropAll', 'junk'), 'startJunkDrop');
assert.strictEqual(L.nextPhase('dropAll'), 'sellAll');
assert.strictEqual(L.nearestEquivalentYaw(170, -170), 190);
const pa = new L.PendingAccounting([{ slot: 1, item: 'a', count: 64 }, { slot: 2, item: 'a', count: 10 }]);
assert.deepStrictEqual(pa.reconcile([{ slot: 1, item: 'a', count: 30 }, { slot: 2, item: 'b', count: 10 }]), { items: 44, stacks: 2 });
assert.deepStrictEqual(pa.reconcile([{ slot: 1, item: 'a', count: 0 }]), { items: 30, stacks: 0 });
// gate, slots
const g = new L.ConfirmationGate(); g.open();
assert.strictEqual(g.confirm(true, false), false); assert.strictEqual(g.confirm(true, true), true); assert.strictEqual(g.confirm(true, true), false);
assert.strictEqual(L.findFirstAvailableSlot(0, 5, new Set([1]), s => s >= 1), 2);
assert.strictEqual(L.shouldSell('Whitelist', true), true); assert.strictEqual(L.shouldSell('Blacklist', true), false);
assert.strictEqual(L.requiredTransfer(false, true, 10, 64, 64), 54); assert.strictEqual(L.requiredTransfer(false, false, 10, 64, 64), 0);
assert.strictEqual(L.patternMask([true, false, true]), 5);
// name protect
assert.strictEqual(L.protectNames('Hi Bob, bob and Alice', [['bob', 'alice'], ['alice', 'x']]), 'Hi alice, alice and x');
assert.strictEqual(L.smartDelayMs(20), 100); assert.strictEqual(L.smartDelayMs(400), 600);
console.log('premium-logic OK');
