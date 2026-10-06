'use strict';
// ProtocolGuard — xử lý lỗi parse gói tin server->client của minecraft-protocol, ví dụ:
//   "Parse error for play.toClient: Read error for undefined : array size is abnormally large, not reading: 210986572"
// Lỗi này KHÔNG làm đứt kết nối: chỉ 1 gói bị bỏ, các gói sau vẫn đọc bình thường. Việc cần làm là
//   1) không báo [ERR] liên tục (gộp + giới hạn tần suất),
//   2) cho biết CHÍNH XÁC gói nào đang hỏng (tên + id + vài byte đầu) để biết nguyên nhân,
//   3) nếu lỗi dồn dập (lệch phiên bản giao thức) thì nói rõ cách xử lý.
const fs = require('fs');
const path = require('path');

const PARSE_RE = /parse error for|deserialization error|array size is abnormally large|read error for|chunk size is/i;
const isParseError = msg => PARSE_RE.test(String(msg || ''));

// Đọc VarInt đầu buffer (id gói). Trả null nếu buffer hỏng/thiếu.
function readVarInt(buf) {
  if (!buf || !buf.length) return null;
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (i >= buf.length) return null;
    const b = buf[i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value, size: i + 1 };
  }
  return null;
}

// Tên gói theo minecraft-data (protocol.<state>.toClient.types.packet -> mapper). Lỗi cấu trúc -> null.
function packetName(registry, state, id) {
  try {
    const mappings = registry?.protocol?.[state]?.toClient?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings;
    if (!mappings) return null;
    return mappings['0x' + id.toString(16).padStart(2, '0')] || null;
  } catch { return null; }
}

const FILE_CAP_BYTES = 1024 * 1024;   // file log tối đa ~1MB
const FILE_MAX_PER_KEY = 5;           // mỗi loại gói chỉ ghi 5 mẫu / lần chạy
const HEX_MAX_BYTES = 512;            // chỉ lưu 512 byte đầu của gói
const FLOOD_COUNT = 20;               // >= 20 lỗi / 60s => coi là lệch phiên bản
const FLOOD_WINDOW_MS = 60000;
const REPEAT_LOG_MS = 60000;

class ProtocolGuard {
  constructor({ botId = '?', log = () => {}, logDir = path.join(process.cwd(), 'logs') } = {}) {
    this.botId = botId;
    this._log = log;
    this._logDir = logDir;
    this._client = null;
    this._mc = null;
    this._onState = null;
    this._last = null;           // thông tin gói vừa parse lỗi (do hook ghi lại)
    this._byKey = new Map();     // key -> { count, lastLogged, written }
    this._recent = [];           // timestamps để phát hiện lỗi dồn dập
    this._hintAt = 0;
    this.total = 0;
  }

  attach(mc) {
    this.detach();
    const client = mc?._client;
    if (!client) return;
    this._mc = mc;
    this._client = client;
    // deserializer được tạo lại mỗi lần đổi state (login -> configuration -> play) nên phải hook lại
    this._onState = () => this._hook(client);
    try { client.on('state', this._onState); } catch { }
    this._hook(client);
  }

  detach() {
    try { if (this._client && this._onState) this._client.removeListener('state', this._onState); } catch { }
    this._client = null;
    this._mc = null;
    this._onState = null;
    this._last = null;
  }

  _hook(client) {
    try {
      const d = client.deserializer;
      if (!d || d.__protocolGuard || typeof d.parsePacketBuffer !== 'function') return;
      const orig = d.parsePacketBuffer;
      const self = this;
      d.parsePacketBuffer = function guardedParse(buf) {
        try {
          return orig.call(this, buf);
        } catch (e) {
          // PartialReadError do protodef tự nuốt; chỉ các lỗi còn lại mới thành sự kiện 'error'
          if (!e || !e.partialReadError) { try { self._remember(client, buf); } catch { } }
          throw e;
        }
      };
      d.__protocolGuard = true;
    } catch { /* hook thất bại thì chỉ mất phần chẩn đoán, bot vẫn chạy */ }
  }

  _remember(client, buf) {
    const v = readVarInt(buf);
    const state = client.state || client.protocolState || 'play';
    const registry = this._mc?.registry || this._mc?.mcData;
    this._last = {
      at: Date.now(),
      state,
      id: v ? v.value : null,
      name: v ? packetName(registry, state, v.value) : null,
      size: buf ? buf.length : 0,
      head: buf ? Buffer.from(buf.subarray(0, HEX_MAX_BYTES)) : null,
    };
  }

  // Trả true nếu đã xử lý (là lỗi parse) -> caller KHÔNG cần log [ERR] nữa.
  handleError(err) {
    const msg = err?.message || String(err);
    if (!isParseError(msg)) return false;
    const now = Date.now();
    this.total++;

    const rec = this._last && now - this._last.at < 3000 ? this._last : null;
    const key = rec
      ? `${rec.state}.${rec.name || (rec.id !== null ? '0x' + rec.id.toString(16) : 'unknown')}`
      : 'unknown';
    let st = this._byKey.get(key);
    if (!st) { st = { count: 0, lastLogged: 0, written: 0 }; this._byKey.set(key, st); }
    st.count++;

    if (st.count === 1) {
      const detail = rec
        ? `gói "${key}" (id 0x${(rec.id ?? 0).toString(16)}, ${rec.size} byte)`
        : 'không xác định được gói nào';
      this._log('warn', `Lỗi đọc gói tin từ server: ${detail} — ${this._short(msg)}. Gói này bị bỏ qua, bot vẫn chạy bình thường.`);
      st.lastLogged = now;
    } else if (now - st.lastLogged >= REPEAT_LOG_MS) {
      this._log('warn', `Lỗi đọc gói "${key}" đã lặp ${st.count} lần (bỏ qua, bot vẫn chạy).`);
      st.lastLogged = now;
    }

    if (st.written < FILE_MAX_PER_KEY) { st.written++; this._writeFile(key, rec, msg); }

    this._recent.push(now);
    while (this._recent.length && now - this._recent[0] > FLOOD_WINDOW_MS) this._recent.shift();
    if (this._recent.length >= FLOOD_COUNT && now - this._hintAt > 10 * 60 * 1000) {
      this._hintAt = now;
      this._log('err',
        `Có ${this._recent.length} lỗi đọc gói trong 60s — gần như chắc chắn lệch phiên bản giao thức. ` +
        'Cách xử lý: (1) chạy "npm i mineflayer@latest minecraft-protocol@latest minecraft-data@latest"; ' +
        '(2) đặt đúng "version" của server trong config.json (hoặc bỏ trống để tự dò); ' +
        '(3) gửi file logs/protocol-errors.log để dò gói bị lỗi.');
    }
    return true;
  }

  _short(msg) {
    return String(msg).replace(/\s+/g, ' ').slice(0, 160);
  }

  _writeFile(key, rec, msg) {
    try {
      fs.mkdirSync(this._logDir, { recursive: true });
      const file = path.join(this._logDir, 'protocol-errors.log');
      try { if (fs.statSync(file).size > FILE_CAP_BYTES) return; } catch { /* chưa có file */ }
      const mc = this._mc;
      const line = JSON.stringify({
        t: new Date().toISOString(),
        bot: this.botId,
        mcVersion: mc?.version || mc?.registry?.version?.minecraftVersion || null,
        protocol: mc?.registry?.version?.version ?? null,
        key,
        id: rec?.id ?? null,
        size: rec?.size ?? null,
        error: this._short(msg),
        hexHead: rec?.head ? rec.head.toString('hex') : null,
      }) + '\n';
      fs.appendFile(file, line, () => { });
    } catch { /* ghi log lỗi không được làm hỏng bot */ }
  }
}

module.exports = ProtocolGuard;
module.exports.isParseError = isParseError;
module.exports.readVarInt = readVarInt;
module.exports.packetName = packetName;
