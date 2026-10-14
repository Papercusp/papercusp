-- 1497 — inherited organization → department → workspace governance policy
-- (papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, WI-10007900).
--
-- One row per policy LAYER. A workspace binds to the tree through its own
-- level='workspace' layer (scope_ref = workspace id); every layer points at its
-- parent, so the evaluation chain is the walk from the workspace layer to the root.
-- Rules/exceptions are evaluated by packages/operator-core/lib/governance-policy/
-- inherited-policy.ts (fail-closed intersection: a descendant can only narrow).
--
-- governance_policy_layer_versions is the append-only VERSIONED EVIDENCE of every
-- change: the full content at each version, its hash, who changed it and why.
-- Expand-only DDL; no existing object is altered.

CREATE TABLE IF NOT EXISTS harness_shared.governance_policy_layers (
  layer_id        text        PRIMARY KEY,
  level           text        NOT NULL CHECK (level IN ('organization', 'department', 'workspace')),
  scope_ref       text        NOT NULL,
  parent_layer_id text        NULL REFERENCES harness_shared.governance_policy_layers (layer_id),
  version         integer     NOT NULL CHECK (version >= 1),
  rules           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  exceptions      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  content_hash    text        NOT NULL,
  updated_by      text        NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_policy_layers_root_is_org
    CHECK ((parent_layer_id IS NULL) = (level = 'organization')),
  CONSTRAINT governance_policy_layers_no_self_parent
    CHECK (parent_layer_id IS DISTINCT FROM layer_id)
);

-- One layer per (level, scope): one workspace layer per workspace, one org layer per org.
CREATE UNIQUE INDEX IF NOT EXISTS governance_policy_layers_level_scope_uq
  ON harness_shared.governance_policy_layers (level, scope_ref);

CREATE INDEX IF NOT EXISTS governance_policy_layers_parent_idx
  ON harness_shared.governance_policy_layers (parent_layer_id);

CREATE TABLE IF NOT EXISTS harness_shared.governance_policy_layer_versions (
  layer_id        text        NOT NULL REFERENCES harness_shared.governance_policy_layers (layer_id),
  version         integer     NOT NULL CHECK (version >= 1),
  level           text        NOT NULL,
  scope_ref       text        NOT NULL,
  parent_layer_id text        NULL,
  rules           jsonb       NOT NULL,
  exceptions      jsonb       NOT NULL,
  content_hash    text        NOT NULL,
  actor           text        NOT NULL,
  reason          text        NOT NULL CHECK (length(btrim(reason)) > 0),
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (layer_id, version)
);

COMMENT ON TABLE harness_shared.governance_policy_layers IS
  'P-005 inherited governance policy layers (organization > department > workspace). Evaluated fail-closed by governance-policy/inherited-policy.ts at the shared kernel enforcement seat.';
COMMENT ON TABLE harness_shared.governance_policy_layer_versions IS
  'Append-only versioned evidence of every governance policy layer change (content, hash, actor, reason).';
