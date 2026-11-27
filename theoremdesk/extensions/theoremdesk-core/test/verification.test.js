// Tests the parser against real `lake check` / `lake comparator` output
// (Lean v4.36.0), recorded from a small project in test/fixtures/.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { explainProblem, parseVerification, verificationCommand } = require('../out/kernels');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.txt`), 'utf8');

const SIX = ['Lean paranoid', 'lean4lean', 'nanoda', 'con-leche', 'con-ron', 'Lean default'];

test('paranoid check accepted by all six kernels', () => {
	const v = parseVerification(fixture('check-paranoid-accepted'), 0, 'check');
	assert.equal(v.verdict, 'accepted');
	assert.deepEqual(v.kernels.map((k) => k.name), SIX);
	assert.ok(v.kernels.every((k) => k.accepted === true));
	assert.deepEqual(v.axioms, ['Classical.choice', 'propext', 'Quot.sound']);
	assert.equal(v.summary, 'All 6 kernels accept; standard axioms only.');
});

test('a sorry is rejected even though the kernel accepts the term', () => {
	const v = parseVerification(fixture('check-sorry-rejected'), 1, 'check');
	assert.equal(v.verdict, 'rejected');
	assert.deepEqual(v.kernels, [{ name: 'Lean default', accepted: true }]);
	assert.ok(v.axioms.includes('sorryAx'));
	assert.equal(v.summary, 'open_goal still uses sorry');
});

test('comparator accepts a real proof', () => {
	const v = parseVerification(fixture('comparator-accepted'), 0, 'comparator');
	assert.equal(v.verdict, 'accepted');
	assert.equal(v.kernels.length, 6);
	assert.equal(v.summary, 'The proof matches the statement. All 6 kernels accept; standard axioms only.');
});

test('comparator rejects a proof that adds an axiom', () => {
	const v = parseVerification(fixture('comparator-axiom-rejected'), 1, 'comparator');
	assert.equal(v.verdict, 'rejected');
	assert.equal(v.summary, 'The proof adds its own axiom: cheat');
});

test('comparator rejects a proof that changes a definition in the statement', () => {
	const v = parseVerification(fixture('comparator-statement-rejected'), 1, 'comparator');
	assert.equal(v.verdict, 'rejected');
	assert.equal(v.summary, "The proof changes double, so it doesn't prove the same statement");
});

test('kernels that disagree are called out', () => {
	const output = [
		'Running Lean paranoid kernel on solution',
		'Lean paranoid kernel accepts the solution',
		'Running nanoda kernel on solution',
		'error: nanoda: declaration foo failed to typecheck',
		'Running Lean default kernel on solution',
		'Lean default kernel accepts the solution',
	].join('\n');
	const v = parseVerification(output, 1, 'check');
	assert.equal(v.verdict, 'rejected');
	assert.match(v.summary, /^Kernels disagree: rejected by nanoda, accepted by Lean paranoid, Lean default/);
	assert.deepEqual(v.kernels.find((k) => k.name === 'nanoda'), {
		name: 'nanoda',
		accepted: false,
		detail: 'nanoda: declaration foo failed to typecheck',
	});
});

test('exit code 2 means it could not start', () => {
	const v = parseVerification("error: `lake check` sandboxes the code it checks with `bwrap`, which needs Linux namespaces.", 2, 'check');
	assert.equal(v.verdict, 'error');
	assert.match(v.summary, /bwrap/);
});

test('build results', () => {
	assert.equal(parseVerification('Build completed successfully (3 jobs).', 0, 'build').summary, 'Build succeeded');
	const failed = parseVerification('error: Hamiltonian/Pendulum.lean:20:4: unknown identifier', 1, 'build');
	assert.equal(failed.verdict, 'rejected');
	assert.equal(failed.summary, 'Build failed: Hamiltonian/Pendulum.lean:20:4: unknown identifier');
});

test('plain-words problems', () => {
	assert.equal(
		explainProblem("Axiom 'myAx' is not permitted; it is used by 'thm'"),
		'thm uses the non-standard axiom myAx',
	);
	assert.equal(explainProblem("Illegal axiom detected: 'sorryAx'"), 'The proof still uses sorry');
	assert.equal(explainProblem('something else'), 'something else');
});

test('commands per platform and mode', () => {
	const script = 'C:/TD/scripts/wsl-verify.sh';
	const lean = 'C:\\Users\\r\\proj\\lean';
	assert.deepEqual(verificationCommand('win32', 'C:\\Users\\r', lean, script, { kind: 'check', paranoid: true }), {
		command: 'wsl.exe',
		args: ['-e', 'bash', '/mnt/c/TD/scripts/wsl-verify.sh', '/mnt/c/Users/r/proj/lean', 'paranoid'],
	});
	assert.deepEqual(
		verificationCommand('win32', 'C:\\Users\\r', lean, script, { kind: 'comparator', config: '.theoremdesk/comparator.json' }).args.slice(-2),
		['comparator', '.theoremdesk/comparator.json'],
	);
	assert.deepEqual(verificationCommand('win32', 'C:\\Users\\r', lean, script, { kind: 'build' }).args, ['build']);
	assert.deepEqual(verificationCommand('linux', path.join('/home/r', '.elan'), '/p/lean', script, { kind: 'check', paranoid: false }), {
		command: path.join('/home/r', '.elan', 'bin', 'lake'),
		args: ['check'],
		cwd: '/p/lean',
	});
	assert.ok('unsupported' in verificationCommand('darwin', '/Users/r', '/p', script, { kind: 'check', paranoid: true }));
});
