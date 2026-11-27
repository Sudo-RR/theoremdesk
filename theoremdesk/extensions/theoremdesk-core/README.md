# TheoremDesk core extension

Built into TheoremDesk. It adds:

- **TheoremDesk: New Research Project...** (also under File → New File...), which creates a project from a template in `templates/`.
- The **Get started with TheoremDesk** walkthrough, opened on first launch.
- The **Environment** view (⊢ icon in the activity bar) and status bar item. They check Git, Python, Lean (elan), TeX and Windows long-path support, plus the open project's `.venv`, Lean version, prebuilt Mathlib and Lean build. Each problem has a one-click fix that runs in its own terminal. The checks live in `src/checks.ts` and don't use the VS Code API, so they're tested against a fake machine.
- Research defaults: basedpyright as the Python language server (`python.languageServer: None`).

## Developing

```bash
npm ci
npm test        # compile, then test the project generator against the real templates
```

`theoremdesk/build.sh` compiles this extension and installs it as a built-in extension. To update an existing build without rebuilding everything:

```bash
bash theoremdesk/build_local_extensions.sh VSCode-win32-x64/resources/app/extensions
```

## Templates

Each folder in `templates/` with a `template.json` is a template. Files are copied as they are, except that:

- `{{NAME}}` placeholders are filled from `template.json`'s `variables` and from `PROJECT_NAME` and `PROJECT_TITLE`;
- names starting with `dot-` are renamed to start with `.` (`dot-gitignore` → `.gitignore`).

Pinned versions, such as the Lean toolchain and Physlib release, live in `template.json`.
