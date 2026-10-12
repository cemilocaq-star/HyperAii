// Hit-location damage + fixed hitbox + death voices. Picked up by tests/run.js.
const fs = require('fs'), os = require('os'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const PUB = path.join(__dirname, '..', 'public');
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const HB = require(path.join(PUB, 'hitbox.js'));
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const { rooms, HIT_CONFIG } = T;
const close = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---------- the fixed hitbox itself (pure geometry) ----------
const FEET = 0, EYE = HB.EYE_HEIGHT; const tgt = { x: 0, y: EYE, z: 0 };
const shotAt = (py, from = { x: 0, z: 10 }) => { const v = [0 - from.x, py - EYE, 0 - from.z]; const l = Math.hypot(...v); return { ox: from.x, oy: EYE, oz: from.z, dx: v[0] / l, dy: v[1] / l, dz: v[2] / l }; };

test('hitbox: one fixed definition — head sphere on top of a torso and a legs cylinder, all above the feet, damage head > torso > legs', () => {
  assert(Object.isFrozen(HB.ZONES) && Object.isFrozen(HB.DAMAGE_MULT), 'frozen: nothing can tune it at runtime');
  assert(HB.ZONES.legs.y1 <= HB.ZONES.torso.y0 + 1e-9 && HB.ZONES.torso.y1 >= HB.ZONES.head.cy - HB.ZONES.head.r, 'zones stack without gaps');
  assert(HB.ZONES.head.cy + HB.ZONES.head.r <= HB.EYE_HEIGHT + 0.3, 'head top is near eye height + a little');
  assert(HB.DAMAGE_MULT.head > HB.DAMAGE_MULT.torso && HB.DAMAGE_MULT.torso > HB.DAMAGE_MULT.legs && HB.DAMAGE_MULT.legs > 0);
});
test('hitbox: a level shot resolves to legs / torso / head by the height it passes at', () => {
  assertEqual(HB.resolveZone(shotAt(FEET + 0.4), tgt).zone, 'legs'); assertEqual(HB.resolveZone(shotAt(FEET + 1.1), tgt).zone, 'torso'); assertEqual(HB.resolveZone(shotAt(FEET + 1.55), tgt).zone, 'head');
  assertEqual(HB.resolveZone(shotAt(EYE), tgt).zone, 'head', 'an eye-level shot is a headshot');
});
test('hitbox: direction-independent (from the side, from behind, from above) and misses are null', () => {
  assertEqual(HB.resolveZone(shotAt(1.55, { x: 10, z: 0 }), tgt).zone, 'head'); assertEqual(HB.resolveZone(shotAt(1.1, { x: 0, z: -10 }), tgt).zone, 'torso');
  const top = { ox: 0.05, oy: 8, oz: 0, dx: 0, dy: -1, dz: 0 }; assertEqual(HB.resolveZone(top, tgt).zone, 'head', 'straight down hits the head first');
  assertEqual(HB.resolveZone({ ox: 3, oy: EYE, oz: 10, dx: 0, dy: 0, dz: -1 }, tgt), null, 'passes 3 units to the side'); assertEqual(HB.resolveZone({ ox: 0, oy: 4, oz: 10, dx: 0, dy: 0, dz: -1 }, tgt), null, 'passes over the head');
  assertEqual(HB.resolveZone({ ox: 0, oy: EYE, oz: 10, dx: 0, dy: 0, dz: 1 }, tgt), null, 'shooting away from the target never hits'); assertEqual(HB.resolveZone(null, tgt), null);
});
test('hitbox: follows the target position only (feet = eye - EYE_HEIGHT), so it is the same for every skin and animation', () => {
  const t2 = { x: 7, y: EYE + 3, z: -4 }; const aim = { ...shotAt(0), ox: 7, oy: EYE + 3 + 0, oz: 6 }; const v = [0, (t2.y - EYE + 1.1) - aim.oy, -4 - 6]; const l = Math.hypot(...v); Object.assign(aim, { dx: 0, dy: v[1] / l, dz: v[2] / l });
  assertEqual(HB.resolveZone(aim, t2).zone, 'torso');
});

// ---------- server: damage by body part ----------
function mk() {
  const h = connect('h'); const t0 = hello(h); h.emitMessage({ type: 'create_room', name: 'A', maxPlayers: 2 }); const code = h.lastOfType('room_created').code;
  const g = connect('g'); const t1 = hello(g); g.emitMessage({ type: 'join_room', roomCode: code, name: 'B' }); g.emitMessage({ type: 'player_ready' }); h.emitMessage({ type: 'start_game' });
  const room = rooms[code]; assert(room.started); const a = room.players[t0], b = room.players[t1];
  a.x = 0; a.y = EYE; a.z = 10; b.x = 0; b.y = EYE; b.z = 0; a.sync = null; b.sync = null; a.moveStrikes = []; b.moveStrikes = [];
  return { h, g, t0, t1, room, a, b };
}
function shoot(m, py, extra) {
  m.b.health = 100; m.b.alive = true; m.a.lastHitAt = 0; m.a.slot = 'gun'; m.h.sent.length = 0; m.g.sent.length = 0;
  const v = [0, py - EYE, -10], l = Math.hypot(...v);
  m.h.emitMessage({ type: 'hit', targetId: m.t1, origin: [0, EYE, 10], dir: v.map((c) => c / l), ...(extra || {}) });
  return m.h.lastOfType('hit_confirm');
}
const base = (m) => (T.getWeapon(m.a.weaponId) || T.WEAPONS[Object.keys(T.WEAPONS)[0]]).damage;

test('zones: head x2 (flagged crit, zone head), torso x1, legs x0.75 — decided by the SERVER from its own positions', () => {
  const m = mk(); const rng = HIT_CONFIG.rng; HIT_CONFIG.rng = () => 0.99; // no random crit
  try {
    const h = shoot(m, 1.55), tr = shoot(m, 1.1), lg = shoot(m, 0.4), W = base(m);
    assert(h && tr && lg, 'all three hits confirmed'); assertEqual(h.zone, 'head'); assertEqual(tr.zone, 'torso'); assertEqual(lg.zone, 'legs');
    assertEqual(h.damage, Math.round(W * 2)); assertEqual(tr.damage, W); assertEqual(lg.damage, Math.round(W * 0.75)); assert(h.crit === true && tr.crit === false && lg.crit === false, 'only the headshot is flagged crit');
  } finally { HIT_CONFIG.rng = rng; T.shutdownAllRooms(); }
});
test('zones: the client cannot choose the zone or the damage (zone/damage/crit fields in the hit are ignored)', () => {
  const m = mk(); const rng = HIT_CONFIG.rng; HIT_CONFIG.rng = () => 0.99;
  try { const r = shoot(m, 0.4, { zone: 'head', damage: 9999, crit: true, headshot: true }); assertEqual(r.zone, 'legs'); assertEqual(r.damage, Math.round(base(m) * 0.75)); } finally { HIT_CONFIG.rng = rng; T.shutdownAllRooms(); }
});
test('zones: a headshot does not stack with the random crit; torso/legs keep the old random crit (x2)', () => {
  const m = mk(); const rng = HIT_CONFIG.rng; HIT_CONFIG.rng = () => 0; // always rolls a crit
  try { const W = base(m); assertEqual(shoot(m, 1.55).damage, Math.round(W * 2), 'head: x2 only'); assertEqual(shoot(m, 1.1).damage, Math.round(W * 2), 'torso crit: x2 as before'); assertEqual(shoot(m, 0.4).damage, Math.round(W * 0.75 * 2), 'legs crit: 0.75 x 2'); } finally { HIT_CONFIG.rng = rng; T.shutdownAllRooms(); }
});
test('zones: a hit the aim check accepts but that misses every zone (lag tolerance), or carries no aim, counts as torso — never rejected by this feature', () => {
  const m = mk(); const rng = HIT_CONFIG.rng; HIT_CONFIG.rng = () => 0.99;
  try {
    const W = base(m); m.b.health = 100; m.a.lastHitAt = 0; m.h.sent.length = 0;
    m.h.emitMessage({ type: 'hit', targetId: m.t1, origin: [1.0, EYE, 10], dir: [0, 0, -1] }); // passes 1.0 unit to the side: outside the hitbox, inside the lag tolerance
    const r = m.h.lastOfType('hit_confirm'); assert(r, 'still confirmed'); assertEqual(r.zone, 'torso'); assertEqual(r.damage, W);
    m.b.health = 100; m.a.lastHitAt = 0; m.h.sent.length = 0; m.h.emitMessage({ type: 'hit', targetId: m.t1 }); const r2 = m.h.lastOfType('hit_confirm'); if (r2) { assertEqual(r2.zone, 'torso'); assertEqual(r2.damage, W); }
  } finally { HIT_CONFIG.rng = rng; T.shutdownAllRooms(); }
});
test('zones: the knife keeps its flat damage and reports no zone; a lethal headshot puts the zone on the kill broadcast', () => {
  const m = mk(); const rng = HIT_CONFIG.rng; HIT_CONFIG.rng = () => 0.99;
  try {
    m.a.z = 1.5; m.a.slot = 'knife'; m.b.health = 100; m.a.lastHitAt = 0; m.a.lastKnifeAt = 0; m.h.sent.length = 0;
    const v = [0, 1.55 - EYE, -1.5], l = Math.hypot(...v); m.h.emitMessage({ type: 'hit', targetId: m.t1, origin: [0, EYE, 1.5], dir: v.map((c) => c / l) });
    const k = m.h.lastOfType('hit_confirm'); assert(k, 'knife hit'); assertEqual(k.damage, T.KNIFE_CONFIG.damage, 'flat knife damage even on the head'); assert(!('zone' in k), 'no zone for the knife');
    m.a.z = 10; m.a.slot = 'gun'; m.b.health = 1; m.b.alive = true; m.a.lastHitAt = 0; m.h.sent.length = 0; m.g.sent.length = 0;
    const v2 = [0, 1.55 - EYE, -10], l2 = Math.hypot(...v2); m.h.emitMessage({ type: 'hit', targetId: m.t1, origin: [0, EYE, 10], dir: v2.map((c) => c / l2) });
    const kill = m.g.lastOfType('kill'); assert(kill && kill.victimId === m.t1, 'kill broadcast'); assertEqual(kill.zone, 'head');
  } finally { HIT_CONFIG.rng = rng; T.shutdownAllRooms(); }
});

// ---------- client: invisible fixed proxies, picking, debug ----------
test('client (static): shots and knife swings are picked against the fixed proxies, not the skin/capsule; proxies live under the mesh so they are disposed with the player', () => {
  assert(/<script src="hitbox\.js"><\/script>/.test(CLIENT) && CLIENT.indexOf('hitbox.js') < CLIENT.indexOf('function buildHitProxies'), 'shared hitbox loaded before use');
  const shot = CLIENT.slice(CLIENT.indexOf("ws.send(JSON.stringify({ type: 'shoot', origin: aimOrigin, dir: aimDir }));\n  const raycaster"), CLIENT.indexOf('function triggerRecoil'));
  assert(/pickRemoteTarget\(raycaster\)/.test(shot) && !/r\.mesh/.test(shot), 'gun picks via proxies'); assert(/remotePlayers\[id\]\.hitProxies = buildHitProxies\(id, mesh\)/.test(CLIENT) && /parent\.add\(m\)/.test(CLIENT), 'proxies are children of the mesh');
  assert(/ws\.send\(JSON\.stringify\(\{ type: 'hit', targetId, origin: aimOrigin, dir: aimDir \}\)\)/.test(shot), 'the hit still sends only targetId + aim (no zone claim)'); assert(/\[\?&\]hitbox=1/.test(CLIENT), 'debug wireframe flag');
});
test('client: proxies are placed exactly where the shared hitbox says (relative to the eye) and picking returns the nearest zone, honouring max distance', () => {
  const src = CLIENT.slice(CLIENT.indexOf('const HITBOX_DEBUG'), CLIENT.indexOf('function spawnRemote'));
  class V { constructor() { this.y = 0; } }
  class Mesh { constructor(g, m) { this.geometry = g; this.material = m; this.position = new V(); this.userData = {}; } }
  const THREE = { SphereGeometry: class { constructor(r) { this.r = r; this.kind = 'sphere'; } }, CylinderGeometry: class { constructor(r, r2, h) { this.r = r; this.h = h; this.kind = 'cyl'; } }, MeshBasicMaterial: class { constructor(o) { Object.assign(this, o); } }, Mesh };
  const remotePlayers = {};
  const api = new Function('THREE', 'BBHitbox', 'location', 'remotePlayers', src + '; return { buildHitProxies, pickRemoteTarget, HITBOX_DEBUG };')(THREE, HB, { search: '' }, remotePlayers);
  const kids = []; const parent = { add: (m) => kids.push(m) }; const px = api.buildHitProxies('abc', parent);
  assertEqual(px.length, 3); assertEqual(px.map((m) => m.userData.zone).join(), 'head,torso,legs'); assert(px.every((m) => m.userData.ownerId === 'abc' && m.material.visible === false), 'owner tagged + invisible by default');
  for (const m of px) { const z = HB.ZONES[m.userData.zone]; const c = z.kind === 'sphere' ? z.cy : (z.y0 + z.y1) / 2; assert(close(m.position.y, c - HB.EYE_HEIGHT), m.userData.zone + ' centre'); assert(close(m.geometry.r, z.r), 'radius'); if (z.kind === 'cyl') assert(close(m.geometry.h, z.y1 - z.y0), 'height'); }
  remotePlayers.abc = { hitProxies: px }; remotePlayers.zzz = {};
  const rc = (hits) => ({ intersectObjects: (list) => { assertEqual(list.length, 3, 'only proxies are tested'); return hits; } });
  assertEqual(api.pickRemoteTarget(rc([]), 0), null); const near = api.pickRemoteTarget(rc([{ object: px[1], distance: 2 }, { object: px[0], distance: 3 }]));
  assertEqual(near.id, 'abc'); assertEqual(near.zone, 'torso'); assertEqual(api.pickRemoteTarget(rc([{ object: px[1], distance: 5 }]), 2.8), null, 'beyond the knife range -> no pick'); assert(api.pickRemoteTarget(rc([{ object: px[1], distance: 2 }]), 2.8), 'inside range');
});

// ---------- death voices ----------
function deathRig(manifest) {
  const src = CLIENT.slice(CLIENT.indexOf('const DEATH_VOICE_RANGE'), CLIENT.indexOf('loadDeathVoiceManifest();\n\n// ---------- SAMPLE AUDIO MANAGER'));
  const played = []; const SAMPLES = {}; const camera = { position: { x: 0, z: 0 } };
  const fetchStub = () => Promise.resolve({ ok: true, json: () => Promise.resolve(manifest) });
  const api = new Function('SAMPLES', 'playSample', 'camera', 'fetch', 'myId', src + '; return { pickDeathVoiceIndex, deathVoiceVolumeMul, loadDeathVoiceManifest, playDeathVoice, deathVoice };')(SAMPLES, (n, m) => played.push([n, m]), camera, fetchStub, 'me');
  return { api, played, SAMPLES };
}
test('death voice: no files shipped -> the manifest is valid and empty, so a death is silent and nothing else changes', async () => {
  const man = JSON.parse(fs.readFileSync(path.join(PUB, 'sfx/death/manifest.json'), 'utf8')); assert(Array.isArray(man.files));
  const r = deathRig({ files: [] }); r.api.loadDeathVoiceManifest(); await new Promise((x) => setTimeout(x, 5)); r.api.playDeathVoice('me', 0, 0); assertEqual(r.played.length, 0);
  assert(/playDeathVoice\(msg\.victimId, msg\.x, msg\.z\);/.test(CLIENT.slice(CLIENT.indexOf("msg.type === 'kill'"), CLIENT.indexOf("msg.type === 'you_died'"))), 'played from the server kill broadcast');
});
test('death voice: only safe audio names are registered (as samples on the sfx bus); random pick never repeats the last voice', async () => {
  const r = deathRig({ files: ['death_1.mp3', 'death_2.wav', '../evil.mp3', 'a/b.mp3', 'note.txt', 'x y.mp3', 42, 'ok-3.ogg'] }); r.api.loadDeathVoiceManifest(); await new Promise((x) => setTimeout(x, 5));
  assertEqual(r.api.deathVoice.names.join(), 'death:death_1.mp3,death:death_2.wav,death:ok-3.ogg'); assert(Object.values(r.SAMPLES).every((d) => d.bus === 'sfx' && /^sfx\/death\/[A-Za-z0-9_.\-]+$/.test(d.src)), 'sfx bus, inside sfx/death/');
  assertEqual(r.api.pickDeathVoiceIndex(0, -1, Math.random), -1); assertEqual(r.api.pickDeathVoiceIndex(1, 0, Math.random), 0);
  for (let last = 0; last < 3; last++) for (const rv of [0, 0.2, 0.34, 0.5, 0.67, 0.99, 1]) { const i = r.api.pickDeathVoiceIndex(3, last, () => rv); assert(i >= 0 && i < 3 && i !== last, 'in range, never the last (' + i + ',' + last + ')'); }
});
test('death voice: your own death is full volume, others fade with distance and are silent beyond the range', async () => {
  const r = deathRig({ files: ['a.mp3', 'b.mp3'] }); r.api.loadDeathVoiceManifest(); await new Promise((x) => setTimeout(x, 5));
  r.api.playDeathVoice('me', 99, 99); assertEqual(r.played[0][1], 1, 'own death: full'); r.api.playDeathVoice('p2', 10, 0); assert(close(r.played[1][1], 0.75), 'distance 10 of 40 -> 0.75'); const n = r.played.length; r.api.playDeathVoice('p3', 41, 0); r.api.playDeathVoice('p4', NaN, 0); assertEqual(r.played.length, n, 'out of range / bad coordinates -> silent');
});
test('death voice: the helper script lists only safe audio files, sorted, and uses the same rule as the client', () => {
  const tool = require(path.join(__dirname, '..', 'tools', 'build_death_manifest.js')); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-death-'));
  for (const f of ['b.mp3', 'a.wav', 'c.ogg', 'notes.txt', 'bad name.mp3', 'x.flac']) fs.writeFileSync(path.join(dir, f), 'x'); const files = tool.build(dir);
  assertEqual(files.join(), 'a.wav,b.mp3,c.ogg'); assertEqual(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).files.join(), 'a.wav,b.mp3,c.ogg');
  const clientRule = CLIENT.match(/\/\^\[A-Za-z0-9_\.\\\-\]\+\\\.\(wav\|mp3\|ogg\)\$\//); assert(clientRule, 'client uses the same rule'); assertEqual(tool.SAFE.source, clientRule[0].slice(1, -1));
});
