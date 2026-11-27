// Verify with All Kernels and Check Proof Against Statement: run Lean's
// `lake check --paranoid` / `lake comparator --paranoid` (sandboxed; through
// WSL on Windows) and show the verdict in the Verification view.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { runInTerminal } from './environment';
import {
	comparatorConfig,
	moduleName,
	parseVerification,
	sorryTheorems,
	supportsKernelChecks,
	Verification,
	verificationCommand,
	VerifyMode,
} from './kernels';

interface Run extends Verification {
	title: string;
	finished: Date;
}

type Item = { kind: 'summary'; run: Run } | { kind: 'line'; label: string; detail?: string; ok?: boolean };

export class VerificationView implements vscode.TreeDataProvider<Item> {
	private last: Run | undefined;
	private running: string | undefined;
	private readonly changed = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly wslVerifyScript: string) {}

	getTreeItem(item: Item): vscode.TreeItem {
		if (item.kind === 'summary') {
			const { run } = item;
			const tree = new vscode.TreeItem(run.title, vscode.TreeItemCollapsibleState.Expanded);
			tree.description = `${VERDICT_LABEL[run.verdict]} · ${run.finished.toLocaleTimeString()}`;
			tree.iconPath = VERDICT_ICON[run.verdict];
			tree.tooltip = run.summary;
			return tree;
		}
		const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
		tree.description = item.detail;
		tree.tooltip = item.detail;
		if (item.ok !== undefined) {
			tree.iconPath = item.ok ? VERDICT_ICON.accepted : VERDICT_ICON.rejected;
		}
		return tree;
	}

	getChildren(item?: Item): Item[] {
		if (!item) {
			if (this.running) {
				return [{ kind: 'line', label: `${this.running}...`, detail: 'see its terminal' }];
			}
			return this.last ? [{ kind: 'summary', run: this.last }] : [];
		}
		if (item.kind !== 'summary') {
			return [];
		}
		const run = item.run;
		const lines: Item[] = [{ kind: 'line', label: run.summary }];
		for (const problem of run.problems.filter((p) => p !== run.summary)) {
			lines.push({ kind: 'line', label: problem, ok: false });
		}
		for (const kernel of run.kernels) {
			lines.push({
				kind: 'line',
				label: `${kernel.name} kernel`,
				detail: kernel.detail ?? (kernel.accepted ? 'accepts' : kernel.accepted === false ? 'rejects' : 'no verdict'),
				ok: kernel.accepted,
			});
		}
		if (run.axioms.length > 0) {
			lines.push({ kind: 'line', label: 'Axioms', detail: run.axioms.join(', ') });
		}
		return lines;
	}

	async buildProject(): Promise<void> {
		const leanDir = await requireLeanProject(false);
		if (leanDir) {
			await this.run('Build', leanDir, { kind: 'build' });
		}
	}

	async checkWithLeanKernel(): Promise<void> {
		const leanDir = await requireLeanProject(true);
		if (leanDir) {
			await this.run("Check with Lean's kernel", leanDir, { kind: 'check', paranoid: false });
		}
	}

	async verifyProject(): Promise<void> {
		const leanDir = await requireLeanProject(true);
		if (leanDir) {
			await this.run('Verify with all kernels', leanDir, { kind: 'check', paranoid: true });
		}
	}

	async checkProof(): Promise<void> {
		const leanDir = await requireLeanProject(true);
		if (!leanDir) {
			return;
		}

		const leanFiles = (await vscode.workspace.findFiles(
			new vscode.RelativePattern(leanDir, '**/*.lean'),
			'**/.lake/**',
		)).map((uri) => uri.fsPath);

		const challenges = leanFiles
			.map((file) => ({ file, theorems: sorryTheorems(fs.readFileSync(file, 'utf8')) }))
			.filter((c) => c.theorems.length > 0);
		if (challenges.length === 0) {
			void vscode.window.showInformationMessage(
				'No theorems ending in `sorry` in this project. A statement to check against is a theorem whose proof is `sorry`.',
			);
			return;
		}
		const active = vscode.window.activeTextEditor?.document.uri.fsPath;
		const challengePick = await vscode.window.showQuickPick(
			challenges
				.map((c) => ({ label: moduleName(leanDir, c.file), description: `${c.theorems.length} unproved`, challenge: c }))
				.sort((a, b) => Number(b.challenge.file === active) - Number(a.challenge.file === active)),
			{ title: 'Check Proof Against Statement (1/3)', placeHolder: 'File with the statement (proved by sorry)' },
		);
		if (!challengePick) {
			return;
		}
		const challenge = challengePick.challenge;

		const theoremPicks = await vscode.window.showQuickPick(
			challenge.theorems.map((name) => ({ label: name, picked: true })),
			{ title: 'Check Proof Against Statement (2/3)', placeHolder: 'Theorems the proof must establish', canPickMany: true },
		);
		if (!theoremPicks || theoremPicks.length === 0) {
			return;
		}

		const solutionPick = await vscode.window.showQuickPick(
			leanFiles
				.filter((file) => file !== challenge.file)
				.map((file) => ({ label: moduleName(leanDir, file), file })),
			{ title: 'Check Proof Against Statement (3/3)', placeHolder: 'File with the proof (for example, the agent\'s)' },
		);
		if (!solutionPick) {
			return;
		}

		const config = comparatorConfig(
			moduleName(leanDir, challenge.file),
			solutionPick.label,
			theoremPicks.map((p) => p.label),
		);
		const configRelative = '.theoremdesk/comparator.json';
		fs.mkdirSync(path.join(leanDir, '.theoremdesk'), { recursive: true });
		fs.writeFileSync(path.join(leanDir, configRelative), JSON.stringify(config, null, '\t') + '\n');

		await this.run(`${solutionPick.label} against ${config.challenge_module}`, leanDir, {
			kind: 'comparator',
			config: configRelative,
		});
	}

	private async run(title: string, leanDir: string, mode: VerifyMode): Promise<void> {
		const command = verificationCommand(process.platform, os.homedir(), leanDir, this.wslVerifyScript, mode);
		if ('unsupported' in command) {
			void vscode.window.showWarningMessage(command.unsupported);
			return;
		}
		if (this.running) {
			void vscode.window.showInformationMessage(`${this.running} is still running.`);
			return;
		}

		this.running = title;
		this.changed.fire(undefined);
		await vscode.commands.executeCommand('theoremdesk.verification.focus');
		try {
			const { exitCode, output } = await runInTerminal({ label: title, ...command });
			this.last = { title, finished: new Date(), ...parseVerification(output, exitCode, mode.kind) };
		} finally {
			this.running = undefined;
			this.changed.fire(undefined);
		}

		const run = this.last;
		const message = `${title}: ${run.summary}`;
		if (run.verdict === 'accepted') {
			void vscode.window.showInformationMessage(message);
		} else if (run.verdict === 'rejected') {
			void vscode.window.showErrorMessage(message);
		} else {
			void vscode.window.showWarningMessage(message);
		}
	}
}

const VERDICT_LABEL: Record<Verification['verdict'], string> = {
	accepted: 'accepted',
	rejected: 'rejected',
	error: "couldn't run",
};

const VERDICT_ICON: Record<Verification['verdict'], vscode.ThemeIcon> = {
	accepted: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
	rejected: new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed')),
	error: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
};

/** The open workspace's Lean project folder, after checking it can be built or verified. */
async function requireLeanProject(forKernelChecks: boolean): Promise<string | undefined> {
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const leanDir = workspace
		? [workspace, path.join(workspace, 'lean')].find(
				(dir) => fs.existsSync(path.join(dir, 'lakefile.toml')) || fs.existsSync(path.join(dir, 'lakefile.lean')),
			)
		: undefined;
	if (!leanDir) {
		void vscode.window.showWarningMessage('Open a folder with a Lean project (a lakefile) first.');
		return undefined;
	}
	if (!forKernelChecks) {
		return leanDir;
	}
	const toolchain = fs.existsSync(path.join(leanDir, 'lean-toolchain'))
		? fs.readFileSync(path.join(leanDir, 'lean-toolchain'), 'utf8').trim()
		: '';
	if (!supportsKernelChecks(toolchain)) {
		void vscode.window.showWarningMessage(
			`Multi-kernel checks need Lean v4.35.0 or later; this project pins ${toolchain || 'an unknown version'}.`,
		);
		return undefined;
	}
	if (!fs.existsSync(path.join(leanDir, 'lake-manifest.json'))) {
		void vscode.window.showWarningMessage(
			'This Lean project has no lake-manifest.json yet. Build it once first (Environment view → Lean project built).',
		);
		return undefined;
	}
	return leanDir;
}
