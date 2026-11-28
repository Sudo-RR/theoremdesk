// The startup wizard: a tab that defines a project step by step and then
// does the work. 1 Project (type, field, journal, parts), 2 Your research
// (a few lines, checked for clarity), 3 Search plan (queries, editable),
// 4 Papers (found, ranked and screened; you choose), 5 Create (folders,
// manuscript, bibliography, Lean, notebooks; papers into the library; the
// agent offered a first task). The steps' logic is in wizard.ts.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { isValidProjectName, listTemplates } from './generator';
import { bestForBibliography, Paper, SOURCE_NAMES, SourceId } from './literature';
import { embeddingQuery } from './llm';
import { LocalAiService } from './localAiService';
import { Providers } from './providers';
import { Journal } from './refstyle';
import { createSources, lookupPaper } from './sources';
import { findBundledTools } from './tools';
import {
	BriefReview,
	Candidate,
	fallbackPlan,
	FIELDS,
	findCandidates,
	fullBrief,
	introductionPrompt,
	JsonModel,
	KINDS,
	planSearch,
	preselect,
	reviewBrief,
	screenCandidates,
	SearchPlan,
	WizardChoices,
	writeProject,
} from './wizard';

export const PENDING_WIZARD = 'theoremdesk.wizard.pending';

export interface PendingWizard {
	folder: string;
	readme: string;
	manuscript?: string;
	prompt: string;
	library: Paper[];
}

type FromWebview =
	| { type: 'ready' }
	| { type: 'chooseFolder' }
	| { type: 'review'; choices: WizardChoices; brief: string }
	| { type: 'plan'; choices: WizardChoices; brief: string; answers: { question: string; answer: string }[] }
	| { type: 'search'; choices: WizardChoices; brief: string; plan: SearchPlan; sources: SourceId[]; screen: boolean }
	| { type: 'addPaper'; identifier: string }
	| { type: 'create'; choices: WizardChoices; brief: string; plan: SearchPlan; picked: number[]; extra: number[]; parent: string; name: string; addToLibrary: boolean; openIn: 'this' | 'new' }
	| { type: 'cancel' };

export class StartupWizard {
	private static current: StartupWizard | undefined;
	private readonly panel: vscode.WebviewPanel;
	private candidates: Candidate[] = [];
	private extra: Paper[] = [];
	private review: BriefReview | undefined;
	private abort = new AbortController();

	static open(context: vscode.ExtensionContext, ai: LocalAiService, providers: Providers): void {
		if (StartupWizard.current) {
			StartupWizard.current.panel.reveal();
			return;
		}
		StartupWizard.current = new StartupWizard(context, ai, providers);
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly ai: LocalAiService,
		private readonly providers: Providers,
	) {
		this.panel = vscode.window.createWebviewPanel('theoremdesk.wizard', 'New Project Wizard', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
		this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'theoremdesk.svg');
		this.panel.webview.html = this.html();
		this.panel.onDidDispose(() => {
			this.abort.abort();
			StartupWizard.current = undefined;
		});
		this.panel.webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m));
	}

	/** In extension tests: replies are collected here instead of going to the page. */
	private testReplies: object[] | undefined;

	private post(m: object): void {
		if (this.testReplies) {
			this.testReplies.push(m);
			return;
		}
		void this.panel.webview.postMessage(m);
	}

	/**
	 * Extension tests only (see extension.ts): send the wizard a message as its
	 * page would, and return its replies. A create doesn't open the folder.
	 */
	static async testMessage(m: FromWebview): Promise<object[]> {
		const w = StartupWizard.current;
		if (!w) {
			throw new Error('the wizard is not open');
		}
		w.testReplies = [];
		w.testing = true;
		try {
			await w.handle(m);
			return w.testReplies;
		} finally {
			w.testReplies = undefined;
		}
	}

	private testing = false;

	private progress(text: string): void {
		this.post({ type: 'progress', text });
	}

	/** The model for the wizard's AI steps, or undefined (the wizard then works without AI). */
	private async model(): Promise<JsonModel | undefined> {
		try {
			if (this.providers.current() === 'local' && !this.ai.available) {
				return undefined;
			}
			this.progress(`Loading ${this.providers.label()}...`);
			return (await this.providers.model()) as unknown as JsonModel;
		} catch (error) {
			this.post({ type: 'notice', text: `The AI isn't available (${(error as Error).message}), so this step runs without it.` });
			return undefined;
		}
	}

	private async handle(m: FromWebview): Promise<void> {
		try {
			switch (m.type) {
				case 'ready': {
					const journals = this.journals().map((j) => ({ name: j.name, field: j.field, template: j.template }));
					const templates = listTemplates(this.context.asAbsolutePath('latex-templates')).map((t) => ({ id: t.id, label: t.label, category: t.category ?? 'Other' }));
					const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
					this.post({
						type: 'init',
						kinds: KINDS,
						fields: FIELDS.map((f) => ({ id: f.id, label: f.label, group: f.group, sources: f.sources })),
						journals,
						templates,
						sourceNames: SOURCE_NAMES,
						author: this.context.globalState.get<string>('theoremdesk.authorName') ?? os.userInfo().username,
						parent: folder ? path.dirname(folder) : path.join(os.homedir(), 'Documents'),
						ai: this.providers.current() !== 'local' || this.ai.available ? this.providers.label() : undefined,
					});
					return;
				}
				case 'chooseFolder': {
					const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: 'Create the Project Here' });
					if (picked?.[0]) {
						this.post({ type: 'folder', parent: picked[0].fsPath });
					}
					return;
				}
				case 'review': {
					const model = await this.model();
					if (!model) {
						this.post({ type: 'review', review: undefined });
						return;
					}
					this.progress('Reading your brief...');
					this.review = await reviewBrief(model, m.choices, m.brief, this.abort.signal);
					this.post({ type: 'review', review: this.review });
					return;
				}
				case 'plan': {
					const brief = fullBrief(m.brief, m.answers);
					const field = FIELDS.find((f) => f.id === m.choices.fieldId) ?? FIELDS[0];
					const model = await this.model();
					let plan: SearchPlan;
					if (model) {
						this.progress('Planning the literature search...');
						try {
							plan = await planSearch(model, m.choices, brief, this.abort.signal);
						} catch (error) {
							this.post({ type: 'notice', text: `The AI's plan wasn't usable (${(error as Error).message}); here's one from your brief's main terms. Edit it as you like.` });
							plan = fallbackPlan(brief, m.choices.title, field);
						}
					} else {
						plan = fallbackPlan(brief, m.choices.title, field);
					}
					this.post({ type: 'plan', plan, brief });
					return;
				}
				case 'search': {
					const sources = createSources(m.sources);
					const embedder = this.ai.available ? await this.ai.client('embedding').catch(() => undefined) : undefined;
					const { candidates, errors } = await findCandidates(sources, m.plan, m.brief, {
						embedder,
						embedQuery: embeddingQuery,
						limit: 30,
						onProgress: (text) => this.progress(text),
						signal: this.abort.signal,
					});
					if (errors.length) {
						this.post({ type: 'notice', text: `Some sources didn't answer: ${errors.join('; ')}` });
					}
					let ranked = candidates;
					if (m.screen && candidates.length) {
						const model = await this.model();
						if (model) {
							ranked = await screenCandidates(model, m.brief, candidates, { limit: 15, onProgress: (d, n) => this.progress(`The AI is reading the abstracts: ${d} of ${n}`), signal: this.abort.signal });
						}
					}
					this.candidates = ranked;
					this.post({ type: 'papers', papers: ranked.map((c) => this.paperView(c.paper, c)), picked: [...preselect(ranked)] });
					return;
				}
				case 'addPaper': {
					this.progress(`Looking up ${m.identifier}...`);
					const paper = await lookupPaper(createSources(), m.identifier);
					if (!paper?.title) {
						this.post({ type: 'notice', text: `No source has ${m.identifier}. Give an arXiv ID (2101.01234, hep-th/9711200) or a DOI.` });
						this.post({ type: 'progress', text: '' });
						return;
					}
					this.extra.push(paper);
					this.post({ type: 'extra', paper: this.paperView(paper), index: this.extra.length - 1 });
					return;
				}
				case 'create':
					await this.create(m);
					return;
				case 'cancel':
					this.panel.dispose();
					return;
			}
		} catch (error) {
			if (!this.abort.signal.aborted) {
				this.post({ type: 'error', text: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	private journals(): Journal[] {
		return (JSON.parse(fs.readFileSync(this.context.asAbsolutePath(path.join('data', 'journals.json')), 'utf8')) as { journals: Journal[] }).journals;
	}

	private paperView(p: Paper, c?: Candidate) {
		const names = p.authors.slice(0, 3).join('; ') + (p.authors.length > 3 ? ' et al.' : '');
		return {
			title: p.title,
			authors: names,
			year: p.year,
			venue: p.journalShort ?? p.journal ?? (p.arxivId ? `arXiv:${p.arxivId}` : ''),
			url: p.url,
			abstract: p.abstract.slice(0, 600),
			sources: (p.sources ?? [p.source]).map((s) => SOURCE_NAMES[s]).join(', '),
			rating: c?.rating,
			reason: c?.reason,
			similarity: c?.similarity,
		};
	}

	private async create(m: Extract<FromWebview, { type: 'create' }>): Promise<void> {
		if (!isValidProjectName(m.name)) {
			throw new Error('The folder name may use letters, numbers, dots, dashes and underscores, starting with a letter or number.');
		}
		const target = path.join(m.parent, m.name);
		await this.context.globalState.update('theoremdesk.authorName', m.choices.author);
		const chosen = [...m.picked.map((i) => this.candidates[i]?.paper), ...m.extra.map((i) => this.extra[i])].filter((p): p is Paper => Boolean(p));
		// The best BibTeX for each: INSPIRE's own when it has the paper.
		const sources = createSources();
		const papers: Paper[] = [];
		for (const [i, p] of chosen.entries()) {
			this.progress(`Preparing BibTeX ${i + 1} of ${chosen.length}: ${p.title.slice(0, 60)}`);
			papers.push(await bestForBibliography(p, sources).catch(() => p));
		}
		this.progress('Writing the project...');
		const toolchain = (() => {
			try {
				return fs.readFileSync(path.join(vscode.env.appRoot, '..', 'tools', 'lean', 'toolchains.txt'), 'utf8').split(/\r?\n/)[0].trim() || 'leanprover/lean4:v4.36.0';
			} catch {
				return 'leanprover/lean4:v4.36.0';
			}
		})();
		const written = writeProject(
			{
				choices: m.choices,
				brief: m.brief,
				review: this.review,
				plan: m.plan,
				papers,
				latexTemplates: this.context.asAbsolutePath('latex-templates'),
				journals: { journals: this.journals() },
				toolchain,
			},
			target,
		);
		if (m.choices.git) {
			this.progress('Starting a Git repository...');
			// The bundled Git (Windows), else the system's.
			const bundled = findBundledTools(vscode.env.appRoot, process.platform, { exists: fs.existsSync, readFile: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined), listDir: (d) => (fs.existsSync(d) ? fs.readdirSync(d) : []) });
			const git = bundled?.gitBin ? path.join(bundled.gitBin, process.platform === 'win32' ? 'git.exe' : 'git') : 'git';
			const failed = await new Promise<string | undefined>((resolve) => execFile(git, ['init', '-q'], { cwd: target, windowsHide: true }, (error, _out, stderr) => resolve(error ? stderr.trim() || error.message : undefined)));
			if (failed) {
				void vscode.window.showWarningMessage(`The project was created, but Git couldn't start a repository in it: ${failed}`);
			}
		}
		const pending: PendingWizard = {
			folder: target,
			readme: path.join(target, 'README.md'),
			manuscript: written.manuscript,
			prompt: introductionPrompt(written),
			library: m.addToLibrary ? papers : [],
		};
		await this.context.globalState.update(PENDING_WIZARD, pending);
		this.post({ type: 'created', folder: target, files: written.files.length, papers: written.keys.length });
		if (!this.testing) {
			await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), m.openIn === 'new');
		}
	}

	private html(): string {
		const nonce = [...Array(24)].map(() => Math.random().toString(36)[2]).join('');
		return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
	body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); max-width: 900px; margin: 0 auto; padding: 16px 24px 48px; line-height: 1.45; }
	h1 { font-size: 1.5em; margin: 0 0 4px; } h2 { font-size: 1.15em; margin: 18px 0 8px; }
	.sub { color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
	ol.steps { display: flex; gap: 6px; list-style: none; padding: 0; margin: 12px 0 20px; flex-wrap: wrap; }
	ol.steps li { padding: 3px 10px; border-radius: 12px; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
	ol.steps li.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
	ol.steps li.done { color: var(--vscode-foreground); }
	section { display: none; } section.on { display: block; }
	.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 8px; }
	.card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; cursor: pointer; }
	.card.on { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
	.card b { display: block; } .card span { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
	label.row { display: block; margin: 10px 0 4px; font-weight: 600; }
	input[type=text], select, textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 5px 6px; font-family: inherit; font-size: inherit; }
	textarea { min-height: 140px; resize: vertical; }
	.checks label { display: block; margin: 4px 0; }
	.hint { color: var(--vscode-descriptionForeground); font-size: 0.92em; margin: 4px 0; }
	.box { border-left: 3px solid var(--vscode-textLink-foreground); background: var(--vscode-textBlockQuote-background); padding: 8px 12px; margin: 10px 0; }
	.box.warn { border-color: var(--vscode-editorWarning-foreground); } .box.ok { border-color: var(--vscode-testing-iconPassed); } .box.err { border-color: var(--vscode-errorForeground); }
	.nav { display: flex; gap: 8px; margin-top: 20px; align-items: center; }
	button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; border-radius: 3px; cursor: pointer; font-size: inherit; }
	button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
	button:disabled { opacity: 0.5; cursor: default; }
	#progress { color: var(--vscode-descriptionForeground); font-style: italic; }
	.query { display: flex; gap: 6px; margin: 4px 0; } .query input:first-child { flex: 2; } .query input:nth-child(2) { flex: 1; }
	.paper { display: flex; gap: 10px; border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 0; }
	.paper input { margin-top: 4px; } .paper .t { font-weight: 600; } .paper .m { color: var(--vscode-descriptionForeground); font-size: 0.92em; }
	.paper details { font-size: 0.92em; } .badge { display: inline-block; min-width: 1.2em; text-align: center; border-radius: 8px; padding: 0 6px; margin-right: 6px; font-size: 0.85em; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
	.r3 { background: var(--vscode-testing-iconPassed); color: var(--vscode-editor-background); } .r0 { opacity: 0.6; }
	a { color: var(--vscode-textLink-foreground); }
</style></head>
<body>
<h1>Start a new project</h1>
<p class="sub">Define the project; TheoremDesk sets it up, finds the literature and fills your bibliography.</p>
<ol class="steps" id="steps"><li>1 Project</li><li>2 Your research</li><li>3 Search plan</li><li>4 Papers</li><li>5 Create</li></ol>
<div id="notice"></div>

<section id="s1">
	<h2>What are you starting?</h2>
	<div class="cards" id="kinds"></div>
	<label class="row" for="field">Field</label>
	<select id="field"></select>
	<label class="row" for="journal">Aiming for a journal? (sets the reference style)</label>
	<select id="journal"><option value="">Not yet / no journal</option></select>
	<label class="row" for="template">Document template</label>
	<select id="template"></select>
	<div class="checks"><label class="row">Include</label>
		<label><input type="checkbox" id="lean"> A Lean project (Physlib for physics, Mathlib for mathematics)</label>
		<label><input type="checkbox" id="notebooks"> Jupyter notebooks (SymPy, NumPy, SciPy)</label>
		<label><input type="checkbox" id="git" checked> A Git repository</label>
	</div>
	<label class="row" for="author">Your name, as it should appear on the document</label>
	<input type="text" id="author">
	<div class="nav"><button id="n1">Next</button><button class="secondary" id="cancel">Cancel</button></div>
</section>

<section id="s2">
	<h2>Describe your research in a few lines</h2>
	<p class="hint">The literature search starts from this, so be specific. A good brief says:</p>
	<ul class="hint"><li><b>what</b> you study (the system, structure, equation or conjecture),</li><li><b>what</b> you want to find out, prove, compute or build,</li><li><b>how</b>, if you know (method, technique, tools),</li><li>and <b>the setting</b> (regime, dimension, assumptions).</li></ul>
	<p class="hint">Example: <i>"I want to compute the quasinormal mode frequencies of Kerr black holes for gravitational perturbations with Leaver's continued-fraction method, and study the overtones as the spin approaches extremality."</i> Name papers you build on, if any.</p>
	<textarea id="brief" placeholder="What I'm working on..."></textarea>
	<div id="review"></div>
	<div class="nav"><button class="secondary" id="b2">Back</button><button id="check">Check my brief</button><button id="n2">Plan the search</button></div>
</section>

<section id="s3">
	<h2>Search plan</h2>
	<p class="hint">Edit anything: these exact phrases are searched.</p>
	<label class="row" for="title">Working title</label>
	<input type="text" id="title">
	<label class="row">Keywords</label>
	<input type="text" id="keywords">
	<label class="row">Searches</label>
	<div id="queries"></div>
	<button class="secondary" id="addq">Add a search</button>
	<div class="checks"><label class="row">Search in</label><div id="sources"></div></div>
	<div class="checks"><label><input type="checkbox" id="screen" checked> Let the AI read the abstracts of the 15 closest papers and rate their relevance (a few minutes on a laptop; better choices)</label></div>
	<div class="nav"><button class="secondary" id="b3">Back</button><button id="n3">Find papers</button></div>
</section>

<section id="s4">
	<h2>Papers</h2>
	<p class="hint">Ticked papers go into your bibliography (and your library, if you choose). Ratings: <span class="badge r3">3</span> on your topic, <span class="badge">2</span> closely related, <span class="badge">1</span> background, <span class="badge r0">0</span> not relevant.</p>
	<div id="papers"></div>
	<label class="row" for="ident">Add a paper you know (arXiv ID or DOI)</label>
	<div class="query"><input type="text" id="ident" placeholder="e.g. gr-qc/0411025 or 10.1103/RevModPhys.83.793"><button class="secondary" id="addp">Add</button></div>
	<div class="nav"><button class="secondary" id="b4">Back</button><button id="n4">Next</button><span id="count" class="hint"></span></div>
</section>

<section id="s5">
	<h2>Create the project</h2>
	<label class="row" for="name">Folder name</label>
	<input type="text" id="name">
	<label class="row">Location</label>
	<div class="query"><input type="text" id="parent"><button class="secondary" id="browse">Choose...</button></div>
	<div class="checks">
		<label><input type="checkbox" id="library" checked> Read the chosen papers into the Library (full text when free), so you can search them and ask questions</label>
		<label><input type="radio" name="open" value="this" checked> Open the project in this window</label>
		<label><input type="radio" name="open" value="new"> Open it in a new window</label>
	</div>
	<div id="summary" class="box"></div>
	<div class="nav"><button class="secondary" id="b5">Back</button><button id="create">Create the project</button></div>
</section>

<p id="progress"></p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let D = null, kind = 'paper', step = 1, review = null, plan = null, briefUsed = '', papers = [], picked = new Set(), extra = [], busy = false;

function show(n) {
	step = n;
	document.querySelectorAll('section').forEach((s, i) => s.classList.toggle('on', i + 1 === n));
	[...$('steps').children].forEach((li, i) => { li.classList.toggle('on', i + 1 === n); li.classList.toggle('done', i + 1 < n); });
	notice('');
	window.scrollTo(0, 0);
}
function notice(text, cls = '') { $('notice').innerHTML = text ? '<div class="box ' + cls + '">' + esc(text) + '</div>' : ''; }
function setBusy(b, text = '') { busy = b; $('progress').textContent = text; document.querySelectorAll('button').forEach((x) => (x.disabled = b && x.id !== 'cancel')); }
function choices() {
	return { kind, fieldId: $('field').value, title: $('title').value.trim() || plan?.title || 'Untitled project', author: $('author').value.trim(), template: $('template').value || undefined, journal: $('journal').value || undefined, lean: $('lean').checked, notebooks: $('notebooks').checked, git: $('git').checked };
}
function renderKinds() {
	$('kinds').innerHTML = D.kinds.map((k) => '<div class="card' + (k.id === kind ? ' on' : '') + '" data-k="' + k.id + '"><b>' + esc(k.label) + '</b><span>' + esc(k.detail) + '</span></div>').join('');
	$('kinds').querySelectorAll('.card').forEach((c) => (c.onclick = () => { kind = c.dataset.k; const k = D.kinds.find((x) => x.id === kind); $('lean').checked = k.lean; $('notebooks').checked = k.notebooks; pickTemplate(); renderKinds(); }));
}
function pickTemplate() {
	const j = D.journals.find((x) => x.name === $('journal').value);
	const k = D.kinds.find((x) => x.id === kind);
	// A journal's template for papers; the kind's own for theses, talks and reports.
	$('template').value = j && (kind === 'paper' || kind === 'formalisation') ? j.template : k.template;
}
function renderSources() {
	const f = D.fields.find((x) => x.id === $('field').value);
	$('sources').innerHTML = Object.entries(D.sourceNames).map(([id, name]) => '<label><input type="checkbox" data-s="' + id + '"' + (f.sources.includes(id) ? ' checked' : '') + '> ' + esc(name) + '</label>').join('');
}
function renderQueries() {
	$('queries').innerHTML = plan.queries.map((q, i) => '<div class="query"><input type="text" data-q="' + i + '" value="' + esc(q.query) + '"><input type="text" data-p="' + i + '" value="' + esc(q.purpose) + '" placeholder="what it covers"><button class="secondary" data-x="' + i + '">Remove</button></div>').join('');
	$('queries').querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => { readPlan(); plan.queries.splice(Number(b.dataset.x), 1); renderQueries(); }));
}
function readPlan() {
	plan.title = $('title').value.trim();
	plan.keywords = $('keywords').value.split(',').map((s) => s.trim()).filter(Boolean);
	plan.queries = [...$('queries').querySelectorAll('[data-q]')].map((el) => ({ query: el.value.trim(), purpose: $('queries').querySelector('[data-p="' + el.dataset.q + '"]').value.trim() })).filter((q) => q.query);
}
function renderReview() {
	if (!review) { $('review').innerHTML = D.ai ? '' : '<div class="box warn">No AI model is available, so your brief isn\\'t checked; the search uses its main terms. Write it as specifically as you can.</div>'; return; }
	if (review.clear) { $('review').innerHTML = '<div class="box ok"><b>Clear enough to search.</b> In short: ' + esc(review.summary) + '</div>'; return; }
	$('review').innerHTML = '<div class="box warn"><b>A few questions would make the search sharper</b> (answer any you can, or continue anyway):' +
		review.questions.map((q, i) => '<label class="row">' + esc(q) + '</label><input type="text" data-a="' + i + '">').join('') + '</div>';
}
function answers() { return review && !review.clear ? review.questions.map((q, i) => ({ question: q, answer: ($('review').querySelector('[data-a="' + i + '"]') || {}).value || '' })) : []; }
function renderPapers() {
	if (!papers.length && !extra.length) { $('papers').innerHTML = '<div class="box warn">No papers found. Go back and broaden the searches, or add papers you know below.</div>'; }
	else $('papers').innerHTML = [...papers.map((p, i) => paperRow(p, 'p' + i, picked.has(i))), ...extra.map((p, i) => paperRow(p, 'e' + i, true))].join('');
	$('papers').querySelectorAll('input[type=checkbox]').forEach((c) => (c.onchange = () => { const id = c.dataset.id; if (id[0] === 'p') { c.checked ? picked.add(Number(id.slice(1))) : picked.delete(Number(id.slice(1))); } else { extra[Number(id.slice(1))].off = !c.checked; } count(); }));
	count();
}
function paperRow(p, id, on) {
	const badge = p.rating === undefined ? '' : '<span class="badge' + (p.rating === 3 ? ' r3' : p.rating === 0 ? ' r0' : '') + '">' + p.rating + '</span>';
	return '<div class="paper"><input type="checkbox" data-id="' + id + '"' + (on ? ' checked' : '') + '><div><div class="t">' + badge + '<a href="' + esc(p.url) + '">' + esc(p.title) + '</a></div><div class="m">' + esc(p.authors) + ' · ' + esc(p.year || '') + (p.venue ? ' · ' + esc(p.venue) : '') + ' · from ' + esc(p.sources) + '</div>' +
		(p.reason ? '<div class="m"><i>' + esc(p.reason) + '</i></div>' : '') + (p.abstract ? '<details><summary>Abstract</summary>' + esc(p.abstract) + '</details>' : '') + '</div></div>';
}
function count() { const n = picked.size + extra.filter((e) => !e.off).length; $('count').textContent = n + ' paper' + (n === 1 ? '' : 's') + ' chosen'; }
function slugify(s) { return (s || 'project').toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 5).join('-') || 'project'; }
function renderSummary() {
	const c = choices(); const n = picked.size + extra.filter((e) => !e.off).length;
	const t = D.templates.find((x) => x.id === c.template);
	$('summary').innerHTML = '<b>' + esc(c.title) + '</b><br>' + [t ? 'Manuscript: ' + esc(t.label) + (c.journal ? ', ' + esc(c.journal) + ' reference style' : '') : 'No manuscript', n + ' paper' + (n === 1 ? '' : 's') + ' in references.bib', c.lean ? 'Lean project' : '', c.notebooks ? 'notebooks' : '', c.git ? 'Git repository' : ''].filter(Boolean).join(' · ');
}

$('cancel').onclick = () => vscode.postMessage({ type: 'cancel' });
$('field').onchange = renderSources;
$('journal').onchange = pickTemplate;
$('n1').onclick = () => { if (!$('author').value.trim()) { notice('Add your name for the document.', 'warn'); return; } show(2); renderReview(); };
$('b2').onclick = () => show(1);
$('check').onclick = () => { if ($('brief').value.trim().length < 20) { notice('Write a few lines about your research first.', 'warn'); return; } setBusy(true, 'Reading your brief...'); vscode.postMessage({ type: 'review', choices: choices(), brief: $('brief').value }); };
$('n2').onclick = () => { if ($('brief').value.trim().length < 20) { notice('Write a few lines about your research first.', 'warn'); return; } setBusy(true, 'Planning the search...'); vscode.postMessage({ type: 'plan', choices: choices(), brief: $('brief').value, answers: answers() }); };
$('b3').onclick = () => show(2);
$('addq').onclick = () => { readPlan(); plan.queries.push({ query: '', purpose: '' }); renderQueries(); };
$('n3').onclick = () => { readPlan(); if (!plan.queries.length) { notice('Add at least one search.', 'warn'); return; } const sources = [...$('sources').querySelectorAll('input:checked')].map((x) => x.dataset.s); if (!sources.length) { notice('Choose at least one source.', 'warn'); return; } setBusy(true, 'Searching...'); vscode.postMessage({ type: 'search', choices: choices(), brief: briefUsed, plan, sources, screen: $('screen').checked && !!D.ai }); };
$('b4').onclick = () => show(3);
$('addp').onclick = () => { const v = $('ident').value.trim(); if (v) { setBusy(true, 'Looking it up...'); vscode.postMessage({ type: 'addPaper', identifier: v }); } };
$('n4').onclick = () => { show(5); if (!$('name').value) $('name').value = slugify(plan.title); renderSummary(); };
$('b5').onclick = () => show(4);
$('browse').onclick = () => vscode.postMessage({ type: 'chooseFolder' });
$('create').onclick = () => {
	const name = $('name').value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) { notice('The folder name may use letters, numbers, dots, dashes and underscores, starting with a letter or number.', 'warn'); return; }
	readPlan();
	setBusy(true, 'Creating the project...');
	vscode.postMessage({ type: 'create', choices: choices(), brief: briefUsed, plan, picked: [...picked], extra: extra.map((e, i) => (e.off ? -1 : i)).filter((i) => i >= 0), parent: $('parent').value.trim(), name, addToLibrary: $('library').checked, openIn: document.querySelector('input[name=open]:checked').value });
};

window.addEventListener('message', ({ data: m }) => {
	if (m.type === 'init') {
		D = m;
		const groups = {};
		D.fields.forEach((f) => (groups[f.group] = groups[f.group] || []).push(f));
		$('field').innerHTML = Object.entries(groups).map(([g, fs]) => '<optgroup label="' + esc(g) + '">' + fs.map((f) => '<option value="' + f.id + '">' + esc(f.label) + '</option>').join('') + '</optgroup>').join('');
		$('journal').innerHTML += D.journals.map((j) => '<option>' + esc(j.name) + '</option>').join('');
		const cats = {};
		D.templates.forEach((t) => (cats[t.category] = cats[t.category] || []).push(t));
		$('template').innerHTML = '<option value="">No document</option>' + Object.entries(cats).map(([c, ts]) => '<optgroup label="' + esc(c) + '">' + ts.map((t) => '<option value="' + t.id + '">' + esc(t.label) + '</option>').join('') + '</optgroup>').join('');
		$('author').value = D.author; $('parent').value = D.parent;
		$('notebooks').checked = true;
		renderKinds(); pickTemplate(); renderSources();
		if (!D.ai) $('screen').checked = false;
		show(1);
	} else if (m.type === 'progress') { $('progress').textContent = m.text; }
	else if (m.type === 'notice') { notice(m.text, 'warn'); }
	else if (m.type === 'error') { setBusy(false); notice(m.text, 'err'); }
	else if (m.type === 'folder') { $('parent').value = m.parent; }
	else if (m.type === 'review') { setBusy(false); review = m.review; renderReview(); }
	else if (m.type === 'plan') { setBusy(false); plan = m.plan; briefUsed = m.brief; $('title').value = plan.title; $('keywords').value = plan.keywords.join(', '); renderQueries(); show(3); }
	else if (m.type === 'papers') { setBusy(false); papers = m.papers; picked = new Set(m.picked); show(4); renderPapers(); }
	else if (m.type === 'extra') { setBusy(false); extra.push(m.paper); $('ident').value = ''; renderPapers(); }
	else if (m.type === 'created') { setBusy(true, 'Created ' + m.folder + ' (' + m.files + ' files, ' + m.papers + ' papers). Opening it...'); }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
	}
}

/**
 * After the wizard's project opens: show its README, read the chosen papers
 * into the library in the background, and offer the agent's first task.
 */
export async function finishWizard(
	context: vscode.ExtensionContext,
	library: { addPaper(p: Paper, quiet: boolean): Promise<void> } | undefined,
	agent: { ask(text?: string): Promise<string | undefined> },
): Promise<void> {
	const pending = context.globalState.get<PendingWizard>(PENDING_WIZARD);
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!pending || !folder || path.resolve(folder) !== path.resolve(pending.folder)) {
		return;
	}
	await context.globalState.update(PENDING_WIZARD, undefined);
	await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(pending.readme));
	if (pending.manuscript && fs.existsSync(pending.manuscript)) {
		await vscode.window.showTextDocument(vscode.Uri.file(pending.manuscript), { preview: false, viewColumn: vscode.ViewColumn.One });
	}
	if (library && pending.library.length) {
		void (async () => {
			for (const p of pending.library) {
				await library.addPaper(p, true);
			}
			void vscode.window.showInformationMessage(`The ${pending.library.length} chosen papers are in your Library: search them or ask questions from the Library view.`);
		})();
	}
	const draft = 'Draft the Introduction';
	const choice = await vscode.window.showInformationMessage('Your project is ready. Ask the agent to draft an introduction from your reading list? You review its edit before anything changes.', draft, 'Not Now');
	if (choice === draft) {
		await agent.ask(pending.prompt);
	}
}
