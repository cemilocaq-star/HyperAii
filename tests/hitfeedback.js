// Phase 4/5 server side — hit_confirm (hit marker + damage number source).
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const { rooms, HIT_CONFIG } = require(path.join(__dirname, '..', 'server.js')).__test__;

function duel() {
  const a = connect('a'); const at = hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = a.lastOfType('room_created').code;
  const b = connect('b'); const bt = hello(b);
  b.emitMessage({ type: 'join_room', roomCode: code });
  b.emitMessage({ type: 'player_ready' });
  a.emitMessage({ type: 'start_game' });
  return { a, b, at, bt, room: rooms[code] };
}
function withCfg(over, fn) {
  const saved = { ...HIT_CONFIG };
  Object.assign(HIT_CONFIG, over);
  try { return fn(); } finally { Object.assign(HIT_CONFIG, saved); }
}

test('hit marker: attacker gets hit_confirm only after a validated hit', () => {
  const { a, b, bt } = duel();
  assert(!a.lastOfType('hit_confirm'), 'no confirm before any hit');
  a.emitMessage({ type: 'hit', targetId: bt });
  const c = a.lastOfType('hit_confirm');
  assert(c, 'expected hit_confirm');
  assertEqual(c.damage, 25); assertEqual(c.crit, false); assertEqual(c.killed, false);
  assert(!b.lastOfType('hit_confirm'), 'victim must not receive attacker hit_confirm');
});

test('hit marker: client cannot fabricate hit_confirm by sending it', () => {
  const { a, bt } = duel();
  a.emitMessage({ type: 'hit_confirm', targetId: bt, damage: 999, crit: true });
  assert(!a.lastOfType('hit_confirm'), 'server must not echo client-made confirms');
});

test('hit marker: client-sent damage is ignored (server is damage source)', () => {
  const { a, bt, room } = duel();
  a.emitMessage({ type: 'hit', targetId: bt, damage: 9999 });
  assertEqual(room.players[bt].health, 75);
  assertEqual(a.lastOfType('hit_confirm').damage, 25);
});

test('critical hit: deterministic crit via injected rng -> 50 dmg, crit=true', () => {
  withCfg({ rng: () => 0.0 }, () => {
    const { a, bt, room } = duel();
    a.emitMessage({ type: 'hit', targetId: bt });
    const c = a.lastOfType('hit_confirm');
    assertEqual(c.crit, true); assertEqual(c.damage, 50);
    assertEqual(room.players[bt].health, 50);
  });
});

test('hit_confirm carries target position and killed flag on lethal hit', () => {
  const { a, bt, room } = duel();
  for (let i = 0; i < 4; i++) a.emitMessage({ type: 'hit', targetId: bt });
  const confirms = a.allOfType('hit_confirm');
  assertEqual(confirms.length, 4);
  const last = confirms[3];
  assertEqual(last.killed, true);
  assert(typeof last.x === 'number' && typeof last.z === 'number', 'position included for damage number');
  assertEqual(room.players[bt].alive, false);
});

test('rejected: fire-rate cap, dead attacker, dead target, out of range -> no confirm', () => {
  withCfg({ minIntervalMs: 1000 }, () => {
    const { a, bt } = duel();
    a.emitMessage({ type: 'hit', targetId: bt });
    a.emitMessage({ type: 'hit', targetId: bt });
    assertEqual(a.allOfType('hit_confirm').length, 1, 'second hit inside interval rejected');
  });
  {
    const { a, b, at, bt, room } = duel();
    room.players[at].alive = false;
    a.emitMessage({ type: 'hit', targetId: bt });
    assert(!a.lastOfType('hit_confirm'), 'dead attacker rejected');
    room.players[at].alive = true; room.players[bt].alive = false;
    a.emitMessage({ type: 'hit', targetId: bt });
    assert(!a.lastOfType('hit_confirm'), 'dead target rejected');
  }
  withCfg({ maxRange: 0.0001 }, () => {
    const { a, bt } = duel();
    a.emitMessage({ type: 'hit', targetId: bt });
    assert(!a.lastOfType('hit_confirm'), 'out-of-range rejected');
  });
});

test('rejected: hit before game start and hit on unknown target', () => {
  const a = connect('a'); const at = hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  a.emitMessage({ type: 'hit', targetId: at });
  a.emitMessage({ type: 'hit', targetId: 'nope' });
  assert(!a.lastOfType('hit_confirm'));
});
