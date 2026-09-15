import { defineVitestConfig } from '@papercusp/test-config/vitest-config';

// Integration layer: picks up guidance.integration.test.ts, which the unit
// config (vitest.config.ts) excludes by construction — the unit layer's
// exclude list carries `**/*.integration.test.*`. Without this config the file
// was visible through a registry glob but executed by nothing, which is what
// `npm run lint:tests -w @papercusp/web` reports as [UNRUNNABLE].
//
// No setupFiles and no globalSetup: this suite is entirely in-memory. It reads
// the shipped index.cjs artifact and drives it with a fake child process, so it
// provisions no container and opens no database.
export default defineVitestConfig({ layer: 'integration' });
