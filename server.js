import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ─── Config ──────────────────────────────────────────────────────────────────
const azurePat   = process.env.AZURE_DEVOPS_PAT   || '';
const jiraEmail  = process.env.JIRA_EMAIL          || '';
const jiraToken  = process.env.JIRA_API_TOKEN      || '';

const rawOrg     = (process.env.AZURE_DEVOPS_ORG_URL || process.env.AZURE_DEVOPS_ORG || '')
  .trim().replace(/[,/\s]+$/, '');
const azureTarget = rawOrg.startsWith('http') ? rawOrg : `https://dev.azure.com/${rawOrg}`;

const azureAuth  = Buffer.from(`:${azurePat}`).toString('base64');
const jiraAuth   = Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

console.log('[Server] Azure target :', azureTarget);
console.log('[Server] Jira email   :', jiraEmail);
console.log('[Server] PAT set      :', !!azurePat);
console.log('[Server] Jira token   :', !!jiraToken);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function buildHeaders(authValue, contentType, bodyBuf) {
  const h = {
    Authorization: authValue,
    Accept: 'application/json',
  };
  if (contentType)            h['Content-Type']   = contentType;
  if (bodyBuf?.length)        h['Content-Length']  = String(bodyBuf.length);
  return h;
}

async function proxy(req, res, targetBase, authValue) {
  const suffix = req.originalUrl.replace(req.baseUrl, '');
  const url    = `${targetBase}${suffix}`;

  try {
    const isBodyMethod = !['GET', 'HEAD'].includes(req.method);
    const body         = isBodyMethod ? await readBody(req) : undefined;
    const headers      = buildHeaders(authValue, req.headers['content-type'], body);

    const upstream = await fetch(url, { method: req.method, headers, body });
    const text     = await upstream.text();

    res
      .status(upstream.status)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
      .send(text);
  } catch (err) {
    console.error('[Proxy error]', err.message);
    res.status(503).json({ error: err.message });
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/api/azure-devops', (req, res) => proxy(req, res, azureTarget, `Basic ${azureAuth}`));
app.use('/api/jira',         (req, res) => proxy(req, res, 'https://api.atlassian.com', `Basic ${jiraAuth}`));

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  azureTarget,
  jiraEmail,
  hasAzurePat:   !!azurePat,
  hasJiraToken:  !!jiraToken,
}));

// ─── Static (production) ─────────────────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
}

app.listen(PORT, async () => {
  console.log(`[Server] Running on :${PORT}`);

  // Startup connectivity test
  const testUrl = `${azureTarget}/_apis/projects?api-version=7.0`;
  try {
    const r = await fetch(testUrl, {
      headers: { Authorization: `Basic ${azureAuth}`, Accept: 'application/json' },
    });
    if (r.ok) {
      console.log(`[Server] ✓ Azure DevOps connection OK (${r.status})`);
    } else {
      const body = await r.text().catch(() => '');
      console.warn(`[Server] ✗ Azure DevOps responded ${r.status} — check PAT and org URL`);
      if (body && !body.startsWith('<')) console.warn('[Server]  ', body.slice(0, 200));
    }
  } catch (err) {
    console.error(`[Server] ✗ Azure DevOps unreachable: ${err.message}`);
    console.error('[Server]   Check AZURE_DEVOPS_ORG_URL in .env');
  }
});
