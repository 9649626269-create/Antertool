'use strict';
// BUG-001: proxy HTTP CONNECT phải gỡ listener 'data' sau khi tunnel mở xong (trước đây listener ở lại, nối mọi byte
//          của phiên chơi vào một chuỗi ngày càng dài -> RAM/CPU tăng theo lưu lượng).
// BUG-005: id proxy nạp từ config không được cấp lại cho proxy thêm mới (trước đây add() ra "pxy_1" lần 2).
// Chạy với proxy giả trên localhost, không cần cài thư viện, không cần mạng.
const assert = require('assert');
const net = require('net');
const ProxyManager = require('../src/core/ProxyManager');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const read = (sock, n, ms = 3000) => new Promise((resolve, reject) => {
  const chunks = []; let len = 0;
  const t = setTimeout(() => reject(new Error(`chỉ nhận ${len}/${n} byte`)), ms);
  sock.on('data', d => {
    chunks.push(d); len += d.length;
    if (len >= n) { clearTimeout(t); resolve(Buffer.concat(chunks)); }
  });
});

// proxy giả: đọc dòng CONNECT rồi trả `reply` theo từng mảnh (mỗi mảnh 1 lần write, cách nhau `gap` ms), sau đó chạy `after(client)`
function fakeProxy({ reply, gap = 0, after = () => { } }) {
  const requests = [];
  const server = net.createServer(client => {
    let got = '';
    client.on('error', () => { });
    client.on('data', async d => {
      got += d.toString('latin1');
      if (!got.includes('\r\n\r\n') || client._replied) return;
      client._replied = true;
      requests.push(got);
      for (const part of reply) { client.write(part); if (gap) await sleep(gap); }
      after(client);
    });
  });
  return new Promise(res => server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port, requests })));
}

(async () => {
  const pm = new ProxyManager();
  const mk = port => ({ type: 'http', host: '127.0.0.1', port, timeout: 3000 });

  // ---- BUG-001 (1) tunnel mở xong: không còn listener 'data' (đã chạy lại bằng proxy giả) ----
  {
    const p = await fakeProxy({ reply: ['HTTP/1.1 200 Connection established\r\n\r\n'] });
    const sock = await pm.connect(mk(p.port), 'mc.example.com', 25565);
    assert.strictEqual(sock.listenerCount('data'), 0, 'sau CONNECT thành công không được còn listener data');
    assert.ok(p.requests[0].startsWith('CONNECT mc.example.com:25565 HTTP/1.1\r\n'), p.requests[0]);
    sock.destroy(); p.server.close();
  }

  // ---- BUG-001 (2) dữ liệu sau CONNECT vẫn tới được bên đọc (kể cả gắn listener muộn), không mất byte nào ----
  {
    const payload = Buffer.alloc(300000); for (let i = 0; i < payload.length; i++) payload[i] = i * 31 % 251;
    // server MC giả (qua tunnel) nói trước 20ms sau 200 -> lúc đó chưa ai gắn listener
    const p = await fakeProxy({
      reply: ['HTTP/1.1 200 Connection established\r\n\r\n'],
      after: c => setTimeout(() => c.write(payload), 20),
    });
    const sock = await pm.connect(mk(p.port), 'h', 1);
    await sleep(100); // "mineflayer" gắn listener muộn
    const got = await read(sock, payload.length);
    assert.ok(got.equals(payload), 'dữ liệu qua tunnel phải nguyên vẹn');
    assert.strictEqual(sock.listenerCount('data'), 1, 'chỉ còn listener của bên đọc, không có listener thừa của ProxyManager');
    sock.destroy(); p.server.close();
  }

  // ---- BUG-001 (3) byte thừa dính liền sau header (cùng gói TCP) được trả lại, đứng trước dữ liệu sau ----
  {
    const p = await fakeProxy({
      reply: ['HTTP/1.1 200 OK\r\n\r\nEARLY'],
      after: c => setTimeout(() => c.write('-LATE'), 30),
    });
    const sock = await pm.connect(mk(p.port), 'h', 1);
    assert.strictEqual(sock.listenerCount('data'), 0);
    await sleep(60);
    const got = await read(sock, 'EARLY-LATE'.length);
    assert.strictEqual(got.toString(), 'EARLY-LATE');
    sock.destroy(); p.server.close();
  }

  // ---- BUG-001 (4) header chia nhiều mảnh vẫn nhận đúng ----
  {
    const p = await fakeProxy({ reply: ['HTTP/1.1 2', '00 Connection est', 'ablished\r\n', '\r\n'], gap: 15 });
    const sock = await pm.connect(mk(p.port), 'h', 1);
    assert.strictEqual(sock.listenerCount('data'), 0);
    sock.destroy(); p.server.close();
  }

  // ---- BUG-001 (5) proxy từ chối: reject với dòng trạng thái và đóng socket ----
  {
    const p = await fakeProxy({ reply: ['HTTP/1.1 407 Proxy Authentication Required\r\nX: y\r\n\r\n'] });
    await assert.rejects(() => pm.connect(mk(p.port), 'h', 1), /HTTP proxy: HTTP\/1\.1 407 Proxy Authentication Required/);
    p.server.close();
  }

  // ---- BUG-005 id proxy không trùng sau khi nạp từ config ----
  {
    const m = new ProxyManager();
    m.loadFromConfig([
      { id: 'pxy_1', type: 'http', host: '1.1.1.1', port: 80 },
      { id: 'pxy_2', type: 'http', host: '2.2.2.2', port: 80 },
    ], {});
    const r = m.add('http://3.3.3.3:80');
    assert.ok(r.ok, r.msg);
    const ids = m.list.map(p => p.id);
    assert.deepStrictEqual(ids, ['pxy_1', 'pxy_2', 'pxy_3']);
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.ok(m.assignBot('bot-a', 'pxy_1'));
    assert.strictEqual(m.getAssignment('bot-a').host, '1.1.1.1', 'gán theo id phải ra đúng proxy cũ, không phải proxy mới');
    assert.ok(m.assignBot('bot-b', r.entry.id));
    assert.strictEqual(m.getAssignment('bot-b').host, '3.3.3.3');
  }
  // id không theo thứ tự / lẫn id lạ: lấy số lớn nhất + 1, id lạ không làm hỏng bộ đếm
  {
    const m = new ProxyManager();
    m.loadFromConfig([
      { id: 'pxy_7', type: 'http', host: '1.1.1.1', port: 80 },
      { id: 'custom', type: 'http', host: '2.2.2.2', port: 80 },
      { type: 'http', host: '4.4.4.4', port: 80 },          // chưa có id -> tự cấp
      { id: 'pxy_3', type: 'http', host: '5.5.5.5', port: 80 },
    ], {});
    const ids = m.list.map(p => p.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'trùng id: ' + ids);
    const r = m.add('http://3.3.3.3:80');
    assert.ok(!ids.includes(r.entry.id), `add() cấp lại id đã có: ${r.entry.id}`);
    assert.strictEqual(r.entry.id, 'pxy_9');
  }

  console.log('PROXY HTTP TESTS PASSED');
})().catch(e => { console.error(e); process.exit(1); });
