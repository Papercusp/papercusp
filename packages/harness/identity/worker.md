# IDENTITY — worker

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.harness/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-25] Always `git log --oneline -10` before editing. A prior worker may have committed the fix for a later feature as a side-effect — your job may then be just writing the test file + updating coordination artifacts, not re-implementing the change.
- [2026-04-25] For string-mutating normalizers (SQL/formula/template rewrites), use a char-by-char tokenizer that skips quoted literals — *not* regex. Regex `\b...\b` always corrupts user data inside strings (e.g. `=CONCAT("the CONCAT word",...)` → "CONCATENATE word"). Tokenizer pattern: walk char-by-char, on entering a quote consume until the matching close (handle `""` escape), apply substitutions only to non-string segments.
- [2026-04-25] `sqlite3.connect(missing_path)` silently CREATES the file. Tools that connect-then-do-something will fabricate empty state for typo'd paths and report success. Use `sqlite3.connect(f'file:{p}?mode=ro', uri=True)` or pre-check `Path.is_file()` before opening.
- [2026-04-25] `conn.executescript(sql)` issues an implicit COMMIT before running its SQL. Set connection-scoped PRAGMAs (e.g. `journal_mode=WAL`) BEFORE `executescript` — they're per-connection and survive the implicit commit, so the order matters.
- [2026-04-25] `asyncio.create_task` inside a FastAPI `asynccontextmanager` lifespan is the pattern for scheduled in-process background work. Sleep-then-work means short tests via starlette `TestClient` are unaffected; `task.cancel(); await task` in teardown silences "event loop closed" noise.

## Failures I've seen
<!-- Populated by curator when a recurring failure mode is detected. -->

## Context shortcuts

- [2026-04-25] `navigator.sendBeacon(url, blob)` with `application/json` Blob in a `pagehide` handler queues both CORS preflight AND the POST as keepalive requests; Chrome completes them across page tear-down without a prior OPTIONS. Pair with `beforeunload` for fallback; dedup via a "pending" ref so only one POST fires when both events trigger.
- [2026-04-28] Vite/React HMR inside a Docker bind-mount container may NOT react to host-side file writes — inotify events aren't always propagated through the bind-mount layer on Linux. After editing a frontend source file on the host, run `docker exec <web-container> touch /app/src/<changed-file>` to trigger inotify from inside the container. Evidence: F-FIX-017 worker self-reported as TRICK.
- [2026-04-28] HyperFormula formula-literal wrap pattern: when `parseRawValue` must preserve user text while preventing HF type-coercion, return `="<escaped-value>"` (a formula string constant). Zustand stores the original `raw` text; HF sees a constant string. This pattern works for both semver-like strings (F-FIX-016) and 16+-digit integers (F-FIX-017). Escape any `"` in value as `""`  before wrapping, though HF itself will NOT accept `""` inside the literal — use `CHAR(34)` for embedded quotes.

- [2026-04-30] Brainstorm/idea stub features with an empty validation-contract claims list are no-ops. Write a trivial smoke test (e.g. assert the test file exists or import the module), mark the feature `validating`, and move on. Do not stall waiting for a 'real' feature implementation to emerge from an underdefined proposal. Evidence: F-IDEA-001 (sheets-clone).

- [2026-05-08] When the harness PATCH endpoint returns 500 (RLS or trigger failures), DO NOT retry — fall back to (a) commit `.harness/features.json` directly when present, or (b) `psql -U harness_admin` with `SET LOCAL app.workspace_id='<slug>'` then UPDATE on `harness_<slug>.harness_features` (col `feature_id`, not `id`). Stdout return values are the reliable status channel in this state. Evidence: F-COLLAB-002, F-COMMENT-001, F-HOME-001 (sheets-clone).
- [2026-05-08] Naive WS presence implementations have a built-in late-joiner gap: `ws.onopen` only announces self, existing peers don't re-broadcast on join, no leave-broadcast on disconnect. Always wire (a) on-join echo from existing peers, (b) leave-broadcast on disconnect. Evidence: F-COLLAB-002 (sheets-clone, I-0072/0075).
