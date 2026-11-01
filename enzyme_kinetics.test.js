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

// ── Quiz Mode ─────────────────────────────────────────────────
const { gradeQuestion, quizCredit, correctAnswerText, fmtSig: fmt } = page;
const buildQuizSet = (mode, rand, hard) => page.buildQuizSet(mode, rand, hard);
const amountInVolume = (conc, unit, rand) => page.amountInVolume(conc, unit, rand);
const inPage = name => vm.runInContext(name, page);   // top-level consts aren't properties of the context
const QUIZ_MODES = {
  rates: ['initialRate', 'runExperiments', 'predictRate', 'whyInitial'],
  kinetics: ['whatChanged', 'fromLine', 'efficiency', 'predictEffect'],
  inhibition: ['identifyType', 'findKi', 'apparent', 'mechanism'],
};
const SETS = 400;

function eachQuestion(check, hard = false) {
  const rand = seededRandom(2024);
  for (const mode of Object.keys(QUIZ_MODES)) {
    for (let i = 0; i < SETS; i++) {
      for (const q of buildQuizSet(mode, rand, hard)) check(q, mode);
    }
  }
}
const eachHardQuestion = check => eachQuestion(check, true);

const rightValues = q => Object.fromEntries([...q.items].map(item => [item.key, item.kind === 'number' ? String(item.truth) : item.answer]));

test('each set has 5 questions and covers all four types', () => {
  const rand = seededRandom(7);
  for (const mode of Object.keys(QUIZ_MODES)) {
    const types = QUIZ_MODES[mode];
    for (let i = 0; i < SETS; i++) {
      const set = [...buildQuizSet(mode, rand)];
      assert.equal(set.length, 5);
      for (const type of types) assert.ok(set.some(q => q.type === type), `${mode}: ${type}`);
    }
  }
});

test('the extra question is never a repeated concept question', () => {
  const rand = seededRandom(8);
  for (let i = 0; i < SETS; i++) {
    assert.equal([...buildQuizSet('rates', rand)].filter(q => q.type === 'whyInitial').length, 1);
  }
});

test('order varies between sets', () => {
  const rand = seededRandom(9);
  const orders = new Set();
  for (let i = 0; i < 50; i++) orders.add([...buildQuizSet('inhibition', rand)].map(q => q.type).join());
  assert.ok(orders.size > 5);
});

for (const hard of [false, true]) {
  test(`every ${hard ? 'hard' : 'easy'} question grades its own answer as correct and is well formed`, () => {
    eachQuestion(q => {
      assert.ok(q.prompt && q.hint && q.explanation && q.title, q.type);
      assert.ok(q.items.length > 0, q.type);
      assert.ok(gradeQuestion(q, rightValues(q)).correct, q.type);
      for (const item of q.items) {
        if (item.kind === 'number') {
          assert.ok(Number.isFinite(item.truth) && item.truth > 0 && item.tolerance > 0 && item.unit, `${q.type} ${item.key}`);
        } else {
          assert.ok(item.options.includes(item.answer), `${q.type} ${item.key}`);
          assert.equal(new Set(item.options).size, item.options.length);
        }
      }
      assert.ok(!/NaN|undefined|Infinity/.test(q.prompt + q.explanation + q.hint), q.prompt + q.explanation);
    }, hard);
  });

  test(`${hard ? 'hard' : 'easy'} numbers outside the allowance are wrong, and prompts don't state it`, () => {
    eachQuestion(q => {
      assert.ok(!/Answers count|within ±/.test(q.prompt), q.prompt);
      for (const item of q.items) {
        if (item.kind !== 'number') continue;
        const off = rightValues(q);
        off[item.key] = String(item.truth * (1 + item.tolerance * 1.5));
        assert.equal(gradeQuestion(q, off).results[item.key], false, q.type);
      }
    }, hard);
  });
}

test('tolerance follows how the value is found', () => {
  const expected = { initialRate: 0.1, runExperiments: 0.1, predictRate: 0.02, fromLine: 0.02, efficiency: 0.02, findKi: 0.05, apparent: 0.02 };
  eachQuestion(q => {
    for (const item of q.items) if (item.kind === 'number') assert.equal(item.tolerance, expected[q.type], q.type);
  });
});

test('a blank part is unmarked and not correct, and a wrong choice is marked wrong', () => {
  const q = [...buildQuizSet('kinetics', seededRandom(3))].find(x => x.type === 'efficiency');
  const values = rightValues(q);
  values.higher = null;
  const blank = gradeQuestion(q, values);
  assert.equal(blank.correct, false);
  assert.equal(blank.results.higher, null);
  assert.equal(blank.results.kcat, true);
  values.higher = 'They are equal';
  const wrong = gradeQuestion(q, values);
  assert.equal(wrong.results.higher, false);
  assert.equal(gradeQuestion(q, {}).correct, false);
});

test('credit: 1 on the first try, ½ on any later try, none if the answer is shown', () => {
  assert.equal(quizCredit(1, true), 1);
  assert.equal(quizCredit(2, true), 0.5);
  assert.equal(quizCredit(5, true), 0.5);
  assert.equal(quizCredit(1, false), 0);
  assert.equal(quizCredit(3, false), 0);
});

// What a student has: three significant figures from each line equation on the plot.
const read = x => Number(fmt(x).replace('−', '-').replace(' × 10', 'e').replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]/g, c => '0123456789-'['⁰¹²³⁴⁵⁶⁷⁸⁹⁻'.indexOf(c)]));
const lines = q => [...buildModel(q.scene.params).curves].map(c => ({ m: read(c.k.slope), b: read(c.k.yInt) }));

test('Vmax and Km worked from the rounded L-B equation pass', () => {
  eachQuestion(q => {
    if (q.type !== 'fromLine') return;
    const { m, b } = lines(q)[1];
    assert.ok(gradeQuestion(q, { Vmax: String(1 / b), Km: String(m / b) }).correct, JSON.stringify(q.scene.params));
  });
});

test('kcat and kcat/Km worked from the rounded equation pass', () => {
  eachQuestion(q => {
    if (q.type !== 'efficiency') return;
    const { m, b } = lines(q)[1];
    const kcat = (1 / b) / q.scene.params.Etot2;
    const values = rightValues(q);
    values.kcat = String(kcat);
    values.ratio = String(kcat / (m / b));
    assert.ok(gradeQuestion(q, values).correct, JSON.stringify(q.scene.params));
  });
});

test('apparent values worked from the rounded equation pass', () => {
  eachQuestion(q => {
    if (q.type !== 'apparent') return;
    const { m, b } = lines(q)[1];
    const values = rightValues(q);
    values.VmaxApp = String(1 / b);
    values.KmApp = String(m / b);
    assert.ok(gradeQuestion(q, values).correct, JSON.stringify(q.scene.params));
  });
});

test('Ki and Ki\' worked from the rounded equations pass', () => {
  eachQuestion(q => {
    if (q.type !== 'findKi') return;
    const [plain, inhibited] = lines(q);
    const values = {};
    if (q.items.some(i => i.key === 'Ki')) values.Ki = String(q.scene.params.I / (inhibited.m / plain.m - 1));
    if (q.items.some(i => i.key === 'KiP')) values.KiP = String(q.scene.params.I / (inhibited.b / plain.b - 1));
    assert.ok(gradeQuestion(q, values).correct, JSON.stringify([q.scene.params, values]));
  });
});

test('hand calculation: predicting v₀ at 2 × Km gives ⅔Vmax', () => {
  const k = constants(6, 25, 1, 1);
  near(v0(k, 50), 4);
});

test('Ki questions ask for the constants that type uses', () => {
  const wanted = { competitive: ['Ki'], uncompetitive: ['KiP'], noncompetitive: ['Ki'], mixed: ['Ki', 'KiP'] };
  eachQuestion(q => {
    if (q.type !== 'findKi') return;
    assert.deepEqual([...q.items].map(i => i.key), wanted[q.scene.params.type]);
  });
});

test('mechanism answers match each inhibition type', () => {
  const wanted = {
    competitive: ['Free E only', 'The active site'],
    uncompetitive: ['The ES complex only', 'A separate (allosteric) site'],
    noncompetitive: ['Both E and ES', 'A separate (allosteric) site'],
    mixed: ['Both E and ES', 'A separate (allosteric) site'],
  };
  eachQuestion(q => {
    if (q.type !== 'mechanism') return;
    assert.deepEqual([...q.items].map(i => i.answer), wanted[q.scene.params.type]);
  });
});

test('apparent trends: competitive keeps Vmax, noncompetitive keeps Km, uncompetitive lowers both', () => {
  const wanted = {
    competitive: { VmaxTrend: 'No change', KmTrend: 'Increases' },
    uncompetitive: { VmaxTrend: 'Decreases', KmTrend: 'Decreases' },
    noncompetitive: { VmaxTrend: 'Decreases', KmTrend: 'No change' },
  };
  eachQuestion(q => {
    if (q.type !== 'apparent' || !wanted[q.scene.params.type]) return;
    const answers = Object.fromEntries([...q.items].filter(i => i.kind === 'choice').map(i => [i.key, i.answer]));
    assert.deepEqual(answers, wanted[q.scene.params.type]);
  });
});

test('predicted effects of doubling each parameter', () => {
  const up = 'Increases', down = 'Decreases', same = 'No change';
  const wanted = {
    Etot: [up, same, down, down], kcat: [up, same, down, down], Km: [same, up, up, same],
  };
  const rand = seededRandom(11);
  const seen = new Set();
  eachQuestion(q => {
    if (q.type !== 'predictEffect') return;
    const by = differingParameter(q.scene.params);
    seen.add(by);
    assert.deepEqual([...q.items].map(i => i.answer), wanted[by], by);
    assert.ok(q.scene.hideB);
    assert.ok(rand() >= 0);
  });
  assert.equal(seen.size, 3);
});

test('"what changed" can always be answered from what is shown', () => {
  eachQuestion(q => {
    if (q.type !== 'whatChanged') return;
    const by = differingParameter(q.scene.params);
    const answer = q.items[0].answer;
    assert.ok(answer.includes(by === 'Etot' ? 'total' : by === 'Km' ? 'K<sub>m</sub>' : 'k<sub>cat</sub>'), answer);
    // [E]total and kcat look identical on the plots, so the prompt must list [E]total for both.
    const { Etot, Etot2 } = q.scene.params;
    assert.ok(q.prompt.includes(fmtCompact(Etot)) && q.prompt.includes(fmtCompact(Etot2)), q.prompt);
  });
});

test('efficiency questions always have a real difference to compare', () => {
  eachQuestion(q => {
    if (q.type !== 'efficiency') return;
    const p = q.scene.params;
    assert.notEqual(differingParameter(p), 'Etot');
    assert.notEqual(p.kcat / p.Km, p.kcat2 / p.Km2);
  });
});

test('questions hide what they test: the inhibition prompt never names Ki, and identify never names the type', () => {
  eachQuestion(q => {
    if (q.type === 'identifyType' || q.type === 'mechanism') {
      assert.ok(!/competitive|mixed/i.test(q.prompt), q.prompt);
    }
    if (q.type === 'findKi') {
      const p = q.scene.params;
      assert.ok(!q.prompt.includes(`K<sub>i</sub> = ${fmtCompact(p.Ki)}`), q.prompt);
    }
    if (q.type === 'initialRate' || q.type === 'runExperiments') {
      assert.ok(!q.prompt.includes('k<sub>cat</sub> ='), q.prompt);
      assert.ok(!q.prompt.includes('K<sub>m</sub> ='), q.prompt);
    }
  });
});

test('correctAnswerText lists every part', () => {
  const q = [...buildQuizSet('kinetics', seededRandom(4))].find(x => x.type === 'fromLine');
  const text = correctAnswerText(q);
  assert.ok(text.includes('V<sub>max</sub> = ') && text.includes('K<sub>m</sub> = '), text);
  const effect = [...buildQuizSet('kinetics', seededRandom(4))].find(x => x.type === 'predictEffect');
  assert.ok(correctAnswerText(effect).startsWith('V<sub>max</sub>: '), correctAnswerText(effect));
  const type = [...buildQuizSet('inhibition', seededRandom(4))].find(x => x.type === 'identifyType');
  assert.equal(correctAnswerText(type), type.items[0].answer);
});

// ── Quiz Hard Mode ────────────────────────────────────────────
const CONC_M = { M: 1, mM: 1e-3, 'µM': 1e-6, nM: 1e-9 };
const TIME_S = { s: 1, min: 60, h: 3600 };
const AMOUNT_MOL = { mol: 1, 'µmol': 1e-6, nmol: 1e-9 };
const VOLUME_L = { L: 1, mL: 1e-3, 'µL': 1e-6 };

test('unit conversions match hand calculations', () => {
  near(inPage('convertConc')(1, 'mM', 'µM'), 1000);
  near(inPage('convertConc')(500, 'nM', 'µM'), 0.5);
  near(inPage('convertPerTime')(60, 'min', 's'), 1);
  near(inPage('convertPerTime')(1, 's', 'h'), 3600);
  near(inPage('convertRate')(60, 'µM', 'min', 'µM', 's'), 1);
  near(inPage('convertRate')(1, 'mM', 's', 'µM', 'min'), 60000);
});

test('an amount in a volume gives back the stated concentration, in units that do not match', () => {
  const rand = seededRandom(21);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const unit = ['nM', 'µM', 'mM'][i % 3];
    const conc = Number((10 ** (rand() * 3 - 1)).toPrecision(2));
    const a = amountInVolume(conc, unit, rand);
    seen.add(a.amountUnit);
    const molar = a.amount * AMOUNT_MOL[a.amountUnit] / (a.volume * VOLUME_L[a.volumeUnit]);
    near(molar / CONC_M[unit], a.conc, 1e-9);
    assert.ok(Math.abs(a.conc - conc) / conc < 0.06, JSON.stringify([conc, a]));   // rounded to 2 figures
    const direct = AMOUNT_MOL[a.amountUnit] / VOLUME_L[a.volumeUnit];
    assert.ok(Math.abs(direct / CONC_M[unit] - 1) > 1e-6, `${a.amountUnit}/${a.volumeUnit} is simply ${unit}`);
    assert.ok(a.of('enzyme').includes(`${a.amountUnit} of enzyme in ${a.volume} ${a.volumeUnit}`), a.of('enzyme'));
  }
  assert.equal(seen.size, 3);
});

test('hand calculation: 0.1 nmol in 2 mL is 0.05 µM', () => {
  near(0.1 * AMOUNT_MOL.nmol / (2 * VOLUME_L.mL) / CONC_M['µM'], 0.05);
});

test('every hard numeric question makes the student convert something', () => {
  eachHardQuestion(q => {
    const numbers = [...q.items].filter(i => i.kind === 'number');
    if (!numbers.length) return;
    const { conc, time } = q.scene.units;
    const plain = new Set([conc, `${conc}/${time}`, `${time}⁻¹`, `${conc}⁻¹ ${time}⁻¹`]);
    const usesAmount = /mol of \w+ in /.test(q.prompt);
    const changedUnit = numbers.some(i => !plain.has(i.unit));
    const predictHasMismatch = q.type === 'predictRate' && /Give your answer/.test(q.prompt);
    assert.ok(usesAmount || changedUnit || predictHasMismatch, q.type + ' ' + q.prompt);
  });
});

test('hard questions that use [E]total or [I] give an amount and a volume', () => {
  const needs = ['runExperiments', 'whatChanged', 'efficiency', 'findKi'];
  const seen = new Set();
  eachHardQuestion(q => {
    if (!needs.includes(q.type)) return;
    seen.add(q.type);
    assert.ok(/mol of (enzyme|inhibitor) in \S+ (L|mL|µL)/.test(q.prompt), q.prompt);
    assert.ok(!q.prompt.includes('[E]<sub>total</sub> ='), q.prompt);
  });
  assert.equal(seen.size, needs.length);
});

test('easy questions keep one set of units, and give no amounts', () => {
  eachQuestion(q => {
    assert.ok(!/mol of /.test(q.prompt), q.prompt);
    const { conc, time } = q.scene.units;
    for (const item of q.items) {
      if (item.kind === 'number') assert.ok(item.unit.includes(conc) || item.unit.includes(time), item.unit);
    }
  });
});

test('units vary between easy questions', () => {
  const concs = new Set(), times = new Set();
  eachQuestion(q => { concs.add(q.scene.units.conc); times.add(q.scene.units.time); });
  assert.equal(concs.size, 3);
  assert.equal(times.size, 3);
});

// Converts a value in plot units to the unit an answer is asked in.
function toItemUnit(value, item, { conc, time }) {
  const parts = item.unit.split('/');
  if (item.unit === 'M⁻¹ s⁻¹') return value * (1 / TIME_S[time]) / CONC_M[conc];
  if (item.unit.endsWith('⁻¹')) return value * TIME_S[item.unit.replace('⁻¹', '')] / TIME_S[time];
  if (parts.length === 2) return value * (CONC_M[conc] / CONC_M[parts[0]]) * (TIME_S[parts[1]] / TIME_S[time]);
  return value * CONC_M[conc] / CONC_M[item.unit];
}

test('hard answers worked from the rounded equations and shown amounts pass', () => {
  const seen = new Set();
  eachHardQuestion(q => {
    if (!['fromLine', 'efficiency', 'apparent', 'findKi'].includes(q.type)) return;
    seen.add(q.type);
    const curves = lines(q);
    const { m, b } = curves[1];
    const values = rightValues(q);
    const units = q.scene.units;
    const worked = {
      Vmax: 1 / b, Km: m / b, VmaxApp: 1 / b, KmApp: m / b,
      kcat: (1 / b) / q.scene.params.Etot2,
      ratio: ((1 / b) / q.scene.params.Etot2) / (m / b),
      Ki: q.scene.params.I / (m / curves[0].m - 1),
      KiP: q.scene.params.I / (b / curves[0].b - 1),
    };
    for (const item of q.items) {
      if (item.kind === 'number') {
        const inPlotUnits = worked[item.key];
        values[item.key] = String(q.type === 'findKi' ? inPlotUnits : toItemUnit(inPlotUnits, item, units));
      }
    }
    const { correct, results } = gradeQuestion(q, values);
    assert.ok(correct, JSON.stringify([q.type, q.scene.params, values, results, [...q.items].map(i => i.truth)]));
  });
  assert.equal(seen.size, 4);
});

test('hard "what changed": equal concentrations from different amounts and volumes', () => {
  eachHardQuestion(q => {
    if (q.type !== 'whatChanged') return;
    const by = differingParameter(q.scene.params);
    const match = q.prompt.match(/A contains (\S+(?: × \S+)?) (\S+) of enzyme in (\S+) (\S+), and Conditions B contains (\S+(?: × \S+)?) (\S+) of enzyme in (\S+) (\S+)\./);
    assert.ok(match, q.prompt);
    assert.equal(match[2], match[6]);                 // same amount unit
    assert.equal(match[4], match[8]);                 // same volume unit
    assert.notEqual(match[3], match[7]);              // but a different volume, so they must be worked out
    assert.equal(q.scene.params.Etot === q.scene.params.Etot2, by !== 'Etot');
  });
});

test('hard "predict the effect" sometimes dilutes the enzyme, halving [E]total', () => {
  let diluted = 0;
  const up = 'Increases', down = 'Decreases', same = 'No change';
  eachHardQuestion(q => {
    if (q.type !== 'predictEffect' || !/diluted/.test(q.prompt)) return;
    diluted += 1;
    assert.deepEqual([...q.items].map(i => i.answer), [down, same, up, up]);
    near(q.scene.params.Etot2, q.scene.params.Etot / 2);
  });
  assert.ok(diluted > 0);
});

test('hard kcat/Km is asked in M⁻¹ s⁻¹, and matches a hand conversion', () => {
  eachHardQuestion(q => {
    if (q.type !== 'efficiency') return;
    const item = [...q.items].find(i => i.key === 'ratio');
    assert.equal(item.unit, 'M⁻¹ s⁻¹');
    const { kcat2, Km2 } = q.scene.params;
    const { conc, time } = q.scene.units;
    near(item.truth, (kcat2 / TIME_S[time]) / (Km2 * CONC_M[conc]), 1e-9);
  });
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

// ── Measuring Rates text and layout ────────────────────────────
const DEMO_S_COUNT = () => HTML.match(/const DEMO_S_FACTORS = \[([^\]]*)\]/)[1].split(',').length;

test('the product vs. time note says why the initial rate is measured', () => {
  assert.ok(HTML.includes('id="product-note">Initial rate is measured because the rate decreases as substrate is consumed.<'));
  assert.ok(!HTML.includes('approaches equilibrium'));
});

test('the data point note moved from the Experiment box to below the M-M plot', () => {
  const experiment = HTML.slice(HTML.indexOf('id="experiment-box"'), HTML.indexOf('id="collect-notes"'));
  assert.ok(!experiment.includes('One data point'));
  assert.ok(!experiment.includes('class="note"'));
  assert.equal(HTML.split('One data point').length, 2, 'it appears once');
  const canvas = HTML.indexOf('id="mm-canvas"'), note = HTML.indexOf('id="mm-note">One data point represents the initial rate at a particular [S].<');
  assert.ok(canvas > 0 && note > canvas, 'below the plot');
  assert.ok(note < HTML.indexOf('id="lb-canvas"'), 'still in the M-M card');
});

test('the note shows only on Measuring Rates, and not during a quiz', () => {
  assert.ok(HTML.includes("$('mm-note').hidden = !rates;"));
  assert.match(HTML, /const QUIZ_HIDDEN = \[[^\]]*'mm-note'/);
});

test('the six starting [S] buttons share one row, with the readout below them', () => {
  assert.equal(DEMO_S_COUNT(), 6);
  assert.match(HTML, /#demo-s-buttons \{ display: grid; grid-template-columns: repeat\(6, minmax\(0, 1fr\)\);/);
  const box = HTML.slice(HTML.indexOf('<div id="demo-controls">'), HTML.indexOf('id="collect-notes"'));
  assert.ok(box.indexOf('id="demo-s-buttons"') > 0 && box.indexOf('id="demo-s-buttons"') < box.indexOf('id="demo-readout"'));
  assert.doesNotMatch(HTML, /#demo-controls, #collect-controls/, 'the box is no longer two columns');
});

test('the product plot compares the selection with 0.2 and 10 × Km, not the previous [S]', () => {
  assert.match(HTML, /const DEMO_REFERENCES = \[0, DEMO_S_FACTORS\.length - 1\]/);
  assert.match(HTML, /const DEMO_S_FACTORS = \[0\.2, 0\.5, 1, 2, 5, 10\]/);
  assert.ok(HTML.includes(".filter(e => e !== focus)"), 'a selected reference is drawn once, as the selection');
  assert.ok(HTML.includes("legend: 'Reference [S]', style: RATE_STYLES.reference"));
  assert.doesNotMatch(HTML, /Previous \[S\]|previously selected|rates\.previous/);
});

test('reference buttons stay selectable and turn from gray to the active color', () => {
  assert.match(HTML, /#demo-s-buttons button\.reference \{ background: #BFBFBF;/);
  assert.match(HTML, /const look = i === selected \? ' class="active"'\s+: reference >= 0/);
  const handler = HTML.slice(HTML.indexOf("$('demo-s-buttons').addEventListener"), HTML.indexOf('function runProblem'));
  assert.ok(handler.includes('state.rates.selected = chosen;'));
  assert.doesNotMatch(handler, /disabled|reference/i, 'no button is left out');
});

test('Show Guides sits beside the note, and the plot cards match in height', () => {
  const footer = HTML.slice(HTML.indexOf('<div id="mm-footer">'), HTML.indexOf('id="lb-canvas"'));
  assert.ok(footer.indexOf('id="mm-note"') > 0 && footer.indexOf('id="mm-note"') < footer.indexOf('id="guides"'));
  assert.match(HTML, /#mm-footer \{ display: flex; align-items: center;/);
  assert.match(HTML, /\.rates-layout #plot-column \{[^}]*align-items: stretch;/);
  assert.match(HTML, /\.rates-layout \.plot-card\.collapsed \{ align-self: start; \}/);
});

test('the hover hint is centered below the plots', () => {
  assert.match(HTML, /\.plot-hint \{[^}]*text-align: center;/);
  assert.match(HTML, /\.rates-layout #plot-hint \{ grid-column: 1 \/ -1;/);
});

test('the enzyme model and scheme are 20% smaller', () => {
  assert.match(HTML, /#enzyme-model svg \{ max-width: 213px; \}/);
  assert.match(HTML, /#reaction-scheme svg \{ max-width: 272px; \}/);
});

test('Random and Reset sit below the tab buttons on every tab, 20% smaller', () => {
  const at = marker => {
    const i = HTML.indexOf(marker);
    assert.ok(i >= 0, marker);
    return i;
  };
  for (const row of ['id="rates-view-buttons"', 'id="type-buttons"', 'id="difference-buttons"']) {
    assert.ok(at(row) < at('<div id="param-buttons">'), row);
  }
  assert.ok(at('<div id="param-buttons">') < at('<div id="workspace">'));
  const row = HTML.slice(at('<div id="param-buttons">'), at('<div id="workspace">'));
  assert.ok(row.includes('id="random"') && row.includes('id="reset"'));
  assert.match(HTML, /#param-buttons \{ margin-top: -12px; \}/);
  assert.match(HTML, /#param-buttons button \{ padding: 5\.6px 12px; font-size: 0\.7em; \}/);
  assert.doesNotMatch(HTML.replace(/<[^>]*param-buttons[^>]*>/, ''), /\$\('param-buttons'\)\.hidden/, 'never hidden by a tab');
});

// ── Measuring Rates layout and answers ─────────────────────────
test('Quiz Mode sits to the right of Inhibition', () => {
  assert.match(HTML, /id="tab-inhibition">Inhibition<\/button>\s*<\/div>\s*<button type="button" id="quiz-toggle"/);
  assert.doesNotMatch(HTML, /action-buttons/);
});

test('Show Guides takes two rows', () => {
  assert.ok(HTML.includes('>Show<br>Guides</button>'));
});

test('the Experiment box holds [E]total and the units on the left, with [Substrate] and Run below', () => {
  assert.doesNotMatch(HTML, /id="rates-settings"|rates-settings-title|\$\('rates-settings'\)/);
  const box = HTML.slice(HTML.indexOf('id="experiment-box"'), HTML.indexOf('id="entry-box"'));
  const at = marker => box.indexOf(marker);
  assert.ok(at('id="experiment-left"') < at('id="rates-settings-fields"'));
  assert.ok(at('id="rates-settings-fields"') < at('id="runS"') && at('id="runS"') < at('id="run-experiment"'));
  assert.ok(at('id="run-experiment"') < at('id="collect-notes"'));
  assert.ok(box.includes('<label for="runS">[Substrate] ('));
  assert.ok(!box.includes('Starting [S]'));
  assert.ok(box.includes('>Enter a [Substrate] to show the product formation over time plot and add a data point to the M-M plot for the initial rate at that [Substrate]. Run additional experiments at higher [S] to observe the effect of substrate on the rate of the reaction.<'));
  assert.doesNotMatch(box, /Each run adds|measure-window/);
});

test('the measurement window slider sits below the product plot, with no percent wording', () => {
  const card = HTML.slice(HTML.indexOf('id="product-card"'), HTML.indexOf('data-panel="mm"'));
  assert.ok(card.indexOf('id="product-canvas"') < card.indexOf('id="measure-window"'));
  assert.ok(card.includes('>Measurement window</label>'));
  assert.doesNotMatch(HTML, /first \$\{windowPct\}|window-readout/);
  assert.match(HTML, /const QUIZ_HIDDEN = \[[^\]]*'window-control'/);
});

test('the rates answer box tells students nothing about how to find the values', () => {
  assert.doesNotMatch(HTML, /entry-note-rates|Estimate from your M-M plot|Answers count within/);
  const hint = HTML.slice(HTML.indexOf('function methodHint'), HTML.indexOf('// The same method with this'));
  assert.match(hint, /if \(mode === 'rates'\) return '';/);
});

test('kcat and catalytic efficiency follow Vmax and Km on Measuring Rates', () => {
  const rows = HTML.slice(HTML.indexOf('function entryRows'), HTML.indexOf('// Measuring Rates works these out'));
  const at = marker => rows.indexOf(marker);
  assert.ok(at("key: 'appVmax'") < at("key: 'appKm'") && at("key: 'appKm'") < at("key: 'kcat'") && at("key: 'kcat'") < at('Catalytic efficiency'));
  assert.ok(!HTML.slice(HTML.indexOf('function ratesEntryTable'), HTML.indexOf('function renderEntryTable')).includes('/K<sub>m</sub>'), 'the heading gives no formula');
});

test('acceptable Vmax and Km estimates give an accepted catalytic efficiency', () => {
  const tol = vm.runInContext('READ_RATIO_TOLERANCE', page);
  assert.ok(1.1 / 0.9 - 1 <= tol && 1 - 0.9 / 1.1 <= tol);
});

test('the page uses the shared answer and disabled colors', () => {
  assert.match(HTML, /\.entry-cell\.correct \{ background: #DBEAFE; outline: 2px solid #1565C0;/);
  assert.match(HTML, /\.entry-cell\.wrong \{ background: #FFEBEE; outline: 2px solid #C8102E;/);
  assert.match(HTML, /\.quiz-item\.correct \{ background: #DBEAFE; border-color: #1565C0; color: #000000; \}/);
  assert.match(HTML, /\.quiz-item\.wrong \{ background: #FFEBEE; border-color: #C8102E; color: #000000; \}/);
  assert.match(HTML, /--bg-disabled: #E4E4E4;/);
  assert.match(HTML, /--text-disabled: +#404040;/);
  assert.doesNotMatch(HTML, /(correct|wrong)[^{\n]*\{[^}]*lavender/);
});

// ── Score breakdown ────────────────────────────────────────────
test('the breakdown has one row per question type, named as the question names itself', () => {
  const groups = vm.runInContext('BREAKDOWN_GROUPS', page);
  const rows = [...groups].flatMap(g => [...g[1]].map(r => [...r]));
  const built = [...HTML.matchAll(/type: '(\w+)', title: '([^']+)'/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(rows, built);
  const types = vm.runInContext('QUIZ_TYPES', page);
  assert.deepEqual(rows.map(r => r[0]), [...types.rates, ...types.kinetics, ...types.inhibition]);
});

test('Reset score and Score breakdown sit together at the bottom', () => {
  const area = HTML.slice(HTML.indexOf('id="score-area"'), HTML.indexOf('</main>'));
  assert.ok(area.indexOf('>Reset score<') > 0 && area.indexOf('>Reset score<') < area.indexOf('>Score breakdown<'));
  assert.ok(area.includes('aria-expanded="false"'));
  assert.ok(HTML.indexOf('id="score-area"') > HTML.indexOf('id="plot-hint"'));
});

test('an answered quiz box left blank is grayed out, and an empty run asks for a [Substrate]', () => {
  assert.match(HTML, /\.quiz-item input\[type=text\]:disabled \{ background: var\(--bg-disabled\); border-color: #BFBFBF; color: var\(--text-disabled\); \}/);
  assert.ok(HTML.indexOf('.quiz-item input[type=text]:disabled') < HTML.indexOf('.quiz-item.correct input[type=text]'), 'a marked answer keeps its color');
  assert.ok(HTML.includes("'Enter a positive [Substrate].'"));
});
