'use strict';
// The version and build of the running panel, a daily check for a newer version and starting
// an update from the panel. The update itself runs as root through the tvstation-update systemd
// units (see deploy/): this process only writes the request file that their path unit watches.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const APP_DIR = path.join(__dirname, '..');
const REF = process.env.TVSTATION_REF || 'main';
const REQUEST_FILE = path.join(store.DATA_DIR, 'update-request');
const LOG_FILE = path.join(store.DATA_DIR, 'update.log');
const PATH_UNIT = process.env.TVSTATION_UPDATE_UNIT || '/etc/systemd/system/tvstation-update.path';
const DAY = 24 * 60 * 60 * 1000;

const state = { latest: null, checkedAt: null, error: null };

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
    const out = await git('ls-remote', 'origin', `refs/heads/${REF}`);
    state.latest = out.split(/\s+/)[0] || null;
    state.error = state.latest ? null : 'errors.updateBranch';
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
  return {
    version: version(),
    build: b,
    branch: REF,
    latest: state.latest,
    available: !!(b.commit && state.latest && b.commit !== state.latest),
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

module.exports = { check, status, requestUpdate, start, REQUEST_FILE, LOG_FILE };
