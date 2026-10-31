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
  for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5)] = v;
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
  };
  return el;
}

// Only the selector forms the page uses: .class and [attr] / [attr="value"], compounded
function matches(el, selector) {
  return selector.match(/\.[\w-]+|\[[^\]]+\]/g).every(part => {
    if (part[0] === '.') return el.classList.contains(part.slice(1));
    const [, name, value] = part.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
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

function loadPage({ rdkit = true } = {}) {
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
const ask = (page, code, ph) => page.run(`current = { aa: AA.find(a => a.code1 === '${code}'), ph: ${ph} }; renderQuestion()`);
const answer = (page, id, value) => {
  page.el('inp-' + id).value = value;
  page.el('inp-' + id).fire(id === 'type' || id === 'ph' ? 'change' : 'blur');
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
test('loads in structure mode with a question ready and only the name fields shown', () => {
  const page = loadPage();
  assert.equal(page.run('displayMode'), 'structure');
  assert.ok(page.run('current'), 'first question was generated');
  assert.deepEqual(visibleFields(page), ['c1', 'c3', 'name']);
  assert.equal(page.el('ph-badge').textContent, `pH ${page.run('current.ph')}`);
  assert.equal(page.document.getElementById('inp-c1'), makeElement.focused);
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
  assert.deepEqual(options('inp-type').sort(), page.json('Object.keys(TYPE_LABELS)').sort());
  assert.deepEqual(options('inp-ph'), ['2', '7', '13']);
});

// ── Amino acid database ────────────────────────────────────────
// code1, code3, name, type, net charge at pH 2 / 7 / 13
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
    assert.deepEqual([2, 7, 13].map(ph => netCharge(smiles[ph])), [q2, q7, q13], name);
  }
});

test('all 60 SMILES are distinct, so no two options in a question can look identical', () => {
  const all = loadPage().json('AA').flatMap(a => [a.smiles[2], a.smiles[7], a.smiles[13]]);
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
    for (const ph of [2, 7, 13]) {
      const tags = [...a.smiles[ph].matchAll(/\[C(@@?)H\]/g)].map(m => m[1]);
      if (tags.join() !== (expected[a.code1] ?? ['@@']).join()) wrong.push(`${a.name} pH ${ph}: ${a.smiles[ph]}`);
    }
  }
  assert.deepEqual(wrong, []);
});

// ── Question generation ────────────────────────────────────────
test('nextQuestion can reach all three pH values', () => {
  const page = loadPage();
  for (const [r, ph] of [[0, 2], [0.5, 7], [0.999, 13]]) {
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
test('getActiveFields follows the mode, question types and hide flags', () => {
  const cases = [
    ['structure', [], ['c1', 'c3', 'name']],
    ['structure', [`toggleQuestionType('ph')`], ['c1', 'c3', 'name', 'ph']],
    ['structure', [`toggleQuestionType('properties')`, `toggleQuestionType('name')`], ['type']],
    ['structure', [`toggleNameHide('c1')`], ['c3', 'name']],
    ['name', [], ['type']],
    ['name', [`toggleNameHide('c1')`], ['c1', 'type']],
    ['name', [`toggleNameHide('name')`, `toggleNameHide('c3')`], ['c3', 'name', 'type']],
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
    ask(page, 'A', 7);
    answer(page, 'c1', c1);
    answer(page, 'c3', c3);
    answer(page, 'name', name);
    assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%'], `${c1}/${c3}/${name}`);
  }
});

test('Aspartic acid and Glutamic acid are accepted as full names', () => {
  for (const [code, code3, names] of [['D', 'Asp', ['Aspartate', 'aspartic acid', ' Aspartic  Acid ']], ['E', 'Glu', ['Glutamate', 'glutamic acid']]]) {
    for (const name of names) {
      const page = loadPage();
      ask(page, code, 7);
      answer(page, 'name', name);
      assert.equal(page.el('inp-name').className, 'field-input ok', name);
      answer(page, 'c3', code3);
      assert.equal(page.el('inp-c3').className, 'field-input ok');
    }
  }
  const page = loadPage();
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
  answer(page, 'c3', 'Gly');
  page.run('showAnswers()');
  assert.equal(page.el('inp-c3').getAttribute('aria-invalid'), null);
});

test('a correct field locks with a check mark', () => {
  const page = loadPage();
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
  const page = loadPage();
  page.run(`toggleQuestionType('properties'); toggleQuestionType('ph')`);
  let done = 0;
  for (const [code1, code3, name, type] of EXPECTED) {
    for (const ph of [2, 7, 13]) {
      ask(page, code1, ph);
      answer(page, 'c1', code1);
      answer(page, 'c3', code3);
      answer(page, 'name', name);
      answer(page, 'type', type);
      answer(page, 'ph', String(ph));
      done++;
      assert.equal(page.el('s-correct').textContent, done, `${name} at pH ${ph}`);
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
  ask(page, 'W', 7);
  answer(page, 'c1', 'W');
  answer(page, 'c3', 'Phe');
  page.run('showAnswers()');
  assert.equal(page.el('inp-c3').value, 'Trp');
  assert.equal(page.el('inp-name').value, 'Tryptophan');
  for (const id of ['c1', 'c3', 'name']) assert.equal(page.el('inp-' + id).disabled, true, id);
  assert.deepEqual(scoreboard(page), ['1', '0', '1', '33%']);
  assert.equal(page.el('feedback').className, 'feedback show partial');
  assert.match(page.el('feedback').innerHTML, /1\/3 correct\./);
  for (const text of ['Trp', 'Tryptophan', 'Nonpolar', 'pH 7']) assert.ok(page.el('feedback').innerHTML.includes(text), text);
});

test('Show Answers with nothing right scores zero', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run('showAnswers()');
  assert.deepEqual(scoreboard(page), ['1', '0', '0', '0%']);
  assert.equal(page.el('feedback').className, 'feedback show wrong');
  assert.match(page.el('feedback').innerHTML, /0\/3 correct\./);
});

test('finishing every field reports a perfect score without Show Answers', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  answer(page, 'c1', 'A');
  answer(page, 'c3', 'Ala');
  answer(page, 'name', 'Alanine');
  assert.equal(page.el('feedback').className, 'feedback show all-correct');
  assert.match(page.el('feedback').innerHTML, /Perfect! All 3 correct\./);
  assert.equal(page.el('btn-check').disabled, true);
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
    `toggleNameHide('c1')`,
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
  page.run(`toggleNameHide('c1')`);
  ask(page, 'G', 7);
  answer(page, 'c3', 'Gly');
  answer(page, 'name', 'Glycine');
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

test('a question with no answer fields is never scored as perfect', () => {
  const page = loadPage();
  ask(page, 'A', 7);
  page.run(`toggleNameHide('c1'); toggleNameHide('c3'); toggleNameHide('name')`);
  assert.deepEqual(visibleFields(page), []);
  assert.equal(page.el('btn-check').disabled, true);
  assert.match(page.el('feedback').innerHTML, /Nothing to answer/);
  page.run('showAnswers()');
  assert.equal(page.run('score.total'), 0);
  assert.equal(page.run('score.correct'), 0);
  assert.equal(page.run('answered'), false);
  assert.doesNotMatch(page.el('feedback').innerHTML, /Perfect/);

  page.run(`toggleNameHide('c1')`);
  assert.equal(page.el('btn-check').disabled, false, 'restoring a field restores the question');
  assert.equal(page.el('feedback').innerHTML, '');
});

// ── Display mode switching ─────────────────────────────────────
test('each mode shows its own panels and marks its own button', () => {
  const shown = id => id.style.display !== 'none';
  const expected = {
    structure: { grid: true, identify: false, qtype: true, toggles: true, identifyToggles: false, random: false, phBadge: true, structControls: false },
    name: { grid: true, identify: false, qtype: true, toggles: true, identifyToggles: false, random: true, phBadge: false, structControls: true },
    identify: { grid: false, identify: true, qtype: false, toggles: false, identifyToggles: true, random: false, phBadge: true, structControls: false },
  };
  const page = loadPage();
  for (const mode of ['name', 'identify', 'structure']) {
    page.run(`setDisplayMode('${mode}')`);
    assert.deepEqual({
      grid: shown(page.q('.main-grid')),
      identify: shown(page.el('identify-panel')),
      qtype: shown(page.el('qtype-bar')),
      toggles: shown(page.el('name-toggles')),
      identifyToggles: shown(page.el('identify-name-toggles')),
      random: shown(page.el('name-random-btn')),
      phBadge: shown(page.el('ph-badge')),
      structControls: shown(page.el('name-struct-controls')),
    }, expected[mode], mode);
    for (const m of ['structure', 'name', 'identify']) {
      assert.equal(page.el('mode-btn-' + m).classList.contains('active'), m === mode, `${m} button in ${mode} mode`);
    }
  }
});

test('name mode drops the name and pH question types and falls back to properties', () => {
  const page = loadPage();
  page.run(`toggleQuestionType('ph')`);
  page.run(`setDisplayMode('name')`);
  assert.deepEqual(page.json('[...activeQtypeSet]'), ['properties']);
  assert.ok(page.q('[data-type="properties"]').classList.contains('active'));
  assert.equal(page.q('[data-type="name"]').style.display, 'none');
  assert.equal(page.q('[data-type="ph"]').style.display, 'none');
  page.run(`setDisplayMode('structure')`);
  assert.equal(page.q('[data-type="name"]').style.display, '');
  assert.equal(page.q('[data-type="ph"]').style.display, '');
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
test('name mode displays every field that is not hidden', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  ask(page, 'W', 7);
  assert.match(boxHTML(page), /name-display-main">Tryptophan</);
  assert.match(boxHTML(page), /<span>W<\/span>/);
  assert.match(boxHTML(page), /<span>Trp<\/span>/);

  page.run(`toggleNameHide('name')`);
  assert.ok(!boxHTML(page).includes('Tryptophan'));
  assert.ok(page.q('[data-field="name"]').classList.contains('active'));
  assert.deepEqual(visibleFields(page), ['name', 'type'], 'the hidden field becomes a question');

  page.run(`toggleNameHide('c1'); toggleNameHide('c3')`);
  assert.match(boxHTML(page), /All name fields hidden/);
});

test('name mode grades a hidden field against the amino acid', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  page.run(`toggleNameHide('c1')`);
  ask(page, 'W', 7);
  answer(page, 'c1', 'w');
  answer(page, 'type', 'nonpolar');
  assert.deepEqual(scoreboard(page), ['1', '1', '0', '100%']);
});

test('random display shows exactly one of the fields that are not hidden', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  ask(page, 'W', 7);
  const expected = [[0, 'W'], [0.5, 'Trp'], [0.9, 'Tryptophan']];
  page.run('toggleNameRandom()');
  assert.ok(page.el('name-random-btn').classList.contains('active'));
  for (const [r, text] of expected) {
    setRandom(page, r);
    page.run('renderQuestion()');
    for (const shown of ['W', 'Trp', 'Tryptophan']) {
      assert.equal(new RegExp(`>${shown}<`).test(boxHTML(page)), shown === text, `${shown} at random=${r}`);
    }
  }
  setRandom(page, 0);
  page.run(`toggleNameHide('c1')`);
  assert.match(boxHTML(page), />Trp</, 'a hidden field is never picked');
});

test('the structure toggle draws the pH 7 form and offers the other pH values', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  ask(page, 'D', 7);
  const smiles = ph => page.run(`current.aa.smiles[${ph}]`);

  page.run('toggleNameStructure()');
  assert.equal(page.el('name-struct-toggle').textContent, 'Show name');
  assert.equal(page.el('name-ph-btns').style.display, '');
  assert.ok(boxHTML(page).includes(smiles(7)));

  page.run('setNameStructPH(2)');
  assert.ok(boxHTML(page).includes(smiles(2)));
  assert.deepEqual(page.qa('.name-ph-btn').map(b => b.classList.contains('active')), [true, false, false]);

  page.run('toggleNameStructure()');
  assert.equal(page.el('name-struct-toggle').textContent, 'Show structure');
  assert.equal(page.el('name-ph-btns').style.display, 'none');
  assert.match(boxHTML(page), /Aspartate/);
});

test('a new question in name mode returns to the name at pH 7', () => {
  const page = loadPage();
  page.run(`setDisplayMode('name')`);
  page.run('toggleNameStructure(); setNameStructPH(13)');
  page.run('nextQuestion()');
  assert.equal(page.run('nameShowingStructure'), false);
  assert.equal(page.run('nameStructPH'), 7);
  assert.equal(page.el('name-struct-toggle').textContent, 'Show structure');
  assert.deepEqual(page.qa('.name-ph-btn').map(b => b.classList.contains('active')), [false, true, false]);
  assert.match(boxHTML(page), /name-display/);
});

// ── Identify mode: options ─────────────────────────────────────
test('every question offers 8 distinct options with one correct answer and a pH near miss', () => {
  const page = loadPage();
  for (let i = 0; i < 20; i++) {
    for (const ph of [2, 7, 13]) {
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
        for (const o of opts) assert.ok([2, 7, 13].includes(o.ph), where);
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
  page.run(`toggleIdentifyNameStyle('c1'); toggleIdentifyNameStyle('c3')`);
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
  assert.equal(wrongCell.getAttribute('aria-disabled'), 'true');
  assert.match(wrongCell.getAttribute('aria-label'), new RegExp(`incorrect, ${wrong.aa.code3} at pH ${wrong.ph}`));

  clickCorrect(page);
  assert.match(cells(page)[optionIndex(page, true)].getAttribute('aria-label'), /: correct$/);
  assert.equal(wrongCell.getAttribute('aria-disabled'), null, 'it can be explored again');
});

test('name style options set how the amino acid is named, and one always stays on', () => {
  const page = loadPage();
  startIdentify(page, 'W', 7);
  page.run(`toggleIdentifyNameStyle('name'); toggleIdentifyNameStyle('c3')`);
  assert.equal(page.el('identify-aa-name').textContent, 'W');
  page.run(`toggleIdentifyNameStyle('c1')`);
  assert.deepEqual(page.json('[...identifyNamePool]'), ['c1'], 'the last style cannot be turned off');
  assert.ok(page.q('[data-style="c1"]').classList.contains('active'));
  assert.ok(!page.q('[data-style="c3"]').classList.contains('active'));
  page.run(`toggleIdentifyNameStyle('c1'); toggleIdentifyNameStyle('c3'); toggleIdentifyNameStyle('c1')`);
  assert.equal(page.el('identify-aa-name').textContent, 'Trp');
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
  assert.equal(cell.children.length, 3, 'clicking an eliminated cell again does nothing');

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
  ask(page, 'E', 2);
  assert.ok(boxHTML(page).includes(`data-smiles="${page.run('AA.find(a => a.code1 === "E").smiles[2]')}"`));
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
  ask(page, 'G', 2);
  page.loader.load();
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[2]')));
});

test('RDKit arriving in name mode does not replace the names with a stale structure', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name')`);
  ask(page, 'A', 7);
  assert.match(boxHTML(page), /Alanine/);
  page.loader.load();
  assert.match(boxHTML(page), /Alanine/);
  assert.equal(page.run('pendingSmiles'), null);
});

test('a structure toggled on in name mode before RDKit loads is drawn once it arrives', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name')`);
  ask(page, 'A', 7);
  page.run('toggleNameStructure()');
  page.loader.load();
  assert.ok(boxHTML(page).includes(page.run('current.aa.smiles[7]')));
});

test('a structure toggled back off in name mode before RDKit loads is not drawn', () => {
  const page = loadPage({ rdkit: false });
  page.run(`setDisplayMode('name')`);
  ask(page, 'A', 7);
  page.run('toggleNameStructure(); toggleNameStructure()');
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
  page.run(`setDisplayMode('name')`);
  ask(page, 'A', 7);
  answer(page, 'type', 'polar');
  page.loader.fail();
  assert.match(boxHTML(page), /Alanine/, 'the names are not replaced');
  assert.equal(page.el('inp-type').className, 'field-input bad', 'work in progress is kept');

  page.run('toggleNameStructure()');
  assert.match(boxHTML(page), /failed to load/);
  page.run('setNameStructPH(13)');
  assert.match(boxHTML(page), /failed to load/);
  page.run('toggleNameStructure()');
  assert.match(boxHTML(page), /Alanine/);
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

  page.run(`setDisplayMode('name')`);
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
    for (const selector of ['.mode-btn', '.qtype-btn', '.name-hide-btn', '.name-ph-btn']) {
      for (const b of page.qa(selector)) {
        assert.equal(b.getAttribute('aria-pressed'), String(b.classList.contains('active')), `${selector} ${b.id ?? JSON.stringify(b.dataset)}`);
      }
    }
  };
  const page = loadPage();
  inSync(page);
  for (const action of [
    `toggleQuestionType('ph')`, `toggleNameHide('c1')`, `toggleNameHide('c1')`, `setDisplayMode('name')`,
    'toggleNameRandom()', 'toggleNameStructure()', 'setNameStructPH(13)', 'nextQuestion()',
    `setDisplayMode('identify')`, `toggleIdentifyNameStyle('c1')`, `setDisplayMode('structure')`,
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

test('the styles use only the University of Tampa palette', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  const palette = ['#D0012B', '#000000', '#FFFFFF', '#E6E0CC', '#282828', '#404040', '#828282', '#BFBFBF', '#F0F0F0'];
  for (const [color] of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) assert.ok(palette.includes(color.toUpperCase()), color);
  for (const [, rgb] of css.matchAll(/rgba?\((\d+,\d+,\d+)/g)) assert.ok(['0,0,0', '208,1,43'].includes(rgb), rgb);
});

test('sulfur is drawn dark enough to read against the structure backgrounds', () => {
  const page = loadPage();
  ask(page, 'M', 7);
  const srgb = page.log.options.atomColourPalette[16];
  const lum = c => { const [r, g, b] = c.map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  // #E6E0CC is the darker of the two backgrounds a structure can sit on
  const ratio = (lum([0xE6 / 255, 0xE0 / 255, 0xCC / 255]) + 0.05) / (lum(srgb) + 0.05);
  assert.ok(ratio >= 4.5, `contrast is ${ratio.toFixed(2)}:1`);
});

test('the pH 2 simplification is stated on the page', () => {
  assert.match(MARKUP, /class="page-note"[\s\S]*pH 2[\s\S]*pKa is about 2/);
});
