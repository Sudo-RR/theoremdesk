// Tests the LaTeX template gallery's metadata and the reference-style logic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listTemplates, isValidProjectName } = require('../out/generator');
const { applyStyle, currentStyle, documentClass, usesNatbib } = require('../out/refstyle');

const ROOT = path.join(__dirname, '..');
const templates = listTemplates(path.join(ROOT, 'latex-templates'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'journals.json'), 'utf8'));

test('every LaTeX template is complete', () => {
	assert.ok(templates.length >= 20, `only ${templates.length} templates`);
	for (const t of templates) {
		assert.ok(t.label && t.description && t.category, `${t.id}: label, description and category`);
		assert.ok(isValidProjectName(t.defaultName), `${t.id}: default folder name`);
		const tex = fs.readFileSync(path.join(t.dir, 'main.tex'), 'utf8');
		assert.match(tex, /\\documentclass/, `${t.id}: main.tex`);
		assert.match(tex, /\{\{PROJECT_TITLE\}\}/, `${t.id}: uses the title`);
		assert.match(tex, /\{\{AUTHOR\}\}/, `${t.id}: uses the author`);
		if (/\\bibliography\{references\}/.test(tex)) {
			assert.ok(fs.existsSync(path.join(t.dir, 'references.bib')), `${t.id}: references.bib`);
		}
	}
});

test('every TeX package a template needs is bundled', () => {
	const bundled = new Set(
		fs
			.readFileSync(path.join(ROOT, '..', '..', 'tools', 'tex-packages.txt'), 'utf8')
			.split('\n')
			.map((l) => l.replace(/#.*/, '').trim())
			.filter(Boolean),
	);
	for (const t of templates) {
		const manifest = JSON.parse(fs.readFileSync(path.join(t.dir, 'template.json'), 'utf8'));
		for (const p of manifest.texPackages) {
			assert.ok(bundled.has(p), `${t.id} needs ${p}, which tools/tex-packages.txt doesn't bundle`);
		}
	}
});

test('journal advice points at real templates and listed styles', () => {
	const ids = new Set(templates.map((t) => t.id));
	const styles = new Set(data.styles.map((s) => s.bibstyle));
	for (const j of data.journals) {
		assert.ok(j.name && j.field && j.class && j.bibstyle && j.note, `${j.name}: fields`);
		if (j.template) {
			assert.ok(ids.has(j.template), `${j.name}: template ${j.template} doesn't exist`);
		}
		assert.ok(styles.has(j.bibstyle), `${j.name}: ${j.bibstyle} isn't in the style list`);
	}
});

const ARTICLE = `\\documentclass[11pt]{article}
\\usepackage{amsmath}
% \\bibliographystyle{commented}
\\begin{document}
Text~\\cite{x}.
\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}
`;

test('reads the class and style, ignoring comments', () => {
	assert.equal(documentClass(ARTICLE), 'article');
	assert.equal(currentStyle(ARTICLE), 'plain');
	assert.ok(!usesNatbib(ARTICLE));
	assert.ok(usesNatbib('\\documentclass[aps]{revtex4-2}'), 'REVTeX provides natbib');
	assert.ok(usesNatbib('\\documentclass{article}\n\\usepackage[numbers]{natbib}'));
});

test('switching style replaces \\bibliographystyle', () => {
	const r = applyStyle(ARTICLE, 'unsrt');
	assert.match(r.tex, /\\bibliographystyle\{unsrt\}\n\\bibliography\{references\}/);
	assert.match(r.tex, /% \\bibliographystyle\{commented\}/, 'comments untouched');
	assert.deepEqual(r.warnings, []);
});

test('an author-year style adds natbib once', () => {
	const r = applyStyle(ARTICLE, 'plainnat', { natbib: true });
	assert.match(r.tex, /^\\documentclass\[11pt\]\{article\}\n\\usepackage\{natbib\}/);
	assert.equal(applyStyle(r.tex, 'abbrvnat', { natbib: true }).tex.match(/usepackage\{natbib\}/g).length, 1);
});

test('adds \\bibliographystyle before \\bibliography when missing', () => {
	const r = applyStyle('\\documentclass{article}\n\\begin{document}\n  \\bibliography{references}\n\\end{document}\n', 'plain');
	assert.match(r.tex, /  \\bibliographystyle\{plain\}\n  \\bibliography\{references\}/);
});

test('warns when the journal expects another class, or its files are not bundled', () => {
	const aps = data.journals.find((j) => j.name === 'Physical Review Letters');
	const r = applyStyle(ARTICLE, aps.bibstyle, { journal: aps });
	assert.ok(r.warnings.some((w) => /expects the revtex4-2 class/.test(w)));

	const jhep = data.journals.find((j) => /JHEP/.test(j.name));
	const j = applyStyle(ARTICLE, jhep.bibstyle, { journal: jhep });
	assert.ok(j.warnings.some((w) => /aren't bundled/.test(w)));
	assert.ok(!j.warnings.some((w) => /expects the/.test(w)), 'no class warning for the closest-bundled fallback');
});
