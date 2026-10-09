-- Preserve neighboring prerequisites when returning a matching doc section.
-- Existing cache rows remain readable; the versioned sync fills order on recut.
ALTER TABLE harness_shared.doc_sections
  ADD COLUMN IF NOT EXISTS section_idx integer NOT NULL DEFAULT -1;
CREATE INDEX IF NOT EXISTS doc_sections_page_order_idx
  ON harness_shared.doc_sections (source_key,slug,section_idx)
  WHERE section_idx >= 0;
COMMENT ON COLUMN harness_shared.doc_sections.section_idx IS
  'Zero-based canonical page order; -1 denotes a legacy cache row pending versioned resync.';
