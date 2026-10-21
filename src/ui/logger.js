'use strict';

/**
 * Unified Terminal Logger.
 * Format:
 *   [19:25:10] [INFO]    Connected to server successfully.
 *   [19:25:11] [SUCCESS] Configuration loaded.
 *   [19:25:12] [WARNING] Retry attempt 2/5.
 *   [19:25:13] [ERROR]   Failed to initialize module.
 *   [19:25:14] [AI]      Analyzing diagnostic information...
 *   [19:25:15] [DEBUG]   Module initialization completed.
 *   [19:25:16] [SERVER]  [bot-1] <Player> Hello!
 */

const RingBuffer = require('../core/RingBuffer');
const { sanitizeUntrusted, redactSecretsInText } = require('./text');

const LEVEL_MAP = Object.freeze({
  info: 'INFO',
  sys: 'INFO',
  afk: 'INFO',
  proxy: 'INFO',
  ok: 'SUCCESS',
  success: 'SUCCESS',
  warn: 'WARNING',
  warning: 'WARNING',
  health: 'WARNING',
  err: 'ERROR',
  error: 'ERROR',
  fatal: 'ERROR',
  debug: 'DEBUG',
  ai: 'AI',
  shard: 'AI',
  server: 'SERVER',
  chat: 'SERVER',
});

const LEVEL_SEVERITY = Object.freeze({
  DEBUG: 10,
  INFO: 20,
  SERVER: 20,
  AI: 25,
  SUCCESS: 30,
  WARNING: 40,
  ERROR: 50,
});

// Prefix width is "[19:25:10] [SUCCESS] " = 11 + 10 = 21 characters (message starts at index 21).
// Continuation gutter aligns under index 21: 19 spaces + 1 gutter char + 1 space = 21 characters.
const GUTTER_INDENT = ' '.repeat(19);

function formatTimestamp(ms = Date.now(), tz = null) {
  const d = new Date(ms || Date.now());
  if (tz) {
    try {
      const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: tz,
          hourCycle: 'h23',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }).formatToParts(d).map(x => [x.type, x.value])
      );
      return `${parts.hour}:${parts.minute}:${parts.second}`;
    } catch {
      // fall back to local time
    }
  }
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function normalizeLevel(rawLevel) {
  const key = String(rawLevel || 'info').trim().toLowerCase();
  return LEVEL_MAP[key] || 'INFO';
}

function styleLevelTag(levelName, theme) {
  const bracketed = `[${levelName}]`;
  const padSpaces = ' '.repeat(Math.max(1, 10 - bracketed.length));
  if (!theme) return bracketed + padSpaces;
  let styled;
  switch (levelName) {
    case 'SUCCESS':
      styled = theme.success(bracketed);
      break;
    case 'WARNING':
      styled = theme.warning(bracketed);
      break;
    case 'ERROR':
      styled = theme.fatal(bracketed);
      break;
    case 'DEBUG':
      styled = theme.debug(bracketed);
      break;
    case 'AI':
      styled = theme.ai(bracketed);
      break;
    case 'SERVER':
    case 'INFO':
    default:
      styled = theme.info(bracketed);
      break;
  }
  return styled + padSpaces;
}

/**
 * Format an Error (including nested .cause chains) into readable lines:
 * - First line in error color
 * - Stack frames dimmed with file:line:col locations highlighted
 */
function formatExceptionLines(err, { theme, secrets = [] } = {}) {
  const out = [];
  const seen = new Set();

  const walk = (current, isCause = false) => {
    if (!current || (typeof current === 'object' && seen.has(current))) return;
    if (typeof current === 'object') seen.add(current);

    const rawStack = current instanceof Error
      ? (current.stack || `${current.name || 'Error'}: ${current.message}`)
      : String(current);
    const cleanStack = redactSecretsInText(sanitizeUntrusted(rawStack), secrets);
    const lines = cleanStack.split('\n');

    const headRaw = isCause ? `Caused by: ${lines[0] || ''}` : (lines[0] || 'Error');
    out.push(theme ? theme.error(headRaw) : headRaw);

    for (let i = 1; i < lines.length; i++) {
      const frame = lines[i].trim();
      if (!frame) continue;
      // Highlight file:line:col inside stack frames while keeping frame text dim
      const m = /^(at\s+.*?\()([^)]+:\d+:\d+)(\))$/.exec(frame) || /^(at\s+)([^\s()]+\:\d+\:\d+)$/.exec(frame);
      if (m && theme) {
        if (m.length === 4) {
          out.push(`  ${theme.muted(m[1])}${theme.key(m[2])}${theme.muted(m[3])}`);
        } else {
          out.push(`  ${theme.muted(m[1])}${theme.key(m[2])}`);
        }
      } else {
        out.push(`  ${theme ? theme.muted(frame) : frame}`);
      }
    }

    if (current && typeof current === 'object' && current.cause) {
      walk(current.cause, true);
    }
  };

  walk(err, false);
  return out;
}

/**
 * Pure function to format a log entry into one or more aligned lines.
 */
function formatLogLines(entry, { caps, theme, secrets = [], tz = null } = {}) {
  const levelName = normalizeLevel(entry && entry.level);
  const timeText = `[${formatTimestamp(entry && entry.time, tz)}]`;
  const styledTime = theme ? theme.muted(timeText) : timeText;
  const styledLevel = styleLevelTag(levelName, theme);
  const prefix = `${styledTime} ${styledLevel}`;

  const sym = (caps && caps.symbols) || { gutter: '|', guillemet: '>' };
  const gutterPrefix = `${GUTTER_INDENT}${theme ? theme.muted(sym.gutter) : sym.gutter} `;

  const botTag = entry && entry.botId ? `[${sanitizeUntrusted(entry.botId)}] ` : '';
  let contentLines = [];

  if (entry && entry.err instanceof Error) {
    const headerMsg = entry.msg
      ? `${botTag}${redactSecretsInText(sanitizeUntrusted(entry.msg), secrets)}`
      : '';
    const errLines = formatExceptionLines(entry.err, { theme, secrets });
    if (headerMsg) {
      errLines[0] = `${theme ? theme.error(headerMsg) : headerMsg} — ${errLines[0]}`;
    }
    contentLines = errLines;
  } else if (entry && entry.msg instanceof Error) {
    const errLines = formatExceptionLines(entry.msg, { theme, secrets });
    if (botTag) {
      errLines[0] = `${theme ? theme.error(botTag) : botTag}${errLines[0]}`;
    }
    contentLines = errLines;
  } else if (entry && entry.serverChat) {
    // Formatted game server chat line (at most 3 styles: dim time, cyan [SERVER], optional bold sender)
    const sc = entry.serverChat;
    const cleanContent = redactSecretsInText(sanitizeUntrusted(sc.content || sc.clean || entry.msg || ''), secrets);
    if (sc.kind === 'player' && sc.sender) {
      const cleanSender = sanitizeUntrusted(sc.sender);
      const senderTag = theme ? theme.key(`<${cleanSender}>`) : `<${cleanSender}>`;
      contentLines = [`${botTag}${senderTag} ${cleanContent}`];
    } else if (sc.kind === 'broadcast' && sc.isServerWide) {
      contentLines = [`[Server] ${sym.guillemet} ${cleanContent}`];
    } else {
      contentLines = [`${botTag}${sym.guillemet} ${cleanContent}`];
    }
  } else {
    const rawMsg = entry && entry.msg !== undefined && entry.msg !== null ? String(entry.msg) : '';
    const sanitized = redactSecretsInText(sanitizeUntrusted(rawMsg), secrets);
    const fullText = `${botTag}${sanitized}`;
    const rawLines = fullText.split('\n');
    contentLines = rawLines.map(line => (levelName === 'ERROR' && theme ? theme.error(line) : line));
  }

  if (!contentLines.length) contentLines = [''];

  const out = [`${prefix}${contentLines[0]}`];
  for (let i = 1; i < contentLines.length; i++) {
    out.push(`${gutterPrefix}${contentLines[i]}`);
  }

  return out.map(l => (theme ? theme.finalizeLine(l) : l));
}

class Logger {
  constructor(options = {}) {
    this.writer = options.writer;
    this.caps = options.caps || (this.writer && this.writer.caps);
    this.theme = options.theme || (this.writer && this.writer.theme);
    this.getSecrets = typeof options.getSecrets === 'function' ? options.getSecrets : () => [];
    this.getTz = typeof options.getTz === 'function' ? options.getTz : () => null;
    this.minLevel = String(options.minLevel || (process.env.ANTER_DEBUG ? 'DEBUG' : 'INFO')).toUpperCase();
    this.recentEvents = new RingBuffer(options.maxRecentEvents || 25);
  }

  setMinLevel(level) {
    this.minLevel = normalizeLevel(level);
  }

  _shouldLog(levelName) {
    if (levelName === 'DEBUG' && /^(1|true|on)$/i.test(String(process.env.ANTER_DEBUG || ''))) {
      return true;
    }
    const minSev = LEVEL_SEVERITY[this.minLevel] || LEVEL_SEVERITY.INFO;
    const sev = LEVEL_SEVERITY[levelName] || LEVEL_SEVERITY.INFO;
    return sev >= minSev;
  }

  format(entry) {
    return formatLogLines(entry, {
      caps: this.caps,
      theme: this.theme,
      secrets: this.getSecrets(),
      tz: this.getTz(),
    });
  }

  log(level, msg, extra = {}) {
    const levelName = normalizeLevel(level);
    const time = extra.time || Date.now();
    const entry = {
      level,
      levelName,
      msg,
      botId: extra.botId || null,
      err: extra.err || null,
      serverChat: extra.serverChat || null,
      time,
    };

    // Record warnings and errors into the bounded recentEvents buffer for the dashboard
    if (levelName === 'WARNING' || levelName === 'ERROR') {
      const cleanSummary = redactSecretsInText(
        sanitizeUntrusted(msg instanceof Error ? msg.message : String(msg ?? '')).split('\n')[0],
        this.getSecrets()
      );
      this.recentEvents.push({
        time,
        level: levelName,
        botId: entry.botId || 'system',
        msg: cleanSummary,
      });
    }

    if (!this._shouldLog(levelName)) return [];

    const lines = this.format(entry);
    if (this.writer) {
      this.writer.writeLines(lines, { stderr: Boolean(extra.stderr) });
    }
    return lines;
  }

  info(msg, extra) { return this.log('INFO', msg, extra); }
  success(msg, extra) { return this.log('SUCCESS', msg, extra); }
  warn(msg, extra) { return this.log('WARNING', msg, extra); }
  error(msg, extra) { return this.log('ERROR', msg, extra); }
  debug(msg, extra) { return this.log('DEBUG', msg, extra); }
  ai(msg, extra) { return this.log('AI', msg, extra); }
  server(msg, extra) { return this.log('SERVER', msg, extra); }

  getRecentEvents(limit = 8) {
    const all = this.recentEvents.toArray();
    return all.slice(-limit);
  }
}

module.exports = {
  LEVEL_MAP,
  LEVEL_SEVERITY,
  GUTTER_INDENT,
  formatTimestamp,
  normalizeLevel,
  formatExceptionLines,
  formatLogLines,
  Logger,
};
