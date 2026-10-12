// GLTF material normalisation (Phase 6). Evidence-driven: the rule is derived from measured data in the shipped GLBs. Rendering result itself is NOT VERIFIED (no GPU here).
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const PUB = path.join(__dirname, '..', 'public');
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const src = CLIENT.slice(CLIENT.indexOf('const GLTF_METAL_NAME'), CLIENT.indexOf('function loadGLTF'));
const { normalizeGltfMaterials } = new Function(src + '; return { normalizeGltfMaterials };')();
const std = (name, metalness, extra) => Object.assign({ isMeshStandardMaterial: true, name, metalness, roughness: 1 }, extra);
const root = (...mats) => ({ traverse(fn) { fn(this); mats.forEach((m) => fn({ isMesh: true, material: m })); } });

test('gltfmat: organic materials exported as metallic=1 are made non-metal; real metals, mapped metals and non-standard materials are left alone', () => {
  const leaf = std('leafsGreen', 1), bark = std('woodBark', 1), stone = std('stone', 1), grass = std('grass', 1);
  const steel = std('steelDark', 1), chrome = std('Chrome_Trim', 0.9), mapped = std('panel', 1, { metalnessMap: {} }), furniture = std('wood', 0), half = std('cloth', 0.4), basic = { name: 'x', metalness: 1 };
  const arr = [std('dirt', 1), std('woodDark', 1)];
  normalizeGltfMaterials(root(leaf, bark, stone, grass, steel, chrome, mapped, furniture, half, basic, arr));
  for (const m of [leaf, bark, stone, grass, ...arr]) assertEqual(m.metalness, 0, m.name + ' -> 0'); assertEqual(steel.metalness, 1, 'named metal kept'); assertEqual(chrome.metalness, 0.9); assertEqual(mapped.metalness, 1, 'metalness map kept'); assertEqual(furniture.metalness, 0); assertEqual(half.metalness, 0.4, 'low metalness untouched'); assertEqual(basic.metalness, 1, 'only MeshStandardMaterial');
});
test('gltfmat: idempotent, null-safe, and shared materials are normalised once (same object seen by every clone)', () => {
  const shared = std('leafsDark', 1); const r = root(shared, shared); normalizeGltfMaterials(r); normalizeGltfMaterials(r); assertEqual(shared.metalness, 0);
  normalizeGltfMaterials({ traverse(fn) { fn({ isMesh: true }); fn({ isMesh: true, material: null }); fn({ isMesh: false, material: shared }); } });
});
test('gltfmat (data): in the shipped GLBs EVERY material with metallicFactor>0.5 is organic (none is metal-named), so the rule changes exactly the audited defect and nothing else', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.glb') ? [path.join(d, e.name)] : []));
  let total = 0, flagged = 0, mapped = 0; const names = new Set();
  for (const f of walk(path.join(PUB, 'models'))) {
    const b = fs.readFileSync(f); const j = JSON.parse(b.slice(20, 20 + b.readUInt32LE(12)).toString('utf8'));
    for (const m of j.materials || []) { total++; const p = m.pbrMetallicRoughness || {}; if (p.metallicRoughnessTexture) mapped++; if ((p.metallicFactor === undefined ? 1 : p.metallicFactor) > 0.5 && !p.metallicRoughnessTexture) { flagged++; names.add(m.name); assert(!/metal|steel|iron|chrome|gold|silver|copper|brass|alumin/i.test(m.name), 'metal-named material would be wrongly zeroed: ' + m.name); } }
  }
  assert(total >= 70, 'GLB materials audited: ' + total); assertEqual(mapped, 0, 'no GLB ships a metal/rough map'); assert(flagged >= 30 && names.has('leafsGreen') && names.has('woodBark') && names.has('dirt') && names.has('stone'), 'the audited defect is real: ' + flagged + ' materials');
});
test('gltfmat (static): applied once per parsed GLB before it is cached; metal accessories take the per-material procedural env (never scene.environment)', () => {
  assert(/normalizeGltfMaterials\(g\.scene\); gltfCache\[url\] = g\.scene;/.test(CLIENT), 'before the cache entry is stored'); assert(!/scene\.environment\s*=/.test(CLIENT), 'no scene-wide environment');
  const acc = CLIENT.slice(CLIENT.indexOf("v.shape === 'model'"), CLIENT.indexOf("v.shape === 'spikes'")); assert(/applyMetalEnv\(ch\.material, 0\.6\)/.test(acc), 'helmet/omnitrix material gets the env');
});
