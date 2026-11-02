// Tests for enzyme_energy.html. No dependencies — run with: node --test
//
// The model touches no DOM, so that section runs unmodified in a Node vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'enzyme_energy.html'), 'utf8');
const MARKUP = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script>'));
const SECTION = HTML.slice(HTML.indexOf('// ═══ 1.'), HTML.indexOf('// ═══ 2.'));
const page = vm.createContext({});
vm.runInContext(SECTION, page);
const run = code => vm.runInContext(code, page);
const DEFAULTS = run('DEFAULTS');
const buildModel = over => page.buildModel({ ...DEFAULTS, ...over });
const { eyring, fractionFolded, phActivity, pathValue, fmtEnergy, barriersOf } = page;
const toDisplayEnergy = run('toDisplayEnergy'), fromDisplayEnergy = run('fromDisplayEnergy'), toKelvin = run('toKelvin');

const R = 8.314462618e-3;
const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} is not within ${tolerance} of ${expected}`);

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}
const randomSettings = rand => {
  const between = (a, b) => a + (b - a) * rand();
  return {
    dGu: between(40, 160), dG: between(-40, 20), esG: between(-40, 0), ts1G: between(-40, 160),
    epG: between(-60, 10), ts2G: between(-40, 160),
  };
};

// ── Energies ───────────────────────────────────────────────────
test('hand calculation: the default path and its barriers', () => {
  const m = buildModel({});
  assert.deepEqual([...m.cat.map(s => s.id)], ['E+S', 'ES', 'TS1', 'EP', 'TS2', 'E+P']);
  assert.deepEqual([...m.cat.map(s => s.g)], [0, -10, 10, -30, 5, -20]);
  assert.equal(m.barriers[0].barrier, 20);      // TS1 from ES: 10 − (−10)
  assert.equal(m.barriers[1].barrier, 35);      // TS2 from EP: 5 − (−30)
  assert.equal(m.limiting.ts.id, 'TS2');
});

test('the defaults are the optimal settings, with no trap and no clamp', () => {
  assert.equal(DEFAULTS.esG, -10);
  assert.equal(DEFAULTS.ts1G, 10);
  const m = buildModel({});
  assert.equal(m.trap, false);
  assert.deepEqual([...m.clamps], []);
});

test('S and P match E + S and E + P, for any settings', () => {
  const rand = seededRandom(1);
  for (let i = 0; i < 300; i++) {
    const m = buildModel(randomSettings(rand));
    assert.equal(m.uncat[0].g, m.cat[0].g, 'S and E + S');
    assert.equal(m.uncat[m.uncat.length - 1].g, m.cat[m.cat.length - 1].g, 'P and E + P');
  }
});

test('raising TS2 makes product release rate-limiting, and lowering it hands the limit to TS1', () => {
  const low = buildModel({ ts1G: 40, esG: -15, ts2G: 5 });
  assert.equal(low.limiting.ts.id, 'TS1');
  assert.equal(low.limiting.barrier, 55);
  const high = buildModel({ ts1G: 40, esG: -15, ts2G: 50 });
  assert.equal(high.limiting.ts.id, 'TS2');
  assert.equal(high.limiting.from.id, 'EP');
  assert.equal(high.limiting.barrier, 80);
});

test('with TS1 at the uncatalyzed level and ES at zero, TS1 has the uncatalyzed barrier', () => {
  const m = buildModel({ ts1G: DEFAULTS.dGu, esG: 0 });
  assert.equal(m.barriers[0].barrier, DEFAULTS.dGu);
  assert.equal(m.limiting.ts.id, 'TS1');
});

test('a barrier runs from the lowest state before it, whichever that is', () => {
  const m = buildModel({ esG: -30, epG: -10, ts2G: 50, ts1G: 40 });
  const ts2 = m.barriers.find(b => b.ts.id === 'TS2');
  assert.equal(ts2.from.id, 'ES');
  assert.equal(ts2.barrier, 50 + 30);
});

test('barriersOf breaks a tie toward the earlier step', () => {
  const states = [
    { id: 'a', role: 'min', g: 0 }, { id: 'b', role: 'ts', g: 10 },
    { id: 'c', role: 'min', g: 0 }, { id: 'd', role: 'ts', g: 10 },
    { id: 'e', role: 'min', g: 0 },
  ];
  assert.equal(barriersOf(states).limiting.ts.id, 'b');
});

test('TS1 is clamped above ES and EP, with a note', () => {
  const m = buildModel({ ts1G: -40, esG: -10, epG: -30 });
  const ts = m.cat.find(s => s.id === 'TS1');
  assert.equal(ts.g, -10 + run('MIN_TS_GAP'));
  assert.equal(m.clamps.length, 1);
  assert.equal(m.clamps[0].ts, 'TS1');
  assert.equal(m.clamps[0].below, 'ES');
});

test('transition states stay above every neighbor, for any settings', () => {
  const rand = seededRandom(7);
  for (let i = 0; i < 500; i++) {
    const m = buildModel(randomSettings(rand));
    m.cat.forEach((s, j) => {
      if (s.role !== 'ts') return;
      assert.ok(s.g > m.cat[j - 1].g && s.g > m.cat[j + 1].g, JSON.stringify(m.cat));
    });
    assert.ok(m.limiting.barrier > 0);
  }
});

test('the curve passes through every state and never overshoots', () => {
  const m = buildModel({});
  for (const states of [m.uncat, m.cat]) {
    states.forEach(s => near(pathValue(states, s.u), s.g, 1e-9, s.id));
    const gs = states.map(s => s.g);
    for (let u = 0; u <= 1; u += 0.002) {
      const g = pathValue(states, u);
      assert.ok(g >= Math.min(...gs) - 1e-9 && g <= Math.max(...gs) + 1e-9, `${u}`);
    }
  }
});

// ── Ground-state trap ──────────────────────────────────────────
test('the trap appears only when binding is tighter than the default', () => {
  assert.equal(buildModel({}).trap, false, 'default binding');
  assert.equal(buildModel({ esG: -5 }).trap, false);
  assert.equal(buildModel({ esG: -11 }).trap, true);
  assert.equal(buildModel({ esG: -40 }).trap, true);
});

test('the trap button raises the barrier from ES', () => {
  const trap = buildModel(run('SETTINGS_TRAP'));
  assert.equal(trap.trap, true);
  assert.deepEqual([...trap.clamps], []);
  assert.equal(trap.barriers[0].barrier, 80);   // 40 − (−40)
  assert.ok(trap.barriers[0].barrier > buildModel({}).barriers[0].barrier);
});

// ── Activity ───────────────────────────────────────────────────
test('at 37 °C, each 5.9 kJ/mol of barrier is about a 10× change in rate', () => {
  const T = toKelvin(37);
  near(R * T * Math.log(10), 5.94, 0.01);
  near(eyring(50, T) / eyring(55.9, T), 10, 0.5);
});

test('hand calculations: fraction folded', () => {
  near(fractionFolded(328.15, 328.15), 0.5, 1e-12, 'half folded at Tm');
  assert.ok(fractionFolded(310.15, 328.15) > 0.99);
  assert.ok(fractionFolded(350, 328.15) < 0.01);
});

test('hand calculations: pH activity', () => {
  near(phActivity(7, 6, 8.5), 1 / (1 + 0.1 + Math.pow(10, -1.5)), 1e-12);
  near(phActivity(6, 6, 20), 0.5, 1e-9, 'half at pKa1 when pKa2 is far away');
});

test('the temperature plot peaks below Tm, topping out at 1', () => {
  for (const Tm of [35, 45, 55, 70]) {
    const t = buildModel({ Tm }).temp;
    assert.ok(t.optimum < Tm, `Tm ${Tm}: ${t.optimum}`);
    near(Math.max(...t.pts.map(p => p.y)), 1, 1e-12);
  }
});

test('with ΔH fixed, the temperature optimum stays below Tm up to a 160 kJ/mol barrier', () => {
  const m = buildModel({ ts1G: 160, esG: 0, Tm: 55 });
  assert.equal(m.limiting.barrier, 160);
  assert.ok(m.temp.optimum < 55, `${m.temp.optimum}`);
});

test('the pH plot peaks at (pKa1 + pKa2)/2, and its curve agrees', () => {
  for (const [a, b] of [[6, 8.5], [5, 9], [7, 7.5], [4.5, 6]]) {
    const curve = buildModel({ pKa1: a, pKa2: b }).ph;
    near(curve.optimum, (a + b) / 2, 1e-12);
    const top = curve.pts.reduce((p, q) => (q.y > p.y ? q : p));
    near(top.x, (a + b) / 2, 0.02, 'scan');
  }
});

// ── Formatting ─────────────────────────────────────────────────
test('unit conversions are correct and round-trip', () => {
  assert.equal(toDisplayEnergy(4.184, 'kcal'), 1);
  assert.equal(fromDisplayEnergy(1, 'kcal'), 4.184);
  assert.equal(toDisplayEnergy(90, 'kJ'), 90);
  near(fromDisplayEnergy(toDisplayEnergy(73.3, 'kcal'), 'kcal'), 73.3, 1e-9);
  assert.equal(fmtEnergy(-20, 'kJ'), '−20.0 kJ/mol');
  assert.equal(fmtEnergy(90, 'kcal'), '21.5 kcal/mol');
  assert.equal(fmtEnergy(0, 'kcal'), '0.0 kcal/mol');
});

// ── Layout and controls ────────────────────────────────────────
const columnOf = key => HTML.match(new RegExp(`key: '${key}',[^\\n]*box: '([\\w-]+)'`))[1];

test('the sliders have the requested ranges and defaults', () => {
  const rows = [['dGu', 40, 160, 90], ['dG', -40, 20, -20], ['esG', -40, 0, -10], ['ts1G', -40, 160, 10],
    ['epG', -60, 10, -30], ['ts2G', -40, 160, 5], ['Tm', 35, 90, 55]];
  for (const [key, min, max, value] of rows) {
    assert.ok(new RegExp(`key: '${key}',[^\\n]*min: ${min},\\s*max: ${max},`).test(HTML), key);
    assert.equal(DEFAULTS[key], value, key);
  }
});

test('the sliders are stacked in three columns', () => {
  assert.equal(columnOf('dGu'), 'column-overall');
  assert.equal(columnOf('dG'), 'column-overall');
  assert.equal(columnOf('esG'), 'column-enzyme');
  assert.equal(columnOf('ts1G'), 'column-enzyme');
  assert.equal(columnOf('epG'), 'column-intermediate');
  assert.equal(columnOf('ts2G'), 'column-intermediate');
  const order = ['column-overall', 'column-enzyme', 'column-intermediate'].map(id => MARKUP.indexOf(`id="${id}"`));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(HTML, /#slider-grid \{ display: grid; grid-template-columns: repeat\(3,/);
});

test('each field has its text box beside the term and its slider below', () => {
  const build = HTML.slice(HTML.indexOf('function buildControls'), HTML.indexOf('function setValue'));
  const head = build.slice(build.indexOf('field-head'), build.indexOf('type="range"'));
  assert.ok(head.indexOf('<label') < head.indexOf('type="number"'), 'the box follows the term');
  assert.match(HTML, /\.field-head \{ display: flex;/);
  assert.match(build, /<\/div>\s*<input type="range"/, 'the slider comes after the head row');
  assert.ok(!HTML.includes('field-range'), 'no text showing the range');
});

test('the controls sit above the diagram in the left column, so the plots start at the top', () => {
  const left = MARKUP.slice(MARKUP.indexOf('id="left-column"'), MARKUP.indexOf('id="plot-column"'));
  assert.ok(left.indexOf('id="controls"') >= 0 && left.indexOf('id="controls"') < left.indexOf('id="diagram"'));
  assert.ok(MARKUP.indexOf('id="main-row"') < MARKUP.indexOf('id="controls"'));
});

test('one button hides or shows the catalyzed plot, and it starts shown', () => {
  assert.ok(MARKUP.includes('<button type="button" id="toggle-cat"></button>'));
  assert.ok(HTML.includes("state.showCat ? 'Hide Catalyzed Plot' : 'Show Catalyzed Plot'"));
  assert.equal(DEFAULTS.showCat, true);
});

test('the energies are named as energies, with one note below them and no unit beside them', () => {
  for (const label of ['ES energy', 'EP energy', 'TS1 energy', 'TS2 energy']) assert.ok(HTML.includes(`label: '${label}'`), label);
  assert.ok(HTML.includes("label: 'ΔG° (overall)'"));
  const grid = MARKUP.indexOf('id="slider-grid"');
  const note = MARKUP.indexOf('<p id="energy-note">Energies are relative to S</p>');
  assert.ok(grid >= 0 && note > grid);
  assert.ok(note < MARKUP.indexOf('id="left-column"') + MARKUP.slice(MARKUP.indexOf('id="left-column"')).indexOf('id="diagram-head"'));
  assert.ok(HTML.includes("field.querySelector('.field-unit').textContent = c.unit || '';"), 'only non-energy fields have a unit');
  for (const line of HTML.match(/\{ key: '(?:dGu|dG|esG|ts1G|epG|ts2G)'[^\n]*/g)) assert.doesNotMatch(line, /unit:/);
});

test('the plot boxes have their text boxes beside their terms, with a short statement to the right', () => {
  assert.match(HTML, /\.small-fields \.field-head \{ justify-content: flex-start;/);
  const footers = [...MARKUP.matchAll(/class="plot-footer">\s*<div class="small-fields" id="(\w+)-fields"><\/div>\s*<p class="plot-statement">([^\n]+)<\/p>/g)];
  assert.deepEqual(footers.map(f => f[1]), ['temp', 'ph']);
  assert.ok(MARKUP.indexOf('id="temp-plot"') < MARKUP.indexOf('id="temp-fields"'));
  assert.ok(MARKUP.indexOf('id="ph-plot"') < MARKUP.indexOf('id="ph-fields"'));
  assert.equal(footers[0][2], 'Activity rises with temperature until the enzyme unfolds near T<sub>m</sub>.');
  assert.equal(footers[1][2], 'Activity optimal is due to protonation or deprotonation of critical groups as pH is adjusted.');
});

test('the trap button is below the plot, in the diagram box, and hides once the trap is on', () => {
  const section = MARKUP.slice(MARKUP.indexOf('id="diagram-head"'), MARKUP.indexOf('id="plot-column"'));
  assert.ok(section.indexOf('id="diagram"') < section.indexOf('id="preset-trap"'));
  assert.ok(section.indexOf('id="preset-trap"') < section.indexOf('id="trap-callout"'));
  assert.ok(HTML.includes("$('preset-trap').hidden = !state.showCat || m.trap;"));
});

test('the check marks sit in the diagram box, at the top right', () => {
  const head = MARKUP.match(/id="diagram-head">[\s\S]*?id="legend"/)[0];
  assert.ok(head.includes('id="show-barriers"') && head.includes('id="show-dg"'));
  assert.ok(head.indexOf('id="diagram-title"') < head.indexOf('id="annotations"'));
  assert.match(HTML, /#diagram-head \{[^}]*justify-content: space-between;/);
  assert.ok(MARKUP.indexOf('id="annotations"') < MARKUP.indexOf('id="diagram"'));
  assert.doesNotMatch(MARKUP.slice(0, MARKUP.indexOf('id="diagram-head"')), /type="checkbox"/);
});

test('the diagram is 30% shorter, and the plots keep their height, temperature above pH, to its right', () => {
  assert.match(HTML, /#diagram \{ height: 336px;/);
  assert.match(HTML, /\.plot-canvas \{ height: 240px;/);
  assert.ok(MARKUP.indexOf('id="diagram"') < MARKUP.indexOf('id="plot-column"'));
  assert.ok(MARKUP.indexOf('id="temp-plot"') < MARKUP.indexOf('id="ph-plot"'));
  const column = MARKUP.slice(MARKUP.indexOf('id="plot-column"'));
  assert.ok(column.includes('id="temp-plot"') && column.includes('id="ph-plot"'));
});

test('removed options are gone from the page', () => {
  for (const gone of ['analog', 'Analog', 'E·TS', 'ENZYME_PRESETS', 'Enzyme</label>', 'include-ep', 'Include EP',
    'id="results"', 'Rate enhancement', 'id="play"', 'id="progress"', 'id="schematic"', 'preset-optimal', 'Optimal catalysis',
    'dHunf: 400', "key: 'dHunf'", 'general base)', 'general acid)',
    'drawSpecies', 'drawEnzyme', 'kind:', 'same for both', 'ΔΔG', 'tsGap', "key: 'tempC'", "key: 'pH'", 'tempC', 'Current ', 'data-view', 'state.view',
    'tsStab', 'ts2Height', 'binding', 'showUncat', 'data-path', 'S → P', 'relative to S)', 'stabilization']) {
    assert.ok(!HTML.includes(gone), gone);
  }
  assert.ok(!MARKUP.includes('type="range"'), 'sliders come only from CONTROLS');
});

test('the Tm field stays, and the pKa fields have plain titles', () => {
  assert.match(HTML, /key: 'Tm',\s*label: 'T<sub>m<\/sub>'/);
  assert.match(HTML, /key: 'pKa1',\s*label: 'pK<sub>a1<\/sub>'/);
  assert.match(HTML, /key: 'pKa2',\s*label: 'pK<sub>a2<\/sub>'/);
});

test('the Quiz Mode button is disabled, greyed out and says Coming soon', () => {
  assert.match(HTML, /<span id="quiz-wrap" title="Coming soon"><button type="button" id="quiz-mode" disabled>Quiz Mode<\/button><\/span>/);
  assert.match(HTML, /button:disabled, input:disabled \{\s*background: #E4E4E4; border-color: #BFBFBF; color: #404040;/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('<script>')), /quiz-mode/, 'no script acts on it yet');
});

test('the page loads nothing from elsewhere', () => {
  assert.doesNotMatch(HTML, /<script[^>]+src|https?:\/\//);
});
