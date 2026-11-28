import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { EnvironmentView } from './environment';
import { generateProject, isValidProjectName, listTemplates } from './generator';
import { newLatexDocument, openPendingDocument, setReferenceStyle } from './latex';
import { LiteratureView, registerLiteratureMcpServer } from './literatureView';
import { MutationView } from './mutation';
import { provisionBundledTools, repairToolchain, Toolchain } from './provision';
import { AgentView } from './agentView';
import { LibraryView } from './libraryView';
import { openCliAgent, Providers } from './providers';
import { LocalAiService } from './localAiService';
import { VerificationView } from './verify';

const WALKTHROUGH_ID = 'gettingStarted';
const GETTING_STARTED_SHOWN = 'theoremdesk.gettingStartedShown';
/** Folder of a project just created, so its README opens once it's loaded. */
const PENDING_README = 'theoremdesk.pendingReadme';

export function activate(context: vscode.ExtensionContext): void {
	const templatesDir = context.asAbsolutePath('templates');
	const environment = new EnvironmentView(context.asAbsolutePath(path.join('scripts', 'wsl-setup.sh')));
	const verification = new VerificationView(context.asAbsolutePath(path.join('scripts', 'wsl-verify.sh')));
	const mutations = new MutationView();
	const literature = new LiteratureView();
	let library: LibraryView | undefined;
	registerLiteratureMcpServer(context);

	context.subscriptions.push(
		mutations,
		vscode.window.registerTreeDataProvider('theoremdesk.mutations', mutations),
		vscode.commands.registerCommand('theoremdesk.mutationTest', () => mutations.run()),
		vscode.commands.registerCommand('theoremdesk.mutations.showDiff', (source, result) => mutations.showDiff(source, result)),
		environment,
		vscode.window.registerTreeDataProvider('theoremdesk.environment', environment),
		vscode.window.registerTreeDataProvider('theoremdesk.verification', verification),
		literature,
		vscode.window.registerTreeDataProvider('theoremdesk.literature', literature),
		vscode.commands.registerCommand('theoremdesk.literature.search', () => literature.search()),
		vscode.commands.registerCommand('theoremdesk.literature.recommend', () => literature.recommend()),
		vscode.commands.registerCommand('theoremdesk.literature.add', async (item) => {
			const added = await literature.add(item);
			if (added && vscode.workspace.getConfiguration('theoremdesk.library').get('addCitedPapers', true)) {
				void library?.addPaper(item, true);
			}
		}),
		vscode.commands.registerCommand('theoremdesk.literature.copyCite', (item) => literature.copyCite(item)),
		vscode.commands.registerCommand('theoremdesk.literature.open', (item) => literature.open(item)),
		vscode.commands.registerCommand('theoremdesk.literature.chooseSources', () => literature.chooseSources()),
		vscode.commands.registerCommand('theoremdesk.newLatexDocument', () => newLatexDocument(context)),
		vscode.commands.registerCommand('theoremdesk.setReferenceStyle', () => setReferenceStyle(context)),
		vscode.commands.registerCommand('theoremdesk.leanBuild', () => verification.buildProject()),
		vscode.commands.registerCommand('theoremdesk.checkLeanKernel', () => verification.checkWithLeanKernel()),
		vscode.commands.registerCommand('theoremdesk.verifyKernels', () => verification.verifyProject()),
		vscode.commands.registerCommand('theoremdesk.checkProof', () => verification.checkProof()),
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

	// Make the built-in Lean, Python, LaTeX and Git ready (and prove they run)
	// before anything else, so the checks and other extensions see them.
	const log = vscode.window.createOutputChannel('TheoremDesk');
	context.subscriptions.push(log);
	let toolchain: Toolchain | undefined;
	const useToolchain = (t: Toolchain | undefined) => {
		toolchain = t;
		environment.builtIn = t
			? { python: t.tools.python, elanHome: t.result.elanHome, status: t.result.status }
			: undefined;
	};
	context.subscriptions.push(
		vscode.commands.registerCommand('theoremdesk.repairToolchain', async () => {
			if (!toolchain) {
				void vscode.window.showInformationMessage('This build of TheoremDesk has no built-in toolchain to repair.');
				return;
			}
			const current = toolchain;
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Repairing the built-in toolchain' },
				async () => useToolchain(await repairToolchain(context, current, log)),
			);
			await environment.refresh();
			const failed = toolchain?.result.status.filter((s) => !s.ok) ?? [];
			if (failed.length === 0) {
				void vscode.window.showInformationMessage('The built-in Lean, Python, LaTeX and Git all work.');
			}
		}),
	);
	void provisionBundledTools(context, log)
		.then(useToolchain)
		.catch((error) => log.appendLine(`Setting up the built-in toolchain failed: ${(error as Error).stack ?? error}`))
		.then(() => environment.refresh())
		.then(() => offerProjectSetup(environment));

	// The local AI: models start when first used.
	const aiLog = vscode.window.createOutputChannel('TheoremDesk Local AI');
	const localAi = new LocalAiService(context, aiLog);
	context.subscriptions.push(
		aiLog,
		localAi,
		vscode.commands.registerCommand('theoremdesk.ai.status', () => localAi.showStatus()),
		vscode.commands.registerCommand('theoremdesk.ai.chooseModel', () => localAi.chooseModel()),
		vscode.commands.registerCommand('theoremdesk.ai.downloadModel', () => localAi.download()),
		vscode.commands.registerCommand('theoremdesk.ai.stop', () => localAi.stop()),
	);
	void localAi.offerSmallModel();

	// The literature database, searched and asked with the local models.
	library = new LibraryView(context, localAi);
	const lib = library;
	context.subscriptions.push(
		lib,
		vscode.window.registerTreeDataProvider('theoremdesk.library', lib),
		vscode.commands.registerCommand('theoremdesk.library.ask', () => lib.ask()),
		vscode.commands.registerCommand('theoremdesk.library.search', () => lib.search()),
		vscode.commands.registerCommand('theoremdesk.library.addBibliography', () => lib.addBibliography()),
		vscode.commands.registerCommand('theoremdesk.library.addPdf', () => lib.addPdf()),
		vscode.commands.registerCommand('theoremdesk.library.addPaper', (item) => lib.addPaper(item)),
		vscode.commands.registerCommand('theoremdesk.library.remove', (item) => lib.remove(item)),
		vscode.commands.registerCommand('theoremdesk.library.open', (item) => lib.open(item)),
	);

	// The research agent.
	const providers = new Providers(context, localAi);
	const agent = new AgentView(context, localAi, providers, () => lib.libraryStore());
	context.subscriptions.push(
		agent,
		vscode.window.registerWebviewViewProvider('theoremdesk.agent', agent, { webviewOptions: { retainContextWhenHidden: true } }),
		vscode.commands.registerCommand('theoremdesk.agent.newChat', () => agent.newChat()),
		vscode.commands.registerCommand('theoremdesk.agent.ask', (text?: string) => agent.ask(typeof text === 'string' ? text : undefined)),
		vscode.commands.registerCommand('theoremdesk.agent.chooseModel', () => providers.choose()),
		vscode.commands.registerCommand('theoremdesk.agent.openCodex', () => openCliAgent(context, 'codex')),
		vscode.commands.registerCommand('theoremdesk.agent.openClaudeCode', () => openCliAgent(context, 'claude')),
	);

	if (!context.globalState.get<boolean>(GETTING_STARTED_SHOWN)) {
		void context.globalState.update(GETTING_STARTED_SHOWN, true);
		void openGettingStarted(context);
	}

	void openPendingReadme(context);
	void openPendingDocument(context);
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
