import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getAreaPaths } from '../../services/azureDevops.js';
import { loadProjectSnapshot, getCachedSnapshot, CANCELLED } from './loadSnapshot.js';
import {
  buildReport, buildTrend, PROGRESS_BINS, DONE, PROGRESS, TODO, fmtDate,
} from './metrics.js';
import { ChartCard, Stacked100, HBars, Columns, TrendChart, Meter, BUCKET_VAR } from './charts.jsx';
import { useSlidingPill } from '../../platform/useSlidingPill.js';
import { fetchPmBrain } from './pmBrainData.js';
import RisksView from './RisksView.jsx';
import MilestonesView from './MilestonesView.jsx';

// ─── Health (Project Status) ──────────────────────────────────────────────────
// Read-only health report over ONE Azure board: pick project + board → load its
// work items, resolve each one's Jira request and pull the whole descendant tree
// (epics → tasks), roll that up into a per-item completion percentage and chart
// the result. Status edits live in PM › Status and PM › Azure-Jira.
//
// The board is the LOAD SCOPE (one WIQL scoped by Area Path), not a client-side
// filter: a single ABS board is ~2–4 s against ~15 s for the whole project.

const ALL_BOARDS = '__all__';

// Three views over one project. Overview is the Azure+Jira delivery report;
// Risks and Milestones read the PM Brain Obsidian vault through
// `/api/pm-brain/:project` and work with no snapshot loaded at all.
const TABS = [
  { id: 'overview',   name: 'Overview' },
  { id: 'risks',      name: 'Risks' },
  { id: 'milestones', name: 'Milestones' },
];

// Completion filter over the loaded board. There is deliberately no "period"
// (changed-date) control: a health report needs the closed work to compute
// progress at all, and a date window silently hides work closed before it —
// "% done" would then mean "% done in the window", which reads as a bug.
const STATUSES = [
  { id: 'all',  label: 'All statuses' },
  { id: 'done', label: 'Done / Closed' },
  { id: 'open', label: 'Open (not closed)' },
];

const HEAD = {
  overview: {
    title: 'Health — board status',
    sub: 'Pick a project and an Azure DevOps board: the report pulls every linked Jira '
       + 'request with all of its epics and tasks, rolls that up into a completion '
       + 'percentage per work item and charts the result.',
  },
  risks: {
    title: 'Health — risks',
    sub: 'The project’s risk register from the PM Brain vault: the scored RBS table '
       + '(probability × impact per milestone), the canonical risk graph with its dated '
       + 'retrospective and call links, and everything currently blocking work. Read-only — '
       + 'edit in Obsidian.',
  },
  milestones: {
    title: 'Health — milestones',
    sub: 'Milestones from the PM Brain vault: window and epics from Timeline, acceptance '
       + 'criteria, open TO DO items, blockers and risks — plus delivery progress from the '
       + 'Azure board each milestone is matched to.',
  },
};

const PHASE_LABEL = {
  azure:    'Azure: board work items',
  link:     'Jira: matching Azure ids → keys',
  requests: 'Jira: request statuses',
  trees:    'Jira: epics and tasks',
  done:     'Done',
};

function progressText(p) {
  if (!p) return '';
  const base = PHASE_LABEL[p.phase] ?? p.phase;
  if (p.phase === 'azure' && p.ids)      return `${base} — ${p.fetched || 0} / ${p.ids}`;
  if (p.phase === 'link' && p.items)     return `${base} — ${p.items} items`;
  if (p.phase === 'requests' && p.keys)  return `${base} — ${p.keys} keys`;
  if (p.phase === 'trees' && p.depth)    return `${base} — level ${p.depth}, ${p.nodes} issues`;
  if (p.phase === 'trees' && p.requests) return `${base} — ${p.requests} requests`;
  return base;
}

const fmtDays = d => (d === null ? '—' : d === 0 ? 'today' : `${d} d`);

// ─── Pieces ───────────────────────────────────────────────────────────────────

function Kpi({ n, label, tone, hero }) {
  return (
    <div className={`ps-kpi${hero ? ' ps-kpi-hero' : ''}`}>
      <span className="ps-kpi-n" style={tone ? { color: BUCKET_VAR[tone] } : undefined}>{n}</span>
      <span className="ps-kpi-l">{label}</span>
    </div>
  );
}

function StatusChip({ bucket, children, title }) {
  if (!children) return <span className="ps-dash">—</span>;
  return (
    <span className={`ps-chip ps-chip-${bucket || 'todo'}`} title={title}>{children}</span>
  );
}

function EpicRow({ epic }) {
  return (
    <div className="ps-epic">
      <a className="ps-epic-key" href={epic.url} target="_blank" rel="noreferrer">{epic.key}</a>
      <span className="ps-epic-sum" title={epic.summary}>{epic.summary}</span>
      <StatusChip bucket={epic.bucket}>{epic.status}</StatusChip>
      <span className="ps-epic-tasks">
        {epic.tasks.total
          ? `${epic.tasks[DONE]}/${epic.tasks.total} tasks`
          : 'no tasks'}
      </span>
      <span className="ps-epic-meter">
        <Meter value={epic.pct} tone={epic.pct === 100 ? DONE : epic.pct > 0 ? PROGRESS : TODO} />
      </span>
      <span className="ps-epic-pct">{epic.pct}%</span>
    </div>
  );
}

const BASIS_HINT = {
  epics:  'from the request\u2019s epics (each epic from its own tasks)',
  tasks:  'from the request\u2019s tasks (it has no epics)',
  status: 'from the request\u2019s own status (it has no children)',
};

function ItemRow({ item, open, onToggle }) {
  const hasTree = item.epicRows.length > 0;
  return (
    <>
      <tr className={`ps-row${open ? ' open' : ''}`}>
        <td className="ps-td-exp">
          {hasTree ? (
            <button type="button" className="ps-exp" onClick={onToggle} aria-expanded={open}
              title={open ? 'Collapse epics' : 'Show epics'}>
              {open ? '−' : '+'}
            </button>
          ) : <span className="ps-exp-empty" />}
        </td>
        <td className="ps-td-az">
          <a href={item.url} target="_blank" rel="noreferrer" className="ps-az-id">#{item.id}</a>
          <span className="ps-az-type">{item.type}</span>
        </td>
        <td className="ps-td-title">
          <span className="ps-title-text" title={item.title}>{item.title}</span>
          {item.assignedTo && <span className="ps-who">{item.assignedTo}</span>}
        </td>
        <td className="ps-td-state">
          <StatusChip bucket={item.azBucket} title={`Azure: ${item.state}`}>{item.state}</StatusChip>
        </td>
        <td className="ps-td-jira">
          {item.jiraKey ? (
            <>
              <a href={item.jiraUrl} target="_blank" rel="noreferrer" className="ps-jira-key">{item.jiraKey}</a>
              <StatusChip bucket={item.jiraBucket} title={`Jira: ${item.jiraStatus}`}>{item.jiraStatus}</StatusChip>
            </>
          ) : <span className="ps-chip ps-chip-warn" title="Azure item with no Jira link">no link</span>}
        </td>
        <td className="ps-td-n">
          {item.epics.total ? `${item.epics[DONE]}/${item.epics.total}` : <span className="ps-dash">—</span>}
        </td>
        <td className="ps-td-n">
          {item.tasks.total ? `${item.tasks[DONE]}/${item.tasks.total}` : <span className="ps-dash">—</span>}
        </td>
        <td className="ps-td-prog">
          {item.pct === null ? <span className="ps-dash">—</span> : (
            <span className="ps-prog-cell" title={BASIS_HINT[item.basis]}>
              <Meter value={item.pct} tone={item.pct === 100 ? DONE : item.pct > 0 ? PROGRESS : TODO} />
              <b>{item.pct}%</b>
            </span>
          )}
        </td>
        <td className="ps-td-act">{fmtDays(item.staleDays)}</td>
      </tr>
      {open && (
        <tr className="ps-row-epics">
          <td />
          <td colSpan={8}>
            <div className="ps-epics">
              {item.epicRows.map(e => <EpicRow key={e.key} epic={e} />)}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

const SORTS = {
  pct:   { get: i => (i.pct === null ? -1 : i.pct) },
  id:    { get: i => i.id },
  open:  { get: i => i.tasks.total - i.tasks[DONE] },
  stale: { get: i => i.staleDays ?? -1 },
};

function RiskBlock({ title, count, children, hint }) {
  if (!count) return null;
  return (
    <details className="ps-risk">
      <summary>
        <span className="ps-risk-n">{count}</span>
        <span className="ps-risk-t">{title}</span>
        {hint && <span className="ps-risk-hint">{hint}</span>}
      </summary>
      <div className="ps-risk-body">{children}</div>
    </details>
  );
}

// Segmented view switcher — the platform's sliding liquid-glass pill (same
// primitive as the PM workspace switcher and the sidebar nav).
function Tabs({ tab, onPick }) {
  const { trackRef, setItemRef, box, ready, seq } = useSlidingPill(tab);
  return (
    <div className="ps-tabs glass-panel" role="tablist" aria-label="Health views" ref={trackRef}>
      <span className="glass-refract" aria-hidden="true" />
      <span
        className={`ps-tabs-pill${ready ? ' ready' : ''}`}
        aria-hidden="true"
        style={{ transform: `translateX(${box.left}px)`, width: box.width }}
      >
        <span key={seq} className={`glass-pill-fill${seq > 0 ? ' gel' : ''}`} />
      </span>
      {TABS.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === tab}
          ref={setItemRef(t.id)}
          className={`ps-tab${t.id === tab ? ' active' : ''}`}
          onClick={() => onPick(t.id)}
        >
          {t.name}
        </button>
      ))}
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function ProjectStatusApp({ allowedProjects }) {
  const projects = useMemo(() => (
    allowedProjects?.length
      ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
      : PROJECT_LIST
  ), [allowedProjects]);

  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [boards,        setBoards]        = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [board,     setBoard]     = useState(ALL_BOARDS);
  const [status,    setStatus]    = useState('all');
  const [loading,   setLoading]   = useState(false);
  const [progress,  setProgress]  = useState(null);
  const [error,     setError]     = useState('');
  const [snapshot,  setSnapshot]  = useState(null);

  // view state
  const [bin,        setBin]        = useState(null);   // progress-bin id
  const [stateFilter, setStateFilter] = useState(null); // Azure System.State
  const [search,     setSearch]     = useState('');
  const [sortKey,    setSortKey]    = useState('pct');
  const [sortDir,    setSortDir]    = useState('asc');
  const [expanded,   setExpanded]   = useState(() => new Set());

  // PM Brain (vault) state — independent of the Azure snapshot on purpose: the
  // Risks / Milestones tabs must open without a 15 s board load first.
  const [tab,          setTab]          = useState('overview');
  const [brain,        setBrain]        = useState(null);
  const [brainLoading, setBrainLoading] = useState(false);
  const [brainError,   setBrainError]   = useState('');
  const [focusMs,      setFocusMs]      = useState(null);

  const loadSeq = useRef(0);
  const brainSeq = useRef(0);
  const proj = projects.find(p => p.id === projectId) ?? null;
  const changedSince = null;      // see STATUSES — the whole history is loaded
  const areaPath = board === ALL_BOARDS ? null : board;

  // ── Boards (Area Paths) of the selected project ───────────────────────────
  // Deliberately NOT filtered by `boardAllowList`: on ABS the dotted Area Paths
  // ("ABS. WS. Customer Service") are absent from that list and hold ~39% of the
  // project, so filtering by it would hide a third of the work from the report.
  useEffect(() => {
    setBoards([]);
    setBoard(ALL_BOARDS);
    if (!proj) return;
    let cancelled = false;
    setBoardsLoading(true);
    getAreaPaths(proj.azure.proxyKey, proj.azure.project)
      .then(all => {
        if (cancelled) return;
        // Drop the project root (it IS the "whole project" option) and sort by
        // the path so children sit under their parent.
        setBoards(all.filter(b => b.path.includes('\\')).sort((a, b) => a.path.localeCompare(b.path)));
      })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setBoardsLoading(false));
    return () => { cancelled = true; };
  }, [proj]);

  // Switching board (or coming back to the app) shows the cached snapshot
  // instantly instead of replaying the load; “Refresh” refetches.
  useEffect(() => {
    loadSeq.current++;               // invalidate any in-flight load
    setLoading(false);
    setProgress(null);
    setError('');
    setBin(null); setStateFilter(null); setSearch(''); setStatus('all'); setExpanded(new Set());
    setSnapshot(proj ? getCachedSnapshot(proj.id, areaPath, changedSince) : null);
  }, [proj, areaPath, changedSince]);

  const loadBrain = useCallback(async (force = false) => {
    if (!proj) return;
    if (brain?.project === proj.id && !force) return;
    const seq = ++brainSeq.current;
    setBrainLoading(true);
    setBrainError('');
    try {
      const data = await fetchPmBrain(proj.id);
      if (seq !== brainSeq.current) return;
      if (data?.available === false) { setBrain(null); setBrainError(data.reason || 'PM Brain is not available.'); }
      else setBrain(data);
    } catch (e) {
      if (seq === brainSeq.current) { setBrain(null); setBrainError(e?.message || 'PM Brain request failed.'); }
    } finally {
      if (seq === brainSeq.current) setBrainLoading(false);
    }
  }, [proj, brain?.project]);

  // The vault is only fetched when a vault tab is actually opened (and once per
  // project) — Overview must not pay for it.
  useEffect(() => {
    if (tab !== 'overview') loadBrain(false);
  }, [tab, projectId]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { brainSeq.current++; setBrain(null); setBrainError(''); }, [projectId]);

  const load = useCallback(async () => {
    if (!proj) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    setProgress(null);
    setSnapshot(null);
    setBin(null); setStateFilter(null); setExpanded(new Set());
    try {
      const snap = await loadProjectSnapshot(proj, {
        areaPath,
        changedSince,
        force:        true,
        onProgress:   p => { if (seq === loadSeq.current) setProgress(p); },
        isCancelled:  () => seq !== loadSeq.current,
      });
      if (seq === loadSeq.current) setSnapshot(snap);
    } catch (e) {
      if (e === CANCELLED) return;
      if (seq === loadSeq.current) setError(e?.message || 'Could not load the data.');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [proj, areaPath, changedSince]);

  const report = useMemo(() => (snapshot ? buildReport(snapshot) : null), [snapshot]);
  const trend  = useMemo(() => (snapshot ? buildTrend(snapshot, 16) : null), [snapshot]);

  // The table's slice. Charts stay on the whole board on purpose — a chart that
  // repaints itself from its own filter can no longer be read as a distribution.
  const rows = useMemo(() => {
    if (!report) return [];
    const q = search.trim().toLowerCase();
    const binDef = bin ? PROGRESS_BINS.find(b => b.id === bin) : null;
    let out = report.items.filter(i => {
      if (binDef && !(i.pct !== null && binDef.test(i.pct))) return false;
      if (stateFilter && i.state !== stateFilter) return false;
      // "Done / Closed" = closed on the Azure side OR fully done in Jira; an item
      // closed in only one of the two systems still counts as done here and shows
      // up under "Azure and Jira disagree".
      if (status === 'done' && !(i.azBucket === DONE || i.pct === 100)) return false;
      if (status === 'open' && (i.azBucket === DONE || i.pct === 100)) return false;
      if (q) {
        const hay = `${i.id} ${i.title} ${i.jiraKey} ${i.assignedTo ?? ''} ${i.state}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    // Items with no computable progress (no Jira link) always sink to the bottom:
    // sorted ascending they would otherwise fill the first screen with rows that
    // carry no progress at all.
    const { get } = SORTS[sortKey];
    const dir = sortDir === 'asc' ? 1 : -1;
    out = [...out].sort((x, y) => {
      const xn = x.pct === null, yn = y.pct === null;
      if (xn !== yn) return xn ? 1 : -1;
      return dir * (get(x) - get(y) || x.id - y.id);
    });
    return out;
  }, [report, search, bin, stateFilter, status, sortKey, sortDir]);

  // Recomputed over the filtered rows so the header can quote the slice’s own
  // slice's own completion next to the board's.
  const sliceAvg = useMemo(() => {
    const scored = rows.filter(i => i.pct !== null);
    return scored.length ? Math.round(scored.reduce((s, i) => s + i.pct, 0) / scored.length) : null;
  }, [rows]);

  const isFiltering = !!(bin || stateFilter || search.trim() || status !== 'all');
  const clearFilters = () => { setBin(null); setStateFilter(null); setSearch(''); setStatus('all'); };

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'pct' ? 'asc' : 'desc'); }
  };
  const sortMark = key => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const toggleRow = id => setExpanded(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const isOverview = tab === 'overview';
  const kpi = report?.kpi;
  const charts = report?.charts;
  const boardLabel = board === ALL_BOARDS ? 'whole project' : boards.find(b => b.path === board)?.name || board;

  return (
    <div className="ps-wrap">
      <div className="ps-head">
        <h2 className="ps-title">{HEAD[tab].title}</h2>
        <p className="ps-sub">{HEAD[tab].sub}</p>
      </div>

      <Tabs tab={tab} onPick={setTab} />

      <div className="ps-bar">
        <label className="ps-field">
          <span className="ps-field-label">Project</span>
          <select className="select" value={projectId} disabled={loading}
            onChange={e => setProjectId(e.target.value)}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>

        {isOverview && <label className="ps-field ps-field-board">
          <span className="ps-field-label">Board (Area Path)</span>
          <select className="select" value={board} disabled={loading || boardsLoading}
            onChange={e => setBoard(e.target.value)}>
            <option value={ALL_BOARDS}>
              {boardsLoading ? 'Loading boards…' : `Whole project${boards.length ? ` (${boards.length} boards)` : ''}`}
            </option>
            {boards.map(b => (
              <option key={b.path} value={b.path}>
                {' '.repeat(Math.max(0, b.path.split('\\').length - 2) * 3)}{b.name}
              </option>
            ))}
          </select>
        </label>}

        {isOverview && <label className="ps-field">
          <span className="ps-field-label">Status</span>
          <select className="select" value={status} disabled={loading}
            onChange={e => setStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>}

        {isOverview ? (
          <button type="button" className="btn btn-primary ps-load-btn" onClick={load} disabled={loading || !proj}>
            {loading ? <span className="spinner" /> : snapshot ? 'Refresh' : 'Load'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary ps-load-btn" onClick={() => loadBrain(true)} disabled={brainLoading || !proj}>
            {brainLoading ? <span className="spinner" /> : 'Reload vault'}
          </button>
        )}

        {isOverview && snapshot && !loading && (
          <span className="ps-loaded-at">
            {boardLabel} · loaded at{' '}
            {new Date(snapshot.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {!isOverview && brain && !brainLoading && (
          <span className="ps-loaded-at">
            PM Brain · {brain.vaultProject} · {brain.source === 'fs' ? 'local vault' : 'git mirror'} ·{' '}
            {new Date(brain.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {isOverview && loading && (
        <p className="ps-progress"><span className="spinner" /> {progressText(progress) || 'Loading…'}</p>
      )}
      {isOverview && error && <p className="ps-err">⚠ {error}</p>}

      {!isOverview && brainLoading && (
        <p className="ps-progress"><span className="spinner" /> Reading the PM Brain vault…</p>
      )}
      {!isOverview && brainError && (
        <div className="ps-notice"><b>PM Brain is not available.</b> {brainError}</div>
      )}

      {tab === 'risks' && brain && !brainLoading && (
        <RisksView brain={brain} onOpenMilestone={name => { setFocusMs(name); setTab('milestones'); }} />
      )}

      {tab === 'milestones' && brain && !brainLoading && (
        <MilestonesView
          brain={brain}
          projectId={projectId}
          items={report?.items ?? []}
          areaPaths={snapshot?.areaPaths ?? []}
          boardScoped={!!snapshot?.areaPath}
          focus={focusMs}
          onFocusHandled={() => setFocusMs(null)}
        />
      )}

      {isOverview && report && !loading && (
        <div className="ps-report">
          {/* ── KPI row ─────────────────────────────────────────────────────── */}
          <div className="ps-kpis">
            <div className="ps-kpi ps-kpi-hero">
              <span className="ps-kpi-n">{kpi.avgPct}%</span>
              <span className="ps-kpi-l">average board progress<br />across {kpi.scored} work items</span>
              <Meter value={kpi.avgPct} height={7} />
            </div>
            <Kpi n={kpi.items}      label="Azure work items" />
            <Kpi n={kpi.itemsDone}  label="complete (100%)" tone={DONE} />
            <Kpi n={kpi.itemsWip}   label="in progress" tone={PROGRESS} />
            <Kpi n={kpi.itemsIdle}  label="not started" tone={TODO} />
            <Kpi n={`${kpi.epicsDone}/${kpi.epicsTotal}`} label={`epics closed (${kpi.epicsPct}%)`} />
            <Kpi n={`${kpi.tasksDone}/${kpi.tasksTotal}`} label={`tasks closed (${kpi.tasksPct}%)`} />
            <Kpi n={kpi.stale}      label="no movement > 30 days" />
          </div>

          {/* ── Charts ──────────────────────────────────────────────────────── */}
          <div className="ps-grid">
            <ChartCard
              title="Progress per Azure work item"
              hint="click a column to filter the table"
              note="An item’s progress is the average progress of its Jira request’s epics; an epic’s progress is the share of its closed tasks (a task in progress counts as a half)."
            >
              <Columns rows={charts.progressBins} onPick={setBin} activeId={bin} />
            </ChartCard>

            <ChartCard title="State of the work" hint="share of the three states">
              <div className="ps-splits">
                <div className="ps-split">
                  <span className="ps-split-l">Azure work items ({kpi.scored})</span>
                  <Stacked100 segments={charts.itemSplit} />
                </div>
                <div className="ps-split">
                  <span className="ps-split-l">Epics ({kpi.epicsTotal})</span>
                  <Stacked100 segments={charts.epicSplit} />
                </div>
                <div className="ps-split">
                  <span className="ps-split-l">Tasks ({kpi.tasksTotal})</span>
                  <Stacked100 segments={charts.taskSplit} />
                </div>
              </div>
            </ChartCard>

            <ChartCard title="Created and closed per week" hint="last 16 weeks" wide>
              <TrendChart
                points={trend.points}
                xLabel={fmtDate}
                series={[
                  { key: 'created',  label: 'created', color: 'var(--ps-cat-1)' },
                  { key: 'resolved', label: 'closed',  color: 'var(--ps-cat-2)' },
                ]}
              />
            </ChartCard>

            <ChartCard
              title="Open tasks per week"
              hint="cumulative"
              note={trend.backlogBefore ? `Open tasks at the start of the window: ${trend.backlogBefore}.` : null}
              wide
            >
              <TrendChart
                points={trend.points}
                xLabel={fmtDate}
                series={[{ key: 'open', label: 'open', color: 'var(--ps-seq)', fill: true }]}
              />
            </ChartCard>

            <ChartCard title="Azure states" hint="click a row to filter the table">
              <HBars rows={charts.azureStates} onPick={setStateFilter} activeLabel={stateFilter} />
            </ChartCard>

            <ChartCard title="Jira statuses of open epics">
              <HBars rows={charts.openJiraStatuses} unit="epics" />
            </ChartCard>

            <ChartCard title="Unfinished items per assignee" hint="Azure Assigned To">
              <HBars rows={charts.assignees} />
            </ChartCard>

            <ChartCard title="Age of open epics" hint="time in the current status">
              <HBars rows={charts.aging} unit="epics" />
            </ChartCard>
          </div>

          {/* ── Risks ───────────────────────────────────────────────────────── */}
          <ChartCard title="Data quality and risks" wide>
            <div className="ps-risks">
              <RiskBlock
                title="Azure items with no Jira link"
                count={report.risks.unlinked.length}
                hint="progress cannot be computed for them"
              >
                {report.risks.unlinked.slice(0, 40).map(i => (
                  <a key={i.id} className="ps-risk-link" href={i.url} target="_blank" rel="noreferrer">
                    #{i.id} {i.title}
                  </a>
                ))}
              </RiskBlock>

              <RiskBlock title="Requests with no children" count={report.risks.noChildren.length}
                hint="progress falls back to the request’s own status">
                {report.risks.noChildren.slice(0, 40).map(i => (
                  <a key={i.id} className="ps-risk-link" href={i.jiraUrl} target="_blank" rel="noreferrer">
                    {i.jiraKey} — #{i.id} {i.title}
                  </a>
                ))}
              </RiskBlock>

              <RiskBlock title="Epics with no tasks" count={report.risks.emptyEpics.length}
                hint="counted by their own status">
                {report.risks.emptyEpics.slice(0, 40).map(e => (
                  <a key={e.key} className="ps-risk-link" href={e.url} target="_blank" rel="noreferrer">
                    {e.key} — {e.summary}
                  </a>
                ))}
              </RiskBlock>

              <RiskBlock title="No movement for over 30 days" count={report.risks.stale.length}
                hint="not closed and not updated">
                {report.risks.stale.slice(0, 40).map(i => (
                  <a key={i.id} className="ps-risk-link" href={i.url} target="_blank" rel="noreferrer">
                    #{i.id} {i.title} — {fmtDays(i.staleDays)}
                  </a>
                ))}
              </RiskBlock>

              <RiskBlock title="Azure and Jira disagree" count={report.risks.stateMismatch.length}
                hint="closed in one system, open in the other">
                {report.risks.stateMismatch.slice(0, 40).map(i => (
                  <a key={i.id} className="ps-risk-link" href={i.url} target="_blank" rel="noreferrer">
                    #{i.id} {i.title} — Azure «{i.state}», Jira {i.pct}%
                  </a>
                ))}
              </RiskBlock>
            </div>
          </ChartCard>

          {/* ── Items table ─────────────────────────────────────────────────── */}
          <ChartCard
            title="Board work items"
            hint={`${rows.length} of ${report.items.length}${sliceAvg !== null && isFiltering ? ` · slice: ${sliceAvg}%` : ''}`}
            wide
          >
            <div className="ps-table-bar">
              <input
                className="input ps-search"
                placeholder="Search: #id, title, Jira key, assignee…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {bin && (
                <button type="button" className="ps-filter-chip" onClick={() => setBin(null)}>
                  progress {PROGRESS_BINS.find(b => b.id === bin)?.label} ✕
                </button>
              )}
              {stateFilter && (
                <button type="button" className="ps-filter-chip" onClick={() => setStateFilter(null)}>
                  Azure “{stateFilter}” ✕
                </button>
              )}
              {status !== 'all' && (
                <button type="button" className="ps-filter-chip" onClick={() => setStatus('all')}>
                  {STATUSES.find(s => s.id === status)?.label} ✕
                </button>
              )}
              {isFiltering && (
                <button type="button" className="ps-clear" onClick={clearFilters}>clear filters</button>
              )}
            </div>

            <div className="ps-table-scroll">
              <table className="ps-table">
                <thead>
                  <tr>
                    <th />
                    <th className="ps-th-sort" onClick={() => toggleSort('id')}>Azure{sortMark('id')}</th>
                    <th>Title</th>
                    <th>State</th>
                    <th>Jira request</th>
                    <th className="ps-th-n">Epics</th>
                    <th className="ps-th-n ps-th-sort" onClick={() => toggleSort('open')}>Tasks{sortMark('open')}</th>
                    <th className="ps-th-sort" onClick={() => toggleSort('pct')}>Progress{sortMark('pct')}</th>
                    <th className="ps-th-sort" onClick={() => toggleSort('stale')}>Activity{sortMark('stale')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(item => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      open={expanded.has(item.id)}
                      onToggle={() => toggleRow(item.id)}
                    />
                  ))}
                </tbody>
              </table>
              {!rows.length && <p className="ps-none">Nothing matches the current filters.</p>}
            </div>
          </ChartCard>

          <p className="ps-foot">
            How progress is computed: an Azure work item resolves to its linked Jira
            request, the request to its epics; an epic’s progress is the share of
            closed tasks in its subtree (a task in progress = 0.5), and the item’s
            progress is the average across its epics. With no epics it falls back to
            the request’s direct children, and with none of those to the request’s
            own status. Loaded {snapshot.counts.nodes} Jira issues under{' '}
            {snapshot.counts.requests} requests.
          </p>
        </div>
      )}

      {isOverview && !report && !loading && !error && (
        <p className="ps-empty">Pick a project and a board, then press “Load”.</p>
      )}
    </div>
  );
}
