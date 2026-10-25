'use strict';
// Test Janitor: dọn file rác / file cũ nhưng KHÔNG đụng dữ liệu người dùng.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Janitor = require('../src/core/Janitor');

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY = 86400000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-janitor-'));
let n = 0;
const fresh = () => { const d = path.join(root, 'case' + (n++)); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (d, rel, content = 'x', ageMs = DAY) => {
  const f = path.join(d, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  const t = new Date(NOW - ageMs);
  fs.utimesSync(f, t, t);
  for (let dir = path.dirname(f); dir.startsWith(root) && dir !== root; dir = path.dirname(dir)) fs.utimesSync(dir, t, t); // thư mục cũng "cũ" như file
  return f;
};
const has = (d, rel) => fs.existsSync(path.join(d, rel));
const day = k => new Date(NOW - k * DAY).toISOString().slice(0, 10);
const mk = (d, o = {}) => new Janitor({ dataDir: d, now: () => NOW, ...o });

// 1. file tạm: xoá file cũ, giữ file mới sửa (có thể đang ghi) và dữ liệu người dùng
{
  const d = fresh();
  put(d, 'a.tmp'); put(d, 'x.swp'); put(d, 'notes.txt~'); put(d, '.DS_Store'); put(d, '.write-test-123'); put(d, 'npm-debug.log.1');
  put(d, 'revenue.json.tmp', 'x', 200000);        // tmp của RevenueTracker, đã quá 2 phút -> xoá được
  put(d, 'fresh.tmp', 'x', 1000);                  // mới sửa 1 giây trước -> giữ
  put(d, 'config.json', '{"bots":[]}'); put(d, 'config.json.bak', '{}'); put(d, '.env', 'K=1'); put(d, 'revenue.json', '{}'); put(d, 'proxies.txt', 'p');
  put(d, 'logs/x.tmp');                            // trong logs/ cũng dọn
  const r = mk(d).run();
  for (const f of ['a.tmp', 'x.swp', 'notes.txt~', '.DS_Store', '.write-test-123', 'npm-debug.log.1', 'revenue.json.tmp', 'logs/x.tmp']) assert.ok(!has(d, f), f + ' phải bị xoá');
  for (const f of ['fresh.tmp', 'config.json', 'config.json.bak', '.env', 'revenue.json', 'proxies.txt']) assert.ok(has(d, f), f + ' phải còn');
  assert.ok(r.freed > 0 && r.removed.length === 8, JSON.stringify(r.removed));
  assert.ok(Janitor.summary(r).startsWith('Dọn rác:'));
  assert.strictEqual(Janitor.summary(mk(d).run()), '', 'lần 2 không còn gì để dọn');
}

// 2. dryRun không đổi gì nhưng báo đúng
{
  const d = fresh();
  put(d, 'a.tmp'); put(d, 'autosell.json', '{}'); put(d, 'logs/runtime-' + day(30) + '.log', 'old');
  const r = mk(d, { dryRun: true }).run();
  assert.ok(has(d, 'a.tmp') && has(d, 'autosell.json') && has(d, 'logs/runtime-' + day(30) + '.log'));
  assert.ok(r.removed.length === 2 && r.quarantined.length === 1, JSON.stringify(r));
  assert.ok(!has(d, '.anter/trash'), 'dryRun không được tạo thùng rác');
}

// 3. updater: code.new / code.old / gói tải dở bị dọn; code.old KHÔNG bị xoá khi chưa có code (load.js cần khôi phục)
{
  const d = fresh();
  put(d, '.anter/code/main.js', 'live'); put(d, '.anter/code.new/main.js', 'half', DAY); put(d, '.anter/code.old/main.js', 'old', DAY);
  put(d, '.anter/dl.tgz', 'zzz'); put(d, '.anter/node_modules/.cache/x', 'c'); put(d, '.anter/node_modules/lib/index.js', 'keep'); put(d, '.anter/state.json', '{}');
  mk(d).run();
  assert.ok(has(d, '.anter/code/main.js') && has(d, '.anter/node_modules/lib/index.js') && has(d, '.anter/state.json'));
  assert.ok(!has(d, '.anter/code.new') && !has(d, '.anter/code.old') && !has(d, '.anter/dl.tgz') && !has(d, '.anter/node_modules/.cache'));
  const e = fresh();
  put(e, '.anter/code.old/main.js', 'only-copy');
  mk(e).run();
  assert.ok(has(e, '.anter/code.old/main.js'), 'chưa có code thì code.old là bản duy nhất, phải giữ');
  const f = fresh();
  put(f, '.anter/code/main.js', 'live'); put(f, '.anter/code.new/main.js', 'being-written', 1000);
  mk(f).run();
  assert.ok(has(f, '.anter/code.new/main.js'), 'update đang chạy dở (mới sửa) thì không đụng');
}

// 4. log: quá hạn, vượt tổng dung lượng (cũ nhất đi trước), protocol-errors.log bị cắt, file lạ giữ nguyên, log ngoài thư mục dữ liệu
{
  const d = fresh();
  const ext = fs.mkdtempSync(path.join(root, 'ext-'));
  put(d, `logs/runtime-${day(1)}.log`, 'a'.repeat(1000)); put(d, `logs/runtime-${day(10)}.log`, 'old'); put(d, `logs/runtime-${day(10)}.1.jsonl`, 'old');
  put(d, `log/runtime-${day(20)}.log`, 'old'); put(d, 'log/last_error.json', '{}'); put(d, 'log/daily-audit.json', '{}'); put(d, 'logs/notes.txt', 'mine');
  put(ext, `runtime-${day(30)}.log`, 'old'); put(ext, `runtime-${day(0)}.log`, 'today'); put(ext, 'photo.tmp', 'user file');
  put(d, 'logs/protocol-errors.log', ('line\n').repeat(400000)); // ~2 MB
  const r = mk(d, { logDirs: [ext], keepDays: 7, config: { cleanup: { protocolLogMaxMB: 1 } } }).run();
  assert.ok(has(d, `logs/runtime-${day(1)}.log`) && has(d, 'logs/notes.txt') && has(d, 'log/last_error.json') && has(d, 'log/daily-audit.json'));
  assert.ok(!has(d, `logs/runtime-${day(10)}.log`) && !has(d, `logs/runtime-${day(10)}.1.jsonl`) && !has(d, `log/runtime-${day(20)}.log`));
  assert.ok(!fs.existsSync(path.join(ext, `runtime-${day(30)}.log`)) && fs.existsSync(path.join(ext, `runtime-${day(0)}.log`)));
  assert.ok(fs.existsSync(path.join(ext, 'photo.tmp')), 'thư mục log ngoài chỉ được dọn file log của tool, không đụng file khác');
  assert.ok(r.truncated.length === 1 && fs.statSync(path.join(d, 'logs/protocol-errors.log')).size <= 1024 * 1024 / 2 + 8, 'protocol-errors.log phải bị cắt còn phần cuối');
  assert.ok(fs.readFileSync(path.join(d, 'logs/protocol-errors.log'), 'utf8').startsWith('line\n'), 'cắt đúng ranh giới dòng');

  // vượt tổng dung lượng
  const e = fresh();
  for (let k = 0; k < 5; k++) put(e, `logs/runtime-${day(k)}.log`, 'a'.repeat(300 * 1024));
  mk(e, { config: { cleanup: { maxLogMB: 1 } } }).run(); // 5 x 300KB = 1.5MB > 1MB
  assert.ok(has(e, `logs/runtime-${day(0)}.log`), 'file mới nhất luôn giữ');
  assert.ok(!has(e, `logs/runtime-${day(4)}.log`), 'file cũ nhất đi trước');
  const left = fs.readdirSync(path.join(e, 'logs')).length;
  assert.ok(left >= 1 && left <= 3, 'còn lại ' + left);
}

// 5. backup: chỉ giữ N bản mới nhất; config.json.bak chính luôn giữ
{
  const d = fresh();
  for (let k = 1; k <= 8; k++) put(d, `backups/b${k}.zip`, 'b', k * DAY);
  for (let k = 1; k <= 5; k++) put(d, `config.json.2026100${k}.bak`, '{}', k * DAY);
  put(d, 'config.json.bak', '{"keep":1}', 30 * DAY); put(d, 'config.json', '{}');
  mk(d, { config: { cleanup: { keepBackups: 3, keepConfigBackups: 2 } } }).run();
  assert.deepStrictEqual(fs.readdirSync(path.join(d, 'backups')).sort(), ['b1.zip', 'b2.zip', 'b3.zip']);
  assert.deepStrictEqual(fs.readdirSync(d).filter(f => /^config\.json\.2/.test(f)).sort(), ['config.json.20261001.bak', 'config.json.20261002.bak']);
  assert.ok(has(d, 'config.json.bak') && has(d, 'config.json'));
}

// 6. legacy: vào thùng rác (lấy lại được), obsolete.json đi kèm bản code, chặn thoát ra ngoài, không đụng file được bảo vệ
{
  const d = fresh(), code = path.join(d, '.anter', 'code');
  put(d, 'autosell.json', '{"Accchinh":{}}'); put(d, 'old/gone.js', 'g'); put(d, 'config.json', '{}'); put(d, 'outside-target.txt', 'keep');
  put(code, 'obsolete.json', JSON.stringify({ paths: ['old/gone.js', 'config.json', '../escape.txt', '.env'], reason: 'bản 2 bỏ file này' }));
  put(path.dirname(d), 'escape.txt', 'must-survive');
  const r = mk(d, { codeDir: code }).run();
  assert.ok(!has(d, 'autosell.json') && !has(d, 'old/gone.js'));
  assert.ok(has(d, 'config.json') && fs.existsSync(path.join(path.dirname(d), 'escape.txt')) && has(d, 'outside-target.txt'));
  const trash = Janitor.trashStatus(d);
  assert.strictEqual(trash.length, 1);
  assert.ok(trash[0].items.includes('autosell.json') && trash[0].items.includes('old__gone.js'), JSON.stringify(trash));
  assert.strictEqual(fs.readFileSync(path.join(d, '.anter/trash', trash[0].name, 'autosell.json'), 'utf8'), '{"Accchinh":{}}');
  assert.ok(r.quarantined.some(e => e.reason === 'bản 2 bỏ file này'));
}

// 7. auth_cache: chỉ cách ly bot không còn trong config; không biết danh sách bot thì KHÔNG đụng
{
  const d = fresh();
  put(d, 'auth_cache/1/token.json', 't'); put(d, 'auth_cache/ghost/token.json', 't');
  put(d, 'config.json', JSON.stringify({ bots: [{ id: 1 }] }));
  mk(d).run();
  assert.ok(has(d, 'auth_cache/1/token.json') && !has(d, 'auth_cache/ghost'), 'chỉ bot đã xoá bị cách ly');
  assert.ok(Janitor.trashStatus(d)[0].items.includes('auth_cache__ghost'));
  const e = fresh();
  put(e, 'auth_cache/ghost/token.json', 't'); put(e, 'config.json', '{ không phải json');
  mk(e).run();
  assert.ok(has(e, 'auth_cache/ghost/token.json'), 'config hỏng -> không xoá đăng nhập đã lưu');
  const f = fresh();
  put(f, 'auth_cache/ghost/token.json', 't'); put(f, 'config.json', '{"bots":[]}');
  mk(f).run();
  assert.ok(has(f, 'auth_cache/ghost/token.json'), 'chưa có bot nào -> không xoá');
}

// 8. archives: giữ bản mới nhất, cách ly bản cũ hơn; không đụng zip lạ
{
  const d = fresh();
  put(d, 'Antertool-fixed5.zip', 'a', 10 * DAY); put(d, 'Antertool-fixed12.zip', 'b', 5 * DAY); put(d, 'antertool-theme_update.zip', 'c', 2 * DAY); put(d, 'baitap.zip', 'mine', 20 * DAY);
  mk(d).run();
  assert.ok(has(d, 'antertool-theme_update.zip') && has(d, 'baitap.zip') && !has(d, 'Antertool-fixed5.zip') && !has(d, 'Antertool-fixed12.zip'));
}

// 9. staleCopies: mặc định tắt; bật thì chỉ làm khi chạy bằng load.js và có code tải về; repo git thì bỏ qua
{
  const d = fresh();
  put(d, 'main.js', 'm'); put(d, 'src/core/a.js', 'a'); put(d, 'load.js', 'l'); put(d, 'package.json', '{}'); put(d, '.anter/code/main.js', 'live'); put(d, 'config.json', '{}');
  mk(d, { viaLoader: true }).run();
  assert.ok(has(d, 'main.js') && has(d, 'src/core/a.js'), 'mặc định tắt');
  mk(d, { viaLoader: false, overrides: { staleCopies: true }, onlyCategories: ['staleCopies'] }).run();
  assert.ok(has(d, 'main.js'), 'chạy thẳng main.js (bản dev) thì không đụng');
  const g = fresh();
  put(g, 'main.js', 'm'); put(g, '.anter/code/main.js', 'live'); fs.mkdirSync(path.join(g, '.git'));
  mk(g, { viaLoader: true, overrides: { staleCopies: true }, onlyCategories: ['staleCopies'] }).run();
  assert.ok(has(g, 'main.js'), 'repo git thì không đụng');
  mk(d, { viaLoader: true, overrides: { staleCopies: true }, onlyCategories: ['staleCopies'] }).run();
  assert.ok(!has(d, 'main.js') && !has(d, 'src') && has(d, 'load.js') && has(d, 'package.json') && has(d, 'config.json') && has(d, '.anter/code/main.js'), 'bật: chỉ bản sao mã nguồn đi, load.js/config/code thật còn');
}

// 10. thùng rác hết hạn bị xoá hẳn, chưa hết hạn giữ
{
  const d = fresh();
  const stamp = ms => new Date(ms).toISOString().replace(/[:.]/g, '-');
  put(d, `.anter/trash/${stamp(NOW - 10 * DAY)}/old.txt`, 'x'); put(d, `.anter/trash/${stamp(NOW - 2 * DAY)}/new.txt`, 'y');
  const r = mk(d).run();
  assert.ok(!has(d, `.anter/trash/${stamp(NOW - 10 * DAY)}`) && has(d, `.anter/trash/${stamp(NOW - 2 * DAY)}/new.txt`));
  assert.strictEqual(r.purged.length, 1);
}

// 11. symlink không bị đi theo; tắt bằng config; tắt từng loại
{
  const d = fresh(), outside = fresh();
  put(outside, 'precious.tmp', 'keep');
  fs.symlinkSync(outside, path.join(d, 'backups'));
  put(d, 'a.tmp');
  mk(d).run();
  assert.ok(fs.existsSync(path.join(outside, 'precious.tmp')), 'không đi theo symlink');
  const e = fresh();
  put(e, 'a.tmp'); put(e, `logs/runtime-${day(30)}.log`);
  mk(e, { config: { cleanup: { enabled: false } } }).run();
  assert.ok(has(e, 'a.tmp') && has(e, `logs/runtime-${day(30)}.log`), 'enabled=false -> không làm gì');
  mk(e, { config: { cleanup: { temp: false } } }).run();
  assert.ok(has(e, 'a.tmp') && !has(e, `logs/runtime-${day(30)}.log`), 'tắt riêng loại temp');
}

// 12. không bao giờ ném lỗi, kể cả thư mục không tồn tại
{
  const r = new Janitor({ dataDir: path.join(root, 'khong-ton-tai'), now: () => NOW }).run();
  assert.deepStrictEqual([r.removed.length, r.quarantined.length, r.errors.length], [0, 0, 0]);
}

fs.rmSync(root, { recursive: true, force: true });
console.log('janitor.test.js: OK');
