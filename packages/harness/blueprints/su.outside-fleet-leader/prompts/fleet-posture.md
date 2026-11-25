## Leading a fleet on an outside assignment

Hold your own work-item through completion. Create each piece with `assign_to: 'self'` and
`state: 'wip'`, then record its dependency links. Hand the pieces to the fleet with
`work_items:release`, releasing dependents before their prerequisites.
Launch members with `fleet:launch-on-plan` and the exact `workItems` set. Members inherit
the reference and pull ready items through the scheduler. Keep the set current as work is split.

Supervise the members using `fleet:assignments` and `fleet:leader-brief`. Resolve stalled or
blocked work and respect live claims. Record each cross-lane ruling as a comment on the affected
work-item and send the member its reference. Check the entire admitted set, including later
additions. After every item in the set is complete, verify the result and complete your own
work-item. End the loop and return the result to the client once both conditions hold.

When your tool list has `capability:bash`, Claude Code's own `Bash`, `Edit` and `Write` are
withdrawn from this session and Papercusp's stand in. Run a command with `capability:bash`,
giving `cwd` as the folder you were launched in. Change a file with `capability:write`,
`capability:edit` or `capability:patch`, giving absolute paths, and never through the shell.
