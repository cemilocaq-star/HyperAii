// Phase 6 — Meme Emote System server tests.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const { rooms, EMOTE_CONFIG, COSMETICS } = require(path.join(__dirname, '..', 'server.js')).__test__;

function room3() {
  const a = connect('a'); const at = hello(a);
  a.emitMessage({ type: 'create_room', maxPlayers: 4 });
  const code = a.lastOfType('room_created').code;
  const b = connect('b'); const bt = hello(b);
  b.emitMessage({ type: 'join_room', roomCode: code }); b.emitMessage({ type: 'player_ready' });
  const c = connect('c'); const ct = hello(c);
  c.emitMessage({ type: 'join_room', roomCode: code }); c.emitMessage({ type: 'player_ready' });
  a.emitMessage({ type: 'start_game' });
  return { a, b, c, at, bt, ct, room: rooms[code], code };
}
function noCooldown(fn) { const s = EMOTE_CONFIG.cooldownMs; EMOTE_CONFIG.cooldownMs = 0; try { return fn(); } finally { EMOTE_CONFIG.cooldownMs = s; } }

test('emotes: registry has the 8 new meme emotes, original (no audio files), with duration', () => {
  const ids = ['emoteGoofyDance','emoteDramaticPoint','emoteFacepalm','emoteConfused','emoteLaugh','emoteVictory','emoteNpcWave','emoteAbsurdParty'];
  for (const id of ids) {
    const e = COSMETICS[id];
    assert(e && e.type === 'emote' && e.enabled, id + ' missing');
    assert(e.duration > 0 && e.duration <= 5000, id + ' bad duration');
    assert(!/\.(mp3|wav|ogg)$/i.test(e.sfx || ''), id + ' must not reference an audio file');
  }
  assert(COSMETICS.emoteWave && COSMETICS.emoteRoadRoller, 'existing emotes preserved');
});

test('emotes: wheel emote is broadcast to every player in the room', () => {
  const { a, b, c, at } = room3();
  a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteFacepalm' });
  for (const w of [a, b, c]) {
    const m = w.lastOfType('emote_used');
    assert(m, 'everyone should receive emote_used');
    assertEqual(m.token, at); assertEqual(m.emoteId, 'emoteFacepalm'); assertEqual(m.duration, 2000);
  }
});

test('emotes: legacy G (no emoteId) still plays the equipped emote', () => {
  const { a, b } = room3();
  a.emitMessage({ type: 'emote_trigger' });
  assertEqual(b.lastOfType('emote_used').emoteId, 'emoteWave');
});

test('emotes: cooldown blocks spam, then allows after it elapses', () => {
  const { a, room, at } = room3();
  a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteLaugh' });
  a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteLaugh' });
  assertEqual(a.allOfType('emote_used').length, 1);
  assertEqual(a.lastOfType('emote_rejected').reason, 'COOLDOWN');
  room.players[at].lastEmoteAt -= EMOTE_CONFIG.cooldownMs + 1; // time passes
  a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteLaugh' });
  assertEqual(a.allOfType('emote_used').length, 2);
});

test('emotes: unknown id, non-emote cosmetic, locked emote, malformed id are rejected', () => {
  noCooldown(() => {
    const { a } = room3();
    for (const [id, reason] of [['nope','UNKNOWN'],['colorGold','UNKNOWN'],['emoteRoadRoller','LOCKED'],[{x:1},'UNKNOWN'],[42,'UNKNOWN']]) {
      a.emitMessage({ type: 'emote_trigger', emoteId: id });
      assertEqual(a.lastOfType('emote_rejected').reason, reason, JSON.stringify(id));
    }
    assert(!a.lastOfType('emote_used'), 'nothing should have broadcast');
  });
});

test('emotes: dead players cannot emote; dying cancels an active emote (emote_end)', () => {
  noCooldown(() => {
    const { a, b, bt, room } = room3();
    b.emitMessage({ type: 'emote_trigger', emoteId: 'emoteLaugh' });
    assert(room.players[bt].activeEmote, 'emote active');
    for (let i = 0; i < 4; i++) a.emitMessage({ type: 'hit', targetId: bt });
    assertEqual(room.players[bt].activeEmote, null, 'cleared on death');
    assert(a.lastOfType('emote_end'), 'others told to stop the animation');
    b.emitMessage({ type: 'emote_trigger', emoteId: 'emoteLaugh' });
    assertEqual(b.lastOfType('emote_rejected').reason, 'DEAD');
  });
});

test('emotes: disconnect clears emote state and notifies the room', () => {
  const { a, b, bt, room } = room3();
  b.emitMessage({ type: 'emote_trigger', emoteId: 'emoteGoofyDance' });
  b.emitClose();
  assertEqual(room.players[bt].activeEmote, null);
  assert(a.lastOfType('emote_end'), 'room notified');
  assertEqual(room.players[bt].emoteTimer, null, 'timer cleared, nothing dangling');
});

test('emotes: emote state auto-clears after its duration (real timer)', async () => {
  const { a, room, at } = room3();
  a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteFacepalm' }); // 2000ms
  assert(room.players[at].activeEmote);
  await new Promise((r) => setTimeout(r, 2200));
  assertEqual(room.players[at].activeEmote, null);
  assert(a.lastOfType('emote_end'));
});

test('emotes: room isolation — other rooms never receive the emote', () => {
  const r1 = room3(); const r2 = room3();
  r1.a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteVictory' });
  assert(!r2.a.lastOfType('emote_used') && !r2.b.lastOfType('emote_used'), 'leaked to another room');
});

test('emotes: no gameplay advantage — emoting does not change health/position/kills', () => {
  const { a, at, room } = room3();
  const before = JSON.stringify([room.players[at].health, room.players[at].x, room.players[at].z, room.players[at].kills]);
  a.emitMessage({ type: 'emote_trigger', emoteId: 'emoteAbsurdParty' });
  assertEqual(JSON.stringify([room.players[at].health, room.players[at].x, room.players[at].z, room.players[at].kills]), before);
});
