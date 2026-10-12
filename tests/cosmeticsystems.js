// Phase 9 — Thor / JoJo / unlock persistence / token safety.
const path = require('path');
const fs = require('fs');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, THOR_CONFIG, thorCheck, runThorEvent, pickThorTarget, loadUnlocksFromDisk, grantAchievement, getUnlocks, isValidToken, UNLOCKS_PATH, JOJO_SECRET_POS, shutdownAllRooms } = T;

function startedRoom(n = 2) {
  const host = connect('h'); const ht = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 6 });
  const code = host.lastOfType('room_created').code;
  const ws = [host], toks = [ht];
  for (let i = 1; i < n; i++) {
    const g = connect('g' + i); toks.push(hello(g));
    g.emitMessage({ type: 'join_room', roomCode: code }); g.emitMessage({ type: 'player_ready' }); ws.push(g);
  }
  host.emitMessage({ type: 'start_game' });
  const room = rooms[code];
  T.CHAOS_CONFIG && (room.chaosTimer && clearTimeout(room.chaosTimer));
  return { code, room, ws, toks };
}
// async-aware: config must stay overridden until the awaited test body finishes
async function fastThor(fn) { const s = { ...THOR_CONFIG }; Object.assign(THOR_CONFIG, { waitMinMs: 20, waitMaxMs: 20, hitDelayMs: 10, rng: () => 0.0 }); try { return await fn(); } finally { Object.assign(THOR_CONFIG, s); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- token safety / persistence ----------
test('token safety: weak or prototype-style tokens are replaced by a fresh server token', () => {
  for (const bad of ['__proto__', 'constructor', 'hasOwnProperty', 'short', 'has space in it!!', 'x'.repeat(200), 12345678901, {}, null]) {
    const ws = connect('x');
    ws.emitMessage({ type: 'hello', token: bad });
    const tok = ws.lastOfType('hello_ok').token;
    assert(isValidToken(tok), 'server must issue a valid token for ' + JSON.stringify(bad));
    assert(tok !== bad, 'bad token must not be reused');
  }
});
test('token safety: granting achievements never pollutes Object.prototype', () => {
  const ws = connect('x'); ws.emitMessage({ type: 'hello', token: '__proto__' });
  const tok = ws.lastOfType('hello_ok').token;
  grantAchievement(tok, 'jojo_reference_found');
  grantAchievement('__proto__', 'jojo_reference_found'); // direct call with a hostile token
  grantAchievement('constructor', 'thunder_hammer_survivor');
  assertEqual({}.jojoRoad, undefined, 'Object.prototype was polluted');
  assertEqual({}.thunderHammer, undefined);
  assertEqual(Object.keys(getUnlocks('another-player-token')).length, 0, 'other players must not inherit unlocks');
});

test('persistence: unlocks are written to disk and restored after a "restart"', () => {
  const tok = 'persist-token-0001';
  assert(grantAchievement(tok, 'thunder_hammer_survivor'));
  const onDisk = JSON.parse(fs.readFileSync(UNLOCKS_PATH, 'utf8'));
  assert(onDisk[tok] && onDisk[tok].thunderHammer && onDisk[tok].accessoryHalo && onDisk[tok].badgeSurvivor);
  loadUnlocksFromDisk(); // simulate restart
  const u = getUnlocks(tok);
  assert(u.thunderHammer && u.accessoryHalo && u.badgeSurvivor && u.thunder_hammer_survivor, 'restored after reload');
  assertEqual(grantAchievement(tok, 'thunder_hammer_survivor'), null, 'no double grant');
  assert(!fs.existsSync(UNLOCKS_PATH + '.tmp'), 'atomic write leaves no temp file');
});
test('persistence: corrupt / hostile file loads safely (junk dropped, no throw, no pollution)', () => {
  const backup = fs.readFileSync(UNLOCKS_PATH, 'utf8');
  try {
    fs.writeFileSync(UNLOCKS_PATH, '{not json');
    loadUnlocksFromDisk(); assertEqual(Object.keys(getUnlocks('persist-token-0001')).length, 0, 'corrupt -> empty');
    fs.writeFileSync(UNLOCKS_PATH, JSON.stringify({ '__proto__': { evil: true }, 'good-token-12345': { jojoRoad: true, bad: 'yes', n: 1 }, 'short': { a: true }, 'arr-token-12345': [1, 2] }));
    loadUnlocksFromDisk();
    assertEqual({}.evil, undefined, 'no pollution from file');
    const g = getUnlocks('good-token-12345');
    assert(g.jojoRoad === true && !('bad' in g) && !('n' in g), 'only boolean true entries kept');
    assertEqual(Object.keys(getUnlocks('short')).length, 0, 'invalid token entry dropped');
  } finally { fs.writeFileSync(UNLOCKS_PATH, backup); loadUnlocksFromDisk(); }
});

// ---------- Thor ----------
test('thor: only connected, living players can be targeted', () => {
  const { room, toks } = startedRoom(3);
  room.players[toks[0]].alive = false; room.players[toks[1]].connected = false;
  for (const r of [0, 0.5, 0.99]) assertEqual(pickThorTarget(room, () => r), toks[2]);
  room.players[toks[2]].alive = false;
  assertEqual(pickThorTarget(room, () => 0), null, 'nobody eligible -> no target');
});

test('thor: full sequence (event -> strike -> hit) grants achievement + 3 cosmetics; target-only notification', async () => {
  await fastThor(async () => {
    const { room, ws, toks } = startedRoom(2);
    assert(runThorEvent(room, toks[1]));
    assert(ws[0].lastOfType('thor_event') && ws[0].lastOfType('thor_event').targetId === toks[1]);
    await sleep(120);
    assert(ws[0].lastOfType('thor_strike') && ws[0].lastOfType('thor_hit'), 'others see strike + hit');
    const ach = ws[1].lastOfType('achievement_unlocked');
    assert(ach && ach.id === 'thunder_hammer_survivor', 'target notified');
    assert(!ws[0].lastOfType('achievement_unlocked'), 'non-target must not get the achievement');
    const u = getUnlocks(toks[1]);
    assert(u.thunderHammer && u.accessoryHalo && u.badgeSurvivor, 'all three cosmetics unlocked');
  });
});

test('thor: unlocked cosmetics become equippable (locked before, ok after)', async () => {
  await fastThor(async () => {
    const { room, ws, toks } = startedRoom(2);
    for (const id of ['thunderHammer', 'accessoryHalo', 'badgeSurvivor']) {
      ws[1].emitMessage({ type: 'equip_cosmetic', cosmeticId: id });
      assertEqual(ws[1].lastOfType('equip_rejected').reason, 'LOCKED', id + ' locked before');
    }
    runThorEvent(room, toks[1]); await sleep(120);
    for (const id of ['thunderHammer', 'accessoryHalo', 'badgeSurvivor']) {
      ws[1].emitMessage({ type: 'equip_cosmetic', cosmeticId: id });
      assertEqual(ws[1].lastOfType('equip_ok').cosmeticId, id);
    }
    assertEqual(room.players[toks[1]].equippedEffect, 'thunderHammer');
    assertEqual(room.players[toks[1]].equippedAccessory, 'accessoryHalo');
  });
});

test('thor: target who leaves before the strike gets no strike and no reward', async () => {
  const s = { ...THOR_CONFIG }; Object.assign(THOR_CONFIG, { waitMinMs: 60, waitMaxMs: 60, hitDelayMs: 10, rng: () => 0.0 });
  try {
    const { room, ws, toks } = startedRoom(3);
    const victimTok = toks[2];
    runThorEvent(room, victimTok);
    ws[2].emitMessage({ type: 'leave_room' });
    await sleep(150);
    assert(!ws[0].lastOfType('thor_strike'), 'no strike on an absent target');
    assertEqual(Object.keys(getUnlocks(victimTok)).length, 0, 'no reward for absent target');
  } finally { Object.assign(THOR_CONFIG, s); }
});

test('thor: thorCheck honors chance, max-per-round and one-at-a-time', async () => {
  await fastThor(async () => {
    const { room } = startedRoom(2);
    THOR_CONFIG.rng = () => 0.99; assertEqual(thorCheck(room), false, 'high roll -> nothing');
    THOR_CONFIG.rng = () => 0.0;
    assertEqual(thorCheck(room), true);
    assertEqual(thorCheck(room), false, 'second Thor blocked while first is running');
    await sleep(120);
    assertEqual(thorCheck(room), true, 'second allowed after the first finished');
    await sleep(120);
    assertEqual(thorCheck(room), false, 'THOR_MAX (2) reached');
    assertEqual(room.thorCount, 2);
  });
});

test('thor: rooms are isolated and shutdown clears pending Thor timers', () => {
  const A = startedRoom(2), B = startedRoom(2);
  const s = { ...THOR_CONFIG }; Object.assign(THOR_CONFIG, { waitMinMs: 5000, waitMaxMs: 5000, rng: () => 0.0 });
  try {
    runThorEvent(A.room, A.toks[0]);
    assert(!B.ws[0].lastOfType('thor_event') && !B.ws[1].lastOfType('thor_event'), 'leaked to room B');
    const t = A.room.thorSubTimer;
    assert(t && t._destroyed === false);
    shutdownAllRooms();
    assert(t._destroyed === true, 'pending strike timer cleared on shutdown');
  } finally { Object.assign(THOR_CONFIG, s); }
});

// ---------- JoJo secret ----------
function placeAt(room, tok, x, z) { room.players[tok].x = x; room.players[tok].z = z; }

test('jojo: too far -> rejected, no unlock', () => {
  const { room, ws, toks } = startedRoom(2);
  placeAt(room, toks[0], JOJO_SECRET_POS.x - JOJO_SECRET_POS.radius - 0.5, JOJO_SECRET_POS.z);
  ws[0].emitMessage({ type: 'interact_secret' });
  assertEqual(ws[0].lastOfType('interact_rejected').reason, 'TOO_FAR');
  assertEqual(Object.keys(getUnlocks(toks[0])).length, 0);
});
test('jojo: distance is measured by the server from its own stored position (edge of radius ok)', () => {
  const { room, ws, toks } = startedRoom(2);
  placeAt(room, toks[0], JOJO_SECRET_POS.x + JOJO_SECRET_POS.radius - 0.01, JOJO_SECRET_POS.z);
  ws[0].emitMessage({ type: 'interact_secret', x: JOJO_SECRET_POS.x, z: JOJO_SECRET_POS.z }); // client-claimed pos ignored
  assert(ws[0].lastOfType('achievement_unlocked'), 'inside radius -> unlock');
});
test('jojo: forged client position in the request cannot bypass distance validation', () => {
  const { room, ws, toks } = startedRoom(2);
  placeAt(room, toks[0], 0, 0);
  ws[0].emitMessage({ type: 'interact_secret', x: JOJO_SECRET_POS.x, z: JOJO_SECRET_POS.z, distance: 0 });
  assertEqual(ws[0].lastOfType('interact_rejected').reason, 'TOO_FAR');
});
test('jojo: unlock grants achievement + 4 cosmetics; repeat -> already:true; all equippable; emote playable', () => {
  const { room, ws, toks } = startedRoom(2);
  placeAt(room, toks[1], JOJO_SECRET_POS.x, JOJO_SECRET_POS.z);
  ws[1].emitMessage({ type: 'interact_secret' });
  const ach = ws[1].lastOfType('achievement_unlocked');
  assertEqual(ach.id, 'jojo_reference_found');
  assertEqual(ach.grants.join(','), 'jojoRoad,colorGold,titleRoadRoller,emoteRoadRoller');
  ws[1].emitMessage({ type: 'interact_secret' });
  assertEqual(ws[1].lastOfType('interact_ok').already, true);
  for (const id of ach.grants) { ws[1].emitMessage({ type: 'equip_cosmetic', cosmeticId: id }); assertEqual(ws[1].lastOfType('equip_ok').cosmeticId, id); }
  ws[1].emitMessage({ type: 'emote_trigger', emoteId: 'emoteRoadRoller' });
  assertEqual(ws[0].lastOfType('emote_used').emoteId, 'emoteRoadRoller');
});
test('jojo: dead players and lobby players cannot interact', () => {
  const { room, ws, toks } = startedRoom(2);
  placeAt(room, toks[0], JOJO_SECRET_POS.x, JOJO_SECRET_POS.z);
  room.players[toks[0]].alive = false;
  ws[0].emitMessage({ type: 'interact_secret' });
  assert(!ws[0].lastOfType('achievement_unlocked'), 'dead player must not unlock');
  const lobby = connect('l'); hello(lobby); lobby.emitMessage({ type: 'create_room', maxPlayers: 4 });
  lobby.emitMessage({ type: 'interact_secret' });
  assert(!lobby.lastOfType('achievement_unlocked') && !lobby.lastOfType('interact_rejected'), 'ignored before the game starts');
});
test('jojo: registry copy is original — the death effect/emote reference no bundled audio path', () => {
  const { COSMETICS } = T;
  for (const id of ['jojoRoad', 'emoteRoadRoller', 'titleRoadRoller']) assert(COSMETICS[id], id + ' exists');
  assert(!JSON.stringify(COSMETICS).match(/\.(wav|mp3|ogg)/i), 'server registry must not reference audio files');
});

test('safety: hit / spectate ids that alias built-ins ("constructor", "__proto__") are ignored, nothing mutated', () => {
  const { ws } = startedRoom(2);
  const before = JSON.stringify(Object.getOwnPropertyNames(Object));
  for (const bad of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) ws[0].emitMessage({ type: 'hit', targetId: bad });
  assertEqual(JSON.stringify(Object.getOwnPropertyNames(Object)), before, 'Object gained properties');
  assertEqual(typeof Object.health, 'undefined', 'Object.health must not be set by a forged hit');
  assert(!ws[0].lastOfType('hit_confirm'));
});

test('thor sfx: whoosh sample is shipped as a valid WAV and wired into the Thor sequence', () => {
  const wav = path.join(__dirname, '..', 'public', 'sfx', 'thor_whoosh.wav');
  const buf = fs.readFileSync(wav);
  assertEqual(buf.slice(0, 4).toString(), 'RIFF'); assertEqual(buf.slice(8, 12).toString(), 'WAVE');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert(html.includes("sfx/thor_whoosh.wav"), 'client must reference the sample');
  assert((html.match(/playThorWhoosh\(/g) || []).length >= 3, 'called on arrival and strike');
  assert(/thor_whoosh/.test(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')), 'license status documented');
});

// ---------- audio asset wiring ----------
const PUB = path.join(__dirname, '..', 'public');
const htmlSrc = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');

test('audio: every sfx/ and meme/ file referenced by the client exists on disk and is served from public/', () => {
  const refs = [...htmlSrc().matchAll(/['"`]((?:sfx|meme)\/[A-Za-z0-9_.\-]+\.(?:wav|mp3|ogg|jpg|png))['"`]/g)].map((m) => m[1]);
  assert(refs.length >= 3, 'expected at least the 3 sample refs, got ' + refs.length);
  for (const r of new Set(refs)) assert(fs.existsSync(path.join(PUB, r)), 'missing asset: ' + r);
});
test('audio: all SAMPLES are registered on a valid bus and route through the volume settings', () => {
  const src = htmlSrc();
  const block = src.slice(src.indexOf('const SAMPLES = {'), src.indexOf('};', src.indexOf('const SAMPLES = {')));
  for (const name of ['thorWhoosh', 'roadRoller', 'sunshine']) assert(block.includes(name + ':'), name + ' not registered');
  assert(/bus: '(sfx|music)'/.test(block));
  assert(src.includes('settings.masterVolume / 100') && src.includes('settings.musicVolume') && src.includes('settings.sfxVolume'));
  assert(!/new Audio\(/.test(src.replace(/function sampleAudio[\s\S]*?\n}\n/, '')), 'no stray new Audio() outside the manager');
});
test('audio: gesture unlock is installed (mobile/iOS autoplay policy)', () => {
  const src = htmlSrc();
  assert(src.includes('function unlockAudioOnce') && /'touchstart'[\s\S]{0,80}unlockAudioOnce/.test(src));
});
test('audio: sounds are hooked to the right game moments', () => {
  const src = htmlSrc();
  assert(/jojo_reference_found'\)\s*playJojoSfx/.test(src), 'JoJo secret found -> road roller sound');
  assert(/effect === 'jojoRoad'[\s\S]{0,200}playJojoSfx\(\)/.test(src), 'JoJo death effect -> road roller sound');
  assert(/roadroller:\s*\(\)\s*=>\s*playJojoSfx/.test(src), 'road roller emote -> sound');
  assert((src.match(/playThorWhoosh\(/g) || []).length >= 3, 'Thor arrival + strike -> whoosh');
  assert(/playMemeAudio\(\);/.test(src), 'Thor meme quad -> sunshine track');
});
test('audio: road roller emote references its sound by key only (server registry has no file paths)', () => {
  const { COSMETICS } = T;
  assertEqual(COSMETICS.emoteRoadRoller.sfx, 'roadroller');
  assert(!/\.(wav|mp3|ogg)/i.test(JSON.stringify(COSMETICS)));
});
test('audio: package.json ships public/** (sfx + meme) in the desktop build', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert(pkg.build.files.includes('public/**/*'), 'sound files would be missing from the .exe build');
});
