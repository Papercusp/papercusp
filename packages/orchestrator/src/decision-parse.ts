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
  'NEXT_PROJECT_MANAGER',
  'NEXT_SUMMARIZER',
  'NEXT_TESTER',
  'NEXT_SECURITY',
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
