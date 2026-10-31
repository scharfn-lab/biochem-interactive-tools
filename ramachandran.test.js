// Tests for ramachandran.html. No dependencies — run with: node --test
//
// The page's inline script runs unmodified in a Node vm against a small DOM and
// canvas stub. Top-level const/let in that script are reachable through page.run().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'ramachandran.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const IDS = [...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

// ── DOM / canvas stubs ─────────────────────────────────────────
function makeContext2D() {
  const calls = [];
  const base = {
    calls,
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    createRadialGradient: () => ({ addColorStop() {} }),
  };
  return new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (...args) => { calls.push({ fn: k, args }); }),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

function makeTarget(id) {
  const classes = new Set();
  const listeners = {};
  return {
    id, value: '', textContent: '', className: '', style: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    rect: { left: 0, top: 0, width: 520, height: 520 },
    context: makeContext2D(),
    classList: {
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
      contains: c => classes.has(c),
    },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    getContext() { return this.context; },
    getBoundingClientRect() { return this.rect; },
    fire(type, props = {}) {
      const e = { target: this, preventDefault() {}, ...props };
      for (const fn of listeners[type] || []) fn(e);
    },
  };
}

function loadPage() {
  const elements = new Map(IDS.map(id => [id, makeTarget(id)]));
  elements.get('plot').rect = { left: 0, top: 0, width: 469, height: 421 };
  const intervals = new Set();
  let nextInterval = 1;
  const document = makeTarget('document');
  document.getElementById = id => elements.get(id) ?? null;
  const context = vm.createContext({
    document,
    window: makeTarget('window'),
    setInterval: () => { intervals.add(nextInterval); return nextInterval++; },
    clearInterval: id => { intervals.delete(id); },
  });
  vm.runInContext(SCRIPT, context);
  return {
    el: id => elements.get(id),
    document,
    intervals,
    plot: elements.get('plot').context,
    dipeptide: elements.get('dipeptide').context,
    run: code => vm.runInContext(code, context),
  };
}

// ── Independent geometry helpers (deliberately not the page's own) ─
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const mag = a => Math.sqrt(dot(a, a));
const DEG = 180 / Math.PI;

const dist = (a, b) => mag(sub(a, b));
const bondAngle = (a, b, c) => {
  const u = sub(a, b), v = sub(c, b);
  return Math.acos(dot(u, v) / (mag(u) * mag(v))) * DEG;
};
// IUPAC signed dihedral A-B-C-D, in degrees
const dihedral = (a, b, c, d) => {
  const b1 = sub(b, a), b2 = sub(c, b), b3 = sub(d, c);
  const n1 = cross(b1, b2), n2 = cross(b2, b3);
  return Math.atan2(dot(cross(n1, n2), b2) / mag(b2), dot(n1, n2)) * DEG;
};
const angleGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function assertClose(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ± ${tol}, got ${actual}`);
}
function assertAngle(actual, expected, label) {
  assert.ok(angleGap(actual, expected) < 1e-6, `${label}: expected ${expected}°, got ${actual}°`);
}

// Renders once and names the atoms joined by each dashed H-bond, e.g. 'HN3-O6,O3-HN6'
const drawnHBonds = page => page.run(`(() => {
  const atoms = buildChain(), found = [];
  const nameOf = p => Object.keys(atoms).find(k => {
    const q = project(rotateView(sub3(atoms[k], atoms.Ca5)), dipScale, DW*0.48 + dipOffX, DH*0.52 + dipOffY);
    return q.x === p.x && q.y === p.y && q.z === p.z;
  });
  const original = drawBond;
  drawBond = (a, b, type, ...rest) => {
    if (type.endsWith('_hbond')) found.push(nameOf(a) + '-' + nameOf(b));
    original(a, b, type, ...rest);
  };
  renderDipeptide();
  drawBond = original;
  return found.sort().join();
})()`);
function assertHBondDistances(page, pairs = drawnHBonds(page).split(',')) {
  const atoms = page.run('buildChain()');
  const lengths = pairs.map(pair => {
    const [a, b] = pair.split('-');
    return { pair, d: dist(atoms[a], atoms[b]) };
  });
  const summary = lengths.map(({ pair, d }) => `${pair} ${d.toFixed(2)} Å`).join(', ');
  assert.ok(lengths.every(({ d }) => d > 1.5 && d < 2.6), summary);
}
const labels = page => page.dipeptide.calls.filter(c => c.fn === 'fillText').map(c => c.args[0]);
const redraw = page => { page.dipeptide.calls.length = 0; page.run('renderDipeptide()'); };

// ── Page wiring ────────────────────────────────────────────────
test('loads and initializes to the β-sheet angles', () => {
  const page = loadPage();
  assert.equal(page.run('phi'), -120);
  assert.equal(page.run('psi'), 130);
  assert.equal(page.el('phi-display').textContent, '-120°');
  assert.equal(page.el('psi-display').textContent, '130°');
});

test('every id the script looks up exists in the markup', () => {
  const used = [...SCRIPT.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(used.length > 0);
  for (const id of used) assert.ok(IDS.includes(id), `missing element #${id}`);
});

test('every inline onclick handler is a defined function', () => {
  const page = loadPage();
  const handlers = [...HTML.matchAll(/onclick="(\w+)\(\)"/g)].map(m => m[1]);
  assert.ok(handlers.length > 0);
  for (const fn of handlers) assert.equal(page.run(`typeof ${fn}`), 'function', fn);
});

// ── Plot coordinates and regions ───────────────────────────────
test('toCanvas and toAngles are inverses and map the plot corners', () => {
  const page = loadPage();
  for (const [p, q] of [[-180, 180], [180, -180], [0, 0], [-60, -45], [57.5, 133.25]]) {
    const a = page.run(`(() => { const c = toCanvas(${p}, ${q}); return toAngles(c.x, c.y); })()`);
    assertClose(a.phi, p, 1e-9, 'phi');
    assertClose(a.psi, q, 1e-9, 'psi');
  }
  const topLeft = page.run('toCanvas(-180, 180)');
  assert.equal(topLeft.x, page.run('M'));
  assert.equal(topLeft.y, page.run('MT'));
  const bottomRight = page.run('toCanvas(180, -180)');
  assert.equal(bottomRight.x, page.run('W - M'));
  assert.equal(bottomRight.y, page.run('MT + PW'));
});

test('toAngles clamps points outside the plot', () => {
  const a = loadPage().run('toAngles(-1000, 5000)');
  assert.equal(a.phi, -180);
  assert.equal(a.psi, -180);
});

test('getRegion classifies known conformations', () => {
  const page = loadPage();
  const cases = [
    [-60, -45, 'favored', 'alpha-helix'],
    [-120, 130, 'favored', 'beta-sheet'],
    [-75, 148, 'favored', 'PPII / beta'],
    [60, 45, 'favored', 'left-hand helix'],
    [0, 0, 'disallowed', ''],
    [180, 0, 'disallowed', ''],
  ];
  for (const [p, q, level, name] of cases) {
    const r = page.run(`getRegion(${p}, ${q})`);
    assert.equal(r.level, level, `(${p}, ${q}) level`);
    assert.equal(r.name, name, `(${p}, ${q}) name`);
  }
  // The γ-turn peak (w=0.25) sits below the favored threshold
  assert.equal(page.run('getRegion(80, -60).level'), 'allowed');
});

test('pixelColor uses a distinct color tier for each level', () => {
  const page = loadPage();
  const rgb = (p, q) => [...page.run(`pixelColor(${p}, ${q})`)];
  assert.deepEqual(rgb(0, 0), [243, 229, 245]);
  const favored = rgb(-60, -45);
  const allowed = rgb(80, -60);
  assert.notDeepEqual(favored, allowed);
  assert.ok(favored[0] <= 106, 'favored is in the deep purple range');
  assert.ok(allowed[0] > 106, 'allowed is in the lighter purple range');
});

// ── setAngles hub ──────────────────────────────────────────────
test('setAngles clamps to ±180 and syncs every residue and control', () => {
  const page = loadPage();
  page.run('setAngles(-500, 500)');
  assert.equal(page.run('phi'), -180);
  assert.equal(page.run('psi'), 180);

  page.run('setAngles(-60.4, -45.4)');
  for (let n = 1; n <= 9; n++) {
    assert.equal(page.run(`residueAngles.aa${n}.phi`), -60.4);
    assert.equal(page.run(`residueAngles.aa${n}.psi`), -45.4);
  }
  assert.equal(page.el('phi-display').textContent, '-60°');
  assert.equal(page.el('psi-display').textContent, '-45°');
  assert.equal(page.el('phi-slider').value, -60);
  assert.equal(page.el('psi-input').value, -45);
});

test('region readout reflects the current angles', () => {
  const page = loadPage();
  const rd = page.el('region-display');
  page.run('setAngles(-60, -45)');
  assert.equal(rd.className, 'reg-favored');
  assert.equal(rd.textContent, 'Favored — alpha-helix');
  page.run('setAngles(80, -60)');
  assert.equal(rd.className, 'reg-allowed');
  assert.equal(rd.textContent, 'Allowed — gamma-turn');
  page.run('setAngles(0, 0)');
  assert.equal(rd.className, 'reg-disallowed');
  assert.equal(rd.textContent, 'Disallowed region');
});

test('the heatmap is built once and restored on later renders', () => {
  const page = loadPage();
  const puts = () => page.plot.calls.filter(c => c.fn === 'putImageData');
  const built = page.plot.calls.filter(c => c.fn === 'fillText').length;
  assert.ok(built > 0, 'axes were drawn');
  assert.equal(puts().length, 1);
  page.run('setAngles(-60, -45)');
  assert.equal(puts().length, 2);
  assert.equal(page.plot.calls.filter(c => c.fn === 'fillText').length, built, 'axes are not redrawn');
  assert.equal(puts()[1].args[0], page.run('bgCache'));
});

// ── User input ─────────────────────────────────────────────────
test('sliders set one angle and keep the other', () => {
  const page = loadPage();
  page.el('phi-slider').fire('input', { target: { value: '-60' } });
  assert.equal(page.run('phi'), -60);
  assert.equal(page.run('psi'), 130);
  page.el('psi-slider').fire('input', { target: { value: '-45' } });
  assert.equal(page.run('phi'), -60);
  assert.equal(page.run('psi'), -45);
});

test('number inputs ignore invalid text; change clamps but input does not apply', () => {
  const page = loadPage();
  const input = page.el('phi-input');
  input.fire('input', { target: { value: 'abc' } });
  input.fire('change', { target: { value: 'abc' } });
  assert.equal(page.run('phi'), -120);
  input.fire('input', { target: { value: '999' } });
  assert.equal(page.run('phi'), -120, 'out-of-range typing is ignored while editing');
  input.fire('change', { target: { value: '999' } });
  assert.equal(page.run('phi'), 180, 'committing an out-of-range value clamps it');
});

test('clicking and dragging the plot sets angles only inside the axes', () => {
  const page = loadPage();
  const plot = page.el('plot');
  plot.fire('mousedown', { clientX: 234.5, clientY: 194.5 });
  assertClose(page.run('phi'), 0, 1e-9, 'phi at center');
  assertClose(page.run('psi'), 0, 1e-9, 'psi at center');

  plot.fire('mousemove', { clientX: 50, clientY: 10 });
  assertClose(page.run('phi'), -180, 1e-9, 'phi while dragging');
  assertClose(page.run('psi'), 180, 1e-9, 'psi while dragging');

  plot.fire('mousemove', { clientX: 10, clientY: 5 });
  assertClose(page.run('phi'), -180, 1e-9, 'margin is ignored');

  page.document.fire('mouseup');
  plot.fire('mousemove', { clientX: 234.5, clientY: 194.5 });
  assertClose(page.run('phi'), -180, 1e-9, 'moves after release are ignored');
});

test('pointer coordinates account for CSS scaling of the canvas', () => {
  const page = loadPage();
  const plot = page.el('plot');
  plot.rect = { left: 100, top: 50, width: 234.5, height: 210.5 };
  plot.fire('mousedown', { clientX: 217.25, clientY: 147.25 });
  assertClose(page.run('phi'), 0, 1e-9, 'phi');
  assertClose(page.run('psi'), 0, 1e-9, 'psi');
});

// ── Backbone geometry ──────────────────────────────────────────
const CONFORMATIONS = [[-60, -45], [-120, 130], [-75, 148], [60, 45], [0, 0], [180, -180]];

test('buildChain reproduces ϕ, ψ and trans ω as measured dihedrals', () => {
  const page = loadPage();
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    const a = page.run('buildChain()');
    for (let i = 1; i <= 8; i++) {
      const j = i + 1;
      assertAngle(dihedral(a[`N${i}`], a[`Ca${i}`], a[`C${i}`], a[`N${j}`]), q, `ψ${i} at (${p},${q})`);
      assertAngle(dihedral(a[`C${i}`], a[`N${j}`], a[`Ca${j}`], a[`C${j}`]), p, `ϕ${j} at (${p},${q})`);
      assertAngle(dihedral(a[`Ca${i}`], a[`C${i}`], a[`N${j}`], a[`Ca${j}`]), 180, `ω${i} at (${p},${q})`);
    }
  }
});

test('buildChain honors independent angles per residue', () => {
  const page = loadPage();
  page.run(`for (let n = 1; n <= 9; n++) {
    residueAngles['aa' + n].phi = -170 + n * 25;
    residueAngles['aa' + n].psi = 160 - n * 30;
  }`);
  const a = page.run('buildChain()');
  for (let i = 1; i <= 8; i++) {
    const j = i + 1;
    assertAngle(dihedral(a[`N${i}`], a[`Ca${i}`], a[`C${i}`], a[`N${j}`]), 160 - i * 30, `ψ${i}`);
    assertAngle(dihedral(a[`C${i}`], a[`N${j}`], a[`Ca${j}`], a[`C${j}`]), -170 + j * 25, `ϕ${j}`);
  }
});

test('bond lengths and angles match the backbone parameters', () => {
  const page = loadPage();
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    const a = page.run('buildChain()');
    for (let i = 1; i <= 9; i++) {
      assertClose(dist(a[`N${i}`], a[`Ca${i}`]), 1.458, 1e-9, `N${i}–Cα`);
      assertClose(dist(a[`Ca${i}`], a[`C${i}`]), 1.525, 1e-9, `Cα${i}–C`);
      assertClose(dist(a[`Ca${i}`], a[`Cb${i}`]), 1.521, 1e-9, `Cα${i}–Cβ`);
      assertClose(dist(a[`Ca${i}`], a[`Ha${i}`]), 1.090, 1e-9, `Cα${i}–Hα`);
      assertClose(dist(a[`C${i}`], a[`O${i}`]), 1.229, 1e-9, `C${i}=O`);
      assertClose(dist(a[`N${i}`], a[`HN${i}`]), 1.010, 1e-9, `N${i}–H`);
      assertClose(bondAngle(a[`N${i}`], a[`Ca${i}`], a[`C${i}`]), 111.2, 1e-6, `N–Cα–C ${i}`);
      if (i < 9) {
        assertClose(dist(a[`C${i}`], a[`N${i + 1}`]), 1.329, 1e-9, `C${i}–N`);
        assertClose(bondAngle(a[`Ca${i}`], a[`C${i}`], a[`N${i + 1}`]), 116.2, 1e-6, `Cα–C–N ${i}`);
        assertClose(bondAngle(a[`C${i}`], a[`N${i + 1}`], a[`Ca${i + 1}`]), 121.7, 1e-6, `C–N–Cα ${i}`);
      }
    }
  }
});

test('peptide planes are planar with O and H trans across the C–N bond', () => {
  const page = loadPage();
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    const a = page.run('buildChain()');
    for (let i = 1; i <= 8; i++) {
      const j = i + 1;
      assertAngle(dihedral(a[`O${i}`], a[`C${i}`], a[`N${j}`], a[`HN${j}`]), 180, `O${i}–C–N–H at (${p},${q})`);
      assertAngle(dihedral(a[`O${i}`], a[`C${i}`], a[`N${j}`], a[`Ca${j}`]), 0, `O${i}–C–N–Cα at (${p},${q})`);
    }
  }
});

test('every residue has L-amino acid chirality at Cα', () => {
  const page = loadPage();
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    const a = page.run('buildChain()');
    for (let i = 1; i <= 9; i++) {
      const volume = dot(cross(sub(a[`N${i}`], a[`Ca${i}`]), sub(a[`C${i}`], a[`Ca${i}`])), sub(a[`Cb${i}`], a[`Ca${i}`]));
      assert.ok(volume > 0, `residue ${i} at (${p},${q}) has signed volume ${volume}`);
    }
  }
});

test('all atom styles and bond definitions refer to atoms in the chain', () => {
  const page = loadPage();
  const atoms = page.run('buildChain()');
  for (const name of ['ATOM_STYLE', 'NTERM_ATOM_STYLE', 'CTERM_ATOM_STYLE', 'EXTRA2_ATOM_STYLE', 'EXTRA4_ATOM_STYLE']) {
    for (const key of Object.keys(page.run(name))) assert.ok(atoms[key], `${name}.${key}`);
  }
  for (const name of ['BOND_DEFS', 'NTERM_BOND_DEFS', 'CTERM_BOND_DEFS', 'EXTRA2_BOND_DEFS', 'EXTRA4_BOND_DEFS']) {
    for (const [a, b, type] of page.run(name)) {
      assert.ok(atoms[a] && atoms[b], `${name}: ${a}–${b}`);
      // Every drawn covalent bond must join atoms that are actually bonded
      const d = dist(atoms[a], atoms[b]);
      assert.ok(d > 0.9 && d < 1.6, `${name}: ${a}–${b} (${type}) is ${d.toFixed(2)} Å long`);
    }
  }
});

test('all nine residues are fully connected once every extension is on', () => {
  const page = loadPage();
  const defs = page.run('[...BOND_DEFS, ...NTERM_BOND_DEFS, ...CTERM_BOND_DEFS, ...EXTRA2_BOND_DEFS, ...EXTRA4_BOND_DEFS]');
  const has = (a, b) => defs.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (let i = 1; i <= 9; i++) {
    for (const [a, b] of [[`N${i}`, `Ca${i}`], [`Ca${i}`, `C${i}`], [`Ca${i}`, `Cb${i}`], [`Ca${i}`, `Ha${i}`], [`C${i}`, `O${i}`], [`N${i}`, `HN${i}`]]) {
      assert.ok(has(a, b), `missing bond ${a}–${b}`);
    }
    if (i < 9) assert.ok(has(`C${i}`, `N${i + 1}`), `missing peptide bond ${i}→${i + 1}`);
  }
});

// ── View matrix ────────────────────────────────────────────────
test('mOrtho keeps the view matrix a proper rotation through many steps', () => {
  const page = loadPage();
  for (let i = 0; i < 500; i++) page.run('viewMatrix = mOrtho(mMul(mMul(mRotX(0.17), mRotY(0.23)), viewMatrix))');
  const m = page.run('viewMatrix');
  for (let i = 0; i < 3; i++) {
    assertClose(mag(m[i]), 1, 1e-9, `row ${i} length`);
    assertClose(dot(m[i], m[(i + 1) % 3]), 0, 1e-9, `rows ${i},${(i + 1) % 3}`);
  }
  assertClose(dot(cross(m[0], m[1]), m[2]), 1, 1e-9, 'determinant');
});

test('applyRotStep applies its rotation in screen space', () => {
  const page = loadPage();
  page.run('viewMatrix = [[1,0,0],[0,1,0],[0,0,1]]');
  page.run('for (let i = 0; i < 9; i++) applyRotStep(1, 0)');  // 9 × 10° = 90° about screen Y
  const v = page.run('rotateView(v3(0, 0, 1))');
  assertClose(v.x, 1, 1e-9, 'x');
  assertClose(v.y, 0, 1e-9, 'y');
  assertClose(v.z, 0, 1e-9, 'z');
});

test('holding a rotation button repeats until the mouse is released', () => {
  const page = loadPage();
  const before = JSON.stringify(page.run('viewMatrix'));
  page.el('rbtn-up').fire('mousedown');
  assert.notEqual(JSON.stringify(page.run('viewMatrix')), before, 'rotates immediately');
  assert.equal(page.intervals.size, 1);
  page.document.fire('mouseup');
  assert.equal(page.intervals.size, 0);
});

test('zoom buttons change scale within limits and pan buttons move the right way', () => {
  const page = loadPage();
  page.el('zbtn-in').fire('mousedown');
  page.document.fire('mouseup');
  assert.equal(page.run('dipScale'), 48);
  page.run('applyZoom(1000)');
  assert.equal(page.run('dipScale'), 120);
  page.run('applyZoom(-1000)');
  assert.equal(page.run('dipScale'), 8);

  for (const [id, x, y] of [['pbtn-up', 0, -8], ['pbtn-down', 0, 8], ['pbtn-left', -8, 0], ['pbtn-right', 8, 0]]) {
    page.run('dipOffX = 0; dipOffY = 0');
    page.el(id).fire('mousedown');
    page.document.fire('mouseup');
    assert.equal(page.run('dipOffX'), x, `${id} x`);
    assert.equal(page.run('dipOffY'), y, `${id} y`);
  }
  assert.equal(page.intervals.size, 0, 'no repeat timers left running');
});

test('convexHull drops interior points', () => {
  const hull = loadPage().run(`convexHull([
    {x:0,y:0},{x:10,y:0},{x:5,y:5},{x:10,y:10},{x:0,y:10},{x:4,y:6}
  ])`);
  assert.equal(hull.length, 4);
  assert.ok(![...hull].some(p => p.x === 5 || p.x === 4));
});

// ── Residue toggles ────────────────────────────────────────────
test('extension toggles cascade and keep button labels in sync', () => {
  const page = loadPage();
  const flags = () => ['showNterm', 'showCterm', 'showExtra2', 'showExtra4'].map(f => page.run(f));

  page.run('toggleExtra4()');
  assert.deepEqual(flags(), [true, true, true, true], 'adding 4 turns on everything it needs');
  assert.equal(page.el('extra4-toggle').textContent, 'Remove 4 Additional AAs');

  page.run('toggleNterm()');
  assert.deepEqual(flags(), [false, true, false, false], 'removing a flank drops the extensions');
  assert.equal(page.el('extra2-toggle').textContent, 'Add 2 Additional AAs');
  assert.equal(page.el('extra4-toggle').textContent, 'Add 4 Additional AAs');
  assert.equal(page.el('nterm-toggle').textContent, 'Add N-terminal AA');
});

test('toggling any pair of options renders in every conformation', () => {
  const page = loadPage();
  const toggles = ['toggleNterm', 'toggleCterm', 'toggleExtra2', 'toggleExtra4', 'togglePlanes', 'toggleAngles'];
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    for (const a of toggles) {
      for (const b of toggles) {
        page.run(`${a}(); ${b}();`);  // throws if a bond or style refers to a missing atom
        page.run(`${b}(); ${a}();`);
      }
    }
  }
});

// ── H-bonds ────────────────────────────────────────────────────
test('α-helix H-bonds are drawn only as the residues they join are shown', () => {
  const page = loadPage();
  page.run('setAngles(-60, -45)');
  assert.equal(drawnHBonds(page), '', 'bare dipeptide');
  page.run('toggleNterm(); toggleCterm()');
  assert.equal(drawnHBonds(page), 'O3-HN7');
  page.run('toggleExtra2()');
  assert.equal(drawnHBonds(page), 'O2-HN6,O3-HN7,O4-HN8');
  page.run('toggleExtra4()');
  assert.equal(drawnHBonds(page), 'O1-HN5,O2-HN6,O3-HN7,O4-HN8,O5-HN9');
  assertHBondDistances(page);

  page.run('setAngles(-120, 130)');
  assert.equal(drawnHBonds(page), '', 'no helix bonds outside the helix region');
});

test('a 3₁₀ helix bonds i→i+3 and an α-helix i→i+4', () => {
  const page = loadPage();
  page.run('toggleExtra4(); setAngles(-49, -26)');
  assert.equal(drawnHBonds(page), 'O1-HN4,O2-HN5,O3-HN6,O4-HN7,O5-HN8,O6-HN9');
  assertHBondDistances(page);
  page.run('setAngles(-57, -47)');
  assert.equal(drawnHBonds(page), 'O1-HN5,O2-HN6,O3-HN7,O4-HN8,O5-HN9');
  assertHBondDistances(page);
});

test('helix H-bonds need the atoms in range, not just a helix-region point', () => {
  const page = loadPage();
  page.run('toggleExtra4(); setAngles(-85, -25)');
  assert.equal(page.run('getRegion(-85, -25).name'), 'alpha-helix', 'a helix-region point');
  assert.equal(drawnHBonds(page), '');
});

// ── β-turn presets ─────────────────────────────────────────────
const TURNS = [
  { fn: 'setBetaTurnTypeI', mode: 'typeI', button: 'bturn-type1', flank: [-114, 102], aa3: [-153, 155], aa4: [-60, -30], aa5: [-90, 0], aa6: [-159, 92],
    aa1: [-128, 131], aa2: [-112, 85], aa7: [-95, 81], aa8: [-122, 110], levels: ['favored', 'allowed'],
    hbonds: 'HN1-O8,HN3-O6,O1-HN8,O3-HN6', arcs: ['ϕ=-90°', 'ψ=0°'] },
  { fn: 'setBetaTurnTypeII', mode: 'typeII', button: 'bturn-type2', flank: [-95, 100], aa3: [-130, 155], aa4: [-60, 120], aa5: [80, 0], aa6: [-140, 95],
    aa1: [-95, 100], aa2: [-95, 100], aa7: [-95, 100], aa8: [-95, 100], levels: ['favored'],
    hbonds: 'HN1-O8,HN3-O6,O1-HN8,O3-HN6', arcs: ['ϕ=80°', 'ψ=0°'] },
];

for (const t of TURNS) {
  test(`${t.fn} applies the canonical i+1 / i+2 angles`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    assert.equal(page.run('betaTurnMode'), t.mode);
    assert.deepEqual([page.run('residueAngles.aa4.phi'), page.run('residueAngles.aa4.psi')], t.aa4);
    assert.deepEqual([page.run('residueAngles.aa5.phi'), page.run('residueAngles.aa5.psi')], t.aa5);
    for (const key of ['aa1', 'aa2', 'aa7', 'aa8']) {
      assert.deepEqual([page.run(`residueAngles.${key}.phi`), page.run(`residueAngles.${key}.psi`)], t[key], key);
    }
    assert.ok(page.el(t.button).textContent.startsWith('Remove'));
    for (const f of ['showNterm', 'showCterm', 'showExtra2', 'showExtra4']) assert.equal(page.run(f), true, f);
    assert.equal(drawnHBonds(page), t.hbonds);
  });

  test(`${t.fn} locks aa3–aa6 while the flanks follow setAngles`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    page.run('setAngles(-60, -45)');
    assert.deepEqual([page.run('residueAngles.aa4.phi'), page.run('residueAngles.aa4.psi')], t.aa4);
    assert.deepEqual([page.run('residueAngles.aa5.phi'), page.run('residueAngles.aa5.psi')], t.aa5);
    for (const key of ['aa3', 'aa6']) {
      assert.deepEqual([page.run(`residueAngles.${key}.phi`), page.run(`residueAngles.${key}.psi`)], t[key], key);
    }
    for (const key of ['aa1', 'aa2', 'aa7', 'aa8', 'aa9']) {
      assert.deepEqual([page.run(`residueAngles.${key}.phi`), page.run(`residueAngles.${key}.psi`)], [-60, -45], key);
    }
    assert.equal(drawnHBonds(page), 'HN3-O6,O3-HN6', 'the locked pair stays; helix and out-of-range bonds are not drawn');
  });

  test(`${t.fn} toggles off and returns the chain to uniform angles`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    page.run(`${t.fn}()`);
    assert.equal(page.run('betaTurnMode'), null);
    assert.ok(page.el(t.button).textContent.startsWith('Show'));
    for (let n = 1; n <= 9; n++) {
      assert.equal(page.run(`residueAngles.aa${n}.phi`), t.flank[0]);
      assert.equal(page.run(`residueAngles.aa${n}.psi`), t.flank[1]);
    }
  });

  test(`${t.fn} closes the i→i+3 H-bond at a hydrogen-bonding distance`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    assertHBondDistances(page, ['O3-HN6']);
  });

  test(`${t.fn} draws its flanking H-bonds at a hydrogen-bonding distance`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    assertHBondDistances(page);
  });

  test(`${t.fn} keeps strand residues in the plot regions it allows`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    assert.deepEqual([page.run('phi'), page.run('psi')], t.flank);
    for (const key of ['aa1', 'aa2', 'aa3', 'aa6', 'aa7', 'aa8']) {
      const level = page.run(`getRegion(residueAngles.${key}.phi, residueAngles.${key}.psi).level`);
      assert.ok(t.levels.includes(level), `${key} is ${level}`);
    }
    assert.ok(t.levels.includes(page.run('getRegion(phi, psi).level')), 'plot point');
  });

  test(`${t.fn} labels the arcs with the angles of aa5`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    redraw(page);
    assert.deepEqual(labels(page).filter(l => /^[ϕψ]=/.test(l)), t.arcs);
    page.run('setAngles(-60, -45)');
    redraw(page);
    assert.deepEqual(labels(page).filter(l => /^[ϕψ]=/.test(l)), t.arcs, 'still aa5 after moving the flanks');
  });
}

test('Type I makes all four sheet H-bonds with good geometry and no clashes', () => {
  const page = loadPage();
  page.run('setBetaTurnTypeI()');
  const a = page.run('buildChain()');
  for (const [h, n, o] of [['HN6', 'N6', 'O3'], ['HN3', 'N3', 'O6'], ['HN8', 'N8', 'O1'], ['HN1', 'N1', 'O8']]) {
    const d = dist(a[h], a[o]);
    assert.ok(d >= 1.8 && d <= 2.2, `${h}···${o} is ${d.toFixed(2)} Å`);
    const nho = bondAngle(a[n], a[h], a[o]);
    assert.ok(nho >= 150, `N–${h}···${o} is ${nho.toFixed(0)}°`);
  }
  const heavy = [];
  for (let i = 1; i <= 9; i++) for (const k of ['N', 'Ca', 'C', 'O', 'Cb']) heavy.push([k + i, i]);
  for (const [x, i] of heavy) {
    for (const [y, j] of heavy) {
      if (j - i < 2) continue;
      const d = dist(a[x], a[y]);
      assert.ok(d >= 2.8, `${x}–${y} clash at ${d.toFixed(2)} Å`);
    }
  }
});

test('moving a slider in Type I sets the strands to one angle and drops the outer bonds', () => {
  const page = loadPage();
  page.run('setBetaTurnTypeI()');
  page.el('phi-slider').fire('input', { target: { value: '-110' } });
  for (const key of ['aa1', 'aa2', 'aa7', 'aa8', 'aa9']) {
    assert.deepEqual([page.run(`residueAngles.${key}.phi`), page.run(`residueAngles.${key}.psi`)], [-110, 102], key);
  }
  assert.equal(drawnHBonds(page), 'HN3-O6,O3-HN6');
});

test('switching directly between turn types replaces the preset', () => {
  const page = loadPage();
  page.run('setBetaTurnTypeI()');
  page.run('setBetaTurnTypeII()');
  assert.equal(page.run('betaTurnMode'), 'typeII');
  assert.equal(page.run('residueAngles.aa5.phi'), 80);
  assert.ok(page.el('bturn-type1').textContent.startsWith('Show'));
  assert.ok(page.el('bturn-type2').textContent.startsWith('Remove'));
});

test('the ϕ/ψ arcs label the angles of the residue they are drawn on', () => {
  const page = loadPage();
  page.run('setAngles(-60, -45)');
  redraw(page);
  assert.ok(labels(page).includes('ϕ=-60°'));
  assert.ok(labels(page).includes('ψ=-45°'));
  page.run('toggleAngles()');
  redraw(page);
  assert.ok(!labels(page).some(l => l.startsWith('ϕ=')), 'arcs hide with the toggle');
});

// ── Single-residue view ────────────────────────────────────────
// Renders once and returns each atom's canvas position
const projected = page => page.run(`(() => {
  const keys = Object.keys(buildChain()), out = {};
  let i = 0;
  const original = project;
  project = (...args) => { const q = original(...args); out[keys[i++]] = q; return q; };
  renderDipeptide();
  project = original;
  return out;
})()`);
const RIGID = ['Ca5', 'Cb5', 'Ha5', 'N5', 'C5'];

test('with one residue shown, its Cα, R group and H stay put as ϕ and ψ change', () => {
  const page = loadPage();
  const start = projected(page);
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    const now = projected(page);
    for (const key of RIGID) {
      for (const axis of ['x', 'y', 'z']) {
        assertClose(now[key][axis], start[key][axis], 1e-6, `${key}.${axis} at (${p},${q})`);
      }
    }
  }
});

test('with one residue shown, ϕ swings only the N-side plane and ψ only the C-side plane', () => {
  const page = loadPage();
  const moved = (a, b, key) => Math.hypot(a[key].x - b[key].x, a[key].y - b[key].y, a[key].z - b[key].z) > 0.1;
  const start = projected(page);

  page.run('setAngles(-60, 130)');
  const afterPhi = projected(page);
  for (const key of ['C4', 'O4', 'HN5', 'Ca4']) assert.ok(moved(start, afterPhi, key), `${key} follows ϕ`);
  for (const key of ['O5', 'N6', 'HN6', 'Ca6']) assert.ok(!moved(start, afterPhi, key), `${key} ignores ϕ`);

  page.run('setAngles(-60, -45)');
  const afterPsi = projected(page);
  for (const key of ['O5', 'N6', 'HN6', 'Ca6']) assert.ok(moved(afterPhi, afterPsi, key), `${key} follows ψ`);
  for (const key of ['C4', 'O4', 'HN5', 'Ca4']) assert.ok(!moved(afterPhi, afterPsi, key), `${key} ignores ψ`);
});

test('the anchored view is a true rotation: the drawn ϕ and ψ stay correct', () => {
  const page = loadPage();
  page.run('viewMatrix = mOrtho(viewMatrix)');  // the default is only rounded to orthonormal
  for (const [p, q] of CONFORMATIONS) {
    page.run(`setAngles(${p}, ${q})`);
    const raw = projected(page);
    const a = {};  // back to a right-handed frame: canvas y points down
    for (const key of Object.keys(raw)) a[key] = { x: raw[key].x / 44, y: -raw[key].y / 44, z: raw[key].z };
    assertAngle(dihedral(a.C4, a.N5, a.Ca5, a.C5), p, 'ϕ');
    assertAngle(dihedral(a.N5, a.Ca5, a.C5, a.N6), q, 'ψ');
    assertClose(dist(a.N5, a.Ca5), 1.458, 1e-9, 'N–Cα');
  }
});

test('the anchored residue still responds to the user rotating the view', () => {
  const page = loadPage();
  const start = projected(page);
  page.run('applyRotStep(1, 0)');
  const rotated = projected(page);
  assert.ok(Math.abs(rotated.Cb5.x - start.Cb5.x) > 0.1 || Math.abs(rotated.Cb5.z - start.Cb5.z) > 0.1, 'view rotation moves it');
  page.run('setAngles(-60, -45)');
  assertClose(projected(page).Cb5.x, rotated.Cb5.x, 1e-6, 'stays put in the rotated view');
});

test('the default conformation looks the same whether or not it is anchored', () => {
  const page = loadPage();
  const anchored = projected(page);
  page.run('toggleNterm(); dipScale = 44; dipOffX = 0; dipOffY = 0');
  const free = projected(page);
  for (const key of RIGID) assertClose(anchored[key].x, free[key].x, 1e-6, key);
});

test('anchoring applies only while a single residue is shown', () => {
  for (const toggle of ['toggleNterm', 'toggleCterm']) {
    const page = loadPage();
    page.run(`${toggle}()`);
    const start = projected(page);
    page.run('setAngles(-60, -45)');
    const now = projected(page);
    assert.ok(Math.hypot(now.Cb5.x - start.Cb5.x, now.Cb5.y - start.Cb5.y) > 0.1, toggle);
  }
});

test('on load, N is left, the carbonyl is right, R is in front and H is behind Cα', () => {
  const a = projected(loadPage());
  assert.ok(a.N5.x < a.Ca5.x, 'N left of Cα');
  assert.ok(a.C5.x > a.Ca5.x, 'carbonyl C right of Cα');
  assertClose(a.N5.y, a.C5.y, 1e-6, 'N and C level on screen');
  assert.ok(a.Cb5.z > a.Ca5.z, 'R in front of Cα');
  assert.ok(a.Ha5.z < a.Ca5.z, 'Hα behind Cα');
  // R is drawn at radius 14, Hα at radius 4; the Hα must not be hidden behind R
  const gap = Math.hypot(a.Ha5.x - a.Cb5.x, a.Ha5.y - a.Cb5.y);
  assert.ok(gap > 14 + 4, `Hα is ${gap.toFixed(1)} px from R`);
});

test('the default view is a proper rotation', () => {
  const m = loadPage().run('DEFAULT_VIEW');
  for (let i = 0; i < 3; i++) {
    assertClose(mag(m[i]), 1, 1e-9, `row ${i} length`);
    assertClose(dot(m[i], m[(i + 1) % 3]), 0, 1e-9, `rows ${i},${(i + 1) % 3}`);
  }
  assertClose(dot(cross(m[0], m[1]), m[2]), 1, 1e-9, 'determinant');
});

test('the Reset button is always visible, between the Add 2 and Add 4 buttons', () => {
  const row = HTML.match(/<div id="extra-row"[\s\S]*?<\/div>/)[0];
  assert.deepEqual([...row.matchAll(/<button id="([^"]+)"/g)].map(m => m[1]), ['extra2-toggle', 'reset-one', 'extra4-toggle']);
  assert.match(row, />Reset to 1 AA</);
  assert.doesNotMatch(row.match(/<div[^>]*>/)[0], /display:\s*none/, 'row is not hidden in the markup');
  assert.doesNotMatch(SCRIPT, /extra-row/, 'the script never hides the row');
});

test('Reset to 1 AA restores the page from any state', () => {
  const setups = [
    'toggleNterm()',
    'toggleExtra4(); setAngles(-60, -45)',
    'setBetaTurnTypeI()',
    'setBetaTurnTypeII(); setAngles(10, 20)',
    'toggleCterm(); applyRotStep(1, 1); applyZoom(40); applyPan(16, -24); setAngles(60, 45)',
  ];
  for (const setup of setups) {
    const page = loadPage();
    const initial = projected(page);
    page.run(setup);
    page.run('resetToOneAA()');

    for (const f of ['showNterm', 'showCterm', 'showExtra2', 'showExtra4']) assert.equal(page.run(f), false, `${setup}: ${f}`);
    assert.equal(page.run('betaTurnMode'), null, setup);
    assert.equal(page.run('dipScale'), 44, setup);
    assert.equal(page.run('dipOffX'), 0, setup);
    assert.equal(page.run('dipOffY'), 0, setup);
    assert.deepEqual([page.run('phi'), page.run('psi')], [-120, 130], setup);
    for (let n = 1; n <= 9; n++) {
      assert.deepEqual([page.run(`residueAngles.aa${n}.phi`), page.run(`residueAngles.aa${n}.psi`)], [-120, 130], `${setup}: aa${n}`);
    }

    // Stub buttons start with empty text, so a never-toggled button has no label to compare
    for (const id of ['nterm-toggle', 'cterm-toggle', 'extra2-toggle', 'extra4-toggle', 'bturn-type1', 'bturn-type2']) {
      assert.ok(!page.el(id).textContent.startsWith('Remove'), `${setup}: #${id} says "${page.el(id).textContent}"`);
      assert.ok(!page.el(id).classList.contains('active'), `${setup}: #${id} is active`);
    }
    assert.equal(page.el('phi-display').textContent, '-120°', setup);

    const now = projected(page);
    for (const key of Object.keys(initial)) {
      for (const axis of ['x', 'y', 'z']) assertClose(now[key][axis], initial[key][axis], 1e-9, `${setup}: ${key}.${axis}`);
    }
  }
});

test('Type II sheet bonds are drawn only while the flanks keep them in range', () => {
  const page = loadPage();
  page.run('setBetaTurnTypeII()');
  assert.equal(drawnHBonds(page), 'HN1-O8,HN3-O6,O1-HN8,O3-HN6');
  page.run('setAngles(-60, -45)');
  assert.equal(drawnHBonds(page), 'HN3-O6,O3-HN6');
  page.run('setAngles(-95, 100)');
  assert.equal(drawnHBonds(page), 'HN1-O8,HN3-O6,O1-HN8,O3-HN6');
});

// ── β-turn framing ─────────────────────────────────────────────
for (const t of TURNS) {
  const box = page => {
    const p = Object.values(projected(page));
    const xs = p.map(q => q.x), ys = p.map(q => q.y);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  };

  test(`${t.fn} centers the whole peptide on the canvas from any prior view`, () => {
    const priors = ['0', 'applyRotStep(4, 7); applyZoom(60); applyPan(-120, 90)', 'toggleExtra4(); setAngles(-60, -45); applyZoom(-30)'];
    const first = [];
    for (const prior of priors) {
      const page = loadPage();
      page.run(prior);
      page.run(`${t.fn}()`);
      const b = box(page);
      assertClose((b.minX + b.maxX) / 2, 250, 1e-6, `x center after ${prior}`);
      assertClose((b.minY + b.maxY) / 2, 130.5, 1e-6, `y center after ${prior}`);
      // Largest atom radius at this zoom must also stay on the canvas
      const r = 14 * page.run('dipScale') / 44;
      assert.ok(b.minX - r >= 0 && b.maxX + r <= 500, `x range ${b.minX}–${b.maxX}`);
      assert.ok(b.minY - r >= 0 && b.maxY + r <= 261, `y range ${b.minY}–${b.maxY}`);
      first.push(JSON.stringify(b));
    }
    assert.equal(new Set(first).size, 1, 'the framing does not depend on the prior view');
  });

  test(`${t.fn} faces the sheet to the viewer with the turn on the right`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    const m = page.run('viewMatrix');
    for (let i = 0; i < 3; i++) assertClose(mag(m[i]), 1, 1e-9, `row ${i} length`);
    assertClose(dot(cross(m[0], m[1]), m[2]), 1, 1e-9, 'determinant');
    const a = projected(page);
    assert.ok((a.Ca4.x + a.Ca5.x) / 2 > (a.Ca1.x + a.Ca8.x) / 2, 'turn right of the strand ends');
  });

  test(`${t.fn} keeps the framing while the sliders move the flanks`, () => {
    const page = loadPage();
    page.run(`${t.fn}()`);
    const before = [page.run('dipScale'), page.run('dipOffX'), page.run('dipOffY')];
    page.run('setAngles(-110, 110)');
    assert.deepEqual([page.run('dipScale'), page.run('dipOffX'), page.run('dipOffY')], before);
  });
}

// ── Layout ─────────────────────────────────────────────────────
test('the legend sits inside the plot box, below the plot', () => {
  const box = HTML.slice(HTML.indexOf('<div id="plot-wrapper">'), HTML.indexOf('<!-- end #plot-wrapper -->'));
  assert.ok(box.includes('id="plot"'));
  assert.equal([...box.matchAll(/class="legend-item"/g)].length, 4);
  assert.ok(box.indexOf('id="plot"') < box.indexOf('class="legend"'));
  assert.equal([...HTML.matchAll(/class="legend-item"/g)].length, 4, 'no second copy elsewhere');
});

test('the columns run ribbon over viewer and sliders over readout over plot', () => {
  const at = marker => {
    const i = HTML.indexOf(marker);
    assert.ok(i >= 0, marker);
    return i;
  };
  assert.ok(at('<div id="ribbon-section">') < at('<div id="panel">'), 'ribbon is left of the panel');
  assert.ok(at('id="phi-slider"') < at('id="region-display"'), 'sliders above the region readout');
  assert.ok(at('id="region-display"') < at('<div id="dipeptide-section">'), 'readout is in the top row');
  assert.ok(at('<div id="dipeptide-section">') < at('<div id="plot-wrapper">'), 'viewer is left of the plot');
});

// ── Ribbon image ───────────────────────────────────────────────
const RIBBONS = [
  [-60, -45, 'helix', 'α-helix (right-handed)'],
  [60, 45, 'leftHelix', 'Left-handed helix'],
  [-120, 130, 'sheet', 'β-sheet / extended strand'],
  [-120, 150, 'sheet', 'β-sheet / extended strand'],
  [-75, 148, 'ppII', 'Polyproline II helix (left-handed, extended)'],
  [80, -60, 'gammaTurn', 'γ-turn (three residues, H-bond from i to i+2)'],
  [0, 0, 'none', 'No regular secondary structure at these angles'],
];
for (const [p, q, kind, caption] of RIBBONS) {
  test(`ribbon at ϕ=${p}, ψ=${q} shows ${kind}`, () => {
    const page = loadPage();
    page.run(`setAngles(${p}, ${q})`);
    assert.equal(page.run('ribbonShown'), kind);
    assert.equal(page.el('ribbon-caption').textContent, caption);
    assert.ok(page.el('ribbon').attrs['aria-label'].includes(caption), 'screen readers get the name');
  });
}

test('the ribbon draws something for a structure and nothing without one', () => {
  const page = loadPage();
  const fills = () => page.el('ribbon').context.calls.filter(c => c.fn === 'fill').length;
  assert.ok(fills() > 0, 'default β-sheet');
  page.run('setAngles(0, 0)');
  assert.equal(page.el('ribbon').context.calls.at(-1).fn, 'clearRect', 'cleared, then nothing drawn');
});

test('the ribbon stays static until the structure changes', () => {
  const page = loadPage();
  const calls = () => page.el('ribbon').context.calls.length;
  const start = calls();
  page.run('setAngles(-110, 125); setAngles(-125, 135)');
  assert.equal(calls(), start, 'still a β-sheet');
  page.run('setAngles(-60, -45)');
  assert.ok(calls() > start, 'helix redraws');
});

// Sign of the curve's torsion: positive for a right-handed helix in a right-handed frame
const helixTwist = (page, kind) => {
  const at = t => page.run(`helixRibbonPoint(${t}, 0, HELIX_SHAPES.${kind})`);
  const [a, b, c, d] = [0.30, 0.31, 0.32, 0.33].map(at);
  return dot(cross(sub(b, a), sub(c, b)), sub(d, c));
};
test('each helix ribbon has the right handedness', () => {
  const page = loadPage();
  for (const kind of ['helix', 'helix310']) assert.ok(helixTwist(page, kind) > 0, `${kind} is right-handed`);
  for (const kind of ['leftHelix', 'ppII']) assert.ok(helixTwist(page, kind) < 0, `${kind} is left-handed`);
});

test('every helix ribbon stays on the canvas, arrowhead included', () => {
  const page = loadPage();
  for (const kind of Object.keys(page.run('HELIX_SHAPES'))) {
    for (let t = 0; t <= 1.0001; t += 0.01) {
      for (const s of [-1, 1]) {
        const p = page.run(`helixRibbonPoint(${Math.min(t, 1)}, ${s}, HELIX_SHAPES.${kind})`);
        assert.ok(Math.abs(p.x) <= 228 && Math.abs(p.y) <= 75, `${kind} t=${t} s=${s}: ${p.x}, ${p.y}`);
      }
    }
  }
});

test('every helix ribbon ends in an arrowhead on the front, labeled N to C', () => {
  const page = loadPage();
  for (const kind of Object.keys(page.run('HELIX_SHAPES'))) {
    const width = t => dist(page.run(`helixRibbonPoint(${t}, -1, HELIX_SHAPES.${kind})`), page.run(`helixRibbonPoint(${t}, 1, HELIX_SHAPES.${kind})`));
    const base = page.run(`HELIX_SHAPES.${kind}.headStart`) ?? 0.931;
    assert.ok(width(base) > width(0.5) * 1.5, `${kind}: the head flares out`);
    assertClose(width(1), 0, 1e-9, `${kind}: the head comes to a point`);
    assert.ok(page.run(`helixRibbonPoint(1, 0, HELIX_SHAPES.${kind})`).z > 0, `${kind}: the tip is in front`);
    const start = page.run(`helixRibbonPoint(0, 0, HELIX_SHAPES.${kind})`);
    assert.ok(start.x < page.run(`helixRibbonPoint(1, 0, HELIX_SHAPES.${kind})`).x, `${kind}: runs left to right`);
  }
  page.run('setAngles(-60, -45)');
  const text = page.el('ribbon').context.calls.filter(c => c.fn === 'fillText').map(c => c.args[0]).slice(-2);
  assert.deepEqual(text, ['N', 'C']);
});

test('sheet ribbons draw the strand directions of their structure', () => {
  const page = loadPage();
  assert.deepEqual([...page.run('SHEET_DIRECTIONS.parallel')], [1, 1, 1]);
  assert.deepEqual([...page.run('SHEET_DIRECTIONS.antiparallel')], [1, -1, 1]);
  const lines = kind => {
    page.el('ribbon').context.calls.length = 0;
    page.run(`rc.clearRect(0, 0, RW, RH); drawSheetRibbon(SHEET_DIRECTIONS.${kind}, '#6A0DAD')`);
    return page.el('ribbon').context.calls.filter(c => c.fn === 'bezierCurveTo').length;
  };
  assert.equal(lines('parallel'), 2, 'parallel strands join by crossovers');
  assert.equal(lines('antiparallel'), 0, 'antiparallel strands join by hairpins');
});

// ── Accessibility ──────────────────────────────────────────────
test('arrow keys move the plot point, 1° at a time or 10° with Shift', () => {
  const page = loadPage();
  const plot = page.el('plot');
  plot.fire('keydown', { key: 'ArrowRight' });
  assert.deepEqual([page.run('phi'), page.run('psi')], [-119, 130]);
  plot.fire('keydown', { key: 'ArrowDown' });
  assert.deepEqual([page.run('phi'), page.run('psi')], [-119, 129]);
  plot.fire('keydown', { key: 'ArrowUp', shiftKey: true });
  assert.deepEqual([page.run('phi'), page.run('psi')], [-119, 139]);
  plot.fire('keydown', { key: 'ArrowLeft', shiftKey: true });
  assert.deepEqual([page.run('phi'), page.run('psi')], [-129, 139]);
  plot.fire('keydown', { key: 'a' });
  assert.deepEqual([page.run('phi'), page.run('psi')], [-129, 139], 'other keys do nothing');
});

test('arrow keys rotate the viewer', () => {
  const page = loadPage();
  const before = JSON.stringify(page.run('viewMatrix'));
  page.el('dipeptide').fire('keydown', { key: 'ArrowLeft' });
  assert.notEqual(JSON.stringify(page.run('viewMatrix')), before);
  const after = JSON.stringify(page.run('viewMatrix'));
  page.el('dipeptide').fire('keydown', { key: 'x' });
  assert.equal(JSON.stringify(page.run('viewMatrix')), after, 'other keys do nothing');
});

test('Enter or Space on a viewer button takes one step; a mouse click adds none', () => {
  const page = loadPage();
  const state = () => JSON.stringify([page.run('viewMatrix'), page.run('dipScale'), page.run('dipOffX'), page.run('dipOffY')]);
  for (const id of ['rbtn-up', 'rbtn-down', 'rbtn-left', 'rbtn-right', 'zbtn-in', 'zbtn-out', 'pbtn-up', 'pbtn-down', 'pbtn-left', 'pbtn-right']) {
    const before = state();
    page.el(id).fire('click', { detail: 1 });
    assert.equal(state(), before, `${id}: mouse click is already handled by mousedown`);
    page.el(id).fire('click', { detail: 0 });
    assert.notEqual(state(), before, `${id}: keyboard activation`);
    assert.equal(page.intervals.size, 0, `${id}: no repeat timer left running`);
  }
});

test('the plot and viewer can take focus and describe themselves', () => {
  for (const id of ['plot', 'dipeptide']) {
    assert.match(HTML, new RegExp(`<canvas id="${id}"[^>]*tabindex="0"`), id);
  }
  assert.match(HTML, /id="region-display"[^>]*aria-live="polite"/);
  assert.ok(loadPage().el('dipeptide').attrs['aria-label'].startsWith('3D peptide backbone viewer'));
  const page = loadPage();
  page.run('setAngles(-60, -45)');
  const label = page.el('plot').attrs['aria-label'];
  for (const text of ['-60°', '-45°', 'Favored — alpha-helix']) assert.ok(label.includes(text), label);
});

test('ϕ and ψ colors meet 4.5:1 on white', () => {
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const phiColor = HTML.match(/style="color:(#[0-9A-Fa-f]{6});">ϕ/)[1];
  const psiColor = HTML.match(/style="color:(#[0-9A-Fa-f]{6});">ψ/)[1];
  for (const color of [phiColor, psiColor]) {
    assert.ok(1.05 / (luminance(color) + 0.05) >= 4.5, color);
  }
  assert.doesNotMatch(HTML, /#ffa726|#26c6da/i, 'old low-contrast colors are gone');
});

test('the legend makes no statistical claim', () => {
  assert.doesNotMatch(HTML, /98%/);
  assert.match(HTML, /approximate/);
});

// ── Structure presets ──────────────────────────────────────────
const STRUCTURE_PRESETS = [
  ['alpha', -57, -47, 'helix', 'O1-HN5,O2-HN6,O3-HN7,O4-HN8,O5-HN9'],
  ['antiparallel', -139, 135, 'antiparallel', ''],
  ['parallel', -119, 113, 'parallel', ''],
  ['ppII', -75, 145, 'ppII', ''],
  ['leftHelix', 57, 47, 'leftHelix', 'O1-HN5,O2-HN6,O3-HN7,O4-HN8,O5-HN9'],
  ['helix310', -49, -26, 'helix310', 'O1-HN4,O2-HN5,O3-HN6,O4-HN7,O5-HN8,O6-HN9'],
];
for (const [name, p, q, ribbon, hbonds] of STRUCTURE_PRESETS) {
  test(`the ${name} preset sets the angles, ribbon and H-bonds of the whole chain`, () => {
    const page = loadPage();
    page.run(`goToStructure('${name}')`);
    assert.deepEqual([page.run('phi'), page.run('psi')], [p, q]);
    for (let n = 1; n <= 9; n++) {
      assert.deepEqual(JSON.parse(page.run(`JSON.stringify(residueAngles.aa${n})`)), { phi: p, psi: q }, `aa${n}`);
    }
    assert.ok(page.run('showNterm && showCterm && showExtra2 && showExtra4'), 'all 9 residues shown');
    assert.equal(page.run('ribbonShown'), ribbon);
    assert.equal(drawnHBonds(page), hbonds);
  });

  test(`the ${name} preset centers the chain on the canvas from any prior view`, () => {
    for (const prior of ['0', 'applyRotStep(4, 7); applyZoom(60); applyPan(-120, 90)', 'setBetaTurnTypeI()']) {
      const page = loadPage();
      page.run(prior);
      page.run(`goToStructure('${name}')`);
      assert.equal(page.run('betaTurnMode'), null, 'clears any β-turn');
      const points = Object.values(page.run(`(() => {
        const atoms = buildChain(), out = {};
        for (const k of Object.keys(atoms)) out[k] = project(rotateView(sub3(atoms[k], atoms.Ca5)), dipScale, DW*0.48 + dipOffX, DH*0.52 + dipOffY);
        return out;
      })()`));
      const xs = points.map(a => a.x), ys = points.map(a => a.y);
      assertClose((Math.min(...xs) + Math.max(...xs)) / 2, 250, 1e-6, 'x center');
      assertClose((Math.min(...ys) + Math.max(...ys)) / 2, 130.5, 1e-6, 'y center');
      assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= 500, 'x on canvas');
      assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) <= 261, 'y on canvas');
    }
  });
}

test('a preset button exists for every structure and the turn button resets its label', () => {
  const page = loadPage();
  const buttons = [...HTML.matchAll(/onclick="goToStructure\('(\w+)'\)"/g)].map(m => m[1]);
  assert.deepEqual(buttons, ['alpha', 'antiparallel', 'parallel', 'ppII', 'leftHelix', 'helix310'], 'button order');
  assert.deepEqual([...Object.keys(page.run('STRUCTURES'))].sort(), [...buttons].sort());
  page.run("setBetaTurnTypeI(); goToStructure('alpha')");
  assert.equal(page.el('bturn-type1').textContent, 'Show β turn (Type I)');
});

test('the sliders still work after a preset, and Reset still returns to the start', () => {
  const page = loadPage();
  page.run("goToStructure('alpha'); setAngles(-100, 100)");
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(residueAngles.aa1)')), { phi: -100, psi: 100 });
  page.run('resetToOneAA()');
  assert.equal(page.run('showNterm || showCterm || showExtra2 || showExtra4'), false);
  assert.deepEqual([page.run('dipScale'), page.run('dipOffX'), page.run('dipOffY')], [44, 0, 0]);
});

test('zoomed-out views list the ϕ/ψ angles in a corner instead of crowding the arcs', () => {
  const page = loadPage();
  const angleLabels = () => page.dipeptide.calls.filter(c => c.fn === 'fillText' && /^[ϕψ]=/.test(c.args[0]));
  const arcs = () => page.dipeptide.calls.filter(c => c.fn === 'setLineDash' && c.args[0].length === 2 && c.args[0][0] === 3);

  redraw(page);
  assert.deepEqual(angleLabels(page).map(c => c.args[0]), ['ϕ=-120°', 'ψ=130°']);
  assert.ok(angleLabels().every(c => c.args[1] !== page.run('ANGLE_CORNER_X')), 'beside the arcs at the default zoom');
  assert.equal(arcs().length, 2, 'both arcs drawn');

  page.run("goToStructure('antiparallel')");
  redraw(page);
  assert.deepEqual(angleLabels().map(c => c.args[0]), ['ϕ=-139°', 'ψ=135°']);
  assert.ok(angleLabels().every(c => c.args[1] === page.run('ANGLE_CORNER_X')), 'in the corner when zoomed out');
  assert.equal(arcs().length, 0, 'no arcs');

  page.run('toggleAngles()');
  redraw(page);
  assert.equal(angleLabels().length, 0, 'Hide ϕ/ψ Angles hides the corner labels too');
});

// ── Steric clashes ─────────────────────────────────────────────
const clashesFor = (page, keys = 'Object.keys(buildChain())') => page.run(`findClashes(buildChain(), ${keys})`);
const shownClashes = page => page.run(`(() => {
  const found = [], original = drawClash;
  drawClash = (...args) => { found.push(args); original(...args); };
  renderDipeptide();
  drawClash = original;
  return found.length;
})()`);

for (const name of ['alpha', 'helix310', 'antiparallel', 'parallel', 'ppII']) {
  test(`the ${name} preset has no steric clashes`, () => {
    const page = loadPage();
    page.run(`goToStructure('${name}')`);
    assert.equal(shownClashes(page), 0);
    assert.ok(page.el('dipeptide').attrs['aria-label'].includes('No steric clashes'));
  });
}

test('the default conformation has no steric clashes', () => {
  const page = loadPage();
  assert.equal(shownClashes(page), 0);
});

test('the left-handed helix clashes only through Cβ···O of the same residue', () => {
  const page = loadPage();
  page.run("goToStructure('leftHelix')");
  const clashes = clashesFor(page);
  assert.ok(clashes.length > 0);
  for (const { a, b } of clashes) assert.match(`${a}-${b}`, /^(Cb(\d)-O\2|O(\d)-Cb\3)$/);
  assert.ok(shownClashes(page) > 0);
});

test('clashes are closest first and their distances are right', () => {
  const page = loadPage();
  page.run('setAngles(0, 0)');
  const clashes = page.run("findClashes(buildChain(), Object.keys({ ...ATOM_STYLE }))");
  assert.ok(clashes.length > 0);
  const atoms = page.run('buildChain()');
  for (let i = 0; i < clashes.length; i++) {
    assertClose(clashes[i].d, dist(atoms[clashes[i].a], atoms[clashes[i].b]), 1e-9, `${clashes[i].a}-${clashes[i].b}`);
    if (i) assert.ok(clashes[i].d >= clashes[i - 1].d, 'closest first');
  }
});

test('directly bonded and 1–3 pairs never count, but 1–4 pairs can', () => {
  const page = loadPage();
  page.run('setAngles(0, 0)');
  const clashes = clashesFor(page);
  for (const { a, b } of clashes) assert.equal(page.run(`withinTwoBonds('${a}', '${b}')`), false, `${a}-${b}`);
  // C4–N5–Ca5–C5 is the 1–4 pair ϕ rotates: at ϕ = 0 the two carbons are eclipsed
  assert.ok(clashes.some(c => [c.a, c.b].sort().join() === 'C4,C5'), 'C4···C5 at ϕ = 0');
});

test('clashes are marked once per pair of groups, however many atoms touch', () => {
  const page = loadPage();
  page.run('setAngles(0, 0)');
  const atoms = page.run("findClashes(buildChain(), Object.keys({ ...ATOM_STYLE }))");
  const groups = page.run("groupClashes(findClashes(buildChain(), Object.keys({ ...ATOM_STYLE })))");
  assert.ok(groups.length > 0 && groups.length < atoms.length, `${groups.length} groups from ${atoms.length} atoms`);
  assert.equal(page.run("atomGroup('O5')"), page.run("atomGroup('C5')"));
  assert.equal(page.run("atomGroup('HN5')"), page.run("atomGroup('N5')"));
  assert.equal(page.run("atomGroup('Ha5')"), page.run("atomGroup('Ca5')"));
  assert.notEqual(page.run("atomGroup('Cb5')"), page.run("atomGroup('Ca5')"));
  assert.notEqual(page.run("atomGroup('C5')"), page.run("atomGroup('C6')"));
  assert.equal(new Set(groups.map(g => [page.run(`atomGroup('${g.a}')`), page.run(`atomGroup('${g.b}')`)].sort().join())).size, groups.length);
  assert.equal(shownClashes(page), groups.length);
});

test('a clash is drawn as two arcs facing each other, not a line between the atoms', () => {
  const page = loadPage();
  page.dipeptide.calls.length = 0;
  page.run('drawClash({ x: 100, y: 50 }, { x: 200, y: 50 }, 10, 20)');
  const arcs = page.dipeptide.calls.filter(c => c.fn === 'arc');
  assert.equal(arcs.length, 2);
  assert.deepEqual(arcs.map(c => c.args.slice(0, 3)), [[100, 50, 14], [200, 50, 24]]);
  assertClose((arcs[0].args[3] + arcs[0].args[4]) / 2, 0, 1e-9, 'first arc faces the second');
  assertClose((arcs[1].args[3] + arcs[1].args[4]) / 2, Math.PI, 1e-9, 'second arc faces the first');
  assert.equal(page.dipeptide.calls.filter(c => c.fn === 'lineTo').length, 0, 'no line joins them');
});

test('only atoms on screen can clash', () => {
  const page = loadPage();
  page.run('setAngles(0, 0)');
  const bare = shownClashes(page);
  page.run('toggleExtra4()');
  assert.ok(shownClashes(page) > bare, 'more residues, more clashes');
  const shown = Object.keys(page.run('({ ...ATOM_STYLE })'));
  for (const { a, b } of page.run(`findClashes(buildChain(), ${JSON.stringify(shown)})`)) {
    assert.ok(shown.includes(a) && shown.includes(b), `${a}-${b}`);
  }
});

test('the viewer marks at most MAX_CLASHES_DRAWN pairs of groups', () => {
  const page = loadPage();
  page.run('toggleExtra4(); setAngles(180, 0)');
  assert.ok(page.run('groupClashes(findClashes(buildChain(), Object.keys(buildChain()))).length') > page.run('MAX_CLASHES_DRAWN'));
  assert.equal(shownClashes(page), page.run('MAX_CLASHES_DRAWN'));
});

test('no clash readout is listed on the page', () => {
  assert.ok(!IDS.includes('clash-display'));
  const page = loadPage();
  page.run('setAngles(0, 0)');
  assert.equal(page.el('region-display').textContent, 'Disallowed region');
  assert.match(page.el('dipeptide').attrs['aria-label'], /steric clashes between groups/);
  assert.match(HTML, /\)\(<\/b>&nbsp;Steric clash/, 'the viewer legend explains the arcs');
});

test('the amide N···H contact at ψ = 0 is not a clash', () => {
  const page = loadPage();
  page.run('setAngles(-90, 0)');
  const atoms = page.run('buildChain()');
  assert.ok(dist(atoms.N5, atoms.HN6) < 2.2, 'the pair is inside the N···H limit');
  assert.equal(clashesFor(page).filter(c => [c.a, c.b].sort().join() === 'HN6,N5').length, 0);
});

for (const fn of ['setBetaTurnTypeI', 'setBetaTurnTypeII']) {
  test(`${fn} marks no clashes, and they return once the turn is off`, () => {
    const page = loadPage();
    page.run(`${fn}()`);
    assert.equal(shownClashes(page), 0);
    page.run('setAngles(-110, 110)');
    assert.equal(shownClashes(page), 0, 'still none while the sliders move the flanks');
    page.run(`${fn}(); setAngles(0, 0)`);
    assert.ok(shownClashes(page) > 0);
  });
}

// ── Glycine and proline ────────────────────────────────────────
test('the general plot is the default and matches REGIONS', () => {
  const page = loadPage();
  assert.equal(page.run('residueType'), 'general');
  assert.equal(page.run('REGION_SETS.general === REGIONS'), true);
  assert.match(HTML, /id="residue-general"[^>]*aria-pressed="true"/);
});

test('the residue buttons show which plot is active and rebuild it', () => {
  const page = loadPage();
  const cached = () => page.run('bgCache');
  const before = cached();
  page.run("setResidueType('gly')");
  assert.notEqual(cached(), before, 'plot background rebuilt');
  assert.equal(page.el('residue-gly').classList.contains('active'), true);
  assert.equal(page.el('residue-general').classList.contains('active'), false);
  assert.equal(page.el('residue-gly').attrs['aria-pressed'], 'true');
  assert.equal(page.el('residue-general').attrs['aria-pressed'], 'false');
});

test('the glycine plot is symmetric about the origin and wider than the general one', () => {
  const page = loadPage();
  const allowedShare = () => page.run(`(() => {
    let n = 0, total = 0;
    for (let p = -175; p < 180; p += 10) for (let q = -175; q < 180; q += 10) {
      total++;
      if (getRegion(p, q).level !== 'disallowed') n++;
    }
    return n / total;
  })()`);
  const general = allowedShare();
  page.run("setResidueType('gly')");
  assert.ok(allowedShare() > general * 1.5, 'more of the plot opens up');
  for (const [p, q] of [[-60, -45], [85, 0], [-75, 165], [170, 170], [30, -120]]) {
    assertClose(page.run(`computeScore(${p}, ${q}).total`), page.run(`computeScore(${-p}, ${-q}).total`), 1e-12, `(${p}, ${q})`);
  }
  assert.equal(page.run('getRegion(60, 45).level'), 'favored');
  assert.equal(page.run('getRegion(0, 0).level'), 'disallowed');
});

test('the glycine plot has a broad β basin and keeps everything favored in the general plot', () => {
  const page = loadPage();
  const favoredInGeneral = page.run(`(() => {
    const out = [];
    for (let p = -175; p < 180; p += 10) for (let q = -175; q < 180; q += 10) {
      if (getRegion(p, q).level === 'favored') out.push([p, q]);
    }
    return out;
  })()`);
  page.run("setResidueType('gly')");
  for (const [p, q] of [[-120, 130], [-150, 150], [-70, 150], [-100, 170], [120, -130], [150, -150]]) {
    assert.equal(page.run(`getRegion(${p}, ${q}).level`), 'favored', `(${p}, ${q})`);
  }
  for (const [p, q] of favoredInGeneral) {
    assert.notEqual(page.run(`getRegion(${p}, ${q}).level`), 'disallowed', `(${p}, ${q})`);
  }
});

test('the proline plot locks ϕ near −65°', () => {
  const page = loadPage();
  page.run("setResidueType('pro')");
  assert.equal(page.run('getRegion(-65, 145).level'), 'favored');
  assert.equal(page.run('getRegion(-65, -35).level'), 'favored');
  for (let q = -180; q <= 180; q += 15) {
    assert.equal(page.run(`getRegion(60, ${q}).level`), 'disallowed', `ϕ=60, ψ=${q}`);
    assert.equal(page.run(`getRegion(-140, ${q}).level`), 'disallowed', `ϕ=-140, ψ=${q}`);
  }
});

test('general scores do not change after visiting another plot', () => {
  const page = loadPage();
  const score = () => page.run('computeScore(-100, 100).total');
  const before = score();
  page.run("setResidueType('gly'); setResidueType('pro'); setResidueType('general')");
  assert.equal(score(), before);
});

test('in glycine the side chains become H and their clashes go away', () => {
  const page = loadPage();
  page.run("goToStructure('leftHelix')");
  assert.ok(shownClashes(page) > 0);
  page.run("setResidueType('gly')");
  assert.equal(shownClashes(page), 0);
  const atoms = page.run('buildChain()');
  assertClose(dist(atoms.Ca5, atoms.Cb5), 1.09, 1e-9, 'Cα–H length');
  page.run("setResidueType('general')");
  const back = page.run('buildChain()');
  assertClose(dist(back.Ca5, back.Cb5), 1.521, 1e-9, 'Cα–Cβ length');
  assert.ok(shownClashes(page) > 0);
});

test('the viewer draws H, not R, in glycine', () => {
  const page = loadPage();
  redraw(page);
  assert.ok(labels(page).some(l => l.startsWith('R')), 'R in general');
  page.run("setResidueType('gly')");
  redraw(page);
  assert.ok(!labels(page).some(l => l.startsWith('R')), 'no R in glycine');
});

test('Reset to 1 AA returns to the general plot', () => {
  const page = loadPage();
  page.run("setResidueType('pro'); resetToOneAA()");
  assert.equal(page.run('residueType'), 'general');
  assert.equal(page.el('residue-general').classList.contains('active'), true);
  assert.equal(page.el('residue-pro').classList.contains('active'), false);
});

test('the ribbon follows the active plot', () => {
  const page = loadPage();
  page.run("setResidueType('pro'); setAngles(-120, 130)");
  assert.equal(page.run('ribbonShown'), 'none', 'β angles are disallowed for proline');
  page.run("setResidueType('gly'); setAngles(170, 170)");
  assert.equal(page.run('ribbonShown'), 'sheet', 'extended glycine');
});

// ── Plot, ribbon and readout agree ─────────────────────────────
// What each preset is called must match everywhere it appears
const PRESET_NAMES = [
  ['alpha', 'α-helix', 'α-helix', 'α-helix'],
  ['antiparallel', 'Antiparallel β', 'Antiparallel β-sheet', 'antiparallel β-sheet'],
  ['parallel', 'Parallel β', 'Parallel β-sheet', 'parallel β-sheet'],
  ['ppII', 'PPII', 'Polyproline II helix', 'polyproline II helix'],
  ['leftHelix', 'Left-handed helix', 'Left-handed helix', 'left-handed helix'],
  ['helix310', '3₁₀ helix', '3₁₀ helix', '3₁₀ helix'],
];
for (const [name, button, caption, region] of PRESET_NAMES) {
  test(`the ${name} preset's button, ribbon and region readout all name the same structure`, () => {
    assert.ok(HTML.includes(`onclick="goToStructure('${name}')">${button}</button>`), 'button');
    const page = loadPage();
    page.run(`goToStructure('${name}')`);
    assert.ok(page.el('ribbon-caption').textContent.startsWith(caption), page.el('ribbon-caption').textContent);
    assert.ok(page.el('ribbon').attrs['aria-label'].includes(caption), 'ribbon label');
    assert.ok(page.el('region-display').textContent.endsWith(`— ${region}`), page.el('region-display').textContent);
    assert.equal(page.run('ribbonShown'), page.run(`STRUCTURES.${name}.ribbon`));
    assert.notEqual(page.run(`getRegion(${page.run(`STRUCTURES.${name}.angles[0]`)}, ${page.run(`STRUCTURES.${name}.angles[1]`)}).level`), 'disallowed', 'preset sits in an open region');
  });
}

test('every point on every plot shows a ribbon matching its region', () => {
  const page = loadPage();
  const EXPECTED = {
    'alpha-helix': 'helix', 'left-hand helix': 'leftHelix', 'PPII / beta': 'ppII',
    'beta-sheet': 'sheet', extended: 'sheet', 'gamma-turn': 'gammaTurn', '': 'none',
  };
  for (const type of ['general', 'gly', 'pro']) {
    page.run(`setResidueType('${type}')`);
    const seen = new Set();
    const pairs = page.run(`(() => {
      const out = [];
      for (let p = -180; p <= 180; p += 15) for (let q = -180; q <= 180; q += 15) {
        out.push([getRegion(p, q).name, ribbonStructure(p, q), p, q]);
      }
      return out;
    })()`);
    for (const [region, ribbon, p, q] of pairs) {
      seen.add(region);
      assert.ok(region in EXPECTED, `unmapped region "${region}"`);
      assert.equal(ribbon, EXPECTED[region], `${type} (${p}, ${q}) "${region}"`);
    }
    assert.ok(seen.size > 1, type);
  }
});

test('moving the angles off a preset returns the ribbon and readout to the plot region', () => {
  const page = loadPage();
  page.run("goToStructure('parallel'); setAngles(-120, 130)");
  assert.equal(page.run('activeStructure'), null);
  assert.equal(page.run('ribbonShown'), 'sheet');
  assert.equal(page.el('region-display').textContent, 'Favored — beta-sheet');
  page.run("goToStructure('helix310'); setResidueType('gly')");
  assert.equal(page.run('activeStructure'), null, 'a new plot drops the preset');
  page.run("setResidueType('general'); goToStructure('parallel'); setBetaTurnTypeI()");
  assert.equal(page.run('activeStructure'), null, 'a β-turn drops the preset');
  assert.equal(page.run('ribbonShown'), 'sheet');
  page.run("setBetaTurnTypeI(); goToStructure('helix310'); resetToOneAA()");
  assert.equal(page.run('activeStructure'), null, 'Reset drops the preset');
});

test('the plot hint no longer advertises the arrow keys', () => {
  for (const m of HTML.matchAll(/class="plot-hint"[^>]*>(.*?)<\/p>/g)) assert.doesNotMatch(m[1], /arrow key/i);
  assert.doesNotMatch(HTML.match(/id="dipeptide-hint">(.*?)<\/span>/)[1], /arrow key/i);
});

// ── Recentering when residues change ───────────────────────────
const shownBox = page => page.run(`(() => {
  const atoms = buildChain();
  const anchor = (showNterm || showCterm) ? null : caAnchorRotation(atoms);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const key of Object.keys(shownAtomStyle())) {
    const c = sub3(atoms[key], atoms.Ca5);
    const p = project(rotateView(anchor ? mApply(anchor, c) : c), dipScale, DW*0.48 + dipOffX, DH*0.52 + dipOffY);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  return { minX, maxX, minY, maxY };
})()`);
function assertCentered(page, label) {
  const b = shownBox(page);
  assertClose((b.minX + b.maxX) / 2, 250, 1e-6, `${label}: x center`);
  assertClose((b.minY + b.maxY) / 2, 130.5, 1e-6, `${label}: y center`);
  assert.ok(b.minX >= 0 && b.maxX <= 500 && b.minY >= 0 && b.maxY <= 261, `${label}: on the canvas`);
}

const RESIDUE_BUTTONS = ['toggleNterm', 'toggleCterm', 'toggleExtra2', 'toggleExtra4'];
for (const fn of RESIDUE_BUTTONS) {
  test(`${fn} recenters and fits the peptide, adding and removing`, () => {
    const page = loadPage();
    page.run('applyRotStep(4, 7); applyZoom(60); applyPan(-120, 90)');
    const view = JSON.stringify(page.run('viewMatrix'));
    page.run(`${fn}()`);
    assertCentered(page, 'added');
    assert.equal(JSON.stringify(page.run('viewMatrix')), view, 'keeps the rotation');
    page.run('applyZoom(60); applyPan(70, -40)');
    page.run(`${fn}()`);
    assertCentered(page, 'removed');
  });
}

test('adding residues zooms out and removing them zooms back in, to the default at most', () => {
  const page = loadPage();
  const scales = [page.run('dipScale')];
  for (const step of ['toggleNterm()', 'toggleCterm()', 'toggleExtra2()', 'toggleExtra4()']) {
    page.run(step);
    scales.push(page.run('dipScale'));
    assertCentered(page, step);
  }
  assert.ok(scales.at(-1) < scales[0], 'the full chain is zoomed out');
  for (let i = 1; i < scales.length; i++) assert.ok(scales[i] <= scales[i - 1] + 1e-9, `${scales}`);
  page.run('toggleExtra4(); toggleExtra2(); toggleCterm(); toggleNterm()');
  assert.equal(page.run('dipScale'), scales[0], 'back at the starting zoom');
  assertCentered(page, 'back to one residue');
});

test('removing a terminal residue that drops the extras still fits what is left', () => {
  const page = loadPage();
  page.run('toggleExtra4(); toggleNterm()');
  assert.equal(page.run('showExtra2 || showExtra4'), false);
  assertCentered(page, 'after dropping the extras');
});

// ── Layout details ─────────────────────────────────────────────
test('the plot box has no notes under the residue buttons, only the click-or-drag hint', () => {
  assert.ok(!IDS.includes('residue-note'));
  const box = HTML.slice(HTML.indexOf('<div id="plot-wrapper">'), HTML.indexOf('<canvas id="plot"'));
  assert.equal([...box.matchAll(/class="plot-hint"/g)].length, 1);
  assert.match(box, /<b>Click or drag<\/b> on the plot to move the point\./);
});

test('the plot is 10% smaller and starts right below the hint', () => {
  const page = loadPage();
  assert.equal(page.run('PW'), 369, '10% smaller than the old 410');
  assert.ok(page.run('MT') <= 10, 'no blank band above the plot');
  assert.ok(HTML.includes(`<canvas id="plot" width="${page.run('W')}" height="${page.run('H')}"`), 'markup and script agree');
  assert.equal(page.run('M + PW + M'), page.run('W'));
  assert.equal(page.run('MT + PW + MB'), page.run('H'));
});

test('the viewer and ribbon canvases are 10% shorter, in markup and script alike', () => {
  const page = loadPage();
  assert.equal(page.run('DH'), 261);
  assert.ok(HTML.includes('<canvas id="dipeptide" width="500" height="261"'));
  assert.equal(page.run('RH'), 150);
  assert.ok(HTML.includes('<canvas id="ribbon" width="456" height="150"'));
});

test('the plot legend runs Favored over Allowed and Disallowed over Current angles', () => {
  const items = [...HTML.matchAll(/class="legend-item">.*?<\/div>([^<]+)<\/div>/g)].map(m => m[1]);
  // A two-column grid fills across, so this order stacks those pairs
  assert.deepEqual(items, ['Favored', 'Disallowed', 'Allowed', 'Current angles']);
});

test('the Steric clash legend overlays the viewer', () => {
  const wrapper = HTML.slice(HTML.indexOf('<div id="dipeptide-wrapper">'), HTML.indexOf('<div id="dipeptide-legend">'));
  assert.match(wrapper, /id="clash-legend"><b[^>]*>\)\(<\/b>&nbsp;Steric clash/);
  const below = HTML.slice(HTML.indexOf('<div id="dipeptide-legend">'), HTML.indexOf('<div id="structure-presets">'));
  assert.doesNotMatch(below, /Steric clash/);
  assert.match(HTML, /#clash-legend \{[^}]*position: absolute;[^}]*right: 8px;[^}]*bottom: 6px;/);
});

test('the rotate buttons are half size and stay in the top right corner', () => {
  assert.match(HTML, /#rotate-btns \{[^}]*top: 10px;[^}]*right: 10px;[^}]*repeat\(3, 15px\)/);
  assert.match(HTML, /#rotate-btns \.rot-btn \{ width: 15px; height: 15px;/);
});

test('section titles use the requested wording and two are centered', () => {
  for (const title of ['Typical Structure at Selected Angles', 'Dihedral Angles']) {
    assert.ok(HTML.includes(`class="panel-section-title centered-title">${title}<`), title);
  }
  assert.match(HTML, /\.centered-title \{ text-align: center; \}/);
  assert.ok(HTML.includes('>Show Specific Fold<'));
  assert.doesNotMatch(HTML, /Go to Structure|at These Angles/);
});

// ── Ribbon details ─────────────────────────────────────────────
const ribbonText = page => page.el('ribbon').context.calls.filter(c => c.fn === 'fillText').map(c => c.args);
for (const [p, q, name] of [[-120, 130, 'sheet'], [-139, 135, 'antiparallel']]) {
  test(`the ${name} ribbon labels the N and C ends`, () => {
    const page = loadPage();
    page.run("setAngles(-60, -45)");
    page.el('ribbon').context.calls.length = 0;
    if (name === 'sheet') page.run(`setAngles(${p}, ${q})`); else page.run(`goToStructure('${name}')`);
    assert.deepEqual(ribbonText(page).slice(-2).map(a => a[0]), ['N', 'C']);
  });
}

test('parallel and antiparallel ribbons start at N on the left and end at C on the right', () => {
  const page = loadPage();
  for (const name of ['parallel', 'antiparallel']) {
    page.run("setAngles(-60, -45)");
    page.el('ribbon').context.calls.length = 0;
    page.run(`goToStructure('${name}')`);
    const [[, nx, ny], [, cx, cy]] = ribbonText(page).slice(-2);
    assert.ok(nx < 50 && nx >= 0, `${name} N at x=${nx}`);
    assert.ok(cx > 406 && cx <= 456, `${name} C at x=${cx}`);
    assert.ok(ny < cy, `${name}: N on the top strand, C on the bottom`);
    assert.ok(ny >= 0 && cy <= 150, `${name}: on the canvas`);
  }
});

test('the helix arrowheads run straight, like the stretched-out PPII one', () => {
  const page = loadPage();
  for (const kind of ['helix', 'leftHelix', 'helix310']) {
    const at = t => page.run(`helixRibbonPoint(${t}, 0, HELIX_SHAPES.${kind})`);
    const start = page.run(`HELIX_SHAPES.${kind}.headStart`);
    const [a, b, c] = [at(start), at((start + 1) / 2), at(1)];
    assertClose(dist(a, b) + dist(b, c), dist(a, c), 1e-9, `${kind} head is straight`);
  }
  const ppII = page.run('HELIX_SHAPES.ppII');
  assert.deepEqual({ ...ppII }, { hand: -1, turns: 2.25, r: 24, pitch: 150, halfWidth: 12 }, 'PPII stays as it was');
  assert.equal(page.run('HELIX_HEAD'), 0.07);
  assert.equal(page.run('HELIX_FLARE'), 2.2);
});

test('the γ-turn image marks its three residues, the H-bond and both ends', () => {
  const page = loadPage();
  page.el('ribbon').context.calls.length = 0;
  page.run('setAngles(75, -64)');
  assert.equal(page.run('ribbonShown'), 'gammaTurn');
  const text = ribbonText(page);
  assert.deepEqual(text.map(a => a[0]).sort(), ['C', 'H-bond', 'N', 'i', 'i+1', 'i+2']);
  for (const [label, x, y] of text) {
    assert.ok(x >= 0 && x <= 456 && y >= 0 && y <= 150, `${label} at ${x}, ${y}`);
  }
  assert.ok(page.el('ribbon').context.calls.some(c => c.fn === 'setLineDash' && c.args[0].length === 2), 'dashed H-bond');
});
