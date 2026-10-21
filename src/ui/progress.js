'use strict';

/**
 * Progress indicators: Spinner and ProgressBar.
 * - Spinner: interactive terminals only, starts after ~300ms if task is still running,
 *   throttled to 10 redraws/sec, cleans up and restores cursor on stop/success/failure.
 * - ProgressBar: only when measurable progress with a known total > 0 exists; shows real n/total.
 */

const { truncate, sanitizeUntrusted } = require('./text');

/**
 * Pure function to render a progress bar string from real current/total numbers.
 * Returns null if total is not a known positive number.
 */
function renderProgressBar(current, total, opts = {}, caps = null, theme = null) {
  const tot = Number(total);
  if (!Number.isFinite(tot) || tot <= 0) return null;
  const cur = Math.max(0, Math.min(tot, Number(current) || 0));
  const width = Math.max(4, Math.min(30, Number(opts.width) || 12));
  const filled = Math.round((cur / tot) * width);
  const empty = Math.max(0, width - filled);

  const sym = (caps && caps.symbols) || { barFull: '#', barEmpty: '-' };
  const fullStr = sym.barFull.repeat(filled);
  const emptyStr = sym.barEmpty.repeat(empty);
  const barInner = theme
    ? `${theme.info(fullStr)}${theme.muted(emptyStr)}`
    : `${fullStr}${emptyStr}`;
  const label = opts.unit ? `${cur}/${tot} ${opts.unit}` : `${cur}/${tot}`;
  return `[${barInner}] ${theme ? theme.key(label) : label}`;
}

class Spinner {
  constructor(options = {}) {
    this.writer = options.writer;
    this.caps = options.caps || (this.writer && this.writer.caps);
    this.theme = options.theme || (this.writer && this.writer.theme);
    this.delayMs = options.delayMs !== undefined ? options.delayMs : 300;
    this.intervalMs = options.intervalMs !== undefined ? Math.max(80, options.intervalMs) : 100; // ~10 fps
    this.text = '';
    this._active = false;
    this._delayTimer = null;
    this._tickTimer = null;
    this._frameIdx = 0;
  }

  get isActive() {
    return this._active;
  }

  start(text) {
    this.text = sanitizeUntrusted(text || '');
    if (this._active) {
      this._render();
      return this;
    }
    this._active = true;
    this._frameIdx = 0;

    if (!this.caps || !this.caps.interactive) {
      // Non-interactive: no spinner animation; caller or logger prints start/end lines
      return this;
    }

    this._delayTimer = setTimeout(() => {
      this._delayTimer = null;
      if (!this._active) return;
      this._render();
      this._tickTimer = setInterval(() => {
        if (!this._active) return;
        this._frameIdx++;
        this._render();
      }, this.intervalMs);
      if (this._tickTimer.unref) this._tickTimer.unref();
    }, this.delayMs);
    if (this._delayTimer.unref) this._delayTimer.unref();

    return this;
  }

  update(text) {
    this.text = sanitizeUntrusted(text || '');
    if (this._active && !this._delayTimer) {
      this._render();
    }
    return this;
  }

  _render() {
    if (!this._active || !this.writer || !this.caps || !this.caps.interactive) return;
    const frames = (this.caps.symbols && this.caps.symbols.spinner) || ['-', '\\', '|', '/'];
    const frame = frames[this._frameIdx % frames.length];
    const maxW = Math.max(20, (this.caps.width || 80) - 2);
    const prefix = this.theme ? this.theme.info(frame) : frame;
    const line = truncate(`  ${prefix} ${this.text}`, maxW, { ascii: !this.caps.unicode });
    this.writer.setEphemeral(line);
  }

  stop() {
    if (this._delayTimer) {
      clearTimeout(this._delayTimer);
      this._delayTimer = null;
    }
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    const wasActive = this._active;
    this._active = false;
    if (wasActive && this.writer) {
      this.writer.clearEphemeral();
    }
    return this;
  }
}

module.exports = {
  renderProgressBar,
  Spinner,
};
