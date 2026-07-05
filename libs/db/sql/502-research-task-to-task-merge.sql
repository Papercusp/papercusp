-- 502-research-task-to-task-merge.sql
-- WI-2874 (2026-07-05): the `research-task` kind was MERGED INTO `task`. Research is
-- non-code work, which is what `task` now means. `research-task` was FEATURE-family
-- (harness_shared.harness_features_consolidated); `task` is ISSUE-family
-- (harness_shared.engineer_issues). The code side (work-items.ts FEATURE_FAMILY_KINDS,
-- claim floors, sentinel deep-delegate, plan executor) has dropped research-task, so any
-- research-task row left in the feature table would fall outside the claim floors and
-- become UNCLAIMABLE. This migration moves the NON-TERMINAL research-task rows into
-- engineer_issues as kind='task' so active work stays claimable. Terminal rows
-- (status passed/deprecated) are left in place — harmless history; reads/UI degrade
-- gracefully (Proxy fallbacks). Idempotent: re-running skips rows already moved.
--
-- Column mapping mirrors harness_shared.work_items_view_dml()'s INSERT-into-issues
-- branch (mig 159) exactly, so a moved row round-trips through the union view identically.

-- 1. Copy non-terminal research-task feature rows into engineer_issues as `task`.
INSERT INTO harness_shared.engineer_issues
  (workspace_id, issue_id, scope, title, body, state, assignee, assigned_at,
   kind, payload, origin, author_pubkey, created_at, updated_at)
SELECT COALESCE(f.workspace_id, 'default'),
       f.feature_id,
       CASE WHEN f.harness_slug IS NULL OR f.harness_slug = '' THEN 'operator'
            ELSE 'harness:' || f.harness_slug END,
       f.title,
       COALESCE(f.summary, ''),
       COALESCE(f.status, 'open'),
       f.taken_by,
       f.taken_at,
       'task',
       f.payload,
       COALESCE(f.origin, 'local'),
       f.author_pubkey,
       COALESCE(to_timestamp(f.created_ts / 1000.0), now()),
       COALESCE(to_timestamp(f.updated_ts / 1000.0), now())
  FROM harness_shared.harness_features_consolidated f
 WHERE f.item_kind = 'research-task'
   AND f.status NOT IN ('passed', 'deprecated')
   AND NOT EXISTS (
     SELECT 1 FROM harness_shared.engineer_issues e
      WHERE e.workspace_id = COALESCE(f.workspace_id, 'default')
        AND e.issue_id = f.feature_id
   );

-- 2. Remove the now-migrated rows from the feature table (only those confirmed present
--    in engineer_issues), so each research-task lives in exactly one family table.
DELETE FROM harness_shared.harness_features_consolidated f
 WHERE f.item_kind = 'research-task'
   AND f.status NOT IN ('passed', 'deprecated')
   AND EXISTS (
     SELECT 1 FROM harness_shared.engineer_issues e
      WHERE e.workspace_id = COALESCE(f.workspace_id, 'default')
        AND e.issue_id = f.feature_id
   );
