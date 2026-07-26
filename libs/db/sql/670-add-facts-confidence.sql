-- 670-add-facts-confidence.sql — EI-18681964809855890 (owner-filed
-- 2026-07-26): facts:assert has no confidence/provenance-strength field, so a
-- peer's single unreplicated run folds into every future orient at IDENTICAL
-- binding authority to a verified, replicated measurement.
--
-- WHY: the incident that prompted this — su-29a4071e ran one unreplicated A/B
-- on a timing-sensitive test and reported it, correctly hedged, as a possible
-- regression; within minutes another agent wrote it into a harness-scoped fact
-- as "TRUE REDS — code BROKEN AT THE TIP (A/B verified)". The hedges did not
-- survive the trip into the fact. Four agents then reasoned from a claim that
-- turned out to be false (the eventual authoritative result was 10/10 green).
-- facts:assert is an AUTHORITY AMPLIFIER by design (it exists to deliver a
-- conclusion deterministically, stripped of surrounding conversation) — this
-- column lets it also carry the evidence-strength dimension it currently
-- drops on the floor.
--
-- FIX: a nullable `confidence` column — 'verified' | 'provisional' |
-- 'suspected'. NULL (the legacy/default shape) renders exactly as before
-- (no badge) — fully backward compatible. Application-layer defaults (store.ts
-- defaultTtlSecForConfidence) scale the TTL down for provisional/suspected
-- facts so stale CERTAINTY doesn't outlive stale DOUBT.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS + DROP/ADD CONSTRAINT IF EXISTS guard).
-- Applied via the runner (db:migrate / A1 boot-apply).

ALTER TABLE harness_shared.agent_facts
  ADD COLUMN IF NOT EXISTS confidence text;

ALTER TABLE harness_shared.agent_facts
  DROP CONSTRAINT IF EXISTS agent_facts_confidence_check;

ALTER TABLE harness_shared.agent_facts
  ADD CONSTRAINT agent_facts_confidence_check
  CHECK (confidence IS NULL OR confidence IN ('verified', 'provisional', 'suspected'));

COMMENT ON COLUMN harness_shared.agent_facts.confidence IS
  'EI-18681964809855890: evidence-strength of the fact — verified | provisional | suspected | NULL (unset, legacy default, renders unbadged). Set via facts:assert { confidence }.';
