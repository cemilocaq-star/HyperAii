// Phase 5 — damage number logic (pure helpers) tests.
const path = require('path');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const { maxDamageNumbers, formatDamage, overflowCount } = require(path.join(__dirname, '..', 'public', 'feedback.js'));

test('damage numbers: cap scales with quality', () => {
  assertEqual(maxDamageNumbers('low', false), 3);
  assertEqual(maxDamageNumbers('medium', false), 6);
  assertEqual(maxDamageNumbers('high', false), 10);
});
test('damage numbers: mobile fallback halves the cap, never below 2', () => {
  assertEqual(maxDamageNumbers('high', true), 5);
  assertEqual(maxDamageNumbers('low', true), 2);
});
test('damage numbers: unknown quality falls back to medium', () => {
  assertEqual(maxDamageNumbers('ULTRA', false), 6);
});
test('damage numbers: format normal vs critical', () => {
  assertEqual(formatDamage(25, false), '25');
  assertEqual(formatDamage(50, true), '50!');
});
test('damage numbers: malformed/absurd values render nothing', () => {
  for (const bad of [0, -5, NaN, 'abc', undefined, null, 1e9]) assertEqual(formatDamage(bad, false), null, String(bad));
});
test('damage numbers: overflow evicts oldest so spam stays capped', () => {
  assertEqual(overflowCount(3, 6), 0);
  assertEqual(overflowCount(6, 6), 1);
  assertEqual(overflowCount(9, 6), 4);
});

const { ashesBudget } = require(path.join(__dirname, '..', 'public', 'feedback.js'));
test('ashes: Particle Quality picks the budget; touch drops one tier; unknown -> medium', () => {
  assertEqual(ashesBudget('high', false).flames, 8);
  assertEqual(ashesBudget('high', true).flames, ashesBudget('medium', false).flames, 'mobile high == desktop medium');
  assertEqual(ashesBudget('low', true).embers, ashesBudget('low', false).embers, 'cannot go below low');
  assertEqual(ashesBudget('???', false).embers, ashesBudget('medium', false).embers);
});
test('ashes: concurrency cap is bounded at every tier (chain kills cannot pile up)', () => {
  for (const q of ['low', 'medium', 'high']) for (const m of [true, false]) { const b = ashesBudget(q, m); assert(b.maxConcurrent >= 2 && b.maxConcurrent <= 5); }
});
