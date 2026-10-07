---
title: Email draft responder
slug: email-draft-responder
status: draft
---

# Email draft responder

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Connect a Gmail account, instantiate this template, review the disarmed binding, and arm it explicitly.

## Background

Each inbound email creates an isolated trigger run. The message itself is not embedded in the
plan inputs: `triggers:read-payload` with the run's `planRunId` returns it. `mail:reply` with the run's
`planRunId` resolves the recipient, thread, reply headers, and the connected account from the
stored message that launched the run. Its mode defaults to `draft`, so a person reviews the
response before anything is sent. The optional `responseGuidance` workflow input steers tone
without changing any recipient or thread coordinate.

## Phase 1 — Draft

- **P-001** `todo` Read the triggering email with `triggers:read-payload { planRunId: payload.plan_run.runId }` plus optional `payload.plan_run.inputs.responseGuidance`, compose a concise response, then call `mail:reply` with `planRunId=payload.plan_run.runId` and the response as `text`. Never pass `mode:"send"`. Complete only after the tool reports `created:true` or `alreadyCreated:true`.

## Decisions

### D-001 — Draft creation stays anchored to the trigger run; sending is outside this pack
Date: 2026-08-23
The reply verb resolves every mail coordinate and the account from the durable trigger run. The pack
never accepts a recipient and never sends: it calls `mail:reply` in its default draft mode only.
## Requirements

**R-1 — Email draft responder.**
```requirement
{
  "intent": {
    "request": "Draft one response to the triggering email in its existing thread.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001"
    ]
  },
  "acceptance": {
    "condition": "The trigger run creates exactly one draft anchored to the triggering message and sends nothing.",
    "falsifier": "The draft is missing, targets another recipient or thread, or is sent.",
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
