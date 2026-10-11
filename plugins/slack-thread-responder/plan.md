---
title: Slack thread responder
slug: slack-thread-responder
status: draft
---

# Slack thread responder

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect Slack Socket Mode, instantiate this template, review the disarmed binding, and arm it explicitly.

## Background

Each Slack mention creates one isolated trigger run. The run carries the canonical chat message
under the event `payload` returned by `triggers:read-payload { planRunId: payload.plan_run.runId }`. The reply tool accepts the run id plus text and
resolves the source, channel, thread, and bot credential server-side, so neither the event payload
nor the worker can redirect the response. Optional `responseGuidance` steers tone only.

## Phase 1 — Respond

- **P-001** `todo` Read the event `payload` returned by `triggers:read-payload { planRunId: payload.plan_run.runId }` plus optional `payload.plan_run.inputs.responseGuidance`, draft a concise answer to the triggering mention, then call `chat:reply` with `planRunId=payload.plan_run.runId` and the answer text (it posts through the source's installed chat package). Complete only after the tool reports `posted:true` or `alreadyPosted:true`.

## Decisions

### D-001 — Replies stay anchored to the trigger run
Date: 2026-08-23
The plan never accepts a channel or thread coordinate. The server resolves both from the durable
trigger run and posts with the connected owner's bot credential.
## Requirements

**R-1 — Slack thread responder.**
```requirement
{
  "intent": {
    "request": "Draft a response to the triggering Slack thread for human review.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001"
    ]
  },
  "acceptance": {
    "condition": "The draft is anchored to the trigger thread and remains unsent.",
    "falsifier": "The draft targets another thread, is missing, or a Slack message is sent.",
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
