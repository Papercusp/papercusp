---
title: Social scheduled crosspost
slug: social-scheduled-crosspost
status: draft
---

# Social scheduled crosspost

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it, and does not schedule it.

**Next:** Connect the destination accounts, instantiate this template with its `destinations`, then arm the cadence with `plans:set-schedule` followed by `plans:arm-schedule` — authoring a schedule and arming it are two steps, and an unarmed schedule never fires.

## Background

**Where the cadence actually lives.** The trigger-pack schema has a `schedule` binding source with a
`scheduleRef`, and this pack deliberately does not use it: that source kind is declared in the type
and the JSON schema but nothing in the system consumes it, so a schedule-sourced binding would
validate cleanly and never fire. This pack's binding is therefore `manual` — an honest statement
that something outside the pack starts the run — and the cadence is armed on the instantiated plan
through `plans:set-schedule` + `plans:arm-schedule`, which is the real scheduling surface. See
D-001.

**Publishing is owner-ratified and this plan does not assume otherwise.** `social:post` is gated by
an owner-authority flag: until the owner enables it, the verb resolves the account, destination and
audience and returns them WITHOUT sending, setting `withheld`. That is the correct behaviour to
report, not a failure to retry. A crosspost run that reports success while every post was withheld
is the specific wrong outcome this plan is written to avoid.

**Adaptation is per-platform work the agent does, not a lookup.** The registry records each
platform's write path, verbs and idempotency, but it carries NO structured text-length field —
limits appear only inside prose notes (Bluesky's 3000 bytes / 300 graphemes is stated there, for
instance). So the plan adapts by reading the destination platform's own constraints rather than by
reading a field that does not exist; do not invent one.

## Phase 1 — Compose

- **P-001** `todo` Compose one shared draft following `payload.plan_run.inputs.composeGuidance`. Keep it platform-neutral: the per-platform adaptation happens next, and jargon baked in here has to be removed six times instead of added once.
- **P-002** `todo` For each ref in `payload.plan_run.inputs.destinations`, split it on the FIRST colon only — the platform half is the prefix, the rest is the destination, and a destination may itself contain colons. When `payload.plan_run.inputs.adaptPerPlatform` is true, produce a per-platform variant honouring that platform's own text and media constraints; when false, use the shared draft verbatim for every destination and say so in the report. Record each variant beside its destination before publishing anything.

## Phase 2 — Publish

- **P-003** `todo` Publish each variant with `social:post`, passing the destination ref verbatim from the input — never a ref assembled from a platform and a name, and never one lifted from post content. Publish one destination at a time and record each result individually.
- **P-004** `todo` Report per destination: published, withheld, or refused. A `withheld` result means NOTHING was published for that destination and is the answer to surface, not to retry. `write-unverified` and `owner-blocked` are terminal refusals — report them and stop; retrying or switching platform will not clear either. Complete only after every destination has one of those three outcomes recorded, and state the counts.

## Decisions

### D-001 — The binding source is `manual`, not `schedule`, because the `schedule` source kind has no consumer
Date: 2026-08-23
`{ kind: 'schedule', scheduleRef }` exists in the plugin SDK type and in the published JSON schema,
and the trigger-pack validator skips every check for a non-external source — so a schedule binding
would pass validation and appear correct. Nothing reads it: no installer, no binding engine, no
runtime path. Shipping the template's defining feature on top of that would produce a pack that
looks scheduled and silently never runs, which is worse than one that says plainly that the owner
arms the cadence elsewhere. The real surface, `plans:set-schedule` + `plans:arm-schedule`, is named
in `## Now` instead.

### D-002 — The destination platform set is derived from the registry, not enumerated by hand
Date: 2026-08-23
The `destinations` pattern admits exactly the platforms whose registry row declares the `post`
write verb AND carries a verified write path. That is a fact the registry owns, so a hand-typed
list would be a second copy of it: a platform gaining `post`, or losing write verification, would
leave this pattern quietly wrong in whichever direction is worse. A test recomputes the set from
the registry and fails on disagreement.

### D-003 — The default cap is one run per 1728 seconds, which is Instagram's derived publishing bound
Date: 2026-08-23
A pack-wide default must be safe for the weakest budget it can be applied to. Across the six
post-capable platforms the tightest derived `post` policy is Instagram's — its ~50-posts-per-24h
publishing bucket, which is a hard per-verb cap rather than a share of a general call budget. The
cap bounds crosspost RUNS, and one run publishes to every destination, so this is not a per-platform
throttle: it is the rate at which the whole fan-out may repeat.
## Requirements

**R-1 — Social scheduled crosspost.**
```requirement
{
  "intent": {
    "request": "Compose and report one crosspost result for every configured destination.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001",
      "P-002",
      "P-003",
      "P-004"
    ]
  },
  "acceptance": {
    "condition": "Each destination is adapted as specified and has an individually recorded published, withheld, or refused result.",
    "falsifier": "A destination lacks a result, content violates its platform constraints, or withheld work is reported as published.",
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
| R-1 | P-001, P-002, P-003, P-004 | tree |
