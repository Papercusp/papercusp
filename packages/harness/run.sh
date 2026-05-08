#!/usr/bin/env bash
# Autonomous 3-agent harness driver.
#
# Usage:
#   cd /path/to/your/project
#   ~/autonomous-harness/run.sh
#
# Requires SPEC.md in the current directory. Will create .harness/.
# Override AGENT_CMD (or legacy CLAUDE) to change how agents are invoked
# (defaults to `omp -p`, which routes through Meridian + Claude Max).

set -u
set -o pipefail

HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)}"
PROJECT_DIR="${PROJECT_DIR:-$PWD}"

# Phase 3 / Item 3: source the PG-status helper. All write functions
# (pg_write_status, pg_write_lane, pg_clear_lanes, pg_clear_running)
# live in lib/pg-status.sh next to run.sh, isolating Phase-3 writes
# from the rest of run.sh's lifecycle so paperclip edits to other
# parts don't clobber them.
# shellcheck source=lib/pg-status.sh
if [ -f "$HARNESS_DIR/lib/pg-status.sh" ]; then
    # shellcheck disable=SC1091
    source "$HARNESS_DIR/lib/pg-status.sh"
else
    # Stub the functions so unconditional callers don't break a run.sh
    # that's been deployed before lib/pg-status.sh shipped alongside.
    pg_write_status() { :; }
    pg_write_lane() { :; }
    pg_clear_lanes() { :; }
    pg_clear_running() { :; }
fi
STATE_DIR="$PROJECT_DIR/.harness"
LOG_DIR="$STATE_DIR/logs"

# Phase-aware env. Reads phase from .harness/config.json (default: staging for
# back-compat). Exports HARNESS_PHASE / HARNESS_PORT / HARNESS_DB_PATH so every
# invoke (and the prompts) can see which phase we're in.
if [ -f "$STATE_DIR/config.json" ]; then
    HARNESS_PHASE="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    print(d.get("phase", "staging"))
except Exception:
    print("staging")
' 2>/dev/null)"
    HARNESS_PORT="$(CONFIG="$STATE_DIR/config.json" PHASE="$HARNESS_PHASE" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    phases = d.get("phases", {})
    p = phases.get(os.environ["PHASE"], {})
    print(p.get("port", ""))
except Exception:
    print("")
' 2>/dev/null)"
    HARNESS_DB_PATH="$(CONFIG="$STATE_DIR/config.json" PHASE="$HARNESS_PHASE" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    phases = d.get("phases", {})
    p = phases.get(os.environ["PHASE"], {})
    print(p.get("dbPath", ""))
except Exception:
    print("")
' 2>/dev/null)"
else
    HARNESS_PHASE="staging"
    HARNESS_PORT=""
    HARNESS_DB_PATH=""
fi
export HARNESS_PHASE HARNESS_PORT HARNESS_DB_PATH
# Resolve the slug. Try the operator HTTP API first (canonical — backed by
# harness_shared.harness_registry in PG). Fall back to the legacy
# ~/.restart-harness-projects.json file for harnesses that pre-date the
# workspace migration or when the operator isn't running.
if [ -z "${HARNESS_SLUG:-}" ]; then
    operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    api_resp="$(curl -sf --max-time 3 "${operator_base}/api/harness/projects" 2>/dev/null || true)"
    if [ -n "$api_resp" ]; then
        HARNESS_SLUG="$(printf '%s' "$api_resp" | PD="$PROJECT_DIR" python3 -c '
import json, os, sys
try:
    r = json.load(sys.stdin)
    for p in r.get("projects", []):
        if p.get("path") == os.environ["PD"]:
            print(p.get("slug", "")); sys.exit(0)
except Exception:
    pass
' 2>/dev/null)"
    fi
    if [ -z "$HARNESS_SLUG" ] && [ -f "$HOME/.restart-harness-projects.json" ]; then
        HARNESS_SLUG="$(REG="$HOME/.restart-harness-projects.json" PD="$PROJECT_DIR" python3 -c '
import json, os, sys
try:
    r = json.load(open(os.environ["REG"]))
    for p in r.get("projects", []):
        if p.get("path") == os.environ["PD"]:
            print(p.get("slug", "")); sys.exit(0)
except Exception:
    pass
' 2>/dev/null)"
    fi
    [ -z "$HARNESS_SLUG" ] && HARNESS_SLUG="$(basename "$PROJECT_DIR")"
fi
export HARNESS_SLUG
MAX_ITERATIONS="${MAX_ITERATIONS:-200}"
# Invocation template. `$ROLE` is the role file path; `$PROMPT` is the actual prompt text.
# Default: non-interactive Claude Code with permission prompts disabled (autonomous
# loop can't answer prompts). Override CLAUDE env var to use a different binary or
# add flags. Without --dangerously-skip-permissions, agents that try to curl the
# operator API (expert, feedback, validator's POST flows) will hang on permission
# prompts that nobody can answer.
# Agent invocation template. Prefer the new $AGENT_CMD env (which is
# backend-neutral — point at `claude -p`, `omp -p`, or any wrapper); fall
# back to legacy $CLAUDE for back-compat with existing harness installs.
# $AGENT_BACKEND ('claude-code' | 'omp') selects the structured-stream
# format we append; default is 'omp' since omp routes through Meridian
# and the user's Claude Max subscription, avoiding direct API quotas.
#
# When the user has set /settings/agent in the operator UI, the operator
# mirrors AGENT_BACKEND/AGENT_CMD/AGENT_MODELS into a shell-sourceable
# file. Source it here so headless `run.sh` invocations from the user's
# terminal pick up the same toggle the operator process uses. Inline env
# (e.g. `AGENT_CMD=... ./run.sh`) still wins because the source happens
# before the parameter expansions below.
if [ -z "${AGENT_CMD:-}" ] && [ -z "${AGENT_BACKEND:-}" ]; then
    if [ -f "$HOME/.papercusp/agent/env.sh" ]; then
        # shellcheck disable=SC1091
        . "$HOME/.papercusp/agent/env.sh"
    fi
fi
CLAUDE="${AGENT_CMD:-${CLAUDE:-omp -p}}"
AGENT_BACKEND="${AGENT_BACKEND:-}"
if [ -z "$AGENT_BACKEND" ]; then
    case "$CLAUDE" in
        omp*|*/omp*|pi*|*/pi*) AGENT_BACKEND=omp ;;
        claude*|*/claude*) AGENT_BACKEND=claude-code ;;
        *) AGENT_BACKEND=omp ;;
    esac
fi
export CLAUDE AGENT_BACKEND

cd "$PROJECT_DIR"

# harness_kind:'org' parent harnesses don't need a SPEC.md (they use
# .harness/validation-contract.md instead). Coding/department harnesses
# still require SPEC.md.
HARNESS_KIND="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    print(d.get("harness_kind", ""))
except Exception:
    print("")
' 2>/dev/null)"

if [ "$HARNESS_KIND" != "org" ] && [ "$HARNESS_KIND" != "department" ] && [ ! -f SPEC.md ]; then
    echo "ERROR: $PROJECT_DIR/SPEC.md not found." >&2
    echo "       Copy $HARNESS_DIR/templates/SPEC.md.template to SPEC.md and edit." >&2
    echo "       (Parent + department harnesses skip this check via harness_kind in config.json.)" >&2
    exit 1
fi

mkdir -p "$STATE_DIR" "$LOG_DIR"

# Structured JSONL companion to run.log. Each line is a single LogEvent
# {ts, source, level, msg, corrId?, attrs?}. Plugin host + operator UI
# consume this for filtering/tabs/search; run.log is kept for human tail.
LOG_JSONL="$LOG_DIR/run.log.jsonl"

# Rotation cap (bytes) for run.log.jsonl. Override with PAPERCUSP_LOG_ROTATE_BYTES.
# Default 50 MiB — enough for a multi-day mission, small enough that gzipped
# rotations don't pile up.
LOG_ROTATE_BYTES="${PAPERCUSP_LOG_ROTATE_BYTES:-52428800}"
LOG_ROTATE_KEEP="${PAPERCUSP_LOG_ROTATE_KEEP:-5}"

# Probe the JSONL file size; if past the cap, rotate to .1.gz and start
# a fresh empty file. Older rotations are renumbered .1 → .2, .2 → .3, …
# up to LOG_ROTATE_KEEP. Cheaper than logrotate(8) and avoids depending
# on a system service.
_log_rotate_if_needed() {
    [ -f "$LOG_JSONL" ] || return 0
    local size
    size=$(stat -c '%s' "$LOG_JSONL" 2>/dev/null || stat -f '%z' "$LOG_JSONL" 2>/dev/null || echo 0)
    [ "$size" -lt "$LOG_ROTATE_BYTES" ] && return 0
    # Cycle .N-1 → .N from highest down (so we don't overwrite live data).
    local i=$((LOG_ROTATE_KEEP - 1))
    while [ "$i" -gt 0 ]; do
        if [ -f "$LOG_JSONL.$i.gz" ]; then
            mv -f "$LOG_JSONL.$i.gz" "$LOG_JSONL.$((i + 1)).gz"
        fi
        i=$((i - 1))
    done
    # Move current → .1, then gzip in background. Doing the gzip async
    # keeps the next log() call from blocking on a multi-MB compress.
    mv -f "$LOG_JSONL" "$LOG_JSONL.1"
    ( gzip -f "$LOG_JSONL.1" 2>/dev/null & )
    # Drop anything past KEEP.
    i=$((LOG_ROTATE_KEEP + 1))
    while [ -f "$LOG_JSONL.$i.gz" ]; do
        rm -f "$LOG_JSONL.$i.gz"
        i=$((i + 1))
    done
}

# Append a single JSONL event. Keeps run.sh's only python3 dep (already
# used elsewhere in this file) for safe JSON encoding of the message —
# bash's `printf %q` doesn't escape control chars correctly for JSON.
_log_jsonl() {
    local source="$1"; local level="$2"; local msg="$3"; local ts="$4"
    _log_rotate_if_needed
    SRC="$source" LEVEL="$level" MSG="$msg" TS="$ts" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "ts": os.environ["TS"],
    "source": os.environ["SRC"],
    "level": os.environ["LEVEL"],
    "msg": os.environ["MSG"],
}) + "\n")
' >> "$LOG_JSONL" 2>/dev/null || true
}

# Classify a log message into a level by looking for known patterns.
# Mirrors classifyLine() in libs/ui-primitives/src/LogView.tsx so the
# server-side classification matches what the legacy text-driven UI
# does. Once the UI is purely JSONL-driven this can move to a single
# shared definition.
_log_level() {
    local msg="$1"
    case "$msg" in
        *ERROR*|*FATAL*|*Aborting*|*Traceback*) printf 'error' ;;
        *WARN*|*Warning*)                       printf 'warn' ;;
        *"ORCH decision:"*)                     printf 'decision' ;;
        "── iteration "*"──"*)                  printf 'iteration' ;;
        "PLAN:"*)                               printf 'plan' ;;
        *)                                       printf 'info' ;;
    esac
}

log() {
    local ts
    ts="$(date -Iseconds)"
    local raw_line; raw_line="$(printf '[%s] %s' "$ts" "$*")"
    printf '%s\n' "$raw_line" | tee -a "$LOG_DIR/run.log"
    _log_jsonl "harness" "$(_log_level "$*")" "$*" "$ts"
    _post_log_event "$raw_line" "$(_log_level "$*")" "$*" "$ts" &
}

# POST one log line to the operator's in-process log bus so SSE
# subscribers (HarnessDashboard log panel + raw run.log tail) see it
# without waiting for fs.watch + 5s re-stat. Runs in background so
# bash never blocks on curl latency. Silently no-ops if curl/jq are
# unavailable, the operator is unreachable, or no harness_token is set
# (CLI fallback). Used in tandem with the existing tee/_log_jsonl
# writes — those are still authoritative on disk for backfill.
_post_log_event() {
    local raw_line="$1"; local level="$2"; local msg="$3"; local ts="$4"
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local harness_token=""
    if [ -f "$HARNESS_DIR/config.json" ]; then
        harness_token="$(jq -r '.harness_token // empty' "$HARNESS_DIR/config.json" 2>/dev/null || true)"
    fi
    [ -z "$harness_token" ] && return 0
    local jsonl_line
    jsonl_line="$(SRC="harness" LEVEL="$level" MSG="$msg" TS="$ts" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({
    "ts": os.environ["TS"],
    "source": os.environ["SRC"],
    "level": os.environ["LEVEL"],
    "msg": os.environ["MSG"],
}))
' 2>/dev/null)" || return 0
    local body
    body="$(LOG="$jsonl_line" RAW="$raw_line" python3 -c '
import json, os, sys
sys.stdout.write(json.dumps({"log": os.environ["LOG"], "raw": os.environ["RAW"]}))
' 2>/dev/null)" || return 0
    curl -sS -X POST -H 'content-type: application/json' \
        -H "Authorization: Bearer $harness_token" \
        --max-time 2 \
        -d "$body" "$operator_base/api/internal/log-event" >/dev/null 2>&1 || true
}

config_get() {
    # config_get <dotted-path> [default]
    # Reads .harness/config.json via python3. Missing path or missing file → default.
    local path="$1"; local default="${2:-}"
    if [ ! -f "$STATE_DIR/config.json" ]; then
        printf '%s' "$default"
        return 0
    fi
    CONFIG_PATH="$path" DEFAULT="$default" CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os, sys
try:
    d = json.load(open(os.environ["CONFIG"]))
    cur = d
    for p in os.environ["CONFIG_PATH"].split("."):
        cur = cur[p]
    # json booleans/numbers → python; we print the string form
    if isinstance(cur, bool):
        print("true" if cur else "false")
    else:
        print(cur)
except Exception:
    print(os.environ["DEFAULT"])
' 2>/dev/null
}

branch_iso_enabled() {
    [ "$(config_get 'branchIsolation.enabled' 'false')" = "true" ]
}

# Composio-inspired: use git worktrees instead of switching branches in the
# main project dir. Each parallel lane gets its own .harness/worktrees/<fid>
# filesystem directory, so workers don't trip over each other.
worktree_enabled() {
    branch_iso_enabled && [ "$(config_get 'branchIsolation.useWorktrees' 'false')" = "true" ]
}

worktree_path_for() {
    # Echo the worktree path for a given feature id.
    local fid="$1"
    echo "$STATE_DIR/worktrees/$fid"
}

worktree_pre_worker() {
    # Create a new worktree on branch harness/<fid> off baseBranch.
    worktree_enabled || return 0
    local fid="$1"
    local base; base="$(branch_iso_base)"
    local wt; wt="$(worktree_path_for "$fid")"
    local br="harness/$fid"
    mkdir -p "$STATE_DIR/worktrees"
    if [ -d "$wt" ]; then
        log "  worktree: $wt already exists (worker retry)"
        return 0
    fi
    ( cd "$PROJECT_DIR" && {
        git worktree add -B "$br" "$wt" "$base" 2>&1 | head -3
    } )
    log "  worktree: lane $wt (branch $br, off $base)"
}

worktree_post_worker() {
    # Commit staged changes in the worktree.
    worktree_enabled || return 0
    local fid="$1"
    local wt; wt="$(worktree_path_for "$fid")"
    [ -d "$wt" ] || return 0
    ( cd "$wt" && {
        git add -A
        if ! git diff --cached --quiet; then
            git commit --quiet -m "worker: $fid" 2>&1 | head -3
        fi
    } )
}

worktree_post_validator() {
    # On PASS: merge worktree branch into base, remove worktree.
    # On FAIL: keep worktree (worker will retry in it).
    worktree_enabled || return 0
    local fid="$1"
    local wt; wt="$(worktree_path_for "$fid")"
    [ -d "$wt" ] || return 0
    local status
    status="$(features_json | FID="$fid" python3 -c '
import json, sys, os
fid = os.environ["FID"]
for f in json.load(sys.stdin):
    if f.get("id") == fid:
        print(f.get("status", "")); break
' 2>/dev/null)"
    if [ "$status" != "passed" ]; then
        return 0
    fi
    local base; base="$(branch_iso_base)"
    local br="harness/$fid"
    local on_pass; on_pass="$(config_get 'branchIsolation.onPass' 'merge')"
    case "$on_pass" in
    merge)
        ( cd "$PROJECT_DIR" && {
            git checkout "$base" 2>&1 | head -2
            git merge --no-ff "$br" -m "merge harness/$fid" 2>&1 | head -5
            git worktree remove --force "$wt" 2>&1 | head -2
            git branch -D "$br" 2>/dev/null
        } )
        log "  worktree: merged $br into $base; removed $wt"
        ;;
    keep)
        log "  worktree: onPass=keep; $wt retained on branch $br"
        ;;
    pr)
        # Push + open PR via gh, then remove worktree (branch stays remote).
        if command -v gh >/dev/null 2>&1; then
            ( cd "$wt" && git push -u origin "$br" 2>&1 | head -3 )
            ( cd "$PROJECT_DIR" && gh pr create --head "$br" --base "$base" --title "harness: $fid" --body "Autogenerated by harness." 2>&1 | head -3 )
            ( cd "$PROJECT_DIR" && git worktree remove --force "$wt" 2>&1 | head -2 )
        else
            log "  worktree: onPass=pr but gh not found — leaving $wt in place"
        fi
        ;;
    esac
}

worktree_reset() {
    # On status reset (feature set back to todo): discard the worktree.
    worktree_enabled || return 0
    local fid="$1"
    local wt; wt="$(worktree_path_for "$fid")"
    [ -d "$wt" ] || return 0
    ( cd "$PROJECT_DIR" && {
        git worktree remove --force "$wt" 2>&1 | head -2
        git branch -D "harness/$fid" 2>/dev/null
    } )
    log "  worktree: reset removed $wt"
}

branch_iso_base() {
    local b; b="$(config_get 'branchIsolation.baseBranch' '')"
    if [ -z "$b" ]; then
        # Auto-detect: try `main` then `master`.
        if ( cd "$PROJECT_DIR" && git show-ref --quiet refs/heads/main ); then
            b="main"
        elif ( cd "$PROJECT_DIR" && git show-ref --quiet refs/heads/master ); then
            b="master"
        else
            b="main"
        fi
    fi
    printf '%s' "$b"
}

branch_iso_pre_worker() {
    branch_iso_enabled || return 0
    if worktree_enabled; then
        worktree_pre_worker "$FEATURE_ID"
        return 0
    fi
    local base; base="$(branch_iso_base)"
    local br="harness/$FEATURE_ID"
    ( cd "$PROJECT_DIR" && {
        git checkout -B "$br" "$base" 2>/dev/null ||
        git checkout -B "$br" 2>/dev/null
    } )
    log "  branch-iso: worker on $br (off $base)"
}

branch_iso_post_worker() {
    branch_iso_enabled || return 0
    if worktree_enabled; then
        worktree_post_worker "$FEATURE_ID"
        return 0
    fi
    ( cd "$PROJECT_DIR" && {
        git add -A
        if ! git diff --cached --quiet; then
            git commit --quiet -m "worker: $FEATURE_ID" 2>&1 | head -3
        fi
    } )
}

branch_iso_pre_validator() {
    branch_iso_enabled || return 0
    if worktree_enabled; then
        # Worktrees don't need branch switching; the validator just reads
        # from the worktree path. The invoke wrapper sets WORKER_CWD for this.
        local wt; wt="$(worktree_path_for "$FEATURE_ID")"
        if [ -d "$wt" ]; then
            log "  worktree: validator on $wt"
        else
            log "  worktree: validator — no worktree for $FEATURE_ID (falling through to main tree)"
        fi
        return 0
    fi
    local br="harness/$FEATURE_ID"
    ( cd "$PROJECT_DIR" && git checkout "$br" 2>/dev/null ) && \
        log "  branch-iso: validator on $br" || \
        log "  branch-iso: branch $br not found (validator will use current)"
}

branch_iso_post_validator() {
    branch_iso_enabled || return 0
    if worktree_enabled; then
        worktree_post_validator "$FEATURE_ID"
        return 0
    fi
    local status
    status="$(features_json | FID="$FEATURE_ID" python3 -c '
import json, sys, os
fid = os.environ["FID"]
for f in json.load(sys.stdin):
    if f.get("id") == fid:
        print(f.get("status", "")); break
' 2>/dev/null)"
    if [ "$status" != "passed" ]; then
        return 0
    fi
    local base; base="$(branch_iso_base)"
    local br="harness/$FEATURE_ID"
    local on_pass; on_pass="$(config_get 'branchIsolation.onPass' 'merge')"

    case "$on_pass" in
    pr)
        # Push branch + open PR via gh cli. Leave branch unmerged.
        if ! command -v gh >/dev/null 2>&1; then
            log "  branch-iso: onPass=pr but gh cli not found — leaving branch unmerged"
            return 0
        fi
        local title
        title="$(features_json | FID="$FEATURE_ID" python3 -c '
import json, sys, os
fid = os.environ["FID"]
for f in json.load(sys.stdin):
    if f.get("id") == fid:
        print(f.get("title", fid)); break
else:
    print(fid)
' 2>/dev/null)"
        local pr_url pr_out
        pr_out="$( cd "$PROJECT_DIR" && {
            git push -u origin "$br" 2>&1
            gh pr create \
                --base "$base" \
                --head "$br" \
                --title "$FEATURE_ID: $title" \
                --body "Automated PR from harness. Feature passed validation on $(date -Iseconds)." \
                2>&1
        } )"
        # Extract the first URL-looking line from gh's stdout (last line is typically the PR URL)
        pr_url="$(printf '%s\n' "$pr_out" | grep -oE 'https?://[^ ]+/pull/[0-9]+' | tail -1)"
        if [ -n "$pr_url" ]; then
            log "  branch-iso: onPass=pr — opened $pr_url"
            # Persist url into .harness/prs.json keyed by feature id (atomic)
            FID="$FEATURE_ID" URL="$pr_url" STATE_DIR="$STATE_DIR" python3 -c '
import json, os, tempfile
p = os.path.join(os.environ["STATE_DIR"], "prs.json")
try:
    d = json.load(open(p))
except Exception:
    d = {"prs": {}}
d.setdefault("prs", {})[os.environ["FID"]] = {
    "url": os.environ["URL"],
    "created_at": __import__("time").time(),
}
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(p))
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2)
os.replace(tmp, p)
' 2>/dev/null
        else
            log "  branch-iso: onPass=pr — gh pr create did not return a URL (output tail follows)"
            printf '%s\n' "$pr_out" | tail -5 | sed 's/^/    /' | tee -a "$LOG_DIR/run.log"
        fi
        ;;
    keep)
        log "  branch-iso: onPass=keep — leaving $br unmerged"
        ;;
    merge|*)
        ( cd "$PROJECT_DIR" && {
            git checkout "$base" 2>/dev/null &&
            git merge --no-ff "$br" -m "merge: $FEATURE_ID passed" 2>&1 | head -5
        } ) && log "  branch-iso: merged $br → $base"
        ;;
    esac
}

feature_set_status() {
    # feature_set_status <feature-id> <status>
    # Layer A/B (2026-04-26): writes go through API → SQL (canonical store).
    # API-first; psql fallback if web is down.
    local fid="$1" status="$2"
    local slug; slug="$(harness_slug)"
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local api_url="${operator_base}/api/harness/$slug/features/$fid"
    if curl -sf -X PATCH -H 'content-type: application/json' --max-time 5 \
        -H "x-actor: run.sh" \
        -d "{\"status\": \"$status\"}" "$api_url" > /dev/null 2>&1; then
        return 0
    fi
    # Fallback: direct psql update (no audit trail without API).
    local schema; schema="harness_${slug//-/_}"
    if command -v psql >/dev/null 2>&1; then
        PGPASSWORD="${HARNESS_APP_PWD:-harness_app_pwd}" \
        PGOPTIONS="-c search_path=${schema},harness_shared,public" \
        psql -U "${HARNESS_APP_USER:-harness_app}" -h "${PGHOST:-localhost}" \
             -d "${HARNESS_PG_DB:-papercusp}" -q \
             -c "UPDATE harness_features SET status = '$(printf '%s' "$status" | sed "s/'/''/g")', updated_ts = $(date +%s)000 WHERE feature_id = '$(printf '%s' "$fid" | sed "s/'/''/g")'" 2>/dev/null
        return 0
    fi
    log "  WARN: feature_set_status $fid → $status: both API and psql unavailable"
    return 1
}

parallel_max_workers() {
    config_get 'parallelWorkers.max' '1'
}

lanes_count() {
    # Counts still-alive lanes, reaping dead PIDs as a side effect.
    [ -f "$STATE_DIR/lanes.json" ] || { echo '{"lanes":[]}' > "$STATE_DIR/lanes.json"; }
    STATE_DIR="$STATE_DIR" python3 -c '
import json, os
p = os.path.join(os.environ["STATE_DIR"], "lanes.json")
d = json.load(open(p))
alive = []
for l in d["lanes"]:
    try:
        os.kill(l["pid"], 0)
        alive.append(l)
    except OSError:
        pass
d["lanes"] = alive
tmp = p + ".tmp"
json.dump(d, open(tmp, "w"), indent=2)
os.replace(tmp, p)
print(len(alive))
'
}

lanes_add() {
    # lanes_add <pid> <feature-id>
    local pid="$1" fid="$2"
    PID="$pid" FID="$fid" STATE_DIR="$STATE_DIR" python3 -c '
import json, os, time
p = os.path.join(os.environ["STATE_DIR"], "lanes.json")
if not os.path.exists(p):
    open(p, "w").write("{\"lanes\":[]}")
d = json.load(open(p))
d["lanes"].append({"pid": int(os.environ["PID"]), "feature_id": os.environ["FID"], "started_at": int(time.time())})
tmp = p + ".tmp"
json.dump(d, open(tmp, "w"), indent=2)
os.replace(tmp, p)
'
}

lanes_wait_all() {
    # Block until every lane's PID has exited. Used before validator runs.
    [ -f "$STATE_DIR/lanes.json" ] || return 0
    local count
    while true; do
        count="$(lanes_count)"
        [ "$count" -eq 0 ] && break
        log "  parallel: waiting on $count worker lane(s)…"
        sleep 3
    done
}

wip_checkpoint_start() {
    # wip_checkpoint_start <feature_id>
    # Starts a background loop that `git commit -am "WIP: <fid> <ts>"` every
    # wipCheckpoint.intervalSeconds (default 300). Prints its own PID to stdout.
    # Only runs if wipCheckpoint.enabled = true AND branch_iso is active (otherwise
    # would pollute the main branch).
    [ "$(config_get 'wipCheckpoint.enabled' 'false')" = "true" ] || { echo 0; return 0; }
    [ "$(config_get 'branchIsolation.enabled' 'false')" = "true" ] || { echo 0; return 0; }
    local fid="$1"
    local interval="$(config_get 'wipCheckpoint.intervalSeconds' '300')"
    (
        while true; do
            sleep "$interval"
            ( cd "$PROJECT_DIR" && git diff --quiet && git diff --cached --quiet ) && continue
            ( cd "$PROJECT_DIR" && git add -A && git commit --quiet -m "WIP: $fid $(date +%s)" ) 2>/dev/null || true
        done
    ) &
    echo $!
}

wip_checkpoint_stop() {
    # wip_checkpoint_stop <pid>
    local pid="$1"
    [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null && kill "$pid" 2>/dev/null
}

extract_proposal_bullets() {
    # extract_proposal_bullets <proposal-file>
    # Heuristic: pulls "Acceptance bar" bullet lists out of a scoper proposal
    # markdown. Prints to stdout (one bullet per line, "- "-prefixed). Empty
    # output if nothing found.
    PROPOSAL="$1" python3 -c '
import os, re, sys
p = os.environ["PROPOSAL"]
src = open(p).read()
out_lines = []
lines = src.split("\n")
in_bar = False
for ln in lines:
    if re.match(r"^\s*[-*\d]+.*\*\*Acceptance bar\*\*", ln) or ("Acceptance bar" in ln and "**" in ln):
        in_bar = True
        continue
    if in_bar:
        if ln.startswith("- ") or ln.startswith("  - "):
            out_lines.append(ln.lstrip())
        elif ln.strip() == "":
            continue
        elif ln.startswith("**") or ln.startswith("###") or ln.startswith("##"):
            in_bar = False
if out_lines:
    print("\n".join("- " + l.lstrip("- ") for l in out_lines))
' 2>/dev/null
}

apply_proposal_to_spec() {
    # apply_proposal_to_spec <proposal-file>
    # Extracts bullets, appends them to SPEC.md with a marker comment, and
    # marks the proposal file as applied. Returns 0 on success, 1 if nothing
    # was applicable.
    #
    # Each early-return path logs why — silent skips here used to leave
    # proposals stuck in pending+verdict=accept state that looked like
    # "auto-accepted" in the UI even though nothing landed in SPEC.md.
    local proposal="$1"
    if [ -z "$proposal" ]; then
        log "  apply: empty proposal arg — skipping"
        return 1
    fi
    if [ ! -f "$proposal" ]; then
        log "  apply: proposal file '$proposal' not found — skipping"
        return 1
    fi
    if [ ! -f "$PROJECT_DIR/SPEC.md" ]; then
        log "  apply: $PROJECT_DIR/SPEC.md not found — cannot append acceptance bullets"
        return 1
    fi

    local extracted
    extracted="$(extract_proposal_bullets "$proposal")"
    if [ -z "$extracted" ]; then
        log "  apply: no acceptance bullets extracted from $(basename "$proposal") — proposal stays pending. Inspect: missing **Acceptance bar** section, or bullets formatted unexpectedly."
        return 1
    fi
    {
        echo
        echo "<!-- auto-applied from $(basename "$proposal") at $(date -Iseconds) (reviewer-approved) -->"
        echo "$extracted"
    } >> "$PROJECT_DIR/SPEC.md"
    local n; n="$(printf '%s\n' "$extracted" | grep -c '^-' || echo 0)"
    log "  apply: appended $n acceptance bullet(s) to SPEC.md from $(basename "$proposal")"
    {
        echo "---"
        echo "applied: true"
        echo "appliedAt: $(date -Iseconds)"
    } >> "$proposal"
    return 0
}

review_pending_proposals() {
    # review_pending_proposals
    # Walks .harness/proposals/, finds files that have not yet been reviewed
    # (no sibling .review.md), and invokes the consolidated `reviewer` role in
    # MODE=proposal for each. On VERDICT: accept it auto-applies the proposal
    # to SPEC.md. On VERDICT: reject or defer it leaves the proposal pending
    # with the review beside it. If anything was accepted, runs the scoper in
    # MODE=replan to fold the new bullets into features.json + the contract.
    local dir="$STATE_DIR/proposals"
    [ -d "$dir" ] || return 0
    local accepted_count=0

    for proposal in "$dir"/*.md; do
        [ -f "$proposal" ] || continue
        # Skip review files themselves
        case "$proposal" in *.review.md) continue ;; esac
        # Skip already-applied proposals
        if grep -q "^applied: true" "$proposal" 2>/dev/null; then
            continue
        fi
        # Short-circuit `NOTHING_MORE` proposals — these are scoper output
        # that explicitly declares no new features to add. Sending them
        # through reviewer wastes a token round-trip, and the historical
        # behavior was for reviewer to verdict=accept (agreeing nothing
        # was needed) and then apply to fail with "0 bullets," leaving
        # the proposal stuck in pending+verdict=accept forever. Mark
        # them applied directly so the UI doesn't dangle them.
        if grep -qE "^\s*NOTHING_MORE\s*$" "$proposal" 2>/dev/null; then
            log "  reviewer: $(basename "$proposal") declares NOTHING_MORE — marking applied (no bullets to land in SPEC.md)"
            {
                echo "---"
                echo "applied: true"
                echo "appliedAt: $(date -Iseconds)"
                echo "appliedReason: nothing_more"
            } >> "$proposal"
            continue
        fi
        local review="${proposal%.md}.review.md"
        if [ -f "$review" ]; then
            # Already reviewed — respect prior verdict, don't re-invoke
            continue
        fi

        log "  reviewer: judging $(basename "$proposal")"
        PROPOSAL_FILE="$proposal" \
            invoke reviewer "MODE=proposal" "PROPOSAL_FILE=$proposal" > /dev/null

        # Reviewer writes its analysis to <basename>.review.md. Verdict is
        # the last `VERDICT:` line in that file.
        if [ ! -f "$review" ]; then
            log "  reviewer: no review file produced for $(basename "$proposal") — leaving pending"
            continue
        fi
        local verdict_line; verdict_line="$(grep -iE '^VERDICT:' "$review" | tail -1)"
        log "  reviewer: $(basename "$proposal") → ${verdict_line:-no verdict}"

        case "$verdict_line" in
            *[Aa]ccept*)
                if apply_proposal_to_spec "$proposal"; then
                    log "  reviewer: auto-accepted $(basename "$proposal")"
                    accepted_count=$((accepted_count + 1))
                else
                    # Verdict says accept but apply couldn't run. The
                    # apply_proposal_to_spec call above already logged
                    # the specific reason; add a top-level summary so
                    # it's obvious the verdict didn't take effect.
                    log "  reviewer: VERDICT=accept on $(basename "$proposal") but apply skipped — proposal will show 'reviewer: accept (not applied)' in the UI until you apply it manually or fix the cause"
                fi
                ;;
            *[Rr]eject*|*[Dd]efer*)
                # Leave the proposal pending; review is alongside.
                ;;
            *)
                log "  reviewer: unparsable verdict for $(basename "$proposal") — leaving pending"
                ;;
        esac
    done

    # Close the loop: if any proposal was applied, fold the new SPEC bullets
    # into features.json + validation-contract.md so the next harness loop
    # iteration actually has work to pick up.
    if [ "$accepted_count" -gt 0 ]; then
        # Default true: accept means accept. The unified MODE=replan path
        # is non-destructive (delta-merge into the existing queue), so
        # there's no reason to gate it. Set explicitly to false to opt out.
        # Legacy product.replanOnAccept is still honored when set.
        local replan_on_accept
        replan_on_accept="$(config_get 'reviewer.replanOnAccept' '')"
        if [ -z "$replan_on_accept" ]; then
            replan_on_accept="$(config_get 'product.replanOnAccept' 'true')"
        fi
        if [ "$replan_on_accept" != "false" ]; then
            log "  reviewer: $accepted_count proposal(s) accepted — invoking scoper (MODE=replan)"
            local replan_out
            replan_out="$(invoke scoper "MODE=replan")"
            local replan_decision
            replan_decision="$(printf '%s\n' "$replan_out" | grep -E '^(REPLANNED|REPLAN_NOOP)' | tail -1)"
            log "  reviewer: replan → ${replan_decision:-no decision line}"
        else
            log "  reviewer: $accepted_count proposal(s) accepted — replanOnAccept disabled, leaving features.json untouched"
        fi
    fi
}

fire_plugin_hook() {
    # fire_plugin_hook <hook-name> [extra-flags...]
    #
    # Discovers plugins reachable for the current project and invokes the
    # named lifecycle hook on each via the papercusp-fire-hook CLI.
    # Each plugin runs in its own child process — a misbehaving plugin
    # cannot crash the harness loop. Failures are logged and ignored.
    #
    # Search paths (priority order):
    #   1. $PROJECT_DIR/plugins/<name>/
    #   2. ~/.papercusp/harnesses/<each>/plugins/<name>/
    #   3. ~/.papercusp/global-plugins/<name>/
    #
    # Hook names: afterDone | beforeMissionStart | onProposalAccepted | onFeaturePassed
    local hook_name="$1"; shift
    [ -z "$hook_name" ] && return 0

    # Locate the fire-hook CLI. Prefer the workspace-installed bin; fall
    # back to running the .ts script directly.
    local fire_hook_cli=""
    if command -v papercusp-fire-hook >/dev/null 2>&1; then
        fire_hook_cli="papercusp-fire-hook"
    elif [ -x "$HARNESS_DIR/../packages/papercusp-plugin-loader/bin/fire-hook" ]; then
        # Legacy in-tree layout (libs/papercusp/packages/...).
        fire_hook_cli="$HARNESS_DIR/../packages/papercusp-plugin-loader/bin/fire-hook"
    elif [ -x "$HARNESS_DIR/../../../../packages/plugin-loader/bin/fire-hook" ]; then
        # Post-2026-04-28 split layout: harness at
        # papercup/libs/papercusp/packages/harness/, loader at
        # papercup/packages/plugin-loader/.
        fire_hook_cli="$HARNESS_DIR/../../../../packages/plugin-loader/bin/fire-hook"
    fi
    if [ -z "$fire_hook_cli" ]; then
        log "  plugins: papercusp-fire-hook CLI not found — skipping hook=$hook_name"
        return 0
    fi

    local project_slug="$(harness_slug 2>/dev/null || echo unknown)"
    local seen=" "
    local fired=0
    local skipped=0
    local errored=0

    fire_one() {
        local plugin_dir="$1"
        local manifest="$plugin_dir/papercusp.json"
        [ -f "$manifest" ] || return 0
        local name; name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("name", ""))' "$manifest" 2>/dev/null)"
        [ -z "$name" ] && return 0
        case "$seen" in *" $name "*) return 0 ;; esac
        seen="$seen$name "
        log "  plugin $name@$hook_name from $plugin_dir"
        if "$fire_hook_cli" "$hook_name" "$plugin_dir" \
            --project-slug="$project_slug" \
            --project-dir="$PROJECT_DIR" \
            --state-dir="$STATE_DIR" \
            "$@" >> "$LOG_DIR/plugins.log" 2>&1; then
            fired=$((fired + 1))
        else
            local rc=$?
            if [ "$rc" -eq 0 ]; then
                fired=$((fired + 1))
            else
                log "  plugin $name $hook_name → rc=$rc (see $LOG_DIR/plugins.log)"
                errored=$((errored + 1))
            fi
        fi
    }

    # 1. Project plugins.
    if [ -d "$PROJECT_DIR/plugins" ]; then
        for d in "$PROJECT_DIR"/plugins/*/; do
            [ -d "$d" ] && fire_one "${d%/}"
        done
    fi
    # 2. Per-installed-harness plugins (deduped by plugin name).
    if [ -d "$HOME/.papercusp/harnesses" ]; then
        for harness_dir in "$HOME"/.papercusp/harnesses/*/; do
            local pdir="${harness_dir%/}/plugins"
            [ -d "$pdir" ] || continue
            for d in "$pdir"/*/; do
                [ -d "$d" ] && fire_one "${d%/}"
            done
        done
    fi
    # 3. Global plugins.
    if [ -d "$HOME/.papercusp/global-plugins" ]; then
        for d in "$HOME"/.papercusp/global-plugins/*/; do
            [ -d "$d" ] && fire_one "${d%/}"
        done
    fi

    if [ $fired -gt 0 ] || [ $errored -gt 0 ]; then
        log "  plugins: $hook_name → fired=$fired errored=$errored"
    fi
    return 0
}

auto_screenshot_post_worker() {
    # auto_screenshot_post_worker
    # If .harness/config.json has autoScreenshot.enabled=true and a URL, captures
    # a screenshot via `verdict` into .harness/screenshots/<FEATURE_ID>-<ts>.png.
    # Silently no-ops if disabled, URL missing, or verdict unavailable.
    [ "$(config_get 'autoScreenshot.enabled' 'false')" = "true" ] || return 0
    local url; url="$(config_get 'autoScreenshot.url' '')"
    [ -z "$url" ] && return 0
    if ! command -v verdict >/dev/null 2>&1; then
        log "  auto-screenshot: verdict not installed — skipping"
        return 0
    fi
    mkdir -p "$STATE_DIR/screenshots"
    local ts; ts="$(date +%s)"
    local out="$STATE_DIR/screenshots/${FEATURE_ID}-${ts}.png"
    ( verdict goto "$url" >/dev/null 2>&1 && \
      verdict screenshot "$out" >/dev/null 2>&1 ) && \
        log "  auto-screenshot: saved $(basename "$out")" || \
        log "  auto-screenshot: capture failed for $url"
}

notify_event() {
    # notify_event <event-kind> <message>
    # Fires $NOTIFY if set. event-kind is one of: done, escalate, cost-cap, max-iter.
    # $NOTIFY is run as: $NOTIFY "<event-kind>" "<message>" "<project-dir>"
    # Any failure is logged but doesn't halt the mission.
    local kind="$1"; shift
    local msg="$*"
    [ -z "${NOTIFY:-}" ] && return 0
    log "NOTIFY $kind: $msg"
    ( $NOTIFY "$kind" "$msg" "$PROJECT_DIR" ) >/dev/null 2>&1 || log "  NOTIFY command failed (rc=$?)"
}

check_cost_cap() {
    # check_cost_cap
    # Sums total_cost_usd across all .jsonl files in $LOG_DIR. If .harness/config.json
    # has maxCostUsd and the total exceeds it, exits with code 6.
    # Emits "COST total=$X.XX cap=$Y" to the run log regardless.
    local cap=""
    if [ -f "$STATE_DIR/config.json" ]; then
        cap="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    c = json.load(open(os.environ["CONFIG"]))
    v = c.get("maxCostUsd")
    if isinstance(v, (int, float)) and v > 0:
        print(v)
except Exception:
    pass
' 2>/dev/null)"
    fi
    local total
    total="$(LOG_DIR="$LOG_DIR" python3 -c '
import glob, json, os
total = 0.0
for f in glob.glob(os.path.join(os.environ["LOG_DIR"], "*.jsonl")):
    try:
        with open(f) as fh:
            last_result = None
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                    if obj.get("type") == "result":
                        last_result = obj
                except Exception:
                    pass
            if last_result is not None:
                total += last_result.get("total_cost_usd", 0) or 0
    except Exception:
        pass
print(f"{total:.4f}")
' 2>/dev/null)"

    if [ -z "$total" ]; then
        return 0
    fi
    if [ -n "$cap" ]; then
        log "$(printf '  COST total=$%s cap=$%s' "$total" "$cap")"
        # bash can't compare floats; use python
        local over
        over="$(python3 -c "print(1 if float('$total') >= float('$cap') else 0)" 2>/dev/null)"
        if [ "$over" = "1" ]; then
            log "$(printf '⛔ COST CAP EXCEEDED: $%s >= $%s. Aborting.' "$total" "$cap")"
            notify_event cost-cap "$(printf 'Cost cap exceeded: $%s >= $%s' "$total" "$cap")"
            exit 6
        fi

        # Soft warning + auto-pause at a fraction of the cap (default 0.8 = 80%).
        # Fires once per mission (sentinel) so we don't spam.
        if [ ! -f "$STATE_DIR/.cost-warn-fired" ]; then
            local warn_frac="$(config_get 'maxCostUsdWarnThreshold' '0.8')"
            local at_warn
            at_warn="$(python3 -c "print(1 if float('$total') >= float('$cap') * float('$warn_frac') else 0)" 2>/dev/null)"
            if [ "$at_warn" = "1" ]; then
                log "$(printf '⚠ COST WARN: $%s >= %s%% of $%s cap' "$total" "$(python3 -c "print(int(float('$warn_frac')*100))")" "$cap")"
                notify_event cost-warn "$(printf 'Cost at %s%% of cap: $%s of $%s' "$(python3 -c "print(int(float('$warn_frac')*100))")" "$total" "$cap")"
                touch "$STATE_DIR/.cost-warn-fired"
                # Optional: auto-pause when warn threshold hit. Gated.
                if [ "$(config_get 'maxCostUsdAutoPause' 'false')" = "true" ]; then
                    log "  auto-pause: SIGSTOP'ing harness process tree (config.maxCostUsdAutoPause=true)"
                    # Self-STOP: the caller's shell. The API's /unpause can resume us.
                    kill -STOP $
                    # Execution resumes here after SIGCONT.
                    log "  auto-pause: resumed"
                fi
            fi
        fi
    else
        log "$(printf '  COST total=$%s (no cap configured)' "$total")"
    fi
}

prune_logs() {
    # Prune oldest .out/.err/.jsonl sets in .harness/logs/ beyond config.json →
    # logRetention (default 500). Keeps hook logs + run.log intact.
    local retention=500
    if [ -f "$STATE_DIR/config.json" ]; then
        local configured
        configured="$(config_get 'logRetention' '')"
        [ -n "$configured" ] && retention="$configured"
    fi
    # List <ts>-<role>.out files, sorted oldest→newest by filename.
    # If count > retention, drop oldest (count - retention) along with .err + .jsonl siblings.
    local files; files=$(ls -1 "$LOG_DIR"/*.out 2>/dev/null | sort)
    local count; count=$(printf '%s\n' "$files" | grep -c . || true)
    if [ "$count" -gt "$retention" ]; then
        local drop=$((count - retention))
        printf '%s\n' "$files" | head -n "$drop" | while IFS= read -r out; do
            [ -z "$out" ] && continue
            local stem="${out%.out}"
            rm -f "$out" "${stem}.err" "${stem}.jsonl"
        done
        log "  log prune: kept $retention .out files, dropped $drop (+.err/.jsonl siblings)"
    fi
}

snapshot_state() {
    # snapshot_state <iteration_number>
    # Dumps a copy of mission state files into .harness/snapshots/<ts>-iter-NNN/
    # for rollback. Skips logs/, hooks/ (user-edited), escalation.md (transient).
    # Prunes oldest snapshots beyond config.json → snapshotRetention (default 50).
    local iter_num="$1"
    local ts; ts="$(date +%s)"
    local snap_id="${ts}-iter-$(printf '%03d' "$iter_num")"
    local snap_dir="$STATE_DIR/snapshots/${snap_id}"
    mkdir -p "$snap_dir"
    [ -f "$STATE_DIR/validation-contract.md" ]  && cp "$STATE_DIR/validation-contract.md"  "$snap_dir/" || true
    [ -f "$STATE_DIR/supervisor-notes.md" ]     && cp "$STATE_DIR/supervisor-notes.md"     "$snap_dir/" || true
    [ -f "$STATE_DIR/config.json" ]             && cp "$STATE_DIR/config.json"             "$snap_dir/" || true

    # Mirror harness_features rows into harness_shared.snapshot_features
    # so restore can round-trip the work queue. Best-effort; if the web
    # tier is unreachable, the snapshot is still useful for FS state.
    curl -sS -m 5 -o /dev/null -X POST \
      "http://localhost:3055/api/harness/${HARNESS_SLUG}/snapshots/${snap_id}/record-pg-state" 2>/dev/null || true

    # Prune oldest beyond retention limit.
    local retention=50
    if [ -f "$STATE_DIR/config.json" ]; then
        local configured
        configured="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    c = json.load(open(os.environ["CONFIG"]))
    v = c.get("snapshotRetention")
    if isinstance(v, int) and v > 0:
        print(v)
except Exception:
    pass
' 2>/dev/null)"
        [ -n "$configured" ] && retention="$configured"
    fi
    # List snapshot dirs sorted oldest→newest by name (filename begins with unix ts)
    local snaps; snaps=$(ls -1d "$STATE_DIR/snapshots"/*-iter-* 2>/dev/null | sort)
    local count; count=$(printf '%s\n' "$snaps" | grep -c . || true)
    if [ "$count" -gt "$retention" ]; then
        local drop=$((count - retention))
        printf '%s\n' "$snaps" | head -n "$drop" | while IFS= read -r d; do
            [ -n "$d" ] && rm -rf "$d"
        done
        log "  snapshot prune: kept $retention, dropped $drop"
    fi
}

# 2026-04-26: features live in Postgres (papercusp DB, harness_<slug>
# schema). These helpers prefer curl-to-API; if the web tier is down, they
# fall back to direct psql against the per-harness schema.

# Resolve the registry slug for the current PROJECT_DIR. Tries the operator
# HTTP API (canonical — PG-backed) first, then the legacy
# ~/.restart-harness-projects.json file. Cached in $_HARNESS_SLUG.
_HARNESS_SLUG=""
harness_slug() {
    if [ -n "$_HARNESS_SLUG" ]; then echo "$_HARNESS_SLUG"; return; fi
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local api_resp; api_resp="$(curl -sf --max-time 3 "${operator_base}/api/harness/projects" 2>/dev/null || true)"
    if [ -n "$api_resp" ]; then
        _HARNESS_SLUG="$(printf '%s' "$api_resp" | PD="$PROJECT_DIR" python3 -c '
import json, os, sys
try:
    r = json.load(sys.stdin)
    for p in r.get("projects", []):
        if p.get("path") == os.environ["PD"]:
            print(p.get("slug", "")); sys.exit(0)
except Exception:
    pass
' 2>/dev/null)"
    fi
    if [ -z "$_HARNESS_SLUG" ] && [ -f "$HOME/.restart-harness-projects.json" ]; then
        _HARNESS_SLUG="$(REG="$HOME/.restart-harness-projects.json" PD="$PROJECT_DIR" python3 -c '
import json, os, sys
try:
    r = json.load(open(os.environ["REG"]))
    for p in r.get("projects", []):
        if p.get("path") == os.environ["PD"]:
            print(p.get("slug", "")); sys.exit(0)
except Exception:
    pass
' 2>/dev/null)"
    fi
    [ -z "$_HARNESS_SLUG" ] && _HARNESS_SLUG="$(basename "$PROJECT_DIR")"
    echo "$_HARNESS_SLUG"
}

# Returns features as JSON array. Tries API first, falls back to psql.
features_json() {
    local slug; slug="$(harness_slug)"
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local resp
    if resp="$(curl -sf --max-time 3 "${operator_base}/api/harness/$slug/status" 2>/dev/null)"; then
        echo "$resp" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin).get("features", [])))'
        return 0
    fi
    # 2026-04-26: Postgres fallback (formerly sqlite3 against store.db).
    # search_path is set via PGOPTIONS so -c output doesn't include "SET".
    local schema; schema="harness_${slug//-/_}"
    if command -v psql >/dev/null 2>&1; then
        PGPASSWORD="${HARNESS_APP_PWD:-harness_app_pwd}" \
        PGOPTIONS="-c search_path=${schema},harness_shared,public" \
        psql -U "${HARNESS_APP_USER:-harness_app}" -h "${PGHOST:-localhost}" \
             -d "${HARNESS_PG_DB:-papercusp}" -At \
             -c "SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) FROM (SELECT feature_id AS id, title, status, attempts, claims, summary, kind, project_id, expected_cost_cents, tags, needs_human_review FROM harness_features) t" 2>/dev/null || echo "[]"
        return 0
    fi
    echo "[]"
}

# Returns 0 if any features exist for current harness, 1 otherwise.
features_exist() {
    local slug; slug="$(harness_slug)"
    local schema; schema="harness_${slug//-/_}"
    if command -v psql >/dev/null 2>&1; then
        local n
        n="$(PGPASSWORD="${HARNESS_APP_PWD:-harness_app_pwd}" \
            PGOPTIONS="-c search_path=${schema},harness_shared,public" \
            psql -U "${HARNESS_APP_USER:-harness_app}" -h "${PGHOST:-localhost}" \
                 -d "${HARNESS_PG_DB:-papercusp}" -At \
                 -c "SELECT COUNT(*) FROM harness_features" 2>/dev/null)"
        [ "${n:-0}" -gt 0 ]
        return $?
    fi
    return 1
}

# Returns the attempts count for a given feature id (or "0" if not found).
feature_attempts() {
    local fid="$1"; local slug; slug="$(harness_slug)"
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local resp
    if resp="$(curl -sf --max-time 3 "${operator_base}/api/harness/$slug/status" 2>/dev/null)"; then
        echo "$resp" | FID="$fid" python3 -c 'import sys,json,os
fid = os.environ["FID"]
for f in json.load(sys.stdin).get("features", []):
    if f.get("id") == fid:
        print(f.get("attempts", 0)); break
else:
    print(0)
'
        return 0
    fi
    local schema; schema="harness_${slug//-/_}"
    if command -v psql >/dev/null 2>&1; then
        local n
        n="$(PGPASSWORD="${HARNESS_APP_PWD:-harness_app_pwd}" \
            PGOPTIONS="-c search_path=${schema},harness_shared,public" \
            psql -U "${HARNESS_APP_USER:-harness_app}" -h "${PGHOST:-localhost}" \
                 -d "${HARNESS_PG_DB:-papercusp}" -At \
                 -c "SELECT COALESCE(attempts,0) FROM harness_features WHERE feature_id = '$(printf '%s' "$fid" | sed "s/'/''/g")'" 2>/dev/null)"
        echo "${n:-0}"
        return 0
    fi
    echo "0"
}

process_actions_block() {
    # Layer 2-C: parse ```actions ... ``` JSON block from worker stdout and
    # POST each action to /api/org/admin/execute-action. Used by department
    # workers (and any other harness whose role emits typed ACTIONS).
    #
    # Usage: process_actions_block "<worker_stdout>" [callingDept]
    local stdout="$1"
    local calling_dept="${2:-}"
    local actions_json
    # Extract content between ```actions and the next ``` fence
    actions_json="$(printf '%s' "$stdout" | awk '
        /^```actions/  {capture=1; next}
        capture && /^```/ {capture=0; next}
        capture
    ')"
    if [ -z "$actions_json" ]; then
        return 0
    fi
    # Validate JSON; on parse failure log and exit non-fatally
    if ! printf '%s' "$actions_json" | python3 -c 'import json,sys; json.loads(sys.stdin.read())' 2>/dev/null; then
        log "ACTIONS: malformed JSON block, skipping"
        return 0
    fi
    log "ACTIONS: $(printf '%s' "$actions_json" | python3 -c 'import json,sys; print(len(json.loads(sys.stdin.read())))') op(s) detected"
    local action_count
    action_count="$(printf '%s' "$actions_json" | python3 -c 'import json,sys; print(len(json.loads(sys.stdin.read())))')"
    local operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
    local harness_token=""
    if [ -f "$HARNESS_DIR/config.json" ]; then
        harness_token="$(jq -r '.harness_token // empty' "$HARNESS_DIR/config.json" 2>/dev/null || true)"
    fi
    local i=0
    while [ "$i" -lt "$action_count" ]; do
        local single_action
        single_action="$(printf '%s' "$actions_json" | INDEX="$i" python3 -c 'import json,sys,os; print(json.dumps(json.loads(sys.stdin.read())[int(os.environ["INDEX"])]))')"
        local action_id; action_id="$(uuidgen 2>/dev/null || python3 -c 'import uuid; print(uuid.uuid4())')"
        local body
        if [ -n "$calling_dept" ]; then
            body="$(printf '{"actionId": "%s", "action": %s, "callingDept": "%s"}' "$action_id" "$single_action" "$calling_dept")"
        else
            body="$(printf '{"actionId": "%s", "action": %s}' "$action_id" "$single_action")"
        fi
        local auth_args=()
        if [ -n "$harness_token" ]; then
            auth_args=(-H "Authorization: Bearer $harness_token")
        fi
        local resp
        resp="$(curl -sS -X POST -H 'content-type: application/json' "${auth_args[@]}" --max-time 30 \
            -d "$body" "$operator_base/api/admin/execute-action" 2>&1 || echo '{"ok":false,"error":"curl failed"}')"
        log "  action $((i+1))/$action_count: $resp"
        i=$((i+1))
    done
}

run_hook() {
    # run_hook <name>
    # Resolution order:
    #   1. <STATE_DIR>/hooks/<name>.sh (per-harness override)
    #   2. <repo>/libs/papercusp/packages/harness/hooks/builtins/<name>.sh (substrate builtin)
    # If neither exists, this is a no-op.
    #
    # Env vars (ROLE, FEATURE_ID, RC, REASON, etc.) must be exported by the
    # caller. Hook stdout/stderr → .harness/logs/hooks/<ts>-<name>.log.
    # Non-zero exit is logged as a warning but does NOT halt the mission.
    local hook="$1"
    local script="$STATE_DIR/hooks/${hook}.sh"
    if [ ! -x "$script" ]; then
        # Fall through to builtin resolver. HOME-dir bin first, then the
        # path relative to this run.sh's own location.
        local self_dir; self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        local builtin="$self_dir/hooks/builtins/${hook}.sh"
        if [ -x "$builtin" ]; then
            script="$builtin"
        else
            return 0
        fi
    fi
    mkdir -p "$LOG_DIR/hooks"
    local ts; ts="$(date +%s)"
    local logfile="$LOG_DIR/hooks/${ts}-${hook}.log"
    log "HOOK $hook running (log: $logfile)"
    ( cd "$PROJECT_DIR" && "$script" ) > "$logfile" 2>&1
    local rc=$?
    if [ $rc -ne 0 ]; then
        log "  HOOK $hook failed rc=$rc — continuing (see $logfile)"
    fi
    return 0
}

invoke() {
    # invoke <role> [extra-context...]
    # Concatenates prompt file + any extra context lines, pipes to $CLAUDE.
    #
    # Output is captured two ways:
    #   1. $out.jsonl — raw stream-json events (one JSON per line, written as
    #      they arrive — UI tails this for live progress).
    #   2. $out      — the final "result" text (one-liner). Harness orchestrator
    #      parses this for decisions like "NEXT_WORKER F-003".
    local role="$1"; shift
    # Phase-aware prompt resolution with per-department override chain:
    #   prompts/$HARNESS_PHASE/departments/<dept>/<role>.md  (Layer 2-C)
    #   prompts/$HARNESS_PHASE/<role>.md
    #   prompts/<role>.md  (fallback)
    local prompt_file="$HARNESS_DIR/prompts/${role}.md"
    if [ -n "${HARNESS_PHASE:-}" ] && [ -f "$HARNESS_DIR/prompts/$HARNESS_PHASE/${role}.md" ]; then
        prompt_file="$HARNESS_DIR/prompts/$HARNESS_PHASE/${role}.md"
    fi
    # Layer 2-C: read dept slug from config.json and prefer per-dept override
    local _dept_slug=""
    if [ -f "$STATE_DIR/config.json" ]; then
        _dept_slug="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    print(d.get("dept", ""))
except Exception:
    print("")
' 2>/dev/null)"
    fi
    if [ -n "$_dept_slug" ] && [ -n "${HARNESS_PHASE:-}" ] \
       && [ -f "$HARNESS_DIR/prompts/$HARNESS_PHASE/departments/$_dept_slug/${role}.md" ]; then
        prompt_file="$HARNESS_DIR/prompts/$HARNESS_PHASE/departments/$_dept_slug/${role}.md"
    fi
    # Trick: keep the existing prompts/department/* tree usable by mapping
    # phase=department to the prompts/department/ subtree (legacy layout).
    if [ -z "$prompt_file" ] || [ ! -f "$prompt_file" ]; then
        # Try legacy: prompts/department/<role>.md when phase=department
        if [ "${HARNESS_PHASE:-}" = "department" ] && [ -f "$HARNESS_DIR/prompts/department/${role}.md" ]; then
            prompt_file="$HARNESS_DIR/prompts/department/${role}.md"
        fi
    fi
    # Layer 2-C: keep this here in case the other branches above didn't fire
    if false; then
        prompt_file="$HARNESS_DIR/prompts/$HARNESS_PHASE/${role}.md"
    fi
    # Extract FEATURE_ID=<fid> from extra-context args if present, so it can be
    # embedded in the run_id for cost-per-feature attribution (see /usage).
    local feature_tag=""
    local feature_id=""
    for extra in "$@"; do
        case "$extra" in
            FEATURE_ID=*)
                local fid="${extra#FEATURE_ID=}"
                # Only include if it looks like a real feature id (F-...)
                # or an expert/feedback instance id (EXP-NNN, FB-NNN). Cost
                # attribution rolls up per id via the run_id suffix.
                if [[ "$fid" =~ ^(F|EXP|FB)-[A-Z0-9-]+$ ]]; then
                    feature_tag="-$fid"
                    feature_id="$fid"
                fi
                ;;
        esac
    done
    # Worktree cwd override: when branchIsolation.useWorktrees is on AND
    # this invocation has a feature id AND a worktree dir exists for it,
    # run the Claude subprocess with cwd=worktree so it edits the isolated
    # filesystem slice rather than the main project tree.
    local cwd_override=""
    if [ -n "$feature_id" ] && worktree_enabled 2>/dev/null; then
        local _wt; _wt="$(worktree_path_for "$feature_id")"
        if [ -d "$_wt" ]; then
            cwd_override="$_wt"
        fi
    fi
    local run_id
    run_id="$(date +%s)-${role}${feature_tag}"
    local jsonl="$LOG_DIR/${run_id}.jsonl"
    local out="$LOG_DIR/${run_id}.out"
    local err="$LOG_DIR/${run_id}.err"

    # Phase 3: write the lane row so the dashboard's lanes tile shows
    # which (role, feature) is currently mid-invoke. pg_clear_lanes at
    # iteration end empties them; the harness-status-sweep drops stale
    # rows whose recorded PID is gone (covers SIGKILL'd workers).
    # Backgrounded so a status-write hiccup never blocks the actual
    # agent invocation.
    #
    # CRITICAL: capture the parent shell pid BEFORE the subshell. Inside
    # the `{...} &` block, the bash special variable expands to the
    # subshell's pid (dies the moment curl returns), and the sweeper
    # would delete the lane within 30s. We want the harness pid → "lane
    # alive iff harness still iterating". Using BASHPID here unambiguously
    # gets the current (parent) shell pid; bash $ has special quoting
    # behavior that earlier edits accidentally truncated.
    _phase3_lane_pid="$BASHPID"
    {
        _phase3_lane_slug="$(harness_slug 2>/dev/null || echo unknown)"
        pg_write_lane "$_phase3_lane_slug" "${PAPERCUSP_PHASE:-staging}" \
            "$role" "$feature_id" "$_phase3_lane_pid" 2>/dev/null || true
    } &

    # Structured-stream mode gives us live progress, tool calls, token
    # usage, and cost. Backend-aware: claude-code → stream-json,
    # omp/pi-coding-agent → --mode json. Falls back to plain text if
    # the caller's $CLAUDE override doesn't support either.
    local extra_flags=""
    if [ "$AGENT_BACKEND" = "omp" ]; then
        if [[ "$CLAUDE" != *"--mode "* ]]; then
            extra_flags="--mode json --no-session"
        fi
    else
        if [[ "$CLAUDE" == *"claude"* ]] && [[ "$CLAUDE" != *"stream-json"* ]]; then
            extra_flags="--output-format stream-json --verbose --include-partial-messages"
        fi
    fi

    # Per-role invocation timeout from .harness/config.json. Value in seconds.
    # Uses GNU coreutils `timeout` — exits 124 on SIGTERM.
    local timeout_seconds=""
    if [ -f "$STATE_DIR/config.json" ]; then
        timeout_seconds="$(ROLE="$role" CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    c = json.load(open(os.environ["CONFIG"]))
    v = c.get("timeouts", {}).get(os.environ["ROLE"])
    if isinstance(v, (int, float)) and v > 0:
        print(int(v))
except Exception:
    pass
' 2>/dev/null)"
    fi
    local timeout_prefix=""
    if [ -n "$timeout_seconds" ] && command -v timeout >/dev/null 2>&1; then
        timeout_prefix="timeout $timeout_seconds"
        log "  role=$role timeout=${timeout_seconds}s"
    fi

    # Per-role model + prompt override from .harness/config.json.
    # User-provided $CLAUDE containing --model wins (no double-override).
    local role_prompt_override=""
    if [ -f "$STATE_DIR/config.json" ]; then
        if [[ "$CLAUDE" != *"--model "* ]]; then
            local role_model
            role_model="$(ROLE="$role" CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    c = json.load(open(os.environ["CONFIG"]))
    print(c.get("models", {}).get(os.environ["ROLE"], ""))
except Exception:
    pass
' 2>/dev/null)"
            if [ -n "$role_model" ]; then
                extra_flags="$extra_flags --model $role_model"
                log "  role=$role model=$role_model (from config.json)"
            fi
        fi
        # Prompt override: inline string OR path (relative = $STATE_DIR, absolute = absolute).
        role_prompt_override="$(ROLE="$role" CONFIG="$STATE_DIR/config.json" STATE_DIR="$STATE_DIR" python3 -c '
import json, os
try:
    c = json.load(open(os.environ["CONFIG"]))
    val = c.get("promptOverrides", {}).get(os.environ["ROLE"], "")
    if not val:
        pass
    elif val.startswith("/"):
        # Absolute path
        if os.path.isfile(val):
            print(open(val).read(), end="")
    elif val.startswith("./") or val.endswith(".md") or val.endswith(".txt"):
        # Relative path
        p = os.path.join(os.environ["STATE_DIR"], val.lstrip("./"))
        if os.path.isfile(p):
            print(open(p).read(), end="")
    else:
        # Inline string
        print(val, end="")
except Exception:
    pass
' 2>/dev/null)"
        if [ -n "$role_prompt_override" ]; then
            log "  role=$role prompt-override applied ($(printf '%s' "$role_prompt_override" | wc -c) chars)"
        fi
    fi

    # Ensure the memory directory exists so agents writing to it don't error.
    mkdir -p "$STATE_DIR/memory"
    [ -f "$STATE_DIR/memory/raw.md" ] || : > "$STATE_DIR/memory/raw.md"
    [ -f "$STATE_DIR/memory/summary.md" ] || : > "$STATE_DIR/memory/summary.md"
    [ -f "$STATE_DIR/memory/MEMORY.md" ] || : > "$STATE_DIR/memory/MEMORY.md"

    # Prompt-assembly path. Default: bash assembles inline below (the legacy
    # path, identical to what's been shipping). When PAPERCUSP_USE_TS_PROMPT_ASSEMBLY=1
    # is set, shells out to the TS `assemble-prompt` CLI which uses the same
    # `assembleRolePrompt()` function the chat endpoint and PM dispatch use,
    # eliminating drift. The TS path is opt-in until parity is verified in the
    # wild — flip the env flag to enable.
    local _slug; _slug="$(harness_slug)"
    local _ts_assembler="$HARNESS_DIR/../orchestrator/bin/assemble-prompt.ts"
    if [ "${PAPERCUSP_USE_TS_PROMPT_ASSEMBLY:-0}" = "1" ] && [ -f "$_ts_assembler" ]; then
        # Build --extra args from the original positional context lines.
        local _extras_args=()
        for extra in "$@"; do
            _extras_args+=( --extra "$extra" )
        done
        if [ -n "$cwd_override" ]; then
            _extras_args+=( --extra "Working directory: $cwd_override (worktree for $feature_id)" )
            _extras_args+=( --extra "Project root: $PROJECT_DIR (reference only — you edit the worktree)" )
        fi
        # Capture into a temp file then pipe (cleaner stderr handling, easier to debug).
        local _prompt_tmp; _prompt_tmp="$(mktemp)"
        if npx tsx "$_ts_assembler" \
                --slug "$_slug" \
                --role "$role" \
                ${feature_id:+--feature-id "$feature_id"} \
                --run-id "$run_id" \
                "${_extras_args[@]}" \
                > "$_prompt_tmp" 2>>"$err"; then
            if [ "$AGENT_BACKEND" = "omp" ]; then
                # omp -p reads message from positional arg, not stdin.
                ( [ -n "$cwd_override" ] && cd "$cwd_override"; stdbuf -oL -eL $timeout_prefix $CLAUDE $extra_flags "@$_prompt_tmp" > "$jsonl" 2>> "$err" ) < /dev/null
            else
                ( [ -n "$cwd_override" ] && cd "$cwd_override"; stdbuf -oL -eL $timeout_prefix $CLAUDE $extra_flags > "$jsonl" 2>> "$err" ) < "$_prompt_tmp"
            fi
            rm -f "$_prompt_tmp"
        else
            log "  role=$role TS prompt-assembly failed (rc=$?), falling back to bash inline"
            rm -f "$_prompt_tmp"
            # Fall through to bash inline path below by setting a sentinel.
            export _PAPERCUSP_TS_ASSEMBLY_FAILED=1
        fi
    fi
    if [ "${PAPERCUSP_USE_TS_PROMPT_ASSEMBLY:-0}" != "1" ] || [ "${_PAPERCUSP_TS_ASSEMBLY_FAILED:-0}" = "1" ]; then
        unset _PAPERCUSP_TS_ASSEMBLY_FAILED
        {
            cat "$prompt_file"
            if [ -n "$role_prompt_override" ]; then
                echo
                echo "---"
                echo "## Droid specialization (from .harness/config.json → promptOverrides.$role)"
                echo
                printf '%s\n' "$role_prompt_override"
            fi

            # Inject curated memory into every role except the curator itself.
            # Keeps prompts small (summary.md is capped at 40 lines) while giving
            # fresh-context agents the lessons from prior iterations.
            if [ "$role" != "curator" ] && [ -s "$STATE_DIR/memory/summary.md" ]; then
                echo
                echo "---"
                echo "## Memory (curated from prior iterations of this run)"
                echo
                cat "$STATE_DIR/memory/summary.md"
            fi

            # Inject per-role IDENTITY (cross-mission, Agent-Swarm-inspired).
            # Maintained by curator. Contains patterns/failures from ALL prior missions,
            # not just this one. Bounded by curator's compaction pass.
            identity_file="$HARNESS_DIR/identity/${role}.md"
            if [ -f "$identity_file" ] && [ -s "$identity_file" ]; then
                echo
                echo "---"
                echo "## Your identity (cross-mission memory for the $role role)"
                echo
                cat "$identity_file"
            fi

            echo
            echo "---"
            echo "## Runtime context"
            echo
            for extra in "$@"; do
                echo "- $extra"
            done
            if [ -n "$cwd_override" ]; then
                echo "- Working directory: $cwd_override (worktree for $feature_id)"
                echo "- Project root: $PROJECT_DIR (reference only — you edit the worktree)"
            else
                echo "- Working directory: $PROJECT_DIR"
            fi
            echo "- State directory: $STATE_DIR (all coordination files live here; shared across worktrees if any)"
            echo "- Run ID: $run_id"
            if [ "$role" != "curator" ]; then
                echo "- **Memory discipline:** at the end of your work, if you learned something"
                echo "  actionable for future iterations (a technique that works, a library that"
                echo "  doesn't, an invariant that tripped you up), append ONE line to"
                echo "  \`.harness/memory/raw.md\` in the format:"
                echo "  \`[<ISO-8601-timestamp>] $role <feature_id-or-dash>: <one-line observation>\`"
                echo "  Do not dump logs. Do not duplicate existing lines. Skip silently if you"
                echo "  have nothing generalizable to add."
            fi
        } > "$LOG_DIR/${run_id}.prompt.md"
        if [ "$AGENT_BACKEND" = "omp" ]; then
            # omp -p reads message from positional arg, not stdin.
            ( [ -n "$cwd_override" ] && cd "$cwd_override"; stdbuf -oL -eL $timeout_prefix $CLAUDE $extra_flags "@$LOG_DIR/${run_id}.prompt.md" > "$jsonl" 2> "$err" ) < /dev/null
        else
            ( [ -n "$cwd_override" ] && cd "$cwd_override"; stdbuf -oL -eL $timeout_prefix $CLAUDE $extra_flags > "$jsonl" 2> "$err" ) < "$LOG_DIR/${run_id}.prompt.md"
        fi
    fi
    local rc=$?
    if [ "$rc" = "124" ]; then
        log "  role=$role TIMED OUT after ${timeout_seconds}s (rc=124)"
    fi

    # Extract final result text. Backend-aware:
    #   - claude-code stream-json: terminal event {"type":"result","result":"...","total_cost_usd":N,...}
    #   - omp -p --mode json: terminal event "turn_end" with the
    #     assistant message at .message.content[*].text. There's no
    #     `result` field — omp aggregates content blocks into .message.
    # We read the WHOLE file (not just tail -5) because omp's session
    # event is at the top and turn_end can be far from the tail with
    # tool-rich runs. Both branches accumulate into `text`; whichever
    # event-shape matched wins.
    # Plain-text fallback: $jsonl IS the plain text output.
    if [ -n "$extra_flags" ]; then
        local final
        final="$(python3 -c '
import sys, json
text = ""
with open(sys.argv[1]) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        t = obj.get("type")
        # claude-code shape
        if t == "result":
            text = obj.get("result", text)
            continue
        # omp shape — turn_end/message_end with role:"assistant" carries
        # the final aggregated text. Prefer the LAST one we see
        # (overrides earlier partials).
        if t in ("turn_end", "message_end"):
            msg = obj.get("message") or {}
            if msg.get("role") == "assistant":
                parts = []
                for block in msg.get("content", []) or []:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                if parts:
                    text = "".join(parts)
print(text)
' "$jsonl" 2>/dev/null)"
        printf '%s\n' "$final" > "$out"
    else
        cp "$jsonl" "$out"
    fi

    log "invoke $role rc=$rc (stdout: $out)"
    if [ $rc -ne 0 ] && [ -s "$err" ]; then
        log "  stderr (first 5 lines):"
        head -5 "$err" | sed 's/^/    /' | tee -a "$LOG_DIR/run.log"
    fi

    # Layer 3 polish: also write a human-readable markdown summary to runs/
    # (matches the old director-runs/ UX from the retired spawnClaude pipeline).
    # Skipped for invocations that have no STATE_DIR/runs/ — only org/dept
    # harnesses opt in via that directory existing.
    if [ -d "$STATE_DIR/runs" ]; then
        local _summary_ts; _summary_ts="$(date -u +%Y-%m-%dT%H-%M-%S-%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H-%M-%SZ)"
        local _summary_path="$STATE_DIR/runs/${_summary_ts}_${role}${feature_tag}.md"
        local _agent_text; _agent_text="$(cat "$out" 2>/dev/null || true)"
        local _decision_line; _decision_line="$(printf '%s' "$_agent_text" | head -1)"
        {
            printf '# Invoke run · %s\n' "$role"
            printf -- '- ts: %s\n' "$(date -Iseconds)"
            printf -- '- role: %s\n' "$role"
            printf -- '- run_id: %s\n' "$run_id"
            printf -- '- exit_code: %s\n' "$rc"
            [ -n "${feature_id:-}" ] && printf -- '- feature_id: %s\n' "$feature_id"
            printf -- '- decision_line: `%s`\n' "$_decision_line"
            printf -- '- raw_log: %s\n' "$out"
            printf -- '- raw_jsonl: %s\n' "$jsonl"
            printf '\n## Agent output\n\n```\n%s\n```\n' "$_agent_text"
            if [ $rc -ne 0 ] && [ -s "$err" ]; then
                printf '\n## stderr (first 30 lines)\n\n```\n%s\n```\n' "$(head -30 "$err")"
            fi
        } > "$_summary_path" 2>/dev/null || true
    fi

    cat "$out"
    return $rc
}

# ─── Step 1: plan (only if missing) ─────────────────────────────────────────
# Uses the consolidated `scoper` role in MODE=initial (formerly the `planner`
# role). Layer A/B (2026-04-26): features moved to SQL; checks both the new
# SQL store and the validation-contract.md file.
if [ ! -f "$STATE_DIR/validation-contract.md" ] || ! features_exist; then
    log "PLAN: SPEC.md detected, no contract or features yet. Invoking scoper (initial mode)."
    plan_out="$(invoke scoper "MODE=initial")"
    echo "$plan_out" | tail -3 | tee -a "$LOG_DIR/run.log"

    # 2026-05-01: scoper now POSTs features directly to
    # /api/harness/<slug>/features/import per scoper.md (top of file, the
    # 2026-05-01 migration banner). The transient features.json + psql import
    # shim that lived here previously is removed. If you see a scoper that
    # still writes features.json on disk, fix the prompt — don't restore the
    # shim.
    if [ -f "$STATE_DIR/features.json" ]; then
        log "WARN: scoper wrote features.json on disk (deprecated). The substrate no longer imports it; features in that file will not enter PG. Update the scoper prompt to POST /features/import. Renaming to .legacy."
        mv "$STATE_DIR/features.json" "$STATE_DIR/features.json.deprecated" 2>/dev/null || true
    fi

    if [ ! -f "$STATE_DIR/validation-contract.md" ] || ! features_exist; then
        log "ERROR: scoper did not produce required artifacts. See $LOG_DIR."
        exit 2
    fi
else
    log "PLAN: existing contract + features (in SQL) found. Skipping scoper."
fi

# ─── Step 1.5: plan review ──────────────────────────────────────────────
# Runs once after the scoper, before the main loop. Gated by config.planReviewer.enabled
# (default true). On verdict=reject, exits 7 so the user can intervene.
# Skipped if plan-review.md already exists (idempotent on re-entry).
# Uses the consolidated `reviewer` role in MODE=plan (formerly `plan-reviewer`).
if [ "$(config_get 'planReviewer.enabled' 'true')" = "true" ] && [ ! -f "$STATE_DIR/plan-review.md" ]; then
    log "PLAN-REVIEW: challenging scoper output"
    plan_review_out="$(invoke reviewer "MODE=plan")"
    if [ -f "$STATE_DIR/plan-review.md" ]; then
        verdict_line="$(grep -E '^VERDICT:' "$STATE_DIR/plan-review.md" | tail -1)"
        log "PLAN-REVIEW: ${verdict_line:-no verdict line found}"
        case "$verdict_line" in
            *reject*)
                log "⛔ Plan reviewer rejected — writing escalation and exiting 7."
                {
                    echo "# Plan reviewer rejected the plan"
                    echo
                    echo "See .harness/plan-review.md for details."
                } > "$STATE_DIR/escalation.md"
                notify_event escalate "Plan reviewer rejected the planner output"
                exit 7
                ;;
        esac
    else
        log "PLAN-REVIEW: no plan-review.md produced, continuing without review"
    fi
fi

# Ensure the project has a docs/ scaffold so the documenter has somewhere
# to write and the docs-viewer can mount it.
if [ -x "$HARNESS_DIR/bin/ensure-docs.sh" ]; then
    "$HARNESS_DIR/bin/ensure-docs.sh" "$PROJECT_DIR" || log "WARN: ensure-docs.sh failed (non-fatal)"
fi

# Auto-fire post-planner checkpoints (Hermes-inspired). If config declares
# a checkpoint type with triggerOn=post-planner, emit it after the planner
# + plan-reviewer have both passed, once per mission.
if [ "$(config_get 'checkpoints.enabled' 'false')" = "true" ]; then
    post_planner_names="$(STATE_DIR="$STATE_DIR" python3 -c '
import json, os
try:
    c = json.load(open(os.path.join(os.environ["STATE_DIR"], "config.json")))
    for t in c.get("checkpoints", {}).get("types", []):
        if t.get("triggerOn") == "post-planner":
            print(t.get("name", ""))
except Exception:
    pass
' 2>/dev/null)"
    for cp_name in $post_planner_names; do
        [ -z "$cp_name" ] && continue
        cp_file="$STATE_DIR/checkpoint-${cp_name}.md"
        sentinel="$STATE_DIR/.checkpoint-${cp_name}.fired"
        if [ -f "$sentinel" ] || [ -f "$cp_file" ] || [ -f "${cp_file}.granted" ]; then
            continue
        fi
        cat > "$cp_file" <<EOF_AUTO_CP
# Checkpoint: ${cp_name} (auto, triggerOn=post-planner)

Requested at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Trigger: planner + plan-reviewer both passed for the first time.

Review the plan in \`.harness/features.json\` and \`.harness/validation-contract.md\`.

## How to grant
- UI: /api/harness/<slug>/checkpoint/${cp_name}/grant
- CLI: touch ${cp_file}.granted && re-run the harness
EOF_AUTO_CP
        : > "$sentinel"
        log "⏸  Auto-fired checkpoint: ${cp_name} (post-planner). Exiting 8."
        CHECKPOINT_NAME="$cp_name" TRIGGER="post-planner" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-checkpoint-fired
        notify_event checkpoint "Auto checkpoint: ${cp_name}"
        exit 8
    done
fi

# Prune stale worktrees left behind by crashes (Composio-inspired).
# No-op when worktrees aren't in use or the feature worktree dir is absent.
if [ "$(config_get 'branchIsolation.useWorktrees' 'false')" = "true" ]; then
    ( cd "$PROJECT_DIR" && git worktree prune 2>&1 | head -3 ) || true
fi

# ─── Step 2: main loop ──────────────────────────────────────────────────────

# Process any previously-granted checkpoints, and refuse to start if an
# ungranted checkpoint is still pending. Grant is signalled by a companion
# `.granted` file that the API writes on the user's behalf.
for cp in "$STATE_DIR"/checkpoint-*.md; do
    [ -e "$cp" ] || continue
    if [ -e "${cp}.granted" ]; then
        log "✅ Checkpoint granted: $(basename "$cp" .md). Removing."
        rm -f "$cp" "${cp}.granted"
    else
        log "⏸  Checkpoint pending grant: $(basename "$cp" .md). Exiting."
        log "Grant via UI, or run: touch ${cp}.granted; then re-run."
        exit 8
    fi
done

iteration=0

# Phase 3: clear agent_runs.running on graceful exit. SIGKILL'd runs get
# swept by the operator's harness-status-sweep within ~30s.
trap 'pg_clear_running "$(harness_slug 2>/dev/null || echo unknown)" 2>/dev/null || true' EXIT

# Compute (total, passed, todo, blocked) feature counts from per-harness PG.
# Echoes "total passed todo blocked" on stdout. Empty on failure.
_phase3_feature_counts() {
    local slug="$1"
    local schema="harness_${slug//-/_}"
    if ! command -v psql >/dev/null 2>&1; then return 0; fi
    PGPASSWORD="${HARNESS_APP_PWD:-harness_app_pwd}" \
    PGOPTIONS="-c search_path=${schema},harness_shared,public" \
    psql -U "${HARNESS_APP_USER:-harness_app}" -h "${PGHOST:-localhost}" \
         -d "${HARNESS_PG_DB:-papercusp}" -At -F ' ' \
         -c "SELECT
               COUNT(*),
               COUNT(*) FILTER (WHERE status = 'passed'),
               COUNT(*) FILTER (WHERE status = 'todo'),
               COUNT(*) FILTER (WHERE status = 'blocked')
             FROM harness_features" 2>/dev/null
}

# Fire beforeMissionStart for every plugin reachable from this project.
# Best-effort; failures are logged to plugins.log and don't gate the run.
fire_plugin_hook beforeMissionStart || true
while [ $iteration -lt $MAX_ITERATIONS ]; do
    iteration=$((iteration + 1))
    log "── iteration $iteration ──"

    # Phase 3: write status row at iteration start. Best-effort; helper
    # absorbs failures so we never gate the loop on a status-write hiccup.
    {
        _phase3_slug="$(harness_slug 2>/dev/null || echo unknown)"
        _phase3_phase="${PAPERCUSP_PHASE:-staging}"
        _phase3_counts="$(_phase3_feature_counts "$_phase3_slug")"
        # _phase3_counts is "total passed todo blocked" or empty
        # shellcheck disable=SC2086
        set -- $_phase3_counts
        pg_write_status "$_phase3_slug" "$_phase3_phase" "running" \
            "$iteration" "${1:-0}" "${2:-0}" "${3:-0}" "${4:-0}" \
            "" 2>/dev/null || true
    } &
    # Don't block iteration on the status write.

    # Ask the phase's primary advancing role what to do next.
    # 2026-04-26: was hard-coded to "orchestrator". The org phase declares
    # roles {coordinator, director, auditor} in its config.json with
    # different decision verbs (NEXT_HARNESS / SEND_MESSAGE / ESCALATE / IDLE)
    # and a different feature lifecycle, so we honor config.json's
    # primaryRole field. Coding harnesses inherit the default "orchestrator".
    # Strip markdown emphasis (* `) and code-fence backticks before matching,
    # and accept the keyword anywhere on the line — LLMs sometimes wrap the
    # decision in `**NEXT_VALIDATOR F-XXX**` or fenced code blocks even when
    # told not to. NB: do NOT strip underscores — keywords contain them.
    primary_role="$(config_get 'primaryRole' 'orchestrator')"
    decision="$(invoke "$primary_role" \
        | sed -E 's/[*`]+//g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
        | grep -oE '(DONE|CONVERTED|NEXT_WORKER_CEO_MODE|NEXT_WORKER|NEXT_VALIDATOR|NEXT_ARCHITECT|NEXT_TESTER|NEXT_SECURITY|GENERATE_TESTS|RUN_TESTS|NEXT_MONITOR|READY_FOR_PROD|FEATURE_FREEZE|NEXT_HARNESS|NEXT_EXPERT|NEXT_FEEDBACK|NEXT_SCOPER|IDLE|ESCALATE|CHECKPOINT)([[:space:]]+[A-Za-z0-9_.-]+)?' \
        | tail -1)"
    log "ORCH decision: $decision (role=$primary_role)"
    fire_plugin_hook onPostOrchestrator --decision="$decision" || true

    case "$decision" in
    DONE)
        log "🎉 All features passed."
        # claudecode-orchestrator-inspired service smoke-test gate on DONE.
        # If configured, runs bin/service-smoke-test.sh; failure reopens the
        # last-passed feature and re-enters the loop.
        if [ "$(config_get 'smokeTest.enabled' 'false')" = "true" ] && \
           [ "$(config_get 'smokeTest.onDone' 'true')" = "true" ]; then
            log "Running service smoke-test (smokeTest.onDone=true)…"
            if PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" \
               HARNESS_DIR="$HARNESS_DIR" \
               "$HARNESS_DIR/bin/service-smoke-test.sh" 2>&1 | tee -a "$LOG_DIR/run.log"; then
                log "Smoke test PASSED."
                TRIGGER="onDone" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-smoke-pass
            else
                log "Smoke test FAILED — feature reopened. Re-entering loop."
                TRIGGER="onDone" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-smoke-fail
                continue
            fi
        fi
        log "Running curator to distill run memory."
        curator_out="$(invoke curator "TRIGGER=done")"
        log "CURATOR: ${curator_out:-(no output)}"
        log "Running documenter in consolidate mode."
        documenter_out="$(invoke documenter "TRIGGER=done" "FEATURE_ID=-")"
        log "DOCUMENTER: ${documenter_out:-(no output)}"
        # Optional: run scoper (proposal mode, formerly the `product` role) to
        # propose next-phase features. The reviewer then auto-approves any
        # proposals it deems appropriate by appending them to SPEC.md.
        # Proposals after DONE: gated by proposals.enabled (canonical) or
        # legacy product.enabled. Default false — opt-in flow.
        proposals_enabled="$(config_get 'proposals.enabled' "$(config_get 'product.enabled' 'false')")"
        proposals_after_done="$(config_get 'proposals.afterDone' "$(config_get 'product.triggerOnDone' 'false')")"
        if [ "$proposals_enabled" = "true" ] && [ "$proposals_after_done" = "true" ]; then
            if [ -f "$PROJECT_DIR/SPEC.md" ]; then
                mkdir -p "$STATE_DIR/proposals"
                log "SCOPER starting (afterDone, proposal mode)"
                product_out="$(invoke scoper "MODE=proposal")"
                log "SCOPER: ${product_out:-(no output)}"
                # Auto-apply reviewer-approved unless explicitly opted out.
                # Legacy: product.mode == 'propose-only' opts out; new key
                # is proposals.autoApply (default true).
                auto_apply="$(config_get 'proposals.autoApply' '')"
                if [ -z "$auto_apply" ]; then
                    legacy_mode="$(config_get 'product.mode' 'auto-apply')"
                    [ "$legacy_mode" = "propose-only" ] && auto_apply="false" || auto_apply="true"
                fi
                if [ "$auto_apply" != "false" ]; then
                    review_pending_proposals
                fi
            else
                log "SCOPER skipped: no SPEC.md in project dir"
            fi
        fi

        # Optional auto-archive of the completed mission.
        if [ "$(config_get 'archiveOnDone' 'false')" = "true" ]; then
            mkdir -p "$STATE_DIR/archives"
            ts_arch="$(date +%s)"
            archive_path="$STATE_DIR/archives/${ts_arch}-done.tar.gz"
            if tar czf "$archive_path" -C "$STATE_DIR" --exclude=archives --exclude=./archives . 2>/dev/null; then
                log "  archiveOnDone: saved $(basename "$archive_path") ($(stat -c%s "$archive_path" 2>/dev/null || echo 0) bytes)"
            fi
        fi
        # Fire registered plugin afterDone hooks (briefings pipeline, etc.).
        # Each plugin runs in its own child process; failures are logged
        # and don't block the mission's clean exit.
        fire_plugin_hook afterDone || true

        notify_event done "Mission complete: all features passed after $iteration iterations"
        exit 0
        ;;

    NEXT_WORKER_CEO_MODE*)
        # Layer 2-C: CEO-mode worker invocation, used by org/department harnesses
        # when business handles a Directive from user. Identical to NEXT_WORKER
        # except the worker prompt is resolved with mode=ceo (which prefers
        # prompts/department/departments/business/ceo.md per buildResolvedPrompt).
        # The worker emits a typed ACTIONS block which we POST to executeAction.
        fid="${decision##NEXT_WORKER_CEO_MODE }"
        log "NEXT_WORKER_CEO_MODE $fid (CEO mode)"
        worker_out="$(invoke worker "FEATURE_ID=$fid" "MODE=ceo" "MESSAGE_ID=$fid")"
        log "WORKER (ceo mode): ${worker_out:-(no output)}"
        fire_plugin_hook onPostWorker --feature-id="$fid" || true
        # Read calling dept from this harness's config.json
        ceo_dept_slug="$(CONFIG="$STATE_DIR/config.json" python3 -c '
import json, os
try:
    d = json.load(open(os.environ["CONFIG"]))
    print(d.get("dept", ""))
except Exception:
    print("")
' 2>/dev/null)"
        process_actions_block "$worker_out" "$ceo_dept_slug"
        ;;

    NEXT_WORKER*)
        fid="${decision##NEXT_WORKER }"

        # Before the worker runs: if this feature has attempted >= threshold AND
        # no debug notes exist yet for this attempt count, invoke the debugger
        # first. The debugger investigates root cause and writes findings for
        # the worker to read. Opt-in via config.debugger.enabled (default true).
        if [ "$(config_get 'debugger.enabled' 'true')" = "true" ]; then
            debugger_threshold="$(config_get 'debugger.threshold' '3')"
            attempts_for_fid="$(feature_attempts "$fid")"
            debug_note="$STATE_DIR/debug/${fid}.md"
            # Fire if attempts >= threshold AND debug note is missing or stale
            # (older than most recent worker log for this feature).
            if [ "${attempts_for_fid:-0}" -ge "${debugger_threshold:-3}" ] && [ ! -f "$debug_note" ]; then
                mkdir -p "$STATE_DIR/debug"
                log "DEBUGGER $fid starting (attempts=$attempts_for_fid ≥ $debugger_threshold)"
                debug_out="$(invoke debugger "FEATURE_ID=$fid")"
                log "DEBUGGER: ${debug_out:-(no output)}"
            fi
        fi

        max_par="$(parallel_max_workers)"
        par_mode="$(config_get 'parallelWorkers.mode' 'lane')"
        if [ "$par_mode" = "competition" ] && [ "$max_par" -gt 1 ] && [ "$(config_get 'branchIsolation.enabled' 'false')" = "true" ] && [ "$(config_get 'branchIsolation.useWorktrees' 'false')" = "true" ]; then
            # Conductor-inspired: N workers on the SAME feature in sibling
            # worktrees; validator picks a winner. Requires worktrees.
            log "COMPETITION: spawning $max_par workers on $fid"
            FEATURE_ID="$fid" LANE_COUNT="$max_par" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-competition-start
            feature_set_status "$fid" "in_progress"
            competition_pids=()
            for i in $(seq 1 "$max_par"); do
                lane_fid="${fid}-lane-${i}"
                wt="$STATE_DIR/worktrees/$lane_fid"
                base="$(branch_iso_base)"
                br="harness/$lane_fid"
                mkdir -p "$STATE_DIR/worktrees"
                [ -d "$wt" ] || ( cd "$PROJECT_DIR" && git worktree add -B "$br" "$wt" "$base" 2>&1 | head -3 )
                log "  competition lane $i: $wt"
                (
                    FEATURE_ID="$lane_fid"
                    invoke worker "FEATURE_ID=$lane_fid" "COMPETITION_PARENT=$fid" "COMPETITION_LANE=$i" > /dev/null
                    fire_plugin_hook onPostWorker --feature-id="$lane_fid" || true
                    ( cd "$wt" && git add -A && git diff --cached --quiet || git commit --quiet -m "worker: $lane_fid (competition lane $i)" 2>&1 | head -3 )
                ) &
                competition_pids+=("$!")
            done
            # Wait all competitors
            for pid in "${competition_pids[@]}"; do wait "$pid" || true; done
            # Mark parent feature ready for competition validator
            feature_set_status "$fid" "validating"
            # Record competition manifest so validator knows which worktrees to compare
            manifest="$STATE_DIR/competition-${fid}.json"
            python3 - "$fid" "$max_par" "$STATE_DIR" > "$manifest" <<'PY'
import json, sys, os
fid, n, state = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lanes = [{"lane": i, "worktree": os.path.join(state, "worktrees", f"{fid}-lane-{i}"), "branch": f"harness/{fid}-lane-{i}"} for i in range(1, n+1)]
print(json.dumps({"parentFeatureId": fid, "lanes": lanes, "n": n}, indent=2))
PY
            log "COMPETITION: manifest $manifest written"
        elif [ "$max_par" -gt 1 ] && [ "$(config_get 'branchIsolation.enabled' 'false')" = "true" ]; then
            # Parallel path: fork the worker + post-steps. Requires branch isolation.
            live="$(lanes_count)"
            if [ "$live" -ge "$max_par" ]; then
                log "  parallel: cap reached ($live/$max_par), waiting for a lane to free"
                while [ "$(lanes_count)" -ge "$max_par" ]; do sleep 2; done
            fi
            log "WORKER $fid starting (parallel lane, $(lanes_count)/$max_par active before this)"
            feature_set_status "$fid" "in_progress"
            (
                FEATURE_ID="$fid" branch_iso_pre_worker
                ROLE=worker FEATURE_ID="$fid" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook pre-worker
                invoke worker "FEATURE_ID=$fid" > /dev/null
                worker_rc=$?
                ROLE=worker FEATURE_ID="$fid" RC="$worker_rc" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook post-worker
                fire_plugin_hook onPostWorker --feature-id="$fid" || true
                FEATURE_ID="$fid" branch_iso_post_worker
                FEATURE_ID="$fid" auto_screenshot_post_worker
                feature_set_status "$fid" "validating"
            ) &
            lanes_add "$!" "$fid"
        else
            # Sequential path (existing behavior)
            log "WORKER $fid starting"
            FEATURE_ID="$fid" branch_iso_pre_worker
            ROLE=worker FEATURE_ID="$fid" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook pre-worker
            wip_pid="$(wip_checkpoint_start "$fid")"
            invoke worker "FEATURE_ID=$fid" > /dev/null
            worker_rc=$?
            wip_checkpoint_stop "$wip_pid"
            ROLE=worker FEATURE_ID="$fid" RC="$worker_rc" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook post-worker
            fire_plugin_hook onPostWorker --feature-id="$fid" || true
            FEATURE_ID="$fid" branch_iso_post_worker
            FEATURE_ID="$fid" auto_screenshot_post_worker
        fi
        ;;

    NEXT_VALIDATOR*)
        fid="${decision##NEXT_VALIDATOR }"
        # Drain parallel worker lanes before running a validator (avoid git conflicts).
        lanes_wait_all
        log "VALIDATOR $fid starting"
        FEATURE_ID="$fid" branch_iso_pre_validator
        ROLE=validator FEATURE_ID="$fid" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook pre-validator
        invoke validator "FEATURE_ID=$fid" > /dev/null
        validator_rc=$?
        ROLE=validator FEATURE_ID="$fid" RC="$validator_rc" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook post-validator
        if [ "$validator_rc" -eq 0 ]; then
            fire_plugin_hook onPostValidator --feature-id="$fid" --status=passed || true
        else
            fire_plugin_hook onPostValidator --feature-id="$fid" --status=failing || true
        fi

        # Competition mode: if a manifest exists for this feature, parse
        # validator's output for COMPETITION_WINNER lane-<N> and merge that
        # lane, removing the losers.
        competition_manifest="$STATE_DIR/competition-${fid}.json"
        if [ -f "$competition_manifest" ]; then
            # Get validator's latest output (most recent .out file for this fid+validator)
            latest_out="$(ls -t "$LOG_DIR"/*"-validator-${fid}".out 2>/dev/null | head -1)"
            winner_lane=""
            if [ -n "$latest_out" ] && [ -f "$latest_out" ]; then
                winner_lane="$(grep -oE 'COMPETITION_WINNER lane-[0-9]+' "$latest_out" | head -1 | awk '{print $2}')"
                winner_none="$(grep -oE 'COMPETITION_WINNER none' "$latest_out" | head -1)"
            fi
            if [ -n "$winner_lane" ]; then
                log "COMPETITION: winner is $winner_lane; merging."
                winner_wt="$STATE_DIR/worktrees/${fid}-${winner_lane}"
                winner_br="harness/${fid}-${winner_lane}"
                base="$(branch_iso_base)"
                ( cd "$PROJECT_DIR" && {
                    git checkout "$base" 2>&1 | head -2
                    git merge --no-ff "$winner_br" -m "competition winner: $fid from $winner_lane" 2>&1 | head -5
                } )
                # Remove all lane worktrees + branches
                n=$(python3 -c "import json; print(json.load(open('$competition_manifest'))['n'])" 2>/dev/null || echo 2)
                for i in $(seq 1 "$n"); do
                    lwt="$STATE_DIR/worktrees/${fid}-lane-${i}"
                    lbr="harness/${fid}-lane-${i}"
                    ( cd "$PROJECT_DIR" && git worktree remove --force "$lwt" 2>/dev/null; git branch -D "$lbr" 2>/dev/null ) || true
                done
                rm -f "$competition_manifest"
                log "COMPETITION: cleaned up; parent $fid now carries winner's changes."
                FEATURE_ID="$fid" WINNER="$winner_lane" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-competition-won
            elif [ -n "$winner_none" ]; then
                log "COMPETITION: no lane passed; discarding all."
                n=$(python3 -c "import json; print(json.load(open('$competition_manifest'))['n'])" 2>/dev/null || echo 2)
                for i in $(seq 1 "$n"); do
                    lwt="$STATE_DIR/worktrees/${fid}-lane-${i}"
                    lbr="harness/${fid}-lane-${i}"
                    ( cd "$PROJECT_DIR" && git worktree remove --force "$lwt" 2>/dev/null; git branch -D "$lbr" 2>/dev/null ) || true
                done
                rm -f "$competition_manifest"
            else
                log "COMPETITION: validator did not emit COMPETITION_WINNER; manifest kept for retry."
            fi
        fi

        FEATURE_ID="$fid" branch_iso_post_validator

        # If the validator just transitioned this feature to `passed`, invoke
        # the documenter to produce user-facing Starlight docs. Gated by
        # features.json status so a failing validator doesn't trigger docs.
        feature_status="$(FID="$fid" STATE_DIR="$STATE_DIR" python3 -c '
import json, os
try:
    d = json.load(open(os.path.join(os.environ["STATE_DIR"], "features.json")))
    feats = d["features"] if isinstance(d, dict) else d
    for f in feats:
        if f.get("id") == os.environ["FID"]:
            print(f.get("status", ""))
            break
except Exception:
    pass
' 2>/dev/null)"
        if [ "$feature_status" = "passed" ]; then
            # Optional: re-check the pass with a DIFFERENT model (cross-model validation).
            # Uses config.models.crosscheck if set (distinct from models.validator).
            # Catches validator-bias "confidently wrong" results. Gated by config.
            if [ "$(config_get 'crosscheck.enabled' 'false')" = "true" ]; then
                log "CROSSCHECK $fid starting"
                xc_stdout="$(invoke crosscheck "FEATURE_ID=$fid")"
                # Extract the one-line verdict from crosscheck output
                xc_verdict="$(printf '%s\n' "$xc_stdout" | grep -E '^CROSSCHECK ' | tail -1)"
                case "$xc_verdict" in
                    "CROSSCHECK disagree"*)
                        log "⚠ CROSSCHECK disagrees on $fid — reverting to failing"
                        feature_set_status "$fid" "failing"
                        feature_status="failing"
                        ;;
                    "CROSSCHECK agree"*)
                        log "CROSSCHECK confirms $fid passed"
                        ;;
                    *)
                        log "CROSSCHECK inconclusive on $fid (verdict: ${xc_verdict:-none})"
                        ;;
                esac
            fi
        fi

        if [ "$feature_status" = "passed" ]; then
            # claudecode-orchestrator-inspired: optional per-feature-pass
            # smoke gate. If the smoke test fails, revert this feature to
            # `failing` so the orchestrator retries — do not run documenter
            # or merge on a broken app.
            if [ "$(config_get 'smokeTest.enabled' 'false')" = "true" ] && \
               [ "$(config_get 'smokeTest.onFeaturePass' 'false')" = "true" ]; then
                log "SMOKE $fid starting (onFeaturePass)"
                if PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" \
                   HARNESS_DIR="$HARNESS_DIR" \
                   "$HARNESS_DIR/bin/service-smoke-test.sh" 2>&1 | tee -a "$LOG_DIR/run.log"; then
                    log "SMOKE $fid passed"
                    TRIGGER="onFeaturePass" FEATURE_ID="$fid" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-smoke-pass
                else
                    log "SMOKE $fid failed — reverting $fid to failing"
                    feature_set_status "$fid" "failing"
                    feature_status="failing"
                    TRIGGER="onFeaturePass" FEATURE_ID="$fid" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-smoke-fail
                fi
            fi
        fi

        if [ "$feature_status" = "passed" ]; then
            log "DOCUMENTER $fid starting (post-pass)"
            documenter_out="$(invoke documenter "FEATURE_ID=$fid")"
            log "DOCUMENTER: ${documenter_out:-(no output)}"
            FEATURE_ID="$fid" STATUS="passed" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-feature-passed

            # Optional: UI QA pass for UI features (has VAL-UI-* claims)
            if [ "$(config_get 'uiQa.enabled' 'false')" = "true" ]; then
                has_ui_claim="$(FID="$fid" STATE_DIR="$STATE_DIR" python3 -c '
import json, os
try:
    d = json.load(open(os.path.join(os.environ["STATE_DIR"], "features.json")))
    feats = d["features"] if isinstance(d, dict) else d
    for f in feats:
        if f.get("id") == os.environ["FID"]:
            for c in (f.get("claims") or []):
                if c.startswith("VAL-UI-"):
                    print("yes"); break
            break
except Exception:
    pass
' 2>/dev/null)"
                if [ "$has_ui_claim" = "yes" ] && command -v verdict >/dev/null 2>&1; then
                    log "UI-QA $fid starting"
                    uiqa_out="$(invoke ui-qa "FEATURE_ID=$fid")"
                    case "$uiqa_out" in
                        "UIQA_FAIL"*)
                            log "⚠ UI QA failed for $fid — reverting to failing"
                            feature_set_status "$fid" "failing"
                            ;;
                        "UIQA_PASS"*)
                            log "UI QA confirms $fid passes visual assertions"
                            ;;
                    esac
                fi
            fi
        elif [ "$feature_status" = "failing" ]; then
            FEATURE_ID="$fid" STATUS="failing" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-feature-failing
        fi
        ;;

    CONVERTED*)
        log "Orchestrator converted issues to fix features. Continuing."
        ;;

    NEXT_ARCHITECT*)
        # Format: NEXT_ARCHITECT F-xxx <reason>
        rest="${decision##NEXT_ARCHITECT }"
        fid="${rest%% *}"
        reason="${rest#* }"
        [ "$fid" = "$reason" ] && reason="(no reason given)"
        log "ARCHITECT $fid starting — reason: $reason"
        mkdir -p "$STATE_DIR/pending-reviews"
        arch_out="$(invoke architect "FEATURE_ID=$fid" "REASON=$reason")"
        arch_verdict="$(printf '%s\n' "$arch_out" | grep -E '^(PATCH|REVIEW) ' | tail -1)"
        log "ARCHITECT verdict: ${arch_verdict:-(none)}"
        case "$arch_verdict" in
        PATCH*)
            # Architect already wrote the patch inline. Mark the feature as
            # todo with attempts=0 so the worker retries with the tightened
            # contract. The architect.md prompt requires the feature stay
            # untouched, so we reset here.
            FID="$fid" STATE_DIR="$STATE_DIR" python3 -c '
import json, os, sys
p = os.path.join(os.environ["STATE_DIR"], "features.json")
try:
    d = json.load(open(p))
    feats = d["features"] if isinstance(d, dict) else d
    for f in feats:
        if f.get("id") == os.environ["FID"]:
            f["status"] = "todo"
            f["attempts"] = 0
            break
    json.dump(d, open(p, "w"), indent=2)
except Exception as e:
    sys.stderr.write(f"architect-reset failed: {e}\n")
' 2>> "$LOG_DIR/run.log"
            log "ARCHITECT patched spec for $fid; reset to todo."
            ;;
        REVIEW*)
            # Mark the feature `blocked` so orchestrator skips it until the
            # human resolves the pending review.
            FID="$fid" STATE_DIR="$STATE_DIR" python3 -c '
import json, os, sys
p = os.path.join(os.environ["STATE_DIR"], "features.json")
try:
    d = json.load(open(p))
    feats = d["features"] if isinstance(d, dict) else d
    for f in feats:
        if f.get("id") == os.environ["FID"]:
            f["status"] = "blocked"
            break
    json.dump(d, open(p, "w"), indent=2)
except Exception as e:
    sys.stderr.write(f"architect-block failed: {e}\n")
' 2>> "$LOG_DIR/run.log"
            log "ARCHITECT queued review for $fid; blocked until resolved."
            notify_event review-pending "$fid needs human input"
            ;;
        *)
            log "ARCHITECT produced no actionable verdict; leaving $fid untouched."
            ;;
        esac
        ;;

    NEXT_EXPERT*)
        # Format: NEXT_EXPERT EXP-NNN
        # The expert is an instanced role: identity + state lives in
        # .harness/experts/<EXP-id>/. We pass FEATURE_ID=<EXP-id> so the
        # invoke() pipeline picks it up (assembleRolePrompt detects EXP-
        # prefix and injects EXPERT_DIR / EXPERT_SPEC into the runtime
        # context). The expert reads identity.json itself.
        eid="${decision##NEXT_EXPERT }"
        [ "$eid" = "NEXT_EXPERT" ] && eid=""
        if [ -z "$eid" ]; then
            log "ERROR: NEXT_EXPERT missing expert id"
        else
            log "EXPERT $eid starting"
            invoke expert "FEATURE_ID=$eid" "EXPERT_ID=$eid" >/dev/null
            log "EXPERT $eid iteration complete"
        fi
        ;;

    NEXT_FEEDBACK*)
        # Format: NEXT_FEEDBACK EXP-NNN.FB-NNN  (separator is `.` because
        # the orchestrator regex's char class is [A-Za-z0-9_.-]; `/` and
        # `:` would not match.)
        fb_arg="${decision##NEXT_FEEDBACK }"
        [ "$fb_arg" = "NEXT_FEEDBACK" ] && fb_arg=""
        eid="${fb_arg%%.*}"
        fbid="${fb_arg##*.}"
        if [ -z "$eid" ] || [ -z "$fbid" ] || [ "$eid" = "$fbid" ]; then
            log "ERROR: NEXT_FEEDBACK expects EXP-NNN.FB-NNN; got '$fb_arg'"
        else
            # Read the assigned persona from disk so the feedback agent's
            # runtime context knows which lens to use.
            persona=""
            persona_path="$STATE_DIR/experts/$eid/feedback/$fbid/persona.txt"
            if [ -f "$persona_path" ]; then
                persona="$(cat "$persona_path")"
            fi
            log "FEEDBACK $eid/$fbid starting (persona=$persona)"
            invoke feedback "FEEDBACK_ID=$fbid" "EXPERT_ID=$eid" "FEEDBACK_PERSONA=$persona" >/dev/null
            log "FEEDBACK $eid/$fbid iteration complete"
        fi
        ;;

    NEXT_SCOPER*)
        # Format: NEXT_SCOPER  (no arg, defaults to phase1) or  NEXT_SCOPER phase2
        # Re-invokes the scoper. In phase2 mode the scoper derives features
        # from finalized experts. Idempotent — re-running with no new
        # finalizations is a no-op.
        sc_phase="${decision##NEXT_SCOPER }"
        [ "$sc_phase" = "NEXT_SCOPER" ] && sc_phase=""
        log "SCOPER starting${sc_phase:+ (phase=$sc_phase)}"
        if [ -n "$sc_phase" ]; then
            invoke scoper "SCOPER_PHASE=$sc_phase" >/dev/null
        else
            invoke scoper >/dev/null
        fi
        log "SCOPER complete"
        ;;

    NEXT_TESTER*)
        val_id="${decision##NEXT_TESTER }"
        [ "$val_id" = "NEXT_TESTER" ] && val_id=""
        log "TESTER starting${val_id:+ for $val_id}"
        tester_out="$(invoke tester "VAL_ID=$val_id")"
        log "TESTER: ${tester_out:-(no output)}"
        ;;

    NEXT_SECURITY*)
        log "SECURITY sweep starting"
        mkdir -p "$STATE_DIR/security"
        sec_out="$(invoke security-reviewer)"
        log "SECURITY: ${sec_out:-(no output)}"
        ;;

    GENERATE_TESTS*)
        log "TEST_WRITER edge-case expansion starting"
        tw_out="$(invoke test-writer)"
        log "TEST_WRITER: ${tw_out:-(no output)}"
        ;;

    RUN_TESTS*)
        log "RUN_TESTS invoked (testing phase)"
        # Delegate to a helper the API can also call. For now, just log — the
        # API endpoint /tests/run-all is the canonical runner; here we emit a
        # trace so the orchestrator knows its decision was captured.
        if [ -x "$HARNESS_DIR/bin/run-tests.sh" ]; then
            "$HARNESS_DIR/bin/run-tests.sh" "$PROJECT_DIR" 2>&1 | tee -a "$LOG_DIR/run.log" || true
        else
            log "  (bin/run-tests.sh not implemented yet — skipping)"
        fi
        ;;

    NEXT_MONITOR*)
        log "MONITOR health sweep starting (production phase)"
        mon_out="$(invoke monitor)"
        log "MONITOR: ${mon_out:-(no output)}"
        ;;

    FEATURE_FREEZE*)
        # Staging orchestrator reports it's either updating or completing the
        # freeze. No action required here — the promotion item state is what
        # the API surfaces to the UI.
        log "FEATURE_FREEZE: ${decision}"
        ;;

    READY_FOR_PROD*)
        # Testing orchestrator reports all tests green + security clear.
        # Writes a flag file the API picks up to flip the promotion item
        # status to 'ready'.
        date > "$STATE_DIR/ready-for-prod.flag"
        log "READY_FOR_PROD — flag written for promotion pipeline."
        ;;

    IDLE*)
        log "IDLE — sleeping before next iteration"
        sleep 30
        ;;

    ESCALATE*)
        reason="${decision##ESCALATE }"
        log "⛔ ESCALATED: $reason"
        log "See $STATE_DIR/escalation.md for details."
        REASON="$reason" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-escalate
        log "Running curator to distill run memory before exit."
        curator_out="$(invoke curator "TRIGGER=escalate" "REASON=$reason")"
        log "CURATOR: ${curator_out:-(no output)}"
        notify_event escalate "$reason"
        exit 3
        ;;

    CHECKPOINT*)
        # Hermes-inspired named checkpoint. Orchestrator emits `CHECKPOINT <name> [message]`.
        # We pause mission until a human grants the checkpoint via the UI.
        cp_rest="${decision##CHECKPOINT }"
        cp_name="${cp_rest%% *}"
        cp_message="${cp_rest#* }"
        [ "$cp_name" = "$cp_message" ] && cp_message=""
        if [ -z "$cp_name" ]; then
            log "CHECKPOINT emitted without name — treating as unnamed escalation."
            cp_name="unnamed"
        fi
        cp_file="$STATE_DIR/checkpoint-${cp_name}.md"
        cat > "$cp_file" <<EOF_CHECKPOINT
# Checkpoint: ${cp_name}

Requested at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Iteration: $iteration

${cp_message}

## How to grant
Grant via UI, or create \`${cp_file}.granted\`:
\`\`\`
touch ${cp_file}.granted
\`\`\`
Then re-run the harness — it will detect the grant file, delete it and the checkpoint,
and continue.
EOF_CHECKPOINT
        log "⏸  CHECKPOINT '$cp_name' requested. See $cp_file"
        CHECKPOINT_NAME="$cp_name" TRIGGER="orchestrator" PROJECT_DIR="$PROJECT_DIR" STATE_DIR="$STATE_DIR" run_hook on-checkpoint-fired
        notify_event checkpoint "Checkpoint requested: $cp_name"
        exit 8
        ;;

    NEXT_HARNESS*)
        # Cross-harness dispatch (harness-of-harnesses).
        # Format: NEXT_HARNESS <child-slug> [--role=<role>] [extra args]
        nh_args="${decision##NEXT_HARNESS }"
        child_slug="${nh_args%% *}"
        nh_rest="${nh_args#* }"
        [ "$nh_rest" = "$nh_args" ] && nh_rest=""
        child_role="orchestrator"
        for arg in $nh_rest; do
            case "$arg" in
                --role=*) child_role="${arg#--role=}" ;;
            esac
        done
        log "NEXT_HARNESS $child_slug --role=$child_role"

        # Try the API first (preferred — gets full Hono context + auth).
        # Fall back to direct shell exec if API unreachable.
        operator_base="${PAPERCUSP_OPERATOR_BASE:-http://localhost:3055}"
        api_url="${operator_base}/api/harness/${child_slug}/invoke?role=${child_role}"
        if curl -sf -X POST -H 'content-type: application/json' --max-time 120 -d '{}' "$api_url" -o "$LOG_DIR/nexth-${child_slug}-$(date +%s).json" 2>/dev/null; then
            log "  → dispatched via API ($api_url)"
        else
            log "  → API unreachable, falling back to direct shell exec"
            api_resp="$(curl -sf --max-time 3 "${operator_base}/api/harness/projects" 2>/dev/null || true)"
            child_path=""
            if [ -n "$api_resp" ]; then
                child_path="$(printf '%s' "$api_resp" | SLUG="$child_slug" python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
    for p in d.get("projects", []):
        if p.get("slug") == os.environ["SLUG"]:
            print(p.get("path", "")); sys.exit(0)
except Exception:
    pass
' 2>/dev/null)"
            fi
            if [ -z "$child_path" ] && [ -f "$HOME/.restart-harness-projects.json" ]; then
                child_path="$(REGISTRY=$HOME/.restart-harness-projects.json SLUG=$child_slug python3 -c '
import json, os, sys
try:
    d = json.load(open(os.environ["REGISTRY"]))
    for p in d.get("projects", []):
        if p.get("slug") == os.environ["SLUG"]:
            print(p.get("path", "")); sys.exit(0)
except Exception:
    pass
' 2>/dev/null)"
            fi
            if [ -z "$child_path" ] || [ ! -d "$child_path" ]; then
                log "  ERROR: child harness path not found for slug '$child_slug'"
                log "  Operator API ($operator_base/api/harness/projects) and legacy ~/.restart-harness-projects.json both missed"
            else
                ( cd "$child_path" && PROJECT_DIR="$child_path" MAX_ITERATIONS=1 bash "$HARNESS_DIR/run.sh" ) 2>&1 | tee -a "$LOG_DIR/run.log" | head -100
            fi
        fi
        ;;

    *)
        log "ERROR: orchestrator returned unparsable decision: '$decision'"
        log "Aborting. Inspect $LOG_DIR and $STATE_DIR, then rerun."
        exit 4
        ;;
    esac

    # Snapshot state for possible rollback via UI.
    snapshot_state "$iteration"

    # Prune oldest agent logs once we exceed config.logRetention (default 500).
    prune_logs

    # Cost accounting + cap (config.json → maxCostUsd). Exits 6 if over.
    check_cost_cap

    # Optional: scoper proposal trigger when mission is near-done (>= threshold passed).
    # Fires at most once per mission via a sentinel file.
    proposals_enabled="$(config_get 'proposals.enabled' "$(config_get 'product.enabled' 'false')")"
    near_done_enabled="$(config_get 'proposals.nearDoneEnabled' "$(config_get 'product.triggerOnNearDone' 'true')")"
    if [ "$proposals_enabled" = "true" ] && \
       [ "$near_done_enabled" = "true" ] && \
       [ -f "$PROJECT_DIR/SPEC.md" ] && \
       [ ! -f "$STATE_DIR/.product-near-done-fired" ]; then
        threshold_pct="$(config_get 'proposals.nearDoneThreshold' "$(config_get 'product.nearDoneThreshold' '0.8')")"
        pct_passed="$(STATE_DIR="$STATE_DIR" python3 -c '
import json, os
try:
    d = json.load(open(os.path.join(os.environ["STATE_DIR"], "features.json")))
    feats = d["features"] if isinstance(d, dict) else d
    n = len(feats)
    passed = sum(1 for f in feats if f.get("status") == "passed")
    print(passed / n if n > 0 else 0)
except Exception:
    print(0)
' 2>/dev/null)"
        # Compare floats in python
        fire_it="$(python3 -c "print(1 if float('$pct_passed') >= float('$threshold_pct') else 0)" 2>/dev/null)"
        if [ "$fire_it" = "1" ]; then
            mkdir -p "$STATE_DIR/proposals"
            log "SCOPER starting (near-done threshold $threshold_pct reached, $(printf '%.0f%%' "$(python3 -c "print(float('$pct_passed')*100)")") passed, proposal mode)"
            product_out="$(invoke scoper "MODE=proposal")"
            log "SCOPER: ${product_out:-(no output)}"
            auto_apply="$(config_get 'proposals.autoApply' '')"
            if [ -z "$auto_apply" ]; then
                legacy_mode="$(config_get 'product.mode' 'auto-apply')"
                [ "$legacy_mode" = "propose-only" ] && auto_apply="false" || auto_apply="true"
            fi
            if [ "$auto_apply" != "false" ]; then
                review_pending_proposals
            fi
            touch "$STATE_DIR/.product-near-done-fired"
        fi
    fi

    # Phase 3: clear lanes at iteration end. Lane rows are per-iteration
    # ephemeral; the next iteration's invoke() calls will repopulate them.
    # Backgrounded so the loop never blocks on a status-write hiccup.
    {
        _phase3_clear_slug="$(harness_slug 2>/dev/null || echo unknown)"
        pg_clear_lanes "$_phase3_clear_slug" "${PAPERCUSP_PHASE:-staging}" 2>/dev/null || true
    } &

    # Polite backoff between iterations.
    sleep "${ITERATION_SLEEP:-2}"
done

log "Hit MAX_ITERATIONS=$MAX_ITERATIONS without converging. Exiting."
notify_event max-iter "Hit MAX_ITERATIONS=$MAX_ITERATIONS without converging"
exit 5
