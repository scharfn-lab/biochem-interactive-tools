// Tests for buffers.html. No dependencies — run with: node --test
//
// The page's inline script runs unmodified in a Node vm against a small DOM and
// canvas stub. Top-level const/let in that script are reachable through page.run().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'buffers.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const IDS = [...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

// ── DOM / canvas stubs ─────────────────────────────────────────
function makeContext2D() {
  const calls = [];
  return new Proxy({ calls }, {
    get: (t, k) => (k in t ? t[k] : (...args) => { calls.push({ fn: k, args }); }),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

function makeTarget(id) {
  const classes = new Set();
  const listeners = {};
  const el = {
    id, value: '', textContent: '', innerHTML: '', className: '', hidden: false, disabled: false, style: {},
    attrs: {}, children: [], removed: false,
    rect: { left: 0, top: 0, width: 620, height: 400 },
    context: makeContext2D(),
    classList: {
      add: c => classes.add(c),
      remove: c => classes.delete(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c),
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(child) { this.children.push(child); return child; },
    remove() { this.removed = true; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    getContext() { return this.context; },
    getBoundingClientRect() { return this.rect; },
    fire(type, props = {}) {
      const e = { target: this, preventDefault() {}, ...props };
      for (const fn of listeners[type] || []) fn(e);
    },
  };
  return el;
}

function loadFreshPage({ reduceMotion = false } = {}) {
  const elements = new Map(IDS.map(id => [id, makeTarget(id)]));
  const document = makeTarget('document');
  document.getElementById = id => elements.get(id) ?? null;
  document.createElementNS = () => makeTarget('');
  document.createElement = () => makeTarget('');
  document.activeElement = null;
  let frames = 0;
  // Inputs start as the markup has them, like a browser
  for (const m of HTML.matchAll(/<input[^>]*\bid="([^"]+)"[^>]*\bvalue="([^"]*)"/g)) elements.get(m[1]).value = m[2];
  for (const [id, value] of [['conc-unit', 'mM'], ['vol-unit', 'mL'], ['add-vol-unit', 'mL']]) {
    elements.get(id).value = value;
  }
  const window = makeTarget('window');
  window.devicePixelRatio = 1;
  window.matchMedia = () => ({ matches: reduceMotion });
  const timers = [];
  const context = vm.createContext({
    document,
    window,
    requestAnimationFrame: () => { frames++; },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
  });
  vm.runInContext(SCRIPT, context);
  return {
    el: id => elements.get(id),
    timers,
    frames: () => frames,
    curve: elements.get('curve').context,
    run: code => vm.runInContext(code, context),
    pH() { return this.run('currentPH()'); },
    text: id => elements.get(id).textContent,
    setUnits(id, value) { elements.get(id).value = value; elements.get(id).fire('change', {}); },
    enter(id, value) { const e = elements.get(id); e.value = String(value); e.fire('change'); },
    click: id => elements.get(id).fire('click'),
  };
}

function loadPage(options) {
  const page = loadFreshPage(options);
  page.run('setVolume(0.05); shownFraction = targetFraction(); placeLiquid()');
  page.el('stock-input').value = '1';
  page.el('add-vol-input').value = '0.5';
  page.setUnits('vol-unit', 'mL');
  return page;
}

function assertClose(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ± ${tol}, got ${actual}`);
}

// ── Page wiring ────────────────────────────────────────────────
test('every id the script looks up exists in the markup', () => {
  const used = [...SCRIPT.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(used.length > 0);
  for (const id of used) assert.ok(IDS.includes(id), `missing element #${id}`);
  for (const m of SCRIPT.matchAll(/(?:setText|setInput|showError)\('([^']+)'/g)) assert.ok(IDS.includes(m[1]), `missing #${m[1]}`);
});

test('the page is one offline file with no outside resources', () => {
  assert.doesNotMatch(HTML, /<link\b|<script[^>]+src=|<img\b|fetch\(|https?:\/\/(?!www\.w3\.org)/);
});

// ── Your test cases ────────────────────────────────────────────
test('50 mM acetate at pH 4.76 has [HA] = [A⁻] = 25 mM', () => {
  const page = loadPage();
  page.run("setBuffer('acetate')");
  assert.equal(page.text('readout-acid-conc'), '25 mM');
  assert.equal(page.text('readout-base-conc'), '25 mM');
  assertClose(page.run('composition().ratio'), 1, 1e-9, 'ratio');
  assertClose(page.run('composition().acidMoles'), 0.00125, 1e-9, 'moles of HA');
});

test('0.5 mL of 1 M HCl into 50 mL of that buffer gives pH 4.39 by exact solve', () => {
  // 1.25 + 0.5 mmol acid form and 1.25 − 0.5 mmol base form: 4.76 + log(0.75/1.75) = 4.392
  const page = loadPage();
  page.run("setBuffer('acetate')");
  page.click('add-button');
  assertClose(page.pH(), 4.392, 0.002, 'pH');
  assert.equal(page.el('vol-input').value, '50.5');
});

test('0.25 mL of 1 M HCl gives the pH 4.58 from the specification', () => {
  const page = loadPage();
  page.run("setBuffer('acetate')");
  page.enter('add-vol-input', 0.25);
  page.click('add-button');
  assertClose(page.pH(), 4.58, 0.005, 'pH');
});

const CONTAINERS = [
  [0.1, 'micro'], [1.5, 'micro'], [1.51, 'conical15'], [15, 'conical15'], [15.1, 'conical50'], [50, 'conical50'],
  [50.1, 'beaker'], [250, 'beaker'], [251, 'flask1'], [1000, 'flask1'], [1001, 'flask2'], [2000, 'flask2'],
];
for (const [mL, key] of CONTAINERS) {
  test(`${mL} mL goes in the ${key} container`, () => {
    const page = loadPage();
    assert.equal(page.run(`setVolume(${mL / 1000})`), null);
    assert.equal(page.run('shownVessel.key'), key);
    assert.equal(page.text('vessel-label'), page.run('shownVessel.label'));
  });
}

test('Tris names its forms TrisH⁺ and Tris, with no HA or A⁻ anywhere', () => {
  const page = loadPage();
  page.run("setBuffer('tris')");
  assert.equal(page.text('forms-label'), 'Acid form: TrisH⁺, Base form: Tris');
  assert.doesNotMatch(page.text('forms-label'), /HA|A⁻/);
  assert.ok(page.el('legend-acid').innerHTML.includes('TrisH⁺'));
  assert.ok(page.el('legend-base').innerHTML.includes('–NH₂'));
  for (const id of ['legend-acid', 'legend-base']) assert.doesNotMatch(page.el(id).innerHTML, /HA|A⁻/, id);
});

test('Tris obeys the same charge balance with a neutral base form', () => {
  const page = loadPage();
  page.run("setBuffer('tris')");
  assertClose(page.pH(), 8.07, 1e-6, 'starts at pKa');
  page.click('add-button');
  // 1.25 + 0.5 mmol TrisH⁺ over 0.75 mmol Tris
  assertClose(page.pH(), 8.07 + Math.log10(0.75 / 1.75), 0.002, 'after HCl');
});

test('a unit change keeps the amounts and relabels them', () => {
  const page = loadPage();
  page.setUnits('conc-unit', 'M');
  assert.equal(page.text('readout-acid-conc'), '0.025 M');
  assert.equal(page.el('conc-input').value, '0.05');
  page.setUnits('vol-unit', 'L');
  assert.equal(page.el('vol-input').value, '0.05');
  page.setUnits('vol-unit', 'µL');
  assert.equal(page.el('vol-input').value, '50000');
  assertClose(page.run('state.volume'), 0.05, 1e-12, 'volume unchanged');
  assertClose(page.run('state.totalMoles'), 0.0025, 1e-12, 'moles unchanged');
});

test('values typed in a unit are read in that unit', () => {
  const page = loadPage();
  page.setUnits('vol-unit', 'µL');
  page.enter('vol-input', 500);
  assertClose(page.run('state.volume'), 5e-4, 1e-12, 'µL');
  page.setUnits('conc-unit', 'M');
  page.enter('conc-input', 0.2);
  assertClose(page.run('totalConc()'), 0.2, 1e-12, 'M');
  page.enter('add-vol-input', 10);
  page.setUnits('add-vol-unit', 'µL');
  page.click('add-button');
  assertClose(page.run('state.volume'), 5.1e-4, 1e-12, 'added µL');
});

test('overshooting the buffer gives the true strong acid pH', () => {
  const page = loadPage();
  page.run("setBuffer('acetate')");
  page.enter('add-vol-input', 10);
  page.click('add-button');
  // 10 mmol H⁺ against 1.25 mmol of A⁻ in 60 mL: about 0.146 M H⁺, plus a little from HA
  assertClose(page.pH(), -Math.log10(8.75e-3 / 0.06), 0.01, 'pH');
  assert.match(page.text('status'), /^Poor buffering: pH is \d+\.\d\d units from pKa$/);
});

test('overshooting with base gives the true strong base pH', () => {
  const page = loadPage();
  page.run("setBuffer('acetate')");
  page.click('reagent-naoh');
  page.enter('add-vol-input', 10);
  page.click('add-button');
  assertClose(page.pH(), 14 + Math.log10(8.75e-3 / 0.06), 0.01, 'pH');
});

// ── Exact solver ───────────────────────────────────────────────
test('the solver satisfies the charge balance across every extreme', () => {
  const page = loadPage();
  for (const [S, C, pKa] of [[0.1, 0.05, 4.76], [-1, 0.05, 4.76], [0, 1e-7, 7], [10, 1, 8.07], [-10, 1, 8.07], [2e-5, 1e-6, 6.1]]) {
    const Ka = 10 ** -pKa;
    const H = page.run(`solveH(${S}, ${C}, ${Ka})`);
    const residual = H + S - 1e-14 / H - C * Ka / (Ka + H);
    assert.ok(Math.abs(residual) < 1e-9 * Math.max(1, Math.abs(S), C), `S=${S}, C=${C}: residual ${residual}`);
  }
});

test('at moderate pH the exact solver matches Henderson–Hasselbalch', () => {
  const page = loadPage();
  for (const pH of [3.76, 4.0, 4.76, 5.5, 5.76]) {
    page.enter('ph-input', pH);
    assertClose(page.pH(), pH, 1e-9, `pH ${pH}`);
    assertClose(page.run('Math.log10(composition().ratio)'), pH - 4.76, 1e-9, 'ratio');
  }
});

test('setting the pH round-trips at the ends of the scale', () => {
  const page = loadPage();
  for (const pH of [0, 1, 7, 13, 14]) {
    assert.equal(page.run(`setPH(${pH})`), null);
    assertClose(page.pH(), pH, 1e-9, `pH ${pH}`);
  }
  assert.ok(page.run('setPH(15)'));
  assert.ok(page.run('setPH(-1)'));
});

test('water alone adds neither acid nor base at very high dilution', () => {
  const page = loadPage();
  page.run('setConcentration(1e-9)');
  page.run('setPH(7)');
  assertClose(page.pH(), 7, 1e-6, 'pH');
});

// ── Controls ───────────────────────────────────────────────────
test('each buffer has its pKa and form labels', () => {
  const page = loadPage();
  for (const [key, pKa] of [['generic', 4.76], ['acetate', 4.76], ['mes', 6.15], ['mops', 7.2], ['hepes', 7.5], ['tris', 8.07], ['bicarbonate', 6.1]]) {
    page.run(`setBuffer('${key}')`);
    assert.equal(page.run('state.pKa'), pKa);
    assertClose(page.pH(), pKa, 1e-6, key);
    assert.match(page.text('forms-label'), /^Acid form: .+, Base form: .+$/);
    assert.ok(page.run(`Object.keys(BUFFERS).includes('${key}')`));
  }
});

test('bicarbonate carries the one-line note about blood pH', () => {
  const page = loadPage();
  assert.equal(page.el('buffer-note').hidden, true);
  page.run("setBuffer('bicarbonate')");
  assert.equal(page.el('buffer-note').hidden, false);
  assert.match(page.el('buffer-note').textContent, /Closed system.*pH 7\.4/);
  assert.doesNotMatch(page.el('buffer-note').textContent, /\n/);
});

test('the volume is held to 100 µL through 2 L', () => {
  const page = loadPage();
  assert.equal(page.run('setVolume(1e-4)'), null);
  assert.equal(page.run('setVolume(2)'), null);
  assert.ok(page.run('setVolume(9e-5)'));
  assert.ok(page.run('setVolume(2.1)'));
  assert.equal(page.run('sliderToVolume(0)'), 1e-4);
  assert.equal(page.run('sliderToVolume(1000)'), 2);
});

test('a batch of a different size keeps the concentration and pH', () => {
  const page = loadPage();
  page.enter('ph-input', 5);
  page.enter('vol-input', 200);
  assert.equal(page.el('conc-input').value, '50');
  assertClose(page.pH(), 5, 1e-9, 'pH');
  assertClose(page.run('state.totalMoles'), 0.01, 1e-12, 'moles');
});

test('invalid entries are refused with a message and change nothing', () => {
  const page = loadPage();
  const before = page.run('JSON.stringify([state.volume, state.totalMoles, state.netBase])');
  const cases = [
    ['conc-input', 0, 'buffer-error'], ['conc-input', 'abc', 'buffer-error'], ['vol-input', 5000, 'buffer-error'], ['ph-input', 20, 'buffer-error'],
  ];
  for (const [id, value, errorId] of cases) {
    page.enter(id, value);
    assert.notEqual(page.text(errorId), '', `${id}=${value}`);
    assert.equal(page.run('JSON.stringify([state.volume, state.totalMoles, state.netBase])'), before);
  }
  page.enter('add-vol-input', 0);
  page.click('add-button');
  assert.notEqual(page.text('add-error'), '');
  assert.equal(page.run('JSON.stringify([state.volume, state.totalMoles, state.netBase])'), before);
});

// ── History ────────────────────────────────────────────────────
test('additions are listed and Undo last restores each state in turn', () => {
  const page = loadPage();
  assert.equal(page.el('undo-button').disabled, true);
  page.click('add-button');
  const one = page.pH();
  page.click('reagent-naoh');
  page.click('add-button');
  page.click('add-button');
  assert.equal(page.run('state.history.length'), 3);
  assert.match(page.el('history').children.slice(-3)[0].textContent, /500 µL of 1 M HCl.*pH 4\.76 → 4\.39/);
  assert.equal(page.el('history-empty').hidden, true);
  page.click('undo-button');
  page.click('undo-button');
  assertClose(page.pH(), one, 1e-9, 'pH after two undos');
  assert.equal(page.el('vol-input').value, '50.5');
  page.click('undo-button');
  assertClose(page.pH(), 4.76, 1e-9, 'pH after three undos');
  assert.equal(page.el('undo-button').disabled, true);
});

test('a new recipe starts a new history', () => {
  for (const change of ['setPH(5)', 'setConcentration(0.1)', 'setVolume(0.1)', "setBuffer('mes')", 'setTemperature(10)']) {
    const page = loadPage();
    page.click('add-button');
    page.run(change);
    assert.equal(page.run('state.history.length'), 0, change);
  }
});

test('Reset returns to the starting amounts for the chosen buffer', () => {
  const page = loadPage();
  page.run("setBuffer('tris')");
  page.setUnits('conc-unit', 'M');
  page.setUnits('vol-unit', 'L');
  page.run('setTemperature(10)');
  page.click('add-button');
  page.click('reset');
  assertClose(page.pH(), 8.07, 1e-6, 'pH');
  assert.equal(page.el('conc-input').value, '50');
  assert.equal(page.el('vol-input').value, '500');
  assert.equal(page.run('state.temperature'), 25);
  assert.equal(page.el('temp-input').value, '25');
  assert.equal(page.run('state.history.length'), 0);
  assert.equal(page.run('state.buffer'), 'tris');
});

// ── Dilution ───────────────────────────────────────────────────
// ── Containers ─────────────────────────────────────────────────
test('the fill level is volume over capacity', () => {
  const page = loadPage();
  for (const [mL, fraction] of [[25, 0.5], [125, 0.5], [500, 0.5], [1500, 0.75], [0.75, 0.5]]) {
    page.run(`setVolume(${mL / 1000})`);
    assertClose(page.run('targetFraction()'), fraction, 1e-9, `${mL} mL`);
  }
});

test('every container has labeled graduations up to its capacity', () => {
  const page = loadPage();
  for (const v of page.run('VESSELS')) {
    assert.equal(v.marks.at(-1), v.capacity, v.key);
    const markup = page.run(`vesselMarkup(VESSELS.find(v => v.key === '${v.key}'))`);
    assert.equal([...markup.matchAll(/<line /g)].length, v.marks.length, v.key);
    assert.ok(markup.includes(`${v.capacity} mL`), v.key);
    assert.equal(v.profile.at(-1)[0], v.fillBottom, `${v.key} floor`);
  }
});

test('the level eases up over frames and the container swaps at a threshold', () => {
  const page = loadPage();
  assert.ok(page.frames() > 0, 'animation running');
  const start = page.run('shownFraction');
  page.run('setVolume(0.04)');
  page.run('animate()');
  const step = page.run('shownFraction');
  assert.ok(step < start && step > page.run('targetFraction()'), `${start} → ${step}`);
  page.run('setVolume(0.2)');
  assert.equal(page.run('shownVessel.key'), 'beaker');
  assert.ok(page.run('shownFraction') < page.run('targetFraction()'), 'rises from the old volume');
  assert.equal(page.el('vessel-body').classList.contains('swap'), true);
});

test('with reduced motion nothing animates and the level jumps', () => {
  const page = loadPage({ reduceMotion: true });
  assert.equal(page.frames(), 0);
  page.run('setVolume(0.2)');
  assert.equal(page.run('shownFraction'), page.run('targetFraction()'));
  assert.match(HTML, /prefers-reduced-motion: reduce/);
  const before = page.run('JSON.stringify(particles.map(p => [p.u, p.v]))');
  page.run('setPH(5)');
  assert.equal(page.run('JSON.stringify(particles.map(p => [p.u, p.v]))'), before);
});

// ── Particles ──────────────────────────────────────────────────
test('the default buffer shows 25 particles split as evenly as an odd count allows', () => {
  const page = loadPage();
  assert.equal(page.run('particles.length'), 25);
  assert.equal(page.run('particles.filter(p => p.isBase).length'), 13);
  assertClose(page.run('particleScale'), 1e-4, 1e-12, 'scale');
});

test('the count follows the moles and stays in bounds at every extreme', () => {
  const page = loadPage();
  for (const [conc, vol] of [[1e-3, 1e-4], [5, 2], [0.05, 0.05], [0.1, 2], [1e-3, 2], [2, 1e-4]]) {
    page.run(`setConcentration(${conc}); setVolume(${vol})`);
    const n = page.run('particles.length');
    assert.ok(n >= 10 && n <= 40, `${conc} M × ${vol} L: ${n}`);
    assertClose(n * page.run('particleScale'), page.run('state.totalMoles'), page.run('particleScale'), 'each particle is worth the scale');
  }
});

test('doubling the moles doubles the particles within a scale', () => {
  const page = loadPage();
  page.run('setVolume(0.02)');
  const n = page.run('particles.length');
  page.run('setVolume(0.04)');
  assert.equal(page.run('particles.length'), 2 * n);
});

test('the particle split follows the acid/base ratio', () => {
  const page = loadPage();
  page.enter('ph-input', 5.76);
  const fb = 10 / 11;
  assert.equal(page.run('particles.filter(p => p.isBase).length'), Math.round(25 * fb));
  page.enter('ph-input', 2);
  assert.equal(page.run('particles.filter(p => p.isBase).length'), 0);
  page.enter('ph-input', 12);
  assert.equal(page.run('particles.filter(p => !p.isBase).length'), 0);
});

test('adding acid or base flashes exactly the particles that converted', () => {
  const page = loadPage();
  page.click('add-button');
  const flashed = page.run("particles.filter(p => p.el.classList.contains('conv')).length");
  assert.equal(flashed, 13 - Math.round(25 * (0.75 / 2.5)));
  assert.equal(page.run('lastFlashed'), flashed);
  page.timers.at(-1)();
  assert.equal(page.run("particles.filter(p => p.el.classList.contains('conv')).length"), 0, 'clears afterward');
  page.run('setPH(7)');
  assert.equal(page.run('lastFlashed'), 0, 'setting the pH does not flash');
  assert.equal(page.run("particles.filter(p => p.el.classList.contains('conv')).length"), 0, 'no particle marked');
});

test('particles keep moving inside the liquid', () => {
  const page = loadPage();
  const start = page.run('JSON.stringify(particles.map(p => [p.u, p.v]))');
  for (let i = 0; i < 2000; i++) page.run('stepParticles()');
  assert.notEqual(page.run('JSON.stringify(particles.map(p => [p.u, p.v]))'), start);
  assert.ok(page.run('particles.every(p => Math.abs(p.u) <= 1 && p.v >= 0.03 && p.v <= 0.97)'));
});

test('the generic buffer draws dots; the others draw their own acid and base glyphs', () => {
  const page = loadPage();
  const generic = page.el('glyph-defs').innerHTML;
  assert.ok(generic.includes('fill="#C8102E"') && generic.includes('fill="#685C53"'));
  assert.doesNotMatch(generic, /<path/);
  const seen = new Set();
  for (const key of ['acetate', 'mes', 'mops', 'hepes', 'tris', 'bicarbonate']) {
    page.run(`setBuffer('${key}')`);
    const html = page.el('glyph-defs').innerHTML;
    assert.match(html, /id="glyph-acid".*<path.*id="glyph-base".*<path/, key);
    seen.add(page.run(`BUFFERS.${key}.core`));
    assert.ok(page.el('legend-acid').innerHTML.includes(page.run(`BUFFERS.${key}.acidSite`)), `${key} names the site`);
    assert.equal(page.run('particles.length'), 25);
  }
  assert.equal(seen.size, 6, 'each buffer has its own skeleton');
});

test('the anionic base forms carry a minus on the site and the neutral ones do not', () => {
  const page = loadPage();
  assert.ok(page.run("siteMarkup(BUFFERS.acetate, true)").includes('−'));
  assert.ok(!page.run("siteMarkup(BUFFERS.tris, true)").includes('−'));
  assert.ok(page.run("siteMarkup(BUFFERS.tris, false)").includes('>H<'));
});

// ── Titration curve ────────────────────────────────────────────
test('the curve runs through the pKa at half equivalence', () => {
  const page = loadPage();
  assertClose(page.run('curvePH(0.5)'), 4.76, 0.01, 'half equivalence');
  assert.ok(page.run('curvePH(0.1) < curvePH(0.5) && curvePH(0.5) < curvePH(0.9) && curvePH(0.9) < curvePH(1.1)'));
  assert.ok(page.curve.calls.some(c => c.fn === 'fillText' && c.args[0] === 'pKa = 4.76'));
  assert.ok(page.curve.calls.some(c => c.fn === 'setLineDash' && c.args[0].length === 2), 'dashed guides');
});

test('the current state always lies on the curve', () => {
  const page = loadPage();
  for (const action of ['0', "addStrong('HCl', 1, 0.0005)", "addStrong('NaOH', 1, 0.002)", 'setTemperature(10)', "addStrong('HCl', 5, 0.01)", 'setPH(9)']) {
    page.run(action);
    assertClose(page.run('curvePH(equivalents())'), page.pH(), 1e-9, action);
  }
});

test('the x axis holds 0 to 1.2 equivalents and extends past either end when overshot', () => {
  const page = loadPage();
  assert.deepEqual([page.run('curveRange().xMin'), page.run('curveRange().xMax')], [0, 1.2]);
  page.run("addStrong('HCl', 5, 0.002)");
  assert.ok(page.run('equivalents()') < 0);
  assert.ok(page.run('curveRange().xMin') < page.run('equivalents()'));
  page.run('reset()');
  page.run("addStrong('NaOH', 5, 0.01)");
  assert.ok(page.run('curveRange().xMax') > page.run('equivalents()') && page.run('equivalents()') > 1.2);
});

test('the y axis extends when strong acid pushes pH below zero', () => {
  const page = loadPage();
  page.run("addStrong('HCl', 12, 0.05)");
  assert.ok(page.pH() < 0, `pH ${page.pH()}`);
  assert.ok(page.run('curveRange().yMin') < page.pH());
});

test('hovering reads out equivalents and pH, and leaving clears it', () => {
  const page = loadPage();
  const curve = page.el('curve');
  curve.fire('pointermove', { clientX: 48 + (620 - 48 - 16) * (0.5 / 1.2) });
  assert.equal(page.text('curve-readout'), `Equivalents of OH⁻: 0.50, pH: ${page.run('curvePH(0.5)').toFixed(2)}`);
  curve.fire('pointerleave');
  assert.match(page.text('curve-readout'), /^Hover/);
  assert.equal(page.run('hoverEq'), null);
});

test('hover coordinates account for CSS scaling, and touch uses the same path', () => {
  const page = loadPage();
  const curve = page.el('curve');
  curve.rect = { left: 10, top: 0, width: 310, height: 200 };
  curve.fire('pointerdown', { clientX: 10 + (48 + (620 - 48 - 16) * (0.6 / 1.2)) / 2, pointerType: 'touch' });
  assert.match(page.text('curve-readout'), /^Equivalents of OH⁻: 0\.60/);
  curve.fire('pointermove', { clientX: 12 });
  assert.equal(page.run('hoverEq'), null, 'the margin is outside the plot');
  assert.match(HTML, /#curve \{[^}]*touch-action: pan-y/);
});

test('the shaded band is pKa ± 1 and moves with the buffer', () => {
  const page = loadPage();
  page.run("setBuffer('tris')");
  assert.ok(page.curve.calls.some(c => c.fn === 'fillText' && c.args[0] === 'pKa = 8.07'));
  assert.ok(page.curve.calls.some(c => c.fn === 'fillText' && /Buffering region/.test(c.args[0])));
});

// ── Readout ────────────────────────────────────────────────────
test('the status line reports good or poor buffering with the distance', () => {
  const page = loadPage();
  assert.equal(page.text('status'), 'Good buffering (within pKa ± 1)');
  assert.equal(page.el('status').className, 'good');
  page.enter('ph-input', 5.76);
  assert.equal(page.text('status'), 'Good buffering (within pKa ± 1)');
  page.enter('ph-input', 6.26);
  assert.equal(page.text('status'), 'Poor buffering: pH is 1.50 units from pKa');
  page.enter('ph-input', 7.26);
  assert.equal(page.text('status'), 'Poor buffering: pH is 2.50 units from pKa');
  assert.equal(page.el('status').className, 'poor');
});

test('moles use the fitting unit', () => {
  const page = loadPage();
  assert.equal(page.run('formatMoles(2)'), '2 mol');
  assert.equal(page.run('formatMoles(0.0025)'), '2.5 mmol');
  assert.equal(page.run('formatMoles(2.5e-6)'), '2.5 µmol');
  assert.equal(page.run('formatMoles(2.5e-9)'), '2.5 nmol');
  assert.equal(page.run('formatVolume(0.0001)'), '100 µL');
  assert.equal(page.run('formatVolume(2)'), '2 L');
  assert.match(page.run('formatNumber(0.00012)'), /^1\.20 × 10⁻⁴$/);
});

test('curve labels sit clear of the curve', () => {
  const page = loadPage();
  const label = text => page.curve.calls.filter(c => c.fn === 'fillText' && c.args[0].startsWith(text)).at(-1).args;
  const y = pH => 16 + (14 - pH) / 14 * (400 - 16 - 44);
  assert.ok(label('pKa =')[2] > y(4.76), 'the pKa label is below its dot');
  assert.ok(label('Buffering')[1] < 100, 'the band label starts at the left, above the low end of the curve');
});

test('a touch reading stays after the finger lifts', () => {
  const page = loadPage();
  const curve = page.el('curve');
  curve.fire('pointerdown', { clientX: 300, pointerType: 'touch' });
  const reading = page.text('curve-readout');
  assert.match(reading, /^Equivalents/);
  curve.fire('pointerleave', { pointerType: 'touch' });
  assert.equal(page.text('curve-readout'), reading);
});

test('the curve canvas takes its displayed width and redraws on resize', () => {
  const page = loadPage();
  assert.equal(page.run('CW'), 620);
  page.el('curve').rect = { left: 0, top: 0, width: 330, height: 280 };
  page.run('sizeCurve()');
  assert.equal(page.run('CW'), 330);
  assert.equal(page.el('curve').width, 330);
  page.run('drawCurve()');
  assert.equal(page.run('curveRange().xMax'), 1.2);
});

test('volume marks draw above the particles', () => {
  assert.ok(HTML.indexOf('<g id="particles">') < HTML.indexOf('<g id="vessel-body">'));
});

// ── Solution panel layout ──────────────────────────────────────
test('Reset sits at the top of the page, above everything else', () => {
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('<h1>') < at('id="reset"') && at('id="reset"') < at('<div id="layout">'));
  assert.equal([...HTML.matchAll(/id="reset"/g)].length, 1);
});

test('the solution panel runs pH, buffering status, container, then legend', () => {
  const at = marker => {
    const i = HTML.indexOf(marker);
    assert.ok(i >= 0, marker);
    return i;
  };
  const order = ['<h2 class="panel-title">Solution', 'id="readout-ph"', 'id="status"', 'id="vessel-svg"', 'id="vessel-label"', 'id="particle-legend"', 'id="readout-acid-conc"', 'id="readout-base-conc"'];
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), order[i]);
});

test('the Readout box and the particle note are gone', () => {
  for (const id of ['readout', 'readout-ratio', 'readout-acid-mol', 'readout-base-mol', 'readout-total', 'readout-volume', 'particle-scale']) {
    assert.ok(!IDS.includes(id), id);
  }
  assert.doesNotMatch(HTML, />Readout</);
  assert.doesNotMatch(HTML, /crowding shows|Each particle ≈/);
});

test('every style rule has a selector and the status box keeps its style', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /#status \{[^}]*border: 2px solid/);
  // A declaration directly after a blank line means a selector went missing
  assert.doesNotMatch(css, /\n\s*\n\s+[a-z-]+: [^;{]+;\n/);
});

test('the legend gives each form with its concentration, in the chosen unit', () => {
  const page = loadPage();
  assert.ok(page.el('legend-acid').innerHTML.includes('HA'));
  assert.ok(page.el('legend-base').innerHTML.includes('A⁻'));
  assert.equal(page.text('readout-acid-conc'), '25 mM');
  assert.equal(page.text('readout-base-conc'), '25 mM');
  page.enter('ph-input', 5.76);
  assert.equal(page.text('readout-acid-conc'), '4.545 mM');
  assert.equal(page.text('readout-base-conc'), '45.45 mM');
  page.setUnits('conc-unit', 'M');
  assert.equal(page.text('readout-base-conc'), '0.04545 M');
});

test('the curve column is 20% narrower than before', () => {
  // The panel was 614 px wide at full size, so its 582 px canvas is now 466 px after 32 px of padding
  assert.match(HTML, /grid-template-columns: 330px minmax\(0, 340px\) minmax\(0, 498px\)/);
  assert.match(HTML, /#column-curve \{ max-width: 498px; \}/);
});

// ── Starting values ────────────────────────────────────────────
test('loads as a 50 mM, 500 mL generic buffer at pH = pKa, in the 1 L flask', () => {
  const page = loadFreshPage();
  assertClose(page.pH(), 4.76, 1e-6, 'pH');
  assert.equal(page.text('readout-ph'), '4.76');
  assert.equal(page.el('conc-input').value, '50');
  assert.equal(page.el('vol-input').value, '500');
  assertClose(page.run('state.volume'), 0.5, 1e-12, 'volume');
  assert.equal(page.run('shownVessel.key'), 'flask1');
  assert.equal(page.run('particles.length'), 25);
  assert.equal(page.run('state.temperature'), 25);
});

test('strong acid and base start at 5 M and 0.1 mL', () => {
  const page = loadFreshPage();
  assert.equal(page.el('stock-input').value, '5');
  assert.equal(page.el('add-vol-input').value, '0.1');
  page.click('add-button');
  // 0.5 mmol of acid against 12.5 mmol of each form
  assertClose(page.pH(), 4.76 + Math.log10(12 / 13), 0.002, 'pH');
  assert.match(page.el('history').children.at(-1).textContent, /100 µL of 5 M HCl/);
});

test('Reset returns to the starting 500 mL', () => {
  const page = loadFreshPage();
  page.run('setVolume(0.02)');
  page.click('reset');
  assert.equal(page.el('vol-input').value, '500');
  assert.equal(page.run('shownVessel.key'), 'flask1');
});

// ── Removed from the page ──────────────────────────────────────
test('there is no dilution box', () => {
  for (const id of ['water-input', 'water-unit', 'water-button', 'final-input', 'final-unit', 'final-button', 'dilute-error', 'dilution-calc']) {
    assert.ok(!IDS.includes(id), id);
  }
  assert.doesNotMatch(HTML, />Dilution</);
  assert.doesNotMatch(SCRIPT, /addWater|diluteToFinal/);
});

test('buffer capacity is never announced, even far past the buffer', () => {
  assert.doesNotMatch(HTML, /Buffer capacity|capacity-warning|capacityExceeded/);
  const page = loadPage();
  page.run("addStrong('HCl', 5, 0.01)");
  assert.ok(page.run('equivalents()') < 0, 'past the end of the buffer');
  assert.ok(page.run('curveRange().xMin') < page.run('equivalents()'), 'the curve still extends to the point');
});

test('the note under the curve no longer defines an equivalent', () => {
  assert.doesNotMatch(HTML, /One equivalent/);
});

// ── Buffer box layout ──────────────────────────────────────────
test('concentration and volume sit side by side, then pKa beside Set pH', () => {
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('class="side-by-side"') < at('id="conc-input"') && at('id="conc-input"') < at('id="vol-input"'));
  assert.ok(at('id="vol-input"') < at('class="pka-and-ph"'));
  assert.ok(at('class="pka-and-ph"') < at('id="pka-input"') && at('id="pka-input"') < at('id="ph-input"'));
  assert.ok(at('id="ph-input"') < at('id="temp-input"'));
  assert.match(HTML, /\.side-by-side \{ display: grid; grid-template-columns: 1fr 1fr;/);
  assert.match(HTML, /\.pka-and-ph \{ display: grid; grid-template-columns: 64px minmax\(0, 1fr\) minmax\(0, 1\.2fr\);/);
});

test('the pKa box always shows, editable only for the generic buffer', () => {
  const page = loadFreshPage();
  assert.equal(page.el('pka-input').disabled, false);
  assert.equal(page.el('pka-input').value, '4.76');
  page.enter('pka-input', 6);
  assert.equal(page.run('state.pKa'), 6);
  assertClose(page.pH(), 4.76, 1e-6, 'pH holds');
  for (const [key, pKa] of [['mops', '7.20'], ['tris', '8.07'], ['bicarbonate', '6.10']]) {
    page.run(`setBuffer('${key}')`);
    assert.equal(page.el('pka-input').disabled, true, key);
    assert.equal(page.el('pka-input').value, pKa, key);
  }
  page.run("setBuffer('generic')");
  assert.equal(page.el('pka-input').disabled, false);
  assert.equal(page.el('pka-input').value, '4.76');
  assert.match(HTML, /input\[type=number\]:disabled \{ background: #E4E4E4;/);
});

// ── Temperature ────────────────────────────────────────────────
test('pKw follows the table and is exactly 14 at 25 °C', () => {
  const page = loadFreshPage();
  assert.equal(page.run('pKwAt(25)'), 14);
  assert.equal(page.run('pKwAt(0)'), 14.94);
  assert.equal(page.run('pKwAt(37)'), 13.62);
  assertClose(page.run('pKwAt(35)'), 13.68, 0.001, 'between entries');
  assert.equal(page.run('pKwAt(60)'), 13.02);
  page.enter('temp-input', 37);
});

test('cooling a Tris buffer raises its pKa and pH by 0.028 per °C', () => {
  const page = loadFreshPage();
  page.run("setBuffer('tris')");
  page.enter('temp-input', 4);
  assertClose(page.run('state.pKa'), 8.07 + 0.028 * 21, 1e-9, 'pKa');
  assert.equal(page.el('pka-input').value, '8.66');
  assertClose(page.pH(), 8.658, 0.005, 'pH');
});

test('warming a buffer keeps its contents and moves only what depends on temperature', () => {
  const page = loadFreshPage();
  page.run("setBuffer('hepes')");
  const before = page.run('[state.volume, state.totalMoles, state.netBase].join()');
  page.enter('temp-input', 37);
  assert.equal(page.run('[state.volume, state.totalMoles, state.netBase].join()'), before);
  assertClose(page.run('state.pKa'), 7.5 - 0.014 * 12, 1e-9, 'pKa');
  assertClose(page.pH(), 7.332, 0.002, 'pH');
});

test('acetate barely shifts and the generic pKa stays as entered', () => {
  const page = loadFreshPage();
  page.run("setBuffer('acetate')");
  page.enter('temp-input', 45);
  assertClose(page.pH(), 4.764, 0.002, 'acetate');
  page.run("setBuffer('generic')");
  assert.equal(page.run('state.pKa'), 4.76);
  page.enter('temp-input', 10);
  assert.equal(page.run('state.pKa'), 4.76);
});

test('choosing a buffer at another temperature uses its pKa there', () => {
  const page = loadFreshPage();
  page.enter('temp-input', 37);
  page.run("setBuffer('tris')");
  assertClose(page.pH(), 8.07 - 0.028 * 12, 1e-6, 'starts at the pKa for 37 °C');
});

test('setting the pH holds at the chosen temperature, with its own water', () => {
  const page = loadFreshPage();
  page.enter('temp-input', 37);
  page.enter('ph-input', 12);
  assertClose(page.pH(), 12, 1e-9, 'pH');
  assertClose(page.run('KW'), 10 ** -13.62, 1e-20, 'Kw');
});

test('temperatures outside 0 to 60 °C are refused and change nothing', () => {
  const page = loadFreshPage();
  for (const value of [-5, 70, 'abc']) {
    page.enter('temp-input', value);
    assert.match(page.text('buffer-error'), /0 to 60 °C/);
    assert.equal(page.run('state.temperature'), 25);
    assert.equal(page.el('temp-input').value, '25');
  }
  page.enter('temp-input', 0);
  assert.equal(page.text('buffer-error'), '');
  assert.equal(page.run('state.temperature'), 0);
});

test('the buffer dropdown does not repeat a pKa that changes with temperature', () => {
  const page = loadFreshPage();
  assert.doesNotMatch(page.el('buffer-select').innerHTML, /pKa/);
});

test('a pKa the student typed survives a temperature change', () => {
  const page = loadFreshPage();
  page.enter('pka-input', 6);
  page.enter('temp-input', 40);
  assert.equal(page.run('state.pKa'), 6);
  assert.equal(page.el('pka-input').value, '6.00');
});

test('Reset puts water back to its 25 °C Kw', () => {
  const page = loadFreshPage();
  page.enter('temp-input', 37);
  page.click('reset');
  assertClose(page.run('KW'), 1e-14, 1e-20, 'Kw');
});

test('the markup starts with the same defaults as the script', () => {
  assert.match(HTML, /id="vol-input"[^>]*value="500"/);
  assert.match(HTML, /id="conc-input"[^>]*value="50"/);
  assert.match(HTML, /id="temp-input"[^>]*value="25"/);
});

test('the subtitle no longer offers dilution', () => {
  assert.doesNotMatch(HTML.match(/class="subtitle">(.*?)</)[1], /dilute/i);
});

// ── Sliders and one-line rows ──────────────────────────────────
test('each entry in the Buffer box has its slider directly underneath', () => {
  for (const [input, slider] of [['conc-input', 'conc-slider'], ['vol-input', 'vol-slider'], ['ph-input', 'ph-slider'], ['temp-input', 'temp-slider']]) {
    const i = HTML.indexOf(`id="${input}"`), s = HTML.indexOf(`id="${slider}"`);
    assert.ok(i >= 0 && s > i, `${slider} comes after ${input}`);
    const nextInput = HTML.slice(i + 1).search(/<input type="number"/);
    assert.ok(nextInput < 0 || s < i + 1 + nextInput, `${slider} comes before the next entry`);
  }
});

test('pKa, pH and temperature share one row, in that order', () => {
  const row = HTML.slice(HTML.indexOf('class="pka-and-ph"'), HTML.indexOf('id="buffer-error"'));
  const at = id => row.indexOf(`id="${id}"`);
  assert.ok(at('pka-input') > 0 && at('pka-input') < at('ph-input') && at('ph-input') < at('temp-input'));
});

test('stock, volume added and Add share one row', () => {
  const row = HTML.slice(HTML.indexOf('class="add-row"'), HTML.indexOf('id="add-error"'));
  const at = id => row.indexOf(`id="${id}"`);
  assert.ok(at('stock-input') > 0 && at('stock-input') < at('add-vol-input') && at('add-vol-input') < at('add-vol-unit') && at('add-vol-unit') < at('add-button'));
});

test('the concentration slider runs 1 mM to 1 M and follows the field', () => {
  const page = loadFreshPage();
  assert.equal(page.run('sliderToConc(0)'), 0.001);
  assert.equal(page.run('sliderToConc(1000)'), 1);
  assertClose(page.run('sliderToConc(concToSlider(0.05))'), 0.05, 0.001, 'round trip');
  assert.equal(page.el('conc-slider').value, page.run('concToSlider(0.05)'));
  const slider = page.el('conc-slider');
  slider.value = 1000;
  slider.fire('input');
  assert.equal(page.el('conc-input').value, '1000');
  assertClose(page.pH(), 4.76, 1e-6, 'the pH holds');
  page.enter('conc-input', 100);
  assert.equal(page.el('conc-slider').value, page.run('concToSlider(0.1)'));
});

test('a concentration typed beyond the slider pegs it at the end', () => {
  const page = loadFreshPage();
  page.run('setConcentration(2)');
  assert.equal(page.el('conc-slider').value, 1000);
  assertClose(page.run('totalConc()'), 2, 1e-9, 'the typed value stands');
  page.run('setConcentration(1e-4)');
  assert.equal(page.el('conc-slider').value, 0);
});

test('the temperature slider and field stay together', () => {
  const page = loadFreshPage();
  assert.equal(page.el('temp-slider').value, '25');
  page.run("setBuffer('tris')");
  const slider = page.el('temp-slider');
  slider.value = 4;
  slider.fire('input');
  assert.equal(page.el('temp-input').value, '4');
  assert.equal(page.el('pka-input').value, '8.66');
  page.enter('temp-input', 37);
  assert.equal(page.el('temp-slider').value, '37');
});

// ── Removed text ───────────────────────────────────────────────
test('the removed text stays gone', () => {
  assert.doesNotMatch(HTML, /Useful range \(pKa|range-label|All values assume|Drawn at the current|pkw-note|Generic HA/);
});

test('the only text under the curve is the hover line', () => {
  const section = HTML.slice(HTML.indexOf('<canvas id="curve"'), HTML.indexOf('</section>', HTML.indexOf('<canvas id="curve"')));
  assert.equal(section.match(/<p\b/g).length, 1);
  assert.ok(section.includes('<p id="curve-readout">Hover over or touch the plot to read a point on the curve</p>'));
});

test('the buffer list says HA / A⁻', () => {
  const page = loadPage();
  assert.equal(page.run('BUFFERS.generic.name'), 'HA / A⁻');
});

// ── Quiz questions ─────────────────────────────────────────────
function seeded(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const quizPage = loadFreshPage();
const SETS = 500;

function eachQuestion(mode, check) {
  quizPage.run(`quizRand = (${seeded.toString()})(${mode === 'easy' ? 11 : 22}); undefined`);
  for (let i = 0; i < SETS; i++) {
    const set = quizPage.run(`JSON.stringify(buildQuizSet('${mode}', quizRand).map(q => ({ ...q, answers: correctAnswerText(q) })))`);
    for (const q of JSON.parse(set)) check(q);
  }
}
quizPage.run('var quizRand;');

const rightValues = q => Object.fromEntries(q.items.map(i => [i.key, i.kind === 'number' ? String(i.truth) : i.answer]));
const grade = (q, values) => JSON.parse(quizPage.run(`JSON.stringify(gradeQuestion(${JSON.stringify(q)}, ${JSON.stringify(values)}))`));

test('each set has 5 questions and covers every type of its mode', () => {
  const wanted = { easy: ['hendersonHasselbalch', 'amounts', 'chooseBuffer', 'predominantForm'], hard: ['phAfterAddition', 'amountToReachPH', 'preparingBuffer'] };
  for (const mode of ['easy', 'hard']) {
    quizPage.run(`quizRand = (${seeded.toString()})(5); undefined`);
    for (let i = 0; i < 200; i++) {
      const types = JSON.parse(quizPage.run(`JSON.stringify(buildQuizSet('${mode}', quizRand).map(q => q.type))`));
      assert.equal(types.length, 5);
      for (const type of wanted[mode]) assert.ok(types.includes(type), `${mode}: ${type}`);
    }
  }
});

for (const mode of ['easy', 'hard']) {
  test(`every ${mode} question grades its own answer as right, and is well formed`, () => {
    let seen = 0;
    eachQuestion(mode, q => {
      seen += 1;
      assert.ok(q.prompt && q.hint && q.explanation && q.title, q.type);
      assert.ok(!/NaN|undefined|Infinity/.test(q.prompt + q.explanation + q.hint + q.answers), q.prompt + q.explanation);
      assert.ok(!/Answers count|within ±/.test(q.prompt), q.prompt);
      assert.ok(grade(q, rightValues(q)).correct, JSON.stringify(q));
      for (const item of q.items) {
        if (item.kind === 'number') assert.ok(Number.isFinite(item.truth) && item.truth > 0, JSON.stringify(item));
        else assert.ok(item.options.includes(item.answer), JSON.stringify(item));
      }
      assert.ok(q.scene.volume > 0 && q.scene.totalMoles > 0 && Number.isFinite(q.scene.netBase), JSON.stringify(q.scene));
    });
    assert.equal(seen, SETS * 5);
  });

  test(`${mode} numbers outside the allowance are marked wrong`, () => {
    eachQuestion(mode, q => {
      for (const item of q.items) {
        if (item.kind !== 'number') continue;
        const off = rightValues(q);
        off[item.key] = String(item.tolerancePH !== undefined ? item.truth + 0.06 : item.truth * (1 + item.tolerance * 1.5));
        assert.equal(grade(q, off).results[item.key], false, JSON.stringify(item));
      }
    });
  });
}

test('allowances: pH ± 0.05, calculations ± 2%, stock volumes ± 5%', () => {
  for (const mode of ['easy', 'hard']) {
    eachQuestion(mode, q => {
      for (const item of q.items) {
        if (item.kind !== 'number') continue;
        if (/pH$/.test(item.label) || item.label === 'pH') assert.equal(item.tolerancePH, 0.05);
        else if (q.type === 'amountToReachPH' || q.type === 'preparingBuffer') assert.equal(item.tolerance, 0.05);
        else assert.equal(item.tolerance, 0.02);
      }
    });
  }
});

test('hand calculation: 50 mM acetate at pH 4.76 has 25 mM of each form', () => {
  const page = loadFreshPage();
  page.run("setBuffer('acetate')");
  const c = JSON.parse(page.run('JSON.stringify(composition())'));
  assertClose(c.acidConc * 1e3, 25, 0.01, 'acid');
  assertClose(c.baseConc * 1e3, 25, 0.01, 'base');
});

test('hand calculation: the scene helpers match 0.5 mL of 1 M HCl into 50 mL of 50 mM acetate', () => {
  const page = loadFreshPage();
  const r = JSON.parse(page.run("JSON.stringify(afterAddition(sceneAtPH({ key: 'acetate', pKa: 4.76 }, 0.05, 0.05, 4.76), -0.0005, 0.0005))"));
  assertClose(r.pH, 4.39, 0.005, 'pH');
  assertClose(r.acidMoles * 1e3, 1.75, 0.01, 'acid');
  assertClose(r.baseMoles * 1e3, 0.75, 0.01, 'base');
});

// ── Worked the way a student would, from what the prompt gives ──
const hhFraction = (pH, pKa) => 1 / (1 + 10 ** (pKa - pH));
const numberAfter = (text, re) => Number(text.match(re)[1]);
const unitFactor = { 'µL': 1e6, mL: 1e3 };

test('pH after an addition, worked by Henderson–Hasselbalch in moles, passes', () => {
  eachQuestion('hard', q => {
    if (q.type !== 'phAfterAddition') return;
    const { pKa, totalMoles } = q.scene;
    const startPH = numberAfter(q.prompt, /buffer at pH (\d+\.\d+)/);
    const volM = q.prompt.match(/add ([\d.]+) (µL|mL) of ([\d.]+) M (NaOH|HCl)/);
    const moles = Number(volM[1]) / unitFactor[volM[2]] * Number(volM[3]);
    const sign = volM[4] === 'NaOH' ? 1 : -1;
    const base = totalMoles * hhFraction(startPH, pKa) + sign * moles;
    const acid = totalMoles - base;
    const pH = pKa + Math.log10(base / acid);
    const values = { added: String(moles * 1e3), acid: String(acid * 1e3), base: String(base * 1e3), pH: String(pH) };
    assert.ok(grade(q, values).correct, JSON.stringify([q.prompt, values, q.items.map(i => i.truth)]));
  });
});

test('amount to reach a pH, worked by Henderson–Hasselbalch, passes', () => {
  eachQuestion('hard', q => {
    if (q.type !== 'amountToReachPH') return;
    const { pKa, totalMoles } = q.scene;
    const startPH = numberAfter(q.prompt, /buffer at pH (\d+\.\d+)/);
    const targetPH = numberAfter(q.prompt, /brings it to pH (\d+\.\d+)/);
    const stock = numberAfter(q.prompt, /What volume of ([\d.]+) M/);
    const moles = Math.abs(hhFraction(targetPH, pKa) - hhFraction(startPH, pKa)) * totalMoles;
    const litres = moles / stock;
    const value = litres * unitFactor[q.items[0].unit];
    assert.ok(grade(q, { volume: String(value) }).correct, JSON.stringify([q.prompt, value, q.items[0].truth]));
  });
});

test('preparing a buffer, worked by Henderson–Hasselbalch, passes', () => {
  eachQuestion('hard', q => {
    if (q.type !== 'preparingBuffer') return;
    const { pKa, totalMoles } = q.scene;
    const targetPH = numberAfter(q.prompt, /at pH ([\d.]+)\?/);
    const stock = numberAfter(q.prompt, /What volume of ([\d.]+) M/);
    const fromAcid = q.scene.netBase === 0;
    const fb = hhFraction(targetPH, pKa);
    const moles = totalMoles * (fromAcid ? fb : 1 - fb);
    const value = moles / stock * unitFactor[q.items[0].unit];
    assert.ok(grade(q, { volume: String(value) }).correct, JSON.stringify([q.prompt, value, q.items[0].truth]));
    assert.equal(q.items[0].label.includes(fromAcid ? 'NaOH' : 'HCl'), true);
  });
});

test('adding the worked stock volume to the solution really reaches the target pH', () => {
  eachQuestion('hard', q => {
    if (q.type !== 'amountToReachPH' && q.type !== 'preparingBuffer') return;
    const target = numberAfter(q.prompt, /(?:to|at) pH ([\d.]+)(?: \?|\?)/);
    const stock = numberAfter(q.prompt, /What volume of ([\d.]+) M/);
    const litres = q.items[0].truth / unitFactor[q.items[0].unit];
    const sign = q.items[0].label.includes('NaOH') ? 1 : -1;
    const r = JSON.parse(quizPage.run(`JSON.stringify(afterAddition(${JSON.stringify(q.scene)}, ${sign * stock * litres}, ${litres}))`));
    assertClose(r.pH, target, 0.005, q.prompt);
  });
});

test('hard questions mix units and always name a stock', () => {
  const seen = new Set();
  eachQuestion('hard', q => {
    assert.ok(/\d M (NaOH|HCl)/.test(q.prompt), q.prompt);
    for (const unit of q.prompt.match(/(\d) (M|mM|mL|L) /g) || []) seen.add(unit.split(' ')[1]);
  });
  for (const unit of ['M', 'mM', 'mL', 'L']) assert.ok(seen.has(unit), unit);
});

test('choose a buffer: the answer is clearly the closest, and the range answer is right', () => {
  eachQuestion('easy', q => {
    if (q.type !== 'chooseBuffer') return;
    const target = numberAfter(q.prompt, /at pH ([\d.]+)\./);
    const pKas = q.items[0].options.map(o => Number(o.match(/pKa ([\d.]+)/)[1]));
    const answerPKa = Number(q.items[0].answer.match(/pKa ([\d.]+)/)[1]);
    const others = pKas.filter(p => p !== answerPKa).map(p => Math.abs(p - target));
    assert.ok(Math.abs(answerPKa - target) + 0.3 < Math.min(...others), q.items[0].options.join() + ' ' + target);
    const [, testPH, checkPKa] = q.items[1].label.match(/pH ([\d.]+) within .*pKa ([\d.]+)/);
    assert.equal(q.items[1].answer, Math.abs(testPH - checkPKa) <= 1 ? 'Yes' : 'No', q.items[1].label);
  });
});

test('which form predominates follows pH against pKa, and uses the buffer\'s own names', () => {
  const seen = new Set();
  eachQuestion('easy', q => {
    if (q.type !== 'predominantForm') return;
    const pH = Number(q.items[0].label.match(/at pH ([\d.]+)\?/)[1]);
    const pKa = q.scene.pKa;
    const [acid, base, equal] = q.items[0].options;
    assert.equal(q.items[0].answer, pH > pKa ? base : pH < pKa ? acid : equal, q.items[0].label);
    assert.ok(q.prompt.includes(acid) && q.prompt.includes(base));
    seen.add(acid);
  });
  for (const name of ['HA', 'CH₃COOH', 'TrisH⁺']) assert.ok(seen.has(name), name);
});

test('questions whose answer the image would show start at pH = pKa', () => {
  eachQuestion('easy', q => {
    const isRatio = q.items[0].key === 'ratio';
    if (q.type !== 'predominantForm' && !isRatio) return;
    const ka = 10 ** -q.scene.pKa;
    const c = q.scene.totalMoles / q.scene.volume;
    const fbAtScene = (q.scene.netBase / q.scene.volume - 0) / c;
    assertClose(fbAtScene, 0.5, 0.01, q.type);
    assert.ok(ka > 0);
  });
});

test('Easy keeps matching units', () => {
  eachQuestion('easy', q => {
    assert.ok(!/\d M\b/.test(q.prompt), q.prompt);
    assert.ok(!/\d L\b/.test(q.prompt), q.prompt);
  });
});

test('answers read in the notations students use', () => {
  const page = loadFreshPage();
  for (const text of ['0.0025', '2.5e-3', '2.5 x 10^-3', '2.50 × 10⁻³']) {
    assertClose(page.run(`parseAnswer(${JSON.stringify(text)})`), 0.0025, 1e-9, text);
  }
  assert.ok(page.run("Number.isNaN(parseAnswer('abc'))"));
});

test('a blank part is unmarked and not right, and credit is 1, then ½, or 0 when shown', () => {
  const q = { items: [{ key: 'a', kind: 'number', truth: 2, tolerance: 0.02 }, { key: 'b', kind: 'choice', answer: 'Yes', options: ['Yes', 'No'] }] };
  const blank = grade(q, { a: '2', b: null });
  assert.equal(blank.correct, false);
  assert.equal(blank.results.a, true);
  assert.equal(blank.results.b, null);
  assert.equal(grade(q, { a: '2', b: 'Yes' }).correct, true);
  assert.equal(grade(q, { a: '2.1', b: 'Yes' }).results.a, false);
  const page = loadFreshPage();
  assert.equal(page.run('quizCredit(1, true)'), 1);
  assert.equal(page.run('quizCredit(2, true)'), 0.5);
  assert.equal(page.run('quizCredit(6, true)'), 0.5);
  assert.equal(page.run('quizCredit(1, false)'), 0);
});

test('the quiz uses the shared answer colors, and no prompt suggests testing with the hidden pH', () => {
  assert.match(HTML, /\.quiz-item\.correct \{ background: #DBEAFE; border-color: #1565C0; color: #000000; \}/);
  assert.match(HTML, /\.quiz-item\.wrong \{ background: #FFEBEE; border-color: #C8102E; color: #000000; \}/);
  assert.match(HTML, /\.quiz-item input\[type=text\]:disabled \{ background: #E4E4E4; border-color: #BFBFBF; color: #404040; \}/);
  assert.doesNotMatch(HTML, /test your answer/);
});

test('a ✓ or ✗ marks the question, never each of its options', () => {
  for (const rule of HTML.match(/[^\n{}]*::after \{ content: ' [✓✗]'/g)) {
    assert.doesNotMatch(rule.replace(/label:not\(\.quiz-option\)/g, ''), /label/, rule);
  }
});
