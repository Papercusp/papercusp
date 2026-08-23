/**
 * Hosted-customer tenant context for Postgres RLS.
 *
 * The caller supplies the already-authenticated hosted Principal plus the
 * server-resolved customer-workspace directory row. Raw route/body/query
 * identifiers are deliberately not accepted as separate arguments. The
 * workspace binding is checked against the Principal's active organization
 * before a transaction is opened, then all three tenant GUCs are installed
 * with transaction-local `set_config(..., true)` calls.
 *
 * `Principal.workspaceId` is the operator/control-plane workspace. It is used
 * only to acquire the existing workspace-scoped transaction. The optional
 * `selectedWorkspaceId` is the customer workspace written to
 * `app.workspace_id`; conflating the two would make ambient local workspace
 * state into hosted customer authority.
 */

import type { Sql } from 'postgres';
import { withWorkspace } from './workspace-context';

/** Structural subset of operator-core's HostedPrincipal needed by the DB seam. */
export interface HostedTenantPrincipal {
  readonly kind: 'user';
  readonly profile: 'hosted';
  readonly authMethod: 'cookie-session';
  readonly trust: 'verified';
  readonly slug: string;
  /** Operator/control-plane workspace, not the selected customer workspace. */
  readonly workspaceId: string;
  readonly userId: string;
  readonly activeOrganizationId: string;
  readonly selectedWorkspaceId?: string;
  readonly sessionId: string;
  readonly sessionVersion: number;
}

/**
 * Result of resolving `selectedWorkspaceId` through the authoritative customer
 * workspace directory. Hosted request middleware owns that lookup; this module
 * owns checking that the resolved record still matches the verified Principal.
 */
export interface ResolvedTenantWorkspace {
  readonly id: string;
  readonly organizationId: string;
}

export interface VerifiedTenantServerContext {
  readonly principal: HostedTenantPrincipal;
  readonly selectedWorkspace?: ResolvedTenantWorkspace | null;
}

export interface DerivedTenantContext {
  readonly controlPlaneWorkspaceId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId?: string;
}

export type TenantContextErrorCode =
  | 'tenant_context_unverified_principal'
  | 'tenant_context_missing_scope'
  | 'tenant_context_principal_identity_mismatch'
  | 'tenant_context_workspace_binding_missing'
  | 'tenant_context_workspace_binding_unexpected'
  | 'tenant_context_workspace_binding_mismatch'
  | 'tenant_context_foreign_workspace';

export class TenantContextError extends Error {
  override readonly name = 'TenantContextError';

  constructor(readonly code: TenantContextErrorCode) {
    super(code);
  }
}

/**
 * Validate and reduce verified server context to the values safe to install as
 * tenant GUCs. This function is intentionally pure so every refusal is testable
 * without opening a database connection.
 */
export function deriveTenantContext(context: VerifiedTenantServerContext): DerivedTenantContext {
  const principal = context?.principal as Partial<HostedTenantPrincipal> | undefined;
  if (
    principal?.kind !== 'user' ||
    principal.profile !== 'hosted' ||
    principal.authMethod !== 'cookie-session' ||
    principal.trust !== 'verified'
  ) {
    throw new TenantContextError('tenant_context_unverified_principal');
  }

  const controlPlaneWorkspaceId = requireIdentifier(principal.workspaceId);
  const userId = requireIdentifier(principal.userId);
  const organizationId = requireIdentifier(principal.activeOrganizationId);
  const sessionId = requireIdentifier(principal.sessionId);
  if (
    !controlPlaneWorkspaceId ||
    !userId ||
    !organizationId ||
    !sessionId ||
    !Number.isSafeInteger(principal.sessionVersion) ||
    (principal.sessionVersion as number) < 0
  ) {
    throw new TenantContextError('tenant_context_missing_scope');
  }
  if (principal.slug !== userId) {
    throw new TenantContextError('tenant_context_principal_identity_mismatch');
  }

  const selectedWorkspaceId =
    principal.selectedWorkspaceId === undefined ? undefined : requireIdentifier(principal.selectedWorkspaceId);
  if (principal.selectedWorkspaceId !== undefined && !selectedWorkspaceId) {
    throw new TenantContextError('tenant_context_missing_scope');
  }

  const resolvedWorkspace = context.selectedWorkspace;
  if (selectedWorkspaceId === undefined) {
    if (resolvedWorkspace !== undefined && resolvedWorkspace !== null) {
      throw new TenantContextError('tenant_context_workspace_binding_unexpected');
    }
    return Object.freeze({ controlPlaneWorkspaceId, userId, organizationId });
  }

  if (resolvedWorkspace === undefined || resolvedWorkspace === null) {
    throw new TenantContextError('tenant_context_workspace_binding_missing');
  }
  const resolvedWorkspaceId = requireIdentifier(resolvedWorkspace.id);
  const resolvedOrganizationId = requireIdentifier(resolvedWorkspace.organizationId);
  if (!resolvedWorkspaceId || !resolvedOrganizationId) {
    throw new TenantContextError('tenant_context_missing_scope');
  }
  if (resolvedWorkspaceId !== selectedWorkspaceId) {
    throw new TenantContextError('tenant_context_workspace_binding_mismatch');
  }
  if (resolvedOrganizationId !== organizationId) {
    throw new TenantContextError('tenant_context_foreign_workspace');
  }

  return Object.freeze({
    controlPlaneWorkspaceId,
    userId,
    organizationId,
    workspaceId: selectedWorkspaceId,
  });
}

/**
 * Run hosted-customer queries inside the canonical tenant transaction.
 *
 * `withWorkspace` is reused for the existing bounded app pool, acquisition
 * deadline/retry, PgBouncer-safe transaction, and search_path setup. Its initial
 * control-plane `app.workspace_id` is overwritten before the caller callback can
 * run; a request with no selected customer workspace gets an explicit empty
 * transaction-local value (fail closed), never ambient pooled-connection state.
 */
export async function withTenantContext<T>(
  context: VerifiedTenantServerContext,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  const tenant = deriveTenantContext(context);
  return withWorkspace(tenant.controlPlaneWorkspaceId, async (tx) => {
    await tx`
      SELECT
        set_config('app.user_id', ${tenant.userId}, true),
        set_config('app.organization_id', ${tenant.organizationId}, true),
        set_config('app.workspace_id', ${tenant.workspaceId ?? ''}, true)
    `;
    return fn(tx);
  });
}

function requireIdentifier(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return null;
  return value;
}
