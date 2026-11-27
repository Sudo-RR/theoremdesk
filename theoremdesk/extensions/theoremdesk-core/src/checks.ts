// Environment checks: which research tools are installed, and how to fix
// what isn't. Free of the `vscode` API so it can be tested with plain Node;
// everything platform-specific goes through the `Env` passed in.

import * as path from 'path';
import { MIN_LEAN_FOR_KERNEL_CHECKS, supportsKernelChecks, toWslPath } from './kernels';

export type Status = 'ok' | 'warning' | 'missing';
export type Group = 'tools' | 'project';

/** One process to run, shown to the user in a terminal. */
export interface Step {
	label: string;
	command: string;
	args: string[];
	cwd?: string;
}

export type Fix =
	| { kind: 'steps'; label: string; steps: Step[] }
	| { kind: 'vscodeCommand'; label: string; command: string }
	| { kind: 'restart'; label: string };

export interface CheckResult {
	id: string;
	group: Group;
	label: string;
	status: Status;
	detail: string;
	fix?: Fix;
}

export interface RunResult {
	ok: boolean;
	stdout: string;
}

export interface Env {
	platform: NodeJS.Platform;
	home: string;
	/** %LOCALAPPDATA% on Windows. */
	localAppData?: string;
	/** %ProgramFiles% on Windows. */
	programFiles?: string;
	/** Run a program directly (no shell); never throws. */
	run(command: string, args: string[], cwd?: string): Promise<RunResult>;
	exists(file: string): boolean;
	readFile(file: string): string | undefined;
	listDir(dir: string): string[];
	/** The open project folder, if any. */
	workspace?: string;
	/** Windows path of scripts/wsl-setup.sh, for the WSL kernel-check setup fix. */
	wslSetupScript?: string;
	/** TheoremDesk's own elan home, when it bundles Lean. */
	elanHome?: string;
	/** Results of checking the built-in toolchain; replaces the Git, Python, Lean and TeX rows. */
	bundledStatus?: { id: string; label: string; ok: boolean; detail: string }[];
	/** The Python bundled with TheoremDesk, if this build has one. */
	bundledPython?: string;
}

/** A tool found on PATH, or installed somewhere this window's PATH doesn't reach yet. */
interface Tool {
	command: string;
	prefixArgs: string[];
	version: string;
	onPath: boolean;
}

const exe = (env: Env, name: string) => (env.platform === 'win32' ? `${name}.exe` : name);

async function probe(env: Env, command: string, prefixArgs: string[], versionArgs: string[]): Promise<Tool | undefined> {
	const result = await env.run(command, [...prefixArgs, ...versionArgs]);
	if (!result.ok) {
		return undefined;
	}
	const version = result.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
	return { command, prefixArgs, version, onPath: !path.isAbsolute(command) };
}

/** Try `names` on PATH first, then the absolute `candidates`. */
async function findTool(
	env: Env,
	names: { command: string; prefixArgs?: string[] }[],
	candidates: string[],
	versionArgs: string[] = ['--version'],
): Promise<Tool | undefined> {
	for (const name of names) {
		const tool = await probe(env, name.command, name.prefixArgs ?? [], versionArgs);
		if (tool) {
			return tool;
		}
	}
	for (const candidate of candidates) {
		if (env.exists(candidate)) {
			const tool = await probe(env, candidate, [], versionArgs);
			if (tool) {
				return tool;
			}
		}
	}
	return undefined;
}

function installFix(env: Env, label: string, byPlatform: { win32: Step[]; darwin: Step[]; linux: Step[] }): Fix {
	const steps = env.platform === 'win32' ? byPlatform.win32 : env.platform === 'darwin' ? byPlatform.darwin : byPlatform.linux;
	return { kind: 'steps', label, steps };
}

const RESTART: Fix = { kind: 'restart', label: 'Restart TheoremDesk' };
const NOT_ON_PATH = "Installed, but this window started before it was. Restart TheoremDesk so it's on PATH.";

// ---------------------------------------------------------------------------
// Tools

async function checkGit(env: Env): Promise<CheckResult> {
	const candidates = env.platform === 'win32' && env.programFiles ? [path.join(env.programFiles, 'Git', 'cmd', 'git.exe')] : [];
	const git = await findTool(env, [{ command: 'git' }], candidates);
	const base = { id: 'git', group: 'tools' as const, label: 'Git' };
	if (!git) {
		return {
			...base,
			status: 'missing',
			detail: 'Lean uses Git to download Mathlib and Physlib.',
			fix: installFix(env, 'Install Git', {
				win32: [{ label: 'Install Git', command: 'winget', args: ['install', '--id', 'Git.Git', '-e'] }],
				darwin: [{ label: 'Install Git', command: 'xcode-select', args: ['--install'] }],
				linux: [{ label: 'Install Git', command: 'pkexec', args: ['apt-get', 'install', '-y', 'git'] }],
			}),
		};
	}
	return git.onPath
		? { ...base, status: 'ok', detail: git.version }
		: { ...base, status: 'warning', detail: NOT_ON_PATH, fix: RESTART };
}

function parsePythonVersion(text: string): [number, number] | undefined {
	const match = /Python (\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2])] : undefined;
}

async function findPython(env: Env): Promise<Tool | undefined> {
	const names = [{ command: 'python3' }, { command: 'python' }];
	if (env.platform === 'win32') {
		names.push({ command: 'py', prefixArgs: ['-3'] } as { command: string; prefixArgs: string[] });
	}
	const candidates: string[] = [];
	if (env.platform === 'win32' && env.localAppData) {
		const root = path.join(env.localAppData, 'Programs', 'Python');
		for (const dir of env.listDir(root).filter((d) => /^Python3\d+$/.test(d)).sort().reverse()) {
			candidates.push(path.join(root, dir, 'python.exe'));
		}
	}
	return findTool(env, names, candidates);
}

async function checkPython(env: Env, python: Tool | undefined): Promise<CheckResult> {
	const base = { id: 'python', group: 'tools' as const, label: 'Python' };
	const install = installFix(env, 'Install Python', {
		win32: [{ label: 'Install Python', command: 'winget', args: ['install', '--id', 'Python.Python.3.12', '-e'] }],
		darwin: [{ label: 'Install Python', command: 'brew', args: ['install', 'python@3.12'] }],
		linux: [{ label: 'Install Python', command: 'pkexec', args: ['apt-get', 'install', '-y', 'python3', 'python3-venv'] }],
	});
	if (!python) {
		return { ...base, status: 'missing', detail: 'The notebooks need Python 3.10 or newer.', fix: install };
	}
	const version = parsePythonVersion(python.version);
	if (!version || version[0] < 3 || (version[0] === 3 && version[1] < 10)) {
		return { ...base, status: 'warning', detail: `${python.version}: the notebooks need 3.10 or newer.`, fix: install };
	}
	return python.onPath
		? { ...base, status: 'ok', detail: python.version }
		: { ...base, status: 'warning', detail: NOT_ON_PATH, fix: RESTART };
}

function elanBin(env: Env): string {
	// TheoremDesk's own elan home when it has one, else the usual ~/.elan.
	if (env.elanHome) {
		return path.join(env.elanHome, 'bin');
	}
	return path.join(env.home, '.elan', 'bin');
}

async function findElan(env: Env): Promise<Tool | undefined> {
	return findTool(env, [{ command: 'elan' }], [path.join(elanBin(env), exe(env, 'elan'))]);
}

function checkElan(elan: Tool | undefined): CheckResult {
	const base = { id: 'elan', group: 'tools' as const, label: 'Lean (elan)' };
	if (!elan) {
		return {
			...base,
			status: 'missing',
			detail: "elan installs whichever Lean version a project's lean-toolchain asks for.",
			fix: { kind: 'vscodeCommand', label: 'Install Lean', command: 'lean4.setup.installElan' },
		};
	}
	// The Lean extension finds elan in ~/.elan/bin itself, so PATH doesn't matter here.
	return { ...base, status: 'ok', detail: elan.version };
}

async function checkTex(env: Env): Promise<CheckResult> {
	const base = { id: 'tex', group: 'tools' as const, label: 'TeX (pdflatex, bibtex)' };
	const binDirs: string[] = [];
	if (env.platform === 'win32') {
		if (env.localAppData) {
			binDirs.push(path.join(env.localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
		}
		if (env.programFiles) {
			binDirs.push(path.join(env.programFiles, 'MiKTeX', 'miktex', 'bin', 'x64'));
		}
	} else if (env.platform === 'darwin') {
		binDirs.push('/Library/TeX/texbin');
	}
	const pdflatex = await findTool(env, [{ command: 'pdflatex' }], binDirs.map((d) => path.join(d, exe(env, 'pdflatex'))));
	const bibtex = await findTool(env, [{ command: 'bibtex' }], binDirs.map((d) => path.join(d, exe(env, 'bibtex'))));
	if (!pdflatex || !bibtex) {
		return {
			...base,
			status: 'missing',
			detail: 'Building the manuscript needs a TeX distribution.',
			fix: installFix(env, 'Install TeX', {
				win32: [{ label: 'Install MiKTeX', command: 'winget', args: ['install', '--id', 'MiKTeX.MiKTeX', '-e'] }],
				darwin: [{ label: 'Install MacTeX', command: 'brew', args: ['install', '--cask', 'mactex-no-gui'] }],
				linux: [
					{
						label: 'Install TeX Live',
						command: 'pkexec',
						args: ['apt-get', 'install', '-y', 'texlive-latex-extra', 'texlive-bibtex-extra'],
					},
				],
			}),
		};
	}
	return pdflatex.onPath && bibtex.onPath
		? { ...base, status: 'ok', detail: pdflatex.version }
		: { ...base, status: 'warning', detail: NOT_ON_PATH, fix: RESTART };
}

const FILE_SYSTEM_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

/** Mathlib's build files have long names; Windows refuses paths over 260 characters unless told otherwise. */
async function checkLongPaths(env: Env, git: boolean): Promise<CheckResult | undefined> {
	if (env.platform !== 'win32') {
		return undefined;
	}
	const base = { id: 'longPaths', group: 'tools' as const, label: 'Long file paths (Windows)' };
	const registry = await env.run('reg', ['query', FILE_SYSTEM_KEY, '/v', 'LongPathsEnabled']);
	const windowsOn = registry.ok && /LongPathsEnabled\s+REG_DWORD\s+0x1\b/.test(registry.stdout);
	const gitOn = git ? (await env.run('git', ['config', '--global', 'core.longpaths'])).stdout.trim() === 'true' : true;
	if (windowsOn && gitOn) {
		return { ...base, status: 'ok', detail: 'Enabled for Windows and Git.' };
	}
	const steps: Step[] = [];
	if (!gitOn) {
		steps.push({ label: 'Allow long paths in Git', command: 'git', args: ['config', '--global', 'core.longpaths', 'true'] });
	}
	if (!windowsOn) {
		steps.push({
			label: 'Allow long paths in Windows (asks for administrator rights)',
			command: 'powershell',
			args: [
				'-NoProfile',
				'-Command',
				"Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command'," +
					"'New-ItemProperty -Path HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force'",
			],
		});
	}
	const off = [!windowsOn && 'Windows', !gitOn && 'Git'].filter(Boolean).join(' and ');
	return {
		...base,
		status: 'warning',
		detail: `Off in ${off}. Some Mathlib files fail to build or download in deep folders.`,
		fix: { kind: 'steps', label: 'Allow long paths', steps },
	};
}

/**
 * `lake check` and `lake comparator` build the project inside a bwrap
 * sandbox, which only exists on Linux. On Windows they run inside WSL.
 */
async function checkKernelSandbox(env: Env): Promise<CheckResult | undefined> {
	const base = { id: 'kernelSandbox', group: 'tools' as const, label: 'Kernel checks sandbox' };

	if (env.platform === 'linux') {
		const bwrap = await findTool(env, [{ command: 'bwrap' }], []);
		return bwrap
			? { ...base, status: 'ok', detail: `bwrap ${bwrap.version}` }
			: {
					...base,
					status: 'missing',
					detail: 'Verifying with all kernels needs bubblewrap (bwrap) to sandbox the build.',
					fix: {
						kind: 'steps',
						label: 'Install bubblewrap',
						steps: [{ label: 'Install bubblewrap', command: 'pkexec', args: ['apt-get', 'install', '-y', 'bubblewrap'] }],
					},
				};
	}

	if (env.platform !== 'win32') {
		// No sandbox is available on macOS; the Verify command explains.
		return undefined;
	}

	const wsl = await env.run('wsl.exe', ['--status']);
	if (!wsl.ok) {
		return {
			...base,
			status: 'missing',
			detail: "Verifying with all kernels runs Lean's sandboxed checker inside WSL2. Installing WSL needs a Windows restart.",
			fix: {
				kind: 'steps',
				label: 'Install WSL',
				steps: [{ label: 'Install WSL with Ubuntu', command: 'wsl.exe', args: ['--install', '-d', 'Ubuntu-24.04'] }],
			},
		};
	}

	const ready = await env.run('wsl.exe', [
		'-e',
		'sh',
		'-c',
		'test -x "$HOME/.theoremdesk/tools/bwrap" && test -x "$HOME/.elan/bin/elan"',
	]);
	if (ready.ok) {
		return { ...base, status: 'ok', detail: 'WSL has Lean (elan) and bwrap.' };
	}
	return {
		...base,
		status: 'missing',
		detail: "Set up Lean (elan) and the bwrap sandbox in WSL's default distro. No administrator rights needed.",
		fix: env.wslSetupScript
			? {
					kind: 'steps',
					label: 'Set up kernel checks',
					steps: [{ label: 'Set up kernel checks in WSL', command: 'wsl.exe', args: ['-e', 'bash', toWslPath(env.wslSetupScript)] }],
				}
			: undefined,
	};
}

// ---------------------------------------------------------------------------
// The open project

/** The folder holding the Lean project: the workspace itself, or its lean/ subfolder. */
export function findLeanProject(env: Env, workspace: string): string | undefined {
	for (const dir of [workspace, path.join(workspace, 'lean')]) {
		if (env.exists(path.join(dir, 'lakefile.toml')) || env.exists(path.join(dir, 'lakefile.lean'))) {
			return dir;
		}
	}
	return undefined;
}

/**
 * The libraries `lake build` builds: the `defaultTargets` that are libraries,
 * or every library if `defaultTargets` isn't set.
 */
export function defaultLibraries(lakefile: string): string[] {
	const libraries = leanLibraries(lakefile);
	const targets = /^\s*defaultTargets\s*=\s*\[([^\]]*)\]/m.exec(lakefile);
	if (!targets) {
		return libraries;
	}
	const defaults = [...targets[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	return libraries.filter((lib) => defaults.includes(lib));
}

/** `[[lean_lib]]` names from a lakefile.toml. */
export function leanLibraries(lakefile: string): string[] {
	const names: string[] = [];
	const pattern = /\[\[lean_lib\]\][^[]*?name\s*=\s*"([^"]+)"/g;
	let match;
	while ((match = pattern.exec(lakefile)) !== null) {
		names.push(match[1]);
	}
	return names;
}

async function checkLeanProject(env: Env, leanDir: string, elan: Tool | undefined): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	const lake = path.join(elanBin(env), exe(env, 'lake'));
	const elanCommand = elan?.command ?? path.join(elanBin(env), exe(env, 'elan'));
	const needsElan = 'Install Lean (elan) first.';

	const toolchain = env.readFile(path.join(leanDir, 'lean-toolchain'))?.trim();
	if (toolchain) {
		const base = { id: 'leanToolchain', group: 'project' as const, label: `Lean ${toolchain.replace(/^.*:/, '')}` };
		if (!elan) {
			results.push({ ...base, status: 'missing', detail: needsElan });
		} else {
			const list = await env.run(elanCommand, ['toolchain', 'list']);
			const installed = list.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s/)[0] === toolchain);
			results.push(
				installed
					? { ...base, status: 'ok', detail: `${toolchain} is installed.` }
					: {
							...base,
							status: 'missing',
							detail: `This project needs ${toolchain}.`,
							fix: {
								kind: 'steps',
								label: 'Install this Lean version',
								steps: [{ label: `Install ${toolchain}`, command: elanCommand, args: ['toolchain', 'install', toolchain], cwd: leanDir }],
							},
						},
			);
		}
	}

	if (toolchain) {
		const min = MIN_LEAN_FOR_KERNEL_CHECKS.join('.');
		results.push(
			supportsKernelChecks(toolchain)
				? { id: 'kernelChecks', group: 'project', label: 'Multi-kernel checks', status: 'ok', detail: `Available (Lean v${min} or later).` }
				: {
						id: 'kernelChecks',
						group: 'project',
						label: 'Multi-kernel checks',
						status: 'warning',
						detail: `Need Lean v${min} or later; this project pins ${toolchain}. Upgrade lean-toolchain and its libraries to use them.`,
					},
		);
	}

	const lakefile = env.readFile(path.join(leanDir, 'lakefile.toml')) ?? env.readFile(path.join(leanDir, 'lakefile.lean')) ?? '';
	if (/mathlib|physlib/i.test(lakefile)) {
		const base = { id: 'mathlibCache', group: 'project' as const, label: 'Mathlib (prebuilt)' };
		const olean = path.join(leanDir, '.lake', 'packages', 'mathlib', '.lake', 'build', 'lib', 'lean', 'Mathlib.olean');
		if (env.exists(olean)) {
			results.push({ ...base, status: 'ok', detail: 'Downloaded.' });
		} else {
			results.push({
				...base,
				status: 'missing',
				detail: elan ? 'Download the prebuilt Mathlib (several GB the first time).' : needsElan,
				fix: elan
					? {
							kind: 'steps',
							label: 'Download Mathlib',
							steps: [{ label: 'lake exe cache get', command: lake, args: ['exe', 'cache', 'get'], cwd: leanDir }],
						}
					: undefined,
			});
		}
	}

	const libraries = defaultLibraries(lakefile);
	if (libraries.length > 0) {
		const base = { id: 'leanBuild', group: 'project' as const, label: 'Lean project built' };
		const built = libraries.every((lib) => env.exists(path.join(leanDir, '.lake', 'build', 'lib', 'lean', `${lib}.olean`)));
		results.push(
			built
				? { ...base, status: 'ok', detail: `${libraries.join(', ')} built.` }
				: {
						...base,
						status: 'warning',
						detail: elan
							? 'Not built yet. The first build also compiles the Physlib files the project uses.'
							: needsElan,
						fix: elan
							? { kind: 'steps', label: 'Build', steps: [{ label: 'lake build', command: lake, args: ['build'], cwd: leanDir }] }
							: undefined,
					},
		);
	}

	return results;
}

/** Import names for a requirements.txt: `scikit-learn>=1` -> `scikit_learn`. */
export function requirementModules(requirements: string): string[] {
	return requirements
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*/, '').trim())
		.filter((line) => line.length > 0 && !line.startsWith('-'))
		.map((line) => line.split(/[<>=!~;\[\s]/)[0].toLowerCase().replace(/-/g, '_'))
		.filter((name) => /^[a-z_][a-z0-9_]*$/.test(name));
}

async function checkPythonProject(env: Env, workspace: string, python: Tool | undefined): Promise<CheckResult[]> {
	const requirements = env.readFile(path.join(workspace, 'requirements.txt'));
	if (requirements === undefined) {
		return [];
	}
	const venvPython =
		env.platform === 'win32'
			? path.join(workspace, '.venv', 'Scripts', 'python.exe')
			: path.join(workspace, '.venv', 'bin', 'python');
	const installRequirements: Step = {
		label: 'Install requirements.txt',
		command: venvPython,
		args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
		cwd: workspace,
	};
	const base = { id: 'venv', group: 'project' as const, label: 'Python environment (.venv)' };

	if (!env.exists(venvPython)) {
		// With the bundled Python, the environment reuses its packages
		// instead of downloading them: pip then finds requirements.txt
		// already satisfied.
		const bundled = env.bundledPython && env.exists(env.bundledPython) ? env.bundledPython : undefined;
		const create: Step | undefined = bundled
			? { label: 'Create .venv', command: bundled, args: ['-m', 'venv', '--system-site-packages', '.venv'], cwd: workspace }
			: python
				? { label: 'Create .venv', command: python.command, args: [...python.prefixArgs, '-m', 'venv', '.venv'], cwd: workspace }
				: undefined;
		return [
			{
				...base,
				status: 'missing',
				detail: create
					? bundled
						? "Create .venv from TheoremDesk's Python. Its packages are already there, so nothing downloads."
						: 'Create .venv and install requirements.txt.'
					: 'Install Python first.',
				fix: create ? { kind: 'steps', label: 'Create environment', steps: [create, installRequirements] } : undefined,
			},
		];
	}

	const modules = requirementModules(requirements);
	if (modules.length === 0) {
		return [{ ...base, status: 'ok', detail: 'Found.' }];
	}
	const imported = await env.run(venvPython, ['-c', `import ${modules.join(', ')}`], workspace);
	return [
		imported.ok
			? { ...base, status: 'ok', detail: `${modules.length} packages importable.` }
			: {
					...base,
					status: 'warning',
					detail: 'Some packages in requirements.txt are missing.',
					fix: { kind: 'steps', label: 'Install requirements', steps: [installRequirements] },
				},
	];
}

// ---------------------------------------------------------------------------

export async function runChecks(env: Env): Promise<CheckResult[]> {
	const [git, python, elan] = await Promise.all([
		findTool(env, [{ command: 'git' }], []),
		findPython(env),
		findElan(env),
	]);

	// With a built-in toolchain, Git, Python, Lean and TeX are TheoremDesk's
	// own: show their verified status, with Repair, instead of installers.
	const builtIn: CheckResult[] = (env.bundledStatus ?? []).map((s) => ({
		id: `builtin-${s.id}`,
		group: 'tools',
		label: `${s.label} (built in)`,
		status: s.ok ? 'ok' : 'missing',
		detail: s.ok ? s.detail : `${s.detail} Repair re-copies and re-checks the built-in tools.`,
		fix: s.ok ? undefined : { kind: 'vscodeCommand', label: 'Repair', command: 'theoremdesk.repairToolchain' },
	}));
	const tools = await Promise.all([
		...(env.bundledStatus
			? builtIn.map((r) => Promise.resolve(r))
			: [checkGit(env), checkPython(env, python), Promise.resolve(checkElan(elan)), checkTex(env)]),
		checkLongPaths(env, Boolean(git)),
		checkKernelSandbox(env),
	]);

	const project: CheckResult[] = [];
	if (env.workspace) {
		const leanDir = findLeanProject(env, env.workspace);
		const [lean, py] = await Promise.all([
			leanDir ? checkLeanProject(env, leanDir, elan) : Promise.resolve([]),
			checkPythonProject(env, env.workspace, python),
		]);
		project.push(...py, ...lean);
	}

	return [...tools.filter((r): r is CheckResult => r !== undefined), ...project];
}
