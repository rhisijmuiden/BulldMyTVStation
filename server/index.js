'use strict';
const path = require('path');
const express = require('express');

const store = require('./store');
const auth = require('./auth');
const components = require('./components');
const updater = require('./updater');
const proxmox = require('./proxmox');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const LANGUAGES = ['en', 'nl'];
const TARGETS = ['proxmox', 'machines'];

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '100kb' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Requests that change something must be JSON: a plain HTML form on another site cannot send that,
// which together with the SameSite=Strict cookie keeps cross-site requests out.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({ error: 'errors.jsonOnly' });
  }
  next();
});

// ---------- auth ----------
// Brute-force brake: five wrong passwords per address and user name, then a growing pause.
const failures = new Map(); // key -> { count, until }
function throttled(key) {
  const f = failures.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function failed(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) f.until = Date.now() + Math.min(15 * 60, 30 * 2 ** (f.count - 5)) * 1000;
  failures.set(key, f);
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = `${req.ip}|${String(username || '').toLowerCase()}`;
  const wait = throttled(key);
  if (wait) return res.status(429).json({ error: 'errors.tooManyAttempts', seconds: wait });
  const user = auth.verify(username, password);
  if (!user) { failed(key); return res.status(401).json({ error: 'errors.invalidLogin' }); }
  failures.delete(key);
  auth.login(res, user, req.secure);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = auth.currentUser(req);
  res.json({ user: auth.publicUser(user), app: { name: 'Build My TV Station', version: pkg.version }, languages: LANGUAGES, defaultLanguage: store.getSection('settings').language || 'en' });
});

// Also allowed while the one-time password is still active: that is how it gets changed.
app.post('/api/password', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'errors.notLoggedIn' });
  const { current, password } = req.body || {};
  const error = auth.passwordError(user, current, password);
  if (error) return res.status(400).json({ error, min: auth.MIN_LENGTH });
  auth.setPassword(user.id, password);
  auth.endOtherSessions(req, user.id);
  res.json({ user: auth.publicUser(store.get('users', user.id)) });
});

app.put('/api/me/language', auth.requireAuth, (req, res) => {
  const language = String((req.body || {}).language || '');
  if (language && !LANGUAGES.includes(language)) return res.status(400).json({ error: 'errors.language' });
  res.json({ user: auth.publicUser(store.update('users', req.user.id, { language })) });
});

// ---------- settings ----------
app.get('/api/settings', auth.requireAuth, (req, res) => {
  res.json({ language: 'en', ...store.getSection('settings') });
});

app.put('/api/settings', auth.requireAuth, (req, res) => {
  const language = String((req.body || {}).language || '');
  if (!LANGUAGES.includes(language)) return res.status(400).json({ error: 'errors.language' });
  res.json(store.setSection('settings', { language }));
});

// ---------- station wizard ----------
// The wizard keeps its answers in the "station" section, so it can be left and picked up again.
app.get('/api/station', auth.requireAuth, (req, res) => {
  res.json({ station: store.getSection('station'), catalog: components.CATALOG });
});

// Step 1 (where the station runs), or going back to an earlier step.
app.put('/api/station', auth.requireAuth, (req, res) => {
  const { target, step } = req.body || {};
  const station = store.getSection('station');
  if (step !== undefined) {
    if (!Number.isInteger(step) || step < 1 || step > (station.step || 1)) return res.status(400).json({ error: 'errors.step' });
    return res.json({ station: store.setSection('station', { step }) });
  }
  if (!TARGETS.includes(target)) return res.status(400).json({ error: 'errors.target' });
  res.json({ station: store.setSection('station', { target, step: 2 }) });
});

app.delete('/api/station', auth.requireAuth, (req, res) => {
  store.setSection('station', { target: null, step: 1, proxmox: null });
  res.json({ station: store.getSection('station') });
});

// ---------- step 2: Proxmox connection ----------
app.get('/api/proxmox/key', auth.requireAuth, wrap(async (req, res) => {
  res.json({ publicKey: await proxmox.publicKey() });
}));

// Connects to the node and returns what the wizard can offer there.
app.post('/api/proxmox/discover', auth.requireAuth, wrap(async (req, res) => {
  const { error, value } = proxmox.validateTarget(req.body || {});
  if (error) return res.status(400).json({ error });
  await proxmox.publicKey();
  try {
    res.json({ found: await proxmox.discover(value) });
  } catch (err) {
    if (!err.key) throw err;
    res.status(502).json({ error: err.key, detail: err.message.trim().slice(-300) });
  }
}));

// Saves the choices after checking them against the node again, and creates the resource pool.
app.put('/api/station/proxmox', auth.requireAuth, wrap(async (req, res) => {
  const body = req.body || {};
  const { error, value: target } = proxmox.validateTarget(body);
  if (error) return res.status(400).json({ error });
  const choice = { storage: String(body.storage || ''), bridge: String(body.bridge || ''), pool: String(body.pool || '').trim(), guestType: String(body.guestType || '') };
  let found;
  let poolCreated;
  try {
    found = await proxmox.discover(target);
    const invalid = proxmox.choiceError(found, choice);
    if (invalid) return res.status(400).json({ error: invalid });
    poolCreated = await proxmox.ensurePool(target, choice.pool);
  } catch (err) {
    if (!err.key) throw err;
    return res.status(502).json({ error: err.key, detail: err.message.trim().slice(-300) });
  }
  const saved = { ...target, ...choice, node: found.node, version: found.version, fingerprint: found.fingerprint, savedAt: new Date().toISOString() };
  res.json({ station: store.setSection('station', { proxmox: saved, step: 3 }), poolCreated });
}));

// ---------- components and monitoring ----------
app.get('/api/components', auth.requireAuth, (req, res) => {
  res.json({ components: store.list('components').map(components.withStatus), catalog: components.CATALOG });
});

app.post('/api/components', auth.requireAuth, wrap(async (req, res) => {
  const { error, value } = components.validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const c = store.create('components', value);
  await components.checkOne(c);
  res.status(201).json({ component: components.withStatus(c) });
}));

app.put('/api/components/:id', auth.requireAuth, wrap(async (req, res) => {
  if (!store.get('components', req.params.id)) return res.status(404).json({ error: 'errors.notFound' });
  const { error, value } = components.validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const c = store.update('components', req.params.id, value);
  await components.checkOne(c);
  res.json({ component: components.withStatus(c) });
}));

app.delete('/api/components/:id', auth.requireAuth, (req, res) => {
  if (!store.remove('components', req.params.id)) return res.status(404).json({ error: 'errors.notFound' });
  components.status.delete(req.params.id);
  res.json({ ok: true });
});

app.post('/api/components/check', auth.requireAuth, wrap(async (req, res) => {
  await components.checkAll();
  res.json({ components: store.list('components').map(components.withStatus) });
}));

// ---------- version and updates ----------
app.get('/api/info', auth.requireAuth, wrap(async (req, res) => {
  res.json(await updater.status());
}));

app.post('/api/info/check', auth.requireAuth, wrap(async (req, res) => {
  res.json(await updater.check());
}));

app.post('/api/info/update', auth.requireAuth, wrap(async (req, res) => {
  if (!updater.requestUpdate({ force: !!(req.body || {}).force })) return res.status(409).json({ error: 'errors.updateNotInstalled' });
  res.json(await updater.status());
}));

// ---------- static ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'errors.notFound' }));
app.use(express.static(PUBLIC, { index: 'index.html' }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'errors.badRequest' });
  console.error(err);
  res.status(500).json({ error: 'errors.server' });
});

if (require.main === module) {
  if (process.argv[2] === 'admin-reset') {
    const username = process.argv[3] || 'admin';
    console.log(`One-time password for "${username}": ${auth.resetAdmin(username)}`);
    console.log('Restart the service to end existing sessions: systemctl restart tvstation');
    process.exit(0);
  }
  auth.bootstrap();
  components.startMonitor();
  updater.start();
  app.listen(PORT, HOST, () => console.log(`Build My TV Station ${pkg.version} listening on http://${HOST}:${PORT}`));
}

module.exports = app;
