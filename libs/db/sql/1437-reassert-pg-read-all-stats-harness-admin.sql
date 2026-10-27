-- EI-19447868110362941: reassert the observability grant from migration 733.
-- A deployment missing 733 leaves pg_stat_activity readers seeing masked backend
-- statistics and returning plausible but incomplete results. Applied migrations
-- are not replayed, so this forward repair makes the grant explicit on the next
-- normal migration pass. The role grant is idempotent.
GRANT pg_read_all_stats TO harness_admin;
