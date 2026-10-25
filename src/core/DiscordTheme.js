'use strict';
/**
 * DiscordTheme.js — Hệ thống giao diện tập trung cho thông báo Discord Webhook của Antertool (Hybrid v3 — Tách kênh & Bố cục gọn sạch).
 *
 *  - Tách biệt rõ 2 luồng hiển thị để không bao giờ bị lộn xộn:
 *      1. Kênh Cảnh Báo & Sự Kiện (Alerts Webhook): chỉ hiển thị thông tin sự cố/trạng thái gọn gàng, không lặp thông tin.
 *      2. Kênh Bảng Trực Tiếp 10s & Doanh Thu (Revenue / Live Panel Webhook): hiển thị bảng Monospace căn cột thẳng hàng,
 *         tách biệt hoàn toàn khỏi luồng cảnh báo sự cố.
 *  - Bảng màu theo mức độ (severity):
 *      • success  = 0x6ef16f (xanh lá — giữ chuẩn "Kiểm Tra Kết Nối Webhook")
 *      • info     = 0x38bdf8 (xanh dương)
 *      • warning  = 0xf59e0b (vàng hổ phách)
 *      • critical = 0xef4444 (đỏ báo động)
 *      • report   = 0xcf8338 (cam — giữ chuẩn "Báo Cáo Tổng Kết ...")
 */
const RevenueTracker = require('./RevenueTracker');

const BRAND = 'Antertool';

const SEVERITY_COLORS = Object.freeze({
  success: 0x6ef16f,
  info: 0x38bdf8,
  warning: 0xf59e0b,
  critical: 0xef4444,
  report: 0xcf8338,
});

// Giữ tương thích ngược với Notifier.COLOR cũ (.ok, .report) đồng thời mở rộng đủ mức độ
const COLOR = Object.freeze({
  ok: SEVERITY_COLORS.success,
  report: SEVERITY_COLORS.report,
  success: SEVERITY_COLORS.success,
  info: SEVERITY_COLORS.info,
  warning: SEVERITY_COLORS.warning,
  critical: SEVERITY_COLORS.critical,
});

/**
 * Bảng chủ đề cho mọi khoá sự kiện (bao gồm toàn bộ Notifier.EVENT_LABELS,
 * NotificationCenter.EVENT_CATALOG, Live Panel, Digest và các biến thể báo cáo/lịch/kiểm tra).
 */
const EVENT_THEMES = Object.freeze({
  disconnect: {
    emoji: '🔌',
    severity: 'critical',
    color: SEVERITY_COLORS.critical,
    label: 'Ngắt Kết Nối / Bị Kick',
    headline: '❌ BOT BỊ KICK',
  },
  reconnectFailed: {
    emoji: '🛑',
    severity: 'critical',
    color: SEVERITY_COLORS.critical,
    label: 'Hết Lượt Reconnect',
    headline: '🔴 BOT HẾT LƯỢT RECONNECT',
  },
  reconnectRecovered: {
    emoji: '🟢',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Đã Kết Nối Lại Ổn Định',
  },
  moneyGoal: {
    emoji: '🎯',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Đạt Mục Tiêu Tiền',
  },
  spawnerThreat: {
    emoji: '🚨',
    severity: 'critical',
    color: SEVERITY_COLORS.critical,
    label: 'Cảnh Báo Bảo Vệ Lồng Spawn',
    headline: '🚨 CẢNH BÁO LỒNG SPAWN',
  },
  protectResult: {
    emoji: '🛡️',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Kết Quả Bảo Vệ Lồng',
  },
  autoSell: {
    emoji: '🎒',
    severity: 'info',
    color: SEVERITY_COLORS.info,
    label: 'Túi Đồ Đầy (Auto-Sell)',
  },
  schedule: {
    emoji: '🗓️',
    severity: 'info',
    color: SEVERITY_COLORS.info,
    label: 'Lịch Tự Out/Vào',
  },
  scheduleOut: {
    emoji: '🌙',
    severity: 'warning',
    color: SEVERITY_COLORS.warning,
    label: 'Bắt Đầu Giờ Nghỉ',
  },
  scheduleIn: {
    emoji: '☀️',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Hết Giờ Nghỉ',
  },
  revenue: {
    emoji: '💰',
    severity: 'report',
    color: SEVERITY_COLORS.report,
    label: 'Báo Cáo Tổng Kết Auto-Sell Spawn',
  },
  revenueMacro: {
    emoji: '📈',
    severity: 'report',
    color: SEVERITY_COLORS.report,
    label: 'Báo Cáo Tổng Kết Auto-Sell (Macro)',
  },
  revenueSummary: {
    emoji: '📊',
    severity: 'report',
    color: SEVERITY_COLORS.report,
    label: 'Báo Cáo Tổng Kết Doanh Thu',
  },
  livePanel: {
    emoji: '📡',
    severity: 'info',
    color: SEVERITY_COLORS.info,
    label: 'Bảng Trạng Thái & Doanh Thu Trực Tiếp',
  },
  digest: {
    emoji: '📦',
    severity: 'warning',
    color: SEVERITY_COLORS.warning,
    label: 'Gộp Thông Báo (Chống Tràn Kênh)',
  },
  featuresReady: {
    emoji: '✅',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Đã Bật Tính Năng',
  },
  homeReturn: {
    emoji: '🏠',
    severity: 'warning',
    color: SEVERITY_COLORS.warning,
    label: 'Vị Trí Treo Lồng',
  },
  autoOrder: {
    emoji: '📦',
    severity: 'report',
    color: SEVERITY_COLORS.report,
    label: 'Báo Cáo AutoOrder',
  },
  sellFailed: {
    emoji: '🚨',
    severity: 'critical',
    color: SEVERITY_COLORS.critical,
    label: 'Auto-Sell Spawn Thất Bại',
    headline: '🚨 KHÔNG BÁN ĐƯỢC LỒNG',
  },
  connected: {
    emoji: '✨',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Đã Vào Server',
  },
  sellCycle: {
    emoji: '🔄',
    severity: 'info',
    color: SEVERITY_COLORS.info,
    label: 'Xong Vòng Bán',
  },
  macro: {
    emoji: '⚙️',
    severity: 'info',
    color: SEVERITY_COLORS.info,
    label: 'Chạy Macro',
  },
  proxy: {
    emoji: '🌐',
    severity: 'warning',
    color: SEVERITY_COLORS.warning,
    label: 'Xoay Proxy',
  },
  posLost: {
    emoji: '🧭',
    severity: 'warning',
    color: SEVERITY_COLORS.warning,
    label: 'Lệch Vị Trí Treo Lồng',
  },
  system: {
    emoji: '🖥️',
    severity: 'info',
    color: SEVERITY_COLORS.info,
    label: 'Hệ Thống',
  },
  test: {
    emoji: '✅',
    severity: 'success',
    color: SEVERITY_COLORS.success,
    label: 'Kiểm Tra Kết Nối Webhook',
  },
  testMention: {
    emoji: '🔔',
    severity: 'warning',
    color: SEVERITY_COLORS.warning,
    label: 'Bot Bị Kick (Tin Thử)',
    headline: '❌ BOT BỊ KICK (test)',
  },
});

const DEFAULT_THEME = Object.freeze({
  emoji: 'ℹ️',
  severity: 'info',
  color: SEVERITY_COLORS.info,
  label: 'Thông Báo',
});

// Biểu thức che thông tin nhạy cảm không bao giờ được lọt lên Discord embed
const SECRET_REDACTIONS = [
  [/(https?:\/\/api\.telegram\.org\/bot)\d{6,12}:[\w-]{20,}/gi, '$1<redacted>'],
  [/\b\d{6,12}:[\w-]{30,}\b/g, '<telegram-token>'],
  [/(https?:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w-]+/gi, '$1***'],
  [/(\/(?:dn|dk|login|register|log|reg|l|changepassword|cp)\s+)\S+(?:\s+\S+)?/gi, '$1***'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, '$1***:***@'],
  [/("(?:botPassword|password|telegramToken|dashboardToken|webhookUrl|revenueWebhookUrl|omniRouterApiKey)"\s*:\s*")[^"]*(")/gi, '$1***$2'],
];

const MC_COLOR_RE = /§x(?:§[0-9a-fA-F]){6}|§[0-9a-fk-orxA-FK-ORX#]/g;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * Gỡ surrogate lẻ để chuỗi UTF-16 luôn hợp lệ khi gửi JSON lên Discord.
 */
function stripLoneSurrogates(str) {
  const s = String(str ?? '');
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        out += s[i] + s[i + 1];
        i++;
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      // Bỏ qua low surrogate lẻ
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * Che mọi thông tin nhạy cảm (webhook URL, token Telegram, mật khẩu đăng nhập, proxy user:pass@).
 */
function redactSecrets(text, extraSecrets = []) {
  let s = stripLoneSurrogates(String(text ?? '')).replace(ANSI_RE, '').replace(MC_COLOR_RE, '');
  for (const [re, rep] of SECRET_REDACTIONS) {
    s = s.replace(re, rep);
  }
  for (const sec of extraSecrets || []) {
    const v = String(sec ?? '');
    if (v.length >= 6) {
      const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      s = s.replace(new RegExp(`(?<![\\w])${esc}(?![\\w])`, 'g'), '***');
    }
  }
  return s;
}

/**
 * Cắt chuỗi an toàn theo Unicode code point (không bao giờ cắt đôi surrogate pair).
 */
function truncateCodePoints(str, maxLen = 1024, ellipsis = '…') {
  const clean = stripLoneSurrogates(String(str ?? ''));
  const limit = Math.max(1, Math.floor(Number(maxLen) || 1024));
  const cps = Array.from(clean);
  if (cps.length <= limit) return clean;
  const tailCps = Array.from(String(ellipsis ?? '…'));
  const keep = Math.max(0, limit - tailCps.length);
  return cps.slice(0, keep).join('') + tailCps.join('');
}

function codePointLength(str) {
  return Array.from(stripLoneSurrogates(String(str ?? ''))).length;
}

/**
 * Suy luận eventKey từ tiêu đề nếu nơi gọi truyền thẳng vào _alertEmbed mà không kèm eventKey.
 */
function inferEventKey(title = '', fallbackKey = null) {
  if (fallbackKey && EVENT_THEMES[fallbackKey]) return fallbackKey;
  const t = String(title || '').toLowerCase();
  if (t.includes('kiểm tra kết nối webhook')) return 'test';
  if (t.includes('tin thử') && t.includes('kick')) return 'testMention';
  if (t.includes('bảng trạng thái') || t.includes('trực tiếp')) return 'livePanel';
  if (t.includes('gộp thông báo') || t.includes('sự kiện đã gộp')) return 'digest';
  if (t.includes('auto-sell (macro)')) return 'revenueMacro';
  if (t.includes('auto-sell spawn') && t.includes('báo cáo')) return 'revenue';
  if (t.includes('báo cáo tổng kết doanh thu')) return 'revenueSummary';
  if (t.includes('bắt đầu giờ nghỉ')) return 'scheduleOut';
  if (t.includes('hết giờ nghỉ')) return 'scheduleIn';
  if (t.includes('bị kick') || t.includes('ngắt kết nối') || t.includes('mất kết nối')) return 'disconnect';
  if (t.includes('hết lượt reconnect') || t.includes('hết lượt kết nối')) return 'reconnectFailed';
  if (t.includes('kết nối lại ổn định')) return 'reconnectRecovered';
  if (t.includes('đủ tiền') || t.includes('mục tiêu tiền')) return 'moneyGoal';
  if (t.includes('túi đồ đầy') || t.includes('túi đầy')) return 'autoSell';
  if (t.includes('xử lý bảo vệ lồng')) return 'protectResult';
  if (t.includes('gần lồng') || t.includes('không có cúp') || t.includes('lồng spawn')) return 'spawnerThreat';
  if (t.includes('thất bại sau') || (t.includes('autosell_spawn') && t.includes('thất bại'))) return 'sellFailed';
  if (t.includes('đã bật')) return 'featuresReady';
  if (t.includes('vị trí treo lồng') || t.includes('về home')) return 'homeReturn';
  if (t.includes('autoorder')) return 'autoOrder';
  return fallbackKey || null;
}

/**
 * Lấy thông tin theme { emoji, color, severity, label } cho một sự kiện.
 */
function getTheme(eventKey, severityOverride = null) {
  const base = EVENT_THEMES[eventKey] || DEFAULT_THEME;
  if (severityOverride && SEVERITY_COLORS[severityOverride] !== undefined) {
    return {
      ...base,
      severity: severityOverride,
      color: SEVERITY_COLORS[severityOverride],
    };
  }
  return { ...base };
}

/**
 * Chuyển tiêu đề sang dạng Title Case tiếng Việt gọn gàng, giữ nguyên lệnh (/home, /ec),
 * tên định danh có dấu gạch dưới (autosell_spawn, spawnerprotect) và từ viết tắt.
 */
function toTitleCaseVi(text) {
  const s = String(text ?? '').trim();
  if (!s) return '';
  let afterSlashCmd = false;
  return s
    .split(/(\s+)/)
    .map(tok => {
      if (/^\s+$/.test(tok)) return tok;
      const leadMatch = /^([(["“']*)/.exec(tok);
      const lead = leadMatch ? leadMatch[1] : '';
      const rest = tok.slice(lead.length);
      if (!rest) return tok;
      if (rest.startsWith('/')) {
        afterSlashCmd = true;
        return tok;
      }
      if (afterSlashCmd && /^[a-z0-9_-]+$/i.test(rest)) {
        afterSlashCmd = false;
        return tok;
      }
      afterSlashCmd = false;
      if (rest.includes('_') || /^(?:spawnerprotect|spawnhome|autosell)$/i.test(rest) || /[a-z][A-Z]/.test(rest) || /^[A-Z0-9+-]{2,}$/.test(rest)) {
        return tok;
      }
      if (rest.includes('-') && !rest.startsWith('-')) {
        const parts = rest.split('-').map(p => (p ? p.charAt(0).toLocaleUpperCase('vi') + p.slice(1) : p));
        return lead + parts.join('-');
      }
      return lead + rest.charAt(0).toLocaleUpperCase('vi') + rest.slice(1);
    })
    .join('');
}

// Kiểm tra chuỗi đã bắt đầu bằng emoji hay ký hiệu đặc biệt chưa
const LEADING_EMOJI_RE = /^(?:[\p{Extended_Pictographic}\u2600-\u27BF\u{1F000}-\u{1FAFF}][\uFE0E\uFE0F\u200D]*)+/u;

/**
 * Chuẩn hoá tiêu đề embed: gỡ tiền tố emoji + "<botId>: " cũ, đổi sang Title Case và gắn emoji của theme.
 */
function formatEmbedTitle(rawTitle, eventKey = null, opts = {}) {
  const botId = opts.botId ? String(opts.botId) : '';
  let s = redactSecrets(rawTitle || '').trim();
  const leadMatch = LEADING_EMOJI_RE.exec(s);
  const extractedEmoji = leadMatch ? leadMatch[0].trim() : '';
  s = s.replace(/^[^\p{L}\p{N}/]+/u, '').trim();
  if (botId) {
    const prefix = `${botId}:`;
    if (s.toLowerCase().startsWith(prefix.toLowerCase())) {
      s = s.slice(prefix.length).trim();
    }
  }
  const inferredKey = inferEventKey(s || rawTitle, eventKey);
  const theme = getTheme(inferredKey);
  const emoji = opts.emoji || theme.emoji || extractedEmoji || DEFAULT_THEME.emoji;
  const body = toTitleCaseVi(s || theme.label || DEFAULT_THEME.label);
  return truncateCodePoints(`${emoji} ${body}`.trim(), 256);
}

/**
 * Tạo đối tượng author cho embed Discord (tên bot/người chơi + icon đầu từ mc-heads).
 */
function buildAuthor(name, username = '') {
  const cleanName = truncateCodePoints(redactSecrets(name || BRAND).trim() || BRAND, 256);
  const cleanUser = String(username || '').trim();
  const iconUrl = /^\w{1,16}$/.test(cleanUser)
    ? `https://mc-heads.net/avatar/${cleanUser}/100`
    : undefined;
  return iconUrl ? { name: cleanName, icon_url: iconUrl } : { name: cleanName };
}

/**
 * Tạo đối tượng thumbnail ảnh đầu nhân vật từ mc-heads (trả về undefined nếu tên không hợp lệ).
 */
function buildThumbnail(username = '') {
  const cleanUser = String(username || '').trim();
  return /^\w{1,16}$/.test(cleanUser)
    ? { url: `https://mc-heads.net/avatar/${cleanUser}/100` }
    : undefined;
}

/**
 * Tạo thanh tiến độ trực quan: progressBar(3, 5) -> "▰▰▰▱▱ 60%"
 */
function progressBar(current, total, width = 5, showPercent = true) {
  const w = Math.max(1, Math.min(20, Math.floor(Number(width) || 5)));
  const cur = Math.max(0, Number(current) || 0);
  const tot = Math.max(0, Number(total) || 0);
  const ratio = tot > 0 ? Math.max(0, Math.min(1, cur / tot)) : 0;
  const filled = Math.round(ratio * w);
  const barStr = '▰'.repeat(filled) + '▱'.repeat(Math.max(0, w - filled));
  if (!showPercent) return barStr;
  const pct = Math.round(ratio * 100);
  return `${barStr} ${pct}%`;
}

/**
 * Tạo mốc thời gian Discord (<t:unix:R>, <t:unix:T>, <t:unix:f>...).
 */
function discordTimestamp(msOrDate = Date.now(), style = 'R') {
  const ms = msOrDate instanceof Date ? msOrDate.getTime() : (Number(msOrDate) || Date.now());
  const unix = Math.max(0, Math.floor(ms / 1000));
  return `<t:${unix}:${style}>`;
}

/**
 * Định dạng tiền tệ thống nhất ($41.35K, $4.45M, $950).
 */
function formatMoney(amount) {
  return RevenueTracker.formatMoneyDollar(amount);
}

/**
 * Bọc văn bản thành trích dẫn Discord (blockquote).
 */
function blockquote(text) {
  const lines = redactSecrets(text || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean);
  if (!lines.length) return '';
  return lines.map(l => (l.startsWith('>') ? l : `> ${l}`)).join('\n');
}

/**
 * Bọc văn bản thành khối mã (code block).
 */
function codeBlock(text, lang = '') {
  const clean = redactSecrets(text || '').replace(/```/g, '`\u200b``').trim();
  return `\`\`\`${lang}\n${clean}\n\`\`\``;
}

/**
 * Đảm bảo mọi trường của embed nằm trong giới hạn nghiêm ngặt của Discord:
 *  - title <= 256, description <= 4096, author.name <= 256, footer.text <= 2048
 *  - field.name <= 256, field.value <= 1024, tối đa 25 fields
 *  - tổng ký tự toàn embed <= 6000 code points
 *  - cắt chuỗi theo code point, không bao giờ cắt giữa surrogate pair.
 */
function enforceEmbedLimits(rawEmbed = {}, extraSecrets = []) {
  const e = { ...rawEmbed };

  if (e.title !== undefined && e.title !== null) {
    e.title = truncateCodePoints(redactSecrets(e.title, extraSecrets), 256);
  }
  if (e.description !== undefined && e.description !== null) {
    e.description = truncateCodePoints(redactSecrets(e.description, extraSecrets), 4096);
  }
  if (e.author && typeof e.author === 'object') {
    const aName = truncateCodePoints(redactSecrets(e.author.name || BRAND, extraSecrets), 256) || BRAND;
    e.author = { ...e.author, name: aName };
  } else {
    e.author = { name: BRAND };
  }

  const footerText = (e.footer && e.footer.text)
    ? truncateCodePoints(redactSecrets(e.footer.text, extraSecrets), 2048)
    : BRAND;
  e.footer = { ...(e.footer || {}), text: footerText || BRAND };

  if (!e.timestamp || Number.isNaN(Date.parse(e.timestamp))) {
    e.timestamp = new Date().toISOString();
  }

  if (!Number.isInteger(e.color) || e.color < 0 || e.color > 0xffffff) {
    const inferred = inferEventKey(e.title);
    e.color = getTheme(inferred).color;
  }

  if (Array.isArray(e.fields)) {
    const cleanFields = [];
    for (const f of e.fields) {
      if (!f || typeof f !== 'object') continue;
      const name = truncateCodePoints(redactSecrets(f.name ?? '', extraSecrets).trim() || '—', 256);
      const value = truncateCodePoints(redactSecrets(f.value ?? '', extraSecrets).trim() || '—', 1024);
      cleanFields.push({ name, value, inline: !!f.inline });
      if (cleanFields.length >= 25) break;
    }
    e.fields = cleanFields;
  }

  const calcTotal = () => {
    let sum = 0;
    sum += codePointLength(e.title);
    sum += codePointLength(e.description);
    sum += codePointLength(e.author?.name);
    sum += codePointLength(e.footer?.text);
    for (const f of e.fields || []) {
      sum += codePointLength(f.name) + codePointLength(f.value);
    }
    return sum;
  };

  let total = calcTotal();
  if (total > 6000 && e.description) {
    const excess = total - 6000;
    const curDescLen = codePointLength(e.description);
    const targetDescLen = Math.max(64, curDescLen - excess - 10);
    e.description = truncateCodePoints(e.description, targetDescLen);
    total = calcTotal();
  }
  while (total > 6000 && Array.isArray(e.fields) && e.fields.length > 0) {
    const last = e.fields[e.fields.length - 1];
    const excess = total - 6000;
    const vLen = codePointLength(last.value);
    if (vLen - excess >= 32) {
      last.value = truncateCodePoints(last.value, vLen - excess - 5);
    } else {
      e.fields.pop();
    }
    total = calcTotal();
  }

  return e;
}

/**
 * Tạo chữ ký trạng thái của Bảng Trực Tiếp (Live Panel) để phát hiện thay đổi.
 */
function livePanelSig(snapshot = {}) {
  const bots = Array.isArray(snapshot.bots) ? snapshot.bots : [];
  return bots.map(b => [
    b.botId,
    b.connState,
    b.disabled ? 1 : 0,
    b.scheduledOut ? 1 : 0,
    b.reconnects || 0,
    b.sellOn ? 1 : 0,
    b.sellBusy ? 1 : 0,
    b.stats ? `${b.stats.total}:${b.stats.cycles}:${b.stats.lastAt || 0}` : '0',
    b.protect?.on ? `${b.protect.level}:${b.protect.threats || 0}` : 'off',
  ].join(':')).join('|');
}

/**
 * Dựng Embed Bảng Trạng Thái & Doanh Thu Trực Tiếp (Live Dashboard 10s).
 * Thiết kế tối giản, thẳng hàng tuyệt đối bằng bảng Monospace, tách biệt hoàn toàn khỏi luồng cảnh báo sự cố.
 */
function buildLivePanelEmbed(snapshot = {}) {
  const now = Number(snapshot.now) || Date.now();
  const refreshSec = Number(snapshot.refreshSec) || 10;
  const bots = Array.isArray(snapshot.bots) ? snapshot.bots : [];
  const totalBots = bots.length;
  const onlineBots = bots.filter(b => b.connState === 'ONLINE').length;
  const reconnectingBots = bots.filter(b => b.connState === 'RECONNECTING' || b.connState === 'CONNECTING' || b.connState === 'AUTHENTICATING' || b.connState === 'SPAWNING').length;
  const sellingBots = bots.filter(b => b.connState === 'ONLINE' && b.sellOn).length;

  let color = SEVERITY_COLORS.success;
  if (totalBots === 0) color = SEVERITY_COLORS.info;
  else if (onlineBots === 0 && reconnectingBots > 0) color = SEVERITY_COLORS.warning;
  else if (onlineBots === 0) color = SEVERITY_COLORS.critical;
  else if (onlineBots < totalBots) color = SEVERITY_COLORS.warning;

  let totalEarned = 0;
  let totalToday = 0;
  let totalLast1h = 0;
  let totalCycles = 0;
  let totalAvgPerHour = 0;
  let hasRate = false;
  let maxUptimeMs = 0;

  for (const b of bots) {
    if (b.totalUptimeMs > maxUptimeMs) maxUptimeMs = b.totalUptimeMs;
    const s = b.stats;
    if (s) {
      totalEarned += Number(s.total) || 0;
      totalToday += Number(s.today) || 0;
      totalLast1h += Number(s.last1h) || 0;
      totalCycles += Number(s.cycles) || 0;
      if (s.avgPerHour != null) {
        totalAvgPerHour += Number(s.avgPerHour) || 0;
        hasRate = true;
      }
    }
  }

  const hosts = [...new Set(bots.map(b => String(b.host || '').trim()).filter(Boolean))];
  const serverLabel = hosts.length === 1 ? hosts[0] : (hosts.length > 1 ? `${hosts.length} server` : '—');
  const primaryUser = bots.find(b => /^\w{1,16}$/.test(String(b.account || '')))?.account || '';

  const cut = (t, n) => {
    const s = String(t ?? '');
    return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n, ' ');
  };
  const pad = (v, n) => String(v ?? '').padStart(n, ' ');

  let tableBlock = '';
  if (bots.length === 0) {
    tableBlock = blockquote('Chưa có bot nào trong cấu hình.');
  } else {
    const MAX = 20;
    const idW = Math.min(12, Math.max(5, ...bots.slice(0, MAX).map(b => String(b.botId || '').length)));
    const header = `${cut('Bot', idW)} ${cut('Tình trạng', 10)} ${pad('1h qua', 8)} ${pad('Hôm nay', 9)} ${pad('Tốc độ', 9)}`;
    const sepLine = `${'-'.repeat(idW)} ---------- -------- --------- ---------`;
    const rows = [header, sepLine];

    for (const b of bots.slice(0, MAX)) {
      let stateStr = 'Online';
      if (b.disabled || b.connState === 'STOPPING') {
        stateStr = b.scheduledOut ? 'Nghỉ lịch' : 'Đã dừng';
      } else if (b.connState === 'RECONNECTING') {
        stateStr = `Thử lại #${b.reconnects || 1}`;
      } else if (b.connState === 'CONNECTING' || b.connState === 'AUTHENTICATING' || b.connState === 'SPAWNING') {
        stateStr = 'Đang vào';
      } else if (b.connState !== 'ONLINE') {
        stateStr = 'Offline';
      } else if (b.sellBusy) {
        stateStr = 'Đang bán';
      } else if (b.sellOn) {
        stateStr = 'Canh lồng';
      }

      const s = b.stats;
      const h1 = s ? formatMoney(s.last1h) : '$0';
      const today = s ? formatMoney(s.today) : '$0';
      const rate = s && s.avgPerHour != null ? `${formatMoney(s.avgPerHour)}/h` : '—';
      rows.push(`${cut(b.botId, idW)} ${cut(stateStr, 10)} ${pad(h1, 8)} ${pad(today, 9)} ${pad(rate, 9)}`);
    }
    if (bots.length > MAX) {
      rows.push(`… và ${bots.length - MAX} bot khác`);
    }
    tableBlock = codeBlock(rows.join('\n'));
  }

  const summaryLine = `🟢 **${onlineBots}/${totalBots}** trực tuyến • 🔄 **${sellingBots}** tự bán lồng • ⏱️ Cập nhật ${discordTimestamp(now, 'R')}`;

  const fields = [
    { name: 'Trạng thái dàn', value: `${progressBar(onlineBots, Math.max(1, totalBots))} (${onlineBots}/${totalBots})`, inline: true },
    { name: 'Server', value: serverLabel, inline: true },
    { name: 'Thời gian treo', value: RevenueTracker.formatClock(maxUptimeMs), inline: true },
    { name: 'Tổng thu nhập', value: formatMoney(totalEarned), inline: true },
    { name: 'Tốc độ trung bình', value: hasRate ? `${formatMoney(totalAvgPerHour)}/h` : '—', inline: true },
    { name: 'Số lượt bán', value: `${totalCycles} vòng`, inline: true },
  ];

  return enforceEmbedLimits({
    title: formatEmbedTitle(`Bảng Trạng Thái & Doanh Thu Trực Tiếp (${totalBots} Bot)`, 'livePanel'),
    description: `${summaryLine}\n${tableBlock}`,
    color,
    author: buildAuthor(`${BRAND} • Live Dashboard`, primaryUser),
    thumbnail: buildThumbnail(primaryUser),
    fields,
    footer: { text: `${BRAND} • Tự động cập nhật tại chỗ mỗi ${refreshSec}s` },
    timestamp: new Date(now).toISOString(),
  });
}

/**
 * Dựng Embed Gộp Sự Kiện (Storm Digest) khi có nhiều thông báo bắn dồn dập trong thời gian ngắn.
 */
function buildDigestEmbed(digest = {}, now = Date.now()) {
  const items = Array.isArray(digest.items) ? digest.items : [];
  const count = Number(digest.count) || items.length;
  const lines = items.slice(0, 12).map(it => {
    const th = getTheme(it.key);
    const botTag = it.botId ? `**${it.botId}**: ` : '';
    const mult = it.count > 1 ? ` \`×${it.count}\`` : '';
    return `• ${th.emoji} ${botTag}${truncateCodePoints(it.summary || it.title || th.label, 80)}${mult} (${discordTimestamp(it.lastTs || now, 'R')})`;
  });
  if (count > lines.length) {
    lines.push(`*… và ${count - lines.length} sự kiện khác đã được gộp*`);
  }
  return enforceEmbedLimits({
    title: formatEmbedTitle(`Gộp ${count} Sự Kiện Trong 60 Giây`, 'digest'),
    description: [
      `Hệ thống tự động gộp các thông báo liên tiếp vào cùng 1 tin nhắn để tránh tràn kênh Discord (${discordTimestamp(now, 'R')}).`,
      lines.join('\n'),
    ].filter(Boolean).join('\n\n'),
    color: SEVERITY_COLORS.warning,
    author: buildAuthor(BRAND),
    fields: [
      { name: 'Tổng sự kiện gộp', value: `${count} sự kiện`, inline: true },
      { name: 'Cửa sổ chống tràn', value: '60 giây', inline: true },
      { name: 'Cập nhật cuối', value: discordTimestamp(now, 'R'), inline: true },
    ],
    timestamp: new Date(now).toISOString(),
  });
}

/**
 * Tạo bộ mẫu thử (preview) cho toàn bộ các loại sự kiện Discord để người dùng kiểm tra giao diện.
 */
function buildPreviewPayloads(opts = {}) {
  const now = Number(opts.now) || Date.now();
  const botId = opts.botId || 'bot-1';
  const username = opts.username || 'Steve_01';
  const server = opts.server || 'donutsmp.net';
  const playerLabel = `${username} (${botId})`;
  const author = buildAuthor(playerLabel, username);
  const thumbnail = buildThumbnail(username);
  const iso = new Date(now).toISOString();
  const baseInline = [
    { name: 'Người chơi', value: playerLabel, inline: true },
    { name: 'Server', value: server, inline: true },
    { name: 'Thời gian treo', value: '03:12:45', inline: true },
  ];

  const items = [
    {
      key: 'livePanel',
      content: '',
      embed: buildLivePanelEmbed({
        now,
        refreshSec: 10,
        bots: [
          {
            botId,
            account: username,
            host: server,
            connState: 'ONLINE',
            sellOn: true,
            nextSellAt: now + 180000,
            activityText: 'Canh lồng',
            totalUptimeMs: 11565000,
            protect: { on: true, level: 2, threats: 0 },
            stats: { total: 41350, today: 41350, last1h: 12500, cycles: 8, avgPerHour: 12500, lastAt: now - 60000 },
          },
        ],
      }),
    },
    {
      key: 'test',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Kiểm Tra Kết Nối Webhook', 'test'),
        description: `${BRAND} đã kết nối thành công tới Discord! (${discordTimestamp(now, 'R')})`,
        color: EVENT_THEMES.test.color,
        author: buildAuthor(BRAND),
        fields: [
          { name: 'Trạng thái', value: 'Hoạt động bình thường', inline: true },
          { name: 'Nguồn', value: `Minecraft ${BRAND}`, inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'disconnect',
      content: EVENT_THEMES.disconnect.headline,
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Bị kick', 'disconnect'),
        description: [
          blockquote('Internal Exception: java.net.SocketException: Connection reset'),
          `⏰ 09:15:00 PM • ${discordTimestamp(now, 'R')}`,
        ].join('\n'),
        color: EVENT_THEMES.disconnect.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Lần thử', value: `${progressBar(1, 5)} (1/5)`, inline: true },
          { name: 'Kết nối lại', value: discordTimestamp(now + 15000, 'R'), inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'reconnectFailed',
      content: EVENT_THEMES.reconnectFailed.headline,
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Hết lượt reconnect', 'reconnectFailed'),
        description: blockquote('Connection refused: no further information'),
        color: EVENT_THEMES.reconnectFailed.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Số lần thử', value: `${progressBar(5, 5)} (5/5)`, inline: true },
          { name: 'Thử lại lúc', value: discordTimestamp(now + 15 * 60000, 'R'), inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'reconnectRecovered',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Đã kết nối lại ổn định', 'reconnectRecovered'),
        description: `Sau 2 lần thử (${progressBar(2, 5)}) • Đã trực tuyến ${discordTimestamp(now, 'R')}.`,
        color: EVENT_THEMES.reconnectRecovered.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Số lần thử', value: '2 lần', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'moneyGoal',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Đã đủ tiền', 'moneyGoal'),
        description: [
          `Đạt mục tiêu tiền đặt trước (${progressBar(52400000, 50000000)}).`,
          codeBlock('macro chuyen_tien'),
        ].join('\n'),
        color: EVENT_THEMES.moneyGoal.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Số dư', value: formatMoney(52400000), inline: true },
          { name: 'Mục tiêu', value: formatMoney(50000000), inline: true },
          { name: 'Macro', value: '`chuyen_tien`', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'spawnerThreat',
      content: EVENT_THEMES.spawnerThreat.headline,
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Người lạ gần lồng', 'spawnerThreat'),
        description: [
          blockquote('Người lạ: Alex_VN đang đập spawner cách lồng 4.2m'),
          `Đang bảo vệ **5 lồng** (mức 2 Cân bằng). Phát hiện ${discordTimestamp(now, 'R')}.`,
        ].join('\n'),
        color: EVENT_THEMES.spawnerThreat.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Mối đe dọa', value: 'Alex_VN (4.2m)', inline: true },
          { name: 'Số lồng bảo vệ', value: '5 lồng', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'protectResult',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Xử lý bảo vệ lồng', 'protectResult'),
        description: [
          blockquote('Người lạ: Alex_VN (4.2m)'),
          `Đã cất 5 item lồng/spawn vào ender chest — đã xác minh ✅.`,
        ].join('\n'),
        color: EVENT_THEMES.protectResult.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Tiến độ đào', value: `${progressBar(5, 5)} (5/5 lồng)`, inline: true },
          { name: 'Ender Chest', value: 'Đã xác minh ✅', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'autoSell',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Túi đồ đầy', 'autoSell'),
        description: codeBlock('macro autosell'),
        color: EVENT_THEMES.autoSell.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Túi đồ', value: `${progressBar(33, 36)} (33/36 ô)`, inline: true },
          { name: 'Macro', value: '`autosell`', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'featuresReady',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Đã bật spawnerprotect + autosell_spawn', 'featuresReady'),
        description: [
          '✅ spawnerprotect: 5 lồng, quét người lạ 16 block',
          '✅ autosell_spawn: 5 lồng, click ô 51, mỗi 5m',
          `⏱️ Hoàn tất ${discordTimestamp(now, 'R')} (4s sau khi vào menu)`,
        ].join('\n'),
        color: EVENT_THEMES.featuresReady.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Toạ độ', value: '`120.0, 64.0, -48.0`', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'homeReturn',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Lệch khỏi vị trí treo lồng — gõ /home treolong', 'homeReturn'),
        description: [
          'Bot không còn ở gần lồng (autosell_spawn 0/5 lồng trong tầm).',
          codeBlock('/home treolong'),
        ].join('\n'),
        color: EVENT_THEMES.homeReturn.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Lệnh thực thi', value: '`/home treolong`', inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'sellFailed',
      content: EVENT_THEMES.sellFailed.headline,
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('autosell_spawn thất bại sau 10 lần gõ /home treolong', 'sellFailed'),
        description: [
          codeBlock('• (120,64,-48) GUI không mở sau 5s\n• (121,64,-48) chunk chưa tải — bỏ qua'),
          '📍 Vị trí: 120.0, 64.0, -48.0 — lồng gần nhất cách 2.1 block',
        ].join('\n'),
        color: EVENT_THEMES.sellFailed.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Tiến độ lồng', value: `${progressBar(3, 5)} (3/5)`, inline: true },
          { name: 'Thử lại /home', value: `${progressBar(10, 10)} (10/10)`, inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'autoOrder',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('AutoOrder', 'autoOrder'),
        description: codeBlock('/order blaze rod'),
        color: EVENT_THEMES.autoOrder.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Vật phẩm', value: '`blaze_rod`', inline: true },
          { name: 'Đã giao', value: '64 stack', inline: true },
          { name: 'Thu nhập', value: formatMoney(12800000), inline: true },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'revenue',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Báo Cáo Tổng Kết Auto-Sell Spawn', 'revenue'),
        color: EVENT_THEMES.revenue.color,
        author,
        thumbnail,
        fields: [
          ...baseInline,
          { name: 'Tổng thu nhập', value: formatMoney(41350), inline: true },
          { name: 'Tốc độ trung bình', value: `${formatMoney(248100)}/h`, inline: true },
          { name: 'Số lượt bán', value: '12', inline: true },
          {
            name: 'Trạng thái',
            value: `Đang hoạt động • ${discordTimestamp(now, 'R')}\nVòng vừa xong: +${formatMoney(3350)} (5/5 lồng) • ${progressBar(5, 5)}`,
            inline: false,
          },
        ],
        timestamp: iso,
      }),
    },
    {
      key: 'schedule',
      content: '',
      embed: enforceEmbedLimits({
        title: formatEmbedTitle('Bắt Đầu Giờ Nghỉ', 'scheduleOut'),
        description: `Đã out 2 bot (${progressBar(2, 2)}). Sẽ tự vô lại lúc **06:00** (${discordTimestamp(now + 7 * 3600000, 'R')}).`,
        color: EVENT_THEMES.scheduleOut.color,
        author: buildAuthor(BRAND, username),
        thumbnail,
        fields: [
          { name: 'Giờ nghỉ', value: '23:00', inline: true },
          { name: 'Vô lại lúc', value: '06:00', inline: true },
          { name: 'Số bot', value: '2', inline: true },
        ],
        timestamp: iso,
      }),
    },
  ];

  if (opts.onlyKey) {
    const k = String(opts.onlyKey).trim();
    return items.filter(it => it.key.toLowerCase() === k.toLowerCase());
  }
  return items;
}

module.exports = {
  BRAND,
  SEVERITY_COLORS,
  COLOR,
  EVENT_THEMES,
  DEFAULT_THEME,
  getTheme,
  inferEventKey,
  toTitleCaseVi,
  formatEmbedTitle,
  buildAuthor,
  buildThumbnail,
  progressBar,
  discordTimestamp,
  formatMoney,
  blockquote,
  codeBlock,
  redactSecrets,
  stripLoneSurrogates,
  truncateCodePoints,
  codePointLength,
  enforceEmbedLimits,
  livePanelSig,
  buildLivePanelEmbed,
  buildDigestEmbed,
  buildPreviewPayloads,
};
