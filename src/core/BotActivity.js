'use strict';
/**
 * BotActivity.js — Mô hình hoạt động hiện tại và lịch sử gần đây của từng BotSession (Section 5).
 * Thuần, không ném ngoại lệ ra ngoài, mọi dữ liệu văn bản đều qua sanitizeExternal.
 */
const RingBuffer = require('./RingBuffer');
const { sanitizeExternal } = require('./TextSafe');
const { dbg } = require('./debug');
const { CS } = require('./constants');

const HISTORY_CAP = 30;
const HISTORY_LINE_MAX = 120;
const SNAPSHOT_TTL_MS = 60000;

/**
 * Bảng ưu tiên và ngưỡng treo (staleness) của từng loại hoạt động.
 * Ưu tiên cao hơn sẽ thắng khi có nhiều hoạt động chồng nhau.
 */
const ACTIVITY_SPECS = Object.freeze({
  protect:   { priority: 100, staleAfterMs: 5 * 60 * 1000,  label: 'Xử lý bảo vệ lồng' },
  login:     { priority: 90,  staleAfterMs: 3 * 60 * 1000,  label: 'Đăng nhập / vào menu' },
  reconnect: { priority: 85,  staleAfterMs: 20 * 60 * 1000, label: 'Kết nối lại' },
  macro:     { priority: 80,  staleAfterMs: 30 * 60 * 1000, label: 'Chạy macro' },
  sell:      { priority: 70,  staleAfterMs: 10 * 60 * 1000, label: 'Bán lồng' },
  recovery:  { priority: 65,  staleAfterMs: 5 * 60 * 1000,  label: 'Phục hồi vị trí bán' },
  poslost:   { priority: 60,  staleAfterMs: 5 * 60 * 1000,  label: 'Lệch vị trí treo lồng' },
  home:      { priority: 58,  staleAfterMs: 2 * 60 * 1000,  label: 'Về home' },
  tpa:       { priority: 55,  staleAfterMs: 1 * 60 * 1000,  label: 'TPA' },
  proxy:     { priority: 50,  staleAfterMs: 2 * 60 * 1000,  label: 'Đổi proxy' },
  order:     { priority: 40,  staleAfterMs: 30 * 60 * 1000, label: 'AutoOrder' },
  beggar:    { priority: 35,  staleAfterMs: 1 * 60 * 1000,  label: 'Chặn ăn xin' },
  eat:       { priority: 25,  staleAfterMs: 1 * 60 * 1000,  label: 'Tự ăn' },
  afk:       { priority: 20,  staleAfterMs: Infinity,       label: 'Treo AFK' },
});

const VALID_STATES = new Set(Object.values(CS));

function fmtShortCountdown(ms) {
  const sec = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h${String(rm).padStart(2, '0')}m`;
}

function initSessionActivity(session) {
  if (!session) return;
  if (!(session.activities instanceof Map)) session.activities = new Map();
  if (!(session.history instanceof RingBuffer)) session.history = new RingBuffer(HISTORY_CAP);
  if (!Array.isArray(session._sellCycleDurations)) session._sellCycleDurations = [];
  if (typeof session._sellCycleCount !== 'number') session._sellCycleCount = 0;
  if (typeof session._nextSellAt !== 'number') session._nextSellAt = 0;
  if (session._activitySnapshot === undefined) session._activitySnapshot = null;
  if (session._activityCoalesce === undefined) {
    session._activityCoalesce = { lastEmitAt: 0, timer: null, pendingPayload: null };
  }
}

function emitCoalescedActivity(session, now = Date.now()) {
  try {
    initSessionActivity(session);
    const c = session._activityCoalesce;
    const fire = (ts) => {
      c.lastEmitAt = ts;
      const desc = describeActivity(session, ts);
      try {
        session.emit?.('activity', { id: session.cfg?.id, activity: desc, ts });
      } catch (e) {
        dbg('BotActivity', e);
      }
      try {
        session._manager?.onBotActivity?.(session, desc, ts);
      } catch (e) {
        dbg('BotActivity', e);
      }
    };
    const elapsed = now - c.lastEmitAt;
    if (elapsed >= 1000 && !c.timer) {
      fire(now);
      return;
    }
    if (!c.timer) {
      const wait = Math.max(50, 1000 - Math.max(0, elapsed));
      c.timer = setTimeout(() => {
        c.timer = null;
        fire(Date.now());
      }, wait);
      if (c.timer.unref) c.timer.unref();
    }
  } catch (e) {
    dbg('BotActivity', e);
  }
}

function pushHistory(session, level, text, now = Date.now()) {
  if (['info', 'ok', 'warn', 'err'].includes(text) && !['info', 'ok', 'warn', 'err'].includes(level)) {
    const tmp = level; level = text; text = tmp;
  }
  try {
    initSessionActivity(session);
    const clean = sanitizeExternal(text, { max: HISTORY_LINE_MAX });
    if (!clean) return null;
    const validLevel = ['info', 'ok', 'warn', 'err'].includes(level) ? level : 'info';
    const entry = { ts: Number(now) || Date.now(), level: validLevel, text: clean };
    session.history.push(entry);
    return entry;
  } catch (e) {
    dbg('BotActivity', e);
    return null;
  }
}

/**
 * Đặt hoặc cập nhật 1 hoạt động theo kind. Không bao giờ throw.
 */
function setActivity(session, kind, text, opts = {}) {
  try {
    if (!session || !kind) return null;
    initSessionActivity(session);
    const k = String(kind).trim().toLowerCase();
    const now = Number(opts.now) || Date.now();
    const prev = session.activities.get(k);
    const since = (prev && !opts.restart) ? prev.since : now;
    const spec = ACTIVITY_SPECS[k] || { priority: 30, staleAfterMs: 10 * 60 * 1000 };
    const cleanText = sanitizeExternal(text || spec.label || k, { max: 120 });
    let progress;
    if (opts.progress && typeof opts.progress === 'object') {
      const done = Math.max(0, Math.floor(Number(opts.progress.done) || 0));
      const total = Math.max(0, Math.floor(Number(opts.progress.total) || 0));
      if (total > 0) progress = { done: Math.min(done, total), total };
    }
    let etaAt;
    if (opts.etaAt && Number.isFinite(Number(opts.etaAt))) {
      etaAt = Number(opts.etaAt);
    } else if (opts.etaMs && Number.isFinite(Number(opts.etaMs)) && Number(opts.etaMs) > 0) {
      etaAt = now + Math.round(Number(opts.etaMs));
    }
    const staleAfterMs = opts.staleAfterMs !== undefined ? Number(opts.staleAfterMs) : spec.staleAfterMs;
    const act = {
      kind: k,
      text: cleanText,
      since,
      ...(progress ? { progress } : {}),
      ...(etaAt ? { etaAt } : {}),
      ...(opts.detail ? { detail: sanitizeExternal(opts.detail, { max: 120 }) } : {}),
      staleAfterMs,
    };
    session.activities.set(k, act);
    emitCoalescedActivity(session, now);
    return act;
  } catch (e) {
    dbg('BotActivity', e);
    return null;
  }
}

/**
 * Kết thúc 1 hoạt động theo kind, chỉ xoá đúng kind đó và ghi 1 dòng history nếu có resultText.
 */
function endActivity(session, kind, resultText = null, opts = {}) {
  try {
    if (!session || !kind) return false;
    initSessionActivity(session);
    const k = String(kind).trim().toLowerCase();
    const now = Number(opts.now) || Date.now();
    const had = session.activities.delete(k);
    if (resultText) {
      pushHistory(session, opts.level || 'info', resultText, now);
    }
    if (had || resultText) emitCoalescedActivity(session, now);
    return had;
  } catch (e) {
    dbg('BotActivity', e);
    return false;
  }
}

/**
 * Xoá mọi hoạt động đang chạy (khi chuyển sang RECONNECTING / DISCONNECTED / STOPPING hoặc shutdown).
 * Chụp lại activitySnapshot và giữ trong 60s để sự kiện disconnect biết lúc đó bot đang làm gì.
 */
function clearActivities(session, reason = '', opts = {}) {
  try {
    if (!session) return null;
    initSessionActivity(session);
    const now = typeof opts === 'number' ? opts : (Number(opts?.now) || Date.now());
    const hadActive = session.activities.size > 0;
    const existingSnap = getActivitySnapshot(session, now);

    // Chụp snapshot trước khi xoá; nếu vừa chụp cách đây <60s và hiện tại đã trống thì giữ snapshot cũ
    if (hadActive || !existingSnap) {
      const top = pickTopExplicitActivity(session, now) || deriveFromFlags(session, now, { ignoreConnOffline: true });
      if (top && top.kind !== 'disconnected' && top.kind !== 'stopping' && top.kind !== 'disabled') {
        session._activitySnapshot = {
          ...top,
          activities: [...session.activities.values()].map(a => ({ ...a })),
          at: now,
        };
      }
    }

    if (hadActive) {
      const top = pickTopExplicitActivity(session, now);
      session.activities.clear();
      const why = sanitizeExternal(reason || 'ngắt kết nối', { max: 40 });
      const what = top ? top.text : 'đang hoạt động';
      pushHistory(session, 'warn', `Dừng việc đang làm (${why}): ${what}`, now);
      emitCoalescedActivity(session, now);
    }
    if (session._activityCoalesce?.timer && (reason === 'shutdown' || session._disabled)) {
      clearTimeout(session._activityCoalesce.timer);
      session._activityCoalesce.timer = null;
    }
    return getActivitySnapshot(session, now);
  } catch (e) {
    dbg('BotActivity', e);
    return null;
  }
}

function getActivitySnapshot(session, now = Date.now()) {
  if (!session || !session._activitySnapshot) return null;
  if (now - session._activitySnapshot.at > SNAPSHOT_TTL_MS) {
    session._activitySnapshot = null;
    return null;
  }
  return session._activitySnapshot;
}

function recordCycleDuration(session, durationMs) {
  try {
    initSessionActivity(session);
    const d = Number(durationMs);
    if (!Number.isFinite(d) || d <= 0) return;
    session._sellCycleDurations.push(d);
    if (session._sellCycleDurations.length > 5) {
      session._sellCycleDurations.splice(0, session._sellCycleDurations.length - 5);
    }
  } catch (e) {
    dbg('BotActivity', e);
  }
}

function estimateCycleDurationMs(session) {
  initSessionActivity(session);
  const arr = session._sellCycleDurations;
  if (!arr || !arr.length) return null;
  const sum = arr.reduce((a, b) => a + b, 0);
  return Math.round(sum / arr.length);
}

function isStale(act, now) {
  if (!act || !act.since) return false;
  const spec = ACTIVITY_SPECS[act.kind];
  const limit = act.staleAfterMs !== undefined ? act.staleAfterMs : (spec ? spec.staleAfterMs : 10 * 60 * 1000);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  return (now - act.since) > limit;
}

function pickTopExplicitActivity(session, now = Date.now()) {
  if (!session?.activities || session.activities.size === 0) return null;
  let best = null;
  let bestPrio = -Infinity;
  for (const act of session.activities.values()) {
    const spec = ACTIVITY_SPECS[act.kind];
    const prio = spec ? spec.priority : 30;
    if (!best || prio > bestPrio || (prio === bestPrio && act.since > best.since)) {
      best = act;
      bestPrio = prio;
    }
  }
  if (!best) return null;
  return {
    kind: best.kind,
    text: best.text,
    since: best.since,
    ...(best.progress ? { progress: { ...best.progress } } : {}),
    ...(best.etaAt ? { etaAt: best.etaAt } : {}),
    ...(best.detail ? { detail: best.detail } : {}),
    stale: isStale(best, now),
  };
}

/**
 * Kiểm tra các cờ mâu thuẫn nhau (Section 5: "If flags contradict each other, return 'Không xác định' and dbg the flags; never default to 'rảnh'").
 */
function checkContradictions(session) {
  if (!session) return 'no_session';
  const st = session.state?.connState;
  if (!st || !VALID_STATES.has(st)) return `invalid_connState:${st}`;
  if (session._disabled && st === CS.ONLINE) return 'disabled_but_online';
  if (st !== CS.ONLINE && (session._spawnerBusy || session._sellSpawnBusy || session._sellRecovering)) {
    return `offline_but_busy:${st}`;
  }
  if (session._spawnerBusy && session._sellSpawnBusy) {
    return 'spawnerBusy_and_sellSpawnBusy';
  }
  if (session.state?.afk && session.state.afk !== 'jump' && session.state.afk !== 'walk') {
    return `invalid_afk:${session.state.afk}`;
  }
  return null;
}

function deriveFromFlags(session, now = Date.now(), opts = {}) {
  const st = session.state?.connState || CS.DISCONNECTED;
  const stateSince = session._stateChangedAt || session._spawnTime || session.state?.loginTime || now;

  if (!opts.ignoreConnOffline) {
    // 1. disabled (_disabled)
    if (session._disabled) {
      const text = session._scheduledOut ? 'Đang nghỉ theo lịch' : 'Đã dừng';
      return { kind: 'disabled', text, since: stateSince, stale: false };
    }
    // 2. STOPPING / DISCONNECTED
    if (st === CS.STOPPING) {
      return { kind: 'stopping', text: 'Đang dừng bot', since: stateSince, stale: false };
    }
    if (st === CS.DISCONNECTED) {
      return { kind: 'disconnected', text: 'Mất kết nối', since: stateSince, stale: false };
    }
    // 3. RECONNECTING (attempt k, wait)
    if (st === CS.RECONNECTING) {
      const k = session.state?.reconnects || session.reconnectHandler?.attempt || 1;
      const maxRaw = session.reconnectHandler?.maxRetries ?? session._reconnectMaxRetries ?? 10;
      const maxStr = maxRaw >= 999 ? 'vô hạn' : String(maxRaw);
      const nextAt = session.reconnectHandler?.nextAttemptAt || 0;
      const waitPart = nextAt > now ? `, chờ ${fmtShortCountdown(nextAt - now)}` : '';
      return {
        kind: 'reconnect',
        text: `Kết nối lại lần ${k}/${maxStr}${waitPart}`,
        since: session.reconnectHandler?.scheduledAt || stateSince,
        ...(nextAt > now ? { etaAt: nextAt } : {}),
        stale: false,
      };
    }
    // 4. CONNECTING / AUTHENTICATING / SPAWNING
    if (st === CS.CONNECTING) {
      return { kind: 'login', text: 'Đang kết nối tới server', since: stateSince, stale: isStale({ kind: 'login', since: stateSince }, now) };
    }
    if (st === CS.AUTHENTICATING) {
      return { kind: 'login', text: 'Đăng nhập: xác thực tài khoản', since: stateSince, stale: isStale({ kind: 'login', since: stateSince }, now) };
    }
    if (st === CS.SPAWNING) {
      return { kind: 'login', text: 'Đang tải thế giới (spawn)', since: stateSince, stale: isStale({ kind: 'login', since: stateSince }, now) };
    }
  }

  // 5. login / antibot / menu in progress
  if (session.autoLogin?.inFlow) {
    const alState = session.autoLogin.state;
    const since = session.autoLogin._flowStartedAt || session.autoLogin._enteredAt || stateSince;
    let text = 'Đăng nhập tự động';
    if (alState === 'WAITING_TO_SEND_LOGIN' || alState === 'WAITING_LOGIN_SUCCESS') {
      const cmd = session.autoLogin.o?.loginCommand || '/l';
      text = `Đăng nhập: gõ ${cmd}`;
    } else if (alState === 'ANTIBOT_VERIFY' || alState === 'WAIT_AFTER_VERIFY') {
      text = 'Đăng nhập: vượt antibot';
    } else {
      const slot = typeof session.autoLogin._finalSlot === 'function' ? session.autoLogin._finalSlot() : 24;
      text = `Mở menu: click ô ${slot}`;
    }
    return { kind: 'login', text, since, stale: isStale({ kind: 'login', since }, now) };
  }
  if (session.cfg?.botPassword && !session._loginConfirmed && st === CS.ONLINE && session._spawnTime > 0) {
    const since = session.state?.loginTime || session._spawnTime || now;
    const cmd = session.cfg.registered === false ? '/dk' : '/dn';
    return { kind: 'login', text: `Đăng nhập: gõ ${cmd}`, since, stale: isStale({ kind: 'login', since }, now) };
  }
  if (session.cfg?.autoMenu && session.cfg?.menuCommand && !session._menuSuccess && session._menuFlowStarted && st === CS.ONLINE) {
    const since = session._spawnTime || now;
    return { kind: 'login', text: `Mở menu: gõ ${session.cfg.menuCommand}`, since, stale: isStale({ kind: 'login', since }, now) };
  }

  // 6. spawner protection handling (_spawnerBusy)
  if (session._spawnerBusy) {
    const since = session._spawnerBusySince || now;
    const total = session.protectedSpawners?.length || 0;
    const text = total ? `Xử lý mối đe dọa: đào lồng (${total} lồng)` : 'Xử lý mối đe dọa bảo vệ lồng';
    return { kind: 'protect', text, since, stale: isStale({ kind: 'protect', since }, now) };
  }

  // 7. macro running (scriptRunner.running: name, step)
  if (session.scriptRunner?.running) {
    const name = sanitizeExternal(session.scriptRunner.currentMacro || 'macro', { max: 40 });
    const step = session.scriptRunner._currentStep;
    const totalSteps = session.scriptRunner._totalSteps;
    const since = session.scriptRunner._startedAt || now;
    const stepPart = step && totalSteps ? ` bước ${step}/${totalSteps}` : '';
    const progress = step && totalSteps ? { done: step, total: totalSteps } : undefined;
    return {
      kind: 'macro',
      text: `Chạy macro "${name}"${stepPart}`,
      since,
      ...(progress ? { progress } : {}),
      stale: isStale({ kind: 'macro', since }, now),
    };
  }

  // 8. sell cycle running (_sellSpawnBusy: spawner i/N)
  if (session._sellSpawnBusy) {
    const total = session.sellSpawnList?.length || session._sellCap?.total || 1;
    const done = Math.min(total, Math.max(1, (session._sellCurrentIdx ?? (session._sellCap?.done || 0)) + 1));
    const cycle = session._sellCycleCount || 1;
    const since = session._sellCycleStartedAt || session._sellCap?.start || now;
    const meanMs = estimateCycleDurationMs(session);
    const etaAt = meanMs ? since + meanMs : undefined;
    return {
      kind: 'sell',
      text: `Bán lồng ${done}/${total} (vòng #${cycle})`,
      since,
      progress: { done, total },
      ...(etaAt ? { etaAt } : {}),
      stale: isStale({ kind: 'sell', since }, now),
    };
  }

  // 9. /home treolong recovery (_sellRecovering: attempt k/max)
  if (session._sellRecovering) {
    const k = session._sellRecoveryAttempt || 1;
    const max = session.sellFailMaxHome || 10;
    const cmd = sanitizeExternal(session.spawnHomeCommand || '/home treolong', { max: 40 });
    const since = session._sellRecoveryStartedAt || now;
    return {
      kind: 'recovery',
      text: `Gõ ${cmd} phục hồi bán (lần ${k}/${max})`,
      since,
      progress: { done: k, total: max },
      stale: isStale({ kind: 'recovery', since }, now),
    };
  }

  // 10. position lost, waiting to return (_posLost)
  if (session._posLost) {
    const tries = session._homeOutage?.tries || 0;
    const cmd = sanitizeExternal(session.spawnHomeCommand || '/home treolong', { max: 40 });
    const since = session._homeOutage?.since || session._posAwaySince || now;
    const tryText = tries ? ` (đã gõ ${cmd} ${tries} lần)` : ` (chờ gõ ${cmd})`;
    return {
      kind: 'poslost',
      text: `Lệch vị trí treo lồng${tryText}`,
      since,
      stale: isStale({ kind: 'poslost', since }, now),
    };
  }

  // 11. AutoOrder
  if (session.autoOrder?.active) {
    const item = sanitizeExternal(session.autoOrder.item || 'item', { max: 40 });
    const state = sanitizeExternal(session.autoOrder.state || 'đang chạy', { max: 40 });
    const since = session.autoOrder.startedAt || now;
    return {
      kind: 'order',
      text: `AutoOrder ${item}: ${state}`,
      since,
      stale: isStale({ kind: 'order', since }, now),
    };
  }

  // 12. AFK jump / walk / shard / autoeat
  if (session.state?.afk === 'jump') {
    return { kind: 'afk', text: 'Treo AFK nhảy', since: session._spawnTime || now, stale: false };
  }
  if (session.state?.afk === 'walk') {
    return { kind: 'afk', text: 'Treo AFK đi bộ', since: session._spawnTime || now, stale: false };
  }
  if (session.state?.tshard || session.state?.autoShard) {
    return { kind: 'afk', text: 'Treo nhận Shard', since: session._spawnTime || now, stale: false };
  }
  if (session.state?.autoEat && session._isEating) {
    return { kind: 'eat', text: 'Đang tự ăn', since: now, stale: false };
  }

  // 13. idle, waiting for the next sell cycle (countdown)
  if (session._sellSpawnOn) {
    const nextAt = session._nextSellAt || 0;
    const countText = nextAt > now ? ` (còn ${fmtShortCountdown(nextAt - now)})` : '';
    return {
      kind: 'idle',
      text: `Đứng canh lồng, chờ vòng bán kế tiếp${countText}`,
      since: session._spawnTime || now,
      ...(nextAt > now ? { etaAt: nextAt } : {}),
      stale: false,
    };
  }

  return {
    kind: 'idle',
    text: 'Đứng yên tại vị trí (chưa bật bán lồng)',
    since: session._spawnTime || now,
    stale: false,
  };
}

/**
 * Trả về hoạt động hiện tại của bot: { kind, text, since, progress, etaAt, stale }.
 * Ưu tiên: kiểm tra cờ mâu thuẫn -> slot tường minh có độ ưu tiên cao nhất -> suy diễn từ state/flag.
 */
function describeActivity(session, now = Date.now()) {
  try {
    const contradiction = checkContradictions(session);
    if (contradiction) {
      dbg('BotActivity', `Contradicting flags on ${session?.cfg?.id || '?'}: ${contradiction}`);
      return { kind: 'unknown', text: 'Không xác định', since: now, stale: false };
    }
    initSessionActivity(session);
    const st = session.state?.connState;
    if (!session._disabled && st === CS.ONLINE) {
      const explicit = pickTopExplicitActivity(session, now);
      if (explicit) return explicit;
    } else if (session.activities.size > 0 && (st === CS.CONNECTING || st === CS.AUTHENTICATING || st === CS.SPAWNING || st === CS.RECONNECTING)) {
      const explicit = pickTopExplicitActivity(session, now);
      if (explicit && (explicit.kind === 'login' || explicit.kind === 'reconnect' || explicit.kind === 'proxy')) {
        return explicit;
      }
    }
    return deriveFromFlags(session, now);
  } catch (e) {
    dbg('BotActivity', e);
    return { kind: 'unknown', text: 'Không xác định', since: now, stale: false };
  }
}

module.exports = {
  RingBuffer,
  ACTIVITY_SPECS,
  HISTORY_CAP,
  HISTORY_LINE_MAX,
  SNAPSHOT_TTL_MS,
  initSessionActivity,
  setActivity,
  endActivity,
  clearActivities,
  getActivitySnapshot,
  describeActivity,
  pushHistory,
  recordCycleDuration,
  estimateCycleDurationMs,
  fmtShortCountdown,
  checkContradictions,
};
