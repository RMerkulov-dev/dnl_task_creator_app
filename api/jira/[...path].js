// Vercel serverless proxy for Jira / Atlassian API
// Handles: /api/jira/<rest...>

export const config = { api: { bodyParser: false } };

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
  // req.url example: /api/jira/ex/jira/cloud-id/rest/api/3/issue
  const rawUrl   = req.url;
  const qIdx     = rawUrl.indexOf('?');
  const fullPath = qIdx === -1 ? rawUrl : rawUrl.substring(0, qIdx);
  const qs       = qIdx === -1 ? '' : rawUrl.substring(qIdx);

  // Strip /api/jira prefix to get the Atlassian path
  const BASE    = '/api/jira';
  const suffix  = fullPath.startsWith(BASE) ? fullPath.substring(BASE.length) : fullPath;

  const url = `https://api.atlassian.com${suffix}${qs}`;

  const email = process.env.JIRA_EMAIL      || '';
  const token = process.env.JIRA_API_TOKEN  || '';
  const auth  = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  try {
    const isBody = !['GET', 'HEAD'].includes(req.method);
    const body   = isBody ? await readBody(req) : undefined;
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (body?.length)                headers['Content-Length'] = String(body.length);

    const upstream = await fetch(url, { method: req.method, headers, body });
    const text     = await upstream.text();
    res.status(upstream.status)
       .setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(text);
  } catch (err) {
    console.error(`[Jira proxy error] ${url}:`, err.message);
    res.status(503).json({ error: err.message });
  }
}
