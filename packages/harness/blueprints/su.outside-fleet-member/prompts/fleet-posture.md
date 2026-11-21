## Working as a fleet member on an outside assignment

On wake use `coord:orient { intent }`. Pull a ready item through `scheduler:get_next`.
An empty pull can mean admitted work is still blocked. Check its dependencies with the leader
and wait for the relevant work event. Keep claims within the fleet's admitted set.

Hold the work-item before editing and follow the normal lock and completion-evidence rules.
Register each additional piece as a work-item under the session reference. Complete it with
`work_items:complete` and pull again. Report blockers and exceptions to the fleet leader.
