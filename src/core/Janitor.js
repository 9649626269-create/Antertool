'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Janitor — dọn file rác / file cũ lỗi thời của Antertool. KHÔNG phụ thuộc thư viện nào (load.js cũng gọi được).
 *
 * Chạy ở 3 thời điểm:
 *   - load.js: mỗi lần chạy `node load.js` và sau khi tải bản cập nhật (dùng chính file này trong bản code vừa tải,
 *     nên danh sách "file bị loại bỏ" của bản MỚI áp dụng ngay cho dữ liệu của bản CŨ).
 *   - main.js: lúc khởi động và mỗi `intervalHours` giờ (bot treo nhiều ngày vẫn không đầy ổ).
 *   - lệnh tay: `clean` / `clean dry` / `clean status`.
 *
 * Phân loại (mỗi loại tắt/bật được trong config.json -> "cleanup"):
 *   temp         xoá  file tạm/dở dang: *.tmp *.part *.swp *~ .DS_Store Thumbs.db .write-test-* npm-debug.log ...
 *   updater      xoá  thư mục dở của updater (.anter/code.new, code.old, *.tgz) + .anter/node_modules/.cache
 *   logs         xoá  runtime-*.log/.jsonl quá keepDays ngày, vượt tổng maxLogMB (xoá cũ nhất trước), cắt protocol-errors.log quá to
 *   backups      xoá  chỉ giữ N bản backup mới nhất trong backups/ và N bản config.json.*.bak có đóng dấu thời gian
 *   legacy       cách ly  file bản cũ đã bị loại bỏ (danh sách có sẵn + obsolete.json đi kèm bản code mới)
 *   authCache    cách ly  auth_cache/<id> của bot không còn trong config.json
 *   archives     cách ly  file .zip/.tgz của các bản cập nhật cũ nằm trong thư mục dữ liệu (giữ N bản mới nhất)
 *   staleCopies  cách ly  (MẶC ĐỊNH TẮT) bản sao mã nguồn cũ ở thư mục dữ liệu khi đang chạy bằng load.js (code thật nằm ở .anter/code)
 *
 * An toàn:
 *   - "Cách ly" = chuyển vào .anter/trash/<ngày giờ>/ giữ `trashDays` ngày rồi mới xoá hẳn, nên nhầm vẫn lấy lại được.
 *   - KHÔNG BAO GIỜ đụng tới dữ liệu người dùng (PROTECTED), không đi theo symlink, không ra ngoài thư mục dữ liệu / thư mục log.
 *   - File mới sửa trong `minAgeMs` (mặc định 2 phút) bị bỏ qua để không phá file đang ghi dở.
 *   - dryRun: chỉ liệt kê, không đổi gì.
 */

const DAY_MS = 86400000;
const MB = 1024 * 1024;

const DEFAULTS = Object.freeze({
  enabled: true,
  onStart: true,          // tự dọn khi khởi động
  intervalHours: 24,      // và định kỳ (0 = không định kỳ)
  keepDays: 7,            // log runtime giữ bao nhiêu ngày (main.js truyền keepDays của FileLogger vào)
  maxLogMB: 200,          // tổng dung lượng log tối đa (0 = không giới hạn)
  protocolLogMaxMB: 5,    // protocol-errors.log vượt mức này thì chỉ giữ phần cuối
  keepBackups: 5,         // số bản trong backups/ được giữ
  keepConfigBackups: 3,   // số config.json.*.bak có dấu thời gian được giữ (config.json.bak chính luôn giữ)
  keepArchives: 1,        // số file .zip/.tgz bản cập nhật được giữ
  trashDays: 7,           // thùng rác giữ bao lâu
  minAgeMs: 120000,
  staleCopies: false,     // chủ động bật mới dọn bản sao mã nguồn cũ
  legacy: true,
  authCache: true,
  archives: true,
  temp: true,
  logs: true,
  backups: true,
  updater: true,
});

// Dữ liệu của người dùng / file hệ thống: tuyệt đối không xoá, không cách ly.
const PROTECTED = new Set([
  'config.json', 'config.json.bak', '.env', 'update.json', 'revenue.json', 'proxies.txt', 'beggars.json', 'autobeg.json',
  'ai_history.json', 'load.js', 'state.json', 'package.json', 'package-lock.json',
]);

// File của các bản cũ đã bị loại bỏ (đường dẫn tương đối với thư mục dữ liệu). Thêm vào đây khi bỏ một file khỏi dự án.
// Có thể bổ sung mà không sửa code: đặt obsolete.json cạnh main.js: { "paths": ["a/b.js"], "reason": "..." }
const LEGACY = Object.freeze([
  { path: 'autosell.json', reason: 'cấu hình autosell kiểu cũ — bản hiện tại lưu trong config.json' },
]);

const TEMP_NAME = [
  /\.(tmp|temp|part|crdownload|swp|swo|orig|rej)$/i,
  /~$/,
  /^\.write-test-\d+$/,
  /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i,
  /^(npm-debug\.log.*|yarn-error\.log|yarn-debug\.log.*)$/i,
  /^core\.\d+$/,
  /^hs_err_pid\d+\.log$/,
];
const TEMP_DIR = [/^__MACOSX$/];
const LOG_RE = /^runtime-(\d{4}-\d{2}-\d{2})(?:\.\d+)?\.(?:log|jsonl)$/;
const ARCHIVE_RE = /^(?=.*anter)[^/]*\.(zip|tgz|tar\.gz)$/i;
const CFG_BAK_RE = /^config\.json\.(?!bak$)[^/]*\.bak$|^config-[^/]*\.bak$|^config\.json\.bak[.-].+$/i;

const fmtBytes = n => n >= MB ? (n / MB).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
const within = (root, p) => { const r = path.resolve(root) + path.sep; return (path.resolve(p) + path.sep).startsWith(r) && path.resolve(p) !== path.resolve(root); };

function lstat(p) { try { return fs.lstatSync(p); } catch { return null; } }
function list(dir) { try { return fs.readdirSync(dir); } catch { return []; } }
function dirSize(p, depth = 0) {
  const st = lstat(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  if (depth > 8) return 0;
  let n = 0;
  for (const f of list(p)) n += dirSize(path.join(p, f), depth + 1);
  return n;
}
function newestMtime(p, depth = 0) {
  const st = lstat(p);
  if (!st) return 0;
  let m = st.mtimeMs;
  if (st.isDirectory() && depth < 4) for (const f of list(p)) m = Math.max(m, newestMtime(path.join(p, f), depth + 1));
  return m;
}

class Janitor {
  /**
   * opts: { dataDir, codeDir?, logDirs?: [], botIds?: [] | null, config?: object, dryRun?, now?, onlyCategories?: [] , log?: fn }
   *  - botIds = null -> tự đọc config.json trong dataDir; mảng rỗng KHÔNG xoá auth_cache nào (chặn xoá nhầm khi chưa có bot)
   */
  constructor(opts = {}) {
    this.dataDir = path.resolve(opts.dataDir || process.cwd());
    this.codeDir = opts.codeDir ? path.resolve(opts.codeDir) : null;
    this.dryRun = !!opts.dryRun;
    this.viaLoader = !!opts.viaLoader || !!process.env.ANTER_LOADER;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this.opts = { ...DEFAULTS, ...pickDefined(opts.config && opts.config.cleanup), ...pickDefined(opts.overrides) };
    if (opts.keepDays !== undefined && !(opts.config && opts.config.cleanup && opts.config.cleanup.keepDays !== undefined)) this.opts.keepDays = opts.keepDays;
    this.only = Array.isArray(opts.onlyCategories) && opts.onlyCategories.length ? new Set(opts.onlyCategories) : null;
    this.home = path.join(this.dataDir, '.anter');
    this.trashRoot = path.join(this.home, 'trash');
    this._cfg = opts.config || null;
    this._botIds = opts.botIds !== undefined ? opts.botIds : undefined;
    this._extraLogDirs = [].concat(opts.logDirs || []).filter(Boolean).map(d => path.resolve(d));
    this.report = { removed: [], quarantined: [], truncated: [], purged: [], skipped: [], errors: [], freed: 0 };
    this._stamp = null;
  }

  // ───────── tiện ích an toàn ─────────
  _roots() { return [this.dataDir, ...this._logDirs()]; }
  _logDirs() {
    const set = new Set([path.join(this.dataDir, 'logs'), path.join(this.dataDir, 'log'), ...this._extraLogDirs]);
    if (lstat('/sdcard/bot/log')) set.add('/sdcard/bot/log');
    if (process.env.ANTER_LOG_DIR) set.add(path.resolve(this.dataDir, process.env.ANTER_LOG_DIR));
    const cfg = this._config();
    if (cfg && typeof cfg.fileLogDir === 'string' && cfg.fileLogDir.trim()) set.add(path.resolve(this.dataDir, cfg.fileLogDir.trim()));
    return [...set].filter(d => d !== this.dataDir && lstat(d) && lstat(d).isDirectory());
  }
  _config() {
    if (this._cfg === null || this._cfg === undefined) {
      try { this._cfg = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'config.json'), 'utf8')); } catch { this._cfg = false; }
    }
    return this._cfg || null;
  }
  _isProtected(abs) {
    if (path.resolve(abs) === this.dataDir) return true;
    if (within(this.dataDir, abs) && path.dirname(abs) === this.dataDir && PROTECTED.has(path.basename(abs))) return true;
    return false;
  }
  _allowed(abs) {
    if (this._isProtected(abs)) return false;
    return this._roots().some(r => within(r, abs));
  }
  _old(st) { return this.now() - st.mtimeMs >= this.opts.minAgeMs; }
  _skip(abs, why) { this.report.skipped.push({ path: this._rel(abs), reason: why }); }
  _rel(abs) { return path.relative(this.dataDir, abs) || abs; }
  _enabled(cat) { return this.opts.enabled !== false && this.opts[cat] !== false && (!this.only || this.only.has(cat)); }

  // Xoá hẳn 1 file/thư mục (nếu không phải dryRun). Trả về true nếu đã (hoặc sẽ) xoá.
  _delete(abs, cat, reason, size) {
    if (!this._allowed(abs)) { this._skip(abs, 'được bảo vệ / ngoài phạm vi'); return false; }
    const st = lstat(abs);
    if (!st) return false;
    if (st.isSymbolicLink()) { this._skip(abs, 'symlink'); return false; }
    const bytes = size !== undefined ? size : dirSize(abs);
    try {
      if (!this.dryRun) fs.rmSync(abs, { recursive: true, force: true });
      this.report.removed.push({ path: this._rel(abs), category: cat, reason, bytes });
      this.report.freed += bytes;
      return true;
    } catch (e) { this.report.errors.push(`${this._rel(abs)}: ${e.message}`); return false; }
  }
  // Cách ly vào .anter/trash/<stamp>/<đường dẫn tương đối>
  _quarantine(abs, cat, reason) {
    if (!this._allowed(abs)) { this._skip(abs, 'được bảo vệ / ngoài phạm vi'); return false; }
    const st = lstat(abs);
    if (!st) return false;
    if (st.isSymbolicLink()) { this._skip(abs, 'symlink'); return false; }
    const bytes = dirSize(abs);
    try {
      if (!this.dryRun) {
        if (!this._stamp) this._stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-');
        const dst = path.join(this.trashRoot, this._stamp, this._rel(abs).replace(/^(\.\.[\\/])+/, '').replace(/[\\/]+/g, '__'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        try { fs.renameSync(abs, dst); } catch (e) { // khác ổ đĩa (EXDEV): sao chép rồi xoá
          fs.cpSync(abs, dst, { recursive: true });
          fs.rmSync(abs, { recursive: true, force: true });
        }
      }
      this.report.quarantined.push({ path: this._rel(abs), category: cat, reason, bytes });
      return true;
    } catch (e) { this.report.errors.push(`${this._rel(abs)}: ${e.message}`); return false; }
  }

  // ───────── các loại dọn ─────────
  _cleanTemp() {
    const scan = (dir, depth) => {
      for (const name of list(dir)) {
        const abs = path.join(dir, name);
        const st = lstat(abs);
        if (!st || st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (TEMP_DIR.some(r => r.test(name)) && this._old(st)) this._delete(abs, 'temp', 'thư mục rác của hệ điều hành');
          else if (depth < 1 && ['logs', 'log', 'backups', '.anter'].includes(name)) scan(abs, depth + 1);
          continue;
        }
        if (this._isProtected(abs) || !TEMP_NAME.some(r => r.test(name))) continue;
        if (this._old(st)) this._delete(abs, 'temp', 'file tạm / dở dang', st.size);
      }
    };
    scan(this.dataDir, 0);
    // Thư mục log nằm NGOÀI thư mục dữ liệu (vd /sdcard/bot/log): chỉ dọn file thử ghi của chính tool, không đụng gì khác
    for (const d of this._logDirs()) {
      if (within(this.dataDir, d)) continue;
      for (const name of list(d)) {
        const abs = path.join(d, name), st = lstat(abs);
        if (st && st.isFile() && /^\.write-test-\d+$/.test(name) && this._old(st)) this._delete(abs, 'temp', 'file thử ghi còn sót', st.size);
      }
    }
  }

  _cleanUpdater() {
    // Chỉ dọn khi KHÔNG có tiến trình update đang chạy dở: file mới sửa trong minAgeMs được bỏ qua.
    for (const name of ['code.new', 'code.old']) {
      const abs = path.join(this.home, name);
      const st = lstat(abs);
      if (!st) continue;
      // code.old mà chưa có code -> load.js sẽ tự khôi phục, đừng xoá
      if (name === 'code.old' && !lstat(path.join(this.home, 'code', 'main.js'))) { this._skip(abs, 'bản cũ cần khôi phục'); continue; }
      if (this.now() - newestMtime(abs) >= this.opts.minAgeMs) this._delete(abs, 'updater', 'thư mục update dở dang');
    }
    for (const name of list(this.home)) {
      if (/\.(tgz|tar|gz|tmp|part)$/i.test(name)) {
        const abs = path.join(this.home, name), st = lstat(abs);
        if (st && st.isFile() && this._old(st)) this._delete(abs, 'updater', 'gói tải về còn sót', st.size);
      }
    }
    const cache = path.join(this.home, 'node_modules', '.cache');
    if (lstat(cache)) this._delete(cache, 'updater', 'cache của thư viện (tự tạo lại khi cần)');
  }

  _cleanLogs() {
    const files = [];
    const limit = this.now() - this.opts.keepDays * DAY_MS;
    for (const dir of this._logDirs()) {
      for (const f of list(dir)) {
        const abs = path.join(dir, f);
        const st = lstat(abs);
        if (!st || !st.isFile()) continue;
        const m = LOG_RE.exec(f);
        if (m) {
          if (Date.parse(m[1] + 'T00:00:00Z') + DAY_MS < limit) this._delete(abs, 'logs', `log quá ${this.opts.keepDays} ngày`, st.size);
          else files.push({ abs, size: st.size, t: Date.parse(m[1] + 'T00:00:00Z') || st.mtimeMs });
        } else if (f === 'protocol-errors.log') this._truncateTail(abs, st);
      }
    }
    // vượt tổng dung lượng -> xoá cũ nhất trước (luôn chừa file mới nhất)
    const cap = this.opts.maxLogMB * MB;
    if (cap > 0) {
      files.sort((a, b) => a.t - b.t || a.abs.localeCompare(b.abs));
      let total = files.reduce((s, f) => s + f.size, 0);
      while (total > cap && files.length > 1) {
        const f = files.shift();
        if (this._delete(f.abs, 'logs', `tổng log vượt ${this.opts.maxLogMB} MB`, f.size)) total -= f.size; else break;
      }
    }
  }
  _truncateTail(abs, st) {
    const max = this.opts.protocolLogMaxMB * MB;
    if (!(max > 0) || st.size <= max || !this._old(st)) return;
    const keep = Math.floor(max / 2);
    try {
      if (!this.dryRun) {
        const fd = fs.openSync(abs, 'r');
        const buf = Buffer.alloc(keep);
        fs.readSync(fd, buf, 0, keep, st.size - keep);
        fs.closeSync(fd);
        const nl = buf.indexOf(10);
        fs.writeFileSync(abs, buf.subarray(nl >= 0 ? nl + 1 : 0));
      }
      this.report.truncated.push({ path: this._rel(abs), category: 'logs', reason: `quá ${this.opts.protocolLogMaxMB} MB, chỉ giữ phần cuối`, bytes: st.size - keep });
      this.report.freed += st.size - keep;
    } catch (e) { this.report.errors.push(`${this._rel(abs)}: ${e.message}`); }
  }
  _cleanBackups() {
    const keepNewest = (entries, keep, why) => {
      entries.sort((a, b) => b.t - a.t);
      for (const e of entries.slice(Math.max(0, keep))) this._delete(e.abs, 'backups', why, e.size);
    };
    const bdir = path.join(this.dataDir, 'backups');
    const items = [];
    for (const f of list(bdir)) {
      const abs = path.join(bdir, f), st = lstat(abs);
      if (st && !st.isSymbolicLink() && this._old(st)) items.push({ abs, t: st.mtimeMs, size: dirSize(abs) });
    }
    keepNewest(items, this.opts.keepBackups, `backup cũ (giữ ${this.opts.keepBackups} bản mới nhất)`);
    const cfgBak = [];
    for (const f of list(this.dataDir)) {
      if (!CFG_BAK_RE.test(f)) continue;
      const abs = path.join(this.dataDir, f), st = lstat(abs);
      if (st && st.isFile() && this._old(st)) cfgBak.push({ abs, t: st.mtimeMs, size: st.size });
    }
    keepNewest(cfgBak, this.opts.keepConfigBackups, `bản backup config cũ (giữ ${this.opts.keepConfigBackups} bản mới nhất)`);
  }

  _cleanLegacy() {
    const entries = LEGACY.map(e => ({ ...e }));
    for (const base of [this.codeDir, this.dataDir]) {
      if (!base) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(base, 'obsolete.json'), 'utf8'));
        for (const p of Array.isArray(j.paths) ? j.paths : []) if (typeof p === 'string') entries.push({ path: p, reason: j.reason || 'đã bị loại bỏ ở bản cập nhật' });
      } catch { /* không có file -> bỏ qua */ }
    }
    const seen = new Set();
    for (const e of entries) {
      const abs = path.resolve(this.dataDir, e.path);
      if (seen.has(abs)) continue;
      seen.add(abs);
      if (!within(this.dataDir, abs) || !lstat(abs)) continue;
      if (this._isProtected(abs)) continue;
      const st = lstat(abs);
      if (st && this._old(st)) this._quarantine(abs, 'legacy', e.reason);
    }
  }

  _cleanAuthCache() {
    const dir = path.join(this.dataDir, 'auth_cache');
    if (!lstat(dir)) return;
    let ids = this._botIds;
    if (ids === undefined || ids === null) {
      const cfg = this._config();
      ids = cfg && Array.isArray(cfg.bots) ? cfg.bots.map(b => b && b.id) : null;
    }
    // Không biết danh sách bot (config lỗi / chưa có bot) -> KHÔNG đụng vào đăng nhập đã lưu
    if (!Array.isArray(ids) || !ids.length) return;
    const keep = new Set(ids.filter(x => x !== undefined && x !== null).map(String));
    for (const name of list(dir)) {
      const abs = path.join(dir, name), st = lstat(abs);
      if (!st || st.isSymbolicLink() || keep.has(name)) continue;
      if (newestMtime(abs) && this.now() - newestMtime(abs) >= this.opts.minAgeMs) this._quarantine(abs, 'authCache', `bot "${name}" không còn trong config.json`);
    }
  }

  _cleanArchives() {
    const items = [];
    for (const f of list(this.dataDir)) {
      if (!ARCHIVE_RE.test(f)) continue;
      const abs = path.join(this.dataDir, f), st = lstat(abs);
      if (st && st.isFile()) items.push({ abs, t: st.mtimeMs, st });
    }
    items.sort((a, b) => b.t - a.t);
    for (const e of items.slice(Math.max(0, this.opts.keepArchives))) {
      if (this.now() - e.t >= DAY_MS) this._quarantine(e.abs, 'archives', `gói cập nhật cũ (giữ ${this.opts.keepArchives} bản mới nhất)`);
    }
  }

  // Bản sao mã nguồn nằm cạnh load.js trong khi code thật chạy từ .anter/code -> load.js KHÔNG dùng, chỉ chiếm chỗ / gây nhầm khi sửa nhầm.
  _cleanStaleCopies() {
    if (!this.viaLoader) return;                                         // đang chạy thẳng main.js -> đây có thể là bản dev, đừng đụng
    if (!lstat(path.join(this.home, 'code', 'main.js'))) return;          // chưa có code tải về
    if (lstat(path.join(this.dataDir, '.git'))) { this._skip(this.dataDir, 'là repo git'); return; }
    for (const name of ['src', 'test', 'scripts', 'docs', 'main.js', 'Dockerfile', 'render.yaml', 'README.md', 'MANIFEST.txt', 'APPLY.txt',
      '.dockerignore', '.gitignore', '.env.example', 'config.example.json', 'node_modules']) {
      const abs = path.join(this.dataDir, name);
      if (lstat(abs)) this._quarantine(abs, 'staleCopies', 'bản sao mã nguồn cũ (code đang chạy nằm ở .anter/code)');
    }
  }

  _purgeTrash() {
    const limit = this.now() - this.opts.trashDays * DAY_MS;
    for (const name of list(this.trashRoot)) {
      const abs = path.join(this.trashRoot, name), st = lstat(abs);
      if (!st) continue;
      const t = Date.parse(name.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, '$1:$2:$3.$4')) || st.mtimeMs;
      if (t < limit) {
        const bytes = dirSize(abs);
        try {
          if (!this.dryRun) fs.rmSync(abs, { recursive: true, force: true });
          this.report.purged.push({ path: this._rel(abs), category: 'trash', reason: `thùng rác quá ${this.opts.trashDays} ngày`, bytes });
          this.report.freed += bytes;
        } catch (e) { this.report.errors.push(`${this._rel(abs)}: ${e.message}`); }
      }
    }
    if (!this.dryRun && lstat(this.trashRoot) && !list(this.trashRoot).length) { try { fs.rmdirSync(this.trashRoot); } catch { /* bỏ qua */ } }
  }

  /** Chạy tất cả. Không bao giờ ném lỗi. */
  run() {
    const steps = [
      ['temp', () => this._cleanTemp()],
      ['updater', () => this._cleanUpdater()],
      ['logs', () => this._cleanLogs()],
      ['backups', () => this._cleanBackups()],
      ['legacy', () => this._cleanLegacy()],
      ['authCache', () => this._cleanAuthCache()],
      ['archives', () => this._cleanArchives()],
      ['staleCopies', () => { if (this.opts.staleCopies === true || (this.only && this.only.has('staleCopies'))) this._cleanStaleCopies(); }],
    ];
    for (const [cat, fn] of steps) {
      if (!this._enabled(cat)) continue;
      try { fn(); } catch (e) { this.report.errors.push(`${cat}: ${e && e.message}`); }
    }
    if (this.opts.enabled !== false && !this.only) { try { this._purgeTrash(); } catch (e) { this.report.errors.push('trash: ' + (e && e.message)); } }
    return this.report;
  }

  /** Tóm tắt 1 dòng để in log; '' nếu không có gì thay đổi */
  static summary(report, dryRun = false) {
    const r = report;
    const n = r.removed.length + r.quarantined.length + r.truncated.length + r.purged.length;
    if (!n) return '';
    const parts = [];
    if (r.removed.length) parts.push(`${dryRun ? 'sẽ xoá' : 'xoá'} ${r.removed.length}`);
    if (r.quarantined.length) parts.push(`${dryRun ? 'sẽ cách ly' : 'cách ly'} ${r.quarantined.length} (thùng rác .anter/trash)`);
    if (r.truncated.length) parts.push(`cắt ${r.truncated.length} log quá to`);
    if (r.purged.length) parts.push(`${dryRun ? 'sẽ dọn' : 'dọn'} ${r.purged.length} mục thùng rác hết hạn`);
    return `Dọn rác: ${parts.join(', ')} · ${dryRun ? 'sẽ giải phóng' : 'giải phóng'} ${fmtBytes(r.freed)}`;
  }

  /** Danh sách chi tiết (mỗi mục 1 dòng) */
  static details(report, max = 40) {
    const rows = [
      ...report.removed.map(e => `  xoá       ${e.path} — ${e.reason} (${fmtBytes(e.bytes)})`),
      ...report.quarantined.map(e => `  cách ly   ${e.path} — ${e.reason} (${fmtBytes(e.bytes)})`),
      ...report.truncated.map(e => `  cắt       ${e.path} — ${e.reason}`),
      ...report.purged.map(e => `  dọn hẳn   ${e.path} — ${e.reason} (${fmtBytes(e.bytes)})`),
      ...report.skipped.map(e => `  bỏ qua    ${e.path} — ${e.reason}`),
      ...report.errors.map(e => `  LỖI       ${e}`),
    ];
    return rows.length > max ? [...rows.slice(0, max), `  ... và ${rows.length - max} mục nữa`] : rows;
  }

  /** Liệt kê thùng rác để biết lấy lại gì */
  static trashStatus(dataDir) {
    const root = path.join(path.resolve(dataDir), '.anter', 'trash');
    return list(root).sort().map(name => ({ name, items: list(path.join(root, name)), bytes: dirSize(path.join(root, name)) }));
  }
}

function pickDefined(o) {
  const out = {};
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && k in DEFAULTS) out[k] = v;
  return out;
}

/** Hàm tiện dụng: tạo Janitor, chạy, trả về report */
function clean(opts) { return new Janitor(opts).run(); }

module.exports = Janitor;
module.exports.clean = clean;
module.exports.DEFAULTS = DEFAULTS;
module.exports.PROTECTED = PROTECTED;
module.exports.LEGACY = LEGACY;
module.exports.fmtBytes = fmtBytes;
