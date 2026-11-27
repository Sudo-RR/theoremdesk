// Tests finding the bundled toolchain and wiring it onto PATH.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { findBundledTools, hasDefaultToolchain, pathAdditions, prependPath, toolchainDirName } = require('../out/tools');

function fakeFs(files, dirs = {}) {
	return {
		exists: (f) => Object.prototype.hasOwnProperty.call(files, f),
		readFile: (f) => files[f],
		listDir: (d) => dirs[d] ?? [],
	};
}

const APP = path.join('C:', 'TD', 'resources', 'app');
const TOOLS = path.join('C:', 'TD', 'resources', 'tools');

test('no bundled.json means no bundled tools', () => {
	assert.equal(findBundledTools(APP, 'win32', fakeFs({})), undefined);
});

test('finds the Windows bundle', () => {
	const tools = findBundledTools(
		APP,
		'win32',
		fakeFs({ [path.join(TOOLS, 'bundled.json')]: JSON.stringify({ lean: ['leanprover/lean4:v4.36.0'], elan: '4.4.0', git: '2.56.1 (MinGit)' }) }),
	);
	assert.equal(tools.python, path.join(TOOLS, 'python', 'python.exe'));
	assert.deepEqual(tools.pythonPath, [path.join(TOOLS, 'python'), path.join(TOOLS, 'python', 'Scripts')]);
	assert.equal(tools.texBin, path.join(TOOLS, 'tinytex', 'bin', 'windows'));
	assert.equal(tools.elanInit, path.join(TOOLS, 'lean', 'elan-init.exe'));
	assert.equal(tools.elanBin, path.join(TOOLS, 'lean', 'elan-home', 'bin'));
	assert.equal(tools.gitBin, path.join(TOOLS, 'git', 'cmd'));
	assert.deepEqual(tools.toolchains, [
		{ name: 'leanprover/lean4:v4.36.0', dir: path.join(TOOLS, 'lean', 'toolchains', 'leanprover--lean4---v4.36.0') },
	]);
	const elanHome = path.join('C:', 'Users', 'r', 'AppData', 'Local', 'TheoremDesk', 'elan');
	assert.deepEqual(pathAdditions(tools, elanHome), [
		path.join(TOOLS, 'python'),
		path.join(TOOLS, 'python', 'Scripts'),
		path.join(TOOLS, 'tinytex', 'bin', 'windows'),
		path.join(TOOLS, 'git', 'cmd'),
		path.join(elanHome, 'bin'),
	]);
});

test('finds the TeX binaries folder on Linux and macOS', () => {
	const tools = findBundledTools(
		APP,
		'linux',
		fakeFs({ [path.join(TOOLS, 'bundled.json')]: '{"lean":[]}' }, { [path.join(TOOLS, 'tinytex', 'bin')]: ['x86_64-linux'] }),
	);
	assert.equal(tools.texBin, path.join(TOOLS, 'tinytex', 'bin', 'x86_64-linux'));
	assert.equal(tools.python, path.join(TOOLS, 'python', 'bin', 'python3'));
	assert.equal(tools.gitBin, undefined, 'Linux uses the system Git');
});

test("TheoremDesk's own data folder, per platform", () => {
	const { dataDirectory, activeElanHome } = require('../out/tools');
	assert.equal(dataDirectory('win32', { LOCALAPPDATA: 'C:/L' }, 'C:/Users/r'), path.join('C:/L', 'TheoremDesk'));
	assert.equal(dataDirectory('win32', {}, 'C:/Users/r'), path.join('C:/Users/r', 'AppData', 'Local', 'TheoremDesk'));
	assert.equal(dataDirectory('linux', {}, '/home/r'), path.join('/home/r', '.local', 'share', 'theoremdesk'));
	assert.equal(dataDirectory('linux', { XDG_DATA_HOME: '/x' }, '/home/r'), path.join('/x', 'theoremdesk'));
	assert.equal(dataDirectory('darwin', {}, '/Users/r'), path.join('/Users/r', 'Library', 'Application Support', 'TheoremDesk'));
	assert.equal(activeElanHome({ ELAN_HOME: '/td/elan' }, '/home/r'), '/td/elan');
	assert.equal(activeElanHome({}, '/home/r'), path.join('/home/r', '.elan'));
});

test('elan folder names', () => {
	assert.equal(toolchainDirName('leanprover/lean4:v4.36.0'), 'leanprover--lean4---v4.36.0');
});

test('PATH: bundled folders go first, once', () => {
	assert.equal(prependPath('C:\\a;C:\\tools\\py;C:\\b', ['C:\\tools\\py', 'C:\\tex'], ';', 'win32'), 'C:\\tools\\py;C:\\tex;C:\\a;C:\\b');
	assert.equal(prependPath('c:\\TOOLS\\PY\\', ['C:\\tools\\py'], ';', 'win32'), 'C:\\tools\\py', 'case-insensitive on Windows');
	assert.equal(prependPath('/usr/bin:/A', ['/a'], ':', 'linux'), '/a:/usr/bin:/A', 'case-sensitive elsewhere');
	assert.equal(prependPath(undefined, ['/a'], ':', 'linux'), '/a');
});

test('elan default toolchain detection', () => {
	assert.ok(hasDefaultToolchain('default_toolchain = "leanprover/lean4:v4.36.0"\n'));
	assert.ok(!hasDefaultToolchain('telemetry = false\n'));
	assert.ok(!hasDefaultToolchain(undefined));
});
