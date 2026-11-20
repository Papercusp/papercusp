-- A successor's first section owns the last complete semantic edition. The
-- deferred FK permits saving it before replacing the current rows in one
-- transaction. Removing a page, or replacing its successor, removes its copy.
-- Keep the text-only installation path usable without pgvector. The read runs
-- with the caller's privileges and the source/scope filter of each search.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid = 'harness_shared.doc_sections'::regclass
      AND attname = 'embedding' AND NOT attisdropped) THEN
    RETURN;
  END IF;

  CREATE UNIQUE INDEX IF NOT EXISTS doc_sections_edition_anchor_idx
    ON harness_shared.doc_sections (source_key, slug, anchor, page_sha);

  CREATE TABLE IF NOT EXISTS harness_shared.doc_section_predecessors (
    source_key text NOT NULL,
    slug text NOT NULL,
    successor_anchor text NOT NULL,
    successor_sha text NOT NULL,
    anchor text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    content text NOT NULL,
    page_sha text NOT NULL,
    section_idx integer NOT NULL,
    -- Each retained vector keeps the dimension of its recorded profile if a
    -- later migration changes the width used by the current embedding model.
    embedding public.vector NOT NULL,
    profile_id text NOT NULL,
    required_legacy_mode text,
    PRIMARY KEY (source_key, slug, successor_sha, anchor),
    FOREIGN KEY (source_key, slug, successor_anchor, successor_sha)
      REFERENCES harness_shared.doc_sections (source_key, slug, anchor, page_sha)
      ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
  );

  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION harness_shared.doc_sections_visible(
      requested_profile text, legacy_mode text
    ) RETURNS TABLE (source_key text, slug text, anchor text, title text, url text,
                     content text, page_sha text, section_idx integer, embedding public.vector)
    LANGUAGE sql STABLE PARALLEL SAFE AS $query$
      SELECT d.source_key, d.slug, d.anchor, d.title, d.url, d.content, d.page_sha, d.section_idx, d.embedding
        FROM harness_shared.doc_sections d
       WHERE d.embedding IS NOT NULL
         AND (d.embedding_profile = requested_profile
              OR (d.embedding_profile IS NULL AND d.embedding_mode = legacy_mode))
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.doc_sections sibling
            WHERE sibling.source_key = d.source_key AND sibling.slug = d.slug
              AND (sibling.page_sha <> d.page_sha OR sibling.embedding IS NULL OR
                   (sibling.embedding_profile = requested_profile OR
                    (sibling.embedding_profile IS NULL AND sibling.embedding_mode = legacy_mode)) IS NOT TRUE)
         )
      UNION ALL
      SELECT p.source_key, p.slug, p.anchor, p.title, p.url, p.content, p.page_sha, p.section_idx, p.embedding
        FROM harness_shared.doc_section_predecessors p
       WHERE p.profile_id = requested_profile
         AND (p.required_legacy_mode IS NULL OR p.required_legacy_mode = legacy_mode)
         AND EXISTS (
           SELECT 1 FROM harness_shared.doc_sections d
            WHERE d.source_key = p.source_key AND d.slug = p.slug
              AND (d.page_sha <> p.successor_sha OR d.embedding IS NULL OR
                   (d.embedding_profile = requested_profile OR
                    (d.embedding_profile IS NULL AND d.embedding_mode = legacy_mode)) IS NOT TRUE)
         )
    $query$
  $ddl$;
END
$migration$;
