#!/usr/bin/env bash
# TheoremDesk branding, read by VSCodium's scripts (utils.sh fills the
# !!APP_NAME!!-style placeholders in patches from these).
#
# Sourced by theoremdesk/build.sh. CI workflows must export the same values.

export APP_NAME="TheoremDesk"
export BINARY_NAME="theoremdesk"
export ORG_NAME="TheoremDesk"
export GH_REPO_PATH="${GH_REPO_PATH:-Sudo-RR/theoremdesk}"
export ASSETS_REPOSITORY="${ASSETS_REPOSITORY:-${GH_REPO_PATH}}"
export TUNNEL_APP_NAME="${BINARY_NAME}-tunnel"

# There is no TheoremDesk update feed yet. Keep updates off so the app never
# reads VSCodium's feed and "updates" itself into VSCodium.
export DISABLE_UPDATE="${DISABLE_UPDATE:-yes}"

# The Rust CLI (`theoremdesk tunnel`) still points at VSCodium's update and
# download endpoints in build_cli.sh, and it isn't needed for the desktop app.
# Leave it off until TheoremDesk has its own release feed.
export SHOULD_BUILD_CLI="${SHOULD_BUILD_CLI:-no}"
