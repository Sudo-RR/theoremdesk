// Answer a question from the literature database: retrieve the closest
// passages, then ask the agent model to answer from them alone, citing
// each claim by source number. The sources go back with the answer so the
// reader can check every citation against the paper and page.

import { ChatMessage, OpenAiClient } from './llm';
import { citeLabel, Embedder, Library, SearchHit } from './library';

export interface Answer {
	text: string;
	sources: { n: number; label: string; hit: SearchHit }[];
	/** Source numbers the answer cites that don't exist (a sign of a bad answer). */
	invalidCitations: number[];
}

export const RAG_SYSTEM = [
	'You answer questions about mathematics and physics research using only the numbered sources given.',
	'Cite every claim with its source number in square brackets, like [2] or [1, 3].',
	'Write mathematics in LaTeX between $...$.',
	"If the sources don't contain the answer, say so plainly and say what they do cover. Never invent results, equations or references.",
].join(' ');

export function ragMessages(question: string, hits: SearchHit[]): ChatMessage[] {
	const sources = hits
		.map((h, i) => `[${i + 1}] ${h.paper.title} (${citeLabel(h)})\n${h.chunk.text}`)
		.join('\n\n---\n\n');
	return [
		{ role: 'system', content: RAG_SYSTEM },
		{ role: 'user', content: `Sources:\n\n${sources}\n\n---\n\nQuestion: ${question}` },
	];
}

/** The [n] citations in an answer. */
export function citations(text: string): number[] {
	const found = new Set<number>();
	for (const m of text.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) {
		for (const part of m[1].split(/\s*,\s*/)) {
			const range = /^(\d+)\s*[–-]\s*(\d+)$/.exec(part);
			if (range) {
				for (let n = Number(range[1]); n <= Number(range[2]) && n - Number(range[1]) < 50; n++) {
					found.add(n);
				}
			} else {
				found.add(Number(part));
			}
		}
	}
	return [...found].sort((a, b) => a - b);
}

export async function askLibrary(
	library: Library,
	question: string,
	embedder: Embedder,
	chat: OpenAiClient,
	options: { limit?: number; papers?: string[]; signal?: AbortSignal } = {},
): Promise<Answer> {
	const hits = await library.search(question, embedder, { limit: options.limit ?? 6, papers: options.papers });
	if (hits.length === 0) {
		return { text: 'The library is empty: add papers to it first.', sources: [], invalidCitations: [] };
	}
	const reply = await chat.chat(ragMessages(question, hits), { temperature: 0.2, maxTokens: 1500, thinking: false, signal: options.signal });
	const cited = citations(reply.content);
	return {
		text: reply.content,
		sources: hits.map((hit, i) => ({ n: i + 1, label: citeLabel(hit), hit })),
		invalidCitations: cited.filter((n) => n < 1 || n > hits.length),
	};
}
