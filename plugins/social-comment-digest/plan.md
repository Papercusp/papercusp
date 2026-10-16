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
`providerStormPolicyFor()` derives from that platform's own rate budget: Reddit's documented 60
requests/minute funds 30 runs per five-minute window, YouTube's 10,000 daily units funds 3,
Threads' dynamic allowance funds 16, and Facebook Pages and Instagram — whose budgets scale with
impressions and are only observable as percentages — fund 1. A single hand-picked cap across five
platforms would have to be the smallest of them to be safe, which would throttle Reddit by 30×.

A digest reads its complete retained batch through `triggers:read-payload`; it does not
query the private delivery ledger. Use `social:search` with a platform and time window to
supplement that batch and obtain opaque post identifiers. Search limits remain visible,
while every delivered batch entry must be represented even when search is truncated.

Comment volume is bursty and unbounded in a way mail is not: one post going wide produces thousands
of genuinely distinct comments in minutes. Nothing is dropped by the policy — the cap bounds RUNS,
not events — but the SEARCH is capped at 50 hits per call, which is a different and real limit the
digest must report rather than hide.

## Phase 1 — Collect

Read `triggers:read-payload { planRunId: payload.plan_run.runId }` once. When
`response.events` is present, process every entry in that complete batch. Otherwise process
the response as one entry. Use each entry's own `source`, `event`, `payload`, `dedupeKey` and
`occurredAt`; the top-level fields describe only the first event. Apply the steps below to
each entry independently and include every outcome in the completion.

Combine the batch entries with the search hits below, deduplicating by supplied stable
source and external identifiers. Report retained batch coverage separately from search overflow.


- **P-001** `todo` Read every delivered batch entry and its own `source` and `occurredAt`. For each platform, take the search window end from its latest supplied timestamp (now when absent) and the start from its earliest timestamp minus the source’s storm-policy `windowSeconds`. Include the payload of every entry in the digest.
- **P-002** `todo` Call `social:search` ONCE PER PLATFORM in scope, passing that `{ from, to }` window, the single platform in `platforms`, and `limit` = `payload.plan_run.inputs.maxCommentsPerPlatform`. Take each hit's `postId` VERBATIM — never assemble one from a platform and an id. Read `scopesSearched` and `skipped` from every response: a platform that was skipped is absent from the digest, and saying so is the difference between an empty section and an unsearched one.
- **P-003** `todo` A search returning exactly `limit` hits for a platform means the window OVERFLOWED and older comments in it are unreported. Record that per platform explicitly; a truncated digest that reads as complete is the failure this step exists to prevent.

## Phase 2 — Summarise

- **P-004** `todo` Group the comments by theme and write the digest. When `payload.plan_run.inputs.includeSentiment` is true, give each theme a sentiment and say what evidence set it; when it is false, omit sentiment entirely rather than emitting a neutral placeholder for every theme.
- **P-005** `todo` List separately every comment matching `payload.plan_run.inputs.escalationGuidance`, each with its author, the `postId` returned by `social:search` for it, and the sentence that flagged it, so the owner can act on one without re-reading the digest. State plainly when the list is empty; an absent section reads as "not checked".
- **P-006** `todo` Complete with the digest, the escalation list, the per-platform breakdown, and — from P-002 and P-003 — which platforms were actually searched, which were skipped, and which overflowed their 50-hit window. Do not reply to any comment: this pack summarises, and answering an individual comment is `social:reply` issued deliberately by the owner.

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

### D-004 — The digest is assembled with `social:search`, because the coalesced deliveries are not agent-readable
Date: 2026-08-23
The natural instruction — "read the comments coalesced into this run from the delivery ledger" —
names a capability that does not exist. `harness_shared.trigger_deliveries` is written by the
ingestion seam and exposed by no agent verb; `triggers:*` covers create/bind/arm/disarm/list/status
only. A plan built on it would look correct and strand the agent at run time.

`social:search` already accepts the two things the digest needs — a `platforms` list and a
`{ from, to }` datetime window — and mints the canonical `postId` for each hit, so the window is
reconstructed from the launching event's timestamp and the source's storm-policy window rather than
from delivery rows. Its `limit` ceiling of 50 per call is why `maxCommentsPerPlatform` is capped at
50 and why P-003 reports overflow: a search that returns exactly `limit` has hidden the remainder,
and a digest that does not say so claims a completeness it never had.

This also settles a smaller trap in the same neighbourhood: a `postId` is an OPAQUE token and both
`social:read` and `social:reply` refuse one the caller assembled. Every step here takes the id
`social:search` returned, verbatim.

### D-003 — No `oauthField` is declared on any binding
Date: 2026-08-23
Same reasoning as the mention-triage pack, plus one platform-specific fact: Threads was
deliberately left unwired to an OAuth provider, because a Threads-configured Meta app carries its
own app id and authorization host distinct from Facebook's, and those endpoints are unverified.
Declaring `provider: "facebook"` for a Threads binding would assert a credential path that was
examined and explicitly not built. Sources connect through the trigger-source flow.
## Requirements

**R-1 — Social comment digest.**
```requirement
{
  "intent": {
    "request": "Produce a useful digest of the triggering social comments and their source posts.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001",
      "P-002",
      "P-003",
      "P-004",
      "P-005",
      "P-006"
    ]
  },
  "acceptance": {
    "condition": "The digest faithfully summarizes collected comments with source references and performs no reply or publishing action.",
    "falsifier": "The digest fabricates comment content, loses source references, or the run replies, posts, or deletes.",
    "requiredScope": [
      "plan-run"
    ],
    "evidencePlane": "tree"
  },
  "verification": {
    "method": "Read the installed plan template and trace one representative trigger run against its input, recorded completion, and declared action boundaries.",
    "check": {
      "kind": "instrument",
      "instrumentKey": "none"
    },
    "replication": "Repeat the review for every material event or decision branch named by the plan."
  }
}
```

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001, P-002, P-003, P-004, P-005, P-006 | tree |
