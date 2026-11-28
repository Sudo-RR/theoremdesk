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
	} catch (error) {
		step('the in-app test runs', false, String(error && error.stack ? error.stack : error));
	}
	save('finished');
};
