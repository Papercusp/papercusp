-- 056-adaptive-telemetry-synthesis.sql
--
-- Add synthesizer outcome columns to harness_shared.adaptive_telemetry.
-- Populated after the synthesizer step (post-worker, pre-validator)
-- finishes for a tier-dispatched feature. NULL on rows from before
-- this migration (the orchestrator updates on next run).
--
-- - `synthesized` true when synth produced a commit, false when it
--   was attempted but failed (timed out, exited nonzero, produced
--   no edits). NULL when no synth attempt was made (worker count
--   resolved to 1 with synthesizeSingle off, or no manifest).
-- - `synthesis_error` populated only when `synthesized=false`;
--   short human-readable reason. NULL otherwise.

ALTER TABLE "harness_shared"."adaptive_telemetry"
  ADD COLUMN IF NOT EXISTS "synthesized" boolean,
  ADD COLUMN IF NOT EXISTS "synthesis_error" text;
