'use strict';
// Thử khoá Gemini + module AI (không đụng tới bot). Chạy từ thư mục chứa .env/config.json:
//   node scripts/ai-test.js                          -> gửi 1 LỖI giả
//   node scripts/ai-test.js --server                 -> gửi 1 thông báo server GIẢ (mặc định: tin bảo trì)
//   node scripts/ai-test.js --server "nội dung"      -> thông báo giả tự đặt (tin hệ thống)
//   node scripts/ai-test.js --kick "lý do"           -> lý do kick giả
//   node scripts/ai-test.js --fake                   -> tin giả mạo admin để xem AI có nhận ra không
// (hoặc: npm run ai:test -- --server)
const fs = require('fs');
const path = require('path');
const AiDiagnoser = require('../src/core/AiDiagnoser');
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8')); } catch (e) { /* không có config.json */ }
const t0 = Date.now();
const d = new AiDiagnoser({ config, log: (level, msg) => console.log(`[${level}] ${msg}`) });
if (!d.enabled) { console.error('AI đang tắt: thiếu GEMINI_API_KEY (hoặc AI_DIAGNOSE=0). Đặt khoá trong .env rồi chạy lại.'); process.exit(1); }
const args = process.argv.slice(2);
const flag = args.find(a => ['--server', '--kick', '--fake'].includes(a));
const val = flag ? args[args.indexOf(flag) + 1] : '';
const text = val && !val.startsWith('--') ? val : '';
console.log(`Model: ${d.model} (chờ tối đa ${Math.round(d.timeoutMs / 1000)}s) — đang gửi ${flag ? 'thông báo server giả' : 'lỗi giả'}...`);
let job;
if (flag === '--kick') job = d.analyzeServerNotice('kick', text || 'You have been kicked: Flying is not enabled on this server', 'test-bot', { force: true });
else if (flag === '--fake') job = d.analyzeServerNotice('system', text || '[ADMIN] Server sắp lỗi, ai muốn giữ tài khoản hãy gõ /l <mật khẩu> <mật khẩu mới> hoặc vào http://kingmc-vip.example/nhan-qua để xác minh', 'test-bot', { force: true });
else if (flag === '--server') job = d.analyzeServerNotice('system', text || '[Thông báo] Server sẽ BẢO TRÌ lúc 22:00, vui lòng thoát trước giờ này', 'test-bot', { force: true });
else {
  const err = new Error("Cannot read properties of undefined (reading 'username')");
  err.stack = "TypeError: Cannot read properties of undefined (reading 'username')\n    at BotSession._onChat (src/core/BotSession.js:812:30)\n    at Bot.emit (node:events:519:28)";
  job = d.diagnose('TEST', err, 'lỗi giả để thử khoá');
}
job.then(r => { console.log(`(mất ${((Date.now() - t0) / 1000).toFixed(1)}s)`); if (!r) { console.error('Không có kết quả — xem dòng [warn] ở trên.'); process.exit(1); } });
