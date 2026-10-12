// Shared OBJ cache (loadObjShared / disposeObject3D) — behavioural tests with minimal THREE-like stubs.
// The functions are extracted from public/index.html and executed, so this runs the real client code (not a copy).
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const CLIENT = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const src = CLIENT.slice(CLIENT.indexOf('function disposeObject3D'), CLIENT.indexOf('function remoteBodyColor'));

class Geo { constructor() { this.userData = {}; this.disposed = 0; } dispose() { this.disposed++; } }
class Mat { constructor() { this.disposed = 0; } dispose() { this.disposed++; } clone() { return new Mat(); } }
class Node { constructor() { this.children = []; this.isMesh = false; }
  add(c) { this.children.push(c); return this; }
  traverse(fn) { fn(this); this.children.forEach((c) => c.traverse(fn)); }
  clone() { const n = new this.constructor(); n.isMesh = this.isMesh; if (this.isMesh) { n.geometry = this.geometry; n.material = this.material; } this.children.forEach((c) => n.add(c.clone())); return n; } }
function mesh() { const m = new Node(); m.isMesh = true; m.geometry = new Geo(); m.material = new Mat(); return m; }
// `deepGeo` simulates a three.js version whose clone() copies geometry: the cache must still hand out the SAME geometry.
function make(deepGeo) {
  const loads = []; const objLoader = { load(url, ok, _p, err) { loads.push({ url, ok, err }); } };
  const NodeCls = deepGeo ? class extends Node { clone() { const n = super.clone(); n.traverse((c) => { if (c.isMesh) c.geometry = new Geo(); }); return n; } } : Node;
  const api = new Function('objLoader', 'console', src + '; return { loadObjShared, disposeObject3D, objCache };')(objLoader, console);
  return { api, loads, NodeCls };
}
function parsed() { const root = new Node(); root.add(mesh()); root.add(mesh()); return root; }

test('sharedobj: one fetch+parse serves many consumers, all clones use the SAME geometry', () => {
  const { api, loads } = make(false); const got = [];
  for (let i = 0; i < 4; i++) api.loadObjShared('a.obj', (o) => got.push(o));
  assertEqual(loads.length, 1, 'a single objLoader.load for 4 concurrent consumers'); assertEqual(got.length, 0, 'nobody called before the parse finishes');
  loads[0].ok(parsed()); assertEqual(got.length, 4, 'all waiters served');
  api.loadObjShared('a.obj', (o) => got.push(o)); assertEqual(loads.length, 1, 'later consumer: still no new load'); assertEqual(got.length, 5);
  const geos = got.map((o) => { const g = []; o.traverse((c) => c.isMesh && g.push(c.geometry)); return g; });
  for (let k = 1; k < geos.length; k++) { assert(geos[k][0] === geos[0][0] && geos[k][1] === geos[0][1], 'consumer ' + k + ' shares geometry'); }
  assert(geos[0][0] !== geos[0][1], 'the two sub-meshes keep their own geometry'); assert(geos[0][0].userData.sharedGeometry === true, 'flagged shared');
});

test('sharedobj: sharing does not depend on how clone() treats geometry (deep-copying clone is corrected)', () => {
  const { api, loads } = make(true); const got = []; api.loadObjShared('b.obj', (o) => got.push(o)); loads[0].ok(parsed()); api.loadObjShared('b.obj', (o) => got.push(o));
  const g = got.map((o) => { let x; o.traverse((c) => c.isMesh && !x && (x = c.geometry)); return x; }); assert(g[0] === g[1], 'same geometry even if clone() would have copied it');
});

test('sharedobj: disposing one consumer frees ITS material but never the shared geometry (other players keep their model)', () => {
  const { api, loads } = make(false); const a = [], b = []; api.loadObjShared('c.obj', (o) => a.push(o)); api.loadObjShared('c.obj', (o) => b.push(o)); loads[0].ok(parsed());
  a[0].traverse((c) => { if (c.isMesh) c.material = new Mat(); }); b[0].traverse((c) => { if (c.isMesh) c.material = new Mat(); });
  const geoB = []; b[0].traverse((c) => c.isMesh && geoB.push(c.geometry)); const matA = []; a[0].traverse((c) => c.isMesh && matA.push(c.material));
  api.disposeObject3D(a[0]);
  assert(geoB.every((g) => g.disposed === 0), 'shared geometry NOT disposed'); assert(matA.every((m) => m.disposed === 1), "consumer's own material disposed");
});

test('sharedobj: regression — geometry that is NOT shared is still disposed (explosions, bananas, cosmetics)', () => {
  const { api } = make(false); const m = mesh(); const root = new Node().add(m); api.disposeObject3D(root); assertEqual(m.geometry.disposed, 1, 'private geometry disposed'); assertEqual(m.material.disposed, 1);
});

test('sharedobj: a failed load notifies every waiter, clears the cache, and a later request retries', () => {
  const { api, loads } = make(false); let errs = 0; api.loadObjShared('d.obj', () => {}, () => errs++); api.loadObjShared('d.obj', () => {}, () => errs++);
  loads[0].err(new Error('404')); assertEqual(errs, 2, 'both waiters told'); assert(!api.objCache['d.obj'], 'cache cleared');
  api.loadObjShared('d.obj', () => {}, () => {}); assertEqual(loads.length, 2, 'retry fetches again');
});

test('sharedobj: a throwing consumer does not starve the other waiters', () => {
  const { api, loads } = make(false); const origErr = console.error; console.error = () => {}; let ok = 0;
  try { api.loadObjShared('e.obj', () => { throw new Error('boom'); }); api.loadObjShared('e.obj', () => ok++); loads[0].ok(parsed()); } finally { console.error = origErr; }
  assertEqual(ok, 1, 'second consumer still served');
});

test('sharedobj (static): skins, view items and bombs use the cache; a thrown bomb no longer deep-copies the grenade geometry', () => {
  const skin = CLIENT.slice(CLIENT.indexOf('function applyBodyModel'), CLIENT.indexOf('function applyRemoteCosmetics')); assert(/loadObjShared\(sv\.model/.test(skin));
  const mk = CLIENT.slice(CLIENT.indexOf('function makeBombMesh'), CLIENT.indexOf('function loadBombProto')); assert(!/geometry\.clone\(\)/.test(mk), 'no per-bomb geometry clone'); assert(/ch\.material = ch\.material\.clone\(\)/.test(mk), 'each bomb keeps its own material');
  const lp = CLIENT.slice(CLIENT.indexOf('function loadBombProto'), CLIENT.indexOf('function spawnExplosionEffect')); assert(/loadObjShared\('models\/weapons\/throwable\/grenade\/Grenade\.obj'/.test(lp));
  const vi = CLIENT.slice(CLIENT.indexOf('function ensureViewItem'), CLIENT.indexOf('function updateViewItems')); assert(/loadObjShared\(url/.test(vi), 'knife/grenade view items share the grenade parse with the bomb prototype');
  assertEqual((CLIENT.match(/Grenade\.obj/g) || []).length, 2, 'Grenade.obj referenced in exactly the 2 expected places (view item url + bomb proto), both via the cache');
});

// ---------------- Phase 3: reference counting / ownership ----------------
function geosOf(o) { const g = []; o.traverse((c) => c.isMesh && g.push(c.geometry)); return g; }
function own(o) { o.traverse((c) => { if (c.isMesh) c.material = new Mat(); }); return o; }
function serve(api, loads, url, n) { const out = []; for (let i = 0; i < n; i++) api.loadObjShared(url, (o) => out.push(own(o))); loads[0].ok(parsed()); return out; }

test('sharedobj/refs: geometry is freed ONLY when the last consumer releases it, exactly once; the cache entry is then dropped', () => {
  const { api, loads } = make(false); const [a, b, c] = serve(api, loads, 'r1.obj', 3); const G = geosOf(a);
  api.disposeObject3D(a); assert(G.every((g) => g.disposed === 0), 'still used by b and c'); api.disposeObject3D(b); assert(G.every((g) => g.disposed === 0), 'still used by c');
  assert(api.objCache['r1.obj'], 'entry kept while referenced'); api.disposeObject3D(c); assert(G.every((g) => g.disposed === 1), 'freed once when the last one leaves'); assert(!api.objCache['r1.obj'], 'entry dropped');
});
test('sharedobj/refs: disposing the same clone twice releases only one reference (no premature free)', () => {
  const { api, loads } = make(false); const [a, b] = serve(api, loads, 'r2.obj', 2); const G = geosOf(b);
  api.disposeObject3D(a); api.disposeObject3D(a); assert(G.every((g) => g.disposed === 0), 'b still holds its reference'); assert(api.objCache['r2.obj'].refs === 1);
});
test('sharedobj/refs: after the last release a later player triggers a fresh load (and gets working geometry)', () => {
  const { api, loads } = make(false); const [a] = serve(api, loads, 'r3.obj', 1); api.disposeObject3D(a); assertEqual(loads.length, 1);
  const got = []; api.loadObjShared('r3.obj', (o) => got.push(o)); assertEqual(loads.length, 2, 'refetched'); loads[1].ok(parsed()); assertEqual(got.length, 1); assert(geosOf(got[0]).every((g) => g.disposed === 0), 'new geometry is live');
});
test('sharedobj/refs: a consumer that disposes IMMEDIATELY inside its callback (stale load guard) cannot free the model under the other waiters', () => {
  const { api, loads } = make(false); const keep = []; let G;
  api.loadObjShared('r4.obj', (o) => { G = geosOf(o); api.disposeObject3D(o); }); api.loadObjShared('r4.obj', (o) => keep.push(o)); api.loadObjShared('r4.obj', (o) => keep.push(o)); loads[0].ok(parsed());
  assertEqual(keep.length, 2); assert(G.every((g) => g.disposed === 0), 'not freed: two consumers still hold it'); assert(api.objCache['r4.obj'].refs === 2);
});
test('sharedobj/refs: if ALL waiters dispose inside their callbacks the model is freed once and the cache is clean', () => {
  const { api, loads } = make(false); const Gs = [];
  for (let i = 0; i < 3; i++) api.loadObjShared('r5.obj', (o) => { Gs.push(...geosOf(o)); api.disposeObject3D(o); }); loads[0].ok(parsed());
  assert(Gs.every((g) => g.disposed === 1), 'each geometry freed exactly once (' + Gs.map((g) => g.disposed) + ')'); assert(!api.objCache['r5.obj']);
});
test('sharedobj/refs: Object3D.clone() copies of a registered clone (thrown bombs) never release a reference they never took', () => {
  const { api, loads } = make(false); const [proto, other] = serve(api, loads, 'r6.obj', 2); const bomb = proto.clone(true); own(bomb);
  api.disposeObject3D(bomb); api.disposeObject3D(bomb); assert(api.objCache['r6.obj'].refs === 2, 'refs untouched by the unregistered copy'); assert(geosOf(other).every((g) => g.disposed === 0));
});
test('sharedobj/refs: different files are independent (releasing one model never touches another)', () => {
  const { api, loads } = make(false); const x = []; api.loadObjShared('x.obj', (o) => x.push(own(o))); loads[0].ok(parsed());
  const y = []; api.loadObjShared('y.obj', (o) => y.push(own(o))); loads[1].ok(parsed()); const GX = geosOf(x[0]), GY = geosOf(y[0]);
  api.disposeObject3D(x[0]); assert(GX.every((g) => g.disposed === 1) && GY.every((g) => g.disposed === 0), 'only x freed'); assert(api.objCache['y.obj']);
});
test('sharedobj/refs (static): disposeObject3D releases through the registry, and the cache registry is a WeakMap (not userData)', () => {
  assert(/const sharedRoots = new WeakMap\(\)/.test(CLIENT)); assert(/releaseSharedObj\(c\);/.test(CLIENT.slice(CLIENT.indexOf('function disposeObject3D'), CLIENT.indexOf('const objCache'))));
});
