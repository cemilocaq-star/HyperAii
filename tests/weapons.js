// Weapon registry / ownership / switch tests (13 real models, 1 archetype).
const path = require('path'); const fs = require('fs');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const { rooms, WEAPONS, getWeapon, HIT_CONFIG, SHOOT_CONFIG, WEAPON_SWITCH_COOLDOWN_MS, MATCH_CONFIG } = startServer.__test__;

function mk() {
  const a = connect('a'), b = connect('b'); const ta = hello(a), tb = hello(b);
  a.emitMessage({ type: 'create_room', name: 'A', maxPlayers: 4 }); const code = a.lastOfType('room_created').code;
  b.emitMessage({ type: 'join_room', roomCode: code, name: 'B' }); b.emitMessage({ type: 'player_ready' }); a.emitMessage({ type: 'start_game' });
  return { a, b, ta, tb, room: rooms[code] };
}
test('weapons: registry has exactly the 13 audited models and every model file exists on disk', () => {
  const ids = Object.keys(WEAPONS); assertEqual(ids.length, 13, 'model count is 13, not 94');
  for (const id of ids) assert(fs.existsSync(path.join(__dirname, '..', 'public', WEAPONS[id].model)), id + ' model file missing');
});
test('weapons: stats come from existing server config (nothing invented)', () => {
  for (const w of Object.values(WEAPONS)) { assertEqual(w.damage, HIT_CONFIG.baseDamage); assertEqual(w.fireIntervalMs, SHOOT_CONFIG.minIntervalMs); }
});
test('weapons: getWeapon rejects hostile / malformed ids (proto pollution, non-strings)', () => {
  for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'w999', 'W001', null, undefined, 1, {}, [], ['w001'], NaN])
    assertEqual(getWeapon(bad), null, 'accepted ' + String(bad));
  assert(getWeapon('w001'), 'w001 valid');
});
test('weapons: equip is server-validated, synced to client and public state', () => {
  const m = mk(); m.a.emitMessage({ type: 'equip_weapon', weaponId: 'w005' });
  assertEqual(m.room.players[m.ta].weaponId, 'w005'); assertEqual(m.a.lastOfType('weapon_ok').weaponId, 'w005');
  assertEqual(m.b.lastOfType('weapon_changed').weaponId, 'w005');
  assertEqual(startServer.__test__.buildPlayerPublicState(m.room, m.room.players[m.ta]).weaponId, 'w005');
  startServer.__test__.shutdownAllRooms();
});
test('weapons: malformed weaponId never changes state and never throws', () => {
  const m = mk();
  for (const bad of ['__proto__', 'nope', null, 5, {}, [], NaN, 'w001'.repeat(1000)]) m.a.emitMessage({ type: 'equip_weapon', weaponId: bad });
  m.a.emitMessage({ type: 'equip_weapon' }); m.a.emitMessage({ type: 'equip_weapon', weaponId: { toString: () => 'w002' } });
  assertEqual(m.room.players[m.ta].weaponId, 'w001'); startServer.__test__.shutdownAllRooms();
});
test('weapons: switch cooldown (spam) and dead players cannot switch', () => {
  const m = mk(); m.a.emitMessage({ type: 'equip_weapon', weaponId: 'w002' }); m.a.emitMessage({ type: 'equip_weapon', weaponId: 'w003' });
  assertEqual(m.room.players[m.ta].weaponId, 'w002'); assertEqual(m.a.lastOfType('weapon_rejected').reason, 'COOLDOWN');
  m.room.players[m.ta].lastWeaponSwitchAt = 0; m.room.players[m.ta].alive = false; m.a.emitMessage({ type: 'equip_weapon', weaponId: 'w004' });
  assertEqual(m.room.players[m.ta].weaponId, 'w002'); startServer.__test__.shutdownAllRooms();
});
test('weapons: cross-room — equip in room A never touches room B', () => {
  const a = mk(), b = mk(); a.a.emitMessage({ type: 'equip_weapon', weaponId: 'w009' });
  assertEqual(b.room.players[b.ta].weaponId, 'w001'); assert(!b.b.lastOfType('weapon_changed'), 'leaked'); startServer.__test__.shutdownAllRooms();
});
test('weapons: client-supplied damage/ammo fields are ignored; damage comes from registry', () => {
  const m = mk(); m.a.emitMessage({ type: 'equip_weapon', weaponId: 'w003', damage: 9999, ammo: 999 });
  m.a.emitMessage({ type: 'hit', targetId: m.tb, damage: 9999 });
  assertEqual(m.room.players[m.tb].health, 100 - WEAPONS.w003.damage); startServer.__test__.shutdownAllRooms();
});
test('weapons: weapon resets to default on new match; switch cleanup leaves no timers', () => {
  const m = mk(); m.a.emitMessage({ type: 'equip_weapon', weaponId: 'w007' });
  startServer.__test__.endMatch(m.room, 'TIME'); m.a.emitMessage({ type: 'rematch' });
  assertEqual(m.room.players[m.ta].weaponId, 'w001'); startServer.__test__.shutdownAllRooms();
});
