// Phase 3 — Settings module tests (pure logic, no DOM/localStorage needed).
// Run standalone: node tests/settings.js
// Also picked up automatically by tests/run.js.

const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const { DEFAULT_SETTINGS, validateSettings, parseSettingsJSON } = require(path.join(__dirname, '..', 'public', 'settings.js'));

test('settings: no stored value -> defaults', () => {
  const s = parseSettingsJSON(null);
  assertEqual(JSON.stringify(s), JSON.stringify(DEFAULT_SETTINGS));
});

test('settings: malformed JSON -> falls back to defaults, does not throw', () => {
  const s = parseSettingsJSON('{not valid json!!');
  assertEqual(JSON.stringify(s), JSON.stringify(DEFAULT_SETTINGS));
});

test('settings: valid partial object merges with defaults', () => {
  const s = parseSettingsJSON(JSON.stringify({ masterVolume: 40, graphicsQuality: 'low' }));
  assertEqual(s.masterVolume, 40);
  assertEqual(s.graphicsQuality, 'low');
  assertEqual(s.pingDisplay, DEFAULT_SETTINGS.pingDisplay, 'unspecified fields keep their default');
});

test('settings: out-of-range volume is clamped, not rejected wholesale', () => {
  const s = validateSettings({ masterVolume: 9999, sfxVolume: -50 });
  assertEqual(s.masterVolume, 100);
  assertEqual(s.sfxVolume, 0);
});

test('settings: non-numeric volume falls back to default (per-field, not whole object)', () => {
  const s = validateSettings({ masterVolume: 'loud please', musicVolume: 55 });
  assertEqual(s.masterVolume, DEFAULT_SETTINGS.masterVolume, 'invalid field falls back to its own default');
  assertEqual(s.musicVolume, 55, 'valid sibling field is preserved, not discarded');
});

test('settings: invalid enum value (graphicsQuality) falls back to default', () => {
  const s = validateSettings({ graphicsQuality: 'ULTRA_9000' });
  assertEqual(s.graphicsQuality, DEFAULT_SETTINGS.graphicsQuality);
});

test('settings: invalid boolean falls back to default', () => {
  const s = validateSettings({ hitMarker: 'yes' });
  assertEqual(s.hitMarker, DEFAULT_SETTINGS.hitMarker);
});

test('settings: every field in DEFAULT_SETTINGS is covered by validateSettings output', () => {
  const s = validateSettings({});
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    assert(key in s, `validateSettings output is missing '${key}'`);
  }
});
