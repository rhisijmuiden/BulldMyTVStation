#!/usr/bin/env bash
# Updates Build My TV Station to the latest version: the code, its dependencies, the systemd units
# and these commands, then restarts the panel. Installed as /usr/bin/tvstation-update, and in the
# LXC container also as /usr/bin/update, so running `update` in the container shell is all it takes.
#
#   update                  update to the latest version of the configured branch
#   update --force          reinstall even when already up to date
#   update --request FILE   do what the admin panel asked for in FILE (used by tvstation-update.service)
set -euo pipefail

APP_DIR="${TVSTATION_DIR:-/opt/tvstation}"
[[ -f /etc/default/tvstation ]] && source /etc/default/tvstation
REF="${TVSTATION_REF:-main}"
SERVICE="tvstation"
FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
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

info "Checking for updates ($REF)"
git_ fetch --quiet --depth 1 origin "$REF" || die "Could not reach the repository."
CURRENT="$(git_ rev-parse HEAD)"
LATEST="$(git_ rev-parse FETCH_HEAD)"
OLD_VERSION="$(version)"

if [[ "$CURRENT" == "$LATEST" && $FORCE -eq 0 ]]; then
  ok "Build My TV Station ${OLD_VERSION} (${CURRENT:0:7}) is already up to date."
  exit 0
fi

info "Stopping Build My TV Station"
systemctl stop "$SERVICE" || true
# Whatever happens from here, never leave the panel stopped.
trap 'systemctl is-active --quiet "$SERVICE" || systemctl start "$SERVICE" || true' EXIT

info "Installing ${LATEST:0:7}"
git_ reset --quiet --hard FETCH_HEAD
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
