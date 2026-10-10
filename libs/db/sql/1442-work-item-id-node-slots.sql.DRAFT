-- Migration 1442 — WI- ids unique across federated databases (node slots).
--
-- scope-unique-identifiers-2026-07-26 P-010, decisions D-005 and D-006.
--
-- next_work_item_id() mints 'WI-' || nextval(work_item_seq), and that sequence
-- exists once per DATABASE. Migration 1003 keeps a database's counter above the
-- WI rows it imports, but two federated databases can still mint the same number
-- before either sees the other's row. Two different items then share one id.
--
-- Fix: once a database federates, it mints inside its own block of ids.
--   id = 'WI-' || (node_slot * 10^11 + local_counter)
-- A database that has never federated has no slot (slot 0), so its ids are the
-- same numbers as before. Slots run 1..90070, so the largest id stays below
-- 2^53 and JavaScript can still hold it as a Number. A decimal block keeps the
-- slot readable: WI-4523100010008294 is slot 45231, counter 10008294.
--
-- A database claims its slot (claim_work_item_id_slot) on its first
-- origin='remote' work_items insert, which is the moment it starts federating.
-- This migration claims at once for a database that already holds remote rows.
-- The slot is derived from the database's HLC node id, so it is stable for the
-- life of the database. Claiming never resets the counter, so a database never
-- re-issues a number it already used.
--
-- The 1003 floor trigger now only advances the counter for imported ids inside
-- this database's own block. An imported id from another node's block can no
-- longer drag the local counter into that node's range.
--
-- Residue (D-006): slot-0 ids minted before a database first federated can still
-- collide with another database's slot-0 ids; slots are a hash draw, so two of
-- ten nodes share one with probability about 5e-4; a database restored onto a
-- second machine keeps the original's HLC node id and therefore its slot.
-- Mixed versions: a peer still on the pre-1442 trigger that imports a slotted
-- id pushes its counter into the sender's block and can mint ids there until it
-- upgrades. When it upgrades, the claim below moves its counter back into its
-- own block (it does not refuse), so the window closes at the peer's upgrade.

CREATE TABLE IF NOT EXISTS harness_shared.work_item_id_space (
    id           smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    node_slot    integer     NOT NULL CHECK (node_slot BETWEEN 1 AND 90070),
    node_id      text        NOT NULL,
    claim_reason text        NOT NULL,
    claimed_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE harness_shared.work_item_id_space IS
    'Per-database (never federated) single row: the WI- id block this database mints in once it federates. No row = slot 0 = pre-federation numbering. Written only by claim_work_item_id_slot().';

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN
        GRANT SELECT ON harness_shared.work_item_id_space TO harness_app;
    END IF;
END
$grant$;

CREATE OR REPLACE FUNCTION harness_shared.claim_work_item_id_slot(
    p_node_id text DEFAULT NULL,
    p_reason  text DEFAULT 'explicit claim'
) RETURNS integer
    LANGUAGE plpgsql
    VOLATILE
    SECURITY DEFINER
    SET search_path = pg_catalog, harness_shared
AS $body$
DECLARE
    block constant bigint := 100000000000;
    max_slot constant integer := 90070;
    v_node text := lower(p_node_id);
    v_slot integer;
    v_existing integer;
    v_max_in_block numeric;
    v_counter bigint;
    v_current bigint;
    v_called boolean;
BEGIN
    -- Same lock as next_work_item_id and the import floor, so no allocation can
    -- run between reading the counter and recording the slot.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );

    SELECT node_slot INTO v_existing FROM harness_shared.work_item_id_space WHERE id = 1;
    IF v_existing IS NOT NULL THEN
        RETURN v_existing;
    END IF;

    IF COALESCE(v_node, '') = '' THEN
        SELECT node_id INTO v_node FROM harness_shared.hlc_clock WHERE id = 1;
    END IF;
    IF COALESCE(v_node, '') = '' THEN
        -- hlc_now() mints and stores the node id on first use.
        PERFORM harness_shared.hlc_now();
        SELECT node_id INTO v_node FROM harness_shared.hlc_clock WHERE id = 1;
    END IF;
    IF v_node IS NULL OR v_node !~ '^[0-9a-f]{8}' THEN
        RAISE EXCEPTION 'claim_work_item_id_slot: node id % does not start with 8 hex digits', v_node
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    v_slot := 1 + ((('x' || substr(v_node, 1, 8))::bit(32)::bigint) % max_slot)::integer;

    -- After the claim only ids inside this database's block can collide with
    -- its allocator, so the counter must end above the highest one it already
    -- holds there (for example rows from a node that happens to share the slot).
    SELECT max(candidate) INTO v_max_in_block
      FROM (
        SELECT substring(feature_id FROM 4)::numeric AS candidate
          FROM harness_shared.work_items
         WHERE feature_id ~ '^WI-[0-9]{1,18}$'
      ) AS ids
     WHERE candidate >= v_slot::numeric * block
       AND candidate <  (v_slot + 1)::numeric * block;
    v_counter := COALESCE((v_max_in_block - v_slot::numeric * block)::bigint, 0);

    SELECT last_value, is_called INTO v_current, v_called FROM harness_shared.work_item_seq;
    IF v_current >= block THEN
        -- A pre-1442 floor trigger imported another node's slotted id and
        -- pushed the counter past one block. Restart inside our own block.
        IF v_counter = 0 THEN
            PERFORM setval('harness_shared.work_item_seq'::regclass, 1, false);
        ELSE
            PERFORM setval('harness_shared.work_item_seq'::regclass, v_counter, true);
        END IF;
    ELSIF v_counter > v_current OR (v_counter = v_current AND v_counter > 0 AND NOT v_called) THEN
        -- Otherwise keep the counter, so the database never re-issues a number.
        PERFORM setval('harness_shared.work_item_seq'::regclass, v_counter, true);
    END IF;

    INSERT INTO harness_shared.work_item_id_space (id, node_slot, node_id, claim_reason)
    VALUES (1, v_slot, v_node, COALESCE(NULLIF(p_reason, ''), 'explicit claim'))
    ON CONFLICT (id) DO NOTHING;

    SELECT node_slot INTO v_existing FROM harness_shared.work_item_id_space WHERE id = 1;
    RETURN v_existing;
END
$body$;

COMMENT ON FUNCTION harness_shared.claim_work_item_id_slot(text, text) IS
    'Idempotently give this database its WI- id block (slot 1..90070 from the HLC node id). Called by the work_items insert trigger on the first remote row; safe to call explicitly. Returns the slot.';

CREATE OR REPLACE FUNCTION harness_shared.next_work_item_id() RETURNS text
    LANGUAGE plpgsql
    VOLATILE
    SET search_path = pg_catalog, harness_shared
AS $body$
DECLARE
    block constant bigint := 100000000000;
    v_slot integer;
    v_counter bigint;
BEGIN
    -- Held until the caller's transaction commits its new row. The import-side
    -- trigger and claim_work_item_id_slot take the same lock.
    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );
    SELECT node_slot INTO v_slot FROM harness_shared.work_item_id_space WHERE id = 1;
    v_counter := nextval('harness_shared.work_item_seq'::regclass);
    IF v_counter >= block THEN
        RAISE EXCEPTION 'next_work_item_id: work_item_seq reached %, the size of one node block', block
            USING ERRCODE = 'sequence_generator_limit_exceeded';
    END IF;
    RETURN 'WI-' || (COALESCE(v_slot, 0)::bigint * block + v_counter)::text;
END
$body$;

COMMENT ON FUNCTION harness_shared.next_work_item_id() IS
    'Allocate the next WI- id: node_slot * 10^11 + work_item_seq (slot 0 before the database federates), under the transaction lock shared with federated WI row inserts.';

CREATE OR REPLACE FUNCTION harness_shared.advance_work_item_seq_from_insert()
RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, harness_shared
AS $body$
DECLARE
    block constant bigint := 100000000000;
    numeric_text text;
    imported_numeric numeric;
    imported_id bigint;
    v_slot integer;
    local_counter bigint;
    current_id bigint;
    current_called boolean;
BEGIN
    -- The first remote work item means this database now federates: take its
    -- own id block before any further local allocation.
    IF NEW.origin = 'remote'
       AND NOT EXISTS (SELECT 1 FROM harness_shared.work_item_id_space WHERE id = 1) THEN
        PERFORM harness_shared.claim_work_item_id_slot(NULL, 'first remote work item');
    END IF;

    numeric_text := substring(NEW.feature_id FROM '^WI-([0-9]+)$');
    IF numeric_text IS NULL THEN
        RETURN NEW;
    END IF;

    -- Parse as arbitrary-precision numeric first so a malformed/out-of-range
    -- external id cannot abort an otherwise-valid replicated INSERT.
    imported_numeric := numeric_text::numeric;
    IF imported_numeric > 9223372036854775807 THEN
        RETURN NEW;
    END IF;
    imported_id := imported_numeric::bigint;

    -- Only an id inside this database's own block can collide with its allocator.
    SELECT node_slot INTO v_slot FROM harness_shared.work_item_id_space WHERE id = 1;
    v_slot := COALESCE(v_slot, 0);
    IF imported_id < v_slot::bigint * block OR imported_id >= (v_slot::bigint + 1) * block THEN
        RETURN NEW;
    END IF;
    local_counter := imported_id - v_slot::bigint * block;

    -- Fast path (migration 1218): the counter is already past this id, so no
    -- allocation can reach it. Sequence state is read outside MVCC.
    SELECT last_value, is_called INTO current_id, current_called FROM harness_shared.work_item_seq;
    IF local_counter < current_id OR (local_counter = current_id AND current_called) THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended('harness_shared.work_item_seq:federation-floor', 0)
    );
    SELECT last_value, is_called INTO current_id, current_called FROM harness_shared.work_item_seq;
    IF local_counter > current_id OR (local_counter = current_id AND NOT current_called) THEN
        PERFORM setval('harness_shared.work_item_seq'::regclass, local_counter, true);
    END IF;
    RETURN NEW;
END
$body$;

COMMENT ON FUNCTION harness_shared.advance_work_item_seq_from_insert() IS
    'Before a work_items insert: claim this database''s WI- id block on its first remote row, then advance work_item_seq past an imported WI id that falls inside this database''s own block. Takes the federation-floor lock only when the row raises the floor.';

-- A database that already federates claims now, before its next allocation.
DO $claim$
BEGIN
    IF EXISTS (SELECT 1 FROM harness_shared.work_items WHERE origin = 'remote') THEN
        PERFORM harness_shared.claim_work_item_id_slot(
            NULL, 'migration 1442: database already holds remote work items'
        );
    END IF;
END
$claim$;
