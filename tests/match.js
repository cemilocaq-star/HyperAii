// Match system tests: score limit, timer, streaks, match end, rematch, isolation, cleanup.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const { rooms, MATCH_CONFIG, endMatch, matchActive, clampInt } = startServer.__test__;

function makeRoom(n, opts) {
  const ws = [], tok = [];
  const host = connect('h'); tok.push(hello(host)); ws.push(host);
  host.emitMessage({ type: 'create_room', name: 'P0', maxPlayers: 8, ...(opts || {}) });
  const code = host.lastOfType('room_created').code;
  for (let i = 1; i < n; i++) { const g = connect('p' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); ws.push(g); }
  for (let i = 1; i < n; i++) ws[i].emitMessage({ type: 'player_ready' });
  host.emitMessage({ type: 'start_game' });
  return { code, room: rooms[code], ws, tok };
}
const kill = (m, a, v) => { for (let i = 0; i < 4; i++) m.ws[a].emitMessage({ type: 'hit', targetId: m.tok[v] }); };
const revive = (m, v) => { const p = m.room.players[m.tok[v]]; p.alive = true; p.health = 100; };

test('match: settings are clamped server-side (hostile / malformed values)', () => {
  assertEqual(clampInt(NaN, 3, 100, 30), 30); assertEqual(clampInt(Infinity, 3, 100, 30), 30);
  assertEqual(clampInt('x', 3, 100, 30), 30); assertEqual(clampInt(-5, 3, 100, 30), 3);
  assertEqual(clampInt(1e9, 3, 100, 30), 100); assertEqual(clampInt({}, 3, 100, 30), 30);
  const m = makeRoom(2, { roundTimeSec: 1e9, scoreLimit: -1 });
  assertEqual(m.room.roundTimeSec, MATCH_CONFIG.maxRoundSec); assertEqual(m.room.scoreLimit, MATCH_CONFIG.minScore);
  startServer.__test__.shutdownAllRooms();
});
test('match: start makes an active match with a timer', () => {
  const m = makeRoom(2);
  assert(matchActive(m.room), 'active'); assert(m.room.match.timer, 'timer armed');
  assert(m.ws[1].lastOfType('match_state'), 'clients told match_state');
  startServer.__test__.shutdownAllRooms();
});
test('match: score limit ends the match exactly once and broadcasts stats', () => {
  const m = makeRoom(2, { scoreLimit: 3 });
  for (let k = 0; k < 3; k++) { kill(m, 0, 1); revive(m, 1); }
  assertEqual(m.room.match.state, 'ended');
  const ends = m.ws[1].sent.filter((x) => x.type === 'match_end');
  assertEqual(ends.length, 1, 'match_end once'); assertEqual(ends[0].reason, 'SCORE_LIMIT');
  assertEqual(ends[0].winner.token, m.tok[0]);
  startServer.__test__.shutdownAllRooms();
});
test('match: no damage / kills after match end', () => {
  const m = makeRoom(2, { scoreLimit: 3 });
  for (let k = 0; k < 3; k++) { kill(m, 0, 1); revive(m, 1); }
  const before = m.room.players[m.tok[0]].kills; kill(m, 0, 1);
  assertEqual(m.room.players[m.tok[0]].kills, before); assertEqual(m.room.players[m.tok[1]].health, 100);
  startServer.__test__.shutdownAllRooms();
});
test('match: timer end (real timer) ends the match with reason TIME', async () => {
  const m = makeRoom(2);
  clearTimeout(m.room.match.timer); m.room.match.timer = setTimeout(() => endMatch(m.room, 'TIME'), 30);
  await new Promise((r) => setTimeout(r, 80));
  assertEqual(m.room.match.state, 'ended'); assertEqual(m.room.match.result.reason, 'TIME');
  startServer.__test__.shutdownAllRooms();
});
test('killstreak: increments, resets on death, best streak tracked, server-side only', () => {
  const m = makeRoom(3, { scoreLimit: 100 });
  kill(m, 0, 1); revive(m, 1); kill(m, 0, 2); revive(m, 2);
  const a = m.room.players[m.tok[0]];
  assertEqual(a.streak, 2); assert(m.ws[1].lastOfType('kill_streak'), 'streak notification');
  kill(m, 1, 0);
  assertEqual(a.streak, 0, 'death resets'); assertEqual(a.bestStreak, 2, 'best kept');
  startServer.__test__.shutdownAllRooms();
});
test('killstreak: client cannot inject streak/kill/score/match_end messages', () => {
  const m = makeRoom(2);
  for (const type of ['kill_streak', 'match_end', 'match_state', 'score', 'kill'])
    m.ws[0].emitMessage({ type, streak: 99, kills: 99, reason: 'X' });
  m.ws[0].emitMessage({ type: 'rematch' }); m.ws[0].emitMessage({ type: 'return_lobby' });
  assertEqual(m.room.players[m.tok[0]].streak, 0); assert(matchActive(m.room), 'still active (rematch needs ended match)');
  startServer.__test__.shutdownAllRooms();
});
test('killstreak: reconnect keeps streak, does not double count', () => {
  const m = makeRoom(2, { scoreLimit: 100 });
  kill(m, 0, 1);
  const p = m.room.players[m.tok[0]]; const s = p.streak, k = p.kills;
  p.connected = false; p.connected = true;
  assertEqual(p.streak, s); assertEqual(p.kills, k);
  startServer.__test__.shutdownAllRooms();
});
test('killstreak+match: room isolation (A kills never touch B)', () => {
  const a = makeRoom(2, { scoreLimit: 3 }), b = makeRoom(2, { scoreLimit: 3 });
  for (let k = 0; k < 3; k++) { kill(a, 0, 1); revive(a, 1); }
  assertEqual(a.room.match.state, 'ended'); assertEqual(b.room.match.state, 'active');
  assertEqual(b.room.players[b.tok[0]].kills, 0); assertEqual(b.room.players[b.tok[0]].streak, 0);
  startServer.__test__.shutdownAllRooms();
});
test('match end: MVP stats — chaotic player is chaos exposure, not kills/deaths', () => {
  const m = makeRoom(3, { scoreLimit: 100 });
  const r = m.room; const [t0, t1, t2] = m.tok;
  r.players[t0].kills = 9; r.players[t1].deaths = 9; r.players[t2].chaosExposure = 2; r.players[t0].chaosExposure = 1;
  const res = startServer.__test__.buildMatchResult(r, 'TIME');
  assertEqual(res.chaoticPlayer.token, t2); assertEqual(res.mostKills.token, t0); assertEqual(res.mostDeaths.token, t1);
  startServer.__test__.shutdownAllRooms();
});
test('match end: chaotic player tie-break is deterministic (join order); none if nobody affected', () => {
  const m = makeRoom(3, { scoreLimit: 100 });
  assertEqual(startServer.__test__.buildMatchResult(m.room, 'TIME').chaoticPlayer, null);
  m.room.players[m.tok[1]].chaosExposure = 2; m.room.players[m.tok[2]].chaosExposure = 2;
  assertEqual(startServer.__test__.buildMatchResult(m.room, 'TIME').chaoticPlayer.token, m.tok[1]);
  startServer.__test__.shutdownAllRooms();
});
test('rematch: only host, only after end; resets stats and starts a new match', () => {
  const m = makeRoom(2, { scoreLimit: 3 });
  for (let k = 0; k < 3; k++) { kill(m, 0, 1); revive(m, 1); }
  m.ws[1].emitMessage({ type: 'rematch' }); assertEqual(m.room.match.state, 'ended', 'non-host rejected');
  m.ws[0].emitMessage({ type: 'rematch' });
  assert(matchActive(m.room), 'new match'); assertEqual(m.room.players[m.tok[0]].kills, 0);
  startServer.__test__.shutdownAllRooms();
});
test('rematch: return_lobby by host unreadies players and leaves started=false', () => {
  const m = makeRoom(2, { scoreLimit: 3 });
  for (let k = 0; k < 3; k++) { kill(m, 0, 1); revive(m, 1); }
  m.ws[0].emitMessage({ type: 'return_lobby' });
  assertEqual(m.room.started, false); assertEqual(m.room.match, null); assertEqual(m.room.players[m.tok[1]].ready, false);
  startServer.__test__.shutdownAllRooms();
});
test('lifecycle: shutdown/room deletion clears the match timer (no orphan)', () => {
  const m = makeRoom(2); const room = m.room; const t = room.match.timer;
  startServer.__test__.shutdownAllRooms();
  assertEqual(room.match.timer, null); assert(t, 'had a timer');
});

test('match: endMatch called again on an ended match is a no-op (no 2nd broadcast, result unchanged)', () => {
  const m = makeRoom(2); assertEqual(endMatch(m.room, 'TIME'), true);
  const first = m.room.match.result; const n = m.ws[1].sent.filter((x) => x.type === 'match_end').length;
  assertEqual(endMatch(m.room, 'SCORE_LIMIT'), false, 'second end refused');
  assertEqual(m.ws[1].sent.filter((x) => x.type === 'match_end').length, n); assertEqual(m.room.match.result, first);
  startServer.__test__.shutdownAllRooms();
});
test('lifecycle: room deleted when its last player leaves clears the match timer (deleteRoomIfEmpty path, not shutdown)', () => {
  const m = makeRoom(2); const room = m.room; assert(room.match.timer, 'armed');
  startServer.__test__.removePlayerFromRoom(room, m.tok[0], 'left'); startServer.__test__.removePlayerFromRoom(room, m.tok[1], 'left');
  assert(!rooms[m.code], 'room deleted'); assertEqual(room.match.timer, null, 'match timer must be cleared on room deletion');
});

// ---------------------------------------------------------------- countdown (real timers)
const { spawnSync } = require('child_process');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function withCountdown(ms, fn) { const old = MATCH_CONFIG.countdownMs; MATCH_CONFIG.countdownMs = ms; return Promise.resolve().then(fn).finally(() => { MATCH_CONFIG.countdownMs = old; }); }

test('countdown: production default is 3000 ms in a fresh process that never loaded the harness', () => {
  const r = spawnSync(process.execPath, ['-e', `const s=require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});console.log(JSON.stringify({cd:s.__test__.MATCH_CONFIG.countdownMs}));process.exit(0)`],
    { encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_PATH: path.join(__dirname, 'stubs', 'node_modules') } });
  assertEqual(r.status, 0, r.stderr); assertEqual(JSON.parse(r.stdout.trim().split('\n').pop()).cd, 3000);
});
test('countdown: state is countdown, shoot/hit are rejected, then it becomes active (real timer) and combat works', async () => {
  await withCountdown(150, async () => {
    const m = makeRoom(2, { scoreLimit: 50 });
    assertEqual(m.room.match.state, 'countdown'); assert(!matchActive(m.room), 'not active during countdown');
    const st = m.ws[1].sent.filter((x) => x.type === 'match_state').pop();
    assertEqual(st.state, 'countdown'); assert(st.countdownMs > 0 && st.countdownMs <= 150, 'remaining countdown reported');
    const hp = m.room.players[m.tok[1]].health; kill(m, 0, 1);
    assertEqual(m.room.players[m.tok[1]].health, hp, 'no damage during countdown'); assertEqual(m.room.players[m.tok[0]].kills, 0);
    assertEqual(m.room.players[m.tok[0]].pendingShot || null, null, 'no shoot credit during countdown');
    await wait(260);
    assertEqual(m.room.match.state, 'active'); assert(m.room.match.timer, 'round timer armed on activation');
    assertEqual(m.ws[1].sent.filter((x) => x.type === 'match_state').pop().state, 'active');
    kill(m, 0, 1); assertEqual(m.room.players[m.tok[0]].kills, 1, 'combat works after countdown');
    startServer.__test__.shutdownAllRooms();
  });
});
test('countdown: room deletion / shutdown during countdown clears the countdown timer (no orphan, never activates)', async () => {
  await withCountdown(120, async () => {
    const m = makeRoom(2); const room = m.room; assert(room.match.countdownTimer, 'armed');
    startServer.__test__.shutdownAllRooms();
    assertEqual(room.match.countdownTimer, null); await wait(220);
    assertEqual(room.match.state, 'countdown', 'never activated after shutdown'); assertEqual(room.match.timer, null);
  });
});
test('countdown: return_lobby/rematch cannot be forced during countdown; rematch re-enters countdown', async () => {
  await withCountdown(120, async () => {
    const m = makeRoom(2, { scoreLimit: 3 });
    m.ws[0].emitMessage({ type: 'rematch' }); m.ws[0].emitMessage({ type: 'return_lobby' });
    assertEqual(m.room.match.state, 'countdown', 'host cannot skip/reset a running countdown');
    await wait(220);
    for (let k = 0; k < 3; k++) { kill(m, 0, 1); revive(m, 1); }
    assertEqual(m.room.match.state, 'ended');
    m.ws[0].emitMessage({ type: 'rematch' });
    assertEqual(m.room.match.state, 'countdown', 'rematch starts a new countdown'); assertEqual(m.room.players[m.tok[0]].kills, 0);
    startServer.__test__.shutdownAllRooms();
  });
});

// Added after mutation testing (2 survivors): (a) the countdown test never sent a real `shoot`, only `hit`s, so
// "shoot allowed during countdown" survived; (b) nothing proved activateMatch() is a no-op outside 'countdown'.
test('countdown: a properly aimed SHOOT is rejected during countdown (no credit, no broadcast) and accepted right after (positive control)', async () => {
  await withCountdown(150, async () => {
    const m = makeRoom(2, { scoreLimit: 50 });
    const p = m.room.players[m.tok[0]]; p.x = 0; p.y = 1.6; p.z = 0;
    const aim = { origin: [0, 1.6, 0], dir: [0, 0, -1] };
    m.ws[0].emitMessage({ type: 'shoot', ...aim });
    assertEqual(p.pendingShot || null, null, 'countdown must not create a shoot credit');
    assertEqual(m.ws[1].sent.filter((x) => x.type === 'shoot').length, 0, 'countdown shot must not be broadcast');
    await wait(260);
    m.ws[0].emitMessage({ type: 'shoot', ...aim });
    assert(p.pendingShot, 'same shot is accepted once the match is active (proves the test would notice)');
    assertEqual(m.ws[1].sent.filter((x) => x.type === 'shoot').length, 1, 'accepted shot is broadcast');
    startServer.__test__.shutdownAllRooms();
  });
});
test('countdown: activateMatch is a no-op unless state === countdown (cannot re-arm timers or resurrect an ended match)', () => {
  const m = makeRoom(2, { scoreLimit: 3 });                    // harness countdown = 0 -> already active
  const timer = m.room.match.timer, endsAt = m.room.match.endsAt;
  startServer.__test__.activateMatch(m.room);
  assertEqual(m.room.match.timer, timer, 'active match: round timer must not be re-armed'); assertEqual(m.room.match.endsAt, endsAt);
  for (let k = 0; k < 3; k++) { kill(m, 0, 1); revive(m, 1); }
  assertEqual(m.room.match.state, 'ended');
  startServer.__test__.activateMatch(m.room);
  assertEqual(m.room.match.state, 'ended', 'ended match must never be re-activated'); assertEqual(m.room.match.timer, null, 'no timer armed after end');
  startServer.__test__.shutdownAllRooms();
});
