// Phase 22 audit — PRODUCTION vs TEST separation.
//
// The legacy suites (Phase 4-21) need bare {type:'hit'} packets to work, so tests/run.js flips
// HIT_CONFIG.requireAim=false (plus minIntervalMs=0 and a fixed rng) INSIDE THE TEST PROCESS.
// These tests prove that (1) `node server.js` in a normal process starts with the production
// values, (2) the harness override lives only in this process's module instance, (3) a brand
// new server instance created inside this very process still starts with production values,
// and (4) after every suite has run, nothing except the documented harness overrides drifted.
//
// This file is required LAST by tests/run.js so the leak check sees every earlier suite.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const S = require(path.join(__dirname, '..', 'server.js')).__test__;

const ROOT = path.join(__dirname, '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const SRC = fs.readFileSync(SERVER_PATH, 'utf8');

// Production defaults that must hold in any process that did not run the harness.
const PROD = {
  HIT: { requireAim: true, minIntervalMs: 80, baseDamage: 25, critChance: 0.1, maxRange: 150, shotWindowMs: 1000 },
  SHOOT: { minIntervalMs: 50 },
  PICKUP: { attemptCooldownMs: 250, respawnMs: 8000, count: 4 },
};

// ---------------------------------------------------------------- static source guarantees
test('p22 prodcfg: server.js declares requireAim:true in the HIT_CONFIG literal', () => {
  const lit = SRC.slice(SRC.indexOf('const HIT_CONFIG = {'), SRC.indexOf('};', SRC.indexOf('const HIT_CONFIG = {')));
  assert(/requireAim:\s*true\b/.test(lit), 'HIT_CONFIG literal must default requireAim to true');
  assert(!/requireAim:\s*false/.test(lit), 'HIT_CONFIG literal must never default requireAim to false');
});

test('p22 prodcfg: NO code path in server.js (or public/) can switch requireAim off — no assignment, no env/argv toggle', () => {
  assert(!/HIT_CONFIG\.requireAim\s*=[^=]/.test(SRC), 'server.js assigns HIT_CONFIG.requireAim');
  assert(!/requireAim/.test(SRC.replace(/^.*requireAim:\s*true.*$/m, '').replace(/^\s*\/\/.*requireAim.*$/gm, '').replace(/HIT_CONFIG\.requireAim\)/g, '')), 'unexpected extra requireAim reference in server.js');
  const envs = [...new Set([...SRC.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assertEqual(envs.join(','), 'BB_UNLOCKS_PATH,PORT', 'server.js reads an unexpected environment variable: ' + envs.join(','));
  assert(!/process\.argv/.test(SRC.replace(/\/\/.*$/gm, '')), 'server.js must not read argv for behavior switches');
  for (const f of ['main.js', 'public/index.html', 'public/settings.js', 'public/feedback.js', 'public/animstate.js']) {
    assert(!/requireAim/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), f + ' must not know about requireAim');
  }
});

test('p22 prodcfg: only tests/ ever reference requireAim=false, and only the documented harness line does so outside security22', () => {
  const offenders = [];
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js'))) {
    const txt = fs.readFileSync(path.join(__dirname, f), 'utf8');
    if (/requireAim\s*(=|:)\s*false/.test(txt)) offenders.push(f);
  }
  // run.js = process-wide harness override; security22.js = withCfg(..., requireAim:false) scoped + restored (legacy death-path test)
  // prodconfig22.js mentions it only inside assertions/regexes.
  assertEqual(offenders.filter((f) => !['run.js', 'security22.js', 'prodconfig22.js'].includes(f)).join(','), '', 'other test files flip requireAim=false');
});

// ---------------------------------------------------------------- real, separate process
function runChild(script, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-prodcfg-'));
  const r = spawnSync(process.execPath, ['-e', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 20000,
    // Offline stubs for express/ws only (same reason as the harness); NOTHING from tests/run.js is loaded.
    env: { ...process.env, NODE_PATH: path.join(__dirname, 'stubs', 'node_modules'), BB_UNLOCKS_PATH: path.join(tmp, 'unlocks.json'), ...extraEnv },
  });
  return r;
}

test('p22 prodcfg: a FRESH node process that never loaded the test harness starts with requireAim === true (and all other production defaults)', () => {
  const script = `
    const s = require(${JSON.stringify(SERVER_PATH)});
    const T = s.__test__;
    const before = Date.now(); const n = T.HIT_CONFIG.now(); const after = Date.now();
    console.log(JSON.stringify({
      hit: { requireAim: T.HIT_CONFIG.requireAim, minIntervalMs: T.HIT_CONFIG.minIntervalMs, baseDamage: T.HIT_CONFIG.baseDamage, critChance: T.HIT_CONFIG.critChance, maxRange: T.HIT_CONFIG.maxRange, shotWindowMs: T.HIT_CONFIG.shotWindowMs },
      rngIsMathRandom: T.HIT_CONFIG.rng === Math.random,
      clockIsReal: n >= before && n <= after,
      shoot: { minIntervalMs: T.SHOOT_CONFIG.minIntervalMs }, pickup: { attemptCooldownMs: T.PICKUP_CONFIG.attemptCooldownMs, respawnMs: T.PICKUP_CONFIG.respawnMs, count: T.PICKUP_CONFIG.count },
      pickupRngIsMathRandom: T.PICKUP_CONFIG.rng === Math.random,
      harnessLoaded: Object.keys(require.cache).some((k) => k.endsWith('tests/run.js') || k.endsWith('tests\\\\run.js')),
    }));
    process.exit(0);`;
  const r = runChild(script);
  assertEqual(r.status, 0, 'child failed: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assertEqual(out.harnessLoaded, false, 'child must not have loaded the harness');
  assertEqual(JSON.stringify(out.hit), JSON.stringify(PROD.HIT), 'production HIT_CONFIG defaults drifted');
  assertEqual(JSON.stringify(out.shoot), JSON.stringify(PROD.SHOOT)); assertEqual(JSON.stringify(out.pickup), JSON.stringify(PROD.PICKUP));
  assertEqual(out.rngIsMathRandom, true, 'production crit rng must be Math.random'); assertEqual(out.pickupRngIsMathRandom, true);
  assertEqual(out.clockIsReal, true, 'production hit clock must be the real clock');
});

test('p22 prodcfg: in that fresh production process an un-backed hit really is rejected end-to-end (behavior, not just config)', () => {
  const script = `
    const s = require(${JSON.stringify(SERVER_PATH)});
    const T = s.__test__; const EventEmitter = require('events');
    function mk() { const w = new EventEmitter(); w.readyState = 1; w.sent = []; w.send = (d) => w.sent.push(JSON.parse(d)); w.on = (e, cb) => { (w.h = w.h || {})[e] = cb; return w; };
                    T.wss.emit('connection', w); return w; }
    const msg = (w, o) => w.h.message(JSON.stringify(o));
    const a = mk(), b = mk(); msg(a, { type: 'hello' }); msg(b, { type: 'hello' });
    const ta = a.sent.find((m) => m.type === 'hello_ok').token, tb = b.sent.find((m) => m.type === 'hello_ok').token;
    msg(a, { type: 'create_room', maxPlayers: 4, name: 'A' }); const code = a.sent.find((m) => m.type === 'room_created').code;
    T.MATCH_CONFIG.countdownMs = 0; // only the (separately tested) match countdown is skipped; requireAim/minInterval/rng stay production
    msg(b, { type: 'join_room', roomCode: code, name: 'B' }); msg(b, { type: 'player_ready' }); msg(a, { type: 'start_game' });
    const room = T.rooms[code]; const pa = room.players[ta], pb = room.players[tb];
    // Fixture positions: the default map now has SERVER-known geometry (a 6x6 obstacle at the centre), so the old
    // (0,0)->(0,-10) line is correctly rejected by the server LOS check. Use two points in the open with a clear line.
    pa.x = 0; pa.y = 1.6; pa.z = 20; pb.x = 0; pb.y = 1.6; pb.z = 10;
    const aim = { origin: [0, 1.6, 20], dir: [0, 0, -1] };
    msg(a, { type: 'hit', targetId: tb, ...aim, damage: 999 });               // bare hit: no shoot behind it
    const bare = pb.health;
    msg(a, { type: 'shoot', ...aim }); msg(a, { type: 'hit', targetId: tb, ...aim }); // proper shoot -> hit
    console.log(JSON.stringify({ bare, afterProper: pb.health, requireAim: T.HIT_CONFIG.requireAim }));
    process.exit(0);`;
  const r = runChild(script);
  assertEqual(r.status, 0, 'child failed: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assertEqual(out.requireAim, true); assertEqual(out.bare, 100, 'production server applied an un-backed bare hit'); // production keeps the real Math.random crit roll (10%): a landed hit is 25 (health 75) or a crit 50 (health 50)
  assert(out.afterProper === 75 || out.afterProper === 50, 'production server must accept a proper shoot->hit, got health ' + out.afterProper);
});

// ---------------------------------------------------------------- harness override is process-local
test('p22 prodcfg: the harness override is real IN THIS process (documented) and is exactly requireAim=false/minIntervalMs=0/fixed rng', () => {
  const b = harness.HARNESS_HIT_BASELINE;
  assertEqual(b.requireAim, false); assertEqual(b.minIntervalMs, 0); assertEqual(b.rng(), 0.99);
  // everything else in HIT_CONFIG is still the production value
  for (const k of ['baseDamage', 'critChance', 'critMultiplier', 'maxRange', 'aimRadius', 'aimLagSlack', 'shotWindowMs', 'pairOriginTol', 'pairDirDot']) assert(k in b, 'missing ' + k);
  assertEqual(b.baseDamage, PROD.HIT.baseDamage); assertEqual(b.maxRange, PROD.HIT.maxRange); assertEqual(b.shotWindowMs, PROD.HIT.shotWindowMs);
});

// ---------------------------------------------------------------- new instance in the SAME process
test('p22 prodcfg: a brand-new server instance created inside the (harness-modified) process starts with production config and shares no state', () => {
  const cacheKey = require.resolve(SERVER_PATH);
  const savedEntry = require.cache[cacheKey];
  const savedInterval = global.setInterval; const captured = [];
  global.setInterval = function () { const h = savedInterval.apply(this, arguments); captured.push(h); return h; };
  let fresh;
  try {
    delete require.cache[cacheKey];
    fresh = require(SERVER_PATH).__test__;
  } finally {
    global.setInterval = savedInterval;
    captured.forEach((h) => clearInterval(h)); // the fresh instance's state-tick loop must not leak into this process
    require.cache[cacheKey] = savedEntry;       // every other suite keeps its original module instance
  }
  assert(fresh && fresh !== S, 'expected a separate module instance');
  assert(fresh.HIT_CONFIG !== S.HIT_CONFIG, 'HIT_CONFIG object is shared between instances');
  assert(fresh.rooms !== S.rooms, 'rooms are shared between instances');
  assertEqual(fresh.HIT_CONFIG.requireAim, true, 'new instance must start with requireAim === true');
  assertEqual(fresh.HIT_CONFIG.minIntervalMs, 80); assert(fresh.HIT_CONFIG.rng === Math.random, 'new instance must use Math.random');
  assertEqual(fresh.SHOOT_CONFIG.minIntervalMs, 50); assertEqual(fresh.PICKUP_CONFIG.respawnMs, 8000);
  // the process-wide harness instance was NOT touched by creating/inspecting the new one
  assertEqual(S.HIT_CONFIG.requireAim, harness.HARNESS_HIT_BASELINE.requireAim);
  assert(require(SERVER_PATH).__test__ === S, 'require cache must be restored to the original instance');
  assert(captured.length >= 1, 'expected the fresh instance to have created its tick interval (which we cleared)');
});

// ---------------------------------------------------------------- final leak check (runs last)
test('p22 prodcfg [LAST]: after every suite has run, no config drifted beyond the documented harness overrides', () => {
  const H = S.HIT_CONFIG, b = harness.HARNESS_HIT_BASELINE;
  for (const k of Object.keys(b)) {
    if (typeof b[k] === 'function') assert(H[k] === b[k], `HIT_CONFIG.${k} function was replaced and not restored`);
    else assertEqual(H[k], b[k], `HIT_CONFIG.${k} leaked from a test`);
  }
  assertEqual(Object.keys(H).sort().join(','), Object.keys(b).sort().join(','), 'HIT_CONFIG gained/lost keys during the run');
  // clock hooks must be the real clock again
  const t0 = Date.now(); const n1 = H.now(); const n2 = S.SHOOT_CONFIG.now(); const t1 = Date.now();
  assert(n1 >= t0 && n1 <= t1 && n2 >= t0 && n2 <= t1, 'a test left a frozen/fake clock installed');
  assertEqual(S.SHOOT_CONFIG.minIntervalMs, PROD.SHOOT.minIntervalMs, 'SHOOT_CONFIG.minIntervalMs leaked');
  for (const k of Object.keys(PROD.PICKUP)) assertEqual(S.PICKUP_CONFIG[k], PROD.PICKUP[k], `PICKUP_CONFIG.${k} leaked`);
  assert(S.PICKUP_CONFIG.rng === Math.random, 'PICKUP_CONFIG.rng leaked'); assertEqual(typeof S.PICKUP_CONFIG.now, 'function');
  const t2 = Date.now(); const pn = S.PICKUP_CONFIG.now(); assert(pn >= t2 - 5 && pn <= Date.now() + 5, 'PICKUP_CONFIG.now leaked');
  assertEqual(S.MAX_MESSAGE_BYTES, 32 * 1024);
  assert(S.getHandlerErrorCount() === 0, 'a suite triggered a contained handler error: ' + S.getHandlerErrorCount());
});
