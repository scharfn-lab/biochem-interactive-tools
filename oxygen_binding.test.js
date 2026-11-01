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
const { saturation, adultCurve, fetalCurve, withCarbonMonoxide, delivery, shiftFrom, bpgFactor, curvePoints, affinityText, boundSites, schematicMarkup } = page;
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
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('id="toggles"') < at('id="activity-buttons"'));
  assert.ok(at('id="activity-buttons"') < at('id="sliders"'));
  assert.match(HTML, /#conditions \{ display: flex; flex-direction: column;/);
  assert.ok(at('id="pH-range"') < at('id="pco2-range"') && at('id="pco2-range"') < at('id="bpg-range"'));
});

test('Reset to Normal sits beside the Conditions title', () => {
  assert.match(HTML, /id="controls-title">Conditions<\/h2>\s*<button type="button" id="reset">Reset to Normal<\/button>/);
  assert.doesNotMatch(HTML, /physiological conditions/i);
});

test('O₂ delivery has only Rest and Exercise, with no marker toggle', () => {
  assert.doesNotMatch(HTML, /Lung\/tissue|data-toggle="markers"|show\.markers|Tissue pO₂/);
  assert.match(HTML, /id="activity-label">O₂ delivery:</);
  assert.equal(HTML.match(/data-activity="/g).length, 2);
});

test('the carbon monoxide button is grayed out', () => {
  assert.match(HTML, /data-toggle="co" disabled>Carbon monoxide/);
  assert.match(HTML, /button:disabled \{ background: #E4E4E4; border-color: #BFBFBF; color: #404040;/);
});

test('P₅₀, the pink band and the old results text are gone', () => {
  assert.doesNotMatch(HTML, /drawP50|P₅₀|P<sub>50<\/sub>|COLORS\.band|results-shift|SHIFT_TEXT/);
  const results = HTML.slice(HTML.indexOf('function renderResults'), HTML.indexOf('function updateCanvasLabel'));
  assert.doesNotMatch(results, /Adjustable|p50/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('function updateCanvasLabel'), HTML.indexOf('// ═══ 5.')), /P50|p50/);
});

test('the plot is 20% smaller: 552 px at most, from 690', () => {
  assert.equal(690 * 0.8, 552);
  assert.match(HTML, /#plot-wrap \{ max-width: 552px;/);
});

// ── Curves and delivery points ─────────────────────────────────
test('Normal Hb has a Hide checkbox at the top right of the curve, and no button', () => {
  assert.doesNotMatch(HTML, /data-toggle="normal"|>Normal Hb reference</);
  const header = HTML.slice(HTML.indexOf('id="plot-panel"'), HTML.indexOf('id="affinity-box"'));
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

test('the note says observe, not see', () => {
  assert.ok(HTML.includes('so you can observe each effect on its own.'));
  assert.doesNotMatch(HTML, /see each effect/);
});

// ── Layout ─────────────────────────────────────────────────────
test('Results sits right of Conditions, and the schematic left of the curve', () => {
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('id="controls-row"') < at('id="controls-title"'));
  assert.ok(at('id="controls-title"') < at('id="results-title"'));
  assert.ok(at('id="results-title"') < at('id="plot-row"'));
  assert.ok(at('id="plot-row"') < at('id="schematic-title"'));
  assert.ok(at('id="schematic-title"') < at('id="plot-title"'));
  assert.match(HTML, /#controls-row \{ grid-template-columns: minmax\(0, 588px\) minmax\(0, 1fr\); \}/);
  assert.match(HTML, /#plot-row \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 588px\); \}/);
});

// ── Schematic ──────────────────────────────────────────────────
test('the pO₂ slider sits at the bottom of the schematic and runs 0 to 120 torr', () => {
  const box = HTML.slice(HTML.indexOf('id="schematic-panel"'), HTML.indexOf('id="plot-panel"'));
  assert.ok(box.indexOf('</svg>') < box.indexOf('id="po2-range"'));
  assert.match(box, /id="po2-range" min="0" max="120"/);
  assert.match(HTML, /#schematic \{[^}]*margin-block: auto;/, 'the drawing centers in the space above it');
});

test('the schematic has its name for screen readers and moves gently', () => {
  assert.match(HTML, /\$\('schematic'\)\.setAttribute\('aria-label'/);
  assert.match(HTML, /prefers-reduced-motion: reduce\) \{ \.o2-site \{ transition: none; \} \}/);
  assert.match(HTML, /\{ key: 'po2', decimals: 0, name: 'pO₂' \}/);
});

// ── Results ────────────────────────────────────────────────────
test('the results read % Saturation, with Hill coefficient last and briefly described', () => {
  const results = HTML.slice(HTML.indexOf('function renderResults'), HTML.indexOf('function updateCanvasLabel'));
  const at = text => results.indexOf(text);
  assert.ok(at("'% Saturation (lung)'") > 0 && at("'% Saturation (lung)'") < at("'% Saturation (tissue)'"));
  assert.ok(at("'% Saturation (tissue)'") < at("'% O₂ delivered'") && at("'% O₂ delivered'") < at("'Hill coefficient, n'"));
  assert.doesNotMatch(results, /Y at lung|Y at tissue|Y\(lung\)/);
  assert.match(results, /row\('% O₂ delivered', ''/, 'no descriptor');
  const words = results.match(/'Hill coefficient, n', '([^']+)'/)[1].split(/\s+/).length;
  assert.ok(words >= 5 && words <= 10, `${words} words`);
});

// ── Schematic population ───────────────────────────────────────
const count = (text, pattern) => (text.match(pattern) || []).length;

test('each cell holds 12 molecules: 12 Mb sites and 48 Hb sites', () => {
  const mb = schematicMarkup('mb'), hb = schematicMarkup('hb');
  assert.equal(count(mb, /class="globin/g), 12);
  assert.equal(count(mb, /id="mb-site-/g), 12);
  assert.equal(count(hb, /class="globin/g), 48, 'four subunits in each of 12');
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
