// Tests the agent loop with a scripted model, and the tools on a scratch
// project.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const A = require('../out/agent');
const T = require('../out/agentTools');
const { OpenAiClient } = require('../out/llm');

/** A model that plays back scripted replies, and records what it was sent. */
function scripted(replies) {
	const sent = [];
	return {
		model: 'fake',
		sent,
		async chatStream(messages, options, onDelta) {
			sent.push({ messages: structuredClone(messages), options });
			const r = replies.shift() ?? { content: 'done' };
			if (r.content) onDelta({ content: r.content });
			return { content: r.content ?? '', toolCalls: (r.calls ?? []).map((c, i) => ({ id: `c${sent.length}_${i}`, type: 'function', function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) } })), finishReason: r.calls ? 'tool_calls' : 'stop' };
		},
	};
}

const echo = { name: 'echo', description: 'Echo', parameters: { type: 'object' }, run: async (a) => `echo:${a.text}` };
const danger = { name: 'danger', description: 'Changes things', parameters: { type: 'object' }, needsApproval: true, summarize: (a) => `delete ${a.what}`, run: async () => 'deleted' };

test('the loop runs tools and feeds results back until the model answers', async () => {
	const model = scripted([{ calls: [{ name: 'echo', args: { text: 'hi' } }] }, { content: 'The tool said echo:hi.' }]);
	const events = [];
	const messages = [{ role: 'user', content: 'go' }];
	const answer = await A.runAgent(model, messages, [echo], { onEvent: (e) => events.push(e.type) });
	assert.equal(answer, 'The tool said echo:hi.');
	assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
	assert.equal(messages[2].content, 'echo:hi');
	assert.equal(messages[2].tool_call_id, messages[1].tool_calls[0].id);
	assert.deepEqual(model.sent[0].options.tools.map((t) => t.function.name), ['echo']);
	assert.deepEqual(events, ['tool-start', 'tool-end', 'text', 'turn-end']);
});

test('tools needing approval run only when approved; refusals are told to the model', async () => {
	const asked = [];
	const model = scripted([{ calls: [{ name: 'danger', args: { what: 'thesis.tex' } }] }, { content: 'ok' }, { calls: [{ name: 'danger', args: { what: 'x' } }] }, { content: 'fine' }]);
	const messages = [{ role: 'user', content: 'a' }];
	await A.runAgent(model, messages, [danger], { approve: async (t, s) => (asked.push(s), false) });
	assert.deepEqual(asked, ['delete thesis.tex']);
	assert.match(messages[2].content, /declined/);
	// No approver at all: refused, never run.
	const m2 = [{ role: 'user', content: 'b' }];
	await A.runAgent(model, m2, [danger]);
	assert.match(m2[2].content, /declined/);
});

test('bad tool names, bad JSON and tool errors become messages, not crashes', async () => {
	const failing = { name: 'boom', description: 'x', parameters: {}, run: async () => { throw new Error('kaput'); } };
	const model = scripted([{ calls: [{ name: 'nope', args: {} }, { name: 'echo', args: '{not json' }, { name: 'boom', args: {} }] }, { content: 'recovered' }]);
	const messages = [{ role: 'user', content: 'x' }];
	assert.equal(await A.runAgent(model, messages, [echo, failing]), 'recovered');
	const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
	assert.match(results[0], /no tool named nope/);
	assert.match(results[1], /valid JSON/);
	assert.match(results[2], /Error: kaput/);
});

test('the loop stops after maxSteps, and long results are cut', async () => {
	const big = { name: 'big', description: 'x', parameters: {}, run: async () => 'y'.repeat(50) };
	const model = scripted(Array.from({ length: 10 }, () => ({ calls: [{ name: 'big', args: {} }] })));
	const messages = [{ role: 'user', content: 'loop' }];
	const answer = await A.runAgent(model, messages, [big], { maxSteps: 3, maxResultChars: 20 });
	assert.match(answer, /stopped after 3 steps/);
	assert.equal(model.sent.length, 3);
	assert.match(messages[2].content, /^y{20}\n\.\.\. \[30 more characters cut\]$/);
});

test('streaming assembles text and tool calls sent in pieces', async () => {
	const events = [
		{ choices: [{ delta: { reasoning_content: 'Let me ' } }] },
		{ choices: [{ delta: { content: 'Searching' } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search_', arguments: '{"que' } }] } }] },
		{ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'literature', arguments: 'ry":"AdS"}' } }] }, finish_reason: 'tool_calls' }] },
		{ choices: [], usage: { prompt_tokens: 5, completion_tokens: 7 } },
	];
	const server = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'text/event-stream');
		// Split mid-event, as networks do.
		const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
		res.write(body.slice(0, 37));
		setTimeout(() => res.end(body.slice(37)), 10);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	try {
		const client = new OpenAiClient(`http://127.0.0.1:${server.address().port}/v1`, 'k', 'm', true);
		const deltas = [];
		const reply = await client.chatStream([{ role: 'user', content: 'x' }], {}, (d) => deltas.push(d));
		assert.equal(reply.content, 'Searching');
		assert.equal(reply.reasoning, 'Let me ');
		assert.deepEqual(reply.toolCalls, [{ id: 'call_1', type: 'function', function: { name: 'search_literature', arguments: '{"query":"AdS"}' } }]);
		assert.equal(reply.finishReason, 'tool_calls');
		assert.deepEqual(reply.usage, { prompt_tokens: 5, completion_tokens: 7 });
		assert.deepEqual(deltas, [{ reasoning: 'Let me ' }, { content: 'Searching' }]);
	} finally {
		server.close();
	}
});

test('tools stay inside the project folder', () => {
	const root = path.resolve('/proj');
	assert.equal(T.insideProject(root, 'paper/main.tex'), path.join(root, 'paper', 'main.tex'));
	assert.throws(() => T.insideProject(root, '../secrets.txt'), /outside the project/);
	assert.throws(() => T.insideProject(root, path.resolve('/etc/passwd')), /outside the project/);
	assert.throws(() => T.insideProject(root, ''), /path is required/);
});

test('file tools: list, read with line numbers, write and edit (exact, once)', async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-tools-'));
	try {
		fs.mkdirSync(path.join(root, '.lake'));
		fs.writeFileSync(path.join(root, '.lake', 'junk'), '');
		fs.writeFileSync(path.join(root, 'a.lean'), 'theorem t : 1 = 1 := rfl\n-- end\n');
		const tools = Object.fromEntries(T.createAgentTools({ root, python: 'python', sources: [] }).map((t) => [t.name, t]));
		assert.equal(await tools.list_files.run({}), 'a.lean');
		assert.match(await tools.read_file.run({ path: 'a.lean' }), /^ {4}1 {2}theorem t/);
		assert.ok(tools.write_file.needsApproval && tools.edit_file.needsApproval && tools.check_lean.needsApproval && tools.run_python.needsApproval);
		assert.ok(!tools.read_file.needsApproval && !tools.search_library.needsApproval);
		await tools.write_file.run({ path: 'sub/b.txt', content: 'x x' });
		await assert.rejects(tools.edit_file.run({ path: 'sub/b.txt', old_text: 'x', new_text: 'y' }), /appears 2 times/);
		await assert.rejects(tools.edit_file.run({ path: 'sub/b.txt', old_text: 'z', new_text: 'y' }), /not found/);
		await tools.edit_file.run({ path: 'sub/b.txt', old_text: 'x x', new_text: '$&' });
		assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), '$&', 'replacement text is literal');
		await assert.rejects(tools.read_file.run({ path: '../x' }), /outside the project/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("Lean results say plainly whether it's a proof", () => {
	assert.match(T.summarizeLean('', 0), /^Compiles with no errors/);
	assert.match(T.summarizeLean("a.lean:3:8: warning: declaration uses 'sorry'", 0), /^Compiles, but uses sorry: not a proof/);
	assert.match(T.summarizeLean('a.lean:3:8: error: unknown identifier', 1), /^Does not compile \(1 error\)/);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'td-lake-'));
	try {
		fs.mkdirSync(path.join(root, 'Proj', 'Sub'), { recursive: true });
		fs.writeFileSync(path.join(root, 'Proj', 'lakefile.toml'), '');
		assert.equal(T.lakeRoot(path.join(root, 'Proj', 'Sub', 'X.lean'), root), path.join(root, 'Proj'));
		assert.equal(T.lakeRoot(path.join(root, 'Other', 'X.lean'), root), undefined);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('repairConversation gives every tool call a result after a stop', () => {
	const messages = [
		{ role: 'user', content: 'x' },
		{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } }] },
		{ role: 'tool', tool_call_id: 'a', content: 'done' },
	];
	A.repairConversation(messages, 'Stopped.');
	assert.deepEqual(messages.slice(2).map((m) => [m.role, m.tool_call_id ?? m.content]), [['tool', 'a'], ['tool', 'b'], ['assistant', 'Stopped.']]);
	const plain = [{ role: 'user', content: 'y' }];
	A.repairConversation(plain, 'Error: offline');
	assert.deepEqual(plain.at(-1), { role: 'assistant', content: 'Error: offline' });
	const fine = [{ role: 'user', content: 'z' }, { role: 'assistant', content: 'answer' }];
	A.repairConversation(fine, 'unused');
	assert.equal(fine.length, 2);
});
