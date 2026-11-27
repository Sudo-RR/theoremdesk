// Tests the project generator against the real templates.
// Run with `npm test` (compiles first).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generateProject, isValidProjectName, listTemplates, substitute } = require('../out/generator');

const templatesDir = path.join(__dirname, '..', 'templates');

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'theoremdesk-test-'));
}

test('lists the Hamiltonian template', () => {
	const templates = listTemplates(templatesDir);
	const hamiltonian = templates.find((t) => t.id === 'hamiltonian');
	assert.ok(hamiltonian, 'hamiltonian template missing');
	assert.match(hamiltonian.variables.LEAN_TOOLCHAIN, /^leanprover\/lean4:v\d+\.\d+\.\d+/);
	assert.ok(hamiltonian.variables.PHYSLIB_REV);
});

test('generates the Hamiltonian project with every placeholder filled', () => {
	const template = listTemplates(templatesDir).find((t) => t.id === 'hamiltonian');
	const target = path.join(tempDir(), 'my-project');
	const written = generateProject(template, target, { PROJECT_NAME: 'my-project', PROJECT_TITLE: 'My Title' });

	const expected = [
		'.gitignore',
		'.vscode/settings.json',
		'README.md',
		'requirements.txt',
		'lean/lakefile.toml',
		'lean/lean-toolchain',
		'lean/Hamiltonian.lean',
		'lean/Hamiltonian/Oscillator.lean',
		'lean/Hamiltonian/Pendulum.lean',
		'lean/Attempts/README.md',
		'notebooks/01_oscillator.ipynb',
		'notebooks/02_pendulum.ipynb',
		'manuscript/main.tex',
		'manuscript/references.bib',
	];
	const normalised = written.map((file) => file.split(path.sep).join('/'));
	for (const file of expected) {
		assert.ok(normalised.includes(file), `missing ${file}`);
	}
	assert.ok(!normalised.includes('template.json'), 'template.json should not be copied');

	for (const file of normalised) {
		const text = fs.readFileSync(path.join(target, file), 'utf8');
		assert.doesNotMatch(text, /\{\{[A-Z_]+\}\}/, `unfilled placeholder in ${file}`);
	}

	assert.equal(
		fs.readFileSync(path.join(target, 'lean', 'lean-toolchain'), 'utf8').trim(),
		template.variables.LEAN_TOOLCHAIN,
	);
	assert.match(fs.readFileSync(path.join(target, 'manuscript', 'main.tex'), 'utf8'), /\\title\{My Title\}/);

	for (const notebook of ['01_oscillator.ipynb', '02_pendulum.ipynb']) {
		const parsed = JSON.parse(fs.readFileSync(path.join(target, 'notebooks', notebook), 'utf8'));
		assert.equal(parsed.nbformat, 4);
		assert.ok(parsed.cells.length > 0);
	}
});

test('refuses a folder that already has files', () => {
	const template = listTemplates(templatesDir).find((t) => t.id === 'hamiltonian');
	const target = tempDir();
	fs.writeFileSync(path.join(target, 'keep.txt'), 'x');
	assert.throws(() => generateProject(template, target, {}), /isn't empty/);
	assert.deepEqual(fs.readdirSync(target), ['keep.txt']);
});

test('substitute leaves LaTeX braces and unknown names alone', () => {
	assert.equal(substitute('\\title{{{PROJECT_TITLE}}}', { PROJECT_TITLE: 'T' }), '\\title{T}');
	assert.equal(substitute('10^{{{x}}} {{UNKNOWN}}', {}), '10^{{{x}}} {{UNKNOWN}}');
});

test('project names', () => {
	for (const ok of ['hamiltonian-mechanics', 'paper_2026', 'a.b']) {
		assert.ok(isValidProjectName(ok), ok);
	}
	for (const bad of ['', '-x', 'a/b', 'a b', 'name.', '..']) {
		assert.ok(!isValidProjectName(bad), bad);
	}
});
