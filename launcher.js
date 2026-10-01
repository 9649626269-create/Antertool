'use strict';
// Chạy file này thay cho main.js:  node launcher.js
// Mỗi lần mở: kiểm tra GitHub -> cập nhật (nếu có) -> chạy main.js.
// Nếu main.js thoát với mã 42 (lệnh "update" trong tool) thì tự cập nhật & chạy lại.
const { spawn } = require('child_process');
const path = require('path');
const updater = require('./updater');

let current = null;
// đăng ký tín hiệu 1 lần (trước đây mỗi lần restart lại đăng ký thêm -> rò listener)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (current) current.kill(sig); });

async function start() {
  await updater.run();
  current = spawn(process.execPath, [path.join(__dirname, 'main.js')], {
    stdio: 'inherit',
    env: { ...process.env, ANTER_LAUNCHER: '1' },   // để lệnh "update" trong tool biết đang chạy dưới launcher
  });
  current.on('exit', code => {
    if (code === 42) return start();   // yêu cầu cập nhật + khởi động lại
    process.exit(code || 0);
  });
}
start();
