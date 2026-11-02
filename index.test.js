// Tests for index.html. No dependencies — run with: node --test
//
// The list of tools runs in a Node vm, and is checked against the files in this folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const SCRIPT = HTML.slice(HTML.indexOf('// ═══ EDIT HERE'), HTML.indexOf('// ═══ ICONS'));
const page = vm.createContext({});
vm.runInContext(SCRIPT, page);
const TOOLS = [...vm.runInContext('TOOLS', page)];
const TOPICS = [...vm.runInContext('TOPICS', page)];
const TOPIC_GROUPS = [...vm.runInContext('TOPIC_GROUPS', page)];
const LOGO_FILE = vm.runInContext('LOGO_FILE', page);
const LAST_UPDATED = vm.runInContext('LAST_UPDATED', page);

// An exact listing, since web hosts treat Buffers.html and buffers.html as different files.
const FILES = fs.readdirSync(__dirname);

test('every tool links to a file in this folder, with its name spelled exactly', () => {
  for (const tool of TOOLS) assert.ok(FILES.includes(tool.file), `${tool.title}: ${tool.file}`);
});

test('every link is a relative file name', () => {
  for (const tool of TOOLS) assert.match(tool.file, /^[\w.-]+\.html$/, tool.file);
});

test('no tool still has placeholder text', () => {
  for (const tool of TOOLS) {
    assert.ok(!/TODO|AMINO_ACID_FILE/.test(tool.file + tool.description), tool.title);
    assert.ok(tool.title && tool.description, tool.file);
  }
});

test('every tool belongs to a listed topic', () => {
  for (const tool of TOOLS) assert.ok(TOPICS.includes(tool.topic), `${tool.title}: ${tool.topic}`);
});

test('the topics are in the requested order', () => {
  assert.deepEqual(TOPICS, [
    'Acid-Base Chemistry', 'Amino Acids', 'Peptide Properties', 'Peptide Folding',
    'Protein Purification', 'Hemoglobin + Myoglobin', 'Enzymes', 'Enzyme Kinetics',
  ]);
});

test('the button rows have the requested headings and topics', () => {
  assert.deepEqual(TOPIC_GROUPS.map(g => [g.heading, [...g.topics]]), [
    ['Amino Acids + Peptides', ['Acid-Base Chemistry', 'Amino Acids', 'Peptide Properties', 'Peptide Folding']],
    ['Proteins + Enzymes', ['Protein Purification', 'Hemoglobin + Myoglobin', 'Enzymes', 'Enzyme Kinetics']],
  ]);
});

test('each tool has the requested description, one sentence or less', () => {
  const wanted = {
    'Acid-Base Chemistry': 'Evaluate buffer composition and addition of strong acid or base',
    'Amino Acids': 'Practice naming the 20 amino acids and their properties',
    'Peptide Properties': 'Evaluate pH, charge, and pI of peptide structures',
    'Peptide Folding': 'Adjust dihedral angles to visualize folding patterns',
    'Hemoglobin + Myoglobin': 'Evaluate effect of pH, CO₂, and 2,3-BPG on O₂ binding curves',
    Enzymes: 'Evaluate effect of enzymes, temperature, and pH on reaction energy diagrams',
    'Enzyme Kinetics': 'Evaluate effect of K<sub>m</sub>, k<sub>cat</sub>, [E] and inhibitors on kinetics plots',
  };
  assert.equal(TOOLS.length, Object.keys(wanted).length);
  for (const tool of TOOLS) {
    assert.equal(tool.description, wanted[tool.topic]);
    assert.ok(!/[.!?]\s/.test(tool.description), tool.description);
  }
});

test('descriptions are written as HTML, so their subscripts show as subscripts', () => {
  assert.ok(HTML.includes('<span class="card-description">${tool.description}</span>'));
  for (const tool of TOOLS) assert.ok(!/\bKm\b|\bkcat\b/.test(tool.description), tool.description);
});

test('the title and name are centered', () => {
  assert.match(HTML, /#header-inner \{[^}]*justify-content: center;[^}]*text-align: center;/);
});

test('the top buttons and the how-to note are indented on both sides, narrower than the cards', () => {
  assert.match(HTML, /#tool-links \{[^}]*margin: 0 64px 18px;/);
  assert.match(HTML, /#how-to \{ margin: 0 64px 26px; \}/);
  assert.doesNotMatch(HTML.match(/#topics \{[^}]*\}/)[0], /margin: 0 \d+px/);
});

test('every topic has an icon', () => {
  for (const topic of TOPICS) assert.ok(HTML.includes(`'${topic}': \``), topic);
});

test('the logo setting matches the folder', () => {
  const hasLogo = FILES.includes('ut_logo.png');
  assert.equal(LOGO_FILE, hasLogo ? 'ut_logo.png' : null, 'set LOGO_FILE in index.html to show the logo');
});

test('the page names no course or university, and draws no logo', () => {
  assert.ok(!/CHE ?\d|University of Tampa|\bUT\b/.test(HTML));   // capitals only: --ut-crimson is fine
});

test('the page loads nothing from elsewhere', () => {
  assert.ok(!/https?:\/\//.test(HTML));
  assert.ok(!/<script[^>]+src|<link[^>]+href="(?!data:,")|@import|url\(/i.test(HTML));
});

test('the footer date is a month and year', () => {
  assert.match(LAST_UPDATED, /^[A-Z][a-z]+ \d{4}$/);
});

test('the Enzymes topic links to the enzyme energy page', () => {
  const tool = TOOLS.find(t => t.topic === 'Enzymes');
  assert.equal(tool.file, 'enzyme_energy.html');
  assert.ok(FILES.includes(tool.file));
});
