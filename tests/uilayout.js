// Phase 11 — UI layout contract.
// There is no browser in this environment, so this is NOT a visual test. It
// parses the real <style> block of public/index.html, resolves the HUD
// elements' geometry for a set of phone/tablet/desktop viewports (applying
// @media rules and the source-order cascade) and asserts: everything is on
// screen, nothing overlaps, the crosshair area is clear, and touch targets
// are big enough. Content-sized elements use the size assumptions below.
const path = require('path');
const fs = require('fs');
const harness = require('./run.js');
const { test, assert, assertEqual } = harness;
const { wheelGeometry } = require(path.join(__dirname, '..', 'public', 'feedback.js'));

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '');

// ---- tiny CSS parser: rules + one level of @media ----
function parseBlock(text, media, out) {
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i); if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith('@media')) parseBlock(body, head.slice(6).trim(), out);
    else if (head.startsWith('@')) { /* keyframes / supports: not geometry */ }
    else {
      const decls = {};
      for (const d of body.split(';')) { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).replace(/!important/, '').trim(); }
      out.push({ selectors: head.split(',').map((x) => x.trim()), decls, media });
    }
    i = j;
  }
  return out;
}
const RULES = parseBlock(css, null, []);

function mediaMatches(q, vp) {
  if (!q) return true;
  return q.split(/\s+and\s+/).every((c) => {
    c = c.trim();
    let m;
    if ((m = c.match(/^\(max-width:\s*(\d+)px\)$/))) return vp.w <= +m[1];
    if ((m = c.match(/^\(min-width:\s*(\d+)px\)$/))) return vp.w >= +m[1];
    if ((m = c.match(/^\(max-height:\s*(\d+)px\)$/))) return vp.h <= +m[1];
    if (c === '(orientation: landscape)' || c === '(orientation:landscape)') return vp.w > vp.h;
    if (c === '(pointer:coarse)') return vp.coarse;
    return false; // reduced-motion etc.: not applied
  });
}
function styleFor(sel, vp) {
  const out = {};
  for (const r of RULES) if (r.selectors.includes(sel) && mediaMatches(r.media, vp)) Object.assign(out, r.decls);
  return out;
}
function px(v, vp, axis) {
  if (v === undefined || v === 'auto') return null;
  let m;
  if ((m = v.match(/^min\((.+),(.+)\)$/))) return Math.min(px(m[1].trim(), vp, axis), px(m[2].trim(), vp, axis));
  if ((m = v.match(/^(-?[\d.]+)px$/))) return +m[1];
  if ((m = v.match(/^(-?[\d.]+)vw$/))) return vp.w * m[1] / 100;
  if ((m = v.match(/^(-?[\d.]+)vh$/))) return vp.h * m[1] / 100;
  if (v === '0') return 0;
  throw new Error('unsupported value in layout test: ' + v);
}

// content-sized elements: worst-case assumptions (documented, not measured)
// (scoreboard has an explicit width + ellipsis in CSS, so it is not an assumption)
const ASSUME = { spectateLabel: { w: 130, h: 36 } };

function rectOf(id, vp, spectating) {
  const st = styleFor('#' + id, vp);
  if (spectating && ['dashBtn', 'emoteBtn', 'interactBtn'].includes(id)) return null; // body.spectating hides them
  let w = px(st.width, vp), h = px(st.height, vp);
  if (w === null) w = ASSUME[id] ? ASSUME[id].w : null;
  if (h === null) h = st['max-height'] ? px(st['max-height'], vp) : (ASSUME[id] ? ASSUME[id].h : null);
  if (w === null || h === null) throw new Error(`no size for #${id} @${vp.w}x${vp.h}`);
  const l = px(st.left, vp), r = px(st.right, vp), t = px(st.top, vp), b = px(st.bottom, vp);
  const x = l !== null ? l : vp.w - r - w;
  const y = t !== null ? t : vp.h - b - h;
  return { id, x, y, w, h };
}
function overlaps(a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; }

const VIEWPORTS = [[320, 568], [360, 640], [390, 844], [412, 915], [667, 375], [844, 390], [768, 1024], [1280, 800], [1920, 1080]];
const HUD = ['scoreboard', 'pingBadge', 'killfeed', 'health', 'dashBtn', 'emoteBtn', 'interactBtn'];

for (const [w, h] of VIEWPORTS) for (const coarse of [false, true]) {
  const vp = { w, h, coarse };
  const tag = `${w}x${h}${coarse ? ' touch' : ''}`;

  test(`ui layout ${tag}: HUD elements are on-screen and never overlap each other or the crosshair`, () => {
    const rects = HUD.map((id) => rectOf(id, vp, false));
    for (const r of rects) assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, `#${r.id} off-screen: ${JSON.stringify(r)}`);
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++)
      assert(!overlaps(rects[i], rects[j]), `#${rects[i].id} overlaps #${rects[j].id} @${tag}: ${JSON.stringify(rects[i])} vs ${JSON.stringify(rects[j])}`);
    const cross = { id: 'crosshair', x: w / 2 - 24, y: h / 2 - 24, w: 48, h: 48 };
    for (const r of rects) assert(!overlaps(r, cross), `#${r.id} covers the crosshair area @${tag}`);
  });

  test(`ui layout ${tag}: spectator UI does not collide with the HUD that stays visible`, () => {
    const keep = ['scoreboard', 'pingBadge', 'killfeed', 'health'].map((id) => rectOf(id, vp, true));
    const padTop = px(styleFor('#spectateOverlay', vp)['padding-top'], vp);
    const nameFont = Math.min(26, Math.max(18, w * 0.06));
    const label = { id: 'spectateLabel', x: (w - 130) / 2, y: padTop, w: 130, h: 36 };
    const nameH = Math.ceil(nameFont * 1.25);
    const name = { id: 'spectateTargetName', x: (w - Math.min(w * 0.92, 320)) / 2, y: padTop + 36 + 10, w: Math.min(w * 0.92, 320), h: nameH };
    const hint = { id: 'spectateRespawnHint', x: (w - 160) / 2, y: name.y + nameH + 6, w: 160, h: 18 };
    const cb = px(styleFor('#spectateControls', vp).bottom, vp);
    const controls = { id: 'spectateControls', x: (w - 232) / 2, y: h - cb - 50, w: 232, h: 50 };
    const mine = [label, name, hint, controls];
    for (const r of mine) assert(r.x >= 0 && r.y >= 0 && r.x + r.w <= w && r.y + r.h <= h, `#${r.id} off-screen @${tag}: ${JSON.stringify(r)}`);
    for (const a of mine) for (const b of keep) assert(!overlaps(a, b), `#${a.id} overlaps #${b.id} @${tag}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) assert(!overlaps(mine[i], mine[j]), `#${mine[i].id} overlaps #${mine[j].id} @${tag}`);
  });
}

test('ui layout: touch targets — round action buttons >= 52px, dash >= 72px, coarse-pointer dash >= 80px', () => {
  for (const [w, h] of VIEWPORTS) {
    const fine = { w, h, coarse: false }, touch = { w, h, coarse: true };
    assert(rectOf('emoteBtn', fine).w >= 52 && rectOf('interactBtn', fine).w >= 52);
    assert(rectOf('dashBtn', fine).w >= 72 && rectOf('dashBtn', touch).w >= 80);
  }
});

test('ui layout: big centre text is width-limited so long strings cannot overflow a phone', () => {
  for (const id of ['chaosBanner', 'punchtext', 'trollmsg', 'spectateTargetName']) {
    const st = styleFor('#' + id, { w: 320, h: 568, coarse: false });
    assert(st['max-width'] && px(st['max-width'], { w: 320, h: 568 }) <= 320 * 0.92 + 0.01, `#${id} needs max-width <= 92vw`);
  }
  const fs = styleFor('#chaosBanner', { w: 320, h: 568 })['font-size'];
  assert(/^clamp\(/.test(fs), 'banner font must scale: ' + fs);
});

test('ui polish: design tokens, shared glass style, reduced-motion and safe-area support exist', () => {
  for (const tok of ['--bb-accent', '--bb-glass', '--bb-line', '--bb-ok', '--bb-bad']) assert(css.includes(tok + ':'), 'missing token ' + tok);
  const glass = RULES.find((r) => r.selectors.includes('#scoreboard') && r.selectors.includes('#pingBadge') && r.selectors.includes('.spectateBtn'));
  assert(glass, 'HUD chips + spectator buttons share one glass rule');
  assert(/prefers-reduced-motion:\s*reduce/.test(css), 'reduced-motion media query');
  assert(/safe-area-inset-bottom/.test(css), 'safe-area padding for notched phones');
  assert(/body\.spectating #dashBtn/.test(css), 'action buttons hidden while spectating');
});

test('ui layout: emote wheel — items stay on-screen and never overlap neighbours (viewports x 1..16 emotes)', () => {
  for (const [w, h] of VIEWPORTS) for (let n = 1; n <= 16; n++) {
    const { R, size } = wheelGeometry(w, h, n);
    assert(R + size / 2 <= Math.min(w, h) / 2 + 0.5, `ring leaves the screen @${w}x${h} n=${n}`);
    if (n > 1) assert(2 * R * Math.sin(Math.PI / n) >= size - 0.5, `neighbours overlap @${w}x${h} n=${n} (size ${size}, R ${R})`);
    if (n <= 10 && Math.min(w, h) >= 360) assert(size >= 44, `wheel item too small to tap @${w}x${h} n=${n}: ${size}`);
  }
});

test('ui layout (Phase 16): chat/react buttons stack in the right-side column without overlapping the interact button', () => {
  const rule = (sel) => { const out = {}; for (const r of RULES) if (r.selectors.includes(sel) && !r.media) Object.assign(out, r.decls); return { decls: out }; };
  const stack = ['interactBtn', 'chatBtn', 'reactBtn'].map((id) => {
    const r = rule('#' + id);
    const bottom = px(r.decls.bottom, { w: 400, h: 800 });
    const height = px(r.decls.height, { w: 400, h: 800 });
    return { id, bottom, top: bottom + height };
  });
  stack.sort((a, b) => a.bottom - b.bottom);
  for (let i = 0; i < stack.length - 1; i++) assert(stack[i].top <= stack[i + 1].bottom, `${stack[i].id} overlaps ${stack[i + 1].id}: ${JSON.stringify(stack[i])} vs ${JSON.stringify(stack[i + 1])}`);
});

test('social (Phase 16): every quick-chat and reaction preset key on the client matches the server registry exactly', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const T = require(path.join(__dirname, '..', 'server.js')).__test__;
  const chatBlock = html.slice(html.indexOf('const QUICK_CHAT_ITEMS'), html.indexOf('const REACTION_ITEMS'));
  const reactBlock = html.slice(html.indexOf('const REACTION_ITEMS'), html.indexOf('function buildPanel'));
  for (const key of Object.keys(T.QUICK_CHAT_PRESETS)) assert(chatBlock.includes(`'${key}'`), 'client missing quick-chat key ' + key);
  for (const key of Object.keys(T.REACTION_PRESETS)) assert(reactBlock.includes(`'${key}'`), 'client missing reaction key ' + key);
});

test('ui layout (Phase 21): joystick (left) never overlaps dash/action buttons (right column)', () => {
  const rule = (sel) => { const out = {}; for (const r of RULES) if (r.selectors.includes(sel) && !r.media) Object.assign(out, r.decls); return out; };
  const vp = { w: 400, h: 800 };
  const joy = rule('#moveJoystick');
  const jw = px(joy.width, vp), jl = px(joy.left, vp);
  assert(jw && jl !== null, 'joystick must have explicit left/width');
  const dash = rule('#dashBtn');
  const dr = px(dash.right, vp), dw = px(dash.width, vp);
  assert(jl + jw < vp.w - dr - dw, 'joystick (left column) must not reach into the dash button (right column)');
});
