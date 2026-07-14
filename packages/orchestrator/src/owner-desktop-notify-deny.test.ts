import { describe, expect, it } from 'vitest';
import { OWNER_DESKTOP_NOTIFY_BASH_DENY, ownerDesktopNotifyDenyFlag } from './owner-desktop-notify-deny';

describe('ownerDesktopNotifyDenyFlag (owner directive 2026-07-14)', () => {
  it('is one `=` token (the variadic space form would eat a trailing positional prompt)', () => {
    const flag = ownerDesktopNotifyDenyFlag();
    expect(flag.startsWith('--disallowedTools=')).toBe(true);
    expect(/\s/.test(flag)).toBe(false);
  });

  it('covers the bare name AND the absolute paths that would trivially bypass the PATH shim', () => {
    expect(OWNER_DESKTOP_NOTIFY_BASH_DENY).toContain('Bash(notify-send:*)');
    expect(OWNER_DESKTOP_NOTIFY_BASH_DENY).toContain('Bash(/usr/bin/notify-send:*)');
    expect(OWNER_DESKTOP_NOTIFY_BASH_DENY).toContain('Bash(/bin/notify-send:*)');
    const flag = ownerDesktopNotifyDenyFlag();
    for (const t of OWNER_DESKTOP_NOTIFY_BASH_DENY) expect(flag).toContain(t);
  });

  it('keeps every entry space-free so the comma join stays one token', () => {
    for (const t of OWNER_DESKTOP_NOTIFY_BASH_DENY) expect(/\s/.test(t)).toBe(false);
  });
});
