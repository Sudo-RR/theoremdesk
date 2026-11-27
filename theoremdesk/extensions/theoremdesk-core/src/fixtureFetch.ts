// Answers literature requests from recorded responses instead of the
// network, for tests: THEOREMDESK_LITERATURE_FIXTURES=<folder> makes the MCP
// server use it. The folder holds the files in test/fixtures.

import * as fs from 'fs';
import * as path from 'path';
import { FetchText } from './literature';

export function fixtureFile(url: string): string | undefined {
	const u = new URL(url);
	const q = decodeURIComponent(u.search);
	switch (u.host) {
		case 'export.arxiv.org':
			return q.includes('id_list=') ? 'arxiv-ids.xml' : 'arxiv-search.xml';
		case 'inspirehep.net':
			if (q.includes('format=bibtex')) {
				return 'inspire-maldacena.bib';
			}
			return /q=(arxiv|doi):/.test(q) ? 'inspire-arxiv.json' : 'inspire-search.json';
		case 'api.zbmath.org':
			return 'zbmath-search.json';
		case 'api.crossref.org':
			return 'crossref-search.json';
		case 'api.openalex.org':
			return q.includes('filter=') ? 'openalex-doi.json' : 'openalex-search.json';
		default:
			return undefined;
	}
}

/** A fetch that reads recorded responses from a folder, and logs each URL asked for. */
export function fixtureFetch(folder: string, log: string[] = []): FetchText {
	return async (url) => {
		log.push(url);
		const file = fixtureFile(url);
		if (!file) {
			throw new Error(`No fixture for ${url}`);
		}
		return fs.readFileSync(path.join(folder, file), 'utf8');
	};
}
