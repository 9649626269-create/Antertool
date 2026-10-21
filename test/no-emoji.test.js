'use strict';
// Kiểm tra chính sách ký hiệu (Section 2 & Section 13 mục 6, 7):
// - Không có emoji (\p{Extended_Pictographic}, U+FE0F, U+200D, regional indicators, keycaps, dingbats màu) trong mọi đầu ra Telegram
// - Kiểm tra cho cả 2 bộ ký hiệu 'unicode' và 'ascii'
// - Quét danh sách ký tự cho phép (allow-list scan)
// - Quét mã nguồn (source scan) các module Telegram và README.md
// - Kiểm tra sanitizeExternal (NFC, mã §x, bidi controls, cắt chuỗi an toàn theo code point không cắt đôi surrogate pair)
// - Kiểm tra fuzz / property-based với chuỗi Unicode ngẫu nhiên qua mọi bộ dựng giao diện
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const Symbols = require('../src/core/Symbols');
const TextSafe = require('../src/core/TextSafe');
const TelegramPanel = require('../src/core/TelegramPanel');
const { renderEventMessage, EVENT_CATALOG } = require('../src/core/NotificationCenter');
const { TelegramControl } = require('../src/core/TelegramControl');
const BotActivity = require('../src/core/BotActivity');

// Biểu thức kiểm tra các ký tự bị cấm theo mục 2.1
const FORBIDDEN_EMOJI_RE = /[\p{Extended_Pictographic}\uFE0F\u200D\u20E3\u{1F1E6}-\u{1F1FF}\u2714\u2716\u26A0\u2699\u25B6\u23F8\u2197\u2139\u2194\u25AA\u2611]/u;
const BIDI_OR_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/u;

// Tập ký tự hợp lệ trong đầu ra Telegram:
// - ASCII in được (0x20..0x7E) + xuống dòng (\n)
// - Chữ cái tiếng Việt / Latin mở rộng (\p{Script=Latin}) + dấu tổ hợp (\p{M})
// - Các ký hiệu trong bảng Symbols.js + sparkline (▁▂▃▄▅▆▇█) + dấu ngoặc kép/gạch ngang phổ thông (“ ” ‘ ’ — –)
const ALLOWED_EXTRA = new Set([
  ...Symbols.allowedGlyphChars(),
  ...'▁▂▃▄▅▆▇█“”‘’—–\n\r\t',
]);

function isAllowedChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp <= 0x7E) return true;
  if (ALLOWED_EXTRA.has(ch)) return true;
  if (/^[\p{L}\p{M}\p{N}]$/u.test(ch)) return true;
  return false;
}

function assertCleanTelegramOutput(str, label = '') {
  assert.strictEqual(typeof str, 'string', `Output must be string (${label})`);
  const m = FORBIDDEN_EMOJI_RE.exec(str);
  if (m) {
    const cp = m[0].codePointAt(0).toString(16).toUpperCase();
    assert.fail(`Forbidden emoji/symbol U+${cp} (${m[0]}) found in ${label}: ${str}`);
  }
  const b = BIDI_OR_CTRL_RE.exec(str);
  if (b) {
    const cp = b[0].codePointAt(0).toString(16).toUpperCase();
    assert.fail(`Forbidden control/bidi U+${cp} found in ${label}`);
  }
  for (const ch of Array.from(str)) {
    const code = ch.codePointAt(0);
    assert.ok(!(code >= 0xD800 && code <= 0xDFFF), `Lone surrogate U+${code.toString(16)} in ${label}`);
    assert.ok(
      isAllowedChar(ch),
      `Character U+${ch.codePointAt(0).toString(16).toUpperCase()} (${ch}) not in allow-list (${label})`
    );
  }
}

function assertValidTelegramHtml(html, label = '') {
  // Chỉ dùng các thẻ được Telegram hỗ trợ: b, i, u, s, code, pre, a, blockquote (kèm expandable), tg-spoiler
  const tagRe = /<\/?([a-zA-Z0-9-]+)(?:\s+([^>]*))?>/g;
  const allowedTags = new Set(['b', 'i', 'u', 's', 'code', 'pre', 'a', 'blockquote', 'tg-spoiler']);
  const stack = [];
  let match;
  while ((match = tagRe.exec(html)) !== null) {
    const full = match[0];
    const tag = match[1].toLowerCase();
    const attr = (match[2] || '').trim();
    assert.ok(allowedTags.has(tag), `Unsupported HTML tag <${tag}> in ${label}`);
    if (full.startsWith('</')) {
      assert.strictEqual(attr, '', `Closing tag </${tag}> cannot have attributes in ${label}`);
      const top = stack.pop();
      assert.strictEqual(top, tag, `Mismatched HTML closing tag </${tag}> (expected </${top}>) in ${label}`);
    } else {
      if (tag === 'blockquote' && attr) {
        assert.strictEqual(attr, 'expandable', `Only 'expandable' attribute allowed on <blockquote> in ${label}`);
      }
      stack.push(tag);
    }
  }
  assert.strictEqual(stack.length, 0, `Unclosed HTML tags [${stack.join(', ')}] in ${label}`);

  // Mọi ký tự '&' phải thuộc thực thể hợp lệ (&lt; &gt; &amp; &quot;)
  const ampRe = /&([a-zA-Z0-9#]+);|&/g;
  let am;
  while ((am = ampRe.exec(html)) !== null) {
    assert.ok(
      ['lt', 'gt', 'amp', 'quot'].includes(am[1]),
      `Invalid or unescaped entity "${am[0]}" in ${label}`
    );
  }
}

function assertCleanRenderedPayload(res, label = '') {
  if (!res) return;
  if (typeof res === 'string') {
    assertCleanTelegramOutput(res, label);
    assertValidTelegramHtml(res, label);
    return;
  }
  if (res.text) {
    assertCleanTelegramOutput(res.text, `${label}.text`);
    assertValidTelegramHtml(res.text, `${label}.text`);
    assert.ok(Array.from(res.text).length <= 4096, `Message exceeds 4096 code points (${label})`);
  }
  if (res.answerText) {
    assertCleanTelegramOutput(res.answerText, `${label}.answerText`);
    assert.ok(Array.from(res.answerText).length <= 200, `Callback answer exceeds 200 chars (${label})`);
  }
  if (Array.isArray(res.keyboard)) {
    assert.ok(res.keyboard.length <= 25, `Too many keyboard rows (${label})`);
    let totalBtns = 0;
    for (const row of res.keyboard) {
      assert.ok(row.length <= 8, `Row exceeds 8 buttons (${label})`);
      for (const btn of row) {
        totalBtns++;
        assertCleanTelegramOutput(btn.text, `${label}.btn(${btn.text})`);
        assert.ok(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `callback_data > 64 bytes: ${btn.callback_data}`);
        assert.ok(/^[\x20-\x7E]+$/.test(btn.callback_data), `callback_data must be ASCII: ${btn.callback_data}`);
      }
    }
    assert.ok(totalBtns <= 100, `Total buttons > 100 (${label})`);
  }
}

(async () => {
  // 1. Kiểm tra bảng ký hiệu Appendix A trên Node hiện tại
  for (const mode of ['unicode', 'ascii']) {
    Symbols.setSymbolSet(mode);
    assert.strictEqual(Symbols.getSymbolSet(), mode);
    for (const [token, pair] of Object.entries(Symbols.PALETTE)) {
      assertCleanTelegramOutput(pair[mode], `palette(${mode}:${token})`);
    }
    assertCleanTelegramOutput(Symbols.bar(3, 5, 5), `bar(${mode})`);
  }

  // 2. Kiểm tra sanitizeExternal (NFC, §x, bidi, emoji, surrogate-safe truncation)
  const nfd = 'Ti\u0065\u0302\u0301ng Vi\u0065\u0323\u0302t'; // NFD
  const sanitizedNfc = TextSafe.sanitizeExternal(nfd);
  assert.strictEqual(sanitizedNfc, sanitizedNfc.normalize('NFC'));
  assert.strictEqual(sanitizedNfc, 'Tiếng Việt');

  const hostileMc = '§a§l[VIP] §cAlex_VN\u202E\u2066\u{1F525}\u{1F468}\u200D\u{1F4BB}\u2714\uFE0F   xin   chào\u0007';
  const cleanMc = TextSafe.sanitizeExternal(hostileMc);
  assert.strictEqual(cleanMc, '[VIP] Alex_VN xin chào');
  assertCleanTelegramOutput(cleanMc, 'sanitizeExternal(hostileMc)');

  // Cắt chuỗi chứa cặp surrogate (astral plane) không bao giờ tạo lone surrogate
  const astral = 'A'.repeat(10) + '\u{1D400}\u{1D401}\u{1D402}' + 'B'.repeat(10);
  const cut = TextSafe.sanitizeExternal(astral, { max: 12 });
  assert.strictEqual(Array.from(cut).length, 12);
  assert.ok(cut.endsWith(Symbols.sym('ellipsis')));
  assertCleanTelegramOutput(cut, 'sanitizeExternal(astral)');

  // Lone surrogate đầu vào bị loại bỏ
  const lone = 'Thử \uD800 nghiệm \uDC00 xong';
  const cleanLone = TextSafe.sanitizeExternal(lone);
  assertCleanTelegramOutput(cleanLone, 'sanitizeExternal(lone)');

  // 3. Chạy mọi bộ dựng giao diện qua dữ liệu thù địch ở cả 2 chế độ unicode & ascii
  const hostileBot = {
    cfg: { id: 'bot-1', username: '§cSteve\u{1F680}\u202E<script>' },
    state: { connState: 'ONLINE', reconnects: 2, ping: 42, position: { x: 120.4, y: 64, z: -48.9 } },
    isOnline: true,
    _sellSpawnOn: true,
    _sellSpawnBusy: true,
    _sellSpawnIntervalMs: () => 300000,
    activities: new Map(),
    history: new BotActivity.RingBuffer(30),
  };
  BotActivity.initSessionActivity(hostileBot);
  BotActivity.setActivity(hostileBot, 'sell', 'Bán lồng 3/5 (vòng #128) \u{1F4B0} <bẩn>', {
    progress: { done: 3, total: 5 },
    now: 1700000000000 - 14000,
  });
  for (let i = 0; i < 30; i++) {
    BotActivity.pushHistory(
      hostileBot,
      `Lịch sử #${i} §4\u{1F6A8}\u202E <tag> & "quote" \u26A0\uFE0F hoàn tất`,
      ['info', 'ok', 'warn', 'err'][i % 4],
      1700000000000 - i * 1000
    );
  }

  const now = 1700000000000;
  const panelInfo = {
    botId: 'bot-1',
    allBotIds: ['bot-1', 'bot-2'],
    account: hostileBot.cfg.username,
    connState: 'ONLINE',
    sellOn: true,
    sellBusy: true,
    intervalMs: 300000,
    now,
    tz: 'Asia/Ho_Chi_Minh',
    stats: {
      total: 12400000,
      last1h: 250000,
      avgPerHour: 45833,
      perDayEst: 1100000,
      observedMs: 7200000,
      lastAt: now - 12000,
      lastAmount: 250000,
      today: 5000000,
      yesterday: 8000000,
      hourly: Array.from({ length: 12 }, (_, idx) => ({ label: `${idx}h`, amount: idx * 10000 })),
    },
    totalUptimeMs: 3 * 3600000 + 12 * 60000,
    sessionMs: 3 * 3600000,
    session: hostileBot,
    nextSellAt: now + 160000,
    protect: { on: true, level: 2, name: 'Cân bằng \u{1F6E1}\uFE0F', threats: 0, lastScanAt: now - 3000 },
    pos: { x: 120, y: 64, z: -48 },
    ping: 42,
    proxy: true,
    proxyStatus: 'có \u{1F310}',
    macros: ['afk_macro', 'mualong'],
  };

  for (const mode of ['unicode', 'ascii']) {
    Symbols.setSymbolSet(mode);

    // Panel, StatusList, BotsPage, BotMenu, HelpText
    assertCleanRenderedPayload(TelegramPanel.buildPanel(panelInfo), `buildPanel(${mode})`);
    assertCleanRenderedPayload(TelegramPanel.buildStatusList([panelInfo]), `buildStatusList(${mode})`);
    assertCleanRenderedPayload(TelegramPanel.buildBotsPage([panelInfo], 1), `buildBotsPage(${mode})`);
    assertCleanRenderedPayload(TelegramPanel.buildBotMenu(panelInfo), `buildBotMenu(${mode})`);
    assertCleanRenderedPayload(TelegramPanel.buildTelegramHelpText(), `buildTelegramHelpText(${mode})`);

    // Mọi sự kiện trong EVENT_CATALOG với chuỗi thù địch
    for (const key of Object.keys(EVENT_CATALOG)) {
      const rendered = renderEventMessage({
        key,
        bot: 'bot-1',
        botSession: hostileBot,
        title: `\u{1F6A8} Sự kiện ${key} §c<script> \u26A0\uFE0F`,
        cause: `Lý do §4\u{1F4A5} <hack> & "kick" \u202E`,
        description: `Chi tiết **đậm** <@123456789> \u{1F525} \u2714`,
        fields: [
          ['Người chơi \u{1F464}', 'Alex_VN \u{1F608} <tag>'],
          ['Lồng \u2699', '3/5'],
        ],
        now,
      }, { tz: 'Asia/Ho_Chi_Minh', allBotIds: ['bot-1'] });
      assertCleanRenderedPayload(rendered, `renderEventMessage(${mode}:${key})`);
    }
  }
  Symbols.setSymbolSet('unicode');

  // 4. Quét mã nguồn (source scan) các module Telegram và README.md
  const filesToScan = [
    'src/core/Symbols.js',
    'src/core/TextSafe.js',
    'src/core/BotActivity.js',
    'src/core/TelegramPanel.js',
    'src/core/NotificationCenter.js',
    'src/core/TelegramControl.js',
    'src/core/TelegramNotifier.js',
    'src/core/TelegramLogger.js',
    'src/core/HelpCatalog.js',
    'README.md',
  ];
  const repoRoot = path.resolve(__dirname, '..');
  for (const rel of filesToScan) {
    const content = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const m = FORBIDDEN_EMOJI_RE.exec(content);
    if (m) {
      const cp = m[0].codePointAt(0).toString(16).toUpperCase();
      assert.fail(`Source scan failed: forbidden char U+${cp} (${m[0]}) found in ${rel}`);
    }
  }

  // 5. Property / Fuzz testing (Mục 13.7): 120 chuỗi ngẫu nhiên chứa dấu tiếng Việt, HTML, RTL, surrogate pairs
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % n;
  };
  const fuzzAtoms = [
    'Nguyễn', 'Đặng', 'ước', 'lồng', 'ổn định', '<', '>', '&', '"', "'",
    '<b>', '</b>', '</script>', '§a', '§l', '\u202E', '\u2066', '\u200D', '\uFE0F',
    '\u{1F600}', '\u{1F6A8}', '\u2714', '\u26A0', '\uD800', '\uDC00', '\u{1D400}', '\n', '   ',
  ];
  for (let i = 0; i < 120; i++) {
    let s = '';
    const len = 5 + rand(40);
    for (let j = 0; j < len; j++) s += fuzzAtoms[rand(fuzzAtoms.length)];
    for (const mode of ['unicode', 'ascii']) {
      Symbols.setSymbolSet(mode);
      const p = TelegramPanel.buildPanel({
        ...panelInfo,
        botId: `bot-${i}`,
        account: s,
        activity: { kind: 'sell', text: s, since: now - 5000, progress: { done: 1, total: 3 } },
        history: [{ ts: now - 1000, level: 'warn', text: s }],
      });
      assertCleanRenderedPayload(p, `fuzzPanel(${mode}:${i})`);
      const ev = renderEventMessage({
        key: 'disconnect',
        bot: s,
        title: s,
        cause: s,
        description: s,
        fields: [[s, s]],
        now,
      });
      assertCleanRenderedPayload(ev, `fuzzEvent(${mode}:${i})`);
    }
  }
  Symbols.setSymbolSet('unicode');

  console.log('no-emoji.test.js OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
