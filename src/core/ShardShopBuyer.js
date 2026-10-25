'use strict';

/**
 * ShardShopBuyer — Macro TPA + Mua lồng trong Shard Shop (/shard).
 *
 * Quy trình (theo thongtin.txt):
 * 1. TPA đến Owner:
 *    Gửi `/tpa <owner>` → chờ GUI xác nhận (slot 16, click chuột phải) → chờ teleport hoàn tất (~5s).
 * 2. Mở Shard Shop:
 *    Gửi `/shard` → chờ GUI shop mở ra.
 * 3. Quét & Lọc GUI (CheckStats KingMC logic):
 *    Lọc bỏ mọi khối kính và kính tấm (glass / stained_glass / glass_pane / stained_glass_pane),
 *    đánh số tuần tự các vật phẩm hợp lệ còn lại [1], [2], ... và hiển thị danh sách.
 * 4. Hỏi người dùng chọn lồng:
 *    Prompt: "> Mua lồng nào? Nhập số (VD: 1, 2, 3...):" → lưu $CHOICE.
 * 4.5. Hỏi người dùng chọn chế độ mua:
 *    Prompt: "> Chế độ mua:
 *             >   [1] Mua 1 lần duy nhất
 *             >   [2] Mua liên tục đến khi có thông báo "bạn cần" (tự dừng)"
 * 5. Thực hiện mua:
 *    - Mode 1: Click slot tương ứng 1 lần rồi dừng.
 *    - Mode 2: Lặp click slot với delay (500ms / 1000ms), đọc chat server và dừng ngay khi thấy
 *              thông báo thiếu ("bạn cần" hoặc "you need").
 */

const EventEmitter = require('events');
const { cleanMinecraftText, componentText, loreFromNbt, cleanLoreLines, isDecorationItem } = require('./StatsReader');
const { dbg } = require('./debug');

// Nhận diện tin nhắn báo dịch chuyển thành công
const TP_DONE_RE = /(?:dịch chuyển|dich chuyen|teleport|tp)\s+thành công|(?:dịch chuyển|dich chuyen|teleport|tp)\s+thanh cong|successfully\s+teleported|teleported\s+(?:to|successfully)|đã\s+(?:dịch chuyển|teleport)\b/i;

// Nhận diện thông báo thiếu tài nguyên/shard
const SHORTAGE_RE = /(?:bạn\s+cần|ban\s+can|you\s+need|không\s+đủ|khong\s+du|bạn\s+còn\s+thiếu|ban\s+con\s+thieu|not\s+enough|insufficient)/i;

/**
 * Loại bỏ dấu tiếng Việt và chuẩn hoá chuỗi để so khớp không dấu
 * @param {string} str
 * @returns {string}
 */
function stripDiacritics(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .trim();
}

/**
 * Kiểm tra xem item có phải là khối kính, kính tấm hoặc vật phẩm trang trí không.
 * @param {object} item - Mineflayer item slot
 * @returns {boolean}
 */
function isGlassOrDecoration(item) {
  if (!item) return true;
  const name = String(item.name || '').toLowerCase();
  if (!name || name === 'air' || name === 'barrier' || name === 'structure_void') return true;

  // Lọc mọi loại kính: glass, glass_pane, stained_glass, stained_glass_pane, tinted_glass...
  if (name.includes('glass') || name.includes('pane')) return true;

  // Nếu là spawner / mob spawner, chắc chắn là vật phẩm hợp lệ trong shop lồng
  if (name.includes('spawner')) return false;

  // Lấy tên hiển thị từ customName, displayName hoặc name
  const rawDisplay = item.customName || item.displayName || item.name || '';
  const displayName = cleanMinecraftText(componentText(rawDisplay));
  if (!displayName) {
    if (name.includes('stained') || isDecorationItem({ name, displayName: '' })) return true;
  }

  // Lọc vật phẩm trang trí theo logic checkstats
  let lore = item.customLore || item.lore || [];
  if (!Array.isArray(lore) && lore) lore = [lore];
  if (isDecorationItem({ name, displayName, lore })) return true;

  return false;
}

/**
 * Quét cửa sổ chest/GUI và lọc bỏ kính, giữ lại các vật phẩm mua được (lồng spawner),
 * đánh số tuần tự [1], [2], ...
 * @param {object} win - Mineflayer Window
 * @returns {Array<{index: number, slot: number, name: string, displayName: string, lore: string[], count: number}>}
 */
function parseShardShopItems(win) {
  if (!win || !win.slots) return [];
  const lim = Number.isInteger(win.inventoryStart) ? win.inventoryStart : win.slots.length;
  const items = [];
  let seq = 1;

  for (let slot = 0; slot < lim; slot++) {
    const it = win.slots[slot];
    if (!it) continue;
    if (isGlassOrDecoration(it)) continue;

    const rawName = componentText(it.customName || it.displayName || it.name || '');
    const displayName = cleanMinecraftText(rawName) || it.name || `Item #${seq}`;
    let lore = [];
    try {
      if (it.customLore) {
        lore = (Array.isArray(it.customLore) ? it.customLore : [it.customLore])
          .map(l => cleanMinecraftText(componentText(l)))
          .filter(Boolean);
      } else {
        lore = cleanLoreLines(loreFromNbt(it.nbt));
      }
    } catch {
      lore = [];
    }

    items.push({
      index: seq++,
      slot,
      name: it.name,
      displayName,
      rawName,
      lore,
      count: it.count || 1,
    });
  }

  return items;
}

/**
 * Định dạng danh sách lồng theo format yêu cầu:
 *   [1] Tên vật phẩm A
 *   [2] Tên vật phẩm B
 * @param {Array<object>} items
 * @returns {string[]}
 */
function formatShopItemList(items) {
  return (items || []).map(i => `[${i.index}] ${i.displayName}`);
}

/**
 * Kiểm tra tin nhắn server có chứa cảnh báo thiếu shard/tiền không ("bạn cần" / "you need").
 * @param {string} text
 * @returns {boolean}
 */
function isShortageMessage(text) {
  if (!text) return false;
  const clean = cleanMinecraftText(text).toLowerCase();
  if (SHORTAGE_RE.test(clean)) return true;
  const normalized = stripDiacritics(clean);
  return SHORTAGE_RE.test(normalized);
}

/**
 * Kiểm tra tin nhắn server có báo dịch chuyển hoàn tất không.
 * @param {string} text
 * @returns {boolean}
 */
function isTeleportSuccessMessage(text) {
  if (!text) return false;
  return TP_DONE_RE.test(cleanMinecraftText(text));
}

class ShardShopBuyer {
  /**
   * @param {import('./BotSession')} session
   */
  constructor(session) {
    this.s = session;
    this.running = false;
    this._stopRequested = false;
    this._stage = 'idle'; // idle | waiting_tpa_gui | teleporting | waiting_shop_gui | selecting | buying
    this.shopItems = [];
    this.selectedItem = null;
    this.mode = null;
    this._pendingPrompt = null;
    this._shortageDetected = false;
    this._shortageReason = '';
    this._stopEmitter = new EventEmitter();
    this._stopEmitter.setMaxListeners(0);
  }

  get stage() { return this._stage; }
  get hasPendingQuestion() { return !!this._pendingPrompt; }
  get pendingQuestion() { return this._pendingPrompt ? this._pendingPrompt.question : null; }

  /** Đang giữ quyền kiểm soát GUI (tránh WindowRouter tự đóng/click) */
  ownsWindows() {
    return this.running && (
      this._stage === 'waiting_tpa_gui' ||
      this._stage === 'waiting_shop_gui' ||
      this._stage === 'selecting' ||
      this._stage === 'buying'
    );
  }

  status() {
    if (!this.running) return 'Đang tắt';
    let extra = '';
    if (this._pendingPrompt) extra = ' (chờ trả lời)';
    else if (this.selectedItem) extra = ` (${this.selectedItem.displayName})`;
    return `Đang chạy [${this._stage}]${extra}`;
  }

  /**
   * Trả lời câu hỏi đang chờ prompt. Cho phép dừng/huỷ trực tiếp qua lệnh hoặc từ khoá dừng.
   * @param {string} text
   * @returns {boolean}
   */
  answer(text) {
    if (!this._pendingPrompt) return false;
    const raw = String(text ?? '').trim().toLowerCase();
    const norm = stripDiacritics(raw);
    if (
      raw === 'stop' || raw === 'cancel' || raw === 'quit' || raw === 'exit' ||
      raw === 'buyspawner stop' || raw === 'stopmacro' ||
      norm === 'huy' || norm === 'dung' || norm === 'dung lai'
    ) {
      this.s.log('sys', '[Shard Shop] Người dùng huỷ/dừng macro tại bước chọn.');
      this.stop();
      return true;
    }
    const p = this._pendingPrompt;
    return p.resolve(String(text ?? ''));
  }

  /** Dừng macro */
  stop() {
    if (!this.running && !this._pendingPrompt) return false;
    this._stopRequested = true;
    this._stopEmitter.emit('stop');
    this.running = false;
    this._stage = 'idle';
    this._pendingPrompt = null;
    try {
      const w = this.s.mc?.currentWindow;
      if (w) this.s.mc.closeWindow(w);
    } catch (e) {
      dbg('ShardShopBuyer', e);
    }
    this.s.log('sys', '[Shard Shop] Macro mua lồng đã dừng.');
    return true;
  }

  /**
   * Ghi nhận tin nhắn chat từ server để phát hiện shortage warning hoặc hoàn tất teleport.
   * @param {string} text
   */
  onMessage(text) {
    if (!this.running) return;
    if (this._stage === 'teleporting' && isTeleportSuccessMessage(text)) {
      this._stopEmitter.emit('teleported');
    }
    if (isShortageMessage(text)) {
      this._shortageDetected = true;
      this._shortageReason = cleanMinecraftText(text);
      if (this._stage === 'buying') {
        this._stopEmitter.emit('shortage');
      }
    }
  }

  /**
   * Bắt đầu quy trình TPA + Mua lồng.
   * @param {object} [opts]
   * @param {string} [opts.owner]
   * @param {number|string} [opts.choice]
   * @param {number|string} [opts.mode]
   * @param {boolean} [opts.skipTpa]
   * @returns {Promise<boolean>}
   */
  async start(opts = {}) {
    if (this.running) {
      this.s.log('warn', '[Shard Shop] Macro đang chạy dở — gõ "buyspawner stop" để dừng trước');
      return false;
    }
    if (!this.s.isOnline) {
      this.s.log('warn', '[Shard Shop] Bot chưa online — không thể chạy macro');
      return false;
    }

    this.running = true;
    this._stopRequested = false;
    this._shortageDetected = false;
    this._shortageReason = '';
    this.shopItems = [];
    this.selectedItem = null;
    this.mode = null;

    try {
      // ═══════════════════════════════════════════════════════════════════
      // BƯỚC 1: TPA ĐẾN OWNER
      // ═══════════════════════════════════════════════════════════════════
      if (!opts.skipTpa) {
        const owner = String(opts.owner || this.s.cfg?.ownerUsername || '').trim();
        if (!owner) {
          this.s.log('warn', '[Shard Shop] Chưa đặt tên owner (ownerUsername) trong config');
          this.stop();
          return false;
        }

        this._stage = 'waiting_tpa_gui';
        // Đóng cửa sổ cũ nếu còn
        try {
          const curr = this.s.mc?.currentWindow;
          if (curr) this.s.mc.closeWindow(curr);
        } catch {}

        this.s.log('sys', `[Shard Shop] BƯỚC 1: Gửi /tpa ${owner}`);
        this.s.mc.chat(`/tpa ${owner}`);

        // Chờ GUI xác nhận TPA (slot 16)
        this.s.log('sys', '[Shard Shop] Chờ GUI xác nhận TPA (tối đa 10s)...');
        const tpaWin = await this._waitForWindow(10000);
        if (this._stopRequested || !this.s.isOnline) return false;

        if (tpaWin) {
          await this._sleep(1000);
          if (this._stopRequested || !this.s.isOnline) return false;

          try {
            if (this.s.mc?.currentWindow) {
              this.s.mc.clickWindow(16, 1, 0);
              this.s.log('ok', '[Shard Shop] Đã click slot 16 (đồng ý TPA)');
            }
          } catch (e) {
            this.s.log('warn', '[Shard Shop] Lỗi click TPA slot 16: ' + e.message);
          }
        } else {
          this.s.log('warn', '[Shard Shop] Không thấy GUI xác nhận TPA (có thể server tự chấp nhận hoặc lệnh đã gửi)');
        }

        // Chờ bot dịch chuyển xong hoàn toàn (delay 5000ms hoặc chat thành công)
        this._stage = 'teleporting';
        this.s.log('sys', '[Shard Shop] Chờ dịch chuyển hoàn tất (~5s)...');
        await this._waitForTeleport(5000);
        if (this._stopRequested || !this.s.isOnline) return false;
        this.s.log('ok', '[Shard Shop] Dịch chuyển hoàn tất');
      }

      // ═══════════════════════════════════════════════════════════════════
      // BƯỚC 2: MỞ SHARD SHOP
      // ═══════════════════════════════════════════════════════════════════
      this._stage = 'waiting_shop_gui';
      this.s.log('sys', '[Shard Shop] BƯỚC 2: Gửi lệnh /shard');
      
      // Đóng cửa sổ cũ nếu còn
      try {
        const curr = this.s.mc?.currentWindow;
        if (curr) this.s.mc.closeWindow(curr);
      } catch {}

      this.s.mc.chat('/shard');

      const shopWin = await this._waitForWindow(10000);
      if (this._stopRequested || !this.s.isOnline) return false;
      if (!shopWin) {
        this.s.log('warn', '[Shard Shop] Không mở được GUI /shard sau 10s');
        this.stop();
        return false;
      }

      // Đợi nạp slot
      await this._sleep(400);
      if (this._stopRequested || !this.s.isOnline) return false;

      // ═══════════════════════════════════════════════════════════════════
      // BƯỚC 3: CHECKSTATS GUI - ĐỌC & LỌC VẬT PHẨM
      // ═══════════════════════════════════════════════════════════════════
      this._stage = 'selecting';
      let items = parseShardShopItems(shopWin);
      if (!items.length) {
        // Đợi thêm 500ms phòng trường hợp gói items đến trễ
        await this._sleep(500);
        items = parseShardShopItems(shopWin);
      }
      if (!items.length) {
        this.s.log('warn', '[Shard Shop] Không tìm thấy vật phẩm/lồng hợp lệ trong GUI');
        this.stop();
        return false;
      }

      this.shopItems = items;
      this.s.log('sys', '[Shard Shop] BƯỚC 3: Danh sách vật phẩm Shard Shop:');
      for (const line of formatShopItemList(items)) {
        this.s.log('sys', `  ${line}`);
      }

      // ═══════════════════════════════════════════════════════════════════
      // BƯỚC 4: HỎI NGƯỜI DÙNG CHỌN LỒNG ($CHOICE)
      // ═══════════════════════════════════════════════════════════════════
      let pickedItem = null;
      if (opts.choice !== undefined && opts.choice !== null) {
        const cleanChoice = String(opts.choice).replace(/^[\[#(\s]+|[\])\s]+$/g, '');
        const parsedIdx = parseInt(cleanChoice, 10);
        const searchRaw = String(opts.choice).toLowerCase().trim();
        const searchNorm = stripDiacritics(searchRaw);
        pickedItem = items.find(i => {
          if (Number.isInteger(parsedIdx) && i.index === parsedIdx) return true;
          const nameRaw = cleanMinecraftText(i.displayName).toLowerCase();
          const nameNorm = stripDiacritics(nameRaw);
          return nameRaw.includes(searchRaw) || (searchNorm && nameNorm.includes(searchNorm));
        });
      }

      if (!pickedItem) {
        const prompt1 = '> Mua lồng nào? Nhập số (VD: 1, 2, 3...):';
        const ans = await this._ask(prompt1, (val) => {
          const cleaned = String(val).replace(/^[\[#(\s]+|[\])\s]+$/g, '');
          const num = parseInt(cleaned, 10);
          const found = items.find(i => i.index === num);
          if (found) return found;
          // Hỗ trợ tìm kiếm theo tên (có dấu lẫn không dấu)
          const searchRaw = String(val).toLowerCase().trim();
          const searchNorm = stripDiacritics(searchRaw);
          const byName = items.find(i => {
            const nameRaw = cleanMinecraftText(i.displayName).toLowerCase();
            const nameNorm = stripDiacritics(nameRaw);
            return nameRaw.includes(searchRaw) || (searchNorm && nameNorm.includes(searchNorm));
          });
          return byName || null;
        });

        if (this._stopRequested || !ans) {
          this.s.log('warn', '[Shard Shop] Huỷ chọn lồng');
          this.stop();
          return false;
        }
        pickedItem = ans;
      }

      this.selectedItem = pickedItem;
      this.s.log('ok', `[Shard Shop] Đã chọn: [${pickedItem.index}] ${pickedItem.displayName} (slot ${pickedItem.slot})`);

      // ═══════════════════════════════════════════════════════════════════
      // BƯỚC 4.5: HỎI NGƯỜI DÙNG CHỌN CHẾ ĐỘ MUA ($MODE)
      // ═══════════════════════════════════════════════════════════════════
      let pickedMode = null;
      if (opts.mode !== undefined && opts.mode !== null) {
        const cleanedMode = String(opts.mode).replace(/^[\[#(\s]+|[\])\s]+$/g, '');
        const m = parseInt(cleanedMode, 10);
        if (m === 1 || m === 2) pickedMode = m;
      }

      if (!pickedMode) {
        const prompt2 = [
          '> Chế độ mua:',
          '>   [1] Mua 1 lần duy nhất',
          '>   [2] Mua liên tục đến khi có thông báo "bạn cần" (tự dừng)',
        ];
        const ansMode = await this._ask(prompt2, (val) => {
          const v = String(val).trim().toLowerCase();
          const vNorm = stripDiacritics(v);
          if (v === '1' || vNorm.includes('1') || vNorm.includes('duy nhat') || vNorm.includes('mot lan') || vNorm.includes('don')) return 1;
          if (v === '2' || vNorm.includes('2') || vNorm.includes('lien tuc') || vNorm.includes('lap')) return 2;
          return null;
        });

        if (this._stopRequested || !ansMode) {
          this.s.log('warn', '[Shard Shop] Huỷ chọn chế độ mua');
          this.stop();
          return false;
        }
        pickedMode = ansMode;
      }

      this.mode = pickedMode;
      this.s.log('ok', `[Shard Shop] Chế độ: [${pickedMode}] ${pickedMode === 1 ? 'Mua 1 lần duy nhất' : 'Mua liên tục đến khi hết Shard'}`);

      // ═══════════════════════════════════════════════════════════════════
      // BƯỚC 5: CLICK MUA
      // ═══════════════════════════════════════════════════════════════════
      this._stage = 'buying';

      if (pickedMode === 1) {
        // BƯỚC 5A: Mua 1 lần
        this.s.log('sys', `[Shard Shop] BƯỚC 5A: Click mua slot ${pickedItem.slot} (chuột phải)`);
        try {
          this.s.mc.clickWindow(pickedItem.slot, 1, 0);
          await this._sleep(500);
          this.s.log('ok', `[Shard Shop] Đã mua thành công 1 lần: ${pickedItem.displayName}`);
        } catch (e) {
          this.s.log('err', '[Shard Shop] Lỗi click mua: ' + e.message);
        }
      } else {
        // BƯỚC 5B: Mua liên tục (Mode 2)
        this.s.log('sys', `[Shard Shop] BƯỚC 5B: Bắt đầu mua liên tục ô ${pickedItem.slot} (chuột phải)...`);
        let loopCount = 0;
        const maxLoops = 500;

        while (!this._stopRequested && this.s.isOnline && loopCount < maxLoops) {
          // Kiểm tra chat gần đây trước khi click
          if (this._shortageDetected || this._checkRecentChatShortage()) {
            this.s.log('warn', `[Shard Shop] Phát hiện thông báo thiếu shard ("${this._shortageReason || 'bạn cần'}") — tự dừng.`);
            break;
          }

          if (!this.s.mc?.currentWindow) {
            this.s.log('warn', '[Shard Shop] Cửa sổ GUI đã đóng — dừng mua.');
            break;
          }

          try {
            this.s.mc.clickWindow(pickedItem.slot, 1, 0);
            loopCount++;
            this.s.log('sys', `[Shard Shop] Lượt ${loopCount}: Đã click mua [${pickedItem.index}] ${pickedItem.displayName}`);
          } catch (e) {
            this.s.log('err', '[Shard Shop] Lỗi clickWindow: ' + e.message);
            break;
          }

          await this._sleep(500);
          if (this._stopRequested || !this.s.isOnline) break;

          // Kiểm tra chat sau delay 500ms
          if (this._shortageDetected || this._checkRecentChatShortage()) {
            this.s.log('warn', `[Shard Shop] Phát hiện thông báo thiếu shard ("${this._shortageReason || 'bạn cần'}") — tự dừng.`);
            break;
          }

          await this._sleep(1000);
          if (this._stopRequested || !this.s.isOnline) break;
        }

        if (loopCount >= maxLoops) {
          this.s.log('warn', `[Shard Shop] Đã đạt giới hạn tối đa ${maxLoops} lượt — dừng`);
        }
        this.s.log('ok', `[Shard Shop] Hoàn tất vòng mua liên tục (${loopCount} lượt).`);
      }

      // Đóng cửa sổ GUI sau khi mua xong
      try {
        const curr = this.s.mc?.currentWindow;
        if (curr) this.s.mc.closeWindow(curr);
      } catch {}

      this.running = false;
      this._stage = 'idle';
      return true;
    } catch (err) {
      this.s.log('err', '[Shard Shop] Lỗi macro: ' + err.message);
      this.stop();
      return false;
    }
  }

  // ── PRIVATE HELPERS ──

  _checkRecentChatShortage(windowMs = 5000, maxScan = 10) {
    if (this._shortageDetected) return true;
    const logs = typeof this.s.getLogs === 'function' ? this.s.getLogs() : [];
    const cutoff = Date.now() - windowMs;
    let scanned = 0;
    for (let i = logs.length - 1; i >= 0 && scanned < maxScan; i--) {
      if (logs[i].level !== 'chat' && logs[i].level !== 'hud') continue;
      scanned++;
      if (logs[i].time && logs[i].time < cutoff) break;
      if (isShortageMessage(logs[i].msg)) {
        this._shortageDetected = true;
        this._shortageReason = logs[i].msg;
        return true;
      }
    }
    return false;
  }

  _waitForWindow(timeoutMs = 10000) {
    return new Promise((resolve) => {
      let done = false;
      const mc = this.s.mc;
      if (!mc) return resolve(null);
      let timer = null;

      const finish = (win) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        mc.removeListener('windowOpen', onOpen);
        this._stopEmitter.removeListener('stop', onStop);
        if (win && mc && !mc.currentWindow) mc.currentWindow = win;
        resolve(win);
      };

      const onOpen = (win) => finish(win);
      const onStop = () => finish(null);

      this._stopEmitter.once('stop', onStop);
      mc.once('windowOpen', onOpen);

      timer = setTimeout(() => {
        finish(null);
      }, timeoutMs);
    });
  }

  _waitForTeleport(waitMs = 5000) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const mc = this.s.mc;

      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._stopEmitter.removeListener('stop', onStop);
        this._stopEmitter.removeListener('teleported', onTeleported);
        if (mc) mc.removeListener('forcedMove', onForcedMove);
        resolve();
      };

      const onStop = () => finish();
      const onTeleported = () => finish();
      const onForcedMove = () => finish();

      this._stopEmitter.once('stop', onStop);
      this._stopEmitter.once('teleported', onTeleported);
      if (mc) mc.once('forcedMove', onForcedMove);

      timer = setTimeout(() => {
        finish();
      }, waitMs);
    });
  }

  _ask(promptText, validator, timeoutMs = 120000) {
    const lines = Array.isArray(promptText) ? promptText : [promptText];
    for (const l of lines) {
      this.s.log('sys', l);
    }
    this.s.log('sys', `→ Trả lời bằng lệnh: answer <nội dung>  (vd: cmd ${this.s.cfg?.id || ''} answer 1)`);

    if (typeof this.s.manager?.cliAsk === 'function') {
      this.s.manager.cliAsk(lines.join('\n'));
    }

    return new Promise((resolve) => {
      let timer = null;
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._stopEmitter.removeListener('stop', onStop);
        this._pendingPrompt = null;
        resolve(result);
      };

      const onStop = () => finish(null);
      this._stopEmitter.once('stop', onStop);

      timer = setTimeout(() => {
        this.s.log('warn', `[Shard Shop] Hết thời gian chờ trả lời (${Math.round(timeoutMs / 1000)}s) — dừng`);
        finish(null);
      }, timeoutMs);

      this._pendingPrompt = {
        question: lines.join('\n'),
        resolve: (input) => {
          const text = String(input ?? '').trim();
          const parsed = validator ? validator(text) : text;
          if (parsed === null || parsed === undefined) {
            this.s.log('warn', `[Shard Shop] Lựa chọn "${text}" không hợp lệ — vui lòng chọn lại`);
            return false;
          }
          finish(parsed);
          return true;
        },
      };
    });
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      let timer = null;
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        this._stopEmitter.removeListener('stop', onStop);
        this._stopEmitter.removeListener('shortage', onShortage);
        resolve();
      };

      const onStop = () => finish();
      const onShortage = () => finish();
      this._stopEmitter.once('stop', onStop);
      this._stopEmitter.once('shortage', onShortage);

      timer = setTimeout(finish, ms);
    });
  }
}

module.exports = ShardShopBuyer;
module.exports.ShardShopBuyer = ShardShopBuyer;
Object.assign(module.exports, {
  isGlassOrDecoration,
  parseShardShopItems,
  formatShopItemList,
  isShortageMessage,
  isTeleportSuccessMessage,
  stripDiacritics,
  TP_DONE_RE,
  SHORTAGE_RE,
});
