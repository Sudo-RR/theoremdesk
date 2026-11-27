// The toolchain bundled with TheoremDesk (Python, TinyTeX, Lean, and Git on
// Windows), found next to the app in resources/tools (see
// theoremdesk/bundle_tools.sh). Free of the `vscode` API so it can be tested
// with plain Node.

import * as path from 'path';

export interface BundledTools {
	root: string;
	python: string;
	/** Folders to put on PATH for Python and its scripts (jupyter, pip). */
	pythonPath: string[];
	/** Folder holding pdflatex and bibtex. */
	texBin: string;
	/** elan's installer (kept as a fallback). */
	elanInit: string;
	/** A ready elan bin folder (elan and its lean/lake proxies), laid out at build time. */
	elanBin: string;
	elanVersion: string;
	/** Bundled Git's folder for PATH, if this build bundles Git (Windows). */
	gitBin?: string;
	/** Bundled Lean toolchains: their elan name and folder. */
	toolchains: { name: string; dir: string }[];
}

interface Fs {
	exists(file: string): boolean;
	readFile(file: string): string | undefined;
	listDir(dir: string): string[];
}

/** `leanprover/lean4:v4.36.0` -> `leanprover--lean4---v4.36.0`, elan's folder name. */
export function toolchainDirName(toolchain: string): string {
	return toolchain.replace(/\//g, '--').replace(/:/g, '---');
}

export function exe(platform: NodeJS.Platform, name: string): string {
	return platform === 'win32' ? `${name}.exe` : name;
}

/** The bundled tools for an app whose `vscode.env.appRoot` is `appRoot`, if any. */
export function findBundledTools(appRoot: string, platform: NodeJS.Platform, fs: Fs): BundledTools | undefined {
	const root = path.join(appRoot, '..', 'tools');
	const manifest = fs.readFile(path.join(root, 'bundled.json'));
	if (manifest === undefined) {
		return undefined;
	}
	const bundled = JSON.parse(manifest) as { lean?: string[]; elan?: string; git?: string };
	const win = platform === 'win32';

	const python = win ? path.join(root, 'python', 'python.exe') : path.join(root, 'python', 'bin', 'python3');
	const pythonPath = win
		? [path.join(root, 'python'), path.join(root, 'python', 'Scripts')]
		: [path.join(root, 'python', 'bin')];

	const binRoot = path.join(root, 'tinytex', 'bin');
	const texArch = win ? 'windows' : fs.listDir(binRoot)[0] ?? '';
	const texBin = path.join(binRoot, texArch);

	const toolchains = (bundled.lean ?? []).map((name) => ({
		name,
		dir: path.join(root, 'lean', 'toolchains', toolchainDirName(name)),
	}));

	return {
		root,
		python,
		pythonPath,
		texBin,
		elanInit: path.join(root, 'lean', exe(platform, 'elan-init')),
		elanBin: path.join(root, 'lean', 'elan-home', 'bin'),
		elanVersion: bundled.elan ?? '',
		gitBin: bundled.git ? path.join(root, 'git', 'cmd') : undefined,
		toolchains,
	};
}

/**
 * Where TheoremDesk keeps its own, writable state, such as its elan home:
 * %LOCALAPPDATA%\TheoremDesk, ~/Library/Application Support/TheoremDesk,
 * or $XDG_DATA_HOME/theoremdesk.
 */
export function dataDirectory(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
	if (platform === 'win32') {
		return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'TheoremDesk');
	}
	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'TheoremDesk');
	}
	return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'theoremdesk');
}

/** Folders to put in front of PATH so the bundled tools are found first. */
export function pathAdditions(tools: BundledTools, elanHome: string): string[] {
	return [...tools.pythonPath, tools.texBin, ...(tools.gitBin ? [tools.gitBin] : []), path.join(elanHome, 'bin')];
}

/** Put `additions` at the front of a PATH value, without duplicating them. */
export function prependPath(current: string | undefined, additions: string[], delimiter: string, platform: NodeJS.Platform): string {
	const norm = (p: string) => (platform === 'win32' ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
	const added = new Set(additions.map(norm));
	const rest = (current ?? '').split(delimiter).filter((p) => p && !added.has(norm(p)));
	return [...additions, ...rest].join(delimiter);
}

/** Whether elan's settings.toml names a default toolchain. */
export function hasDefaultToolchain(settingsToml: string | undefined): boolean {
	return settingsToml !== undefined && /^\s*default_toolchain\s*=\s*"[^"]+"/m.test(settingsToml);
}

/** The elan home Lean commands should use: TheoremDesk's own once set up, else ~/.elan. */
export function activeElanHome(env: NodeJS.ProcessEnv = process.env, home: string = require('os').homedir()): string {
	return env.ELAN_HOME || path.join(home, '.elan');
}
