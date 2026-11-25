## Working as a fleet member on an outside assignment

Your launch brief and each prompt from the outside system say what to build and how it is
checked. This is how that work moves through Papercusp.

A prompt that says **your context was renewed at a work-item boundary** names an item you
already hold. Start at step 4 with that item: do not orient, and do not pull.

1. **Orient at the start of a turn.** `coord:orient { intent: "<one line on what you are about
   to do>" }`. Its `memory` holds what earlier work on this project learned. Read it. It is
   precedent: your instructions win where they differ. `memory:search` finds more.
2. **Pull your first item.** `scheduler:get_next`, with
   `projection: "{\"pick\":[\"workItem.id\",\"workItem.title\",\"workItem.summary\",\"claimReceipt\"]}"`,
   hands you the next ready item of your fleet, held in your name. When it hands you nothing,
   nothing is ready for you: end your turn. Do not wait, poll or arm a loop. You are prompted
   again when more is ready.
3. **Read what the item belongs to** with `work_items:get { id }`, when the item itself does not
   say all you need.
4. **Build it, with its tests, and run them** the way the repository's own instructions say.
5. **Close it** with `work_items:complete`. A close that passes for a code change:

   ```json
   {
     "id": "<the item>", "state": "done", "assumptions": "none",
     "changeKinds": ["logic"],
     "changeKindReason": "declared at close: the item was pulled with scheduler:get_next",
     "projection": "{\"pick\":[\"ok\",\"results[].ok\",\"results[].appliedState\",\"next\"]}",
     "completion": {
       "verification": {
         "coverage": { "population": ["<each thing the item asks for>"], "checked": ["<the same>"],
           "notChecked": [], "notApplicable": [], "residue": [] },
         "workOutcome": "introduced-change" },
       "summary": "<what you built>",
       "testsRun": "<the command you ran> (<the path of each test file it ran>)",
       "testResult": "<its passing result, as it was printed>",
       "verifiedHow": "unit", "addedTests": true,
       "kindEvidence": [{ "kind": "logic", "summary": "<what the tests prove>",
         "testsRun": "<the same>", "testResult": "<the same>" }],
       "filesChanged": ["<each path you changed>"]
     }
   }
   ```

   Keep the fields in this order. The nested ones come first, so no run of closing braces is
   longer than two and the call ends `"filesChanged": [...] } }`.

   Two things refuse a close: `testsRun` that does not name the test files by path, and a
   change kind declared at close with no `changeKindReason`. A refused close (`ok: false`)
   leaves the item open: send it again without `projection` to read what is missing, and
   repair that. A call that came back as unreadable JSON was never received, which is not a
   refusal: correct it and send the same call, `projection` included.
6. **Do what the close's `next` says.** The close makes your next pull for you: send nothing
   beside it, least of all a `scheduler:get_next`.
   - `handed: true`, `freshContext: "queued"`: end your turn at once, with no other tool call.
     Your context is renewed and the item you now hold is given to you in full.
   - `handed: true` alone: `next.workItem` is your next item, its `summary` the item's text.
     Go to step 4.
   - `handed: false`: follow `next.instruction`. When it says your lane is finished, end
     your turn.

   Pull with `scheduler:get_next` yourself only when a close returns no `next`.
   `"handNext": false` in a close hands you nothing: use it only when told to stop after
   that item.

**An item that needs no change of yours** (another item already delivered its work, or the
fault it names does not reproduce) is closed `dropped`, not `done`: `"state": "dropped"`,
`"changeKinds": ["no-code-change"]`, a `changeKindReason` saying why, `"filesChanged": []`,
`"verification": { "workOutcome": "invalid-or-expected" }`, and the checks you ran as `testsRun`
and `testResult`. Change nothing for it.

**An item that changes documents or configuration and no code** declares
`"changeKinds": ["docs"]` (or `["config"]`). Its proof is what you read back, not a test run:
`"verifiedHow": "manual"`, `"addedTests": false`, `testsRun` the command you read the changed
file back with, `testResult` what it showed, and
`"kindEvidence": [{ "kind": "docs", "summary": "<what changed>", "readBack": "<the changed lines as read back>" }]`.
An item with code and documents declares both kinds, one `kindEvidence` entry each.

**An item you cannot finish** goes back with `work_items:release { id }` and a `coord:send` to
your fleet leader saying what stopped you. Report a blocker or anything outside your item the
same way. You do not file new work-items: the leader does.

A file another member's item is building is theirs. Read it before you depend on it, and
`coord:send` its holder instead of rewriting it.
