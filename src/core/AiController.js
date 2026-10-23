'use strict';
/**
 * AiController.js — Điều phối AI-Anter tích hợp OmniRouter API (OpenAI-compatible /v1/chat/completions)
 * kết hợp bộ phân tích ngôn ngữ tự nhiên tiếng Việt tại chỗ (fallback & thực thi lệnh).
 *
 * Ví dụ:
 *   Dev: khởi động 2 bot số 1 và 2
 *   AI-Anter: Đã nhận đang làm — đang khởi động 2 bot: bot-1 (#1), bot-2 (#2).
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { DEFAULT_CMD_DENYLIST } = require('./ConfigValidator');
const { maskSecret } = require('../ui/text');

const DEFAULT_BASE_URL = 'https://omnirouter.li/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 15000;

function foldVi(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
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

/**
 * Tìm danh sách bot mục tiêu từ câu lệnh tiếng Việt / tiếng Anh.
 * Hỗ trợ:
 *  - "tất cả", "toàn bộ", "cả dàn", "all"
 *  - "2 bot số 1 và 2", "bot số 1, 2", "bot 1 và 3", "bot 1-3"
 *  - tên định danh trực tiếp ("bot-1", "acc2")
 */
function resolveTargetBots(text, bots = []) {
  if (!Array.isArray(bots) || !bots.length) return [];
  const raw = String(text || '').trim();
  const folded = foldVi(raw);

  if (/\b(tat ca|toan bo|ca dan|het tat ca|all)\b/.test(folded)) {
    return [...bots];
  }

  const picked = [];
  const seen = new Set();
  const addBot = (b) => {
    if (b && !seen.has(b.cfg.id)) {
      seen.add(b.cfg.id);
      picked.push(b);
    }
  };

  // 1. Khớp tên ID bot xuất hiện trực tiếp trong câu
  const lower = raw.toLowerCase();
  for (const b of bots) {
    const id = String(b.cfg?.id || '').toLowerCase();
    if (!id) continue;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-z0-9_-])${esc}(?![a-z0-9_-])`, 'i');
    if (re.test(lower)) addBot(b);
  }

  // 2. Khớp cụm chỉ định bot theo số thứ tự:
  //    Ví dụ: "khởi động 2 bot số 1 và 2" -> bỏ số lượng "2" trước chữ "bot", lấy "1 và 2" sau chữ "bot"/"số"
  let targetSegment = folded;
  const afterBotMatch = /\b(?:\d+\s+)?bots?\s+(?:so\s+|thu\s+|#)?([0-9,\s]+(?:(?:va|&|voi|den|toi|-)\s*[0-9,\s]+)*)/.exec(folded);
  const afterSoMatch = /\b(?:so|thu|#)\s*([0-9,\s]+(?:(?:va|&|voi|den|toi|-)\s*[0-9,\s]+)*)/.exec(folded);
  if (afterBotMatch) {
    targetSegment = afterBotMatch[1];
  } else if (afterSoMatch) {
    targetSegment = afterSoMatch[1];
  }

  // Hỗ trợ dải số: "1-3" hoặc "1 den 3" / "1 toi 3"
  const rangeRe = /\b(\d+)\s*(?:-|den|toi)\s*(\d+)\b/g;
  for (const m of targetSegment.matchAll(rangeRe)) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      for (let idx = start; idx <= end; idx++) {
        if (idx >= 1 && idx <= bots.length) addBot(bots[idx - 1]);
      }
    }
  }

  // Các số thứ tự rời rạc trong cụm target
  if (afterBotMatch || afterSoMatch) {
    const numRe = /\b(\d+)\b/g;
    for (const m of targetSegment.matchAll(numRe)) {
      const idx = parseInt(m[1], 10);
      if (idx >= 1 && idx <= bots.length) addBot(bots[idx - 1]);
    }
  } else if (picked.length === 0) {
    // Nếu người dùng viết "khởi động 1 và 2" (không có chữ bot)
    const fallbackNums = [...folded.matchAll(/\b(\d+)\b/g)].map(m => parseInt(m[1], 10));
    for (const idx of fallbackNums) {
      if (idx >= 1 && idx <= bots.length) addBot(bots[idx - 1]);
    }
  }

  return picked;
}

/**
 * Phân tích câu lệnh tự nhiên tiếng Việt / tiếng Anh sang danh sách hành động chuẩn.
 */
function parseNaturalCommand(rawInput, bots = []) {
  const cleaned = String(rawInput || '')
    .trim()
    .replace(/^(?:dev|operator|admin|user)\s*:\s*/i, '')
    .replace(/^\/?ai\s+/i, '')
    .trim();

  if (!cleaned) {
    return { actions: [], cleaned: '' };
  }

  const folded = foldVi(cleaned);
  const targets = resolveTargetBots(cleaned, bots);
  const targetIds = targets.map(b => b.cfg.id);

  // 1. Bật/tắt/chạy ngay autosell_spawn (bán lồng)
  if (/\b(autosell_spawn|autosell|ban long|auto sell|tu ban)\b/.test(folded) || /\b(bat|tat|dung)\s+ban\b/.test(folded) || /\bban\s+ngay\b/.test(folded)) {
    let type = 'sell_on';
    if (/\b(tat(?!\s+ca\b)|dung|off|stop)\b/.test(folded) && !/\btắt\s+cả\b/i.test(cleaned)) type = 'sell_off';
    else if (/\b(ngay|now|1 vong)\b/.test(folded)) type = 'sell_now';
    return {
      cleaned,
      actions: [{ type, targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 2. Bảo vệ lồng (spawnerprotect)
  if (/\b(spawnerprotect|protect|bao ve long|canh long)\b/.test(folded)) {
    const type = /\b(tat(?!\s+ca\b)|dung|off|stop)\b/.test(folded) ? 'protect_off' : 'protect_on';
    return {
      cleaned,
      actions: [{ type, targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 3. AFK
  if (/\b(wafk|afk)\b/.test(folded)) {
    let type = 'afk_jump';
    if (/\b(tat(?!\s+ca\b)|dung|off|stop|nghi)\b/.test(folded)) type = 'afk_stop';
    else if (/\b(wafk|di bo|walk)\b/.test(folded)) type = 'afk_walk';
    return {
      cleaned,
      actions: [{ type, targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 4. Về home / vị trí treo lồng
  if (/\b(ve home|spawnhome|\/home|quay ve home)\b/.test(folded)) {
    return {
      cleaned,
      actions: [{ type: 'home', targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 5. Macro
  const macroMatch = /\b(?:dung|tat|stop)\s+macro\b/i.exec(folded);
  if (macroMatch) {
    return {
      cleaned,
      actions: [{ type: 'stop_macro', targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }
  const runMacroMatch = /\b(?:chay\s+macro|macro)\s+([a-zA-Z0-9_-]+)/i.exec(folded);
  if (runMacroMatch) {
    return {
      cleaned,
      actions: [{ type: 'macro', arg: runMacroMatch[1], targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 6. Kết nối lại (reconnect)
  if (/\b(reconnect|ket noi lai|vao lai|relog|khoi dong lai|restart)\b/.test(folded)) {
    return {
      cleaned,
      actions: [{ type: 'reconnect', targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 7. Khởi động bot (start)
  if (/\b(khoi dong|bat|chay|start|login|vao server|log in)\b/.test(folded)) {
    return {
      cleaned,
      actions: [{ type: 'start', targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 8. Dừng / tắt bot (stop)
  if (/\b(dung|tat(?!\s+ca\b)|ngat|stop|out|disconnect|nghi)\b/.test(folded)) {
    return {
      cleaned,
      actions: [{ type: 'stop', targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 9. Gửi lệnh raw/chat
  const cmdMatch = /(?:gui lenh|go lenh|chat|lenh)\s+["'`]?([^"'`]+)["'`]?$/i.exec(cleaned);
  if (cmdMatch) {
    return {
      cleaned,
      actions: [{ type: 'cmd', arg: cmdMatch[1].trim(), targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  // 10. Xem trạng thái / báo cáo
  if (/\b(trang thai|status|tinh hinh|bao cao|doanh thu|kiem tra|danh sach)\b/.test(folded)) {
    return {
      cleaned,
      actions: [{ type: 'status', targets: targetIds.length ? targetIds : bots.map(b => b.cfg.id) }],
    };
  }

  return { actions: [], cleaned };
}

class AiController {
  constructor(manager, opts = {}) {
    this.mgr = manager;
    this.apiKey = '';
    this.baseUrl = DEFAULT_BASE_URL;
    this.model = DEFAULT_MODEL;
    this.timeoutMs = DEFAULT_TIMEOUT_MS;
    this._httpPost = opts.httpPost || null; // cho phép inject mock trong unit test
    this.configure(opts);
  }

  configure(opts = {}) {
    if (opts.apiKey !== undefined) {
      this.apiKey = opts.apiKey ? String(opts.apiKey).trim() : '';
    }
    if (opts.baseUrl !== undefined) {
      this.baseUrl = opts.baseUrl ? String(opts.baseUrl).trim() : DEFAULT_BASE_URL;
    }
    if (opts.model !== undefined) {
      this.model = opts.model ? String(opts.model).trim() : DEFAULT_MODEL;
    }
    if (opts.timeoutMs !== undefined && Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) >= 1000) {
      this.timeoutMs = Number(opts.timeoutMs);
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
    };
  }

  /**
   * Tóm tắt trạng thái dàn bot để đưa vào context cho OmniRouter AI.
   */
  _buildFleetSnapshot() {
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    return bots.map((b, i) => ({
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
    }));
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

  /**
   * Thực thi danh sách hành động điều khiển bot và trả về kết quả chi tiết.
   */
  executeActions(actions = []) {
    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    const results = [];
    const indexMap = new Map(bots.map((b, i) => [b.cfg.id, i + 1]));
    const fmtBot = (b) => `${b.cfg.id} (#${indexMap.get(b.cfg.id) || '?'})`;

    for (const act of actions) {
      if (!act || typeof act !== 'object') continue;
      const type = String(act.type || '').toLowerCase().trim();
      const targets = this._resolveActionTargets(act.targets);

      if (!targets.length && type !== 'status') {
        results.push({ type, ok: false, summary: 'Không tìm thấy bot phù hợp để thực hiện.' });
        continue;
      }

      switch (type) {
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
          const detail = snap.map(s => `#${s.index} ${s.id} (${s.state}${s.sellOn ? ', đang bán lồng' : ''})`).join(', ');
          results.push({
            type,
            ok: true,
            summary: `hiện có ${onlineCount}/${snap.length} bot đang ONLINE${detail ? ': ' + detail : ''}`,
          });
          break;
        }
        default:
          results.push({ type, ok: false, summary: `Hành động "${type}" chưa được hỗ trợ.` });
      }
    }

    return results;
  }

  _buildSystemPrompt() {
    const fleet = this._buildFleetSnapshot();
    return [
      'Bạn là AI-Anter, trợ lý điều khiển dàn bot Minecraft của hệ thống Antertool.',
      'Khi người vận hành (Dev) yêu cầu điều khiển hoặc kiểm tra bot, hãy trả về DUY NHẤT một JSON hợp lệ theo cấu trúc:',
      '{"reply": "AI-Anter: Đã nhận đang làm — <mô tả ngắn gọn tiếng Việt>", "actions": [{"type": "<loại_lệnh>", "targets": ["<bot_id_hoặc_số_thứ_tự>"], "arg": "<tham_số_nếu_có>"}]}',
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
      '- "macro": chạy macro (đặt tên macro ở "arg")',
      '- "stop_macro": dừng macro',
      '- "cmd": gửi lệnh bot (đặt lệnh ở "arg", KHÔNG gửi lệnh login/register/pay)',
      '- "status": xem trạng thái dàn bot',
      `Danh sách bot hiện tại (index 1-based): ${JSON.stringify(fleet)}`,
    ].join('\n');
  }

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

  async _callOmniRouter(userPrompt) {
    const postFn = this._httpPost || this._defaultHttpPost.bind(this);
    const body = {
      model: this.model || DEFAULT_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: this._buildSystemPrompt() },
        { role: 'user', content: String(userPrompt || '') },
      ],
    };
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    const res = await postFn(this.endpointUrl, headers, body, this.timeoutMs);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}: ${String(res.body || '').slice(0, 200)}`);
    }
    let data;
    try {
      data = JSON.parse(res.body);
    } catch {
      throw new Error('Phản hồi từ OmniRouter không phải JSON hợp lệ');
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OmniRouter trả về nội dung rỗng');
    }
    return String(content).trim();
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

  _formatReplyPrefix(replyText) {
    const trimmed = String(replyText || '').trim();
    if (!trimmed) return 'AI-Anter: Đã nhận đang làm.';
    if (/^AI-Anter\s*:/i.test(trimmed)) return trimmed;
    return `AI-Anter: ${trimmed}`;
  }

  /**
   * Nhận câu lệnh từ Dev (VD: "Dev: khởi động 2 bot số 1 và 2"),
   * gọi OmniRouter (nếu đã cấu hình API key) + kết hợp bộ phân tích tại chỗ,
   * thực thi hành động trên dàn bot và trả về câu trả lời của AI-Anter.
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

    const bots = Array.isArray(this.mgr?.bots) ? this.mgr.bots : [];
    const localPlan = parseNaturalCommand(rawPrompt, bots);
    let actions = localPlan.actions;
    let llmReply = '';
    let via = 'local';
    let apiError = null;

    if (this.hasKey && opts.offline !== true) {
      try {
        const rawContent = await this._callOmniRouter(rawPrompt);
        const parsed = this._extractJsonPlan(rawContent);
        if (parsed) {
          if (Array.isArray(parsed.actions) && parsed.actions.length > 0) {
            actions = parsed.actions;
          }
          if (typeof parsed.reply === 'string' && parsed.reply.trim()) {
            llmReply = parsed.reply.trim();
          }
        } else {
          llmReply = rawContent;
        }
        via = 'omnirouter';
      } catch (err) {
        apiError = err.message || String(err);
      }
    }

    const results = actions.length > 0 ? this.executeActions(actions) : [];
    const summaries = results.map(r => r.summary).filter(Boolean);

    let reply;
    if (llmReply) {
      reply = this._formatReplyPrefix(llmReply);
      if (summaries.length && !summaries.some(s => reply.toLowerCase().includes(s.slice(0, 12).toLowerCase()))) {
        reply = `${reply} (${summaries.join('; ')})`;
      }
    } else if (summaries.length > 0) {
      reply = `AI-Anter: Đã nhận đang làm — ${summaries.join('; ')}.`;
    } else if (apiError) {
      reply = `AI-Anter: Không gọi được OmniRouter (${apiError}) và chưa nhận diện được lệnh tại chỗ.`;
    } else if (!this.hasKey) {
      reply = 'AI-Anter: Chưa nhận diện được lệnh. Bạn có thể đặt khoá OmniRouter bằng "ai set <api_key>" hoặc nói rõ như: "khởi động 2 bot số 1 và 2".';
    } else {
      reply = 'AI-Anter: Đã nhận yêu cầu nhưng không có thao tác bot nào cần thực thi.';
    }

    try {
      this.mgr?.runtimeLog?.('sys', `[AI-Anter via ${via}] ${rawPrompt} -> ${reply}`);
    } catch { /* ignore */ }

    return {
      ok: results.length > 0 || via === 'omnirouter',
      via,
      apiError,
      reply,
      actions,
      results,
    };
  }

  /**
   * Kiểm tra nhanh kết nối tới OmniRouter API.
   */
  async testConnection() {
    if (!this.hasKey) {
      return { ok: false, message: 'Chưa cấu hình khoá API OmniRouter (dùng: ai set <api_key> [base_url] [model])' };
    }
    try {
      const res = await this.ask('Kiểm tra trạng thái dàn bot', { offline: false });
      if (res.apiError) {
        return { ok: false, message: `Lỗi kết nối OmniRouter: ${res.apiError}` };
      }
      return {
        ok: true,
        message: `Kết nối OmniRouter thành công (${this.endpointUrl} · model ${this.model})`,
        reply: res.reply,
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

module.exports = AiController;