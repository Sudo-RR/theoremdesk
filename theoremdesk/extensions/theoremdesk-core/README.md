# TheoremDesk core extension

Built into TheoremDesk. It adds:

- **TheoremDesk: New Research Project...** (also under File → New File...), which creates a project from a template in `templates/`.
- The **Get started with TheoremDesk** walkthrough, opened on first launch.
- The **Environment** view (⊢ icon in the activity bar) and status bar item. They check Git, Python, Lean (elan), TeX and Windows long-path support, plus the open project's `.venv`, Lean version, prebuilt Mathlib and Lean build. Each problem has a one-click fix that runs in its own terminal. The checks live in `src/checks.ts` and don't use the VS Code API, so they're tested against a fake machine.
- Research defaults: basedpyright as the Python language server (`python.languageServer: None`).

## Verifying proofs with several kernels

Lean files get a **Run** button with a dropdown. VS Code remembers the mode you last used:

| Mode | Runs | |
|---|---|---|
| Build Lean Project | `lake build` | Everyday compile. |
| Check with Lean Kernel | `lake check` | Sandboxed; Lean's kernel, standard axioms only. Fast. |
| Verify with All Kernels | `lake check --paranoid` | Sandboxed; Lean's kernel plus `leanchecker-paranoid`, `lean4lean`, `nanoda`, `con-leche` and `con-ron` must all accept. A proof that exploits a bug in one kernel is caught by the others. Slow: every kernel replays all the Mathlib declarations the project uses. |
| Check Proof Against Statement | `lake comparator --paranoid` | Pick a file whose theorems end in `sorry` (the statement) and a file that proves them (for example, the research agent's). Confirms the proof states exactly the same theorems, adds no axioms, and passes all six kernels. |

Results appear in the **Verification** view, with each kernel's verdict and the axioms used. If kernels disagree, the result says so.

The sandbox is `bwrap`, which needs Linux:

- **Linux:** runs directly; the Environment view installs `bubblewrap` if it's missing.
- **Windows:** runs in WSL2. `scripts/wsl-setup.sh` installs elan and `bwrap` in your WSL home folder without `sudo`. `scripts/wsl-verify.sh` copies the project into WSL's file system, keeping Linux build files apart from Windows ones, fetches Mathlib's prebuilt files, and runs the check there.
- **macOS:** not available yet.

The checks need Lean v4.35.0 or later, where `lake check` and `lake comparator` became part of Lean.

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
