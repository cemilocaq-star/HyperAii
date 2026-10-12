// Killcam tests: attacker identity, invalid attacker, disconnect, respawn, isolation, killcam -> spectator.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const { rooms, KILLCAM_MS, startKillcam, removePlayerFromRoom } = startServer.__test__;

function mk(n) {
  const ws = [], tok = []; const h = connect('h'); tok.push(hello(h)); ws.push(h);
  h.emitMessage({ type: 'create_room', name: 'P0', maxPlayers: 8, scoreLimit: 100 }); const code = h.lastOfType('room_created').code;
  for (let i = 1; i < n; i++) { const g = connect('p' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); ws.push(g); g.emitMessage({ type: 'player_ready' }); }
  h.emitMessage({ type: 'start_game' });
  return { room: rooms[code], ws, tok };
}
const kill = (m, a, v) => { for (let i = 0; i < 4; i++) m.ws[a].emitMessage({ type: 'hit', targetId: m.tok[v] }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('killcam: victim is shown the server-validated killer (id + name), not a client-claimed one', () => {
  const m = mk(3); kill(m, 0, 1);
  const kc = m.ws[1].lastOfType('killcam'); assertEqual(kc.attackerId, m.tok[0]); assertEqual(kc.attackerName, 'P0'); assertEqual(kc.durationMs, KILLCAM_MS);
  assertEqual(m.room.players[m.tok[1]].spectating, m.tok[0]);
  assert(!m.ws[2].lastOfType('killcam'), 'bystander gets no killcam'); startServer.__test__.shutdownAllRooms();
});
test('killcam: client cannot request a killcam / choose an attacker', () => {
  const m = mk(3);
  for (const type of ['killcam', 'killcam_end']) m.ws[1].emitMessage({ type, attackerId: m.tok[2] });
  assert(!m.ws[1].lastOfType('killcam'), 'no killcam without a validated kill'); startServer.__test__.shutdownAllRooms();
});
test('killcam: invalid attacker (self / unknown / missing) is refused', () => {
  const m = mk(2);
  assertEqual(startKillcam(m.room, m.tok[0], m.tok[0]), false); assertEqual(startKillcam(m.room, m.tok[0], 'nobody-1234567'), false);
  assertEqual(startKillcam(m.room, 'nobody-1234567', m.tok[0]), false); assertEqual(startKillcam(m.room, m.tok[0], undefined), false);
  startServer.__test__.shutdownAllRooms();
});
test('killcam: disconnected attacker -> safe fallback (no killcam, no crash, still spectator-capable)', () => {
  const m = mk(3); m.room.players[m.tok[0]].connected = false; kill(m, 0, 1);
  // disconnected players cannot hit, so trigger the fallback path directly
  m.room.players[m.tok[1]].alive = false;
  assertEqual(startKillcam(m.room, m.tok[1], m.tok[0]), false); assert(!m.ws[1].lastOfType('killcam'), 'no killcam for offline attacker');
  startServer.__test__.shutdownAllRooms();
});
test('killcam: after KILLCAM_MS (real timer) it ends and hands over to normal spectator', async () => {
  const m = mk(3); kill(m, 0, 1);
  await wait(KILLCAM_MS + 150);
  assert(m.ws[1].lastOfType('killcam_end'), 'killcam_end sent');
  const sp = m.ws[1].sent.filter((x) => x.type === 'spectate_state'); assert(sp.length >= 2, 'spectator target re-picked by server');
  assert(m.room.players[m.tok[1]].killcamTimer === null, 'timer cleared'); startServer.__test__.shutdownAllRooms();
});
test('killcam: respawn during/after killcam closes it (no stale timer, no spectate loop)', async () => {
  const m = mk(3); kill(m, 0, 1);
  const p = m.room.players[m.tok[1]]; assert(p.killcamTimer, 'armed');
  await wait(startServer.__test__.KILLCAM_MS + 100);
  await wait(1600); // RESPAWN_DELAY_MS = 4000
  assertEqual(p.alive, true); assertEqual(p.spectating, null); assertEqual(p.killcamTimer, null);
  startServer.__test__.shutdownAllRooms();
});
test('killcam: victim leaving mid-killcam clears the timer (no orphan)', () => {
  const m = mk(3); kill(m, 0, 1); const p = m.room.players[m.tok[1]]; assert(p.killcamTimer, 'armed');
  removePlayerFromRoom(m.room, m.tok[1], 'left'); assertEqual(p.killcamTimer, null);
  startServer.__test__.shutdownAllRooms();
});
test('killcam: match end / shutdown clears killcam timers', () => {
  const m = mk(3); kill(m, 0, 1); const p = m.room.players[m.tok[1]];
  startServer.__test__.endMatch(m.room, 'TIME'); assertEqual(p.killcamTimer, null); startServer.__test__.shutdownAllRooms();
});
test('killcam: room isolation — a kill in room A never sends killcam in room B', () => {
  const a = mk(3), b = mk(3); kill(a, 0, 1);
  for (const w of b.ws) assert(!w.lastOfType('killcam'), 'leaked'); startServer.__test__.shutdownAllRooms();
});
// Added after mutation testing: mutant "killcam timer not cleared on respawn" SURVIVED because the only respawn test
// waited for the killcam to finish first. Here the killcam is (re)armed just before the 4 s respawn fires, so the
// respawn itself must close it (real timers).
test('killcam: respawn while a killcam is still armed closes it (timer + killcamOf cleared by the respawn itself)', async () => {
  const m = mk(3); kill(m, 0, 1);
  const p = m.room.players[m.tok[1]];
  await wait(3700);                                  // just before RESPAWN_DELAY_MS (4000)
  assertEqual(p.alive, false, 'still dead before respawn');
  assert(startKillcam(m.room, m.tok[1], m.tok[0]), 're-armed killcam');
  assert(p.killcamTimer && p.killcamOf === m.tok[0], 'armed');
  await wait(600);                                   // respawn fires at ~4000 ms, killcam would run to ~6200 ms
  assertEqual(p.alive, true, 'respawned');
  assertEqual(p.killcamTimer, null, 'respawn must clear the killcam timer');
  assertEqual(p.killcamOf, null, 'respawn must clear killcamOf');
  startServer.__test__.shutdownAllRooms();
});
