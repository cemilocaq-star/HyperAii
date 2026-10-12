// Server-side interest management tests (Phase 2). Picked up by tests/run.js.
// These test the PURE per-recipient builder (deterministic) plus one run through the real tick.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, buildPlayerPublicState, buildStateFor, metaString, INTEREST_CONFIG: IC } = T;

function mk(n) {
  const w = [], tok = [];
  const h = connect('h'); tok.push(hello(h)); h.emitMessage({ type: 'create_room', name: 'P0', maxPlayers: Math.max(2, n) });
  const code = h.lastOfType('room_created').code; w.push(h);
  for (let i = 1; i < n; i++) { const g = connect('g' + i); tok.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code, name: 'P' + i }); w.push(g); }
  for (let i = 1; i < n; i++) w[i].emitMessage({ type: 'player_ready' });
  h.emitMessage({ type: 'start_game' });
  const room = rooms[code];
  assert(room.started, 'room started');
  return { w, tok, room, code, p: (i) => room.players[tok[i]] };
}
function snap(room) { const full = {}, sigs = {}; for (const t of room.order) { const p = room.players[t]; if (!p) continue; full[t] = buildPlayerPublicState(room, p); sigs[t] = metaString(full[t]); } return { full, sigs }; }
function place(m, i, x, z) { const p = m.p(i); p.x = x; p.z = z; p.y = 1.6; }
const isPosOnly = (e) => e && !('name' in e) && 'x' in e;

test('interest: first state for a recipient carries full meta for every player (new/reconnected socket)', () => {
  const m = mk(3); place(m, 0, 0, 0); place(m, 1, 10, 0); place(m, 2, 50, 0);
  const { full, sigs } = snap(m.room); const msg = buildStateFor(m.room, m.tok[0], full, sigs, 1);
  for (let i = 0; i < 3; i++) assert(msg.players[m.tok[i]] && typeof msg.players[m.tok[i]].name === 'string', 'full entry for player ' + i);
  assert(Array.isArray(msg.roster) && msg.roster.length === 3, 'roster present on first message'); T.shutdownAllRooms();
});

test('interest: near player gets a position EVERY tick; far player is thinned but never starved', () => {
  const m = mk(3); place(m, 0, 0, 0); place(m, 1, 10, 0); place(m, 2, -90, 0); // 10 = near, 90 = far
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1); // prime: meta delivered
  let near = 0, far = 0, maxGapFar = 0, gap = 0; const N = 60;
  for (let t = 2; t < 2 + N; t++) {
    const msg = buildStateFor(m.room, m.tok[0], full, sigs, t); // (t % metaResyncTicks hits are full entries: still positions)
    if (msg.players[m.tok[1]]) near++; if (msg.players[m.tok[2]]) { far++; gap = 0; } else { gap++; maxGapFar = Math.max(maxGapFar, gap); }
  }
  assertEqual(near, N, 'near player updated every tick'); assert(far > 0 && far < N, 'far thinned: ' + far + '/' + N); assert(maxGapFar < IC.farEvery, 'far player never silent for >= farEvery ticks (gap ' + maxGapFar + ')'); T.shutdownAllRooms();
});

test('interest: mid distance updates every midEvery ticks', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, 45, 0);
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1);
  let got = 0; for (let t = 2; t < 2 + 20; t++) if (buildStateFor(m.room, m.tok[0], full, sigs, t).players[m.tok[1]]) got++;
  assert(got >= 9 && got <= 11, 'about half the ticks: ' + got); T.shutdownAllRooms();
});

test('interest: a meta change (health/alive/cosmetic) reaches a FAR recipient on the very next tick, not delayed by distance', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, -100, 0);
  let { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1);
  m.p(1).health = 37; m.p(1).alive = false; ({ full, sigs } = snap(m.room));
  for (let t = 2; t < 2 + IC.farEvery; t++) { // whichever phase this tick has, a changed signature forces a full entry
    const msg = buildStateFor(m.room, m.tok[0], full, sigs, t);
    if (t === 2) { const e = msg.players[m.tok[1]]; assert(e && e.health === 37 && e.alive === false, 'change delivered immediately'); }
  } T.shutdownAllRooms();
});

test('interest: unchanged meta is NOT resent between resyncs (position-only entries are small), then resynced', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, 5, 0);
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1);
  const e = buildStateFor(m.room, m.tok[0], full, sigs, 2).players[m.tok[1]]; assert(isPosOnly(e), 'position-only entry'); assert(JSON.stringify(e).length < 90, 'compact: ' + JSON.stringify(e).length);
  const r = buildStateFor(m.room, m.tok[0], full, sigs, IC.metaResyncTicks).players[m.tok[1]]; assert(r && typeof r.name === 'string', 'periodic full-meta resync'); T.shutdownAllRooms();
});

test('interest: own entry is always complete (weaponId/slot/cosmetics + position)', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, 5, 0);
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1);
  const me = buildStateFor(m.room, m.tok[0], full, sigs, 2).players[m.tok[0]];
  for (const k of ['name', 'x', 'z', 'weaponId', 'slot', 'health', 'alive']) assert(k in me, 'own entry has ' + k); T.shutdownAllRooms();
});

test('interest: a dead (spectating) recipient gets full rate even for far players', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, -100, 0); m.p(0).alive = false;
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1);
  for (let t = 2; t < 20; t++) assert(buildStateFor(m.room, m.tok[0], full, sigs, t).players[m.tok[1]], 'tick ' + t + ' has the far player'); T.shutdownAllRooms();
});

test('interest: roster drops a removed player immediately; periodic roster resync', () => {
  const m = mk(3); place(m, 0, 0, 0); place(m, 1, 5, 0); place(m, 2, 6, 0);
  let { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1);
  assert(!buildStateFor(m.room, m.tok[0], full, sigs, 2).roster, 'no roster when unchanged');
  assert(buildStateFor(m.room, m.tok[0], full, sigs, IC.rosterResyncTicks).roster, 'periodic roster');
  const gone = m.tok[2]; T.removePlayerFromRoom(m.room, gone, 'test'); ({ full, sigs } = snap(m.room));
  const msg = buildStateFor(m.room, m.tok[0], full, sigs, 3); assert(msg.roster && !msg.roster.includes(gone) && msg.roster.length === 2, 'roster without removed player'); T.shutdownAllRooms();
});

test('interest: a new socket for the same token (reconnect) gets a full snapshot again', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, 5, 0);
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1); assert(isPosOnly(buildStateFor(m.room, m.tok[0], full, sigs, 2).players[m.tok[1]]), 'steady state is delta');
  const a2 = connect('a2'); a2.emitMessage({ type: 'hello', token: m.tok[0] });
  const msg = buildStateFor(m.room, m.tok[0], full, sigs, 3); const e = msg.players[m.tok[1]]; assert(e && typeof e.name === 'string' && msg.roster, 'full meta + roster for the new socket'); T.shutdownAllRooms();
});

test('interest: a game (re)start resets what each recipient was told (client rebuilds its scene)', () => {
  const m = mk(2); place(m, 0, 0, 0); place(m, 1, 5, 0);
  const { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1); assert(isPosOnly(buildStateFor(m.room, m.tok[0], full, sigs, 2).players[m.tok[1]]));
  m.room.interestEpoch++; const e = buildStateFor(m.room, m.tok[0], full, sigs, 3).players[m.tok[1]]; assert(typeof e.name === 'string', 'epoch bump forces full meta'); T.shutdownAllRooms();
});

test('interest: ROOM ISOLATION — a recipient never receives another room\'s tokens, even when positions overlap', () => {
  const A = mk(2), B = mk(2); [A, B].forEach((m) => { place(m, 0, 0, 0); place(m, 1, 5, 0); });
  const { full, sigs } = snap(A.room); const msg = buildStateFor(A.room, A.tok[0], full, sigs, 1);
  for (const t of Object.keys(msg.players).concat(msg.roster)) assert(!B.tok.includes(t), 'foreign token leaked'); T.shutdownAllRooms();
});

test('interest: disabled flag restores the legacy full-state-every-tick behaviour', () => {
  const m = mk(3); place(m, 0, 0, 0); place(m, 1, 5, 0); place(m, 2, -100, 0); IC.enabled = false;
  try { const { full, sigs } = snap(m.room); for (let t = 1; t < 8; t++) { const msg = buildStateFor(m.room, m.tok[0], full, sigs, t); assertEqual(Object.keys(msg.players).length, 3, 'all players every tick'); assert(msg.roster, 'roster every tick'); } }
  finally { IC.enabled = true; } T.shutdownAllRooms();
});

test('interest: the interest code does not touch combat events (static source check)', () => {
  const m = mk(2);
  // Static proof only (a real shoot may be rejected by validation, so a behavioural check would be flaky):
  // the interest code never sends or filters combat events; those keep using the unfiltered broadcastRoom path.
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const tickBlock = src.slice(src.indexOf('function buildStateFor'), src.indexOf('}, 66);'));
  assert(!/broadcastRoom\(room, \{ type: '(shoot|damage|kill|respawn|you_died)/.test(tickBlock), 'interest code does not touch combat events'); T.shutdownAllRooms();
});

test('interest: through the REAL tick, steady-state bytes per recipient are far below the legacy full-state size', async () => {
  const m = mk(8); m.room.order.forEach((t, i) => { const a = i / 8 * Math.PI * 2; place(m, i, Math.cos(a) * 30, Math.sin(a) * 30); });
  m.w.forEach((w) => { w.sent.length = 0; });
  await new Promise((r) => setTimeout(r, 1200));
  const states = m.w[0].allOfType('state'); assert(states.length >= 10, 'ticks arrived: ' + states.length);
  const steady = states.slice(3).map((s) => JSON.stringify(s).length).reduce((a, b) => a + b, 0) / (states.length - 3);
  const legacy = JSON.stringify({ type: 'state', players: Object.fromEntries(m.room.order.map((t) => [t, buildPlayerPublicState(m.room, m.room.players[t])])) }).length;
  assert(steady < legacy * 0.6, 'steady ' + Math.round(steady) + ' B vs legacy ' + legacy + ' B'); T.shutdownAllRooms();
});

test('interest: client handler tolerates partial ticks (static source check — real browser NOT VERIFIED)', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const blk = src.slice(src.indexOf("msg.type === 'state'"), src.indexOf("msg.type === 'shoot'"));
  assert(/Array\.isArray\(msg\.roster\)/.test(blk), 'removal gated on roster'); assert(!/if \(!msg\.players\[id\]\) removeRemotePlayer/.test(blk), 'no removal-by-absence');
  assert(/typeof p\.name === 'string'/.test(blk) && /if \(!hasMeta\) continue;/.test(blk), 'meta fields only applied from meta-bearing entries');
});

test('interest (Phase 3): a token that LEAVES and later comes back with an unchanged meta signature is sent in full again (client removed it on the roster)', () => {
  const m = mk(3); place(m, 0, 0, 0); place(m, 1, 5, 0); place(m, 2, 6, 0);
  let { full, sigs } = snap(m.room); buildStateFor(m.room, m.tok[0], full, sigs, 1); assert(isPosOnly(buildStateFor(m.room, m.tok[0], full, sigs, 2).players[m.tok[2]]), 'steady state is delta');
  const gone = m.tok[2]; const savedP = m.room.players[gone]; const idx = m.room.order.indexOf(gone);
  delete m.room.players[gone]; m.room.order.splice(idx, 1); ({ full, sigs } = snap(m.room)); const lm = buildStateFor(m.room, m.tok[0], full, sigs, 3); assert(!lm.roster.includes(gone), 'roster without it');
  m.room.players[gone] = savedP; m.room.order.push(gone); ({ full, sigs } = snap(m.room)); const back = buildStateFor(m.room, m.tok[0], full, sigs, 4).players[gone];
  assert(back && typeof back.name === 'string', 'full entry (with meta) when it comes back, not a position-only one'); T.shutdownAllRooms();
});
