#!/usr/bin/env bash
# shellcheck disable=SC2154
#
# TheoremDesk distribution layer.
#
# prepare_vscode.sh sources this from inside ./vscode, after VSCodium has
# applied its branding, patches and npm install. Every TheoremDesk change to
# the VS Code source tree happens here, so syncing with VSCodium stays a
# clean merge. `replace` comes from utils.sh, which prepare_vscode.sh loads.

theoremdesk_prepare() {
  local td_dir="../theoremdesk"
  local repo_url="https://github.com/${GH_REPO_PATH}"
  local f

  if [[ "${VSCODE_QUALITY}" == "insider" ]]; then
    echo "TheoremDesk: insider builds are not branded yet; leaving VSCodium branding" >&2
    return 0
  fi

  echo "TheoremDesk: applying distribution layer"

  # Icons and other resources, laid out like VSCodium's src/stable/.
  if [[ -d "${td_dir}/src/stable" ]]; then
    while IFS= read -r -d '' f; do
      mkdir -p "$( dirname "${f}" )"
      cp -p "${td_dir}/src/stable/${f}" "${f}"
      echo "TheoremDesk: resource ${f}"
    done < <( cd "${td_dir}/src/stable" && find . -type f ! -name '.gitkeep' -print0 )
  fi

  # product.json: names, IDs, data folders, links, update feed.
  node "${td_dir}/merge_product.js" product.json "${td_dir}/product.json"

  # Names VSCodium wrote into the app's own metadata.
  replace "s|VSCodium|${ORG_NAME}|g" package.json
  replace "s|VSCodium|${ORG_NAME}|g" build/lib/electron.ts
  setpath "resources/server/manifest" "name" "${APP_NAME}"
  setpath "resources/server/manifest" "short_name" "${APP_NAME}"

  # Installer and package metadata. Rebranded, but not built or tested yet.
  if [[ "${OS_NAME}" == "windows" ]]; then
    replace "s|https://vscodium.com|${repo_url}|g" build/win32/code.iss
    replace "s|VSCodium|${ORG_NAME}|g" build/win32/code.iss
    # Installer stage 2: the local AI models, installed by setup (see installer/).
    bash "${td_dir}/installer/prepare_installer.sh" .
  elif [[ "${OS_NAME}" == "linux" ]]; then
    for f in resources/linux/code.appdata.xml resources/linux/debian/control.template resources/linux/rpm/code.spec.template; do
      replace "s|VSCodium Team https://github.com/VSCodium/vscodium/graphs/contributors|${ORG_NAME} contributors ${repo_url}/graphs/contributors|g" "${f}"
      replace "s|https://github.com/VSCodium/vscodium#download-install|${repo_url}|g" "${f}"
      replace "s|https://vscodium.com/img/vscodium.png||g" "${f}"
      replace "s|https://vscodium.com|${repo_url}|g" "${f}"
      replace "s|VSCodium|${APP_NAME}|g" "${f}"
    done
    replace "s/(^|[^A-Za-z])codium([^A-Za-z-]|$)/\1${BINARY_NAME}\2/g" resources/linux/debian/postinst.template
  fi

  echo "TheoremDesk: distribution layer applied"
}

theoremdesk_prepare
unset -f theoremdesk_prepare
