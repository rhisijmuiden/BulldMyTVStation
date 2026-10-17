'use strict';
// Talks to a Proxmox VE node over SSH as root with a key of its own: the community-scripts that
// create the containers only run in a node shell, and the Proxmox API cannot run commands in a
// container. The key pair and the known host keys live in DATA_DIR/ssh.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const SSH_DIR = path.join(store.DATA_DIR, 'ssh');
const KEY = path.join(SSH_DIR, 'id_ed25519');
const KNOWN_HOSTS = path.join(SSH_DIR, 'known_hosts');
const SSH = process.env.TVS_SSH_BIN || 'ssh';
const SSH_KEYGEN = process.env.TVS_SSH_KEYGEN_BIN || 'ssh-keygen';

const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:]+\]?$/;
const POOL_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const GUEST_TYPES = ['lxc', 'vm'];

function run(cmd, args, { input, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
      resolve(String(stdout));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// The panel's own key pair; created on first use.
async function publicKey() {
  if (!fs.existsSync(KEY)) {
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
    await run(SSH_KEYGEN, ['-q', '-t', 'ed25519', '-N', '', '-C', 'build-my-tv-station', '-f', KEY]);
  }
  return fs.readFileSync(`${KEY}.pub`, 'utf8').trim();
}

function validateTarget({ host, port }) {
  const h = String(host || '').trim();
  const p = Number(port || 22);
  if (!HOST_RE.test(h)) return { error: 'errors.proxmoxHost' };
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: 'errors.proxmoxPort' };
  return { value: { host: h.replace(/^\[|\]$/g, ''), port: p } };
}

// Runs a script on the node as root. The script goes over stdin, so nothing in it passes
// through a remote shell command line.
async function exec({ host, port }, script, timeout = 30000) {
  const args = [
    '-i', KEY, '-p', String(port),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'IdentitiesOnly=yes',
    '-o', `UserKnownHostsFile=${KNOWN_HOSTS}`, '-o', 'StrictHostKeyChecking=accept-new',
    `root@${host}`, 'bash -s',
  ];
  try {
    return await run(SSH, args, { input: script, timeout });
  } catch (err) {
    const msg = err.stderr || err.message || '';
    if (err.killed) throw Object.assign(new Error(msg), { key: 'errors.proxmoxTimeout' });
    if (/Permission denied/i.test(msg)) throw Object.assign(new Error(msg), { key: 'errors.proxmoxDenied' });
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(msg)) throw Object.assign(new Error(msg), { key: 'errors.proxmoxHostKey' });
    if (/Could not resolve|No route|Connection refused|timed out|Network is unreachable/i.test(msg)) throw Object.assign(new Error(msg), { key: 'errors.proxmoxUnreachable' });
    throw Object.assign(new Error(msg), { key: 'errors.proxmoxFailed' });
  }
}

// What the wizard offers: the node the panel is connected to, its storage, bridges and the pools.
// Each section is printed after an @@ marker so one SSH session collects everything.
const DISCOVER = `set -e
command -v pvesh >/dev/null || { echo "@@notproxmox"; exit 0; }
NODE="$(hostname)"
echo "@@version"; pveversion
echo "@@node"; echo "$NODE"
echo "@@storage"; pvesh get "/nodes/$NODE/storage" --output-format json
echo "@@network"; pvesh get "/nodes/$NODE/network" --type any_bridge --output-format json
echo "@@pools"; pvesh get /pools --output-format json
`;

function parseSections(out) {
  const sections = {};
  let current = null;
  for (const line of out.split('\n')) {
    const m = line.match(/^@@(\w+)$/);
    if (m) { current = m[1]; sections[current] = ''; } else if (current) sections[current] += `${line}\n`;
  }
  return sections;
}

const json = (s) => { try { return JSON.parse(s); } catch { return []; } };

async function fingerprint(host, port) {
  const name = port === 22 ? host : `[${host}]:${port}`;
  try {
    const out = await run(SSH_KEYGEN, ['-l', '-F', name, '-f', KNOWN_HOSTS]);
    const line = out.split('\n').find((l) => /SHA256:/.test(l));
    return line ? line.match(/SHA256:\S+/)[0] : null;
  } catch { return null; }
}

async function discover(target) {
  const s = parseSections(await exec(target, DISCOVER));
  if ('notproxmox' in s) throw Object.assign(new Error('pvesh not found'), { key: 'errors.proxmoxNotProxmox' });
  const storage = json(s.storage)
    .filter((x) => x.active !== 0 && x.enabled !== 0)
    .map((x) => ({ id: x.storage, type: x.type, content: String(x.content || '').split(',').filter(Boolean), avail: x.avail || null, total: x.total || null }));
  return {
    version: (s.version || '').trim(),
    node: (s.node || '').trim(),
    storage,
    bridges: json(s.network).map((x) => x.iface).filter(Boolean).sort(),
    pools: json(s.pools).map((x) => x.poolid).filter(Boolean).sort(),
    fingerprint: await fingerprint(target.host, target.port),
  };
}

// Storage that can hold the chosen guest type: container root disks or VM disks.
const storageFits = (st, guestType) => st.content.includes(guestType === 'vm' ? 'images' : 'rootdir');

// Checks the choices against what the node really has, and returns the error key or null.
function choiceError(found, { storage, bridge, pool, guestType }) {
  if (!GUEST_TYPES.includes(guestType)) return 'errors.proxmoxGuestType';
  const st = found.storage.find((x) => x.id === storage);
  if (!st || !storageFits(st, guestType)) return 'errors.proxmoxStorage';
  if (!found.bridges.includes(bridge)) return 'errors.proxmoxBridge';
  if (!POOL_RE.test(String(pool || ''))) return 'errors.proxmoxPool';
  return null;
}

// Creates the resource pool when it does not exist yet. The name was checked against POOL_RE.
async function ensurePool(target, pool) {
  const out = await exec(target, `set -e
if pvesh get /pools --output-format json | grep -q '"poolid":"${pool}"'; then echo existed; else
  pvesh create /pools --poolid '${pool}' --comment 'Build My TV Station' >/dev/null; echo created; fi
`);
  return out.trim().split('\n').pop() === 'created';
}

module.exports = { publicKey, validateTarget, discover, choiceError, ensurePool, storageFits, POOL_RE, GUEST_TYPES };
