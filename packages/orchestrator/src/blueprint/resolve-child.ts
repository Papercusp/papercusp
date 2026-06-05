/**
 * resolveChildBlueprint — the spawn-time binding of `recursion.childBlueprint`
 * (autoloop-pot-operator-rebuild-2026-06-05 D-008 / P-008).
 *
 * A recursion-enabled blueprint declares WHICH blueprint its spawned child runs
 * in one of three forms:
 *
 *   - omitted            → SELF (the documented default — monorepo sub-projects,
 *                          research overflow recurse into their own shape);
 *   - a literal id       → that blueprint (a fixed child shape);
 *   - a `$param` token   → a PARAMETERIZED child, bound by the spawner at spawn
 *                          time. The gym declares `childBlueprint: $target` and
 *                          the gym runtime binds `{ target: <blueprint-under-
 *                          optimization> }` — the former undeclared runtime
 *                          override of "self", now declared in the blueprint and
 *                          resolved through ONE canonical helper.
 *
 * Pure; fail-closed: an unbound or malformed `$param` throws a descriptive
 * error rather than silently falling back to self (a gym run against the wrong
 * target is exactly the bug this lift exists to prevent).
 */

/** The well-formed `$param` placeholder shape: `$` + identifier. */
export const CHILD_BLUEPRINT_PARAM_RE = /^\$[A-Za-z][A-Za-z0-9_-]*$/;

/** True when a declared childBlueprint is a `$param` placeholder (vs a literal id). */
export function isChildBlueprintParam(value: string | undefined): boolean {
  return typeof value === 'string' && value.startsWith('$');
}

/**
 * Resolve the blueprint id a spawned child runs. See the module doc for the
 * three declaration forms. `params` carries the spawner's bindings (the gym
 * passes `{ target: <id> }`); it is only consulted for the `$param` form.
 */
export function resolveChildBlueprint(
  bp: { id: string; recursion?: { childBlueprint?: string } },
  params: Record<string, string> = {},
): string {
  const declared = bp.recursion?.childBlueprint;
  // Omitted ⇒ self (the schema's documented default).
  if (declared === undefined || declared === '') return bp.id;
  // Literal ⇒ that blueprint.
  if (!declared.startsWith('$')) return declared;
  // `$param` ⇒ the spawner's binding. Fail closed on malformed/unbound.
  if (!CHILD_BLUEPRINT_PARAM_RE.test(declared)) {
    throw new Error(
      `blueprint "${bp.id}": recursion.childBlueprint ${JSON.stringify(declared)} is not a valid ` +
        `placeholder — expected \`$\` + identifier (e.g. \`$target\`)`,
    );
  }
  const name = declared.slice(1);
  const bound = params[name];
  if (!bound) {
    throw new Error(
      `blueprint "${bp.id}": recursion.childBlueprint declares the parameterized child ` +
        `\`${declared}\` but the spawn bound no "${name}" param — pass it in ` +
        `resolveChildBlueprint(bp, { ${name}: '<blueprint-id>' })`,
    );
  }
  return bound;
}
