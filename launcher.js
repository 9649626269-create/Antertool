'use strict';
// Chạy file này thay cho main.js:  node launcher.js
// Mỗi lần mở: kiểm tra GitHub -> cập nhật (nếu có) -> chạy main.js.
// Nếu main.js thoát với mã 42 (lệnh "update" trong tool) thì tự cập nhật & chạy lại.
const { spawn } = require('child_process');
const path = require('path');
const updater = require('./updater');

async function start() {
  await updater.run();
  const child = spawn(process.execPath, [path.join(__dirname, 'main.js')], { stdio: 'inherit' });
  child.on('exit', code => {
    if (code === 42) return start();   // yêu cầu cập nhật + khởi động lại
    process.exit(code || 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
}
start();
