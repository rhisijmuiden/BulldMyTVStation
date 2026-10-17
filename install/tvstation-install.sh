#!/usr/bin/env bash
# Runs inside the new Debian 13 container; called by ct/tvstation.sh through the community-scripts engine.
# License: MIT
# Source: https://github.com/rhisijmuiden/BulldMyTVStation

source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

TVSTATION_REPO="${TVSTATION_REPO:-https://github.com/rhisijmuiden/BulldMyTVStation.git}"
TVSTATION_REF="${TVSTATION_REF:-main}"

msg_info "Installing Dependencies"
$STD apt-get install -y git ca-certificates curl
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs

msg_info "Creating service user"
useradd --system --home-dir /var/lib/tvstation --shell /usr/sbin/nologin tvstation 2>/dev/null || true
install -d -m 0750 -o tvstation -g tvstation /var/lib/tvstation
msg_ok "Created service user"

msg_info "Installing Build My TV Station"
$STD git clone --depth 1 --branch "$TVSTATION_REF" "$TVSTATION_REPO" /opt/tvstation
cd /opt/tvstation || exit
$STD npm ci --omit=dev
chown -R tvstation:tvstation /opt/tvstation
msg_ok "Installed Build My TV Station"

msg_info "Creating Service"
[[ "$TVSTATION_REF" != "main" ]] && echo "TVSTATION_REF=$TVSTATION_REF" >/etc/default/tvstation
source /opt/tvstation/scripts/install-system-files.sh
install_system_files /opt/tvstation
systemctl enable -q --now tvstation
msg_ok "Created Service"

motd_ssh
customize

# Our own `update` command (replaces the generic one customize() writes): updates everything in place.
install -m 0755 /opt/tvstation/scripts/update.sh /usr/bin/update

cleanup_lxc
