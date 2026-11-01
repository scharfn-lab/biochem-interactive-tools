// Tests for amino_acids.html. No dependencies — run with: node --test
//
// The page's inline script runs unmodified in a Node vm against a small DOM stub
// built from the page's own markup, with a fake RDKit whose load the test controls.
// Top-level const/let in that script are reachable through page.run().
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'amino_acids.html'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];
const MARKUP = HTML.slice(HTML.indexOf('<body>'), HTML.indexOf('<script>', HTML.indexOf('<body>'))).replace(/<!--[\s\S]*?-->/g, '');
const IDS = [...MARKUP.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

// ── DOM stub ───────────────────────────────────────────────────
function makeElement(tag, attrs = {}) {
  const listeners = {};
  const dataset = {};
  const style = {};
  const camelCase = name => name.replace(/-(\w)/g, (_, c) => c.toUpperCase());
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[camelCase(k.slice(5))] = v;
  for (const rule of (attrs.style ?? '').split(';')) {
    const [k, v] = rule.split(':').map(s => s.trim());
    if (k) style[k] = v;
  }
  const classes = el => el.className.split(/\s+/).filter(Boolean);
  const attributes = { ...attrs };
  let html = '';
  const el = {
    tag, id: attrs.id, className: attrs.class ?? '', value: '', textContent: '', disabled: false,
    dataset, style, children: [], clientWidth: 0,
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; el.children = []; },
    classList: {
      add: (...cs) => { el.className = [...new Set([...classes(el), ...cs])].join(' '); },
      remove: (...cs) => { el.className = classes(el).filter(c => !cs.includes(c)).join(' '); },
      toggle: (c, on) => { if (on) el.classList.add(c); else el.classList.remove(c); },
      contains: c => classes(el).includes(c),
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute: name => attributes[name] ?? null,
    removeAttribute(name) { delete attributes[name]; },
    appendChild(child) { el.children.push(child); return child; },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, props = {}) {
      const e = { target: el, preventDefault() {}, ...props };
      for (const fn of listeners[type] || []) fn(e);
    },
    focus() { makeElement.focused = el; },
    scrollIntoView() {},
  };
  return el;
}

// Only the selector forms the page uses: .class and [attr] / [attr="value"], compounded
function matches(el, selector) {
  return selector.match(/\.[\w-]+|\[[^\]]+\]/g).every(part => {
    if (part[0] === '.') return el.classList.contains(part.slice(1));
    const [, attr, value] = part.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
    const name = attr.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    return value === undefined ? name in el.dataset : el.dataset[name] === value;
  });
}

function fakeRDKit(log) {
  return {
    get_mol: smiles => ({
      is_valid: () => smiles !== 'invalid',
      get_svg_with_highlights: options => {
        if (log.failHighlights) throw new Error('not supported');
        log.options = JSON.parse(options);
        return `<svg data-smiles="${smiles}"><rect style="fill:#FFFFFF;"></rect></svg>`;
      },
      get_svg: () => `<svg data-smiles="${smiles}" data-plain="1"></svg>`,
      delete: () => { log.deleted++; },
    }),
  };
}

// Most tests begin from the structure section; asOpened keeps the page's real starting section
function loadPage({ rdkit = true, asOpened = false } = {}) {
  const roots = [...MARKUP.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)].map(m => {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]));
    return makeElement(m[1], attrs);
  });
  const walk = list => list.flatMap(el => [el, ...walk(el.children)]);
  const document = makeElement('document');
  document.getElementById = id => roots.find(el => el.id === id) ?? null;
  document.querySelectorAll = selector => walk(roots).filter(el => matches(el, selector));
  document.querySelector = selector => document.querySelectorAll(selector)[0] ?? null;
  document.createElement = tag => makeElement(tag);

  const log = { deleted: 0, failHighlights: false };
  const loader = {};
  const window = rdkit === 'missing' ? {} : {
    initRDKitModule: () => ({
      then(onLoad) { loader.load = () => onLoad(fakeRDKit(log)); return { catch(onFail) { loader.fail = onFail; } }; },
    }),
  };
  const context = vm.createContext({ document, window });
  vm.runInContext(SCRIPT, context);
  document.fire('DOMContentLoaded');
  if (!asOpened) vm.runInContext(`setDisplayMode('structure')`, context);
  if (rdkit === true) loader.load();

  const run = code => vm.runInContext(code, context);
  return {
    el: id => document.getElementById(id),
    q: selector => document.querySelector(selector),
    qa: selector => document.querySelectorAll(selector),
    document, loader, log, run,
    // Values cross the vm boundary as plain data, so deepEqual sees this realm's prototypes
    json: code => JSON.parse(run(`JSON.stringify(${code})`)),
  };
}

// ── Helpers ────────────────────────────────────────────────────
const FIELDS = ['c1', 'c3', 'name', 'type', 'ph'];
const visibleFields = page => FIELDS.filter(id => page.el('fg-' + id).style.display !== 'none');
// Fixes the default "Randomly select" choices: the 1-letter code, and in name mode a question from the name
const ask = (page, code, ph) => page.run(`current = { aa: AA.find(a => a.code1 === '${code}'), ph: ${ph}, randomNameType: 'c1', randomSource: 'name' }; renderQuestion()`);
const pickNameType = (page, type) => page.run(`setNameType('${type}')`);
const answer = (page, id, value) => {
  page.el('inp-' + id).value = value;
  page.el('inp-' + id).fire(id === 'ph' ? 'change' : 'blur');
};
const scoreboard = page => ['s-total', 's-correct', 's-partial', 's-pct'].map(id => String(page.el(id).textContent));
const setRandom = (page, value) => page.run(`Math.random = () => ${value}`);
const boxHTML = page => page.el('struct-box').innerHTML;
const cells = page => page.qa('.identify-cell');
const cellHTML = cell => cell.children[0].innerHTML;
const optionIndex = (page, isCorrect) => page.json('current.identifyOptions').findIndex(o => o.isCorrect === isCorrect);
const clickCorrect = page => cells(page)[optionIndex(page, true)].onclick();
const clickWrong = page => cells(page)[optionIndex(page, false)].onclick();
const startIdentify = (page, code = 'A', ph = 7) => {
  page.run(`setDisplayMode('identify')`);
  ask(page, code, ph);
};

// ── Page wiring ────────────────────────────────────────────────
test('the page opens on Determine Structure with Randomly select', () => {
  const page = loadPage({ asOpened: true });
  assert.equal(page.run('displayMode'), 'identify');
  assert.deepEqual(page.qa('.mode-btn').filter(b => b.classList.contains('active')).map(b => b.id), ['mode-btn-identify']);
  assert.match(MARKUP, /class="mode-btn active" id="mode-btn-identify"\s+aria-pressed="true"/);
  assert.deepEqual(page.qa('[data-style]').filter(b => b.classList.contains('active')).map(b => b.dataset.style), ['random']);
  assert.equal(page.el('identify-panel').style.display, '');
  assert.equal(page.el('identify-name-toggles').style.display, '');
  assert.equal(page.q('.main-grid').style.display, 'none');
  assert.equal(page.el('qtype-bar').style.display, 'none');
  assert.equal(page.el('name-toggles').style.display, 'none');

  assert.ok(page.run('current'), 'a question is ready');
  assert.equal(page.qa('.identify-cell').length, 8);
  assert.ok(page.qa('.identify-cell').every(c => c.children[0].innerHTML.includes('<svg')));
  assert.match(page.el('identify-ph-badge').textContent, /^pH (1|7|13)$/);
  assert.notEqual(page.el('identify-aa-name').textContent, '');
});

test('the structure section starts with a question ready and one name field shown', () => {
  const page = loadPage();
  assert.equal(page.run('displayMode'), 'structure');
  assert.ok(page.run('current'), 'first question was generated');
  const fields = visibleFields(page);
  assert.equal(fields.length, 1, fields.join());
  assert.ok(['c1', 'c3', 'name'].includes(fields[0]), fields.join());
  assert.equal(page.el('ph-badge').textContent, `pH ${page.run('current.ph')}`);
  assert.equal(page.document.getElementById('inp-' + fields[0]), makeElement.focused);
});

test('every id the script looks up exists in the markup', () => {
  const used = [...SCRIPT.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  assert.ok(used.length > 0);
  for (const id of used) assert.ok(IDS.includes(id), `missing element #${id}`);
  for (const id of FIELDS) {
    for (const prefix of ['fg-', 'inp-', 'ind-']) assert.ok(IDS.includes(prefix + id), `missing element #${prefix}${id}`);
  }
  for (const m of ['structure', 'name', 'identify']) assert.ok(IDS.includes('mode-btn-' + m), `missing mode button ${m}`);
});

test('every inline onclick handler is a defined function', () => {
  const page = loadPage();
  const handlers = [...MARKUP.matchAll(/onclick="(\w+)\(/g)].map(m => m[1]);
  assert.ok(handlers.length > 0);
  for (const fn of handlers) assert.equal(page.run(`typeof ${fn}`), 'function', fn);
});

test('question-type buttons and answer dropdowns agree with the script', () => {
  const page = loadPage();
  assert.deepEqual(page.qa('.qtype-btn').map(b => b.dataset.type).sort(), page.json('Object.keys(QTYPE)').sort());
  const options = id => [...MARKUP.match(new RegExp(`id="${id}"[\\s\\S]*?</select>`))[0].matchAll(/<option value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(page.json('COMBO_OPTIONS.type'), ['Nonpolar', 'Polar', 'Acidic', 'Basic']);
  assert.deepEqual(options('inp-ph'), ['1', '7', '13']);
});

// ── Amino acid database ────────────────────────────────────────
// code1, code3, name, type, net charge at pH 1 / 7 / 13
const EXPECTED = [
  ['G', 'Gly', 'Glycine',       'nonpolar', 1,  0, -1],
  ['A', 'Ala', 'Alanine',       'nonpolar', 1,  0, -1],
  ['V', 'Val', 'Valine',        'nonpolar', 1,  0, -1],
  ['L', 'Leu', 'Leucine',       'nonpolar', 1,  0, -1],
  ['I', 'Ile', 'Isoleucine',    'nonpolar', 1,  0, -1],
  ['P', 'Pro', 'Proline',       'nonpolar', 1,  0, -1],
  ['F', 'Phe', 'Phenylalanine', 'nonpolar', 1,  0, -1],
  ['W', 'Trp', 'Tryptophan',    'nonpolar', 1,  0, -1],
  ['M', 'Met', 'Methionine',    'nonpolar', 1,  0, -1],
  ['S', 'Ser', 'Serine',        'polar',    1,  0, -1],
  ['T', 'Thr', 'Threonine',     'polar',    1,  0, -1],
  ['C', 'Cys', 'Cysteine',      'polar',    1,  0, -2],
  ['N', 'Asn', 'Asparagine',    'polar',    1,  0, -1],
  ['Q', 'Gln', 'Glutamine',     'polar',    1,  0, -1],
  ['Y', 'Tyr', 'Tyrosine',      'polar',    1,  0, -2],
  ['D', 'Asp', 'Aspartate',     'acidic',   1, -1, -2],
  ['E', 'Glu', 'Glutamate',     'acidic',   1, -1, -2],
  ['K', 'Lys', 'Lysine',        'basic',    2,  1, -1],
  ['R', 'Arg', 'Arginine',      'basic',    2,  1, -1],
  ['H', 'His', 'Histidine',     'basic',    2,  0, -1],
];
const netCharge = smiles => [...smiles.matchAll(/\[[^\]]*([+-])\]/g)].reduce((sum, m) => sum + (m[1] === '+' ? 1 : -1), 0);

test('the database holds the 20 standard amino acids with the right codes and types', () => {
  const aa = loadPage().json('AA');
  assert.deepEqual(aa.map(a => [a.code1, a.code3, a.name, a.type]).sort(), EXPECTED.map(e => e.slice(0, 4)).sort());
  for (const a of aa) assert.ok(a.note.length > 0, `${a.name} has a note`);
});

test('every structure has the net charge expected at its pH', () => {
  const aa = loadPage().json('AA');
  for (const [code1, , name, , q2, q7, q13] of EXPECTED) {
    const { smiles } = aa.find(a => a.code1 === code1);
    assert.deepEqual([1, 7, 13].map(ph => netCharge(smiles[ph])), [q2, q7, q13], name);
  }
});

test('all 60 SMILES are distinct, so no two options in a question can look identical', () => {
  const all = loadPage().json('AA').flatMap(a => [a.smiles[1], a.smiles[7], a.smiles[13]]);
  assert.equal(all.length, 60);
  assert.equal(new Set(all).size, 60);
});

// @ and @@ describe the written neighbor order, not R/S. Every entry lists N, H, side chain,
// carboxyl around Cα (Pro's ring order is an even permutation of that), so every L-amino acid
// has @@ there, including cysteine even though its CIP label is R. β-carbons list Cα, H, then
// the substituents as written: L-Ile [C@H](CC)C is 3S and L-Thr [C@H](O)C is 3R.
test('every structure has natural L stereochemistry', () => {
  const aa = loadPage().json('AA');
  const expected = { G: [], I: ['@@', '@'], T: ['@@', '@'] };
  const wrong = [];
  for (const a of aa) {
    for (const ph of [1, 7, 13]) {
      const tags = [...a.smiles[ph].matchAll(/\[C(@@?)H\]/g)].map(m => m[1]);
      if (tags.join() !== (expected[a.code1] ?? ['@@']).join()) wrong.push(`${a.name} pH ${ph}: ${a.smiles[ph]}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// ── Question generation ────────────────────────────────────────
test('nextQuestion can reach all three pH values', () => {
  const page = loadPage();
  for (const [r, ph] of [[0, 1], [0.5, 7], [0.999, 13]]) {
    setRandom(page, r);
    page.run('nextQuestion()');
    assert.equal(page.run('current.ph'), ph);
  }
});

test('every amino acid comes up once per round, never twice in a row', () => {
  const page = loadPage();
  const seen = [page.run('current.aa.code1')];
  for (let i = 1; i < 200; i++) {
    page.run('nextQuestion()');
    seen.push(page.run('current.aa.code1'));
  }
  for (let start = 0; start < 200; start += 20) {
    assert.equal(new Set(seen.slice(start, start + 20)).size, 20, `round starting at question ${start}`);
  }
  seen.forEach((code, i) => assert.notEqual(code, seen[i - 1], `questions ${i - 1} and ${i}`));
});

test('a new round cannot start with the amino acid that ended the last one', () => {
  const page = loadPage();
  // With random fixed at 0.999, shuffle keeps database order, so pop() deals AA[19] first
  setRandom(page, 0.999);
  page.run('questionBag = []; current = { aa: AA[19], ph: 7 }; nextQuestion()');
  assert.notEqual(page.run('current.aa.code1'), 'H');
});

test('shuffle returns a permutation and leaves its input alone', () => {
  const page = loadPage();
  const out = page.json(`(() => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    return { result: shuffle(input), input };
  })()`);
  assert.deepEqual(out.input, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...out.result].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ── Active fields ──────────────────────────────────────────────
test('getActiveFields follows the mode, question types and name type', () => {
  const cases = [
    ['structure', [`setNameType('name')`], ['name']],
    ['structure', [`setNameType('c3')`, `toggleQuestionType('ph')`], ['c3', 'ph']],
    ['structure', [`toggleQuestionType('properties')`, `toggleQuestionType('name')`], ['type']],
    ['structure', [`setNameType('c1')`], ['c1']],
    ['name', [], ['type']],
    ['name', [`setNameType('c1')`], ['type']],
    ['name', [`setNameType('name')`], ['type']],
    ['identify', [], []],
  ];
  for (const [mode, actions, expected] of cases) {
    const page = loadPage();
    page.run(`setDisplayMode('${mode}')`);
    for (const action of actions) page.run(action);
    assert.deepEqual(page.json('getActiveFields()'), expected, `${mode}: ${actions}`);
    assert.equal(page.run('getMaxPts()'), mode === 'identify' ? 1 : expected.length);
    if (mode !== 'identify') assert.deepEqual(visibleFields(page), FIELDS.filter(f => expected.includes(f)));
  }
});

test('at least one question type always stays active', () => {
  const page = loadPage();
  page.run(`toggleQuestionType('name')`);
  assert.deepEqual(page.json('[...activeQtypeSet]'), ['name']);
  page.run(`toggleQuestionType('ph')`);
  page.run(`toggleQuestionType('name')`);
  assert.deepEqual(page.json('[...activeQtypeSet]'), ['ph']);
  assert.ok(page.q('[data-type="ph"]').classList.contains('active'));
  assert.ok(!page.q('[data-type="name"]').classList.contains('active'));
});

test('the pH badge is hidden only while pH is being asked for', () => {
  const page = loadPage();
  ask(page, 'A', 13);
  assert.equal(page.el('ph-badge').textContent, 'pH 13');
  page.run(`toggleQuestionType('ph')`);
  assert.equal(page.el('ph-badge').textContent, 'pH ?');
  page.run('showAnswers()');
  assert.equal(page.el('ph-badge').textContent, 'pH 13', 'revealed with the answers');
});

// ── Grading ────────────────────────────────────────────────────
test('text answers ignore case and surrounding spaces', () => {
  for (const [c1, c3, name] of [['a', 'ala', 'alanine'], [' A ', ' ALA ', ' ALANINE '], ['A', 'Ala', 'Alanine']]) {
    const page = loadPage();
    Object.entries({ c1, c3, name }).forEach(([type, value], i) => {
      pickNameType(page, type);
      ask(page, 'A', 7);
      answer(page, type, value);
      assert.deepEqual(scoreboard(page), [`${i + 1}`, `${i + 1}`, '0', '100%'], `${type}: ${value}`);
    });
  }
});

test('Aspartic acid and Glutamic acid are accepted as full names', () => {
  for (const [code, names] of [['D', ['Aspartate', 'aspartic acid', ' Aspartic  Acid ']], ['E', ['Glutamate', 'glutamic acid']]]) {
    for (const name of names) {
      const page = loadPage();
      pickNameType(page, 'name');
      ask(page, code, 7);
      answer(page, 'name', name);
      assert.equal(page.el('inp-name').className, 'field-input ok', name);
    }
  }
  const page = loadPage();
  pickNameType(page, 'name');
  ask(page, 'D', 7);
  answer(page, 'name', 'Glutamic acid');
  assert.equal(page.el('inp-name').className, 'field-input bad', "Glu's name is not accepted for Asp");
  ask(page, 'A', 7);
  answer(page, 'name', 'Aspartic acid');
  assert.equal(page.el('inp-name').className, 'field-input bad');
});

test('wrong answers are exposed to assistive technology and clear when fixed', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'G');
  assert.equal(page.el('inp-c1').getAttribute('aria-invalid'), 'true');
  answer(page, 'c1', '');
  assert.equal(page.el('inp-c1').getAttribute('aria-invalid'), null);
  answer(page, 'c1', 'G');
  answer(page, 'c1', 'A');
  assert.equal(page.el('inp-c1').getAttribute('aria-invalid'), null);
  ask(page, 'A', 7);
  answer(page, 'c1', 'G');
  page.run('showAnswers()');
  assert.equal(page.el('inp-c1').getAttribute('aria-invalid'), null);
});

test('a correct field locks with a check mark', () => {
  const page = loadPage();
  page.run(`toggleQuestionType('properties')`);
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  assert.equal(page.el('inp-c1').className, 'field-input ok');
  assert.equal(page.el('inp-c1').disabled, true);
  assert.equal(page.el('ind-c1').textContent, '✓');
  assert.equal(page.run('answered'), false, 'the other fields are still open');
});

test('a wrong field stays editable and can be corrected', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'G');
  assert.equal(page.el('inp-c1').className, 'field-input bad');
  assert.equal(page.el('inp-c1').disabled, false);
  assert.equal(page.el('ind-c1').textContent, '✗');
  answer(page, 'c1', 'A');
  assert.equal(page.el('inp-c1').className, 'field-input ok');
  assert.equal(page.el('ind-c1').textContent, '✓');
});

test('clearing a field removes its mark without grading it', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'G');
  answer(page, 'c1', '   ');
  assert.equal(page.el('inp-c1').className, 'field-input');
  assert.equal(page.el('ind-c1').textContent, '');
});

test('fields that are not part of the question are not graded', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.el('inp-type').value = 'nonpolar';
  page.run(`gradeField('type')`);
  assert.equal(page.el('inp-type').className, 'field-input');
});

test('dropdown answers grade on change against the true type and pH', () => {
  const page = loadPage();
  page.run(`toggleQuestionType('properties'); toggleQuestionType('ph'); toggleQuestionType('name')`);
  ask(page, 'K', 13);
  answer(page, 'type', 'acidic');
  assert.equal(page.el('inp-type').className, 'field-input bad');
  answer(page, 'type', 'basic');
  assert.equal(page.el('inp-type').className, 'field-input ok');
  answer(page, 'ph', '7');
  assert.equal(page.el('inp-ph').className, 'field-input bad');
  answer(page, 'ph', '13');
  assert.equal(page.el('inp-ph').className, 'field-input ok');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
});

test('every amino acid can be answered correctly at every pH', () => {
  for (const nameType of ['c1', 'c3', 'name']) {
    const page = loadPage();
    page.run(`toggleQuestionType('properties'); toggleQuestionType('ph')`);
    pickNameType(page, nameType);
    let done = 0;
    for (const [code1, code3, name, type] of EXPECTED) {
      for (const ph of [1, 7, 13]) {
        ask(page, code1, ph);
        answer(page, 'c1', code1);
        answer(page, 'c3', code3);
        answer(page, 'name', name);
        answer(page, 'type', type);
        answer(page, 'ph', String(ph));
        done++;
        assert.equal(page.el('s-correct').textContent, done, `${name} at pH ${ph}, name type ${nameType}`);
      }
    }
  }
});

test('Enter grades the field, then moves on once the question is finished', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.el('inp-c1').value = 'A';
  page.el('inp-c1').fire('keydown', { key: 'Enter' });
  assert.equal(page.el('inp-c1').disabled, true);
  answer(page, 'c3', 'Ala');
  answer(page, 'name', 'Alanine');
  assert.equal(page.run('answered'), true);

  const before = page.run('current');
  page.el('inp-name').fire('keydown', { key: 'a' });
  assert.equal(page.run('current'), before, 'other keys do nothing');
  page.el('inp-name').fire('keydown', { key: 'Enter' });
  assert.notEqual(page.run('current'), before);
  assert.equal(page.run('answered'), false);
});

test('a new question clears every field, mark and message', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  answer(page, 'c3', 'Gly');
  page.run('showAnswers()');
  assert.equal(page.el('btn-check').disabled, true);

  page.run('nextQuestion()');
  for (const id of FIELDS) {
    assert.equal(page.el('inp-' + id).value, '', id);
    assert.equal(page.el('inp-' + id).className, 'field-input', id);
    assert.equal(page.el('inp-' + id).disabled, false, id);
    assert.equal(page.el('ind-' + id).textContent, '', id);
  }
  assert.equal(page.el('feedback').className, 'feedback');
  assert.equal(page.el('feedback').innerHTML, '');
  assert.equal(page.el('btn-check').disabled, false);
});

// ── Show Answers and scoring ───────────────────────────────────
test('Show Answers reveals what is missing and credits only what was already right', () => {
  const page = loadPage();
  page.run(`toggleQuestionType('properties')`);
  ask(page, 'W', 7);
  answer(page, 'c1', 'W');
  answer(page, 'type', 'polar');
  page.run('showAnswers()');
  assert.equal(page.el('inp-type').value, 'Nonpolar');
  assert.equal(page.el('inp-name').value, '', 'a field that was not asked is left alone');
  for (const id of ['c1', 'type']) assert.equal(page.el('inp-' + id).disabled, true, id);
  assert.deepEqual(scoreboard(page), ['1', '0', '1', '50%']);
  assert.equal(page.el('feedback').className, 'feedback show partial');
  assert.match(page.el('feedback').innerHTML, /1\/2 correct\./);
  for (const text of ['Trp', 'Tryptophan', 'Nonpolar', 'pH 7']) assert.ok(page.el('feedback').innerHTML.includes(text), text);
});

test('Show Answers with nothing right scores zero', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run('showAnswers()');
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.equal(page.el('feedback').className, 'feedback show wrong');
  assert.match(page.el('feedback').innerHTML, /0\/1 correct\./);
});

test('finishing every field reports a perfect score without Show Answers', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  answer(page, 'c3', 'Ala');
  answer(page, 'name', 'Alanine');
  assert.equal(page.el('feedback').className, 'feedback show all-correct');
  assert.match(page.el('feedback').innerHTML, /Correct!/);
  assert.equal(page.el('btn-check').disabled, true);

  page.run(`toggleQuestionType('ph')`);
  ask(page, 'G', 7);
  answer(page, 'c1', 'G');
  answer(page, 'ph', '7');
  assert.match(page.el('feedback').innerHTML, /Perfect! All 2 correct\./);
});

test('a finished question cannot be scored twice', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run('showAnswers()');
  page.run('showAnswers()');
  page.run(`gradeField('c1')`);
  assert.equal(page.el('s-total').textContent, 1);
});

test('reopening a finished question by changing settings does not score it again', () => {
  const reopen = [
    `toggleQuestionType('properties')`,
    `setNameType('c3')`,
    `setDisplayMode('name')`,
    `setDisplayMode('identify')`,
  ];
  for (const action of reopen) {
    const page = loadPage();
    ask(page, 'A', 7);
    page.run('showAnswers()');
    assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);

    page.run(action);
    assert.equal(page.run('answered'), false, action);
    if (page.run('displayMode') === 'identify') clickCorrect(page);
    else {
      const fields = page.json('getActiveFields()');
      const answers = { c1: 'A', c3: 'Ala', name: 'Alanine', type: 'nonpolar', ph: '7' };
      for (const id of fields) answer(page, id, answers[id]);
    }
    assert.equal(page.run('answered'), true, action);
    assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%'], action);
    assert.match(page.el('feedback').innerHTML, /already scored/, action);
  }
});

test('a new question is scored normally after a reopened one', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run('showAnswers()');
  pickNameType(page, 'c3');
  ask(page, 'G', 7);
  answer(page, 'c3', 'Gly');
  assert.equal(page.el('s-total').textContent, 2);
  assert.doesNotMatch(page.el('feedback').innerHTML, /already scored/);
});

test('the teaching note appears only once the question is finished', () => {
  const page = loadPage();
  ask(page, 'W', 7);
  const note = page.run('current.aa.note');
  answer(page, 'c1', 'A');
  assert.ok(!page.el('feedback').innerHTML.includes(note));
  page.run('showAnswers()');
  assert.ok(page.el('feedback').innerHTML.includes(note));

  startIdentify(page, 'W', 7);
  clickWrong(page);
  assert.ok(!page.el('feedback').innerHTML.includes(note), 'not after a wrong pick');
  clickCorrect(page);
  assert.ok(page.el('feedback').innerHTML.includes(note));
});

test('the score percentage is weighted by points across questions', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  answer(page, 'c3', 'Ala');
  answer(page, 'name', 'Alanine');
  ask(page, 'G', 7);
  page.run('showAnswers()');
  assert.deepEqual(scoreboard(page), ['2', '1', '0', '50%']);
});

test('Reset score clears the tally and keeps the question', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run('showAnswers()');
  const before = page.run('current');
  page.run('resetScore()');
  assert.deepEqual(scoreboard(page), ['0', '0', '0', '—']);
  assert.equal(page.run('current'), before);
});

// ── Type-ahead answer lists ────────────────────────────────────
const listed = (page, id) => (page.el('list-' + id).hidden ? null : page.el('list-' + id).children.map(c => c.textContent));
const typeInto = (page, id, text) => {
  page.el('inp-' + id).value = text;
  page.el('inp-' + id).fire('input');
};
const showAllFields = page => page.run(`toggleQuestionType('properties')`);

test('name and type answers are combo boxes, and pH stays a dropdown', () => {
  for (const id of ['c1', 'c3', 'name', 'type']) {
    assert.match(MARKUP, new RegExp(`<input [^>]*id="inp-${id}"[^>]*role="combobox"[^>]*aria-controls="list-${id}"`), id);
    assert.match(MARKUP, new RegExp(`<ul [^>]*id="list-${id}"[^>]*role="listbox"[^>]*aria-label=`), id);
  }
  assert.match(MARKUP, /<select class="field-input" id="inp-ph">/);
  assert.equal([...MARKUP.matchAll(/<select/g)].length, 1, 'pH is the only dropdown left');
});

test('the lists hold every answer the page accepts', () => {
  const options = loadPage().json('COMBO_OPTIONS');
  assert.deepEqual(options.c1, EXPECTED.map(e => e[0]).sort());
  assert.deepEqual(options.c3, EXPECTED.map(e => e[1]).sort());
  assert.deepEqual(options.name, [...EXPECTED.map(e => e[2]), 'Aspartic acid', 'Glutamic acid'].sort());
  assert.equal(options.c1.length, 20);
});

test('typing shows only the options that start with those letters, in any case', () => {
  const page = loadPage();
  showAllFields(page);
  page.run(`setNameType('name')`);
  ask(page, 'A', 7);
  assert.equal(listed(page, 'name'), null, 'closed before any typing');
  typeInto(page, 'name', 'gl');
  assert.deepEqual(listed(page, 'name'), ['Glutamate', 'Glutamic acid', 'Glutamine', 'Glycine']);
  typeInto(page, 'name', 'GLUTAM');
  assert.deepEqual(listed(page, 'name'), ['Glutamate', 'Glutamic acid', 'Glutamine']);
  typeInto(page, 'name', 'a');
  assert.ok(!listed(page, 'name').includes('Valine'), 'a letter later in the word is not a match');
  typeInto(page, 'name', 'zzz');
  assert.equal(listed(page, 'name'), null, 'nothing matches, so nothing is listed');
  typeInto(page, 'name', '');
  assert.equal(listed(page, 'name'), null, 'clearing the box closes the list');

  typeInto(page, 'type', 'p');
  assert.deepEqual(listed(page, 'type'), ['Polar']);
  typeInto(page, 'type', 'NO');
  assert.deepEqual(listed(page, 'type'), ['Nonpolar']);

  pickNameType(page, 'c3');
  typeInto(page, 'c3', 'a');
  assert.deepEqual(listed(page, 'c3'), ['Ala', 'Arg', 'Asn', 'Asp']);
  pickNameType(page, 'c1');
  typeInto(page, 'c1', 'a');
  assert.deepEqual(listed(page, 'c1'), ['A'], 'a complete answer still narrows while typing');
});

test('a new question does not open a list by focusing the box', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  assert.equal(makeElement.focused, page.el('inp-c1'));
  assert.equal(listed(page, 'c1'), null);
  assert.equal(page.el('inp-c1').getAttribute('aria-expanded'), 'false');
});

test('clicking a box lists every option, or the matches for partial text', () => {
  const page = loadPage();
  showAllFields(page);
  ask(page, 'A', 7);
  page.el('inp-type').fire('click');
  assert.deepEqual(listed(page, 'type'), ['Nonpolar', 'Polar', 'Acidic', 'Basic']);
  assert.equal(page.el('inp-type').getAttribute('aria-expanded'), 'true');
  page.el('inp-type').fire('blur');
  assert.equal(listed(page, 'type'), null);

  page.el('inp-type').value = 'a';
  page.el('inp-type').fire('click');
  assert.deepEqual(listed(page, 'type'), ['Acidic']);
});

test('choosing an option with the mouse grades it once, then moves on', () => {
  const page = loadPage();
  showAllFields(page);
  ask(page, 'A', 7);
  typeInto(page, 'c1', 'a');
  const option = page.el('list-c1').children[0];
  let prevented = false;
  option.fire('mousedown', { preventDefault() { prevented = true; } });
  assert.ok(prevented, 'focus stays in the box, so partial text is not graded on blur');
  option.fire('click');
  assert.equal(page.el('inp-c1').value, 'A');
  assert.equal(page.el('inp-c1').className, 'field-input ok');
  assert.equal(listed(page, 'c1'), null);
  assert.equal(makeElement.focused, page.el('inp-type'), 'on to the next open field');

  page.el('inp-type').fire('click');
  page.el('list-type').children[0].fire('click');
  assert.equal(page.run('answered'), true);
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
  assert.equal(makeElement.focused, page.q('.btn-next'), 'finished, so on to Next');
});

test('a wrong choice stays editable and the full list comes back on click', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run(`setNameType('c3')`);
  typeInto(page, 'c3', 'g');
  const option = page.el('list-c3').children.find(c => c.textContent === 'Gly');
  option.fire('click');
  assert.equal(page.el('inp-c3').className, 'field-input bad');
  assert.equal(page.el('inp-c3').disabled, false);
  assert.equal(makeElement.focused, page.el('inp-c3'), 'stays to try again');
  page.el('inp-c3').fire('click');
  assert.equal(listed(page, 'c3').length, 20);
  page.el('list-c3').children.find(c => c.textContent === 'Ala').fire('click');
  assert.equal(page.el('inp-c3').className, 'field-input ok');
});

test('the lists work from the keyboard', () => {
  const page = loadPage();
  showAllFields(page);
  ask(page, 'A', 7);
  const box = page.el('inp-type');
  const list = page.el('list-type');
  const key = k => box.fire('keydown', { key: k });
  const active = () => list.children.filter(c => c.classList.contains('combo-active')).map(c => c.textContent);

  key('ArrowDown');
  assert.deepEqual(active(), ['Nonpolar'], 'opens on the first option');
  assert.equal(box.getAttribute('aria-activedescendant'), list.children[0].id);
  assert.equal(list.children[0].getAttribute('aria-selected'), 'true');
  key('ArrowDown');
  assert.deepEqual(active(), ['Polar']);
  key('ArrowUp');
  key('ArrowUp');
  assert.deepEqual(active(), ['Basic'], 'wraps around');
  key('ArrowDown');
  assert.deepEqual(active(), ['Nonpolar']);

  key('Escape');
  assert.equal(listed(page, 'type'), null);
  assert.equal(box.getAttribute('aria-activedescendant'), null);

  key('ArrowUp');
  assert.deepEqual(active(), ['Basic'], 'ArrowUp opens on the last option');
  key('ArrowUp');
  key('ArrowUp');
  key('ArrowUp');
  assert.deepEqual(active(), ['Nonpolar']);
  key('Enter');
  assert.equal(box.value, 'Nonpolar');
  assert.equal(box.className, 'field-input ok');
  assert.equal(listed(page, 'type'), null);
  assert.equal(makeElement.focused, page.el('inp-c1'), 'on to the open field');
});

test('Enter without a highlighted option grades the typed text', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  typeInto(page, 'c1', 'a');
  page.el('inp-c1').fire('keydown', { key: 'Enter' });
  assert.equal(listed(page, 'c1'), null);
  assert.equal(page.el('inp-c1').className, 'field-input ok');
});

test('leaving a box closes its list and grades what was typed', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  typeInto(page, 'c1', 'g');
  page.el('inp-c1').fire('blur');
  assert.equal(listed(page, 'c1'), null);
  assert.equal(page.el('inp-c1').className, 'field-input bad');
});

test('locked answers cannot reopen a list, and new questions close open ones', () => {
  const page = loadPage();
  showAllFields(page);
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  page.el('inp-c1').fire('click');
  assert.equal(listed(page, 'c1'), null, 'a correct answer stays locked');

  typeInto(page, 'type', 'p');
  page.run('showAnswers()');
  assert.equal(listed(page, 'type'), null, 'Show Answers closes it');

  ask(page, 'G', 7);
  typeInto(page, 'type', 'p');
  page.run('nextQuestion()');
  assert.equal(listed(page, 'type'), null, 'a new question closes it');
  assert.equal(page.el('inp-type').getAttribute('aria-expanded'), 'false');
});

// ── Interactions between two amino acids ───────────────────────
const interactionsOf = (page, a, b, ph = 7) => page.json(`correctInteractions(aaByCode('${a}'), aaByCode('${b}'), ${ph})`).sort();
const askPair = (page, a, b, nameType = 'c3') => page.run(`interactQuestion = { a: '${a}', b: '${b}', nameType: '${nameType}' }; renderQuestion()`);
const startInteract = (page, a = 'D', b = 'K', nameType = 'c3') => {
  page.run(`setDisplayMode('interact')`);
  askPair(page, a, b, nameType);
};
const INTERACTION_KEYS = { 'Salt bridge': 'salt', 'Hydrogen bond': 'hbond', Hydrophobic: 'hydrophobic', 'Pi stacking': 'pi', 'Disulfide bond': 'disulfide', 'Charge repulsion': 'repulsion' };
const enter = (page, label) => page.run(`chooseInteraction('${INTERACTION_KEYS[label]}')`);
const option = (page, label) => page.q(`[data-interaction="${INTERACTION_KEYS[label]}"]`);
const structuresShown = page => page.el('pair-grid').style.display !== 'none';

// Worked out by hand from the side-chain chemistry, deliberately not from the page's own table
const PAIR_ANSWERS = [
  ['D', 'K', ['salt']],                    // the salt bridge overrides its hydrogen bond
  ['E', 'R', ['salt']],
  ['D', 'R', ['salt']],
  ['E', 'K', ['salt']],
  ['D', 'E', ['repulsion']],
  ['K', 'R', ['repulsion']],
  ['K', 'H', ['hbond']],                   // His is neutral at pH 7 on this page
  ['D', 'H', ['hbond']],
  ['D', 'S', ['hbond']],
  ['C', 'C', ['disulfide', 'hbond']],
  ['C', 'S', ['hbond']],
  ['F', 'W', ['hydrophobic', 'pi']],
  ['F', 'Y', ['pi']],                      // Tyr is polar here, so it is not hydrophobic
  ['F', 'A', ['hydrophobic']],
  ['Y', 'Y', ['hbond', 'pi']],
  ['H', 'H', ['hbond', 'pi']],
  ['H', 'F', ['pi']],
  ['W', 'W', ['hydrophobic', 'pi']],       // indole NH can only donate
  ['W', 'S', ['hbond']],
  ['M', 'S', []],                          // Met sulfur is not counted as an acceptor
  ['M', 'L', ['hydrophobic']],
  ['S', 'T', ['hbond']],
  ['N', 'Q', ['hbond']],
  ['A', 'S', []],
  ['D', 'A', []],
];

test('the side-chain rules give the expected interactions at pH 7', () => {
  const page = loadPage();
  for (const [a, b, expected] of PAIR_ANSWERS) {
    assert.deepEqual(interactionsOf(page, a, b), [...expected].sort(), `${a}-${b}`);
  }
});

test('glycine has no side chain, so it forms nothing with any amino acid', () => {
  const page = loadPage();
  for (const [code] of EXPECTED) assert.deepEqual(interactionsOf(page, 'G', code), [], code);
});

test('salt bridges form only between Asp or Glu and Lys or Arg', () => {
  const page = loadPage();
  const found = [];
  for (const [a] of EXPECTED) {
    for (const [b] of EXPECTED) {
      if (interactionsOf(page, a, b).includes('salt')) found.push([a, b].sort().join(''));
    }
  }
  assert.deepEqual([...new Set(found)].sort(), ['DK', 'DR', 'EK', 'ER']);
});

test('a pair gives the same answer in either order', () => {
  const page = loadPage();
  for (const [a] of EXPECTED) {
    for (const [b] of EXPECTED) assert.deepEqual(interactionsOf(page, a, b), interactionsOf(page, b, a), `${a}-${b}`);
  }
});

test('side-chain charges agree with the net charge of each structure', () => {
  const page = loadPage();
  const backbone = { 1: 1, 7: 0, 13: -1 };
  for (const [code, , name, , q1, q7, q13] of EXPECTED) {
    const net = { 1: q1, 7: q7, 13: q13 };
    for (const ph of [1, 7, 13]) {
      assert.equal(page.run(`SIDE_CHAINS['${code}'][${ph}].charge`), net[ph] - backbone[ph], `${name} at pH ${ph}`);
    }
  }
});

test('the choices are six buttons above the structures', () => {
  const buttons = [...MARKUP.matchAll(/data-interaction="(\w+)"[^>]*onclick="chooseInteraction\('(\w+)'\)">([^<]+)</g)];
  assert.deepEqual(buttons.map(m => m[3]),
    ['Hydrogen bond', 'Hydrophobic', 'Pi stacking', 'Salt bridge', 'Charge repulsion', 'Disulfide bond']);
  assert.deepEqual(loadPage().json('INTERACTIONS.map(i => i[1])'), buttons.map(m => m[3]), 'explanations use the same order');
  for (const m of buttons) assert.equal(m[1], m[2]);
  assert.doesNotMatch(HTML, /cation/i);
  assert.doesNotMatch(HTML, /None of these/);
  assert.doesNotMatch(HTML, /inp-choice|list-choice|Check Answer/, 'no entry box or separate check step');
  assert.ok(MARKUP.indexOf('data-interaction="salt"') < MARKUP.indexOf('id="pair-grid"'));
});

test('the section shows its own panel and hides the others', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact')`);
  assert.equal(page.el('interact-panel').style.display, '');
  assert.equal(page.q('.main-grid').style.display, 'none');
  assert.equal(page.el('identify-panel').style.display, 'none');
  assert.equal(page.el('qtype-bar').style.display, 'none');
  assert.equal(page.el('source-bar').style.display, 'none');
  assert.equal(page.el('name-toggles').style.display, 'none');
  assert.ok(page.el('mode-btn-interact').classList.contains('active'));
  page.run(`setDisplayMode('structure')`);
  assert.equal(page.el('interact-panel').style.display, 'none');
  assert.equal(page.q('.main-grid').style.display, '');
});

test('the question names both amino acids the same way, with pH 7 in parentheses', () => {
  const page = loadPage();
  const prompt = () => page.el('interact-prompt').innerHTML;
  for (const [type, a, b] of [['c1', 'D', 'K'], ['c3', 'Asp', 'Lys'], ['name', 'Aspartate', 'Lysine']]) {
    startInteract(page, 'D', 'K', type);
    assert.ok(prompt().includes(`<strong>${a}</strong> and <strong>${b}</strong> <strong>(pH 7)</strong>`), prompt());
  }
});

test('Randomly chosen questions use one name type for the pair', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact')`);
  for (const [r, type] of [[0, 'c1'], [0.5, 'c3'], [0.9, 'name']]) {
    setRandom(page, r);
    page.run('nextQuestion()');
    assert.equal(page.run('interactQuestion.nameType'), type);
    const { a, b } = page.json('interactQuestion');
    const name = code => page.run(`nameOfType(aaByCode('${code}'), '${type}')`);
    assert.ok(page.el('interact-prompt').innerHTML.includes(`<strong>${name(a)}</strong> and <strong>${name(b)}</strong>`));
  }
});

test('structures stay hidden until a choice is entered', () => {
  const page = loadPage();
  startInteract(page, 'F', 'A');
  assert.equal(structuresShown(page), false);
  enter(page, 'Hydrogen bond');
  assert.equal(structuresShown(page), true);
  assert.ok(page.el('pair-struct-a').innerHTML.includes(page.run(`aaByCode('F').smiles[7]`)));
  assert.ok(page.el('pair-struct-b').innerHTML.includes(page.run(`aaByCode('A').smiles[7]`)));
});

test('a right first answer scores and shows the answer first, then its reason', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startInteract(page);
  enter(page, 'Salt bridge');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
  assert.deepEqual(counts(page, 'Interactions'), [1, 0]);
  const text = page.el('feedback').innerHTML;
  assert.equal(page.el('feedback').className, 'feedback show all-correct');
  assert.match(text, /Correct!/);
  assert.match(text, /interact-answer">Correct interaction: Salt bridge</);
  assert.match(text, /<b>Salt bridge:<\/b> Asp carboxylate COO⁻ and Lys ammonium NH₃⁺ carry opposite charges/);
  assert.ok(text.indexOf('interact-answer') < text.indexOf('interact-reasons'));
  assert.ok(option(page, 'Salt bridge').classList.contains('opt-correct'));
  assert.equal(option(page, 'Salt bridge').dataset.mark, '✓');
  assert.ok(page.qa('.interact-opt').every(b => b.disabled));
  assert.equal(option(page, 'Hydrophobic').dataset.mark, undefined, 'other choices stay unmarked');
  assert.equal(makeElement.focused, page.el('interact-btn-next'));
});

test('only the correct interactions are described', () => {
  const page = loadPage();
  startInteract(page);
  enter(page, 'Salt bridge');
  const text = page.el('feedback').innerHTML;
  for (const other of ['Hydrogen bond', 'Hydrophobic', 'Pi stacking', 'Disulfide bond', 'Charge repulsion']) {
    assert.ok(!text.includes(other), other);
  }
  assert.doesNotMatch(text, /Needs|✗/);
});

test('a wrong first answer gives a second chance with the structures, and keeps the answer back', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startInteract(page);
  enter(page, 'Hydrophobic');
  const text = page.el('feedback').innerHTML;
  assert.match(text, /Try once more/);
  assert.match(text, /<b>Hydrophobic<\/b> is not correct/);
  assert.doesNotMatch(text, /Salt bridge|interact-answer/, 'the answer stays hidden');
  assert.equal(page.el('pair-note-a').textContent, '', 'descriptions would give it away');
  assert.equal(structuresShown(page), true);
  const used = option(page, 'Hydrophobic');
  assert.ok(used.classList.contains('opt-wrong'));
  assert.equal(used.dataset.mark, '✗');
  assert.equal(used.disabled, true, 'the used choice cannot be picked again');
  assert.equal(page.qa('.interact-opt').filter(b => !b.disabled).length, 5);
  assert.equal(option(page, 'Salt bridge').dataset.mark, undefined, 'the answer is not marked yet');
  assert.equal(makeElement.focused, option(page, 'Hydrogen bond'), 'keyboard focus moves to the first open choice');
  assert.equal(page.run('answered'), false);
  assert.equal(page.run('score.total'), 0);
  assert.deepEqual(counts(page, 'Interactions'), [0, 0]);

  enter(page, 'Hydrophobic');
  assert.equal(page.run('answered'), false, 'clicking a used choice is not a second try');
  assert.equal(page.run('interactTried.length'), 1);
});

test('a right second answer earns the point', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startInteract(page);
  enter(page, 'Hydrophobic');
  enter(page, 'Salt bridge');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
  assert.deepEqual(counts(page, 'Interactions'), [1, 0]);
  assert.match(page.el('feedback').innerHTML, /Correct interaction: Salt bridge/);
  assert.ok(option(page, 'Salt bridge').classList.contains('opt-correct'));
  assert.ok(option(page, 'Hydrophobic').classList.contains('opt-wrong'), 'the first try stays marked');
});

test('a wrong second answer shows the answer and scores zero', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startInteract(page);
  enter(page, 'Hydrophobic');
  enter(page, 'Hydrogen bond');
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.deepEqual(counts(page, 'Interactions'), [0, 1]);
  assert.equal(page.el('feedback').className, 'feedback show wrong');
  assert.match(page.el('feedback').innerHTML, /Correct interaction: Salt bridge/);
  assert.ok(option(page, 'Hydrogen bond').classList.contains('opt-wrong'));
  assert.ok(option(page, 'Hydrophobic').classList.contains('opt-wrong'));
  assert.ok(option(page, 'Salt bridge').classList.contains('opt-answer'));
  assert.equal(option(page, 'Salt bridge').dataset.mark, '✓ answer');
  assert.ok(page.qa('.interact-opt').every(b => b.disabled));
});

test('the hydrogen bond does not stand in for a salt bridge', () => {
  const page = loadPage();
  startInteract(page);
  enter(page, 'Hydrogen bond');
  assert.match(page.el('feedback').innerHTML, /Try once more/);
});

test('when two interactions form, either one is right and both are explained', () => {
  for (const choice of ['Hydrophobic', 'Pi stacking']) {
    const page = loadPage();
    startInteract(page, 'F', 'W');
    enter(page, choice);
    assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%'], choice);
    const text = page.el('feedback').innerHTML;
    assert.match(text, /Correct interactions: Hydrophobic, Pi stacking/);
    assert.match(text, /<b>Hydrophobic:<\/b>/);
    assert.match(text, /<b>Pi stacking:<\/b>/);
    const other = choice === 'Hydrophobic' ? 'Pi stacking' : 'Hydrophobic';
    assert.ok(option(page, choice).classList.contains('opt-correct'));
    assert.equal(option(page, other).dataset.mark, '✓ also correct');
  }
});

test('Show random pair is centered', () => {
  assert.match(MARKUP, /<div style="text-align:center">\s*<button [^>]*id="explore-random"/);
});

test('side-chain descriptions appear under each structure once the question ends', () => {
  const page = loadPage();
  startInteract(page, 'D', 'K', 'c1');
  enter(page, 'Hydrophobic');
  assert.equal(page.el('pair-name-a').textContent, 'D', 'the name type holds during the second chance');
  enter(page, 'Salt bridge');
  assert.equal(page.el('pair-name-a').textContent, 'Aspartate (Asp)');
  assert.equal(page.el('pair-name-b').textContent, 'Lysine (Lys)');
  assert.equal(page.el('pair-note-a').textContent, 'Side chain: carboxylate COO⁻, negative, can only accept hydrogen bonds.');
  assert.equal(page.el('pair-note-b').textContent, 'Side chain: ammonium NH₃⁺, positive, can only donate hydrogen bonds.');
  assert.doesNotMatch(page.el('feedback').innerHTML, /Side chain:/, 'no longer stacked in the feedback');
});

test('the disulfide explanation states its conditions', () => {
  const page = loadPage();
  startInteract(page, 'C', 'C');
  page.run('showAnswers()');
  assert.match(page.el('feedback').innerHTML, /<b>Disulfide bond:<\/b>[^<]*oxidizing conditions/);
});

test('Show Answer reveals the structures and answer, and scores zero', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startInteract(page);
  page.run('showAnswers()');
  assert.equal(structuresShown(page), true);
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.deepEqual(counts(page, 'Interactions'), [0, 1]);
  assert.match(page.el('feedback').innerHTML, /Correct interaction: Salt bridge/);
  assert.equal(page.el('interact-btn-show').disabled, true);
});

test('returning to a finished pair reopens it without scoring it again', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startInteract(page);
  page.run('showAnswers()');
  page.run(`setDisplayMode('structure'); setDisplayMode('interact')`);
  assert.equal(page.run('answered'), false);
  assert.ok(page.qa('.interact-opt').every(b => !b.disabled && b.className === 'name-type-btn interact-opt'), 'marks are cleared');
  assert.equal(structuresShown(page), false, 'hidden again');
  assert.equal(page.el('feedback').innerHTML, '');
  enter(page, 'Salt bridge');
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.deepEqual(counts(page, 'Interactions'), [0, 1]);
  assert.match(page.el('feedback').innerHTML, /already scored/);
});

test('finishing a single amino acid question does not stop a pair from scoring', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run('showAnswers()');
  startInteract(page);
  enter(page, 'Salt bridge');
  assert.deepEqual(scoreboard(page), ['2', '1', '0', '50%']);
  page.run(`setDisplayMode('structure')`);
  assert.equal(page.run('current.aa.code1'), 'A', 'the single amino acid question is untouched');
});

test('every interaction comes up, and every question has an answer', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact')`);
  page.json('INTERACTIONS').forEach(([outcome], i) => {
    // The first random call picks the interaction; later ones pick a pair and an order
    page.run(`(() => { let first = true; Math.random = () => { if (first) { first = false; return ${(i + 0.5) / 6}; } return 0.3; }; })()`);
    page.run('interactQuestion = null; nextQuestion()');
    const { a, b } = page.json('interactQuestion');
    assert.ok(interactionsOf(page, a, b).includes(outcome), `${outcome}: ${a}-${b}`);
  });
  page.run('Math.random = Object.getPrototypeOf(Math).random || Math.random');
});

test('Next Pair changes only the pair, always asks at pH 7, and never repeats a pair', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact')`);
  const single = page.run('current');
  const key = () => { const q = page.json('interactQuestion'); return [q.a, q.b].sort().join(''); };
  let previous = key();
  for (let i = 0; i < 60; i++) {
    page.run('showAnswers(); nextQuestion()');
    const { a, b } = page.json('interactQuestion');
    assert.notEqual(key(), previous, `question ${i}`);
    assert.ok(interactionsOf(page, a, b).length > 0, `${a}-${b} has an answer`);
    assert.match(page.el('interact-prompt').innerHTML, /\(pH 7\)/);
    assert.equal(page.run('answered'), false);
    previous = key();
  }
  assert.equal(page.run('current'), single);
  assert.equal(page.el('s-total').textContent, 60);
});

test('Explore shows both structures with a description below each, without scoring', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact'); setInteractActivity('explore')`);
  assert.equal(page.el('interact-quiz').style.display, 'none');
  assert.equal(page.el('explore-controls').style.display, '');
  assert.equal(page.el('inp-pairA').value, 'Aspartate');
  assert.equal(page.el('inp-pairB').value, 'Lysine');
  assert.equal(structuresShown(page), true, 'nothing to wait for here');
  assert.ok(page.el('pair-struct-a').innerHTML.includes(page.run(`aaByCode('D').smiles[7]`)));
  assert.equal(page.el('pair-note-a').textContent, 'Side chain: carboxylate COO⁻, negative, can only accept hydrogen bonds.');
  assert.match(page.el('explore-results').innerHTML, /interact-answer">Correct interaction: Salt bridge</);
  assert.doesNotMatch(page.el('explore-results').innerHTML, /Hydrophobic|Needs|Side chain:/);
  assert.equal(page.el('s-total').textContent, '', 'nothing is scored');
});

test('Explore has no pH buttons', () => {
  assert.doesNotMatch(HTML, /explore-ph|setExplorePH|data-explore-ph/);
  const controls = MARKUP.match(/id="explore-controls"[\s\S]*?id="interact-prompt"/)[0];
  assert.doesNotMatch(controls, /pH/);
});

test('Show random pair sits below the two names and picks a new pair with an interaction', () => {
  const controls = MARKUP.match(/id="explore-controls"[\s\S]*?id="interact-prompt"/)[0];
  assert.ok(controls.indexOf('inp-pairB') < controls.indexOf('Show random pair'));
  const page = loadPage();
  page.run(`setDisplayMode('interact'); setInteractActivity('explore')`);
  const pair = () => [page.run('explorePair.a'), page.run('explorePair.b')].sort().join('');
  let previous = pair();
  for (let i = 0; i < 40; i++) {
    page.run('showRandomExplorePair()');
    assert.notEqual(pair(), previous, `pair ${i}`);
    previous = pair();
    assert.match(page.el('explore-results').innerHTML, /Correct interaction/);
    assert.equal(page.el('inp-pairA').value, page.run(`aaByCode(explorePair.a).name`));
  }
  assert.equal(page.el('s-total').textContent, '');
});

test('a pair chosen in Explore with no interaction says so', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact'); setInteractActivity('explore')`);
  page.el('inp-pairA').value = 'Glycine';
  page.el('inp-pairA').fire('blur');
  const text = page.el('explore-results').innerHTML;
  assert.match(text, /interact-answer">No interaction</);
  assert.doesNotMatch(text, /Correct interaction/);
});

test('Explore pickers use the type-ahead lists and keep the choice valid', () => {
  const page = loadPage();
  page.run(`setDisplayMode('interact'); setInteractActivity('explore')`);
  const box = page.el('inp-pairA');
  box.value = 'cy';
  box.fire('input');
  assert.deepEqual(page.el('list-pairA').children.map(c => c.textContent), ['Cysteine']);
  page.el('list-pairA').children[0].fire('click');
  assert.equal(page.run('explorePair.a'), 'C');
  assert.equal(box.value, 'Cysteine');
  assert.match(page.el('interact-prompt').innerHTML, /<strong>Cys<\/strong>/);

  box.value = 'Glu';
  box.fire('blur');
  assert.equal(page.run('explorePair.a'), 'E', 'a typed code works');
  assert.equal(box.value, 'Glutamate');

  box.value = 'Aspartic acid';
  box.fire('keydown', { key: 'Enter' });
  assert.equal(page.run('explorePair.a'), 'D', 'so does an accepted alternate name');

  box.value = 'nonsense';
  box.fire('blur');
  assert.equal(page.run('explorePair.a'), 'D');
  assert.equal(box.value, 'Aspartate', 'an unknown entry goes back');
});

test('switching between Quiz and Explore keeps the quiz pair', () => {
  const page = loadPage();
  startInteract(page, 'F', 'W');
  page.run(`setInteractActivity('explore'); setInteractActivity('quiz')`);
  assert.equal(page.run('interactQuestion.a'), 'F');
  assert.match(page.el('interact-prompt').innerHTML, /Phe/);
  assert.equal(page.el('explore-results').style.display, 'none');
  assert.equal(structuresShown(page), false);
});

test('structures fill in when RDKit arrives without changing the second chance', () => {
  const page = loadPage({ rdkit: false });
  startInteract(page);
  page.loader.load();
  assert.equal(structuresShown(page), false, 'RDKit arriving does not reveal them');
  const late = loadPage({ rdkit: false });
  startInteract(late);
  enter(late, 'Hydrophobic');
  assert.match(late.el('pair-struct-a').innerHTML, /Loading/);
  late.loader.load();
  assert.ok(late.el('pair-struct-a').innerHTML.includes('<svg'));
  assert.equal(late.run('interactTried.length'), 1);
  assert.equal(late.run('interactQuestion.a'), 'D');
});

test('a failed RDKit load explains itself once structures are due, and the question still works', () => {
  const page = loadPage({ rdkit: false });
  startInteract(page);
  page.loader.fail();
  assert.equal(page.el('interact-unavailable').hidden, true, 'nothing to explain yet');
  enter(page, 'Salt bridge');
  assert.match(page.el('pair-struct-a').innerHTML, /Unavailable/);
  assert.equal(page.el('pair-struct-a').getAttribute('role'), null);
  assert.equal(page.el('interact-unavailable').hidden, false);
  assert.match(page.el('interact-unavailable').textContent, /failed to load/);
  assert.match(HTML, /#interact-unavailable\[hidden\] \{ display: none; \}/, '.struct-msg would otherwise override hidden');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
});

// ── Score breakdown ────────────────────────────────────────────
const breakdownRows = page => [...page.el('score-breakdown').innerHTML.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>(\d+)<\/td><td>(\d+)<\/td><\/tr>/g)]
  .map(m => [m[1], +m[2], +m[3]]);
const counts = (page, label) => breakdownRows(page).find(r => r[0] === label).slice(1);

test('the breakdown button sits beside Reset score and toggles a table', () => {
  assert.match(MARKUP, /class="score-links"[\s\S]*Reset score<\/button>\s*<button[^>]*id="breakdown-btn"[^>]*>Score breakdown</);
  const page = loadPage();
  const panel = page.el('score-breakdown');
  assert.equal(panel.style.display, 'none');
  assert.equal(page.el('breakdown-btn').getAttribute('aria-expanded'), 'false');

  page.run('toggleScoreBreakdown()');
  assert.equal(panel.style.display, '');
  assert.equal(page.el('breakdown-btn').getAttribute('aria-expanded'), 'true');
  assert.match(panel.innerHTML, /Correct Responses/);
  assert.match(panel.innerHTML, /Incorrect Responses/);
  assert.deepEqual(breakdownRows(page).map(r => r[0]),
    ['Structure', 'Name (1-letter)', 'Name (3-letter)', 'Name (full)', 'Property', 'pH', 'Interactions', 'Total']);
  assert.ok(breakdownRows(page).every(r => r[1] === 0 && r[2] === 0), 'starts empty');

  page.run('toggleScoreBreakdown()');
  assert.equal(panel.style.display, 'none');
});

test('each response counts toward its own row, and the open table stays current', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  page.run(`toggleQuestionType('properties'); toggleQuestionType('ph')`);

  ask(page, 'A', 7);  // right name, right property, revealed pH
  answer(page, 'c1', 'A');
  answer(page, 'type', 'nonpolar');
  page.run('showAnswers()');
  assert.deepEqual(counts(page, 'Name (1-letter)'), [1, 0]);
  assert.deepEqual(counts(page, 'Property'), [1, 0]);
  assert.deepEqual(counts(page, 'pH'), [0, 1]);

  pickNameType(page, 'name');
  ask(page, 'G', 1);  // all three revealed
  page.run('showAnswers()');
  assert.deepEqual(counts(page, 'Name (full)'), [0, 1]);
  assert.deepEqual(counts(page, 'Property'), [1, 1]);
  assert.deepEqual(counts(page, 'pH'), [0, 2]);
  assert.deepEqual(counts(page, 'Name (1-letter)'), [1, 0], 'other name types are untouched');
  assert.deepEqual(counts(page, 'Total'), [2, 4]);
});

test('structure questions count as correct only on a clean first pick', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  startIdentify(page);
  clickCorrect(page);
  assert.deepEqual(counts(page, 'Structure'), [1, 0]);
  ask(page, 'G', 7);
  clickWrong(page);
  assert.deepEqual(counts(page, 'Structure'), [1, 0], 'not counted until the question ends');
  clickCorrect(page);
  assert.deepEqual(counts(page, 'Structure'), [1, 1]);
  ask(page, 'V', 7);
  page.run('showAnswers()');
  assert.deepEqual(counts(page, 'Structure'), [1, 2]);
});

test('the breakdown always adds up to the score points', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  page.run(`toggleQuestionType('properties')`);
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  page.run('showAnswers()');
  ask(page, 'W', 13);
  answer(page, 'c1', 'x');
  answer(page, 'c1', 'W');
  answer(page, 'type', 'nonpolar');
  startIdentify(page, 'K', 1);
  clickWrong(page);
  clickCorrect(page);
  assert.deepEqual(counts(page, 'Total'), [page.run('score.pts'), page.run('score.maxPts') - page.run('score.pts')]);
});

test('a reopened question adds nothing to the breakdown', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  ask(page, 'A', 7);
  page.run('showAnswers()');
  pickNameType(page, 'c3');
  answer(page, 'c3', 'Ala');
  assert.deepEqual(counts(page, 'Total'), [0, 1]);
});

test('Reset score clears the breakdown', () => {
  const page = loadPage();
  page.run('toggleScoreBreakdown()');
  ask(page, 'A', 7);
  page.run('showAnswers()');
  assert.deepEqual(counts(page, 'Total'), [0, 1]);
  page.run('resetScore()');
  assert.deepEqual(counts(page, 'Total'), [0, 0]);
  assert.equal(page.el('score-breakdown').style.display, '', 'the table stays open');
});

test('every combination of settings leaves something to answer', () => {
  const page = loadPage();
  const types = ['name', 'ph', 'properties'];
  for (const nameType of ['random', 'c1', 'c3', 'name']) {
    pickNameType(page, nameType);
    for (let mask = 1; mask < 8; mask++) {
      page.run(`activeQtypeSet = new Set(${JSON.stringify(types.filter((_, i) => mask & (1 << i)))}); renderQuestion()`);
      assert.ok(page.json('getActiveFields()').length > 0, `name type ${nameType}, types ${mask}`);
    }
  }
});

// ── Name type ──────────────────────────────────────────────────
test('the name type row sits below the question types and needs "Determine name"', () => {
  assert.ok(MARKUP.indexOf('id="qtype-bar"') < MARKUP.indexOf('id="name-toggles"'));
  const page = loadPage();
  const row = page.el('name-toggles');
  assert.equal(row.style.display, '', 'on by default with Determine name');

  page.run(`toggleQuestionType('ph'); toggleQuestionType('name')`);
  assert.equal(row.style.display, 'none');
  assert.deepEqual(visibleFields(page), ['ph']);
  page.run(`toggleQuestionType('name')`);
  assert.equal(row.style.display, '');

  page.run(`toggleQuestionType('name'); setDisplayMode('identify')`);
  assert.equal(row.style.display, 'none');
  page.run(`setDisplayMode('name')`);
  assert.equal(row.style.display, 'none', 'name mode only offers it for Show Name');
  page.run(`setDisplayMode('structure')`);
  assert.equal(row.style.display, 'none', 'Determine name is still off');
});

test('the row is labeled Name Type and no button says Hide', () => {
  const row = MARKUP.match(/id="name-toggles"[\s\S]*?<\/div>/)[0];
  assert.match(row, />Name Type:</);
  assert.deepEqual([...row.matchAll(/>([^<>]+)<\/button>/g)].map(m => m[1]),
    ['Randomly select', '1-letter', '3-letter', 'Full name']);
  assert.doesNotMatch(MARKUP, /Hide/);
});

const selectedNameTypes = page => page.qa('.name-type-btn[data-field]').filter(b => b.classList.contains('active')).map(b => b.dataset.field);

test('in structure mode exactly one name type is selected and it is the one asked for', () => {
  const page = loadPage();
  assert.deepEqual(selectedNameTypes(page), ['random']);
  ask(page, 'A', 7);
  for (const type of ['c1', 'c3', 'name']) {
    pickNameType(page, type);
    assert.deepEqual(selectedNameTypes(page), [type]);
    assert.deepEqual(visibleFields(page), [type]);
    pickNameType(page, type);
    assert.deepEqual(selectedNameTypes(page), [type], 'clicking the selected type keeps it');
  }
  pickNameType(page, 'random');
  assert.deepEqual(selectedNameTypes(page), ['random']);
});

test('in name mode exactly one name type is selected and it is the one shown', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name'); setNameModeSource('name')`);
  assert.deepEqual(selectedNameTypes(page), ['random']);
  ask(page, 'W', 7);
  for (const [type, text] of [['c1', 'W'], ['c3', 'Trp'], ['name', 'Tryptophan']]) {
    pickNameType(page, type);
    assert.deepEqual(selectedNameTypes(page), [type]);
    assert.match(boxHTML(page), new RegExp(`name-display-main">${text}<`));
    for (const other of ['W', 'Trp', 'Tryptophan']) {
      if (other !== text) assert.doesNotMatch(boxHTML(page), new RegExp(`>${other}<`));
    }
    assert.deepEqual(visibleFields(page), ['type'], 'only the property is asked');
  }
});

test('Randomly select picks one name type per question and keeps it through re-renders', () => {
  const page = loadPage();
  for (const [r, type] of [[0, 'c1'], [0.5, 'c3'], [0.9, 'name']]) {
    setRandom(page, r);
    page.run('nextQuestion()');
    assert.deepEqual(visibleFields(page), [type], `structure mode at random=${r}`);
    setRandom(page, r === 0 ? 0.9 : 0);
    page.run(`toggleQuestionType('ph'); toggleQuestionType('ph')`);
    assert.deepEqual(visibleFields(page), [type], 'same question, same field');
  }

  page.run(`setDisplayMode('name'); setNameModeSource('name')`);
  for (const [r, text] of [[0, 'W'], [0.5, 'Trp'], [0.9, 'Tryptophan']]) {
    page.run(`current = { aa: AA.find(a => a.code1 === 'W'), ph: 7 }`);
    setRandom(page, r);
    page.run('renderQuestion()');
    assert.match(boxHTML(page), new RegExp(`>${text}<`), `name mode at random=${r}`);
    setRandom(page, r === 0 ? 0.9 : 0);
    page.run('renderQuestion()');
    assert.match(boxHTML(page), new RegExp(`>${text}<`), 'same question, same name');
  }
});

test('each section remembers its own name type', () => {
  const page = loadPage();
  pickNameType(page, 'c1');
  page.run(`setDisplayMode('name')`);
  assert.deepEqual(selectedNameTypes(page), ['random']);
  pickNameType(page, 'c3');
  page.run(`setDisplayMode('structure')`);
  assert.deepEqual(selectedNameTypes(page), ['c1']);
  page.run(`setDisplayMode('name')`);
  assert.deepEqual(selectedNameTypes(page), ['c3']);
});

test('the mode buttons have their new names', () => {
  const labels = [...MARKUP.matchAll(/id="mode-btn-(\w+)"[^>]*>([^<]+)<span class="mode-sub">([^<]+)<\/span>/g)]
    .map(m => [m[1], m[2].trim(), m[3]]);
  assert.deepEqual(labels, [
    ['identify', 'Determine Structure', '(From Name + pH)'],
    ['structure', 'Determine Properties', '(From Structure)'],
    ['name', 'Determine Property', '(From Name or Structure)'],
    ['interact', 'Determine Interactions', '(Between Two Amino Acids)'],
  ], 'Determine Structure comes first, with each parenthetical on its own line');
  assert.doesNotMatch(HTML, /Show Amino Acid/);
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /\.mode-sub\s*{[^}]*display: block;[^}]*font-size: 0\.75rem;[^}]*font-weight: 400;/);
});

// ── Display mode switching ─────────────────────────────────────
test('each mode shows its own panels and marks its own button', () => {
  const shown = id => id.style.display !== 'none';
  const expected = {
    structure: { grid: true, identify: false, qtype: true, source: false, toggles: true, identifyToggles: false, phBadge: true, structControls: false },
    name: { grid: true, identify: false, qtype: false, source: true, toggles: true, identifyToggles: false, phBadge: false, structControls: false },
    identify: { grid: false, identify: true, qtype: false, source: false, toggles: false, identifyToggles: true, phBadge: true, structControls: false },
  };
  const page = loadPage();
  page.run(`setNameModeSource('name')`);
  for (const mode of ['name', 'identify', 'structure']) {
    page.run(`setDisplayMode('${mode}')`);
    assert.deepEqual({
      grid: shown(page.q('.main-grid')),
      identify: shown(page.el('identify-panel')),
      qtype: shown(page.el('qtype-bar')),
      source: shown(page.el('source-bar')),
      toggles: shown(page.el('name-toggles')),
      identifyToggles: shown(page.el('identify-name-toggles')),
      phBadge: shown(page.el('ph-badge')),
      structControls: shown(page.el('name-struct-controls')),
    }, expected[mode], mode);
    for (const m of ['structure', 'name', 'identify']) {
      assert.equal(page.el('mode-btn-' + m).classList.contains('active'), m === mode, `${m} button in ${mode} mode`);
    }
  }
});

test('visiting name mode leaves the structure mode question types as they were', () => {
  const page = loadPage();
  page.run(`toggleQuestionType('ph')`);
  page.run(`setDisplayMode('name')`);
  assert.deepEqual(page.json('getActiveFields()'), ['type']);
  page.run(`setDisplayMode('structure')`);
  assert.deepEqual(page.json('[...activeQtypeSet]'), ['name', 'ph']);
  assert.ok(page.q('[data-type="name"]').classList.contains('active'));
  assert.equal(page.el('name-toggles').style.display, '');
});

test('switching mode starts the current question over', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  page.run(`setDisplayMode('name')`);
  assert.equal(page.el('inp-c1').value, '');
  assert.equal(page.run('current.aa.code1'), 'A');
});

// ── Name mode ──────────────────────────────────────────────────
test('name mode grades the property of the amino acid shown', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  ask(page, 'W', 7);
  answer(page, 'type', 'nonpolar');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
});

test('the question type replaces Determine properties with three single choices', () => {
  const bar = MARKUP.match(/id="source-bar"[\s\S]*?<\/div>/)[0];
  assert.match(bar, />Question type:</);
  assert.deepEqual([...bar.matchAll(/>([^<>]+)<\/button>/g)].map(m => m[1]), ['Randomly select', 'Show Name', 'Show Structure']);

  const page = loadPage();
  const selected = () => page.qa('[data-source]').filter(b => b.classList.contains('active')).map(b => b.dataset.source);
  page.run(`setDisplayMode('name')`);
  assert.equal(page.el('qtype-bar').style.display, 'none', 'Determine properties is gone from this section');
  assert.equal(page.el('source-bar').style.display, '');
  assert.deepEqual(selected(), ['random']);
  for (const source of ['name', 'structure', 'random']) {
    page.run(`setNameModeSource('${source}')`);
    assert.deepEqual(selected(), [source]);
    assert.deepEqual(visibleFields(page), ['type']);
  }
  page.run(`setDisplayMode('structure')`);
  assert.equal(page.el('source-bar').style.display, 'none');
  assert.equal(page.el('qtype-bar').style.display, '');
});

test('the name type options appear only for Show Name', () => {
  const page = loadPage();
  const row = page.el('name-toggles');
  page.run(`setDisplayMode('name')`);
  assert.equal(row.style.display, 'none', 'hidden for the default Randomly select');
  page.run(`setNameModeSource('name')`);
  assert.equal(row.style.display, '');
  page.run(`setNameModeSource('structure')`);
  assert.equal(row.style.display, 'none');
  page.run(`setNameModeSource('random')`);
  assert.equal(row.style.display, 'none');
});

test('Show Name shows only the name and Show Structure shows only the structure', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  ask(page, 'D', 7);
  page.run(`setNameModeSource('name'); setNameType('name')`);
  assert.match(boxHTML(page), />Aspartate</);
  assert.equal(page.el('name-struct-controls').style.display, 'none', 'no pH buttons with a name');

  page.run(`setNameModeSource('structure')`);
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[7]')));
  assert.doesNotMatch(boxHTML(page), /Aspartate/);
  assert.equal(page.el('name-struct-controls').style.display, '', 'pH buttons with a structure');
  answer(page, 'type', 'acidic');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
});

test('there is no Show structure button', () => {
  assert.doesNotMatch(HTML, /Show structure/);
  assert.doesNotMatch(HTML, /name-struct-toggle|toggleNameStructure/);
});

test('a structure question opens at its random pH and students can still switch', () => {
  const page = loadPage();
  const activePH = () => page.qa('.name-ph-btn').filter(b => b.classList.contains('active')).map(b => b.dataset.ph);
  page.run(`setDisplayMode('name'); setNameModeSource('structure')`);
  for (const ph of [1, 7, 13]) {
    ask(page, 'D', ph);
    assert.ok(boxHTML(page).includes(page.run(`current.aa.smiles[${ph}]`)), `opens at pH ${ph}`);
    assert.deepEqual(activePH(), [String(ph)]);
  }

  ask(page, 'D', 13);
  answer(page, 'type', 'polar');
  page.run('setNameStructPH(1)');
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[1]')));
  assert.deepEqual(activePH(), ['1']);
  assert.equal(page.el('inp-type').className, 'field-input bad', 'changing pH keeps the answer in progress');

  page.run(`current = { aa: AA[0], ph: 7 }; renderQuestion()`);
  assert.deepEqual(activePH(), ['7'], 'the next question uses its own pH');
});

test('the opening pH covers all three values across questions', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name'); setNameModeSource('structure')`);
  for (const [r, ph] of [[0, 1], [0.5, 7], [0.999, 13]]) {
    setRandom(page, r);
    page.run('nextQuestion()');
    assert.equal(page.run('nameStructPH'), ph, `random=${r}`);
    assert.ok(boxHTML(page).includes(page.run(`current.aa.smiles[${ph}]`)));
  }
});

test('Randomly select asks from a name or a structure per question and keeps it', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name'); setNameType('c3')`);
  for (const [r, source] of [[0.2, 'name'], [0.8, 'structure']]) {
    setRandom(page, r);
    page.run('nextQuestion()');
    assert.equal(page.run('current.randomSource'), source);
    const before = boxHTML(page);
    assert.equal(/<svg/.test(before), source === 'structure', `random=${r}`);
    setRandom(page, r === 0.2 ? 0.8 : 0.2);
    page.run('renderQuestion()');
    assert.equal(/<svg/.test(boxHTML(page)), source === 'structure', 'same question, same prompt');
  }
  // The name type row is hidden here, so the saved 3-letter choice does not apply
  page.run(`current = { aa: AA.find(a => a.code1 === 'W'), ph: 7, randomSource: 'name', randomNameType: 'name' }; renderQuestion()`);
  assert.match(boxHTML(page), />Tryptophan</);
  page.run(`setNameModeSource('name')`);
  assert.match(boxHTML(page), />Trp</, 'Show Name uses the saved choice');
});

// ── Identify mode: options ─────────────────────────────────────
test('every question offers 8 distinct options with one correct answer and a pH near miss', () => {
  const page = loadPage();
  for (let i = 0; i < 20; i++) {
    for (const ph of [1, 7, 13]) {
      for (let round = 0; round < 5; round++) {
        const opts = page.json(`buildIdentifyOptions(AA[${i}], ${ph}).map(o => ({ i: AA.indexOf(o.aa), ph: o.ph, isCorrect: o.isCorrect }))`);
        const where = `AA[${i}] at pH ${ph}`;
        assert.equal(opts.length, 8, where);
        assert.equal(new Set(opts.map(o => `${o.i}/${o.ph}`)).size, 8, `${where}: duplicate option`);

        const correct = opts.filter(o => o.isCorrect);
        assert.deepEqual(correct.map(o => [o.i, o.ph]), [[i, ph]], where);

        const sameAA = opts.filter(o => o.i === i && !o.isCorrect);
        assert.equal(sameAA.length, 1, `${where}: one wrong-pH copy of the target`);
        assert.notEqual(sameAA[0].ph, ph, where);

        const others = opts.filter(o => o.i !== i);
        assert.ok(others.filter(o => o.ph === ph).length >= 3, `${where}: at least 3 distractors share the target pH`);
        for (const o of opts) assert.ok([1, 7, 13].includes(o.ph), where);
      }
    }
  }
});

test('distractors favor the same side-chain type, up to the 3 available', () => {
  const page = loadPage();
  const sameTypeCount = code => page.run(`(() => {
    const target = AA.find(a => a.code1 === '${code}');
    return buildIdentifyOptions(target, 7).filter(o => o.aa !== target && o.aa.type === target.type).length;
  })()`);
  assert.equal(sameTypeCount('A'), 3, 'nonpolar has plenty');
  assert.equal(sameTypeCount('S'), 3, 'polar has plenty');
  assert.equal(sameTypeCount('K'), 2, 'only two other basic residues');
  assert.equal(sameTypeCount('D'), 1, 'only one other acidic residue');
});

// ── Identify mode: flow ────────────────────────────────────────
test('the question names the amino acid and draws a structure in each of 8 cells', () => {
  const page = loadPage();
  startIdentify(page, 'A', 13);
  page.run(`setIdentifyNameStyle('name')`);
  assert.equal(page.el('identify-aa-name').textContent, 'Alanine');
  assert.equal(page.el('identify-ph-badge').textContent, 'pH 13');
  const options = page.json('current.identifyOptions');
  assert.equal(cells(page).length, 8);
  cells(page).forEach((cell, i) => {
    assert.ok(cellHTML(cell).includes(`data-smiles="${options[i].aa.smiles[options[i].ph]}"`), `cell ${i}`);
  });
});

test('structure options are real buttons with labels that do not give away the answer', () => {
  const page = loadPage();
  startIdentify(page, 'A', 7);
  cells(page).forEach((cell, i) => {
    assert.equal(cell.tag, 'button');
    assert.equal(cell.type, 'button');
    assert.equal(cell.getAttribute('aria-label'), `Structure option ${i + 1}`);
  });

  const wrong = page.json('current.identifyOptions')[optionIndex(page, false)];
  clickWrong(page);
  const wrongCell = cells(page)[optionIndex(page, false)];
  assert.equal(wrongCell.getAttribute('aria-disabled'), null, 'it can be clicked again');
  assert.match(wrongCell.getAttribute('aria-label'), new RegExp(`incorrect, ${wrong.aa.code3} at pH ${wrong.ph}`));

  clickCorrect(page);
  assert.match(cells(page)[optionIndex(page, true)].getAttribute('aria-label'), /: correct$/);
});

test('the pH in the identify question is plain red text like the name, not a bubble', () => {
  const question = MARKUP.match(/class="identify-question"[\s\S]*?<\/p>/)[0];
  assert.match(question, /<strong id="identify-aa-name">/);
  assert.match(question, /<strong id="identify-ph-badge">/);
  assert.doesNotMatch(question, /class="ph-badge"/);
  assert.match(HTML, /\.identify-question strong \{ color: #C8102E; \}/);
});

test('re-clicking an eliminated choice explains it again without a new penalty', () => {
  const page = loadPage();
  startIdentify(page);
  const options = page.json('current.identifyOptions');
  const wrongs = options.map((o, i) => (o.isCorrect ? -1 : i)).filter(i => i >= 0);
  const [first, second] = wrongs;
  const explains = i => `<b>${options[i].aa.code3}</b> at pH <b>${options[i].ph}</b>`;

  cells(page)[first].onclick();
  cells(page)[second].onclick();
  assert.ok(page.el('feedback').innerHTML.includes(explains(second)));

  cells(page)[first].onclick();
  const fb = page.el('feedback');
  assert.ok(fb.innerHTML.includes(explains(first)), 'shows the earlier choice again');
  assert.equal(fb.className, 'feedback show wrong');
  assert.match(fb.innerHTML, /Incorrect/);
  assert.equal(cells(page)[first].children.length, 3, 'no duplicate marks');
  assert.equal(page.run('answered'), false, 'the question stays open');
  assert.equal(page.run('score.total'), 0);

  clickCorrect(page);
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.match(HTML, /\.identify-cell\.locked\.wrong \{ cursor: pointer; \}/);
});

test('exactly one name style is selected, starting with Randomly select first', () => {
  const page = loadPage();
  const buttons = page.qa('[data-style]');
  assert.deepEqual(buttons.map(b => b.dataset.style), ['random', 'c1', 'c3', 'name']);
  const selected = () => buttons.filter(b => b.classList.contains('active')).map(b => b.dataset.style);
  assert.deepEqual(selected(), ['random']);

  startIdentify(page, 'W', 7);
  for (const [style, text] of [['c1', 'W'], ['c3', 'Trp'], ['name', 'Tryptophan']]) {
    page.run(`setIdentifyNameStyle('${style}')`);
    assert.deepEqual(selected(), [style]);
    assert.equal(page.el('identify-aa-name').textContent, text);
    page.run(`setIdentifyNameStyle('${style}')`);
    assert.deepEqual(selected(), [style], 'clicking the selected style keeps it');
  }
});

test('Randomly select can name the amino acid each of the three ways', () => {
  const page = loadPage();
  startIdentify(page, 'W', 7);
  page.run(`setIdentifyNameStyle('random')`);
  for (const [r, text] of [[0, 'W'], [0.5, 'Trp'], [0.9, 'Tryptophan']]) {
    setRandom(page, r);
    page.run('renderQuestion()');
    assert.equal(page.el('identify-aa-name').textContent, text);
  }
});

test('a correct first pick earns the point and locks the grid', () => {
  const page = loadPage();
  startIdentify(page);
  clickCorrect(page);
  const cell = cells(page)[optionIndex(page, true)];
  assert.ok(cell.classList.contains('correct'));
  assert.equal(cell.children.at(-1).textContent, '✓');
  assert.ok(cells(page).every(c => c.classList.contains('locked') && c.classList.contains('post-answer')));
  assert.equal(page.el('identify-btn-show').disabled, true);
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
  assert.equal(page.el('feedback').className, 'feedback show all-correct');
});

test('a wrong pick is labeled, then the eventual correct pick earns nothing', () => {
  const page = loadPage();
  startIdentify(page);
  const wrong = page.json('current.identifyOptions')[optionIndex(page, false)];
  clickWrong(page);
  const cell = cells(page)[optionIndex(page, false)];
  assert.ok(cell.classList.contains('wrong') && cell.classList.contains('locked'));
  assert.deepEqual(cell.children.slice(1).map(c => c.textContent), ['✗', `${wrong.aa.code3} pH ${wrong.ph}`]);
  assert.equal(page.el('feedback').className, 'feedback show wrong');
  assert.equal(page.el('s-total').textContent, '', 'not scored until the question ends');

  clickWrong(page);
  assert.equal(cell.children.length, 3, 'clicking an eliminated cell again adds no marks');

  clickCorrect(page);
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.equal(page.el('feedback').className, 'feedback show wrong');
});

test('Show Answer reveals the correct cell and scores zero', () => {
  const page = loadPage();
  startIdentify(page);
  page.run('showAnswers()');
  const cell = cells(page)[optionIndex(page, true)];
  assert.ok(cell.classList.contains('revealed'));
  assert.equal(cell.children.at(-1).textContent, '✓');
  assert.equal(page.el('identify-btn-show').disabled, true);
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
});

test('after answering, clicking other cells identifies them without changing the score', () => {
  const page = loadPage();
  startIdentify(page);
  clickCorrect(page);
  const success = page.el('feedback').innerHTML;

  clickCorrect(page);
  assert.equal(page.el('feedback').innerHTML, success, 'the correct cell keeps its message');

  const wrong = page.json('current.identifyOptions')[optionIndex(page, false)];
  clickWrong(page);
  assert.ok(page.el('feedback').innerHTML.includes(`<b>${wrong.aa.code3}</b> at pH <b>${wrong.ph}</b>`));
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
  assert.ok(!cells(page)[optionIndex(page, false)].classList.contains('wrong'));
});

test('a new identify question clears the penalty and rebuilds the grid', () => {
  const page = loadPage();
  startIdentify(page);
  clickWrong(page);
  page.run('nextQuestion()');
  assert.equal(page.run('!!current.hadWrong'), false);
  assert.equal(page.el('identify-btn-show').disabled, false);
  assert.equal(page.el('feedback').className, 'feedback');
  assert.equal(cells(page).length, 8);
  assert.ok(cells(page).every(c => c.className === 'identify-cell'));
  clickCorrect(page);
  assert.equal(page.el('s-correct').textContent, 1);
});

test('leaving identify mode and coming back does not clear the penalty for a wrong pick', () => {
  const page = loadPage();
  startIdentify(page);
  clickWrong(page);
  page.run(`setDisplayMode('structure'); setDisplayMode('identify')`);
  clickCorrect(page);
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
});

// ── Structure rendering and RDKit ──────────────────────────────
test('structure mode draws the SMILES for the current amino acid and pH', () => {
  const page = loadPage();
  ask(page, 'E', 1);
  assert.ok(boxHTML(page).includes(`data-smiles="${page.run('AA.find(a => a.code1 === "E").smiles[1]')}"`));
});

test('drawn SVGs get a transparent background and free their molecule', () => {
  const page = loadPage();
  const deleted = page.log.deleted;
  ask(page, 'A', 7);
  assert.match(boxHTML(page), /fill:transparent/);
  assert.doesNotMatch(boxHTML(page), /fill:#FFFFFF/);
  assert.equal(page.log.deleted, deleted + 1);
});

test('drawing falls back to plain SVG, then to a message', () => {
  const page = loadPage();
  page.log.failHighlights = true;
  ask(page, 'A', 7);
  assert.match(boxHTML(page), /data-plain="1"/);
  page.run(`drawStructure('invalid')`);
  assert.match(boxHTML(page), /Unavailable/);
});

test('a structure requested before RDKit loads is drawn once it arrives', () => {
  const page = loadPage({ rdkit: false });
  ask(page, 'A', 7);
  assert.match(boxHTML(page), /Loading structure renderer/);
  assert.equal(page.run('rdkitReady'), false);
  page.loader.load();
  assert.equal(page.run('rdkitReady'), true);
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[7]')));
  assert.equal(page.run('pendingSmiles'), null);
  assert.equal(page.el('struct-msg').style.display, 'none');
});

test('only the latest structure requested before RDKit loads is drawn', () => {
  const page = loadPage({ rdkit: false });
  ask(page, 'A', 7);
  ask(page, 'G', 1);
  page.loader.load();
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[1]')));
});

test('RDKit arriving in name mode does not replace the names with a stale structure', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name'); setNameModeSource('name'); setNameType('name')`);
  ask(page, 'A', 7);
  assert.match(boxHTML(page), /Alanine/);
  page.loader.load();
  assert.match(boxHTML(page), /Alanine/);
  assert.equal(page.run('pendingSmiles'), null);
});

test('a Show Structure question asked before RDKit loads is drawn once it arrives', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name'); setNameModeSource('structure')`);
  ask(page, 'A', 7);
  page.loader.load();
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[7]')));
});

test('switching to Show Name before RDKit loads keeps the name on screen', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name'); setNameModeSource('structure')`);
  ask(page, 'A', 7);
  page.run(`setNameModeSource('name'); setNameType('name')`);
  page.loader.load();
  assert.match(boxHTML(page), /Alanine/);
});

test('RDKit arriving in identify mode redraws the placeholder cells', () => {
  const page = loadPage({ rdkit: false });
  startIdentify(page);
  assert.ok(cells(page).every(c => /Loading/.test(cellHTML(c))));
  page.loader.load();
  assert.equal(cells(page).length, 8);
  assert.ok(cells(page).every(c => cellHTML(c).includes('<svg')));
});

test('RDKit arriving in identify mode keeps the options, the picks and the penalty', () => {
  const page = loadPage({ rdkit: false });
  startIdentify(page);
  const options = JSON.stringify(page.json('current.identifyOptions'));
  clickWrong(page);
  const wrongCell = cells(page)[optionIndex(page, false)];
  page.loader.load();

  assert.equal(JSON.stringify(page.json('current.identifyOptions')), options);
  assert.equal(cells(page)[optionIndex(page, false)], wrongCell);
  assert.ok(wrongCell.classList.contains('wrong'));
  assert.equal(wrongCell.children.at(-2).textContent, '✗');
  assert.ok(cellHTML(wrongCell).includes('<svg'));
  clickCorrect(page);
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
});

test('RDKit arriving after Show Answer does not reopen the question', () => {
  const page = loadPage({ rdkit: false });
  startIdentify(page);
  page.run('showAnswers()');
  page.loader.load();
  assert.equal(page.run('answered'), true);
  assert.ok(cells(page)[optionIndex(page, true)].classList.contains('revealed'));
  assert.equal(page.el('s-total').textContent, 1);
});

test('a failed RDKit load says so', () => {
  const page = loadPage({ rdkit: false });
  page.loader.fail();
  assert.match(boxHTML(page), /failed to load/);
  assert.equal(page.el('struct-box').getAttribute('role'), null, 'the message stays readable');
});

test('the failure message stays through later questions instead of going back to Loading', () => {
  const page = loadPage({ rdkit: false });
  page.loader.fail();
  page.run('nextQuestion()');
  assert.match(boxHTML(page), /failed to load/);
  assert.doesNotMatch(boxHTML(page), /Loading/);
  page.run(`setDisplayMode('name'); setDisplayMode('structure')`);
  assert.match(boxHTML(page), /failed to load/);
});

test('a failed load leaves name mode usable', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name'); setNameModeSource('name'); setNameType('name')`);
  ask(page, 'A', 7);
  answer(page, 'type', 'polar');
  page.loader.fail();
  assert.match(boxHTML(page), /Alanine/, 'the names are not replaced');
  assert.equal(page.el('inp-type').className, 'field-input bad', 'work in progress is kept');

  page.run(`setNameModeSource('structure')`);
  assert.match(boxHTML(page), /failed to load/);
  page.run('setNameStructPH(13)');
  assert.match(boxHTML(page), /failed to load/);
  page.run(`setNameModeSource('name')`);
  assert.match(boxHTML(page), /Alanine/);
});

test('after a failed load, Randomly select only asks from names', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name')`);
  page.run(`current = { aa: AA.find(a => a.code1 === 'A'), ph: 7, randomSource: 'structure', randomNameType: 'name' }; renderQuestion()`);
  assert.match(boxHTML(page), /Loading/);
  page.loader.fail();
  assert.match(boxHTML(page), /Alanine/, 'the waiting structure question becomes a name question');
  assert.equal(page.el('name-struct-controls').style.display, 'none');
  for (let i = 0; i < 20; i++) {
    page.run('nextQuestion()');
    assert.match(boxHTML(page), /name-display/);
  }
});

test('a failed load in identify mode explains itself and scores nothing', () => {
  const page = loadPage({ rdkit: false });
  startIdentify(page);
  assert.ok(cells(page).every(c => /Loading/.test(cellHTML(c))));
  page.loader.fail();
  const unavailable = () => {
    assert.ok(cells(page).every(c => /Unavailable/.test(cellHTML(c)) && c.disabled));
    assert.equal(page.el('identify-btn-show').disabled, true);
    assert.match(page.el('feedback').innerHTML, /failed to load/);
  };
  unavailable();
  page.run('nextQuestion()');
  unavailable();
  page.run(`setDisplayMode('structure'); setDisplayMode('identify')`);
  unavailable();
  assert.equal(page.run('score.total'), 0);
});

test('a failed load does not disturb an identify question already finished', () => {
  const page = loadPage({ rdkit: false });
  startIdentify(page);
  page.run('showAnswers()');
  const finished = page.el('feedback').innerHTML;
  page.loader.fail();
  assert.equal(page.el('feedback').innerHTML, finished);
  assert.equal(page.el('s-total').textContent, 1);
});

test('the page still works when the RDKit script itself never loaded', async () => {
  const page = loadPage({ rdkit: 'missing' });
  assert.ok(page.run('current'), 'the first question was generated');
  await new Promise(setImmediate);
  assert.match(boxHTML(page), /failed to load/);

  page.run(`setDisplayMode('name'); setNameModeSource('name'); setNameType('name')`);
  ask(page, 'A', 7);
  assert.match(boxHTML(page), /Alanine/);
  answer(page, 'type', 'nonpolar');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
});

test('RDKit is pinned to one exact version for both the script and its wasm', () => {
  const urls = [...HTML.matchAll(/https:\/\/unpkg\.com\/@rdkit\/rdkit([^/]*)\/dist\//g)].map(m => m[1]);
  assert.equal(urls.length, 2);
  for (const version of urls) assert.match(version, /^@\d+\.\d+\.\d+$/);
  assert.equal(urls[0], urls[1]);
});

// ── Accessibility and design standards ─────────────────────────
test('every answer field has a real label', () => {
  for (const id of FIELDS) assert.match(MARKUP, new RegExp(`<label [^>]*for="inp-${id}"`), id);
});

test('toggle buttons report their state, in the markup and after every change', () => {
  const inSync = page => {
    for (const selector of ['.mode-btn', '.qtype-btn', '.name-type-btn', '.name-ph-btn']) {
      for (const b of page.qa(selector)) {
        assert.equal(b.getAttribute('aria-pressed'), String(b.classList.contains('active')), `${selector} ${b.id ?? JSON.stringify(b.dataset)}`);
      }
    }
  };
  const page = loadPage();
  inSync(page);
  for (const action of [
    `toggleQuestionType('ph')`, `setNameType('c1')`, `setDisplayMode('name')`,
    `setNameType('c3')`, `setNameModeSource('name')`, `setNameModeSource('structure')`, 'setNameStructPH(13)', 'nextQuestion()',
    `setDisplayMode('identify')`, `setIdentifyNameStyle('c1')`, `setDisplayMode('structure')`,
    `toggleQuestionType('name')`, `setNameType('c3')`, `setNameType('random')`,
  ]) {
    page.run(action);
    inSync(page);
  }
});

test('every click target in the markup can take keyboard focus', () => {
  for (const m of MARKUP.matchAll(/<(\w+)[^>]*\bonclick=/g)) assert.equal(m[1], 'button');
});

test('feedback and option groups are announced', () => {
  assert.match(MARKUP, /id="feedback"[^>]*aria-live="polite"/);
  for (const id of ['qtype-bar', 'name-toggles', 'identify-name-toggles', 'identify-grid']) {
    assert.match(MARKUP, new RegExp(`id="${id}"[^>]*role="group"[^>]*aria-label=`), id);
  }
});

test('the drawing has a label that never names the amino acid', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  const box = page.el('struct-box');
  assert.equal(box.getAttribute('role'), 'img');
  assert.equal(box.getAttribute('aria-label'), 'Amino acid structure');
  page.run(`drawStructure('invalid')`);
  assert.equal(box.getAttribute('role'), null, 'a failure message must stay readable');
  page.run(`setDisplayMode('name')`);
  assert.equal(box.getAttribute('role'), null, 'names are read as text');
});

test('focus stays visible on every control', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /outline:\s*(none|0)/);
  assert.match(css, /button:focus-visible, input:focus-visible, select:focus-visible\s*{\s*outline: 3px solid/);
});

test('unselected option buttons are grayed out but stay readable', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const selector of ['mode-btn', 'qtype-btn', 'name-type-btn', 'name-ph-btn']) {
    const rule = css.match(new RegExp(`\\.${selector}\\s*{([^}]*)}`))[1];
    assert.match(rule, /background: #DEDEDE;/, selector);
    assert.match(rule, /color: #555555;/, selector);  // 5.54:1 on the gray fill
    assert.match(css, new RegExp(`\\.${selector}\\.active\\s*{[^}]*color: #(C8102E|FFFFFF);`), `${selector} when selected`);
  }
});

test('correct and incorrect choices look different', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  const background = selector => css.match(new RegExp(`${selector}\\s*{[^}]*background:\\s*(#[0-9a-fA-F]{6})`))[1];
  assert.notEqual(background('\\.identify-cell\\.correct'), background('\\.identify-cell\\.wrong'));
  assert.notEqual(background('\\.field-input\\.ok'), background('\\.field-input\\.bad'));
  assert.notEqual(background('\\.feedback\\.all-correct'), background('\\.feedback\\.wrong'));
});

test('sulfur is drawn dark enough to read against the structure backgrounds', () => {
  const page = loadPage();
  ask(page, 'M', 7);
  const srgb = page.log.options.atomColourPalette[16];
  const lum = c => { const [r, g, b] = c.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  // #DBEAFE is the darkest background a structure can sit on
  const ratio = (lum([0xDB / 255, 0xEA / 255, 0xFE / 255]) + 0.05) / (lum(srgb) + 0.05);
  assert.ok(ratio >= 4.5, `contrast is ${ratio.toFixed(2)}:1`);
});

test('the low pH is 1 everywhere and needs no explanatory note', () => {
  const page = loadPage();
  assert.doesNotMatch(HTML, /pH 2\b/);
  assert.doesNotMatch(HTML, /page-note/);
  assert.match(MARKUP, /data-ph="1"[^>]*onclick="setNameStructPH\(1\)">pH 1</);
  for (const a of page.json('AA')) assert.deepEqual(Object.keys(a.smiles).sort(), ['1', '13', '7'], a.name);
  for (let i = 0; i < 50; i++) assert.ok([1, 7, 13].includes(page.run('resolveCurrentPH()')));
});
