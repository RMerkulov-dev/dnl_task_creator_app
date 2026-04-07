// Vercel serverless proxy — plain Node.js (no framework)
// Handles: /api/azure-devops/<key>/...  and  /api/jira/...

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

// ─── Read raw request body ────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ─── Generic proxy ────────────────────────────────────────────────────────────
async function proxyTo(req, res, upstreamUrl, authHeader) {
  const method = req.method;
  const isBody = !['GET', 'HEAD'].includes(method);

  const headers = new Headers({ Authorization: authHeader, Accept: 'application/json' });
  const ct = req.headers['content-type'];
  if (ct) headers.set('Content-Type', ct);

  const body = isBody ? await readBody(req) : undefined;

  console.log(`[Proxy] ${method} → ${upstreamUrl}`);

  try {
    const upstream = await fetch(upstreamUrl, { method, headers, body });
    const text     = await upstream.text();
    if (!upstream.ok) {
      console.error(`[Proxy] ${upstream.status} ← ${upstreamUrl}: ${text.slice(0, 300)}`);
    }
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.end(text);
  } catch (err) {
    console.error(`[Proxy error] ${err.message}`);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message }));
  }
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // req.url is the full path+qs, e.g. /api/azure-devops/abs/Project%20Name/_apis/...?api-version=7.0
  const rawUrl = req.url;

  // Azure DevOps proxy — /api/azure-devops/:key/...
  if (rawUrl.startsWith('/api/azure-devops/')) {
    const afterPrefix = rawUrl.substring('/api/azure-devops/'.length); // key/rest...
    const slashIdx    = afterPrefix.indexOf('/');
    const key         = slashIdx === -1 ? afterPrefix.split('?')[0] : afterPrefix.substring(0, slashIdx);
    const rest        = slashIdx === -1 ? '' : afterPrefix.substring(slashIdx); // /Project%20Name/...?qs

    const org = AZURE_ORGS[key];
    if (!org?.target) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Azure org "${key}" is not configured.` }));
      return;
    }

    const auth = `Basic ${Buffer.from(`:${org.pat || ''}`).toString('base64')}`;
    return proxyTo(req, res, `${org.target}${rest}`, auth);
  }

  // Jira proxy — /api/jira/...
  if (rawUrl.startsWith('/api/jira/')) {
    const suffix = rawUrl.substring('/api/jira'.length); // /ex/jira/...?qs
    const email  = process.env.JIRA_EMAIL     || '';
    const token  = process.env.JIRA_API_TOKEN || '';
    const auth   = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
    return proxyTo(req, res, `https://api.atlassian.com${suffix}`, auth);
  }

  // Health check — /api/health
  if (rawUrl.startsWith('/api/health')) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok:  true,
      env: {
        AZURE_DEVOPS_ORG_URL: process.env.AZURE_DEVOPS_ORG_URL ? '✓ set' : '✗ missing',
        AZURE_NSMG_ORG_URL:   process.env.AZURE_NSMG_ORG_URL   ? '✓ set' : '✗ missing',
        AZURE_ABS_ORG_URL:    process.env.AZURE_ABS_ORG_URL     ? '✓ set' : '✗ missing',
        JIRA_EMAIL:           process.env.JIRA_EMAIL            ? '✓ set' : '✗ missing',
      },
    }));
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'Not found' }));
}
