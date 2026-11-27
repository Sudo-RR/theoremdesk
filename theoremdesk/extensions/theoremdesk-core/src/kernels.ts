// Multi-kernel verification with Lean's `lake check` and `lake comparator`.
// Free of the `vscode` API so it can be tested with plain Node.

import * as path from 'path';

/** The axioms `#print axioms` treats as a clean proof. */
export const STANDARD_AXIOMS = ['propext', 'Quot.sound', 'Classical.choice'];

/** `lake check` and `lake comparator` exist from this Lean release on. */
export const MIN_LEAN_FOR_KERNEL_CHECKS: [number, number, number] = [4, 35, 0];

/** `leanprover/lean4:v4.36.0` -> [4, 36, 0]; undefined for nightlies and unparseable names. */
export function leanVersion(toolchain: string): [number, number, number] | undefined {
	const match = /v(\d+)\.(\d+)\.(\d+)/.exec(toolchain);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function supportsKernelChecks(toolchain: string): boolean {
	const version = leanVersion(toolchain);
	if (!version) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (version[i] !== MIN_LEAN_FOR_KERNEL_CHECKS[i]) {
			return version[i] > MIN_LEAN_FOR_KERNEL_CHECKS[i];
		}
	}
	return true;
}

/** `C:\Users\r\proj` -> `/mnt/c/Users/r/proj` (WSL's default automount). */
export function toWslPath(windowsPath: string): string {
	const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(windowsPath);
	if (!match) {
		throw new Error(`Not a Windows drive path: ${windowsPath}`);
	}
	const rest = match[2].replace(/\\/g, '/').replace(/\/+$/, '');
	return `/mnt/${match[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/** `lean/Hamiltonian/Pendulum.lean` under `lean/` -> `Hamiltonian.Pendulum`. */
export function moduleName(leanDir: string, file: string): string {
	const relative = path.relative(leanDir, file);
	if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.lean')) {
		throw new Error(`${file} isn't a Lean file inside ${leanDir}.`);
	}
	return relative.slice(0, -'.lean'.length).split(/[\\/]/).join('.');
}

/**
 * Fully qualified names of the theorems in a Lean file whose proof is
 * `sorry`, the candidates for a challenge. Follows `namespace`/`end` blocks;
 * ignores comments.
 */
export function sorryTheorems(source: string): string[] {
	const code = source.replace(/\/-[\s\S]*?-\//g, '').replace(/--[^\n]*/g, '');
	const names: string[] = [];
	const namespaces: string[] = [];
	const token = /\b(namespace|end|theorem|lemma)\s+([^\s:({[]+)|\bend\b/g;
	let match;
	while ((match = token.exec(code)) !== null) {
		const [, keyword, name] = match;
		if (keyword === 'namespace') {
			namespaces.push(...name.split('.'));
		} else if (keyword === 'end' || match[0] === 'end') {
			if (name && namespaces.length > 0) {
				namespaces.splice(namespaces.length - name.split('.').length);
			}
		} else {
			// The declaration runs until the next top-level keyword.
			const rest = code.slice(token.lastIndex);
			const next = /\n(?=theorem|lemma|def|noncomputable|structure|instance|end|namespace|abbrev|example|axiom|@\[|\/--)/.exec(rest);
			const body = next ? rest.slice(0, next.index) : rest;
			if (/:=\s*(by\s+)?sorry\s*$/.test(body.trim())) {
				names.push([...namespaces, name].join('.'));
			}
		}
	}
	return names;
}

/**
 * What the run button does for a Lean project:
 * - build: `lake build`, natively; the everyday compile
 * - check: `lake check`, sandboxed; Lean's kernel and the axiom check
 * - check + paranoid: `lake check --paranoid`; also every external checker
 * - comparator: `lake comparator --paranoid`; a proof against a statement
 */
export type VerifyMode =
	| { kind: 'build' }
	| { kind: 'check'; paranoid: boolean }
	| { kind: 'comparator'; config: string };

/** The process that runs a verification, or why it can't run on this platform. */
export function verificationCommand(
	platform: NodeJS.Platform,
	home: string,
	leanDir: string,
	wslVerifyScript: string,
	mode: VerifyMode,
): { command: string; args: string[]; cwd?: string } | { unsupported: string } {
	const lake = path.join(home, '.elan', 'bin', platform === 'win32' ? 'lake.exe' : 'lake');
	if (mode.kind === 'build') {
		return { command: lake, args: ['build'], cwd: leanDir };
	}
	const lakeArgs =
		mode.kind === 'check'
			? ['check', ...(mode.paranoid ? ['--paranoid'] : [])]
			: ['comparator', '--paranoid', '--config', mode.config];
	if (platform === 'win32') {
		const extra =
			mode.kind === 'check' ? [mode.paranoid ? 'paranoid' : 'check'] : ['comparator', mode.config];
		return { command: 'wsl.exe', args: ['-e', 'bash', toWslPath(wslVerifyScript), toWslPath(leanDir), ...extra] };
	}
	if (platform === 'linux') {
		return { command: lake, args: lakeArgs, cwd: leanDir };
	}
	return {
		unsupported:
			"Lean's multi-kernel checks sandbox the build with bwrap, which needs Linux. They run on Linux, and on Windows through WSL2, but not on macOS yet.",
	};
}

export interface KernelVerdict {
	name: string;
	/** undefined: it started but never reported a verdict. */
	accepted: boolean | undefined;
	detail?: string;
}

export interface Verification {
	verdict: 'accepted' | 'rejected' | 'error';
	summary: string;
	kernels: KernelVerdict[];
	axioms: string[];
	/** Problems in plain words, most important first. */
	problems: string[];
}

/** Turn one of Lake's error lines into plain words. */
export function explainProblem(message: string): string {
	let match;
	if ((match = /^Axiom 'sorryAx' is not permitted; it is used by '([^']+)'/.exec(message))) {
		return `${match[1]} still uses sorry`;
	}
	if ((match = /^Axiom '([^']+)' is not permitted; it is used by '([^']+)'/.exec(message))) {
		return `${match[2]} uses the non-standard axiom ${match[1]}`;
	}
	if ((match = /^Illegal axiom detected: '([^']+)'/.exec(message))) {
		return match[1] === 'sorryAx' ? 'The proof still uses sorry' : `The proof adds its own axiom: ${match[1]}`;
	}
	if ((match = /^Const does not match between challenge and target '([^']+)'/.exec(message))) {
		return `The proof changes ${match[1]}, so it doesn't prove the same statement`;
	}
	return message;
}

const KERNEL_RUNNING = /^Running (.+?) kernel on /;
const KERNEL_VERDICT = /^(.+?) kernel (accepts|rejects|rejected)\b(.*)$/;

/** Read `lake build`/`lake check`/`lake comparator` output into a verdict. */
export function parseVerification(
	output: string,
	exitCode: number | undefined,
	kind: VerifyMode['kind'],
): Verification {
	const kernels: KernelVerdict[] = [];
	const errors: string[] = [];
	let axioms: string[] = [];
	let current: KernelVerdict | undefined;

	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trim();
		let match;
		if ((match = KERNEL_RUNNING.exec(line))) {
			current = { name: match[1], accepted: undefined };
			kernels.push(current);
		} else if ((match = KERNEL_VERDICT.exec(line))) {
			const kernel = kernels.find((k) => k.name === match![1]) ?? { name: match[1], accepted: undefined };
			if (!kernels.includes(kernel)) {
				kernels.push(kernel);
			}
			kernel.accepted = match[2] === 'accepts';
			if (kernel.accepted) {
				// An error printed while it ran was about axioms, not this kernel.
				delete kernel.detail;
			} else if (match[3].trim()) {
				kernel.detail = match[3].replace(/^[\s:,-]+/, '');
			}
		} else if ((match = /^Uses axioms:\s*(.*)$/.exec(line))) {
			axioms = match[1].split(',').map((a) => a.trim()).filter(Boolean);
		} else if ((match = /^error:\s*(.+)$/.exec(line))) {
			errors.push(match[1]);
			if (current && current.accepted === undefined && !current.detail) {
				current.detail = match[1];
			}
		}
	}

	// A kernel that started but never said "accepts" failed, if the run failed.
	if (exitCode !== 0) {
		for (const kernel of kernels) {
			if (kernel.accepted === undefined) {
				kernel.accepted = false;
			}
		}
	}

	const problems = [...new Set(errors.map(explainProblem))];
	const accepted = kernels.filter((k) => k.accepted === true);
	const rejected = kernels.filter((k) => k.accepted === false);
	const nonStandard = axioms.filter((a) => !STANDARD_AXIOMS.includes(a));

	if (kind === 'build') {
		return exitCode === 0
			? { verdict: 'accepted', summary: 'Build succeeded', kernels, axioms, problems }
			: { verdict: 'rejected', summary: problems[0] ? `Build failed: ${problems[0]}` : 'Build failed', kernels, axioms, problems };
	}

	if (exitCode === 2 || exitCode === undefined) {
		return {
			verdict: 'error',
			summary: problems[0] ?? output.trim().split(/\r?\n/).pop() ?? "Couldn't start the check",
			kernels,
			axioms,
			problems,
		};
	}

	if (accepted.length > 0 && rejected.length > 0) {
		const names = (list: KernelVerdict[]) => list.map((k) => k.name).join(', ');
		return {
			verdict: 'rejected',
			summary: `Kernels disagree: rejected by ${names(rejected)}, accepted by ${names(accepted)}. The proof may exploit a kernel bug.`,
			kernels,
			axioms,
			problems,
		};
	}

	if (exitCode === 0) {
		const who = kernels.length > 1 ? `All ${kernels.length} kernels accept` : "Lean's kernel accepts";
		const what = kind === 'comparator' ? 'The proof matches the statement. ' : '';
		return { verdict: 'accepted', summary: `${what}${who}; standard axioms only.`, kernels, axioms, problems };
	}

	return {
		verdict: 'rejected',
		summary:
			problems[0] ??
			(rejected.length > 0
				? `Rejected by ${rejected.map((k) => k.name).join(', ')}`
				: nonStandard.length > 0
					? `Uses non-standard axioms: ${nonStandard.join(', ')}`
					: 'Rejected'),
		kernels,
		axioms,
		problems,
	};
}

export interface ComparatorConfig {
	challenge_module: string;
	solution_module: string;
	theorem_names: string[];
	definition_names?: string[];
	permitted_axioms: string[];
}

export function comparatorConfig(challengeModule: string, solutionModule: string, theorems: string[]): ComparatorConfig {
	return {
		challenge_module: challengeModule,
		solution_module: solutionModule,
		theorem_names: theorems,
		permitted_axioms: STANDARD_AXIOMS,
	};
}
