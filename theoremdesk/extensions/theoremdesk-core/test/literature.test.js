// Tests the literature engine against real arXiv API responses (fixtures).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const L = require('../out/literature');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const search = L.parseArxivAtom(fixture('arxiv-search.xml'));
const ids = L.parseArxivAtom(fixture('arxiv-ids.xml'));
const maldacena = ids.find((p) => p.id === 'hep-th/9711200');
const vaswani = ids.find((p) => p.id === '1706.03762');

test('parses arXiv Atom: new and old identifiers, versions, DOI, journal reference', () => {
	assert.equal(search.length, 3);
	assert.equal(ids.length, 2);
	const first = search[0];
	assert.equal(first.id, '1104.0312');
	assert.equal(first.version, 'v2');
	assert.equal(first.primaryCategory, 'math.DS');
	assert.deepEqual(first.categories, ['math.DS', 'math-ph']);
	assert.equal(first.year, 2011);
	assert.equal(first.authors[0], 'Primitivo B. Acosta-Humánez');
	assert.equal(first.url, 'https://arxiv.org/abs/1104.0312');
	assert.ok(first.abstract.startsWith('In this paper we analyze'));
	assert.ok(!/\s{2}/.test(first.abstract), 'whitespace collapsed');

	assert.equal(maldacena.doi, '10.1023/A:1026654312961');
	assert.equal(maldacena.journalRef, 'Adv.Theor.Math.Phys.2:231-252,1998');
	assert.equal(maldacena.primaryCategory, 'hep-th');
	assert.equal(vaswani.title, 'Attention Is All You Need');
});

test('arXiv identifiers from text and links', () => {
	assert.deepEqual(L.parseArxivId('1706.03762v7'), { id: '1706.03762', version: 'v7' });
	assert.deepEqual(L.parseArxivId('https://arxiv.org/abs/hep-th/9711200'), { id: 'hep-th/9711200', version: undefined });
	assert.deepEqual(L.parseArxivId('arXiv:2401.12345'), { id: '2401.12345', version: undefined });
	assert.equal(L.parseArxivId('https://arxiv.org/pdf/math.DG/0211159v1').id, 'math.DG/0211159');
	assert.equal(L.parseArxivId('not an id'), undefined);
});

test('search queries: words, phrases, field syntax and categories', () => {
	assert.equal(L.arxivSearchQuery('hamiltonian pendulum'), 'all:hamiltonian AND all:pendulum');
	assert.equal(L.arxivSearchQuery('"double pendulum" chaos'), 'all:"double pendulum" AND all:chaos');
	assert.equal(L.arxivSearchQuery('au:maldacena AND ti:large'), 'au:maldacena AND ti:large');
	assert.equal(L.arxivSearchQuery('pendulum', 'math-ph'), '(all:pendulum) AND cat:math-ph');
});

test('accents and special letters become LaTeX', () => {
	assert.equal(L.toLatex('Acosta-Humánez'), "Acosta-Hum{\\'a}nez");
	assert.equal(L.toLatex('Joaquín'), "Joaqu{\\'\\i}n");
	assert.equal(L.toLatex('Schrödinger, Gödel'), 'Schr{\\"o}dinger, G{\\"o}del');
	assert.equal(L.toLatex('Łukasz Kaiser'), '{\\L}ukasz Kaiser');
	assert.equal(L.toLatex('Čech'), '{\\v{C}}ech');
	assert.equal(L.toLatex('Poincaré–Birkhoff'), "Poincar{\\'e}--Birkhoff");
	assert.equal(L.toLatex('plain ASCII'), 'plain ASCII');
});

test('BibTeX entries: readable unique keys, arXiv fields, DOI and journal', () => {
	assert.equal(L.bibtexKey(maldacena), 'maldacena1997large');
	assert.equal(L.bibtexKey(vaswani), 'vaswani2017attention');
	assert.equal(L.bibtexKey(search[0]), 'acostahumanez2011integrability');
	assert.equal(L.bibtexKey(maldacena, new Set(['maldacena1997large'])), 'maldacena1997largea');

	const entry = L.toBibtex(maldacena, 'maldacena1997large');
	assert.match(entry, /^@misc\{maldacena1997large,\n/);
	assert.match(entry, /title\s+= \{\{The Large N Limit of Superconformal Field Theories and Supergravity\}\}/);
	assert.match(entry, /eprint\s+= \{hep-th\/9711200\}/);
	assert.match(entry, /archivePrefix = \{arXiv\}/);
	assert.match(entry, /primaryClass\s+= \{hep-th\}/);
	assert.match(entry, /doi\s+= \{10\.1023\/A:1026654312961\}/);
	assert.match(entry, /note\s+= \{Adv\.Theor\.Math\.Phys\.2:231-252,1998\}/);
	assert.match(L.toBibtex(search[0], 'k'), /author\s+= \{Primitivo B\. Acosta-Hum\{\\'a\}nez and /);
	assert.equal(L.toBibtex({ ...vaswani, title: 'R&D at 50% #1' }, 'k').match(/title\s+= \{\{(.*)\}\}/)[1], 'R\\&D at 50\\% \\#1');
});

test('adding to a bibliography: appends once, finds duplicates by arXiv ID or DOI', () => {
	const first = L.addToBib('', maldacena);
	assert.ok(first.added);
	assert.equal(first.key, 'maldacena1997large');

	const again = L.addToBib(first.text, maldacena);
	assert.ok(!again.added);
	assert.equal(again.key, 'maldacena1997large');
	assert.equal(again.text, first.text);

	// Already cited under another key, by DOI only.
	const byDoi = '@article{Maldacena:1997re,\n  author = {Maldacena, Juan},\n  doi = {10.1023/A:1026654312961},\n}\n';
	assert.deepEqual(L.addToBib(byDoi, maldacena), { text: byDoi, key: 'Maldacena:1997re', added: false });

	// Already cited by arXiv link.
	const byUrl = '@misc{attn,\n  url = {https://arxiv.org/abs/1706.03762v5},\n}\n';
	assert.equal(L.addToBib(byUrl, vaswani).key, 'attn');

	const both = L.addToBib(first.text, vaswani);
	assert.ok(both.added);
	assert.deepEqual([...L.indexBib(both.text).keys], ['maldacena1997large', 'vaswani2017attention']);
	assert.match(both.text, /\}\n\n@misc\{vaswani2017attention,/, 'a blank line between entries');
});

const MANUSCRIPT = fs.readFileSync(path.join(__dirname, '..', 'templates', 'hamiltonian', 'manuscript', 'main.tex'), 'utf8');

test('a manuscript profile picks out its subject', () => {
	const text = L.plainText('\\section{Intro} The $E=mc^2$ pendulum~\\cite{x} % hidden\n\\begin{equation}a=b\\end{equation} oscillates');
	assert.ok(!/cite|hidden|mc\^2|section/.test(text), text);
	const terms = L.topTerms(L.projectProfile(MANUSCRIPT), 6);
	assert.ok(terms.includes('pendulum'), terms.join(' '));
	assert.ok(terms.includes('oscillator'), terms.join(' '));
	assert.match(L.recommendationQuery(L.projectProfile(MANUSCRIPT)), /^all:\w+( OR all:[\w-]+)+$/);
});

test('ranking puts related papers above unrelated ones', () => {
	const ranked = L.rankBySimilarity(L.projectProfile(MANUSCRIPT), [vaswani, ...search, maldacena]);
	assert.ok(ranked[0].paper.title.toLowerCase().includes('pendulum'), ranked[0].paper.title);
	const pos = (p) => ranked.findIndex((r) => r.paper === p);
	assert.ok(pos(vaswani) > pos(search[0]) && pos(vaswani) > pos(search[1]));
	assert.ok(ranked.every((r, i) => i === 0 || ranked[i - 1].score >= r.score));
});

test('recommendations leave out papers already in the bibliography', async () => {
	const source = { id: 'fake', name: 'fake', search: async () => [...search, vaswani], byIds: async () => [] };
	const bib = L.addToBib('', search[0]).text;
	const ranked = await L.recommend(source, MANUSCRIPT, bib, { maxResults: 10 });
	assert.ok(!ranked.some((r) => r.paper.id === search[0].id), 'already cited');
	assert.equal(ranked.length, 3);
});

test('the arXiv client asks politely: one request at a time, spaced out', async () => {
	const urls = [];
	const times = [];
	const source = new L.ArxivSource(async (url) => {
		urls.push(url);
		times.push(Date.now());
		return fixture('arxiv-search.xml');
	}, 200);
	const [a, b] = await Promise.all([source.search('hamiltonian pendulum', { maxResults: 3, category: 'math-ph' }), source.byIds(['1706.03762', 'junk'])]);
	assert.equal(a.length, 3);
	assert.equal(b.length, 3);
	assert.ok(times[1] - times[0] >= 190, `requests ${times[1] - times[0]} ms apart`);
	const first = new URL(urls[0]);
	assert.equal(first.searchParams.get('search_query'), '(all:hamiltonian AND all:pendulum) AND cat:math-ph');
	assert.equal(first.searchParams.get('max_results'), '3');
	assert.equal(new URL(urls[1]).searchParams.get('id_list'), '1706.03762');
});
