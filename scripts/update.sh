#!/usr/bin/env bash
# Updates Build My TV Station to the latest version: the code, its dependencies, the systemd units
# and these commands, then restarts the panel. Installed as /usr/bin/tvstation-update, and in the
# LXC container also as /usr/bin/update, so running `update` in the container shell is all it takes.
#
#   update                    update to the latest version of the release channel
#   update --force            reinstall even when already up to date
#   update --channel CHANNEL  switch to the stable or test release channel, then update
#   update --request FILE     do what the admin panel asked for in FILE (used by tvstation-update.service)
#
# Release channels (chosen in the panel under Version and updates, or with --channel):
#   stable  the newest release tag vX.Y.Z (the default; tags with a suffix are pre-releases)
#   test    the newest commit on the branch TVSTATION_REF (default main)
set -euo pipefail

APP_DIR="${TVSTATION_DIR:-/opt/tvstation}"
[[ -f /etc/default/tvstation ]] && source /etc/default/tvstation
REF="${TVSTATION_REF:-main}"
DATA_DIR="${DATA_DIR:-/var/lib/tvstation}"
CHANNEL_FILE="$DATA_DIR/update-channel"
SERVICE="tvstation"
FORCE=0
NEW_CHANNEL=""
case "${1:-}" in
  --force) FORCE=1 ;;
  --channel) NEW_CHANNEL="${2:-}" ;;
  --request)
    # The panel writes "force" to reinstall the current version; anything else means update.
    REQUEST="$(cat "${2:-}" 2>/dev/null || true)"
    rm -f "${2:-}"
    [[ "$REQUEST" == force* ]] && FORCE=1
    ;;
esac

if [[ -t 1 ]]; then GN=$'\e[32m'; YW=$'\e[33m'; RD=$'\e[31m'; CL=$'\e[0m'; else GN=''; YW=''; RD=''; CL=''; fi
info() { echo -e "${YW}▶${CL} $*"; }
ok() { echo -e "${GN}✔${CL} $*"; }
die() { echo -e "${RD}✖${CL} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run update as root."
[[ -d "$APP_DIR/.git" ]] || die "No Build My TV Station installation found in $APP_DIR."

# The checkout belongs to the service user; let root's git work on it.
git_() { git -c safe.directory="$APP_DIR" -C "$APP_DIR" "$@"; }
version() { node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo "?"; }

if [[ -n "$NEW_CHANNEL" ]]; then
  [[ "$NEW_CHANNEL" == stable || "$NEW_CHANNEL" == test ]] || die "Choose the release channel stable or test."
  echo "$NEW_CHANNEL" >"$CHANNEL_FILE"
  chown "$SERVICE:$SERVICE" "$CHANNEL_FILE" 2>/dev/null || true
  ok "Release channel set to $NEW_CHANNEL."
fi
CHANNEL="$(cat "$CHANNEL_FILE" 2>/dev/null || true)"
[[ "$CHANNEL" == test ]] || CHANNEL=stable

CURRENT="$(git_ rev-parse HEAD)"
OLD_VERSION="$(version)"
if [[ "$CHANNEL" == stable ]]; then
  info "Checking for updates (stable releases)"
  TAGS="$(git_ ls-remote --tags --refs origin 'refs/tags/v*')" || die "Could not reach the repository."
  TAG="$(awk '{sub("refs/tags/", "", $2); print $2}' <<<"$TAGS" | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
  [[ -n "$TAG" ]] || die "No stable release has been published yet. Follow the newest changes with: update --channel test"
  # Never go back to an older release than the version that runs now (after leaving the test channel).
  if [[ "$(printf '%s\n' "${TAG#v}" "${OLD_VERSION%%-*}" | sort -V | tail -n 1)" != "${TAG#v}" ]]; then
    ok "Build My TV Station ${OLD_VERSION} (${CURRENT:0:7}) is newer than the latest stable release ${TAG}; it moves to the next stable release that is at least as new."
    exit 0
  fi
  git_ fetch --quiet --depth 1 origin "refs/tags/$TAG" || die "Could not fetch release $TAG."
else
  info "Checking for updates (test: $REF)"
  git_ fetch --quiet --depth 1 origin "$REF" || die "Could not reach the repository."
fi
LATEST="$(git_ rev-parse 'FETCH_HEAD^{commit}')"

if [[ "$CURRENT" == "$LATEST" && $FORCE -eq 0 ]]; then
  ok "Build My TV Station ${OLD_VERSION} (${CURRENT:0:7}) is already up to date."
  exit 0
fi

info "Stopping Build My TV Station"
systemctl stop "$SERVICE" || true
# Whatever happens from here, never leave the panel stopped.
trap 'systemctl is-active --quiet "$SERVICE" || systemctl start "$SERVICE" || true' EXIT

info "Installing ${LATEST:0:7}"
git_ reset --quiet --hard "$LATEST"
# System packages that newer versions need (the panel talks to Proxmox over SSH).
if ! command -v ssh >/dev/null; then
  info "Installing system packages"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-client >/dev/null || die "Installing openssh-client failed."
fi
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error --silent) || die "Installing dependencies failed; the panel was restarted with the files it has now."
chown -R "$SERVICE:$SERVICE" "$APP_DIR"
source "$APP_DIR/scripts/install-system-files.sh"
install_system_files "$APP_DIR"

info "Starting Build My TV Station"
systemctl start "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || die "The panel did not start. See: journalctl -u $SERVICE -n 50"

ok "Updated Build My TV Station ${OLD_VERSION} (${CURRENT:0:7}) → $(version) (${LATEST:0:7})."
