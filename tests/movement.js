// Phase 10 — server-side movement validation. Uses an injected clock so no test sleeps.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, MOVE_CONFIG, isSuspicious, HIT_CONFIG, JOJO_SECRET_POS, getUnlocks } = T;

let clock = 1_000_000;
const realNow = MOVE_CONFIG.now;
function useClock(fn) { MOVE_CONFIG.now = () => clock; try { return fn(); } finally { MOVE_CONFIG.now = realNow; } }
function tick(ms) { clock += ms; }

function game(n = 2) {
  const host = connect('h'); const ht = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 6 });
  const code = host.lastOfType('room_created').code;
  const ws = [host], toks = [ht];
  for (let i = 1; i < n; i++) { const g = connect('g' + i); toks.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code }); g.emitMessage({ type: 'player_ready' }); ws.push(g); }
  host.emitMessage({ type: 'start_game' });
  const room = rooms[code];
  if (room.chaosTimer) clearTimeout(room.chaosTimer);
  return { code, room, ws, toks };
}
// put a player at a known spot with an established baseline (bypasses spawn sync)
function settle(room, tok, x, z) { const p = room.players[tok]; p.x = x; p.y = 1.6; p.z = z; p.sync = null; p.moveBudget = MOVE_CONFIG.burst; p.lastMoveAt = clock; p.moveStrikes = []; p.dashBudgetUntil = 0; p.lastCorrectionAt = 0; }
function move(ws, x, z, extra) { ws.emitMessage({ type: 'update', x, y: 1.6, z, ry: 0.5, ...(extra || {}) }); }
function raw(ws, json) { ws._handlers.message(json); }

test('movement: game start sends every player their real spawn (client used to start at 0,0)', () => {
  const { ws, toks, room } = game(3);
  for (let i = 0; i < 3; i++) {
    const r = ws[i].allOfType('respawn').pop();
    assert(r && r.id === toks[i], 'spawn message for player ' + i);
    assertEqual(r.x, room.players[toks[i]].x); assertEqual(r.z, room.players[toks[i]].z);
  }
});

test('movement: normal walking (6 u/s at 60Hz for 3s) is accepted with zero corrections', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  let x = 0;
  for (let i = 0; i < 180; i++) { tick(16); x += 6 * 0.016; move(ws[0], x, 0); }
  assert(Math.abs(room.players[toks[0]].x - x) < 1e-9, 'server tracked the client');
  assert(!ws[0].lastOfType('position_correct'), 'no false-positive corrections');
  assertEqual(room.players[toks[0]].moveStrikes.length, 0);
}));

test('movement: malformed payloads rejected, position untouched (strings, null, missing, objects, 1e999, huge ry)', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 5, 5);
  const bads = [
    { x: '34', y: 1.6, z: '-34', ry: 0 }, { x: 'abc', y: 1.6, z: 0, ry: 0 }, { x: null, y: 1.6, z: 0, ry: 0 },
    { y: 1.6, z: 0, ry: 0 }, { x: {}, y: 1.6, z: 0, ry: 0 }, { x: [1], y: 1.6, z: 0, ry: 0 }, { x: true, y: 1.6, z: 0, ry: 0 },
    { x: 1, y: 1.6, z: 0, ry: 1e9 }, { x: 1, y: 1.6, z: 0, ry: 'up' },
  ];
  for (const b of bads) { tick(300); ws[0].emitMessage({ type: 'update', ...b }); }
  tick(300); raw(ws[0], '{"type":"update","x":1e999,"y":1.6,"z":0,"ry":0}');
  assertEqual(room.players[toks[0]].x, 5); assertEqual(room.players[toks[0]].z, 5);
  assert(room.players[toks[0]].moveStrikes.length >= 5, 'counted as violations');
}));

test('SECURITY regression: string/NaN position can no longer unlock the JoJo secret from across the map', () => useClock(() => {
  // Before: p.x = "abc"  ->  NaN > radius is false  ->  distance check passed from anywhere.
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  ws[0].emitMessage({ type: 'update', x: 'abc', y: 1.6, z: 'abc', ry: 0 });
  ws[0].emitMessage({ type: 'interact_secret' });
  assert(!ws[0].lastOfType('achievement_unlocked'), 'must not unlock');
  assert(isFinite(room.players[toks[0]].x), 'stored position is still a finite number');
}));

test('movement: teleport rejected; server keeps old position and sends position_correct', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  tick(16); move(ws[0], 30, 30);
  assertEqual(room.players[toks[0]].x, 0); assertEqual(room.players[toks[0]].z, 0);
  const c = ws[0].lastOfType('position_correct');
  assert(c && c.reason === 'SPEED' && c.x === 0 && c.z === 0, 'correction carries server position');
}));

test('movement: sustained 2x speed hack is caught once the burst is spent, and the cheater gets stuck', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  // cheater ignores corrections and keeps claiming positions at 12 u/s (2x walk speed)
  let claim = 0, rejected = 0;
  for (let i = 0; i < 120; i++) {
    tick(16); claim += 12 * 0.016;
    const before = room.players[toks[0]].x; move(ws[0], claim, 0);
    if (room.players[toks[0]].x === before) rejected++;
  }
  const serverX = room.players[toks[0]].x;
  assert(rejected >= 30, 'speed hack rejected repeatedly, got ' + rejected);
  assert(claim - serverX > 5, `server position must fall far behind the claim (claim ${claim.toFixed(1)}, server ${serverX.toFixed(1)})`);
  assert(serverX <= MOVE_CONFIG.burst + 6 * MOVE_CONFIG.tolerance * 1.92 + 0.5, 'net progress bounded by budget: ' + serverX);
  assert(ws[0].lastOfType('position_correct'), 'client was told to snap back');
}));

test('movement: lag burst is tolerated (0.5s gap then 3 units is legal walking)', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  tick(500); move(ws[0], 3, 0);
  assertEqual(room.players[toks[0]].x, 3); assert(!ws[0].lastOfType('position_correct'));
}));

test('movement: dash gets a server-approved extra budget; the same jump without a dash is rejected', () => useClock(() => {
  const a = game(2); settle(a.room, a.toks[0], 0, 0);
  tick(16); move(a.ws[0], 5, 0);            // 5u in 16ms with no dash (burst is 4)
  assertEqual(a.room.players[a.toks[0]].x, 0, 'no dash -> rejected');
  const b = game(2); settle(b.room, b.toks[0], 0, 0);
  b.room.players[b.toks[0]].dashCooldownUntil = 0; b.room.players[b.toks[0]].stamina = 100;
  b.ws[0].emitMessage({ type: 'dash_request', dir: [1, 0] });
  assert(b.ws[0].lastOfType('dash_ok'));
  tick(16); move(b.ws[0], 5, 0);
  assertEqual(b.room.players[b.toks[0]].x, 5, 'dash -> accepted');
}));

test('movement: arena bounds and vertical (fly) limits enforced', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 37, 0);
  tick(300); move(ws[0], 45, 0); assertEqual(room.players[toks[0]].x, 37, 'outside arena rejected');
  tick(300); ws[0].emitMessage({ type: 'update', x: 37, y: 10, z: 0, ry: 0 }); assertEqual(room.players[toks[0]].y, 1.6, 'flying rejected');
  tick(300); ws[0].emitMessage({ type: 'update', x: 37, y: -5, z: 0, ry: 0 }); assertEqual(room.players[toks[0]].y, 1.6, 'underground rejected');
}));

test('movement: update flood is dropped without strikes; corrections are rate-limited', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  tick(16); move(ws[0], 0.05, 0);
  for (let i = 0; i < 50; i++) move(ws[0], 0.06, 0); // same millisecond flood
  assertEqual(room.players[toks[0]].moveStrikes.length, 0, 'flood dropped, not a violation');
  for (let i = 0; i < 20; i++) { tick(10); move(ws[0], 30, 30); }
  assert(ws[0].allOfType('position_correct').length <= 2, 'corrections rate-limited, got ' + ws[0].allOfType('position_correct').length);
}));

test('movement: after a server respawn, stale far updates are ignored (no strikes); near update re-syncs', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  T.beginServerSync(room.players[toks[0]], 20, 1.6, 20);
  tick(50); move(ws[0], 0, 0); // client still at old spot
  assertEqual(room.players[toks[0]].x, 20); assertEqual(room.players[toks[0]].moveStrikes.length, 0);
  tick(50); move(ws[0], 20.2, 20.1); // client snapped
  assertEqual(room.players[toks[0]].x, 20.2); assertEqual(room.players[toks[0]].sync, null);
}));

test('movement: a client that never snaps is bound by normal rules after the sync timeout', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  T.beginServerSync(room.players[toks[0]], 20, 1.6, 20);
  tick(MOVE_CONFIG.syncTimeoutMs + 100); move(ws[0], 0, 0);
  assertEqual(room.players[toks[0]].x, 20, 'far claim rejected after grace');
  assert(ws[0].lastOfType('position_correct'));
}));

test('movement: dead players cannot move; lobby updates ignored', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[1], 3, 3);
  room.players[toks[1]].alive = false; tick(300); move(ws[1], 3.5, 3);
  assertEqual(room.players[toks[1]].x, 3);
  const l = connect('l'); const lt = hello(l); l.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const before = Object.values(rooms).find((r) => r.players[lt]).players[lt].x;
  l.emitMessage({ type: 'update', x: 9, y: 1.6, z: 9, ry: 0 });
  assertEqual(Object.values(rooms).find((r) => r.players[lt]).players[lt].x, before);
}));

test('movement: repeated violations flag the player suspicious -> hits and secret refused; recovers after the window', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0); settle(room, toks[1], 1, 0);
  const saved = HIT_CONFIG.minIntervalMs; HIT_CONFIG.minIntervalMs = 0;
  try {
    for (let i = 0; i < MOVE_CONFIG.strikeLimit; i++) { tick(20); move(ws[0], 30, 30); }
    assert(isSuspicious(room.players[toks[0]]), 'flagged');
    ws[0].emitMessage({ type: 'hit', targetId: toks[1] });
    assert(!ws[0].lastOfType('hit_confirm'), 'cheater deals no damage');
    room.players[toks[0]].x = JOJO_SECRET_POS.x; room.players[toks[0]].z = JOJO_SECRET_POS.z;
    ws[0].emitMessage({ type: 'interact_secret' });
    assert(!ws[0].lastOfType('achievement_unlocked'), 'no secret while flagged');
    tick(MOVE_CONFIG.strikeWindowMs + 100);
    assert(!isSuspicious(room.players[toks[0]]), 'recovers after a clean window');
    ws[0].emitMessage({ type: 'hit', targetId: toks[1] });
  } finally { HIT_CONFIG.minIntervalMs = saved; }
}));

test('movement: rejoining player is realigned to the server position (client resets camera on rejoin)', () => {
  const { ws, room, toks } = game(2);
  room.players[toks[1]].x = 7; room.players[toks[1]].z = -4;
  ws[1].emitClose();
  const re = connect('re'); hello(re, toks[1]);
  const c = re.lastOfType('position_correct');
  assert(c && c.reason === 'REJOIN' && c.x === 7 && c.z === -4, 'rejoin correction carries stored position');
});

test('movement: heading is stored wrapped to [-pi, pi]', () => useClock(() => {
  const { ws, room, toks } = game(2); settle(room, toks[0], 0, 0);
  tick(300); ws[0].emitMessage({ type: 'update', x: 0, y: 1.6, z: 0, ry: 7 * Math.PI });
  const ry = room.players[toks[0]].ry; assert(ry >= -Math.PI - 1e-9 && ry <= Math.PI + 1e-9, 'ry ' + ry);
}));
