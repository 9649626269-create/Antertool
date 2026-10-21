'use strict';

/**
 * Shared Theme & Design System.
 * Maps semantic roles to the 16 base ANSI colors so the user's terminal theme applies.
 * No raw escape codes exist outside this layer.
 */

const { stripAnsi } = require('./text');

const CODES = Object.freeze({
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  redBold: '\x1b[1;31m',
  yellow: '\x1b[33m',
  yellowDim: '\x1b[2;33m',
  cyan: '\x1b[36m',
  cyanBold: '\x1b[1;36m',
  brightBlue: '\x1b[94m',
  magenta: '\x1b[35m',
  titleBold: '\x1b[1m',
});

function hasAnsi(s) {
  return typeof s === 'string' && s.includes('\x1b[');
}

/**
 * Wrap plain text in an ANSI SGR sequence.
 * Never wraps already-styled text in a second style.
 */
function styleWith(code, enabled) {
  return (text) => {
    if (text === null || text === undefined || text === '') return '';
    const str = String(text);
    if (!enabled) return hasAnsi(str) ? stripAnsi(str) : str;
    // Apply style at exactly one point; if already styled, do not double-wrap
    if (hasAnsi(str)) return str.endsWith(CODES.reset) ? str : `${str}${CODES.reset}`;
    return `${code}${str}${CODES.reset}`;
  };
}

function createTheme(caps) {
  const enabled = Boolean(caps && caps.color);

  const theme = {
    enabled,
    success: styleWith(CODES.green, enabled),
    error: styleWith(CODES.red, enabled),
    fatal: styleWith(CODES.redBold, enabled),
    errorBold: styleWith(CODES.redBold, enabled),
    warning: styleWith(CODES.yellow, enabled),
    skip: styleWith(CODES.yellowDim, enabled),
    info: styleWith(CODES.cyan, enabled),
    debug: styleWith(CODES.brightBlue, enabled),
    ai: styleWith(CODES.magenta, enabled),
    muted: styleWith(CODES.dim, enabled),
    accent: styleWith(CODES.cyan, enabled),
    title: styleWith(CODES.titleBold, enabled),
    key: styleWith(CODES.bold, enabled),
    border: styleWith(CODES.dim, enabled),

    /**
     * Optional truecolor gradient for banner lines when terminal reports 24-bit color.
     * Falls back to `accent` in 16/256-color mode and plain text when color is off.
     */
    bannerArt(line, rgbStart = [34, 211, 238], rgbEnd = [167, 139, 250]) {
      const s = String(line ?? '');
      if (!enabled) return stripAnsi(s);
      if (!caps || !caps.truecolor) return theme.accent(s);
      const chars = Array.from(stripAnsi(s));
      if (!chars.length) return '';
      const len = Math.max(1, chars.length - 1);
      let out = '';
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch === ' ') {
          out += ch;
          continue;
        }
        const t = i / len;
        const r = Math.round(rgbStart[0] + (rgbEnd[0] - rgbStart[0]) * t);
        const g = Math.round(rgbStart[1] + (rgbEnd[1] - rgbStart[1]) * t);
        const b = Math.round(rgbStart[2] + (rgbEnd[2] - rgbStart[2]) * t);
        out += `\x1b[38;2;${r};${g};${b}m${ch}`;
      }
      return `${out}${CODES.reset}`;
    },

    /**
     * Format a status state using semantic color + word/symbol so meaning never relies on color alone.
     */
    formatStatus(rawState, opts = {}) {
      const sym = (caps && caps.symbols) || { ok: 'OK', fail: 'X', warn: '!', bullet: '*' };
      const st = String(rawState ?? 'UNKNOWN').trim().toUpperCase();
      const withSymbol = opts.symbol !== false;

      if (['OK', 'SUCCESS', 'ONLINE', 'CONNECTED', 'ENABLED', 'BẬT', 'LIVE', 'READY', 'ACTIVE', 'DONE'].includes(st)) {
        const label = withSymbol ? `${sym.ok} ${st}` : st;
        return { text: theme.success(label), raw: label, role: 'success', state: st };
      }
      if (['PENDING', 'RUNNING', 'CONNECTING', 'AUTHENTICATING', 'SPAWNING'].includes(st)) {
        const label = withSymbol ? `${sym.bullet} ${st}` : st;
        return { text: theme.info(label), raw: label, role: 'info', state: st };
      }
      if (['WARN', 'WARNING', 'RECONNECTING', 'RETRY', 'RETRYING', 'LATE', 'SLOW', 'TIMEOUT'].includes(st)) {
        const label = withSymbol ? `${sym.warn} ${st}` : st;
        return { text: theme.warning(label), raw: label, role: 'warning', state: st };
      }
      if (['SKIP', 'SKIPPED'].includes(st)) {
        const label = withSymbol ? `${sym.warn} ${st}` : st;
        return { text: theme.skip(label), raw: label, role: 'skip', state: st };
      }
      if (['FAIL', 'FAILED', 'ERROR', 'ERR', 'FATAL', 'OFFLINE', 'DEAD', 'DIE', 'AUTH_FAIL'].includes(st)) {
        const label = withSymbol ? `${sym.fail} ${st}` : st;
        return { text: theme.error(label), raw: label, role: 'error', state: st };
      }
      if (['DISCONNECTED', 'STOPPING', 'STOPPED', 'DISABLED', 'OFF', 'TẮT', 'IDLE', 'UNKNOWN'].includes(st)) {
        const label = withSymbol ? `${sym.bullet} ${st}` : st;
        return { text: theme.muted(label), raw: label, role: 'muted', state: st };
      }
      return { text: theme.muted(st), raw: st, role: 'muted', state: st };
    },

    /**
     * Ensure line ends with reset if styled, or is stripped of ANSI if color is disabled.
     */
    finalizeLine(line) {
      const s = String(line ?? '');
      if (!enabled) return hasAnsi(s) ? stripAnsi(s) : s;
      if (hasAnsi(s) && !s.endsWith(CODES.reset)) return `${s}${CODES.reset}`;
      return s;
    },
  };

  return theme;
}

module.exports = {
  CODES,
  createTheme,
};
