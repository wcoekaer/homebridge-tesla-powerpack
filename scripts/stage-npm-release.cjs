// Stage the exact GitHub release asset. No stored npm token or dependency install is needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PACKAGE_NAME = '@wcoekaer/homebridge-tesla-powerpack';
const REGISTRY = 'https://registry.npmjs.org/';

function verifyRelease(tag, directory) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'A stable release tag is required');
  const version = tag.slice(1);
  const release = JSON.parse(fs.readFileSync(path.join(directory, 'release.json'), 'utf8'));
  assert.equal(release.tagName, tag, 'GitHub release tag mismatch');
  assert.equal(release.isDraft, false, 'Release must be published');
  assert.equal(release.isPrerelease, false, 'Prereleases must not become npm latest');
  const filename = `wcoekaer-homebridge-tesla-powerpack-${version}.tgz`;
  const archive = path.resolve(directory, filename);
  const bytes = fs.readFileSync(archive);
  const checksum = fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\s+/);
  assert.equal(checksum.length, 2, 'Expected exactly one release checksum');
  assert.equal(checksum[1], filename, 'Checksum filename mismatch');
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), checksum[0], 'Release checksum mismatch');
  // Read one member without extracting or running anything from the archive.
  const pkg = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8', maxBuffer: 256 * 1024 }));
  assert.equal(pkg.name, PACKAGE_NAME, 'Unexpected npm package name');
  assert.equal(pkg.version, version, 'Package version must match the release tag');
  assert.equal(pkg.repository?.url, 'git+https://github.com/wcoekaer/homebridge-tesla-powerpack.git', 'Unexpected package repository');
  assert.equal(pkg.publishConfig?.access, 'public', 'Package must be public');
  assert.equal(pkg.publishConfig?.registry, REGISTRY, 'Unexpected package registry');
  return { name: pkg.name, version, archive, integrity: `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}` };
}

async function alreadyPublished(pkg, fetcher = fetch) {
  const response = await fetcher(`${REGISTRY}${PACKAGE_NAME}/${pkg.version}`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`Cannot check npm publication status: HTTP ${response.status}`);
  const published = await response.json();
  assert.equal(published.name, pkg.name);
  assert.equal(published.version, pkg.version);
  assert.equal(published.dist?.integrity, pkg.integrity, 'This npm version already exists with different contents; bump the version');
  return true;
}

function summary(message) {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}

async function main() {
  const [tag, directory] = process.argv.slice(2);
  const pkg = verifyRelease(tag, directory || 'artifacts');
  if (await alreadyPublished(pkg)) {
    summary(`${pkg.name}@${pkg.version} is already published with the same contents; no upload needed.`);
    return;
  }
  const result = JSON.parse(execFileSync('npm', [
    'stage', 'publish', pkg.archive, '--access=public', '--tag=latest',
    '--ignore-scripts', '--json', `--registry=${REGISTRY}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 2 * 1024 * 1024 }));
  const stageId = result[pkg.name]?.stageId;
  assert.match(stageId || '', /^[\da-f-]{36}$/i, 'npm did not return a stage ID');
  summary(`Staged **${pkg.name}@${pkg.version}** for maintainer approval.\n\nStage ID: \`${stageId}\`. Approve it in npm Staged Packages with 2FA after validation completes.`);
}

module.exports = { verifyRelease, alreadyPublished };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
