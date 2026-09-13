import { describe, expect, it } from 'vitest';
import {
  createSchemaCliSpawnOptions,
  normalizeSchemaCliOutput,
} from './schema-cli-output.mjs';

const redraw = '\u001b[2K\u001b[1G';

describe('createSchemaCliSpawnOptions', () => {
  it('inherits the terminal for interactive runs', () => {
    expect(
      createSchemaCliSpawnOptions({
        cwd: '/tmp/db',
        env: { PATH: '/bin' },
        interactive: true,
      }),
    ).toEqual({
      cwd: '/tmp/db',
      stdio: 'inherit',
      env: { PATH: '/bin' },
    });
  });

  it('pipes non-interactive stdout while leaving stdin and stderr inherited', () => {
    expect(
      createSchemaCliSpawnOptions({
        cwd: '/tmp/db',
        env: { PATH: '/bin' },
        interactive: false,
      }),
    ).toEqual({
      cwd: '/tmp/db',
      stdio: ['inherit', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { PATH: '/bin' },
    });
  });
});

describe('normalizeSchemaCliOutput', () => {
  it('strips ANSI/cursor controls and collapses spinner-only redraws', () => {
    const output =
      '\u001b[?25l' +
      '[\u28f7] 0 tables fetching\n' +
      '[\u28f7] 0 columns fetching\n' +
      redraw +
      '[\u28ef] 0 tables fetching\n' +
      '[\u28ef] 0 columns fetching\n' +
      redraw +
      '[\u2713] 12 tables fetched\n' +
      '[\u2713] 34 columns fetched\n' +
      '\u001b[?25h';

    expect(normalizeSchemaCliOutput(output)).toBe(
      '[ ] 0 tables fetching\n' +
        '[ ] 0 columns fetching\n' +
        '[✓] 12 tables fetched\n' +
        '[✓] 34 columns fetched\n',
    );
  });

  it('keeps distinct progress frames when counts or statuses change', () => {
    const output =
      '[\u28f7] 0 tables fetching\n' +
      redraw +
      '[\u28ef] 7 tables fetching\n' +
      redraw +
      '[\u28df] 7 tables fetched\n';

    expect(normalizeSchemaCliOutput(output)).toBe(
      '[ ] 0 tables fetching\n[ ] 7 tables fetching\n[ ] 7 tables fetched\n',
    );
  });

  it('handles bare carriage-return redraws and Buffer captures', () => {
    const output = Buffer.from('[\u28f7] fetching\r[\u28ef] fetching\r[\u2713] fetched');

    expect(normalizeSchemaCliOutput(output)).toBe('[ ] fetching\n[✓] fetched');
  });

  it('preserves ordinary output and is idempotent', () => {
    const output = '==> applying quirk fixups\n\u001b[32m✓ done\u001b[0m\n';
    const normalized = normalizeSchemaCliOutput(output);

    expect(normalized).toBe('==> applying quirk fixups\n✓ done\n');
    expect(normalizeSchemaCliOutput(normalized)).toBe(normalized);
  });
});
