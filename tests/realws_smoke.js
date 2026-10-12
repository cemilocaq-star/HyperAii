// REAL-SOCKET smoke test (not part of `node tests/run.js`, which is offline/in-memory).
//
// What is REAL here: the `ws` library (server AND client), Node's http server, TCP over loopback,
// actual WebSocket frames, ws's own maxPayload enforcement. What is NOT real when express is not
// installed: express (a tiny stub is used; static file serving is therefore NOT exercised).
//
// Run:  node tests/realws_smoke.js
// - If the project has real deps installed (npm install), they are used automatically.
// - Otherwise it looks for any real `ws` on the machine; if none exists it prints
//   "SKIPPED — real ws unavailable" and exits 0 (it never pretends to have run).
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
process.env.BB_UNLOCKS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-real-')), 'unlocks.json');

function findRealWs() {
  const tries = [];
  try { tries.push(require.resolve('ws', { paths: [ROOT] })); } catch {}
  if (process.env.BB_REAL_WS_PATH) tries.push(process.env.BB_REAL_WS_PATH);
  try {
    const g = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    for (const rel of ['ws', '@mermaid-js/mermaid-cli/node_modules/ws']) tries.push(path.join(g, rel));
  } catch {}
  for (const t of tries) { try { return { path: require.resolve(t), mod: require(t) }; } catch {} }
  return null;
}
const realWs = findRealWs();
if (!realWs) { console.log('SKIPPED — real ws unavailable (run `npm install` first). Nothing was verified.'); process.exit(0); }

let realExpress = null; try { realExpress = require.resolve('express', { paths: [ROOT] }); } catch {}
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'ws') return realWs.mod;
  if (request === 'express' && !realExpress) return origLoad.call(this, path.join(__dirname, 'stubs', 'node_modules', 'express'), parent, isMain);
  return origLoad.apply(this, arguments);
};
const WebSocket = realWs.mod;
const startServer = require(path.join(ROOT, 'server.js'));
const S = startServer.__test__;

const results = []; const check = (name, ok, detail) => { results.push({ name, ok: !!ok }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`); const c = { ws, msgs: [], closed: null };
    ws.on('message', (d) => { try { c.msgs.push(JSON.parse(d.toString())); } catch {} });
    ws.on('close', (code) => { c.closed = code; });
    ws.on('error', () => {});
    c.send = (o) => ws.readyState === 1 && ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    c.last = (t) => [...c.msgs].reverse().find((m) => m.type === t);
    c.all = (t) => c.msgs.filter((m) => m.type === t);
    c.waitFor = async (t, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = c.last(t); if (m) return m; await sleep(15); } return null; };
    ws.on('open', () => resolve(c)); setTimeout(() => reject(new Error('connect timeout')), 3000);
  });
}

(async () => {
  console.log(`real ws ${require(path.join(path.dirname(realWs.path), 'package.json')).version} at ${path.dirname(realWs.path)}; express: ${realExpress ? 'REAL' : 'STUB'}`);
  const port = 39000 + Math.floor(Math.random() * 900);
  const server = startServer(port);
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  check('server listens on a real TCP port', server.listening, 'not listening');

  const a = await client(port), b = await client(port);
  a.send({ type: 'hello' }); b.send({ type: 'hello' });
  const ha = await a.waitFor('hello_ok'), hb = await b.waitFor('hello_ok');
  check('hello handshake over real sockets', ha && hb && ha.token && hb.token, 'no hello_ok');
  a.send({ type: 'create_room', maxPlayers: 4, name: 'Alice' });
  const rc = await a.waitFor('room_created'); check('create_room returns a SERVER-generated code', rc && /^[A-Z0-9]{4,8}$/.test(rc.code), JSON.stringify(rc));
  b.send({ type: 'join_room', roomCode: rc.code, name: 'Bob' }); await sleep(60); b.send({ type: 'player_ready' }); await sleep(60);
  a.send({ type: 'start_game' });
  const gsA = await a.waitFor('game_started'), gsB = await b.waitFor('game_started');
  check('game_started reaches both real clients with the server-owned pickup list', gsA && gsB && Array.isArray(gsA.pickups) && gsA.pickups.length === 4, JSON.stringify(gsA));

  const room = S.rooms[rc.code]; const pa = room.players[ha.token], pb = room.players[hb.token];
  // The production match has a REAL countdown (MATCH_CONFIG.countdownMs, not overridden here): combat is locked until it ends.
  for (let i = 0; i < 100 && !(room.match && room.match.state === 'active'); i++) await sleep(50);
  check('production countdown really ends and the match becomes active (real timer, not overridden)', !!(room.match && room.match.state === 'active'), 'state=' + (room.match && room.match.state));
  // Open-field positions: the default map has SERVER-known geometry (centre obstacle), so (0,0)->(0,-10) is a blocked line.
  pa.x = 0; pa.y = 1.6; pa.z = 20; pb.x = 0; pb.y = 1.6; pb.z = 10; pa.sync = null; pb.sync = null;
  const aim = { origin: [0, 1.6, 20], dir: [0, 0, -1] };
  a.send({ type: 'hit', targetId: hb.token, ...aim, damage: 9999 }); await sleep(250);
  check('production path: a bare hit (no shoot) over a real socket does no damage', pb.health === 100 && !a.last('hit_confirm'), 'health=' + pb.health);
  a.send({ type: 'shoot', ...aim }); a.send({ type: 'hit', targetId: hb.token, ...aim });
  const conf = await a.waitFor('hit_confirm');
  check('production path: shoot -> hit lands with SERVER damage (25 or crit 50)', conf && (conf.damage === 25 || conf.damage === 50) && (pb.health === 75 || pb.health === 50), JSON.stringify(conf));
  check('the victim receives the shoot broadcast (sanitized numbers only)', !!(await b.waitFor('shoot')) && !('damage' in b.last('shoot')), 'no shoot on B');

  check('production requireAim is true in this real-socket run', S.HIT_CONFIG.requireAim === true, 'requireAim=' + S.HIT_CONFIG.requireAim);

  // oversize frame: ws itself must close the connection (1009 Message Too Big) at maxPayload
  const before = b.msgs.length;
  b.send('{"type":"shoot","pad":"' + 'A'.repeat(200 * 1024) + '"}'); await sleep(300);
  check('a 200 KB frame is refused by ws maxPayload (close code 1009)', b.closed === 1009, 'closed=' + b.closed);

  // hostile-but-small frames on a live connection: server survives and keeps serving
  const c3 = await client(port); c3.send({ type: 'hello' }); await c3.waitFor('hello_ok');
  for (const raw of ['', 'null', '{', '[]', '{"type":null}', '{"type":"hit","targetId":["x"],"origin":"a"}', '{"__proto__":{"polluted":1},"type":"equip_cosmetic","cosmeticId":{"a":1}}']) c3.send(raw);
  c3.ws.send(Buffer.from([0xff, 0xfe, 0x00, 0x7b]), { binary: true });
  await sleep(200);
  c3.send({ type: 'ping', t: 42, seq: 1 });
  const pong = await c3.waitFor('pong');
  check('server survives hostile frames from a real client (the SAME connection still gets a real pong)', pong && pong.t === 42 && c3.ws.readyState === 1, 'no pong / closed=' + c3.closed);
  check('no prototype pollution after hostile frames', !({}).polluted, 'polluted');
  check('no contained handler errors were needed', S.getHandlerErrorCount() === 0, 'count=' + S.getHandlerErrorCount());

  // reconnect over a NEW real socket with the same token (B was just closed by 1009)
  const b2 = await client(port); b2.send({ type: 'hello', token: hb.token });
  const back = await b2.waitFor('game_started');
  check('reconnect with the same token gets game_started{rejoin} + current pickups', back && back.rejoin === true && Array.isArray(back.pickups) && back.pickups.length === 4, JSON.stringify(back && { rejoin: back.rejoin }));
  check('reconnect kept combat state (health) and did not duplicate the player', room.players[hb.token] && room.players[hb.token].health === pb.health && Object.keys(room.players).length === 2, 'players=' + Object.keys(room.players).length);

  for (const c of [a, b, b2, c3]) try { c.ws.terminate(); } catch {}
  S.shutdownAllRooms(); try { server.close(); } catch {}
  const ok = results.filter((r) => r.ok).length;
  console.log(`\nREAL-WS SMOKE: ${ok}/${results.length} PASS (real ws + real TCP; express ${realExpress ? 'real' : 'STUBBED'}; no browser, no real clients on other devices)`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => { console.log('SMOKE CRASHED:', e && e.stack || e); process.exit(2); });
