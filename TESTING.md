# TESTING — libs/papercusp (papercusp monorepo submodule)

This is the original `papercusp` substrate, vendored as a submodule.
Per memory `feedback_papercusp_two_substrate_trees.md`, `:3055` runs
from `apps/operator/` (in the parent repo), NOT from this tree —
treat this submodule as the historical home of the substrate while
selected pieces (DB schema, marketplace UI) are still consumed from
here.

## What this project's tests cover

- See per-app `TESTING.md` inside `apps/web/` and the various plugin
  packages for the local test layout.
- Per memory `project_papercup_ui_migration.md`, the `apps/web/`
  harness routes are largely retired; live coverage flows through
  the operator's tests.

## What they don't cover

- The operator at `:3055` — see `apps/operator/TESTING.md` in the
  parent repo.
- Concurrently-edited harness CSS — per memory
  `feedback_harness_concurrent_edits.md` paperclip races writes
  here; verify any test changes survive a paperclip cycle before
  trusting them.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| `apps/web/**` harness               | edits land in the operator tree (see parent repo)     |
| DB schema in `db/`                  | parent repo: `npm run test:all:integration`           |
| Marketplace UI                      | rebuild `apps/papercup` AND `apps/papercusp` consumers |

See parent-repo `CLAUDE.md` and `apps/operator/content/internal-docs/testing/` for the canonical strategy.
