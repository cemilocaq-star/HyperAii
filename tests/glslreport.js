// The REAL-WebGL shader check (tools/glsl_compile_check.py) writes docs/glsl_compile_report.json with a hash of the GLSL it tested.
// This test does not run a GPU; it proves the committed report is about THE CURRENT shader text (a changed shader makes it fail until the tool is re-run)
// and that the recorded real-WebGL results are all good. Scope of the evidence is stated in the report itself: mock three.js prefix, software GPU.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const ROOT = path.join(__dirname, '..');
const W = require(path.join(ROOT, 'public', 'wind.js'));
const R = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'glsl_compile_report.json'), 'utf8'));

test('glslreport: the committed real-WebGL report is for the CURRENT GLSL (hash matches) — re-run `python3 tools/glsl_compile_check.py` after any shader edit', () => {
  const h = crypto.createHash('sha256').update(W.vertexCommon() + '\0' + W.vertexBegin() + '\0' + W.particleVertex() + '\0' + W.particleFragment()).digest('hex');
  assertEqual(R.glsl_sha256, h, 'report is stale: the shader text changed since the last real-WebGL run');
});
test('glslreport: every custom shader compiled and linked in BOTH WebGL1 and WebGL2 (real ANGLE/SwiftShader context, mock three.js prefix)', () => {
  assert(R.all_ok === true, 'all_ok'); assert(R.contexts.webgl && R.contexts.webgl.available && R.contexts.webgl2 && R.contexts.webgl2.available, 'both contexts were available'); assertEqual(R.errors.length, 0, 'no missing uniforms');
  const by = (ctx) => R.shaders.filter((s) => s.context === ctx); assert(by('webgl').length >= 3 && by('webgl2').length >= 4, 'sway + particle (mediump + highp) in both, plus the ES 3.00 execution variant');
  for (const s of R.shaders) assert(s.vertexCompiled && s.fragmentCompiled && s.linked && s.log === '', s.context + ' ' + s.label + ': ' + s.log);
  for (const ctx of ['webgl', 'webgl2']) { assertEqual(R.particles[ctx].glError, 0, ctx + ' draw error'); assert(R.particles[ctx].litPixels > 0, ctx + ' the motes actually rasterised'); assert(R.particles[ctx].pointSizeRange[1] >= 6, ctx + ' supports the 1..6 px point sizes we clamp to'); }
});
test('glslreport: the sway snippet EXECUTED on the GPU does what the design says — base planted, push along the wind only, matches the formula, correct under rotation + scale', () => {
  assertEqual(R.sway.length, 3, 'three model-matrix cases');
  for (const c of R.sway) {
    assertEqual(c.glError, 0, c.case + ' GL error'); assert(c.worstError < 1e-3, c.case + ' worst error vs formula ' + c.worstError); assertEqual(c.baseRowDisplacement.join(), '0,0,0', c.case + ': a vertex at the plant base never moves'); assertEqual(c.verticalDriftMax, 0, c.case + ': no vertical drift');
    for (const r of c.rows) { const [dx, , dz] = r.displacement; const mag = Math.hypot(dx, dz); if (mag > 0.05) assert(Math.abs(dx / mag - W.DIR.x) < 1e-3 && Math.abs(dz / mag - W.DIR.z) < 1e-3, c.case + ': push is parallel to the wind direction at h=' + r.objectHeight); }
    const mags = c.rows.map((r) => Math.hypot(r.displacement[0], r.displacement[2])); for (let i = 1; i < mags.length; i++) assert(mags[i] + 1e-9 >= mags[i - 1] || c.rows[i].worldHeight >= 5.99, c.case + ': push grows with height (until the 6-unit clamp)');
  }
  const ident = R.sway.find((c) => c.case === 'identity'); const low = ident.rows.find((r) => r.objectHeight === 0.5); assert(Math.hypot(low.displacement[0], low.displacement[2]) < 0.02, 'half a unit above the root moves < 0.02 units: no root deformation');
  assert(/MOCK three\.js prefix/i.test(R.notes) && /not the full three\.js program/i.test(R.notes), 'the report states what it does NOT prove');
});
