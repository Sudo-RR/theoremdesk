// Tests the startup wizard's core: its prompts' answers are validated (and
// retried), made-up papers are dropped, and the project it writes is right.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const W = require('../out/wizard');

/** A model that plays back answers, and records what it was asked. */
function scripted(answers) {
	const sent = [];
	return { model: 'fake', sent, chat: async (messages, options) => (sent.push({ messages, options }), { content: answers.shift() ?? '{}', toolCalls: [], finishReason: 'stop' }) };
}

const choices = { kind: 'paper', fieldId: 'gr-qc', title: 'T', author: 'A', template: 'aps-revtex', journal: 'Physical Review Research', lean: true, notebooks: true, git: false };

test('JSON is found even in prose or code fences', () => {
	assert.deepEqual(W.parseJsonObject('{"a":1}'), { a: 1 });
	assert.deepEqual(W.parseJsonObject('```json\n{"a":2}\n```'), { a: 2 });
	assert.deepEqual(W.parseJsonObject('Here you go: {"a":3} hope it helps'), { a: 3 });
	assert.throws(() => W.parseJsonObject('no json here'), /did not answer with JSON/);
});

test('the brief review: schema-constrained, an example given, and a bad answer retried', async () => {
	const model = scripted(['{"clear": false, "missing": ["question"], "questions": [], "summary": "x"}', '{"clear": false, "missing": ["question","nonsense"], "questions": ["What do you want to compute?"], "summary": "A study of black holes."}']);
	const review = await W.reviewBrief(model, choices, 'I want to look at black holes.');
	assert.deepEqual(review, { clear: false, missing: ['question'], questions: ['What do you want to compute?'], summary: 'A study of black holes.' });
	const first = model.sent[0];
	assert.equal(first.options.jsonSchema.name, 'brief_review');
	assert.equal(first.options.temperature, 0.2);
	assert.equal(first.options.thinking, false);
	assert.match(first.messages[0].content, /object: what is studied/);
	assert.equal(first.messages[1].role, 'user', 'a worked example comes first');
	assert.equal(first.messages[2].role, 'assistant');
	assert.match(first.messages.at(-1).content, /Field: General relativity and cosmology\.\n\nBrief:\nI want to look at black holes\./);
	// The retry says what was wrong.
	assert.match(model.sent[1].messages.at(-1).content, /not usable: an unclear brief needs at least one question/);
});

test('a clear brief needs no questions; answers are folded into the brief', () => {
	assert.deepEqual(W.validateReview({ clear: true, missing: [], questions: ['ignored'], summary: ' S ' }), { clear: true, missing: [], questions: [], summary: 'S' });
	assert.equal(W.fullBrief('Brief.', [{ question: 'Which spin?', answer: ' near extremal ' }, { question: 'Skipped?', answer: '' }]), 'Brief.\n\nWhich spin?\nnear extremal');
});

test('the search plan: queries cleaned, categories limited to the field, invented works dropped', () => {
	const field = W.FIELDS.find((f) => f.id === 'gr-qc');
	const brief = 'Quasinormal modes of Kerr black holes with Leaver continued fractions, building on Leaver 1985 "An analytic representation for the quasi-normal modes of Kerr black holes".';
	const plan = W.validatePlan(
		{
			title: 'Kerr quasinormal modes',
			keywords: ['quasinormal modes', 'Kerr black hole'],
			queries: [{ query: '"Kerr" AND (quasinormal modes)', purpose: 'object' }, { query: 'x', purpose: 'too short' }],
			arxiv_categories: ['gr-qc', 'math.NT'],
			named_works: ['Leaver 1985, An analytic representation for the quasi-normal modes of Kerr black holes', 'Teukolsky 1973, Perturbations of a rotating black hole'],
		},
		field,
		brief,
	);
	assert.deepEqual(plan.queries, [{ query: 'Kerr quasinormal modes', purpose: 'object' }]);
	assert.deepEqual(plan.arxivCategories, ['gr-qc']);
	assert.equal(plan.namedWorks.length, 1, 'Teukolsky was never mentioned');
	assert.match(plan.namedWorks[0], /Leaver 1985/);
	const schema = W.searchPlanSchema(field).schema;
	assert.deepEqual(schema.properties.arxiv_categories.items.enum, field.arxiv);
	assert.throws(() => W.validatePlan({ title: 't', queries: [] }, field, brief), /at least one search query/);
});

test('without a model, the plan comes from the brief itself', () => {
	const plan = W.fallbackPlan('Quasinormal modes of Kerr black holes, quasinormal frequencies, overtone spectrum near extremality, continued fraction method.', 'Title', W.FIELDS[0]);
	assert.ok(plan.queries.length >= 1);
	assert.match(plan.queries[0].query, /quasinormal/);
	assert.deepEqual(plan.namedWorks, []);
});

test('screening: every paper rated, in small batches, unrated ones kept', async () => {
	const paper = (t, abstract = 'An abstract.') => ({ source: 'arxiv', id: t, title: t, authors: [], abstract, year: 2020, url: '' });
	const candidates = ['A', 'B', 'C', 'D'].map((t, i) => ({ paper: paper(t, t === 'C' ? '' : 'Abstract.'), similarity: 0.9 - i / 10, foundBy: [] }));
	const model = scripted(['{"ratings":[{"id":1,"score":1,"reason":"r"},{"id":2,"score":3,"reason":"on topic"}]}', '{"ratings":[{"id":1,"score":2,"reason":"near"}]}']);
	const ranked = await W.screenCandidates(model, 'brief', candidates, { batch: 2, limit: 3 });
	assert.deepEqual(ranked.map((c) => [c.paper.title, c.rating]), [['B', 3], ['C', 2], ['A', 1], ['D', undefined]]);
	assert.match(model.sent[1].messages[1].content, /\(no abstract: judge from the title\)/);
	assert.equal(model.sent[0].options.jsonSchema.schema.properties.ratings.minItems, 2, 'the schema demands a rating for every paper');
	assert.match(W.SCREEN_SYSTEM, /missing abstract is not a reason to lower the score/);
	assert.throws(() => W.validateScreen({ ratings: [{ id: 1, score: 9, reason: '' }] }, 1), /rated 0 of the 1/);
	assert.deepEqual([...W.preselect(ranked)], [0, 1]);
	assert.equal(W.preselect(candidates.map((c) => ({ ...c, rating: undefined }))).size, 4, 'unrated: the most similar are ticked');
});

test('writeProject: manuscript with the reading list, journal style, Lean, notebook, README', () => {
	const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'td-wiz-')), 'kerr-qnm');
	try {
		const papers = [
			{ source: 'arxiv', id: '1', arxivId: 'gr-qc/0411025', title: 'Quasinormal modes of Kerr black holes', authors: ['Berti, Emanuele'], abstract: '', year: 2004, url: 'https://arxiv.org/abs/gr-qc/0411025' },
			{ source: 'crossref', id: '2', doi: '10.1098/rspa.1985.0119', title: 'An analytic representation for the quasi-normal modes of Kerr black holes', authors: ['Leaver, E. W.'], abstract: '', year: 1985, journal: 'Proc. R. Soc. A', volume: '402', pages: '285--298', url: '' },
		];
		const plan = { title: 'Kerr quasinormal modes near extremality', keywords: ['quasinormal modes'], queries: [{ query: 'Kerr quasinormal modes', purpose: 'object' }], arxivCategories: ['gr-qc'], namedWorks: [] };
		const written = W.writeProject(
			{ choices, brief: 'Compute Kerr QNMs with Leaver\'s method near extremality.', plan, papers, latexTemplates: path.join(__dirname, '..', 'latex-templates'), journals: require('../data/journals.json'), toolchain: 'leanprover/lean4:v4.36.0' },
			target,
		);
		assert.deepEqual(written.keys.map((k) => k.key), ['berti2004quasinormal', 'leaver1985analytic']);
		const tex = fs.readFileSync(written.manuscript, 'utf8');
		assert.match(tex, /\\begin\{abstract\}\n% Research brief \(from the TheoremDesk startup wizard\):\n% Compute Kerr QNMs/);
		assert.match(tex, /\\nocite\{berti2004quasinormal,leaver1985analytic\}/);
		const bib = fs.readFileSync(written.bib, 'utf8');
		assert.match(bib, /@article\{leaver1985analytic,[\s\S]*journal\s+= \{Proc\. R\. Soc\. A\}/);
		assert.match(bib, /einstein1905/, "the template's own example entries stay, so its example text still compiles");
		// Physics field: Lean on Physlib, pinned to the bundled toolchain.
		const lake = fs.readFileSync(path.join(target, 'lean', 'lakefile.toml'), 'utf8');
		assert.match(lake, /name = "Physlib"[\s\S]*rev = "v4\.36\.0"/);
		assert.match(lake, /name = "KerrQuasinormalModes"/);
		assert.match(fs.readFileSync(path.join(target, 'lean', 'KerrQuasinormalModes', 'Basic.lean'), 'utf8'), /^import Physlib/);
		assert.equal(fs.readFileSync(path.join(target, 'lean', 'lean-toolchain'), 'utf8'), 'leanprover/lean4:v4.36.0\n');
		const nb = JSON.parse(fs.readFileSync(path.join(target, 'notebooks', '01_start.ipynb'), 'utf8'));
		assert.equal(nb.nbformat, 4);
		const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
		assert.match(readme, /## Reading list\n\n1\. Quasinormal modes of Kerr black holes `\\cite\{berti2004quasinormal\}`/);
		const meta = JSON.parse(fs.readFileSync(path.join(target, '.theoremdesk', 'project.json'), 'utf8'));
		assert.equal(meta.choices.fieldId, 'gr-qc');
		assert.match(W.introductionPrompt(written), /manuscript\/main\.tex[\s\S]*edit_file/);
		assert.throws(() => W.writeProject({ choices, brief: 'b', plan, papers: [], latexTemplates: path.join(__dirname, '..', 'latex-templates'), journals: { journals: [] }, toolchain: 't' }, target), /isn't empty/);
		// A mathematics field gets plain Mathlib.
		const math = path.join(path.dirname(target), 'algebra');
		W.writeProject({ choices: { ...choices, fieldId: 'algebra', template: undefined, notebooks: false }, brief: 'b', plan, papers: [], latexTemplates: '', journals: { journals: [] }, toolchain: 'leanprover/lean4:v4.36.0' }, math);
		assert.match(fs.readFileSync(path.join(math, 'lean', 'lakefile.toml'), 'utf8'), /name = "mathlib"[\s\S]*mathlib4\.git/);
		assert.ok(!fs.existsSync(path.join(math, 'manuscript')) && !fs.existsSync(path.join(math, 'notebooks')));
	} finally {
		fs.rmSync(path.dirname(target), { recursive: true, force: true });
	}
});

test('every field and kind points at things that exist', () => {
	const templates = fs.readdirSync(path.join(__dirname, '..', 'latex-templates'));
	for (const k of W.KINDS) {
		assert.ok(templates.includes(k.template), `${k.id}: ${k.template}`);
	}
	const sources = ['arxiv', 'inspire', 'zbmath', 'crossref', 'openalex'];
	for (const f of W.FIELDS) {
		assert.ok(f.arxiv.length > 0 && f.sources.every((s) => sources.includes(s)), f.id);
	}
	for (const j of require('../data/journals.json').journals) {
		assert.ok(templates.includes(j.template), `${j.name}: ${j.template}`);
	}
});

test('Lean library names come from the title\'s content words', () => {
	const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'td-slug-')), 'p');
	try {
		const plan = { title: 'Period of the nonlinear simple pendulum via elliptic integrals', keywords: [], queries: [{ query: 'q', purpose: '' }], arxivCategories: [], namedWorks: [] };
		W.writeProject({ choices: { ...choices, template: undefined, notebooks: false }, brief: 'b', plan, papers: [], latexTemplates: '', journals: { journals: [] }, toolchain: 'leanprover/lean4:v4.36.0' }, target);
		assert.ok(fs.existsSync(path.join(target, 'lean', 'PeriodNonlinearSimple.lean')));
	} finally {
		fs.rmSync(path.dirname(target), { recursive: true, force: true });
	}
});
