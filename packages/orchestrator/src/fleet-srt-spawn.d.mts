export const FLEET_SANDBOX_DENY_READ: readonly string[];
export const FLEET_SANDBOX_CACHE_ROOT: string;
export const NATIVE_CONTAINER_EXEC_ENV: 'PAPERCUSP_NATIVE_CONTAINER_EXEC';
export interface NativeContainerExecBinding {
  kind: 'docker-exec';
  command: string;
  sha256: string;
}
export function rootReadDenyPaths(
  entries: readonly Pick<import('node:fs').Dirent, 'name' | 'isSymbolicLink'>[],
): string[];
export function buildProcessSrtSettings(options: {
  cwd: string; agentHomes?: string[]; allowedDomains: readonly string[]; denyWrite?: string[];
}): Record<string, unknown>;
export function wrapProcessWithSrt(command: string, argv: string[], options: {
  srtBin: string | null | undefined; settingsPath: string | null | undefined;
}): { command: string; argv: string[] };
/** Installed SRT launcher/package paths, including its seccomp resources. */
export function scopedSandboxReadPaths(bin: string): string[];
export type NativeSandboxSpawn = (command: string, argv: string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; [key: string]: unknown;
}, realSpawn: (...args: any[]) => any) => any;
export function createScopedNativeSandboxSpawn(options: {
  env: NodeJS.ProcessEnv; cwd: string; srtBin?: string | null;
}): NativeSandboxSpawn | null;
