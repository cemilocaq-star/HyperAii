// Shared FIXED player hitbox + hit-location damage table.
// Single source of truth: server.js require()s this file to decide the hit zone (server-authoritative), and the browser loads the very same
// file to build its invisible picking proxies and the optional ?hitbox=1 debug wireframe. The hitbox is the same for every player, skin and
// animation: it never follows the visible model, so a bulky skin or an emote cannot make a player easier or harder to hit.
//
// Geometry is defined relative to the player's FEET. Players are tracked by EYE position (EYE_HEIGHT above the feet), so feet = eyeY - EYE_HEIGHT.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBHitbox = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const EYE_HEIGHT = 1.6;
  const ZONES = Object.freeze({
    legs:  Object.freeze({ kind: 'cyl',    y0: 0.00, y1: 0.80, r: 0.30 }),
    torso: Object.freeze({ kind: 'cyl',    y0: 0.80, y1: 1.40, r: 0.38 }),
    head:  Object.freeze({ kind: 'sphere', cy: 1.55, r: 0.26 }),
  });
  // DESIGN VALUES (tune freely): damage multiplier per zone. Applied to gun hits only (the knife keeps its flat damage, the bomb is area damage).
  const DAMAGE_MULT = Object.freeze({ head: 2.0, torso: 1.0, legs: 0.75 });
  const ZONE_ORDER = Object.freeze(['head', 'torso', 'legs']); // tie-break when two zones are hit at the same distance
  const SLACK = 0.1; // small forgiveness added to every zone (server positions are a little behind what the shooter sees)

  // Ray (unit direction) vs vertical cylinder with flat caps. Returns the nearest t >= 0 or null.
  function rayCylinder(ox, oy, oz, dx, dy, dz, cx, cz, r, y0, y1) {
    let best = null;
    const consider = (t) => { if (t >= 0 && (best === null || t < best)) best = t; };
    const a = dx * dx + dz * dz;
    const px = ox - cx, pz = oz - cz;
    if (a > 1e-12) {
      const b = 2 * (px * dx + pz * dz), c = px * px + pz * pz - r * r, disc = b * b - 4 * a * c;
      if (disc >= 0) {
        const s = Math.sqrt(disc);
        for (const t of [(-b - s) / (2 * a), (-b + s) / (2 * a)]) { const y = oy + dy * t; if (t >= 0 && y >= y0 && y <= y1) consider(t); }
      }
    }
    if (Math.abs(dy) > 1e-12) {
      for (const yc of [y0, y1]) {
        const t = (yc - oy) / dy;
        if (t >= 0) { const hx = px + dx * t, hz = pz + dz * t; if (hx * hx + hz * hz <= r * r) consider(t); }
      }
    }
    return best;
  }

  // Ray (unit direction) vs sphere. Returns the nearest t >= 0 or null (origin inside the sphere counts as t = 0).
  function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
    const px = ox - cx, py = oy - cy, pz = oz - cz;
    const b = px * dx + py * dy + pz * dz, c = px * px + py * py + pz * pz - r * r;
    if (c <= 0) return 0;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : null;
  }

  // aim = { ox, oy, oz, dx, dy, dz } with a UNIT direction; target = { x, y, z } with y = EYE position.
  // Returns { zone, t } for the nearest zone the ray passes through, or null when it misses the whole hitbox.
  function resolveZone(aim, target) {
    if (!aim || !target) return null;
    const feet = target.y - EYE_HEIGHT;
    let bestZone = null, bestT = null;
    for (const name of ZONE_ORDER) {
      const z = ZONES[name];
      const t = z.kind === 'sphere'
        ? raySphere(aim.ox, aim.oy, aim.oz, aim.dx, aim.dy, aim.dz, target.x, feet + z.cy, target.z, z.r + SLACK)
        : rayCylinder(aim.ox, aim.oy, aim.oz, aim.dx, aim.dy, aim.dz, target.x, target.z, z.r + SLACK, feet + z.y0 - SLACK, feet + z.y1 + SLACK);
      if (t !== null && (bestT === null || t < bestT - 1e-9)) { bestT = t; bestZone = name; }
    }
    return bestZone ? { zone: bestZone, t: bestT } : null;
  }

  return { EYE_HEIGHT, ZONES, DAMAGE_MULT, ZONE_ORDER, SLACK, resolveZone, rayCylinder, raySphere };
});
