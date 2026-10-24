import { describe, expect, it } from 'vitest';
import { MANAGED_CAPABILITY_DISPOSITIONS } from './managed-capability-contract';
import { nativeToolInventory } from './managed-capability-client-inventory';

describe('version-pinned client native tool inventory', () => {
  it.each([
    ['claude', '2.1.293 (Claude Code)', ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'CronCreate', 'Skill']],
    ['codex', 'codex-cli 0.163.0', ['exec_command', 'write_stdin', 'view_image', 'spawn_agent', 'get_goal', 'request_user_input']],
    ['omp', 'omp/18.0.3', ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'python', 'notebook', 'inspect_image',
      'browser', 'computer', 'task', 'todo', 'web_search', 'ask']],
  ] as const)('maps installed %s names to the existing family contract without enabling cutover', (client, version, names) => {
    const report = nativeToolInventory({ client, clientVersion: version, nativeNames: names });
    expect(report.completeNameMapping).toBe(true);
    expect(report.rows).toHaveLength(names.length);
    expect(report.cutoverReady).toBe(false);
    for (const row of report.rows) {
      const family = MANAGED_CAPABILITY_DISPOSITIONS.find(entry => entry.family === row.family)!;
      expect(row.managedAuthorities).toEqual(family.managedAuthorities);
      expect(row.cutoverReady).toBe(false);
    }
  });

  it('keeps a newly exposed native tool visible as an unsupported gap', () => {
    const report = nativeToolInventory({ client: 'codex', clientVersion: '0.163.0',
      nativeNames: ['exec_command', 'future_native_writer'] });
    expect(report.completeNameMapping).toBe(false);
    expect(report.rows[1]).toMatchObject({ nativeName: 'future_native_writer',
      family: null, disposition: 'unsupported-gap', gap: 'unknown-native-tool' });
    expect(report.rows[1].boundary).toContain('Retain');
  });

  it.each([null, '', 'unknown', '0.164.0'])('refuses a current-version mapping claim for version %s', version => {
    const report = nativeToolInventory({ client: 'codex', clientVersion: version, nativeNames: ['exec_command'] });
    expect(report.completeNameMapping).toBe(false);
    expect(report.rows[0].gap).toBe(version === '0.164.0' ? 'client-version-drift' : 'client-version-unmeasured');
    expect(report.rows[0].disposition).toBe('unsupported-gap');
    expect(report.cutoverReady).toBe(false);
  });

  it('does not treat an empty native surface as evidence of complete coverage', () => {
    const report = nativeToolInventory({ client: 'codex', clientVersion: '0.163.0', nativeNames: [] });
    expect(report.completeNameMapping).toBe(false);
  });

  it('distinguishes registered MCP tools and qualified native aliases', () => {
    const report = nativeToolInventory({ client: 'codex', clientVersion: '0.163.0',
      nativeNames: ['functions.exec_command', 'multi_agent_v1.spawn_agent', 'mcp__managed_surface',
        'managed_surface_canary'], managedNames: ['managed_surface_canary'] });
    expect(report.rows.map(row => row.family)).toEqual(['shell-ssh-interpreters', 'delegation']);
    expect(report.ignoredManagedNames).toEqual(['mcp__managed_surface', 'managed_surface_canary']);
  });

  it('does not silently accept another client native name or a namespace as a callable tool', () => {
    const report = nativeToolInventory({ client: 'omp', clientVersion: '18.0.3',
      nativeNames: ['Bash', 'multi_agent_v1'] });
    expect(report.rows.every(row => row.gap === 'unknown-native-tool')).toBe(true);
  });

  it('records the distinct patch and persistent-script gaps instead of treating names as parity', () => {
    const report = nativeToolInventory({ client: 'codex', clientVersion: '0.163.0',
      nativeNames: ['functions.exec', 'functions.apply_patch'] });
    expect(report.rows[0].boundary).toContain('continuity');
    expect(report.rows[1].boundary).toContain('multi-file patch');
    expect(report.rows.every(row => row.cutoverReady === false)).toBe(true);
  });
});
