#!/usr/bin/env bash
# shellcheck disable=SC1091
#
# Build TheoremDesk locally: the unpackaged app, with bundled extensions.
# Installers are not built yet.
#
#   Windows (Git Bash):  bash theoremdesk/build.sh
#   macOS / Linux:       bash theoremdesk/build.sh
#
# Flags:
#   -s  reuse the VS Code source already in ./vscode instead of fetching it again
#   -n  don't bundle the extensions from theoremdesk/extensions.json
#       (TheoremDesk's own extensions in theoremdesk/extensions/ are always built)
#   -t  don't bundle Python, TeX and Lean (theoremdesk/tools/tools.json)
#
# This follows VSCodium's documented downstream build (export the variables,
# then get_repo.sh and build.sh) rather than dev/build.sh, which hardcodes
# VSCodium's names.

set -e

cd "$( dirname "${BASH_SOURCE[0]}" )/.."

SKIP_SOURCE="no"
SKIP_EXTENSIONS="no"
SKIP_TOOLS="no"

while getopts ":snt" opt; do
  case "${opt}" in
    s) SKIP_SOURCE="yes" ;;
    n) SKIP_EXTENSIONS="yes" ;;
    t) SKIP_TOOLS="yes" ;;
    *) echo "usage: bash theoremdesk/build.sh [-s] [-n] [-t]" >&2; exit 2 ;;
  esac
done

. theoremdesk/env.sh

export CI_BUILD="no"
export SHOULD_BUILD="yes"
export SHOULD_BUILD_REH="no"
export SHOULD_BUILD_REH_WEB="no"
export VSCODE_LATEST="no"
export VSCODE_QUALITY="stable"
export VSCODE_SKIP_NODE_VERSION_CHECK="yes"
export NODE_OPTIONS="--max-old-space-size=8192"

case "${OSTYPE}" in
  darwin*) export OS_NAME="osx" ;;
  msys* | cygwin*) export OS_NAME="windows" ;;
  *) export OS_NAME="linux" ;;
esac

case "$( uname -m )" in
  aarch64 | arm64) export VSCODE_ARCH="arm64" ;;
  armv7l) export VSCODE_ARCH="armhf" ;;
  *) export VSCODE_ARCH="x64" ;;
esac

echo "TheoremDesk: building ${APP_NAME} for ${OS_NAME}-${VSCODE_ARCH}"

bash theoremdesk/check_prereqs.sh

if [[ "${SKIP_SOURCE}" == "no" ]]; then
  rm -rf vscode VSCode-*

  . get_repo.sh
  . version.sh

  {
    echo "MS_TAG=\"${MS_TAG}\""
    echo "MS_COMMIT=\"${MS_COMMIT}\""
    echo "RELEASE_VERSION=\"${RELEASE_VERSION}\""
    echo "BUILD_SOURCEVERSION=\"${BUILD_SOURCEVERSION}\""
  } > theoremdesk/build.env
else
  if [[ ! -f theoremdesk/build.env || ! -d vscode ]]; then
    echo "TheoremDesk: -s needs an earlier full build (no theoremdesk/build.env or ./vscode)" >&2
    exit 1
  fi

  . theoremdesk/build.env
  export MS_TAG MS_COMMIT RELEASE_VERSION BUILD_SOURCEVERSION

  # Undo the patches from the previous build, as dev/build.sh does.
  (
    cd vscode
    git add .
    git reset -q --hard HEAD
    while git log -1 | grep -q "VSCODIUM HELPER"; do
      git reset -q --hard HEAD~
    done
    rm -rf .build out*
  )
  rm -rf VSCode-*
fi

. build.sh

case "${OS_NAME}" in
  windows) PLATFORM="win32" ;;
  osx) PLATFORM="darwin" ;;
  *) PLATFORM="linux" ;;
esac

APP_DIR="VSCode-${PLATFORM}-${VSCODE_ARCH}"

if [[ "${OS_NAME}" == "osx" ]]; then
  EXTENSIONS_DIR="${APP_DIR}/${APP_NAME}.app/Contents/Resources/app/extensions"
else
  EXTENSIONS_DIR="${APP_DIR}/resources/app/extensions"
fi

if [[ "${SKIP_EXTENSIONS}" == "no" ]]; then
  bash theoremdesk/bundle_extensions.sh "${EXTENSIONS_DIR}" "${PLATFORM}-${VSCODE_ARCH}"
fi

bash theoremdesk/build_local_extensions.sh "${EXTENSIONS_DIR}"

if [[ "${SKIP_TOOLS}" == "no" ]]; then
  RESOURCES_DIR="$( dirname "$( dirname "${EXTENSIONS_DIR}" )" )"
  bash theoremdesk/bundle_tools.sh "${RESOURCES_DIR}" "${PLATFORM}-${VSCODE_ARCH}"

  # A build whose built-in toolchain doesn't work offline, from a clean
  # first launch, must never ship.
  if ! bash theoremdesk/test_offline.sh "${RESOURCES_DIR}"; then
    echo "TheoremDesk: BUILD FAILED. The built-in toolchain didn't pass the offline test above." >&2
    exit 1
  fi
fi

{ set +x; } 2> /dev/null
echo "TheoremDesk: build finished in ./${APP_DIR}"
