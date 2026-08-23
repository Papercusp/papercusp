import { describe, expect, it } from 'vitest';
import {
  TenantContextError,
  deriveTenantContext,
  type HostedTenantPrincipal,
  type VerifiedTenantServerContext,
} from './tenant-context';

const principal = (overrides: Partial<HostedTenantPrincipal> = {}): HostedTenantPrincipal => ({
  kind: 'user',
  profile: 'hosted',
  authMethod: 'cookie-session',
  trust: 'verified',
  slug: 'user-1',
  workspaceId: 'control-plane',
  userId: 'user-1',
  activeOrganizationId: 'org-a',
  selectedWorkspaceId: 'customer-ws-a',
  sessionId: 'session-1',
  sessionVersion: 4,
  ...overrides,
});

const context = (
  principalOverrides: Partial<HostedTenantPrincipal> = {},
  workspace: VerifiedTenantServerContext['selectedWorkspace'] = {
    id: 'customer-ws-a',
    organizationId: 'org-a',
  },
): VerifiedTenantServerContext => ({
  principal: principal(principalOverrides),
  selectedWorkspace: workspace,
});

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof TenantContextError ? error.code : undefined;
  }
  return undefined;
}

describe('deriveTenantContext', () => {
  it('separates the control-plane workspace from the selected customer workspace', () => {
    expect(deriveTenantContext(context())).toEqual({
      controlPlaneWorkspaceId: 'control-plane',
      userId: 'user-1',
      organizationId: 'org-a',
      workspaceId: 'customer-ws-a',
    });
  });

  it('allows an organization-scoped request with no selected workspace', () => {
    expect(deriveTenantContext(context({ selectedWorkspaceId: undefined }, null))).toEqual({
      controlPlaneWorkspaceId: 'control-plane',
      userId: 'user-1',
      organizationId: 'org-a',
    });
  });

  it.each([
    ['local profile', { profile: 'local' }],
    ['untrusted session', { trust: 'trusted' }],
    ['wrong auth method', { authMethod: 'bearer-token' }],
    ['non-user principal', { kind: 'system' }],
  ])('refuses an unverified hosted Principal: %s', (_label, override) => {
    expect(errorCode(() => deriveTenantContext(context(override as never)))).toBe(
      'tenant_context_unverified_principal',
    );
  });

  it.each([
    ['workspaceId', { workspaceId: '' }],
    ['userId', { userId: ' ' }],
    ['organization', { activeOrganizationId: '' }],
    ['session', { sessionId: '' }],
    ['session version', { sessionVersion: -1 }],
    ['selected workspace', { selectedWorkspaceId: '' }],
  ])('refuses missing or malformed scope: %s', (_label, override) => {
    expect(errorCode(() => deriveTenantContext(context(override as never)))).toBe('tenant_context_missing_scope');
  });

  it('refuses a Principal whose slug does not match its hosted user id', () => {
    expect(errorCode(() => deriveTenantContext(context({ slug: 'user-other' })))).toBe(
      'tenant_context_principal_identity_mismatch',
    );
  });

  it('requires a server-resolved binding for a selected workspace', () => {
    expect(errorCode(() => deriveTenantContext(context({}, null)))).toBe('tenant_context_workspace_binding_missing');
  });

  it('refuses a resolved record for a different workspace id', () => {
    expect(
      errorCode(() =>
        deriveTenantContext(
          context(
            {},
            {
              id: 'customer-ws-b',
              organizationId: 'org-a',
            },
          ),
        ),
      ),
    ).toBe('tenant_context_workspace_binding_mismatch');
  });

  it('refuses a selected workspace owned by a foreign organization', () => {
    expect(
      errorCode(() =>
        deriveTenantContext(
          context(
            {},
            {
              id: 'customer-ws-a',
              organizationId: 'org-b',
            },
          ),
        ),
      ),
    ).toBe('tenant_context_foreign_workspace');
  });

  it('refuses a workspace binding when the verified Principal selected none', () => {
    expect(
      errorCode(() =>
        deriveTenantContext(
          context({ selectedWorkspaceId: undefined }, { id: 'customer-ws-a', organizationId: 'org-a' }),
        ),
      ),
    ).toBe('tenant_context_workspace_binding_unexpected');
  });
});
