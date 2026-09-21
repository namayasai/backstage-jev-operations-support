import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run after the package builds. Pack all workspaces together so unpublished versions
// are resolved from these archives, never from a published version or workspace link.
const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check with npm run test:packages');
const manifests = readdirSync(join(root, 'plugins'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => JSON.parse(readFileSync(join(root, 'plugins', entry.name, 'package.json'), 'utf8')));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
assert.equal(manifests.length, 5, 'All five plugin workspaces must be checked');
for (const manifest of manifests) {
  assert.equal(manifest.version, version, `${manifest.name}: workspace version mismatch`);
  assert(existsSync(resolve(root, 'plugins', manifest.name.replace('@namayasai/backstage-plugin-', ''), manifest.main)), `${manifest.name}: build the packages first`);
}

const temporary = mkdtempSync(join(tmpdir(), 'jev-package-check-'));
const archives = join(temporary, 'tarballs');
const consumer = join(temporary, 'consumer');
mkdirSync(archives);
mkdirSync(consumer);
// A consumer outside the repository cannot accidentally resolve missing imports
// from this repository's node_modules. Remove the other Node lookup escape hatch too.
const consumerEnv = { ...process.env };
delete consumerEnv.NODE_PATH;
delete consumerEnv.NODE_OPTIONS;
for (const key of Object.keys(consumerEnv)) {
  if (key.toLowerCase().startsWith('npm_config_')) delete consumerEnv[key];
}
const userConfig = join(temporary, 'user.npmrc');
const globalConfig = join(temporary, 'global.npmrc');
writeFileSync(userConfig, '');
writeFileSync(globalConfig, '');

try {
  const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--workspaces', '--json', '--pack-destination', archives], { cwd: root, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }));
  assert.equal(packed.length, manifests.length);
  assert.deepEqual(packed.map(pkg => pkg.name).sort(), manifests.map(pkg => pkg.name).sort());
  for (const pkg of packed) {
    assert.equal(pkg.version, version);
    assert.equal(pkg.filename, basename(pkg.filename));
    const actual = 'sha512-' + createHash('sha512').update(readFileSync(join(archives, pkg.filename))).digest('base64');
    assert.equal(actual, pkg.integrity, `${pkg.name}: archive integrity mismatch`);
    const names = new Set(pkg.files.map(file => file.path));
    for (const required of ['package.json', 'README.md', 'LICENSE']) assert(names.has(required), `${pkg.name}: missing ${required}`);
    for (const name of names) assert(/^(package\.json|README\.md|LICENSE|config\.d\.ts|dist\/.+|migrations\/.+)$/.test(name), `${pkg.name}: unexpected published file ${name}`);
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'jev-package-consumer', private: true, version: '1.0.0', dependencies: Object.fromEntries(packed.map(pkg => [pkg.name, `file:../tarballs/${pkg.filename}`])) }, null, 2));
  writeFileSync(join(consumer, 'expected-packages.json'), JSON.stringify(manifests.map(({ name, version }) => ({ name, version }))));
  copyFileSync(join(root, 'scripts/package-consumer-smoke.mjs'), join(consumer, 'smoke.mjs'));
  execFileSync(process.execPath, [npmCli, 'install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`, '--registry=https://registry.npmjs.org'], { cwd: consumer, env: consumerEnv, stdio: 'inherit', timeout: 5 * 60 * 1000 });
  execFileSync(process.execPath, ['smoke.mjs'], { cwd: consumer, env: consumerEnv, stdio: 'inherit', timeout: 60_000 });
  console.log(`Verified all ${packed.length} package archives at ${version} in an isolated consumer.`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
