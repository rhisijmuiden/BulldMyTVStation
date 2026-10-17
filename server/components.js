'use strict';
// The parts a TV station is built from, and the monitor that checks each registered part.
// A part is registered by the wizard after it deploys it, or by hand under Components to
// monitor a part that already runs somewhere.
const store = require('./store');

// What each kind of part is and where it comes from. `installer: false` means the project
// has no installer yet, so the wizard cannot deploy it.
const CATALOG = {
  generator: {
    project: 'Beeldkrant',
    repo: 'https://github.com/rhisijmuiden/TV-Channel-Generator',
    proxmoxScript: 'https://raw.githubusercontent.com/rhisijmuiden/TV-Channel-Generator/main/ct/beeldkrant.sh',
    debianScript: null,
    defaultPort: 8080,
    installer: true,
  },
  distribution: {
    project: 'MediaMTX Panel',
    repo: 'https://github.com/rhisijmuiden/Mediamtx-controlpanel',
    proxmoxScript: 'https://raw.githubusercontent.com/rhisijmuiden/Mediamtx-controlpanel/main/deploy/proxmox/create-lxc.sh',
    debianScript: 'https://raw.githubusercontent.com/rhisijmuiden/Mediamtx-controlpanel/main/deploy/debian/install.sh',
    defaultPort: 8080,
    installer: true,
  },
  portal: {
    project: 'IPTV Portal',
    repo: 'https://github.com/rhisijmuiden/iptv-portal',
    proxmoxScript: null,
    debianScript: null,
    defaultPort: 8080,
    installer: false,
  },
};

const CHECK_MS = 30 * 1000;
const TIMEOUT_MS = 5000;
const status = new Map(); // component id -> { state: 'up'|'down'|'unknown', httpStatus, latencyMs, error, checkedAt }

function validate(fields) {
  const type = String(fields.type || '');
  const name = String(fields.name || '').trim();
  const url = String(fields.url || '').trim();
  if (!CATALOG[type]) return { error: 'errors.componentType' };
  if (!name || name.length > 80) return { error: 'errors.componentName' };
  let parsed;
  try { parsed = new URL(url); } catch { return { error: 'errors.componentUrl' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'errors.componentUrl' };
  return { value: { type, name, url: parsed.toString().replace(/\/$/, '') } };
}

// One HTTP request to the part's web interface: any answer below 500 means it is up.
async function checkOne(c) {
  const started = Date.now();
  let result;
  try {
    const res = await fetch(c.url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    result = { state: res.status < 500 ? 'up' : 'down', httpStatus: res.status, latencyMs: Date.now() - started, error: null };
  } catch (err) {
    result = { state: 'down', httpStatus: null, latencyMs: null, error: err.name === 'TimeoutError' ? 'timeout' : (err.cause && err.cause.code) || err.message };
  }
  status.set(c.id, { ...result, checkedAt: new Date().toISOString() });
  return status.get(c.id);
}

function checkAll() {
  return Promise.all(store.list('components').map(checkOne));
}

function withStatus(c) {
  return { ...c, status: status.get(c.id) || { state: 'unknown' } };
}

let timer = null;
function startMonitor() {
  checkAll();
  timer = setInterval(checkAll, CHECK_MS);
  timer.unref();
}

module.exports = { CATALOG, validate, checkOne, checkAll, withStatus, startMonitor, status };
