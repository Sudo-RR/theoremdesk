// Tests the local AI runtime without a model: finding the bundled files,
// llama-server's command line, and the OpenAI-compatible client against a
// fake server.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const A = require('../out/llm');

function fakeBundle() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ai-'));
	const ai = path.join(dir, 'tools', 'ai');
	fs.mkdirSync(path.join(ai, 'models'), { recursive: true });
	fs.writeFileSync(
		path.join(ai, 'models.json'),
		JSON.stringify({ llama: 'llama.cpp b12774', chat: { file: 'chat.gguf', name: 'Qwen3.5-9B' }, embedding: { file: 'embed.gguf', name: 'Qwen3-Embedding-0.6B' } }),
	);
	for (const f of ['chat.gguf', 'embed.gguf']) {
		fs.writeFileSync(path.join(ai, 'models', f), '');
	}
	const data = path.join(dir, 'data');
	fs.mkdirSync(path.join(data, 'models'), { recursive: true });
	for (const f of ['Qwen3.5-4B-Q4_K_M.gguf', 'mmproj-x.gguf', 'notes.txt']) {
		fs.writeFileSync(path.join(data, 'models', f), '');
	}
	return { dir, tools: path.join(dir, 'tools'), data };
}

test('findLocalAi reads the bundle and the downloaded models', () => {
	const b = fakeBundle();
	try {
		const ai = A.findLocalAi(b.tools, 'win32', b.data);
		assert.equal(ai.server, path.join(b.tools, 'ai', 'llama', 'llama-server.exe'));
		assert.equal(ai.chat.name, 'Qwen3.5-9B');
		assert.equal(ai.chat.path, path.join(b.tools, 'ai', 'models', 'chat.gguf'));
		assert.equal(ai.embedding.path, path.join(b.tools, 'ai', 'models', 'embed.gguf'));
		assert.deepEqual(ai.extraChat.map((m) => m.name), ['Qwen3.5-4B-Q4_K_M'], 'projector files and non-models are skipped');
		assert.equal(A.findLocalAi(b.tools, 'linux').server, path.join(b.tools, 'ai', 'llama', 'llama-server'));
		assert.equal(A.findLocalAi(path.join(b.dir, 'nothing'), 'linux'), undefined);
	} finally {
		fs.rmSync(b.dir, { recursive: true, force: true });
	}
});

test('llama-server listens on localhost only, with a key', () => {
	const chat = A.serverArgs('chat', 'm.gguf', 4321, 'k', { contextTokens: 8192 });
	const at = (flag) => chat[chat.indexOf(flag) + 1];
	assert.equal(at('--host'), '127.0.0.1');
	assert.equal(at('--port'), '4321');
	assert.equal(at('--api-key'), 'k');
	assert.equal(at('--ctx-size'), '8192');
	assert.ok(chat.includes('--jinja'), "the model's own template, for tool calls");
	assert.ok(chat.includes('--no-webui'));
	assert.ok(!chat.includes('--embedding'));
	const embed = A.serverArgs('embedding', 'e.gguf', 1, 'k', { gpu: false });
	assert.ok(embed.includes('--embedding'));
	assert.equal(embed[embed.indexOf('--pooling') + 1], 'last');
	assert.equal(embed[embed.indexOf('--n-gpu-layers') + 1], '0');
});

test('freePort gives a usable port', async () => {
	const port = await A.freePort();
	assert.ok(port > 1024 && port < 65536);
});

test('the client speaks OpenAI chat (with tools) and embeddings', async () => {
	const seen = [];
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
			res.setHeader('Content-Type', 'application/json');
			if (req.url === '/v1/embeddings') {
				res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 2] }, { index: 0, embedding: [3, 4] }] }));
			} else if (req.url === '/v1/chat/completions') {
				res.end(
					JSON.stringify({
						choices: [
							{
								message: {
									content: '<think>hmm</think>\nLet me search.',
									tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_literature', arguments: '{"query":"large N"}' } }],
								},
								finish_reason: 'tool_calls',
							},
						],
						usage: { prompt_tokens: 10, completion_tokens: 5 },
					}),
				);
			} else {
				res.statusCode = 404;
				res.end('{"error":"no"}');
			}
		});
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const client = new A.OpenAiClient(`http://127.0.0.1:${server.address().port}/v1`, 'secret', 'm', true);
	try {
		const tools = [{ type: 'function', function: { name: 'search_literature', description: 'd', parameters: { type: 'object' } } }];
		const reply = await client.chat([{ role: 'user', content: 'hi' }], { tools, thinking: false });
		assert.equal(reply.content, 'Let me search.', 'thinking is stripped');
		assert.equal(reply.toolCalls[0].function.name, 'search_literature');
		assert.equal(seen[0].auth, 'Bearer secret');
		assert.deepEqual(seen[0].body.tools, tools);
		assert.deepEqual(seen[0].body.chat_template_kwargs, { enable_thinking: false });

		const [a, b] = await client.embed(['x', 'y']);
		assert.deepEqual([...a].map((v) => +v.toFixed(3)), [0.6, 0.8], 'sorted by index and normalised');
		assert.deepEqual([...b], [0, 1]);
		assert.deepEqual(await client.embed([]), []);

		const bad = new A.OpenAiClient(`http://127.0.0.1:${server.address().port}/nope`, 'k', 'm');
		await assert.rejects(bad.chat([{ role: 'user', content: 'x' }]), /answered 404/);
	} finally {
		server.close();
	}
});

test('LlamaServer.start explains a missing runtime or model', async () => {
	await assert.rejects(A.LlamaServer.start('/no/llama-server', 'chat', { name: 'x', file: 'x', path: '/no/x.gguf' }), /llama-server is missing/);
	await assert.rejects(A.LlamaServer.start(process.execPath, 'chat', { name: 'Qwen', file: 'x', path: '/no/x.gguf' }), /The model Qwen is missing/);
});

test('embedding queries carry the instruction; documents do not need one', () => {
	assert.match(A.embeddingQuery('pendulum separatrix'), /^Instruct: .*\nQuery: pendulum separatrix$/);
	assert.equal(A.stripThinking('<think>\na\n</think>\n\nAnswer'), 'Answer');
	assert.equal(A.stripThinking('No thinking'), 'No thinking');
});

test('chooseChatModel: the user pick, else bundled, else the small one on small machines', () => {
	const chat = { file: 'Qwen3.5-9B.gguf', name: 'Qwen3.5-9B', path: '/b/9b' };
	const small = { file: 'Qwen3.5-4B-Q4_K_M.gguf', name: 'Qwen3.5-4B-Q4_K_M', path: '/d/4b' };
	const ai = { chat, extraChat: [small] };
	assert.equal(A.chooseChatModel(ai, 32), chat);
	assert.equal(A.chooseChatModel(ai, 8), small);
	assert.equal(A.chooseChatModel({ chat, extraChat: [] }, 8), chat);
	assert.equal(A.chooseChatModel(ai, 32, 'Qwen3.5-4B-Q4_K_M.gguf'), small);
	assert.equal(A.chooseChatModel(ai, 32, 'gone.gguf'), chat);
});

test('downloadModel resumes, checks the SHA-256, and refuses a bad file', async () => {
	const crypto = require('node:crypto');
	const content = Buffer.from('GGUF'.repeat(5000));
	const spec = { id: 't', name: 'Test model', file: 't.gguf', url: 'https://example.invalid/t.gguf', size: content.length, sha256: crypto.createHash('sha256').update(content).digest('hex') };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-dl-'));
	const ranges = [];
	const fakeFetch = async (url, init) => {
		const range = init.headers.Range;
		ranges.push(range);
		const from = range ? Number(/bytes=(\d+)-/.exec(range)[1]) : 0;
		return new Response(content.subarray(from), { status: range ? 206 : 200 });
	};
	try {
		fs.writeFileSync(path.join(dir, 't.gguf.part'), content.subarray(0, 7000));
		let last = 0;
		const file = await A.downloadModel(spec, dir, (b) => (last = b), undefined, fakeFetch);
		assert.deepEqual(ranges, ['bytes=7000-'], 'resumed from the partial file');
		assert.equal(last, content.length);
		assert.ok(fs.readFileSync(file).equals(content));
		assert.ok(!fs.existsSync(path.join(dir, 't.gguf.part')));
		// Already there: no request.
		await A.downloadModel(spec, dir, undefined, undefined, fakeFetch);
		assert.equal(ranges.length, 1);
		// Wrong checksum: deleted, not installed.
		const bad = { ...spec, file: 'bad.gguf', sha256: '0'.repeat(64) };
		await assert.rejects(A.downloadModel(bad, dir, undefined, undefined, fakeFetch), /didn't match its checksum/);
		assert.ok(!fs.existsSync(path.join(dir, 'bad.gguf')) && !fs.existsSync(path.join(dir, 'bad.gguf.part')));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('models are found in the bundle, the all-users folder or the user folder, else offered for download', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'td-ai-where-'));
	try {
		const tools = path.join(dir, 'tools');
		fs.mkdirSync(path.join(tools, 'ai', 'models'), { recursive: true });
		const pin = { url: 'https://huggingface.co/x/resolve/abc/chat.gguf', sha256: 'a'.repeat(64), size: 123 };
		const embedPin = { ...pin, url: 'https://huggingface.co/x/resolve/abc/embed.gguf' };
		fs.writeFileSync(path.join(tools, 'ai', 'models.json'), JSON.stringify({ llama: 'b', chat: { file: 'chat.gguf', name: 'Chat', ...pin }, embedding: { file: 'embed.gguf', name: 'Embed', ...embedPin } }));
		const data = path.join(dir, 'data');
		const programData = path.join(dir, 'ProgramData');
		fs.mkdirSync(path.join(data, 'models'), { recursive: true });
		fs.mkdirSync(path.join(programData, 'TheoremDesk', 'models'), { recursive: true });
		// An all-users install: the chat model in ProgramData; the embedding model not installed.
		fs.writeFileSync(path.join(programData, 'TheoremDesk', 'models', 'chat.gguf'), '');
		// The installer's own models in the user folder aren't "other downloaded models".
		fs.writeFileSync(path.join(data, 'models', 'chat.gguf'), '');
		const ai = A.findLocalAi(tools, 'win32', data, { ProgramData: programData });
		assert.equal(ai.chat.path, path.join(programData, 'TheoremDesk', 'models', 'chat.gguf'));
		assert.equal(ai.chat.present, true);
		assert.equal(ai.embedding.present, false);
		assert.equal(ai.embedding.path, path.join(data, 'models', 'embed.gguf'), 'a download goes to the user folder');
		assert.deepEqual(ai.embedding.download, embedPin);
		assert.deepEqual(ai.extraChat, []);
		assert.deepEqual(A.modelFolders(path.join(tools, 'ai'), 'linux', data, {}), [path.join(tools, 'ai', 'models'), path.join(data, 'models')]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
