#!/usr/bin/env bash
# Compile TheoremDesk's own extensions (theoremdesk/extensions/*) and install
# them as built-in extensions of a built app.
#
# Usage: theoremdesk/build_local_extensions.sh <app extensions dir>
#   e.g. theoremdesk/build_local_extensions.sh VSCode-win32-x64/resources/app/extensions
#
# Restart TheoremDesk afterwards to load the new version.

set -euo pipefail

TD_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="${1:?usage: build_local_extensions.sh <app extensions dir>}"

if [[ ! -d "${DEST}" ]]; then
  echo "TheoremDesk: extensions folder not found: ${DEST}" >&2
  exit 1
fi
DEST="$( cd "${DEST}" && pwd )"

# What a built-in extension needs at runtime. Sources, tests and
# node_modules (dev dependencies only) stay behind.
RUNTIME_ITEMS=(package.json package.nls.json README.md LICENSE out media scripts templates themes)

for EXT in "${TD_DIR}"/extensions/*/; do
  EXT="${EXT%/}"
  if [[ ! -f "${EXT}/package.json" ]]; then
    continue
  fi

  ID="$( node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);console.log(p.publisher+"."+p.name)})' < "${EXT}/package.json" )"
  echo "TheoremDesk: compiling ${ID}"

  (
    cd "${EXT}"
    npm ci --no-audit --no-fund --loglevel=error
    npm run compile --silent
  )

  rm -rf "${DEST:?}/${ID}"
  mkdir -p "${DEST}/${ID}"
  for ITEM in "${RUNTIME_ITEMS[@]}"; do
    if [[ -e "${EXT}/${ITEM}" ]]; then
      cp -R "${EXT}/${ITEM}" "${DEST}/${ID}/"
    fi
  done

  echo "TheoremDesk: installed ${ID} as a built-in extension"
done
