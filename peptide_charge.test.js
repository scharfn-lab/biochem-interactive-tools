// Tests for peptide_charge.html. No dependencies — run with: node --test
//
// The page's inline script runs unmodified in a Node vm against a small DOM stub
// built from the page's own markup. Top-level const/let are reachable through page.run().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'peptide_charge.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const MARKUP = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script>')).replace(/<!--[\s\S]*?-->/g, '');
const CSS = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];

function makeContext2D() {
  const calls = [];
  return new Proxy({ calls }, {
    get: (t, k) => (k in t ? t[k] : (...args) => { calls.push({ fn: k, args }); }),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

function makeElement(tag, attrs = {}) {
  const listeners = {};
  const dataset = {};
  const style = {};
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5)] = v;
  for (const rule of (attrs.style ?? '').split(';')) {
    const [k, v] = rule.split(':').map(s => s.trim());
    if (k) style[k] = v;
  }
  const attributes = { ...attrs };
  const classes = el => el.className.split(/\s+/).filter(Boolean);
  const context = makeContext2D();
  const el = {
    tag, id: attrs.id, className: attrs.class ?? '', value: attrs.value ?? '', textContent: '', innerHTML: '',
    hidden: 'hidden' in attrs, dataset, style, clientWidth: 0, clientHeight: 0,
    classList: {
      add: c => { if (!classes(el).includes(c)) el.className = [...classes(el), c].join(' '); },
      remove: c => { el.className = classes(el).filter(x => x !== c).join(' '); },
      toggle: (c, on) => { if (on) el.classList.add(c); else el.classList.remove(c); },
      contains: c => classes(el).includes(c),
    },
    setAttribute(k, v) { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute(k) { delete attributes[k]; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, props = {}) {
      const e = { target: el, preventDefault() {}, ...props };
      for (const fn of listeners[type] || []) fn(e);
    },
    getContext: () => context,
    context,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    focus() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  return el;
}

function loadPage() {
  const roots = [...MARKUP.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)].map(m => {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(a => [a[1], a[2] ?? '']));
    return makeElement(m[1], attrs);
  });
  const document = makeElement('document');
  document.getElementById = id => roots.find(el => el.id === id) ?? null;
  document.querySelectorAll = selector => roots.filter(el => el.classList.contains(selector.slice(1)));
  const structure = makeElement('svg', { id: 'structure' });
  const realGet = document.getElementById;
  document.getElementById = id => (id === 'structure' ? structure : realGet(id));
  const window = makeElement('window');
  window.devicePixelRatio = 1;
  const context = vm.createContext({ document, window });
  vm.runInContext(SCRIPT, context);
  return {
    el: id => document.getElementById(id),
    qa: selector => document.querySelectorAll(selector),
    document, structure,
    run: code => vm.runInContext(code, context),
    json: code => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, context)),
  };
}

const page0 = loadPage();
const net = (seq, ph) => page0.run(`netCharge(ionizableGroups('${seq}'), ${ph})`);
const pI = seq => page0.run(`findPI(ionizableGroups('${seq}'))`);
const close = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: expected ${expected} ± ${tol}, got ${actual}`);
const ALL = 'GAVLIPFWMSTCYNQDEKRH'.split('');
const enterSeq = (page, text) => {
  page.el('seq-input').value = text;
  page.el('seq-input').fire('input');
};

// ── The test cases you specified ───────────────────────────────
test('Gly at pH 7 has net charge about 0 and pI about 5.55', () => {
  close(net('G', 7), 0, 0.15, 'net charge');
  close(pI('G'), 5.55, 0.005, 'pI');
});

test('Lys alone has pI about 9.4', () => close(pI('K'), 9.4, 0.005, 'pI'));
test('Asp alone has pI about 3.6', () => close(pI('D'), 3.6, 0.005, 'pI'));

// ── pKa table ──────────────────────────────────────────────────
test('the pKa table holds the Berg, Tymoczko & Stryer values', () => {
  assert.deepEqual(page0.json('PKA'), { alphaCOOH: 3.1, alphaNH3: 8, Asp: 4.1, Glu: 4.1, His: 6, Cys: 8.3, Tyr: 10.9, Lys: 10.8, Arg: 12.5 });
  assert.match(SCRIPT, /Berg, Tymoczko & Stryer/);
});

test('pKa numbers live only in the one table', () => {
  const afterTable = SCRIPT.slice(SCRIPT.indexOf('// ─── Residues'));
  for (const value of ['3.1', '4.1', '6.0', '8.3', '10.9', '10.8', '12.5']) {
    assert.ok(!afterTable.includes(`pKa: ${value}`), value);
  }
});

// ── Charge chemistry ───────────────────────────────────────────
test('each group follows the charge equations', () => {
  const groups = page0.json(`ionizableGroups('K')`);
  const charge = (g, ph) => page0.run(`groupCharge(${JSON.stringify(g)}, ${ph})`);
  const [nterm, side, cterm] = groups;
  close(charge(nterm, 8), 0.5, 1e-9, 'base at its pKa');
  close(charge(side, 10.8), 0.5, 1e-9, 'Lys at its pKa');
  close(charge(cterm, 3.1), -0.5, 1e-9, 'acid at its pKa');
  close(charge(nterm, 9), 1 / 11, 1e-9, 'base one unit above');
  close(charge(cterm, 2.1), -1 / 11, 1e-9, 'acid one unit below');
});

test('only the termini and side chains ionize', () => {
  const ids = seq => page0.json(`ionizableGroups('${seq}').map(g => g.id)`);
  assert.deepEqual(ids('GAG'), ['nterm', 'cterm'], 'internal backbone groups are amides');
  assert.deepEqual(ids('ADEHKR'), ['nterm', 'side1', 'side2', 'side3', 'side4', 'side5', 'cterm']);
  assert.deepEqual(ids('CY'), ['nterm', 'side0', 'side1', 'cterm']);
  for (const code of 'GAVLIPFWMSTNQ') assert.equal(ids(code).length, 2, code);
});

test('net charge at pH 2, 7 and 13 for a peptide with each ionizable type', () => {
  // Hand-calculated group by group with the table's pKa values: D H C Y K R
  close(net('DHCYKR', 2), 3.92, 0.005, 'pH 2: N-term, His, Lys and Arg are positive');
  close(net('DHCYKR', 7), 0.95, 0.005, 'pH 7');
  close(net('DHCYKR', 13), -3.75, 0.005, 'pH 13: Asp, Cys, Tyr and C-term are negative, and Arg is still 24% protonated');
});

test('the pI always brackets to a zero of net charge, for any residue pair', () => {
  for (const a of ALL) {
    for (const b of ALL) {
      const p = pI(a + b);
      close(net(a + b, p), 0, 1e-6, `${a}${b}`);
      assert.ok(p > 0 && p < 14, `${a}${b}`);
    }
  }
  close(net('RRRRRR', pI('RRRRRR')), 0, 1e-6, 'all Arg');
  close(net('DDDDDD', pI('DDDDDD')), 0, 1e-6, 'all Asp');
  assert.ok(net('RRRRRR', 14) < 0, 'the bracket holds at the top');
  assert.ok(net('DDDDDD', 0) > 0, 'the bracket holds at the bottom');
});

test('net charge only falls as pH rises', () => {
  for (const seq of ['ADEHKR', 'CYKR', 'G', 'DDDDDD', 'RRRRRR']) {
    let previous = Infinity;
    for (let p = 0; p <= 14; p += 0.25) {
      const q = net(seq, p);
      assert.ok(q < previous, `${seq} at ${p}`);
      previous = q;
    }
  }
});

// ── Most prevalent form ────────────────────────────────────────
test('groups are drawn protonated below the pKa and deprotonated above', () => {
  const form = (ph, kind = 'acid', pKa = 4.1) => page0.json(`drawnForm({ kind: '${kind}', pKa: ${pKa} }, ${ph})`);
  assert.deepEqual(form(3), { form: 'prot', half: false });
  assert.deepEqual(form(5), { form: 'deprot', half: false });
  assert.equal(form(4.1).half, true);
  assert.equal(form(4.05).half, true, 'edge of the window');
  assert.equal(form(4.15).half, true, 'edge of the window');
  assert.equal(form(4.2).half, false);
  assert.equal(form(4).half, false);
});

test('the neutral form is uncharged for every group', () => {
  const groups = page0.json(`ionizableGroups('CYDEKRH')`);
  for (const g of groups) {
    const form = page0.run(`neutralForm(${JSON.stringify(g)})`);
    assert.equal(form, g.kind === 'base' ? 'deprot' : 'prot', g.short);
    assert.doesNotMatch(g[form], /[⁺⁻]/, g.short);
  }
});

// ── Parsing ────────────────────────────────────────────────────
const parse = text => page0.json(`parsePeptide(${JSON.stringify(text)})`);

test('one-letter and three-letter input both parse, in any case', () => {
  for (const [text, seq] of [
    ['AKDH', 'AKDH'], ['akdh', 'AKDH'], ['Ala-Lys-Asp-His', 'AKDH'], ['ala lys asp his', 'AKDH'],
    ['ALA–LYS', 'AK'], ['A-K-D', 'AKD'], ['  Gly  ', 'G'], ['G', 'G'], ['Ala-K', 'AK'],
  ]) {
    assert.equal(parse(text).seq, seq, text);
  }
});

test('all 20 amino acids parse in both formats', () => {
  const residues = page0.json('RESIDUES');
  assert.equal(Object.keys(residues).length, 20);
  for (const [one, three] of Object.entries(residues)) {
    assert.equal(parse(one).seq, one);
    assert.equal(parse(three).seq, one);
    assert.equal(parse(`${three}-Gly`).seq, `${one}G`);
  }
});

test('a lone three-letter code reads as one residue, with a note when it could be three', () => {
  const r = parse('Lys');
  assert.equal(r.seq, 'K');
  assert.match(r.note, /single residue Lys.*L-Y-S/);
  assert.equal(parse('L-Y-S').seq, 'LYS');
  assert.equal(parse('Glu').note, '', 'U is not a residue, so Glu is not ambiguous');
});

test('unknown residues and long peptides get clear messages', () => {
  assert.match(parse('AXK').error, /Unknown residue: "X"/);
  assert.match(parse('Ala-Foo').error, /Unknown residue: "Foo"/);
  assert.match(parse('Ala-Foo-Bar').error, /Unknown residues: "Foo", "Bar"/);
  for (const letter of 'BJOUXZ') assert.match(parse(letter).error, /Unknown/, letter);
  assert.match(parse('AAAAAAA').error, /7 residues.*at most 6/);
  assert.match(parse('Ala-Ala-Ala-Ala-Ala-Ala-Ala').error, /at most 6/);
  assert.equal(parse('AAAAAA').seq, 'AAAAAA');
  assert.match(parse('   ').error, /Enter 1 to 6/);
});

// ── Structure drawing ──────────────────────────────────────────
const svgOf = seq => page0.run(`buildStructure('${seq}').svg`);
const ionCount = svg => [...svg.matchAll(/class="ion-group"/g)].length;

test('every amino acid draws in every position without a broken bond', () => {
  for (const a of ALL) {
    for (const seq of [a, `${a}G`, `G${a}G`, `GG${a}`]) {
      const svg = svgOf(seq);
      assert.doesNotMatch(svg, /NaN|undefined/, seq);
      assert.equal(ionCount(svg), page0.run(`ionizableGroups('${seq}').length`), seq);
    }
  }
});

test('side chain templates exist for all 20 and Gly has none', () => {
  const templates = page0.json('Object.keys(SIDE_TEMPLATES)').sort();
  assert.deepEqual(templates, [...ALL].sort());
  assert.deepEqual(page0.json('SIDE_TEMPLATES.G.bonds'), []);
});

test('every ionizable residue has drawn templates for both forms', () => {
  const ionizable = page0.json('Object.keys(SIDE_IONIZABLE)').sort();
  const withIon = ALL.filter(c => page0.run(`Boolean(SIDE_TEMPLATES.${c}.ion)`)).sort();
  assert.deepEqual(withIon, ionizable);
});

test('the drawn forms show explicit hydrogens and charges', () => {
  const cases = { D: ['OH', 'O⁻'], E: ['OH', 'O⁻'], C: ['SH', 'S⁻'], Y: ['OH', 'O⁻'], K: ['NH₃⁺', 'NH₂'], R: ['NH₂⁺', 'NH'], H: ['NH⁺', 'NH'] };
  for (const [code, [prot, deprot]] of Object.entries(cases)) {
    const svg = svgOf(code);
    const group = svg.match(new RegExp('data-group="side0">([\\s\\S]*?)<text class="half-label"'))[1];
    const [protPart, deprotPart] = group.split('ion-state deprot');
    assert.ok(protPart.includes(`>${prot}<`), `${code} protonated`);
    assert.ok(deprotPart.includes(`>${deprot}<`), `${code} deprotonated`);
  }
});

test('imidazole keeps its aromatic double bonds in both forms, with the right N-H count', () => {
  const group = svgOf('H').match(/data-group="side0">([\s\S]*?)<text class="half-label"/)[1];
  const [protPart, deprotPart] = group.split('ion-state deprot');
  assert.ok(protPart.includes('>HN<') && protPart.includes('>NH⁺<'), 'imidazolium has two N-H');
  assert.ok(deprotPart.includes('>N<') && deprotPart.includes('>NH<'), 'imidazole has one N-H');
});

test('termini show both forms, and N-terminal proline has a secondary amine', () => {
  const svg = svgOf('A');
  for (const label of ['H₃N⁺', 'H₂N', '>O⁻<', '>OH<']) assert.ok(svg.includes(label), label);
  const pro = svgOf('P');
  assert.ok(pro.includes('H₂N⁺'));
  assert.ok(pro.includes('>HN<'));
  assert.ok(!pro.includes('H₃N⁺'));
});

test('internal proline has no N-H, and other internal residues do', () => {
  const hs = seq => [...svgOf(seq).matchAll(/>H</g)].length;
  assert.equal(hs('GGG'), 2);
  assert.equal(hs('GPG'), 1);
  assert.equal(hs('PPP'), 0);
});

test('nothing in the drawing marks where one residue ends and the next begins', () => {
  for (const seq of ['ADEHKR', 'GAVLIP', 'WWWWWW', 'G']) {
    const svg = svgOf(seq);
    assert.doesNotMatch(svg, /peptide bond|peptide-glow|class="leader"|class="res-name"|class="bond-name"/, seq);
    assert.doesNotMatch(svg, /<rect/, `${seq}: no shaded bands or group circles`);
    assert.doesNotMatch(svg, /stroke-dasharray/, seq);
    for (const three of Object.values(page0.json('RESIDUES'))) assert.ok(!svg.includes(`>${three}`), `${seq} names ${three}`);
  }
  assert.doesNotMatch(CSS, /ion-box|peptide-glow|\.leader|\.res-name|\.bond-name|\.swatch/, 'no leftover styles');
});

test('the structure is 20% smaller and still fits beside the pI box', () => {
  assert.match(SCRIPT, /Math\.round\(width \* 1\.04\)/, '1.3 × 0.8');
  for (const seq of ['ADEHKR', 'WWWWWW', 'RRRRRR', 'YWRYWR']) {
    assert.ok(page0.run(`buildStructure('${seq}').width`) * 1.04 <= 723, `${seq} fits the structure panel`);
  }
  assert.match(CSS, /#structure-box svg \{[^}]*max-width: 100%;[^}]*height: auto;/);
  assert.match(CSS, /#structure-box \{[^}]*overflow: hidden/, 'no scrolling');
});

test('charges are still colored as text, and the half state keeps its label', () => {
  assert.match(CSS, /\.charge-pos \.atom \{ fill: var\(--positive\)/);
  assert.match(CSS, /\.charge-neg \.atom \{ fill: var\(--ut-crimson\)/);
  assert.match(CSS, /\.ion-state \{ opacity: 0; transition: opacity/, 'smooth updates');
  const lys = svgOf('K').match(/data-group="side0">([\s\S]*?)<text class="half-label"/)[1];
  assert.match(lys, /ion-state prot charge-pos/);
  assert.match(lys, /ion-state deprot charge-neu/);
  const asp = svgOf('D').match(/data-group="side0">([\s\S]*?)<text class="half-label"/)[1];
  assert.match(asp, /ion-state prot charge-neu/);
  assert.match(asp, /ion-state deprot charge-neg/);
  assert.ok(svgOf('K').includes('≈50/50'));
});

// ── Page wiring ────────────────────────────────────────────────
test('every id the script looks up exists, and the file works offline', () => {
  const used = [...SCRIPT.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]).filter(id => id !== 'structure');
  assert.ok(used.length > 10);
  for (const id of used) assert.match(MARKUP, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(HTML, /<script src|<link |https?:\/\/(?!www\.w3\.org)/, 'no external resources');
});

test('the style matches the Ramachandran page', () => {
  for (const color of ['--ut-crimson:  #C8102E', '--ut-taupe:    #685C53', '--ut-lavender: #FFCDFF', '--bg-panel:    #FFF8FF']) {
    assert.ok(CSS.includes(color), color);
  }
  assert.match(CSS, /'Segoe UI'/);
  assert.match(CSS, /button\.active \{ background: #FFCDD2; border-color: var\(--ut-crimson\)/);
});

test('removed parts are gone', () => {
  assert.doesNotMatch(HTML, /<canvas|id="plot|drawPlot|hoverPH/, 'no plot');
  assert.doesNotMatch(HTML, /notation|terminusText/, 'no notation lines');
  assert.doesNotMatch(HTML, /seq-preset|data-seq/, 'no example peptides');
  assert.doesNotMatch(HTML, /results-panel|net-charge|pi-value/, 'no results box');
});

test('the layout puts peptide beside pH, structure beside pI, and Quiz Mode on top', () => {
  assert.match(CSS, /\.half-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/);
  assert.match(CSS, /\.structure-row \{[^}]*grid-template-columns: minmax\(0, 2\.6fr\) minmax\(0, 1fr\)/);
  const order = ['id="quiz-toggle"', 'id="seq-input"', 'id="ph-slider"', 'id="structure-box"', 'id="pka-rows"'];
  const positions = order.map(id => MARKUP.indexOf(id));
  assert.ok(positions.every(p => p >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), order.join(' < '));
  const row = MARKUP.match(/id="seq-input"[\s\S]*?id="random-btn">([^<]+)</);
  assert.equal(row[1], 'Randomly Generate');
});

test('the input updates the peptide and keeps the last good one on an error', () => {
  const page = loadPage();
  const input = page.el('seq-input');
  enterSeq(page, 'Ala-Lys');
  assert.equal(page.run('sequence'), 'AK');

  enterSeq(page, 'AXK');
  assert.equal(page.run('sequence'), 'AK', 'kept');
  assert.equal(page.el('seq-message').className, 'error');
  assert.match(page.el('seq-message').textContent, /Unknown residue: "X"/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');

  enterSeq(page, 'AK');
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(page.el('seq-message').textContent, '');
});

test('the page opens on a random peptide with the entry box empty', () => {
  const page = loadPage();
  const seq = page.run('sequence');
  assert.ok(seq.length >= 2 && seq.length <= 6, seq);
  assert.equal(page.el('seq-input').value, '');
  assert.equal(page.el('seq-message').textContent, '');
  assert.ok(page.el('structure-box').innerHTML.includes('<svg'));
});

test('Randomly Generate draws a new peptide without showing its sequence', () => {
  const page = loadPage();
  enterSeq(page, 'AXK');
  for (let i = 0; i < 300; i++) {
    const before = page.run('sequence');
    page.el('random-btn').fire('click');
    const after = page.run('sequence');
    assert.notEqual(after, before);
    assert.ok(after.length >= 2 && after.length <= 6, after);
    assert.equal(page.el('seq-input').value, '', 'the box stays empty');
    assert.equal(page.el('seq-input').getAttribute('aria-invalid'), null);
    assert.ok(!page.el('seq-message').textContent.includes(after));
    assert.match(page.el('structure').getAttribute('aria-label'), /^Skeletal structure of the peptide at pH/);
  }
  assert.match(page.el('seq-message').textContent, /Work out its residues/);
});

test('the drawing description never names the sequence', () => {
  const page = loadPage();
  enterSeq(page, 'Ala-Lys');
  const label = page.structure.getAttribute('aria-label');
  assert.doesNotMatch(label, /Ala/);
  assert.match(label, /N-term: NH₃⁺; C-term: COO⁻; Lys R group: NH₃⁺/);
});

test('pH presets set the slider, and moving the slider deselects them', () => {
  const page = loadPage();
  const active = () => page.qa('.ph-preset').filter(b => b.classList.contains('active')).map(b => b.dataset.ph);
  assert.deepEqual(page.qa('.ph-preset').map(b => b.dataset.ph), ['2', '7', '13']);
  assert.deepEqual(active(), ['7']);
  page.qa('.ph-preset')[2].fire('click');
  assert.equal(page.run('pH'), 13);
  assert.equal(page.el('ph-slider').value, 13);
  assert.equal(page.el('ph-input').value, 13);
  assert.deepEqual(active(), ['13']);

  page.el('ph-slider').fire('input', { target: { value: '7' } });
  assert.equal(page.run('pH'), 7);
  assert.deepEqual(active(), [], 'even when it lands on a preset value');

  page.el('ph-input').fire('input', { target: { value: '99' } });
  assert.equal(page.run('pH'), 14, 'clamped');
  page.el('ph-input').fire('input', { target: { value: '' } });
  assert.equal(page.run('pH'), 14, 'blank is ignored while typing');
  page.el('ph-input').fire('input', { target: { value: 'abc' } });
  assert.equal(page.run('pH'), 14);
});

// ── Determining pI ─────────────────────────────────────────────
const pkaTable = page => [...page.el('pka-rows').innerHTML.matchAll(/<tr><td>([^<]+)<\/td><td class="num">([^<]+)<\/td><\/tr>/g)].map(m => [m[1], m[2]]);

const FULL_PKA_TABLE = [
  ['N-term', '8.0'], ['C-term', '3.1'], ['Arg R group', '12.5'], ['Asp R group', '4.1'], ['Cys R group', '8.3'],
  ['Glu R group', '4.1'], ['His R group', '6.0'], ['Lys R group', '10.8'], ['Tyr R group', '10.9'],
];

test('the box lists the termini and every ionizable side chain alphabetically', () => {
  const page = loadPage();
  enterSeq(page, 'ADEHKR');
  assert.deepEqual(pkaTable(page), FULL_PKA_TABLE);
  assert.match(MARKUP, /<th scope="col">Ionizable group<\/th><th scope="col" class="num">pKa<\/th>/);
  const sideChains = pkaTable(page).slice(2).map(r => r[0]);
  assert.deepEqual(sideChains, [...sideChains].sort(), 'alphabetical');
});

test('the table does not change with the peptide, so it cannot give away the residues', () => {
  const page = loadPage();
  for (const seq of ['GAG', 'KK', 'CY', 'KD', 'DK', 'R']) {
    enterSeq(page, seq);
    assert.deepEqual(pkaTable(page), FULL_PKA_TABLE, seq);
  }
});

test('the pKa values always show, in Quiz Mode and after Reveal too', () => {
  const page = loadPage();
  enterSeq(page, 'GA');
  page.el('quiz-toggle').fire('click');
  assert.deepEqual(pkaTable(page), FULL_PKA_TABLE, 'in the quiz');
  page.el('quiz-reveal').fire('click');
  assert.deepEqual(pkaTable(page), FULL_PKA_TABLE, 'after Reveal');
  assert.doesNotMatch(MARKUP, /pka-table-wrap"[^>]*hidden/);
  assert.doesNotMatch(SCRIPT, /pka-table-wrap/);
  assert.doesNotMatch(MARKUP, /pKa values are hidden/);
});

test('the pI entry sits above the ionizable groups', () => {
  const box = MARKUP.match(/id="pi-title"[\s\S]*?<\/section>/)[0];
  const at = marker => box.indexOf(marker);
  assert.ok(at('id="pi-input"') >= 0 && at('id="pi-input"') < at('id="pi-check"'));
  assert.ok(at('id="pi-check"') < at('id="pi-result"') && at('id="pi-result"') < at('id="pka-rows"'));
});

test('right and wrong answers use the shared colors from CLAUDE.md', () => {
  assert.match(CSS, /\.quiz-result\.right \{ background: #DBEAFE; border-color: #1565C0; \}/);
  assert.match(CSS, /\.quiz-result\.wrong \{ background: #FFEBEE; border-color: #C8102E; \}/);
  const guide = fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8');
  assert.match(guide, /Correct \| `#DBEAFE` \| `#1565C0`/);
  assert.match(guide, /Incorrect \| `#FFEBEE` \| `#C8102E`/);
});

test('the pH slider is the width of the entry box and directly below it', () => {
  const entry = MARKUP.match(/<div id="ph-entry">([\s\S]*?)<\/div>/)[1];
  assert.ok(entry.indexOf('id="ph-input"') >= 0 && entry.indexOf('id="ph-input"') < entry.indexOf('id="ph-slider"'));
  assert.equal([...entry.matchAll(/<input/g)].length, 2, 'nothing else between them');
  assert.match(CSS, /#ph-entry \{[^}]*flex-direction: column;[^}]*width: 84px;/);
  assert.match(CSS, /#ph-input \{ width: 100%; \}/);
  assert.match(CSS, /input\[type=range\] \{\s*width: 100%;/);
});

test('the pI stays hidden until it is checked, and Check pI sits beside a blank box', () => {
  const page = loadPage();
  enterSeq(page, 'K');
  assert.equal(page.el('pi-input').value, '');
  assert.equal(page.el('pi-result').textContent, '');
  assert.doesNotMatch(page.el('pka-rows').innerHTML, /9\.40/);
  const box = MARKUP.match(/id="pi-title"[\s\S]*?<\/section>/)[0];
  assert.ok(box.includes('Determining pI'));
  assert.ok(box.indexOf('id="pi-input"') < box.indexOf('>Check pI<'));
});

const checkPIWith = (page, value) => {
  page.el('pi-input').value = value;
  page.el('pi-check').fire('click');
  return page.el('pi-result');
};

test('a right pI within ±0.1 shows the actual pI', () => {
  const page = loadPage();
  enterSeq(page, 'G');  // pI 5.55
  for (const value of ['5.55', '5.65', '5.45']) {
    const result = checkPIWith(page, value);
    assert.equal(result.className, 'quiz-result right', value);
    assert.equal(result.textContent, '✓ pI: correct. The actual pI is 5.55.', value);
  }
});

test('an empty Check pI still shows the pI, without calling it wrong', () => {
  const page = loadPage();
  enterSeq(page, 'K');
  const result = checkPIWith(page, '');
  assert.equal(result.textContent, 'The pI is 9.40.');
  assert.equal(result.className, 'quiz-result info');
  enterSeq(page, 'G');
  assert.equal(checkPIWith(page, '   ').textContent, 'The pI is 5.55.');
  assert.equal(checkPIWith(page, 'abc').textContent, 'The pI is 5.55.', 'text that is not a number works the same way');
});

test('a first wrong guess gets the pH range and keeps the pI back; the next one gets the pI', () => {
  const page = loadPage();
  enterSeq(page, 'G');
  const first = checkPIWith(page, '7');
  assert.equal(first.className, 'quiz-result wrong');
  assert.equal(first.textContent, '✗ pI: not within ±0.1. Evaluate the structure between pH 3.1 and pH 8.0, then try again.');
  assert.doesNotMatch(first.textContent, /5\.55/);
  const second = checkPIWith(page, '7');
  assert.equal(second.className, 'quiz-result wrong');
  assert.equal(second.textContent, '✗ pI: the actual pI is 5.55.');
});

test('a right answer after the hint still gets credit, and empty after the hint shows the pI', () => {
  const page = loadPage();
  enterSeq(page, 'K');
  checkPIWith(page, '7');
  assert.match(checkPIWith(page, '9.4').textContent, /^✓ pI: correct\. The actual pI is 9\.40\./);
  enterSeq(page, 'K');
  enterSeq(page, 'G');
  checkPIWith(page, '7');
  assert.equal(checkPIWith(page, '').textContent, 'The pI is 5.55.');
});

test('the wrong-guess count starts over with each new peptide', () => {
  const page = loadPage();
  enterSeq(page, 'G');
  checkPIWith(page, '7');
  enterSeq(page, 'K');
  assert.match(checkPIWith(page, '1').textContent, /Evaluate the structure between pH 8\.0 and pH 10\.8/);
  page.el('random-btn').fire('click');
  assert.match(checkPIWith(page, '-5').textContent, /Evaluate the structure/);
});

test('the range uses the two pKa values on either side of the neutral form', () => {
  // Hand-worked: deprotonating in pKa order, net charge reaches 0 between these two steps
  const cases = [
    ['G', [3.1, 8]], ['K', [8, 10.8]], ['D', [3.1, 4.1]], ['R', [8, 12.5]], ['H', [6, 8]], ['C', [3.1, 8]],
    ['DEK', [4.1, 4.1]], ['KK', [10.8, 10.8]], ['HHH', [6, 8]], ['ADEHKR', [6, 8]], ['DHCYKR', [8, 8.3]], ['CYKR', [8.3, 10.8]],
  ];
  for (const [seq, range] of cases) {
    assert.deepEqual(page0.json(`relevantPKas(ionizableGroups('${seq}'))`), range, seq);
  }
  // The two-group and three-group textbook cases land on the average of that range
  for (const [seq, pi] of [['G', 5.55], ['K', 9.4], ['D', 3.6]]) {
    const [low, high] = page0.json(`relevantPKas(ionizableGroups('${seq}'))`);
    close((low + high) / 2, pi, 0.005, seq);
  }
});

test('two equal relevant pKa values read as "near" that pH', () => {
  const page = loadPage();
  enterSeq(page, 'KK');
  assert.match(checkPIWith(page, '2').textContent, /Evaluate the structure near pH 10\.8, then try again\./);
});

test('pressing Enter in the pI box checks it', () => {
  const page = loadPage();
  enterSeq(page, 'G');
  page.el('pi-input').value = '5.55';
  page.el('pi-input').fire('keydown', { key: 'Enter' });
  assert.equal(page.el('pi-result').className, 'quiz-result right');
});

test('a new sequence clears the pI answer, but a pH change does not', () => {
  const page = loadPage();
  enterSeq(page, 'G');
  page.el('pi-input').value = '5.55';
  page.el('pi-check').fire('click');
  page.run('setPH(3)');
  assert.equal(page.el('pi-input').value, '5.55', 'the pI does not depend on pH');
  assert.notEqual(page.el('pi-result').textContent, '');
  enterSeq(page, 'A');
  assert.equal(page.el('pi-input').value, '');
  assert.equal(page.el('pi-result').textContent, '');
  page.el('pi-input').value = '5';
  page.el('random-btn').fire('click');
  assert.equal(page.el('pi-input').value, '');
});

test('tiny charges never read as −0.00', () => {
  assert.equal(page0.run('formatSigned(-0.001)'), '0.00');
  assert.equal(page0.run('formatSigned(0.001)'), '0.00');
  assert.equal(page0.run('formatSigned(-1.5)'), '−1.50');
  assert.equal(page0.run('formatSigned(1.5)'), '+1.50');
});

// ── Quiz ───────────────────────────────────────────────────────
// Starts the quiz, then fixes the peptide, pH and sequence format for the test
const quizPage = (seq = 'G', format = 'one', ph = 7) => {
  const page = loadPage();
  page.el('quiz-toggle').fire('click');
  setQuestion(page, seq, format, ph);
  return page;
};
const setQuestion = (page, seq, format = 'one', ph = 7) => {
  page.run(`quizFormat = '${format}'; pH = ${ph}; setSequence('${seq}'); clearAnswers(); refresh();`);
};
const answerField = (page, input, button, value) => {
  page.el(input).value = value;
  page.el(button).fire('click');
};
const answerSeq = (page, value) => answerField(page, 'quiz-seq', 'quiz-seq-check', value);
const answerCharge = (page, value) => answerField(page, 'quiz-charge', 'quiz-check', value);
const answerPI = (page, value) => answerField(page, 'quiz-pi', 'quiz-pi-check', value);
const breakdownRows = page => [...page.el('score-breakdown').innerHTML.matchAll(/<tr><th scope="row">([^<]+)<\/th><td class="num">(\d+)<\/td><td class="num">(\d+)<\/td><\/tr>/g)]
  .map(m => [m[1], +m[2], +m[3]]);
const counts = (page, label) => breakdownRows(page).find(r => r[0] === label).slice(1);

test('Quiz Mode hides the peptide and pH boxes and puts the quiz above the structure', () => {
  const page = loadPage();
  assert.equal(page.el('quiz-toggle').textContent, 'Quiz Mode: Off');
  assert.equal(page.el('quiz-panel').hidden, true);
  assert.equal(page.el('setup-row').hidden, false);
  assert.equal(page.el('score-area').hidden, true);

  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('quiz-toggle').textContent, 'Quiz Mode: On');
  assert.equal(page.el('quiz-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(page.el('quiz-panel').hidden, false);
  assert.equal(page.el('setup-row').hidden, true);
  assert.equal(page.el('score-area').hidden, false);

  const order = ['id="quiz-panel"', 'id="structure-box"', 'id="pka-rows"', 'id="score-area"'].map(id => MARKUP.indexOf(id));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'quiz, then structure and table, then score');
  assert.ok(MARKUP.indexOf('id="setup-row"') < MARKUP.indexOf('id="quiz-panel"'));
});

test('hidden rows really disappear, whatever display their class sets', () => {
  assert.match(CSS, /\[hidden\] \{ display: none !important; \}/);
});

test('the quiz box holds the sequence, net charge and pI entries, and the table stays below', () => {
  const box = MARKUP.match(/id="quiz-panel"[\s\S]*?<\/section>/)[0];
  for (const id of ['quiz-seq', 'quiz-charge', 'quiz-pi']) assert.ok(box.includes(`id="${id}"`), id);
  assert.ok(box.includes('Determining pI'));
  assert.ok(box.includes('>Check pI<'));

  const page = loadPage();
  assert.equal(page.el('pi-entry').hidden, false);
  assert.equal(page.el('pi-title').textContent, 'Determining pI');
  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('pi-entry').hidden, true, 'one pI entry at a time');
  assert.equal(page.el('pi-title').textContent, 'pKa values');
  assert.deepEqual(pkaTable(page), FULL_PKA_TABLE);
  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('pi-entry').hidden, false);
});

test('Quiz Mode draws the structure uncharged and leaving it restores the pH', () => {
  const page = loadPage();
  page.run('setPH(4.5)');
  page.el('quiz-toggle').fire('click');
  assert.ok([2, 7, 13].includes(page.run('pH')), 'the quiz picks its own pH');
  assert.equal(page.el('structure-legend').style.display, 'none');
  assert.match(page.structure.getAttribute('aria-label'), /drawn uncharged/);
  assert.ok(page.structure.classList.contains('neutral-view'));
  page.el('quiz-toggle').fire('click');
  assert.equal(page.run('pH'), 4.5);
  assert.equal(page.structure.classList.contains('neutral-view'), false);
});

test('each question randomly asks for 1-letter or 3-letter codes', () => {
  const page = loadPage();
  page.el('quiz-toggle').fire('click');
  const seen = { 'Sequence in 1-letter codes (like AKD)': 0, 'Sequence in 3-letter codes (like Ala-Lys-Asp)': 0 };
  for (let i = 0; i < 200; i++) {
    page.el('quiz-next').fire('click');
    const label = page.el('quiz-seq-label').textContent;
    assert.ok(label in seen, label);
    seen[label]++;
    assert.ok([2, 7, 13].includes(page.run('pH')));
    assert.equal(page.el('quiz-ph').textContent, `pH ${page.run('pH')}`);
  }
  for (const [label, n] of Object.entries(seen)) assert.ok(n > 40, `${label}: ${n}`);
});

test('sequences are read in the asked format, in any case and with or without separators', () => {
  const read = (text, format) => page0.run(`parseSequenceAnswer(${JSON.stringify(text)}, '${format}')`);
  for (const text of ['AKD', 'akd', 'A-K-D', 'a k d', ' AKD ']) assert.equal(read(text, 'one'), 'AKD', text);
  for (const text of ['Ala-Lys-Asp', 'ala lys asp', 'ALA-LYS-ASP', 'AlaLysAsp', 'ala,lys,asp']) assert.equal(read(text, 'three'), 'AKD', text);
  assert.equal(read('Ala-Lys', 'one'), null, 'three-letter codes when asked for one');
  assert.equal(read('AK', 'three'), null, 'one-letter codes when asked for three');
  assert.equal(read('A-K', 'three'), null);
  assert.equal(read('AXK', 'one'), null);
  assert.equal(read('Ala-Foo', 'three'), null);
  assert.equal(read('', 'one'), null);
  assert.equal(read('   ', 'three'), null);
});

test('a right sequence is locked and shown, in either format', () => {
  const page = quizPage('AK', 'three');
  answerSeq(page, 'ala-lys');
  assert.equal(page.el('quiz-seq-result').textContent, '✓ Sequence: correct. The peptide is Ala-Lys.');
  assert.equal(page.el('quiz-seq-result').className, 'quiz-result right');
  assert.equal(page.el('quiz-seq').disabled, true);
  assert.equal(page.el('quiz-seq-check').disabled, true);
  setQuestion(page, 'AK', 'one');
  answerSeq(page, 'ak');
  assert.equal(page.el('quiz-seq-result').textContent, '✓ Sequence: correct. The peptide is AK.');
});

test('the wrong format or empty box does not use up a try', () => {
  const page = quizPage('AK', 'one');
  answerSeq(page, 'Ala-Lys');
  assert.match(page.el('quiz-seq-result').textContent, /enter it in 1-letter codes/);
  answerSeq(page, '');
  assert.match(page.el('quiz-seq-result').textContent, /enter it in 1-letter codes/);
  assert.equal(page.run('quizField.seq.wrong'), 0);
  answerSeq(page, 'AK');
  assert.match(page.el('quiz-seq-result').textContent, /^✓/);
  setQuestion(page, 'AK', 'three');
  answerSeq(page, 'AK');
  assert.match(page.el('quiz-seq-result').textContent, /enter it in 3-letter codes/);
});

test('sequence order matters, and a second wrong try shows the answer', () => {
  const page = quizPage('AK', 'one');
  answerSeq(page, 'KA');
  assert.match(page.el('quiz-seq-result').textContent, /try once more/);
  assert.equal(page.el('quiz-seq').disabled, false);
  assert.doesNotMatch(page.el('quiz-seq-result').textContent, /AK/);
  answerSeq(page, 'GG');
  assert.equal(page.el('quiz-seq-result').textContent, '✗ Sequence: the peptide is AK.');
  assert.equal(page.el('quiz-seq').disabled, true);
});

test('net charge accepts ±0.2, and a second wrong try shows the answer', () => {
  const page = quizPage('G');  // −0.09 at pH 7
  answerCharge(page, 'x');
  assert.match(page.el('quiz-charge-result').textContent, /enter a number/);
  answerCharge(page, '1');
  assert.match(page.el('quiz-charge-result').textContent, /not within ±0\.2\. Try once more/);
  assert.doesNotMatch(page.el('quiz-charge-result').textContent, /0\.09/);
  answerCharge(page, '−0.2');
  assert.equal(page.el('quiz-charge-result').textContent, '✓ Net charge: correct. The net charge is −0.09.');
  setQuestion(page, 'G');
  answerCharge(page, '1');
  answerCharge(page, '1');
  assert.equal(page.el('quiz-charge-result').textContent, '✗ Net charge: the net charge is −0.09.');
  assert.equal(page.el('quiz-check').disabled, true);
});

test('the quiz pI follows the same rules as Check pI', () => {
  const page = quizPage('G');
  answerPI(page, '7');
  assert.match(page.el('quiz-pi-result').textContent, /Evaluate the structure between pH 3\.1 and pH 8\.0/);
  assert.equal(page.el('quiz-pi').disabled, false);
  answerPI(page, '5.55');
  assert.equal(page.el('quiz-pi-result').textContent, '✓ pI: correct. The actual pI is 5.55.');
  assert.equal(page.el('quiz-pi').disabled, true);

  setQuestion(page, 'G');
  answerPI(page, '');
  assert.equal(page.el('quiz-pi-result').textContent, 'The pI is 5.55.');
  assert.equal(page.el('quiz-pi').disabled, true, 'an empty check shows it, so that try is over');

  setQuestion(page, 'G');
  answerPI(page, '7');
  answerPI(page, '7');
  assert.equal(page.el('quiz-pi-result').textContent, '✗ pI: the actual pI is 5.55.');
});

test('pressing Enter checks each quiz field', () => {
  const page = quizPage('AK');
  page.el('quiz-seq').value = 'AK';
  page.el('quiz-seq').fire('keydown', { key: 'Enter' });
  assert.match(page.el('quiz-seq-result').textContent, /^✓/);
  page.el('quiz-charge').value = '1';
  page.el('quiz-charge').fire('keydown', { key: 'Enter' });
  assert.notEqual(page.el('quiz-charge-result').textContent, '');
  page.el('quiz-pi').value = '9.4';
  page.el('quiz-pi').fire('keydown', { key: 'Enter' });
  assert.notEqual(page.el('quiz-pi-result').textContent, '');
});

test('once all three are answered, the drawing shows the charges', () => {
  const page = quizPage('G');
  answerSeq(page, 'G');
  answerCharge(page, '0');
  assert.ok(page.structure.classList.contains('neutral-view'), 'still uncharged');
  answerPI(page, '5.55');
  assert.equal(page.structure.classList.contains('neutral-view'), false);
  assert.equal(page.el('structure-legend').style.display, '');
  assert.equal(page.el('quiz-reveal').disabled, true);
});

test('Reveal shows every remaining answer, counts them as incorrect and shows the charges', () => {
  const page = quizPage('K', 'three');
  page.el('breakdown-btn').fire('click');
  answerSeq(page, 'Lys');
  page.el('quiz-reveal').fire('click');
  assert.equal(page.el('quiz-seq-result').textContent, '✓ Sequence: correct. The peptide is Lys.', 'a finished answer stays');
  assert.equal(page.el('quiz-charge-result').textContent, '✗ Net charge: the net charge is +0.91.');
  assert.equal(page.el('quiz-pi-result').textContent, '✗ pI: the actual pI is 9.40.');
  assert.equal(page.structure.classList.contains('neutral-view'), false);
  assert.deepEqual(counts(page, 'Sequence (3-letter)'), [1, 0]);
  assert.deepEqual(counts(page, 'Net charge'), [0, 1]);
  assert.deepEqual(counts(page, 'pI'), [0, 1]);
});

test('Next Peptide starts a clean question', () => {
  const page = quizPage('K');
  answerSeq(page, 'K');
  answerCharge(page, '1');
  page.el('quiz-reveal').fire('click');
  page.el('quiz-next').fire('click');
  assert.notEqual(page.run('sequence'), 'K');
  for (const id of ['quiz-seq', 'quiz-charge', 'quiz-pi']) {
    assert.equal(page.el(id).value, '', id);
    assert.equal(page.el(id).disabled, false, id);
    assert.equal(page.el(id + '-result').textContent, '', id);
  }
  assert.equal(page.el('quiz-reveal').disabled, false);
  assert.ok(page.structure.classList.contains('neutral-view'));
});

// ── Score breakdown ────────────────────────────────────────────
test('a Score breakdown button sits at the bottom and toggles a table', () => {
  const area = MARKUP.slice(MARKUP.indexOf('id="score-area"'));
  assert.ok(area.indexOf('>Reset score<') >= 0 && area.indexOf('>Reset score<') < area.indexOf('>Score breakdown<'));
  const page = loadPage();
  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('score-breakdown').hidden, true);
  assert.equal(page.el('breakdown-btn').getAttribute('aria-expanded'), 'false');
  page.el('breakdown-btn').fire('click');
  assert.equal(page.el('score-breakdown').hidden, false);
  assert.equal(page.el('breakdown-btn').getAttribute('aria-expanded'), 'true');
  assert.match(page.el('score-breakdown').innerHTML, /Correct Responses/);
  assert.match(page.el('score-breakdown').innerHTML, /Incorrect Responses/);
  assert.deepEqual(breakdownRows(page).map(r => r[0]),
    ['Sequence (1-letter)', 'Sequence (3-letter)', 'Net charge', 'pI', 'Total']);
  assert.ok(breakdownRows(page).every(r => r[1] === 0 && r[2] === 0), 'starts empty');
  page.el('breakdown-btn').fire('click');
  assert.equal(page.el('score-breakdown').hidden, true);
});

test('each answer counts in its own row, and the open table stays current', () => {
  const page = quizPage('AK', 'one');
  page.el('breakdown-btn').fire('click');
  answerSeq(page, 'AK');
  assert.deepEqual(counts(page, 'Sequence (1-letter)'), [1, 0]);
  answerCharge(page, '5');
  answerCharge(page, '5');
  assert.deepEqual(counts(page, 'Net charge'), [0, 1]);
  answerPI(page, '');
  assert.deepEqual(counts(page, 'pI'), [0, 1]);

  setQuestion(page, 'G', 'three');
  answerSeq(page, 'Ala');
  answerSeq(page, 'Gly');
  assert.deepEqual(counts(page, 'Sequence (3-letter)'), [1, 0], 'right on the second try counts');
  assert.deepEqual(counts(page, 'Sequence (1-letter)'), [1, 0], 'the other format is untouched');
  answerPI(page, '1');
  answerPI(page, '5.55');
  assert.deepEqual(counts(page, 'pI'), [1, 1], 'right after the hint counts');
  assert.deepEqual(counts(page, 'Total'), [3, 2]);
});

test('an answer counts only once per peptide, and hints and format errors do not count', () => {
  const page = quizPage('G', 'one');
  page.el('breakdown-btn').fire('click');
  answerSeq(page, 'Gly');
  answerPI(page, '1');
  answerCharge(page, '5');
  assert.deepEqual(counts(page, 'Total'), [0, 0], 'nothing is final yet');
  answerSeq(page, 'G');
  answerSeq(page, 'G');
  page.run('checkQuizSequence()');
  assert.deepEqual(counts(page, 'Total'), [1, 0]);
  page.el('quiz-reveal').fire('click');
  page.el('quiz-reveal').fire('click');
  assert.deepEqual(counts(page, 'Total'), [1, 2]);
});

test('skipping with Next Peptide adds nothing, and the outside-quiz pI check is not scored', () => {
  const page = loadPage();
  enterSeq(page, 'G');
  checkPIWith(page, '5.55');
  assert.deepEqual(page.json('breakdown'), {});
  page.el('quiz-toggle').fire('click');
  page.el('breakdown-btn').fire('click');
  page.el('quiz-next').fire('click');
  assert.deepEqual(counts(page, 'Total'), [0, 0]);
});

test('the score survives leaving the quiz, and Reset score clears it', () => {
  const page = quizPage('G');
  page.el('breakdown-btn').fire('click');
  answerSeq(page, 'G');
  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('score-area').hidden, true);
  page.el('quiz-toggle').fire('click');
  assert.deepEqual(counts(page, 'Total'), [1, 0]);
  page.el('score-reset').fire('click');
  assert.deepEqual(counts(page, 'Total'), [0, 0]);
  assert.equal(page.el('score-breakdown').hidden, false, 'the table stays open');
});

// ── Shared standards ───────────────────────────────────────────
test('tolerances are ±0.2 for charge and ±0.1 for pI, and a typed minus sign works', () => {
  const within = (a, t, tol) => page0.run(`withinTolerance(${a}, ${t}, ${tol})`);
  assert.equal(within(1.2, 1, 0.2), true);
  assert.equal(within(1.21, 1, 0.2), false);
  assert.equal(within(5.65, 5.55, 0.1), true);
  assert.equal(within(5.66, 5.55, 0.1), false);
  assert.equal(page0.run(`parseAnswer('−1.5')`), -1.5);
  assert.equal(page0.run(`parseAnswer('-1.5')`), -1.5);
  assert.equal(page0.run(`parseAnswer('+2')`), 2);
  assert.equal(page0.run(`parseAnswer('')`), null);
  assert.equal(page0.run(`parseAnswer('x')`), null);
});

test('disabled boxes and buttons use the shared gray from CLAUDE.md', () => {
  assert.match(CSS, /input:disabled, button:disabled \{[^}]*background: #E4E4E4;[^}]*border-color: #BFBFBF;[^}]*color: #404040;/);
  const guide = fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8');
  assert.match(guide, /Grayed out \(disabled box\) \| `#E4E4E4` \| `#BFBFBF` \| `#404040`/);
});

test('CLAUDE.md asks every quiz page for this score tracking', () => {
  const guide = fs.readFileSync(path.join(__dirname, 'CLAUDE.md'), 'utf8');
  assert.match(guide, /### Quiz Score Tracking/);
  assert.match(guide, /Correct Responses/);
  assert.match(guide, /Score breakdown/);
});

test('pH and pI keep their capitalization on screen', () => {
  assert.match(MARKUP, /class="panel-section-title keep-case" id="ph-title"/);
  assert.match(MARKUP, /class="panel-section-title keep-case" id="pi-title"/);
  assert.match(CSS, /\.keep-case \{ text-transform: none/);
  assert.ok(CSS.indexOf('.panel-section-title') < CSS.indexOf('.keep-case'), 'keep-case wins the cascade');
});

test('feedback keeps black text on its colored background', () => {
  assert.match(CSS, /\.quiz-result \{[^}]*color: #000000/);
  assert.match(CSS, /\.quiz-result\.info \{/);
});
