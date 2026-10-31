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
const differingParameter = p => page.differingParameter(p);
const randomParameters = (rand, units) => page.randomParameters(rand, units);
const { timeToReach, productAt, progressCurve, measuredRate, ratesTimeEnd } = page;

// A repeatable random sequence, so a failure can be reproduced.
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const NM_PER_UNIT = { nM: 1, 'µM': 1e3, mM: 1e6 };

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not near ${expected}`);
}

const VALID = { type: 'competitive', compare: false, Km: '10', kcat: '100', Etot: '0.01', I: '10', Ki: '5', KiP: '5', I2: '20' };
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
  const m = buildModel({ type: 'mixed', compare: false, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 20 });
  for (const c of m.curves) {
    for (const p of c.lb) near(p.y, c.k.slope * p.x + c.k.yInt, 1e-9);
  }
});

// ── [S] range ───────────────────────────────────────────────────
test('auto range uses 10 × the largest of Km and every appKm, and 0.1 × Km for [S]min', () => {
  const base = { compare: false, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 5 };
  assert.equal(buildModel({ ...base, type: 'competitive' }).range.Smax, 300);
  assert.equal(buildModel({ ...base, type: 'uncompetitive' }).range.Smax, 100);   // Km beats appKm = 3.33
  const two = buildModel({ ...base, type: 'competitive', compare: true, I2: 20 }).range;
  assert.equal(two.Smax, 500);   // second [I]: appKm = 50
  assert.equal(two.Smin, 1);
  assert.equal(two.points, 200);
});

test('M-M starts at [S] = 0; L-B never reaches it and stays inside [S]min..[S]max', () => {
  const m = buildModel({ type: 'competitive', compare: false, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 5 });
  const c = m.curves[1];
  assert.equal(c.mm.length, 200);
  assert.equal(c.lb.length, 200);
  assert.equal(c.mm[0].x, 0);
  near(c.mm[199].x, 300);
  near(c.lb[0].x, 1 / 300);
  near(c.lb[199].x, 1);
  assert.ok(c.lb.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0));
});

test('curves shown: None has only the uninhibited curve, even with the second [I] checked', () => {
  const ids = raw => [...buildModel(validate({ ...VALID, ...raw }).params).curves].map(c => c.id);
  assert.deepEqual(ids({ type: 'none', compare: true }), ['uninhibited']);
  assert.deepEqual(ids({}), ['uninhibited', 'first']);
  assert.deepEqual(ids({ compare: true }), ['uninhibited', 'first', 'second']);
});

// ── Kinetics tab: Conditions A and B ────────────────────────────
const CONDITIONS = { mode: 'kinetics', Km2: '10', kcat2: '100', Etot2: '0.02' };
const kineticsModel = raw => buildModel(validate({ ...VALID, ...CONDITIONS, ...raw }).params);

test('Kinetics always has curves for Conditions A and B, and ignores inhibition', () => {
  const m = kineticsModel({ type: 'competitive', I: '10' });
  assert.deepEqual([...m.curves].map(c => c.label), ['Conditions A', 'Conditions B']);
  assert.ok([...m.curves].every(c => c.k.alpha === 1 && c.k.alphaP === 1));
  assert.equal(m.curves[0].k.appKm, 10);
});

test('each curve uses its own conditions, and B can differ in several parameters at once', () => {
  const k = kineticsModel({ Km2: '40', kcat2: '50', Etot2: '0.04' }).curves;
  assert.equal(k[0].k.Vmax, 1);
  assert.equal(k[0].k.Km, 10);
  assert.equal(k[1].k.Vmax, 2);
  assert.equal(k[1].k.Km, 40);
});

test('differingParameter names the one parameter that differs, or null', () => {
  const p = { Km: 10, kcat: 100, Etot: 0.01, Km2: 10, kcat2: 100, Etot2: 0.01 };
  assert.equal(differingParameter(p), null);
  assert.equal(differingParameter({ ...p, Km2: 20 }), 'Km');
  assert.equal(differingParameter({ ...p, kcat2: 200 }), 'kcat');
  assert.equal(differingParameter({ ...p, Etot2: 0.02 }), 'Etot');
  assert.equal(differingParameter({ ...p, Km2: 20, kcat2: 200 }), null);
});

test('kcat/Km: hand calculation, and it follows kcat and Km but not [E]total', () => {
  const ratio = raw => kineticsModel(raw).curves[1].k.kcatOverKm;
  assert.equal(kineticsModel({}).curves[0].k.kcatOverKm, 10);        // 100/10
  assert.equal(ratio({ kcat2: '200' }), 20);
  assert.equal(ratio({ Km2: '40' }), 2.5);
  assert.equal(ratio({ Etot2: '0.5' }), 10);
});

test('kcat/Km sets the rate at low [S]: v₀ ≈ (kcat/Km)[E][S]', () => {
  const c = kineticsModel({ kcat2: '250', Km2: '40', Etot2: '0.03' }).curves[1];
  const S = 1e-6;
  near(v0(c.k, S) / (c.k.kcatOverKm * 0.03 * S), 1, 1e-6);
});

test('auto [S] range covers both Km values', () => {
  const larger = kineticsModel({ Km2: '40' }).range;
  assert.equal(larger.Smax, 400);
  assert.equal(larger.Smin, 1);
  const smaller = kineticsModel({ Km2: '2' }).range;
  assert.equal(smaller.Smax, 100);
  near(smaller.Smin, 0.2);
});

test('Conditions B is validated only on the Kinetics tab', () => {
  const errs = raw => [...validate({ ...VALID, ...CONDITIONS, ...raw }).errors].map(e => e.field);
  assert.deepEqual(errs({}), []);
  assert.deepEqual(errs({ kcat2: '0' }), ['kcat2']);
  assert.deepEqual(errs({ Km2: '', Etot2: '-1' }), ['Km2', 'Etot2']);
  assert.deepEqual(errs({ I: '-1', Ki: '' }), []);   // inhibition fields are not in use
  assert.deepEqual(fieldsWithErrors({ mode: 'inhibition', kcat2: '' }), []);
});

test('error messages say which conditions a Kinetics field belongs to', () => {
  const message = raw => validate({ ...VALID, ...CONDITIONS, ...raw }).errors[0].message;
  assert.equal(message({ Km: '-1' }), 'Km in Conditions A must be a positive number.');
  assert.equal(message({ Etot2: '-1' }), '[E]total in Conditions B must be a positive number.');
  assert.equal(validate({ ...VALID, Km: '-1' }).errors[0].message, 'Km must be a positive number.');
});

// ── Select Random Parameters ──────────────────────────────────
const RANDOM_DRAWS = 5000;
function eachRandomDraw(check) {
  const rand = seededRandom(317);
  for (let i = 0; i < RANDOM_DRAWS; i++) check(randomParameters(rand));
}
const asRaw = (r, extra) => {
  const raw = { ...r, compare: true, ...extra };
  for (const f of ['Km', 'kcat', 'Etot', 'I', 'Ki', 'KiP', 'I2', 'Km2', 'kcat2', 'Etot2']) raw[f] = String(r[f]);
  return raw;
};

test('random values pass validation on both tabs', () => {
  eachRandomDraw(r => {
    assert.equal(validate(asRaw(r, { mode: 'kinetics' })).errors.length, 0, JSON.stringify(r));
    assert.equal(validate(asRaw(r, { mode: 'inhibition' })).errors.length, 0, JSON.stringify(r));
  });
});

test('random concentrations stay between nM and high mM, and [E]total stays well below Km', () => {
  eachRandomDraw(r => {
    const nM = NM_PER_UNIT[r.concUnit];
    assert.ok(nM, r.concUnit);
    for (const f of ['Km', 'Etot', 'I', 'Ki', 'KiP', 'I2', 'Km2', 'Etot2']) {
      const value = r[f] * nM;
      assert.ok(value >= 0.99 && value <= 1e9, `${f} = ${r[f]} ${r.concUnit}`);
    }
    assert.ok(r.Etot <= r.Km * 0.11, JSON.stringify(r));
  });
});

test('random kcat stays in a realistic range for its time unit', () => {
  const perSecond = { s: 1, min: 1 / 60, h: 1 / 3600 };
  eachRandomDraw(r => {
    const rate = r.kcat * perSecond[r.timeUnit];
    assert.ok(rate >= 0.02 && rate <= 2100, `${r.kcat} per ${r.timeUnit}`);
  });
});

test('every random set visibly inhibits, under the chosen type and any other a student clicks', () => {
  eachRandomDraw(r => {
    assert.notEqual(r.type, 'none');
    for (const type of ['competitive', 'uncompetitive', 'noncompetitive', 'mixed']) {
      const params = validate(asRaw(r, { mode: 'inhibition', type })).params;
      const [plain, inhibited, second] = buildModel(params).curves;
      // The L-B line moves: its slope or intercept changes by at least 50%.
      const moved = Math.max(inhibited.k.slope / plain.k.slope, inhibited.k.yInt / plain.k.yInt);
      assert.ok(moved >= 1.5, `${type}: ${moved} ${JSON.stringify(r)}`);
      // The M-M curve moves too, at a substrate level on the plotted range.
      const at = plain.k.Km;
      assert.ok(v0(inhibited.k, at) <= v0(plain.k, at) * 0.8, `${type} ${JSON.stringify(r)}`);
      assert.ok(second.I > inhibited.I);
    }
  });
});

test('random mixed inhibition never looks noncompetitive', () => {
  eachRandomDraw(r => {
    const ratio = Math.max(r.Ki / r.KiP, r.KiP / r.Ki);
    assert.ok(ratio >= 1.3, JSON.stringify(r));
  });
});

test('random Conditions B differs from A in exactly one parameter', () => {
  eachRandomDraw(r => {
    assert.ok(['Km', 'kcat', 'Etot'].includes(differingParameter(r)), JSON.stringify(r));
  });
});

test('random draws reach every unit and inhibition type', () => {
  const seen = new Set();
  eachRandomDraw(r => { seen.add(r.concUnit); seen.add(r.timeUnit); seen.add(r.type); });
  for (const v of ['nM', 'µM', 'mM', 's', 'min', 'h', 'competitive', 'uncompetitive', 'noncompetitive', 'mixed']) {
    assert.ok(seen.has(v), v);
  }
  assert.ok(!seen.has('M'));
});

test('random values are rounded to 2 significant figures', () => {
  eachRandomDraw(r => {
    for (const f of ['Km', 'kcat', 'Etot', 'I', 'Ki', 'KiP', 'I2']) {
      assert.equal(Number(r[f].toPrecision(2)), r[f], `${f} = ${r[f]}`);
    }
  });
});

// ── Measuring Rates: progress curves ─────────────────────────
const ENZYME = constants(6, 25, 1, 1);   // Vmax = 6, Km = 25

test('the initial slope of a progress curve is v₀', () => {
  for (const S0 of [5, 25, 125]) {
    const t = 1e-5;
    near(productAt(ENZYME, S0, t) / t, v0(ENZYME, S0), 1e-4);
  }
});

test('productAt inverts the integrated rate law', () => {
  for (const [S0, S] of [[25, 20], [25, 5], [5, 0.5], [125, 100], [125, 1]]) {
    near(productAt(ENZYME, S0, timeToReach(ENZYME, S0, S)), S0 - S, 1e-8);
  }
  assert.equal(productAt(ENZYME, 25, 0), 0);
});

test('hand calculation: t = (Km·ln(S0/S) + S0 − S)/Vmax', () => {
  near(timeToReach(ENZYME, 25, 5), (25 * Math.log(5) + 20) / 6);
  near(ratesTimeEnd(ENZYME), (25 * Math.log(5) + 20) / 6);
});

test('progress curves start at zero, only rise, and never pass S0', () => {
  for (const S0 of [1, 25, 500]) {
    const pts = progressCurve(ENZYME, S0, 100);
    assert.equal(pts.length, 200);
    assert.equal(pts[0].y, 0);
    near(pts[199].x, 100);
    for (let i = 1; i < pts.length; i++) {
      assert.ok(pts[i].y >= pts[i - 1].y);
      assert.ok(pts[i].y <= S0);
    }
  }
});

test('the time axis shows low [S] levelling off and high [S] staying nearly straight', () => {
  const tEnd = ratesTimeEnd(ENZYME);
  near(productAt(ENZYME, 25, tEnd) / 25, 0.8, 1e-8);
  assert.ok(productAt(ENZYME, 5, tEnd) / 5 > 0.85);
  assert.ok(productAt(ENZYME, 125, tEnd) / 125 < 0.45);
});

test('a measured rate falls as the window widens and approaches v₀ as it narrows', () => {
  const tEnd = ratesTimeEnd(ENZYME);
  for (const S0 of [5, 25, 125]) {
    let last = Infinity;
    for (const pct of [1, 5, 25, 50, 100]) {
      const rate = measuredRate(ENZYME, S0, tEnd * pct / 100);
      assert.ok(rate < last && rate < v0(ENZYME, S0));
      last = rate;
    }
    near(measuredRate(ENZYME, S0, tEnd * 1e-6), v0(ENZYME, S0), 1e-4);
  }
});

test('the Measuring Rates tab reads only Conditions A and gives one uninhibited curve', () => {
  const { errors, params } = validate({ ...VALID, mode: 'rates', I: '-1', Ki: '', Km2: '' });
  assert.equal(errors.length, 0);
  assert.equal(params.mode, 'rates');
  const { curves } = buildModel(params);
  assert.equal(curves.length, 1);
  assert.equal(curves[0].k.appKm, 10);
});

test('a tolerance can be widened for values read from a plot', () => {
  assert.ok(isCorrect(1.1, 1, 0.1));
  assert.ok(!isCorrect(1.11, 1, 0.1));
  assert.ok(!isCorrect(1.1, 1));
});

test('random enzymes can share the same units', () => {
  const rand = seededRandom(5);
  for (let i = 0; i < 500; i++) {
    const r = randomParameters(rand, { conc: 'mM', time: 'min' });
    assert.equal(r.concUnit, 'mM');
    assert.equal(r.timeUnit, 'min');
    assert.ok(r.Km >= 0.5 && r.Km <= 200 && r.kcat >= 10 && r.kcat <= 5000, JSON.stringify(r));
  }
});

// ── Identify the Inhibitor ───────────────────────────────────
const checkInhibitorGuess = (truth, guess) => page.checkInhibitorGuess(truth, guess);

test('the challenge marks the type, then only the constants that type uses', () => {
  const mixed = { type: 'mixed', Ki: 6, KiP: 18 };
  assert.deepEqual({ ...checkInhibitorGuess(mixed, { type: 'mixed', Ki: '6', KiP: '18' }) }, { type: true, Ki: true, KiP: true });
  assert.deepEqual({ ...checkInhibitorGuess(mixed, { type: 'mixed', Ki: '7', KiP: '' }) }, { type: true, Ki: false, KiP: null });
  const competitive = { type: 'competitive', Ki: 6, KiP: 18 };
  assert.deepEqual({ ...checkInhibitorGuess(competitive, { type: 'competitive', Ki: '6', KiP: '999' }) }, { type: true, Ki: true, KiP: null });
  const uncompetitive = { type: 'uncompetitive', Ki: 6, KiP: 18 };
  assert.deepEqual({ ...checkInhibitorGuess(uncompetitive, { type: 'uncompetitive', Ki: '999', KiP: '18' }) }, { type: true, Ki: null, KiP: true });
});

test('a wrong type marks no constants, even if they are right', () => {
  const truth = { type: 'competitive', Ki: 6, KiP: 18 };
  assert.deepEqual({ ...checkInhibitorGuess(truth, { type: 'mixed', Ki: '6', KiP: '18' }) }, { type: false, Ki: null, KiP: null });
  assert.equal(checkInhibitorGuess(truth, { type: null, Ki: '', KiP: '' }).type, false);
});

test('challenge constants count within ±5%, including an exact 5%, and read any notation', () => {
  const truth = { type: 'competitive', Ki: 2, KiP: 2 };
  const ki = text => checkInhibitorGuess(truth, { type: 'competitive', Ki: text, KiP: '' }).Ki;
  assert.equal(ki('2.1'), true);
  assert.equal(ki('1.9'), true);
  assert.equal(ki('2.11'), false);
  assert.equal(ki('abc'), false);
  assert.equal(ki('2 x 10^0'), true);
});

test('Ki worked out from the page\'s rounded equation counts as correct, for every random draw', () => {
  const rand = seededRandom(99);
  for (let i = 0; i < 2000; i++) {
    const r = randomParameters(rand);
    const params = validate(asRaw(r, { mode: 'inhibition', compare: false })).params;
    const [plain, inhibited] = buildModel(params).curves;
    // What a student has: three significant figures from each line equation.
    const read = x => Number(x.toPrecision(3));
    const slopeRatio = read(inhibited.k.slope) / read(plain.k.slope);
    const yRatio = read(inhibited.k.yInt) / read(plain.k.yInt);
    const guess = { type: r.type, Ki: String(r.I / (slopeRatio - 1)), KiP: String(r.I / (yRatio - 1)) };
    const truth = { type: r.type, Ki: r.Ki, KiP: r.type === 'noncompetitive' ? r.Ki : r.KiP };
    const result = checkInhibitorGuess(truth, guess);
    assert.notEqual(result.Ki, false, JSON.stringify([r, guess]));
    assert.notEqual(result.KiP, false, JSON.stringify([r, guess]));
  }
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
});

test('noncompetitive locks Ki\' to Ki whatever the Ki\' field holds', () => {
  assert.equal(validate({ ...VALID, type: 'noncompetitive', Ki: '7', KiP: '100' }).params.KiP, 7);
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
  const m = buildModel({ type: 'mixed', compare: false, Km: 10, kcat: 100, Etot: 0.01, I: 10, Ki: 5, KiP: 20 });
  for (const c of m.curves) {
    for (const key of ['Vmax', 'appVmax', 'Km', 'appKm', 'alpha', 'alphaP', 'slope', 'yInt']) {
      assert.ok(isCorrect(parseAnswer(fmtSig(c.k[key])), c.k[key]), `${key} = ${c.k[key]}`);
    }
  }
});
