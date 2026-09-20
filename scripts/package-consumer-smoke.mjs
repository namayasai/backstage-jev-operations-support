import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file is copied into the temporary consumer before running: imports must
// resolve against the installed archives rather than source aliases or the repo.
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const installedRoot = realpathSync(join(here, 'node_modules'));
const packages = JSON.parse(readFileSync(join(here, 'expected-packages.json'), 'utf8'));
const expectedVersions = new Map(packages.map(pkg => [pkg.name, pkg.version]));
function inside(parent, child) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\');
}
function targets(value) {
  if (typeof value === 'string') return [value];
  return Object.values(value ?? {}).flatMap(targets);
}
for (const pkg of packages) {
  const file = realpathSync(require.resolve(`${pkg.name}/package.json`));
  assert(inside(installedRoot, file), `${pkg.name}: resolved outside the isolated consumer`);
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const directory = dirname(file);
  assert.equal(manifest.version, pkg.version, `${pkg.name}: installed version differs from the archive`);
  for (const section of ['dependencies', 'optionalDependencies']) for (const [name, version] of Object.entries(manifest[section] ?? {})) {
    if (expectedVersions.has(name)) assert.equal(version, expectedVersions.get(name), `${pkg.name}: inconsistent internal dependency ${name}`);
  }
  for (const target of targets(manifest.exports)) {
    assert(target.startsWith('./'), `${pkg.name}: unexpected export target`);
    const path = join(directory, target);
    assert(existsSync(path) && inside(directory, realpathSync(path)), `${pkg.name}: missing or invalid exported file ${target}`);
  }
  for (const entry of Object.keys(manifest.exports)) require.resolve(pkg.name + (entry === '.' ? '' : entry.slice(1)));
  if (manifest.backstage.role !== 'frontend-plugin') { require(pkg.name); await import(pkg.name); }
  console.log(`${pkg.name}@${pkg.version}: installed archive, exports and imports passed`);
}
const base = '@namayasai/backstage-plugin-jev-operations-support';
const common = require(`${base}-common`);
const result = common.demoEvaluation({ workflow: 'incident', text: 'Synthetic incident report for package verification', candidates: [] });
assert.equal(result.workflow, 'incident');
assert.equal(result.mode, 'demo');
assert.equal(result.findings.length, 2);
assert.equal(typeof require(`${base}-backend/client`).createJevClient, 'function');
const planner = require(`${base}-backend/response-plan`).responsePlannerFromConfig({ getOptionalBoolean: () => true, getOptionalString: () => undefined, getOptionalNumber: () => undefined });
const response = await planner.generate('Synthetic report', result);
assert.equal(response.status, 'generated');
assert.equal(response.mode, 'demo');
const migrations = realpathSync(require(`${base}-aws-notifications`).awsAlertDetailsMigrationsDirectory());
assert(inside(installedRoot, migrations), 'Migration directory resolved outside installed packages');
const files = readdirSync(migrations).filter(file => file.endsWith('.js'));
assert(files.length > 0, 'Packaged AWS migrations are missing');
for (const file of files) {
  const migration = require(join(migrations, file));
  assert.equal(typeof migration.up, 'function');
  assert.equal(typeof migration.down, 'function');
}
console.log('Demo evaluation, response planning and packaged migrations passed; no live provider credentials required.');
