// Where the agent's model runs: TheoremDesk's local model (default), or a
// provider's API with the user's key (OpenAI, Anthropic, or any
// OpenAI-compatible service such as OpenRouter or a Hugging Face endpoint).
//
// ChatGPT (Plus/Pro) and Claude (Pro/Max) subscriptions are used through
// the providers' own agents, OpenAI's Codex and Anthropic's Claude Code,
// which sign in with the subscription. TheoremDesk opens them in a
// terminal, connected to its literature MCP server.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChatModel } from './agent';
import { OpenAiClient } from './llm';
import { LocalAiService } from './localAiService';

export type ProviderId = 'local' | 'openai' | 'anthropic' | 'custom';

interface ProviderInfo {
	id: ProviderId;
	label: string;
	baseUrl?: string;
	defaultModel?: string;
	keyHelp?: string;
}

export const PROVIDERS: ProviderInfo[] = [
	{ id: 'local', label: 'TheoremDesk Local (offline, free)' },
	{ id: 'openai', label: 'OpenAI API', baseUrl: 'https://api.openai.com/v1', keyHelp: 'https://platform.openai.com/api-keys' },
	// Anthropic's OpenAI-compatible endpoint.
	{ id: 'anthropic', label: 'Anthropic API', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-5-5', keyHelp: 'https://console.anthropic.com/settings/keys' },
	{ id: 'custom', label: 'Other OpenAI-compatible API (OpenRouter, Hugging Face, a server of your own)' },
];

const secretKey = (id: ProviderId) => `theoremdesk.agent.apiKey.${id}`;

export class Providers {
	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly ai: LocalAiService,
	) {}

	private config() {
		return vscode.workspace.getConfiguration('theoremdesk.agent');
	}

	current(): ProviderId {
		const id = this.config().get<string>('provider', 'local') as ProviderId;
		return PROVIDERS.some((p) => p.id === id) ? id : 'local';
	}

	label(): string {
		const id = this.current();
		if (id === 'local') {
			return 'TheoremDesk Local';
		}
		return `${PROVIDERS.find((p) => p.id === id)!.label.replace(/ \(.*$/, '')} · ${this.config().get<string>('model') || '(no model set)'}`;
	}

	/** The model to chat with, for the chosen provider. */
	async model(): Promise<ChatModel> {
		const id = this.current();
		if (id === 'local') {
			return this.ai.client('chat');
		}
		const info = PROVIDERS.find((p) => p.id === id)!;
		const baseUrl = (id === 'custom' ? this.config().get<string>('baseUrl') : info.baseUrl)?.replace(/\/+$/, '');
		const model = this.config().get<string>('model') || info.defaultModel;
		const key = await this.context.secrets.get(secretKey(id));
		if (!baseUrl || !model || !key) {
			throw new Error(`${info.label} isn't set up yet: choose it again from the Model button to enter ${!key ? 'its API key' : !model ? 'a model' : 'its address'}.`);
		}
		return new OpenAiClient(baseUrl, key, model);
	}

	/** Pick a provider, or open Codex or Claude Code for a subscription. */
	async choose(): Promise<void> {
		const items: (vscode.QuickPickItem & { run: () => Promise<void> })[] = [
			...PROVIDERS.map((p) => ({ label: p.label, description: p.id === this.current() ? 'current' : undefined, run: () => this.setUp(p) })),
			{ label: '', kind: vscode.QuickPickItemKind.Separator, run: async () => undefined },
			{ label: 'ChatGPT Plus or Pro: open Codex', detail: "OpenAI's agent signs in with your ChatGPT plan; it gets TheoremDesk's literature tools.", run: () => openCliAgent(this.context, 'codex') },
			{ label: 'Claude Pro or Max: open Claude Code', detail: "Anthropic's agent signs in with your Claude plan; it gets TheoremDesk's literature tools.", run: () => openCliAgent(this.context, 'claude') },
		];
		const pick = await vscode.window.showQuickPick(items, { title: 'Model for the TheoremDesk agent' });
		await pick?.run();
	}

	private async setUp(p: ProviderInfo): Promise<void> {
		if (p.id !== 'local') {
			if (p.id === 'custom') {
				const url = await vscode.window.showInputBox({ title: 'API address (OpenAI-compatible)', value: this.config().get<string>('baseUrl') || 'https://router.huggingface.co/v1', prompt: 'e.g. https://openrouter.ai/api/v1 or https://router.huggingface.co/v1' });
				if (!url) {
					return;
				}
				await this.config().update('baseUrl', url, vscode.ConfigurationTarget.Global);
			}
			const model = await vscode.window.showInputBox({ title: `${p.label}: model`, value: this.config().get<string>('model') || p.defaultModel || '', prompt: "The model's ID, as the provider names it" });
			if (!model) {
				return;
			}
			await this.config().update('model', model, vscode.ConfigurationTarget.Global);
			const existing = await this.context.secrets.get(secretKey(p.id));
			const key = await vscode.window.showInputBox({
				title: `${p.label}: API key`,
				prompt: `${existing ? 'Leave empty to keep the saved key. ' : ''}Stored in your system's secure storage, sent only to ${p.baseUrl ?? 'the address you gave'}.${p.keyHelp ? ` Get one at ${p.keyHelp}` : ''}`,
				password: true,
				ignoreFocusOut: true,
			});
			if (key === undefined || (!key && !existing)) {
				return;
			}
			if (key) {
				await this.context.secrets.store(secretKey(p.id), key.trim());
			}
		}
		await this.config().update('provider', p.id, vscode.ConfigurationTarget.Global);
	}
}

function hasCommand(cmd: string): Promise<boolean> {
	return new Promise((resolve) => execFile(cmd, ['--version'], { windowsHide: true, timeout: 15_000, shell: process.platform === 'win32' }, (error) => resolve(!error)));
}

/**
 * Open Codex or Claude Code in a terminal in the project, with TheoremDesk's
 * literature MCP server attached (run by TheoremDesk's own runtime).
 */
export async function openCliAgent(context: vscode.ExtensionContext, which: 'codex' | 'claude'): Promise<void> {
	const name = which === 'codex' ? 'Codex' : 'Claude Code';
	if (!(await hasCommand(which))) {
		const page = which === 'codex' ? 'https://learn.chatgpt.com/docs/codex/cli' : 'https://code.claude.com/docs/en/setup';
		const open = 'Open Install Instructions';
		if ((await vscode.window.showInformationMessage(`${name} isn't installed. Install it once, then sign in with your ${which === 'codex' ? 'ChatGPT' : 'Claude'} plan.`, open)) === open) {
			await vscode.env.openExternal(vscode.Uri.parse(page));
		}
		return;
	}
	const server = context.asAbsolutePath(path.join('out', 'mcp', 'literatureServer.js'));
	const terminal = vscode.window.createTerminal({ name, cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath });
	terminal.show();
	if (which === 'claude') {
		// Claude Code reads MCP servers from a JSON file given on the command line.
		const config = path.join(os.tmpdir(), 'theoremdesk-mcp.json');
		fs.writeFileSync(
			config,
			JSON.stringify({ mcpServers: { 'theoremdesk-literature': { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' } } } }, null, 2),
		);
		terminal.sendText(`claude --mcp-config ${quote(config)}`);
	} else {
		// Codex's documented way: `codex mcp add`, which writes ~/.codex/config.toml. Ask first.
		const add = 'Add and Open Codex';
		const choice = await vscode.window.showInformationMessage(
			"Add TheoremDesk's literature tools to Codex? This runs `codex mcp add theoremdesk-literature`, which changes Codex's settings (~/.codex/config.toml).",
			{ modal: true },
			add,
			'Open Codex Only',
		);
		if (!choice) {
			terminal.dispose();
			return;
		}
		if (choice === add) {
			terminal.sendText(`codex mcp add theoremdesk-literature --env ELECTRON_RUN_AS_NODE=1 -- ${quote(process.execPath)} ${quote(server)}`);
		}
		terminal.sendText('codex');
	}
}

function quote(s: string): string {
	return process.platform === 'win32' ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, "'\\''")}'`;
}
