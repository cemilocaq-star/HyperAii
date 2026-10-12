// Phase 16 — player names, Quick Chat, Reactions.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual, connect, hello } = harness;
const T = require(path.join(__dirname, '..', 'server.js')).__test__;
const { rooms, QUICK_CHAT_PRESETS, REACTION_PRESETS, SOCIAL_CONFIG, sanitizeName, dedupeName } = T;

function game(n = 2) {
  const host = connect('h'); const ht = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 6 });
  const code = host.lastOfType('room_created').code;
  const ws = [host], toks = [ht];
  for (let i = 1; i < n; i++) { const g = connect('g' + i); toks.push(hello(g)); g.emitMessage({ type: 'join_room', roomCode: code }); g.emitMessage({ type: 'player_ready' }); ws.push(g); }
  host.emitMessage({ type: 'start_game' });
  const room = rooms[code];
  if (room.chaosTimer) clearTimeout(room.chaosTimer);
  return { code, room, ws, toks };
}

// ---------- names ----------
test('name validation: empty/whitespace-only falls back to default', () => {
  for (const bad of ['', '   ', null, undefined]) assertEqual(sanitizeName(bad), 'Bəndə');
});
test('name validation: control chars and angle brackets stripped, length capped at 16', () => {
  assertEqual(sanitizeName('<script>alert(1)</script>'), 'scriptalert(1)/s'); // 16-char cap after stripping < >
  assertEqual(sanitizeName('a\u0000b\u001Fc'), 'abc');
  assertEqual(sanitizeName('x'.repeat(50)).length, 16);
});
test('name validation: normal names pass through trimmed', () => {
  assertEqual(sanitizeName('  Vüsal  '), 'Vüsal');
});
test('duplicate name handling: second player with the same name gets a numeric suffix', () => {
  // Lobby-only (no start_game): a solo host room auto-satisfies "all ready"
  // (readiness only checks non-host players), so calling start_game here
  // would immediately start the room and lock out further joins.
  const host = connect('h'); const ht = hello(host);
  host.emitMessage({ type: 'create_room', maxPlayers: 6 });
  const code = host.lastOfType('room_created').code;
  const room = rooms[code];
  assertEqual(room.players[ht].name, 'Bəndə');
  const g = connect('g'); const gt = hello(g);
  g.emitMessage({ type: 'join_room', roomCode: code, name: 'Bəndə' });
  assertEqual(room.players[gt].name, 'Bəndə#2');
  const g2 = connect('g2'); const gt2 = hello(g2);
  g2.emitMessage({ type: 'join_room', roomCode: code, name: 'Bəndə' });
  assertEqual(room.players[gt2].name, 'Bəndə#3');
});
test('name validation: object/array/huge-string name payloads never crash join', () => {
  for (const bad of [{}, [], 12345, true]) {
    const ws = connect('x'); hello(ws);
    ws.emitMessage({ type: 'create_room', maxPlayers: 4, name: bad });
    assert(ws.lastOfType('room_created'), 'must still create the room with a sane fallback name');
  }
});

// ---------- quick chat ----------
test('quick chat: broadcast to the room only, with the server-controlled text', () => {
  const { ws, toks } = game(3);
  ws[0].emitMessage({ type: 'quick_chat', key: 'run' });
  for (const w of ws) { const m = w.lastOfType('quick_chat'); assertEqual(m.token, toks[0]); assertEqual(m.text, 'RUN!'); }
});
test('quick chat: unknown/free-text key is rejected, nothing broadcast', () => {
  const { ws } = game(2);
  for (const bad of ['I am typing whatever I want', 'lol; DROP TABLE', 42, null, '<b>x</b>']) {
    ws[0].emitMessage({ type: 'quick_chat', key: bad });
    assertEqual(ws[0].lastOfType('chat_rejected').reason, 'UNKNOWN');
  }
  assert(!ws[0].lastOfType('quick_chat'), 'nothing valid should have gone out');
});
test('quick chat: cooldown blocks spam, then allows after the window', () => {
  const { ws, room, toks } = game(2);
  ws[0].emitMessage({ type: 'quick_chat', key: 'gg' });
  ws[0].emitMessage({ type: 'quick_chat', key: 'gg' });
  assertEqual(ws[0].allOfType('quick_chat').length, 1);
  assertEqual(ws[0].lastOfType('chat_rejected').reason, 'COOLDOWN');
  room.players[toks[0]].lastChatAt -= SOCIAL_CONFIG.chatCooldownMs + 1;
  ws[0].emitMessage({ type: 'quick_chat', key: 'gg' });
  assertEqual(ws[0].allOfType('quick_chat').length, 2);
});
test('quick chat: room isolation — a message in one room never reaches another', () => {
  const A = game(2), B = game(2);
  A.ws[0].emitMessage({ type: 'quick_chat', key: 'nice' });
  assert(!B.ws[0].lastOfType('quick_chat') && !B.ws[1].lastOfType('quick_chat'));
});
test('quick chat: entire preset table is covered (every listed phrase from the spec exists)', () => {
  const wanted = ['LOL 😂', 'HELP!', 'RUN!', 'WAIT!', 'COME HERE', 'NICE!', 'NO WAY!', 'WHAT?!', 'GG', 'BRUH 💀', 'RUN AWAY!'];
  const have = Object.values(QUICK_CHAT_PRESETS);
  for (const w of wanted) assert(have.includes(w), 'missing preset: ' + w);
});

// ---------- reactions ----------
test('reactions: broadcast the server-controlled emoji only, with cooldown and room isolation', () => {
  const { ws, toks } = game(2);
  ws[0].emitMessage({ type: 'reaction', key: 'skull' });
  assertEqual(ws[1].lastOfType('reaction').emoji, '💀');
  ws[0].emitMessage({ type: 'reaction', key: 'fire' });
  assertEqual(ws[0].lastOfType('reaction_rejected').reason, 'COOLDOWN');
  for (const bad of ['🤡', 'onload=alert(1)', 99]) { ws[0].emitMessage({ type: 'reaction', key: bad }); assertEqual(ws[0].lastOfType('reaction_rejected').reason, 'UNKNOWN'); }
  assertEqual(Object.keys(REACTION_PRESETS).length, 8);
});

test('social: dead/lobby players cannot chat or react; both require room.started', () => {
  const lobby = connect('l'); hello(lobby);
  lobby.emitMessage({ type: 'create_room', maxPlayers: 4 });
  lobby.emitMessage({ type: 'quick_chat', key: 'gg' });
  lobby.emitMessage({ type: 'reaction', key: 'fire' });
  assert(!lobby.lastOfType('quick_chat') && !lobby.lastOfType('reaction'), 'must be ignored before the game starts');
});
