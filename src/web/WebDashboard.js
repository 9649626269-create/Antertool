'use strict';
const fs = require('fs');
const path = require('path');
class WebDashboard {
  constructor(botManager, options = {}) {
    this.manager = botManager;
    this.expressApp = options.expressApp;
    this.io = options.io;
    this.expressServer = options.expressServer;
    this.port = process.env.PORT || options.port || 3000;
    this.autoExe = options.autoExe || false;
    this._prevStatusSnap = '';
    this._statusInterval = null;
    this._metricsInterval = null;
  }
  start() {
    if (!this.expressApp || !this.io) {
      console.log('[Dashboard] express/socket.io không khả dụng');
      return;
    }
    this._prevStatusSnap = '';
    const publicDir = path.join(__dirname, 'public');
    try {
      fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
    } catch { }
    this.expressApp.use(require('express').static(publicDir, {
      maxAge: 0,
      setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
      },
    }));
    this.expressApp.get('/', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(publicDir, 'index.html'));
    });
    this.expressApp.use(require('express').json());
    this.expressApp.use('/api', (req, res, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });
    const _rateMap = new Map();
    const _rateLimit = (key, maxPerSec = 5) => {
      const now = Date.now();
      const bucket = _rateMap.get(key) || [];
      const recent = bucket.filter(t => now - t < 1000);
      recent.push(now);
      _rateMap.set(key, recent);
      return recent.length <= maxPerSec;
    };
    this._rateCleanup = setInterval(() => {
      const cutoff = Date.now() - 5000;
      for (const [key, bucket] of _rateMap) {
        const filtered = bucket.filter(t => t > cutoff);
        if (filtered.length) _rateMap.set(key, filtered);
        else _rateMap.delete(key);
      }
    }, 30000);
    if (this._rateCleanup.unref) this._rateCleanup.unref();
    this.expressApp.get('/api/bots', (req, res) => {
      res.json(this.manager.bots.map(b => b.getSummary()));
    });
    this.expressApp.post('/api/bots/all/cmd', (req, res) => {
      const { cmd } = req.body || {};
      if (!cmd) return res.status(400).json({ error: 'cmd required' });
      for (const b of this.manager.bots) b.cmd(String(cmd));
      res.json({ ok: true, count: this.manager.bots.length });
    });
    this.expressApp.post('/api/bots/all/start', (req, res) => {
      this.manager.startAll();
      res.json({ ok: true, count: this.manager.bots.length });
    });
    this.expressApp.post('/api/bots/all/stop', (req, res) => {
      this.manager.stopAll();
      res.json({ ok: true, count: this.manager.bots.length });
    });
    this.expressApp.get('/api/bots/:id', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      res.json({
        ...b.getSummary(),
        logs: b.getLogs(),
        inventory: b.state.inventory,
        customCmds: b.cmdRegistry.getCustomCmds(),
      });
    });
    this.expressApp.post('/api/bots/:id/cmd', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      const { cmd } = req.body || {};
      if (!cmd) return res.status(400).json({ error: 'cmd required' });
      b.cmd(String(cmd));
      res.json({ ok: true });
    });
    this.expressApp.post('/api/bots/:id/reconnect', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      b.forceReconnect();
      res.json({ ok: true });
    });
    this.expressApp.post('/api/bots/:id/start', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      if (b.isConnected || b.isReconnecting) {
        return res.status(409).json({ error: 'Bot đang chạy' });
      }
      b._disabled = false;
      b.state.reconnects = 0;
      b.start();
      if (this.io) this.io.emit('botState', { id: b.cfg.id, state: b.state.connState });
      res.json({ ok: true });
    });
    this.expressApp.post('/api/bots/:id/stop', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      b.shutdown();
      if (this.io) this.io.emit('botState', { id: b.cfg.id, state: b.state.connState });
      res.json({ ok: true });
    });
    this.expressApp.delete('/api/bots/:id', (req, res) => {
      const bot = this.manager.removeBot(req.params.id);
      if (!bot) return res.status(404).json({ error: 'Not found' });
      if (this.io) this.io.emit('botRemoved', { id: req.params.id });
      res.json({ ok: true });
    });
    this.expressApp.patch('/api/bots/:id', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      const allowed = ['autoMenu', 'menuCommand', 'respawn', 'ownerUsername', 'botPassword', 'useProxy', 'sendClientSettings', 'skipValidation', 'viewDistance', 'host', 'port', 'version', 'username'];
      const needsRestart = ['host', 'port', 'version', 'username'];
      let willNeedRestart = false;
      for (const k of allowed) {
        if (req.body[k] !== undefined) {
          b.cfg[k] = req.body[k];
          if (needsRestart.includes(k) && (b.isConnected || b.isReconnecting)) {
            willNeedRestart = true;
          }
        }
      }
      this._syncBotToConfig(b);
      res.json({
        ok: true,
        needsRestart: willNeedRestart,
        warning: willNeedRestart ? 'Thay đổi host/port/version/username cần restart bot để có hiệu lực' : undefined,
        cfg: { autoMenu: b.cfg.autoMenu, menuCommand: b.cfg.menuCommand, respawn: b.cfg.respawn, ownerUsername: b.cfg.ownerUsername, useProxy: b.cfg.useProxy, host: b.cfg.host, port: b.cfg.port, username: b.cfg.username, version: b.cfg.version }
      });
    });
    this.expressApp.post('/api/bots', (req, res) => {
      const { id, host, port, username, password, version, proxyIdx, proxyId } = req.body || {};
      if (!id || !host || !port || !username) {
        return res.status(400).json({ error: 'id, host, port, username required' });
      }
      if (this.manager.findBot(id)) {
        return res.status(409).json({ error: 'ID already exists' });
      }
      const b = this.manager.createBot({ id, host, port, username, password, version, proxyIdx, proxyId });
      if (this.io) this.io.emit('botAdded', b.getSummary());
      res.json({ ok: true, id: b.cfg.id });
    });
    this.expressApp.get('/api/proxies', (req, res) => {
      res.json(this.manager.proxyManager.getSummaries());
    });

    this.expressApp.post('/api/proxies', (req, res) => {
      const { proxy, tag } = req.body || {};
      if (!proxy) return res.status(400).json({ error: 'proxy required' });
      const r = this.manager.proxyManager.add(proxy, tag);
      res.json(r);
    });
    this.expressApp.post('/api/proxies/auto-add', async (req, res) => {
      const { proxy, tag } = req.body || {};
      if (!proxy) return res.status(400).json({ error: 'proxy required' });
      const r = await this.manager.proxyManager.autoAdd(proxy, tag);
      res.json(r);
    });
    this.expressApp.post('/api/proxies/detect', async (req, res) => {
      const { proxy, host, port } = req.body || {};
      let result;
      if (proxy) {
        result = await this.manager.proxyManager.detectType(proxy);
      } else if (host && port) {
        result = await this.manager.proxyManager.detectType(host, port);
      } else {
        return res.status(400).json({ error: 'proxy or host+port required' });
      }
      res.json(result);
    });
    this.expressApp.post('/api/proxies/test/:idx', async (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const result = await this.manager.proxyManager.test(idx);
      res.json(result);
    });
    this.expressApp.post('/api/proxies/enrich/:idx', async (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const result = await this.manager.proxyManager.enrichGeo(idx);
      res.json(result);
    });
    this.expressApp.post('/api/proxies/upgrade/:idx', async (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const result = await this.manager.proxyManager.upgrade(idx);
      res.json(result);
    });
    this.expressApp.post('/api/proxies/upgrade-all', async (req, res) => {
      const results = await this.manager.proxyManager.upgradeAll();
      res.json({ ok: true, results });
    });
    this.expressApp.delete('/api/proxies/:idx', (req, res) => {
      const idx = parseInt(req.params.idx, 10);
      const p = this.manager.proxyManager.remove(idx);
      if (!p) return res.status(404).json({ error: 'Invalid index' });
      res.json({ ok: true, removed: { host: p.host, port: p.port } });
    });
    this.expressApp.post('/api/bots/:id/assign-proxy', (req, res) => {
      const b = this.manager.findBot(req.params.id);
      if (!b) return res.status(404).json({ error: 'Not found' });
      const { proxyIdx, proxyId } = req.body || {};
      if ((proxyIdx === undefined || proxyIdx === null) && (proxyId === undefined || proxyId === null)) {
        this.manager.proxyManager.unassignBot(b.cfg.id);
        b.proxy = null;
        this._syncBotToConfig(b);
        return res.json({ ok: true });
      }
      const target = proxyId !== undefined ? proxyId : parseInt(proxyIdx, 10);
      if (!this.manager.proxyManager.assignBot(b.cfg.id, target)) {
        return res.status(400).json({ error: 'Invalid proxy' });
      }
      b.proxy = this.manager.proxyManager.getAssignment(b.cfg.id);
      this._syncBotToConfig(b);
      res.json({ ok: true });
    });
    this.expressApp.get('/api/system', (req, res) => {
      res.json(this.manager.getSystemMetrics());
    });
    this.expressApp.get('/api/capacity', (req, res) => {
      try {
        res.json(this.manager.getBotCapacity());
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
    this.expressApp.get('/api/server-env', (req, res) => {
      res.json(this.manager.env);
    });
    this.io.on('connection', sock => {
      const clientIp = sock.handshake?.address || sock.conn?.remoteAddress || 'unknown';
      sock.emit('init', {
        bots: this.manager.bots.map(b => b.getSummary()),
        serverEnv: this.manager.env,
        proxies: this.manager.proxyManager.getSummaries(),
        summary: this.manager.getSummary ? this.manager.getSummary() : null,
        capacity: this.manager.getBotCapacity ? this.manager.getBotCapacity() : null,
        webhook: { enabled: this.manager.notifier.enabled, events: [...this.manager.notifier.events] },
        revenueWebhook: { enabled: this.manager.revenueNotifier.enabled },
        schedule: this.manager.getSchedule(),
      });
      sock.on('subscribe', id => {
        try {
          if (!id || typeof id !== 'string') return;
          sock.join(`bot:${id}`);
          const b = this.manager.findBot(id);
          if (b) {
            sock.emit('logs', { id, logs: b.getLogs() });
            sock.emit('inventory', { id, items: b.state.inventory });
            sock.emit('customCmds', { id, cmds: b.cmdRegistry.getCustomCmds() });
          }
        } catch (e) {
        }
      });
      sock.on('unsubscribe', id => sock.leave(`bot:${id}`));
      sock.on('cmd', ({ id, cmd }) => {
        if (!id || cmd === undefined) return;
        if (!_rateLimit('cmd:' + id, 10)) {
          sock.emit('error', { code: 'RATE_LIMIT', message: 'Quá nhiều lệnh — vui lòng chậm lại' });
          return;
        }
        if (id === '*') {
          for (const bot of this.manager.bots) bot.cmd(String(cmd));
        } else {
          const b = this.manager.findBot(id);
          if (b) b.cmd(String(cmd));
        }
      });
      sock.on('reconnect_bot', ({ id }) => {
        if (!id) return;
        const b = this.manager.findBot(id);
        if (b) b.forceReconnect();
      });
      sock.on('startBot', ({ id }, cb) => {
        if (!id) { if (cb) cb({ ok: false, code: 'INVALID_ID', message: 'Thiếu ID bot' }); return; }
        if (!_rateLimit('startStop:' + id, 2)) {
          if (cb) cb({ ok: false, code: 'RATE_LIMIT', message: 'Vui lòng chậm lại' }); return;
        }
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, code: 'NOT_FOUND', message: 'Bot không tồn tại' }); return; }
        if (b.isConnected || b.isReconnecting) {
          if (cb) cb({ ok: false, code: 'ALREADY_RUNNING', message: 'Bot đang chạy rồi' });
          return;
        }
        b._disabled = false;
        b.state.reconnects = 0;
        b.start();
        this.io.emit('botState', { id, state: b.state.connState });
        if (cb) cb({ ok: true });
      });
      sock.on('stopBot', ({ id }, cb) => {
        if (!id) { if (cb) cb({ ok: false, code: 'INVALID_ID', message: 'Thiếu ID bot' }); return; }
        if (!_rateLimit('startStop:' + id, 2)) {
          if (cb) cb({ ok: false, code: 'RATE_LIMIT', message: 'Vui lòng chậm lại' }); return;
        }
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, code: 'NOT_FOUND', message: 'Bot không tồn tại' }); return; }
        b.shutdown();
        this.io.emit('botState', { id, state: b.state.connState });
        if (cb) cb({ ok: true });
      });
      sock.on('addBot', (data, cb) => {
        const { id, host, port, username, password, version, proxyIdx, proxyId } = data || {};
        if (!id || !host || !port || !username) {
          if (cb) cb({ ok: false, code: 'MISSING_FIELDS', message: 'Thiếu thông tin (id, host, port, username)' });
          return;
        }
        if (this.manager.findBot(id)) {
          if (cb) cb({ ok: false, code: 'DUPLICATE', message: 'ID đã tồn tại' });
          return;
        }
        const b = this.manager.createBot({ id, host, port, username, password, version, proxyIdx, proxyId });
        this.io.emit('botAdded', b.getSummary());
        if (cb) cb({ ok: true });
      });
      sock.on('editBot', (data, cb) => {
        const { id, host, port, username, password, version, useProxy, autoMenu, menuCommand, ownerUsername, proxyId, sendClientSettings, skipValidation, viewDistance } = data || {};
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, code: 'NOT_FOUND', message: 'Bot không tồn tại' }); return; }
        const allowed = { host, port, username, version, useProxy, autoMenu, menuCommand, ownerUsername, sendClientSettings, skipValidation, viewDistance };
        for (const [k, v] of Object.entries(allowed)) {
          if (v !== undefined && v !== null && v !== '') b.cfg[k] = v;
        }
        if (password !== undefined && password !== null && password !== '') {
          b.cfg.botPassword = password;
          b.cfg.registered = false;
        }
        if (proxyId !== undefined && proxyId !== null) {
          if (proxyId && proxyId !== '') {
            const assigned = this.manager.proxyManager.assignBot(b.cfg.id, proxyId);
            if (!assigned) {
              if (cb) cb({ ok: false, code: 'PROXY_NOT_FOUND', message: 'Proxy không tồn tại hoặc đã bị xóa' });
              return;
            }
            b.proxy = this.manager.proxyManager.getAssignment(b.cfg.id);
            b.cfg.useProxy = true;
          } else {
            this.manager.proxyManager.unassignBot(b.cfg.id);
            b.proxy = null;
            b.cfg.useProxy = false;
          }
        }
        this._syncBotToConfig(b);
        this.io.emit('botUpdated', b.getSummary());
        if (cb) cb({ ok: true });
      });
      sock.on('removeBot', ({ id }, cb) => {
        const bot = this.manager.removeBot(id);
        if (!bot) { if (cb) cb({ ok: false, code: 'NOT_FOUND', message: 'Bot không tồn tại' }); return; }
        this.io.emit('botRemoved', { id });
        if (cb) cb({ ok: true });
      });
      sock.on('addCustomCmd', ({ id, name, cmd }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, code: 'NOT_FOUND', message: 'Bot không tồn tại' }); return; }
        b.cmdRegistry.addCustom(name, cmd);
        this.io.emit('customCmds', { id, cmds: b.cmdRegistry.getCustomCmds() });
        if (cb) cb({ ok: true });
      });
      sock.on('delCustomCmd', ({ id, name }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, code: 'NOT_FOUND', message: 'Bot không tồn tại' }); return; }
        b.cmdRegistry.deleteCustom(name);
        this.io.emit('customCmds', { id, cmds: b.cmdRegistry.getCustomCmds() });
        if (cb) cb({ ok: true });
      });
      sock.on('getSystemMetrics', (cb) => {
        if (cb) cb(this.manager.getSystemMetrics());
      });
      sock.on('startAll', (data, cb) => {
        this.manager.startAll(typeof data?.filterFn === 'function' ? data.filterFn : null);
        if (cb) cb({ ok: true });
      });
      sock.on('stopAll', (data, cb) => {
        this.manager.stopAll(typeof data?.filterFn === 'function' ? data.filterFn : null);
        if (cb) cb({ ok: true });
      });
      sock.on('restartAll', (data, cb) => {
        this.manager.restartAll(typeof data?.filterFn === 'function' ? data.filterFn : null);
        if (cb) cb({ ok: true });
      });
      // ===== Macro Engine =====
      sock.on('getMacros', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        const macros = b.macroEngine.list().map(n => ({ name: n, next: b.cfg.macros?.[n]?.next || null }));
        if (cb) cb({ ok: true, macros, running: b.macroEngine.running, current: b.macroEngine.currentMacro, waitingAnswer: b.macroEngine.hasPendingQuestion, question: b.macroEngine.pendingQuestion });
      });
      sock.on('runMacro', ({ id, name }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        b.macroEngine.run(name).catch(() => { });
        if (cb) cb({ ok: true });
      });
      sock.on('stopMacro', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        b.macroEngine.stop();
        if (cb) cb({ ok: true });
      });
      sock.on('answerMacro', ({ id, text }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        const ok = b.macroEngine.answer(text || '');
        if (cb) cb({ ok, message: ok ? null : 'Không có câu hỏi nào đang chờ' });
      });
      // ===== Board / Đơn hàng =====
      sock.on('readBoard', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (!b.isOnline) { if (cb) cb({ ok: false, message: 'Bot chưa online' }); return; }
        const board = b.readBoard();
        if (cb) cb({ ok: true, board, money: b.state.money, shard: b.state.shard });
      });
      sock.on('getOrders', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (cb) cb({ ok: true, entries: b._lastOrderEntries || [], title: b._lastOrderTitle || '' });
      });
      // ===== Money Goal =====
      sock.on('setMoneyGoal', ({ id, amount, macro }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (amount === null || amount === undefined || amount === '') {
          b.moneyGoal = null; b.moneyGoalMacro = null; b._moneyGoalFired = false;
        } else {
          b.moneyGoal = Number(amount) || null;
          b.moneyGoalMacro = macro || null;
          b._moneyGoalFired = b.moneyGoal ? b.state.money >= b.moneyGoal : false;
        }
        b.cfg.moneyGoal = b.moneyGoal;
        b.cfg.moneyGoalMacro = b.moneyGoalMacro;
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true });
      });
      // ===== Auto-sell (đầy túi đồ) =====
      sock.on('setAutoSell', ({ id, threshold, macro }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (!macro) {
          b.autoSellMacro = null; b._autoSellFired = false;
        } else {
          b.autoSellThreshold = Number(threshold) || 90;
          b.autoSellMacro = macro;
          b._autoSellFired = false;
        }
        b.cfg.autoSellMacro = b.autoSellMacro;
        b.cfg.autoSellThreshold = b.autoSellThreshold;
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true });
      });
      // ===== Bảo vệ Lồng Spawn =====
      sock.on('getSpawnerProtect', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (cb) cb({ ok: true, on: b._spawnerProtectOn, range: b.spawnerProtectRange, spawners: b.protectedSpawners, whitelist: b.spawnerWhitelist,
          autoMine: b.spawnerAutoMine, autoDisconnect: b.spawnerAutoDisconnect, requireSilk: b.spawnerRequireSilk, enderCmd: b.enderChestCommand, saveRange: b.spawnerSaveRange });
      });
      sock.on('setSpawnerProtect', ({ id, on, range, autoMine, autoDisconnect, whitelist, requireSilk, enderCmd }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (typeof range === 'number') b.spawnerProtectRange = range;
        if (typeof autoMine === 'boolean') b.spawnerAutoMine = autoMine;
        if (typeof autoDisconnect === 'boolean') b.spawnerAutoDisconnect = autoDisconnect;
        if (Array.isArray(whitelist)) b.spawnerWhitelist = whitelist.map(s => String(s).toLowerCase());
        if (typeof requireSilk === 'boolean') b.spawnerRequireSilk = requireSilk;
        if (typeof enderCmd === 'string') b.enderChestCommand = enderCmd.trim();
        let message = null;
        if (on === true) {
          if (!b.isOnline) { if (cb) cb({ ok: false, on: false, message: 'Bot đang offline' }); return; }
          if (!b._startSpawnerProtect()) message = `Không thấy lồng nào trong ${b.spawnerSaveRange} block quanh bot — đứng sát lồng rồi bật lại`;
        } else if (on === false) b._stopSpawnerProtect();
        b.cfg.spawnerRequireSilk = b.spawnerRequireSilk;
        b.cfg.enderChestCommand = b.enderChestCommand;
        b.cfg.spawnerProtectRange = b.spawnerProtectRange;
        b.cfg.spawnerAutoMine = b.spawnerAutoMine;
        b.cfg.spawnerAutoDisconnect = b.spawnerAutoDisconnect;
        b.cfg.spawnerWhitelist = b.spawnerWhitelist;
        b.cfg.spawnerProtectOn = b._spawnerProtectOn;
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true, on: b._spawnerProtectOn, message, spawners: b.protectedSpawners });
      });
      sock.on('addSpawner', ({ id, x, y, z }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        let px = x, py = y, pz = z;
        if (px === undefined && b.mc?.entity?.position) ({ x: px, y: py, z: pz } = b.mc.entity.position);
        if (px === undefined) { if (cb) cb({ ok: false, message: 'Thiếu toạ độ (và bot chưa online để lấy vị trí hiện tại)' }); return; }
        px = Math.round(px); py = Math.round(py); pz = Math.round(pz);
        if (!b.protectedSpawners.some(p => p.x === px && p.y === py && p.z === pz)) {
          b.protectedSpawners.push({ x: px, y: py, z: pz });
          b.cfg.protectedSpawners = b.protectedSpawners;
          this._syncBotToConfig(b);
        }
        if (cb) cb({ ok: true, spawners: b.protectedSpawners });
      });
      sock.on('removeSpawner', ({ id, x, y, z }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        b.protectedSpawners = b.protectedSpawners.filter(p => !(p.x === Number(x) && p.y === Number(y) && p.z === Number(z)));
        b.cfg.protectedSpawners = b.protectedSpawners;
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true, spawners: b.protectedSpawners });
      });
      // ===== Auto-sell Spawn =====
      sock.on('getSellSpawn', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (cb) cb({ ok: true, ...b.getSellSpawnInfo() });
      });
      sock.on('setSellSpawn', ({ id, on, slot, button, second, minute, hour, range, revenue, msgKeyword, ignoreChat, reportMin }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (on === true && !b.isOnline) { if (cb) cb({ ok: false, on: false, message: 'Bot đang offline' }); return; }
        const r = b.configureSellSpawn({ on, slot, button, second, minute, hour, range, revenue, msgKeyword, ignoreChat, reportMin });
        this._syncBotToConfig(b);
        if (cb) cb({ ...r, ...b.getSellSpawnInfo() });
      });
      sock.on('runSellSpawnNow', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        const ok = b.runSellSpawnNow();
        if (cb) cb({ ok, message: ok ? null : 'Không chạy được (bot offline / đang bận / danh sách trống)' });
      });
      sock.on('scanSellSpawn', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (!b.isOnline) { if (cb) cb({ ok: false, message: 'Bot đang offline' }); return; }
        const added = b._scanSellSpawns();
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true, added, list: b.sellSpawnList });
      });
      sock.on('getRevenue', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (cb) cb({ ok: true, stats: b.getRevenueStats(), text: b.getRevenueText() });
      });
      sock.on('sendRevenueReport', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        const r = b.sendRevenueReportNow();
        if (cb) cb(r);
      });
      sock.on('resetRevenue', ({ id }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        b.resetRevenue();
        if (cb) cb({ ok: true });
      });
      sock.on('addSellSpawn', ({ id, x, y, z }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        const n = [x, y, z].map(Number);
        if (n.some(v => !Number.isFinite(v))) { if (cb) cb({ ok: false, message: 'Toạ độ không hợp lệ' }); return; }
        const [px, py, pz] = n.map(Math.round);
        if (!b.sellSpawnList.some(p => p.x === px && p.y === py && p.z === pz)) b.sellSpawnList.push({ x: px, y: py, z: pz });
        b._persistSellSpawnState();
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true, list: b.sellSpawnList });
      });
      sock.on('removeSellSpawn', ({ id, x, y, z }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        b.sellSpawnList = b.sellSpawnList.filter(p => !(p.x === Number(x) && p.y === Number(y) && p.z === Number(z)));
        b._persistSellSpawnState();
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true, list: b.sellSpawnList });
      });
      // ===== Proxy: nhập hàng loạt từ text + auto-rotate =====
      sock.on('addProxyText', ({ text, tag }, cb) => {
        if (!text) { if (cb) cb({ ok: false, message: 'Thiếu danh sách proxy' }); return; }
        const r = this.manager.proxyManager.addText(text, tag || null);
        this.io.emit('proxiesUpdated', this.manager.proxyManager.getSummaries());
        if (cb) cb(r);
      });
      sock.on('setProxyRotate', ({ id, on, minMinutes, maxMinutes }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        if (typeof minMinutes === 'number' && minMinutes > 0) b.proxyRotateMinMs = minMinutes * 60000;
        if (typeof maxMinutes === 'number' && maxMinutes > 0) b.proxyRotateMaxMs = Math.max(b.proxyRotateMinMs, maxMinutes * 60000);
        if (on === true) b._startProxyRotate(); else if (on === false) b._stopProxyRotate();
        b.cfg.proxyRotateMinMinutes = b.proxyRotateMinMs / 60000;
        b.cfg.proxyRotateMaxMinutes = b.proxyRotateMaxMs / 60000;
        b.cfg.proxyAutoRotate = b.proxyAutoRotate;
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true });
      });
      // ===== Discord Webhook (toàn cục) =====
      sock.on('setWebhook', ({ url, events }, cb) => {
        this.manager.notifier.configure(url || null, Array.isArray(events) ? events : undefined);
        this.manager.persistence.set('webhookUrl', url || null);
        if (Array.isArray(events)) this.manager.persistence.set('webhookEvents', events);
        if (cb) cb({ ok: true });
      });
      sock.on('testWebhook', async (data, cb) => {
        if (!this.manager.notifier.enabled) { if (cb) cb({ ok: false, message: 'Chưa cấu hình webhook' }); return; }
        const ok = await this.manager.notifier.test();
        if (cb) cb({ ok });
      });
      // ===== Webhook RIÊNG cho báo cáo doanh thu =====
      sock.on('setRevenueWebhook', ({ url }, cb) => {
        const u = url ? String(url).trim() : null;
        this.manager.revenueNotifier.configure(u || null, ['all']);
        this.manager.persistence.set('revenueWebhookUrl', u || null);
        if (cb) cb({ ok: true, enabled: !!u });
      });
      sock.on('testRevenueWebhook', async (data, cb) => {
        if (!this.manager.revenueNotifier.enabled) { if (cb) cb({ ok: false, message: 'Chưa đặt webhook doanh thu riêng' }); return; }
        const ok = await this.manager.revenueNotifier.test();
        if (cb) cb({ ok });
      });
      // ===== Lịch tự out/vào theo giờ =====
      sock.on('setSchedule', ({ enabled, outTime, inTime }, cb) => {
        const s = this.manager.setSchedule(!!enabled, outTime, inTime);
        if (cb) cb({ ok: true, schedule: s });
      });
      // ===== Đăng nhập acc Premium (Microsoft) =====
      sock.on('setAuthMode', ({ id, authMode }, cb) => {
        const b = this.manager.findBot(id);
        if (!b) { if (cb) cb({ ok: false, message: 'Bot không tồn tại' }); return; }
        b.cfg.authMode = authMode === 'microsoft' ? 'microsoft' : 'offline';
        this._syncBotToConfig(b);
        if (cb) cb({ ok: true, needsRestart: b.isConnected || b.isReconnecting });
      });
      sock.on('disconnect', reason => {
        const reasonMap = {
          'transport close': 'transport_close',
          'ping timeout': 'ping_timeout',
          'transport error': 'transport_error',
          'server namespace disconnect': 'server_ns_disconnect',
          'client namespace disconnect': 'client_ns_disconnect',
        };
        const code = reasonMap[reason] || reason;
        if (!process.env.SILENT_SOCKET) {
          console.log(`[Socket] Client disconnected (${clientIp}): ${code}`);
        }
      });
    });
    const statusInterval = this.manager.profile?.statusInterval || 1500;
    const metricsInterval = this.manager.profile?.metricsInterval || 3000;
    this._statusInterval = setInterval(() => {
      if (!this.io || this.io.engine.clientsCount === 0) return;
      const summaries = this.manager.bots.map(b => b.getSummary());
      const hashParts = summaries.map(s =>
        `${s.id}|${s.state}|${s.ping}|${s.ppsIn}|${s.ppsOut}|${s.health}|${s.food}|${s.shard}|${s.reconnects}|${s.afk || ''}|${s.position?.x?.toFixed(1) || ''}`
      ).join(';');
      if (hashParts === this._prevStatusSnap) return;
      this._prevStatusSnap = hashParts;
      if (summaries.length > 50) {
        setImmediate(() => {
          this.io.emit('statusUpdate', { bots: summaries });
        });
      } else {
        this.io.emit('statusUpdate', { bots: summaries });
      }
    }, statusInterval);
    this._metricsInterval = setInterval(() => {
      if (!this.io || this.io.engine.clientsCount === 0) return;
      this.io.emit('systemMetrics', this.manager.getSystemMetrics());
    }, metricsInterval);
    if (this._statusInterval.unref) this._statusInterval.unref();
    if (this._metricsInterval.unref) this._metricsInterval.unref();
    this.expressServer.listen(this.port, () => {
      const url = `http://localhost:${this.port}`;
      if (this.autoExe) {
        console.log(`\x1b[36m╔══════════════════════════════════════╗\x1b[0m`);
        console.log(`\x1b[36m║  ⬡   Bot Manager — Antares       ║\x1b[0m`);
        console.log(`\x1b[36m╠══════════════════════════════════════╣\x1b[0m`);
        console.log(`\x1b[36m║  Web Dashboard:                      ║\x1b[0m`);
        console.log(`\x1b[36m║  \x1b[33m${url.padEnd(36)}\x1b[36m║\x1b[0m`);
        console.log(`\x1b[36m╚══════════════════════════════════════╝\x1b[0m`);
      } else {
        console.log(`\x1b[36m[Dashboard] Web UI: ${url}\x1b[0m`);
      }
    });
  }
  shutdown() {
    if (this._statusInterval) clearInterval(this._statusInterval);
    if (this._metricsInterval) clearInterval(this._metricsInterval);
    if (this._rateCleanup) clearInterval(this._rateCleanup);
  }
  _syncBotToConfig(bot) {
    if (!this.manager._config?.bots) return;
    const cfgBot = this.manager._config.bots.find(c => c.id.toLowerCase() === bot.cfg.id.toLowerCase());
    if (cfgBot) {
      for (const k of Object.keys(bot.cfg)) {
        if (bot.cfg[k] !== undefined) cfgBot[k] = bot.cfg[k];
      }
    }
    this.manager.persistence.markDirty();
    this.manager.persistence.saveSync();
  }
}
module.exports = WebDashboard;
