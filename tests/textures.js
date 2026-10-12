// Texture tier tests (Phase 2): skybox resolution follows the existing quality tiers; assets are what the code claims.
const fs = require('fs'), path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const PUB = path.join(__dirname, '..', 'public');
const FB = require(path.join(PUB, 'feedback.js'));
const CLIENT = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
function pngSize(f) { const b = fs.readFileSync(f); assertEqual(b.slice(1, 4).toString(), 'PNG', f + ' is a PNG'); return [b.readUInt32BE(16), b.readUInt32BE(20)]; }

test('textures: skyboxFile tier table (desktop keeps 4k at medium/high; low and touch+medium use 2k; unknown -> medium)', () => {
  const K4 = 'textures/skyboxes/day.png', K2 = 'textures/skyboxes/day_2k.png';
  assertEqual(FB.skyboxFile('low', false), K2); assertEqual(FB.skyboxFile('medium', false), K4); assertEqual(FB.skyboxFile('high', false), K4);
  assertEqual(FB.skyboxFile('low', true), K2); assertEqual(FB.skyboxFile('medium', true), K2); assertEqual(FB.skyboxFile('high', true), K4);
  assertEqual(FB.skyboxFile('garbage', false), K4); assertEqual(FB.skyboxFile(undefined, true), K2);
});
test('textures: both sky files exist with the exact sizes the memory claim rests on (4096x2048 original untouched, 2048x1024 reduced)', () => {
  assertEqual(pngSize(path.join(PUB, 'textures/skyboxes/day.png')).join('x'), '4096x2048'); assertEqual(pngSize(path.join(PUB, 'textures/skyboxes/day_2k.png')).join('x'), '2048x1024');
  for (const f of Object.values(FB.SKYBOX_FILES)) assert(fs.existsSync(path.join(PUB, f)), f + ' exists');
});
test('textures (static): client takes the sky from the tier helper and falls back to the original file if the reduced one is missing', () => {
  const i = CLIENT.indexOf('BBFeedback.skyboxFile'); assert(i > 0, 'uses skyboxFile'); const blk = CLIENT.slice(i - 100, i + 700);
  assert(/texLoader\.load\(skyUrl, onSky, undefined,/.test(blk) && /textures\/skyboxes\/day\.png', onSky/.test(blk), 'error fallback to day.png'); assert(!/texLoader\.load\('textures\/skyboxes\/day\.png', \(tex\)/.test(CLIENT), 'no hard-coded 4k load left');
});
