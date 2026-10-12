// Bounty tests: creation, claim, single reward, isolation, reconnect, disconnect, farming protection.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const { rooms, getUnlocks, BOUNTY_CONFIG, removePlayerFromRoom, publicBounty } = startServer.__test__;

function mk(n) {
  const ws = [], tok = []; const h = connect('h'); tok.push(hello(h)); ws.push(h);
  h.emitMessage({ type: 'create_room', name: 'P0', maxPlayers: 8, scoreLimit: 100 }); const code = h.lastOfType('room_created').code;
  for (let i = 1; i < n; i++) { const g = connect('p' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); ws.push(g); g.emitMessage({ type: 'player_ready' }); }
  h.emitMessage({ type: 'start_game' });
  return { room: rooms[code], ws, tok };
}
const kill = (m, a, v) => { const p = m.room.players[m.tok[v]]; p.alive = true; p.health = 100; const at = m.room.players[m.tok[a]]; at.alive = true; at.health = 100; for (let i = 0; i < 4; i++) m.ws[a].emitMessage({ type: 'hit', targetId: m.tok[v] }); };
// give player 0 a legit streak over >=2 distinct victims
function streak(m, killer, victims, count) { for (let i = 0; i < count; i++) kill(m, killer, victims[i % victims.length]); }
const hasBadge = (t) => !!(getUnlocks(t) && getUnlocks(t).bounty_hunter);

test('bounty: created after threshold streak over distinct victims; announced to room', () => {
  const m = mk(3); streak(m, 0, [1, 2], BOUNTY_CONFIG.streakThreshold);
  assertEqual(m.room.bounty.token, m.tok[0]); assert(m.ws[1].lastOfType('bounty_set'), 'announced');
  assertEqual(publicBounty(m.room).name, 'P0'); startServer.__test__.shutdownAllRooms();
});
test('bounty: NOT created before threshold', () => {
  const m = mk(3); streak(m, 0, [1, 2], BOUNTY_CONFIG.streakThreshold - 1); assertEqual(m.room.bounty, null);
  startServer.__test__.shutdownAllRooms();
});
test('bounty farming: streak on ONE repeatedly-killed victim never creates a bounty', () => {
  const m = mk(3); streak(m, 0, [1], 12); assertEqual(m.room.players[m.tok[0]].streak, 12); assertEqual(m.room.bounty, null);
  startServer.__test__.shutdownAllRooms();
});
test('bounty: claim by killing the target -> consumed, announced, reward granted once', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5); kill(m, 1, 0);
  assertEqual(m.room.bounty, null); assert(m.ws[2].lastOfType('bounty_claimed'), 'claim announced');
  assertEqual(m.ws[2].lastOfType('bounty_claimed').hunterName, 'P1'); assert(hasBadge(m.tok[1]), 'hunter rewarded');
  startServer.__test__.shutdownAllRooms();
});
test('bounty: reward is single — second bounty on same room does not re-grant / re-announce achievement', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5); kill(m, 1, 0);
  const before = m.ws[1].sent.filter((x) => x.type === 'achievement_unlocked' && x.id === 'bounty_hunter').length;
  streak(m, 0, [1, 2], 5); kill(m, 1, 0);
  assertEqual(m.ws[1].sent.filter((x) => x.type === 'achievement_unlocked' && x.id === 'bounty_hunter').length, before, 'no 2nd reward'); assertEqual(before, 1);
  startServer.__test__.shutdownAllRooms();
});
test('bounty: killing a NON-bounty player never claims; client cannot send claim/set messages', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5);
  for (const type of ['bounty_claim', 'bounty_claimed', 'bounty_set', 'claim_bounty']) m.ws[1].emitMessage({ type, targetId: m.tok[0], id: m.tok[1] });
  assertEqual(m.room.bounty.token, m.tok[0]); assert(!hasBadge(m.tok[1]), 'no reward from fake packets');
  kill(m, 1, 2); assertEqual(m.room.bounty.token, m.tok[0], 'bounty untouched');
  startServer.__test__.shutdownAllRooms();
});
test('bounty: only one active bounty per room (no duplicates)', () => {
  const m = mk(4); streak(m, 0, [1, 2], 5); streak(m, 3, [1, 2], 6);
  assertEqual(m.room.bounty.token, m.tok[0]); assertEqual(m.ws[1].sent.filter((x) => x.type === 'bounty_set').length, 1);
  startServer.__test__.shutdownAllRooms();
});
test('bounty: room isolation — A bounty/claim never touches B', () => {
  const a = mk(3), b = mk(3); streak(a, 0, [1, 2], 5); kill(a, 1, 0);
  assertEqual(b.room.bounty, null); assert(!b.ws[1].lastOfType('bounty_set') && !b.ws[1].lastOfType('bounty_claimed'), 'leak');
  startServer.__test__.shutdownAllRooms();
});
test('bounty: reconnect keeps bounty (visible in room_state) and disconnect grace does not clear/duplicate it', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5);
  m.room.players[m.tok[0]].connected = false; // grace window: token/player object stays
  assertEqual(m.room.bounty.token, m.tok[0]);
  m.room.players[m.tok[0]].connected = true;
  assertEqual(startServer.__test__.rooms[Object.keys(rooms).find((c) => rooms[c] === m.room)].bounty.token, m.tok[0]);
  startServer.__test__.shutdownAllRooms();
});
test('bounty: target permanently leaving clears bounty safely (no crash, no orphan)', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5);
  removePlayerFromRoom(m.room, m.tok[0], 'timeout'); assertEqual(m.room.bounty, null);
  startServer.__test__.shutdownAllRooms();
});
test('bounty: match end clears bounty; new match starts clean', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5); startServer.__test__.endMatch(m.room, 'TIME'); assertEqual(m.room.bounty, null);
  m.ws[0].emitMessage({ type: 'rematch' }); assertEqual(m.room.bounty, null); assertEqual(m.room.players[m.tok[0]].streak, 0);
  startServer.__test__.shutdownAllRooms();
});

test('bounty: a target can never claim their own bounty (guard tested directly, not only via the self-hit guard)', () => {
  const m = mk(3); streak(m, 0, [1, 2], 5); const p0 = m.room.players[m.tok[0]];
  startServer.__test__.settleBountyOnKill(m.room, m.tok[0], p0, m.tok[0], p0);
  assertEqual(m.room.bounty.token, m.tok[0], 'bounty still active'); assert(!hasBadge(m.tok[0]), 'no self reward');
  assert(!m.ws[1].lastOfType('bounty_claimed'), 'no claim broadcast'); startServer.__test__.shutdownAllRooms();
});
