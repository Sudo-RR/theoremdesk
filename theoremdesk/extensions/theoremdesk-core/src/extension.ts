import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EnvironmentView } from './environment';
import { generateProject, isValidProjectName, listTemplates } from './generator';

const WALKTHROUGH_ID = 'gettingStarted';
const GETTING_STARTED_SHOWN = 'theoremdesk.gettingStartedShown';
/** Folder of a project just created, so its README opens once it's loaded. */
const PENDING_README = 'theoremdesk.pendingReadme';

export function activate(context: vscode.ExtensionContext): void {
	const templatesDir = context.asAbsolutePath('templates');
	const environment = new EnvironmentView();

	context.subscriptions.push(
		environment,
		vscode.window.registerTreeDataProvider('theoremdesk.environment', environment),
		vscode.commands.registerCommand('theoremdesk.newResearchProject', () =>
			newResearchProject(context, templatesDir),
		),
		vscode.commands.registerCommand('theoremdesk.openGettingStarted', () => openGettingStarted(context)),
		vscode.commands.registerCommand('theoremdesk.checkEnvironment', async () => {
			await vscode.commands.executeCommand('theoremdesk.environment.focus');
			await environment.refresh();
		}),
		vscode.commands.registerCommand('theoremdesk.environment.refresh', () => environment.refresh()),
		vscode.commands.registerCommand('theoremdesk.environment.fix', (node) => environment.fix(node)),
		vscode.workspace.onDidChangeWorkspaceFolders(() => environment.refresh()),
	);

	void environment.refresh().then(() => offerProjectSetup(environment));

	if (!context.globalState.get<boolean>(GETTING_STARTED_SHOWN)) {
		void context.globalState.update(GETTING_STARTED_SHOWN, true);
		void openGettingStarted(context);
	}

	void openPendingReadme(context);
}

export function deactivate(): void {}

function openGettingStarted(context: vscode.ExtensionContext): Thenable<unknown> {
	return vscode.commands.executeCommand(
		'workbench.action.openWalkthrough',
		`${context.extension.id}#${WALKTHROUGH_ID}`,
		false,
	);
}

async function newResearchProject(context: vscode.ExtensionContext, templatesDir: string): Promise<void> {
	const templates = listTemplates(templatesDir);
	const picked = await vscode.window.showQuickPick(
		templates.map((template) => ({ label: template.label, detail: template.description, template })),
		{ title: 'New Research Project', placeHolder: 'Choose a template' },
	);
	if (!picked) {
		return;
	}
	const template = picked.template;

	const name = await vscode.window.showInputBox({
		title: 'New Research Project',
		prompt: 'Project folder name',
		value: template.defaultName,
		validateInput: (value) =>
			isValidProjectName(value)
				? undefined
				: 'Use letters, numbers, dots, dashes and underscores, starting with a letter or number.',
	});
	if (!name) {
		return;
	}

	const parent = await vscode.window.showOpenDialog({
		title: `Choose where to create ${name}`,
		canSelectFiles: false,
		canSelectFolders: true,
		canSelectMany: false,
		openLabel: 'Create Project Here',
		defaultUri: vscode.Uri.file(os.homedir()),
	});
	if (!parent || parent.length === 0) {
		return;
	}

	const target = path.join(parent[0].fsPath, name);
	try {
		generateProject(template, target, { PROJECT_NAME: name, PROJECT_TITLE: template.defaultTitle });
	} catch (error) {
		void vscode.window.showErrorMessage(`Couldn't create the project: ${(error as Error).message}`);
		return;
	}

	const open = 'Open';
	const openNew = 'Open in New Window';
	const choice = await vscode.window.showInformationMessage(`Created ${name} in ${parent[0].fsPath}.`, open, openNew);
	if (choice) {
		await context.globalState.update(PENDING_README, target);
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), choice === openNew);
	}
}

/** When a project opens with something to set up, say so once. */
async function offerProjectSetup(environment: EnvironmentView): Promise<void> {
	const projectIssues = environment.issues.filter((r) => r.group === 'project');
	if (projectIssues.length === 0) {
		return;
	}
	const show = 'Show';
	const plural = projectIssues.length === 1 ? 'thing' : 'things';
	const choice = await vscode.window.showInformationMessage(
		`This project has ${projectIssues.length} ${plural} to set up: ${projectIssues.map((r) => r.label).join(', ')}.`,
		show,
	);
	if (choice === show) {
		await vscode.commands.executeCommand('theoremdesk.environment.focus');
	}
}

/** After a new project opens, show its README once. */
async function openPendingReadme(context: vscode.ExtensionContext): Promise<void> {
	const pending = context.globalState.get<string>(PENDING_README);
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!pending || !folder || path.resolve(folder.uri.fsPath) !== path.resolve(pending)) {
		return;
	}
	await context.globalState.update(PENDING_README, undefined);
	await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(pending, 'README.md')));
}
