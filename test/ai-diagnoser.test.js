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
  assert.ok(c1[0].url.includes('/models/gemini-2.5-flash:generateContent'));
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

  // đọc .env cạnh config.json (không ghi đè biến môi trường)
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-env-'));
  fs.writeFileSync(path.join(dir, '.env'), '# c\nGEMINI_API_KEY="from-dotenv"\nGEMINI_MODEL=gemini-x\n');
  const d6 = new AiDiagnoser({ env: {}, envDir: dir, fetch: okFetch([]) });
  assert.strictEqual(d6.apiKey, 'from-dotenv'); assert.strictEqual(d6.model, 'gemini-x'); assert.strictEqual(d6.enabled, true);
  assert.strictEqual(new AiDiagnoser({ env: { GEMINI_API_KEY: 'envwins' }, envDir: dir, fetch: okFetch([]) }).apiKey, 'envwins');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log('ai-diagnoser.test OK');
})().catch(e => { console.error(e); process.exit(1); });
