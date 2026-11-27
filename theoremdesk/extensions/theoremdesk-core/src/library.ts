// The literature database: papers' full text (or abstract), split into
// passages, embedded with the local embedding model, and searched by
// meaning. It lives on the user's machine, in TheoremDesk's data folder,
// and is shared by every project. Free of the `vscode` API so it can be
// tested with plain Node.
//
// On disk (library/):
//   papers.json   metadata of each paper, and how its text was obtained
//   chunks.jsonl  one passage per line: {paper, page, text}
//   vectors.f32   one embedding per passage, float32, in the same order

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { displayName, Paper } from './literature';
import { embeddingQuery } from './llm';

export interface Embedder {
	embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface LibraryPaper {
	key: string;
	title: string;
	authors: string[];
	year: number;
	arxivId?: string;
	doi?: string;
	journal?: string;
	texkey?: string;
	url: string;
	/** Where the text came from. */
	text: 'pdf' | 'abstract';
	pages: number;
	chunks: number;
	added: string;
	/** A local PDF this paper was read from. */
	file?: string;
}

export interface Chunk {
	paper: string;
	/** 1-based page, for PDFs. */
	page?: number;
	text: string;
}

export interface SearchHit {
	paper: LibraryPaper;
	chunk: Chunk;
	score: number;
}

/** A stable key: arXiv ID, else DOI, else a file or title. */
export function paperKey(p: { arxivId?: string; doi?: string; title?: string; file?: string }): string {
	if (p.arxivId) {
		return `arxiv:${p.arxivId}`;
	}
	if (p.doi) {
		return `doi:${p.doi.toLowerCase()}`;
	}
	if (p.file) {
		return `file:${path.basename(p.file).toLowerCase()}`;
	}
	return `title:${(p.title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

/** Tidy extracted PDF text: ligatures, hyphenation at line ends, spacing. */
export function cleanText(text: string): string {
	return text
		.normalize('NFKC') // ﬁ -> fi
		.replace(/(\w)-\n(\w)/g, '$1$2')
		.replace(/[ \t]+/g, ' ')
		.replace(/ *\n */g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Split pages into passages of about `size` characters, breaking at
 * paragraph or sentence ends, overlapping by `overlap` so an idea split
 * across a boundary is still found.
 */
export function chunkPages(pages: string[], size = 1200, overlap = 200): { page: number; text: string }[] {
	const out: { page: number; text: string }[] = [];
	pages.forEach((raw, i) => {
		const text = cleanText(raw);
		let start = 0;
		while (start < text.length) {
			let end = Math.min(text.length, start + size);
			if (end < text.length) {
				const window = text.slice(start + Math.floor(size * 0.6), end);
				const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
				if (breakAt > 0) {
					end = start + Math.floor(size * 0.6) + breakAt + 1;
				}
			}
			const passage = text.slice(start, end).trim();
			if (passage.replace(/\s/g, '').length >= 40) {
				out.push({ page: i + 1, text: passage });
			}
			if (end >= text.length) {
				break;
			}
			start = Math.max(end - overlap, start + 1);
		}
	});
	return out;
}

/** The text of a PDF, page by page, using the bundled Python and pypdf. */
export function pdfPages(python: string, script: string, pdf: string): Promise<string[]> {
	return new Promise((resolve, reject) => {
		execFile(python, ['-I', script, pdf], { maxBuffer: 256 * 1024 * 1024, windowsHide: true, timeout: 120_000 }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(stderr.trim() || error.message));
				return;
			}
			try {
				resolve((JSON.parse(stdout) as { pages: string[] }).pages);
			} catch (e) {
				reject(new Error(`couldn't read pdf_text.py's output: ${(e as Error).message}`));
			}
		});
	});
}

/** Where a paper's PDF can be fetched freely: arXiv, or an open-access link. */
export function pdfUrl(paper: Paper): string | undefined {
	if (paper.arxivId) {
		return `https://arxiv.org/pdf/${paper.arxivId}`;
	}
	return paper.pdfUrl;
}

export async function downloadPdf(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
	const response = await fetchImpl(url, { headers: { 'User-Agent': 'TheoremDesk (literature search)' } });
	if (!response.ok) {
		throw new Error(`${new URL(url).host} answered ${response.status}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
		throw new Error(`${url} isn't a PDF`);
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-pdf-'));
	const file = path.join(dir, 'paper.pdf');
	fs.writeFileSync(file, bytes);
	return file;
}

const BATCH = 16;

export class Library {
	private papers = new Map<string, LibraryPaper>();
	private chunks: Chunk[] = [];
	private vectors: Float32Array[] = [];
	private dim = 0;

	constructor(readonly dir: string) {
		this.load();
	}

	private file(name: string): string {
		return path.join(this.dir, name);
	}

	private load(): void {
		try {
			const meta = JSON.parse(fs.readFileSync(this.file('papers.json'), 'utf8')) as { dim: number; papers: LibraryPaper[] };
			this.dim = meta.dim;
			this.papers = new Map(meta.papers.map((p) => [p.key, p]));
			this.chunks = fs
				.readFileSync(this.file('chunks.jsonl'), 'utf8')
				.split('\n')
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Chunk);
			const raw = fs.readFileSync(this.file('vectors.f32'));
			const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
			this.vectors = this.chunks.map((_, i) => all.slice(i * this.dim, (i + 1) * this.dim));
			if (this.vectors.length !== this.chunks.length || this.chunks.length * this.dim !== all.length) {
				throw new Error('the library files disagree');
			}
		} catch (error) {
			if (fs.existsSync(this.file('papers.json'))) {
				// Damaged: keep it aside rather than lose it silently, and start afresh.
				fs.renameSync(this.dir, `${this.dir}.damaged-${Date.now()}`);
			}
			this.papers.clear();
			this.chunks = [];
			this.vectors = [];
			this.dim = 0;
		}
	}

	/** Write all three files, each atomically (write then rename). */
	private save(): void {
		fs.mkdirSync(this.dir, { recursive: true });
		const write = (name: string, data: string | Buffer) => {
			const tmp = this.file(`${name}.tmp`);
			fs.writeFileSync(tmp, data);
			fs.renameSync(tmp, this.file(name));
		};
		const flat = new Float32Array(this.vectors.length * this.dim);
		this.vectors.forEach((v, i) => flat.set(v, i * this.dim));
		write('vectors.f32', Buffer.from(flat.buffer));
		write('chunks.jsonl', this.chunks.map((c) => JSON.stringify(c)).join('\n') + (this.chunks.length ? '\n' : ''));
		write('papers.json', JSON.stringify({ version: 1, dim: this.dim, papers: [...this.papers.values()] }, null, 1));
	}

	list(): LibraryPaper[] {
		return [...this.papers.values()].sort((a, b) => b.added.localeCompare(a.added));
	}

	get(key: string): LibraryPaper | undefined {
		return this.papers.get(key);
	}

	has(paper: { arxivId?: string; doi?: string; title?: string; file?: string }): boolean {
		return this.papers.has(paperKey(paper));
	}

	get size(): { papers: number; passages: number } {
		return { papers: this.papers.size, passages: this.chunks.length };
	}

	/**
	 * Add a paper with its text: pages of a PDF, or else its abstract.
	 * Replaces an earlier copy. Embeds every passage before saving, so a
	 * failure leaves the library as it was.
	 */
	async add(
		paper: Pick<Paper, 'title' | 'authors' | 'year' | 'url'> & Partial<Paper> & { file?: string },
		pages: string[] | undefined,
		embedder: Embedder,
		onProgress: (done: number, total: number) => void = () => undefined,
		signal?: AbortSignal,
	): Promise<LibraryPaper> {
		const key = paperKey(paper);
		const header = `${paper.title}\n${paper.authors.map(displayName).join(', ')} (${paper.year || 'n.d.'})`;
		const passages = pages && pages.some((p) => p.trim()) ? chunkPages(pages) : [];
		const text: 'pdf' | 'abstract' = passages.length > 0 ? 'pdf' : 'abstract';
		// Always index the title and abstract as their own passage.
		const chunks: Chunk[] = [
			{ paper: key, text: `${header}\n\n${paper.abstract ?? ''}`.trim() },
			...passages.map((p) => ({ paper: key, page: p.page, text: p.text })),
		];
		const vectors: Float32Array[] = [];
		for (let i = 0; i < chunks.length; i += BATCH) {
			// The title goes with every passage, so a passage is found with its paper's subject.
			const batch = chunks.slice(i, i + BATCH).map((c, j) => (i + j === 0 ? c.text : `${paper.title}\n${c.text}`));
			vectors.push(...(await embedder.embed(batch, signal)));
			onProgress(Math.min(i + BATCH, chunks.length), chunks.length);
		}
		if (vectors.length !== chunks.length || vectors.some((v) => v.length !== vectors[0].length)) {
			throw new Error('the embedding model returned the wrong number of vectors');
		}
		if (this.dim && vectors[0].length !== this.dim) {
			throw new Error(`the embedding model changed (${vectors[0].length} dimensions, the library has ${this.dim}); rebuild the library`);
		}
		this.removeChunks(key);
		this.dim = vectors[0].length;
		this.chunks.push(...chunks);
		this.vectors.push(...vectors);
		const entry: LibraryPaper = {
			key,
			title: paper.title,
			authors: paper.authors,
			year: paper.year,
			arxivId: paper.arxivId,
			doi: paper.doi,
			journal: paper.journal,
			texkey: paper.texkey,
			url: paper.url,
			text,
			pages: pages?.length ?? 0,
			chunks: chunks.length,
			added: new Date().toISOString(),
			file: paper.file,
		};
		this.papers.set(key, entry);
		this.save();
		return entry;
	}

	private removeChunks(key: string): void {
		const keep = this.chunks.map((c) => c.paper !== key);
		this.chunks = this.chunks.filter((_, i) => keep[i]);
		this.vectors = this.vectors.filter((_, i) => keep[i]);
	}

	remove(key: string): boolean {
		if (!this.papers.delete(key)) {
			return false;
		}
		this.removeChunks(key);
		this.save();
		return true;
	}

	/**
	 * The passages closest in meaning to the question, at most `perPaper`
	 * from any one paper so a single long paper doesn't crowd out the rest.
	 */
	async search(question: string, embedder: Embedder, options: { limit?: number; perPaper?: number; papers?: string[]; relative?: number } = {}): Promise<SearchHit[]> {
		if (this.chunks.length === 0) {
			return [];
		}
		const [q] = await embedder.embed([embeddingQuery(question)]);
		const allowed = options.papers ? new Set(options.papers) : undefined;
		const scored: { i: number; score: number }[] = [];
		for (let i = 0; i < this.vectors.length; i++) {
			if (allowed && !allowed.has(this.chunks[i].paper)) {
				continue;
			}
			const v = this.vectors[i];
			let s = 0;
			for (let d = 0; d < v.length; d++) {
				s += v[d] * q[d];
			}
			scored.push({ i, score: s });
		}
		scored.sort((a, b) => b.score - a.score);
		const perPaper = new Map<string, number>();
		const hits: SearchHit[] = [];
		// Passages far less relevant than the best one only distract the answer.
		const floor = (scored[0]?.score ?? 0) * (options.relative ?? 0.6);
		for (const { i, score } of scored) {
			if (score < floor) {
				break;
			}
			const chunk = this.chunks[i];
			const n = perPaper.get(chunk.paper) ?? 0;
			if (n >= (options.perPaper ?? 3)) {
				continue;
			}
			perPaper.set(chunk.paper, n + 1);
			hits.push({ paper: this.papers.get(chunk.paper)!, chunk, score });
			if (hits.length >= (options.limit ?? 8)) {
				break;
			}
		}
		return hits;
	}
}

/** How to cite a hit in an answer: [Bender 2007, p. 3]. */
export function citeLabel(hit: SearchHit): string {
	const first = hit.paper.authors[0] ? displayName(hit.paper.authors[0]).split(/\s+/).pop() : hit.paper.title.split(/\s+/)[0];
	return `${first}${hit.paper.authors.length > 1 ? ' et al.' : ''} ${hit.paper.year || ''}${hit.chunk.page ? `, p. ${hit.chunk.page}` : ''}`.trim();
}
