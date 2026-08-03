import { useMemo, useState } from 'react';
import { ChartCard, HBars } from './charts.jsx';
import {
  buildRiskReport, BANDS, BAND_LABEL, BAND_VAR, STATUS_LABEL,
  SEVERITY_LABEL, TREND_MARK, TREND_LABEL,
} from './pmBrainData.js';

// ─── Health › Risks ───────────────────────────────────────────────────────────
// Three blocks over the PM Brain vault, kept separate on purpose:
//   1. RBS register (02_PROJECTS/<P>/RBS.md) — the scored weekly table: P×I
//      matrix, bands, categories, one row per risk per milestone.
//   2. Risk Graph (00_DASHBOARD/Risks/Risk Graph.md) — the canonical nodes with
//      a dated retrospective, so a risk carries a TREND (worsened / improved /
//      unchanged) and its Fathom call links.
//   3. Active blockers (per-milestone Blockers.md) — what is stopping work now.
// Read-only: the vault is edited in Obsidian, never from here.

const fmtDate = d => (d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—');

const daysAgo = d => {
  if (!d) return null;
  const n = Math.floor((Date.now() - Date.parse(d)) / 86400000);
  return Number.isFinite(n) ? n : null;
};

function BandChip({ band, children }) {
  if (!band) return <span className="ps-dash">—</span>;
  return (
    <span className="ps-band" style={{ '--band': BAND_VAR[band] }}>
      {children ?? BAND_LABEL[band]}
    </span>
  );
}

/**
 * The P×I matrix. Rows are impact 5→1, columns probability 1→5, so the
 * dangerous corner is top-right — the orientation every PM already reads.
 * Cell tint comes from the band of its score, not from its count: the colour
 * must mean "how bad", the number means "how many".
 */
function RiskMatrix({ matrix, onPick, active }) {
  const bandOf = score => (score >= 15 ? 'critical' : score >= 10 ? 'high' : score >= 5 ? 'medium' : 'low');
  return (
    <div className="ps-matrix-wrap">
      <div className="ps-matrix">
        <span className="ps-matrix-ylabel">Impact</span>
        <div className="ps-matrix-grid">
          {matrix.map(row => (
            <div className="ps-matrix-row" key={row[0].i}>
              <span className="ps-matrix-tick">{row[0].i}</span>
              {row.map(cell => {
                const isActive = active && active.p === cell.p && active.i === cell.i;
                return (
                  <button
                    type="button"
                    key={cell.p}
                    className={`ps-cell${cell.value ? ' has' : ''}${isActive ? ' active' : ''}`}
                    style={{ '--band': BAND_VAR[bandOf(cell.score)] }}
                    onClick={() => cell.value && onPick(isActive ? null : { p: cell.p, i: cell.i })}
                    title={`P ${cell.p} × I ${cell.i} = ${cell.score} · ${cell.value} risk(s)`}
                    disabled={!cell.value}
                  >
                    {cell.value || ''}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="ps-matrix-row ps-matrix-xaxis">
            <span className="ps-matrix-tick" />
            {[1, 2, 3, 4, 5].map(p => <span className="ps-matrix-tick" key={p}>{p}</span>)}
          </div>
        </div>
      </div>
      <span className="ps-matrix-xlabel">Probability →</span>
      <ul className="ps-legend">
        {BANDS.map(b => (
          <li key={b}><i className="ps-legend-dot" style={{ background: BAND_VAR[b] }} />{BAND_LABEL[b]}</li>
        ))}
      </ul>
    </div>
  );
}

function GraphNode({ node, open, onToggle }) {
  return (
    <div className={`ps-gnode${open ? ' open' : ''}`}>
      <button type="button" className="ps-gnode-head" onClick={onToggle} aria-expanded={open}>
        <span className={`ps-sev ps-sev-${node.severity || 'watch'}`}>{SEVERITY_LABEL[node.severity] ?? '—'}</span>
        <span className="ps-gnode-id">{node.id}</span>
        <span className="ps-gnode-title" title={node.title}>{node.title}</span>
        {node.trend && (
          <span className={`ps-trend ps-trend-${node.trend}`} title={`Last review: ${TREND_LABEL[node.trend]}`}>
            {TREND_MARK[node.trend]} {TREND_LABEL[node.trend]}
          </span>
        )}
        <span className="ps-gnode-meta">
          {node.seen} review{node.seen === 1 ? '' : 's'} · last {fmtDate(node.last)}
        </span>
      </button>
      {open && (
        <div className="ps-gnode-body">
          {node.retro.map((r, idx) => (
            <div className="ps-retro" key={`${r.date}-${idx}`}>
              <span className="ps-retro-date">{fmtDate(r.date)}</span>
              <span className="ps-retro-text">
                {r.text}
                {r.links.map(l => (
                  <a key={l.url} className="ps-retro-link" href={l.url} target="_blank" rel="noreferrer">{l.label} ↗</a>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RisksView({ brain, onOpenMilestone }) {
  const rep = useMemo(() => buildRiskReport(brain), [brain]);
  const [cell,       setCell]       = useState(null);   // {p, i} from the matrix
  const [band,       setBand]       = useState(null);
  const [milestone,  setMilestone]  = useState(null);
  const [search,     setSearch]     = useState('');
  const [openNode,   setOpenNode]   = useState(null);
  const [graphOnlyActive, setGraphOnlyActive] = useState(true);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rep.risks.filter(r => {
      if (cell && !(r.p === cell.p && r.i === cell.i)) return false;
      if (band && r.band !== band) return false;
      if (milestone && r.milestone !== milestone) return false;
      if (q && !`${r.id} ${r.title} ${r.owner ?? ''} ${r.category ?? ''} ${r.milestone}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || String(a.id).localeCompare(String(b.id)));
  }, [rep.risks, cell, band, milestone, search]);

  const graphNodes = useMemo(() => {
    const list = graphOnlyActive ? rep.graph.filter(n => n.status === 'active') : rep.graph;
    const rank = { critical: 0, elevated: 1, watch: 2 };
    return [...list].sort((a, b) =>
      (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3)
      || String(b.last).localeCompare(String(a.last)));
  }, [rep.graph, graphOnlyActive]);

  const filtering = !!(cell || band || milestone || search.trim());
  const clear = () => { setCell(null); setBand(null); setMilestone(null); setSearch(''); };
  const k = rep.kpi;

  if (!rep.risks.length && !rep.graph.length && !rep.blockers.length) {
    return (
      <p className="ps-empty">
        No risk data in PM Brain for this project — expected
        {' '}<code>02_PROJECTS/{brain.vaultProject}/RBS.md</code> or nodes under
        {' '}<code>00_DASHBOARD/Risks/Risk Graph.md</code>.
      </p>
    );
  }

  return (
    <div className="ps-report">
      <div className="ps-kpis">
        <div className="ps-kpi ps-kpi-hero">
          <span className="ps-kpi-n">{k.critical + k.high}</span>
          <span className="ps-kpi-l">
            critical + high risks open<br />
            of {k.open} open ({k.total} in the register)
          </span>
        </div>
        <div className="ps-kpi"><span className="ps-kpi-n" style={{ color: BAND_VAR.critical }}>{k.critical}</span><span className="ps-kpi-l">critical (score ≥ 15)</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n" style={{ color: BAND_VAR.high }}>{k.high}</span><span className="ps-kpi-l">high (10–14)</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{k.realized}</span><span className="ps-kpi-l">realized</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{k.blockers}</span><span className="ps-kpi-l">active blockers</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{k.graphActive}</span><span className="ps-kpi-l">active risk-graph nodes</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{k.worsened}</span><span className="ps-kpi-l">worsened at last review</span></div>
        <div className="ps-kpi"><span className="ps-kpi-n">{fmtDate(k.lastReview)}</span><span className="ps-kpi-l">RBS last review{k.nextReview ? ` · next ${fmtDate(k.nextReview)}` : ''}</span></div>
      </div>

      <div className="ps-grid">
        <ChartCard
          title="Probability × Impact"
          hint="click a cell to filter"
          note="Open risks from the RBS register (closed ones excluded). Colour = band of the cell's score, number = how many risks sit there."
        >
          <RiskMatrix matrix={rep.matrix} onPick={setCell} active={cell} />
        </ChartCard>

        <ChartCard title="Open risks by band" hint="click a row to filter">
          <HBars rows={rep.charts.byBand} unit="risks" onPick={l => setBand(BANDS.find(b => BAND_LABEL[b] === l) ?? null)}
            activeLabel={band ? BAND_LABEL[band] : null} />
        </ChartCard>

        <ChartCard title="Register by status" hint="all rows, incl. closed">
          <HBars rows={rep.charts.byStatus} unit="risks" />
        </ChartCard>

        <ChartCard title="Open risks by RBS category">
          <HBars rows={rep.charts.byCategory} unit="risks" />
        </ChartCard>

        <ChartCard title="Open risks by milestone" hint="click a row to filter">
          <HBars rows={rep.charts.byMilestone} unit="risks" onPick={setMilestone} activeLabel={milestone} />
        </ChartCard>

        <ChartCard title="Open risks by owner">
          <HBars rows={rep.charts.byOwner} unit="risks" />
        </ChartCard>
      </div>

      {/* ── RBS register table ────────────────────────────────────────────── */}
      <ChartCard title="Risk register (RBS)" hint={`${rows.length} of ${rep.risks.length}`} wide>
        <div className="ps-table-bar">
          <input className="input ps-search" placeholder="Search risks: id, text, owner, category…"
            value={search} onChange={e => setSearch(e.target.value)} />
          {cell && <button type="button" className="ps-filter-chip" onClick={() => setCell(null)}>P{cell.p} × I{cell.i} ✕</button>}
          {band && <button type="button" className="ps-filter-chip" onClick={() => setBand(null)}>{BAND_LABEL[band]} ✕</button>}
          {milestone && <button type="button" className="ps-filter-chip" onClick={() => setMilestone(null)}>{milestone} ✕</button>}
          {filtering && <button type="button" className="ps-clear" onClick={clear}>clear filters</button>}
        </div>

        <div className="ps-table-scroll">
          <table className="ps-table ps-risk-table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Risk</th>
                <th>Milestone</th>
                <th>Category</th>
                <th className="ps-th-n">P</th>
                <th className="ps-th-n">I</th>
                <th className="ps-th-n">Score</th>
                <th>Response</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr className="ps-row" key={`${r.id ?? 'r'}-${r.milestone}-${idx}`}>
                  <td className="ps-td-az">{r.id ?? '—'}</td>
                  <td className="ps-td-risk"><span title={r.title}>{r.title}</span></td>
                  <td className="ps-td-ms">
                    {onOpenMilestone ? (
                      <button type="button" className="ps-link-btn" onClick={() => onOpenMilestone(r.milestone)}>{r.milestone}</button>
                    ) : r.milestone}
                  </td>
                  <td className="ps-td-cat">{r.category ?? '—'}</td>
                  <td className="ps-td-n">{r.p ?? '—'}</td>
                  <td className="ps-td-n">{r.i ?? '—'}</td>
                  <td className="ps-td-n"><BandChip band={r.band}>{r.score ?? '—'}</BandChip></td>
                  <td>{r.response ?? '—'}</td>
                  <td>{r.owner ?? '—'}</td>
                  <td><span className={`ps-rstatus ps-rstatus-${r.status}`}>{STATUS_LABEL[r.status]}</span></td>
                  <td className="ps-td-act">{fmtDate(r.reviewed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="ps-none">Nothing matches the current filters.</p>}
        </div>
      </ChartCard>

      {/* ── Canonical risk graph ──────────────────────────────────────────── */}
      <ChartCard
        title="Risk graph — canonical nodes with retrospective"
        hint={`${graphNodes.length} shown · ${rep.graph.length} total`}
        note="Built by the daily fathom-risk-review over call transcripts; each node keeps its own dated history, so the trend is the change since the previous review."
        wide
      >
        <div className="ps-table-bar">
          <label className="ps-toggle">
            <input type="checkbox" checked={graphOnlyActive} onChange={e => setGraphOnlyActive(e.target.checked)} />
            active only
          </label>
          <span className="ps-hint-inline">
            {rep.graph.filter(n => n.status === 'active' && daysAgo(n.last) > 21).length} node(s) not re-raised in 3+ weeks
          </span>
        </div>
        <div className="ps-gnodes">
          {graphNodes.map(n => (
            <GraphNode key={n.id} node={n} open={openNode === n.id}
              onToggle={() => setOpenNode(openNode === n.id ? null : n.id)} />
          ))}
          {!graphNodes.length && <p className="ps-none">No nodes for this project.</p>}
        </div>
      </ChartCard>

      {/* ── Active blockers ───────────────────────────────────────────────── */}
      <ChartCard title="Active blockers" hint={`${rep.blockers.length} blocking now`} wide>
        <div className="ps-table-scroll">
          <table className="ps-table">
            <thead>
              <tr>
                <th>Blocker</th>
                <th>Milestone</th>
                <th>Owner</th>
                <th>Since</th>
                <th>Impact</th>
                <th>Next step</th>
              </tr>
            </thead>
            <tbody>
              {rep.blockers.map((b, idx) => (
                <tr className="ps-row" key={idx}>
                  <td className="ps-td-risk">
                    {b.high && <span className="ps-band" style={{ '--band': BAND_VAR.critical }}>high</span>}{' '}
                    <span title={b.text}>{b.text}</span>
                  </td>
                  <td className="ps-td-ms">{b.milestone ?? '—'}</td>
                  <td>{b.owner ?? '—'}</td>
                  <td className="ps-td-act">
                    {fmtDate(b.since)}
                    {daysAgo(b.since) !== null && <span className="ps-since"> · {daysAgo(b.since)} d</span>}
                  </td>
                  <td className="ps-td-risk"><span title={b.impact}>{b.impact || '—'}</span></td>
                  <td className="ps-td-risk"><span title={b.nextStep}>{b.nextStep || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rep.blockers.length && <p className="ps-none">No active blockers recorded.</p>}
        </div>
      </ChartCard>
    </div>
  );
}
