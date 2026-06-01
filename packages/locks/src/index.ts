/**
 * @papercusp/locks — SU-agent file-lock coordination substrate.
 *
 * Public surface = the union of the storage layer, the per-workspace
 * transaction wrapper, the refcounted LISTEN/janitor module, the
 * FileClaimCoordinator adapter, and the host seam. Path-validation rules
 * (`path-normalize`) are re-exported transitively via `su-lock-store`, so
 * this barrel deliberately does NOT `export *` from `./path-normalize`
 * again — a second star-export of the same names is an ambiguous re-export
 * that ESM silently drops, which would break `normalizePaths` et al.
 *
 * Call `configureLocks({ getAdminBaseUrl })` once before any other API.
 */
export * from './config';
export * from './su-lock-store';
export * from './in-workspace-txn';
export * from './workspace-listener';
export * from './coordinator';
