'use strict';
/**
 * TextSafe.js — Làm sạch mọi chuỗi văn bản từ nguồn bên ngoài trước khi đưa lên Telegram.
 *
 * Quy trình sanitizeExternal(text, { max = 200 }):
 *  1. Chuẩn hoá Unicode NFC + gỡ surrogate lẻ (tránh lỗi UTF-16).
 *  2. Bỏ mã ANSI và mã màu Minecraft (§x, §0-§9, §a-§f, §k-§r).
 *  3. Bỏ ký tự điều khiển, zero-width, và bidi controls (U+202A–U+202E, U+2066–U+2069).
 *  4. Bỏ toàn bộ emoji / pictograph (\p{Extended_Pictographic}, U+FE0F, U+200D, regional indicators, keycaps, dingbats).
 *  5. Gộp khoảng trắng thừa.
 *  6. Cắt theo code point (không bao giờ cắt đôi surrogate pair) kèm ký hiệu ellipsis.
 */
const { sym, allowedGlyphChars } = require('./Symbols');

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const MC_HEX_RE = /§x(?:§[0-9a-fA-F]){6}/g;
const MC_CODE_RE = /§[0-9a-fk-orxA-FK-ORX#]/g;

// Ký tự điều khiển C0/C1, zero-width, soft-hyphen, variación selectors, ZWJ, bidi controls, tag chars
const CONTROL_BIDI_ZW_RE = /[\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFE0E\uFE0F\uFEFF\u20E3\u{E0000}-\u{E007F}]/gu;

// Emoji / Pictographic / Regional Indicators / Misc Symbols & Dingbats (trừ ✓ U+2713 và ✗ U+2717 trong bảng PALETTE)
const PICTO_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u2600-\u26FF\u2700-\u2712\u2714-\u2716\u2718-\u27BF\u2300-\u23FF\u2B00-\u2BFF\u2194-\u2199\u21A9-\u21AA\u2139\u25AA\u25AB\u25B6\u25C0\u25FB-\u25FE\u{1F000}-\u{1FAFF}]/gu;

// Surrogate lẻ (không ghép thành cặp hợp lệ)
function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += str[i] + str[i + 1];
        i++;
      }
      // Bỏ qua high surrogate lẻ
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Bỏ qua low surrogate lẻ
    } else {
      out += str[i];
    }
  }
  return out;
}

const ALLOWED_PALETTE = allowedGlyphChars();
const ALLOWED_CHAR_RE = /^[\u0020-\u007E\u00A0-\u024F\u1E00-\u1EFF\u0394\u2010-\u2027\u2190-\u2193\u21BB\u2261\u2500-\u25FF\u2713\u2717]$/u;

function filterAllowedChars(str) {
  let out = '';
  for (const ch of str) {
    if (ch === '\n') {
      out += ch;
      continue;
    }
    if (ALLOWED_PALETTE.has(ch) || ALLOWED_CHAR_RE.test(ch) || /\p{L}|\p{N}/u.test(ch)) {
      out += ch;
    }
  }
  return out;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripEmoji(text) {
  const clean = stripLoneSurrogates(String(text ?? '')).normalize('NFC');
  return clean.replace(CONTROL_BIDI_ZW_RE, '').replace(PICTO_RE, '');
}

function truncateCodePoints(str, max = 200, ellipsis = null) {
  const s = stripLoneSurrogates(String(str ?? ''));
  const lim = Math.max(1, Math.floor(Number(max) || 200));
  const cps = Array.from(s);
  if (cps.length <= lim) return s;
  const tail = ellipsis !== null ? String(ellipsis) : sym('ellipsis');
  const tailCps = Array.from(tail);
  const keep = Math.max(0, lim - tailCps.length);
  return cps.slice(0, keep).join('') + tail;
}

/**
 * Làm sạch chuỗi từ bên ngoài (kick reason, tên người chơi, chat, scoreboard, lỗi proxy, tên macro).
 * @param {any} text
 * @param {{max?: number, multiline?: boolean, escape?: boolean}} [opts]
 * @returns {string}
 */
function sanitizeExternal(text, opts = {}) {
  if (text === null || text === undefined) return '';
  const max = opts.max !== undefined ? Math.max(1, Number(opts.max) || 200) : 200;
  let s = stripLoneSurrogates(String(text)).normalize('NFC');
  s = s.replace(ANSI_RE, '').replace(MC_HEX_RE, '').replace(MC_CODE_RE, '');
  if (opts.multiline) {
    s = s.replace(/\r\n?/g, '\n');
    s = s
      .split('\n')
      .map(line => {
        const cleaned = line.replace(CONTROL_BIDI_ZW_RE, '').replace(PICTO_RE, '');
        return filterAllowedChars(cleaned).replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .join('\n');
  } else {
    s = s.replace(/[\r\n\t]+/g, ' ');
    s = s.replace(CONTROL_BIDI_ZW_RE, '').replace(PICTO_RE, '');
    s = filterAllowedChars(s).replace(/\s+/g, ' ').trim();
  }
  s = truncateCodePoints(s, max);
  return opts.escape ? escapeHtml(s) : s;
}

function sanitizeHtml(text, opts = {}) {
  return escapeHtml(sanitizeExternal(text, { ...opts, escape: false }));
}

module.exports = {
  sanitizeExternal,
  sanitizeHtml,
  escapeHtml,
  stripEmoji,
  stripLoneSurrogates,
  truncateCodePoints,
};
