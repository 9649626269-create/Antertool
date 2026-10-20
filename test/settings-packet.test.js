'use strict';
// Kiểm tra gói `settings` dựng theo tên trường của phiên bản (không cần mineflayer thật: stub các module ngoài)
const Module = require('module');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  try { return origLoad.call(this, req, parent, isMain); }
  catch (e) { if (e.code === 'MODULE_NOT_FOUND' && !req.startsWith('.')) return new Proxy(function () { }, { get: () => function () { } }); throw e; }
};
const assert = require('assert');
const BotSession = require('../src/core/BotSession');
const proto = BotSession.prototype;
const field = (name, type = 'varint') => ({ name, type });
const registry = { protocol: { play: { toServer: { types: { packet_settings: ['container', [
  field('locale', ['pstring', {}]), field('viewDistance', 'i8'), field('chatFlags'), field('chatColors', 'bool'),
  field('skinParts', 'u8'), field('mainHand'), field('enableTextFiltering', 'bool'), field('enableServerListing', 'bool'), field('particleStatus'), field('futureField', 'bool'),
]] } } } } };
const mk = (cfg) => ({ cfg, _buildSettingsPacket: proto._buildSettingsPacket });

let p = mk({})._buildSettingsPacket({ registry });
assert.strictEqual(p.skinParts, 127, 'mặc định (vanilla): skinParts=127 như client thật');
assert.strictEqual(p.enableServerListing, true);
assert.strictEqual(p.viewDistance, 2); assert.strictEqual(p.chatColors, true); assert.strictEqual(p.mainHand, 1);
assert.strictEqual(p.futureField, false, 'trường lạ kiểu bool -> false');
let l = mk({ settingsProfile: 'legacy' })._buildSettingsPacket({ registry });
assert.strictEqual(l.skinParts, 0, 'legacy: như fix2'); assert.strictEqual(l.enableServerListing, false);
assert.strictEqual(mk({})._buildSettingsPacket({ registry: {} }), null, 'không có định nghĩa -> null (fallback setSettings)');
// phiên bản mặc định: để trống KHÔNG được thành "tự dò" (server sau Velocity sẽ dò ra giao thức mới hơn server thật)
const { resolveVersion, DEFAULT_MC_VERSION } = require('../src/core/constants');
assert.strictEqual(DEFAULT_MC_VERSION, '1.21.11');
assert.strictEqual(resolveVersion(undefined, '', null), '1.21.11');
assert.strictEqual(resolveVersion('1.20.4', '1.21.1'), '1.20.4');
assert.strictEqual(resolveVersion('', '1.21.1'), '1.21.1');
assert.strictEqual(resolveVersion('auto'), undefined, '"auto" = cố ý tự dò');
console.log('settings-packet.test OK');
