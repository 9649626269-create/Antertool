'use strict';
/**
 * AutoSellHandler — tách logic auto-sell spawn, revenue capture, recovery từ BotSession.
 * Hiện tại giữ reference session; các method chính vẫn nằm trên BotSession và gọi qua đây
 * để giảm kích thước class dần dần. Các method private (_beginSellCapture, _extractSellAmount...)
 * sẽ được chuyển sang đây ở bước tiếp theo.
 */
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

  // TODO: chuyển toàn bộ body của _startSellSpawn, _sellFail, _recoverSell, _faceBlock (sell path)
  // từ BotSession sang đây ở lần refactor tiếp theo.
}

module.exports = AutoSellHandler;
