import { describe, expect, it } from 'vitest';
import {
  NATIVE_SCHEDULER_DENY,
  OS_SCHEDULER_BASH_DENY,
  hasExplicitDisallowedTools,
  nativeSchedulerDenyFlag,
} from './native-scheduler-deny';

describe('nativeSchedulerDenyFlag', () => {
  it('is one `=` token (the variadic space form would eat a trailing positional prompt)', () => {
    const flag = nativeSchedulerDenyFlag();
    expect(flag.startsWith('--disallowedTools=')).toBe(true);
    // Single argv token: no whitespace anywhere — splitCommand() and the
    // wake-executor argv array both rely on this (D-002).
    expect(/\s/.test(flag)).toBe(false);
  });

  it('carries both layers: T1 scheduler tools and T2 Bash OS-scheduler patterns', () => {
    const flag = nativeSchedulerDenyFlag();
    for (const t of NATIVE_SCHEDULER_DENY) expect(flag).toContain(t);
    for (const t of OS_SCHEDULER_BASH_DENY) expect(flag).toContain(t);
  });

  it('denies the verified-live surfaces (ScheduleWakeup is in a headless -p toolset)', () => {
    expect(NATIVE_SCHEDULER_DENY).toContain('ScheduleWakeup');
    expect(NATIVE_SCHEDULER_DENY).toContain('CronCreate');
    expect(OS_SCHEDULER_BASH_DENY).toContain('Bash(crontab:*)');
  });

  it('keeps every entry space-free so the comma join stays one token', () => {
    for (const t of [...NATIVE_SCHEDULER_DENY, ...OS_SCHEDULER_BASH_DENY]) {
      expect(/\s/.test(t)).toBe(false);
    }
  });
});

describe('hasExplicitDisallowedTools', () => {
  it('detects both flag spellings, = and space forms', () => {
    expect(hasExplicitDisallowedTools('claude -p --disallowedTools=Bash')).toBe(true);
    expect(hasExplicitDisallowedTools('claude -p --disallowedTools Bash')).toBe(true);
    expect(hasExplicitDisallowedTools('claude -p --disallowed-tools=Bash')).toBe(true);
    expect(hasExplicitDisallowedTools('claude -p --disallowed-tools Bash')).toBe(true);
  });

  it('is false for commands without an explicit deny list', () => {
    expect(hasExplicitDisallowedTools('claude -p')).toBe(false);
    expect(hasExplicitDisallowedTools('omp -p')).toBe(false);
    expect(hasExplicitDisallowedTools('claude -p --model opus')).toBe(false);
  });
});
