-- code-intel-delivery-and-outcomes-2026-10-26 P-007 (WI-6554700010029481):
-- record the enclosing function/class names of each edit at edit time, so
-- symbol history survives later rewrites of the file.
-- NULL means the capture did not run or could not measure (unknown).
-- An empty array means the capture ran and the edit touched no named symbol.
ALTER TABLE harness_shared.edit_attribution_ledger
  ADD COLUMN IF NOT EXISTS symbols text[];

COMMENT ON COLUMN harness_shared.edit_attribution_ledger.symbols IS
  'Enclosing function/class names (code-health dotted names) of the lines this edit changed, '
  'measured right after the edit against the file''s committed HEAD blob. NULL = unknown '
  '(not measured, non-TS/JS file, parse failure, or legacy row); {} = measured, no enclosing symbol.';

-- Lookups by (file, symbol): readSymbolProvenance filters a file''s history by
-- symbols @> ARRAY[name] OR symbols IS NULL. The GIN index serves the
-- containment arm; the partial btree serves the unknown (NULL) arm without
-- scanning a hot file''s measured rows.
CREATE INDEX IF NOT EXISTS edit_attribution_ledger_symbols_gin
  ON harness_shared.edit_attribution_ledger USING gin (symbols);

CREATE INDEX IF NOT EXISTS edit_attribution_ledger_symbols_unknown_idx
  ON harness_shared.edit_attribution_ledger (repo_root, file, ts DESC)
  WHERE symbols IS NULL;
