// Mutation testing for Lean files: does the code verify what you meant?
//
// Two kinds of mutant, each compiled with `lake env lean`:
// - a changed definition (`cos` -> `sin`, `+` -> `-`, `2` -> `3`): some
//   theorem should stop compiling, or the theorems don't constrain it;
// - a changed theorem statement with its proof kept (a hypothesis dropped,
//   `<` -> `<=`): the proof should break, or the hypothesis is unused or
//   the statement is weaker than it looks.
//
// Free of the `vscode` API so it can be tested with plain Node.

export type Region = 'statement' | 'definition';

export interface Declaration {
	kind: string;
	name: string;
	start: number;
	/** Where the statement or signature starts (after the name). */
	headerStart: number;
	/** The top-level `:=`, or -1 if there isn't one. */
	assign: number;
	end: number;
	/** The proof is `sorry`; it can't kill a mutant. */
	sorry: boolean;
}

export interface Mutant {
	id: number;
	declaration: string;
	region: Region;
	/** For statement mutants: in a hypothesis, or in what the theorem concludes. */
	position?: 'hypothesis' | 'conclusion';
	operator: string;
	offset: number;
	original: string;
	replacement: string;
	line: number;
	column: number;
	description: string;
}

export type Verdict = 'killed' | 'survived' | 'stillborn' | 'timeout';

export interface Diagnostic {
	line: number;
	column: number;
	severity: 'error' | 'warning' | 'info';
	message: string;
}

const PROOF_KINDS = new Set(['theorem', 'lemma', 'example']);
const DEFINITION_KINDS = new Set(['def', 'abbrev', 'instance']);

/** Blank out comments and strings (same length, newlines kept) so searches skip them. */
export function maskComments(source: string): string {
	let out = '';
	let i = 0;
	let depth = 0;
	while (i < source.length) {
		const two = source.slice(i, i + 2);
		if (depth > 0) {
			if (two === '/-') {
				depth++;
				out += '  ';
				i += 2;
			} else if (two === '-/') {
				depth--;
				out += '  ';
				i += 2;
			} else {
				out += source[i] === '\n' ? '\n' : ' ';
				i++;
			}
		} else if (two === '/-') {
			depth = 1;
			out += '  ';
			i += 2;
		} else if (two === '--') {
			while (i < source.length && source[i] !== '\n') {
				out += ' ';
				i++;
			}
		} else if (source[i] === '"') {
			out += ' ';
			i++;
			while (i < source.length && source[i] !== '"') {
				out += source[i] === '\n' ? '\n' : ' ';
				i += source[i] === '\\' ? 2 : 1;
			}
			out += ' ';
			i++;
		} else {
			out += source[i];
			i++;
		}
	}
	return out.slice(0, source.length);
}

const DECLARATION =
	/^(?:@\[[^\]\n]*\]\s*)?(?:(?:private|protected|noncomputable|nonrec|partial|unsafe)\s+)*(theorem|lemma|def|abbrev|instance|example)\b[ \t]*([^\s:({[⦃]*)/gm;
const BLOCK_END = /^(?:end|namespace|section|structure|class|inductive|open|variable|set_option|#\w+|@\[|\/--)/;

/** Top-level declarations with their statement/body split. */
export function findDeclarations(source: string): Declaration[] {
	const masked = maskComments(source);
	const starts: { kind: string; name: string; start: number; headerStart: number }[] = [];
	let match;
	DECLARATION.lastIndex = 0;
	while ((match = DECLARATION.exec(masked)) !== null) {
		starts.push({ kind: match[1], name: match[2] || match[1], start: match.index, headerStart: DECLARATION.lastIndex });
	}

	return starts.map((decl, index) => {
		const limit = index + 1 < starts.length ? starts[index + 1].start : masked.length;
		// Stop at the next top-level command that isn't a declaration.
		let end = limit;
		const lines = masked.slice(decl.start, limit).split('\n');
		let offset = decl.start;
		for (let i = 0; i < lines.length; i++) {
			if (i > 0 && BLOCK_END.test(lines[i])) {
				end = offset;
				break;
			}
			offset += lines[i].length + 1;
		}

		// The first `:=` outside brackets ends the statement.
		let depth = 0;
		let assign = -1;
		for (let i = decl.headerStart; i < end; i++) {
			const c = masked[i];
			if ('([{⟨⦃'.includes(c)) {
				depth++;
			} else if (')]}⟩⦄'.includes(c)) {
				depth--;
			} else if (depth === 0 && c === ':' && masked[i + 1] === '=') {
				assign = i;
				break;
			}
		}
		const body = assign >= 0 ? masked.slice(assign + 2, end).trim() : '';
		return { ...decl, assign, end, sorry: /^(by\s+)?sorry$/.test(body) };
	});
}

interface Operator {
	name: string;
	regions: Region[];
	pattern: RegExp;
	/** Replacements for one match; empty to skip it. */
	replace: (text: string) => string[];
}

const OPERATORS: Operator[] = [
	{
		name: 'relation',
		regions: ['statement', 'definition'],
		pattern: /(?<![<>=:|←-])(≤|≥|<|>)(?![<>=|;-])/g,
		replace: (t) => ({ '<': ['≤', '>'], '≤': ['<', '≥'], '>': ['≥', '<'], '≥': ['>', '≤'] })[t] ?? [],
	},
	{
		name: 'equality',
		regions: ['statement', 'definition'],
		pattern: /(?<![:=<>!≠])(=|≠)(?![=>])/g,
		replace: (t) => (t === '=' ? ['≠'] : ['=']),
	},
	{
		name: 'arithmetic',
		regions: ['statement', 'definition'],
		pattern: /(?<=\s)(\+|-|\*|\/)(?=\s)/g,
		replace: (t) => ({ '+': ['-'], '-': ['+'], '*': ['/'], '/': ['*'] })[t] ?? [],
	},
	{
		name: 'literal',
		regions: ['statement', 'definition'],
		pattern: /(?<![\w.'₀-₉])\d+(?![\w.'])/g,
		replace: (t) => [String(Number(t) + 1), ...(Number(t) > 0 ? [String(Number(t) - 1)] : [])],
	},
	{
		name: 'logic',
		regions: ['statement', 'definition'],
		pattern: /∧|∨/g,
		replace: (t) => (t === '∧' ? ['∨'] : ['∧']),
	},
	{
		name: 'function',
		regions: ['statement', 'definition'],
		pattern: /(?<![\w.])(?:Real\.)?(sin|cos|min|max)\b/g,
		replace: (t) => {
			const swap: Record<string, string> = { sin: 'cos', cos: 'sin', min: 'max', max: 'min' };
			const [prefix, name] = t.includes('.') ? [t.slice(0, t.lastIndexOf('.') + 1), t.slice(t.lastIndexOf('.') + 1)] : ['', t];
			return swap[name] ? [prefix + swap[name]] : [];
		},
	},
	{
		// Drop an explicit hypothesis binder, such as `(h : IsSolution P θ p)`.
		name: 'hypothesis',
		regions: ['statement'],
		pattern: /\s\((\w+)\s*:\s*((?:[^()]|\([^()]*\))*)\)/g,
		replace: (t) => {
			const binder = /\((\w+)\s*:\s*([\s\S]*)\)/.exec(t);
			if (!binder) {
				return [];
			}
			const [, name, type] = binder;
			const looksLikeProp = /^h/.test(name) || /[=<>≤≥≠∧∨¬∀∃→]|Is[A-Z]/.test(type);
			return looksLikeProp ? [''] : [];
		},
	},
];

/** original -> replacement pairs where the new proposition follows from the old one. */
const WEAKENS = new Set(['<→≤', '>→≥', '∧→∨']);
/** ... and pairs where the old one follows from the new one. */
const STRENGTHENS = new Set(['≤→<', '≥→>', '∨→∧']);

/**
 * Where the conclusion of a theorem statement starts: after the binders'
 * top-level `:`, and after the last top-level `→` (whose left side is
 * another hypothesis). Nested implications are not tracked.
 */
function conclusionStart(masked: string, from: number, to: number): number {
	let depth = 0;
	let start = from;
	let seenColon = false;
	for (let i = from; i < to; i++) {
		const c = masked[i];
		if ('([{⟨⦃'.includes(c)) {
			depth++;
		} else if (')]}⟩⦄'.includes(c)) {
			depth--;
		} else if (depth === 0 && !seenColon && c === ':' && masked[i + 1] !== '=') {
			seenColon = true;
			start = i + 1;
		} else if (depth === 0 && seenColon && c === '→') {
			start = i + 1;
		}
	}
	return start;
}

/** Reversed relations: in a hypothesis these usually contradict the others. */
const FLIPS = new Set(['<→>', '>→<', '≤→≥', '≥→≤']);

/**
 * A statement mutant whose survival says nothing: it only makes the
 * statement weaker (a weaker conclusion, a stronger hypothesis), or it flips
 * a hypothesis, which usually makes the hypotheses contradictory so that
 * anything follows.
 */
function uninformative(position: 'hypothesis' | 'conclusion', original: string, replacement: string): boolean {
	const pair = `${original.trim()}→${replacement}`;
	return position === 'conclusion' ? WEAKENS.has(pair) : STRENGTHENS.has(pair) || FLIPS.has(pair);
}

function lineColumn(source: string, offset: number): { line: number; column: number } {
	const before = source.slice(0, offset);
	const line = before.split('\n').length;
	return { line, column: offset - before.lastIndexOf('\n') };
}

/** Every mutant of `source`: statements of proved theorems and bodies of definitions. */
export function generateMutants(source: string, operators?: string[]): Mutant[] {
	const masked = maskComments(source);
	const declarations = findDeclarations(source);
	const mutants: Mutant[] = [];

	for (const decl of declarations) {
		let region: Region;
		let from: number;
		let to: number;
		if (PROOF_KINDS.has(decl.kind)) {
			// A sorry'd proof passes whatever the statement says.
			if (decl.sorry || decl.assign < 0) {
				continue;
			}
			region = 'statement';
			from = decl.headerStart;
			to = decl.assign;
		} else if (DEFINITION_KINDS.has(decl.kind) && decl.assign >= 0) {
			region = 'definition';
			from = decl.assign + 2;
			to = decl.end;
		} else {
			continue;
		}

		const text = masked.slice(from, to);
		const conclusion = region === 'statement' ? conclusionStart(masked, from, to) : -1;
		for (const operator of OPERATORS) {
			if (!operator.regions.includes(region) || (operators && !operators.includes(operator.name))) {
				continue;
			}
			operator.pattern.lastIndex = 0;
			let match;
			while ((match = operator.pattern.exec(text)) !== null) {
				const offset = from + match.index;
				const original = source.slice(offset, offset + match[0].length);
				const position =
					region === 'statement' ? (offset >= conclusion ? 'conclusion' : 'hypothesis') : undefined;
				for (const replacement of operator.replace(original)) {
					// Dropping a hypothesis is always kept: if the proof survives it,
					// the hypothesis was never used.
					if (position && operator.name !== 'hypothesis' && uninformative(position, original, replacement)) {
						continue;
					}
					const where = lineColumn(source, offset);
					const shown = original.trim().replace(/\s+/g, ' ');
					mutants.push({
						id: mutants.length,
						declaration: decl.name,
						region,
						position,
						operator: operator.name,
						offset,
						original,
						replacement,
						...where,
						description:
							operator.name === 'hypothesis'
								? `drop hypothesis \`${shown}\``
								: `\`${shown}\` → \`${replacement}\``,
					});
				}
			}
		}
	}
	return mutants;
}

export function applyMutant(source: string, mutant: Mutant): string {
	return source.slice(0, mutant.offset) + mutant.replacement + source.slice(mutant.offset + mutant.original.length);
}

/** `file:line:col: error: message` lines from `lean` output. */
export function parseDiagnostics(output: string): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const pattern = /^(?:.*?):(\d+):(\d+): (error|warning|info): ?(.*)$/gm;
	let match;
	while ((match = pattern.exec(output)) !== null) {
		diagnostics.push({
			line: Number(match[1]),
			column: Number(match[2]),
			severity: match[3] as Diagnostic['severity'],
			message: match[4],
		});
	}
	return diagnostics;
}

/**
 * Killed if a proof broke; stillborn if only the mutated statement or
 * definition itself failed to elaborate; survived if nothing failed.
 */
export function classify(
	mutatedSource: string,
	output: string,
	exitCode: number | undefined,
	mutant: Pick<Mutant, 'declaration' | 'region'>,
): Verdict {
	const errors = parseDiagnostics(output).filter((d) => d.severity === 'error');
	if (errors.length === 0) {
		return exitCode === 0 || exitCode === undefined ? 'survived' : 'stillborn';
	}
	const lineStarts = [0];
	for (let i = 0; i < mutatedSource.length; i++) {
		if (mutatedSource[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}
	const declarations = findDeclarations(mutatedSource);
	const located = errors.map((error) => {
		const offset = (lineStarts[error.line - 1] ?? 0) + error.column;
		return { offset, decl: declarations.find((d) => offset >= d.start && offset <= d.end) };
	});

	// The mutant itself doesn't elaborate: an ill-typed definition, or a
	// statement that no longer makes sense. Anything downstream is noise.
	const brokenItself = located.some(
		({ offset, decl }) =>
			decl?.name === mutant.declaration &&
			(mutant.region === 'definition' || decl.assign < 0 || offset <= decl.assign),
	);
	if (brokenItself) {
		return 'stillborn';
	}

	const proofBroke = located.some(
		({ offset, decl }) => decl && PROOF_KINDS.has(decl.kind) && decl.assign >= 0 && offset > decl.assign,
	);
	return proofBroke ? 'killed' : 'stillborn';
}

export interface Summary {
	killed: number;
	survived: number;
	stillborn: number;
	timeout: number;
}

export function summarize(verdicts: Verdict[]): Summary {
	const summary: Summary = { killed: 0, survived: 0, stillborn: 0, timeout: 0 };
	for (const v of verdicts) {
		summary[v]++;
	}
	return summary;
}

/** Theorems with `sorry` proofs: they can't catch anything, so say so. */
export function sorryDeclarations(source: string): string[] {
	return findDeclarations(source)
		.filter((d) => PROOF_KINDS.has(d.kind) && d.sorry)
		.map((d) => d.name);
}
