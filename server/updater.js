'use strict';
// The version and build of the running panel, the release channel it follows, a daily check for
// a newer version and starting an update from the panel.
//
// Two release channels:
//   stable  the newest release tag vX.Y.Z (tags with a suffix, like v1.2.0-rc.1, are pre-releases)
//   test    the newest commit on the branch (TVSTATION_REF, default main)
// The channel lives in CHANNEL_FILE, so scripts/update.sh (the `update` command) follows it too. The update itself runs as root through the tvstation-update systemd
// units (see deploy/): this process only writes the request file that their path unit watches.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const APP_DIR = path.join(__dirname, '..');
const REF = process.env.TVSTATION_REF || 'main';
const REQUEST_FILE = path.join(store.DATA_DIR, 'update-request');
const LOG_FILE = path.join(store.DATA_DIR, 'update.log');
const CHANNEL_FILE = path.join(store.DATA_DIR, 'update-channel');
const CHANNELS = ['stable', 'test'];
const DEFAULT_CHANNEL = 'stable';
const PATH_UNIT = process.env.TVSTATION_UPDATE_UNIT || '/etc/systemd/system/tvstation-update.path';
const DAY = 24 * 60 * 60 * 1000;

const state = { latest: null, latestVersion: null, checkedAt: null, error: null };

function channel() {
  try {
    const c = fs.readFileSync(CHANNEL_FILE, 'utf8').trim();
    if (CHANNELS.includes(c)) return c;
  } catch { /* not chosen yet */ }
  return DEFAULT_CHANNEL;
}

function setChannel(c) {
  if (!CHANNELS.includes(c)) return false;
  if (c !== channel()) {
    fs.writeFileSync(CHANNEL_FILE, `${c}\n`);
    // What is available depends on the channel: forget the last check.
    Object.assign(state, { latest: null, latestVersion: null, checkedAt: null, error: null });
  }
  return true;
}

// Compares two versions like 1.2.3 (a leading v and a pre-release suffix are allowed;
// 1.2.3-rc.1 comes before 1.2.3). Returns <0, 0 or >0.
function compareVersions(a, b) {
  const parse = (v) => {
    const m = String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
    return m ? [+m[1], +m[2], +m[3], m[4] ? 0 : 1] : [0, 0, 0, 0];
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The newest stable release in `git ls-remote --tags` output: { tag, version, commit } or null.
// Annotated tags are listed twice; the peeled line (tag^{}) carries the commit.
function latestStable(lsRemote) {
  const tags = new Map();
  for (const line of String(lsRemote).split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/);
    if (m && (m[3] || !tags.has(m[2]))) tags.set(m[2], m[1]);
  }
  const best = [...tags.keys()].sort(compareVersions).pop();
  return best ? { tag: best, version: best.slice(1), commit: tags.get(best) } : null;
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: APP_DIR, timeout }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });
}
// safe.directory: the checkout may be owned by another user than the one running the server.
// Only read-only git commands are used here: the service cannot write to the checkout.
const git = (...args) => run('git', ['-c', `safe.directory=${APP_DIR}`, '-C', APP_DIR, ...args]);

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return null; }
}

// The build: the commit the panel runs, with its date and message.
async function build() {
  try {
    const [commit, date, subject] = (await git('log', '-1', '--format=%H%n%cI%n%s')).split('\n');
    return { commit, date, subject };
  } catch { return { commit: null, date: null, subject: null }; }
}

async function check() {
  try {
    if (channel() === 'stable') {
      const release = latestStable(await git('ls-remote', '--tags', 'origin', 'refs/tags/v*'));
      state.latest = release && release.commit;
      state.latestVersion = release && release.version;
      state.error = release ? null : 'errors.updateNoRelease';
    } else {
      const out = await git('ls-remote', 'origin', `refs/heads/${REF}`);
      state.latest = out.split(/\s+/)[0] || null;
      state.latestVersion = null;
      state.error = state.latest ? null : 'errors.updateBranch';
    }
  } catch {
    state.error = 'errors.updateUnreachable';
  }
  state.checkedAt = new Date().toISOString();
  return status();
}

async function status() {
  const b = await build();
  let log = '';
  let logAt = null;
  try {
    log = fs.readFileSync(LOG_FILE, 'utf8').slice(-4000);
    logAt = fs.statSync(LOG_FILE).mtime.toISOString();
  } catch { /* no update has run yet */ }
  const current = version();
  const ch = channel();
  // On stable, never offer an older release than the version that runs now (after switching
  // back from test, the next stable release that is at least as new is the update).
  const newer = ch !== 'stable' || compareVersions(state.latestVersion, current) >= 0;
  return {
    version: current,
    build: b,
    channel: ch,
    channels: CHANNELS,
    branch: REF,
    latest: state.latest,
    latestVersion: state.latestVersion,
    available: !!(b.commit && state.latest && b.commit !== state.latest && newer),
    checkedAt: state.checkedAt,
    error: state.error,
    // The panel can only start updates on an installed machine (git checkout + systemd units).
    canUpdate: !!b.commit && fs.existsSync(PATH_UNIT),
    requested: fs.existsSync(REQUEST_FILE),
    log,
    logAt,
    // update.sh ends every run with a ✔ or ✖ line.
    logFinished: /^[✔✖]/.test(log.trim().split('\n').pop() || ''),
  };
}

function requestUpdate({ force = false } = {}) {
  if (!fs.existsSync(PATH_UNIT)) return false;
  fs.writeFileSync(REQUEST_FILE, force ? 'force\n' : 'update\n');
  return true;
}

function start() {
  if (!fs.existsSync(path.join(APP_DIR, '.git'))) return;
  setTimeout(check, 60 * 1000).unref();
  setInterval(check, DAY).unref();
}

module.exports = { check, status, requestUpdate, start, channel, setChannel, compareVersions, latestStable, CHANNELS, REQUEST_FILE, LOG_FILE, CHANNEL_FILE };
