// Literature search, recommendations and BibTeX, shared by the Literature
// view and the MCP server. Free of the `vscode` API so it can be tested with
// plain Node.
//
// Papers come from several sources (sources.ts: arXiv, INSPIRE-HEP, zbMATH
// Open, Crossref, OpenAlex). Each source fills in what it knows; results are
// merged by DOI or arXiv ID so a paper appears once with the best of each.

export type SourceId = 'arxiv' | 'inspire' | 'zbmath' | 'crossref' | 'openalex';

export const SOURCE_NAMES: Record<SourceId, string> = {
	arxiv: 'arXiv',
	inspire: 'INSPIRE-HEP',
	zbmath: 'zbMATH Open',
	crossref: 'Crossref',
	openalex: 'OpenAlex',
};

export interface Paper {
	/** The source this record came from (the first, after merging). */
	source: SourceId;
	/** Every source that returned this paper, after merging. */
	sources?: SourceId[];
	/** The source's own identifier (arXiv ID, INSPIRE record, zbMATH ID, DOI, OpenAlex ID). */
	id: string;
	version?: string;
	title: string;
	/** As the source gives them: "First Last" or "Last, First". */
	authors: string[];
	abstract: string;
	published?: string;
	updated?: string;
	year: number;
	/** arXiv identifier without version: 1706.03762 or hep-th/9711200. */
	arxivId?: string;
	primaryCategory?: string;
	categories?: string[];
	doi?: string;
	journal?: string;
	journalShort?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	/** Free-text journal reference (arXiv). */
	journalRef?: string;
	comment?: string;
	/** INSPIRE's citation key, the one physicists use: Maldacena:1997re. */
	texkey?: string;
	inspireId?: string;
	zbl?: string;
	openalexId?: string;
	/** OpenAlex IDs of related works. */
	relatedIds?: string[];
	citationCount?: number;
	url: string;
	pdfUrl?: string;
	/** A ready BibTeX entry from the source (INSPIRE). */
	bibtex?: string;
}

export interface SearchOptions {
	maxResults?: number;
	start?: number;
	sort?: 'relevance' | 'recent' | 'cited';
	/** An arXiv category, such as math-ph or hep-th (arXiv only). */
	category?: string;
}

export interface LiteratureSource {
	id: SourceId;
	name: string;
	search(query: string, options?: SearchOptions): Promise<Paper[]>;
	/** Look papers up by arXiv ID or DOI. */
	lookup?(identifiers: { arxivIds?: string[]; dois?: string[] }): Promise<Paper[]>;
	/** Works related to the given papers (OpenAlex). */
	related?(papers: Paper[], limit: number): Promise<Paper[]>;
	/** The source's own BibTeX for a paper it returned (INSPIRE). */
	bibtex?(paper: Paper): Promise<string | undefined>;
}

// ---------------------------------------------------------------------------
// Fetching, politely

export type FetchText = (url: string, accept?: string) => Promise<string>;

export const defaultFetch: FetchText = async (url, accept) => {
	const response = await fetch(url, {
		headers: { 'User-Agent': 'TheoremDesk (literature search)', ...(accept ? { Accept: accept } : {}) },
	});
	if (!response.ok) {
		throw new Error(`${new URL(url).host} answered ${response.status} ${response.statusText}`);
	}
	return response.text();
};

/** One request at a time per source, at least intervalMs apart. */
export class RateLimiter {
	private last = 0;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly intervalMs: number) {}

	run<T>(task: () => Promise<T>): Promise<T> {
		const go = async () => {
			const wait = this.last + this.intervalMs - Date.now();
			if (wait > 0) {
				await new Promise((resolve) => setTimeout(resolve, wait));
			}
			try {
				return await task();
			} finally {
				this.last = Date.now();
			}
		};
		const result = this.queue.then(go, go);
		this.queue = result.catch(() => undefined);
		return result;
	}
}

// ---------------------------------------------------------------------------
// Identifiers

/** `http://arxiv.org/abs/1104.0312v2` -> { id: '1104.0312', version: 'v2' }. */
export function parseArxivId(text: string): { id: string; version?: string } | undefined {
	const match = /(?:arxiv\.org\/(?:abs|pdf)\/|arxiv:|^)\s*((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/i.exec(text.trim());
	return match ? { id: match[1], version: match[2] } : undefined;
}

/** A DOI from a DOI, doi: prefix or doi.org link. */
export function parseDoi(text: string): string | undefined {
	const match = /(?:doi\.org\/|doi:\s*|^)(10\.\d{4,9}\/[^\s"<>{}]+)/i.exec(text.trim());
	return match ? match[1].replace(/[.,;]$/, '') : undefined;
}

// ---------------------------------------------------------------------------
// Merging results from several sources

/** Field priority: who to trust first for each kind of information. */
const PUBLICATION_ORDER: SourceId[] = ['inspire', 'crossref', 'zbmath', 'openalex', 'arxiv'];
const ABSTRACT_ORDER: SourceId[] = ['arxiv', 'inspire', 'zbmath', 'openalex', 'crossref'];

export function normalizedTitle(title: string): string {
	return title
		.toLowerCase()
		.replace(/\$[^$]*\$/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function identityKeys(p: Paper): string[] {
	const keys: string[] = [];
	if (p.doi) {
		keys.push(`doi:${p.doi.toLowerCase()}`);
	}
	if (p.arxivId) {
		keys.push(`arxiv:${p.arxivId}`);
	}
	if (keys.length === 0 && p.title) {
		keys.push(`title:${normalizedTitle(p.title)}:${p.year}`);
	}
	return keys;
}

function pick<K extends keyof Paper>(records: Paper[], order: SourceId[], field: K): Paper[K] | undefined {
	for (const source of order) {
		const value = records.find((r) => r.source === source && r[field] !== undefined && r[field] !== '')?.[field];
		if (value !== undefined) {
			return value;
		}
	}
	return records.find((r) => r[field] !== undefined && r[field] !== '')?.[field];
}

/** Combine records of the same paper from different sources. */
export function mergeRecords(records: Paper[]): Paper {
	const base = records[0];
	const pub = <K extends keyof Paper>(f: K) => pick(records, PUBLICATION_ORDER, f);
	const arxiv = records.find((r) => r.source === 'arxiv');
	const sources = [...new Set(records.flatMap((r) => r.sources ?? [r.source]))];
	const counts = records.map((r) => r.citationCount).filter((c): c is number => c !== undefined);
	return {
		...base,
		sources,
		title: pub('title') ?? base.title,
		authors: pick(records, PUBLICATION_ORDER, 'authors') ?? base.authors,
		abstract: pick(records, ABSTRACT_ORDER, 'abstract') ?? '',
		year: (pub('year') as number | undefined) ?? base.year,
		arxivId: pub('arxivId'),
		version: arxiv?.version ?? base.version,
		primaryCategory: pick(records, ['arxiv', 'inspire'], 'primaryCategory'),
		categories: pick(records, ['arxiv', 'inspire', 'zbmath'], 'categories'),
		doi: pub('doi'),
		journal: pub('journal'),
		journalShort: pub('journalShort'),
		volume: pub('volume'),
		issue: pub('issue'),
		pages: pub('pages'),
		journalRef: pub('journalRef'),
		texkey: pub('texkey'),
		inspireId: pub('inspireId'),
		zbl: pub('zbl'),
		openalexId: pub('openalexId'),
		relatedIds: pub('relatedIds'),
		bibtex: pub('bibtex'),
		citationCount: counts.length > 0 ? Math.max(...counts) : undefined,
		url: arxiv?.url ?? base.url,
		pdfUrl: arxiv?.pdfUrl ?? pub('pdfUrl'),
	};
}

/**
 * Merge result lists from several sources, keeping each source's own
 * relevance order by taking their results in turn, and combining records of
 * the same paper (same DOI or arXiv ID).
 */
export function mergeResults(lists: Paper[][]): Paper[] {
	const order: string[] = [];
	const groups = new Map<string, Paper[]>();
	const alias = new Map<string, string>();
	const longest = Math.max(0, ...lists.map((l) => l.length));
	for (let i = 0; i < longest; i++) {
		for (const list of lists) {
			const paper = list[i];
			if (!paper) {
				continue;
			}
			const keys = identityKeys(paper);
			const existing = keys.map((k) => alias.get(k)).find((k) => k !== undefined);
			const group = existing ?? keys[0];
			if (!groups.has(group)) {
				groups.set(group, []);
				order.push(group);
			}
			groups.get(group)!.push(paper);
			for (const k of keys) {
				alias.set(k, group);
			}
		}
	}
	return order.map((g) => mergeRecords(groups.get(g)!));
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

/** "Maldacena, Juan Martin" or "Juan Martin Maldacena" -> "Juan Martin Maldacena". */
export function displayName(name: string): string {
	const comma = name.indexOf(',');
	return comma > 0 ? `${name.slice(comma + 1).trim()} ${name.slice(0, comma).trim()}`.trim() : name.trim();
}

function surname(name: string): string {
	const comma = name.indexOf(',');
	return comma > 0 ? name.slice(0, comma).trim() : name.trim().split(/\s+/).pop() ?? name;
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

function fold(s: string): string {
	return s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[ßæøłœ]/gi, (c) => ({ ß: 'ss', æ: 'ae', ø: 'o', ł: 'l', œ: 'oe' } as Record<string, string>)[c.toLowerCase()] ?? c)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, '');
}

/** A readable, unique key: first author's surname + year + first meaningful title word. */
export function bibtexKey(paper: Paper, taken: Set<string> = new Set()): string {
	const first = paper.authors[0] ?? 'anonymous';
	const name = fold(surname(first)) || 'anonymous';
	const word =
		paper.title
			.replace(/\$[^$]*\$/g, ' ')
			.split(/[^A-Za-zÀ-ɏ]+/)
			.map(fold)
			.find((w) => w.length > 3 && !STOPWORDS.has(w)) ?? '';
	const base = `${name}${paper.year || ''}${word}`;
	let key = base;
	for (let i = 0; taken.has(key); i++) {
		key = base + String.fromCharCode(97 + i);
	}
	return key;
}

/**
 * A BibTeX entry. Published papers are @article (journal, volume, pages),
 * keeping the arXiv eprint fields when there's a preprint; preprints are
 * @misc in the form arXiv recommends; anything else is @misc with a DOI.
 */
export function toBibtex(paper: Paper, key: string): string {
	const fields: [string, string][] = [
		['author', paper.authors.map(toLatex).join(' and ')],
		['title', `{${escapeText(toLatex(paper.title))}}`], // double braces keep capitals
	];
	let type = 'misc';
	if (paper.journal) {
		type = 'article';
		fields.push(['journal', escapeText(toLatex(paper.journal))]);
		if (paper.volume) {
			fields.push(['volume', paper.volume]);
		}
		if (paper.issue) {
			fields.push(['number', paper.issue]);
		}
		if (paper.pages) {
			fields.push(['pages', paper.pages.replace(/(\d)\s*[-–]+\s*(\w)/, '$1--$2')]);
		}
	}
	fields.push(['year', String(paper.year)]);
	if (paper.arxivId) {
		fields.push(['eprint', paper.arxivId], ['archivePrefix', 'arXiv']);
		if (paper.primaryCategory) {
			fields.push(['primaryClass', paper.primaryCategory]);
		}
	}
	if (paper.doi) {
		fields.push(['doi', paper.doi]);
	}
	if (!paper.journal && paper.journalRef) {
		fields.push(['note', escapeText(toLatex(paper.journalRef))]);
	}
	if (!paper.doi) {
		fields.push(['url', paper.url]);
	}
	const width = Math.max(...fields.map(([name]) => name.length));
	const body = fields.map(([name, value]) => `  ${name.padEnd(width)} = {${value}}`).join(',\n');
	return `@${type}{${key},\n${body}\n}\n`;
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

/** Whether the paper is in the bibliography, by arXiv ID or DOI. */
export function inBib(index: BibIndex, paper: Paper): boolean {
	return Boolean((paper.arxivId && index.eprints.has(paper.arxivId)) || (paper.doi && index.dois.has(paper.doi.toLowerCase())));
}

/** The key under which this paper is already in the bibliography, if it is. */
export function findInBib(bib: string, paper: Paper): string | undefined {
	if (!inBib(indexBib(bib), paper)) {
		return undefined;
	}
	for (const m of bib.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|$)/g)) {
		const entry = m[2];
		const id = paper.arxivId;
		if ((id && entry.includes(id)) || (paper.doi && entry.toLowerCase().includes(paper.doi.toLowerCase()))) {
			return m[1];
		}
	}
	return undefined;
}

/** The entry to add: the source's own BibTeX (INSPIRE) if it has one, else ours. */
export function bibtexFor(paper: Paper, taken: Set<string>): { entry: string; key: string } {
	if (paper.bibtex) {
		const own = /@\w+\s*\{\s*([^,\s]+)\s*,/.exec(paper.bibtex);
		if (own) {
			const key = taken.has(own[1]) ? bibtexKey(paper, taken) : own[1];
			const entry = toLatex(paper.bibtex.replace(own[0], own[0].replace(own[1], key))).trim() + '\n';
			return { entry, key };
		}
	}
	const key = bibtexKey(paper, taken);
	return { entry: toBibtex(paper, key), key };
}

/** Append the paper to a .bib file's text, unless it's already there. */
export function addToBib(bib: string, paper: Paper): { text: string; key: string; added: boolean } {
	const existing = findInBib(bib, paper);
	if (existing) {
		return { text: bib, key: existing, added: false };
	}
	const { entry, key } = bibtexFor(paper, indexBib(bib).keys);
	const separator = bib.length === 0 || bib.endsWith('\n\n') ? '' : bib.endsWith('\n') ? '\n' : '\n\n';
	return { text: bib + separator + entry, key, added: true };
}

/**
 * The best record to cite: if a source has its own BibTeX for the paper
 * (INSPIRE, with the key physicists use), fetch it; otherwise fill in journal
 * details from a source that has them.
 */
export async function bestForBibliography(paper: Paper, sources: LiteratureSource[]): Promise<Paper> {
	let best = paper;
	if (!best.bibtex) {
		for (const source of sources) {
			if (!source.bibtex) {
				continue;
			}
			try {
				let record = best.sources?.includes(source.id) || best.source === source.id ? best : undefined;
				if (!record && source.lookup && (best.arxivId || best.doi)) {
					const [found] = await source.lookup({
						arxivIds: best.arxivId ? [best.arxivId] : [],
						dois: best.doi ? [best.doi] : [],
					});
					record = found ? mergeRecords([found, best]) : undefined;
				}
				const bibtex = record ? await source.bibtex(record) : undefined;
				if (record && bibtex) {
					return { ...record, bibtex };
				}
			} catch {
				// fall through to the next source, or our own entry
			}
		}
	}
	const doi = best.doi;
	if (!best.journal && doi) {
		for (const source of sources) {
			if (source.id === 'crossref' && source.lookup) {
				try {
					const [found] = await source.lookup({ dois: [doi] });
					if (found) {
						best = mergeRecords([found, best]);
					}
				} catch {
					// keep what we have
				}
			}
		}
	}
	return best;
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

/** The papers a .bib file cites, as stubs with their arXiv IDs and DOIs. */
export function bibSeeds(bib: string): Paper[] {
	const index = indexBib(bib);
	const stubs: Paper[] = [];
	for (const id of index.eprints) {
		stubs.push({ source: 'arxiv', id, arxivId: id, title: '', authors: [], abstract: '', year: 0, url: '' });
	}
	for (const doi of index.dois) {
		stubs.push({ source: 'crossref', id: doi, doi, title: '', authors: [], abstract: '', year: 0, url: '' });
	}
	return stubs;
}

/**
 * Recommend papers for a project. Candidates come from searching each
 * source with the manuscript's main terms, and from works related to the
 * papers it already cites (OpenAlex). They are merged, papers already in the
 * bibliography are left out, and the rest ranked by similarity to the
 * manuscript, with a bonus for papers several sources or related-work lists
 * agree on.
 */
export async function recommend(
	sources: LiteratureSource | LiteratureSource[],
	tex: string,
	bib: string,
	options: { maxResults?: number; candidates?: number } = {},
): Promise<{ paper: Paper; score: number }[]> {
	const list = Array.isArray(sources) ? sources : [sources];
	const bibTitles = [...bib.matchAll(/\btitle\s*=\s*[{"]([\s\S]*?)[}"]\s*,?\s*\n/gi)].map((m) => m[1]);
	const profile = projectProfile(tex, bibTitles);
	const top = topTerms(profile, 6);
	if (top.length === 0) {
		return [];
	}
	const seeds = bibSeeds(bib);
	const lists = await Promise.all(
		list.flatMap((source) => {
			const jobs: Promise<Paper[]>[] = [];
			const query = source.id === 'arxiv' ? top.map((t) => `all:${t}`).join(' OR ') : top.slice(0, 4).join(' ');
			jobs.push(source.search(query, { maxResults: options.candidates ?? (source.id === 'arxiv' ? 60 : 25) }).catch(() => []));
			if (source.related && seeds.length > 0) {
				jobs.push(source.related(seeds, 40).catch(() => []));
			}
			return jobs;
		}),
	);
	const index = indexBib(bib);
	const merged = mergeResults(lists).filter((p) => !inBib(index, p) && p.title);
	return rankBySimilarity(profile, merged)
		.map(({ paper, score }) => ({ paper, score: score + 0.02 * ((paper.sources?.length ?? 1) - 1) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, options.maxResults ?? 15);
}

/** One paper as a few lines of text, for agents and logs. */
export function describe(paper: Paper, abstractChars = 300): string {
	const names = paper.authors.map(displayName);
	const authors = names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
	const abstract = paper.abstract.length > abstractChars ? `${paper.abstract.slice(0, abstractChars)}...` : paper.abstract;
	const ids = [
		paper.arxivId ? `arXiv:${paper.arxivId}${paper.primaryCategory ? ` [${paper.primaryCategory}]` : ''}` : undefined,
		paper.doi ? `doi:${paper.doi}` : undefined,
		paper.texkey ? `INSPIRE ${paper.texkey}` : undefined,
		paper.zbl ? `Zbl ${paper.zbl}` : undefined,
	].filter(Boolean);
	const venue = paper.journal
		? `${paper.journalShort ?? paper.journal}${paper.volume ? ` ${paper.volume}` : ''}${paper.pages ? `, ${paper.pages}` : ''}`
		: paper.journalRef;
	const extras = [
		venue,
		paper.citationCount !== undefined ? `${paper.citationCount} citations` : undefined,
		`from ${(paper.sources ?? [paper.source]).map((s) => SOURCE_NAMES[s]).join(', ')}`,
	].filter(Boolean);
	return [
		paper.title,
		`  ${authors} (${paper.year}) · ${ids.join(' · ')}`,
		`  ${extras.join(' · ')}`,
		`  ${paper.url}`,
		...(abstract ? [`  ${abstract}`] : []),
	].join('\n');
}
