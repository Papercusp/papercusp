/**
 * Parse the orchestrator's decision string. Mirrors bash:
 *
 *   sed -E 's/[*`]+//g; s/^[[:space:]]+//; s/[[:space:]]+$//' \
 *   | grep -oE '(DONE|CONVERTED|NEXT_WORKER_CEO_MODE|NEXT_WORKER|...|CHECKPOINT)([[:space:]]+[A-Za-z0-9_.-]+)?' \
 *   | tail -1
 *
 * The orchestrator prompt instructs the agent to end with one of these
 * verbs; in practice LLMs sometimes wrap them in markdown emphasis
 * (`**NEXT_WORKER F-001**`) or code fences (\`\`\`NEXT_WORKER F-001\`\`\`).
 * Strip those decorations before matching. Return the *last* match in case
 * the agent emits multiple decisions (rare but observed).
 */

/**
 * Recognized decision verbs. Order matters in the regex below — longer
 * prefixes must come first (NEXT_WORKER_CEO_MODE before NEXT_WORKER).
 */
export const DECISION_VERBS = [
  'NEXT_WORKER_CEO_MODE',
  'NEXT_WORKER',
  'NEXT_VALIDATOR',
  'NEXT_ARCHITECT',
  'NEXT_TESTER',
  'NEXT_SECURITY',
  'NEXT_EXPERT',
  'NEXT_FEEDBACK',
  'NEXT_SCOPER',
  'GENERATE_TESTS',
  'RUN_TESTS',
  'NEXT_MONITOR',
  'READY_FOR_PROD',
  'FEATURE_FREEZE',
  'NEXT_HARNESS',
  'CONVERTED',
  'CHECKPOINT',
  'ESCALATE',
  'IDLE',
  'DONE',
] as const;

export type DecisionVerb = typeof DECISION_VERBS[number];

export interface ParsedDecision {
  /** The decision verb. */
  verb: DecisionVerb;
  /** Optional argument (feature id, harness slug, etc.). null when absent. */
  arg: string | null;
  /**
   * Optional adaptive-mode worker count. Set by `NEXT_WORKER F-X N=k`
   * (parsed case-insensitively). null when the verb didn't include an
   * `N=` token. Validated against the configured tier set in the
   * adaptive handler — invalid values clamp to the smallest tier.
   */
  n: number | null;
  /** The exact line that matched (post-stripping). */
  raw: string;
}

const DECISION_RE = new RegExp(
  // Match: VERB [arg] [N=<int>]
  // The N= token is optional and case-insensitive (LLMs sometimes emit n=2).
  '(' + DECISION_VERBS.join('|') + ')(?:\\s+([A-Za-z0-9_.-]+))?(?:\\s+[Nn]=([0-9]+))?',
  'g',
);

/**
 * Parse the agent's free-form output and extract the last decision verb
 * (with optional argument). Returns null if no recognized verb appears.
 *
 *   parseDecision('Some thinking…\n**NEXT_WORKER F-001**\n')
 *   // → { verb: 'NEXT_WORKER', arg: 'F-001', raw: 'NEXT_WORKER F-001' }
 *
 *   parseDecision('done')
 *   // → null  (case-sensitive: must be uppercase DONE)
 */
export function parseDecision(text: string): ParsedDecision | null {
  // Strip markdown emphasis + code fences, then trim each line.
  const cleaned = text
    .replace(/[*`]+/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join('\n');

  let lastMatch: ParsedDecision | null = null;
  // matchAll replays the regex across the full text.
  for (const m of cleaned.matchAll(DECISION_RE)) {
    const nStr = m[3];
    const n = nStr ? parseInt(nStr, 10) : null;
    lastMatch = {
      verb: m[1] as DecisionVerb,
      arg: m[2] ?? null,
      n: Number.isFinite(n) && n !== null && n > 0 ? n : null,
      raw: (m[0] ?? '').trim(),
    };
  }
  return lastMatch;
}

/**
 * Verbs that may NOT appear in a multi-decision batch — they imply a
 * state change other dispatched items would race against, so they
 * have to be the sole decision in their turn. Anything not in this
 * set (currently only NEXT_WORKER) can batch.
 */
const SOLO_VERBS = new Set<DecisionVerb>([
  'NEXT_VALIDATOR',
  'NEXT_ARCHITECT',
  'NEXT_TESTER',
  'NEXT_SECURITY',
  'NEXT_EXPERT',
  'NEXT_FEEDBACK',
  'NEXT_SCOPER',
  'GENERATE_TESTS',
  'RUN_TESTS',
  'NEXT_MONITOR',
  'READY_FOR_PROD',
  'FEATURE_FREEZE',
  'NEXT_HARNESS',
  'NEXT_WORKER_CEO_MODE',
  'CONVERTED',
  'CHECKPOINT',
  'ESCALATE',
  'IDLE',
  'DONE',
]);

/**
 * Parse a multi-decision batch. The orchestrator MAY emit multiple
 * decisions in one turn for batchable verbs (NEXT_WORKER on independent
 * features) wrapped in a `DECISIONS … END` envelope:
 *
 *   DECISIONS
 *   NEXT_WORKER F-AUTH-001
 *   NEXT_WORKER F-PAY-007 N=2
 *   NEXT_WORKER F-DOCS-012
 *   END
 *
 * If no envelope is present, falls back to single-decision parsing
 * (parseDecision) and wraps the result in a 1-element array. Returns
 * an empty array on any parse failure.
 *
 * Validation:
 *   - SOLO_VERBS may not appear in a batch with other decisions. If
 *     a batch contains any solo verb, the whole batch is rejected
 *     (returns []). Solo decisions emitted alone — with or without
 *     the envelope — are accepted.
 *   - Duplicate feature ids in the same batch are rejected (return []).
 *   - Empty envelope (DECISIONS … END with nothing between) returns [].
 */
export function parseDecisions(text: string): ParsedDecision[] {
  const cleaned = text.replace(/[*`]+/g, '');
  const envelope =
    /(?:^|\n)\s*DECISIONS\s*\n([\s\S]*?)\n\s*END\b/m.exec(cleaned);
  if (!envelope) {
    // No envelope: treat as legacy single decision.
    const single = parseDecision(text);
    return single ? [single] : [];
  }
  const body = envelope[1];
  const parsed: ParsedDecision[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const decision = parseDecision(line);
    if (!decision) continue; // ignore non-decision lines (comments)
    parsed.push(decision);
  }
  if (parsed.length === 0) return [];

  // If the batch is a single decision, allow solo verbs.
  if (parsed.length === 1) return parsed;

  // Multi-decision batch: every entry must be batchable.
  const hasSolo = parsed.some((d) => SOLO_VERBS.has(d.verb));
  if (hasSolo) return [];

  // Reject duplicate feature ids.
  const seenArgs = new Set<string>();
  for (const d of parsed) {
    if (d.arg) {
      if (seenArgs.has(d.arg)) return [];
      seenArgs.add(d.arg);
    }
  }

  return parsed;
}
