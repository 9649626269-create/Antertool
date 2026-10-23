'use strict';
/**
 * AutoSellHandler — logic auto-sell spawn: bật/tắt/lịch, vòng bán (_runSellSpawnCycle / _sellOneSpawn),
 * phục hồi bán lỗi (/home → bán lại), cấu hình & thông tin. State vẫn nằm trên BotSession (this.s);
 * BotSession giữ các hàm mỏng chuyển tiếp để lệnh/web/test gọi như cũ.
 * Phần doanh thu dùng chung với macro (_beginSellCapture, _captureRevenueInto...) vẫn ở BotSession.
 */
const { SELL, TP } = require('./constants');
const { jit, nowMs, sleep, resolveText } = require('./utils');
const { dbg } = require('./debug');
const { describePose } = require('./MotionUtil');
const Notifier = require('./Notifier');
const BotActivity = require('./BotActivity');

class AutoSellHandler {
  /**
   * @param {import('./BotSession')} session
   */
  constructor(session) {
    this.s = session;
  }

  // Public API wrappers — gọi lại method hiện có trên session
  checkAutoSell(usedSlots) {
    return this.s._checkAutoSell(usedSlots);
  }

  beginSellCapture(total) {
    return this.s._beginSellCapture(total);
  }

  captureSellRevenue(text, pos) {
    return this.s._captureSellRevenue(text, pos);
  }

  finalizeSellRevenue(quiet = false) {
    return this.s._finalizeSellRevenue(quiet);
  }

  // ===== Auto-sell Spawn =====
  _scanSellSpawns() {
    const s = this.s;
    const mc = s.mc;
    const ids = s._spawnerBlockIds();
    if (!mc?.entity?.position || !ids.length) return 0;
    let found = [];
    try { found = mc.findBlocks({ matching: ids, maxDistance: s.autoSellSpawnRange, count: 128 }); }
    catch (e) { s.log('warn', 'Quét lồng lỗi: ' + e.message); }
    let added = 0;
    for (const p of found) {
      if (!s.sellSpawnList.some(q => q.x === p.x && q.y === p.y && q.z === p.z)) {
        s.sellSpawnList.push({ x: p.x, y: p.y, z: p.z });
        added++;
      }
    }
    if (added) s._persistSellSpawnState();
    return added;
  }

  _startSellSpawn(resume = false) {
    const s = this.s;
    if (!s.isOnline) { s.log('warn', 'Auto-sell Spawn: bot offline — chưa bật được'); return false; }
    if (!resume) {
      const added = s._scanSellSpawns();
      if (added) s.log('ok', `Auto-sell Spawn: tự lưu ${added} lồng trong ${s.autoSellSpawnRange} block quanh bot`);
    }
    if (!s.sellSpawnList.length) {
      if (resume) { s.log('warn', 'Auto-sell Spawn: danh sách lồng trống — chưa chạy được (giữ trạng thái BẬT)'); return false; }
      s._sellSpawnOn = false;
      s._nextSellAt = 0;
      s._clearTimer('sellSpawn');
      s._persistSellSpawnState();
      s.log('warn', `Auto-sell Spawn: không có lồng nào — đứng sát lồng (≤${s.autoSellSpawnRange} block) rồi bật lại, hoặc: autosell_spawn add <x> <y> <z>`);
      return false;
    }
    s._sellSpawnOn = true;
    s._persistSellSpawnState();
    s._alignViewToSellSpawn(s.mc).catch(e => s.log('warn', 'Auto-sell Spawn: chỉnh góc nhìn lỗi: ' + e.message));
    s._scheduleSellSpawn(resume ? 8000 : 3000);
    s.log('sys', `Auto-sell Spawn: BẬT — ${s.sellSpawnList.length} lồng, click ô ${s.autoSellSpawnSlot}, lặp mỗi ${s._fmtDuration(s._sellSpawnIntervalMs())}`);
    return true;
  }

  _stopSellSpawn() {
    const s = this.s;
    s._sellSpawnOn = false;
    s._sellSpawnAbort = true;
    s._nextSellAt = 0;
    s._clearTimer('sellSpawn');
    s._persistSellSpawnState();
    BotActivity.endActivity(s, 'sell', 'Đã tắt tự bán lồng', { level: 'info' });
    s.log('sys', 'Auto-sell Spawn: TẮT');
  }

  _scheduleSellSpawn(ms) {
    const s = this.s;
    if (!s._sellSpawnOn || !s.isOnline) {
      s._nextSellAt = 0;
      return;
    }
    const delay = Math.max(500, ms);
    s._nextSellAt = nowMs() + delay;
    s._setTimer('sellSpawn', () => s._sellSpawnTick(), delay);
  }

  _onKickedDuringSell(kickMsg) {
    const s = this.s;
    if (!s._sellSpawnOn || !s._sellSpawnBusy) return;
    s._sellKickStrikes = (s._sellKickStrikes || 0) + 1;
    s.log('warn', `Bị kick khi đang chạy vòng auto-sell spawn (lần ${s._sellKickStrikes}/2): "${String(kickMsg).substring(0, 80)}"`);
    try { s.log('sys', 'Gói bot gửi ngay trước khi bị kick: ' + s.packetMgr.recentOut(8).join(' | ')); } catch (e) { dbg('BotSession', e); }
    if (s._sellKickStrikes >= 2) {
      s._sellKickStrikes = 0;
      s._stopSellSpawn();
      s.log('err', 'autosell_spawn bị kick 2 lần liên tiếp ngay lúc chuột phải lồng → đã tự TẮT. Nguyên nhân hay gặp nhất: bot đang nói giao thức KHÁC bản server thật (proxy Velocity dịch phiên bản làm hỏng gói chuột phải). Xem dòng "Giao thức" lúc kết nối; đặt "version" của bot đúng bản bạn dùng để chơi thật (vd "1.21.11") trong config.json rồi khởi động lại; bật lại bằng: autosell_spawn on');
    }
  }

  async _sellSpawnTick() {
    const s = this.s;
    if (!s._sellSpawnOn || !s.isOnline) return;
    if (s._isBusy || s._posLost) { s._scheduleSellSpawn(5000); return; }
    const t0 = nowMs();
    try { await s._runSellWithRecovery(); }
    catch (e) { s.log('err', 'Auto-sell Spawn lỗi: ' + e.message); }
    s._scheduleSellSpawn(s._sellSpawnIntervalMs() - (nowMs() - t0));
  }

  runSellSpawnNow() {
    const s = this.s;
    if (!s.isOnline) { s.log('warn', 'Auto-sell Spawn: bot offline'); return false; }
    if (s._sellSpawnBusy || s._sellRecovering) { s.log('warn', 'Auto-sell Spawn: đang chạy một vòng rồi'); return false; }
    if (s._spawnerBusy || s.scriptRunner.running) { s.log('warn', 'Auto-sell Spawn: bot đang bận (bảo vệ lồng/macro) — thử lại sau'); return false; }
    s._runSellWithRecovery().catch(e => s.log('err', 'Auto-sell Spawn lỗi: ' + e.message));
    return true;
  }

  async _alignViewToSellSpawn(mc) {
    const s = this.s;
    if (!s.isOnline || !mc?.entity?.position) return false;
    for (let w = 0; w < 20 && s._tp.frozen(nowMs()); w++) {
      await sleep(500);
      if (!s.isOnline || s.mc !== mc) return false;
    }
    if (s._tp.frozen(nowMs())) { s.log('warn', 'Auto-sell Spawn: bot vẫn đang chờ teleport — chưa chỉnh được góc nhìn (vòng bán sẽ tự nhìn lồng trước khi chuột phải)'); return false; }
    if (s._isBusy) { s.log('sys', 'Auto-sell Spawn: bot đang bận việc khác — vòng bán sẽ tự nhìn lồng trước khi chuột phải'); return false; }
    await s._settleBody(mc);
    const eye = s._eyePos(mc);
    const p = s.sellSpawnList.find(q => Math.hypot(eye.x - (q.x + 0.5), eye.y - (q.y + 0.5), eye.z - (q.z + 0.5)) <= SELL.SPAWN_REACH);
    if (!p) { s.log('warn', `Auto-sell Spawn: chưa có lồng nào trong tầm để chỉnh góc nhìn — ${describePose(s._lastBody)}`); return false; }
    const ok = await s._faceBlock(mc, p);
    s.log(ok ? 'sys' : 'warn', `Auto-sell Spawn: ${ok ? `đã chỉnh góc nhìn về lồng — tư thế ${describePose(s._lastBody)}` : `đã xoay về lồng nhưng tia ngắm chưa tới${s._aimWhy()}`} (${p.x},${p.y},${p.z})`);
    return ok;
  }

  async _runSellSpawnCycle() {
    const s = this.s;
    const mc = s.mc;
    const none = { done: 0, total: 0, ok: false, aborted: false, skipped: true, reasons: [] };
    if (!s.isOnline || !mc?.entity?.position || s._sellSpawnBusy) return none;
    const list = s.sellSpawnList.slice();
    if (!list.length) { s.log('warn', 'Auto-sell Spawn: danh sách lồng trống'); return none; }
    s._sellSpawnBusy = true;
    s._sellSpawnAbort = false;
    s._sellCycleCount = (s._sellCycleCount || 0) + 1;
    s._sellCycleStartedAt = nowMs();
    s._sellCurrentIdx = 0;
    s._releaseAfkKeys();
    if (s.autoSellSpawnRevenue) s._beginSellCapture(list.length);
    const stop = () => s._sellSpawnAbort || !s.isOnline || s.mc !== mc;
    let wasSneak = false;
    try { wasSneak = !!mc.getControlState?.('sneak'); if (wasSneak) mc.setControlState('sneak', false); } catch (e) { dbg('BotSession', e); }
    let done = 0, aborted = false;
    const reasons = [];
    s.log('sys', `Auto-sell Spawn: bắt đầu vòng bán (${list.length} lồng)`);
    try {
      for (let i = 0; i < list.length; i++) {
        if (stop()) { s.log('warn', 'Auto-sell Spawn: bị ngắt giữa chừng (bảo vệ lồng/macro/tắt/mất kết nối)'); break; }
        s._sellCurrentIdx = i;
        BotActivity.setActivity(s, 'sell', `Bán lồng ${i + 1}/${list.length} (vòng #${s._sellCycleCount})`, {
          progress: { done: i + 1, total: list.length },
          now: nowMs(),
        });
        let ok = false;
        s._sellWhy = '';
        try { ok = await s._sellOneSpawn(mc, list[i], `${i + 1}/${list.length}`, stop); }
        catch (e) { s._sellWhy = `lỗi: ${e.message}`; s.log('err', `Auto-sell Spawn [${i + 1}/${list.length}] lỗi: ${e.message}`); }
        if (ok) done++;
        else if (!stop()) reasons.push(`(${list[i].x},${list[i].y},${list[i].z}) ${s._sellWhy || 'không rõ lý do'}`);
        if (i < list.length - 1 && !stop()) await sleep(jit(900, 300));
      }
      aborted = stop();
    } finally {
      try { if (s.mc === mc && mc.currentWindow) mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); }
      try { if (wasSneak && s.mc === mc) mc.setControlState('sneak', true); } catch (e) { dbg('BotSession', e); }
      s._sellSpawnBusy = false;
      s._sellCurrentIdx = 0;
    }
    const elapsed = nowMs() - (s._sellCycleStartedAt || nowMs());
    if (!aborted && done > 0) BotActivity.recordCycleDuration(s, elapsed);
    BotActivity.endActivity(
      s,
      'sell',
      aborted ? `Ngắt vòng bán #${s._sellCycleCount} (${done}/${list.length} lồng)` : `Xong vòng bán #${s._sellCycleCount}: ${done}/${list.length} lồng`,
      { level: !aborted && done === list.length ? 'ok' : 'warn', now: nowMs() }
    );
    s.log(done === list.length ? 'ok' : 'warn', `Auto-sell Spawn: xong ${done}/${list.length} lồng${s._sellSpawnOn ? ` — vòng kế tiếp sau ~${s._fmtDuration(s._sellSpawnIntervalMs())}` : ''}`);
    if (s._sellCap) { s._sellCap.done = done; s._setTimer('sellRevFinalize', () => s._finalizeSellRevenue(false), 4000); }
    return { done, total: list.length, ok: !aborted && done === list.length, aborted, skipped: false, reasons };
  }

  _sellFail(tag, at, msg) {
    const s = this.s;
    s._sellWhy = msg;
    s.log('warn', `Auto-sell Spawn [${tag}] ${at}: ${msg}`);
    return false;
  }

  async _sellOneSpawn(mc, p, tag, stop) {
    const s = this.s;
    const block = mc.blockAt(s._vec(p));
    const at = `(${p.x},${p.y},${p.z})`;
    if (!block) return s._sellFail(tag, at, 'chunk chưa tải — bỏ qua');
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return s._sellFail(tag, at, 'không có block ở đây — bỏ qua');
    const eye = s._eyePos(mc);
    const dist = Math.hypot(eye.x - (p.x + 0.5), eye.y - (p.y + 0.5), eye.z - (p.z + 0.5));
    if (dist > SELL.SPAWN_REACH) return s._sellFail(tag, at, `quá xa (${dist.toFixed(1)} block) — bot không tự di chuyển, bỏ qua`);
    if (mc.currentWindow) { try { mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); } await sleep(300); }
    let aimed = await s._faceBlock(mc, p, { stop });
    if (stop()) return false;
    if (aimed && !s._aimCheckBlock(mc, p).hit) aimed = await s._faceBlock(mc, p, { stop });
    if (stop()) return false;
    if (!aimed) s.log('warn', `Auto-sell Spawn [${tag}] ${at}: tia ngắm chưa trúng lồng${s._aimWhy()} — vẫn thử chuột phải`);
    let win = null, waited = 0;
    for (let attempt = 1; attempt <= SELL.GUI_CLICKS && !win; attempt++) {
      const waitMs = attempt < SELL.GUI_CLICKS ? SELL.GUI_FIRST_WAIT_MS : SELL.GUI_LAST_WAIT_MS;
      const winP = s._waitWindowOpen(mc, waitMs);
      try { await s._withTimeout(mc.activateBlock(block), 2500); }
      catch (e) { s.log('warn', `Auto-sell Spawn [${tag}] ${at}: click chuột phải lỗi: ${e.message}`); }
      win = await winP;
      waited += waitMs;
      if (!win && s.mc === mc && mc.currentWindow) win = mc.currentWindow;
      if (win || stop()) break;
      if (attempt < SELL.GUI_CLICKS) {
        s.log('warn', `Auto-sell Spawn [${tag}] ${at}: GUI chưa mở sau ${(waitMs / 1000).toFixed(1)}s — nhắm lại rồi chuột phải lần ${attempt + 1}/${SELL.GUI_CLICKS}`);
        await s._faceBlock(mc, p, { stop });
        if (stop()) return false;
      }
    }
    if (!win) {
      if (stop()) return false;
      return s._sellFail(tag, at, `GUI không mở sau ${(waited / 1000).toFixed(0)}s`);
    }
    try {
      await sleep(jit(650, 150));
      const slot = s.autoSellSpawnSlot;
      const start = win.inventoryStart ?? Math.max(0, win.slots.length - 36);
      if (slot >= start) return s._sellFail(tag, at, `GUI chỉ có ${start} ô — slot ${slot} nằm ngoài GUI (là túi đồ của bot), KHÔNG click. Kiểm tra lại số slot`);
      let it = win.slots[slot];
      for (let k = 0; !it && k < 3; k++) { await sleep(500); it = win.slots[slot]; }
      if (!it) return s._sellFail(tag, at, `ô ${slot} trống — không click`);
      if (stop()) return false;
      const name = resolveText(it.customName || it.displayName || it.name || '').substring(0, 40);
      const title = resolveText(win.title || '').substring(0, 30);
      s.log('sys', `Auto-sell Spawn [${tag}] ${at}: GUI [${title}] — click ô ${slot} "${name}"`);
      try { await s._withTimeout(mc.clickWindow(slot, s.autoSellSpawnButton, 0), 3000); }
      catch (e) { s.log('warn', `Auto-sell Spawn [${tag}] ${at}: click ô ${slot} lỗi: ${e.message}`); }
      await sleep(jit(700, 200));
      s._sellKickStrikes = 0;
      return true;
    } finally {
      try { const cur = s.mc === mc ? mc.currentWindow : null; if (cur) mc.closeWindow(cur); } catch (e) { dbg('BotSession', e); }
      await sleep(jit(350, 100));
    }
  }

  _sellHomeCmd() {
    const s = this.s;
    const c = String(s.spawnHomeCommand || '/home treolong').trim() || '/home treolong';
    return c.startsWith('/') ? c : `/${c}`;
  }

  async _runSellWithRecovery() {
    const s = this.s;
    const mc = s.mc;
    s._sellRecovering = true;
    s._sellRecoveryStartedAt = nowMs();
    s._sellRecoveryAttempt = 0;
    s._sellHomeTries = 0;
    try {
      let res = await s._runSellSpawnCycle();
      if (res.ok || res.aborted || res.skipped) return res;
      const max = s.sellFailMaxHome;
      if (!(max > 0)) return res;
      const cmd = s._sellHomeCmd();
      const stopRec = () => !s.isOnline || s.mc !== mc || s._spawnerBusy || s._sellSpawnAbort;
      for (let n = 1; n <= max; n++) {
        if (stopRec()) { s.log('warn', 'Auto-sell Spawn: ngắt chuỗi thử lại (bảo vệ lồng/tắt/mất kết nối)'); return { ...res, aborted: true }; }
        s._sellRecoveryAttempt = n;
        s._sellHomeTries = n;
        BotActivity.setActivity(s, 'recovery', `Gõ ${cmd} phục hồi bán (lần ${n}/${max})`, {
          progress: { done: n, total: max },
          now: nowMs(),
        });
        s.log('warn', `Auto-sell Spawn: bán chưa xong (${res.done}/${res.total}${res.reasons.length ? `: ${res.reasons[0]}` : ''}) → gõ ${cmd} rồi bán lại (lần ${n}/${max})`);
        await s._sellGoHome(mc, n, stopRec);
        if (stopRec()) { s.log('warn', 'Auto-sell Spawn: ngắt chuỗi thử lại (bảo vệ lồng/tắt/mất kết nối)'); return { ...res, aborted: true }; }
        res = await s._runSellSpawnCycle();
        if (res.ok) {
          BotActivity.endActivity(s, 'recovery', `Phục hồi bán thành công sau ${n} lần ${cmd}`, { level: 'ok', now: nowMs() });
          s.log('ok', `Auto-sell Spawn: bán được ${res.done}/${res.total} lồng sau khi gõ ${cmd} ${n} lần`);
          return res;
        }
        if (res.aborted || res.skipped) return res;
      }
      BotActivity.endActivity(s, 'recovery', `Phục hồi bán thất bại sau ${max} lần ${cmd}`, { level: 'err', now: nowMs() });
      s._onSellRecoveryFailed(res, max, cmd);
      return res;
    } finally {
      s._sellRecovering = false;
      s._sellRecoveryAttempt = 0;
      s._sellHomeTries = 0;
      BotActivity.endActivity(s, 'recovery');
    }
  }

  async _sellGoHome(mc, n, stop) {
    const s = this.s;
    const cmd = s._sellHomeCmd();
    const minGap = TP.PRESEND_MS + s._tp.deadlineMs + s._tp.settleMs + 1000;
    while (nowMs() < (s._lastSellHomeAt || 0) + minGap) { if (stop()) return false; await sleep(500); }
    try { if (mc.currentWindow) mc.closeWindow(mc.currentWindow); } catch (e) { dbg('BotSession', e); }
    s._tpHoldStill(nowMs());
    await sleep(TP.PRESEND_MS);
    if (stop()) return false;
    try { mc.chat(cmd); } catch (e) { s.log('err', `Lỗi gửi ${cmd}: ${e.message}`); return false; }
    s._lastSellHomeAt = nowMs();
    s._tp.begin({ cmd, pos: mc.entity?.position, now: nowMs() });
    s.log('sys', `Auto-sell Spawn: đã gõ ${cmd} (lần ${n}) — đứng yên chờ teleport ${(s.spawnHomeWarmupMs / 1000).toFixed(0)}s...`);
    const t0 = nowMs();
    const limit = s._tp.deadlineMs + s._tp.settleMs + 2000;
    while (nowMs() - t0 < limit) {
      await sleep(500);
      if (stop()) return false;
      const ev = s._tp.tick(mc.entity?.position, nowMs());
      if (ev) s._onTeleportEvent(ev);
      if (!s._tp.active && !s._tp.frozen(nowMs())) break;
    }
    const first = s.sellSpawnList[0];
    const chunkUntil = nowMs() + s.sellHomeChunkWaitMs;
    while (first && nowMs() < chunkUntil) {
      let b = null;
      try { b = mc.blockAt(s._vec(first)); } catch (e) { dbg('BotSession', e); }
      if (b && s._isSpawnerBlock(b)) break;
      await sleep(250);
      if (stop()) return false;
    }
    await sleep(jit(500, 150));
    return true;
  }

  _onSellRecoveryFailed(res, max, cmd) {
    const s = this.s;
    const id = s.cfg.id;
    const pos = s._fmtXYZ(s.mc?.entity?.position);
    s.log('err', `Auto-sell Spawn: đã gõ ${cmd} ${max} lần mà vẫn không bán được (${res.done}/${res.total} lồng) → báo webhook`);
    const now = nowMs();
    if (now - s._sellFailAlertedAt < s.sellFailAlertMinMs) { s.log('sys', 'Auto-sell Spawn: vừa báo webhook thất bại gần đây — bỏ qua tin trùng'); return; }
    const n = s._manager?.notifier;
    if (!n?.isEventOn('sellFailed') && !s._manager?.telegram?.isEventOn('sellFailed')) { s.log('warn', 'Auto-sell Spawn: chưa cấu hình webhook (webhook set <url>) / Telegram (telegram set <token>) hoặc sự kiện sellFailed đang tắt — không gửi được tin thất bại'); return; }
    s._sellFailAlertedAt = now;
    const tag = Notifier.formatMention(s.sellFailMention);
    const cage = s._describeCageDistance();
    const lines = [
      `Đã gõ ${cmd} ${max} lần, sau mỗi lần đều bán lại nhưng vẫn không xong (${res.done}/${res.total} lồng).`,
      res.reasons.length ? `Lý do lần cuối:\n${res.reasons.slice(0, 5).map(r => `• ${r}`).join('\n')}` : null,
      `📍 Vị trí: ${pos}${cage ? ` — ${cage}` : ''}`,
      `⚙️ Click ô ${s.autoSellSpawnSlot}, ${s.sellSpawnList.length} lồng. Chu kỳ kế tiếp vẫn tự chạy lại.`,
    ].filter(Boolean);
    s._notify('sellFailed', `🚨 ${id}: autosell_spawn thất bại sau ${max} lần gõ ${cmd}`, lines.join('\n'), 0xef4444, `🚨 KHÔNG BÁN ĐƯỢC LỒNG${tag ? ' ' + tag : ''}`);
  }

  configureSellSpawn(o = {}) {
    const s = this.s;
    if (o.slot !== undefined) {
      const n = parseInt(o.slot, 10);
      if (!Number.isInteger(n) || n < 0 || n > 200) return { ok: false, message: 'Slot không hợp lệ (0-200)' };
      s.autoSellSpawnSlot = n;
    }
    if (o.button !== undefined) s.autoSellSpawnButton = Number(o.button) === 1 ? 1 : 0;
    let ivChanged = false;
    for (const [k, f] of [['second', 'Second'], ['minute', 'Minute'], ['hour', 'Hour']]) {
      if (o[k] === undefined) continue;
      const v = Number(o[k]);
      if (!Number.isFinite(v) || v < 0) return { ok: false, message: `Giá trị ${k} không hợp lệ` };
      s['autoSellSpawn' + f] = v;
      ivChanged = true;
    }
    if (o.revenue !== undefined) s.autoSellSpawnRevenue = !!o.revenue;
    if (o.msgKeyword !== undefined) s.autoSellSpawnMsgKeyword = String(o.msgKeyword || '').trim();
    if (o.ignoreChat !== undefined) s.autoSellSpawnIgnoreChat = !!o.ignoreChat;
    if (o.reportMin !== undefined) {
      const v = Number(o.reportMin);
      if (!Number.isFinite(v) || v < 0) return { ok: false, message: 'Khoảng cách báo cáo không hợp lệ (phút, >= 0)' };
      s.autoSellSpawnReportMin = v;
    }
    if (o.range !== undefined) {
      const r = Number(o.range);
      if (!Number.isFinite(r) || r < 1 || r > 6) return { ok: false, message: 'Bán kính quét phải từ 1 đến 6 block' };
      s.autoSellSpawnRange = r;
    }
    s._persistSellSpawnState();
    let message = null;
    if (o.on === true) {
      if (!s._startSellSpawn()) return { ok: true, on: s._sellSpawnOn, message: 'Không bật được — bot offline hoặc chưa có lồng nào trong danh sách' };
    } else if (o.on === false) {
      s._stopSellSpawn();
    } else if (ivChanged && s._sellSpawnOn && !s._sellSpawnBusy) {
      s._scheduleSellSpawn(s._sellSpawnIntervalMs());
    }
    if (ivChanged && s._sellSpawnIntervalMs() === 5000 && (s.autoSellSpawnSecond + s.autoSellSpawnMinute * 60 + s.autoSellSpawnHour * 3600) < 5) message = 'Khoảng thời gian tối thiểu là 5 giây (đã tự nâng lên 5s)';
    return { ok: true, on: s._sellSpawnOn, message };
  }

  getSellSpawnInfo() {
    const s = this.s;
    return {
      on: s._sellSpawnOn, busy: s._sellSpawnBusy, slot: s.autoSellSpawnSlot, button: s.autoSellSpawnButton,
      second: s.autoSellSpawnSecond, minute: s.autoSellSpawnMinute, hour: s.autoSellSpawnHour,
      intervalText: s._fmtDuration(s._sellSpawnIntervalMs()), range: s.autoSellSpawnRange, list: s.sellSpawnList,
      revenue: s.autoSellSpawnRevenue, msgKeyword: s.autoSellSpawnMsgKeyword, ignoreChat: s.autoSellSpawnIgnoreChat, reportMin: s.autoSellSpawnReportMin,
    };
  }
}

module.exports = AutoSellHandler;
