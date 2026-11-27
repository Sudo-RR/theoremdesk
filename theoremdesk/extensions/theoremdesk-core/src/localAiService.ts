// Runs the bundled local AI inside the app: starts each model the first
// time something needs it, shows what's running in the status bar, stops
// models that have been idle (they hold gigabytes of memory), and offers
// the smaller 4B model on machines with less memory.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { chooseChatModel, downloadModel, findLocalAi, LlamaServer, LocalAi, ModelDownload, OpenAiClient, ServerKind, SMALL_MACHINE_GB } from './llm';
import { dataDirectory } from './tools';

const SMALL_MODEL_OFFERED = 'theoremdesk.ai.smallModelOffered';

export class LocalAiService implements vscode.Disposable {
	private ai: LocalAi | undefined;
	private readonly servers = new Map<ServerKind, LlamaServer>();
	private readonly starting = new Map<ServerKind, Promise<LlamaServer>>();
	private readonly lastUsed = new Map<ServerKind, number>();
	private readonly status = vscode.window.createStatusBarItem('theoremdesk.ai', vscode.StatusBarAlignment.Right, 90);
	private readonly idleTimer: NodeJS.Timeout;
	private readonly dataDir = dataDirectory(process.platform, process.env, os.homedir());

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly log: vscode.OutputChannel,
	) {
		this.refresh();
		this.status.name = 'TheoremDesk Local AI';
		this.status.command = 'theoremdesk.ai.status';
		this.update();
		this.idleTimer = setInterval(() => this.stopIdle(), 60_000);
	}

	/** Re-read the bundle and downloaded models. */
	refresh(): void {
		this.ai = findLocalAi(path.join(vscode.env.appRoot, '..', 'tools'), process.platform, this.dataDir);
	}

	get available(): boolean {
		return this.ai !== undefined;
	}

	private config() {
		return vscode.workspace.getConfiguration('theoremdesk.ai');
	}

	/** An OpenAI-compatible client for a running local model, starting it if needed. */
	async client(kind: ServerKind): Promise<OpenAiClient> {
		const server = await this.ensure(kind);
		this.lastUsed.set(kind, Date.now());
		return server.client();
	}

	private async ensure(kind: ServerKind): Promise<LlamaServer> {
		const running = this.servers.get(kind);
		if (running?.running) {
			return running;
		}
		const pending = this.starting.get(kind);
		if (pending) {
			return pending;
		}
		if (!this.ai) {
			throw new Error("This build of TheoremDesk doesn't include the local AI.");
		}
		const ai = this.ai;
		const model = kind === 'chat' ? chooseChatModel(ai, os.totalmem() / 2 ** 30, this.config().get<string>('localModel') || undefined) : ai.embedding;
		const start: Promise<LlamaServer> = Promise.resolve(vscode.window
			.withProgress(
				{ location: vscode.ProgressLocation.Window, title: `Loading ${shortName(model.name)}` },
				() =>
					LlamaServer.start(ai.server, kind, model, {
						contextTokens: this.config().get<number>('contextTokens', 32768),
						gpu: this.config().get<boolean>('useGpu', true),
						log: (line) => this.log.appendLine(line),
					}),
			)
			.then(
				(server) => {
					this.servers.set(kind, server);
					this.starting.delete(kind);
					this.update();
					return server;
				},
				(error: unknown) => {
					this.starting.delete(kind);
					this.log.appendLine(String(error instanceof Error ? error.message : error));
					throw error;
				},
			));
		this.starting.set(kind, start);
		this.update();
		return start;
	}

	stop(kind?: ServerKind): void {
		for (const [k, server] of this.servers) {
			if (!kind || k === kind) {
				server.stop();
				this.servers.delete(k);
				this.log.appendLine(`Stopped ${server.model.name}`);
			}
		}
		this.update();
	}

	private stopIdle(): void {
		const minutes = this.config().get<number>('idleMinutes', 15);
		if (minutes <= 0) {
			return;
		}
		for (const [kind] of this.servers) {
			if (Date.now() - (this.lastUsed.get(kind) ?? 0) > minutes * 60_000) {
				this.stop(kind);
			}
		}
	}

	private update(): void {
		if (!this.ai) {
			this.status.hide();
			return;
		}
		const chat = this.servers.get('chat');
		const loading = this.starting.size > 0;
		this.status.text = loading ? '$(loading~spin) Local AI' : chat ? `$(hubot) ${shortName(chat.model.name)}` : '$(hubot) Local AI';
		const lines = [...this.servers.values()].map((s) => `${shortName(s.model.name)} on ${s.backend()}`);
		this.status.tooltip = lines.length > 0 ? `Running: ${lines.join('; ')}\nClick for options.` : 'Local AI (starts when first used). Click for options.';
		this.status.show();
	}

	/** The status bar menu. */
	async showStatus(): Promise<void> {
		if (!this.ai) {
			void vscode.window.showWarningMessage("This build of TheoremDesk doesn't include the local AI.");
			return;
		}
		const items: (vscode.QuickPickItem & { run: () => unknown })[] = [];
		for (const server of this.servers.values()) {
			items.push({ label: `$(debug-stop) Stop ${shortName(server.model.name)}`, description: server.backend(), run: () => this.stop(server.kind) });
		}
		if (!this.servers.has('chat')) {
			items.push({ label: '$(play) Start the agent model', description: shortName(chooseChatModel(this.ai, os.totalmem() / 2 ** 30, this.config().get<string>('localModel') || undefined).name), run: () => this.ensure('chat') });
		}
		items.push({ label: '$(arrow-swap) Choose the local model...', run: () => this.chooseModel() });
		items.push({ label: '$(cloud-download) Download another model...', run: () => this.download() });
		items.push({ label: '$(output) Show log', run: () => this.log.show() });
		const pick = await vscode.window.showQuickPick(items, { title: 'TheoremDesk Local AI' });
		await pick?.run();
	}

	async chooseModel(): Promise<void> {
		this.refresh();
		if (!this.ai) {
			return;
		}
		const current = chooseChatModel(this.ai, os.totalmem() / 2 ** 30, this.config().get<string>('localModel') || undefined);
		const models = [this.ai.chat, ...this.ai.extraChat];
		const pick = await vscode.window.showQuickPick(
			models.map((m) => ({ label: shortName(m.name), description: m === this.ai!.chat ? 'bundled' : 'downloaded', detail: m.name, model: m, picked: m.path === current.path })),
			{ title: 'Local model for the agent' },
		);
		if (pick) {
			await this.config().update('localModel', pick.model === this.ai.chat ? '' : pick.model.file, vscode.ConfigurationTarget.Global);
			this.stop('chat');
		}
	}

	private catalog(): ModelDownload[] {
		return (JSON.parse(fs.readFileSync(this.context.asAbsolutePath(path.join('data', 'models.json')), 'utf8')) as { downloads: ModelDownload[] }).downloads;
	}

	async download(id?: string): Promise<void> {
		const catalog = this.catalog();
		const spec =
			catalog.find((m) => m.id === id) ??
			(
				await vscode.window.showQuickPick(
					catalog.map((m) => ({ label: m.name, description: `${(m.size / 1e9).toFixed(1)} GB`, detail: m.description, m })),
					{ title: 'Download a model' },
				)
			)?.m;
		if (!spec) {
			return;
		}
		const dir = path.join(this.dataDir, 'models');
		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Downloading ${spec.name}`, cancellable: true },
				async (progress, token) => {
					const abort = new AbortController();
					token.onCancellationRequested(() => abort.abort());
					let shown = 0;
					await downloadModel(
						spec,
						dir,
						(bytes, total) => {
							const pct = Math.floor((bytes / total) * 100);
							if (pct > shown) {
								progress.report({ increment: pct - shown, message: `${(bytes / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB` });
								shown = pct;
							}
						},
						abort.signal,
					);
				},
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!/abort/i.test(message)) {
				void vscode.window.showErrorMessage(`${message} It resumes where it stopped next time.`);
			}
			return;
		}
		this.refresh();
		const use = 'Use It';
		if ((await vscode.window.showInformationMessage(`${spec.name} is ready.`, use)) === use) {
			await this.config().update('localModel', spec.file, vscode.ConfigurationTarget.Global);
			this.stop('chat');
		}
	}

	/** On a machine with less memory, offer the faster 4B once. */
	async offerSmallModel(): Promise<void> {
		const memory = os.totalmem() / 2 ** 30;
		if (!this.ai || memory >= SMALL_MACHINE_GB || this.ai.extraChat.length > 0 || this.context.globalState.get(SMALL_MODEL_OFFERED)) {
			return;
		}
		await this.context.globalState.update(SMALL_MODEL_OFFERED, true);
		const spec = this.catalog().find((m) => m.id === 'qwen3.5-4b');
		if (!spec) {
			return;
		}
		const download = `Download (${(spec.size / 1e9).toFixed(1)} GB)`;
		const choice = await vscode.window.showInformationMessage(
			`This computer has ${memory.toFixed(0)} GB of memory. The built-in Qwen3.5-9B works, but ${spec.name} answers about twice as fast here.`,
			download,
			'Not Now',
		);
		if (choice === download) {
			await this.download(spec.id);
		}
	}

	dispose(): void {
		clearInterval(this.idleTimer);
		this.stop();
		this.status.dispose();
	}
}

/** "Qwen3.5-9B Q4_K_M (unsloth/...)" -> "Qwen3.5-9B". */
function shortName(name: string): string {
	return name.split(/\s+/)[0].replace(/-Q\d.*$/, '');
}
