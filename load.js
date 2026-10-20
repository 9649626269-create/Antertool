#!/usr/bin/env node
'use strict';
/**
 * load.js — file DUY NHẤT cần có trên máy.   Chạy:  node load.js
 *
 * Mỗi lần chạy:
 *   1. Hỏi GitHub commit mới nhất của nhánh.
 *   2. Khác bản đã tải -> tải code về thư mục ẩn .anter/code/ (và cài thư viện nếu package.json đổi).
 *   3. Chạy main.js từ .anter/code/.
 * Không có mạng -> chạy bản đã tải lần trước.
 *
 * Trên máy chỉ có:
 *   load.js                 bộ nạp này
 *   config.json             mật khẩu, bot, macro, proxy  } dữ liệu của bạn — update KHÔNG BAO GIỜ đụng tới
 *                           (chưa có thì load.js tạo file trống)
 *   revenue.json, proxies.txt, auth_cache/, logs/, backups/ }
 *   .anter/                 code + node_modules tải từ GitHub (xoá đi cũng được, lần sau tự tải lại)
 *
 * Cấu hình repo (ưu tiên từ trên xuống): biến môi trường GH_OWNER / GH_REPO / GH_BRANCH / GITHUB_TOKEN
 *   -> file update.json cạnh load.js ({"owner","repo","branch","token","autoUpdate"}) -> mặc định bên dưới.
 *   GITHUB_TOKEN chỉ cần khi repo private.
 *
 * An toàn chuỗi cung ứng (code tải về được CHẠY trên máy bạn nên hãy tin repo):
 *   - GH_BRANCH (hoặc "branch") nhận cả tag/commit SHA: đặt GH_BRANCH=v1.2.0 hoặc một SHA 40 ký tự để GHIM phiên bản,
 *     không tự nhảy theo commit mới.
 *   - ANTER_AUTO_UPDATE=0 (hoặc "autoUpdate": false trong update.json): không hỏi GitHub nữa, chỉ chạy bản đã tải
 *     (lần đầu chưa có code vẫn tải một lần). Lệnh "update" trong tool vẫn cập nhật khi bạn chủ động gọi.
 *   - Repo có package-lock.json -> cài thư viện bằng `npm ci` (đúng phiên bản đã khoá).
 * Lệnh "update" trong tool thoát với mã 42 -> load.js tự tải bản mới & chạy lại.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const DEFAULTS = { owner: '9649626269-create', repo: 'Antertool', branch: 'main' };

const DATA_DIR = path.resolve(process.env.ANTER_DATA_DIR || __dirname); // nơi chứa dữ liệu người dùng + cwd của bot
const HOME = path.join(DATA_DIR, '.anter');       // mọi thứ tải về nằm ở đây
const CODE = path.join(HOME, 'code');             // code từ GitHub (bị thay nguyên thư mục mỗi lần update)
const STATE_FILE = path.join(HOME, 'state.json'); // { sha, depsHash, updatedAt }
const API = (process.env.GH_API || 'https://api.github.com').replace(/\/+$/, ''); // GH_API chỉ dùng để test
const MAX_DOWNLOAD = 100 * 1024 * 1024;

// Zero-dependency ANSI capability & structured logging for standalone load.js
function isColorEnabled(stream = process.stdout) {
  if (typeof process.env.NO_COLOR === 'string' && process.env.NO_COLOR.length > 0) return false;
  if (typeof process.env.FORCE_COLOR === 'string' && process.env.FORCE_COLOR.length > 0) {
    return process.env.FORCE_COLOR !== '0' && process.env.FORCE_COLOR.toLowerCase() !== 'false';
  }
  if (process.env.TERM === 'dumb') return false;
  return Boolean(stream && stream.isTTY);
}

function fmtLoaderLog(level, msg, stream = process.stdout) {
  const d = new Date();
  const ts = `[${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}]`;
  const color = isColorEnabled(stream);
  if (!color) {
    const badge = level === 'err' ? '[ERROR  ]' : (level === 'warn' ? '[WARNING]' : (level === 'ok' ? '[SUCCESS]' : '[INIT   ]'));
    return `${ts} ${badge} [load] ${msg}`;
  }
  const tsCol = `\x1b[90m${ts}\x1b[0m`;
  const scopeCol = `\x1b[96m[load]\x1b[0m`;
  let badgeCol = `\x1b[1;96m[INIT   ]\x1b[0m`;
  if (level === 'ok') badgeCol = `\x1b[1;92m[SUCCESS]\x1b[0m`;
  else if (level === 'warn') badgeCol = `\x1b[1;93m[WARNING]\x1b[0m`;
  else if (level === 'err') badgeCol = `\x1b[1;91m[ERROR  ]\x1b[0m`;
  return `${tsCol} ${badgeCol} ${scopeCol} \x1b[97m${msg}\x1b[0m`;
}

const log = (m, level = 'info') => console.log(fmtLoaderLog(level, m, process.stdout));
const logErr = (m) => console.error(fmtLoaderLog('err', m, process.stderr));
const rmrf = p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };

function settings() {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'update.json'), 'utf8')); } catch {}
  return {
    owner: process.env.GH_OWNER || f.owner || DEFAULTS.owner,
    repo: process.env.GH_REPO || f.repo || DEFAULTS.repo,
    branch: process.env.GH_BRANCH || f.branch || DEFAULTS.branch,
    token: process.env.GITHUB_TOKEN || f.token || '',
    autoUpdate: !/^(0|false|off|no)$/i.test(String(process.env.ANTER_AUTO_UPDATE ?? (f.autoUpdate === false ? '0' : '1'))),
  };
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function writeState(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
}
const hasCode = () => fs.existsSync(path.join(CODE, 'main.js'));

// ───────────────────────── HTTP ─────────────────────────
function request(url, token, accept, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > 5) return reject(new Error('quá nhiều lần chuyển hướng'));
    const lib = url.startsWith('http:') ? require('http') : require('https');
    const req = lib.get(url, {
      headers: { 'User-Agent': 'anter-loader', Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      timeout: 30000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, url); } catch (e) { return reject(e); }
        // chỉ gửi token tới đúng host ban đầu, không gửi sang host khác khi bị chuyển hướng
        const same = next.host === new URL(url).host;
        return resolve(request(next.toString(), same ? token : '', accept, hops + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const hint = res.statusCode === 404 ? ' (sai owner/repo/nhánh, hoặc repo private cần GITHUB_TOKEN)'
          : res.statusCode === 403 || res.statusCode === 429 ? ' (có thể bị giới hạn lượt gọi API — thử lại sau, hoặc đặt GITHUB_TOKEN)' : '';
        return reject(new Error(`GitHub trả về HTTP ${res.statusCode}${hint}`));
      }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_DOWNLOAD) return req.destroy(new Error('file tải về quá lớn'));
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function getJson(url, token) {
  return JSON.parse((await request(url, token, 'application/vnd.github+json')).toString('utf8'));
}

// ───────────────────────── Giải nén tar (không cần thư viện) ─────────────────────────
function parsePax(data) {
  const out = {};
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(32, p);
    if (sp < 0) break;
    const len = parseInt(data.toString('latin1', p, sp), 10);
    if (!len) break;
    const rec = data.toString('utf8', sp + 1, p + len - 1); // bỏ '\n' cuối bản ghi
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    p += len;
  }
  return out;
}

// Trả về [{ name, data }] cho các file thường (bỏ thư mục, symlink, header đặc biệt)
function untar(buf) {
  const files = [];
  let off = 0, pax = null, longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (s, e) => { const z = h.indexOf(0, s); return h.toString('utf8', s, z >= 0 && z < e ? z : e); };
    let name = str(0, 100);
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = h[156];
    if (h.toString('latin1', 257, 262) === 'ustar') {
      const prefix = str(345, 500);
      if (prefix) name = prefix + '/' + name;
    }
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 0x78) { pax = parsePax(data); continue; }                          // 'x' — header mở rộng cho entry kế tiếp
    if (type === 0x67) continue;                                                      // 'g' — header toàn cục (GitHub ghi commit vào đây)
    if (type === 0x4c) { longName = data.toString('utf8').replace(/\0+$/, ''); continue; } // 'L' — tên dài kiểu GNU
    if (pax && pax.path) name = pax.path;
    if (longName) name = longName;
    pax = longName = null;
    if (type === 0 || type === 0x30) files.push({ name, data: Buffer.from(data) }); // file thường
  }
  return files;
}

// ───────────────────────── Cập nhật ─────────────────────────
async function checkForUpdate() {
  const cfg = settings();
  const info = await getJson(`${API}/repos/${cfg.owner}/${cfg.repo}/commits/${cfg.branch}`, cfg.token);
  if (!info || !info.sha) throw new Error('GitHub không trả về commit');
  const current = readState().sha || null;
  return {
    cfg, current, latest: info.sha,
    available: current !== info.sha || !hasCode(),
    message: String((info.commit && info.commit.message) || '').split('\n')[0],
  };
}

// node_modules nằm ở .anter/node_modules (thư mục cha của .anter/code) nên Node tự tìm thấy,
// và không bị mất khi thư mục code bị thay.
function ensureDeps(pkg, lock) {
  const deps = (pkg && pkg.dependencies) || {};
  const hash = crypto.createHash('sha1').update(JSON.stringify(deps)).update(lock || '').digest('hex');
  if (readState().depsHash === hash && fs.existsSync(path.join(HOME, 'node_modules'))) return;
  fs.mkdirSync(HOME, { recursive: true });
  const lockFile = path.join(HOME, 'package-lock.json');
  const useCi = !!lock;
  log(useCi ? 'Đang cài thư viện (npm ci, theo package-lock.json)...' : 'Đang cài thư viện (npm install — repo chưa có package-lock.json)...');
  // npm ci cần package.json khớp lockfile -> giữ name/version của repo; không có lock thì dùng bản tối giản
  fs.writeFileSync(path.join(HOME, 'package.json'), JSON.stringify(useCi
    ? { name: pkg.name, version: pkg.version, private: true, dependencies: deps }
    : { name: 'anter-runtime', private: true, dependencies: deps }, null, 2));
  if (useCi) fs.writeFileSync(lockFile, lock); else rmrf(lockFile);
  if (useCi) rmrf(path.join(HOME, 'node_modules')); // npm ci tự xoá, làm sẵn để chắc chắn sạch
  const r = spawnSync('npm', [useCi ? 'ci' : 'install', '--omit=dev', '--no-fund', '--no-audit'], {
    cwd: HOME, stdio: 'inherit', shell: process.platform === 'win32', // Windows: npm là npm.cmd
  });
  if (r.status !== 0) throw new Error((useCi ? 'npm ci' : 'npm install') + ' thất bại' + (r.error ? ': ' + r.error.message : ''));
  writeState({ depsHash: hash });
}

async function install(info) {
  const { cfg, latest } = info;
  log(`Đang tải ${cfg.owner}/${cfg.repo}@${cfg.branch} (${latest.slice(0, 7)})...`);
  const tgz = await request(`${API}/repos/${cfg.owner}/${cfg.repo}/tarball/${latest}`, cfg.token, '*/*');
  const files = untar(zlib.gunzipSync(tgz));

  const stage = path.join(HOME, 'code.new');
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });
  let n = 0;
  for (const f of files) {
    const rel = f.name.split('/').slice(1).join('/'); // bỏ thư mục gốc "owner-repo-sha"
    if (!rel) continue;
    const dst = path.resolve(stage, rel);
    if (!dst.startsWith(stage + path.sep)) continue;   // chặn đường dẫn thoát ra ngoài (../)
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.data);
    n++;
  }
  if (!fs.existsSync(path.join(stage, 'main.js'))) throw new Error('repo không có main.js ở thư mục gốc');

  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8')); } catch {}
  let lock = '';
  try { lock = fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8'); } catch {}
  ensureDeps(pkg, lock); // lỗi ở đây -> giữ nguyên bản cũ

  // Thay nguyên thư mục code (file cũ không còn trong bản mới tự biến mất)
  rmrf(CODE + '.old');
  if (fs.existsSync(CODE)) fs.renameSync(CODE, CODE + '.old');
  fs.renameSync(stage, CODE);
  rmrf(CODE + '.old');
  writeState({ sha: latest, updatedAt: new Date().toISOString() });
  log(`Đã cập nhật xong (${n} file).`, 'ok');
}

let forceUpdate = false; // true khi người dùng gõ "update" trong tool (thoát mã 42) -> bỏ qua ANTER_AUTO_UPDATE=0
async function sync() {
  let info;
  const forced = forceUpdate; forceUpdate = false;
  if (hasCode() && !settings().autoUpdate && !forced) {
    log('Tự cập nhật đang TẮT (ANTER_AUTO_UPDATE=0) → chạy bản đã tải. Gõ "update" trong tool để cập nhật thủ công.', 'warn');
    return;
  }
  try {
    info = await checkForUpdate();
  } catch (e) {
    if (hasCode()) { log(`Không kết nối được GitHub (${e.message}) → chạy bản đã tải trước đó.`, 'warn'); return; }
    throw new Error(`Chưa có code trên máy và không tải được từ GitHub: ${e.message}`);
  }
  if (!info.available) { log(`Đang là bản mới nhất (${info.latest.slice(0, 7)}).`, 'ok'); return; }
  log(info.current ? `Có bản mới: ${info.message}` : 'Lần đầu chạy: tải code từ GitHub (có thể mất vài phút để cài thư viện)...', 'info');
  try {
    await install(info);
  } catch (e) {
    rmrf(path.join(HOME, 'code.new'));
    if (!hasCode() && fs.existsSync(CODE + '.old')) { rmrf(CODE); fs.renameSync(CODE + '.old', CODE); } // khôi phục nếu đang thay dở
    if (hasCode()) { log(`Cập nhật lỗi (${e.message}) → chạy bản cũ.`, 'warn'); return; }
    throw e;
  }
}

// ───────────────────────── Chạy ─────────────────────────
let child = null;
function launch() {
  child = spawn(process.execPath, [path.join(CODE, 'main.js')], {
    cwd: DATA_DIR, // config.json, revenue.json, logs/, auth_cache/... đều nằm ở máy, cạnh load.js
    stdio: 'inherit',
    env: { ...process.env, ANTER_LOADER: __filename, ANTER_DATA_DIR: DATA_DIR }, // để lệnh "update" trong tool gọi lại load.js
  });
  child.on('error', e => { logErr('Không chạy được main.js: ' + e.message); process.exit(1); });
  child.on('exit', code => {
    child = null;
    if (code === 42) { forceUpdate = true; return start(); } // yêu cầu cập nhật + khởi động lại
    process.exit(code || 0);
  });
}

// Máy mới chưa có config.json -> tạo file trống (tool cần file này tồn tại); thêm bot bằng lệnh "addbot" hoặc trên web
function ensureConfig() {
  const f = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(f)) return;
  fs.writeFileSync(f, JSON.stringify({ bots: [] }, null, 2));
  log('Chưa có config.json → đã tạo file trống.', 'ok');
}

async function start() {
  try { await sync(); ensureConfig(); } catch (e) { logErr(e.message); process.exit(1); }
  launch();
}

module.exports = { checkForUpdate, untar };

if (require.main === module) {
  if (parseInt(process.versions.node, 10) < 18) { logErr('Cần Node.js >= 18 (đang dùng ' + process.versions.node + ')'); process.exit(1); }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (child) child.kill(sig); else process.exit(0); });
  start();
}
