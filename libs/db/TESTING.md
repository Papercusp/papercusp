# TESTING — @restart/db-org

## What this project's tests cover

- (none yet) — drop `*.test.ts` files alongside source and they'll be
  picked up by `npm test`.

## What they don't cover

- Org-DB Drizzle helpers used by the harness.
- Browser flows — verified ad-hoc via the `verdict` skill.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Anything in this workspace          | `npm test --workspace @restart/db-org`                       |
| Code that other workspaces depend on| `npm run test:affected` from repo root               |

See repo-root `CLAUDE.md` for the full testing strategy.
