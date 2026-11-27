#!/usr/bin/env bash
# Prepare a WSL distro for TheoremDesk's sandboxed kernel checks.
#
# Installs, in the user's home and without sudo:
#   - elan (Lean's version manager), with no default toolchain; each project
#     installs the Lean version it pins
#   - bubblewrap (bwrap), the sandbox `lake check` and `lake comparator` need,
#     unpacked from Ubuntu's package into ~/.theoremdesk/tools
#
# Safe to run again: it skips whatever is already there.

set -euo pipefail

TOOLS="${HOME}/.theoremdesk/tools"
mkdir -p "${TOOLS}"

if [[ -x "${HOME}/.elan/bin/elan" ]]; then
  echo "elan: already installed"
else
  echo "Installing elan..."
  curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o "${TOOLS}/elan-init.sh"
  bash "${TOOLS}/elan-init.sh" -y --default-toolchain none --no-modify-path
  rm -f "${TOOLS}/elan-init.sh"
fi

if [[ -x "${TOOLS}/bwrap" ]]; then
  echo "bwrap: already installed"
elif command -v bwrap > /dev/null; then
  ln -sf "$( command -v bwrap )" "${TOOLS}/bwrap"
  echo "bwrap: using $( command -v bwrap )"
else
  echo "Fetching bubblewrap..."
  WORK="$( mktemp -d )"
  trap 'rm -rf "${WORK}"' EXIT
  # The distro's package lists may be stale, and refreshing them needs root,
  # so fall back to refreshing a private copy of the lists.
  APT_DIR="${HOME}/.theoremdesk/apt"
  APT_PRIVATE=(-o Debug::NoLocking=1 -o Dir::State::Lists="${APT_DIR}/lists" -o Dir::Cache="${APT_DIR}/cache")
  if ! ( cd "${WORK}" && apt-get download bubblewrap > /dev/null 2>&1 ); then
    mkdir -p "${APT_DIR}/lists/partial" "${APT_DIR}/cache/archives/partial"
    if ! ( apt-get "${APT_PRIVATE[@]}" update > /dev/null 2>&1 \
        && cd "${WORK}" && apt-get "${APT_PRIVATE[@]}" download bubblewrap > /dev/null 2>&1 ); then
      echo "Couldn't download the bubblewrap package. Install it yourself, then run this again:" >&2
      echo "  sudo apt-get update && sudo apt-get install -y bubblewrap" >&2
      exit 1
    fi
  fi
  dpkg-deb -x "${WORK}"/bubblewrap_*.deb "${WORK}/pkg"
  cp "${WORK}/pkg/usr/bin/bwrap" "${TOOLS}/bwrap"
  chmod +x "${TOOLS}/bwrap"
  echo "bwrap: installed in ${TOOLS}"
fi

if "${TOOLS}/bwrap" --ro-bind / / --unshare-user --unshare-pid --dev /dev --proc /proc true; then
  echo "Sandbox works."
else
  echo "bwrap is installed but can't create a sandbox: this distro doesn't allow unprivileged user namespaces." >&2
  exit 1
fi
