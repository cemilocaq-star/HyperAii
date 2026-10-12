// Wind (visual only). Nothing here touches gameplay, collision, the server or the network: it only moves trees/flowers and drifts a few dust motes.
// One source of truth for: the wind direction, the gust curve, per-kind sway strength, the particle budget per quality tier and the GLSL snippets.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBWind = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DIR = Object.freeze({ x: 0.8, z: 0.6 });               // unit vector (0.8^2 + 0.6^2 = 1): wind blows toward +x/+z
  const SWAY = Object.freeze({ tree: 1.0, flower: 2.4 });        // sway strength per plant kind (flowers are short, so they need more to read)
  const PARTICLES = Object.freeze({                              // dust/leaf motes around the camera, by the existing particleQuality setting
    low:    Object.freeze({ desktop: 0,   mobile: 0 }),
    medium: Object.freeze({ desktop: 140, mobile: 50 }),
    high:   Object.freeze({ desktop: 280, mobile: 110 }),
  });
  const PARTICLE_BOX = 30;                                       // motes live in a 30 x 30 area that follows the camera (wrapped on the GPU)

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // Slow irregular gusts, 0..1. Pure function of time so every client (and the tests) agree on it.
  function gust(t) { return clamp01(0.5 + 0.35 * Math.sin(0.31 * t) + 0.25 * Math.sin(0.77 * t + 1.7)); }

  // Same tier convention as the other particle effects: touch devices use the smaller budget; unknown quality -> medium.
  function particleCount(quality, isMobile) {
    const tier = PARTICLES[quality] || PARTICLES.medium;
    return isMobile ? tier.mobile : tier.desktop;
  }
  // Which decor sways. Rocks, logs, stumps, fences, mushrooms and every house prop stay perfectly still.
  function swayKind(url) {
    if (typeof url !== 'string') return null;
    if (/\/tree_[A-Za-z0-9]+\.glb$/.test(url)) return 'tree';
    if (/\/flower_[A-Za-z0-9]+\.glb$/.test(url)) return 'flower';
    return null;
  }

  // ---- GLSL (kept to GLSL ES 1.00 features: no inverse()/transpose(), so it also compiles on WebGL1 fallbacks) ----
  // Foliage sway, injected into a standard material's vertex shader. The plant's base (object origin) never moves; the offset grows with the
  // square of the height above it, each plant gets its own phase from its world position, and gusts add to the push.
  function vertexCommon() {
    return '#include <common>\nuniform float uWindTime;\nuniform float uWindGust;\nuniform float uWindAmp;\nuniform vec2 uWindDir;\n';
  }
  function vertexBegin() {
    return [
      '#include <begin_vertex>',
      '{',
      '  vec4 wBase = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);',
      '  vec4 wPos = modelMatrix * vec4(transformed, 1.0);',
      '  float wh = clamp(wPos.y - wBase.y, 0.0, 6.0);',
      '  float wPhase = dot(wBase.xz, vec2(0.35, 0.27));',
      '  float wWave = 0.55 + 0.6 * sin(uWindTime * 1.7 + wPhase) + 0.25 * sin(uWindTime * 3.1 + wPhase * 1.7 + wh * 0.8) + 0.9 * uWindGust;',
      '  vec2 wOff = uWindDir * (wh * wh * 0.012 * uWindAmp * wWave);',
      '  vec3 wWorld = vec3(wOff.x, 0.0, wOff.y);',
      '  mat3 wM = mat3(modelMatrix);',
      '  float wS2 = max(dot(wM[0], wM[0]), 0.0001);',
      '  transformed += vec3(dot(wM[0], wWorld), dot(wM[1], wWorld), dot(wM[2], wWorld)) / wS2;', // world offset -> object space (rotation + uniform scale)
      '}',
    ].join('\n');
  }
  // Dust / leaf motes: all motion is computed here from a per-mote seed, so the CPU only updates a few uniforms per frame.
  function particleVertex() {
    return [
      'uniform float uTime;',
      'uniform float uGust;',
      'uniform float uBox;',
      'uniform float uSize;',
      'uniform vec2 uWindDir;',
      'uniform vec3 uCam;',
      'attribute vec4 aSeed;',
      'varying float vAlpha;',
      'void main() {',
      '  float speed = 1.2 + uGust * 2.2;',
      '  vec2 drift = uWindDir * (uTime * speed);',
      '  vec2 flutter = vec2(sin(uTime * 0.9 + aSeed.w * 6.2831), cos(uTime * 0.7 + aSeed.w * 5.0)) * 0.5;',
      '  vec2 p = aSeed.xz * uBox + drift + flutter;',
      '  vec2 off = mod(p - uCam.xz + vec2(uBox * 0.5), vec2(uBox)) - vec2(uBox * 0.5);',
      '  float y = 0.3 + aSeed.y * 4.0 + cos(uTime * 1.3 + aSeed.w * 9.0) * 0.3;',
      '  vec4 mv = viewMatrix * vec4(uCam.x + off.x, y, uCam.z + off.y, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = clamp(uSize * 200.0 / max(1.0, -mv.z), 1.0, 6.0);',
      '  vAlpha = 1.0 - smoothstep(0.35, 0.5, length(off) / uBox);',
      '}',
    ].join('\n');
  }
  function particleFragment() {
    return [
      'uniform vec3 uColor;',
      'varying float vAlpha;',
      'void main() {',
      '  float d = length(gl_PointCoord - vec2(0.5));',
      '  if (d > 0.5) discard;',
      '  gl_FragColor = vec4(uColor, vAlpha * (1.0 - d * 2.0) * 0.55);',
      '}',
    ].join('\n');
  }

  return { DIR, SWAY, PARTICLES, PARTICLE_BOX, gust, particleCount, swayKind, vertexCommon, vertexBegin, particleVertex, particleFragment };
});
