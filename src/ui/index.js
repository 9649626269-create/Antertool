'use strict';

/**
 * Shared Terminal UI Layer Entry Point (`src/ui/index.js`).
 * Exports capabilities, theme, text utilities, output writer, logger,
 * table renderer, startup tracker, progress indicators, and dashboard views.
 */

const capabilities = require('./capabilities');
const text = require('./text');
const theme = require('./theme');
const writer = require('./writer');
const progress = require('./progress');
const logger = require('./logger');
const table = require('./table');
const startup = require('./startup');
const dashboard = require('./dashboard');

let _defaultRuntime = null;

function createUIRuntime(options = {}) {
  const caps = options.caps || capabilities.detectCapabilities(options);
  const th = options.theme || theme.createTheme(caps);
  const outWriter = options.writer || new writer.OutputWriter({
    caps,
    theme: th,
    stream: options.stream,
    errStream: options.errStream,
    rl: options.rl,
    registerCleanup: options.registerCleanup,
  });
  const log = options.logger || new logger.Logger({
    writer: outWriter,
    caps,
    theme: th,
    getSecrets: options.getSecrets,
    getTz: options.getTz,
    minLevel: options.minLevel,
  });
  return {
    caps,
    theme: th,
    writer: outWriter,
    logger: log,
    createSpinner(opts = {}) {
      return new progress.Spinner({ writer: outWriter, caps, theme: th, ...opts });
    },
    createStartupTracker(opts = {}) {
      return new startup.StartupTracker({
        writer: outWriter,
        caps,
        theme: th,
        getSecrets: options.getSecrets,
        ...opts,
      });
    },
    createDashboardController(manager, opts = {}) {
      return new dashboard.LiveDashboardController({
        manager,
        writer: outWriter,
        caps,
        theme: th,
        logger: log,
        ...opts,
      });
    },
  };
}

function getDefaultRuntime(options = {}) {
  if (!_defaultRuntime) {
    _defaultRuntime = createUIRuntime(options);
  }
  return _defaultRuntime;
}

function setDefaultRuntime(rt) {
  _defaultRuntime = rt;
  return _defaultRuntime;
}

module.exports = {
  ...capabilities,
  ...text,
  ...theme,
  ...writer,
  ...progress,
  ...logger,
  ...table,
  ...startup,
  ...dashboard,
  createUIRuntime,
  getDefaultRuntime,
  setDefaultRuntime,
};
