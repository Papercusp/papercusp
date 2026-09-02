/**
 * EI-10946 — THE SPINE MUST NEVER ADVERTISE A CREATE AND HIDE ITS UNDO.
 *
 * The seeded tool surface (`CORE_MCP_TOOL_NAMES`) is a SUBSET of the ~581-tool catalog. A
 * trimmed client's tool-search only sees that subset, so a zero-hit search is
 * INDISTINGUISHABLE from "the tool does not exist" — and agents, correctly trusting the
 * system, conclude the capability is absent and build a strictly-worse workaround.
 *
 * This has now happened five times, each fixed by seeding the missing verb:
 *   EI-6770  session:request-compaction — agent self-halted rather than compact
 *   EI-8597  loop:end / loop:status     — worker couldn't stop its own loop
 *   EI-9012  events:await / emit        — built a blind poll loop the persona forbids
 *   EI-9034  events:catalog             — same
 *   EI-21345492095209440 events:cancel  — a seeded await could not be retracted directly
 *   EI-10946 work_items:comment/update, facts:retract — agent abused work_items:checkpoint
 *            as an erratum channel, and abandoned retracting a stale fact that kept telling
 *            every future orient to redo finished work
 *
 * The pattern is always the same shape: the spine carried the WRITE but not the CORRECTION.
 * So this test encodes the invariant rather than the individual fixes — if you seed a verb
 * that creates or mutates durable state, seed the verb that undoes/corrects it too, or the
 * next agent's only reachable option is the workaround.
 *
 * Demand-evidence call counts CANNOT arbitrate this: a tool nobody can see is a tool nobody
 * calls, so the metric measures the discoverability bug rather than the need. (work_items:update
 * was cut at "104 calls/7d" with the rationale "set_state + comment cover the common cases" —
 * while comment itself was not seeded either.)
 */
import { describe, expect, it } from 'vitest';
import { CORE_MCP_TOOL_NAMES } from './invoke';

/** write verb in the spine → the verb that corrects/undoes it, which must ALSO be in the spine. */
const REQUIRED_INVERSES: ReadonlyArray<readonly [string, string, string]> = [
  ['facts:assert', 'facts:retract', 'a standing fact folds VERBATIM into every orient forever; retract is its only exit'],
  ['work_items:create', 'work_items:update', 'correcting a wrong BODY — what every future reader and brief inherits'],
  ['work_items:create', 'work_items:comment', 'annotating an item without rewriting it'],
  ['loop:arm', 'loop:end', 'an armed loop that cannot be stopped burns wakes forever'],
  ['events:await', 'events:cancel', 'a registered await must be retractable before it fires'],
];

describe('core spine — every seeded write verb has its correction verb seeded too (EI-10946)', () => {
  const seed = new Set(CORE_MCP_TOOL_NAMES);

  it.each(REQUIRED_INVERSES)(
    'seeding %s requires seeding %s (%s)',
    (writeVerb, inverseVerb, why) => {
      if (!seed.has(writeVerb)) return; // the write verb isn't seeded — nothing to require.
      expect(
        seed.has(inverseVerb),
        `CORE_MCP_TOOL_NAMES seeds "${writeVerb}" but NOT "${inverseVerb}".\n` +
          `Why that matters: ${why}.\n` +
          `A trimmed client cannot see "${inverseVerb}" — its tool-search reports "not found", which is\n` +
          `indistinguishable from "does not exist" — so the agent builds a workaround instead (EI-10946).\n` +
          `Seed the inverse, or remove "${writeVerb}" from the spine.`,
      ).toBe(true);
    },
  );

  it('the specific verbs whose absence caused EI-10946 are in the spine', () => {
    expect(seed.has('work_items:comment')).toBe(true);
    expect(seed.has('work_items:update')).toBe(true);
    expect(seed.has('facts:retract')).toBe(true);
  });

  it('the spine stays SMALL — it is a seed, not a catalog (the whole point of trimming)', () => {
    // Guard against the opposite failure: "just seed everything" would restore the ~165k-token
    // load the trim exists to avoid. If this trips, justify the growth or use tools:find.
    //
    // 46 -> 47 on 2026-09-02: coord:dispatch (WI-2142095 / P-011). Justification and the
    // full ratchet history live on the twin assertion in invoke.test.ts — keep the two
    // numbers in step. Its correction half is already seeded (work_items:release), so this
    // addition does not create the EI-10946 asymmetry the rest of this file guards.
    expect(CORE_MCP_TOOL_NAMES.length).toBeLessThanOrEqual(47);
  });

  it('has no duplicate entries (a hand-maintained list that has been edited many times)', () => {
    expect(CORE_MCP_TOOL_NAMES.length).toBe(new Set(CORE_MCP_TOOL_NAMES).size);
  });
});
