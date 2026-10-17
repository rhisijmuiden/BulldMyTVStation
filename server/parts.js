'use strict';
// Step 3 of the wizard: which parts the station gets, their resources and where nginx publishes
// them. Several channel generators are allowed; the other parts exist once.
const crypto = require('crypto');

// Defaults come from each project's own Proxmox script; nginx is set up by the panel itself.
const DEFAULTS = {
  generator: { cpu: 4, ram: 4096, disk: 16, gpu: true },
  distribution: { cpu: 2, ram: 2048, disk: 8, gpu: false },
  portal: { cpu: 1, ram: 512, disk: 2, gpu: false },
  proxy: { cpu: 1, ram: 512, disk: 4, gpu: false },
};
const SINGLE = ['distribution', 'portal', 'proxy'];
const MAX_GENERATORS = 20;
// A Debian 13 VM needs more room than a container.
const VM_MIN = { ram: 1024, disk: 8 };

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_RE = /^\/([a-z0-9][a-z0-9-]{0,39})?$/;
const CIDR_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)\/([1-9]|[12]\d|3[0-2])$/;
const IP_RE = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)$/;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_RE = /^[A-Za-z0-9._-]{1,32}$/;

function generatorDefaults(n) {
  return { name: `Channel ${n}`, hostname: `tv-channel${n}`, path: `/channel${n}` };
}

// What step 3 shows the first time: one of each part.
function initialParts() {
  const make = (type, extra) => ({ id: crypto.randomUUID(), type, ...DEFAULTS[type], network: 'dhcp', ip: '', gateway: '', auth: false, authUser: 'admin', ...extra });
  return [
    make('generator', generatorDefaults(1)),
    make('distribution', { name: 'Distribution', hostname: 'tv-mediamtx', path: '/stream' }),
    // TV boxes and IPTV apps expect the portal at the root of the address.
    make('portal', { name: 'IPTV portal', hostname: 'tv-portal', path: '/' }),
    make('proxy', { name: 'Reverse proxy', hostname: 'tv-proxy', path: null }),
  ];
}

const int = (v) => (typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10));

// Checks and normalizes what the form sent. Returns { error, field?, index? } or { value }.
function validate(body, { guestType = 'lxc' } = {}) {
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (!parts.length) return { error: 'errors.partsNone' };
  const out = [];
  const seen = { hostname: new Set(), path: new Set(), type: {} };
  for (const [index, p] of parts.entries()) {
    const fail = (error, field) => ({ error, field, index });
    const type = String(p.type || '');
    if (!DEFAULTS[type]) return fail('errors.partType', 'type');
    seen.type[type] = (seen.type[type] || 0) + 1;
    if (SINGLE.includes(type) && seen.type[type] > 1) return fail('errors.partOnce', 'type');
    if (type === 'generator' && seen.type[type] > MAX_GENERATORS) return fail('errors.partTooMany', 'type');

    const name = String(p.name || '').trim();
    if (!name || name.length > 60) return fail('errors.partName', 'name');
    const hostname = String(p.hostname || '').trim().toLowerCase();
    if (!HOSTNAME_RE.test(hostname) || seen.hostname.has(hostname)) return fail('errors.partHostname', 'hostname');
    seen.hostname.add(hostname);

    const cpu = int(p.cpu);
    const ram = int(p.ram);
    const disk = int(p.disk);
    if (!(cpu >= 1 && cpu <= 64)) return fail('errors.partCpu', 'cpu');
    if (!(ram >= 256 && ram <= 262144) || (guestType === 'vm' && ram < VM_MIN.ram)) return fail('errors.partRam', 'ram');
    if (!(disk >= 1 && disk <= 4096) || (guestType === 'vm' && disk < VM_MIN.disk)) return fail('errors.partDisk', 'disk');

    const network = p.network === 'static' ? 'static' : 'dhcp';
    const ip = network === 'static' ? String(p.ip || '').trim() : '';
    const gateway = network === 'static' ? String(p.gateway || '').trim() : '';
    if (network === 'static' && !CIDR_RE.test(ip)) return fail('errors.partIp', 'ip');
    if (network === 'static' && !IP_RE.test(gateway)) return fail('errors.partGateway', 'gateway');

    let path = null;
    if (type !== 'proxy') {
      path = String(p.path || '').trim().toLowerCase();
      if (!path.startsWith('/')) path = `/${path}`;
      if (!PATH_RE.test(path) || seen.path.has(path)) return fail('errors.partPath', 'path');
      seen.path.add(path);
    }
    const auth = type !== 'proxy' && !!p.auth;
    const authUser = auth ? String(p.authUser || '').trim() : 'admin';
    if (auth && !USER_RE.test(authUser)) return fail('errors.partAuthUser', 'authUser');

    out.push({
      id: typeof p.id === 'string' && /^[0-9a-f-]{36}$/.test(p.id) ? p.id : crypto.randomUUID(),
      type, name, hostname, cpu, ram, disk,
      // GPU passthrough is offered for the channel generator in an LXC container.
      gpu: type === 'generator' && guestType === 'lxc' && !!p.gpu,
      network, ip, gateway, path, auth, authUser,
    });
  }

  const proxy = body.proxy || {};
  const hasProxy = out.some((p) => p.type === 'proxy');
  const domain = String(proxy.domain || '').trim().toLowerCase();
  const email = String(proxy.email || '').trim();
  const tls = !!proxy.tls;
  if (hasProxy) {
    if (!DOMAIN_RE.test(domain)) return { error: 'errors.proxyDomain', field: 'domain' };
    if (tls && !EMAIL_RE.test(email)) return { error: 'errors.proxyEmail', field: 'email' };
  }
  return { value: { parts: out, proxy: hasProxy ? { domain, email: tls ? email : '', tls } : null } };
}

module.exports = { DEFAULTS, VM_MIN, MAX_GENERATORS, initialParts, generatorDefaults, validate };
