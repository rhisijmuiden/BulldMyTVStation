# Station contract (version 1)

Build My TV Station deploys and connects other projects (Beeldkrant, MediaMTX Panel, IPTV Portal). Each of them stays a standalone project. This contract is the small set of **optional** hooks a project offers so the station panel can run it as one part of a station.

Rule zero: **nothing in this contract changes the behaviour of a standalone install.** Every setting below is off until it is set, and with all of them unset a project behaves exactly as it did before.

## 1. The `station` command

Each project installs one command that the panel runs as root on the machine or in the container (over SSH, or with `pct exec` on Proxmox) right after the project's own installer:

| Project | Command |
|---|---|
| Beeldkrant | `beeldkrant-station` |
| MediaMTX Panel | `mediamtx-panel-station` |
| IPTV Portal | `iptv-portal station` |

```
<command> [--reset-admin]
```

It reads these environment variables. A variable that is **not set** leaves that setting as it is; a variable set to the **empty string** clears it.

| Variable | Meaning |
|---|---|
| `STATION_SERVICE_TOKEN` | Enables the service token (section 4). At least 32 characters. |
| `STATION_BASE_PATH` | Serves the admin interface under this path (section 5), for example `/channel1`. `/` or empty means the root. |
| `STATION_PUBLIC_URL` | The public address of this part, for example `https://tv.example.com/channel1`. Used where the project builds absolute links. |
| `STATION_TRUSTED_PROXIES` | Comma-separated IPs or CIDRs of the reverse proxy (section 6). |

What it does, in this order:

1. Stores the settings in the project's own configuration (an env file or its settings store), readable by root and the service user only.
2. With `--reset-admin`: sets a new one-time password for the admin user, which must be changed at the next login, as the project's own reset already does.
3. Restarts the service when something changed, and waits up to 60 seconds for `/healthz` (section 3) to answer.
4. Writes `station.json` (section 2) to the project's data directory and prints the same JSON on **stdout**, with `initialPassword` added when `--reset-admin` was given. Everything else (progress, logs) goes to stderr.

It exits 0 on success and non-zero with a message on stderr otherwise. Running it twice with the same input is harmless.

## 2. `station.json`

Written to the data directory (`/var/lib/beeldkrant`, `/var/lib/mediamtx-panel`, `/var/lib/iptv-portal`), mode 0600. The file never holds a password or the token; only the command's stdout carries `initialPassword`.

```json
{
  "contract": 1,
  "app": "beeldkrant",
  "version": "0.7.1",
  "port": 8080,
  "basePath": "/channel1",
  "adminUrl": "http://10.0.0.21:8080/channel1/",
  "adminUser": "admin",
  "apiBase": "/channel1/api",
  "serviceToken": true,
  "ports": {}
}
```

- `basePath`: the base path without a trailing slash, `""` at the root.
- `adminUrl`: the local address of the admin interface on this machine (first non-loopback IPv4), including the base path.
- `apiBase`: the path the service token works on (section 4), including the base path: `<base>/api` for Beeldkrant, `<base>/api/v1` for MediaMTX Panel and IPTV Portal.
- `serviceToken`: whether a token is configured. Never the token itself.
- `ports`: extra ports other parts need, by name. MediaMTX Panel: `rtmp`, `rtsp`, `srt`, `hls`, `webrtc`. IPTV Portal: `portal` (the port TV boxes use).

## 3. Health

`GET /healthz` answers without a login, with status 200 and:

```json
{ "status": "ok", "app": "beeldkrant", "version": "0.7.1", "contract": 1 }
```

It answers on the root path **and** under the base path (`/channel1/healthz`). It holds no secrets.

## 4. Service token

When a token is configured, a request with `Authorization: Bearer <token>` is treated as an admin on the API (`apiBase` in `station.json`). The token is compared in constant time. No cookie is involved, so CSRF checks do not apply to these requests. A wrong token gets 401. Without a configured token, Bearer headers are ignored as before.

The API each project offers this way:

**Beeldkrant**: its existing JSON API under `/api/`. The panel uses `POST /api/outputs` to point a channel at the distribution server (`{"name", "type": "custom", "url": "srt://…", "enabled": true, "source": "schedule"}`).

**MediaMTX Panel**: a new API under `/api/v1/`, on the first (default) media server:

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/v1/streams` | | list of streams |
| `POST /api/v1/streams` | `{"name": "channel1", "publicRead": true}` | 201 with the stream |
| `GET /api/v1/streams/{id}` | | the stream |
| `DELETE /api/v1/streams/{id}` | | 204 |

A stream:

```json
{
  "id": 3,
  "name": "channel1",
  "publicRead": true,
  "publish": { "rtmp": "rtmp://host:1935/channel1?user=…&pass=…", "srt": "srt://host:8890?streamid=publish:channel1:user:pass", "rtsp": "rtsp://user:pass@host:8554/channel1" },
  "play": { "hls": "http://host:8888/channel1/index.m3u8", "webrtc": "http://host:8889/channel1/", "rtsp": "rtsp://host:8554/channel1", "srt": "srt://host:8890?streamid=read:channel1" }
}
```

Read URLs carry the read credentials when the stream is not public.

**IPTV Portal**: a new API under `/api/v1/` on the admin port:

| Method and path | Body | Answer |
|---|---|---|
| `GET /api/v1/channels` | | list of channels |
| `POST /api/v1/channels` | `{"name", "streamUrl", "logoUrl", "category", "epgId", "sortOrder", "enabled"}` | 201 with the channel |
| `PUT /api/v1/channels/{id}` | same fields | the channel |
| `DELETE /api/v1/channels/{id}` | | 204 |

`category` is a category name; it is created when it does not exist yet.

## 5. Base path

With a base path set, the admin interface is served under it: pages, assets, API calls, redirects and cookies (`Path=<base path>`). The reverse proxy forwards the **full** path unchanged (`location /channel1/ { proxy_pass http://10.0.0.21:8080; }`), so no rewriting is needed. A request to `<base path>` without the trailing slash redirects to `<base path>/`.

IPTV Portal applies the base path to its **admin** interface only (default in the station: `/portal-admin`); the portal that TV boxes use stays at `/`.

## 6. Trusted proxies

`X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` are only believed from the addresses in `STATION_TRUSTED_PROXIES`. With the list unset, a project keeps its current behaviour, with one exception for safety: a request that carries `X-Forwarded-For` is never treated as coming from the machine itself, even when the proxy runs on the same host.

## Versioning

`contract` in `/healthz` and `station.json` is this document's version. A change that is not backwards compatible raises it; the panel reads it to know what a part supports. A part that answers `/healthz` without `contract` (or not at all) is deployed the old way, with path rewriting in nginx.
