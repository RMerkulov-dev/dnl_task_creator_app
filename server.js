import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function buildAzureTarget(raw) {
  if (!raw) return '';
  const clean = raw.trim().replace(/[,/\s]+$/, '');
  if (!clean) return '';
  if (clean.startsWith('http')) {
    // Already a full URL — if it's NOT dev.azure.com style, convert it
    // e.g. https://dynamicalabsdevops → https://dev.azure.com/dynamicalabsdevops
    if (clean.includes('dev.azure.com')) return clean;
    const orgName = clean.replace(/^https?:\/\//, '');
    return `https://dev.azure.com/${orgName}`;
  }
  return `https://dev.azure.com/${clean}`;
}

function azureAuth(pat) {
  return `Basic ${Buffer.from(`:${pat || ''}`).toString('base64')}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyRequest(req, res, targetBase, authHeader) {
  const suffix = req.originalUrl.replace(req.baseUrl, '');
  const url    = `${targetBase}${suffix}`;
  try {
    const isBody = !['GET', 'HEAD'].includes(req.method);
    const body   = isBody ? await readBody(req) : undefined;
    const headers = { Authorization: authHeader, Accept: 'application/json' };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (body?.length)                headers['Content-Length'] = String(body.length);

    const upstream = await fetch(url, { method: req.method, headers, body });
    const text     = await upstream.text();
    res.status(upstream.status)
       .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(text);
  } catch (err) {
    console.error(`[Proxy error] ${url}:`, err.message);
    res.status(503).json({ error: err.message });
  }
}

// ─── Azure org registry ───────────────────────────────────────────────────────
// Each key maps to a .env variable pair: AZURE_<KEY>_ORG_URL + AZURE_<KEY>_PAT
// Add new projects here by adding a new key + env vars — no other server changes needed.
const AZURE_ORGS = {
  ht: {
    target: buildAzureTarget(process.env.AZURE_DEVOPS_ORG_URL || process.env.AZURE_DEVOPS_ORG),
    auth:   azureAuth(process.env.AZURE_DEVOPS_PAT),
  },
  nsmg: {
    target: buildAzureTarget(process.env.AZURE_NSMG_ORG_URL),
    auth:   azureAuth(process.env.AZURE_NSMG_PAT),
  },
  abs: {
    target: buildAzureTarget(process.env.AZURE_ABS_ORG_URL),
    auth:   azureAuth(process.env.AZURE_ABS_PAT),
  },
};

const jiraEmail = process.env.JIRA_EMAIL       || '';
const jiraToken = process.env.JIRA_API_TOKEN   || '';
const jiraAuth  = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`;

// Log startup config
Object.entries(AZURE_ORGS).forEach(([key, cfg]) => {
  const status = cfg.target ? `✓ ${cfg.target}` : '✗ (not configured)';
  console.log(`[Server] Azure [${key.toUpperCase()}]: ${status}`);
});
console.log(`[Server] Jira: ${jiraEmail || '(not configured)'}`);

// ─── Routes ───────────────────────────────────────────────────────────────────

// Register one proxy route per Azure org — path: /api/azure-devops/<orgKey>/...
Object.entries(AZURE_ORGS).forEach(([key, cfg]) => {
  app.use(`/api/azure-devops/${key}`, (req, res) => {
    if (!cfg.target) {
      return res.status(503).json({
        error: `Azure org "${key.toUpperCase()}" is not configured. Add AZURE_${key.toUpperCase()}_ORG_URL and AZURE_${key.toUpperCase()}_PAT to .env`,
      });
    }
    proxyRequest(req, res, cfg.target, cfg.auth);
  });
});

// Jira proxy (shared across all projects)
app.use('/api/jira', (req, res) => proxyRequest(req, res, 'https://api.atlassian.com', jiraAuth));

// Health check — useful for debugging
app.get('/api/health', (_req, res) => res.json({
  ok: true,
  azure: Object.fromEntries(
    Object.entries(AZURE_ORGS).map(([k, v]) => [k, { target: v.target || null, hasPat: v.auth !== azureAuth('') }])
  ),
  jira: { email: jiraEmail, hasToken: !!jiraToken },
}));

// ─── Serve React build (production) ──────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
}

// ─── Startup connectivity test (HT) ──────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`[Server] Running on :${PORT}`);
  const { target, auth } = AZURE_ORGS.ht;
  if (!target) return;
  try {
    const r = await fetch(`${target}/_apis/projects?api-version=7.0`, {
      headers: { Authorization: auth, Accept: 'application/json' },
    });
    console.log(`[Server] HT connectivity: ${r.ok ? `✓ OK (${r.status})` : `✗ Failed (${r.status})`}`);
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      if (body && !body.trimStart().startsWith('<')) console.warn('[Server]', body.slice(0, 300));
    }
  } catch (err) {
    console.error(`[Server] HT unreachable: ${err.message}`);
  }
});
