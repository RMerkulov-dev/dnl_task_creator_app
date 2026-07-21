import { useState, useEffect, useMemo, useCallback } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getIterations, getBoardWorkItems, updateWorkItemIteration } from '../../services/azureDevops.js';

// Only projects that actually run on sprints (features.iteration) can move work
// items between iterations. ABS is board-based and HT is flat — they have no
// sprints, so they never appear in the Iterations tool.
const SPRINT_PROJECTS = PROJECT_LIST.filter(p => p.features?.iteration);

// Fixed column order to match the Azure DevOps board layout. States not listed
// here fall to the end (alphabetically). Matched case-insensitively on trimmed
// name, so minor casing differences still line up.
const STATE_ORDER = [
  'Request',
  'Need more info',
  'In Progress',
  'Ready for testing on Samdbox',
  'Approved for Prod',
  'Ready for testing on Prod',
  'Resolved',
  'Closed',
];
const STATE_RANK = new Map(STATE_ORDER.map((s, i) => [s.toLowerCase(), i]));
const rankOf = (state) => {
  const r = STATE_RANK.get((state || '').trim().toLowerCase());
  return r === undefined ? STATE_ORDER.length : r;
};

// Group a state name into one of three colour buckets, mirroring the Azure state
// categories used elsewhere — without a per-type states fetch (cheap heuristic).
function toneForState(state) {
  const s = (state || '').toLowerCase();
  if (/(done|closed|resolved|completed|removed)/.test(s)) return 'done';
  if (/(active|progress|committed|doing|review|testing)/.test(s)) return 'progress';
  return 'todo';
}

// Short label for a work-item type, used on the type chip.
function typeTone(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('epic')) return 'epic';
  if (t.includes('story')) return 'story';
  if (t.includes('bug')) return 'bug';
  return 'task';
}

export default function IterationsApp({ allowedProjects }) {
  const projects = useMemo(() => (
    allowedProjects?.length
      ? SPRINT_PROJECTS.filter(p => allowedProjects.includes(p.id))
      : SPRINT_PROJECTS
  ), [allowedProjects]);

  const [proj, setProj] = useState(projects[0] ?? null);

  const [iterations, setIterations]     = useState([]);
  const [iterLoading, setIterLoading]   = useState(false);
  const [sourceSprint, setSourceSprint] = useState('');
  const [targetSprint, setTargetSprint] = useState('');

  const [items,   setItems]   = useState([]);   // [{ id, title, type, state, assignedTo, url, _move }]
  const [selected, setSelected] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [loaded,  setLoaded]  = useState(false);
  const [moving,  setMoving]  = useState(false);
  const [error,   setError]   = useState('');

  // ── Load sprints whenever the project changes ──────────────────────────────
  useEffect(() => {
    setIterations([]); setSourceSprint(''); setTargetSprint('');
    setItems([]); setSelected(new Set()); setLoaded(false); setError('');
    if (!proj) return;
    let cancelled = false;
    setIterLoading(true);
    getIterations(proj.azure.proxyKey, proj.azure.project)
      .then(all => { if (!cancelled) setIterations(all); })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setIterLoading(false));
    return () => { cancelled = true; };
  }, [proj]);

  // ── Load the work items in the selected source sprint ──────────────────────
  const load = useCallback(async () => {
    if (!proj || !sourceSprint) { setError('Select a source sprint first.'); return; }
    setLoading(true); setError(''); setSelected(new Set());
    try {
      const list = await getBoardWorkItems(
        proj.azure.proxyKey,
        proj.azure.project,
        proj.azure.jiraIdField,
        null,            // no board / area-path filter
        sourceSprint,    // filter by the chosen sprint
      );
      setItems(list.map(i => ({ ...i, _move: null })));
      setLoaded(true);
    } catch (e) {
      setError(e.message || 'Failed to load work items.');
    } finally {
      setLoading(false);
    }
  }, [proj, sourceSprint]);

  // ── Selection helpers ──────────────────────────────────────────────────────
  const toggleOne = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleMany = useCallback((ids, on) => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });
  }, []);

  // ── Group loaded items by state for display ────────────────────────────────
  const groups = useMemo(() => {
    const byState = new Map();
    for (const it of items) {
      const s = it.state || '—';
      if (!byState.has(s)) byState.set(s, []);
      byState.get(s).push(it);
    }
    // Order columns to match the Azure board; unknown states sort to the end.
    return [...byState.entries()]
      .map(([state, rows]) => ({ state, tone: toneForState(state), rows }))
      .sort((a, b) => (rankOf(a.state) - rankOf(b.state)) || a.state.localeCompare(b.state));
  }, [items]);

  const allIds       = useMemo(() => items.map(i => i.id), [items]);
  const selectedRows = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected]);
  const allSelected  = items.length > 0 && selected.size === items.length;

  const targetSprintName = iterations.find(it => it.path === targetSprint)?.name ?? '';

  // ── Batch-move the selected items into the target sprint ───────────────────
  async function move() {
    setError('');
    if (!targetSprint)      { setError('Select a target sprint.'); return; }
    if (targetSprint === sourceSprint) { setError('Target sprint is the same as the source.'); return; }
    if (!selectedRows.length) { setError('Select at least one work item.'); return; }

    setMoving(true);
    // Reset any previous per-row outcome for the rows we're about to touch.
    setItems(prev => prev.map(i => (selected.has(i.id) ? { ...i, _move: 'pending' } : i)));

    const movedOk = [];
    for (const row of selectedRows) {
      setItems(prev => prev.map(i => (i.id === row.id ? { ...i, _move: 'working' } : i)));
      const r = await updateWorkItemIteration(proj.azure.proxyKey, proj.azure.project, row.id, targetSprint)
        .then(() => ({ ok: true }))
        .catch(e => ({ ok: false, error: e.message }));
      if (r.ok) {
        movedOk.push(row.id);
        setItems(prev => prev.map(i => (i.id === row.id ? { ...i, _move: 'done' } : i)));
      } else {
        setItems(prev => prev.map(i => (i.id === row.id ? { ...i, _move: 'error', _err: r.error } : i)));
      }
    }

    // Drop successfully-moved rows from the source-sprint list and clear their
    // selection (they no longer belong to this sprint). Failed rows stay so the
    // error is visible and the user can retry.
    setItems(prev => prev.filter(i => !movedOk.includes(i.id)));
    setSelected(prev => {
      const next = new Set(prev);
      for (const id of movedOk) next.delete(id);
      return next;
    });
    setMoving(false);
  }

  const moveProgress = useMemo(() => {
    const touched = items.filter(i => i._move);
    const done = touched.filter(i => i._move === 'done').length;
    const failed = touched.filter(i => i._move === 'error').length;
    return { total: touched.length, done, failed };
  }, [items]);

  return (
    <div className="iter">
      <div className="iter-head">
        <h2 className="iter-title">Iterations</h2>
        <p className="iter-sub">
          Move Azure DevOps work items between sprints in bulk — pick a source sprint,
          tick the items, then reassign them all to another sprint.
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="iter-empty">No sprint-based projects are available to you.</div>
      ) : (
      <div className="iter-grid">
        {/* ── Left: source / target selection ── */}
        <div className="iter-panel">
          <label className="iter-label">Project</label>
          <select
            className="select"
            value={proj?.id ?? ''}
            onChange={e => setProj(projects.find(p => p.id === e.target.value))}
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>

          <label className="iter-label" style={{ marginTop: 16 }}>Source sprint</label>
          <select
            className="select"
            value={sourceSprint}
            onChange={e => setSourceSprint(e.target.value)}
            disabled={iterLoading || !iterations.length}
          >
            <option value="">{iterLoading ? 'Loading sprints…' : '— Select sprint —'}</option>
            {iterations.map(it => (
              <option key={it.id} value={it.path}>{it.name}</option>
            ))}
          </select>

          <button
            className="btn btn-primary iter-load"
            onClick={load}
            disabled={loading || !sourceSprint}
          >
            {loading ? <><span className="spinner" /> Loading…</> : (loaded ? 'Reload items' : 'Load items')}
          </button>

          <div className="iter-divider" />

          <label className="iter-label">Move to sprint</label>
          <select
            className="select"
            value={targetSprint}
            onChange={e => setTargetSprint(e.target.value)}
            disabled={!iterations.length}
          >
            <option value="">— Select target sprint —</option>
            {iterations.map(it => (
              <option key={it.id} value={it.path} disabled={it.path === sourceSprint}>
                {it.name}{it.path === sourceSprint ? ' (source)' : ''}
              </option>
            ))}
          </select>

          <button
            className={`btn btn-primary iter-move${moving ? ' is-running' : ''}`}
            onClick={move}
            disabled={moving || !targetSprint || !selectedRows.length}
          >
            {moving
              ? <><span className="spinner" /> Moving…</>
              : `Move ${selectedRows.length} item${selectedRows.length === 1 ? '' : 's'}${targetSprintName ? ` → ${targetSprintName}` : ''}`}
          </button>

          {moveProgress.total > 0 && (
            <div className="iter-progress">
              {moveProgress.done + moveProgress.failed} / {moveProgress.total} processed
              {moveProgress.failed > 0 && <span className="iter-progress-failed"> · {moveProgress.failed} failed</span>}
            </div>
          )}

          {error && <div className="iter-error">{error}</div>}
        </div>

        {/* ── Right: item board — one column per status ── */}
        <div className="iter-panel iter-boardwrap">
          {!loaded && !loading && (
            <div className="iter-empty">Load a sprint to see its work items.</div>
          )}
          {loading && <div className="iter-empty"><span className="spinner spinner-lg" /></div>}
          {loaded && !loading && items.length === 0 && (
            <div className="iter-empty">No work items in this sprint.</div>
          )}

          {loaded && !loading && items.length > 0 && (
            <>
              <div className="iter-list-head">
                <label className="iter-check">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={e => toggleMany(allIds, e.target.checked)}
                  />
                  <span>Select all</span>
                </label>
                <span className="iter-count">{selected.size} / {items.length} selected</span>
              </div>

              <div className="iter-board">
                {groups.map(g => {
                  const groupIds = g.rows.map(r => r.id);
                  const groupAllSel = groupIds.every(id => selected.has(id));
                  return (
                    <div key={g.state} className="iter-col">
                      <div className="iter-col-head">
                        <label className="iter-check">
                          <input
                            type="checkbox"
                            checked={groupAllSel}
                            onChange={e => toggleMany(groupIds, e.target.checked)}
                            title="Select whole column"
                          />
                          <span className={`iter-state iter-state-${g.tone}`}>{g.state}</span>
                        </label>
                        <span className="iter-col-count">{g.rows.length}</span>
                      </div>

                      <div className="iter-col-body">
                        {g.rows.map(it => {
                          const isSel = selected.has(it.id);
                          return (
                            <div
                              key={it.id}
                              className={`iter-card iter-card-${g.tone}${isSel ? ' is-selected' : ''}${it._move === 'done' ? ' is-moved' : it._move === 'error' ? ' is-failed' : it._move === 'working' ? ' is-moving' : ''}`}
                              onClick={() => !moving && toggleOne(it.id)}
                            >
                              <div className="iter-card-top">
                                <input
                                  type="checkbox"
                                  checked={isSel}
                                  onChange={() => toggleOne(it.id)}
                                  onClick={e => e.stopPropagation()}
                                  disabled={moving}
                                />
                                <span className={`iter-type iter-type-${typeTone(it.type)}`}>{it.type || '—'}</span>
                                {it.url
                                  ? <a className="iter-id" href={it.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>#{it.id}</a>
                                  : <span className="iter-id">#{it.id}</span>}
                                {it._move === 'working' && <span className="spinner" style={{ width: 12, height: 12, marginLeft: 'auto' }} />}
                                {it._move === 'done'    && <span className="iter-badge iter-badge-ok" style={{ marginLeft: 'auto' }}>moved</span>}
                                {it._move === 'error'   && <span className="iter-badge iter-badge-err" style={{ marginLeft: 'auto' }} title={it._err}>failed</span>}
                              </div>

                              <div className="iter-card-title" title={it.title}>{it.title}</div>

                              <div className="iter-card-foot">
                                <span className="iter-assignee">{it.assignedTo || 'Unassigned'}</span>
                                {it.jiraKey ? (
                                  <a
                                    className="iter-jira"
                                    href={`https://dynamicalabs.atlassian.net/browse/${it.jiraKey}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    onClick={e => e.stopPropagation()}
                                    title="Open in Jira"
                                  >{it.jiraKey}</a>
                                ) : (
                                  <span className="iter-jira iter-jira-none">no Jira link</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
