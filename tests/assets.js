// Asset integration tests (behaviour-checking: real files are parsed, registry/client references are cross-checked).
// Static client checks read public/index.html; they are NOT a browser/3D runtime verification.
const fs = require('fs');
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const ROOT = path.join(__dirname, '..', 'public');
const CLIENT = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Minimal OBJ validator (fan-triangulates, checks indices, NaN/Infinity, zero size, material references).
function parseObj(file) {
  const txt = fs.readFileSync(file, 'utf8'); const v = []; let tris = 0, maxIdx = 0, minIdx = 1e9, bad = 0; const mtllib = [], usemtl = new Set(); let degenerate = 0;
  const tri = [];
  for (const ln of txt.split('\n')) {
    if (ln.startsWith('v ')) { const p = ln.trim().split(/\s+/).slice(1, 4).map(Number); if (p.length < 3 || p.some((x) => !Number.isFinite(x))) bad++; v.push(p); }
    else if (ln.startsWith('f ')) {
      const ids = ln.trim().split(/\s+/).slice(1).map((t) => parseInt(t.split('/')[0], 10));
      for (let k = 1; k < ids.length - 1; k++) { tris++; tri.push([ids[0], ids[k], ids[k + 1]]); }
      for (const i of ids) { if (!(Math.abs(i) >= 1)) bad++; else { const a = i > 0 ? i : v.length + 1 + i; maxIdx = Math.max(maxIdx, a); minIdx = Math.min(minIdx, a); } }
    } else if (ln.startsWith('mtllib')) mtllib.push(ln.slice(6).trim());
    else if (ln.startsWith('usemtl')) usemtl.add(ln.slice(6).trim());
  }
  for (const t of tri) if (t[0] === t[1] || t[1] === t[2] || t[0] === t[2]) degenerate++;
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const p of v) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  return { verts: v.length, tris, maxIdx, minIdx, bad, mtllib, usemtl: [...usemtl], degenerate, size: hi.map((h, i) => h - lo[i]), bytes: txt.length };
}
harness.__parseObj = parseObj;

const MJ = 'models/thor/mjolnir.obj';
test('mjolnir: the ONE logical id (thunderHammer) now points at the NEW model file, which exists and is a valid OBJ', () => {
  assertEqual(T.COSMETICS.thunderHammer.model, MJ);
  const o = parseObj(path.join(ROOT, MJ));
  assert(o.verts > 1000 && o.tris > 1000, 'has geometry'); assertEqual(o.bad, 0, 'no NaN/Infinity/garbage'); assert(o.maxIdx <= o.verts && o.minIdx >= 1, 'all face indices in range');
  assert(o.size.every((s) => s > 0.1), 'no zero-size axis: ' + o.size); assert(o.degenerate === 0, 'no degenerate triangles');
});
test('mjolnir: triangle budget is not heavier than the OLD model (mobile safety) and the file is not the 36 MB source', () => {
  const o = parseObj(path.join(ROOT, MJ)); assert(o.tris <= 71786, 'tris ' + o.tris + ' must be <= old thor.obj (71786)'); assert(o.bytes < 6e6, 'file size ' + o.bytes);
});
test('mjolnir: no broken material reference is shipped (source MTL is missing -> the OBJ must not point at it)', () => {
  const o = parseObj(path.join(ROOT, MJ)); assertEqual(o.mtllib.length, 0, 'no mtllib to a file that does not exist'); assertEqual(o.usemtl.length, 0, 'no usemtl to undefined materials');
});
test('mjolnir: client loads the same file through the existing ensureThorHammer path; old thor.obj is no longer loaded', () => {
  const m = CLIENT.match(/const MJOLNIR_MODEL = \{ path: '([^']+)'/); assert(m, 'MJOLNIR_MODEL defined'); assertEqual(m[1], T.COSMETICS.thunderHammer.model, 'client path == server registry path');
  assert(/objLoader\.load\(MJOLNIR_MODEL\.path/.test(CLIENT), 'loader uses MJOLNIR_MODEL');
  assert(!/models\/thor\/thor\.obj/.test(CLIENT), 'client must not reference the old model'); assert(!/thor_color\.jpg|thor_normal\.jpg/.test(CLIENT), 'old textures not referenced');
  assertEqual((CLIENT.match(/function ensureThorHammer/g) || []).length, 1, 'exactly one loader'); assertEqual((CLIENT.match(/thorHammerModel = pivot/g) || []).length, 1, 'exactly one runtime entity');
});
test('mjolnir: no duplicate Mjolnir entity — one cosmetic/effect id, Thor achievement + unlock stay connected', () => {
  const ids = Object.keys(T.COSMETICS).filter((k) => /mjolnir|thunder.?hammer|thor/i.test(k)); assertEqual(ids.join(','), 'thunderHammer', 'exactly one Mjolnir-like cosmetic');
  assert(T.ACHIEVEMENTS.thunder_hammer_survivor.grants.includes('thunderHammer'), 'Thor achievement still grants the Mjolnir effect');
  assertEqual(T.COSMETICS.thunderHammer.type, 'deathEffect'); assertEqual(T.COSMETICS.thunderHammer.enabled, true);
});
test('mjolnir: placement keeps the OLD on-screen size (~8.4 units) and orientation (static placement math, not a render check)', () => {
  const o = parseObj(path.join(ROOT, MJ)); const sc = Number(CLIENT.match(/scale: ([0-9.]+), rotZ/)[1]); const len = Math.max(...o.size) * sc;
  assert(len > 7.5 && len < 9.5, 'world length ' + len.toFixed(2) + ' vs old ~8.4'); assert(/rotZ: -Math\.PI \/ 2/.test(CLIENT), 'head up (+Y), handle down, spin axis preserved');
  const mjBlk = CLIENT.slice(CLIENT.indexOf('function ensureThorHammer'), CLIENT.indexOf('function flashLightning')); assert(/getCenter\(new THREE\.Vector3\(\)\)/.test(mjBlk), 'Mjolnir pivot centred (checked inside ensureThorHammer only — the Omnitrix builder has the same call)');
});
test('mjolnir: old thor.obj was deleted on user request (2026-10-09); its textures are still kept; nothing references it', () => {
  assert(!fs.existsSync(path.join(ROOT, 'models/thor', 'thor.obj')), 'thor.obj must stay deleted');
  for (const f of ['thor_color.jpg', 'thor_normal.jpg']) assert(fs.existsSync(path.join(ROOT, 'models/thor', f)), f + ' kept on disk');
  assert(!fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes("models/thor/thor.obj'"), 'server does not reference the old model');
});

// ---- staged assets: SurvivalKnife + Grenade (no melee/throwable gameplay exists -> asset-only, not equippable) ----
const { WEAPONS, WEAPON_ASSET_STAGING: STAGE } = T;
test('staging: knife + grenade files exist, parse as valid OBJ, and have no broken material references', () => {
  for (const a of Object.values(STAGE)) {
    const f = path.join(ROOT, a.model); assert(fs.existsSync(f), a.id + ' model missing'); const o = parseObj(f);
    assert(o.tris > 500 && o.bad === 0 && o.maxIdx <= o.verts && o.minIdx >= 1, a.id + ' invalid OBJ'); assert(o.size.every((s) => s > 0), a.id + ' zero-size axis');
    for (const m of o.mtllib) assert(fs.existsSync(path.join(path.dirname(f), m)), a.id + ' mtllib ' + m + ' missing (case-sensitive)');
  }
  assertEqual(parseObj(path.join(ROOT, STAGE.knife_01.model)).mtllib.length, 0, 'knife ships no reference to its missing MTL');
});
test('staging: grenade MTL defines every material its OBJ uses and references no (missing) texture file', () => {
  const dir = path.join(ROOT, 'models/weapons/throwable/grenade'); const used = new Set([...fs.readFileSync(path.join(dir, 'Grenade.obj'), 'utf8').matchAll(/^usemtl\s+(\S+)/gm)].map((m) => m[1]));
  const mtl = fs.readFileSync(path.join(dir, 'Grenade.mtl'), 'utf8'); const def = new Set([...mtl.matchAll(/^newmtl\s+(\S+)/gm)].map((m) => m[1]));
  for (const u of used) assert(def.has(u), 'undefined material ' + u); assert(!/^\s*map_/m.test(mtl), 'no texture maps to resolve');
});
test('staging: asset-only entries are NOT gameplay weapons — WEAPONS stays the 13 real models and equip_weapon rejects them', () => {
  assertEqual(Object.keys(WEAPONS).length, 13); for (const id of Object.keys(STAGE)) { assertEqual(T.getWeapon(id), null, id + ' must not resolve as a weapon'); assertEqual(STAGE[id].equippable, false); assertEqual(STAGE[id].status, 'ASSET_ONLY'); }
  const models = [...Object.values(WEAPONS), ...Object.values(STAGE)].map((w) => w.model); assertEqual(new Set(models).size, models.length, 'no model file is bound twice');
  assert(Object.isFrozen(STAGE) && Object.isFrozen(STAGE.knife_01), 'staging is immutable');
});
test('staging: a client cannot equip a staged asset (server rejects knife_01 / grenade_01 as UNKNOWN_WEAPON)', () => {
  const { connect, hello } = harness; const h = connect('h'); hello(h); h.emitMessage({ type: 'create_room', name: 'A', maxPlayers: 4 }); const g = connect('g'); hello(g);
  g.emitMessage({ type: 'join_room', roomCode: h.lastOfType('room_created').code, name: 'B' }); g.emitMessage({ type: 'player_ready' }); h.emitMessage({ type: 'start_game' });
  for (const id of ['knife_01', 'grenade_01']) { h.emitMessage({ type: 'equip_weapon', weaponId: id }); const r = h.lastOfType('weapon_rejected'); assert(r && r.reason === 'UNKNOWN_WEAPON', id + ' must be rejected'); }
  T.shutdownAllRooms();
});

// ---- Omnitrix: first MODEL-BASED accessory (extends the existing accessory slot; no second accessory renderer) ----
const OM = 'accessoryOmnitrix';
test('omnitrix: registry entry is well-formed, free, enabled and uses the existing accessory slot', () => {
  const c = T.COSMETICS[OM]; assert(c, 'registered'); assertEqual(c.id, OM); assertEqual(c.type, 'accessory'); assertEqual(c.enabled, true); assertEqual(c.unlockRequirement, null, 'free (no unlock was specified)');
  assertEqual(c.visual.shape, 'model'); assert(/^#[0-9a-f]{6}$/i.test(c.visual.color), 'preview colour'); assert(typeof c.visual.palette === 'object' && c.visual.palette.default, 'palette has a default');
  for (const [k, v] of Object.entries(c.visual.palette)) assert(/^#[0-9a-f]{6}$/i.test(v), 'palette ' + k);
});
test('omnitrix: model file is a valid, mobile-light OBJ with no broken material reference, and every material has a palette colour', () => {
  const v = T.COSMETICS[OM].visual; const f = path.join(ROOT, v.model); assert(fs.existsSync(f), 'model exists'); const o = parseObj(f);
  assert(o.tris > 500 && o.tris <= 3000, 'tris ' + o.tris); assertEqual(o.bad, 0); assert(o.maxIdx <= o.verts && o.minIdx >= 1, 'indices in range'); assertEqual(o.mtllib.length, 0, 'no mtllib to a missing file');
  assert(o.usemtl.length >= 2, 'materials preserved per object'); for (const m of o.usemtl) assert(v.palette[m] || v.palette.default, 'no colour for material ' + m);
  const len = Math.max(...o.size) * v.scale; assert(len > 0.2 && len < 0.5, 'worn size ' + len.toFixed(3) + ' world units (capsule radius 0.4)');
});
test('omnitrix: no real source object was lost by decimation (all 22 non-empty objects survive)', () => {
  const names = (p) => { const d = {}; let cur = null; for (const ln of fs.readFileSync(p, 'utf8').split('\n')) { if (ln.startsWith('o ')) { cur = ln.slice(2).trim(); d[cur] = 0; } else if (ln.startsWith('f ') && cur) d[cur]++; } return d; };
  const out = names(path.join(ROOT, T.COSMETICS[OM].visual.model)); assertEqual(Object.keys(out).length, 22); assert(Object.values(out).every((n) => n > 0), 'every kept object has faces');
});
test('omnitrix: equip through the real server flow is synced to the public state, never leaks to another room, and a RECONNECTED player gets it back in the live state tick', async () => {
  const { connect, hello } = harness; const a = connect('a'); const at = hello(a); a.emitMessage({ type: 'create_room', maxPlayers: 4 }); const code = a.lastOfType('room_created').code;
  const b = connect('b'); hello(b); b.emitMessage({ type: 'join_room', roomCode: code }); b.emitMessage({ type: 'player_ready' });
  const o = connect('o'); hello(o); o.emitMessage({ type: 'create_room', maxPlayers: 4 }); const other = o.lastOfType('room_created').code;
  a.emitMessage({ type: 'equip_cosmetic', cosmeticId: OM }); assertEqual(a.lastOfType('equip_ok').cosmeticId, OM);
  assertEqual(T.buildPlayerPublicState(T.rooms[code], T.rooms[code].players[at]).accessory, OM, 'public state carries the accessory id');
  for (const p of Object.values(T.rooms[other].players)) assertEqual(T.buildPlayerPublicState(T.rooms[other], p).accessory, 'accessoryNone', 'other room unaffected');
  const saved = T.MATCH_CONFIG.countdownMs; T.MATCH_CONFIG.countdownMs = 0; try { a.emitMessage({ type: 'start_game' }); } finally { T.MATCH_CONFIG.countdownMs = saved; }
  assert(T.rooms[code].started, 'game started');
  T.rooms[code].players[at].connected = false; // socket dropped
  const a2 = connect('a2'); a2.emitMessage({ type: 'hello', token: at }); // same token = reconnect
  assertEqual(T.rooms[code].players[at].connected, true, 'marked connected again');
  let st = null; for (let i = 0; i < 40 && !st; i++) { await new Promise((r) => setTimeout(r, 50)); const m = a2.lastOfType('state'); if (m && m.players && m.players[at]) st = m.players[at]; }
  assert(st, 'reconnected client received a live state tick'); assertEqual(st.accessory, OM, 'accessory is in the tick state the reconnected client receives'); T.shutdownAllRooms();
});
test('omnitrix: invalid / wrong-type ids are rejected and never reach the model path', () => {
  const { connect, hello } = harness; const a = connect('a'); const at = hello(a); a.emitMessage({ type: 'create_room', maxPlayers: 4 }); const code = a.lastOfType('room_created').code;
  for (const bad of ['accessoryOmnitrix ', 'ACCESSORYOMNITRIX', '../../etc/passwd', { id: OM }, ['x'], null, 12, 'models/accessories/omnitrix/omnitrix.obj', '__proto__']) a.emitMessage({ type: 'equip_cosmetic', cosmeticId: bad });
  assertEqual(T.rooms[code].players[at].equippedAccessory, 'accessoryNone'); T.shutdownAllRooms();
});
test('omnitrix client (static): model accessories are built by the EXISTING buildCosmeticPart + objLoader (no second loader/renderer), with a dispose guard', () => {
  const blk = CLIENT.slice(CLIENT.indexOf("v.shape === 'model'"), CLIENT.indexOf("v.shape === 'spikes'"));
  assert(/objLoader\.load\(v\.model/.test(blk), 'uses the existing objLoader'); assert(/root !== scene/.test(blk) && /disposeObject3D\(m\)/.test(blk), 'late-load dispose guard');
  assert(/pal\[ch\.material && ch\.material\.name\]/.test(blk) && /pal\.default/.test(blk), 'palette by usemtl name with default');
  assertEqual((CLIENT.match(/new THREE\.OBJLoader\(\)/g) || []).length, 1, 'still exactly one OBJLoader');
});

// ---- Helmet: converted from .blend WITHOUT Blender (tools/blend_export.py). ASSET-ONLY: not in the cosmetic registry. ----
const HEL = path.join(ROOT, 'models/accessories/helmet');
test('helmet (asset-only): converted OBJ is valid, has UVs for the meshes that carry them, and its texture is a real JPEG', () => {
  const o = parseObj(path.join(HEL, 'helmet.obj')); assert(o.tris > 300 && o.tris < 1500, 'tris ' + o.tris); assertEqual(o.bad, 0); assert(o.maxIdx <= o.verts && o.minIdx >= 1, 'indices in range'); assertEqual(o.mtllib.length, 0);
  const src = fs.readFileSync(path.join(HEL, 'helmet.obj'), 'utf8'); assert((src.match(/^vt /gm) || []).length > 100, 'UV coordinates present'); assert(/^o Head$/m.test(src) && /^o Mask$/m.test(src), 'original object names kept');
  const j = fs.readFileSync(path.join(HEL, 'corroded_metal_texture_by_ketronpl-d6mnkhy.jpg')); assertEqual(j.slice(0, 3).toString('hex'), 'ffd8ff', 'real JPEG magic');
});
test('helmet (accessory, requested by the maintainer): registered in the EXISTING accessory slot with its converted model, the real texture file and explicit placement (scale/rotation/offset)', () => {
  const c = T.COSMETICS.accessoryHelmet; assert(c, 'registered'); assertEqual(c.type, 'accessory'); assertEqual(c.enabled, true); assertEqual(c.visual.shape, 'model'); assertEqual(c.visual.model, 'models/accessories/helmet/helmet.obj');
  assert(fs.existsSync(path.join(ROOT, c.visual.model)), 'model file'); const j = fs.readFileSync(path.join(ROOT, c.visual.texture)); assertEqual(j.slice(0, 3).toString('hex'), 'ffd8ff', 'texture is a real JPEG');
  assert(Math.abs(c.visual.rotX + Math.PI / 2) < 1e-3 && Math.abs(c.visual.rotY - Math.PI) < 1e-3, 'Blender Z-up -> Y-up, mask (-Y) turned to the player forward'); assert(c.visual.scale > 0 && c.visual.scale < 0.3 && c.visual.y > 0.3 && c.visual.y < 1.0, 'placement fields are explicit and inside the capsule head region');
  const o = parseObj(path.join(ROOT, c.visual.model)); const h = Math.max(...o.size) * c.visual.scale; assert(h > 0.3 && h < 0.8, 'worn height ' + h.toFixed(2) + ' (capsule head ~0.8 wide)');
  assertEqual(Object.keys(T.COSMETICS).filter((k) => T.COSMETICS[k].visual && T.COSMETICS[k].visual.model === c.visual.model).length, 1, 'only one cosmetic uses the helmet file');
});
test('helmet (accessory): equip goes through the real server flow, reaches the public state, never leaks to another room, invalid ids never reach the model path', () => {
  const { connect, hello } = harness; const a = connect('a'); const at = hello(a); a.emitMessage({ type: 'create_room', maxPlayers: 4 }); const code = a.lastOfType('room_created').code; const o = connect('o'); hello(o); o.emitMessage({ type: 'create_room', maxPlayers: 4 }); const other = o.lastOfType('room_created').code;
  a.emitMessage({ type: 'equip_cosmetic', cosmeticId: 'accessoryHelmet' }); assertEqual(a.lastOfType('equip_ok').cosmeticId, 'accessoryHelmet'); assertEqual(T.buildPlayerPublicState(T.rooms[code], T.rooms[code].players[at]).accessory, 'accessoryHelmet');
  for (const p of Object.values(T.rooms[other].players)) assertEqual(T.buildPlayerPublicState(T.rooms[other], p).accessory, 'accessoryNone', 'other room unaffected');
  for (const bad of ['accessoryHelmet ', 'ACCESSORYHELMET', 'models/accessories/helmet/helmet.obj', '../accessoryHelmet', null, 5, { id: 'accessoryHelmet' }]) a.emitMessage({ type: 'equip_cosmetic', cosmeticId: bad }); assertEqual(T.rooms[code].players[at].equippedAccessory, 'accessoryHelmet', 'unchanged by invalid ids'); T.shutdownAllRooms();
});
test('helmet client (static): the model branch applies rotX before centring, rotY on the holder, and the texture ONLY to meshes that have UVs, through one shared texture per file', () => {
  const blk = CLIENT.slice(CLIENT.indexOf("v.shape === 'model'"), CLIENT.indexOf("v.shape === 'spikes'"));
  assert(/hasUV = !!\(ch\.geometry && ch\.geometry\.attributes && ch\.geometry\.attributes\.uv\)/.test(blk) && /map: tex && hasUV \? tex : null/.test(blk), 'texture only where UVs exist'); assert(/if \(v\.rotX\) m\.rotation\.x = v\.rotX;/.test(blk) && blk.indexOf('m.rotation.x = v.rotX') < blk.indexOf('getCenter'), 'rotX before the pivot is centred');
  assert(/holder\.rotation\.y = v\.rotY \|\| 0/.test(blk), 'rotY on the holder'); assert(/function getSharedTexture\(url\)/.test(CLIENT) && /sharedTextures\[url\]/.test(CLIENT), 'shared texture cache'); assertEqual((CLIENT.match(/new THREE\.OBJLoader\(\)/g) || []).length, 1, 'still one OBJLoader');
  const uvCount = (fs.readFileSync(path.join(ROOT, 'models/accessories/helmet/helmet.obj'), 'utf8').match(/^vt /gm) || []).length; assert(uvCount > 100, 'the converted OBJ really carries UVs for the textured meshes');
});

// ---- RAR extraction tool (tools/rar_extract.py -> system libarchive via ctypes). A minimal RAR4 archive is BUILT here by hand. ----
const zlib = require('zlib'); const os = require('os'); const { execFileSync, spawnSync } = require('child_process');
function buildRar4(files, corruptData, declaredUnpSize) {
  const parts = [Buffer.from('526172211a0700', 'hex')];
  const hdr = (type, flags, body) => { const size = 7 + body.length; const b = Buffer.alloc(size); b.writeUInt8(type, 2); b.writeUInt16LE(flags, 3); b.writeUInt16LE(size, 5); body.copy(b, 7); b.writeUInt16LE(zlib.crc32 ? zlib.crc32(b.slice(2)) & 0xffff : crc32(b.slice(2)) & 0xffff, 0); return b; };
  parts.push(hdr(0x73, 0, Buffer.alloc(6)));
  for (const [name, data] of files) {
    const nm = Buffer.from(name); const body = Buffer.alloc(25 + nm.length);
    body.writeUInt32LE(data.length, 0); body.writeUInt32LE(declaredUnpSize === undefined ? data.length : declaredUnpSize, 4); body.writeUInt8(2, 8); body.writeUInt32LE(crc32(data) >>> 0, 9); body.writeUInt32LE(0x5a21_0000 >>> 0, 13);
    body.writeUInt8(29, 17); body.writeUInt8(0x30, 18); body.writeUInt16LE(nm.length, 19); body.writeUInt32LE(0x20, 21); nm.copy(body, 25);
    parts.push(hdr(0x74, 0x8000, body)); const dd = Buffer.from(data); if (corruptData) dd[0] ^= 0xff; parts.push(dd);
  }
  parts.push(Buffer.from('c43d7b00400700', 'hex')); return Buffer.concat(parts);
}
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
const HAVE_LIBARCHIVE = spawnSync('python3', ['-c', "import ctypes; ctypes.CDLL('libarchive.so.13')"]).status === 0;
test('rar tool: a hand-built RAR4 archive is really extracted (content byte-identical, header CRC32 matches); skipped ONLY if libarchive is absent', () => {
  if (!HAVE_LIBARCHIVE) { console.log('        SKIPPED — libarchive.so.13 not available on this machine'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-')); const payload = Buffer.from('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'.repeat(50)); const rar = path.join(tmp, 't.rar');
  fs.writeFileSync(rar, buildRar4([['model/tri.obj', payload], ['readme.txt', Buffer.from('hello')]]));
  const out = execFileSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract.py'), rar, path.join(tmp, 'o')]).toString();
  assert(/files 2 ok 2 error: None/.test(out), 'tool output: ' + out); assertEqual(Buffer.compare(fs.readFileSync(path.join(tmp, 'o/model/tri.obj')), payload), 0, 'payload identical'); assertEqual(fs.readFileSync(path.join(tmp, 'o/readme.txt'), 'utf8'), 'hello');
});
test('rar tool: a damaged archive is REPORTED (non-OK / error), never silently treated as extracted', () => {
  if (!HAVE_LIBARCHIVE) { console.log('        SKIPPED — libarchive.so.13 not available on this machine'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-')); const rar = path.join(tmp, 'bad.rar'); const full = buildRar4([['a.bin', Buffer.alloc(4096, 7)]]);
  fs.writeFileSync(rar, full.slice(0, full.length - 3000)); // truncated payload
  const out = execFileSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract.py'), rar, path.join(tmp, 'o')]).toString();
  assert(!/files 1 ok 1 error: None/.test(out), 'a truncated archive must not be reported as fully OK: ' + out);
});
// Added after mutation testing (survivor "rartool: truncated data reported as OK"): the header-level truncation test never reached the
// data/CRC check. Here the header is valid but the stored payload is corrupted, so only the CRC/size handling can catch it.
test('rar tool: valid header but CORRUPTED payload (CRC mismatch) is reported, never as a clean extraction', () => {
  if (!HAVE_LIBARCHIVE) { console.log('        SKIPPED — libarchive.so.13 not available on this machine'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-')); const rar = path.join(tmp, 'crc.rar'); fs.writeFileSync(rar, buildRar4([['a.bin', Buffer.alloc(4096, 7)]], true));
  const out = execFileSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract.py'), rar, path.join(tmp, 'o')]).toString();
  assert(!/files 1 ok 1 error: None/.test(out), 'CRC-corrupted payload must not be reported as OK: ' + out);
  const ctl = path.join(tmp, 'ok.rar'); fs.writeFileSync(ctl, buildRar4([['a.bin', Buffer.alloc(4096, 7)]], false));
  assert(/files 1 ok 1 error: None/.test(execFileSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract.py'), ctl, path.join(tmp, 'o2')]).toString()), 'control: the same archive without corruption extracts cleanly');
});

// Added after the full mutation re-run (survivor "rartool: short read accepted"): no test produced a size mismatch WITHOUT a libarchive error.
test('rar tool: declared size larger than the data actually extracted is reported as SHORT (no libarchive error is involved)', () => {
  if (!HAVE_LIBARCHIVE) { console.log('        SKIPPED — libarchive.so.13 not available on this machine'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rar-')); const data = Buffer.alloc(500, 120);
  fs.writeFileSync(path.join(tmp, 'ok.rar'), buildRar4([['a.bin', data]])); fs.writeFileSync(path.join(tmp, 'short.rar'), buildRar4([['a.bin', data]], false, 900));
  assert(/files 1 ok 1 error: None/.test(execFileSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract.py'), path.join(tmp, 'ok.rar'), path.join(tmp, 'o1')]).toString()), 'control extracts cleanly');
  const out = execFileSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract.py'), path.join(tmp, 'short.rar'), path.join(tmp, 'o2')]).toString();
  assert(/SHORT\(500\/900\)/.test(out) && !/files 1 ok 1/.test(out), 'size mismatch must be reported: ' + out);
});

// ================= own RAR3 decoder (tools/rar3ppm.c) + full extractor (tools/rar_extract_full.py) =================
// Why it exists: system libarchive mis-decodes IronMan.obj at a PPMd->LZ block switch and cannot run VM filters. The decoder was verified against the
// CRC32 stored in the RAR headers of ALL 368 files of the 5 archives (IronMan.obj cd8968fb, .max ec6f106e, ...). These tests keep two small REAL fixtures.
const FXD = path.join(__dirname, 'fixtures'); const FXMETA = JSON.parse(fs.readFileSync(path.join(FXD, 'ironman_rar_expected.json'), 'utf8'));
const cpx = require('child_process'); const osx = require('os'); const zl = require('zlib');
const gccOk = cpx.spawnSync('gcc', ['--version']).status === 0 && cpx.spawnSync('python3', ['--version']).status === 0;
const crc32hex = (b) => (zl.crc32(b) >>> 0).toString(16).padStart(8, '0');
function buildDecoder() { const exe = path.join(osx.tmpdir(), 'rar3ppm_test_' + process.pid); const r = cpx.spawnSync('gcc', ['-O2', '-w', '-o', exe, path.join(__dirname, '..', 'tools', 'rar3ppm.c')], { encoding: 'utf8' }); assertEqual(r.status, 0, r.stderr); return exe; }
test('rar3ppm: PPMd var.H + escape-4 copy decode a REAL RAR stream to the CRC32 stored in its header (IronMan.mtl)', () => {
  if (!gccOk) { console.log('       SKIPPED — gcc/python3 not available in this environment'); return; }
  const tmp = fs.mkdtempSync(path.join(osx.tmpdir(), 'rx-')); const r = cpx.spawnSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract_full.py'), path.join(FXD, 'ironman_mtl.rar'), tmp], { encoding: 'utf8' });
  assertEqual(r.status, 0, r.stdout + r.stderr); assert(/files 1 crc-verified ok 1/.test(r.stdout), r.stdout);
  const out = fs.readFileSync(path.join(tmp, 'IronMan', 'IronMan.mtl')); assertEqual(out.length, FXMETA.mtl.unp); assertEqual(crc32hex(out), FXMETA.mtl.crc); assert(out.toString('latin1').startsWith('# Max2Mtl Version 4.0'), 'text is the real MTL');
});
test('rar3ppm: LZ blocks (incl. a keep-old-tables table read) + VM DELTA filters decode a REAL stream prefix to the expected bytes', () => {
  if (!gccOk) { console.log('       SKIPPED — gcc/python3 not available in this environment'); return; }
  const exe = buildDecoder(); const tmp = fs.mkdtempSync(path.join(osx.tmpdir(), 'rx-')); const o = path.join(tmp, 'o.bin');
  const r = cpx.spawnSync(exe, [path.join(FXD, 'ironman_max_prefix.bin'), String(FXMETA.max_prefix.unp), o], { encoding: 'utf8' });
  assert(/status=OK/.test(r.stdout) && new RegExp('produced=' + FXMETA.max_prefix.unp).test(r.stdout), r.stdout); assert(new RegExp('applied=' + FXMETA.max_prefix.filters_applied).test(r.stderr), 'filters: ' + r.stderr);
  assertEqual(crc32hex(fs.readFileSync(o).subarray(0, FXMETA.max_prefix.verify_bytes)), FXMETA.max_prefix.crc_first_verify_bytes);
});
test('rar_extract_full: a corrupted stream is REPORTED as FAILED (CRC mismatch) and no file is written — never a silent "success"', () => {
  if (!gccOk) { console.log('       SKIPPED — gcc/python3 not available in this environment'); return; }
  const tmp = fs.mkdtempSync(path.join(osx.tmpdir(), 'rx-')); const raw = Buffer.from(fs.readFileSync(path.join(FXD, 'ironman_mtl.rar'))); raw[raw.length - 40] ^= 0x55; fs.writeFileSync(path.join(tmp, 'bad.rar'), raw);
  const r = cpx.spawnSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract_full.py'), path.join(tmp, 'bad.rar'), path.join(tmp, 'out')], { encoding: 'utf8' });
  assert(r.status !== 0, 'non-zero exit on corruption'); assert(/FAILED/.test(r.stdout), r.stdout); assert(!fs.existsSync(path.join(tmp, 'out', 'IronMan', 'IronMan.mtl')), 'no output file for a failed entry');
});
test('rar_extract_full: truncated archive and non-RAR input fail loudly', () => {
  if (!gccOk) { console.log('       SKIPPED — gcc/python3 not available in this environment'); return; }
  const tmp = fs.mkdtempSync(path.join(osx.tmpdir(), 'rx-')); fs.writeFileSync(path.join(tmp, 'junk.rar'), Buffer.from('not a rar'));
  const r = cpx.spawnSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract_full.py'), path.join(tmp, 'junk.rar'), path.join(tmp, 'o')], { encoding: 'utf8' }); assert(r.status !== 0, 'junk must not exit 0');
  fs.writeFileSync(path.join(tmp, 'cut.rar'), fs.readFileSync(path.join(FXD, 'ironman_mtl.rar')).subarray(0, 200));
  const t = cpx.spawnSync('python3', [path.join(__dirname, '..', 'tools', 'rar_extract_full.py'), path.join(tmp, 'cut.rar'), path.join(tmp, 'o2')], { encoding: 'utf8' }); assert(t.status !== 0 || /FAILED|files 0/.test(t.stdout), 'truncated archive is not reported as success: ' + t.stdout);
});

// ================= tools/bake_skin.py (relative OBJ indices regression) =================
test('bake_skin: handles NEGATIVE (relative) OBJ face indices like the Pilot model — output has valid indices, the right shape, feet on y=0 and the requested height', () => {
  const pyOk = cpx.spawnSync('python3', ['-c', 'import numpy']).status === 0; if (!pyOk) { console.log('       SKIPPED — python3/numpy not available'); return; }
  const tmp = fs.mkdtempSync(path.join(osx.tmpdir(), 'bk-')); const v = []; for (const x of [-1, 1]) for (const y of [0, 4]) for (const z of [-1, 1]) v.push(`v ${x} ${y} ${z}`);
  const f = ['f -8 -4 -2', 'f -8 -2 -6', 'f -7 -5 -1', 'f -7 -1 -3', 'f -8 -7 -3', 'f -8 -3 -4', 'f -6 -2 -1', 'f -6 -1 -5', 'f -8 -6 -5', 'f -8 -5 -7', 'f -4 -3 -1', 'f -4 -1 -2']; // one block of 8 vertices, every index relative
  fs.writeFileSync(path.join(tmp, 'a.obj'), ['mtllib a.mtl', 'usemtl red', ...v, ...f].join('\n') + '\n'); fs.writeFileSync(path.join(tmp, 'a.mtl'), 'newmtl red\nKd 0.8 0.1 0.1\n');
  const r = cpx.spawnSync('python3', [path.join(__dirname, '..', 'tools', 'bake_skin.py'), path.join(tmp, 'a.obj'), path.join(tmp, 'a.mtl'), path.join(tmp, 'o.obj'), '--target', '100', '--height', '1.8'], { encoding: 'utf8' });
  assertEqual(r.status, 0, r.stderr); const o = parseObj(path.join(tmp, 'o.obj')); assertEqual(o.bad, 0); assert(o.maxIdx <= o.verts && o.minIdx >= 1, 'indices in range'); assert(o.tris >= 6, 'tris ' + o.tris);
  assert(Math.abs(o.size[1] - 1.8) < 1e-3, 'height ' + o.size[1]); assert(o.size[0] < 1.8 && o.size[2] < 1.8, 'x/z not blown up (wrong relative-index resolution would stretch them): ' + o.size);
  const cols = fs.readFileSync(path.join(tmp, 'o.obj'), 'utf8').split('\n').filter((l) => l.startsWith('v ')).map((l) => l.split(' ').slice(4, 7).map(Number)); assert(cols.every((c) => c.length === 3 && Math.abs(c[0] - 0.8) < 0.01 && Math.abs(c[1] - 0.1) < 0.01), 'MTL Kd baked into vertex colours');
});

// ================= full-body model skins (IronMan / Vader / Pilot): baked meshes in the existing skin slot =================
const SKINS = { skinIronMan: 'models/skins/ironman/ironman.obj', skinVader: 'models/skins/vader/vader.obj', skinPilot: 'models/skins/pilot/pilot.obj', skinSkeleton: 'models/skins/skeleton/skeleton.obj' };
test('skins: each registered in the EXISTING skin slot, enabled, with a unique model file that exists', () => {
  const files = new Set();
  for (const [id, model] of Object.entries(SKINS)) { const c = T.COSMETICS[id]; assert(c, id + ' registered'); assertEqual(c.type, 'skin'); assertEqual(c.enabled, true); assertEqual(c.visual.shape, 'bodyModel'); assertEqual(c.visual.model, model); assert(fs.existsSync(path.join(ROOT, model)), id + ' file'); files.add(model); }
  assertEqual(files.size, Object.keys(SKINS).length, 'no model file is shared by two skins'); assertEqual(Object.keys(T.COSMETICS).filter((k) => T.COSMETICS[k].visual && T.COSMETICS[k].visual.shape === 'bodyModel').length, Object.keys(SKINS).length, 'every body-model cosmetic is covered by this test');
});
test('skins: baked meshes are valid, mobile-light, ONE mesh with per-vertex colours, y-up, feet on y=0 and player height (not a render check)', () => {
  for (const model of Object.values(SKINS)) {
    const f = path.join(ROOT, model); const o = parseObj(f); assertEqual(o.bad, 0, model); assert(o.maxIdx <= o.verts && o.minIdx >= 1, model + ' indices'); assert(o.tris >= 3000 && o.tris <= 6500, model + ' tris ' + o.tris);
    assertEqual(o.mtllib.length, 0); assertEqual(o.usemtl.length, 0, 'single mesh: no per-material draw calls'); assert(fs.statSync(f).size < 450000, model + ' file size');
    const L = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('v ')); const rows = L.map((l) => l.split(' ').slice(1).map(Number)); assert(rows.every((r) => r.length === 6 && r.every(Number.isFinite)), model + ' every vertex has x y z r g b');
    assert(rows.every((r) => r[3] >= 0 && r[3] <= 1 && r[4] >= 0 && r[4] <= 1 && r[5] >= 0 && r[5] <= 1), model + ' colours in [0,1]'); const variety = new Set(rows.map((r) => r.slice(3).map((c) => Math.round(c * 100)).join())).size; const id = Object.keys(SKINS).find((k) => SKINS[k] === model);
    if (T.COSMETICS[id].visual.flatColor) assertEqual(variety, 1, model + ' is declared flatColor, so it must be ONE colour (single source material, no texture)'); else assert(variety >= 4, model + ' has colour variety (not a flat blob): ' + variety);
    const ys = rows.map((r) => r[1]); assert(Math.abs(Math.min(...ys)) < 1e-3 && Math.abs(Math.max(...ys) - 1.8) < 1e-2, model + ' feet y=0, height 1.8: ' + Math.min(...ys) + '..' + Math.max(...ys));
  }
});
test('skins: equip through the real server flow reaches the public state, never leaks to another room, and invalid ids never reach a model path', () => {
  const { connect, hello } = harness; const a = connect('a'); const at = hello(a); a.emitMessage({ type: 'create_room', maxPlayers: 4 }); const code = a.lastOfType('room_created').code; const o = connect('o'); hello(o); o.emitMessage({ type: 'create_room', maxPlayers: 4 }); const other = o.lastOfType('room_created').code;
  for (const id of Object.keys(SKINS)) { a.emitMessage({ type: 'equip_cosmetic', cosmeticId: id }); assertEqual(a.lastOfType('equip_ok').cosmeticId, id); assertEqual(T.buildPlayerPublicState(T.rooms[code], T.rooms[code].players[at]).skin, id); }
  for (const p of Object.values(T.rooms[other].players)) assertEqual(T.buildPlayerPublicState(T.rooms[other], p).skin, 'skinDefault', 'other room unaffected');
  for (const bad of ['skinVader ', 'SKINVADER', 'models/skins/vader/vader.obj', '../skinVader', { id: 'skinVader' }, null, 7]) a.emitMessage({ type: 'equip_cosmetic', cosmeticId: bad }); assertEqual(T.rooms[code].players[at].equippedSkin, Object.keys(SKINS).at(-1), 'unchanged by invalid ids (still the last valid skin)'); T.shutdownAllRooms();
});
test('skins client (static): body models replace the capsule only in FFA, reuse the existing objLoader, guard late loads, fall back to the capsule on error, and every tint path reaches the model', () => {
  const blk = CLIENT.slice(CLIENT.indexOf('function applyBodyModel'), CLIENT.indexOf('function applyRemoteCosmetics'));
  assert(/p\.mode !== 'team' && p\.mode !== 'zombie'/.test(blk), 'FFA only'); assert(/loadObjShared\(sv\.model/.test(blk), 'skins load through the shared cache'); { const sh = CLIENT.slice(CLIENT.indexOf('function loadObjShared'), CLIENT.indexOf('function remoteBodyColor')); assert(/objLoader\.load\(url/.test(sh) && !/new THREE\.OBJLoader/.test(sh), 'the shared cache goes through the EXISTING objLoader (no second loader)'); } assert(/r\.bodyModel !== holder\) \{ disposeObject3D\(m\)/.test(blk), 'late-load guard');
  assert(/r\.mesh\.material\.visible = true/.test(blk), 'fallback on load error'); assert(/vertexColors: true/.test(blk), 'vertex colours used');
  assert(/\[p\.skin, p\.outfit, p\.head, p\.hair, p\.accessory, p\.mode\]/.test(CLIENT), 'cosmetic signature includes mode'); assert((CLIENT.match(/tintBodyModel\(/g) || []).length >= 6, 'ogre/pinkPop/team/refresh tints reach the model');
  assertEqual((CLIENT.match(/new THREE\.OBJLoader\(\)/g) || []).length, 1, 'still one OBJLoader');
});
