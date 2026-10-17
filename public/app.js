'use strict';
// Single-page admin panel. Every text comes from /locales/<language>.json through t().

const state = { me: null, app: null, languages: ['en'], defaultLanguage: 'en', language: 'en', strings: {}, fallback: {} };
const root = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function t(key, vars = {}) {
  const s = state.strings[key] ?? state.fallback[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

async function api(method, url, body) {
  let res;
  try {
    // Every change is sent as JSON, also without a body: the server refuses anything else.
    const send = method !== 'GET';
    res = await fetch(url, { method, headers: send ? { 'Content-Type': 'application/json' } : {}, body: send ? JSON.stringify(body || {}) : undefined });
  } catch {
    throw Object.assign(new Error(t('errors.network')), { key: 'errors.network' });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') { state.me = null; route(); }
    if (res.status === 403 && data.error === 'errors.mustChangePassword') { state.me.mustChangePassword = true; route(); }
    throw Object.assign(new Error(t(data.error || 'errors.server', data)), { key: data.error, status: res.status, field: data.field, index: data.index });
  }
  return data;
}

async function loadLanguage(lang) {
  const get = async (l) => (await fetch(`/locales/${l}.json`)).json();
  if (!Object.keys(state.fallback).length) state.fallback = await get('en');
  state.language = state.languages.includes(lang) ? lang : 'en';
  state.strings = state.language === 'en' ? state.fallback : await get(state.language);
  document.documentElement.lang = state.language;
  document.title = t('app.name');
}

const userLanguage = () => (state.me && state.me.language) || localStorage.getItem('tvs-language') || state.defaultLanguage;

function formatTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString(state.language === 'nl' ? 'nl-NL' : 'en-GB') : '';
}

function showError(form, err) {
  const box = form.querySelector('.error');
  box.textContent = err.message;
  box.hidden = false;
}

// ---------- layout ----------
function languageSelect() {
  return `<label class="lang">${esc(t('nav.language'))}
    <select id="lang-select">${state.languages.map((l) => `<option value="${l}" ${l === state.language ? 'selected' : ''}>${esc(t(`language.${l}`))}</option>`).join('')}</select>
  </label>`;
}

function bindLanguageSelect() {
  const sel = document.getElementById('lang-select');
  if (!sel) return;
  sel.onchange = async () => {
    localStorage.setItem('tvs-language', sel.value);
    if (state.me && !state.me.mustChangePassword) state.me = (await api('PUT', '/api/me/language', { language: sel.value })).user;
    await loadLanguage(sel.value);
    route();
  };
}

const PAGES = [
  ['dashboard', 'nav.dashboard'],
  ['wizard', 'nav.wizard'],
  ['components', 'nav.components'],
  ['settings', 'nav.settings'],
];

const shortCommit = (c) => (c ? c.slice(0, 7) : '');
const buildLabel = (info) => `v${info.version}${info.build.commit ? ` · ${shortCommit(info.build.commit)}` : ''}`;

function shell(page, content) {
  const info = state.info;
  const banner = info && info.available && page !== 'info'
    ? `<a class="banner" href="#/info">${esc(t('info.availableBanner'))}</a>` : '';
  root.innerHTML = `
    <header class="top">
      <div class="brand">${esc(t('app.name'))}</div>
      <nav>${PAGES.map(([p, k]) => `<a href="#/${p}" class="${p === page ? 'active' : ''}">${esc(t(k))}</a>`).join('')}</nav>
      <div class="user">
        <a href="#/info" class="button info-button ${page === 'info' ? 'active' : ''} ${info && info.available ? 'has-update' : ''}" title="${esc(t('info.title'))}">${esc(info ? buildLabel(info) : `v${state.app.version}`)}</a>
        ${languageSelect()}<span class="who">${esc(state.me.username)}</span><button id="logout" class="link">${esc(t('nav.logout'))}</button>
      </div>
    </header>
    ${banner}
    <main>${content}</main>
    <footer>${esc(t('app.name'))} ${esc(info ? buildLabel(info) : state.app.version)}</footer>`;
  bindLanguageSelect();
  document.getElementById('logout').onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = ''; route(); };
}

function statusBadge(s) {
  const state_ = (s && s.state) || 'unknown';
  return `<span class="badge ${state_}">${esc(t(`status.${state_}`))}</span>`;
}

// ---------- pages ----------
function renderLogin() {
  root.innerHTML = `
    <div class="center"><form class="card narrow" id="login">
      <h1>${esc(t('app.name'))}</h1>
      <h2>${esc(t('login.title'))}</h2>
      <label>${esc(t('login.username'))}<input name="username" autocomplete="username" required autofocus></label>
      <label>${esc(t('login.password'))}<input name="password" type="password" autocomplete="current-password" required></label>
      <p class="error" hidden></p>
      <button class="primary">${esc(t('login.submit'))}</button>
      <div class="foot">${languageSelect()}</div>
    </form></div>`;
  bindLanguageSelect();
  const form = document.getElementById('login');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      state.me = (await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') })).user;
      await loadLanguage(userLanguage());
      route();
    } catch (err) { showError(form, err); }
  };
}

function renderPassword(forced) {
  const content = `
    <form class="card narrow" id="password">
      <h2>${esc(t('password.title'))}</h2>
      ${forced ? `<p class="notice">${esc(t('password.forced'))}</p>` : ''}
      <label>${esc(t('password.current'))}<input name="current" type="password" autocomplete="current-password" required></label>
      <label>${esc(t('password.new'))}<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
      <label>${esc(t('password.repeat'))}<input name="repeat" type="password" autocomplete="new-password" minlength="10" required></label>
      <p class="hint">${esc(t('password.hint', { min: 10 }))}</p>
      <p class="error" hidden></p>
      <p class="ok" hidden></p>
      <button class="primary">${esc(t('password.submit'))}</button>
      ${forced ? `<div class="foot">${languageSelect()}</div>` : ''}
    </form>`;
  if (forced) {
    root.innerHTML = `<div class="center">${content}</div>`;
    bindLanguageSelect();
  } else {
    shell('settings', content);
  }
  const form = document.getElementById('password');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    if (f.get('password') !== f.get('repeat')) return showError(form, new Error(t('password.mismatch')));
    try {
      state.me = (await api('POST', '/api/password', { current: f.get('current'), password: f.get('password') })).user;
      if (forced) { location.hash = '#/dashboard'; route(); return; }
      form.reset();
      form.querySelector('.error').hidden = true;
      const ok = form.querySelector('.ok');
      ok.textContent = t('password.changed');
      ok.hidden = false;
    } catch (err) { showError(form, err); }
  };
}

async function renderDashboard() {
  const [{ components }, { station }] = await Promise.all([api('GET', '/api/components'), api('GET', '/api/station')]);
  const up = components.filter((c) => c.status.state === 'up').length;
  const started = station.target;
  shell('dashboard', `
    <section class="hero card">
      <div>
        <h1>${esc(t('dashboard.title'))}</h1>
        <p>${esc(t('dashboard.intro'))}</p>
      </div>
      <a class="button primary big" href="#/wizard">${esc(t(started ? 'dashboard.continue' : 'dashboard.create'))}</a>
    </section>
    <h2>${esc(t('dashboard.parts'))}</h2>
    ${components.length ? `<p class="hint">${esc(t('dashboard.summary', { up, total: components.length }))}</p>
      <div class="grid">${components.map((c) => `
        <div class="card part">
          <div class="part-head"><strong>${esc(c.name)}</strong>${statusBadge(c.status)}</div>
          <div class="hint">${esc(t(`role.${c.type}`))}</div>
          <a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a>
          <div class="hint">${c.status.checkedAt ? esc(t('status.checked', { time: formatTime(c.status.checkedAt) })) : ''}${c.status.latencyMs != null ? ` · ${esc(t('status.latency', { ms: c.status.latencyMs }))}` : ''}</div>
        </div>`).join('')}</div>`
    : `<p class="card empty">${esc(t('dashboard.noParts'))}</p>`}`);
}

// ---------- wizard ----------
const WIZARD_STEPS = ['target', 'connection', 'parts', 'deploy', 'connect', 'overview'];

function stepper(current) {
  return `<ol class="stepper">${WIZARD_STEPS.map((s, i) => `<li class="${i + 1 === current ? 'current' : i + 1 < current ? 'done' : ''}">${esc(t(`wizard.steps.${s}`))}</li>`).join('')}</ol>`;
}

function wizardShell(step, body) {
  shell('wizard', `
    <h1>${esc(t('wizard.title'))}</h1>
    ${stepper(step)}
    <div class="card">
      <p class="hint">${esc(t('wizard.step', { n: step, total: WIZARD_STEPS.length }))}</p>
      ${body}
    </div>`);
}

const backButton = () => `<button type="button" id="back">${esc(t('wizard.back'))}</button>`;
function bindBack(step) {
  const b = document.getElementById('back');
  if (b) b.onclick = async () => { await api('PUT', '/api/station', { step: step - 1 }); renderWizard(); };
}

function formatBytes(n) {
  if (!n) return '';
  const gb = n / 1024 ** 3;
  return gb >= 1024 ? `${(gb / 1024).toFixed(1)} TB` : `${Math.round(gb)} GB`;
}

async function renderWizard() {
  const { station, catalog, defaults, vmMin } = await api('GET', '/api/station');
  const step = station.target ? Math.min(station.step || 2, 4) : 1;
  if (step === 1) return renderTargetStep(station);
  if (step === 2) return station.target === 'proxmox' ? renderProxmoxStep(station) : renderMachinesStep();
  if (step === 3) return renderPartsStep(station, catalog, defaults, vmMin);
  return renderDeployStep();
}

function renderTargetStep(station) {
  wizardShell(1, `
    <h2>${esc(t('wizard.step1.title'))}</h2>
    <p>${esc(t('wizard.step1.intro'))}</p>
    <form id="target">
      <div class="choices">${['proxmox', 'machines'].map((v) => `
        <label class="choice"><input type="radio" name="target" value="${v}" required ${station.target === v ? 'checked' : ''}>
          <span><strong>${esc(t(`wizard.target.${v}`))}</strong><span class="hint">${esc(t(`wizard.target.${v}.about`))}</span></span>
        </label>`).join('')}</div>
      <p class="error" hidden></p>
      <div class="actions"><button class="primary">${esc(t('wizard.next'))}</button></div>
    </form>`);
  const form = document.getElementById('target');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PUT', '/api/station', { target: new FormData(form).get('target') }); renderWizard(); } catch (err) { showError(form, err); }
  };
}

function renderMachinesStep() {
  wizardShell(2, `
    <h2>${esc(t('wizard.machines.title'))}</h2>
    <p class="notice">${esc(t('wizard.machines.pending'))}</p>
    <div class="actions">${backButton()}</div>`);
  bindBack(2);
}

async function renderProxmoxStep(station) {
  const saved = station.proxmox || {};
  const { publicKey } = await api('GET', '/api/proxmox/key');
  const authorize = `echo '${publicKey}' >> /root/.ssh/authorized_keys`;
  wizardShell(2, `
    <h2>${esc(t('wizard.proxmox.title'))}</h2>
    <p>${esc(t('wizard.proxmox.intro'))}</p>
    <h3>${esc(t('wizard.proxmox.keyTitle'))}</h3>
    <p>${esc(t('wizard.proxmox.keyIntro'))}</p>
    <div class="copy"><pre id="authorize">${esc(authorize)}</pre><button type="button" id="copy">${esc(t('wizard.copy'))}</button></div>
    <form id="connect" class="row">
      <label class="grow">${esc(t('wizard.proxmox.host'))}<input name="host" required placeholder="192.168.1.10" value="${esc(saved.host || '')}"></label>
      <label class="small">${esc(t('wizard.proxmox.port'))}<input name="port" type="number" min="1" max="65535" value="${esc(saved.port || 22)}"></label>
      <button class="primary" id="connect-button">${esc(t('wizard.proxmox.connect'))}</button>
      <p class="error wide" hidden></p>
    </form>
    <div id="found"></div>
    <div class="actions" id="step-actions">${backButton()}</div>`);
  bindBack(2);
  document.getElementById('copy').onclick = async (e) => {
    try { await navigator.clipboard.writeText(authorize); e.target.textContent = t('wizard.copied'); } catch { /* not allowed on plain http */ }
  };
  const form = document.getElementById('connect');
  const connect = async () => {
    const f = new FormData(form);
    const target = { host: f.get('host'), port: Number(f.get('port') || 22) };
    const button = document.getElementById('connect-button');
    button.disabled = true;
    button.textContent = t('wizard.proxmox.connecting');
    form.querySelector('.error').hidden = true;
    try {
      const { found } = await api('POST', '/api/proxmox/discover', target);
      renderProxmoxChoices(target, found, saved);
    } catch (err) {
      showError(form, err);
      document.getElementById('found').innerHTML = '';
    }
    button.disabled = false;
    button.textContent = t('wizard.proxmox.connect');
  };
  form.onsubmit = (e) => { e.preventDefault(); connect(); };
  if (saved.host) connect();
}

function renderProxmoxChoices(target, found, saved) {
  const box = document.getElementById('found');
  const guestType = saved.guestType || 'lxc';
  box.innerHTML = `
    <p class="ok">${esc(t('wizard.proxmox.connected', { node: found.node, version: found.version }))}</p>
    ${found.fingerprint ? `<p class="hint">${esc(t('wizard.proxmox.fingerprint'))} <code>${esc(found.fingerprint)}</code></p>` : ''}
    <form id="choices">
      <h3>${esc(t('wizard.proxmox.guestTitle'))}</h3>
      <div class="choices">${['lxc', 'vm'].map((v) => `
        <label class="choice"><input type="radio" name="guestType" value="${v}" ${v === guestType ? 'checked' : ''}>
          <span><strong>${esc(t(`wizard.guest.${v}`))}</strong><span class="hint">${esc(t(`wizard.guest.${v}.about`))}</span></span>
        </label>`).join('')}</div>
      <h3>${esc(t('wizard.proxmox.placement'))}</h3>
      <label>${esc(t('wizard.proxmox.storage'))}<select name="storage" required></select></label>
      <p class="hint" id="storage-hint"></p>
      <label>${esc(t('wizard.proxmox.bridge'))}<select name="bridge" required>${found.bridges.map((b) => `<option ${b === saved.bridge ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select></label>
      <label>${esc(t('wizard.proxmox.pool'))}<input name="pool" required maxlength="40" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*" list="pools" value="${esc(saved.pool || 'tvstation')}"></label>
      <datalist id="pools">${found.pools.map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
      <p class="hint" id="pool-hint"></p>
      <p class="error" hidden></p>
      <div class="actions">${backButton()}<button class="primary">${esc(t('wizard.saveNext'))}</button></div>
    </form>`;
  // The form now has its own Back button next to Save.
  const outer = document.getElementById('step-actions');
  if (outer) outer.remove();
  bindBack(2);
  const form = document.getElementById('choices');
  const fillStorage = () => {
    const type = new FormData(form).get('guestType');
    const fits = found.storage.filter((s) => s.content.includes(type === 'vm' ? 'images' : 'rootdir'));
    const sel = form.querySelector('[name=storage]');
    const keep = sel.value || saved.storage;
    sel.innerHTML = fits.map((s) => `<option value="${esc(s.id)}" ${s.id === keep ? 'selected' : ''}>${esc(s.id)} (${esc(s.type)}${s.avail ? `, ${esc(t('wizard.proxmox.free', { size: formatBytes(s.avail) }))}` : ''})</option>`).join('');
    document.getElementById('storage-hint').textContent = fits.length ? '' : t('wizard.proxmox.noStorage');
  };
  const poolHint = () => {
    const name = form.querySelector('[name=pool]').value.trim();
    document.getElementById('pool-hint').textContent = t(found.pools.includes(name) ? 'wizard.proxmox.poolExists' : 'wizard.proxmox.poolNew');
  };
  form.querySelectorAll('[name=guestType]').forEach((r) => { r.onchange = fillStorage; });
  form.querySelector('[name=pool]').oninput = poolHint;
  fillStorage();
  poolHint();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button.primary');
    button.disabled = true;
    try {
      await api('PUT', '/api/station/proxmox', { ...target, ...f });
      renderWizard();
    } catch (err) { showError(form, err); button.disabled = false; }
  };
}

function renderPartsStep(station, catalog, defaults, vmMin) {
  const px = station.proxmox;
  const guestType = station.target === 'proxmox' && px ? px.guestType : 'vm';
  const viaScript = guestType === 'lxc';
  const draft = station.parts.map((p) => ({ ...p }));
  const proxy = { ...station.proxy };

  const summary = px ? `
    <dl class="facts">
      <dt>${esc(t('wizard.proxmox.node'))}</dt><dd>${esc(px.node)} (${esc(px.host)})</dd>
      <dt>${esc(t('wizard.proxmox.guestTitle'))}</dt><dd>${esc(t(`wizard.guest.${px.guestType}`))}</dd>
      <dt>${esc(t('wizard.proxmox.storage'))}</dt><dd>${esc(px.storage)} · ${esc(px.bridge)} · ${esc(t('wizard.proxmox.pool'))} ${esc(px.pool)}</dd>
    </dl>` : '';

  const field = (i, name, label, value, attrs = '') => `<label>${esc(label)}<input name="${name}" data-i="${i}" value="${esc(value ?? '')}" ${attrs}></label>`;
  const url = (p) => (proxy.domain ? `${proxy.tls ? 'https' : 'http'}://${proxy.domain}${p.path === '/' ? '/' : `${p.path}/`}` : '');
  const blank = { network: 'dhcp', ip: '', gateway: '', auth: false, authUser: 'admin' };

  function partCard(p, i) {
    const c = catalog[p.type];
    const ready = c.installer && (viaScript ? c.proxmoxScript : (c.debianScript || c.builtIn));
    const canRemove = p.type === 'generator' ? draft.filter((x) => x.type === 'generator').length > 1 : p.type !== 'proxy';
    return `<div class="card part-edit" data-index="${i}">
      <div class="part-head">
        <strong>${esc(t(`role.${p.type}`))} · ${esc(c.project)}</strong>
        <span class="badge ${ready ? 'up' : 'unknown'}">${esc(t(ready ? 'wizard.installer' : 'wizard.noInstaller'))}</span>
      </div>
      <p class="hint">${esc(t(`role.${p.type}.about`))}</p>
      <div class="fields">
        ${field(i, 'name', t('wizard.parts.name'), p.name, 'maxlength="60" required')}
        ${field(i, 'hostname', t('wizard.parts.hostname'), p.hostname, 'maxlength="63" required')}
        ${field(i, 'cpu', t('wizard.parts.cpu'), p.cpu, 'type="number" min="1" max="64" required')}
        ${field(i, 'ram', t('wizard.parts.ram'), p.ram, `type="number" min="${guestType === 'vm' ? vmMin.ram : 256}" step="256" required`)}
        ${field(i, 'disk', t('wizard.parts.disk'), p.disk, `type="number" min="${guestType === 'vm' ? vmMin.disk : 1}" required`)}
        <label>${esc(t('wizard.parts.network'))}<select name="network" data-i="${i}">
          <option value="dhcp" ${p.network !== 'static' ? 'selected' : ''}>DHCP</option>
          <option value="static" ${p.network === 'static' ? 'selected' : ''}>${esc(t('wizard.parts.static'))}</option>
        </select></label>
        ${p.network === 'static' ? `${field(i, 'ip', t('wizard.parts.ip'), p.ip, 'placeholder="192.168.1.50/24" required')}${field(i, 'gateway', t('wizard.parts.gateway'), p.gateway, 'placeholder="192.168.1.1" required')}` : ''}
        ${p.type !== 'proxy' ? field(i, 'path', t('wizard.parts.path'), p.path, 'required') : ''}
      </div>
      ${p.type === 'generator' && guestType === 'lxc' ? `<label class="check"><input type="checkbox" name="gpu" data-i="${i}" ${p.gpu ? 'checked' : ''}> ${esc(t('wizard.parts.gpu'))}</label>` : ''}
      ${p.type !== 'proxy' ? `<label class="check"><input type="checkbox" name="auth" data-i="${i}" ${p.auth ? 'checked' : ''}> ${esc(t('wizard.parts.auth'))}</label>
        ${p.auth ? `<div class="fields">${field(i, 'authUser', t('wizard.parts.authUser'), p.authUser, 'required maxlength="32"')}</div><p class="hint">${esc(t('wizard.parts.authHint'))}</p>` : ''}
        ${draft.some((x) => x.type === 'proxy') ? `<p class="hint address" ${url(p) ? '' : 'hidden'}>${esc(t('wizard.parts.address'))} <code>${esc(url(p))}</code></p>` : ''}` : ''}
      ${p.type === 'portal' && p.path !== '/' ? `<p class="notice">${esc(t('wizard.parts.portalRoot'))}</p>` : ''}
      ${canRemove ? `<div class="actions"><button type="button" class="danger" data-remove="${i}">${esc(t('wizard.parts.remove'))}</button></div>` : ''}
    </div>`;
  }

  // Reads the form back into the draft, so a re-render keeps what was typed.
  function collect() {
    const form = document.getElementById('parts');
    if (!form) return;
    form.querySelectorAll('[data-i]').forEach((el) => {
      const p = draft[Number(el.dataset.i)];
      if (!p) return;
      if (el.type === 'checkbox') p[el.name] = el.checked;
      else if (['cpu', 'ram', 'disk'].includes(el.name)) p[el.name] = Number(el.value);
      else p[el.name] = el.value;
    });
    const f = new FormData(form);
    proxy.domain = String(f.get('domain') || '').trim();
    proxy.email = String(f.get('email') || proxy.email || '').trim();
    const tls = form.querySelector('[name=tls]');
    if (tls) proxy.tls = tls.checked;
  }

  function render(error) {
    const hasProxy = draft.some((p) => p.type === 'proxy');
    const missing = ['distribution', 'portal'].filter((type) => !draft.some((p) => p.type === type));
    wizardShell(3, `
      <h2>${esc(t('wizard.parts.title'))}</h2>
      ${summary}
      <form id="parts" novalidate>
        ${hasProxy ? `<div class="card">
          <h3>${esc(t('wizard.parts.domainTitle'))}</h3>
          <p class="hint">${esc(t('wizard.parts.domainIntro'))}</p>
          <div class="fields">
            <label>${esc(t('wizard.parts.domain'))}<input name="domain" placeholder="tv.example.com" value="${esc(proxy.domain)}" required></label>
            ${proxy.tls ? `<label>${esc(t('wizard.parts.email'))}<input name="email" type="email" value="${esc(proxy.email)}" required></label>` : ''}
          </div>
          <label class="check"><input type="checkbox" name="tls" ${proxy.tls ? 'checked' : ''}> ${esc(t('wizard.parts.tls'))}</label>
        </div>` : ''}
        ${draft.map(partCard).join('')}
        <div class="actions left">
          <button type="button" id="add-generator">${esc(t('wizard.parts.addGenerator'))}</button>
          ${missing.map((type) => `<button type="button" data-add="${type}">${esc(t('wizard.parts.add', { part: t(`role.${type}`) }))}</button>`).join('')}
        </div>
        <p class="error" ${error ? '' : 'hidden'}>${esc(error || '')}</p>
        <div class="actions">${backButton()}<button class="primary">${esc(t('wizard.saveNext'))}</button></div>
      </form>`);
    bindBack(3);
    const form = document.getElementById('parts');
    // Changes that show or hide fields re-render the form.
    form.querySelectorAll('[name=network], [name=auth], [name=tls]').forEach((el) => { el.onchange = () => { collect(); render(); }; });
    // The public addresses follow the domain and paths as you type, without a re-render.
    const updateAddresses = () => {
      collect();
      form.querySelectorAll('.part-edit').forEach((card) => {
        const line = card.querySelector('.address');
        if (!line) return;
        const address = url(draft[Number(card.dataset.index)]);
        line.hidden = !address;
        line.querySelector('code').textContent = address;
      });
    };
    form.querySelectorAll('[name=domain], [name=path]').forEach((el) => { el.oninput = updateAddresses; });
    form.querySelectorAll('[data-remove]').forEach((b) => { b.onclick = () => { collect(); draft.splice(Number(b.dataset.remove), 1); render(); }; });
    document.getElementById('add-generator').onclick = () => {
      collect();
      const used = new Set(draft.map((p) => p.hostname));
      let n = 1;
      while (used.has(`tv-channel${n}`)) n += 1;
      const at = draft.filter((p) => p.type === 'generator').length;
      draft.splice(at, 0, { type: 'generator', ...defaults.generator, ...blank, name: `Channel ${n}`, hostname: `tv-channel${n}`, path: `/channel${n}` });
      render();
    };
    const names = { distribution: ['Distribution', 'tv-mediamtx', '/stream'], portal: ['IPTV portal', 'tv-portal', '/'] };
    form.querySelectorAll('[data-add]').forEach((b) => {
      b.onclick = () => {
        collect();
        const [name, hostname, path] = names[b.dataset.add];
        draft.push({ type: b.dataset.add, ...defaults[b.dataset.add], ...blank, name, hostname, path });
        render();
      };
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      collect();
      try {
        await api('PUT', '/api/station/parts', { parts: draft, proxy });
        renderWizard();
      } catch (err) {
        render(err.message);
        const scope = err.index !== undefined ? document.querySelector(`[data-index="${err.index}"]`) : document;
        const bad = err.field && scope && scope.querySelector(`[name="${err.field}"]`);
        if (bad) { bad.classList.add('invalid'); bad.focus(); }
      }
    };
  }
  render();
}

function renderDeployStep() {
  wizardShell(4, `
    <h2>${esc(t('wizard.deploy.title'))}</h2>
    <p class="notice">${esc(t('wizard.deploy.pending'))}</p>
    <div class="actions">${backButton()}</div>`);
  bindBack(4);
}

async function renderComponents(editId) {
  const { components, catalog } = await api('GET', '/api/components');
  const editing = components.find((c) => c.id === editId);
  const typeOptions = (sel) => Object.keys(catalog).map((k) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(t(`role.${k}`))}</option>`).join('');
  shell('components', `
    <h1>${esc(t('components.title'))}</h1>
    <p>${esc(t('components.intro'))}</p>
    <div class="card">
      ${components.length ? `<table>
        <tbody>${components.map((c) => `<tr>
          <td>${statusBadge(c.status)}</td>
          <td><strong>${esc(c.name)}</strong><div class="hint">${esc(t(`role.${c.type}`))}</div></td>
          <td><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.url)}</a></td>
          <td><div class="actions"><button data-edit="${esc(c.id)}">${esc(t('components.edit'))}</button><button data-delete="${esc(c.id)}" data-name="${esc(c.name)}" class="danger">${esc(t('components.delete'))}</button></div></td>
        </tr>`).join('')}</tbody></table>
        <button id="check">${esc(t('components.checkNow'))}</button>`
      : `<p>${esc(t('components.none'))}</p>`}
    </div>
    <form class="card narrow" id="component">
      <h2>${esc(editing ? editing.name : t('components.add'))}</h2>
      <label>${esc(t('components.type'))}<select name="type">${typeOptions(editing && editing.type)}</select></label>
      <label>${esc(t('components.name'))}<input name="name" maxlength="80" required value="${esc(editing ? editing.name : '')}"></label>
      <label>${esc(t('components.url'))}<input name="url" type="url" required placeholder="${esc(t('components.urlHint'))}" value="${esc(editing ? editing.url : '')}"></label>
      <p class="error" hidden></p>
      <div class="actions">${editing ? `<button type="button" id="cancel">${esc(t('components.cancel'))}</button>` : ''}<button class="primary">${esc(t('components.save'))}</button></div>
    </form>`);
  root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => renderComponents(b.dataset.edit); });
  root.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(t('components.confirmDelete', { name: b.dataset.name }))) return;
      await api('DELETE', `/api/components/${encodeURIComponent(b.dataset.delete)}`);
      renderComponents();
    };
  });
  const check = document.getElementById('check');
  if (check) check.onclick = async () => { check.disabled = true; await api('POST', '/api/components/check'); renderComponents(editId); };
  const cancel = document.getElementById('cancel');
  if (cancel) cancel.onclick = () => renderComponents();
  const form = document.getElementById('component');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      if (editing) await api('PUT', `/api/components/${encodeURIComponent(editing.id)}`, f);
      else await api('POST', '/api/components', f);
      renderComponents();
    } catch (err) { showError(form, err); }
  };
}

function formatDateTime(iso) {
  return iso ? new Date(iso).toLocaleString(state.language === 'nl' ? 'nl-NL' : 'en-GB') : '';
}

let updatePoll = null;
async function renderInfo() {
  const info = state.info = await api('GET', '/api/info');
  const updating = info.requested;
  shell('info', `
    <h1>${esc(t('info.title'))}</h1>
    <div class="card">
      <dl class="facts">
        <dt>${esc(t('info.version'))}</dt><dd>${esc(info.version)}</dd>
        <dt>${esc(t('info.build'))}</dt><dd>${info.build.commit ? `<code>${esc(shortCommit(info.build.commit))}</code> · ${esc(formatDateTime(info.build.date))}` : esc(t('info.noBuild'))}</dd>
        ${info.build.subject ? `<dt>${esc(t('info.change'))}</dt><dd>${esc(info.build.subject)}</dd>` : ''}
        <dt>${esc(t('info.branch'))}</dt><dd>${esc(info.branch)}</dd>
        <dt>${esc(t('info.lastCheck'))}</dt><dd>${info.checkedAt ? esc(formatDateTime(info.checkedAt)) : esc(t('info.never'))}</dd>
      </dl>
      ${info.error ? `<p class="error">${esc(t(info.error, { branch: info.branch }))}</p>` : ''}
      ${updating ? `<p class="notice">${esc(t('info.updating'))}</p>`
        : info.available ? `<p class="notice">${esc(t('info.available', { commit: shortCommit(info.latest) }))}</p>`
        : info.checkedAt && !info.error ? `<p class="ok">${esc(t('info.upToDate'))}</p>` : ''}
      ${!info.canUpdate ? `<p class="hint">${esc(t('info.notInstalled'))}</p>` : ''}
      <p class="error" id="info-error" hidden></p>
      <div class="actions">
        <button id="check" ${updating ? 'disabled' : ''}>${esc(t('info.checkNow'))}</button>
        ${info.canUpdate && !info.available ? `<button id="reinstall" ${updating ? 'disabled' : ''}>${esc(t('info.reinstall'))}</button>` : ''}
        ${info.canUpdate && info.available ? `<button id="update" class="primary" ${updating ? 'disabled' : ''}>${esc(t('info.updateNow'))}</button>` : ''}
      </div>
    </div>
    ${info.log ? `<h2>${esc(t('info.log'))}</h2><pre class="log">${esc(info.log)}</pre>` : ''}`);

  const fail = (err) => { const e = document.getElementById('info-error'); e.textContent = err.message; e.hidden = false; };
  document.getElementById('check').onclick = async (e) => {
    e.target.disabled = true;
    try { state.info = await api('POST', '/api/info/check'); renderInfo(); } catch (err) { fail(err); e.target.disabled = false; }
  };
  const start = async (force) => {
    if (force && !confirm(t('info.confirmReinstall'))) return;
    try { await api('POST', '/api/info/update', { force }); waitForUpdate(info.build.commit); } catch (err) { fail(err); }
  };
  const update = document.getElementById('update');
  if (update) update.onclick = () => start(false);
  const reinstall = document.getElementById('reinstall');
  if (reinstall) reinstall.onclick = () => start(true);
  if (updating && !updatePoll) waitForUpdate(info.build.commit);
}

// While the update runs the panel restarts: poll until it answers again, then reload the page
// so the browser runs the new version too.
function waitForUpdate(fromCommit) {
  clearInterval(updatePoll);
  let wentAway = false;
  const startedAt = new Date().toISOString();
  renderUpdating();
  updatePoll = setInterval(async () => {
    try {
      const res = await fetch('/api/info');
      if (!res.ok) return;
      const info = await res.json();
      if (!info.requested && (wentAway || info.build.commit !== fromCommit)) {
        clearInterval(updatePoll);
        updatePoll = null;
        location.hash = '#/info';
        location.reload();
      } else if (!info.requested && info.logFinished && info.logAt > startedAt) {
        // The update finished without a restart (already up to date, or it failed): show the log.
        clearInterval(updatePoll);
        updatePoll = null;
        renderInfo();
      }
    } catch { wentAway = true; }
  }, 2000);
}

function renderUpdating() {
  const main = root.querySelector('main');
  if (main) main.innerHTML = `<div class="card center-text"><div class="spinner"></div><h2>${esc(t('info.updatingTitle'))}</h2><p>${esc(t('info.updating'))}</p></div>`;
}

async function renderSettings() {
  const settings = await api('GET', '/api/settings');
  renderPassword(false);
  const main = root.querySelector('main');
  main.insertAdjacentHTML('afterbegin', `
    <h1>${esc(t('settings.title'))}</h1>
    <form class="card narrow" id="settings">
      <label>${esc(t('settings.language'))}<select name="language">${state.languages.map((l) => `<option value="${l}" ${l === settings.language ? 'selected' : ''}>${esc(t(`language.${l}`))}</option>`).join('')}</select></label>
      <p class="hint">${esc(t('settings.languageHint'))}</p>
      <p class="error" hidden></p>
      <p class="ok" hidden></p>
      <button class="primary">${esc(t('settings.save'))}</button>
    </form>`);
  const form = document.getElementById('settings');
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const saved = await api('PUT', '/api/settings', { language: new FormData(form).get('language') });
      state.defaultLanguage = saved.language;
      const ok = form.querySelector('.ok');
      ok.textContent = t('settings.saved');
      ok.hidden = false;
    } catch (err) { showError(form, err); }
  };
}

// ---------- routing ----------
let refresh = null;
async function route() {
  clearInterval(refresh);
  if (!state.me) return renderLogin();
  if (state.me.mustChangePassword) return renderPassword(true);
  if (!state.info) state.info = await api('GET', '/api/info').catch(() => null);
  const page = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
  try {
    if (page === 'wizard') await renderWizard();
    else if (page === 'components') await renderComponents();
    else if (page === 'settings') await renderSettings();
    else if (page === 'info') await renderInfo();
    else {
      await renderDashboard();
      refresh = setInterval(() => { if (!document.hidden) renderDashboard().catch(() => {}); }, 15000);
    }
  } catch (err) {
    if (err.status !== 401 && err.status !== 403) root.innerHTML = `<div class="center"><p class="card error">${esc(err.message)}</p></div>`;
  }
}

window.addEventListener('hashchange', route);

(async function start() {
  const me = await fetch('/api/me').then((r) => r.json());
  Object.assign(state, { me: me.user, app: me.app, languages: me.languages, defaultLanguage: me.defaultLanguage });
  await loadLanguage(userLanguage());
  route();
}());
