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

// Cú pháp bước macro — phải khớp ScriptRunner._runSteps. Biến $answer/$label/$owner... được thay lúc chạy nên số có thể là "$x".
const MACRO_TEXT_OPS = new Set(['stopif', 'ask', 'confirm', 'until']); // cần đoạn chữ sau tên lệnh
const MACRO_OPS = new Set(['chat', 'delay', 'winclick', 'waitmsg', 'waitmsg!', 'loop', 'until', 'closewin', 'stopif', 'ask', 'askmap', 'askmenu', 'confirm']);
const isIntOrVar = s => /^\d+$/.test(s) || /^\$\w+$/.test(s);

/** Kiểm tra từng dòng của macro.steps → đẩy lỗi vào errors (kèm số dòng). */
function validateMacroSteps(steps, where, errors) {
  if (!isStr(steps)) { errors.push(`${where}.steps phải là string (mỗi bước một dòng)`); return; }
  const lines = steps.split('\n').map(l => l.trim());
  let inLoop = false;
  lines.forEach((line, idx) => {
    if (!line) return;
    const at = `${where}.steps dòng ${idx + 1}`;
    const parts = line.split(/\s+/);
    const op = parts[0].toLowerCase();
    const arg = line.slice(parts[0].length).trim();
    if (!MACRO_OPS.has(op)) { errors.push(`${at}: lệnh "${parts[0]}" không tồn tại`); return; }
    if (op === 'chat' && !arg) errors.push(`${at}: chat thiếu nội dung`);
    else if (op === 'delay' && !isIntOrVar(parts[1] || '')) errors.push(`${at}: delay cần số mili-giây`);
    else if (op === 'winclick') {
      if (!isIntOrVar(parts[1] || '')) errors.push(`${at}: winclick cần slot là số nguyên >= 0`);
      if (parts[2] !== undefined && !/^[01]$/.test(parts[2]) && !/^\$\w+$/.test(parts[2])) errors.push(`${at}: winclick button chỉ là 0 (trái) hoặc 1 (phải)`);
    } else if (op === 'waitmsg' || op === 'waitmsg!') {
      const text = (/^\d+$/.test(parts[1] || '') ? parts.slice(2) : parts.slice(1)).join(' ');
      if (!text) errors.push(`${at}: ${op} thiếu đoạn chữ cần chờ`);
    } else if (op === 'loop') {
      if (parts[1] !== undefined && !/^\d+$/.test(parts[1])) errors.push(`${at}: loop chỉ nhận số lượt tối đa`);
      inLoop = true;
    } else if (MACRO_TEXT_OPS.has(op) && !arg) errors.push(`${at}: ${op} thiếu nội dung`);
    if (op === 'until' && !inLoop) errors.push(`${at}: until cần có "loop" phía trên`);
    if (op === 'askmap') {
      const sep = line.indexOf('||');
      if (sep === -1) errors.push(`${at}: askmap thiếu "||" — cú pháp: askmap <câu hỏi> || nhãn=giá_trị,...`);
      else if (!line.slice(sep + 2).split(',').some(p => p.includes('='))) errors.push(`${at}: askmap không có cặp nhãn=giá_trị nào`);
    } else if (op === 'askmenu') {
      const sep = line.indexOf('||');
      if (sep === -1 || !line.slice(sep + 2).includes('=')) errors.push(`${at}: askmenu cần bảng lựa chọn sau "||" — vd: askmenu <tiêu đề> || NHÓM: 2=nhãn,3=nhãn`);
    }
  });
  if (!lines.some(Boolean)) errors.push(`${where}.steps rỗng`);
}

/** macros: { tên: { steps, next? } } — kiểm tra kiểu, steps, và `next` phải trỏ tới macro có thật. */
function validateMacros(macros, where, errors) {
  if (macros === undefined) return;
  if (!isObj(macros)) { errors.push(`${where} phải là object`); return; }
  const squash = v => String(v).toLowerCase().replace(/[\s_\-]+/g, '');
  const keys = Object.keys(macros);
  for (const k of keys) {
    const m = macros[k], w = `${where}.${k}`;
    if (!isObj(m)) { errors.push(`${w} phải là object { steps, next? }`); continue; }
    validateMacroSteps(m.steps, w, errors);
    if (m.next !== undefined) {
      if (!isStr(m.next) || !m.next.trim()) errors.push(`${w}.next phải là string không rỗng`);
      else if (!keys.some(x => x.toLowerCase() === m.next.trim().toLowerCase() || squash(x) === squash(m.next))) errors.push(`${w}.next: macro "${m.next}" không tồn tại`);
    }
  }
}

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

  // autoLogin (toàn cục hoặc từng bot)
  const checkAutoLogin = (al, where) => {
    if (al === undefined || al === null) return;
    if (!isObj(al)) { errors.push(`${where}.autoLogin phải là object`); return; }
    if (al.enabled !== undefined && !isBool(al.enabled)) errors.push(`${where}.autoLogin.enabled phải là boolean`);
    for (const k of ['password', 'loginCommand', 'registerCommand', 'menuCommand']) {
      if (al[k] !== undefined && !isStr(al[k])) errors.push(`${where}.autoLogin.${k} phải là string`);
    }
    for (const k of ['loginPrompt', 'menuTriggers', 'antibotItemNames', 'antibotSuccess']) {
      if (al[k] !== undefined && !(Array.isArray(al[k]) && al[k].every(isStr))) errors.push(`${where}.autoLogin.${k} phải là mảng string`);
    }
    for (const k of ['finalSlot', 'actionDelayMs', 'menuSendDelayMs', 'menuTimeoutMs', 'antibotTimeoutMs', 'postVerifyWaitMs',
      'restoreSettleMs', 'globalTimeoutMs', 'maxLoginAttempts', 'triggerCooldownMs', 'startFallbackMs']) {
      if (al[k] !== undefined && (!isNum(al[k]) || al[k] < 0)) errors.push(`${where}.autoLogin.${k} phải là số >= 0`);
    }
  };
  checkAutoLogin(cfg.autoLogin, 'config');
  if (Array.isArray(cfg.bots)) cfg.bots.forEach((b, i) => { if (isObj(b)) checkAutoLogin(b.autoLogin, `bots[${i}]`); });

  // macros
  validateMacros(cfg.macros, 'macros', errors);
  if (Array.isArray(cfg.bots)) cfg.bots.forEach((b, i) => { if (isObj(b)) validateMacros(b.macros, `bots[${i}].macros`, errors); });

  // proxies
  if (cfg.proxies !== undefined && !Array.isArray(cfg.proxies)) errors.push('proxies phải là mảng');

  return { ok: errors.length === 0, errors };
}

module.exports = { validateConfig, validateMacroSteps, validateMacros };
