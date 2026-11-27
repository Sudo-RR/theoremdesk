// Wire the bundled toolchain into the app on every launch: bootstrap it
// (bootstrap.ts), then point the Lean extension, LaTeX Workshop, Jupyter
// and terminals at it.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { bootstrap, BootstrapResult } from './bootstrap';
import { BundledTools, dataDirectory, findBundledTools } from './tools';

const nodeFs = {
	exists: (file: string) => fs.existsSync(file),
	readFile: (file: string) => {
		try {
			return fs.readFileSync(file, 'utf8');
		} catch {
			return undefined;
		}
	},
	listDir: (dir: string) => {
		try {
			return fs.readdirSync(dir);
		} catch {
			return [];
		}
	},
};

export interface Toolchain {
	tools: BundledTools;
	result: BootstrapResult;
}

/**
 * Make the bundled toolchain ready and point everything at it. Returns
 * undefined when this build doesn't bundle one (a development build).
 */
export async function provisionBundledTools(
	context: vscode.ExtensionContext,
	log: vscode.OutputChannel,
): Promise<Toolchain | undefined> {
	const tools = findBundledTools(vscode.env.appRoot, process.platform, nodeFs);
	if (!tools) {
		log.appendLine('No bundled toolchain in this build.');
		return undefined;
	}
	const result = await bootstrap(tools, {
		platform: process.platform,
		dataDir: dataDirectory(process.platform, process.env, os.homedir()),
		baseEnv: process.env,
		log: (message) => log.appendLine(message),
	});
	applyEnvironment(context, result);
	await ensurePythonDefault(tools, log);

	const failed = result.status.filter((s) => !s.ok);
	if (failed.length > 0) {
		const show = 'Show Details';
		void vscode.window
			.showErrorMessage(
				`TheoremDesk's built-in ${failed.map((s) => s.label).join(', ')} ${failed.length === 1 ? "isn't" : "aren't"} working. Reinstalling TheoremDesk will fix this.`,
				show,
			)
			.then((choice) => choice === show && log.show());
	}
	return { tools, result };
}

/** Re-run the bootstrap from scratch: re-copy elan, re-link Lean, re-check everything. */
export async function repairToolchain(
	context: vscode.ExtensionContext,
	toolchain: Toolchain,
	log: vscode.OutputChannel,
): Promise<Toolchain> {
	const elanBin = path.join(toolchain.result.elanHome, 'bin');
	fs.rmSync(elanBin, { recursive: true, force: true }); // forces a fresh copy
	const result = await bootstrap(toolchain.tools, {
		platform: process.platform,
		dataDir: path.dirname(toolchain.result.elanHome),
		baseEnv: process.env,
		log: (message) => log.appendLine(message),
	});
	applyEnvironment(context, result);
	return { tools: toolchain.tools, result };
}

function applyEnvironment(context: vscode.ExtensionContext, result: BootstrapResult): void {
	// Other extensions in this extension host (Lean, LaTeX Workshop, Jupyter)
	// start their tools from process.env, so this is how they find ours. TheoremDesk
	// activates first ("*"), before they start anything.
	process.env.ELAN_HOME = result.elanHome;
	process.env.PATH = result.env.PATH;
	if (process.platform === 'win32') {
		delete process.env.Path;
	}

	// Integrated terminals get the same.
	const collection = context.environmentVariableCollection;
	collection.description = 'TheoremDesk: built-in Lean, Python, LaTeX and Git';
	collection.replace('ELAN_HOME', result.elanHome);
	collection.prepend('PATH', result.pathAdditions.join(path.delimiter) + path.delimiter);
}

async function ensurePythonDefault(tools: BundledTools, log: vscode.OutputChannel): Promise<void> {
	const config = vscode.workspace.getConfiguration('python');
	const current = config.inspect<string>('defaultInterpreterPath');
	if (current?.globalValue === undefined && fs.existsSync(tools.python)) {
		await config.update('defaultInterpreterPath', tools.python, vscode.ConfigurationTarget.Global);
		log.appendLine(`Default Python interpreter: ${tools.python}`);
	}
}
