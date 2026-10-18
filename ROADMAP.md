# Roadmap

Where Build My TV Station is going. The goal: **one install, one wizard, one working TV station**, which the panel keeps healthy, up to date and backed up afterwards.

Each milestone ends with something that works end to end and is tested on a real Proxmox server. The order is the order we build in; dates are left out on purpose.

Legend: ✅ done · 🔨 in progress · ⬜ planned

## Where we are (October 2026)

| | Milestone | Status |
|---|---|---|
| 1 | Base panel and install | ✅ |
| 2 | Wizard: plan the station (steps 1 to 3) | ✅ |
| – | Station contract in the three projects | ✅ |
| 3 | Wizard: deploy the station (step 4) | ⬜ next |
| 4 | Wizard: connect the parts (step 5) and overview (step 6) | ⬜ |
| 5 | Separate machines (VPS / physical) | ⬜ |
| 6 | Monitoring and alerts | ⬜ |
| 7 | Operating the station: updates, backup and restore | ⬜ |
| 8 | Panel standards: Entra SSO, mail, backup | ⬜ |
| 9 | Standards in every project | ⬜ |
| – | Later | ideas |

---

## 1. Base panel and install ✅

- Node.js admin panel on port **8080**, menu on the left, English and Dutch.
- Proxmox LXC script `ct/tvstation.sh` (community-scripts engine, like `ct/debian.sh`) and installer `install/debian.sh` for a minimal Debian 13 machine or VPS.
- One-time admin password printed at install, password change forced at first login, `tvstation-admin-reset`.
- Version button with build, update check and **Update now**; `update` / `tvstation-update` on the shell.
- Release channels **Stable** (release tags) and **Test** (newest commit on main), chosen in the panel or with `update --channel`.
- Components page: monitor a part that already runs by its address.

## 2. Wizard: plan the station ✅

- **Step 1, location**: everything on one Proxmox server, or separate machines.
- **Step 2, connection**: SSH as root with the panel's key, LXC or Debian 13 VMs, storage, bridge and a resource pool with its own name.
- **Step 3, parts**: resources per part, several channel generators, nginx with a public domain, a path per part (`/channel1`, `/stream`, portal at `/`), Let's Encrypt and optional logins.

### Station contract ✅

Every project offers the optional [station contract](docs/station-contract.md) (`station` command, `station.json`, `/healthz`, service token with `/api/v1`, base path, trusted proxies). Off by default, so each project still installs and runs on its own. Merged in Beeldkrant, MediaMTX Panel and IPTV Portal.

## 3. Wizard: deploy the station ⬜ next

Step 4 turns the plan from steps 1 to 3 into running guests.

- Create the resource pool and one LXC container or Debian 13 VM per part, with the chosen resources, network and GPU passthrough.
- Always install the **latest version** of each project with its own installer, unattended.
- Run each project's `station` command: set the service token, base path, public URL and trusted proxies, and collect `station.json` and the one-time admin password.
- Create the **nginx** container: one public domain, a location per path, Let's Encrypt, optional nginx logins.
- Live progress per part with its log, resumable after an error, and a clean **undo** that removes what the wizard created.
- Register every deployed part under Components so it is monitored at once.

Done when: from an empty Proxmox node the wizard produces all parts plus nginx, each reachable on its path over HTTPS.

## 4. Wizard: connect the parts and overview ⬜

Step 5 wires the parts together through their `/api/v1` with the service token; step 6 shows the result.

- **Generator → distribution**: create a MediaMTX path per channel and set the generator's RTMP or SRT output to it, with its own publish credentials.
- **Distribution → portal**: add every channel to the IPTV portal with its HLS/stream URL, logo and category.
- Check the chain: the stream arrives in MediaMTX and plays from the portal.
- **Overview**: every part with its status, version, public address and an **Open** button that logs you in; the one-time passwords shown once.
- Add or remove a channel generator later without running the whole wizard again.

Done when: a test channel made in Beeldkrant plays on a TV box through the portal, without any manual step.

## 5. Separate machines ⬜

The second choice of step 1: each part on its own Debian 13 VPS or physical machine.

- Add machines by address with SSH as root using the panel's key; check Debian 13 and resources.
- Same deploy and connect flow as on Proxmox, with each project's Debian installer.
- nginx on its own machine or on the panel's machine; firewall rules between the parts.

## 6. Monitoring and alerts ⬜

- Health per part from `/healthz`: up/down, version, contract version, response time, with history.
- Stream health: is each channel publishing, bitrate, viewers (from MediaMTX), portal users online.
- Resources per guest from Proxmox (CPU, memory, disk, network) or from the machine itself.
- Certificate expiry and disk space warnings.
- Alerts by mail (milestone 8) when a part or channel goes down and when it recovers; optional webhook.
- Dashboard tiles per part and a station status page.

## 7. Operating the station ⬜

- **Updates for every part** from the panel: see which part has a new version, update one or all, in a safe order, with a health check afterwards and a rollback when it fails.
- **Station backup**: back up the panel and every part (through each project's own backup or `pct`/`vzdump` snapshots) in one job, on a schedule.
- **Restore / rebuild**: restore one part, or rebuild a whole station from a backup on new hardware.
- Export and import the station definition (the wizard's plan) as a file.

## 8. Panel standards ⬜

The things every app of Reinder's has, still missing in this panel.

- **Microsoft Entra SSO** (OpenID Connect), optional and off by default: tenant, client ID and secret, group to role mapping, local admin always kept as a way back in.
- **Users and roles**: more than one admin account (admin, operator, read only).
- **Mail server**: own SMTP server with STARTTLS or SSL/TLS, login or none, optional OAuth2 for Microsoft 365, encrypted password, *Send test mail*. Used for alerts and password resets (*Forgot your password?*).
- **Backup** of the panel itself:
  - full and incremental backups, on a schedule and on request;
  - remote locations over **FTP, FTPS and SCP/SFTP**, with retention;
  - **restore** from a local or a remote backup.
- Info button: version, build, changelog, check for updates and update from the panel (already there, keep in line with the other projects).

## 9. Standards in every project ⬜

What is still missing per project, so all parts look and work the same. Each item is its own PR in that project's repository.

| | Beeldkrant | MediaMTX Panel | IPTV Portal |
|---|---|---|---|
| LXC script + Debian 13 installer | ✅ | ✅ | ✅ |
| Port 8080 | ✅ | ✅ | ✅ (admin) |
| Info + check for updates | ✅ | ✅ | ✅ |
| Update from the interface | ✅ | ⬜ (shows how, does not install) | ✅ |
| Release channels (stable + test) | ⬜ | ⬜ | ⬜ |
| Microsoft Entra SSO | ✅ | ⬜ | ⬜ |
| Own SMTP server | ⬜ | ✅ | ✅ |
| Backup to FTP/FTPS/SCP + restore | ✅ | ⬜ | ⬜ |
| Incremental backup | ⬜ | ⬜ | ⬜ |
| Station contract v1 | ✅ | ✅ | ✅ |

With Entra in every part, the station can offer **one login** for all parts later (the panel's **Open** button then logs you in through Entra).

## Later (ideas, not planned yet)

- Several Proxmox nodes or a cluster, and moving a part to another node.
- High availability for the distribution server (a second MediaMTX, failover).
- EPG (programme guide) from the generators to the portal.
- Recording and catch-up TV.
- Templates: create a station from a saved station definition in one click.
- Metrics export (Prometheus) for people who already run Grafana.
