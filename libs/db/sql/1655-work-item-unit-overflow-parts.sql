-- 1655 — overflow parts of a whole-unit work_items:get (shared-reference-system-2026-11-13
-- P-005, R-4; design D-032 #4).
--
-- work_items:get returns the whole unit: header, full body, every comment and the
-- complete latest checkpoint. When the unit does not fit the caller's per-result
-- capacity, the parts that fit are returned inline and the rest are written here,
-- in one transaction, by the reading call. They are never fetched by a second
-- call (R-4 forbids that). The caller's own hooks deliver them at the next input:
-- the mid-turn-context endpoint (Claude PostToolBatch) and the turn-start-memory
-- endpoint (UserPromptSubmit) drain this owner's pending parts in
-- (created_at, invocation_id, part_index) order.
--
-- Delivery is ack-on-proof and reuses the existing memory-emission receipt ledger
-- (memory/session-epoch-ledger.ts). An emission stages its parts under that
-- emission's deliveryToken (staged_token). A part becomes delivered only when the
-- next hook request echoes the token together with the part's exact content hash.
-- An unproven emission is offered again, so a restart loses no part and a proven
-- one is never repeated.
--
--   unit_ref        the work-item id the unit describes
--   part_index      1-based index of this part within the unit
--   part_count      N, the unit's total number of parts
--   content         the rendered part (its announcement line plus its segments)
--   content_sha256  sha256 of content, matched exactly against the receipt
--   unit_sha256     sha256 of the whole serialised unit (unit-parts.ts)
--   staged_token    the deliveryToken of the emission that last offered it
--   delivered_at    set only on a proven receipt; NULL means still pending
--
-- Expand-only: one new table and one partial index.

CREATE TABLE IF NOT EXISTS harness_shared.work_item_unit_overflow_parts (
  workspace_id    text        NOT NULL,
  owner_id        text        NOT NULL,
  invocation_id   text        NOT NULL,
  part_index      integer     NOT NULL CHECK (part_index >= 1),
  unit_ref        text        NOT NULL,
  part_count      integer     NOT NULL CHECK (part_count >= part_index),
  content         text        NOT NULL,
  content_sha256  text        NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  unit_sha256     text        NOT NULL CHECK (unit_sha256 ~ '^[a-f0-9]{64}$'),
  staged_token    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  PRIMARY KEY (workspace_id, owner_id, invocation_id, part_index)
);

-- The drain reads one owner's undelivered parts oldest first.
CREATE INDEX IF NOT EXISTS work_item_unit_overflow_parts_pending_idx
  ON harness_shared.work_item_unit_overflow_parts (workspace_id, owner_id, created_at, invocation_id, part_index)
  WHERE delivered_at IS NULL;

COMMENT ON TABLE harness_shared.work_item_unit_overflow_parts IS
  'Overflow parts of a whole-unit work_items:get (shared-reference-system-2026-11-13#D-032 #4). Written by the reading call, delivered by the caller''s hooks at the next input, marked delivered only on a proven hook receipt.';

-- Which owners' hooks prove receipts. Overflow may be withheld from the inline
-- result only for such an owner: without a receipt a withheld part could never be
-- marked delivered. A staged memory emission is not evidence (turn-start stages
-- whether or not a receipt can follow, and a proven one clears its cursor), so the
-- hook's own declaration is recorded instead: a native hook request that carries
-- its delivery ledger (memoryReceiptMode, or a confirmedMemoryDeliveries array).
-- seen_at is rewritten at most every few minutes per owner (a conditional upsert).
CREATE TABLE IF NOT EXISTS harness_shared.work_item_unit_receipt_hooks (
  workspace_id  text        NOT NULL,
  owner_id      text        NOT NULL,
  port          text        NOT NULL,
  client        text        NOT NULL,
  seen_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, owner_id)
);

COMMENT ON TABLE harness_shared.work_item_unit_receipt_hooks IS
  'Owners whose native hooks declared a delivery ledger recently (shared-reference-system-2026-11-13#D-032 #4). Read by deferUnitOverflow before withholding overflow parts.';
