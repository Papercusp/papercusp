/**
 * E2a — import-time blueprint **dependency validation**.
 *
 * `harness-blueprint-distribution-2026-06-03` P-003 / P-004 / D-003 / D-004.
 *
 * A blueprint declares the tools + plugins its roles need
 * (`dependencies.{tools,plugins}` — the engine's schema field). Today an
 * unsatisfied tool is only discovered at CALL time, deep in a run, as a
 * `404 unknown_tool` (`apps/operator/lib/capabilities/invoke.ts:69`). This
 * validator resolves the declared deps UPFRONT — at `init --from` /
 * `harness:create` / blueprint-load — against the host's known tools + installed
 * plugins + Cupboard listings, and fails with an actionable "needs plugin X"
 * before any run starts.
 *
 * **Pure + borrowable.** The host capability sets are INJECTED
 * (`availableTools`, `installedPlugins`, `cupboardPlugins`) — the validator
 * touches no catalog, no PG, no filesystem. The operator wires `getCatalog()`
 * tool names + the installed-plugin registry + Cupboard listings into the sets;
 * the CLI wires its own equivalents. Keeps the predicate trivial to cover.
 *
 * Resolution rules (per D-003 "resolve against the catalog + Cupboard"):
 *   - a declared **tool** is satisfied iff its name is in `availableTools`;
 *   - a declared **plugin** is satisfied iff it is `installedPlugins` (already
 *     present) OR `cupboardPlugins` (installable from the Cupboard — `init`'s
 *     plugin auto-install step, P-004, will fetch it). A plugin in NEITHER is a
 *     hard failure.
 *
 * Version qualifiers (`name@range`) on a dep are parsed off for the presence
 * check and carried (in `installable`) for the installer; full version
 * reconciliation (semver/exact/hash) reuses the snapshot manifest machinery
 * (`@papercusp/export-state` `SnapshotVersionPin` / `reconcileMigrations`,
 * D-004) and is layered on by the install step, not duplicated here.
 */

/** The dependency block a blueprint declares (mirrors the engine's `DependenciesSchema`). */
export interface BlueprintDependencyInput {
  tools?: string[];
  plugins?: string[];
}

/** The host capability sets the validator resolves declared deps against. */
export interface DependencyHostSets {
  /** Tool names currently resolvable (e.g. operator `getCatalog()` names). */
  availableTools: Set<string>;
  /** Plugins installed/enabled in this host. */
  installedPlugins: Set<string>;
  /** Plugins listed in the Cupboard (installable but not necessarily installed). */
  cupboardPlugins?: Set<string>;
}

export interface BlueprintDependencyValidation {
  /** True iff no declared tool/plugin is unresolvable (installable plugins do NOT block). */
  ok: boolean;
  /** Unresolvable declared deps — the dep strings as written (with any `@range`). */
  missing: { tools: string[]; plugins: string[] };
  /**
   * Declared plugins not installed but resolvable from the Cupboard. Advisory:
   * `init --from`'s plugin auto-install step (P-004) should fetch these. Does
   * not affect `ok`.
   */
  installable: { plugins: string[] };
  /** One human-readable line per unresolvable dep — surfaced to the user. */
  messages: string[];
}

/**
 * Split a dependency spec `"name@range"` → `{ name, range }`. Tolerates scoped
 * names (`@scope/pkg`, `@scope/pkg@1.2.0`): a leading `@` is part of the name,
 * only a LATER `@` introduces a version. No version → `range: null`.
 */
export function parseDepSpec(spec: string): { name: string; range: string | null } {
  const at = spec.lastIndexOf('@');
  if (at > 0) return { name: spec.slice(0, at), range: spec.slice(at + 1) };
  return { name: spec, range: null };
}

/**
 * Resolve a blueprint's declared `dependencies` against the host sets, returning
 * the missing/installable breakdown + actionable messages. Pure.
 */
export function validateBlueprintDependencies(
  deps: BlueprintDependencyInput | undefined | null,
  host: DependencyHostSets,
): BlueprintDependencyValidation {
  const missingTools: string[] = [];
  const missingPlugins: string[] = [];
  const installablePlugins: string[] = [];
  const messages: string[] = [];

  const cupboard = host.cupboardPlugins ?? new Set<string>();

  for (const raw of deps?.tools ?? []) {
    const { name } = parseDepSpec(raw);
    if (!host.availableTools.has(name)) {
      missingTools.push(raw);
      messages.push(
        `needs tool "${name}" — not in the tool catalog; declare/install the plugin that provides it`,
      );
    }
  }

  for (const raw of deps?.plugins ?? []) {
    const { name } = parseDepSpec(raw);
    if (host.installedPlugins.has(name)) continue; // already installed → satisfied
    if (cupboard.has(name)) {
      installablePlugins.push(raw); // resolvable from the Cupboard → init installs it
      continue;
    }
    missingPlugins.push(raw);
    messages.push(`needs plugin "${name}" — not installed and not available in the Cupboard`);
  }

  return {
    ok: missingTools.length === 0 && missingPlugins.length === 0,
    missing: { tools: missingTools, plugins: missingPlugins },
    installable: { plugins: installablePlugins },
    messages,
  };
}
