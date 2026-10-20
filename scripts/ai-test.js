'use strict';
// Thử khoá Gemini + module AI: node scripts/ai-test.js   (hoặc: npm run ai:test)
// Đọc GEMINI_API_KEY từ môi trường hoặc .env cạnh thư mục chạy. Gửi 1 lỗi giả; không đụng tới bot.
const AiDiagnoser = require('../src/core/AiDiagnoser');
const d = new AiDiagnoser({ log: (level, msg) => console.log(`[${level}] ${msg}`) });
if (!d.enabled) { console.error('AI đang tắt: thiếu GEMINI_API_KEY (hoặc AI_DIAGNOSE=0). Đặt khoá trong .env rồi chạy lại.'); process.exit(1); }
console.log(`Model: ${d.model} — đang gửi lỗi thử...`);
const err = new Error("Cannot read properties of undefined (reading 'username')");
err.stack = "TypeError: Cannot read properties of undefined (reading 'username')\n    at BotSession._onChat (src/core/BotSession.js:812:30)\n    at Bot.emit (node:events:519:28)";
d.diagnose('TEST', err, 'lỗi giả để thử khoá').then(r => { if (!r) { console.error('Không có kết quả — xem dòng [warn] ở trên.'); process.exit(1); } });
