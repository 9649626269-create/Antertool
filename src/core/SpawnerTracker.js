'use strict';
// SpawnerTracker — port của SpawnerESP + TrackedSpawner từ ClowingAddon (Meteor mod).
// Quét lồng trong chunk đã load, phân loại NATURAL / SMP, tích hợp với SpawnerGuard.js.
//
// Mineflayer types sử dụng:
//   bot.entity        → { position: {x,y,z} }
//   bot.world.getColumn(chunkX, chunkZ)  → truthy nếu chunk đã load
//   bot.blockAt({x,y,z})                → Block | null  (block.name, block.type)
//   bot.world.getBlockEntity({x,y,z})   → Object NBT | null
//   EntityType string  → bot.registry.entitiesByName[name]
//
// Import:
//   const SpawnerTracker = require('./SpawnerTracker');
//   const tracker = new SpawnerTracker(bot, options);
//   tracker.start(); tracker.stop();
//   tracker.on('spawner_found', ({ spawner }) => { ... });
//   tracker.on('spawner_removed', ({ pos, key }) => { ... });

const EventEmitter = require('events');

// ---- TrackedSpawner (Java Record port) ----
// Tương đương: lIIlIIIIlIIIIIIIIIII (Java Record)
// fields: pos, mobLabel, distanceBlocks, spawnedType, isSMP
class TrackedSpawner {
  /**
   * @param {{x:number,y:number,z:number}} pos
   * @param {string} mobLabel        tên mob hiển thị
   * @param {number} distanceBlocks  khoảng cách tới bot
   * @param {string} spawnedType     entity type id (vd 'zombie', 'blaze')
   * @param {boolean} isSMP          phát hiện là lồng SMP (short max value heuristic)
   */
  constructor(pos, mobLabel, distanceBlocks, spawnedType, isSMP) {
    this.pos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) };
    this.mobLabel = String(mobLabel || 'Unknown');
    this.distanceBlocks = Number(distanceBlocks) || 0;
    this.spawnedType = String(spawnedType || 'unknown');
    this.isSMP = Boolean(isSMP);
    Object.freeze(this.pos);
  }

  // Java Record toString() port: "-pos;mobLabel;distanceBlocks;spawnedType;isSMP"
  toString() {
    const { x, y, z } = this.pos;
    return `-${x},${y},${z};${this.mobLabel};${this.distanceBlocks.toFixed(1)};${this.spawnedType};${this.isSMP}`;
  }

  // Key duy nhất cho Map
  get key() { return posKey(this.pos); }
}

// ---- Helpers ----
function posKey(pos) { return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`; }

function distTo(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---- isSMPSpawner heuristic (port từ lIlIlIIIlIIIIIIIIIII.isSMPSpawner) ----
// Java gốc: đọc 3 short NBT từ spawner block entity, kiểm tra:
//   short1 == Short.MAX_VALUE (32767) AND short2 == Short.MAX_VALUE AND short3 == 0
// Ba NBT key bị obfuscate bằng string decryptor, nhưng từ pattern so sánh:
//   - short1, short2 = 32767 → MinSpawnDelay = MaxSpawnDelay = 32767 (server set max)
//   - short3 = 0             → Delay = 0 (lồng đang active, spawn ngay)
// Đây là signature của spawner được configure bởi plugin SMP (EssentialsX Spawner, etc.)
function isSMPSpawner(nbt) {
  if (!nbt || typeof nbt !== 'object') return false;

  // mineflayer NBT thường là object có dạng: { MinSpawnDelay: {value:N}, MaxSpawnDelay: {value:N}, Delay: {value:N}, ... }
  // hoặc flat: { MinSpawnDelay: N, MaxSpawnDelay: N, Delay: N }
  function getShort(obj, ...keys) {
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined || v === null) continue;
      const n = (typeof v === 'object' && v !== null) ? (v.value ?? v.Value) : v;
      const num = Number(n);
      if (Number.isFinite(num)) return num;
    }
    return null;
  }

  const minDelay = getShort(nbt, 'MinSpawnDelay', 'minSpawnDelay');
  const maxDelay = getShort(nbt, 'MaxSpawnDelay', 'maxSpawnDelay');
  const delay    = getShort(nbt, 'Delay', 'delay');

  // short1 == 32767 AND short2 == 32767 AND short3 == 0
  return minDelay === 32767 && maxDelay === 32767 && delay === 0;
}

// ---- Lấy entity type từ spawner NBT ----
// SpawnData.entity.id  hoặc  SpawnData.id  (NBT format thay đổi theo MC version)
function spawnerEntityType(nbt) {
  if (!nbt || typeof nbt !== 'object') return 'unknown';

  function tryGet(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const id = obj.id || (obj.value && obj.value.id);
    if (id) {
      const s = typeof id === 'object' ? (id.value || id.Value) : id;
      if (s) return String(s).replace(/^minecraft:/, '').toLowerCase();
    }
    return null;
  }

  // Try SpawnData.entity.id (1.19+)
  const sd = nbt.SpawnData || nbt.spawnData;
  if (sd) {
    const ent = (sd.value || sd).entity || sd;
    const r = tryGet(ent);
    if (r) return r;
  }

  // Try SpawnPotentials[0].data.entity.id (legacy)
  const sp = nbt.SpawnPotentials || nbt.spawnPotentials;
  if (Array.isArray(sp) && sp.length > 0) {
    const first = sp[0];
    const data = (first.value || first).data || first;
    const ent = data.entity || data;
    const r = tryGet(ent);
    if (r) return r;
  }

  return 'unknown';
}

// Mob label hiển thị (capitalize + chuyển _ thành space)
function mobLabel(typeId) {
  return typeId === 'unknown' ? 'Unknown'
    : typeId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---- mergeNearbySpawners (port từ lIIllIIIIlIIIIIIIIII.mergeNearbySpawners) ----
// Nhóm các spawner trong vòng `mergeRadius` block lại với nhau (theo spawner gần nhất đã biết).
// Trả về Map<key, TrackedSpawner> sau khi gộp — spawner xa nhau vẫn giữ nguyên.
function mergeNearbySpawners(spawners, mergeRadius = 4) {
  const result = new Map();
  const processed = new Set();

  for (const [key, s] of spawners) {
    if (processed.has(key)) continue;
    // Tìm tất cả spawner trong bán kính mergeRadius
    const group = [s];
    for (const [k2, s2] of spawners) {
      if (k2 !== key && !processed.has(k2) && distTo(s.pos, s2.pos) <= mergeRadius) {
        group.push(s2);
        processed.add(k2);
      }
    }
    processed.add(key);
    // Giữ spawner gần bot nhất trong nhóm làm đại diện
    const rep = group.reduce((a, b) => a.distanceBlocks <= b.distanceBlocks ? a : b);
    result.set(rep.key, rep);
  }
  return result;
}

// ---- SpawnerTracker ----
// Phát sự kiện: 'spawner_found', 'spawner_removed', 'scan_done'
class SpawnerTracker extends EventEmitter {
  /**
   * @param {object} bot           mineflayer bot instance
   * @param {object} [options]
   * @param {number} [options.scanRadiusChunks=4]   bán kính quét tính bằng chunk (1 chunk = 16 block)
   * @param {number} [options.scanTickInterval=5]   số game tick giữa 2 lần quét (20 tick = 1s)
   * @param {string} [options.filter='BOTH']        'NATURAL' | 'SMP' | 'BOTH'
   * @param {boolean}[options.mergeEnabled=true]    gộp spawner kề nhau
   * @param {number} [options.mergeRadius=4]        bán kính gộp (block)
   */
  constructor(bot, options = {}) {
    super();
    this.bot = bot;
    this.opt = {
      scanRadiusChunks: options.scanRadiusChunks ?? 4,
      scanTickInterval: options.scanTickInterval ?? 5,
      filter: (options.filter || 'BOTH').toUpperCase(),
      mergeEnabled: options.mergeEnabled !== false,
      mergeRadius: options.mergeRadius ?? 4,
    };
    // Map<posKey, TrackedSpawner>
    this.spawners = new Map();
    this._tickCount = 0;
    this._active = false;
    this._onTick = this._onTick.bind(this);
  }

  start() {
    if (this._active) return;
    this._active = true;
    this.bot.on('physicsTick', this._onTick);
  }

  stop() {
    if (!this._active) return;
    this._active = false;
    this.bot.off('physicsTick', this._onTick);
  }

  // Xoá bảng theo dõi (vd khi respawn / đổi thế giới)
  reset() {
    this.spawners.clear();
  }

  // Truy vấn danh sách hiện tại (bản sao)
  getSpawners() {
    return new Map(this.spawners);
  }

  // ---- internal ----
  _onTick() {
    this._tickCount++;
    if (this._tickCount < this.opt.scanTickInterval) return;
    this._tickCount = 0;
    this._scan();
  }

  _scan() {
    const bot = this.bot;
    if (!bot.entity || !bot.entity.position || !bot.registry?.blocksByName) return;
    const pos = bot.entity.position;
    const r = this.opt.scanRadiusChunks * 16;
    const ids = ['mob_spawner', 'spawner']
      .map(name => bot.registry.blocksByName[name]?.id)
      .filter(id => id !== undefined);
    if (!ids.length) return;
    const found = new Set();
    let positions = [];
    // Mineflayer findBlocks searches loaded blocks efficiently. Avoid walking every
    // block in every chunk on each scan, which would cause severe client-side lag.
    try { positions = bot.findBlocks({ matching: ids, maxDistance: r, count: 512 }); }
    catch (e) { this.emit('scan_error', e); return; }
    for (const p of positions) {
      let block;
      try { block = bot.blockAt(p); } catch { continue; }
      if (!block || (block.name !== 'mob_spawner' && block.name !== 'spawner')) continue;
      this._handleSpawner(p.x, p.y, p.z, pos, found);
    }
    for (const [key] of this.spawners) {
      if (!found.has(key)) {
        this.spawners.delete(key);
        this.emit('spawner_removed', { key });
      }
    }
    if (this.opt.mergeEnabled) this.spawners = mergeNearbySpawners(this.spawners, this.opt.mergeRadius);
    this.emit('scan_done', { count: this.spawners.size });
  }

  _handleSpawner(bx, by, bz, playerPos, found) {
    const bot = this.bot;
    const sPos = { x: bx, y: by, z: bz };
    const key = posKey(sPos);

    // Lấy NBT block entity
    let nbt = null;
    try {
      nbt = bot.world.getBlockEntity
        ? bot.world.getBlockEntity(sPos)
        : (bot.blockEntityAt ? bot.blockEntityAt(sPos) : null);
    } catch { /* chunk chưa ready */ }

    const smp = isSMPSpawner(nbt);

    // Filter: NATURAL = chỉ lấy lồng tự nhiên, SMP = chỉ lấy lồng SMP
    const { filter } = this.opt;
    if (filter === 'NATURAL' && smp) return;
    if (filter === 'SMP' && !smp) return;

    const entityType = spawnerEntityType(nbt);
    const label = mobLabel(entityType);
    const dist = distTo({ x: bx + 0.5, y: by + 0.5, z: bz + 0.5 }, playerPos);

    const existing = this.spawners.get(key);
    const updated = new TrackedSpawner(sPos, label, dist, entityType, smp);

    // Chỉ emit 'spawner_found' nếu lần đầu phát hiện
    if (!existing) {
      this.spawners.set(key, updated);
      this.emit('spawner_found', { spawner: updated });
    } else {
      // Cập nhật khoảng cách (label/type không đổi)
      if (Math.abs(existing.distanceBlocks - dist) > 0.5) {
        this.spawners.set(key, updated);
      }
    }
    found.add(key);
  }
}

module.exports = {
  TrackedSpawner,
  SpawnerTracker,
  isSMPSpawner,
  spawnerEntityType,
  mobLabel,
  mergeNearbySpawners,
  posKey,
};
