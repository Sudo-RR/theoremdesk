// Copies KaTeX (MIT) from node_modules into media/katex at compile time,
// so the Agent view typesets mathematics offline. Run by `npm run compile`.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'node_modules', 'katex', 'dist');
const dest = path.join(__dirname, 'media', 'katex');
if (!fs.existsSync(src)) {
	console.error('copy-katex: node_modules/katex is missing; run npm ci');
	process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(path.join(dest, 'fonts'), { recursive: true });
for (const file of ['katex.min.js', 'katex.min.css']) {
	fs.copyFileSync(path.join(src, file), path.join(dest, file));
}
fs.copyFileSync(path.join(src, 'contrib', 'auto-render.min.js'), path.join(dest, 'auto-render.min.js'));
// The app's Chromium reads woff2; the css also names woff and ttf as fallbacks it never needs.
for (const font of fs.readdirSync(path.join(src, 'fonts')).filter((f) => f.endsWith('.woff2'))) {
	fs.copyFileSync(path.join(src, 'fonts', font), path.join(dest, 'fonts', font));
}
fs.copyFileSync(path.join(__dirname, 'node_modules', 'katex', 'LICENSE'), path.join(dest, 'LICENSE'));
