'use strict';
/**
 * TuiEngine.js — Centralized Terminal UI Design System, Semantic Color Palette,
 * Structured Colored Logging Formatter, ANSI-Aware Unicode Table Engine,
 * Multi-Panel Dashboard Renderer, Startup Initialization Checklist, and
 * Non-Intrusive Braille Spinner / Progress Bar Utility.
 *
 * Zero external dependencies required (works standalone with ANSI/256/TrueColor
 * escape sequences and automatically respects NO_COLOR, FORCE_COLOR, TERM=dumb,
 * and stdout/stderr TTY status).
 */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const MC_COLOR_RE = /§[0-9a-fk-orx#]/gi;

// ─────────────────────────────────────────────────────────────────────────────
// 1. Environment & Capability Detection
// ─────────────────────────────────────────────────────────────────────────────

function detectColorSupport(stream = process.stdout, env = process.env) {
  if (env && typeof env.NO_COLOR === 'string' && env.NO_COLOR.length > 0) {
    return false;
  }
  if (env && typeof env.FORCE_COLOR === 'string' && env.FORCE_COLOR.length > 0) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR.toLowerCase() !== 'false';
  }
  if (env && env.TERM === 'dumb') {
    return false;
  }
  return Boolean(stream && stream.isTTY);
}

function detectInteractiveTTY(stream = process.stdout, env = process.env) {
  if (env && typeof env.NO_COLOR === 'string' && env.NO_COLOR.length > 0) return false;
  if (env && env.TERM === 'dumb') return false;
  if (env && (env.CI === 'true' || env.CI === '1')) return false;
  return Boolean(stream && stream.isTTY);
}

function getTerminalWidth(stream = process.stdout, env = process.env) {
  if (env && env.COLUMNS) {
    const c = parseInt(env.COLUMNS, 10);
    if (Number.isFinite(c) && c >= 40) return c;
  }
  if (stream && typeof stream.columns === 'number' && stream.columns >= 40) {
    return stream.columns;
  }
  if (process.stdout && typeof process.stdout.columns === 'number' && process.stdout.columns >= 40) {
    return process.stdout.columns;
  }
  return 80;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Design System & Semantic Color Palette
// ─────────────────────────────────────────────────────────────────────────────

function stripAnsi(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(ANSI_RE, '');
}

function cleanText(str) {
  return stripAnsi(str).replace(MC_COLOR_RE, '');
}

function createStyler(enabledFn = () => detectColorSupport()) {
  const wrap = (open, close = '\x1b[0m') => (text) => {
    const s = String(text ?? '');
    if (!s) return '';
    if (!enabledFn()) return stripAnsi(s);
    return `${open}${s}${close}`;
  };

  return {
    get enabled() { return enabledFn(); },
    success: wrap('\x1b[92m'),                  // Bright Green
    successBold: wrap('\x1b[1;92m'),            // Bold Bright Green (for badges)
    error: wrap('\x1b[91m'),                    // Bright Red
    errorBold: wrap('\x1b[1;91m'),              // Bold Bright Red (for headers/badges)
    warning: wrap('\x1b[93m'),                  // Bright Yellow / Amber
    warningBold: wrap('\x1b[1;93m'),            // Bold Bright Yellow
    info: wrap('\x1b[96m'),                     // Bright Cyan
    infoBold: wrap('\x1b[1;96m'),               // Bold Bright Cyan
    ai: wrap('\x1b[95m'),                       // Bright Magenta / Purple
    aiBold: wrap('\x1b[1;95m'),                 // Bold Bright Magenta
    debug: wrap('\x1b[38;5;68m'),               // Blue / Slate
    debugBold: wrap('\x1b[1;38;5;68m'),         // Bold Blue / Slate
    muted: wrap('\x1b[90m'),                    // Dim Gray / Bright Black
    dim: wrap('\x1b[2;37m'),                    // Dim white
    primary: wrap('\x1b[1;97m'),                // Bold White (Primary Accent)
    white: wrap('\x1b[97m'),                    // Crisp White
    key: wrap('\x1b[38;5;221m'),                // Warm Gold / Key highlight
    value: wrap('\x1b[38;5;117m'),              // Sky Blue value highlight
    duration: wrap('\x1b[38;5;215m'),           // Amber/Orange duration highlight
    path: wrap('\x1b[4;36m'),                   // Underlined Cyan path
    bold: wrap('\x1b[1m'),
  };
}

const theme = createStyler();

const SYMBOLS = Object.freeze({
  success: '✔',
  online: '●',
  error: '✖',
  offline: '■',
  warning: '⚠',
  retry: '▲',
  info: 'ℹ',
  system: '◆',
  ai: '✦',
  bolt: '⚡',
  debug: '⚙',
  bullet: '•',
  guide: '│',
  dash: '—',
  arrow: '→',
  prompt: '⬡',
});

const BOX = Object.freeze({
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
  lt: '├', rt: '┤', tt: '┬', bt: '┴', cross: '┼',
  hDouble: '═', ltDouble: '╞', rtDouble: '╡', crossDouble: '╪',
});

function formatBadge(label, role = 'info', styler = theme) {
  const raw = `[${String(label).toUpperCase()}]`;
  switch (role) {
    case 'success':
    case 'ok':
    case 'ready':
    case 'connected':
    case 'online':
      return styler.successBold(raw);
    case 'error':
    case 'err':
    case 'failed':
    case 'offline':
    case 'critical':
      return styler.errorBold(raw);
    case 'warning':
    case 'warn':
    case 'retry':
    case 'skipped':
    case 'degraded':
      return styler.warningBold(raw);
    case 'ai':
    case 'model':
    case 'shard':
    case 'special':
      return styler.aiBold(raw);
    case 'debug':
    case 'trace':
      return styler.debugBold(raw);
    case 'muted':
    case 'idle':
    case 'disabled':
      return styler.muted(raw);
    case 'info':
    case 'init':
    case 'pending':
    case 'sys':
    default:
      return styler.infoBold(raw);
  }
}

function formatStatusPill(state, styler = theme) {
  const s = String(state || 'UNKNOWN').toUpperCase();
  if (['ONLINE', 'RUNNING', 'CONNECTED', 'ACTIVE', 'OK', 'HEALTHY', 'ENABLED', 'BẬT'].includes(s)) {
    return `${styler.success('●')} ${styler.successBold(s)}`;
  }
  if (['READY', 'AI', 'SMART', 'MODEL', 'ARMED'].includes(s)) {
    return `${styler.ai('✦')} ${styler.aiBold(s)}`;
  }
  if (['CONNECTING', 'AUTHENTICATING', 'SPAWNING', 'RECONNECTING', 'RETRY', 'STARTING', 'PENDING', 'WARNING', 'DEGRADED'].includes(s)) {
    return `${styler.warning('●')} ${styler.warningBold(s)}`;
  }
  if (['IDLE', 'OFF', 'DISABLED', 'SKIPPED', 'STANDBY', 'TẮT'].includes(s)) {
    return `${styler.muted('●')} ${styler.muted(s)}`;
  }
  if (['DISCONNECTED', 'STOPPED', 'STOPPING', 'OFFLINE', 'ERROR', 'FAILED', 'DEAD'].includes(s)) {
    return `${styler.error('●')} ${styler.errorBold(s)}`;
  }
  return `${styler.info('◆')} ${styler.info(s)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ANSI-Safe Width Calculation & String Manipulation
// ─────────────────────────────────────────────────────────────────────────────

function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff
  ) {
    return 0;
  }
  if (
    cp === 0x26a1 ||
    cp === 0x2705 ||
    cp === 0x274c ||
    cp === 0x2728 ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x1100 && (
      cp <= 0x115f ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ))
  ) {
    return 2;
  }
  return 1;
}

function visibleLength(str) {
  const clean = stripAnsi(str);
  let width = 0;
  for (const ch of clean) {
    width += codePointWidth(ch.codePointAt(0));
  }
  return width;
}

function truncateAnsi(str, maxWidth, ellipsis = '…') {
  const s = String(str ?? '');
  if (maxWidth <= 0) return '';
  if (visibleLength(s) <= maxWidth) return s;
  const ellW = visibleLength(ellipsis);
  const target = Math.max(0, maxWidth - ellW);

  let out = '';
  let w = 0;
  let i = 0;
  let hasAnsi = false;

  while (i < s.length) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        hasAnsi = true;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = codePointWidth(cp);
    if (w + cw > target) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + (hasAnsi ? '\x1b[0m' : '') + ellipsis;
}

function padAnsi(str, width, align = 'left', padChar = ' ') {
  const s = String(str ?? '');
  const len = visibleLength(s);
  if (len >= width) return s;
  const diff = width - len;
  if (align === 'right') return padChar.repeat(diff) + s;
  if (align === 'center') {
    const left = Math.floor(diff / 2);
    const right = diff - left;
    return padChar.repeat(left) + s + padChar.repeat(right);
  }
  return s + padChar.repeat(diff);
}

function wrapAnsi(str, maxWidth) {
  const s = String(str ?? '');
  if (maxWidth <= 4) return [s];
  const rawLines = s.split('\n');
  const out = [];
  for (const line of rawLines) {
    if (visibleLength(line) <= maxWidth) {
      out.push(line);
      continue;
    }
    const words = line.split(' ');
    let cur = '';
    for (const word of words) {
      if (!cur) {
        if (visibleLength(word) > maxWidth) {
          out.push(truncateAnsi(word, maxWidth));
        } else {
          cur = word;
        }
      } else if (visibleLength(cur) + 1 + visibleLength(word) <= maxWidth) {
        cur += ' ' + word;
      } else {
        out.push(cur);
        cur = visibleLength(word) > maxWidth ? truncateAnsi(word, maxWidth) : word;
      }
    }
    if (cur) out.push(cur);
  }
  return out.length ? out : [''];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Structured Colored Logging System (Section 3)
// ─────────────────────────────────────────────────────────────────────────────

const LOG_LEVEL_MAP = Object.freeze({
  info:    { badge: 'INFO   ', role: 'info',    symbol: '' },
  sys:     { badge: 'INFO   ', role: 'info',    symbol: '' },
  ok:      { badge: 'SUCCESS', role: 'success', symbol: '' },
  success: { badge: 'SUCCESS', role: 'success', symbol: '' },
  warn:    { badge: 'WARNING', role: 'warning', symbol: '' },
  warning: { badge: 'WARNING', role: 'warning', symbol: '' },
  err:     { badge: 'ERROR  ', role: 'error',   symbol: '' },
  error:   { badge: 'ERROR  ', role: 'error',   symbol: '' },
  fatal:   { badge: 'FATAL  ', role: 'error',   symbol: '✖ ' },
  ai:      { badge: 'AI     ', role: 'ai',      symbol: '✦ ' },
  shard:   { badge: 'AI     ', role: 'ai',      symbol: '✦ ' },
  afk:     { badge: 'AFK    ', role: 'success', symbol: '' },
  proxy:   { badge: 'PROXY  ', role: 'info',    symbol: '' },
  health:  { badge: 'HEALTH ', role: 'warning', symbol: '' },
  debug:   { badge: 'DEBUG  ', role: 'debug',   symbol: '' },
  trace:   { badge: 'TRACE  ', role: 'debug',   symbol: '' },
  load:    { badge: 'INIT   ', role: 'info',    symbol: '' },
});

function formatTimestamp(ts, tz) {
  const d = new Date(ts || Date.now());
  try {
    if (tz) {
      return d.toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });
    }
  } catch {}
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function highlightMessageBody(rawBody, styler = theme) {
  const clean = cleanText(rawBody);
  if (!styler.enabled) return clean;

  const tokenRe = /(https?:\/\/[^\s)]+|(?:\/[\w.-]+){2,}(?:\.\w+)?|\b[\w.-]+\.(?:json|jsonl|log|js|txt|md|yml|yaml)\b|"[^"\n]{1,60}"|\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|MB|GB|KB|%|block|blocks|tick|ticks)\b|\b[a-zA-Z_][\w-]*=(?:[^\s,;)]+)|\b\d+\/\d+\b)/g;

  let result = '';
  let lastIdx = 0;
  let m;
  while ((m = tokenRe.exec(clean)) !== null) {
    if (m.index > lastIdx) {
      result += styler.white(clean.slice(lastIdx, m.index));
    }
    const tok = m[0];
    if (/^https?:\/\//.test(tok) || /\.(?:json|jsonl|log|js|txt|md|yml|yaml)$/.test(tok) || tok.startsWith('/')) {
      result += styler.path(tok);
    } else if (tok.startsWith('"') && tok.endsWith('"')) {
      result += styler.key(tok);
    } else if (tok.includes('=')) {
      const eq = tok.indexOf('=');
      result += styler.key(tok.slice(0, eq + 1)) + styler.value(tok.slice(eq + 1));
    } else if (/\b(?:ms|s|m|h|MB|GB|KB|%)\b/.test(tok)) {
      result += styler.duration(tok);
    } else {
      result += styler.primary(tok);
    }
    lastIdx = m.index + tok.length;
  }
  if (lastIdx < clean.length) {
    result += styler.white(clean.slice(lastIdx));
  }
  return result;
}

function formatLogEntry(opts = {}, styler = theme) {
  const {
    time = Date.now(),
    level = 'info',
    scope = null,
    msg = '',
    tz = null,
    rawAnsiAllowed = false,
  } = opts;

  const tsRaw = `[${formatTimestamp(time, tz)}]`;
  const tsFormatted = styler.muted(tsRaw);

  const lvlKey = String(level || 'info').toLowerCase();
  const meta = LOG_LEVEL_MAP[lvlKey] || {
    badge: String(lvlKey).toUpperCase().slice(0, 7).padEnd(7, ' '),
    role: 'info',
    symbol: '',
  };

  const badgeRaw = `[${meta.badge}]`;
  let badgeFormatted;
  switch (meta.role) {
    case 'success': badgeFormatted = styler.successBold(badgeRaw); break;
    case 'error':   badgeFormatted = styler.errorBold(badgeRaw); break;
    case 'warning': badgeFormatted = styler.warningBold(badgeRaw); break;
    case 'ai':      badgeFormatted = styler.aiBold(badgeRaw); break;
    case 'debug':   badgeFormatted = styler.debugBold(badgeRaw); break;
    default:        badgeFormatted = styler.infoBold(badgeRaw); break;
  }

  let scopePart = '';
  if (scope && scope !== 'system') {
    scopePart = ' ' + styler.info(`[${cleanText(scope)}]`);
  }

  let bodyStr = '';
  if (msg instanceof Error) {
    bodyStr = msg.stack || `${msg.name}: ${msg.message}`;
  } else if (typeof msg === 'object' && msg !== null) {
    try { bodyStr = JSON.stringify(msg); } catch { bodyStr = String(msg); }
  } else {
    bodyStr = String(msg ?? '');
  }

  const cleanedBody = rawAnsiAllowed ? bodyStr : cleanText(bodyStr);
  const lines = cleanedBody.replace(/\r/g, '').split('\n');
  const firstLine = lines[0] || '';
  const symPrefix = meta.symbol && !firstLine.startsWith('✦') && !firstLine.startsWith('✖')
    ? (meta.role === 'ai' ? styler.ai(meta.symbol) : styler.error(meta.symbol))
    : '';

  const renderedFirst = rawAnsiAllowed && styler.enabled
    ? firstLine
    : symPrefix + highlightMessageBody(firstLine, styler);

  const guideIndent = ' '.repeat(tsRaw.length + 1) + styler.muted('│') + ' ';
  const outLines = [`${tsFormatted} ${badgeFormatted}${scopePart} ${renderedFirst}`];

  for (let i = 1; i < lines.length; i++) {
    const sub = lines[i];
    if (!sub.trim() && i === lines.length - 1) continue;
    const isTrace = /^\s*at\s+/.test(sub) || /^(Caused by|Error|TypeError|RangeError|SyntaxError|TimeoutError):/.test(sub.trim());
    const renderedSub = isTrace
      ? styler.muted(sub.trim())
      : (rawAnsiAllowed && styler.enabled ? sub : highlightMessageBody(sub, styler));
    outLines.push(`${guideIndent}${renderedSub}`);
  }

  return outLines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ANSI-Aware Table Formatting Engine (Section 6)
// ─────────────────────────────────────────────────────────────────────────────

function renderTable(options = {}) {
  const {
    columns = [],
    rows = [],
    title = null,
    footer = null,
    maxWidth = getTerminalWidth(),
    styler = theme,
    indent = '',
  } = options;

  if (!columns.length) return '';

  const numCols = columns.length;
  const availWidth = Math.max(40, maxWidth - indent.length);

  const normRows = rows.map((row) => {
    const isRowError = Boolean(row && row._rowRole === 'error');
    const isRowWarn = Boolean(row && row._rowRole === 'warning');
    const cells = columns.map((col, idx) => {
      const rawVal = Array.isArray(row) ? row[idx] : (row ? row[col.key ?? idx] : undefined);
      if (rawVal === null || rawVal === undefined || rawVal === '') {
        return styler.muted('—');
      }
      let formatted = typeof col.format === 'function' ? col.format(rawVal, row) : String(rawVal);
      if (isRowError && stripAnsi(formatted) === formatted) {
        formatted = styler.error(formatted);
      } else if (isRowWarn && stripAnsi(formatted) === formatted) {
        formatted = styler.warning(formatted);
      }
      return formatted;
    });
    return { cells, _rowRole: row && row._rowRole };
  });

  const colWidths = columns.map((col, idx) => {
    const headerW = visibleLength(col.header || '');
    const cellMax = normRows.reduce((max, r) => Math.max(max, visibleLength(r.cells[idx])), 0);
    let w = Math.max(headerW, cellMax, col.minWidth || 2);
    if (col.maxWidth) w = Math.min(w, col.maxWidth);
    return w;
  });

  const overhead = 2 + (numCols - 1) + numCols * 2;
  let totalContentW = colWidths.reduce((a, b) => a + b, 0);

  if (totalContentW + overhead > availWidth) {
    const targetContentW = Math.max(numCols * 3, availWidth - overhead);
    while (totalContentW > targetContentW) {
      let maxIdx = 0;
      for (let i = 1; i < numCols; i++) {
        if (colWidths[i] > colWidths[maxIdx]) maxIdx = i;
      }
      if (colWidths[maxIdx] <= 3) break;
      colWidths[maxIdx]--;
      totalContentW--;
    }
  }

  const innerBoxWidth = colWidths.reduce((a, b) => a + b, 0) + (numCols - 1) + numCols * 2;
  const b = (ch) => styler.muted(ch);
  const out = [];

  if (title) {
    out.push(indent + b(BOX.tl + BOX.h.repeat(innerBoxWidth) + BOX.tr));
    const titleStr = truncateAnsi(title, innerBoxWidth - 2);
    out.push(indent + b(BOX.v) + ' ' + padAnsi(styler.primary(titleStr), innerBoxWidth - 2, 'left') + ' ' + b(BOX.v));
    const midTop = colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.tt);
    out.push(indent + b(BOX.lt + midTop + BOX.rt));
  } else {
    const topSegs = colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.tt);
    out.push(indent + b(BOX.tl + topSegs + BOX.tr));
  }

  const headerCells = columns.map((col, i) => {
    const hText = truncateAnsi(col.header || '', colWidths[i]);
    const aligned = padAnsi(styler.primary(hText), colWidths[i], col.align || 'left');
    return ' ' + aligned + ' ';
  });
  out.push(indent + b(BOX.v) + headerCells.join(b(BOX.v)) + b(BOX.v));

  const headSepSegs = colWidths.map(w => BOX.hDouble.repeat(w + 2)).join(BOX.crossDouble);
  out.push(indent + b(BOX.ltDouble + headSepSegs + BOX.rtDouble));

  if (!normRows.length) {
    const emptyMsg = styler.muted('No entries to display');
    const emptyLine = columns.map((_, i) => i === 0 ? ' ' + padAnsi(truncateAnsi(emptyMsg, colWidths[0]), colWidths[0]) + ' ' : ' ' + ' '.repeat(colWidths[i]) + ' ');
    out.push(indent + b(BOX.v) + emptyLine.join(b(BOX.v)) + b(BOX.v));
  } else {
    for (const r of normRows) {
      const rowCells = columns.map((col, i) => {
        const val = truncateAnsi(r.cells[i], colWidths[i]);
        const rawClean = stripAnsi(val).trim();
        const isNumeric = /^[$+-]?\d[\d,._]*(?:\s*(?:ms|s|m|h|MB|GB|KB|%|k|M|B))?$/i.test(rawClean);
        const align = col.align || (isNumeric ? 'right' : 'left');
        return ' ' + padAnsi(val, colWidths[i], align) + ' ';
      });
      out.push(indent + b(BOX.v) + rowCells.join(b(BOX.v)) + b(BOX.v));
    }
  }

  if (footer) {
    const botMid = colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.bt);
    out.push(indent + b(BOX.lt + botMid + BOX.rt));
    const footStr = truncateAnsi(footer, innerBoxWidth - 2);
    out.push(indent + b(BOX.v) + ' ' + padAnsi(footStr, innerBoxWidth - 2, 'left') + ' ' + b(BOX.v));
    out.push(indent + b(BOX.bl + BOX.h.repeat(innerBoxWidth) + BOX.br));
  } else {
    const botSegs = colWidths.map(w => BOX.h.repeat(w + 2)).join(BOX.bt);
    out.push(indent + b(BOX.bl + botSegs + BOX.br));
  }

  return out.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Complete Dashboard Re-architecture (Section 4)
// ─────────────────────────────────────────────────────────────────────────────

function renderDashboard(manager, options = {}) {
  const styler = options.styler || theme;
  const termWidth = Math.min(options.maxWidth || getTerminalWidth(), 108);
  const innerWidth = Math.max(56, termWidth - 2);
  const b = (ch) => styler.muted(ch);

  const summary = manager && typeof manager.getSummary === 'function'
    ? manager.getSummary()
    : { total: 0, counts: {}, totalPpsIn: 0, totalPpsOut: 0, avgPing: -1, systemMetrics: {} };
  const sys = summary.systemMetrics || (manager && typeof manager.getSystemMetrics === 'function' ? manager.getSystemMetrics() : {});
  const counts = summary.counts || {};
  const bots = (manager && Array.isArray(manager.bots)) ? manager.bots : [];

  const onlineCount = counts.ONLINE || 0;
  const connectingCount = (counts.CONNECTING || 0) + (counts.AUTHENTICATING || 0) + (counts.SPAWNING || 0) + (counts.RECONNECTING || 0);
  const offlineCount = Math.max(0, (summary.total || 0) - onlineCount - connectingCount);

  let spawnerProtectActive = 0;
  let autoSellSpawnActive = 0;
  let afkActive = 0;
  let totalReconnects = 0;
  let totalMoney = 0;
  let totalShard = 0;
  for (const bot of bots) {
    const s = bot.getSummary ? bot.getSummary() : {};
    if (s.spawnerProtect > 0) spawnerProtectActive++;
    if (s.autoSellSpawn > 0) autoSellSpawnActive++;
    if (s.afk) afkActive++;
    totalReconnects += s.reconnects || 0;
    totalMoney += s.money || 0;
    totalShard += s.shard || 0;
  }

  const webRunning = Boolean(manager && manager.dashboard && manager.dashboard.isRunning);
  const webPort = (manager && manager.dashboard && manager.dashboard.port) || 3000;
  const tgEnabled = Boolean(manager && manager.telegram && manager.telegram.enabled);
  const whEnabled = Boolean((manager && manager.notifier && manager.notifier.enabled) || (manager && manager.revenueNotifier && manager.revenueNotifier.enabled));
  const proxies = (manager && manager.proxyManager && typeof manager.proxyManager.getSummaries === 'function')
    ? manager.proxyManager.getSummaries()
    : [];
  const liveProxies = proxies.filter(p => !['dead', 'die', 'auth_fail', 'timeout'].includes(p.status)).length;
  const sched = (manager && typeof manager.getSchedule === 'function') ? manager.getSchedule() : { enabled: false };

  let overallState = 'READY';
  if (onlineCount > 0) overallState = 'RUNNING';
  else if (connectingCount > 0) overallState = 'CONNECTING';
  else if (summary.total > 0 && offlineCount === summary.total) overallState = 'IDLE';

  const versionLabel = 'v2.0';
  const leftHeader = ` ${SYMBOLS.bolt} ${styler.primary('ANTERTOOL PREMIUM V2')}  ${styler.muted('•')}  ${styler.info('Antares Bot Manager')}`;
  const rightHeader = `${styler.muted(versionLabel)} ${styler.muted('•')} ${formatStatusPill(overallState, styler)} `;
  const headerGap = Math.max(1, innerWidth - visibleLength(leftHeader) - visibleLength(rightHeader));

  const lines = [];
  lines.push(b(BOX.tl + BOX.h.repeat(innerWidth) + BOX.tr));
  lines.push(b(BOX.v) + leftHeader + ' '.repeat(headerGap) + rightHeader + b(BOX.v));

  const kvLine = (label, val) => {
    const k = styler.muted(label.padEnd(13, ' '));
    return ` ${k}: ${val}`;
  };

  const fmtCounter = (n, warnColor = 'warning') => {
    if (!n || n <= 0) return styler.muted('0');
    return warnColor === 'error' ? styler.errorBold(String(n)) : styler.warningBold(String(n));
  };

  const memHeapMB = sys.procHeap ? Math.round(sys.procHeap / 1024 / 1024) : 0;
  const memTotalGB = sys.totalMem ? (sys.totalMem / 1024 / 1024 / 1024).toFixed(1) : '0.0';
  const memPct = sys.memPercent || 0;
  const uptimeSec = Math.floor(process.uptime());
  const upH = Math.floor(uptimeSec / 3600);
  const upM = Math.floor((uptimeSec % 3600) / 60);
  const upS = uptimeSec % 60;

  const leftTitle = ` ${styler.primary('SYSTEM & BOT TELEMETRY')}`;
  const leftRows = [
    kvLine('State', formatStatusPill(overallState, styler)),
    kvLine('Loaded Bots', `${styler.primary(String(summary.total || 0))} total (${styler.success(onlineCount + ' on')} / ${styler.muted(offlineCount + ' off')})`),
    kvLine('Active Tasks', `${styler.info(afkActive + ' AFK')} · ${styler.ai(autoSellSpawnActive + ' Sell')} · ${styler.success(spawnerProtectActive + ' Guard')}`),
    kvLine('Memory / RAM', `${styler.primary(memHeapMB + 'MB')} heap / ${memTotalGB}GB (${memPct >= 80 ? styler.warning(memPct + '%') : styler.info(memPct + '%')})`),
    kvLine('Runtime', `Node ${sys.nodeVersion || process.version} · Up ${upH}h ${upM}m ${upS}s`),
    kvLine('Economy', `${styler.key('$' + totalMoney.toLocaleString())} · ${styler.ai('✦ ' + totalShard.toLocaleString())}`),
  ];

  const rightTitle = ` ${styler.primary('ENGINE & CONNECTIVITY')}`;
  const aiStatus = (spawnerProtectActive > 0 || autoSellSpawnActive > 0)
    ? `${styler.ai('✦')} ${styler.aiBold('ACTIVE')} (${spawnerProtectActive + autoSellSpawnActive} flows)`
    : `${styler.ai('✦')} ${styler.aiBold('READY')}`;
  const webStatus = webRunning
    ? `${styler.success('●')} ${styler.successBold('ONLINE')} (${styler.path(':' + webPort)})`
    : `${styler.muted('●')} ${styler.muted('OFFLINE')}`;
  const netStatus = onlineCount > 0
    ? `${styler.success('●')} ${styler.successBold('CONNECTED')} (${summary.avgPing >= 0 ? summary.avgPing + 'ms' : 'N/A'})`
    : (connectingCount > 0 ? `${styler.warning('●')} ${styler.warningBold('HANDSHAKING')} (${connectingCount})` : `${styler.muted('●')} ${styler.muted('STANDBY')}`);
  const notifyStatus = [
    tgEnabled ? styler.success('TG:ON') : styler.muted('TG:OFF'),
    whEnabled ? styler.success('Discord:ON') : styler.muted('Discord:OFF'),
    sched.enabled ? styler.info(`Sched:${sched.outTime}→${sched.inTime}`) : styler.muted('Sched:OFF'),
  ].join(' · ');

  const rightRows = [
    kvLine('Smart Engine', aiStatus),
    kvLine('Connection', netStatus),
    kvLine('Web Server', webStatus),
    kvLine('Proxy Pool', `${styler.primary(String(proxies.length))} loaded (${styler.success(liveProxies + ' ready')})`),
    kvLine('Integrations', notifyStatus),
    kvLine('Reconnects', `${fmtCounter(totalReconnects, 'warning')} retries · Pkt ${summary.totalPpsIn || 0}↓ ${summary.totalPpsOut || 0}↑/s`),
  ];

  if (innerWidth >= 74) {
    const leftW = Math.floor((innerWidth - 1) / 2);
    const rightW = innerWidth - 1 - leftW;

    lines.push(b(BOX.lt + BOX.h.repeat(leftW) + BOX.tt + BOX.h.repeat(rightW) + BOX.rt));
    lines.push(
      b(BOX.v) + padAnsi(truncateAnsi(leftTitle, leftW), leftW) +
      b(BOX.v) + padAnsi(truncateAnsi(rightTitle, rightW), rightW) +
      b(BOX.v)
    );
    lines.push(b(BOX.lt + BOX.h.repeat(leftW) + BOX.cross + BOX.h.repeat(rightW) + BOX.rt));

    const rowCount = Math.max(leftRows.length, rightRows.length);
    for (let i = 0; i < rowCount; i++) {
      const lRaw = leftRows[i] ? kvLineFromRaw(leftRows[i], leftW) : ' '.repeat(leftW);
      const rRaw = rightRows[i] ? kvLineFromRaw(rightRows[i], rightW) : ' '.repeat(rightW);
      lines.push(b(BOX.v) + lRaw + b(BOX.v) + rRaw + b(BOX.v));
    }
    lines.push(b(BOX.bl + BOX.h.repeat(leftW) + BOX.bt + BOX.h.repeat(rightW) + BOX.br));
  } else {
    lines.push(b(BOX.lt + BOX.h.repeat(innerWidth) + BOX.rt));
    lines.push(b(BOX.v) + padAnsi(truncateAnsi(leftTitle, innerWidth), innerWidth) + b(BOX.v));
    for (const r of leftRows) {
      lines.push(b(BOX.v) + kvLineFromRaw(r, innerWidth) + b(BOX.v));
    }
    lines.push(b(BOX.lt + BOX.h.repeat(innerWidth) + BOX.rt));
    lines.push(b(BOX.v) + padAnsi(truncateAnsi(rightTitle, innerWidth), innerWidth) + b(BOX.v));
    for (const r of rightRows) {
      lines.push(b(BOX.v) + kvLineFromRaw(r, innerWidth) + b(BOX.v));
    }
    lines.push(b(BOX.bl + BOX.h.repeat(innerWidth) + BOX.br));
  }

  return lines.join('\n');
}

function kvLineFromRaw(str, width) {
  return padAnsi(truncateAnsi(str, width - 1), width, 'left');
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Startup Sequence & Initialization Tables (Section 5)
// ─────────────────────────────────────────────────────────────────────────────

function renderStartupBanner(meta = {}, styler = theme) {
  const termWidth = Math.min(meta.maxWidth || getTerminalWidth(), 96);
  const innerWidth = Math.max(54, termWidth - 2);
  const b = (ch) => styler.muted(ch);

  const appName = meta.appName || 'ANTERTOOL PREMIUM V2';
  const subtitle = meta.subtitle || 'Antares Mine Bot Manager • High-Contrast TUI';
  const version = meta.version || 'v2.0';
  const mode = meta.mode || (process.env.NODE_ENV === 'production' ? 'PRODUCTION' : 'INTERACTIVE');
  const runtime = `Node ${process.version} • ${process.platform}/${process.arch}`;

  const top = b(BOX.tl + BOX.h.repeat(innerWidth) + BOX.tr);
  const sep = b(BOX.lt + BOX.h.repeat(innerWidth) + BOX.rt);
  const bot = b(BOX.bl + BOX.h.repeat(innerWidth) + BOX.br);

  const line1Left = `  ${styler.ai('✦')} ${styler.primary(appName)}  ${styler.muted('—')}  ${styler.info(subtitle)}`;
  const line1Right = `${formatBadge(mode, mode === 'PRODUCTION' ? 'ai' : 'info', styler)} `;

  const line2Left = `  ${styler.muted('Runtime:')} ${styler.white(runtime)}   ${styler.muted('Version:')} ${styler.key(version)}`;
  const line2Right = `${styler.muted('PID ' + process.pid)} `;

  return [
    top,
    b(BOX.v) + padAnsi(truncateAnsi(line1Left, innerWidth - visibleLength(line1Right) - 1), innerWidth - visibleLength(line1Right)) + line1Right + b(BOX.v),
    sep,
    b(BOX.v) + padAnsi(truncateAnsi(line2Left, innerWidth - visibleLength(line2Right) - 1), innerWidth - visibleLength(line2Right)) + line2Right + b(BOX.v),
    bot,
  ].join('\n');
}

function renderStartupTable(checks = [], summaryMeta = {}, styler = theme) {
  const maxWidth = Math.min(summaryMeta.maxWidth || getTerminalWidth(), 96);

  const rows = checks.map((c) => {
    const statusUpper = String(c.status || 'OK').toUpperCase();
    let role = c.role;
    if (!role) {
      if (['OK', 'READY', 'CONNECTED', 'ONLINE'].includes(statusUpper)) role = 'success';
      else if (['AI', 'MODEL'].includes(statusUpper)) role = 'ai';
      else if (['WARN', 'WARNING', 'SKIPPED', 'RETRY'].includes(statusUpper)) role = 'warning';
      else if (['FAIL', 'FAILED', 'ERROR', 'OFFLINE'].includes(statusUpper)) role = 'error';
      else role = 'info';
    }
    return {
      step: styler.white(c.step),
      badge: formatBadge(statusUpper, role, styler),
      detail: role === 'error' ? styler.error(c.detail || '') : (role === 'warning' ? styler.warning(c.detail || '') : styler.muted(c.detail || '')),
      time: typeof c.durationMs === 'number' ? styler.duration(`${c.durationMs}ms`) : styler.muted('—'),
      _rowRole: role === 'error' ? 'error' : undefined,
    };
  });

  const {
    totalBots = 0,
    warnings = 0,
    skipped = 0,
    errors = 0,
    bootMs = 0,
    ready = errors === 0,
  } = summaryMeta;

  const stateBadge = ready
    ? formatBadge('READY', 'success', styler)
    : formatBadge('FAILED', 'error', styler);

  const warnText = warnings > 0 ? styler.warningBold(`${warnings} warn`) : styler.muted('0 warn');
  const skipText = skipped > 0 ? styler.warning(`${skipped} skipped`) : styler.muted('0 skipped');
  const errText = errors > 0 ? styler.errorBold(`${errors} errors`) : styler.muted('0 errors');

  const footer = `${stateBadge}  Bots: ${styler.primary(String(totalBots))}  •  ${warnText}  •  ${skipText}  •  ${errText}  •  Boot: ${styler.duration(bootMs + 'ms')}`;

  return renderTable({
    title: '⚡ INITIALIZATION & SYSTEM READINESS CHECKLIST',
    columns: [
      { key: 'step', header: 'COMPONENT / STAGE', align: 'left', minWidth: 16, maxWidth: 26 },
      { key: 'badge', header: 'STATUS', align: 'left', minWidth: 11, maxWidth: 13 },
      { key: 'detail', header: 'TELEMETRY & DETAILS', align: 'left', minWidth: 20, maxWidth: 44 },
      { key: 'time', header: 'TIME', align: 'right', minWidth: 6, maxWidth: 8 },
    ],
    rows,
    footer,
    maxWidth,
    styler,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Non-Intrusive Spinners & Progress Bars (Section 7)
// ─────────────────────────────────────────────────────────────────────────────

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const activeSpinners = new Set();

function cleanupAllSpinners() {
  for (const sp of activeSpinners) {
    sp.stop();
  }
}

process.on('exit', cleanupAllSpinners);

class Spinner {
  constructor(text = '', options = {}) {
    this.text = text;
    this.stream = options.stream || process.stdout;
    this.styler = options.styler || theme;
    this.interactive = options.interactive !== undefined
      ? Boolean(options.interactive)
      : detectInteractiveTTY(this.stream);
    this._frameIdx = 0;
    this._timer = null;
    this._active = false;
  }

  start(text) {
    if (text !== undefined) this.text = text;
    if (this._active) return this;
    this._active = true;
    activeSpinners.add(this);

    if (!this.interactive) {
      return this;
    }

    this._render();
    this._timer = setInterval(() => {
      this._frameIdx = (this._frameIdx + 1) % BRAILLE_FRAMES.length;
      this._render();
    }, 80);
    if (this._timer.unref) this._timer.unref();
    return this;
  }

  update(text) {
    this.text = text;
    if (this._active && this.interactive) this._render();
    return this;
  }

  _render() {
    if (!this.interactive || !this.stream) return;
    const frame = this.styler.info(BRAILLE_FRAMES[this._frameIdx]);
    const line = `\r\x1b[2K  ${frame} ${this.styler.white(this.text)}`;
    try { this.stream.write(line); } catch {}
  }

  clear() {
    if (this.interactive && this.stream) {
      try { this.stream.write('\r\x1b[2K'); } catch {}
    }
  }

  stop(finalMessage = null) {
    if (!this._active) return;
    this._active = false;
    activeSpinners.delete(this);
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.clear();
    if (finalMessage) {
      try { this.stream.write(finalMessage + '\n'); } catch {}
    }
  }

  succeed(msg) {
    const text = msg || this.text;
    this.stop(formatLogEntry({ level: 'ok', msg: text }, this.styler));
  }

  fail(msg) {
    const text = msg || this.text;
    this.stop(formatLogEntry({ level: 'err', msg: text }, this.styler));
  }

  warn(msg) {
    const text = msg || this.text;
    this.stop(formatLogEntry({ level: 'warn', msg: text }, this.styler));
  }
}

function renderProgressBar(current, total, options = {}) {
  const width = options.width || 16;
  const styler = options.styler || theme;
  const safeTotal = Math.max(1, Number(total) || 1);
  const safeCur = Math.max(0, Math.min(safeTotal, Number(current) || 0));
  const ratio = safeCur / safeTotal;
  const pct = Math.round(ratio * 100);
  const filled = Math.round(ratio * width);
  const empty = Math.max(0, width - filled);

  const bar = styler.success('█'.repeat(filled)) + styler.muted('░'.repeat(empty));
  return `[${bar}] ${styler.primary(String(pct).padStart(3, ' ') + '%')}`;
}

function renderErrorBlock(title, errOrMsg, styler = theme) {
  const maxWidth = Math.min(getTerminalWidth(), 96);
  const innerWidth = Math.max(46, maxWidth - 2);
  const b = (ch) => styler.errorBold(ch);

  const rawText = errOrMsg instanceof Error ? (errOrMsg.stack || errOrMsg.message) : String(errOrMsg ?? '');
  const wrapped = wrapAnsi(cleanText(rawText), innerWidth - 2);

  const out = [
    b(BOX.tl + BOX.h.repeat(innerWidth) + BOX.tr),
    b(BOX.v) + ' ' + padAnsi(`${styler.errorBold(SYMBOLS.error + ' ' + String(title || 'CRITICAL ERROR').toUpperCase())}`, innerWidth - 2) + ' ' + b(BOX.v),
    b(BOX.lt + BOX.h.repeat(innerWidth) + BOX.rt),
  ];
  for (const l of wrapped) {
    out.push(b(BOX.v) + ' ' + padAnsi(styler.white(l), innerWidth - 2) + ' ' + b(BOX.v));
  }
  out.push(b(BOX.bl + BOX.h.repeat(innerWidth) + BOX.br));
  return out.join('\n');
}

module.exports = {
  ANSI_RE,
  SYMBOLS,
  BOX,
  LOG_LEVEL_MAP,
  detectColorSupport,
  detectInteractiveTTY,
  getTerminalWidth,
  stripAnsi,
  cleanText,
  createStyler,
  theme,
  formatBadge,
  formatStatusPill,
  codePointWidth,
  visibleLength,
  truncateAnsi,
  padAnsi,
  wrapAnsi,
  formatTimestamp,
  highlightMessageBody,
  formatLogEntry,
  renderTable,
  renderDashboard,
  renderStartupBanner,
  renderStartupTable,
  Spinner,
  cleanupAllSpinners,
  renderProgressBar,
  renderErrorBlock,
};
