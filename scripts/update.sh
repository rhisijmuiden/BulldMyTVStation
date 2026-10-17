#!/usr/bin/env bash
# Updates Build My TV Station to the latest version. Installed as /usr/bin/update in the LXC container
# and as /usr/bin/tvstation-update on a standalone machine.
#
#   update            update to the latest version of the configured branch
#   update --force    reinstall even when already up to date
set -euo pipefail

APP_DIR="${TVSTATION_DIR:-/opt/tvstation}"
[[ -f /etc/default/tvstation ]] && source /etc/default/tvstation
REF="${TVSTATION_REF:-main}"
SERVICE="tvstation"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

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

info "Installing ${LATEST:0:7}"
git_ reset --quiet --hard FETCH_HEAD
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || {
  systemctl start "$SERVICE" || true
  die "Installing dependencies failed; the panel was restarted with the files it has now."
}
chown -R "$SERVICE:$SERVICE" "$APP_DIR"
install -m 0644 "$APP_DIR/deploy/tvstation.service" /etc/systemd/system/tvstation.service
install -m 0755 "$APP_DIR/scripts/tvstation-admin-reset.sh" /usr/bin/tvstation-admin-reset
# Keep this command current under the name it was started with.
install -m 0755 "$APP_DIR/scripts/update.sh" "$(readlink -f "$0")"
systemctl daemon-reload

info "Starting Build My TV Station"
systemctl start "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE" || die "The panel did not start. See: journalctl -u $SERVICE -n 50"

ok "Updated Build My TV Station ${OLD_VERSION} (${CURRENT:0:7}) → $(version) (${LATEST:0:7})."
