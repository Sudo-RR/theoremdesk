// Tests the literature MCP server as a real process over stdio, answering
// arXiv requests from fixtures.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const test = require('node:test');

const SERVER = path.join(__dirname, '..', 'out', 'mcp', 'literatureServer.js');

/** Start the server; returns call(method, params) and stop(). */
function startServer(fixture, folder) {
	const child = spawn(process.execPath, [SERVER], {
		env: folder
			? { ...process.env, THEOREMDESK_LITERATURE_FIXTURES: path.join(__dirname, 'fixtures') }
			: { ...process.env, THEOREMDESK_ARXIV_FIXTURE: path.join(__dirname, 'fixtures', fixture) },
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	const pending = new Map();
	readline.createInterface({ input: child.stdout }).on('line', (line) => {
		const message = JSON.parse(line);
		pending.get(message.id)?.(message);
		pending.delete(message.id);
	});
	let next = 1;
	return {
		call(method, params) {
			const id = next++;
			return new Promise((resolve) => {
				pending.set(id, resolve);
				child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
			});
		},
		notify(method) {
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
		},
		stop() {
			child.kill();
		},
	};
}

const text = (reply) => reply.result.content[0].text;

test('MCP handshake and tool list', async () => {
	const server = startServer('arxiv-search.xml');
	try {
		const init = await server.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
		assert.equal(init.result.protocolVersion, '2025-06-18');
		assert.equal(init.result.serverInfo.name, 'theoremdesk-literature');
		assert.ok(init.result.capabilities.tools);
		server.notify('notifications/initialized');

		const list = await server.call('tools/list');
		assert.deepEqual(
			list.result.tools.map((t) => t.name),
			['search_literature', 'search_arxiv', 'recommend_papers', 'get_bibtex', 'add_to_bibliography'],
		);
		for (const tool of list.result.tools) {
			assert.equal(tool.inputSchema.type, 'object');
			assert.ok(tool.description.length > 40);
		}
		assert.deepEqual((await server.call('ping')).result, {});
		assert.equal((await server.call('no/such/method')).error.code, -32601);
	} finally {
		server.stop();
	}
});

test('search_arxiv and recommend_papers', async () => {
	const server = startServer('arxiv-search.xml');
	try {
		const reply = await server.call('tools/call', { name: 'search_arxiv', arguments: { query: 'hamiltonian pendulum', max_results: 3 } });
		assert.equal(reply.result.isError, false);
		assert.match(text(reply), /^1\. Non-integrability Criterium/);
		assert.match(text(reply), /arXiv:1104\.0312 \[math\.DS\]/);
		assert.match(text(reply), /https:\/\/arxiv\.org\/abs\/1104\.0312/);

		const tex = path.join(__dirname, '..', 'templates', 'hamiltonian', 'manuscript', 'main.tex');
		const rec = await server.call('tools/call', { name: 'recommend_papers', arguments: { tex_file: tex, max_results: 2 } });
		assert.equal(rec.result.isError, false);
		assert.match(text(rec), /^1\. .*pendulum/i);
		assert.match(text(rec), /relevance \d\.\d\d/);
	} finally {
		server.stop();
	}
});

test('get_bibtex and add_to_bibliography (once)', async () => {
	const server = startServer('arxiv-ids.xml');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-mcp-'));
	const bib = path.join(dir, 'paper', 'references.bib');
	try {
		const entry = await server.call('tools/call', { name: 'get_bibtex', arguments: { arxiv_id: 'https://arxiv.org/abs/hep-th/9711200' } });
		assert.match(text(entry), /^@misc\{maldacena1997large,/);

		const added = await server.call('tools/call', { name: 'add_to_bibliography', arguments: { arxiv_id: 'hep-th/9711200', bib_file: bib } });
		assert.match(text(added), /Cite it with \\cite\{maldacena1997large\}/);
		const again = await server.call('tools/call', { name: 'add_to_bibliography', arguments: { arxiv_id: 'hep-th/9711200v3', bib_file: bib } });
		assert.match(text(again), /^Already in .* as maldacena1997large/);
		assert.equal(fs.readFileSync(bib, 'utf8').match(/@misc/g).length, 1);
	} finally {
		server.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('bad input is a readable tool error, not a crash', async () => {
	const server = startServer('arxiv-ids.xml');
	try {
		const missing = await server.call('tools/call', { name: 'search_arxiv', arguments: {} });
		assert.equal(missing.result.isError, true);
		assert.match(text(missing), /query is required/);

		const notBib = await server.call('tools/call', { name: 'add_to_bibliography', arguments: { arxiv_id: '1706.03762', bib_file: 'refs.txt' } });
		assert.equal(notBib.result.isError, true);
		assert.match(text(notBib), /must be a \.bib file/);

		assert.equal((await server.call('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
		// Still alive afterwards.
		assert.deepEqual((await server.call('ping')).result, {});
	} finally {
		server.stop();
	}
});

test('search_literature merges all sources; INSPIRE BibTeX is preferred', async () => {
	const server = startServer(undefined, true);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-mcp-'));
	const bib = path.join(dir, 'references.bib');
	try {
		const reply = await server.call('tools/call', { name: 'search_literature', arguments: { query: 'pendulum', max_results: 50 } });
		assert.equal(reply.result.isError, false);
		const out = text(reply);
		for (const source of ['arXiv', 'INSPIRE-HEP', 'zbMATH Open', 'Crossref', 'OpenAlex']) {
			assert.match(out, new RegExp(`from [^\n]*${source}`), source);
		}
		assert.match(out, /INSPIRE Maldacena:1997re/);
		assert.match(out, /Zbl 1112\.70020/);

		const only = await server.call('tools/call', { name: 'search_literature', arguments: { query: 'x', sources: ['zbmath'] } });
		assert.doesNotMatch(text(only), /from [^\n]*arXiv/);

		const entry = await server.call('tools/call', { name: 'get_bibtex', arguments: { identifier: 'hep-th/9711200' } });
		assert.match(text(entry), /^@article\{Maldacena:1997re,/);
		assert.match(text(entry), /journal = "Adv\. Theor\. Math\. Phys\."/);

		const added = await server.call('tools/call', { name: 'add_to_bibliography', arguments: { identifier: '10.4310/ATMP.1998.v2.n2.a1', bib_file: bib } });
		assert.match(text(added), /\\cite\{Maldacena:1997re\}/);
		const again = await server.call('tools/call', { name: 'add_to_bibliography', arguments: { arxiv_id: 'hep-th/9711200', bib_file: bib } });
		assert.match(text(again), /^Already in .* as Maldacena:1997re/);
	} finally {
		server.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
