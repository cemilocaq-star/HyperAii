// Phase 7 — cosmetic registry validation + customization synchronization.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const { rooms, COSMETICS, COSMETIC_SLOTS, buildPlayerPublicState } = require(path.join(__dirname, '..', 'server.js')).__test__;

const NEW_SLOTS = ['skin', 'outfit', 'head', 'hair'];
const OLD_SLOTS = ['color', 'accessory', 'badge', 'title', 'emote', 'deathEffect'];

test('cosmetic registry: all required slots exist (old preserved + 4 new)', () => {
  for (const t of [...OLD_SLOTS, ...NEW_SLOTS]) assert(COSMETIC_SLOTS[t], 'missing slot ' + t);
  assertEqual(COSMETIC_SLOTS.color.field, 'equippedColor', 'old field names unchanged');
  assertEqual(COSMETIC_SLOTS.emote.fallback, 'emoteWave');
});

test('cosmetic registry: every entry is well-formed (id matches key, known type, valid visual)', () => {
  for (const [key, c] of Object.entries(COSMETICS)) {
    assertEqual(c.id, key, 'id/key mismatch: ' + key);
    assert(COSMETIC_SLOTS[c.type], key + ' has unknown type ' + c.type);
    assert(typeof c.name === 'string', key + ' name');
    assert(typeof c.enabled === 'boolean', key + ' enabled');
    if (c.visual) {
      assert(typeof c.visual === 'object', key + ' visual');
      if (c.visual.shape) assert(['torus', 'sphere', 'box', 'spikes', 'model', 'bodyModel'].includes(c.visual.shape), key + ' bad shape');
      if (c.visual.color) assert(/^#[0-9a-f]{6}$/i.test(c.visual.color), key + ' bad color');
    }
  }
});

test('cosmetic registry: every slot fallback exists, matches type and is free (no unlock)', () => {
  for (const [type, slot] of Object.entries(COSMETIC_SLOTS)) {
    if (type === 'deathEffect') continue; // 'default' death effect predates the registry
    const c = COSMETICS[slot.fallback];
    assert(c && c.type === type, `${type} fallback ${slot.fallback} invalid`);
    assert(!c.unlockRequirement, `${type} fallback must be unlocked by default`);
  }
});

test('customization: each new slot can be equipped and shows up in the public state', () => {
  const a = connect('a'); const at = hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = a.lastOfType('room_created').code;
  const picks = { skin: 'skinChrome', outfit: 'outfitBelt', head: 'headCube', hair: 'hairSpiky' };
  for (const id of Object.values(picks)) {
    a.emitMessage({ type: 'equip_cosmetic', cosmeticId: id });
    assertEqual(a.lastOfType('equip_ok').cosmeticId, id);
  }
  const st = buildPlayerPublicState(rooms[code], rooms[code].players[at]);
  for (const t of NEW_SLOTS) assertEqual(st[t], picks[t], t + ' must be synced to other clients');
  for (const k of ['color', 'accessory', 'badge', 'title']) assert(k in st, 'old key still broadcast: ' + k);
});

test('customization: another client in the room sees the same equipped ids', () => {
  const a = connect('a'); hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = a.lastOfType('room_created').code;
  const b = connect('b'); const bt = hello(b);
  b.emitMessage({ type: 'join_room', roomCode: code });
  b.emitMessage({ type: 'equip_cosmetic', cosmeticId: 'hairAfro' });
  const seenByA = buildPlayerPublicState(rooms[code], rooms[code].players[bt]);
  assertEqual(seenByA.hair, 'hairAfro');
});

test('customization: join with cosmetics applies valid new-slot picks, falls back on invalid', () => {
  const a = connect('a'); hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4, cosmetics: { skin: 'skinNeon', hair: 'colorGold', head: 12345, outfit: 'nope' } });
  const code = a.lastOfType('room_created').code;
  const p = Object.values(rooms[code].players)[0];
  assertEqual(p.equippedSkin, 'skinNeon');
  assertEqual(p.equippedHair, 'hairNone', 'wrong-type id rejected');
  assertEqual(p.equippedHead, 'headDefault', 'non-string rejected');
  assertEqual(p.equippedOutfit, 'outfitNone', 'unknown id rejected');
});

test('customization: malformed / prototype-pollution-style ids are rejected safely', () => {
  const a = connect('a'); hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, undefined, 5, {}, [], 'x'.repeat(500)]) {
    a.emitMessage({ type: 'equip_cosmetic', cosmeticId: bad });
    const r = a.lastOfType('equip_rejected');
    assert(r && r.reason === 'UNKNOWN', 'not rejected: ' + JSON.stringify(bad));
    assert(r.cosmeticId === null || r.cosmeticId.length <= 40, 'echoed id must be bounded');
  }
});

test('customization: locked items still cannot be equipped (existing rule preserved)', () => {
  const a = connect('a'); hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  a.emitMessage({ type: 'equip_cosmetic', cosmeticId: 'colorGold' });
  assertEqual(a.lastOfType('equip_rejected').reason, 'LOCKED');
});

test('customization: public catalog exposes visual descriptors for the client', () => {
  const a = connect('a');
  a.emitMessage({ type: 'hello' });
  const cat = a.lastOfType('hello_ok').catalog;
  assert(cat.skinChrome && cat.skinChrome.visual && cat.skinChrome.visual.metalness === 0.9);
  assert(cat.hairSpiky.visual.shape === 'spikes');
});
