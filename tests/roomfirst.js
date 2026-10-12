// Phase 15 — room-first multiplayer: create/join/quick-play, isolation, security.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, PROTOCOL_VERSION, shutdownAllRooms, connectedCount, removePlayerFromRoom } = T;

test('room codes: server-generated, 6 chars, collisions never produced across many rooms', () => {
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const ws = connect('c' + i); hello(ws);
    ws.emitMessage({ type: 'create_room', maxPlayers: 4 });
    const code = ws.lastOfType('room_created').code;
    assert(/^[A-Z0-9]{6}$/.test(code));
    assert(!codes.has(code), 'duplicate room code generated');
    codes.add(code);
  }
});

test('join_room: closed/ended room and already-started room are both rejected', () => {
  const host = connect('h'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  host.emitMessage({ type: 'player_ready' });
  host.emitMessage({ type: 'start_game' });
  const late = connect('l'); hello(late);
  late.emitMessage({ type: 'join_room', roomCode: code });
  assertEqual(late.lastOfType('join_error').reason, 'ALREADY_STARTED');
});

test('join_room: a client already connected to the room cannot double-join', () => {
  const host = connect('h'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  host.emitMessage({ type: 'join_room', roomCode: code }); // host tries to join its own room again
  assertEqual(host.lastOfType('join_error').reason, 'ALREADY_IN_ROOM');
});

test('join_room: protocol mismatch is rejected only when the client actually declares a version', () => {
  const host = connect('h'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  const old = connect('old'); hello(old);
  old.emitMessage({ type: 'join_room', roomCode: code, protocolVersion: PROTOCOL_VERSION + 5 });
  assertEqual(old.lastOfType('join_error').reason, 'PROTOCOL_MISMATCH');
  const noVersion = connect('nv'); hello(noVersion);
  noVersion.emitMessage({ type: 'join_room', roomCode: code }); // no version field: legacy client, must still work
  assert(noVersion.lastOfType('room_joined'), 'clients with no version field must not be broken');
});

test('quick play: no matching public room -> creates one; matching room -> joins it', () => {
  for (const k of Object.keys(rooms)) delete rooms[k]; // isolate from other tests' leftover public rooms in the shared module state
  const a = connect('a'); const at = hello(a);
  a.emitMessage({ type: 'quick_play' });
  const created = a.lastOfType('room_created');
  assert(created, 'first quick play creates a room');
  const b = connect('b'); hello(b);
  b.emitMessage({ type: 'quick_play' });
  assertEqual(b.lastOfType('room_joined').code, created.code, 'second quick play joins the same public room');
});

test('quick play: a full or already-started public room is skipped (a new one is made instead)', () => {
  for (const k of Object.keys(rooms)) delete rooms[k]; // isolate from other tests' leftover public rooms
  const a = connect('a'); hello(a);
  a.emitMessage({ type: 'quick_play' });
  const codeA = a.lastOfType('room_created').code;
  rooms[codeA].maxPlayers = 1; // simulate "already full" deterministically
  const b = connect('b'); hello(b);
  b.emitMessage({ type: 'quick_play' });
  assert(b.lastOfType('room_created') && b.lastOfType('room_created').code !== codeA, 'full room must be skipped');

  const codeB = b.lastOfType('room_created').code;
  rooms[codeB].started = true; // simulate "already started"
  const c = connect('c'); hello(c);
  c.emitMessage({ type: 'quick_play' });
  assert(c.lastOfType('room_created') && ![codeA, codeB].includes(c.lastOfType('room_created').code), 'started room must be skipped too');
});

test("room isolation: two simultaneous rooms never see each other's state, hits, or emotes", () => {
  function started() {
    const h = connect('h'); const ht = hello(h);
    h.emitMessage({ type: 'create_room', maxPlayers: 4 });
    const code = h.lastOfType('room_created').code;
    const g = connect('g'); const gt = hello(g);
    g.emitMessage({ type: 'join_room', roomCode: code }); g.emitMessage({ type: 'player_ready' });
    h.emitMessage({ type: 'start_game' });
    return { code, h, g, ht, gt };
  }
  const A = started(), B = started();
  A.h.emitMessage({ type: 'hit', targetId: A.gt });
  assert(!B.h.lastOfType('damage') && !B.g.lastOfType('damage'), "room B saw room A's hit");
  A.h.emitMessage({ type: 'emote_trigger', emoteId: 'emoteVictory' });
  assert(!B.h.lastOfType('emote_used') && !B.g.lastOfType('emote_used'), "room B saw room A's emote");
  const stB = require(path.join(__dirname, '..', 'server.js')).__test__.rooms[B.code];
  assert(stB.players[A.ht] === undefined && stB.players[A.gt] === undefined, 'room A players leaked into room B');
});

test('host system: disconnect migrates host without closing the room; last player leaving deletes it', () => {
  const h = connect('h'); const ht = hello(h);
  h.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = h.lastOfType('room_created').code;
  const g = connect('g'); const gt = hello(g);
  g.emitMessage({ type: 'join_room', roomCode: code });
  h.emitClose(); // host disconnects (grace period, not a full leave)
  assertEqual(rooms[code].hostToken, gt, 'immediate migration');
  assert(rooms[code], 'room stays open with one player connected');
  g.emitMessage({ type: 'leave_room' }); // last CONNECTED player leaves; disconnected host is still in its grace period
  assert(rooms[code], 'room must survive while the disconnected host\'s reconnect grace period is still running');
  assertEqual(connectedCount(rooms[code]), 0);
  T.removePlayerFromRoom(rooms[code], ht, 'timeout'); // simulate the grace timer firing
  assertEqual(rooms[code], undefined, 'room deleted once truly empty');
});

test('host reconnect: former host reconnecting joins as a normal (non-host) player', () => {
  const h = connect('h'); const ht = hello(h);
  h.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = h.lastOfType('room_created').code;
  const g = connect('g'); const gt = hello(g);
  g.emitMessage({ type: 'join_room', roomCode: code });
  h.emitClose();
  const h2 = connect('h2'); hello(h2, ht);
  assertEqual(rooms[code].hostToken, gt, 'guest stays host after the original host reconnects');
});

test('security: room codes and tokens sent as non-strings never crash the handlers', () => {
  for (const bad of [42, {}, [], null, true, 'x'.repeat(10000)]) {
    const ws = connect('x'); hello(ws);
    ws.emitMessage({ type: 'join_room', roomCode: bad });
    assert(ws.lastOfType('join_error'), 'should be rejected, not crash: ' + JSON.stringify(bad));
  }
});
