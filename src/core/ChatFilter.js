'use strict';
const { findSender } = require('./BeggarGuard');

/**
 * ChatFilter — Bộ lọc chống lặp và phân loại tin nhắn chat khi chạy nhiều bot trên cùng server.
 *
 * Giải quyết 2 vấn đề chính khi chạy dàn nhiều bot:
 *   1. Lặp liên bot (Cross-bot duplicate): 1 thông báo của server hoặc 1 câu chat của người chơi
 *      được gửi tới tất cả các bot cùng lúc -> chỉ hiển thị 1 lần duy nhất trong cửa sổ thời gian ngắn.
 *   2. Lặp thông báo tự động của server (Server Auto-Broadcast / Tips): Server phát đi phát lại
 *      các câu nhắc nhở/quảng cáo (như "Chơi server dưới 180 phút...", "Để có rank plus và key...",
 *      "Ai là newbie thì dùng lệnh /commands...", "Xin lưu ý: giá bán item...") -> chỉ hiện 1 lần,
 *      tự động ẩn các lần phát lại trong khoảng broadcastCooldownMs (mặc định 30 phút).
 *
 * Chế độ (mode):
 *   - 'smart'  (mặc định): Lọc trùng liên bot + ẩn thông báo server lặp lại.
 *   - 'player' (nobroadcast): Ẩn toàn bộ thông báo chung của server, chỉ hiện chat người chơi & phản hồi lệnh/giao dịch của bot.
 *   - 'all':   Hiện tất cả tin nhắn thô của từng bot (không lọc trùng).
 */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MC_COLOR_RE = /[§§][0-9a-fk-or]/gi;

// Các mẫu nhận diện chắc chắn là thông báo tự động / nhắc nhở chung của server (Broadcast / Tip)
const BROADCAST_HINT_RE = new RegExp([
  '^\\s*(?:\\[\\s*(?:thong bao|server|he thong|tip|auto|quang cao|nhac nho)\\s*\\]|xin luu y\\b)',
  '\\b(?:dung lenh\\s+\\/[a-z0-9_]+\\s+de|ai la newbie thi dung lenh|de co rank\\b.*dung lenh)\\b',
  '\\b(?:choi server duoi \\d+ phut|dam bao suc khoe|can bang server tranh lam phat)\\b',
  '\\b(?:tu do xay dung,\\s*tu do pvp|tuan thu luat|tham gia discord|nap the tai)\\b',
].join('|'), 'i');

// Các mẫu nhận diện phản hồi hành động / giao dịch / lệnh trực tiếp của riêng bot
// (chỉ lọc trùng ngắn hạn 2.5s giữa các bot khi dùng cmdall, KHÔNG ẩn dài hạn như broadcast)
const ACTION_RE = new RegExp([
  '^\\[(?:Title|Subtitle|ActionBar)\\]',
  '\\+\\s*\\$|\\$\\s*\\d',
  '\\b(?:ban da ban|da ban thanh cong|ban da giao|ban da mua|nhan duoc|so du|balance)\\b',
  '\\b(?:dich chuyen thanh cong|dang dich chuyen|huy dich chuyen|yeu cau dich chuyen|gui yeu cau tpa|dong y tpa)\\b',
  '\\b(?:dang nhap thanh cong|vui long dang nhap|sai mat khau|xac minh thanh cong)\\b',
  '\\b(?:ban nhap sai lenh|sai cu phap|khong co quyen|khong du tien|khong du|het hang|het tien|cooldown|vui long cho)\\b',
].join('|'), 'i');

function stripFormatting(s) {
  return String(s || '').replace(ANSI_RE, '').replace(MC_COLOR_RE, '').replace(/\s+/g, ' ').trim();
}

function normNoAccent(s) {
  return stripFormatting(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
}

class ChatFilter {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.mode = opts.mode || 'smart'; // 'smart' | 'player' | 'all'
    this.crossBotWindowMs = opts.crossBotWindowMs ?? 4500;       // 4.5s chống lặp cùng 1 tin giữa nhiều bot
    this.actionWindowMs = opts.actionWindowMs ?? 2500;           // 2.5s chống lặp phản hồi lệnh khi gõ cmdall
    this.broadcastCooldownMs = opts.broadcastCooldownMs ?? 30 * 60 * 1000; // 30 phút ẩn thông báo tự động lặp lại của server
    this._recentCross = new Map();     // normKey -> { time, botId, count }
    this._seenBroadcasts = new Map();  // normKey -> { firstAt, lastAt, count }
    this.stats = { shown: 0, dedupCrossBot: 0, dedupBroadcast: 0 };
  }

  setMode(mode) {
    const m = String(mode || '').toLowerCase().trim();
    if (m === 'smart' || m === 'dedup') { this.enabled = true; this.mode = 'smart'; return true; }
    if (m === 'player' || m === 'nobroadcast' || m === 'players') { this.enabled = true; this.mode = 'player'; return true; }
    if (m === 'all' || m === 'raw') { this.enabled = true; this.mode = 'all'; return true; }
    if (m === 'on') { this.enabled = true; return true; }
    if (m === 'off') { this.enabled = false; return true; }
    return false;
  }

  reset() {
    this._recentCross.clear();
    this._seenBroadcasts.clear();
  }

  /**
   * Phân loại 1 dòng chat:
   *   - kind: 'player' | 'action' | 'broadcast'
   *   - sender, content (nếu là 'player')
   */
  classify(rawMsg, onlinePlayers = []) {
    const clean = stripFormatting(rawMsg);
    if (!clean) return { kind: 'empty', clean: '' };

    // 1. Dạng chuẩn "<Tên> nội dung"
    const angleMatch = /^<\s*([^>]{2,20}?)\s*>\s*(.+)$/s.exec(clean);
    if (angleMatch) {
      return { kind: 'player', sender: angleMatch[1].trim(), content: angleMatch[2].trim(), clean };
    }

    // 2. Dạng server custom ("[Rank] Tên » nội dung" hoặc "Tên: nội dung") khớp với người chơi đang online
    if (onlinePlayers && onlinePlayers.length) {
      const snd = findSender(clean, onlinePlayers);
      if (snd && snd.name && snd.body && snd.body.trim()) {
        return { kind: 'player', sender: snd.name, content: snd.body.trim(), clean };
      }
    }

    const noAccent = normNoAccent(clean);
    // 3. Nếu khớp mẫu thông báo chung/nhắc nhở của server -> ưu tiên phân loại là 'broadcast'
    if (BROADCAST_HINT_RE.test(noAccent)) {
      return { kind: 'broadcast', clean };
    }

    // 4. Tin nhắn phản hồi hành động / giao dịch / lệnh trực tiếp của bot
    if (ACTION_RE.test(clean) || ACTION_RE.test(noAccent)) {
      return { kind: 'action', clean };
    }

    // 5. Còn lại là thông báo chung / broadcast từ server
    return { kind: 'broadcast', clean };
  }

  /**
   * Quyết định có hiển thị dòng chat này ra console hay không.
   * Trả về:
   *   { show: boolean, kind: 'player'|'action'|'broadcast', sender?: string, content?: string, isServerWide?: boolean, reason?: string }
   */
  decide(botId, rawMsg, { time = Date.now(), onlinePlayers = [], onlineBotCount = 1 } = {}) {
    if (!this.enabled) return { show: false, reason: 'disabled' };
    const info = this.classify(rawMsg, onlinePlayers);
    if (info.kind === 'empty') return { show: false, reason: 'empty' };

    if (this.mode === 'all') {
      this.stats.shown++;
      return { show: true, ...info, isServerWide: false };
    }

    // Chế độ 'player': ẩn toàn bộ thông báo broadcast của server
    if (this.mode === 'player' && info.kind === 'broadcast') {
      this.stats.dedupBroadcast++;
      return { show: false, ...info, reason: 'player-only-mode' };
    }

    const key = info.kind === 'player'
      ? `p:${info.sender.toLowerCase()}:${info.content}`
      : `${info.kind}:${info.clean}`;

    // Dọn bộ nhớ tạm nếu quá lớn
    if (this._recentCross.size > 400) {
      for (const [k, v] of this._recentCross) {
        if (time - v.time > this.crossBotWindowMs * 2) this._recentCross.delete(k);
      }
    }

    // 1. Kiểm tra lặp ngắn hạn (nhiều bot cùng nhận 1 tin hoặc server vừa gửi tức thì)
    const crossWindow = info.kind === 'action' ? this.actionWindowMs : this.crossBotWindowMs;
    const prevCross = this._recentCross.get(key);
    if (prevCross && (time - prevCross.time) >= 0 && (time - prevCross.time) <= crossWindow) {
      // Nếu từ bot khác gửi lên cùng 1 tin trong cửa sổ ngắn -> chắc chắn là tin chung bị lặp giữa các bot
      // Hoặc cùng 1 bot bị server spam đúp trong < 1.5s
      if (prevCross.botId !== botId || (time - prevCross.time) < 1500) {
        prevCross.count++;
        this.stats.dedupCrossBot++;
        return { show: false, ...info, reason: 'cross-bot-duplicate' };
      }
    }
    this._recentCross.set(key, { time, botId, count: 1 });

    // 2. Kiểm tra thông báo tự động của server lặp đi lặp lại theo chu kỳ (broadcast)
    if (info.kind === 'broadcast') {
      if (this._seenBroadcasts.size > 400) {
        for (const [k, v] of this._seenBroadcasts) {
          if (time - v.lastAt > this.broadcastCooldownMs) this._seenBroadcasts.delete(k);
        }
      }
      const prevB = this._seenBroadcasts.get(info.clean);
      if (prevB && (time - prevB.lastAt) >= 0 && (time - prevB.lastAt) <= this.broadcastCooldownMs) {
        prevB.lastAt = time;
        prevB.count++;
        this.stats.dedupBroadcast++;
        return { show: false, ...info, reason: 'repeated-broadcast' };
      }
      this._seenBroadcasts.set(info.clean, { firstAt: time, lastAt: time, count: 1 });
    }

    this.stats.shown++;
    return {
      show: true,
      ...info,
      isServerWide: info.kind === 'broadcast' && onlineBotCount > 1,
    };
  }

  statusText() {
    const modeLabel = this.mode === 'smart'
      ? 'SMART (gộp tin trùng nhiều bot + ẩn broadcast lặp lại)'
      : (this.mode === 'player' ? 'PLAYER (chỉ hiện chat người chơi & phản hồi lệnh, ẩn broadcast server)' : 'ALL (hiện tất cả không lọc)');
    return `Chat hiển thị: ${this.enabled ? 'BẬT' : 'TẮT'} · chế độ: ${modeLabel} · đã hiện ${this.stats.shown}, đã chặn ${this.stats.dedupCrossBot} tin trùng giữa các bot & ${this.stats.dedupBroadcast} thông báo server lặp`;
  }
}

module.exports = ChatFilter;