---
title: Social comment digest
slug: social-comment-digest
status: draft
---

# Social comment digest

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect one or more comment-bearing social sources, instantiate this template, review the disarmed bindings, and arm them explicitly.

## Background

**The digest period is the storm window, not a poll.** This pack ships no scheduler and needs none.
Social storm policy is `coalesce-with-cap`: within one window the first run launches and every
further comment for that source FOLDS INTO it rather than being skipped, so one run already
represents a window's worth of comments. A digest is exactly what coalescing produces, and building
a separate periodic sweep beside it would poll for events the binding engine is already batching.

That is why the per-binding windows differ and the caps do not read alike. Each is the value
`socialStormPolicyFor()` derives from that platform's own rate budget: Reddit's documented 60
requests/minute funds 30 runs per five-minute window, YouTube's 10,000 daily units funds 3,
Threads' dynamic allowance funds 16, and Facebook Pages and Instagram — whose budgets scale with
impressions and are only observable as percentages — fund 1. A single hand-picked cap across five
platforms would have to be the smallest of them to be safe, which would throttle Reddit by 30×.

**A digest run does not see every comment in its own payload.** The run is launched by ONE trigger
event; the rest of the window's comments are coalesced against it and are read from the delivery
ledger for that source and window. Summarising only the launching event would produce a "digest"
of one comment while reporting a window — the failure this note exists to prevent.

Comment volume is bursty and unbounded in a way mail is not: one post going wide produces thousands
of genuinely distinct comments in minutes. Nothing is dropped — the cap bounds RUNS, not events.

## Phase 1 — Collect

- **P-001** `todo` Read the launching event from `payload.plan_run.inputs.trigger.payload` and its platform from `payload.plan_run.inputs.trigger.source`. Then read the comments coalesced into this run for the same source and window from the delivery ledger — do not treat the launching event as the whole window. Cap the set at `payload.plan_run.inputs.maxCommentsPerDigest`, keeping the OLDEST first so a truncated digest drops the newest rather than silently losing the backlog, and state the count you kept against the count available.

## Phase 2 — Summarise

- **P-002** `todo` Group the comments by theme and write the digest. When `payload.plan_run.inputs.includeSentiment` is true, give each theme a sentiment and say what evidence set it; when it is false, omit sentiment entirely rather than emitting a neutral placeholder for every theme.
- **P-003** `todo` List separately every comment matching `payload.plan_run.inputs.escalationGuidance`, each with its author, its canonical `postId` (`<platform>:<id>`) and the sentence that flagged it, so the owner can act on one without re-reading the digest. State plainly when the list is empty; an absent section reads as "not checked".
- **P-004** `todo` Complete with the digest, the escalation list, the platform breakdown, and the kept-versus-available counts from P-001. Do not reply to any comment: this pack summarises, and answering an individual comment is `social:reply` issued deliberately by the owner.

## Decisions

### D-001 — Coalescing IS the digest mechanism; this pack adds no scheduler
Date: 2026-08-23
The obvious reading of "periodic summary" is a cron job that sweeps for new comments. That would
duplicate work the binding engine already does and would poll a store that is already pushing. The
landed `coalesce-with-cap` policy batches a window's comments into one run by construction, so the
window IS the period and the digest is its natural output. Cadence is retuned by changing the
storm-policy window, not by arming a second timer.

### D-002 — The pack default cap is the TIGHTEST bound platform's, with per-binding overrides carrying each platform's own derivation
Date: 2026-08-23
A pack-wide default is applied to any binding that does not override it, so it must be safe for the
weakest budget in the pack — Facebook Pages and Instagram at one run per window. Every platform
with a larger derived budget carries it as an explicit per-binding override. The alternative,
one averaged cap, is simultaneously too generous for Instagram and 30× too strict for Reddit.

### D-003 — No `oauthField` is declared on any binding
Date: 2026-08-23
Same reasoning as the mention-triage pack, plus one platform-specific fact: Threads was
deliberately left unwired to an OAuth provider, because a Threads-configured Meta app carries its
own app id and authorization host distinct from Facebook's, and those endpoints are unverified.
Declaring `provider: "facebook"` for a Threads binding would assert a credential path that was
examined and explicitly not built. Sources connect through the trigger-source flow.
