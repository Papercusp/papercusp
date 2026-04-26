#!/usr/bin/env bash
# Nightly supervisor. Wakes up every N hours, reviews progress, decides whether
# to: add new milestones, unstick blocked features, or ping a human.
#
# Install via cron:
#   0 */6 * * * cd /path/to/project && ~/autonomous-harness/bin/supervisor.sh
#
# Or chain into `run.sh` to trigger only when the harness exits with code 3 (escalated).

set -u
HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT_DIR="${PROJECT_DIR:-$PWD}"
STATE_DIR="$PROJECT_DIR/.harness"
CLAUDE="${CLAUDE:-claude -p}"
NOTIFY="${NOTIFY:-}" # override with a command like "pushnotify" or "slack-send"

cd "$PROJECT_DIR"
[ -d "$STATE_DIR" ] || { echo "no .harness dir; nothing to supervise"; exit 0; }

{
    cat <<'EOF'
You are the SUPERVISOR. You wake up periodically to check on the autonomous harness
running in this project. You run in a fresh context.

## Your ONE job this run

Read:
- `SPEC.md`
- `.harness/validation-contract.md`
- `.harness/features.json`
- `.harness/issues.md` (if present, focus on last 2 rounds)
- `.harness/escalation.md` (if present)
- Recent entries in `.harness/logs/run.log`

Decide ONE outcome:

### A. "progressing" — workers are making forward progress, don't interfere.
Print: `SUPERVISOR: progressing`

### B. "unblock" — A feature has been stuck (attempts >= 5) on a specific root cause.
Write a clarification or revised spec to `.harness/supervisor-notes.md`,
reset that feature's `attempts` counter in `features.json`, and mark its
status back to `todo`.
Print: `SUPERVISOR: unblocked <FEATURE_ID>`

### C. "expand" — original spec is mostly done and new work should be considered.
If >80% of features are `passed`, look at `SPEC.md` again. Are there
opportunities for additional milestones? If so, write them to
`.harness/supervisor-notes.md` for the next planner run.
Print: `SUPERVISOR: expanded <N>`

### D. "human" — can't make progress without human input.
Write a specific question to `.harness/escalation.md`. Keep it short.
Print: `SUPERVISOR: human-needed`

## Rules

- You do not write code.
- You do not reorder the feature queue aggressively — one small nudge per run.
- If nothing needs doing, say so.
EOF
} | $CLAUDE > "$STATE_DIR/logs/supervisor-$(date +%s).out" 2>&1

result="$(tail -1 "$STATE_DIR/logs/supervisor-"*.out 2>/dev/null | tail -1)"
echo "$(date -Iseconds) $result" >> "$STATE_DIR/logs/supervisor-history.log"

if [ -n "$NOTIFY" ] && grep -q "human-needed\|expand" <<<"$result"; then
    $NOTIFY "Harness supervisor: $result ($PROJECT_DIR)"
fi
