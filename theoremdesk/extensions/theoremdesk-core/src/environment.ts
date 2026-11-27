// The Environment view: shows the checks from checks.ts, keeps a status bar
// summary, and runs fixes in visible terminals.

import { ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { CheckResult, Env, Fix, Group, runChecks, Status, Step } from './checks';

const RUN_TIMEOUT_MS = 20_000;

/** wsl.exe prints its own messages in UTF-16 unless told otherwise. */
const CHILD_ENV = { ...process.env, WSL_UTF8: '1' };

function nodeEnv(workspace: string | undefined, wslSetupScript: string): Env {
	return {
		wslSetupScript,
		platform: process.platform,
		home: os.homedir(),
		localAppData: process.env.LOCALAPPDATA,
		programFiles: process.env.ProgramFiles,
		workspace,
		run: (command, args, cwd) =>
			new Promise((resolve) => {
				execFile(command, args, { cwd, timeout: RUN_TIMEOUT_MS, windowsHide: true, env: CHILD_ENV }, (error, stdout, stderr) => {
					resolve({ ok: !error, stdout: `${stdout}${stderr ? `\n${stderr}` : ''}` });
				});
			}),
		exists: (file) => fs.existsSync(file),
		readFile: (file) => {
			try {
				return fs.readFileSync(file, 'utf8');
			} catch {
				return undefined;
			}
		},
		listDir: (dir) => {
			try {
				return fs.readdirSync(dir);
			} catch {
				return [];
			}
		},
	};
}

type Node = { kind: 'group'; group: Group } | { kind: 'check'; result: CheckResult };

const GROUP_LABELS: Record<Group, string> = { tools: 'Tools', project: 'This project' };

const ICONS: Record<Status, vscode.ThemeIcon> = {
	ok: new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')),
	warning: new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground')),
	missing: new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground')),
};

export class EnvironmentView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
	private results: CheckResult[] = [];
	private checking: Promise<CheckResult[]> | undefined;
	private readonly changed = new vscode.EventEmitter<Node | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

	constructor(private readonly wslSetupScript: string) {
		this.statusBar.command = 'theoremdesk.checkEnvironment';
		this.statusBar.name = 'TheoremDesk Environment';
		this.statusBar.text = '$(sync~spin) TheoremDesk';
		this.statusBar.show();
	}

	dispose(): void {
		this.statusBar.dispose();
		this.changed.dispose();
	}

	get issues(): CheckResult[] {
		return this.results.filter((r) => r.status !== 'ok');
	}

	/** Re-run every check; concurrent calls share one run. */
	refresh(): Promise<CheckResult[]> {
		if (!this.checking) {
			const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
			this.checking = runChecks(nodeEnv(workspace, this.wslSetupScript))
				.then((results) => {
					this.results = results;
					this.updateStatusBar();
					this.changed.fire(undefined);
					return results;
				})
				.finally(() => {
					this.checking = undefined;
				});
		}
		return this.checking;
	}

	private updateStatusBar(): void {
		const issues = this.issues;
		if (issues.length === 0) {
			this.statusBar.text = '$(check) TheoremDesk';
			this.statusBar.tooltip = 'Research environment ready';
			this.statusBar.backgroundColor = undefined;
		} else {
			this.statusBar.text = `$(tools) TheoremDesk: ${issues.length} to set up`;
			this.statusBar.tooltip = issues.map((r) => `${r.label}: ${r.detail}`).join('\n');
			this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
		}
	}

	getTreeItem(node: Node): vscode.TreeItem {
		if (node.kind === 'group') {
			const item = new vscode.TreeItem(GROUP_LABELS[node.group], vscode.TreeItemCollapsibleState.Expanded);
			item.contextValue = 'group';
			return item;
		}
		const { result } = node;
		const item = new vscode.TreeItem(result.label, vscode.TreeItemCollapsibleState.None);
		item.id = result.id;
		item.description = result.status === 'ok' ? result.detail : result.fix?.label ?? result.detail;
		item.tooltip = result.detail;
		item.iconPath = ICONS[result.status];
		item.contextValue = result.fix ? 'fixable' : 'check';
		if (result.fix) {
			item.command = { command: 'theoremdesk.environment.fix', title: result.fix.label, arguments: [node] };
		}
		return item;
	}

	getChildren(node?: Node): Node[] {
		if (!node) {
			const groups = (['tools', 'project'] as Group[]).filter((g) => this.results.some((r) => r.group === g));
			return groups.map((group) => ({ kind: 'group', group }));
		}
		if (node.kind === 'group') {
			return this.results.filter((r) => r.group === node.group).map((result) => ({ kind: 'check', result }));
		}
		return [];
	}

	async fix(node: Node | undefined): Promise<void> {
		if (!node || node.kind !== 'check' || !node.result.fix) {
			return;
		}
		await applyFix(node.result.fix);
		await this.refresh();
	}
}

async function applyFix(fix: Fix): Promise<void> {
	switch (fix.kind) {
		case 'vscodeCommand':
			await vscode.commands.executeCommand(fix.command);
			return;
		case 'restart':
			await vscode.window.showInformationMessage(
				'Quit TheoremDesk and open it again so it can see newly installed tools.',
				{ modal: true },
			);
			return;
		case 'steps':
			for (const step of fix.steps) {
				const exitCode = await runStep(step);
				if (exitCode !== 0) {
					void vscode.window.showErrorMessage(
						`"${step.label}" failed${exitCode === undefined ? '' : ` (exit code ${exitCode})`}. See its terminal for details.`,
					);
					return;
				}
			}
			return;
	}
}

async function runStep(step: Step): Promise<number | undefined> {
	return (await runInTerminal(step)).exitCode;
}

/**
 * Run one step in its own terminal so the user sees exactly what runs.
 * Resolves with the exit code and everything it printed once it ends.
 */
export function runInTerminal(step: Step): Promise<{ exitCode: number | undefined; output: string }> {
	let output = '';
	return new Promise((resolveRun) => {
		const resolve = (exitCode: number | undefined) => resolveRun({ exitCode, output });
		const writeEmitter = new vscode.EventEmitter<string>();
		const closeEmitter = new vscode.EventEmitter<number>();
		let child: ChildProcess | undefined;

		const pty: vscode.Pseudoterminal = {
			onDidWrite: writeEmitter.event,
			onDidClose: closeEmitter.event,
			open: () => {
				const shown = [step.command, ...step.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
				writeEmitter.fire(`\x1b[1m> ${shown}\x1b[0m\r\n${step.cwd ? `  in ${step.cwd}\r\n` : ''}\r\n`);
				child = spawn(step.command, step.args, { cwd: step.cwd, windowsHide: true, env: CHILD_ENV });
				const forward = (data: Buffer) => {
					const text = data.toString();
					output += text;
					writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
				};
				child.stdout?.on('data', forward);
				child.stderr?.on('data', forward);
				child.on('error', (error) => {
					writeEmitter.fire(`\r\n\x1b[31m${error.message}\x1b[0m\r\n`);
					resolve(undefined);
				});
				child.on('close', (code) => {
					const ok = code === 0;
					writeEmitter.fire(`\r\n\x1b[${ok ? '32' : '31'}m${ok ? 'Done.' : `Exited with code ${code}.`}\x1b[0m\r\n`);
					resolve(code ?? undefined);
				});
			},
			close: () => child?.kill(),
			// Some installers ask questions (winget asks you to accept terms): echo
			// what's typed and pass it on.
			handleInput: (data) => {
				writeEmitter.fire(data === '\r' ? '\r\n' : data);
				child?.stdin?.write(data === '\r' ? '\n' : data);
			},
		};

		const terminal = vscode.window.createTerminal({ name: `TheoremDesk: ${step.label}`, pty });
		terminal.show(true);
	});
}
