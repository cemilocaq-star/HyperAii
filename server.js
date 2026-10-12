const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 }); // hard cap below the ws default (100 MB)

// ============================================================
// PERSİSTENT UNLOCK-LAR (device/browser-token əsaslı, hesab sistemi yoxdur)
// ============================================================
// Path is overridable (tests use a temp file so they never touch real data).
const UNLOCKS_PATH = process.env.BB_UNLOCKS_PATH || path.join(__dirname, 'data', 'unlocks.json');

// Tokens are client-supplied, so they must never be usable as object keys
// like '__proto__' / 'constructor' (prototype pollution). Only UUID-ish
// strings are accepted, and every per-token map is a null-prototype object.
const TOKEN_RE = /^[A-Za-z0-9-]{9,64}$/;
// Also reject names that exist on Object.prototype ('constructor', 'toString', ...)
// which match the character set but would alias built-ins in plain-object lookups.
function isValidToken(t) { return typeof t === 'string' && TOKEN_RE.test(t) && !(t in Object.prototype); }

let unlocks = Object.create(null);
function loadUnlocksFromDisk() {
  const fresh = Object.create(null);
  try {
    const parsed = JSON.parse(fs.readFileSync(UNLOCKS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const tok of Object.keys(parsed)) {
        if (!isValidToken(tok) || !parsed[tok] || typeof parsed[tok] !== 'object') continue; // drop junk entries
        const entry = Object.create(null);
        for (const k of Object.keys(parsed[tok])) if (parsed[tok][k] === true) entry[k] = true;
        fresh[tok] = entry;
      }
    }
  } catch { /* missing/corrupt file -> start empty */ }
  unlocks = fresh;
}
loadUnlocksFromDisk();

function saveUnlocks() {
  try {
    fs.mkdirSync(path.dirname(UNLOCKS_PATH), { recursive: true });
    const tmp = UNLOCKS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(unlocks));
    fs.renameSync(tmp, UNLOCKS_PATH); // atomic: never leaves a half-written file
  } catch (e) { console.error('unlocks save error', e); }
}
const EMPTY_UNLOCKS = Object.freeze(Object.create(null));
function getUnlocks(token) { return (isValidToken(token) && unlocks[token]) || EMPTY_UNLOCKS; }
function grantUnlock(token, key) {
  if (!isValidToken(token)) return false;
  if (!unlocks[token]) unlocks[token] = Object.create(null);
  if (unlocks[token][key]) return false; // artıq var idi
  unlocks[token][key] = true;
  saveUnlocks();
  return true;
}

// ============================================================
// COSMETIC DATA MODEL (modular registry — yeni cosmetic üçün
// sadəcə bura bir obyekt əlavə etmək kifayətdir)
// ============================================================
const COSMETICS = {
  // --- Death Effects ---
  default:      { id: 'default', type: 'deathEffect', name: 'Standart', description: 'Sadə respawn', unlockRequirement: null, rarity: 'common', enabled: true },
  thunderHammer:{ id: 'thunderHammer', type: 'deathEffect', name: 'Thunder Hammer', description: 'İldırım + çəkic effekti', unlockRequirement: 'Thor hadisəsinin hədəfi ol', rarity: 'rare', enabled: true,
    model: 'models/thor/mjolnir.obj' /* the ONE logical Mjolnir; replaced old models/thor/thor.obj (deprecated, kept on disk) */ },
  jojoRoad:     { id: 'jojoRoad', type: 'deathEffect', name: 'Road Roller Reference', description: 'Komik anime-ilhamlı ölüm təqdimatı', unlockRequirement: 'Xəritədəki gizli referansı tap', rarity: 'epic', enabled: true },
  ashesFire:    { id: 'ashesFire', type: 'deathEffect', name: 'Ashes & Fire', description: 'Alovlanıb külə dönmə', unlockRequirement: null, rarity: 'uncommon', enabled: true },
  // --- Character customization ---
  colorDefault:   { id: 'colorDefault', type: 'color', name: 'Standart', unlockRequirement: null, rarity: 'common', enabled: true },
  colorGold:      { id: 'colorGold', type: 'color', name: 'Qızılı', unlockRequirement: 'Xəritədəki gizli referansı tap', rarity: 'epic', enabled: true, visual: { color: '#ffd700' } },
  // Model-based accessory (first one). visual.shape 'model' = decimated OBJ (tools/decimate_obj.py, 2483 tris). The source MTL has NO colour
  // data (all 9 materials share Kd 0.64), so palette is a NAME-based fallback ('green' -> green, everything else neutral metal), not MTL data.
  // Placement (scale/x/y) is an estimate and is NOT VERIFIED in a real renderer. Licence of the source model: UNKNOWN.
  accessoryOmnitrix: { id: 'accessoryOmnitrix', type: 'accessory', name: 'Omnitrix', unlockRequirement: null, rarity: 'uncommon', enabled: true,
    visual: { shape: 'model', model: 'models/accessories/omnitrix/omnitrix.obj', scale: 0.0125, x: 0.46, y: 0.1, color: '#39ff14', palette: { green: '#39ff14', default: '#8a8f9a' } } },
  // Helmet (helmet_free3d.blend, converted by tools/blend_export.py WITHOUT Blender: base meshes + object transforms + Mirror; Subsurf/Solidify NOT applied).
  // Blender is Z-up with the mask on -Y, so rotX -90deg makes it Y-up and rotY 180deg makes it face the player's forward (-Z). Texture = the one JPEG in the pack,
  // applied only to the meshes that carry UVs (Head, Mask); the third mesh has none and uses the palette. Placement/scale/orientation are estimates: NOT VERIFIED in a renderer. Licence: UNKNOWN.
  accessoryHelmet: { id: 'accessoryHelmet', type: 'accessory', name: 'Helmet', unlockRequirement: null, rarity: 'uncommon', enabled: true,
    visual: { shape: 'model', model: 'models/accessories/helmet/helmet.obj', texture: 'models/accessories/helmet/corroded_metal_texture_by_ketronpl-d6mnkhy.jpg', scale: 0.11, x: 0, y: 0.72, rotX: -1.5707963, rotY: 3.1415927, color: '#8a8f9a', palette: { default: '#8a8f9a' } } },
  accessoryNone:  { id: 'accessoryNone', type: 'accessory', name: 'Yoxdur', unlockRequirement: null, rarity: 'common', enabled: true },
  accessoryHalo:  { id: 'accessoryHalo', type: 'accessory', name: 'Halo', unlockRequirement: 'Thor hadisəsinin hədəfi ol', rarity: 'rare', enabled: true, visual: { shape: 'torus', radius: 0.3, tube: 0.05, y: 1.35, color: '#fff3a0', emissive: '#fff3a0' } },
  badgeNone:      { id: 'badgeNone', type: 'badge', name: 'Yoxdur', unlockRequirement: null, rarity: 'common', enabled: true },
  badgeSurvivor:  { id: 'badgeSurvivor', type: 'badge', name: '🏆 Sağ qalan', icon: '🏆', unlockRequirement: 'Thor hadisəsinin hədəfi ol', rarity: 'rare', enabled: true },
  titleNone:      { id: 'titleNone', type: 'title', name: '', unlockRequirement: null, rarity: 'common', enabled: true },
  titleRoadRoller:{ id: 'titleRoadRoller', type: 'title', name: 'Yol Silindirçisi', unlockRequirement: 'Xəritədəki gizli referansı tap', rarity: 'epic', enabled: true },
  emoteWave:      { id: 'emoteWave', type: 'emote', name: '👋 Əl yelləmə', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteRoadRoller:{ id: 'emoteRoadRoller', type: 'emote', name: 'YOL SİLİNDİRİİİ!!!', duration: 2500, sfx: 'roadroller', unlockRequirement: 'Xəritədəki gizli referansı tap', rarity: 'epic', enabled: true },
  badgeBounty:    { id: 'badgeBounty', type: 'badge', name: '🎯 Bounty Hunter', icon: '🎯', unlockRequirement: 'Bounty hədəfini məğlub et', rarity: 'rare', enabled: true },
  // --- Meme emotes (Phase 6). Original/parody-style: no copyrighted
  // animations or audio. SFX are synthesized client-side (sfx key = recipe name).
  emoteGoofyDance:   { id: 'emoteGoofyDance', type: 'emote', name: '🕺 Goofy Dance', icon: '🕺', duration: 2500, sfx: 'boing', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteDramaticPoint:{ id: 'emoteDramaticPoint', type: 'emote', name: '👉 Dramatic Point', icon: '👉', duration: 2000, sfx: 'dun', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteFacepalm:     { id: 'emoteFacepalm', type: 'emote', name: '🤦 Facepalm', icon: '🤦', duration: 2000, sfx: 'slap', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteConfused:     { id: 'emoteConfused', type: 'emote', name: '❓ Confused', icon: '❓', duration: 2200, sfx: 'huh', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteLaugh:        { id: 'emoteLaugh', type: 'emote', name: '🤣 Laugh', icon: '🤣', duration: 2500, sfx: 'giggle', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteVictory:      { id: 'emoteVictory', type: 'emote', name: '🏆 Victory Pose', icon: '🏆', duration: 2500, sfx: 'fanfare', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteNpcWave:      { id: 'emoteNpcWave', type: 'emote', name: '🤖 NPC Wave', icon: '🤖', duration: 2000, sfx: 'blip', unlockRequirement: null, rarity: 'common', enabled: true },
  emoteAbsurdParty:  { id: 'emoteAbsurdParty', type: 'emote', name: '🎉 Absurd Celebration', icon: '🎉', duration: 3000, sfx: 'party', unlockRequirement: null, rarity: 'uncommon', enabled: true },
  // --- Modular character slots (Phase 7). The character is a capsule, so
  // each item carries a declarative `visual` descriptor the client turns into
  // primitives (tint / material / torus / sphere / cones). A future real
  // model plugs in by setting visual.model to an asset path — no protocol change.
  skinDefault:   { id: 'skinDefault', type: 'skin', name: 'Standart', unlockRequirement: null, rarity: 'common', enabled: true, visual: {} },
  skinChrome:    { id: 'skinChrome', type: 'skin', name: 'Chrome', unlockRequirement: null, rarity: 'uncommon', enabled: true, visual: { metalness: 0.9, roughness: 0.2 } },
  skinNeon:      { id: 'skinNeon', type: 'skin', name: 'Neon Glow', unlockRequirement: null, rarity: 'uncommon', enabled: true, visual: { emissive: '#39ff14', emissiveIntensity: 0.6 } },
  // Full-body model skins. Source OBJs (100k-217k tris, 86-154 materials) are BAKED by tools/bake_skin.py into ONE vertex-coloured mesh of ~6000 tris.
  // Orientation (front=-Z) is ESTIMATED from the feet and the pose/scale are NOT VERIFIED in a renderer. Source licence: UNKNOWN; these are third-party
  // characters (Iron Man / Darth Vader are trademarked IP) - confirm rights before shipping. Static meshes: they get the same bob/heading/knockdown as the capsule.
  skinIronMan:   { id: 'skinIronMan', type: 'skin', name: 'Iron Man', unlockRequirement: null, rarity: 'rare', enabled: true, visual: { shape: 'bodyModel', model: 'models/skins/ironman/ironman.obj', pose: 'T-pose' } },
  skinVader:     { id: 'skinVader', type: 'skin', name: 'Darth Vader', unlockRequirement: null, rarity: 'rare', enabled: true, visual: { shape: 'bodyModel', model: 'models/skins/vader/vader.obj' } },
  // Anatomical skeleton (skeleton.fbx: 2 static meshes, A/T-pose). Colour = the FBX Material DiffuseColor (0.23,0.97,0.85); its texture reference is missing. Its 33-bone
  // rig has no usable clips (the 'animation' is one pose: 84 of 87 curves have a single key), so only the geometry is used.
  skinSkeleton:  { id: 'skinSkeleton', type: 'skin', name: 'Skeleton', unlockRequirement: null, rarity: 'rare', enabled: true, visual: { shape: 'bodyModel', model: 'models/skins/skeleton/skeleton.obj', flatColor: true } },
  skinPilot:     { id: 'skinPilot', type: 'skin', name: 'Pilot', unlockRequirement: null, rarity: 'rare', enabled: true, visual: { shape: 'bodyModel', model: 'models/skins/pilot/pilot.obj' } },
  outfitNone:    { id: 'outfitNone', type: 'outfit', name: 'Yoxdur', unlockRequirement: null, rarity: 'common', enabled: true, visual: {} },
  outfitBelt:    { id: 'outfitBelt', type: 'outfit', name: 'Champion Belt', unlockRequirement: null, rarity: 'uncommon', enabled: true, visual: { shape: 'torus', radius: 0.42, tube: 0.07, y: -0.1, color: '#ffcc00' } },
  outfitStripe:  { id: 'outfitStripe', type: 'outfit', name: 'Racing Stripe', unlockRequirement: null, rarity: 'common', enabled: true, visual: { shape: 'torus', radius: 0.41, tube: 0.05, y: 0.25, color: '#ffffff' } },
  headDefault:   { id: 'headDefault', type: 'head', name: 'Standart', unlockRequirement: null, rarity: 'common', enabled: true, visual: {} },
  headBall:      { id: 'headBall', type: 'head', name: 'Big Head', unlockRequirement: null, rarity: 'common', enabled: true, visual: { shape: 'sphere', radius: 0.36, y: 0.95, color: '#f1c27d' } },
  headCube:      { id: 'headCube', type: 'head', name: 'Cube Head', unlockRequirement: null, rarity: 'uncommon', enabled: true, visual: { shape: 'box', size: 0.55, y: 0.95, color: '#9ad0ff' } },
  hairNone:      { id: 'hairNone', type: 'hair', name: 'Yoxdur', unlockRequirement: null, rarity: 'common', enabled: true, visual: {} },
  hairSpiky:     { id: 'hairSpiky', type: 'hair', name: 'Spiky', unlockRequirement: null, rarity: 'common', enabled: true, visual: { shape: 'spikes', count: 5, y: 1.2, color: '#ff3b8d' } },
  hairAfro:      { id: 'hairAfro', type: 'hair', name: 'Afro', unlockRequirement: null, rarity: 'uncommon', enabled: true, visual: { shape: 'sphere', radius: 0.4, y: 1.25, color: '#3a2a1a' } },
};

function getPublicCatalog() {
  const out = {};
  for (const id in COSMETICS) {
    const c = COSMETICS[id];
    if (!c.enabled) continue;
    out[id] = { id: c.id, type: c.type, name: c.name, description: c.description || '', unlockRequirement: c.unlockRequirement, rarity: c.rarity, icon: c.icon || '', duration: c.duration || 0, sfx: c.sfx || '', visual: c.visual || null };
  }
  return out;
}

const ACHIEVEMENTS = {
  thunder_hammer_survivor: { name: 'Thunder Hammer', grants: ['thunderHammer', 'accessoryHalo', 'badgeSurvivor'] },
  bounty_hunter: { name: 'Bounty Hunter', grants: ['badgeBounty'] },
  jojo_reference_found: { name: 'Road Roller Reference', grants: ['jojoRoad', 'colorGold', 'titleRoadRoller', 'emoteRoadRoller'] },
};

// Achievement veriləndə eyni zamanda bir neçə cosmetic-i birlikdə açır.
// Köhnə grantUnlock(token,'thunderHammer') tək-açarlı forması da hələ işləyir
// (aşağıda saxlanılıb) — geriyə uyğunluq üçün.
function grantAchievement(token, achId) {
  const ach = ACHIEVEMENTS[achId];
  if (!ach || !isValidToken(token)) return null;
  if (!unlocks[token]) unlocks[token] = Object.create(null);
  if (unlocks[token][achId]) return null; // artıq alınıb
  unlocks[token][achId] = true;
  ach.grants.forEach((cid) => { unlocks[token][cid] = true; });
  saveUnlocks();
  return ach;
}

// Single source of truth for customization slots (Phase 7): registry type ->
// player field, default id and the key used in the public state broadcast.
const COSMETIC_SLOTS = Object.freeze({
  deathEffect: { field: 'equippedEffect', fallback: 'default', stateKey: null },
  color:       { field: 'equippedColor', fallback: 'colorDefault', stateKey: 'color' },
  accessory:   { field: 'equippedAccessory', fallback: 'accessoryNone', stateKey: 'accessory' },
  badge:       { field: 'equippedBadge', fallback: 'badgeNone', stateKey: 'badge' },
  title:       { field: 'equippedTitle', fallback: 'titleNone', stateKey: 'title' },
  emote:       { field: 'equippedEmote', fallback: 'emoteWave', stateKey: null },
  skin:        { field: 'equippedSkin', fallback: 'skinDefault', stateKey: 'skin' },
  outfit:      { field: 'equippedOutfit', fallback: 'outfitNone', stateKey: 'outfit' },
  head:        { field: 'equippedHead', fallback: 'headDefault', stateKey: 'head' },
  hair:        { field: 'equippedHair', fallback: 'hairNone', stateKey: 'hair' },
});
function getCosmetic(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(COSMETICS, id) ? COSMETICS[id] : null;
}

function resolveCosmeticFields(token, requested) {
  const u = getUnlocks(token);
  const req = requested || {};
  function pick(type, requestedId, fallback) {
    const id = typeof requestedId === 'string' ? requestedId : fallback;
    const cos = getCosmetic(id);
    if (!cos || cos.type !== type || !cos.enabled) return fallback;
    if (cos.unlockRequirement && !u[id]) return fallback;
    return id;
  }
  const out = {};
  for (const type in COSMETIC_SLOTS) out[COSMETIC_SLOTS[type].field] = pick(type, req[type], COSMETIC_SLOTS[type].fallback);
  return out;
}

// ============================================================
// ROOM SİSTEMİ
// ============================================================
const rooms = Object.create(null);        // code -> room
const wsToToken = new Map(); // ws -> token
const tokenToRoom = new Map(); // token -> room code

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I çıxarılıb
const DISCONNECT_GRACE_MS = 25000; // reconnect üçün güzəşt müddəti
const JOIN_ATTEMPT_LIMIT = 8;
const JOIN_ATTEMPT_WINDOW_MS = 30000;

const MEME_DEATHS = [
  "{killer} {victim}-i badımcan kimi doğradı! 🍆",
  "{victim} partladı! BOOM 💥",
  "{killer} dedi: 'Bu badımcan mənimdir!' və {victim}-i vurdu.",
  "{victim} yerə sərildi, {killer} qəhqəhə çəkir 😂",
  "{killer} snayper kimi vurdu, {victim} uçdu!",
  "{victim} bəndəliyini itirdi. Hörmətlə xatırlanacaq.",
  "womp womp... {victim} öldü, {killer} sevinir",
];

const TROLL_MESSAGES = [
  "Badımcan lənəti aktivdir! 🍆✨",
  "Kimsə tərsə döndü!",
  "Xaos vaxtıdır!",
];

// ============================================================
// DASH / STAMINA (server authoritative qərar qatı)
// ============================================================
const DASH_COST = 35;
const DASH_COOLDOWN_MS = 2200;
const STAMINA_MAX = 100;
const STAMINA_REGEN_PER_SEC = 22;

// Strips control chars, trims, enforces a length cap, and falls back to a
// default on empty input. Reused by create/join/quick_play/rename so a name
// is validated exactly once, in one place.
function sanitizeName(raw) {
  const stripped = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001F\u007F<>]/g, '') // control chars + < > (defense in depth; client also never uses innerHTML for names)
    .trim()
    .slice(0, 16);
  return stripped || 'Bəndə';
}
// Appends '#2', '#3', ... when a name collides with someone already in the room.
function dedupeName(room, name) {
  const taken = new Set(Object.values(room.players).map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; n < 1000; n++) { const c = `${name}#${n}`; if (!taken.has(c)) return c; }
  return name + '#' + Date.now();
}

function freshPlayerExtra() {
  return { stamina: STAMINA_MAX, dashCooldownUntil: 0, duckWeaponUntil: 0 };
}

const BBHitbox = require('./public/hitbox.js'); // shared with the browser: ONE fixed hitbox + zone damage table for every player/skin/animation
const BBMaps = require('./public/maplayouts.js'); // shared with the browser: one source of truth for layout + collision math
// PRODUCTION DEFAULT enabled:true. The legacy test harness switches it off in ITS OWN process only (its suites assume
// the old random spawns and coordinates like (0,0)); tests/map.js proves the default in a fresh process and tests it live.
const GEOMETRY_CONFIG = { enabled: true };
const roomLayout = (room) => (GEOMETRY_CONFIG.enabled && room && BBMaps.layouts[room.map]) || null; // null => no shared geometry (forest/house, or harness)
const SPAWN_CONFIG = { fallbackCandidates: 8, rng: Math.random };
// Spawn safety: never inside geometry, never on top of a living player. Picks the candidate whose nearest
// other player is FARTHEST (deterministic on the layout's spawn list; ties -> lowest index).
function pickSpawn(room, token, others) {
  const layout = roomLayout(room);
  const pts = others || Object.keys(room.players).filter((t) => t !== token).map((t) => room.players[t]).filter((q) => q && q.alive !== false && Number.isFinite(q.x) && Number.isFinite(q.z));
  let cands;
  if (layout) cands = layout.spawns.filter((c) => !BBMaps.pointBlocked(c.x, c.z, 1.0, layout));
  else { cands = []; for (let i = 0; i < SPAWN_CONFIG.fallbackCandidates; i++) cands.push({ x: (SPAWN_CONFIG.rng() - 0.5) * 24, z: (SPAWN_CONFIG.rng() - 0.5) * 24 }); }
  let best = cands[0], bestD = -1;
  for (const c of cands) {
    let d = Infinity; for (const q of pts) d = Math.min(d, Math.hypot(c.x - q.x, c.z - q.z));
    if (d > bestD) { bestD = d; best = c; }
  }
  return { x: best.x, y: 1.6, z: best.z, minDist: bestD };
}

function genRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  } while (rooms[code]);
  return code;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, exceptToken) {
  const msg = JSON.stringify(obj);
  for (const token in room.players) {
    if (token === exceptToken) continue;
    const p = room.players[token];
    if (p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  }
}

function publicPlayerList(room) {
  return room.order
    .filter((t) => room.players[t])
    .map((t) => {
      const p = room.players[t];
      return {
        token: t, name: p.name, ready: p.ready, connected: p.connected,
        team: p.team, isHost: t === room.hostToken, slippedMs: isSlipped(p) ? Math.max(0, p.bananaSlippedUntil - BANANA_CONFIG.now()) : 0,
      };
    });
}

function roomStatePayload(room) {
  return {
    type: 'room_state',
    code: room.code,
    hostToken: room.hostToken,
    maxPlayers: room.maxPlayers,
    mode: room.mode,
    map: room.map, mapSeed: room.mapSeed,
    started: room.started,
    settings: roomSettingsPayload(room),
    bananas: publicBananas(room),
    bounty: publicBounty(room),
    players: publicPlayerList(room),
    chaos: room.chaosState
      ? { id: room.chaosState.id, displayName: room.chaosState.displayName, scope: room.chaosState.scope, targetId: room.chaosState.targetId || null, remainingMs: Math.max(0, room.chaosState.until - Date.now()) }
      : null,
  };
}

function broadcastRoomState(room) {
  broadcastRoom(room, roomStatePayload(room));
}

function connectedCount(room) {
  return Object.values(room.players).filter((p) => p.connected).length;
}

function deleteRoomIfEmpty(room) {
  if (connectedCount(room) === 0 && Object.keys(room.players).length === 0) {
    clearThorTimers(room);
    clearChaosTimers(room);
    clearPickupTimers(room);
    clearMatchTimers(room);
    clearBananas(room);
    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);
    for (const t in room.players) { if (room.players[t].emoteTimer) clearTimeout(room.players[t].emoteTimer); clearKillcam(room.players[t]); }
    delete rooms[room.code];
  }
}

function migrateHostIfNeeded(room) {
  if (room.players[room.hostToken] && room.players[room.hostToken].connected) return;
  const next = room.order.find((t) => room.players[t] && room.players[t].connected);
  if (next) room.hostToken = next;
}

function removePlayerFromRoom(room, token, reason) {
  if (!room.players[token]) return;
  if (room.chaosState && room.chaosState.targetId === token) endChaosEvent(room, room.chaosState.id);
  if (room.respawnTimers && room.respawnTimers[token]) {
    clearTimeout(room.respawnTimers[token]);
    delete room.respawnTimers[token];
  }
  if (room.players[token].emoteTimer) clearTimeout(room.players[token].emoteTimer);
  if (room.players[token].slipTimer) { clearTimeout(room.players[token].slipTimer); room.players[token].slipTimer = null; }
  if (room.bananas) for (const bb of room.bananas.slice()) if (bb.kind === 'bomb' && bb.ownerPlayerId === token) removeBanana(room, bb, 'OWNER_LEFT'); // a leaving owner's bombs never explode (no credit target)
  clearKillcam(room.players[token]);
  if (room.bounty && room.bounty.token === token) room.bounty = null;
  delete room.players[token];
  room.order = room.order.filter((t) => t !== token);
  tokenToRoom.delete(token);
  if (Object.keys(room.players).length === 0) {
    deleteRoomIfEmpty(room);
    return;
  }
  migrateHostIfNeeded(room);
  if (room.started) reassignSpectatorsOf(room, token);
  broadcastRoom(room, { type: 'player_left', token, reason });
  broadcastRoomState(room);
}

// ---------------- OYUN MƏNTİQİ (room-scoped) ----------------


// ============================================================
// WEAPON REGISTRY (server-authoritative). 13 real MODELS (tools/weapon_audit.py), ONE gameplay archetype.
// Every stat below is an EXISTING server value (HIT_CONFIG/SHOOT_CONFIG) - nothing invented. Ammo/reload/
// secondary/melee have no existing design numbers, so they are intentionally NOT faked here.
// ============================================================
const WEAPON_MODEL_COUNT = 13;
const WEAPON_SWITCH_COOLDOWN_MS = 300;
const WEAPONS = Object.create(null);
for (let i = 1; i <= WEAPON_MODEL_COUNT; i++) {
  const id = 'w' + String(i).padStart(3, '0');
  WEAPONS[id] = Object.freeze({
    id, name: 'Blaster ' + i, category: 'primary', archetype: 'blaster', hitscan: true,
    model: 'models/weapons/split/weapon_' + String(i).padStart(3, '0') + '.obj',
    get damage() { return HIT_CONFIG.baseDamage; },
    get fireIntervalMs() { return SHOOT_CONFIG.minIntervalMs; },
  });
}
// Assets that arrived WITHOUT an existing gameplay archetype. They are deliberately NOT in WEAPONS (WEAPONS stays the 13 real
// hitscan models, getWeapon()/equip never return these). No melee or throwable gameplay exists, so none is faked here.
const WEAPON_ASSET_STAGING = Object.freeze({
  knife_01: Object.freeze({ id: 'knife_01', kind: 'melee', model: 'models/weapons/melee/knife/knife.obj', equippable: false, status: 'ASSET_ONLY',
    blocked: 'texture: the source MTL pointed at a missing absolute-path image; the geometry ships untextured', license: 'Jagdoe - free for games, credit appreciated (ReadMe.txt)' }),
  grenade_01: Object.freeze({ id: 'grenade_01', kind: 'throwable', model: 'models/weapons/throwable/grenade/Grenade.obj', mtl: 'models/weapons/throwable/grenade/Grenade.mtl', equippable: false, status: 'ASSET_ONLY',
    blocked: 'no projectile/throwable gameplay exists in the server; materials are colour-only (no texture files in the source pack)', license: 'UNKNOWN (no licence file in the archive)' }),
});
const DEFAULT_WEAPON_ID = 'w001';
function getWeapon(id) { return typeof id === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, id) ? WEAPONS[id] : null; }
function handleEquipWeapon(room, token, msg) {
  const p = room && room.players[token];
  if (!p || !msg || typeof msg !== 'object') return;
  const w = getWeapon(msg.weaponId); // unknown / non-string / '__proto__' / 'constructor' -> null
  if (!w) { send(p.ws, { type: 'weapon_rejected', reason: 'UNKNOWN_WEAPON' }); return; }
  if (p.alive === false) { send(p.ws, { type: 'weapon_rejected', reason: 'DEAD' }); return; }
  if (p.bananaActive || isSlipped(p)) { send(p.ws, { type: 'weapon_rejected', reason: p.bananaActive ? 'BANANA_LOCK' : 'SLIPPED' }); return; }
  const now = MATCH_CONFIG.now();
  if (p.lastWeaponSwitchAt && now - p.lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) { send(p.ws, { type: 'weapon_rejected', reason: 'COOLDOWN' }); return; }
  p.lastWeaponSwitchAt = now;
  p.weaponId = w.id;
  send(p.ws, { type: 'weapon_ok', weaponId: w.id, model: w.model });
  broadcastRoom(room, { type: 'weapon_changed', id: token, weaponId: w.id }, token);
}

// ============================================================
// KILLCAM (attacker-POV follow, NOT a replay): victim watches the server-validated killer briefly, then normal spectator.
// Reuses the existing spectate_state channel + client spectator camera; no second camera system.
// ============================================================
const KILLCAM_MS = 2500; // must stay < RESPAWN_DELAY_MS
function clearKillcam(p) { if (p && p.killcamTimer) { clearTimeout(p.killcamTimer); p.killcamTimer = null; } if (p) p.killcamOf = null; }
function startKillcam(room, victimToken, attackerToken) {
  const v = room.players[victimToken], a = room.players[attackerToken];
  if (!v || !a || victimToken === attackerToken) return false;
  clearKillcam(v);
  if (!a.connected) return false; // attacker gone: caller falls back to plain spectator
  v.spectating = attackerToken; v.killcamOf = attackerToken;
  send(v.ws, { type: 'killcam', attackerId: attackerToken, attackerName: a.name, durationMs: KILLCAM_MS });
  send(v.ws, { type: 'spectate_state', targetToken: attackerToken, targetName: a.name, killcam: true });
  v.killcamTimer = setTimeout(() => {
    v.killcamTimer = null; v.killcamOf = null;
    if (!room.players[victimToken] || v.alive !== false) return; // respawned/left meanwhile
    send(v.ws, { type: 'killcam_end' });
    handleSpectateRequest(room, victimToken, null); // killcam -> normal spectator
  }, KILLCAM_MS);
  if (v.killcamTimer.unref) v.killcamTimer.unref();
  return true;
}

// ============================================================
// BOUNTY (server-authoritative, room-scoped, one active bounty per room)
// ============================================================
const BOUNTY_CONFIG = { streakThreshold: 5, minDistinctVictims: 2 };
function maybeCreateBounty(room, attackerToken, attacker) {
  if (room.bounty) return;
  if ((attacker.streak || 0) < BOUNTY_CONFIG.streakThreshold) return;
  // anti-farming: a streak built on one repeatedly-killed victim does not make a target
  if (!attacker.streakVictims || attacker.streakVictims.size < BOUNTY_CONFIG.minDistinctVictims) return;
  room.bounty = { token: attackerToken, createdAt: MATCH_CONFIG.now() };
  broadcastRoom(room, { type: 'bounty_set', id: attackerToken, name: attacker.name });
}
function settleBountyOnKill(room, attackerToken, attacker, victimToken, victim) {
  if (!room.bounty || room.bounty.token !== victimToken || attackerToken === victimToken) return;
  room.bounty = null; // consumed exactly once, whatever happens next
  const ach = grantAchievement(attackerToken, 'bounty_hunter'); // reward only the first time ever (existing unlock system)
  broadcastRoom(room, { type: 'bounty_claimed', hunterId: attackerToken, hunterName: attacker.name, targetName: victim.name });
  if (ach && attacker.connected) send(attacker.ws, { type: 'achievement_unlocked', id: 'bounty_hunter', name: ach.name });
}
function publicBounty(room) {
  const b = room.bounty; const p = b && room.players[b.token];
  return p ? { token: b.token, name: p.name } : null;
}

// ============================================================
// MATCH SYSTEM (server-authoritative): timer, score limit, streaks, end, rematch
// ============================================================
const MATCH_CONFIG = {
  minRoundSec: 60, maxRoundSec: 900, defaultRoundSec: 300,
  minScore: 3, maxScore: 100, defaultScore: 30,
  countdownMs: 3000,        // PRODUCTION DEFAULT: combat is locked until the countdown ends (harness sets 0 in its own process)
  now: () => Date.now(),
};
// One authoritative decoration seed per room (forest/house scatter). Clients NEVER pick it; every client derives the identical layout from it (BBMaps.scatterPlan).
const newMapSeed = () => crypto.randomInt(1, 0x7fffffff);
function clampInt(v, lo, hi, dflt) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}
// Host-configurable room options. Only strict booleans are accepted (no truthy strings/objects); anything else keeps the current value.
const ROOM_FLAG_DEFAULTS = { chaosEnabled: true, spectatorEnabled: true, friendlyFire: false, randomEvents: true, randomWeapons: true };
function applyRoomFlags(room, src) {
  for (const k of Object.keys(ROOM_FLAG_DEFAULTS)) {
    if (src && typeof src[k] === 'boolean') room[k] = src[k];
    else if (typeof room[k] !== 'boolean') room[k] = ROOM_FLAG_DEFAULTS[k];
  }
}
function roomSettingsPayload(room) {
  return { maxPlayers: room.maxPlayers, roundTimeSec: room.roundTimeSec, scoreLimit: room.scoreLimit,
    chaosEnabled: room.chaosEnabled, spectatorEnabled: room.spectatorEnabled, friendlyFire: room.friendlyFire,
    randomEvents: room.randomEvents, randomWeapons: room.randomWeapons };
}
function clearMatchTimers(room) {
  if (!room.match) return;
  if (room.match.timer) { clearTimeout(room.match.timer); room.match.timer = null; }
  if (room.match.countdownTimer) { clearTimeout(room.match.countdownTimer); room.match.countdownTimer = null; }
}
function beginMatch(room) {
  clearMatchTimers(room);
  clearBananas(room);
  if (!Number.isFinite(room.roundTimeSec) || room.roundTimeSec <= 0) room.roundTimeSec = MATCH_CONFIG.defaultRoundSec;
  if (!Number.isFinite(room.scoreLimit) || room.scoreLimit <= 0) room.scoreLimit = MATCH_CONFIG.defaultScore;
  const startedAt = MATCH_CONFIG.now();
  room.bounty = null;
  const cd = Math.max(0, Math.min(10000, Math.floor(Number(MATCH_CONFIG.countdownMs) || 0)));
  room.match = { state: cd > 0 ? 'countdown' : 'active', startedAt, countdownEndsAt: startedAt + cd, endsAt: startedAt + cd + room.roundTimeSec * 1000, timer: null, countdownTimer: null, result: null };
  if (cd > 0) {
    room.match.countdownTimer = setTimeout(() => activateMatch(room), cd);
    if (room.match.countdownTimer.unref) room.match.countdownTimer.unref();
  } else armRoundTimer(room);
  for (const t of room.order) {
    const p = room.players[t];
    if (p) { p.streak = 0; p.streakVictims = null; p.bestStreak = 0; p.chaosExposure = 0; p.weaponId = DEFAULT_WEAPON_ID; p.slot = 'gun'; p.lastBombAt = 0; p.lastKnifeAt = 0; }
  }
}
function armRoundTimer(room) {
  room.match.timer = setTimeout(() => endMatch(room, 'TIME'), room.roundTimeSec * 1000);
  if (room.match.timer.unref) room.match.timer.unref();
}
function activateMatch(room) {
  const m = room.match;
  if (!m || m.state !== 'countdown' || !room.started) return;
  m.countdownTimer = null; m.state = 'active';
  m.endsAt = MATCH_CONFIG.now() + room.roundTimeSec * 1000;
  armRoundTimer(room);
  broadcastRoom(room, matchStatePayload(room));
}
function matchActive(room) { return !!(room && room.started && room.match && room.match.state === 'active'); }
// Server-side stats only; nothing here is ever read from a client packet.
function buildMatchResult(room, reason) {
  const rows = room.order.filter((t) => room.players[t]).map((t, i) => {
    const p = room.players[t];
    return { token: t, name: p.name, kills: p.kills, deaths: p.deaths, score: p.kills, bestStreak: p.bestStreak || 0, chaosExposure: p.chaosExposure || 0, _i: i };
  });
  // Deterministic tie-break: higher stat wins, then earlier join order.
  const best = (key) => { const c = rows.slice().sort((a, b) => b[key] - a[key] || a._i - b._i)[0]; return c && c[key] > 0 ? { token: c.token, name: c.name, value: c[key] } : null; };
  const ranking = rows.slice().sort((a, b) => b.score - a.score || a.deaths - b.deaths || a._i - b._i);
  return {
    reason, winner: ranking[0] ? { token: ranking[0].token, name: ranking[0].name } : null,
    mostKills: best('kills'), mostDeaths: best('deaths'), bestStreak: best('bestStreak'),
    chaoticPlayer: best('chaosExposure'), // = most affected by Chaos events, NOT kills/deaths/strength
    players: ranking.map(({ _i, ...r }) => r),
  };
}
function endMatch(room, reason) {
  if (!matchActive(room)) return false; // ends exactly once
  clearMatchTimers(room);
  room.match.state = 'ended';
  if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);
  room.respawnTimers = {};
  for (const t of room.order) clearKillcam(room.players[t]);
  clearChaosTimers(room); room.chaosState = null; room.bounty = null;
  for (const t of room.order) { const pl = room.players[t]; if (pl && pl.bananaActive) { pl.bananaActive = false; if (pl.bananaSavedWeaponId) pl.weaponId = pl.bananaSavedWeaponId; pl.bananaSavedWeaponId = null; } }
  clearBananas(room);
  room.match.result = buildMatchResult(room, reason);
  broadcastRoom(room, { type: 'match_end', ...room.match.result });
  return true;
}
function checkScoreLimit(room, killer) {
  if (killer && killer.kills >= room.scoreLimit) endMatch(room, 'SCORE_LIMIT');
}
function registerKillStreak(room, attacker, victim, victimToken) {
  victim.streak = 0; victim.streakVictims = null;
  attacker.streak = (attacker.streak || 0) + 1;
  if (!attacker.streakVictims) attacker.streakVictims = new Set();
  attacker.streakVictims.add(victimToken);
  if (attacker.streak > (attacker.bestStreak || 0)) attacker.bestStreak = attacker.streak;
  if (attacker.streak >= 2) broadcastRoom(room, { type: 'kill_streak', id: attacker.token || null, name: attacker.name, streak: attacker.streak });
}
function matchStatePayload(room) {
  const m = room.match;
  return { type: 'match_state', state: m ? m.state : 'lobby', remainingMs: m && m.state === 'active' ? Math.max(0, m.endsAt - MATCH_CONFIG.now()) : 0, countdownMs: m && m.state === 'countdown' ? Math.max(0, m.countdownEndsAt - MATCH_CONFIG.now()) : 0, scoreLimit: room.scoreLimit, roundTimeSec: room.roundTimeSec };
}

function startRoomGame(room) {
  room.started = true;
  room.interestEpoch = (room.interestEpoch || 0) + 1; // clients rebuild their scene on game start: forget what each recipient was told
  beginMatch(room);
  clearChaosTimers(room);
  clearThorTimers(room);
  room.chaosState = null;
  const placed = [];
  for (const token of room.order) {
    const p = room.players[token];
    if (!p) continue;
    const spawn = pickSpawn(room, token, placed);
    placed.push({ x: spawn.x, z: spawn.z });
    p.x = spawn.x; p.y = spawn.y; p.z = spawn.z; p.ry = 0;
    p.health = 100; p.kills = 0; p.deaths = 0;
    p.stamina = STAMINA_MAX; p.dashCooldownUntil = 0; p.duckWeaponUntil = 0;
    p.alive = true; p.spectating = null;
    if (room.respawnTimers && room.respawnTimers[token]) { clearTimeout(room.respawnTimers[token]); }
  }
  room.respawnTimers = {};
  initPickups(room);
  broadcastRoom(room, { type: 'game_started', map: room.map, mapSeed: room.mapSeed, mode: room.mode, pickups: publicPickups(room) });
  // The client used to start at (0,0) regardless of the server's spawn, so
  // server and client disagreed from tick 1. Send each player their spawn
  // (existing 'respawn' message; the client already snaps its camera to it).
  for (const token of room.order) {
    const p = room.players[token];
    if (!p) continue;
    beginServerSync(p, p.x, p.y, p.z);
    p.moveStrikes = [];
    if (p.connected) send(p.ws, { type: 'respawn', id: token, x: p.x, y: p.y, z: p.z });
  }
  scheduleThorForRoom(room);
  scheduleChaosForRoom(room);
  broadcastRoom(room, matchStatePayload(room));
}

function handleDashRequest(room, token, msg, ws) {
  const p = room.players[token];
  if (!p) return;
  if (isSlipped(p)) { send(ws, { type: 'dash_rejected', reason: 'SLIPPED' }); return; }
  const now = Date.now();
  if (now < p.dashCooldownUntil) {
    send(ws, { type: 'dash_rejected', reason: 'COOLDOWN', remainingMs: p.dashCooldownUntil - now });
    return;
  }
  if (p.stamina < DASH_COST) {
    send(ws, { type: 'dash_rejected', reason: 'NO_STAMINA' });
    return;
  }
  p.stamina -= DASH_COST;
  p.dashCooldownUntil = now + DASH_COOLDOWN_MS;
  p.moveBudget = Math.min(MOVE_CONFIG.burstMaxWithDash, (p.moveBudget === undefined ? MOVE_CONFIG.burst : p.moveBudget) + MOVE_CONFIG.dashBonus);
  p.dashBudgetUntil = MOVE_CONFIG.now() + MOVE_CONFIG.dashBudgetWindowMs;
  send(ws, { type: 'dash_ok', dir: msg.dir });
  broadcastRoom(room, { type: 'dash_used', token }, token);
}

// ============================================================
// MOVEMENT VALIDATION (Phase 10)
// ============================================================
// WASD movement is still simulated by the client (the server has no physics),
// but the server now treats every position as an unverified CLAIM:
//  - payload must be finite numbers inside the arena
//  - travelled distance is paid for from a "movement budget" that refills at
//    walkSpeed*tolerance per real second (server clock) and is capped at a
//    small burst, so lag bursts are fine but teleports / speed hacks are not.
//    (Client movement has no acceleration model — velocity is instant — so the
//    budget IS the acceleration/teleport limit; a separate derivative check
//    would only add false positives.)
//  - a rejected update leaves the server position untouched and sends the
//    client a `position_correct` (rate-limited).
//  - enough rejections in a window flags the player "suspicious": their hits
//    and secret interactions are refused until they behave.
// Positions therefore only ever come from accepted updates or server teleports.
const MOVE_CONFIG = {
  walkSpeed: 6,            // client: const speed = 6
  tolerance: 1.35,         // timer/frame jitter margin
  burst: 4,                // max stored budget (units) ~0.7s of walking
  dashBonus: 4,            // extra budget granted per server-approved dash (client dash = 16u/s * 0.18s)
  burstMaxWithDash: 8,
  dashBudgetWindowMs: 600,
  bound: 38.5,             // client clamps to +-38
  yMin: 1.0, yMax: 2.2,    // client pins y=1.6
  minIntervalMs: 5,        // drop update floods (client sends ~60/s)
  correctionIntervalMs: 250,
  strikeLimit: 10, strikeWindowMs: 5000,
  syncRadius: 3, syncTimeoutMs: 1500,
  now: () => Date.now(),   // injectable clock for deterministic tests
};

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// Server-initiated teleport (spawn / respawn / rejoin): stale in-flight client
// updates from the old spot are ignored until the client reports near the new one.
function beginServerSync(p, x, y, z) {
  const now = MOVE_CONFIG.now();
  p.x = x; p.y = y; p.z = z;
  p.moveBudget = MOVE_CONFIG.burst;
  p.lastMoveAt = now;
  p.sync = { x, z, until: now + MOVE_CONFIG.syncTimeoutMs };
}

function isSuspicious(p) {
  if (!p.moveStrikes) return false;
  const cutoff = MOVE_CONFIG.now() - MOVE_CONFIG.strikeWindowMs;
  p.moveStrikes = p.moveStrikes.filter((t) => t >= cutoff);
  return p.moveStrikes.length >= MOVE_CONFIG.strikeLimit;
}

function moveViolation(p, reason) {
  const now = MOVE_CONFIG.now();
  if (!p.moveStrikes) p.moveStrikes = [];
  p.moveStrikes.push(now);
  if (!p.lastCorrectionAt || now - p.lastCorrectionAt >= MOVE_CONFIG.correctionIntervalMs) {
    p.lastCorrectionAt = now;
    if (p.connected) send(p.ws, { type: 'position_correct', x: p.x, y: p.y, z: p.z, reason });
  }
}

function handleUpdate(room, token, msg) {
  const p = room.players[token];
  if (!p || !room.started || p.alive === false) return; // dead/lobby players don't move
  if (isSlipped(p)) return; // BANANA_SLIPPED: server ignores movement until recovery (no strike)
  const cfg = MOVE_CONFIG;
  const now = cfg.now();
  const { x, y, z, ry } = msg;
  if (!isNum(x) || !isNum(y) || !isNum(z) || !isNum(ry) || Math.abs(ry) > 1e4) { moveViolation(p, 'MALFORMED'); return; }
  if (p.lastMoveAt && now - p.lastMoveAt < cfg.minIntervalMs) return; // flood control (not a strike)
  if (Math.abs(x) > cfg.bound || Math.abs(z) > cfg.bound || y < cfg.yMin || y > cfg.yMax) { moveViolation(p, 'OUT_OF_BOUNDS'); return; }
  if (BBMaps.pointBlocked(x, z, BBMaps.SERVER_R, roomLayout(room))) { moveViolation(p, 'IN_OBSTACLE'); return; } // walking through walls: reject + correct, no kick

  const wrappedRy = ((ry + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  if (p.sync) {
    if (now > p.sync.until) p.sync = null; // grace over: normal rules vs the server position
    else if (Math.hypot(x - p.sync.x, z - p.sync.z) > cfg.syncRadius) return; // client hasn't snapped yet: ignore, no strike
    else { p.sync = null; p.x = x; p.y = y; p.z = z; p.ry = wrappedRy; p.lastMoveAt = now; p.moveBudget = cfg.burst; return; }
  }

  const dt = Math.max(0, Math.min(2, (now - (p.lastMoveAt || now)) / 1000));
  const cap = now < (p.dashBudgetUntil || 0) ? cfg.burstMaxWithDash : cfg.burst;
  const budget = Math.min(cap, (p.moveBudget === undefined ? cfg.burst : p.moveBudget) + cfg.walkSpeed * cfg.tolerance * dt);
  const dist = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2 + (z - p.z) ** 2);
  p.lastMoveAt = now;
  if (dist > budget + 1e-6) {
    p.moveBudget = budget; // budget keeps refilling with real time even while rejecting
    moveViolation(p, 'SPEED');
    return;
  }
  p.moveBudget = budget - dist;
  p.x = x; p.y = y; p.z = z; p.ry = wrappedRy;
}

// ============================================================
// SHOOT / HIT VALIDATION (Phase 22)
// ============================================================
// LIMITATION (real, not hidden): map geometry (obstacles, trees, furniture) is
// generated by each CLIENT with Math.random(), so the server has no walls to
// raycast against. There is therefore NO server-side line-of-sight/wall check.
// What the server DOES enforce for a claimed hit: shooter/target identity and
// room membership, both alive, fire-rate, range (server-known positions), and
// an aim-ray plausibility check — the claimed aim origin must be near the
// server-known shooter position and the server-known target position must lie
// close to the claimed aim ray. Damage / crit / kill / health are always
// computed here; anything of that kind in a packet is ignored.
const MAX_MESSAGE_BYTES = 32 * 1024;
let handlerErrorCount = 0; // exposed to tests: must stay 0 under fuzz (the try/catch is a safety net, not a licence to throw)
const SHOOT_CONFIG = {
  minIntervalMs: 50,        // per-player floor between accepted shoot broadcasts
  originTolerance: 6,       // claimed camera origin vs server-known position (lag + dash burst)
  dirMinLen: 0.5, dirMaxLen: 1.5, // client sends a unit vector; anything wildly off is malformed
  coordLimit: 1000,
  now: () => Date.now(),
};

function isVec3(v, limit) {
  return Array.isArray(v) && v.length === 3 && v.every((n) => isNum(n) && Math.abs(n) <= limit);
}

// Returns { ox,oy,oz, dx,dy,dz (normalized) } or null for any malformed aim.
function parseAim(msg) {
  if (!msg || !isVec3(msg.origin, SHOOT_CONFIG.coordLimit) || !isVec3(msg.dir, 100)) return null;
  const [ox, oy, oz] = msg.origin;
  const [rx, ry, rz] = msg.dir;
  const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (!(len >= SHOOT_CONFIG.dirMinLen && len <= SHOOT_CONFIG.dirMaxLen)) return null;
  return { ox, oy, oz, dx: rx / len, dy: ry / len, dz: rz / len };
}

function aimOriginNearPlayer(aim, p) {
  return Math.sqrt((aim.ox - p.x) ** 2 + (aim.oy - p.y) ** 2 + (aim.oz - p.z) ** 2) <= SHOOT_CONFIG.originTolerance;
}

function handleShoot(room, token, msg) {
  const p = room.players[token];
  if (!p || !room.started || !matchActive(room) || p.alive === false) return; // dead / lobby / countdown / ended: cannot fire
  if (isSlipped(p)) return; // BANANA_SLIPPED: cannot shoot
  if (isSuspicious(p)) return;
  const aim = parseAim(msg);
  if (!aim) return;
  if (!aimOriginNearPlayer(aim, p)) return; // claimed muzzle is nowhere near the server-known position
  const now = SHOOT_CONFIG.now();
  if (p.lastShootAt && now - p.lastShootAt < SHOOT_CONFIG.minIntervalMs) return; // shoot-spam floor
  p.lastShootAt = now;
  if (p.bananaActive) { throwBanana(room, token, p, aim); return; } // banana holder: projectile only, no hitscan credit, no damage
  if (slotOf(p) === 'bomb') { throwBomb(room, token, p, aim); return; } // bomb slot: server-side projectile, no hitscan credit
  // A validated shot is the ONLY thing that can back a later `hit` claim: one credit per
  // shoot, consumed by handleHit, so a duplicated/replayed hit packet can never apply twice.
  p.pendingShot = { at: now, aim };
  // Rebroadcast ONLY server-sanitized numbers, never the raw client payload.
  broadcastRoom(room, { type: 'shoot', token, origin: [aim.ox, aim.oy, aim.oz], dir: [aim.dx, aim.dy, aim.dz] }, token);
}

// Hit tuning. Mutable object so tests can inject a deterministic rng /
// disable the fire-rate cap without touching gameplay code paths.
const HIT_CONFIG = {
  baseDamage: 25,
  critChance: 0.1,
  critMultiplier: 2,
  minIntervalMs: 80,
  maxRange: 150,
  aimRadius: 1.2,           // capsule radius + a little body height slack
  aimLagSlack: 2.5,         // target may have moved (dash = 16u/s) since the shooter's frame
  requireAim: true,         // PRODUCTION DEFAULT true: a hit must carry origin+dir AND be backed by a fresh validated `shoot` (see below).
                            // The legacy test harness flips this to false in ITS OWN process only (tests/prodconfig22.js proves isolation).
  shotWindowMs: 1000,       // a hit must follow its `shoot` within this window
  pairOriginTol: 0.25,      // the hit's aim must equal the paired shot's aim (client sends the same camera values in both)
  pairDirDot: 0.9999,
  now: () => Date.now(),    // injectable clock (tests only); production never overrides it
  rng: Math.random,
};

// ---- Weapon slots: gun (the existing 13-model blaster archetype) -> knife -> bomb. Every player has all three; the slot is server state. ----
// DESIGN VALUES (chosen by the maintainer's request "cooldown/distance is up to you"): they are NOT derived from any existing design number; tune freely.
const SLOTS = ['gun', 'knife', 'bomb'];
const KNIFE_CONFIG = { damage: 50, cooldownMs: 650, range: 2.8, serverSlack: 1.2 };            // hits need the target within range (+ lag slack, server positions)
const BOMB_CONFIG = { maxDamage: 80, minDamage: 20, radius: 5, fuseMs: 2000, cooldownMs: 5000, throwSpeed: 14, upSpeed: 4.5, selfDamageFactor: 0.5, torsoDrop: 0.8 };
function slotOf(p) { return SLOTS.includes(p && p.slot) ? p.slot : 'gun'; }

// Shared damage -> death pipeline (was inline in handleHit). Used by gun/knife hits and bomb explosions.
function dealDamage(room, token, attacker, targetId, target, dealt, crit, zone) {
  target.health -= dealt;
  const killed = target.health <= 0;
  // Only the attacker is told their hit landed (hit marker + damage number); strictly after server validation.
  if (attacker.connected !== false) send(attacker.ws, Object.assign({ type: 'hit_confirm', targetId, damage: dealt, crit, killed, x: target.x, y: target.y, z: target.z }, zone ? { zone } : {}));
  if (killed) {
    const self = attacker === target;
    const deathX = target.x, deathY = target.y, deathZ = target.z;
    target.health = 0; target.alive = false; target.deaths++;
    if (!self) {
      attacker.kills++; attacker.token = token;
      settleBountyOnKill(room, token, attacker, targetId, target); // must read the victim's bounty status BEFORE streak bookkeeping
      registerKillStreak(room, attacker, target, targetId);
      maybeCreateBounty(room, token, attacker);
    } else { target.streak = 0; } // a self-inflicted death is never a kill, streak step or bounty
    const template = MEME_DEATHS[Math.floor(Math.random() * MEME_DEATHS.length)];
    const text = template.replace('{killer}', attacker.name).replace('{victim}', target.name);
    broadcastRoom(room, Object.assign({ type: 'kill', text, killerId: token, victimId: targetId, deathEffect: target.equippedEffect || 'default', x: deathX, y: deathY, z: deathZ }, zone ? { zone } : {}));
    clearActiveEmote(room, targetId, true); // dying cancels any emote in progress
    send(target.ws, { type: 'you_died', respawnInMs: RESPAWN_DELAY_MS });
    reassignSpectatorsOf(room, targetId);
    startKillcam(room, targetId, token); // returns false for a self kill -> plain spectator
    scheduleRespawn(room, targetId);
    if (!self) checkScoreLimit(room, attacker);
  } else {
    broadcastRoom(room, { type: 'damage', id: targetId, health: target.health });
  }
}

function handleHit(room, token, msg) {
  if (!msg || typeof msg.targetId !== 'string' || !isValidToken(msg.targetId)) return; // malformed / non-string ids
  const attacker = room.players[token];
  const target = room.players[msg.targetId]; // room.players is per-room + prototype-less: cross-room ids simply don't exist here
  if (!attacker || !target || target === attacker) return;
  if (room.mode === 'team' && target.team === attacker.team && !room.friendlyFire) return;
  if (attacker.duckWeaponUntil && Date.now() < attacker.duckWeaponUntil) return; // 🦆 yalnız səs, zərər yoxdur
  if (attacker.bananaActive || isSlipped(attacker)) return; // 🍌 banana holders deal no hitscan damage; slipped players cannot fire
  const slot = slotOf(attacker);
  if (slot === 'bomb') return; // the bomb slot has no hitscan: it throws (see handleShoot / throwBomb)

  // ---- Server-authoritative hit validation (Phase 4/5) ----
  // The client only says WHO it thinks it hit. Damage and crit are decided
  // here; any 'damage' field sent by a client is ignored.
  if (!room.started || !matchActive(room)) return;
  if (attacker.alive === false || target.alive === false) return; // dead can't shoot / be shot
  if (isSuspicious(attacker)) return; // repeated impossible movement: positions untrusted, no damage
  const now = HIT_CONFIG.now();
  if (attacker.lastHitAt && now - attacker.lastHitAt < HIT_CONFIG.minIntervalMs) return; // fire-rate cap
  const dx = attacker.x - target.x, dy = attacker.y - target.y, dz = attacker.z - target.z;
  const maxRange = slot === 'knife' ? KNIFE_CONFIG.range + KNIFE_CONFIG.serverSlack : HIT_CONFIG.maxRange; // knife: melee reach on SERVER positions
  if (Math.sqrt(dx * dx + dy * dy + dz * dz) > maxRange) return; // impossible range
  if (slot === 'knife' && attacker.lastKnifeAt && now - attacker.lastKnifeAt < KNIFE_CONFIG.cooldownMs) return; // knife cooldown is server-side
  if (HIT_CONFIG.requireAim) {
    // shoot = intent, hit = claimed result. The claim must be backed by exactly one fresh,
    // already-validated shoot from this player; the credit is consumed whatever the outcome.
    const shot = attacker.pendingShot; attacker.pendingShot = null;
    if (!shot || now - shot.at > HIT_CONFIG.shotWindowMs || now < shot.at) return;
    const aim = parseAim(msg);
    if (!aim || !aimOriginNearPlayer(aim, attacker)) return;
    const dOrg = Math.sqrt((aim.ox - shot.aim.ox) ** 2 + (aim.oy - shot.aim.oy) ** 2 + (aim.oz - shot.aim.oz) ** 2);
    const dDot = aim.dx * shot.aim.dx + aim.dy * shot.aim.dy + aim.dz * shot.aim.dz;
    if (dOrg > HIT_CONFIG.pairOriginTol || dDot < HIT_CONFIG.pairDirDot) return; // hit aim != the shot it claims to come from
    // vector from the claimed muzzle to the SERVER-known target position
    const vx = target.x - aim.ox, vy = target.y - aim.oy, vz = target.z - aim.oz;
    const along = vx * aim.dx + vy * aim.dy + vz * aim.dz;
    if (along <= 0 || along > HIT_CONFIG.maxRange + SHOOT_CONFIG.originTolerance) return; // target behind the shooter
    const px = vx - along * aim.dx, py = vy - along * aim.dy, pz = vz - along * aim.dz;
    if (Math.sqrt(px * px + py * py + pz * pz) > HIT_CONFIG.aimRadius + HIT_CONFIG.aimLagSlack) return; // not where the shooter was aiming
  }
  // Line of sight: only for maps whose geometry the server really has (shared layout). Others: client-only, see LIMITATION.
  if (BBMaps.segmentBlocked(attacker.x, attacker.z, target.x, target.z, roomLayout(room))) return;
  attacker.lastHitAt = now;
  if (slot === 'knife') attacker.lastKnifeAt = now;
  // Hit location (gun only): the SERVER intersects the shot's aim ray with the fixed hitbox at the target's SERVER position (public/hitbox.js).
  // The client never says which body part it hit. A ray that is accepted by the (lag-tolerant) aim check above but misses every zone, or a hit
  // without usable aim data (legacy test harness), counts as torso = x1, so this change can only add head/leg variation, never reject a hit.
  let zone = null;
  if (slot === 'gun') { const zoneAim = parseAim(msg); const zr = zoneAim && BBHitbox.resolveZone(zoneAim, target); zone = zr ? zr.zone : 'torso'; }
  const headshot = zone === 'head';
  const crit = headshot || (slot === 'gun' && HIT_CONFIG.rng() < HIT_CONFIG.critChance); // the knife never crits; a headshot IS the crit (no stacking)
  const wpn = getWeapon(attacker.weaponId) || WEAPONS[DEFAULT_WEAPON_ID]; // ownership: only registry weapons ever count
  const zoneMult = zone ? BBHitbox.DAMAGE_MULT[zone] : 1;
  const dealt = slot === 'knife' ? KNIFE_CONFIG.damage : Math.round(wpn.damage * zoneMult * (!headshot && crit ? HIT_CONFIG.critMultiplier : 1));
  dealDamage(room, token, attacker, msg.targetId, target, dealt, crit, zone);
}

// ============================================================
// SPECTATOR MODE (server-authoritative — Phase 1)
// ============================================================
const RESPAWN_DELAY_MS = 4000;

function isLive(room, token) {
  const p = room.players[token];
  return !!(p && p.connected && p.alive !== false);
}

function liveOrderExcept(room, token) {
  return room.order.filter((t) => t !== token && isLive(room, t));
}

function scheduleRespawn(room, token) {
  room.respawnTimers = room.respawnTimers || {};
  if (room.respawnTimers[token]) clearTimeout(room.respawnTimers[token]);
  room.respawnTimers[token] = setTimeout(() => {
    delete room.respawnTimers[token];
    const p = room.players[token];
    if (!p || !room.started || !matchActive(room)) return;
    const respawn = pickSpawn(room, token);
    beginServerSync(p, respawn.x, respawn.y, respawn.z);
    clearKillcam(p);
    p.health = 100; p.alive = true; p.spectating = null; p.slot = 'gun';
    broadcastRoom(room, { type: 'respawn', id: token, x: p.x, y: p.y, z: p.z });
    if (p.connected) send(p.ws, { type: 'spectate_end' });
  }, RESPAWN_DELAY_MS);
}

// Server picks the target — client only says 'next' | 'prev' | (nothing, on
// first entry). This is what prevents a client from spoofing an arbitrary
// spectate target: it can never send a token directly.
function handleSpectateRequest(room, token, msg) {
  const p = room.players[token];
  if (!p) return;
  const live = liveOrderExcept(room, token);
  if (live.length === 0) {
    p.spectating = null;
    send(p.ws, { type: 'spectate_state', targetToken: null, reason: 'NO_LIVE_PLAYERS' });
    return;
  }
  let idx = p.spectating && live.includes(p.spectating) ? live.indexOf(p.spectating) : -1;
  if (msg && msg.direction === 'next') idx = (idx + 1 + live.length) % live.length;
  else if (msg && msg.direction === 'prev') idx = (idx - 1 + live.length) % live.length;
  else if (idx === -1) idx = 0;
  const targetToken = live[idx];
  p.spectating = targetToken;
  const target = room.players[targetToken];
  send(p.ws, { type: 'spectate_state', targetToken, targetName: target.name });
}

// Called whenever a player's live-ness changes (death/disconnect) so anyone
// currently spectating them gets bumped to the next live player instead of
// staring at a stale target.
function reassignSpectatorsOf(room, changedToken) {
  for (const t of room.order) {
    const sp = room.players[t];
    if (sp && sp.spectating === changedToken) handleSpectateRequest(room, t, null);
  }
}

// ---------- TROLL PICKUPS (server-owned since Phase 22) ----------
// Previously every client invented its own random pickup balls and told the
// server "I got one" with a self-declared target. Now the SERVER owns the
// pickup list per room (ids + positions), sends it in game_started, validates
// distance/state/cooldown, activates each pickup once, respawns it on a timer
// and always curses the real sender (never a client-supplied targetId).
const PICKUP_CONFIG = {
  count: 4, spread: 50,
  radius: 1.2,             // client touch radius
  slack: 2.5,              // lag/position-lag allowance on top of the touch radius
  respawnMs: 8000,
  attemptCooldownMs: 250,  // per-player floor between pickup attempts (valid or not)
  rng: Math.random,
  now: () => Date.now(),
};

function randomPickupPos() {
  return { x: (PICKUP_CONFIG.rng() - 0.5) * PICKUP_CONFIG.spread, z: (PICKUP_CONFIG.rng() - 0.5) * PICKUP_CONFIG.spread };
}

function clearPickupTimers(room) {
  if (!room.pickups) return;
  for (const id in room.pickups) {
    const pk = room.pickups[id];
    if (pk.timer) { clearTimeout(pk.timer); pk.timer = null; }
  }
}

function initPickups(room) {
  clearPickupTimers(room);
  room.pickups = Object.create(null);
  for (let i = 0; i < PICKUP_CONFIG.count; i++) {
    const pos = randomPickupPos();
    const id = 'pk' + i;
    room.pickups[id] = { id, x: pos.x, z: pos.z, active: true, timer: null };
  }
}

function publicPickups(room) {
  if (!room.pickups) return [];
  return Object.keys(room.pickups).map((id) => {
    const pk = room.pickups[id];
    return { id: pk.id, x: pk.x, z: pk.z, active: pk.active };
  });
}

function handleTrollPickup(room, token, msg) {
  const p = room.players[token];
  if (!p || !room.started || p.alive === false || !room.pickups) return;
  if (!msg || typeof msg.pickupId !== 'string' || msg.pickupId.length > 16) return; // malformed id
  const now = PICKUP_CONFIG.now();
  if (p.lastPickupAttemptAt && now - p.lastPickupAttemptAt < PICKUP_CONFIG.attemptCooldownMs) return; // spam floor
  p.lastPickupAttemptAt = now;
  const pk = room.pickups[msg.pickupId]; // prototype-less map: '__proto__' etc. are just absent
  if (!pk || !pk.active) return; // unknown, other room's (not in this room's map), or already taken
  if (isSuspicious(p)) return;
  if (Math.hypot(p.x - pk.x, p.z - pk.z) > PICKUP_CONFIG.radius + PICKUP_CONFIG.slack) return; // server-known position too far
  pk.active = false;
  broadcastRoom(room, { type: 'pickup_state', id: pk.id, active: false, x: pk.x, z: pk.z });
  pk.timer = setTimeout(() => {
    pk.timer = null;
    if (rooms[room.code] !== room || !room.pickups || room.pickups[pk.id] !== pk) return; // room gone / restarted
    const pos = randomPickupPos();
    pk.x = pos.x; pk.z = pos.z; pk.active = true;
    broadcastRoom(room, { type: 'pickup_state', id: pk.id, active: true, x: pk.x, z: pk.z });
  }, PICKUP_CONFIG.respawnMs);
  const text = TROLL_MESSAGES[Math.floor(Math.random() * TROLL_MESSAGES.length)];
  // the cursed player is ALWAYS the validated sender
  broadcastRoom(room, { type: 'troll', text, targetId: token });
}

function handleEquipDeathEffect(ws, token, msg) {
  const room = tokenToRoom.get(token) ? rooms[tokenToRoom.get(token)] : null;
  const validIds = Object.keys(COSMETICS).filter((id) => COSMETICS[id].type === 'deathEffect' && COSMETICS[id].enabled);
  const effect = validIds.includes(msg.effect) ? msg.effect : 'default';
  const cosmetic = COSMETICS[effect];
  const u = getUnlocks(token);
  if (cosmetic.unlockRequirement && !u[effect]) {
    send(ws, { type: 'equip_rejected', effect, reason: 'LOCKED' });
    return;
  }
  if (room && room.players[token]) room.players[token].equippedEffect = effect;
  send(ws, { type: 'equip_ok', effect });
}

// Yeni, ümumi cosmetic növləri üçün (color/accessory/badge/title/emote/deathEffect)
function handleEquipCosmetic(ws, token, msg, room) {
  const cosmeticId = msg.cosmeticId;
  const cosmetic = getCosmetic(cosmeticId);
  if (!cosmetic || !cosmetic.enabled) { send(ws, { type: 'equip_rejected', cosmeticId: typeof cosmeticId === 'string' ? cosmeticId.slice(0, 40) : null, reason: 'UNKNOWN' }); return; }
  const u = getUnlocks(token);
  if (cosmetic.unlockRequirement && !u[cosmeticId]) { send(ws, { type: 'equip_rejected', cosmeticId, reason: 'LOCKED' }); return; }
  const slot = COSMETIC_SLOTS[cosmetic.type];
  if (slot && room && room.players[token]) room.players[token][slot.field] = cosmeticId;
  send(ws, { type: 'equip_ok', cosmeticId, cosmeticType: cosmetic.type });
}

// ============================================================
// EMOTES (Phase 6) — server validates, rate-limits and broadcasts.
// Emotes are cosmetic only: they never change movement, damage or targeting.
// ============================================================
const EMOTE_CONFIG = { cooldownMs: 1500, defaultDurationMs: 2200 };

function clearActiveEmote(room, token, notify) {
  const p = room.players[token];
  if (!p) return;
  if (p.emoteTimer) { clearTimeout(p.emoteTimer); p.emoteTimer = null; }
  if (p.activeEmote) {
    p.activeEmote = null;
    if (notify) broadcastRoom(room, { type: 'emote_end', token });
  }
}

function handleEmote(ws, room, token, msg) {
  const p = room.players[token];
  if (!p || !room.started) return;
  if (p.alive === false) { send(ws, { type: 'emote_rejected', reason: 'DEAD' }); return; }
  // No emoteId = legacy 'G' key -> the player's equipped emote (backward compat).
  const requested = msg.emoteId === undefined ? p.equippedEmote : msg.emoteId;
  const cosmetic = getCosmetic(requested);
  if (!cosmetic || cosmetic.type !== 'emote' || !cosmetic.enabled) { send(ws, { type: 'emote_rejected', reason: 'UNKNOWN' }); return; }
  if (cosmetic.unlockRequirement && !getUnlocks(token)[cosmetic.id]) { send(ws, { type: 'emote_rejected', reason: 'LOCKED' }); return; }
  const now = Date.now();
  if (p.lastEmoteAt && now - p.lastEmoteAt < EMOTE_CONFIG.cooldownMs) { send(ws, { type: 'emote_rejected', reason: 'COOLDOWN' }); return; }
  p.lastEmoteAt = now;
  clearActiveEmote(room, token, false);
  const duration = cosmetic.duration || EMOTE_CONFIG.defaultDurationMs;
  p.activeEmote = { id: cosmetic.id, until: now + duration };
  p.emoteTimer = setTimeout(() => clearActiveEmote(room, token, true), duration);
  broadcastRoom(room, { type: 'emote_used', token, emoteId: cosmetic.id, text: cosmetic.name, icon: cosmetic.icon || '', sfx: cosmetic.sfx || '', duration });
}


// ============================================================
// QUICK CHAT + REACTIONS (Phase 16) — fixed preset lists only (no free
// text), so there is no injection surface at all; the server validates the
// key against these tables and broadcasts the associated text/emoji it
// controls, never anything from the client payload itself.
// ============================================================
const QUICK_CHAT_PRESETS = Object.freeze({
  lol: 'LOL 😂', help: 'HELP!', run: 'RUN!', wait: 'WAIT!', comeHere: 'COME HERE',
  nice: 'NICE!', noWay: 'NO WAY!', what: 'WHAT?!', gg: 'GG', bruh: 'BRUH 💀', runAway: 'RUN AWAY!',
});
const REACTION_PRESETS = Object.freeze({ laugh: '😂', cry: '😭', skull: '💀', scream: '😱', side: '🤨', fire: '🔥', heart: '❤️', zap: '⚡' });
const SOCIAL_CONFIG = { chatCooldownMs: 1200, reactionCooldownMs: 800, now: () => Date.now() };

function handleQuickChat(room, token, ws, msg) {
  const p = room.players[token];
  if (!p || !room.started) return;
  const text = QUICK_CHAT_PRESETS[msg.key];
  if (!text) { send(ws, { type: 'chat_rejected', reason: 'UNKNOWN' }); return; }
  const now = SOCIAL_CONFIG.now();
  if (p.lastChatAt && now - p.lastChatAt < SOCIAL_CONFIG.chatCooldownMs) { send(ws, { type: 'chat_rejected', reason: 'COOLDOWN' }); return; }
  p.lastChatAt = now;
  broadcastRoom(room, { type: 'quick_chat', token, key: msg.key, text });
}
function handleReaction(room, token, ws, msg) {
  const p = room.players[token];
  if (!p || !room.started) return;
  const emoji = REACTION_PRESETS[msg.key];
  if (!emoji) { send(ws, { type: 'reaction_rejected', reason: 'UNKNOWN' }); return; }
  const now = SOCIAL_CONFIG.now();
  if (p.lastReactionAt && now - p.lastReactionAt < SOCIAL_CONFIG.reactionCooldownMs) { send(ws, { type: 'reaction_rejected', reason: 'COOLDOWN' }); return; }
  p.lastReactionAt = now;
  broadcastRoom(room, { type: 'reaction', token, key: msg.key, emoji });
}

const JOJO_SECRET_POS = { x: 34, z: -34, radius: 3.5 };
function handleInteractSecret(ws, token, room) {
  if (!room || !room.players[token] || !room.started) return;
  const p = room.players[token];
  if (p.alive === false) return; // dead players can't interact
  if (isSuspicious(p)) return;   // untrusted position
  const dist = Math.sqrt((p.x - JOJO_SECRET_POS.x) ** 2 + (p.z - JOJO_SECRET_POS.z) ** 2);
  if (dist > JOJO_SECRET_POS.radius) { send(ws, { type: 'interact_rejected', reason: 'TOO_FAR' }); return; }
  const ach = grantAchievement(token, 'jojo_reference_found');
  if (ach) send(ws, { type: 'achievement_unlocked', id: 'jojo_reference_found', name: ach.name, grants: ach.grants });
  else send(ws, { type: 'interact_ok', already: true });
}

// Thor çəkici hadisəsi (otaq başına, oyun başlayandan sonra)
const THOR_MAX = 2;
const THOR_CHANCE = 0.35;
// Mutable so tests can inject rng and shrink the timings.
const THOR_CONFIG = {
  minDelayMs: 90000, maxDelayMs: 240000,   // between rolls
  waitMinMs: 5000, waitMaxMs: 6000,        // warning -> strike
  hitDelayMs: 250,                         // strike -> hit/achievement
  rng: Math.random,
};

function clearThorTimers(room) {
  if (room.thorTimer) { clearTimeout(room.thorTimer); room.thorTimer = null; }
  if (room.thorSubTimer) { clearTimeout(room.thorSubTimer); room.thorSubTimer = null; }
  if (room.thorHitTimer) { clearTimeout(room.thorHitTimer); room.thorHitTimer = null; }
}

// Only connected, living players can be picked (a dead spectator can't be "targeted").
function pickThorTarget(room, rng) {
  const ids = room.order.filter((t) => room.players[t] && room.players[t].connected && room.players[t].alive !== false);
  if (!ids.length) return null;
  return ids[Math.floor((rng || THOR_CONFIG.rng)() * ids.length)];
}

function runThorEvent(room, targetId) {
  const t = room.players[targetId];
  if (!t || !rooms[room.code]) return false;
  broadcastRoom(room, { type: 'thor_event', targetId, x: t.x, y: t.y, z: t.z, ry: t.ry });
  const waitMs = THOR_CONFIG.waitMinMs + THOR_CONFIG.rng() * (THOR_CONFIG.waitMaxMs - THOR_CONFIG.waitMinMs);
  room.thorSubTimer = setTimeout(() => {
    room.thorSubTimer = null;
    const target = room.players[targetId];
    if (!target || !rooms[room.code]) return; // target left: no strike, no reward
    broadcastRoom(room, { type: 'thor_strike', targetId, x: target.x, y: target.y, z: target.z });
    room.thorHitTimer = setTimeout(() => {
      room.thorHitTimer = null;
      if (!rooms[room.code] || !room.players[targetId]) return;
      broadcastRoom(room, { type: 'thor_hit', targetId });
      const ach = grantAchievement(targetId, 'thunder_hammer_survivor');
      if (ach) {
        const p = room.players[targetId];
        if (p) send(p.ws, { type: 'achievement_unlocked', id: 'thunder_hammer_survivor', name: ach.name, grants: ach.grants });
      }
    }, THOR_CONFIG.hitDelayMs);
  }, waitMs);
  return true;
}

function thorCheck(room) {
  if (!rooms[room.code] || !room.started) return false;
  if (room.thorSubTimer || room.thorHitTimer) return false; // one Thor at a time
  if (room.thorCount >= THOR_MAX || THOR_CONFIG.rng() >= THOR_CHANCE) return false;
  const targetId = pickThorTarget(room);
  if (!targetId) return false;
  room.thorCount++;
  return runThorEvent(room, targetId);
}

function scheduleThorForRoom(room) {
  clearThorTimers(room);
  room.thorCount = 0;
  const tick = () => {
    if (!rooms[room.code] || !room.started) return;
    const delay = THOR_CONFIG.minDelayMs + Math.random() * (THOR_CONFIG.maxDelayMs - THOR_CONFIG.minDelayMs);
    room.thorTimer = setTimeout(() => { thorCheck(room); tick(); }, delay);
  };
  tick();
}

// ============================================================
// RANDOM CHAOS EVENT SİSTEMİ (modular registry)
// ============================================================
// Bumped only on a breaking protocol change; clients that don't send it are
// never rejected (keeps this backward-compatible with every earlier phase).
const PROTOCOL_VERSION = 1;

const CHAOS_DURATION_MS = 15000;
// Mutable so tests can inject a deterministic rng / shorten timings.
const CHAOS_CONFIG = {
  checkMinMs: 70000,   // random delay between chaos rolls
  checkMaxMs: 130000,
  cooldownMs: 20000,   // quiet period after an event ends before another can start
  rng: Math.random,
};


// ============================================================
// BANANA WEAPON CHAOS (server-authoritative). Lives INSIDE the existing RandomEventRegistry ('banana_weapon').
// Physics is a small pure step function (stepBananas) driven by a room-owned interval that only exists while
// bananas exist; every timer is cleared by clearBananas() on room deletion / match end / restart.
// ============================================================
const BANANA_CONFIG = {
  now: () => Date.now(),
  speed: 15, upSpeed: 3.5, gravity: 22, rotSpeed: 9,     // rotSpeed is visual only (sent to clients, never simulated)
  hitRadius: 0.9, peelRadius: 0.9, bodyHeight: 1.8,
  slipMs: 4000, immunityMs: 1500, peelLifeMs: 15000, maxFlightMs: 5000,
  fireCooldownMs: 1200, maxPerOwner: 3, maxPerRoom: 12, stepMs: 50, groundY: 0.05,
};
function clearBananaLoop(room) { if (room.bananaTimer) { clearInterval(room.bananaTimer); room.bananaTimer = null; } }
function isSlipped(p) { return !!(p && p.bananaSlippedUntil && BANANA_CONFIG.now() < p.bananaSlippedUntil); }
function publicBananas(room) {
  const now = BANANA_CONFIG.now();
  return (room.bananas || []).map((b) => ({ bananaId: b.bananaId, kind: b.kind || 'banana', fuseMs: b.kind === 'bomb' ? Math.max(0, b.explodeAt - now) : 0, ownerPlayerId: b.ownerPlayerId, ownerUsername: b.ownerUsername, roomId: b.roomId,
    position: b.position.map((v) => Math.round(v * 100) / 100), velocity: b.velocity.map((v) => Math.round(v * 100) / 100), state: b.state, remainingMs: Math.max(0, b.expiresAt - now) }));
}
function clearBananas(room) {
  clearBananaLoop(room);
  room.bananas = [];
  for (const t in room.players) {
    const p = room.players[t];
    if (p.slipTimer) { clearTimeout(p.slipTimer); p.slipTimer = null; }
    p.bananaSlippedUntil = 0; p.bananaImmuneUntil = 0;
  }
}
function recoverFromSlip(room, token) {
  const p = room.players[token]; if (!p) return;
  if (p.slipTimer) { clearTimeout(p.slipTimer); p.slipTimer = null; }
  p.bananaSlippedUntil = 0; p.bananaImmuneUntil = BANANA_CONFIG.now() + BANANA_CONFIG.immunityMs;
  broadcastRoom(room, { type: 'banana_recovered', id: token });
}
function slipPlayer(room, token, banana) {
  const p = room.players[token]; const now = BANANA_CONFIG.now();
  if (!p || p.alive === false || !p.connected) return false;
  if (isSlipped(p) || now < (p.bananaImmuneUntil || 0)) return false; // no repeated / chained slip
  p.bananaSlippedUntil = now + BANANA_CONFIG.slipMs;
  p.pendingShot = null; // a slipped player cannot cash in a prior shoot credit
  if (p.slipTimer) clearTimeout(p.slipTimer);
  p.slipTimer = setTimeout(() => recoverFromSlip(room, token), BANANA_CONFIG.slipMs);
  if (p.slipTimer.unref) p.slipTimer.unref();
  // ownerUsername is the server-stored, already-sanitized name of the owner; the client never supplies it.
  broadcastRoom(room, { type: 'banana_slipped', id: token, state: 'BANANA_SLIPPED', ownerUsername: banana.ownerUsername, durationMs: BANANA_CONFIG.slipMs });
  return true;
}
function removeBanana(room, b, why) {
  room.bananas = room.bananas.filter((x) => x !== b);
  broadcastRoom(room, { type: 'banana_removed', bananaId: b.bananaId, why });
}
function stepBananas(room, dtSec, nowOverride) {
  if (!room || !room.bananas || !room.bananas.length) return;
  const C = BANANA_CONFIG; const now = nowOverride === undefined ? C.now() : nowOverride; const layout = roomLayout(room);
  const dt = Math.max(0, Math.min(0.25, Number(dtSec) || 0));
  for (const b of room.bananas.slice()) {
    if (b.kind === 'bomb') { stepBomb(room, b, dt, now, layout); continue; }
    if (now >= b.expiresAt) { removeBanana(room, b, 'EXPIRED'); continue; }
    if (b.state === 'flying') {
      const px = b.position[0], pz = b.position[2];
      b.velocity[1] -= C.gravity * dt;
      b.position[0] += b.velocity[0] * dt; b.position[1] += b.velocity[1] * dt; b.position[2] += b.velocity[2] * dt;
      const bound = MOVE_CONFIG.bound;
      if (Math.abs(b.position[0]) > bound || Math.abs(b.position[2]) > bound) { removeBanana(room, b, 'OUT_OF_BOUNDS'); continue; }
      let hit = null;
      for (const t of room.order) {
        const p = room.players[t];
        if (!p || t === b.ownerPlayerId || p.alive === false || !p.connected) continue;
        const dxz = Math.hypot(p.x - b.position[0], p.z - b.position[2]);
        if (dxz <= C.hitRadius && b.position[1] >= p.y - C.bodyHeight && b.position[1] <= p.y + 0.4) { hit = t; break; }
      }
      if (hit) { slipPlayer(room, hit, b); removeBanana(room, b, 'HIT'); continue; }
      const blocked = BBMaps.pointBlocked(b.position[0], b.position[2], 0.3, layout);
      if (blocked) { b.position[0] = px; b.position[2] = pz; }
      if (blocked || b.position[1] <= C.groundY) {
        b.position[1] = C.groundY; b.velocity = [0, 0, 0]; b.state = 'peel'; b.expiresAt = now + C.peelLifeMs;
        broadcastRoom(room, { type: 'banana_landed', bananaId: b.bananaId, position: b.position.map((v) => Math.round(v * 100) / 100), remainingMs: C.peelLifeMs });
      }
    } else if (b.state === 'peel') {
      for (const t of room.order) {
        const p = room.players[t];
        if (!p || p.alive === false || !p.connected) continue;
        if (Math.hypot(p.x - b.position[0], p.z - b.position[2]) <= C.peelRadius && p.y - C.bodyHeight <= C.groundY + 0.5) {
          if (slipPlayer(room, t, b)) { removeBanana(room, b, 'SLIPPED'); break; }
        }
      }
    }
  }
  if (!room.bananas.length) clearBananaLoop(room);
}

// ============================================================
// BOMB (slot 3). Reuses the room-owned projectile list + loop of the banana system (room.bananas, stepBananas, clearBananas) with kind:'bomb':
// no second projectile engine / loop / timer. Flies with the same gravity/obstacle/ground rules, lands, and explodes when the fuse ends.
// Damage, falloff, line of sight, friendly fire and kill credit are ALL decided here; the client only draws the effect from `bomb_exploded`.
// ============================================================
function throwBomb(room, token, p, aim) {
  const C = BOMB_CONFIG, now = BANANA_CONFIG.now();
  const wait = (p.lastBombAt || 0) + C.cooldownMs - now;
  if (p.lastBombAt && wait > 0) { send(p.ws, { type: 'bomb_rejected', reason: 'COOLDOWN', remainingMs: wait }); return false; }
  room.bananas = room.bananas || [];
  if (room.bananas.length >= BANANA_CONFIG.maxPerRoom) { send(p.ws, { type: 'bomb_rejected', reason: 'ROOM_LIMIT' }); return false; }
  if (room.bananas.some((b) => b.kind === 'bomb' && b.ownerPlayerId === token)) { send(p.ws, { type: 'bomb_rejected', reason: 'ALREADY_ACTIVE' }); return false; }
  p.lastBombAt = now;
  const h = Math.hypot(aim.dx, aim.dz) || 1;
  const b = {
    bananaId: 'bomb' + (room.bananaSeq = (room.bananaSeq || 0) + 1), kind: 'bomb', ownerPlayerId: token, ownerUsername: p.name, roomId: room.code,
    position: [p.x + (aim.dx / h) * 0.6, Math.max(p.y - 0.2, 0.5), p.z + (aim.dz / h) * 0.6],
    velocity: [(aim.dx / h) * C.throwSpeed, C.upSpeed + Math.max(-0.3, Math.min(0.6, aim.dy)) * C.throwSpeed * 0.5, (aim.dz / h) * C.throwSpeed],
    state: 'flying', createdAt: now, expiresAt: now + C.fuseMs + 1000, explodeAt: now + C.fuseMs,
  };
  room.bananas.push(b);
  broadcastRoom(room, { type: 'bomb_spawn', bombId: b.bananaId, ownerPlayerId: token, position: b.position.map((v) => Math.round(v * 100) / 100), velocity: b.velocity.map((v) => Math.round(v * 100) / 100), fuseMs: C.fuseMs });
  send(p.ws, { type: 'bomb_ok', cooldownMs: C.cooldownMs });
  ensureBananaLoop(room);
  return true;
}
function stepBomb(room, b, dt, now, layout) {
  const C = BANANA_CONFIG;
  if (now >= b.explodeAt) { explodeBomb(room, b); return; }
  if (b.state !== 'flying') return;
  const px = b.position[0], pz = b.position[2];
  b.velocity[1] -= C.gravity * dt;
  b.position[0] += b.velocity[0] * dt; b.position[1] += b.velocity[1] * dt; b.position[2] += b.velocity[2] * dt;
  if (Math.abs(b.position[0]) > MOVE_CONFIG.bound || Math.abs(b.position[2]) > MOVE_CONFIG.bound) { removeBanana(room, b, 'OUT_OF_BOUNDS'); return; }
  const blocked = BBMaps.pointBlocked(b.position[0], b.position[2], 0.3, layout);
  if (blocked) { b.position[0] = px; b.position[2] = pz; }
  if (blocked || b.position[1] <= C.groundY) {
    b.position[1] = C.groundY; b.velocity = [0, 0, 0]; b.state = 'landed';
    broadcastRoom(room, { type: 'bomb_landed', bombId: b.bananaId, position: b.position.map((v) => Math.round(v * 100) / 100) });
  }
}
function explodeBomb(room, b) {
  room.bananas = (room.bananas || []).filter((x) => x !== b);
  const C = BOMB_CONFIG, layout = roomLayout(room), owner = room.players[b.ownerPlayerId];
  broadcastRoom(room, { type: 'bomb_exploded', bombId: b.bananaId, position: b.position.map((v) => Math.round(v * 100) / 100), radius: C.radius });
  if (!owner || !matchActive(room)) return;
  for (const t of room.order.slice()) {
    if (!matchActive(room)) break; // a kill earlier in this loop may have ended the match
    const tp = room.players[t];
    if (!tp || tp.alive === false || !tp.connected) continue;
    if (t !== b.ownerPlayerId && room.mode === 'team' && tp.team === owner.team && !room.friendlyFire) continue; // own team is safe unless friendly fire is on
    const dx = tp.x - b.position[0], dy = (tp.y - C.torsoDrop) - b.position[1], dz = tp.z - b.position[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > C.radius) continue;
    if (BBMaps.segmentBlocked(b.position[0], b.position[2], tp.x, tp.z, layout)) continue; // walls stop the blast
    let dmg = Math.max(C.minDamage, Math.round(C.maxDamage * (1 - dist / C.radius)));
    if (t === b.ownerPlayerId) dmg = Math.round(dmg * C.selfDamageFactor);
    dealDamage(room, b.ownerPlayerId, owner, t, tp, dmg, false);
  }
}
function handleSelectSlot(room, token, msg) {
  const p = room && room.players[token];
  if (!p || !msg || typeof msg !== 'object') return;
  const slot = msg.slot;
  if (typeof slot !== 'string' || !SLOTS.includes(slot)) { send(p.ws, { type: 'slot_rejected', reason: 'UNKNOWN_SLOT' }); return; }
  if (!room.started || !matchActive(room)) { send(p.ws, { type: 'slot_rejected', reason: 'NOT_ACTIVE' }); return; }
  if (p.alive === false) { send(p.ws, { type: 'slot_rejected', reason: 'DEAD' }); return; }
  if (p.bananaActive || isSlipped(p)) { send(p.ws, { type: 'slot_rejected', reason: p.bananaActive ? 'BANANA_LOCK' : 'SLIPPED' }); return; }
  const now = MATCH_CONFIG.now();
  if (p.lastWeaponSwitchAt && now - p.lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) { send(p.ws, { type: 'slot_rejected', reason: 'COOLDOWN' }); return; }
  p.lastWeaponSwitchAt = now; p.slot = slot;
  send(p.ws, { type: 'slot_ok', slot });
  broadcastRoom(room, { type: 'slot_changed', id: token, slot }, token);
}
function ensureBananaLoop(room) {
  if (room.bananaTimer) return;
  let last = BANANA_CONFIG.now();
  room.bananaTimer = setInterval(() => {
    if (!rooms[room.code]) { clearBananaLoop(room); return; }
    const now = BANANA_CONFIG.now(); const dt = (now - last) / 1000; last = now;
    stepBananas(room, dt, now);
  }, BANANA_CONFIG.stepMs);
  if (room.bananaTimer.unref) room.bananaTimer.unref();
}
// Throw: called only from a validated `shoot` of a player that the SERVER made a banana holder.
function throwBanana(room, token, p, aim) {
  const C = BANANA_CONFIG; const now = C.now();
  if (p.lastBananaAt && now - p.lastBananaAt < C.fireCooldownMs) return false;
  room.bananas = room.bananas || [];
  if (room.bananas.length >= C.maxPerRoom || room.bananas.filter((b) => b.ownerPlayerId === token).length >= C.maxPerOwner) return false;
  p.lastBananaAt = now;
  const h = Math.hypot(aim.dx, aim.dz) || 1;
  const b = {
    bananaId: 'ban' + (room.bananaSeq = (room.bananaSeq || 0) + 1), ownerPlayerId: token, ownerUsername: p.name, roomId: room.code,
    position: [p.x + (aim.dx / h) * 0.6, Math.max(p.y - 0.2, 0.5), p.z + (aim.dz / h) * 0.6],
    velocity: [(aim.dx / h) * C.speed, C.upSpeed + Math.max(-0.3, Math.min(0.6, aim.dy)) * C.speed * 0.5, (aim.dz / h) * C.speed],
    state: 'flying', createdAt: now, expiresAt: now + C.maxFlightMs,
  };
  room.bananas.push(b);
  broadcastRoom(room, { type: 'banana_spawn', bananaId: b.bananaId, ownerPlayerId: token, ownerUsername: b.ownerUsername, position: b.position.map((v) => Math.round(v * 100) / 100), velocity: b.velocity.map((v) => Math.round(v * 100) / 100), rotSpeed: C.rotSpeed });
  ensureBananaLoop(room);
  return true;
}

const RandomEventRegistry = {
  pinkPop: {
    id: 'pinkPop', displayName: 'Pink Pop Chaos', probability: 0.10, duration: CHAOS_DURATION_MS, scope: 'all',
    start(room) {
      room.chaosState = { id: this.id, displayName: this.displayName, scope: 'all', until: Date.now() + this.duration };
      broadcastRoom(room, { type: 'chaos_event', id: this.id, displayName: this.displayName, scope: 'all', duration: this.duration });
    },
    end(room) {
      broadcastRoom(room, { type: 'chaos_event_end', id: this.id, scope: 'all' });
      room.chaosState = null;
    },
  },
  duckWeapon: {
    id: 'duckWeapon', displayName: 'Duck Weapon', probability: 0.05, duration: CHAOS_DURATION_MS, scope: 'single',
    start(room) {
      const ids = room.order.filter((t) => room.players[t] && room.players[t].connected);
      if (!ids.length) return false;
      const targetId = ids[Math.floor(CHAOS_CONFIG.rng() * ids.length)];
      const until = Date.now() + this.duration;
      room.players[targetId].duckWeaponUntil = until;
      room.chaosState = { id: this.id, displayName: this.displayName, scope: 'single', targetId, until };
      broadcastRoom(room, { type: 'chaos_event', id: this.id, displayName: this.displayName, scope: 'single', targetId, duration: this.duration });
      return true;
    },
    end(room) {
      const t = room.chaosState && room.chaosState.targetId;
      if (t && room.players[t]) room.players[t].duckWeaponUntil = 0;
      broadcastRoom(room, { type: 'chaos_event_end', id: this.id, scope: 'single', targetId: t });
      room.chaosState = null;
    },
  },
  greenOgre: {
    id: 'greenOgre', displayName: 'Green Ogre Chaos', probability: 0.07, duration: CHAOS_DURATION_MS, scope: 'single',
    start(room) {
      const ids = room.order.filter((t) => room.players[t] && room.players[t].connected);
      if (!ids.length) return false;
      const targetId = ids[Math.floor(CHAOS_CONFIG.rng() * ids.length)];
      const until = Date.now() + this.duration;
      room.chaosState = { id: this.id, displayName: this.displayName, scope: 'single', targetId, until };
      broadcastRoom(room, { type: 'chaos_event', id: this.id, displayName: this.displayName, scope: 'single', targetId, duration: this.duration });
      return true;
    },
    end(room) {
      broadcastRoom(room, { type: 'chaos_event_end', id: this.id, scope: 'single', targetId: room.chaosState && room.chaosState.targetId });
      room.chaosState = null;
    },
  },
  banana_weapon: {
    id: 'banana_weapon', displayName: 'Banana Weapon', probability: 0.04, duration: CHAOS_DURATION_MS, scope: 'single',
    start(room) {
      const ids = room.order.filter((t) => room.players[t] && room.players[t].connected && room.players[t].alive !== false);
      if (!ids.length) return false;
      const targetId = ids[Math.floor(CHAOS_CONFIG.rng() * ids.length)];
      const p = room.players[targetId];
      p.bananaSavedWeaponId = p.weaponId || DEFAULT_WEAPON_ID; // original weapon state, restored in end()
      p.bananaActive = true;
      room.chaosState = { id: this.id, displayName: this.displayName, scope: 'single', targetId, until: Date.now() + this.duration };
      broadcastRoom(room, { type: 'chaos_event', id: this.id, displayName: this.displayName, scope: 'single', targetId, duration: this.duration });
      return true;
    },
    end(room) {
      const t = room.chaosState && room.chaosState.targetId; const p = t && room.players[t];
      if (p) { p.bananaActive = false; if (p.bananaSavedWeaponId) p.weaponId = p.bananaSavedWeaponId; p.bananaSavedWeaponId = null; }
      broadcastRoom(room, { type: 'chaos_event_end', id: this.id, scope: 'single', targetId: t });
      room.chaosState = null;
    },
  },
};

// One roll per check, split into consecutive probability bands:
// [0,.10) pinkPop, [.10,.15) duckWeapon, [.15,.22) greenOgre, rest = nothing.
// (The old loop rolled each event in turn, which made the later events'
// real odds lower than their declared probability: duck ~4.5%, ogre ~6.0%.)
function rollChaosEvent(rng) {
  const r = (rng || CHAOS_CONFIG.rng)();
  let acc = 0;
  for (const key of Object.keys(RandomEventRegistry)) {
    const ev = RandomEventRegistry[key];
    acc = Math.round((acc + ev.probability) * 1e9) / 1e9; // avoid 0.1+0.05 = 0.15000000000000002 edge drift
    if (r < acc) return ev;
  }
  return null;
}

function validateChaosRegistry(reg) {
  const errors = [];
  let sum = 0;
  const ids = new Set();
  for (const [key, ev] of Object.entries(reg || {})) {
    if (ev.id !== key) errors.push(key + ': id mismatch');
    if (ids.has(ev.id)) errors.push(key + ': duplicate id');
    ids.add(ev.id);
    if (!(ev.probability > 0 && ev.probability < 1)) errors.push(key + ': bad probability');
    if (!(ev.duration > 0 && ev.duration <= 120000)) errors.push(key + ': bad duration');
    if (typeof ev.start !== 'function' || typeof ev.end !== 'function') errors.push(key + ': missing start/end');
    sum += ev.probability || 0;
  }
  if (sum > 1) errors.push('probabilities sum > 1');
  return errors;
}

// Central guarded start: only one event per room at a time, only while the
// round is running, and not during the post-event cooldown.
function startChaosEvent(room, ev) {
  if (!room || !ev || !rooms[room.code] || !room.started) return false;
  if (room.chaosState) return false; // duplicate prevention
  if (Date.now() < (room.chaosCooldownUntil || 0)) return false;
  if (ev.start(room) === false || !room.chaosState) { room.chaosState = null; return false; }
  if (room.chaosEndTimer) clearTimeout(room.chaosEndTimer);
  room.chaosEndTimer = setTimeout(() => endChaosEvent(room, ev.id), ev.duration);
  for (const t of room.order) { const p = room.players[t]; if (p && (room.chaosState.scope !== 'single' || room.chaosState.targetId === t)) p.chaosExposure = (p.chaosExposure || 0) + 1; }
  return true;
}

// Idempotent end: safe to call from the timer, target removal, room stop.
function endChaosEvent(room, expectedId) {
  if (!room || !room.chaosState) return false;
  if (expectedId && room.chaosState.id !== expectedId) return false;
  const ev = RandomEventRegistry[room.chaosState.id];
  if (room.chaosEndTimer) { clearTimeout(room.chaosEndTimer); room.chaosEndTimer = null; }
  if (ev) ev.end(room); else room.chaosState = null;
  room.chaosCooldownUntil = Date.now() + CHAOS_CONFIG.cooldownMs;
  return true;
}

function clearChaosTimers(room) {
  if (room.chaosTimer) { clearTimeout(room.chaosTimer); room.chaosTimer = null; }
  if (room.chaosEndTimer) { clearTimeout(room.chaosEndTimer); room.chaosEndTimer = null; }
}

function chaosCheck(room) {
  if (!rooms[room.code] || !room.started) return;
  if (room.chaosEnabled === false) return; // host turned Chaos off for this room
  if (room.chaosState || Date.now() < (room.chaosCooldownUntil || 0)) return;
  const ev = rollChaosEvent();
  if (ev) startChaosEvent(room, ev);
}

function scheduleChaosForRoom(room) {
  clearChaosTimers(room); // never stack schedules (e.g. game restarted)
  room.chaosCooldownUntil = 0;
  const tick = () => {
    if (!rooms[room.code] || !room.started) return;
    const delay = CHAOS_CONFIG.checkMinMs + Math.random() * (CHAOS_CONFIG.checkMaxMs - CHAOS_CONFIG.checkMinMs);
    room.chaosTimer = setTimeout(() => { chaosCheck(room); tick(); }, delay);
  };
  tick();
}

wss.on('connection', (ws) => {
  const joinAttempts = { count: 0, windowStart: Date.now() };
  // REQUIRED: without an 'error' listener, a protocol error from ONE client (e.g. a frame above
  // maxPayload -> RangeError 1009, bad UTF-8, invalid opcode) is an unhandled 'error' event and
  // crashes the whole Node process = every room. ws closes the offending socket by itself; we only
  // have to stop the exception (found by tests/realws_smoke.js against the real ws library).
  ws.on('error', (err) => { console.error('[ws] socket error (client dropped):', err && err.code || err && err.message); });

  const handleWsMessage = (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello') {
      let token = isValidToken(msg.token) ? msg.token : null;
      if (!token) token = crypto.randomUUID();
      wsToToken.set(ws, token);

      // reconnect: əvvəlki otaqda idisə bərpa et
      const roomCode = tokenToRoom.get(token);
      if (roomCode && rooms[roomCode] && rooms[roomCode].players[token]) {
        const room = rooms[roomCode];
        const p = room.players[token];
        p.ws = ws; p.connected = true;
        if (p.disconnectTimer) { clearTimeout(p.disconnectTimer); p.disconnectTimer = null; }
        send(ws, { type: 'hello_ok', token, unlocks: getUnlocks(token), catalog: getPublicCatalog() });
        send(ws, { ...roomStatePayload(room), type: 'room_rejoined' });
        if (room.started) {
          send(ws, { type: 'game_started', map: room.map, mapSeed: room.mapSeed, mode: room.mode, rejoin: true, pickups: publicPickups(room) });
          const rp = room.players[token];
          if (rp && rp.alive !== false) { beginServerSync(rp, rp.x, rp.y, rp.z); send(ws, { type: 'position_correct', x: rp.x, y: rp.y, z: rp.z, reason: 'REJOIN' }); }
        }
        broadcastRoom(room, { type: 'player_reconnected', token }, token);
        broadcastRoomState(room);
        return;
      }
      send(ws, { type: 'hello_ok', token, unlocks: getUnlocks(token), catalog: getPublicCatalog() });
      return;
    }

    const token = wsToToken.get(ws);
    if (!token) return; // hello göndərməmiş heç nə qəbul etmirik

    // PING (Phase 2) — real round-trip measurement. Works any time after
    // hello (lobby or in-game), needs no room. Server never invents a
    // number: it just echoes the client's own timestamp/seq straight back
    // as fast as possible so the client can compute a true RTT itself.
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t, seq: msg.seq, serverTime: Date.now() });
      return;
    }

    if (msg.type === 'create_room') {
      const code = genRoomCode();
      const maxPlayers = Math.max(2, Math.min(12, parseInt(msg.maxPlayers) || 8));
      const map = ['purple', 'forest', 'house'].includes(msg.map) ? msg.map : 'purple';
      const mode = ['ffa', 'team', 'zombie'].includes(msg.mode) ? msg.mode : 'ffa';
      const name = sanitizeName(msg.name);
      const room = {
        code, hostToken: token, maxPlayers, map, mode,
        roundTimeSec: clampInt(msg.roundTimeSec, MATCH_CONFIG.minRoundSec, MATCH_CONFIG.maxRoundSec, MATCH_CONFIG.defaultRoundSec),
        scoreLimit: clampInt(msg.scoreLimit, MATCH_CONFIG.minScore, MATCH_CONFIG.maxScore, MATCH_CONFIG.defaultScore),
        match: null, mapSeed: newMapSeed(),
        started: false, isPublic: !!msg.isPublic,
        players: Object.create(null), order: [],
      };
      applyRoomFlags(room, msg);
      room.players[token] = {
        ws, name, ready: false, team: 1, connected: true,
        x: 0, y: 1.6, z: 0, ry: 0, health: 100, kills: 0, deaths: 0,
        disconnectTimer: null, ...freshPlayerExtra(), ...resolveCosmeticFields(token, msg.cosmetics),
      };
      room.order.push(token);
      rooms[code] = room;
      tokenToRoom.set(token, code);
      send(ws, { type: 'room_created', code });
      broadcastRoomState(room);
      return;
    }

    if (msg.type === 'quick_play') {
      const name = sanitizeName(msg.name);
      let room = Object.values(rooms).find((r) => r.isPublic && !r.started && connectedCount(r) < r.maxPlayers);
      const isNewRoom = !room; // matters for which message we send below
      if (!room) {
        const code = genRoomCode();
        room = {
          code, hostToken: token, maxPlayers: 8, map: 'purple', mode: 'ffa',
          roundTimeSec: MATCH_CONFIG.defaultRoundSec, scoreLimit: MATCH_CONFIG.defaultScore, match: null, mapSeed: newMapSeed(),
          started: false, isPublic: true, players: Object.create(null), order: [],
        };
        applyRoomFlags(room);
        rooms[code] = room;
      }
      room.players[token] = {
        ws, name: dedupeName(room, name), ready: false, team: (room.order.length % 2) + 1, connected: true,
        x: 0, y: 1.6, z: 0, ry: 0, health: 100, kills: 0, deaths: 0,
        disconnectTimer: null, ...freshPlayerExtra(), ...resolveCosmeticFields(token, msg.cosmetics),
      };
      room.order.push(token);
      tokenToRoom.set(token, room.code);
      // Room code IS created by the server either way; this only tells the
      // client whether Quick Play made a fresh room or slotted them into one.
      send(ws, isNewRoom ? { type: 'room_created', code: room.code, quick: true } : { type: 'room_joined', code: room.code, quick: true });
      broadcastRoomState(room);
      return;
    }

    if (msg.type === 'join_room') {
      const now = Date.now();
      if (now - joinAttempts.windowStart > JOIN_ATTEMPT_WINDOW_MS) { joinAttempts.count = 0; joinAttempts.windowStart = now; }
      joinAttempts.count++;
      if (joinAttempts.count > JOIN_ATTEMPT_LIMIT) {
        send(ws, { type: 'join_error', reason: 'RATE_LIMITED' });
        return;
      }
      const code = (typeof msg.roomCode === 'string' ? msg.roomCode : '').toUpperCase().trim();
      const room = /^[A-Z0-9]{6}$/.test(code) && Object.prototype.hasOwnProperty.call(rooms, code) ? rooms[code] : null;
      if (!room) { send(ws, { type: 'join_error', reason: 'NOT_FOUND' }); return; }
      if (room.started) { send(ws, { type: 'join_error', reason: 'ALREADY_STARTED' }); return; }
      if (connectedCount(room) >= room.maxPlayers) { send(ws, { type: 'join_error', reason: 'FULL' }); return; }
      if (room.players[token] && room.players[token].connected) { send(ws, { type: 'join_error', reason: 'ALREADY_IN_ROOM' }); return; }
      if (typeof msg.protocolVersion === 'number' && msg.protocolVersion !== PROTOCOL_VERSION) {
        send(ws, { type: 'join_error', reason: 'PROTOCOL_MISMATCH', serverVersion: PROTOCOL_VERSION }); return;
      }

      const name = dedupeName(room, sanitizeName(msg.name));
      room.players[token] = {
        ws, name, ready: false, team: (room.order.length % 2) + 1, connected: true,
        x: 0, y: 1.6, z: 0, ry: 0, health: 100, kills: 0, deaths: 0,
        disconnectTimer: null, ...freshPlayerExtra(), ...resolveCosmeticFields(token, msg.cosmetics),
      };
      room.order.push(token);
      tokenToRoom.set(token, room.code);
      send(ws, { type: 'room_joined', code: room.code });
      broadcastRoom(room, { type: 'player_joined', token, name }, token);
      broadcastRoomState(room);
      return;
    }

    // aşağıdakı bütün mesajlar üçün oyunçunun bir otaqda olması lazımdır
    const roomCode = tokenToRoom.get(token);
    const room = roomCode ? rooms[roomCode] : null;

    if (msg.type === 'leave_room') {
      if (room) removePlayerFromRoom(room, token, 'left');
      return;
    }
    if (msg.type === 'set_team') {
      if (room && room.players[token] && !room.started) {
        room.players[token].team = msg.team === 2 ? 2 : 1;
        broadcastRoomState(room);
      }
      return;
    }
    if (msg.type === 'player_ready') {
      if (room && room.players[token]) { room.players[token].ready = true; broadcastRoomState(room); }
      return;
    }
    if (msg.type === 'player_unready') {
      if (room && room.players[token]) { room.players[token].ready = false; broadcastRoomState(room); }
      return;
    }
    if (msg.type === 'room_settings') {
      if (!room || room.hostToken !== token || room.started) return; // host only, lobby only (never mid-match)
      if (!msg || typeof msg.settings !== 'object' || msg.settings === null || Array.isArray(msg.settings)) return;
      const st = msg.settings;
      if (st.maxPlayers !== undefined) room.maxPlayers = Math.max(Math.max(2, connectedCount(room)), Math.min(12, clampInt(st.maxPlayers, 2, 12, room.maxPlayers)));
      if (st.roundTimeSec !== undefined) room.roundTimeSec = clampInt(st.roundTimeSec, MATCH_CONFIG.minRoundSec, MATCH_CONFIG.maxRoundSec, room.roundTimeSec);
      if (st.scoreLimit !== undefined) room.scoreLimit = clampInt(st.scoreLimit, MATCH_CONFIG.minScore, MATCH_CONFIG.maxScore, room.scoreLimit);
      applyRoomFlags(room, st);
      broadcastRoomState(room);
      return;
    }
    if (msg.type === 'start_game') {
      if (!room || room.hostToken !== token) return; // yalnız host
      if (room.started) return;
      const others = room.order.filter((t) => t !== room.hostToken && room.players[t] && room.players[t].connected);
      const allReady = others.every((t) => room.players[t] && room.players[t].ready);
      if (!allReady) { send(ws, { type: 'start_rejected', reason: 'NOT_ALL_READY' }); return; }
      startRoomGame(room);
      return;
    }
    if (msg.type === 'rematch') {
      if (!room || room.hostToken !== token || !room.match || room.match.state !== 'ended') return;
      startRoomGame(room);
      return;
    }
    if (msg.type === 'return_lobby') {
      if (!room || room.hostToken !== token || !room.match || room.match.state !== 'ended') return;
      clearMatchTimers(room); clearPickupTimers(room); clearBananas(room);
      room.started = false; room.match = null;
      for (const t of room.order) if (room.players[t]) room.players[t].ready = false;
      broadcastRoomState(room);
      return;
    }
    if (msg.type === 'equip_death_effect') { handleEquipDeathEffect(ws, token, msg); return; }
    if (msg.type === 'equip_cosmetic') { handleEquipCosmetic(ws, token, msg, room); return; }

    if (!room || !room.started || !room.players[token]) return;
    if (msg.type === 'update') handleUpdate(room, token, msg);
    else if (msg.type === 'shoot') handleShoot(room, token, msg);
    else if (msg.type === 'hit') handleHit(room, token, msg);
    else if (msg.type === 'equip_weapon') handleEquipWeapon(room, token, msg);
    else if (msg.type === 'select_slot') handleSelectSlot(room, token, msg);
    else if (msg.type === 'troll_pickup') handleTrollPickup(room, token, msg);
    else if (msg.type === 'dash_request') handleDashRequest(room, token, msg, ws);
    else if (msg.type === 'interact_secret') handleInteractSecret(ws, token, room);
    else if (msg.type === 'spectate_request') { if (room.spectatorEnabled !== false) handleSpectateRequest(room, token, msg); }
    else if (msg.type === 'quick_chat') handleQuickChat(room, token, ws, msg);
    else if (msg.type === 'reaction') handleReaction(room, token, ws, msg);
    else if (msg.type === 'emote_trigger') handleEmote(ws, room, token, msg);
  };

  // Containment: one malformed/hostile packet must never take the whole server (all rooms) down.
  // Legit traffic is tiny (< 2 KB); anything above MAX_MESSAGE_BYTES is dropped before parsing.
  ws.on('message', (raw) => {
    if (raw && typeof raw.length === 'number' && raw.length > MAX_MESSAGE_BYTES) return;
    try { handleWsMessage(raw); }
    catch (err) { handlerErrorCount++; console.error('[ws] handler error, message dropped:', err && err.message); }
  });

  ws.on('close', () => {
    const token = wsToToken.get(ws);
    wsToToken.delete(ws);
    if (!token) return;
    const roomCode = tokenToRoom.get(token);
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    const p = room.players[token];
    if (!p) return;
    // A stale socket (the player already re-helloed on a newer socket, e.g. half-open TCP
    // on mobile) must never mark the live connection as dropped or arm the removal timer.
    if (p.ws && p.ws !== ws) return;
    p.connected = false;
    clearActiveEmote(room, token, true); // don't leave a dropped player stuck mid-emote
    migrateHostIfNeeded(room); // host disconnect olsa belə otaq dərhal yeni host alsın
    if (room.started) reassignSpectatorsOf(room, token); // don't leave spectators stuck on a dropped player
    broadcastRoomState(room);
    p.disconnectTimer = setTimeout(() => {
      // reconnect etmədi - real şəkildə çıxar
      removePlayerFromRoom(room, token, 'timeout');
    }, DISCONNECT_GRACE_MS);
  });
});

// otaq başına oyun vəziyyətini saniyədə ~15 dəfə yayımla
// What every client in the room sees about a player (per-tick broadcast).
function buildPlayerPublicState(room, p) {
  const st = {
    name: p.name, team: p.team, mode: room.mode,
    x: p.x, y: p.y, z: p.z, ry: p.ry,
    health: p.health, kills: p.kills, deaths: p.deaths,
    alive: p.alive !== false, weaponId: p.weaponId || DEFAULT_WEAPON_ID, slot: slotOf(p),
  };
  for (const type in COSMETIC_SLOTS) {
    const slot = COSMETIC_SLOTS[type];
    if (slot.stateKey) st[slot.stateKey] = p[slot.field];
  }
  return st;
}

// ============================================================
// INTEREST MANAGEMENT (server-side, per recipient) — NOT render culling.
// What it changes: only HOW OFTEN a remote player's position and HOW OFTEN their
// unchanging "meta" fields (name/team/cosmetics/health/...) are re-sent in the
// periodic `state` broadcast. What it never changes: gameplay events (shoot, hit,
// damage, kill, respawn, ...) are separate messages and are never filtered; the
// server's own simulation/validation uses full-rate server positions; nobody is
// ever dropped from view entirely (far players just update less often).
// Dead recipients (spectating / killcam) always get full rate.
// ============================================================
const INTEREST_CONFIG = {
  enabled: true,
  nearR: 35,          // <= nearR units: every tick (~15 Hz)
  midR: 60,           // <= midR: every midEvery ticks
  midEvery: 2,
  farEvery: 3,        // beyond midR (only reachable across the arena diagonal)
  metaResyncTicks: 60,   // re-send full meta to everyone every ~4 s as a safety net
  rosterResyncTicks: 15, // re-send the roster every ~1 s (client removes players absent from it)
};
const interestByWs = new WeakMap(); // ws -> { epoch, meta: Map(token -> metaString), rosterSig }
const POS_KEYS = { x: 1, y: 1, z: 1, ry: 1 };
function metaString(st) { const m = {}; for (const k in st) if (!POS_KEYS[k]) m[k] = st[k]; return JSON.stringify(m); }
function interestEvery(recipient, target) {
  if (recipient.alive === false) return 1;
  const dx = recipient.x - target.x, dz = recipient.z - target.z, d2 = dx * dx + dz * dz;
  if (d2 <= INTEREST_CONFIG.nearR * INTEREST_CONFIG.nearR) return 1;
  if (d2 <= INTEREST_CONFIG.midR * INTEREST_CONFIG.midR) return INTEREST_CONFIG.midEvery;
  return INTEREST_CONFIG.farEvery;
}
// Pure builder (exported for tests): the `state` message one recipient gets this tick.
function buildStateFor(room, recipientToken, full, sigs, tick) {
  const me = room.players[recipientToken];
  let seen = interestByWs.get(me.ws);
  if (!seen || seen.epoch !== room.interestEpoch) { seen = { epoch: room.interestEpoch, meta: new Map(), rosterSig: null }; interestByWs.set(me.ws, seen); }
  const players = {};
  const resync = tick % INTEREST_CONFIG.metaResyncTicks === 0;
  let idx = 0;
  const live = [];
  for (const t of room.order) {
    const p = room.players[t];
    if (!p) continue;
    live.push(t);
    idx++;
    if (t === recipientToken) { players[t] = full[t]; continue; } // own entry stays complete (weaponId/slot/cosmetics + position)
    if (!INTEREST_CONFIG.enabled) { players[t] = full[t]; continue; }
    const needMeta = resync || seen.meta.get(t) !== sigs[t];
    if (needMeta) { players[t] = full[t]; seen.meta.set(t, sigs[t]); continue; }
    if ((tick + idx) % interestEvery(me, p) === 0) { const st = full[t]; players[t] = { x: st.x, y: st.y, z: st.z, ry: st.ry }; }
  }
  const msg = { type: 'state', players };
  const rosterSig = live.join(',');
  if (!INTEREST_CONFIG.enabled || seen.rosterSig !== rosterSig || tick % INTEREST_CONFIG.rosterResyncTicks === 0) { msg.roster = live; seen.rosterSig = rosterSig; }
  // Forget what we told this socket about players who are gone: the client drops them on the roster, so if the SAME token comes back with an
  // unchanged meta signature it must be sent in full again (otherwise the client would ignore its position-only entries until the next resync).
  for (const t of seen.meta.keys()) if (!room.players[t]) seen.meta.delete(t);
  return msg;
}

let lastTickAt = Date.now();
setInterval(() => {
  const now = Date.now();
  const dtSec = Math.min(0.2, (now - lastTickAt) / 1000);
  lastTickAt = now;
  for (const code in rooms) {
    const room = rooms[code];
    if (!room.started) continue;
    room.tick = (room.tick || 0) + 1;
    const full = {}, sigs = {};
    for (const token of room.order) {
      const p = room.players[token];
      if (!p) continue;
      full[token] = buildPlayerPublicState(room, p);
      sigs[token] = metaString(full[token]);
      // stamina bərpası (dash zamanı sərf olunur, vaxtla özü dolur)
      p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN_PER_SEC * dtSec);
      if (p.connected) {
        send(p.ws, {
          type: 'self_state',
          stamina: p.stamina,
          dashReady: now >= p.dashCooldownUntil,
          dashCooldownMs: Math.max(0, p.dashCooldownUntil - now),
          slot: slotOf(p),
          bombCooldownMs: Math.max(0, (p.lastBombAt || 0) + BOMB_CONFIG.cooldownMs - BANANA_CONFIG.now()),
        });
      }
    }
    // per-recipient `state` (room membership is the first filter: only this room's players are iterated)
    for (const token of room.order) {
      const p = room.players[token];
      if (p && p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(buildStateFor(room, token, full, sigs, room.tick)));
    }
  }
}, 66);

// Clears every timer the game runtime owns (used on SIGINT/SIGTERM and by
// tests). State is in-memory only, so a restart starts with no rooms and no
// stale chaos/respawn/emote timers.
function shutdownAllRooms() {
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    clearChaosTimers(room);
    clearThorTimers(room);
    clearPickupTimers(room);
    clearMatchTimers(room);
    clearBananas(room);
    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);
    for (const t in room.players) {
      const pl = room.players[t];
      if (pl.emoteTimer) clearTimeout(pl.emoteTimer);
      clearKillcam(pl);
      if (pl.disconnectTimer) clearTimeout(pl.disconnectTimer);
    }
    room.chaosState = null;
    delete rooms[code];
  }
}

function startServer(port) {
  const PORT = port || process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Badımcan Bəndələr server işə düşdü: http://localhost:${PORT}`);
    console.log('Dostların həmin şəbəkədəsə, öz IP-ni tapıb onlara ver (README-ə bax).');
  });
  // Clean stop: clear every room timer, close sockets, then exit.
  const stop = () => { shutdownAllRooms(); try { server.close(); } catch {} process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

if (require.main === module) {
  startServer();
}

// Test-only hooks: attached as properties on the exported function so the
// public API (module.exports is still a callable startServer) is unchanged.
// Lets an offline test harness drive wss 'connection'/'message' events and
// inspect room state without opening real sockets or npm-installing deps.
startServer.__test__ = { SLOTS, KNIFE_CONFIG, BOMB_CONFIG, slotOf, throwBomb, explodeBomb, dealDamage, handleSelectSlot, WEAPON_ASSET_STAGING, roomStatePayload, BANANA_CONFIG, stepBananas, throwBanana, slipPlayer, clearBananas, publicBananas, isSlipped, CHAOS_CONFIG, chaosCheck, startChaosEvent, endChaosEvent, GEOMETRY_CONFIG, SPAWN_CONFIG, pickSpawn, roomLayout, BBMaps, wss, rooms, PROTOCOL_VERSION, QUICK_CHAT_PRESETS, REACTION_PRESETS, SOCIAL_CONFIG, sanitizeName, dedupeName, connectedCount, removePlayerFromRoom, MOVE_CONFIG, isSuspicious, beginServerSync, THOR_CONFIG, thorCheck, runThorEvent, pickThorTarget, loadUnlocksFromDisk, saveUnlocks, grantAchievement, getUnlocks, isValidToken, UNLOCKS_PATH, JOJO_SECRET_POS, CHAOS_CONFIG, scheduleChaosForRoom, rollChaosEvent, validateChaosRegistry, startChaosEvent, endChaosEvent, chaosCheck, shutdownAllRooms, buildPlayerPublicState, buildStateFor, BBHitbox, INTEREST_CONFIG, metaString, COSMETIC_SLOTS, HIT_CONFIG, SHOOT_CONFIG, PICKUP_CONFIG, MAX_MESSAGE_BYTES, getHandlerErrorCount: () => handlerErrorCount, resetHandlerErrorCount: () => { handlerErrorCount = 0; }, initPickups, publicPickups, EMOTE_CONFIG, COSMETICS, ACHIEVEMENTS, RandomEventRegistry, ROOM_FLAG_DEFAULTS, MATCH_CONFIG, settleBountyOnKill, KILLCAM_MS, startKillcam, BOUNTY_CONFIG, publicBounty, WEAPONS, getWeapon, WEAPON_SWITCH_COOLDOWN_MS, activateMatch, endMatch, matchActive, buildMatchResult, clampInt };

module.exports = startServer;
