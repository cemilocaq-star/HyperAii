// Weapon slots (gun -> knife -> bomb): server-authoritative state, knife melee, thrown bomb with an area explosion.
// The numbers under test (KNIFE_CONFIG / BOMB_CONFIG) are DESIGN VALUES chosen on request; the tests pin the BEHAVIOUR, and read the values from the config.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const T = startServer.__test__;
const { KNIFE_CONFIG: K, BOMB_CONFIG: B, BANANA_CONFIG: BC, stepBananas, throwBomb, explodeBomb, slotOf } = T;

function mk(n, opts) {
  const ws = [], tok = [];
  const h = connect('h'); tok.push(hello(h)); ws.push(h);
  h.emitMessage({ type: 'create_room', name: 'Own', maxPlayers: 8, ...(opts || {}) });
  const code = h.lastOfType('room_created').code;
  for (let i = 1; i < n; i++) { const g = connect('p' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); ws.push(g); g.emitMessage({ type: 'player_ready' }); }
  const saved = T.MATCH_CONFIG.countdownMs; T.MATCH_CONFIG.countdownMs = 0;
  try { h.emitMessage({ type: 'start_game' }); } finally { T.MATCH_CONFIG.countdownMs = saved; }
  const room = T.rooms[code];
  const place = (i, x, z) => { const p = room.players[tok[i]]; p.x = x; p.y = 1.6; p.z = z; };
  place(0, 0, 20); if (n > 1) place(1, 0, 18.5); if (n > 2) place(2, 0, 30);
  return { code, room, ws, tok, p: (i) => room.players[tok[i]], place };
}
const aim = () => ({ origin: [0, 1.6, 20], dir: [0, 0, -1] });
const slash = (m, a, v) => { const p = m.p(a); const o = [p.x, 1.6, p.z]; m.ws[a].emitMessage({ type: 'shoot', origin: o, dir: [0, 0, -1] }); m.ws[a].emitMessage({ type: 'hit', targetId: m.tok[v], origin: o, dir: [0, 0, -1] }); };
const withGeometry = (fn) => { const old = T.GEOMETRY_CONFIG.enabled; T.GEOMETRY_CONFIG.enabled = true; try { fn(); } finally { T.GEOMETRY_CONFIG.enabled = old; } }; // tests/run.js disables server geometry globally; LOS tests must enable it
const fire = (m, i, extra) => { m.p(i).lastShootAt = 0; m.ws[i].emitMessage({ type: 'shoot', ...aim(), ...(extra || {}) }); }; // lastShootAt=0: skip the real 50 ms SHOOT_CONFIG spam floor, which has its own tests
const select = (m, i, slot) => { m.p(i).lastWeaponSwitchAt = 0; m.ws[i].emitMessage({ type: 'select_slot', slot }); };
const bombAt = (m, owner, x, z, y = 0.05) => { const o = m.p(owner); o.lastBombAt = 0; select(m, owner, 'bomb'); assert(throwBomb(m.room, m.tok[owner], o, { dx: 0, dy: 0, dz: -1 }), 'thrown'); const b = m.room.bananas.find((q) => q.kind === 'bomb' && q.ownerPlayerId === m.tok[owner]); b.position = [x, y, z]; b.velocity = [0, 0, 0]; b.state = 'landed'; return b; };

// ---------------- slot selection ----------------
test('slots: every player starts on the gun and can select knife and bomb; the server state reaches the public state and the room', () => {
  const m = mk(2); assertEqual(slotOf(m.p(0)), 'gun'); assertEqual(T.buildPlayerPublicState(m.room, m.p(0)).slot, 'gun');
  for (const slot of ['knife', 'bomb', 'gun']) { select(m, 0, slot); assertEqual(m.ws[0].lastOfType('slot_ok').slot, slot); assertEqual(m.p(0).slot, slot); assertEqual(T.buildPlayerPublicState(m.room, m.p(0)).slot, slot); assertEqual(m.ws[1].lastOfType('slot_changed').slot, slot, 'roommates are told'); }
  T.shutdownAllRooms();
});
test('slots: unknown / malformed slots are rejected and never change the state', () => {
  const m = mk(2);
  for (const bad of [undefined, null, 7, [], {}, 'Knife', 'KNIFE', ' knife', 'knife ', '__proto__', 'constructor', 'melee', '', { slot: 'knife' }]) { select(m, 0, bad); }
  assertEqual(m.p(0).slot, 'gun', 'unchanged: beginMatch gave every player the gun slot'); assertEqual(slotOf(m.p(0)), 'gun'); assert(m.ws[0].lastOfType('slot_rejected').reason === 'UNKNOWN_SLOT');
  m.ws[0].emitMessage({ type: 'select_slot' }); m.ws[0].emitMessage({ type: 'select_slot', slot: 'knife', extra: 1 }); assertEqual(m.p(0).slot, 'knife', 'a well-formed message with extra fields is fine');
  T.shutdownAllRooms();
});
test('slots: cannot select while dead, banana-locked, slipped, in the lobby, or faster than the switch cooldown', () => {
  const m = mk(2); const p = m.p(0);
  p.alive = false; select(m, 0, 'knife'); assertEqual(m.ws[0].lastOfType('slot_rejected').reason, 'DEAD'); p.alive = true;
  p.bananaActive = true; select(m, 0, 'knife'); assertEqual(m.ws[0].lastOfType('slot_rejected').reason, 'BANANA_LOCK'); p.bananaActive = false;
  T.slipPlayer(m.room, m.tok[0], { ownerUsername: 'x' }); select(m, 0, 'knife'); assertEqual(m.ws[0].lastOfType('slot_rejected').reason, 'SLIPPED'); T.clearBananas(m.room);
  assertEqual(p.slot, 'gun', 'nothing changed so far (rejections never touch the slot)');
  select(m, 0, 'knife'); assertEqual(p.slot, 'knife'); m.ws[0].emitMessage({ type: 'select_slot', slot: 'bomb' }); assertEqual(p.slot, 'knife', 'switch spam inside the cooldown is ignored'); assertEqual(m.ws[0].lastOfType('slot_rejected').reason, 'COOLDOWN');
  T.shutdownAllRooms();
  // In the LOBBY the dispatcher (server.js: `if (!room || !room.started ...) return;`) drops every in-game message silently, like equip_weapon: no state change, no reply.
  const a = connect('a'); const at = hello(a); a.emitMessage({ type: 'create_room', maxPlayers: 4 }); const lobby = T.rooms[a.lastOfType('room_created').code]; a.emitMessage({ type: 'select_slot', slot: 'knife' });
  assertEqual(lobby.players[at].slot, undefined, 'lobby: slot untouched'); assertEqual(a.lastOfType('slot_ok'), null, 'lobby: no confirmation'); assertEqual(a.lastOfType('slot_rejected'), null, 'lobby: ignored like every other in-game message'); T.shutdownAllRooms();
  // During the COUNTDOWN the game has started but the match is not active yet: that is what NOT_ACTIVE answers.
  const h = connect('h'); const ht = hello(h); h.emitMessage({ type: 'create_room', maxPlayers: 4 }); const g = connect('g'); hello(g); g.emitMessage({ type: 'join_room', roomCode: h.lastOfType('room_created').code, name: 'G' }); g.emitMessage({ type: 'player_ready' });
  const saved = T.MATCH_CONFIG.countdownMs; T.MATCH_CONFIG.countdownMs = 5000; try { h.emitMessage({ type: 'start_game' }); } finally { T.MATCH_CONFIG.countdownMs = saved; }
  h.emitMessage({ type: 'select_slot', slot: 'knife' }); assertEqual(h.lastOfType('slot_rejected').reason, 'NOT_ACTIVE', 'countdown'); T.shutdownAllRooms();
});
test('slots: respawn and rematch put the player back on the gun; slot state is room-scoped', () => {
  const a = mk(2), b = mk(2); select(a, 0, 'bomb'); select(a, 1, 'knife'); assertEqual(slotOf(b.p(0)), 'gun'); assertEqual(slotOf(b.p(1)), 'gun', 'room B untouched');
  a.p(1).alive = false; T.dealDamage; // dead state set directly, then respawn through the real timer path
  a.p(1).health = 0; a.room.respawnTimers = a.room.respawnTimers || {}; T.endMatch(a.room, 'TIME'); a.ws[0].emitMessage({ type: 'rematch' });
  assertEqual(slotOf(a.p(0)), 'gun', 'rematch resets the slot'); assertEqual(slotOf(a.p(1)), 'gun'); T.shutdownAllRooms();
});
test('slots: the slot and the bomb cooldown are in the live state a RECONNECTED player receives', async () => {
  const m = mk(2); select(m, 0, 'bomb'); m.p(0).lastBombAt = BC.now();
  m.p(0).connected = false; const a2 = connect('a2'); a2.emitMessage({ type: 'hello', token: m.tok[0] });
  let st = null, me = null; for (let i = 0; i < 40 && !(st && me); i++) { await new Promise((r) => setTimeout(r, 50)); const s1 = a2.lastOfType('state'); if (s1 && s1.players) st = s1.players[m.tok[0]]; me = a2.lastOfType('self_state'); }
  assert(me, 'self_state tick received'); assertEqual(me.slot, 'bomb'); assert(me.bombCooldownMs > 0 && me.bombCooldownMs <= B.cooldownMs, 'cooldown remaining ' + me.bombCooldownMs); T.shutdownAllRooms();
});

// ---------------- knife ----------------
test('knife: server decides the damage (client damage ignored), no crit, and a lethal slash goes through the shared kill pipeline', () => {
  const m = mk(2); select(m, 0, 'knife'); const v = m.p(1); const rng = T.HIT_CONFIG.rng; T.HIT_CONFIG.rng = () => 0; // would always crit a gun shot
  try { m.ws[0].emitMessage({ type: 'shoot', ...aim() }); m.ws[0].emitMessage({ type: 'hit', targetId: m.tok[1], ...aim(), damage: 9999, crit: true }); } finally { T.HIT_CONFIG.rng = rng; }
  assertEqual(v.health, 100 - K.damage, 'exactly the knife damage'); const hc = m.ws[0].lastOfType('hit_confirm'); assertEqual(hc.damage, K.damage); assertEqual(hc.crit, false);
  m.p(0).lastKnifeAt = 0; v.health = K.damage; slash(m, 0, 1);
  assertEqual(v.alive, false, 'killed'); assertEqual(m.p(0).kills, 1); assertEqual(v.deaths, 1); assertEqual(m.p(0).streak, 1); assert(m.ws[1].lastOfType('you_died'), 'victim told'); assert(m.ws[0].lastOfType('kill'), 'kill broadcast'); T.shutdownAllRooms();
});
test('knife: melee range is enforced on SERVER positions (inside = hit, far = nothing)', () => {
  const m = mk(2); select(m, 0, 'knife'); m.place(1, 0, 20 - (K.range - 0.3)); slash(m, 0, 1); assertEqual(m.p(1).health, 100 - K.damage, 'inside reach');
  m.p(1).health = 100; m.p(0).lastKnifeAt = 0; m.place(1, 0, 20 - (K.range + K.serverSlack + 2)); slash(m, 0, 1); assertEqual(m.p(1).health, 100, 'out of reach: a claimed hit from across the map does nothing'); T.shutdownAllRooms();
});
test('knife: cooldown is server-side (spam inside the window deals damage once), and a hit needs a real target (self / dead / unknown ignored)', () => {
  const m = mk(2); select(m, 0, 'knife'); slash(m, 0, 1); slash(m, 0, 1); slash(m, 0, 1); assertEqual(m.p(1).health, 100 - K.damage, 'one slash per cooldown');
  m.p(0).lastKnifeAt = BC.now() - K.cooldownMs - 5; slash(m, 0, 1); assertEqual(m.p(1).health, 100 - 2 * K.damage, 'after the cooldown the next slash lands');
  m.p(1).alive = false; m.p(0).lastKnifeAt = 0; const before = m.p(1).health; slash(m, 0, 1); assertEqual(m.p(1).health, before, 'dead target ignored');
  m.ws[0].emitMessage({ type: 'hit', targetId: m.tok[0], ...aim() }); assertEqual(m.p(0).health, 100, 'self hit ignored'); m.ws[0].emitMessage({ type: 'hit', targetId: 'nope', ...aim() }); T.shutdownAllRooms();
});
test('knife: blocked by walls (server line of sight), protected by teams unless friendly fire is on, and never crosses rooms', () => {
  withGeometry(() => { const m = mk(2); select(m, 0, 'knife'); m.place(0, -13.0, 9); m.place(1, -11.0, 9); // the lane divider (x -12.75..-11.25, z 3.5..14.5, h 3) is between them
    assert(T.BBMaps.segmentBlocked(-13, 9, -11, 9, T.roomLayout(m.room)), 'precondition: the server really sees the wall'); slash(m, 0, 1); assertEqual(m.p(1).health, 100, 'wall blocks the knife');
    m.place(1, -13.0, 7.8); m.p(0).lastKnifeAt = 0; slash(m, 0, 1); assertEqual(m.p(1).health, 100 - K.damage, 'control: same distance WITHOUT a wall between them lands'); T.shutdownAllRooms(); });
  const t = mk(2, { mode: 'team' }); t.p(0).team = 1; t.p(1).team = 1; select(t, 0, 'knife'); slash(t, 0, 1); assertEqual(t.p(1).health, 100, 'teammate safe'); t.room.friendlyFire = true; t.p(0).lastKnifeAt = 0; slash(t, 0, 1); assertEqual(t.p(1).health, 100 - K.damage, 'friendly fire on'); T.shutdownAllRooms();
  const a = mk(2), b = mk(2); select(a, 0, 'knife'); a.ws[0].emitMessage({ type: 'shoot', ...aim() }); a.ws[0].emitMessage({ type: 'hit', targetId: b.tok[1], ...aim() }); assertEqual(b.p(1).health, 100, 'cross-room id does nothing'); T.shutdownAllRooms();
});
test('knife/gun/bomb: the gun still uses the weapon registry; the bomb slot never produces hitscan damage', () => {
  const m = mk(2); slash(m, 0, 1); assertEqual(m.p(1).health, 100 - T.WEAPONS[m.p(0).weaponId].damage * (m.ws[0].lastOfType('hit_confirm').crit ? 2 : 1), 'gun damage = registry damage (x2 on crit)');
  m.p(1).health = 100; select(m, 0, 'bomb'); m.p(0).lastHitAt = 0; m.ws[0].emitMessage({ type: 'hit', targetId: m.tok[1], ...aim() }); assertEqual(m.p(1).health, 100, 'bomb slot: a claimed hit is ignored'); T.shutdownAllRooms();
});

// ---------------- bomb ----------------
test('bomb: a shoot in the bomb slot throws a server projectile (owner/kind/roomId from the server), with an owner-only confirmation and a room-wide spawn', () => {
  const m = mk(2); select(m, 0, 'bomb'); m.ws[0].emitMessage({ type: 'shoot', ...aim() });
  const b = m.room.bananas.find((q) => q.kind === 'bomb'); assert(b, 'bomb exists'); assertEqual(b.ownerPlayerId, m.tok[0]); assertEqual(b.roomId, m.code); assertEqual(b.state, 'flying'); assertEqual(b.explodeAt - b.createdAt, B.fuseMs);
  assert(m.ws[1].lastOfType('bomb_spawn') && m.ws[1].lastOfType('bomb_spawn').bombId === b.bananaId, 'roommates see it'); assertEqual(m.ws[0].lastOfType('bomb_ok').cooldownMs, B.cooldownMs); assert(!m.ws[1].lastOfType('bomb_ok'), 'confirmation is owner-only');
  assertEqual(m.p(1).health, 100, 'throwing hurts nobody'); T.shutdownAllRooms();
});
test('bomb: cooldown, one live bomb per player, and the room-wide projectile cap', () => {
  const m = mk(2); select(m, 0, 'bomb'); fire(m, 0); fire(m, 0);
  assertEqual(m.room.bananas.filter((q) => q.kind === 'bomb').length, 1, 'second throw refused'); assertEqual(m.ws[0].lastOfType('bomb_rejected').reason, 'COOLDOWN');
  m.p(0).lastBombAt = 0; fire(m, 0); assertEqual(m.ws[0].lastOfType('bomb_rejected').reason, 'ALREADY_ACTIVE'); assertEqual(m.room.bananas.length, 1);
  T.clearBananas(m.room); m.room.bananas = new Array(BC.maxPerRoom).fill(0).map((_, i) => ({ bananaId: 'x' + i, kind: 'banana', position: [0, 0, 0], velocity: [0, 0, 0], ownerPlayerId: 'z', state: 'peel', expiresAt: BC.now() + 9e6, createdAt: 0 })); m.p(0).lastBombAt = 0; fire(m, 0);
  assertEqual(m.ws[0].lastOfType('bomb_rejected').reason, 'ROOM_LIMIT'); T.shutdownAllRooms();
});
test('bomb: the production shoot-spam floor (50 ms) silently drops a same-instant second shoot BEFORE the bomb logic; after it elapses the real COOLDOWN rejection (with remainingMs) is returned', async () => {
  const m = mk(2); select(m, 0, 'bomb'); m.p(0).lastShootAt = 0; m.ws[0].emitMessage({ type: 'shoot', ...aim() }); m.ws[0].emitMessage({ type: 'shoot', ...aim() });
  assertEqual(m.ws[0].lastOfType('bomb_rejected'), null, 'floor drops the 2nd shoot: no rejection message either'); await new Promise((r) => setTimeout(r, 80)); m.ws[0].emitMessage({ type: 'shoot', ...aim() });
  const rj = m.ws[0].lastOfType('bomb_rejected'); assertEqual(rj.reason, 'COOLDOWN'); assert(rj.remainingMs > 0 && rj.remainingMs <= B.cooldownMs, 'remainingMs ' + rj.remainingMs); T.shutdownAllRooms();
});
test('bomb: flies with gravity (an arc, no teleport), lands on the ground, and does NOT detonate on contact — only when the fuse ends', () => {
  const m = mk(2); select(m, 0, 'bomb'); m.place(1, 0, 40); throwBomb(m.room, m.tok[0], m.p(0), { dx: 0, dy: 0, dz: -1 }); const b = m.room.bananas[0]; const t0 = BC.now(); const ys = [];
  for (let k = 1; k <= 60 && b.state === 'flying'; k++) { stepBananas(m.room, 0.02, t0 + k * 20); ys.push(b.position[1]); }
  assertEqual(b.state, 'landed'); assertEqual(b.position[1], BC.groundY); assert(Math.max(...ys) > b.position[1] + 0.3, 'it rose and fell (arc)'); assert(b.position[2] < 19, 'travelled forward');
  assert(m.ws[1].lastOfType('bomb_landed'), 'landing broadcast'); assertEqual(m.room.bananas.length, 1, 'still armed: no early detonation'); assert(!m.ws[1].lastOfType('bomb_exploded'), 'not exploded yet');
  stepBananas(m.room, 0.02, b.explodeAt + 1); assertEqual(m.room.bananas.length, 0, 'gone after the fuse'); const ex = m.ws[1].lastOfType('bomb_exploded'); assert(ex && ex.radius === B.radius, 'explosion broadcast carries the radius'); T.shutdownAllRooms();
});
test('bomb: area damage with linear falloff, never below the minimum inside the radius, nothing outside; the owner gets hit_confirm per victim', () => {
  const m = mk(4); const b = bombAt(m, 0, 0, 0); m.place(0, 40, 40); // owner far away so only the others are inside
  m.place(1, 0, 0); m.p(1).y = 0.05 + B.torsoDrop; // dead centre
  m.place(2, B.radius / 2, 0); m.p(2).y = 0.05 + B.torsoDrop; // half radius
  m.place(3, B.radius - 0.2, 0); m.p(3).y = 0.05 + B.torsoDrop; // rim
  explodeBomb(m.room, b);
  assertEqual(m.p(1).health, 100 - B.maxDamage, 'centre = max damage'); assertEqual(m.p(2).health, 100 - Math.round(B.maxDamage * 0.5), 'half radius = half'); assertEqual(m.p(3).health, 100 - Math.max(B.minDamage, Math.round(B.maxDamage * (1 - (B.radius - 0.2) / B.radius))), 'rim >= minDamage');
  assert(m.p(3).health <= 100 - B.minDamage, 'minimum applies'); const confirms = m.ws[0].sent.filter((x) => x.type === 'hit_confirm'); assertEqual(confirms.length, 3, 'owner is told about each victim'); assert(!m.ws[1].sent.some((x) => x.type === 'hit_confirm'), 'victims get no hit confirmation');
  const m2 = mk(2); const b2 = bombAt(m2, 0, 0, 0); m2.place(0, 40, 40); m2.place(1, B.radius + 0.5, 0); m2.p(1).y = 0.05 + B.torsoDrop; explodeBomb(m2.room, b2); assertEqual(m2.p(1).health, 100, 'outside the radius'); T.shutdownAllRooms();
});
test('bomb: walls stop the blast (server line of sight) and a hostile client cannot choose damage/position', () => {
  withGeometry(() => { const m = mk(2); const b = bombAt(m, 0, -13.2, 9); m.place(0, 40, 40); m.place(1, -10.8, 9); m.p(1).y = 0.05 + B.torsoDrop; // lane divider between bomb and victim
    assert(T.BBMaps.segmentBlocked(-13.2, 9, -10.8, 9, T.roomLayout(m.room)), 'precondition: the server sees the wall'); explodeBomb(m.room, b); assertEqual(m.p(1).health, 100, 'protected by the wall');
    const c = mk(2); const cb = bombAt(c, 0, -13.2, 7.0); c.place(0, 40, 40); c.place(1, -10.8, 7.0 - 0.0); c.place(1, -13.2, 7.0 + 0.0); c.p(1).x = -12.0; c.p(1).x = -14.0; c.p(1).z = 7.0; c.p(1).y = 0.05 + B.torsoDrop; explodeBomb(c.room, cb); assert(c.p(1).health < 100, 'control: same blast on the SAME side of the wall hurts'); T.shutdownAllRooms(); });
  const n = mk(2); select(n, 0, 'bomb'); n.ws[0].emitMessage({ type: 'shoot', ...aim(), damage: 9999, position: [0, 0, 0], radius: 999, fuseMs: 1, ownerPlayerId: n.tok[1] });
  const nb = n.room.bananas[0]; assertEqual(nb.ownerPlayerId, n.tok[0], 'owner from the server'); assertEqual(nb.explodeAt - nb.createdAt, B.fuseMs, 'client cannot change the fuse'); assert(Math.abs(nb.position[2] - 19.4) < 0.7, 'client position ignored: starts at the server-known player position'); T.shutdownAllRooms();
});
test('bomb: self damage is reduced, a self kill is NOT a kill/streak, and own-team members are safe unless friendly fire is on', () => {
  const m = mk(2); const b = bombAt(m, 0, 0, 0); m.place(0, 0, 0); m.p(0).y = 0.05 + B.torsoDrop; m.place(1, 40, 40); explodeBomb(m.room, b);
  assertEqual(m.p(0).health, 100 - Math.round(B.maxDamage * B.selfDamageFactor), 'self damage factor');
  const s = mk(2); const sb = bombAt(s, 0, 0, 0); s.place(0, 0, 0); s.p(0).y = 0.05 + B.torsoDrop; s.p(0).health = 10; s.p(0).streak = 3; s.place(1, 40, 40); explodeBomb(s.room, sb);
  assertEqual(s.p(0).alive, false, 'died'); assertEqual(s.p(0).deaths, 1); assertEqual(s.p(0).kills, 0, 'no kill for a suicide'); assertEqual(s.p(0).streak, 0, 'streak reset');
  const t = mk(3, { mode: 'team' }); t.p(0).team = 1; t.p(1).team = 1; t.p(2).team = 2; const tb = bombAt(t, 0, 0, 0); t.place(0, 40, 40); t.place(1, 0, 0); t.p(1).y = 0.05 + B.torsoDrop; t.place(2, 1, 0); t.p(2).y = 0.05 + B.torsoDrop; explodeBomb(t.room, tb);
  assertEqual(t.p(1).health, 100, 'teammate safe'); assert(t.p(2).health < 100, 'enemy hit'); T.shutdownAllRooms();
  const f = mk(2, { mode: 'team' }); f.p(0).team = 1; f.p(1).team = 1; f.room.friendlyFire = true; const fb = bombAt(f, 0, 0, 0); f.place(0, 40, 40); f.place(1, 0, 0); f.p(1).y = 0.05 + B.torsoDrop; explodeBomb(f.room, fb); assert(f.p(1).health < 100, 'friendly fire on'); T.shutdownAllRooms();
});
test('bomb: kills give the owner credit through the shared pipeline (kills, streak, kill broadcast, respawn), one explosion can kill several players, and the score limit ends the match once', () => {
  const m = mk(3, { scoreLimit: 3 }); const b = bombAt(m, 0, 0, 0); m.place(0, 40, 40); for (const i of [1, 2]) { m.place(i, 0.5 * i, 0); m.p(i).y = 0.05 + B.torsoDrop; m.p(i).health = 10; }
  explodeBomb(m.room, b); assertEqual(m.p(1).alive, false); assertEqual(m.p(2).alive, false); assertEqual(m.p(0).kills, 2, 'two kills from one blast'); assertEqual(m.p(0).streak, 2); assertEqual(m.ws[0].sent.filter((x) => x.type === 'kill').length, 2);
  assert(m.room.respawnTimers[m.tok[1]] && m.room.respawnTimers[m.tok[2]], 'respawn scheduled through the real pipeline');
  const c = mk(2, { scoreLimit: 3 }); c.p(0).kills = 2; const cb = bombAt(c, 0, 0, 0); c.place(0, 40, 40); c.place(1, 0, 0); c.p(1).y = 0.05 + B.torsoDrop; c.p(1).health = 5; explodeBomb(c.room, cb);
  assertEqual(c.room.match.state, 'ended', 'score limit via bomb'); assertEqual(c.ws[1].sent.filter((x) => x.type === 'match_end').length, 1, 'ends exactly once'); T.shutdownAllRooms();
});
test('bomb: dead or disconnected players are not damaged; the owner leaving removes the bomb silently; an owner who died still gets the credit', () => {
  const m = mk(3); const b = bombAt(m, 0, 0, 0); m.place(0, 40, 40); m.place(1, 0, 0); m.p(1).y = 0.05 + B.torsoDrop; m.p(1).alive = false; m.place(2, 0.5, 0); m.p(2).y = 0.05 + B.torsoDrop; m.p(2).connected = false; explodeBomb(m.room, b);
  assertEqual(m.p(1).health, 100); assertEqual(m.p(2).health, 100); T.shutdownAllRooms();
  const l = mk(2); const lb = bombAt(l, 0, 0, 0); l.place(1, 0, 0); l.p(1).y = 0.05 + B.torsoDrop; l.ws[0].emitMessage({ type: 'leave_room' }); assertEqual(l.room.bananas.filter((q) => q.kind === 'bomb').length, 0, 'bomb removed'); assert(!l.ws[1].lastOfType('bomb_exploded')); assertEqual(l.p(1).health, 100); T.shutdownAllRooms();
  const d = mk(2); const db = bombAt(d, 0, 0, 0); d.p(0).alive = false; d.place(0, 40, 40); d.place(1, 0, 0); d.p(1).y = 0.05 + B.torsoDrop; d.p(1).health = 10; explodeBomb(d.room, db); assertEqual(d.p(0).kills, 1, 'credit even though the owner is dead'); T.shutdownAllRooms();
});
test('bomb: room isolation, spoofed bomb/slot messages do nothing, malformed throws never crash, and cleanup leaves no loop or state (match end, room deletion)', () => {
  const a = mk(2), b = mk(2); const ba = bombAt(a, 0, 0, 0); b.place(1, 0, 0); b.p(1).y = 0.05 + B.torsoDrop; explodeBomb(a.room, ba); assertEqual(b.p(1).health, 100, 'room B unaffected'); assert(!b.ws[0].lastOfType('bomb_exploded'), 'room B never saw room A packets'); T.shutdownAllRooms();
  const m = mk(2);
  for (const type of ['bomb_spawn', 'bomb_landed', 'bomb_exploded', 'bomb_ok', 'slot_changed', 'slot_ok', 'throw_bomb', 'explode']) m.ws[0].emitMessage({ type, slot: 'bomb', bombId: 'x', position: [0, 0, 0], damage: 999 });
  assertEqual((m.room.bananas || []).length, 0, 'spoofs create nothing'); assertEqual(slotOf(m.p(0)), 'gun');
  select(m, 0, 'bomb'); for (const bad of [{}, { origin: null, dir: null }, { origin: [NaN, 0, 0], dir: [0, 0, -1] }, { origin: [0, 1.6, 20], dir: [Infinity, 0, 0] }, { origin: 'x', dir: [] }, { origin: [1e12, 1e12, 1e12], dir: [0, 0, -1] }, { origin: [0, 1.6, 20], dir: [0, 0, 0] }]) m.ws[0].emitMessage({ type: 'shoot', ...bad });
  assertEqual((m.room.bananas || []).length, 0, 'malformed throws create nothing');
  const e = mk(2); select(e, 0, 'bomb'); e.ws[0].emitMessage({ type: 'shoot', ...aim() }); assert(e.room.bananaTimer, 'loop armed'); const er = e.room; T.endMatch(e.room, 'TIME'); assertEqual(er.bananas.length, 0, 'match end clears bombs'); assertEqual(er.bananaTimer, null, 'loop stopped'); T.shutdownAllRooms();
  const r = mk(2); select(r, 0, 'bomb'); r.ws[0].emitMessage({ type: 'shoot', ...aim() }); const rr = r.room; T.shutdownAllRooms(); assertEqual(rr.bananaTimer, null); assertEqual(rr.bananas.length, 0);
});
test('bomb: a live bomb and its remaining fuse are in the room_state snapshot a returning player gets', () => {
  const m = mk(2); select(m, 0, 'bomb'); m.ws[0].emitMessage({ type: 'shoot', ...aim() }); const st = T.roomStatePayload(m.room); const pb = st.bananas.find((q) => q.kind === 'bomb');
  assert(pb, 'bomb in snapshot'); assert(pb.fuseMs > 0 && pb.fuseMs <= B.fuseMs, 'fuse ' + pb.fuseMs); assertEqual(pb.ownerPlayerId, m.tok[0]); T.shutdownAllRooms();
});
test('bomb/knife: design values are sane (positive, bounded) so a typo cannot ship a one-shot-everyone bomb', () => {
  assert(K.damage > 0 && K.damage <= 100 && K.cooldownMs >= 200 && K.range >= 1 && K.range <= 5, 'knife'); assert(B.maxDamage > B.minDamage && B.minDamage >= 0 && B.maxDamage <= 100 && B.radius >= 2 && B.radius <= 10 && B.fuseMs >= 500 && B.cooldownMs >= B.fuseMs && B.selfDamageFactor > 0 && B.selfDamageFactor <= 1, 'bomb');
});

// ---------------- client (STATIC checks of public/index.html: NOT a browser test) + real data the client constants come from ----------------
const fs = require('fs');
const ROOT = path.join(__dirname, '..', 'public');
const CLIENT = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
test('slots client: the box has exactly the three slots, keys 1/2/3 map to them, and the request path only sends select_slot (the UI changes on the server answer)', () => {
  const box = CLIENT.slice(CLIENT.indexOf('<div id="slotBox">'), CLIENT.indexOf('<div id="dashBtn">')); assertEqual((box.match(/class="slotBtn/g) || []).length, 3); for (const s of T.SLOTS) assert(box.includes('data-slot="' + s + '"'), 'button for ' + s);
  assert(/const SLOT_KEYS = \{ Digit1: 'gun', Digit2: 'knife', Digit3: 'bomb' \}/.test(CLIENT) && /if \(SLOT_KEYS\[e\.code\] && !e\.repeat\) selectSlot\(SLOT_KEYS\[e\.code\]\)/.test(CLIENT), 'keys');
  const sel = CLIENT.slice(CLIENT.indexOf('function selectSlot'), CLIENT.indexOf('function applySlot')); assert(/type: 'select_slot', slot/.test(sel) && !/applySlot\(/.test(sel) && /isDead \|\| stunned/.test(sel), 'selectSlot only REQUESTS, never changes the state itself');
  assert(/msg\.type === 'slot_ok'\) applySlot\(msg\.slot\)/.test(CLIENT) && /mine\.slot !== mySlot\) applySlot\(mine\.slot\)/.test(CLIENT) && /msg\.slot !== mySlot\) applySlot\(msg\.slot\)/.test(CLIENT), 'state changes only from slot_ok and the server tick (reconnect-safe)');
});
test('slots client: the mirrored design constants equal the server config, and the fire routing follows the slot (knife range-gated, bomb sends only shoot)', () => {
  const num = (name) => Number(CLIENT.match(new RegExp(name + ' = ([0-9.]+)'))[1]); assertEqual(num('KNIFE_RANGE'), K.range); assertEqual(num('KNIFE_COOLDOWN_MS'), K.cooldownMs); assertEqual(num('BOMB_COOLDOWN_MS'), B.cooldownMs);
  assert(/if \(mySlot === 'knife'\) \{ fireKnife\(\); return; \}\s*if \(mySlot === 'bomb'\) \{ fireBomb\(\); return; \}\s*sfxShoot\(\);/.test(CLIENT), 'onShoot routes by slot before the gun sound');
  const kn = CLIENT.slice(CLIENT.indexOf('function fireKnife'), CLIENT.indexOf('function fireBomb')); { const pk = CLIENT.slice(CLIENT.indexOf('function pickRemoteTarget'), CLIENT.indexOf('function spawnRemote')); assert(/pickRemoteTarget\(rc, KNIFE_RANGE\)/.test(kn) && /hits\[0\]\.distance > maxDist\)\) return null/.test(pk) && /type: 'hit', targetId/.test(kn) && /now - lastKnifeLocalAt < KNIFE_COOLDOWN_MS/.test(kn), 'knife: reach (enforced by the shared picker) + cooldown gates'); }
  const bm = CLIENT.slice(CLIENT.indexOf('function fireBomb'), CLIENT.indexOf("document.querySelectorAll('#slotBox .slotBtn').forEach((b) => b.addEventListener")); assert(bm.length > 50, 'slice found'); assert(/type: 'shoot'/.test(bm) && !/type: 'hit'/.test(bm), 'bomb: shoot only, never a client-claimed hit');
});
test('slots client: every bomb/slot message the server can send is handled; bombs reuse the banana projectile meshes; the explosion uses the shared particle budget, the existing loop and disposes its objects', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'); const sent = new Set([...server.matchAll(/type: '((?:bomb|slot)_[a-z]+)'/g)].map((m) => m[1]).filter((t) => t !== 'slot_changed'));
  assert(sent.size >= 6, 'server sends ' + [...sent].join(',')); for (const t of sent) assert(CLIENT.includes("'" + t + "'"), 'client has no handler for ' + t);
  assert(/b\.kind === 'bomb' \? makeBombMesh\(\) : makeBananaMesh\(\)/.test(CLIENT) && /disposeObject3D\(e\.mesh\);/.test(CLIENT), 'one projectile mesh engine, safe disposal for Group meshes');
  const ex = CLIENT.slice(CLIENT.indexOf('function spawnExplosionEffect'), CLIENT.indexOf('function handleSlotAndBombMessage')); assert(/BBFeedback\.ashesBudget\(settings\.particleQuality, IS_TOUCH_DEVICE\)/.test(ex) && /explosionFx\.length >= Math\.max\(1, budget\.maxConcurrent\)/.test(ex), 'quality + concurrency budget'); assert(/disposeObject3D\(f\.group\)/.test(ex), 'effects free their objects');
  assert(/updateViewItems\(dt\);\s*updateExplosions\(dt\);/.test(CLIENT), 'effects advance inside the existing animate loop'); assertEqual((CLIENT.match(/requestAnimationFrame\(animate\)/g) || []).length, 1, 'still one game loop'); assertEqual((CLIENT.match(/new THREE\.OBJLoader\(\)/g) || []).length, 1, 'still one OBJLoader');
});
test('slots client: the explosion is damage-free — it is drawn only from bomb_exploded and sends nothing to the server', () => {
  const ex = CLIENT.slice(CLIENT.indexOf('function spawnExplosionEffect'), CLIENT.indexOf('function handleSlotAndBombMessage')); assert(!/ws\.send/.test(ex), 'no network send inside the effect'); const h = CLIENT.slice(CLIENT.indexOf('function handleSlotAndBombMessage'), CLIENT.indexOf('// ---------- 🍌 Banana Weapon Chaos')); assert(!/ws\.send/.test(h) && !/\.health/.test(h), 'the handler neither sends nor changes health');
});
test('slots client: constants come from REAL data — grenade colours equal Grenade.mtl Kd; the knife tip (thin end) really is at -Z (forward) in the source mesh', () => {
  const mtl = fs.readFileSync(path.join(ROOT, 'models/weapons/throwable/grenade/Grenade.mtl'), 'utf8'); const kd = {}; let cur = null; for (const ln of mtl.split('\n')) { const t = ln.trim(); if (t.startsWith('newmtl')) cur = t.split(/\s+/)[1]; else if (cur && t.startsWith('Kd ')) kd[cur] = t.split(/\s+/).slice(1, 4).map(Number); }
  const pal = CLIENT.match(/const GRENADE_PALETTE = \{([^}]*)\}/)[1]; for (const [name, c] of Object.entries(kd)) { const m = pal.match(new RegExp(name + ': 0x([0-9a-f]{6})')); if (!m) continue; const hex = parseInt(m[1], 16); const want = (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255); for (const sh of [16, 8, 0]) assert(Math.abs(((hex >> sh) & 255) - ((want >> sh) & 255)) <= 1, name + ' channel ' + sh); }
  assert(['pCube5SG', 'pCube5SG1', 'pCube5SG2'].every((n) => pal.includes(n)), 'all three used grenade materials have a colour');
  const V = fs.readFileSync(path.join(ROOT, 'models/weapons/melee/knife/knife.obj'), 'utf8').split('\n').filter((l) => l.startsWith('v ')).map((l) => l.trim().split(/\s+/).slice(1, 4).map(Number)); const zs = V.map((v) => v[2]); const lo = Math.min(...zs), hi = Math.max(...zs), L = hi - lo;
  const xext = (sel) => { const xs = V.filter(sel).map((v) => v[0]); return Math.max(...xs) - Math.min(...xs); }; assert(xext((v) => v[2] < lo + 0.15 * L) < xext((v) => v[2] > hi - 0.15 * L), 'the -Z end is the thin blade tip, the +Z end the thicker handle (the client holds the knife with -Z forward and applies no extra rotation)');
});

// Added after mutation testing (survivor "slot not reset on respawn"): the rematch path was tested, the real respawn path was not.
test('slots: after a REAL death the respawn timer returns the player to the gun slot (real timer), so a dead player never respawns holding a bomb', async () => {
  const m = mk(2); select(m, 1, 'bomb'); assertEqual(m.p(1).slot, 'bomb'); T.dealDamage(m.room, m.tok[0], m.p(0), m.tok[1], m.p(1), 500, false); assertEqual(m.p(1).alive, false, 'dead');
  await new Promise((r) => setTimeout(r, 4300)); assertEqual(m.p(1).alive, true, 'respawned by the real timer'); assertEqual(m.p(1).slot, 'gun', 'slot reset by the respawn'); T.shutdownAllRooms();
});
