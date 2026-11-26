#!/usr/bin/env bash
# Install the extensions pinned in theoremdesk/extensions.json as built-in
# extensions of a built TheoremDesk app.
#
# Each extension is downloaded from Open VSX (the platform-specific build if
# one exists, otherwise the universal one), checked against the SHA-256 the
# registry publishes, and unpacked into the app's extensions folder.
# Downloads are cached in theoremdesk/.cache/extensions.
#
# Usage: theoremdesk/bundle_extensions.sh <app extensions dir> <target platform>
#   e.g. theoremdesk/bundle_extensions.sh VSCode-win32-x64/resources/app/extensions win32-x64

set -euo pipefail

TD_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
DEST="${1:?usage: bundle_extensions.sh <app extensions dir> <target platform>}"
TARGET="${2:?usage: bundle_extensions.sh <app extensions dir> <target platform>}"
CACHE="${TD_DIR}/.cache/extensions"
MANIFEST="${TD_DIR}/extensions.json"

if [[ ! -d "${DEST}" ]]; then
  echo "TheoremDesk: extensions folder not found: ${DEST}" >&2
  exit 1
fi

mkdir -p "${CACHE}"

json_field() { # json_field <expression on j> ; reads JSON from stdin
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const v=('"$1"');if(v===undefined||v===null)process.exit(3);console.log(v)})'
}

REGISTRY="$( json_field 'j.registry' < "${MANIFEST}" )"
ENTRIES="$( json_field 'j.extensions.map(e=>e.id+" "+e.version).join("\n")' < "${MANIFEST}" )"

while read -r ID VERSION; do
  NAMESPACE="${ID%%.*}"
  NAME="${ID#*.}"

  META=""
  FOUND_TARGET=""
  for T in "${TARGET}" "universal"; do
    if META="$( curl -sf "${REGISTRY}/api/${NAMESPACE}/${NAME}/${T}/${VERSION}" )"; then
      FOUND_TARGET="${T}"
      break
    fi
  done

  if [[ -z "${FOUND_TARGET}" ]]; then
    echo "TheoremDesk: ${ID}@${VERSION} has no ${TARGET} or universal build on ${REGISTRY}" >&2
    exit 1
  fi

  DOWNLOAD_URL="$( json_field 'j.files.download' <<< "${META}" )"
  SHA_URL="$( json_field 'j.files.sha256' <<< "${META}" )"
  VSIX="${CACHE}/${ID}-${VERSION}@${FOUND_TARGET}.vsix"

  EXPECTED="$( curl -sfL "${SHA_URL}" | awk '{print tolower($1)}' )"
  if [[ ! "${EXPECTED}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "TheoremDesk: no valid SHA-256 published for ${ID}@${VERSION}" >&2
    exit 1
  fi

  if [[ ! -f "${VSIX}" ]]; then
    echo "TheoremDesk: downloading ${ID}@${VERSION} (${FOUND_TARGET})"
    curl -sfL "${DOWNLOAD_URL}" -o "${VSIX}.part"
    mv "${VSIX}.part" "${VSIX}"
  fi

  ACTUAL="$( sha256sum "${VSIX}" | awk '{print $1}' )"
  if [[ "${ACTUAL}" != "${EXPECTED}" ]]; then
    rm -f "${VSIX}"
    echo "TheoremDesk: SHA-256 mismatch for ${ID}@${VERSION}; deleted the download" >&2
    exit 1
  fi

  # Unpack the whole package: some unzip builds stop `extension/*` at the
  # first directory level and silently drop everything below it.
  WORK="$( mktemp -d )"
  unzip -q "${VSIX}" -d "${WORK}"

  INSTALLED_VERSION="$( json_field 'j.version' < "${WORK}/extension/package.json" )"
  if [[ "${INSTALLED_VERSION}" != "${VERSION}" ]]; then
    echo "TheoremDesk: ${ID} package.json says ${INSTALLED_VERSION}, expected ${VERSION}" >&2
    rm -rf "${WORK}"
    exit 1
  fi

  ENTRY="$( json_field 'j.main || ""' < "${WORK}/extension/package.json" )"
  if [[ -n "${ENTRY}" && ! -f "${WORK}/extension/${ENTRY}" && ! -f "${WORK}/extension/${ENTRY}.js" ]]; then
    echo "TheoremDesk: ${ID} entry point ${ENTRY} is missing after unpacking" >&2
    rm -rf "${WORK}"
    exit 1
  fi

  rm -rf "${DEST:?}/${ID}"
  mv "${WORK}/extension" "${DEST}/${ID}"
  rm -rf "${WORK}"

  echo "TheoremDesk: bundled ${ID}@${VERSION} (${FOUND_TARGET})"
done <<< "${ENTRIES}"
