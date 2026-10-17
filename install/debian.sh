#!/usr/bin/env bash
# Installs Build My TV Station on a minimal Debian 13 machine (bare metal, a VM or a VPS), without Proxmox.
#
# Run as root:
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/rhisijmuiden/BulldMyTVStation/main/install/debian.sh)"
# On a minimal Debian without curl:
#     bash -c "$(wget -qO- https://raw.githubusercontent.com/rhisijmuiden/BulldMyTVStation/main/install/debian.sh)"
#
# Settings (environment variables):
#     TVSTATION_REF=<branch>   install another branch (default main)
#     PORT=<port>              port of the admin panel (default 8080)
#
# At the end it prints the admin address, the user "admin" and a one-time password that must be
# changed at the first login. Running it again on an installed machine updates the panel.
set -euo pipefail

TVSTATION_REPO="${TVSTATION_REPO:-https://github.com/rhisijmuiden/BulldMyTVStation.git}"
TVSTATION_REF="${TVSTATION_REF:-main}"
PORT="${PORT:-8080}"
APP_DIR=/opt/tvstation
DATA_DIR=/var/lib/tvstation

c_info="\e[1;34m"; c_ok="\e[1;32m"; c_warn="\e[1;33m"; c_err="\e[1;31m"; c_off="\e[0m"
info() { echo -e "${c_info}[i]${c_off} $*"; }
ok()   { echo -e "${c_ok}[✓]${c_off} $*"; }
warn() { echo -e "${c_warn}[!]${c_off} $*"; }
die()  { echo -e "${c_err}[✗]${c_off} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this script as root."
[[ -r /etc/os-release ]] && . /etc/os-release
[[ "${ID:-}" == "debian" ]] || die "This installer is for Debian 13. Found: ${PRETTY_NAME:-unknown}."
[[ "${VERSION_ID:-}" == "13" ]] || warn "This installer is made for Debian 13; found ${PRETTY_NAME:-unknown}. Continuing anyway."

if [[ -d "$APP_DIR/.git" ]]; then
  info "Build My TV Station is already installed; updating it instead."
  exec bash "$APP_DIR/scripts/update.sh"
fi

info "Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git ca-certificates curl openssh-client nodejs npm >/dev/null
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js 20 or newer is needed; Debian installed $(node -v)."
ok "Installed git and Node.js $(node -v)"

info "Creating service user"
id tvstation &>/dev/null || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin tvstation
install -d -m 0750 -o tvstation -g tvstation "$DATA_DIR"
ok "Created service user"

info "Installing Build My TV Station ($TVSTATION_REF)"
git clone --quiet --depth 1 --branch "$TVSTATION_REF" "$TVSTATION_REPO" "$APP_DIR"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R tvstation:tvstation "$APP_DIR"
ok "Installed Build My TV Station"

info "Creating service"
{
  [[ "$TVSTATION_REF" != "main" ]] && echo "TVSTATION_REF=$TVSTATION_REF"
  [[ "$PORT" != "8080" ]] && echo "PORT=$PORT"
  true
} >/etc/default/tvstation
source "$APP_DIR/scripts/install-system-files.sh"
install_system_files "$APP_DIR"
systemctl enable --quiet --now tvstation
ok "Started service"

ADMIN_PASSWORD=""
for _ in $(seq 1 30); do
  ADMIN_PASSWORD="$(tr -d '[:space:]' <"$DATA_DIR/initial-admin-password" 2>/dev/null || true)"
  [[ -n "$ADMIN_PASSWORD" ]] && break
  sleep 1
done
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo
ok "Build My TV Station is installed."
echo -e "    Admin panel:        ${c_ok}http://${IP:-<this-machine>}:${PORT}${c_off}"
echo -e "    User name:          ${c_ok}admin${c_off}"
if [[ -n "$ADMIN_PASSWORD" ]]; then
  echo -e "    One-time password:  ${c_ok}${ADMIN_PASSWORD}${c_off} (you must change it at the first login)"
else
  warn "The one-time password is not there yet. Show it with: cat $DATA_DIR/initial-admin-password"
fi
echo "    Update later with:  tvstation-update"
echo "    Lost the password?  tvstation-admin-reset"
