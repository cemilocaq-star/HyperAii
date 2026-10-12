// Graphics profile (client rendering only — never touches gameplay, collision, the server or the network).
// Pure logic shared by the browser and the tests: which pixel ratio and which directional-shadow quality each quality tier gets, whether a plan is
// valid for the device, and where the shadow camera must sit so shadows do not shimmer while the player moves.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBGfx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TIERS = Object.freeze(['low', 'medium', 'high']);
  // DESIGN VALUES (not measured on any device): per tier pixel-ratio cap and sun-shadow quality.
  // low = no shadows, pixel ratio 1 (exactly the behaviour before this phase). medium = 1024 PCF shadows. high = 2048 soft-PCF shadows.
  const PROFILES = Object.freeze({
    low:    Object.freeze({ pixelRatioCap: 1.0, shadow: null }),
    medium: Object.freeze({ pixelRatioCap: 1.5, shadow: Object.freeze({ size: 1024, half: 22, type: 'pcf' }) }),
    high:   Object.freeze({ pixelRatioCap: 2.0, shadow: Object.freeze({ size: 2048, half: 26, type: 'pcfsoft' }) }),
  });
  const SUN_DIR = Object.freeze({ x: 10 / Math.hypot(10, 20, 10), y: 20 / Math.hypot(10, 20, 10), z: 10 / Math.hypot(10, 20, 10) }); // same direction as the scene's directional light
  const SUN_DISTANCE = 40;

  // Same tier convention as the other quality-driven effects: touch devices use one tier lower; unknown quality = medium.
  function effectiveTier(quality, isMobile) {
    let i = TIERS.indexOf(quality); if (i < 0) i = 1;
    if (isMobile) i = Math.max(0, i - 1);
    return TIERS[i];
  }
  // dpr = window.devicePixelRatio. The result never goes below 1 (the previous behaviour) and never above the tier cap.
  function plan(quality, isMobile, dpr) {
    const tier = effectiveTier(quality, isMobile), prof = PROFILES[tier];
    const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const pixelRatio = Math.max(1, Math.min(d, prof.pixelRatioCap));
    const sh = prof.shadow;
    return { tier, pixelRatio, shadows: sh ? { enabled: true, size: sh.size, half: sh.half, type: sh.type } : { enabled: false, size: 0, half: 0, type: 'pcf' } };
  }
  const isPow2 = (n) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
  // caps = { maxTextureSize }. A plan that fails here is rejected BEFORE anything is applied.
  function validate(p, caps) {
    if (!p || typeof p !== 'object') return { ok: false, reason: 'no plan' };
    if (!Number.isFinite(p.pixelRatio) || p.pixelRatio < 1 || p.pixelRatio > 3) return { ok: false, reason: 'pixelRatio out of range' };
    const s = p.shadows;
    if (!s || typeof s.enabled !== 'boolean') return { ok: false, reason: 'no shadow plan' };
    if (s.enabled) {
      if (!isPow2(s.size)) return { ok: false, reason: 'shadow size is not a power of two' };
      const max = caps && Number.isFinite(caps.maxTextureSize) ? caps.maxTextureSize : 0;
      if (!(max >= s.size)) return { ok: false, reason: 'shadow size exceeds the device texture limit' };
      if (!(s.half > 0)) return { ok: false, reason: 'shadow area must be positive' };
      if (s.type !== 'pcf' && s.type !== 'pcfsoft') return { ok: false, reason: 'unknown shadow type' };
    }
    return { ok: true, reason: '' };
  }

  // Where to put the sun and its target so that the shadow map is always centred on the camera but moves in whole-texel steps (no shimmering).
  // cam = {x,y,z}. Snapping is done along the light's own right/up axes, which is what the shadow map's texel grid follows.
  function shadowFit(cam, half, size) {
    const fx = -SUN_DIR.x, fy = -SUN_DIR.y, fz = -SUN_DIR.z;               // light forward (towards the scene)
    let rx = fz, ry = 0, rz = -fx; const rl = Math.hypot(rx, ry, rz); rx /= rl; rz /= rl; // right = up(0,1,0) x forward, normalised (ry stays 0)
    const ux = fy * rz - fz * ry, uy = fz * rx - fx * rz, uz = fx * ry - fy * rx;          // up' = forward x right
    const texel = (2 * half) / size;
    const pr = cam.x * rx + cam.y * ry + cam.z * rz, pu = cam.x * ux + cam.y * uy + cam.z * uz, pf = cam.x * fx + cam.y * fy + cam.z * fz;
    const sr = Math.round(pr / texel) * texel, su = Math.round(pu / texel) * texel;
    const tx = rx * sr + ux * su + fx * pf, ty = ry * sr + uy * su + fy * pf, tz = rz * sr + uz * su + fz * pf;
    return { tx, ty, tz, px: tx + SUN_DIR.x * SUN_DISTANCE, py: ty + SUN_DIR.y * SUN_DISTANCE, pz: tz + SUN_DIR.z * SUN_DISTANCE, texel };
  }

  return { TIERS, PROFILES, SUN_DIR, SUN_DISTANCE, effectiveTier, plan, validate, shadowFit };
});
