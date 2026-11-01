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
const { saturation, adultCurve, fetalCurve, withCarbonMonoxide, delivery, shiftFrom, bpgFactor, curvePoints, affinityText } = page;
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

test('sliders run pH, pCO₂, then 2,3-BPG, to the right of the buttons', () => {
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('id="toggles"') < at('id="sliders"'));
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

test('P₅₀, the pink band and the Adjustable Hb results text are gone', () => {
  assert.doesNotMatch(HTML, /drawP50|P₅₀|P<sub>50<\/sub>|COLORS\.band|results-shift|SHIFT_TEXT/);
  const results = HTML.slice(HTML.indexOf('function renderResults'), HTML.indexOf('function updateCanvasLabel'));
  assert.doesNotMatch(results, /Adjustable|p50/);
  assert.doesNotMatch(HTML.slice(HTML.indexOf('function updateCanvasLabel'), HTML.indexOf('// ═══ 5.')), /P50|p50/);
});

test('the plot is 20% smaller: 552 px at most, from 690', () => {
  assert.equal(690 * 0.8, 552);
  assert.match(HTML, /#plot-wrap \{ max-width: 552px;/);
});
