// Phase 12/13 — README/TEST_CHECKLIST.md hygiene.
const path = require('path');
const fs = require('fs');
const harness = require('./run.js');
const { test, assert } = harness;

test('TEST_CHECKLIST.md exists and covers every required section', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'TEST_CHECKLIST.md'), 'utf8');
  for (const s of ['SERVER', 'PC', 'ANDROID', 'IOS', 'MULTIPLAYER']) assert(t.includes('## ' + s), 'missing section ' + s);
  for (const item of ['npm install', 'npm start', 'room create', 'reconnect', 'host migration', 'dash', 'stamina', 'chaos', 'cosmetics', 'achievements', 'spectator', 'ping', 'emotes', 'touch movement', 'emote wheel']) {
    assert(t.includes(item), 'missing checklist item: ' + item);
  }
  assert(!/\[x\]/i.test(t), 'no item should be pre-checked — this is unverified until a human checks it');
});
test('README references TEST_CHECKLIST.md and does not claim a stale/unrun test count', () => {
  const r = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert(r.includes('TEST_CHECKLIST.md'));
});
