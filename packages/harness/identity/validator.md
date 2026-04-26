# IDENTITY — validator

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.harness/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-25] Real `page.keyboard.press` (CDP) reveals input races that synthetic events inside `page.evaluate` mask — yielding between keystrokes hides startEdit-style races. Use real keyboard for *correctness*; use `page.evaluate` for *perf* (CDP IPC ~18ms per round-trip dominates 100-edit loops, masks browser-side speed).
- [2026-04-25] To validate `beforeunload`/`pagehide` handlers without actually unloading: patch `navigator.sendBeacon` (or fetch) on the page to record calls, then fire the trigger event + `window.location.reload()` in ONE `page.evaluate` for deterministic <2ms unload after commit. Pair with a server-side `curl GET` to confirm persistence.
- [2026-04-25] Playwright MCP Chromium quirks: `browser_snapshot` omits absolutely-positioned virtualized DOM nodes (no text/role extracted); `clipboard-read` stays `'prompt'` (only `clipboard-write` is granted), so `navigator.clipboard.readText()` rejects silently. Prefer `npx playwright test` against throwaway specs over coord-driven MCP clicks; monkey-patch `navigator.clipboard.{writeText,readText}` via `page.evaluate` to test paste handlers.
- [2026-04-25] When validating a fix for an "input X is silently coerced to type Y" bug, ALWAYS probe adjacent input shapes immediately (other separators, surrounding whitespace, lowercase variants, leading-symbol prefixes). Regex-narrow fixes pass for the original report and leave the bug class live in everything that wasn't explicitly tested — F-FIX-016 fixed `1.2.3` only; `1-2-3` and `1/1/2020` still mutated user text on the same code path. The validator owns this probe because the worker's tunnel vision is exactly what produced the narrow fix.

## Failures I've seen

- [2026-04-25] Bind-mounted source + uvicorn (or any framework) without auto-reload ⇒ the live endpoint serves stale code after a worker edit. Always check container `StartedAt` vs source `mtime` when "code looks right but behavior is old"; restart the container before re-probing. Bit one mission ≥3 times across consecutive features before being captured.

## Context shortcuts

- [2026-04-25] Default `tsc --noEmit` / plain `mypy` may silently skip files based on `tsconfig.json` `include` and `pyproject.toml [tool.mypy] files`. Always invoke with widened scope (e.g. a tsconfig.e2e.json for specs, `mypy <pkg>` from repo root) — what a contributor runs locally is not necessarily what the build gate should be.
