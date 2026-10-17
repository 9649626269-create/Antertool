'use strict';
// Mật khẩu bot: ưu tiên biến môi trường để không phải để mật khẩu thật trong config.json (Render/Docker/Git).
//   BOT_PASSWORD_<ID>  (ID viết hoa, ký tự lạ -> "_", vd bot "bot-1" -> BOT_PASSWORD_BOT_1)
//   > botPassword của bot trong config.json
//   > BOT_PASSWORD (chung)  > botPassword cấp toàn cục
const envKey = id => 'BOT_PASSWORD_' + String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
function resolveBotPassword(cfg = {}, globalCfg = {}, env = process.env) {
  return env[envKey(cfg.id)] || cfg.botPassword || env.BOT_PASSWORD || globalCfg.botPassword || undefined;
}
module.exports = { resolveBotPassword, envKey };
