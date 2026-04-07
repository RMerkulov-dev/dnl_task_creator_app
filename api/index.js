import { Hono } from 'hono'
import { handle } from 'hono/vercel'

const app = new Hono()

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

// ─── Generic proxy ────────────────────────────────────────────────────────────
async function proxyTo(c, upstreamUrl, authHeader) {
  const req = c.req.raw;
  const headers = new Headers({ Authorization: authHeader, Accept: 'application/json' });
  const ct = req.headers.get('content-type');
  if (ct) headers.set('Content-Type', ct);

  const body = !['GET', 'HEAD'].includes(req.method) ? await req.arrayBuffer() : undefined;

  try {
    const upstream = await fetch(upstreamUrl, { method: req.method, headers, body });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });
  } catch (err) {
    return c.json({ error: err.message }, 503);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Azure DevOps proxy
app.all('/api/azure-devops/:key/*', async (c) => {
  const key = c.req.param('key');
  const org = AZURE_ORGS[key];
  if (!org?.target) {
    return c.json({ error: `Azure org "${key}" is not configured in environment variables.` }, 503);
  }

  // Безопасное извлечение пути с сохранением %20 (пробелов)
  const urlObj = new URL(c.req.raw.url);
  const fullPath = urlObj.pathname + urlObj.search;
  const prefix = `/api/azure-devops/${key}`;
  const suffix = fullPath.substring(fullPath.indexOf(prefix) + prefix.length);

  const auth = `Basic ${Buffer.from(`:${org.pat || ''}`).toString('base64')}`;
  return proxyTo(c, `${org.target}${suffix}`, auth);
});

// Jira proxy
app.all('/api/jira/*', async (c) => {
  const urlObj = new URL(c.req.raw.url);
  const fullPath = urlObj.pathname + urlObj.search;
  const prefix = `/api/jira`;
  const suffix = fullPath.substring(fullPath.indexOf(prefix) + prefix.length);
  
  return proxyTo(c, `https://api.atlassian.com${suffix}`, jiraAuth);
});

// Health check
app.get('/api/health', (c) => c.json({
  ok: true,
  azure: Object.fromEntries(Object.entries(AZURE_ORGS).map(([k, v]) => [k, { target: v.target || null, hasPat: !!v.pat }])),
  jira: { hasToken: !!jiraToken }
}));

// Экспорт для Vercel
export default handle(app);