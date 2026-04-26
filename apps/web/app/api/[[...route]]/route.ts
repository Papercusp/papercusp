/**
 * Papercusp API entrypoint. Mounts the framework's Hono routers:
 *   /api/harness/*  — harness CRUD (project picker, features, audit, proposals…)
 *   /api/plugins/*  — installed-plugin metadata
 *
 * Plus the static credentials/profile/auth/marketplace routes which live as
 * regular Next.js route handlers in app/api/{credentials,profile,auth,marketplace,installed}/.
 */
import { Hono } from 'hono';
import { handle } from 'hono/vercel';
import { harness } from '../_hono/harness';
import { plugins } from '../_hono/plugins';

export const dynamic = 'force-dynamic';

const app = new Hono().basePath('/api');

// CORS — preview origins (admin tooling). Tightens on production.
const adminPreviewCors = async (c: any, next: any) => {
  const origin = c.req.header('origin');
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'content-type, x-actor');
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
};

app.use('/harness/*', adminPreviewCors);
app.use('/plugins/*', adminPreviewCors);

app.route('/harness', harness);
app.route('/plugins', plugins);

export const GET = handle(app);
export const POST = handle(app);
export const PUT = handle(app);
export const PATCH = handle(app);
export const DELETE = handle(app);
export const OPTIONS = handle(app);
