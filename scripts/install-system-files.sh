# Sourced by the installers and by update.sh: puts the systemd units and commands of the checkout
# in APP_DIR in place. `install` writes a new file, so replacing the running update command is safe.
install_system_files() {
  local app_dir="$1"
  install -m 0644 "$app_dir/deploy/tvstation.service" "$app_dir/deploy/tvstation-update.path" "$app_dir/deploy/tvstation-update.service" /etc/systemd/system/
  install -m 0755 "$app_dir/scripts/update.sh" /usr/bin/tvstation-update
  install -m 0755 "$app_dir/scripts/tvstation-admin-reset.sh" /usr/bin/tvstation-admin-reset
  # In the LXC container `update` is the command; keep it current too.
  if [[ -f /usr/bin/update ]] && grep -q "Build My TV Station" /usr/bin/update; then
    install -m 0755 "$app_dir/scripts/update.sh" /usr/bin/update
  fi
  systemctl daemon-reload
  systemctl enable --quiet --now tvstation-update.path || true
}
