// Wind (visual only). No GLSL compiler / three.js / GPU exists in this environment, so these tests prove the JS logic, the patch plumbing and the
// STRUCTURE of the shader text — they do NOT prove the shaders compile or look right (that needs a real browser; see TEST_CHECKLIST.md).
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const PUB = path.join(__dirname, '..', 'public');
const W = require(path.join(PUB, 'wind.js'));
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

test('wind: gust is a deterministic, bounded, genuinely varying 0..1 curve', () => {
  let lo = 1, hi = 0; for (let t = 0; t < 600; t += 0.25) { const g = W.gust(t); assert(g >= 0 && g <= 1 && Number.isFinite(g), 'in range at t=' + t); assertEqual(g, W.gust(t), 'pure'); lo = Math.min(lo, g); hi = Math.max(hi, g); }
  assert(hi - lo > 0.5, 'gusts really vary (' + lo.toFixed(2) + '..' + hi.toFixed(2) + ')');
});
test('wind: direction is a unit vector; only trees and flowers sway (rocks, logs, fences, mushrooms and house props never)', () => {
  assert(Math.abs(Math.hypot(W.DIR.x, W.DIR.z) - 1) < 1e-9, 'unit'); assert(Object.isFrozen(W.SWAY) && W.SWAY.flower > W.SWAY.tree, 'flowers are short so they get more sway');
  for (const u of ['models/nature/tree_oak.glb', 'models/nature/tree_pineTallA.glb']) assertEqual(W.swayKind(u), 'tree'); for (const u of ['models/nature/flower_redA.glb', 'models/nature/flower_purpleA.glb']) assertEqual(W.swayKind(u), 'flower');
  for (const u of ['models/nature/rock_largeA.glb', 'models/nature/log_stack.glb', 'models/nature/stump_round.glb', 'models/nature/fence_simple.glb', 'models/nature/mushroom_redGroup.glb', 'models/furniture/chair.glb', 'models/nature/tree_oak.obj', 'models/nature/subtree_oak.glb', null, undefined, 42]) assertEqual(W.swayKind(u), null, String(u));
  const M = require(path.join(PUB, 'maplayouts.js')); for (const it of M.scatterPlan('house', 3)) assertEqual(W.swayKind(it.url), null, 'house prop ' + it.url);
  const kinds = new Set(M.scatterPlan('forest', 1).map((i) => W.swayKind(i.url))); assert(kinds.has('tree') && kinds.has('flower') && kinds.has(null), 'forest has swaying and still decor');
});
test('wind: particle budget follows the particle quality (low = none), mobile is smaller, unknown quality = medium', () => {
  assertEqual(W.particleCount('low', false), 0); assertEqual(W.particleCount('low', true), 0);
  assert(W.particleCount('high', false) > W.particleCount('medium', false) && W.particleCount('medium', false) > 0, 'desktop tiers grow'); assert(W.particleCount('high', true) < W.particleCount('high', false) && W.particleCount('medium', true) < W.particleCount('medium', false), 'mobile smaller');
  assertEqual(W.particleCount('garbage', false), W.particleCount('medium', false)); assert(W.particleCount('high', false) <= 300, 'stays a small budget (one draw call)');
});
test('wind (shader text): sway splices into the standard material chunks, declares every uniform it uses, is brace-balanced and WebGL1-safe', () => {
  const common = W.vertexCommon(), begin = W.vertexBegin();
  assert(common.startsWith('#include <common>') && begin.startsWith('#include <begin_vertex>'), 'keeps the original chunks');
  for (const u of ['uWindTime', 'uWindGust', 'uWindAmp', 'uWindDir']) { assert(new RegExp('uniform \\w+ ' + u + ';').test(common), u + ' declared'); assert(begin.includes(u), u + ' used'); }
  for (const src of [common, begin, W.particleVertex(), W.particleFragment()]) { assertEqual((src.match(/\{/g) || []).length, (src.match(/\}/g) || []).length, 'braces balanced'); assert(!/\binverse\s*\(|\btranspose\s*\(/.test(src), 'no GLSL ES 3.00-only functions'); }
  assert(/modelMatrix \* vec4\(0\.0, 0\.0, 0\.0, 1\.0\)/.test(begin) && /wh \* wh/.test(begin), 'base is the object origin and the push grows with height squared (the base stays planted)');
  assert(/transformed \+=/.test(begin), 'moves the vertex in object space');
});
test('wind (shader text): particle shaders declare what they use, wrap around the camera, and discard outside the round sprite', () => {
  const v = W.particleVertex(), f = W.particleFragment();
  for (const u of ['uTime', 'uGust', 'uBox', 'uSize', 'uWindDir', 'uCam']) assert(new RegExp('uniform \\w+ ' + u + ';').test(v), u + ' declared in the vertex shader');
  assert(/attribute vec4 aSeed;/.test(v) && /varying float vAlpha;/.test(v) && /varying float vAlpha;/.test(f), 'seed attribute + varying shared'); assert(/mod\(p - uCam\.xz/.test(v), 'wrapped around the camera'); assert(/uniform vec3 uColor;/.test(f) && /discard;/.test(f) && /gl_FragColor/.test(f));
  assert(/void main\(\)/.test(v) && /void main\(\)/.test(f) && /gl_PointSize/.test(v) && /gl_Position/.test(v));
});

// ---------- client plumbing, run for real against stubs ----------
function rig(search, quality, mobile) {
  const src = CLIENT.slice(CLIENT.indexOf('const WIND_ON'), CLIENT.indexOf('// Decoration for forest/house comes from'));
  class V2 { constructor(x, y) { this.x = x; this.y = y; } } class V3 { constructor() { this.x = this.y = this.z = 0; } copy(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; } }
  class Attr { constructor(a, n) { this.array = a; this.itemSize = n; } } class Geo { constructor() { this.attrs = {}; this.disposed = 0; } setAttribute(n, a) { this.attrs[n] = a; } dispose() { this.disposed++; } }
  class Mat { constructor(o) { Object.assign(this, o); this.disposed = 0; } dispose() { this.disposed++; } } class Pts { constructor(g, m) { this.geometry = g; this.material = m; } }
  const THREE = { Vector2: V2, Vector3: V3, Color: class { constructor(c) { this.c = c; } }, BufferGeometry: Geo, BufferAttribute: Attr, ShaderMaterial: Mat, Points: Pts };
  const scene = { kids: [], add(o) { this.kids.push(o); }, remove(o) { const i = this.kids.indexOf(o); if (i >= 0) this.kids.splice(i, 1); } };
  const renderer = { info: { programs: [] } }; const camera = { position: new V3() };
  const api = new Function('THREE', 'BBWind', 'location', 'settings', 'IS_TOUCH_DEVICE', 'scene', 'camera', 'renderer', 'console', src + '; return { patchWindMaterial, applyWindSway, createWindParticles, disableWind, windTick, windU, windPatched, fx: () => windFx, off: () => windDisabled, clock: () => windClock };')(THREE, W, { search: search || '' }, { particleQuality: quality || 'medium' }, !!mobile, scene, camera, renderer, { warn() {}, error() {}, log() {} });
  const mesh = (mat) => ({ isMesh: true, material: mat }); const obj = (...ms) => ({ traverse(fn) { fn(this); ms.forEach(fn); } });
  return { api, scene, renderer, camera, mesh, obj, V3, Mat };
}
test('wind (client): a shared material is patched exactly once; the patch splices the shader, shares the time/gust uniforms and sets a private program key', () => {
  const r = rig(); const mat = { userData: {} }; r.api.patchWindMaterial(mat, 2.4); const hook = mat.onBeforeCompile; r.api.patchWindMaterial(mat, 9); assert(mat.onBeforeCompile === hook, 'second patch is a no-op'); assertEqual(r.api.windPatched.length, 1);
  const shader = { uniforms: {}, vertexShader: 'A\n#include <common>\nB\n#include <begin_vertex>\nC' }; mat.onBeforeCompile(shader);
  assert(shader.vertexShader.includes('uniform float uWindTime;') && shader.vertexShader.includes('wh * wh') && shader.vertexShader.startsWith('A\n') && shader.vertexShader.endsWith('\nC'), 'spliced in place');
  assert(shader.uniforms.uWindTime === r.api.windU.uWindTime && shader.uniforms.uWindGust === r.api.windU.uWindGust && shader.uniforms.uWindDir === r.api.windU.uWindDir, 'time/gust/dir are the SHARED objects');
  assertEqual(shader.uniforms.uWindAmp.value, 2.4); assertEqual(mat.customProgramCacheKey(), 'bbwind'); assert(mat.needsUpdate === true);
});
test('wind (client): only tree and flower objects are patched (all their materials); everything else is untouched', () => {
  const r = rig(); const a = { userData: {} }, b = { userData: {} }, c = { userData: {} };
  r.api.applyWindSway(r.obj(r.mesh(a), r.mesh([b, c])), 'models/nature/tree_oak.glb'); assertEqual(r.api.windPatched.length, 3, 'array materials too'); assert(a.onBeforeCompile && b.onBeforeCompile && c.onBeforeCompile);
  const rock = { userData: {} }; r.api.applyWindSway(r.obj(r.mesh(rock)), 'models/nature/rock_largeA.glb'); assert(!rock.onBeforeCompile && !rock.userData.windPatched, 'rock untouched'); const fl = { userData: {} }; r.api.applyWindSway(r.obj(r.mesh(fl)), 'models/nature/flower_redA.glb'); const sh = { uniforms: {}, vertexShader: '#include <common>#include <begin_vertex>' }; fl.onBeforeCompile(sh); assertEqual(sh.uniforms.uWindAmp.value, W.SWAY.flower);
});
test('wind (client): the per-frame tick advances time, feeds the gust and moves the dust with the camera; dt=0 changes nothing', () => {
  const r = rig('', 'high', false); r.api.createWindParticles(); const fx = r.api.fx(); assert(fx, 'particles created'); r.camera.position.x = 12; r.camera.position.z = -7; r.api.windTick(0.5); r.api.windTick(0.25);
  assert(Math.abs(r.api.windU.uWindTime.value - 0.75) < 1e-9 && r.api.windU.uWindGust.value === W.gust(0.75), 'time + gust'); assertEqual(fx.mat.uniforms.uCam.value.x, 12); assertEqual(fx.mat.uniforms.uCam.value.z, -7);
  const t = r.api.windU.uWindTime.value; r.api.windTick(0); assertEqual(r.api.windU.uWindTime.value, t);
});
test('wind (client): particle count follows quality; low makes none; the points object is one draw call with culling off (GPU-placed) and no depth writes', () => {
  const none = rig('', 'low', false); none.api.createWindParticles(); assertEqual(none.api.fx(), null); assertEqual(none.scene.kids.length, 0);
  const hi = rig('', 'high', false); hi.api.createWindParticles(); const fx = hi.api.fx(); assertEqual(fx.geo.attrs.aSeed.array.length, W.particleCount('high', false) * 4); assertEqual(fx.geo.attrs.aSeed.itemSize, 4); assertEqual(fx.geo.attrs.position.array.length, W.particleCount('high', false) * 3);
  assert(fx.pts.frustumCulled === false && fx.mat.depthWrite === false && fx.mat.transparent === true && hi.scene.kids.length === 1, 'one Points, no culling, no depth write');
  assert(Array.from(fx.geo.attrs.aSeed.array).every((v) => v >= 0 && v < 1), 'seeds are 0..1'); const mob = rig('', 'high', true); mob.api.createWindParticles(); assertEqual(mob.api.fx().geo.attrs.aSeed.array.length, W.particleCount('high', true) * 4); hi.api.createWindParticles(); assertEqual(hi.scene.kids.length, 1, 'no duplicate on a second call');
});
test('wind (client): ?wind=0 and the shader-error safety net both fall back to stock materials and remove the particles', () => {
  const off = rig('?a=1&wind=0'); assert(off.api.off() === true); const m0 = { userData: {} }; off.api.applyWindSway(off.obj(off.mesh(m0)), 'models/nature/tree_oak.glb'); assert(!m0.onBeforeCompile, 'no patch when disabled'); off.api.createWindParticles(); assertEqual(off.api.fx(), null); off.api.windTick(1); assertEqual(off.api.clock(), 0, 'tick is inert');
  const r = rig('', 'high'); const m = { userData: {} }; r.api.applyWindSway(r.obj(r.mesh(m)), 'models/nature/tree_oak.glb'); r.api.createWindParticles(); const fx = r.api.fx(); r.renderer.info.programs = [{ diagnostics: { runnable: true } }, {}];
  for (let i = 0; i < 200; i++) r.api.windTick(0.016); assert(r.api.off() === false && fx.pts && r.scene.kids.length === 1, 'healthy programs keep the wind');
  const r2 = rig('', 'high'); const m2 = { userData: {} }; r2.api.applyWindSway(r2.obj(r2.mesh(m2)), 'models/nature/tree_oak.glb'); r2.api.createWindParticles(); const g2 = r2.api.fx().geo; r2.renderer.info.programs = [{ diagnostics: { runnable: false } }];
  for (let i = 0; i < 200; i++) r2.api.windTick(0.016); assert(r2.api.off() === true && r2.api.fx() === null && r2.scene.kids.length === 0 && g2.disposed === 1, 'failed program -> wind removed and freed'); const sh = { uniforms: {}, vertexShader: 'X' }; m2.onBeforeCompile(sh); assertEqual(sh.vertexShader, 'X', 'restored material no longer rewrites the shader'); assert(m2.needsUpdate === true && r2.api.windPatched.length === 0);
});
test('wind (static): hooked in once — script loaded before use, sway applied when decor is placed, particles only on the forest map, ticked from the existing animate loop', () => {
  assert(CLIENT.indexOf('<script src="wind.js">') > 0 && CLIENT.indexOf('<script src="wind.js">') < CLIENT.indexOf('const WIND_ON'), 'wind.js loaded first');
  assert(/applyWindSway\(obj, it\.url\); markShadow\(obj, true, true\); scene\.add\(obj\)/.test(CLIENT), 'sway (and shadow flags) applied before the decor joins the scene'); const forest = CLIENT.slice(CLIENT.indexOf('function buildForestMap'), CLIENT.indexOf('function buildHouseMap')); assert(/createWindParticles\(\);/.test(forest)); assert(!/createWindParticles/.test(CLIENT.slice(CLIENT.indexOf('function buildHouseMap'), CLIENT.indexOf('function buildHouseMap') + 3000)), 'not on the house map');
  assertEqual((CLIENT.match(/windTick\(dt\);/g) || []).length, 1, 'ticked exactly once, inside animate'); assertEqual((CLIENT.match(/requestAnimationFrame\(/g) || []).length, 6, 'requestAnimationFrame call sites: still the 6 that existed before wind (no second render loop)');
  assert(/\[\?&\]wind=0/.test(CLIENT), 'kill switch');
});
