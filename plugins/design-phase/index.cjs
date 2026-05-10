"use strict";
/**
 * @papercupai/design-phase — runtime artifact, hand-written CommonJS.
 *
 * Provides the MCP + HTTP tools the designer agent calls. Plan §15
 * (MCP surface): apps/operator/content/docs/design/design-phase-plan.mdx.
 *
 * Six tools in v0.1: validate_spec, lint_spec, submit_spec, list_memos,
 * read_memo, get_design_spec. proposeToken / searchRegistry /
 * captureCurrentSurface deferred until DTCG store + adapter integration
 * lands.
 *
 * IMPORTANT — duplication: this plugin re-implements a small slice of
 * apps/operator/lib/design-ir + apps/operator/lib/design-spec because
 * those libs aren't yet a workspace package. The operator's libs are
 * authoritative; refactor to a shared package when the duplication
 * starts hurting.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// ─── ajv ────────────────────────────────────────────────────────────
let ajvInstance = null;
let validateFn = null;
function getAjv() {
  if (validateFn) return validateFn;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Ajv2020 = require('ajv/dist/2020');
  ajvInstance = new (Ajv2020.default ?? Ajv2020)({ allErrors: true, strict: false });
  validateFn = ajvInstance.compile(IR_SCHEMA);
  return validateFn;
}

// ─── IR schema (mirror of apps/operator/lib/design-ir/schema.ts) ────
const IR_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://papercusp.dev/schemas/ui-ir/v0.1.json',
  type: 'object',
  required: ['irVersion', 'surface', 'ecosystem', 'layout'],
  additionalProperties: false,
  properties: {
    irVersion: { type: 'string', pattern: '^0\\.[0-9]+$' },
    surface: { type: 'string', minLength: 1 },
    ecosystem: { type: 'string', minLength: 1 },
    layout: { $ref: '#/$defs/node' },
    components: { type: 'array', items: { $ref: '#/$defs/componentBinding' } },
    tokens: {
      type: 'object',
      additionalProperties: false,
      properties: {
        uses: { type: 'array', items: { type: 'string', minLength: 1 } },
        proposed: { type: 'array', items: { $ref: '#/$defs/proposedToken' } },
      },
    },
    states: { type: 'object', additionalProperties: { $ref: '#/$defs/node' } },
    a11y: { $ref: '#/$defs/a11ySurface' },
  },
  $defs: {
    copy: {
      type: 'object',
      required: ['default'],
      additionalProperties: false,
      properties: {
        key: { type: 'string', minLength: 1 },
        default: { type: 'string' },
      },
    },
    iconRef: { type: 'string', minLength: 1 },
    tokenRef: {
      type: 'object',
      required: ['token'],
      additionalProperties: false,
      properties: { token: { type: 'string', minLength: 1 } },
    },
    motion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enter: { type: 'string', enum: ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'none'] },
        exit:  { type: 'string', enum: ['fade', 'slide-up', 'slide-down', 'slide-left', 'slide-right', 'scale', 'none'] },
        duration: { $ref: '#/$defs/tokenRef' },
        easing: { $ref: '#/$defs/tokenRef' },
      },
    },
    a11yNode: {
      type: 'object',
      additionalProperties: false,
      properties: {
        role: { type: 'string' },
        ariaLabel: { $ref: '#/$defs/copy' },
        ariaDescribedBy: { type: 'string' },
        ariaLive: { type: 'string', enum: ['off', 'polite', 'assertive'] },
        keyboardShortcut: { type: 'string' },
        focusOrder: { type: 'integer', minimum: 0 },
      },
    },
    a11ySurface: {
      type: 'object',
      additionalProperties: false,
      properties: {
        landmark: { type: 'string', enum: ['main', 'banner', 'navigation', 'complementary', 'contentinfo', 'form', 'search', 'region'] },
        headingLevel: { type: 'integer', minimum: 1, maximum: 6 },
      },
    },
    responsive: { type: 'object', additionalProperties: { type: 'object' } },
    binding: {
      type: 'object',
      required: ['slot'],
      additionalProperties: false,
      properties: {
        slot: { type: 'string', minLength: 1 },
        repeats: { type: 'boolean' },
        shape: { type: 'string', minLength: 1 },
      },
    },
    componentBinding: {
      type: 'object',
      required: ['id', 'registry'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        registry: { type: 'string', minLength: 1 },
        props: { type: 'object' },
      },
    },
    proposedToken: {
      type: 'object',
      required: ['id', 'type', 'value', 'reason'],
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        type: { type: 'string', enum: ['color', 'dimension', 'duration', 'fontFamily', 'fontWeight', 'number', 'shadow', 'cubicBezier'] },
        value: {},
        reason: { type: 'string', minLength: 1 },
      },
    },
    node: {
      type: 'object',
      required: ['kind'],
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: [
            'stack', 'grid', 'header', 'list', 'card', 'text', 'heading',
            'image', 'icon', 'button', 'link', 'input', 'textarea', 'select',
            'checkbox', 'radio', 'switch', 'badge', 'tag', 'separator',
            'spinner', 'progress', 'tooltip', 'modal', 'drawer', 'popover',
            'menu', 'tabs', 'breadcrumb', 'pagination', 'toast', 'banner',
            'empty-state', 'form', 'fieldset', 'chart', 'component', 'raw',
          ],
        },
        direction: { type: 'string', enum: ['vertical', 'horizontal'] },
        gap: { $ref: '#/$defs/tokenRef' },
        padding: { $ref: '#/$defs/tokenRef' },
        align: { type: 'string', enum: ['start', 'center', 'end', 'stretch', 'baseline'] },
        justify: { type: 'string', enum: ['start', 'center', 'end', 'space-between', 'space-around', 'space-evenly'] },
        children: { type: 'array', items: { $ref: '#/$defs/node' } },
        slots: { type: 'object', additionalProperties: { $ref: '#/$defs/node' } },
        title: { $ref: '#/$defs/copy' },
        copy: { $ref: '#/$defs/copy' },
        label: { $ref: '#/$defs/copy' },
        placeholder: { $ref: '#/$defs/copy' },
        icon: { $ref: '#/$defs/iconRef' },
        item: { $ref: '#/$defs/node' },
        emptyState: { $ref: '#/$defs/node' },
        interactions: { type: 'array', items: { type: 'string' } },
        ref: { type: 'string' },
        ecosystem: { type: 'string' },
        payload: {},
        spec: { type: 'object' },
        a11y: { $ref: '#/$defs/a11yNode' },
        motion: { $ref: '#/$defs/motion' },
        responsive: { $ref: '#/$defs/responsive' },
        binding: { $ref: '#/$defs/binding' },
        tokens: {
          type: 'object',
          additionalProperties: false,
          properties: { uses: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  },
};

// ─── lint rules (subset of operator's lint.ts) ─────────────────────
const DEFAULT_MAX_DEPTH = 6;
const INTERACTIVE_KINDS = new Set(['button', 'link', 'input', 'textarea', 'select', 'checkbox', 'radio', 'switch', 'menu', 'tabs']);

function walkNodes(node, prefix, visit, depth = 0) {
  if (!node) return;
  visit(node, prefix, depth);
  if (Array.isArray(node.children)) {
    node.children.forEach((c, i) => walkNodes(c, `${prefix}/children/${i}`, visit, depth + 1));
  }
  if (node.slots && typeof node.slots === 'object') {
    for (const [k, v] of Object.entries(node.slots)) walkNodes(v, `${prefix}/slots/${k}`, visit, depth + 1);
  }
  if (node.item) walkNodes(node.item, `${prefix}/item`, visit, depth + 1);
  if (node.emptyState) walkNodes(node.emptyState, `${prefix}/emptyState`, visit, depth + 1);
}

function lintIr(ir, ctx = {}) {
  const issues = [];
  const emit = (ruleId, severity, p, m) => issues.push({ ruleId, severity, path: p, message: m });
  const maxDepth = ctx.maxDepth ?? DEFAULT_MAX_DEPTH;

  // depth
  walkNodes(ir.layout, '/layout', (_n, p, d) => {
    if (d > maxDepth) emit('max-nesting-depth', 'warning', p, `depth ${d} exceeds max ${maxDepth}`);
  });

  // unknown tokens
  if (ctx.knownTokens) {
    const known = new Set(ctx.knownTokens);
    for (const t of (ir.tokens && ir.tokens.uses) || []) {
      if (!known.has(t)) emit('unknown-token', 'error', '/tokens/uses', `unknown token "${t}"`);
    }
    walkNodes(ir.layout, '/layout', (n, p) => {
      const inline = [
        [n.gap && n.gap.token, `${p}/gap/token`],
        [n.padding && n.padding.token, `${p}/padding/token`],
      ];
      for (const [t, pp] of inline) {
        if (t && !known.has(t)) emit('unknown-token', 'error', pp, `unknown token "${t}"`);
      }
    });
  }

  // unknown components
  if (ctx.knownComponents) {
    const known = new Set(ctx.knownComponents);
    (ir.components || []).forEach((b, i) => {
      if (!known.has(b.registry)) emit('unknown-component', 'error', `/components/${i}/registry`, `unknown registry "${b.registry}"`);
    });
  }

  // orphan component bindings
  const declared = new Set((ir.components || []).map((c) => c.id));
  const referenced = new Set();
  walkNodes(ir.layout, '/layout', (n) => {
    if (n.kind === 'component' && n.ref) referenced.add(n.ref);
  });
  for (const id of declared) {
    if (!referenced.has(id)) emit('orphan-component-binding', 'warning', '/components', `"${id}" declared but unused`);
  }
  for (const id of referenced) {
    if (!declared.has(id)) emit('orphan-component-binding', 'error', '/layout', `kind="component" ref="${id}" has no binding`);
  }

  // interactive without a11y
  walkNodes(ir.layout, '/layout', (n, p) => {
    if (INTERACTIVE_KINDS.has(n.kind)) {
      const a = n.a11y || {};
      if (!a.role && !a.ariaLabel) emit('interactive-without-a11y', 'warning', p, `${n.kind} missing a11y.role or ariaLabel`);
    }
  });

  // error state w/ recovery
  const err = ir.states && ir.states.error;
  if (err) {
    let hasRecovery = false;
    walkNodes(err, '/states/error', (n) => {
      if (n.kind === 'button' || n.kind === 'link') hasRecovery = true;
      if (Array.isArray(n.interactions) && n.interactions.includes('retry')) hasRecovery = true;
    });
    if (!hasRecovery) emit('error-state-missing-recovery', 'warning', '/states/error', 'no recovery action');
  }

  // loading state aria-live
  const loading = ir.states && ir.states.loading;
  if (loading) {
    let hasLive = false;
    walkNodes(loading, '/states/loading', (n) => {
      if (n.a11y && n.a11y.ariaLive && n.a11y.ariaLive !== 'off') hasLive = true;
    });
    if (!hasLive) emit('loading-state-missing-aria-live', 'warning', '/states/loading', 'no aria-live region');
  }

  // raw escape hatch
  walkNodes(ir.layout, '/layout', (n, p) => {
    if (n.kind === 'raw') emit('raw-escape-hatch', 'warning', p, 'kind="raw" bypasses the IR abstraction');
  });

  // copy missing key
  const checkCopy = (val, p) => {
    if (val && typeof val === 'object' && 'default' in val && !('key' in val)) {
      emit('copy-missing-key', 'warning', p, 'copy has no i18n key');
    }
  };
  walkNodes(ir.layout, '/layout', (n, p) => {
    if (n.title) checkCopy(n.title, `${p}/title`);
    if (n.copy) checkCopy(n.copy, `${p}/copy`);
    if (n.label) checkCopy(n.label, `${p}/label`);
    if (n.placeholder) checkCopy(n.placeholder, `${p}/placeholder`);
    if (n.a11y && n.a11y.ariaLabel) checkCopy(n.a11y.ariaLabel, `${p}/a11y/ariaLabel`);
  });

  return issues;
}

function validateIr(ir) {
  const v = getAjv();
  const ok = v(ir);
  if (ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (v.errors || []).map((e) => ({
      path: e.instancePath || '/',
      message: e.message || 'invalid',
      keyword: e.keyword,
      params: e.params,
    })),
  };
}

// ─── DESIGN_SPEC.md fallback resolver ──────────────────────────────
function parseFrontmatter(body) {
  if (!body.startsWith('---')) return { fm: {}, rest: body };
  const end = body.indexOf('\n---', 3);
  if (end === -1) return { fm: {}, rest: body };
  const head = body.slice(3, end).trim();
  const rest = body.slice(end + 4).replace(/^\r?\n/, '');
  const fm = {};
  let curKey = null;
  let curObj = null;
  for (const raw of head.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indented = /^\s+/.test(raw);
    if (!indented) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, k, val] = m;
      if (val === '' || val === undefined) {
        curKey = k; curObj = {}; fm[k] = curObj;
      } else {
        fm[k] = stripQuotes(val); curKey = null; curObj = null;
      }
    } else if (curObj) {
      const m = /^\s+([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
      if (m) curObj[m[1]] = stripQuotes(m[2]);
    }
  }
  return { fm, rest };
}
function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}
async function tryRead(p) {
  try { return await fsp.readFile(p, 'utf-8'); }
  catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
}
async function resolveDesignSpec(opts) {
  const filename = 'DESIGN_SPEC.md';
  const candidates = [];
  if (opts.harnessRoot) candidates.push({ layer: 'harness', path: path.join(opts.harnessRoot, filename) });
  if (opts.workspaceRoot) candidates.push({ layer: 'workspace', path: path.join(opts.workspaceRoot, filename) });
  // app default ships with the operator app. The plugin's runtime cwd
  // varies (repo root vs apps/operator/), so try both candidate roots.
  for (const root of candidateOperatorRoots()) {
    candidates.push({ layer: 'app-default', path: path.join(root, 'lib/design-spec/default.md') });
  }
  for (const c of candidates) {
    const raw = await tryRead(c.path);
    if (raw !== null) {
      const { fm, rest } = parseFrontmatter(raw);
      return { layer: c.layer, source: c.path, body: rest, frontmatter: fm };
    }
  }
  return {
    layer: 'empty', source: null, body: '', frontmatter: {},
    warning: 'no DESIGN_SPEC.md found at harness, workspace, or app-default paths',
  };
}

// ─── memos ─────────────────────────────────────────────────────────
function candidateOperatorRoots() {
  // Plugin runs from operator-host process; cwd may be the repo root or
  // the operator app dir itself. Try both.
  const cwd = process.cwd();
  return [
    path.resolve(cwd, 'apps/operator'),
    cwd, // when cwd already IS apps/operator
    path.resolve(cwd, '../../apps/operator'),
  ];
}
async function findFirstExisting(relPath) {
  for (const root of candidateOperatorRoots()) {
    const full = path.join(root, relPath);
    try { await fsp.access(full); return full; } catch {}
  }
  return null;
}
const MEMOS_REL = 'content/docs/design';
async function listMemos(filterStatus) {
  const dir = await findFirstExisting(MEMOS_REL);
  if (!dir) return [];
  let entries = [];
  try { entries = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of entries) {
    if (!f.endsWith('.mdx')) continue;
    const slug = f.slice(0, -4);
    const full = path.join(dir, f);
    const raw = await tryRead(full);
    if (!raw) continue;
    const { fm } = parseFrontmatter(raw);
    const title = String(fm.title || slug);
    const status = String(fm.status || 'open');
    if (filterStatus && filterStatus !== 'any' && status !== filterStatus) continue;
    out.push({ slug, title, status, source: full });
  }
  return out;
}
async function readMemo(slug) {
  const full = await findFirstExisting(path.join(MEMOS_REL, `${slug}.mdx`));
  if (!full) return null;
  const raw = await tryRead(full);
  if (!raw) return null;
  const { fm, rest } = parseFrontmatter(raw);
  return { slug, source: full, body: rest, frontmatter: fm };
}

// ─── PG persistence (submit_spec) ──────────────────────────────────
async function persistSpec(workspaceId, harnessSlug, featureId, ir, metadata) {
  // Lazy require so unit-test runs that mock fs don't pull postgres-js.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postgres = require('postgres');
  const url = process.env.HARNESS_ADMIN_DATABASE_URL
    || process.env.HARNESS_DATABASE_URL
    || 'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';
  const sql = postgres(url, { max: 1, idle_timeout: 5 });
  try {
    const id = `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    await sql.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
      await tx`
        INSERT INTO harness_shared.harness_design_artifacts
          (id, harness_slug, feature_id, kind, payload, metadata, created_ts)
        VALUES (${id}, ${harnessSlug}, ${featureId}, 'spec',
                ${tx.json(ir)}, ${tx.json(metadata || {})}, ${now})
      `;
      await tx`
        UPDATE harness_shared.harness_features_consolidated
           SET design_status  = 'accepted',
               design_spec_id = ${id},
               needs_design   = TRUE,
               updated_ts     = ${now}
         WHERE harness_slug = ${harnessSlug}
           AND feature_id   = ${featureId}
      `;
    });
    return { ok: true, specId: id };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// ─── tool handlers ─────────────────────────────────────────────────
async function validate_spec(input) {
  if (!input || typeof input.ir !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'validate_spec: input.ir (object) is required' }] };
  }
  const r = validateIr(input.ir);
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

async function lint_spec(input) {
  if (!input || typeof input.ir !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'lint_spec: input.ir (object) is required' }] };
  }
  const issues = lintIr(input.ir, {
    knownTokens: input.knownTokens,
    knownComponents: input.knownComponents,
    knownIcons: input.knownIcons,
    maxDepth: input.maxDepth,
  });
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warnCount = issues.length - errorCount;
  return { content: [{ type: 'text', text: JSON.stringify({ issues, errorCount, warnCount }, null, 2) }] };
}

async function submit_spec(input, ctx) {
  if (!input || typeof input.featureId !== 'string' || typeof input.ir !== 'object') {
    return { isError: true, content: [{ type: 'text', text: 'submit_spec: input.featureId (string) and input.ir (object) are required' }] };
  }
  const v = validateIr(input.ir);
  if (!v.ok) {
    return { isError: true, content: [{ type: 'text', text: `submit_spec: validation failed\n${JSON.stringify(v.errors, null, 2)}` }] };
  }
  const issues = lintIr(input.ir);
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    return { isError: true, content: [{ type: 'text', text: `submit_spec: lint errors block acceptance\n${JSON.stringify(errors, null, 2)}` }] };
  }
  ctx.progress(50, 'persisting');
  const result = await persistSpec(ctx.workspaceId, ctx.harnessSlug, input.featureId, input.ir, input.metadata);
  ctx.progress(100, 'done');
  return { content: [{ type: 'text', text: JSON.stringify({ ...result, lintWarnings: issues }, null, 2) }] };
}

async function list_memos(input) {
  const memos = await listMemos(input && input.status);
  return { content: [{ type: 'text', text: JSON.stringify(memos, null, 2) }] };
}

async function read_memo(input) {
  if (!input || typeof input.slug !== 'string') {
    return { isError: true, content: [{ type: 'text', text: 'read_memo: input.slug (string) is required' }] };
  }
  const memo = await readMemo(input.slug);
  if (!memo) return { isError: true, content: [{ type: 'text', text: `memo "${input.slug}" not found` }] };
  return { content: [{ type: 'text', text: JSON.stringify(memo, null, 2) }] };
}

async function get_design_spec(input, ctx) {
  const harnessRoot = (input && input.harnessRoot) || ctx.projectDir;
  const workspaceRoot = (input && input.workspaceRoot) || process.cwd();
  const r = await resolveDesignSpec({ harnessRoot, workspaceRoot });
  return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
}

const tools = {
  validate_spec,
  lint_spec,
  submit_spec,
  list_memos,
  read_memo,
  get_design_spec,
};

const plugin = {
  name: '@papercupai/design-phase',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'MCP + HTTP tools for the design-phase agent loop.',
  capabilities: [
    'tools:design:validate_spec',
    'tools:design:lint_spec',
    'tools:design:submit_spec',
    'tools:design:list_memos',
    'tools:design:read_memo',
    'tools:design:get_design_spec',
    'fs:read:design_memos',
    'db:write:harness_design_artifacts',
  ],
  tools,
};

module.exports = plugin;
module.exports.default = plugin;
// expose internals for in-process tests
module.exports._internal = { validateIr, lintIr, parseFrontmatter, resolveDesignSpec, listMemos, readMemo };
