/** Shared operator database pins, without importing SQL clients or ORM schemas. */
// Keep this source safe for the hosted Portal's non-ESM Next instrumentation
// chunk. Webpack rewrites static `node:module`/`createRequire` usage in that
// chunk, while a runtime `process.getBuiltinModule` lookup remains intact.
type BuiltinModuleGetter = (id: string) => unknown;

function nodeRequire(id: string): unknown {
  const proc = (globalThis as { process?: { getBuiltinModule?: unknown } }).process;
  const getter = proc?.getBuiltinModule;
  if (typeof getter !== 'function') {
    throw new Error(`db_builtin_module_unavailable: process.getBuiltinModule(${id}) requires Node >= 22.3`);
  }
  return (getter as BuiltinModuleGetter).call(proc, id);
}

type OperatorDbEnv = Partial<Record<'HARNESS_ADMIN_DATABASE_URL' | 'HARNESS_DATABASE_URL' | 'DATABASE_URL', string>>;
let _operatorDbEnvLocalCache: { loaded: boolean; values: OperatorDbEnv } = { loaded: false, values: {} };

/**
 * Locate the operator's .env.local from either this source file or the caller's
 * working directory. Service units source this exact file; consulting it before
 * desktop discovery keeps an env-less CLI on the same database as the operator.
 * Keep Node-only access lazy because connection.ts is also imported by browser
 * bundles.
 */
function findOperatorEnvLocalPath(): string | null {
  try {
    const fs = nodeRequire('node:fs') as typeof import('node:fs');
    const path = nodeRequire('node:path') as typeof import('node:path');
    const starts: string[] = [];
    try {
      const entry = process.argv[1];
      if (typeof entry === 'string' && entry.length > 0) starts.push(path.dirname(path.resolve(entry)));
    } catch { /* unavailable in edge runtimes */ }
    try { starts.push(process.cwd()); } catch { /* unavailable in edge runtimes */ }

    const visited = new Set<string>();
    for (const start of starts) {
      let dir = start;
      for (let depth = 0; depth < 12; depth += 1) {
        if (visited.has(dir)) break;
        visited.add(dir);
        const isOperatorDir = path.basename(dir) === 'operator' && path.basename(path.dirname(dir)) === 'apps';
        const candidates = isOperatorDir
          ? [path.join(dir, '.env.local')]
          : [path.join(dir, 'apps', 'operator', '.env.local')];
        for (const candidate of candidates) {
          try {
            if (fs.statSync(candidate).isFile()) return candidate;
          } catch { /* keep walking */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  } catch { /* browser/edge import: no filesystem-backed operator config */ }
  return null;
}

/** Parse only the DB URL assignments supported by scripts/lib/pg-url.mjs; never shell-evaluate. */
function parseOperatorEnvLocal(text: string): OperatorDbEnv {
  const values: OperatorDbEnv = {};
  const keys = new Set(['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL', 'DATABASE_URL']);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match || !keys.has(match[1])) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) value = value.slice(1, -1);
    if (value) values[match[1] as keyof OperatorDbEnv] = value;
  }
  return values;
}

/** Read only DB pins; do not source the file or copy unrelated secrets into process.env. */
export function readOperatorDbEnvLocal(fileOverride?: string): OperatorDbEnv {
  // An isolated test/PG must not inherit the live operator database from .env.local.
  if (process.env.PAPERCUSP_PG_PORT || process.env.PAPERCUSP_SKIP_PG_DISCOVERY === '1') {
    return {};
  }
  if (fileOverride) {
    try {
      const fs = nodeRequire('node:fs') as typeof import('node:fs');
      return parseOperatorEnvLocal(fs.readFileSync(fileOverride, 'utf8'));
    } catch { return {}; }
  }
  if (_operatorDbEnvLocalCache.loaded) return _operatorDbEnvLocalCache.values;
  let values: OperatorDbEnv = {};
  const file = findOperatorEnvLocalPath();
  if (file) {
    try {
      const fs = nodeRequire('node:fs') as typeof import('node:fs');
      values = parseOperatorEnvLocal(fs.readFileSync(file, 'utf8'));
    } catch { /* an unreadable local file is not an operator DB pin */ }
  }
  _operatorDbEnvLocalCache = { loaded: true, values };
  return values;
}

export function resetOperatorDbEnvLocalCacheForTests(): void {
  _operatorDbEnvLocalCache = { loaded: false, values: {} };
}
