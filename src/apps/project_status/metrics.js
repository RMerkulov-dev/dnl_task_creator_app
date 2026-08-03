// ─── Project Status — aggregation ─────────────────────────────────────────────
// Pure functions over one board snapshot (loadSnapshot.js). No I/O, no React:
// `buildReport(snapshot)` returns every number the report renders.
//
// The core idea is the **progress rollup**: an Azure work item is done to the
// degree its Jira request's epics are done, and an epic is done to the degree
// its own tasks are done. So "a request with 3 epics, 2 Done and 1 in progress"
// is not 67% — it is 67% plus whatever share of the third epic's tasks are
// closed, which is the number a PM actually wants.

import { getJiraUrl } from '../../services/jira.js';

export const DONE = 'done';
export const PROGRESS = 'progress';
export const TODO = 'todo';

export const BUCKET_LABEL = { [DONE]: 'Done', [PROGRESS]: 'In progress', [TODO]: 'Not started' };

// Weight of one issue in a progress average. An in-progress issue counts half:
// it is the only honest single number without story points, and it keeps a board
// where everything is "Doing" from reading as 0%.
const WEIGHT = { [DONE]: 1, [PROGRESS]: 0.5, [TODO]: 0 };

const DONE_NAME_RE = /^(done|closed|resolved|complete|completed|deployed|cancelled|canceled)\b/i;
const PROGRESS_NAME_RE = /(progress|doing|review|testing|test in|qa|stage|uat|dev\b|blocked|hold)/i;

/**
 * Which of the three states an issue is in. Jira's statusCategory is the
 * authority (new | indeterminate | done); the name heuristics only cover issues
 * whose category came back empty — and Azure's `System.State`, which is NOT an
 * enum to switch on (ABS alone has 15 values with inconsistent casing).
 */
export function bucketOfStatus(statusCategory, statusName) {
  if (statusCategory === 'done') return DONE;
  if (statusCategory === 'indeterminate') return PROGRESS;
  if (statusCategory === 'new') return TODO;
  const name = statusName || '';
  if (DONE_NAME_RE.test(name)) return DONE;
  if (PROGRESS_NAME_RE.test(name)) return PROGRESS;
  return TODO;
}

const bucketOfNode = n => bucketOfStatus(n.statusCategory, n.status);
export const bucketOfAzureState = state => bucketOfStatus('', state);

const isEpic = n => n.isEpic;

// ─── Progress of one Azure item ───────────────────────────────────────────────

function emptyCounts() { return { [DONE]: 0, [PROGRESS]: 0, [TODO]: 0, total: 0 }; }

function tally(nodes) {
  const c = emptyCounts();
  for (const n of nodes) { c[bucketOfNode(n)]++; c.total++; }
  return c;
}

// Weighted share of a set of issues that is complete, 0..1.
function shareDone(counts) {
  if (!counts.total) return null;
  return (counts[DONE] * WEIGHT[DONE] + counts[PROGRESS] * WEIGHT[PROGRESS]) / counts.total;
}

/**
 * Roll a request's descendant tree up into one progress figure.
 *
 * Levels, in order of preference:
 *   1. the request has epics → each epic's own progress (its tasks, else its
 *      own status), averaged with equal weight per epic;
 *   2. no epics but direct children → the weighted share of those;
 *   3. nothing below it → the request's own status.
 * `basis` says which rule produced the number, so the UI can be honest about it.
 */
export function rollupRequest(request, treeNodes) {
  const epics = treeNodes.filter(isEpic);
  const tasks = treeNodes.filter(n => !isEpic(n));

  const epicRows = epics.map(e => {
    const own = tasks.filter(t => t.epicKey === e.key);
    const counts = tally(own);
    const share = counts.total ? shareDone(counts) : WEIGHT[bucketOfNode(e)];
    return {
      key: e.key,
      url: getJiraUrl(e.key),
      summary: e.summary,
      status: e.status,
      bucket: bucketOfNode(e),
      assignee: e.assignee,
      tasks: counts,
      pct: Math.round(share * 100),
      updated: e.updated || '',
      statusChanged: e.statusChanged || e.updated || '',
    };
  }).sort((a, b) => a.pct - b.pct || a.key.localeCompare(b.key));

  const epicCounts = tally(epics);
  const taskCounts = tally(tasks);

  let share = null;
  let basis = 'status';
  if (epicRows.length) {
    share = epicRows.reduce((s, e) => s + e.pct / 100, 0) / epicRows.length;
    basis = 'epics';
  } else if (taskCounts.total) {
    share = shareDone(taskCounts);
    basis = 'tasks';
  } else if (request) {
    share = WEIGHT[bucketOfNode(request)];
    basis = 'status';
  }

  return {
    pct: share === null ? null : Math.round(share * 100),
    basis,
    epics: epicCounts,
    tasks: taskCounts,
    epicRows,
  };
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

const DAY = 86400000;

const parseDate = v => {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

// Monday 00:00 of the week a timestamp falls in.
function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

// When a node became done: resolutiondate on ~88% of ABS's closed issues, with
// statuscategorychangedate (100% coverage) as the fallback.
const resolvedAt = n => parseDate(n.resolutionDate) ?? parseDate(n.statusChanged);

export const daysSince = v => {
  const t = parseDate(v);
  return t === null ? null : Math.floor((Date.now() - t) / DAY);
};

// ─── The report ───────────────────────────────────────────────────────────────

export const PROGRESS_BINS = [
  { id: 'b0',   label: '0%',      test: p => p === 0 },
  { id: 'b25',  label: '1–25%',   test: p => p > 0 && p <= 25 },
  { id: 'b50',  label: '26–50%',  test: p => p > 25 && p <= 50 },
  { id: 'b75',  label: '51–75%',  test: p => p > 50 && p <= 75 },
  { id: 'b99',  label: '76–99%',  test: p => p > 75 && p < 100 },
  { id: 'b100', label: '100%',    test: p => p === 100 },
];

const AGING_BINS = [
  { label: '≤ 7 days',    max: 7 },
  { label: '8–30 days',   max: 30 },
  { label: '31–90 days',  max: 90 },
  { label: '> 90 days',   max: Infinity },
];

const STALE_DAYS = 30;

function countBy(list, keyFn) {
  const out = new Map();
  for (const item of list) {
    const k = keyFn(item);
    if (k == null) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return [...out.entries()].map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

// Keep the top `n` rows and fold the tail into one "Other" row: past ~7 classes
// a bar chart stops being readable and the tail belongs in a table.
function topN(rows, n, restLabel = 'Other') {
  if (rows.length <= n) return rows;
  const rest = rows.slice(n).reduce((s, r) => s + r.value, 0);
  return [...rows.slice(0, n), { label: `${restLabel} (${rows.length - n})`, value: rest, rest: true }];
}

/**
 * Every number the report shows, computed from one snapshot.
 * Charts read the `items` list too, so a table filter and the charts can share
 * the same rows (see `buildCharts`).
 */
export function buildReport(snapshot) {
  const { azure, requests, nodes } = snapshot;

  // Group the flat node list once — every per-item rollup then reads its own
  // slice instead of scanning all ~3k nodes per item.
  const byRequest = new Map();
  for (const n of nodes) {
    const list = byRequest.get(n.requestKey);
    if (list) list.push(n); else byRequest.set(n.requestKey, [n]);
  }

  // Two Azure items occasionally point at the SAME Jira request. Each one is
  // scored from that request (correct per row), but the epic/task TOTALS must
  // count the tree once — hence `firstForRequest`, the flag every aggregate
  // filters on.
  const seenRequest = new Set();

  const items = azure.map(az => {
    const request = az.jiraKey ? requests.get(az.jiraKey) ?? null : null;
    const tree = az.jiraKey ? byRequest.get(az.jiraKey) ?? [] : [];
    const roll = request || tree.length ? rollupRequest(request, tree) : null;
    const azBucket = bucketOfAzureState(az.state);
    const lastActivity = Math.max(
      parseDate(az.changedDate) ?? 0,
      ...tree.map(n => parseDate(n.updated) ?? 0),
    ) || null;
    const firstForRequest = !az.jiraKey || !seenRequest.has(az.jiraKey);
    if (az.jiraKey) seenRequest.add(az.jiraKey);

    return {
      ...az,
      request,
      firstForRequest,
      jiraStatus: request?.status ?? '',
      jiraBucket: request ? bucketOfNode(request) : null,
      jiraUrl: az.jiraKey ? getJiraUrl(az.jiraKey) : '',
      azBucket,
      pct: roll?.pct ?? null,
      basis: roll?.basis ?? null,
      epics: roll?.epics ?? emptyCounts(),
      tasks: roll?.tasks ?? emptyCounts(),
      epicRows: roll?.epicRows ?? [],
      nodeCount: tree.length,
      lastActivity,
      staleDays: lastActivity ? Math.floor((Date.now() - lastActivity) / DAY) : null,
    };
  });

  const scored = items.filter(i => i.pct !== null);
  const uniq = items.filter(i => i.firstForRequest);
  const epicsTotal = uniq.reduce((s, i) => s + i.epics.total, 0);
  const epicsDone  = uniq.reduce((s, i) => s + i.epics[DONE], 0);
  const tasksTotal = uniq.reduce((s, i) => s + i.tasks.total, 0);
  const tasksDone  = uniq.reduce((s, i) => s + i.tasks[DONE], 0);
  const tasksProg  = uniq.reduce((s, i) => s + i.tasks[PROGRESS], 0);

  const kpi = {
    items:      items.length,
    linked:     items.filter(i => i.jiraKey).length,
    unlinked:   items.filter(i => !i.jiraKey).length,
    // The headline: the average board progress over the items we can score.
    avgPct:     scored.length ? Math.round(scored.reduce((s, i) => s + i.pct, 0) / scored.length) : 0,
    scored:     scored.length,
    itemsDone:  scored.filter(i => i.pct === 100).length,
    itemsWip:   scored.filter(i => i.pct > 0 && i.pct < 100).length,
    itemsIdle:  scored.filter(i => i.pct === 0).length,
    epicsTotal, epicsDone,
    epicsPct:   epicsTotal ? Math.round((epicsDone / epicsTotal) * 100) : 0,
    tasksTotal, tasksDone, tasksProg,
    tasksOpen:  tasksTotal - tasksDone,
    tasksPct:   tasksTotal ? Math.round((tasksDone / tasksTotal) * 100) : 0,
    stale:      items.filter(i => i.staleDays !== null && i.staleDays > STALE_DAYS && i.pct !== 100).length,
  };

  const risks = {
    unlinked:      items.filter(i => !i.jiraKey),
    noChildren:    items.filter(i => i.jiraKey && i.nodeCount === 0),
    emptyEpics:    uniq.flatMap(i => i.epicRows.filter(e => !e.tasks.total).map(e => ({ ...e, itemId: i.id }))),
    stale:         items.filter(i => i.staleDays !== null && i.staleDays > STALE_DAYS && i.pct !== 100)
                     .sort((a, b) => b.staleDays - a.staleDays),
    // Azure says closed, the Jira tree does not — the mismatch a status report
    // exists to surface.
    stateMismatch: items.filter(i => i.pct !== null && (
      (i.azBucket === DONE && i.pct < 100) || (i.azBucket !== DONE && i.pct === 100)
    )),
  };

  return { items, kpi, risks, charts: buildCharts(items) };
}

/**
 * The chart series, over whatever slice of items is passed in — so the table's
 * filter can repaint the charts with the same function.
 */
export function buildCharts(items) {
  // Per-tree series count each Jira tree once (see `firstForRequest`).
  const epicRows = items.filter(i => i.firstForRequest !== false).flatMap(i => i.epicRows);

  // Progress distribution — one column per bin, plus the item ids behind it so
  // clicking a column can filter the table.
  const progressBins = PROGRESS_BINS.map(bin => {
    const hit = items.filter(i => i.pct !== null && bin.test(i.pct));
    return { id: bin.id, label: bin.label, value: hit.length, ids: hit.map(i => i.id) };
  });

  // Part-to-whole splits (the three states) for the two levels of the tree.
  const split = (list, bucketFn) => {
    const c = emptyCounts();
    for (const x of list) { c[bucketFn(x)]++; c.total++; }
    return [DONE, PROGRESS, TODO].map(k => ({ key: k, label: BUCKET_LABEL[k], value: c[k] }));
  };

  const epicSplit = split(epicRows, e => e.bucket);
  const taskSplit = [DONE, PROGRESS, TODO].map(k => ({
    key: k,
    label: BUCKET_LABEL[k],
    value: items.filter(i => i.firstForRequest !== false).reduce((s, i) => s + i.tasks[k], 0),
  }));
  const itemSplit = split(items.filter(i => i.pct !== null), i => (
    i.pct === 100 ? DONE : i.pct > 0 ? PROGRESS : TODO
  ));

  const azureStates = topN(countBy(items, i => i.state || '—'), 7);
  const openJiraStatuses = topN(
    countBy(epicRows.filter(e => e.bucket !== DONE), e => e.status || '—'),
    7,
  );

  const assignees = topN(
    countBy(items.filter(i => i.pct !== null && i.pct < 100), i => i.assignedTo || 'Unassigned'),
    8,
  );

  // Aging of the open epics, by time in the current status
  // (statuscategorychangedate — 100% coverage on ABS).
  const agingSrc = epicRows.filter(e => e.bucket !== DONE);
  const aging = AGING_BINS.map((bin, idx) => {
    const lo = idx ? AGING_BINS[idx - 1].max : -1;
    return {
      label: bin.label,
      value: agingSrc.filter(e => {
        const d = daysSince(e.statusChanged);
        return d !== null && d > lo && d <= bin.max;
      }).length,
    };
  });

  return {
    progressBins, itemSplit, epicSplit, taskSplit,
    azureStates, openJiraStatuses, assignees, aging,
  };
}

/**
 * Weekly created / resolved curves over the snapshot's Jira nodes.
 * Trends come from dates, not from a changelog (there is no snapshot store):
 * `created` for the intake curve, resolutiondate (statuscategorychangedate as
 * fallback) for the closed one. Capped to the last `weeks` buckets so a 3-year
 * project does not render 150 columns.
 */
export function buildTrend(snapshot, weeks = 16) {
  const nodes = snapshot.nodes.filter(n => !n.isEpic);
  const now = weekStart(Date.now());
  const from = now - (weeks - 1) * 7 * DAY;

  const axis = [];
  for (let t = from; t <= now; t += 7 * DAY) axis.push(t);
  const idxOf = t => Math.floor((weekStart(t) - from) / (7 * DAY));

  const created = new Array(axis.length).fill(0);
  const resolved = new Array(axis.length).fill(0);
  let backlogBefore = 0;      // open at the start of the window

  for (const n of nodes) {
    const c = parseDate(n.created);
    const r = bucketOfNode(n) === DONE ? resolvedAt(n) : null;
    if (c !== null) {
      const i = idxOf(c);
      if (i >= 0 && i < axis.length) created[i]++;
      else if (i < 0 && (r === null || idxOf(r) >= 0)) backlogBefore++;
    }
    if (r !== null) {
      const i = idxOf(r);
      if (i >= 0 && i < axis.length) resolved[i]++;
    }
  }

  // Open work over time: the pre-window backlog plus intake minus closures.
  let open = backlogBefore;
  const points = axis.map((t, i) => {
    open += created[i] - resolved[i];
    return { t, created: created[i], resolved: resolved[i], open: Math.max(0, open) };
  });

  return { points, weeks: axis.length, backlogBefore };
}

export const fmtDate = ms => new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
