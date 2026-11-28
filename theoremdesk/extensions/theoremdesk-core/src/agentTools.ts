// The tools the research agent can use. Free of the `vscode` API: the app
// passes in the project folder, the bundled tools and the library.
//
// Read-only tools run freely. Tools that change files or run code
// (writing files, Lean, LaTeX, Python) need the user's approval per call,
// because Lean files and Python can run arbitrary programs.

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { AgentTool } from './agent';
import { addToBib, bestForBibliography, describe, LiteratureSource, SourceId } from './literature';
import { citeLabel, Embedder, Library } from './library';
import { lookupPaper, searchAll } from './sources';

export interface AgentToolContext {
	/** The project folder: every path the agent uses must be inside it. */
	root: string;
	python: string;
	/** Folder holding pdflatex and bibtex; else they're looked up on PATH. */
	texBin?: string;
	library?: Library;
	embedder?: () => Promise<Embedder>;
	sources: LiteratureSource[];
	env?: NodeJS.ProcessEnv;
}

const SKIP_DIRS = new Set(['.git', '.lake', 'node_modules', '.venv', 'build', '__pycache__', '.ipynb_checkpoints']);

/** A path inside the project, or an error: the agent can't reach outside it. */
export function insideProject(root: string, p: unknown): string {
	if (typeof p !== 'string' || !p.trim()) {
		throw new Error('path is required');
	}
	const full = path.resolve(root, p);
	const rel = path.relative(root, full);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`${p} is outside the project folder`);
	}
	return full;
}

const str = (v: unknown, name: string): string => {
	if (typeof v !== 'string' || !v.trim()) {
		throw new Error(`${name} is required`);
	}
	return v;
};

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv | undefined, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; output: string }> {
	return new Promise((resolve) => {
		execFile(cmd, args, { cwd, env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
			if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				resolve({ code: 127, output: `${cmd} isn't installed or isn't on PATH` });
				return;
			}
			const timedOut = error && (error as { killed?: boolean }).killed;
			resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: timedOut ? `${output}\n[stopped after ${timeoutMs / 1000} s]` : output });
		});
	});
}

function listFiles(root: string, dir: string, out: string[], max: number): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (out.length >= max) {
			return;
		}
		if (e.isDirectory()) {
			if (!SKIP_DIRS.has(e.name)) {
				listFiles(root, path.join(dir, e.name), out, max);
			}
		} else {
			out.push(path.relative(root, path.join(dir, e.name)).replace(/\\/g, '/'));
		}
	}
}

/** The Lake project a file belongs to: the nearest folder up with a lakefile. */
export function lakeRoot(file: string, stop: string): string | undefined {
	for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
		if (['lakefile.lean', 'lakefile.toml'].some((f) => fs.existsSync(path.join(dir, f)))) {
			return dir;
		}
		if (dir === stop || dir === path.dirname(dir)) {
			return undefined;
		}
	}
}

/** Lean's messages, without the noise, and whether the file relies on sorry. */
export function summarizeLean(output: string, code: number): string {
	const lines = output.split(/\r?\n/).filter((l) => l.trim());
	const errors = lines.filter((l) => /: error:/.test(l)).length;
	const sorry = lines.some((l) => /declaration uses 'sorry'/.test(l));
	const verdict = code === 0 && errors === 0 ? (sorry ? 'Compiles, but uses sorry: not a proof.' : 'Compiles with no errors.') : `Does not compile (${errors || 'some'} error${errors === 1 ? '' : 's'}).`;
	return `${verdict}\n${lines.join('\n')}`.trim();
}

export function createAgentTools(ctx: AgentToolContext): AgentTool[] {
	const env = ctx.env ?? process.env;
	const tex = (name: string) => (ctx.texBin ? path.join(ctx.texBin, process.platform === 'win32' ? `${name}.exe` : name) : name);
	const tools: AgentTool[] = [
		{
			name: 'search_literature',
			description: 'Search arXiv, INSPIRE-HEP, zbMATH Open, Crossref and OpenAlex for papers. Returns title, authors, year, identifiers, venue and abstract.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Title words, authors or topic' },
					sources: { type: 'array', items: { type: 'string', enum: ['arxiv', 'inspire', 'zbmath', 'crossref', 'openalex'] } },
					max_results: { type: 'number' },
				},
				required: ['query'],
			},
			summarize: (a) => `search the literature for "${a.query}"`,
			async run(a) {
				const wanted = Array.isArray(a.sources) ? ctx.sources.filter((s) => (a.sources as SourceId[]).includes(s.id)) : ctx.sources;
				const { papers, errors } = await searchAll(wanted.length ? wanted : ctx.sources, str(a.query, 'query'), { maxResults: Math.min(Number(a.max_results) || 8, 20) });
				const failed = errors.length ? `\n(Not reached: ${errors.map((e) => e.source).join(', ')})` : '';
				return (papers.length ? papers.map((p, i) => `${i + 1}. ${describe(p, 400)}`).join('\n\n') : 'No papers found.') + failed;
			},
		},
		{
			name: 'add_to_bibliography',
			description: "Add a paper, by arXiv ID or DOI, to the project's .bib file and return the key to \\cite. INSPIRE's own entry is used when it has the paper.",
			parameters: {
				type: 'object',
				properties: { identifier: { type: 'string', description: 'arXiv ID or DOI' }, bib_file: { type: 'string', description: 'Path of the .bib file in the project (default: the only one, or references.bib)' } },
				required: ['identifier'],
			},
			needsApproval: true,
			summarize: (a) => `add ${a.identifier} to ${a.bib_file ?? 'the bibliography'}`,
			async run(a) {
				let bib = typeof a.bib_file === 'string' ? insideProject(ctx.root, a.bib_file) : undefined;
				if (!bib) {
					const all: string[] = [];
					listFiles(ctx.root, ctx.root, all, 5000);
					const bibs = all.filter((f) => f.endsWith('.bib'));
					if (bibs.length > 1) {
						throw new Error(`the project has several .bib files (${bibs.join(', ')}); give bib_file`);
					}
					bib = path.join(ctx.root, bibs[0] ?? 'references.bib');
				}
				if (!bib.endsWith('.bib')) {
					throw new Error('bib_file must be a .bib file');
				}
				const found = await lookupPaper(ctx.sources, str(a.identifier, 'identifier'));
				if (!found?.title) {
					throw new Error(`no source has ${a.identifier}`);
				}
				const paper = await bestForBibliography(found, ctx.sources);
				const current = fs.existsSync(bib) ? fs.readFileSync(bib, 'utf8') : '';
				const result = addToBib(current, paper);
				if (result.added) {
					fs.writeFileSync(bib, result.text);
				}
				return `${result.added ? 'Added' : 'Already in'} ${path.relative(ctx.root, bib)}: "${paper.title}". Cite it as \\cite{${result.key}}.`;
			},
		},
		{
			name: 'search_library',
			description: "Search the user's literature database (papers read in full) for passages about a question. Returns passages with paper and page, to quote and cite.",
			parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
			summarize: (a) => `search the library for "${a.query}"`,
			async run(a) {
				if (!ctx.library || !ctx.embedder) {
					throw new Error('the library is not available');
				}
				const hits = await ctx.library.search(str(a.query, 'query'), await ctx.embedder(), { limit: Math.min(Number(a.limit) || 6, 12) });
				return hits.length
					? hits.map((h, i) => `[${i + 1}] ${h.paper.title} (${citeLabel(h)}${h.paper.texkey ? `, key ${h.paper.texkey}` : ''})\n${h.chunk.text}`).join('\n\n---\n\n')
					: 'The library has nothing on this. search_literature finds papers to add.';
			},
		},
		{
			name: 'list_files',
			description: "List the project's files (build folders and .git are skipped). Optionally only those under a folder.",
			parameters: { type: 'object', properties: { folder: { type: 'string' } } },
			summarize: (a) => `list files${a.folder ? ` in ${a.folder}` : ''}`,
			async run(a) {
				const dir = a.folder ? insideProject(ctx.root, a.folder) : ctx.root;
				const out: string[] = [];
				listFiles(ctx.root, dir, out, 400);
				return out.length ? out.join('\n') + (out.length >= 400 ? '\n... (more)' : '') : 'No files.';
			},
		},
		{
			name: 'read_file',
			description: 'Read a text file in the project, with line numbers. Optionally a range of lines.',
			parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] },
			summarize: (a) => `read ${a.path}`,
			async run(a) {
				const file = insideProject(ctx.root, a.path);
				const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
				const start = Math.max(1, Number(a.start_line) || 1);
				const end = Math.min(lines.length, Number(a.end_line) || start + 399);
				return lines
					.slice(start - 1, end)
					.map((l, i) => `${String(start + i).padStart(5)}  ${l}`)
					.join('\n') + (end < lines.length ? `\n... (${lines.length - end} more lines; read with start_line=${end + 1})` : '');
			},
		},
		{
			name: 'write_file',
			description: 'Create or replace a text file in the project with the given content.',
			parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
			needsApproval: true,
			summarize: (a) => `write ${a.path} (${String(a.content ?? '').split('\n').length} lines)`,
			async run(a) {
				const file = insideProject(ctx.root, a.path);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, String(a.content ?? ''));
				return `Wrote ${path.relative(ctx.root, file)}.`;
			},
		},
		{
			name: 'edit_file',
			description: 'Replace one exact piece of text in a project file with new text. old_text must appear exactly once.',
			parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] },
			needsApproval: true,
			summarize: (a) => `edit ${a.path}`,
			async run(a) {
				const file = insideProject(ctx.root, a.path);
				const text = fs.readFileSync(file, 'utf8');
				const old = str(a.old_text, 'old_text');
				const count = text.split(old).length - 1;
				if (count !== 1) {
					throw new Error(count === 0 ? 'old_text was not found; read the file again' : `old_text appears ${count} times; include more context`);
				}
				fs.writeFileSync(file, text.replace(old, () => String(a.new_text ?? '')));
				return `Edited ${path.relative(ctx.root, file)}.`;
			},
		},
		{
			name: 'check_lean',
			description: "Compile a Lean file with the project's Lean and Mathlib (lake env lean). Says whether it compiles, lists errors, and whether it uses sorry.",
			parameters: { type: 'object', properties: { path: { type: 'string', description: 'A .lean file in the project' } }, required: ['path'] },
			needsApproval: true,
			summarize: (a) => `compile ${a.path} with Lean`,
			async run(a, signal) {
				const file = insideProject(ctx.root, a.path);
				const root = lakeRoot(file, ctx.root);
				if (!root) {
					throw new Error(`${a.path} isn't in a Lake project (no lakefile up to the project folder)`);
				}
				const { code, output } = await run('lake', ['env', 'lean', path.relative(root, file)], root, env, 600_000, signal);
				return summarizeLean(output, code);
			},
		},
		{
			name: 'compile_latex',
			description: 'Compile a LaTeX file with pdflatex (and bibtex when it has a bibliography). Returns success or the first errors.',
			parameters: { type: 'object', properties: { path: { type: 'string', description: 'A .tex file in the project' } }, required: ['path'] },
			needsApproval: true,
			summarize: (a) => `compile ${a.path} with pdflatex`,
			async run(a, signal) {
				const file = insideProject(ctx.root, a.path);
				const dir = path.dirname(file);
				const name = path.basename(file, '.tex');
				const latex = () => run(tex('pdflatex'), ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', name], dir, env, 180_000, signal);
				let result = await latex();
				if (result.code === 0 && /\\bibliography\{/.test(fs.readFileSync(file, 'utf8'))) {
					const bib = await run(tex('bibtex'), [name], dir, env, 60_000, signal);
					if (bib.code > 1) {
						return `bibtex failed:\n${bib.output.slice(-3000)}`;
					}
					await latex();
					result = await latex();
				}
				if (result.code !== 0) {
					const errors = result.output.split(/\r?\n/).filter((l) => /:\d+: |^! /.test(l));
					return `Did not compile.\n${(errors.length ? errors : result.output.split(/\r?\n/).slice(-30)).join('\n')}`;
				}
				const log = fs.existsSync(path.join(dir, `${name}.log`)) ? fs.readFileSync(path.join(dir, `${name}.log`), 'latin1') : '';
				const warnings = log.split(/\r?\n/).filter((l) => /undefined|Warning: Citation|Overfull/.test(l)).slice(0, 15);
				return `Compiled ${path.relative(ctx.root, path.join(dir, `${name}.pdf`))}.${warnings.length ? `\nWarnings:\n${warnings.join('\n')}` : ''}`;
			},
		},
		{
			name: 'run_python',
			description: "Run Python code with TheoremDesk's Python (SymPy, NumPy, SciPy, Matplotlib) in the project folder. Print what you need to see. Stops after 2 minutes.",
			parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
			needsApproval: true,
			summarize: (a) => `run Python (${String(a.code ?? '').split('\n').length} lines)`,
			async run(a, signal) {
				const { code, output } = await run(ctx.python, ['-c', str(a.code, 'code')], ctx.root, { ...env, MPLBACKEND: 'Agg', PYTHONIOENCODING: 'utf-8' }, 120_000, signal);
				return `${code === 0 ? 'Exit 0' : `Exit ${code}`}\n${output || '(no output)'}`;
			},
		},
	];
	return tools;
}
