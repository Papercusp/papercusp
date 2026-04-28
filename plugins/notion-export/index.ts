/**
 * @papercupai/notion-export — post the harness mission summary to a Notion
 * database. Demonstrates secrets:read + http:fetch against api.notion.com.
 */
import type { Plugin, PapercuspContext } from '@papercusp/plugin-sdk';

interface Config {
  databaseId?: string;
  version?: string;
}

interface ExportParams {
  title?: string;
  summary?: string;
}

async function readConfig(ctx: PapercuspContext): Promise<Config> {
  const { promises: fs } = await import('node:fs');
  const { join } = await import('node:path');
  try {
    return JSON.parse(await fs.readFile(join(ctx.pluginDataDir, 'config.json'), 'utf8')) as Config;
  } catch {
    return {};
  }
}

const plugin: Plugin = {
  kind: 'plugin',
  name: '@papercupai/notion-export',
  version: '0.1.0',
  papercusp: '^0.1.0',
  description: 'Export mission summary to a Notion database.',
  capabilities: [
    'secrets:read:NOTION_API_KEY',
    'http:fetch:api.notion.com',
    'events:listen:mission-done',
  ],
  actions: [
    {
      name: 'exportMission',
      label: 'Export to Notion',
      surfaces: ['mission-done', 'harness-toolbar'],
      capabilities: ['secrets:read:NOTION_API_KEY', 'http:fetch:api.notion.com'],
      serverHandler: { timeoutSec: 30 },
    },
  ],
  async init(ctx) {
    ctx.actions.register('exportMission', async (innerCtx, params, signal) => {
      const p = (params ?? {}) as ExportParams;
      const cfg = await readConfig(innerCtx);
      if (!cfg.databaseId) {
        return { ok: false, error: 'notion-export: databaseId not configured (run `papercusp plugin enable`)' };
      }
      const apiKey = process.env.NOTION_API_KEY;
      if (!apiKey) {
        return { ok: false, error: 'notion-export: NOTION_API_KEY not set in substrate process env' };
      }

      const title = p.title ?? `Mission @ ${innerCtx.installSlug} — ${new Date().toISOString().slice(0, 19)}`;
      const summary = p.summary ?? '(no summary provided)';
      const body = {
        parent: { database_id: cfg.databaseId },
        properties: {
          // Notion's database may have a Title property under any name; the
          // most common is "Name". Fall back to "title" if Name is missing
          // by submitting both is brittle — we just send Name and let the
          // user know via the README that this is the assumed property.
          Name: { title: [{ text: { content: title } }] },
        },
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: summary.slice(0, 2000) } }],
            },
          },
        ],
      };

      try {
        const r = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'notion-version': cfg.version ?? '2022-06-28',
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          return { ok: false, error: `notion-export: HTTP ${r.status}${text ? ' — ' + text.slice(0, 200) : ''}` };
        }
        const j = (await r.json()) as { id?: string; url?: string };
        return { ok: true, result: { pageId: j.id ?? null, url: j.url ?? null } };
      } catch (e: any) {
        if (e?.name === 'AbortError') return { ok: false, error: 'notion-export: aborted (timeout)' };
        return { ok: false, error: e?.message ?? String(e) };
      }
    });
  },
};

export default plugin;
