// The Agent view: chat with the research agent in the sidebar. Answers
// stream in as they're written, with mathematics typeset (KaTeX, bundled);
// each tool call shows as a card with its result. Anything that changes
// files or runs code asks first: file changes open as a diff to apply or
// reject, and are applied through the editor so Ctrl+Z undoes them. The
// chat is saved per project and restored when the project reopens.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_SYSTEM, AgentEvent, AgentTool, ChatModel, repairConversation, runAgent } from './agent';
import { createAgentTools, proposeChange } from './agentTools';
import { ChatMessage } from './llm';
import { Library } from './library';
import { LocalAiService } from './localAiService';
import { Providers } from './providers';
import { createSources } from './sources';
import { dataDirectory, findBundledTools } from './tools';

const nodeFs = {
	exists: (f: string) => fs.existsSync(f),
	readFile: (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
	listDir: (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
};

/** What the chat shows, kept so a saved chat can be shown again. */
export type DisplayItem =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string; reasoning?: string }
	| { kind: 'tool'; id: string; summary: string; result?: string; ok?: boolean; denied?: boolean }
	| { kind: 'error'; text: string };

interface SavedChat {
	version: 1;
	messages: ChatMessage[];
	display: DisplayItem[];
}

const FILE_TOOLS = new Set(['write_file', 'edit_file']);
const PROPOSED = 'theoremdesk-proposed';

/** Keep a saved chat a sensible size: the last 200 messages, long results cut. */
export function trimForSaving(chat: SavedChat): SavedChat {
	const cut = (s: string) => (s.length > 20_000 ? `${s.slice(0, 20_000)}\n... [cut when saved]` : s);
	let messages = chat.messages.map((m) => ('content' in m && typeof m.content === 'string' ? { ...m, content: cut(m.content) } : m)) as ChatMessage[];
	if (messages.length > 200) {
		// Keep the system prompt; start the kept part at a user message so tool results keep their calls.
		const tail = messages.slice(-199);
		const start = tail.findIndex((m) => m.role === 'user');
		messages = [messages[0], ...tail.slice(Math.max(0, start))];
	}
	const display = chat.display.slice(-300).map((d) => (d.kind === 'tool' && d.result ? { ...d, result: cut(d.result) } : d));
	return { version: 1, messages, display };
}

export class AgentView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private messages: ChatMessage[] = [];
	private display: DisplayItem[] = [];
	private running: AbortController | undefined;
	/** Tools the user allowed for the rest of this chat. */
	private readonly alwaysAllow = new Set<string>();
	/** Proposed file contents shown in diffs, by URI. */
	private readonly proposed = new Map<string, string>();
	private readonly disposables: vscode.Disposable[] = [];
	/** Set only in extension tests (see extension.ts): answers approval questions. */
	private testApprover: ((question: string, diffOpen: boolean) => string | undefined) | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly ai: LocalAiService,
		private readonly providers: Providers,
		private readonly library: () => Library | undefined,
	) {
		const saved = this.loadChat();
		if (saved?.version === 1) {
			this.messages = saved.messages;
			this.display = saved.display;
		}
		this.disposables.push(
			vscode.workspace.registerTextDocumentContentProvider(PROPOSED, { provideTextDocumentContent: (uri) => this.proposed.get(uri.toString()) ?? '' }),
		);
	}

	/** What the chat holds, for the in-app test. */
	chatForTests(): { messages: number; display: DisplayItem[] } {
		return { messages: this.messages.length, display: this.display };
	}

	setTestApprover(answer: (question: string, diffOpen: boolean) => string | undefined): void {
		this.testApprover = answer;
	}

	/** Ask the user to approve an action (a modal dialog), or the test, in extension tests. */
	private async confirm(kind: 'info' | 'warning', question: string, detail: string, ...choices: string[]): Promise<string | undefined> {
		if (this.testApprover) {
			const diffOpen = vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === PROPOSED));
			return this.testApprover(question, diffOpen);
		}
		const show = kind === 'info' ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
		return show(question, { modal: true, detail }, ...choices);
	}

	dispose(): void {
		this.running?.abort();
		this.disposables.forEach((d) => d.dispose());
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
		view.webview.options = { enableScripts: true, localResourceRoots: [media] };
		view.webview.html = this.html(view.webview, media);
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
				this.post({ type: 'restore', display: this.display });
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

/** The chat file: in this project's storage folder, or the global one with no folder open. */
	private chatFile(): string {
		const dir = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
		return path.join(dir, this.context.storageUri ? 'agent-chat.json' : 'agent-chat-no-folder.json');
	}

	private loadChat(): SavedChat | undefined {
		try {
			return JSON.parse(fs.readFileSync(this.chatFile(), 'utf8')) as SavedChat;
		} catch {
			return undefined;
		}
	}

	/** Written straight to disk after every turn (atomically), so a crash or abrupt close keeps it. */
	private save(): void {
		try {
			const file = this.chatFile();
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(`${file}.tmp`, JSON.stringify(trimForSaving({ version: 1, messages: this.messages, display: this.display })));
			fs.renameSync(`${file}.tmp`, file);
		} catch {
			// Saving the chat is a convenience; never let it break the agent.
		}
	}

	newChat(): void {
		this.running?.abort();
		this.messages = [];
		this.display = [];
		this.alwaysAllow.clear();
		this.save();
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

	private root(): string {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? path.join(dataDirectory(process.platform, process.env, os.homedir()), 'scratch');
	}

	/** A file as the user sees it: an open editor's text, unsaved changes included. */
	private readText(file: string): string {
		const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(file));
		return open ? open.getText() : fs.readFileSync(file, 'utf8');
	}

	/** Apply a change through the editor, save it, and show the file, so Ctrl+Z undoes it. */
	private async applyChange(file: string, text: string): Promise<void> {
		const uri = vscode.Uri.file(file);
		const edit = new vscode.WorkspaceEdit();
		if (fs.existsSync(file)) {
			const doc = await vscode.workspace.openTextDocument(uri);
			edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
		} else {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			edit.createFile(uri, { ignoreIfExists: true });
			edit.insert(uri, new vscode.Position(0, 0), text);
		}
		if (!(await vscode.workspace.applyEdit(edit))) {
			throw new Error(`the editor refused the change to ${vscode.workspace.asRelativePath(uri)}`);
		}
		const doc = await vscode.workspace.openTextDocument(uri);
		await doc.save();
		await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
	}

	private tools(): AgentTool[] {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const bundled = findBundledTools(vscode.env.appRoot, process.platform, nodeFs);
		const all = createAgentTools({
			root: this.root(),
			python: bundled?.python ?? (process.platform === 'win32' ? 'python' : 'python3'),
			texBin: bundled?.texBin,
			library: this.library(),
			embedder: () => this.ai.client('embedding'),
			sources: createSources(),
			readText: (f) => this.readText(f),
			applyChange: (f, t) => this.applyChange(f, t),
		});
		// Without a project folder there are no files to work on.
		return root ? all : all.filter((t) => ['search_literature', 'search_library', 'run_python'].includes(t.name));
	}

	/** Show a proposed file change as a diff and ask whether to apply it. */
	private async reviewChange(tool: AgentTool, args: Record<string, unknown>): Promise<boolean> {
		let change;
		try {
			change = proposeChange({ root: this.root(), python: '', sources: [], readText: (f) => this.readText(f) }, tool.name, args);
		} catch {
			return true; // the tool reports the problem itself when it runs
		}
		const rel = vscode.workspace.asRelativePath(change.file);
		const right = vscode.Uri.from({ scheme: PROPOSED, path: `/${rel}`, query: String(Date.now()) });
		this.proposed.set(right.toString(), change.after);
		const left = change.before === undefined ? vscode.Uri.from({ scheme: PROPOSED, path: `/${rel}`, query: 'new' }) : vscode.Uri.file(change.file);
		if (change.before === undefined) {
			this.proposed.set(left.toString(), '');
		}
		await vscode.commands.executeCommand('vscode.diff', left, right, `${rel}: the agent's change${change.before === undefined ? ' (new file)' : ''}`, { preview: true });
		const apply = 'Apply';
		const all = 'Apply All in This Chat';
		const choice = await this.confirm(
			'info',
			`Apply the agent's change to ${rel}?`,
			'The change is open as a diff: the right side is what the file will be. You can undo it afterwards with Ctrl+Z in the file.',
			apply,
			all,
		);
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				if (tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.toString() === right.toString()) {
					await vscode.window.tabGroups.close(tab);
				}
			}
		}
		this.proposed.delete(right.toString());
		this.proposed.delete(left.toString());
		if (choice === all) {
			FILE_TOOLS.forEach((t) => this.alwaysAllow.add(t));
		}
		return choice === apply || choice === all;
	}

	private async approve(tool: AgentTool, summary: string, args: Record<string, unknown>): Promise<boolean> {
		if (this.alwaysAllow.has(tool.name)) {
			return true;
		}
		if (FILE_TOOLS.has(tool.name)) {
			return this.reviewChange(tool, args);
		}
		const detail = tool.name === 'run_python' ? String(args.code ?? '') : tool.name === 'run_command' ? String(args.command ?? '') : '';
		const allow = 'Allow';
		const always = `Allow ${tool.name} for this chat`;
		const choice = await this.confirm('warning', `The agent wants to ${summary}.`, detail.slice(0, 3000), allow, always);
		if (choice === always) {
			this.alwaysAllow.add(tool.name);
		}
		return choice === allow || choice === always;
	}

	/** Keep the display list in step with what the chat shows. */
	private record(e: AgentEvent): void {
		const last = this.display[this.display.length - 1];
		if (e.type === 'text' || e.type === 'reasoning') {
			const item = last?.kind === 'assistant' ? last : (this.display.push({ kind: 'assistant', text: '' }), this.display[this.display.length - 1] as Extract<DisplayItem, { kind: 'assistant' }>);
			if (e.type === 'text') {
				item.text += e.text;
			} else {
				item.reasoning = (item.reasoning ?? '') + e.text;
			}
		} else if (e.type === 'tool-start' || e.type === 'tool-denied') {
			this.display.push({ kind: 'tool', id: e.id, summary: e.summary, denied: e.type === 'tool-denied' });
		} else if (e.type === 'tool-end') {
			const tool = this.display.find((d): d is Extract<DisplayItem, { kind: 'tool' }> => d.kind === 'tool' && d.id === e.id);
			if (tool) {
				tool.result = e.result;
				tool.ok = e.ok;
			} else {
				this.display.push({ kind: 'tool', id: e.id, summary: e.name, result: e.result, ok: e.ok });
			}
		}
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
		this.display.push({ kind: 'user', text });
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
				onEvent: (e: AgentEvent) => {
					this.record(e);
					this.post({ type: 'event', event: e });
				},
			});
		} catch (error) {
			const message = abort.signal.aborted ? 'Stopped.' : `Error: ${error instanceof Error ? error.message : String(error)}`;
			this.post({ type: 'error', text: message });
			this.display.push({ kind: 'error', text: message });
			repairConversation(this.messages, message);
			answer = message;
		} finally {
			this.running = undefined;
			this.save();
			this.post({ type: 'note', text: '' });
			this.postStatus();
		}
		return answer;
	}

	private html(webview: vscode.Webview, media: vscode.Uri): string {
		const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
		const katex = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, 'katex', f)).toString();
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
<link rel="stylesheet" href="${katex('katex.min.css')}">
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
	.assistant .katex-display { overflow-x: auto; overflow-y: hidden; padding: 2px 0; }
	details.tool { border-left: 2px solid var(--vscode-textLink-foreground); padding: 2px 8px; margin: 6px 0; font-size: 0.92em; }
	details.tool.fail { border-color: var(--vscode-errorForeground); }
	details.tool.denied { border-color: var(--vscode-disabledForeground); opacity: 0.8; }
	details.tool pre { white-space: pre-wrap; max-height: 240px; overflow-y: auto; margin: 4px 0; }
	details.thinking { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; white-space: pre-wrap; }
	.note, .error { color: var(--vscode-descriptionForeground); font-style: italic; margin: 4px 0; }
	.error { color: var(--vscode-errorForeground); }
	#input { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--vscode-panel-border); }
	textarea { flex: 1; resize: vertical; min-height: 44px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); font-family: inherit; padding: 4px; }
	#go { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 0 12px; cursor: pointer; border-radius: 3px; }
	.empty { color: var(--vscode-descriptionForeground); padding: 4px; }
</style></head>
<body>
<div id="bar"><span id="provider">…</span><button id="switch" title="Choose the model">Model</button><button id="new" title="Start a new chat">New</button></div>
<div id="log"></div>
<div id="input"><textarea id="text" placeholder="Ask the agent (Enter to send, Shift+Enter for a new line)"></textarea><button id="go">Send</button></div>
<script nonce="${nonce}" src="${katex('katex.min.js')}"></script>
<script nonce="${nonce}" src="${katex('auto-render.min.js')}"></script>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const log = document.getElementById('log'), text = document.getElementById('text'), go = document.getElementById('go');
const EMPTY = 'Ask about your project or the literature. The agent can search papers and your library, read and edit files, compile Lean and LaTeX, run Python and terminal commands. It asks before changing files or running anything, and shows each file change as a diff first.';
let busy = false, current = null, currentText = '', thinking = null, tools = {}, mathTimer = null;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Mathematics is set aside before the markdown rules run, so * and _ inside it survive.
function md(s) {
	const maths = [];
	const keep = (m) => { maths.push(m); return '\\u0000' + (maths.length - 1) + '\\u0000'; };
	const blocks = s.split(/\`\`\`/);
	return blocks.map((b, i) => {
		if (i % 2) { const nl = b.indexOf('\\n'); return '<pre><code>' + esc(nl >= 0 ? b.slice(nl + 1) : b) + '</code></pre>'; }
		b = b.replace(/\\$\\$[\\s\\S]+?\\$\\$|\\\\\\[[\\s\\S]+?\\\\\\]|\\\\\\([\\s\\S]+?\\\\\\)|\\$[^$\\n]+?\\$/g, keep);
		return esc(b).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>').replace(/^#{1,4} (.*)$/gm, '<b>$1</b>').replace(/^\\s*[-*] (.*)$/gm, '• $1').replace(/\\n/g, '<br>')
			.replace(/\\u0000(\\d+)\\u0000/g, (_, n) => esc(maths[Number(n)]));
	}).join('');
}
function typeset(el) {
	if (window.renderMathInElement) {
		renderMathInElement(el, { delimiters: [{ left: '$$', right: '$$', display: true }, { left: '\\\\[', right: '\\\\]', display: true }, { left: '\\\\(', right: '\\\\)', display: false }, { left: '$', right: '$', display: false }], throwOnError: false, ignoredTags: ['pre', 'code'] });
	}
}
function add(cls, html) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; }
function clearEmpty() { const e = log.querySelector('.empty'); if (e) e.remove(); }
function showEmpty() { if (!log.children.length) add('empty', esc(EMPTY)); }
function assistant() { if (!current) { current = add('assistant', ''); currentText = ''; } return current; }
function renderAssistant(final) {
	const a = assistant(); a.innerHTML = md(currentText);
	// Typeset at most a few times a second while streaming, and once at the end.
	if (final) { clearTimeout(mathTimer); mathTimer = null; typeset(a); }
	else if (!mathTimer) mathTimer = setTimeout(() => { mathTimer = null; if (current === a) typeset(a); }, 300);
	log.scrollTop = log.scrollHeight;
}
function toolCard(id, summary, denied) { const d = document.createElement('details'); d.className = 'tool msg' + (denied ? ' denied' : ''); d.innerHTML = '<summary>' + (denied ? 'Declined: ' : '⚙ ') + esc(summary) + '</summary><pre></pre>'; log.appendChild(d); tools[id] = d; log.scrollTop = log.scrollHeight; return d; }
function finishTool(d, ok, result) { if (!ok) d.classList.add('fail'); d.lastChild.textContent = result || ''; }
function setBusy(b) { busy = b; go.textContent = b ? 'Stop' : 'Send'; }
function send() { if (busy) { vscode.postMessage({ type: 'stop' }); return; } const t = text.value.trim(); if (!t) return; text.value = ''; vscode.postMessage({ type: 'send', text: t }); }
go.onclick = send;
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
document.getElementById('new').onclick = () => vscode.postMessage({ type: 'new' });
document.getElementById('switch').onclick = () => vscode.postMessage({ type: 'provider' });
let note = null;
function endTurn() { if (current) renderAssistant(true); current = null; thinking = null; }
window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'status') { document.getElementById('provider').textContent = m.provider; setBusy(m.busy); }
	else if (m.type === 'clear') { log.innerHTML = ''; current = null; showEmpty(); }
	else if (m.type === 'restore') {
		log.innerHTML = ''; current = null;
		for (const d of m.display) {
			if (d.kind === 'user') add('user', esc(d.text));
			else if (d.kind === 'error') add('error', esc(d.text));
			else if (d.kind === 'tool') { const c = toolCard(d.id, d.summary, d.denied); if (d.result !== undefined) finishTool(c, d.ok, d.result); }
			else if (d.kind === 'assistant') { current = null; currentText = d.text; renderAssistant(true); current = null; }
		}
		showEmpty();
	}
	else if (m.type === 'user') { clearEmpty(); add('user', esc(m.text)); current = null; thinking = null; }
	else if (m.type === 'note') { if (note) { note.remove(); note = null; } if (m.text) note = add('note', esc(m.text)); }
	else if (m.type === 'error') { add('error', esc(m.text)); current = null; }
	else if (m.type === 'event') {
		const e = m.event;
		if (e.type === 'text') { assistant(); currentText += e.text; renderAssistant(false); }
		else if (e.type === 'reasoning') { if (!thinking) { const a = assistant(); thinking = document.createElement('details'); thinking.className = 'thinking'; thinking.innerHTML = '<summary>Thinking</summary><div></div>'; a.before(thinking); } thinking.lastChild.textContent += e.text; }
		else if (e.type === 'tool-start' || e.type === 'tool-denied') { endTurn(); toolCard(e.id, e.summary, e.type === 'tool-denied'); }
		else if (e.type === 'tool-end') { finishTool(tools[e.id] || toolCard(e.id, e.name, false), e.ok, e.result); current = null; }
		else if (e.type === 'turn-end') { endTurn(); }
	}
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
	}
}
