'use strict';
const EventEmitter = require('events');
/**
 * MacroEngine — chạy các kịch bản (macro) gồm nhiều bước tuần tự:
 *   chat <lệnh MC>             gửi chat/lệnh
 *   delay <ms>                  chờ N mili-giây
 *   winclick <slot> <button>    click vào ô inventory/GUI đang mở (0-based),
 *                                button: 0 = trái, 1 = phải. slot có thể
 *                                dùng biến $answer (xem "ask"/"askmap")
 *   waitmsg [timeoutMs] <chữ>   chờ tới khi có tin nhắn/chat chứa đúng đoạn
 *                                chữ đó mới chạy bước tiếp theo (mặc định
 *                                chờ tối đa 15000ms, hết giờ thì chạy tiếp)
 *   stopif <chữ>                nếu (vài) dòng chat GẦN ĐÂY chứa đoạn chữ
 *                                này thì dừng macro ngay — dùng để tránh
 *                                bấm mua lặp lại vô ích khi đã biết chắc
 *                                sẽ thất bại (vd "stopif Bạn cần có")
 *   ask <câu hỏi>                dừng macro lại, hỏi và CHỜ người dùng trả
 *                                lời bằng lệnh "answer <nội dung>". Câu trả
 *                                lời được lưu vào biến $answer để dùng ở
 *                                các bước sau (vd winclick $answer 1). Hết
 *                                thời gian chờ (mặc định 120s) thì huỷ macro.
 *   askmap <câu hỏi> || nhãn1=giá_trị1,nhãn2=giá_trị2,...
 *                                giống "ask" nhưng đối chiếu câu trả lời với
 *                                bảng nhãn->giá_trị (không phân biệt hoa
 *                                thường), lưu GIÁ TRỊ khớp được vào $answer.
 *                                Trả lời không khớp nhãn nào -> huỷ macro.
 *                                Dùng để hỏi "mua loại lồng nào" rồi tự map
 *                                sang đúng slot cần click.
 *   askmenu <tiêu đề> || NHÓM: số=nhãn,... || NHÓM2: số=nhãn,...
 *                                hiện BẢNG lựa chọn theo nhóm, người dùng chỉ
 *                                cần gõ SỐ (hoặc tên) qua "answer". Lưu vào
 *                                $answer (số), $label (tên), $group (nhóm).
 *                                Gõ sai thì được hỏi lại (tối đa 3 lần).
 *   waitmsg! [timeoutMs] <chữ>  như waitmsg nhưng hết giờ mà KHÔNG thấy thì
 *                                DỪNG macro (không chạy next).
 *   confirm <câu hỏi>            hỏi có/không, chỉ tiếp tục nếu người dùng
 *                                trả lời có (yes/y/co/có/ok/đồng ý/xác nhận)
 *                                — dùng để chặn lại trước bước bấm mua thật.
 *
 * Macro được khai báo trong config.json, mục "macros":
 *   "macros": {
 *     "ten_macro": {
 *       "next": "ten_macro_ke_tiep",   // optional — tự chạy tiếp khi xong
 *       "steps": "chat /shop\ndelay 1000\nwinclick 15 1"
 *     }
 *   }
 *
 * Biến có sẵn: $owner (chủ bot), $bot (tên bot).
 * Dùng qua CLI/web (giống các lệnh khác): cmd <id> macro <ten_macro>
 * Trả lời câu hỏi đang chờ: cmd <id> answer <nội dung>
 * Dừng giữa chừng: cmd <id> stopmacro — ngắt ngay cả khi đang ở giữa
 * bước "delay"/"waitmsg"/"ask", không cần chờ bước đó tự hết giờ.
 */
class MacroEngine {
  constructor(bot) {
    this.bot = bot;
    this._running = false;
    this._stopRequested = false;
    this._currentMacro = null;
    this._stopEmitter = new EventEmitter();
    this._stopEmitter.setMaxListeners(0);
    this._vars = {};
    this._pendingAsk = null;
  }

  _getMacro(name) {
    const key = String(name || '').trim().toLowerCase();
    const all = this.bot.cfg.macros || {};
    // không phân biệt hoa/thường; nếu không khớp y hệt thì thử bỏ dấu _ - và
    // khoảng trắng (vd gõ "Tpa_Owner" hay "tpaowner" đều ra macro tpa_owner)
    const squash = v => String(v).toLowerCase().replace(/[\s_\-]+/g, '');
    const foundKey = Object.keys(all).find(k => k.toLowerCase() === key)
      || Object.keys(all).find(k => squash(k) === squash(key));
    return foundKey ? all[foundKey] : null;
  }

  list() {
    return Object.keys(this.bot.cfg.macros || {});
  }

  get running() { return this._running; }
  get currentMacro() { return this._currentMacro; }

  stop() {
    if (!this._running) return false;
    this._stopRequested = true;
    this._stopEmitter.emit('stop');
    return true;
  }

  // Trả lời 1 câu hỏi "ask"/"askmap"/"confirm" đang chờ. Trả về true nếu có
  // câu hỏi đang chờ và đã nhận được trả lời, false nếu không có gì đang chờ.
  answer(text) {
    if (!this._pendingAsk) return false;
    const resolve = this._pendingAsk.resolve;
    this._pendingAsk = null;
    resolve(String(text ?? ''));
    return true;
  }
  get hasPendingQuestion() { return !!this._pendingAsk; }
  get pendingQuestion() { return this._pendingAsk ? this._pendingAsk.question : null; }

  async run(name, depth = 0) {
    if (depth > 20) {
      this.bot.log('err', 'Macro: chuỗi "next" quá sâu (>20) — dừng để tránh lặp vô hạn');
      return false;
    }
    const macro = this._getMacro(name);
    if (!macro) {
      this.bot.log('warn', `Macro "${name}" không tồn tại — kiểm tra config.json > macros`);
      return false;
    }
    // Vòng auto-sell spawn đang điều khiển GUI -> yêu cầu nó dừng rồi chờ (tối đa 8s) trước khi macro chạy
    if (this.bot._sellSpawnBusy) {
      this.bot._sellSpawnAbort = true;
      const t0 = Date.now();
      while (this.bot._sellSpawnBusy && Date.now() - t0 < 8000) await new Promise(r => setTimeout(r, 200));
    }
    if (this._running) {
      this.bot.log('warn', `Macro khác đang chạy ("${this._currentMacro}") — bỏ qua "${name}"`);
      return false;
    }
    if (!this.bot.isOnline) {
      this.bot.log('warn', `Bot offline — không thể chạy macro "${name}"`);
      return false;
    }
    this._running = true;
    this._stopRequested = false;
    this._currentMacro = name;
    if (depth === 0) this._vars = {}; // reset biến khi bắt đầu 1 chuỗi macro mới (giữ lại qua các bước "next")
    this.bot.log('sys', `Macro: bắt đầu "${name}"`);
    let ok = true;
    let aborted = false;
    try {
      aborted = await this._runSteps(macro.steps || '');
      if (!this._stopRequested && !aborted) {
        this.bot.log('ok', `Macro: hoàn tất "${name}"`);
      }
    } catch (e) {
      this.bot.log('err', `Macro "${name}" lỗi: ${e.message}`);
      ok = false;
    }
    this._running = false;
    this._currentMacro = null;
    this._pendingAsk = null;
    // Nếu macro để sót 1 GUI đang mở (server không tự đóng), trả lại quyền
    // xử lý cho WindowRouter để không bị treo/kẹt màn hình vô thời hạn.
    try {
      const win = this.bot.mc?.currentWindow;
      if (win) {
        const WindowRouter = require('./WindowRouter');
        this.bot.log('sys', 'Macro: còn GUI mở sau khi kết thúc — chuyển cho WindowRouter xử lý');
        WindowRouter.route(this.bot, win);
      }
    } catch { }
    if (!ok || aborted || this._stopRequested) return false;
    if (macro.next) {
      return this.run(macro.next, depth + 1);
    }
    return true;
  }

  // Thay $tenBien trong 1 dòng bằng giá trị biến đã lưu (vd từ "ask").
  // Có sẵn: $owner (ownerUsername của bot), $bot (username bot).
  _substituteVars(line) {
    const builtin = {
      owner: this.bot.cfg?.ownerUsername || '',
      bot: this.bot.cfg?.username || '',
    };
    return line.replace(/\$(\w+)/g, (m, name) => {
      if (name in this._vars) return this._vars[name];
      if (name in builtin && builtin[name]) return builtin[name];
      return m;
    });
  }

  // Bỏ dấu tiếng Việt + hạ chữ thường để so khớp câu trả lời dễ hơn
  // ("bo" khớp "bò", "nguoi sat" khớp "người sắt").
  _fold(text) {
    return String(text || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Tìm mục menu khớp câu trả lời: gõ SỐ (vd 9), hoặc gõ tên (heo / key gold / gold).
  _matchMenu(answer, items) {
    const a = this._fold(answer);
    if (!a) return null;
    const byValue = items.find(i => this._fold(i.value) === a);
    if (byValue) return byValue;
    const exact = items.find(i => this._fold(i.label) === a);
    if (exact) return exact;
    const partial = items.filter(i => this._fold(i.label).endsWith(' ' + a));
    return partial.length === 1 ? partial[0] : null;
  }

  // Trả về true nếu macro bị NGẮT giữa chừng (do stopif / stop theo yêu cầu
  // / bot offline / huỷ ở ask-confirm) — báo cho run() biết không nên chạy
  // tiếp "next".
  async _runSteps(scriptText) {
    const lines = String(scriptText)
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    for (let line of lines) {
      if (this._stopRequested) {
        this.bot.log('sys', 'Macro: đã dừng theo yêu cầu');
        return true;
      }
      if (!this.bot.isOnline) {
        this.bot.log('warn', 'Macro: bot offline — dừng giữa chừng');
        return true;
      }
      line = this._substituteVars(line);
      const parts = line.split(/\s+/);
      const op = parts[0].toLowerCase();
      if (op === 'chat') {
        const text = line.slice(line.indexOf(' ') + 1).trim();
        if (text) {
          try {
            this.bot.mc.chat(text.startsWith('/') ? text : `/${text}`);
            this.bot.log('sys', `Macro chat: ${text}`);
          } catch (e) {
            this.bot.log('err', `Macro chat lỗi: ${e.message}`);
          }
        }
      } else if (op === 'delay') {
        const ms = Math.max(0, Math.min(60000, parseInt(parts[1], 10) || 0));
        await this._sleep(ms);
      } else if (op === 'winclick') {
        const slot = parseInt(parts[1], 10);
        const button = parseInt(parts[2], 10) || 0;
        if (!Number.isInteger(slot) || slot < 0) {
          this.bot.log('warn', `Macro winclick: slot không hợp lệ "${parts[1]}"`);
          continue;
        }
        try {
          this.bot.mc.clickWindow(slot, button, 0);
          this.bot.log('sys', `Macro winclick: slot=${slot} button=${button}`);
        } catch (e) {
          this.bot.log('err', `Macro winclick slot=${slot} lỗi: ${e.message}`);
        }
      } else if (op === 'waitmsg' || op === 'waitmsg!') {
        const strict = op === 'waitmsg!';
        let timeoutMs = 15000;
        let textParts = parts.slice(1);
        if (textParts[0] && /^\d+$/.test(textParts[0])) {
          timeoutMs = Math.max(500, Math.min(60000, parseInt(textParts[0], 10)));
          textParts = textParts.slice(1);
        }
        const text = textParts.join(' ').trim();
        if (!text) {
          this.bot.log('warn', 'Macro waitmsg: thiếu đoạn chữ cần chờ');
          continue;
        }
        this.bot.log('sys', `Macro: đang chờ tin nhắn chứa "${text}" (tối đa ${timeoutMs}ms)...`);
        const got = await this._waitForChat(text, timeoutMs);
        if (!got && this._stopRequested) return true;
        if (!got && strict) {
          this.bot.log('warn', `Macro: hết ${timeoutMs}ms, không thấy "${text}" — DỪNG (không chạy bước tiếp theo)`);
          return true;
        }
        this.bot.log(got ? 'ok' : 'warn', got ? `Macro: đã thấy "${text}"` : `Macro: hết ${timeoutMs}ms, không thấy "${text}" — chạy tiếp`);
      } else if (op === 'stopif') {
        const text = line.slice(line.indexOf(' ') + 1).trim();
        if (!text) {
          this.bot.log('warn', 'Macro stopif: thiếu đoạn chữ cần kiểm tra');
          continue;
        }
        if (this._lastChatContains(text)) {
          this.bot.log('warn', `Macro: dừng vì tin nhắn gần nhất khớp "${text}"`);
          return true;
        }
      } else if (op === 'ask') {
        const question = line.slice(line.indexOf(' ') + 1).trim();
        if (!question) { this.bot.log('warn', 'Macro ask: thiếu câu hỏi'); continue; }
        const answer = await this._waitForAnswer(question, 120000);
        if (answer === null) { this.bot.log('warn', 'Macro: dừng vì không có câu trả lời'); return true; }
        this._vars.answer = answer.trim();
        this.bot.log('ok', `Macro: đã nhận trả lời "${this._vars.answer}"`);
      } else if (op === 'askmap') {
        const rest = line.slice(line.indexOf(' ') + 1);
        const sepIdx = rest.indexOf('||');
        if (sepIdx === -1) {
          this.bot.log('warn', 'Macro askmap: thiếu bảng ánh xạ — cú pháp: askmap <câu hỏi> || nhãn1=giátrị1,nhãn2=giátrị2');
          continue;
        }
        const question = rest.slice(0, sepIdx).trim();
        const mapPart = rest.slice(sepIdx + 2).trim();
        const map = {};
        mapPart.split(',').forEach(pair => {
          const eq = pair.indexOf('=');
          if (eq === -1) return;
          const k = pair.slice(0, eq).trim().toLowerCase();
          const v = pair.slice(eq + 1).trim();
          if (k) map[k] = v;
        });
        if (!Object.keys(map).length) {
          this.bot.log('warn', 'Macro askmap: bảng ánh xạ rỗng/không hợp lệ');
          continue;
        }
        const optionsStr = Object.keys(map).join(', ');
        const answer = await this._waitForAnswer(`${question} (${optionsStr})`, 120000);
        if (answer === null) { this.bot.log('warn', 'Macro: dừng vì không có câu trả lời'); return true; }
        const key = answer.trim().toLowerCase();
        if (key in map) {
          this._vars.answer = map[key];
          this.bot.log('ok', `Macro: đã chọn "${key}" → ${map[key]}`);
        } else {
          this.bot.log('warn', `Macro: "${answer.trim()}" không khớp lựa chọn nào (${optionsStr}) — dừng`);
          return true;
        }
      } else if (op === 'askmenu') {
        // askmenu <tiêu đề> || NHÓM1: giá_trị=nhãn, ... || NHÓM2: giá_trị=nhãn, ...
        const segs = line.slice(line.indexOf(' ') + 1).split('||').map(x => x.trim());
        const title = segs.shift() || 'Chọn:';
        const groups = [];
        for (const seg of segs) {
          const colon = seg.indexOf(':');
          const gname = colon === -1 ? '' : seg.slice(0, colon).trim();
          const body = colon === -1 ? seg : seg.slice(colon + 1);
          const items = [];
          body.split(',').forEach(pair => {
            const eq = pair.indexOf('=');
            if (eq === -1) return;
            const value = pair.slice(0, eq).trim();
            const label = pair.slice(eq + 1).trim();
            if (value && label) items.push({ value, label, group: gname });
          });
          if (items.length) groups.push({ name: gname, items });
        }
        if (!groups.length) {
          this.bot.log('warn', 'Macro askmenu: thiếu bảng lựa chọn — cú pháp: askmenu <tiêu đề> || NHÓM: 2=key free,3=key gold || NHÓM2: 9=heo');
          continue;
        }
        const allItems = groups.flatMap(g => g.items);
        const menuLines = [title];
        for (const g of groups) {
          if (g.name) menuLines.push(`=== ${g.name} ===`);
          g.items.forEach(i => menuLines.push(`${i.value}: ${i.label}`));
        }
        menuLines.push(`→ Gõ SỐ để chọn (vd: cmd ${this.bot.cfg?.id || '<id>'} answer ${allItems[0].value})`);
        let picked = null;
        for (let attempt = 1; attempt <= 3 && !picked; attempt++) {
          const answer = await this._waitForAnswer(menuLines, 120000, true);
          if (answer === null) { this.bot.log('warn', 'Macro: dừng vì không có câu trả lời'); return true; }
          picked = this._matchMenu(answer, allItems);
          if (!picked) {
            this.bot.log('warn', `Macro: "${answer.trim()}" không có trong bảng${attempt < 3 ? ' — chọn lại' : ' — huỷ'}`);
          }
        }
        if (!picked) return true;
        this._vars.answer = picked.value;
        this._vars.label = picked.label;
        this._vars.group = picked.group;
        this.bot.log('ok', `Macro: đã chọn ${picked.value} → ${picked.group ? picked.group + ' ' : ''}${picked.label}`);
      } else if (op === 'confirm') {
        const question = line.slice(line.indexOf(' ') + 1).trim() || 'Xác nhận?';
        const answer = await this._waitForAnswer(`${question} (yes/no)`, 60000);
        const yes = answer !== null && /^(y|yes|co|có|ok|dong\s*y|đồng\s*ý|xac\s*nhan|xác\s*nhận)$/i.test(answer.trim());
        if (!yes) { this.bot.log('warn', 'Macro: huỷ vì không được xác nhận'); return true; }
        this.bot.log('ok', 'Macro: đã xác nhận, tiếp tục');
      } else {
        this.bot.log('warn', `Macro: dòng không hiểu "${line}" (bỏ qua)`);
      }
    }
    return false;
  }

  // Dò tin nhắn chat GẦN ĐÂY (không chỉ đúng 1 dòng cuối cùng, để không bị
  // "trượt" nếu có tin nhắn khác — vd người chơi khác chat — xen vào ngay
  // sau phản hồi thật sự cần kiểm tra) trong vài giây gần nhất, dùng cho
  // bước "stopif".
  _lastChatContains(text, windowMs = 4000, maxScan = 6) {
    const lower = text.toLowerCase();
    const logs = this.bot.getLogs ? this.bot.getLogs() : [];
    const cutoff = Date.now() - windowMs;
    let scanned = 0;
    for (let i = logs.length - 1; i >= 0 && scanned < maxScan; i--) {
      if (logs[i].level !== 'chat') continue;
      scanned++;
      if (logs[i].time && logs[i].time < cutoff) break;
      if ((logs[i].msg || '').toLowerCase().includes(lower)) return true;
    }
    return false;
  }

  _waitForChat(matchText, timeoutMs) {
    const lower = matchText.toLowerCase();
    return new Promise(resolve => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        this.bot.removeListener('log', onLog);
        this._stopEmitter.removeListener('stop', onStop);
        this.bot._clearTimer(timerKey);
        resolve(result);
      };
      const onLog = (entry) => {
        if (entry.level !== 'chat' || !entry.msg) return;
        if (entry.msg.toLowerCase().includes(lower)) finish(true);
      };
      const onStop = () => finish(false);
      const timerKey = `macroWaitMsg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this.bot.on('log', onLog);
      this._stopEmitter.once('stop', onStop);
      this.bot._setTimer(timerKey, () => finish(false), timeoutMs);
    });
  }

  // Dừng macro lại, hỏi người dùng 1 câu và chờ lệnh "answer" trả lời —
  // dùng cho "ask"/"askmap"/"confirm". null = hết giờ hoặc bị stop/huỷ.
  _waitForAnswer(question, timeoutMs, isMenu = false) {
    const qLines = Array.isArray(question) ? question : [question];
    if (isMenu) {
      this.bot.log('sys', `❓ ${qLines[0]}`);
      qLines.slice(1).forEach(l => this.bot.log('sys', l));
    } else {
      this.bot.log('sys', `❓ ${qLines[0]}`);
      this.bot.log('sys', `→ Trả lời bằng lệnh: answer <nội dung>  (vd: cmd ${this.bot.cfg?.id || ''} answer yes)`);
    }
    return new Promise(resolve => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        this._pendingAsk = null;
        this._stopEmitter.removeListener('stop', onStop);
        this.bot._clearTimer(timerKey);
        resolve(val);
      };
      const onStop = () => finish(null);
      const timerKey = `macroAsk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this._stopEmitter.once('stop', onStop);
      this.bot._setTimer(timerKey, () => {
        this.bot.log('warn', `Macro: hết ${timeoutMs}ms chờ trả lời`);
        finish(null);
      }, timeoutMs);
      this._pendingAsk = { resolve: finish, question: qLines.join('\n') };
    });
  }

  _sleep(ms) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._stopEmitter.removeListener('stop', onStop);
        resolve();
      };
      const onStop = () => { this.bot._clearTimer(key); finish(); };
      const key = `macroSleep_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      this._stopEmitter.once('stop', onStop);
      this.bot._setTimer(key, finish, ms);
    });
  }
}
module.exports = MacroEngine;
