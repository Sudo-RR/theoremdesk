// The Library view: the literature database (library.ts) in the app.
// Papers are added from the Literature view, from a project's .bib, or as
// local PDFs; their text is read and embedded with the local models, and
// the library can then be searched by meaning or asked questions, with
// answers citing paper and page.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { displayName, indexBib, Paper } from './literature';
import { downloadPdf, Library, LibraryPaper, pdfPages, pdfUrl, SearchHit } from './library';
import { LocalAiService } from './localAiService';
import { askLibrary } from './rag';
import { createSources, lookupPaper } from './sources';
import { dataDirectory, findBundledTools } from './tools';

type Item = { kind: 'paper'; paper: LibraryPaper } | { kind: 'note'; label: string; command?: vscode.Command };

const nodeFs = {
	exists: (f: string) => fs.existsSync(f),
	readFile: (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined),
	listDir: (d: string) => (fs.existsSync(d) ? fs.readdirSync(d) : []),
};

export class LibraryView implements vscode.TreeDataProvider<Item>, vscode.Disposable {
	private readonly library = new Library(path.join(dataDirectory(process.platform, process.env, os.homedir()), 'library'));
	private readonly changed = new vscode.EventEmitter<Item | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	private busy: string | undefined;
	/** One paper at a time: the embedding model and the library files are shared. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly ai: LocalAiService,
	) {}

	/** The library itself, for the agent's search_library tool. */
	libraryStore(): Library {
		return this.library;
	}

	dispose(): void {
		this.changed.dispose();
	}

	getTreeItem(item: Item): vscode.TreeItem {
		if (item.kind === 'note') {
			const tree = new vscode.TreeItem(item.label);
			tree.command = item.command;
			tree.iconPath = item.command ? new vscode.ThemeIcon('add') : new vscode.ThemeIcon('loading~spin');
			return tree;
		}
		const p = item.paper;
		const tree = new vscode.TreeItem(p.title);
		const names = p.authors.map(displayName);
		tree.description = `${names.length > 2 ? `${names[0]} et al.` : names.join(', ')} · ${p.year || ''} · ${p.text === 'pdf' ? `${p.pages} pages` : 'abstract only'}`;
		tree.iconPath = new vscode.ThemeIcon(p.text === 'pdf' ? 'file-pdf' : 'note');
		tree.tooltip = `${p.title}\n${names.join(', ')}\n${p.chunks} passages indexed from ${p.text === 'pdf' ? 'the full text' : 'the abstract (no free PDF found)'}`;
		tree.contextValue = 'libraryPaper';
		tree.command = { command: 'theoremdesk.library.open', title: 'Open', arguments: [item] };
		return tree;
	}

	getChildren(item?: Item): Item[] {
		if (item) {
			return [];
		}
		const notes: Item[] = this.busy ? [{ kind: 'note', label: this.busy }] : [];
		const papers = this.library.list().map((paper): Item => ({ kind: 'paper', paper }));
		return [...notes, ...papers];
	}

	private refresh(): void {
		this.changed.fire(undefined);
	}

	private python(): { python: string; script: string } {
		const tools = findBundledTools(vscode.env.appRoot, process.platform, nodeFs);
		return { python: tools?.python ?? (process.platform === 'win32' ? 'python' : 'python3'), script: this.context.asAbsolutePath(path.join('scripts', 'pdf_text.py')) };
	}

	/** Read a paper's text (its free PDF, else its abstract) and index it. */
	private async ingest(paper: Paper & { file?: string }, pdfFile?: string): Promise<LibraryPaper> {
		let pages: string[] | undefined;
		let file = pdfFile;
		const url = pdfFile ? undefined : pdfUrl(paper);
		if (url) {
			try {
				file = await downloadPdf(url);
			} catch {
				file = undefined; // fall back to the abstract
			}
		}
		if (file) {
			const { python, script } = this.python();
			try {
				pages = await pdfPages(python, script, file);
			} finally {
				if (!pdfFile) {
					fs.rmSync(path.dirname(file), { recursive: true, force: true });
				}
			}
		}
		const embedder = await this.ai.client('embedding');
		return this.library.add(paper, pages, embedder, (done, total) => {
			this.busy = `Indexing ${shorten(paper.title)} (${done}/${total})`;
			this.refresh();
		});
	}

	private enqueue<T>(label: string, work: () => Promise<T>): Promise<T> {
		const run = async () => {
			this.busy = label;
			this.refresh();
			try {
				return await work();
			} finally {
				this.busy = undefined;
				this.refresh();
			}
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Add a paper from the Literature view (or any Paper). */
	async addPaper(arg: { paper?: Paper } | Paper | undefined, quiet = false): Promise<void> {
		const paper = arg && 'paper' in arg && arg.paper ? arg.paper : (arg as Paper | undefined);
		if (!paper?.title) {
			return;
		}
		try {
			const entry = await this.enqueue(`Reading ${shorten(paper.title)}`, () => this.ingest(paper));
			if (!quiet) {
				void vscode.window.showInformationMessage(
					`Added "${shorten(entry.title)}" to the library (${entry.text === 'pdf' ? `${entry.pages} pages` : 'abstract only: no free PDF'}).`,
				);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`Couldn't add "${shorten(paper.title)}" to the library: ${(error as Error).message}`);
		}
	}

	/** Add every paper the project's .bib files cite (by arXiv ID or DOI). */
	async addBibliography(): Promise<void> {
		const files = await vscode.workspace.findFiles('**/*.bib', '**/{node_modules,.lake,build}/**', 20);
		const bib = files.map((f) => fs.readFileSync(f.fsPath, 'utf8')).join('\n');
		const index = indexBib(bib);
		const ids = [...[...index.eprints].map((id) => `arXiv:${id}`), ...[...index.dois].map((doi) => `doi:${doi}`)];
		const missing = ids.filter((id) => !this.library.has(id.startsWith('arXiv:') ? { arxivId: id.slice(6) } : { doi: id.slice(4) }));
		if (missing.length === 0) {
			void vscode.window.showInformationMessage(
				ids.length === 0 ? 'No .bib file here cites papers by arXiv ID or DOI.' : `All ${ids.length} papers the bibliography cites are already in the library.`,
			);
			return;
		}
		const sources = createSources();
		let added = 0;
		const failed: string[] = [];
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Adding the bibliography to the library', cancellable: true },
			async (progress, token) => {
				for (const [i, id] of missing.entries()) {
					if (token.isCancellationRequested) {
						break;
					}
					progress.report({ message: `${i + 1} of ${missing.length}: ${id}`, increment: 100 / missing.length });
					try {
						const paper = await lookupPaper(sources, id);
						if (!paper?.title) {
							throw new Error('not found');
						}
						await this.enqueue(`Reading ${shorten(paper.title)}`, () => this.ingest(paper));
						added++;
					} catch {
						failed.push(id);
					}
				}
			},
		);
		void vscode.window.showInformationMessage(
			`Added ${added} paper${added === 1 ? '' : 's'} to the library.${failed.length ? ` Couldn't add ${failed.join(', ')}.` : ''}`,
		);
	}

	async addPdf(): Promise<void> {
		const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { PDF: ['pdf'] }, title: 'Add PDFs to the library' });
		for (const uri of picked ?? []) {
			const file = uri.fsPath;
			const title = await vscode.window.showInputBox({ title: `Title of ${path.basename(file)}`, value: path.basename(file, '.pdf').replace(/[_-]+/g, ' ') });
			if (!title) {
				continue;
			}
			const authors = (await vscode.window.showInputBox({ title: 'Authors (comma separated, optional)' })) ?? '';
			const year = Number(await vscode.window.showInputBox({ title: 'Year (optional)' })) || 0;
			const paper = {
				source: 'arxiv' as const,
				id: file,
				title,
				authors: authors.split(',').map((a) => a.trim()).filter(Boolean),
				abstract: '',
				year,
				url: vscode.Uri.file(file).toString(),
				file,
			};
			try {
				await this.enqueue(`Reading ${shorten(title)}`, () => this.ingest(paper, file));
			} catch (error) {
				void vscode.window.showErrorMessage(`Couldn't add ${path.basename(file)}: ${(error as Error).message}`);
			}
		}
	}

	remove(item: Item | undefined): void {
		if (item?.kind === 'paper' && this.library.remove(item.paper.key)) {
			this.refresh();
		}
	}

	async open(item: Item | undefined, page?: number): Promise<void> {
		if (item?.kind !== 'paper') {
			return;
		}
		const p = item.paper;
		const target = p.arxivId ? `https://arxiv.org/pdf/${p.arxivId}${page ? `#page=${page}` : ''}` : p.url;
		await vscode.env.openExternal(vscode.Uri.parse(target));
	}

	private emptyLibrary(): boolean {
		if (this.library.size.papers > 0) {
			return false;
		}
		void vscode.window.showInformationMessage('The library is empty. Add papers from the Literature view, your bibliography, or PDFs.');
		return true;
	}

	/** Find passages by meaning. */
	async search(): Promise<void> {
		if (this.emptyLibrary()) {
			return;
		}
		const query = await vscode.window.showInputBox({ title: 'Search the library', prompt: 'Describe what you are looking for, e.g. "separatrix of the pendulum in the complex plane"' });
		if (!query?.trim()) {
			return;
		}
		const hits = await vscode.window.withProgress({ location: { viewId: 'theoremdesk.library' } }, async () =>
			this.library.search(query, await this.ai.client('embedding'), { limit: 15 }),
		);
		const pick = await vscode.window.showQuickPick(
			hits.map((h) => ({ label: h.paper.title, description: `${pageLabel(h)} · ${h.score.toFixed(2)}`, detail: h.chunk.text.replace(/\s+/g, ' ').slice(0, 300), h })),
			{ title: `Passages about "${query}"`, matchOnDetail: true },
		);
		if (pick) {
			await this.open({ kind: 'paper', paper: pick.h.paper }, pick.h.chunk.page);
		}
	}

	/** Ask a question; the local agent model answers from the library, citing paper and page. */
	async ask(): Promise<void> {
		if (this.emptyLibrary()) {
			return;
		}
		const question = await vscode.window.showInputBox({ title: 'Ask the library', prompt: 'A question the papers in your library can answer' });
		if (!question?.trim()) {
			return;
		}
		try {
			const answer = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Answering from the library (local model)', cancellable: true },
				async (progress, token) => {
					const abort = new AbortController();
					token.onCancellationRequested(() => abort.abort());
					progress.report({ message: 'finding passages' });
					const embedder = await this.ai.client('embedding');
					progress.report({ message: 'loading the agent model' });
					const chat = await this.ai.client('chat');
					progress.report({ message: 'writing the answer' });
					return askLibrary(this.library, question, embedder, chat, { signal: abort.signal });
				},
			);
			const sources = answer.sources
				.map((s) => {
					const link = s.hit.paper.arxivId ? `https://arxiv.org/pdf/${s.hit.paper.arxivId}${s.hit.chunk.page ? `#page=${s.hit.chunk.page}` : ''}` : s.hit.paper.url;
					return `${s.n}. [${s.hit.paper.title}](${link}), ${s.label}`;
				})
				.join('\n');
			const warning = answer.invalidCitations.length
				? `\n\n> **Check this answer:** it cites source ${answer.invalidCitations.join(', ')}, which it wasn't given.\n`
				: '';
			const doc = await vscode.workspace.openTextDocument({
				language: 'markdown',
				content: `# ${question}\n\n${answer.text}${warning}\n\n## Sources\n\n${sources}\n\n*Answered by the local model from your library. Check each citation against the paper.*\n`,
			});
			await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
		} catch (error) {
			if (!/abort/i.test(String(error))) {
				void vscode.window.showErrorMessage(`Couldn't answer: ${(error as Error).message}`);
			}
		}
	}
}

function pageLabel(h: SearchHit): string {
	return h.chunk.page ? `p. ${h.chunk.page}` : 'abstract';
}

function shorten(title: string, n = 50): string {
	return title.length > n ? `${title.slice(0, n - 1)}…` : title;
}
