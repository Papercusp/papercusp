-- Legacy baselines keep their original SHA and time. Only the writer that
-- observed a review may attach its evidence to a baseline.
ALTER TABLE harness_shared.harness_docs
  ADD COLUMN IF NOT EXISTS last_review jsonb;

-- Status, retry counters and projection timestamps do not change the subject
-- of a review. Epoch seconds retain the database's full timestamp precision
-- across readers with different time zones.
CREATE OR REPLACE FUNCTION harness_shared.harness_doc_review_scope(d harness_shared.harness_docs)
RETURNS jsonb LANGUAGE sql STABLE PARALLEL SAFE AS $scope$
  SELECT jsonb_build_object(
    'workspace', d.workspace_id, 'harness', d.harness_slug, 'doc', d.doc_id,
    'origin', d.origin, 'authorKey', d.author_pubkey, 'source', d.source,
    'contentMode', d.content_mode, 'title', d.title, 'contentHash', d.content_hash,
    'bodyHash', encode(sha256(convert_to(d.content, 'UTF8')), 'hex'),
    'overlayHash', encode(sha256(convert_to(d.overlay, 'UTF8')), 'hex'),
    'subjects', d.subject_ref, 'paths', d.anchor_paths, 'retired', d.retired_at IS NOT NULL,
    'baseline', d.last_verified_sha, 'observedAt', extract(epoch FROM d.last_verified_at)
  )
$scope$;
