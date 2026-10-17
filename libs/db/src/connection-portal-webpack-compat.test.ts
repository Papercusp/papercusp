/**
 * Regression guard for WI-6554700010016612.
 *
 * The hosted Portal's Next development instrumentation emits a non-ESM webpack
 * chunk. Any `import.meta` expression or static `createRequire` binding in the
 * shared DB runtime reaches that chunk and throws or gets rewritten before the
 * Portal can serve a request. Keep the Node-only builtin seam runtime-resolved
 * so the browser-safe import remains parseable by that bundler.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONNECTION = readFileSync(join(HERE, 'connection.ts'), 'utf8');
const OPERATOR_ENV = readFileSync(join(HERE, 'operator-db-env.ts'), 'utf8');
const withoutComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

describe('shared DB runtime hosted Portal webpack compatibility (WI-6554700010016612)', () => {
  it('contains no import.meta expression in the runtime modules that Portal bundles', () => {
    expect(withoutComments(CONNECTION)).not.toMatch(/\bimport\.meta\b/);
    expect(withoutComments(OPERATOR_ENV)).not.toMatch(/\bimport\.meta\b/);
  });

  it('resolves Node builtins through the runtime process API', () => {
    for (const source of [CONNECTION, OPERATOR_ENV]) {
      const sourceWithoutComments = withoutComments(source);
      expect(sourceWithoutComments).toMatch(/process\.getBuiltinModule/);
      expect(sourceWithoutComments).not.toMatch(/createRequire/);
      expect(sourceWithoutComments).not.toMatch(/from ['\"]node:module['\"]/);
    }
  });
});
