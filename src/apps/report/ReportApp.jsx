import { useState, useEffect, useMemo, useCallback } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getJiraProjects, getProjectComponents, searchIssuesPaged, getWorklogs } from '../../services/jira.js';

const LOGO     = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';
const CLOUD_ID = PROJECT_LIST.find(p => p.jira)?.jira.cloudId ?? '';

// Field ids verified against this Jira site (GET /rest/api/3/field):
//   customfield_10031 "Developer Estimate" (number) — what was planned
//   customfield_10057 "Dev Tracked"        (number) — what was actually tracked
const PLANNED_FIELD = 'customfield_10031';
const TRACKED_FIELD = 'customfield_10057';
const EPIC_LINK_FIELD = 'customfield_10014'; // legacy Epic Link (pre-parent hierarchy)

// Chart series colors — validated (dataviz six checks) on the app's dark
// surface #111113 and legal on light with direct labels + table relief.
const COLOR_PLANNED = '#1098AD';
const COLOR_TRACKED = '#9775FA';

const fmt = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};

// Status-category colors (reserved status palette, matching the table chips
// used elsewhere in the platform).
const STATUS_COLORS = { done: '#34d399', indeterminate: '#60a5fa', new: 'var(--text-3)' };

// ─── Searchable select (same look as Task Agent's project picker) ─────────────

function SearchSelect({ items, value, onChange, placeholder, searchPlaceholder = 'Search…', disabled = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query,  setQuery]  = useState('');

  const selected = items.find(i => i.value === value) ?? null;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(i => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q))
    : items;

  function select(v) {
    onChange(v);
    setIsOpen(false);
    setQuery('');
  }

  function close() { setIsOpen(false); setQuery(''); }

  return (
    <div className="project-picker">
      {!isOpen ? (
        <button
          type="button"
          className="project-picker-current"
          onClick={() => setIsOpen(true)}
          disabled={disabled}
          style={disabled ? { opacity: .5, cursor: 'not-allowed' } : undefined}
        >
          {selected
            ? <span>{selected.label}{selected.hint ? <span style={{ color: 'var(--text-3)' }}> ({selected.hint})</span> : null}</span>
            : <span style={{ color: 'var(--text-3)' }}>{placeholder}</span>}
          <span className="project-picker-chevron">▾</span>
        </button>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className="input"
              placeholder={searchPlaceholder}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') close();
                if (e.key === 'Enter' && filtered.length === 1) select(filtered[0].value);
              }}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={close} style={{ flexShrink: 0 }}>
              Cancel
            </button>
          </div>
          <ul className="project-picker-results">
            {filtered.length === 0 && (
              <li style={{ padding: '9px 14px', fontSize: 13, color: 'var(--text-3)' }}>Nothing found</li>
            )}
            {filtered.map(i => (
              <li key={i.value}>
                <button type="button" className="project-picker-result" onClick={() => select(i.value)}>
                  <span>{i.label}</span>
                  {i.hint && <span className="project-picker-key">{i.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Data loading ─────────────────────────────────────────────────────────────

// Monday 00:00 of the week the date falls into (local time).
function weekStartMs(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function loadReport(projectKey, componentName, { updatedFrom = '', updatedTo = '' } = {}) {
  const epicJql =
    `project = "${projectKey}" AND issuetype = Epic` +
    (componentName ? ` AND component = "${componentName.replace(/"/g, '\\"')}"` : '') +
    (updatedFrom ? ` AND updated >= "${updatedFrom}"` : '') +
    // "23:59" keeps the end date inclusive — a bare date in JQL means midnight.
    (updatedTo ? ` AND updated <= "${updatedTo} 23:59"` : '') +
    ' ORDER BY created ASC';

  const epicIssues = await searchIssuesPaged(CLOUD_ID, epicJql, [
    'summary', 'status', PLANNED_FIELD, TRACKED_FIELD,
  ]);
  if (!epicIssues.length) return { epics: [], weekly: [] };

  // Pull every child of every epic in chunked bulk queries (parent for new
  // hierarchy, Epic Link for old projects), then group client-side.
  const epicKeys = epicIssues.map(e => e.key);
  const children = [];
  for (let i = 0; i < epicKeys.length; i += 50) {
    const chunk = epicKeys.slice(i, i + 50);
    const list  = chunk.map(k => `"${k}"`).join(',');
    const jql   = `parent in (${list}) OR "Epic Link" in (${list})`;
    const issues = await searchIssuesPaged(CLOUD_ID, jql, [
      'summary', 'status', 'issuetype', 'parent', EPIC_LINK_FIELD, PLANNED_FIELD, TRACKED_FIELD, 'worklog',
    ]);
    children.push(...issues);
  }

  const byEpic = new Map(epicIssues.map(e => [e.key, {
    key:      e.key,
    summary:  e.fields?.summary ?? '',
    status:   e.fields?.status?.name ?? '',
    category: e.fields?.status?.statusCategory?.key ?? '',
    tasks:    0,
    planned:  0,
    tracked:  0,
  }]));

  // Worklogs give the tracked hours a date, powering the dynamics chart. The
  // search response inlines up to 20 worklogs per issue; fetch the full list
  // for the rare issue that has more.
  const worklogEntries = [];   // { ms: weekStart, hours }
  const incompleteKeys = [];

  for (const c of children) {
    const parentKey = c.fields?.parent?.key ?? c.fields?.[EPIC_LINK_FIELD] ?? null;
    const row = parentKey ? byEpic.get(parentKey) : null;
    if (row) {
      row.tasks += 1;
      const planned = Number(c.fields?.[PLANNED_FIELD]);
      const tracked = Number(c.fields?.[TRACKED_FIELD]);
      if (Number.isFinite(planned)) row.planned += planned;
      if (Number.isFinite(tracked)) row.tracked += tracked;
    }
    const wl = c.fields?.worklog;
    if (!wl) continue;
    if ((wl.total ?? 0) > (wl.worklogs?.length ?? 0)) {
      incompleteKeys.push(c.key);
    } else {
      for (const w of wl.worklogs ?? []) {
        const ms = weekStartMs(w.started);
        if (ms != null && w.timeSpentSeconds) worklogEntries.push({ ms, hours: w.timeSpentSeconds / 3600 });
      }
    }
  }

  for (let i = 0; i < incompleteKeys.length; i += 5) {
    const chunk = incompleteKeys.slice(i, i + 5);
    const lists = await Promise.all(chunk.map(k => getWorklogs(CLOUD_ID, k).catch(() => [])));
    for (const list of lists) {
      for (const w of list) {
        const ms = weekStartMs(w.started);
        if (ms != null && w.timeSpentSeconds) worklogEntries.push({ ms, hours: w.timeSpentSeconds / 3600 });
      }
    }
  }

  // Weekly buckets over a continuous range (gap weeks stay at 0 hours).
  const byWeek = new Map();
  for (const e of worklogEntries) byWeek.set(e.ms, (byWeek.get(e.ms) ?? 0) + e.hours);
  const weekly = [];
  if (byWeek.size) {
    const msList = [...byWeek.keys()].sort((a, b) => a - b);
    const WEEK = 7 * 24 * 3600 * 1000;
    for (let t = msList[0]; t <= msList[msList.length - 1]; t += WEEK) {
      weekly.push({ ms: t, hours: byWeek.get(t) ?? 0 });
    }
  }

  return { epics: [...byEpic.values()], weekly };
}

// ─── Chart: horizontal grouped bars, planned vs tracked per epic ──────────────

// Rounded data-end (right side only), anchored to the baseline on the left.
function barPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, Math.max(w, 0.01), h / 2);
  const body = Math.max(w - rr, 0);
  return `M${x},${y} h${body} a${rr},${rr} 0 0 1 ${rr},${rr} v${h - 2 * rr} a${rr},${rr} 0 0 1 -${rr},${rr} h-${body} z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const step  = Math.pow(10, Math.floor(Math.log10(max / count)));
  const cand  = [step, step * 2, step * 2.5, step * 5, step * 10];
  const pick  = cand.find(s => max / s <= count) ?? step * 10;
  // Extend the axis to the next full step so the longest bar (and its value
  // label) always stays inside the plot instead of being clipped by the edge.
  const top   = Math.ceil((max - 1e-9) / pick) * pick;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += pick) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

// Rows above this stop being readable as bars — the table below still has everything.
const CHART_MAX_ROWS = 30;

function truncate(text, max) {
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

// A value label sits inside the bar when it fits; tiny bars get it just outside.
function BarValueLabel({ barX, barW, y, value }) {
  const inside = barW >= 44;
  return (
    <text
      x={inside ? barX + barW - 6 : barX + barW + 5}
      y={y}
      textAnchor={inside ? 'end' : 'start'}
      fontSize="10"
      fontWeight="600"
      fill={inside ? 'var(--accent-ink, #0A0A0B)' : 'var(--text-2)'}
    >{fmt(value)}</text>
  );
}

function PlannedVsTrackedChart({ rows }) {
  const data = rows.filter(r => r.planned > 0 || r.tracked > 0).slice(0, CHART_MAX_ROWS);
  if (!data.length) return null;

  const PAD_L = 16, PAD_R = 56, PAD_T = 6, PAD_B = 24;
  const NAME_H = 17, BAR_H = 11, BAR_GAP = 3, GROUP_GAP = 15;
  const groupH = NAME_H + BAR_H * 2 + BAR_GAP + GROUP_GAP;
  const width  = 760;
  const plotW  = width - PAD_L - PAD_R;
  const height = PAD_T + data.length * groupH + PAD_B;

  const max     = Math.max(...data.map(r => Math.max(r.planned, r.tracked)));
  const ticks   = niceTicks(max);
  const tickMax = ticks[ticks.length - 1] || 1;
  const x = (v) => (v / tickMax) * plotW;

  return (
    <div className="rp-chart-scroll">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', minWidth: 560, height: 'auto', display: 'block' }}
        role="img"
        aria-label="Planned vs tracked hours per epic"
      >
        {/* grid */}
        {ticks.map(t => (
          <g key={t}>
            <line
              x1={PAD_L + x(t)} x2={PAD_L + x(t)}
              y1={PAD_T} y2={height - PAD_B}
              stroke="var(--border)" strokeWidth="1"
            />
            <text
              x={PAD_L + x(t)} y={height - 8}
              textAnchor="middle" fontSize="10" fill="var(--text-3)"
            >{fmt(t)}</text>
          </g>
        ))}

        {data.map((r, i) => {
          const y0    = PAD_T + i * groupH;
          const barY1 = y0 + NAME_H;
          const barY2 = barY1 + BAR_H + BAR_GAP;
          return (
            <g key={r.key} className="rp-bar-group">
              <title>{`${r.key} — ${r.summary}\nPlanned: ${fmt(r.planned)}h · Tracked: ${fmt(r.tracked)}h`}</title>
              {/* Epic key + name + status above its pair of bars */}
              <text x={PAD_L} y={y0 + 11} fontSize="11" fill="var(--text-1)">
                <tspan fontWeight="600">{r.key}</tspan>
                <tspan fill="var(--text-2)">{'  ' + truncate(r.summary, 74)}</tspan>
                <tspan
                  fontWeight="600"
                  fill={r.category === 'done' ? '#34d399' : r.category === 'indeterminate' ? '#60a5fa' : 'var(--text-3)'}
                >{'  · ' + (r.status || '—')}</tspan>
              </text>

              {r.planned > 0 && (
                <path className="rp-bar" d={barPath(PAD_L, barY1, x(r.planned), BAR_H)} fill={COLOR_PLANNED} />
              )}
              <BarValueLabel barX={PAD_L} barW={x(r.planned)} y={barY1 + BAR_H - 2.5} value={r.planned} />

              {r.tracked > 0 && (
                <path className="rp-bar" d={barPath(PAD_L, barY2, x(r.tracked), BAR_H)} fill={COLOR_TRACKED} />
              )}
              <BarValueLabel barX={PAD_L} barW={x(r.tracked)} y={barY2 + BAR_H - 2.5} value={r.tracked} />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ─── Dynamics: cumulative tracked hours per week vs the planned total ─────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtWeek = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };

function TrendChart({ weekly, plannedTotal }) {
  if (weekly.length < 2) return null;

  let acc = 0;
  const points = weekly.map(w => ({ ...w, cum: (acc += w.hours) }));

  const PAD_L = 44, PAD_R = 64, PAD_T = 12, PAD_B = 26;
  const width = 760, height = 230;
  const plotW = width - PAD_L - PAD_R;
  const plotH = height - PAD_T - PAD_B;

  const yMax    = Math.max(points[points.length - 1].cum, plannedTotal || 0);
  const ticks   = niceTicks(yMax);
  const tickMax = ticks[ticks.length - 1] || 1;
  const x = (i) => PAD_L + (points.length === 1 ? 0 : (i / (points.length - 1)) * plotW);
  const y = (v) => PAD_T + plotH - (v / tickMax) * plotH;

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`).join('');
  const xLabelEvery = Math.max(1, Math.ceil(points.length / 8));
  const last = points[points.length - 1];

  return (
    <div className="rp-chart-scroll">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', minWidth: 400, height: 'auto', display: 'block' }}
        role="img"
        aria-label="Cumulative tracked hours per week against the planned total"
      >
        {/* horizontal grid + y labels */}
        {ticks.map(t => (
          <g key={t}>
            <line x1={PAD_L} x2={PAD_L + plotW} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD_L - 7} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-3)">{fmt(t)}</text>
          </g>
        ))}

        {/* planned total reference */}
        {plannedTotal > 0 && (
          <g>
            <line
              x1={PAD_L} x2={PAD_L + plotW} y1={y(plannedTotal)} y2={y(plannedTotal)}
              stroke={COLOR_PLANNED} strokeWidth="1.5" strokeDasharray="5 4"
            />
            <text x={PAD_L + plotW + 6} y={y(plannedTotal) + 3} fontSize="10" fontWeight="600" fill={COLOR_PLANNED}>
              plan {fmt(plannedTotal)}
            </text>
          </g>
        )}

        {/* cumulative tracked line */}
        <path d={line} fill="none" stroke={COLOR_TRACKED} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {points.map((p, i) => (
          <circle key={p.ms} cx={x(i)} cy={y(p.cum)} r="3" fill={COLOR_TRACKED}>
            <title>{`Week of ${fmtWeek(p.ms)}\n+${fmt(p.hours)}h this week · ${fmt(p.cum)}h total`}</title>
          </circle>
        ))}
        <text x={x(points.length - 1) + 7} y={y(last.cum) + 3} fontSize="10" fontWeight="600" fill="var(--text-1)">
          {fmt(last.cum)}h
        </text>

        {/* x labels */}
        {points.map((p, i) => (i % xLabelEvery === 0
          ? <text key={p.ms} x={x(i)} y={height - 8} textAnchor="middle" fontSize="10" fill="var(--text-3)">{fmtWeek(p.ms)}</text>
          : null))}
      </svg>
    </div>
  );
}

// ─── Component progress: how many epics are already Done ──────────────────────

function ProgressDonut({ done, total }) {
  const R = 54, C = 2 * Math.PI * R;
  const pct = total ? done / total : 0;
  return (
    <svg viewBox="0 0 150 150" width="170" height="170" role="img" aria-label={`${done} of ${total} epics done`}>
      <circle cx="75" cy="75" r={R} fill="none" stroke="var(--border)" strokeWidth="15" />
      {pct > 0 && (
        <circle
          cx="75" cy="75" r={R} fill="none"
          stroke={STATUS_COLORS.done} strokeWidth="15"
          strokeDasharray={`${C * pct} ${C}`}
          strokeLinecap={pct < 1 ? 'round' : 'butt'}
          transform="rotate(-90 75 75)"
        />
      )}
      <text x="75" y="70" textAnchor="middle" fontSize="26" fontWeight="700" fill="var(--text-1)">
        {Math.round(pct * 100)}%
      </text>
      <text x="75" y="92" textAnchor="middle" fontSize="12" fill="var(--text-3)">
        {done} of {total}
      </text>
    </svg>
  );
}

function ProgressCard({ rows }) {
  const total = rows.length;
  const counts = { done: 0, indeterminate: 0, new: 0 };
  for (const r of rows) counts[r.category === 'done' || r.category === 'indeterminate' ? r.category : 'new']++;
  return (
    <div className="rp-progress">
      <ProgressDonut done={counts.done} total={total} />
      <div className="rp-progress-legend">
        <div className="rp-progress-row">
          <span className="rp-dot" style={{ background: STATUS_COLORS.done }} />
          <span>Done</span>
          <span className="rp-progress-num">{counts.done}</span>
        </div>
        <div className="rp-progress-row">
          <span className="rp-dot" style={{ background: STATUS_COLORS.indeterminate }} />
          <span>In progress</span>
          <span className="rp-progress-num">{counts.indeterminate}</span>
        </div>
        <div className="rp-progress-row">
          <span className="rp-dot" style={{ background: 'var(--text-3)' }} />
          <span>To do</span>
          <span className="rp-progress-num">{counts.new}</span>
        </div>
        <div className="rp-progress-row rp-progress-total">
          <span className="rp-dot" style={{ background: 'transparent' }} />
          <span>All epics</span>
          <span className="rp-progress-num">{total}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ReportApp({ user, onLogout }) {
  const [projects,   setProjects]   = useState([]);
  const [projectKey, setProjectKey] = useState('');
  const [components, setComponents] = useState([]);
  const [component,  setComponent]  = useState('');
  const [rows,       setRows]       = useState(null); // null = not loaded yet
  const [weekly,     setWeekly]     = useState([]);
  const [updatedFrom, setUpdatedFrom] = useState('');
  const [updatedTo,   setUpdatedTo]   = useState('');
  const [sortBy,      setSortBy]      = useState('planned'); // 'planned' | 'status'
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');

  useEffect(() => {
    if (!CLOUD_ID) return;
    getJiraProjects(CLOUD_ID).then(setProjects).catch(() => {});
  }, []);

  useEffect(() => {
    setComponents([]);
    setComponent('');
    setRows(null);
    setError('');
    if (!projectKey) return;
    getProjectComponents(CLOUD_ID, projectKey).then(setComponents).catch(() => {});
  }, [projectKey]);

  const load = useCallback(async () => {
    if (!projectKey || loading) return;
    setLoading(true);
    setError('');
    try {
      const { epics, weekly: weeklyData } = await loadReport(projectKey, component || null, { updatedFrom, updatedTo });
      // Biggest plans first — keeps the chart and the table scannable.
      epics.sort((a, b) => (b.planned - a.planned) || (b.tracked - a.tracked));
      setRows(epics);
      setWeekly(weeklyData);
    } catch (e) {
      setError(e.message || 'Failed to load report.');
      setRows(null);
      setWeekly([]);
    } finally {
      setLoading(false);
    }
  }, [projectKey, component, updatedFrom, updatedTo, loading]);

  // Chart order: by planned hours, or grouped by status — active categories
  // first (in progress → to do → done), identical status names kept together,
  // by planned inside each status group.
  const displayRows = useMemo(() => {
    if (!rows) return null;
    if (sortBy !== 'status') return rows;
    const order = { indeterminate: 0, new: 1, done: 2 };
    return [...rows].sort((a, b) =>
      (order[a.category] ?? 1) - (order[b.category] ?? 1) ||
      (a.status || '').localeCompare(b.status || '') ||
      (b.planned - a.planned) || (b.tracked - a.tracked));
  }, [rows, sortBy]);

  const totals = useMemo(() => {
    if (!rows) return null;
    const planned = rows.reduce((s, r) => s + r.planned, 0);
    const tracked = rows.reduce((s, r) => s + r.tracked, 0);
    return {
      planned,
      tracked,
      delta: tracked - planned,
      pct:   planned > 0 ? (tracked / planned) * 100 : null,
    };
  }, [rows]);

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-logo"><img src={LOGO} alt="Dynamica Labs" /></div>
        <div className="header-sep" />
        <span className="header-title">Report</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className="rp-main">
        {/* Sticky header: filters + summary tiles */}
        <div className="rp-sticky">
        <div className="rp-controls">
          <div className="rp-control">
            <label className="field-label">Jira Project</label>
            <SearchSelect
              items={projects.map(p => ({ value: p.key, label: p.name, hint: p.key }))}
              value={projectKey}
              onChange={setProjectKey}
              placeholder="— Select project —"
              searchPlaceholder="Search projects…"
            />
          </div>
          <div className="rp-control">
            <label className="field-label">Component</label>
            <SearchSelect
              items={[
                { value: '', label: 'All components' },
                ...components.map(c => ({ value: c.name, label: c.name })),
              ]}
              value={component}
              onChange={setComponent}
              placeholder="All components"
              searchPlaceholder="Search components…"
              disabled={!projectKey || !components.length}
            />
          </div>
          <div className="rp-control rp-control-date">
            <label className="field-label">Epic updated from</label>
            <input
              type="date"
              className="input"
              value={updatedFrom}
              max={updatedTo || undefined}
              onChange={e => setUpdatedFrom(e.target.value)}
            />
          </div>
          <div className="rp-control rp-control-date">
            <label className="field-label">Updated to</label>
            <input
              type="date"
              className="input"
              value={updatedTo}
              min={updatedFrom || undefined}
              onChange={e => setUpdatedTo(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            style={{
              alignSelf: 'flex-end',
              padding: '10px 16px',
              ...(!updatedFrom && !updatedTo ? { borderColor: 'var(--accent-1)', color: 'var(--accent-1)' } : {}),
            }}
            title="Show all epics regardless of update date"
            onClick={() => { setUpdatedFrom(''); setUpdatedTo(''); }}
          >
            All
          </button>
          <button
            className="btn btn-primary"
            style={{ width: 'auto', padding: '10px 22px', alignSelf: 'flex-end' }}
            onClick={load}
            disabled={!projectKey || loading}
          >
            {loading ? <span className="spinner" style={{ width: 15, height: 15 }} /> : 'Build Report'}
          </button>
        </div>

        {rows && rows.length > 0 && totals && (
          <div className="rp-tiles">
            <div className="rp-tile">
              <span className="rp-tile-num">{rows.length}</span>
              <span className="rp-tile-label">epics</span>
            </div>
            <div className="rp-tile">
              <span className="rp-tile-num">{fmt(totals.planned)}h</span>
              <span className="rp-tile-label">
                <span className="rp-dot" style={{ background: COLOR_PLANNED }} />
                planned (Developer Estimate)
              </span>
            </div>
            <div className="rp-tile">
              <span className="rp-tile-num">{fmt(totals.tracked)}h</span>
              <span className="rp-tile-label">
                <span className="rp-dot" style={{ background: COLOR_TRACKED }} />
                tracked (Dev Tracked)
              </span>
            </div>
            <div className="rp-tile">
              <span className="rp-tile-num" style={{ color: totals.delta > 0 ? '#fbbf24' : 'var(--text-1)' }}>
                {totals.delta > 0 ? '+' : ''}{fmt(totals.delta)}h
              </span>
              <span className="rp-tile-label">
                difference{totals.pct != null ? ` · ${Math.round(totals.pct)}% of plan used` : ''}
              </span>
            </div>
          </div>
        )}
        </div>

        {error && <p className="error-msg" style={{ marginTop: 12 }}>⚠ {error}</p>}

        {rows && !rows.length && (
          <p className="rp-empty">No epics found for this selection.</p>
        )}

        {rows && rows.length > 0 && totals && (
          <>
            {/* Two-column layout: per-epic bars left, dynamics + progress right */}
            <div className="rp-columns">
              <div className="rp-card">
                <div className="rp-card-head">
                  <span className="rp-card-title">
                    Planned vs tracked per epic (hours)
                    {rows.filter(r => r.planned > 0 || r.tracked > 0).length > 30 ? ' — top 30' : ''}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                    <select
                      className="select"
                      style={{ width: 'auto', padding: '4px 28px 4px 10px', fontSize: 12, height: 'auto' }}
                      value={sortBy}
                      onChange={e => setSortBy(e.target.value)}
                      title="Chart sort order"
                    >
                      <option value="planned">Sort: by planned</option>
                      <option value="status">Sort: by status</option>
                    </select>
                    <span className="rp-legend">
                      <span className="rp-dot" style={{ background: COLOR_PLANNED }} /> Planned
                      <span className="rp-dot" style={{ background: COLOR_TRACKED, marginLeft: 14 }} /> Tracked
                    </span>
                  </span>
                </div>
                <PlannedVsTrackedChart rows={displayRows} />
              </div>

              <div className="rp-column">
                {weekly.length >= 2 && (
                  <div className="rp-card" style={{ marginTop: 0 }}>
                    <div className="rp-card-head">
                      <span className="rp-card-title">Tracked hours over time (weekly)</span>
                      <span className="rp-legend">
                        <span className="rp-dot" style={{ background: COLOR_TRACKED }} /> Tracked (cumulative)
                        <span className="rp-dash" style={{ borderColor: COLOR_PLANNED, marginLeft: 14 }} /> Planned total
                      </span>
                    </div>
                    <TrendChart weekly={weekly} plannedTotal={totals.planned} />
                  </div>
                )}

                <div className="rp-card">
                  <div className="rp-card-head">
                    <span className="rp-card-title">
                      {component ? `Progress — ${component}` : 'Progress — all components'} (epics done)
                    </span>
                  </div>
                  <ProgressCard rows={rows} />
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
