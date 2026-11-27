// Tests the literature sources against responses recorded from the real
// services (test/fixtures), and how their results merge.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const L = require('../out/literature');
const S = require('../out/sources');
const { fixtureFetch } = require('../out/fixtureFetch');

const FIXTURES = path.join(__dirname, 'fixtures');
const json = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

test('INSPIRE: published version, texkey, arXiv ID, citations', () => {
	const [maldacena, ...rest] = S.parseInspire(json('inspire-search.json'));
	assert.equal(maldacena.source, 'inspire');
	assert.equal(maldacena.texkey, 'Maldacena:1997re');
	assert.equal(maldacena.arxivId, 'hep-th/9711200');
	assert.equal(maldacena.primaryCategory, 'hep-th');
	assert.equal(maldacena.doi, '10.4310/ATMP.1998.v2.n2.a1');
	// The publication, not the Int. J. Theor. Phys. reprint listed first.
	assert.equal(maldacena.journal, 'Adv.Theor.Math.Phys.');
	assert.equal(maldacena.volume, '2');
	assert.equal(maldacena.pages, '231--252');
	assert.equal(maldacena.year, 1998);
	assert.deepEqual(maldacena.authors, ['Maldacena, Juan Martin']);
	assert.ok(maldacena.citationCount > 20000);
	assert.equal(maldacena.url, 'https://inspirehep.net/literature/451647');
	assert.ok(rest.some((p) => p.texkey === 'Rey:1998ik'));
});

test('zbMATH: journal from the series, DOI and arXiv from links, MSC classes', () => {
	const [bender] = S.parseZbmath(json('zbmath-search.json'));
	assert.equal(bender.zbl, '1112.70020');
	assert.equal(bender.title, 'Complex trajectories of a simple pendulum');
	assert.deepEqual(bender.authors, ['Bender, Carl M.', 'Holm, Darryl D.', 'Hook, Daniel W.']);
	assert.equal(bender.doi, '10.1088/1751-8113/40/3/F01');
	assert.equal(bender.arxivId, 'math-ph/0609068');
	assert.equal(bender.journal, 'Journal of Physics A: Mathematical and Theoretical');
	assert.equal(bender.journalShort, 'J. Phys. A, Math. Theor.');
	assert.equal(bender.volume, '40');
	assert.equal(bender.issue, '3');
	assert.equal(bender.pages, 'F81-F89');
	assert.equal(bender.year, 2007);
	assert.ok(bender.categories.includes('70K55'));
	assert.match(bender.abstract, /^The motion of a classical pendulum/);
});

test('Crossref: journal articles with "Family, Given" authors', () => {
	const [first] = S.parseCrossref(json('crossref-search.json'));
	assert.equal(first.doi, '10.1016/s0370-1573(96)00038-5');
	assert.equal(first.journal, 'Physics Reports');
	assert.equal(first.volume, '285');
	assert.equal(first.issue, '3');
	assert.equal(first.pages, '77-141');
	assert.equal(first.year, 1997);
	assert.deepEqual(first.authors, ['Jung, C.', 'Seligman, T.H.']);
	assert.equal(first.url, 'https://doi.org/10.1016/s0370-1573(96)00038-5');
});

test('OpenAlex: arXiv DOIs become arXiv IDs; journals, pages, related works', () => {
	const [preprint] = S.parseOpenalex(json('openalex-search.json'));
	assert.equal(preprint.arxivId, '2608.10235');
	assert.equal(preprint.doi, undefined, "arXiv's own DOI names the preprint, not a publication");
	assert.equal(preprint.journal, undefined);

	const [jcp] = S.parseOpenalex(json('openalex-doi.json'));
	assert.equal(jcp.openalexId, 'W2085205285');
	assert.equal(jcp.doi, '10.1016/0021-9991(91)90299-z');
	assert.equal(jcp.journal, 'Journal of Computational Physics');
	assert.equal(jcp.volume, '92');
	assert.equal(jcp.pages, '230--256');
	assert.equal(jcp.relatedIds.length, 10);
	assert.match(jcp.relatedIds[0], /^W\d+$/);
});

test('inverted abstracts are put back in order', () => {
	assert.equal(S.invertedAbstract({ pendulum: [2], The: [0], simple: [1] }), 'The simple pendulum');
	assert.equal(S.invertedAbstract(null), '');
});

test('DOIs from links and prefixes', () => {
	assert.equal(L.parseDoi('https://doi.org/10.1103/PhysRevLett.116.061102'), '10.1103/PhysRevLett.116.061102');
	assert.equal(L.parseDoi('doi:10.4310/ATMP.1998.v2.n2.a1.'), '10.4310/ATMP.1998.v2.n2.a1');
	assert.equal(L.parseDoi('hep-th/9711200'), undefined);
});

test('merging: one paper from several sources keeps the best of each', () => {
	const arxiv = S.parseArxivAtom(fs.readFileSync(path.join(FIXTURES, 'arxiv-ids.xml'), 'utf8')).find((p) => p.arxivId === 'hep-th/9711200');
	const inspire = S.parseInspire(json('inspire-search.json'))[0];
	const [merged, ...others] = L.mergeResults([[arxiv], [inspire]]);
	assert.equal(others.length, 0);
	assert.deepEqual(merged.sources, ['arxiv', 'inspire']);
	assert.equal(merged.abstract, arxiv.abstract, 'abstract from arXiv');
	assert.equal(merged.journal, 'Adv.Theor.Math.Phys.', 'journal from INSPIRE');
	assert.equal(merged.texkey, 'Maldacena:1997re');
	assert.equal(merged.url, 'https://arxiv.org/abs/hep-th/9711200');
	// Matched by DOI too, when arXiv IDs are missing.
	const crossref = { ...inspire, source: 'crossref', arxivId: undefined, texkey: undefined, id: inspire.doi };
	assert.equal(L.mergeResults([[inspire], [crossref]]).length, 1);
});

test('merging takes each source in turn, so no source crowds out the others', () => {
	const a = [1, 2, 3].map((i) => ({ source: 'arxiv', id: `a${i}`, arxivId: `2601.0000${i}`, title: `A${i}`, authors: [], abstract: '', year: 2026, url: '' }));
	const z = [1, 2].map((i) => ({ source: 'zbmath', id: `z${i}`, title: `Z${i}`, authors: [], abstract: '', year: 2026, url: '' }));
	assert.deepEqual(L.mergeResults([a, z]).map((p) => p.title), ['A1', 'Z1', 'A2', 'Z2', 'A3']);
});

test('BibTeX: published papers are @article with journal fields and eprint', () => {
	const [bender] = S.parseZbmath(json('zbmath-search.json'));
	const entry = L.toBibtex(bender, L.bibtexKey(bender));
	assert.match(entry, /^@article\{bender2007complex,/);
	assert.match(entry, /author\s+= \{Bender, Carl M\. and Holm, Darryl D\. and Hook, Daniel W\.\}/);
	assert.match(entry, /journal\s+= \{Journal of Physics A: Mathematical and Theoretical\}/);
	assert.match(entry, /volume\s+= \{40\}/);
	assert.match(entry, /number\s+= \{3\}/);
	assert.match(entry, /pages\s+= \{F81--F89\}/);
	assert.match(entry, /eprint\s+= \{math-ph\/0609068\}/);
	assert.match(entry, /doi\s+= \{10\.1088\/1751-8113\/40\/3\/F01\}/);
	assert.doesNotMatch(entry, /\burl\b/, 'the DOI is the link');
});

test("BibTeX: INSPIRE's own entry and key are used when available", () => {
	const inspire = { ...S.parseInspire(json('inspire-search.json'))[0], bibtex: fs.readFileSync(path.join(FIXTURES, 'inspire-maldacena.bib'), 'utf8') };
	const { text, key, added } = L.addToBib('', inspire);
	assert.ok(added);
	assert.equal(key, 'Maldacena:1997re');
	assert.match(text, /^@article\{Maldacena:1997re,/);
	// Found again by arXiv ID or DOI, in INSPIRE's "quoted" field style.
	assert.equal(L.findInBib(text, { ...inspire, doi: undefined }), 'Maldacena:1997re');
	assert.equal(L.findInBib(text, { ...inspire, arxivId: undefined }), 'Maldacena:1997re');
	// A clash with an existing key falls back to our own key.
	const clash = L.addToBib('@article{Maldacena:1997re, title={Other}}\n', { ...inspire, arxivId: 'x', doi: undefined });
	assert.notEqual(clash.key, 'Maldacena:1997re');
	assert.match(clash.text, new RegExp(`@article\\{${clash.key},`));
});

test('bibtexKey uses the surname of "Last, First" names', () => {
	const paper = { authors: ['Maldacena, Juan Martin'], title: 'The Large N limit of superconformal field theories', year: 1998 };
	assert.equal(L.bibtexKey(paper), 'maldacena1998large');
	assert.equal(L.displayName('Maldacena, Juan Martin'), 'Juan Martin Maldacena');
});

test('searchAll asks every source politely and reports the ones that fail', async () => {
	const urls = [];
	const fetch = fixtureFetch(FIXTURES, urls);
	const sources = S.createSources(S.ALL_SOURCES, fetch);
	const failing = { id: 'crossref', name: 'Crossref', search: async () => { throw new Error('crossref answered 503'); } };
	const { papers, errors } = await S.searchAll([...sources.filter((s) => s.id !== 'crossref'), failing], 'pendulum', { maxResults: 100 });
	assert.deepEqual(errors, [{ source: 'crossref', message: 'crossref answered 503' }]);
	const from = new Set(papers.flatMap((p) => p.sources));
	assert.deepEqual([...from].sort(), ['arxiv', 'inspire', 'openalex', 'zbmath']);
	for (const host of ['export.arxiv.org', 'inspirehep.net', 'api.zbmath.org', 'api.openalex.org']) {
		assert.ok(urls.some((u) => new URL(u).host === host), host);
	}
	// What is sent: the query, never anything about the user.
	assert.ok(urls.every((u) => !/mailto|email/i.test(u)));
});

test('lookupPaper and bestForBibliography: arXiv ID or DOI to INSPIRE BibTeX', async () => {
	const sources = S.createSources(S.ALL_SOURCES, fixtureFetch(FIXTURES));
	const byArxiv = await S.lookupPaper(sources, 'https://arxiv.org/abs/hep-th/9711200v3');
	assert.equal(byArxiv.texkey, 'Maldacena:1997re');
	assert.ok(byArxiv.sources.includes('arxiv') && byArxiv.sources.includes('inspire'));
	const byDoi = await S.lookupPaper(sources, 'doi:10.4310/ATMP.1998.v2.n2.a1');
	assert.equal(byDoi.arxivId, 'hep-th/9711200');
	const best = await L.bestForBibliography(byDoi, sources);
	assert.match(best.bibtex, /^@article\{Maldacena:1997re,/);
	assert.equal(await S.lookupPaper(sources, 'not an identifier'), undefined);
});

test('recommendations draw on every source and on related works', async () => {
	const urls = [];
	const sources = S.createSources(S.ALL_SOURCES, fixtureFetch(FIXTURES, urls));
	const tex = fs.readFileSync(path.join(__dirname, '..', 'templates', 'hamiltonian', 'manuscript', 'main.tex'), 'utf8');
	const bib = '@article{x, title={Symplectic integrators}, doi={10.1016/0021-9991(91)90299-z}}\n';
	const ranked = await L.recommend(sources, tex, bib, { maxResults: 50 });
	assert.ok(ranked.length > 5);
	assert.ok(!ranked.some(({ paper }) => paper.doi === '10.1016/0021-9991(91)90299-z'), 'already cited');
	assert.ok(urls.some((u) => u.includes('filter=openalex')), 'asked OpenAlex for related works');
	assert.match(ranked[0].paper.title, /pendulum|hamiltonian/i);
	const from = new Set(ranked.flatMap(({ paper }) => paper.sources));
	assert.ok(from.size >= 4, [...from].join(','));
});
