// The Agent view: chat with the research agent in the sidebar. Answers
// stream in as they're written; each tool call shows as a card with its
// result; anything that changes files or runs code asks first.

import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_SYSTEM, AgentEvent, AgentTool, ChatModel, repairConversation, runAgent } from './agent';
import { createAgentTools } from './agentTools';
import { ChatMessage } from './llm';
import { Library } from './library';
import { LocalAiService } from './localAiService';
import { Providers } from './providers';
import { createSources } from './sources';
import { dataDirectory, findBundledTools } from './tools';
import * as fs from 'fs';

const nodeFs = {
	exists: (f: string) => fs.existsSync(f),
	readFile: (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
	listDir: (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
};

export class AgentView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private messages: ChatMessage[] = [];
	private running: AbortController | undefined;
	/** Tools the user allowed for the rest of this chat. */
	private readonly alwaysAllow = new Set<string>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly ai: LocalAiService,
		private readonly providers: Providers,
		private readonly library: () => Library | undefined,
	) {}

	dispose(): void {
		this.running?.abort();
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = { enableScripts: true, localResourceRoots: [] };
		view.webview.html = this.html(view.webview);
		view.webview.onDidReceiveMessage((m: { type: string; text?: string }) => {
			if (m.type === 'send' && m.text?.trim()) {
				void this.send(m.text.trim());
			} else if (m.type === 'stop') {
				this.running?.abort();
			} else if (m.type === 'new') {
				this.newChat();
			} else if (m.type === 'provider') {
				void this.providers.choose().then(() => this.postStatus());
			} else if (m.type === 'ready') {
				this.postStatus();
			}
		});
	}

	private post(message: object): void {
		void this.view?.webview.postMessage(message);
	}

	private postStatus(): void {
		this.post({ type: 'status', provider: this.providers.label(), busy: Boolean(this.running) });
	}

	newChat(): void {
		this.running?.abort();
		this.messages = [];
		this.alwaysAllow.clear();
		this.post({ type: 'clear' });
		this.postStatus();
	}

	/** Ask the agent (asks for the question if none is given); returns its answer. */
	async ask(text?: string): Promise<string | undefined> {
		const question = text ?? (await vscode.window.showInputBox({ title: 'Ask the TheoremDesk agent', prompt: 'About your project, the literature, a proof or a calculation' }));
		if (!question?.trim()) {
			return undefined;
		}
		await vscode.commands.executeCommand('theoremdesk.agent.focus');
		return this.send(question.trim());
	}

	private tools(): AgentTool[] {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const bundled = findBundledTools(vscode.env.appRoot, process.platform, nodeFs);
		const all = createAgentTools({
			root: root ?? path.join(dataDirectory(process.platform, process.env, os.homedir()), 'scratch'),
			python: bundled?.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
			texBin: bundled?.texBin,
			library: this.library(),
			embedder: () => this.ai.client('embedding'),
			sources: createSources(),
		});
		// Without a project folder there are no files to work on.
		return root ? all : all.filter((t) => ['search_literature', 'search_library', 'run_python'].includes(t.name));
	}

	private async approve(tool: AgentTool, summary: string, args: Record<string, unknown>): Promise<boolean> {
		if (this.alwaysAllow.has(tool.name)) {
			return true;
		}
		const detail =
			tool.name === 'run_python' ? String(args.code ?? '') : tool.name === 'write_file' ? String(args.content ?? '').slice(0, 1500) : tool.name === 'edit_file' ? `- ${args.old_text}\n+ ${args.new_text}` : '';
		const allow = 'Allow';
		const always = `Allow ${tool.name} for this chat`;
		const choice = await vscode.window.showWarningMessage(`The agent wants to ${summary}.`, { modal: true, detail: detail.slice(0, 3000) }, allow, always);
		if (choice === always) {
			this.alwaysAllow.add(tool.name);
		}
		return choice === allow || choice === always;
	}

	private async send(text: string): Promise<string | undefined> {
		if (this.running) {
			return undefined;
		}
		let answer: string | undefined;
		const abort = new AbortController();
		this.running = abort;
		this.postStatus();
		this.post({ type: 'user', text });
		if (this.messages.length === 0) {
			this.messages.push({ role: 'system', content: AGENT_SYSTEM });
		}
		const editor = vscode.window.activeTextEditor;
		const open = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri) ? vscode.workspace.asRelativePath(editor.document.uri) : undefined;
		const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).slice(0, 4000) : undefined;
		const context = [open ? `(Open file: ${open})` : '', selection ? `(Selected text:\n${selection}\n)` : ''].filter(Boolean).join('\n');
		this.messages.push({ role: 'user', content: context ? `${context}\n\n${text}` : text });
		try {
			this.post({ type: 'note', text: `Loading ${this.providers.label()}...` });
			const model: ChatModel = await this.providers.model();
			this.post({ type: 'note', text: '' });
			answer = await runAgent(model, this.messages, this.tools(), {
				signal: abort.signal,
				thinking: vscode.workspace.getConfiguration('theoremdesk.agent').get<boolean>('thinking', false),
				maxSteps: vscode.workspace.getConfiguration('theoremdesk.agent').get<number>('maxSteps', 12),
				approve: (tool, summary, args) => this.approve(tool, summary, args),
				onEvent: (e: AgentEvent) => this.post({ type: 'event', event: e }),
			});
		} catch (error) {
			const message = abort.signal.aborted ? 'Stopped.' : `Error: ${error instanceof Error ? error.message : String(error)}`;
			this.post({ type: 'error', text: message });
			repairConversation(this.messages, message);
			answer = message;
		} finally {
			this.running = undefined;
			this.post({ type: 'note', text: '' });
			this.postStatus();
		}
		return answer;
	}

	private html(webview: vscode.Webview): string {
		const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; }
	#bar { display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
	#bar button { background: none; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-textLink-foreground); cursor: pointer; padding: 2px 6px; border-radius: 3px; }
	#provider { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	#log { flex: 1; overflow-y: auto; padding: 8px; }
	.msg { margin: 0 0 12px; line-height: 1.45; overflow-wrap: anywhere; }
	.user { background: var(--vscode-input-background); border-radius: 6px; padding: 6px 8px; white-space: pre-wrap; }
	.assistant pre { background: var(--vscode-textCodeBlock-background); padding: 6px; overflow-x: auto; border-radius: 4px; }
	.assistant code { font-family: var(--vscode-editor-font-family); }
	details.tool { border-left: 2px solid var(--vscode-textLink-foreground); padding: 2px 8px; margin: 6px 0; font-size: 0.92em; }
	details.tool.fail { border-color: var(--vscode-errorForeground); }
	details.tool.denied { border-color: var(--vscode-disabledForeground); opacity: 0.8; }
	details.tool pre { white-space: pre-wrap; max-height: 240px; overflow-y: auto; margin: 4px 0; }
	details.thinking { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; }
	.note, .error { color: var(--vscode-descriptionForeground); font-style: italic; margin: 4px 0; }
	.error { color: var(--vscode-errorForeground); }
	#input { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
	textarea { flex: 1; resize: vertical; min-height: 44px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; padding: 4px; }
	#go { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 0 12px; cursor: pointer; border-radius: 3px; }
	.empty { color: var(--vscode-descriptionForeground); padding: 4px; }
</style></head>
<body>
<div id="bar"><span id="provider">…</span><button id="switch" title="Choose the model">Model</button><button id="new" title="Start a new chat">New</button></div>
<div id="log"><div class="empty">Ask about your project or the literature. The agent can search papers, read your library, read and edit files, compile Lean and LaTeX, and run Python. It asks before changing files or running code.</div></div>
<div id="input"><textarea id="text" placeholder="Ask the agent (Enter to send, Shift+Enter for a new line)"></textarea><button id="go">Send</button></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log'), text = document.getElementById('text'), go = document.getElementById('go');
let busy = false, current = null, currentText = '', thinking = null, tools = {};
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function md(s) {
	const blocks = s.split(/\`\`\`/);
	return blocks.map((b, i) => {
		if (i % 2) { const nl = b.indexOf('\\n'); return '<pre><code>' + esc(nl >= 0 ? b.slice(nl + 1) : b) + '</code></pre>'; }
		return esc(b).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>').replace(/^#{1,4} (.*)$/gm, '<b>$1</b>').replace(/^\\s*[-*] (.*)$/gm, '• $1').replace(/\\n/g, '<br>');
	}).join('');
}
function add(cls, html) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
function clearEmpty() { const e = log.querySelector('.empty'); if (e) e.remove(); }
function assistant() { if (!current) { current = add('assistant', ''); currentText = ''; } return current; }
function setBusy(b) { busy = b; go.textContent = b ? 'Stop' : 'Send'; }
function send() { if (busy) { vscode.postMessage({ type: 'stop' }); return; } const t = text.value.trim(); if (!t) return; text.value = ''; vscode.postMessage({ type: 'send', text: t }); }
go.onclick = send;
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
document.getElementById('new').onclick = () => vscode.postMessage({ type: 'new' });
document.getElementById('switch').onclick = () => vscode.postMessage({ type: 'provider' });
let note = null;
window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'status') { document.getElementById('provider').textContent = m.provider; setBusy(m.busy); }
	else if (m.type === 'clear') { log.innerHTML = ''; current = null; }
	else if (m.type === 'user') { clearEmpty(); add('user', esc(m.text)); current = null; thinking = null; }
	else if (m.type === 'note') { if (note) { note.remove(); note = null; } if (m.text) note = add('note', esc(m.text)); }
	else if (m.type === 'error') { add('error', esc(m.text)); current = null; }
	else if (m.type === 'event') {
		const e = m.event;
		if (e.type === 'text') { const a = assistant(); currentText += e.text; a.innerHTML = md(currentText); log.scrollTop = log.scrollHeight; }
		else if (e.type === 'reasoning') { if (!thinking) { const a = assistant(); thinking = document.createElement('details'); thinking.className = 'thinking'; thinking.innerHTML = '<summary>Thinking</summary><div></div>'; a.before(thinking); } thinking.lastChild.textContent += e.text; }
		else if (e.type === 'tool-start' || e.type === 'tool-denied') { current = null; thinking = null; const d = document.createElement('details'); d.className = 'tool msg' + (e.type === 'tool-denied' ? ' denied' : ''); d.innerHTML = '<summary>' + (e.type === 'tool-denied' ? 'Declined: ' : '⚙ ') + esc(e.summary) + '</summary><pre></pre>'; log.appendChild(d); tools[e.id] = d; log.scrollTop = log.scrollHeight; }
		else if (e.type === 'tool-end') { let d = tools[e.id]; if (!d) { d = document.createElement('details'); d.className = 'tool msg'; d.innerHTML = '<summary>⚙ ' + esc(e.name) + '</summary><pre></pre>'; log.appendChild(d); } if (!e.ok) d.classList.add('fail'); d.lastChild.textContent = e.result; current = null; }
		else if (e.type === 'turn-end') { current = null; thinking = null; }
	}
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
	}
}
