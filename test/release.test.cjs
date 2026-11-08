const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyRelease, alreadyPublished } = require('../scripts/stage-npm-release.cjs');

test('release verification refuses corrupt archives, wrong versions, and unpublished releases', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'powerpack-release-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = { ...require('../package.json'), version: '9.8.7' };
  fs.mkdirSync(path.join(dir, 'package'));
  fs.writeFileSync(path.join(dir, 'package/package.json'), JSON.stringify(pkg));
  const filename = 'wcoekaer-homebridge-tesla-powerpack-9.8.7.tgz';
  const archive = path.join(dir, filename);
  execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), `${checksum}  ${filename}\n`);
  const release = { tagName: 'v9.8.7', isDraft: false, isPrerelease: false };
  const metadata = path.join(dir, 'release.json');
  fs.writeFileSync(metadata, JSON.stringify(release));
  assert.equal(verifyRelease('v9.8.7', dir).version, '9.8.7');
  assert.throws(() => verifyRelease('v9.8.8', dir), /tag mismatch/);
  fs.writeFileSync(metadata, JSON.stringify({ ...release, isDraft: true }));
  assert.throws(() => verifyRelease('v9.8.7', dir), /must be published/);
  fs.writeFileSync(metadata, JSON.stringify({ ...release, isPrerelease: true }));
  assert.throws(() => verifyRelease('v9.8.7', dir), /Prereleases/);
  fs.writeFileSync(metadata, JSON.stringify(release));
  fs.appendFileSync(archive, 'corrupted');
  assert.throws(() => verifyRelease('v9.8.7', dir), /checksum mismatch/);
});

test('publication retries skip identical versions but reject collisions and registry failures', async () => {
  const pkg = { name: '@wcoekaer/homebridge-tesla-powerpack', version: '9.8.7', integrity: 'sha512-fixture' };
  const response = (status, data) => async () => ({ status, ok: status === 200, json: async () => data });
  assert.equal(await alreadyPublished(pkg, response(404)), false);
  assert.equal(await alreadyPublished(pkg, response(200, { ...pkg, dist: { integrity: pkg.integrity } })), true);
  await assert.rejects(alreadyPublished(pkg, response(200, { ...pkg, dist: { integrity: 'different' } })), /different contents/);
  await assert.rejects(alreadyPublished(pkg, response(503)), /HTTP 503/);
});
