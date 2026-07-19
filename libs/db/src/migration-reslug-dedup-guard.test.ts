/**
 * migration-reslug-dedup-guard.test.ts
 *
 * REGRESSION GUARD (fast, no DB) for the mac 0.0.12 crash-loop (2026-07-19).
 *
 * Migration 631-reslug-operator-workspace-changetask-to-papercusp.sql re-slugged
 * work-items from `operator:papercusp-workspace` to `papercusp` with a STRAIGHT
 * `UPDATE ... SET harness_slug='papercusp'` that ASSUMED zero (harness_slug,
 * feature_id) primary-key collisions. That held on the dev DB it was authored
 * against but NOT on the shipped embedded-pg SEED, where a `papercusp` row already
 * existed for a moved feature_id — so the packaged operator hit `duplicate key
 * value violates unique constraint "work_items_pkey"` and CRASH-LOOPED on first
 * boot. It was found only AFTER a ~45-minute build + install (part of why v0.0.12
 * took ~12h). Migration 630 had already learned this lesson (it de-dups first);
 * 631 shipped without the same guard.
 *
 * This lint enforces the rule for EVERY migration: a re-slug UPDATE of
 * work_items.harness_slug must be collision-safe — either it removes the
 * would-collide rows first (a dedup DELETE) or the UPDATE itself is guarded
 * (WHERE ... NOT EXISTS a row already at the target slug). A straight unguarded
 * reslug UPDATE is the 631 bug and fails here in milliseconds, instead of
 * crash-looping a packaged operator after a multi-hour release build
 * (plan release-readiness-preflight-gate-2026-07-19 P-001).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/** Strip line/block comments so we only reason about executable SQL. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** A reslug UPDATE = one that assigns a NEW literal to work_items.harness_slug. */
const RESLUG_UPDATE_RE =
  /UPDATE\s+[\w".]*\bwork_items\b[\s\S]*?SET\s+[\s\S]*?\bharness_slug\s*=\s*'[^']+'[\s\S]*?;/gi;

/** Collision-safe if the migration EITHER de-dups colliders first (a DELETE on
 *  work_items) OR guards the reslug UPDATE with a NOT EXISTS at the target slug. */
function isCollisionSafe(migrationSql: string, updateStmt: string): boolean {
  const hasDedupDelete = /DELETE\s+FROM\s+[\w".]*\bwork_items\b/i.test(migrationSql);
  const guardedUpdate = /NOT\s+EXISTS/i.test(updateStmt);
  return hasDedupDelete || guardedUpdate;
}

describe('migrations: a work_items harness_slug reslug UPDATE must be collision-safe (mac 0.0.12 crash-loop class)', () => {
  const files = readdirSync(SQL_DIR)
    .filter((f) => /\.sql$/i.test(f))
    .sort();

  it('finds the migration files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    const raw = readFileSync(join(SQL_DIR, file), 'utf8');
    const sql = stripSqlComments(raw);
    const reslugs = sql.match(RESLUG_UPDATE_RE);
    if (!reslugs) continue;

    it(`${file}: each work_items reslug UPDATE de-dups or is NOT EXISTS-guarded`, () => {
      for (const stmt of reslugs) {
        expect(
          isCollisionSafe(sql, stmt),
          `${file} re-slugs work_items.harness_slug with a straight UPDATE and no ` +
            `collision guard — this is the migration-631 bug that crash-looped the ` +
            `packaged operator on the seed (duplicate work_items_pkey). Add a dedup ` +
            `DELETE of the would-collide rows first (mirror migration 630/631), or ` +
            `guard the UPDATE with "AND NOT EXISTS (SELECT 1 ... target slug ...)".`,
        ).toBe(true);
      }
    });
  }

  it('specifically: migration 631 (the one that crashed) is collision-safe', () => {
    const f = files.find((x) => x.startsWith('631-reslug-operator-workspace-changetask'));
    expect(f, 'migration 631 file must exist').toBeTruthy();
    const sql = stripSqlComments(readFileSync(join(SQL_DIR, f as string), 'utf8'));
    const reslugs = sql.match(RESLUG_UPDATE_RE) ?? [];
    expect(reslugs.length, '631 must contain a reslug UPDATE').toBeGreaterThan(0);
    for (const stmt of reslugs) expect(isCollisionSafe(sql, stmt)).toBe(true);
  });
});
