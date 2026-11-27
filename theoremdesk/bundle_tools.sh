#!/usr/bin/env bash
# Bundle the research toolchain into a built TheoremDesk app, so nothing
# needs installing to get started:
#
#   resources/tools/python     Python (python-build-standalone) with the
#                              packages in tools/python-requirements.lock
#                              (SymPy, NumPy, SciPy, Matplotlib, Plotly,
#                              Jupyter's ipykernel)
#   resources/tools/tinytex    TinyTeX (TeX Live): pdflatex, bibtex, and the
#                              packages in tools/tex-packages.txt
#   resources/tools/lean       elan (installer, and a ready bin/ in elan-home)
#                              and a Lean toolchain; TheoremDesk copies elan and
#                              links the toolchain into its own elan home on
#                              first launch
#   resources/tools/git        Git for Windows (MinGit); Lake uses Git
#
# Every download is pinned in tools/tools.json and checked against its
# SHA-256. Downloads are cached in theoremdesk/.cache/tools.
#
# Usage: theoremdesk/bundle_tools.sh <app resources dir> <platform>
#   e.g. theoremdesk/bundle_tools.sh VSCode-win32-x64/resources win32-x64

set -euo pipefail

TD_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
RESOURCES="${1:?usage: bundle_tools.sh <app resources dir> <platform>}"
PLATFORM="${2:?usage: bundle_tools.sh <app resources dir> <platform>}"
MANIFEST="${TD_DIR}/tools/tools.json"
CACHE="${TD_DIR}/.cache/tools"
DEST="${RESOURCES}/tools"

if [[ ! -d "${RESOURCES}/app" ]]; then
  echo "TheoremDesk: ${RESOURCES} doesn't look like a built app's resources folder" >&2
  exit 1
fi
mkdir -p "${CACHE}" "${DEST}"

# JSON is read with Node, or Python 3 where there's no Node.
if command -v node > /dev/null; then
  JSON_TOOL=node
elif command -v python3 > /dev/null; then
  JSON_TOOL=python3
else
  echo "TheoremDesk: bundling needs node or python3 to read tools.json" >&2
  exit 1
fi

field() { # field <tool> <key>
  if [[ "${JSON_TOOL}" == "node" ]]; then
    node -e '
      const m = require(process.argv[1]);
      const entry = (m[process.argv[2]] || {})[process.argv[3]];
      if (!entry) { console.error(`TheoremDesk: no ${process.argv[3]} for ${process.argv[2]} in tools.json`); process.exit(3); }
      const value = entry[process.argv[4]];
      console.log(value === undefined ? "" : value);
    ' "${MANIFEST}" "${PLATFORM}" "$1" "$2"
  else
    python3 -c '
import json, sys
m = json.load(open(sys.argv[1], encoding="utf-8"))
entry = m.get(sys.argv[2], {}).get(sys.argv[3])
if entry is None:
    sys.exit(f"TheoremDesk: no {sys.argv[3]} for {sys.argv[2]} in tools.json")
print(entry.get(sys.argv[4], ""))
' "${MANIFEST}" "${PLATFORM}" "$1" "$2"
  fi
}

fetch() { # fetch <tool>  ->  prints the cached file path
  local url sha file actual
  url="$( field "$1" url )"
  sha="$( field "$1" sha256 )"
  file="${CACHE}/$( basename "${url//%2B/+}" )"
  if [[ ! -f "${file}" ]]; then
    echo "TheoremDesk: downloading $1 from ${url}" >&2
    curl -sSfL "${url}" -o "${file}.part"
    mv "${file}.part" "${file}"
  fi
  actual="$( sha256sum "${file}" | cut -d' ' -f1 )"
  if [[ "${actual}" != "${sha}" ]]; then
    echo "TheoremDesk: SHA-256 mismatch for $1 (got ${actual}); deleted the download" >&2
    rm -f "${file}"
    exit 1
  fi
  echo "${file}"
}

fresh() { # fresh <dir>: remove and recreate
  rm -rf "${1:?}"
  mkdir -p "$1"
}

# --- Python ---------------------------------------------------------------
PYTHON_ARCHIVE="$( fetch python )"
echo "TheoremDesk: unpacking Python"
fresh "${DEST}/python"
tar -xzf "${PYTHON_ARCHIVE}" -C "${DEST}" # the archive's top folder is python/
case "${PLATFORM}" in
  win32-*) PYTHON="${DEST}/python/python.exe" ;;
  *) PYTHON="${DEST}/python/bin/python3" ;;
esac
echo "TheoremDesk: installing Python packages"
"${PYTHON}" -m pip install --quiet --disable-pip-version-check --no-warn-script-location \
  -r "${TD_DIR}/tools/python-requirements.lock"
"${PYTHON}" -c 'import sympy, numpy, scipy, matplotlib, plotly, ipykernel; print("Python packages import")'

# --- TeX ------------------------------------------------------------------
TEX_ARCHIVE="$( fetch tinytex )"
echo "TheoremDesk: unpacking TinyTeX"
fresh "${DEST}/tinytex"
case "${TEX_ARCHIVE}" in
  *.exe)
    # A 7-Zip self-extracting archive containing TinyTeX/.
    WORK="$( mktemp -d )"
    "${TEX_ARCHIVE}" -y -o"$( cygpath -w "${WORK}" 2> /dev/null || echo "${WORK}" )" > /dev/null
    cp -R "${WORK}/TinyTeX/." "${DEST}/tinytex/"
    rm -rf "${WORK}"
    TLMGR="${DEST}/tinytex/bin/windows/tlmgr.bat"
    ;;
  *.tar.xz | *.tar.gz | *.tgz)
    tar -xf "${TEX_ARCHIVE}" -C "${DEST}/tinytex" --strip-components=1
    TLMGR="$( ls "${DEST}"/tinytex/bin/*/tlmgr | head -1 )"
    ;;
esac
# Add only the packages TinyTeX-1 doesn't already have. A TinyTeX release
# can be older than the TeX Live repository, in which case tlmgr refuses to
# install anything until it has updated itself.
KPSEWHICH="$( dirname "${TLMGR}" )/kpsewhich"
mapfile -t TEX_PACKAGES < <( grep -vE '^\s*(#|$)' "${TD_DIR}/tools/tex-packages.txt" )
MISSING_TEX=()
for package in "${TEX_PACKAGES[@]}"; do
  if [[ -z "$( "${KPSEWHICH}" "${package}.sty" 2> /dev/null | tr -d '\r' )" ]]; then
    MISSING_TEX+=("${package}")
  fi
done
if [[ ${#MISSING_TEX[@]} -gt 0 ]]; then
  echo "TheoremDesk: adding TeX packages: ${MISSING_TEX[*]}"
  "${TLMGR}" update --self > /dev/null
  "${TLMGR}" install "${MISSING_TEX[@]}" > /dev/null
else
  echo "TheoremDesk: TinyTeX already has ${TEX_PACKAGES[*]}"
fi

# --- Lean -----------------------------------------------------------------
ELAN_ARCHIVE="$( fetch elan )"
LEAN_ARCHIVE="$( fetch lean )"
TOOLCHAIN="$( field lean toolchain )"
TOOLCHAIN_DIR="$( echo "${TOOLCHAIN}" | sed 's|/|--|g; s|:|---|g' )" # elan's folder name
echo "TheoremDesk: unpacking elan and ${TOOLCHAIN}"
fresh "${DEST}/lean"
mkdir -p "${DEST}/lean/toolchains"
case "${ELAN_ARCHIVE}" in
  *.zip) unzip -q -o "${ELAN_ARCHIVE}" -d "${DEST}/lean" ;;
  *) tar -xzf "${ELAN_ARCHIVE}" -C "${DEST}/lean" ;;
esac
WORK="$( mktemp -d )"
case "${LEAN_ARCHIVE}" in
  *.zip) unzip -q "${LEAN_ARCHIVE}" -d "${WORK}" ;;
  *.tar.zst) tar --use-compress-program=unzstd -xf "${LEAN_ARCHIVE}" -C "${WORK}" ;; # needs zstd
  *) tar -xf "${LEAN_ARCHIVE}" -C "${WORK}" ;;
esac
mv "${WORK}"/lean-* "${DEST}/lean/toolchains/${TOOLCHAIN_DIR}"
rm -rf "${WORK}"
printf '%s\n' "${TOOLCHAIN}" > "${DEST}/lean/toolchains.txt"

# Lay out elan's bin folder (elan plus its lean/lake proxies) now, so first
# launch only copies files into TheoremDesk's own elan home: no installer
# runs on the user's machine.
case "${PLATFORM}" in
  win32-*) ELAN_INIT="${DEST}/lean/elan-init.exe" ;;
  *) ELAN_INIT="${DEST}/lean/elan-init" ;;
esac
ELAN_HOME="${DEST}/lean/elan-home" "${ELAN_INIT}" -y --default-toolchain none --no-modify-path > /dev/null
find "${DEST}/lean/elan-home" -mindepth 1 -maxdepth 1 ! -name bin -exec rm -rf {} +
ls "${DEST}/lean/elan-home/bin" > /dev/null

# --- Git (Windows; Lake uses it, and Windows doesn't ship it) ---------------
GIT_VERSION=""
if GIT_URL="$( field git url 2> /dev/null )" && [[ -n "${GIT_URL}" ]]; then
  GIT_ARCHIVE="$( fetch git )"
  echo "TheoremDesk: unpacking Git"
  fresh "${DEST}/git"
  unzip -q -o "${GIT_ARCHIVE}" -d "${DEST}/git"
  "${DEST}/git/cmd/git" --version
  GIT_VERSION="$( field git version )"
fi

# --- Record what's bundled -----------------------------------------------
cat > "${DEST}/bundled.json" << EOF
{
	"platform": "${PLATFORM}",
	"python": "$( field python version )",
	"tinytex": "$( field tinytex version )",
	"elan": "$( field elan version )",
	"git": "${GIT_VERSION}",
	"lean": ["${TOOLCHAIN}"]
}
EOF

# (No size report: walking tens of thousands of files is very slow on Windows.)
echo "TheoremDesk: bundled tools in ${DEST}"
