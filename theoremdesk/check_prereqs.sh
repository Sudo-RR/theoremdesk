#!/usr/bin/env bash
# Check the tools a local TheoremDesk build needs and say how to install
# anything missing. Exits 1 if a required tool is missing.
#
# Set TD_ALLOW_NODE_MISMATCH=yes to build with a Node major version other
# than the one in .nvmrc (not recommended).

set -u
cd "$( dirname "${BASH_SOURCE[0]}" )/.." || exit 1

MISSING=0
ok()   { printf '  ok       %-10s %s\n' "$1" "$2"; }
fail() { printf '  MISSING  %-10s %s\n' "$1" "$2"; MISSING=1; }

case "${OSTYPE}" in
  msys* | cygwin*) WIN="yes" ;;
  *) WIN="no" ;;
esac

hint() { if [[ "${WIN}" == "yes" ]]; then echo "$1"; else echo "$2"; fi; }

echo "TheoremDesk build prerequisites:"

for tool in git curl unzip sha256sum; do
  if command -v "${tool}" > /dev/null 2>&1; then
    ok "${tool}" "$( command -v "${tool}" )"
  else
    fail "${tool}" "install it with your package manager"
  fi
done

if command -v jq > /dev/null 2>&1; then
  ok "jq" "$( jq --version )"
else
  fail "jq" "$( hint 'winget install --id jqlang.jq -e' 'brew install jq, or apt install jq' )"
fi

WANT_NODE="$( cat .nvmrc )"
if command -v node > /dev/null 2>&1; then
  HAVE_NODE="$( node --version | sed 's/^v//' )"
  if [[ "${HAVE_NODE%%.*}" == "${WANT_NODE%%.*}" ]]; then
    ok "node" "${HAVE_NODE}"
  elif [[ "${TD_ALLOW_NODE_MISMATCH:-no}" == "yes" ]]; then
    ok "node" "${HAVE_NODE} (.nvmrc wants ${WANT_NODE}; mismatch allowed)"
  else
    fail "node" "have ${HAVE_NODE}, need ${WANT_NODE}: nvm install ${WANT_NODE}, then nvm use ${WANT_NODE}"
  fi
else
  fail "node" "need ${WANT_NODE} (nodejs.org, or nvm)"
fi

PY_VERSION_CODE='import sys; print("%d.%d.%d" % sys.version_info[:3])'
PYTHON=""
for candidate in python3 python; do
  if version="$( "${candidate}" -c "${PY_VERSION_CODE}" 2> /dev/null )"; then
    PYTHON="${candidate} ${version}"
    break
  fi
done
if [[ -z "${PYTHON}" && "${WIN}" == "yes" ]] && version="$( py -3 -c "${PY_VERSION_CODE}" 2> /dev/null )"; then
  PYTHON="py -3 ${version}"
fi
if [[ -n "${PYTHON}" ]]; then
  ok "python" "${PYTHON} (VSCodium builds with 3.11)"
else
  fail "python" "$( hint 'winget install --id Python.Python.3.11 -e' 'install Python 3.11' )"
fi

if [[ "${WIN}" == "yes" ]]; then
  VSWHERE="/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"
  has_vs_component() {
    [[ -x "${VSWHERE}" ]] && [[ -n "$( "${VSWHERE}" -products '*' -requires "$1" -property installationPath 2> /dev/null )" ]]
  }
  VC_TOOLS="Microsoft.VisualStudio.Component.VC.Tools.x86.x64"
  SPECTRE="Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre"
  VS_INSTALL="winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override \"--passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add ${SPECTRE}\""
  if has_vs_component "${VC_TOOLS}"; then
    ok "C++ tools" "Visual Studio C++ build tools"
    if has_vs_component "${SPECTRE}"; then
      ok "Spectre" "MSVC Spectre-mitigated libraries"
    else
      VS_PATH="$( "${VSWHERE}" -products '*' -requires "${VC_TOOLS}" -property installationPath 2> /dev/null | head -1 | tr -d '\r' )"
      fail "Spectre" "MSVC Spectre-mitigated libraries. Add them to your existing Visual Studio (from an admin PowerShell):"
      echo "             & \"C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\setup.exe\" modify --installPath \"${VS_PATH}\" --add ${SPECTRE} --passive"
    fi
  else
    fail "C++ tools" "${VS_INSTALL}"
  fi
fi

if [[ "${SHOULD_BUILD_CLI:-no}" != "no" ]]; then
  if command -v cargo > /dev/null 2>&1; then
    ok "cargo" "$( cargo --version )"
  else
    fail "cargo" "$( hint 'winget install --id Rustlang.Rustup -e' 'https://rustup.rs' ) (needed because SHOULD_BUILD_CLI is on)"
  fi
fi

if [[ "${MISSING}" != "0" ]]; then
  echo "Install the missing tools above, then run the build again."
  exit 1
fi
