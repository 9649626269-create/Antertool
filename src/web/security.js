'use strict';
// Bảo vệ dashboard: (1) token tuỳ chọn (DASHBOARD_TOKEN hoặc config.dashboardToken), (2) chặn truy cập
// chéo nguồn (CSRF / WebSocket hijacking từ trang web khác tới localhost) bằng kiểm tra Origin == Host.
const crypto = require('crypto');

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const tokenEquals = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

// Lấy token từ header Authorization: "Basic base64(user:token)" (mật khẩu = token) hoặc "Bearer token"
function tokenFromHeader(value) {
  const v = String(value || '');
  let m = /^Basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(v);
  if (m) {
    const dec = Buffer.from(m[1], 'base64').toString('utf8');
    const i = dec.indexOf(':');
    return i >= 0 ? dec.slice(i + 1) : dec;
  }
  m = /^Bearer\s+(.+)$/i.exec(v);
  return m ? m[1].trim() : '';
}

function allowedOrigins() {
  return String(process.env.DASHBOARD_CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
}

// true nếu request không phải từ trang web khác nguồn. Không có header Origin (curl, app, cùng nguồn GET) -> cho qua.
function isSameOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins().includes(origin) || allowedOrigins().includes('*')) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// engine.io allowRequest: chặn WebSocket/polling từ trang web lạ
function allowSocketRequest(req, cb) {
  cb(null, isSameOrigin(req));
}

function isAuthorized(token, headerValue, authToken) {
  if (!token) return true;
  return tokenEquals(token, tokenFromHeader(headerValue) || authToken || '');
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const isLoopbackHost = h => LOOPBACK.has(String(h || '').toLowerCase()) || /^127\./.test(String(h || ''));

// Quyết định địa chỉ bind + token cho dashboard.
//  - host: DASHBOARD_HOST | config.dashboardHost; mặc định 127.0.0.1 (chỉ máy này).
//          Khi NODE_ENV=production (Docker/Render) mặc định 0.0.0.0 vì phải nhận kết nối từ ngoài container.
//  - token: DASHBOARD_TOKEN | config.dashboardToken. Nếu bind ra ngoài mà chưa có token -> tự sinh token ngẫu nhiên
//          (generated=true) để không bao giờ mở dashboard không mật khẩu ra mạng.
function resolveBind(env = process.env, config = {}) {
  const prod = env.NODE_ENV === 'production';
  const host = String(env.DASHBOARD_HOST || (config && config.dashboardHost) || (prod ? '0.0.0.0' : '127.0.0.1')).trim();
  let token = String(env.DASHBOARD_TOKEN || (config && config.dashboardToken) || '');
  let generated = false;
  if (!token && !isLoopbackHost(host)) { token = crypto.randomBytes(18).toString('base64url'); generated = true; }
  return { host, token, generated, exposed: !isLoopbackHost(host) };
}

module.exports = { resolveBind, isLoopbackHost, tokenEquals, tokenFromHeader, isSameOrigin, allowSocketRequest, isAuthorized, allowedOrigins };
