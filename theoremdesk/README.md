# The TheoremDesk layer

This repository is a fork of [VSCodium](https://github.com/VSCodium/vscodium)'s build repo. It contains no VS Code source code; the scripts fetch a pinned VS Code release, patch it and build it.

Everything specific to TheoremDesk lives in this folder. Outside it there are two additions: `.github/README.md` (the repo's front page on GitHub, so VSCodium's own `README.md` stays untouched) and a short hook at the end of `prepare_vscode.sh` that sources `theoremdesk/prepare.sh`. Keeping it that way is what lets us take VSCodium's updates with a plain merge.

## Files

| File | What it does |
|---|---|
| `env.sh` | Branding values VSCodium's scripts read (`APP_NAME`, `BINARY_NAME`, `ORG_NAME`, repo paths). Also turns updates and the Rust CLI off for now. |
| `product.json` | Overrides merged last into VS Code's `product.json`: names, data folders, URL protocol, macOS bundle ID, Windows installer IDs. |
| `merge_product.js` | Does that merge, points the licence and issue links at this repo, and removes the update feed while `DISABLE_UPDATE=yes`. |
| `prepare.sh` | The hook. Copies resources from `src/stable/`, runs the merge, and replaces the "VSCodium" names VSCodium wrote into package and installer metadata. |
| `extensions.json` | Extensions bundled as built-in, pinned to exact Open VSX versions. |
| `bundle_extensions.sh` | Downloads those extensions, checks each against Open VSX's SHA-256, and unpacks them into the built app. |
| `extensions/` | TheoremDesk's own extensions, compiled and installed as built-ins. `theoremdesk-core` adds New Research Project, the getting-started walkthrough and research defaults. |
| `build_local_extensions.sh` | Compiles `extensions/*` and installs them into a built app. Run it on its own to update an existing build. |
| `check_prereqs.sh` | Lists missing build tools with the command to install each. |
| `build.sh` | Local build: prerequisites, fetch, patch, compile, bundle extensions. |
| `src/stable/` | TheoremDesk icons and resources, at the same paths as VSCodium's `src/stable/` (e.g. `resources/win32/code.ico`). Empty until there is a logo. |

Don't put comment keys in `product.json` or `extensions.json`: they are merged or read as data.

## Building locally

Run in Git Bash on Windows, or a shell on macOS/Linux:

```bash
bash theoremdesk/check_prereqs.sh   # see what's missing
bash theoremdesk/build.sh           # full build
bash theoremdesk/build.sh -s        # rebuild using the VS Code source already in ./vscode
bash theoremdesk/build.sh -n        # skip bundling extensions
```

To update only TheoremDesk's own extensions in an existing build, then restart the app:

```bash
bash theoremdesk/build_local_extensions.sh VSCode-win32-x64/resources/app/extensions
```

The app lands in `VSCode-<platform>-<arch>/`. On Windows, start `VSCode-win32-x64/TheoremDesk.exe`. A full build downloads the VS Code source, runs `npm ci` and compiles everything, so expect a long first run and plenty of disk use.

TheoremDesk keeps its settings and extensions apart from VS Code and VSCodium (`.theoremdesk` data folder, its own Windows installer IDs), so all three can be installed side by side.

## Taking VSCodium's updates

```bash
git fetch upstream
git merge upstream/master
```

The only place a conflict can appear is the hook at the end of `prepare_vscode.sh`. If VSCodium renames or moves something the hook relies on (`replace`, `setpath`, the files listed in `prepare.sh`), the build stops with an error and `prepare.sh` needs updating.

Each VSCodium release pins a VS Code version in `upstream/stable.json`, and its patches are written for that version. Build against that pin rather than the latest VS Code.

## Bundled extensions

| Extension | Why |
|---|---|
| `leanprover.lean4` | Lean 4, infoview, Mathlib and Physlib projects |
| `James-Yu.latex-workshop` | LaTeX editing, build and PDF preview |
| `ms-python.python`, `ms-python.debugpy`, `ms-python.vscode-python-envs` | Python, debugging, environments |
| `detachhead.basedpyright` | Python language server (Pylance is licensed for Microsoft's VS Code only) |
| `ms-toolsai.jupyter`, `ms-toolsai.jupyter-renderers` | Notebooks and rich outputs (Plotly, images, LaTeX) |
| `jeanp413.open-remote-ssh` | Remote development on clusters over SSH (Microsoft's Remote-SSH is licensed for VS Code only) |

To upgrade one, change its `version` in `extensions.json` and rebuild. Built-in extensions can be disabled but not uninstalled.

## Not done yet

- **Icons.** `src/stable/` is empty, so the app still uses VSCodium's icons.
- **Installers.** Windows `.exe`/`.msi`, macOS `.dmg`, Linux `.deb`/`.rpm`/AppImage/snap have not been built. `prepare.sh` rebrands their metadata, but `build/windows/msi/vscodium.wxs`, `build/linux/` and `stores/` still use VSCodium's names.
- **CI.** The workflows in `.github/workflows` are still VSCodium's. Leave GitHub Actions disabled on this repo until they export the values from `env.sh`.
- **Updates.** Off (`DISABLE_UPDATE=yes`) until there's a TheoremDesk release feed.
- **Rust CLI.** Off (`SHOULD_BUILD_CLI=no`); `build_cli.sh` points it at VSCodium's endpoints.
- **Insider builds.** Not branded; `prepare.sh` skips them.
- **Placeholder values.** The macOS bundle ID `org.theoremdesk.TheoremDesk` assumes a domain; change it before the first signed release, because it can't change afterwards without breaking updates.
- **Code signing** on Windows and macOS.
