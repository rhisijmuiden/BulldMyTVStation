'use strict';
// Every language has exactly the keys of English, with the same {placeholders}.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'public', 'locales');
const load = (l) => JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'));
const en = load('en');
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');

for (const file of fs.readdirSync(dir).filter((f) => f !== 'en.json')) {
  const lang = path.basename(file, '.json');
  test(`${lang} matches English`, () => {
    const other = load(lang);
    assert.deepStrictEqual(Object.keys(other).sort(), Object.keys(en).sort());
    for (const k of Object.keys(en)) assert.strictEqual(placeholders(other[k]), placeholders(en[k]), k);
  });
}

test('every t() key used in the frontend exists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'auth.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'server', 'components.js'), 'utf8');
  const keys = [...src.matchAll(/['"`]((?:errors|nav|login|password|dashboard|wizard|components|settings|status|language|app|info|role)\.[\w.]+)['"`]/g)].map((m) => m[1]);
  const missing = [...new Set(keys)].filter((k) => !(k in en));
  assert.deepStrictEqual(missing, []);
});
