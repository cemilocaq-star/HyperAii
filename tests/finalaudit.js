// Phase 14 — final audit sweep: static checks + a fuzz pass over every
// known message type with garbage payloads (must never throw / crash).
const path = require('path');
const fs = require('fs');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, shutdownAllRooms } = T;

const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('audit: exactly one HTTP server, one WebSocket server, one game-loop interval', () => {
  assertEqual((serverSrc.match(/http\.createServer\(/g) || []).length, 1);
  assertEqual((serverSrc.match(/new WebSocket\.Server\(/g) || []).length, 1);
  assertEqual((serverSrc.match(/^setInterval\(/gm) || []).length, 1, 'exactly one top-level game tick');
});

test('audit: no listen() call outside the guarded startServer/require.main block (no duplicate startup)', () => {
  assertEqual((serverSrc.match(/\.listen\(/g) || []).length, 1);
});

test('audit: shutdownAllRooms clears every timer kind a room can own', () => {
  const host = connect('h'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  host.emitMessage({ type: 'start_game' });
  const room = rooms[code];
  const timers = [room.thorTimer, room.chaosTimer].filter(Boolean);
  shutdownAllRooms();
  for (const t of timers) assert(t._destroyed === true);
  assertEqual(Object.keys(rooms).length, 0);
});

test('audit: fuzzing every known message type with garbage payloads never throws (server keeps running)', () => {
  const host = connect('h'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const guest = connect('g'); hello(guest);
  const code = host.lastOfType('room_created').code;
  guest.emitMessage({ type: 'join_room', roomCode: code });
  host.emitMessage({ type: 'start_game' });

  const types = ['hello', 'create_room', 'join_room', 'leave_room', 'player_ready', 'start_game',
    'update', 'hit', 'dash_request', 'equip_cosmetic', 'emote_trigger', 'interact_secret',
    'spectate_request', 'ping'];
  const junk = [undefined, null, 42, 'str', {}, [], { toString: 1 }, { valueOf: () => 1 }, NaN, Infinity, -1, ''];
  let crashed = 0;
  for (const type of types) for (const j of junk) {
    try { host.emitMessage({ type, cosmeticId: j, targetId: j, roomCode: j, x: j, y: j, z: j, ry: j, emoteId: j, dir: j, token: j }); }
    catch (e) { crashed++; console.log('CRASH', type, JSON.stringify(j), e.message); }
  }
  assertEqual(crashed, 0, 'no message handler may throw on malformed input');
  // server must still be fully functional after the fuzz pass
  host.emitMessage({ type: 'ping', t: 1, seq: 99 });
  assertEqual(host.lastOfType('pong').seq, 99);
});

test('audit: unknown message type is silently ignored, not an error', () => {
  const ws = connect('x'); hello(ws);
  ws.emitMessage({ type: 'definitely_not_a_real_type', foo: 'bar' });
  ws.emitMessage({ type: 'ping', t: 5, seq: 1 });
  assert(ws.lastOfType('pong'), 'server kept processing after an unknown type');
});

test('audit: raw non-JSON / missing-type frames are dropped without crashing', () => {
  const ws = connect('x');
  ws._handlers.message('not json at all {{{');
  ws._handlers.message('null');
  ws._handlers.message('"just a string"');
  ws._handlers.message('42');
  ws._handlers.message(JSON.stringify({ noType: true }));
  ws.emitMessage({ type: 'hello' });
  assert(ws.lastOfType('hello_ok'), 'server recovered and still answers hello');
});
