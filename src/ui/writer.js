'use strict';

/**
 * Centralized OutputWriter: the ONLY code that writes to the terminal.
 * Coordinates logs, spinners, progress bars, live dashboard views, and readline prompts
 * so they never interleave, corrupt the input prompt, or leave the cursor hidden.
 */

const { stripAnsi } = require('./text');
const { CODES } = require('./theme');

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K\r';
const ORIG_CONSOLE_LOG = console.log;

class OutputWriter {
  constructor(options = {}) {
    this.caps = options.caps;
    this.theme = options.theme;
    this.stream = options.stream !== undefined ? options.stream : process.stdout;
    this.errStream = options.errStream !== undefined ? options.errStream : process.stderr;
    this.rl = options.rl || null;
    this._ephemeralLine = '';      // Single-line spinner / progress / running step
    this._liveBlockLines = 0;      // Multi-line live dashboard height currently on screen
    this._liveBlockText = '';
    this._cursorHidden = false;
    this._cleanupRegistered = false;

    if (options.registerCleanup !== false) {
      this._registerCleanup();
    }
  }

  setReadline(rl) {
    this.rl = rl || null;
  }

  _isInteractive() {
    return Boolean(this.caps && this.caps.interactive && this.stream && this.stream.isTTY);
  }

  _formatForOutput(line) {
    const s = String(line ?? '');
    if (!this.caps || !this.caps.color) {
      return stripAnsi(s);
    }
    if (s.includes('\x1b[') && !s.endsWith(CODES.reset)) {
      return `${s}${CODES.reset}`;
    }
    return s;
  }

  hideCursor() {
    if (!this._isInteractive() || this._cursorHidden) return;
    this._cursorHidden = true;
    try { this.stream.write(HIDE_CURSOR); } catch { /* ignore */ }
  }

  showCursor() {
    if (!this._cursorHidden) return;
    this._cursorHidden = false;
    if (this.stream && this.stream.isTTY) {
      try { this.stream.write(SHOW_CURSOR); } catch { /* ignore */ }
    }
  }

  restoreTerminal() {
    this.clearEphemeral();
    this._liveBlockLines = 0;
    this._liveBlockText = '';
    this.showCursor();
    if (this.caps && this.caps.color && this.stream && this.stream.isTTY) {
      try { this.stream.write(CODES.reset); } catch { /* ignore */ }
    }
  }

  _registerCleanup() {
    if (this._cleanupRegistered) return;
    this._cleanupRegistered = true;
    this._onExit = () => this.restoreTerminal();
    process.on('exit', this._onExit);
  }

  destroy() {
    this.restoreTerminal();
    if (this._onExit) {
      process.removeListener('exit', this._onExit);
      this._onExit = null;
    }
    this._cleanupRegistered = false;
  }

  /**
   * Clear any ephemeral spinner/progress line or live block before printing permanent output.
   */
  _clearActiveOverlays() {
    if (!this._isInteractive()) return;

    if (this._ephemeralLine) {
      try { this.stream.write(CLEAR_LINE); } catch { /* ignore */ }
    }

    if (this._liveBlockLines > 0) {
      try {
        let seq = '\r';
        for (let i = 0; i < this._liveBlockLines; i++) {
          seq += '\x1b[2K';
          if (i < this._liveBlockLines - 1) seq += '\x1b[1A';
        }
        seq += '\r';
        this.stream.write(seq);
      } catch { /* ignore */ }
    }

    if (this.rl) {
      try {
        this.stream.write(CLEAR_LINE);
      } catch { /* ignore */ }
    }
  }

  /**
   * Redraw active overlays (ephemeral line, live dashboard, or readline prompt) after printing permanent output.
   */
  _restoreActiveOverlays() {
    if (!this._isInteractive()) return;

    if (this._liveBlockLines > 0 && this._liveBlockText) {
      try {
        this.stream.write(this._liveBlockText + '\n');
      } catch { /* ignore */ }
    }

    if (this._ephemeralLine) {
      try {
        this.stream.write(CLEAR_LINE + this._formatForOutput(this._ephemeralLine));
      } catch { /* ignore */ }
      return;
    }

    if (this.rl && typeof this.rl.prompt === 'function') {
      try {
        this.rl.prompt(true);
      } catch { /* ignore */ }
    }
  }

  /**
   * Write one or more permanent lines to stdout (or stderr when opts.stderr is true).
   */
  writeLine(text = '', opts = {}) {
    const rawLines = Array.isArray(text) ? text : String(text ?? '').split('\n');
    const target = opts.stderr && this.errStream ? this.errStream : this.stream;
    const interactive = this._isInteractive() && target === this.stream;

    if (interactive) {
      this._clearActiveOverlays();
    }

    const body = rawLines.map(l => this._formatForOutput(l)).join('\n');
    if (target === process.stdout && console.log !== ORIG_CONSOLE_LOG) {
      console.log(body);
    } else if (target && typeof target.write === 'function') {
      target.write(body + '\n');
    }

    if (interactive) {
      this._restoreActiveOverlays();
    }
  }

  /**
   * Write an array of lines as a single atomic frame.
   */
  writeLines(lines, opts = {}) {
    if (!Array.isArray(lines) || !lines.length) return;
    this.writeLine(lines.join('\n'), opts);
  }

  /**
   * Update a single-line ephemeral status (spinner, progress bar, or running startup step).
   * Ignored in non-interactive mode.
   */
  setEphemeral(line) {
    if (!this._isInteractive()) return;
    this._ephemeralLine = String(line ?? '');
    if (!this._ephemeralLine) {
      this.clearEphemeral();
      return;
    }
    this.hideCursor();
    try {
      this.stream.write(CLEAR_LINE + this._formatForOutput(this._ephemeralLine));
    } catch { /* ignore */ }
  }

  clearEphemeral() {
    const had = Boolean(this._ephemeralLine);
    this._ephemeralLine = '';
    if (!this._isInteractive()) return;
    if (had) {
      try { this.stream.write(CLEAR_LINE); } catch { /* ignore */ }
    }
    if (this._liveBlockLines === 0) {
      this.showCursor();
    }
    if (had && this.rl && typeof this.rl.prompt === 'function') {
      try { this.rl.prompt(true); } catch { /* ignore */ }
    }
  }

  /**
   * Render a multi-line live view (dashboard) in place without full-screen clear or flicker.
   * Builds the whole frame as one string and writes it once.
   */
  renderLiveFrame(lines) {
    const arr = Array.isArray(lines) ? lines : String(lines ?? '').split('\n');
    const formattedLines = arr.map(l => this._formatForOutput(l));
    const frameText = formattedLines.join('\n');

    if (!this._isInteractive()) {
      this.writeLine(frameText);
      return;
    }

    this.hideCursor();
    let seq = '';
    if (this._ephemeralLine) {
      seq += CLEAR_LINE;
    }
    if (this.rl) {
      seq += CLEAR_LINE;
    }
    if (this._liveBlockLines > 0) {
      seq += '\r';
      for (let i = 0; i < this._liveBlockLines; i++) {
        seq += '\x1b[2K';
        if (i < this._liveBlockLines - 1) seq += '\x1b[1A';
      }
      seq += '\r';
    }

    seq += frameText + '\n';
    this._liveBlockLines = formattedLines.length;
    this._liveBlockText = frameText;

    if (this.rl && typeof this.rl.getPrompt === 'function') {
      seq += this.rl.getPrompt() + (this.rl.line || '');
    }

    try {
      this.stream.write(seq);
    } catch { /* ignore */ }
  }

  stopLiveFrame() {
    if (!this._isInteractive()) {
      this._liveBlockLines = 0;
      this._liveBlockText = '';
      return;
    }
    if (this._liveBlockLines > 0) {
      try {
        let seq = '\r';
        for (let i = 0; i < this._liveBlockLines; i++) {
          seq += '\x1b[2K';
          if (i < this._liveBlockLines - 1) seq += '\x1b[1A';
        }
        seq += '\r';
        this.stream.write(seq);
      } catch { /* ignore */ }
    }
    this._liveBlockLines = 0;
    this._liveBlockText = '';
    if (!this._ephemeralLine) {
      this.showCursor();
    }
    if (this.rl && typeof this.rl.prompt === 'function') {
      try { this.rl.prompt(true); } catch { /* ignore */ }
    }
  }
}

module.exports = {
  OutputWriter,
  HIDE_CURSOR,
  SHOW_CURSOR,
};
