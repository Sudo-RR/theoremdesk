// Run TheoremDesk's first-launch bootstrap (the core extension's own
// compiled code, out/bootstrap.js) outside the app, against a given data
// folder, and print the result as JSON. Exits 1 if any tool failed its check.
//
// Usage: node first_launch.js <extension out dir> <app resources dir> <data dir>

'use strict';

const fs = require('fs');
const path = require('path');

const [outDir, resources, dataDir] = process.argv.slice(2);
const { findBundledTools } = require(path.resolve(outDir, 'tools.js'));
const { bootstrap } = require(path.resolve(outDir, 'bootstrap.js'));

const nodeFs = {
	exists: (f) => fs.existsSync(f),
	readFile: (f) => {
		try {
			return fs.readFileSync(f, 'utf8');
		} catch {
			return undefined;
		}
	},
	listDir: (d) => {
		try {
			return fs.readdirSync(d);
		} catch {
			return [];
		}
	},
};

const tools = findBundledTools(path.join(path.resolve(resources), 'app'), process.platform, nodeFs);
if (!tools) {
	console.error(`No bundled toolchain in ${resources}`);
	process.exit(2);
}

bootstrap(tools, {
	platform: process.platform,
	dataDir: path.resolve(dataDir),
	baseEnv: process.env,
	log: (message) => console.error(message),
}).then((result) => {
	console.log(
		JSON.stringify({
			elanHome: result.elanHome,
			path: result.env.PATH,
			status: result.status,
			repaired: result.repaired,
		}),
	);
	process.exit(result.status.every((s) => s.ok) ? 0 : 1);
});
