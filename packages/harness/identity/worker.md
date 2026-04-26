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
