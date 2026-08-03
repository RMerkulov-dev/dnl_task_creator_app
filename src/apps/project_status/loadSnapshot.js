// ─── Project Status — data layer ──────────────────────────────────────────────
// One snapshot of a **selected Azure board** (Area Path): its work items joined
// with the Jira request each one is linked to and that request's whole
// descendant tree (epics → tasks → subtasks).
//
// This is the same pipeline PM › Status runs per board, with two differences:
//   • terminal states are NOT dropped. A health report needs the closed work to
//     compute progress ("2 of 3 epics done") and the resolved-per-week trend;
//   • the Jira side asks for the analytics fields (resolutiondate, updated,
//     statuscategorychangedate, components), which is what makes burn-up,
//     throughput and aging computable with no changelog request.
//
// `areaPath: null` still loads the whole project in one WIQL (the "Whole project"
// option, and the only mode for projects without boards) — on ABS that is 1186
// items / ~15 s against ~2–4 s for a single board, which is why the board is
// the load scope and not a client-side filter.
//
// Everything here is I/O + normalisation. All aggregation lives in metrics.js
// and runs over the flat `nodes` array this returns.

import { getBoardWorkItems } from '../../services/azureDevops.js';
import {
  getIssueKeysByAzureIds, getIssuesStatusByKeys, getChildIssuesTreesBulk,
} from '../../services/jira.js';

// Jira fields every request/node carries beyond the Status-app basics.
export const ANALYTICS_FIELDS = [
  'resolutiondate',            // → resolutionDate: the resolved-per-week curve
  'updated',                   // → updated: staleness
  'statuscategorychangedate',  // → statusChanged: time in the current status
  'components',                // → components: [name]
  'created',                   // → created: the burn-up's "created" curve
];

export const CANCELLED = Symbol('project-status-load-cancelled');

// A board load is a few seconds and a whole-project one ~20 s on ABS (1186
// Azure items → 3375 Jira nodes), three quarters of it in the descendant-tree
// phase, so switching boards back and forth must not refetch. Module-level and
// in-memory on purpose: the snapshot holds Maps and runs over 1 MB serialised,
// which is the wrong shape for sessionStorage — and a page reload SHOULD get
// fresh data anyway. `Refresh` bypasses it.
const CACHE = new Map();   // `${projectId}|${areaPath}|${changedSince}` → snapshot

const cacheKey = (projectId, areaPath, changedSince) =>
  `${projectId}|${areaPath ?? '*'}|${changedSince ?? 'all'}`;

export function getCachedSnapshot(projectId, areaPath, changedSince) {
  return CACHE.get(cacheKey(projectId, areaPath, changedSince)) ?? null;
}

export function clearSnapshotCache(projectId) {
  if (!projectId) return CACHE.clear();
  for (const k of CACHE.keys()) if (k.startsWith(`${projectId}|`)) CACHE.delete(k);
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// 'YYYY-MM-DD' for `monthsBack` months ago, or null for "no lower bound".
export function monthsAgo(monthsBack) {
  if (!monthsBack) return null;
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack);
  return d.toISOString().slice(0, 10);
}

// The Jira project keys to search when resolving Azure ids → keys. ABS stamps
// its Azure id on issues in both ABS and ABSPO, hence jiraProjectOptions.
function jiraProjectKeys(proj) {
  return proj.jiraProjectOptions?.length ? proj.jiraProjectOptions : proj.jira.projectKey;
}

const isEpicType = t => /epic/i.test(t || '');

/**
 * Flatten the per-request descendant trees into one array, denormalising the
 * context every metric needs onto each node: which request it hangs under,
 * which Azure work item that request is, the item's Area Path (= board) and the
 * nearest Epic ancestor. With that, every chart is a filter + reduce over one
 * flat list instead of a tree walk.
 */
function flattenTrees(trees, azureByRequestKey) {
  const nodes = [];
  const walk = (list, requestKey, epicKey, depth) => {
    for (const n of list || []) {
      const az = azureByRequestKey.get(requestKey);
      const ownEpic = isEpicType(n.type) ? n.key : epicKey;
      nodes.push({
        ...n,
        children:   undefined,      // the tree stays in `trees`; this list is flat
        requestKey,
        epicKey:    ownEpic,
        isEpic:     isEpicType(n.type),
        depth,
        azureId:    az?.id ?? null,
        areaPath:   az?.areaPath ?? '',
        azureState: az?.state ?? '',
      });
      if (n.children?.length) walk(n.children, requestKey, ownEpic, depth + 1);
    }
  };
  for (const [requestKey, list] of trees) walk(list, requestKey, null, 1);
  return nodes;
}

/**
 * Load one board's snapshot (or the whole project when `areaPath` is null).
 *
 * @param {object} proj  entry from config/projects.js
 * @param {object} opts
 *   - areaPath: string | null — Azure Area Path of the board; `UNDER`, so a
 *     parent node covers its whole subtree. null = the whole project.
 *   - changedSince: 'YYYY-MM-DD' | null — WIQL guard on System.ChangedDate.
 *     Cuts the archive out of the payload; note it also hides work closed
 *     before that date, so "% done" is read as "% done in scope".
 *   - excludeStates: string[] | null — normally left null here (see header).
 *   - onProgress({ phase, ...detail }) — 'azure' | 'link' | 'requests' | 'trees' | 'done'
 *   - isCancelled() — checked between phases; throws CANCELLED when true.
 *   - force: true — ignore the in-memory cache and refetch.
 */
export async function loadProjectSnapshot(proj, opts = {}) {
  const {
    areaPath = null,
    changedSince = null,
    excludeStates = null,
    onProgress = () => {},
    isCancelled = () => false,
    force = false,
  } = opts;

  if (!force) {
    const hit = CACHE.get(cacheKey(proj.id, areaPath, changedSince));
    if (hit) { onProgress({ phase: 'done', cached: true, counts: hit.counts }); return hit; }
  }

  const t = {};
  const started = nowMs();
  const check = () => { if (isCancelled()) throw CANCELLED; };

  // ── 1. Azure: the selected board in one WIQL + detail batches of 200 ──────
  onProgress({ phase: 'azure' });
  let t0 = nowMs();
  const azItems = await getBoardWorkItems(
    proj.azure.proxyKey,
    proj.azure.project,
    proj.azure.jiraIdField,
    areaPath || null,              // the board IS the load scope
    null,
    {
      excludeStates: excludeStates?.length ? excludeStates : undefined,
      changedSince,
      onProgress: p => onProgress({ phase: 'azure', ...p }),
    },
  );
  t.azure = nowMs() - t0;
  check();

  const azure = azItems.map(i => ({
    id:          i.id,
    title:       i.title,
    type:        i.type,
    state:       i.state,
    assignedTo:  i.assignedTo,
    parentId:    i.parentId,
    url:         i.url,
    jiraKey:     i.jiraKey,
    areaPath:    i.fields?.['System.AreaPath'] || '',
    iterationPath: i.fields?.['System.IterationPath'] || '',
    createdDate: i.fields?.['System.CreatedDate'] || '',
    changedDate: i.fields?.['System.ChangedDate'] || '',
    closedDate:  i.fields?.['Microsoft.VSTS.Common.ClosedDate'] || '',
    commentCount: i.fields?.['System.CommentCount'] ?? 0,
  }));

  // ── 2. Azure id → Jira key (authoritative side: the Jira custom field) ────
  onProgress({ phase: 'link', items: azure.length });
  t0 = nowMs();
  const keyByAzureId = await getIssueKeysByAzureIds(
    proj.jira.cloudId,
    jiraProjectKeys(proj),
    proj.jira.clientRequestIdField,
    azure.map(i => i.id),
  );
  t.link = nowMs() - t0;
  check();

  for (const row of azure) {
    row.jiraKey = keyByAzureId.get(String(row.id)) ?? row.jiraKey;
  }

  // ── 3. The requests themselves ────────────────────────────────────────────
  const keys = [...new Set(azure.map(i => i.jiraKey).filter(Boolean))];
  onProgress({ phase: 'requests', keys: keys.length });
  t0 = nowMs();
  const requests = await getIssuesStatusByKeys(proj.jira.cloudId, keys, { fields: ANALYTICS_FIELDS });
  t.requests = nowMs() - t0;
  check();

  // ── 4. Every request's descendant tree, level by level in bulk ────────────
  const requestKeys = keys.filter(k => requests.has(k));
  onProgress({ phase: 'trees', requests: requestKeys.length });
  t0 = nowMs();
  const trees = requestKeys.length
    ? await getChildIssuesTreesBulk(proj.jira.cloudId, requestKeys, 5, {
        fields: ANALYTICS_FIELDS,
        onProgress: p => onProgress({ phase: 'trees', requests: requestKeys.length, ...p }),
      })
    : new Map();
  t.trees = nowMs() - t0;
  check();

  // ── 5. Normalise ──────────────────────────────────────────────────────────
  const azureByRequestKey = new Map();
  for (const row of azure) {
    if (row.jiraKey && !azureByRequestKey.has(row.jiraKey)) azureByRequestKey.set(row.jiraKey, row);
  }
  const nodes = flattenTrees(trees, azureByRequestKey);
  t.total = nowMs() - started;

  const snapshot = {
    projectId:  proj.id,
    areaPath:   areaPath || null,
    loadedAt:   new Date().toISOString(),
    changedSince,
    azure,
    areaPaths:  [...new Set(azure.map(i => i.areaPath).filter(Boolean))].sort(),
    requests,
    trees,
    nodes,
    azureByRequestKey,
    timings: t,
    counts: {
      azure:     azure.length,
      linked:    azure.filter(i => i.jiraKey).length,
      requests:  requests.size,
      nodes:     nodes.length,
      epics:     nodes.filter(n => n.isEpic).length,
      resolvedDatesPresent: nodes.filter(n => n.resolutionDate).length,
    },
  };
  CACHE.set(cacheKey(proj.id, areaPath, changedSince), snapshot);
  onProgress({ phase: 'done', counts: snapshot.counts });
  return snapshot;
}
