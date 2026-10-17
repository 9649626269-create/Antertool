'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileLogger = require('../src/core/FileLogger');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-filelog-'));
const T = Date.UTC(2026, 9, 17, 16, 45, 1, 123); // = 2026-10-17 23:45:01.123 giờ Việt Nam (UTC+7)
const mk = (o = {}) => new FileLogger({ dir, tz: () => 'Asia/Ho_Chi_Minh', redact: s => s.replace(/matkhau123/g, '***'), ...o });
const read = f => fs.readFileSync(path.join(dir, f), 'utf8');

(async () => {
  // 1. định dạng text, đúng múi giờ, che bí mật, bỏ màu/ANSI, nhiều dòng thụt vào, lọc chat
  let lg = mk();
  lg.write('bot-1', { level: 'warn', msg: '§cMất kết nối\x1b[31m do matkhau123\nchi tiết dòng 2', time: T });
  lg.write('system', { level: 'err', msg: new Error('boom'), time: T + 1000 });
  lg.write('bot-1', { level: 'chat', msg: 'Người chơi: xin chào', time: T }); // mặc định không ghi chat
  lg.write('bot-1', { level: 'xyz', msg: 'mức lạ', time: T });                 // mức lạ cũng bị bỏ
  await lg.flush();
  let txt = read('runtime-2026-10-17.log');
  assert.ok(txt.startsWith('2026-10-17 23:45:01.123 [WARN  ] [bot-1] Mất kết nối do ***\n    chi tiết dòng 2\n'), txt);
  assert.ok(/\[ERR   \] \[system\] Error: boom/.test(txt), txt);
  assert.ok(!txt.includes('xin chào') && !txt.includes('mức lạ') && !txt.includes('matkhau123') && !txt.includes('§') && !txt.includes('\x1b'), txt);

  // 2. ghi lệch nhịp: write không chờ (bất đồng bộ) nhưng flushSync ghi hết ngay
  lg.write('bot-1', { level: 'ok', msg: 'đồng bộ', time: T + 5000 });
  lg.flushSync();
  assert.ok(read('runtime-2026-10-17.log').includes('đồng bộ'));

  // 3. includeChat bật thì ghi chat
  lg.configure({ includeChat: true });
  lg.write('bot-1', { level: 'chat', msg: 'có chat', time: T }); lg.flushSync();
  assert.ok(read('runtime-2026-10-17.log').includes('có chat'));
  lg.close();

  // 4. sang ngày mới -> file mới (theo múi giờ: 17:00 UTC ngày 17 = 00:00 ngày 18 giờ VN)
  lg = mk();
  lg.write('bot-1', { level: 'ok', msg: 'ngày mới', time: Date.UTC(2026, 9, 17, 17, 0, 0) }); lg.flushSync();
  assert.ok(read('runtime-2026-10-18.log').includes('ngày mới'));
  assert.ok(!read('runtime-2026-10-17.log').includes('ngày mới'));

  // 5. xoay vòng theo dung lượng: runtime-DAY.log -> .1.log -> .2.log, không mất dòng
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-filelog2-'));
  const big = new FileLogger({ dir: d2, tz: () => 'UTC' }).configure({ maxMB: 0.1 }); // ~100KB
  const line = 'x'.repeat(1000);
  for (let i = 0; i < 300; i++) big.write('b', { level: 'ok', msg: i + ' ' + line, time: T });
  big.flushSync();
  const parts = fs.readdirSync(d2).sort();
  assert.ok(parts.length >= 3 && parts.includes('runtime-2026-10-17.1.log'), parts.join());
  const all = parts.map(f => fs.readFileSync(path.join(d2, f), 'utf8')).join('');
  assert.strictEqual((all.match(/\[OK    \]/g) || []).length, 300);
  for (const f of parts) assert.ok(fs.statSync(path.join(d2, f)).size <= 0.1 * 1048576 + 1100, f);
  big.close();
  const before = fs.readdirSync(d2).map(f => fs.readFileSync(path.join(d2, f), 'utf8')).join('');
  // chạy lại (tiến trình mới) -> ghi tiếp vào phần cuối, không ghi đè
  const big2 = new FileLogger({ dir: d2, tz: () => 'UTC' }).configure({ maxMB: 0.1 });
  big2.write('b', { level: 'ok', msg: 'tiếp tục', time: T }); big2.flushSync(); big2.close();
  const after = fs.readdirSync(d2).map(f => fs.readFileSync(path.join(d2, f), 'utf8')).join('');
  assert.ok(after.includes('tiếp tục') && after.length > before.length && after.split('x'.repeat(1000)).length === before.split('x'.repeat(1000)).length, 'phải ghi tiếp, không ghi đè');

  // 6. xoá file cũ hơn keepDays, giữ file không liên quan
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-filelog3-'));
  for (const f of ['runtime-2026-10-01.log', 'runtime-2026-10-09.log', 'runtime-2026-10-10.2.jsonl', 'protocol-errors.log', 'notes.txt']) fs.writeFileSync(path.join(d3, f), 'x');
  const pr = new FileLogger({ dir: d3, tz: () => 'UTC' }).configure({ keepDays: 7 });
  pr.write('b', { level: 'ok', msg: 'hôm nay', time: T }); pr.flushSync(); pr.close();
  const left = fs.readdirSync(d3).sort();
  assert.deepStrictEqual(left, ['notes.txt', 'protocol-errors.log', 'runtime-2026-10-10.2.jsonl', 'runtime-2026-10-17.log'].sort(), left.join());

  // 7. JSON
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-filelog4-'));
  const js = new FileLogger({ dir: d4, tz: () => 'UTC', redact: s => s }).configure({ format: 'json', levels: ['err'] });
  js.write('bot-9', { level: 'err', msg: 'lỗi\nhai dòng', time: T }); js.write('bot-9', { level: 'ok', msg: 'bỏ', time: T }); js.flushSync(); js.close();
  const rows = fs.readFileSync(path.join(d4, 'runtime-2026-10-17.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows, [{ t: '2026-10-17T16:45:01.123Z', level: 'err', bot: 'bot-9', msg: 'lỗi\nhai dòng' }]);

  // 8. tắt -> không ghi; thư mục không ghi được -> không ném lỗi
  const off = new FileLogger({ dir: path.join(d4, 'off') }).configure({ enabled: false });
  off.write('b', { level: 'err', msg: 'x', time: T }); off.flushSync();
  assert.ok(!fs.existsSync(path.join(d4, 'off')));
  const bad = new FileLogger({ dir: path.join(d4, 'runtime-2026-10-17.jsonl', 'khong-the') }); // cha là file -> mkdir lỗi
  bad.write('b', { level: 'err', msg: 'x', time: T }); bad.flushSync(); await bad.flush();

  // 9. msg quá dài bị cắt
  const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-filelog5-'));
  const lng = new FileLogger({ dir: d5, tz: () => 'UTC' });
  lng.write('b', { level: 'ok', msg: 'y'.repeat(50000), time: T }); lng.flushSync(); lng.close();
  assert.ok(fs.readFileSync(path.join(d5, 'runtime-2026-10-17.log'), 'utf8').length < 8200);

  for (const x of [dir, d2, d3, d4, d5]) fs.rmSync(x, { recursive: true, force: true });
  console.log('file-logger.test OK');
})().catch(e => { console.error(e); process.exit(1); });
