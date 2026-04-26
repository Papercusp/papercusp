# IDENTITY — curator

This file is your durable, cross-mission memory. Curator maintains it (append-only). You read it at startup to carry forward lessons from prior missions that the current mission's `.harness/memory/summary.md` doesn't capture.

## Patterns I've learned

- [2026-04-25] When the same trap bites multiple consecutive features (e.g. one mission's bind-mount + no-reload trap hit 3 features in a row before being captured), promote it to `summary.md` "Avoid" — not just "Lessons". Lessons get scrolled past; "Avoid" gates behavior. The signal that a lesson belongs in Avoid is repetition across distinct feature ids, not severity.
- [2026-04-25] After auto-closing issues whose `linkedFeatureId` ↔ a now-passed feature, manually scan the remaining open issues for codepath overlap with the freshly-merged work. Issues from older rounds (no `linkedFeatureId`) often describe a regression that the new fix obviated — they need explicit closure with a "superseded by F-FIX-XXX" note, otherwise the open count stays artificially high.
- [2026-04-26] When the prior curator pass already absorbed lessons that fully describe the current fault AND the new raw entries are pure echoes (no new pending issues, no feature-state changes, no contract diff between cycles), this is a stall, not a retry. Promote a "STALLED — awaiting supervisor/scoper" block to the TOP of `summary.md` and add an Avoid bullet that gates re-dispatch on at least one of: contract rewrite, `features.json` reconciliation, role/phase reconfiguration. Bumping the curated timestamp is not progress; the orchestrator/coordinator needs an explicit gate or it'll loop forever. Signal: ≥2 consecutive escalations citing identical blockers with no scoper revision between them.

## Failures I've seen

- [2026-04-26] Three orchestrator escalations in ~16 minutes (restart-org runs 1777193472, 1777193516, 1777194386), all on the same phase-mismatch + rejected-contract fault, with two intervening curator passes that just re-stamped MEMORY.md. Curator should have escalated the meta-stall into `summary.md#Avoid` after the SECOND identical absorption, not the third.

## Context shortcuts

- [2026-04-25] Pending → durable merge: dedup is `(codePointer exact match if both have one) OR (lowercased title Jaccard ≥ 0.85) AND status in {open,fixing,acknowledged}`. CodePointer line-numbers drift across worker rounds — a stale pointer to L23 vs a new one to L35 in the same file is NOT a duplicate per the rule, even if morally related; rely on title overlap for those.
