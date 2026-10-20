'use strict';
const fs = require('fs');
const path = require('path');

// Đọc .env tối giản (KEY=VALUE, bỏ dòng # và dòng trống). Chỉ ĐỌC ra object, không đụng vào process.env.
function readDotEnv(dir) {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || m[0].trim().startsWith('#')) continue;
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (e) { /* không có .env */ }
  return out;
}
module.exports = { readDotEnv };
