---
title: Discord community responder
slug: discord-community-responder
status: draft
---

# Discord community responder

## Now

**State:** Starter template. Installation makes this trigger pack available but does not arm it.

**Next:** Install the `discord` provider package, connect it with a bot token (Message Content intent on) and set its Bot user ID, instantiate this template, review the disarmed binding, and arm it explicitly.

## Background

Each message that @mentions the bot creates one isolated trigger run. The run carries the canonical
chat message under the event `payload` returned by `triggers:read-payload { planRunId: payload.plan_run.runId }`.
The reply tool accepts the run id plus text and resolves the source, channel, message and bot
credential server-side, so neither the event payload nor the worker can redirect the response.
Optional `responseGuidance` steers tone only.

## Phase 1 — Respond

- **P-001** `todo` Read the event `payload` returned by `triggers:read-payload { planRunId: payload.plan_run.runId }` plus optional `payload.plan_run.inputs.responseGuidance`, draft a concise answer to the member's question, then call `chat:reply` with `planRunId=payload.plan_run.runId` and the answer text (it posts a Discord reply to the member's message through the `discord` package; at most 2,000 characters, no pings). Complete only after the tool reports `posted:true` or `alreadyPosted:true`.

## Decisions

### D-001 — Replies stay anchored to the trigger run
Date: 2026-10-20
The plan never accepts a channel or message coordinate. The server resolves both from the durable
trigger run and posts with the connected owner's bot credential.

## Requirements

**R-1 — Discord community responder.**
```requirement
{
  "intent": {
    "request": "Answer the member who mentioned the bot with a reply to their own message.",
    "constraints": [
      "Source references name the plan items that implement this outcome."
    ],
    "sourceRefs": [
      "P-001"
    ]
  },
  "acceptance": {
    "condition": "One reply is posted to the triggering message in its own channel, through chat:reply anchored to the run.",
    "falsifier": "The reply targets another channel or message, is missing, is posted twice, or pings anyone.",
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
