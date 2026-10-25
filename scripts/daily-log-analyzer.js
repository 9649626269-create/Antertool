'use strict';
/**
 * daily-log-analyzer.js
 * Tự động đọc và phân tích log hàng ngày của dàn bot Antertool.
 * Phân loại: Lỗi mạng (Network), Cảnh báo logic (GUI/Spawn), Lỗi nghiêm trọng (Exception/Stack trace).
 * Xuất kết quả ra log/daily-audit.json và màn hình.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOCAL_LOG_DIR = path.join(ROOT_DIR, 'log');
const SDCARD_LOG_DIR = '/sdcard/bot/log';

function findLogFile(dateStr) {
  const sdcardPath = path.join(SDCARD_LOG_DIR, `runtime-${dateStr}.log`);
  if (fs.existsSync(sdcardPath)) return sdcardPath;
  const localPath = path.join(LOCAL_LOG_DIR, `runtime-${dateStr}.log`);
  if (fs.existsSync(localPath)) return localPath;
  return null;
}

function getDateString(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

let targetDate = process.argv[2] || getDateString(0);
let logFile = findLogFile(targetDate);

if (!logFile && !process.argv[2]) {
  const yesterday = getDateString(-1);
  const yLog = findLogFile(yesterday);
  if (yLog) {
    targetDate = yesterday;
    logFile = yLog;
  }
}

if (!logFile) {
  console.log(`[DailyAudit] Không tìm thấy file log cho ngày ${targetDate}`);
  process.exit(0);
}

const content = fs.readFileSync(logFile, 'utf8');
const lines = content.split('\n');

const report = {
  date: targetDate,
  scannedAt: new Date().toISOString(),
  totalLines: lines.length,
  stats: {
    errors: 0,
    warnings: 0,
    uncaught: 0,
    networkErrors: 0,
    logicErrors: 0,
  },
  needsRepair: false,
  codeBugs: [],
  networkIssues: [],
  warnings: [],
};

const networkKeywords = ['ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'ETIMEDOUT', 'socket hang up', 'timed out', 'keepAlive'];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const isErr = line.includes('[ERR   ]') || line.includes('[ERROR]') || line.includes('[UNCAUGHT]') || line.includes('[UNHANDLED]');
  const isWarn = line.includes('[WARN  ]');

  if (isErr) {
    report.stats.errors++;

    const isNet = networkKeywords.some(k => line.includes(k));
    if (isNet) {
      report.stats.networkErrors++;
      report.networkIssues.push(line);
      continue;
    }

    if (line.includes('[UNCAUGHT]') || line.includes('[UNHANDLED]') || line.includes('Error:') || line.includes('TypeError') || line.includes('ReferenceError')) {
      report.stats.uncaught++;
      // Đọc tiếp các dòng stack trace phía sau
      let stack = [line];
      let j = i + 1;
      while (j < lines.length && (lines[j].startsWith('    at ') || lines[j].startsWith('  at '))) {
        stack.push(lines[j]);
        j++;
      }
      i = j - 1;

      report.codeBugs.push({
        line: line,
        stack: stack.join('\n'),
      });
      report.needsRepair = true;
    } else {
      report.stats.logicErrors++;
      report.codeBugs.push({ line });
    }
  } else if (isWarn) {
    report.stats.warnings++;
    // Thu thập các cảnh báo đáng chú ý
    if (line.includes('Tên người chơi không hợp lệ') || line.includes('GUI không mở') || line.includes('chưa ONLINE')) {
      report.warnings.push(line);
    }
  }
}

// Lưu báo cáo JSON
const auditOutPath = path.join(LOCAL_LOG_DIR, 'daily-audit.json');
if (!fs.existsSync(LOCAL_LOG_DIR)) fs.mkdirSync(LOCAL_LOG_DIR, { recursive: true });
fs.writeFileSync(auditOutPath, JSON.stringify(report, null, 2), 'utf8');

console.log('====================================================');
console.log(`📊 BÁO CÁO NHẬT KÝ BOT NGÀY: ${targetDate}`);
console.log(`- Tổng số dòng log: ${report.totalLines}`);
console.log(`- Lỗi nghiêm trọng (Exception/Bugs): ${report.stats.uncaught}`);
console.log(`- Lỗi mạng/Disconnect: ${report.stats.networkErrors}`);
console.log(`- Cảnh báo (Warnings): ${report.stats.warnings}`);
console.log(`- Cần AI can thiệp sửa code (needsRepair): ${report.needsRepair ? 'CÓ ⚠️' : 'KHÔNG (Hệ thống ổn định) ✅'}`);

if (report.codeBugs.length > 0) {
  console.log('\n🔍 CHI TIẾT LỖI CẦN SỬA:');
  report.codeBugs.slice(0, 5).forEach((b, idx) => {
    console.log(`  [${idx + 1}] ${b.line}`);
    if (b.stack) console.log(`      Stack:\n${b.stack}`);
  });
}

if (report.warnings.length > 0) {
  console.log(`\n⚠️ CẢNH BÁO ĐÁNG CHÚ Ý (${report.warnings.length} mục):`);
  report.warnings.slice(-5).forEach(w => console.log(`  - ${w}`));
}
console.log('====================================================');
console.log(`Đã xuất báo cáo chi tiết vào: ${auditOutPath}`);
