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
$STD apt-get install -y git ca-certificates curl openssh-client
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs

msg_info "Creating service user"
useradd --system --home-dir /var/lib/tvstation --shell /usr/sbin/nologin tvstation 2>/dev/null || true
install -d -m 0750 -o tvstation -g tvstation /var/lib/tvstation
msg_ok "Created service user"

msg_info "Installing Build My TV Station"
# Release channel: see install/debian.sh.
TVSTATION_CHANNEL="${TVSTATION_CHANNEL:-stable}"
[[ "$TVSTATION_CHANNEL" == test ]] || TVSTATION_CHANNEL=stable
CLONE_REF="$TVSTATION_REF"
if [[ "$TVSTATION_CHANNEL" == stable ]]; then
  STABLE_TAG="$(git ls-remote --tags --refs "$TVSTATION_REPO" 'refs/tags/v*' 2>/dev/null | awk '{sub("refs/tags/", "", $2); print $2}' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)"
  [[ -n "$STABLE_TAG" ]] && CLONE_REF="$STABLE_TAG"
fi
$STD git clone --depth 1 --branch "$CLONE_REF" "$TVSTATION_REPO" /opt/tvstation
echo "$TVSTATION_CHANNEL" >/var/lib/tvstation/update-channel
chown tvstation:tvstation /var/lib/tvstation/update-channel
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
