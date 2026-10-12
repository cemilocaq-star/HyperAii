// Phases 17-19 — movement animation state derivation (pure logic).
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const A = require(path.join(__dirname, '..', 'public', 'animstate.js'));

test('anim: idle/walk/run derived from real speed, not key-press intent', () => {
  assertEqual(A.deriveMoveState({ speed: 0 }), 'idle');
  assertEqual(A.deriveMoveState({ speed: 0.1 }), 'idle');
  assertEqual(A.deriveMoveState({ speed: 2 }), 'walk');
  assertEqual(A.deriveMoveState({ speed: 6 }), 'walk', 'normal walk speed (6u/s) must read as walk, not run');
  assertEqual(A.deriveMoveState({ speed: 10 }), 'run');
});
test('anim: dash and death states override speed', () => {
  assertEqual(A.deriveMoveState({ speed: 0, dashActive: true }), 'dash');
  assertEqual(A.deriveMoveState({ speed: 20, dead: true }), 'death', 'death takes priority over everything');
  assertEqual(A.deriveMoveState({ speed: 20, dashActive: true, dead: true }), 'death');
});
test('anim: negative/NaN speed treated as 0, never throws or returns run', () => {
  assertEqual(A.deriveMoveState({ speed: -5 }), 'idle');
  assertEqual(A.deriveMoveState({ speed: NaN }), 'idle');
  assertEqual(A.deriveMoveState({}), 'idle');
});
test('anim: state transitions idle->walk->run->dash->death are all reachable and consistent with thresholds', () => {
  const seq = [0, 1, 5, 9, 0].map((s) => A.deriveMoveState({ speed: s }));
  assertEqual(seq.join(','), 'idle,walk,walk,run,idle'); // 5 is still walking (walk speed=6), 9 is running
});

test('footsteps: run cadence is faster than walk; dash has none (one-shot whoosh instead)', () => {
  assert(A.footstepIntervalMs('run') < A.footstepIntervalMs('walk'));
  assertEqual(A.footstepIntervalMs('dash'), null);
  assertEqual(A.footstepIntervalMs('idle'), null);
});
test('footsteps: unknown material falls back to default (modular — new materials can be added later)', () => {
  assertEqual(A.footstepMaterialKey('grass'), 'grass');
  assertEqual(A.footstepMaterialKey('lava'), 'default');
  assertEqual(A.footstepMaterialKey(undefined), 'default');
});

test('smoothing: heading interpolates toward target, capped, and never overshoots or teleports', () => {
  let a = 0;
  for (let i = 0; i < 20; i++) a = A.smoothAngle(a, Math.PI / 2, 0.2);
  assert(Math.abs(a - Math.PI / 2) < 0.01, 'converges to target: ' + a);
  const step = A.smoothAngle(0, Math.PI / 2, 0.2);
  assertEqual(step, 0.2, 'single step never exceeds the cap');
});
test('smoothing: takes the shortest path across the -pi/pi wrap', () => {
  const next = A.smoothAngle(3.0, -3.0, 10); // wraps the short way, not through 0
  assert(next > Math.PI || next < -Math.PI + 0.4, 'should move toward +/-pi, not back through 0: ' + next);
});

test('nameplate distance cutoff: visible up to the max distance, hidden beyond it', () => {
  assert(A.nameplateVisible(10, 30));
  assert(!A.nameplateVisible(31, 30));
  assert(A.nameplateVisible(5)); // default max
});
