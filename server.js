import { serve }       from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono }        from 'hono'
import { handle }      from 'hono/vercel' // Адаптер для работы на Vercel
import dotenv          from 'dotenv'
import path            from 'path'
import { fileURLToPath } from 'url'
import fs              from 'fs' // Нужен для чтения index.html

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT      = Number(process.env.PORT) || 3001

// ─── Azure org registry ───────────────────────────────────────────────────────
function buildAzureTarget(raw) {
  if (!raw) return '';
  const clean = raw.trim().replace(/[,/\s]+$/, '');
  if (!clean) return '';
  if (clean.includes('dev.azure.com')) return clean;
  if (clean.startsWith('http')) return `https://dev.azure.com/${clean.replace(/^https?:\/\//, '')}`;
  return `https://dev.azure.com/${clean}`;
}

const AZURE_ORGS = {
  ht:   { target: buildAzureTarget(process.env.AZURE_DEVOPS_ORG_URL || process.env.AZURE_DEVOPS_ORG), pat: process.env.AZURE_DEVOPS_PAT },
  nsmg: { target: buildAzureTarget(process.env.AZURE_NSMG_ORG_URL),  pat: process.env.AZURE_NSMG_PAT },
  abs:  { target: buildAzureTarget(process.env.AZURE_ABS_ORG_URL),   pat: process.env.AZURE_ABS_PAT },
};

const jiraEmail = process.env.JIRA_EMAIL      || '';
const jiraToken = process.env.JIRA_API_TOKEN  || '';
const jiraAuth  = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`;

Object.entries(AZURE_ORGS).forEach(([key, cfg]) => {
  console.log(`[Server] Azure [${key.toUpperCase()}]: ${cfg.target ? `✓ ${cfg.target}` : '✗ (not configured)'}`);
});
console.log(`[Server] Jira: ${jiraEmail || '(not configured)'}`);

// ─── Generic proxy ────────────────────────────────────────────────────────────
async function proxyTo(c, upstreamUrl, authHeader) {
  const req    = c.req.raw;
  const method = req.method;
  const isBody = !['GET', 'HEAD'].includes(method);

  const headers = new Headers({ Authorization: authHeader, Accept: 'application/json' });
  const ct = req.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);

  const body = isBody ? await req.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(upstreamUrl, { method, headers, body });
    const text     = await upstream.text();
    if (!upstream.ok) console.error(`[Proxy] ${upstream.status} ← ${upstreamUrl}: ${text.slice(0, 300)}`);
    return new Response(text, {
      status:  upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    console.error(`[Proxy error] ${upstreamUrl}: ${err.message}`);
    return c.json({ error: err.message }, 503);
  }
}

// ─── Extract raw path+qs from Hono request URL ────────────────────────────────
function rawPathAndQs(c) {
  const full  = c.req.raw.url;                          
  const start = full.indexOf('/', full.indexOf('//') + 2); 
  return full.substring(start);                         
}

// ─── App ──────────────────────────────────────────────────────────────────────
const app = new Hono();

// Azure DevOps proxy — /api/azure-devops/:key/...
app.all('/api/azure-devops/:key/*', async (c) => {
  const key = c.req.param('key');
  const org = AZURE_ORGS[key];
  if (!org?.target) {
    return c.json({ error: `Azure org "${key}" is not configured. Add AZURE_${key.toUpperCase()}_ORG_URL and _PAT to .env` }, 503);
  }
  const raw    = rawPathAndQs(c);
  const qIdx   = raw.indexOf('?');
  const path_  = qIdx === -1 ? raw : raw.substring(0, qIdx);
  const qs     = qIdx === -1 ? '' : raw.substring(qIdx);
  const suffix = path_.substring(`/api/azure-devops/${key}`.length); 
  const auth   = `Basic ${Buffer.from(`:${org.pat || ''}`).toString('base64')}`;
  return proxyTo(c, `${org.target}${suffix}${qs}`, auth);
});

// Jira proxy — /api/jira/...
app.all('/api/jira/*', async (c) => {
  const raw    = rawPathAndQs(c);
  const qIdx   = raw.indexOf('?');
  const path_  = qIdx === -1 ? raw : raw.substring(0, qIdx);
  const qs     = qIdx === -1 ? '' : raw.substring(qIdx);
  const suffix = path_.substring('/api/jira'.length);
  return proxyTo(c, `https://api.atlassian.com${suffix}${qs}`, jiraAuth);
});

// Health check
app.get('/api/health', (c) => c.json({
  ok: true,
  azure: Object.fromEntries(Object.entries(AZURE_ORGS).map(([k, v]) => [k, { target: v.target || null, hasPat: !!v.pat }])),
  jira: { email: jiraEmail, hasToken: !!jiraToken },
}));

// Production: serve Vite build (для локального запуска сборки)
if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('*', (c) => {
    try {
      const index = fs.readFileSync(path.resolve('./dist/index.html'), 'utf-8');
      return c.html(index);
    } catch (e) {
      return c.text('index.html not found. Build the project first.', 404);
    }
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

// 1. Запуск для локальной разработки (не Vercel)
if (process.env.NODE_ENV !== 'production' || process.env.RUN_LOCAL) {
  serve({ fetch: app.fetch, port: PORT }, async (info) => {
    console.log(`[Server] Running locally on http://localhost:${info.port}`);
    const { target, pat } = AZURE_ORGS.ht;
    if (!target) return;
    try {
      const r = await fetch(`${target}/_apis/projects?api-version=7.0`, {
        headers: { Authorization: `Basic ${Buffer.from(`:${pat || ''}`).toString('base64')}`, Accept: 'application/json' },
      });
      console.log(`[Server] HT connectivity: ${r.ok ? `✓ OK (${r.status})` : `✗ Failed (${r.status})`}`);
    } catch (err) {
      console.error(`[Server] HT unreachable: ${err.message}`);
    }
  });
}

// 2. Экспорт для бессерверных функций Vercel
export default handle(app);