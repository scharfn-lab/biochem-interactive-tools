// Tests for oxygen_binding.html. No dependencies — run with: node --test
//
// The page's model section touches no DOM, so it runs unmodified in a Node vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'oxygen_binding.html'), 'utf8');
const SECTION = HTML.slice(HTML.indexOf('// ═══ 2.'), HTML.indexOf('// ═══ 3.'));
const page = vm.createContext({});
vm.runInContext(SECTION, page);
const { saturation, adultCurve, fetalCurve, withCarbonMonoxide, delivery, shiftFrom, bpgFactor, curvePoints, affinityText, boundSites, schematicMarkup, subunitStates } = page;
const myoglobinCurve = vm.runInContext('myoglobinCurve', page);
const normalHbCurve = vm.runInContext('normalHbCurve', page);

function near(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} is not near ${expected}`);
}

const NORMAL = { pH: 7.4, bpg: 5, pco2: 40 };

// ── Your stated targets ─────────────────────────────────────────
test('default adult Hb: P50 = 26 torr and Y(100) is 0.97–0.98', () => {
  const c = adultCurve(NORMAL);
  near(c.p50, 26);
  assert.equal(c.n, 2.8);
  const y = saturation(c, 100);
  assert.ok(y >= 0.97 && y <= 0.98, String(y));
});

test('at P50, Y is exactly one half', () => {
  near(saturation(adultCurve(NORMAL), 26), 0.5);
  near(saturation(myoglobinCurve(), 2.8), 0.5);
});

test('pH 7.2 gives P50 of about 32 torr (hand: 26 × 10^(0.48 × 0.2) = 32.4)', () => {
  const { p50 } = adultCurve({ ...NORMAL, pH: 7.2 });
  near(p50, 26 * 10 ** 0.096);
  assert.ok(Math.abs(p50 - 32) < 0.6, String(p50));
});

test('pH follows the Bohr slope of −0.48 at any pH', () => {
  for (const pH of [6.8, 7.0, 7.6, 7.8]) {
    const { p50 } = adultCurve({ ...NORMAL, pH });
    near(Math.log10(p50 / 26) / (pH - 7.4), -0.48);
  }
});

test('stripped Hb at 0 mM BPG has P50 of about 1 torr', () => {
  near(adultCurve({ ...NORMAL, bpg: 0 }).p50, 1);
});

test('BPG raises P50 smoothly and levels off', () => {
  let last = 0, lastGain = Infinity;
  for (let bpg = 0; bpg <= 8.0001; bpg += 1) {
    const logP50 = Math.log10(adultCurve({ ...NORMAL, bpg }).p50);
    if (bpg > 0) {
      const gain = logP50 - last;
      assert.ok(gain > 0 && gain < lastGain, `at ${bpg} mM`);
      lastGain = gain;
    }
    last = logP50;
  }
  near(bpgFactor(5), 1);
});

test('pCO₂ 80 gives P50 of about 30 torr, with a modest left shift at 20', () => {
  near(adultCurve({ ...NORMAL, pco2: 80 }).p50, 30);
  const low = adultCurve({ ...NORMAL, pco2: 20 }).p50;
  assert.ok(low < 26 && low > 23, String(low));
});

test('the effects combine multiplicatively on P50', () => {
  const each = {
    pH: adultCurve({ ...NORMAL, pH: 7.1 }).p50 / 26,
    bpg: adultCurve({ ...NORMAL, bpg: 3 }).p50 / 26,
    pco2: adultCurve({ ...NORMAL, pco2: 60 }).p50 / 26,
  };
  near(adultCurve({ pH: 7.1, bpg: 3, pco2: 60 }).p50, 26 * each.pH * each.bpg * each.pco2);
});

// ── Myoglobin ───────────────────────────────────────────────────
test('myoglobin is hyperbolic with P50 = 2.8 torr, and unaffected by conditions', () => {
  const c = myoglobinCurve();
  assert.equal(c.n, 1);
  near(saturation(c, 40), 40 / (2.8 + 40));
});

// ── Fetal Hb ────────────────────────────────────────────────────
test('fetal Hb has P50 of 19 torr at normal conditions', () => {
  near(fetalCurve(NORMAL).p50, 19);
});

test('fetal Hb responds much less to BPG than adult Hb', () => {
  const adultRange = adultCurve({ ...NORMAL, bpg: 5 }).p50 / adultCurve({ ...NORMAL, bpg: 0 }).p50;
  const fetalRange = fetalCurve({ ...NORMAL, bpg: 5 }).p50 / fetalCurve({ ...NORMAL, bpg: 0 }).p50;
  assert.ok(fetalRange > 1 && fetalRange < adultRange / 5, `${fetalRange} vs ${adultRange}`);
});

test('fetal Hb follows pH and CO₂ just as adult Hb does', () => {
  near(fetalCurve({ ...NORMAL, pH: 7.2 }).p50 / 19, adultCurve({ ...NORMAL, pH: 7.2 }).p50 / 26);
  near(fetalCurve({ ...NORMAL, pco2: 80 }).p50 / 19, adultCurve({ ...NORMAL, pco2: 80 }).p50 / 26);
});

test('fetal Hb holds more O₂ than adult Hb at tissue pO₂', () => {
  assert.ok(saturation(fetalCurve(NORMAL), 40) > saturation(adultCurve(NORMAL), 40));
});

// ── Carbon monoxide ─────────────────────────────────────────────
test('at 20% COHb: P50 of about 18 torr, n of about 2.2, and a cap of 0.8', () => {
  const c = withCarbonMonoxide(adultCurve(NORMAL), 0.2);
  near(c.p50, 18);
  near(c.n, 2.2);
  near(c.cap, 0.8);
});

test('O₂ saturation is a fraction of total Hb, with a maximum of 1 − f', () => {
  for (const f of [0.1, 0.2, 0.5]) {
    const c = withCarbonMonoxide(adultCurve(NORMAL), f);
    near(saturation(c, 1e6), 1 - f, 1e-6);
    near(saturation(c, c.p50), (1 - f) / 2);
  }
});

test('0% COHb changes nothing', () => {
  const c = withCarbonMonoxide(adultCurve(NORMAL), 0);
  near(c.p50, 26);
  near(c.n, 2.8);
  assert.equal(c.cap, 1);
});

test('P50 and n both fall as COHb rises, and n never drops below 1', () => {
  let last = withCarbonMonoxide(adultCurve(NORMAL), 0);
  for (let f = 0.05; f <= 0.5001; f += 0.05) {
    const c = withCarbonMonoxide(adultCurve(NORMAL), f);
    assert.ok(c.p50 < last.p50 && c.n < last.n && c.n >= 1, `at ${f}`);
    last = c;
  }
});

test('CO reduces the O₂ delivered at rest', () => {
  const healthy = delivery(adultCurve(NORMAL), 40).delivered;
  const poisoned = delivery(withCarbonMonoxide(adultCurve(NORMAL), 0.2), 40).delivered;
  assert.ok(poisoned < healthy, `${poisoned} vs ${healthy}`);
});

// ── Delivery and shift ──────────────────────────────────────────
test('delivered O₂ is Y(lung) − Y(tissue), and exercise delivers more', () => {
  const c = adultCurve(NORMAL);
  const rest = delivery(c, 40);
  near(rest.delivered, saturation(c, 100) - saturation(c, 40));
  assert.ok(delivery(c, 20).delivered > rest.delivered);
});

test('hand calculation: Y(40) at normal conditions', () => {
  const r = (40 / 26) ** 2.8;
  near(saturation(adultCurve(NORMAL), 40), r / (1 + r));
});

test('the arrow reads right for low pH, left for high pH or fetal Hb, and same at normal', () => {
  assert.equal(shiftFrom(adultCurve(NORMAL).p50), 'none');
  assert.equal(shiftFrom(adultCurve({ ...NORMAL, pH: 7.2 }).p50), 'right');
  assert.equal(shiftFrom(adultCurve({ ...NORMAL, pH: 7.6 }).p50), 'left');
  assert.equal(shiftFrom(adultCurve({ ...NORMAL, pco2: 80 }).p50), 'right');
  assert.equal(shiftFrom(adultCurve({ ...NORMAL, bpg: 2 }).p50), 'left');
  assert.equal(shiftFrom(fetalCurve(NORMAL).p50), 'left');
  assert.equal(shiftFrom(withCarbonMonoxide(adultCurve(NORMAL), 0.2).p50), 'left');
});

// ── Curve sampling ──────────────────────────────────────────────
test('curves start at 0, only rise, and stay at or below their cap over 0–120 torr', () => {
  const curves = [adultCurve(NORMAL), adultCurve({ ...NORMAL, bpg: 0 }), myoglobinCurve(), normalHbCurve(), fetalCurve(NORMAL), withCarbonMonoxide(adultCurve(NORMAL), 0.5)];
  for (const c of curves) {
    const pts = [...curvePoints(c)];
    assert.equal(pts[0].y, 0);
    near(pts[pts.length - 1].x, 120);
    for (let i = 1; i < pts.length; i++) {
      assert.ok(pts[i].y >= pts[i - 1].y && pts[i].y <= c.cap, `at ${pts[i].x}`);
    }
  }
});

test('all slider extremes stay finite', () => {
  for (const pH of [6.8, 7.8]) for (const bpg of [0, 8]) for (const pco2 of [20, 80]) {
    const c = adultCurve({ pH, bpg, pco2 });
    assert.ok(Number.isFinite(c.p50) && c.p50 > 0);
    assert.ok(Number.isFinite(saturation(c, 100)));
    assert.ok(Number.isFinite(fetalCurve({ pH, bpg, pco2 }).p50));
  }
});

// ── The page itself ─────────────────────────────────────────────
test('the page names no specific course', () => {
  assert.ok(!/CHE ?317/.test(HTML));
});

test('the affinity box follows the shift, and says nothing at normal', () => {
  assert.equal(affinityText(shiftFrom(adultCurve({ ...NORMAL, pH: 7.6 }).p50)), 'Higher O₂ affinity (curve shifted to the left)');
  assert.equal(affinityText(shiftFrom(adultCurve({ ...NORMAL, pH: 7.2 }).p50)), 'Lower O₂ affinity (curve shifted to the right)');
  assert.equal(affinityText(shiftFrom(adultCurve(NORMAL).p50)), '');
});

test('the affinity box is red for left, blue for right, and sits above the plot', () => {
  assert.match(HTML, /#affinity-box\.left \{ background: var\(--ut-crimson\);/);
  assert.match(HTML, /#affinity-box\.right \{ background: var\(--blue\);/);
  assert.ok(HTML.indexOf('id="affinity-box"') < HTML.indexOf('<canvas id="plot"'));
});

test('sliders run pH, pCO₂, then 2,3-BPG side by side, below the O₂ delivery buttons', () => {
  assert.match(HTML, /#sliders \{\s+display: grid;\s+grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  for (const key of ['pH', 'pco2', 'bpg']) {
    assert.ok(HTML.indexOf(`id="${key}-number"`) < HTML.indexOf(`id="${key}-range"`), `${key}: the bar sits below its box`);
  }
  assert.match(HTML, /#sliders \.slider-row \{ flex-direction: column;/);
  assert.doesNotMatch(HTML, /#sliders \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, 'phones keep all three on one line');
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('id="toggles"') < at('id="activity-buttons"'));
  assert.ok(at('id="activity-buttons"') < at('id="sliders"'));
  assert.match(HTML, /#conditions \{ display: flex; flex-direction: column;/);
  assert.ok(at('id="pH-range"') < at('id="pco2-range"') && at('id="pco2-range"') < at('id="bpg-range"'));
});

test('O₂ delivery has only Rest and Exercise, with no marker toggle', () => {
  assert.doesNotMatch(HTML, /Lung\/tissue|data-toggle="markers"|show\.markers|Tissue pO₂/);
  assert.match(HTML, /id="activity-label">O₂ delivery:</);
  assert.equal(HTML.match(/data-activity="/g).length, 2);
});

test('P₅₀, the pink band and the old results text are gone', () => {
  assert.doesNotMatch(HTML, /drawP50|P₅₀|P<sub>50<\/sub>|COLORS\.band|results-shift|SHIFT_TEXT/);
  const hill = HTML.slice(HTML.indexOf('function renderHill'), HTML.indexOf('function updateCanvasLabel'));
  assert.doesNotMatch(hill, /Adjustable|p50/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('function updateCanvasLabel'), HTML.indexOf('// ═══ 5.')), /P50|p50/);
});

test('the plot is 10% smaller: 497 px at most, from 552', () => {
  assert.equal(Math.round(552 * 0.9), 497);
  assert.match(HTML, /#plot-wrap \{ max-width: 497px;/);
});

// ── Curves and delivery points ─────────────────────────────────
test('Normal Hb has a Hide checkbox at the top right of the curve, and no button', () => {
  assert.doesNotMatch(HTML, /data-toggle="normal"|>Normal Hb reference</);
  const header = HTML.slice(HTML.indexOf('id="plot-panel"'), HTML.indexOf('<canvas id="plot"'));
  assert.ok(header.indexOf('id="plot-title"') < header.indexOf('id="hide-normal"'), 'after the title, in the header row');
  assert.match(header, /type="checkbox" id="hide-normal">Hide Normal Hb/);
  assert.ok(HTML.includes('state.show.normal = !e.target.checked;'));
  assert.ok(HTML.includes("show: { myoglobin: true, normal: true,"), 'shown by default');
});

test('delivery dots are blue, with the reference half the size of Adjusted Hb', () => {
  const sizes = HTML.match(/const DELIVERY_DOT = \{ adjusted: ([\d.]+), normal: ([\d.]+) \}/);
  assert.equal(Number(sizes[2]), Number(sizes[1]) / 2);
  const draw = HTML.slice(HTML.indexOf('function drawPlot'), HTML.indexOf('let frame = 0'));
  assert.ok(draw.includes('drawDeliveryDots(ctx, g, currentCurve(), DELIVERY_DOT.adjusted)'));
  assert.ok(draw.includes('if (state.show.normal) drawDeliveryDots(ctx, g, normalHbCurve(), DELIVERY_DOT.normal)'));
  assert.ok(draw.indexOf('drawCurves(') < draw.indexOf('drawDeliveryDots('), 'over the curves');
  assert.match(HTML.slice(HTML.indexOf('function drawDeliveryDots')), /ctx\.fillStyle = COLORS\.blue/);
});

test('pressing the selected O₂ delivery button hides the markings', () => {
  assert.ok(HTML.includes('state.activity = button.dataset.activity === state.activity ? null : button.dataset.activity;'));
  const draw = HTML.slice(HTML.indexOf('function drawPlot'), HTML.indexOf('let frame = 0'));
  assert.match(draw, /if \(state\.activity\) \{\s+drawDeliveryDots/);
  for (const fn of ['drawMarkers', 'drawDeliveryLabel']) {
    assert.match(HTML, new RegExp(`function ${fn}\\(ctx, g, curve\\) \\{\\s+if \\(!state\\.activity\\) return;`), fn);
  }
});

test('the label reads Adjusted Hb, never Adjustable', () => {
  assert.doesNotMatch(HTML, /Adjustable/);
  assert.ok(HTML.includes("'Adjusted Hb'"));
});

// ── Layout ─────────────────────────────────────────────────────
test('Conditions and the schematic stack left of the curve, with no Results box', () => {
  const at = marker => HTML.indexOf(marker);
  assert.doesNotMatch(HTML, /results-title|results-table|renderResults|controls-row/);
  assert.ok(at('id="plot-row"') < at('id="side-column"'));
  assert.ok(at('id="side-column"') < at('id="controls-title"'));
  assert.ok(at('id="controls-title"') < at('id="schematic-title"'));
  assert.ok(at('id="schematic-title"') < at('id="plot-title"'));
  assert.match(HTML, /#plot-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 533px\); \}/);
});

// ── Schematic ──────────────────────────────────────────────────
test('the pO₂ slider sits at the bottom of the schematic and runs 0 to 120 torr', () => {
  const box = HTML.slice(HTML.indexOf('id="schematic-panel"'), HTML.indexOf('id="plot-panel"'));
  assert.ok(box.indexOf('</svg>') < box.indexOf('id="po2-range"'));
  assert.match(box, /id="po2-range" min="0" max="120"/);
});

test('the schematic has its name for screen readers and moves gently', () => {
  assert.match(HTML, /\$\('schematic'\)\.setAttribute\('aria-label'/);
  assert.match(HTML, /prefers-reduced-motion: reduce\) \{ \.o2-site \{ transition: none; \} \}/);
  assert.match(HTML, /\{ key: 'po2', decimals: 0, name: 'pO₂' \}/);
});

// ── Hill coefficient ───────────────────────────────────────────
test('the Hill coefficient and a short descriptor sit below the plot, hidden in the quiz', () => {
  const panel = HTML.slice(HTML.indexOf('id="plot-panel"'), HTML.indexOf('</main>'));
  assert.ok(panel.indexOf('<canvas id="plot"') < panel.indexOf('id="hill-note"'));
  const hill = HTML.slice(HTML.indexOf('function renderHill'), HTML.indexOf('function updateCanvasLabel'));
  assert.match(hill, /Hill coefficient, n/);
  assert.match(hill, /c\.curve\.n\.toFixed\(2\)/);
  assert.match(hill, /\$\{HILL_DESCRIPTOR\}/);
  assert.ok(HTML.includes("$('hill-note').hidden = on;"));
});

// ── Schematic population ───────────────────────────────────────
const count = (text, pattern) => (text.match(pattern) || []).length;

test('each cell holds 12 molecules: 12 Mb sites and 48 Hb sites', () => {
  const mb = schematicMarkup('mb'), hb = schematicMarkup('hb');
  assert.equal(count(mb, /class="globin/g), 12);
  assert.equal(count(mb, /id="mb-site-/g), 12);
  assert.equal(count(hb, /<rect class="globin/g), 48, 'a T square for four subunits in each of 12');
  assert.equal(count(hb, /<circle class="globin/g), 48, 'and an R circle for each');
  assert.equal(count(hb, /id="hb-site-/g), 48);
  for (const [markup, key, total] of [[mb, 'mb', 12], [hb, 'hb', 48]]) {
    const ids = [...markup.matchAll(new RegExp(`id="${key}-site-(\\d+)"`, 'g'))].map(m => Number(m[1])).sort((a, b) => a - b);
    assert.deepEqual([...ids], Array.from({ length: total }, (_, i) => i), `${key} sites are numbered once each`);
  }
});

test('the molecules are much smaller than before', () => {
  const radii = text => [...text.matchAll(/class="globin[^"]*"[^>]* r="([\d.]+)"/g)].map(m => Number(m[1]));
  assert.ok(Math.max(...radii(schematicMarkup('mb'))) <= 10, 'Mb was about 65');
  assert.ok(Math.max(...radii(schematicMarkup('hb'))) <= 7, 'Hb subunits were about 50');
});

test('hemoglobin fills one molecule at a time, in a scattered order', () => {
  const rank = vm.runInContext('MOLECULE_FILL_RANK', page);
  assert.deepEqual([...rank].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i));
  assert.notDeepEqual([...rank], Array.from({ length: 12 }, (_, i) => i), 'not top to bottom');
  const hb = schematicMarkup('hb');
  // Sites 0-3 belong to one molecule: the same four lobes around one center
  const center = i => {
    const m = hb.match(new RegExp(`id="hb-site-${i}" cx="([\\d.]+)" cy="([\\d.]+)"`));
    return [Number(m[1]), Number(m[2])];
  };
  const xs = [0, 1, 2, 3].map(i => center(i)[0]), ys = [0, 1, 2, 3].map(i => center(i)[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) <= 11 && Math.max(...ys) - Math.min(...ys) <= 11);
});

test('hand check: bound sites follow saturation across both populations', () => {
  const hb = adultCurve(NORMAL), mb = myoglobinCurve();
  assert.equal(boundSites(hb, 0, 48), 0);
  assert.equal(boundSites(hb, 26, 48), 24, 'P50 gives half of the sites');
  assert.equal(boundSites(hb, 40, 48), 37, 'Y ≈ 0.770');
  assert.equal(boundSites(hb, 100, 48), 47, 'Y ≈ 0.978');
  assert.equal(boundSites(mb, 2.8, 12), 6, 'Mb at its P50');
  assert.equal(boundSites(mb, 40, 12), 11, 'Y ≈ 0.935');
  assert.equal(boundSites(mb, 0, 12), 0);
});

test('at tissue pO₂, myoglobin holds its O₂ while hemoglobin has released most', () => {
  const hb = adultCurve(NORMAL), mb = myoglobinCurve();
  assert.ok(boundSites(mb, 20, 12) / 12 > 0.8);
  assert.ok(boundSites(hb, 20, 48) / 48 < 0.4);
});

test('a vertical line separates the two cells, each named and drawn', () => {
  const svg = HTML.slice(HTML.indexOf('id="schematic"'), HTML.indexOf('</svg>', HTML.indexOf('id="schematic"')));
  const line = svg.match(/id="schematic-divider" x1="(\d+)" y1="\d+" x2="(\d+)"/);
  assert.equal(line[1], line[2], 'vertical');
  const divider = Number(line[1]);
  const x = name => Number(svg.match(new RegExp(`<text[^>]* x="(\\d+)"[^>]*>${name}<`))[1]);
  assert.ok(x('Myoglobin') < divider && x('Hemoglobin') > divider);
  assert.ok(svg.includes('in a cardiac muscle cell') && svg.includes('in a red blood cell'));
  assert.match(svg, /fill="#C8102E" fill-opacity="0\.12"/, 'a see-through red blood cell');
  for (const key of ['mb', 'hb']) {
    const { xs } = vm.runInContext(`SCHEMATIC_MOLECULES.${key}`, page);
    for (const value of xs) assert.equal(value < divider, key === 'mb', `${key} stays on its side`);
  }
  assert.ok(HTML.includes('sites: 12, curve: myoglobinCurve') && HTML.includes('sites: 48, curve: currentCurve'));
});

// ── Selected point and purple arrow ────────────────────────────
test('the red point starts clear of the blue points at the lung and tissue pO₂', () => {
  const start = Number(HTML.match(/po2: (\d+),/)[1]);
  for (const key of ['lung', 'rest', 'exercise']) assert.notEqual(start, vm.runInContext(`MODEL.tissue.${key}`, page), key);
});

test('a large red point marks Adjusted Hb at the selected pO₂', () => {
  const size = Number(HTML.match(/const SELECTED_DOT = (\d+);/)[1]);
  assert.ok(size > Number(HTML.match(/DELIVERY_DOT = \{ adjusted: (\d+)/)[1]), 'larger than the blue points');
  const fn = HTML.slice(HTML.indexOf('function drawSelectedPoint'), HTML.indexOf('function drawCurves'));
  assert.ok(fn.includes('saturation(currentCurve(), state.po2)'));
  assert.ok(fn.includes('ctx.fillStyle = COLORS.crimson'));
});

test('clicking or dragging on the plot places the point, in whole torr, inside the axes', () => {
  const fn = HTML.slice(HTML.indexOf('function placeSelectedPoint'), HTML.indexOf('function setHover'));
  assert.ok(fn.includes('state.po2 = Math.round((x - g.left) / g.plotW * PLOT.xMax);'));
  assert.match(fn, /x < g\.left \|\| x > g\.left \+ g\.plotW \|\| y < g\.top \|\| y > g\.top \+ g\.plotH\) return;/);
  assert.match(HTML, /addEventListener\('pointerdown', e => \{\s+placeSelectedPoint\(e\);/);
  assert.match(HTML, /if \(e\.buttons\) placeSelectedPoint\(e\);/);
});

test('the purple arrow runs between the curves, with no horizontal lines of its own', () => {
  const fn = HTML.slice(HTML.indexOf('function drawShiftArrow'), HTML.indexOf('function drawSelectedPoint'));
  assert.ok(fn.includes('COLORS.purple'));
  assert.equal(count(fn, /const x = g\.sx\(state\.po2\)/g), 1);
  assert.doesNotMatch(fn, /g\.left, |lineTo\(g\.|moveTo\(g\./, 'nothing runs out to the axis');
  const shift = HTML.slice(HTML.indexOf('function shiftAtSelected'), HTML.indexOf('function drawShiftArrow'));
  assert.ok(shift.includes('if (!state.show.normal) return null;'), 'no reference, no arrow');
  assert.ok(shift.includes('normalHbCurve()') && shift.includes('currentCurve()'));
});

test('the second y axis is titled Percent saturation', () => {
  const axes = HTML.slice(HTML.indexOf('function drawAxes'), HTML.indexOf('function labelWithHalo'));
  assert.ok(axes.includes("ctx.fillText('Percent saturation', 0, 0);"));
  assert.ok(axes.includes("ctx.fillText('Fractional saturation, Y', 0, 0);"));
});

test('the plot draws the arrow and red point over the curves, and the blue points over those', () => {
  const draw = HTML.slice(HTML.indexOf('function drawPlot'), HTML.indexOf('let frame = 0'));
  const steps = ['drawCurves(ctx, g, curves)', 'drawShiftArrow(ctx, g)', 'drawSelectedPoint(ctx, g)', 'drawDeliveryDots(ctx, g, currentCurve()'];
  const places = steps.map(step => draw.indexOf(step));
  assert.ok(places.every(place => place >= 0), 'each is drawn');
  assert.deepEqual(places, [...places].sort((a, b) => a - b), steps.join(' < '));
});

// ── Wording ────────────────────────────────────────────────────
test('the Hill coefficient descriptor and O₂ delivery legend read as asked', () => {
  assert.ok(HTML.includes("'Measures cooperativity (>1 is cooperative)'"));
  assert.doesNotMatch(HTML, /O₂ delivery points/);
  const legend = HTML.slice(HTML.indexOf('function renderLegend'), HTML.indexOf('const fmtPercent'));
  assert.match(legend, /stroke="\$\{COLORS\.blue\}"[^`]*fill="\$\{COLORS\.blue\}"[^`]*O₂ delivery</, 'a blue arrow, not a dot');
  assert.doesNotMatch(legend, /<circle[^>]*COLORS\.blue/);
});

// ── Concerted and sequential ───────────────────────────────────
const flatStates = (model, bound) => [...subunitStates(model, bound)].flatMap(m => [...m]);
const boundCount = (model, bound) => flatStates(model, bound).filter(s => s.bound).length;

test('both models hold exactly the sites the curve calls for', () => {
  for (const model of ['concerted', 'sequential']) {
    for (let bound = 0; bound <= 48; bound++) assert.equal(boundCount(model, bound), bound, `${model} ${bound}`);
  }
});

test('in the concerted model every molecule is all T or all R', () => {
  for (let bound = 0; bound <= 48; bound++) {
    for (const molecule of subunitStates('concerted', bound)) {
      assert.equal(new Set([...molecule].map(s => s.relaxed)).size, 1, `${bound} bound`);
      assert.equal(molecule[0].relaxed, [...molecule].some(s => s.bound), 'R once any O₂ is bound');
    }
  }
});

test('in the sequential model a subunit is in R only while it holds O₂', () => {
  for (let bound = 0; bound <= 48; bound++) {
    for (const s of flatStates('sequential', bound)) assert.equal(s.relaxed, s.bound);
  }
  const mixed = [...subunitStates('sequential', 18)].filter(m => new Set([...m].map(s => s.relaxed)).size === 2);
  assert.ok(mixed.length > 0, 'T and R share a molecule');
});

test('the concerted model fills one molecule before the next', () => {
  const partial = bound => [...subunitStates('concerted', bound)].filter(m => [...m].some(s => s.bound) && ![...m].every(s => s.bound)).length;
  for (let bound = 0; bound <= 48; bound++) assert.equal(partial(bound), bound % 4 ? 1 : 0, `${bound} bound`);
});

test('the two model buttons sit under hemoglobin, with a plain T and R key', () => {
  const box = HTML.slice(HTML.indexOf('id="schematic-panel"'), HTML.indexOf('id="plot-panel"'));
  assert.ok(box.indexOf('data-model="concerted">Concerted Model') > 0);
  assert.ok(box.indexOf('data-model="concerted"') < box.indexOf('data-model="sequential">Sequential Model'));
  const lastCaption = box.indexOf('id="hb-percent"');
  assert.ok(lastCaption > 0 && lastCaption < box.indexOf('</svg>'), 'the saturation caption is in the drawing');
  assert.ok(box.indexOf('</svg>') < box.indexOf('data-model="concerted"'), 'below the drawing and its caption');
  assert.match(HTML, /#model-buttons \{[^}]*width: 50%; margin: 4px 0 0 50%;/, 'on the hemoglobin half');
  assert.ok(box.includes('>T state<') && box.includes('>R state<'));
  assert.doesNotMatch(box, /low affinity|high affinity/);
  assert.ok(HTML.includes("hbModel: 'concerted',"), 'starts on concerted');
});

test('hemoglobin subunits are numbered once each, in all three layers', () => {
  const hb = schematicMarkup('hb');
  for (const layer of ['hb-t', 'hb-r', 'hb-site']) {
    const ids = [...hb.matchAll(new RegExp(`id="${layer}-(\\d+)"`, 'g'))].map(m => Number(m[1])).sort((a, b) => a - b);
    assert.deepEqual(ids, Array.from({ length: 48 }, (_, i) => i), layer);
  }
});

// ── Quiz questions ─────────────────────────────────────────────
// Repeatable random numbers (mulberry32), so a failure can be reproduced.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const { buildQuizQuestion, createQuizDeck, gradeQuizAnswer, quizCurveEntries } = page;
const plain = value => JSON.parse(JSON.stringify(value));
const TOPICS = Object.keys(vm.runInContext('QUIZ_TOPICS', page));
const CHANGES = plain(vm.runInContext('QUIZ_CHANGES', page));
const manyOf = (topic, n = 300) => Array.from({ length: n }, (_, i) => buildQuizQuestion(topic, seeded(i + 1)));

// By hand from the textbook, not from the page's model
const EXPECTED_SHIFT = { pHDown: 'right', hUp: 'right', co2Up: 'right', bpgUp: 'right', pHUp: 'left', hDown: 'left', co2Down: 'left', bpgDown: 'left' };

test('there are eight topics, and all of them build', () => {
  assert.deepEqual([...TOPICS].sort(), ['causes', 'fetal', 'match', 'mbHb', 'models', 'predict', 'scenarios', 'twoChanges']);
  for (const topic of TOPICS) assert.ok(manyOf(topic, 20).length);
});

test('every question has a valid answer among unique options, and an explanation', () => {
  for (const topic of TOPICS) {
    for (const q of manyOf(topic)) {
      const options = [...q.options];
      assert.equal(new Set(options).size, options.length, q.prompt);
      assert.ok(q.prompt.length > 10 && q.explanation.length > 10, q.prompt);
      assert.ok(['single', 'multi', 'match'].includes(q.format));
      if (q.format === 'single') assert.ok(options.includes(q.answer), `${q.prompt}: ${q.answer}`);
      if (q.format === 'multi') for (const a of q.answer) assert.ok(options.includes(a), a);
      if (q.format === 'match') for (const row of q.rows) assert.ok(options.includes(q.answer[row]), row);
    }
  }
});

test('every change moves the curve the textbook way, by enough to see', () => {
  const normalP50 = normalHbCurve().p50;
  for (const [key, expected] of Object.entries(EXPECTED_SHIFT)) {
    const p50 = adultCurve({ ...NORMAL, ...CHANGES[key].conditions }).p50;
    assert.equal(p50 > normalP50 ? 'right' : 'left', expected, key);
    assert.ok(Math.abs(p50 / normalP50 - 1) >= 0.05, `${key}: P50 ${p50}`);
  }
});

test('[H⁺] questions go the opposite way from the same pH wording', () => {
  const direction = key => EXPECTED_SHIFT[key];
  assert.equal(direction('hUp'), direction('pHDown'));
  assert.equal(direction('hDown'), direction('pHUp'));
  assert.deepEqual(plain(CHANGES.hUp.conditions), plain(CHANGES.pHDown.conditions), 'the same solution, said two ways');
  assert.deepEqual(plain(CHANGES.hDown.conditions), plain(CHANGES.pHUp.conditions));
});

test('predict answers agree with the model and the textbook', () => {
  const seen = { shift: 0, affinity: 0, delivery: 0 };
  for (const q of manyOf('predict', 600)) {
    const key = Object.keys(CHANGES).find(k => q.curves[1].name === CHANGES[k].label);
    const expected = EXPECTED_SHIFT[key];
    if (/which way/i.test(q.prompt)) { seen.shift++; assert.equal(q.answer, expected === 'right' ? 'To the right' : 'To the left', q.prompt); }
    if (/affinity/.test(q.prompt)) { seen.affinity++; assert.equal(q.answer, expected === 'left' ? 'It increases' : 'It decreases', q.prompt); }
    if (/delivered/.test(q.prompt)) {
      seen.delivery++;
      const changed = delivery(adultCurve({ ...NORMAL, ...CHANGES[key].conditions }), 40).delivered, normal = delivery(normalHbCurve(), 40).delivered;
      assert.equal(q.answer, changed > normal ? 'More O₂ is delivered' : 'Less O₂ is delivered', q.prompt);
      assert.equal(q.answer, expected === 'right' ? 'More O₂ is delivered' : 'Less O₂ is delivered', `${key}: at rest, a right shift delivers more`);
    }
  }
  assert.ok(seen.shift && seen.affinity && seen.delivery, JSON.stringify(seen));
});

test('explanations in [H⁺] terms talk about [H⁺]', () => {
  for (const q of manyOf('predict', 400)) {
    if (q.prompt.includes('[H⁺]') && q.format === 'single') assert.match(q.explanation, /\[H⁺\]/, q.prompt);
  }
});

test('Mb vs Hb questions point at the right curve', () => {
  for (const q of manyOf('mbHb')) {
    const mb = q.curves.find(c => c.name === 'Myoglobin'), hb = q.curves.find(c => c.name === 'Normal Hb');
    if (/is myoglobin/.test(q.prompt)) assert.equal(q.answer, `Curve ${mb.letter}`);
    if (/cooperative/.test(q.prompt)) assert.equal(q.answer, `Curve ${hb.letter}`);
    if (/holds more/.test(q.prompt)) assert.equal(q.answer, `Curve ${mb.letter}`, 'Mb holds its O₂ at tissue pO₂');
    if (/four/.test(q.prompt)) assert.equal(q.answer, `Curve ${hb.letter}`);
    assert.notEqual(mb.letter, hb.letter);
  }
});

test('fetal questions point at the left-shifted curve', () => {
  for (const q of manyOf('fetal')) {
    const fetal = q.curves.find(c => c.name === 'Fetal Hb');
    assert.ok(fetal.curve.p50 < q.curves.find(c => c.name === 'Adult Hb').curve.p50);
    if (/is fetal/.test(q.prompt) || /more saturated/.test(q.prompt)) assert.equal(q.answer, `Curve ${fetal.letter}`);
    if (/2,3-BPG|higher O₂ affinity than adult/.test(q.prompt)) assert.equal(q.answer, 'It binds 2,3-BPG less tightly');
  }
});

test('match questions never pair two causes in the same direction', () => {
  const rightLabels = new Set(Object.keys(EXPECTED_SHIFT).filter(k => EXPECTED_SHIFT[k] === 'right').map(k => CHANGES[k].label));
  for (const q of manyOf('match')) {
    const causes = [...q.options];
    assert.equal(causes.length, 2, q.prompt);
    assert.equal(causes.filter(c => rightLabels.has(c)).length, 1, causes.join());
    for (const row of q.rows) {
      const curve = q.curves.find(c => c.letter === row.slice(-1));
      assert.equal(shiftFrom(curve.curve.p50), rightLabels.has(q.answer[row]) ? 'right' : 'left', `${row} ${q.answer[row]}`);
    }
  }
});

test('any plot with more than two curves names one as Normal Hb, before answering', () => {
  let checked = 0;
  for (const topic of TOPICS) {
    for (const q of manyOf(topic, 200)) {
      const shown = [...quizCurveEntries(q, false)];
      if (shown.length <= 2) continue;
      checked++;
      const references = shown.filter(c => c.name === 'Normal Hb');
      assert.equal(references.length, 1, `${topic}: ${q.prompt}`);
      assert.equal(references[0].letter, undefined, 'named, not lettered');
      near(references[0].curve.p50, normalHbCurve().p50);
    }
  }
  assert.ok(checked > 100, `${checked} plots checked`);
});

test('every lettered curve in a match or checkbox question is compared with a named Normal Hb', () => {
  for (const topic of ['match', 'causes']) {
    for (const q of manyOf(topic, 100)) {
      assert.ok([...quizCurveEntries(q, false)].some(c => c.name === 'Normal Hb'), topic);
      assert.match(q.prompt, /Normal Hb/, 'the question refers to it by name');
      assert.doesNotMatch(q.prompt, /dotted|gray/, 'and not by how it looks');
    }
  }
  assert.doesNotMatch(HTML, /No change|normal conditions, and the other/);
});

test('Normal Hb is named on the plot itself', () => {
  const fn = HTML.slice(HTML.indexOf('function drawNormalHbLabel'), HTML.indexOf('function drawCurves'));
  assert.ok(fn.includes("labelWithHalo(ctx, 'Normal Hb',"));
  assert.ok(fn.includes("c.key === 'normal'"));
  assert.match(HTML, /drawNormalHbLabel\(ctx, g, curves\);\s+drawCurves\(ctx, g, curves\);/, 'behind the curves, so it hides none of them');
});

test('checkbox questions: every option in the curve\'s direction is correct, and only those', () => {
  const label = key => CHANGES[key].label;
  for (const q of manyOf('causes')) {
    assert.equal(q.format, 'multi');
    assert.equal(q.options.length, 6);
    assert.ok(q.answer.length >= 2 && q.answer.length <= 4, String(q.answer.length));
    const shift = shiftFrom(q.curves.find(c => c.letter === 'A').curve.p50);
    const expected = Object.keys(EXPECTED_SHIFT).filter(k => EXPECTED_SHIFT[k] === shift).map(label);
    for (const option of q.options) assert.equal([...q.answer].includes(option), expected.includes(option), option);
  }
});

test('two-change questions push the same way, and the curve goes that way', () => {
  for (const q of manyOf('twoChanges')) {
    const [first, second] = q.curves[1].name.split(', ');
    const keys = [first, second].map(l => Object.keys(CHANGES).find(k => CHANGES[k].label === l));
    assert.equal(EXPECTED_SHIFT[keys[0]], EXPECTED_SHIFT[keys[1]], q.curves[1].name);
    assert.notDeepEqual(plain(CHANGES[keys[0]].conditions), plain(CHANGES[keys[1]].conditions), 'two real changes, not pH twice');
    assert.equal(q.answer, EXPECTED_SHIFT[keys[0]] === 'right' ? 'To the right' : 'To the left', q.prompt);
  }
});

test('physiological scenarios shift the textbook way', () => {
  const expected = { 'Exercising muscle': 'To the right', 'High altitude': 'To the right', Acidosis: 'To the right', 'Stored blood': 'To the left', Hyperventilation: 'To the left' };
  const seen = new Set();
  for (const q of manyOf('scenarios')) {
    const name = q.curves[1].name;
    seen.add(name);
    assert.equal(q.answer, expected[name], name);
  }
  assert.deepEqual([...seen].sort(), Object.keys(expected).sort(), 'all appear');
  assert.ok(manyOf('scenarios').some(q => /several days/.test(q.prompt)), 'altitude says after several days');
});

test('concerted and sequential questions have the right answers and no plot', () => {
  for (const q of manyOf('models')) {
    assert.equal(q.curves.length, 0);
    if (/all four subunits/.test(q.prompt) || /MWC/.test(q.prompt)) assert.equal(q.answer, 'Concerted model');
    if (/T and R subunits at once/.test(q.prompt) || /KNF/.test(q.prompt) || /only the subunit/.test(q.prompt)) assert.equal(q.answer, 'Sequential model');
    if (/sigmoidal/.test(q.prompt)) assert.equal(q.answer, 'Both models');
  }
});

// ── Dealing ────────────────────────────────────────────────────
test('exactly one question in every five uses checkboxes, at varying places', () => {
  const deck = createQuizDeck(seeded(7));
  const places = new Set();
  for (let block = 0; block < 100; block++) {
    const five = Array.from({ length: 5 }, () => deck.next());
    const checkbox = five.map((q, i) => (q.format === 'multi' ? i : -1)).filter(i => i >= 0);
    assert.equal(checkbox.length, 1, `block ${block}`);
    places.add(checkbox[0]);
  }
  assert.equal(places.size, 5, 'every place gets used');
});

test('all topics come up within a couple of bags, and a question never repeats back to back', () => {
  const deck = createQuizDeck(seeded(11));
  const questions = Array.from({ length: 400 }, () => deck.next());
  assert.deepEqual([...new Set(questions.map(q => q.topic))].sort(), [...TOPICS].sort());
  for (const start of [0, 100, 200]) {
    assert.equal(new Set(questions.slice(start, start + 20).map(q => q.topic)).size, TOPICS.length, 'none is left out for long');
  }
  for (let i = 1; i < questions.length; i++) assert.notEqual(questions[i].prompt, questions[i - 1].prompt, `question ${i}`);
});

// ── Grading ────────────────────────────────────────────────────
test('single choice grades exactly', () => {
  const q = { format: 'single', answer: 'To the left' };
  assert.equal(gradeQuizAnswer(q, 'To the left'), true);
  assert.equal(gradeQuizAnswer(q, 'To the right'), false);
});

test('a partly right checkbox answer scores as wrong', () => {
  const q = { format: 'multi', answer: ['a', 'b'] };
  assert.equal(gradeQuizAnswer(q, ['b', 'a']), true, 'order does not matter');
  assert.equal(gradeQuizAnswer(q, ['a']), false, 'one missing');
  assert.equal(gradeQuizAnswer(q, ['a', 'b', 'c']), false, 'one extra');
  assert.equal(gradeQuizAnswer(q, ['a', 'c']), false, 'same count, one wrong');
});

test('a match answer needs every row right', () => {
  const q = { format: 'match', rows: ['Curve A', 'Curve B'], answer: { 'Curve A': 'x', 'Curve B': 'y' } };
  assert.equal(gradeQuizAnswer(q, { 'Curve A': 'x', 'Curve B': 'y' }), true);
  assert.equal(gradeQuizAnswer(q, { 'Curve A': 'y', 'Curve B': 'x' }), false);
  assert.equal(gradeQuizAnswer(q, { 'Curve A': 'x' }), false);
});

test('curve names stay hidden until the question is answered', () => {
  const names = /Myoglobin|Fetal|Adult|Decreased|Increased|No change|Exercising|altitude|Acidosis|Stored|Hyperventilation/;
  for (const topic of TOPICS) {
    for (const q of manyOf(topic, 100)) {
      const before = [...quizCurveEntries(q, false)];
      for (const c of before) {
        if (c.name !== 'Normal Hb') assert.match(c.name, /^Curve [ABC]$/, `${topic}: ${c.name}`);
        assert.doesNotMatch(c.name, names, topic);
      }
      assert.equal(before.length, q.curves.filter(c => !c.afterAnswer).length);
      for (const c of quizCurveEntries(q, true)) {
        if (topic === 'mbHb' || topic === 'fetal') assert.match(c.name, /: /, 'named after answering');
      }
    }
  }
});

test('in match questions Normal Hb never gives away a lettered curve', () => {
  for (const q of manyOf('mbHb')) {
    const before = [...quizCurveEntries(q, false)];
    assert.ok(before.every(c => c.letter), 'the Hb curve here is a letter, not named');
  }
});

// ── Page wiring ────────────────────────────────────────────────
test('the quiz button sits above the page, and the quiz panel starts hidden', () => {
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('id="quiz-toggle"') < at('id="controls-panel"'));
  assert.match(HTML, /id="quiz-panel"[^>]*hidden/);
  const fn = HTML.slice(HTML.indexOf('function setQuizMode'), HTML.indexOf("$('quiz-toggle').addEventListener"));
  for (const id of ['controls-panel', 'schematic-panel', 'affinity-box', 'hide-normal-label']) assert.ok(fn.includes(`$('${id}').hidden = on;`), id);
});

test('the quiz never changes the conditions, and clicks do not place the point', () => {
  const section = HTML.slice(HTML.indexOf('// ── Quiz Mode ──'), HTML.indexOf('// Hover readout'));
  assert.doesNotMatch(section, /state\.(pH|bpg|pco2|po2|coh|activity|show|hbModel)\b/);
  assert.match(HTML, /function placeSelectedPoint\(e\) \{\s+if \(quiz\.active\) return;/);
  assert.match(HTML, /if \(quiz\.active\) \{\s+drawNormalHbLabel\(ctx, g, curves\);\s+drawCurves\(ctx, g, curves\);\s+drawCurveLetters/, 'no delivery markings, arrow or red point');
});

test('feedback uses the shared answer colors with ✓ and ✗', () => {
  assert.match(HTML, /#quiz-feedback\.right \{ background: #DBEAFE; border-color: #1565C0;/);
  assert.match(HTML, /#quiz-feedback\.wrong \{ background: #FFEBEE; border-color: #C8102E;/);
  assert.ok(HTML.includes("'✓ Correct.'") && HTML.includes("'✗ Not quite.'"));
});

test('chemical names keep their capitals in every question', () => {
  const bad = /bpg|\[h⁺\]|pco₂|\bph\b/;
  for (const topic of TOPICS) {
    for (const q of manyOf(topic, 150)) {
      const entries = [...quizCurveEntries(q, true)].map(c => c.name);
      for (const text of [q.prompt, q.explanation, ...[].concat(q.options || []), ...entries]) assert.doesNotMatch(text, bad, text);
    }
  }
});

test('the sequential model spreads O₂ across the molecules', () => {
  for (const [bound, each] of [[12, 1], [24, 2], [36, 3]]) {
    for (const molecule of subunitStates('sequential', bound)) {
      assert.equal([...molecule].filter(s => s.bound).length, each, `${bound} bound`);
    }
  }
});

// ── Check Answer with nothing entered ──────────────────────────
test('the answer status tells blank, partial and complete apart', () => {
  const status = page.quizAnswerStatus;
  const single = { format: 'single' }, multi = { format: 'multi' }, match = { format: 'match', rows: ['Curve A', 'Curve B'] };
  assert.equal(status(single, null), 'blank');
  assert.equal(status(single, 'To the left'), 'complete');
  assert.equal(status(multi, []), 'blank');
  assert.equal(status(multi, ['a']), 'complete');
  assert.equal(status(match, {}), 'blank');
  assert.equal(status(match, { 'Curve A': 'x' }), 'partial');
  assert.equal(status(match, { 'Curve A': 'x', 'Curve B': 'y' }), 'complete');
});

test('a blank Check Answer reveals the answer and leaves the score alone', () => {
  const fn = HTML.slice(HTML.indexOf('function checkQuizAnswer'), HTML.indexOf('function nextQuizQuestion'));
  const blank = fn.slice(fn.indexOf("status === 'blank'"), fn.indexOf('const right = gradeQuizAnswer'));
  assert.ok(blank.includes("finishQuizQuestion('revealed', 'Answer revealed.');"));
  assert.ok(blank.includes('return;'));
  assert.doesNotMatch(blank, /quiz\.total|quiz\.correct|topic/, 'nothing is counted');
  assert.ok(fn.indexOf("status === 'blank'") < fn.indexOf('quiz.total++'), 'decided before counting');
  assert.doesNotMatch(fn, /Choose an answer first/);
  assert.ok(fn.includes("'Choose an answer for every curve.'"), 'a half-finished match still asks for the rest');
});

test('a revealed answer has its own neutral style, not right or wrong', () => {
  assert.match(HTML, /#quiz-feedback\.revealed \{ background: #FFFFFF;/);
});

// ── Layout of the controls ─────────────────────────────────────
test('Reset to Normal sits right of Quiz Mode, and leaves during a quiz', () => {
  const bar = HTML.slice(HTML.indexOf('<div id="quiz-bar">'), HTML.indexOf('id="controls-panel"'));
  assert.ok(bar.indexOf('id="quiz-toggle"') >= 0 && bar.indexOf('id="quiz-toggle"') < bar.indexOf('id="reset">Reset to Normal'));
  assert.equal(HTML.split('id="reset"').length, 2, 'only once');
  assert.ok(HTML.includes("$('reset').hidden = on;"));
});

test('the Conditions box says Curves, with no Show heading, reference or carbon monoxide', () => {
  const box = HTML.slice(HTML.indexOf('id="controls-title"'), HTML.indexOf('id="quiz-panel"'));
  assert.doesNotMatch(box, />Show</);
  const at = text => box.indexOf(text);
  assert.ok(at('>Curves:<') > 0 && at('>Curves:<') < at('data-toggle="myoglobin">Myoglobin<') && at('data-toggle="myoglobin"') < at('data-toggle="fetal">Fetal Hb<'));
  assert.doesNotMatch(HTML, /Myoglobin reference/);
});

test('carbon monoxide is gone from the page, with its model kept', () => {
  const page = HTML.slice(0, HTML.indexOf('// ═══ 2.'));
  assert.doesNotMatch(page, /Carbon monoxide|COHb|co-control|coh-/i);
  const after = HTML.slice(HTML.indexOf('// ═══ 3.'));
  assert.doesNotMatch(after, /withCarbonMonoxide|show\.co|state\.coh|co-results|'coh'/);
  assert.ok(HTML.includes('function withCarbonMonoxide'));
});

test('the Conditions note reads as asked', () => {
  assert.ok(HTML.includes('In the body, CO₂ lowers pH. The sliders are kept separate to observe each effect individually.'));
  assert.doesNotMatch(HTML, /observe each effect on its own|see each effect/);
});

test('pO₂ has its box beside the header and a slider only that wide, with the key to the right', () => {
  const box = HTML.slice(HTML.indexOf('<div id="po2-row">'), HTML.indexOf('id="plot-panel"'));
  const head = box.slice(box.indexOf('<div id="po2-head">'), box.indexOf('id="po2-range"'));
  assert.ok(head.indexOf('for="po2-number"') > 0 && head.indexOf('for="po2-number"') < head.indexOf('id="po2-number"'));
  assert.match(HTML, /#po2-head \{ display: flex;/);
  assert.match(HTML, /#po2-control \{ flex: none; \}/, 'as wide as the header and box');
  assert.match(HTML, /#po2-control input\[type=range\] \{ display: block; width: 100%; \}/);
  assert.ok(box.indexOf('id="po2-control"') < box.indexOf('id="schematic-key"'), 'the key follows, to the right');
  assert.match(HTML, /#plot-row \{[^}]*align-items: start;/, 'each column takes only the height it needs');
  assert.doesNotMatch(HTML, /#schematic-panel \{[^}]*align-self/, 'and the box fills the width of its column');
});

test('the curve legend has line keys on the first row and markings on the second', () => {
  const fn = HTML.slice(HTML.indexOf('function renderLegend'), HTML.indexOf('const fmtPercent'));
  assert.ok(fn.includes("const LINE_ORDER = ['adjustable', 'normal', 'fetal', 'myoglobin'];"));
  const rows = fn.slice(fn.lastIndexOf("$('legend').innerHTML"));
  assert.equal(rows.split('legend-row').length - 1, 2, 'two rows');
  assert.ok(rows.indexOf('entries.map') < rows.indexOf('${dots}${selected}${arrow}'), 'lines first');
});

test('the plot comes right after the title row, with its legend below', () => {
  const panel = HTML.slice(HTML.indexOf('id="plot-panel"'), HTML.indexOf('</main>'));
  const at = text => panel.indexOf(text);
  const headerEnd = panel.indexOf('</div>');
  assert.ok(at('id="plot-title"') < at('id="affinity-box"') && at('id="affinity-box"') < at('id="hide-normal"'), 'the message shares the title row');
  assert.ok(at('id="hide-normal"') < headerEnd && headerEnd < at('id="plot-wrap"'));
  assert.ok(at('<canvas id="plot"') < at('id="legend"') && at('id="legend"') < at('id="plot-hint"'));
  assert.match(HTML.slice(HTML.indexOf('#affinity-box {'), HTML.indexOf('#affinity-box.left')), /flex: 1;\s+min-width: 0;\s+min-height: 36px;/, 'in the title row, at a fixed height, so the plot stays put');
});

test('the schematic stays its size even though its box grew', () => {
  assert.match(HTML, /#schematic-body \{ width: 100%; max-width: 402px;/);
  const body = HTML.slice(HTML.indexOf('<div id="schematic-body">'), HTML.indexOf('id="plot-panel"'));
  for (const id of ['id="schematic"', 'id="model-buttons"', 'id="po2-row"']) assert.ok(body.includes(id), id);
});
