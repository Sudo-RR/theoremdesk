// Tests the environment checks against a fake machine.
// Run with `npm test` (compiles first).

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { leanLibraries, requirementModules, runChecks } = require('../out/checks');

const HOME = path.join(path.sep, 'home', 'r');
const WS = path.join(path.sep, 'work', 'proj');

/**
 * A fake Env. `programs` maps a command (or "command arg0") to its stdout;
 * anything not listed fails, like a missing program.
 */
function fakeEnv({ platform = 'linux', programs = {}, files = {}, dirs = {}, workspace } = {}) {
	return {
		platform,
		home: HOME,
		localAppData: platform === 'win32' ? 'C:\\Users\\r\\AppData\\Local' : undefined,
		programFiles: platform === 'win32' ? 'C:\\Program Files' : undefined,
		workspace,
		run: async (command, args) => {
			for (const key of [`${command} ${args.join(' ')}`, `${command} ${args[0] ?? ''}`.trim(), command]) {
				if (Object.prototype.hasOwnProperty.call(programs, key)) {
					const value = programs[key];
					return value === false ? { ok: false, stdout: '' } : { ok: true, stdout: value };
				}
			}
			return { ok: false, stdout: '' };
		},
		exists: (file) => Object.prototype.hasOwnProperty.call(files, file),
		readFile: (file) => files[file],
		listDir: (dir) => dirs[dir] ?? [],
	};
}

const ALL_TOOLS = {
	git: 'git version 2.47.1',
	python3: 'Python 3.11.9',
	elan: 'elan 4.1.2',
	pdflatex: 'pdfTeX 3.141592653',
	bibtex: 'BibTeX 0.99d',
	bwrap: 'bubblewrap 0.9.0',
};

const byId = (results) => Object.fromEntries(results.map((r) => [r.id, r]));

test('everything installed and no project: all ok', async () => {
	const results = byId(await runChecks(fakeEnv({ programs: ALL_TOOLS })));
	for (const id of ['git', 'python', 'elan', 'tex']) {
		assert.equal(results[id].status, 'ok', id);
	}
	assert.equal(results.longPaths, undefined, 'long paths only checked on Windows');
});

test('nothing installed on Windows: winget fixes and the Lean installer', async () => {
	const results = byId(await runChecks(fakeEnv({ platform: 'win32' })));
	assert.equal(results.git.status, 'missing');
	assert.deepEqual(results.git.fix.steps[0].args, ['install', '--id', 'Git.Git', '-e']);
	assert.equal(results.python.fix.steps[0].command, 'winget');
	assert.deepEqual(results.elan.fix, { kind: 'vscodeCommand', label: 'Install Lean', command: 'lean4.setup.installElan' });
	assert.deepEqual(results.tex.fix.steps[0].args, ['install', '--id', 'MiKTeX.MiKTeX', '-e']);
});

test('Python older than 3.10 is a warning with an install fix', async () => {
	const results = byId(await runChecks(fakeEnv({ programs: { ...ALL_TOOLS, python3: 'Python 3.8.10' } })));
	assert.equal(results.python.status, 'warning');
	assert.equal(results.python.fix.kind, 'steps');
});

test('py launcher is used on Windows when python is only the Store alias', async () => {
	const results = byId(
		await runChecks(fakeEnv({ platform: 'win32', programs: { python: false, 'py -3': 'Python 3.12.1' } })),
	);
	assert.equal(results.python.status, 'ok');
});

test('MiKTeX installed but not on PATH asks for a restart', async () => {
	const bin = path.join('C:\\Users\\r\\AppData\\Local', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64');
	const pdflatex = path.join(bin, 'pdflatex.exe');
	const bibtex = path.join(bin, 'bibtex.exe');
	const results = byId(
		await runChecks(
			fakeEnv({
				platform: 'win32',
				programs: { [pdflatex]: 'MiKTeX-pdfTeX 4.20', [bibtex]: 'BibTeX 0.99d' },
				files: { [pdflatex]: '', [bibtex]: '' },
			}),
		),
	);
	assert.equal(results.tex.status, 'warning');
	assert.equal(results.tex.fix.kind, 'restart');
});

test('Windows long paths: off in both places gives two steps, on gives ok', async () => {
	const off = byId(
		await runChecks(
			fakeEnv({
				platform: 'win32',
				programs: { git: 'git version 2.47', 'reg query': '    LongPathsEnabled    REG_DWORD    0x0', 'git config': '' },
			}),
		),
	);
	assert.equal(off.longPaths.status, 'warning');
	assert.equal(off.longPaths.fix.steps.length, 2);
	assert.deepEqual(off.longPaths.fix.steps[0].args, ['config', '--global', 'core.longpaths', 'true']);

	const on = byId(
		await runChecks(
			fakeEnv({
				platform: 'win32',
				programs: {
					git: 'git version 2.47',
					'reg query': '    LongPathsEnabled    REG_DWORD    0x1',
					'git config': 'true\n',
				},
			}),
		),
	);
	assert.equal(on.longPaths.status, 'ok');
});

const LAKEFILE = `name = "Hamiltonian"

[[require]]
name = "Physlib"
git = "https://github.com/leanprover-community/physlib.git"
rev = "v4.36.0"

[[lean_lib]]
name = "Hamiltonian"
`;

function projectFiles(extra = {}) {
	const lean = path.join(WS, 'lean');
	return {
		[path.join(WS, 'requirements.txt')]: 'sympy>=1.13\nscikit-learn\n# comment\nipykernel>=6\n',
		[path.join(lean, 'lakefile.toml')]: LAKEFILE,
		[path.join(lean, 'lean-toolchain')]: 'leanprover/lean4:v4.36.0\n',
		...extra,
	};
}

test('fresh project: venv, Mathlib and build all need doing, in order', async () => {
	const lean = path.join(WS, 'lean');
	const results = await runChecks(
		fakeEnv({
			programs: { ...ALL_TOOLS, 'elan toolchain': 'leanprover/lean4:v4.36.0 (default)\n' },
			files: projectFiles(),
			workspace: WS,
		}),
	);
	const project = results.filter((r) => r.group === 'project');
	assert.deepEqual(project.map((r) => r.id), ['venv', 'leanToolchain', 'kernelChecks', 'mathlibCache', 'leanBuild']);
	assert.equal(byId(project).kernelChecks.status, 'ok');
	const ids = byId(project);

	assert.equal(ids.venv.status, 'missing');
	assert.deepEqual(ids.venv.fix.steps.map((s) => s.args.slice(0, 2)), [['-m', 'venv'], ['-m', 'pip']]);
	assert.equal(ids.venv.fix.steps[0].cwd, WS);

	assert.equal(ids.leanToolchain.status, 'ok');

	assert.equal(ids.mathlibCache.status, 'missing');
	assert.deepEqual(ids.mathlibCache.fix.steps[0].args, ['exe', 'cache', 'get']);
	assert.equal(ids.mathlibCache.fix.steps[0].command, path.join(HOME, '.elan', 'bin', 'lake'));
	assert.equal(ids.mathlibCache.fix.steps[0].cwd, lean);

	assert.equal(ids.leanBuild.status, 'warning');
	assert.deepEqual(ids.leanBuild.fix.steps[0].args, ['build']);
});

test('set-up project: everything ok', async () => {
	const lean = path.join(WS, 'lean');
	const venvPython = path.join(WS, '.venv', 'bin', 'python');
	const results = await runChecks(
		fakeEnv({
			programs: {
				...ALL_TOOLS,
				'elan toolchain': 'leanprover/lean4:v4.36.0\n',
				[`${venvPython} -c import sympy, scikit_learn, ipykernel`]: '',
			},
			files: projectFiles({
				[venvPython]: '',
				[path.join(lean, '.lake', 'packages', 'mathlib', '.lake', 'build', 'lib', 'lean', 'Mathlib.olean')]: '',
				[path.join(lean, '.lake', 'build', 'lib', 'lean', 'Hamiltonian.olean')]: '',
			}),
			workspace: WS,
		}),
	);
	for (const r of results) {
		assert.equal(r.status, 'ok', `${r.id}: ${r.detail}`);
	}
});

test('missing Lean version offers elan toolchain install', async () => {
	const results = byId(
		await runChecks(
			fakeEnv({ programs: { ...ALL_TOOLS, 'elan toolchain': 'leanprover/lean4:v4.21.0\n' }, files: projectFiles(), workspace: WS }),
		),
	);
	assert.equal(results.leanToolchain.status, 'missing');
	assert.deepEqual(results.leanToolchain.fix.steps[0].args, ['toolchain', 'install', 'leanprover/lean4:v4.36.0']);
});

test('without elan, project Lean checks explain instead of offering broken fixes', async () => {
	const { elan, ...noElan } = ALL_TOOLS;
	const results = byId(await runChecks(fakeEnv({ programs: noElan, files: projectFiles(), workspace: WS })));
	assert.equal(results.mathlibCache.fix, undefined);
	assert.match(results.mathlibCache.detail, /elan/);
});

test('helpers', () => {
	assert.deepEqual(requirementModules('numpy>=2.0\nscikit-learn[all]==1.5 ; python_version>"3"\n-r other.txt\n\n'), [
		'numpy',
		'scikit_learn',
	]);
	assert.deepEqual(leanLibraries(LAKEFILE + '\n[[lean_lib]]\nname = "Extra"\n'), ['Hamiltonian', 'Extra']);
});

test('kernel checks sandbox: Linux needs bwrap, Windows needs WSL set up, macOS has no row', async () => {
	const linux = byId(await runChecks(fakeEnv({ programs: { ...ALL_TOOLS, bwrap: false } })));
	assert.equal(linux.kernelSandbox.status, 'missing');
	assert.deepEqual(linux.kernelSandbox.fix.steps[0].args, ['apt-get', 'install', '-y', 'bubblewrap']);
	const linuxOk = byId(await runChecks(fakeEnv({ programs: ALL_TOOLS })));
	assert.equal(linuxOk.kernelSandbox.status, 'ok');

	const noWsl = byId(await runChecks(fakeEnv({ platform: 'win32', programs: { git: 'git version 2' } })));
	assert.deepEqual(noWsl.kernelSandbox.fix.steps[0].args, ['--install', '-d', 'Ubuntu-24.04']);

	const script = 'C:/TD/resources/app/extensions/theoremdesk.theoremdesk-core/scripts/wsl-setup.sh';
	const env = fakeEnv({ platform: 'win32', programs: { 'wsl.exe --status': 'Default Version: 2' } });
	env.wslSetupScript = script;
	const notSetUp = byId(await runChecks(env));
	assert.equal(notSetUp.kernelSandbox.status, 'missing');
	assert.deepEqual(notSetUp.kernelSandbox.fix.steps[0].args, [
		'-e',
		'bash',
		'/mnt/c/TD/resources/app/extensions/theoremdesk.theoremdesk-core/scripts/wsl-setup.sh',
	]);

	const ready = byId(
		await runChecks(fakeEnv({ platform: 'win32', programs: { 'wsl.exe --status': 'ok', 'wsl.exe -e': '' } })),
	);
	assert.equal(ready.kernelSandbox.status, 'ok');

	const mac = byId(await runChecks(fakeEnv({ platform: 'darwin', programs: ALL_TOOLS })));
	assert.equal(mac.kernelSandbox, undefined);
});

test('old Lean versions are flagged for kernel checks', async () => {
	const files = projectFiles({ [path.join(WS, 'lean', 'lean-toolchain')]: 'leanprover/lean4:v4.30.0\n' });
	const results = byId(await runChecks(fakeEnv({ programs: ALL_TOOLS, files, workspace: WS })));
	assert.equal(results.kernelChecks.status, 'warning');
	assert.match(results.kernelChecks.detail, /v4\.35\.0/);
});
