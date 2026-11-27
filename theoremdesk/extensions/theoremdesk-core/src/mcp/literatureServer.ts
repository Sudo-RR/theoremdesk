#!/usr/bin/env node
// TheoremDesk's literature MCP server: arXiv search, recommendations for a
// project, BibTeX entries, and adding them to a .bib file. Agents (Codex,
// Claude Code, VS Code's agent mode, ...) use it over stdio.
//
// Run with any Node, or with TheoremDesk's own runtime:
//   ELECTRON_RUN_AS_NODE=1 TheoremDesk out/mcp/literatureServer.js
//
// Implements the MCP tools protocol (newline-delimited JSON-RPC 2.0 on
// stdin/stdout) without dependencies, so it ships inside the extension.
// THEOREMDESK_ARXIV_FIXTURE=<file> answers every arXiv request from a file
// (for tests).

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { addToBib, ArxivSource, describe, FetchText, parseArxivId, recommend, toBibtex, bibtexKey, indexBib } from '../literature';

const VERSION = '0.1.0';
const PROTOCOL = '2025-06-18';

const fixture = process.env.THEOREMDESK_ARXIV_FIXTURE;
const fetchText: FetchText | undefined = fixture ? async () => fs.readFileSync(fixture, 'utf8') : undefined;
const arxiv = new ArxivSource(fetchText, fixture ? 0 : undefined);

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

const tools: Tool[] = [
	{
		name: 'search_arxiv',
		title: 'Search arXiv',
		description:
			'Search arXiv for papers. Plain words must all appear; arXiv field syntax also works (ti:, au:, abs:, cat:, AND, OR). Returns title, authors, year, arXiv ID, link and the start of the abstract for each paper.',
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
			const papers = await arxiv.search(str(args.query, 'query'), {
				maxResults: num(args.max_results, 10, 50),
				category: typeof args.category === 'string' ? args.category : undefined,
				sort: args.sort === 'recent' ? 'recent' : 'relevance',
			});
			return papers.length === 0 ? 'No papers found.' : papers.map((p, i) => `${i + 1}. ${describe(p)}`).join('\n\n');
		},
	},
	{
		name: 'recommend_papers',
		title: 'Recommend papers for a project',
		description:
			"Recommend arXiv papers related to a manuscript: takes the main terms from its title, abstract and text (and the titles in its .bib), searches arXiv, ranks by similarity, and leaves out papers already in the bibliography.",
		inputSchema: {
			type: 'object',
			properties: {
				tex_file: { type: 'string', description: 'Path to the manuscript (.tex)' },
				text: { type: 'string', description: 'Or: text describing the research, instead of a .tex file' },
				bib_file: { type: 'string', description: 'Path to the project .bib file, to skip papers already cited' },
				max_results: { type: 'number', description: 'How many papers (default 10, at most 30)' },
			},
		},
		async run(args) {
			const tex = typeof args.text === 'string' ? args.text : readIfExists(typeof args.tex_file === 'string' ? args.tex_file : undefined);
			if (!tex.trim()) {
				throw new Error('Give tex_file (an existing .tex file) or text.');
			}
			const bib = readIfExists(typeof args.bib_file === 'string' ? args.bib_file : undefined);
			const ranked = await recommend(arxiv, tex, bib, { maxResults: num(args.max_results, 10, 30) });
			return ranked.length === 0
				? 'No recommendations: the text had too few distinctive words.'
				: ranked.map(({ paper, score }, i) => `${i + 1}. ${describe(paper)}\n  relevance ${score.toFixed(2)}`).join('\n\n');
		},
	},
	{
		name: 'get_bibtex',
		title: 'BibTeX for an arXiv paper',
		description: 'The BibTeX entry for an arXiv paper, in the form arXiv recommends (eprint, archivePrefix, primaryClass, DOI and journal reference when published).',
		inputSchema: {
			type: 'object',
			properties: { arxiv_id: { type: 'string', description: 'e.g. 1706.03762, hep-th/9711200 or an arxiv.org link' } },
			required: ['arxiv_id'],
		},
		async run(args) {
			const [paper] = await arxiv.byIds([str(args.arxiv_id, 'arxiv_id')]);
			if (!paper) {
				throw new Error(`arXiv has no paper ${args.arxiv_id}`);
			}
			return toBibtex(paper, bibtexKey(paper));
		},
	},
	{
		name: 'add_to_bibliography',
		title: 'Add an arXiv paper to a .bib file',
		description:
			'Add an arXiv paper to a BibTeX file (created if missing) and return the key to cite it with. If the paper is already there, nothing changes and its existing key is returned.',
		inputSchema: {
			type: 'object',
			properties: {
				arxiv_id: { type: 'string', description: 'e.g. 1706.03762 or an arxiv.org link' },
				bib_file: { type: 'string', description: 'Path to the .bib file' },
			},
			required: ['arxiv_id', 'bib_file'],
		},
		async run(args) {
			const bibFile = path.resolve(str(args.bib_file, 'bib_file'));
			if (!bibFile.endsWith('.bib')) {
				throw new Error('bib_file must be a .bib file');
			}
			const id = parseArxivId(str(args.arxiv_id, 'arxiv_id'))?.id;
			const [paper] = id ? await arxiv.byIds([id]) : [];
			if (!paper) {
				throw new Error(`arXiv has no paper ${args.arxiv_id}`);
			}
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
					'Search arXiv, recommend papers for a manuscript, and add BibTeX entries to the project .bib. Cite added papers with the key returned.',
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
