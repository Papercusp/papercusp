/**
 * Version-pinned native tool names mapped onto the existing capability contract.
 * This is a census, never permission to disable a tool: policy admission and
 * actual client positive/refusal controls remain separate.
 */
import {
  MANAGED_CAPABILITY_DISPOSITIONS,
  type ManagedCapabilityFamilyId,
} from './managed-capability-contract';
import type { CapabilityClientFamily } from './managed-capability-policy';

export const NATIVE_TOOL_INVENTORY_CLIENT_VERSIONS = Object.freeze({
  claude: '2.1.293',
  codex: '0.163.0',
  omp: '18.0.3',
});

type Group = { family: ManagedCapabilityFamilyId; names: readonly string[]; boundary?: string };
const common: readonly Group[] = [
  { family: 'shell-ssh-interpreters', names: ['Bash', 'bash', 'exec_command', 'shell_command', 'shell'] },
  { family: 'jobs-output-stop-pty', names: ['write_stdin', 'TaskStop', 'BashOutput', 'KillShell'] },
  { family: 'script-orchestration-kernels', names: ['exec', 'python'],
    boundary: 'Native orchestration/code-mode execution needs its own managed continuity and media proof.' },
  { family: 'reads-list-search-lsp', names: ['Read', 'read', 'Glob', 'glob', 'Grep', 'grep', 'lsp'] },
  { family: 'edit-write-patch-notebook', names: ['Edit', 'edit', 'Write', 'write', 'apply_patch', 'NotebookEdit', 'notebook'],
    boundary: 'Exact-string edit is not multi-file patch or notebook parity; keep each adapter gap explicit.' },
  { family: 'http-search-browser-computer', names: ['WebFetch', 'WebSearch', 'web_search', 'web', 'browser', 'computer'] },
  { family: 'delegation', names: ['Agent', 'Task', 'Workflow', 'task', 'ListAgents', 'SendMessage',
      'ReportFindings', 'spawn_agent', 'send_input', 'resume_agent', 'close_agent', 'wait_agent'] },
  { family: 'schedules-monitors-wakes', names: ['CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'sleep'] },
  { family: 'tasks-plans-goals', names: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'todo', 'update_plan',
      'get_goal', 'create_goal', 'update_goal'],
    boundary: 'Keep native panels usable; shared work, goals and plan authority belong to their canonical stores.' },
  { family: 'memory-checkpoint-resume-rewind', names: ['EnterWorktree', 'ExitWorktree'],
    boundary: 'A native worktree/filesystem operation is not transcript resume or a Papercusp checkpoint.' },
  { family: 'questions-approvals', names: ['ask', 'request_user_input', 'AskUserQuestion'],
    boundary: 'The native dialog may remain an interface; managed approval authority is not implied.' },
  { family: 'images-artifacts-skills-discovery', names: ['Skill', 'ToolSearch', 'view_image', 'inspect_image',
      'imagegen', 'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
    boundary: 'Native image/resource/skill interfaces require their own access, media and output boundaries.' },
];

const clientNames: Readonly<Record<CapabilityClientFamily, ReadonlySet<string>>> = {
  claude: new Set(['Agent', 'Task', 'Workflow', 'Bash', 'BashOutput', 'KillShell', 'Read', 'Glob', 'Grep',
    'Edit', 'Write', 'NotebookEdit', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'ListAgents',
    'SendMessage', 'ReportFindings', 'Skill', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskStop',
    'TaskUpdate', 'WebFetch', 'WebSearch', 'EnterWorktree', 'ExitWorktree', 'AskUserQuestion']),
  codex: new Set(['exec', 'exec_command', 'write_stdin', 'shell_command', 'shell', 'apply_patch', 'view_image',
    'web', 'spawn_agent', 'send_input', 'resume_agent', 'close_agent', 'wait_agent', 'sleep', 'update_plan',
    'get_goal', 'create_goal', 'update_goal', 'request_user_input', 'imagegen',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']),
  omp: new Set(['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'python', 'notebook',
    'inspect_image', 'browser', 'computer', 'task', 'todo', 'web_search', 'ask']),
};

// Inspected in installed OMP 18.0.3 src/prompts/tools/{eval,hub}.md and
// src/tools/{eval.ts,hub/index.ts}; the native probe also captures the rendered
// descriptions. These composite contracts require operation-level parity,
// rather than a name-only mapping to one managed capability family.
const observedUnverifiedContracts: Readonly<Partial<Record<CapabilityClientFamily,
  Readonly<Record<string, string>>>>> = {
  omp: {
    eval: 'OMP eval runs a persistent multi-language kernel, with read/write/env, tool, completion and agent helpers. ' +
      'Cross-call state, helper effects, media and delegation need separate managed parity proof.',
    hub: 'OMP hub combines peer messaging, background-job wait/cancel, and project-scoped process ' +
      'start/ps/logs/stop/restart/describe, including PTY input and persistence. ' +
      'Messaging, job delivery and process lifecycle each need separate managed parity proof.',
  },
};
export type NativeToolInventoryGap = 'client-version-unmeasured' | 'client-version-drift' |
  'unknown-native-tool' | 'native-parity-unverified';

export interface NativeToolInventoryRow {
  nativeName: string;
  family: ManagedCapabilityFamilyId | null;
  disposition: (typeof MANAGED_CAPABILITY_DISPOSITIONS)[number]['disposition'] | 'unsupported-gap';
  managedAuthorities: readonly string[];
  boundary: string;
  gap: NativeToolInventoryGap | null;
  /** A name mapping is not replacement acceptance or a cutover instruction. */
  cutoverReady: false;
}

function callableName(client: CapabilityClientFamily, name: string): string {
  if (client === 'codex') return name.replace(/^(?:functions|multi_agent_v1)\./, '');
  return name;
}

/**
 * Classify the ACTUAL measured names, not a loop over the expected inventory.
 * A new tool or client version must stay visible as a gap. Callers identify
 * fixture/registered MCP tools explicitly; only the conventional mcp__ prefix
 * is excluded automatically. Namespace/container rows must not be passed as
 * callable tools (for example Codex's multi_agent_v1 namespace).
 */
export function nativeToolInventory(input: {
  client: CapabilityClientFamily;
  clientVersion: string | null;
  nativeNames: readonly string[];
  managedNames?: readonly string[];
}): {
  client: CapabilityClientFamily;
  expectedVersion: string;
  observedVersion: string | null;
  versionMatches: boolean;
  rows: NativeToolInventoryRow[];
  ignoredManagedNames: string[];
  completeNameMapping: boolean;
  cutoverReady: false;
} {
  const expectedVersion = NATIVE_TOOL_INVENTORY_CLIENT_VERSIONS[input.client];
  const observedVersion = input.clientVersion?.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  const versionMatches = observedVersion === expectedVersion;
  const managedNames = new Set(input.managedNames ?? []);
  const ignoredManagedNames: string[] = [];
  const rows: NativeToolInventoryRow[] = [];
  for (const nativeName of [...new Set(input.nativeNames)]) {
    if (nativeName.startsWith('mcp__') || managedNames.has(nativeName)) {
      ignoredManagedNames.push(nativeName);
      continue;
    }
    const name = callableName(input.client, nativeName);
    const group = clientNames[input.client].has(name)
      ? common.find(row => row.names.includes(name))
      : undefined;
    const family = group && MANAGED_CAPABILITY_DISPOSITIONS.find(row => row.family === group.family);
    const contracts = observedUnverifiedContracts[input.client];
    const unverifiedContract = contracts && Object.hasOwn(contracts, name) ? contracts[name] : undefined;
    const gap: NativeToolInventoryGap | null = observedVersion === null
      ? 'client-version-unmeasured'
      : !versionMatches ? 'client-version-drift'
      : !family ? unverifiedContract
        ? 'native-parity-unverified' : 'unknown-native-tool' : null;
    rows.push({
      nativeName,
      family: group?.family ?? null,
      disposition: gap ? 'unsupported-gap' : family!.disposition,
      managedAuthorities: family?.managedAuthorities ?? [],
      boundary: gap
        ? [unverifiedContract, `Retain this native surface: ${gap}; no client-removal guarantee is established.`]
          .filter(Boolean).join(' ')
        : [family!.boundary, group!.boundary].filter(Boolean).join(' '),
      gap,
      cutoverReady: false,
    });
  }
  return {
    client: input.client, expectedVersion, observedVersion, versionMatches, rows, ignoredManagedNames,
    completeNameMapping: rows.length > 0 && rows.every(row => row.gap === null),
    cutoverReady: false,
  };
}
