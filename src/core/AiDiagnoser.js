'use strict';
const fs = require('fs');
const path = require('path');
const { dbg } = require('./debug');

/**
 * AiDiagnoser — nhờ Gemini phân tích lỗi nặng ([FATAL]/[UNCAUGHT]/[UNHANDLED]) và ghi kết luận vào log runtime (+ Telegram).
 *
 *  - CHỈ đọc & gợi ý: không bao giờ sửa/ghi đè code đang chạy.
 *  - Không bao giờ làm hỏng bot: mọi lỗi (mạng, quota 429, key sai...) chỉ được ghi log mức warn / im lặng.
 *  - Chống tốn quota: cùng một lỗi chỉ phân tích 1 lần / cooldownMin phút; tối đa maxPerDay lần mỗi ngày; 1 yêu cầu tại một thời điểm.
 *  - Che mật khẩu/token bằng hàm redact do chủ tool đưa vào trước khi gửi đi; log chat người chơi không được gửi.
 *  - Khoá API: biến môi trường GEMINI_API_KEY, hoặc file .env cạnh config.json, hoặc config.json -> ai.apiKey (không khuyến khích).
 *  - Tắt: AI_DIAGNOSE=0 hoặc "ai": {"enabled": false}. Chưa có khoá -> tự tắt.
 *
 *  config.json (tuỳ chọn):  "ai": { "enabled": true, "model": "gemini-2.5-flash", "cooldownMin": 30, "maxPerDay": 20, "timeoutMs": 30000 }
 */
const DEFAULTS = { model: 'gemini-2.5-flash', cooldownMin: 30, maxPerDay: 20, timeoutMs: 30000, maxChars: 4000 };
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Đọc .env tối giản (KEY=VALUE, bỏ dòng # và dòng trống); không ghi đè biến môi trường đã có.
function readDotEnv(dir) {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m || m[0].trim().startsWith('#')) continue;
      out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (e) { /* không có .env */ }
  return out;
}

class AiDiagnoser {
  /**
   * opts: { config: {ai:{...}}, env: process.env, envDir: cwd, redact: s => s, log: (level,msg) => {},
   *         fetch: globalThis.fetch, now: () => Date.now() }
   */
  constructor(opts = {}) {
    const cfg = (opts.config && opts.config.ai) || {};
    const env = { ...readDotEnv(opts.envDir || process.cwd()), ...(opts.env || process.env) };
    this._fetch = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    this._now = opts.now || Date.now;
    this._redact = typeof opts.redact === 'function' ? opts.redact : s => s;
    this._log = typeof opts.log === 'function' ? opts.log : () => {};
    this.apiKey = String(env.GEMINI_API_KEY || cfg.apiKey || '').trim();
    this.model = String(env.GEMINI_MODEL || cfg.model || DEFAULTS.model).trim();
    this.cooldownMs = Math.max(1, Number(cfg.cooldownMin) || DEFAULTS.cooldownMin) * 60000;
    this.maxPerDay = Math.max(1, Math.floor(Number(cfg.maxPerDay)) || DEFAULTS.maxPerDay);
    this.timeoutMs = Math.max(1000, Number(cfg.timeoutMs) || DEFAULTS.timeoutMs);
    this.maxChars = DEFAULTS.maxChars;
    const off = /^(0|false|off)$/i.test(String(env.AI_DIAGNOSE || '')) || cfg.enabled === false;
    this.enabled = !off && !!this.apiKey && !!this._fetch;
    this._seen = new Map();      // dấu vân tay lỗi -> thời điểm phân tích gần nhất
    this._day = ''; this._count = 0;
    this._busy = false;
  }

  /** Chuẩn hoá lỗi thành chuỗi: bỏ số/địa chỉ đổi liên tục để cùng một lỗi cho cùng một vân tay. */
  static fingerprint(text) {
    return String(text).split('\n').slice(0, 3).join('|').replace(/0x[0-9a-f]+/gi, 'X').replace(/\d+/g, 'N').slice(0, 200);
  }

  _allow(fp) {
    const now = this._now();
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this._day) { this._day = day; this._count = 0; }
    if (this._count >= this.maxPerDay) return false;
    const last = this._seen.get(fp);
    if (last !== undefined && now - last < this.cooldownMs) return false;
    if (this._seen.size > 200) { for (const [k, t] of this._seen) if (now - t >= this.cooldownMs) this._seen.delete(k); }
    return true;
  }

  _prompt(text, context) {
    return 'Bạn là chuyên gia Node.js. Đây là lỗi của một tool quản lý nhiều bot Minecraft (mineflayer) kèm web dashboard.\n' +
      'Trả lời bằng tiếng Việt, ngắn gọn (tối đa ~12 dòng), theo 3 mục:\n' +
      '1) Nguyên nhân có khả năng nhất\n2) Cách kiểm tra\n3) Hướng sửa cụ thể (nếu cần sửa code thì nêu file/hàm). Không bịa nếu không chắc — hãy nói rõ là chưa chắc.\n\n' +
      `Ngữ cảnh: ${context || '(không có)'}\n\nLỗi:\n${text}`;
  }

  /** Gọi Gemini, trả về văn bản hoặc null. Ném lỗi nếu HTTP/mạng hỏng (để người gọi quyết định). */
  async ask(prompt) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
    try {
      const r = await this._fetch(`${ENDPOINT}${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey }, // key ở header, không để lộ trong URL
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      if (!r.ok) {
        let detail = '';
        try { const j = await r.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* bỏ qua */ }
        const err = new Error(`Gemini HTTP ${r.status}${detail ? ': ' + String(detail).slice(0, 200) : ''}`);
        err.status = r.status;
        throw err;
      }
      const j = await r.json();
      const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
      const out = Array.isArray(parts) ? parts.map(p => p.text || '').join('').trim() : '';
      return out || null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Phân tích 1 lỗi; ghi kết luận bằng log('sys', '[AI] ...'). Không bao giờ ném lỗi.
   * Trả về văn bản kết luận, hoặc null nếu bị bỏ qua / thất bại.
   */
  async diagnose(tag, err, context = '') {
    try {
      if (!this.enabled) return null;
      const raw = String((err && err.stack) || (err && err.message) || err || '');
      if (!raw) return null;
      const fp = AiDiagnoser.fingerprint(raw);
      if (this._busy || !this._allow(fp)) return null;
      this._busy = true;
      this._seen.set(fp, this._now()); this._count++;   // tính cả khi thất bại: không dồn dập gọi lại khi quota hết
      let text = this._redact(raw);
      if (text.length > this.maxChars) text = text.slice(0, this.maxChars) + '\n…(cắt bớt)';
      const answer = await this.ask(this._prompt(text, `${tag}${context ? ' · ' + this._redact(String(context)) : ''}`));
      if (answer) this._log('sys', `[AI] Phân tích ${tag} (${this.model}):\n${answer}`);
      return answer;
    } catch (e) {
      const why = e && e.status === 429 ? 'hết hạn mức (429), thử lại sau' : (e && e.message) || String(e);
      this._log('warn', `[AI] Không phân tích được ${tag}: ${String(why).replace(this.apiKey, '***')}`);
      dbg('AiDiagnoser', e);
      return null;
    } finally {
      this._busy = false;
    }
  }
}

module.exports = AiDiagnoser;
module.exports.AiDiagnoser = AiDiagnoser;
module.exports.readDotEnv = readDotEnv;
