// Vercel serverless proxy — Hono
// Handles: /api/azure-devops/<key>/...  and  /api/jira/...

import { Hono }   from 'hono'
import { handle } from 'hono/vercel'

export const config = { runtime: 'nodejs' }

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
  ht:   { target: buildAzureTarget(process.env.AZURE_DEVOPS_ORG_URL), pat: process.env.AZURE_DEVOPS_PAT },
  nsmg: { target: buildAzureTarget(process.env.AZURE_NSMG_ORG_URL),   pat: process.env.AZURE_NSMG_PAT },
  abs:  { target: buildAzureTarget(process.env.AZURE_ABS_ORG_URL),    pat: process.env.AZURE_ABS_PAT },
};

// ─── Generic proxy ────────────────────────────────────────────────────────────
async function proxyTo(c, upstreamUrl, authHeader) {
  const req    = c.req.raw;
  const method = req.method;
  const isBody = !['GET', 'HEAD'].includes(method);

  const headers = new Headers({ Authorization: authHeader, Accept: 'application/json' });
  const ct = req.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);

  const body = isBody ? await req.arrayBuffer() : undefined;

  console.log(`[Proxy] ${method} → ${upstreamUrl}`);

  try {
    const upstream = await fetch(upstreamUrl, { method, headers, body });
    const text     = await upstream.text();
    if (!upstream.ok) {
      console.error(`[Proxy] ${upstream.status} ← ${upstreamUrl}: ${text.slice(0, 300)}`);
    }
    return new Response(text, {
      status:  upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    console.error(`[Proxy error] ${err.message}`);
    return c.json({ error: err.message }, 503);
  }
}

// ─── Extract path+qs from Hono request, preserving percent-encoding ───────────
function rawPathAndQs(c) {
  const full  = c.req.raw.url;                           // https://host/path?qs
  const start = full.indexOf('/', full.indexOf('//') + 2); // first '/' after scheme://host
  return full.substring(start);                          // /path?qs  (encoding preserved)
}

// ─── Hono app ─────────────────────────────────────────────────────────────────
const app = new Hono()

// Azure DevOps proxy — /api/azure-devops/:key/...
app.all('/api/azure-devops/:key/*', async (c) => {
  const key = c.req.param('key');
  const org = AZURE_ORGS[key];
  if (!org?.target) {
    return c.json({ error: `Azure org "${key}" is not configured.` }, 503);
  }
  const raw    = rawPathAndQs(c);
  const qIdx   = raw.indexOf('?');
  const path_  = qIdx === -1 ? raw : raw.substring(0, qIdx);
  const qs     = qIdx === -1 ? '' : raw.substring(qIdx);
  const suffix = path_.substring(`/api/azure-devops/${key}`.length); // /ABS%20-.../...
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
  const email  = process.env.JIRA_EMAIL     || '';
  const token  = process.env.JIRA_API_TOKEN || '';
  const auth   = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  return proxyTo(c, `https://api.atlassian.com${suffix}${qs}`, auth);
});

// Health check
app.get('/api/health', (c) => c.json({
  ok:  true,
  env: {
    AZURE_DEVOPS_ORG_URL: process.env.AZURE_DEVOPS_ORG_URL ? '✓ set' : '✗ missing',
    AZURE_NSMG_ORG_URL:   process.env.AZURE_NSMG_ORG_URL   ? '✓ set' : '✗ missing',
    AZURE_ABS_ORG_URL:    process.env.AZURE_ABS_ORG_URL     ? '✓ set' : '✗ missing',
    JIRA_EMAIL:           process.env.JIRA_EMAIL            ? '✓ set' : '✗ missing',
  },
}));

export default handle(app)
