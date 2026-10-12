// Generated box-projection UV for the UV-less helmet (Phase 7). Two variants were evaluated by numbers: A = palette colour only (no texture), B = generated UV + the shipped texture.
// Rule decided BEFORE measuring: B is used only if texel-density ratio <= sqrt(3)+0.01 (theoretical bound), seams <= 30% of shared edges and every UV lies in [0,1].
// How it LOOKS is NOT VERIFIED (no GPU here); these tests prove the mapping is bounded, deterministic and wired in correctly.
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const PUB = path.join(__dirname, '..', 'public');
const UV = require(path.join(PUB, 'uvgen.js'));
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
function parseObj(f) { const v = [], pos = []; for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (l.startsWith('v ')) v.push(l.split(/\s+/).slice(1, 4).map(Number)); else if (l.startsWith('f ')) { const ix = l.trim().split(/\s+/).slice(1).map((t) => parseInt(t.split('/')[0], 10) - 1); for (let k = 1; k < ix.length - 1; k++) for (const q of [ix[0], ix[k], ix[k + 1]]) pos.push(...v[q]); } } return new Float32Array(pos); }
const GATE = { ratio: Math.sqrt(3) + 0.01, seam: 0.30 };

test('uvgen: a unit cube maps every face into [0,1], deterministically, with density inside the theoretical bound; bad input is rejected', () => {
  const q = (a, b, c, d) => [...a, ...b, ...c, ...a, ...c, ...d]; const P = (x, y, z) => [x, y, z];
  const cube = new Float32Array([...q(P(0,0,0), P(1,0,0), P(1,1,0), P(0,1,0)), ...q(P(0,0,1), P(0,1,1), P(1,1,1), P(1,0,1)), ...q(P(0,0,0), P(0,1,0), P(0,1,1), P(0,0,1)), ...q(P(1,0,0), P(1,0,1), P(1,1,1), P(1,1,0)), ...q(P(0,0,0), P(0,0,1), P(1,0,1), P(1,0,0)), ...q(P(0,1,0), P(1,1,0), P(1,1,1), P(0,1,1))]);
  const a = UV.boxProjectUV(cube), b = UV.boxProjectUV(cube); assertEqual(a.uv.length, cube.length / 3 * 2); assert(a.uv.every((x) => x >= 0 && x <= 1), 'in [0,1]'); assertEqual(Array.from(a.uv).join(), Array.from(b.uv).join(), 'deterministic');
  const st = UV.densityStats(cube, a.uv, a.axes); assert(st.densityRatio <= 1.0001, 'axis-aligned faces: perfectly uniform density'); assertEqual(new Set(a.axes).size, 3, 'uses all three projection axes');
  for (const bad of [null, undefined, new Float32Array(0), new Float32Array(8), new Float32Array(9), new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]), []]) assertEqual(UV.boxProjectUV(bad), null, 'rejected: ' + String(bad && bad.length));
});
test('uvgen: arbitrary-orientation triangles stay within the theoretical density bound (a projection can never distort a triangle by more than sqrt(3))', () => {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1; const pos = new Float32Array(9 * 400); for (let i = 0; i < pos.length; i++) pos[i] = rnd() * 5;
  const r = UV.boxProjectUV(pos), st = UV.densityStats(pos, r.uv, r.axes); assert(st.densityRatio <= GATE.ratio, 'ratio ' + st.densityRatio.toFixed(3));
});
test('uvgen: DECISION GATE on the real helmet (variant B = generated UV + texture) passes the pre-set criteria; the Omnitrix would NOT (and has no texture), so it is left alone', () => {
  const hp = parseObj(path.join(PUB, 'models/accessories/helmet/helmet.obj')); const h = UV.boxProjectUV(hp), hs = UV.densityStats(hp, h.uv, h.axes);
  assertEqual(hs.triangles, 620); assert(hs.densityRatio <= GATE.ratio, 'helmet density ratio ' + hs.densityRatio.toFixed(3)); assert(hs.seamFraction <= GATE.seam, 'helmet seam fraction ' + hs.seamFraction.toFixed(3)); assert(hs.uvRange.u[0] >= 0 && hs.uvRange.u[1] <= 1 && hs.uvRange.v[0] >= 0 && hs.uvRange.v[1] <= 1, 'uv in [0,1]');
  assert(Array.from(h.uv).every(Number.isFinite), 'no NaN');
  const op = parseObj(path.join(PUB, 'models/accessories/omnitrix/omnitrix.obj')); const o = UV.boxProjectUV(op), os = UV.densityStats(op, o.uv, o.axes); assert(os.seamFraction > GATE.seam, 'omnitrix seams ' + os.seamFraction.toFixed(3) + ' exceed the gate');
});
test('uvgen (client): the UV is generated ONLY for a textured mesh without UV and without an index; an authored UV is never replaced; script loaded before use', () => {
  assert(CLIENT.indexOf('<script src="uvgen.js">') > 0 && CLIENT.indexOf('<script src="uvgen.js">') < CLIENT.indexOf('BBUV.boxProjectUV'), 'uvgen.js loaded first');
  const acc = CLIENT.slice(CLIENT.indexOf("v.shape === 'model'"), CLIENT.indexOf("v.shape === 'spikes'")); assert(/if \(tex && !hasUV && ch\.geometry && ch\.geometry\.attributes && ch\.geometry\.attributes\.position && !ch\.geometry\.index\)/.test(acc), 'guard: texture + no UV + not indexed');
  assert(/ch\.geometry\.setAttribute\('uv', new THREE\.BufferAttribute\(gen\.uv, 2\)\)/.test(acc) && /map: tex && hasUV \? tex : null/.test(acc), 'texture only on a mesh that has UVs now');
});
test('uvgen (client, behaviour): the integration block really adds a uv attribute to a UV-less mesh and leaves an authored one untouched', () => {
  const acc = CLIENT.slice(CLIENT.indexOf("v.shape === 'model'"), CLIENT.indexOf("v.shape === 'spikes'")); const blk = acc.slice(acc.indexOf('let hasUV'), acc.indexOf('ch.material = new THREE.MeshStandardMaterial'));
  const run = (geo, tex) => new Function('BBUV', 'THREE', 'tex', 'ch', blk + '; return hasUV;')(UV, { BufferAttribute: class { constructor(a, n) { this.array = a; this.itemSize = n; } } }, tex, { geometry: geo });
  const mk = () => ({ attributes: { position: { array: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) } }, index: null, setAttribute(n, a) { this.attributes[n] = a; } });
  const g1 = mk(); assert(run(g1, {}) === true && g1.attributes.uv && g1.attributes.uv.itemSize === 2 && g1.attributes.uv.array.length === 6, 'uv added');
  const g2 = mk(); g2.attributes.uv = { marker: 'authored' }; assert(run(g2, {}) === true && g2.attributes.uv.marker === 'authored', 'authored UV kept'); const g3 = mk(); assert(run(g3, null) === false && !g3.attributes.uv, 'no texture -> nothing generated'); const g4 = mk(); g4.index = {}; assert(run(g4, {}) === false && !g4.attributes.uv, 'indexed geometry is not touched');
});
