#!/usr/bin/env bash
# Run Lean's multi-kernel checks on a Lean project, sandboxed, inside WSL.
#
# Usage: wsl-verify.sh <lean project dir, as a WSL path> check|paranoid
#        wsl-verify.sh <lean project dir, as a WSL path> comparator <config, relative to the project>
#
# The project is copied into the Linux file system (~/.theoremdesk/verify/),
# keeping Linux build files apart from Windows ones. Mathlib's prebuilt cache
# is downloaded there; then `lake check --paranoid` (or `lake comparator
# --paranoid`) builds, exports and replays the project through Lean's kernel
# and every external checker bundled with Lean, inside a bwrap sandbox.

set -euo pipefail

SRC="${1:?usage: wsl-verify.sh <project> check|paranoid|comparator [config]}"
MODE="${2:?usage: wsl-verify.sh <project> check|paranoid|comparator [config]}"
CONFIG="${3:-comparator.json}"

export PATH="${HOME}/.elan/bin:${PATH}"
export COMPARATOR_BWRAP="${HOME}/.theoremdesk/tools/bwrap"

if [[ ! -x "${COMPARATOR_BWRAP}" ]] || ! command -v lake > /dev/null; then
  echo "TheoremDesk's WSL tools aren't set up. Run Set Up Kernel Checks in the Environment view." >&2
  exit 2
fi

ID="$( basename "$( dirname "${SRC}" )" )-$( printf '%s' "${SRC}" | sha1sum | cut -c1-8 )"
DEST="${HOME}/.theoremdesk/verify/${ID}"
mkdir -p "${DEST}"

echo "== Copying ${SRC} to ${DEST}"
# .lake stays on each side: Windows and Linux build files don't mix.
rsync -a --delete --exclude '.lake/' --exclude '.git/' "${SRC}/" "${DEST}/"
cd "${DEST}"

echo "== Fetching dependencies"
lake env true
if grep -q '"name": *"mathlib"' lake-manifest.json 2> /dev/null; then
  lake exe cache get
fi

case "${MODE}" in
  check)
    echo "== lake check"
    exec lake check
    ;;
  paranoid)
    echo "== lake check --paranoid"
    exec lake check --paranoid
    ;;
  comparator)
    echo "== lake comparator --paranoid --config ${CONFIG}"
    exec lake comparator --paranoid --config "${CONFIG}"
    ;;
  *)
    echo "unknown mode: ${MODE}" >&2
    exit 2
    ;;
esac
