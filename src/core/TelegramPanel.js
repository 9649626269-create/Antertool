'use strict';
const { escapeHtml } = require('./TelegramNotifier');

/**
 * TelegramPanel — dựng nội dung "bảng thông báo Auto sell spawner" cho Telegram (HTML).
 * Toàn hàm thuần (không gọi mạng, không đọc bot) → dễ test. BotManager đưa số liệu vào qua `info`.
 *
 * info = {
 *   botId, account, connState ('ONLINE'|...), disabled, sellOn, intervalMs, now,
 *   stats (RevenueTracker.stats | null), totalUptimeMs, sessionMs, sellFailAgoMs, clock ('HH:MM')
 * }
 */
const LATE_FACTOR = 2;             // quá 2 chu kỳ (+60s) không có vòng bán mới -> "chậm"
const FAIL_RECENT_MS = 30 * 60000; // bán lỗi trong 30 phút gần đây -> "không ổn định"

// 1250 -> "1.25K", 31200000 -> "31.2M", 2.5e9 -> "2.5B", 950 -> "950"
function fmtMoney(n) {
  n = Number(n) || 0;
  const neg = n < 0; const a = Math.abs(n);
  for (const [v, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (a >= v) return (neg ? '-' : '') + (a / v).toFixed(2).replace(/\.?0+$/, '') + s;
  }
  return (neg ? '-' : '') + String(Math.round(a));
}
// 3d 04h 12m | 4h 12m | 12m | <1m      (sec:true -> 3d 04h 12m 35s | 12m 05s | 35s — bảng cập nhật mỗi giây nên có giây)
function fmtDuration(ms, { sec = false } = {}) {
  const total = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  if (!sec && m < 1) return '<1m';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  const tail = sec ? ` ${p2(s)}s` : '';
  if (d) return `${d}d ${p2(h)}h ${p2(mi)}m${tail}`;
  if (h) return `${h}h ${p2(mi)}m${tail}`;
  if (m) return `${mi}m${tail}`;
  return `${s}s`;
}
function fmtAgo(ms) {
  const total = Math.floor(Math.max(0, ms) / 1000);
  if (total < 2) return 'vừa xong';
  if (total < 60) return `${total}s trước`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s trước`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m trước`;
}
// [0,3,9,...] -> "▁▂█" (biểu đồ mini; toàn số 0 -> "▁▁▁")
function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const arr = (values || []).map(v => Math.max(0, Number(v) || 0));
  const max = Math.max(0, ...arr);
  if (!arr.length) return '';
  return arr.map(v => (max <= 0 ? bars[0] : bars[Math.min(7, Math.floor((v / max) * 7.999))])).join('');
}

// -> { icon, label, level: 'ok'|'warn'|'bad'|'off'|'idle' }
function computeStatus(i) {
  const st = i.connState;
  const now = i.now ?? Date.now();
  if (i.disabled || st === 'STOPPING') return { icon: '⚫', label: 'đã tắt', level: 'off' };
  if (st === 'RECONNECTING') return { icon: '🟠', label: 'đang kết nối lại', level: 'warn' };
  if (st === 'CONNECTING' || st === 'AUTHENTICATING' || st === 'SPAWNING') return { icon: '🟡', label: 'đang vào server', level: 'warn' };
  if (st !== 'ONLINE') return { icon: '🔴', label: 'mất kết nối', level: 'bad' };
  if (!i.sellOn) return { icon: '⚪', label: 'chưa bật autosell_spawn', level: 'idle' };
  if (i.sellFailAgoMs != null && i.sellFailAgoMs < FAIL_RECENT_MS) return { icon: '🟡', label: 'bán lỗi gần đây', level: 'warn' };
  const lateMs = (i.intervalMs || 300000) * LATE_FACTOR + 60000;
  const lastAt = i.stats?.last ?? null;
  const sess = i.sessionMs || 0;
  if (lastAt != null && now - lastAt > lateMs && sess > lateMs) return { icon: '🟡', label: 'lâu chưa có vòng bán mới', level: 'warn' };
  if (lastAt == null && sess > lateMs) return { icon: '🟡', label: 'chưa thấy vòng bán nào', level: 'warn' };
  return { icon: '🟢', label: 'ổn định', level: 'ok' };
}

const LINE = '──────────────────';

// "Chữ ký" trạng thái của bảng (không gồm giờ/giây): đổi chữ ký = bảng cần sửa dù bot đang offline
function panelSig(i) {
  const st = computeStatus(i);
  return `${st.label}|${i.connState}|${i.stats ? i.stats.total : 0}|${i.stats ? i.stats.lastAt : 0}`;
}

function buildPanel(info) {
  const e = escapeHtml;
  const now = info.now ?? Date.now();
  const s = info.stats;
  const st = computeStatus(info);
  const total = s ? fmtMoney(s.total) : '0';
  const noRate = !s || s.avgPerHour == null;
  const perDay = noRate ? '—' : fmtMoney(s.perDayEst);
  const est = !noRate && s.observedMs < 3600000 ? ' <i>(ước tính)</i>' : '';
  const lines = [
    '💸 <b>Auto sell spawner</b>',
    `🤖 Tên Bot: <b>${e(info.botId)}</b>`,
    `👤 Tên Acc: <b>${e(info.account || '—')}</b>`,
    `📡 Tình Trạng : <b>${e(st.label)}</b> ${st.icon}`,
    `💰 Tổng Thu Nhập: <b>${total}</b>`,
    LINE,
    `📈 <b>${perDay}</b>/day${est}`,
    `⏱ 1h/<b>${s ? fmtMoney(s.last1h) : '0'}</b>`,
    s && s.lastAt
      ? `🆕 Thu nhập vừa qua: <b>${fmtMoney(s.lastAmount)}</b> <i>(${fmtAgo(now - s.lastAt)})</i>`
      : '🆕 Thu nhập vừa qua: <b>—</b> <i>(chờ vòng bán đầu tiên)</i>',
    LINE,
    `🕒 Tổng Thời Gian Hoạt Động: <b>${fmtDuration(info.totalUptimeMs, { sec: true })}</b>`,
  ];
  if (s) {
    lines.push(`📅 Hôm nay <b>${fmtMoney(s.today)}</b> · Hôm qua ${fmtMoney(s.yesterday)}`);
    if (s.hourly?.length) lines.push(`📊 12h: <code>${sparkline(s.hourly.map(h => h.amount))}</code>`);
  }
  lines.push(`<i>🔄 cập nhật ${e(info.clock || '')}</i>`);
  const id = String(info.botId);
  const keyboard = [[{ text: '🔄 Làm mới', callback_data: Buffer.byteLength(id) <= 56 ? `r:${id}` : 'r:*' }]];
  return { text: lines.join('\n'), keyboard, status: st };
}

// /status: mỗi bot 1 dòng + tổng cả dàn
function buildStatusList(infos, clock) {
  const e = escapeHtml;
  if (!infos.length) return '📋 Chưa có bot nào.';
  let day = 0, h1 = 0, hasRate = false;
  const rows = infos.map(i => {
    const st = computeStatus(i);
    const s = i.stats;
    if (s && s.avgPerHour != null) { day += s.perDayEst; hasRate = true; }
    if (s) h1 += s.last1h;
    const money = s ? `${s.avgPerHour == null ? '—' : fmtMoney(s.perDayEst)}/day · 1h ${fmtMoney(s.last1h)}` : 'chưa có doanh thu';
    return `${st.icon} <b>${e(i.botId)}</b> — ${e(st.label)}\n      ${money} · ⏱ ${fmtDuration(i.totalUptimeMs)}`;
  });
  const sum = `Σ cả dàn: <b>${hasRate ? fmtMoney(day) : '—'}</b>/day · 1h <b>${fmtMoney(h1)}</b>`;
  return [`📋 <b>Trạng thái ${infos.length} bot</b>`, ...rows, LINE, sum, `<i>🔄 ${e(clock || '')}</i>`].join('\n');
}

const HELP_TEXT = [
  '🤖 <b>Antertool</b> — lệnh Telegram',
  '/status — trạng thái + thu nhập cả dàn bot',
  '/panel — gửi lại bảng Auto sell spawner (mỗi bot 1 bảng)',
  '/help — xem lại danh sách này',
  '',
  'Bảng tự cập nhật tại chỗ (không spam). Nút 🔄 để làm mới ngay.',
].join('\n');

module.exports = { panelSig, buildPanel, buildStatusList, computeStatus, fmtMoney, fmtDuration, fmtAgo, sparkline, HELP_TEXT };
