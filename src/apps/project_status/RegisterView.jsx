import { useMemo, useState } from 'react';
import { ChartCard } from './charts.jsx';
import { SEVERITY_LABEL, TREND_MARK, TREND_LABEL } from './pmBrainData.js';

// ─── Risks › the register ─────────────────────────────────────────────────────
// The machine-owned register (`00_DASHBOARD/Risks/.register-<P>.json`), grouped
// by milestone — the view the RBS table and the Risk Graph could not give:
// the graph has no milestone at all, and RBS is maintained by hand.
//
// Risks are never deleted. A solved risk moves to `resolved` (with the evidence
// that closed it) and leaves the default list through the status filter, so the
// history stays readable — the vault's own rule is "only forward".
//
// Stage 1 renders the register and lets a human override any status. Extraction
// from call notes and automatic resolution land in the next stages; until then a
// project's register is whatever the Risk Graph seed brought in.

const STATUSES = [
  { id: 'open',     label: 'Open',      hint: 'active + resolving' },
  { id: 'active',   label: 'Active' },
  { id: 'resolving', label: 'Resolving' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'dormant',  label: 'Dormant',   hint: 'not re-raised' },
  { id: 'all',      label: 'All' },
];

const STATUS_LABEL = {
  active: 'Active', resolving: 'Resolving', resolved: 'Resolved', dormant: 'Dormant',
};

const UNATTRIBUTED = '__none__';

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

const matchesStatus = (risk, filter) => {
  if (filter === 'all') return true;
  if (filter === 'open') return risk.open;
  return risk.statusEffective === filter;
};

// ─── One risk ─────────────────────────────────────────────────────────────────

function OverrideBar({ risk, busy, writable, onOverride }) {
  // Which move is worth offering depends on where the risk is: an open risk can
  // be closed, a closed one reopened. The third button only appears when there is
  // an override to clear — otherwise it reads as a third state.
  const isOpen = risk.open;
  const disabled = busy || !writable;
  const why = writable ? undefined : 'PM_BRAIN_GITHUB_TOKEN is not set — the register is read-only.';
  return (
    <div className="ps-reg-actions">
      {risk.override && (
        <span className="ps-reg-ovr" title={`${risk.override.why || 'manual override'} · ${fmtDate(risk.override.at)}`}>
          manual: {STATUS_LABEL[risk.override.status]}
        </span>
      )}
      {isOpen ? (
        <button type="button" className="ps-reg-btn" disabled={disabled} title={why}
          onClick={() => onOverride(risk, 'resolved')}>
          Mark resolved
        </button>
      ) : (
        <button type="button" className="ps-reg-btn" disabled={disabled} title={why}
          onClick={() => onOverride(risk, 'active')}>
          Reopen
        </button>
      )}
      {risk.override && (
        <button type="button" className="ps-reg-btn ps-reg-btn-ghost" disabled={disabled} title={why}
          onClick={() => onOverride(risk, null)}>
          clear
        </button>
      )}
    </div>
  );
}

function RiskRow({ risk, open, onToggle, busy, writable, onOverride }) {
  const last = risk.retro?.[risk.retro.length - 1] ?? null;
  return (
    <div className={`ps-reg-risk${open ? ' open' : ''}`}>
      <button type="button" className="ps-reg-head" onClick={onToggle} aria-expanded={open}>
        <span className={`ps-sev ps-sev-${risk.severity || 'watch'}`}>
          {SEVERITY_LABEL[risk.severity] ?? '—'}
        </span>
        <span className="ps-reg-id">{risk.id}</span>
        <span className="ps-reg-title" title={risk.title}>{risk.title}</span>
        {risk.trend && (
          <span className={`ps-trend ps-trend-${risk.trend}`} title={`Last review: ${TREND_LABEL[risk.trend]}`}>
            {TREND_MARK[risk.trend]}
          </span>
        )}
        <span className={`ps-reg-st ps-reg-st-${risk.statusEffective}`}>
          {STATUS_LABEL[risk.statusEffective] ?? risk.statusEffective}
        </span>
        <span className="ps-reg-meta">
          {risk.retro?.length ?? 0} review{(risk.retro?.length ?? 0) === 1 ? '' : 's'} · last {fmtDate(risk.last)}
        </span>
      </button>

      {open && (
        <div className="ps-reg-body">
          {risk.resolution && (
            <p className="ps-reg-res">
              <b>Resolved {fmtDate(risk.resolution.at)}</b>
              {risk.resolution.signals?.length ? ` · signals: ${risk.resolution.signals.join(' + ')}` : ''}
              {risk.resolution.evidence?.length ? ` — ${risk.resolution.evidence.join('; ')}` : ''}
            </p>
          )}
          {risk.milestoneFrom === 'auto-name' && (
            <p className="ps-reg-note">
              Milestone guessed from the title{risk.milestoneMatched?.length ? ` (matched: ${risk.milestoneMatched.join(', ')})` : ''} — not confirmed by a call.
            </p>
          )}
          {(risk.retro ?? []).map((r, idx) => (
            <div className="ps-retro" key={`${r.date}-${idx}`}>
              <span className="ps-retro-date">{fmtDate(r.date)}</span>
              <span className="ps-retro-text">
                {r.text}
                {r.quote && <em className="ps-reg-quote">“{r.quote}”</em>}
                {r.source?.url && (
                  <a className="ps-retro-link" href={r.source.url} target="_blank" rel="noreferrer">Fathom ↗</a>
                )}
              </span>
            </div>
          ))}
          {!risk.retro?.length && <p className="ps-none">No history recorded yet.</p>}
          <OverrideBar risk={risk} busy={busy} writable={writable} onOverride={onOverride} />
        </div>
      )}
    </div>
  );
}

// ─── The view ─────────────────────────────────────────────────────────────────

export default function RegisterView({
  register, milestones, busyRisk, seeding, onSeed, onOverride, onOpenMilestone,
}) {
  const [status, setStatus] = useState('open');
  const [search, setSearch] = useState('');
  const [openRisk, setOpenRisk] = useState(null);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (register.risks ?? []).filter(r => {
      if (!matchesStatus(r, status)) return false;
      if (q && !`${r.id} ${r.title} ${r.milestone ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [register.risks, status, search]);

  // Group by milestone, in the vault's own folder order, with the unattributed
  // bucket last — those are the seeded graph nodes whose milestone nobody has
  // determined yet, and they must not look like a milestone of their own.
  const groups = useMemo(() => {
    const byMs = new Map();
    for (const r of rows) {
      const key = r.milestone || UNATTRIBUTED;
      if (!byMs.has(key)) byMs.set(key, []);
      byMs.get(key).push(r);
    }
    const rank = { critical: 0, elevated: 1, watch: 2 };
    const order = [...(milestones ?? []), ...[...byMs.keys()].filter(k => k !== UNATTRIBUTED && !(milestones ?? []).includes(k))];
    const out = order
      .filter(name => byMs.has(name))
      .map(name => ({ name, risks: byMs.get(name) }));
    if (byMs.has(UNATTRIBUTED)) out.push({ name: null, risks: byMs.get(UNATTRIBUTED) });
    for (const g of out) {
      g.risks.sort((a, b) =>
        (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
        || String(b.last).localeCompare(String(a.last)));
    }
    return out;
  }, [rows, milestones]);

  const c = register.counts;
  const calls = register.calls;

  // Nothing imported and nothing extracted yet: the one action that makes sense
  // is bringing in the canonical graph as history.
  if (!register.risks?.length && status === 'open' && !search) {
    return (
      <div className="ps-report">
        <div className="ps-notice">
          <b>The register for {register.vaultProject} is empty.</b>{' '}
          Import the canonical <code>Risk Graph.md</code> as seed history, then run the
          analysis over this project’s call notes.
          <div className="ps-reg-empty-actions">
            <button type="button" className="btn btn-primary ps-reg-seed" onClick={onSeed}
              disabled={seeding || !register.writable}
              title={register.writable ? undefined : 'PM_BRAIN_GITHUB_TOKEN is not set — the register cannot be written.'}>
              {seeding ? <span className="spinner" /> : 'Import Risk Graph as seed'}
            </button>
            <span className="ps-hint-inline">
              {calls.total} call note{calls.total === 1 ? '' : 's'} archived for this project
              {' '}across {Object.keys(calls.byMilestone).length} milestone(s)
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ps-report">
      <div className="ps-kpis">
        <div className="ps-kpi ps-kpi-hero">
          <span className="ps-kpi-n">{c.open}</span>
          <span className="ps-kpi-l">open risks<br />of {c.total} in the register</span>
        </div>
        <div className="ps-kpi"><span className="ps-kpi-n">{c.active}</span><span className="ps-kpi-l">active</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{c.resolving}</span><span className="ps-kpi-l">resolving</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{c.resolved}</span><span className="ps-kpi-l">resolved</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{c.dormant}</span><span className="ps-kpi-l">dormant · not re-raised</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{c.unattributed}</span><span className="ps-kpi-l">no milestone yet</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{calls.total}</span><span className="ps-kpi-l">call notes in the vault</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{register.processed}</span><span className="ps-kpi-l">calls analysed</span></div>
      </div>

      <div className="ps-table-bar ps-reg-bar">
        <div className="ps-reg-statuses">
          {STATUSES.map(s => (
            <button
              key={s.id}
              type="button"
              className={`ps-filter-chip${status === s.id ? ' active' : ''}`}
              title={s.hint}
              onClick={() => setStatus(s.id)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <input className="input ps-search" placeholder="Search risks: id, text, milestone…"
          value={search} onChange={e => setSearch(e.target.value)} />
        <button type="button" className="ps-reg-btn" onClick={onSeed} disabled={seeding || !register.writable}
          title={register.writable
            ? 'Import any Risk Graph node that is not in the register yet'
            : 'PM_BRAIN_GITHUB_TOKEN is not set — the register cannot be written.'}>
          {seeding ? <span className="spinner" /> : 'Sync from Risk Graph'}
        </button>
      </div>

      {groups.map(g => (
        <ChartCard
          key={g.name ?? UNATTRIBUTED}
          title={g.name ?? 'No milestone determined'}
          hint={`${g.risks.length} risk${g.risks.length === 1 ? '' : 's'}${
            g.name && calls.byMilestone[g.name] ? ` · ${calls.byMilestone[g.name]} calls` : ''}`}
          note={g.name
            ? undefined
            : 'Seeded from Risk Graph, which records no milestone. The analysis pass attributes these '
              + 'from the calls that raise them; until then they belong to the project as a whole.'}
          wide
        >
          {g.name && onOpenMilestone && (
            <div className="ps-reg-group-bar">
              <button type="button" className="ps-link-btn" onClick={() => onOpenMilestone(g.name)}>
                open milestone ↗
              </button>
            </div>
          )}
          <div className="ps-reg-list">
            {g.risks.map(r => (
              <RiskRow
                key={r.id}
                risk={r}
                open={openRisk === r.id}
                onToggle={() => setOpenRisk(openRisk === r.id ? null : r.id)}
                busy={busyRisk === r.id}
                writable={register.writable}
                onOverride={onOverride}
              />
            ))}
          </div>
        </ChartCard>
      ))}

      {!rows.length && (
        <p className="ps-none">
          No risks match “{STATUSES.find(s => s.id === status)?.label}”
          {search ? ` and “${search}”` : ''}.
        </p>
      )}

      <p className="ps-foot">
        Register: <code>{register.registerPath}</code>
        {' '}· read from the {register.registerSource === 'fs' ? 'local vault' : 'git mirror'}
        {register.registerSource !== register.source
          ? ` (the vault files come from the ${register.source === 'fs' ? 'local vault' : 'git mirror'})`
          : ''}
        {register.updatedAt ? ` · last written ${fmtDate(register.updatedAt)}` : ''}
        {register.seededFrom ? ` · seeded from ${register.seededFrom.file} (${register.seededFrom.nodes} nodes)` : ''}.
        {' '}A manual status always wins over the engine’s and survives the next run.
      </p>
    </div>
  );
}
