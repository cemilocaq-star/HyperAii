// Offline logic test harness for badimcan-bendeler server.js
//
// Why this exists: the project shipped with no test files at all (README
// claimed "50/50 PASS" but no test suite was present in the repo). This
// harness drives the real wss 'connection'/'message' handlers in server.js
// through fake WebSocket objects (via node_modules/ws + node_modules/express
// stubs, since this sandbox has no network access for npm install), so the
// actual server logic executes on every test, not a re-implementation of it.
//
// Run: node tests/run.js

const path = require('path');
const os = require('os');
const fs = require('fs');
// Tests must never touch the real data/unlocks.json: point persistence at a
// throwaway temp file BEFORE server.js is loaded.
process.env.BB_UNLOCKS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-unlocks-')), 'unlocks.json');
// Offline harness: 'express' and 'ws' are replaced by tiny in-memory stubs
// (tests/stubs) ONLY inside this test process, so the real server.js logic runs
// with fake sockets and no network, and nothing fake ever sits in the project's
// own node_modules (which `npm install` / `npm start` must use for real).
const Module = require('module');
const STUBS = path.join(__dirname, 'stubs', 'node_modules');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'express' || request === 'ws') return origLoad.call(this, path.join(STUBS, request), parent, isMain);
  return origLoad.apply(this, arguments);
};
const startServer = require(path.join(__dirname, '..', 'server.js'));
const { wss, rooms, HIT_CONFIG } = startServer.__test__;
// Deterministic combat for tests: no fire-rate cap, no random crits.
// (Phase 4 has its own tests that override these explicitly.)
HIT_CONFIG.minIntervalMs = 0;
HIT_CONFIG.rng = () => 0.99;
// Legacy suites (Phase 4-21) send bare {type:'hit', targetId} packets. The aim-ray
// check (Phase 22) is exercised explicitly, with requireAim=true, in tests/security22.js.
HIT_CONFIG.requireAim = false;
// Snapshot of exactly what the harness changed, so tests/prodconfig22.js can prove nothing else
// (and nothing after the suite) drifts. Values only; functions are compared by reference.
// Match countdown (production default 3000 ms, proven in a fresh process by tests/match.js) is disabled here so legacy
// suites can fight right after start_game; tests/match.js exercises the real countdown explicitly.
startServer.__test__.MATCH_CONFIG.countdownMs = 0;
// Shared map geometry (spawn layout, wall rejection, hit line-of-sight) is production-on; legacy suites assume the old
// random spawns/free coordinates, so it is OFF in this process only. tests/map.js enables it explicitly and proves the default.
startServer.__test__.GEOMETRY_CONFIG.enabled = false;
const HARNESS_HIT_BASELINE = { ...HIT_CONFIG };

let passed = 0;
let failed = 0;
const failures = [];
const pending = []; // {name, fn} — run sequentially (supports async tests that use real timers)

function test(name, fn) {
  pending.push({ name, fn });
}

async function runPending() {
  for (const { name, fn } of pending) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, err });
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ---- Fake WebSocket -------------------------------------------------
class FakeWs {
  constructor(label) {
    this.label = label || 'ws';
    this.readyState = 1; // WebSocket.OPEN
    this.sent = [];
    this._handlers = {};
  }
  on(evt, cb) { this._handlers[evt] = cb; return this; }
  send(data) { this.sent.push(JSON.parse(data)); }
  emitMessage(obj) { this._handlers['message'] && this._handlers['message'](JSON.stringify(obj)); }
  emitClose() { this._handlers['close'] && this._handlers['close'](); }
  lastOfType(type) {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === type) return this.sent[i];
    return null;
  }
  allOfType(type) { return this.sent.filter((m) => m.type === type); }
}

function connect(label) {
  const ws = new FakeWs(label);
  wss.emit('connection', ws);
  return ws;
}

function hello(ws, token) {
  ws.emitMessage({ type: 'hello', token });
  const ok = ws.lastOfType('hello_ok');
  return ok.token;
}

// ======================================================================
// BASELINE — pre-existing behavior (room/lobby, combat, dash, cosmetics,
// chaos structure). These re-establish, with real executed tests, what the
// README asserted was "50/50 PASS" with no test file to back it up.
// ======================================================================

test('hello issues a token', () => {
  const ws = connect('a');
  const token = hello(ws);
  assert(typeof token === 'string' && token.length > 8, 'expected a real token');
});

test('create_room returns a unique 6-char code', () => {
  const ws = connect('a');
  const token = hello(ws);
  ws.emitMessage({ type: 'create_room', name: 'Host', maxPlayers: 4 });
  const created = ws.lastOfType('room_created');
  assert(created && /^[A-Z0-9]{6}$/.test(created.code), 'expected 6-char code');
});

test('join_room: second player joins host room', () => {
  const host = connect('host');
  hello(host);
  host.emitMessage({ type: 'create_room', name: 'Host', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;

  const guest = connect('guest');
  hello(guest);
  guest.emitMessage({ type: 'join_room', roomCode: code, name: 'Guest' });
  const joined = guest.lastOfType('room_joined');
  assertEqual(joined.code, code, 'guest should join same room');
});

test('join_room: wrong code -> NOT_FOUND', () => {
  const ws = connect('a');
  hello(ws);
  ws.emitMessage({ type: 'join_room', roomCode: 'ZZZZZZ' });
  assertEqual(ws.lastOfType('join_error').reason, 'NOT_FOUND');
});

test('join_room: full room -> FULL', () => {
  // server clamps maxPlayers to a minimum of 2 (Math.max(2, ...)), so a
  // "full" room here is host + 1 guest at the clamped max of 2.
  const host = connect('host');
  hello(host);
  host.emitMessage({ type: 'create_room', name: 'Host', maxPlayers: 1 });
  const code = host.lastOfType('room_created').code;
  assertEqual(rooms[code].maxPlayers, 2, 'server clamps maxPlayers to a floor of 2');

  const guest1 = connect('guest1');
  hello(guest1);
  guest1.emitMessage({ type: 'join_room', roomCode: code });
  assert(guest1.lastOfType('room_joined'), 'room has space for guest1');

  const guest2 = connect('guest2');
  hello(guest2);
  guest2.emitMessage({ type: 'join_room', roomCode: code });
  assertEqual(guest2.lastOfType('join_error').reason, 'FULL');
});

test('only host can start_game', () => {
  const host = connect('host'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  const guest = connect('guest'); hello(guest);
  guest.emitMessage({ type: 'join_room', roomCode: code });
  guest.emitMessage({ type: 'player_ready' });
  guest.emitMessage({ type: 'start_game' }); // not host, ignored
  assert(!rooms[code].started, 'non-host start_game must be ignored');
  host.emitMessage({ type: 'start_game' });
  assert(rooms[code].started, 'host start_game must start the room');
});

test('start_game rejected when not everyone ready', () => {
  const host = connect('host'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  const guest = connect('guest'); hello(guest);
  guest.emitMessage({ type: 'join_room', roomCode: code });
  host.emitMessage({ type: 'start_game' });
  assertEqual(host.lastOfType('start_rejected').reason, 'NOT_ALL_READY');
});

test('host disconnect triggers immediate host migration', () => {
  const host = connect('host'); hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  const guest = connect('guest'); hello(guest);
  guest.emitMessage({ type: 'join_room', roomCode: code });
  const guestToken = rooms[code].order[1];
  host.emitClose();
  assertEqual(rooms[code].hostToken, guestToken, 'guest should become host immediately');
});

test('hit reduces health; lethal hit triggers kill+respawn broadcast', () => {
  const host = connect('host'); const hostTok = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  const guest = connect('guest'); const guestTok = hello(guest);
  guest.emitMessage({ type: 'join_room', roomCode: code });
  guest.emitMessage({ type: 'player_ready' });
  host.emitMessage({ type: 'start_game' });

  // CHANGED in Phase 4: server owns damage (25 base); client 'damage' is ignored.
  host.emitMessage({ type: 'hit', targetId: guestTok, damage: 40 });
  assertEqual(rooms[code].players[guestTok].health, 75, 'non-lethal hit reduces health by server damage (25), not client-sent 40');
  assert(guest.lastOfType('damage'), 'target should get a damage message');

  // Phase 10: game start now sends each player a 'respawn' (their real spawn),
  // so compare against the count from before the lethal hit.
  const respawnsBefore = guest.allOfType('respawn').length;
  for (let i = 0; i < 3; i++) host.emitMessage({ type: 'hit', targetId: guestTok, damage: 100 });
  // CHANGED in Phase 1 (spectator mode): a lethal hit used to respawn the
  // victim instantly (health snapped back to 100 in the same tick). Now the
  // victim enters a dead/spectating window and only actually respawns after
  // RESPAWN_DELAY_MS — see tests/spectator.js for the respawn-timer test.
  assertEqual(rooms[code].players[guestTok].health, 0, 'victim health is 0 immediately after a lethal hit');
  assertEqual(rooms[code].players[guestTok].alive, false, 'victim should not be alive yet (spectator window)');
  assertEqual(rooms[code].players[guestTok].deaths, 1);
  assertEqual(rooms[code].players[hostTok].kills, 1);
  assert(guest.lastOfType('kill'), 'kill message should be broadcast');
  assert(guest.lastOfType('you_died'), 'victim should be told to enter spectator mode');
  assertEqual(guest.allOfType('respawn').length, respawnsBefore, 'no NEW respawn right after death (that is the whole point of Phase 1)');
});

test('dash: first request ok, immediate second rejected (cooldown)', () => {
  const host = connect('host'); const hostTok = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  host.emitMessage({ type: 'player_ready' });
  rooms[code].players[hostTok].ready = true;
  host.emitMessage({ type: 'start_game' });

  host.emitMessage({ type: 'dash_request', dir: { x: 1, z: 0 } });
  assert(host.lastOfType('dash_ok'), 'first dash should be allowed');
  host.emitMessage({ type: 'dash_request', dir: { x: 1, z: 0 } });
  assertEqual(host.lastOfType('dash_rejected').reason, 'COOLDOWN');
});

test('locked cosmetic equip is rejected', () => {
  const host = connect('host'); const tok = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = host.lastOfType('room_created').code;
  host.emitMessage({ type: 'equip_cosmetic', cosmeticId: 'accessoryHalo' });
  assertEqual(host.lastOfType('equip_rejected').reason, 'LOCKED');
});

test('chaos registry: the 3 original events are unchanged (order + probabilities), plus registered extensions; each with start/end/probability', () => {
  const { RandomEventRegistry } = startServer.__test__;
  const keys = Object.keys(RandomEventRegistry);
  assertEqual(keys.slice(0, 3).join(','), 'pinkPop,duckWeapon,greenOgre', 'original events must stay first and in order');
  assertEqual([0, 1, 2].map((i) => RandomEventRegistry[keys[i]].probability).join(','), '0.1,0.05,0.07', 'original probabilities must not change');
  assertEqual(keys.slice(3).join(','), 'banana_weapon', 'only the documented extension events are registered');
  for (const k of keys) {
    const ev = RandomEventRegistry[k];
    assert(typeof ev.start === 'function' && typeof ev.end === 'function', `${k} missing start/end`);
    assert(typeof ev.probability === 'number', `${k} missing probability`);
  }
});

module.exports = { test, assert, assertEqual, connect, hello, FakeWs, HARNESS_HIT_BASELINE, get results() { return { passed, failed, failures }; } };

if (require.main === module) {
  // Load phase test files if present (kept separate so each phase's tests
  // can be reviewed/run independently too: node tests/spectator.js).
  try { require('./spectator.js'); } catch (e) { console.log('spectator.js failed to load:', e.message); }
  try { require('./ping.js'); } catch (e) { console.log('ping.js failed to load:', e.message); }
  try { require('./hitfeedback.js'); } catch (e) { console.log('hitfeedback.js failed to load:', e.message); }
  try { require('./damagenumbers.js'); } catch (e) { console.log('damagenumbers.js failed to load:', e.message); }
  try { require('./emotes.js'); } catch (e) { console.log('emotes.js failed to load:', e.message); }
  try { require('./customization.js'); } catch (e) { console.log('customization.js failed to load:', e.message); }
  try { require('./chaos.js'); } catch (e) { console.log('chaos.js failed to load:', e.message); }
  try { require('./cosmeticsystems.js'); } catch (e) { console.log('cosmeticsystems.js failed to load:', e.message); }
  try { require('./movement.js'); } catch (e) { console.log('movement.js failed to load:', e.message); }
  try { require('./uilayout.js'); } catch (e) { console.log('uilayout.js failed to load:', e.message); }
  try { require('./checklist.js'); } catch (e) { console.log('checklist.js failed to load:', e.message); }
  try { require('./finalaudit.js'); } catch (e) { console.log('finalaudit.js failed to load:', e.message); }
  try { require('./roomfirst.js'); } catch (e) { console.log('roomfirst.js failed to load:', e.message); }
  try { require('./social.js'); } catch (e) { console.log('social.js failed to load:', e.message); }
  try { require('./animation.js'); } catch (e) { console.log('animation.js failed to load:', e.message); }
  try { require('./settings.js'); } catch (e) { console.log('settings.js failed to load:', e.message); }
  try { require('./security22.js'); } catch (e) { console.log('security22.js failed to load:', e.message); }
  try { require('./clientlogic22.js'); } catch (e) { console.log('clientlogic22.js failed to load:', e.message); }
  try { require('./match.js'); } catch (e) { console.log('match.js failed to load:', e.message); }
  try { require('./weapons.js'); } catch (e) { console.log('weapons.js failed to load:', e.message); }
  try { require('./roomsettings.js'); } catch (e) { console.log('roomsettings.js failed to load:', e.message); }
  try { require('./banana.js'); } catch (e) { console.log('banana.js failed to load:', e.message); }
  try { require('./assets.js'); } catch (e) { console.log('assets.js failed to load:', e.message); }
  try { require('./slots.js'); } catch (e) { console.log('slots.js failed to load:', e.message); }
  try { require('./mapdeterminism.js'); } catch (e) { console.log('mapdeterminism.js failed to load:', e.message); }
  try { require('./weaponvisual.js'); } catch (e) { console.log('weaponvisual.js failed to load:', e.message); }
  try { require('./bounty.js'); } catch (e) { console.log('bounty.js failed to load:', e.message); }
  try { require('./killcam.js'); } catch (e) { console.log('killcam.js failed to load:', e.message); }
  try { require('./sharedobj.js'); } catch (e) { console.log('sharedobj.js failed to load:', e.message); }
  try { require('./textures.js'); } catch (e) { console.log('textures.js failed to load:', e.message); }
  try { require('./weaponlife.js'); } catch (e) { console.log('weaponlife.js failed to load:', e.message); }
  try { require('./hitzones.js'); } catch (e) { console.log('hitzones.js failed to load:', e.message); }
  try { require('./wind.js'); } catch (e) { console.log('wind.js failed to load:', e.message); }
  try { require('./weaponmat.js'); } catch (e) { console.log('weaponmat.js failed to load:', e.message); }
  try { require('./uvgen.js'); } catch (e) { console.log('uvgen.js failed to load:', e.message); }
  try { require('./glslreport.js'); } catch (e) { console.log('glslreport.js failed to load:', e.message); }
  try { require('./gltfmat.js'); } catch (e) { console.log('gltfmat.js failed to load:', e.message); }
  try { require('./gfx.js'); } catch (e) { console.log('gfx.js failed to load:', e.message); }
  try { require('./interest.js'); } catch (e) { console.log('interest.js failed to load:', e.message); }
  try { require('./prodconfig22.js'); } catch (e) { console.log('prodconfig22.js failed to load:', e.message); } // MUST stay last: it checks for config leaks from every suite above

  runPending().then(() => {
    console.log(`\n${passed}/${passed + failed} PASS`);
    if (failed) {
      console.log('\nFAILED:');
      for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
    }
    // server.js runs a module-scope setInterval (the ~15Hz state broadcast
    // loop) that keeps the event loop alive forever in-process; force exit
    // once tests are done so this harness terminates on its own.
    process.exit(failed ? 1 : 0);
  });
}
