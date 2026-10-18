'use strict';
// Release channels: which release is the newest stable one, and how versions compare.
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'tvstation-updater-'));
const { compareVersions, latestStable } = require('../server/updater');

test('versions compare by number, with pre-releases before their release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.1') > 0);
  assert.ok(compareVersions('v1.2.3', '1.2.3') === 0);
  assert.ok(compareVersions('1.2.3-rc.1', '1.2.3') < 0);
  assert.ok(compareVersions('1.2.3', '1.3.0') < 0);
});

test('the newest stable release skips pre-releases and peels annotated tags', () => {
  const a = 'a'.repeat(40); const b = 'b'.repeat(40); const c = 'c'.repeat(40); const d = 'd'.repeat(40);
  const out = [
    `${a}\trefs/tags/v0.9.0`,
    `${b}\trefs/tags/v0.10.0`,
    `${c}\trefs/tags/v0.10.0^{}`,
    `${d}\trefs/tags/v0.11.0-rc.1`,
  ].join('\n');
  assert.deepStrictEqual(latestStable(out), { tag: 'v0.10.0', version: '0.10.0', commit: c });
  assert.strictEqual(latestStable(`${d}\trefs/tags/v1.0.0-beta`), null);
  assert.strictEqual(latestStable(''), null);
});
