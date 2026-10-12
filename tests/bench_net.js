// Network baseline benchmark (server-side, offline, fake sockets).
// Measures messages/bytes per room and per player over a fixed wall-clock window.
// Run: node tests/bench_net.js [players=8] [seconds=4]
// It measures JSON payload size only (what ws.send receives) — no TCP/WS framing, no compression.
const path = require('path'), os = require('os'), fs = require('fs'), Module = require('module');
process.env.BB_UNLOCKS_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bench-')), 'unlocks.json');
const STUBS = path.join(__dirname, 'stubs', 'node_modules');
const orig = Module._load;
Module._load = function (r, p, m) { if (r === 'express' || r === 'ws') return orig.call(this, path.join(STUBS, r), p, m); return orig.apply(this, arguments); };
const startServer = require(path.join(__dirname, '..', 'server.js'));
const T = startServer.__test__;
T.MATCH_CONFIG.countdownMs = 0;

const N = parseInt(process.argv[2] || '8', 10), SECS = parseFloat(process.argv[3] || '4');
class MWs {
  constructor() { this.readyState = 1; this.h = {}; this.sent = []; this.bytes = 0; this.byType = {}; this.measuring = false; }
  on(e, cb) { this.h[e] = cb; return this; }
  send(d) {
    const m = JSON.parse(d); this.sent.push(m);
    if (this.measuring) { this.bytes += d.length; const b = this.byType[m.type] || (this.byType[m.type] = { n: 0, bytes: 0 }); b.n++; b.bytes += d.length; }
    if (this.sent.length > 50) this.sent.splice(0, this.sent.length - 5); // keep memory flat
  }
  emit(o) { this.h.message && this.h.message(JSON.stringify(o)); }
  last(t) { for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === t) return this.sent[i]; return null; }
}
function conn() { const w = new MWs(); T.wss.emit('connection', w); return w; }

(async () => {
  const ws = [];
  for (let i = 0; i < N; i++) { const w = conn(); w.emit({ type: 'hello' }); ws.push(w); }
  ws[0].emit({ type: 'create_room', name: 'P0', maxPlayers: Math.max(N, 2), mode: 'ffa' });
  const code = ws[0].last('room_created').code;
  for (let i = 1; i < N; i++) ws[i].emit({ type: 'join_room', roomCode: code, name: 'P' + i });
  for (let i = 1; i < N; i++) ws[i].emit({ type: 'player_ready' });
  ws[0].emit({ type: 'start_game' });
  const room = T.rooms[code];
  if (!room.started) { console.log('room did not start'); process.exit(2); }
  // spread players on a ring, radius 30, deterministic (no map geometry dependence for measurement)
  const toks = room.order.slice();
  toks.forEach((t, i) => { const a = i / N * Math.PI * 2; const p = room.players[t]; p.x = Math.cos(a) * 30; p.z = Math.sin(a) * 30; p.y = 1.6; });
  ws.forEach((w) => { w.sent.length = 0; w.measuring = true; });
  const cpu0 = process.cpuUsage(); const t0 = Date.now();
  // clients send `update` at ~60 Hz like animate() does
  const iv = setInterval(() => {
    toks.forEach((t, i) => { const p = room.players[t]; const a = i / N * Math.PI * 2 + (Date.now() - t0) / 20000; ws[i].emit({ type: 'update', x: Math.cos(a) * 30, y: 1.6, z: Math.sin(a) * 30, ry: a }); });
  }, 16);
  await new Promise((r) => setTimeout(r, SECS * 1000));
  clearInterval(iv); const el = (Date.now() - t0) / 1000; const cpu = process.cpuUsage(cpu0);
  const tot = { n: 0, bytes: 0 }, by = {};
  ws.forEach((w) => { tot.bytes += w.bytes; Object.entries(w.byType).forEach(([k, v]) => { const b = by[k] || (by[k] = { n: 0, bytes: 0 }); b.n += v.n; b.bytes += v.bytes; tot.n += v.n; }); });
  const out = { players: N, seconds: +el.toFixed(2), room_msgs_per_s: +(tot.n / el).toFixed(1), room_kB_per_s: +(tot.bytes / 1024 / el).toFixed(2),
    per_player_kB_per_s: +(tot.bytes / 1024 / el / N).toFixed(2), server_cpu_ms_per_s: +((cpu.user + cpu.system) / 1000 / el).toFixed(1),
    by_type: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, { msgs_per_s: +(v.n / el).toFixed(1), kB_per_s: +(v.bytes / 1024 / el).toFixed(2) }])) };
  console.log(JSON.stringify(out, null, 2));
  T.shutdownAllRooms(); process.exit(0);
})();
