// The 13 real weapon models and how the client shows them. Facts pinned here come from the Phase 0/4 audit of the real files:
//  - split/weapon_001..013.obj: one object each, all long along X (the client's rotation/scale logic relies on that)
//  - weapon_006 and weapon_008 are an EXACT geometric duplicate (different material names), so there are 12 unique shapes
//  - every file references `all weapons.mtl`, which does NOT exist (known BLOCKED dependency); real weapon TYPES are UNKNOWN
// Static client checks read public/index.html: they are NOT a browser/3D verification.
const fs = require('fs');
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const ROOT = path.join(__dirname, '..', 'public');
const CLIENT = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const IDS = Array.from({ length: 13 }, (_, i) => i + 1);
const file = (n) => path.join(ROOT, 'models/weapons/split/weapon_' + String(n).padStart(3, '0') + '.obj');
function load(n) { const V = [], F = [], mats = new Set(), objs = []; let mtllib = null; for (const ln of fs.readFileSync(file(n), 'utf8').split('\n')) { if (ln.startsWith('v ')) V.push(ln.trim().split(/\s+/).slice(1, 4).map(Number)); else if (ln.startsWith('f ')) F.push(ln.trim().split(/\s+/).slice(1).map((t) => t.split('/')[0]).join(',')); else if (ln.startsWith('usemtl')) mats.add(ln.slice(6).trim()); else if (ln.startsWith('o ')) objs.push(ln.slice(2).trim()); else if (ln.startsWith('mtllib')) mtllib = ln.slice(6).trim(); } return { V, F, mats: [...mats], objs, mtllib }; }
const ext = (V) => [0, 1, 2].map((i) => Math.max(...V.map((v) => v[i])) - Math.min(...V.map((v) => v[i])));
const centred = (V) => { const c = [0, 1, 2].map((i) => V.reduce((s, v) => s + v[i], 0) / V.length); return V.map((v) => v.map((x, i) => x - c[i])); };
const same = (a, b) => a.V.length === b.V.length && a.F.join('|') === b.F.join('|') && centred(a.V).every((v, i) => v.every((x, k) => Math.abs(x - centred(b.V)[i][k]) < 1e-4));

test('weapons(13): the registry has exactly 13 entries w001..w013 whose model file is split/weapon_NNN.obj, exists, and is bound only once', () => {
  const ids = Object.keys(T.WEAPONS); assertEqual(ids.length, 13); const seen = new Set();
  for (const n of IDS) { const w = T.WEAPONS['w' + String(n).padStart(3, '0')]; assert(w, 'registry entry for ' + n); assertEqual(w.model, 'models/weapons/split/weapon_' + String(n).padStart(3, '0') + '.obj'); assert(fs.existsSync(file(n)), 'file ' + n); assert(!seen.has(w.model), 'model bound twice'); seen.add(w.model); }
});
test('weapons(13): every split file is one valid object (no NaN, indices in range), long along X, and has exactly one material name', () => {
  for (const n of IDS) { const o = load(n); assertEqual(o.objs.length, 1, 'one object in ' + n); assert(o.V.length > 100 && o.F.length > 100, 'geometry ' + n); assert(o.V.every((v) => v.length === 3 && v.every(Number.isFinite)), 'finite ' + n);
    assert(o.F.every((f) => f.split(',').every((i) => { const k = parseInt(i, 10); return k >= 1 && k <= o.V.length; })), 'indices in range ' + n); const e = ext(o.V); assert(e[0] > e[1] && e[0] > e[2], 'weapon_' + n + ' must be longest along X (the client rotates by -90deg about Y assuming this): ' + e.map((x) => x.toFixed(2)));
    assertEqual(o.mats.length, 1, 'one usemtl in ' + n); }
});
test('weapons(13): exactly ONE exact duplicate pair exists (weapon_006 == weapon_008 geometry, different material); the other 11 shapes are all distinct', () => {
  const L = IDS.map(load); const pairs = []; for (let i = 0; i < 13; i++) for (let j = i + 1; j < 13; j++) if (same(L[i], L[j])) pairs.push([i + 1, j + 1]);
  assertEqual(JSON.stringify(pairs), '[[6,8]]', 'duplicate pairs'); assert(L[5].mats[0] !== L[7].mats[0], 'the duplicates carry different material names (' + L[5].mats + ' vs ' + L[7].mats + ') — possibly colour variants, UNKNOWN without the MTL');
  assertEqual(new Set(L.map((o) => o.mats[0])).size, 13, '13 distinct material names');
});
test('weapons(13): the missing MTL dependency is exactly the one known file; no other dangling material reference exists', () => {
  const refs = new Set(IDS.map((n) => load(n).mtllib)); assertEqual([...refs].join(), 'all weapons.mtl', 'all split files point at the same MTL'); const known = !fs.existsSync(path.join(ROOT, 'models/weapons/all weapons.mtl'));
  if (known) console.log('        NOTE: "all weapons.mtl" is still missing (BLOCKED dependency: colours/textures cannot be recovered; the client uses a generated metal texture)'); else assert(true);
});
test('weapons(13) client: the first-person weapon follows the SERVER weaponId (w00N -> weapon_00N.obj), no hard-coded object, no all_weapons.obj download, safe fallbacks and a stale-load guard', () => {
  assert(!/WEAPON_NAME/.test(CLIENT) && !/objLoader\.load\('models\/weapons\/all_weapons\.obj'/.test(CLIENT), 'old hard-coded loader is gone');
  const fn = CLIENT.slice(CLIENT.indexOf('const VIEW_WEAPON_COUNT'), CLIENT.indexOf('let thorHammerModel')); assert(/models\/weapons\/split\/weapon_/.test(fn) && /VIEW_WEAPON_COUNT = 13/.test(fn), 'split path + 13 weapons');
  assert(/const want = weaponId \|\| 'w001';/.test(fn), 'the weapon shown comes from the weaponId argument (default w001), never a constant'); assert(/if \(viewWeaponId === want\) return;/.test(fn), 'no reload of the same weapon'); assert(/viewWeaponId !== want\) \{ disposeObject3D\(obj\); return; \}/.test(fn), 'stale-load guard'); assert(/viewWeaponId = null; \}\);/.test(fn), 'a failed load can be retried');
  assert(/if \(id === myId\) \{ const mine = msg\.players\[id\]; if \(mine && typeof mine\.weaponId === 'string'\) loadRealWeapon\(mine\.weaponId\)/.test(CLIENT), 'own weaponId from the state tick drives it');
});
test('weapons(13) client: the path mapping is total — every registry id maps to its own file, anything else falls back to weapon_001 (evaluated from the real client function)', () => {
  const src = CLIENT.slice(CLIENT.indexOf('const VIEW_WEAPON_COUNT'), CLIENT.indexOf('function makeMetalTexture')); const mod = new Function(src + '; return weaponModelPath;')(); 
  for (const n of IDS) assertEqual(mod('w' + String(n).padStart(3, '0')), 'models/weapons/split/weapon_' + String(n).padStart(3, '0') + '.obj');
  for (const bad of ['w000', 'w014', 'w999', 'x001', 'w1', '', null, undefined, 7, {}, [], 'w001 ', '../w001', 'w00١']) assertEqual(mod(bad), 'models/weapons/split/weapon_001.obj', 'fallback for ' + String(bad));
});
