// The research agent: a model that answers, or calls TheoremDesk's tools
// (literature, library, files, Lean, LaTeX, Python) and reads their
// results, until it has an answer. Free of the `vscode` API so it can be
// tested with plain Node; the tools themselves are in agentTools.ts.

import { ChatMessage, ChatReply, ToolCall, ToolDefinition } from './llm';

export interface AgentTool {
	name: string;
	description: string;
	/** JSON Schema for the arguments. */
	parameters: object;
	/** Changes files or runs code: the user approves each call first. */
	needsApproval?: boolean;
	/** One line describing a call, for the approval prompt and the transcript. */
	summarize?(args: Record<string, unknown>): string;
	run(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

/** Anything that can chat with tools: the local model or a remote API. */
export interface ChatModel {
	readonly model: string;
	chatStream(
		messages: ChatMessage[],
		options: { tools?: ToolDefinition[]; temperature?: number; maxTokens?: number; thinking?: boolean; signal?: AbortSignal },
		onDelta: (delta: { content?: string; reasoning?: string }) => void,
	): Promise<ChatReply>;
}

export type AgentEvent =
	| { type: 'text'; text: string }
	| { type: 'reasoning'; text: string }
	| { type: 'tool-start'; id: string; name: string; summary: string }
	| { type: 'tool-end'; id: string; name: string; ok: boolean; result: string }
	| { type: 'tool-denied'; id: string; name: string; summary: string }
	| { type: 'turn-end'; content: string };

export interface AgentOptions {
	maxSteps?: number;
	thinking?: boolean;
	signal?: AbortSignal;
	/** Ask the user before a tool that needs approval runs. */
	approve?: (tool: AgentTool, summary: string, args: Record<string, unknown>) => Promise<boolean>;
	onEvent?: (event: AgentEvent) => void;
	/** Results longer than this are cut, so one tool can't fill the context. */
	maxResultChars?: number;
}

export const AGENT_SYSTEM = `You are TheoremDesk's research assistant for mathematics and physics, working inside the user's project.
- Use the tools to find papers, read the project's files, check Lean proofs, compile LaTeX and run Python, instead of guessing.
- Cite papers you rely on, with the BibTeX key when they're in the bibliography.
- A Lean proof is only correct once the tools say it compiles; say so plainly when it doesn't, and never present sorry or axioms as a proof.
- Write mathematics in LaTeX between $...$. Be concise.`;

/**
 * After a stop or an error, make the conversation valid to continue: every
 * tool call needs a result, and the turn must end with the assistant.
 */
export function repairConversation(messages: ChatMessage[], note: string): void {
	const lastCalls = [...messages].reverse().find((m): m is Extract<ChatMessage, { role: 'assistant' }> => m.role === 'assistant' && Boolean(m.tool_calls?.length));
	if (lastCalls) {
		const start = messages.lastIndexOf(lastCalls);
		const answered = new Set(messages.slice(start + 1).filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => m.tool_call_id));
		for (const call of lastCalls.tool_calls ?? []) {
			if (!answered.has(call.id)) {
				messages.push({ role: 'tool', tool_call_id: call.id, content: 'Not run: the user stopped the agent.' });
			}
		}
	}
	if (messages[messages.length - 1]?.role !== 'assistant' || (messages[messages.length - 1] as { tool_calls?: unknown[] }).tool_calls?.length) {
		messages.push({ role: 'assistant', content: note });
	}
}

export function toolDefinitions(tools: AgentTool[]): ToolDefinition[] {
	return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function parseArgs(call: ToolCall): Record<string, unknown> | string {
	const raw = call.function.arguments?.trim() || '{}';
	try {
		const parsed = JSON.parse(raw) as unknown;
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : `arguments must be a JSON object, got ${raw.slice(0, 200)}`;
	} catch {
		return `arguments aren't valid JSON: ${raw.slice(0, 200)}`;
	}
}

export function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n... [${text.length - max} more characters cut]`;
}

/**
 * Run the agent on a conversation until the model answers without calling
 * a tool, or `maxSteps` model calls have been made. Appends every message
 * (assistant, tool results) to `messages` and returns the final answer.
 */
export async function runAgent(model: ChatModel, messages: ChatMessage[], tools: AgentTool[], options: AgentOptions = {}): Promise<string> {
	const emit = options.onEvent ?? (() => undefined);
	const definitions = toolDefinitions(tools);
	const maxSteps = options.maxSteps ?? 12;
	for (let step = 0; step < maxSteps; step++) {
		const reply = await model.chatStream(
			messages,
			{ tools: definitions, thinking: options.thinking, temperature: 0.6, maxTokens: 4096, signal: options.signal },
			(d) => {
				if (d.content) {
					emit({ type: 'text', text: d.content });
				}
				if (d.reasoning) {
					emit({ type: 'reasoning', text: d.reasoning });
				}
			},
		);
		messages.push({ role: 'assistant', content: reply.content || null, ...(reply.toolCalls.length ? { tool_calls: reply.toolCalls } : {}) });
		if (reply.toolCalls.length === 0) {
			emit({ type: 'turn-end', content: reply.content });
			return reply.content;
		}
		for (const call of reply.toolCalls) {
			const tool = tools.find((t) => t.name === call.function.name);
			const args = parseArgs(call);
			let result: string;
			if (!tool) {
				result = `Error: there is no tool named ${call.function.name}. Available: ${tools.map((t) => t.name).join(', ')}.`;
				emit({ type: 'tool-end', id: call.id, name: call.function.name, ok: false, result });
			} else if (typeof args === 'string') {
				result = `Error: ${args}`;
				emit({ type: 'tool-end', id: call.id, name: tool.name, ok: false, result });
			} else {
				const summary = tool.summarize?.(args) ?? `${tool.name} ${JSON.stringify(args).slice(0, 200)}`;
				if (tool.needsApproval && !(await (options.approve?.(tool, summary, args) ?? Promise.resolve(false)))) {
					result = 'The user declined this action. Ask them, or continue without it.';
					emit({ type: 'tool-denied', id: call.id, name: tool.name, summary });
				} else {
					emit({ type: 'tool-start', id: call.id, name: tool.name, summary });
					try {
						result = truncate(await tool.run(args, options.signal), options.maxResultChars ?? 12_000);
						emit({ type: 'tool-end', id: call.id, name: tool.name, ok: true, result });
					} catch (error) {
						if (options.signal?.aborted) {
							throw error;
						}
						result = `Error: ${error instanceof Error ? error.message : String(error)}`;
						emit({ type: 'tool-end', id: call.id, name: tool.name, ok: false, result });
					}
				}
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: result });
		}
	}
	const stopped = `I stopped after ${maxSteps} steps without finishing. Tell me how to continue.`;
	emit({ type: 'text', text: stopped });
	emit({ type: 'turn-end', content: stopped });
	messages.push({ role: 'assistant', content: stopped });
	return stopped;
}
