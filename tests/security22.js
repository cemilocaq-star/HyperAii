// Phase 22 — server-side combat/shoot/pickup validation, badge+title cosmetic
// integrity, room isolation, reconnect/host-migration and fuzz regression.
//
// Uses the SAME harness as every other suite (tests/run.js): the real server.js
// handlers driven through fake sockets. Timer-dependent behavior (fire-rate,
// pickup respawn) is tested with REAL timers, not mocks.
//
// NOTE on NaN/Infinity: packets travel as JSON, and JSON.stringify turns
// NaN/Infinity into null before the server ever sees them. The fuzz tests
// therefore send what a hostile client can actually put on the wire (null,
// numeric strings, huge numbers, 1e999 written as raw JSON text).
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const S = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, HIT_CONFIG, SHOOT_CONFIG, PICKUP_CONFIG, COSMETICS } = S;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withCfg(cfg, over, fn) {
  const saved = { ...cfg };
  Object.assign(cfg, over);
  const restore = () => Object.assign(cfg, saved);
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

// Room with N started players. Returns clients, tokens and the live room object.
function startedRoom(n = 2, joinExtra = {}) {
  const ws = []; const tok = [];
  ws[0] = connect('h'); tok[0] = hello(ws[0]);
  ws[0].emitMessage({ type: 'create_room', maxPlayers: 8, name: 'P0' });
  const code = ws[0].lastOfType('room_created').code;
  for (let i = 1; i < n; i++) {
    ws[i] = connect('g' + i); tok[i] = hello(ws[i]);
    ws[i].emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i, ...joinExtra });
    ws[i].emitMessage({ type: 'player_ready' });
  }
  ws[0].emitMessage({ type: 'start_game' });
  const room = rooms[code];
  assert(room && room.started, 'room should be started');
  return { ws, tok, room, code };
}

// Put a player at an exact server-known position (bypasses the movement layer on purpose).
function place(room, token, x, z) {
  const p = room.players[token];
  p.x = x; p.y = 1.6; p.z = z; p.sync = null; p.moveStrikes = [];
  return p;
}
function aimFrom(room, atkTok, tgtTok, jitter = [0, 0, 0]) {
  const a = room.players[atkTok], t = room.players[tgtTok];
  // aims at the target's TORSO centre (eye - 0.6): hit-location damage means an eye-level shot is a headshot (x2); these tests assert the base damage
  const v = [t.x - a.x + jitter[0], t.y - 0.6 - a.y + jitter[1], t.z - a.z + jitter[2]];
  const len = Math.hypot(...v) || 1;
  return { origin: [a.x, a.y, a.z], dir: v.map((c) => c / len) };
}
// Deterministic clock for rate-limit logic. Production reads Date.now(); the config hooks let a
// test move time explicitly instead of sleeping or widening tolerances.
function makeClock(start = 1e9) { const c = { t: start, now: () => c.t, tick(ms) { c.t += ms; } }; return c; }
function withClock(clock, fn) {
  return withCfg(HIT_CONFIG, { now: clock.now }, () => withCfg(SHOOT_CONFIG, { now: clock.now }, fn));
}

// A well-behaved client: `shoot` (intent) first, then `hit` (claim) with the same aim.
// Sends the shoot only when the packet carries a usable aim, so malformed-aim tests stay malformed.
function hitP(w, pkt) {
  if (pkt && Array.isArray(pkt.origin) && Array.isArray(pkt.dir)) w.emitMessage({ type: 'shoot', origin: pkt.origin, dir: pkt.dir });
  w.emitMessage(pkt);
}

// Strict = production hit path (requireAim true) with fire-rate floors removed so multi-hit
// sequences (kill in 4 hits) run instantly. Rate limits themselves are tested with explicit clocks.
function strictHit(fn) {
  return withCfg(HIT_CONFIG, { requireAim: true, minIntervalMs: 0, rng: () => 0.99 }, () => withCfg(SHOOT_CONFIG, { minIntervalMs: 0 }, fn));
}
function strictHitAsync(fn) { return withCfg(HIT_CONFIG, { requireAim: true, rng: () => 0.99 }, fn); }

// ======================================================================
// 1. SERVER-SIDE COMBAT TARGET VALIDATION
// ======================================================================

test('p22 combat: an aimed hit at a valid in-range target lands and server computes damage', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -20);
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  const c = ws[0].lastOfType('hit_confirm');
  assert(c, 'expected hit_confirm'); assertEqual(c.damage, 25); assertEqual(room.players[tok[1]].health, 75);
}));

test('p22 combat: hit without aim data (origin/dir) is rejected', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  hitP(ws[0], { type: 'hit', targetId: tok[1] });
  assert(!ws[0].lastOfType('hit_confirm')); assertEqual(room.players[tok[1]].health, 100);
}));

test('p22 combat: target behind the shooter (aim points away) is rejected', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  const a = aimFrom(room, tok[0], tok[1]); a.dir = a.dir.map((c) => -c);
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...a });
  assert(!ws[0].lastOfType('hit_confirm')); assertEqual(room.players[tok[1]].health, 100);
}));

test('p22 combat: claimed aim far from the server-known target is rejected (not looking at them)', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -30);
  const a = aimFrom(room, tok[0], tok[1], [15, 0, 0]); // aiming ~15u to the side of the target
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...a });
  assert(!ws[0].lastOfType('hit_confirm')); assertEqual(room.players[tok[1]].health, 100);
}));

test('p22 combat: aim origin far from the server-known shooter position is rejected', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  const a = aimFrom(room, tok[0], tok[1]); a.origin = [30, 1.6, 30];
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...a });
  assert(!ws[0].lastOfType('hit_confirm')); assertEqual(room.players[tok[1]].health, 100);
}));

test('p22 combat: target beyond weapon range is rejected even with a perfect aim', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], -38, -38); place(room, tok[1], 38, 38); // ~107u apart: inside 150 -> allowed baseline
  withCfg(HIT_CONFIG, { maxRange: 50 }, () => {
    hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  });
  assert(!ws[0].lastOfType('hit_confirm')); assertEqual(room.players[tok[1]].health, 100);
}));

test('p22 combat: dead attacker / dead target cannot hit or be hit', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  room.players[tok[0]].alive = false;
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  assertEqual(room.players[tok[1]].health, 100, 'dead attacker dealt damage');
  room.players[tok[0]].alive = true; room.players[tok[1]].alive = false;
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  assert(!ws[0].lastOfType('hit_confirm'), 'hit on a dead target confirmed');
}));

test('p22 combat: client-supplied damage/crit/kill/health/score/reward fields are ignored', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  hitP(ws[0], {
    type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]),
    damage: 9999, crit: true, killed: true, kill: true, health: 0, targetHealth: -5, score: 999, kills: 99, bountyReward: 1000, reward: 500,
  });
  assertEqual(room.players[tok[1]].health, 75, 'health must only change by the server-computed 25');
  assertEqual(room.players[tok[1]].alive, true);
  assertEqual(room.players[tok[0]].kills, 0, 'no client-made kill');
  const c = ws[0].lastOfType('hit_confirm'); assertEqual(c.damage, 25); assertEqual(c.crit, false); assertEqual(c.killed, false);
}));

test('p22 combat: malformed target ids never hit anything and never throw', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  const aim = aimFrom(room, tok[0], tok[1]);
  const bad = [null, 0, 1, -1, 1e308, [], [tok[1]], {}, { toString: 'x' }, true, '', ' ', '__proto__', 'constructor', 'toString', 'A'.repeat(100000), tok[1] + 'x', tok[1].toUpperCase() + '!!'];
  for (const b of bad) hitP(ws[0], { type: 'hit', targetId: b, ...aim });
  hitP(ws[0], { type: 'hit', ...aim }); // targetId missing entirely
  assertEqual(room.players[tok[1]].health, 100, 'a malformed id damaged the target');
  assert(!ws[0].lastOfType('hit_confirm'));
}));

test('p22 combat: malformed aim payloads are rejected (strings, wrong length, huge, zero-length, nested)', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  const good = aimFrom(room, tok[0], tok[1]);
  const variants = [
    { origin: 'x', dir: good.dir }, { origin: good.origin, dir: 'x' },
    { origin: [0, 1.6], dir: good.dir }, { origin: good.origin, dir: [0, 0, -1, 0] },
    { origin: ['0', '1.6', '0'], dir: good.dir }, { origin: good.origin, dir: ['0', '0', '-1'] },
    { origin: [null, 1.6, 0], dir: good.dir }, { origin: good.origin, dir: [0, 0, 0] },       // zero-length
    { origin: good.origin, dir: [0, 0, -50] },                                                // absurd magnitude
    { origin: [1e9, 1.6, 0], dir: good.dir }, { origin: good.origin, dir: [[0], 0, -1] },
    { origin: {}, dir: {} }, { origin: null, dir: null },
  ];
  for (const v of variants) hitP(ws[0], { type: 'hit', targetId: tok[1], ...v });
  // raw JSON that overflows to Infinity on parse
  ws[0]._handlers.message(`{"type":"hit","targetId":"${tok[1]}","origin":[0,1.6,0],"dir":[0,0,-1e999]}`);
  assertEqual(room.players[tok[1]].health, 100, 'malformed aim caused damage');
}));

test('p22 combat: cross-room target is rejected (A1 cannot hit B1 even with B1\'s real token)', () => strictHit(() => {
  const A = startedRoom(2); const B = startedRoom(2);
  place(A.room, A.tok[0], 0, 0); place(B.room, B.tok[0], 0, -10);
  hitP(A.ws[0], { type: 'hit', targetId: B.tok[0], origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(B.room.players[B.tok[0]].health, 100); assert(!A.ws[0].lastOfType('hit_confirm'));
}));

test('p22 combat: fire-rate cap (REAL time): a click burst deals one hit, the next click after the interval lands', async () => {
  await strictHitAsync(async () => withCfg(HIT_CONFIG, { minIntervalMs: 80 }, async () => {
    const { ws, tok, room } = startedRoom(2);
    place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
    const click = () => hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
    for (let i = 0; i < 6; i++) click(); // 6 clicks in the same instant
    assertEqual(room.players[tok[1]].health, 75, 'burst must deal exactly one hit');
    await sleep(110); // real timer: > shoot floor (50ms) and > hit floor (80ms)
    click();
    assertEqual(room.players[tok[1]].health, 50, 'after the cooldown the next hit counts');
  }));
});

// ---- shoot -> hit protocol (deterministic clock, production hit path) ----------------------

function clockedFight() {
  const clk = makeClock();
  const f = startedRoom(2);
  place(f.room, f.tok[0], 0, 0); place(f.room, f.tok[1], 0, -10);
  return { clk, ...f, aim: aimFrom(f.room, f.tok[0], f.tok[1]) };
}
const prodHit = (fn) => withCfg(HIT_CONFIG, { requireAim: true, rng: () => 0.99 }, fn);

test('p22 protocol: a `hit` with NO preceding `shoot` never applies damage (production path)', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => { ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim }); });
  assertEqual(room.players[tok[1]].health, 100); assert(!ws[0].lastOfType('hit_confirm'));
}));

test('p22 protocol: `shoot` alone is intent only — it never damages or kills anyone', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => { for (let i = 0; i < 50; i++) { ws[0].emitMessage({ type: 'shoot', ...aim, targetId: tok[1], damage: 100, kill: true }); clk.tick(60); } });
  assertEqual(room.players[tok[1]].health, 100); assertEqual(room.players[tok[0]].kills, 0);
}));

test('p22 protocol: a replayed identical hit packet cannot apply twice, even long after the rate window', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => {
    hitP(ws[0], { type: 'hit', targetId: tok[1], ...aim });
    assertEqual(room.players[tok[1]].health, 75);
    for (let i = 0; i < 20; i++) { clk.tick(200); ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim }); } // replay, no new shoot
  });
  assertEqual(room.players[tok[1]].health, 75, 'replay applied damage');
}));

test('p22 protocol: 2000 duplicate hit packets after ONE shoot = exactly one hit, one kill credit at most', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => {
    room.players[tok[1]].health = 25; // one hit from death
    ws[0].emitMessage({ type: 'shoot', ...aim });
    for (let i = 0; i < 2000; i++) { if (i % 100 === 0) clk.tick(90); ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim }); }
  });
  assertEqual(room.players[tok[1]].deaths, 1, 'victim died exactly once'); assertEqual(room.players[tok[0]].kills, 1, 'kill credited exactly once');
  assertEqual(ws[0].allOfType('hit_confirm').length, 1);
}));

test('p22 protocol: the shot credit expires (stale shoot cannot back a late hit)', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => {
    ws[0].emitMessage({ type: 'shoot', ...aim });
    clk.tick(HIT_CONFIG.shotWindowMs + 1);
    ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });
    assertEqual(room.players[tok[1]].health, 100, 'expired credit accepted');
    ws[0].emitMessage({ type: 'shoot', ...aim }); clk.tick(HIT_CONFIG.shotWindowMs - 1);
    ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });
    assertEqual(room.players[tok[1]].health, 75, 'a credit still inside the window must work');
  });
}));

test('p22 protocol: a hit whose aim differs from its shoot is rejected, and the credit is still consumed', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => {
    ws[0].emitMessage({ type: 'shoot', origin: aim.origin, dir: [0, 0, 1] }); // shot fired AWAY from the target
    ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });             // ...claimed as a hit on the target
    assertEqual(room.players[tok[1]].health, 100, 'mismatched aim accepted');
    clk.tick(100);
    ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });             // credit was consumed: retry needs a new shoot
    assertEqual(room.players[tok[1]].health, 100, 'consumed credit reused');
    ws[0].emitMessage({ type: 'shoot', ...aim }); clk.tick(60);
    ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });
    assertEqual(room.players[tok[1]].health, 75);
  });
}));

test('p22 protocol: one shoot backs at most one target (no multi-hit from a single shot)', () => prodHit(() => {
  const clk = makeClock(); const f = startedRoom(3);
  place(f.room, f.tok[0], 0, 0); place(f.room, f.tok[1], 0, -10); place(f.room, f.tok[2], 0, -10.4);
  const aim = aimFrom(f.room, f.tok[0], f.tok[1]);
  withClock(clk, () => {
    f.ws[0].emitMessage({ type: 'shoot', ...aim });
    f.ws[0].emitMessage({ type: 'hit', targetId: f.tok[1], ...aim }); clk.tick(90);
    f.ws[0].emitMessage({ type: 'hit', targetId: f.tok[2], ...aim });
  });
  assertEqual(f.room.players[f.tok[1]].health, 75); assertEqual(f.room.players[f.tok[2]].health, 100);
}));

test('p22 protocol: rate limits are exact under a frozen clock (2000 x shoot+hit = 1 hit, 1 broadcast; +interval = +1)', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  ws[1].sent.length = 0;
  withClock(clk, () => {
    for (let i = 0; i < 2000; i++) { ws[0].emitMessage({ type: 'shoot', ...aim }); ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim }); ws[0].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' }); }
    assertEqual(room.players[tok[1]].health, 75, 'frozen clock: exactly one hit'); assertEqual(ws[1].allOfType('shoot').length, 1, 'frozen clock: exactly one broadcast');
    clk.tick(Math.max(HIT_CONFIG.minIntervalMs, SHOOT_CONFIG.minIntervalMs));
    ws[0].emitMessage({ type: 'shoot', ...aim }); ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });
    assertEqual(room.players[tok[1]].health, 50); assertEqual(ws[1].allOfType('shoot').length, 2);
  });
}));

test('p22 combat: chaos Duck Weapon still deals no damage under the stricter path', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  room.players[tok[0]].duckWeaponUntil = Date.now() + 5000;
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  assertEqual(room.players[tok[1]].health, 100);
}));

// ======================================================================
// 2. SHOOT MESSAGE SECURITY
// ======================================================================

test('p22 shoot: valid shot is rebroadcast to others only, with server-sanitized numbers (no extra fields)', () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0);
  ws[1].sent.length = 0;
  ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -2 * 0.6], damage: 9999, evil: '<script>' });
  const s = ws[1].lastOfType('shoot'); assert(s, 'peer should see the shot');
  assertEqual(s.token, tok[0]);
  assert(Math.abs(Math.hypot(...s.dir) - 1) < 1e-9, 'dir must be re-normalized by the server');
  assert(!('damage' in s) && !('evil' in s), 'raw client fields must not be forwarded');
  assert(!ws[0].lastOfType('shoot'), 'shooter does not get its own shot echoed');
});

test('p22 shoot: malformed payloads are dropped without broadcast or crash', () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); ws[1].sent.length = 0;
  const bad = [
    {}, { origin: 1, dir: 2 }, { origin: [0, 1.6, 0] }, { dir: [0, 0, -1] },
    { origin: 'a', dir: 'b' }, { origin: [0, 0], dir: [0, 0, -1] }, { origin: ['0', '0', '0'], dir: [0, 0, -1] },
    { origin: [null, null, null], dir: [null, null, null] }, { origin: [0, 1.6, 0], dir: [0, 0, 0] },
    { origin: [0, 1.6, 0], dir: [0, 0, 9999] }, { origin: [1e12, 0, 0], dir: [0, 0, -1] },
    { origin: [0, 1.6, 0], dir: [[], {}, 'x'] }, { origin: new Array(1000).fill(0), dir: [0, 0, -1] },
  ];
  for (const b of bad) ws[0].emitMessage({ type: 'shoot', ...b });
  ws[0]._handlers.message('{"type":"shoot","origin":[0,1.6,0],"dir":[1e999,0,0]}');
  assertEqual(ws[1].allOfType('shoot').length, 0, 'a malformed shoot was broadcast');
});

test('p22 shoot: origin far from the server-known position is rejected', () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); ws[1].sent.length = 0;
  ws[0].emitMessage({ type: 'shoot', origin: [35, 1.6, 35], dir: [0, 0, -1] });
  assertEqual(ws[1].allOfType('shoot').length, 0);
});

test('p22 shoot: rapid-fire spam is rate-limited with real time, then allowed again', async () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); ws[1].sent.length = 0;
  for (let i = 0; i < 30; i++) ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(ws[1].allOfType('shoot').length, 1, '30 instant shoots must yield 1 broadcast');
  await sleep(SHOOT_CONFIG.minIntervalMs + 30);
  ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(ws[1].allOfType('shoot').length, 2);
});

test('p22 shoot: dead players cannot shoot; lobby (not started) players cannot shoot', () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); room.players[tok[0]].alive = false; ws[1].sent.length = 0;
  ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(ws[1].allOfType('shoot').length, 0);
  // lobby
  const h = connect('lh'); hello(h); h.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const g = connect('lg'); hello(g); g.emitMessage({ type: 'join_room', roomCode: h.lastOfType('room_created').code });
  h.emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(g.allOfType('shoot').length, 0);
});

test('p22 shoot: room isolation — a shot in room A is never delivered to room B', () => {
  const A = startedRoom(2); const B = startedRoom(2);
  place(A.room, A.tok[0], 0, 0); B.ws.forEach((w) => { w.sent.length = 0; });
  A.ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  B.ws.forEach((w) => assertEqual(w.allOfType('shoot').length, 0));
  assertEqual(A.ws[1].allOfType('shoot').length, 1);
});

// ======================================================================
// 3. TROLL_PICKUP SECURITY (server-owned pickups)
// ======================================================================

const troll0 = (r) => r.pickups.pk0;

test('p22 pickup: game_started carries a server-owned pickup list (4 ids, positions, active)', () => {
  const { ws, room } = startedRoom(2);
  const gs = ws[1].lastOfType('game_started');
  assert(Array.isArray(gs.pickups) && gs.pickups.length === PICKUP_CONFIG.count, 'expected server pickups in game_started');
  gs.pickups.forEach((p) => { assert(typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.z) && p.active === true, 'bad pickup entry'); });
  assertEqual(Object.keys(room.pickups).length, PICKUP_CONFIG.count);
});

test('p22 pickup: valid pickup deactivates it for everyone and curses ONLY the real sender', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const { ws, tok, room } = startedRoom(3);
  place(room, tok[1], troll0(room).x, troll0(room).z);
  ws.forEach((w) => { w.sent.length = 0; });
  // client tries to name somebody else as the cursed target
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0', targetId: tok[2] });
  assertEqual(troll0(room).active, false);
  ws.forEach((w) => { const st = w.lastOfType('pickup_state'); assert(st && st.id === 'pk0' && st.active === false, 'everyone must see the pickup vanish'); });
  const t = ws[0].lastOfType('troll'); assert(t, 'troll broadcast expected');
  assertEqual(t.targetId, tok[1], 'the cursed player is the validated sender, not the client-supplied targetId');
  clearTimers(room);
}));

test('p22 pickup: too far away -> rejected, pickup stays active', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const { ws, tok, room } = startedRoom(2);
  const pk = troll0(room);
  place(room, tok[1], pk.x > 0 ? pk.x - 30 : pk.x + 30, pk.z);
  ws[0].sent.length = 0;
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  assertEqual(pk.active, true); assert(!ws[0].lastOfType('troll'));
}));

test('p22 pickup: an already-taken pickup cannot be taken twice (even by a second nearby player)', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const { ws, tok, room } = startedRoom(3);
  const pk = troll0(room);
  place(room, tok[1], pk.x, pk.z); place(room, tok[2], pk.x, pk.z);
  ws[0].sent.length = 0;
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  ws[2].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' }); // duplicate packet
  assertEqual(ws[0].allOfType('troll').length, 1, 'exactly one troll for one pickup');
  clearTimers(room);
}));

test('p22 pickup: unknown / malformed / prototype ids are rejected without throwing', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[1], troll0(room).x, troll0(room).z); ws[0].sent.length = 0;
  const bad = [null, 0, 7, [], ['pk0'], {}, true, '', 'pk99', '__proto__', 'constructor', 'toString', 'PK0', 'pk0 ', 'A'.repeat(50000)];
  for (const b of bad) ws[1].emitMessage({ type: 'troll_pickup', pickupId: b });
  ws[1].emitMessage({ type: 'troll_pickup' });
  ws[1].emitMessage({ type: 'troll_pickup', targetId: tok[1] }); // legacy shape: no pickupId -> nothing
  assertEqual(troll0(room).active, true); assertEqual(ws[0].allOfType('troll').length, 0);
}));

test('p22 pickup: coordinates in the packet are irrelevant — only the server-known position counts', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const { ws, tok, room } = startedRoom(2);
  const pk = troll0(room);
  place(room, tok[1], pk.x > 0 ? pk.x - 30 : pk.x + 30, pk.z);
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0', x: pk.x, z: pk.z, position: [pk.x, 1, pk.z] });
  assertEqual(pk.active, true);
}));

test('p22 pickup: other room\'s pickup cannot be taken (each room owns its own map)', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const A = startedRoom(2); const B = startedRoom(2);
  const bpk = B.room.pickups.pk0, apk = A.room.pickups.pk0;
  // force A's pk0 far away from where B's pk0 is, then stand A1 on B's pk0
  apk.x = bpk.x > 0 ? bpk.x - 30 : bpk.x + 30; apk.z = bpk.z;
  place(A.room, A.tok[0], bpk.x, bpk.z);
  B.ws.forEach((w) => { w.sent.length = 0; });
  A.ws[0].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  assertEqual(bpk.active, true, 'B pickup must not be affected'); assertEqual(apk.active, true);
  B.ws.forEach((w) => { assert(!w.lastOfType('pickup_state') && !w.lastOfType('troll'), 'B must not hear about A'); });
}));

test('p22 pickup: dead players cannot pick up; per-player attempt cooldown limits spam', () => {
  const { ws, tok, room } = startedRoom(2);
  const pk = troll0(room);
  place(room, tok[1], pk.x, pk.z);
  room.players[tok[1]].alive = false;
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  assertEqual(pk.active, true, 'dead player took a pickup');
  room.players[tok[1]].alive = true;
  // spam: first attempt is a miss (wrong id) and starts the cooldown; the immediate valid one is dropped
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'nope' });
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  assertEqual(pk.active, true, 'attempt inside the cooldown window must be ignored');
});

test('p22 pickup: respawn timer (real time) reactivates the pickup, broadcasts it, and moves it', async () => {
  let n = 0;
  await withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0, respawnMs: 60, rng: () => [0.1, 0.9, 0.3, 0.7][n++ % 4] }, async () => {
    const { ws, tok, room } = startedRoom(2);
    const pk = troll0(room);
    place(room, tok[1], pk.x, pk.z);
    ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
    assertEqual(pk.active, false);
    ws[0].sent.length = 0;
    await sleep(140);
    assertEqual(pk.active, true, 'pickup should respawn');
    const st = ws[0].lastOfType('pickup_state'); assert(st && st.active === true && st.id === 'pk0', 'respawn must be broadcast');
    clearTimers(room);
  });
});

test('p22 pickup: room deletion clears the pending respawn timer and nothing fires afterwards', async () => {
  await withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0, respawnMs: 60 }, async () => {
    const { ws, tok, room, code } = startedRoom(2);
    const pk = troll0(room); const pickups = room.pickups;
    place(room, tok[1], pk.x, pk.z);
    ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
    assert(pk.timer, 'a respawn timer must be pending');
    ws[0].emitMessage({ type: 'leave_room' }); ws[1].emitMessage({ type: 'leave_room' });
    assert(!rooms[code], 'room should be deleted');
    assertEqual(pk.timer, null, 'pickup timer must be cleared on room deletion');
    await sleep(120);
    assertEqual(pk.active, false, 'a cleared timer must never reactivate a pickup of a dead room');
    assertEqual(Object.keys(pickups).length, PICKUP_CONFIG.count);
  });
});

test('p22 pickup: reconnect gets the CURRENT pickup state (taken pickup stays taken), no duplicates', () => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const { ws, tok, room } = startedRoom(2);
  const pk = troll0(room);
  place(room, tok[1], pk.x, pk.z);
  ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  ws[1].emitClose();
  const ws2 = connect('re'); hello(ws2, tok[1]);
  const gs = ws2.lastOfType('game_started');
  assert(gs && gs.rejoin && Array.isArray(gs.pickups), 'rejoin must carry pickups');
  assertEqual(gs.pickups.length, PICKUP_CONFIG.count);
  assertEqual(gs.pickups.find((p) => p.id === 'pk0').active, false);
  clearTimers(room);
}));

function clearTimers(room) { for (const id in room.pickups) { if (room.pickups[id].timer) { clearTimeout(room.pickups[id].timer); room.pickups[id].timer = null; } } }

// ======================================================================
// 4. BADGE + TITLE (server-authoritative cosmetic state)
// ======================================================================

test('p22 cosmetics: badge registry entry carries a glyph the nameplate can draw', () => {
  assertEqual(COSMETICS.badgeSurvivor.icon, '🏆');
  assert(S.buildPlayerPublicState, 'public state builder exists');
});

test('p22 cosmetics: equipping a LOCKED badge is rejected and public state keeps the default', () => {
  const { ws, tok, room } = startedRoom(2);
  ws[0].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'badgeSurvivor' });
  assertEqual(ws[0].lastOfType('equip_rejected').reason, 'LOCKED');
  assertEqual(S.buildPlayerPublicState(room, room.players[tok[0]]).badge, 'badgeNone');
});

test('p22 cosmetics: equipping a LOCKED title is rejected and public state keeps the default', () => {
  const { ws, tok, room } = startedRoom(2);
  ws[0].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'titleRoadRoller' });
  assertEqual(ws[0].lastOfType('equip_rejected').reason, 'LOCKED');
  assertEqual(S.buildPlayerPublicState(room, room.players[tok[0]]).title, 'titleNone');
});

test('p22 cosmetics: unlocked badge+title equip, show in the broadcast state, and survive death/respawn + reconnect', async () => {
  const { ws, tok, room } = startedRoom(2);
  S.grantAchievement(tok[0], 'thunder_hammer_survivor'); S.grantAchievement(tok[0], 'jojo_reference_found');
  ws[0].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'badgeSurvivor' });
  ws[0].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'titleRoadRoller' });
  assertEqual(ws[0].allOfType('equip_ok').length, 2);
  let st = S.buildPlayerPublicState(room, room.players[tok[0]]);
  assertEqual(st.badge, 'badgeSurvivor'); assertEqual(st.title, 'titleRoadRoller');
  // death + respawn (real respawn path through the server)
  const p = room.players[tok[0]];
  place(room, tok[1], 0, -10); place(room, tok[0], 0, 0);
  withCfg(HIT_CONFIG, { requireAim: false, minIntervalMs: 0, rng: () => 0.99 }, () => { for (let i = 0; i < 4; i++) hitP(ws[1], { type: 'hit', targetId: tok[0] }); });
  assertEqual(p.alive, false);
  assertEqual(S.buildPlayerPublicState(room, p).badge, 'badgeSurvivor', 'badge kept while dead');
  // reconnect keeps cosmetic state
  ws[0].emitClose(); const ws2 = connect('re'); hello(ws2, tok[0]);
  assertEqual(room.players[tok[0]].equippedBadge, 'badgeSurvivor'); assertEqual(room.players[tok[0]].equippedTitle, 'titleRoadRoller');
  assert(ws2.lastOfType('room_rejoined'), 'rejoined');
});

test('p22 cosmetics: badge/title on join are re-validated; a room switch never carries the old room\'s state', () => {
  const t1 = (() => { const w = connect('u'); const t = hello(w); return { w, t }; })();
  S.grantAchievement(t1.t, 'thunder_hammer_survivor');
  t1.w.emitMessage({ type: 'create_room', maxPlayers: 4, cosmetics: { badge: 'badgeSurvivor', title: 'titleRoadRoller' } });
  const codeA = t1.w.lastOfType('room_created').code;
  const roomA = rooms[codeA];
  assertEqual(roomA.players[t1.t].equippedBadge, 'badgeSurvivor', 'unlocked badge accepted');
  assertEqual(roomA.players[t1.t].equippedTitle, 'titleNone', 'locked title silently falls back on join');
  t1.w.emitMessage({ type: 'leave_room' });
  t1.w.emitMessage({ type: 'create_room', maxPlayers: 4 }); // no cosmetics sent this time
  const roomB = rooms[t1.w.lastOfType('room_created').code];
  assertEqual(roomB.players[t1.t].equippedBadge, 'badgeNone', 'new room starts from defaults, old room state does not leak');
  // wrong-slot spoof: a title id offered as a badge
  const w2 = connect('v'); const t2 = hello(w2);
  w2.emitMessage({ type: 'create_room', maxPlayers: 4, cosmetics: { badge: 'titleNone', title: 'badgeNone', color: ['colorGold'], accessory: { id: 'accessoryHalo' } } });
  const r2 = rooms[w2.lastOfType('room_created').code];
  assertEqual(r2.players[t2].equippedBadge, 'badgeNone'); assertEqual(r2.players[t2].equippedTitle, 'titleNone'); assertEqual(r2.players[t2].equippedColor, 'colorDefault'); assertEqual(r2.players[t2].equippedAccessory, 'accessoryNone');
});

test('p22 cosmetics: spectators receive the target\'s badge/title through the same public state', () => {
  const { ws, tok, room } = startedRoom(3);
  S.grantAchievement(tok[1], 'thunder_hammer_survivor');
  ws[1].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'badgeSurvivor' });
  const st = S.buildPlayerPublicState(room, room.players[tok[1]]);
  assertEqual(st.badge, 'badgeSurvivor'); // this exact object is what the 15Hz broadcast sends to every client, incl. spectators
});

// ======================================================================
// 5. ATTACK SCENARIOS (spec section 7) — none may forge server state
// ======================================================================

test('p22 attack: client sends "kill" / "damage" / "score" / "reward" message types directly -> nothing happens', () => {
  const { ws, tok, room } = startedRoom(2);
  const before = JSON.stringify([room.players[tok[1]].health, room.players[tok[1]].deaths, room.players[tok[0]].kills]);
  for (const type of ['kill', 'damage', 'score', 'reward', 'bounty_reward', 'respawn', 'hit_confirm', 'you_died', 'pickup_state', 'troll', 'position_correct']) {
    ws[0].emitMessage({ type, id: tok[1], victimId: tok[1], killerId: tok[0], targetId: tok[1], health: 0, damage: 999, amount: 999 });
  }
  assertEqual(JSON.stringify([room.players[tok[1]].health, room.players[tok[1]].deaths, room.players[tok[0]].kills]), before);
  assert(room.players[tok[1]].alive !== false);
});

test('p22 attack: nonexistent playerId / fake target health / NaN-Infinity coordinate wire values', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  hitP(ws[0], { type: 'hit', targetId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', ...aimFrom(room, tok[0], tok[1]) });
  hitP(ws[0], { type: 'hit', targetId: tok[1], origin: [NaN, NaN, NaN], dir: [Infinity, 0, 0] }); // becomes nulls on the wire
  ws[0]._handlers.message(`{"type":"update","x":1e999,"y":1.6,"z":0,"ry":0}`);
  ws[0]._handlers.message(`{"type":"update","x":"1","y":"1.6","z":"0","ry":"0"}`);
  assertEqual(room.players[tok[1]].health, 100); assert(Number.isFinite(room.players[tok[0]].x) && Number.isFinite(room.players[tok[0]].z));
}));

test('p22 attack: reconnecting cannot duplicate rewards/kills/state (kills counted once)', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  for (let i = 0; i < 4; i++) hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  assertEqual(room.players[tok[0]].kills, 1); assertEqual(room.players[tok[1]].deaths, 1);
  for (let i = 0; i < 3; i++) { ws[0].emitClose(); const w = connect('r' + i); hello(w, tok[0]); ws[0] = w; }
  assertEqual(room.players[tok[0]].kills, 1, 'reconnect must not add or reset kills'); assertEqual(room.order.filter((t) => t === tok[0]).length, 1, 'no duplicate player entry');
  assertEqual(Object.keys(room.players).length, 2);
}));

// ======================================================================
// 6. ROOM ISOLATION (two rooms x two players)
// ======================================================================

test('p22 isolation: A1->B1 attack, A1->B pickup, cosmetics, combat, events and rewards never cross rooms', () => strictHit(() => withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0 }, () => {
  const A = startedRoom(2); const B = startedRoom(2);
  const [a1, a2] = A.tok, [b1, b2] = B.tok;
  place(A.room, a1, 0, 0); place(A.room, a2, 0, -10); place(B.room, b1, 0, 0); place(B.room, b2, 0, -10);
  B.ws.forEach((w) => { w.sent.length = 0; });
  // attack across rooms (real tokens of the other room)
  hitP(A.ws[0], { type: 'hit', targetId: b1, ...aimFrom(A.room, a1, a2) });
  hitP(A.ws[0], { type: 'hit', targetId: b2, origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(B.room.players[b1].health, 100); assertEqual(B.room.players[b2].health, 100);
  // a real kill in A must not touch B's stats
  for (let i = 0; i < 4; i++) hitP(A.ws[0], { type: 'hit', targetId: a2, ...aimFrom(A.room, a1, a2) });
  assertEqual(A.room.players[a1].kills, 1); assertEqual(B.room.players[b1].kills, 0); assertEqual(B.room.players[b2].deaths, 0);
  // pickup across rooms
  const bpk = B.room.pickups.pk1; place(A.room, a1, bpk.x, bpk.z);
  A.ws[0].emitMessage({ type: 'troll_pickup', pickupId: 'pk1' });
  assertEqual(bpk.active, true);
  // cosmetics
  S.grantAchievement(a1, 'thunder_hammer_survivor'); A.ws[0].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'badgeSurvivor' });
  assertEqual(B.room.players[b1].equippedBadge, 'badgeNone');
  // chaos event started in A
  S.startChaosEvent(A.room, S.RandomEventRegistry[Object.keys(S.RandomEventRegistry)[0]]);
  assertEqual(B.room.chaosState, null, 'B must not receive A\'s chaos event');
  S.endChaosEvent(A.room, A.room.chaosState && A.room.chaosState.id);
  // nothing addressed to B's sockets except B's own periodic state ticks
  B.ws.forEach((w) => { for (const m of w.sent) assert(!['kill', 'damage', 'hit_confirm', 'troll', 'pickup_state', 'chaos_start', 'you_died'].includes(m.type), 'B saw ' + m.type + ' from room A'); });
  clearTimers(A.room);
})));

// ======================================================================
// 7. RECONNECT / HOST MIGRATION with the new security state
// ======================================================================

test('p22 host migration: old host reconnects as a normal player; settings, combat, cosmetics, kills survive', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(3);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  S.grantAchievement(tok[0], 'thunder_hammer_survivor');
  ws[0].emitMessage({ type: 'equip_cosmetic', cosmeticId: 'badgeSurvivor' });
  for (let i = 0; i < 4; i++) hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  const settings = { max: room.maxPlayers, mode: room.mode, map: room.map };
  ws[0].emitClose(); // host drops
  assert(room.hostToken !== tok[0], 'host must migrate');
  const newHost = room.hostToken;
  const w = connect('old'); hello(w, tok[0]);
  assertEqual(room.hostToken, newHost, 'old host must NOT regain host on reconnect');
  assertEqual(room.players[tok[0]].kills, 1); assertEqual(room.players[tok[0]].equippedBadge, 'badgeSurvivor');
  assertEqual(room.maxPlayers, settings.max); assertEqual(room.mode, settings.mode); assertEqual(room.map, settings.map);
  // old host, now a normal player, must not be able to start/host-only actions
  w.emitMessage({ type: 'start_game' });
  assertEqual(room.players[tok[0]].kills, 1);
  // and can still fight with validated packets
  place(room, tok[0], 0, 0); place(room, tok[2], 0, -10);
  hitP(w, { type: 'hit', targetId: tok[2], ...aimFrom(room, tok[0], tok[2]) });
  assertEqual(room.players[tok[2]].health, 75);
}));

// ======================================================================
// 8. FUZZ / PACKET SPAM — the server must never throw or change unrelated state
// ======================================================================

// The list of message types is EXTRACTED from server.js so a newly added handler is fuzzed
// automatically (a hand-written list silently goes stale).
const fs22 = require('fs');
const SERVER_SRC = fs22.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const ALL_TYPES = [...new Set([...SERVER_SRC.matchAll(/msg\.type === '([a-z_]+)'/g)].map((m) => m[1]))];

function fuzzValues() {
  let deep = {}; let cur = deep; for (let i = 0; i < 200; i++) { cur.a = {}; cur = cur.a; }
  const deepArr = []; let ca = deepArr; for (let i = 0; i < 200; i++) { const n = []; ca.push(n); ca = n; }
  return [null, undefined, 0, -0, -1, 1, 0.5, -1e308, 1e308, Number.MAX_SAFE_INTEGER, 'NaN', 'Infinity', '-Infinity', '', ' ', 'x', '__proto__', 'constructor', '<script>alert(1)</script>',
    'A'.repeat(20000), 'A'.repeat(70000), true, false, [], [1, 2, 3], [null, null, null], ['a'], {}, { a: 1 }, deep, deepArr, { __proto__: { polluted: 1 } }, { constructor: { prototype: { polluted: 1 } } }];
}
const FUZZ_FIELDS = ['targetId', 'pickupId', 'origin', 'dir', 'x', 'y', 'z', 'ry', 'rx', 'direction', 'cosmeticId', 'cosmetics', 'key', 'emoteId', 'presetId', 'icon', 'damage', 'roomCode', 'token', 'name', 'mode', 'map', 'maxPlayers', 'team', 'text', 'slot', 'id'];

function fuzzContext(kind) {
  const other = startedRoom(2); // an unrelated room that must never be affected
  let f, w;
  if (kind === 'lobbyMember' || kind === 'lobbyHost') {
    const host = connect('fh'); hello(host); host.emitMessage({ type: 'create_room', maxPlayers: 4, name: 'FH' });
    const code = host.lastOfType('room_created').code;
    const g = connect('fg'); hello(g); g.emitMessage({ type: 'join_room', roomCode: code, name: 'FG' });
    w = kind === 'lobbyHost' ? host : g;
    f = { room: rooms[code], bystanderTok: null };
  } else if (kind === 'startedAlive' || kind === 'startedDead' || kind === 'closedSocket') {
    const r = startedRoom(3);
    place(r.room, r.tok[0], 0, 0); place(r.room, r.tok[1], 0, -10); place(r.room, r.tok[2], 5, 5);
    w = r.ws[2];
    if (kind === 'startedDead') r.room.players[r.tok[2]].alive = false;
    if (kind === 'closedSocket') r.ws[2].emitClose();
    f = { room: r.room, bystanderTok: r.tok[1] };
  } else if (kind === 'noHello') { w = connect('nh'); f = { room: null, bystanderTok: null };
  } else { w = connect('hn'); hello(w); f = { room: null, bystanderTok: null }; }
  // The harness FakeWs records every server->client message forever; with ~100k fuzz packets that
  // is a harness-side memory hog (not a server leak - measured separately), so mute the sockets.
  const mute = (room) => { if (room) for (const t in room.players) if (room.players[t].ws) room.players[t].ws.send = () => {}; };
  mute(other.room); mute(f.room); w.send = () => {};
  return { w, other, ...f };
}
const fuzzSnapshot = (ctx) => JSON.stringify([
  ctx.other.room.order.map((t) => { const p = ctx.other.room.players[t]; return [p.health, p.kills, p.deaths, p.alive, p.equippedBadge, p.equippedTitle]; }),
  Object.keys(ctx.other.room.pickups).map((k) => ctx.other.room.pickups[k].active), ctx.other.room.chaosState ? 1 : 0,
  ctx.room && ctx.bystanderTok ? [ctx.room.players[ctx.bystanderTok].health, ctx.room.players[ctx.bystanderTok].kills, ctx.room.players[ctx.bystanderTok].deaths, ctx.room.players[ctx.bystanderTok].alive] : null,
]);

test('p22 fuzz: EVERY server message type x 7 sender states x hostile fields/values — no throw, no pollution, no cross-room/bystander change', () => {
  assert(ALL_TYPES.length >= 20, 'type extraction broke: ' + ALL_TYPES.length);
  const vals = fuzzValues();
  const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort().join(',') + '|' + Object.getOwnPropertyNames(Array.prototype).length;
  const errsBefore = S.getHandlerErrorCount();
  const origErr = console.error; console.error = () => {}; // containment logs; the counter is what we assert on
  let packets = 0;
  try {
    for (const kind of ['lobbyMember', 'lobbyHost', 'startedAlive', 'startedDead', 'closedSocket', 'noHello', 'helloNoRoom']) {
      for (const type of ALL_TYPES) {
        if (type === 'hello') continue; // covered separately below (it legitimately rebinds the socket)
        const ctx = fuzzContext(kind); const snap = fuzzSnapshot(ctx);
        for (const f of FUZZ_FIELDS) for (const v of vals) {
          ctx.w.emitMessage({ type, [f]: v }); packets++;
        }
        for (const raw of ['', 'null', '[]', '0', '"s"', '{', '{"type":1}', '{"type":[]}', '{"type":null}', `{"type":"${type}"`, `{"type":"${type}","x":1e999,"y":-1e999,"origin":[1e999,0,0]}`,
          `{"type":"${type}","__proto__":{"polluted":1},"cosmetics":{"__proto__":{"polluted":1}},"constructor":{"prototype":{"polluted":1}}}`, Buffer.from([0xff, 0xfe, 0x00, 0x7b])]) { ctx.w._handlers.message(raw); packets++; }
        assertEqual(fuzzSnapshot(ctx), snap, `fuzzing ${type} as ${kind} changed unrelated state`);
        S.shutdownAllRooms(); // free the rooms + their timers before the next context
      }
    }
  } finally { console.error = origErr; }
  assert(packets > 60000, 'fuzz volume too low: ' + packets);
  assertEqual(S.getHandlerErrorCount(), errsBefore, 'a handler THREW under fuzz (containment caught it, but it is a bug)');
  assert(!({}).polluted && !([]).polluted, 'prototype pollution');
  assertEqual(Object.getOwnPropertyNames(Object.prototype).sort().join(',') + '|' + Object.getOwnPropertyNames(Array.prototype).length, protoBefore, 'prototype surface changed');
});

test('p22 fuzz: `hello` with hostile tokens/names never throws or pollutes', () => {
  const errsBefore = S.getHandlerErrorCount(); const origErr = console.error; console.error = () => {};
  try {
    for (const v of fuzzValues()) { const w = connect('hf'); w.emitMessage({ type: 'hello', token: v, name: v }); w.emitMessage({ type: 'create_room', name: v, cosmetics: v, maxPlayers: v }); }
  } finally { console.error = origErr; }
  assertEqual(S.getHandlerErrorCount(), errsBefore); assert(!({}).polluted);
});

test('p22 containment: an oversized packet is dropped before parsing; a legit packet of the same type still works', () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); ws[1].sent.length = 0;
  const body = (pad) => `{"type":"shoot","origin":[0,1.6,0],"dir":[0,0,-1],"pad":"${'A'.repeat(pad)}"}`;
  ws[0]._handlers.message(body(S.MAX_MESSAGE_BYTES + 10));
  assertEqual(ws[1].allOfType('shoot').length, 0, 'oversized packet was processed');
  ws[0]._handlers.message(Buffer.from(body(S.MAX_MESSAGE_BYTES + 10)));
  assertEqual(ws[1].allOfType('shoot').length, 0, 'oversized Buffer packet was processed');
  ws[0]._handlers.message(body(100));
  assertEqual(ws[1].allOfType('shoot').length, 1, 'a normal packet must still pass');
  assert(S.wss.opts && S.wss.opts.maxPayload > 0 && S.wss.opts.maxPayload < 100 * 1024 * 1024, 'ws maxPayload must be capped well below the 100MB default');
});

test('p22 containment: a handler that throws is contained (counter++), later packets and other rooms keep working', () => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0);
  const other = startedRoom(2); place(other.room, other.tok[0], 0, 0); other.ws[1].sent.length = 0;
  const before = S.getHandlerErrorCount(); const origErr = console.error; console.error = () => {};
  const realSend = ws[1].send; ws[1].send = () => { throw new Error('boom: peer socket exploded'); };
  try { ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] }); } finally { ws[1].send = realSend; console.error = origErr; }
  // the throw happened inside the handler and was CONTAINED by the message wrapper: exactly one counted error
  assertEqual(S.getHandlerErrorCount(), before + 1, 'the containment wrapper did not catch (or double counted) the throw');
  S.resetHandlerErrorCount(); // this error was intentional; the final leak check requires the counter to be 0 for the whole run
  other.ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(other.ws[1].allOfType('shoot').length, 1, 'other room stopped working after an error');
});

test('p22 reconnect: a STALE old socket closing after the new socket re-helloed must not disconnect the live player', () => {
  const { ws, tok, room } = startedRoom(2);
  const fresh = connect('fresh'); hello(fresh, tok[1]); // new socket arrives first (half-open TCP on mobile)
  assertEqual(room.players[tok[1]].connected, true);
  ws[1].emitClose(); // the old socket's close event fires late
  assertEqual(room.players[tok[1]].connected, true, 'live player was marked disconnected by a stale socket');
  assert(!room.players[tok[1]].disconnectTimer, 'removal timer armed for a live player');
  fresh.emitClose(); // the REAL current socket dropping must still start the grace timer
  assertEqual(room.players[tok[1]].connected, false);
  assert(room.players[tok[1]].disconnectTimer, 'grace timer must arm for a real disconnect');
  clearTimeout(room.players[tok[1]].disconnectTimer); room.players[tok[1]].disconnectTimer = null;
});

test('p22 fuzz: disconnected, dead and unknown-token senders cannot act', () => strictHit(() => {
  const { ws, tok, room } = startedRoom(2);
  place(room, tok[0], 0, 0); place(room, tok[1], 0, -10);
  const stranger = connect('stranger'); // never sent hello
  hitP(stranger, { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
  stranger.emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
  stranger.emitMessage({ type: 'shoot', origin: [0, 1.6, 0], dir: [0, 0, -1] });
  const drifter = connect('drifter'); hello(drifter); // has a token but no room
  hitP(drifter, { type: 'hit', targetId: tok[1], origin: [0, 1.6, 0], dir: [0, 0, -1] });
  assertEqual(room.players[tok[1]].health, 100);
  ws[0].emitClose(); // disconnected attacker: the socket can't send, but a stale handler call must be harmless
  hitP(ws[0], { type: 'hit', targetId: tok[1], ...aimFrom(room, tok[0], tok[1]) });
}));

test('p22 containment: every connection registers a ws "error" listener (an unhandled ws error event would crash the whole process)', () => {
  const w = connect('err');
  assertEqual(typeof w._handlers.error, 'function', "no ws.on('error') — one bad frame from one client would kill every room");
  const origErr = console.error; console.error = () => {};
  try {
    w._handlers.error(Object.assign(new RangeError('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' }));
    w._handlers.error(null); w._handlers.error(undefined);
  } finally { console.error = origErr; }
});

// ---- tests added after mutation analysis (three surviving mutants) ------------------------------

test('p22 combat: an attacker can never hit THEMSELVES (guard isolated: legacy path and strict path)', () => {
  // legacy path (requireAim=false): the ONLY thing standing between a client and self-damage is the `target === attacker` guard
  withCfg(HIT_CONFIG, { requireAim: false, minIntervalMs: 0, rng: () => 0.99 }, () => {
    const { ws, tok, room } = startedRoom(2);
    place(room, tok[0], 0, 0);
    ws[0].emitMessage({ type: 'hit', targetId: tok[0] });
    assertEqual(room.players[tok[0]].health, 100, 'self-hit (legacy path) applied damage'); assert(!ws[0].lastOfType('hit_confirm'));
  });
  // strict path
  strictHit(() => {
    const { ws, tok, room } = startedRoom(2);
    place(room, tok[0], 0, 0);
    hitP(ws[0], { type: 'hit', targetId: tok[0], origin: [0, 1.6, 0], dir: [0, 0, -1] });
    hitP(ws[0], { type: 'hit', targetId: tok[0], origin: [0, 1.6, 0], dir: [0, 1, 0] });
    assertEqual(room.players[tok[0]].health, 100, 'self-hit (strict path) applied damage'); assertEqual(room.players[tok[0]].deaths, 0);
  });
});

test('p22 protocol: a hit is rejected if the shooter is no longer near the aim origin at hit time (shoot was legit, position then moved)', () => prodHit(() => {
  const { clk, ws, tok, room, aim } = clockedFight();
  withClock(clk, () => {
    ws[0].emitMessage({ type: 'shoot', ...aim });   // fine: origin matches the server-known position now
    place(room, tok[0], 0, 30);                      // server-side correction / rubber-band moves the shooter far away
    place(room, tok[1], 0, -10);                     // target unchanged: the claimed ray still "points at" it
    clk.tick(100);
    ws[0].emitMessage({ type: 'hit', targetId: tok[1], ...aim });
  });
  assertEqual(room.players[tok[1]].health, 100, 'hit accepted although its aim origin is ~30u from the server-known shooter');
}));

test('p22 pickup: a respawn timer that fires AFTER its room vanished (timers not cleared) does nothing and broadcasts nothing', async () => {
  await withCfg(PICKUP_CONFIG, { attemptCooldownMs: 0, respawnMs: 40 }, async () => {
    const { ws, tok, room, code } = startedRoom(2);
    const pk = troll0(room); place(room, tok[1], pk.x, pk.z);
    ws[1].emitMessage({ type: 'troll_pickup', pickupId: 'pk0' });
    assertEqual(pk.active, false); assert(pk.timer, 'respawn timer pending');
    ws.forEach((w) => { w.sent.length = 0; });
    delete rooms[code];               // simulate the race: room is gone but its timer was NOT cleared
    await sleep(120);                 // REAL time: the callback does run
    assertEqual(pk.active, false, 'a stale timer reactivated a pickup of a deleted room');
    ws.forEach((w) => assertEqual(w.allOfType('pickup_state').length, 0, 'a stale timer broadcast into a deleted room'));
    if (pk.timer) clearTimeout(pk.timer);
  });
});
