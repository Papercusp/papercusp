-- 1175 — scope the spec_evidence_bindings dedup index to LIVE proof only.
--
-- WI-10001850. Plan managed-agent-capability-contract-and-native-cutover-2026-09-13,
-- decision D-011. Follow-up to 1174, which added the retraction stamp.
--
-- WHY THIS EXISTS. 1174 gave the table a recorded-retraction path but left
-- spec_evidence_bindings_dedup a TOTAL unique index over
-- (workspace_id, harness_slug, work_item_id, plan_slug, spec_id, spec_revision,
-- binding_fingerprint). A retracted row therefore still occupies its dedup slot, and
-- that silently defeats the repair D-011 mandates:
--
--   1. bindSpecEvidence INSERTs with ON CONFLICT (<those columns>) DO NOTHING RETURNING id.
--   2. When an identical binding already exists the insert returns no row, so the
--      writer falls back to a lookup keyed on binding_fingerprint.
--   3. Because the index is unique over exactly those columns, that lookup matches
--      EXACTLY ONE row — the retracted one — and the call returns status 'unchanged'
--      naming it.
--
-- The caller is told the evidence is bound. Every reader excludes retracted rows by
-- default, so the evaluator sees nothing, and the clause stays failing with no
-- diagnosable cause. Retract-then-rebind-identical-evidence is exactly the flow a
-- repair takes when the retraction was provisional or mistaken, and re-emitting a
-- binding with a stable evidence_ref and test_run_id is ordinary behaviour here.
--
-- The dedup index exists to stop DUPLICATE LIVE PROOF. A retracted row is not live
-- proof, so scoping the index to retracted_at IS NULL restores the intended meaning
-- rather than weakening it: two live identical bindings remain impossible, while a
-- withdrawn one no longer squats on the slot its replacement needs.
--
-- FORWARD-COMPAT: the release checkout serving :3070 has no retraction code at all —
-- it can neither set retracted_at nor read it — so under that release every row has
-- retracted_at IS NULL and the partial index covers exactly the same rows the total
-- index did. Its INSERT ... ON CONFLICT names the index's column list, not its name,
-- so the rename is invisible to it. The deployed release therefore observes no
-- behaviour change whatsoever; the new admission only becomes reachable once a row
-- has actually been retracted, which only the newer build can do.
--
-- Built before the old one is dropped so the table is never momentarily without a
-- uniqueness guarantee. The partial index is a strict subset of the total index's
-- key space, and no row is retracted at the time this runs, so the build cannot
-- fail on a pre-existing duplicate.

CREATE UNIQUE INDEX IF NOT EXISTS spec_evidence_bindings_dedup_live
  ON harness_shared.spec_evidence_bindings (
    workspace_id, harness_slug, work_item_id,
    plan_slug, spec_id, spec_revision, binding_fingerprint
  )
  WHERE retracted_at IS NULL;

COMMENT ON INDEX harness_shared.spec_evidence_bindings_dedup_live IS
  'Dedup guard for LIVE evidence bindings only. Two identical live bindings remain impossible; a retracted binding releases its slot so the corrected replacement can be inserted instead of silently deduping onto the withdrawn row. Replaces the total index spec_evidence_bindings_dedup (migration 1175).';

DROP INDEX IF EXISTS harness_shared.spec_evidence_bindings_dedup;
