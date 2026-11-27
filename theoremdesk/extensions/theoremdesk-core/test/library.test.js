// Tests the literature database and library answers with a fake embedder
// (hashed bag of words), so no model is needed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const L = require('../out/library');
const R = require('../out/rag');

/** Words hashed into 256 buckets, normalised: similar texts get similar vectors. */
const fakeEmbedder = (dim = 256) => ({
	calls: 0,
	async embed(texts) {
		this.calls++;
		return texts.map((t) => {
			const v = new Float32Array(dim);
			for (const w of t.replace(/^Instruct:[^\n]*\nQuery: /, '').toLowerCase().match(/[a-z]{3,}/g) ?? []) {
				let h = 0;
				for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
				v[h % dim] += 1;
			}
			const n = Math.hypot(...v) || 1;
			return v.map((x) => x / n);
		});
	},
});

const pendulum = {
	title: 'Complex trajectories of a simple pendulum',
	authors: ['Bender, Carl M.', 'Holm, Darryl D.', 'Hook, Daniel W.'],
	year: 2007,
	arxivId: 'math-ph/0609068',
	abstract: 'The motion of a classical pendulum is studied in the complex plane.',
	url: 'https://arxiv.org/abs/math-ph/0609068',
};
const pendulumPages = [
	'Introduction. The simple pendulum has a separatrix between libration and rotation. When the energy exceeds the separatrix energy the pendulum rotates.',
	'Complex trajectories. Turning points of the pendulum lie on the real axis; complex trajectories encircle the turning points and the orbits are closed when the energy is below one.',
];
const attention = {
	title: 'Attention is all you need',
	authors: ['Ashish Vaswani', 'Noam Shazeer'],
	year: 2017,
	arxivId: '1706.03762',
	abstract: 'We propose the Transformer, a network architecture based solely on attention mechanisms for machine translation.',
	url: 'https://arxiv.org/abs/1706.03762',
};

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'td-lib-'));

test('cleanText fixes ligatures, end-of-line hyphenation and spacing', () => {
	assert.equal(L.cleanText('con\uFB01guration  of   the pendu-\nlum\n\n\n\nnext'), 'configuration of the pendulum\n\nnext');
});

test('chunkPages: bounded passages that keep their page, overlapping, skipping scraps', () => {
	const long = Array.from({ length: 60 }, (_, i) => `Sentence ${i} about the Hamiltonian flow.`).join(' ');
	const chunks = L.chunkPages(['tiny', long], 400, 80);
	assert.ok(chunks.length >= 5);
	assert.ok(chunks.every((c) => c.page === 2), 'the scrap on page 1 is skipped');
	assert.ok(chunks.every((c) => c.text.length <= 400));
	assert.ok(chunks.slice(0, -1).every((c) => /\.$/.test(c.text)), 'breaks at sentence ends');
	const joined = chunks.map((c) => c.text).join(' ');
	for (let i = 0; i < 60; i++) {
		assert.ok(joined.includes(`Sentence ${i} `), `sentence ${i} kept`);
	}
});

test('paperKey: arXiv ID, then DOI, then file, then title', () => {
	assert.equal(L.paperKey({ arxivId: '1706.03762', doi: '10.x/Y' }), 'arxiv:1706.03762');
	assert.equal(L.paperKey({ doi: '10.1103/PhysRevLett.116.061102' }), 'doi:10.1103/physrevlett.116.061102');
	assert.equal(L.paperKey({ file: 'C:/papers/Notes.PDF' }), 'file:notes.pdf');
	assert.equal(L.paperKey({ title: 'On the Pendulum!' }), 'title:on the pendulum');
});

test('add, search, persist, replace and remove', async () => {
	const dir = tmp();
	const e = fakeEmbedder();
	try {
		const lib = new L.Library(dir);
		const entry = await lib.add(pendulum, pendulumPages, e);
		assert.equal(entry.text, 'pdf');
		assert.equal(entry.pages, 2);
		assert.equal(entry.chunks, 3, 'title+abstract, plus one passage per page');
		const abstractOnly = await lib.add(attention, undefined, e);
		assert.equal(abstractOnly.text, 'abstract');
		assert.equal(abstractOnly.chunks, 1);

		const hits = await lib.search('closed orbits around the turning points of the pendulum', e, { limit: 5 });
		assert.equal(hits[0].paper.key, 'arxiv:math-ph/0609068');
		assert.equal(hits[0].chunk.page, 2);
		assert.equal(L.citeLabel(hits[0]), 'Bender et al. 2007, p. 2');
		assert.ok(!hits.some((h) => h.paper.key === 'arxiv:1706.03762'), 'unrelated papers fall below the relevance floor');

		// Survives a restart.
		const again = new L.Library(dir);
		assert.deepEqual(again.size, { papers: 2, passages: 4 });
		assert.equal((await again.search('Transformer attention translation', e))[0].paper.key, 'arxiv:1706.03762');

		// Adding again replaces, doesn't duplicate.
		await again.add(pendulum, pendulumPages.slice(0, 1), e);
		assert.deepEqual(again.size, { papers: 2, passages: 3 });

		assert.ok(again.remove('arxiv:1706.03762'));
		assert.ok(!again.remove('arxiv:1706.03762'));
		assert.deepEqual(new L.Library(dir).size, { papers: 1, passages: 2 });
		assert.ok(new L.Library(dir).has(pendulum));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('at most perPaper passages from one paper; search within chosen papers', async () => {
	const dir = tmp();
	const e = fakeEmbedder();
	try {
		const lib = new L.Library(dir);
		const pages = Array.from({ length: 6 }, (_, i) => `Pendulum separatrix rotation libration page ${i} with enough words to be a passage.`);
		await lib.add(pendulum, pages, e);
		await lib.add(attention, undefined, e);
		const hits = await lib.search('pendulum separatrix', e, { limit: 10, perPaper: 2, relative: 0 });
		assert.equal(hits.filter((h) => h.paper.key === 'arxiv:math-ph/0609068').length, 2);
		const only = await lib.search('pendulum separatrix', e, { papers: ['arxiv:1706.03762'], relative: 0 });
		assert.ok(only.every((h) => h.paper.key === 'arxiv:1706.03762'));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a failed embedding leaves the library unchanged; a changed model is refused', async () => {
	const dir = tmp();
	try {
		const lib = new L.Library(dir);
		await lib.add(attention, undefined, fakeEmbedder());
		const failing = { embed: async () => { throw new Error('model crashed'); } };
		await assert.rejects(lib.add(pendulum, pendulumPages, failing), /model crashed/);
		assert.deepEqual(new L.Library(dir).size, { papers: 1, passages: 1 });
		await assert.rejects(lib.add(pendulum, pendulumPages, fakeEmbedder(128)), /embedding model changed/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('damaged library files are set aside, not silently lost', async () => {
	const base = tmp();
	const dir = path.join(base, 'library');
	try {
		const lib = new L.Library(dir);
		await lib.add(attention, undefined, fakeEmbedder());
		fs.writeFileSync(path.join(dir, 'vectors.f32'), Buffer.alloc(12));
		const reopened = new L.Library(dir);
		assert.deepEqual(reopened.size, { papers: 0, passages: 0 });
		assert.ok(fs.readdirSync(base).some((f) => f.startsWith('library.damaged-')));
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test('citations are read from answers, including ranges', () => {
	assert.deepEqual(R.citations('As shown [2], and [1, 3]; see [4-6] but not [x].'), [1, 2, 3, 4, 5, 6]);
	assert.deepEqual(R.citations('No sources.'), []);
});

test('askLibrary gives the model numbered sources and flags made-up citations', async () => {
	const dir = tmp();
	const e = fakeEmbedder();
	try {
		const lib = new L.Library(dir);
		await lib.add(pendulum, pendulumPages, e);
		let sent;
		const chat = { chat: async (messages) => ((sent = messages), { content: 'Orbits are closed below the separatrix [1], see also [9].', toolCalls: [] }) };
		const answer = await R.askLibrary(lib, 'When are pendulum orbits closed?', e, chat);
		assert.match(sent[0].content, /only the numbered sources/);
		assert.match(sent[1].content, /^Sources:\n\n\[1\] Complex trajectories of a simple pendulum \(Bender et al\. 2007/);
		assert.match(sent[1].content, /Question: When are pendulum orbits closed\?$/);
		assert.deepEqual(answer.invalidCitations, [9]);
		assert.ok(answer.sources[0].label.startsWith('Bender et al. 2007'));
		const empty = await R.askLibrary(new L.Library(tmp()), 'x', e, chat);
		assert.match(empty.text, /library is empty/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('downloadPdf accepts only PDFs', async () => {
	const pdf = await L.downloadPdf('https://x.test/a.pdf', async () => new Response('%PDF-1.7 rest'));
	assert.equal(fs.readFileSync(pdf, 'latin1'), '%PDF-1.7 rest');
	await assert.rejects(L.downloadPdf('https://x.test/b', async () => new Response('<html>')), /isn't a PDF/);
	await assert.rejects(L.downloadPdf('https://x.test/c', async () => new Response('', { status: 403 })), /answered 403/);
	assert.equal(L.pdfUrl({ arxivId: 'hep-th/9711200' }), 'https://arxiv.org/pdf/hep-th/9711200');
	assert.equal(L.pdfUrl({ doi: '10.x/y' }), undefined);
});
