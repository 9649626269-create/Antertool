'use strict';
// Kiểm tra cú pháp mọi file .js (nhanh, không cần thư viện). Dùng: npm run lint
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const skip = new Set(['node_modules', '.git', '.anter', 'auth_cache', 'logs', 'backups']);
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
  }
})(root);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.log('✘ ' + path.relative(root, f) + '\n' + r.stderr); }
}
console.log(bad ? `${bad} file lỗi cú pháp` : `OK — ${files.length} file`);
process.exit(bad ? 1 : 0);
