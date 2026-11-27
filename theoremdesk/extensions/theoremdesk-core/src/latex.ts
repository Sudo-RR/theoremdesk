// New LaTeX Document from Template, and Reference Style for a Journal.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateProject, isValidProjectName, listTemplates, TemplateInfo } from './generator';
import { applyStyle, currentStyle, Journal, Style, StyleData } from './refstyle';

const PENDING_OPEN = 'theoremdesk.pendingOpen';

/** Template sections, in gallery order. */
const CATEGORY_ORDER = ['Research papers', 'Conference papers', 'Talks and posters', 'Theses', 'Reports and submissions'];

export async function newLatexDocument(context: vscode.ExtensionContext): Promise<void> {
	const templates = listTemplates(context.asAbsolutePath('latex-templates'));
	const byCategory = new Map<string, TemplateInfo[]>();
	for (const t of templates) {
		const key = t.category ?? 'Other';
		byCategory.set(key, [...(byCategory.get(key) ?? []), t]);
	}
	const categories = [...byCategory.keys()].sort(
		(a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99),
	);

	type Item = vscode.QuickPickItem & { template?: TemplateInfo };
	const items: Item[] = [];
	for (const category of categories) {
		items.push({ label: category, kind: vscode.QuickPickItemKind.Separator });
		for (const t of byCategory.get(category)!.sort((a, b) => a.label.localeCompare(b.label))) {
			items.push({ label: t.label, detail: t.description, template: t });
		}
	}
	const picked = await vscode.window.showQuickPick(items, {
		title: 'New LaTeX Document',
		placeHolder: 'Choose a template',
		matchOnDetail: true,
	});
	const template = picked?.template;
	if (!template) {
		return;
	}

	const title = await vscode.window.showInputBox({ title: 'New LaTeX Document', prompt: 'Title', value: template.defaultTitle });
	if (title === undefined) {
		return;
	}
	const author = await vscode.window.showInputBox({
		title: 'New LaTeX Document',
		prompt: 'Your name, as it should appear on the document',
		value: context.globalState.get<string>('theoremdesk.authorName') ?? os.userInfo().username,
	});
	if (author === undefined) {
		return;
	}
	await context.globalState.update('theoremdesk.authorName', author);

	const name = await vscode.window.showInputBox({
		title: 'New LaTeX Document',
		prompt: 'Folder name',
		value: template.defaultName,
		validateInput: (value) =>
			isValidProjectName(value) ? undefined : 'Use letters, numbers, dots, dashes and underscores, starting with a letter or number.',
	});
	if (!name) {
		return;
	}
	const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
	const parent = await vscode.window.showOpenDialog({
		title: `Choose where to create ${name}`,
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: 'Create Here',
		defaultUri: workspace ?? vscode.Uri.file(os.homedir()),
	});
	if (!parent?.length) {
		return;
	}

	const target = path.join(parent[0].fsPath, name);
	try {
		generateProject(template, target, {
			PROJECT_NAME: name,
			PROJECT_TITLE: title || template.defaultTitle,
			AUTHOR: author,
			YEAR: String(new Date().getFullYear()),
		});
	} catch (error) {
		void vscode.window.showErrorMessage(`Couldn't create the document: ${(error as Error).message}`);
		return;
	}

	const mainTex = path.join(target, 'main.tex');
	const inWorkspace = workspace && path.resolve(target).startsWith(path.resolve(workspace.fsPath) + path.sep);
	if (inWorkspace) {
		await vscode.window.showTextDocument(vscode.Uri.file(mainTex));
		return;
	}
	const open = 'Open';
	const openNew = 'Open in New Window';
	const choice = await vscode.window.showInformationMessage(`Created ${name}.`, open, openNew);
	if (choice) {
		await context.globalState.update(PENDING_OPEN, mainTex);
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), choice === openNew);
	}
}

/** After a new document's folder opens, show its main.tex once. */
export async function openPendingDocument(context: vscode.ExtensionContext): Promise<void> {
	const pending = context.globalState.get<string>(PENDING_OPEN);
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!pending || !folder || !path.resolve(pending).startsWith(path.resolve(folder.uri.fsPath))) {
		return;
	}
	await context.globalState.update(PENDING_OPEN, undefined);
	if (fs.existsSync(pending)) {
		await vscode.window.showTextDocument(vscode.Uri.file(pending));
	}
}

export async function setReferenceStyle(context: vscode.ExtensionContext): Promise<void> {
	const document = await findTexDocument();
	if (!document) {
		void vscode.window.showWarningMessage('Open the LaTeX document whose reference style you want to set.');
		return;
	}
	const data = JSON.parse(fs.readFileSync(context.asAbsolutePath(path.join('data', 'journals.json')), 'utf8')) as StyleData;
	const current = currentStyle(document.getText());

	type Item = vscode.QuickPickItem & { journal?: Journal; style?: Style };
	const items: Item[] = [{ label: 'Journals', kind: vscode.QuickPickItemKind.Separator }];
	for (const journal of [...data.journals].sort((a, b) => a.field.localeCompare(b.field) || a.name.localeCompare(b.name))) {
		items.push({
			label: journal.name,
			description: `${journal.bibstyle}${journal.official === false ? ' (closest bundled)' : ''} · ${journal.field}`,
			detail: journal.note,
			journal,
		});
	}
	items.push({ label: 'Styles', kind: vscode.QuickPickItemKind.Separator });
	for (const style of data.styles) {
		items.push({
			label: style.bibstyle,
			description: style.bibstyle === current ? 'current' : undefined,
			detail: style.description,
			style,
		});
	}

	const picked = await vscode.window.showQuickPick(items, {
		title: `Reference Style for ${path.basename(document.uri.fsPath)}${current ? ` (now ${current})` : ''}`,
		placeHolder: 'Choose your journal, or a style',
		matchOnDescription: true,
		matchOnDetail: true,
	});
	if (!picked || (!picked.journal && !picked.style)) {
		return;
	}
	const bibstyle = picked.journal?.bibstyle ?? picked.style!.bibstyle;
	const natbib = picked.journal?.natbib ?? picked.style?.natbib ?? data.styles.find((s) => s.bibstyle === bibstyle)?.natbib;
	const result = applyStyle(document.getText(), bibstyle, { natbib, journal: picked.journal });

	if (result.tex !== document.getText()) {
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), result.tex);
		await vscode.workspace.applyEdit(edit);
		await document.save();
	}
	const message = [...result.changes, ...result.warnings].join(' ');
	if (result.warnings.length > 0) {
		void vscode.window.showWarningMessage(message);
	} else {
		void vscode.window.showInformationMessage(`${message} Rebuild the document to see it.`);
	}
}

/** The active .tex file, or the workspace's main.tex. */
async function findTexDocument(): Promise<vscode.TextDocument | undefined> {
	const active = vscode.window.activeTextEditor?.document;
	if (active && (active.languageId === 'latex' || active.fileName.endsWith('.tex'))) {
		return active;
	}
	const [main] = await vscode.workspace.findFiles('**/main.tex', '**/{node_modules,.lake,build}/**', 1);
	return main ? vscode.workspace.openTextDocument(main) : undefined;
}
