// The Literature view: recommendations for the open project, arXiv search,
// and Add to bibliography. Also registers the literature MCP server so
// agents in the app can use the same tools.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { addToBib, ArxivSource, findInBib, Paper, recommend } from './literature';

type Section = 'recommended' | 'search';
type Item =
	| { kind: 'section'; section: Section }
	| { kind: 'paper'; paper: Paper; score?: number }
	| { kind: 'note'; label: string; command?: vscode.Command };

export class LiteratureView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
	private readonly arxiv = new ArxivSource();
	private recommended: { paper: Paper; score: number }[] | undefined;
	private results: Paper[] | undefined;
	private query: string | undefined;
	private busy: Section | undefined;
	private bibText = '';
	private readonly changed = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.bib');

	constructor() {
		const reload = () => void this.loadBib().then(() => this.changed.fire(undefined));
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(reload);
		reload();
	}

	dispose(): void {
		this.watcher.dispose();
		this.changed.dispose();
	}

	getTreeItem(item: Item): vscode.TreeItem {
		if (item.kind === 'section') {
			const label = item.section === 'recommended' ? 'Recommended for this project' : `Search: ${this.query ?? ''}`;
			const tree = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
			tree.contextValue = `section-${item.section}`;
			tree.iconPath = new vscode.ThemeIcon(item.section === 'recommended' ? 'sparkle' : 'search');
			return tree;
		}
		if (item.kind === 'note') {
			const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
			tree.command = item.command;
			return tree;
		}
		const { paper } = item;
		const tree = new vscode.TreeItem(paper.title, vscode.TreeItemCollapsibleState.None);
		const authors = paper.authors.length > 2 ? `${paper.authors[0]} et al.` : paper.authors.join(', ');
		const key = findInBib(this.bibText, paper);
		tree.description = `${authors} · ${paper.year} · ${paper.primaryCategory}${key ? ` · in bibliography as ${key}` : ''}`;
		tree.iconPath = new vscode.ThemeIcon(key ? 'pass-filled' : 'book', key ? new vscode.ThemeColor('testing.iconPassed') : undefined);
		tree.contextValue = key ? 'paper-cited' : 'paper';
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${escapeMd(paper.title)}**\n\n`);
		tooltip.appendMarkdown(`${escapeMd(paper.authors.join(', '))}\n\n`);
		tooltip.appendMarkdown(
			`arXiv:${paper.id} · ${paper.primaryCategory} · ${paper.published.slice(0, 10)}${paper.journalRef ? ` · ${escapeMd(paper.journalRef)}` : ''}\n\n`,
		);
		tooltip.appendMarkdown(escapeMd(paper.abstract));
		if (item.score !== undefined) {
			tooltip.appendMarkdown(`\n\n*Relevance to this project: ${item.score.toFixed(2)}*`);
		}
		tree.tooltip = tooltip;
		tree.command = { command: 'theoremdesk.literature.open', title: 'Open on arXiv', arguments: [item] };
		return tree;
	}

	getChildren(item?: Item): Item[] {
		if (!item) {
			const sections: Item[] = [{ kind: 'section', section: 'recommended' }];
			if (this.query) {
				sections.push({ kind: 'section', section: 'search' });
			}
			return sections;
		}
		if (item.kind !== 'section') {
			return [];
		}
		if (this.busy === item.section) {
			return [{ kind: 'note', label: 'Asking arXiv...' }];
		}
		if (item.section === 'recommended') {
			if (!this.recommended) {
				return [
					{
						kind: 'note',
						label: 'Find papers related to your manuscript',
						command: { command: 'theoremdesk.literature.recommend', title: 'Recommend' },
					},
				];
			}
			return this.recommended.length > 0
				? this.recommended.map(({ paper, score }) => ({ kind: 'paper', paper, score }))
				: [{ kind: 'note', label: 'No recommendations yet: the manuscript needs a title, abstract or some text.' }];
		}
		return this.results && this.results.length > 0
			? this.results.map((paper) => ({ kind: 'paper', paper }))
			: [{ kind: 'note', label: 'No papers found.' }];
	}

	async search(): Promise<void> {
		const query = await vscode.window.showInputBox({
			title: 'Search arXiv',
			prompt: 'Words that must appear, or arXiv syntax such as au:maldacena AND ti:large',
			value: this.query,
		});
		if (!query?.trim()) {
			return;
		}
		this.query = query.trim();
		await this.run('search', async () => {
			this.results = await this.arxiv.search(this.query!, { maxResults: 25 });
		});
	}

	async recommend(): Promise<void> {
		const tex = await findManuscript();
		if (!tex) {
			void vscode.window.showWarningMessage('Open a project with a LaTeX manuscript (a .tex file) to get recommendations.');
			return;
		}
		await this.loadBib();
		await this.run('recommended', async () => {
			this.recommended = await recommend(this.arxiv, tex.getText(), this.bibText, { maxResults: 15 });
		});
	}

	private async run(section: Section, work: () => Promise<void>): Promise<void> {
		this.busy = section;
		this.changed.fire(undefined);
		await vscode.commands.executeCommand('theoremdesk.literature.focus');
		try {
			await work();
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Couldn't reach arXiv: ${(error as Error).message}. Literature search needs an internet connection.`,
			);
		} finally {
			this.busy = undefined;
			this.changed.fire(undefined);
		}
	}

	async add(item: Item | undefined): Promise<void> {
		if (item?.kind !== 'paper') {
			return;
		}
		const bibFile = await chooseBibFile();
		if (!bibFile) {
			return;
		}
		const current = fs.existsSync(bibFile) ? fs.readFileSync(bibFile, 'utf8') : '';
		const result = addToBib(current, item.paper);
		if (result.added) {
			fs.writeFileSync(bibFile, result.text);
		}
		await vscode.env.clipboard.writeText(`\\cite{${result.key}}`);
		await this.loadBib();
		this.changed.fire(undefined);
		void vscode.window.showInformationMessage(
			result.added
				? `Added to ${path.basename(bibFile)} as ${result.key}. \\cite{${result.key}} is on the clipboard.`
				: `Already in ${path.basename(bibFile)} as ${result.key}. \\cite{${result.key}} is on the clipboard.`,
		);
	}

	async copyCite(item: Item | undefined): Promise<void> {
		if (item?.kind !== 'paper') {
			return;
		}
		const key = findInBib(this.bibText, item.paper);
		if (!key) {
			await this.add(item);
			return;
		}
		await vscode.env.clipboard.writeText(`\\cite{${key}}`);
		void vscode.window.showInformationMessage(`\\cite{${key}} is on the clipboard.`);
	}

	async open(item: Item | undefined): Promise<void> {
		if (item?.kind === 'paper') {
			await vscode.env.openExternal(vscode.Uri.parse(item.paper.url));
		}
	}

	private async loadBib(): Promise<void> {
		const files = await vscode.workspace.findFiles('**/*.bib', '**/{node_modules,.lake,build}/**', 20);
		this.bibText = files.map((f) => fs.readFileSync(f.fsPath, 'utf8')).join('\n');
	}
}

function escapeMd(text: string): string {
	return text.replace(/([\\`*_{}[\]<>#|])/g, '\\$1');
}

/** The active .tex file, else the workspace's main.tex, else any .tex. */
async function findManuscript(): Promise<vscode.TextDocument | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (active?.fileName.endsWith('.tex')) {
		return active;
	}
	const exclude = '**/{node_modules,.lake,build}/**';
	const [main] = await vscode.workspace.findFiles('**/main.tex', exclude, 1);
	const [any] = main ? [main] : await vscode.workspace.findFiles('**/*.tex', exclude, 1);
	return any ? vscode.workspace.openTextDocument(any) : undefined;
}

/** The project's .bib file: the only one, the user's choice, or a new references.bib. */
async function chooseBibFile(): Promise<string | undefined> {
	const files = await vscode.workspace.findFiles('**/*.bib', '**/{node_modules,.lake,build}/**', 20);
	if (files.length === 1) {
		return files[0].fsPath;
	}
	if (files.length > 1) {
		const pick = await vscode.window.showQuickPick(
			files.map((f) => ({ label: vscode.workspace.asRelativePath(f), file: f.fsPath })),
			{ title: 'Add to which bibliography?' },
		);
		return pick?.file;
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage('Open your project folder first, so the paper can go in its bibliography.');
		return undefined;
	}
	const tex = await findManuscript();
	const dir = tex ? path.dirname(tex.uri.fsPath) : folder.uri.fsPath;
	const create = 'Create references.bib';
	const choice = await vscode.window.showInformationMessage(
		`This project has no .bib file yet. Create ${vscode.workspace.asRelativePath(path.join(dir, 'references.bib'))}?`,
		create,
	);
	return choice === create ? path.join(dir, 'references.bib') : undefined;
}

/** Offer the literature MCP server to agents in the app (VS Code 1.101+). */
export function registerLiteratureMcpServer(context: vscode.ExtensionContext): void {
	// The MCP API is newer than the @types/vscode this extension builds against.
	const api = vscode as unknown as {
		lm?: { registerMcpServerDefinitionProvider?: (id: string, provider: object) => vscode.Disposable };
		McpStdioServerDefinition?: new (label: string, command: string, args: string[], env: Record<string, string>, version?: string) => object;
	};
	if (!api.lm?.registerMcpServerDefinitionProvider || !api.McpStdioServerDefinition) {
		return;
	}
	const server = context.asAbsolutePath(path.join('out', 'mcp', 'literatureServer.js'));
	const Definition = api.McpStdioServerDefinition;
	context.subscriptions.push(
		api.lm.registerMcpServerDefinitionProvider('theoremdesk.literature', {
			// TheoremDesk's own runtime runs the server, so no separate Node is needed.
			provideMcpServerDefinitions: () => [
				new Definition('TheoremDesk Literature (arXiv)', process.execPath, [server], { ELECTRON_RUN_AS_NODE: '1' }, '0.1.0'),
			],
		}),
	);
}
