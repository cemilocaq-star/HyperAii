// Phase 8 — Chaos events: deterministic probability, cooldown, duplicates,
// reconnect sync, cleanup. No waiting hours for random events: rng is injected.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, CHAOS_CONFIG, RandomEventRegistry, rollChaosEvent, validateChaosRegistry, startChaosEvent, endChaosEvent, chaosCheck, shutdownAllRooms } = T;

function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function startedRoom(n = 2) {
  const host = connect('h'); const ht = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 6 });
  const code = host.lastOfType('room_created').code;
  const ws = [host], toks = [ht];
  for (let i = 1; i < n; i++) {
    const g = connect('g' + i); toks.push(hello(g));
    g.emitMessage({ type: 'join_room', roomCode: code }); g.emitMessage({ type: 'player_ready' }); ws.push(g);
  }
  host.emitMessage({ type: 'start_game' });
  const room = rooms[code];
  // the real scheduler timers aren't needed here; tests drive chaos directly
  if (room.chaosTimer) { clearTimeout(room.chaosTimer); room.chaosTimer = null; }
  return { code, room, ws, toks };
}
function withCfg(over, fn) { const s = { ...CHAOS_CONFIG }; Object.assign(CHAOS_CONFIG, over); try { return fn(); } finally { Object.assign(CHAOS_CONFIG, s); } }

test('chaos: registry keeps the 3 events with the required probabilities', () => {
  assertEqual(RandomEventRegistry.pinkPop.probability, 0.10);
  assertEqual(RandomEventRegistry.duckWeapon.probability, 0.05);
  assertEqual(RandomEventRegistry.greenOgre.probability, 0.07);
  assertEqual(validateChaosRegistry(RandomEventRegistry).length, 0, 'registry must validate');
});

test('chaos: validateChaosRegistry catches bad registries', () => {
  const bad = { a: { id: 'b', probability: 2, duration: -1, start() {}, end() {} }, c: { id: 'c', probability: 0.5, duration: 10 } };
  const errs = validateChaosRegistry(bad);
  assert(errs.length >= 4, 'expected several errors, got ' + JSON.stringify(errs));
});

test('chaos 10%: pinkPop band is exactly [0, 0.10)', () => {
  assertEqual(rollChaosEvent(() => 0.0).id, 'pinkPop');
  assertEqual(rollChaosEvent(() => 0.0999999).id, 'pinkPop');
  assert(rollChaosEvent(() => 0.10).id !== 'pinkPop', '0.10 is outside the pinkPop band');
});
test('chaos 5%: duckWeapon band is exactly [0.10, 0.15)', () => {
  assertEqual(rollChaosEvent(() => 0.10).id, 'duckWeapon');
  assertEqual(rollChaosEvent(() => 0.1499999).id, 'duckWeapon');
  assert(rollChaosEvent(() => 0.15).id !== 'duckWeapon');
});
test('chaos 7%: greenOgre band is exactly [0.15, 0.22)', () => {
  assertEqual(rollChaosEvent(() => 0.15).id, 'greenOgre');
  assertEqual(rollChaosEvent(() => 0.2199999).id, 'greenOgre');
  assertEqual(rollChaosEvent(() => 0.22).id, 'banana_weapon', 'the extension event starts exactly where greenOgre ends');
  assertEqual(rollChaosEvent(() => 0.2599999).id, 'banana_weapon');
  assertEqual(rollChaosEvent(() => 0.26), null, 'past the last band = no event');
  assertEqual(rollChaosEvent(() => 0.999), null);
});

test('chaos: seeded 200k-roll distribution matches 10% / 5% / 7% (old sequential logic gave ~4.5% / ~6.0%)', () => {
  const rng = mulberry32(12345); const N = 200000; const c = { pinkPop: 0, duckWeapon: 0, greenOgre: 0, banana_weapon: 0, none: 0 };
  for (let i = 0; i < N; i++) { const ev = rollChaosEvent(rng); c[ev ? ev.id : 'none']++; }
  const near = (got, want, name) => assert(Math.abs(got / N - want) < 0.004, `${name}: ${(got / N * 100).toFixed(2)}% vs ${want * 100}%`);
  near(c.pinkPop, 0.10, 'pinkPop'); near(c.duckWeapon, 0.05, 'duckWeapon'); near(c.greenOgre, 0.07, 'greenOgre'); near(c.banana_weapon, 0.04, 'banana_weapon'); near(c.none, 0.74, 'none');
});

test('chaos: chaosCheck triggers the event chosen by the injected rng (10% / 5% / 7%)', () => {
  for (const [r, id] of [[0.05, 'pinkPop'], [0.12, 'duckWeapon'], [0.20, 'greenOgre']]) {
    withCfg({ rng: () => r }, () => {
      const { room } = startedRoom(2);
      chaosCheck(room);
      assert(room.chaosState, 'event should have started for rng=' + r);
      assertEqual(room.chaosState.id, id);
      endChaosEvent(room);
    });
  }
  withCfg({ rng: () => 0.9 }, () => { const { room } = startedRoom(2); chaosCheck(room); assertEqual(room.chaosState, null, 'no event on a high roll'); });
});

test('chaos: duplicate prevention — second event cannot start while one is active', () => {
  const { room, ws } = startedRoom(2);
  assert(startChaosEvent(room, RandomEventRegistry.pinkPop));
  const before = JSON.stringify(room.chaosState);
  assertEqual(startChaosEvent(room, RandomEventRegistry.greenOgre), false);
  assertEqual(startChaosEvent(room, RandomEventRegistry.pinkPop), false);
  assertEqual(JSON.stringify(room.chaosState), before, 'active state untouched');
  assertEqual(ws[0].allOfType('chaos_event').length, 1, 'exactly one start broadcast');
  endChaosEvent(room);
});

test('chaos: cooldown blocks a new event right after one ends, then allows it', () => {
  withCfg({ cooldownMs: 60000 }, () => {
    const { room } = startedRoom(2);
    startChaosEvent(room, RandomEventRegistry.pinkPop);
    assert(endChaosEvent(room));
    assertEqual(startChaosEvent(room, RandomEventRegistry.pinkPop), false, 'blocked during cooldown');
    withCfg({ rng: () => 0.0 }, () => { chaosCheck(room); assertEqual(room.chaosState, null, 'chaosCheck also respects cooldown'); });
    room.chaosCooldownUntil = 0; // cooldown elapsed
    assert(startChaosEvent(room, RandomEventRegistry.pinkPop), 'allowed after cooldown');
    endChaosEvent(room);
  });
});

test('chaos: endChaosEvent is idempotent and checks the expected id', () => {
  const { room, ws } = startedRoom(2);
  startChaosEvent(room, RandomEventRegistry.pinkPop);
  assertEqual(endChaosEvent(room, 'greenOgre'), false, 'wrong id must not end the active event');
  assert(room.chaosState);
  assertEqual(endChaosEvent(room, 'pinkPop'), true);
  assertEqual(endChaosEvent(room, 'pinkPop'), false, 'second end is a no-op');
  assertEqual(ws[0].allOfType('chaos_event_end').length, 1);
  assertEqual(room.chaosEndTimer, null, 'end timer cleared');
});

test('chaos: duration — event ends by itself via the real end timer and broadcasts chaos_event_end', async () => {
  const ev = RandomEventRegistry.pinkPop; const saved = ev.duration; ev.duration = 150;
  try {
    const { room, ws } = startedRoom(2);
    startChaosEvent(room, ev);
    assert(room.chaosState && room.chaosEndTimer, 'active with end timer');
    await new Promise((r) => setTimeout(r, 300));
    assertEqual(room.chaosState, null, 'auto-ended');
    assert(ws[1].lastOfType('chaos_event_end'), 'clients told to clean up');
    assert(room.chaosCooldownUntil > Date.now(), 'cooldown started');
  } finally { ev.duration = saved; }
});

test('chaos: single-target events pick their target from the injected rng', () => {
  withCfg({ rng: () => 0.0 }, () => {
    const { room, toks } = startedRoom(3);
    startChaosEvent(room, RandomEventRegistry.greenOgre);
    assertEqual(room.chaosState.targetId, toks[0]);
    endChaosEvent(room);
  });
  withCfg({ rng: () => 0.99 }, () => {
    const { room, toks } = startedRoom(3);
    startChaosEvent(room, RandomEventRegistry.greenOgre);
    assertEqual(room.chaosState.targetId, toks[2]);
    endChaosEvent(room);
  });
});

test('chaos: duck weapon flag is set on the target and cleared on end (server-enforced damage block)', () => {
  withCfg({ rng: () => 0.0 }, () => {
    const { room, toks } = startedRoom(2);
    startChaosEvent(room, RandomEventRegistry.duckWeapon);
    assert(room.players[toks[0]].duckWeaponUntil > Date.now());
    endChaosEvent(room);
    assertEqual(room.players[toks[0]].duckWeaponUntil, 0);
  });
});

test('chaos reconnect: rejoining client receives the active event with remaining time', () => {
  const { room, code, ws, toks } = startedRoom(2);
  startChaosEvent(room, RandomEventRegistry.pinkPop);
  ws[1].emitClose();
  const re = connect('re'); hello(re, toks[1]);
  const rs = re.lastOfType('room_rejoined');
  assert(rs && rs.chaos, 'room_rejoined must carry chaos state');
  assertEqual(rs.chaos.id, 'pinkPop');
  assert(rs.chaos.remainingMs > 0 && rs.chaos.remainingMs <= RandomEventRegistry.pinkPop.duration, 'remainingMs sane: ' + rs.chaos.remainingMs);
  assert(!('until' in rs.chaos), 'no absolute server timestamp leaks (client clocks differ)');
  endChaosEvent(room);
  const rs2 = (() => { const r2 = connect('re2'); hello(r2, toks[1]); return r2.lastOfType('room_rejoined'); })();
  assertEqual(rs2.chaos, null, 'no stale event after it ended');
});

test('chaos cleanup: a permanently removed target ends a single-target event', () => {
  withCfg({ rng: () => 0.99 }, () => {
    const { room, ws, toks } = startedRoom(3);
    startChaosEvent(room, RandomEventRegistry.greenOgre);
    assertEqual(room.chaosState.targetId, toks[2]);
    ws[2].emitMessage({ type: 'leave_room' });
    assertEqual(room.chaosState, null, 'event ended when its target left');
    assert(ws[0].lastOfType('chaos_event_end'));
  });
});

test('chaos: rooms are isolated — an event in room A never reaches room B', () => {
  const A = startedRoom(2), B = startedRoom(2);
  startChaosEvent(A.room, RandomEventRegistry.pinkPop);
  assert(A.ws[1].lastOfType('chaos_event'));
  assert(!B.ws[0].lastOfType('chaos_event') && !B.ws[1].lastOfType('chaos_event'), 'leaked to room B');
  assertEqual(B.room.chaosState, null);
  endChaosEvent(A.room);
});

test('chaos cleanup: re-scheduling never stacks timers (old timer is cleared)', () => {
  const host = connect('h'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  host.emitMessage({ type: 'start_game' }); // schedules the first chaos timer
  const room = rooms[code];
  const first = room.chaosTimer;
  assert(first && first._destroyed === false, 'first timer is live');
  T.scheduleChaosForRoom(room); // e.g. round restarted
  assert(first._destroyed === true, 'old timer must be cleared, not left running');
  assert(room.chaosTimer !== first && room.chaosTimer._destroyed === false, 'exactly one live timer');
  shutdownAllRooms();
});

test('server restart cleanup: shutdownAllRooms clears rooms, chaos state and timers', () => {
  const { room } = startedRoom(2);
  startChaosEvent(room, RandomEventRegistry.pinkPop);
  const endTimer = room.chaosEndTimer;
  shutdownAllRooms();
  assertEqual(Object.keys(rooms).length, 0, 'no rooms survive');
  assertEqual(room.chaosState, null);
  assert(endTimer._destroyed === true, 'end timer was cleared');
});
