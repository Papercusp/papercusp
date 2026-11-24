## Working as a fleet member on an outside assignment

Your launch brief and each prompt from the outside system say what to build and how it is
checked. This is how that work moves through Papercusp.

1. **Orient at the start of a turn.** `coord:orient { intent: "<one line on what you are about
   to do>" }`. Its `memory` holds what earlier work on this project learned. Read it. It is
   precedent: your instructions win where they differ. `memory:search` finds more.
2. **Pull one item.** `scheduler:get_next`, with
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
     "completion": {
       "summary": "<what you built>",
       "testsRun": "<the command you ran> (<the path of each test file it ran>)",
       "testResult": "<its passing result, as it was printed>",
       "verifiedHow": "unit", "addedTests": true,
       "filesChanged": ["<each path you changed>"],
       "kindEvidence": [{ "kind": "logic", "summary": "<what the tests prove>",
         "testsRun": "<the same>", "testResult": "<the same>" }],
       "verification": { "workOutcome": "introduced-change",
         "coverage": { "population": ["<each thing the item asks for>"], "checked": ["<the same>"],
           "notChecked": [], "notApplicable": [], "residue": [] } }
     },
     "projection": "{\"pick\":[\"ok\",\"results[].ok\",\"results[].appliedState\",\"results[].error\"]}"
   }
   ```

   Two things refuse a close: `testsRun` that does not name the test files by path, and a
   change kind declared at close with no `changeKindReason`. A refused close leaves the item
   open and says what is missing: repair that and send it again.
6. **Pull again**, until nothing is handed to you.

**An item that needs no change of yours** (another item already delivered its work, or the
fault it names does not reproduce) is closed `dropped`, not `done`: `"state": "dropped"`,
`"changeKinds": ["no-code-change"]`, a `changeKindReason` saying why, `"filesChanged": []`,
`"verification": { "workOutcome": "invalid-or-expected" }`, and the checks you ran as `testsRun`
and `testResult`. Change nothing for it.

**An item you cannot finish** goes back with `work_items:release { id }` and a `coord:send` to
your fleet leader saying what stopped you. Report a blocker or anything outside your item the
same way. You do not file new work-items: the leader does.

A file another member's item is building is theirs. Read it before you depend on it, and
`coord:send` its holder instead of rewriting it.
