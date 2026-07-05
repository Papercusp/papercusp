-- 504-fed-apply-writer-tiebreak.sql
--
-- WI-2923: the LWW *SQL apply-guard* used `fed_order_key(EXCLUDED…) >=
-- fed_order_key(local…)`, which at an EQUAL order key (two writers completing
-- the same item in the same clock tick — a partition double-execution with no
-- HLC, e.g. the composition-chaos rig's fake clock, or legacy no-HLC rows)
-- applies UNCONDITIONALLY. Two healed cells each apply the OTHER's value, the
-- echo/recapture suppression then stops further ops, and convergence reports a
-- fixed point while the replicas hold DIFFERENT values — a permanent,
-- undetected divergence (composition-chaos P-002: F-003 winner a↔b swap).
--
-- The in-memory fold (projection.ts lwwPick) already resolves clock ties with
-- a value-independent WRITER tie-break; this function gives the SQL apply path
-- the same property: at an equal fed_order_key the HIGHER writer key wins on
-- EVERY replica, so both cells settle on the same value in ≤1 exchange.
--
--   fed_apply_wins(excluded_hlc, excluded_ts, excluded_writer,
--                  local_hlc,    local_ts,    local_writer)
--     → true  when the incoming (EXCLUDED) op should overwrite the stored row:
--         * its fed_order_key is strictly newer, or
--         * the keys are EQUAL and its writer key sorts >= the stored writer
--           key (>= keeps a writer's own echo idempotent — same key, same
--           writer, same value → re-apply is a no-op overwrite).
--
-- Writers are compared as COALESCE(text,'') so a NULL writer (local/legacy
-- rows) stays total and sorts lowest — any attributed remote write beats an
-- unattributed local one at a clock tie, deterministically on every peer.
--
-- Explicit two-level comparison (NOT string concatenation onto the order key):
-- fed_order_key outputs mix real-HLC and derived `lpad(ts)…` encodings, so a
-- concatenated composite would only sort correctly if the encodings were
-- provably fixed-width; the CASE avoids that assumption entirely.
--
-- Pure + IMMUTABLE (same contract as 458's fed_order_key). Idempotent
-- (CREATE OR REPLACE); no table rewrite. The migration runner wraps this file
-- in its own transaction — no top-level BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION harness_shared.fed_apply_wins(
  excluded_hlc text, excluded_ts bigint, excluded_writer text,
  local_hlc    text, local_ts    bigint, local_writer    text
) RETURNS boolean LANGUAGE sql IMMUTABLE AS $fed_apply_wins$
  SELECT CASE
    WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
       > harness_shared.fed_order_key(local_hlc, local_ts) THEN true
    WHEN harness_shared.fed_order_key(excluded_hlc, excluded_ts)
       < harness_shared.fed_order_key(local_hlc, local_ts) THEN false
    ELSE COALESCE(excluded_writer, '') >= COALESCE(local_writer, '')
  END;
$fed_apply_wins$;
