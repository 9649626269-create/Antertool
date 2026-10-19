'use strict';
/**
 * AutoOrder — port từ premium/AutoOrder.java sang mineflayer.
 * Lặp: /order <item> → (bấm vạc nếu có) → tìm đơn giá cao nhất còn thiếu ≥ 64 (lật trang) →
 * shift-click item vào GUI giao → xác nhận (ô 16) → cộng tiền theo tin "Bạn đã giao ...".
 * Chỉ đếm stack khi server xác nhận ô thực sự giảm (ConfirmedTransfer).
 */
const { dbg } = require('./debug');
const { sleep, resolveText, nowMs } = require('./utils');
const L = require('./PremiumLogic');

const MAX_PAGES = 20;
const FILL_TITLE = 'bo vat pham vao de giao';
const FILL_TITLE_LOOSE = 'bo vat pham';

class AutoOrder {
  constructor(session) {
    this.s = session;
    this.item = null;            // tên item mineflayer, vd 'blaze_rod'
    this.running = false;
    this._gen = 0;               // tăng mỗi lần start/stop để vòng cũ tự thoát
    this.stacks = new L.StackCounter();
    this.schedule = new L.MinuteSchedule();
    this.money = 0;
    this.startedAt = 0;
    this.state = 'idle';
    this.clickCauldron = session.cfg.autoOrderCauldron ?? true;
    this.reportMin = Math.max(1, Number(session.cfg.autoOrderReportMin) || 5);
    this._restart = false;
  }

  get active() { return this.running; }
  get mc() { return this.s.mc; }

  start(item) {
    const name = String(item || '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_');
    if (!name) return false;
    if (this.running) this.stop(true);
    this.item = name;
    this.running = true;
    this.stacks.reset(); this.money = 0;
    this.startedAt = nowMs();
    this.schedule.reset(this.startedAt, this.reportMin);
    const gen = ++this._gen;
    this.s.log('ok', `AutoOrder BẬT: ${name}`);
    this._loop(gen).catch(e => { this.s.log('err', `AutoOrder lỗi: ${e.message}`); if (gen === this._gen) this.stop(true); });
    return true;
  }

  stop(quiet = false) {
    if (!this.running) return;
    this.running = false; this._gen++; this.state = 'idle';
    try { const w = this.mc?.currentWindow; if (w) this.mc.closeWindow(w); } catch (e) { dbg('AutoOrder', e); }
    if (!quiet) this.s.log('sys', `AutoOrder TẮT — ${this.summary()}`);
  }

  summary() {
    const up = Math.max(0, Math.floor((nowMs() - this.startedAt) / 1000));
    const hms = [Math.floor(up / 3600), Math.floor(up % 3600 / 60), up % 60].map(n => String(n).padStart(2, '0')).join(':');
    return `${this.stacks.stacks} stack · ${L.formatMoney(this.money)} · ${hms} · ${this.state}`;
  }

  /** Gọi từ handler chat của BotSession */
  onMessage(text) {
    if (!this.running) return;
    const d = L.parseDelivery(text);
    if (!d) return;
    this.money += d.money;
    this._restart = true;
    this.s.log('ok', `AutoOrder: giao ${d.items} → +${L.formatMoney(d.money)} (tổng ${L.formatMoney(this.money)})`);
  }

  // ── helpers ──
  _alive(gen) { return this.running && gen === this._gen && this.s.isOnline && !!this.mc; }
  _delay() { return L.smartDelayMs(this.mc?.player?.ping); }
  _title(win) { return L.normalizeVi(resolveText(win?.title || '')); }
  _lore(it) { try { return (it.customLore || []).map(l => resolveText(l)); } catch { return []; } }
  _hasItem() { return !!this.mc.inventory.items().some(i => i.name === this.item); }
  async _waitWindow(gen, ms = 5000) {
    const end = nowMs() + ms;
    while (nowMs() < end) {
      if (!this._alive(gen)) return null;
      if (this.mc.currentWindow) return this.mc.currentWindow;
      await sleep(50);
    }
    return null;
  }
  async _click(slot, mode = 0) {
    try { await Promise.race([this.mc.clickWindow(slot, 0, mode), sleep(1500)]); } catch (e) { dbg('AutoOrder', e); }
  }
  _close() { try { const w = this.mc.currentWindow; if (w) this.mc.closeWindow(w); } catch (e) { dbg('AutoOrder', e); } }

  async _periodicReport() {
    if (!this.schedule.takeIfDue(nowMs(), this.reportMin)) return;
    this.s._notify?.('autoOrder', `📦 ${this.s.cfg.id}: AutoOrder`, `${this.item}: ${this.summary()}`, 0x55ffaa);
  }

  // ── vòng chính ──
  async _loop(gen) {
    while (this._alive(gen)) {
      this._restart = false;
      await this._periodicReport();
      if (this.s._isBusy) { await sleep(1000); continue; }
      if (!this._hasItem()) { this.state = 'chờ item'; await sleep(2000); continue; }
      try { await this._pass(gen); } catch (e) { this.s.log('warn', `AutoOrder pass: ${e.message}`); }
      this._close();
      await sleep(this._delay() * 3);
    }
  }

  async _pass(gen) {
    const mc = this.mc;
    this.state = 'gửi /order';
    this._close();
    mc.chat(`/order ${L.orderCommandName(this.item)}`);
    await sleep(this._delay());
    let win = await this._waitWindow(gen);
    if (!win) return;
    await sleep(this._delay());

    // Bấm nút vạc để mở view tìm kiếm
    if (this.clickCauldron) {
      const cauldron = win.slots.findIndex((it, i) => i < win.inventoryStart && it && it.name === 'cauldron');
      if (cauldron >= 0) {
        this.state = 'mở tìm kiếm';
        await this._click(cauldron);
        this._close();
        await sleep(this._delay() * 3);
        win = await this._waitWindow(gen);
        if (!win) return;
      }
    }

    // Tìm đơn tốt nhất, lật trang
    this.state = 'tìm đơn';
    let pages = 0, slot = -1;
    for (;;) {
      if (!this._alive(gen)) return;
      win = mc.currentWindow;
      if (!win) return;
      slot = this._bestCandidate(win);
      if (slot >= 0) break;
      const next = win.slots[53];
      if (win.inventoryStart > 53 && next && pages++ < MAX_PAGES) {
        const before = this._title(win);
        await this._click(53);
        await sleep(this._delay());
        for (let i = 0; i < 20 && mc.currentWindow && this._title(mc.currentWindow) === before; i++) await sleep(100);
        continue;
      }
      return; // hết trang, không có đơn hợp lệ
    }
    await this._click(slot);
    await sleep(this._delay());

    // Giao hàng
    this.state = 'giao hàng';
    for (let round = 0; round < 6 && this._alive(gen) && !this._restart; round++) {
      win = mc.currentWindow;
      if (!win) break;
      const t = this._title(win);
      if (!t.includes(FILL_TITLE)) {
        if (!t.includes(FILL_TITLE_LOOSE)) return;
        await sleep(this._delay()); continue;
      }
      const hasEmpty = win.slots.some((it, i) => i < Math.min(54, win.inventoryStart) && !it);
      const mine = [];
      for (let i = win.inventoryStart; i < win.slots.length; i++) {
        const it = win.slots[i];
        if (it && it.name === this.item) mine.push([i, it.count]);
      }
      if (!hasEmpty || !mine.length) break;
      const acct = new L.ConfirmedTransfer(new Map(mine));
      for (const [i] of mine) await this._click(i, 1); // shift-click
      await sleep(this._delay() * 2);
      const cur = new Map();
      for (const [i] of mine) { const it = mc.currentWindow?.slots[i]; cur.set(i, it && it.name === this.item ? it.count : 0); }
      this.stacks.addConfirmedItems(acct.reconcileAll(cur));
      if (!this._hasItem()) break;
    }

    // Xác nhận
    this.state = 'xác nhận';
    this._close();
    win = await this._waitWindow(gen, 4000);
    if (win && win.inventoryStart > 16) {
      await this._click(16);
      await sleep(this._delay());
      // GUI giao đóng → còn item thì bấm lại cho lượt kế (vòng ngoài sẽ /order lại)
    }
  }

  _bestCandidate(win) {
    const cands = [];
    const limit = Math.min(45, win.inventoryStart);
    for (let i = 0; i < limit; i++) {
      const it = win.slots[i];
      if (!it || it.name !== this.item) continue;
      const lore = this._lore(it);
      cands.push({ slot: i, remaining: L.orderRemaining(lore), price: L.orderPricePerItem(lore) });
    }
    return L.bestOrderSlot(cands);
  }
}

module.exports = AutoOrder;
