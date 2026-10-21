'use strict';

/**
 * Terminal capabilities detection (color depth, Unicode support, interactivity, width, height).
 * Detects once and refreshes width/height on terminal resize.
 */

const UNICODE_SYMBOLS = Object.freeze({
  ok: '✔',
  fail: '✖',
  warn: '▲',
  bullet: '●',
  dash: '─',
  vbar: '│',
  ellipsis: '…',
  arrow: '→',
  guillemet: '»',
  gutter: '│',
  barFull: '█',
  barEmpty: '░',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
});

const ASCII_SYMBOLS = Object.freeze({
  ok: 'OK',
  fail: 'X',
  warn: '!',
  bullet: '*',
  dash: '-',
  vbar: '|',
  ellipsis: '...',
  arrow: '->',
  guillemet: '>',
  gutter: '|',
  barFull: '#',
  barEmpty: '-',
  spinner: ['-', '\\', '|', '/'],
});

const UNICODE_BORDERS = Object.freeze({
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  horizontal: '─',
  vertical: '│',
  topMid: '┬',
  bottomMid: '┴',
  leftMid: '├',
  rightMid: '┤',
  midMid: '┼',
});

const ASCII_BORDERS = Object.freeze({
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  topMid: '+',
  bottomMid: '+',
  leftMid: '+',
  rightMid: '+',
  midMid: '+',
});

function parseCliFlags(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : [];
  let forceColor = null;
  let noColor = false;
  let plain = false;
  let ascii = false;
  let dashboard = false;

  for (const raw of args) {
    const a = String(raw || '').trim();
    if (a === '--plain' || a === '--no-ansi') {
      plain = true;
      noColor = true;
      ascii = true;
    } else if (a === '--no-color' || a === '--color=false' || a === '--color=0' || a === '--color=never') {
      noColor = true;
      forceColor = 0;
    } else if (a === '--ascii' || a === '--no-unicode') {
      ascii = true;
    } else if (a === '--color' || a === '--color=true' || a === '--color=1' || a === '--color=always') {
      forceColor = 16;
      noColor = false;
    } else if (a === '--color=256') {
      forceColor = 256;
      noColor = false;
    } else if (a === '--color=truecolor' || a === '--color=16m' || a === '--color=24bit') {
      forceColor = 16777216;
      noColor = false;
    } else if (a === '--dashboard' || a === '--tui') {
      dashboard = true;
    }
  }

  return { forceColor, noColor, plain, ascii, dashboard };
}

function detectColorDepth({ stream, env, flags, config }) {
  const cfg = config || {};
  const uiCfg = cfg.ui || {};

  // 1. Explicit CLI disable or plain config
  if (flags.plain || flags.noColor || cfg.plain === true || cfg.noColor === true || cfg.color === false || uiCfg.plain === true || uiCfg.color === false) {
    return 0;
  }

  // 2. Explicit CLI force
  if (typeof flags.forceColor === 'number') {
    return flags.forceColor;
  }

  // 3. Environment variables: NO_COLOR vs FORCE_COLOR
  const hasNoColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const hasPlainEnv = /^(1|true|on|yes)$/i.test(String(env.ANTER_PLAIN || env.PLAIN || ''));
  if (hasPlainEnv) return 0;

  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '') {
    const fc = String(env.FORCE_COLOR).trim().toLowerCase();
    if (fc === '0' || fc === 'false') return 0;
    if (hasNoColor) return 0;
    if (fc === '3' || fc === 'truecolor') return 16777216;
    if (fc === '2' || fc === '256') return 256;
    return 16;
  }

  if (hasNoColor) return 0;

  // 4. TERM=dumb or non-TTY output
  const term = String(env.TERM || '').toLowerCase();
  if (term === 'dumb') return 0;
  const isTTY = Boolean(stream && stream.isTTY);
  if (!isTTY) return 0;

  // 5. Truecolor / 256-color detection
  const colorTerm = String(env.COLORTERM || '').toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 16777216;
  const termProg = String(env.TERM_PROGRAM || '');
  if (['iTerm.app', 'WezTerm', 'vscode', 'Hyper'].includes(termProg)) return 16777216;
  if (env.WT_SESSION) return 16777216;
  if (term.includes('truecolor') || term.includes('24bit')) return 16777216;
  if (term.includes('256color') || termProg === 'Apple_Terminal') return 256;

  if (stream && typeof stream.getColorDepth === 'function') {
    try {
      const bits = stream.getColorDepth(env);
      if (bits >= 24) return 16777216;
      if (bits >= 8) return 256;
      if (bits >= 4) return 16;
      return 0;
    } catch {
      // ignore and fall back to 16
    }
  }

  return 16;
}

function detectUnicode({ env, platform, flags, config }) {
  const cfg = config || {};
  const uiCfg = cfg.ui || {};

  if (flags.plain || flags.ascii || cfg.plain === true || cfg.ascii === true || cfg.unicode === false || uiCfg.plain === true || uiCfg.unicode === false) {
    return false;
  }
  if (/^(1|true|on|yes)$/i.test(String(env.ANTER_PLAIN || env.ANTER_ASCII || ''))) {
    return false;
  }
  const term = String(env.TERM || '').toLowerCase();
  if (term === 'dumb' || term === 'linux') return false;
  if (env.NCURSES_NO_UTF8_ACS === '1') return false;

  const locale = String(env.LC_ALL || env.LC_CTYPE || env.LANG || '').toLowerCase();
  if (locale === 'c' || locale === 'posix' || (locale && !locale.includes('utf-8') && !locale.includes('utf8') && locale.includes('ascii'))) {
    return false;
  }

  if (platform === 'win32') {
    if (env.WT_SESSION || env.ConEmuANSI === 'ON' || env.TERM_PROGRAM || term.includes('xterm') || term.includes('cygwin') || term.includes('msys') || locale.includes('utf')) {
      return true;
    }
    return false;
  }

  return true;
}

function detectDimensions(stream, env) {
  let width = 80;
  let height = 24;
  if (stream && typeof stream.columns === 'number' && stream.columns > 0) {
    width = stream.columns;
  } else if (env && Number(env.COLUMNS) > 0) {
    width = Number(env.COLUMNS);
  }
  if (stream && typeof stream.rows === 'number' && stream.rows > 0) {
    height = stream.rows;
  } else if (env && Number(env.LINES) > 0) {
    height = Number(env.LINES);
  }
  return { width, height };
}

function detectCapabilities(options = {}) {
  const stream = options.stream !== undefined ? options.stream : process.stdout;
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const config = options.config || {};
  const platform = options.platform || process.platform;

  const flags = parseCliFlags(argv);
  const colorDepth = options.color !== undefined
    ? (options.color ? (options.colorDepth || 16) : 0)
    : (options.colorDepth !== undefined ? options.colorDepth : detectColorDepth({ stream, env, flags, config }));
  const color = colorDepth > 0;
  const unicode = options.unicode !== undefined
    ? Boolean(options.unicode)
    : detectUnicode({ env, platform, flags, config });
  const isTTY = Boolean(stream && stream.isTTY);
  const term = String(env.TERM || '').toLowerCase();
  const interactive = options.interactive !== undefined
    ? Boolean(options.interactive)
    : (isTTY && term !== 'dumb' && !flags.plain && config.plain !== true);

  const dims = detectDimensions(stream, env);
  const width = options.width !== undefined && options.width > 0 ? options.width : dims.width;
  const height = options.height !== undefined && options.height > 0 ? options.height : dims.height;

  const listeners = new Set();
  const caps = {
    color,
    colorDepth,
    truecolor: colorDepth >= 16777216,
    color256: colorDepth >= 256,
    unicode,
    interactive,
    plain: !color && !unicode,
    width,
    height,
    flags,
    symbols: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
    borders: unicode ? UNICODE_BORDERS : ASCII_BORDERS,
    refresh() {
      const next = detectDimensions(stream, env);
      if (options.width === undefined) caps.width = next.width;
      if (options.height === undefined) caps.height = next.height;
      for (const fn of listeners) {
        try { fn(caps); } catch { /* ignore listener errors */ }
      }
      return caps;
    },
    onResize(fn) {
      if (typeof fn === 'function') listeners.add(fn);
      return () => listeners.delete(fn);
    },
    destroy() {
      if (stream && typeof stream.removeListener === 'function' && caps._onResize) {
        stream.removeListener('resize', caps._onResize);
      }
      listeners.clear();
    },
  };

  if (stream && typeof stream.on === 'function' && options.listenResize !== false) {
    caps._onResize = () => caps.refresh();
    stream.on('resize', caps._onResize);
    if (typeof stream.setMaxListeners === 'function') {
      try { stream.setMaxListeners(Math.max(20, stream.getMaxListeners ? stream.getMaxListeners() : 10)); } catch { /* ignore */ }
    }
  }

  return caps;
}

module.exports = {
  UNICODE_SYMBOLS,
  ASCII_SYMBOLS,
  UNICODE_BORDERS,
  ASCII_BORDERS,
  parseCliFlags,
  detectColorDepth,
  detectUnicode,
  detectDimensions,
  detectCapabilities,
};
