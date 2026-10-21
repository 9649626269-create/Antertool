'use strict';
/**
 * Symbols.js — Bảng ký hiệu duy nhất cho Telegram (Appendix A).
 * Không chứa bất kỳ ký tự Extended_Pictographic, U+FE0F hay U+200D nào.
 * Hỗ trợ 2 bộ: 'unicode' (mặc định) và 'ascii' (fallback cho font thiếu glyph).
 */

const PALETTE = Object.freeze({
  title:    { unicode: '\u25C6', ascii: '#' },     // ◆
  info:     { unicode: '\u25C7', ascii: '[i]' },   // ◇
  ok:       { unicode: '\u2713', ascii: '[ok]' },  // ✓
  fail:     { unicode: '\u2717', ascii: '[x]' },   // ✗
  warn:     { unicode: '\u25B2', ascii: '[!]' },   // ▲
  on:       { unicode: '\u25CF', ascii: '(*)' },   // ●
  off:      { unicode: '\u25CB', ascii: '( )' },   // ○
  busy:     { unicode: '\u25D0', ascii: '(~)' },   // ◐
  retry:    { unicode: '\u21BB', ascii: '(@)' },   // ↻
  now:      { unicode: '\u25BA', ascii: '>' },     // ►
  next:     { unicode: '\u00BB', ascii: '>>' },    // »
  guard:    { unicode: '\u25C8', ascii: '[#]' },   // ◈
  pos:      { unicode: '\u25CE', ascii: '@' },     // ◎
  log:      { unicode: '\u2261', ascii: '=' },     // ≡
  rule:     { unicode: '\u2500', ascii: '-' },     // ─
  sep:      { unicode: '\u00B7', ascii: '-' },     // ·
  barOn:    { unicode: '\u25B0', ascii: '#' },     // ▰
  barOff:   { unicode: '\u25B1', ascii: '-' },     // ▱
  arrow:    { unicode: '\u2192', ascii: '->' },    // →
  back:     { unicode: '\u2190', ascii: '<-' },    // ←
  up:       { unicode: '\u2191', ascii: '^' },     // ↑
  down:     { unicode: '\u2193', ascii: 'v' },     // ↓
  delta:    { unicode: '\u0394', ascii: '+/-' },   // Δ
  mult:     { unicode: '\u00D7', ascii: 'x' },     // ×
  bullet:   { unicode: '\u2022', ascii: '*' },     // •
  ellipsis: { unicode: '\u2026', ascii: '...' },   // …
  stop:     { unicode: '\u25A0', ascii: '[]' },    // ■
  money:    { unicode: '\u0024', ascii: '$' },     // $
});

// Bảng ánh xạ emoji cũ (viết bằng \u{...} để mã nguồn thuần ASCII, không dính pictograph).
const LEGACY_EMOJI_MAP = Object.freeze([
  ['\u{2705}', 'ok'],
  ['\u{2714}', 'ok'],
  ['\u{1F7E2}', 'on'],
  ['\u{274C}', 'fail'],
  ['\u{2716}', 'fail'],
  ['\u{1F534}', 'fail'],
  ['\u{1F6A8}', 'fail'],
  ['\u{26A0}', 'warn'],
  ['\u{1F7E1}', 'warn'],
  ['\u{1F7E0}', 'warn'],
  ['\u{26AB}', 'off'],
  ['\u{26AA}', 'off'],
  ['\u{1F504}', 'retry'],
  ['\u{1F4B0}', 'money'],
  ['\u{1F4B8}', 'money'],
  ['\u{1F4CD}', 'pos'],
  ['\u{1F3E0}', 'pos'],
  ['\u{1F4DC}', 'log'],
  ['\u{1F4CB}', 'log'],
  ['\u{1F6E1}', 'guard'],
  ['\u{25B6}', 'now'],
  ['\u{23F9}', 'stop'],
  ['\u{2699}', 'info'],
  ['\u{1F4E6}', 'info'],
  ['\u{1F3AF}', 'ok'],
  ['\u{1F392}', 'info'],
  ['\u{23F0}', 'info'],
  ['\u{23F1}', 'info'],
  ['\u{1F552}', 'info'],
  ['\u{1F916}', 'title'],
  ['\u{1F464}', 'info'],
  ['\u{1F4E1}', 'info'],
  ['\u{1F4C8}', 'up'],
  ['\u{1F195}', 'delta'],
  ['\u{1F4C5}', 'info'],
  ['\u{1F4CA}', 'info'],
]);

const LEGACY_LOOKUP = new Map(LEGACY_EMOJI_MAP);

let currentSet = 'unicode';

function setSymbolSet(mode) {
  currentSet = String(mode || '').toLowerCase() === 'ascii' ? 'ascii' : 'unicode';
  return currentSet;
}

function getSymbolSet() {
  return currentSet;
}

function sym(token, setOverride = null) {
  const mode = setOverride ? (String(setOverride).toLowerCase() === 'ascii' ? 'ascii' : 'unicode') : currentSet;
  const entry = PALETTE[token];
  if (entry) return entry[mode];
  return '';
}

function bar(done, total, width = 5, setOverride = null) {
  const w = Math.max(1, Math.min(20, Math.floor(Number(width) || 5)));
  const d = Math.max(0, Number(done) || 0);
  const t = Math.max(0, Number(total) || 0);
  const ratio = t > 0 ? Math.max(0, Math.min(1, d / t)) : 0;
  const onCount = Math.round(ratio * w);
  const onGlyph = sym('barOn', setOverride);
  const offGlyph = sym('barOff', setOverride);
  return onGlyph.repeat(onCount) + offGlyph.repeat(Math.max(0, w - onCount));
}

/**
 * Ánh xạ trạng thái bot hoặc mức độ sang token trong bảng PALETTE.
 * @param {string|object} state
 * @returns {string} token key ('on' | 'busy' | 'retry' | 'off' | 'fail' | 'warn' | 'info' | 'ok')
 */
function statusToken(state) {
  if (state && typeof state === 'object') {
    if (state.disabled || state.connState === 'STOPPING' || state.connState === 'STOPPED') return 'off';
    const st = String(state.connState || '').toUpperCase();
    if (st === 'RECONNECTING') return 'retry';
    if (st === 'CONNECTING' || st === 'AUTHENTICATING' || st === 'SPAWNING') return 'busy';
    if (st !== 'ONLINE') return 'fail';
    if (state.level === 'warn') return 'warn';
    if (state.level === 'bad' || state.level === 'err' || state.level === 'crit') return 'fail';
    if (state.level === 'off') return 'off';
    if (state.level === 'idle' || state.sellOn === false) return 'off';
    return 'on';
  }
  const s = String(state || '').trim().toUpperCase();
  switch (s) {
    case 'ONLINE':
    case 'ON':
      return 'on';
    case 'OK':
      return 'ok';
    case 'CONNECTING':
    case 'AUTHENTICATING':
    case 'SPAWNING':
    case 'BUSY':
      return 'busy';
    case 'RECONNECTING':
    case 'RETRY':
      return 'retry';
    case 'STOPPING':
    case 'STOPPED':
    case 'OFF':
    case 'DISABLED':
    case 'IDLE':
      return 'off';
    case 'WARN':
    case 'WARNING':
      return 'warn';
    case 'INFO':
      return 'info';
    case 'DISCONNECTED':
    case 'ERROR':
    case 'ERR':
    case 'FAIL':
    case 'BAD':
    case 'CRIT':
    default:
      return 'fail';
  }
}

function legacyEmojiToToken(ch) {
  const clean = String(ch || '').replace(/\uFE0F|\uFE0E/g, '');
  return LEGACY_LOOKUP.get(clean) || null;
}

function replaceLegacyEmoji(text, setOverride = null) {
  let s = String(text ?? '');
  for (const [emo, tok] of LEGACY_EMOJI_MAP) {
    const re = new RegExp(emo + '[\\uFE0F\\uFE0E]?', 'gu');
    s = s.replace(re, sym(tok, setOverride));
  }
  return s;
}

function ruleLine(width = 18, setOverride = null) {
  return sym('rule', setOverride).repeat(Math.max(1, width));
}

// Tập hợp tất cả ký tự đơn trong PALETTE (phục vụ kiểm tra allow-list).
function allowedGlyphChars() {
  const chars = new Set();
  for (const v of Object.values(PALETTE)) {
    for (const ch of v.unicode) chars.add(ch);
    for (const ch of v.ascii) chars.add(ch);
  }
  return chars;
}

module.exports = {
  PALETTE,
  LEGACY_EMOJI_MAP,
  sym,
  bar,
  statusToken,
  setSymbolSet,
  getSymbolSet,
  legacyEmojiToToken,
  replaceLegacyEmoji,
  ruleLine,
  allowedGlyphChars,
};
