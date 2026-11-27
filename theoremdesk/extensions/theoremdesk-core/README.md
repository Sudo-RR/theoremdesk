# TheoremDesk core extension

Built into TheoremDesk. It adds:

- **TheoremDesk: New Research Project...** (also under File → New File...), which creates a project from a template in `templates/`.
- The **Get started with TheoremDesk** walkthrough, opened on first launch.
- **Literature**: search across arXiv, INSPIRE-HEP, zbMATH Open, Crossref and OpenAlex, recommendations for the open project, Add to bibliography, and a literature MCP server for agents (see below).
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
