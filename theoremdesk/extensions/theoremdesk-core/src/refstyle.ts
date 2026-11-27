// Reference styles: which BibTeX style a journal expects, and switching a
// document's \bibliographystyle. Free of the `vscode` API so it can be
// tested with plain Node.

export interface Journal {
	name: string;
	field: string;
	publisher: string;
	/** The document class the journal expects. */
	class: string;
	bibstyle: string;
	/** The TheoremDesk template that starts a paper for this journal. */
	template?: string;
	/** false when the journal's own files aren't bundled and bibstyle is the closest bundled one. */
	official?: boolean;
	/** The style needs natbib (author-year citations). */
	natbib?: boolean;
	note: string;
}

export interface Style {
	bibstyle: string;
	description: string;
	natbib?: boolean;
}

export interface StyleData {
	journals: Journal[];
	styles: Style[];
}

/** Classes that load natbib (or provide its commands) themselves. */
const NATBIB_CLASSES = new Set(['revtex4-2', 'revtex4-1', 'mnras', 'elsarticle', 'acmart']);

function uncommented(tex: string): string {
	// Blank out % comments (but not \%), keeping offsets.
	return tex.replace(/(^|[^\\])%[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length));
}

export function documentClass(tex: string): string | undefined {
	return /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/.exec(uncommented(tex))?.[1].trim();
}

export function currentStyle(tex: string): string | undefined {
	return /\\bibliographystyle\s*\{([^}]+)\}/.exec(uncommented(tex))?.[1].trim();
}

export function usesNatbib(tex: string): boolean {
	const code = uncommented(tex);
	const cls = documentClass(tex);
	return (cls !== undefined && NATBIB_CLASSES.has(cls)) || /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\bnatbib\b[^}]*\}/.test(code);
}

export interface StyleChange {
	tex: string;
	/** What changed, in plain words. */
	changes: string[];
	/** Things the author should know but that weren't changed automatically. */
	warnings: string[];
}

/**
 * Set the document's bibliography style. Replaces \bibliographystyle, or adds
 * one before \bibliography{...}; adds natbib when an author-year style needs
 * it; warns when the journal expects a different document class.
 */
export function applyStyle(tex: string, bibstyle: string, options: { natbib?: boolean; journal?: Journal } = {}): StyleChange {
	const changes: string[] = [];
	const warnings: string[] = [];
	const code = uncommented(tex);
	let out = tex;

	const existing = /\\bibliographystyle\s*\{([^}]+)\}/.exec(code);
	if (existing) {
		if (existing[1].trim() !== bibstyle) {
			out = out.slice(0, existing.index) + `\\bibliographystyle{${bibstyle}}` + out.slice(existing.index + existing[0].length);
			changes.push(`Reference style changed from ${existing[1].trim()} to ${bibstyle}.`);
		} else {
			changes.push(`The reference style is already ${bibstyle}.`);
		}
	} else {
		const bib = /\\bibliography\s*\{/.exec(code);
		if (bib) {
			const lineStart = out.lastIndexOf('\n', bib.index) + 1;
			const indent = /^[ \t]*/.exec(out.slice(lineStart))?.[0] ?? '';
			out = out.slice(0, lineStart) + `${indent}\\bibliographystyle{${bibstyle}}\n` + out.slice(lineStart);
			changes.push(`Reference style set to ${bibstyle}.`);
		} else {
			warnings.push(
				`This document has no \\bibliography{...}; add \\bibliographystyle{${bibstyle}} and \\bibliography{references} where the references should go.`,
			);
		}
	}

	if (options.natbib && !usesNatbib(out)) {
		const cls = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{[^}]+\}[^\n]*\n/.exec(uncommented(out));
		if (cls) {
			const at = cls.index + cls[0].length;
			out = out.slice(0, at) + '\\usepackage{natbib}% author-year citations: \\citet, \\citep\n' + out.slice(at);
			changes.push(`Added natbib, which ${bibstyle} needs.`);
		} else {
			warnings.push(`${bibstyle} needs \\usepackage{natbib}.`);
		}
	}

	const journal = options.journal;
	if (journal) {
		const cls = documentClass(out);
		if (journal.official !== false && cls && cls !== journal.class) {
			warnings.push(
				`${journal.name} expects the ${journal.class} class, but this document uses ${cls}.` +
					(journal.template ? ' New LaTeX Document from Template has one ready.' : ''),
			);
		}
		if (journal.official === false) {
			warnings.push(journal.note);
		}
	}

	return { tex: out, changes, warnings };
}
