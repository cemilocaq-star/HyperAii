// Host room settings + Quick Play defaults. Regression for: Quick Play rooms had no roundTimeSec/scoreLimit,
// so setTimeout(NaN) ended every Quick Play match within ~1 ms.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const T = startServer.__test__;

function lobby(n, opts) {
  const ws = [], tok = [];
  const h = connect('h'); tok.push(hello(h)); ws.push(h);
  h.emitMessage({ type: 'create_room', name: 'P0', maxPlayers: 8, mode: 'ffa', ...(opts || {}) });
  const code = h.lastOfType('room_created').code;
  for (let i = 1; i < n; i++) { const g = connect('p' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); ws.push(g); }
  return { code, room: T.rooms[code], ws, tok };
}

test('quickplay: a Quick Play room gets valid match settings and the match does not end immediately (real timer)', async () => {
  const a = connect('q'); hello(a); a.emitMessage({ type: 'quick_play', name: 'Q' });
  const room = Object.values(T.rooms).find((r) => r.players && Object.keys(r.players).length === 1 && r.isPublic);
  assert(room, 'quick-play room exists');
  assertEqual(room.roundTimeSec, T.MATCH_CONFIG.defaultRoundSec); assertEqual(room.scoreLimit, T.MATCH_CONFIG.defaultScore);
  a.emitMessage({ type: 'start_game' });
  await new Promise((r) => setTimeout(r, 80));
  assert(room.match && room.match.state !== 'ended', 'match must not end within 80 ms, got ' + (room.match && room.match.state));
  T.shutdownAllRooms();
});
test('roomsettings: defaults + strict-boolean parsing on create_room', () => {
  const m = lobby(1, { chaosEnabled: 'no', friendlyFire: 1, spectatorEnabled: false, randomEvents: {} });
  assertEqual(m.room.chaosEnabled, true, 'string is not a boolean -> default'); assertEqual(m.room.friendlyFire, false, '1 is not a boolean -> default');
  assertEqual(m.room.spectatorEnabled, false, 'real boolean accepted'); assertEqual(m.room.randomEvents, true); assertEqual(m.room.randomWeapons, true);
  T.shutdownAllRooms();
});
test('roomsettings: only the host can change settings; non-host is ignored', () => {
  const m = lobby(2);
  m.ws[1].emitMessage({ type: 'room_settings', settings: { scoreLimit: 5, chaosEnabled: false } });
  assertEqual(m.room.scoreLimit, T.MATCH_CONFIG.defaultScore); assertEqual(m.room.chaosEnabled, true);
  m.ws[0].emitMessage({ type: 'room_settings', settings: { scoreLimit: 5, chaosEnabled: false, friendlyFire: true } });
  assertEqual(m.room.scoreLimit, 5); assertEqual(m.room.chaosEnabled, false); assertEqual(m.room.friendlyFire, true);
  assertEqual(m.ws[1].lastOfType('room_state').settings.scoreLimit, 5, 'guests are told the new settings');
  T.shutdownAllRooms();
});
test('roomsettings: hostile / malformed values are clamped or ignored, never crash', () => {
  const m = lobby(2);
  for (const bad of [null, undefined, 'x', 5, [], [1], { scoreLimit: NaN }, { scoreLimit: Infinity, roundTimeSec: -1, maxPlayers: 1e9 }, { __proto__: { chaosEnabled: false } }, JSON.parse('{"__proto__":{"polluted":1}}')])
    m.ws[0].emitMessage({ type: 'room_settings', settings: bad });
  assert(m.room.scoreLimit >= T.MATCH_CONFIG.minScore && m.room.scoreLimit <= T.MATCH_CONFIG.maxScore);
  assert(m.room.roundTimeSec >= T.MATCH_CONFIG.minRoundSec && m.room.roundTimeSec <= T.MATCH_CONFIG.maxRoundSec);
  assert(m.room.maxPlayers >= 2 && m.room.maxPlayers <= 12); assertEqual({}.polluted, undefined, 'no prototype pollution');
  T.shutdownAllRooms();
});
test('roomsettings: maxPlayers can never be lowered below the players already in the room', () => {
  const m = lobby(4);
  m.ws[0].emitMessage({ type: 'room_settings', settings: { maxPlayers: 2 } });
  assert(m.room.maxPlayers >= 4, 'got ' + m.room.maxPlayers);
  T.shutdownAllRooms();
});
test('roomsettings: cannot be changed once the match has started', () => {
  const m = lobby(2); m.ws[1].emitMessage({ type: 'player_ready' }); m.ws[0].emitMessage({ type: 'start_game' });
  assert(m.room.started, 'started');
  m.ws[0].emitMessage({ type: 'room_settings', settings: { scoreLimit: 3, friendlyFire: true } });
  assertEqual(m.room.scoreLimit, T.MATCH_CONFIG.defaultScore); assertEqual(m.room.friendlyFire, false);
  T.shutdownAllRooms();
});
test('roomsettings: settings persist across host migration (new host can change, old host cannot)', () => {
  const m = lobby(2); m.ws[0].emitMessage({ type: 'room_settings', settings: { scoreLimit: 7 } });
  m.ws[0].emitMessage({ type: 'leave_room' });
  assertEqual(m.room.hostToken, m.tok[1], 'host migrated'); assertEqual(m.room.scoreLimit, 7, 'settings survive migration');
  m.ws[1].emitMessage({ type: 'room_settings', settings: { scoreLimit: 9 } }); assertEqual(m.room.scoreLimit, 9);
  m.ws[0].emitMessage({ type: 'room_settings', settings: { scoreLimit: 4 } }); assertEqual(m.room.scoreLimit, 9, 'old host lost permission');
  T.shutdownAllRooms();
});
test('roomsettings: chaosEnabled=false really suppresses chaos events (server side)', () => {
  const m = lobby(2, { chaosEnabled: false }); m.ws[1].emitMessage({ type: 'player_ready' }); m.ws[0].emitMessage({ type: 'start_game' });
  const saved = T.CHAOS_CONFIG.rng; T.CHAOS_CONFIG.rng = () => 0; // would always roll the first event
  try { for (let i = 0; i < 5; i++) T.chaosCheck(m.room); } finally { T.CHAOS_CONFIG.rng = saved; }
  assertEqual(m.room.chaosState, null);
  m.room.chaosEnabled = true; m.room.chaosCooldownUntil = 0; T.CHAOS_CONFIG.rng = () => 0;
  try { T.chaosCheck(m.room); } finally { T.CHAOS_CONFIG.rng = saved; }
  assert(m.room.chaosState, 'with chaos on the same roll starts an event (control)');
  T.shutdownAllRooms();
});
test('roomsettings: friendlyFire in team mode — blocked by default, allowed when the host enables it', () => {
  const m = lobby(2, { mode: 'team' }); m.ws[1].emitMessage({ type: 'player_ready' });
  m.room.players[m.tok[0]].team = 1; m.room.players[m.tok[1]].team = 1;
  m.ws[0].emitMessage({ type: 'start_game' });
  const v = m.room.players[m.tok[1]];
  const fire = () => { m.ws[0].emitMessage({ type: 'shoot', origin: [0, 1.6, 20], dir: [0, 0, -1] }); m.ws[0].emitMessage({ type: 'hit', targetId: m.tok[1], origin: [0, 1.6, 20], dir: [0, 0, -1] }); };
  const a = m.room.players[m.tok[0]]; a.x = 0; a.y = 1.6; a.z = 20; v.x = 0; v.y = 1.6; v.z = 10;
  fire(); assertEqual(v.health, 100, 'teammate protected by default');
  m.room.friendlyFire = true; fire(); assert(v.health < 100, 'friendly fire on -> damage lands');
  T.shutdownAllRooms();
});
test('roomsettings: spectatorEnabled=false ignores spectate_request', () => {
  const m = lobby(3, { spectatorEnabled: false }); m.ws[1].emitMessage({ type: 'player_ready' }); m.ws[2].emitMessage({ type: 'player_ready' }); m.ws[0].emitMessage({ type: 'start_game' });
  const d = m.room.players[m.tok[1]]; d.alive = false;
  m.ws[1].emitMessage({ type: 'spectate_request', targetId: m.tok[2] });
  assert(!d.spectating, 'spectating must stay off when the host disabled it');
  T.shutdownAllRooms();
});
test('roomsettings: settings are room-scoped (room A change never touches room B)', () => {
  const a = lobby(1), b = lobby(1); a.ws[0].emitMessage({ type: 'room_settings', settings: { scoreLimit: 5, friendlyFire: true } });
  assertEqual(b.room.scoreLimit, T.MATCH_CONFIG.defaultScore); assertEqual(b.room.friendlyFire, false);
  T.shutdownAllRooms();
});
// Added after mutation testing: the beginMatch guard (defense in depth) had no test that reaches it.
test('roomsettings: a room with corrupt/missing round settings still gets a sane, non-instant match (guard in beginMatch)', async () => {
  for (const bad of [undefined, NaN, -5, 0, Infinity]) {
    const m = lobby(2); m.ws[1].emitMessage({ type: 'player_ready' });
    m.room.roundTimeSec = bad; m.room.scoreLimit = bad;
    const saved = T.MATCH_CONFIG.countdownMs; T.MATCH_CONFIG.countdownMs = 0;
    try { m.ws[0].emitMessage({ type: 'start_game' }); } finally { T.MATCH_CONFIG.countdownMs = saved; }
    await new Promise((r) => setTimeout(r, 30));
    assertEqual(m.room.match.state, 'active', 'roundTimeSec=' + String(bad) + ' must not end the match instantly');
    assertEqual(m.room.roundTimeSec, T.MATCH_CONFIG.defaultRoundSec); assertEqual(m.room.scoreLimit, T.MATCH_CONFIG.defaultScore);
    T.shutdownAllRooms();
  }
});
