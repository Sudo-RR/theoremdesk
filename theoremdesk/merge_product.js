#!/usr/bin/env node
// Deep-merge TheoremDesk's product.json overrides into VS Code's product.json,
// after VSCodium has written its own values.
//
// Usage: node merge_product.js <vscode/product.json> <theoremdesk/product.json>
//
// Environment:
//   GH_REPO_PATH    owner/repo used for the licence and issue links
//   DISABLE_UPDATE  "yes" removes the update feed so the app never updates
//                   itself from VSCodium's feed
//   BINARY_NAME     checked against applicationName

'use strict';

const fs = require('fs');

const [target, overrides] = process.argv.slice(2);
if (!target || !overrides) {
	console.error('usage: merge_product.js <target product.json> <overrides product.json>');
	process.exit(2);
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, extra) {
	for (const [key, value] of Object.entries(extra)) {
		base[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
	}
	return base;
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const product = merge(read(target), read(overrides));

const repo = process.env.GH_REPO_PATH;
if (repo) {
	product.licenseUrl = `https://github.com/${repo}/blob/master/LICENSE`;
	product.reportIssueUrl = `https://github.com/${repo}/issues/new`;
}

if (process.env.DISABLE_UPDATE === 'yes') {
	delete product.updateUrl;
	delete product.downloadUrl;
}

const binary = process.env.BINARY_NAME;
if (binary && product.applicationName !== binary) {
	console.warn(`TheoremDesk: applicationName "${product.applicationName}" differs from BINARY_NAME "${binary}"`);
}

fs.writeFileSync(target, JSON.stringify(product, null, '\t') + '\n');
console.log(`TheoremDesk: product.json is now ${product.nameLong} (${product.applicationName})`);
