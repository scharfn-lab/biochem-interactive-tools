// Tests for enzyme_kinetics.html. No dependencies — run with: node --test
//
// The page's kinetics and formatting section touches no DOM, so it runs unmodified in a Node vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'enzyme_kinetics.html'), 'utf8');
const SECTION = HTML.slice(HTML.indexOf('// ═══ 2.'), HTML.indexOf('// ═══ 3.'));
const page = vm.createContext({});
vm.runInContext(SECTION, page);
const { factors, constants, v0, fmtSig, fmtCompact, tickLabels, niceScale, parseAnswer, isCorrect, lineEquation } = page;
const validate = raw => page.validate(raw);
const buildModel = p => page.buildModel(p);

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not near ${expected}`);
}

const VALID = { type: 'competitive', compare: false, auto: true, Km: '10', kcat: '100', Etot: '0.01', I: '10', Ki: '5', KiP: '5', I2: '20', Smax: '', Smin: '', points: '' };
const fieldsWithErrors = raw => [...validate({ ...VALID, ...raw }).errors].map(e => e.field);   // spread: vm arrays fail strict equality

// ── Hand calculations from the spec (Vmax = 1 µM/s) ─────────────
const HAND_CASES = [
  { type: 'competitive',   Ki: 5, KiP: 5,  alpha: 3, alphaP: 1,   appKm: 30,     appVmax: 1 },
  { type: 'uncompetitive', Ki: 5, KiP: 5,  alpha: 1, alphaP: 3,   appKm: 10 / 3, appVmax: 1 / 3 },
  { type: 'mixed',         Ki: 5, KiP: 20, alpha: 3, alphaP: 1.5, appKm: 20,     appVmax: 2 / 3 },
];

for (const c of HAND_CASES) {
  test(`${c.type} matches the hand calculation, including L-B slope and y-intercept`, () => {
    const { alpha, alphaP } = factors(c.type, 10, c.Ki, c.KiP);
    assert.equal(alpha, c.alpha);
    assert.equal(alphaP, c.alphaP);
    const Vmax = 100 * 0.01;
    assert.equal(Vmax, 1);
    const k = constants(Vmax, 10, alpha, alphaP);
    near(k.appKm, c.appKm);
    near(k.appVmax, c.appVmax);
    near(k.slope, alpha * 10 / Vmax);
    near(k.yInt, alphaP / Vmax);
  });
}

test('none and pure noncompetitive', () => {
  assert.equal(factors('none', 10, 5, 5).alpha, 1);
  assert.equal(factors('none', 10, 5, 5).alphaP, 1);
  const { alpha, alphaP } = factors('noncompetitive', 10, 5, 999);
  assert.equal(alpha, 3);
  assert.equal(alphaP, 3);
  const k = constants(1, 10, alpha, alphaP);
  near(k.appKm, 10);   // Km is unchanged
  near(k.appVmax, 1 / 3);
});

test('v₀ follows the rate law and saturates at appVmax', () => {
  const k = constants(1, 10, 3, 1.5);
  near(v0(k, 20), 1 * 20 / (3 * 10 + 1.5 * 20));
  assert.equal(v0(k, 0), 0);
  near(v0(k, 1e12), k.appVmax, 1e-6);
});

test('both plots agree: L-B points lie on the line given by slope and y-intercept', () => {
  const m = buildModel({ type: 'mixed', compare: false, auto: true, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 20 });
  for (const c of m.curves) {
    for (const p of c.lb) near(p.y, c.k.slope * p.x + c.k.yInt, 1e-9);
  }
});

// ── [S] range ───────────────────────────────────────────────────
test('auto range uses 10 × the largest of Km and every appKm, and 0.1 × Km for [S]min', () => {
  const base = { compare: false, auto: true, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 5 };
  assert.equal(buildModel({ ...base, type: 'competitive' }).range.Smax, 300);
  assert.equal(buildModel({ ...base, type: 'uncompetitive' }).range.Smax, 100);   // Km beats appKm = 3.33
  const two = buildModel({ ...base, type: 'competitive', compare: true, I2: 20 }).range;
  assert.equal(two.Smax, 500);   // second [I]: appKm = 50
  assert.equal(two.Smin, 1);
  assert.equal(two.points, 200);
});

test('M-M starts at [S] = 0; L-B never reaches it and stays inside [S]min..[S]max', () => {
  const m = buildModel({ type: 'competitive', compare: false, auto: false, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 5, Smax: 50, Smin: 2, points: 25 });
  const c = m.curves[1];
  assert.equal(c.mm.length, 25);
  assert.equal(c.lb.length, 25);
  assert.equal(c.mm[0].x, 0);
  assert.equal(c.mm[24].x, 50);
  near(c.lb[0].x, 1 / 50);
  near(c.lb[24].x, 1 / 2);
  assert.ok(c.lb.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0));
});

test('curves shown: None has only the uninhibited curve, even with the second [I] checked', () => {
  const ids = raw => [...buildModel(validate({ ...VALID, ...raw }).params).curves].map(c => c.id);
  assert.deepEqual(ids({ type: 'none', compare: true }), ['uninhibited']);
  assert.deepEqual(ids({}), ['uninhibited', 'first']);
  assert.deepEqual(ids({ compare: true }), ['uninhibited', 'first', 'second']);
});

// ── Kinetics tab comparisons ──────────────────────────────────
const kineticsModel = raw => buildModel(validate({ ...VALID, mode: 'kinetics', compareBy: 'none', Etot2: '0.02', kcat2: '200', Km2: '20', ...raw }).params);

test('Kinetics with no comparison has one curve and ignores inhibition', () => {
  const m = kineticsModel({ type: 'competitive', I: '10' });
  assert.equal(m.curves.length, 1);
  assert.equal(m.curves[0].k.alpha, 1);
  assert.equal(m.curves[0].k.alphaP, 1);
  assert.equal(m.curves[0].k.appKm, 10);
});

test('comparing [E]total or kcat changes Vmax only; comparing Km changes Km only', () => {
  const pair = by => [...kineticsModel({ compareBy: by }).curves].map(c => [c.k.Vmax, c.k.Km]);
  assert.deepEqual(pair('Etot'), [[1, 10], [2, 10]]);
  assert.deepEqual(pair('kcat'), [[1, 10], [2, 10]]);
  assert.deepEqual(pair('Km'), [[1, 10], [1, 20]]);
});

test('auto [S] range covers both Km values being compared', () => {
  const larger = kineticsModel({ compareBy: 'Km', Km2: '40' }).range;
  assert.equal(larger.Smax, 400);
  assert.equal(larger.Smin, 1);
  const smaller = kineticsModel({ compareBy: 'Km', Km2: '2' }).range;
  assert.equal(smaller.Smax, 100);
  near(smaller.Smin, 0.2);
});

test('only the second value being compared is validated, and only on the Kinetics tab', () => {
  const errs = raw => [...validate({ ...VALID, mode: 'kinetics', compareBy: 'kcat', Etot2: '', kcat2: '200', Km2: '', ...raw }).errors].map(e => e.field);
  assert.deepEqual(errs({}), []);
  assert.deepEqual(errs({ kcat2: '0' }), ['kcat2']);
  assert.deepEqual(errs({ I: '-1', Ki: '' }), []);   // inhibition fields are not in use
  assert.deepEqual(fieldsWithErrors({ mode: 'inhibition', compareBy: 'kcat', kcat2: '' }), []);
});

// ── Validation ──────────────────────────────────────────────────
test('values must be positive, except [I], which may be 0', () => {
  assert.deepEqual(fieldsWithErrors({}), []);
  assert.deepEqual(fieldsWithErrors({ I: '0' }), []);
  assert.deepEqual(fieldsWithErrors({ compare: true, I2: '0' }), []);
  for (const bad of ['', '   ', '0', '-1', 'abc', '1e999']) {
    assert.deepEqual(fieldsWithErrors({ Km: bad }), ['Km'], `Km = "${bad}"`);
  }
  assert.deepEqual(fieldsWithErrors({ I: '-1' }), ['I']);
});

test('disabled fields are ignored', () => {
  assert.deepEqual(fieldsWithErrors({ type: 'none', I: '', Ki: '', KiP: '' }), []);
  assert.deepEqual(fieldsWithErrors({ type: 'competitive', KiP: '' }), []);
  assert.deepEqual(fieldsWithErrors({ type: 'uncompetitive', Ki: '' }), []);
  assert.deepEqual(fieldsWithErrors({ type: 'noncompetitive', KiP: '' }), []);
  assert.deepEqual(fieldsWithErrors({ compare: false, I2: '' }), []);
  assert.deepEqual(fieldsWithErrors({ auto: true, Smax: '-5' }), []);
});

test('noncompetitive locks Ki\' to Ki whatever the Ki\' field holds', () => {
  assert.equal(validate({ ...VALID, type: 'noncompetitive', Ki: '7', KiP: '100' }).params.KiP, 7);
});

test('manual range is validated', () => {
  const manual = { auto: false, Smax: '100', Smin: '1', points: '50' };
  assert.deepEqual(fieldsWithErrors(manual), []);
  assert.deepEqual(fieldsWithErrors({ ...manual, Smin: '100' }), ['Smin']);
  assert.deepEqual(fieldsWithErrors({ ...manual, Smin: '0' }), ['Smin']);
  assert.deepEqual(fieldsWithErrors({ ...manual, points: '2.5' }), ['points']);
  assert.deepEqual(fieldsWithErrors({ ...manual, points: '1' }), ['points']);
  assert.deepEqual(fieldsWithErrors({ ...manual, points: '1000000' }), ['points']);
});

test('values that overflow when combined are rejected', () => {
  assert.equal(validate({ ...VALID, kcat: '1e308', Etot: '1e308' }).errors.length, 1);
});

// ── Number formatting ───────────────────────────────────────────
test('fmtSig gives 3 significant figures with scientific notation at the thresholds', () => {
  const cases = [
    [0.0025, '2.50 × 10⁻³'], [0.01, '0.0100'], [0.00999, '9.99 × 10⁻³'],
    [0.333333, '0.333'], [1, '1.00'], [3.33333, '3.33'], [30, '30.0'], [100, '100'],
    [999.9, '1000'], [1234, '1230'], [9994, '9990'],
    [9996, '1.00 × 10⁴'], [10000, '1.00 × 10⁴'], [123456, '1.23 × 10⁵'],
    [-0.0333, '−0.0333'], [-0.0025, '−2.50 × 10⁻³'], [0, '0'],
  ];
  for (const [x, text] of cases) assert.equal(fmtSig(x), text, String(x));
});

test('fmtCompact drops trailing zeros for [I] labels', () => {
  assert.equal(fmtCompact(5), '5');
  assert.equal(fmtCompact(0), '0');
  assert.equal(fmtCompact(12.345), '12.3');
  assert.equal(fmtCompact(0.005), '5 × 10⁻³');
});

test('lineEquation gives y = mx + b from the L-B slope and y-intercept', () => {
  assert.equal(lineEquation(constants(1, 10, 3, 1)), 'y = 30.0x + 1.00');     // competitive
  assert.equal(lineEquation(constants(1, 10, 1, 3)), 'y = 10.0x + 3.00');     // uncompetitive
  assert.equal(lineEquation(constants(1, 10, 3, 1.5)), 'y = 30.0x + 1.50');   // mixed
  assert.equal(lineEquation(constants(5e-6, 1e-9, 1, 1)), 'y = 2.00×10⁻⁴x + 2.00×10⁵');
});

test('niceScale gives clean ticks without floating-point residue', () => {
  assert.deepEqual([...niceScale(1.08, 5).ticks], [0, 0.5, 1, 1.5]);
  assert.deepEqual([...niceScale(300, 6).ticks], [0, 50, 100, 150, 200, 250, 300]);
  assert.deepEqual([...niceScale(0.6, 3).ticks], [0, 0.2, 0.4, 0.6]);
  assert.ok(niceScale(7.3e-9, 5).max >= 7.3e-9);
});

test('tick labels on an axis share one notation', () => {
  assert.deepEqual([...tickLabels([0, 0.5, 1])], ['0', '0.5', '1']);
  assert.deepEqual([...tickLabels([0, 0.005, 0.01])], ['0', '5 × 10⁻³', '1 × 10⁻²']);
  assert.deepEqual([...tickLabels([0, 5000, 10000])], ['0', '5 × 10³', '1 × 10⁴']);
});

// ── Quiz checking ───────────────────────────────────────────────
test('answers are read in every notation a student might use', () => {
  for (const text of ['0.0025', '.0025', '2.5e-3', '2.5E-3', '2.5 x 10^-3', '2.5×10^-3', '2.50 × 10⁻³', '2.5*10^-3']) {
    near(parseAnswer(text), 0.0025);
  }
  near(parseAnswer('−0.0333'), -0.0333);
  near(parseAnswer(fmtSig(-0.0025)), -0.0025);
  near(parseAnswer(fmtSig(123456)), 123000);
  assert.ok(Number.isNaN(parseAnswer('')));
  assert.ok(Number.isNaN(parseAnswer('abc')));
});

test('answers count within ±2% of the true value, sign included', () => {
  assert.ok(isCorrect(1.02, 1));   // exactly 2% must pass despite rounding
  assert.ok(isCorrect(0.98, 1));
  assert.ok(!isCorrect(1.021, 1));
  assert.ok(!isCorrect(0.979, 1));
  assert.ok(isCorrect(-0.0333, -1 / 30));
  assert.ok(!isCorrect(0.0333, -1 / 30));
  assert.ok(!isCorrect(NaN, 1));
});

test('every displayed value, typed back in, is accepted as correct', () => {
  const m = buildModel({ type: 'mixed', compare: false, auto: true, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 20 });
  for (const c of m.curves) {
    for (const key of ['Vmax', 'appVmax', 'Km', 'appKm', 'alpha', 'alphaP', 'slope', 'yInt']) {
      assert.ok(isCorrect(parseAnswer(fmtSig(c.k[key])), c.k[key]), `${key} = ${c.k[key]}`);
    }
  }
});
