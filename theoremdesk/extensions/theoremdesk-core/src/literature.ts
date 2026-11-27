// Literature search, recommendations and BibTeX, shared by the Literature
// view and the MCP server. Free of the `vscode` API so it can be tested with
// plain Node.
//
// Sources implement LiteratureSource; arXiv is the first. Semantic Scholar,
// PubMed and journal sources can be added the same way.

export interface Paper {
	source: 'arxiv';
	/** arXiv identifier without version: 1706.03762 or hep-th/9711200. */
	id: string;
	version?: string;
	title: string;
	authors: string[];
	abstract: string;
	published: string;
	updated: string;
	year: number;
	primaryCategory: string;
	categories: string[];
	doi?: string;
	journalRef?: string;
	comment?: string;
	url: string;
	pdfUrl: string;
}

export interface SearchOptions {
	maxResults?: number;
	start?: number;
	sort?: 'relevance' | 'recent';
	/** An arXiv category, such as math-ph or hep-th. */
	category?: string;
}

export interface LiteratureSource {
	id: string;
	name: string;
	search(query: string, options?: SearchOptions): Promise<Paper[]>;
	byIds(ids: string[]): Promise<Paper[]>;
}

// ---------------------------------------------------------------------------
// arXiv

const ARXIV_API = 'https://export.arxiv.org/api/query';
/** arXiv asks API users for no more than one request every three seconds. */
const ARXIV_INTERVAL_MS = 3000;

export type FetchText = (url: string) => Promise<string>;

export const defaultFetch: FetchText = async (url) => {
	const response = await fetch(url, { headers: { 'User-Agent': 'TheoremDesk (literature search)' } });
	if (!response.ok) {
		throw new Error(`arXiv answered ${response.status} ${response.statusText}`);
	}
	return response.text();
};

function decodeXml(text: string): string {
	return text
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&amp;/g, '&');
}

const clean = (text: string) => decodeXml(text).replace(/\s+/g, ' ').trim();

function tag(xml: string, name: string): string | undefined {
	const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
	return match ? clean(match[1]) : undefined;
}

/** `http://arxiv.org/abs/1104.0312v2` -> { id: '1104.0312', version: 'v2' }. */
export function parseArxivId(text: string): { id: string; version?: string } | undefined {
	const match = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:|^)\s*((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/i.exec(text.trim());
	return match ? { id: match[1], version: match[2] } : undefined;
}

export function parseArxivAtom(xml: string): Paper[] {
	const papers: Paper[] = [];
	for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const idText = tag(entry, 'id') ?? '';
		const parsed = parseArxivId(idText);
		if (!parsed) {
			continue; // arXiv returns an entry describing the error for bad queries
		}
		const published = tag(entry, 'published') ?? '';
		const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
		const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1] ?? categories[0] ?? '';
		papers.push({
			source: 'arxiv',
			id: parsed.id,
			version: parsed.version,
			title: tag(entry, 'title') ?? '',
			authors: [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) => clean(m[1])),
			abstract: tag(entry, 'summary') ?? '',
			published,
			updated: tag(entry, 'updated') ?? published,
			year: Number(published.slice(0, 4)) || 0,
			primaryCategory: primary,
			categories,
			doi: tag(entry, 'arxiv:doi'),
			journalRef: tag(entry, 'arxiv:journal_ref'),
			comment: tag(entry, 'arxiv:comment'),
			url: `https://arxiv.org/abs/${parsed.id}`,
			pdfUrl: `https://arxiv.org/pdf/${parsed.id}`,
		});
	}
	return papers;
}

/**
 * An arXiv search_query from free text. Field syntax (`au:`, `ti:`, `cat:`,
 * AND/OR) passes through unchanged; otherwise every word must appear, and
 * quoted phrases are kept together.
 */
export function arxivSearchQuery(query: string, category?: string): string {
	const q = query.trim();
	let search: string;
	if (/\b(?:ti|au|abs|co|jr|cat|rn|all|id):|\b(?:AND|OR|ANDNOT)\b/.test(q)) {
		search = q;
	} else {
		const parts = q.match(/"[^"]+"|\S+/g) ?? [];
		search = parts.map((p) => `all:${p.replace(/[()]/g, '')}`).join(' AND ');
	}
	return category ? `(${search}) AND cat:${category}` : search;
}

export class ArxivSource implements LiteratureSource {
	readonly id = 'arxiv';
	readonly name = 'arXiv';
	private last = 0;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly fetchText: FetchText = defaultFetch, private readonly intervalMs = ARXIV_INTERVAL_MS) {}

	/** One request at a time, at least intervalMs apart. */
	private request(url: string): Promise<string> {
		const run = async () => {
			const wait = this.last + this.intervalMs - Date.now();
			if (wait > 0) {
				await new Promise((resolve) => setTimeout(resolve, wait));
			}
			try {
				return await this.fetchText(url);
			} finally {
				this.last = Date.now();
			}
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
		const params = new URLSearchParams({
			search_query: arxivSearchQuery(query, options.category),
			start: String(options.start ?? 0),
			max_results: String(Math.min(options.maxResults ?? 20, 100)),
			sortBy: options.sort === 'recent' ? 'submittedDate' : 'relevance',
			sortOrder: 'descending',
		});
		return parseArxivAtom(await this.request(`${ARXIV_API}?${params}`));
	}

	async byIds(ids: string[]): Promise<Paper[]> {
		const clean = ids.map((i) => parseArxivId(i)?.id).filter((i): i is string => Boolean(i));
		if (clean.length === 0) {
			return [];
		}
		const params = new URLSearchParams({ id_list: clean.join(','), max_results: String(clean.length) });
		return parseArxivAtom(await this.request(`${ARXIV_API}?${params}`));
	}
}

// ---------------------------------------------------------------------------
// BibTeX

const ACCENTS: Record<string, string> = {
	'̀': '`',
	'́': "'",
	'̂': '^',
	'̃': '~',
	'̄': '=',
	'̆': 'u',
	'̇': '.',
	'̈': '"',
	'̊': 'r',
	'̋': 'H',
	'̌': 'v',
	'̧': 'c',
	'̨': 'k',
};
const SPECIAL: Record<string, string> = {
	ß: '{\\ss}',
	æ: '{\\ae}',
	Æ: '{\\AE}',
	ø: '{\\o}',
	Ø: '{\\O}',
	ł: '{\\l}',
	Ł: '{\\L}',
	œ: '{\\oe}',
	Œ: '{\\OE}',
	ı: '{\\i}',
	'–': '--',
	'—': '---',
	'’': "'",
	'‘': '`',
	'“': '``',
	'”': "''",
};

/** Accented and special letters as LaTeX, so pdflatex never meets raw Unicode. */
export function toLatex(text: string): string {
	let out = '';
	for (const ch of text.normalize('NFD')) {
		if (ACCENTS[ch] && out.length > 0) {
			// Wrap the previous base letter: a + acute -> {\'a}; i/j drop their dot.
			const base = out[out.length - 1];
			const letter = base === 'i' ? '\\i' : base === 'j' ? '\\j' : base;
			const macro = ACCENTS[ch];
			out = out.slice(0, -1) + (/[a-zA-Z]/.test(macro) ? `{\\${macro}{${letter}}}` : `{\\${macro}${letter}}`);
		} else if (/[̀-ͯ]/.test(ch)) {
			// another combining mark: drop it
		} else {
			out += SPECIAL[ch] ?? ch;
		}
	}
	return out;
}

/** Escape &, % and # outside math, which BibTeX values can't contain bare. */
function escapeText(text: string): string {
	return text.replace(/(^|[^\\])([&%#])/g, '$1\\$2');
}

const STOPWORDS = new Set(
	`a an the of on in at to for from by with and or but not is are was were be been being as into onto over under
	 between among via using use used new novel some any all its it this that these those their our we you they
	 than then there here when where which who whom whose what how why can may might will would should could also
	 about above after again against before below during each few further more most other same such only own so too
	 very just both either neither nor per upon within without study paper analysis approach result results method
	 methods theory model models case cases problem problems towards toward based effect effects general first second
	 two three one`.split(/\s+/),
);

/** A readable, unique key: first author's surname + year + first meaningful title word. */
export function bibtexKey(paper: Paper, taken: Set<string> = new Set()): string {
	const fold = (s: string) =>
		s
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[ßæøłœ]/gi, (c) => ({ ß: 'ss', æ: 'ae', ø: 'o', ł: 'l', œ: 'oe' } as Record<string, string>)[c.toLowerCase()] ?? c)
			.toLowerCase()
			.replace(/[^a-z0-9]/g, '');
	const first = paper.authors[0] ?? 'anonymous';
	const surname = fold(first.split(/\s+/).filter(Boolean).pop() ?? first) || 'anonymous';
	const word =
		paper.title
			.replace(/\$[^$]*\$/g, ' ')
			.split(/[^A-Za-zÀ-ɏ]+/)
			.map(fold)
			.find((w) => w.length > 3 && !STOPWORDS.has(w)) ?? '';
	const base = `${surname}${paper.year || ''}${word}`;
	let key = base;
	for (let i = 0; taken.has(key); i++) {
		key = base + String.fromCharCode(97 + i);
	}
	return key;
}

/** A BibTeX entry in the form arXiv recommends: eprint, archivePrefix, primaryClass. */
export function toBibtex(paper: Paper, key: string): string {
	const fields: [string, string][] = [
		['author', paper.authors.map(toLatex).join(' and ')],
		['title', `{${escapeText(toLatex(paper.title))}}`], // double braces keep capitals
		['year', String(paper.year)],
		['eprint', paper.id],
		['archivePrefix', 'arXiv'],
		['primaryClass', paper.primaryCategory],
	];
	if (paper.doi) {
		fields.push(['doi', paper.doi]);
	}
	if (paper.journalRef) {
		fields.push(['note', escapeText(toLatex(paper.journalRef))]);
	}
	fields.push(['url', paper.url]);
	const width = Math.max(...fields.map(([name]) => name.length));
	const body = fields.map(([name, value]) => `  ${name.padEnd(width)} = {${value}}`).join(',\n');
	return `@misc{${key},\n${body}\n}\n`;
}

export interface BibIndex {
	keys: Set<string>;
	eprints: Set<string>;
	dois: Set<string>;
}

/** Keys, arXiv IDs and DOIs already in a .bib file. */
export function indexBib(bib: string): BibIndex {
	const keys = new Set([...bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((m) => m[1]));
	const eprints = new Set<string>();
	for (const m of bib.matchAll(/\b(?:eprint|arxiv)\s*=\s*[{"]\s*([^}"]+?)\s*[}"]/gi)) {
		const id = parseArxivId(m[1])?.id;
		if (id) {
			eprints.add(id);
		}
	}
	for (const m of bib.matchAll(/arxiv\.org\/(?:abs|pdf)\/([^\s}"]+)/gi)) {
		const id = parseArxivId(m[1])?.id;
		if (id) {
			eprints.add(id);
		}
	}
	const dois = new Set([...bib.matchAll(/\bdoi\s*=\s*[{"]\s*([^}"]+?)\s*[}"]/gi)].map((m) => m[1].toLowerCase()));
	return { keys, eprints, dois };
}

/** The key under which this paper is already in the bibliography, if it is. */
export function findInBib(bib: string, paper: Paper): string | undefined {
	const index = indexBib(bib);
	if (!index.eprints.has(paper.id) && !(paper.doi && index.dois.has(paper.doi.toLowerCase()))) {
		return undefined;
	}
	for (const m of bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|$)/g)) {
		const entry = m[2];
		if (entry.includes(paper.id) || (paper.doi && entry.toLowerCase().includes(paper.doi.toLowerCase()))) {
			return m[1];
		}
	}
	return [...index.keys][0];
}

/** Append the paper to a .bib file's text, unless it's already there. */
export function addToBib(bib: string, paper: Paper): { text: string; key: string; added: boolean } {
	const existing = findInBib(bib, paper);
	if (existing) {
		return { text: bib, key: existing, added: false };
	}
	const key = bibtexKey(paper, indexBib(bib).keys);
	const separator = bib.length === 0 || bib.endsWith('\n\n') ? '' : bib.endsWith('\n') ? '\n' : '\n\n';
	return { text: bib + separator + toBibtex(paper, key), key, added: true };
}

// ---------------------------------------------------------------------------
// Recommendations

/** Words of a LaTeX document: commands, math, comments and braces removed. */
export function plainText(tex: string): string {
	return tex
		.replace(/(^|[^\\])%.*$/gm, '$1')
		.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$/g, ' ')
		.replace(/\\begin\{(equation|align|gather|multline|eqnarray)\*?\}[\s\S]*?\\end\{\1\*?\}/g, ' ')
		.replace(/\\(?:cite\w*|ref|eqref|label|includegraphics|input|include|bibliography\w*|usepackage|documentclass)\s*(\[[^\]]*\])?\s*\{[^}]*\}/g, ' ')
		.replace(/\\[a-zA-Z@]+\*?/g, ' ')
		.replace(/[{}[\]\\~^_&#]/g, ' ');
}

function words(text: string): string[] {
	return (text.toLowerCase().match(/[a-z][a-z-]{2,}/g) ?? [])
		.map((w) => w.replace(/^-+|-+$/g, ''))
		.filter((w) => w.length > 3 && !STOPWORDS.has(w))
		.map((w) => (w.length > 5 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/**
 * What a project is about, from its manuscript and bibliography: the title
 * and abstract count three times as much as the body.
 */
export function projectProfile(tex: string, bibTitles: string[] = []): string {
	const title = /\\title\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(tex)?.[1] ?? '';
	const abstract = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/.exec(tex)?.[1] ?? '';
	const head = plainText(`${title} ${abstract}`);
	return [head, head, head, plainText(tex), ...bibTitles].join(' ');
}

/** The most frequent meaningful words. */
export function topTerms(text: string, n: number): string[] {
	const counts = new Map<string, number>();
	for (const w of words(text)) {
		counts.set(w, (counts.get(w) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, n)
		.map(([w]) => w);
}

/** An arXiv query that finds candidates for a profile: any of its top terms. */
export function recommendationQuery(profile: string, terms = 6): string | undefined {
	const top = topTerms(profile, terms);
	return top.length > 0 ? top.map((t) => `all:${t}`).join(' OR ') : undefined;
}

/** Papers ranked by TF-IDF cosine similarity to the profile. */
export function rankBySimilarity(profile: string, papers: Paper[]): { paper: Paper; score: number }[] {
	const docs = papers.map((p) => words(`${p.title} ${p.title} ${p.abstract}`));
	const query = words(profile);
	const df = new Map<string, number>();
	for (const doc of [...docs, query]) {
		for (const w of new Set(doc)) {
			df.set(w, (df.get(w) ?? 0) + 1);
		}
	}
	const total = docs.length + 1;
	const vector = (doc: string[]) => {
		const tf = new Map<string, number>();
		for (const w of doc) {
			tf.set(w, (tf.get(w) ?? 0) + 1);
		}
		const v = new Map<string, number>();
		for (const [w, c] of tf) {
			v.set(w, (1 + Math.log(c)) * Math.log(1 + total / (df.get(w) ?? 1)));
		}
		return v;
	};
	const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0)) || 1;
	const q = vector(query);
	const qn = norm(q);
	return papers
		.map((paper, i) => {
			const d = vector(docs[i]);
			let dot = 0;
			for (const [w, x] of d) {
				dot += x * (q.get(w) ?? 0);
			}
			return { paper, score: dot / (norm(d) * qn) };
		})
		.sort((a, b) => b.score - a.score);
}

/**
 * Recommend papers for a project: search the source with the profile's top
 * terms, rank by similarity, and leave out papers already in the bibliography.
 */
export async function recommend(
	source: LiteratureSource,
	tex: string,
	bib: string,
	options: { maxResults?: number; candidates?: number } = {},
): Promise<{ paper: Paper; score: number }[]> {
	const bibTitles = [...bib.matchAll(/\btitle\s*=\s*[{"]([\s\S]*?)[}"]\s*,?\s*\n/gi)].map((m) => m[1]);
	const profile = projectProfile(tex, bibTitles);
	const query = recommendationQuery(profile);
	if (!query) {
		return [];
	}
	const candidates = await source.search(query, { maxResults: options.candidates ?? 60 });
	const index = indexBib(bib);
	const fresh = candidates.filter((p) => !index.eprints.has(p.id) && !(p.doi && index.dois.has(p.doi.toLowerCase())));
	return rankBySimilarity(profile, fresh).slice(0, options.maxResults ?? 15);
}

/** One paper as a few lines of text, for agents and logs. */
export function describe(paper: Paper, abstractChars = 300): string {
	const authors = paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(', ')} et al.` : paper.authors.join(', ');
	const abstract = paper.abstract.length > abstractChars ? `${paper.abstract.slice(0, abstractChars)}...` : paper.abstract;
	return [
		`${paper.title}`,
		`  ${authors} (${paper.year}) · arXiv:${paper.id} [${paper.primaryCategory}]${paper.journalRef ? ` · ${paper.journalRef}` : ''}`,
		`  ${paper.url}`,
		`  ${abstract}`,
	].join('\n');
}
