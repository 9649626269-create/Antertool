'use strict';
const assert = require('assert');
const AutoBeg = require('../src/core/AutoBeg');
const { BegLedger, resolveOptions, parseMsgArgs, STATES: ST, TRANSITIONS } = AutoBeg;

const FAST = { messageDelayMs: 0, responseTimeoutMs: 0, roundCooldownMs: 0, maxMessagesPerMinute: 1, dedupWindowMs: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(cond, ms = 4000, what = 'điều kiện') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return; await sleep(10); }
  throw new Error(`hết giờ chờ: ${what}`);
}

/** Session giả + "server" giả trả lời đúng mẫu đã xác minh. */
function mk(over = {}, scenario = {}) {
  const chats = []; const logs = [];
  const sc = { balance: '$13.87M', pay: 'success', offline: ['Alex'], ...scenario };
  const s = {
    cfg: {
      id: 's1', username: 'Noanno', botPassword: '',
      autoBeg: { owner: 'dahas', recipientMode: 'allowlist', allowedRecipients: ['Steve', 'Alex'], messageDelayMs: 0, responseTimeoutMs: 250,
        maxMessagesPerMinute: 30, maxRounds: 1, roundCooldownMs: 0, askCooldownMs: 3600000, ...over },
    },
    isOnline: true, _disabled: false, _menuDoneAt: 1, _loginConfirmed: true, autoLogin: { inFlow: false },
    mc: { username: 'Noanno', players: { Steve: {}, Alex: {}, Noanno: {}, dahas: {}, Bob_1: {} }, chat(m) { chats.push(m); setImmediate(() => s._serverReply(m)); } },
    log: (l, m) => logs.push([l, m]), _manager: { bots: [] },
  };
  s._serverReply = (m) => {
    const say = (t, pos = 'system') => s.autoBeg.onMessage(t, pos);
    let x;
    if ((x = /^\/msg (\S+) /.exec(m)) && sc.offline.includes(x[1])) say(`» Người chơi ${x[1]} không online`);
    else if (m === '/bal') { if (sc.balance !== null) say(`» Bạn có ${sc.balance}`); }
    else if ((x = /^\/pay (\S+) (\d+)$/.exec(m))) {
      const amt = BigInt(x[2]);
      if (sc.pay === 'success') { say(`» Bạn đã chuyển cho ${x[1]} $${amt >= 1000000n ? (Number(amt) / 1e6).toFixed(2) + 'M' : amt}`); sc.balance = '$20'; }
      else if (sc.pay === 'success-nodrop') say(`» Bạn đã chuyển cho ${x[1]} $${amt >= 1000000n ? (Number(amt) / 1e6).toFixed(2) + 'M' : amt}`);
      else if (sc.pay === 'notenough') say('» Bạn không có đủ tiền');
      else if (sc.pay === 'notfound') say('» Không tìm thấy người chơi này');
      // 'silent' -> không trả lời
    }
  };
  const ab = new AutoBeg(s, { ledger: new BegLedger(null), floors: FAST });
  s.autoBeg = ab;
  return { s, ab, chats, logs, sc, say: (t, pos = 'system') => ab.onMessage(t, pos) };
}
const count = (chats, re) => chats.filter(c => re.test(c)).length;

(async () => {
  AutoBeg._receipts = [];

  // ───────── cấu hình ─────────
  let r = resolveOptions({});
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.o.minBalance, 100000n);
  assert.strictEqual(r.o.recipientMode, 'allowlist');   // mặc định an toàn: không nhắn bừa mọi người online
  assert.strictEqual(r.o.owner, '');
  assert.strictEqual(r.o.ownerValid, false);            // KHÔNG tự điền owner
  assert.strictEqual(r.o.enabled, false);
  r = resolveOptions({ messageDelayMs: 'x', minBalanceThreshold: 'abc', recipientMode: 'all', owner: 5, allowedRecipients: 'Steve' });
  assert.ok(r.errors.length >= 5, r.errors.join('|'));
  r = resolveOptions({ messageDelayMs: 10, maxMessagesPerMinute: 999, maxRounds: 0 });
  assert.strictEqual(r.o.messageDelayMs, 1500);          // không cho gửi nhanh hơn sàn an toàn
  assert.strictEqual(r.o.maxMessagesPerMinute, 30);
  assert.strictEqual(r.o.maxRounds, 1);
  assert.ok(r.warnings.length >= 3);
  r = resolveOptions({ requestMessageTemplate: 'x'.repeat(300) });
  assert.ok(r.errors.some(e => /quá dài/.test(e)));
  r = resolveOptions({ requestMessageTemplate: '   ' });
  assert.ok(r.errors.some(e => /rỗng/.test(e)));
  r = resolveOptions({ minBalanceThreshold: '100K', reserve: '5k', maxTransferAmount: '1B', allowedRecipients: ['Steve', 'a b', 'ab'] });
  assert.strictEqual(r.o.reserve, 5000n); assert.strictEqual(r.o.maxTransfer, 1000000000n);
  assert.deepStrictEqual(r.o.allowedRecipients, ['steve']); assert.strictEqual(r.warnings.length, 2);

  // ───────── lệnh msg ─────────
  let p = parseMsgArgs(['Steve', 'Em', 'là', 'newbie', 'ạ,', 'cho', 'em', 'xin', '100k']);
  assert.ok(p.ok); assert.strictEqual(p.name, 'Steve'); assert.strictEqual(p.cmd, '/msg Steve Em là newbie ạ, cho em xin 100k');
  assert.ok(!parseMsgArgs([]).ok);
  assert.ok(!parseMsgArgs(['Steve']).ok);
  assert.ok(!parseMsgArgs(['St', 'hi']).ok);                    // tên quá ngắn
  assert.ok(!parseMsgArgs(['Ste ve!', 'hi']).ok);               // ký tự lạ
  assert.ok(!parseMsgArgs(['x'.repeat(17), 'hi']).ok);
  assert.ok(!parseMsgArgs(['Steve', 'a'.repeat(300)]).ok);      // vượt 256 ký tự
  assert.ok(!parseMsgArgs(['Noanno', 'hi'], 'noanno').ok);      // không nhắn cho chính mình
  assert.strictEqual(parseMsgArgs(['Steve', 'hi\n/op', 'me']).cmd, '/msg Steve hi /op me');   // không chèn xuống dòng
  assert.strictEqual(parseMsgArgs(['Steve', '§ahi']).cmd, '/msg Steve hi');

  // ───────── state machine ─────────
  {
    const { ab } = mk();
    assert.strictEqual(ab.state, ST.OFF);
    assert.strictEqual(ab._to(ST.TRANSFERRING), false);        // OFF không được nhảy thẳng sang TRANSFERRING
    assert.strictEqual(ab.state, ST.OFF);
    for (const [from, tos] of Object.entries(TRANSITIONS)) for (const t of tos) assert.ok(ST[t], `${from}->${t}`);
    assert.ok(!TRANSITIONS.VERIFYING.includes(ST.CONNECTING)); // đang xác minh mà mất kết nối -> UNKNOWN, không phải "kết nối lại"
    ab.state = ST.REQUESTING; assert.strictEqual(ab._to(ST.TRANSFERRING), false);
    ab.state = ST.CHECKING_BALANCE; assert.strictEqual(ab._to(ST.TRANSFERRING), true);
    ab.state = ST.OFF;
  }
  // thiếu owner -> không bật, không đoán
  {
    const { ab } = mk({ owner: '' });
    const e = ab.enable();
    assert.strictEqual(e.ok, false); assert.match(e.reason, /owner/); assert.strictEqual(ab.state, ST.OFF);
  }
  {
    const { ab } = mk({ owner: 'Noanno' });               // owner trùng tên bot
    assert.strictEqual(ab.enable().ok, false);
  }
  {
    const { ab } = mk({ owner: '', autoTransfer: false });   // chỉ xin tiền thì không cần owner
    const e = ab.enable(); assert.strictEqual(e.ok, true); ab.estop();
  }
  {
    const { ab } = mk({ messageDelayMs: 'nhanh' });
    const e = ab.enable(); assert.strictEqual(e.ok, false); assert.match(e.reason, /không hợp lệ/);
  }

  // ───────── luồng đầy đủ: xin → /bal → /pay → xác minh ─────────
  {
    const { s, ab, chats, say } = mk();
    assert.strictEqual(ab.enable().ok, true);
    assert.strictEqual(ab.enable().ok, false, 'không cho 2 vòng chạy song song trên cùng tài khoản');
    await until(() => ab.state === ST.OFF, 6000, 'vòng hoàn tất');
    // đã xin Steve + Alex (cả hai trong allowlist & online), đúng 1 lần mỗi người, KHÔNG xin Bob_1 (ngoài allowlist), owner, chính bot
    assert.strictEqual(count(chats, /^\/msg Steve Em là newbie/), 1);
    assert.strictEqual(count(chats, /^\/msg Alex Em là newbie/), 1);
    assert.strictEqual(count(chats, /^\/msg (Bob_1|dahas|Noanno) /), 0);
    // Alex offline -> FAILED, Steve -> SENT (chưa có bằng chứng thì không phải CONFIRMED)
    const rec = [...ab.round.recipients.values()];
    assert.strictEqual(rec.find(x => x.name === 'Steve').status, 'SENT');
    assert.strictEqual(rec.find(x => x.name === 'Alex').status, 'FAILED');
    // đọc /bal rồi chuyển đúng 1 lần, đúng số tiền an toàn (13.87M -> 13,860,000)
    assert.strictEqual(count(chats, /^\/bal$/) >= 1, true);
    assert.strictEqual(count(chats, /^\/pay /), 1);
    assert.ok(chats.includes('/pay dahas 13860000'), chats.join(' | '));
    assert.ok(chats.indexOf('/bal') < chats.indexOf('/pay dahas 13860000'));
    const tx = ab.ledger.data.tx;
    assert.strictEqual(tx.length, 1); assert.strictEqual(tx[0].status, 'SUCCESS'); assert.strictEqual(tx[0].crossCheck, 'ok');
    assert.strictEqual(ab.stats.pays, 1); assert.strictEqual(ab.stats.paid, 13860000n);
    assert.strictEqual(ab.unknownTx, null);
    assert.ok(chats.every(c => !/\/pay confirm/.test(c)));
  }

  // ───────── dryRun: chỉ log ý định ─────────
  {
    const { ab, chats } = mk({ dryRun: true });
    ab.enable(); await until(() => ab.state === ST.OFF, 6000);
    assert.strictEqual(count(chats, /^\/pay/), 0);
    assert.strictEqual(ab.ledger.data.tx[0].status, 'DRYRUN');
    assert.strictEqual(ab.ledger.data.tx[0].amount, '13860000');
  }

  // ───────── dưới ngưỡng / không đọc được số dư / số dư mơ hồ ─────────
  for (const [bal, why] of [['$500', 'dưới ngưỡng'], ['$0', 'số dư 0'], [null, 'không có phản hồi /bal'], ['$1.250', 'mơ hồ'], ['$99.99K', 'sát dưới ngưỡng']]) {
    const { ab, chats, logs } = mk({ balanceRetries: 0 }, { balance: bal });
    ab.enable(); await until(() => ab.state === ST.OFF, 6000, why);
    assert.strictEqual(count(chats, /^\/pay/), 0, `không được /pay khi ${why}`);
    assert.strictEqual(ab.ledger.data.tx.length, 0, why);
    if (bal === null || bal === '$1.250') assert.ok(logs.some(([, m]) => /KHÔNG chuyển tiền, KHÔNG mặc định số dư bằng 0/.test(m)), why);
  }
  // đúng ngưỡng 100.00K -> chuyển 99,990? (số rút gọn: trừ 1 đơn vị hiển thị, vẫn không vượt số dư thật)
  {
    const { ab, chats } = mk({}, { balance: '$100.00K' });
    ab.enable(); await until(() => ab.state === ST.OFF, 6000);
    assert.ok(chats.includes('/pay dahas 99990'), chats.join('|'));
  }
  // số dư nguyên đầy đủ đúng bằng ngưỡng
  {
    const { ab, chats } = mk({}, { balance: '$100000' });
    ab.enable(); await until(() => ab.state === ST.OFF, 6000);
    assert.ok(chats.includes('/pay dahas 100000'));
  }
  // reserve + maxTransferAmount
  {
    const { ab, chats } = mk({ reserve: '10K', maxTransferAmount: '5M' }, { balance: '$13.87M' });
    ab.enable(); await until(() => ab.state === ST.OFF, 6000);
    assert.ok(chats.includes('/pay dahas 5000000'), chats.join('|'));
  }

  // ───────── /pay bị từ chối: không coi là thành công, không gửi lại ─────────
  for (const [mode, reason] of [['notenough', 'insufficient-funds'], ['notfound', 'owner-not-found']]) {
    const { ab, chats } = mk({}, { pay: mode });
    ab.enable(); await until(() => ab.state === ST.OFF, 6000, mode);
    assert.strictEqual(count(chats, /^\/pay/), 1, `${mode}: không được tự gửi lại`);
    assert.strictEqual(ab.ledger.data.tx[0].status, 'FAILED'); assert.strictEqual(ab.ledger.data.tx[0].note, reason);
    assert.strictEqual(ab.stats.pays, 0);
  }

  // ───────── timeout -> UNKNOWN, tạm dừng cứng, tuyệt đối không gửi lại ─────────
  {
    const { s, ab, chats, sc } = mk({ maxRounds: 3 }, { pay: 'silent' });
    ab.enable(); await until(() => ab.state === ST.PAUSED, 6000, 'UNKNOWN');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'UNKNOWN');
    assert.ok(ab.unknownTx);
    assert.strictEqual(ab._hard, true);
    await sleep(600);                                       // chờ lâu: không được tự gửi lại / tự xin tiếp
    assert.strictEqual(count(chats, /^\/pay/), 1);
    assert.strictEqual(ab.state, ST.PAUSED);
    // bot vẫn online: tự đọc /bal chỉ-đọc để operator đối chiếu, nhưng vẫn PAUSED
    await until(() => ab._reconciled, 3000, 'đối chiếu /bal');
    assert.strictEqual(ab.state, ST.PAUSED);
    assert.strictEqual(count(chats, /^\/pay/), 1);
    // resume = operator đã kiểm tra: ghi nhận, rồi mới chạy tiếp (vòng sau vẫn có thể /pay vì operator đã xác nhận)
    sc.pay = 'success';
    assert.strictEqual(ab.resume().ok, true);
    assert.strictEqual(ab.unknownTx, null);
    assert.strictEqual(ab.ledger.data.tx[0].status, 'UNKNOWN_ACK');
    ab.estop();
  }
  // mất kết nối sau khi gửi /pay -> UNKNOWN (không phải FAILED/SUCCESS)
  {
    const { s, ab, chats, sc } = mk({}, { pay: 'silent' });
    s.mc.chat = (m) => { chats.push(m); if (/^\/pay/.test(m)) setTimeout(() => { s.isOnline = false; }, 30); else setImmediate(() => s._serverReply(m)); };
    ab.enable(); await until(() => ab.state === ST.PAUSED, 6000, 'UNKNOWN khi mất kết nối');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'UNKNOWN');
    assert.match(ab.ledger.data.tx[0].note, /mất kết nối/);
    s.isOnline = true;
    await sleep(500);
    assert.strictEqual(count(chats, /^\/pay/), 1, 'reconnect không được tự /pay lại');
    assert.strictEqual(ab.state, ST.PAUSED);
    ab.estop();
  }
  // dòng xác nhận có nhưng số dư KHÔNG giảm -> CONFLICT, dừng, không gửi lại
  {
    const { ab, chats } = mk({}, { pay: 'success-nodrop' });
    ab.enable(); await until(() => ab.state === ST.PAUSED, 6000, 'CONFLICT');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'CONFLICT');
    assert.strictEqual(count(chats, /^\/pay/), 1);
    ab.estop();
  }
  // dòng "đã chuyển" của người khác / số tiền khác không được tính là bằng chứng
  {
    const { s, ab, chats, say } = mk({}, { pay: 'silent' });
    s.mc.chat = (m) => {
      chats.push(m);
      if (/^\/pay/.test(m)) { setImmediate(() => { say('» Bạn đã chuyển cho Steve $13.86M'); say('» Bạn đã chuyển cho dahas $5K'); say('<Alex> » Bạn đã chuyển cho dahas $13.86M', 'chat'); say('» Bạn đã chuyển cho dahas $13.86M', 'chat'); }); }
      else setImmediate(() => s._serverReply(m));
    };
    ab.enable(); await until(() => ab.state === ST.PAUSED, 6000, 'UNKNOWN do bằng chứng giả');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'UNKNOWN');
    ab.estop();
  }
  // xác nhận chéo từ bot Owner cùng hệ thống ("Bạn nhận được ... từ <bot>")
  {
    AutoBeg._receipts = [];
    const { s, ab, chats } = mk({ verifyWithBalance: false }, { pay: 'silent' });
    s.mc.chat = (m) => {
      chats.push(m);
      if (/^\/pay dahas (\d+)$/.test(m)) setTimeout(() => AutoBeg._publishReceipt({ to: 'dahas', from: 'noanno', amount: require('../src/core/MoneyParse').parseMoney('$13.86M'), at: Date.now() }), 30);
      else setImmediate(() => s._serverReply(m));
    };
    ab.enable(); await until(() => ab.state === ST.OFF, 6000, 'xác nhận chéo');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'SUCCESS'); assert.match(ab.ledger.data.tx[0].via, /owner-bot/);
  }

  // ───────── khôi phục sau crash: INTENT còn dang dở lần trước ─────────
  {
    const { s, ab, chats } = mk({});
    ab.ledger.addTx({ id: 'tx-old', botId: 's1', owner: 'dahas', amount: '13860000', balShown: '13870000', balPrecision: '10000', status: 'INTENT', at: 1 });
    ab.enable(); await until(() => ab.state === ST.PAUSED, 3000, 'phát hiện giao dịch dang dở');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'UNKNOWN');
    assert.match(ab._pauseReason, /chưa rõ kết quả/);
    await sleep(300);
    assert.strictEqual(count(chats, /^\/pay/), 0);
    ab.estop();
  }
  // ý định phải xuống đĩa TRƯỚC khi gửi /pay
  {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ab-')), 'autobeg.json');
    const { s, ab, chats } = mk({}, { pay: 'silent' });
    ab.ledger = new BegLedger(f);
    let onDiskAtSend = null;
    s.mc.chat = (m) => { chats.push(m); if (/^\/pay/.test(m)) onDiskAtSend = JSON.parse(fs.readFileSync(f, 'utf8')).tx.slice(); else setImmediate(() => s._serverReply(m)); };
    ab.enable(); await until(() => ab.state === ST.PAUSED, 6000);
    assert.ok(onDiskAtSend && onDiskAtSend[0] && onDiskAtSend[0].status === 'INTENT', 'INTENT phải có trên đĩa trước khi gửi /pay');
    ab.estop();
    // file hỏng không bị ghi đè mất dữ liệu
    fs.writeFileSync(f, '{not json');
    const l2 = new BegLedger(f);
    assert.deepStrictEqual(l2.data.tx, []);
    assert.ok(fs.readdirSync(path.dirname(f)).some(n => n.includes('.corrupt-')));
  }

  // ───────── dừng khẩn cấp / tắt giữa vòng ─────────
  {
    const { s, ab, chats } = mk({ allowedRecipients: ['Steve', 'Alex', 'Bob_1'], messageDelayMs: 0 });
    s.cfg.autoBeg.messageDelayMs = 0;
    ab.enable();
    await until(() => chats.some(c => /^\/msg /.test(c)), 3000);
    ab.estop();
    const n = chats.length;
    await sleep(400);
    assert.strictEqual(chats.length, n, 'sau estop không được gửi thêm bất cứ thứ gì');
    assert.strictEqual(ab.state, ST.OFF);
    assert.strictEqual(count(chats, /^\/pay/), 0);
    assert.strictEqual(ab._thankQ.length, 0);
  }
  // bật/tắt liên tục
  {
    const { ab, chats } = mk();
    for (let i = 0; i < 5; i++) { assert.strictEqual(ab.enable().ok, true); ab.estop(); assert.strictEqual(ab.state, ST.OFF); }
    await sleep(200);
    assert.ok(chats.length <= 3, `bật/tắt nhanh không được gây gửi dồn: ${chats.length}`);
    assert.strictEqual(ab.enable().ok, true); ab.stop(); await sleep(50); assert.strictEqual(ab.state, ST.OFF);
  }
  // stop() có kiểm soát khi đang chờ xác minh /pay: chờ xong rồi mới tắt, không bỏ rơi giao dịch
  {
    const { s, ab, chats, sc } = mk({ responseTimeoutMs: 400 }, { pay: 'silent' });
    s.mc.chat = (m) => { chats.push(m); if (/^\/pay/.test(m)) setTimeout(() => { sc.balance = '$20'; s.autoBeg.onMessage('» Bạn đã chuyển cho dahas $13.86M', 'system'); }, 150); else setImmediate(() => s._serverReply(m)); };
    ab.enable();
    await until(() => ab.state === ST.VERIFYING, 6000, 'VERIFYING');
    ab.stop();
    assert.strictEqual(ab.state, ST.STOPPING);
    await until(() => ab.state === ST.OFF, 4000, 'tắt sau khi xác minh');
    assert.strictEqual(ab.ledger.data.tx[0].status, 'SUCCESS');
  }
  // estop khi đang VERIFYING -> giao dịch thành UNKNOWN (không mất dấu)
  {
    const { s, ab, chats } = mk({ responseTimeoutMs: 1000 }, { pay: 'silent' });
    ab.enable();
    await until(() => ab.state === ST.VERIFYING, 6000);
    ab.estop();
    await sleep(100);
    assert.strictEqual(ab.ledger.data.tx[0].status, 'UNKNOWN');
    assert.ok(ab.unknownTx);
    assert.strictEqual(ab.state, ST.OFF);
    // bật lại: phải bị chặn bởi giao dịch UNKNOWN cũ
    ab.enable(); await until(() => ab.state === ST.PAUSED, 2000);
    assert.strictEqual(count(chats, /^\/pay/), 1);
    ab.estop();
  }

  // ───────── mất kết nối / chưa sẵn sàng giữa vòng ─────────
  {
    const { s, ab, chats } = mk({ allowedRecipients: ['Steve', 'Alex', 'Bob_1'], responseTimeoutMs: 150 }, { offline: [] });
    s.isOnline = false;                                      // chưa online: không được gửi gì
    ab.enable();
    await sleep(300);
    assert.strictEqual(chats.length, 0, 'chưa READY thì không gửi chat');
    assert.strictEqual(ab.state, ST.CONNECTING);
    s.isOnline = true; s._menuDoneAt = 0;                    // online nhưng chưa vào server (menu chưa xong)
    await sleep(300);
    assert.strictEqual(chats.length, 0);
    s._menuDoneAt = 5;
    await until(() => chats.some(c => /^\/msg Steve/.test(c)), 3000, 'bắt đầu sau khi READY');
    // rớt mạng giữa vòng rồi vào lại: không gửi lặp cho người đã xin
    s.isOnline = false; await sleep(150); s.isOnline = true;
    await until(() => ab.state === ST.OFF, 8000, 'xong vòng');
    for (const n of ['Steve', 'Alex', 'Bob_1']) assert.ok(count(chats, new RegExp(`^/msg ${n} `)) <= 1, `${n} bị xin lặp`);
    assert.strictEqual(count(chats, /^\/pay/), 1);
  }
  // AutoLogin đang chạy = chưa READY
  {
    const { s, ab, chats } = mk();
    s.autoLogin.inFlow = true; ab.enable(); await sleep(250);
    assert.strictEqual(chats.length, 0); ab.estop();
  }

  // ───────── chống lặp / giới hạn vòng ─────────
  {
    const { ab, chats } = mk({ maxRounds: 3 }, { balance: '$500', offline: [] });
    ab.enable(); await until(() => ab.state === ST.OFF, 12000, '3 vòng');
    assert.strictEqual(ab.roundsDone, 3, 'không tạo vòng vô hạn');
    assert.strictEqual(count(chats, /^\/msg Steve /), 1, 'vòng sau không xin lại người vừa xin (askCooldown)');
    assert.strictEqual(count(chats, /^\/bal$/), 3);
    assert.strictEqual(count(chats, /^\/pay/), 0);
    assert.strictEqual(ab.enable({ manual: false }).ok, false);   // tự bật lại sau khi hoàn tất bị chặn trong phiên này
  }
  // nhiều bot cùng xin 1 người: chỉ một bot xin (sổ chung)
  {
    const a = mk({ allowedRecipients: ['Steve'], autoTransfer: false }, { offline: [] });
    const b = mk({ allowedRecipients: ['Steve'], autoTransfer: false }, { offline: [] });
    b.ab.ledger = a.ab.ledger; b.s.cfg.id = 's2'; b.s.cfg.username = 'Clone2'; b.s.mc.username = 'Clone2';
    a.ab.enable(); b.ab.enable();
    await until(() => a.ab.state === ST.OFF && b.ab.state === ST.OFF, 8000);
    assert.strictEqual(count(a.chats, /^\/msg Steve /) + count(b.chats, /^\/msg Steve /), 1);
  }
  // loại trừ: bot cùng hệ thống + blacklist + owner; người đã từ chối không bị nhắn lại
  {
    const m = mk({ recipientMode: 'online', blacklistRecipients: ['Bob_1'], autoTransfer: false, maxRecipientsPerRound: 10 }, { offline: [] });
    m.s._manager.bots = [{ cfg: { username: 'Alex' }, mc: { username: 'Alex' } }];
    m.ab.ledger.markDeclined('steve');
    m.ab.enable(); await until(() => m.ab.state === ST.OFF, 8000);
    assert.strictEqual(m.chats.filter(c => /^\/msg /.test(c)).length, 0, m.chats.join('|'));   // Steve từ chối, Alex là bot nhà, Bob_1 blacklist, dahas owner
  }
  // allowlist rỗng -> không nhắn ai
  {
    const m = mk({ allowedRecipients: [], autoTransfer: false }); m.ab.enable(); await until(() => m.ab.state === ST.OFF, 6000);
    assert.strictEqual(m.chats.filter(c => /^\/msg /.test(c)).length, 0);
  }
  // maxRecipientsPerRound
  {
    const m = mk({ recipientMode: 'online', maxRecipientsPerRound: 1, autoTransfer: false }, { offline: [] });
    m.ab.enable(); await until(() => m.ab.state === ST.OFF, 6000);
    assert.strictEqual(m.chats.filter(c => /^\/msg /.test(c)).length, 1);
  }
  // từ chối qua PM
  {
    const m = mk({ autoTransfer: false }, { offline: [] }); m.ab.enable(); await sleep(50);
    m.say('<Steve> Noanno: đừng nhắn tin cho tôi nữa, spam quá');
    assert.strictEqual(m.ab.ledger.isDeclined('steve'), true);
    m.say('<Alex> dahas: đừng nhắn tin nữa');                 // gửi cho người khác -> không áp dụng
    assert.strictEqual(m.ab.ledger.isDeclined('alex'), false);
    m.ab.estop();
  }

  // ───────── nhận tiền + cảm ơn ─────────
  {
    const m = mk({ thankCooldownMs: 0 }, { balance: '$500', offline: [] });
    m.ab.enable(); await sleep(60);
    let t = 1_000_000; m.ab._now = () => t;                   // đồng hồ giả cho dedup
    m.ab.o.dedupWindowMs = 1000;
    m.say('» Bạn nhận được $100K từ Noanno');                 // chính bot -> không cảm ơn chính mình
    m.say('» Bạn nhận được $100K từ Steve');
    assert.strictEqual(m.ab.stats.receivedCount, 2);
    assert.strictEqual(m.ab.stats.received, 200000n);
    // hai giao dịch THẬT liên tiếp cùng người, cùng số tiền, cách 3 giây => cả hai đều tính
    t += 3000; m.say('» Bạn nhận được $100K từ Steve');
    assert.strictEqual(m.ab.stats.receivedCount, 3);
    // cùng tin phát lại trong 300ms (gói trùng) => chỉ tính một
    t += 300; m.say('» Bạn nhận được $100K từ Steve');
    assert.strictEqual(m.ab.stats.receivedCount, 3); assert.strictEqual(m.ab.stats.duplicates, 1);
    // khác số tiền thì không phải trùng
    m.say('» Bạn nhận được $1.00M từ Steve'); assert.strictEqual(m.ab.stats.receivedCount, 4);
    assert.strictEqual(m.ab.stats.received, 100000n * 3n + 1000000n);   // 100K(Noanno) + 100K + 100K(3s sau) + 1M; gói trùng 300ms không tính
    m.ab._now = Date.now;
    await until(() => m.ab.stats.thanked >= 1, 3000, 'cảm ơn');
    await sleep(200);
    assert.ok(m.chats.some(c => c === '/msg Steve Cảm ơn anh/chị nhiều ạ ❤'), m.chats.join('|'));
    assert.strictEqual(count(m.chats, /^\/msg Noanno /), 0);
    m.ab.estop();
  }
  // cảm ơn: mỗi người một lần trong cooldown (không spam khi họ chuyển nhiều lần)
  {
    const m = mk({ thankCooldownMs: 60000 }, { balance: '$500', offline: [] });
    m.ab.enable(); await sleep(50);
    m.say('» Bạn nhận được $100K từ Alex'); m.ab._now = (() => { const b = Date.now(); return () => b + 5000; })(); m.say('» Bạn nhận được $100K từ Alex');
    m.ab._now = Date.now;
    assert.strictEqual(m.ab.stats.receivedCount, 2); assert.strictEqual(m.ab.stats.thankSuppressed, 1);
    assert.strictEqual(m.ab._thankQ.length + m.ab.stats.thanked, 1);
    m.ab.estop();
  }
  // tắt thankEnabled / đang OFF: không cảm ơn
  {
    const m = mk({ thankEnabled: false }); m.ab.enable(); await sleep(30);
    m.say('» Bạn nhận được $100K từ Steve'); await sleep(150);
    assert.strictEqual(m.chats.filter(c => /Cảm ơn/.test(c)).length, 0); m.ab.estop();
    const o = mk(); o.say('» Bạn nhận được $100K từ Steve'); await sleep(100);   // OFF
    assert.strictEqual(o.chats.length, 0); assert.strictEqual(o.ab.stats.receivedCount, 0);
  }
  // thất bại cảm ơn do người nhận offline được ghi nhận
  {
    const m = mk({}, { balance: '$500', offline: ['Alex'] }); m.ab.enable(); await sleep(30);
    m.say('» Bạn nhận được $100K từ Alex'); await until(() => m.chats.some(c => /^\/msg Alex Cảm ơn/.test(c)), 2000);
    await sleep(80); assert.ok(m.logs.some(([, x]) => /Alex không online/.test(x))); m.ab.estop();
  }
  // ───────── CHỐNG GIẢ MẠO ─────────
  {
    const m = mk({}, { balance: '$500', offline: [] }); m.ab.enable(); await sleep(30);
    const before = () => [m.ab.stats.receivedCount, m.ab.stats.thanked, m.ab._thankQ.length].join();
    const b0 = before();
    m.say('<Steve> » Bạn nhận được $100K từ Steve');                       // chat giả
    m.say('<Steve> Noanno: » Bạn nhận được $100K từ Steve');               // PM giả
    m.say('[Accchinh] <Steve> dahas: » Bạn nhận được $100K từ Steve');
    m.say('Steve: » Bạn nhận được $100K từ Steve');
    m.say('» Bạn nhận được $100K từ Steve', 'chat');                        // đúng mẫu nhưng đi kênh chat người chơi
    m.say('» Bạn nhận được $100K từ Steve', 'game_info');
    m.say('» Bạn nhận được $100K từ Steve', null);                          // position không xác định -> không tin
    m.say('» Bạn có $999B', 'chat');
    await sleep(120);
    assert.strictEqual(before(), b0, 'không dòng giả mạo nào được tính');
    assert.strictEqual(m.chats.filter(c => /Cảm ơn/.test(c)).length, 0);
    assert.ok(m.logs.some(([, x]) => /position="chat"/.test(x)), 'phải cảnh báo rõ lý do bỏ qua');
    m.say('» Bạn nhận được $100K từ Steve');                                // thật
    assert.strictEqual(m.ab.stats.receivedCount, 1);
    // số dư giả khi không có yêu cầu /bal đang chờ -> bỏ qua
    m.say('» Bạn có $999B'); assert.strictEqual(m.ab._balCtx, null);
    m.ab.estop();
  }
  // số dư giả trong chat người chơi không được dùng khi đang chờ /bal
  {
    const m = mk({}, { balance: null, offline: [], pay: 'silent' }, );
    m.s.mc.chat = (c) => { m.chats.push(c); if (c === '/bal') setImmediate(() => { m.say('<Steve> » Bạn có $999B'); m.say('» Bạn có $999B', 'chat'); }); };
    m.ab.enable(); await until(() => m.ab.state === ST.OFF || m.ab.state === ST.PAUSED, 8000);
    assert.strictEqual(count(m.chats, /^\/pay/), 0, 'số dư giả không được kích hoạt /pay');
    m.ab.estop();
  }
  // trustedPositions cấu hình được (server gửi tin qua kênh khác)
  {
    const m = mk({ trustedPositions: ['system', 'chat'] }); m.ab.enable(); await sleep(30);
    m.say('» Bạn nhận được $100K từ Steve', 'chat'); assert.strictEqual(m.ab.stats.receivedCount, 1); m.ab.estop();
  }

  // ───────── giới hạn tốc độ & kick ─────────
  {
    const m = mk({ messageDelayMs: 1500, allowedRecipients: ['Steve', 'Alex', 'Bob_1'], autoTransfer: false }, { offline: [] });
    m.ab._floors = FAST; m.ab.o.messageDelayMs = 400;
    m.ab.enable(); m.ab.o.messageDelayMs = 400;
    const t0 = Date.now();
    await until(() => m.chats.filter(c => /^\/msg /.test(c)).length >= 3, 6000);
    assert.ok(Date.now() - t0 >= 2 * 400 * 0.8, 'phải giãn cách giữa các tin');
    m.ab.estop();
  }
  {
    const m = mk({ maxMessagesPerMinute: 2, allowedRecipients: ['Steve', 'Alex', 'Bob_1'], autoTransfer: false, responseTimeoutMs: 100 }, { offline: [] });
    m.ab.enable(); await sleep(800);
    assert.ok(m.chats.length <= 2, `vượt maxMessagesPerMinute: ${m.chats.length}`);
    m.ab.estop();
  }
  {
    const m = mk({ autoTransfer: false, allowedRecipients: ['Steve', 'Alex', 'Bob_1'] }, { offline: [] });
    m.ab.enable(); await until(() => m.chats.length >= 1, 2000);
    m.say('» Bạn đang chat quá nhanh, vui lòng chậm lại');
    assert.ok(m.ab._backoffUntil > Date.now() + 20000, 'phải lùi khi server báo giới hạn tốc độ');
    const n = m.chats.length; await sleep(300); assert.strictEqual(m.chats.length, n, 'đang lùi thì không gửi thêm');
    m.say('<Steve> » Bạn đang chat quá nhanh'); // chat giả không kích hoạt thêm
    m.ab.estop();
  }
  {
    const m = mk({ autoTransfer: false, allowedRecipients: ['Steve', 'Alex', 'Bob_1'] }, { offline: [] });
    m.ab.enable(); await until(() => m.chats.length >= 1, 2000);
    m.ab.onKicked('spam'); assert.notStrictEqual(m.ab.state, ST.PAUSED);
    m.ab.onKicked('spam'); assert.strictEqual(m.ab.state, ST.PAUSED); assert.strictEqual(m.ab._hard, true);
    m.ab.estop();
  }

  // ───────── lệnh msg tay: bắt lỗi offline ─────────
  {
    const m = mk({}, { offline: ['hannnnnnnn'] });
    const r1 = await m.ab.sendManualMsg('hannnnnnnn', '/msg hannnnnnnn hello');
    assert.strictEqual(r1.ok, true);
    await sleep(60);
    assert.ok(m.logs.some(([, x]) => /hannnnnnnn không online/.test(x)));
    m.s.isOnline = false;
    assert.strictEqual((await m.ab.sendManualMsg('Steve', '/msg Steve hi')).ok, false);
  }

  // ───────── trạng thái hiển thị ─────────
  { const m = mk(); assert.match(m.ab.status(), /AutoBeg: OFF/); }

  console.log('auto-beg: OK');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
