'use strict';
// Ghi lỗi "bị nuốt" (các khối catch trước đây để trống) khi bật ANTER_DEBUG=1.
// Mặc định không in gì, nên hành vi bình thường không đổi; bật lên để tìm nguyên nhân khi bot hành xử lạ.
const { getDefaultRuntime } = require('../ui');

const on = () => /^(1|true|on)$/i.test(String(process.env.ANTER_DEBUG || ''));
function dbg(tag, err) {
  if (!on()) return;
  const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err);
  try {
    getDefaultRuntime().logger.debug(`[debug:${tag}] ${msg}`);
  } catch {
    // ignore if output stream is closed
  }
}
module.exports = { dbg };
