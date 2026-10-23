'use strict';

/**
 * Text utilities: strip ANSI/Minecraft codes, sanitize untrusted external text,
 * mask secrets, measure visible width (wide chars, emoji, combining marks),
 * and truncate/pad/wrap without cutting escape sequences.
 */

const ANSI_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const MC_COLOR_RE = /[§\u00a7][0-9a-fk-orx]/gi;
const CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function stripAnsi(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(ANSI_RE, '');
}

function stripMcCodes(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(MC_COLOR_RE, '');
}

/**
 * Sanitize untrusted text from game servers, player names, or external APIs.
 * Strips ANSI escape sequences, Minecraft § color codes, and unsafe control characters.
 */
function sanitizeUntrusted(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(ANSI_RE, '')
    .replace(MC_COLOR_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/\t/g, '  ')
    .replace(CTRL_RE, '');
}

function isZeroWidthCodePoint(cp) {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0x00ad) return true; // soft hyphen
  if (cp >= 0x0300 && cp <= 0x036f) return true; // Combining Diacritical Marks
  if (cp >= 0x1ab0 && cp <= 0x1aff) return true;
  if (cp >= 0x1dc0 && cp <= 0x1dff) return true;
  if (cp >= 0x20d0 && cp <= 0x20ff) return true;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true; // Variation Selectors
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true; // Variation Selectors Supplement
  if (cp >= 0x200b && cp <= 0x200f) return true; // ZWSP, ZWNJ, ZWJ, LRM, RLM
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2060 && cp <= 0x206f) return true;
  if (cp === 0xfeff) return true;
  if (cp >= 0x1f3fb && cp <= 0x1f3ff) return true; // Emoji skin tone modifiers
  return false;
}

function isWideCodePoint(cp) {
  if (
    cp >= 0x1100 && (
      cp <= 0x115f || // Hangul Jamo
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x3247 && cp !== 0x303f) || // CJK Radicals..Enclosed CJK
      (cp >= 0x3250 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x4e00 && cp <= 0xa4c6) || // CJK Unified Ideographs & Yi
      (cp >= 0xa960 && cp <= 0xa97c) || // Hangul Jamo Extended-A
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6b) ||
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1b000 && cp <= 0x1b001) ||
      (cp >= 0x1f200 && cp <= 0x1f251) ||
      (cp >= 0x1f300 && cp <= 0x1faff) || // Misc Symbols, Pictographs, Emoticons, Supplemental Symbols
      (cp >= 0x20000 && cp <= 0x3fffd)
    )
  ) {
    return true;
  }
  // Common wide dingbats/misc symbols rendered as 2 columns in modern terminals
  if (
    cp === 0x231a || cp === 0x231b ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 || cp === 0x23f3 ||
    cp === 0x25fd || cp === 0x25fe ||
    cp === 0x2614 || cp === 0x2615 ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f || cp === 0x2693 || cp === 0x26a1 ||
    cp === 0x26aa || cp === 0x26ab ||
    cp === 0x26bd || cp === 0x26be ||
    cp === 0x26c4 || cp === 0x26c5 || cp === 0x26ce || cp === 0x26d4 ||
    cp === 0x26ea || cp === 0x26f2 || cp === 0x26f3 || cp === 0x26f5 ||
    cp === 0x26fa || cp === 0x26fd ||
    cp === 0x2705 || cp === 0x270a || cp === 0x270b || cp === 0x2728 ||
    cp === 0x274c || cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) || cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 || cp === 0x27bf ||
    cp === 0x2b1b || cp === 0x2b1c || cp === 0x2b50 || cp === 0x2b55
  ) {
    return true;
  }
  return false;
}

function charWidth(cp) {
  if (isZeroWidthCodePoint(cp)) return 0;
  if (isWideCodePoint(cp)) return 2;
  return 1;
}

/**
 * Measure visible column width of a string (after stripping ANSI codes).
 */
function visibleWidth(str) {
  if (str === null || str === undefined || str === '') return 0;
  const clean = stripAnsi(str).normalize('NFC');
  let width = 0;
  let afterZwj = false;
  for (const ch of clean) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200d) {
      afterZwj = true;
      continue;
    }
    if (afterZwj) {
      afterZwj = false;
      continue;
    }
    width += charWidth(cp);
  }
  return width;
}

/**
 * Tokenize string into ANSI sequences and grapheme-like character clusters with visible widths.
 */
function tokenizeAnsi(str) {
  const s = String(str ?? '');
  const tokens = [];
  const re = new RegExp(ANSI_RE.source, 'g');
  let lastIdx = 0;
  let match;

  const pushText = (segment) => {
    if (!segment) return;
    const norm = segment.normalize('NFC');
    const chars = Array.from(norm);
    for (let i = 0; i < chars.length; i++) {
      let cluster = chars[i];
      const cp = cluster.codePointAt(0);
      let w = charWidth(cp);
      // Attach trailing zero-width marks or ZWJ sequences to the base character
      while (i + 1 < chars.length) {
        const nextCp = chars[i + 1].codePointAt(0);
        if (nextCp === 0x200d) {
          cluster += chars[i + 1];
          i++;
          if (i + 1 < chars.length) {
            cluster += chars[i + 1];
            i++;
          }
        } else if (isZeroWidthCodePoint(nextCp)) {
          cluster += chars[i + 1];
          i++;
        } else {
          break;
        }
      }
      tokens.push({ type: 'char', value: cluster, width: w });
    }
  };

  while ((match = re.exec(s)) !== null) {
    if (match.index > lastIdx) {
      pushText(s.slice(lastIdx, match.index));
    }
    tokens.push({ type: 'ansi', value: match[0], width: 0 });
    lastIdx = re.lastIndex;
  }
  if (lastIdx < s.length) {
    pushText(s.slice(lastIdx));
  }
  return tokens;
}

/**
 * Truncate string to `maxWidth` visible columns without cutting an ANSI escape sequence
 * or wide character. Adds an ellipsis ('…' in Unicode mode, '...' in ASCII mode).
 */
function truncate(str, maxWidth, opts = {}) {
  const s = String(str ?? '');
  const max = Math.max(0, Math.floor(Number(maxWidth) || 0));
  if (max === 0) return '';
  const totalW = visibleWidth(s);
  if (totalW <= max) return s;

  const ascii = Boolean(opts.ascii);
  const ellipsis = opts.ellipsis !== undefined ? String(opts.ellipsis) : (ascii ? '...' : '…');
  const ellW = visibleWidth(ellipsis);

  if (max <= ellW) {
    return ascii ? '.'.repeat(max) : ellipsis.slice(0, max);
  }

  const targetW = max - ellW;
  const tokens = tokenizeAnsi(s);
  let curW = 0;
  let out = '';
  let hasAnsi = false;

  for (const tok of tokens) {
    if (tok.type === 'ansi') {
      out += tok.value;
      hasAnsi = true;
    } else {
      if (curW + tok.width > targetW) break;
      out += tok.value;
      curW += tok.width;
    }
  }

  return hasAnsi ? `${out}${ellipsis}\x1b[0m` : `${out}${ellipsis}`;
}

/**
 * Pad string to `width` visible columns.
 * align: 'left' | 'right' | 'center'
 */
function pad(str, width, align = 'left', padChar = ' ') {
  const s = String(str ?? '');
  const target = Math.max(0, Math.floor(Number(width) || 0));
  const w = visibleWidth(s);
  const diff = Math.max(0, target - w);
  if (diff === 0) return s;
  const ch = String(padChar || ' ')[0] || ' ';
  if (align === 'right') {
    return ch.repeat(diff) + s;
  }
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return ch.repeat(left) + s + ch.repeat(right);
  }
  return s + ch.repeat(diff);
}

/**
 * Wrap plain or styled text to `maxWidth` visible columns.
 */
function wrap(str, maxWidth) {
  const max = Math.max(4, Math.floor(Number(maxWidth) || 80));
  const rawLines = String(str ?? '').split('\n');
  const out = [];

  for (const rawLine of rawLines) {
    if (visibleWidth(rawLine) <= max) {
      out.push(rawLine);
      continue;
    }
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (!words.length) {
      out.push('');
      continue;
    }
    let cur = '';
    let curW = 0;
    for (const word of words) {
      const wLen = visibleWidth(word);
      if (wLen > max) {
        if (cur) {
          out.push(cur);
          cur = '';
          curW = 0;
        }
        // Slice overlong word by visible width chunks
        const tokens = tokenizeAnsi(word);
        let chunk = '';
        let chunkW = 0;
        let chunkAnsi = false;
        for (const t of tokens) {
          if (t.type === 'ansi') {
            chunk += t.value;
            chunkAnsi = true;
          } else {
            if (chunkW + t.width > max && chunkW > 0) {
              out.push(chunkAnsi ? `${chunk}\x1b[0m` : chunk);
              chunk = '';
              chunkW = 0;
            }
            chunk += t.value;
            chunkW += t.width;
          }
        }
        if (chunk) {
          cur = chunkAnsi ? `${chunk}\x1b[0m` : chunk;
          curW = chunkW;
        }
      } else if (curW === 0) {
        cur = word;
        curW = wLen;
      } else if (curW + 1 + wLen <= max) {
        cur += ' ' + word;
        curW += 1 + wLen;
      } else {
        out.push(cur);
        cur = word;
        curW = wLen;
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * Mask a standalone secret token or password, keeping at most the last 4 characters
 * when long enough (>= 8 chars), or '***' when shorter.
 */
function maskSecret(secret) {
  if (secret === null || secret === undefined || secret === '') return '';
  const s = String(secret).trim();
  if (!s) return '';
  // Webhook URL: keep protocol + host + last 4 chars
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const tail = s.length > 8 ? s.slice(-4) : '';
      return `${u.protocol}//${u.host}/.../${tail ? '****' + tail : '***'}`;
    } catch {
      return '***';
    }
  }
  // Telegram token: 123456789:AAH...
  const tgMatch = /^(\d{6,12}):([\w-]{10,})$/.exec(s);
  if (tgMatch) {
    return `${tgMatch[1].slice(0, 3)}***:****${tgMatch[2].slice(-4)}`;
  }
  if (s.length >= 10) {
    return `****${s.slice(-4)}`;
  }
  return '***';
}

/**
 * Redact secrets embedded inside log or status text (webhook URLs, Telegram tokens,
 * /dn or /l passwords, proxy credentials, and custom known secrets).
 */
function redactSecretsInText(text, knownSecrets = []) {
  if (text === null || text === undefined || text === '') return '';
  let out = String(text);
  // Discord webhooks
  out = out.replace(
    /(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)([\w-]+)/gi,
    (_, prefix, tok) => `${prefix}****${tok.length >= 4 ? tok.slice(-4) : '***'}`
  );
  // Telegram bot tokens
  out = out.replace(
    /\b(\d{6,12}):([\w-]{30,})\b/g,
    (_, id, tok) => `${id.slice(0, 3)}***:****${tok.slice(-4)}`
  );
  // Minecraft login/register commands
  out = out.replace(
    /(\/(?:dn|dk|login|register|log|reg|l|changepassword|cp)\s+)\S+(?:\s+\S+)?/gi,
    '$1***'
  );
  // JSON secret fields & Bearer tokens
  out = out.replace(/("(?:botPassword|password|telegramToken|dashboardToken|webhookUrl|revenueWebhookUrl|omniRouterApiKey)"\s*:\s*")[^"]*(")/gi, '$1***$2');
  out = out.replace(/(Bearer\s+)[\w.-]{8,}/gi, '$1***');
  // Proxy URLs with user:pass@
  out = out.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi,
    '$1***@'
  );
  // Known secrets list
  if (Array.isArray(knownSecrets)) {
    for (const sec of knownSecrets) {
      const s = String(sec || '').trim();
      if (s.length >= 3) {
        const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(escaped, 'g'), '***');
      }
    }
  }
  return out;
}

module.exports = {
  ANSI_RE,
  MC_COLOR_RE,
  stripAnsi,
  stripMcCodes,
  sanitizeUntrusted,
  visibleWidth,
  truncate,
  pad,
  wrap,
  maskSecret,
  redactSecretsInText,
};
