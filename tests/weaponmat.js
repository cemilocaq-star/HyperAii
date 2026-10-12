// RECONSTRUCTED weapon materials ("all weapons.mtl" is not available): registry, generated MTL, client integration. Rendering itself is NOT VERIFIED.
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const ROOT = path.join(__dirname, '..'), PUB = path.join(ROOT, 'public');
const WM = require(path.join(PUB, 'weaponmat.js'));
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const splitDir = path.join(PUB, 'models/weapons/split'), weaponsDir = path.join(PUB, 'models/weapons');
const objFiles = [...Array.from({ length: 13 }, (_, i) => path.join(splitDir, 'weapon_' + String(i + 1).padStart(3, '0') + '.obj')), path.join(weaponsDir, 'all_weapons.obj')];
const head = (f) => fs.readFileSync(f, 'utf8');

test('weaponmat: every mtllib in the 13 weapon OBJs and all_weapons.obj resolves (exact name, with the space) to a shipped file that is clearly marked RECONSTRUCTED', () => {
  for (const f of objFiles) {
    const refs = head(f).split('\n').filter((l) => l.startsWith('mtllib')).map((l) => l.slice(7).trim()); assert(refs.length >= 1, path.basename(f) + ' has an mtllib');
    for (const r of refs) { const p = path.join(path.dirname(f), r); assert(fs.existsSync(p), path.basename(f) + ' -> "' + r + '" exists'); assert(/^# RECONSTRUCTED \/ GENERATED/.test(head(p)) && /NOT the original/.test(head(p)), 'marked as reconstructed, not original'); }
  }
});
test('weaponmat: every usemtl used by the weapon OBJs has its own entry (or is "None" -> the documented fallback); nothing is silently unmapped', () => {
  const used = new Set(); for (const f of objFiles) for (const l of head(f).split('\n')) if (l.startsWith('usemtl')) used.add(l.slice(7).trim());
  assert(used.size >= 13, 'materials used: ' + [...used].join(','));
  for (const u of used) { if (u === 'None') { assert(WM.forUsemtl('None') === WM.FALLBACK, 'None -> fallback'); continue; } assert(Object.prototype.hasOwnProperty.call(WM.MATERIALS, u), u + ' has a table entry'); assert(WM.forUsemtl(u) === WM.MATERIALS[u]); }
  for (const k of Object.keys(WM.MATERIALS)) assert(used.has(k), k + ' is actually used (no dead entry)');
});
test('weaponmat: the 12 finishes are distinct and valid; weapon_006 and weapon_008 (identical geometry) get DIFFERENT materials; unknown/hostile names fall back', () => {
  const keys = Object.keys(WM.MATERIALS); assertEqual(keys.length, 12); const sig = new Set(); for (const k of keys) { const m = WM.MATERIALS[k]; assert(m.kd.length === 3 && m.kd.every((c) => c >= 0 && c <= 1), k + ' kd range'); assert(m.metalness >= 0 && m.metalness <= 1 && m.roughness >= 0.05 && m.roughness <= 1, k + ' pbr range'); sig.add(JSON.stringify([m.kd, m.metalness, m.roughness])); }
  assertEqual(sig.size, 12, 'no two finishes identical'); const m6 = head(path.join(splitDir, 'weapon_006.obj')).match(/^usemtl (.*)$/m)[1], m8 = head(path.join(splitDir, 'weapon_008.obj')).match(/^usemtl (.*)$/m)[1];
  assert(m6 !== m8 && WM.forUsemtl(m6) !== WM.forUsemtl(m8), '006 vs 008 materials differ (' + m6 + ' / ' + m8 + ')');
  for (const bad of ['__proto__', 'constructor', 'toString', '', null, undefined, 42, 'Material.999']) assert(WM.forUsemtl(bad) === WM.FALLBACK, String(bad) + ' -> fallback');
  assert(Object.isFrozen(WM.MATERIALS) && Object.isFrozen(WM.FALLBACK), 'frozen'); assertEqual(WM.STATUS, 'RECONSTRUCTED');
});
test('weaponmat: the shipped MTL files are exactly what the generator produces from the registry (no drift), and parse back to the registry values', () => {
  const expected = WM.toMtl(); for (const d of [weaponsDir, splitDir]) assertEqual(fs.readFileSync(path.join(d, 'all weapons.mtl'), 'utf8'), expected, d.replace(ROOT, '') + ' matches the generator');
  const blocks = expected.split('newmtl ').slice(1); assertEqual(blocks.length, 13, '12 materials + None');
  for (const b of blocks) { const name = b.split('\n')[0].trim(); const kd = b.match(/^Kd (.*)$/m)[1].split(' ').map(Number), pr = Number(b.match(/^Pr (.*)$/m)[1]), pm = Number(b.match(/^Pm (.*)$/m)[1]); const e = name === 'None' ? WM.FALLBACK : WM.MATERIALS[name]; assert(e, name + ' known');
    kd.forEach((c, i) => assert(Math.abs(c - e.kd[i]) < 1e-3, name + ' Kd')); assert(Math.abs(pr - e.roughness) < 1e-3 && Math.abs(pm - e.metalness) < 1e-3, name + ' Pr/Pm'); assert(!/map_/i.test(b), 'no texture references'); }
  const tool = require(path.join(ROOT, 'tools', 'build_weapon_mtl.js')); assertEqual(tool.DIRS.length, 2);
});
test('weaponmat: tint keeps the finish brightness relative to the procedural metal map (bounded), so the multiply does not blank or blow out a weapon', () => {
  for (const e of [...Object.values(WM.MATERIALS), WM.FALLBACK]) { const t = WM.tint(e); assert(t.every((c) => c >= 0 && c <= 2.5), 'tint bounded'); e.kd.forEach((k, i) => assert(Math.abs(t[i] * WM.MAP_BASE[i] - Math.min(k, 2.5 * WM.MAP_BASE[i])) < 1e-9, 'colour x map == finish')); }
  assert(WM.tint(WM.FALLBACK).every((c) => c > 0.8 && c < 1.2), 'fallback is ~neutral, i.e. the pre-registry look');
});
test('weaponmat (client): the weapon material comes from the OBJ\'s usemtl name through the registry, the placeholder is freed, and nothing else (weaponId mapping, loader) changed', () => {
  assert(CLIENT.indexOf('<script src="weaponmat.js">') > 0 && CLIENT.indexOf('<script src="weaponmat.js">') < CLIENT.indexOf('function loadRealWeapon'), 'script loaded before use');
  const lw = CLIENT.slice(CLIENT.indexOf('function loadRealWeapon'), CLIENT.indexOf('let thorHammerModel')); assert(/BBWeaponMat\.forUsemtl\(srcMat && srcMat\.name\)/.test(lw) && /BBWeaponMat\.tint\(wm\)/.test(lw) && /metalness: wm\.metalness, roughness: wm\.roughness/.test(lw) && /srcMat\.dispose\(\)/.test(lw));
  assert(/objLoader\.load\(weaponModelPath\(want\)/.test(lw), 'still the one existing objLoader'); assert(!/MTLLoader/.test(CLIENT), 'no second loader added');
});
