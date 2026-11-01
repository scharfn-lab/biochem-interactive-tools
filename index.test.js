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
    'Protein Structure', 'Hemoglobin + Myoglobin', 'Enzymes', 'Enzyme Kinetics',
  ]);
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
