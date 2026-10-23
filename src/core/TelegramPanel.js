'use strict';
/**
 * TelegramPanel — dựng nội dung "bảng thông báo Auto sell spawner", danh sách bot,
 * menu điều khiển từng bot và trợ giúp cho Telegram (HTML, hoàn toàn không dùng emoji).
 */
const crypto = require('crypto');
const { sym, bar, ruleLine } = require('./Symbols');
const { sanitizeExternal, escapeHtml, truncateCodePoints } = require('./TextSafe');
const { describeActivity, fmtShortCountdown } = require('./BotActivity');

const LATE_FACTOR = 2;             // quá 2 chu kỳ (+60s) không có vòng bán mới -> "chậm"
const FAIL_RECENT_MS = 30 * 60000; // bán lỗi trong 30 phút gần đây -> "không ổn định"

// 1250 -> "1.25K", 31200000 -> "31.2M", 2.5e9 -> "2.5B", 950 -> "950"
function fmtMoney(n) {
  n = Number(n) || 0;
  const neg = n < 0;
  const a = Math.abs(n);
  for (const [v, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
    if (a >= v) return (neg ? '-' : '') + (a / v).toFixed(2).replace(/\.?0+$/, '') + s;
  }
  return (neg ? '-' : '') + String(Math.round(a));
}

// 3d 04h 12m | 4h 12m | 12m | <1m  (sec:true -> 3d 04h 12m 35s | 12m 05s | 35s)
function fmtDuration(ms, { sec = false } = {}) {
  const total = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (!sec && m < 1) return '<1m';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  const tail = sec ? ` ${p2(s)}s` : '';
  if (d) return `${d}d ${p2(h)}h ${p2(mi)}m${tail}`;
  if (h) return `${h}h ${p2(mi)}m${tail}`;
  if (m) return `${mi}m${tail}`;
  return `${s}s`;
}

function fmtAgo(ms) {
  const total = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
  if (total < 2) return 'vừa xong';
  if (total < 60) return `${total}s trước`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s trước`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m trước`;
}

function fmtClock(ts = Date.now(), tz = 'Asia/Ho_Chi_Minh', sec = true) {
  const d = new Date(Number(ts) || Date.now());
  const opts = {
    timeZone: tz || 'Asia/Ho_Chi_Minh',
    hour: '2-digit',
    minute: '2-digit',
    ...(sec ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  };
  try {
    return new Intl.DateTimeFormat('en-GB', opts).format(d);
  } catch {
    const fallbackOpts = { hour: '2-digit', minute: '2-digit', ...(sec ? { second: '2-digit' } : {}), hourCycle: 'h23' };
    return new Intl.DateTimeFormat('en-GB', fallbackOpts).format(d);
  }
}

// [0,3,9,...] -> "▁▂█" (biểu đồ mini; toàn số 0 -> "▁▁▁")
function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const arr = (values || []).map(v => Math.max(0, Number(v) || 0));
  const max = Math.max(0, ...arr);
  if (!arr.length) return '';
  return arr.map(v => (max <= 0 ? bars[0] : bars[Math.min(7, Math.floor((v / max) * 7.999))])).join('');
}

function hashBase36(str, len = 5) {
  const hex = crypto.createHash('sha256').update(String(str ?? '')).digest('hex').slice(0, 16);
  return BigInt('0x' + hex).toString(36).padStart(len, '0').slice(0, len);
}

function buildShortIdMap(allKeys = [], len = 5) {
  const list = Array.isArray(allKeys) ? allKeys.map(x => String(x ?? '')) : [];
  const used = new Set();
  const map = new Map();
  for (const k of list) {
    if (map.has(k)) continue;
    let code = hashBase36(k, len);
    let salt = 1;
    while (used.has(code)) {
      code = hashBase36(`${k}#${salt++}`, len);
    }
    used.add(code);
    map.set(k, code);
  }
  return map;
}

function botShortId(id, allIds = []) {
  const key = String(id ?? '');
  const list = Array.isArray(allIds) && allIds.length ? allIds : [key];
  const map = buildShortIdMap(list.includes(key) ? list : [...list, key], 5);
  return map.get(key) || hashBase36(key, 5);
}

function macroShortId(name, allMacros = []) {
  const key = String(name ?? '');
  const list = Array.isArray(allMacros) && allMacros.length ? allMacros : [key];
  const map = buildShortIdMap(list.includes(key) ? list : [...list, key], 4);
  return map.get(key) || hashBase36(key, 4);
}

function resolveByShortId(shortId, list = [], getKey = (x => String(x)), len = 5) {
  const target = String(shortId ?? '').trim().toLowerCase();
  if (!target || !Array.isArray(list) || !list.length) return null;
  const fn = typeof getKey === 'function' ? getKey : (x => String(x));
  const keys = list.map(item => String(fn(item) ?? ''));
  const map = buildShortIdMap(keys, len);
  for (let i = 0; i < list.length; i++) {
    if (map.get(keys[i]) === target) return list[i];
  }
  return null;
}

// -> { icon, label, level: 'ok'|'warn'|'bad'|'off'|'idle' }
function computeStatus(i = {}) {
  const st = i.connState;
  const now = i.now ?? Date.now();
  if (i.disabled || st === 'STOPPING') {
    const isSched = !!(i.scheduledOut || i.session?._scheduledOut);
    return { icon: sym('off'), label: isSched ? 'nghỉ theo lịch' : 'đã dừng', level: 'off' };
  }
  if (st === 'RECONNECTING') {
    const k = i.reconnects ?? i.session?.state?.reconnects ?? i.session?.reconnectHandler?.attempt ?? 0;
    return { icon: sym('retry'), label: k ? `kết nối lại (lần ${k})` : 'đang kết nối lại', level: 'warn' };
  }
  if (st === 'CONNECTING' || st === 'AUTHENTICATING' || st === 'SPAWNING') {
    return { icon: sym('busy'), label: 'đang kết nối', level: 'warn' };
  }
  if (st !== 'ONLINE') {
    return { icon: sym('fail'), label: 'mất kết nối', level: 'bad' };
  }
  if (!i.sellOn) {
    return { icon: sym('off'), label: 'chưa bật autosell_spawn', level: 'idle' };
  }
  if (i.sellFailAgoMs != null && i.sellFailAgoMs < FAIL_RECENT_MS) {
    return { icon: sym('warn'), label: 'bán lỗi gần đây', level: 'warn' };
  }
  const lateMs = (i.intervalMs || 300000) * LATE_FACTOR + 60000;
  const lastAt = i.stats?.last ?? i.stats?.lastAt ?? null;
  const sess = i.sessionMs || 0;
  if (lastAt != null && now - lastAt > lateMs && sess > lateMs) {
    return { icon: sym('warn'), label: 'lâu chưa có vòng bán mới', level: 'warn' };
  }
  if (lastAt == null && sess > lateMs) {
    return { icon: sym('warn'), label: 'chưa thấy vòng bán nào', level: 'warn' };
  }
  return { icon: sym('on'), label: 'ổn định', level: 'ok' };
}

function panelSig(i = {}) {
  const st = computeStatus(i);
  const now = i.now ?? Date.now();
  const act = i.activity || (i.session ? describeActivity(i.session, now) : null);
  const actSig = act ? `${act.kind}:${act.text}:${act.stale ? 1 : 0}` : '';
  return `${st.label}|${i.connState}|${i.stats ? i.stats.total : 0}|${i.stats ? i.stats.lastAt : 0}|${actSig}`;
}

function buildPanelKeyboard(info = {}) {
  const bid = info.shortId || botShortId(info.botId, info.allBotIds || [info.botId]);
  const st = info.connState;
  const now = info.now ?? Date.now();
  const act = info.activity || (info.session ? describeActivity(info.session, now) : null);
  const protectOp = info.protect?.on ? 'p0' : 'p1';

  if (info.disabled || st === 'STOPPING' || st === 'DISCONNECTED' || !st) {
    return [[
      { text: `${sym('retry')} Làm mới`, callback_data: `p:${bid}:r` },
      { text: `${sym('now')} Khởi động`, callback_data: `p:${bid}:b1` },
    ]];
  }
  if (st === 'RECONNECTING' || st === 'CONNECTING' || st === 'AUTHENTICATING' || st === 'SPAWNING') {
    return [[
      { text: `${sym('retry')} Làm mới`, callback_data: `p:${bid}:r` },
      { text: `${sym('stop')} Dừng bot`, callback_data: `p:${bid}:b0` },
    ]];
  }
  if (!info.sellOn) {
    return [[
      { text: `${sym('retry')} Làm mới`, callback_data: `p:${bid}:r` },
      { text: `${sym('on')} Bật bán`, callback_data: `p:${bid}:s1` },
      { text: `${sym('guard')} Protect`, callback_data: `p:${bid}:${protectOp}` },
      { text: `${sym('log')} Menu bot`, callback_data: `p:${bid}:m` },
    ]];
  }
  const isSelling = !!(info.sellBusy || act?.kind === 'sell');
  if (isSelling) {
    return [[
      { text: `${sym('retry')} Làm mới`, callback_data: `p:${bid}:r` },
      { text: `${sym('stop')} Tắt bán`, callback_data: `p:${bid}:s0` },
      { text: `${sym('guard')} Protect`, callback_data: `p:${bid}:${protectOp}` },
      { text: `${sym('log')} Menu bot`, callback_data: `p:${bid}:m` },
    ]];
  }
  return [[
    { text: `${sym('retry')} Làm mới`, callback_data: `p:${bid}:r` },
    { text: `${sym('now')} Bán ngay`, callback_data: `p:${bid}:sn` },
    { text: `${sym('stop')} Tắt bán`, callback_data: `p:${bid}:s0` },
    { text: `${sym('guard')} Protect`, callback_data: `p:${bid}:${protectOp}` },
    { text: `${sym('log')} Menu bot`, callback_data: `p:${bid}:m` },
  ]];
}

function levelHistoryGlyph(level) {
  if (level === 'ok') return sym('ok');
  if (level === 'warn') return sym('warn');
  if (level === 'err' || level === 'crit') return sym('fail');
  return sym('info');
}

function buildPanel(info = {}) {
  const e = escapeHtml;
  const now = info.now ?? Date.now();
  const tz = info.tz || 'Asia/Ho_Chi_Minh';
  const sep = sym('sep');
  const s = info.stats;
  const st = computeStatus(info);

  const safeBotId = sanitizeExternal(info.botId ?? 'bot', { max: 40 }) || 'bot';
  const safeAccount = sanitizeExternal(info.account || '—', { max: 40 }) || '—';

  const act = info.activity || (info.session ? describeActivity(info.session, now) : {
    kind: 'idle',
    text: info.sellOn ? 'Đứng canh lồng, chờ vòng bán kế tiếp' : 'Đứng yên tại vị trí',
    since: now,
    stale: false,
  });
  let actLine = e(sanitizeExternal(act?.text || '—', { max: 120 }) || '—');
  if (act?.progress && act.progress.total > 0) {
    actLine += ` ${bar(act.progress.done, act.progress.total, 5)}`;
  }
  if (act?.since && now > act.since && !['idle', 'disabled', 'disconnected', 'stopping', 'unknown'].includes(act.kind)) {
    actLine += ` ${sep} ${fmtDuration(now - act.since, { sec: true })}`;
  }
  if (act?.stale) {
    actLine += ' (quá lâu, có thể bị treo)';
  }

  const headLines = [
    `${sym('title')} <b>Auto sell spawner</b>`,
    `Bot: <b>${e(safeBotId)}</b> ${sep} Acc: <b>${e(safeAccount)}</b>`,
    `${st.icon} Tình trạng: <b>${e(st.label)}</b>`,
    `${sym('now')} Đang làm: ${actLine}`,
  ];

  const nextSellAt = info.nextSellAt ?? info.session?._nextSellAt ?? 0;
  if (nextSellAt > now && info.connState === 'ONLINE' && info.sellOn) {
    headLines.push(`${sym('next')} Kế tiếp: vòng bán sau ${fmtShortCountdown(nextSellAt - now)}`);
  }

  if (info.protect) {
    if (info.protect.on) {
      const pName = sanitizeExternal(info.protect.name || '', { max: 30 });
      const threats = Number(info.protect.threats) || 0;
      const scanStr = info.protect.lastScanAt ? ` ${sep} quét ${fmtAgo(now - info.protect.lastScanAt)}` : '';
      headLines.push(`${sym('guard')} Protect: mức ${Number(info.protect.level) || 2}${pName ? ' ' + e(pName) : ''} ${sep} ${threats} mối đe dọa${scanStr}`);
    } else {
      headLines.push(`${sym('guard')} Protect: tắt`);
    }
  }

  const metaParts = [];
  if (info.pos && Number.isFinite(Number(info.pos.x))) {
    metaParts.push(`x:${Math.round(info.pos.x)} y:${Math.round(info.pos.y)} z:${Math.round(info.pos.z)}`);
  }
  if (typeof info.ping === 'number' && info.ping >= 0) {
    metaParts.push(`ping ${info.ping}ms`);
  }
  if (info.proxyStatus) {
    metaParts.push(`proxy: ${e(sanitizeExternal(info.proxyStatus, { max: 24 }))}`);
  } else if (info.proxy !== undefined) {
    metaParts.push(`proxy: ${info.proxy ? 'có' : 'không'}`);
  }
  if (metaParts.length) {
    headLines.push(`${sym('pos')} ${metaParts.join(` ${sep} `)}`);
  }

  const total = s ? fmtMoney(s.total) : '0';
  const noRate = !s || s.avgPerHour == null;
  const perDay = noRate ? '—' : fmtMoney(s.perDayEst);
  const est = !noRate && s.observedMs < 3600000 ? ' <i>(ước tính)</i>' : '';
  const deltaStr = s && s.lastAt
    ? `+<b>${fmtMoney(s.lastAmount)}</b> <i>(${fmtAgo(now - s.lastAt)})</i>`
    : '<b>—</b> <i>(chờ vòng bán đầu tiên)</i>';

  headLines.push(
    ruleLine(18),
    `${sym('money')} Tổng <b>${total}</b> ${sep} ${sym('up')} <b>${perDay}</b>/ngày${est} ${sep} 1h <b>${s ? fmtMoney(s.last1h) : '0'}</b> ${sep} ${sym('delta')} ${deltaStr}`,
    `Uptime <b>${fmtDuration(info.totalUptimeMs, { sec: true })}</b>`
  );

  const recentLimit = Math.max(1, Math.min(30, Number(info.recentLimit) || 8));
  let rawHist = [];
  if (Array.isArray(info.history)) {
    rawHist = info.history.slice(0, recentLimit);
  } else if (info.session?.history?.toArray) {
    rawHist = [...info.session.history.toArray()].reverse().slice(0, recentLimit);
  }

  const formattedHist = rawHist
    .map(h => {
      const cleanTxt = sanitizeExternal(h.text, { max: 120 });
      if (!cleanTxt) return null;
      return ` ${fmtClock(h.ts || now, tz, true)} ${levelHistoryGlyph(h.level)} ${e(cleanTxt)}`;
    })
    .filter(Boolean);

  const clockStr = info.clock ? sanitizeExternal(info.clock, { max: 20 }) : fmtClock(now, tz, true);
  const footerLine = `Cập nhật ${e(clockStr)}`;

  const assemble = (histSlice) => {
    const out = [...headLines];
    if (histSlice.length) {
      out.push(`${sym('log')} Gần đây`);
      out.push(`<blockquote expandable>${histSlice.join('\n')}</blockquote>`);
    }
    out.push(footerLine);
    return out.join('\n');
  };

  let keptHist = formattedHist.slice();
  let text = assemble(keptHist);
  while (Array.from(text).length > 4096 && keptHist.length > 0) {
    keptHist.pop();
    text = assemble(keptHist);
  }
  if (Array.from(text).length > 4096) {
    text = truncateCodePoints(text, 4096);
  }

  const keyboard = buildPanelKeyboard(info);
  return { text, keyboard, status: st };
}

function buildStatusList(infos = [], clock = '', tz = 'Asia/Ho_Chi_Minh') {
  const e = escapeHtml;
  const sep = sym('sep');
  if (!infos.length) return `${sym('log')} Chưa có bot nào.`;
  let day = 0;
  let h1 = 0;
  let hasRate = false;
  const rows = infos.map(i => {
    const st = computeStatus(i);
    const s = i.stats;
    if (s && s.avgPerHour != null) { day += s.perDayEst; hasRate = true; }
    if (s) h1 += s.last1h;
    const safeId = sanitizeExternal(i.botId, { max: 40 });
    const money = s ? `${s.avgPerHour == null ? '—' : fmtMoney(s.perDayEst)}/ngày ${sep} 1h ${fmtMoney(s.last1h)}` : 'chưa có doanh thu';
    return `${st.icon} <b>${e(safeId)}</b> — ${e(st.label)}\n   ${money} ${sep} Uptime ${fmtDuration(i.totalUptimeMs)}`;
  });
  const sum = `Tổng cả dàn: <b>${hasRate ? fmtMoney(day) : '—'}</b>/ngày ${sep} 1h <b>${fmtMoney(h1)}</b>`;
  const clockClean = clock ? sanitizeExternal(clock, { max: 20 }) : fmtClock(Date.now(), tz, true);
  return [
    `${sym('title')} <b>Trạng thái ${infos.length} bot</b>`,
    ...rows,
    ruleLine(18),
    sum,
    `<i>${sym('retry')} Cập nhật ${e(clockClean)}</i>`,
  ].join('\n');
}

function buildBotsPage(infos = [], page = 1, pageSize = 8) {
  const e = escapeHtml;
  const sep = sym('sep');
  if (!infos.length) {
    return { text: `${sym('log')} Chưa có bot nào.`, keyboard: [] };
  }
  const allIds = infos.map(x => String(x.botId || ''));
  const totalPages = Math.max(1, Math.ceil(infos.length / pageSize));
  const curPage = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));
  const startIdx = (curPage - 1) * pageSize;
  const slice = infos.slice(startIdx, startIdx + pageSize);

  const lines = [
    `${sym('title')} <b>Danh sách bot (${infos.length} bot${totalPages > 1 ? ` ${sep} trang ${curPage}/${totalPages}` : ''})</b>`,
  ];
  const keyboard = [];
  let row = [];

  slice.forEach((info, idx) => {
    const num = startIdx + idx + 1;
    const st = computeStatus(info);
    const safeId = sanitizeExternal(info.botId, { max: 32 });
    const bid = info.shortId || botShortId(info.botId, allIds);
    const act = info.activity || (info.session ? describeActivity(info.session, info.now ?? Date.now()) : null);
    const actText = act ? sanitizeExternal(act.text, { max: 60 }) : st.label;
    lines.push(`${num}. ${st.icon} <b>${e(safeId)}</b> — ${e(actText)}`);
    row.push({
      text: `${st.icon} ${truncateCodePoints(safeId, 14)}`,
      callback_data: `p:${bid}:m`,
    });
    if (row.length >= 2) {
      keyboard.push(row);
      row = [];
    }
  });
  if (row.length) keyboard.push(row);

  if (totalPages > 1) {
    const nav = [];
    if (curPage > 1) nav.push({ text: `${sym('back')} Trang ${curPage - 1}`, callback_data: `p:all:bp:${curPage - 1}` });
    if (curPage < totalPages) nav.push({ text: `Trang ${curPage + 1} ${sym('arrow')}`, callback_data: `p:all:bp:${curPage + 1}` });
    if (nav.length) keyboard.push(nav);
  }

  return { text: lines.join('\n'), keyboard };
}

function buildBotMenu(info = {}) {
  const e = escapeHtml;
  const sep = sym('sep');
  const now = info.now ?? Date.now();
  const st = computeStatus(info);
  const safeId = sanitizeExternal(info.botId ?? 'bot', { max: 40 }) || 'bot';
  const safeAcc = sanitizeExternal(info.account || '—', { max: 40 }) || '—';
  const bid = info.shortId || botShortId(info.botId, info.allBotIds || [info.botId]);
  const act = info.activity || (info.session ? describeActivity(info.session, now) : null);

  const lines = [
    `${sym('title')} <b>Menu điều khiển: ${e(safeId)}</b> (${e(safeAcc)})`,
    `${st.icon} Tình trạng: <b>${e(st.label)}</b>`,
    `${sym('now')} Hoạt động: <b>${e(sanitizeExternal(act?.text || st.label, { max: 80 }))}</b>`,
    `Bán lồng: <b>${info.sellOn ? 'BẬT' : 'TẮT'}</b> ${sep} Protect: <b>${info.protect?.on ? `BẬT (mức ${info.protect.level || 2})` : 'TẮT'}</b>`,
  ];

  const keyboard = [
    [
      { text: `${sym('retry')} Bảng chính`, callback_data: `p:${bid}:r` },
      info.sellOn
        ? { text: `${sym('stop')} Tắt bán`, callback_data: `p:${bid}:s0` }
        : { text: `${sym('on')} Bật bán`, callback_data: `p:${bid}:s1` },
      { text: `${sym('now')} Bán ngay`, callback_data: `p:${bid}:sn` },
    ],
    [
      info.protect?.on
        ? { text: `${sym('guard')} Tắt Protect`, callback_data: `p:${bid}:p0` }
        : { text: `${sym('guard')} Bật Protect`, callback_data: `p:${bid}:p1` },
      { text: 'Mức 1', callback_data: `p:${bid}:pl1` },
      { text: 'Mức 2', callback_data: `p:${bid}:pl2` },
      { text: 'Mức 3', callback_data: `p:${bid}:pl3` },
      { text: 'Mức 4', callback_data: `p:${bid}:pl4` },
    ],
    [
      { text: `${sym('pos')} Về /home`, callback_data: `p:${bid}:h` },
      { text: `${sym('on')} AFK nhảy`, callback_data: `p:${bid}:a1` },
      { text: `${sym('off')} Dừng AFK`, callback_data: `p:${bid}:a0` },
    ],
    [
      { text: `${sym('info')} Túi đồ`, callback_data: `p:${bid}:iv` },
      { text: `${sym('pos')} Toạ độ`, callback_data: `p:${bid}:ps` },
      { text: `${sym('title')} Bảng điểm`, callback_data: `p:${bid}:bd` },
      { text: `${sym('log')} Lịch sử`, callback_data: `p:${bid}:ac` },
    ],
    [
      { text: `${sym('retry')} Kết nối lại`, callback_data: `p:${bid}:rc` },
      (info.disabled || info.connState === 'DISCONNECTED')
        ? { text: `${sym('now')} Khởi động`, callback_data: `p:${bid}:b1` }
        : { text: `${sym('stop')} Dừng bot`, callback_data: `p:${bid}:b0` },
    ],
  ];

  const macros = Array.isArray(info.macros) ? info.macros : [];
  if (macros.length) {
    const mRow = [];
    for (const m of macros.slice(0, 3)) {
      const mid = macroShortId(m, macros);
      mRow.push({
        text: `${sym('now')} ${truncateCodePoints(sanitizeExternal(m, { max: 12 }), 12)}`,
        callback_data: `p:${bid}:mc:${mid}`,
      });
    }
    mRow.push({ text: `${sym('stop')} Dừng macro`, callback_data: `p:${bid}:ms` });
    keyboard.push(mRow);
  }

  return { text: lines.join('\n'), keyboard };
}

function buildTelegramHelpText() {
  const sTitle = sym('title');
  const sBullet = sym('bullet');
  return [
    `${sTitle} <b>Antertool — Hướng dẫn Telegram Bot</b>`,
    '<i>Bot đã được cấu hình chuyên biệt: Không gửi thông báo rác, chỉ dùng để ra lệnh cho AI hoặc chạy lệnh điều khiển.</i>',
    '',
    '<b>Ra lệnh cho AI (nhắn tin trực tiếp hoặc dùng /ai):</b>',
    `${sBullet} Nhắn trực tiếp: <code>khởi động 2 bot số 1 và 2</code>, <code>xem túi đồ bot 1</code>, <code>tọa độ bot 2</code>, <code>bot 1 đang làm gì</code>, <code>bật bán lồng bot 1</code>...`,
    `${sBullet} Hoặc cú pháp: <code>/ai &lt;yêu cầu tiếng Việt&gt;</code>`,
    '',
    '<b>Xem trạng thái (Viewer &amp; Admin):</b>',
    `${sBullet} <code>/status</code> — tổng quan toàn dàn bot và doanh thu`,
    `${sBullet} <code>/bots [trang]</code> — danh sách bot kèm nút mở menu`,
    `${sBullet} <code>/bot &lt;bot&gt;</code> — mở menu điều khiển của 1 bot`,
    `${sBullet} <code>/panel [bot]</code> — gửi bảng Auto sell spawner (theo yêu cầu)`,
    `${sBullet} <code>/activity [bot] [n]</code> — hoạt động hiện tại và n mục lịch sử`,
    `${sBullet} <code>/inv &lt;bot&gt;</code> · <code>/pos &lt;bot&gt;</code> · <code>/board &lt;bot&gt;</code> · <code>/ping &lt;bot&gt;</code>`,
    `${sBullet} <code>/checkstats &lt;player&gt;</code> · <code>/bal &lt;player&gt;</code> — xem stats và số dư người chơi`,
    `${sBullet} <code>/logs [now|status|bot n]</code> — cập nhật hoặc xuất file log runtime`,
    `${sBullet} <code>/whoami</code> — xem User ID, Chat ID và quyền hiện tại`,
    '',
    '<b>Lệnh điều khiển trực tiếp (Admin):</b>',
    `${sBullet} <code>/startbot &lt;bot|all&gt;</code> · <code>/stopbot &lt;bot|all&gt;</code> · <code>/reconnect &lt;bot&gt;</code>`,
    `${sBullet} <code>/sell &lt;bot&gt; on|off|now|status|every &lt;5m&gt;</code> · <code>/sellall on|off|now</code>`,
    `${sBullet} <code>/protect &lt;bot&gt; on|off|status|level &lt;1-4&gt;</code>`,
    `${sBullet} <code>/home &lt;bot&gt;</code> · <code>/afk &lt;bot&gt; [jump|walk]</code> · <code>/stopafk &lt;bot&gt;</code>`,
    `${sBullet} <code>/macro &lt;bot&gt; [tên]</code> · <code>/stopmacro &lt;bot&gt;</code>`,
    `${sBullet} <code>/cmd &lt;bot&gt; &lt;lệnh&gt;</code> · <code>/cmdall &lt;lệnh&gt;</code> (có xác nhận 30s)`,
    `${sBullet} <code>/diag</code> — chẩn đoán kết nối và hàng đợi`,
  ].join('\n');
}

module.exports = {
  panelSig,
  buildPanel,
  buildPanelKeyboard,
  buildStatusList,
  buildBotsPage,
  buildBotMenu,
  buildTelegramHelpText,
  computeStatus,
  fmtMoney,
  fmtDuration,
  fmtAgo,
  fmtClock,
  sparkline,
  botShortId,
  macroShortId,
  resolveByShortId,
  get HELP_TEXT() { return buildTelegramHelpText(); },
};
