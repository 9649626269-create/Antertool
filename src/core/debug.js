'use strict';
const { formatLogEntry } = require('./TuiEngine');
// Ghi lỗi "bị nuốt" (các khối catch trước đây để trống) khi bật ANTER_DEBUG=1.
// Mặc định không in gì, nên hành vi bình thường không đổi; bật lên để tìm nguyên nhân khi bot hành xử lạ.
const on = () => /^(1|true|on)$/i.test(String(process.env.ANTER_DEBUG || ''));
function dbg(tag, err) {
  if (!on()) return;
  const msg = err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : String(err);
  console.log(formatLogEntry({ level: 'debug', scope: `debug:${tag}`, msg }));
}
module.exports = { dbg };
