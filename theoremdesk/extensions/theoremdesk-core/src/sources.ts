// The literature sources: arXiv, INSPIRE-HEP, zbMATH Open, Crossref and
// OpenAlex. Each is a free, public API that needs no key. Every client has
// its own rate limiter, set below the limit the service publishes, and
// identifies itself as "TheoremDesk (literature search)".

import {
	defaultFetch,
	FetchText,
	LiteratureSource,
	mergeResults,
	Paper,
	parseArxivId,
	parseDoi,
	RateLimiter,
	SearchOptions,
	SourceId,
} from './literature';

// ---------------------------------------------------------------------------
// arXiv (Atom XML)

const ARXIV_API = 'https://export.arxiv.org/api/query';

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

export function parseArxivAtom(xml: string): Paper[] {
	const papers: Paper[] = [];
	for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
		const parsed = parseArxivId(tag(entry, 'id') ?? '');
		if (!parsed) {
			continue; // arXiv returns an entry describing the error for bad queries
		}
		const published = tag(entry, 'published') ?? '';
		const categories = [...entry.matchAll(/<category[^>]*term="([^"]+)"/g)].map((m) => m[1]);
		const primary = /<arxiv:primary_category[^>]*term="([^"]+)"/.exec(entry)?.[1] ?? categories[0] ?? '';
		papers.push({
			source: 'arxiv',
			id: parsed.id,
			arxivId: parsed.id,
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
	readonly id = 'arxiv' as const;
	readonly name = 'arXiv';
	private readonly limiter: RateLimiter;

	/** arXiv asks for at most one request every three seconds. */
	constructor(private readonly fetchText: FetchText = defaultFetch, intervalMs = 3000) {
		this.limiter = new RateLimiter(intervalMs);
	}

	private request(params: URLSearchParams): Promise<string> {
		return this.limiter.run(() => this.fetchText(`${ARXIV_API}?${params}`));
	}

	async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
		const params = new URLSearchParams({
			search_query: arxivSearchQuery(query, options.category),
			start: String(options.start ?? 0),
			max_results: String(Math.min(options.maxResults ?? 20, 100)),
			sortBy: options.sort === 'recent' ? 'submittedDate' : 'relevance',
			sortOrder: 'descending',
		});
		return parseArxivAtom(await this.request(params));
	}

	async byIds(ids: string[]): Promise<Paper[]> {
		const list = ids.map((i) => parseArxivId(i)?.id).filter((i): i is string => Boolean(i));
		if (list.length === 0) {
			return [];
		}
		return parseArxivAtom(await this.request(new URLSearchParams({ id_list: list.join(','), max_results: String(list.length) })));
	}

	lookup(identifiers: { arxivIds?: string[] }): Promise<Paper[]> {
		return this.byIds(identifiers.arxivIds ?? []);
	}
}

// ---------------------------------------------------------------------------
// INSPIRE-HEP: high-energy physics, with the citation keys physicists use

const INSPIRE_API = 'https://inspirehep.net/api/literature';
const INSPIRE_FIELDS = [
	'control_number',
	'titles.title',
	'authors.full_name',
	'author_count',
	'abstracts.value',
	'arxiv_eprints',
	'dois.value',
	'publication_info',
	'texkeys',
	'citation_count',
	'earliest_date',
	'document_type',
	'inspire_categories.term',
].join(',');

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const first = <T>(list: T[] | undefined): T | undefined => (Array.isArray(list) && list.length > 0 ? list[0] : undefined);

export function parseInspire(json: Json): Paper[] {
	return (json?.hits?.hits ?? []).map((hit: Json): Paper => {
		const m = hit.metadata ?? {};
		const eprint = first<Json>(m.arxiv_eprints);
		// The published version, not reprints or erratum entries.
		const pubs: Json[] = (m.publication_info ?? []).filter((p: Json) => p.journal_title);
		const pub = pubs.find((p) => p.material === 'publication' || !p.material) ?? first(pubs);
		const id = String(m.control_number ?? hit.id);
		const authors: string[] = (m.authors ?? []).map((a: Json) => a.full_name).filter(Boolean);
		const pages = pub?.page_start ? (pub.page_end ? `${pub.page_start}--${pub.page_end}` : pub.page_start) : pub?.artid;
		const year = Number(pub?.year) || Number(String(m.earliest_date ?? '').slice(0, 4)) || 0;
		return {
			source: 'inspire',
			id,
			inspireId: id,
			title: first<Json>(m.titles)?.title ?? '',
			authors: m.author_count > authors.length && authors.length > 0 ? [...authors, 'others'] : authors,
			abstract: first<Json>(m.abstracts)?.value ?? '',
			year,
			arxivId: eprint?.value,
			primaryCategory: first<string>(eprint?.categories),
			categories: eprint?.categories,
			doi: (m.dois ?? []).map((d: Json) => d.value).find(Boolean),
			journal: pub?.journal_title,
			journalShort: pub?.journal_title,
			volume: pub?.journal_volume,
			issue: pub?.journal_issue,
			pages,
			texkey: first<string>(m.texkeys),
			citationCount: m.citation_count,
			url: `https://inspirehep.net/literature/${id}`,
			pdfUrl: eprint?.value ? `https://arxiv.org/pdf/${eprint.value}` : undefined,
		};
	});
}

export class InspireSource implements LiteratureSource {
	readonly id = 'inspire' as const;
	readonly name = 'INSPIRE-HEP';
	private readonly limiter: RateLimiter;

	/** INSPIRE allows 15 requests every 5 seconds. */
	constructor(private readonly fetchText: FetchText = defaultFetch, intervalMs = 400) {
		this.limiter = new RateLimiter(intervalMs);
	}

	private get(url: string, accept?: string): Promise<string> {
		return this.limiter.run(() => this.fetchText(url, accept));
	}

	private async query(q: string, options: SearchOptions = {}): Promise<Paper[]> {
		const params = new URLSearchParams({
			q,
			size: String(Math.min(options.maxResults ?? 20, 100)),
			page: String(Math.floor((options.start ?? 0) / Math.max(1, options.maxResults ?? 20)) + 1),
			sort: options.sort === 'recent' ? 'mostrecent' : options.sort === 'cited' ? 'mostcited' : 'mostrecent',
			fields: INSPIRE_FIELDS,
		});
		if (!options.sort || options.sort === 'relevance') {
			params.delete('sort'); // INSPIRE's default ranking is by relevance for free text
		}
		return parseInspire(JSON.parse(await this.get(`${INSPIRE_API}?${params}`, 'application/json')));
	}

	/** INSPIRE's own search syntax (`a Maldacena`, `t holography`, `refersto:arxiv:...`) works too. */
	search(query: string, options?: SearchOptions): Promise<Paper[]> {
		return this.query(query, options);
	}

	async lookup(identifiers: { arxivIds?: string[]; dois?: string[] }): Promise<Paper[]> {
		const terms = [
			...(identifiers.arxivIds ?? []).map((id) => `arxiv:${id}`),
			...(identifiers.dois ?? []).map((doi) => `doi:"${doi}"`),
		];
		if (terms.length === 0) {
			return [];
		}
		return this.query(terms.join(' or '), { maxResults: terms.length });
	}

	async bibtex(paper: Paper): Promise<string | undefined> {
		if (!paper.inspireId) {
			return undefined;
		}
		const text = await this.get(`${INSPIRE_API}/${paper.inspireId}?format=bibtex`, 'application/x-bibtex');
		return /@\w+\s*\{/.test(text) ? text.trim() + '\n' : undefined;
	}
}

// ---------------------------------------------------------------------------
// zbMATH Open: mathematics, with reviews and MSC classes

const ZBMATH_API = 'https://api.zbmath.org/v1/document/_search';

export function parseZbmath(json: Json): Paper[] {
	return (json?.result ?? []).map((d: Json): Paper => {
		const links: Json[] = d.links ?? [];
		const series = first<Json>(d.source?.series);
		const summary = (d.editorial_contributions ?? []).find((c: Json) => c.text)?.text ?? '';
		const zbl = d.identifier ?? String(d.id);
		const arxiv = links.find((l) => l.type === 'arxiv')?.identifier;
		const title = d.title?.title ?? '';
		return {
			source: 'zbmath',
			id: zbl,
			zbl,
			title: d.title?.subtitle ? `${title}: ${d.title.subtitle}` : title,
			authors: (d.contributors?.authors ?? []).map((a: Json) => a.name).filter(Boolean),
			abstract: summary.replace(/^Summary:\s*/, ''),
			year: Number(d.year) || Number(series?.year) || 0,
			arxivId: arxiv ? parseArxivId(arxiv)?.id : undefined,
			categories: (d.msc ?? []).map((c: Json) => c.code),
			doi: links.find((l) => l.type === 'doi')?.identifier,
			journal: series?.title ?? undefined,
			journalShort: series?.short_title ?? undefined,
			volume: series?.volume ?? undefined,
			issue: series?.issue ?? undefined,
			pages: d.source?.pages || undefined,
			journalRef: d.source?.source,
			url: d.zbmath_url ?? `https://zbmath.org/?q=an:${zbl}`,
		};
	});
}

export class ZbmathSource implements LiteratureSource {
	readonly id = 'zbmath' as const;
	readonly name = 'zbMATH Open';
	private readonly limiter: RateLimiter;

	constructor(private readonly fetchText: FetchText = defaultFetch, intervalMs = 1000) {
		this.limiter = new RateLimiter(intervalMs);
	}

	/** zbMATH syntax works too: `au:Bender ti:pendulum cc:70K`. */
	async search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
		const size = Math.min(options.maxResults ?? 20, 100);
		const params = new URLSearchParams({
			search_string: query,
			page: String(Math.floor((options.start ?? 0) / size)),
			results_per_page: String(size),
		});
		const text = await this.limiter.run(() => this.fetchText(`${ZBMATH_API}?${params}`, 'application/json'));
		return parseZbmath(JSON.parse(text));
	}
}

// ---------------------------------------------------------------------------
// Crossref: every journal with DOIs (APS, Springer, Elsevier, IOP, AMS, ...)

const CROSSREF_API = 'https://api.crossref.org/works';
const CROSSREF_SELECT = 'DOI,title,author,container-title,short-container-title,volume,issue,page,article-number,issued,abstract,is-referenced-by-count,type';

function stripJats(text: string): string {
	return text
		.replace(/<jats:title>[\s\S]*?<\/jats:title>/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function parseCrossrefItem(w: Json): Paper {
	const doi = String(w.DOI ?? '');
	const author = (a: Json) => (a.family ? (a.given ? `${a.family}, ${a.given}` : a.family) : a.name);
	return {
		source: 'crossref',
		id: doi,
		doi,
		title: decodeXml(first<string>(w.title) ?? '').replace(/<[^>]+>/g, ''),
		authors: (w.author ?? []).map(author).filter(Boolean),
		abstract: w.abstract ? stripJats(w.abstract) : '',
		year: Number(w.issued?.['date-parts']?.[0]?.[0]) || 0,
		journal: first<string>(w['container-title']),
		journalShort: first<string>(w['short-container-title']),
		volume: w.volume,
		issue: w.issue,
		pages: w.page ?? w['article-number'],
		citationCount: w['is-referenced-by-count'],
		url: `https://doi.org/${doi}`,
	};
}

export function parseCrossref(json: Json): Paper[] {
	const items = json?.message?.items ?? (json?.message?.DOI ? [json.message] : []);
	return items.map(parseCrossrefItem);
}

export class CrossrefSource implements LiteratureSource {
	readonly id = 'crossref' as const;
	readonly name = 'Crossref';
	private readonly limiter: RateLimiter;

	constructor(private readonly fetchText: FetchText = defaultFetch, intervalMs = 1000) {
		this.limiter = new RateLimiter(intervalMs);
	}

	private get(url: string): Promise<Paper[]> {
		return this.limiter.run(async () => parseCrossref(JSON.parse(await this.fetchText(url, 'application/json'))));
	}

	search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
		const params = new URLSearchParams({
			'query.bibliographic': query,
			filter: 'type:journal-article',
			rows: String(Math.min(options.maxResults ?? 20, 100)),
			offset: String(options.start ?? 0),
			select: CROSSREF_SELECT,
		});
		if (options.sort === 'recent') {
			params.set('sort', 'published');
		} else if (options.sort === 'cited') {
			params.set('sort', 'is-referenced-by-count');
		}
		return this.get(`${CROSSREF_API}?${params}`);
	}

	async lookup(identifiers: { dois?: string[] }): Promise<Paper[]> {
		const papers: Paper[] = [];
		for (const doi of identifiers.dois ?? []) {
			try {
				papers.push(...(await this.get(`${CROSSREF_API}/${encodeURIComponent(doi)}`)));
			} catch {
				// unknown DOI: skip it
			}
		}
		return papers;
	}
}

// ---------------------------------------------------------------------------
// OpenAlex: everything, with related works for recommendations

const OPENALEX_API = 'https://api.openalex.org/works';
const OPENALEX_SELECT = 'id,doi,ids,title,authorships,publication_year,primary_location,biblio,cited_by_count,related_works,abstract_inverted_index,type';

/** OpenAlex stores abstracts as word -> positions; put the words back in order. */
export function invertedAbstract(index: Record<string, number[]> | null | undefined): string {
	if (!index) {
		return '';
	}
	const words: string[] = [];
	for (const [word, positions] of Object.entries(index)) {
		for (const p of positions) {
			words[p] = word;
		}
	}
	return words.filter((w) => w !== undefined).join(' ');
}

const shortId = (url: string) => url.replace(/^https:\/\/openalex\.org\//, '');

export function parseOpenalexWork(w: Json): Paper {
	const doiUrl: string = w.doi ?? w.ids?.doi ?? '';
	let doi = doiUrl ? parseDoi(doiUrl) : undefined;
	let arxivId = w.ids?.arxiv ? parseArxivId(w.ids.arxiv)?.id : undefined;
	// arXiv's own DOIs (10.48550/arXiv.X) name the preprint, not a publication.
	const arxivDoi = doi && /^10\.48550\/arxiv\.(.+)$/i.exec(doi);
	if (arxivDoi) {
		arxivId = arxivId ?? parseArxivId(arxivDoi[1])?.id;
		doi = undefined;
	}
	const source = w.primary_location?.source;
	const journal = source?.type === 'journal' ? source.display_name : undefined;
	const b = w.biblio ?? {};
	const id = shortId(w.id ?? '');
	return {
		source: 'openalex',
		id,
		openalexId: id,
		title: w.title ?? w.display_name ?? '',
		authors: (w.authorships ?? []).map((a: Json) => a.author?.display_name ?? a.raw_author_name).filter(Boolean),
		abstract: invertedAbstract(w.abstract_inverted_index),
		year: Number(w.publication_year) || 0,
		arxivId,
		doi,
		journal,
		volume: journal ? b.volume ?? undefined : undefined,
		issue: journal ? b.issue ?? undefined : undefined,
		pages: journal && b.first_page ? (b.last_page && b.last_page !== b.first_page ? `${b.first_page}--${b.last_page}` : b.first_page) : undefined,
		relatedIds: (w.related_works ?? []).map(shortId),
		citationCount: w.cited_by_count,
		url: doi ? `https://doi.org/${doi}` : arxivId ? `https://arxiv.org/abs/${arxivId}` : w.id,
		pdfUrl: w.primary_location?.pdf_url ?? undefined,
	};
}

export function parseOpenalex(json: Json): Paper[] {
	return (json?.results ?? (json?.id ? [json] : [])).map(parseOpenalexWork);
}

export class OpenalexSource implements LiteratureSource {
	readonly id = 'openalex' as const;
	readonly name = 'OpenAlex';
	private readonly limiter: RateLimiter;

	/** OpenAlex allows 10 requests a second without a key. */
	constructor(private readonly fetchText: FetchText = defaultFetch, intervalMs = 200) {
		this.limiter = new RateLimiter(intervalMs);
	}

	private get(params: URLSearchParams): Promise<Paper[]> {
		params.set('select', OPENALEX_SELECT);
		return this.limiter.run(async () => parseOpenalex(JSON.parse(await this.fetchText(`${OPENALEX_API}?${params}`, 'application/json'))));
	}

	search(query: string, options: SearchOptions = {}): Promise<Paper[]> {
		const perPage = Math.min(options.maxResults ?? 20, 100);
		const params = new URLSearchParams({
			search: query,
			'per-page': String(perPage),
			page: String(Math.floor((options.start ?? 0) / perPage) + 1),
		});
		if (options.sort === 'recent') {
			params.set('sort', 'publication_date:desc');
		} else if (options.sort === 'cited') {
			params.set('sort', 'cited_by_count:desc');
		}
		return this.get(params);
	}

	async lookup(identifiers: { arxivIds?: string[]; dois?: string[] }): Promise<Paper[]> {
		const dois = [...(identifiers.dois ?? []), ...(identifiers.arxivIds ?? []).map((id) => `10.48550/arXiv.${id}`)];
		const papers: Paper[] = [];
		for (let i = 0; i < dois.length; i += 50) {
			const batch = dois.slice(i, i + 50);
			papers.push(...(await this.get(new URLSearchParams({ filter: `doi:${batch.join('|')}`, 'per-page': String(batch.length) }))));
		}
		return papers;
	}

	/** Works OpenAlex relates to the given papers, most often related first. */
	async related(papers: Paper[], limit: number): Promise<Paper[]> {
		const known = papers.filter((p) => p.relatedIds && p.relatedIds.length > 0);
		const missing = papers.filter((p) => !p.relatedIds?.length && (p.doi || p.arxivId)).slice(0, 50);
		const looked = missing.length > 0 ? await this.lookup({ dois: missing.filter((p) => p.doi).map((p) => p.doi!), arxivIds: missing.filter((p) => !p.doi && p.arxivId).map((p) => p.arxivId!) }) : [];
		const counts = new Map<string, number>();
		for (const p of [...known, ...looked]) {
			for (const id of p.relatedIds ?? []) {
				counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
		const ids = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.min(limit, 100)).map(([id]) => id);
		const works: Paper[] = [];
		for (let i = 0; i < ids.length; i += 50) {
			const batch = ids.slice(i, i + 50);
			works.push(...(await this.get(new URLSearchParams({ filter: `openalex:${batch.join('|')}`, 'per-page': String(batch.length) }))));
		}
		return works;
	}
}

// ---------------------------------------------------------------------------
// All sources together

export const ALL_SOURCES: SourceId[] = ['arxiv', 'inspire', 'zbmath', 'crossref', 'openalex'];

export function createSource(id: SourceId, fetchText: FetchText = defaultFetch): LiteratureSource {
	switch (id) {
		case 'arxiv':
			return new ArxivSource(fetchText);
		case 'inspire':
			return new InspireSource(fetchText);
		case 'zbmath':
			return new ZbmathSource(fetchText);
		case 'crossref':
			return new CrossrefSource(fetchText);
		case 'openalex':
			return new OpenalexSource(fetchText);
	}
}

export function createSources(ids: SourceId[] = ALL_SOURCES, fetchText: FetchText = defaultFetch): LiteratureSource[] {
	return [...new Set(ids)].filter((id) => ALL_SOURCES.includes(id)).map((id) => createSource(id, fetchText));
}

export interface SearchAllResult {
	papers: Paper[];
	/** Sources that failed, with the reason; the others' results still count. */
	errors: { source: SourceId; message: string }[];
}

/**
 * Search several sources at once and merge the results, so a paper found on
 * arXiv, INSPIRE and Crossref appears once, with its abstract from arXiv, its
 * journal details from INSPIRE or Crossref, and its INSPIRE key. A source
 * that fails or is offline is reported, not fatal.
 */
export async function searchAll(sources: LiteratureSource[], query: string, options: SearchOptions = {}): Promise<SearchAllResult> {
	const errors: SearchAllResult['errors'] = [];
	const lists = await Promise.all(
		sources.map((s) =>
			s.search(query, options).catch((e: unknown) => {
				errors.push({ source: s.id, message: e instanceof Error ? e.message : String(e) });
				return [] as Paper[];
			}),
		),
	);
	const merged = mergeResults(lists);
	// Relevance keeps each source's own order; the others re-sort the merged list.
	if (options.sort === 'cited') {
		merged.sort((a, b) => (b.citationCount ?? -1) - (a.citationCount ?? -1));
	} else if (options.sort === 'recent') {
		merged.sort((a, b) => (b.published ?? String(b.year)).localeCompare(a.published ?? String(a.year)));
	}
	return { papers: options.maxResults ? merged.slice(0, options.maxResults) : merged, errors };
}

/** A paper by arXiv ID or DOI, merged from every source that has it. */
export async function lookupPaper(sources: LiteratureSource[], identifier: string): Promise<Paper | undefined> {
	const doi = parseDoi(identifier);
	const arxivId = doi ? undefined : parseArxivId(identifier)?.id;
	if (!doi && !arxivId) {
		return undefined;
	}
	const lists = await Promise.all(
		sources.filter((s) => s.lookup).map((s) => s.lookup!({ arxivIds: arxivId ? [arxivId] : [], dois: doi ? [doi] : [] }).catch(() => [] as Paper[])),
	);
	const matching = lists.map((l) => l.filter((p) => (doi ? p.doi?.toLowerCase() === doi.toLowerCase() : p.arxivId === arxivId)));
	return mergeResults(matching)[0];
}
