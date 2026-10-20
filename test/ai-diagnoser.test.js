'use strict';
const assert = require('assert');
const AiDiagnoser = require('../src/core/AiDiagnoser');

const okFetch = (calls, text = 'Nguyên nhân: X') => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) };
};
const mk = (o = {}) => new AiDiagnoser({ env: { GEMINI_API_KEY: 'k-123456', ...(o.env || {}) }, envDir: '/nonexistent', ...o });

(async () => {
  // không có key / AI_DIAGNOSE=0 / enabled:false -> tắt, không gọi mạng
  const calls = [];
  assert.strictEqual(new AiDiagnoser({ env: {}, envDir: '/nonexistent', fetch: okFetch(calls) }).enabled, false);
  assert.strictEqual(mk({ env: { AI_DIAGNOSE: '0' }, fetch: okFetch(calls) }).enabled, false);
  assert.strictEqual(mk({ config: { ai: { enabled: false } }, fetch: okFetch(calls) }).enabled, false);
  assert.strictEqual(await new AiDiagnoser({ env: {}, envDir: '/nonexistent', fetch: okFetch(calls) }).diagnose('X', new Error('a')), null);
  assert.strictEqual(calls.length, 0);

  // gọi đúng URL/header, key không nằm trong URL, redact trước khi gửi, ghi log [AI]
  const logs = []; const c1 = [];
  const d = mk({ fetch: okFetch(c1), redact: s => s.replace(/secret-pass/g, '***'), log: (l, m) => logs.push([l, m]) });
  const out = await d.diagnose('UNCAUGHT', new Error('lỗi với secret-pass'), 'bot-1');
  assert.strictEqual(out, 'Nguyên nhân: X');
  assert.strictEqual(c1.length, 1);
  assert.ok(c1[0].url.includes('/models/gemini-3.8-flash:generateContent'));
  assert.ok(!c1[0].url.includes('k-123456'));
  assert.strictEqual(c1[0].init.headers['x-goog-api-key'], 'k-123456');
  const sent = JSON.parse(c1[0].init.body).contents[0].parts[0].text;
  assert.ok(sent.includes('***') && !sent.includes('secret-pass'));
  assert.ok(logs.length === 1 && logs[0][0] === 'sys' && logs[0][1].startsWith('[AI]'));

  // cooldown: cùng lỗi (khác số) không gọi lại; lỗi khác thì gọi; hết cooldown thì gọi lại
  let now = Date.parse('2026-10-20T00:00:00Z'); const c2 = [];
  const d2 = mk({ fetch: okFetch(c2), now: () => now });
  await d2.diagnose('U', new Error('timeout sau 1000 ms'));
  await d2.diagnose('U', new Error('timeout sau 2000 ms'));
  assert.strictEqual(c2.length, 1);
  await d2.diagnose('U', new Error('lỗi hoàn toàn khác'));
  assert.strictEqual(c2.length, 2);
  now += 31 * 60000;
  await d2.diagnose('U', new Error('timeout sau 3000 ms'));
  assert.strictEqual(c2.length, 3);

  // giới hạn mỗi ngày, sang ngày mới thì đặt lại
  let t = Date.parse('2026-10-20T00:00:00Z'); const c3 = [];
  const d3 = mk({ fetch: okFetch(c3), now: () => t, config: { ai: { maxPerDay: 2, cooldownMin: 1 } } });
  for (let i = 0; i < 5; i++) { await d3.diagnose('U', new Error('lỗi ' + 'abc'.repeat(i + 1))); t += 120000; }
  assert.strictEqual(c3.length, 2);
  t = Date.parse('2026-10-21T00:00:00Z');
  await d3.diagnose('U', new Error('lỗi mới hẳn'));
  assert.strictEqual(c3.length, 3);

  // 429 / mạng hỏng: không ném lỗi, ghi warn, không lộ key
  const logs4 = [];
  const d4 = mk({ fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'quota k-123456' } }) }), log: (l, m) => logs4.push([l, m]) });
  assert.strictEqual(await d4.diagnose('U', new Error('e')), null);
  assert.ok(logs4[0][0] === 'warn' && logs4[0][1].includes('429') && !logs4[0][1].includes('k-123456'));
  const d5 = mk({ fetch: async () => { throw new Error('ECONNRESET'); }, log: () => {} });
  assert.strictEqual(await d5.diagnose('U', new Error('e')), null);

  // timeout: fetch bị abort -> ghi cảnh báo dễ hiểu; GEMINI_TIMEOUT_MS ưu tiên hơn config
  const logs7 = [];
  const d7 = mk({ env: { GEMINI_API_KEY: 'k-123456', GEMINI_TIMEOUT_MS: '1500' }, config: { ai: { timeoutMs: 99999 } }, log: (l, m) => logs7.push([l, m]),
    fetch: async (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => { const e = new Error('This operation was aborted'); e.name = 'AbortError'; rej(e); })) });
  assert.strictEqual(d7.timeoutMs, 1500);
  assert.strictEqual(await d7.diagnose('U', new Error('chậm')), null);
  assert.ok(logs7[0][0] === 'warn' && logs7[0][1].includes('GEMINI_TIMEOUT_MS'));
  assert.strictEqual(mk({ fetch: okFetch([]) }).model, 'gemini-3.8-flash');
  assert.strictEqual(mk({ fetch: okFetch([]) }).timeoutMs, 60000);

  // đọc .env cạnh config.json (không ghi đè biến môi trường)
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# c\nGEMINI_API_KEY="from-dotenv"\nGEMINI_MODEL=gemini-x\n');
  const d6 = new AiDiagnoser({ env: {}, envDir: dir, fetch: okFetch([]) });
  assert.strictEqual(d6.apiKey, 'from-dotenv'); assert.strictEqual(d6.model, 'gemini-x'); assert.strictEqual(d6.enabled, true);
  assert.strictEqual(new AiDiagnoser({ env: { GEMINI_API_KEY: 'envwins' }, envDir: dir, fetch: okFetch([]) }).apiKey, 'envwins');
  fs.rmSync(dir, { recursive: true, force: true });

  // ===== thông báo từ server =====
  const sv = []; const slogs = [];
  const ds = mk({ fetch: okFetch(sv, 'Mức độ: cần chú ý'), log: (l, m) => slogs.push([l, m]), redact: s => s.replace(/matkhau123/g, '***') });
  // tin thường (không từ khoá) ở chế độ important -> bỏ qua; chat/quảng cáo bình thường không tốn quota
  assert.strictEqual(await ds.analyzeServerNotice('system', 'Bạn đã nhận được 5 shard từ lồng'), null);
  assert.strictEqual(sv.length, 0);
  // từ khoá có dấu / viết hoa vẫn khớp; 'bạn' (ban không dấu) KHÔNG làm khớp nhầm
  assert.strictEqual(ds.isImportantNotice('Server sẽ BẢO TRÌ lúc 22:00'), true);
  assert.strictEqual(ds.isImportantNotice('Bạn đã bán tất cả'), false);
  assert.strictEqual(ds.isImportantNotice('Hãy xác minh bạn là người thật'), true);
  assert.strictEqual(await ds.analyzeServerNotice('system', 'Server sẽ bảo trì lúc 22:00, mật khẩu matkhau123', 'bot-1'), 'Mức độ: cần chú ý');
  assert.strictEqual(sv.length, 1);
  const sent2 = JSON.parse(sv[0].init.body).contents[0].parts[0].text;
  assert.ok(sent2.includes('bảo trì') && sent2.includes('***') && !sent2.includes('matkhau123'));
  assert.ok(sent2.includes('KHÔNG TIN CẬY') && sent2.includes('giả mạo'));        // chống chèn lệnh + hỏi dấu hiệu giả mạo
  assert.ok(slogs[0][0] === 'sys' && slogs[0][1].startsWith('[AI] Thông báo server [bot-1] (system)'));
  // trùng (cùng nội dung, khác số) trong cooldown -> bỏ qua
  assert.strictEqual(await ds.analyzeServerNotice('system', 'Server sẽ bảo trì lúc 23:00, mật khẩu matkhau123', 'bot-1'), null);
  assert.strictEqual(sv.length, 1);
  // kick luôn được phân tích dù không có từ khoá; 'connection ended' thì bỏ qua
  assert.ok(await ds.analyzeServerNotice('kick', 'You are fine'));
  assert.strictEqual(sv.length, 2);
  assert.strictEqual(await ds.analyzeServerNotice('disconnect', 'connection ended'), null);
  assert.strictEqual(sv.length, 2);
  // kick + disconnect đến liên tiếp: cả hai đều được xử lý tuần tự (không rơi mất)
  const sv3 = []; let inflight = 0, maxInflight = 0;
  const ds3 = mk({ log: () => {}, fetch: async (u, i) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise(r => setTimeout(r, 20)); inflight--; sv3.push(1); return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }; } });
  await Promise.all([ds3.analyzeServerNotice('kick', 'Bị kick vì AFK'), ds3.analyzeServerNotice('disconnect', 'Máy chủ đóng')]);
  assert.strictEqual(sv3.length, 2); assert.strictEqual(maxInflight, 1);
  // chế độ all: mọi tin hệ thống; chế độ off: kể cả kick cũng không gọi
  const sv4 = [];
  const ds4 = mk({ fetch: okFetch(sv4), log: () => {}, config: { ai: { serverMessages: 'all' } } });
  await ds4.analyzeServerNotice('system', 'Tin bất kỳ không từ khoá');
  assert.strictEqual(sv4.length, 1);
  const ds5 = mk({ fetch: okFetch(sv4), log: () => {}, env: { GEMINI_API_KEY: 'k-123456', AI_SERVER_MESSAGES: 'off' } });
  assert.strictEqual(await ds5.analyzeServerNotice('kick', 'x'), null);
  assert.strictEqual(sv4.length, 1);
  // từ khoá tự thêm; hạn mức riêng cho thông báo server (maxServerPerDay) không ăn vào hạn mức lỗi
  const sv6 = [];
  const ds6 = mk({ fetch: okFetch(sv6), log: () => {}, config: { ai: { serverKeywords: ['Khuyến mãi'], maxServerPerDay: 2, maxPerDay: 5 } } });
  assert.strictEqual(ds6.isImportantNotice('Sự kiện KHUYẾN MÃI hôm nay'), true);
  for (let i = 0; i < 4; i++) await ds6.analyzeServerNotice('kick', 'lý do ' + 'x'.repeat(i + 1) + 'abc'.repeat(i));
  assert.strictEqual(sv6.length, 2);
  assert.ok(await ds6.diagnose('U', new Error('lỗi code riêng')));   // hạn mức lỗi vẫn còn
  // 503 khi phân tích thông báo: không ném lỗi, ghi warn
  const l7 = [];
  const ds7 = mk({ log: (l, m) => l7.push([l, m]), fetch: async () => ({ ok: false, status: 503, json: async () => ({ error: { message: 'high demand' } }) }) });
  assert.strictEqual(await ds7.analyzeServerNotice('kick', 'abc'), null);
  assert.ok(l7[0][0] === 'warn' && l7[0][1].includes('503'));

  console.log('ai-diagnoser.test OK');
})().catch(e => { console.error(e); process.exit(1); });
