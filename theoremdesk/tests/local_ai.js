// The bundled local AI works offline: llama-server starts with each bundled
// model, the agent model answers and calls a tool when it should, and the
// embedding model ranks a relevant passage above unrelated ones.
//
// Usage: node local_ai.js <extension out dir> <app resources dir>
// Prints one JSON object: { ok, steps: [{ name, ok, detail }] }.

const path = require('path');

const [out, resources] = process.argv.slice(2).map((p) => path.resolve(p));
const { findLocalAi, LlamaServer, embeddingQuery } = require(path.join(out, 'llm.js'));

const steps = [];
const step = (name, ok, detail) => steps.push({ name, ok: Boolean(ok), detail });

async function main() {
	const ai = findLocalAi(path.join(resources, 'tools'), process.platform);
	if (!ai) {
		step('the build bundles the local AI', false, 'no tools/ai/models.json');
		return;
	}
	step('the build bundles the local AI', true, `${ai.llamaVersion}; ${ai.chat.name}; ${ai.embedding.name}`);

	// --- Embeddings ---
	let embed;
	try {
		const t = Date.now();
		embed = await LlamaServer.start(ai.server, 'embedding', ai.embedding);
		step('the embedding model loads', true, `${((Date.now() - t) / 1000).toFixed(1)} s on ${embed.backend()}`);
		const client = embed.client();
		const passages = [
			'The Hamiltonian of a simple pendulum is H = p^2/(2 m l^2) - m g l cos(theta); its phase portrait has a separatrix between libration and rotation.',
			'Black holes emit thermal radiation at the Hawking temperature T = hbar c^3 / (8 pi G M k_B).',
			'The Riemann zeta function has trivial zeros at the negative even integers.',
		];
		const [q, ...docs] = await client.embed([embeddingQuery('What separates oscillation from full rotation of a pendulum?'), ...passages]);
		const scores = docs.map((d) => d.reduce((s, x, i) => s + x * q[i], 0));
		const best = scores.indexOf(Math.max(...scores));
		step('embeddings rank the relevant passage first', best === 0, `cosine ${scores.map((s) => s.toFixed(3)).join(', ')}; dimension ${q.length}`);
	} catch (error) {
		step('the embedding model loads', false, String(error.message || error));
	} finally {
		embed?.stop();
	}

	// --- Agent model ---
	let chat;
	try {
		const t = Date.now();
		chat = await LlamaServer.start(ai.server, 'chat', ai.chat, { contextTokens: 8192 });
		step('the agent model loads', true, `${((Date.now() - t) / 1000).toFixed(1)} s on ${chat.backend()}`);
		const client = chat.client();

		const t1 = Date.now();
		const answer = await client.chat([{ role: 'user', content: 'What is the derivative of x^3 with respect to x? Answer with the expression only.' }], {
			thinking: false,
			maxTokens: 64,
			temperature: 0,
		});
		const tokens = answer.usage?.completion_tokens ?? 0;
		const seconds = (Date.now() - t1) / 1000;
		step('the agent model answers', /3\s*\*?\s*x\s*\^?\s*2|3x²/.test(answer.content), `"${answer.content.slice(0, 80)}" (${tokens} tokens in ${seconds.toFixed(1)} s)`);

		const tools = [
			{
				type: 'function',
				function: {
					name: 'search_literature',
					description: 'Search arXiv, INSPIRE-HEP, zbMATH, Crossref and OpenAlex for papers.',
					parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search terms' } }, required: ['query'] },
				},
			},
		];
		const call = await client.chat(
			[
				{ role: 'system', content: 'You are a research assistant in TheoremDesk. Use the tools to find papers.' },
				{ role: 'user', content: 'Find papers about the large N limit of superconformal field theories.' },
			],
			{ tools, thinking: false, maxTokens: 256, temperature: 0 },
		);
		const tc = call.toolCalls[0];
		let args = {};
		try {
			args = JSON.parse(tc?.function.arguments ?? '{}');
		} catch {
			// reported below
		}
		step(
			'the agent model calls a tool with valid arguments',
			tc?.function.name === 'search_literature' && typeof args.query === 'string' && /large\s*n|superconformal/i.test(args.query),
			tc ? `${tc.function.name}(${tc.function.arguments})` : `no tool call; said "${call.content.slice(0, 120)}"`,
		);
	} catch (error) {
		step('the agent model loads', false, String(error.message || error));
	} finally {
		chat?.stop();
	}
}

main()
	.catch((error) => step('local AI test', false, String(error.stack || error)))
	.finally(() => {
		console.log(JSON.stringify({ ok: steps.length > 0 && steps.every((s) => s.ok), steps }, null, 1));
	});
