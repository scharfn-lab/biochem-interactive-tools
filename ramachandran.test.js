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
  assert.equal(topLeft.y, page.run('M'));
  const bottomRight = page.run('toCanvas(180, -180)');
  assert.equal(bottomRight.x, page.run('W - M'));
  assert.equal(bottomRight.y, page.run('H - M'));
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
  plot.fire('mousedown', { clientX: 260, clientY: 260 });
  assertClose(page.run('phi'), 0, 1e-9, 'phi at center');
  assertClose(page.run('psi'), 0, 1e-9, 'psi at center');

  plot.fire('mousemove', { clientX: 55, clientY: 55 });
  assertClose(page.run('phi'), -180, 1e-9, 'phi while dragging');
  assertClose(page.run('psi'), 180, 1e-9, 'psi while dragging');

  plot.fire('mousemove', { clientX: 10, clientY: 10 });
  assertClose(page.run('phi'), -180, 1e-9, 'margin is ignored');

  page.document.fire('mouseup');
  plot.fire('mousemove', { clientX: 260, clientY: 260 });
  assertClose(page.run('phi'), -180, 1e-9, 'moves after release are ignored');
});

test('pointer coordinates account for CSS scaling of the canvas', () => {
  const page = loadPage();
  const plot = page.el('plot');
  plot.rect = { left: 100, top: 50, width: 260, height: 260 };
  plot.fire('mousedown', { clientX: 230, clientY: 180 });
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
  page.run('toggleNterm()');
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
      assertClose((b.minY + b.maxY) / 2, 145, 1e-6, `y center after ${prior}`);
      // Largest atom radius at this zoom must also stay on the canvas
      const r = 14 * page.run('dipScale') / 44;
      assert.ok(b.minX - r >= 0 && b.maxX + r <= 500, `x range ${b.minX}–${b.maxX}`);
      assert.ok(b.minY - r >= 0 && b.maxY + r <= 290, `y range ${b.minY}–${b.maxY}`);
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
  [-75, 148, 'sheet', 'β-sheet / extended strand'],
  [80, -60, 'none', 'No regular secondary structure at these angles'],
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
const helixTwist = (page, hand) => {
  const at = t => page.run(`helixRibbonPoint(${t}, 0, ${hand})`);
  const [a, b, c, d] = [0.30, 0.31, 0.32, 0.33].map(at);
  return dot(cross(sub(b, a), sub(c, b)), sub(d, c));
};
test('the helix ribbon is right-handed and its mirror image left-handed', () => {
  const page = loadPage();
  assert.ok(helixTwist(page, 1) > 0, 'right-handed');
  assert.ok(helixTwist(page, -1) < 0, 'left-handed');
});

test('both helix hands stay on the ribbon canvas', () => {
  const page = loadPage();
  for (const hand of [1, -1]) {
    for (let t = 0; t <= 1; t += 0.01) {
      for (const s of [-1, 1]) {
        const p = page.run(`helixRibbonPoint(${t}, ${s}, ${hand})`);
        assert.ok(Math.abs(p.x) <= 228 && Math.abs(p.y) <= 88, `t=${t} s=${s}: ${p.x}, ${p.y}`);
      }
    }
  }
});
