import { defineVitestConfig } from '@papercusp/test-config';

// Integration layer: picks up *.integration.test.ts (the unit config excludes
// them). These tests provision their own fresh testcontainer database — no
// shared baseline schema needed — so no globalSetup is wired here.
export default defineVitestConfig({ layer: 'integration' });
