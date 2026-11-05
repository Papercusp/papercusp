-- report-sharing-gist-pages-2026-11-05 P-002. Mutable external publication state
-- beside immutable report_library editions. Existing settings/user_data lack
-- edition/account identity and recovery lifecycle. No report body is duplicated.
CREATE TABLE IF NOT EXISTS harness_shared.report_library_shares (
  workspace_id text NOT NULL,
  report_id text NOT NULL,
  github_user_id bigint NOT NULL,
  share jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, report_id, github_user_id),
  FOREIGN KEY (workspace_id, report_id)
    REFERENCES harness_shared.report_library(workspace_id, report_id),
  CHECK (jsonb_typeof(share) = 'object')
);
