#!/usr/bin/env bash
# Gives a user (default "admin") a new one-time password. Installed as /usr/bin/tvstation-admin-reset.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
[[ -f /etc/default/tvstation ]] && source /etc/default/tvstation
cd /opt/tvstation
runuser -u tvstation -- env DATA_DIR="${DATA_DIR:-/var/lib/tvstation}" /usr/bin/node server/index.js admin-reset "${1:-admin}"
systemctl restart tvstation
