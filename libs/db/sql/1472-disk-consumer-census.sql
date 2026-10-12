-- 1472-disk-consumer-census
--
-- The disk consumer census: what is filling each watched device, sampled on a schedule so a
-- read can answer "how big is each consumer, and how much did it grow in the last 24h".
-- Plan: disk-headroom-standing-reclaim-2026-10-12 P-001 (R-1); work item WI-6554700010008933.
--
-- WHY THIS EXISTS: the disk-space alarm (storage/disk-space-alarm.ts) knows a device is low, and
-- the storage-growth alarm knows a REGISTERED store or an unregistered ~/.papercusp child is big —
-- but nothing records what is on a whole device over time. On 2026-10-12 / reached 49 GB free and
-- the cause had to be rebuilt by hand with du (PG 215G, docker 70G, release-cut worktrees 180G on
-- /mnt/data). With no history there was no way to say which consumer had grown.
--
-- GRAIN: one disk_census_runs row per (host, device) per census pass; one disk_census_consumers row
-- per consumer measured in that run. A consumer key is an absolute path for du-measured trees
-- ('dir' / 'files' / 'file'), a 'postgres:'/'docker:' key for stores measured through their own
-- APIs because the operator user cannot read them, or '<device> (unattributed)' for the bytes the
-- census could not attribute. The 24h growth is a join of the latest run with the run nearest to
-- 24h before it, on the consumer key.
--
-- RETENTION: rows older than 30 days are deleted by the census itself (runDiskConsumerCensusOnce,
-- storage/disk-consumer-census.ts); consumers go with their run via ON DELETE CASCADE.
--
-- EXPAND-ONLY, so no FORWARD-COMPAT acknowledgment is required: this migration only CREATEs new
-- relations. The currently-deployed :3070 release neither reads nor writes them.

CREATE TABLE IF NOT EXISTS harness_shared.disk_census_runs (
    run_id           uuid        PRIMARY KEY,
    host             text        NOT NULL,
    device           text        NOT NULL,
    started_at       timestamptz NOT NULL,
    finished_at      timestamptz NOT NULL,
    size_bytes       bigint      NOT NULL,
    used_bytes       bigint      NOT NULL,
    avail_bytes      bigint      NOT NULL,
    attributed_bytes bigint      NOT NULL,
    complete         boolean     NOT NULL,
    note             text
);

COMMENT ON TABLE harness_shared.disk_census_runs IS
  'One census pass over one device (mount point) on one host. used/size/avail are statfs; attributed_bytes is what the census assigned to consumers. complete=false when the du walk timed out or failed. Written by storage/disk-consumer-census.ts; pruned after 30 days.';
COMMENT ON COLUMN harness_shared.disk_census_runs.device IS
  'Mount point of the device (e.g. / or /mnt/data), resolved from /proc/self/mountinfo.';

CREATE INDEX IF NOT EXISTS disk_census_runs_host_device_finished_idx
    ON harness_shared.disk_census_runs (host, device, finished_at DESC);

CREATE TABLE IF NOT EXISTS harness_shared.disk_census_consumers (
    run_id   uuid     NOT NULL REFERENCES harness_shared.disk_census_runs (run_id) ON DELETE CASCADE,
    consumer text     NOT NULL,
    kind     text     NOT NULL CHECK (kind IN ('dir', 'files', 'file', 'postgres', 'docker', 'unattributed')),
    depth    smallint NOT NULL,
    bytes    bigint   NOT NULL CHECK (bytes >= 0),
    PRIMARY KEY (run_id, consumer)
);

COMMENT ON TABLE harness_shared.disk_census_consumers IS
  'One consumer measured in one disk_census_runs pass. kind: dir = a directory subtree (du); files = the files directly inside a listed directory; file = one large file; postgres / docker = stores sized through their own APIs; unattributed = device used bytes the census could not assign.';
COMMENT ON COLUMN harness_shared.disk_census_consumers.depth IS
  'Path depth below the device mount point (0 = the mount point itself). API-sized and unattributed rows use 0.';
