/**
 * Morning AI intelligence uses the existing research/operation engine.
 * These fixtures pin the owner-approved source and output contract.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BlueprintSchema } from './schema.js';
import { loadBuiltinBlueprint } from './loader.js';

const sourcePath = fileURLToPath(new URL('../../../harness/blueprints/morning-ai-intelligence/blueprint.yaml', import.meta.url));
const child = JSON.parse(readFileSync(sourcePath, 'utf8'));
const parent = loadBuiltinBlueprint('research').blueprint;
const resolved = BlueprintSchema.parse({
  ...parent, ...child,
  dependencies: { ...parent.dependencies, ...child.dependencies },
});
const operation = resolved.operations!.find((entry) => entry.id === 'daily-ai-brief')!;
const input = operation.inputSchema as Record<string, any>;
const result = operation.acceptance.resultSchema as Record<string, any>;

describe('morning AI-intelligence research contract', () => {
  it('extends the existing repo-less research engine', () => {
    expect(child.extends).toBe('research');
    expect(resolved.knobs.requiresRepo).toBe(false);
    expect(resolved.workItem.kind).toBe('task');
    expect(resolved.spine.decider).toBe('research-director');
  });

  it('declares an agent task for the existing researcher role', () => {
    expect(operation.target).toEqual({ kind: 'work-item', itemKind: 'task' });
    expect(operation.execution).toEqual({ kind: 'agent', role: 'researcher' });
    expect(operation.policy.identity?.ref).toBe('blueprint-operation-worker');
  });

  it('declares every required tool and no write or external-send tool', () => {
    for (const tool of operation.policy.requiredTools) {
      expect(resolved.dependencies?.tools).toContain(tool);
    }
    expect(operation.policy.requiredTools).toEqual(expect.arrayContaining(['reports:publish', 'reports:get', 'capability:fetch']));
    expect(operation.policy.requiredTools.some((tool) => /capability:(write|bash)|mail:|email:|github:.*(create|push)/.test(tool))).toBe(false);
  });

  it('includes primary, research, broad-news and AI-aggregator sources', () => {
    const ids = input.properties.sources.default.map((source: { id: string }) => source.id);
    expect(ids).toEqual(expect.arrayContaining([
      'openai', 'claude', 'gemini', 'mcp-sdk', 'codex', 'arxiv', 'huggingface',
      'google-news', 'techmeme', 'smol-ai', 'tldr-ai', 'alphasignal',
      'last-week-in-ai', 'import-ai', 'bens-bites', 'rundown',
    ]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('bounds the collection window and number of material items', () => {
    expect(input.properties.lookbackHours).toMatchObject({ minimum: 1, maximum: 72, default: 24 });
    expect(input.properties.maxItems).toMatchObject({ minimum: 1, maximum: 10, default: 10 });
    expect(input.properties.timezone.const).toBe('America/New_York');
  });

  it('requires input sources rather than silently relying on schema defaults', () => {
    expect(input.required).toContain('sources');
    expect(input.required).toContain('instructions');
    expect(input.additionalProperties).toBe(false);
  });

  it('preserves source failure, quiet-day and upstream-verification instructions', () => {
    const instructions = input.properties.instructions.const;
    expect(instructions).toContain('disclose each inaccessible source');
    expect(instructions).toContain('no-material-updates');
    expect(instructions).toContain('Technical claims require original docs');
    expect(instructions).toContain('weekly/weekday source need not have an issue today');
  });

  it('uses shared report editions rather than a second report store', () => {
    expect(input.properties.seriesTag.const).toBe('series:papercusp-ai-brief');
    expect(input.properties.instructions.const).toContain('supersedes is only for a correction to that SAME edition');
    expect(input.properties.instructions.const).toContain('Read back the persisted report via reports:get');
  });

  it('requires a durable report reference, date and explicit source coverage', () => {
    expect(result.required).toEqual(expect.arrayContaining([
      'reportId', 'reportPath', 'editionDate', 'itemCount', 'sourceCount', 'unavailableSources', 'status',
    ]));
    expect(result.properties.itemCount.maximum).toBe(10);
    expect(result.properties.status.enum).toContain('partial');
    expect(result.properties.status.enum).toContain('no-material-updates');
    expect(result.additionalProperties).toBe(false);
  });

  it('requires in-app notification and does not claim viewer proof from API readback', () => {
    expect(input.properties.instructions.const).toContain('notify human in-app via coord:send');
    expect(input.properties.instructions.const).toContain('Do NOT claim the owner viewer was tested from an API readback');
  });
});
