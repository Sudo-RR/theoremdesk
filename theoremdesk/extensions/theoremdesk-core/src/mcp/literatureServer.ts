#!/usr/bin/env node
// TheoremDesk's literature MCP server: search across arXiv, INSPIRE-HEP,
// zbMATH Open, Crossref and OpenAlex, recommendations for a project, BibTeX
// entries, and adding them to a .bib file. Agents (Codex, Claude Code, VS
// Code's agent mode, ...) use it over stdio.
//
// Run with any Node, or with TheoremDesk's own runtime:
//   ELECTRON_RUN_AS_NODE=1 TheoremDesk out/mcp/literatureServer.js
//
// Implements the MCP tools protocol (newline-delimited JSON-RPC 2.0 on
// stdin/stdout) without dependencies, so it ships inside the extension.
//
// THEOREMDESK_LITERATURE_SOURCES=arxiv,inspire,... picks the sources (default all).
// For tests: THEOREMDESK_LITERATURE_FIXTURES=<folder> answers every request
// from recorded responses; THEOREMDESK_ARXIV_FIXTURE=<file> answers arXiv
// requests from one file and uses arXiv alone.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fixtureFetch } from '../fixtureFetch';
import { addToBib, bestForBibliography, bibtexFor, describe, FetchText, LiteratureSource, Paper, recommend, SourceId } from '../literature';
import { ALL_SOURCES, ArxivSource, createSources, lookupPaper, searchAll } from '../sources';

const VERSION = '0.2.0';
const PROTOCOL = '2025-06-18';

const arxivFixture = process.env.THEOREMDESK_ARXIV_FIXTURE;
const fixtures = process.env.THEOREMDESK_LITERATURE_FIXTURES;
const fetchText: FetchText | undefined = arxivFixture
	? async () => fs.readFileSync(arxivFixture, 'utf8')
	: fixtures
		? fixtureFetch(fixtures)
		: undefined;
const chosen = (process.env.THEOREMDESK_LITERATURE_SOURCES ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter((s): s is SourceId => (ALL_SOURCES as string[]).includes(s));
const sources: LiteratureSource[] = arxivFixture
	? [new ArxivSource(fetchText, 0)]
	: createSources(chosen.length > 0 ? chosen : ALL_SOURCES, fetchText);
const arxiv = (sources.find((s) => s.id === 'arxiv') as ArxivSource | undefined) ?? new ArxivSource(fetchText, fixtures ? 0 : undefined);

interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: object;
	run(args: Record<string, unknown>): Promise<string>;
}

const str = (v: unknown, name: string): string => {
	if (typeof v !== 'string' || v.trim() === '') {
		throw new Error(`${name} is required`);
	}
	return v;
};
const num = (v: unknown, fallback: number, max: number) => (typeof v === 'number' && v > 0 ? Math.min(Math.floor(v), max) : fallback);
const readIfExists = (file: string | undefined) => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const list = (papers: Paper[]) => (papers.length === 0 ? 'No papers found.' : papers.map((p, i) => `${i + 1}. ${describe(p)}`).join('\n\n'));

/** The sources an agent asked for, or all enabled ones. */
function pickSources(value: unknown): LiteratureSource[] {
	if (!Array.isArray(value) || value.length === 0) {
		return sources;
	}
	const picked = sources.filter((s) => value.includes(s.id));
	if (picked.length === 0) {
		throw new Error(`sources must be some of: ${sources.map((s) => s.id).join(', ')}`);
	}
	return picked;
}

/** A paper by arXiv ID or DOI (identifier; arxiv_id for older clients), at its best for citing. */
async function findPaper(args: Record<string, unknown>): Promise<Paper> {
	const identifier = str(args.identifier ?? args.arxiv_id ?? args.doi, 'identifier');
	const paper = await lookupPaper(sources, identifier);
	if (!paper || !paper.title) {
		throw new Error(`No source has a paper ${identifier}. Give an arXiv ID (1706.03762, hep-th/9711200) or a DOI (10.1103/...).`);
	}
	return bestForBibliography(paper, sources);
}

const identifierSchema = {
	identifier: {
		type: 'string',
		description: 'An arXiv ID (1706.03762, hep-th/9711200), a DOI (10.1103/PhysRevLett.116.061102), or an arxiv.org or doi.org link',
	},
};

const tools: Tool[] = [
	{
		name: 'search_literature',
		title: 'Search the literature',
		description:
			'Search arXiv, INSPIRE-HEP (high-energy physics), zbMATH Open (mathematics), Crossref (journal articles) and OpenAlex at once. Results are merged: each paper appears once, with its journal, DOI, arXiv ID, INSPIRE key, zbMATH ID and citation count where known.',
		inputSchema: {
			type: 'object',
			properties: {
				query: {
					type: 'string',
					description: 'Title words, authors or topics, e.g. "large N superconformal supergravity" or "Bender pendulum complex trajectories"',
				},
				sources: {
					type: 'array',
					items: { type: 'string', enum: ALL_SOURCES },
					description: 'Which sources to search (default: all). inspire suits high-energy physics, zbmath mathematics.',
				},
				max_results: { type: 'number', description: 'How many papers (default 10, at most 50)' },
				sort: { type: 'string', enum: ['relevance', 'recent', 'cited'], description: 'relevance (default), recent, or cited' },
			},
			required: ['query'],
		},
		async run(args) {
			const sort = args.sort === 'recent' || args.sort === 'cited' ? args.sort : 'relevance';
			const { papers, errors } = await searchAll(pickSources(args.sources), str(args.query, 'query'), {
				maxResults: num(args.max_results, 10, 50),
				sort,
			});
			const failed = errors.length > 0 ? `\n\n(Not reached: ${errors.map((e) => `${e.source}: ${e.message}`).join('; ')})` : '';
			if (papers.length === 0 && errors.length > 0) {
				throw new Error(`No source could be reached.${failed}`);
			}
			return list(papers) + failed;
		},
	},
	{
		name: 'search_arxiv',
		title: 'Search arXiv',
		description:
			'Search arXiv alone, with its own syntax: plain words must all appear; field syntax also works (ti:, au:, abs:, cat:, AND, OR). Returns title, authors, year, arXiv ID, link and the start of the abstract for each paper.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search terms, e.g. "hamiltonian pendulum integrability" or "au:maldacena AND ti:large"' },
				max_results: { type: 'number', description: 'How many papers (default 10, at most 50)' },
				category: { type: 'string', description: 'Limit to an arXiv category, e.g. math-ph, hep-th, quant-ph' },
				sort: { type: 'string', enum: ['relevance', 'recent'], description: 'relevance (default) or recent' },
			},
			required: ['query'],
		},
		async run(args) {
			return list(
				await arxiv.search(str(args.query, 'query'), {
					maxResults: num(args.max_results, 10, 50),
					category: typeof args.category === 'string' ? args.category : undefined,
					sort: args.sort === 'recent' ? 'recent' : 'relevance',
				}),
			);
		},
	},
	{
		name: 'recommend_papers',
		title: 'Recommend papers for a project',
		description:
			'Recommend papers related to a manuscript: takes the main terms from its title, abstract and text (and the titles in its .bib), searches the sources, adds works OpenAlex relates to the papers already cited, ranks by similarity, and leaves out papers already in the bibliography.',
		inputSchema: {
			type: 'object',
			properties: {
				tex_file: { type: 'string', description: 'Path to the manuscript (.tex)' },
				text: { type: 'string', description: 'Or: text describing the research, instead of a .tex file' },
				bib_file: { type: 'string', description: 'Path to the project .bib file, to skip papers already cited and find related work' },
				max_results: { type: 'number', description: 'How many papers (default 10, at most 30)' },
			},
		},
		async run(args) {
			const tex = typeof args.text === 'string' ? args.text : readIfExists(typeof args.tex_file === 'string' ? args.tex_file : undefined);
			if (!tex.trim()) {
				throw new Error('Give tex_file (an existing .tex file) or text.');
			}
			const bib = readIfExists(typeof args.bib_file === 'string' ? args.bib_file : undefined);
			const ranked = await recommend(sources, tex, bib, { maxResults: num(args.max_results, 10, 30) });
			return ranked.length === 0
				? 'No recommendations: the text had too few distinctive words.'
				: ranked.map(({ paper, score }, i) => `${i + 1}. ${describe(paper)}\n  relevance ${score.toFixed(2)}`).join('\n\n');
		},
	},
	{
		name: 'get_bibtex',
		title: 'BibTeX for a paper',
		description:
			"The BibTeX entry for a paper, by arXiv ID or DOI: INSPIRE's own entry (with the key physicists use, like Maldacena:1997re) when INSPIRE has the paper; otherwise @article with journal, volume and pages when published, keeping the arXiv eprint fields.",
		inputSchema: { type: 'object', properties: identifierSchema, required: ['identifier'] },
		async run(args) {
			return bibtexFor(await findPaper(args), new Set()).entry;
		},
	},
	{
		name: 'add_to_bibliography',
		title: 'Add a paper to a .bib file',
		description:
			'Add a paper (by arXiv ID or DOI) to a BibTeX file (created if missing) and return the key to cite it with. If the paper is already there, matched by arXiv ID or DOI, nothing changes and its existing key is returned.',
		inputSchema: {
			type: 'object',
			properties: { ...identifierSchema, bib_file: { type: 'string', description: 'Path to the .bib file' } },
			required: ['identifier', 'bib_file'],
		},
		async run(args) {
			const bibFile = path.resolve(str(args.bib_file, 'bib_file'));
			if (!bibFile.endsWith('.bib')) {
				throw new Error('bib_file must be a .bib file');
			}
			const paper = await findPaper(args);
			const result = addToBib(readIfExists(bibFile), paper);
			if (result.added) {
				fs.mkdirSync(path.dirname(bibFile), { recursive: true });
				fs.writeFileSync(bibFile, result.text);
			}
			return result.added
				? `Added "${paper.title}" to ${bibFile}. Cite it with \\cite{${result.key}}.`
				: `Already in ${bibFile} as ${result.key}. Cite it with \\cite{${result.key}}.`;
		},
	},
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio

type Id = string | number | null;

function send(message: object): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

async function handle(method: string, params: Record<string, unknown> | undefined, id: Id | undefined): Promise<void> {
	const reply = (result: object) => id !== undefined && send({ id, result });
	const fail = (code: number, message: string) => id !== undefined && send({ id, error: { code, message } });
	switch (method) {
		case 'initialize':
			reply({
				protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'theoremdesk-literature', title: 'TheoremDesk Literature', version: VERSION },
				instructions:
					'Search arXiv, INSPIRE-HEP, zbMATH Open, Crossref and OpenAlex; recommend papers for a manuscript; and add BibTeX entries to the project .bib. Cite added papers with the key returned.',
			});
			return;
		case 'ping':
			reply({});
			return;
		case 'tools/list':
			reply({ tools: tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) });
			return;
		case 'tools/call': {
			const tool = tools.find((t) => t.name === params?.name);
			if (!tool) {
				fail(-32602, `Unknown tool: ${String(params?.name)}`);
				return;
			}
			try {
				const text = await tool.run((params?.arguments as Record<string, unknown>) ?? {});
				reply({ content: [{ type: 'text', text }], isError: false });
			} catch (error) {
				// Tool failures are results the agent can read, not protocol errors.
				reply({ content: [{ type: 'text', text: `Error: ${(error as Error).message}` }], isError: true });
			}
			return;
		}
		default:
			if (!method.startsWith('notifications/')) {
				fail(-32601, `Method not found: ${method}`);
			}
	}
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
	if (!line.trim()) {
		return;
	}
	let message: { method?: string; params?: Record<string, unknown>; id?: Id };
	try {
		message = JSON.parse(line);
	} catch {
		send({ id: null, error: { code: -32700, message: 'Parse error' } });
		return;
	}
	if (message.method) {
		void handle(message.method, message.params, message.id);
	}
});
