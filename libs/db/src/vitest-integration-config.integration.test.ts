import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('DB integration Vitest config', () => {
  it('resolves setup files from the config directory instead of invocation cwd', async () => {
    const expectedSetup = fileURLToPath(new URL('../vitest.integration.setup.ts', import.meta.url));
    const { default: config } = await import('../vitest.integration.config.ts');
    const setupFiles = (config.test?.setupFiles ?? []) as string[];
    const integrationSetup = setupFiles.find((setupFile) => setupFile.endsWith('vitest.integration.setup.ts'));

    expect(integrationSetup).toBe(expectedSetup);
    expect(isAbsolute(integrationSetup ?? '')).toBe(true);
    expect(existsSync(integrationSetup ?? '')).toBe(true);
  });
});
