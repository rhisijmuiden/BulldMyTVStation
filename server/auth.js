'use strict';
// User accounts (scrypt password hashes) with HTTP-only session cookies.
// On first start an "admin" user is created with a one-time password that must be changed at
// first login. The password is printed to the log and stored in DATA_DIR/initial-admin-password
// until it is changed, so the installers can show it.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const COOKIE = 'tvs_session';
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIN_LENGTH = 10;
const INITIAL_PASSWORD_FILE = path.join(store.DATA_DIR, 'initial-admin-password');

const sessions = new Map(); // token -> { userId, expiresAt }

function hash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${key}`;
}

function check(password, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(':');
  const test = crypto.scryptSync(String(password), salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(key, 'hex'));
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]).join('');
}

// Creates the first admin account when there are no users yet.
function bootstrap() {
  if (store.list('users').length) return null;
  const password = process.env.TVS_INITIAL_PASSWORD || randomPassword();
  store.create('users', { username: 'admin', role: 'admin', passwordHash: hash(password), mustChangePassword: true, language: '' });
  fs.writeFileSync(INITIAL_PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  console.log(`Created user "admin" with one-time password: ${password}`);
  console.log(`(also stored in ${INITIAL_PASSWORD_FILE} until it is changed)`);
  return password;
}

// Gives the admin a new one-time password (used by `tvstation admin-reset`).
function resetAdmin(username = 'admin') {
  const password = randomPassword();
  const user = findByName(username);
  if (user) store.update('users', user.id, { passwordHash: hash(password), mustChangePassword: true });
  else store.create('users', { username, role: 'admin', passwordHash: hash(password), mustChangePassword: true, language: '' });
  fs.writeFileSync(INITIAL_PASSWORD_FILE, `${password}\n`, { mode: 0o600 });
  return password;
}

function publicUser(u) {
  return u && { id: u.id, username: u.username, role: u.role, mustChangePassword: !!u.mustChangePassword, language: u.language || '' };
}

function findByName(username) {
  const name = String(username || '').trim().toLowerCase();
  return store.list('users').find((u) => u.username.toLowerCase() === name) || null;
}

function verify(username, password) {
  const user = findByName(username);
  if (!user) { hash(password); return null; } // keep timing similar
  return check(password, user.passwordHash) ? user : null;
}

// A translation key when the new password is not acceptable, else null.
function passwordError(user, current, next) {
  if (!check(current, user.passwordHash)) return 'errors.currentPasswordWrong';
  if (String(next || '').length < MIN_LENGTH) return 'errors.passwordTooShort';
  if (next === current) return 'errors.passwordSame';
  return null;
}

function setPassword(userId, password) {
  store.update('users', userId, { passwordHash: hash(password), mustChangePassword: false, passwordChangedAt: new Date().toISOString() });
  if (!store.list('users').some((u) => u.mustChangePassword)) fs.rm(INITIAL_PASSWORD_FILE, { force: true }, () => {});
}

// ---------- sessions ----------
function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function login(res, user, secure) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
  store.update('users', user.id, { lastLoginAt: new Date().toISOString() });
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
}

function logout(req, res) {
  sessions.delete(parseCookies(req)[COOKIE]);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

// Ends every other session of a user, e.g. after a password change.
function endOtherSessions(req, userId) {
  const own = parseCookies(req)[COOKIE];
  for (const [token, s] of sessions) if (s.userId === userId && token !== own) sessions.delete(token);
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE];
  const s = token && sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) { sessions.delete(token); return null; }
  return store.get('users', s.userId);
}

// Logged in, and the one-time password has been changed.
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'errors.notLoggedIn' });
  if (user.mustChangePassword) return res.status(403).json({ error: 'errors.mustChangePassword' });
  req.user = user;
  next();
}

module.exports = {
  INITIAL_PASSWORD_FILE, MIN_LENGTH, bootstrap, resetAdmin, publicUser, verify, passwordError, setPassword,
  login, logout, endOtherSessions, currentUser, requireAuth, hash, check,
};
