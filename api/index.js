import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

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
// Читаем сырое тело запроса (чтобы проксировать создание тасков POST/PATCH)
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyTo(req, res, upstreamUrl, authHeader) {
  const isBody = !['GET', 'HEAD'].includes(req.method);
  const body = isBody ? await readBody(req) : undefined;

  const headers = { 
    'Authorization': authHeader, 
    'Accept': 'application/json' 
  };
  
  if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }

  try {
    // В Node.js 18+ fetch встроен по умолчанию, Vercel его поддерживает
    const upstream = await fetch(upstreamUrl, { 
      method: req.method, 
      headers, 
      body 
    });
    
    const text = await upstream.text();
    
    res.status(upstream.status)
       .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(text);
  } catch (err) {
    console.error(`[Proxy error] ${upstreamUrl}:`, err.message);
    res.status(503).json({ error: err.message });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Azure DevOps proxy
app.use('/api/azure-devops/:key', async (req, res) => {
  const key = req.params.key;
  const org = AZURE_ORGS[key];
  
  if (!org?.target) {
    return res.status(503).json({ error: `Azure org "${key}" is not configured in environment variables.` });
  }

  // Извлекаем точный путь с сохранением %20, используя req.originalUrl
  const prefix = `/api/azure-devops/${key}`;
  const suffix = req.originalUrl.substring(req.originalUrl.indexOf(prefix) + prefix.length);

  const auth = `Basic ${Buffer.from(`:${org.pat || ''}`).toString('base64')}`;
  await proxyTo(req, res, `${org.target}${suffix}`, auth);
});

// Jira proxy
app.use('/api/jira', async (req, res) => {
  const prefix = `/api/jira`;
  const suffix = req.originalUrl.substring(req.originalUrl.indexOf(prefix) + prefix.length);
  
  await proxyTo(req, res, `https://api.atlassian.com${suffix}`, jiraAuth);
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    azure: Object.fromEntries(Object.entries(AZURE_ORGS).map(([k, v]) => [k, { target: v.target || null, hasPat: !!v.pat }])),
    jira: { hasToken: !!jiraToken }
  });
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`[Server] Running locally on http://localhost:${PORT}`);
  });
}

// Обязательно экспортируем app для бессерверной среды Vercel
export default app;