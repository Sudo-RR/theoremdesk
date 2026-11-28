# TheoremDesk core extension

Built into TheoremDesk. It adds:

- **TheoremDesk: New Research Project...** (also under File → New File...), which creates a project from a template in `templates/`.
- The **New Project Wizard** (below): define a project by choosing options and describing your research; TheoremDesk sets it up, finds the literature and fills the bibliography.
- The **Get started with TheoremDesk** walkthrough, opened on first launch.
- **Literature**: search across arXiv, INSPIRE-HEP, zbMATH Open, Crossref and OpenAlex, recommendations for the open project, Add to bibliography, and a literature MCP server for agents (see below).
- The **Environment** view (⊢ icon in the activity bar) and status bar item. They check Git, Python, Lean (elan), TeX and Windows long-path support, plus the open project's `.venv`, Lean version, prebuilt Mathlib and Lean build. Each problem has a one-click fix that runs in its own terminal. The checks live in `src/checks.ts` and don't use the VS Code API, so they're tested against a fake machine.
- Research defaults: basedpyright as the Python language server (`python.languageServer: None`).

## The New Project Wizard

**TheoremDesk: New Project Wizard** (also under File → New File..., and opened when TheoremDesk starts without a folder: `theoremdesk.wizard.showOnStartup`) defines a project in five steps and does the work:

1. **Project:** what you're starting (paper, Lean formalisation, computation, thesis, talk, report), the field, the journal you're aiming for (which sets the template and reference style), and the parts: a Lean project, notebooks, Git.
2. **Your research:** a few lines on what you study, what you want to find out, how, and in which setting. **Check my brief** has the AI judge whether that's specific enough to search with; if not, it asks up to three short questions, which you can answer or skip.
3. **Search plan:** the AI turns the brief into a working title, keywords and 3 to 5 searches, one per part of the brief (object, method, question, related results). Everything is editable, and the sources are preset for the field: INSPIRE for high-energy physics, zbMATH for mathematics.
4. **Papers:** every search runs on every chosen source. The results are merged, ranked by meaning against your brief (local embedding model), and the AI reads the abstracts of the 15 closest. It rates each from 3 (on your topic) to 0 (not relevant) with a one-line reason. Papers rated 2 or 3 are ticked; change the ticks, or add papers you know by arXiv ID or DOI.
5. **Create:** the project folder, with:
   - `manuscript/` from the chosen template, with the brief as a comment in the abstract, the reading list in `references.bib` (INSPIRE's own entries where it has them) and listed with `\nocite` until you cite each one, and the journal's reference style;
   - `lean/` with Physlib (physics) or Mathlib (mathematics), pinned to the bundled Lean;
   - `notebooks/01_start.ipynb`, a `README.md` with the brief, the search plan and the reading list with `\cite` keys, and `.theoremdesk/project.json`.

   The project opens, the chosen papers are read into the Library in the background, and the agent offers to draft the introduction from the reading list (as an edit you review).

**How the prompts keep a small local model reliable.** Each AI step has one job and a short list of numbered rules. It gets a worked example, and runs at temperature 0.2 without the slow step-by-step thinking. Its answer must be JSON matching a schema, which llama.cpp enforces while the model writes.

Every answer is then checked:
- **Retry once:** an unusable answer is retried once, with the reason it was rejected.
- **Allowed values only:** arXiv categories must come from the field's list.
- **No invented papers:** a paper the plan says you named is dropped unless its words appear in your brief.
- **Every paper rated:** the relevance ratings must cover every paper exactly once.

Every step also works without the AI: the plan falls back to your brief's main terms, and papers are ranked by similarity alone.

On a laptop with integrated graphics, a run takes 5 to 7 minutes, most of it the relevance ratings. The AI steps use the model chosen for the agent: TheoremDesk Local, or an API.

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

## Literature: search, recommendations, Add to bibliography

Five free, public sources, none of which needs a key:

| Source | Covers | Brings |
|---|---|---|
| arXiv | Preprints in physics, mathematics, CS | Abstracts, categories, PDFs |
| INSPIRE-HEP | High-energy physics, gravitation, cosmology | The citation keys physicists use (`Maldacena:1997re`), INSPIRE's own BibTeX, citation counts |
| zbMATH Open | Mathematics | Reviews and summaries, MSC classes, journal details |
| Crossref | Every journal with DOIs (APS, Springer, Elsevier, IOP, AMS, ...) | Publication details |
| OpenAlex | All fields | Related works for recommendations, citation counts |

The **Literature** view (in the ⊢ sidebar):

- **Search Literature** asks every chosen source at once and merges the results: a paper found by several sources appears once, matched by DOI or arXiv ID, with its abstract from arXiv, its journal, volume and pages from INSPIRE, Crossref or zbMATH, and its INSPIRE key. Each paper shows which sources found it. Results alternate between sources, so no single source crowds out the rest. A source that's down is reported, and the others' results still show.
- **Choose Literature Sources** (the filter button) picks the sources; the choice is the `theoremdesk.literature.sources` setting.
- **Recommend Papers for This Project** reads the open manuscript (its title and abstract count most, then the text and the titles already in the `.bib`), searches the sources for its main terms, adds works OpenAlex relates to the papers already cited, ranks everything by text similarity (TF-IDF), and leaves out papers already in the bibliography.
- Hover a paper for its abstract, journal, identifiers and citation count; click to open it. **+** adds it to the project's `.bib` (asking which one if there are several, or offering to create `references.bib`) and puts `\cite{key}` on the clipboard. Papers already cited show a tick and their key, matched by arXiv ID or DOI.

The entry added is INSPIRE's own when INSPIRE has the paper (looked up by arXiv ID or DOI if it came from another source), so physics bibliographies get the standard keys. Otherwise a published paper is an `@article` with journal, volume, number, pages and DOI, keeping arXiv's `eprint`, `archivePrefix` and `primaryClass` when there's a preprint; a preprint alone is `@misc` in arXiv's recommended form. Accented names are converted to LaTeX so `pdflatex` handles them. The offline test compiles entries made from real records from all five sources with plain, unsrtnat, apsrev4-2, IEEEtran, naturemag, pnas2009 and amsplain.

Each source has its own rate limit, below what the service asks (arXiv one request every three seconds, INSPIRE 15 every five seconds), and requests identify themselves only as "TheoremDesk (literature search)". A recommendation sends a handful of the manuscript's most frequent words and the DOIs or arXiv IDs already in its `.bib`, never the manuscript.

The engine (`src/literature.ts`) merges records and writes BibTeX; each source (`src/sources.ts`) implements the `LiteratureSource` interface, so more can be added. Semantic Scholar was left out because it refuses requests without an API key.

### The literature MCP server

The same tools are an MCP server, `out/mcp/literatureServer.js` (stdio, no dependencies):

| Tool | Does |
|---|---|
| `search_literature` | Search all sources at once, merged (query, sources, max_results, sort: relevance, recent or cited) |
| `search_arxiv` | Search arXiv alone, with its own syntax (query, max_results, category, sort) |
| `recommend_papers` | Recommend papers for a `.tex` file or a description, skipping those in a `.bib` |
| `get_bibtex` | The BibTeX entry for an arXiv ID or DOI (INSPIRE's own entry when it has the paper) |
| `add_to_bibliography` | Add a paper, by arXiv ID or DOI, to a `.bib` file (once) and return the key to cite |

Inside TheoremDesk it's offered to agents automatically ("TheoremDesk Literature", with the sources chosen in the Literature view). Elsewhere, `THEOREMDESK_LITERATURE_SOURCES=arxiv,inspire,zbmath,crossref,openalex` picks them (default: all). Other agents can run it with TheoremDesk's own runtime, so no separate Node is needed; for example, in an MCP client's configuration:

```json
{
  "command": "C:\\path\\to\\TheoremDesk\\TheoremDesk.exe",
  "args": ["C:\\path\\to\\TheoremDesk\\resources\\app\\extensions\\theoremdesk.theoremdesk-core\\out\\mcp\\literatureServer.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

## Local AI

TheoremDesk ships with its own AI that runs on your machine, offline and free:

| | Model | Size | Licence |
|---|---|---|---|
| Agent | Qwen3.5-9B (Q4_K_M) | 5.7 GB | Apache 2.0 |
| Literature database (embeddings) | Qwen3-Embedding-0.6B (Q8_0) | 0.6 GB | Apache 2.0 |
| Runtime | llama.cpp `llama-server` b12774 (v1.1.0), Vulkan + CPU | 40 MB | MIT |

Among models that fit a laptop, Qwen3.5-9B leads published maths and physics benchmarks: GPQA Diamond 81.7, HMMT 83, and 75% on a benchmark of PhD-qualifying-exam physics problems (arXiv 2503.21821), close to Gemma 4 31B at a third of the size.

- **When it runs:** each model starts the first time something needs it and stops after `theoremdesk.ai.idleMinutes` (default 15) unused, freeing its memory. The status bar shows what's running and on which device; click it to start, stop or switch models.
- **Hardware:** the Vulkan build uses any GPU (NVIDIA, AMD, Intel, including integrated graphics) and falls back to the CPU. As a guide, a Core Ultra 7 155U laptop with integrated graphics generates about 5 tokens a second with the 9B.
- **Smaller machines:** with less than 15 GB of memory, TheoremDesk offers Qwen3.5-4B once (3 GB, about twice as fast). **TheoremDesk: Download a Local AI Model** fetches it, resuming interrupted downloads and checking its SHA-256. Downloaded models live in TheoremDesk's data folder (`%LOCALAPPDATA%\TheoremDesk\models`), and **Choose the Local AI Model** switches between them.
- **Privacy:** each model server listens only on 127.0.0.1, on a random port, with a random key, so other programs on the machine can't use it. Nothing leaves the machine.

### The Library: your literature database

The **Library** view (in the ⊢ sidebar) holds papers read in full, on your machine, shared by all your projects:

- **Adding papers:** **+** in the Literature view adds a paper to your `.bib` and to the library (`theoremdesk.library.addCitedPapers`). **Add the Bibliography** reads every paper your `.bib` files cite by arXiv ID or DOI. **Add PDFs** takes local files. A paper's text comes from its free PDF (arXiv, or an open-access link), read with the bundled Python's `pypdf`; without one, its abstract is indexed instead, and the view says so.
- **Indexing:** the text is split into passages of about 1,200 characters at sentence ends, overlapping slightly. Each is embedded with Qwen3-Embedding-0.6B, together with the paper's title and abstract. On a laptop with integrated graphics a 20-page paper takes about 30 seconds.
- **Search the Library** finds passages by meaning, not keywords, at most three per paper, dropping passages far less relevant than the best. Picking one opens the paper at that page.
- **Ask the Library** answers a question with the local agent model from the closest passages only. Every claim cites its source by number, and the answer lists each source with its paper and page, linked. If the sources don't answer the question, the answer says so. An answer citing a source it wasn't given is flagged.

The library is stored in TheoremDesk's data folder (`library/`: `papers.json`, `chunks.jsonl`, `vectors.f32`), written atomically. Damaged files are set aside rather than silently lost.

### The Agent

The **Agent** view (in the ⊢ sidebar), or **TheoremDesk: Ask the Agent**, is a research assistant that works in your project. The answer streams in as it's written, with mathematics typeset (KaTeX, bundled, so it works offline), and each tool call appears as a card you can expand to see its result. It's told about the open file and any selected text (including unsaved changes). The chat is saved with the project (in its storage folder, after every turn) and comes back when you reopen it; **New** starts a fresh one.

| Tool | Does | Asks first |
|---|---|---|
| `search_literature` | Searches arXiv, INSPIRE-HEP, zbMATH Open, Crossref and OpenAlex | |
| `search_library` | Finds passages in your library, with paper and page | |
| `list_files`, `read_file` | Reads the project | |
| `add_to_bibliography` | Adds a paper to the `.bib` and returns its key | yes |
| `write_file`, `edit_file` | Creates or changes a file; you review it as a diff first | yes |
| `check_lean` | Compiles a Lean file (`lake env lean`); says plainly if it uses `sorry` | yes |
| `compile_latex` | Runs pdflatex (and bibtex) and returns the errors | yes |
| `run_python` | Runs Python with SymPy, NumPy and SciPy | yes |
| `run_command` | Runs a terminal command in the project (PowerShell on Windows, bash on Linux), e.g. `lake build` or `git status`; stops after 5 minutes | yes |

Every path must be inside the open project. Anything that changes files or runs code needs approval each time, or for the rest of the chat if you choose; the approval shows the exact code or command. Lean is included because Lean files can run arbitrary programs while they compile.

**Reviewing edits:** each change the agent proposes opens as a side-by-side diff (your file on the left, the proposed file on the right) with **Apply**, **Apply All in This Chat** or cancel. An applied change goes through the editor and is saved, and the file opens, so **Ctrl+Z** undoes it like your own typing.

**The model** (the Model button in the view):

- **TheoremDesk Local**, the default: the bundled Qwen3.5-9B, offline and free. On a laptop with integrated graphics, a task using three tools takes about a minute and a half.
- **OpenAI API**, **Anthropic API** (its OpenAI-compatible endpoint), or **another OpenAI-compatible API** (OpenRouter, Hugging Face, a server of your own), with your key. Keys are kept in the operating system's secure storage and sent only to that provider.
- **ChatGPT Plus/Pro** or **Claude Pro/Max**: these plans work through the providers' own agents, so TheoremDesk opens **Codex** or **Claude Code** in a terminal in your project, with its literature tools attached. Claude Code gets them for that session (`--mcp-config`). For Codex, TheoremDesk asks before running `codex mcp add theoremdesk-literature`, which changes Codex's settings. If the tool isn't installed, TheoremDesk links to its install page.

`theoremdesk.agent.thinking` lets the local model reason step by step before answering: better on hard problems, much slower on a laptop. `theoremdesk.agent.maxSteps` (default 12) limits how many model calls one message can make.

`src/llm.ts` starts the servers and is an OpenAI-compatible client (chat with tool calls, and embeddings), so a remote provider can be used the same way. The offline test (`tests/local_ai.js`) runs both models with the network cut: the agent must answer, and call a tool with valid arguments, and the embedding model must rank the relevant passage first.

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
