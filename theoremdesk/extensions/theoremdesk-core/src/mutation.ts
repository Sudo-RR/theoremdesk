// Mutation Test This File: generate mutants of the open Lean file, compile
// each with `lake env lean`, and show which ones survive.

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { activeElanHome } from './tools';
import {
	applyMutant,
	classify,
	generateMutants,
	Mutant,
	parseDiagnostics,
	sorryDeclarations,
	summarize,
	Summary,
	Verdict,
} from './mutate';

/** A mutant taking longer than this probably sent a tactic into a loop. */
const MUTANT_TIMEOUT_MS = 180_000;

interface Result {
	mutant: Mutant;
	verdict: Verdict;
	file: string;
}

interface Run {
	source: vscode.Uri;
	results: Result[];
	summary: Summary;
	sorry: string[];
	finished: Date;
}

type Item =
	| { kind: 'summary'; run: Run }
	| { kind: 'group'; verdict: Verdict; results: Result[] }
	| { kind: 'result'; result: Result; run: Run }
	| { kind: 'note'; label: string };

const GROUP_LABEL: Record<Verdict, string> = {
	survived: 'Survived: nothing caught these',
	killed: 'Killed: a proof broke',
	timeout: 'Timed out',
	stillborn: "Stillborn: the mutant didn't elaborate",
};

const ICON: Record<Verdict, vscode.ThemeIcon> = {
	survived: new vscode.ThemeIcon('bug', new vscode.ThemeColor('problemsWarningIcon.foreground')),
	killed: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
	timeout: new vscode.ThemeIcon('watch'),
	stillborn: new vscode.ThemeIcon('circle-slash'),
};

export class MutationView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
	private last: Run | undefined;
	private readonly changed = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('TheoremDesk mutations');
	private running = false;

	dispose(): void {
		this.diagnostics.dispose();
		this.changed.dispose();
	}

	getTreeItem(item: Item): vscode.TreeItem {
		switch (item.kind) {
			case 'summary': {
				const { summary } = item.run;
				const tree = new vscode.TreeItem(path.basename(item.run.source.fsPath), vscode.TreeItemCollapsibleState.Expanded);
				tree.description = `${summary.survived} survived · ${summary.killed} killed · ${summary.stillborn} stillborn${summary.timeout ? ` · ${summary.timeout} timed out` : ''}`;
				tree.iconPath = summary.survived > 0 ? ICON.survived : ICON.killed;
				return tree;
			}
			case 'group': {
				const tree = new vscode.TreeItem(
					`${GROUP_LABEL[item.verdict]} (${item.results.length})`,
					item.verdict === 'survived' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
				);
				tree.iconPath = ICON[item.verdict];
				return tree;
			}
			case 'result': {
				const { mutant } = item.result;
				const tree = new vscode.TreeItem(mutant.description, vscode.TreeItemCollapsibleState.None);
				tree.description = `${mutant.declaration} · line ${mutant.line}`;
				tree.tooltip = `${mutant.region === 'statement' ? 'Statement' : 'Definition'} of ${mutant.declaration}, line ${mutant.line}. Click to compare with your file.`;
				tree.iconPath = ICON[item.result.verdict];
				tree.command = {
					command: 'theoremdesk.mutations.showDiff',
					title: 'Compare',
					arguments: [item.run.source, item.result],
				};
				return tree;
			}
			case 'note':
				return new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
		}
	}

	getChildren(item?: Item): Item[] {
		if (!item) {
			if (this.running) {
				return [{ kind: 'note', label: 'Running mutants... (see the progress notification)' }];
			}
			return this.last ? [{ kind: 'summary', run: this.last }] : [];
		}
		if (item.kind === 'summary') {
			const run = item.run;
			const children: Item[] = [];
			if (run.sorry.length > 0) {
				children.push({
					kind: 'note',
					label: `Not tested: ${run.sorry.join(', ')} ${run.sorry.length === 1 ? 'is' : 'are'} proved by sorry, which accepts any statement.`,
				});
			}
			for (const verdict of ['survived', 'killed', 'timeout', 'stillborn'] as Verdict[]) {
				const results = run.results.filter((r) => r.verdict === verdict);
				if (results.length > 0) {
					children.push({ kind: 'group', verdict, results });
				}
			}
			return children;
		}
		if (item.kind === 'group' && this.last) {
			return item.results.map((result) => ({ kind: 'result', result, run: this.last! }));
		}
		return [];
	}

	async run(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.languageId !== 'lean4') {
			void vscode.window.showWarningMessage('Open the Lean file you want to mutation test.');
			return;
		}
		if (this.running) {
			void vscode.window.showInformationMessage('A mutation test is already running.');
			return;
		}
		const document = editor.document;
		if (document.isDirty) {
			await document.save();
		}
		const leanDir = findLeanDir(document.uri.fsPath);
		if (!leanDir) {
			void vscode.window.showWarningMessage('This file is not inside a Lean project (no lakefile found above it).');
			return;
		}

		const source = document.getText();
		const mutants = generateMutants(source);
		const sorry = sorryDeclarations(source);
		if (mutants.length === 0) {
			void vscode.window.showInformationMessage(
				sorry.length > 0
					? `Nothing to mutate: ${sorry.join(', ')} ${sorry.length === 1 ? 'is' : 'are'} proved by sorry, and the file has no definitions with bodies.`
					: 'Nothing to mutate in this file.',
			);
			return;
		}

		const lake = path.join(activeElanHome(), 'bin', process.platform === 'win32' ? 'lake.exe' : 'lake');
		const workDir = path.join(
			os.tmpdir(),
			'theoremdesk-mutants',
			crypto.createHash('sha1').update(document.uri.fsPath).digest('hex').slice(0, 10),
		);
		fs.rmSync(workDir, { recursive: true, force: true });
		fs.mkdirSync(workDir, { recursive: true });

		this.running = true;
		this.diagnostics.delete(document.uri);
		this.changed.fire(undefined);
		await vscode.commands.executeCommand('theoremdesk.mutations.focus');

		try {
			const results = await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Mutation testing ${path.basename(document.uri.fsPath)}`,
					cancellable: true,
				},
				async (progress, token) => {
					// The unmutated file must compile, or every mutant looks killed.
					progress.report({ message: 'compiling the original' });
					const baselineFile = path.join(workDir, 'Original.lean');
					fs.writeFileSync(baselineFile, source);
					const baseline = await compile(lake, leanDir, baselineFile, token);
					const baselineErrors = parseDiagnostics(baseline.output).filter((d) => d.severity === 'error');
					if (baselineErrors.length > 0 || baseline.exitCode !== 0) {
						const first = baselineErrors[0];
						throw new Error(
							first
								? `The file doesn't compile as it is (line ${first.line}: ${first.message}). Fix it or build the project first.`
								: `The file doesn't compile as it is. ${baseline.output.trim().split('\n').pop() ?? ''}`,
						);
					}

					const results: Result[] = [];
					let done = 0;
					const queue = [...mutants];
					const workers = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
					const worker = async () => {
						let mutant: Mutant | undefined;
						while ((mutant = queue.shift()) !== undefined && !token.isCancellationRequested) {
							const mutated = applyMutant(source, mutant);
							const file = path.join(workDir, `Mutant${mutant.id}.lean`);
							fs.writeFileSync(file, mutated);
							const { output, exitCode, timedOut } = await compile(lake, leanDir, file, token);
							const verdict: Verdict = timedOut ? 'timeout' : classify(mutated, output, exitCode, mutant);
							results.push({ mutant, verdict, file });
							done++;
							progress.report({
								message: `${done}/${mutants.length} (${results.filter((r) => r.verdict === 'survived').length} survived)`,
								increment: 100 / mutants.length,
							});
						}
					};
					await Promise.all(Array.from({ length: workers }, worker));
					return results.sort((a, b) => a.mutant.id - b.mutant.id);
				},
			);

			this.last = { source: document.uri, results, summary: summarize(results.map((r) => r.verdict)), sorry, finished: new Date() };
			this.showSurvivors(document, results);
			const { survived, killed } = this.last.summary;
			const message = `${survived} of ${results.length} mutants survived, ${killed} killed.`;
			if (survived > 0) {
				void vscode.window.showWarningMessage(`${message} Survivors show where your theorems don't pin down what you meant.`);
			} else {
				void vscode.window.showInformationMessage(`${message} Every mutation that elaborated broke a proof.`);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Mutation test stopped: ${(error as Error).message}`);
		} finally {
			this.running = false;
			this.changed.fire(undefined);
		}
	}

	private showSurvivors(document: vscode.TextDocument, results: Result[]): void {
		const diagnostics = results
			.filter((r) => r.verdict === 'survived')
			.map(({ mutant }) => {
				const start = document.positionAt(mutant.offset);
				const end = document.positionAt(mutant.offset + mutant.original.length);
				const diagnostic = new vscode.Diagnostic(
					new vscode.Range(start, end),
					survivorMessage(mutant),
					vscode.DiagnosticSeverity.Warning,
				);
				diagnostic.source = 'TheoremDesk mutation test';
				return diagnostic;
			});
		this.diagnostics.set(document.uri, diagnostics);
	}

	async showDiff(source: vscode.Uri, result: Result): Promise<void> {
		await vscode.commands.executeCommand(
			'vscode.diff',
			source,
			vscode.Uri.file(result.file),
			`${path.basename(source.fsPath)} ↔ mutant: ${result.mutant.description} (${result.verdict})`,
		);
	}
}

function survivorMessage(mutant: Mutant): string {
	const what = `Mutant survived: ${mutant.description}`;
	if (mutant.region === 'definition') {
		return `${what} in ${mutant.declaration}, and every theorem still compiles. No theorem constrains this part of the definition.`;
	}
	if (mutant.operator === 'hypothesis') {
		return `${what} from ${mutant.declaration}, and its proof still goes through. The proof never uses this hypothesis.`;
	}
	if (mutant.position === 'hypothesis') {
		return `${what} in a hypothesis of ${mutant.declaration}, and its proof still goes through. The hypothesis is stronger than the proof needs, or not used as you meant.`;
	}
	return `${what} in the conclusion of ${mutant.declaration}, and the same proof proves it. The hypotheses may be contradictory, or the conclusion says less than you meant.`;
}

function findLeanDir(file: string): string | undefined {
	let dir = path.dirname(file);
	while (true) {
		if (fs.existsSync(path.join(dir, 'lakefile.toml')) || fs.existsSync(path.join(dir, 'lakefile.lean'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

function compile(
	lake: string,
	cwd: string,
	file: string,
	token: vscode.CancellationToken,
): Promise<{ output: string; exitCode: number | undefined; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = execFile(
			lake,
			['env', 'lean', file],
			{ cwd, timeout: MUTANT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				const timedOut = Boolean(error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed);
				const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1) : 0;
				resolve({ output: `${stdout}\n${stderr}`, exitCode: code, timedOut: timedOut && !token.isCancellationRequested });
			},
		);
		token.onCancellationRequested(() => child.kill());
	});
}
