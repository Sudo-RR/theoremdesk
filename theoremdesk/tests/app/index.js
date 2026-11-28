// Runs inside a built TheoremDesk (--extensionTestsPath): checks that the
// TheoremDesk extension activates with its commands, and that the agent
// answers a question about the open project using its tools, with the
// bundled local model. Writes the results as JSON to TD_APP_TEST_OUT.

const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = process.env.TD_APP_TEST_OUT || path.join(os.tmpdir(), 'td-app-test.json');
const vscode = require('vscode');

exports.run = async function run() {
	const results = [];
	// Written after every step, so a run that stalls still shows how far it got.
	const save = (stage) => fs.writeFileSync(OUT, JSON.stringify({ stage, steps: results }, null, 1));
	const step = (name, ok, detail) => {
		results.push({ name, ok: Boolean(ok), detail });
		save('running');
	};
	save('started');
	try {
		const ext = vscode.extensions.getExtension('theoremdesk.theoremdesk-core');
		await ext.activate();
		step('the TheoremDesk extension activates', ext.isActive, ext.packageJSON.version);

		// TD_APP_TEST_MODE=restore: only check that the last run's chat came back.
		if (process.env.TD_APP_TEST_MODE === 'restore') {
			const chat = ext.exports.testing.chat();
			const users = chat.display.filter((d) => d.kind === 'user').map((d) => d.text.slice(0, 50));
			step('the saved chat is restored when the project reopens', users.length >= 2 && chat.messages > 4, `${chat.messages} messages, ${chat.display.length} items; questions: ${users.join(' | ')}`);
			save('finished');
			return;
		}

		const commands = await vscode.commands.getCommands(true);
		const wanted = ['theoremdesk.agent.ask', 'theoremdesk.agent.chooseModel', 'theoremdesk.library.ask', 'theoremdesk.library.addPdf', 'theoremdesk.ai.status', 'theoremdesk.literature.search'];
		const missing = wanted.filter((c) => !commands.includes(c));
		step('agent, library and AI commands are registered', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : wanted.join(', '));

		save('asking the agent');
		const t = Date.now();
		const answer = await vscode.commands.executeCommand(
			'theoremdesk.agent.ask',
			'Read notes.md in this project and tell me the formula it gives for the pendulum period. Do not run any code.',
		);
		step(
			'the agent reads the project and answers (local model)',
			typeof answer === 'string' && /elliptic|K\s*\(|K\(/i.test(answer) && !/^Error/.test(answer),
			`${((Date.now() - t) / 1000).toFixed(0)} s: ${String(answer).replace(/\s+/g, ' ').slice(0, 300)}`,
		);

		// An edit: the change must open as a diff for review, apply through the
		// editor when accepted, and be undoable. The test answers the approval
		// dialog in place of the user, recording what was on screen.
		const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
		const notes = path.join(root, 'notes.md');
		const before = fs.readFileSync(notes, 'utf8');
		const asked = [];
		ext.exports.testing.answerApprovals((question, diffOpen) => {
			asked.push({ question, diffOpen });
			return /Apply the agent's change/.test(question) ? 'Apply' : undefined;
		});
		save('asking for an edit');
		const t2 = Date.now();
		let edited;
		try {
			edited = await vscode.commands.executeCommand(
				'theoremdesk.agent.ask',
				'In notes.md, use edit_file to replace the words "The pendulum period" with "The period of a pendulum". Change nothing else.',
			);
		} finally {
			ext.exports.testing.answerApprovals(() => undefined);
		}
		const after = fs.readFileSync(notes, 'utf8');
		step(
			'an agent edit opens as a diff, and is applied when accepted',
			asked.length > 0 && asked.every((a) => a.diffOpen) && after.includes('The period of a pendulum') && after !== before,
			`${((Date.now() - t2) / 1000).toFixed(0)} s; asked ${asked.length}x, diff open: ${asked.map((a) => a.diffOpen).join(',')}; file now: ${after.split('\n')[1]}; agent: ${String(edited).replace(/\s+/g, ' ').slice(0, 120)}`,
		);
		const doc = await vscode.workspace.openTextDocument(notes);
		await vscode.window.showTextDocument(doc);
		await vscode.commands.executeCommand('undo');
		step(
			'Undo in the editor reverts the agent edit',
			after !== before && doc.getText() === before,
			`${after === before ? 'nothing was edited, so nothing to undo; ' : ''}${doc.getText().split('\n')[1]}`,
		);
		await doc.save();
	} catch (error) {
		step('the in-app test runs', false, String(error && error.stack ? error.stack : error));
	}
	save('finished');
};
