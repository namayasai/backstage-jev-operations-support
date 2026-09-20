import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Why this test exists: this package is published dual CJS/ESM via tsup, and its `dist/*.mjs`
// output is consumed directly by real Backstage hosts bundled with webpack/Rspack. Those
// bundlers apply Node-style *strict* ESM->CJS interop to a `.mjs` importer: a default import of
// a CommonJS module resolves to the whole `module.exports` object, not to whatever the CJS
// module assigned to `exports.default`. `@material-ui/icons/*` deep-path modules are exactly
// this shape (CJS with `__esModule: true`), so `import Icon from '@material-ui/icons/Foo'` in
// our source silently became `import { default: Icon }` worth of breakage at runtime — visible
// only in a real bundler, not in Vite's dev server or in our jsdom-based unit tests, which is
// why this needs a dedicated static check instead of relying on component tests to catch it.
//
// The rule: no default import from `@material-ui/icons` (banned outright — use `./icons`
// instead), and no other default import from a bare (non-relative) specifier unless it is
// explicitly allowlisted below with a justification. Named imports from a package root
// (`@material-ui/core`, `@material-ui/lab`, `@backstage/*`, `react`, `react-router-dom`, etc.)
// are unaffected by this interop hazard and are not restricted by this test.

// Intentionally empty: nothing in this plugin's source has been shown to need a default import
// from a bare specifier. Add an entry here only with a comment justifying why that specific
// import is safe under strict ESM->CJS default interop (e.g. the dependency ships real ESM).
const DEFAULT_IMPORT_ALLOWLIST: readonly string[] = [];

const SRC_DIR = join(__dirname);

// import Foo from 'bare-specifier';  OR  import Foo, { bar } from 'bare-specifier';
// (relative specifiers, e.g. './icons', are always fine here: they resolve within our own ESM
// output, not into a third party's CJS build.)
const DEFAULT_IMPORT_RE = /^\s*import\s+[A-Za-z_$][\w$]*\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/gm;
const MATERIAL_UI_ICONS_RE = /^\s*import\s+.*from\s*['"]@material-ui\/icons(\/[^'"]*)?['"]/gm;

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

describe('published dist import hazards (strict ESM->CJS default interop)', () => {
  const files = listSourceFiles(SRC_DIR);

  it('found at least one source file to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports from @material-ui/icons', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      const matches = contents.match(MATERIAL_UI_ICONS_RE);
      if (matches) offenders.push(`${file}: ${matches.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never default-imports from a bare specifier unless allowlisted', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      for (const match of contents.matchAll(DEFAULT_IMPORT_RE)) {
        const specifier = match[1];
        const isRelative = specifier.startsWith('.') || specifier.startsWith('/');
        if (isRelative) continue;
        if (DEFAULT_IMPORT_ALLOWLIST.includes(specifier)) continue;
        offenders.push(`${file}: default import from '${specifier}'`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
