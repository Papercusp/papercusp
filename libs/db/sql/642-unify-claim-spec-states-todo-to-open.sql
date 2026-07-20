-- 642-unify-claim-spec-states-todo-to-open
--
-- work-item-status-full-unify (2026-07-19) P-004/P-005: `todo` is retired as a claimable
-- status token — `open` is the SINGLE unified claimable token for BOTH work-item families
-- (the feature `todo`→`open` mapping D-001, already applied to the rows by migration 638).
--
-- This pass narrows CLAIM_STATES_ALLOWLIST from ['todo','open','failing'] to ['open','failing'].
-- A stored claim spec is RE-VALIDATED against that allowlist on the READ path
-- (claim-spec-store.getClaimSpec → validateClaimSpec): a spec whose `states` array still
-- lists 'todo' would now fail validation and SILENTLY degrade that bee to DEFAULT_CLAIM_SPEC,
-- dropping its leader-configured lane (view.filter / rank / limits) mid-drain. Rewrite every
-- stored spec's `states` array todo→open (de-duplicating, preserving 'open'/'failing') so it
-- validates unchanged. This ALSO revives the specs currently pinned to states:['todo'] alone,
-- which match zero rows now that the backfill left no 'todo' rows (a latent starvation).
--
-- `cup_claim_specs` is the base table (relkind 'r'); `bee_claim_specs` is a view over it —
-- rewriting the base is sufficient. Multi-tenant: every workspace's specs share this one
-- vocabulary, so the rewrite is intentionally global (no workspace_id predicate).
--
-- Idempotent: the WHERE clause matches only rows whose `states` array still contains 'todo';
-- after the rewrite none do, so a re-run (every deploy) is a no-op.

UPDATE harness_shared.cup_claim_specs
   SET spec = jsonb_set(
         spec,
         '{states}',
         (SELECT jsonb_agg(DISTINCT CASE WHEN e = 'todo' THEN 'open' ELSE e END)
            FROM jsonb_array_elements_text(spec -> 'states') AS e)
       )
 WHERE jsonb_typeof(spec -> 'states') = 'array'
   AND spec -> 'states' @> '["todo"]'::jsonb;
