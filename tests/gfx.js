// Graphics profile (pixel ratio + sun shadows) and its atomic application. Pure logic + the real client functions run against stubs.
// No GPU/WebGL/three.js exists here, so this proves the plan, the validation, the apply/verify/commit/rollback ORDER and the shadow-camera maths —
// NOT that shadows render correctly (see TEST_CHECKLIST.md, Phase 6).
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const PUB = path.join(__dirname, '..', 'public');
const G = require(path.join(PUB, 'gfx.js'));
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const close = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

test('gfx: tier table — low = exactly the old behaviour (ratio 1, no shadows); medium/high add pixel ratio and sun shadows; touch drops one tier; unknown = medium', () => {
  const lo = G.plan('low', false, 2), me = G.plan('medium', false, 2), hi = G.plan('high', false, 2);
  assertEqual(lo.pixelRatio, 1); assertEqual(lo.shadows.enabled, false); assert(me.shadows.enabled && hi.shadows.enabled && hi.shadows.size > me.shadows.size && hi.pixelRatio > me.pixelRatio, 'high > medium');
  assertEqual(me.pixelRatio, 1.5); assertEqual(hi.pixelRatio, 2); assertEqual(G.plan('high', false, 3).pixelRatio, 2, 'capped'); assertEqual(G.plan('high', false, 1).pixelRatio, 1, 'never below 1');
  assertEqual(G.plan('medium', true, 3).tier, 'low'); assertEqual(G.plan('high', true, 3).tier, 'medium'); assertEqual(G.plan('low', true, 3).tier, 'low'); assertEqual(G.plan('weird', false, 1).tier, 'medium'); assertEqual(G.plan(undefined, true, 1).tier, 'low');
  for (const d of [NaN, 0, -2, undefined, Infinity]) assert(G.plan('high', false, d).pixelRatio >= 1 && Number.isFinite(G.plan('high', false, d).pixelRatio), 'bad dpr ' + d);
  assert(Object.isFrozen(G.PROFILES) && Object.isFrozen(G.PROFILES.high), 'profiles are frozen');
});
test('gfx: validate rejects what the device cannot do BEFORE anything is applied', () => {
  const ok = G.plan('high', false, 2); assert(G.validate(ok, { maxTextureSize: 4096 }).ok); assert(!G.validate(ok, { maxTextureSize: 1024 }).ok, 'shadow map larger than the device limit'); assert(!G.validate(ok, {}).ok && !G.validate(ok, null).ok, 'unknown limit is not assumed');
  assert(G.validate(G.plan('low', false, 1), {}).ok, 'a no-shadow plan needs no texture limit');
  const bad = (m) => G.validate(Object.assign({}, ok, m), { maxTextureSize: 8192 }); assert(!bad({ pixelRatio: 0.5 }).ok && !bad({ pixelRatio: 5 }).ok && !bad({ pixelRatio: NaN }).ok);
  assert(!bad({ shadows: { enabled: true, size: 1000, half: 20, type: 'pcf' } }).ok, 'not a power of two'); assert(!bad({ shadows: { enabled: true, size: 1024, half: 0, type: 'pcf' } }).ok); assert(!bad({ shadows: { enabled: true, size: 1024, half: 20, type: 'vsm' } }).ok); assert(!G.validate(null, {}).ok);
});
test('gfx: the sun direction is the scene light direction and shadowFit keeps the target within one texel of the camera, in whole-texel steps', () => {
  assert(close(Math.hypot(G.SUN_DIR.x, G.SUN_DIR.y, G.SUN_DIR.z), 1)); assert(close(G.SUN_DIR.x / G.SUN_DIR.y, 0.5) && close(G.SUN_DIR.x, G.SUN_DIR.z), 'same direction as DirectionalLight(10,20,10)');
  const half = 22, size = 1024; const a = G.shadowFit({ x: 3.2, y: 1.6, z: -7.1 }, half, size), t = a.texel;
  assert(close(t, 44 / 1024)); const fx = -G.SUN_DIR.x, fy = -G.SUN_DIR.y, fz = -G.SUN_DIR.z, rl = Math.hypot(fz, fx), rx = fz / rl, rz = -fx / rl, ux = fy * rz, uy = fz * rx - fx * rz, uz = -fy * rx;
  const at = { x: a.tx, y: a.ty, z: a.tz }; // start from an already snapped position so the sub-texel moves below cannot straddle a rounding boundary
  const jitter = G.shadowFit({ x: at.x + rx * t * 0.2, y: at.y, z: at.z + rz * t * 0.2 }, half, size); assert(close(jitter.tx, a.tx, 1e-9) && close(jitter.ty, a.ty, 1e-9) && close(jitter.tz, a.tz, 1e-9), 'a 0.2-texel move along the light right axis does not move the shadow camera (no shimmer)');
  const step = G.shadowFit({ x: at.x + rx * t * 1.2, y: at.y, z: at.z + rz * t * 1.2 }, half, size); assert(close(Math.hypot(step.tx - a.tx, step.ty - a.ty, step.tz - a.tz), t, 1e-9), 'a 1.2-texel move advances the shadow camera by exactly one texel');
  const cam = { x: 10, y: 1.6, z: 5 }; const f = G.shadowFit(cam, half, size); const dx = f.tx - cam.x, dy = f.ty - cam.y, dz = f.tz - cam.z;
  assert(Math.abs(dx * rx + dz * rz) <= t / 2 + 1e-9 && Math.abs(dx * ux + dy * uy + dz * uz) <= t / 2 + 1e-9, 'within half a texel along the light right/up axes'); assert(close(dx * fx + dy * fy + dz * fz, 0, 1e-9), 'depth along the light is not snapped');
  assert(close(f.px - f.tx, G.SUN_DIR.x * G.SUN_DISTANCE) && close(f.py - f.ty, G.SUN_DIR.y * G.SUN_DISTANCE) && close(f.pz - f.tz, G.SUN_DIR.z * G.SUN_DISTANCE), 'light sits SUN_DISTANCE along the sun direction from its target');
  assertEqual(JSON.stringify(G.shadowFit(cam, half, size)), JSON.stringify(f), 'deterministic');
});

// ---------- the real client functions against stubs ----------
function rig(opts) {
  opts = opts || {};
  const src = CLIENT.slice(CLIENT.indexOf('// ---------- GRAPHICS PROFILE'), CLIENT.indexOf('function initScene(mapName, mapSeed) {'));
  const log = []; const warns = [];
  const THREE = { PCFShadowMap: 1, PCFSoftShadowMap: 2 };
  const shadow = { mapSize: { x: 512, y: 512, set(a, b) { this.x = a; this.y = b; } }, camera: { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 500, updateProjectionMatrix() { log.push('cam.update'); } }, map: null, bias: 0, normalBias: 0 };
  const sun = { castShadow: false, shadow, position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, target: { position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, updateMatrixWorld() {} } };
  let pr = 1; const renderer = { capabilities: { maxTextureSize: opts.maxTex === undefined ? 4096 : opts.maxTex }, info: { programs: [] }, shadowMap: { enabled: false, type: 1 },
    setPixelRatio(v) { log.push('pr:' + v); if (opts.throwOnPr && v === opts.throwOnPr) throw new Error('boom'); pr = opts.lie ? 7 : v; }, getPixelRatio: () => pr, setSize() { log.push('size'); } };
  const mats = [{ n: 'a', needsUpdate: false }, { n: 'b', needsUpdate: false }];
  const meshes = [{ material: mats[0] }, { material: mats[0] }, { material: [mats[1]] }, { noMaterial: true }];
  const scene = { traverse(fn) { fn({}); meshes.forEach(fn); } };
  const camera = { position: { x: 4, y: 1.6, z: -3 } };
  const win = { devicePixelRatio: opts.dpr || 2 };
  const api = new Function('THREE', 'BBGfx', 'renderer', 'scene', 'camera', 'window', 'IS_TOUCH_DEVICE', 'innerWidth', 'innerHeight', 'console', 'sunInit', 'settings',
    src + '; sunLight = sunInit; return { applyGraphics, gfxTick, markShadow, state: () => gfxState, fellBack: () => gfxFallback };')(THREE, G, renderer, scene, camera, win, !!opts.mobile, 800, 600, { warn: (...a) => warns.push(a.join(' ')), error: (...a) => warns.push(a.join(' ')), log() {} }, sun, {});
  return { api, log, warns, renderer, sun, shadow, mats, camera, setPr: (v) => { pr = v; } };
}
test('gfx (client): a valid profile goes PREPARE -> VALIDATE -> APPLY -> VERIFY -> COMMIT and every material recompiles once', () => {
  const r = rig({ dpr: 2 }); assert(r.api.applyGraphics('high') === true); const st = r.api.state(); assertEqual(st.quality, 'high'); assertEqual(st.plan.tier, 'high');
  assertEqual(r.renderer.getPixelRatio(), 2); assert(r.renderer.shadowMap.enabled === true && r.renderer.shadowMap.type === 2 && r.sun.castShadow === true, 'soft shadows on'); assertEqual(r.shadow.mapSize.x, 2048); assertEqual(r.shadow.camera.right, 26); assert(r.shadow.camera.left === -26 && r.shadow.camera.top === 26);
  assert(r.mats.every((m) => m.needsUpdate === true), 'array and single materials both flagged'); assertEqual(r.log.filter((l) => l === 'size').length, 1, 'resized once after the ratio change');
  assert(r.api.applyGraphics('low') === true); assert(r.renderer.shadowMap.enabled === false && r.sun.castShadow === false && r.renderer.getPixelRatio() === 1, 'low turns everything off again'); assertEqual(r.api.state().plan.tier, 'low');
});
test('gfx (client): a shadow map of a different size drops the old render target; the same size keeps it', () => {
  const r = rig({ dpr: 1 }); r.api.applyGraphics('medium'); let disposed = 0; r.shadow.map = { dispose() { disposed++; } };
  r.api.applyGraphics('medium'); assertEqual(disposed, 0, 'same size: kept'); assert(r.shadow.map); r.api.applyGraphics('high'); assertEqual(disposed, 1, 'size changed: old target disposed'); assertEqual(r.shadow.map, null, 'a new one is created lazily by the renderer');
});
test('gfx (client): VALIDATE failure applies NOTHING (the previous profile stays exactly as it was)', () => {
  const r = rig({ maxTex: 1024 }); r.api.applyGraphics('low'); const before = JSON.stringify([r.renderer.getPixelRatio(), r.renderer.shadowMap.enabled, r.sun.castShadow, r.shadow.mapSize.x]); r.log.length = 0;
  assert(r.api.applyGraphics('high') === false, 'rejected'); assertEqual(JSON.stringify([r.renderer.getPixelRatio(), r.renderer.shadowMap.enabled, r.sun.castShadow, r.shadow.mapSize.x]), before); assertEqual(r.log.length, 0, 'no renderer call at all'); assertEqual(r.api.state().quality, 'low', 'state not committed'); assert(r.warns.some((w) => /rejected/.test(w)));
});
test('gfx (client): an exception while APPLYING rolls back to the snapshot (no half-applied mix of old and new)', () => {
  const r = rig({ dpr: 2, throwOnPr: 2 }); r.api.applyGraphics('medium'); /* medium: ratio 1.5 -> ok */ const good = JSON.stringify([r.renderer.getPixelRatio(), r.renderer.shadowMap.enabled, r.shadow.mapSize.x]);
  assert(r.api.applyGraphics('high') === false, 'high wants ratio 2 which throws'); assertEqual(JSON.stringify([r.renderer.getPixelRatio(), r.renderer.shadowMap.enabled, r.shadow.mapSize.x]), good, 'back to the medium state'); assertEqual(r.api.state().plan.tier, 'medium', 'last committed state still medium'); assert(r.warns.some((w) => /rolled back/.test(w)));
});
test('gfx (client): VERIFY (read-back) failure rolls back instead of committing a state the renderer does not hold', () => {
  const r = rig({ dpr: 2, lie: true }); assert(r.api.applyGraphics('high') === false, 'renderer reports a different ratio than requested'); assertEqual(r.api.state(), null, 'nothing committed'); assert(r.warns.some((w) => /rolled back/.test(w)));
});
test('gfx (client): shadow camera follows the player every frame only when shadows are on, and a shader failure falls back to Low once', () => {
  const r = rig({ dpr: 1 }); r.api.applyGraphics('low'); r.api.gfxTick(); assertEqual(r.sun.position.x, undefined, 'no shadow work on Low');
  r.api.applyGraphics('medium'); r.api.gfxTick(); const f = G.shadowFit(r.camera.position, 22, 1024); assert(close(r.sun.target.position.x, f.tx) && close(r.sun.position.y, f.py), 'sun follows the camera snapped');
  r.camera.position.x = 30; r.api.gfxTick(); assert(close(r.sun.target.position.x, G.shadowFit(r.camera.position, 22, 1024).tx), 'follows as the player moves');
  r.renderer.info.programs = [{ diagnostics: { runnable: true } }, {}]; for (let i = 0; i < 300; i++) r.api.gfxTick(); assertEqual(r.api.state().plan.tier, 'medium', 'healthy programs keep the profile'); assert(r.api.fellBack() === false);
  const b = rig({ dpr: 1 }); b.api.applyGraphics('high'); b.renderer.info.programs = [{ diagnostics: { runnable: false } }]; for (let i = 0; i < 300; i++) b.api.gfxTick();
  assertEqual(b.api.state().plan.tier, 'low'); assert(b.api.fellBack() === true && b.renderer.shadowMap.enabled === false && b.warns.some((w) => /falling back to the Low/.test(w)), 'fell back, loudly'); assertEqual(b.warns.filter((w) => /falling back/.test(w)).length, 1, 'only once');
});
test('gfx (client): markShadow flags solid meshes only — transparent or invisible meshes (hit proxies, glass, sprites) never cast or receive', () => {
  const r = rig(); const mk = (mat) => ({ isMesh: true, material: mat, castShadow: false, receiveShadow: false }); const solid = mk({ transparent: false }), glass = mk({ transparent: true }), proxy = mk({ visible: false }), multi = mk([{}]), nomat = { isMesh: true }, notMesh = { material: {} };
  r.api.markShadow({ traverse(fn) { [solid, glass, proxy, multi, nomat, notMesh].forEach(fn); } }, true, false);
  assert(solid.castShadow && !solid.receiveShadow && multi.castShadow, 'solid + array material flagged'); assert(!glass.castShadow && !proxy.castShadow && !nomat.castShadow && !notMesh.castShadow, 'others untouched');
});
test('gfx (static): wired once — script before use, light + target in the scene, applied at init, ticked from animate, live setting change, floors receive / obstacles + decor + skins cast', () => {
  assert(CLIENT.indexOf('<script src="gfx.js">') > 0 && CLIENT.indexOf('<script src="gfx.js">') < CLIENT.indexOf('let sunLight'), 'gfx.js loaded first');
  assert(/scene\.add\(dir\.target\);[^\n]*\n\s*sunLight = dir;\s*applyGraphics\(settings\.graphicsQuality\);/.test(CLIENT), 'sun + target in the scene, profile applied at init'); assertEqual((CLIENT.match(/gfxTick\(\);/g) || []).length, 1, 'ticked once, inside animate');
  assert(/key === 'graphicsQuality' && renderer && sunLight\) applyGraphics\(settings\.graphicsQuality\)/.test(CLIENT), 'live change goes through the atomic path');
  assertEqual((CLIENT.match(/ground\.receiveShadow = true/g) || []).length, 3, 'all three floors receive'); assert(/box\.castShadow = true; box\.receiveShadow = true;/.test(CLIENT), 'purple obstacles'); assert(/markShadow\(obj, true, true\)/.test(CLIENT) && /markShadow\(m, true, false\)/.test(CLIENT), 'decor + skins');
  assert(!/viewGun[^;\n]*castShadow/.test(CLIENT), 'the first-person gun never casts'); assertEqual((CLIENT.match(/requestAnimationFrame\(/g) || []).length, 6, 'no new render loop');
});
