// ─── Health — PM Brain client layer ───────────────────────────────────────────
// Fetches the parsed vault payload (`GET /api/pm-brain/:project`) and derives
// everything the Risks / Milestones tabs chart. Pure aside from the one fetch.

import { PROJECTS } from '../../config/projects.js';
import { DONE } from './metrics.js';

export async function fetchPmBrain(projectId) {
  const res = await fetch(`/api/pm-brain/${encodeURIComponent(projectId)}`);
  const data = await res.json().catch(() => null);
  if (res.status === 503) return data ?? { available: false, reason: 'PM Brain is not configured.' };
  if (!res.ok) throw new Error(data?.error || `PM Brain request failed (${res.status})`);
  return data;
}

// ─── Risk register (machine-owned, in the vault) ───────────────────────────────
// Separate from `fetchPmBrain` on purpose: the register is written by the app and
// changes on every analysis run, while the vault payload is a read of files a
// human edits. They also fail independently — a missing GitHub token makes the
// register read-only without affecting the Milestones tab at all.

export async function fetchRiskRegister(projectId) {
  const res = await fetch(`/api/risks/${encodeURIComponent(projectId)}`);
  const data = await res.json().catch(() => null);
  if (res.status === 503) return data ?? { available: false, reason: 'The vault is not configured.' };
  if (!res.ok) throw new Error(data?.error || `Risk register request failed (${res.status})`);
  return data;
}

export async function seedRiskRegister(projectId) {
  const res = await fetch(`/api/risks/${encodeURIComponent(projectId)}/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || data?.reason || `Seeding failed (${res.status})`);
  return data;
}

export async function overrideRiskStatus(projectId, riskId, status, why) {
  const res = await fetch(`/api/risks/${encodeURIComponent(projectId)}/override`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ riskId, status, why }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Could not set the status (${res.status})`);
  return data.risk;
}

// ─── Risk bands / statuses ────────────────────────────────────────────────────

export const BANDS = ['critical', 'high', 'medium', 'low'];
export const BAND_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
export const BAND_VAR = {
  critical: 'var(--ps-band-crit)',
  high:     'var(--ps-band-high)',
  medium:   'var(--ps-band-med)',
  low:      'var(--ps-band-low)',
};

export const RISK_STATUSES = ['open', 'mitigating', 'watching', 'realized', 'closed'];
export const STATUS_LABEL = {
  open: 'Open', mitigating: 'Mitigating', watching: 'Watching',
  realized: 'Realized', closed: 'Closed',
};

export const SEVERITY_LABEL = { critical: 'Critical', elevated: 'Elevated', watch: 'Watch' };
export const TREND_MARK = { worsened: '▲', improved: '▼', unchanged: '▪' };
export const TREND_LABEL = { worsened: 'worsened', improved: 'improved', unchanged: 'unchanged' };

const count = (list, fn) => {
  const out = new Map();
  for (const x of list) {
    const k = fn(x);
    if (k === null || k === undefined || k === '') continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return [...out.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
};

// RBS codes are "1.2 Technology" / "2.3 Client" — the top-level digit is the
// category that is worth charting; the sub-code is detail for the table.
const topCategory = raw => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const m = /^(\d)(?:\.\d)?\s*(.*)$/.exec(s);
  if (!m) return s;
  const NAMES = { 1: 'Technical', 2: 'External', 3: 'Organizational', 4: 'Project Management' };
  return NAMES[m[1]] ?? (m[2] || s);
};

/**
 * Everything the Risks tab needs, from the RBS register + the canonical graph.
 * The two are deliberately NOT merged into one list: RBS carries P/I scoring per
 * milestone, the graph carries the dated retrospective and the Fathom links —
 * they answer different questions and their ids live in different spaces.
 */
export function buildRiskReport(brain) {
  const risks = brain?.rbs?.risks ?? [];
  const graph = brain?.graph ?? [];
  const open = risks.filter(r => r.status !== 'closed');

  // P×I matrix: 5×5 cells, each holding the risks that landed there.
  const matrix = [];
  for (let i = 5; i >= 1; i--) {
    const row = [];
    for (let p = 1; p <= 5; p++) {
      const hit = open.filter(r => r.p === p && r.i === i);
      row.push({ p, i, score: p * i, risks: hit, value: hit.length });
    }
    matrix.push(row);
  }

  const blockers = [
    ...(brain?.milestones ?? []).flatMap(m => m.blockers.filter(b => b.active).map(b => ({ ...b, milestone: m.name }))),
    ...(brain?.projectLevel?.blockers ?? []).filter(b => b.active).map(b => ({ ...b, milestone: null })),
  ].sort((a, b) => Number(b.high) - Number(a.high) || String(a.since).localeCompare(String(b.since)));

  return {
    risks,
    open,
    graph,
    blockers,
    matrix,
    kpi: {
      total:      risks.length,
      open:       open.length,
      critical:   open.filter(r => r.band === 'critical').length,
      high:       open.filter(r => r.band === 'high').length,
      realized:   risks.filter(r => r.status === 'realized').length,
      unscored:   risks.filter(r => r.score === null).length,
      graphActive:   graph.filter(n => n.status === 'active').length,
      graphCritical: graph.filter(n => n.status === 'active' && n.severity === 'critical').length,
      worsened:      graph.filter(n => n.status === 'active' && n.trend === 'worsened').length,
      blockers:      blockers.length,
      lastReview: brain?.rbs?.lastReview ?? null,
      nextReview: brain?.rbs?.nextReview ?? null,
    },
    charts: {
      byBand:      BANDS.map(b => ({ label: BAND_LABEL[b], value: open.filter(r => r.band === b).length, color: BAND_VAR[b] })),
      byStatus:    RISK_STATUSES.map(s => ({ label: STATUS_LABEL[s], value: risks.filter(r => r.status === s).length })),
      byCategory:  count(open, r => topCategory(r.category)),
      byMilestone: count(open, r => r.milestone),
      byOwner:     count(open, r => r.owner),
      graphBySeverity: ['critical', 'elevated', 'watch'].map(s => ({
        label: SEVERITY_LABEL[s],
        value: graph.filter(n => n.status === 'active' && n.severity === s).length,
      })),
    },
  };
}

// ─── Milestone ↔ Azure board matching ─────────────────────────────────────────

// Words that carry no identity on either side of the match.
const STOP = new Set(['abs', 'nsmg', 'nsmgm', 'marker', 'hydrotec', 'ht', 'ws', 'qg',
  'the', 'and', 'of', 'for', 'only', 'new', 'module', 'review']);

const tokens = s => String(s ?? '')
  .toLowerCase()
  .replace(/[.\-—–_|/\\]+/g, ' ')
  .replace(/[^a-z0-9 ]+/g, '')
  .split(/\s+/)
  .filter(w => w.length > 2 && !STOP.has(w));

/**
 * Match a milestone name against the Area Paths present in the snapshot.
 * Rule: every identity token of the SHORTER side must appear on the other side
 * ("Commission Module" ↔ "ABS - Commission Module", "BUREAU — Quote Management
 * Portal" ↔ "ABS. Bureau"). One shared token is enough only when it is the whole
 * of the shorter side — that is what keeps "Fixed Price" from attaching itself
 * to every board that happens to mention "price".
 *
 * The explicit map in `config/projects.js` (`milestoneBoards`) always wins: name
 * matching cannot know that "WS — Migration from QW" lives under three dotted
 * Area Paths.
 */
export function matchMilestoneBoards(projectId, milestoneName, areaPaths) {
  const proj = Object.values(PROJECTS).find(p => p.id === projectId);
  const manual = proj?.milestoneBoards?.[milestoneName];
  if (manual?.length) {
    const hit = areaPaths.filter(ap => manual.some(m => ap === m || ap.endsWith(`\\${m}`) || leafOf(ap) === m));
    return { boards: hit, how: hit.length ? 'mapped' : 'mapped-missing', mapped: manual };
  }
  const want = tokens(milestoneName);
  if (!want.length) return { boards: [], how: null };
  const boards = areaPaths.filter(ap => {
    const have = tokens(leafOf(ap));
    if (!have.length) return false;
    const [short, long] = want.length <= have.length ? [want, have] : [have, want];
    return short.every(w => long.includes(w));
  });
  return { boards, how: boards.length ? 'auto' : null };
}

export const leafOf = areaPath => String(areaPath ?? '').split('\\').pop();

/**
 * Progress of the matched boards, taken from the already-loaded Health snapshot
 * (`report.items`). Returns null when nothing matched or the snapshot does not
 * cover those boards — the card then says so instead of showing a fake 0%.
 */
export function boardProgressFor(items, boards) {
  if (!boards?.length) return null;
  const set = new Set(boards);
  const rows = items.filter(i => set.has(i.areaPath));
  if (!rows.length) return null;
  const scored = rows.filter(i => i.pct !== null);
  return {
    items: rows.length,
    scored: scored.length,
    pct: scored.length ? Math.round(scored.reduce((s, i) => s + i.pct, 0) / scored.length) : null,
    done: scored.filter(i => i.pct === 100).length,
    epicsTotal: rows.reduce((s, i) => s + i.epics.total, 0),
    epicsDone:  rows.reduce((s, i) => s + i.epics[DONE], 0),
    tasksTotal: rows.reduce((s, i) => s + i.tasks.total, 0),
    tasksDone:  rows.reduce((s, i) => s + i.tasks[DONE], 0),
  };
}

// ─── Milestone timing ─────────────────────────────────────────────────────────

const DAY = 86400000;
const parse = v => (v ? Date.parse(v) : NaN);

/** Where a milestone sits in its own window: elapsed share, days left, overdue. */
export function milestoneTiming(m) {
  const start = parse(m.start), due = parse(m.due);
  const now = Date.now();
  if (Number.isNaN(due)) return { elapsed: null, daysLeft: null, overdue: false, hasWindow: false };
  const daysLeft = Math.ceil((due - now) / DAY);
  const span = Number.isNaN(start) ? null : Math.max(1, due - start);
  return {
    hasWindow: true,
    elapsed: span ? Math.max(0, Math.min(100, Math.round(((now - start) / span) * 100))) : null,
    daysLeft,
    overdue: daysLeft < 0 && m.status !== 'done',
  };
}

export const MS_STATUS_LABEL = {
  'in-progress': 'In progress', 'on-hold': 'On hold', done: 'Done', planned: 'Planned', unknown: '—',
};
