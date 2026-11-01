// Tests for enzyme_energy.html. No dependencies — run with: node --test
//
// The presets and the model touch no DOM, so those sections run unmodified in a Node vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'enzyme_energy.html'), 'utf8');
const SECTION = HTML.slice(HTML.indexOf('// ═══ 1.'), HTML.indexOf('// ═══ 3.'));
const page = vm.createContext({});
vm.runInContext(SECTION, page);
const run = code => vm.runInContext(code, page);
const DEFAULTS = run('DEFAULTS');
const ENZYME_PRESETS = run('ENZYME_PRESETS');
const buildModel = over => page.buildModel({ ...DEFAULTS, ...over });
const { eyring, fractionFolded, phActivity, pathValue, stabilizationFor, presetSettings, fmtSci, fmtEnergy, barriersOf } = page;
const toDisplayEnergy = run('toDisplayEnergy'), fromDisplayEnergy = run('fromDisplayEnergy'), toKelvin = run('toKelvin');

const R = 8.314462618e-3;
const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);
const log10Near = (actual, exponent, tolerance, label = '') => near(Math.log10(actual), exponent, tolerance, label);

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// ── The requested checks ───────────────────────────────────────
test('TS stabilization 0 and binding 0 give the uncatalyzed barrier and an enhancement of 1', () => {
  const m = buildModel({ tsStab: 0, binding: 0 });
  assert.equal(m.limiting.barrier, DEFAULTS.dGu);
  assert.equal(m.enhancement, 1);
  assert.equal(m.ddG, 0);
});

test('at 37 °C, each 5.9 kJ/mol of ΔΔG‡ is about a 10× enhancement', () => {
  near(R * toKelvin(37) * Math.log(10), 5.94, 0.01);
  const a = buildModel({ binding: 0, tsStab: 30 });
  const b = buildModel({ binding: 0, tsStab: 35.9 });
  near(b.enhancement / a.enhancement, 10, 0.5);
  near(a.enhancement, Math.exp(30 / (R * 310.15)), 1e-3 * a.enhancement);
});

test('ΔG and Keq never differ between the pathways', () => {
  const rand = seededRandom(1);
  const between = (a, b) => a + (b - a) * rand();
  for (let i = 0; i < 300; i++) {
    const m = buildModel({
      dGu: between(40, 160), dG: between(-40, 20), binding: between(-40, 0), tsStab: between(0, 110),
      tempC: between(0, 80), includeEP: rand() < 0.5, epG: between(-60, 10), ts2Height: between(5, 80),
    });
    assert.equal(m.uncat[0].g, m.cat[0].g, 'S and E + S');
    assert.equal(m.uncat[m.uncat.length - 1].g, m.cat[m.cat.length - 1].g, 'P and E + P');
    assert.equal(m.keq, Math.exp(-m.dG / (R_used(m))));
  }
});
function R_used(m) { return run('R_KJ') * m.T; }

test('raising TS2 eventually makes product release rate-limiting', () => {
  const low = buildModel({ includeEP: true, ts2Height: 35 });
  assert.equal(low.limiting.ts.id, 'TS1');
  const high = buildModel({ includeEP: true, ts2Height: 80 });
  assert.equal(high.limiting.ts.id, 'TS2');
  assert.equal(high.limiting.from.id, 'EP');
  assert.equal(high.limiting.barrier, 80);
  near(high.kCat, eyring(80, high.T), high.kCat * 1e-9);
});

test('every preset gives its listed enhancement at 25 °C, inside the slider ranges', () => {
  for (const preset of ENZYME_PRESETS) {
    const settings = presetSettings(preset);
    const m = buildModel(settings);
    assert.equal(settings.tempC, 25, preset.name);
    assert.equal(settings.view, 'both');
    near(m.enhancement / preset.enhancement, 1, 0.03, preset.name);
    assert.ok(settings.tsStab >= 0 && settings.tsStab <= 110, `${preset.name}: stabilization ${settings.tsStab}`);
    assert.ok(settings.dGu >= 40 && settings.dGu <= 160, preset.name);
    assert.ok(settings.binding >= -40 && settings.binding <= 0, preset.name);
    assert.deepEqual([...m.clamps], [], `${preset.name} needs no clamp`);
    assert.ok(m.limiting.barrier > 0, preset.name);
  }
});

test('the OMP decarboxylase preset gives about 10¹⁷', () => {
  const omp = ENZYME_PRESETS.find(p => p.id === 'ompdc');
  log10Near(buildModel(presetSettings(omp)).enhancement, 17, 0.02);
});

test('only OMP decarboxylase changes the generic energies, and it has to', () => {
  for (const preset of ENZYME_PRESETS) {
    const s = presetSettings(preset);
    if (preset.id === 'ompdc') continue;
    assert.equal(s.dGu, DEFAULTS.dGu, preset.name);
    assert.equal(s.dG, DEFAULTS.dG, preset.name);
    assert.equal(s.binding, DEFAULTS.binding, preset.name);
  }
  // 10¹⁷ at 25 °C needs ΔΔG‡ = 97 kJ/mol, which is more than the generic barrier of 90.
  const needed = R * 298.15 * Math.log(1e17);
  assert.ok(needed > DEFAULTS.dGu, `${needed}`);
  assert.ok(needed - DEFAULTS.binding > 110, 'with binding −15 the stabilization would pass its slider');
});

test('the temperature plot peaks below Tm', () => {
  const m = buildModel({});
  assert.ok(m.temp.optimum < DEFAULTS.Tm, `${m.temp.optimum}`);
  for (const [Tm, dHunf] of [[35, 400], [55, 800], [70, 400], [45, 300]]) {
    const t = buildModel({ Tm, dHunf }).temp;
    assert.ok(t.optimum < Tm, `Tm ${Tm}, ΔH ${dHunf}: ${t.optimum}`);
  }
});

test('the pH plot peaks at (pKa1 + pKa2)/2, and its curve agrees', () => {
  for (const [a, b] of [[6, 8.5], [5, 9], [7, 7.5], [4.5, 6]]) {
    const curve = buildModel({ pKa1: a, pKa2: b }).ph;
    near(curve.optimum, (a + b) / 2, 1e-12);
    const top = curve.pts.reduce((p, q) => (q.y > p.y ? q : p));
    near(top.x, (a + b) / 2, 0.02, 'scan');
  }
});

test('the Quiz Mode button is disabled, greyed out and says Coming soon', () => {
  assert.match(HTML, /<span id="quiz-wrap" title="Coming soon"><button type="button" id="quiz-mode" disabled>Quiz Mode<\/button><\/span>/);
  assert.match(HTML, /button:disabled, select:disabled, input:disabled \{\s*background: #E4E4E4; border-color: #BFBFBF; color: #404040;/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('<script>')), /quiz-mode/, 'no script acts on it yet');
});

test('unit conversions are correct and round-trip', () => {
  assert.equal(toDisplayEnergy(4.184, 'kcal'), 1);
  assert.equal(fromDisplayEnergy(1, 'kcal'), 4.184);
  assert.equal(toDisplayEnergy(90, 'kJ'), 90);
  near(fromDisplayEnergy(toDisplayEnergy(73.3, 'kcal'), 'kcal'), 73.3, 1e-9);
  assert.equal(fmtEnergy(-20, 'kJ'), '−20.0 kJ/mol');
  assert.equal(fmtEnergy(90, 'kcal'), '21.5 kcal/mol');
  assert.equal(fmtEnergy(0, 'kcal'), '0.0 kcal/mol');
});

// ── Barriers and clamps ────────────────────────────────────────
test('hand calculation: the default barriers and rates', () => {
  const m = buildModel({});
  assert.equal(m.limiting.ts.g, 40);            // 90 − 50
  assert.equal(m.limiting.from.id, 'ES');
  assert.equal(m.limiting.barrier, 55);         // 40 − (−15)
  assert.equal(m.ddG, 35);
  assert.equal(m.tsGap, 50);
  const RT = R * 310.15;
  near(m.kUncat, 2.083661912e10 * 310.15 * Math.exp(-90 / RT), m.kUncat * 1e-9);
  near(m.enhancement, Math.exp(35 / RT), m.enhancement * 1e-9);
});

test('a barrier runs from the lowest state before it, whichever that is', () => {
  // TS2 from E + S: EP sits above it, so the lowest earlier state is ES
  const m = buildModel({ includeEP: true, binding: -30, epG: -10, ts2Height: 60 });
  const ts2 = m.barriers.find(b => b.ts.id === 'TS2');
  assert.equal(ts2.from.id, 'ES');
  assert.equal(ts2.barrier, 50 + 30);
  // With no binding, ES and E + S tie, and the earlier one stays
  const flat = buildModel({ binding: 0 });
  assert.equal(flat.limiting.from.g, 0);
});

test('ES‡ is clamped above ES, with a note', () => {
  const m = buildModel({ dGu: 40, tsStab: 110, binding: -10, dG: -40 });
  const ts = m.cat.find(s => s.id === 'ES‡');
  assert.equal(ts.g, -10 + run('MIN_TS_GAP'));
  assert.equal(m.clamps.length, 1);
  assert.equal(m.clamps[0].ts, 'ES‡');
  assert.equal(m.clamps[0].below, 'ES');
  assert.deepEqual([...buildModel({}).clamps], []);
});

test('transition states stay above every neighbor, for any settings', () => {
  const rand = seededRandom(7);
  const between = (a, b) => a + (b - a) * rand();
  for (let i = 0; i < 500; i++) {
    const m = buildModel({
      dGu: between(40, 160), dG: between(-40, 20), binding: between(-40, 0), tsStab: between(0, 110),
      includeEP: rand() < 0.5, epG: between(-60, 10), ts2Height: between(5, 80),
    });
    m.cat.forEach((s, j) => {
      if (s.role !== 'ts') return;
      assert.ok(s.g > m.cat[j - 1].g && s.g > m.cat[j + 1].g, JSON.stringify(m.cat));
    });
    assert.ok(m.limiting.barrier > 0);
  }
});

test('the curve passes through every state and never overshoots', () => {
  for (const m of [buildModel({}), buildModel({ includeEP: true, ts2Height: 80 })]) {
    for (const states of [m.uncat, m.cat]) {
      states.forEach(s => near(pathValue(states, s.u), s.g, 1e-9, s.id));
      const gs = states.map(s => s.g);
      for (let u = 0; u <= 1; u += 0.002) {
        const g = pathValue(states, u);
        assert.ok(g >= Math.min(...gs) - 1e-9 && g <= Math.max(...gs) + 1e-9, `${u}`);
      }
    }
  }
});

// ── Ground-state trap ──────────────────────────────────────────
test('the trap appears only when binding is tighter than the default', () => {
  assert.equal(buildModel({}).trap, false, 'default binding');
  assert.equal(buildModel({ binding: -5 }).trap, false);
  assert.equal(buildModel({ binding: -16 }).trap, true);
  assert.equal(buildModel({ binding: -40 }).trap, true);
});

test('the trap preset slows the enzyme, and the optimal preset beats the default', () => {
  const trap = buildModel(run('SETTINGS_TRAP'));
  const optimal = buildModel(run('SETTINGS_OPTIMAL'));
  const generic = buildModel({});
  assert.equal(trap.trap, true);
  assert.equal(optimal.trap, false);
  assert.ok(trap.enhancement < generic.enhancement);
  assert.ok(optimal.enhancement > generic.enhancement);
  assert.deepEqual([...trap.clamps], []);
  assert.deepEqual([...optimal.clamps], []);
});

// ── Transition-state analog ────────────────────────────────────
test('TS binding is the TS stabilization, from the thermodynamic cycle', () => {
  const a = buildModel({}).analog;
  assert.equal(a.bindTS, -50);
  assert.equal(a.levelTS, 40, 'E·TS sits at the level of ES‡');
  // The same value, the other way around the cycle: −(ΔΔG‡ + |binding|)
  const m = buildModel({});
  assert.equal(a.bindTS, -(m.ddG + Math.abs(DEFAULTS.binding)));
});

test('the analog captures its share of the TS binding energy', () => {
  const a = buildModel({ analogPct: 70 }).analog;
  assert.equal(a.bindI, 0.7 * -50);
  near(a.levelI, 90 - 35, 1e-9);
  assert.ok(a.Kts < a.Ki && a.Ki < a.Ks, 'TS, then analog, then substrate');
  const full = buildModel({ analogPct: 100 }).analog;
  near(full.Ki, full.Kts, full.Kts * 1e-9);
});

test('K_TS = K_S × (k_uncat / k_cat)', () => {
  for (const over of [{}, { binding: -5, tsStab: 90 }, { tempC: 25, dGu: 120, tsStab: 70 }, { includeEP: true, ts2Height: 80 }]) {
    const a = buildModel(over).analog;
    near(a.relation / a.Kts, 1, 1e-9, JSON.stringify(over));
  }
});

test('Kd follows K = e^(ΔG/RT)', () => {
  const a = buildModel({}).analog;
  const RT = R * 310.15;
  near(a.Ks / Math.exp(-15 / RT), 1, 1e-6);
  near(a.Kts / Math.exp(-50 / RT), 1, 1e-6);
});

// ── Activity ───────────────────────────────────────────────────
test('hand calculations: fraction folded', () => {
  near(fractionFolded(328.15, 328.15, 400), 0.5, 1e-12, 'half folded at Tm');
  assert.ok(fractionFolded(310.15, 328.15, 400) > 0.99);
  assert.ok(fractionFolded(350, 328.15, 400) < 0.01);
});

test('hand calculations: pH activity', () => {
  near(phActivity(7, 6, 8.5), 1 / (1 + 0.1 + Math.pow(10, -1.5)), 1e-12);
  near(phActivity(6, 6, 20), 0.5, 1e-9, 'half at pKa1 when pKa2 is far away');
});

test('the observed rate is k_cat × fraction folded × pH activity', () => {
  const m = buildModel({ tempC: 50, pH: 5 });
  near(m.observed, m.kCat * m.folded * m.phFraction, m.observed * 1e-12);
  assert.ok(m.observed < m.kCat);
});

test('the temperature curve is relative, topping out at 1', () => {
  const { pts } = buildModel({}).temp;
  near(Math.max(...pts.map(p => p.y)), 1, 1e-12);
  assert.equal(pts[0].x, 0);
  assert.equal(pts[pts.length - 1].x, 80);
});

// ── Formatting and controls in the markup ──────────────────────
test('scientific notation', () => {
  assert.equal(fmtSci(1.26e5), '1.3 × 10⁵');
  assert.equal(fmtSci(9.96e-3), '1.0 × 10⁻²');
  assert.equal(fmtSci(1), '1.0 × 10⁰');
  assert.equal(fmtSci(0), '0');
  assert.equal(fmtSci(1.2e17), '1.2 × 10¹⁷');
});

test('the sliders have the requested ranges and defaults', () => {
  const rows = [['dGu', 40, 160, 90], ['dG', -40, 20, -20], ['binding', -40, 0, -15], ['tsStab', 0, 110, 50],
    ['tempC', 0, 80, 37], ['pH', 4, 10, 7], ['epG', -60, 10, -30], ['ts2Height', 5, 80, 35], ['analogPct', 50, 100, 70],
    ['Tm', 35, 90, 55], ['dHunf', 200, 800, 400]];
  for (const [key, min, max, value] of rows) {
    assert.ok(new RegExp(`key: '${key}',[^\\n]*min: ${min},\\s*max: ${max},`).test(HTML), key);
    assert.equal(DEFAULTS[key], value, key);
  }
  assert.equal(DEFAULTS.pKa1, 6);
  assert.equal(DEFAULTS.pKa2, 8.5);
});

test('the page loads nothing from elsewhere and has the requested callout', () => {
  assert.doesNotMatch(HTML, /<script[^>]+src|https?:\/\//);
  assert.ok(HTML.includes('Enzymes bind the transition state far more tightly than the substrate. Analogs that mimic it are potent inhibitors.'));
  assert.ok(HTML.includes('Rate enhancement from literature; other energy values are illustrative.'));
});

test('stabilizationFor inverts the enhancement', () => {
  const s = stabilizationFor(1e9, 25, -15);
  near(s, R * 298.15 * Math.log(1e9) + 15, 0.05);
});

test('barriersOf breaks a tie toward the earlier step', () => {
  const states = [
    { id: 'a', role: 'min', g: 0 }, { id: 'b', role: 'ts', g: 10 },
    { id: 'c', role: 'min', g: 0 }, { id: 'd', role: 'ts', g: 10 },
    { id: 'e', role: 'min', g: 0 },
  ];
  assert.equal(barriersOf(states).limiting.ts.id, 'b');
});
