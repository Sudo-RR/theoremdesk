// The Literature view: recommendations for the open project, search across
// arXiv, INSPIRE-HEP, zbMATH Open, Crossref and OpenAlex, and Add to
// bibliography. Also registers the literature MCP server so agents in the
// app can use the same tools.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { addToBib, bestForBibliography, displayName, findInBib, LiteratureSource, Paper, recommend, SOURCE_NAMES, SourceId } from './literature';
import { ALL_SOURCES, createSources, searchAll } from './sources';

type Section = 'recommended' | 'search';
type Item =
	| { kind: 'section'; section: Section }
	| { kind: 'paper'; paper: Paper; score?: number }
	| { kind: 'note'; label: string; command?: vscode.Command };

const SOURCE_DESCRIPTIONS: Record<SourceId, string> = {
	arxiv: 'Preprints in physics, mathematics and computer science',
	inspire: 'High-energy physics, with INSPIRE citation keys and BibTeX',
	zbmath: 'Mathematics, with reviews and MSC classes',
	crossref: 'Published journal articles with DOIs',
	openalex: 'All fields; also finds works related to those you cite',
};

function enabledSources(): SourceId[] {
	const configured = vscode.workspace.getConfiguration('theoremdesk.literature').get<string[]>('sources', ALL_SOURCES);
	const valid = configured.filter((s): s is SourceId => (ALL_SOURCES as string[]).includes(s));
	return valid.length > 0 ? valid : ALL_SOURCES;
}

function sourceBadge(paper: Paper): string {
	return (paper.sources ?? [paper.source]).map((s) => SOURCE_NAMES[s]).join(', ');
}

export class LiteratureView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
	private sources: LiteratureSource[] = createSources(enabledSources());
	private recommended: { paper: Paper; score: number }[] | undefined;
	private results: Paper[] | undefined;
	private query: string | undefined;
	private busy: Section | undefined;
	private bibText = '';
	private readonly changed = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private readonly watcher = vscode.workspace.createFileSystemWatcher('**/*.bib');
	private readonly config: vscode.Disposable;

	constructor() {
		const reload = () => void this.loadBib().then(() => this.changed.fire(undefined));
		this.watcher.onDidChange(reload);
		this.watcher.onDidCreate(reload);
		this.watcher.onDidDelete(reload);
		this.config = vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('theoremdesk.literature.sources')) {
				this.sources = createSources(enabledSources());
			}
		});
		reload();
	}

	dispose(): void {
		this.watcher.dispose();
		this.config.dispose();
		this.changed.dispose();
	}

	getTreeItem(item: Item): vscode.TreeItem {
		if (item.kind === 'section') {
			const label = item.section === 'recommended' ? 'Recommended for this project' : `Search: ${this.query ?? ''}`;
			const tree = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
			tree.contextValue = `section-${item.section}`;
			tree.iconPath = new vscode.ThemeIcon(item.section === 'recommended' ? 'sparkle' : 'search');
			tree.tooltip = `Sources: ${this.sources.map((s) => s.name).join(', ')}`;
			return tree;
		}
		if (item.kind === 'note') {
			const tree = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
			tree.command = item.command;
			return tree;
		}
		const { paper } = item;
		const tree = new vscode.TreeItem(paper.title, vscode.TreeItemCollapsibleState.None);
		const names = paper.authors.map(displayName);
		const authors = names.length > 2 ? `${names[0]} et al.` : names.join(', ');
		const venue = paper.journalShort ?? paper.journal ?? (paper.arxivId ? paper.primaryCategory : undefined);
		const key = findInBib(this.bibText, paper);
		tree.description = [authors, paper.year || undefined, venue, sourceBadge(paper), key ? `in bibliography as ${key}` : undefined]
			.filter(Boolean)
			.join(' · ');
		tree.iconPath = new vscode.ThemeIcon(key ? 'pass-filled' : 'book', key ? new vscode.ThemeColor('testing.iconPassed') : undefined);
		tree.contextValue = key ? 'paper-cited' : 'paper';
		const tooltip = new vscode.MarkdownString(undefined, true);
		tooltip.appendMarkdown(`**${escapeMd(paper.title)}**\n\n`);
		tooltip.appendMarkdown(`${escapeMd(names.join(', '))}\n\n`);
		const facts = [
			paper.journal
				? `${paper.journal}${paper.volume ? ` ${paper.volume}` : ''}${paper.pages ? `, ${paper.pages}` : ''} (${paper.year})`
				: paper.journalRef,
			paper.arxivId ? `arXiv:${paper.arxivId}${paper.primaryCategory ? ` [${paper.primaryCategory}]` : ''}` : undefined,
			paper.doi ? `doi:${paper.doi}` : undefined,
			paper.texkey ? `INSPIRE key ${paper.texkey}` : undefined,
			paper.zbl ? `Zbl ${paper.zbl}` : undefined,
			paper.citationCount !== undefined ? `${paper.citationCount} citations` : undefined,
		].filter(Boolean) as string[];
		tooltip.appendMarkdown(`${facts.map(escapeMd).join(' · ')}\n\n`);
		if (paper.abstract) {
			tooltip.appendMarkdown(`${escapeMd(paper.abstract)}\n\n`);
		}
		tooltip.appendMarkdown(`*From ${escapeMd(sourceBadge(paper))}*`);
		if (item.score !== undefined) {
			tooltip.appendMarkdown(` · *relevance to this project: ${item.score.toFixed(2)}*`);
		}
		tree.tooltip = tooltip;
		tree.command = { command: 'theoremdesk.literature.open', title: 'Open Paper', arguments: [item] };
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
			return [{ kind: 'note', label: `Asking ${this.sources.map((s) => s.name).join(', ')}...` }];
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

	async chooseSources(): Promise<void> {
		const enabled = new Set(enabledSources());
		const picks = await vscode.window.showQuickPick(
			ALL_SOURCES.map((id) => ({ label: SOURCE_NAMES[id], description: SOURCE_DESCRIPTIONS[id], id, picked: enabled.has(id) })),
			{ title: 'Search and recommend from', canPickMany: true },
		);
		if (picks && picks.length > 0) {
			await vscode.workspace
				.getConfiguration('theoremdesk.literature')
				.update('sources', picks.map((p) => p.id), vscode.ConfigurationTarget.Global);
		}
	}

	async search(): Promise<void> {
		const query = await vscode.window.showInputBox({
			title: `Search ${this.sources.map((s) => s.name).join(', ')}`,
			prompt: 'Title words, authors or topics, e.g. "large N limit superconformal" or "Bender pendulum"',
			value: this.query,
		});
		if (!query?.trim()) {
			return;
		}
		this.query = query.trim();
		await this.run('search', async () => {
			const { papers, errors } = await searchAll(this.sources, this.query!, { maxResults: 40 });
			this.results = papers;
			this.reportErrors(errors, papers.length === 0);
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
			this.recommended = await recommend(this.sources, tex.getText(), this.bibText, { maxResults: 20 });
		});
	}

	private reportErrors(errors: { source: SourceId; message: string }[], nothing: boolean): void {
		if (errors.length === 0) {
			return;
		}
		const which = errors.map((e) => SOURCE_NAMES[e.source]).join(', ');
		if (nothing && errors.length === this.sources.length) {
			throw new Error(errors[0].message);
		}
		void vscode.window.showWarningMessage(`Couldn't reach ${which}; showing results from the other sources. (${errors[0].message})`);
	}

	private async run(section: Section, work: () => Promise<void>): Promise<void> {
		this.busy = section;
		this.changed.fire(undefined);
		await vscode.commands.executeCommand('theoremdesk.literature.focus');
		try {
			await work();
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Couldn't reach the literature sources: ${(error as Error).message}. Literature search needs an internet connection.`,
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
		// INSPIRE's own entry (with the key physicists use) when it has the paper.
		const paper = findInBib(current, item.paper)
			? item.paper
			: await vscode.window.withProgress(
					{ location: { viewId: 'theoremdesk.literature' } },
					() => bestForBibliography(item.paper, this.sources),
				);
		const result = addToBib(current, paper);
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
				new Definition(
					'TheoremDesk Literature',
					process.execPath,
					[server],
					{ ELECTRON_RUN_AS_NODE: '1', THEOREMDESK_LITERATURE_SOURCES: enabledSources().join(',') },
					'0.2.0',
				),
			],
		}),
	);
}
