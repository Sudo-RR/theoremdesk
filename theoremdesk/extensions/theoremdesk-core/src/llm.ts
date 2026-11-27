// The local AI: llama.cpp's llama-server running the bundled models
// (resources/tools/ai, see theoremdesk/bundle_tools.sh), and a client for
// any OpenAI-compatible endpoint, local or remote. Free of the `vscode`
// API so it can be tested with plain Node.
//
// Two servers run on demand, each on its own localhost port with a random
// key, so other programs on the machine can't use them:
//   chat       the agent model (Qwen3.5-9B), with tool calls
//   embedding  the literature database's embedding model (Qwen3-Embedding-0.6B)

import { ChildProcess, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { exe } from './tools';

export interface ModelFile {
	file: string;
	name: string;
	path: string;
}

export interface LocalAi {
	root: string;
	server: string;
	llamaVersion: string;
	chat: ModelFile;
	embedding: ModelFile;
	/** Other chat models the user has downloaded (in TheoremDesk's data folder). */
	extraChat: ModelFile[];
}

/** The bundled AI in `<resources>/tools/ai`, if this build has it. */
export function findLocalAi(toolsRoot: string, platform: NodeJS.Platform, dataDir?: string): LocalAi | undefined {
	const root = path.join(toolsRoot, 'ai');
	let manifest: { llama?: string; chat?: { file: string; name: string }; embedding?: { file: string; name: string } };
	try {
		manifest = JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8'));
	} catch {
		return undefined;
	}
	if (!manifest.chat || !manifest.embedding) {
		return undefined;
	}
	const model = (m: { file: string; name: string }, dir = path.join(root, 'models')): ModelFile => ({ ...m, path: path.join(dir, m.file) });
	const extraDir = dataDir ? path.join(dataDir, 'models') : undefined;
	let extraChat: ModelFile[] = [];
	try {
		extraChat = extraDir
			? fs
					.readdirSync(extraDir)
					.filter((f) => f.endsWith('.gguf') && !/embedding|mmproj|mtp-/i.test(f))
					.map((file) => model({ file, name: file.replace(/\.gguf$/, '') }, extraDir))
			: [];
	} catch {
		// no downloaded models
	}
	return {
		root,
		server: path.join(root, 'llama', exe(platform, 'llama-server')),
		llamaVersion: manifest.llama ?? '',
		chat: model(manifest.chat),
		embedding: model(manifest.embedding),
		extraChat,
	};
}

// ---------------------------------------------------------------------------
// Optional model downloads (data/models.json)

export interface ModelDownload {
	id: string;
	name: string;
	description: string;
	file: string;
	url: string;
	sha256: string;
	size: number;
	minMemoryGB: number;
}

/**
 * The chat model to use: the one the user picked if it's present, else the
 * bundled one; on a machine with too little memory for the bundled model,
 * a downloaded smaller one.
 */
export function chooseChatModel(ai: LocalAi, totalMemoryGB: number, preferred?: string): ModelFile {
	const picked = preferred ? [ai.chat, ...ai.extraChat].find((m) => m.file === preferred || m.name === preferred) : undefined;
	if (picked) {
		return picked;
	}
	if (totalMemoryGB < SMALL_MACHINE_GB && ai.extraChat.length > 0) {
		return ai.extraChat[0];
	}
	return ai.chat;
}

/** Below this much memory the bundled 9B is slow, and the 4B is offered. */
export const SMALL_MACHINE_GB = 15;

async function sha256File(file: string): Promise<string> {
	const { createHash } = await import('crypto');
	const hash = createHash('sha256');
	await new Promise<void>((resolve, reject) => {
		fs.createReadStream(file)
			.on('data', (chunk) => hash.update(chunk))
			.on('end', () => resolve())
			.on('error', reject);
	});
	return hash.digest('hex');
}

/**
 * Download a model into `dir`, resuming a partial download, and check its
 * SHA-256 before putting it in place. Returns the model's path.
 */
export async function downloadModel(
	spec: ModelDownload,
	dir: string,
	onProgress: (bytes: number, total: number) => void = () => undefined,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string> {
	fs.mkdirSync(dir, { recursive: true });
	const target = path.join(dir, spec.file);
	if (fs.existsSync(target) && fs.statSync(target).size === spec.size) {
		return target;
	}
	const part = `${target}.part`;
	let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
	if (have > spec.size) {
		fs.rmSync(part);
		have = 0;
	}
	if (have < spec.size) {
		const response = await fetchImpl(spec.url, {
			headers: { 'User-Agent': 'TheoremDesk (model download)', ...(have > 0 ? { Range: `bytes=${have}-` } : {}) },
			signal,
		});
		if (!response.ok || !response.body) {
			throw new Error(`Downloading ${spec.name} failed: ${response.status} ${response.statusText}`);
		}
		if (have > 0 && response.status !== 206) {
			have = 0; // the server ignored the range: start again
		}
		const out = fs.createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
		let done = have;
		try {
			for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				if (!out.write(chunk)) {
					await new Promise<void>((resolve) => out.once('drain', () => resolve()));
				}
				done += chunk.length;
				onProgress(done, spec.size);
			}
		} finally {
			await new Promise<void>((resolve) => out.end(() => resolve()));
		}
	}
	const actual = await sha256File(part);
	if (actual !== spec.sha256) {
		fs.rmSync(part, { force: true });
		throw new Error(`${spec.name} didn't match its checksum, so it was deleted. Try the download again.`);
	}
	fs.renameSync(part, target);
	return target;
}

export type ServerKind = 'chat' | 'embedding';

export interface ServerOptions {
	/** Context window in tokens (chat). */
	contextTokens?: number;
	/** CPU threads; default: llama.cpp's choice. */
	threads?: number;
	/** Use the GPU when there is one (default true). */
	gpu?: boolean;
}

/** llama-server's command line for a model. */
export function serverArgs(kind: ServerKind, modelPath: string, port: number, apiKey: string, options: ServerOptions = {}): string[] {
	const args = ['--model', modelPath, '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey, '--no-webui'];
	// Verbosity 4 logs the device and GPU offload, which backend() reports.
	args.push('--verbosity', '4', '--log-colors', 'off');
	// By default llama.cpp fits as many layers on the GPU as its memory allows (--fit).
	if (options.gpu === false) {
		args.push('--n-gpu-layers', '0');
	}
	if (options.threads) {
		args.push('--threads', String(options.threads));
	}
	if (kind === 'chat') {
		// --jinja uses the model's own chat template, which defines its tool-call format.
		args.push('--jinja', '--ctx-size', String(options.contextTokens ?? 32768), '--parallel', '1');
	} else {
		// Qwen3-Embedding takes the last token's state as the embedding.
		args.push('--embedding', '--pooling', 'last', '--ctx-size', '8192', '--batch-size', '8192', '--ubatch-size', '8192');
	}
	return args;
}

export function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.unref();
		probe.on('error', reject);
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address() as net.AddressInfo;
			probe.close(() => resolve(port));
		});
	});
}

/** A running llama-server. Start it with LlamaServer.start. */
export class LlamaServer {
	private exited: string | undefined;
	private readonly logTail: string[] = [];
	/** What it printed while loading: devices and offload. */
	private readonly logHead: string[] = [];

	private constructor(
		readonly kind: ServerKind,
		readonly model: ModelFile,
		readonly url: string,
		readonly apiKey: string,
		private readonly child: ChildProcess,
	) {
		const keep = (chunk: Buffer) => {
			for (const line of chunk.toString().split(/\r?\n/)) {
				if (line.trim()) {
					if (this.logHead.length < 300) {
						this.logHead.push(line);
					}
					this.logTail.push(line);
					if (this.logTail.length > 60) {
						this.logTail.shift();
					}
				}
			}
		};
		child.stdout?.on('data', keep);
		child.stderr?.on('data', keep);
		child.on('exit', (code, signal) => {
			this.exited = `exited with ${signal ?? `code ${code}`}`;
		});
		// A failed spawn is reported by waitReady, never thrown at the process.
		child.on('error', (error) => {
			this.exited = `couldn't start (${error.message})`;
		});
	}

	static async start(server: string, kind: ServerKind, model: ModelFile, options: ServerOptions & { timeoutMs?: number; log?: (line: string) => void } = {}): Promise<LlamaServer> {
		// Absolute paths: the server runs in its own folder.
		server = path.resolve(server);
		model = { ...model, path: path.resolve(model.path) };
		if (!fs.existsSync(server)) {
			throw new Error(`llama-server is missing (${server}). Reinstalling TheoremDesk will fix this.`);
		}
		if (!fs.existsSync(model.path)) {
			throw new Error(`The model ${model.name} is missing (${model.path}). Reinstalling TheoremDesk will fix this.`);
		}
		const port = await freePort();
		const apiKey = randomBytes(24).toString('hex');
		const child = spawn(server, serverArgs(kind, model.path, port, apiKey, options), {
			cwd: path.dirname(server), // the backend libraries sit next to it
			stdio: ['ignore', 'pipe', 'pipe'],
			windowsHide: true,
		});
		const instance = new LlamaServer(kind, model, `http://127.0.0.1:${port}`, apiKey, child);
		options.log?.(`Starting ${kind} model ${model.name} on port ${port}`);
		await instance.waitReady(options.timeoutMs ?? 180_000);
		options.log?.(`${model.name} is ready (${instance.backend()})`);
		return instance;
	}

	/** Wait until /health says the model is loaded. */
	private async waitReady(timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.exited) {
				throw new Error(`llama-server ${this.exited} while loading ${this.model.name}:\n${this.log()}`);
			}
			try {
				const response = await fetch(`${this.url}/health`, { headers: { Authorization: `Bearer ${this.apiKey}` } });
				if (response.ok) {
					return;
				}
			} catch {
				// not listening yet
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		this.stop();
		throw new Error(`${this.model.name} didn't load within ${Math.round(timeoutMs / 1000)} s:\n${this.log()}`);
	}

	get running(): boolean {
		return this.exited === undefined;
	}

	/** The last lines llama-server printed. */
	log(): string {
		return this.logTail.join('\n');
	}

	/** Which device llama.cpp is using, from its log ("Vulkan0: Intel(R) Graphics", or "CPU"). */
	backend(): string {
		// "using device Vulkan0 (Intel(R) Graphics) (unknown id) - 17632 MiB free"
		const device = this.logHead.map((l) => /using device (\S+) \((.+?)\)(?: \(| -|$)/.exec(l)).find(Boolean);
		const layers = this.logHead.map((l) => /offloaded (\d+)\/(\d+) layers to GPU/.exec(l)).find(Boolean);
		if (!device || (layers && layers[1] === '0')) {
			return 'CPU';
		}
		return `${device[2]} (${device[1]}${layers ? `, ${layers[1]}/${layers[2]} layers` : ''})`;
	}

	client(): OpenAiClient {
		return new OpenAiClient(`${this.url}/v1`, this.apiKey, this.model.name);
	}

	stop(): void {
		if (this.running) {
			this.child.kill();
		}
	}
}

// ---------------------------------------------------------------------------
// OpenAI-compatible chat and embeddings

export interface ToolCall {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type ChatMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
	| { role: 'tool'; tool_call_id: string; content: string };

export interface ToolDefinition {
	type: 'function';
	function: { name: string; description: string; parameters: object };
}

export interface ChatOptions {
	tools?: ToolDefinition[];
	temperature?: number;
	maxTokens?: number;
	/** Let the model think before answering (Qwen3.5's default). */
	thinking?: boolean;
	signal?: AbortSignal;
}

export interface ChatReply {
	content: string;
	reasoning?: string;
	toolCalls: ToolCall[];
	finishReason: string;
	usage?: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAiClient {
	constructor(
		readonly baseUrl: string,
		private readonly apiKey: string,
		readonly model: string,
	) {}

	private async post<T>(endpoint: string, body: object, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${this.baseUrl}${endpoint}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
			body: JSON.stringify(body),
			signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`${this.model} answered ${response.status}: ${text.slice(0, 500)}`);
		}
		return JSON.parse(text) as T;
	}

	async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<ChatReply> {
		const body: Record<string, unknown> = {
			model: this.model,
			messages,
			temperature: options.temperature ?? 0.6,
			max_tokens: options.maxTokens ?? 4096,
		};
		if (options.tools && options.tools.length > 0) {
			body.tools = options.tools;
			body.tool_choice = 'auto';
		}
		if (options.thinking !== undefined) {
			body.chat_template_kwargs = { enable_thinking: options.thinking };
		}
		const reply = await this.post<{
			choices: { message: { content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }; finish_reason: string }[];
			usage?: ChatReply['usage'];
		}>('/chat/completions', body, options.signal);
		const choice = reply.choices[0];
		return {
			content: stripThinking(choice.message.content ?? ''),
			reasoning: choice.message.reasoning_content,
			toolCalls: choice.message.tool_calls ?? [],
			finishReason: choice.finish_reason,
			usage: reply.usage,
		};
	}

	async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
		if (texts.length === 0) {
			return [];
		}
		const reply = await this.post<{ data: { index: number; embedding: number[] }[] }>('/embeddings', { model: this.model, input: texts }, signal);
		return reply.data.sort((a, b) => a.index - b.index).map((d) => normalize(Float32Array.from(d.embedding)));
	}
}

/** Remove a <think>...</think> block a server left in the answer. */
export function stripThinking(text: string): string {
	return text.replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '').trim();
}

export function normalize(v: Float32Array): Float32Array {
	let n = 0;
	for (const x of v) {
		n += x * x;
	}
	n = Math.sqrt(n) || 1;
	for (let i = 0; i < v.length; i++) {
		v[i] /= n;
	}
	return v;
}

/** Qwen3-Embedding wants queries (not documents) prefixed with the task. */
export function embeddingQuery(query: string, task = 'Given a question about mathematics or physics, retrieve passages from research papers that answer it'): string {
	return `Instruct: ${task}\nQuery: ${query}`;
}
