// Project templates: listing them and writing one out to disk.
// Deliberately free of the `vscode` API so it can be tested with plain Node.

import * as fs from 'fs';
import * as path from 'path';

/** A template folder under templates/, described by its template.json. */
export interface TemplateInfo {
	id: string;
	dir: string;
	label: string;
	description: string;
	defaultName: string;
	defaultTitle: string;
	/** Values for {{NAME}} placeholders, such as pinned toolchain versions. */
	variables: Record<string, string>;
}

const MANIFEST = 'template.json';

export function listTemplates(templatesDir: string): TemplateInfo[] {
	return fs
		.readdirSync(templatesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(templatesDir, entry.name, MANIFEST)))
		.map((entry) => {
			const dir = path.join(templatesDir, entry.name);
			const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
			return {
				id: entry.name,
				dir,
				label: manifest.label,
				description: manifest.description,
				defaultName: manifest.defaultName,
				defaultTitle: manifest.defaultTitle,
				variables: manifest.variables ?? {},
			};
		});
}

/** A folder name that is safe on Windows, macOS and Linux. */
export function isValidProjectName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !name.endsWith('.');
}

/** Replace {{NAME}} placeholders that have a value; leave everything else alone. */
export function substitute(text: string, variables: Record<string, string>): string {
	return text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match,
	);
}

/**
 * Template files can't be called .gitignore or .vscode without git and
 * packaging tools treating them specially, so they are stored as dot-gitignore
 * and dot-vscode and renamed on the way out.
 */
function outputName(name: string): string {
	return name.startsWith('dot-') ? `.${name.slice('dot-'.length)}` : name;
}

/**
 * Write `template` into `targetDir`, which must not exist or be empty.
 * Returns the written files, relative to `targetDir`.
 */
export function generateProject(
	template: TemplateInfo,
	targetDir: string,
	variables: Record<string, string>,
): string[] {
	if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
		throw new Error(`${targetDir} already exists and isn't empty.`);
	}

	const values = { ...template.variables, ...variables };
	const written: string[] = [];

	const copyDir = (from: string, to: string) => {
		fs.mkdirSync(to, { recursive: true });
		for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
			if (from === template.dir && entry.name === MANIFEST) {
				continue;
			}
			const source = path.join(from, entry.name);
			const destination = path.join(to, outputName(entry.name));
			if (entry.isDirectory()) {
				copyDir(source, destination);
				continue;
			}
			const data = fs.readFileSync(source);
			fs.writeFileSync(destination, data.includes(0) ? data : substitute(data.toString('utf8'), values));
			written.push(path.relative(targetDir, destination));
		}
	};

	copyDir(template.dir, targetDir);
	return written;
}
