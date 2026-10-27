/**
 * The issue-family work-item kinds: the ONE canonical list (code-cleanup-campaigns-2026-10-26
 * P-003, R-3, D-003).
 *
 * It lives in this low-level package so that both operator-core and the orchestrator can
 * import it; operator-core re-exports it from work-nature/agent-work-predicate.ts. Every
 * issue-family enumeration in source (a TS array or Set, a zod enum, an SQL `IN (...)` or
 * `ARRAY[...]` list) is derived from this constant. The database copies (trigger functions,
 * views, partial-index predicates) were extended by migration 1590.
 *
 * `cleanup` is the low-priority code-cleanup kind: issue-family for routing, claimed only
 * when no feature, bug or change item is claimable.
 */
export const ISSUE_FAMILY_ROUTE_KINDS = ['bug', 'change', 'task', 'cleanup'] as const;
export type IssueFamilyRouteKind = (typeof ISSUE_FAMILY_ROUTE_KINDS)[number];

/**
 * The same list spelled as SQL literals (`'bug', 'change', 'task', 'cleanup'`) for raw SQL
 * text. Literals rather than a bound array on purpose: partial indexes carry this exact list
 * in their predicate, and the planner can prove implication only from a literal list.
 */
export const ISSUE_FAMILY_KINDS_SQL_LIST: string = ISSUE_FAMILY_ROUTE_KINDS.map((k) => `'${k}'`).join(', ');
