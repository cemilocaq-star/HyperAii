// First-person weapon resource lifecycle (Phase 3). The REAL loadRealWeapon / makeMetalTexture / disposeObject3D are extracted from public/index.html
// and run against counting stubs. This proves OWNERSHIP and DISPOSE ORDER logic; it is NOT a GPU/heap measurement (no browser here).
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const WeaponMat = require(path.join(__dirname, '..', 'public', 'weaponmat.js'));
const sharedSrc = CLIENT.slice(CLIENT.indexOf('function disposeObject3D'), CLIENT.indexOf('function remoteBodyColor'));
const weaponSrc = CLIENT.slice(CLIENT.indexOf('const VIEW_WEAPON_COUNT'), CLIENT.indexOf('let thorHammerModel'));

function rig() {
  const c = { canvases: 0, textures: [], mats: [], geos: [], loads: [], envCalls: [] };
  class Vec { constructor() { this.x = 0; this.y = 0; this.z = 0; } sub() { return this; } setScalar() { return this; } }
  class Obj { constructor() { this.children = []; this.position = new Vec(); this.rotation = new Vec(); this.scale = new Vec(); this.isMesh = false; }
    add(...k) { k.forEach((x) => { if (x.parent) x.parent.remove(x); x.parent = this; this.children.push(x); }); return this; }
    remove(x) { const i = this.children.indexOf(x); if (i >= 0) { this.children.splice(i, 1); x.parent = null; } return this; }
    traverse(fn) { fn(this); this.children.slice().forEach((k) => k.traverse(fn)); } }
  const THREE = { Group: Obj,
    Box3: class { setFromObject() { return this; } getSize(v) { v.x = v.y = v.z = 1; } getCenter(v) { v.x = v.y = v.z = 0; } }, Vector3: Vec,
    CanvasTexture: class { constructor() { this.disposed = 0; this.wrapS = 0; this.repeat = { set() {} }; c.textures.push(this); } dispose() { this.disposed++; } },
    Color: class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } },
    MeshStandardMaterial: class { constructor(o) { this.map = o && o.map; this.opts = o; this.disposed = 0; c.mats.push(this); } dispose() { this.disposed++; } } };
  const document = { createElement() { c.canvases++; return { getContext: () => ({ fillRect() {}, set fillStyle(v) {} }) }; } };
  const objLoader = { load(url, ok, _p, err) { c.loads.push({ url, ok, err }); } };
  const viewGun = new Obj();
  const placeholder = []; for (let i = 0; i < 4; i++) { const m = new Obj(); m.isMesh = true; m.geometry = { disposed: 0, userData: {}, dispose() { this.disposed++; } }; m.material = { disposed: 0, dispose() { this.disposed++; } }; placeholder.push(m); viewGun.add(m); }
  const api = new Function('THREE', 'document', 'objLoader', 'ctx', 'window', 'applyMetalEnv', 'BBWeaponMat', 'let viewGun = ctx.viewGun; const console = ctx.console;\n' + sharedSrc + '\n' + weaponSrc + '\n return { loadRealWeapon, weaponModelPath };')(THREE, document, objLoader, { viewGun, console }, {}, (m, i) => c.envCalls.push([m, i]), WeaponMat); // own `window` stub + a spy for the metal-environment helper: the extracted code must not depend on any global
  // a parsed weapon file: Group -> one mesh with its own private geometry + a default OBJ material
  function parsedWeapon(extraMesh) { const o = new Obj(); const m = new Obj(); m.isMesh = true; m.geometry = { disposed: 0, userData: {}, dispose() { this.disposed++; } }; m.material = { disposed: 0, dispose() { this.disposed++; } }; c.geos.push(m.geometry); o.add(m); if (extraMesh) { const e = new Obj(); e.isMesh = true; e.geometry = { disposed: 0, userData: {}, dispose() { this.disposed++; } }; e.material = { disposed: 0, dispose() { this.disposed++; } }; c.geos.push(e.geometry); o.add(e); } return o; }
  return { c, api, viewGun, placeholder, parsedWeapon, finish(i, obj) { c.loads[i].ok(obj); } };
}
const shown = (r) => r.viewGun.children.length;

test('weaponlife: five switches create ONE canvas texture, every weapon material shares it, and it is never disposed', () => {
  const r = rig(); const ids = ['w001', 'w002', 'w003', 'w004', 'w005'];
  ids.forEach((id, i) => { r.api.loadRealWeapon(id); r.finish(i, r.parsedWeapon()); });
  assertEqual(r.c.canvases, 1, 'one canvas for five loads'); assertEqual(r.c.textures.length, 1); assert(r.c.mats.every((m) => m.map === r.c.textures[0]), 'all share the same map'); assertEqual(r.c.textures[0].disposed, 0, 'shared texture not disposed');
});
test('weaponlife: a switch frees the PREVIOUS weapon (its own geometry+material, once) and keeps exactly one weapon shown', () => {
  const r = rig(); r.api.loadRealWeapon('w001'); r.finish(0, r.parsedWeapon()); const g1 = r.c.geos[0], m1 = r.c.mats[0]; assertEqual(shown(r), 1);
  assert(r.placeholder.every((p) => p.geometry.disposed === 1 && p.material.disposed >= 1), 'placeholder boxes freed on the first real weapon');
  assertEqual(g1.disposed, 0, 'current weapon is live'); r.api.loadRealWeapon('w002'); r.finish(1, r.parsedWeapon());
  assertEqual(shown(r), 1, 'never empty, never two'); assertEqual(g1.disposed, 1, 'old geometry freed once'); assertEqual(m1.disposed, 1, 'old material freed once'); assertEqual(r.c.geos[1].disposed, 0, 'new weapon live'); assertEqual(r.c.mats[1].disposed, 0);
});
test('weaponlife: the swap is atomic — the old weapon is removed and the new one added in the same step, and the new one is already attached when the old is freed', () => {
  const r = rig(); r.api.loadRealWeapon('w001'); r.finish(0, r.parsedWeapon()); const first = r.viewGun.children[0];
  const seen = []; const orig = first.traverse.bind(first); first.traverse = (fn) => { seen.push(r.viewGun.children.length); return orig(fn); }; // disposeObject3D(old) traverses it
  r.api.loadRealWeapon('w002'); r.finish(1, r.parsedWeapon()); assert(seen.length > 0 && seen.every((n) => n === 1 && r.viewGun.children[0] !== first), 'when the old weapon is freed the new one is already shown');
});
test('weaponlife: stale load (A requested, then B before A finished) — A is discarded and freed, B is shown, nothing else is touched', () => {
  const r = rig(); r.api.loadRealWeapon('w001'); r.api.loadRealWeapon('w002'); r.finish(1, r.parsedWeapon()); const shownBefore = r.viewGun.children[0]; const gB = r.c.geos[0];
  r.finish(0, r.parsedWeapon()); const gA = r.c.geos[1]; assertEqual(gA.disposed, 1, 'late A freed'); assertEqual(gB.disposed, 0, 'B untouched'); assertEqual(shown(r), 1); assert(r.viewGun.children[0] === shownBefore, 'B still the one shown');
});
test('weaponlife: same weapon requested again does nothing; a failed load leaves the current weapon intact and can be retried', () => {
  const r = rig(); r.api.loadRealWeapon('w001'); r.finish(0, r.parsedWeapon()); r.api.loadRealWeapon('w001'); assertEqual(r.c.loads.length, 1, 'no reload'); const cur = r.viewGun.children[0], g = r.c.geos[0];
  r.api.loadRealWeapon('w003'); r.c.loads[1].err(new Error('404')); assert(r.viewGun.children[0] === cur && g.disposed === 0, 'old weapon kept after a failed switch'); r.api.loadRealWeapon('w003'); assertEqual(r.c.loads.length, 3, 'retry allowed'); r.finish(2, r.parsedWeapon()); assertEqual(shown(r), 1); assertEqual(g.disposed, 1);
});
test('weaponlife: leftover meshes in a parsed file are freed and an EMPTY file does not leak or replace the current weapon', () => {
  const r = rig(); r.api.loadRealWeapon('w001'); r.finish(0, r.parsedWeapon(true)); assertEqual(r.c.geos[1].disposed, 1, 'the unused second mesh was freed'); assertEqual(r.c.geos[0].disposed, 0, 'the chosen one is live');
  const cur = r.viewGun.children[0]; r.api.loadRealWeapon('w002'); const empty = r.parsedWeapon(); empty.children.length = 0; r.finish(1, empty); assert(r.viewGun.children[0] === cur && r.c.geos[0].disposed === 0, 'current weapon kept when the new file is empty');
});
test('weaponlife: weaponId mapping and registry are untouched (w001..w013 -> split files, fallback weapon_001)', () => {
  const r = rig(); assertEqual(r.api.weaponModelPath('w013'), 'models/weapons/split/weapon_013.obj'); assertEqual(r.api.weaponModelPath('zzz'), 'models/weapons/split/weapon_001.obj');
});

test('perf overlay: bbStats reads renderer.info + cache counters; the overlay is gated on ?perf=1 and creates no timer/DOM otherwise', () => {
  const src = CLIENT.slice(CLIENT.indexOf('function bbStats'), CLIENT.indexOf('let viewMetalTexture'));
  const st = new Function('renderer', 'objCache', 'remotePlayers', 'window', 'location', 'document', 'setInterval', 'gfxState', 'gfxFallback', src + '; return { bbStats, startPerfOverlay };');
  const info = { render: { calls: 120, triangles: 9000 }, memory: { geometries: 40, textures: 12 }, programs: [1, 2, 3] };
  let timers = 0, nodes = 0; const win = {};
  const mk = (search) => st({ info, getPixelRatio: () => 1 }, { 'a.obj': { refs: 2 }, 'b.obj': { refs: 3 } }, { p1: 1, p2: 1 }, win, { search }, { createElement: () => ({ style: {} }), body: { appendChild: () => nodes++ } }, () => timers++, null, false);
  const a = mk(''); assertEqual(JSON.stringify(a.bbStats()), JSON.stringify({ drawCalls: 120, triangles: 9000, geometries: 40, textures: 12, programs: 3, gfxTier: null, shadows: false, pixelRatio: 1, gfxFallback: false, sharedModels: 2, sharedRefs: 5, remotePlayers: 2 }));
  assert(typeof win.bbStats === 'function'); a.startPerfOverlay(); mk('?x=1').startPerfOverlay(); mk('?perf=10').startPerfOverlay(); assertEqual(timers + nodes, 0, 'off by default');
  mk('?a=1&perf=1').startPerfOverlay(); assertEqual(timers, 1); assertEqual(nodes, 1);
  assert(/startPerfOverlay\(\); \/\/ only active with \?perf=1/.test(CLIENT), 'called once from init');
});

test('weaponlife: every loaded view weapon gets the metal environment on its OWN material (never on the shared texture or the placeholder)', () => {
  const r = rig(); r.api.loadRealWeapon('w001'); r.finish(0, r.parsedWeapon()); r.api.loadRealWeapon('w002'); r.finish(1, r.parsedWeapon());
  assertEqual(r.c.envCalls.length, 2, 'once per weapon load'); assert(r.c.envCalls.every(([m, i]) => r.c.mats.includes(m) && i === 0.8), 'own material, intensity 0.8');
});
