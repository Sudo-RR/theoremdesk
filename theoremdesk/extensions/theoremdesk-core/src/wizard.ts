// The startup wizard's work, free of the `vscode` API so it can be tested
// with plain Node: the choices a project is defined by, the prompts that
// check and structure the user's research brief, the literature pipeline
// (plan -> search -> rank -> screen), and writing the project.
//
// Prompting a small local model reliably: every model step has one job,
// short numbered rules, a worked example, and an answer that must match a
// JSON schema (llama.cpp enforces the schema while generating). Every
// answer is validated, and each step has a non-AI fallback, so the wizard
// still works if a model misbehaves or isn't available.

import * as fs from 'fs';
import * as path from 'path';
import { generateProject, listTemplates } from './generator';
import { addToBib, bibtexKey, describe, LiteratureSource, mergeResults, Paper, rankBySimilarity, SourceId, topTerms } from './literature';
import { ChatMessage, ChatOptions, ChatReply } from './llm';
import { applyStyle, Journal } from './refstyle';

// ---------------------------------------------------------------------------
// Choices

export type ProjectKind = 'paper' | 'thesis' | 'talk' | 'formalisation' | 'computation' | 'report';

export const KINDS: { id: ProjectKind; label: string; detail: string; template: string; lean: boolean; notebooks: boolean }[] = [
	{ id: 'paper', label: 'Research paper', detail: 'A manuscript for a journal or arXiv, with notebooks for calculations.', template: 'arxiv-preprint', lean: false, notebooks: true },
	{ id: 'formalisation', label: 'Formalisation in Lean', detail: 'Theorems proved in Lean with Mathlib (or Physlib), with a write-up.', template: 'ams-article', lean: true, notebooks: false },
	{ id: 'computation', label: 'Computation or simulation', detail: 'Notebooks with SymPy, NumPy and SciPy, and a report of the results.', template: 'project-report', lean: false, notebooks: true },
	{ id: 'thesis', label: 'Thesis or dissertation', detail: 'A thesis in your university’s class, or a generic one.', template: 'thesis-generic', lean: false, notebooks: true },
	{ id: 'talk', label: 'Talk', detail: 'Beamer slides.', template: 'beamer-talk', lean: false, notebooks: false },
	{ id: 'report', label: 'Report or notes', detail: 'A project report or lecture notes.', template: 'project-report', lean: false, notebooks: false },
];

export interface Field {
	id: string;
	label: string;
	group: 'Physics' | 'Mathematics' | 'Other';
	/** arXiv categories the search plan may use. */
	arxiv: string[];
	/** Which literature sources suit the field, best first. */
	sources: SourceId[];
	/** Physlib (physics) or plain Mathlib, when the project has Lean. */
	lean: 'physlib' | 'mathlib';
}

const PHYS: SourceId[] = ['arxiv', 'inspire', 'crossref', 'openalex'];
const MATH: SourceId[] = ['arxiv', 'zbmath', 'crossref', 'openalex'];
const GEN: SourceId[] = ['arxiv', 'crossref', 'openalex'];

export const FIELDS: Field[] = [
	{ id: 'hep-th', label: 'High-energy theory, string theory', group: 'Physics', arxiv: ['hep-th', 'gr-qc', 'math-ph'], sources: PHYS, lean: 'physlib' },
	{ id: 'hep-ph', label: 'Particle phenomenology', group: 'Physics', arxiv: ['hep-ph', 'hep-ex', 'hep-th'], sources: PHYS, lean: 'physlib' },
	{ id: 'gr-qc', label: 'General relativity and cosmology', group: 'Physics', arxiv: ['gr-qc', 'astro-ph.CO', 'hep-th'], sources: PHYS, lean: 'physlib' },
	{ id: 'astro-ph', label: 'Astrophysics', group: 'Physics', arxiv: ['astro-ph.CO', 'astro-ph.GA', 'astro-ph.HE', 'astro-ph.SR'], sources: ['arxiv', 'crossref', 'openalex', 'inspire'], lean: 'physlib' },
	{ id: 'quant-ph', label: 'Quantum physics and information', group: 'Physics', arxiv: ['quant-ph', 'cond-mat.str-el', 'math-ph'], sources: GEN, lean: 'physlib' },
	{ id: 'cond-mat', label: 'Condensed matter', group: 'Physics', arxiv: ['cond-mat.str-el', 'cond-mat.stat-mech', 'cond-mat.mes-hall', 'cond-mat.supr-con', 'cond-mat.soft'], sources: GEN, lean: 'physlib' },
	{ id: 'math-ph', label: 'Mathematical physics', group: 'Physics', arxiv: ['math-ph', 'hep-th', 'math.DS'], sources: [...PHYS, 'zbmath'], lean: 'physlib' },
	{ id: 'classical', label: 'Classical mechanics and dynamical systems', group: 'Physics', arxiv: ['nlin.CD', 'math.DS', 'physics.class-ph', 'math-ph'], sources: [...GEN, 'zbmath'], lean: 'physlib' },
	{ id: 'physics-other', label: 'Other physics', group: 'Physics', arxiv: ['physics.gen-ph', 'physics.comp-ph', 'physics.flu-dyn', 'physics.optics'], sources: GEN, lean: 'physlib' },
	{ id: 'algebra', label: 'Algebra and number theory', group: 'Mathematics', arxiv: ['math.NT', 'math.AG', 'math.RA', 'math.GR', 'math.RT'], sources: MATH, lean: 'mathlib' },
	{ id: 'geometry', label: 'Geometry and topology', group: 'Mathematics', arxiv: ['math.DG', 'math.GT', 'math.AT', 'math.SG', 'math.AG'], sources: MATH, lean: 'mathlib' },
	{ id: 'analysis', label: 'Analysis and PDE', group: 'Mathematics', arxiv: ['math.AP', 'math.CA', 'math.FA', 'math.SP'], sources: MATH, lean: 'mathlib' },
	{ id: 'probability', label: 'Probability and statistics', group: 'Mathematics', arxiv: ['math.PR', 'math.ST', 'stat.TH'], sources: MATH, lean: 'mathlib' },
	{ id: 'combinatorics', label: 'Combinatorics and discrete maths', group: 'Mathematics', arxiv: ['math.CO', 'cs.DM'], sources: MATH, lean: 'mathlib' },
	{ id: 'logic', label: 'Logic, foundations, formal proof', group: 'Mathematics', arxiv: ['math.LO', 'cs.LO'], sources: MATH, lean: 'mathlib' },
	{ id: 'numerical', label: 'Numerical analysis and scientific computing', group: 'Mathematics', arxiv: ['math.NA', 'physics.comp-ph'], sources: MATH, lean: 'mathlib' },
	{ id: 'math-other', label: 'Other mathematics', group: 'Mathematics', arxiv: ['math.GM', 'math.HO'], sources: MATH, lean: 'mathlib' },
];

export interface WizardChoices {
	kind: ProjectKind;
	fieldId: string;
	title: string;
	author: string;
	/** A LaTeX template id (latex-templates/), or none. */
	template?: string;
	/** A journal name from data/journals.json, to set the reference style. */
	journal?: string;
	lean: boolean;
	notebooks: boolean;
	git: boolean;
}

// ---------------------------------------------------------------------------
// Talking to a model

export interface JsonModel {
	readonly model: string;
	chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatReply>;
}

/** The JSON object in a reply, even if a model wrapped it in prose or a code fence. */
export function parseJsonObject(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	try {
		return JSON.parse(trimmed);
	} catch {
		const start = trimmed.indexOf('{');
		const end = trimmed.lastIndexOf('}');
		if (start >= 0 && end > start) {
			return JSON.parse(trimmed.slice(start, end + 1));
		}
		throw new Error('the model did not answer with JSON');
	}
}

/**
 * Ask for JSON matching a schema, validate it, and if it doesn't validate
 * ask once more, telling the model what was wrong.
 */
export async function askJson<T>(model: JsonModel, messages: ChatMessage[], schema: { name: string; schema: object }, validate: (value: unknown) => T, options: { maxTokens?: number; signal?: AbortSignal } = {}): Promise<T> {
	const opts: ChatOptions = { temperature: 0.2, thinking: false, maxTokens: options.maxTokens ?? 1200, jsonSchema: schema, signal: options.signal };
	const first = await model.chat(messages, opts);
	try {
		return validate(parseJsonObject(first.content));
	} catch (error) {
		const retry = await model.chat(
			[...messages, { role: 'assistant', content: first.content }, { role: 'user', content: `That answer was not usable: ${(error as Error).message}. Answer again with only the JSON object, following the schema and the rules.` }],
			opts,
		);
		return validate(parseJsonObject(retry.content));
	}
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter(isStr).map((s) => s.trim()).filter(Boolean).slice(0, max) : []);

function fieldOf(choices: Pick<WizardChoices, 'fieldId'>): Field {
	return FIELDS.find((f) => f.id === choices.fieldId) ?? FIELDS[FIELDS.length - 1];
}

function context(choices: Pick<WizardChoices, 'kind' | 'fieldId'>): string {
	const kind = KINDS.find((k) => k.id === choices.kind)?.label ?? choices.kind;
	return `Project type: ${kind}. Field: ${fieldOf(choices).label}.`;
}

// ---------------------------------------------------------------------------
// Step 1: is the brief clear enough to search with?

export const BRIEF_CRITERIA = ['object', 'question', 'approach', 'scope'] as const;
export type BriefCriterion = (typeof BRIEF_CRITERIA)[number];

export interface BriefReview {
	clear: boolean;
	missing: BriefCriterion[];
	/** At most three short questions, each about one missing item. */
	questions: string[];
	/** The topic restated in one sentence, in the user's own terms. */
	summary: string;
}

export const BRIEF_REVIEW_SYSTEM = `You review a short research brief written by a mathematician or physicist, before a literature search. Decide whether it says enough to find the right papers.

A clear brief states:
1. object: what is studied (a system, structure, equation or conjecture).
2. question: what the author wants to find out, prove, compute or build.
3. approach: how (method, technique, tools), if the author knows.
4. scope: the setting or limits (dimension, regime, assumptions, which case).

Rules:
- Judge only what is written. Do not guess what the author meant.
- A brief is clear when object and question are both present and specific. approach and scope help but are optional.
- Ask at most 3 questions, one per missing item, most important first. Each question is one short sentence the author can answer in a line, uses the author's own terms, and offers examples in brackets when that helps.
- If the brief is clear, ask no questions.
- summary: restate the topic in one sentence using only the author's information. Add no facts, results or references.`;

const REVIEW_EXAMPLE: ChatMessage[] = [
	{ role: 'user', content: 'Project type: Research paper. Field: General relativity and cosmology.\n\nBrief:\nI want to look at black hole stuff with numerical methods.' },
	{
		role: 'assistant',
		content: JSON.stringify({
			clear: false,
			missing: ['object', 'question', 'scope'],
			questions: [
				'Which black holes or spacetimes (for example Schwarzschild, Kerr, binary mergers)?',
				'What do you want to compute or find out about them (for example quasinormal modes, shadows, waveforms)?',
				'Which regime or assumptions (for example linear perturbations, full nonlinear evolution, a given spin range)?',
			],
			summary: 'A numerical study of black holes.',
		}),
	},
];

export const BRIEF_REVIEW_SCHEMA = {
	name: 'brief_review',
	schema: {
		type: 'object',
		properties: {
			clear: { type: 'boolean' },
			missing: { type: 'array', items: { type: 'string', enum: [...BRIEF_CRITERIA] }, maxItems: 4 },
			questions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
			summary: { type: 'string' },
		},
		required: ['clear', 'missing', 'questions', 'summary'],
		additionalProperties: false,
	},
};

export function validateReview(v: unknown): BriefReview {
	const o = v as Record<string, unknown>;
	if (!o || typeof o.clear !== 'boolean' || !isStr(o.summary)) {
		throw new Error('it needs clear (true or false) and a summary');
	}
	const missing = strings(o.missing, 4).filter((m): m is BriefCriterion => (BRIEF_CRITERIA as readonly string[]).includes(m));
	const questions = o.clear ? [] : strings(o.questions, 3);
	if (!o.clear && questions.length === 0) {
		throw new Error('an unclear brief needs at least one question');
	}
	return { clear: o.clear, missing, questions, summary: o.summary.trim() };
}

/** The brief with the author's answers to the review's questions. */
export function fullBrief(brief: string, answers: { question: string; answer: string }[] = []): string {
	const answered = answers.filter((a) => a.answer.trim());
	return answered.length ? `${brief.trim()}\n\n${answered.map((a) => `${a.question}\n${a.answer.trim()}`).join('\n\n')}` : brief.trim();
}

export function reviewBrief(model: JsonModel, choices: Pick<WizardChoices, 'kind' | 'fieldId'>, brief: string, signal?: AbortSignal): Promise<BriefReview> {
	return askJson(
		model,
		[{ role: 'system', content: BRIEF_REVIEW_SYSTEM }, ...REVIEW_EXAMPLE, { role: 'user', content: `${context(choices)}\n\nBrief:\n${brief.trim()}` }],
		BRIEF_REVIEW_SCHEMA,
		validateReview,
		{ maxTokens: 600, signal },
	);
}

// ---------------------------------------------------------------------------
// Step 2: a search plan

export interface SearchQuery {
	query: string;
	purpose: string;
}

export interface SearchPlan {
	title: string;
	keywords: string[];
	queries: SearchQuery[];
	arxivCategories: string[];
	/** Works the author named themselves, to look up directly. */
	namedWorks: string[];
}

export const SEARCH_PLAN_SYSTEM = `You turn a research brief into a literature search plan for arXiv, INSPIRE-HEP, zbMATH, Crossref and OpenAlex.

Rules:
1. title: a working title for the project, at most 12 words, in the field's usual style.
2. keywords: 4 to 8 technical terms exactly as papers in the field write them (for example "quasinormal modes", not "how black holes ring").
3. queries: 3 to 5 search phrases of 2 to 6 words each, as you would type them into a paper search. Each covers a different part of the brief: the main object, the method, the question, and closely related known results. No boolean operators, quotes, author names or years.
4. purpose: for each query, a few words on which part of the brief it covers.
5. arxiv_categories: 1 to 3 categories, chosen only from the allowed list given.
6. named_works: papers, books or arXiv IDs the author explicitly named in the brief, copied exactly. If none, give an empty list. Never add works the author did not name.
7. Use only the brief. Do not invent results, authors or references.`;

const PLAN_EXAMPLE: ChatMessage[] = [
	{
		role: 'user',
		content:
			'Project type: Research paper. Field: Classical mechanics and dynamical systems.\nAllowed arXiv categories: nlin.CD, math.DS, physics.class-ph, math-ph\n\nBrief:\nI want to prove that the double pendulum is chaotic for energies above some threshold, by computing Lyapunov exponents numerically and checking against a Melnikov-type argument. I would build on Shinbrot et al. 1992 on the double pendulum experiment.',
	},
	{
		role: 'assistant',
		content: JSON.stringify({
			title: 'Onset of chaos in the double pendulum: Lyapunov exponents and Melnikov analysis',
			keywords: ['double pendulum', 'Lyapunov exponent', 'Melnikov method', 'Hamiltonian chaos', 'homoclinic orbit', 'energy threshold'],
			queries: [
				{ query: 'double pendulum chaos', purpose: 'the main object' },
				{ query: 'Lyapunov exponents Hamiltonian systems', purpose: 'the numerical method' },
				{ query: 'Melnikov method homoclinic chaos', purpose: 'the analytic argument' },
				{ query: 'double pendulum energy threshold chaos', purpose: 'the question' },
			],
			arxiv_categories: ['nlin.CD', 'math.DS'],
			named_works: ['Shinbrot et al. 1992, double pendulum experiment'],
		}),
	},
];

export function searchPlanSchema(field: Field) {
	return {
		name: 'search_plan',
		schema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				keywords: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
				queries: {
					type: 'array',
					items: { type: 'object', properties: { query: { type: 'string' }, purpose: { type: 'string' } }, required: ['query', 'purpose'], additionalProperties: false },
					minItems: 1,
					maxItems: 5,
				},
				arxiv_categories: { type: 'array', items: { type: 'string', enum: field.arxiv }, maxItems: 3 },
				named_works: { type: 'array', items: { type: 'string' }, maxItems: 10 },
			},
			required: ['title', 'keywords', 'queries', 'arxiv_categories', 'named_works'],
			additionalProperties: false,
		},
	};
}

export function validatePlan(v: unknown, field: Field, brief: string): SearchPlan {
	const o = v as Record<string, unknown>;
	if (!o || !isStr(o.title)) {
		throw new Error('it needs a title');
	}
	const queries = (Array.isArray(o.queries) ? o.queries : [])
		.map((q) => ({ query: isStr(q?.query) ? q.query.replace(/["()]|\b(AND|OR|NOT)\b/g, ' ').replace(/\s+/g, ' ').trim() : '', purpose: isStr(q?.purpose) ? q.purpose.trim() : '' }))
		.filter((q) => q.query.split(' ').length >= 1 && q.query.length >= 3)
		.slice(0, 5);
	if (queries.length === 0) {
		throw new Error('it needs at least one search query');
	}
	// Named works must actually appear in the brief: drop anything the model made up.
	const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
	const briefWords = new Set(words(brief));
	const namedWorks = strings(o.named_works, 10).filter((w) => {
		const ws = words(w);
		return ws.length > 0 && ws.filter((x) => briefWords.has(x)).length / ws.length >= 0.6;
	});
	return {
		title: o.title.trim().split(/\s+/).slice(0, 16).join(' '),
		keywords: strings(o.keywords, 8),
		queries,
		arxivCategories: strings(o.arxiv_categories, 3).filter((c) => field.arxiv.includes(c)),
		namedWorks,
	};
}

/** A plan without a model: the brief's most frequent terms. */
export function fallbackPlan(brief: string, title: string, field: Field): SearchPlan {
	const terms = topTerms(brief, 8);
	const queries = [terms.slice(0, 3), terms.slice(3, 6), [terms[0], ...terms.slice(6, 8)]]
		.filter((q) => q.length && q.every(Boolean))
		.map((q, i) => ({ query: q.join(' '), purpose: i === 0 ? 'the main terms of the brief' : 'more terms from the brief' }));
	return { title, keywords: terms, queries: queries.length ? queries : [{ query: brief.slice(0, 60), purpose: 'the brief' }], arxivCategories: field.arxiv.slice(0, 1), namedWorks: [] };
}

export async function planSearch(model: JsonModel, choices: Pick<WizardChoices, 'kind' | 'fieldId'>, brief: string, signal?: AbortSignal): Promise<SearchPlan> {
	const field = fieldOf(choices);
	return askJson(
		model,
		[
			{ role: 'system', content: SEARCH_PLAN_SYSTEM },
			...PLAN_EXAMPLE,
			{ role: 'user', content: `${context(choices)}\nAllowed arXiv categories: ${field.arxiv.join(', ')}\n\nBrief:\n${brief.trim()}` },
		],
		searchPlanSchema(field),
		(v) => validatePlan(v, field, brief),
		{ maxTokens: 900, signal },
	);
}

// ---------------------------------------------------------------------------
// Step 3: find candidates and rank them

export interface Embedder {
	embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
}

export interface Candidate {
	paper: Paper;
	/** Similarity of the paper to the brief (0-1). */
	similarity: number;
	/** The model's rating, when screened: 3 on topic ... 0 unrelated. */
	rating?: number;
	reason?: string;
	/** Which queries found it. */
	foundBy: string[];
}

/**
 * Run every query on the field's sources, merge the results, drop papers
 * without an abstract or title, and rank by similarity to the brief: with
 * the embedding model when given, else by word overlap (TF-IDF).
 */
export async function findCandidates(
	sources: LiteratureSource[],
	plan: SearchPlan,
	brief: string,
	options: { perQuery?: number; limit?: number; embedder?: Embedder; embedQuery?: (q: string) => string; onProgress?: (message: string) => void; signal?: AbortSignal } = {},
): Promise<{ candidates: Candidate[]; errors: string[] }> {
	const lists: Paper[][] = [];
	const foundBy = new Map<string, Set<string>>();
	const errors: string[] = [];
	const key = (p: Paper) => (p.doi ? `doi:${p.doi.toLowerCase()}` : p.arxivId ? `arxiv:${p.arxivId}` : `t:${p.title.toLowerCase()}`);
	for (const q of plan.queries) {
		options.onProgress?.(`Searching for "${q.query}"`);
		const results = await Promise.all(
			sources.map((s) =>
				s.search(q.query, { maxResults: options.perQuery ?? 12, category: s.id === 'arxiv' && plan.arxivCategories.length === 1 ? plan.arxivCategories[0] : undefined }).catch((e: unknown) => {
					errors.push(`${s.name}: ${e instanceof Error ? e.message : String(e)}`);
					return [] as Paper[];
				}),
			),
		);
		for (const list of results) {
			for (const p of list) {
				(foundBy.get(key(p)) ?? foundBy.set(key(p), new Set()).get(key(p))!).add(q.query);
			}
			lists.push(list);
		}
	}
	const merged = mergeResults(lists).filter((p) => p.title && p.title.length > 3);
	let ranked: { paper: Paper; score: number }[];
	if (options.embedder && merged.length) {
		options.onProgress?.(`Ranking ${merged.length} papers by meaning`);
		const [q, ...docs] = await options.embedder.embed([options.embedQuery ? options.embedQuery(brief) : brief, ...merged.map((p) => `${p.title}\n${p.abstract.slice(0, 1500)}`)], options.signal);
		ranked = merged.map((paper, i) => ({ paper, score: docs[i].reduce((s, x, d) => s + x * q[d], 0) })).sort((a, b) => b.score - a.score);
	} else {
		ranked = rankBySimilarity(brief, merged);
	}
	const candidates = ranked.slice(0, options.limit ?? 30).map(({ paper, score }) => {
		const by = new Set<string>();
		for (const k of [paper.doi ? `doi:${paper.doi.toLowerCase()}` : '', paper.arxivId ? `arxiv:${paper.arxivId}` : '', `t:${paper.title.toLowerCase()}`]) {
			foundBy.get(k)?.forEach((x) => by.add(x));
		}
		return { paper, similarity: score, foundBy: [...by] };
	});
	return { candidates, errors: [...new Set(errors)] };
}

// ---------------------------------------------------------------------------
// Step 4: the model screens candidates against the brief

export const SCREEN_SYSTEM = `You help a researcher choose papers for the reading list of a new project. For each numbered paper, rate how useful it is for the research in the brief:
3 = directly on the topic of the brief
2 = closely related: the same object, method or question in a nearby setting
1 = background: useful context only
0 = not relevant

Rules:
- Judge only from the title and abstract given. Do not use other knowledge about the paper or its authors.
- If a paper has no abstract, judge it from its title alone, as if the title were the abstract. A missing abstract is not a reason to lower the score.
- reason: at most 12 words, saying what in the abstract connects (or doesn't) to the brief.
- Rate every paper exactly once, using its number as id.`;

export function screenSchema(n: number) {
	return {
		name: 'screening',
		schema: {
			type: 'object',
			properties: {
				ratings: {
					type: 'array',
					items: {
						type: 'object',
						properties: { id: { type: 'integer', minimum: 1, maximum: n }, score: { type: 'integer', minimum: 0, maximum: 3 }, reason: { type: 'string' } },
						required: ['id', 'score', 'reason'],
						additionalProperties: false,
					},
					minItems: n,
					maxItems: n,
				},
			},
			required: ['ratings'],
			additionalProperties: false,
		},
	};
}

export function validateScreen(v: unknown, n: number): Map<number, { score: number; reason: string }> {
	const ratings = (v as { ratings?: unknown })?.ratings;
	if (!Array.isArray(ratings)) {
		throw new Error('it needs a ratings list');
	}
	const out = new Map<number, { score: number; reason: string }>();
	for (const r of ratings) {
		const id = Number(r?.id);
		const score = Number(r?.score);
		if (Number.isInteger(id) && id >= 1 && id <= n && Number.isInteger(score) && score >= 0 && score <= 3 && !out.has(id)) {
			out.set(id, { score, reason: isStr(r?.reason) ? r.reason.trim().split(/\s+/).slice(0, 20).join(' ') : '' });
		}
	}
	if (out.size < n) {
		throw new Error(`it rated ${out.size} of the ${n} papers; rate every one`);
	}
	return out;
}

/** Rate candidates in small batches, so a small model keeps each abstract in view. */
export async function screenCandidates(
	model: JsonModel,
	brief: string,
	candidates: Candidate[],
	options: { batch?: number; limit?: number; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<Candidate[]> {
	const size = options.batch ?? 5;
	// Only the most similar are read: a small model takes about 10 s a paper on a laptop.
	const toScreen = candidates.slice(0, options.limit ?? candidates.length);
	for (let i = 0; i < toScreen.length; i += size) {
		const batch = toScreen.slice(i, i + size);
		const papers = batch
			.map((c, j) => `[${j + 1}] ${c.paper.title} (${c.paper.year || 'n.d.'})\n${c.paper.abstract ? c.paper.abstract.slice(0, 900) : '(no abstract: judge from the title)'}`)
			.join('\n\n');
		try {
			const ratings = await askJson(
				model,
				[{ role: 'system', content: SCREEN_SYSTEM }, { role: 'user', content: `Brief:\n${brief.trim()}\n\nPapers:\n\n${papers}` }],
				screenSchema(batch.length),
				(v) => validateScreen(v, batch.length),
				{ maxTokens: 70 * batch.length + 80, signal: options.signal },
			);
			batch.forEach((c, j) => Object.assign(c, { rating: ratings.get(j + 1)!.score, reason: ratings.get(j + 1)!.reason }));
		} catch (error) {
			if (options.signal?.aborted) {
				throw error;
			}
			// Leave this batch unrated; similarity still orders it.
		}
		options.onProgress?.(Math.min(i + size, toScreen.length), toScreen.length);
	}
	return [...candidates].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.similarity - a.similarity);
}

/** Which candidates to tick by default: rated 2 or 3, or (unrated) the most similar. */
export function preselect(candidates: Candidate[], max = 12): Set<number> {
	const rated = candidates.some((c) => c.rating !== undefined);
	const picks = candidates
		.map((c, i) => ({ c, i }))
		.filter(({ c }) => (rated ? (c.rating ?? 0) >= 2 : true))
		.slice(0, rated ? max : Math.min(8, max));
	return new Set(picks.map((p) => p.i));
}

// ---------------------------------------------------------------------------
// Step 5: write the project

export interface ProjectSpec {
	choices: WizardChoices;
	brief: string;
	review?: BriefReview;
	plan: SearchPlan;
	papers: Paper[];
	/** Folders for the templates. */
	latexTemplates: string;
	journals: { journals: Journal[] };
	toolchain: string;
}

export interface WrittenProject {
	files: string[];
	manuscript?: string;
	bib?: string;
	keys: { key: string; title: string }[];
}

function slug(s: string): string {
	return (
		s
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/[^A-Za-z0-9]+/g, ' ')
			.trim()
			.split(/\s+/)
			// Lean library names from the title's content words: "Period of the nonlinear..." -> PeriodNonlinearSimple.
			.filter((w, i, all) => !/^(a|an|the|of|on|in|for|with|via|and|or|to|from|by|at|its|using)$/i.test(w) || all.length <= 1)
			.slice(0, 3)
			.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
			.join('') || 'Project'
	);
}

/** LaTeX-safe text for a comment line or a title. */
function texComment(s: string): string {
	return s.replace(/\r?\n/g, '\n% ');
}

export function writeProject(spec: ProjectSpec, target: string): WrittenProject {
	if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
		throw new Error(`${target} already exists and isn't empty.`);
	}
	const { choices, plan } = spec;
	const field = fieldOf(choices);
	const files: string[] = [];
	const write = (rel: string, text: string) => {
		const file = path.join(target, rel);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, text);
		files.push(rel.replace(/\\/g, '/'));
	};
	fs.mkdirSync(target, { recursive: true });

	// The manuscript, with the chosen papers in its bibliography.
	let manuscript: string | undefined;
	let bib: string | undefined;
	const keys: { key: string; title: string }[] = [];
	if (choices.template) {
		const template = listTemplates(spec.latexTemplates).find((t) => t.id === choices.template);
		if (!template) {
			throw new Error(`there's no LaTeX template ${choices.template}`);
		}
		const dir = path.join(target, 'manuscript');
		generateProject(template, dir, { PROJECT_NAME: path.basename(target), PROJECT_TITLE: choices.title, AUTHOR: choices.author, YEAR: String(new Date().getFullYear()) }).forEach((f) =>
			files.push(`manuscript/${f.replace(/\\/g, '/')}`),
		);
		manuscript = path.join(dir, 'main.tex');
		bib = path.join(dir, 'references.bib');
		let bibText = fs.existsSync(bib) ? fs.readFileSync(bib, 'utf8') : '';
		for (const paper of spec.papers) {
			const result = addToBib(bibText, paper);
			bibText = result.text;
			keys.push({ key: result.key, title: paper.title });
		}
		fs.writeFileSync(bib, bibText);
		if (!files.includes('manuscript/references.bib')) {
			files.push('manuscript/references.bib');
		}
		let tex = fs.readFileSync(manuscript, 'utf8');
		// The brief, where the author will write the abstract.
		const note = `% Research brief (from the TheoremDesk startup wizard):\n% ${texComment(fullBriefText(spec))}\n`;
		tex = /\\begin\{abstract\}/.test(tex) ? tex.replace(/\\begin\{abstract\}\n?/, (m) => `${m}${note}`) : tex.replace(/\\begin\{document\}\n?/, (m) => `${m}${note}`);
		// The reading list, in the bibliography until each paper is cited.
		if (keys.length && /\\bibliography\{/.test(tex)) {
			tex = tex.replace(/(\n[^\n]*\\bibliographystyle|\n[^\n]*\\bibliography\{)/, (m) => `\n% Papers chosen in the startup wizard: they appear in the bibliography until you cite them.\n\\nocite{${keys.map((k) => k.key).join(',')}}${m}`);
		}
		const journal = spec.journals.journals.find((j) => j.name === choices.journal);
		if (journal) {
			tex = applyStyle(tex, journal.bibstyle, { natbib: journal.natbib, journal }).tex;
		}
		fs.writeFileSync(manuscript, tex);
	}

	// Lean, with Physlib for physics and Mathlib for mathematics, pinned to the bundled Lean.
	if (choices.lean) {
		const lib = slug(plan.title);
		const rev = spec.toolchain.split(':')[1] ?? 'v4.36.0';
		const dep = field.lean === 'physlib' ? { name: 'Physlib', git: 'https://github.com/leanprover-community/physlib.git' } : { name: 'mathlib', git: 'https://github.com/leanprover-community/mathlib4.git' };
		write('lean/lean-toolchain', `${spec.toolchain}\n`);
		write(
			'lean/lakefile.toml',
			`name = "${lib}"\ndefaultTargets = ["${lib}"]\n\n# ${dep.name} release tags match Lean versions: keep rev and lean-toolchain in step.\n[[require]]\nname = "${dep.name}"\ngit = "${dep.git}"\nrev = "${rev}"\n\n[[lean_lib]]\nname = "${lib}"\n\n# Proof attempts (yours or the agent's), outside the default build.\n[[lean_lib]]\nname = "Attempts"\nglobs = ["Attempts.+"]\n`,
		);
		write(`lean/${lib}.lean`, `import ${lib}.Basic\n`);
		write(
			`lean/${lib}/Basic.lean`,
			`${field.lean === 'physlib' ? 'import Physlib' : 'import Mathlib'}\n\n/-!\n# ${plan.title}\n\n${fullBriefText(spec)}\n\nState the main results here as theorems. Leave a proof as \`sorry\` until it's done:\nTheoremDesk's checks report every \`sorry\`, and a proof attempt can go in \`Attempts/\`.\n-/\n\nnamespace ${lib}\n\nend ${lib}\n`,
		);
		write('lean/Attempts/README.md', 'Proof attempts, one file per attempt. Check one against the statements with **Check Proof Against Statement** on the Run button.\n');
	}

	// A first notebook, with the project's tools imported.
	if (choices.notebooks) {
		const cell = (type: 'markdown' | 'code', source: string) => ({ cell_type: type, metadata: {}, source: source.split(/(?<=\n)/), ...(type === 'code' ? { execution_count: null, outputs: [] } : {}) });
		write(
			'notebooks/01_start.ipynb',
			JSON.stringify(
				{
					cells: [
						cell('markdown', `# ${plan.title}\n\n${fullBriefText(spec)}`),
						cell('code', 'import sympy as sp\nimport numpy as np\nimport scipy as sc\nimport matplotlib.pyplot as plt\n\nsp.init_printing()'),
					],
					metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
					nbformat: 4,
					nbformat_minor: 5,
				},
				null,
				1,
			) + '\n',
		);
	}

	// What the project is, for the author and the agent.
	const reading = keys.length
		? keys.map((k, i) => `${i + 1}. ${k.title} \`\\cite{${k.key}}\``).join('\n')
		: spec.papers.map((p, i) => `${i + 1}. ${describe(p, 0).split('\n')[0]}`).join('\n') || '(none chosen yet)';
	write(
		'README.md',
		`# ${choices.title}\n\n${choices.author ? `${choices.author}\n\n` : ''}## Research brief\n\n${fullBriefText(spec)}\n\n## Search plan\n\nKeywords: ${plan.keywords.join(', ') || '(none)'}\n\n${plan.queries.map((q) => `- "${q.query}" (${q.purpose})`).join('\n')}\n\n## Reading list\n\n${reading}\n\n## Layout\n\n${[
			manuscript ? '- `manuscript/`: the LaTeX source; `references.bib` holds the reading list.' : '',
			choices.lean ? `- \`lean/\`: the Lean project (${field.lean === 'physlib' ? 'Physlib, which brings Mathlib' : 'Mathlib'}). The first build downloads ${field.lean === 'physlib' ? 'Physlib and ' : ''}Mathlib's prebuilt files.` : '',
			choices.notebooks ? '- `notebooks/`: Jupyter notebooks with SymPy, NumPy and SciPy.' : '',
		]
			.filter(Boolean)
			.join('\n')}\n\n## Next steps\n\n- Read the papers (the Library view holds their full text, and **Ask the Library** answers questions from them).\n- Ask the agent to draft the introduction from the reading list.\n${choices.lean ? '- State the main theorems in Lean.\n' : ''}`,
	);
	write(
		'.theoremdesk/project.json',
		JSON.stringify({ version: 1, created: new Date().toISOString(), choices, brief: spec.brief, review: spec.review, plan, papers: keys }, null, 1) + '\n',
	);
	write('.gitignore', ['.lake/', '*.aux', '*.log', '*.out', '*.bbl', '*.blg', '*.synctex.gz', '*.fdb_latexmk', '*.fls', '.ipynb_checkpoints/', '__pycache__/', '.venv/'].join('\n') + '\n');
	return { files, manuscript, bib, keys };
}

function fullBriefText(spec: Pick<ProjectSpec, 'brief'>): string {
	return spec.brief.trim().replace(/\s+\n/g, '\n');
}

/** The agent's first task in the new project: a draft introduction from the reading list. */
export function introductionPrompt(written: WrittenProject): string {
	return `Draft an introduction section for this project in ${written.manuscript ? path.basename(path.dirname(written.manuscript)) + '/main.tex' : 'README.md'}. Use the research brief in README.md, and cite papers from the reading list with \\cite{key} using the keys in README.md, only where their abstracts support what you write (search_library and search_literature can show them). Mark anything you're unsure of with % TODO. Propose the change with edit_file so I can review it.`;
}

/** Make a bibtex key preview for the paper list (same as addToBib would choose). */
export function previewKey(paper: Paper, taken: Set<string>): string {
	return paper.texkey ?? bibtexKey(paper, taken);
}
