// Pure helpers for combat feedback UI (Phase 5). No DOM access, so the same
// file is loaded by the browser and required by the Node tests.
const DAMAGE_NUMBER_CAPS = Object.freeze({ low: 3, medium: 6, high: 10 });

// Max simultaneous floating numbers. Mobile gets half (min 2) as the
// performance fallback so a full-auto brawl can't flood the DOM.
function maxDamageNumbers(quality, isMobile) {
  const base = DAMAGE_NUMBER_CAPS[quality] || DAMAGE_NUMBER_CAPS.medium;
  return isMobile ? Math.max(2, Math.floor(base / 2)) : base;
}

// Text shown for a server-confirmed damage value. Rejects anything that is
// not a finite positive number so a malformed message can't render junk.
function formatDamage(damage, crit) {
  const n = Math.round(Number(damage));
  if (!Number.isFinite(n) || n <= 0 || n > 9999) return null;
  return crit ? `${n}!` : String(n);
}

// Given the live list (oldest first), returns how many of the oldest must be
// removed so that adding one more stays within max.
function overflowCount(currentLength, max) {
  return Math.max(0, currentLength + 1 - max);
}

// Ashes/Fire death-effect budget (Phase 9). Particle Quality setting picks the
// tier; touch devices drop one tier (mobile performance fallback) and the
// number of effects alive at once is capped so chain kills can't pile up.
const ASH_TIERS = Object.freeze({
  low:    { flames: 3, embers: 10, maxConcurrent: 2 },
  medium: { flames: 5, embers: 18, maxConcurrent: 3 },
  high:   { flames: 8, embers: 28, maxConcurrent: 5 },
});
function ashesBudget(quality, isMobile) {
  const order = ['low', 'medium', 'high'];
  let i = order.indexOf(quality); if (i < 0) i = 1;
  if (isMobile) i = Math.max(0, i - 1);
  return ASH_TIERS[order[i]];
}

// Emote wheel geometry (Phase 11): ring radius keeps every item on-screen and
// item size shrinks when many emotes would otherwise overlap their neighbours.
function wheelGeometry(w, h, n) {
  const half = Math.min(w, h) / 2;
  const R = Math.max(40, Math.min(140, half - 40));
  const chord = n > 1 ? 2 * R * Math.sin(Math.PI / n) : 64;
  const size = Math.max(36, Math.min(64, Math.floor(chord - 6)));
  return { R, size };
}

// Skybox resolution tier (Phase 2). Same tier convention as ashesBudget: touch devices drop one tier. Only the LOW tier uses the
// 2048x1024 sky (4x less GPU memory: ~11 MB vs ~43 MB with mipmaps); medium/high keep the original 4096x2048 file unchanged.
const SKYBOX_FILES = Object.freeze({ low: 'textures/skyboxes/day_2k.png', medium: 'textures/skyboxes/day.png', high: 'textures/skyboxes/day.png' });
function skyboxFile(quality, isMobile) {
  const order = ['low', 'medium', 'high'];
  let i = order.indexOf(quality); if (i < 0) i = 1;
  if (isMobile) i = Math.max(0, i - 1);
  return SKYBOX_FILES[order[i]];
}

const api = { skyboxFile, SKYBOX_FILES, wheelGeometry, ashesBudget, ASH_TIERS, DAMAGE_NUMBER_CAPS, maxDamageNumbers, formatDamage, overflowCount };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.BBFeedback = api;
