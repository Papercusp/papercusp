import { describe, expect, it } from 'vitest';
import {
  MIGRATION_FINGERPRINT_SQL,
  describeCatalogDrift,
  parseMigrationFingerprint,
} from './schema-catalog-drift.mjs';

// WI-10006614: a migration committing mid-pull must be reported as catalog
// drift ("re-run"), not as a projector defect.
const BEFORE = {
  count: 1375,
  latestFilename: '1374-plan-revision-backfill.sql',
  latestAppliedAt: '2026-10-06T04:30:00+00:00',
};

describe('parseMigrationFingerprint', () => {
  it('parses psql -tA json_build_object output', () => {
    const fp = parseMigrationFingerprint(
      '{"count" : 1376, "latestFilename" : "1375-hosted-funding.sql", "latestAppliedAt" : "2026-10-06T04:43:18.1+00:00"}\n',
    );
    expect(fp).toEqual({
      count: 1376,
      latestFilename: '1375-hosted-funding.sql',
      latestAppliedAt: '2026-10-06T04:43:18.1+00:00',
    });
  });

  it('keeps an empty ledger as a real fingerprint (count 0, nulls), not as unavailable', () => {
    expect(
      parseMigrationFingerprint('{"count":0,"latestFilename":null,"latestAppliedAt":null}'),
    ).toEqual({ count: 0, latestFilename: null, latestAppliedAt: null });
  });

  it.each([
    ['empty output', ''],
    ['psql error text', 'ERROR:  relation "harness_shared.schema_migrations" does not exist'],
    ['a JSON array', '[1,2]'],
    ['a negative count', '{"count":-1}'],
    ['a non-integer count', '{"count":"many"}'],
    ['null', 'null'],
  ])('returns null (unavailable) for %s', (_label, stdout) => {
    expect(parseMigrationFingerprint(stdout)).toBeNull();
  });
});

describe('describeCatalogDrift', () => {
  it('reports no drift when the ledger is unchanged', () => {
    expect(describeCatalogDrift(BEFORE, { ...BEFORE })).toBeNull();
  });

  it('reproduces the 2026-10-06 incident: 1375 committed mid-run → names it and says re-run', () => {
    const message = describeCatalogDrift(
      BEFORE,
      {
        count: 1376,
        latestFilename: '1375-hosted-funding.sql',
        latestAppliedAt: '2026-10-06T04:43:18+00:00',
      },
      { stage: 'at the pg_policies check' },
    );
    expect(message).toMatch(/^catalog changed during pull \(migration 1375-hosted-funding\.sql applied mid-run/);
    expect(message).toContain('schema_migrations rows 1375 → 1376');
    expect(message).toContain('detected at the pg_policies check');
    expect(message).toContain('NOT a projector defect');
    expect(message).toContain('re-run pull-schema');
  });

  it('catches a commit whose applied_at (tx start) predates the first fingerprint: count alone moves', () => {
    // applied_at is the migration transaction's START time, so a migration that
    // began before the first read but committed after it can leave max(applied_at)
    // and the latest filename unchanged when an older-named file lands.
    const message = describeCatalogDrift(BEFORE, { ...BEFORE, count: BEFORE.count + 1 });
    expect(message).not.toBeNull();
    expect(message).toContain('(a migration applied mid-run');
  });

  it('does not claim drift when either fingerprint is unavailable', () => {
    expect(describeCatalogDrift(null, BEFORE)).toBeNull();
    expect(describeCatalogDrift(BEFORE, null)).toBeNull();
  });
});

describe('MIGRATION_FINGERPRINT_SQL', () => {
  it('reads count, latest filename and max(applied_at) from the applied-migration ledger', () => {
    expect(MIGRATION_FINGERPRINT_SQL).toContain('harness_shared.schema_migrations');
    expect(MIGRATION_FINGERPRINT_SQL).toMatch(/'count', \(SELECT count\(\*\)/);
    expect(MIGRATION_FINGERPRINT_SQL).toContain("'latestFilename'");
    expect(MIGRATION_FINGERPRINT_SQL).toContain('max(applied_at)');
  });
});
