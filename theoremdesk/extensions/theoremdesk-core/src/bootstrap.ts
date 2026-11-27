// Make the bundled toolchain ready and prove it works, on every launch.
//
// - TheoremDesk has its own elan home (see dataDirectory), so it never
//   depends on, or changes, a Lean install the user already has.
// - elan's bin folder is copied from the bundle (laid out at build time); no
//   installer runs. It is refreshed when the bundle's elan changes.
// - Bundled Lean toolchains are linked in (a junction on Windows, which
//   needs no administrator rights), or copied if linking fails.
// - Lean, Python, TeX and Git are each run once to prove they work. If Lean
//   doesn't, it is repaired (re-copied and re-linked) and checked again.
//
// No `vscode` API here: test_offline.sh runs this exact code against a
// clean, empty user profile.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BundledTools, exe, hasDefaultToolchain, pathAdditions, prependPath } from './tools';

export type ToolId = 'lean' | 'python' | 'tex' | 'git';

export interface ToolStatus {
	id: ToolId;
	label: string;
	ok: boolean;
	detail: string;
}

export interface BootstrapResult {
	elanHome: string;
	/** Folders to put in front of PATH. */
	pathAdditions: string[];
	/** The environment the tools were verified with: ELAN_HOME and PATH set. */
	env: NodeJS.ProcessEnv;
	status: ToolStatus[];
	/** What had to be repaired, for the log. */
	repaired: string[];
}

export interface BootstrapOptions {
	platform: NodeJS.Platform;
	/** Where TheoremDesk keeps its writable state (see dataDirectory). */
	dataDir: string;
	baseEnv: NodeJS.ProcessEnv;
	log: (message: string) => void;
}

const MARKER = '.theoremdesk-bundle';

function run(
	command: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	cwd?: string,
): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(command, args, { env, cwd, timeout: 120_000, windowsHide: true }, (error, stdout, stderr) =>
			resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}`.trim() }),
		);
	});
}

function isLink(file: string): boolean {
	try {
		return fs.lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}

function samePath(a: string, b: string): boolean {
	try {
		return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase();
	} catch {
		return false;
	}
}

/** Copy the bundle's ready elan bin folder in, unless it's already this bundle's. */
function installElan(tools: BundledTools, elanHome: string, force: boolean, repaired: string[]): void {
	const bin = path.join(elanHome, 'bin');
	const marker = path.join(bin, MARKER);
	const expected = `${tools.elanVersion}\n${tools.root}\n`;
	const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : undefined;
	if (!force && current === expected && fs.existsSync(path.join(bin, exe(process.platform, 'elan')))) {
		return;
	}
	fs.rmSync(bin, { recursive: true, force: true });
	fs.mkdirSync(elanHome, { recursive: true });
	fs.cpSync(tools.elanBin, bin, { recursive: true });
	fs.writeFileSync(marker, expected);
	repaired.push(current === undefined ? 'installed elan' : 'refreshed elan');
}

/** Link (or, failing that, copy) each bundled toolchain into the elan home. */
function installToolchains(tools: BundledTools, elanHome: string, force: boolean, log: (m: string) => void, repaired: string[]): void {
	const toolchainsDir = path.join(elanHome, 'toolchains');
	fs.mkdirSync(toolchainsDir, { recursive: true });
	for (const toolchain of tools.toolchains) {
		const target = path.join(toolchainsDir, path.basename(toolchain.dir));
		const linked = isLink(target);
		const healthy = fs.existsSync(path.join(target, 'bin'));
		if (!force && healthy && (!linked || samePath(target, toolchain.dir))) {
			continue; // linked to this bundle, or a real folder (copied, or installed by elan)
		}
		if (linked || fs.existsSync(target)) {
			fs.rmSync(target, { recursive: true, force: true });
		}
		try {
			fs.symlinkSync(toolchain.dir, target, 'junction');
			repaired.push(`linked ${toolchain.name}`);
		} catch (error) {
			log(`Couldn't link ${toolchain.name} (${(error as Error).message}); copying it instead.`);
			fs.cpSync(toolchain.dir, target, { recursive: true });
			repaired.push(`copied ${toolchain.name}`);
		}
	}
}

async function setDefaultToolchain(tools: BundledTools, elanHome: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<void> {
	const settings = path.join(elanHome, 'settings.toml');
	const text = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : undefined;
	if (tools.toolchains.length > 0 && !hasDefaultToolchain(text)) {
		await run(path.join(elanHome, 'bin', exe(platform, 'elan')), ['default', tools.toolchains[0].name], env);
	}
}

async function verify(tools: BundledTools, elanHome: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<ToolStatus[]> {
	const checks: Promise<ToolStatus>[] = [];

	const toolchain = tools.toolchains[0];
	if (toolchain) {
		const version = toolchain.name.replace(/^.*:v?/, '');
		checks.push(
			run(path.join(elanHome, 'bin', exe(platform, 'lean')), ['--version'], env).then((r) => ({
				id: 'lean',
				label: `Lean ${toolchain.name.replace(/^.*:/, '')}`,
				ok: r.ok && r.output.includes(version),
				detail: r.ok ? r.output.split('\n')[0] : r.output.split('\n').slice(-3).join(' '),
			})),
		);
	}

	checks.push(
		run(tools.python, ['-c', 'import sys, sympy, numpy, scipy, matplotlib, plotly, ipykernel; print(sys.version.split()[0])'], env).then(
			(r) => ({
				id: 'python',
				label: 'Python and Jupyter',
				ok: r.ok,
				detail: r.ok ? `Python ${r.output} with SymPy, NumPy, SciPy, Matplotlib, Plotly, ipykernel` : r.output.split('\n').slice(-2).join(' '),
			}),
		),
	);

	checks.push(
		run(path.join(tools.texBin, exe(platform, 'pdflatex')), ['--version'], env).then((r) => ({
			id: 'tex',
			label: 'LaTeX (TinyTeX)',
			ok: r.ok,
			detail: r.ok ? r.output.split('\n')[0] : r.output.split('\n').slice(-2).join(' '),
		})),
	);

	const git = tools.gitBin ? path.join(tools.gitBin, exe(platform, 'git')) : 'git';
	checks.push(
		run(git, ['--version'], env).then((r) => ({
			id: 'git',
			label: 'Git',
			ok: r.ok,
			detail: r.ok
				? `${r.output}${tools.gitBin ? ' (built in)' : ''}`
				: tools.gitBin
					? r.output
					: 'Git is needed for Lean projects. Install it with your package manager.',
		})),
	);

	return Promise.all(checks);
}

/** Make the bundled toolchain ready, verify it, and repair Lean once if needed. */
export async function bootstrap(tools: BundledTools, options: BootstrapOptions): Promise<BootstrapResult> {
	const { platform, dataDir, log } = options;
	const elanHome = path.join(dataDir, 'elan');
	const additions = pathAdditions(tools, elanHome);
	const env: NodeJS.ProcessEnv = {
		...options.baseEnv,
		ELAN_HOME: elanHome,
		PATH: prependPath(options.baseEnv.PATH ?? options.baseEnv.Path, additions, path.delimiter, platform),
	};
	if (platform === 'win32') {
		delete env.Path; // one PATH variable, not two differently-cased ones
	}
	const repaired: string[] = [];

	const prepare = async (force: boolean) => {
		installElan(tools, elanHome, force, repaired);
		installToolchains(tools, elanHome, force, log, repaired);
		await setDefaultToolchain(tools, elanHome, env, platform);
	};

	try {
		await prepare(false);
	} catch (error) {
		log(`Preparing Lean failed: ${(error as Error).message}`);
	}
	let status = await verify(tools, elanHome, env, platform);

	if (status.some((s) => s.id === 'lean' && !s.ok)) {
		log('Lean failed its check; repairing it.');
		try {
			await prepare(true);
		} catch (error) {
			log(`Repairing Lean failed: ${(error as Error).message}`);
		}
		status = await verify(tools, elanHome, env, platform);
		repaired.push('repaired Lean');
	}

	for (const s of status) {
		log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.label}: ${s.detail}`);
	}
	return { elanHome, pathAdditions: additions, env, status, repaired };
}
