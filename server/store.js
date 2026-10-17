'use strict';
// A small JSON file store in DATA_DIR. Collections are arrays of records with an id;
// sections are single objects (settings, station). Every change is written to disk at once,
// through a temporary file so a crash never leaves half a file behind.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'data.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

let data = { collections: {}, sections: {} };
try {
  data = { collections: {}, sections: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

function save() {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

const coll = (name) => (data.collections[name] ||= []);

function list(name) {
  return coll(name).map((r) => ({ ...r }));
}

function get(name, id) {
  const r = coll(name).find((x) => x.id === id);
  return r ? { ...r } : null;
}

function create(name, fields) {
  const now = new Date().toISOString();
  const record = { id: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now };
  coll(name).push(record);
  save();
  return { ...record };
}

function update(name, id, fields) {
  const r = coll(name).find((x) => x.id === id);
  if (!r) return null;
  Object.assign(r, fields, { id, updatedAt: new Date().toISOString() });
  save();
  return { ...r };
}

function remove(name, id) {
  const before = coll(name).length;
  data.collections[name] = coll(name).filter((x) => x.id !== id);
  if (data.collections[name].length !== before) save();
  return data.collections[name].length !== before;
}

function getSection(name) {
  return { ...(data.sections[name] || {}) };
}

function setSection(name, fields) {
  data.sections[name] = { ...(data.sections[name] || {}), ...fields };
  save();
  return getSection(name);
}

module.exports = { DATA_DIR, list, get, create, update, remove, getSection, setSection };
