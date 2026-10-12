// Phase 2 — Real Ping System tests.
// Run standalone: node tests/ping.js
// Also picked up automatically by tests/run.js.

const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;

test('ping: server echoes t/seq and adds a real serverTime', () => {
  const ws = connect('a');
  hello(ws);
  ws.emitMessage({ type: 'ping', t: 12345.6, seq: 1 });
  const pong = ws.lastOfType('pong');
  assert(pong, 'expected a pong');
  assertEqual(pong.t, 12345.6, 'server must echo back the exact client timestamp (client computes RTT itself)');
  assertEqual(pong.seq, 1);
  assert(typeof pong.serverTime === 'number' && pong.serverTime > 0, 'serverTime should be a real timestamp');
});

test('ping: works in the lobby, before any room exists', () => {
  const ws = connect('a');
  hello(ws);
  // no create_room/join_room at all
  ws.emitMessage({ type: 'ping', t: 1, seq: 1 });
  assert(ws.lastOfType('pong'), 'ping must not require a room');
});

test('ping: works mid-game inside a started room', () => {
  const host = connect('host'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  host.emitMessage({ type: 'player_ready' });
  const startServer = require(path.join(__dirname, '..', 'server.js'));
  const code = host.lastOfType('room_created').code;
  startServer.__test__.rooms[code].players[Object.keys(startServer.__test__.rooms[code].players)[0]].ready = true;
  host.emitMessage({ type: 'start_game' });
  host.emitMessage({ type: 'ping', t: 999, seq: 7 });
  const pong = host.lastOfType('pong');
  assertEqual(pong.t, 999);
  assertEqual(pong.seq, 7);
});

test('ping: sequential pings each get their own pong (not dropped/batched)', () => {
  const ws = connect('a');
  hello(ws);
  ws.emitMessage({ type: 'ping', t: 1, seq: 1 });
  ws.emitMessage({ type: 'ping', t: 2, seq: 2 });
  ws.emitMessage({ type: 'ping', t: 3, seq: 3 });
  const pongs = ws.allOfType('pong');
  assertEqual(pongs.length, 3);
  assertEqual(pongs.map((p) => p.seq).join(','), '1,2,3');
});

test('ping: rejected before hello (no token yet)', () => {
  const ws = connect('a');
  // no hello() call — ws never got a token
  ws.emitMessage({ type: 'ping', t: 1, seq: 1 });
  assert(!ws.lastOfType('pong'), 'must not respond to ping before hello establishes a token');
});
