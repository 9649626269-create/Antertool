'use strict';
// Chạy mọi test/*.test.js (mỗi file một tiến trình), chạy hết rồi mới báo tổng — không dừng ở lỗi đầu tiên.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const only = process.argv[2]; // vd: node test/run-all.js telegram
const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && (!only || f.includes(only))).sort();
const failed = [];
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 180000, env: { ...process.env, NODE_ENV: 'test' } });
  const ok = r.status === 0;
  console.log(`${ok ? '✔' : '✘'} ${f}`);
  if (!ok) { failed.push(f); console.log((r.stdout || '') + (r.stderr || '')); }
}
console.log(`\n${files.length - failed.length}/${files.length} bộ test đạt` + (failed.length ? ` — LỖI: ${failed.join(', ')}` : ''));
process.exit(failed.length ? 1 : 0);
