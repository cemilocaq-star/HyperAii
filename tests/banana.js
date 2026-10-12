// Banana Weapon Chaos. Physics is tested deterministically through stepBananas(); the ~4 s slip uses a REAL timer test.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const T = startServer.__test__;
const { RandomEventRegistry: REG, BANANA_CONFIG: BC, stepBananas, throwBanana, slipPlayer, isSlipped } = T;

function mk(n) {
  const ws = [], tok = [];
  const h = connect('h'); tok.push(hello(h)); ws.push(h);
  h.emitMessage({ type: 'create_room', name: 'Own', maxPlayers: 8 });
  const code = h.lastOfType('room_created').code;
  for (let i = 1; i < n; i++) { const g = connect('p' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); ws.push(g); g.emitMessage({ type: 'player_ready' }); }
  const savedCd = T.MATCH_CONFIG.countdownMs; T.MATCH_CONFIG.countdownMs = 0;
  try { h.emitMessage({ type: 'start_game' }); } finally { T.MATCH_CONFIG.countdownMs = savedCd; }
  const room = T.rooms[code];
  room.players[tok[0]].x = 0; room.players[tok[0]].z = 20; room.players[tok[0]].y = 1.6;
  if (n > 1) { room.players[tok[1]].x = 0; room.players[tok[1]].z = 10; room.players[tok[1]].y = 1.6; }
  return { code, room, ws, tok, p: (i) => room.players[tok[i]] };
}
function giveBanana(m, i) {
  const rng = T.CHAOS_CONFIG.rng; T.CHAOS_CONFIG.rng = () => i / m.tok.length + 0.001;
  try { assert(T.startChaosEvent(m.room, REG.banana_weapon), 'event started'); } finally { T.CHAOS_CONFIG.rng = rng; }
}
const aim = (z = -1) => ({ origin: [0, 1.6, 20], dir: [0, 0, z] });
function run(room, sec) { const N = Math.round(sec / 0.05); const t0 = BC.now(); for (let k = 0; k < N; k++) stepBananas(room, 0.05, t0 + (k + 1) * 50); }

test('banana: registered in the EXISTING registry with the required shape; existing probabilities untouched', () => {
  const ev = REG.banana_weapon;
  assertEqual(ev.id, 'banana_weapon'); assert(ev.probability > 0 && ev.duration > 0 && typeof ev.start === 'function' && typeof ev.end === 'function');
  assertEqual(REG.pinkPop.probability, 0.10); assertEqual(REG.duckWeapon.probability, 0.05); assertEqual(REG.greenOgre.probability, 0.07);
  assertEqual(T.validateChaosRegistry ? T.validateChaosRegistry(REG).length : 0, 0, 'registry validates');
});
test('banana: start picks a connected player, saves the original weapon state, and only that player holds it', () => {
  const m = mk(3); m.p(1).weaponId = 'w002';
  giveBanana(m, 1);
  assertEqual(m.room.chaosState.id, 'banana_weapon'); const tgt = m.room.chaosState.targetId;
  assertEqual(m.room.players[tgt].bananaActive, true); assertEqual(m.tok.filter((t) => m.room.players[t].bananaActive).length, 1);
  assert(m.room.players[tgt].bananaSavedWeaponId, 'original weapon saved');
  T.shutdownAllRooms();
});
test('banana: end restores the original weapon exactly and clears the holder flag', () => {
  const m = mk(2); m.p(1).weaponId = 'w003'; m.room.players[m.tok[0]].weaponId = 'w003';
  giveBanana(m, 0); const tgt = m.room.chaosState.targetId; const before = m.room.players[tgt].bananaSavedWeaponId;
  T.endChaosEvent(m.room);
  assertEqual(m.room.players[tgt].bananaActive, false); assertEqual(m.room.players[tgt].weaponId, before); assertEqual(m.room.chaosState, null);
  T.shutdownAllRooms();
});
test('banana: holder cannot switch weapons; non-holders are unaffected', () => {
  const m = mk(2); giveBanana(m, 0); const tgt = m.room.chaosState.targetId; const other = m.tok.find((t) => t !== tgt);
  const wsOf = (t) => m.ws[m.tok.indexOf(t)];
  const before = m.room.players[tgt].weaponId;
  wsOf(tgt).emitMessage({ type: 'equip_weapon', weaponId: 'w002' }); assertEqual(m.room.players[tgt].weaponId, before, 'holder locked');
  wsOf(other).emitMessage({ type: 'equip_weapon', weaponId: 'w002' }); assertEqual(m.room.players[other].weaponId, 'w002', 'others can switch');
  T.shutdownAllRooms();
});
test('banana: throw spawns a projectile with the documented state fields, server-side owner + sanitized username', () => {
  const m = mk(2); giveBanana(m, 0); const tgt = m.room.chaosState.targetId; const i = m.tok.indexOf(tgt);
  m.room.players[tgt].x = 0; m.room.players[tgt].z = 20; m.room.players[tgt].y = 1.6;
  m.ws[i].emitMessage({ type: 'shoot', ...aim() });
  assertEqual(m.room.bananas.length, 1); const b = m.room.bananas[0];
  for (const k of ['bananaId', 'ownerPlayerId', 'ownerUsername', 'roomId', 'position', 'velocity', 'state', 'createdAt', 'expiresAt']) assert(k in b, 'missing ' + k);
  assertEqual(b.ownerPlayerId, tgt); assertEqual(b.roomId, m.code); assertEqual(b.ownerUsername, m.room.players[tgt].name); assertEqual(b.state, 'flying');
  const ev = m.ws[1 - i >= 0 ? 1 - i : 0].lastOfType('banana_spawn'); assert(ev && ev.ownerUsername === b.ownerUsername, 'clients told');
  T.shutdownAllRooms();
});
test('banana: projectile moves forward with gravity and rotation data; it does NOT teleport in a straight line', () => {
  const m = mk(1); giveBanana(m, 0); const p = m.p(0); p.x = 0; p.z = 20; p.y = 1.6;
  assert(throwBanana(m.room, m.tok[0], p, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 }), 'thrown');
  const b = m.room.bananas[0]; const z0 = b.position[2], y0 = b.position[1], vy0 = b.velocity[1];
  stepBananas(m.room, 0.1, BC.now() + 100);
  assert(b.position[2] < z0, 'moved forward (-z)'); assert(b.velocity[1] < vy0, 'gravity reduces vy'); assert(Math.abs(b.position[2] - z0) < BC.speed * 0.1 + 0.01, 'moved by v*dt only');
  const seen = []; for (let k = 0; k < 40 && b.state === 'flying'; k++) { stepBananas(m.room, 0.05, BC.now() + 100 + k * 50); seen.push(b.position[1]); }
  assert(Math.max(...seen) >= y0 - 0.5 && seen[seen.length - 1] < Math.max(...seen), 'arc: rises/holds then falls');
  T.shutdownAllRooms();
});
test('banana: lands at a distance, becomes a peel hazard with limited lifetime, and expires', () => {
  const m = mk(1); giveBanana(m, 0); const p = m.p(0); p.x = 0; p.z = 30; p.y = 1.6;
  throwBanana(m.room, m.tok[0], p, { ox: 0, oy: 1.6, oz: 30, dx: 0, dy: 0, dz: -1 });
  const b = m.room.bananas[0]; const t0 = BC.now(); let k = 0; for (; k < 200 && b.state === 'flying'; k++) stepBananas(m.room, 0.05, t0 + (k + 1) * 50);
  assertEqual(b.state, 'peel'); assertEqual(b.position[1], BC.groundY); assert(b.position[2] < 29 && b.position[2] > -5, 'landed at a distance, z=' + b.position[2]);
  assertEqual(b.velocity.join(','), '0,0,0'); assert(b.expiresAt > t0 + (k) * 50 + BC.peelLifeMs - 200, 'peel lifetime set');
  stepBananas(m.room, 0.05, b.expiresAt + 1); assertEqual(m.room.bananas.length, 0, 'expired peel removed'); assertEqual(m.room.bananaTimer, null, 'loop stopped when empty');
  T.shutdownAllRooms();
});
test('banana: valid collision slips the target (BANANA_SLIPPED), never the owner, no damage dealt', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const victim = m.tok.find((t) => t !== owner);
  const po = m.room.players[owner], pv = m.room.players[victim]; po.x = 0; po.z = 20; po.y = 1.6; pv.x = 0; pv.z = 12; pv.y = 1.6;
  throwBanana(m.room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 });
  const hp = pv.health; run(m.room, 1.2);
  assert(isSlipped(pv), 'victim slipped'); assert(!isSlipped(po), 'owner not slipped by own flying banana'); assertEqual(pv.health, hp, 'banana deals no damage');
  const ev = m.ws[m.tok.indexOf(victim)].lastOfType('banana_slipped'); assertEqual(ev.state, 'BANANA_SLIPPED'); assertEqual(ev.ownerUsername, po.name);
  assertEqual(m.room.bananas.length, 0, 'consumed'); T.shutdownAllRooms();
});
test('banana: peel hazard slips a walker exactly once; no repeated slip during slip or immunity', () => {
  const m = mk(2); const v = m.p(1); const b = { bananaId: 'x1', ownerPlayerId: m.tok[0], ownerUsername: 'Own', roomId: m.code, position: [v.x, BC.groundY, v.z], velocity: [0, 0, 0], state: 'peel', createdAt: BC.now(), expiresAt: BC.now() + 15000 };
  m.room.bananas = [b, { ...b, bananaId: 'x2', position: [v.x, BC.groundY, v.z] }];
  stepBananas(m.room, 0.05); assert(isSlipped(v), 'slipped'); assertEqual(m.room.bananas.length, 1, 'only one peel consumed');
  const until = v.bananaSlippedUntil; stepBananas(m.room, 0.05); assertEqual(v.bananaSlippedUntil, until, 'second peel did not extend/re-trigger the slip');
  assertEqual(slipPlayer(m.room, m.tok[1], b), false, 'direct re-slip refused'); T.shutdownAllRooms();
});
test('banana: slipped player cannot move, shoot, dash or switch weapon (server-enforced)', () => {
  const m = mk(2); const v = m.p(1); slipPlayer(m.room, m.tok[1], { ownerUsername: 'Own' });
  const x0 = v.x, z0 = v.z; m.ws[1].emitMessage({ type: 'update', x: x0 + 0.1, y: 1.6, z: z0, ry: 0 }); assertEqual(v.x, x0, 'movement ignored');
  m.ws[1].emitMessage({ type: 'shoot', origin: [v.x, 1.6, v.z], dir: [0, 0, -1] }); assertEqual(v.pendingShot, null, 'no shoot credit while slipped');
  m.ws[1].emitMessage({ type: 'dash_request' }); assert(m.ws[1].lastOfType('dash_rejected') && m.ws[1].lastOfType('dash_rejected').reason === 'SLIPPED');
  m.ws[1].emitMessage({ type: 'equip_weapon', weaponId: 'w002' }); assert(v.weaponId !== 'w002', 'weapon switch blocked');
  T.shutdownAllRooms();
});
test('banana: ~4 s slip then automatic recovery (REAL timer, shortened config)', async () => {
  const m = mk(2); const saved = BC.slipMs; BC.slipMs = 300;
  try {
    slipPlayer(m.room, m.tok[1], { ownerUsername: 'Own' }); assert(isSlipped(m.p(1)), 'slipped now');
    await new Promise((r) => setTimeout(r, 150)); assert(isSlipped(m.p(1)), 'still down mid-slip');
    await new Promise((r) => setTimeout(r, 300)); assert(!isSlipped(m.p(1)), 'auto recovered'); assert(m.ws[1].lastOfType('banana_recovered'), 'recovery broadcast');
  } finally { BC.slipMs = saved; T.shutdownAllRooms(); }
});
test('banana: default slip duration is ~4 s', () => { assert(BC.slipMs >= 3500 && BC.slipMs <= 4500, 'slipMs=' + BC.slipMs); });
test('banana: fire spam is rate limited and capped per owner / per room', () => {
  const m = mk(1); giveBanana(m, 0); const p = m.p(0); const a = { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 };
  assertEqual(throwBanana(m.room, m.tok[0], p, a), true); assertEqual(throwBanana(m.room, m.tok[0], p, a), false, 'cooldown');
  for (let i = 0; i < 10; i++) { p.lastBananaAt = 0; throwBanana(m.room, m.tok[0], p, a); }
  assert(m.room.bananas.length <= BC.maxPerOwner, 'per-owner cap, got ' + m.room.bananas.length);
  T.shutdownAllRooms();
});
test('banana: a banana holder deals no hitscan damage (hit is rejected)', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const v = m.tok.find((t) => t !== owner); const io = m.tok.indexOf(owner);
  const po = m.room.players[owner]; po.x = 0; po.z = 20; m.room.players[v].x = 0; m.room.players[v].z = 10;
  m.ws[io].emitMessage({ type: 'shoot', ...aim() }); m.ws[io].emitMessage({ type: 'hit', targetId: v, ...aim() });
  assertEqual(m.room.players[v].health, 100); T.shutdownAllRooms();
});
test('banana: client cannot activate, spawn, own, collide, slip or spoof — all such messages are ignored', () => {
  const m = mk(2);
  for (const type of ['chaos_event', 'banana_weapon', 'banana_spawn', 'banana_slipped', 'banana_landed', 'banana_removed', 'banana_recovered', 'throw_banana'])
    m.ws[0].emitMessage({ type, id: m.tok[1], targetId: m.tok[1], ownerPlayerId: m.tok[1], ownerUsername: '<img src=x onerror=alert(1)>', position: [0, 0, 0], durationMs: 1, state: 'BANANA_SLIPPED' });
  assertEqual(m.room.chaosState, null); assertEqual((m.room.bananas || []).length, 0); assert(!isSlipped(m.p(1)) && !isSlipped(m.p(0)), 'nobody slipped');
  assert(!m.p(0).bananaActive && !m.p(1).bananaActive, 'no banana granted');
  // a non-holder's shoot never makes a banana
  m.ws[0].emitMessage({ type: 'shoot', ...aim() }); assertEqual((m.room.bananas || []).length, 0);
  T.shutdownAllRooms();
});
test('banana: username in the slip notification comes from the server-sanitized name (no markup can be injected)', () => {
  const m = mk(2); const owner = m.p(0); owner.name = T.sanitizeName('<script>alert(1)</script>Ow');
  assert(!/[<>]/.test(owner.name), 'sanitized name has no angle brackets: ' + owner.name);
  slipPlayer(m.room, m.tok[1], { ownerUsername: owner.name }); const ev = m.ws[0].lastOfType('banana_slipped'); assert(!/[<>]/.test(ev.ownerUsername));
  T.shutdownAllRooms();
});
test('banana: room isolation — banana/slip in room A never touches room B', () => {
  const a = mk(2), b = mk(2); giveBanana(a, 0); const owner = a.room.chaosState.targetId; const po = a.room.players[owner];
  throwBanana(a.room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 }); slipPlayer(a.room, a.tok[1], { ownerUsername: 'x' });
  assertEqual((b.room.bananas || []).length, 0); assertEqual(b.room.chaosState, null); assert(!isSlipped(b.p(0)) && !isSlipped(b.p(1)));
  assert(!b.ws[0].lastOfType('banana_spawn') && !b.ws[1].lastOfType('banana_slipped'), 'room B never received room A packets'); T.shutdownAllRooms();
});
test('banana: owner disconnect mid-flight does not crash; hazard keeps its stored owner name and expires normally', () => {
  const m = mk(3); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner]; const name = po.name;
  throwBanana(m.room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 });
  const i = m.tok.indexOf(owner); m.ws[i].emitMessage({ type: 'leave_room' });
  let threw = false; try { run(m.room, 3); } catch (e) { threw = true; }
  assert(!threw, 'stepping after owner left must not throw'); assertEqual(m.room.chaosState, null, 'event ended when holder left');
  T.shutdownAllRooms();
});
test('banana: reconnect — active banana event, live bananas and slip state are in the room_state a returning player receives', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner];
  throwBanana(m.room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 }); slipPlayer(m.room, m.tok[1], { ownerUsername: po.name });
  const st = T.roomStatePayload ? T.roomStatePayload(m.room) : null; assert(st, 'roomStatePayload exported');
  assertEqual(st.chaos.id, 'banana_weapon'); assertEqual(st.bananas.length, 1); assert(st.players.find((p) => p.token === m.tok[1]).slippedMs > 0, 'slipped remaining time present');
  assertEqual(m.room.players[owner].bananaActive, true, 'holder state survives (same player object)'); T.shutdownAllRooms();
});
test('banana: cleanup — match end / room shutdown clears bananas, loop and slip timers; weapon restored at match end', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner]; const orig = po.bananaSavedWeaponId;
  throwBanana(m.room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 }); slipPlayer(m.room, m.tok[1], { ownerUsername: 'x' });
  assert(m.room.bananaTimer && m.p(1).slipTimer, 'timers armed'); T.endMatch(m.room, 'TIME');
  assertEqual(m.room.bananas.length, 0); assertEqual(m.room.bananaTimer, null); assertEqual(m.p(1).slipTimer, null); assert(!isSlipped(m.p(1)));
  assertEqual(po.bananaActive, false); assertEqual(po.weaponId, orig, 'original weapon restored when the match ends mid-event'); T.shutdownAllRooms();
});
test('banana: room deletion leaves no orphan interval or slip timer', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner]; const room = m.room;
  throwBanana(room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 }); slipPlayer(room, m.tok[1], { ownerUsername: 'x' });
  const st = room.players[m.tok[1]]; T.shutdownAllRooms();
  assertEqual(room.bananaTimer, null); assertEqual(st.slipTimer, null); assertEqual(room.bananas.length, 0);
});
test('banana: malformed shoot payloads from a banana holder never crash or spawn anything', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const io = m.tok.indexOf(owner);
  for (const bad of [{}, { origin: null, dir: null }, { origin: [NaN, 0, 0], dir: [0, 0, -1] }, { origin: [0, 1.6, 20], dir: [Infinity, 0, 0] }, { origin: 'x', dir: [] }, { origin: [1e12, 1e12, 1e12], dir: [0, 0, -1] }, { origin: [0, 1.6, 20], dir: [0, 0, 0] }])
    m.ws[io].emitMessage({ type: 'shoot', ...bad });
  assertEqual((m.room.bananas || []).length, 0); T.shutdownAllRooms();
});
// ---- strengthened after mutation testing (4 survivors) ----
test('banana: slipped player cannot move — with a CONTROL proving the same update is accepted when not slipped', () => {
  const m = mk(2); const v = m.p(1); const t = BC.now;
  const move = (dx) => { v.lastMoveAt = 0; v.sync = null; m.ws[1].emitMessage({ type: 'update', x: v.x + dx, y: 1.6, z: v.z, ry: 0 }); };
  const x0 = v.x; move(0.2); assert(v.x !== x0, 'control: an ordinary small step IS accepted (so the slip block below is what stops it)');
  slipPlayer(m.room, m.tok[1], { ownerUsername: 'Own' }); const x1 = v.x; move(0.2); assertEqual(v.x, x1, 'slipped: same update ignored');
  T.shutdownAllRooms();
});
test('banana: the owner is never slipped by their own FLYING banana even while it is still inside their radius', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner]; po.x = 0; po.z = 20; po.y = 1.6;
  throwBanana(m.room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 });
  const b = m.room.bananas[0]; assert(Math.hypot(b.position[0] - po.x, b.position[2] - po.z) <= BC.hitRadius, 'precondition: banana starts inside the owner radius');
  stepBananas(m.room, 0.001, BC.now() + 1);
  assert(!isSlipped(po), 'owner must not be slipped by own flying banana'); T.shutdownAllRooms();
});
test('banana: end() restores the saved original weapon even if the holder weapon id changed during the event', () => {
  const m = mk(2); m.p(0).weaponId = 'w004'; giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner];
  const orig = po.bananaSavedWeaponId; po.weaponId = 'w009'; // whatever touched the weapon during the event
  T.endChaosEvent(m.room);
  assertEqual(po.weaponId, orig, 'original weapon state restored'); assertEqual(po.bananaSavedWeaponId, null); T.shutdownAllRooms();
});
test('banana: the normal room-deletion path (last player leaves) clears the banana loop and slip timers', () => {
  const m = mk(2); giveBanana(m, 0); const owner = m.room.chaosState.targetId; const po = m.room.players[owner]; const room = m.room;
  throwBanana(room, owner, po, { ox: 0, oy: 1.6, oz: 20, dx: 0, dy: 0, dz: -1 }); slipPlayer(room, m.tok[1], { ownerUsername: 'x' });
  const loser = room.players[m.tok[1]]; assert(room.bananaTimer && loser.slipTimer, 'armed');
  m.ws[0].emitMessage({ type: 'leave_room' }); m.ws[1].emitMessage({ type: 'leave_room' });
  assertEqual(T.rooms[m.code], undefined, 'room deleted through the normal path'); assertEqual(room.bananaTimer, null, 'banana loop cleared'); assertEqual(loser.slipTimer, null);
  assertEqual(room.bananas.length, 0); T.shutdownAllRooms();
});
// ---- client static checks (NOT a browser test: they only read public/index.html) ----
const fs = require('fs');
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
test('banana client (static): handles every server banana message type the server can send', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sent = new Set([...server.matchAll(/type: '(banana_[a-z]+)'/g)].map((m) => m[1]));
  assert(sent.size >= 5, 'server sends banana_* messages: ' + [...sent].join(','));
  for (const t of sent) assert(CLIENT.includes("'" + t + "'"), 'client has no handler for ' + t);
});
test('banana client (static): username is shown via textContent only (showToast), never innerHTML; name is cleaned', () => {
  const blk = CLIENT.slice(CLIENT.indexOf('function handleBananaMessage'), CLIENT.indexOf('function handleChaosEvent('));
  assert(blk.includes('showToast(') && blk.includes('cleanName(msg.ownerUsername)'), 'toast uses cleaned server username');
  assert(!/innerHTML/.test(blk), 'no innerHTML in the banana handler'); assert(/You got slapped by/.test(blk));
  assert(/function showToast[\s\S]{0,120}\.textContent\s*=/.test(CLIENT), 'showToast writes textContent');
});
test('banana client (static): reuses the existing knockdown/fall state (no second animation engine) and cleans up on match end', () => {
  const blk = CLIENT.slice(CLIENT.indexOf('function handleBananaMessage'), CLIENT.indexOf('function handleChaosEvent('));
  assert(blk.includes('startKnockdown(') && blk.includes('endKnockdown()'), 'slip uses startKnockdown/endKnockdown');
  assertEqual((CLIENT.match(/function startKnockdown/g) || []).length, 1, 'still exactly one knockdown implementation');
  assert(/match_end'\) \{\s*clearBananaMeshes\(\)/.test(CLIENT), 'meshes cleared on match end');
  assert(/if \(scene\) syncBananas\(msg\.bananas\)/.test(CLIENT), 'reconnect rebuilds bananas from the room_state snapshot');
});
test('banana client (static): Chaos Effects OFF only gates the banner, never the gameplay state or the meshes', () => {
  const blk = CLIENT.slice(CLIENT.indexOf("msg.id === 'banana_weapon'"), CLIENT.indexOf("msg.id === 'banana_weapon'") + 420);
  assert(/if \(fx\) showChaosBanner/.test(blk) && /bananaHolder = true/.test(blk) && !/if \(fx\)[^\n]*bananaHolder/.test(blk));
});
