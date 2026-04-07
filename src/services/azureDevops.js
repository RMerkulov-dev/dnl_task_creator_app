const BASE = '/api/azure-devops';

// ─── Response parser ──────────────────────────────────────────────────────────
async function parse(res, label) {
  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    if (res.status === 503) throw new Error('Proxy server not reachable — run "npm run dev".');
    throw new Error(`Azure DevOps returned HTML (${res.status}) — check proxy & PAT.`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`${label}: invalid response (${res.status}) — ${text.substring(0, 200)}`); }
  if (!res.ok) throw new Error(data.message || data.error || data.value?.Message || `Azure DevOps error ${res.status}`);
  return data;
}

// ─── Work item CRUD ───────────────────────────────────────────────────────────

/**
 * Create a work item.
 * @param {string} proxyKey   - 'ht' | 'nsmg' | 'abs'
 * @param {string} project    - Azure DevOps project name
 * @param {string} type       - 'Epic' | 'Task' | etc.
 * @param {object} fields     - { 'System.Title': '...', ... }
 * @param {Array}  relations  - optional relation objects (e.g. parent link)
 */
export async function createWorkItem(proxyKey, project, type, fields, relations = []) {
  const url = `${BASE}/${proxyKey}/${encodeURIComponent(project)}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.0`;
  const ops = [
    ...Object.entries(fields).map(([path, value]) => ({ op: 'add', path: `/fields/${path}`, value })),
    ...relations.map(rel => ({ op: 'add', path: '/relations/-', value: rel })),
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(ops),
  });
  return parse(res, 'createWorkItem');
}

export async function updateWorkItem(proxyKey, project, id, fields) {
  const url = `${BASE}/${proxyKey}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=7.0`;
  const ops = Object.entries(fields).map(([path, value]) => ({ op: 'add', path: `/fields/${path}`, value }));
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json-patch+json' },
    body: JSON.stringify(ops),
  });
  return parse(res, 'updateWorkItem');
}

export async function getWorkItem(proxyKey, project, id) {
  const url = `${BASE}/${proxyKey}/${encodeURIComponent(project)}/_apis/wit/workitems/${id}?api-version=7.0`;
  const res = await fetch(url);
  return parse(res, 'getWorkItem');
}

// ─── Iterations (Sprints) — used by NSMG ─────────────────────────────────────

/**
 * Returns a flat list of iteration nodes: [{ id, name, path }]
 * `path` is the full iteration path (e.g. "NSMG\\Sprint 1") suitable for System.IterationPath.
 */
export async function getIterations(proxyKey, project) {
  const url = `${BASE}/${proxyKey}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/iterations?$depth=10&api-version=7.0`;
  const res  = await fetch(url);
  const root = await parse(res, 'getIterations');
  const nodes = [];
  flattenNodes(root, '', nodes);
  // Skip the root project node; return children only
  return nodes.filter(n => n.path.includes('\\'));
}

// ─── User Stories — used by NSMG ─────────────────────────────────────────────

/**
 * Returns user stories: [{ id, title, url }]
 * `url` is the Azure DevOps REST API URL needed for the parent relation.
 */
export async function getStories(proxyKey, project) {
  // Step 1: WIQL to get IDs
  const wiqlUrl = `${BASE}/${proxyKey}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.0`;
  const wiqlRes = await fetch(wiqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'User Story' AND [System.TeamProject] = @project AND [System.State] <> 'Closed' ORDER BY [System.Title]`,
    }),
  });
  const wiql = await parse(wiqlRes, 'getStories-wiql');
  const ids  = (wiql.workItems || []).slice(0, 200).map(w => w.id);
  if (!ids.length) return [];

  // Step 2: batch-fetch titles (org-level endpoint, no project in path)
  const batchUrl = `${BASE}/${proxyKey}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title&api-version=7.0`;
  const batchRes = await fetch(batchUrl);
  const batch    = await parse(batchRes, 'getStories-batch');
  return (batch.value || []).map(item => ({
    id:    item.id,
    title: item.fields?.['System.Title'] || `Story #${item.id}`,
    url:   item.url,  // Azure REST API URL — used for parent relation
  }));
}

// ─── Area Paths (Boards) — used by ABS ───────────────────────────────────────

/**
 * Returns a flat list of area path nodes: [{ id, name, path }]
 * `path` is the full area path (e.g. "ABS- Dynamics 365\\Team A") for System.AreaPath.
 */
export async function getAreaPaths(proxyKey, project) {
  const url = `${BASE}/${proxyKey}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/areas?$depth=4&api-version=7.0`;
  const res  = await fetch(url);
  const root = await parse(res, 'getAreaPaths');
  const nodes = [];
  flattenNodes(root, '', nodes);
  return nodes;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function flattenNodes(node, parentPath, result) {
  const fullPath = parentPath ? `${parentPath}\\${node.name}` : node.name;
  result.push({ id: node.id, name: node.name, path: fullPath, attributes: node.attributes ?? {} });
  if (node.children?.length) {
    for (const child of node.children) flattenNodes(child, fullPath, result);
  }
}
