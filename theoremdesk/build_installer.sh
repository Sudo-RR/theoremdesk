#!/usr/bin/env bash
# Build TheoremDesk's Windows installers from a finished build
# (VSCode-win32-x64, made by theoremdesk/build.sh), into ./assets:
#
#   TheoremDeskUserSetup-x64-<version>.exe   per-user install (recommended)
#   TheoremDeskSetup-x64-<version>.exe       all-users install (needs admin)
#   TheoremDesk-AI/                          the local AI models, for offline
#                                            installs (optional download)
#
# The installers hold everything except the local AI models, which don't
# fit (Windows can't run an installer over 4 GB). Setup installs the models
# itself, its second stage: from a TheoremDesk-AI folder placed next to the
# installer if there is one, else by downloading them. See installer/.
#
# Usage (Git Bash):  bash theoremdesk/build_installer.sh [user|system|both]

set -euo pipefail

cd "$( dirname "${BASH_SOURCE[0]}" )/.."
TARGETS="${1:-both}"
. theoremdesk/env.sh
[[ -f theoremdesk/build.env ]] && . theoremdesk/build.env
VERSION="${RELEASE_VERSION:-dev}"

[[ -d VSCode-win32-x64 ]] || { echo "TheoremDesk: build first (bash theoremdesk/build.sh)" >&2; exit 1; }

# Stage 2's model list must match the build's pinned models.
bash theoremdesk/installer/prepare_installer.sh vscode

mkdir -p assets
cd vscode
npm run gulp vscode-win32-x64-inno-updater
for target in user system; do
  [[ "${TARGETS}" == "both" || "${TARGETS}" == "${target}" ]] || continue
  echo "TheoremDesk: building the ${target} installer"
  npm run gulp "vscode-win32-x64-${target}-setup"
  name="${APP_NAME}$( [[ "${target}" == "user" ]] && echo User )Setup-x64-${VERSION}.exe"
  mv ".build/win32-x64/${target}-setup/VSCodeSetup.exe" "../assets/${name}"
  echo "TheoremDesk: assets/${name} ($( du -h "../assets/${name}" | cut -f1 ))"
done
cd ..

# The offline pack: the pinned model files, their checksums, a note.
PACK=assets/TheoremDesk-AI
mkdir -p "${PACK}"
for key in chat-model embedding-model; do
  file="$( node -e 'const m=require("./theoremdesk/tools/tools.json")["win32-x64"][process.argv[1]]; console.log(m.file)' "${key}" )"
  sha="$( node -e 'const m=require("./theoremdesk/tools/tools.json")["win32-x64"][process.argv[1]]; console.log(m.sha256)' "${key}" )"
  src="theoremdesk/.cache/tools/${file}"
  [[ -f "${src}" ]] || { echo "TheoremDesk: ${src} missing; run bundle_tools.sh first" >&2; exit 1; }
  [[ -f "${PACK}/${file}" ]] && cmp -s <( stat -c %s "${src}" ) <( stat -c %s "${PACK}/${file}" ) || cp "${src}" "${PACK}/${file}"
  echo "${sha}  ${file}"
done > "${PACK}/SHA256SUMS"
cat > "${PACK}/README.txt" << 'EOF'
TheoremDesk local AI models, for installing without internet.

Put this TheoremDesk-AI folder next to the TheoremDesk setup program, then
run setup: it installs the models from here instead of downloading them.
Setup checks each file against SHA256SUMS first and ignores any that don't
match.

With internet, you don't need this folder: setup downloads the models
itself (6.3 GB, once), and TheoremDesk offers the download if you skip it.
EOF
echo "TheoremDesk: ${PACK} (offline AI models)"
