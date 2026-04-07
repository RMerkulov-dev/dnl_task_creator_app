// Vercel serverless proxy for Azure DevOps
// Handles: /api/azure-devops/<orgKey>/<rest...>

export const config = { api: { bodyParser: false } };

const ORGS = {
  ht:   { orgUrl: process.env.AZURE_DEVOPS_ORG_URL, pat: process.env.AZURE_DEVOPS_PAT },
  nsmg: { orgUrl: process.env.AZURE_NSMG_ORG_URL,   pat: process.env.AZURE_NSMG_PAT },
  abs:  { orgUrl: process.env.AZURE_ABS_ORG_URL,    pat: process.env.AZURE_ABS_PAT },
};

function buildTarget(raw) {
  if (!raw) return '';
  const clean = raw.trim().replace(/[,/\s]+$/, '');
  if (!clean) return '';
  if (clean.includes('dev.azure.com')) return clean;
  if (clean.startsWith('http')) return `https://dev.azure.com/${clean.replace(/^https?:\/\//, '')}`;
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

export default async function handler(req, res) {
  // Parse req.url directly to preserve original percent-encoding.
  // req.url example: /api/azure-devops/abs/ABS%20-%20Dynamics%20365/_apis/wit/...?api-version=7.0
  const rawUrl = req.url;
  const qIdx     = rawUrl.indexOf('?');
  const fullPath  = qIdx === -1 ? rawUrl : rawUrl.substring(0, qIdx);
  const qs        = qIdx === -1 ? '' : rawUrl.substring(qIdx);

  const BASE = '/api/azure-devops/';
  const afterBase = fullPath.startsWith(BASE) ? fullPath.substring(BASE.length) : fullPath.substring(1);

  const slashIdx = afterBase.indexOf('/');
  const key      = decodeURIComponent(slashIdx === -1 ? afterBase : afterBase.substring(0, slashIdx));
  const suffix   = slashIdx === -1 ? '' : afterBase.substring(slashIdx); // e.g. /ABS%20-%20Dynamics%20365/_apis/...

  const org = ORGS[key];
  if (!org?.orgUrl) {
    return res.status(503).json({
      error: `Azure org "${key}" is not configured. Add AZURE_${(key || '').toUpperCase()}_ORG_URL and AZURE_${(key || '').toUpperCase()}_PAT to environment variables.`,
    });
  }

  const target = buildTarget(org.orgUrl);
  const url    = `${target}${suffix}${qs}`;

  console.log(`[Azure proxy] req.url=${req.url} → upstream=${url}`);

  try {
    const isBody = !['GET', 'HEAD'].includes(req.method);
    const body   = isBody ? await readBody(req) : undefined;
    const headers = { Authorization: azureAuth(org.pat), Accept: 'application/json' };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (body?.length)                headers['Content-Length'] = String(body.length);

    const upstream = await fetch(url, { method: req.method, headers, body });
    const text     = await upstream.text();
    if (!upstream.ok) {
      console.error(`[Azure proxy] ${upstream.status} from ${url} — body: ${text.substring(0, 300)}`);
    }
    res.status(upstream.status)
       .setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(text);
  } catch (err) {
    console.error(`[Azure proxy error] ${url}:`, err.message);
    res.status(503).json({ error: err.message });
  }
}
