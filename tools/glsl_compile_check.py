#!/usr/bin/env python3
"""Compile + execute the project's custom GLSL (public/wind.js) in a REAL WebGL context (headless Chrome, SwiftShader software GPU).

What this proves:  the GLSL snippets compile and link in WebGL1 (GLSL ES 1.00) and WebGL2, the point shaders draw without GL errors,
                   and the foliage-sway snippet, executed on the (software) GPU through transform feedback, produces the numbers the design promises
                   (plant base fixed, push along the wind direction only, bounded, correct under rotation + scale).
What it does NOT prove: the full three.js program (three's own chunks are replaced by a minimal mock prefix), visual quality, or any real-GPU/mobile behaviour.
Usage: python3 tools/glsl_compile_check.py   -> writes docs/glsl_compile_report.json (contains a hash of the GLSL so tests can detect a stale report)
"""
import asyncio, hashlib, json, os, subprocess, sys, glob
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def find_chrome():
    c = glob.glob(os.path.expanduser('~/.cache/puppeteer/chrome-headless-shell/*/*/chrome-headless-shell')) + glob.glob('/opt/pw-browsers/*/chrome-linux/headless_shell') + glob.glob('/opt/pw-browsers/*/chrome-headless-shell-linux64/chrome-headless-shell')
    return c[0] if c else None

def load_glsl():
    js = "const W=require(%r);process.stdout.write(JSON.stringify({common:W.vertexCommon(),begin:W.vertexBegin(),pv:W.particleVertex(),pf:W.particleFragment(),DIR:W.DIR,gust:[0,0.5,1].map(g=>g)}))" % os.path.join(ROOT, 'public', 'wind.js')
    return json.loads(subprocess.check_output(['node', '-e', js]))

PAGE_JS = r"""
async (g) => {
  const out = { contexts: {}, shaders: [], sway: null, particles: null, errors: [] };
  const stripInclude = (s, tag) => s.replace('#include <' + tag + '>', '');
  function compile(gl, type, src, label) { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); const ok = gl.getShaderParameter(sh, gl.COMPILE_STATUS); return { sh, ok, log: ok ? '' : gl.getShaderInfoLog(sh), label }; }
  function link(gl, vs, fs, label, tf) { const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, fs); if (tf) gl.transformFeedbackVaryings(p, tf, gl.INTERLEAVED_ATTRIBS); gl.linkProgram(p); const ok = gl.getProgramParameter(p, gl.LINK_STATUS); return { p, ok, log: ok ? '' : gl.getProgramInfoLog(p), label }; }
  const fsPlain = 'precision mediump float;\nvoid main(){ gl_FragColor = vec4(1.0); }';
  for (const ver of ['webgl', 'webgl2']) {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64; const gl = c.getContext(ver);
    if (!gl) { out.contexts[ver] = { available: false }; continue; }
    out.contexts[ver] = { available: true, version: gl.getParameter(gl.VERSION) };
    // 1) foliage sway snippet inside a mock of three's vertex prefix (GLSL ES 1.00: valid in WebGL1 and WebGL2)
    const swayVS = 'precision highp float;\nuniform mat4 modelMatrix; uniform mat4 viewMatrix; uniform mat4 projectionMatrix;\nattribute vec3 position;\n' + stripInclude(g.common, 'common') +
      '\nvoid main(){ vec3 transformed = vec3(position);\n' + stripInclude(g.begin, 'begin_vertex') + '\ngl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(transformed, 1.0); }';
    // 2) point shaders in three's ShaderMaterial prefix (highp vertex; fragment checked at highp AND mediump)
    const pVS = 'precision highp float;\nuniform mat4 viewMatrix; uniform mat4 projectionMatrix;\nattribute vec3 position;\n' + g.pv;
    const jobs = [['sway-vertex', gl.VERTEX_SHADER, swayVS, fsPlain], ['particle-vertex+fragment(mediump)', gl.VERTEX_SHADER, pVS, 'precision mediump float;\n' + g.pf], ['particle-vertex+fragment(highp)', gl.VERTEX_SHADER, pVS, 'precision highp float;\n' + g.pf]];
    for (const [label, type, vsrc, fsrc] of jobs) {
      const v = compile(gl, type, vsrc, label), f = compile(gl, gl.FRAGMENT_SHADER, fsrc, label); const l = (v.ok && f.ok) ? link(gl, v.sh, f.sh, label) : { ok: false, log: '' };
      out.shaders.push({ context: ver, label, vertexCompiled: v.ok, fragmentCompiled: f.ok, linked: l.ok, log: (v.log + f.log + l.log).slice(0, 400) });
      if (label.startsWith('particle-vertex+fragment(mediump)') && l.ok) { // draw 200 motes and make sure the GPU accepts the program, uniforms and attribute layout
        gl.useProgram(l.p); const n = 200; const seeds = new Float32Array(n * 4).map((_, i) => (Math.sin(i * 12.9898) * 43758.5453) % 1 * 0.5 + 0.5); const pos = new Float32Array(n * 3);
        const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW); const lp = gl.getAttribLocation(l.p, 'position'); if (lp >= 0) { gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0); }
        const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2); gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW); const ls = gl.getAttribLocation(l.p, 'aSeed'); gl.enableVertexAttribArray(ls); gl.vertexAttribPointer(ls, 4, gl.FLOAT, false, 0, 0);
        const U = (n, ...v) => { const loc = gl.getUniformLocation(l.p, n); if (loc === null) { out.errors.push(ver + ': uniform missing/optimised out: ' + n); return; } v.length === 1 ? gl.uniform1f(loc, v[0]) : v.length === 2 ? gl.uniform2f(loc, ...v) : gl.uniform3f(loc, ...v); };
        U('uTime', 3.0); U('uGust', 0.5); U('uBox', 30.0); U('uSize', 1.0); U('uWindDir', 0.8, 0.6); U('uCam', 0, 1.6, 0); U('uColor', 0.9, 0.95, 0.77);
        const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); const P = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,-1.0020,-1, 0,0,-0.2002,0]);
        gl.uniformMatrix4fv(gl.getUniformLocation(l.p, 'viewMatrix'), false, I); gl.uniformMatrix4fv(gl.getUniformLocation(l.p, 'projectionMatrix'), false, P);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.POINTS, 0, n);
        const err = gl.getError(); const px = new Uint8Array(64 * 64 * 4); gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px); let lit = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
        out.particles = Object.assign(out.particles || {}, { [ver]: { glError: err, litPixels: lit, pointSizeRange: Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)) } });
      }
    }
    // 3) EXECUTE the sway snippet on the GPU (WebGL2 transform feedback) and read back the vertices it moved
    if (ver === 'webgl2') {
      const vs = '#version 300 es\nprecision highp float;\nuniform mat4 modelMatrix;\nin vec3 position;\nout vec3 vT;\n' + stripInclude(g.common, 'common') + '\nvoid main(){ vec3 transformed = position;\n' + stripInclude(g.begin, 'begin_vertex') + '\nvT = transformed; gl_Position = vec4(0.0); }';
      const v = compile(gl, gl.VERTEX_SHADER, vs, 'sway-es300'), f = compile(gl, gl.FRAGMENT_SHADER, '#version 300 es\nprecision mediump float;\nout vec4 o;\nvoid main(){ o = vec4(1.0); }', 'f');
      const l = link(gl, v.sh, f.sh, 'sway-tf', ['vT']); out.shaders.push({ context: ver, label: 'sway-es300-transform-feedback', vertexCompiled: v.ok, fragmentCompiled: f.ok, linked: l.ok, log: (v.log + f.log + l.log).slice(0, 400) });
      if (l.ok) {
        const cases = []; const sets = [ { name: 'identity', M: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], amp: 1.0, t: 0.0, gust: 0.0 },
          { name: 'flower amp, gust 1', M: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], amp: 2.4, t: 5.3, gust: 1.0 },
          { name: 'rotated 1.2 rad + scale 1.8 + translated', M: (() => { const s = 1.8, c = Math.cos(1.2) * s, sn = Math.sin(1.2) * s; return [c,0,-sn,0, 0,s,0,0, sn,0,c,0, 7,0,-4,1]; })(), amp: 1.0, t: 11.7, gust: 0.4 } ];
        const heights = [0, 0.5, 1, 2, 3, 4.5, 6, 9]; // object-space heights (scale 1.8 makes world heights up to 16.2: the shader clamps at 6)
        for (const s of sets) {
          gl.useProgram(l.p); const m = gl.getUniformLocation(l.p, 'modelMatrix'); gl.uniformMatrix4fv(m, false, new Float32Array(s.M));
          const set1 = (n, x) => gl.uniform1f(gl.getUniformLocation(l.p, n), x); set1('uWindTime', s.t); set1('uWindGust', s.gust); set1('uWindAmp', s.amp); gl.uniform2f(gl.getUniformLocation(l.p, 'uWindDir'), g.DIR.x, g.DIR.z);
          const input = new Float32Array(heights.flatMap((h) => [0.1, h, -0.05])); const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, input, gl.STATIC_DRAW); const lp = gl.getAttribLocation(l.p, 'position'); gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 0, 0);
          const tb = gl.createBuffer(); gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, tb); gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, input.byteLength, gl.STATIC_READ); const tf = gl.createTransformFeedback(); gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf); gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, tb);
          gl.enable(gl.RASTERIZER_DISCARD); gl.beginTransformFeedback(gl.POINTS); gl.drawArrays(gl.POINTS, 0, heights.length); gl.endTransformFeedback(); gl.disable(gl.RASTERIZER_DISCARD);
          const res = new Float32Array(input.length); gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, res); cases.push({ name: s.name, M: s.M, amp: s.amp, t: s.t, gust: s.gust, heights, input: Array.from(input), output: Array.from(res), glError: gl.getError() });
        }
        out.sway = cases;
      }
    }
  }
  return out;
}
"""

async def run(chrome, g):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=chrome, args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(); await pg.set_content('<canvas></canvas>'); r = await pg.evaluate(PAGE_JS, g); ver = b.version; await b.close(); return r, ver

def mat_mul_point(M, p):  # column-major 4x4 * (x,y,z,1)
    return [M[0]*p[0] + M[4]*p[1] + M[8]*p[2] + M[12], M[1]*p[0] + M[5]*p[1] + M[9]*p[2] + M[13], M[2]*p[0] + M[6]*p[1] + M[10]*p[2] + M[14]]

def analyse_sway(cases, DIR):
    import math
    res = []
    for c in cases:
        M = c['M']; base = mat_mul_point(M, [0, 0, 0]); rows = []
        for k, h in enumerate(c['heights']):
            i = c['input'][3*k:3*k+3]; o = c['output'][3*k:3*k+3]; wi = mat_mul_point(M, i); wo = mat_mul_point(M, o); d = [wo[j] - wi[j] for j in range(3)]
            hw = max(0.0, min(6.0, wi[1] - base[1])); phase = base[0]*0.35 + base[2]*0.27
            wave = 0.55 + 0.6*math.sin(c['t']*1.7 + phase) + 0.25*math.sin(c['t']*3.1 + phase*1.7 + hw*0.8) + 0.9*c['gust']; mag = hw*hw*0.012*c['amp']*wave
            exp = [DIR['x']*mag, 0.0, DIR['z']*mag]; err = max(abs(d[j] - exp[j]) for j in range(3))
            rows.append(dict(objectHeight=h, worldHeight=round(hw, 4), displacement=[round(x, 5) for x in d], expected=[round(x, 5) for x in exp], maxAbsError=round(err, 6)))
        res.append(dict(case=c['name'], glError=c['glError'], rows=rows, worstError=max(r['maxAbsError'] for r in rows), baseRowDisplacement=rows[0]['displacement'], maxPush=max(math.hypot(r['displacement'][0], r['displacement'][2]) for r in rows),
                        verticalDriftMax=max(abs(r['displacement'][1]) for r in rows)))
    return res

def main():
    chrome = find_chrome()
    if not chrome: print('no headless Chrome found - cannot run a real WebGL check'); return 2
    g = load_glsl(); h = hashlib.sha256((g['common'] + '\0' + g['begin'] + '\0' + g['pv'] + '\0' + g['pf']).encode()).hexdigest()
    r, ver = asyncio.run(run(chrome, g))
    sway = analyse_sway(r['sway'] or [], g['DIR'])
    report = dict(tool='tools/glsl_compile_check.py', browser=ver, glsl_sha256=h, contexts=r['contexts'], shaders=r['shaders'], particles=r['particles'], sway=sway, errors=r['errors'],
                  notes='Real WebGL (ANGLE/SwiftShader software GPU) with a MOCK three.js prefix. Proves GLSL compile/link/execute; not the full three.js program, not visuals, not real/mobile GPUs.')
    ok = all(s['vertexCompiled'] and s['fragmentCompiled'] and s['linked'] for s in r['shaders']) and bool(sway) and all(c['worstError'] < 1e-3 and c['glError'] == 0 for c in sway)
    report['all_ok'] = bool(ok)
    open(os.path.join(ROOT, 'docs', 'glsl_compile_report.json'), 'w', encoding='utf8').write(json.dumps(report, indent=2) + '\n')
    for s in r['shaders']: print('%-8s %-40s compiled=%s/%s linked=%s %s' % (s['context'], s['label'], s['vertexCompiled'], s['fragmentCompiled'], s['linked'], s['log'][:120]))
    for c in sway: print('sway case %-45s glError=%s worstError=%.2e maxPush=%.3f baseDisp=%s verticalDrift=%.1e' % (c['case'], c['glError'], c['worstError'], c['maxPush'], c['baseRowDisplacement'], c['verticalDriftMax']))
    print('particles:', json.dumps(r['particles'])); print('errors:', r['errors']); print('ALL OK' if ok else 'FAILED'); return 0 if ok else 1
if __name__ == '__main__': sys.exit(main())
