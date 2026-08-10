import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getAreaPaths } from '../../services/azureDevops.js';
import { loadProjectSnapshot, getCachedSnapshot, CANCELLED } from './loadSnapshot.js';
import { buildReport } from './metrics.js';
import { useSlidingPill } from '../../platform/useSlidingPill.js';
import {
  fetchPmBrain, fetchRiskRegister, seedRiskRegister, overrideRiskStatus,
} from './pmBrainData.js';
import RegisterView from './RegisterView.jsx';
import RisksView from './RisksView.jsx';
import MilestonesView from './MilestonesView.jsx';

// ─── Risks ────────────────────────────────────────────────────────────────────
// Risk report over the PM Brain Obsidian vault, per project and per milestone.
//
// Two tabs:
//   • Risks — the machine-owned register (`.register-<P>.json`, written by the
//     app), followed by the hand-maintained RBS scoring and the active blockers.
//   • Milestones — one card per milestone folder, with delivery progress from the
//     Azure board it matches.
//
// The Azure board load lives on the Milestones tab, which is the only thing that
// needs it: opening Risks must never cost a 3–15 s board fetch. It is also the
// third resolution signal for the engine ("the work that carried this risk is
// closed"), which is why the picker stays in the app at all.

const ALL_BOARDS = '__all__';

const TABS = [
  { id: 'risks',      name: 'Risks' },
  { id: 'milestones', name: 'Milestones' },
];

const HEAD = {
  risks: {
    title: 'Risks — register per milestone',
    sub: 'Risks built from the project’s call notes in the PM Brain vault, one entry per '
       + 'unique risk with its dated history and call links. A risk that gets solved moves '
       + 'to “resolved” and leaves the open list — nothing is ever deleted. Below the '
       + 'register: the hand-scored RBS table and everything currently blocking work.',
  },
  milestones: {
    title: 'Risks — milestones',
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

// Segmented view switcher — the platform's sliding liquid-glass pill (same
// primitive as the PM workspace switcher and the sidebar nav).
function Tabs({ tab, onPick }) {
  const { trackRef, setItemRef, box, ready, seq } = useSlidingPill(tab);
  return (
    <div className="ps-tabs glass-panel" role="tablist" aria-label="Risk views" ref={trackRef}>
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
  const [tab, setTab] = useState('risks');

  // Azure snapshot — only the Milestones tab uses it (delivery progress).
  const [boards,        setBoards]        = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [board,     setBoard]     = useState(ALL_BOARDS);
  const [loading,   setLoading]   = useState(false);
  const [progress,  setProgress]  = useState(null);
  const [error,     setError]     = useState('');
  const [snapshot,  setSnapshot]  = useState(null);

  // PM Brain (vault files) — read fresh, independent of the Azure snapshot.
  const [brain,        setBrain]        = useState(null);
  const [brainLoading, setBrainLoading] = useState(false);
  const [brainError,   setBrainError]   = useState('');
  const [focusMs,      setFocusMs]      = useState(null);

  // The register — written by the app, so it has its own loading and error state.
  const [register,     setRegister]     = useState(null);
  const [regLoading,   setRegLoading]   = useState(false);
  const [regError,     setRegError]     = useState('');
  const [seeding,      setSeeding]      = useState('');   // '' | 'run' | a result line
  const [busyRisk,     setBusyRisk]     = useState(null);

  const loadSeq  = useRef(0);
  const brainSeq = useRef(0);
  const regSeq   = useRef(0);
  const proj = projects.find(p => p.id === projectId) ?? null;
  const changedSince = null;      // the whole history is loaded — see loadSnapshot
  const areaPath = board === ALL_BOARDS ? null : board;

  // ── Boards (Area Paths) of the selected project ───────────────────────────
  // Deliberately NOT filtered by `boardAllowList`: on ABS the dotted Area Paths
  // ("ABS. WS. Customer Service") are absent from that list and hold ~39% of the
  // project, so filtering by it would hide a third of the work.
  useEffect(() => {
    setBoards([]);
    setBoard(ALL_BOARDS);
    if (!proj) return;
    let cancelled = false;
    setBoardsLoading(true);
    getAreaPaths(proj.azure.proxyKey, proj.azure.project)
      .then(all => {
        if (cancelled) return;
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

  const loadRegister = useCallback(async (force = false) => {
    if (!proj) return;
    if (register?.project === proj.id && !force) return;
    const seq = ++regSeq.current;
    setRegLoading(true);
    setRegError('');
    try {
      const data = await fetchRiskRegister(proj.id);
      if (seq !== regSeq.current) return;
      if (data?.available === false) { setRegister(null); setRegError(data.reason || 'The register is not available.'); }
      else setRegister(data);
    } catch (e) {
      if (seq === regSeq.current) { setRegister(null); setRegError(e?.message || 'Register request failed.'); }
    } finally {
      if (seq === regSeq.current) setRegLoading(false);
    }
  }, [proj, register?.project]);

  // Both tabs need the vault payload (Risks shows the RBS table under the
  // register); only Risks needs the register itself.
  useEffect(() => { loadBrain(false); }, [tab, projectId]);        // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'risks') loadRegister(false); }, [tab, projectId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Only the messages are cleared on a project switch. The payloads are NOT reset
  // here and the sequence guards are NOT bumped: both loads start in the effects
  // above on the very first render, and a reset effect running after them would
  // invalidate the seq they just captured, so the first result was thrown away and
  // the tab stayed empty until something re-triggered it. Instead, each payload
  // carries the project it belongs to and is matched against the selection at
  // render time (`brainData` / `regData`) — a stale project's data can then never
  // be displayed, without a reset racing the fetch.
  useEffect(() => { setBrainError(''); setRegError(''); setSeeding(''); }, [projectId]);

  const load = useCallback(async () => {
    if (!proj) return;
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    setProgress(null);
    setSnapshot(null);
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

  const onSeed = useCallback(async () => {
    if (!proj) return;
    setSeeding('run');
    setRegError('');
    try {
      const out = await seedRiskRegister(proj.id);
      setSeeding(out.added
        ? `Imported ${out.added} node(s)${out.attributed ? `, ${out.attributed} attributed to a milestone` : ''}${out.skipped ? ` · ${out.skipped} already present` : ''}.`
        : `Nothing new — all ${out.graphNodes} graph node(s) are already in the register.`);
      await loadRegister(true);
    } catch (e) {
      setSeeding('');
      setRegError(e?.message || 'Seeding failed.');
    }
  }, [proj, loadRegister]);

  // An override is a single-risk write, so patch that one row in place instead of
  // refetching the whole register — the list must not jump under the cursor.
  const onOverride = useCallback(async (risk, status) => {
    if (!proj) return;
    setBusyRisk(risk.id);
    setRegError('');
    try {
      const updated = await overrideRiskStatus(proj.id, risk.id, status, '');
      setRegister(prev => {
        if (!prev) return prev;
        const risks = prev.risks.map(r => (r.id === updated.id ? updated : r));
        return { ...prev, risks, counts: recount(risks) };
      });
    } catch (e) {
      setRegError(e?.message || 'Could not change the status.');
    } finally {
      setBusyRisk(null);
    }
  }, [proj]);

  const isMilestones = tab === 'milestones';
  const boardLabel = board === ALL_BOARDS ? 'whole project' : boards.find(b => b.path === board)?.name || board;

  // Never render another project's payload while its own load is in flight.
  const brainData = brain?.project === projectId ? brain : null;
  const regData   = register?.project === projectId ? register : null;

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

        {isMilestones && <label className="ps-field ps-field-board">
          <span className="ps-field-label">Board (Area Path) — for delivery progress</span>
          <select className="select" value={board} disabled={loading || boardsLoading}
            onChange={e => setBoard(e.target.value)}>
            <option value={ALL_BOARDS}>
              {boardsLoading ? 'Loading boards…' : `Whole project${boards.length ? ` (${boards.length} boards)` : ''}`}
            </option>
            {boards.map(b => (
              <option key={b.path} value={b.path}>
                {' '.repeat(Math.max(0, b.path.split('\\').length - 2) * 3)}{b.name}
              </option>
            ))}
          </select>
        </label>}

        {isMilestones && (
          <button type="button" className="btn btn-primary ps-load-btn" onClick={load} disabled={loading || !proj}>
            {loading ? <span className="spinner" /> : snapshot ? 'Refresh board' : 'Load board'}
          </button>
        )}

        <button type="button" className="btn btn-primary ps-load-btn"
          onClick={() => { loadBrain(true); if (!isMilestones) loadRegister(true); }}
          disabled={brainLoading || regLoading || !proj}>
          {brainLoading || regLoading ? <span className="spinner" /> : 'Reload vault'}
        </button>

        {isMilestones && snapshot && !loading && (
          <span className="ps-loaded-at">
            {boardLabel} · loaded at{' '}
            {new Date(snapshot.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
        {brainData && !brainLoading && (
          <span className="ps-loaded-at">
            PM Brain · {brainData.vaultProject} · {brainData.source === 'fs' ? 'local vault' : 'git mirror'} ·{' '}
            {new Date(brainData.loadedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}
      </div>

      {isMilestones && loading && (
        <p className="ps-progress"><span className="spinner" /> {progressText(progress) || 'Loading…'}</p>
      )}
      {isMilestones && error && <p className="ps-err">⚠ {error}</p>}

      {(brainLoading || regLoading) && (
        <p className="ps-progress"><span className="spinner" /> Reading the PM Brain vault…</p>
      )}
      {brainError && <div className="ps-notice"><b>PM Brain is not available.</b> {brainError}</div>}
      {regError && <div className="ps-notice"><b>Risk register.</b> {regError}</div>}
      {seeding && seeding !== 'run' && <div className="ps-notice">{seeding}</div>}

      {tab === 'risks' && (
        <>
          {regData && !regLoading && (
            <RegisterView
              register={regData}
              milestones={(brainData?.milestones ?? []).map(m => m.name)}
              busyRisk={busyRisk}
              seeding={seeding === 'run'}
              onSeed={onSeed}
              onOverride={onOverride}
              onOpenMilestone={name => { setFocusMs(name); setTab('milestones'); }}
            />
          )}
          {/* The two blocks come from different places and one is scored by hand,
              so the boundary has to be visible — without it the RBS KPI row reads
              as if it were counting the register above it. */}
          {brainData && !brainLoading && (
            <h3 className="ps-section-h">
              Hand-maintained in Obsidian
              <span> · RBS scoring (probability × impact) and active blockers</span>
            </h3>
          )}
          {brainData && !brainLoading && (
            <RisksView
              brain={brainData}
              hideGraph
              onOpenMilestone={name => { setFocusMs(name); setTab('milestones'); }}
            />
          )}
        </>
      )}

      {isMilestones && brainData && !brainLoading && (
        <MilestonesView
          brain={brainData}
          projectId={projectId}
          items={report?.items ?? []}
          areaPaths={snapshot?.areaPaths ?? []}
          boardScoped={!!snapshot?.areaPath}
          focus={focusMs}
          onFocusHandled={() => setFocusMs(null)}
        />
      )}
    </div>
  );
}

/** Counts after a single-row change — same shape the server computes. */
function recount(risks) {
  const by = s => risks.filter(r => r.statusEffective === s).length;
  return {
    total: risks.length,
    open: risks.filter(r => r.open).length,
    active: by('active'),
    resolving: by('resolving'),
    resolved: by('resolved'),
    dormant: by('dormant'),
    unattributed: risks.filter(r => !r.milestone).length,
  };
}
