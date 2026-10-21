'use strict';
const assert = require('assert');
const { detectCapabilities } = require('../src/ui/capabilities');
const { stripAnsi, sanitizeUntrusted, visibleWidth, truncate, pad, wrap, maskSecret, redactSecretsInText } = require('../src/ui/text');
const { createTheme } = require('../src/ui/theme');
const { OutputWriter } = require('../src/ui/writer');
const { Spinner, renderProgressBar } = require('../src/ui/progress');

// 1. Capabilities detection: default TTY, NO_COLOR=1, TERM=dumb, FORCE_COLOR=1, --no-color, --plain
{
  const ttyStream = { isTTY: true, columns: 100, rows: 30 };
  const nonTtyStream = { isTTY: false };

  const cDefault = detectCapabilities({ stream: ttyStream, env: {}, argv: [], listenResize: false });
  assert.strictEqual(cDefault.color, true);
  assert.strictEqual(cDefault.unicode, true);
  assert.strictEqual(cDefault.interactive, true);
  assert.strictEqual(cDefault.width, 100);

  const cNoColor = detectCapabilities({ stream: ttyStream, env: { NO_COLOR: '1' }, argv: [], listenResize: false });
  assert.strictEqual(cNoColor.color, false);
  assert.strictEqual(cNoColor.colorDepth, 0);

  const cDumb = detectCapabilities({ stream: ttyStream, env: { TERM: 'dumb' }, argv: [], listenResize: false });
  assert.strictEqual(cDumb.color, false);
  assert.strictEqual(cDumb.unicode, false);
  assert.strictEqual(cDumb.interactive, false);

  const cForce = detectCapabilities({ stream: nonTtyStream, env: { FORCE_COLOR: '1' }, argv: [], listenResize: false });
  assert.strictEqual(cForce.color, true);
  assert.strictEqual(cForce.colorDepth, 16);

  const cPipe = detectCapabilities({ stream: nonTtyStream, env: {}, argv: [], listenResize: false });
  assert.strictEqual(cPipe.color, false);
  assert.strictEqual(cPipe.interactive, false);
  assert.strictEqual(cPipe.width, 80); // fallback 80

  const cFlagPlain = detectCapabilities({ stream: ttyStream, env: { FORCE_COLOR: '1' }, argv: ['node', 'main.js', '--plain'], listenResize: false });
  assert.strictEqual(cFlagPlain.color, false);
  assert.strictEqual(cFlagPlain.unicode, false);
  assert.strictEqual(cFlagPlain.symbols.ok, 'OK');
  assert.strictEqual(cFlagPlain.borders.topLeft, '+');
}

// 2. Text utilities: stripAnsi, sanitizeUntrusted, visibleWidth, truncate, pad, wrap, secrets
{
  assert.strictEqual(stripAnsi('\x1b[32m✔ OK\x1b[0m'), '✔ OK');
  assert.strictEqual(sanitizeUntrusted('§c§lHello \x1b[31mWorld\x07\x00\r\nNext\tTab'), 'Hello World\nNext  Tab');

  assert.strictEqual(visibleWidth('Hello'), 5);
  assert.strictEqual(visibleWidth('\x1b[36mHello\x1b[0m'), 5);
  assert.strictEqual(visibleWidth('Tiếng Việt'), 10);
  assert.strictEqual(visibleWidth('Tiếng Việt'.normalize('NFD')), 10);
  assert.strictEqual(visibleWidth('中文'), 4);
  assert.strictEqual(visibleWidth('🟢'), 2);

  const styled = '\x1b[32mConnected to server successfully\x1b[0m';
  const trUni = truncate(styled, 12, { ascii: false });
  assert.strictEqual(visibleWidth(trUni), 12);
  assert.strictEqual(stripAnsi(trUni), 'Connected t…');
  assert.ok(trUni.endsWith('\x1b[0m'));

  const trAsc = truncate(styled, 12, { ascii: true });
  assert.strictEqual(visibleWidth(trAsc), 12);
  assert.strictEqual(stripAnsi(trAsc), 'Connected...');

  const pLeft = pad('\x1b[32mOK\x1b[0m', 6, 'left');
  assert.strictEqual(visibleWidth(pLeft), 6);
  const pRight = pad('\x1b[32m42\x1b[0m', 6, 'right');
  assert.strictEqual(visibleWidth(pRight), 6);
  assert.strictEqual(stripAnsi(pRight), '    42');

  const wrapped = wrap('One two three four five six', 10);
  assert.ok(wrapped.every(l => visibleWidth(l) <= 10));

  assert.strictEqual(maskSecret('https://discord.com/api/webhooks/123456789/abcdef1234567890'), 'https://discord.com/.../****7890');
  assert.strictEqual(maskSecret('123456789:AAHxyz1234567890abcdef'), '123***:****cdef');
  assert.strictEqual(maskSecret('supersecretpassword'), '****word');
  assert.strictEqual(maskSecret('short'), '***');
  const red = redactSecretsInText('Login /dn mypass123 and webhook https://discord.com/api/webhooks/111/tok9876543210', ['customSecret']);
  assert.ok(!red.includes('mypass123') && !red.includes('tok9876543210'));
}

// 3. Theme: color on vs off, no double-wrapping, status formatting
{
  const capsColor = detectCapabilities({ color: true, unicode: true, listenResize: false });
  const capsPlain = detectCapabilities({ color: false, unicode: false, listenResize: false });
  const thColor = createTheme(capsColor);
  const thPlain = createTheme(capsPlain);

  const s1 = thColor.success('Ready');
  assert.ok(s1.includes('\x1b[32m') && s1.endsWith('\x1b[0m'));
  assert.strictEqual(thColor.info(s1), s1);

  const s2 = thPlain.success('Ready');
  assert.strictEqual(s2, 'Ready');
  assert.ok(!s2.includes('\x1b'));

  assert.strictEqual(thPlain.formatStatus('OK').raw, 'OK OK');
  assert.strictEqual(thColor.formatStatus('OK').raw, '✔ OK');
  assert.strictEqual(thPlain.formatStatus('FAIL').raw, 'X FAIL');
}

// 4. OutputWriter & Spinner & ProgressBar
{
  const chunks = [];
  const fakeTty = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(str) { chunks.push(str); },
  };
  const caps = detectCapabilities({ stream: fakeTty, color: true, unicode: true, interactive: true, listenResize: false });
  const theme = createTheme(caps);
  const writer = new OutputWriter({ caps, theme, stream: fakeTty, registerCleanup: false });

  const sp = new Spinner({ writer, caps, theme, delayMs: 10, intervalMs: 80 });
  sp.start('Waiting for teleport...');
  assert.strictEqual(sp.isActive, true);

  setTimeout(() => {
    writer.writeLine(theme.info('[12:00:00] [INFO]    Interleaved log line'));
    sp.stop();
    assert.strictEqual(writer._cursorHidden, false, 'cursor must be restored after spinner stops');
    const combined = chunks.join('');
    assert.ok(combined.includes('Interleaved log line'));
    assert.ok(combined.includes('\x1b[?25h'), 'cursor show sequence must be emitted on cleanup');

    const bar = renderProgressBar(3, 10, { width: 10 }, caps, theme);
    assert.ok(stripAnsi(bar).includes('3/10'));
    assert.strictEqual(renderProgressBar(3, 0, {}, caps, theme), null);

    console.log('ui-foundation.test OK');
  }, 40);
}
