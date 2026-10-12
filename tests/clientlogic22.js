// Phase 22 — client-side LOGIC checks for server-owned pickups and the
// badge/title nameplate. There is no browser here: the real function sources
// are cut out of public/index.html and executed against tiny THREE/DOM stubs.
// This proves the data flow (server list -> objects, state msgs, badge glyph
// reaching the canvas text). It does NOT prove real rendering, 3D appearance,
// touch/mouse feel or audio — those stay NOT VERIFIED.
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in index.html`);
  let i = html.indexOf('{', start), depth = 0;
  for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}') { depth--; if (!depth) { i++; break; } } }
  return html.slice(start, i);
}

function makeSandbox() {
  const drawn = [];
  const removed = [];
  class Obj { constructor() { this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }; this.userData = {}; this.visible = true; this.geometry = { dispose() { removed.push('geo'); } }; this.material = { dispose() { removed.push('mat'); }, map: { dispose() {} } }; this.children = []; }
    add(c) { this.children.push(c); } remove(c) { this.children = this.children.filter((x) => x !== c); } }
  const scene = { added: [], add(o) { this.added.push(o); }, remove(o) { this.added = this.added.filter((x) => x !== o); } };
  const THREE = {
    Mesh: Obj, Sprite: class extends Obj { constructor(m) { super(); this.material = m; this.scale = { set() {} }; } },
    SphereGeometry: class {}, MeshStandardMaterial: class { dispose() { removed.push('mat'); } },
    CanvasTexture: class { constructor(c) { this.c = c; } dispose() {} },
    SpriteMaterial: class { constructor(o) { Object.assign(this, o); } dispose() {} },
  };
  const document = { createElement() { return { width: 0, height: 0, getContext() { return { fillText: (t, x, y) => drawn.push(t), set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set shadowColor(v) {}, set shadowBlur(v) {} }; } }; } };
  const ctx = { THREE, scene, document, trollPickups: [], remotePlayers: {}, console };
  vm.createContext(ctx);
  ctx.__drawn = drawn; ctx.__removed = removed;
  for (const fn of ['applyServerPickups', 'applyPickupState', 'nameplateCanvas', 'attachNameplate']) vm.runInContext(extractFunction(fn), ctx);
  return ctx;
}

test('p22 client: applyServerPickups builds one object per SERVER pickup (id, position, active) and ignores malformed entries', () => {
  const c = makeSandbox();
  vm.runInContext(`applyServerPickups([{id:'pk0',x:3,z:-4,active:true},{id:'pk1',x:-8,z:9,active:false},{id:5,x:1,z:1},null,{id:'bad',x:'a',z:1},'x'])`, c);
  const balls = vm.runInContext('trollPickups', c);
  assertEqual(balls.length, 2);
  assertEqual(balls[0].userData.id, 'pk0'); assertEqual(balls[0].position.x, 3); assertEqual(balls[0].position.z, -4); assertEqual(balls[0].visible, true);
  assertEqual(balls[1].userData.id, 'pk1'); assertEqual(balls[1].visible, false, 'a taken pickup is hidden from the start (reconnect case)');
});

test('p22 client: re-applying the list (rejoin) replaces objects and disposes the old ones — no duplicates', () => {
  const c = makeSandbox();
  vm.runInContext(`applyServerPickups([{id:'pk0',x:0,z:0,active:true},{id:'pk1',x:1,z:1,active:true}])`, c);
  vm.runInContext(`applyServerPickups([{id:'pk0',x:0,z:0,active:true},{id:'pk1',x:1,z:1,active:true}])`, c);
  assertEqual(vm.runInContext('trollPickups.length', c), 2);
  assertEqual(vm.runInContext('scene.added.length', c), 2, 'scene must not accumulate stale pickups');
  assert(c.__removed.length >= 4, 'old geometry/material must be disposed');
});

test('p22 client: pickup_state hides / moves / shows the matching pickup only; unknown id is a no-op', () => {
  const c = makeSandbox();
  vm.runInContext(`applyServerPickups([{id:'pk0',x:0,z:0,active:true},{id:'pk1',x:1,z:1,active:true}])`, c);
  vm.runInContext(`applyPickupState({id:'pk0',active:false,x:0,z:0})`, c);
  vm.runInContext(`applyPickupState({id:'nope',active:false})`, c);
  let b = vm.runInContext('trollPickups', c);
  assertEqual(b[0].visible, false); assertEqual(b[1].visible, true);
  vm.runInContext(`applyPickupState({id:'pk0',active:true,x:12,z:-7})`, c);
  b = vm.runInContext('trollPickups', c);
  assertEqual(b[0].visible, true); assertEqual(b[0].position.x, 12); assertEqual(b[0].position.z, -7);
});

test('p22 client: nameplate draws title, badge glyph and name from the (server-validated) values it is given', () => {
  const c = makeSandbox();
  vm.runInContext(`remotePlayers.p1 = { mesh: new THREE.Mesh(), nameSprite: null }; attachNameplate('p1', 'Alex', 'Yol Silindirçisi', '🏆');`, c);
  const text = c.__drawn.join(' | ');
  assert(text.includes('Yol Silindirçisi'), 'title drawn: ' + text);
  assert(text.includes('🏆 Alex'), 'badge glyph + name drawn: ' + text);
  const sig = vm.runInContext(`remotePlayers.p1.nameSig`, c);
  assertEqual(sig, 'Alex|Yol Silindirçisi|🏆', 'signature includes the badge so a badge change rebuilds the plate');
});

test('p22 client: nameplate with no badge/title draws just the name (no "null"/"undefined" text)', () => {
  const c = makeSandbox();
  vm.runInContext(`remotePlayers.p2 = { mesh: new THREE.Mesh(), nameSprite: null }; attachNameplate('p2', 'Sam', null, null);`, c);
  const text = c.__drawn.join(' | ');
  assert(text.includes('Sam') && !/null|undefined/.test(text), text);
});

test('p22 client source contract: no client-invented pickup positions, no client damage in hit, hit carries aim, pickup sends pickupId only', () => {
  assert(!/type:\s*'hit',\s*targetId,\s*damage/.test(html), 'client must not send damage in hit');
  const onShoot = html.slice(html.indexOf('function onShoot('), html.indexOf('function triggerRecoil('));
  const iShoot = onShoot.indexOf("type: 'shoot'"), iHit = onShoot.indexOf("type: 'hit'");
  assert(iShoot > 0 && iHit > 0 && iShoot < iHit, 'shoot (intent) must be sent BEFORE hit (claim)');
  assert(/type: 'hit', targetId, origin: aimOrigin, dir: aimDir/.test(onShoot) && /type: 'shoot', origin: aimOrigin, dir: aimDir/.test(onShoot), 'hit and shoot must carry the SAME aim values');
  assert(!/damage|crit|kill|health/.test(onShoot.slice(iHit, iHit + 200)), 'hit packet must not carry result fields');
  assert(/type:'troll_pickup',\s*pickupId:\s*ball\.userData\.id/.test(html), 'troll_pickup must send pickupId');
  assert(!/troll_pickup[^\n]*targetId/.test(html), 'troll_pickup must not send a client-chosen targetId');
  assert(!/ball\.position\.set\(\(Math\.random\(\)-0\.5\)\*50/.test(html), 'client must not invent pickup positions any more');
  assert(/msg\.type === 'pickup_state'/.test(html) && /applyServerPickups\(msg\.pickups\)/.test(html), 'handlers for game_started.pickups / pickup_state are wired');
});

test('p22 client: an in-page reconnect (game_started while gameStarted) refreshes pickups but never rebuilds scene/renderer/animate loop', () => {
  const i = html.indexOf("msg.type === 'game_started'");
  const block = html.slice(i, html.indexOf("msg.type === 'pickup_state'", i));
  const iGuard = block.indexOf('if (gameStarted)'), iStart = block.indexOf('startGame(msg.map, msg.mapSeed)'); // the call now also carries the server's map seed; the guard ordering is what this test pins
  assert(iGuard > 0 && iStart > iGuard, 'startGame must only be reachable when the game is NOT already started');
  assert(/if \(gameStarted\) \{[\s\S]*?applyServerPickups\(msg\.pickups\)[\s\S]*?\} else \{/.test(block), 'reconnect branch must re-apply server pickups');
  assert(!/if \(gameStarted\) \{[^}]*startGame\(/.test(block), 'reconnect branch must not call startGame');
});

// ---------------------------------------------------------------------------------------------
// Static client audit (real execution: vm.Script compiles every JS file; regex checks on markup)
// ---------------------------------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('p22 static: every JS file compiles (syntax) — server.js, main.js, public/*.js and the inline script of index.html', () => {
  for (const f of ['server.js', 'main.js', 'public/settings.js', 'public/feedback.js', 'public/animstate.js']) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*\n/, '');
    try { new vm.Script(`(function (exports, require, module, __filename, __dirname) {${code}\n})`, { filename: f }); }
    catch (e) { throw new Error(`${f}: ${e.message}`); }
  }
  assertEqual(inlineScripts.length, 1, 'expected exactly one inline <script> in index.html');
  try { new vm.Script(inlineScripts[0], { filename: 'index.html(inline)' }); } catch (e) { throw new Error('index.html inline script: ' + e.message); }
});

test('p22 static: no duplicate static element ids in index.html; every getElementById target exists', () => {
  const markup = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  const ids = [...markup.matchAll(/\bid="([^"$]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assertEqual([...new Set(dup)].join(','), '', 'duplicate ids: ' + dup.join(','));
  const jsAll = inlineScripts.join('\n') + '\n' + ['settings.js', 'feedback.js', 'animstate.js'].map((f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
  const created = new Set([...jsAll.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]));
  const wanted = [...new Set([...jsAll.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  const missing = wanted.filter((id) => !ids.includes(id) && !created.has(id));
  assertEqual(missing.join(','), '', 'getElementById targets that exist nowhere: ' + missing.join(','));
});

test('p22 static: every inline onclick="fn(...)" handler is a defined function', () => {
  const fns = new Set([...inlineScripts[0].matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const used = [...new Set([...html.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))];
  const undef = used.filter((f) => !fns.has(f));
  assertEqual(undef.join(','), '', 'onclick handlers with no function: ' + undef.join(','));
});

test('p22 static: classes toggled from JS have CSS (no markup-without-style silent failure)', () => {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join(' ');
  const cssClasses = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
  const js = inlineScripts.join('\n');
  const toggled = [...new Set([...js.matchAll(/classList\.(?:add|toggle|remove)\('([^']+)'/g)].map((m) => m[1]))];
  const noCss = toggled.filter((c) => !cssClasses.has(c));
  assertEqual(noCss.join(','), '', 'classes toggled in JS but not styled: ' + noCss.join(','));
});

test('p22 static: listeners are not stacked on rebuild — startGame() is only reachable once (guard) and its named listeners are re-add-safe', () => {
  const start = extractFunction('startGame');
  assert(/document\.addEventListener\('mousemove', onMouseMove\)/.test(start) && /document\.addEventListener\('mousedown', onShoot\)/.test(start), 'named listeners expected');
  assert(!/addEventListener\('(mousemove|mousedown)',\s*(\(|function)/.test(start), 'anonymous document listeners in startGame would stack');
  // the only call site of startGame() must sit in the branch that runs when the game is NOT started
  const code = inlineScripts[0].replace(/\/\/.*$/gm, ''); // ignore comments that merely mention startGame()
  const calls = [...code.matchAll(/startGame\(/g)].length; // definition + one call
  assertEqual(calls, 2, 'unexpected extra startGame() call site');
});

test('p22 static: lobby cards escape player names (escHtml) instead of trusting the server strip alone', () => {
  const card = html.slice(html.indexOf("card.className = 'playercard'"), html.indexOf("list.appendChild(card)", html.indexOf("card.className = 'playercard'")));
  assert(!/\$\{p\.name\}/.test(card), 'raw ${p.name} inside innerHTML');
  assert(/escHtml\(p\.name\)/.test(card), 'escHtml(p.name) expected');
  const ctx = vm.createContext({}); vm.runInContext(extractFunction('escHtml'), ctx);
  assertEqual(vm.runInContext(`escHtml('<img src=x onerror=alert(1)>&"\\'')`, ctx), '&lt;img src=x onerror=alert(1)&gt;&amp;&quot;&#39;');
  assertEqual(vm.runInContext('escHtml(null)', ctx), ''); assertEqual(vm.runInContext('escHtml(0)', ctx), '0');
});

test('p22 static: nameplate title/badge come ONLY from the server catalog (never a raw cosmetic id, never innerHTML)', () => {
  const upd = html.slice(html.indexOf('function attachNameplate('), html.indexOf('function attachNameplate(') + 900);
  assert(!/innerHTML/.test(upd), 'nameplate must not use innerHTML');
  const stateLoop = html.slice(html.indexOf('const badgeIcon = (p.badge'), html.indexOf('const badgeIcon = (p.badge') + 700);
  assert(/cosmeticCatalog\[p\.title\]/.test(html) && /cosmeticCatalog\[p\.badge\]\.icon/.test(stateLoop), 'title/badge must be resolved through cosmeticCatalog');
  assert(/titleText/.test(stateLoop) || /attachNameplate\(id, p\.name, titleText, badgeIcon\)/.test(stateLoop), 'state loop passes resolved title/badge');
  assert(!/attachNameplate\(id, p\.name, p\.title\)/.test(html), 'raw p.title id must never be passed to the nameplate');
});
