const BASE = '/api/azure-devops';

function patch(fields) {
  return Object.entries(fields).map(([path, value]) => ({
    op: 'add',
    path: `/fields/${path}`,
    value,
  }));
}

async function parseResponse(res, label) {
  const text = await res.text();

  // Detect HTML (proxy not running, or auth redirect)
  if (text.trimStart().startsWith('<')) {
    if (res.status === 503) {
      throw new Error('Proxy server not reachable — run "npm run dev" (not just "vite").');
    }
    throw new Error(
      `Azure DevOps returned HTML (status ${res.status}). ` +
      `Check that the proxy server is running and the PAT is valid.`
    );
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`${label}: invalid response (status ${res.status})`);
  }

  if (!res.ok) {
    throw new Error(data.message || data.error || data.value?.Message || `Azure DevOps error ${res.status}`);
  }
  return data;
}

export async function createWorkItem(project, type, fields) {
  const url = `${BASE}/${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.0`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(patch(fields)),
  });
  return parseResponse(res, 'createWorkItem');
}

export async function updateWorkItem(project, id, fields) {
  const url = `${BASE}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=7.0`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(patch(fields)),
  });
  return parseResponse(res, 'updateWorkItem');
}

export async function getWorkItem(project, id) {
  const url = `${BASE}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=7.0`;
  const res = await fetch(url);
  return parseResponse(res, 'getWorkItem');
}

export function getEpicUrl(org, project, id) {
  return `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_workitems/edit/${id}`;
}
