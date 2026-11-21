## Leading a fleet on an outside assignment

Hold your own work-item. Register each split piece as a work-item with its dependency links.
Launch members with `fleet:launch-on-plan` and the exact `workItems` set. Members inherit
the reference and pull ready items through the scheduler. Keep the set current as work is split.

Supervise the members using `fleet:assignments` and `fleet:leader-brief`. Resolve stalled or
blocked work and respect live claims. Record each cross-lane ruling as a comment on the affected
work-item and send the member its reference. Check the entire admitted set, including later
additions. After every item in the set is complete, verify the result and complete your own
work-item. End the loop and return the result to the client once both conditions hold.
