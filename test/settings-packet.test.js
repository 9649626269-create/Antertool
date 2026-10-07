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

let p = mk({}); p = p._buildSettingsPacket({ registry });
assert.strictEqual(p.skinParts, 0, 'legacy: skinParts=0 (như fix2)');
assert.strictEqual(p.enableServerListing, false, 'legacy: serverListing=false (như fix2)');
assert.strictEqual(p.viewDistance, 2); assert.strictEqual(p.chatColors, true); assert.strictEqual(p.mainHand, 1);
assert.strictEqual(p.futureField, false, 'trường lạ kiểu bool -> false');
let v = mk({ settingsProfile: 'vanilla' })._buildSettingsPacket({ registry });
assert.strictEqual(v.skinParts, 127); assert.strictEqual(v.enableServerListing, true);
assert.strictEqual(mk({})._buildSettingsPacket({ registry: {} }), null, 'không có định nghĩa -> null (fallback setSettings)');
console.log('settings-packet.test OK');
