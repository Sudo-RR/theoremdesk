#!/usr/bin/env bash
# Prove the bundled toolchain works with no network.
#
# Usage: theoremdesk/test_offline.sh <app resources dir>
#   e.g. theoremdesk/test_offline.sh VSCode-win32-x64/resources
#
# The network is cut first:
#   - Linux: the script re-runs itself in a new network namespace
#     (`unshare -rn`), where there is no network at all.
#   - Elsewhere: every proxy variable points at a dead port and pip's index
#     is turned off, so any download attempt fails.
# Then, on a simulated clean machine (an empty, throwaway TheoremDesk data
# folder; your own ~/.elan and settings are never touched):
#   First launch  the core extension's own compiled bootstrap (out/bootstrap.js)
#                 sets up Lean, Python, LaTeX and Git and proves each runs; a
#                 second launch changes nothing; a broken Lean is repaired; and
#                 nothing is ever written into the installed bundle
#   Lean    with the environment first launch gives the app, a fresh Lake
#           project builds (using the bundled Git on Windows)
#   Python  a project .venv is created from the bundled Python, the
#           template's requirements.txt is satisfied without downloading,
#           and both template notebooks run
#   LaTeX   the template manuscript compiles with pdflatex and bibtex,
#           including the notebooks' generated equations and figures
#           and so does every LaTeX template (test_templates.sh)
#
# Needs Node to run the extension's code (TD_NODE overrides which one).

set -uo pipefail

TD_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
RESOURCES="$( cd "${1:?usage: test_offline.sh <app resources dir>}" && pwd )"
TOOLS="${RESOURCES}/tools"
TEMPLATE="${TD_DIR}/extensions/theoremdesk-core/templates/hamiltonian"

# --- Cut the network --------------------------------------------------------
if [[ -z "${TD_OFFLINE:-}" && "${OSTYPE}" == linux* ]] && command -v unshare > /dev/null; then
  exec env TD_OFFLINE=netns unshare -rn bash "$0" "$@"
fi
if [[ "${TD_OFFLINE:-}" == "netns" ]]; then
  # A new network namespace starts with even loopback down. An offline
  # machine still has loopback, and the local AI's servers listen on it.
  ip link set lo up 2> /dev/null || echo "TheoremDesk offline test: couldn't bring up loopback (no ip command?)"
fi
if [[ -z "${TD_OFFLINE:-}" ]]; then
  export TD_OFFLINE=proxy
  for v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    export "${v}=http://127.0.0.1:9"
  done
  # Everything goes to a dead proxy, except this machine itself (the local AI).
  export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
fi
export PIP_NO_INDEX=1 PIP_DISABLE_PIP_VERSION_CHECK=1

case "${OSTYPE}" in
  msys* | cygwin*)
    WIN=yes
    PY="${TOOLS}/python/python.exe"
    TEXBIN="${TOOLS}/tinytex/bin/windows"
    ELAN_INIT="${TOOLS}/lean/elan-init.exe"
    VENV_PY="venv/Scripts/python.exe"
    ;;
  *)
    WIN=no
    PY="${TOOLS}/python/bin/python3"
    TEXBIN="$( ls -d "${TOOLS}"/tinytex/bin/*/ 2> /dev/null | head -1 )"
    ELAN_INIT="${TOOLS}/lean/elan-init"
    VENV_PY="venv/bin/python"
    ;;
esac
# The bundle must be complete before anything else means something.
MISSING=()
for required in "${TOOLS}/bundled.json" "${PY}" "${TEXBIN%/}" "${ELAN_INIT}" "${TOOLS}/lean/elan-home/bin" "${TOOLS}/lean/toolchains.txt"; do
  [[ -e "${required}" ]] || MISSING+=("${required}")
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "TheoremDesk offline test: the bundle in ${TOOLS} is incomplete; missing:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  echo "Run theoremdesk/bundle_tools.sh first." >&2
  exit 2
fi

TOOLCHAIN="$( head -1 "${TOOLS}/lean/toolchains.txt" )"
TOOLCHAIN_DIR="$( echo "${TOOLCHAIN}" | sed 's|/|--|g; s|:|---|g' )"
if [[ ! -d "${TOOLS}/lean/toolchains/${TOOLCHAIN_DIR}/bin" ]]; then
  echo "TheoremDesk offline test: ${TOOLCHAIN} isn't in the bundle (${TOOLS}/lean/toolchains/${TOOLCHAIN_DIR})" >&2
  exit 2
fi

WORK="$( mktemp -d )"
trap 'rm -rf "${WORK}"' EXIT
FAILED=0
PASSED=0

check() { # check <name> <command...>: run it, show the tail of its output on failure
  local name="$1"
  shift
  local log="${WORK}/log.txt"
  if "$@" > "${log}" 2>&1; then
    PASSED=$(( PASSED + 1 ))
    echo "  ok    ${name}"
  else
    FAILED=$(( FAILED + 1 ))
    echo "  FAIL  ${name}"
    tail -15 "${log}" | sed 's/^/        /'
  fi
}

echo "TheoremDesk offline test: ${TOOLS} (network cut by ${TD_OFFLINE})"

# --- The network really is off ---------------------------------------------
no_network() { ! curl -sS -m 10 -o /dev/null https://github.com; }
check "network is unreachable" no_network

# --- First launch on a clean machine ------------------------------------
NODE="${TD_NODE:-node}"
OUT="${RESOURCES}/app/extensions/theoremdesk.theoremdesk-core/out" # the shipped extension
[[ -f "${OUT}/bootstrap.js" ]] || OUT="${TD_DIR}/extensions/theoremdesk-core/out" # a development checkout
DATA="${WORK}/TheoremDesk" # stands in for %LOCALAPPDATA%TheoremDesk
STAMP="${WORK}/before-launch"
touch "${STAMP}"
sleep 1

launch() { # launch <result file>: run the app's first-launch code
  "${NODE}" "${TD_DIR}/tests/first_launch.js" "${OUT}" "${RESOURCES}" "${DATA}" > "$1"
}
result() { # result <file> <python expression on r>
  "${PY}" -c "import json, sys; r = json.load(open(sys.argv[1])); print($2)" "$1"
}

check "first launch sets up Lean, Python, LaTeX and Git, and each one runs" launch "${WORK}/launch1.json"
if [[ -s "${WORK}/launch1.json" ]]; then
  result "${WORK}/launch1.json" "chr(10).join(('ok   ' if s['ok'] else 'FAIL ') + s['label'] + ': ' + s['detail'] for s in r['status'])" | sed 's/^/        /'
  export ELAN_HOME="$( result "${WORK}/launch1.json" "r['elanHome']" | tr -d '' )"
  APP_PATH="$( result "${WORK}/launch1.json" "r['path']" | tr -d '' )"
  [[ "${WIN}" == "yes" ]] && APP_PATH="$( cygpath -p "${APP_PATH}" )"
  export PATH="${APP_PATH}"
fi

second_launch_is_a_no_op() {
  launch "${WORK}/launch2.json" || return 1
  [[ "$( result "${WORK}/launch2.json" "len(r['repaired'])" | tr -d '' )" == "0" ]]
}
check "second launch changes nothing" second_launch_is_a_no_op

repairs_broken_lean() {
  rm -rf "${ELAN_HOME}/bin" || return 1
  rm -rf "${ELAN_HOME}/toolchains/${TOOLCHAIN_DIR}" || return 1 # removes the link, not the bundle
  [[ -d "${TOOLS}/lean/toolchains/${TOOLCHAIN_DIR}/bin" ]] || { echo "the bundle was damaged"; return 1; }
  launch "${WORK}/launch3.json" || return 1
  result "${WORK}/launch3.json" "r['repaired']"
}
check "a launch repairs a deleted elan and toolchain link" repairs_broken_lean

bundle_untouched() {
  local changed
  changed="$( find "${TOOLS}" -newer "${STAMP}" -print 2> /dev/null | grep -v '__pycache__' | head -5 )"
  [[ -z "${changed}" ]] || { echo "first launch wrote into the bundle:"; echo "${changed}"; return 1; }
}
check "first launch never writes into the installed bundle" bundle_untouched

# --- Lean, as the app runs it ----------------------------------------------
lean_version() { lean --version | tee /dev/stderr | grep -q "${TOOLCHAIN##*:v}"; }
check "lean --version is ${TOOLCHAIN##*:}" lean_version
check "git is available to Lake" git --version

lake_project() {
  cd "${WORK}" || return 1
  lake new demo || return 1
  cd demo || return 1
  # Add to the generated file: Main.lean uses its `hello`.
  cat >> Demo/Basic.lean << 'LEAN'

theorem two_add_two : 2 + 2 = 4 := rfl

theorem add_comm' (a b : Nat) : a + b = b + a := Nat.add_comm a b
LEAN
  lake build
}
check "a new Lake project builds" lake_project

# --- Python ------------------------------------------------------------------
cd "${WORK}" || exit 1
check "bundled Python runs" "${PY}" -c 'import sys; print(sys.version)'
check "SymPy, NumPy, SciPy, Matplotlib, Plotly, ipykernel import" \
  "${PY}" -c 'import sympy, numpy, scipy, matplotlib, plotly, ipykernel, nbformat'
check "a project .venv reuses the bundled packages" "${PY}" -m venv --system-site-packages venv
check "requirements.txt is satisfied without downloading" \
  "${WORK}/${VENV_PY}" -m pip install -r "${TEMPLATE}/requirements.txt"

# The template, generated the way New Research Project does (placeholders
# filled, dot- names renamed), using the bundled Python.
generate_project() {
  "${PY}" - "${TEMPLATE}" "${WORK}/project" << 'PYTHON'
import json, pathlib, re, shutil, sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
manifest = json.loads((src / "template.json").read_text(encoding="utf-8"))
values = {**manifest.get("variables", {}), "PROJECT_NAME": "project", "PROJECT_TITLE": manifest["defaultTitle"]}
for path in src.rglob("*"):
    if path.is_dir() or path.name == "template.json":
        continue
    rel = path.relative_to(src)
    out = dst.joinpath(*[("." + p[4:]) if p.startswith("dot-") else p for p in rel.parts])
    out.parent.mkdir(parents=True, exist_ok=True)
    text = path.read_text(encoding="utf-8")
    out.write_text(re.sub(r"\{\{([A-Z_]+)\}\}", lambda m: values.get(m.group(1), m.group(0)), text), encoding="utf-8")
PYTHON
}
check "the Hamiltonian template generates" generate_project

export MPLBACKEND=Agg PLOTLY_RENDERER=json
for notebook in 01_oscillator 02_pendulum; do
  check "notebook ${notebook} runs" "${WORK}/${VENV_PY}" "${TD_DIR}/tests/run_notebook.py" "${WORK}/project/notebooks/${notebook}.ipynb"
done
generated() {
  for f in generated/oscillator_eom.tex generated/oscillator_drift.tex generated/pendulum_eom.tex \
    generated/pendulum_period_check.tex figures/oscillator_phase.pdf figures/pendulum_period.pdf; do
    [[ -s "${WORK}/project/manuscript/${f}" ]] || { echo "missing ${f}"; return 1; }
  done
}
check "notebooks wrote the manuscript's equations and figures" generated

# --- LaTeX -------------------------------------------------------------------
export PATH="${TEXBIN%/}:${PATH}"
latex_build() {
  cd "${WORK}/project/manuscript" || return 1
  pdflatex -interaction=nonstopmode -halt-on-error main || return 1
  bibtex main || return 1
  pdflatex -interaction=nonstopmode -halt-on-error main || return 1
  pdflatex -interaction=nonstopmode -halt-on-error main || return 1
  [[ -s main.pdf ]] || return 1
  # Everything resolved: no missing citations, references or generated files.
  ! grep -E "Citation .* undefined|Reference .* undefined|run .* to generate" main.log
}
check "the manuscript compiles with pdflatex and bibtex" latex_build

# --- Every LaTeX template -----------------------------------------------------
while IFS= read -r line; do
  echo "${line}"
  case "${line}" in
    "  ok    "*) PASSED=$(( PASSED + 1 )) ;;
    "  FAIL  "*) FAILED=$(( FAILED + 1 )) ;;
  esac
done < <( bash "${TD_DIR}/test_templates.sh" "${TEXBIN}" "${PY}" 2>&1 )

# --- Every reference style TheoremDesk recommends exists ---------------------
styles_bundled() {
  local missing=() style
  while IFS= read -r style; do
    style="${style%$'\r'}"
    [[ -n "$( kpsewhich "${style}.bst" 2> /dev/null | tr -d '\r' )" ]] || missing+=("${style}")
  done < <( "${PY}" -c "import json, sys; d = json.load(open(sys.argv[1], encoding='utf-8')); print(chr(10).join(sorted({s['bibstyle'] for s in d['styles']} | {j['bibstyle'] for j in d['journals']})))" \
    "${TD_DIR}/extensions/theoremdesk-core/data/journals.json" )
  [[ ${#missing[@]} -eq 0 ]] || { echo "not in the bundled TeX: ${missing[*]}"; return 1; }
}
check "every reference style TheoremDesk recommends is bundled" styles_bundled

# --- BibTeX from every source (as Add to Bibliography writes it) compiles --
# Real records recorded from arXiv, INSPIRE-HEP (its own BibTeX), zbMATH
# Open, Crossref and OpenAlex: @misc preprints and @article publications.
literature_bibtex_compiles() {
  local dir="${WORK}/literature-bib" fixtures="${TD_DIR}/extensions/theoremdesk-core/test/fixtures" style
  mkdir -p "${dir}" && cd "${dir}" || return 1
  "${NODE}" -e '
    const [out, fx] = process.argv.slice(1); const fs = require("fs"); const path = require("path");
    const L = require(path.join(out, "literature.js")); const S = require(path.join(out, "sources.js"));
    const read = (f) => fs.readFileSync(path.join(fx, f), "utf8"); const json = (f) => JSON.parse(read(f));
    const inspire = S.parseInspire(json("inspire-search.json"));
    inspire[0].bibtex = read("inspire-maldacena.bib");
    const papers = [
      ...S.parseArxivAtom(read("arxiv-search.xml")), ...S.parseArxivAtom(read("arxiv-ids.xml")).filter((p) => p.arxivId !== "hep-th/9711200"),
      ...inspire, ...S.parseZbmath(json("zbmath-search.json")), ...S.parseCrossref(json("crossref-search.json")),
      ...S.parseOpenalex(json("openalex-search.json")), ...S.parseOpenalex(json("openalex-doi.json")),
    ];
    let bib = ""; for (const p of papers) bib = L.addToBib(bib, p).text;
    if (!/@article\{Maldacena:1997re,/.test(bib) || !/@article\{bender2007complex,/.test(bib)) { console.log("expected INSPIRE and zbMATH entries"); process.exit(1); }
    fs.writeFileSync("refs.bib", bib);' "${OUT}" "${fixtures}" || return 1
  for style in plain unsrtnat apsrev4-2 IEEEtran naturemag pnas2009 amsplain; do
    printf '%s\n' '\documentclass{article}' '\usepackage[numbers]{natbib}' '\usepackage{url}' '\begin{document}' \
      '\nocite{*}' "\\bibliographystyle{${style}}" '\bibliography{refs}' '\end{document}' > "${style}.tex"
    pdflatex -interaction=nonstopmode -halt-on-error "${style}" > /dev/null 2>&1 || { echo "${style}: pdflatex failed"; return 1; }
    bibtex "${style}" > "${style}.bibtex.txt" 2>&1 || { echo "${style}: bibtex failed"; cat "${style}.bibtex.txt"; return 1; }
    pdflatex -interaction=nonstopmode -halt-on-error "${style}" > /dev/null 2>&1 || { echo "${style}: pdflatex failed"; grep -m1 -A3 '^!' "${style}.log"; return 1; }
    if grep -E 'Undefined control sequence|Unicode character|Missing character' "${style}.log"; then return 1; fi
    [[ "$( grep -c '\\bibitem' "${style}.bbl" )" -ge 15 ]] || { echo "${style}: expected 15 entries"; return 1; }
  done
}
check "BibTeX from arXiv, INSPIRE, zbMATH, Crossref and OpenAlex compiles with 7 styles" literature_bibtex_compiles

# --- The local AI: models load, answer, call tools, embed --------------------
# Real inference with the bundled llama.cpp and models (tests/local_ai.js).
"${NODE}" "${TD_DIR}/tests/local_ai.js" "${OUT}" "${RESOURCES}" > "${WORK}/local_ai.json" 2> "${WORK}/local_ai.err"
while IFS=$'\t' read -r ok name detail; do
  if [[ "${ok}" == "True" ]]; then
    PASSED=$(( PASSED + 1 ))
    echo "  ok    ${name}"
    echo "        ${detail}"
  else
    FAILED=$(( FAILED + 1 ))
    echo "  FAIL  ${name}"
    printf '%s\n' "${detail}" | tail -15 | sed 's/^/        /'
  fi
done < <( "${PY}" -c '
import json, sys
try:
    r = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception as e:
    print("False\tthe local AI test runs\t" + open(sys.argv[2], encoding="utf-8").read()[-1500:].replace("\n", " | "))
    sys.exit()
for s in r["steps"]:
    print(str(s["ok"]) + "\t" + s["name"] + "\t" + str(s.get("detail", "")).replace("\t", " ").replace("\n", " | "))
' "${WORK}/local_ai.json" "${WORK}/local_ai.err" | tr -d '\r' )

echo
echo "TheoremDesk offline test: ${PASSED} passed, ${FAILED} failed"
[[ "${FAILED}" -eq 0 ]]
