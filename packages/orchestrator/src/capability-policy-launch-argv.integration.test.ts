/**
 * INTEGRATION (launch surface): the ONE capability policy must reach the argv of
 * a REAL spawned process, via the REAL `invoke()` — plan
 * managed-agent-capability-contract-and-native-cutover-2026-09-13 P-005.
 *
 * ## Why this file exists — what no other test can say
 *
 * Three layers already touch this subject and NONE of them proves the claim:
 *
 *  - `managed-capability-policy.test.ts` (unit) proves the POLICY TABLE resolves
 *    the right restriction set for a client/surface/audience. It imports the
 *    module directly, so it is silent on whether any caller uses the result.
 *  - `psu-launcher-capability-policy-pin.test.ts` (unit, operator-core) pins the
 *    launcher's hand-written LITERALS against the policy. Its own header states
 *    the limit verbatim: "It does NOT prove either launch site actually PUSHES
 *    every literal it holds: a site that simply forgets one still passes here."
 *  - the argv test in `invoke.test.ts` does reach real argv, but asserts a
 *    HAND-LISTED pair (scheduler + subagent). A restriction added to the policy
 *    and forgotten at this call site stays green there forever.
 *
 * That gap is not hypothetical — it is the exact defect P-005 was opened for.
 * The launch site pushed four restrictions while the WAKE site pushed three, so
 * `notify-send` was denied at every launch and silently regained on the first
 * wake. Each site read healthy in isolation, which is why nothing caught it.
 *
 * ## The property under test
 *
 * The expectation is DERIVED FROM THE POLICY, never hand-listed: every flag
 * `capabilityPolicyFlags(...)` emits for this client/surface/audience must
 * appear as an exact argv token in the command line a real process actually
 * received. So a restriction added to the policy and not consumed here FAILS
 * this test on the day it is added, rather than lapsing quietly.
 *
 * ## Why this is the integration layer and not a unit test
 *
 * Nothing is mocked. `invoke()` runs its real resolution chain (backend
 * selection, role/model resolution, sandbox args, MCP args, the claude
 * discriminator) and execs a real subprocess; the stub agent prints its own
 * argv, so the bytes asserted on are the bytes the kernel delivered — not a
 * value returned by the module under test. A unit test cannot observe that,
 * because argv only exists once a process is spawned.
 */
import { test, beforeEach, afterEach } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invoke } from './invoke';
import {
  capabilityPolicyFlags,
  capabilityRetentionCensus,
  resolveCapabilityPolicy,
} from './managed-capability-policy';

// Host identity must not decide what this measures: AGENT_CMD / CLAUDE /
// AGENT_BACKEND make invoke() resolve the caller's live backend instead of the
// fixture stub, and the model/capability keys shift the committed defaults.
// Same scrub list and rationale as invoke.test.ts (EI-942 env isolation).
const SESSION_ENV_KEYS = [
  'AGENT_BACKEND',
  'AGENT_CMD',
  'AGENT_MODELS',
  'CLAUDE',
  'PAPERCUSP_INTEGRATION_ROOT',
  'PAPERCUSP_SPAWN_BACKEND',
  'PAPERCUSP_SPAWN_MODEL',
  'HARNESS_CONFIG_JSON',
  'PAPERCUSP_FLEET_CAPABILITY_ONLY',
  'PAPERCUSP_FLEET_SANDBOX',
  'PAPERCUSP_FLEET_SANDBOX_ALLOWED_DOMAINS',
  'PAPERCUSP_FLEET_SANDBOX_DENY_ALL_EGRESS',
] as const;
const envSnapshot: Partial<Record<(typeof SESSION_ENV_KEYS)[number], string | undefined>> = {};
beforeEach(() => {
  for (const k of SESSION_ENV_KEYS) {
    envSnapshot[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of SESSION_ENV_KEYS) {
    const prior = envSnapshot[k];
    if (prior === undefined) delete process.env[k];
    else process.env[k] = prior;
  }
});

function makeFixture(): {
  harnessDir: string;
  projectDir: string;
  stateDir: string;
  logDir: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'papercusp-cap-policy-launch-'));
  const harnessDir = join(root, 'harness');
  const projectDir = join(root, 'project');
  const stateDir = join(projectDir, '.papercusp');
  const logDir = join(stateDir, 'logs');
  mkdirSync(join(harnessDir, 'blueprints', 'base', 'prompts'), { recursive: true });
  mkdirSync(join(harnessDir, 'identity'), { recursive: true });
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(harnessDir, 'blueprints', 'base', 'prompts', 'worker.md'), '# WORKER');
  return {
    harnessDir,
    projectDir,
    stateDir,
    logDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Spawn a real headless claude-named agent and return the argv it received. */
async function spawnAndCaptureArgv(): Promise<string[]> {
  const fx = makeFixture();
  try {
    // The stub's PATH must NAME claude: both the backend resolution and the
    // policy discriminator in invoke.ts key on the command naming claude. It
    // prints its own argv, so what we assert on is what the kernel delivered.
    const binDir = join(fx.projectDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const stub = join(binDir, 'claude');
    writeFileSync(stub, '#!/bin/sh\nprintf "%s\\n" "$@"\ncat >/dev/null\n', { mode: 0o755 });
    const result = await invoke(
      {
        harnessDir: fx.harnessDir,
        projectDir: fx.projectDir,
        stateDir: fx.stateDir,
        logDir: fx.logDir,
        phase: 'staging',
        claudeCmd: stub,
        dept: '',
        log: () => {},
        nowSeconds: () => 1700000002,
      },
      'worker',
      [],
    );
    assert.equal(result.exitCode, 0, 'fixture spawn did not exit cleanly');
    return readFileSync(result.jsonlPath, 'utf8').split('\n');
  } finally {
    fx.cleanup();
  }
}

test('invoke — a real headless claude spawn carries EVERY policy flag in its argv', async () => {
  const expected = capabilityPolicyFlags({
    client: 'claude',
    surface: 'launch',
    audience: 'headless-agent',
    explicitDenyList: false,
  });

  // CALIBRATION — without this the assertion loop below is vacuous: an empty
  // policy would make every `includes` check pass by never running. This is the
  // same false-green class as a name filter matching zero tests, and it is the
  // one failure mode a green run of this file could otherwise hide.
  assert.ok(
    expected.length >= 2,
    `capabilityPolicyFlags emitted ${expected.length} flag(s) for the headless launch surface — ` +
      'the assertion below would be vacuous. Either the policy regressed to empty, or this ' +
      'calibration needs updating alongside a deliberate policy change.',
  );

  const argvTokens = await spawnAndCaptureArgv();

  const missing = expected.filter((flag) => !argvTokens.includes(flag));
  assert.deepEqual(
    missing,
    [],
    `invoke() did not push ${missing.length} policy flag(s) into the spawned argv.\n` +
      `MISSING: ${JSON.stringify(missing)}\n` +
      `The policy resolves these for {claude,launch,headless-agent}, so this call site ` +
      `is consuming the policy incompletely — the P-005 drift class.\n` +
      `ACTUAL ARGV:\n${argvTokens.join('\n')}`,
  );
});

test('invoke — every policy flag reaches argv as ONE `=` token, never the variadic space form', async () => {
  // D-002: claude's `--disallowedTools A B C` form is variadic and would swallow
  // the positional prompt. The policy emits single `=` tokens; this asserts the
  // call site preserves that shape through argv construction rather than
  // re-splitting them, which would corrupt the spawn while still "containing"
  // every flag by substring.
  const expected = capabilityPolicyFlags({
    client: 'claude',
    surface: 'launch',
    audience: 'headless-agent',
    explicitDenyList: false,
  });
  assert.ok(expected.length >= 2, 'calibration: policy emitted too few flags to test shape');

  const argvTokens = await spawnAndCaptureArgv();
  for (const flag of expected) {
    if (!flag.startsWith('--')) continue;
    assert.ok(
      flag.includes('='),
      `policy emitted a non-\`=\` flag token (${flag}) — the variadic form eats positionals (D-002)`,
    );
    // The exact token must be present; a site that split it into `--flag value`
    // would leave the `=` form absent even though both words appear in argv.
    assert.ok(
      argvTokens.includes(flag),
      `flag ${flag} is not present as a single argv token (it may have been split)`,
    );
  }
});

/*
 * P-006 / D-012 — the retention rule, asserted against bytes the kernel
 * delivered rather than against a value the policy returned.
 *
 * The clause: "Every native capability family lacking a semantically equivalent
 * managed adapter remains explicitly retained or unsupported instead of being
 * disabled." `managed-capability-retention.test.ts` proves the census computes
 * that correctly. It cannot prove the argv a real process receives agrees with
 * it — the same gap the two tests above were written to close for P-005, one
 * level up: a call site that appends its OWN hand-listed deny reaches argv
 * without passing through the policy at all, so the census would read clean
 * while the native surface it audits was in fact removed at spawn.
 */
test('invoke — every native name the real argv removes is owner-mandated or proven-equivalent', async () => {
  const decision = resolveCapabilityPolicy({
    client: 'claude',
    surface: 'launch',
    audience: 'headless-agent',
    explicitDenyList: false,
  });
  const census = capabilityRetentionCensus();
  const outcomeByFamily = new Map(census.families.map((entry) => [entry.family, entry.outcome]));

  // CALIBRATION — both halves. A zero-context census or a zero-deny argv would
  // satisfy every assertion below by never iterating.
  assert.ok(census.contextsMeasured > 0, 'the census measured no context at all');
  assert.ok(decision.applied.length > 0, 'the policy applied nothing at this launch surface');

  const argvTokens = await spawnAndCaptureArgv();
  const deniedInArgv = argvTokens
    .filter((token) => token.startsWith('--disallowedTools='))
    .flatMap((token) => token.slice('--disallowedTools='.length).split(','))
    .filter(Boolean);
  assert.ok(
    deniedInArgv.length > 0,
    'the spawned argv denied nothing — this assertion would be vacuous',
  );

  const offenders: string[] = [];
  const unattributed: string[] = [];
  for (const name of deniedInArgv) {
    const owner = decision.applied.find((entry) => entry.deniedNames.includes(name));
    if (!owner) {
      // A name reached argv that the ONE policy does not own. That is a native
      // capability removed outside the audited mapping, which is exactly the
      // state the census cannot see and therefore must not be allowed to exist.
      unattributed.push(name);
      continue;
    }
    if (owner.authorityKind === 'owner-mandate') continue;
    const scope = owner.familyScope;
    const outcome = scope.kind === 'contract-family' ? outcomeByFamily.get(scope.family) : undefined;
    if (outcome === 'managed-cutover-eligible') continue;
    offenders.push(
      `${name} (restriction ${owner.id}, authority ${owner.authorityKind}, family ` +
        `${scope.kind === 'contract-family' ? scope.family : 'outside-r1-taxonomy'}, outcome ${outcome ?? 'unknown'})`,
    );
  }

  assert.deepEqual(
    unattributed,
    [],
    `the spawned argv denied ${unattributed.length} native name(s) no policy restriction owns:\n` +
      `${JSON.stringify(unattributed)}\n` +
      'A hand-listed deny at the call site bypasses the ONE policy, so the retention census ' +
      'audits a surface that is not the one being removed.\n' +
      `ACTUAL ARGV:\n${argvTokens.join('\n')}`,
  );
  assert.deepEqual(
    offenders,
    [],
    `the spawned argv removed ${offenders.length} native name(s) belonging to a family with no ` +
      `proven managed equivalent and no owner mandate:\n${offenders.join('\n')}\n` +
      'CAP-CONTRACT-P006-UNPROVEN-RETAINED: such a family must remain explicitly retained or ' +
      'unsupported, not disabled.',
  );
});
