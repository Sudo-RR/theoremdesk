#!/usr/bin/env bash
# Compile every LaTeX template with a given TeX installation, offline-safe:
# generate it as New LaTeX Document would, then pdflatex, bibtex, pdflatex x2.
# A template passes only if the PDF is built with no errors and no undefined
# citations or references.
#
# Usage: theoremdesk/test_templates.sh <TeX bin dir> <python> [template id ...]
#   e.g. theoremdesk/test_templates.sh VSCode-win32-x64/resources/tools/tinytex/bin/windows \
#          VSCode-win32-x64/resources/tools/python/python.exe
#
# Prints one ok/FAIL line per template; exits non-zero if any failed.

set -uo pipefail

TD_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TEXBIN="${1:?usage: test_templates.sh <TeX bin dir> <python> [template ...]}"
PY="${2:?usage: test_templates.sh <TeX bin dir> <python> [template ...]}"
shift 2
TEMPLATES="${TD_DIR}/extensions/theoremdesk-core/latex-templates"
export PATH="${TEXBIN%/}:${PATH}"

if [[ $# -gt 0 ]]; then
  IDS=("$@")
else
  mapfile -t IDS < <( ls "${TEMPLATES}" )
fi

WORK="$( mktemp -d )"
trap 'rm -rf "${WORK}"' EXIT
FAILED=0

build() { # build <dir>
  cd "$1" || return 1
  pdflatex -interaction=nonstopmode -halt-on-error main > build.txt 2>&1 || return 1
  if grep -q '\\bibdata' main.aux 2> /dev/null; then
    bibtex main >> build.txt 2>&1 || return 1
  fi
  pdflatex -interaction=nonstopmode -halt-on-error main >> build.txt 2>&1 || return 1
  pdflatex -interaction=nonstopmode -halt-on-error main >> build.txt 2>&1 || return 1
  [[ -s main.pdf ]] || { echo "no PDF" >> build.txt; return 1; }
  if grep -E "Citation .* undefined|Reference .* undefined|There were undefined" main.log > undefined.txt; then
    cat undefined.txt >> build.txt
    return 1
  fi
}

for id in "${IDS[@]}"; do
  dir="${WORK}/${id}"
  "${PY}" "${TD_DIR}/tests/generate_template.py" "${TEMPLATES}/${id}" "${dir}" \
    "AUTHOR=Ada Lovelace" "YEAR=2026" || { echo "  FAIL  template ${id} (generating)"; FAILED=$(( FAILED + 1 )); continue; }
  if ( build "${dir}" ); then
    echo "  ok    template ${id} compiles"
  else
    echo "  FAIL  template ${id} compiles"
    # The first LaTeX error, with a few lines of context, or the tail.
    if grep -q '^!' "${dir}/build.txt"; then
      grep -A4 -m1 '^!' "${dir}/build.txt" | sed 's/^/        /'
    else
      tail -8 "${dir}/build.txt" | sed 's/^/        /'
    fi
    FAILED=$(( FAILED + 1 ))
  fi
done

[[ "${FAILED}" -eq 0 ]]
