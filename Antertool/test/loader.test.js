'use strict';
// Test load.js: giải nén tar + luồng tải code -> chạy -> giữ dữ liệu, dùng server GitHub giả (không cần mạng).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const LOADER = path.join(__dirname, '..', 'load.js');

// ── tạo tar.gz tối giản (ustar) trong bộ nhớ ──
function tarEntry(name, data) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);          // checksum tạm = 8 dấu cách
  h.write('0', 156);
  h.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([h, data, pad]);
}
function makeTgz(files) {
  const parts = Object.entries(files).map(([n, c]) => tarEntry(n, Buffer.from(c)));
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

// ── 1. untar ──
{
  const { untar } = require(LOADER);
  const out = untar(zlib.gunzipSync(makeTgz({ 'r-1/a.txt': 'xin chào', 'r-1/src/b.js': 'x'.repeat(1500) })));
  assert.deepStrictEqual(out.map(f => f.name), ['r-1/a.txt', 'r-1/src/b.js']);
  assert.strictEqual(out[0].data.toString('utf8'), 'xin chào');
  assert.strictEqual(out[1].data.length, 1500);
}

// ── 2. luồng đầy đủ với server giả ──
const SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);
let sha = SHA1;
let calls = [];
const bundles = {
  [SHA1]: { 'o-r-aaaaaaa/main.js': 'const fs = require("fs"); if (!fs.existsSync("restart.flag")) { fs.writeFileSync("restart.flag", "1"); process.exit(42); } console.log("V1 cwd=" + process.cwd() + " loader=" + !!process.env.ANTER_LOADER);', 'o-r-aaaaaaa/package.json': '{"dependencies":{}}', 'o-r-aaaaaaa/old.js': '//' },
  [SHA2]: { 'o-r-bbbbbbb/main.js': 'console.log("V2");', 'o-r-bbbbbbb/package.json': '{"dependencies":{}}', 'o-r-bbbbbbb/../../evil.txt': 'x' },
};
const server = http.createServer((req, res) => {
  calls.push(req.url);
  if (req.url === '/repos/o/r/commits/main') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ sha, commit: { message: 'msg ' + sha[0] + '\nchi tiết' } }));
  }
  const m = req.url.match(/^\/repos\/o\/r\/tarball\/([0-9a-f]{40})$/);
  if (m && bundles[m[1]]) { res.writeHead(302, { location: '/dl/' + m[1] }); return res.end(); } // giống GitHub: chuyển hướng sang codeload
  const d = req.url.match(/^\/dl\/([0-9a-f]{40})$/);
  if (d) return res.end(makeTgz(bundles[d[1]]));
  res.writeHead(404); res.end();
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-loader-test-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{"bots":[{"id":"x","botPassword":"giu-lai"}]}');
  const env = { ...process.env, ANTER_DATA_DIR: dir, GH_API: `http://127.0.0.1:${port}`, GH_OWNER: 'o', GH_REPO: 'r', GH_BRANCH: 'main' };
  const run = () => new Promise(resolve => {
    const p = require('child_process').spawn(process.execPath, [LOADER], { env, cwd: os.tmpdir() });
    let out = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => out += c);
    p.on('exit', code => resolve({ code, out }));
  });

  (async () => {
    // lần đầu: tải V1 (main.js thoát mã 42 một lần -> chạy lại), chạy với cwd = thư mục dữ liệu
    let r = await run();
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(r.out.includes('V1 cwd=' + fs.realpathSync(dir)) && r.out.includes('loader=true'), r.out);
    assert.ok(fs.existsSync(path.join(dir, '.anter', 'code', 'old.js')));
    assert.ok(r.out.includes('mới nhất'), 'mã thoát 42 phải khiến load.js kiểm tra lại rồi chạy lại: ' + r.out);

    // chạy lại, không đổi commit: không tải lại
    calls = [];
    r = await run();
    assert.ok(r.out.includes('mới nhất') && !calls.some(u => u.includes('tarball')), r.out);

    // có commit mới: thay code, xoá file cũ, chặn ../, giữ nguyên dữ liệu
    sha = SHA2;
    r = await run();
    assert.ok(r.out.includes('V2') && r.out.includes('Có bản mới: msg b'), r.out);
    assert.ok(!fs.existsSync(path.join(dir, '.anter', 'code', 'old.js')), 'file cũ phải biến mất');
    assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')) && !fs.existsSync(path.join(dir, 'evil.txt')), 'chặn ../');
    assert.ok(fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes('giu-lai'), 'config phải còn nguyên');

    // offline: server tắt -> vẫn chạy bản đã tải
    await new Promise(res => server.close(res));
    r = await run();
    assert.ok(r.out.includes('V2') && r.out.includes('chạy bản đã tải'), r.out);

    // máy mới chưa có config.json -> load.js tạo file trống
    fs.rmSync(path.join(dir, 'config.json'));
    r = await run();
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')), { bots: [] }, r.out);

    fs.rmSync(dir, { recursive: true, force: true });
    console.log('loader.test.js: OK');
  })().catch(e => { console.error(e); process.exit(1); });
});
