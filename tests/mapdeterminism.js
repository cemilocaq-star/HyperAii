// Map determinism + client/server geometry parity.
// Risk being closed: forest/house decoration was Math.random() per client, and the client never loaded the shared purple layout (random boxes, no collision),
// while the server enforced the real layout (IN_OBSTACLE rejections, LOS, spawns, projectiles). Static client checks read public/index.html: they are NOT a browser test.
const fs = require('fs');
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const startServer = require(path.join(__dirname, '..', 'server.js'));
const T = startServer.__test__;
const BBMaps = require(path.join(__dirname, '..', 'public', 'maplayouts.js'));
const ROOT = path.join(__dirname, '..', 'public');
const CLIENT = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('prng: same seed -> identical sequence, different seed -> different sequence, values in [0,1), invalid seeds are safe', () => {
  const a = BBMaps.makeRng(12345), b = BBMaps.makeRng(12345), c = BBMaps.makeRng(12346); const sa = [], sb = [], sc = [];
  for (let i = 0; i < 200; i++) { sa.push(a()); sb.push(b()); sc.push(c()); }
  assertEqual(JSON.stringify(sa), JSON.stringify(sb), 'identical for identical seeds'); assert(JSON.stringify(sa) !== JSON.stringify(sc), 'different seeds differ'); assert(sa.every((x) => x >= 0 && x < 1), 'range');
  assertEqual(BBMaps.makeRng(0)(), BBMaps.makeRng(NaN)(), 'NaN seed behaves like 0'); assertEqual(BBMaps.makeRng(1.9)(), BBMaps.makeRng(1)(), 'fractional seed is floored'); for (const bad of [undefined, null, 'x', Infinity, {}, []]) assert(Number.isFinite(BBMaps.makeRng(bad)()), 'no crash on ' + String(bad));
  const mean = sa.reduce((s, x) => s + x, 0) / sa.length; assert(mean > 0.4 && mean < 0.6, 'roughly uniform: mean ' + mean.toFixed(3));
  // pinned golden values: the generator must produce the SAME numbers on every machine/version (this is what keeps clients in agreement)
  const g = BBMaps.makeRng(1); assertEqual(g().toFixed(6), '0.627074'); assertEqual(g().toFixed(6), '0.002736');
});
test('scatterPlan: same (map, seed) -> byte-identical plan; a different seed changes it; unknown maps give no props', () => {
  for (const map of ['forest', 'house']) {
    const p1 = BBMaps.scatterPlan(map, 777), p2 = BBMaps.scatterPlan(map, 777), p3 = BBMaps.scatterPlan(map, 778);
    assertEqual(JSON.stringify(p1), JSON.stringify(p2), map + ' deterministic'); assert(JSON.stringify(p1) !== JSON.stringify(p3), map + ' seed matters'); assert(p1.length > 40, map + ' has props: ' + p1.length);
  }
  for (const bad of ['purple', 'nope', '', undefined, null, '__proto__', 'constructor', 'toString', 7]) assertEqual(BBMaps.scatterPlan(bad, 1).length, 0, 'no props for ' + String(bad));
});
test('scatterPlan: every prop obeys its group recipe (url set, scale range, spread, rotation) and every referenced model file really exists', () => {
  for (const map of Object.keys(BBMaps.SCATTER)) {
    const rec = BBMaps.SCATTER[map], plan = BBMaps.scatterPlan(map, 424242); assertEqual(plan.length, rec.groups.reduce((n, g) => n + g.count, 0), map + ' total count = sum of group counts');
    let k = 0; for (const g of rec.groups) for (let i = 0; i < g.count; i++, k++) { const it = plan[k];
      assert(g.urls.includes(it.url), map + ' url in group'); assert(it.scale >= g.scale[0] - 1e-9 && it.scale <= g.scale[1] + 1e-9, map + ' scale'); assert(Math.abs(it.x) <= g.spread / 2 && Math.abs(it.z) <= g.spread / 2, map + ' inside the spread');
      assert(it.rotY >= 0 && it.rotY < Math.PI * 2 + 1e-9, map + ' rotation'); assert(Number.isFinite(it.x) && Number.isFinite(it.z) && Number.isFinite(it.scale), map + ' finite'); }
    for (const g of rec.groups) for (const u of g.urls) assert(fs.existsSync(path.join(ROOT, u)), map + ': model file missing on disk: ' + u);
    const half = rec.groupsGround; // (not used) the spread of every group must fit inside the playable ground
    for (const g of rec.groups) assert(g.spread / 2 <= rec.groundSize / 2, map + ' spread fits the ground');
  }
});
test('server: every room gets ONE authoritative integer seed (in room_state, game_started and the rejoin game_started); clients cannot choose it; rooms differ', () => {
  const seeds = new Set(); let first = null;
  for (let i = 0; i < 12; i++) { const a = connect('a' + i); hello(a); a.emitMessage({ type: 'create_room', maxPlayers: 4, mapSeed: 5, seed: 5 }); const code = a.lastOfType('room_created').code; const r = T.rooms[code];
    assert(Number.isInteger(r.mapSeed) && r.mapSeed >= 1 && r.mapSeed < 0x7fffffff, 'valid seed ' + r.mapSeed); assert(r.mapSeed !== 5, 'a client-supplied seed is ignored'); seeds.add(r.mapSeed); if (!first) first = { a, code, r }; }
  assert(seeds.size >= 11, 'seeds differ between rooms (' + seeds.size + ' distinct of 12)');
  const { a, code, r } = first; const b = connect('b'); const bt = hello(b); b.emitMessage({ type: 'join_room', roomCode: code, name: 'B' }); b.emitMessage({ type: 'player_ready' });
  const saved = T.MATCH_CONFIG.countdownMs; T.MATCH_CONFIG.countdownMs = 0; try { a.emitMessage({ type: 'start_game' }); } finally { T.MATCH_CONFIG.countdownMs = saved; }
  assertEqual(b.lastOfType('game_started').mapSeed, r.mapSeed, 'game_started carries the room seed to every player'); assertEqual(T.roomStatePayload(r).mapSeed, r.mapSeed, 'room_state carries it (late joiners)');
  r.players[bt].connected = false; const b2 = connect('b2'); b2.emitMessage({ type: 'hello', token: bt }); const rj = b2.lastOfType('game_started'); assert(rj && rj.rejoin === true, 'rejoin game_started'); assertEqual(rj.mapSeed, r.mapSeed, 'a reconnecting client gets the SAME seed -> same decoration');
  T.endMatch(r, 'TIME'); a.emitMessage({ type: 'rematch' }); assertEqual(r.mapSeed, rj.mapSeed, 'rematch keeps the room map unchanged'); T.shutdownAllRooms();
});
test('server: quick-play rooms get a seed too', () => {
  const q = connect('q'); hello(q); q.emitMessage({ type: 'quick_play', name: 'Q' }); const room = Object.values(T.rooms).find((r) => r.isPublic); assert(room && Number.isInteger(room.mapSeed), 'quick play room has a seed'); T.shutdownAllRooms();
});
test('parity: the client loads the SAME shared module as the server, builds purple from its layout (no random boxes) and collides with it', () => {
  const srcIdx = CLIENT.indexOf('<script src="maplayouts.js"></script>'); assert(srcIdx > 0, 'maplayouts.js is loaded by the client'); assert(srcIdx < CLIENT.indexOf('<script>\n'), 'and before the main inline script that uses BBMaps');
  const purple = CLIENT.slice(CLIENT.indexOf('function buildPurpleMap'), CLIENT.indexOf('function buildForestMap')); assert(/BBMaps\.layouts\.purple/.test(purple) && /L\.obstacles/.test(purple) && !/Math\.random/.test(purple), 'purple from the shared layout');
  assert(/const r = BBMaps\.resolveCircle\(camera\.position\.x, camera\.position\.z, BBMaps\.PLAYER_R, currentLayout\); camera\.position\.x = r\[0\]; camera\.position\.z = r\[1\];/.test(CLIENT), 'client movement collides with the layout AND applies the resolved position to the camera'); assert(/currentLayout = BBMaps\.layouts\[mapName\] \|\| null/.test(CLIENT), 'forest/house: null layout = no collision, same as the server');
});
test('parity: forest/house decoration is built ONLY from the seeded plan — no Math.random anywhere in the map-building code', () => {
  const blk = CLIENT.slice(CLIENT.indexOf('function placeScatterPlan'), CLIENT.indexOf('function startGame') > 0 ? CLIENT.indexOf('function buildHouseMap') + 1200 : undefined);
  const maps = CLIENT.slice(CLIENT.indexOf('function placeScatterPlan'), CLIENT.indexOf('function buildHouseMap') + 900); assert(!/Math\.random/.test(maps), 'no Math.random in placeScatterPlan/buildMapContent/buildPurpleMap/buildForestMap/buildHouseMap');
  assert(/BBMaps\.scatterPlan\(mapName, seed\)/.test(CLIENT) && /placeScatterPlan\('forest', seed\)/.test(CLIENT) && /placeScatterPlan\('house', seed\)/.test(CLIENT), 'both maps use the plan'); assert(!/function scatterModels/.test(CLIENT), 'the random scatter function is gone');
  assert(/startGame\(msg\.map, msg\.mapSeed\)/.test(CLIENT) && /initScene\(mapName, mapSeed\)/.test(CLIENT) && /buildMapContent\(mapName \|\| 'purple', mapSeed\)/.test(CLIENT), 'the server seed reaches the builders');
});
test('parity invariant: a position the CLIENT collision leaves a player in is NEVER one the SERVER rejects as IN_OBSTACLE (no rubber-banding into invisible walls)', () => {
  const L = BBMaps.layouts.purple; let checked = 0, pushed = 0;
  for (let x = -40; x <= 40; x += 0.37) for (let z = -40; z <= 40; z += 0.37) {
    const r = BBMaps.resolveCircle(x, z, BBMaps.PLAYER_R, L); checked++; if (Math.abs(r[0] - x) > 1e-9 || Math.abs(r[1] - z) > 1e-9) pushed++;
    assert(!BBMaps.pointBlocked(r[0], r[1], BBMaps.SERVER_R, L), 'client end position (' + r.map((v) => v.toFixed(3)) + ') from (' + x.toFixed(2) + ',' + z.toFixed(2) + ') is inside server geometry');
  }
  assert(pushed > 500, 'the grid really exercised the walls: ' + pushed + ' of ' + checked + ' points were pushed out'); assertEqual(BBMaps.resolveCircle(3, 4, 0.4, null).join(), '3,4', 'null layout = no-op');
  assert(BBMaps.PLAYER_R > BBMaps.SERVER_R, 'the client is stricter than the server by design');
});
test('parity: every purple spawn point is walkable for BOTH sides (client radius and server radius)', () => {
  const L = BBMaps.layouts.purple; assert(L.spawns.length >= 4, 'spawns'); for (const s of L.spawns) { assert(!BBMaps.pointBlocked(s.x, s.z, BBMaps.PLAYER_R, L), 'spawn inside client collision: ' + JSON.stringify(s)); const r = BBMaps.resolveCircle(s.x, s.z, BBMaps.PLAYER_R, L); assert(Math.abs(r[0] - s.x) < 1e-9 && Math.abs(r[1] - s.z) < 1e-9, 'spawn is not pushed'); }
});
