'use strict';
/**
 * AiController.js — Điều phối AI-Anter tích hợp OmniRouter API (OpenAI-compatible /v1/chat/completions)
 * kết hợp bộ phân tích ngôn ngữ tự nhiên tiếng Việt tại chỗ.
 *
 * Luồng xử lý (v2):
 *   1. LOCAL-FIRST: parser tại chỗ chạy trước. Nếu hiểu chắc chắn (từ khoá + mục tiêu rõ) thì thực thi
 *      luôn, không gọi API (nhanh, rẻ, không bị LLM "nghĩ bậy").
 *   2. Chỉ gọi LLM khi local không hiểu, hoặc câu mang tính hỏi/phân tích ("sao bot 2 treo vậy?").
 *   3. LLM chỉ LẬP KẾ HOẠCH (JSON actions). Hệ thống validate (whitelist type, target tồn tại,
 *      denylist lệnh) rồi mới thực thi.
 *   4. Báo cáo dựa trên KẾT QUẢ THẬT. Với log/trạng thái, kết quả được gửi lại LLM để diễn giải.
 *   5. Câu nhiều thao tác ("bật bán lồng rồi bảo vệ lồng bot 1") được tách thành nhiều action.
 *   6. Thiếu bot mục tiêu cho lệnh nguy hiểm (stop/reconnect/cmd/macro) => hỏi lại, nhớ ngữ cảnh.
 *   7. Có lịch sử hội thoại ngắn: hiểu "bot đó", "làm lại đi".
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { DEFAULT_CMD_DENYLIST } = require('./ConfigValidator');
const { describeActivity } = require('./BotActivity');
const { maskSecret } = require('../ui/text');

const DEFAULT_BASE_URL = 'https://omnirouter.li/v1';
const DEFAULT_MODEL = 'agy/gemini-3.8-flash-medium';
const DEFAULT_TIMEOUT_MS = 25000; // model "medium" có thể suy nghĩ lâu hơn
const DEFAULT_HISTORY_TURNS = 20;
const MAX_ACTIONS = 8;
const PENDING_TTL_MS = 5 * 60 * 1000;

const ALLOWED_TYPES = new Set([
  'greet', 'logs', 'status',
  'start', 'stop', 'reconnect',
  'sell_on', 'sell_off', 'sell_now',
  'protect_on', 'protect_off',
  'afk_jump', 'afk_walk', 'afk_stop',
  'home', 'macro', 'stop_macro', 'cmd',
  'inv', 'pos', 'activity', 'ping', 'chat',
  'checkstats', 'bal',
]);
// Các lệnh nguy hiểm: không bao giờ mặc định "cả dàn bot" khi thiếu mục tiêu.
const NEEDS_TARGET = new Set(['stop', 'reconnect', 'cmd', 'macro', 'stop_macro', 'chat']);
const INFO_TYPES = new Set(['logs', 'status', 'inv', 'pos', 'activity', 'ping', 'checkstats', 'bal']);

const CLARIFY_VERB = {
  stop: 'dừng',
  reconnect: 'kết nối lại',
  cmd: 'gửi lệnh cho',
  macro: 'chạy macro trên',
  stop_macro: 'dừng macro trên',
  chat: 'gửi chat từ',
};

const QUESTION_RE = /\?|\b(sao|tai sao|vi sao|co phai|lieu|bao nhieu|la gi|the nao|nhu the nao|bi gi|co nen|hay khong)\b/;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ */
/* Tiện ích tiếng Việt                                                  */
/* ------------------------------------------------------------------ */

function foldRaw(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function foldVi(s) {
  return foldRaw(s).trim();
}

/**
 * Phân biệt nghĩa của "dung" khi bỏ dấu:
 *   "dừng" (có râu ư)         => dừng/stop
 *   "dùng" / "dụng" (có dấu)   => sử dụng
 *   "dung" không dấu           => đoán theo từ đứng cạnh
 */
function dungSense(rawTok, prev, next) {
  const nfd = String(rawTok || '').normalize('NFD');
  if (/\u031b/.test(nfd)) return 'stop';
  if (/[\u0300\u0301\u0303\u0309\u0323]/.test(nfd)) return 'use';
  if (['su', 'ap', 'noi', 'nhan', 'hieu', 'tinh', 'cong', 'thuc'].includes(prev)) return 'use';
  if (['lenh', 'de', 'cmd', 'command', 'chuc', 'nang'].includes(next)) return 'use';
  return 'stop';
}

/**
 * Chuẩn hoá câu để so khớp ý định: bỏ dấu, hạ chữ thường; riêng "dùng/dụng" (sử dụng)
 * được đổi thành "dung_use" để KHÔNG bị nhầm với "dừng" (stop).
 */
function normalizeIntent(raw) {
  const nfc = String(raw || '').normalize('NFC').toLowerCase();
  const toks = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(nfc))) toks.push({ raw: m[0], idx: m.index, f: foldVi(m[0]) });

  let out = '';
  let last = 0;
  toks.forEach((t, i) => {
    out += foldRaw(nfc.slice(last, t.idx));
    let w = t.f;
    if (w === 'dung') {
      const sense = dungSense(t.raw, toks[i - 1]?.f || '', toks[i + 1]?.f || '');
      w = sense === 'use' ? 'dung_use' : 'dung';
    }
    out += w;
    last = t.idx + t.raw.length;
  });
  out += foldRaw(nfc.slice(last));
  return out.trim();
}

function isBlockedRawCommand(cmdText, denylist = DEFAULT_CMD_DENYLIST) {
  const trimmed = String(cmdText || '').trim().replace(/^\/+/, '');
  const first = (trimmed.split(/\s+/)[0] || '').toLowerCase();
  const denySet = new Set((denylist || DEFAULT_CMD_DENYLIST).map(x => String(x).replace(/^\/+/, '').toLowerCase()));
  if (denySet.has(first)) return true;
  return /^(dn|dk|login|register|log|reg|l|changepassword|cp|unregister|pay)$/i.test(first);
}

/**
 * Chuẩn hoá URL gốc của OmniRouter sang endpoint /chat/completions.
 */
function buildChatCompletionsUrl(baseUrl) {
  let u = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!u) u = DEFAULT_BASE_URL;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return `${u}/v1/chat/completions`;
}

/* ------------------------------------------------------------------ */
/* Tìm bot mục tiêu                                                     */
/* ------------------------------------------------------------------ */

const NUMLIST = '\\d+(?:\\s*(?:,|va|&|voi|den|toi|-)\\s*\\d+)*';

/**
 * Tìm danh sách bot mục tiêu từ câu lệnh tiếng Việt / tiếng Anh.
 */
function resolveTargetBots(text, bots = []) {
  if (!Array.isArray(bots) || !bots.length) return [];
  const raw = String(text || '').trim();
  const folded = foldVi(raw);

  // 1. Tất cả bot
  if (/\b(tat ca|toan bo|ca dan|het tat ca|all)\b/.test(folded)) {
    return [...bots];
  }

  // 2. "2 bot", "cả 2 bot" (số lượng tổng quát, không có "số 2", "#2" theo sau)
  const nBotMatch = /\b(?:cua|ca)?\s*(\d+)\s+bots?\b(?!\s+(?:so|thu|#|[0-9]))/.exec(folded);
  if (nBotMatch) {
    const count = parseInt(nBotMatch[1], 10);
    if (Number.isFinite(count) && count > 0) {
      if (count >= bots.length) return [...bots];
      return bots.slice(0, count);
    }
  }

  const picked = [];
  const seen = new Set();
  const addBot = (b) => {
    if (b && !seen.has(b.cfg.id)) {
      seen.add(b.cfg.id);
      picked.push(b);
    }
  };

  // 3. Khớp đích danh theo ID bot hoặc Username
  const lowerRaw = raw.toLowerCase();
  for (const b of bots) {
    const id = String(b.cfg?.id || '').toLowerCase();
    const user = String(b.cfg?.username || '').toLowerCase();
    if (id) {
      const escId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9_-])${escId}(?![a-z0-9_-])`, 'i').test(lowerRaw) || foldVi(id) === folded) {
        addBot(b);
      }
    }
    if (user && user.length >= 3) {
      const escUser = user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(?<![a-z0-9_-])${escUser}(?![a-z0-9_-])`, 'i').test(lowerRaw)) {
        addBot(b);
      }
    }
  }

  // 4. Số thứ tự: "bot 1 và 2", "bot số 1, 3", "bot 1-3", "bot 1 và bot 3", "#2", "số 2"
  const segments = [];
  const afterBotRe = new RegExp(`\\bbots?\\s+(?:so\\s+|thu\\s+|#)?(${NUMLIST})`, 'g');
  const afterSoRe = new RegExp(`(?:\\b(?:so|thu)|#)\\s*(${NUMLIST})`, 'g');
  for (const m of folded.matchAll(afterBotRe)) segments.push(m[1]);
  for (const m of folded.matchAll(afterSoRe)) segments.push(m[1]);

  for (const seg of segments) {
    for (const m of seg.matchAll(/\b(\d+)\s*(?:-|den|toi)\s*(\d+)\b/g)) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        for (let idx = Math.min(a, b); idx <= Math.max(a, b); idx++) {
          if (idx >= 1 && idx <= bots.length) addBot(bots[idx - 1]);
        }
      }
    }
    for (const m of seg.matchAll(/\b(\d+)\b/g)) {
      const idx = parseInt(m[1], 10);
      if (idx >= 1 && idx <= bots.length) addBot(bots[idx - 1]);
    }
  }

  return picked;
}

/* ------------------------------------------------------------------ */
/* Tách câu nhiều thao tác                                              */
/* ------------------------------------------------------------------ */

const VERB_LA = '(?:khoi dong|bat|tat|dung|ngung|ngat|chay|start|stop|restart|reconnect|ket noi|vao lai|xem|doc|bao cao|trang thai|kiem tra|tom tat|ve home|gui|go lenh|macro|ban|bao ve|canh|protect|afk|wafk|cho)';
const CMD_KW_RE = /\b(?:(?:gui|go|nhap|chay)\s+lenh|gui\s+chat|chat|lenh(?=\s*["'`\/]))\s*/;

/**
 * Tách "bật bán lồng rồi bảo vệ lồng bot 1", "khởi động bot 1, bật bán lồng"... thành nhiều đoạn.
 * Không tách bên trong nội dung trong ngoặc kép hoặc phần nội dung lệnh raw.
 */
function splitSegments(text) {
  const nfc = String(text || '').normalize('NFC');
  let f = foldRaw(nfc);
  if (f.length !== nfc.length) return [nfc.trim()].filter(Boolean);
  f = f.replace(/(["'`“‘])([^"'`”’]*)(["'`”’])/g, (m, a, b, c) => a + 'x'.repeat(b.length) + c);

  const cmdM = CMD_KW_RE.exec(f);
  const cmdIdx = cmdM ? cmdM.index : Infinity;

  const re = new RegExp(
    `(\\s*(?:[;\\n]+|,?\\s*\\b(?:roi|sau do|xong|then)\\b)\\s*)|((?:\\s*[+,]\\s*|\\s+\\bva\\b\\s+)(?=${VERB_LA}\\b))`,
    'g'
  );

  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(f))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const isHard = m[1] !== undefined;
    if (!isHard && m.index > cmdIdx) continue; // phần sau "gửi lệnh" là nội dung lệnh
    parts.push(nfc.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(nfc.slice(last));
  return parts.map(s => s.trim()).filter(Boolean);
}

/**
 * Tách nội dung lệnh raw: "gửi lệnh /sethome cho bot 2" => { cmd: '/sethome', targetText: 'bot 2' }
 */
function extractRawCmd(seg) {
  const nfc = String(seg || '').normalize('NFC');
  const f = foldRaw(nfc);
  if (f.length !== nfc.length) return null;
  const m = CMD_KW_RE.exec(f);
  if (!m) return null;
  const before = nfc.slice(0, m.index);
  const rest = nfc.slice(m.index + m[0].length);

  const q = /^["'`“‘]([^"'`”’]+)["'`”’]\s*(.*)$/.exec(rest);
  if (q) return { cmd: q[1].trim(), targetText: `${before} ${q[2]}`.trim() };

  const rf = foldRaw(rest);
  const t = /\s+(?:cho|tren|o|vao)\s+(?=(?:bot\b|tat ca|toan bo|ca dan|all\b|#?\d))/.exec(rf);
  if (t) {
    return {
      cmd: rest.slice(0, t.index).trim(),
      targetText: `${before} ${rest.slice(t.index + t[0].length)}`.trim(),
    };
  }
  return { cmd: rest.trim(), targetText: before.trim() };
}

function pickTargets(text, bots, ctx = {}) {
  const t = resolveTargetBots(text, bots);
  if (t.length) return { ids: t.map(b => b.cfg.id), explicit: true };
  const f = foldVi(text);
  if (ctx.lastTargetIds?.length) {
    if (/\b(?:bot|con|em|dua)\s+(?:do|nay|kia|day|ay|vua roi|vua noi)\b|\b(?:no|han|em no|tui no|chung no|nhu cu)\b/.test(f)) {
      return { ids: [...ctx.lastTargetIds], explicit: true };
    }
  }
  return { ids: [], explicit: false };
}

/**
 * Nhận diện MỘT thao tác trong một đoạn câu. Trả về null nếu không hiểu.
 */
function classifySegment(seg, bots, ctx = {}) {
  const raw = String(seg || '').normalize('NFC').trim();
  if (!raw) return null;
  const n = normalizeIntent(raw);
  const mk = (type, arg, text = raw) => ({ type, arg, ...pickTargets(text, bots, ctx) });

  // 0. Gửi lệnh raw (nội dung lệnh giữ nguyên, kiểm tra ĐẦU TIÊN)
  const rc = extractRawCmd(raw);
  if (rc && rc.cmd) return mk('cmd', rc.cmd, rc.targetText);

  // 1. Chào hỏi
  if (/^(xin chao|chao|hello|hi|hey|alo|halo)\b/.test(n) || /\b(ban la ai|em la ai|tro ly)\b/.test(n)) {
    return { type: 'greet', ids: [], explicit: false };
  }

  // 1a. CheckStats người chơi (checkstats)
  // Các mẫu: "check stats <player>", "xem stats của <player>", "chỉ số của <player>", "thống kê <player>", "stats player <player>"
  const statsPatterns = [
    /(?:^|\b)(?:check\s*stats|checkstats)\s+([A-Za-z0-9_.*]{1,32})\b/i,
    /(?:^|\b)(?:xem\s+stats|xem\s+thống\s+kê|xem\s+thong\s+ke|thống\s+kê|thong\s+ke|chỉ\s+số|chi\s+so)(?:\s+(?:của|cua))?\s+([A-Za-z0-9_.*]{1,32})\b/i,
    /(?:^|\b)(?:stats\s+player|stats\s+(?:của|cua))\s+([A-Za-z0-9_.*]{1,32})\b/i,
    /(?:^|\b)stats\s+([A-Za-z0-9_.*]{1,32})\b/i,
  ];
  for (const re of statsPatterns) {
    const sm = re.exec(raw);
    if (sm) {
      const pName = sm[1].trim();
      const bad = new Set(['bot', 'dan', 'all', 'ca', 'cua', 'he', 'thong', 'status', 'may', 'cac']);
      if (!bad.has(foldVi(pName))) {
        return mk('checkstats', pName);
      }
    }
  }

  // 1b. Bal người chơi (bal)
  // Các mẫu: "check bal <player>", "số dư của <player>", "xem tiền của <player>", "bal <player>", "<player> có bao nhiêu tiền", "tiền của <player>"
  const balSuffixMatch = /\b([A-Za-z0-9_.*]{1,32})\s+(?:có|co)\s+(?:bao\s+nhiêu|bao\s+nhieu|mấy|may)\s+(?:tiền|tien)\b/i.exec(raw);
  if (balSuffixMatch) {
    const pName = balSuffixMatch[1].trim();
    const bad = new Set(['bot', 'dan', 'all', 'ca', 'cua', 'he', 'thong', 'may', 'cac']);
    if (!bad.has(foldVi(pName))) {
      return mk('bal', pName);
    }
  }

  const balPrePatterns = [
    /(?:^|\b)(?:check\s*bal|checkbal|số\s+dư|so\s+du|xem\s+tiền|xem\s+tien|tiền|tien|bal)(?:\s+(?:của|cua))?\s+([A-Za-z0-9_.*]{1,32})\b/i,
  ];
  for (const re of balPrePatterns) {
    const bm = re.exec(raw);
    if (bm) {
      const pName = bm[1].trim();
      const bad = new Set(['bot', 'dan', 'all', 'ca', 'cua', 'he', 'thong', 'status', 'may', 'cac', 'bao', 'nhieu']);
      if (!bad.has(foldVi(pName))) {
        return mk('bal', pName);
      }
    }
  }

  // 2. Tóm tắt log / lịch sử
  if (/\b(tom tat|noi dung log|xem log|doc log|log cua|nhat ky|lich su)\b/.test(n)) return mk('logs');

  // 3. Trạng thái / báo cáo
  if (/\b(trang thai|status|tinh hinh|bao cao|doanh thu|kiem tra|danh sach)\b/.test(n)) return mk('status');

  // 3a. Xem túi đồ / vật phẩm (inv)
  if (/\b(tui do|kho do|ruong do|xem do|inventory|inv|vat pham|do trong tui)\b/.test(n)) return mk('inv');

  // 3b. Toạ độ / vị trí (pos)
  if (/\b(toa do|vi tri|o dau|dung dau|dung cho nao|coords?|pos|position)\b/.test(n)) return mk('pos');

  // 3c. Hoạt động hiện tại (activity)
  if (/\b(dang lam gi|hoat dong|activity|tinh hinh hoat dong)\b/.test(n)) return mk('activity');

  // 3d. Ping / độ trễ / mạng (ping)
  if (/\b(ping|do tre|latency|mang meo|lag khong|co lag khong)\b/.test(n)) return mk('ping');

  // 3e. Chat trong game (chat)
  const chatMatch = /^(?:chat|noi|bao)\s+(?:trong\s+game\s+)?(["'`“‘](.+?)["'`”’]|.+)$/i.exec(raw);
  if (chatMatch && !/\b(bot|tat ca|toan bo)\b/.test(chatMatch[1])) {
    const chatMsg = (chatMatch[2] || chatMatch[1] || '').trim();
    if (chatMsg && !/^(lenh|cmd|\/)/i.test(chatMsg)) {
      return mk('chat', chatMsg);
    }
  }

  // 4. Autosell_spawn (bán lồng)
  if (/\b(autosell_spawn|autosell|ban long|auto sell|tu ban)\b/.test(n)
    || /\b(bat|tat|dung)\s+ban\b/.test(n) || /\bban\s+ngay\b/.test(n)) {
    let type = 'sell_on';
    if (/\b(tat(?! ca\b)|dung|ngung|off|stop)\b/.test(n)) type = 'sell_off';
    else if (/\b(ngay|now|1 vong|mot vong)\b/.test(n)) type = 'sell_now';
    return mk(type);
  }

  // 5. Bảo vệ lồng
  if (/\b(spawnerprotect|protect|bao ve long|canh long)\b/.test(n)) {
    return mk(/\b(tat(?! ca\b)|dung|ngung|off|stop)\b/.test(n) ? 'protect_off' : 'protect_on');
  }

  // 6. AFK
  if (/\b(wafk|afk)\b/.test(n)) {
    let type = 'afk_jump';
    if (/\b(tat(?! ca\b)|dung|ngung|off|stop|nghi)\b/.test(n)) type = 'afk_stop';
    else if (/\b(wafk|di bo|walk)\b/.test(n)) type = 'afk_walk';
    return mk(type);
  }

  // 7. Về home
  if (/\b(ve home|spawnhome|quay ve home|ve treolong)\b/.test(n) || /(?:^|\s|\/)home\b/.test(n)) return mk('home');

  // 8. Macro
  if (/\b(?:dung|tat|stop)\s+macro\b/.test(n)) return mk('stop_macro');
  const mm = /\bmacro\s+([A-Za-z0-9_-]+)/i.exec(raw);
  if (mm) {
    const bad = new Set(['cho', 'tren', 'o', 'bot', 'tat', 'all', 'so', 'thu', 'nao']);
    const name = bad.has(foldVi(mm[1])) ? '' : mm[1];
    return mk('macro', name, raw.replace(mm[0], ' '));
  }

  // 9. Kết nối lại
  if (/\b(reconnect|ket noi lai|vao lai|relog|khoi dong lai|restart)\b/.test(n)) return mk('reconnect');

  // 10. Khởi động
  if (/\b(khoi dong|bat(?! ngo\b| dac di\b)|chay|start|login|dang nhap|vao server|log in)\b/.test(n)) return mk('start');

  // 11. Dừng / tắt
  const nStop = n.replace(/\b(tom tat|noi dung|ap dung|suy nghi|de nghi|nghi ngo)\b/g, ' ');
  if (/\b(dung|tat(?! ca\b)|ngung|ngat|stop|out|disconnect|thoat|nghi|kick)\b/.test(nStop)) return mk('stop');

  // 12. Tiếp nối hành động lượt trước cho bot khác hoặc player khác ("còn bot 2?", "thế còn bot 2 thì sao?", "còn Alex?")
  const followMatch = /^(?:the\s+)?con\s+(?:lai\s+)?(?:bot\s+|con\s+|#)?(\d+|[a-zA-Z0-9_-]+)(?:\s*(?:thi\s+sao|nhu\s+nao|the\s+nao|nua))?[?\s.]*$/i.exec(n);
  if (followMatch && ctx.lastActions?.length) {
    const nextTargetStr = followMatch[1];
    const prevAct = ctx.lastActions[0];
    if (prevAct && prevAct.type && prevAct.type !== 'greet') {
      if (['checkstats', 'bal'].includes(prevAct.type)) {
        return { type: prevAct.type, ids: [], arg: nextTargetStr, explicit: true, followUp: true };
      }
      const targetQuery = /^\d+$/.test(nextTargetStr) ? `bot ${nextTargetStr}` : nextTargetStr;
      return { ...mk(prevAct.type, prevAct.arg, targetQuery), followUp: true };
    }
  }

  return null;
}

function buildClarifyQuestion(pendingActions, bots) {
  const verbs = [...new Set((pendingActions || []).map(a => CLARIFY_VERB[a.type] || a.type))];
  const list = (bots || []).map((b, i) => `#${i + 1} ${b.cfg?.id || ''}`).join(', ');
  return `Bạn muốn ${verbs.join(' / ')} bot nào? Hiện có: ${list || '(chưa có bot)'} — hoặc nói "tất cả".`;
}

/**
 * Phân tích câu lệnh tự nhiên tiếng Việt / tiếng Anh sang danh sách hành động chuẩn.
 * Trả về { cleaned, actions, clarify?, pendingActions?, repeatLast? }
 *
 * @param ctx { lastTargetIds } — ngữ cảnh để hiểu "bot đó", "như cũ"
 */
function parseNaturalCommand(rawInput, bots = [], ctx = {}) {
  const cleaned = String(rawInput || '')
    .trim()
    .replace(/^(?:dev|operator|admin|user)\s*:\s*/i, '')
    .replace(/^\/?ai\s+/i, '')
    .trim();

  if (!cleaned) return { actions: [], cleaned: '' };

  if (/^(lam lai|lap lai|nhu cu|nua di|lam nua|again|redo)\b/.test(foldVi(cleaned))) {
    return { cleaned, actions: [], repeatLast: true };
  }

  const parsed = [];
  for (const seg of splitSegments(cleaned)) {
    const c = classifySegment(seg, bots, ctx);
    if (c) parsed.push(c);
  }
  if (!parsed.length) return { actions: [], cleaned };

  // Đoạn không nêu bot => mượn mục tiêu của đoạn gần nhất có nêu (ưu tiên đoạn trước)
  for (let i = 0; i < parsed.length; i++) {
    if (parsed[i].explicit || parsed[i].type === 'greet') continue;
    let src = null;
    for (let j = i - 1; j >= 0 && !src; j--) if (parsed[j].explicit) src = parsed[j];
    for (let j = i + 1; j < parsed.length && !src; j++) if (parsed[j].explicit) src = parsed[j];
    if (src) {
      parsed[i].ids = [...src.ids];
      parsed[i].explicit = true;
    }
  }

  const allIds = bots.map(b => b.cfg.id);
  const actions = [];
  const pendingActions = [];
  const seen = new Set();
  for (const p of parsed) {
    if (p.type === 'greet') {
      if (!seen.has('greet')) { seen.add('greet'); actions.push({ type: 'greet' }); }
      continue;
    }
    let ids = p.ids;
    if (!ids.length) {
      if (ctx.lastTargetIds?.length === 1 && !/\b(tat ca|toan bo|ca dan|all)\b/.test(foldVi(cleaned))) {
        // Tự động mượn bot vừa tương tác ở lượt trước nếu người dùng ra lệnh không nêu rõ tên bot
        ids = [...ctx.lastTargetIds];
      } else if (NEEDS_TARGET.has(p.type) && allIds.length > 1) {
        pendingActions.push({ type: p.type, ...(p.arg ? { arg: p.arg } : {}) });
        continue;
      } else {
        ids = allIds;
      }
    }
    const key = `${p.type}|${p.arg || ''}|${ids.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ type: p.type, targets: ids, ...(p.arg ? { arg: p.arg } : {}) });
  }

  const out = { cleaned, actions };
  if (parsed.some(p => p.followUp)) out.followUp = true;
  if (pendingActions.length) {
    out.pendingActions = pendingActions;
    out.clarify = buildClarifyQuestion(pendingActions, bots);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* AiController                                                         */
/* ------------------------------------------------------------------ */

class AiController {
  constructor(manager, opts = {}) {
    this.mgr = manager;
    this.apiKey = '';
    this.baseUrl = DEFAULT_BASE_URL;
    this.model = DEFAULT_MODEL;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
    this.historyTurns = opts.historyTurns !== undefined ? Number(opts.historyTurns) : DEFAULT_HISTORY_TURNS;
    this._httpPost = opts.httpPost || null; // cho phép inject mock trong unit test
    this._jsonMode = true;                  // tự tắt nếu model/router không hỗ trợ response_format
    this._history = new Map();              // chatId -> [{role, content}]
    this._memory = new Map();               // k -> v (thông tin người dùng / ngữ cảnh dài hạn)
    this._pending = null;                   // câu hỏi làm rõ đang chờ trả lời
    this._lastTargets = [];
    this._lastActions = [];
    this._historyFile = opts.historyFile !== undefined
      ? opts.historyFile
      : (this.mgr?.configPath ? path.join(path.dirname(this.mgr.configPath), 'ai_history.json') : path.join(process.cwd(), 'ai_history.json'));
    this._saveTimer = null;
    this.configure(opts);
    this._loadHistoryFromDisk();
  }

  configure(opts = {}) {
    if (opts.apiKey !== undefined) {
      this.apiKey = opts.apiKey ? String(opts.apiKey).trim() : '';
    }
    if (opts.baseUrl !== undefined) {
      this.baseUrl = opts.baseUrl ? String(opts.baseUrl).trim() : DEFAULT_BASE_URL;
    }
    if (opts.model !== undefined) {
      const nextModel = opts.model ? String(opts.model).trim() : DEFAULT_MODEL;
      if (nextModel !== this.model) this._jsonMode = true; // thử lại json mode với model mới
      this.model = nextModel;
    }
    if (opts.timeoutMs !== undefined && Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) >= 1000) {
      this.timeoutMs = Number(opts.timeoutMs);
    }
    if (opts.historyTurns !== undefined && Number.isFinite(Number(opts.historyTurns)) && Number(opts.historyTurns) >= 0) {
      this.historyTurns = Math.min(50, Number(opts.historyTurns));
    }
    if (opts.historyFile !== undefined) {
      this._historyFile = opts.historyFile;
    }
    return this;
  }

  get hasKey() {
    return Boolean(this.apiKey && this.apiKey.length >= 4);
  }

  get endpointUrl() {
    return buildChatCompletionsUrl(this.baseUrl);
  }

  getStatus() {
    return {
      enabled: this.hasKey,
      maskedKey: this.hasKey ? maskSecret(this.apiKey) : '(chưa đặt)',
      baseUrl: this.baseUrl || DEFAULT_BASE_URL,
      endpoint: this.endpointUrl,
      model: this.model || DEFAULT_MODEL,
      jsonMode: this._jsonMode,
      historyTurns: this.historyTurns,
    };
  }

  _loadHistoryFromDisk() {
    if (!this._historyFile) return;
    try {
      if (fs.existsSync(this._historyFile)) {
        const raw = fs.readFileSync(this._historyFile, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
          if (data.history && typeof data.history === 'object') {
            for (const [cid, msgs] of Object.entries(data.history)) {
              if (Array.isArray(msgs)) this._history.set(String(cid), msgs.slice(-this.historyTurns * 2));
            }
          }
          if (data.memory && typeof data.memory === 'object') {
            for (const [k, v] of Object.entries(data.memory)) {
              if (v !== undefined) this._memory.set(String(k), String(v));
            }
          }
          if (Array.isArray(data.lastTargets) && data.lastTargets.length) {
            this._lastTargets = data.lastTargets;
          }
          if (Array.isArray(data.lastActions) && data.lastActions.length) {
            this._lastActions = data.lastActions;
          }
        }
      }
    } catch { /* ignore corrupted disk file */ }
  }

  flushHistoryToDisk() {
    if (!this._historyFile) return;
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try {
      const histObj = {};
      for (const [k, v] of this._history.entries()) {
        histObj[k] = v.slice(-this.historyTurns * 2);
      }
      const memObj = {};
      for (const [k, v] of this._memory.entries()) {
        memObj[k] = v;
      }
      const data = {
        history: histObj,
        memory: memObj,
        lastTargets: this._lastTargets,
        lastActions: this._lastActions,
        updatedAt: Date.now(),
      };
      const dir = path.dirname(this._historyFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = this._historyFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, this._historyFile);
    } catch { /* ignore disk save errors */ }
  }

  _saveHistoryToDisk() {
    if (!this._historyFile) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this.flushHistoryToDisk();
    }, 500);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  resetHistory(chatId) {
    if (chatId === undefined) {
      this._history.clear();
      this._memory.clear();
      this._lastTargets = [];
      this._lastActions = [];
    } else {
      this._history.delete(String(chatId));
    }
    this._pending = null;
    this.flushHistoryToDisk();
    return this;
  }

  /* ---------------- lịch sử hội thoại ---------------- */

  _getHistory(chatId) {
    if (!this.historyTurns) return [];
    const key = String(chatId || 'default');
    const arr = this._history.get(key) || [];
    return arr.slice(-this.historyTurns * 2);
  }

  _pushHistory(chatId, role, content) {
    if (!this.historyTurns) return;
    const text = String(content || '').trim().slice(0, 800);
    if (!text) return;
    const key = String(chatId || 'default');
    const arr = this._history.get(key) || [];
    arr.push({ role, content: text });
    while (arr.length > this.historyTurns * 2) arr.shift();
    this._history.set(key, arr);
    this._saveHistoryToDisk();
  }

  /* ---------------- dàn bot ---------------- */

  _buildFleetSnapshot() {
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    return bots.map((b, i) => {
      const p = b.mc?.entity?.position;
      const coords = p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : null;
      const invCount = Array.isArray(b.state?.inventory) ? b.state.inventory.length : (b.mc?.inventory?.items?.().length ?? 0);
      return {
        index: i + 1,
        id: b.cfg?.id || `bot-${i + 1}`,
        username: b.cfg?.username || '',
        state: b.state?.connState || 'DISCONNECTED',
        online: Boolean(b.isOnline),
        sellOn: Boolean(b.autoSell?.spawnOn),
        protectOn: Boolean(b.spawnerProtectOn),
        afkMode: b.state?.afkMode || 'off',
        money: b.state?.money ?? 0,
        shard: b.state?.shard ?? 0,
        ping: b.mc?.player?.ping ?? 0,
        coords,
        invUsed: invCount,
      };
    });
  }

  _resolveActionTargets(rawTargets) {
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    if (!bots.length) return [];
    if (!rawTargets || rawTargets === 'all' || (Array.isArray(rawTargets) && rawTargets.includes('all'))) {
      return [...bots];
    }
    const list = Array.isArray(rawTargets) ? rawTargets : [rawTargets];
    const picked = [];
    const seen = new Set();
    const add = (b) => {
      if (b && !seen.has(b.cfg.id)) {
        seen.add(b.cfg.id);
        picked.push(b);
      }
    };

    for (const item of list) {
      const tok = String(item ?? '').trim();
      if (!tok) continue;
      if (tok.toLowerCase() === 'all') return [...bots];
      const exact = bots.find(b => String(b.cfg?.id || '').toLowerCase() === tok.toLowerCase());
      if (exact) { add(exact); continue; }
      const numMatch = /^#?(\d+)$/.exec(tok);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (idx >= 0 && idx < bots.length) { add(bots[idx]); continue; }
      }
      const sub = resolveTargetBots(tok, bots);
      for (const b of sub) add(b);
    }
    return picked;
  }

  /* ---------------- validate kế hoạch từ LLM ---------------- */

  /**
   * Không tin LLM tuyệt đối: whitelist type, kiểm tra target tồn tại, denylist lệnh,
   * tên macro hợp lệ, giới hạn số action. Thiếu mục tiêu của lệnh nguy hiểm => pending (hỏi lại).
   */
  _validateActions(rawActions) {
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    const allIds = bots.map(b => b.cfg.id);
    const valid = [];
    const rejected = [];
    const pending = [];
    if (!Array.isArray(rawActions)) return { valid, rejected, pending };

    const denylist = this.mgr?._config?.telegramCmdDenylist || DEFAULT_CMD_DENYLIST;
    const seen = new Set();

    for (const raw of rawActions.slice(0, MAX_ACTIONS)) {
      if (!raw || typeof raw !== 'object') continue;
      const type = String(raw.type || '').toLowerCase().trim();
      if (!ALLOWED_TYPES.has(type)) {
        rejected.push(`Loại hành động "${type || '?'}" không hợp lệ.`);
        continue;
      }
      if (type === 'greet') {
        if (!seen.has('greet')) { seen.add('greet'); valid.push({ type }); }
        continue;
      }

      const arg = raw.arg == null ? '' : String(raw.arg).trim();
      if (type === 'cmd') {
        if (!arg) { rejected.push('Thiếu nội dung lệnh cần gửi.'); continue; }
        if (isBlockedRawCommand(arg, denylist)) {
          rejected.push('Từ chối lệnh nhạy cảm (login/register/changepassword/pay).');
          continue;
        }
      }
      if (type === 'macro' && !/^[A-Za-z0-9_-]{1,40}$/.test(arg)) {
        rejected.push('Tên macro không hợp lệ hoặc bị thiếu.');
        continue;
      }
      if ((type === 'checkstats' || type === 'bal') && !arg) {
        rejected.push(`Thiếu tên người chơi cho hành động "${type}".`);
        continue;
      }

      let tokens = raw.targets;
      if (tokens == null || tokens === '') tokens = [];
      if (!Array.isArray(tokens)) tokens = [tokens];
      tokens = tokens.map(t => String(t ?? '').trim()).filter(Boolean);

      let ids;
      if (tokens.some(t => t.toLowerCase() === 'all')) {
        ids = allIds;
      } else if (tokens.length) {
        const resolved = this._resolveActionTargets(tokens);
        if (!resolved.length) {
          rejected.push(`Không có bot nào khớp "${tokens.join(', ')}".`);
          continue;
        }
        ids = resolved.map(b => b.cfg.id);
      } else if (NEEDS_TARGET.has(type) && allIds.length > 1) {
        pending.push({ type, ...(arg ? { arg } : {}) });
        continue;
      } else {
        ids = allIds;
      }

      const key = `${type}|${arg}|${ids.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      valid.push({ type, targets: ids, ...(arg ? { arg } : {}) });
    }
    return { valid, rejected, pending };
  }

  /* ---------------- thực thi ---------------- */

  /**
   * Thực thi danh sách hành động điều khiển bot và trả về kết quả chi tiết.
   */
  async executeActions(actions = []) {
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    const results = [];
    const indexMap = new Map(bots.map((b, i) => [b.cfg.id, i + 1]));
    const fmtBot = (b) => `${b.cfg.id} (#${indexMap.get(b.cfg.id) || '?'})`;

    for (const act of actions) {
      if (!act || typeof act !== 'object') continue;
      const type = String(act.type || '').toLowerCase().trim();

      const hasExplicit = Array.isArray(act.targets) ? act.targets.length > 0 : (act.targets != null && act.targets !== '');
      if (NEEDS_TARGET.has(type) && !hasExplicit && bots.length > 1) {
        results.push({ type, ok: false, summary: `Thiếu bot mục tiêu cho "${type}" — hãy nói rõ bot nào hoặc "tất cả".` });
        continue;
      }

      const targets = this._resolveActionTargets(act.targets);

      if (!targets.length && !['status', 'greet', 'checkstats', 'bal'].includes(type)) {
        results.push({ type, ok: false, summary: 'Không tìm thấy bot phù hợp để thực hiện.' });
        continue;
      }

      switch (type) {
        case 'greet': {
          results.push({
            type,
            ok: true,
            summary: 'Chào bạn! Em là AI-Anter sẵn sàng hỗ trợ điều khiển và kiểm tra dàn bot (khởi động/dừng, bật/tắt bán lồng, treo AFK, xem log và doanh thu).',
          });
          break;
        }
        case 'logs': {
          const lines = [];
          const data = [];
          for (const b of targets) {
            const id = b.cfg?.id || 'bot';
            const acc = b.cfg?.username || '';
            const state = b.state?.connState || 'DISCONNECTED';
            const up = this.mgr?.revenue?.uptime ? this.mgr.revenue.uptime(id) : null;
            const rev = this.mgr?.revenue?.stats ? this.mgr.revenue.stats(id) : null;
            const rawLogs = typeof b.getLogs === 'function' ? b.getLogs() : [];
            const recent = rawLogs.filter(l => l && l.level !== 'chat').slice(-3);
            const recentStr = recent.length
              ? recent.map(l => l.msg).join(' · ')
              : (b.isOnline ? 'đang hoạt động ổn định' : 'chưa kết nối');
            const upStr = up?.totalMs ? `${Math.round(up.totalMs / 60000)}p uptime` : 'offline';
            const revStr = rev && rev.total > 0 ? ` · Doanh thu: $${rev.total.toLocaleString()}` : '';
            lines.push(`• Bot ${id}${acc ? ' (' + acc + ')' : ''}: ${state} (${upStr}${revStr})\n  ↳ Hoạt động: ${recentStr}`);
            data.push({
              id,
              username: acc,
              state,
              online: Boolean(b.isOnline),
              uptimeMin: up?.totalMs ? Math.round(up.totalMs / 60000) : 0,
              revenue: rev?.total || 0,
              recentLogs: recent.map(l => String(l.msg || '').slice(0, 200)),
            });
          }
          results.push({
            type,
            ok: true,
            data,
            summary: `Tóm tắt log của ${targets.length} bot:\n${lines.join('\n')}`,
          });
          break;
        }
        case 'start': {
          const started = [];
          const already = [];
          for (const b of targets) {
            if (b.isConnected || b.isReconnecting) {
              already.push(fmtBot(b));
            } else {
              b._disabled = false;
              b.state.reconnects = 0;
              b.start();
              started.push(fmtBot(b));
            }
          }
          const parts = [];
          if (started.length) parts.push(`đang khởi động ${started.length} bot: ${started.join(', ')}`);
          if (already.length) parts.push(`đang chạy sẵn: ${already.join(', ')}`);
          results.push({ type, ok: true, started, already, summary: parts.join('; ') });
          break;
        }
        case 'stop': {
          const stopped = [];
          for (const b of targets) {
            b.shutdown();
            stopped.push(fmtBot(b));
          }
          results.push({ type, ok: true, stopped, summary: `đã dừng ${stopped.length} bot: ${stopped.join(', ')}` });
          break;
        }
        case 'reconnect': {
          const reconnected = [];
          for (const b of targets) {
            b._disabled = false;
            b.forceReconnect();
            reconnected.push(fmtBot(b));
          }
          results.push({ type, ok: true, reconnected, summary: `đang kết nối lại ${reconnected.length} bot: ${reconnected.join(', ')}` });
          break;
        }
        case 'sell_on':
        case 'sell_off':
        case 'sell_now': {
          const sub = type === 'sell_on' ? 'on' : (type === 'sell_off' ? 'off' : 'now');
          const label = type === 'sell_on' ? 'bật autosell_spawn' : (type === 'sell_off' ? 'tắt autosell_spawn' : 'chạy bán lồng ngay');
          const done = [];
          for (const b of targets) {
            b.cmd(`autosell_spawn ${sub}`);
            done.push(fmtBot(b));
          }
          results.push({ type, ok: true, targets: done, summary: `đã ${label} cho ${done.join(', ')}` });
          break;
        }
        case 'protect_on':
        case 'protect_off': {
          const sub = type === 'protect_on' ? 'on' : 'off';
          const done = [];
          for (const b of targets) {
            b.cmd(`spawnerprotect ${sub}`);
            done.push(fmtBot(b));
          }
          results.push({
            type,
            ok: true,
            targets: done,
            summary: `đã ${sub === 'on' ? 'bật' : 'tắt'} bảo vệ lồng cho ${done.join(', ')}`,
          });
          break;
        }
        case 'afk_jump':
        case 'afk_walk':
        case 'afk_stop': {
          const cmdName = type === 'afk_jump' ? 'afk' : (type === 'afk_walk' ? 'wafk' : 'stop');
          const label = type === 'afk_jump' ? 'bật AFK nhảy' : (type === 'afk_walk' ? 'bật AFK đi bộ' : 'dừng AFK');
          const done = [];
          for (const b of targets) {
            b.cmd(cmdName);
            done.push(fmtBot(b));
          }
          results.push({ type, ok: true, targets: done, summary: `đã ${label} cho ${done.join(', ')}` });
          break;
        }
        case 'home': {
          const done = [];
          for (const b of targets) {
            b.cmd('spawnhome now');
            done.push(fmtBot(b));
          }
          results.push({ type, ok: true, targets: done, summary: `đã gửi lệnh về home cho ${done.join(', ')}` });
          break;
        }
        case 'macro': {
          const macroName = String(act.arg || '').trim();
          if (!macroName) {
            results.push({ type, ok: false, summary: 'Thiếu tên macro cần chạy.' });
            break;
          }
          const done = [];
          for (const b of targets) {
            b.cmd(`macro ${macroName}`);
            done.push(fmtBot(b));
          }
          results.push({ type, ok: true, targets: done, summary: `đang chạy macro "${macroName}" trên ${done.join(', ')}` });
          break;
        }
        case 'stop_macro': {
          const done = [];
          for (const b of targets) {
            b.cmd('stopmacro');
            done.push(fmtBot(b));
          }
          results.push({ type, ok: true, targets: done, summary: `đã dừng macro trên ${done.join(', ')}` });
          break;
        }
        case 'cmd': {
          const rawCmd = String(act.arg || '').trim();
          if (!rawCmd) {
            results.push({ type, ok: false, summary: 'Thiếu nội dung lệnh cần gửi.' });
            break;
          }
          const denylist = this.mgr?._config?.telegramCmdDenylist || DEFAULT_CMD_DENYLIST;
          if (isBlockedRawCommand(rawCmd, denylist)) {
            results.push({ type, ok: false, summary: 'Từ chối lệnh nhạy cảm (login/register/changepassword/pay).' });
            break;
          }
          const done = [];
          for (const b of targets) {
            b.cmd(rawCmd);
            done.push(fmtBot(b));
          }
          results.push({ type, ok: true, targets: done, summary: `đã gửi lệnh "${rawCmd}" cho ${done.join(', ')}` });
          break;
        }
        case 'status': {
          const snap = this._buildFleetSnapshot();
          const onlineCount = snap.filter(s => s.online).length;
          const detail = snap.map(s => {
            const extra = [];
            if (s.sellOn) extra.push('đang bán lồng');
            if (s.protectOn) extra.push('bảo vệ lồng');
            if (s.money) extra.push(`$${Number(s.money).toLocaleString()}`);
            return `#${s.index} ${s.id} (${[s.state, ...extra].join(', ')})`;
          }).join(', ');
          results.push({
            type,
            ok: true,
            data: snap,
            summary: `hiện có ${onlineCount}/${snap.length} bot đang ONLINE${detail ? ': ' + detail : ''}`,
          });
          break;
        }
        case 'inv': {
          const lines = [];
          const data = [];
          for (const b of targets) {
            const id = b.cfg?.id || 'bot';
            if (!b.isOnline) {
              lines.push(`• Bot ${id}: Đang OFFLINE, không thể xem túi đồ.`);
              continue;
            }
            const rawItems = Array.isArray(b.state?.inventory) && b.state.inventory.length
              ? b.state.inventory
              : (b.mc?.inventory?.items?.() || []).map(it => ({
                  name: it.customName || it.displayName || it.name || 'Unknown',
                  count: it.count || 1,
                }));
            const usedSlots = rawItems.length;
            const freeSlots = Math.max(0, 36 - usedSlots);
            const byName = new Map();
            for (const it of rawItems) {
              const k = it.name || 'Unknown';
              byName.set(k, (byName.get(k) || 0) + (Number(it.count) || 1));
            }
            const topList = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
            const summaryText = topList.length
              ? topList.map(([name, count]) => `${name} x${count}`).join(', ')
              : 'Trống';
            lines.push(`• Bot ${id}: Đã dùng ${usedSlots}/36 ô (${freeSlots} ô trống) · ${summaryText}`);
            data.push({ id, usedSlots, freeSlots, topItems: topList });
          }
          results.push({
            type,
            ok: true,
            data,
            summary: `Túi đồ của ${targets.length} bot:\n${lines.join('\n')}`,
          });
          break;
        }
        case 'pos': {
          const lines = [];
          const data = [];
          for (const b of targets) {
            const id = b.cfg?.id || 'bot';
            if (!b.isOnline) {
              lines.push(`• Bot ${id}: Đang OFFLINE, không có toạ độ.`);
              continue;
            }
            const p = b.mc?.entity?.position;
            const dim = b.mc?.game?.dimension || 'overworld';
            if (!p) {
              lines.push(`• Bot ${id}: Chưa tải xong toạ độ.`);
              continue;
            }
            const coordsStr = `X: ${Math.round(p.x)}, Y: ${Math.round(p.y)}, Z: ${Math.round(p.z)}`;
            lines.push(`• Bot ${id}: ${coordsStr} (${dim})`);
            data.push({ id, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), dimension: dim });
          }
          results.push({
            type,
            ok: true,
            data,
            summary: `Toạ độ của ${targets.length} bot:\n${lines.join('\n')}`,
          });
          break;
        }
        case 'activity': {
          const lines = [];
          const data = [];
          for (const b of targets) {
            const id = b.cfg?.id || 'bot';
            const act = typeof describeActivity === 'function' ? describeActivity(b) : (b.isOnline ? 'Đang online' : 'Offline');
            const up = this.mgr?.revenue?.uptime ? this.mgr.revenue.uptime(id) : null;
            const upStr = up?.totalMs ? `${Math.round(up.totalMs / 60000)}p uptime` : 'offline';
            lines.push(`• Bot ${id}: ${act} (Uptime: ${upStr})`);
            data.push({ id, activity: act, uptime: upStr, online: Boolean(b.isOnline) });
          }
          results.push({
            type,
            ok: true,
            data,
            summary: `Hoạt động của ${targets.length} bot:\n${lines.join('\n')}`,
          });
          break;
        }
        case 'ping': {
          const lines = [];
          const data = [];
          for (const b of targets) {
            const id = b.cfg?.id || 'bot';
            if (!b.isOnline) {
              lines.push(`• Bot ${id}: Offline`);
              continue;
            }
            const ping = b.mc?.player?.ping ?? 0;
            lines.push(`• Bot ${id}: Ping ${ping}ms`);
            data.push({ id, ping });
          }
          results.push({
            type,
            ok: true,
            data,
            summary: `Độ trễ (ping) của ${targets.length} bot:\n${lines.join('\n')}`,
          });
          break;
        }
        case 'chat': {
          const chatMsg = String(act.arg || '').trim();
          if (!chatMsg) {
            results.push({ type, ok: false, summary: 'Thiếu nội dung tin nhắn chat.' });
            break;
          }
          const done = [];
          for (const b of targets) {
            if (b.isOnline && b.mc?.chat) {
              b.mc.chat(chatMsg);
              done.push(fmtBot(b));
            }
          }
          results.push({
            type,
            ok: done.length > 0,
            targets: done,
            summary: done.length ? `đã gửi chat "${chatMsg}" từ ${done.join(', ')}` : 'Các bot đang offline không thể chat',
          });
          break;
        }
        case 'checkstats': {
          const player = String(act.arg || '').trim();
          if (!player) {
            results.push({ type, ok: false, summary: 'Thiếu tên người chơi cần kiểm tra stats.' });
            break;
          }
          const activeBot = targets.find(b => b.isOnline) || bots.find(b => b.isOnline);
          if (!activeBot) {
            results.push({ type, ok: false, summary: 'Không có bot nào đang online để kiểm tra stats.' });
            break;
          }
          try {
            const res = typeof activeBot.checkStats === 'function'
              ? await activeBot.checkStats(player, 12000)
              : await activeBot.statsReader.request(player, 12000);

            let linesSummary = '';
            if (Array.isArray(res.items) && res.items.length) {
              linesSummary = res.items
                .map(it => `• ${it.labelVi || it.title || it.label || it.name}: ${it.value || (Array.isArray(it.lore) ? it.lore.join(', ') : '') || '—'}`)
                .join('\n');
            } else if (Array.isArray(res.lines) && res.lines.length) {
              linesSummary = res.lines.map(l => `• ${l}`).join('\n');
            } else {
              linesSummary = 'Không có dữ liệu chi tiết.';
            }
            const titlePart = res.title ? ` [${res.title}]` : '';
            const summary = `Stats của ${res.player || player}${titlePart}:\n${linesSummary}`;
            results.push({
              type,
              ok: true,
              data: res,
              summary,
            });
          } catch (err) {
            results.push({
              type,
              ok: false,
              summary: `Kiểm tra stats cho ${player} thất bại: ${err.message || err}`,
            });
          }
          break;
        }
        case 'bal': {
          const player = String(act.arg || '').trim();
          if (!player) {
            results.push({ type, ok: false, summary: 'Thiếu tên người chơi cần xem số dư.' });
            break;
          }
          const activeBot = targets.find(b => b.isOnline) || bots.find(b => b.isOnline);
          if (!activeBot) {
            results.push({ type, ok: false, summary: 'Không có bot nào đang online để kiểm tra số dư.' });
            break;
          }
          try {
            const res = typeof activeBot.checkBal === 'function'
              ? await activeBot.checkBal(player, 8000)
              : await activeBot.statsReader.requestBal(player, 8000);

            const summary = `Số dư của ${res.player || player}: ${res.balance || '0'}`;
            results.push({
              type,
              ok: true,
              data: res,
              summary,
            });
          } catch (err) {
            results.push({
              type,
              ok: false,
              summary: `Kiểm tra số dư cho ${player} thất bại: ${err.message || err}`,
            });
          }
          break;
        }
        default:
          results.push({ type, ok: false, summary: `Hành động "${type}" chưa được hỗ trợ.` });
      }
    }

    return results;
  }

  /* ---------------- prompt ---------------- */

  _buildSystemPrompt() {
    const fleet = this._buildFleetSnapshot();
    const lastNames = this._lastTargets.length ? this._lastTargets.join(', ') : '(chưa có)';
    const memoryEntries = [...this._memory.entries()];
    const memoryStr = memoryEntries.length ? memoryEntries.map(([k, v]) => `${k}: ${v}`).join('; ') : '(chưa có)';
    return [
      'Bạn là AI-Anter, trợ lý điều khiển dàn bot Minecraft của hệ thống Antertool. Người vận hành nói tiếng Việt (có thể không dấu, viết tắt).',
      'Nhiệm vụ: hiểu yêu cầu và LẬP KẾ HOẠCH. Trả về DUY NHẤT một JSON hợp lệ, không markdown, theo cấu trúc:',
      '{"reply": "<chỉ để trò chuyện/giải thích, để rỗng nếu có action>", "actions": [{"type": "<loại>", "targets": ["<bot_id|số thứ tự|all>"], "arg": "<tham số nếu có>"}], "clarify": "<câu hỏi lại nếu thiếu thông tin, nếu không để rỗng>"}',
      'QUY TẮC:',
      '- Hệ thống tự thực thi actions rồi tự báo kết quả thật. KHÔNG được nói "đã xong/đã làm" trong "reply".',
      '- "targets": mảng id bot hoặc số thứ tự (1-based). Chỉ dùng ["all"] khi người dùng nói rõ "tất cả/cả dàn".',
      '- Câu có nhiều thao tác => nhiều phần tử trong "actions", đúng thứ tự.',
      '- Thiếu bot mục tiêu cho stop/reconnect/cmd/macro/stop_macro khi có nhiều bot => actions rỗng + "clarify" hỏi lại. Tuyệt đối không tự đoán "tất cả".',
      '- "bot đó", "con đó", "nó", "hắn", "em nó", "như cũ" = bot được nhắc ở lượt trước.',
      '- Luôn duy trì bộ nhớ ngữ cảnh từ các lượt hội thoại trước trong lịch sử trò chuyện (tên người dùng, bot đang được trao đổi, câu hỏi trước). Trả lời tiếp nối một cách tự nhiên.',
      '- Các tin nhắn trước của assistant trong lịch sử hội thoại có thể là câu trả lời tiếng Việt cho người dùng (ví dụ: "AI-Anter: Đã nhận..."). Bạn vẫn luôn trả về DUY NHẤT một JSON hợp lệ để lập kế hoạch hoặc trò chuyện.',
      '- Câu hỏi nguyên nhân/tình trạng ("sao bot 2 treo?", "doanh thu thế nào?") => dùng "logs" hoặc "status" để lấy dữ liệu thật; hệ thống sẽ diễn giải sau.',
      '- Trò chuyện thường (không liên quan điều khiển) => actions rỗng, trả lời ngắn trong "reply".',
      '- TUYỆT ĐỐI không gửi lệnh login/register/changepassword/pay.',
      'Danh sách type hợp lệ:',
      '- "start": khởi động bot',
      '- "stop": dừng/tắt bot',
      '- "reconnect": kết nối lại bot',
      '- "sell_on": bật autosell_spawn (bán lồng)',
      '- "sell_off": tắt autosell_spawn',
      '- "sell_now": bán lồng ngay 1 vòng',
      '- "protect_on": bật spawnerprotect',
      '- "protect_off": tắt spawnerprotect',
      '- "afk_jump": bật AFK nhảy',
      '- "afk_walk": bật AFK đi bộ',
      '- "afk_stop": dừng AFK',
      '- "home": cho bot về /home treolong',
      '- "macro": chạy macro (tên macro ở "arg")',
      '- "stop_macro": dừng macro',
      '- "cmd": gửi lệnh bot (lệnh ở "arg")',
      '- "logs": lấy log hoạt động gần nhất của bot',
      '- "status": lấy trạng thái dàn bot',
      '- "inv": kiểm tra túi đồ (vật phẩm, số ô trống)',
      '- "pos": xem toạ độ vị trí hiện tại (x, y, z)',
      '- "activity": xem hoạt động hiện tại (đang làm gì)',
      '- "ping": kiểm tra độ trễ mạng (ping ms)',
      '- "chat": gửi tin nhắn chat trong game Minecraft (nội dung ở "arg")',
      '- "checkstats": kiểm tra thống kê stats của người chơi (tên người chơi ở "arg")',
      '- "bal": xem số dư/tiền của người chơi (tên người chơi ở "arg")',
      'VÍ DỤ:',
      'U: khởi động 2 bot số 1 và 2 => {"reply":"","actions":[{"type":"start","targets":["1","2"]}],"clarify":""}',
      'U: bat ban long bot 1 roi bao ve long luon => {"reply":"","actions":[{"type":"sell_on","targets":["1"]},{"type":"protect_on","targets":["1"]}],"clarify":""}',
      'U: xem túi đồ bot 1 => {"reply":"","actions":[{"type":"inv","targets":["1"]}],"clarify":""}',
      'U: check stats Steve => {"reply":"","actions":[{"type":"checkstats","arg":"Steve"}],"clarify":""}',
      'U: xem tiền của Alex => {"reply":"","actions":[{"type":"bal","arg":"Alex"}],"clarify":""}',
      'U: Steve có bao nhiêu tiền => {"reply":"","actions":[{"type":"bal","arg":"Steve"}],"clarify":""}',
      'U: bot 2 đang ở đâu => {"reply":"","actions":[{"type":"pos","targets":["2"]}],"clarify":""}',
      'U: bot 1 đang làm gì => {"reply":"","actions":[{"type":"activity","targets":["1"]}],"clarify":""}',
      'U: kiểm tra ping các bot => {"reply":"","actions":[{"type":"ping","targets":["all"]}],"clarify":""}',
      'U: bảo bot 1 chat xin chào => {"reply":"","actions":[{"type":"chat","targets":["1"],"arg":"xin chào"}],"clarify":""}',
      'U: tắt bot đi (có nhiều bot) => {"reply":"","actions":[],"clarify":"Bạn muốn tắt bot nào? (số thứ tự/id hoặc tất cả)"}',
      'U: sao bot 2 treo vậy? => {"reply":"","actions":[{"type":"logs","targets":["2"]}],"clarify":""}',
      'U: chạy macro farm cho tất cả => {"reply":"","actions":[{"type":"macro","targets":["all"],"arg":"farm"}],"clarify":""}',
      'U: gửi lệnh /sethome cho bot 2 => {"reply":"","actions":[{"type":"cmd","targets":["2"],"arg":"/sethome"}],"clarify":""}',
      'U: doanh thu hôm nay sao rồi => {"reply":"","actions":[{"type":"status","targets":["all"]}],"clarify":""}',
      'U: bạn khoẻ không => {"reply":"AI-Anter: Mình khoẻ, sẵn sàng điều khiển dàn bot cho bạn!","actions":[],"clarify":""}',
      `Thông tin ghi nhớ dài hạn (user memory): ${memoryStr}`,
      `Bot được nhắc gần nhất: ${lastNames}`,
      `Danh sách bot hiện tại (index 1-based): ${JSON.stringify(fleet)}`,
    ].join('\n');
  }

  _buildNarrationPrompt() {
    return [
      'Bạn là AI-Anter, trợ lý điều khiển dàn bot Minecraft (Antertool).',
      'Bên dưới là KẾT QUẢ THỰC TẾ vừa thực thi. Hãy trả lời người vận hành bằng tiếng Việt, ngắn gọn (tối đa khoảng 6 dòng), bắt đầu bằng "AI-Anter:".',
      'Chỉ dùng số liệu có trong kết quả, không bịa. Thao tác lỗi (ok=false) phải nói rõ.',
      'Với kết quả stats hoặc số dư (checkstats/bal), trình bày rõ ràng, thân thiện với các chỉ số quan trọng.',
      'Nếu người dùng hỏi nguyên nhân/vì sao, hãy suy luận từ log và nói rõ đó là suy đoán. Không trả về JSON.',
      'Bạn có thể tham khảo ngữ cảnh hội thoại trước đó để câu trả lời tự nhiên, liền mạch.',
    ].join('\n');
  }

  /* ---------------- HTTP / LLM ---------------- */

  _defaultHttpPost(urlStr, headers, bodyObj, timeoutMs) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (e) {
        return reject(new Error(`URL OmniRouter không hợp lệ: ${urlStr}`));
      }
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');

      const req = lib.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            ...headers,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            resolve({ statusCode: res.statusCode || 0, body: raw });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`OmniRouter timeout sau ${timeoutMs}ms`));
      });
      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  /**
   * Gọi chat/completions. Tự động:
   *  - thử response_format json_object, nếu router/model không hỗ trợ thì tắt và gọi lại;
   *  - thử lại 1 lần khi lỗi mạng / 429 / 5xx.
   */
  async _chat(messages, { json = false, temperature = 0.1 } = {}) {
    const postFn = this._httpPost || this._defaultHttpPost.bind(this);
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    let useJson = Boolean(json && this._jsonMode);
    let attempt = 0;

    for (;;) {
      const body = {
        model: this.model || DEFAULT_MODEL,
        temperature,
        messages,
      };
      if (useJson) body.response_format = { type: 'json_object' };

      let res;
      try {
        res = await postFn(this.endpointUrl, headers, body, this.timeoutMs);
      } catch (err) {
        if (attempt < 1) { attempt++; await sleep(500); continue; }
        throw err;
      }

      if (res.statusCode >= 200 && res.statusCode < 300) {
        let data;
        try {
          data = JSON.parse(res.body);
        } catch {
          throw new Error('Phản hồi từ OmniRouter không phải JSON hợp lệ');
        }
        let content = data?.choices?.[0]?.message?.content;
        if (Array.isArray(content)) content = content.map(c => (typeof c === 'string' ? c : c?.text || '')).join('');
        if (!content || !String(content).trim()) throw new Error('OmniRouter trả về nội dung rỗng');
        return String(content).trim();
      }

      if (useJson && (res.statusCode === 400 || res.statusCode === 422)
        && /response_format|json_object|json mode|json_schema/i.test(String(res.body || ''))) {
        this._jsonMode = false;
        useJson = false;
        continue;
      }
      if ([429, 500, 502, 503, 504].includes(res.statusCode) && attempt < 1) {
        attempt++;
        await sleep(600);
        continue;
      }
      if (res.statusCode === 401) {
        throw new Error('HTTP 401: Khoá API OmniRouter chưa đúng hoặc đã hết hạn (Incorrect API key)');
      }
      throw new Error(`HTTP ${res.statusCode}: ${String(res.body || '').slice(0, 160)}`);
    }
  }

  /** Giữ lại để tương thích code cũ: hỏi 1 câu, nhận về nội dung thô. */
  async _callOmniRouter(userPrompt) {
    return this._chat([
      { role: 'system', content: this._buildSystemPrompt() },
      { role: 'user', content: String(userPrompt || '') },
    ], { json: true });
  }

  _extractJsonPlan(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    const candidate = fenced ? fenced[1].trim() : s;
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        const obj = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
        if (obj && typeof obj === 'object') return obj;
      } catch {
        return null;
      }
    }
    return null;
  }

  async _planWithLlm(rawPrompt, chatId) {
    const messages = [
      { role: 'system', content: this._buildSystemPrompt() },
      ...this._getHistory(chatId),
      { role: 'user', content: rawPrompt },
    ];
    const content = await this._chat(messages, { json: true, temperature: 0.1 });
    return { content, parsed: this._extractJsonPlan(content) };
  }

  /** Gửi KẾT QUẢ THẬT cho LLM để diễn giải thành câu trả lời. */
  async _narrate(rawPrompt, results, chatId = null) {
    let payload = JSON.stringify(results.map(r => ({ type: r.type, ok: r.ok, summary: r.summary, data: r.data })));
    if (payload.length > 6000) payload = payload.slice(0, 6000) + '…(đã cắt bớt)';
    const history = chatId ? this._getHistory(chatId).slice(-6) : [];
    const content = await this._chat([
      { role: 'system', content: this._buildNarrationPrompt() },
      ...history,
      { role: 'user', content: `Yêu cầu của người vận hành: ${rawPrompt}\n\nKết quả thực thi (JSON):\n${payload}` },
    ], { json: false, temperature: 0.3 });
    return content;
  }

  _formatReplyPrefix(replyText) {
    const trimmed = String(replyText || '').trim();
    if (!trimmed) return 'AI-Anter: Đã nhận đang làm.';
    if (/^AI-Anter\s*:/i.test(trimmed)) return trimmed;
    return `AI-Anter: ${trimmed}`;
  }

  _composeReply({ results, llmReply, clarify, apiError, question, softHint }) {
    const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    const okRes = results.filter(r => r.ok);
    const failRes = results.filter(r => !r.ok);
    let reply = '';

    if (okRes.length) {
      const sums = okRes.map(r => r.summary).filter(Boolean);
      const actionable = okRes.some(r => !INFO_TYPES.has(r.type) && r.type !== 'greet');
      const multi = sums.some(s => s.includes('\n')) || sums.length > 3;
      if (actionable) {
        reply = multi
          ? `AI-Anter:\n${sums.map(cap).join('\n')}`
          : `AI-Anter: Đã nhận đang làm — ${sums.join('; ')}.`;
      } else {
        reply = multi || sums.length > 1
          ? `AI-Anter:\n${sums.map(cap).join('\n')}`
          : `AI-Anter: ${cap(sums[0] || '')}`;
      }
    }

    if (failRes.length) {
      const failText = failRes.map(r => `⚠ ${r.summary}`).join('\n');
      reply = reply ? `${reply}\n${failText}` : `AI-Anter:\n${failText}`;
    }

    if (!reply) {
      if (llmReply) reply = this._formatReplyPrefix(llmReply);
      else if (clarify) reply = '';
      else if (softHint) reply = `AI-Anter: ${softHint}`;
      else if (apiError) {
        reply = apiError.includes('401')
          ? 'AI-Anter: Khoá API OmniRouter chưa đúng hoặc đã hết hạn (lỗi 401: Incorrect API key). Bạn vui lòng dùng lệnh: "ai set <omnirouter_api_key>" để cập nhật khoá hợp lệ nhé.'
          : `AI-Anter: Không gọi được OmniRouter (${apiError}) và chưa nhận diện được lệnh tại chỗ.`;
      } else if (!this.hasKey) {
        reply = 'AI-Anter: Chưa nhận diện được lệnh. Bạn có thể đặt khoá OmniRouter bằng "ai set <api_key>" hoặc nói rõ như: "khởi động 2 bot số 1 và 2", "xem log của 2 bot", "trạng thái".';
      } else {
        reply = 'AI-Anter: Đã nhận yêu cầu nhưng không có thao tác bot nào cần thực thi.';
      }
    }

    if (clarify) {
      reply = reply ? `${reply}\n${clarify}` : `AI-Anter: ${clarify}`;
    }
    if (apiError && apiError.includes('401') && reply && !/401/.test(reply)) {
      reply += '\n(Lưu ý: Khoá OmniRouter đang báo lỗi 401 — Incorrect API key. Dùng: "ai set <khoá_mới>" để cập nhật).';
    }
    return reply;
  }

  /* ---------------- điểm vào chính ---------------- */

  /**
   * Nhận câu lệnh từ Dev (VD: "Dev: khởi động 2 bot số 1 và 2").
   * opts: { offline?: boolean, chatId?: string }
   */
  async ask(prompt, opts = {}) {
    const rawPrompt = String(prompt || '').trim();
    if (!rawPrompt) {
      return {
        ok: false,
        via: 'none',
        reply: 'AI-Anter: Vui lòng nhập yêu cầu điều khiển (ví dụ: khởi động 2 bot số 1 và 2).',
        actions: [],
        results: [],
      };
    }

    const chatId = String(opts.chatId || 'default');
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    const botIds = new Set(bots.map(b => b.cfg.id));
    const ctx = {
      lastTargetIds: this._lastTargets.filter(id => botIds.has(id)),
      lastActions: this._lastActions,
    };
    const local = parseNaturalCommand(rawPrompt, bots, ctx);
    const question = QUESTION_RE.test(foldVi(local.cleaned || rawPrompt));
    const llmAllowed = this.hasKey && opts.offline !== true;

    // 1. Kiểm tra hỏi về danh tính / tên người dùng
    const foldedPrompt = foldVi(rawPrompt);
    const asksName = /(?:toi|minh|tao)\s+(?:ten\s+(?:la\s+)?gi|la\s+ai)\b/i.test(foldedPrompt)
      || /\b(ten toi|ten minh)\s+(?:la\s+)?gi\b/i.test(foldedPrompt)
      || /\bco nho toi (?:la ai|ten gi)\b/i.test(foldedPrompt);

    if (asksName && !local.actions.length) {
      const savedName = this._memory.get('user_name');
      const memReply = savedName
        ? `AI-Anter: Bạn là ${savedName}! Mình luôn ghi nhớ bạn mà.`
        : 'AI-Anter: Bạn chưa cho mình biết tên. Bạn có thể nói "tôi tên là..." để mình ghi nhớ nhé!';
      this._pushHistory(chatId, 'user', rawPrompt);
      this._pushHistory(chatId, 'assistant', memReply);
      return {
        ok: true,
        via: 'local',
        reply: memReply,
        actions: [],
        results: [],
      };
    }

    // 2. Nhận diện ghi nhớ tên người dùng ("mình tên là Tuấn", "tôi tên là Nam")
    const nameIntroMatch = /(?:t[oô]i|m[iì]nh|tao|anh|ch[iị]|em)\s+t[eê]n\s+(?:l[aà]\s+)?([\p{L}\p{N}_]+(?:\s+[\p{L}\p{N}_]+)*)/iu.exec(rawPrompt)
      || /(?:t[eê]n\s+(?:c[uủ]a\s+)?(?:t[oô]i|m[iì]nh|tao)\s+l[aà]\s+)([\p{L}\p{N}_]+(?:\s+[\p{L}\p{N}_]+)*)/iu.exec(rawPrompt)
      || /(?:g[oọ]i\s+(?:t[oô]i|m[iì]nh)\s+l[aà]\s+)([\p{L}\p{N}_]+(?:\s+[\p{L}\p{N}_]+)*)/iu.exec(rawPrompt);

    if (nameIntroMatch && !local.actions.length) {
      const detectedName = nameIntroMatch[1].replace(/[.,!?;:]/g, '').trim();
      const foldName = foldVi(detectedName);
      if (detectedName && !/^(la|gi|ai|chua|nao|sao|the|khong)$/i.test(foldName)) {
        this._memory.set('user_name', detectedName);
        this.flushHistoryToDisk();
        const memReply = `AI-Anter: Chào ${detectedName}! Mình đã ghi nhớ tên của bạn rồi nhé.`;
        this._pushHistory(chatId, 'user', rawPrompt);
        this._pushHistory(chatId, 'assistant', memReply);
        return {
          ok: true,
          via: 'local',
          reply: memReply,
          actions: [],
          results: [],
        };
      }
    }

    let actions = [];
    let pending = [];
    let clarify = '';
    let llmReply = '';
    let softHint = '';
    let via = 'local';
    let apiError = null;
    const rejected = [];

    // A. Người dùng đang trả lời câu hỏi "bot nào?" trước đó
    if (this._pending && Date.now() - this._pending.ts <= PENDING_TTL_MS && !local.actions.length && !local.clarify) {
      const t = resolveTargetBots(local.cleaned || rawPrompt, bots);
      if (t.length) {
        actions = this._pending.actions.map(a => ({ ...a, targets: t.map(b => b.cfg.id) }));
      }
    }

    // B. "làm lại đi"
    if (!actions.length && local.repeatLast && this._lastActions.length) {
      actions = this._lastActions.map(a => ({ ...a }));
    }

    // C. Local hiểu chắc chắn => chạy luôn, không gọi API
    const infoOnly = local.actions.length > 0 && local.actions.every(a => INFO_TYPES.has(a.type) || a.type === 'greet');
    const localConfident = local.actions.length > 0 && (!question || infoOnly || local.followUp);
    if (!actions.length && localConfident) {
      actions = local.actions;
      pending = local.pendingActions || [];
      clarify = local.clarify || '';
    } else if (!actions.length && local.clarify && !question) {
      pending = local.pendingActions || [];
      clarify = local.clarify;
    }

    // D. Local không hiểu / câu hỏi mở => nhờ LLM lập kế hoạch
    if (!actions.length && !clarify) {
      if (llmAllowed) {
        try {
          const { parsed, content } = await this._planWithLlm(rawPrompt, chatId);
          via = 'omnirouter';
          if (parsed) {
            const v = this._validateActions(parsed.actions);
            actions = v.valid;
            pending = v.pending;
            rejected.push(...v.rejected);
            if (typeof parsed.clarify === 'string' && parsed.clarify.trim()) clarify = parsed.clarify.trim();
            else if (pending.length) clarify = buildClarifyQuestion(pending, bots);
            if (typeof parsed.reply === 'string' && parsed.reply.trim()) llmReply = parsed.reply.trim();
          } else {
            llmReply = content;
          }
        } catch (err) {
          apiError = err.message || String(err);
        }
      } else if (local.actions.length && question) {
        softHint = 'Câu này giống một câu hỏi nên mình chưa thực thi. Bạn nói rõ lệnh giúp mình nhé (ví dụ: "khởi động bot 1", "tắt bot 2").';
      }
    }

    // E. Thực thi + ghi nhận kết quả thật
    const results = actions.length > 0 ? await this.executeActions(actions) : [];
    for (const msg of rejected) results.push({ type: 'invalid', ok: false, summary: msg });

    // Cập nhật bot mục tiêu gần nhất từ tất cả hành động có target (cả info lẫn control)
    const targeted = actions.filter(a => a.type !== 'greet');
    if (targeted.length) {
      const ids = new Set();
      for (const a of targeted) {
        for (const b of this._resolveActionTargets(a.targets)) {
          if (b?.cfg?.id) ids.add(b.cfg.id);
        }
      }
      if (ids.size) {
        this._lastTargets = [...ids];
      }
      this._lastActions = targeted.map(a => ({ ...a }));
      this._saveHistoryToDisk();
    }
    this._pending = pending.length ? { actions: pending, ts: Date.now() } : null;

    // F. Báo cáo: log/trạng thái được gửi lại LLM để diễn giải dựa trên dữ liệu thật
    let reply = '';
    const hasInfo = results.some(r => r.ok && INFO_TYPES.has(r.type));
    if (hasInfo && llmAllowed && (via === 'omnirouter' || question)) {
      try {
        const text = await this._narrate(rawPrompt, results, chatId);
        if (text) {
          reply = this._formatReplyPrefix(text);
          via = 'omnirouter';
          const fails = results.filter(r => !r.ok);
          if (fails.length) reply += `\n${fails.map(r => `⚠ ${r.summary}`).join('\n')}`;
          if (clarify) reply += `\n${clarify}`;
        }
      } catch (err) {
        apiError = apiError || err.message || String(err);
      }
    }
    if (!reply) {
      reply = this._composeReply({ results, llmReply, clarify, apiError, question, softHint });
    }

    this._pushHistory(chatId, 'user', local.cleaned || rawPrompt);
    this._pushHistory(chatId, 'assistant', reply);

    try {
      this.mgr?.runtimeLog?.('sys', `[AI-Anter via ${via}] ${rawPrompt} -> ${reply}`);
    } catch { /* ignore */ }

    return {
      ok: results.some(r => r.ok) || via === 'omnirouter' || Boolean(clarify),
      via,
      apiError,
      reply,
      actions,
      results,
      clarify: clarify || undefined,
    };
  }

  /**
   * Kiểm tra nhanh kết nối tới OmniRouter API (gọi thẳng API, không đi qua parser tại chỗ).
   */
  async testConnection() {
    if (!this.hasKey) {
      return { ok: false, message: 'Chưa cấu hình khoá API OmniRouter (dùng: ai set <api_key> [base_url] [model])' };
    }
    try {
      const reply = await this._chat(
        [{ role: 'user', content: 'Trả lời đúng một từ: OK' }],
        { json: false, temperature: 0 }
      );
      return {
        ok: true,
        message: `Kết nối OmniRouter thành công (${this.endpointUrl} · model ${this.model})`,
        reply,
      };
    } catch (e) {
      return { ok: false, message: `Lỗi kết nối OmniRouter: ${e.message || e}` };
    }
  }
}

AiController.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
AiController.DEFAULT_MODEL = DEFAULT_MODEL;
AiController.parseNaturalCommand = parseNaturalCommand;
AiController.resolveTargetBots = resolveTargetBots;
AiController.buildChatCompletionsUrl = buildChatCompletionsUrl;
AiController.splitSegments = splitSegments;
AiController.normalizeIntent = normalizeIntent;

module.exports = AiController;
