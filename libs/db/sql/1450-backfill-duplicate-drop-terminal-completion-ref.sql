-- 1450: backfill terminal_completion_ref for duplicate-merge drops (WI-6554700010008454).
--
-- The admission promoter's duplicate-merge write (work-items-admission-promoter.ts) recorded
-- its disposition, 'duplicate of <canonical> (<actor> <runId>)', ONLY in terminal_reason.
-- terminal_completion_ref is the canonical drop-disposition column: work_items:complete writes
-- it, and it is the only one the WorkItem projection exposes. The burn-down cohort audit
-- therefore saw these drops as having no disposition. The writer now sets both columns; this
-- migration copies the existing text across so history reads the same as new rows.
--
-- Measured 2026-10-11 ~06:16Z: 303 dropped rows (admission-promoter 276, system:operator 21,
-- admission-bulk-dedup 6) with an empty terminal_completion_ref and a 'duplicate of'
-- terminal_reason.
--
-- Additive and idempotent: only empty refs are filled, terminal_reason is left in place
-- (ideation-backlog-adjudication reads it), and a re-run matches zero rows. No DDL.

UPDATE harness_shared.work_items
   SET terminal_completion_ref = terminal_reason
 WHERE status = 'dropped'
   AND (terminal_completion_ref IS NULL OR btrim(terminal_completion_ref) = '')
   AND terminal_reason LIKE 'duplicate of %';
