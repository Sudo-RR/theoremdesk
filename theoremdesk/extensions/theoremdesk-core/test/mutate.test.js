// Tests the Lean mutation engine.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
	applyMutant,
	classify,
	findDeclarations,
	generateMutants,
	maskComments,
	parseDiagnostics,
	sorryDeclarations,
	summarize,
} = require('../out/mutate');

const PENDULUM_TEMPLATE = fs.readFileSync(
	path.join(__dirname, '..', 'templates', 'hamiltonian', 'lean', 'Hamiltonian', 'Pendulum.lean'),
	'utf8',
);

const SAMPLE = `-- a comment with theorem fake : 1 < 2 := rfl
def double (n : Nat) : Nat := n + n

/-- doc: 3 < 4 -/
theorem double_eq (n : Nat) : double n = 2 * n := by
  unfold double; omega

theorem pos (n : Nat) (h : 0 < n) : 0 < double n := by
  unfold double; omega

theorem open_goal : 1 = 2 := sorry
`;

test('masking keeps length and newlines but hides comments and strings', () => {
	const src = 'a -- b < c\n/- x /- y -/ z -/ "s < t" d';
	const masked = maskComments(src);
	assert.equal(masked.length, src.length);
	assert.equal(masked.split('\n').length, 2);
	assert.ok(!masked.includes('<'));
	assert.ok(masked.trimEnd().endsWith('d'));
});

test('finds declarations, their := and sorry proofs', () => {
	const decls = findDeclarations(SAMPLE);
	assert.deepEqual(decls.map((d) => [d.kind, d.name, d.sorry]), [
		['def', 'double', false],
		['theorem', 'double_eq', false],
		['theorem', 'pos', false],
		['theorem', 'open_goal', true],
	]);
	const doubleEq = decls[1];
	assert.ok(SAMPLE.slice(doubleEq.headerStart, doubleEq.assign).includes('double n = 2 * n'));
	assert.deepEqual(sorryDeclarations(SAMPLE), ['open_goal']);
});

test('mutants cover definitions and statements, never comments or sorry theorems', () => {
	const mutants = generateMutants(SAMPLE);
	const described = mutants.map((m) => `${m.declaration} ${m.region} ${m.description}`);

	assert.ok(described.includes('double definition `+` → `-`'));
	assert.ok(described.includes('double_eq statement `=` → `≠`'));
	assert.ok(described.includes('double_eq statement `2` → `3`'));
	assert.ok(described.includes('double_eq statement `*` → `/`'));
	assert.ok(described.includes('pos statement drop hypothesis `(h : 0 < n)`'));
	assert.ok(described.includes('pos statement `<` → `≤`'));
	assert.ok(!mutants.some((m) => m.declaration === 'open_goal'), 'sorry theorems are skipped');
	assert.ok(!mutants.some((m) => m.declaration === 'fake'), 'comments are skipped');
	assert.ok(!described.some((d) => d.includes('(n : Nat)')), 'data binders are not dropped');

	const dropH = mutants.find((m) => m.operator === 'hypothesis');
	assert.match(applyMutant(SAMPLE, dropH), /theorem pos \(n : Nat\) : 0 < double n := by/);
	for (const m of mutants) {
		assert.equal(SAMPLE.slice(m.offset, m.offset + m.original.length), m.original);
	}
});

test('the pendulum template: its only theorem is sorry, so only definitions are mutated', () => {
	const mutants = generateMutants(PENDULUM_TEMPLATE);
	assert.ok(mutants.length > 0);
	assert.ok(mutants.every((m) => m.region === 'definition'));
	assert.ok(mutants.some((m) => m.declaration === 'hamiltonian' && m.description === '`Real.cos` → `Real.sin`'));
	assert.ok(mutants.some((m) => m.declaration === 'IsSolution'));
	assert.deepEqual(sorryDeclarations(PENDULUM_TEMPLATE), ['energy_conserved']);
});

test('operators can be limited', () => {
	const mutants = generateMutants(SAMPLE, ['hypothesis']);
	assert.deepEqual(mutants.map((m) => m.operator), ['hypothesis']);
});

test('parses lean diagnostics, including Windows paths', () => {
	const out = 'C:\\tmp\\M3.lean:5:2: error: unsolved goals\nM3.lean:9:8: warning: declaration uses `sorry`\n';
	assert.deepEqual(parseDiagnostics(out), [
		{ line: 5, column: 2, severity: 'error', message: 'unsolved goals' },
		{ line: 9, column: 8, severity: 'warning', message: 'declaration uses `sorry`' },
	]);
});

test('classification', () => {
	// Proof of double_eq (line 6) breaks: killed.
	assert.equal(classify(SAMPLE, 'M.lean:6:2: error: omega could not prove the goal', 1, { declaration: 'double', region: 'definition' }), 'killed');
	// The mutated definition itself is ill-typed: stillborn, even though later proofs fail too.
	assert.equal(
		classify(SAMPLE, 'M.lean:2:30: error: type mismatch\nM.lean:6:2: error: unknown constant', 1, { declaration: 'double', region: 'definition' }),
		'stillborn',
	);
	// An error in the mutated statement (line 5, before :=): stillborn.
	assert.equal(classify(SAMPLE, 'M.lean:5:30: error: failed to synthesize', 1, { declaration: 'double_eq', region: 'statement' }), 'stillborn');
	// Nothing failed: survived.
	assert.equal(classify(SAMPLE, 'M.lean:11:8: warning: declaration uses `sorry`', 0, { declaration: 'pos', region: 'statement' }), 'survived');
});

test('summary counts', () => {
	assert.deepEqual(summarize(['killed', 'killed', 'survived', 'stillborn', 'timeout']), {
		killed: 2,
		survived: 1,
		stillborn: 1,
		timeout: 1,
	});
});

test('statement mutants that only weaken the statement are skipped', () => {
	const src = `theorem t (n : Nat) (h : 0 < n) (k : n ≤ 9) : 0 < n * 2 ∧ n ≤ 99 := by omega\n`;
	const mutants = generateMutants(src).filter((m) => m.operator !== 'literal');
	const described = mutants.map((m) => `${m.position} ${m.description}`);

	// Conclusion: strengthening and flipping are kept, weakening is not.
	assert.ok(described.includes('conclusion `<` → `>`'));
	assert.ok(described.includes('conclusion `≤` → `<`'));
	assert.ok(described.includes('conclusion `∧` → `∨`') === false, '∧ → ∨ weakens the conclusion');
	assert.ok(!described.includes('conclusion `<` → `≤`'), '< → ≤ weakens the conclusion');

	// Hypotheses: weakening is kept; strengthening and flipping are not.
	assert.ok(described.includes('hypothesis `<` → `≤`'));
	assert.ok(!described.includes('hypothesis `≤` → `<`'), '≤ → < strengthens a hypothesis');
	assert.ok(!described.includes('hypothesis `<` → `>`'), 'a flipped hypothesis usually contradicts the others');

	// Dropping a hypothesis is always tried.
	assert.ok(described.includes('hypothesis drop hypothesis `(h : 0 < n)`'));
	assert.ok(described.includes('hypothesis drop hypothesis `(k : n ≤ 9)`'));
});

test('an implication in the statement counts as a hypothesis', () => {
	const mutants = generateMutants('theorem t (n : Nat) : 0 < n → 0 < n + n := by omega\n', ['relation']);
	assert.deepEqual(
		mutants.map((m) => `${m.position} ${m.description}`),
		['hypothesis `<` → `≤`', 'conclusion `<` → `>`'],
	);
});
