'use strict';
/**
 * ConfigValidator — kiểm tra schema cơ bản cho config.json khi load.
 * Không dùng thư viện ngoài (ajv/zod) để giữ dependency nhẹ.
 * Trả về { ok: true } hoặc { ok: false, errors: string[] }.
 */

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isStr(v) { return typeof v === 'string'; }
function isNum(v) { return typeof v === 'number' && isFinite(v); }
function isBool(v) { return typeof v === 'boolean'; }

/**
 * Validate toàn bộ config.
 * @param {object} cfg
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateConfig(cfg) {
  const errors = [];
  if (!isObj(cfg)) {
    return { ok: false, errors: ['config phải là object'] };
  }

  // Top-level optional but typed
  if (cfg.host !== undefined && !isStr(cfg.host)) errors.push('host phải là string');
  if (cfg.port !== undefined && (!isNum(cfg.port) || cfg.port < 1 || cfg.port > 65535)) errors.push('port phải là số 1-65535');
  if (cfg.version !== undefined && !isStr(cfg.version)) errors.push('version phải là string');
  if (cfg.botPassword !== undefined && !isStr(cfg.botPassword)) errors.push('botPassword phải là string');
  if (cfg.webDashboard !== undefined && !isBool(cfg.webDashboard)) errors.push('webDashboard phải là boolean');
  if (cfg.dashboardToken !== undefined && !isStr(cfg.dashboardToken)) errors.push('dashboardToken phải là string');
  if (cfg.useProxy !== undefined && !isBool(cfg.useProxy)) errors.push('useProxy phải là boolean');
  if (cfg.timezone !== undefined && !isStr(cfg.timezone)) errors.push('timezone phải là string');

  // settings
  if (cfg.settings !== undefined) {
    if (!isObj(cfg.settings)) errors.push('settings phải là object');
    else {
      const s = cfg.settings;
      if (s.webPort !== undefined && (!isNum(s.webPort) || s.webPort < 1 || s.webPort > 65535)) errors.push('settings.webPort không hợp lệ');
      if (s.pollInterval !== undefined && (!isNum(s.pollInterval) || s.pollInterval < 1000)) errors.push('settings.pollInterval phải >= 1000');
    }
  }

  // reconnect
  if (cfg.reconnect !== undefined) {
    if (!isObj(cfg.reconnect)) errors.push('reconnect phải là object');
    else {
      const r = cfg.reconnect;
      if (r.baseDelay !== undefined && (!isNum(r.baseDelay) || r.baseDelay < 0)) errors.push('reconnect.baseDelay không hợp lệ');
      if (r.maxDelay !== undefined && (!isNum(r.maxDelay) || r.maxDelay < 0)) errors.push('reconnect.maxDelay không hợp lệ');
      if (r.maxRetries !== undefined && (!isNum(r.maxRetries) || r.maxRetries < 0)) errors.push('reconnect.maxRetries không hợp lệ');
    }
  }

  // bots array
  if (cfg.bots !== undefined) {
    if (!Array.isArray(cfg.bots)) errors.push('bots phải là mảng');
    else {
      cfg.bots.forEach((b, i) => {
        if (!isObj(b)) {
          errors.push(`bots[${i}] phải là object`);
          return;
        }
        if (!isStr(b.id) || !b.id.trim()) errors.push(`bots[${i}].id bắt buộc và phải là string không rỗng`);
        if (b.username !== undefined && !isStr(b.username)) errors.push(`bots[${i}].username phải là string`);
        if (b.port !== undefined && (!isNum(b.port) || b.port < 1 || b.port > 65535)) errors.push(`bots[${i}].port không hợp lệ`);
        if (b.botPassword !== undefined && !isStr(b.botPassword)) errors.push(`bots[${i}].botPassword phải là string`);
        if (b.sellFailMention !== undefined && !isStr(b.sellFailMention)) errors.push(`bots[${i}].sellFailMention phải là string`);
        if (b.sellFailMaxHome !== undefined && (!isNum(b.sellFailMaxHome) || b.sellFailMaxHome < 0)) errors.push(`bots[${i}].sellFailMaxHome phải >= 0`);
        if (b.theme !== undefined && !isStr(b.theme)) errors.push(`bots[${i}].theme phải là string`);
      });
      // id unique
      const ids = cfg.bots.map(b => b && b.id).filter(Boolean);
      if (new Set(ids).size !== ids.length) errors.push('bots[].id phải duy nhất');
    }
  }

  // macros
  if (cfg.macros !== undefined && !isObj(cfg.macros)) errors.push('macros phải là object');

  // proxies
  if (cfg.proxies !== undefined && !Array.isArray(cfg.proxies)) errors.push('proxies phải là mảng');

  return { ok: errors.length === 0, errors };
}

module.exports = { validateConfig };
