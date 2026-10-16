---
title: Record an inbound Instagram event
slug: social-instagram
status: draft
---

# Record an inbound Instagram event

## Now

**State:** Starter template. Installing this pack makes it available; it does NOT arm it.

**Next:** Connect an Instagram source, instantiate this template, review the 3 disarmed
bindings (`mention`, `comment`, `reply`), and arm the ones you want explicitly.

## Goal

An inbound Instagram event arrived through the `instagram` trigger source. Record what
it was, in one short summary, so the connection's activity is visible — then stop.

**This plan never drafts a reply and never publishes anything.** It is the
least-privilege plan a platform pack can ship: it proves the wiring works
end to end without taking any action on the platform. Compose it with
`@papercupai/social-mention-triage` or `@papercupai/social-comment-digest`
when you want drafting or digesting.

## Input

`trigger` is delivered by the binding that fired:

- `trigger.event` — which event fired: `mention`, `comment`, `reply`.
- the event payload — not embedded in the plan inputs; fetch it with `triggers:read-payload { planRunId: payload.plan_run.runId }` and read its `payload` field, the canonical `social-post` document the Instagram adapter
  normalized. `id` and `text` are always present; `author`, `url`,
  `replyToId` and `occurredAt` are present when Instagram supplies them.
- `trigger.dedupeKey` — stable across identical passes, so a redelivery of the
  same event carries the same key.

## Steps

Read `triggers:read-payload { planRunId: payload.plan_run.runId }` once. When
`response.events` is present, process every entry in that complete batch. Otherwise process
the response as one entry. Use each entry's own `source`, `event`, `payload`, `dedupeKey` and
`occurredAt`; the top-level fields describe only the first event. Apply the steps below to
each entry independently and include every outcome in the completion.

- **P-001** `todo` Read every delivered event in the batch, use only supplied fields, and record a concise activity summary. Ask the owner only when the stated escalation condition applies; take no platform write.

1. For the current entry, read its `payload`. Use ONLY fields that are actually present on it —
   an absent field means Instagram did not supply one, not that you should go
   looking for it elsewhere.
2. Summarize the event in your completion, in one or two lines: the platform,
   `trigger.event`, the author if present, the permalink if present, and the
   first line of `text`.
3. If — and only if — the event plainly needs a person (it is hostile, legal,
   financial, or commits the owner to something they have not said), raise it
   with `coord:ask-owner`. Otherwise complete quietly.

## Not in scope

- **Do not reply, post, or delete.** This pack requests no write path, and the
  registry gates writes independently of what a plan asks for.
- **Do not read the delivery ledger.** `harness_shared.trigger_deliveries` is
  written by ingestion and exposed by NO agent verb, so "read the events
  coalesced into this run" names a capability that does not exist. Work from the
  `trigger` you were handed.
- **Do not construct a postId** as `instagram:<id>`. A postId is opaque: `social:read`
  and `social:reply` accept one only as `social:search` returned it, verbatim.
  If a later step needs one, get it from `social:search`.
## Requirements

**R-1 — Record an inbound Instagram event.**
```requirement
{
  "intent": {
    "request": "Record an inbound Instagram event as a concise activity summary.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001"
    ]
  },
  "acceptance": {
    "condition": "One trigger run identifies the Instagram event and summarizes only payload fields supplied by the platform.",
    "falsifier": "The completion invents an absent event fact, omits the event, or the run replies, posts, or deletes.",
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
| R-1 | P-001 | tree |
