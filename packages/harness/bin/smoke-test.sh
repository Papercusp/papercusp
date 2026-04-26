#!/usr/bin/env bash
# Standalone smoke test: runs just the planner in a scratch dir, verifies it
# produced a contract + features.json. Costs < $0.05.

set -eu
HARNESS_DIR="${HARNESS_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
CLAUDE="${CLAUDE:-claude -p}"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

echo "Testing in $TEST_DIR"
cd "$TEST_DIR"

cat > SPEC.md <<'EOF'
# Spec

## Goal
A POST /echo endpoint that accepts JSON `{msg:string}` and returns `{ok:true,msg}`.

## Acceptance bar
- curl POST /echo with `{"msg":"hi"}` → `{"ok":true,"msg":"hi"}` HTTP 200.
- curl POST /echo with empty body → HTTP 400.
- curl POST /echo with non-JSON body → HTTP 400.
EOF

mkdir -p .harness
{
    cat "$HARNESS_DIR/prompts/planner.md"
    echo
    echo "---"
    echo "## Runtime context"
    echo "- Working directory: $TEST_DIR"
    echo "- State directory: $TEST_DIR/.harness"
} | $CLAUDE --dangerously-skip-permissions > /tmp/planner-smoke.out 2>&1

echo "--- stdout (last 5 lines) ---"
tail -5 /tmp/planner-smoke.out

echo "--- artifacts ---"
if [ -f .harness/validation-contract.md ] && [ -f .harness/features.json ]; then
    echo "✅ planner produced both artifacts"
    echo
    echo "--- validation-contract.md (head 20) ---"
    head -20 .harness/validation-contract.md
    echo
    echo "--- features.json ---"
    cat .harness/features.json
    exit 0
else
    echo "❌ planner FAILED to produce artifacts"
    ls -la .harness/ 2>/dev/null || echo "(no .harness dir at all)"
    exit 1
fi
