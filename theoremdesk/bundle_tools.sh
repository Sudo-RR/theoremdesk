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
#   resources/tools/ai         llama.cpp (llama-server) and the local models:
#                              Qwen3.5-9B for the agent, Qwen3-Embedding-0.6B
#                              for the literature database
#
# Every download is pinned in tools/tools.json and checked against its
# SHA-256. Downloads are cached in theoremdesk/.cache/tools.
#
# Usage: theoremdesk/bundle_tools.sh <app resources dir> <platform>
#   e.g. theoremdesk/bundle_tools.sh VSCode-win32-x64/resources win32-x64

set -euo pipefail
# Stop on errors inside $( ... ) too: every download and value is read that way.
shopt -s inherit_errexit

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

# JSON is read with Node, or Python 3 where there's no Node. Each must
# actually run: on Windows, "python3" may be only the Microsoft Store alias.
if node -e "0" > /dev/null 2>&1; then
  JSON_TOOL=node
elif python3 -c "0" > /dev/null 2>&1; then
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
  if [[ -z "${url}" || ! "${sha}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "TheoremDesk: tools.json has no valid url and sha256 for $1 on ${PLATFORM}" >&2
    exit 1
  fi
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

# TD_BUNDLE_ONLY="ai" (or "python tex lean git ai") bundles just those parts
# into an app that already has the rest; by default everything is bundled.
want() { [[ -z "${TD_BUNDLE_ONLY:-}" || " ${TD_BUNDLE_ONLY} " == *" $1 "* ]]; }

fresh() { # fresh <dir>: remove and recreate
  rm -rf "${1:?}"
  mkdir -p "$1"
}

# --- Python ---------------------------------------------------------------
if want python; then
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
fi

# --- TeX ------------------------------------------------------------------
if want tex; then
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
# Bring TinyTeX up to the current TeX Live release first: packages from the
# repository (like latex-lab) must match the LaTeX kernel they run on, and
# tlmgr refuses to install anything until it has updated itself. Then add
# the packages the templates need. test_offline.sh compiles every template.
mapfile -t TEX_PACKAGES < <( sed -e 's/#.*//' -e 's/[[:space:]]*$//' "${TD_DIR}/tools/tex-packages.txt" | grep -v '^$' )
echo "TheoremDesk: updating TinyTeX to the current TeX Live"
"${TLMGR}" update --self > /dev/null
"${TLMGR}" update --all > /dev/null
echo "TheoremDesk: adding ${#TEX_PACKAGES[@]} TeX packages for the templates"
"${TLMGR}" install "${TEX_PACKAGES[@]}" > /dev/null
fi

# --- Lean -----------------------------------------------------------------
if want lean; then
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
fi

# --- Git (Windows; Lake uses it, and Windows doesn't ship it) ---------------
if want git; then
GIT_VERSION=""
if GIT_URL="$( field git url 2> /dev/null )" && [[ -n "${GIT_URL}" ]]; then
  GIT_ARCHIVE="$( fetch git )"
  echo "TheoremDesk: unpacking Git"
  fresh "${DEST}/git"
  unzip -q -o "${GIT_ARCHIVE}" -d "${DEST}/git"
  "${DEST}/git/cmd/git" --version
  GIT_VERSION="$( field git version )"
fi
fi

# --- Local AI: llama.cpp and the models it runs -------------------------
if want ai; then
# llama-server answers OpenAI-style chat (with tool calls) and embeddings on
# localhost. The Vulkan build uses any GPU (NVIDIA, AMD, Intel) and falls
# back to its CPU backend when there's none. Models are copied, not
# unpacked: GGUF files are loaded directly.
LLAMA_ARCHIVE="$( fetch llama )"
CHAT_MODEL="$( fetch chat-model )"
EMBED_MODEL="$( fetch embedding-model )"
echo "TheoremDesk: unpacking llama.cpp and copying the models"
fresh "${DEST}/ai/llama"
mkdir -p "${DEST}/ai/models"
WORK="$( mktemp -d )"
case "${LLAMA_ARCHIVE}" in
  *.zip) unzip -q "${LLAMA_ARCHIVE}" -d "${WORK}" ;;
  *) tar -xzf "${LLAMA_ARCHIVE}" -C "${WORK}" ;;
esac
# The archive holds the binaries either at its top or in one folder.
SERVER="$( find "${WORK}" -type f \( -name llama-server -o -name llama-server.exe \) | head -1 )"
[[ -n "${SERVER}" ]] || { echo "TheoremDesk: no llama-server in ${LLAMA_ARCHIVE}" >&2; exit 1; }
cp -R "$( dirname "${SERVER}" )/." "${DEST}/ai/llama/"
rm -rf "${WORK}"
chmod +x "${DEST}"/ai/llama/llama-* 2> /dev/null || true
# Linux builds need GCC's OpenMP runtime, which minimal systems lack. The
# binaries look for libraries in their own folder first, so ship it there.
if GOMP_URL="$( field libgomp url 2> /dev/null )" && [[ -n "${GOMP_URL}" ]]; then
  GOMP_DEB="$( fetch libgomp )"
  WORK="$( mktemp -d )"
  if command -v dpkg-deb > /dev/null; then
    dpkg-deb -x "${GOMP_DEB}" "${WORK}"
  else
    ( cd "${WORK}" && ar x "${GOMP_DEB}" && tar -xf data.tar.* )
  fi
  cp -P "${WORK}"/usr/lib/x86_64-linux-gnu/libgomp.so.1* "${DEST}/ai/llama/"
  rm -rf "${WORK}"
fi
for model in "${CHAT_MODEL}" "${EMBED_MODEL}"; do
  # Copy only if changed: these are gigabytes.
  target="${DEST}/ai/models/$( basename "${model}" )"
  if [[ ! -f "${target}" ]] || ! cmp -s <( stat -c %s "${model}" ) <( stat -c %s "${target}" ); then
    cp "${model}" "${target}"
  fi
done
# Remove models no longer pinned.
for old in "${DEST}"/ai/models/*.gguf; do
  case "$( basename "${old}" )" in
    "$( basename "${CHAT_MODEL}" )" | "$( basename "${EMBED_MODEL}" )") ;;
    *) rm -f "${old}" ;;
  esac
done
"${DEST}/ai/llama/$( basename "${SERVER}" )" --version 2>&1 | grep -i 'version' | head -1
cat > "${DEST}/ai/models.json" << EOF
{
	"llama": "$( field llama version )",
	"chat": { "file": "$( basename "${CHAT_MODEL}" )", "name": "$( field chat-model version )" },
	"embedding": { "file": "$( basename "${EMBED_MODEL}" )", "name": "$( field embedding-model version )" }
}
EOF
fi

# --- Record what's bundled -----------------------------------------------
# (Only for a full bundle; the local AI records itself in ai/models.json.)
[[ -n "${TD_BUNDLE_ONLY:-}" ]] || cat > "${DEST}/bundled.json" << EOF
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
