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
  const parts = req.query.path;
  const segments = Array.isArray(parts) ? parts : [parts];
  const qs  = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  // Vercel URL-decodes path segments — re-encode before forwarding
  const url = `https://api.atlassian.com/${segments.map(s => encodeURIComponent(s)).join('/')}${qs}`;

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
