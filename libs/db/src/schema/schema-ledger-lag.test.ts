import { describe, expect, it } from 'vitest';
import {
  ALLOW_LAGGING_LEDGER_ENV,
  APPLIED_MIGRATIONS_SQL,
  describeLaggingLedger,
  findUnappliedMigrations,
  parseAppliedMigrations,
} from './schema-ledger-lag.mjs';

// WI-6554700010008404: pull-schema must refuse a reachable database that lags
// the armed migrations (the desktop's embedded PG), naming what it lacks.

describe('parseAppliedMigrations', () => {
  it('reads one filename per psql -tA line', () => {
    const applied = parseAppliedMigrations('1445-a.sql\n1446-plan-contract-triage.sql\n\n');
    expect(applied).toEqual(new Set(['1445-a.sql', '1446-plan-contract-triage.sql']));
  });

  it('returns null for empty output, so a failed read is never read as "nothing applied"', () => {
    expect(parseAppliedMigrations('')).toBeNull();
    expect(parseAppliedMigrations(undefined)).toBeNull();
    expect(parseAppliedMigrations('\n  \n')).toBeNull();
  });

  it('queries the ledger the migration runner writes', () => {
    expect(APPLIED_MIGRATIONS_SQL).toMatch(/FROM harness_shared\.schema_migrations/);
  });
});

describe('findUnappliedMigrations', () => {
  const dir = [
    '1445-a.sql',
    '1446-plan-contract-triage.sql',
    '1451-tutorial-voice-reservations.sql.DRAFT',
    '040-plugin-configs-backfill.sql',
    '900-per-harness-template.sql',
    'README.md',
  ];

  it('names an armed migration the database has not applied', () => {
    expect(findUnappliedMigrations(dir, new Set(['1445-a.sql']))).toEqual([
      '1446-plan-contract-triage.sql',
    ]);
  });

  it('is empty when every armed migration is applied', () => {
    expect(
      findUnappliedMigrations(dir, new Set(['1445-a.sql', '1446-plan-contract-triage.sql'])),
    ).toEqual([]);
  });

  it("uses the runner's armed definition: no .DRAFT, no manual-only, no per-harness template", () => {
    const unapplied = findUnappliedMigrations(dir, new Set());
    expect(unapplied).toEqual(['1445-a.sql', '1446-plan-contract-triage.sql']);
  });

  it('control: a checker that ignores the applied set reports lag on a current database', () => {
    // A deliberately wrong implementation, kept as a control: comparing only the
    // directory listing cannot tell a current DB from a lagging one. The real
    // helper must disagree with it on the current-DB case above.
    const ignoresLedger = (files: string[]) => files.filter((f) => f.endsWith('.sql'));
    const applied = new Set(['1445-a.sql', '1446-plan-contract-triage.sql']);
    expect(ignoresLedger(dir).length).toBeGreaterThan(0);
    expect(findUnappliedMigrations(dir, applied)).toEqual([]);
  });
});

describe('describeLaggingLedger', () => {
  it('names the source, the redacted URL, each missing file and the override', () => {
    const message = describeLaggingLedger({
      unapplied: ['1446-plan-contract-triage.sql'],
      source: 'discovery-file',
      redactedUrl: 'postgresql://harness_admin:****@localhost:24680/papercusp',
    });
    expect(message).toContain('1 armed migration(s)');
    expect(message).toContain('source: discovery-file');
    expect(message).toContain('localhost:24680');
    expect(message).toContain('1446-plan-contract-triage.sql');
    expect(message).toContain('HARNESS_ADMIN_DATABASE_URL');
    expect(message).toContain(`${ALLOW_LAGGING_LEDGER_ENV}=1`);
  });

  it('bounds a long list and says how many it left out', () => {
    const unapplied = Array.from({ length: 33 }, (_, i) => `${1400 + i}-m.sql`);
    const message = describeLaggingLedger({
      unapplied,
      source: 'discovery-file',
      redactedUrl: 'postgresql://x@localhost:24680/papercusp',
    });
    expect(message).toContain('33 armed migration(s)');
    expect(message).toContain('1409-m.sql');
    expect(message).not.toContain('1410-m.sql');
    expect(message).toContain('… and 23 more');
  });
});
