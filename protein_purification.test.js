// Tests for protein_purification.html. No dependencies — run with: node --test
//
// The page's model section touches no DOM, so it runs unmodified in a Node vm.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'protein_purification.html'), 'utf8');
const SECTION = HTML.slice(HTML.indexOf('// ═══ 1.'), HTML.indexOf('// ═══ 2.'));
const page = vm.createContext({});
vm.runInContext(SECTION, page);
const run = code => vm.runInContext(code, page);
const {
  createRng, generateLysate, fullSample, sampleTotal, nativeSize, subunitMW, subunitCount, gelMW, netCharge, chargeColor,
  bindsExchanger, elutionSalt, kav, secVolume, runIEX, runSEC, runAffinity, affinityNote, a280At, sumFractions,
  gelMobility, laneBands, bandIntensity, bandThickness, coElutesIEX, coElutesSEC, isPurifiable, separableFromTarget,
  blobRadius, blobCounts, blobMarkup, blobPosition,
} = run(`({
  createRng, generateLysate, fullSample, sampleTotal, nativeSize, subunitMW, subunitCount, gelMW, netCharge, chargeColor,
  bindsExchanger, elutionSalt, kav, secVolume, runIEX, runSEC, runAffinity, affinityNote, a280At, sumFractions,
  gelMobility, laneBands, bandIntensity, bandThickness, coElutesIEX, coElutesSEC, isPurifiable, separableFromTarget,
  blobRadius, blobCounts, blobMarkup, blobPosition,
})`);
const plain = value => JSON.parse(JSON.stringify(value));
const FRACTIONS = run('FRACTIONS'), SEC_VOID = run('SEC_VOID'), SEC_TOTAL = run('SEC_TOTAL');

function near(actual, expected, tolerance, label = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
}

// A hand-built protein, so these tests don't depend on the random lysate.
let nextId = 100;
const protein = (mw, pI, extra = {}) => ({ id: nextId++, mw, pI, oligomer: 'monomer', amount: 10, isTarget: false, sticky: false, scatter: 0, ...extra });
const sampleOf = proteins => Object.fromEntries(proteins.map(p => [p.id, p.amount]));
const lysates = (n = 60) => Array.from({ length: n }, (_, i) => plain(generateLysate(createRng(i + 1))));
const totalIn = (result, id, indices) => sumFractions(result, indices)[id] || 0;
const all = Array.from({ length: FRACTIONS }, (_, i) => i);
const peakFraction = (result, id) => {
  let best = 0, bestAmount = -1;
  result.fractions.forEach((f, i) => { if ((f[id] || 0) > bestAmount) { bestAmount = f[id] || 0; best = i; } });
  return best;
};

// ── The lysate ─────────────────────────────────────────────────
test('each lysate has 8–10 contaminants and one target, within the stated ranges', () => {
  for (const proteins of lysates()) {
    assert.equal(proteins.filter(p => p.isTarget).length, 1);
    const others = proteins.filter(p => !p.isTarget).length;
    assert.ok(others >= 8 && others <= 10, `${others} contaminants`);
    for (const p of proteins) {
      assert.ok(p.mw >= 10 && p.mw <= 150, `MW ${p.mw}`);
      assert.ok(p.pI >= 4.5 && p.pI <= 9.5, `pI ${p.pI}`);
      assert.ok(['monomer', 'dimer', 'disulfide'].includes(p.oligomer));
      assert.ok(p.amount > 0);
    }
  }
});

test('the target is 5–10% of the total, and the total is 100', () => {
  for (const proteins of lysates()) {
    near(sampleTotal(fullSample(proteins)), 100, 1e-9, 'total');
    const share = proteins.find(p => p.isTarget).amount;
    assert.ok(share >= 5 - 1e-9 && share <= 10 + 1e-9, `target ${share}%`);
  }
});

test('at least one contaminant is a disulfide-linked dimer, and the target is not', () => {
  for (const proteins of lysates()) {
    assert.ok(proteins.some(p => !p.isTarget && p.oligomer === 'disulfide'));
    assert.notEqual(proteins.find(p => p.isTarget).oligomer, 'disulfide');
  }
});

test('the same seed gives the same lysate, and different seeds differ', () => {
  const a = plain(generateLysate(createRng(5))), b = plain(generateLysate(createRng(5))), c = plain(generateLysate(createRng(6)));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('every contaminant can be separated from the target by some non-affinity step', () => {
  for (const proteins of lysates()) {
    const target = proteins.find(p => p.isTarget);
    assert.ok(isPurifiable(proteins));
    for (const c of proteins.filter(p => !p.isTarget)) assert.ok(separableFromTarget(c, target), `MW ${c.mw}, pI ${c.pI}`);
  }
});

test('at least two contaminants run with the target in any single SEC step', () => {
  for (const proteins of lysates()) {
    const target = proteins.find(p => p.isTarget), others = proteins.filter(p => !p.isTarget);
    for (const range of ['small', 'large']) {
      assert.ok(others.filter(c => coElutesSEC(c, target, range)).length >= 2, range);
    }
  }
});

test('at least two contaminants run with the target in any single ion exchange step, at every pH', () => {
  for (const proteins of lysates(30)) {
    const target = proteins.find(p => p.isTarget), others = proteins.filter(p => !p.isTarget);
    for (const exchanger of ['anion', 'cation']) {
      for (let pH = 4; pH <= 10.001; pH += 0.1) {
        const same = others.filter(c => coElutesIEX(c, target, exchanger, pH)).length;
        assert.ok(same >= 2, `${exchanger} pH ${pH.toFixed(1)}: only ${same}`);
      }
    }
  }
});

test('the real runs agree: no single non-affinity step pools the target alone', () => {
  for (const proteins of lysates(30)) {
    const target = proteins.find(p => p.isTarget), sample = fullSample(proteins);
    const purity = result => {
      const f = peakFraction(result, target.id), near3 = [f - 1, f, f + 1].filter(i => i >= 0 && i < FRACTIONS);
      const pool = sumFractions(result, near3);
      return (pool[target.id] || 0) / sampleTotal(pool);
    };
    for (const range of ['small', 'large']) assert.ok(purity(runSEC(proteins, sample, { range })) < 0.9, range);
    for (const exchanger of ['anion', 'cation']) {
      for (const pH of [5, 6, 7, 8, 9]) assert.ok(purity(runIEX(proteins, sample, { exchanger, pH })) < 0.9, `${exchanger} ${pH}`);
    }
  }
});

test('the target band stays clear of every contaminant on a reducing gel, so purity can be judged', () => {
  for (const proteins of lysates()) {
    const target = proteins.find(p => p.isTarget);
    for (const c of proteins.filter(p => !p.isTarget)) {
      assert.ok(Math.max(c.mw, target.mw) / Math.min(c.mw, target.mw) >= 1.12, `${c.mw} vs ${target.mw}`);
    }
  }
});

// ── Charge and color ───────────────────────────────────────────
test('net charge is positive below the pI, zero at it, and negative above it', () => {
  assert.ok(netCharge(7, 5) > 0);
  assert.equal(netCharge(7, 7), 0);
  assert.ok(netCharge(7, 9) < 0);
});

test('color runs from blue when positive, through gray, to red when negative', () => {
  const rgb = charge => chargeColor(charge).match(/\d+/g).map(Number);
  assert.deepEqual(rgb(0), [228, 228, 228]);
  assert.deepEqual(rgb(1), [21, 101, 192]);
  assert.deepEqual(rgb(-1), [200, 16, 46]);
  const [r1, , b1] = rgb(0.5);
  assert.ok(b1 > r1, 'bluish when positive');
  const [r2, , b2] = rgb(-0.5);
  assert.ok(r2 > b2, 'reddish when negative');
});

// ── Ion exchange ───────────────────────────────────────────────
test('an anion exchanger at pH 8 binds pI 5.5 and does not bind pI 9', () => {
  assert.equal(bindsExchanger('anion', 5.5, 8), true);
  assert.equal(bindsExchanger('anion', 9, 8), false);
  const acidic = protein(40, 5.5), basic = protein(40, 9), proteins = [acidic, basic];
  const result = runIEX(proteins, sampleOf(proteins), { exchanger: 'anion', pH: 8 });
  near(totalIn(result, acidic.id, result.phases.elution), 10, 0.01, 'acidic elutes in the gradient');
  near(totalIn(result, acidic.id, result.phases.flowThrough), 0, 0.01, 'acidic is not in the flow-through');
  assert.ok(totalIn(result, basic.id, result.phases.flowThrough) > 8.5, 'basic flows through');
  near(totalIn(result, basic.id, result.phases.elution), 0, 0.01, 'basic is not in the gradient');
});

test('a cation exchanger does the reverse', () => {
  assert.equal(bindsExchanger('cation', 9, 8), true);
  assert.equal(bindsExchanger('cation', 5.5, 8), false);
});

test('a protein at its pI binds neither resin', () => {
  assert.equal(bindsExchanger('anion', 7, 7), false);
  assert.equal(bindsExchanger('cation', 7, 7), false);
});

test('elution [NaCl] rises with distance from the pI, and modestly with size', () => {
  const p = protein(40, 6);
  const salts = [6.3, 6.8, 7.5, 8.5, 9.5].map(pH => elutionSalt(p, pH));
  for (let i = 1; i < salts.length; i++) assert.ok(salts[i] > salts[i - 1], salts.join());
  const small = elutionSalt(protein(20, 6), 8), large = elutionSalt(protein(150, 6), 8);
  assert.ok(large > small);
  assert.ok(large - small < 0.05, 'modestly');
  for (const pH of [4, 6.01, 10]) {
    const salt = elutionSalt(p, pH);
    assert.ok(salt >= 0 && salt <= 1, String(salt));
  }
});

test('nothing is lost or created in an ion exchange run', () => {
  for (const proteins of lysates(10)) {
    const sample = fullSample(proteins);
    const result = runIEX(proteins, sample, { exchanger: 'anion', pH: 7.5 });
    near(sampleTotal(sumFractions(result, all)), 100, 1e-6, 'total');
  }
});

// ── Size exclusion ─────────────────────────────────────────────
test('SEC elutes larger native proteins first', () => {
  const big = protein(60, 7), mid = protein(30, 7), small = protein(15, 7), proteins = [small, big, mid];
  for (const range of ['small', 'large']) {
    const result = runSEC(proteins, sampleOf(proteins), { range });
    const center = id => result.peaks.find(x => x.id === id).center;
    assert.ok(center(big.id) < center(mid.id) && center(mid.id) < center(small.id), range);
  }
});

test('proteins above the range elute in the void, and below it in the total volume', () => {
  assert.equal(kav(100, 'small'), 0);
  assert.equal(secVolume(100, 'small'), SEC_VOID);
  assert.equal(secVolume(5000, 'large'), SEC_VOID);
  assert.equal(kav(1, 'small'), 1);
  assert.equal(secVolume(5, 'large'), SEC_TOTAL);
});

test('Kav is linear in log(MW) inside the range', () => {
  for (const [range, min, max] of [['small', 3, 70], ['large', 10, 600]]) {
    const mid = Math.sqrt(min * max);
    near(kav(mid, range), 0.5, 1e-9, range);
    const a = kav(min * 2, range), b = kav(min * 4, range), c = kav(min * 8, range);
    near(a - b, b - c, 1e-9, `${range} spacing`);
  }
});

test('SEC goes by native size: a dimer runs as twice its subunit', () => {
  const dimer = protein(30, 7, { oligomer: 'dimer' }), bond = protein(30, 7, { oligomer: 'disulfide' }), monomer = protein(30, 7);
  assert.equal(nativeSize(dimer), 60);
  assert.equal(nativeSize(bond), 60);
  assert.equal(nativeSize(monomer), 30);
  assert.ok(secVolume(nativeSize(dimer), 'large') < secVolume(nativeSize(monomer), 'large'));
});

test('SEC has no flow-through or wash, and all protein is in the profile', () => {
  const proteins = plain(generateLysate(createRng(3)));
  const result = runSEC(proteins, fullSample(proteins), { range: 'large' });
  assert.equal(result.phases.flowThrough, undefined);
  assert.equal(result.phases.wash, undefined);
  near(sampleTotal(sumFractions(result, all)), 100, 1e-6, 'total');
  assert.deepEqual(plain(result.volumes), { void: SEC_VOID, total: SEC_TOTAL });
});

// ── Tags ───────────────────────────────────────────────────────
test('tags add their mass to the target only', () => {
  const target = protein(40, 7, { isTarget: true }), other = protein(40, 7);
  assert.equal(subunitMW(target, 'his'), 41);
  assert.equal(subunitMW(target, 'mbp'), 82);
  assert.equal(subunitMW(target, 'gst'), 66);
  assert.equal(subunitMW(other, 'mbp'), 40);
});

test('GST makes the target a native dimer that runs as a monomer on SDS-PAGE', () => {
  const target = protein(40, 7, { isTarget: true });
  assert.equal(subunitCount(target), 1);
  assert.equal(subunitCount(target, 'gst'), 2);
  assert.equal(nativeSize(target, 'gst'), 132);
  assert.equal(gelMW(target, 'gst', true), 66);
  assert.equal(gelMW(target, 'gst', false), 66, 'noncovalent, so a monomer even without reductant');
  assert.equal(nativeSize(target, 'mbp'), 82, 'other tags stay monomers');
});

// ── Affinity ───────────────────────────────────────────────────
function tagged(tagAmount = 7) {
  const target = protein(40, 7, { isTarget: true, amount: tagAmount });
  const sticky = protein(55, 6, { sticky: true, amount: 40 }), plainOne = protein(25, 8, { amount: 53 });
  return { target, sticky, plainOne, proteins: [target, sticky, plainOne], sample: sampleOf([target, sticky, plainOne]) };
}

test('Ni-NTA with imidazole purifies a His₆ target', () => {
  const { target, proteins, sample } = tagged();
  const result = runAffinity(proteins, sample, { resin: 'ni', eluent: 'imidazole' }, 'his');
  near(totalIn(result, target.id, result.phases.elution), 7, 0.01, 'target elutes');
  const eluate = sumFractions(result, result.phases.elution);
  assert.ok(eluate[target.id] / sampleTotal(eluate) > 0.9, 'and is mostly pure');
  assert.equal(result.note, '');
});

test('Ni-NTA with maltose leaves a His₆ target on the column, and says so', () => {
  const { target, proteins, sample } = tagged();
  const result = runAffinity(proteins, sample, { resin: 'ni', eluent: 'maltose' }, 'his');
  near(totalIn(result, target.id, all), 0, 1e-9, 'not in any fraction');
  assert.equal(result.retained[target.id], 7);
  assert.match(result.note, /still on the column/);
});

test('amylose sends a His₆ target to the flow-through, and says so', () => {
  const { target, proteins, sample } = tagged();
  const result = runAffinity(proteins, sample, { resin: 'amylose', eluent: 'maltose' }, 'his');
  assert.ok(totalIn(result, target.id, result.phases.flowThrough) > 6);
  near(totalIn(result, target.id, result.phases.elution), 0, 0.01, 'none elutes');
  assert.match(result.note, /flow-through/);
});

test('each tag works with its own resin and agent, and with no other pairing', () => {
  const pairs = { his: ['ni', 'imidazole'], mbp: ['amylose', 'maltose'], gst: ['glutathione', 'gsh'] };
  const resins = ['ni', 'amylose', 'glutathione'], eluents = ['imidazole', 'maltose', 'gsh'];
  for (const [tag, [goodResin, goodEluent]] of Object.entries(pairs)) {
    for (const resin of resins) {
      for (const eluent of eluents) {
        const { target, proteins, sample } = tagged();
        const result = runAffinity(proteins, sample, { resin, eluent }, tag);
        const inEluate = totalIn(result, target.id, result.phases.elution);
        const works = resin === goodResin && eluent === goodEluent;
        assert.equal(inEluate > 6, works, `${tag} ${resin} ${eluent}`);
        assert.equal(result.note === '', works, `${tag} ${resin} ${eluent}: note`);
      }
    }
  }
});

test('nonspecific binders are a few percent, mostly removed by the wash', () => {
  const { sticky, proteins, sample } = tagged();
  const result = runAffinity(proteins, sample, { resin: 'ni', eluent: 'imidazole' }, 'his');
  const eluted = totalIn(result, sticky.id, result.phases.elution);
  assert.ok(eluted > 0, 'a little reaches the eluate');
  assert.ok(eluted / sticky.amount < 0.02, 'mostly removed by the wash');
  assert.ok(eluted / sticky.amount > 0.002);
});

test('only one or two contaminants in a lysate bind nonspecifically', () => {
  for (const proteins of lysates()) {
    const count = proteins.filter(p => p.sticky).length;
    assert.ok(count >= 1 && count <= 2, String(count));
    assert.equal(proteins.find(p => p.isTarget).sticky, false);
  }
});

test('affinity purifies the target from any real lysate', () => {
  for (const proteins of lysates(30)) {
    const target = proteins.find(p => p.isTarget);
    const result = runAffinity(proteins, fullSample(proteins), { resin: 'ni', eluent: 'imidazole' }, 'his');
    const eluate = sumFractions(result, result.phases.elution);
    assert.ok(eluate[target.id] / sampleTotal(eluate) > 0.85, String(eluate[target.id] / sampleTotal(eluate)));
  }
});

test('protein amounts balance across fractions and the column', () => {
  const { proteins, sample } = tagged();
  const result = runAffinity(proteins, sample, { resin: 'ni', eluent: 'maltose' }, 'his');
  const held = Object.values(result.retained).reduce((a, b) => a + b, 0);
  near(sampleTotal(sumFractions(result, all)) + held, 100, 1e-6, 'balance');
});

test('notes name the mismatch, and no numbers', () => {
  assert.match(affinityNote({ resin: 'amylose', eluent: 'maltose' }, 'his'), /Amylose does not recognize the His₆ tag/);
  assert.match(affinityNote({ resin: 'ni', eluent: 'gsh' }, 'his'), /still on the column/);
});

// ── Chromatogram ───────────────────────────────────────────────
test('there are 30 fractions, and the curve peaks where the protein is', () => {
  const p = protein(40, 5.5), proteins = [p];
  const result = runIEX(proteins, sampleOf(proteins), { exchanger: 'anion', pH: 8 });
  assert.equal(result.fractions.length, 30);
  const center = result.peaks[0].center;
  assert.ok(a280At(result, center) > a280At(result, center - 2));
  assert.ok(a280At(result, center) > a280At(result, center + 2));
  assert.equal(Math.floor(center), peakFraction(result, p.id));
});

test('A280 is the sum of the peaks, with larger amounts giving larger peaks', () => {
  const a = protein(600, 7, { amount: 10 }), b = protein(600, 7, { amount: 30 });
  const one = runSEC([a], sampleOf([a]), { range: 'large' });
  const both = runSEC([a, b], sampleOf([a, b]), { range: 'large' });
  const v = one.peaks[0].center;
  near(a280At(both, v), a280At(one, v) * 4, 1e-9, 'sum');
});

test('the IEX run carries its gradient', () => {
  const p = protein(40, 5.5);
  const result = runIEX([p], sampleOf([p]), { exchanger: 'anion', pH: 8 });
  assert.deepEqual(plain(result.gradient), { start: 10, end: 30 });
  near(result.peaks[0].center, 10 + elutionSalt(p, 8) * 20, 1e-9, 'elutes at its [NaCl]');
});

test('the chromatogram draws one summed trace, not a line per protein', () => {
  const fn = HTML.slice(HTML.indexOf('function drawChromatogram'), HTML.indexOf('function fractionAt'));
  assert.ok(fn.includes('a280At(result, v)'));
  assert.doesNotMatch(fn, /isTarget|peaks\.forEach|for \(const .* of result\.peaks/);
});

// ── SDS-PAGE ───────────────────────────────────────────────────
test('mobility is linear in log(MW) inside a gel\'s range', () => {
  for (const [percent, lo, hi] of [[8, 40, 250], [10, 25, 150], [12, 15, 100], [15, 10, 70]]) {
    const a = gelMobility(hi / 1.2, percent), b = gelMobility(hi / 2, percent), c = gelMobility(hi / 2 / (hi / 1.2 / (hi / 2)), percent);
    near(b - a, c - b, 1e-9, `${percent}% spacing`);
    assert.ok(gelMobility(hi * 0.99, percent) < gelMobility(lo * 1.01, percent), 'larger stays higher');
  }
});

test('larger proteins run slower on every gel, inside and outside the range', () => {
  for (const percent of [8, 10, 12, 15]) {
    const mobilities = [600, 300, 250, 150, 100, 75, 50, 37, 25, 20, 15, 10, 5, 2].map(mw => gelMobility(mw, percent));
    for (let i = 1; i < mobilities.length; i++) assert.ok(mobilities[i] > mobilities[i - 1], `${percent}%: ${mobilities}`);
    for (const rf of mobilities) assert.ok(rf > 0 && rf < 0.97, `stays between the well and the dye front: ${rf}`);
  }
});

test('higher % spreads small proteins and compresses large ones', () => {
  const spread = (percent, a, b) => gelMobility(b, percent) - gelMobility(a, percent);
  assert.ok(spread(15, 20, 15) > spread(8, 20, 15), 'small proteins');
  assert.ok(spread(8, 150, 100) > spread(15, 150, 100), 'large proteins');
});

test('out-of-range proteins bunch at the top or near the dye front', () => {
  const dye = run('DYE_FRONT');
  assert.ok(gelMobility(250, 15) < 0.05 && gelMobility(150, 15) < 0.05, 'large on a 15% gel');
  assert.ok(gelMobility(250, 15) - gelMobility(150, 15) > -0.03);
  assert.ok(gelMobility(10, 8) > 0.92 && gelMobility(10, 8) < dye, 'small on an 8% gel');
  assert.ok(gelMobility(15, 8) > 0.9);
});

test('a disulfide-linked dimer moves between reducing and non-reducing gels', () => {
  const bond = protein(30, 7, { oligomer: 'disulfide' });
  assert.equal(gelMW(bond, null, true), 30);
  assert.equal(gelMW(bond, null, false), 60);
  const proteins = [bond], amounts = { [bond.id]: 10 };
  const reducing = laneBands(amounts, proteins, null, 12, true)[0], nonReducing = laneBands(amounts, proteins, null, 12, false)[0];
  assert.ok(nonReducing.rf < reducing.rf, 'higher up without reductant');
  near(reducing.rf, gelMobility(30, 12), 1e-9, 'at the monomer');
  near(nonReducing.rf, gelMobility(60, 12), 1e-9, 'at the dimer');
});

test('noncovalent dimers run as monomers on both gels', () => {
  const dimer = protein(30, 7, { oligomer: 'dimer' });
  assert.equal(gelMW(dimer, null, true), 30);
  assert.equal(gelMW(dimer, null, false), 30);
});

test('band strength rises with the amount, and traces are too faint to draw', () => {
  for (const [a, b] of [[0.5, 1], [1, 5], [5, 20]]) {
    assert.ok(bandIntensity(b) > bandIntensity(a));
    assert.ok(bandThickness(b) > bandThickness(a));
  }
  const p = protein(30, 7);
  assert.equal(laneBands({ [p.id]: 0.001 }, [p], null, 12, true).length, 0);
  assert.equal(laneBands({ [p.id]: 5 }, [p], null, 12, true).length, 1);
});

test('a band carries no hover text or protein information', () => {
  const p = protein(30, 7);
  assert.deepEqual(Object.keys(laneBands({ [p.id]: 5 }, [p], null, 12, true)[0]).sort(), ['intensity', 'rf', 'thickness']);
  const gel = HTML.slice(HTML.indexOf('function gelMarkup'), HTML.indexOf('function renderGel'));
  const sampleLoop = gel.slice(gel.indexOf('for (const band of laneBands'));
  assert.doesNotMatch(sampleLoop.slice(0, sampleLoop.indexOf('});')), /data-tip/);
  assert.match(gel, /class="ladder-band" data-tip="\$\{mw\} kDa"/);
});

test('the ladder has the requested bands', () => {
  assert.deepEqual([...run('LADDER')], [250, 150, 100, 75, 50, 37, 25, 20, 15, 10]);
});

test('a gel holds 12 lanes, counting the ladder', () => {
  assert.match(HTML, /const MAX_LANES = 12;/);
  assert.match(HTML, /if \(1 \+ state\.gels\[state\.activeGel\]\.lanes\.length >= MAX_LANES\)/);
});

// ── Blobs ──────────────────────────────────────────────────────
test('blob size follows native size', () => {
  assert.ok(blobRadius(300) > blobRadius(100) && blobRadius(100) > blobRadius(20));
  const small = blobRadius(10), large = blobRadius(600);
  assert.ok(large < 12 && small >= 5, `${small} to ${large}`);
});

test('blob counts follow each protein\'s share of the sample', () => {
  assert.deepEqual(plain(blobCounts({ 1: 10, 2: 30 })), { 1: 10, 2: 30 });
  assert.deepEqual(plain(blobCounts({ 1: 90, 2: 10 })), { 1: 36, 2: 4 });
  assert.deepEqual(plain(blobCounts({})), {});
  const pure = blobCounts({ 1: 7, 2: 0.01 });
  assert.equal(pure[1], 40, 'a purified sample is all target');
  assert.equal(pure[2], 0);
});

test('a blob shows only its role, with its properties hidden', () => {
  const target = protein(40, 7, { isTarget: true }), other = protein(40, 7);
  assert.match(blobMarkup(target, 7), /data-tip="Target protein"/);
  assert.match(blobMarkup(other, 7), /data-tip="Contaminant"/);
  for (const markup of [blobMarkup(target, 7), blobMarkup(other, 7)]) assert.doesNotMatch(markup, /kDa|pI\b|\bMW\b/);
});

test('the target has a crimson outline and a star, and contaminants neither', () => {
  const target = protein(40, 7, { isTarget: true }), other = protein(40, 7);
  assert.match(blobMarkup(target, 7), /stroke="#C8102E" stroke-width="2"/);
  assert.ok(blobMarkup(target, 7).includes(run('STAR')));
  assert.doesNotMatch(blobMarkup(other, 7), /#C8102E/);
  assert.ok(!blobMarkup(other, 7).includes(run('STAR')));
});

test('dimers are two touching blobs, with a bridge for disulfide-linked ones', () => {
  const circles = markup => (markup.match(/<circle/g) || []).length;
  assert.equal(circles(blobMarkup(protein(40, 7), 7)), 1);
  const dimer = blobMarkup(protein(40, 7, { oligomer: 'dimer' }), 7), bond = blobMarkup(protein(40, 7, { oligomer: 'disulfide' }), 7);
  assert.equal(circles(dimer), 2);
  assert.equal(circles(bond), 2);
  assert.ok(bond.includes('S–S'));
  assert.ok(!dimer.includes('S–S'));
});

test('blob color follows the buffer pH', () => {
  const p = protein(40, 7);
  assert.notEqual(blobMarkup(p, 5), blobMarkup(p, 9));
  assert.ok(blobMarkup(p, 5).includes(chargeColor(netCharge(7, 5))));
});

test('only the target shows a tag, each with its own shape', () => {
  const target = protein(40, 7, { isTarget: true }), other = protein(40, 7);
  assert.match(blobMarkup(target, 7, 'his'), /<polyline/);
  assert.match(blobMarkup(target, 7, 'mbp'), /<ellipse/);
  assert.match(blobMarkup(target, 7, 'gst'), /<rect/);
  assert.equal((blobMarkup(target, 7, 'gst').match(/<circle/g) || []).length, 2, 'GST: a dimer');
  for (const tag of ['his', 'mbp', 'gst']) assert.doesNotMatch(blobMarkup(other, 7, tag), /polyline|ellipse|<rect/);
});

// ── Animation ──────────────────────────────────────────────────
test('column animation paths: flow through leaves, bound waits, stuck stays', () => {
  assert.equal(blobPosition('through', 0.2) < 1, true);
  assert.equal(blobPosition('through', 0.9), null);
  const held = blobPosition('bound', 0.4);
  assert.ok(held < 0.3, 'held near the top during the wash');
  assert.equal(blobPosition('bound', 1, 0), null, 'gone by the end');
  assert.ok(blobPosition('stay', 1) !== null && blobPosition('stay', 1) < 0.3, 'stuck blobs stay');
  assert.ok(blobPosition('sec', 0.5, 1) < 1 && blobPosition('sec', 0.5, 0) === null, 'larger leaves first');
});

// ── Page wiring ────────────────────────────────────────────────
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const IDS = [...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

test('every id the script looks up exists in the markup', () => {
  for (const m of SCRIPT.matchAll(/\$\('([\w-]+)'\)/g)) assert.ok(IDS.includes(m[1]), m[1]);
});

test('the page is offline and uses the shared palette', () => {
  assert.doesNotMatch(HTML, /<link\b|<script[^>]+src=|<img\b|fetch\(|https?:\/\//);
  for (const color of ['--ut-crimson:  #C8102E', '--ut-taupe:    #685C53', '--ut-lavender: #FFCDFF', '--bg-panel:    #FFF8FF']) {
    assert.ok(HTML.includes(color), color);
  }
  assert.match(HTML, /:focus-visible \{ outline: 3px solid var\(--ut-crimson\);/);
  assert.match(HTML, /prefers-reduced-motion/);
  assert.match(SCRIPT, /if \(reduceMotion\) \{ finish\(\); return; \}/);
});

test('there is no scoring, and no protein numbers are written to the page', () => {
  assert.doesNotMatch(HTML, /\bscore\b|\bgrade\b|\bcorrect\b/i);
  const drawn = SCRIPT.slice(SCRIPT.indexOf('// ═══ 3.'));
  assert.doesNotMatch(drawn, /p\.mw\}|p\.pI\}|\.amount\}/);
});

test('the layout has the requested panels, with history on top', () => {
  const at = marker => HTML.indexOf(marker);
  assert.ok(at('id="breadcrumbs"') < at('id="sample-panel"'));
  assert.ok(at('id="sample-panel"') < at('id="step-panel"') && at('id="step-panel"') < at('id="gel-panel"'));
  for (const id of ['undo', 'start-over', 'new-lysate', 'run-column', 'carry-forward', 'add-fractions', 'new-gel', 'gel-percent', 'skip-animation']) {
    assert.ok(IDS.includes(id), id);
  }
  assert.match(HTML, /@media \(max-width: 760px\) \{\s+#columns \{ grid-template-columns: minmax\(0, 1fr\);/);
});

test('the chromatogram takes a touch drag, and has typed fraction entry as well', () => {
  assert.match(HTML, /#chromatogram \{[^}]*touch-action: pan-y;/);
  assert.ok(IDS.includes('pool-from') && IDS.includes('pool-to') && IDS.includes('pool-apply'));
});

test('ladder labels favor in-range bands, and each band keeps its own hover area', () => {
  const gel = HTML.slice(HTML.indexOf('function gelMarkup'), HTML.indexOf('function renderGel'));
  assert.match(gel, /for \(let i = LADDER\.length - 1; i >= 0; i--\)/, 'labeled from the bottom up');
  assert.match(gel, /Math\.max\(y - 4, i > 0 \? \(ladderYs\[i - 1\] \+ y\) \/ 2/, 'stops halfway to its neighbor above');
  assert.match(gel, /Math\.min\(y \+ 4, i < LADDER\.length - 1 \? \(y \+ ladderYs\[i \+ 1\]\) \/ 2/, 'and below');
});

test('the gel leaves room for long lane labels', () => {
  const longest = '1: Pooled eluate'.length * 5.4 * Math.sin(55 * Math.PI / 180);
  const top = Number(HTML.match(/const GEL = \{ left: \d+, top: (\d+),/)[1]);
  assert.ok(top - 15 >= longest, `${top - 15} px for ${longest} px`);
});

test('tagged blobs stay inside the tube walls', () => {
  const [, start, step] = HTML.match(/x: (\d+) \+ col \* (\d+) \+ between\(rand, -4, 4\) \+ \(row % 2 \? 6 : -4\)/).map(Number);
  const widestRight = 25, widestLeft = 10;       // a dimer with an MBP tag, measured in the browser
  assert.ok(start + 4 * step + 4 + 6 + widestRight <= 182, 'right wall');
  assert.ok(start - 4 - 4 - widestLeft >= 18, 'left wall');
});
