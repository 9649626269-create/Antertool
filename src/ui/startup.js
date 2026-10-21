'use strict';

/**
 * Startup View & Initialization Step Tracker.
 * Shows application banner, initialization table (Step, Status, Details), and summary.
 * Every value comes from a real operation and monotonic clock.
 */

const fs = require('fs');
const path = require('path');
const { renderTable } = require('./table');
const { truncate, pad, visibleWidth, sanitizeUntrusted, redactSecretsInText } = require('./text');

const COMPACT_ASCII_ART = [
  '   ___         __            __            __',
  '  / _ | ___   / /____ ____  / /____  ___  / /',
  ' / __ |/ _ \\ / __/ _ `/ _ \\/ __/ _ \\/ _ \\/ / ',
  '/_/ |_/_//_/ \\__/\\_,_/_//_/\\__/\\___/\\___/_/  ',
];

function readAppMeta(pkgPath = path.join(__dirname, '..', '..', 'package.json')) {
  let name = 'antares-manager';
  let version = '1.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.name) name = String(pkg.name);
    if (pkg.version) version = String(pkg.version);
  } catch {
    // use defaults if package.json is unreadable
  }
  return {
    name,
    version,
    displayName: 'Antertool Premium v2',
    subtitle: `${name} v${version}`,
  };
}

/**
 * Pure function to render the startup banner.
 * Hides ASCII art in plain mode and on narrow terminals (< 60 cols).
 */
function renderBanner(meta = {}, caps = null, theme = null) {
  const info = { ...readAppMeta(), ...meta };
  const width = Math.max(20, (caps && caps.width) || 80);
  const ascii = !(caps && caps.unicode);
  const plain = !caps || !caps.color || Boolean(caps.plain);
  const b = (caps && caps.borders) || {
    topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|',
  };
  const borderFn = theme ? theme.border : (s => s);
  const titleFn = theme ? theme.title : (s => s);
  const mutedFn = theme ? theme.muted : (s => s);
  const accentFn = theme ? theme.accent : (s => s);

  // Plain mode or narrow terminal (< 60 cols): compact single-line header without ASCII art
  if (plain || width < 60) {
    const head = `${info.displayName} (${info.name} v${info.version})`;
    const sep = b.horizontal.repeat(Math.min(width, Math.max(20, visibleWidth(head))));
    return [
      truncate(titleFn(head), width, { ascii }),
      truncate(borderFn(sep), width, { ascii }),
    ];
  }

  const boxInner = Math.min(width - 4, 54);
  const top = borderFn(`${b.topLeft}${b.horizontal.repeat(boxInner + 2)}${b.topRight}`);
  const bot = borderFn(`${b.bottomLeft}${b.horizontal.repeat(boxInner + 2)}${b.bottomRight}`);
  const row = (content, align = 'center') => {
    const padded = pad(truncate(content, boxInner, { ascii }), boxInner, align);
    return `${borderFn(b.vertical)} ${padded} ${borderFn(b.vertical)}`;
  };

  const lines = [top];
  for (const artLine of COMPACT_ASCII_ART) {
    const colored = theme && typeof theme.bannerArt === 'function'
      ? theme.bannerArt(artLine)
      : accentFn(artLine);
    lines.push(row(colored, 'center'));
  }
  lines.push(row(`${titleFn(info.displayName)} ${mutedFn('•')} ${accentFn(info.subtitle)}`, 'center'));
  lines.push(bot);
  return lines;
}

/**
 * Pure function to render the initialization step table (columns: Step, Status, Details).
 */
function renderStartupTable(steps = [], caps = null, theme = null) {
  const columns = [
    { key: 'step', label: 'Step', align: 'left', minWidth: 10, maxWidth: 28, priority: 1 },
    { key: 'status', label: 'Status', align: 'left', minWidth: 8, maxWidth: 14, priority: 1, status: true },
    {
      key: 'details',
      label: 'Details',
      align: 'left',
      minWidth: 12,
      maxWidth: 72,
      flex: true,
      priority: 1,
      format: (val, c, th) => {
        if (!val) return th ? th.muted('-') : '-';
        return String(val);
      },
    },
  ];

  const rows = (steps || []).map(s => {
    const durStr = typeof s.durationMs === 'number' ? ` (${s.durationMs.toFixed(0)}ms)` : '';
    const detailClean = sanitizeUntrusted(s.details || '');
    const combinedDetails = detailClean
      ? `${detailClean}${theme ? theme.muted(durStr) : durStr}`
      : (durStr ? (theme ? theme.muted(durStr.trim()) : durStr.trim()) : '-');
    return {
      step: sanitizeUntrusted(s.step || s.name || ''),
      status: s.status || 'PENDING',
      details: combinedDetails,
    };
  });

  return renderTable(columns, rows, { emptyText: 'No initialization steps recorded' }, caps, theme);
}

/**
 * Pure function to render the startup summary & ready/failure footer.
 */
function renderStartupSummary(steps = [], opts = {}, caps = null, theme = null) {
  const counts = { OK: 0, WARN: 0, SKIP: 0, FAIL: 0 };
  let failedStep = null;

  for (const s of steps || []) {
    const st = String(s.status || 'OK').toUpperCase();
    if (st === 'OK' || st === 'CONNECTED' || st === 'SUCCESS') counts.OK++;
    else if (st === 'WARN' || st === 'WARNING') counts.WARN++;
    else if (st === 'SKIP' || st === 'SKIPPED') counts.SKIP++;
    else if (st === 'FAIL' || st === 'FAILED' || st === 'ERROR') {
      counts.FAIL++;
      if (!failedStep) failedStep = s;
    }
  }

  const totalMs = typeof opts.totalMs === 'number'
    ? opts.totalMs
    : (steps || []).reduce((acc, s) => acc + (Number(s.durationMs) || 0), 0);

  const sym = (caps && caps.symbols) || { ok: 'OK', fail: 'X', warn: '!', bullet: '*' };
  const width = Math.max(20, (caps && caps.width) || 80);
  const ascii = !(caps && caps.unicode);

  const okPart = theme ? theme.success(`OK: ${counts.OK}`) : `OK: ${counts.OK}`;
  const warnPart = counts.WARN > 0
    ? (theme ? theme.warning(`WARN: ${counts.WARN}`) : `WARN: ${counts.WARN}`)
    : (theme ? theme.muted(`WARN: ${counts.WARN}`) : `WARN: ${counts.WARN}`);
  const skipPart = theme ? theme.muted(`SKIP: ${counts.SKIP}`) : `SKIP: ${counts.SKIP}`;
  const failPart = counts.FAIL > 0
    ? (theme ? theme.errorBold(`FAIL: ${counts.FAIL}`) : `FAIL: ${counts.FAIL}`)
    : (theme ? theme.muted(`FAIL: ${counts.FAIL}`) : `FAIL: ${counts.FAIL}`);
  const timePart = theme ? theme.muted(`Total: ${Math.round(totalMs)}ms`) : `Total: ${Math.round(totalMs)}ms`;

  const lines = [
    truncate(`Startup Summary: ${okPart} | ${warnPart} | ${skipPart} | ${failPart} · ${timePart}`, width, { ascii }),
  ];

  const requiredFailed = (steps || []).some(s => s.required !== false && ['FAIL', 'FAILED', 'ERROR'].includes(String(s.status || '').toUpperCase()));

  if (requiredFailed || counts.FAIL > 0) {
    const f = failedStep || { step: 'Startup', error: opts.error || 'Initialization failed' };
    const errText = sanitizeUntrusted(f.error || f.details || 'Unknown error');
    const failLine = `${sym.fail} Startup failed at "${sanitizeUntrusted(f.step || f.name)}": ${errText}`;
    lines.push(truncate(theme ? theme.errorBold(failLine) : failLine, width, { ascii }));
    if (f.hint) {
      const hintLine = `  Hint: ${sanitizeUntrusted(f.hint)}`;
      lines.push(truncate(theme ? theme.warning(hintLine) : hintLine, width, { ascii }));
    }
  } else {
    const readyMsg = opts.readyText || 'Antertool ready.';
    const readyLine = `${sym.ok} ${sanitizeUntrusted(readyMsg)}`;
    lines.push(truncate(theme ? theme.success(readyLine) : readyLine, width, { ascii }));
  }

  return lines;
}

/**
 * Helper class that wraps real startup steps, measures monotonic duration,
 * updates live running state on interactive terminals, and re-raises exceptions unchanged.
 */
class StartupTracker {
  constructor(options = {}) {
    this.writer = options.writer || null;
    this.caps = options.caps || (this.writer && this.writer.caps) || null;
    this.theme = options.theme || (this.writer && this.writer.theme) || null;
    this.getSecrets = typeof options.getSecrets === 'function' ? options.getSecrets : () => [];
    this.meta = readAppMeta(options.pkgPath);
    this.steps = [];
    this._t0 = process.hrtime.bigint();
  }

  _redact(text) {
    return redactSecretsInText(sanitizeUntrusted(text || ''), this.getSecrets());
  }

  /**
   * Wrap a synchronous or asynchronous startup step.
   * fn receives a helper `ctx` with `ctx.warn(details, hint)` and `ctx.skip(details)` and `ctx.ok(details)`.
   * If fn returns a string, it is used as `details` with status `OK`.
   * If fn throws, records `FAIL` with real elapsed time and error message, and re-throws the original exception unchanged.
   */
  async runStep(stepName, fn, opts = {}) {
    const record = {
      step: stepName,
      status: 'RUNNING',
      details: opts.pendingDetails || 'Running...',
      durationMs: 0,
      required: opts.required !== false,
      hint: opts.hint || null,
      error: null,
    };
    this.steps.push(record);

    const interactive = Boolean(this.caps && this.caps.interactive && this.writer);
    if (interactive) {
      const st = this.theme ? this.theme.formatStatus('RUNNING').text : '* RUNNING';
      this.writer.setEphemeral(`  ${st} ${stepName}...`);
    }

    const startNs = process.hrtime.bigint();
    let customOutcome = null;
    const ctx = {
      ok(details) { customOutcome = { status: 'OK', details }; },
      warn(details, hint) { customOutcome = { status: 'WARN', details, hint }; },
      skip(details) { customOutcome = { status: 'SKIP', details }; },
      connected(details) { customOutcome = { status: 'CONNECTED', details }; },
    };

    try {
      const ret = await fn(ctx);
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      record.durationMs = elapsedMs;

      if (customOutcome) {
        record.status = customOutcome.status;
        record.details = this._redact(customOutcome.details || '');
        if (customOutcome.hint) record.hint = this._redact(customOutcome.hint);
      } else if (ret && typeof ret === 'object' && ret.status) {
        record.status = String(ret.status).toUpperCase();
        record.details = this._redact(ret.details || '');
        if (ret.hint) record.hint = this._redact(ret.hint);
      } else {
        record.status = 'OK';
        record.details = this._redact(typeof ret === 'string' ? ret : (opts.okDetails || 'Completed'));
      }

      if (interactive) {
        this.writer.clearEphemeral();
      } else if (this.writer && opts.streamPlainSteps) {
        const plainStatus = `[${record.status}]`;
        this.writer.writeLine(`${plainStatus} ${record.step}: ${record.details} (${Math.round(record.durationMs)}ms)`);
      }

      return ret;
    } catch (err) {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      record.durationMs = elapsedMs;
      record.status = 'FAIL';
      record.error = this._redact((err && err.message) || String(err));
      record.details = record.error;
      if (err && err.hint && !record.hint) record.hint = this._redact(err.hint);

      if (interactive) {
        this.writer.clearEphemeral();
      }
      throw err;
    }
  }

  getTotalMs() {
    return Number(process.hrtime.bigint() - this._t0) / 1e6;
  }

  render(opts = {}) {
    const lines = [];
    if (opts.showBanner !== false) {
      lines.push(...renderBanner(this.meta, this.caps, this.theme));
    }
    lines.push(...renderStartupTable(this.steps, this.caps, this.theme));
    lines.push(...renderStartupSummary(this.steps, {
      totalMs: this.getTotalMs(),
      readyText: opts.readyText,
    }, this.caps, this.theme));
    return lines;
  }

  print(opts = {}) {
    const lines = this.render(opts);
    if (this.writer) {
      this.writer.writeLines(lines);
    }
    return lines;
  }
}

module.exports = {
  COMPACT_ASCII_ART,
  readAppMeta,
  renderBanner,
  renderStartupTable,
  renderStartupSummary,
  StartupTracker,
};
