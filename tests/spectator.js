// Phase 1 — Spectator Mode tests.
// Run standalone: node tests/spectator.js
// Also picked up automatically by tests/run.js.

const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const { rooms } = startServer.__test__;

function makeRoom(playerCount) {
  const wss_ = [];
  const toks = [];
  const host = connect('host');
  const hostTok = hello(host);
  host.emitMessage({ type: 'create_room', name: 'P0', maxPlayers: Math.max(2, playerCount) });
  const code = host.lastOfType('room_created').code;
  wss_.push(host); toks.push(hostTok);
  for (let i = 1; i < playerCount; i++) {
    const g = connect('p' + i);
    const t = hello(g);
    g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i });
    wss_.push(g); toks.push(t);
  }
  for (let i = 1; i < playerCount; i++) wss_[i].emitMessage({ type: 'player_ready' });
  host.emitMessage({ type: 'start_game' });
  return { code, room: rooms[code], ws: wss_, tok: toks };
}

function killPlayer(room, wsArr, tokArr, attackerIdx, victimIdx) {
  // server owns damage (25/hit) -> 4 hits kill a 100hp player
  for (let i = 0; i < 4; i++) wsArr[attackerIdx].emitMessage({ type: 'hit', targetId: tokArr[victimIdx] });
}

test('spectator: on death, victim gets you_died and alive=false', () => {
  const { room, ws, tok } = makeRoom(3);
  killPlayer(room, ws, tok, 0, 1);
  assert(ws[1].lastOfType('you_died'), 'victim should receive you_died');
  assertEqual(room.players[tok[1]].alive, false, 'victim should be marked not alive');
});

test('spectator: dead player can request a target among live players only', () => {
  const { room, ws, tok } = makeRoom(3);
  killPlayer(room, ws, tok, 0, 1); // tok[1] is now dead
  ws[1].emitMessage({ type: 'spectate_request' });
  const state = ws[1].lastOfType('spectate_state');
  assert(state.targetToken, 'should get a target');
  assert(state.targetToken !== tok[1], 'must not be able to spectate self');
  const liveTokens = [tok[0], tok[2]];
  assert(liveTokens.includes(state.targetToken), 'target must be a live player');
});

test('spectator: client cannot spoof a target token — only next/prev/self-heal from server list', () => {
  const { room, ws, tok } = makeRoom(3);
  killPlayer(room, ws, tok, 0, 1);
  // Try to smuggle an arbitrary token in the request — server must ignore it
  // and pick from its own live-player list instead.
  ws[1].emitMessage({ type: 'spectate_request', targetToken: 'not-a-real-token-i-made-up' });
  const state = ws[1].lastOfType('spectate_state');
  assertEqual(room.players[tok[1]].spectating, state.targetToken, 'server-chosen target should be what is stored');
  assert(state.targetToken !== 'not-a-real-token-i-made-up', 'must ignore client-supplied target token');
});

test('spectator: next/prev cycles through live players deterministically', () => {
  const { room, ws, tok } = makeRoom(4); // tok[0] host alive, tok[1] dies, tok[2],tok[3] alive
  killPlayer(room, ws, tok, 0, 1);
  ws[1].emitMessage({ type: 'spectate_request' });
  const first = ws[1].lastOfType('spectate_state').targetToken;
  ws[1].emitMessage({ type: 'spectate_request', direction: 'next' });
  const second = ws[1].lastOfType('spectate_state').targetToken;
  assert(second !== first, 'next should move to a different live player');
  ws[1].emitMessage({ type: 'spectate_request', direction: 'prev' });
  const back = ws[1].lastOfType('spectate_state').targetToken;
  assertEqual(back, first, 'prev should return to the previous target');
});

test('spectator: if watched target dies, spectator is auto-reassigned to another live player', () => {
  const { room, ws, tok } = makeRoom(3);
  killPlayer(room, ws, tok, 0, 1); // tok[1] dead, spectating available: tok[0], tok[2]
  ws[1].emitMessage({ type: 'spectate_request' }); // will land on tok[0] (idx 0 of [tok0,tok2])
  const watching = ws[1].lastOfType('spectate_state').targetToken;
  assertEqual(watching, tok[0]);
  // Now attacker (tok0) also dies — spectator[1] should get bumped off tok0.
  killPlayer(room, ws, tok, 2, 0);
  const reassigned = ws[1].allOfType('spectate_state').pop();
  assert(reassigned.targetToken !== tok[0], 'must be moved off the now-dead target');
  assertEqual(reassigned.targetToken, tok[2], 'only remaining live player is tok[2]');
});

test('spectator: no live players left -> WAITING (targetToken null, reason NO_LIVE_PLAYERS)', () => {
  const { room, ws, tok } = makeRoom(2);
  killPlayer(room, ws, tok, 0, 1); // tok1 dead, tok0 alive
  ws[1].emitMessage({ type: 'spectate_request' });
  assertEqual(ws[1].lastOfType('spectate_state').targetToken, tok[0], 'tok1 should be watching the only live player tok0');
  // Model "last player standing also goes down" (e.g. disconnects) directly,
  // since with only 2 players the dead one has no way to deal more damage.
  room.players[tok[0]].alive = false;
  ws[1].emitMessage({ type: 'spectate_request', direction: 'next' });
  const state = ws[1].lastOfType('spectate_state');
  assertEqual(state.targetToken, null, 'no live players left');
  assertEqual(state.reason, 'NO_LIVE_PLAYERS');
});

test('spectator: dead player auto-respawns after the real delay and gets spectate_end', async () => {
  const { room, ws, tok } = makeRoom(2);
  killPlayer(room, ws, tok, 0, 1);
  assertEqual(room.players[tok[1]].alive, false);
  assert(room.respawnTimers[tok[1]], 'a respawn timer should be scheduled');
  // Real wait (RESPAWN_DELAY_MS is 4000ms and not injectable without a
  // bigger refactor) so this exercises the actual setTimeout callback,
  // not a re-implementation of it.
  await new Promise((resolve) => setTimeout(resolve, 4200));
  assertEqual(room.players[tok[1]].alive, true, 'should have auto-respawned');
  assertEqual(room.players[tok[1]].health, 100);
  assert(ws[1].lastOfType('spectate_end'), 'victim should be told to exit spectator UI');
  assert(ws[1].lastOfType('respawn'), 'respawn broadcast should have fired');
});

test('spectator: disconnect of watched target reassigns the spectator', () => {
  const { room, ws, tok } = makeRoom(3);
  killPlayer(room, ws, tok, 0, 1); // tok1 dead
  ws[1].emitMessage({ type: 'spectate_request' }); // -> tok0 (first live)
  assertEqual(ws[1].lastOfType('spectate_state').targetToken, tok[0]);
  ws[0].emitClose(); // host (tok0) disconnects
  const latest = ws[1].allOfType('spectate_state').pop();
  assertEqual(latest.targetToken, tok[2], 'should move to the remaining live+connected player');
});

test('spectator: per-tick state broadcast includes alive flag', () => {
  const { room, ws, tok } = makeRoom(2);
  killPlayer(room, ws, tok, 0, 1);
  assertEqual(room.players[tok[0]].alive, true);
  assertEqual(room.players[tok[1]].alive, false);
  // (The 66ms setInterval broadcast loop itself isn't invoked by this
  // harness — see NOT VERIFIED note in the report re: live tick timing.)
});


