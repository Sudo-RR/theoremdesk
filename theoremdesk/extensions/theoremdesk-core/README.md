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

## Mutation testing: does the Lean code verify what you meant?

**Mutation Test This File** is the fifth mode of the Run button on Lean files. TheoremDesk makes small changes (mutants) to the open file and compiles each one with `lake env lean`, several at a time:

- **Definitions** (`def`, `abbrev`, `instance` bodies): `cos` ↔ `sin`, `min` ↔ `max`, `+` ↔ `-`, `*` ↔ `/`, `<`/`≤`/`>`/`≥`, `=` ↔ `≠`, `∧` ↔ `∨`, numbers ±1. Some theorem should stop compiling. If none does, no theorem constrains that part of the definition.
- **Theorem statements**, keeping each proof: dropping a hypothesis binder, plus the operators above. The proof should break. A survivor means the hypothesis is unused, or the conclusion says less than intended, or the hypotheses contradict each other.

Statement mutants that only make the statement weaker are skipped, because the old proof may still work by logic alone: a weaker conclusion (`<` → `≤`, `∧` → `∨`), a stronger hypothesis (`≤` → `<`), or a flipped hypothesis, which usually contradicts the others. Number changes can't be classed as stronger or weaker, so some of their survivors are noise.

Each mutant is **killed** (a proof broke), **survived**, **stillborn** (the mutant itself doesn't elaborate), or **timed out**. Survivors appear in the **Mutations** view and as warnings in the editor at the exact spot; click one to compare the mutant with your file. Theorems proved by `sorry` can't catch anything, so they're skipped and listed.

The file must compile first; build the project (`lake build`) before testing. Prior art: [Mutate.lean](https://github.com/jubnzv/Mutate.lean) (definitions; no licence, so not bundled), [Specmut](https://github.com/TylerRector/Specmut) and [lean-audit](https://github.com/Futlas/lean-audit) (statements).

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
