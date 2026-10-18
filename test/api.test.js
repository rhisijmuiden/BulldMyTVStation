'use strict';
// End-to-end tests of the API against a fresh data directory.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tvstation-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.TVS_INITIAL_PASSWORD = 'one-time-pass-123';
// Stands in for the installed tvstation-update.path unit.
const UNIT = path.join(DATA_DIR, 'tvstation-update.path');
process.env.TVSTATION_UPDATE_UNIT = UNIT;
process.env.TVS_SSH_BIN = path.join(__dirname, 'fixtures', 'fake-ssh');
process.env.TVS_SSH_KEYGEN_BIN = path.join(__dirname, 'fixtures', 'fake-ssh-keygen');
process.env.FAKE_PVE_POOLS = path.join(DATA_DIR, 'fake-pools');

const auth = require('../server/auth');
const app = require('../server/index');

let server;
let base;
let cookie = '';

async function call(method, url, body, { json = true } = {}) {
  const headers = { cookie };
  if (method !== 'GET' && body === undefined) body = {};
  if (body !== undefined) headers['content-type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (json ? JSON.stringify(body) : body) });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  auth.bootstrap();
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('first start writes the one-time password file', () => {
  assert.strictEqual(fs.readFileSync(path.join(DATA_DIR, 'initial-admin-password'), 'utf8').trim(), 'one-time-pass-123');
});

test('wrong password is refused', async () => {
  const r = await call('POST', '/api/login', { username: 'admin', password: 'nope' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error, 'errors.invalidLogin');
});

test('form posts are refused', async () => {
  const r = await call('POST', '/api/login', 'username=admin&password=x', { json: false });
  assert.strictEqual(r.status, 415);
});

test('the one-time password must be changed before anything else', async () => {
  const login = await call('POST', '/api/login', { username: 'admin', password: 'one-time-pass-123' });
  assert.strictEqual(login.status, 200);
  assert.strictEqual(login.body.user.mustChangePassword, true);

  const blocked = await call('GET', '/api/components');
  assert.strictEqual(blocked.status, 403);
  assert.strictEqual(blocked.body.error, 'errors.mustChangePassword');

  const short = await call('POST', '/api/password', { current: 'one-time-pass-123', password: 'short' });
  assert.strictEqual(short.body.error, 'errors.passwordTooShort');
  const same = await call('POST', '/api/password', { current: 'one-time-pass-123', password: 'one-time-pass-123' });
  assert.strictEqual(same.body.error, 'errors.passwordSame');

  const changed = await call('POST', '/api/password', { current: 'one-time-pass-123', password: 'a-much-better-password' });
  assert.strictEqual(changed.status, 200);
  assert.strictEqual(changed.body.user.mustChangePassword, false);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!fs.existsSync(path.join(DATA_DIR, 'initial-admin-password')), 'one-time password file is removed');

  assert.strictEqual((await call('GET', '/api/components')).status, 200);
});

test('wizard step 1 stores where the station runs', async () => {
  assert.strictEqual((await call('PUT', '/api/station', { target: 'cloud' })).status, 400);
  const r = await call('PUT', '/api/station', { target: 'proxmox' });
  assert.strictEqual(r.body.station.target, 'proxmox');
  assert.strictEqual((await call('GET', '/api/station')).body.station.target, 'proxmox');
  const reset = await call('DELETE', '/api/station');
  assert.strictEqual(reset.body.station.target, null);
});

test('wizard step 2 connects to Proxmox and creates the resource pool', async () => {
  await call('PUT', '/api/station', { target: 'proxmox' });
  assert.match((await call('GET', '/api/proxmox/key')).body.publicKey, /^ssh-ed25519 /);

  assert.strictEqual((await call('POST', '/api/proxmox/discover', { host: 'bad host;rm', port: 22 })).body.error, 'errors.proxmoxHost');
  assert.strictEqual((await call('POST', '/api/proxmox/discover', { host: 'denied.example' })).body.error, 'errors.proxmoxDenied');

  const found = (await call('POST', '/api/proxmox/discover', { host: '192.168.1.10' })).body.found;
  assert.strictEqual(found.node, 'pve1');
  assert.deepStrictEqual(found.bridges, ['vmbr0']);
  assert.deepStrictEqual(found.pools, ['backups']);
  assert.strictEqual(found.fingerprint, 'SHA256:testfingerprint');

  const choice = { host: '192.168.1.10', port: 22, storage: 'local-lvm', bridge: 'vmbr0', pool: 'tv-station', guestType: 'lxc' };
  assert.strictEqual((await call('PUT', '/api/station/proxmox', { ...choice, storage: 'local' })).body.error, 'errors.proxmoxStorage');
  assert.strictEqual((await call('PUT', '/api/station/proxmox', { ...choice, storage: 'tank' })).body.error, 'errors.proxmoxStorage');
  assert.strictEqual((await call('PUT', '/api/station/proxmox', { ...choice, bridge: 'vmbr9' })).body.error, 'errors.proxmoxBridge');
  assert.strictEqual((await call('PUT', '/api/station/proxmox', { ...choice, pool: "x';reboot" })).body.error, 'errors.proxmoxPool');
  assert.strictEqual((await call('PUT', '/api/station/proxmox', { ...choice, guestType: 'docker' })).body.error, 'errors.proxmoxGuestType');

  const saved = await call('PUT', '/api/station/proxmox', choice);
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.poolCreated, true);
  assert.strictEqual(saved.body.station.step, 3);
  assert.strictEqual(saved.body.station.proxmox.node, 'pve1');
  const vm = await call('PUT', '/api/station/proxmox', { ...choice, storage: 'tank', guestType: 'vm' });
  assert.strictEqual(vm.body.poolCreated, false);
  assert.deepStrictEqual(fs.readFileSync(process.env.FAKE_PVE_POOLS, 'utf8').trim().split('\n'), ['backups', 'tv-station']);

  // Step 3: parts and resources.
  const st = (await call('GET', '/api/station')).body.station;
  assert.deepStrictEqual(st.parts.map((p) => p.type), ['generator', 'distribution', 'portal', 'proxy']);
  // The VM route was saved above, so every part needs at least 1024 MB and 8 GB.
  const parts = st.parts.concat([{ type: 'generator', name: 'Channel 2', hostname: 'tv-channel2', cpu: 4, ram: 4096, disk: 16, path: '/channel2', auth: true, authUser: 'editor' }])
    .map((p) => ({ ...p, ram: Math.max(p.ram, 1024), disk: Math.max(p.disk, 8) }));
  const put = (body) => call('PUT', '/api/station/parts', body);
  const proxyCfg = { domain: 'tv.example.com', email: 'me@example.com', tls: true };
  assert.strictEqual((await put({ parts, proxy: { ...proxyCfg, domain: 'nope' } })).body.error, 'errors.proxyDomain');
  const dup = await put({ parts: parts.map((p, i) => (i === 4 ? { ...p, path: '/channel1' } : p)), proxy: proxyCfg });
  assert.deepStrictEqual([dup.body.error, dup.body.index, dup.body.field], ['errors.partPath', 4, 'path']);
  assert.strictEqual((await put({ parts: parts.concat([{ ...parts[1], hostname: 'x2', path: '/x2' }]), proxy: proxyCfg })).body.error, 'errors.partOnce');
  assert.strictEqual((await put({ parts: [{ ...parts[0], network: 'static', ip: '10.0.0.5' }], proxy: proxyCfg })).body.error, 'errors.partIp');
  assert.strictEqual((await put({ parts: [{ ...parts[2], ram: 512 }], proxy: proxyCfg })).body.error, 'errors.partRam');
  const ok = await put({ parts, proxy: proxyCfg });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.station.step, 4);
  assert.strictEqual(ok.body.station.parts.length, 5);
  assert.strictEqual(ok.body.station.parts[4].authUser, 'editor');
  assert.strictEqual(ok.body.station.parts[0].gpu, false, 'no GPU passthrough on the VM route');
  assert.strictEqual(ok.body.station.parts[3].path, null);

  assert.strictEqual((await call('PUT', '/api/station', { step: 2 })).body.station.step, 2);
  assert.strictEqual((await call('PUT', '/api/station', { step: 3 })).status, 400);
  assert.strictEqual((await call('DELETE', '/api/station')).body.station.proxmox, null);
});

test('components are validated, checked and removable', async () => {
  assert.strictEqual((await call('POST', '/api/components', { type: 'portal', name: 'x', url: 'ftp://x' })).body.error, 'errors.componentUrl');
  const r = await call('POST', '/api/components', { type: 'distribution', name: 'Panel itself', url: `${base}/` });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.component.status.state, 'up');
  const down = await call('POST', '/api/components', { type: 'portal', name: 'Nothing', url: 'http://127.0.0.1:1' });
  assert.strictEqual(down.body.component.status.state, 'down');
  assert.strictEqual((await call('DELETE', `/api/components/${down.body.component.id}`)).status, 200);
  assert.strictEqual((await call('GET', '/api/components')).body.components.length, 1);
});

test('language can be set per user and as default', async () => {
  assert.strictEqual((await call('PUT', '/api/me/language', { language: 'nl' })).body.user.language, 'nl');
  assert.strictEqual((await call('PUT', '/api/settings', { language: 'de' })).status, 400);
  assert.strictEqual((await call('PUT', '/api/settings', { language: 'nl' })).body.language, 'nl');
});

test('info shows the version and build', async () => {
  const r = await call('GET', '/api/info');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.version, require('../package.json').version);
  assert.match(r.body.build.commit, /^[0-9a-f]{40}$/);
  assert.strictEqual(r.body.canUpdate, false);
});

test('an update can only be requested on an installed machine', async () => {
  const refused = await call('POST', '/api/info/update', {});
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.error, 'errors.updateNotInstalled');

  fs.writeFileSync(UNIT, '');
  const r = await call('POST', '/api/info/update', { force: true });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.requested, true);
  assert.strictEqual(fs.readFileSync(path.join(DATA_DIR, 'update-request'), 'utf8').trim(), 'force');
});

test('the release channel is stable by default and can be switched to test', async () => {
  assert.strictEqual((await call('GET', '/api/info')).body.channel, 'stable');
  assert.strictEqual((await call('PUT', '/api/info/channel', { channel: 'nightly' })).status, 400);
  const r = await call('PUT', '/api/info/channel', { channel: 'test' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.channel, 'test');
  assert.strictEqual(fs.readFileSync(path.join(DATA_DIR, 'update-channel'), 'utf8').trim(), 'test');
});

test('logout ends the session', async () => {
  await call('POST', '/api/logout');
  assert.strictEqual((await call('GET', '/api/components')).status, 401);
});
