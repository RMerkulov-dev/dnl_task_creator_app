import { useEffect, useMemo, useState } from 'react';
import { ChartCard, Meter, HBars } from './charts.jsx';
import { DONE, PROGRESS } from './metrics.js';
import {
  matchMilestoneBoards, boardProgressFor, milestoneTiming, leafOf,
  MS_STATUS_LABEL, BAND_VAR, BAND_LABEL,
} from './pmBrainData.js';

// ─── Health › Milestones ──────────────────────────────────────────────────────
// One card per milestone folder in the PM Brain vault: window + mini Gantt from
// Timeline.md, acceptance-criteria progress from the hub, TO DO / Blockers /
// RBS-risk counts — and, when the milestone can be matched to an Azure board,
// the real delivery progress from the already-loaded Health snapshot.
// The match is name-based with an explicit override in config/projects.js; every
// card states which of the two produced it, so a wrong link is visible.

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—');
const fmtFull = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Epics of one Timeline.md laid out on the milestone's own window. */
function MiniGantt({ epics, start, due }) {
  const t0 = start ? Date.parse(start) : NaN;
  const t1 = due ? Date.parse(due) : NaN;
  if (!epics.length || Number.isNaN(t0) || Number.isNaN(t1)) return null;
  const span = Math.max(1, t1 - t0);
  const now = Date.now();
  const nowPct = now >= t0 && now <= t1 ? ((now - t0) / span) * 100 : null;
  return (
    <div className="ps-gantt">
      {nowPct !== null && <span className="ps-gantt-now" style={{ left: `${nowPct}%` }} aria-hidden="true" />}
      {epics.map(e => {
        const a = Date.parse(e.from), b = Date.parse(e.to);
        const left = ((a - t0) / span) * 100;
        const width = Math.max(e.milestone ? 0 : 1.5, ((b - a) / span) * 100);
        return (
          <div className="ps-gantt-row" key={e.id}>
            <span className="ps-gantt-label" title={e.name}>{e.name}</span>
            <span className="ps-gantt-track">
              {e.milestone ? (
                <span className="ps-gantt-diamond" style={{ left: `${left}%` }}
                  title={`${e.name} · ${fmtFull(e.from)}`} />
              ) : (
                <span className="ps-gantt-bar" style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${e.name} · ${fmtFull(e.from)} → ${fmtFull(e.to)}`} />
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Pill({ n, label, tone, title }) {
  return (
    <span className="ps-pill" title={title}>
      <b style={tone ? { color: tone } : undefined}>{n}</b> {label}
    </span>
  );
}

function MilestoneCard({ m, boards, how, progress, open, onToggle, projectAreaPaths, boardScoped }) {
  const timing = milestoneTiming(m);
  const ac = m.acceptance;
  const acPct = ac.total ? Math.round((ac.done / ac.total) * 100) : null;
  const worst = m.maxScore ?? null;
  const band = worst >= 15 ? 'critical' : worst >= 10 ? 'high' : worst >= 5 ? 'medium' : worst ? 'low' : null;

  return (
    <section className={`ps-ms${open ? ' open' : ''}`}>
      <header className="ps-ms-head">
        <button type="button" className="ps-ms-title" onClick={onToggle} aria-expanded={open}>
          <span className={`ps-ms-status ps-ms-${m.status}`}>{MS_STATUS_LABEL[m.status] ?? m.status}</span>
          <span className="ps-ms-name">{m.name}</span>
          {timing.overdue && <span className="ps-ms-late" title="Due date is in the past">overdue</span>}
        </button>
        <span className="ps-ms-window">
          {fmtDate(m.start)} → {fmtDate(m.due)}
          {timing.daysLeft !== null && (
            <span className="ps-ms-left">
              {timing.daysLeft >= 0 ? `${timing.daysLeft} d left` : `${-timing.daysLeft} d over`}
            </span>
          )}
          {m.datesFrom === 'timeline' && <span className="ps-ms-src" title="No dates in the hub — window derived from Timeline.md">from timeline</span>}
        </span>
      </header>

      <div className="ps-ms-body">
        <div className="ps-ms-metrics">
          {/* Delivery progress from Azure/Jira, only when a board is matched —
              otherwise the card says so rather than showing a fabricated 0%. */}
          {progress ? (
            <div className="ps-ms-metric">
              <span className="ps-ms-metric-l">
                Delivery ({leafOf(boards[0])}{boards.length > 1 ? ` +${boards.length - 1}` : ''})
                <span className={`ps-ms-how ps-ms-how-${how}`}>{how === 'mapped' ? 'mapped' : 'auto-matched'}</span>
              </span>
              <div className="ps-ms-metric-row">
                <Meter value={progress.pct ?? 0} tone={progress.pct === 100 ? DONE : PROGRESS} height={7} />
                <b>{progress.pct === null ? '—' : `${progress.pct}%`}</b>
              </div>
              <span className="ps-ms-metric-sub">
                {progress.items} Azure items · {progress.epicsDone}/{progress.epicsTotal} epics · {progress.tasksDone}/{progress.tasksTotal} tasks
              </span>
            </div>
          ) : (
            <div className="ps-ms-metric">
              <span className="ps-ms-metric-l">Delivery</span>
              <span className="ps-ms-metric-sub">
                {!projectAreaPaths.length
                  ? 'load a snapshot on Overview to see delivery progress'
                  : boards.length
                    ? `board “${leafOf(boards[0])}” has no items in the loaded snapshot`
                    : boardScoped
                      ? 'no match among the loaded board — load “Whole project” on Overview to match every board'
                      : 'no Azure board matched — add a row to milestoneBoards in config/projects.js'}
              </span>
            </div>
          )}

          <div className="ps-ms-metric">
            <span className="ps-ms-metric-l">Acceptance criteria</span>
            <div className="ps-ms-metric-row">
              <Meter value={acPct ?? 0} tone={acPct === 100 ? DONE : PROGRESS} height={7} />
              <b>{acPct === null ? '—' : `${acPct}%`}</b>
            </div>
            <span className="ps-ms-metric-sub">{ac.total ? `${ac.done} of ${ac.total} checked` : 'none listed in the hub'}</span>
          </div>

          <div className="ps-ms-metric">
            <span className="ps-ms-metric-l">Window elapsed</span>
            <div className="ps-ms-metric-row">
              <Meter value={timing.elapsed ?? 0} height={7} />
              <b>{timing.elapsed === null ? '—' : `${timing.elapsed}%`}</b>
            </div>
            <span className="ps-ms-metric-sub">{timing.hasWindow ? `due ${fmtFull(m.due)}` : 'no dates yet'}</span>
          </div>
        </div>

        <div className="ps-ms-pills">
          <Pill n={m.todoCounts.open} label="open TODO" title="TO DO.md › Open" />
          {!!m.todoCounts.high && <Pill n={m.todoCounts.high} label="high" tone={BAND_VAR.critical} title="Marked 🔴 in TO DO.md" />}
          <Pill n={m.todoCounts.done} label="done" tone={BAND_VAR.low} />
          <Pill n={m.blockerCounts.active} label="blockers" tone={m.blockerCounts.active ? BAND_VAR.high : undefined} />
          <Pill n={m.risks.length} label="risks" />
          {band && <span className="ps-band" style={{ '--band': BAND_VAR[band] }}>max {worst} · {BAND_LABEL[band]}</span>}
          {!m.timeline.epics.length && <span className="ps-pill ps-pill-warn">no timeline</span>}
        </div>

        {m.goal && <p className="ps-ms-goal">{m.goal}</p>}

        <MiniGantt epics={m.timeline.epics} start={m.timeline.start ?? m.start} due={m.timeline.due ?? m.due} />

        {open && (
          <div className="ps-ms-detail">
            {m.scope && (
              <div className="ps-ms-block">
                <h5>Scope</h5>
                <p>{m.scope}</p>
              </div>
            )}
            {m.latestCall && (
              <div className="ps-ms-block">
                <h5>Latest call</h5>
                <p>{m.latestCall}</p>
              </div>
            )}
            {!!ac.items.length && (
              <div className="ps-ms-block">
                <h5>Acceptance criteria</h5>
                <ul className="ps-ms-list">
                  {ac.items.map((x, i) => (
                    <li key={i} className={x.done ? 'done' : ''}>{x.done ? '☑' : '☐'} {x.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {!!m.todos.length && (
              <div className="ps-ms-block">
                <h5>TO DO — open</h5>
                <ul className="ps-ms-list">
                  {m.todos.filter(t => t.state !== 'done').map((t, i) => (
                    <li key={i}>
                      {t.high && <span className="ps-band" style={{ '--band': BAND_VAR.critical }}>high</span>}
                      {t.owner && <b className="ps-ms-owner">{t.owner}</b>}
                      {t.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!m.blockers.filter(b => b.active).length && (
              <div className="ps-ms-block">
                <h5>Active blockers</h5>
                <ul className="ps-ms-list">
                  {m.blockers.filter(b => b.active).map((b, i) => (
                    <li key={i}>
                      {b.high && <span className="ps-band" style={{ '--band': BAND_VAR.critical }}>high</span>}
                      {b.text}
                      {b.nextStep && <span className="ps-ms-next"> → {b.nextStep}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!m.risks.length && (
              <div className="ps-ms-block">
                <h5>Risks (RBS)</h5>
                <ul className="ps-ms-list">
                  {[...m.risks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((r, i) => (
                    <li key={i}>
                      <span className="ps-band" style={{ '--band': BAND_VAR[r.band ?? 'low'] }}>{r.score ?? '—'}</span>
                      <b className="ps-ms-owner">{r.id ?? ''}</b>{r.title}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="ps-ms-path">{m.path} · {m.files.join(' · ') || 'no files'}</p>
          </div>
        )}
      </div>
    </section>
  );
}

export default function MilestonesView({ brain, items, areaPaths, boardScoped, projectId, focus, onFocusHandled }) {
  const [open, setOpen] = useState(() => new Set(focus ? [focus] : []));
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');

  // A "show this milestone" jump from the Risks tab expands its card once.
  useEffect(() => {
    if (!focus) return;
    setOpen(prev => new Set([...prev, focus]));
    onFocusHandled?.();
  }, [focus]);   // eslint-disable-line react-hooks/exhaustive-deps

  const cards = useMemo(() => (brain.milestones ?? []).map(m => {
    const { boards, how } = matchMilestoneBoards(projectId, m.name, areaPaths);
    return { m, boards, how, progress: boardProgressFor(items, boards) };
  }), [brain.milestones, projectId, areaPaths, items]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cards.filter(({ m }) => {
      if (status !== 'all' && m.status !== status) return false;
      if (q && !`${m.name} ${m.goal} ${m.owner ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      // Overdue first, then by due date, undated last.
      const ao = milestoneTiming(a.m), bo = milestoneTiming(b.m);
      if (ao.overdue !== bo.overdue) return ao.overdue ? -1 : 1;
      if (!a.m.due) return 1;
      if (!b.m.due) return -1;
      return a.m.due.localeCompare(b.m.due);
    });
  }, [cards, status, search]);

  const kpi = useMemo(() => {
    const ms = brain.milestones ?? [];
    const late = ms.filter(m => milestoneTiming(m).overdue).length;
    return {
      total: ms.length,
      inProgress: ms.filter(m => m.status === 'in-progress').length,
      onHold: ms.filter(m => m.status === 'on-hold').length,
      late,
      noDates: ms.filter(m => !m.due).length,
      openTodos: ms.reduce((s, m) => s + m.todoCounts.open, 0),
      blockers: ms.reduce((s, m) => s + m.blockerCounts.active, 0),
      linked: cards.filter(c => c.boards.length).length,
    };
  }, [brain.milestones, cards]);

  const projectLevel = brain.projectLevel ?? { todos: [], blockers: [] };
  const hasProjectLevel = !!(projectLevel.todos.length || projectLevel.blockers.length);

  if (!(brain.milestones ?? []).length && !hasProjectLevel) {
    return (
      <p className="ps-empty">
        No milestones in PM Brain for this project — expected folders under
        {' '}<code>02_PROJECTS/{brain.vaultProject}/Milestones/</code>.
      </p>
    );
  }

  return (
    <div className="ps-report">
      <div className="ps-kpis">
        <div className="ps-kpi ps-kpi-hero">
          <span className="ps-kpi-n">{kpi.inProgress}</span>
          <span className="ps-kpi-l">milestones in progress<br />of {kpi.total} in the vault</span>
        </div>
        <div className="ps-kpi"><span className="ps-kpi-n" style={{ color: BAND_VAR.high }}>{kpi.late}</span><span className="ps-kpi-l">past their due date</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{kpi.onHold}</span><span className="ps-kpi-l">on hold</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{kpi.openTodos}</span><span className="ps-kpi-l">open TODO items</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{kpi.blockers}</span><span className="ps-kpi-l">active blockers</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{kpi.linked}</span><span className="ps-kpi-l">linked to an Azure board</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{kpi.noDates}</span><span className="ps-kpi-l">without a due date</span></div>
      </div>

      <div className="ps-grid">
        <ChartCard title="Open TODO per milestone">
          <HBars rows={(brain.milestones ?? []).map(m => ({ label: m.name, value: m.todoCounts.open }))
            .filter(r => r.value).sort((a, b) => b.value - a.value)} unit="items" />
        </ChartCard>
        <ChartCard title="Active blockers per milestone">
          <HBars rows={(brain.milestones ?? []).map(m => ({ label: m.name, value: m.blockerCounts.active }))
            .filter(r => r.value).sort((a, b) => b.value - a.value)} unit="blockers" />
        </ChartCard>
      </div>

      <div className="ps-table-bar">
        <input className="input ps-search" placeholder="Search milestones…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select ps-inline-select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="in-progress">In progress</option>
          <option value="on-hold">On hold</option>
        </select>
        <span className="ps-hint-inline">{shown.length} of {cards.length}</span>
      </div>

      <div className="ps-ms-list-wrap">
        {shown.map(({ m, boards, how, progress }) => (
          <MilestoneCard
            key={m.name}
            m={m} boards={boards} how={how} progress={progress}
            projectAreaPaths={areaPaths}
            boardScoped={boardScoped}
            open={open.has(m.name)}
            onToggle={() => setOpen(prev => {
              const next = new Set(prev);
              next.has(m.name) ? next.delete(m.name) : next.add(m.name);
              return next;
            })}
          />
        ))}
        {!shown.length && <p className="ps-none">Nothing matches the current filters.</p>}
      </div>

      {/* HYDROTEC-style projects keep TO DO / Blockers at project level. */}
      {hasProjectLevel && (
        <ChartCard title="Project level (no milestone folders)" hint={`${projectLevel.todos.filter(t => t.state !== 'done').length} open TODO · ${projectLevel.blockers.filter(b => b.active).length} blockers`} wide>
          <div className="ps-ms-detail">
            {!!projectLevel.todos.length && (
              <div className="ps-ms-block">
                <h5>TO DO — open</h5>
                <ul className="ps-ms-list">
                  {projectLevel.todos.filter(t => t.state !== 'done').map((t, i) => (
                    <li key={i}>{t.owner && <b className="ps-ms-owner">{t.owner}</b>}{t.text}</li>
                  ))}
                </ul>
              </div>
            )}
            {!!projectLevel.blockers.length && (
              <div className="ps-ms-block">
                <h5>Active blockers</h5>
                <ul className="ps-ms-list">
                  {projectLevel.blockers.filter(b => b.active).map((b, i) => (
                    <li key={i}>{b.text}{b.nextStep && <span className="ps-ms-next"> → {b.nextStep}</span>}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </ChartCard>
      )}

      {!!(brain.orphanRisks ?? []).length && (
        <p className="ps-foot">
          {brain.orphanRisks.length} RBS register row(s) point at a milestone with no folder in the vault
          ({[...new Set(brain.orphanRisks.map(r => r.milestone))].join(', ')}) — renamed or archived.
        </p>
      )}
    </div>
  );
}
