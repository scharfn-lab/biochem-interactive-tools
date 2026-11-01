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
    assert.equal(form, g.kind === 'base' ? 'deprot' : 'prot', g.name);
    assert.doesNotMatch(g[form], /[⁺⁻]/, g.name);
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

test('residue names, peptide bonds and alternating bands are drawn', () => {
  const svg = svgOf('ADEHKR');
  for (const [i, name] of ['Ala', 'Asp', 'Glu', 'His', 'Lys', 'Arg'].entries()) assert.ok(svg.includes(`>${name} ${i + 1}<`), name);
  assert.equal([...svg.matchAll(/>peptide bond</g)].length, 5);
  assert.equal([...svg.matchAll(/class="peptide-glow"/g)].length, 5);
  assert.equal([...svg.matchAll(/rgba\(104,92,83,0\.09\)/g)].length, 3);
  assert.equal([...svg.matchAll(/rgba\(255,205,255,0\.28\)/g)].length, 3);
  assert.equal(svgOf('A').includes('peptide bond'), false, 'one residue has no peptide bond');
});

test('six residues fit a desktop panel, with the drawing able to shrink', () => {
  for (const seq of ['ADEHKR', 'WWWWWW', 'RRRRRR', 'YWRYWR']) {
    assert.ok(page0.run(`buildStructure('${seq}').width`) * 1.3 <= 1036, `${seq} fits 1080px minus panel padding`);
  }
  assert.match(CSS, /#structure-box svg \{[^}]*max-width: 100%;[^}]*height: auto;/);
  assert.match(CSS, /#structure-box \{[^}]*overflow: hidden/, 'no scrolling');
});

test('colors follow the spec, and the half state is dashed', () => {
  assert.match(CSS, /\.charge-pos \.ion-box \{ stroke: var\(--positive\)/);
  assert.match(CSS, /\.charge-neg \.ion-box \{ stroke: var\(--ut-crimson\)/);
  assert.match(CSS, /\.charge-neu \.ion-box \{ stroke: var\(--ut-taupe\)/);
  assert.match(CSS, /\.ion-group\.half \.ion-box \{ stroke-dasharray/);
  assert.match(CSS, /\.ion-state \{ opacity: 0; transition: opacity/, 'smooth updates');
  const lys = svgOf('K').match(/data-group="side0">([\s\S]*?)<text class="half-label"/)[1];
  assert.match(lys, /ion-state prot charge-pos/);
  assert.match(lys, /ion-state deprot charge-neu/);
  const asp = svgOf('D').match(/data-group="side0">([\s\S]*?)<text class="half-label"/)[1];
  assert.match(asp, /ion-state prot charge-neu/);
  assert.match(asp, /ion-state deprot charge-neg/);
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

test('the input updates the peptide and keeps the last good one on an error', () => {
  const page = loadPage();
  const input = page.el('seq-input');
  input.value = 'Ala-Lys';
  input.fire('input');
  assert.equal(page.run('sequence'), 'AK');
  assert.match(page.el('notation-three').innerHTML, /H₃N⁺–Ala–Lys–COO⁻/);
  assert.match(page.el('notation-three').innerHTML, /N-terminus.*C-terminus/);
  assert.match(page.el('notation-one').innerHTML, /H₃N⁺–A–K–COO⁻/);

  input.value = 'AXK';
  input.fire('input');
  assert.equal(page.run('sequence'), 'AK', 'kept');
  assert.equal(page.el('seq-message').className, 'error');
  assert.match(page.el('seq-message').textContent, /Unknown residue: "X"/);
  assert.equal(input.getAttribute('aria-invalid'), 'true');

  input.value = 'AK';
  input.fire('input');
  assert.equal(input.getAttribute('aria-invalid'), null);
  assert.equal(page.el('seq-message').textContent, '');
});

test('the notation follows pH at the termini', () => {
  const page = loadPage();
  const notation = () => page.el('notation-three').innerHTML;
  page.run(`chooseSequence('GA')`);
  page.run('setPH(2, 2)');
  assert.match(notation(), /H₃N⁺–Gly–Ala–COOH/);
  page.run('setPH(7, 7)');
  assert.match(notation(), /H₃N⁺–Gly–Ala–COO⁻/);
  page.run('setPH(13, 13)');
  assert.match(notation(), /H₂N–Gly–Ala–COO⁻/);
  page.run(`chooseSequence('PA')`);
  assert.match(notation(), /HN–Pro–Ala–COO⁻/);
  page.run('setPH(7, 7)');
  assert.match(notation(), /H₂N⁺–Pro–Ala–COO⁻/);
});

test('presets highlight, and Random gives a valid new peptide', () => {
  const page = loadPage();
  const active = () => page.qa('.seq-preset').filter(b => b.classList.contains('active')).map(b => b.dataset.seq);
  assert.deepEqual(page.qa('.seq-preset').map(b => b.dataset.seq), ['GAG', 'DEK', 'HHH', 'CYKR', 'ADEHKR']);
  assert.deepEqual(active(), ['ADEHKR']);
  page.qa('.seq-preset')[0].fire('click');
  assert.equal(page.run('sequence'), 'GAG');
  assert.deepEqual(active(), ['GAG']);
  assert.equal(page.el('seq-input').value, 'GAG');
  for (let i = 0; i < 50; i++) {
    const before = page.run('sequence');
    page.el('random-btn').fire('click');
    const after = page.run('sequence');
    assert.notEqual(after, before);
    assert.ok(after.length >= 2 && after.length <= 6, after);
    assert.equal(parse(after).seq, after);
  }
  assert.deepEqual(active().length <= 1, true);
});

test('a chosen sequence that spells a three-letter code stays three residues', () => {
  const page = loadPage();
  for (const three of Object.values(page.json('RESIDUES'))) {
    const seq = three.toUpperCase();
    if (![...seq].every(c => page.run(`Boolean(RESIDUES['${c}'])`))) continue;
    page.run(`chooseSequence('${seq}')`);
    assert.equal(page.run('sequence'), seq, three);
    assert.equal(page.el('seq-input').value, seq.split('').join('-'), three);
    assert.equal(page.el('seq-message').textContent, '', three);
  }
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

test('results show net charge, pI and a row for each group', () => {
  const page = loadPage();
  page.run(`chooseSequence('K')`);
  page.run('setPH(7, 7)');
  assert.equal(page.el('pi-value').textContent, '9.40');
  assert.equal(page.el('net-charge').textContent, '+0.91');
  const rows = page.el('group-rows').innerHTML;
  assert.equal([...rows.matchAll(/<tr>/g)].length, 3);
  assert.match(rows, /N-terminal α-amino \(Lys1\).*8\.0.*\+0\.91.*NH₃⁺/);
  assert.match(rows, /Lys1 ε-amino.*10\.8.*\+1\.00.*NH₃⁺/);
  assert.match(rows, /C-terminal α-carboxyl \(Lys1\).*3\.1.*−1\.00.*COO⁻/);
  page.run('setPH(10.8)');
  assert.match(page.el('group-rows').innerHTML, /Lys1 ε-amino.*\+0\.50.*≈50\/50/);
});

test('tiny charges never read as −0.00', () => {
  assert.equal(page0.run('formatSigned(-0.001)'), '0.00');
  assert.equal(page0.run('formatSigned(0.001)'), '0.00');
  assert.equal(page0.run('formatSigned(-1.5)'), '−1.50');
  assert.equal(page0.run('formatSigned(1.5)'), '+1.50');
});

test('the plot marks the zero line, current pH and pI, and describes itself', () => {
  const page = loadPage();
  page.run(`chooseSequence('K')`);
  const label = page.el('plot').getAttribute('aria-label');
  assert.match(label, /pI is 9\.40/);
  const texts = page.el('plot').context.calls.filter(c => c.fn === 'fillText').map(c => c.args[0]);
  assert.ok(texts.includes('pI 9.40'));
  assert.ok(texts.includes('pH'));
  assert.ok(texts.includes('Net charge'));
  assert.ok(texts.includes('0'));
  assert.ok(page.el('plot').context.calls.some(c => c.fn === 'arc'));
});

test('hovering the plot reads out pH and net charge', () => {
  const page = loadPage();
  page.run(`chooseSequence('G')`);
  const canvas = page.el('plot');
  const area = page.json(`$('plot').plotArea`);
  canvas.fire('mousemove', { clientX: (area.left + area.right) / 2 });
  assert.match(page.el('plot-readout').textContent, /^pH 7\.0: net charge −0\.09$/);
  canvas.fire('mouseleave');
  assert.match(page.el('plot-readout').textContent, /Hover/);
  assert.equal(page.run('hoverPH'), null);
});

// ── Quiz ───────────────────────────────────────────────────────
const quizPage = (seq = 'G') => {
  const page = loadPage();
  page.run(`chooseSequence('${seq}')`);
  page.el('quiz-toggle').fire('click');
  return page;
};
const answerQuiz = (page, charge, pi) => {
  page.el('quiz-charge').value = charge;
  page.el('quiz-pi').value = pi;
  page.el('quiz-check').fire('click');
};

test('Quiz Mode hides the answers and turns back off', () => {
  const page = loadPage();
  assert.equal(page.el('quiz-toggle').textContent, 'Quiz Mode: Off');
  assert.equal(page.el('quiz-body').hidden, true);
  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('quiz-toggle').textContent, 'Quiz Mode: On');
  assert.equal(page.el('quiz-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(page.el('quiz-body').hidden, false);
  for (const id of ['plot-panel', 'results-panel']) assert.equal(page.el(id).style.display, 'none', id);
  page.el('quiz-toggle').fire('click');
  assert.equal(page.el('plot-panel').style.display, '');
  assert.equal(page.el('results-panel').style.display, '');
});

test('the quiz notation is uncharged at any pH', () => {
  const page = quizPage('GA');
  for (const ph of [2, 7, 13]) {
    page.run(`setPH(${ph}, ${ph})`);
    assert.match(page.el('notation-three').innerHTML, /H₂N–Gly–Ala–COOH/, `pH ${ph}`);
  }
  assert.match(page.structure.getAttribute('aria-label'), /drawn uncharged/);
  assert.ok(page.structure.classList.contains('neutral-view'));
});

test('Check accepts answers within tolerance and gives ✓ or ✗', () => {
  const page = quizPage('G');
  page.run('setPH(7, 7)');
  // Gly at pH 7: net charge −0.09, pI 5.55
  answerQuiz(page, '0', '5.55');
  assert.match(page.el('quiz-charge-result').textContent, /^✓ Net charge/);
  assert.match(page.el('quiz-pi-result').textContent, /^✓ pI/);
  assert.equal(page.el('quiz-charge-result').className, 'quiz-result right');

  answerQuiz(page, '0.5', '5.8');
  assert.match(page.el('quiz-charge-result').textContent, /^✗ Net charge/);
  assert.match(page.el('quiz-pi-result').textContent, /^✗ pI/);
  assert.equal(page.el('quiz-pi-result').className, 'quiz-result wrong');
  assert.doesNotMatch(page.el('quiz-pi-result').textContent, /5\.55/, 'the answer stays hidden');

  answerQuiz(page, 'abc', '');
  assert.match(page.el('quiz-charge-result').textContent, /enter a number/);
  assert.match(page.el('quiz-pi-result').textContent, /enter a number/);
});

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

test('Reveal restores everything', () => {
  const page = quizPage('K');
  page.el('quiz-reveal').fire('click');
  assert.equal(page.el('plot-panel').style.display, '');
  assert.equal(page.el('results-panel').style.display, '');
  assert.equal(page.el('pi-value').textContent, '9.40');
  assert.equal(page.structure.classList.contains('neutral-view'), false);
  assert.match(page.el('notation-three').innerHTML, /H₃N⁺/);
});

test('changing the sequence or pH clears answers and hides a reveal again', () => {
  for (const change of [`chooseSequence('A')`, 'setPH(3)', 'setPH(13, 13)']) {
    const page = quizPage('K');
    answerQuiz(page, '1', '9');
    page.el('quiz-reveal').fire('click');
    page.run(change);
    assert.equal(page.el('quiz-charge').value, '', change);
    assert.equal(page.el('quiz-pi').value, '', change);
    assert.equal(page.el('quiz-charge-result').textContent, '', change);
    assert.equal(page.el('plot-panel').style.display, 'none', change);
  }
});

test('re-selecting the same sequence or pH keeps the answers', () => {
  const page = quizPage('K');
  page.run('setPH(7, 7)');
  page.el('quiz-charge').value = '1';
  page.run(`chooseSequence('K')`);
  page.run('setPH(7, 7)');
  assert.equal(page.el('quiz-charge').value, '1');
});

test('pH and pI keep their capitalization on screen', () => {
  assert.match(MARKUP, /class="panel-section-title keep-case" id="ph-title"/);
  assert.match(MARKUP, /class="panel-section-title keep-case" id="plot-title"/);
  assert.match(CSS, /\.keep-case \{ text-transform: none/);
  assert.doesNotMatch(CSS.match(/\.stat-label \{[^}]*\}/)[0], /uppercase/);
  assert.ok(CSS.indexOf('.panel-section-title') < CSS.indexOf('.keep-case'), 'keep-case wins the cascade');
});

test('quiz feedback keeps readable text on lavender', () => {
  assert.match(CSS, /\.quiz-result\.right \{ background: var\(--ut-lavender\)/);
  assert.match(CSS, /\.quiz-result\.wrong \{[^}]*border-color: var\(--ut-crimson\)/);
  assert.match(CSS, /\.quiz-result \{[^}]*color: #000000/);
});
