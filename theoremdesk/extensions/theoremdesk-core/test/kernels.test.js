// Tests the multi-kernel verification helpers.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
	comparatorConfig,
	leanVersion,
	moduleName,
	sorryTheorems,
	supportsKernelChecks,
	toWslPath,
} = require('../out/kernels');

test('Lean versions that have lake check', () => {
	assert.deepEqual(leanVersion('leanprover/lean4:v4.36.0'), [4, 36, 0]);
	assert.ok(supportsKernelChecks('leanprover/lean4:v4.35.0'));
	assert.ok(supportsKernelChecks('leanprover/lean4:v4.36.0-rc1'));
	assert.ok(supportsKernelChecks('leanprover/lean4:v5.0.0'));
	assert.ok(!supportsKernelChecks('leanprover/lean4:v4.34.1'));
	assert.ok(!supportsKernelChecks('leanprover/lean4:nightly-2026-11-01'));
});

test('Windows paths become WSL paths', () => {
	assert.equal(toWslPath('C:\\Users\\r\\my proj\\lean'), '/mnt/c/Users/r/my proj/lean');
	assert.equal(toWslPath('d:/data/'), '/mnt/d/data');
	assert.equal(toWslPath('E:\\'), '/mnt/e');
	assert.throws(() => toWslPath('\\\\server\\share'));
});

test('module names from file paths', () => {
	const lean = path.join(path.sep, 'p', 'lean');
	assert.equal(moduleName(lean, path.join(lean, 'Hamiltonian', 'Pendulum.lean')), 'Hamiltonian.Pendulum');
	assert.throws(() => moduleName(lean, path.join(path.sep, 'p', 'other.lean')));
	assert.throws(() => moduleName(lean, path.join(lean, 'notes.md')));
});

test('finds sorry theorems in the template, with their namespace', () => {
	const pendulum = fs.readFileSync(
		path.join(__dirname, '..', 'templates', 'hamiltonian', 'lean', 'Hamiltonian', 'Pendulum.lean'),
		'utf8',
	);
	assert.deepEqual(sorryTheorems(pendulum), ['Hamiltonian.Pendulum.energy_conserved']);
});

test('sorryTheorems ignores proved theorems, comments and closed namespaces', () => {
	const source = `
namespace A
-- theorem commented : True := sorry
/- theorem blocked : True := by sorry -/
theorem done : True := trivial
lemma open1 (n : Nat) :
    n = n := by
  sorry
namespace B
theorem open2 : True := sorry
end B
end A
theorem top : 1 = 1 := by sorry
`;
	assert.deepEqual(sorryTheorems(source), ['A.open1', 'A.B.open2', 'top']);
});

test('comparator config uses the standard axioms', () => {
	assert.deepEqual(comparatorConfig('Ch', 'Sol', ['t']), {
		challenge_module: 'Ch',
		solution_module: 'Sol',
		theorem_names: ['t'],
		permitted_axioms: ['propext', 'Quot.sound', 'Classical.choice'],
	});
});
