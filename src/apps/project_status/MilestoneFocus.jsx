import { milestoneTiming, MS_STATUS_LABEL, BAND_VAR } from './pmBrainData.js';

// ─── Risks › one milestone ────────────────────────────────────────────────────
// What the Risks tab shows once a single milestone is picked in the toolbar: the
// milestone's own context above the register (so the risk list below is read
// against a window and a goal, not in the abstract), and its hand-maintained
// work — TO DO, blockers, acceptance criteria, RBS rows — below it.
//
// Deliberately NOT the Milestones tab's `MilestoneCard`: that one is a collapsed
// row in a list of eleven and is built around Azure delivery progress, which
// costs a 3–15 s board load the Risks tab must never pay. Here the milestone is
// already the subject of the screen, so everything is open and nothing is Azure.

const fmt = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

function Pill({ n, label, tone, title }) {
  return (
    <span className="ps-pill" title={title}>
      <b style={tone ? { color: tone } : undefined}>{n}</b> {label}
    </span>
  );
}

/** Name, window and counters — the strip that sits above the risk register. */
export function MilestoneHeader({ m, riskCount, callCount, onOpenCard }) {
  const t = milestoneTiming(m);
  const ac = m.acceptance;
  const acPct = ac.total ? Math.round((ac.done / ac.total) * 100) : null;

  return (
    <section className="ps-mf">
      <div className="ps-mf-top">
        <span className={`ps-ms-status ps-ms-${m.status}`}>{MS_STATUS_LABEL[m.status] ?? m.status}</span>
        <h3 className="ps-mf-name">{m.name}</h3>
        {t.overdue && <span className="ps-ms-late" title="Due date is in the past">overdue</span>}
        <span className="ps-mf-window">
          {fmt(m.start)} → {fmt(m.due)}
          {t.daysLeft !== null && (
            <span className="ps-ms-left">{t.daysLeft >= 0 ? `${t.daysLeft} d left` : `${-t.daysLeft} d over`}</span>
          )}
          {m.datesFrom === 'timeline' && (
            <span className="ps-ms-src" title="No dates in the hub — window derived from Timeline.md">from timeline</span>
          )}
        </span>
        {onOpenCard && (
          <button type="button" className="ps-link-btn ps-mf-open" onClick={onOpenCard}>
            full card ↗
          </button>
        )}
      </div>

      {m.goal && <p className="ps-mf-goal">{m.goal}</p>}

      <div className="ps-ms-pills">
        <Pill n={riskCount} label={`risk${riskCount === 1 ? '' : 's'} in register`} title="Risks extracted from this milestone’s call notes" />
        <Pill n={m.todoCounts.open + m.todoCounts.progress} label="open TODO" title="TO DO.md › Open + In progress" />
        {!!m.todoCounts.high && <Pill n={m.todoCounts.high} label="high" tone={BAND_VAR.critical} title="Marked 🔴 in TO DO.md" />}
        <Pill n={m.blockerCounts.active} label="active blockers"
          tone={m.blockerCounts.active ? BAND_VAR.high : undefined} />
        <Pill n={m.risks.length} label="RBS risks" title="Scored by hand in RBS.md" />
        {acPct !== null && <Pill n={`${acPct}%`} label={`acceptance (${ac.done}/${ac.total})`} />}
        {callCount != null && <Pill n={callCount} label="call notes" />}
      </div>
    </section>
  );
}

function TodoItem({ t }) {
  return (
    <li className={t.state === 'done' ? 'done' : ''}>
      {t.high && <span className="ps-band" style={{ '--band': BAND_VAR.critical }}>high</span>}
      {t.state === 'progress' && <span className="ps-pill ps-mf-wip">in progress</span>}
      {t.owner && <b className="ps-ms-owner">{t.owner}</b>}
      {t.text}
    </li>
  );
}

/**
 * TO DO / blockers / acceptance criteria / RBS rows for the milestone, side by
 * side. Empty sections are dropped rather than rendered as empty headings — most
 * milestones in the vault fill in two of the four.
 */
export function MilestoneWork({ m }) {
  const open = (m.todos ?? []).filter(t => t.state !== 'done');
  const done = (m.todos ?? []).filter(t => t.state === 'done');
  const blockers = (m.blockers ?? []).filter(b => b.active);
  const ac = m.acceptance?.items ?? [];
  const rbs = [...(m.risks ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (!open.length && !done.length && !blockers.length && !ac.length && !rbs.length) {
    return (
      <p className="ps-none">
        Nothing recorded by hand for this milestone yet — no TO DO, blockers, acceptance
        criteria or RBS rows in <code>{m.path}</code>.
      </p>
    );
  }

  return (
    <div className="ps-mf-work">
      {!!open.length && (
        <div className="ps-mf-block">
          <h5>TO DO — open <span>{open.length}</span></h5>
          <ul className="ps-ms-list">{open.map((t, i) => <TodoItem key={i} t={t} />)}</ul>
          {!!done.length && (
            <details className="ps-mf-done">
              <summary>{done.length} done</summary>
              <ul className="ps-ms-list">{done.map((t, i) => <TodoItem key={i} t={t} />)}</ul>
            </details>
          )}
        </div>
      )}

      {!blockers.length ? null : (
        <div className="ps-mf-block">
          <h5>Active blockers <span>{blockers.length}</span></h5>
          <ul className="ps-ms-list">
            {blockers.map((b, i) => (
              <li key={i}>
                {b.high && <span className="ps-band" style={{ '--band': BAND_VAR.critical }}>high</span>}
                {b.owner && <b className="ps-ms-owner">{b.owner}</b>}
                {b.text}
                {b.nextStep && <span className="ps-ms-next"> → {b.nextStep}</span>}
                {b.since && <span className="ps-since"> · since {fmt(b.since)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!!ac.length && (
        <div className="ps-mf-block">
          <h5>Acceptance criteria <span>{m.acceptance.done}/{m.acceptance.total}</span></h5>
          <ul className="ps-ms-list">
            {ac.map((x, i) => <li key={i} className={x.done ? 'done' : ''}>{x.done ? '☑' : '☐'} {x.text}</li>)}
          </ul>
        </div>
      )}

      {!!rbs.length && (
        <div className="ps-mf-block">
          <h5>RBS risks — scored by hand <span>{rbs.length}</span></h5>
          <ul className="ps-ms-list">
            {rbs.map((r, i) => (
              <li key={i}>
                <span className="ps-band" style={{ '--band': BAND_VAR[r.band ?? 'low'] }}>{r.score ?? '—'}</span>
                {r.id && <b className="ps-ms-owner">{r.id}</b>}
                {r.title}
                {r.owner && <span className="ps-since"> · {r.owner}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
