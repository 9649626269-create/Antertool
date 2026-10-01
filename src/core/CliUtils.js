'use strict';
// Parser cho lệnh CLI "addbot".
//
//   addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]
//   addbot 123 mk 123
//   addbot 123 mk 123 play.example.vn 25565 1.21.1 Steve
//   addbot 123 mk 123 play.example.vn:25565 1.21.1        (ip:port viết liền)
//   addbot 123 mk 123 - - 1.21.1                          ("-" = bỏ qua, lấy mặc định)
//   addbot 123 mk 123 ip=play.example.vn port=25565 ver=1.21.1 owner=Steve id=acc1
//
// Hàm này chỉ đọc + kiểm tra cú pháp. Giá trị bỏ trống để undefined, nơi gọi tự điền mặc định.

const USAGE = 'addbot <tên> mk <mật khẩu> [ip] [port] [ver] [owner]';
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;
const USER_RE = /^[A-Za-z0-9_]{3,16}$/;
const OWNER_RE = /^[A-Za-z0-9_]{1,16}$/;
const ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const KV_RE = /^(id|host|ip|server|port|ver|version|owner)=(.*)$/i;
const isSkip = t => t === '-' || t === '_';

function fail(error) { return { ok: false, error }; }

function parseAddBotArgs(args) {
  const kv = {};
  const pos = [];
  for (const a of args || []) {
    const m = KV_RE.exec(a);
    if (m) {
      const k = m[1].toLowerCase();
      kv[k === 'ip' || k === 'server' ? 'host' : k === 'ver' ? 'version' : k] = m[2];
    } else pos.push(a);
  }

  const username = pos.shift();
  if (!username) return fail('Thiếu tên bot');
  if (pos.length && /^(mk|pass|password|pw|matkhau)$/i.test(pos[0])) pos.shift();
  const password = pos.shift();
  if (!password) return fail('Thiếu mật khẩu (addbot <tên> mk <mật khẩu>)');

  // Các tham số vị trí còn lại: host -> port -> ver -> owner. Thiếu cái nào thì bỏ qua cái đó
  // (vd "host 1.21.1" hiểu là host + ver, port lấy mặc định).
  let host, port, version, owner;
  let slot = 0;
  while (pos.length) {
    const t = pos[0];
    if (slot === 0) {
      pos.shift(); slot = 1;
      if (isSkip(t)) continue;
      const i = t.lastIndexOf(':');
      if (i > 0) {                       // ip:port viết liền
        host = t.slice(0, i);
        const p = t.slice(i + 1);
        if (!/^\d{1,5}$/.test(p)) return fail(`Port không hợp lệ trong "${t}"`);
        port = p; slot = 2;
      } else host = t;
    } else if (slot === 1) {
      if (/^\d{1,5}$/.test(t)) { port = t; pos.shift(); }
      else if (isSkip(t)) pos.shift();
      slot = 2;                          // không phải số -> coi như bỏ port, xét token này ở ô ver
    } else if (slot === 2) {
      if (VERSION_RE.test(t)) { version = t; pos.shift(); }
      else if (isSkip(t)) pos.shift();
      slot = 3;
    } else if (slot === 3) {
      pos.shift(); slot = 4;
      if (!isSkip(t)) owner = t;
    } else {
      return fail(`Dư tham số: ${pos.join(' ')}`);
    }
  }

  // key=value ghi đè giá trị vị trí
  if (kv.host !== undefined) host = kv.host;
  if (kv.port !== undefined) port = kv.port;
  if (kv.version !== undefined) version = kv.version;
  if (kv.owner !== undefined) owner = kv.owner;

  if (!USER_RE.test(username)) return fail(`Tên bot phải 3-16 ký tự (chữ, số, dấu _): ${username}`);
  const id = kv.id !== undefined ? kv.id : username;
  if (!ID_RE.test(id)) return fail('id chỉ gồm chữ, số, _ . - (tối đa 32 ký tự)');
  if (host !== undefined && !HOST_RE.test(host)) return fail(`IP/host server không hợp lệ: ${host}`);
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) return fail(`Port không hợp lệ (1-65535): ${port}`);
    port = n;
  }
  if (version !== undefined && !VERSION_RE.test(version)) return fail(`Version phải dạng 1.21.1 (nhận được: ${version})`);
  if (owner !== undefined && !OWNER_RE.test(owner)) return fail(`Tên owner không hợp lệ (chữ, số, _ tối đa 16 ký tự): ${owner}`);

  return { ok: true, data: { id, username, password, host, port, version, owner } };
}

module.exports = { parseAddBotArgs, ADDBOT_USAGE: USAGE };
