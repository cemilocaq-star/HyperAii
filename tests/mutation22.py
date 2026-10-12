#!/usr/bin/env python3
"""Mutation check for the Phase 22 security tests.

Copies the project to a temp dir (the real files are NEVER modified), applies ONE mutation at a time
to server.js / public/index.html / tests-visible config, runs `node tests/run.js` there and reports
which tests failed. A mutant that leaves the suite green is a SURVIVOR = a hole in the tests.

Usage: python3 tests/mutation22.py            (from the project root)
"""
import os, re, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MUTANTS = [
  # ---- Beta additions (match / weapons / bounty / killcam) ----
  ("match: hits accepted after match end", "server.js",
   "if (!room.started || !matchActive(room)) return;", "if (!room.started) return;"),
  ("match: score limit never ends the match", "server.js",
   "if (killer && killer.kills >= room.scoreLimit) endMatch(room, 'SCORE_LIMIT');", "if (false) endMatch(room, 'SCORE_LIMIT');"),
  ("match: endMatch can fire twice", "server.js",
   "if (!matchActive(room)) return false; // ends exactly once", ""),
  ("match: rematch allowed for non-host", "server.js",
   "if (!room || room.hostToken !== token || !room.match || room.match.state !== 'ended') return;\n      startRoomGame(room);",
   "if (!room || !room.match || room.match.state !== 'ended') return;\n      startRoomGame(room);"),
  ("match: timer not cleared on room deletion", "server.js",
   "    clearPickupTimers(room);\n    clearMatchTimers(room);\n    clearBananas(room);\n    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);\n    for (const t in room.players) { if",
   "    clearPickupTimers(room);\n    clearBananas(room);\n    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);\n    for (const t in room.players) { if"),
  ("streak: death does not reset victim streak", "server.js", "victim.streak = 0; victim.streakVictims = null;", ""),
  ("chaotic player: uses kills instead of chaos exposure", "server.js",
   "chaoticPlayer: best('chaosExposure')", "chaoticPlayer: best('kills')"),
  ("weapons: unknown weapon ids accepted (no registry check)", "server.js",
   "if (!w) { send(p.ws, { type: 'weapon_rejected', reason: 'UNKNOWN_WEAPON' }); return; }", "if (!w) { p.weaponId = msg.weaponId; return; }"),
  ("weapons: proto-pollution ids pass getWeapon", "server.js",
   "typeof id === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, id) ? WEAPONS[id] : null", "typeof id === 'string' ? (WEAPONS[id] || Object.prototype[id] || null) : null"),
  ("weapons: switch cooldown removed", "server.js",
   "if (p.lastWeaponSwitchAt && now - p.lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) { send(p.ws, { type: 'weapon_rejected'", "if (false) { send(p.ws, { type: 'weapon_rejected'"),
  ("slots: slot-switch cooldown removed", "server.js",
   "if (p.lastWeaponSwitchAt && now - p.lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) { send(p.ws, { type: 'slot_rejected'", "if (false) { send(p.ws, { type: 'slot_rejected'"),
  ("weapons: dead players can switch", "server.js",
   "if (p.alive === false) { send(p.ws, { type: 'weapon_rejected', reason: 'DEAD' }); return; }", ""),
  ("bounty: anti-farming (distinct victims) removed", "server.js",
   "if (!attacker.streakVictims || attacker.streakVictims.size < BOUNTY_CONFIG.minDistinctVictims) return;", ""),
  ("bounty: self-claim allowed", "server.js",
   "room.bounty.token !== victimToken || attackerToken === victimToken) return;", "room.bounty.token !== victimToken) return;"),
  ("bounty: not consumed on claim", "server.js", "room.bounty = null; // consumed exactly once, whatever happens next", ""),
  ("bounty: second active bounty allowed", "server.js", "  if (room.bounty) return;\n  if ((attacker.streak", "  if ((attacker.streak"),
  ("killcam: shown even when attacker is disconnected", "server.js", "if (!a.connected) return false; // attacker gone: caller falls back to plain spectator", ""),
  ("killcam: timer not cleared on respawn", "server.js", "    clearKillcam(p);\n    p.health = 100; p.alive = true;", "    p.health = 100; p.alive = true;"),

  ("match: shoot allowed during countdown", "server.js", "!room.started || !matchActive(room) || p.alive === false) return; // dead / lobby / countdown / ended: cannot fire", "!room.started || p.alive === false) return; // dead / lobby / countdown / ended: cannot fire"),
  ("match: countdown timer not cleared with match timers", "server.js", "  if (room.match.countdownTimer) { clearTimeout(room.match.countdownTimer); room.match.countdownTimer = null; }\n", ""),
  ("match: activation ignores state (can re-activate)", "server.js", "if (!m || m.state !== 'countdown' || !room.started) return;", "if (!m || !room.started) return;"),
  ("roomsettings: quick-play room without match settings", "server.js", "          roundTimeSec: MATCH_CONFIG.defaultRoundSec, scoreLimit: MATCH_CONFIG.defaultScore, match: null, mapSeed: newMapSeed(),\n          started: false, isPublic: true,", "          mapSeed: newMapSeed(),\n          started: false, isPublic: true,"),
  ("roomsettings: beginMatch NaN guard removed", "server.js", "  if (!Number.isFinite(room.roundTimeSec) || room.roundTimeSec <= 0) room.roundTimeSec = MATCH_CONFIG.defaultRoundSec;\n", ""),
  ("roomsettings: non-host may change settings", "server.js", "      if (!room || room.hostToken !== token || room.started) return; // host only, lobby only (never mid-match)", "      if (!room || room.started) return;"),
  ("roomsettings: settings changeable mid-match", "server.js", "      if (!room || room.hostToken !== token || room.started) return; // host only, lobby only (never mid-match)", "      if (!room || room.hostToken !== token) return;"),
  ("roomsettings: chaosEnabled ignored", "server.js", "  if (room.chaosEnabled === false) return; // host turned Chaos off for this room\n", ""),
  ("roomsettings: friendlyFire always allowed", "server.js", "target.team === attacker.team && !room.friendlyFire) return;", "target.team === attacker.team && false) return;"),
  ("roomsettings: spectatorEnabled ignored", "server.js", "{ if (room.spectatorEnabled !== false) handleSpectateRequest(room, token, msg); }", "{ handleSpectateRequest(room, token, msg); }"),
  ("roomsettings: truthy strings accepted as booleans", "server.js", "if (src && typeof src[k] === 'boolean') room[k] = src[k];", "if (src && src[k] !== undefined) room[k] = !!src[k];"),
  ("roomsettings: maxPlayers may drop below current players", "server.js", "Math.max(Math.max(2, connectedCount(room)), Math.min(12,", "Math.max(Math.max(2, 0), Math.min(12,"),
  ("banana: slipped player may still move", "server.js", "  if (isSlipped(p)) return; // BANANA_SLIPPED: server ignores movement until recovery (no strike)\n", ""),
  ("banana: slipped player may still shoot", "server.js", "  if (isSlipped(p)) return; // BANANA_SLIPPED: cannot shoot\n", ""),
  ("banana: slipped player may dash", "server.js", "  if (isSlipped(p)) { send(ws, { type: 'dash_rejected', reason: 'SLIPPED' }); return; }\n", ""),
  ("banana: holder may hitscan-damage", "server.js", "  if (attacker.bananaActive || isSlipped(attacker)) return; // 🍌 banana holders deal no hitscan damage; slipped players cannot fire\n", ""),
  ("banana: repeated slip allowed", "server.js", "  if (isSlipped(p) || now < (p.bananaImmuneUntil || 0)) return false; // no repeated / chained slip\n", ""),
  ("banana: owner can be slipped by own flying banana", "server.js", "if (!p || t === b.ownerPlayerId || p.alive === false || !p.connected) continue;\n        const dxz", "if (!p || p.alive === false || !p.connected) continue;\n        const dxz"),
  ("banana: no fire-rate limit", "server.js", "  if (p.lastBananaAt && now - p.lastBananaAt < C.fireCooldownMs) return false;\n", ""),
  ("banana: no per-owner cap", "server.js", " || room.bananas.filter((b) => b.ownerPlayerId === token).length >= C.maxPerOwner", ""),
  ("banana: no gravity", "server.js", "      b.velocity[1] -= C.gravity * dt;\n", ""),
  ("banana: peel never expires", "server.js", "    if (now >= b.expiresAt) { removeBanana(room, b, 'EXPIRED'); continue; }\n", ""),
  ("banana: slip never recovers", "server.js", "  p.slipTimer = setTimeout(() => recoverFromSlip(room, token), BANANA_CONFIG.slipMs);\n", "  p.slipTimer = null;\n"),
  ("banana: end() does not restore weapon", "server.js", "if (p) { p.bananaActive = false; if (p.bananaSavedWeaponId) p.weaponId = p.bananaSavedWeaponId; p.bananaSavedWeaponId = null; }\n      broadcastRoom(room, { type: 'chaos_event_end', id: this.id, scope: 'single', targetId: t });", "if (p) { p.bananaActive = false; p.bananaSavedWeaponId = null; }\n      broadcastRoom(room, { type: 'chaos_event_end', id: this.id, scope: 'single', targetId: t });"),
  ("banana: matchEnd leaves bananas", "server.js", "  clearBananas(room);\n  room.match.result", "  room.match.result"),
  ("banana: room deletion leaves bananas", "server.js", "    clearMatchTimers(room);\n    clearBananas(room);\n    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);\n    for (const t in room.players) { if (room.players[t].emoteTimer)", "    clearMatchTimers(room);\n    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);\n    for (const t in room.players) { if (room.players[t].emoteTimer)"),
  ("banana: holder can switch weapon", "server.js", "  if (p.bananaActive || isSlipped(p)) { send(p.ws, { type: 'weapon_rejected', reason: p.bananaActive ? 'BANANA_LOCK' : 'SLIPPED' }); return; }\n", ""),
  ("banana: reconnect state omits bananas", "server.js", "    bananas: publicBananas(room),\n", ""),
  ("mjolnir: registry points at the OLD model", "server.js", "model: 'models/thor/mjolnir.obj' /* the ONE", "model: 'models/thor/thor.obj' /* the ONE"),
  ("mjolnir: client loads the OLD model", "public/index.html", "const MJOLNIR_MODEL = { path: 'models/thor/mjolnir.obj',", "const MJOLNIR_MODEL = { path: 'models/thor/thor.obj',"),
  ("mjolnir: wrong scale (huge)", "public/index.html", "scale: 0.75, rotZ:", "scale: 7.5, rotZ:"),
  ("mjolnir: orientation lost", "public/index.html", "rotZ: -Math.PI / 2, material", "rotZ: 0, material"),
  ("mjolnir: Thor achievement no longer grants the hammer", "server.js", "grants: ['thunderHammer', 'accessoryHalo', 'badgeSurvivor'] }", "grants: ['accessoryHalo', 'badgeSurvivor'] }"),
  ("mjolnir: duplicate Mjolnir cosmetic added", "server.js", "  accessoryHalo:  { id: 'accessoryHalo',", "  mjolnirNew:{ id: 'mjolnirNew', type: 'deathEffect', name: 'Mjolnir', description: 'x', unlockRequirement: 'x', rarity: 'rare', enabled: true },\n  accessoryHalo:  { id: 'accessoryHalo',"),
  ("mjolnir: pivot not centred", "public/index.html", "    obj.position.sub(new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3())); // centred pivot\n", ""),
  ("omnitrix: registry points at a missing model", "server.js", "model: 'models/accessories/omnitrix/omnitrix.obj', scale: 0.0125", "model: 'models/accessories/omnitrix/omnitrixx.obj', scale: 0.0125"),
  ("omnitrix: palette default removed", "server.js", "palette: { green: '#39ff14', default: '#8a8f9a' } } },", "palette: { green: '#39ff14' } } },"),
  ("omnitrix: worn size wrong (x100)", "server.js", "scale: 0.0125, x: 0.46", "scale: 1.25, x: 0.46"),
  ("omnitrix: accessory registered as the wrong slot type", "server.js", "accessoryOmnitrix: { id: 'accessoryOmnitrix', type: 'accessory',", "accessoryOmnitrix: { id: 'accessoryOmnitrix', type: 'badge',"),
  ("omnitrix: client late-load dispose guard removed", "public/index.html", "      if (root !== scene) { disposeObject3D(m); return; } // the player/cosmetic was removed before the model arrived\n", ""),
  ("omnitrix: client ignores palette by material name", "public/index.html", "const hex = pal[ch.material && ch.material.name] || pal.default || v.color || '#ffffff';", "const hex = pal.default || v.color || '#ffffff';"),
  ("omnitrix: client builds a second loader", "public/index.html", "objLoader.load(v.model, (m) => {", "new THREE.OBJLoader().load(v.model, (m) => {"),
  ("staging: knife becomes equippable", "server.js", "model: 'models/weapons/melee/knife/knife.obj', equippable: false,", "model: 'models/weapons/melee/knife/knife.obj', equippable: true,"),
  ("staging: staging map not frozen", "server.js", "const WEAPON_ASSET_STAGING = Object.freeze({", "const WEAPON_ASSET_STAGING = ({"),
  ("rartool: CRC mismatch ignored", "tools/rar_extract.py", "status = 'OK' if (c == expect[key][1] and n == expect[key][0]) else 'CRC-MISMATCH(%08x!=%08x)' % (c, expect[key][1])", "status = 'OK'"),
  ("rartool: short read accepted", "tools/rar_extract.py", "        if err or n != size: status = 'SHORT(%d/%d)' % (n, size)\n", "        if False: status = 'SHORT(%d/%d)' % (n, size)\n"),
  ("rartool: unsafe path not skipped", "tools/rar_extract.py", "if '..' in rel.split('/'): res.append((name, 'SKIPPED-UNSAFE-PATH', 0)); continue\n", ""),
  ("rar3ppm: escape-4 distance off by one", "tools/rar3ppm.c", "dist = d + 2; len = 32;", "dist = d + 1; len = 32;"),
  ("rar3ppm: 7z-style range for the binary context bit", "tools/rar3ppm.c", "else { sym = 1; r->Low += R * size0; r->Range = R * (total - size0); }", "else { sym = 1; r->Low += R * size0; r->Range -= R * size0; }"),
  ("rar3ppm: DELTA filter sign flipped", "tools/rar3ppm.c", "prev = (Byte)(prev - src[sp++]); dst[d] = prev;", "prev = (Byte)(prev + src[sp++]); dst[d] = prev;"),
  ("rar3ppm: LZ long-distance length bonus removed", "tools/rar3ppm.c", "if (dist >= 0x2000) { len++; if (dist >= 0x40000) len++; }", "if (0) { len++; }"),
  ("rar3ppm: PPM initial binary escape table corrupted", "tools/rar3ppm.c", "0x3CDD, 0x1F3F, 0x59BF", "0x3CDD, 0x1F3F, 0x59BE"),
  ("rar3ppm: LZ table 'keep old tables' ignored", "tools/rar3ppm.c", "if (!keep) memset(z->old, 0, sizeof(z->old));", "memset(z->old, 0, sizeof(z->old));"),
  ("rar_extract_full: CRC mismatch accepted", "tools/rar_extract_full.py", "ok = (c == e['crc'] and len(data) == e['unp'])", "ok = True"),
  ("skins: registry points at the wrong file", "server.js", "model: 'models/skins/vader/vader.obj' } }", "model: 'models/skins/pilot/pilot.obj' } }"),
  ("skins: client shows body models in team mode too", "public/index.html", "p.mode !== 'team' && p.mode !== 'zombie');\n  r.mesh.material.visible = !use;", "true);\n  r.mesh.material.visible = !use;"),
  ("skins: client late-load guard removed", "public/index.html", "if (r.bodyModel !== holder) { disposeObject3D(m); return; } // skin changed", "if (false) { disposeObject3D(m); return; } // skin changed"),
  ("skins: client load-failure fallback removed", "public/index.html", "() => { if (r.bodyModel === holder) r.mesh.material.visible = true; }); // load failed", "() => {}); // load failed"),
  ("skins: cosmetic signature ignores mode", "public/index.html", "p.accessory, p.mode].join('|'); // mode", "p.accessory].join('|'); // mode"),
  ("skins: skeleton no longer declared flatColor", "server.js", "skeleton.obj', flatColor: true } },", "skeleton.obj' } },"),
  ("skins: skeleton skin removed from registry", "server.js", "  skinSkeleton:  { id: 'skinSkeleton',", "  skinSkeletonX:  { id: 'skinSkeletonX',"),
  ("mapdet: scatterPlan ignores the seed", "public/maplayouts.js", "const rng = makeRng(seed), out = [];", "const rng = makeRng(0), out = [];"),
  ("mapdet: PRNG constant corrupted", "public/maplayouts.js", "t ^= t + Math.imul(t ^ (t >>> 7), t | 61);", "t ^= t + Math.imul(t ^ (t >>> 7), t | 62);"),
  ("mapdet: PRNG falls back to Math.random for bad seeds", "public/maplayouts.js", "let a = (typeof seed === 'number' && isFinite(seed) ? Math.floor(seed) : 0) >>> 0;", "let a = (typeof seed === 'number' && isFinite(seed) ? Math.floor(seed) : Math.floor(Math.random() * 1e9)) >>> 0;"),
  ("mapdet: server omits the seed from game_started", "server.js", "map: room.map, mapSeed: room.mapSeed, mode: room.mode, pickups: publicPickups(room) });", "map: room.map, mode: room.mode, pickups: publicPickups(room) });"),
  ("mapdet: rejoin game_started loses the seed", "server.js", "send(ws, { type: 'game_started', map: room.map, mapSeed: room.mapSeed, mode: room.mode, rejoin: true,", "send(ws, { type: 'game_started', map: room.map, mode: room.mode, rejoin: true,"),
  ("mapdet: server seed is client-controlled", "server.js", "match: null, mapSeed: newMapSeed(),\n        started: false, isPublic: !!msg.isPublic,", "match: null, mapSeed: (typeof msg.mapSeed === 'number' ? msg.mapSeed : newMapSeed()),\n        started: false, isPublic: !!msg.isPublic,"),
  ("mapdet: client collision removed", "public/index.html", "camera.position.x = r[0]; camera.position.z = r[1]; }", "}"),
  ("mapdet: client collides with the lax server radius", "public/index.html", "BBMaps.resolveCircle(camera.position.x, camera.position.z, BBMaps.PLAYER_R, currentLayout)", "BBMaps.resolveCircle(camera.position.x, camera.position.z, BBMaps.SERVER_R, currentLayout)"),
  ("mapdet: client no longer loads the shared module", "public/index.html", "<script src=\"maplayouts.js\"></script>", ""),
  ("mapdet: purple built from random boxes again", "public/index.html", "for (const o of L.obstacles) {\n    const box", "for (const o of L.obstacles.map((q) => ({ ...q, x: (Math.random() - 0.5) * 40 }))) {\n    const box"),
  ("mapdet: client drops the server seed", "public/index.html", "startGame(msg.map, msg.mapSeed);", "startGame(msg.map);"),
  ("mapdet: client invariant broken (client radius below server radius)", "public/maplayouts.js", "const PLAYER_R = 0.4;", "const PLAYER_R = 0.1;"),
  ("weaponvis: path mapping off by one", "public/index.html", "String(n >= 1 && n <= VIEW_WEAPON_COUNT ? n : 1).padStart(3, '0')", "String(n >= 1 && n <= VIEW_WEAPON_COUNT ? n + 1 : 1).padStart(3, '0')"),
  ("weaponvis: only 12 weapons selectable", "public/index.html", "const VIEW_WEAPON_COUNT = 13;", "const VIEW_WEAPON_COUNT = 12;"),
  ("weaponvis: stale-load guard removed", "public/index.html", "if (viewWeaponId !== want) { disposeObject3D(obj); return; } // a newer", "if (false) { disposeObject3D(obj); return; } // a newer"),
  ("weaponvis: own weaponId from the state tick ignored", "public/index.html", "if (mine && typeof mine.weaponId === 'string') loadRealWeapon(mine.weaponId); if (mine && typeof mine.slot", "if (mine && typeof mine.slot"),
  ("weaponvis: client again hard-codes a weapon", "public/index.html", "const want = weaponId || 'w001';", "const want = 'w005';"),
  ("weaponvis: registry binds weapon 13 to the wrong file", "server.js", "model: 'models/weapons/split/weapon_' + String(i).padStart(3, '0') + '.obj',", "model: 'models/weapons/split/weapon_' + String(i === 13 ? 12 : i).padStart(3, '0') + '.obj',"),
  ("slotmut: knife uses the gun damage", "server.js", "const dealt = slot === 'knife' ? KNIFE_CONFIG.damage : Math.round(", "const dealt = Math.round("),
  ("slotmut: knife range check dropped", "server.js", "const maxRange = slot === 'knife' ? KNIFE_CONFIG.range + KNIFE_CONFIG.serverSlack : HIT_CONFIG.maxRange;", "const maxRange = HIT_CONFIG.maxRange;"),
  ("slotmut: knife cooldown dropped", "server.js", "  if (slot === 'knife' && attacker.lastKnifeAt && now - attacker.lastKnifeAt < KNIFE_CONFIG.cooldownMs) return; // knife cooldown is server-side", "  // (mutant) knife cooldown dropped"),
  ("slotmut: bomb slot may hitscan", "server.js", "  if (slot === 'bomb') return; // the bomb slot has no hitscan", "  // (mutant) bomb slot hitscan allowed"),
  ("slotmut: knife can crit", "server.js", "(slot === 'gun' && HIT_CONFIG.rng() < HIT_CONFIG.critChance)", "(HIT_CONFIG.rng() < HIT_CONFIG.critChance)"),
  ("slotmut: bomb damage has no falloff", "server.js", "let dmg = Math.max(C.minDamage, Math.round(C.maxDamage * (1 - dist / C.radius)));", "let dmg = C.maxDamage;"),
  ("slotmut: bomb ignores walls", "server.js", "    if (BBMaps.segmentBlocked(b.position[0], b.position[2], tp.x, tp.z, layout)) continue; // walls stop the blast\n", "\n"),
  ("slotmut: bomb self damage not reduced", "server.js", "    if (t === b.ownerPlayerId) dmg = Math.round(dmg * C.selfDamageFactor);\n", "\n"),
  ("slotmut: bomb ignores team protection", "server.js", "if (t !== b.ownerPlayerId && room.mode === 'team' && tp.team === owner.team && !room.friendlyFire) continue;", "if (false) continue;"),
  ("slotmut: bomb cooldown dropped", "server.js", "  if (p.lastBombAt && wait > 0) { send(p.ws, { type: 'bomb_rejected', reason: 'COOLDOWN', remainingMs: wait }); return false; }\n", "\n"),
  ("slotmut: several live bombs per player", "server.js", "  if (room.bananas.some((b) => b.kind === 'bomb' && b.ownerPlayerId === token)) { send(p.ws, { type: 'bomb_rejected', reason: 'ALREADY_ACTIVE' }); return false; }\n", "\n"),
  ("slotmut: leaving owner keeps the bomb", "server.js", "removeBanana(room, bb, 'OWNER_LEFT'); // a leaving owner's bombs never explode (no credit target)", "void 0;"),
  ("slotmut: unknown slot accepted", "server.js", "if (typeof slot !== 'string' || !SLOTS.includes(slot)) {", "if (typeof slot !== 'string') {"),
  ("slotmut: suicide counts as a kill", "server.js", "    if (!self) {\n      attacker.kills++;", "    if (true) {\n      attacker.kills++;"),
  ("slotmut: slot not reset on respawn", "server.js", "p.health = 100; p.alive = true; p.spectating = null; p.slot = 'gun';", "p.health = 100; p.alive = true; p.spectating = null;"),
  ("slotmut: switch cooldown dropped", "server.js", "  if (p.lastWeaponSwitchAt && now - p.lastWeaponSwitchAt < WEAPON_SWITCH_COOLDOWN_MS) { send(p.ws, { type: 'slot_rejected', reason: 'COOLDOWN' }); return; }\n", "\n"),
  ("slotmut: client knife reach changed", "public/index.html", "const KNIFE_RANGE = 2.8,", "const KNIFE_RANGE = 9.8,"),
  ("slotmut: client bomb sends a hit", "public/index.html", "  ws.send(JSON.stringify({ type: 'shoot', origin: aimOrigin, dir: aimDir })); // the server turns a shoot in the bomb slot into a thrown bomb", "  ws.send(JSON.stringify({ type: 'shoot', origin: aimOrigin, dir: aimDir })); ws.send(JSON.stringify({ type: 'hit', targetId: 'x' }));"),
  ("slotmut: client changes the slot optimistically", "public/index.html", "  ws.send(JSON.stringify({ type: 'select_slot', slot }));\n}", "  ws.send(JSON.stringify({ type: 'select_slot', slot })); applySlot(slot);\n}"),
  ("slotmut: explosion ignores the particle budget", "public/index.html", "const budget = window.BBFeedback.ashesBudget(settings.particleQuality, IS_TOUCH_DEVICE); // same quality/mobile tiers as the other particle effects", "const budget = { flames: 40, embers: 60, maxConcurrent: 99 };"),
  ("slotmut: client fires the gun sound/path in every slot", "public/index.html", "  if (mySlot === 'knife') { fireKnife(); return; }\n  if (mySlot === 'bomb') { fireBomb(); return; }\n", ""),
  ("helmetmut: texture applied to meshes without UVs", "public/index.html", "map: tex && hasUV ? tex : null", "map: tex ? tex : null"),
  ("helmetmut: rotX applied after centring", "public/index.html", "      if (v.rotX) m.rotation.x = v.rotX; // source-axis correction (e.g. Blender Z-up -> Y-up), applied BEFORE centring the pivot\n      m.updateMatrixWorld(true);", "      m.updateMatrixWorld(true);"),
  ("helmetmut: helmet rotY forgotten", "public/index.html", "holder.rotation.y = v.rotY || 0;", "holder.rotation.y = 0;"),
  ("helmetmut: helmet registry points at the Omnitrix file", "server.js", "model: 'models/accessories/helmet/helmet.obj', texture:", "model: 'models/accessories/omnitrix/omnitrix.obj', texture:"),
  # (name, file, old, new)
  ("hit: malformed targetId guard removed", "server.js",
   "  if (!msg || typeof msg.targetId !== 'string' || !isValidToken(msg.targetId)) return; // malformed / non-string ids\n",
   "  if (!msg) return;\n"),
  ("hit: cross-room target lookup (global instead of per-room)", "server.js",
   "const target = room.players[msg.targetId]; // room.players",
   "const target = room.players[msg.targetId] || (Object.values(rooms).map((r) => r.players[msg.targetId]).find(Boolean)); // room.players"),
  ("hit: dead-target check removed", "server.js",
   "if (attacker.alive === false || target.alive === false) return;", "if (attacker.alive === false) return;"),
  ("hit: dead-attacker check removed", "server.js",
   "if (attacker.alive === false || target.alive === false) return;", "if (target.alive === false) return;"),
  ("hit: self-hit allowed", "server.js",
   "if (!attacker || !target || target === attacker) return;", "if (!attacker || !target) return;"),
  ("hit: range check removed", "server.js",
   "  if (Math.sqrt(dx * dx + dy * dy + dz * dz) > maxRange) return; // impossible range\n", ""),
  ("hit: fire-rate cap removed", "server.js",
   "  if (attacker.lastHitAt && now - attacker.lastHitAt < HIT_CONFIG.minIntervalMs) return; // fire-rate cap\n", ""),
  ("hit: aim-ray plausibility removed", "server.js",
   "    if (Math.sqrt(px * px + py * py + pz * pz) > HIT_CONFIG.aimRadius + HIT_CONFIG.aimLagSlack) return; // not where the shooter was aiming\n", ""),
  ("hit: target-behind-shooter check removed", "server.js",
   "if (along <= 0 || along > HIT_CONFIG.maxRange + SHOOT_CONFIG.originTolerance) return;", "if (along > HIT_CONFIG.maxRange + SHOOT_CONFIG.originTolerance) return;"),
  ("hit: aim origin-vs-server-position check removed", "server.js",
   "    if (!aim || !aimOriginNearPlayer(aim, attacker)) return;\n    const dOrg", "    if (!aim) return;\n    const dOrg"),
  ("hit: shot credit NOT consumed (duplicate/replay protection off)", "server.js",
   "const shot = attacker.pendingShot; attacker.pendingShot = null;", "const shot = attacker.pendingShot;"),
  ("hit: shot credit never expires", "server.js",
   " || now - shot.at > HIT_CONFIG.shotWindowMs || now < shot.at) return;", ") return;"),
  ("hit: hit-aim vs shoot-aim pairing removed", "server.js",
   "    if (dOrg > HIT_CONFIG.pairOriginTol || dDot < HIT_CONFIG.pairDirDot) return;", "    // pairing removed"),
  ("hit: no shoot required at all (credit check removed)", "server.js",
   "    if (!shot || now - shot.at > HIT_CONFIG.shotWindowMs || now < shot.at) return;\n", "    if (!shot) { /* no credit needed */ } else if (false) return;\n    const shot0 = shot || { aim: parseAim(msg) }; if (!shot) { Object.assign(shot0, { at: now }); }\n"),
  ("hit: client damage accepted", "server.js",
   "  const dealt = slot === 'knife' ? KNIFE_CONFIG.damage : Math.round(wpn.damage * zoneMult * (!headshot && crit ? HIT_CONFIG.critMultiplier : 1));",
   "  const dealt = typeof msg.damage === 'number' ? msg.damage : slot === 'knife' ? KNIFE_CONFIG.damage : Math.round(wpn.damage * zoneMult * (!headshot && crit ? HIT_CONFIG.critMultiplier : 1));"),
  ("production default requireAim=false", "server.js", "  requireAim: true,         // PRODUCTION DEFAULT", "  requireAim: false,        // PRODUCTION DEFAULT"),
  ("shoot: rate limit removed", "server.js",
   "  if (p.lastShootAt && now - p.lastShootAt < SHOOT_CONFIG.minIntervalMs) return; // shoot-spam floor\n", ""),
  ("shoot: origin-near-player check removed", "server.js",
   "  if (!aimOriginNearPlayer(aim, p)) return; // claimed muzzle is nowhere near the server-known position\n", ""),
  ("shoot: dead players may shoot", "server.js",
   "|| !matchActive(room) || p.alive === false) return; // dead / lobby / countdown / ended: cannot fire", "|| !matchActive(room)) return; // dead / lobby / countdown / ended: cannot fire"),
  ("shoot: raw client payload rebroadcast", "server.js",
   "broadcastRoom(room, { type: 'shoot', token, origin: [aim.ox, aim.oy, aim.oz], dir: [aim.dx, aim.dy, aim.dz] }, token);",
   "broadcastRoom(room, { type: 'shoot', token, ...msg }, token);"),
  ("pickup: distance validation removed", "server.js",
   "  if (Math.hypot(p.x - pk.x, p.z - pk.z) > PICKUP_CONFIG.radius + PICKUP_CONFIG.slack) return; // server-known position too far\n", ""),
  ("pickup: can be taken twice (active flag ignored)", "server.js",
   "  if (!pk || !pk.active) return; // unknown", "  if (!pk) return; // unknown"),
  ("pickup: curses client-supplied targetId instead of sender", "server.js",
   "broadcastRoom(room, { type: 'troll', text, targetId: token });", "broadcastRoom(room, { type: 'troll', text, targetId: msg.targetId || token });"),
  ("pickup: attempt cooldown removed", "server.js",
   "  if (p.lastPickupAttemptAt && now - p.lastPickupAttemptAt < PICKUP_CONFIG.attemptCooldownMs) return; // spam floor\n", ""),
  ("pickup: dead players may pick up", "server.js",
   "if (!p || !room.started || p.alive === false || !room.pickups) return;", "if (!p || !room.started || !room.pickups) return;"),
  ("pickup: rooms share ONE pickup map (isolation broken)", "server.js",
   "  clearPickupTimers(room);\n  room.pickups = Object.create(null);", "  clearPickupTimers(room);\n  room.pickups = initPickups.shared || (initPickups.shared = Object.create(null));"),
  ("pickup: respawn timer not cleared on room deletion", "server.js",
   "    clearPickupTimers(room);\n    clearMatchTimers(room);\n    clearBananas(room);\n    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);\n    for (const t in room.players) { if (room.players[t].emoteTimer)",
   "    clearMatchTimers(room);\n    clearBananas(room);\n    if (room.respawnTimers) for (const t in room.respawnTimers) clearTimeout(room.respawnTimers[t]);\n    for (const t in room.players) { if (room.players[t].emoteTimer)"),
  ("pickup: respawn timer callback ignores room deletion", "server.js",
   "    if (rooms[room.code] !== room || !room.pickups || room.pickups[pk.id] !== pk) return; // room gone / restarted\n", ""),
  ("room isolation: broadcastRoom leaks to every room", "server.js",
   "  for (const token in room.players) {\n    if (token === exceptToken) continue;\n    const p = room.players[token];\n    if (p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);\n  }",
   "  for (const rc in rooms) for (const token in rooms[rc].players) {\n    if (token === exceptToken) continue;\n    const p = rooms[rc].players[token];\n    if (p.connected && p.ws && p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);\n  }"),
  ("cosmetics: unlock check removed from equip_cosmetic", "server.js",
   "  if (cosmetic.unlockRequirement && !u[cosmeticId]) { send(ws, { type: 'equip_rejected', cosmeticId, reason: 'LOCKED' }); return; }\n", ""),
  ("cosmetics: unlock check removed from join/create resolution", "server.js",
   "    if (cos.unlockRequirement && !u[id]) return fallback;\n", ""),
  ("cosmetics: slot-type check removed (title accepted as badge)", "server.js",
   "if (!cos || cos.type !== type || !cos.enabled) return fallback;", "if (!cos || !cos.enabled) return fallback;"),
  ("reconnect: stale socket close marks live player disconnected", "server.js",
   "    if (p.ws && p.ws !== ws) return;\n", ""),
  ("containment: oversized message guard removed", "server.js",
   "    if (raw && typeof raw.length === 'number' && raw.length > MAX_MESSAGE_BYTES) return;\n", ""),
  ("containment: handler errors NOT caught", "server.js",
   "    try { handleWsMessage(raw); }\n    catch (err) { handlerErrorCount++; console.error('[ws] handler error, message dropped:', err && err.message); }",
   "    handleWsMessage(raw);"),
  ("containment: ws 'error' listener removed (one bad frame would crash the process)", "server.js",
   "  ws.on('error', (err) => { console.error('[ws] socket error (client dropped):', err && err.code || err && err.message); });\n", ""),
  ("client: hit sent BEFORE shoot", "public/index.html",
   "  ws.send(JSON.stringify({ type: 'shoot', origin: aimOrigin, dir: aimDir }));\n  const raycaster", "  const raycaster"),
  ("client: rejoin rebuilds the scene (double animate loop)", "public/index.html",
   "    if (gameStarted) {\n      // In-page reconnect", "    if (false) {\n      // In-page reconnect"),
  ("client: nameplate drops the badge glyph", "public/index.html",
   "const tex = new THREE.CanvasTexture(nameplateCanvas(name, title, badgeIcon || null, false));", "const tex = new THREE.CanvasTexture(nameplateCanvas(name, title, null, false));"),
]

def run_suite(d):
    try:
        r = subprocess.run(["node", "tests/run.js"], cwd=d, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return [], "TIMEOUT", -9  # reported as its own status (not killed, not survived, not a crash) - see one_mutant
    out = r.stdout + r.stderr
    failed = re.findall(r"^  FAIL  (.+)$", out, re.M)
    m = re.search(r"(\d+)/(\d+) PASS", out)
    return failed, (m.group(0) if m else "NO RESULT (crash?)"), r.returncode

def one_mutant(base_dir, tmp, idx, m):
    name, f, old, new = m
    d = os.path.join(tmp, f"m{idx}")
    shutil.copytree(base_dir, d)
    path = os.path.join(d, f)
    orig = open(path, encoding="utf-8").read()
    if orig.count(old) != 1:
        shutil.rmtree(d, ignore_errors=True); return (name, "ERROR", f"pattern matched {orig.count(old)}x (the mutant itself is stale)", None)
    open(path, "w", encoding="utf-8").write(orig.replace(old, new, 1))
    failed, res, rc = run_suite(d)
    shutil.rmtree(d, ignore_errors=True)
    if res == "TIMEOUT": return (name, "TIMEOUT", "the test suite exceeded 300 s with this mutant applied (not counted as killed or survived)", None)
    if "NO RESULT" in res: return (name, "ERROR", "runner produced no result (mutant crashed the suite; cannot attribute to a test)", None)
    if failed: return (name, "KILLED", f"{len(failed)} failing ({res}); e.g. {failed[0][:90]}", failed)
    if rc != 0: return (name, "ERROR", "non-zero exit without a FAIL line", None)
    return (name, "SURVIVED", res, None)

def main():
    import concurrent.futures as cf
    args = [a for a in sys.argv[1:] if not a.startswith("--jobs=") and not a.startswith("--range=")]
    jobs = next((int(a.split("=")[1]) for a in sys.argv[1:] if a.startswith("--jobs=")), min(4, os.cpu_count() or 1))
    only = args[0] if args else None
    tmp = tempfile.mkdtemp(prefix="bb-mut-")
    work = os.path.join(tmp, "base")
    # Skip only the TOP-LEVEL node_modules / .git; tests/stubs/node_modules (offline express/ws stubs) must be copied.
    def _ignore(d, names):
        return [n for n in names if n in ("node_modules", ".git") and os.path.abspath(d) == ROOT]
    shutil.copytree(ROOT, work, ignore=_ignore)
    base_failed, base_res, base_rc = run_suite(work)
    print(f"BASELINE (unmutated copy): {base_res}, failing={len(base_failed)}, exit={base_rc}", flush=True)
    if base_failed or base_rc != 0 or "NO RESULT" in base_res or base_res == "TIMEOUT": print("ABORT: baseline is not green - mutation results would be meaningless"); sys.exit(2)
    rng = next((a.split("=")[1] for a in sys.argv[1:] if a.startswith("--range=")), None)  # e.g. --range=0:10 (for time-limited shells)
    lo, hi = (int(x) for x in rng.split(":")) if rng else (0, len(MUTANTS))
    todo = [(i, m) for i, m in enumerate(MUTANTS) if lo <= i < hi and (not only or only in m[0])]
    survivors, invalid, timeouts = [], [], []
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futs = [ex.submit(one_mutant, work, tmp, i, m) for i, m in todo]
        for fu in futs:
            try:
                name, status, detail, _ = fu.result()
            except Exception as e:  # one broken mutant must not abort the whole suite
                name, status, detail = "(unknown mutant)", "ERROR", f"harness exception: {type(e).__name__}: {e}"
            print(f"  {status:<8} {name}  {detail}", flush=True)
            if status == "SURVIVED": survivors.append(name)
            if status == "ERROR": invalid.append(name)
            if status == "TIMEOUT": timeouts.append(name)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nmutants={len(todo)} survivors={len(survivors)} timeouts={len(timeouts)} errors={len(invalid)} jobs={jobs}")
    for s_ in survivors: print("  SURVIVOR:", s_)
    for s_ in timeouts: print("  TIMEOUT :", s_)
    for s_ in invalid: print("  ERROR   :", s_)
    sys.exit(1 if survivors or invalid or timeouts else 0)

main()
