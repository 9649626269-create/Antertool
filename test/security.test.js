const assert = require('assert');
const s = require('../src/web/security');
const b64 = x => 'Basic ' + Buffer.from(x).toString('base64');
assert.strictEqual(s.tokenFromHeader(b64('admin:s3cret:with:colons')), 's3cret:with:colons');
assert.strictEqual(s.tokenFromHeader('Bearer abc'), 'abc');
assert.strictEqual(s.tokenFromHeader(undefined), '');
assert.strictEqual(s.isAuthorized('tok', b64('u:tok')), true);
assert.strictEqual(s.isAuthorized('tok', b64('u:bad')), false);
assert.strictEqual(s.isAuthorized('tok', undefined), false);
assert.strictEqual(s.isAuthorized('', undefined), true);
const req = (origin, host) => ({ headers: { origin, host } });
assert.strictEqual(s.isSameOrigin(req(undefined, 'localhost:3000')), true);
assert.strictEqual(s.isSameOrigin(req('http://localhost:3000', 'localhost:3000')), true);
assert.strictEqual(s.isSameOrigin(req('https://evil.com', 'localhost:3000')), false);
assert.strictEqual(s.isSameOrigin(req('not a url', 'localhost:3000')), false);
process.env.DASHBOARD_CORS_ORIGIN = 'https://ui.example.com';
assert.strictEqual(s.isSameOrigin(req('https://ui.example.com', 'localhost:3000')), true);
let res; s.allowSocketRequest(req('https://evil.com', 'localhost:3000'), (e, ok) => res = ok); assert.strictEqual(res, false);
// resolveBind: mặc định chỉ localhost; production/ra ngoài bắt buộc có token
{
  const r = (env, cfg) => s.resolveBind(env, cfg);
  let b = r({}, {});
  assert.deepStrictEqual([b.host, b.token, b.generated, b.exposed], ['127.0.0.1', '', false, false]);
  b = r({ NODE_ENV: 'production' }, {});
  assert.strictEqual(b.host, '0.0.0.0'); assert.strictEqual(b.generated, true); assert.ok(b.token.length >= 20);
  b = r({ NODE_ENV: 'production', DASHBOARD_TOKEN: 'abc' }, {});
  assert.deepStrictEqual([b.token, b.generated], ['abc', false]);
  b = r({ DASHBOARD_HOST: '0.0.0.0' }, {});
  assert.strictEqual(b.generated, true);
  b = r({}, { dashboardHost: '::1' });
  assert.deepStrictEqual([b.host, b.generated], ['::1', false]);
  b = r({ DASHBOARD_HOST: '127.0.0.1', NODE_ENV: 'production' }, {});
  assert.deepStrictEqual([b.token, b.exposed], ['', false]);
  assert.notStrictEqual(r({ NODE_ENV: 'production' }, {}).token, r({ NODE_ENV: 'production' }, {}).token);
}
console.log('SECURITY TESTS PASSED');
