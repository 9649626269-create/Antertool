'use strict';
// Tự cập nhật từ GitHub: so sánh commit mới nhất với commit đã cài, tải zip,
// ghi đè code nhưng GIỮ dữ liệu người dùng (config.json, revenue.json, ...).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, '.update-state.json');

// File/thư mục KHÔNG bao giờ bị ghi đè hay xoá khi cập nhật
const PROTECTED = [
  'config.json', 'config.json.bak', 'config.json.tmp',
  'revenue.json', '.env', 'proxies.txt', 'node_modules', '.update-state.json',
  'update.json', 'backups', 'logs', 'data',
];

function loadSettings() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8')); } catch {}
  return {
    owner: process.env.GH_OWNER || s.owner,
    repo: process.env.GH_REPO || s.repo,
    branch: process.env.GH_BRANCH || s.branch || 'main',
    token: process.env.GITHUB_TOKEN || s.token || '', // chỉ cần nếu repo private
    enabled: s.enabled !== false,
  };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function writeState(st) { fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); }

function get(url, token, asBuffer) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'anter-updater',
        Accept: asBuffer ? '*/*' : 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      timeout: 20000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(res.headers.location, token, asBuffer));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(asBuffer ? buf : JSON.parse(buf.toString('utf8')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function checkForUpdate() {
  const cfg = loadSettings();
  if (!cfg.enabled || !cfg.owner || !cfg.repo) return { available: false, reason: 'chưa cấu hình update.json' };
  const info = await get(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/commits/${cfg.branch}`, cfg.token);
  const latest = info.sha;
  const current = readState().sha || null;
  return {
    available: !!current && current !== latest,
    firstRun: !current,
    current, latest, cfg,
    message: (info.commit && info.commit.message || '').split('\n')[0],
  };
}

function copyTree(src, dst, isRoot) {
  for (const name of fs.readdirSync(src)) {
    if (isRoot && PROTECTED.includes(name)) continue;
    if (name === '.git') continue;
    const s = path.join(src, name), d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTree(s, d, false);
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    }
  }
}

function listFiles(dir, base = dir, out = []) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    if (fs.statSync(p).isDirectory()) listFiles(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

// Thêm key mới của config mặc định (nếu bản mới có) mà KHÔNG đụng giá trị user đã đặt
function mergeMissing(target, defaults) {
  let changed = false;
  for (const k of Object.keys(defaults)) {
    if (!(k in target)) { target[k] = defaults[k]; changed = true; }
    else if (defaults[k] && typeof defaults[k] === 'object' && !Array.isArray(defaults[k])
      && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      if (mergeMissing(target[k], defaults[k])) changed = true;
    }
  }
  return changed;
}

async function applyUpdate(info, log = console.log) {
  const { cfg, latest } = info;
  const AdmZip = require('adm-zip');
  log(`[update] Đang tải ${cfg.owner}/${cfg.repo}@${cfg.branch} (${latest.slice(0, 7)})...`);
  const zipBuf = await get(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}/zipball/${latest}`, cfg.token, true);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anter-upd-'));
  try {
    new AdmZip(zipBuf).extractAllTo(tmp, true);
    const top = fs.readdirSync(tmp)[0]; // GitHub bọc trong 1 thư mục owner-repo-sha
    const srcRoot = path.join(tmp, top);

    // Sao lưu config trước khi cập nhật
    const bdir = path.join(ROOT, 'backups');
    fs.mkdirSync(bdir, { recursive: true });
    for (const f of ['config.json', 'revenue.json']) {
      const p = path.join(ROOT, f);
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(bdir, `${f}.${Date.now()}.bak`));
    }

    const oldPkg = safeRead(path.join(ROOT, 'package.json'));
    const newFiles = new Set(listFiles(srcRoot));

    // Xoá file code cũ không còn trong bản mới (chỉ trong src/), không đụng dữ liệu
    const oldSrc = path.join(ROOT, 'src');
    if (fs.existsSync(oldSrc)) {
      for (const rel of listFiles(oldSrc, ROOT)) {
        if (!newFiles.has(rel)) { try { fs.unlinkSync(path.join(ROOT, rel)); } catch {} }
      }
    }

    copyTree(srcRoot, ROOT, true);

    // Bổ sung key config mới nếu bản mới có config.json mẫu
    const defCfg = path.join(srcRoot, 'config.json');
    const userCfg = path.join(ROOT, 'config.json');
    if (fs.existsSync(defCfg) && fs.existsSync(userCfg)) {
      try {
        const d = JSON.parse(fs.readFileSync(defCfg, 'utf8'));
        const u = JSON.parse(fs.readFileSync(userCfg, 'utf8'));
        const { bots, ...dRest } = d; // không bao giờ đụng danh sách bot/tài khoản của user
        if (mergeMissing(u, dRest)) fs.writeFileSync(userCfg, JSON.stringify(u, null, 2));
      } catch (e) { log('[update] Bỏ qua merge config: ' + e.message); }
    }

    // Chỉ npm install khi dependencies thay đổi
    const newPkg = safeRead(path.join(ROOT, 'package.json'));
    const depsOf = p => JSON.stringify(p && p.dependencies || {});
    if (depsOf(oldPkg) !== depsOf(newPkg) || !fs.existsSync(path.join(ROOT, 'node_modules'))) {
      log('[update] Dependencies thay đổi → npm install...');
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['install', '--production', '--no-fund', '--no-audit'], { cwd: ROOT, stdio: 'inherit' });
      if (r.status !== 0) throw new Error('npm install thất bại');
    }
    writeState({ sha: latest, updatedAt: new Date().toISOString() });
    log('[update] Cập nhật xong.');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function safeRead(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

async function run(log = console.log) {
  try {
    const info = await checkForUpdate();
    if (info.firstRun && info.latest) {
      // Lần đầu: ghi nhận commit hiện tại, coi như bản đang chạy là mới nhất
      writeState({ sha: info.latest, updatedAt: new Date().toISOString() });
      log('[update] Khởi tạo theo dõi phiên bản.');
      return false;
    }
    if (!info.available) { log('[update] Đang là bản mới nhất.'); return false; }
    log(`[update] Có bản mới: ${info.message}`);
    await applyUpdate(info, log);
    return true;
  } catch (e) {
    log('[update] Không kiểm tra được (bỏ qua, chạy bản hiện tại): ' + e.message);
    return false;
  }
}

module.exports = { run, checkForUpdate, applyUpdate, mergeMissing };
