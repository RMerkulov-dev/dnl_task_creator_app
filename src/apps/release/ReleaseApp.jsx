import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_LIST } from '../../config/projects.js';
import { getAreaPaths, getBoardWorkItems, getFields, setWorkItemField } from '../../services/azureDevops.js';

// The Release view is board-based: only projects that expose boards (area paths)
// qualify. ABS is the one today. Unlike the Status tab, every board is shown —
// the project's boardAllowList is intentionally ignored here.
const BOARD_PROJECTS = PROJECT_LIST.filter(p => p.features?.board);

// Resolve a field reference name by matching its display name against a set of
// substrings (all must be present, case-insensitive). When `dateOnly`, only
// dateTime fields qualify — the value we sort by must be a date, so a same-named
// text/flag field never shadows the real date field. Returns referenceName|null.
function pickField(fields, needles, dateOnly) {
  const hit = fields.find(f => {
    if (dateOnly && f.type !== 'dateTime') return false;
    const n = (f.name || '').toLowerCase();
    return needles.every(nd => n.includes(nd));
  });
  return hit?.referenceName || null;
}

// Board fields are named "Expected UAT/PROD …" (older projects may say "release"
// or "estimated"). Prefer a dateTime field with the specific pair, then loosen.
function detectField(fields, kind) {
  const alts = kind === 'prod' ? ['prod'] : ['uat', 'uet'];
  for (const dateOnly of [true, false]) {
    for (const kw of alts) {
      const hit = pickField(fields, ['expected', kw], dateOnly)
        || pickField(fields, ['release', kw], dateOnly)
        || pickField(fields, ['estimat', kw], dateOnly);
      if (hit) return hit;
    }
    for (const kw of alts) { const hit = pickField(fields, [kw], dateOnly); if (hit) return hit; }
  }
  return '';
}

// How many of the loaded items have a non-empty value for a field reference.
function fillCount(list, ref) {
  if (!ref) return 0;
  let n = 0;
  for (const it of list) { const v = it.fields?.[ref]; if (v != null && v !== '') n++; }
  return n;
}

// After loading, if the chosen field holds no data, switch to the name-matching
// candidate that actually has the most values — fixes wrong auto-detection when
// several similarly-named fields exist. Keeps the current field if it has data.
function refineField(list, candidates, kind, current) {
  if (fillCount(list, current) > 0) return current;
  const alts = kind === 'prod' ? ['prod'] : ['uat', 'uet'];
  let best = '', bestFill = 0;
  for (const c of candidates) {
    const n = c.name.toLowerCase();
    if (!alts.some(a => n.includes(a))) continue;
    const f = fillCount(list, c.ref);
    if (f > bestFill) { bestFill = f; best = c.ref; }
  }
  return best || current;
}

// Parse an Azure dateTime field value to a timestamp (or null), plus a short
// display / <input type=date> string (YYYY-MM-DD). Azure returns ISO strings.
function parseDate(value) {
  if (!value) return { ts: null, label: '' };
  const t = Date.parse(value);
  if (Number.isNaN(t)) return { ts: null, label: '' };
  const d = new Date(t);
  const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { ts: t, label };
}

function typeTone(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('epic')) return 'epic';
  if (t.includes('story')) return 'story';
  if (t.includes('bug')) return 'bug';
  return 'task';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const keyOfDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Build a GitHub-style week grid spanning [min,max], padded to whole Mon–Sun
// weeks. Returns an array of weeks, each an array of 7 Date objects.
function buildWeeks(minKey, maxKey) {
  const start = new Date(`${minKey}T00:00:00`);
  const end   = new Date(`${maxKey}T00:00:00`);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));       // back to Monday
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));       // forward to Sunday
  const weeks = [];
  const cur = new Date(start);
  while (cur <= end) {
    const week = [];
    for (let i = 0; i < 7; i++) { week.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    weeks.push(week);
  }
  return weeks;
}

function Chevron() {
  return (
    <svg className="rel-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

export default function ReleaseApp({ allowedProjects }) {
  const projects = useMemo(() => (
    allowedProjects?.length
      ? BOARD_PROJECTS.filter(p => allowedProjects.includes(p.id))
      : BOARD_PROJECTS
  ), [allowedProjects]);

  const [proj, setProj] = useState(projects[0] ?? null);

  const [boards, setBoards]               = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState('');

  const [fields, setFields]       = useState([]);
  const [prodField, setProdField] = useState('');
  const [uatField,  setUatField]  = useState('');

  const [items,   setItems]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [loaded,  setLoaded]  = useState(false);
  const [error,   setError]   = useState('');
  const [query,   setQuery]   = useState('');

  const [reportOpen, setReportOpen] = useState(false);
  const [metric,     setMetric]     = useState('prod');   // 'prod' | 'uat'
  const [filtersOpen, setFiltersOpen] = useState(true);

  // Inline-edit bookkeeping: which "<id>:<uat|prod>" cells are saving / errored.
  const [saving, setSaving] = useState(() => new Set());
  const [errs,   setErrs]   = useState({});

  // ── On project change: load boards + field catalogue, auto-detect fields ────
  useEffect(() => {
    setBoards([]); setSelectedBoard(''); setItems([]); setLoaded(false); setError(''); setQuery('');
    setFields([]); setProdField(''); setUatField(''); setSaving(new Set()); setErrs({});
    if (!proj) return;
    let cancelled = false;

    setBoardsLoading(true);
    getAreaPaths(proj.azure.proxyKey, proj.azure.project)
      .then(all => { if (!cancelled) setBoards(all); })
      .catch(e => !cancelled && setError(e.message))
      .finally(() => !cancelled && setBoardsLoading(false));

    getFields(proj.azure.proxyKey, proj.azure.project)
      .then(list => {
        if (cancelled) return;
        setFields(list);
        setProdField(detectField(list, 'prod'));
        setUatField(detectField(list, 'uat'));
      })
      .catch(() => { /* non-fatal — user can still pick fields manually */ });

    return () => { cancelled = true; };
  }, [proj]);

  const candidateFields = useMemo(() => (
    fields
      .filter(f => f.type === 'dateTime' || /release|expected/i.test(f.name))
      .map(f => ({ ref: f.referenceName, name: f.name }))
      .sort((a, b) => a.name.localeCompare(b.name))
  ), [fields]);

  // ── Load the board's work items ────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!proj || !selectedBoard) { setError('Select a board first.'); return; }
    setLoading(true); setError(''); setErrs({});
    try {
      const list = await getBoardWorkItems(
        proj.azure.proxyKey,
        proj.azure.project,
        proj.azure.jiraIdField,
        selectedBoard,
        null,
      );
      setItems(list);
      setLoaded(true);
      // If auto-detected fields hold no data on this board, re-pick by fill count.
      setProdField(prev => refineField(list, candidateFields, 'prod', prev));
      setUatField(prev => refineField(list, candidateFields, 'uat', prev));
    } catch (e) {
      setError(e.message || 'Failed to load work items.');
    } finally {
      setLoading(false);
    }
  }, [proj, selectedBoard, candidateFields]);

  // How many loaded items have each candidate field set — surfaced in the field
  // pickers so it's obvious which field actually holds the release dates.
  const fieldFill = useMemo(() => {
    const m = new Map();
    for (const c of candidateFields) m.set(c.ref, fillCount(items, c.ref));
    return m;
  }, [items, candidateFields]);

  // ── Inline date edit → PATCH Azure → optimistic update ─────────────────────
  const setDate = useCallback(async (item, which, value) => {
    const ref = which === 'prod' ? prodField : uatField;
    if (!ref) return;
    const cellKey = `${item.id}:${which}`;
    const iso = value ? `${value}T00:00:00Z` : null;
    setSaving(s => new Set(s).add(cellKey));
    setErrs(e => { const n = { ...e }; delete n[cellKey]; return n; });
    try {
      await setWorkItemField(proj.azure.proxyKey, proj.azure.project, item.id, ref, iso);
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, fields: { ...i.fields, [ref]: iso } } : i)));
    } catch (err) {
      setErrs(e => ({ ...e, [cellKey]: err.message || 'Failed to save' }));
    } finally {
      setSaving(s => { const n = new Set(s); n.delete(cellKey); return n; });
    }
  }, [proj, prodField, uatField]);

  // ── Search, then split into 3 mutually-exclusive sections ──────────────────
  // PROD-dated wins over UAT-only, so every item shows exactly once.
  const { uatRows, prodRows, noneRows } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = items
      .filter(it => !q
        || String(it.id).includes(q)
        || (it.title || '').toLowerCase().includes(q)
        || (it.jiraKey || '').toLowerCase().includes(q))
      .map(it => ({
        it,
        uat:  parseDate(uatField  ? it.fields?.[uatField]  : null),
        prod: parseDate(prodField ? it.fields?.[prodField] : null),
      }));
    const byId = (a, b) => a.it.id - b.it.id;
    return {
      prodRows: rows.filter(r => r.prod.ts != null).sort(byId),
      uatRows:  rows.filter(r => r.prod.ts == null && r.uat.ts != null).sort(byId),
      noneRows: rows.filter(r => r.prod.ts == null && r.uat.ts == null).sort(byId),
    };
  }, [items, query, uatField, prodField]);

  const total = uatRows.length + prodRows.length + noneRows.length;
  const prodName = fields.find(f => f.referenceName === prodField)?.name || 'Expected PROD';
  const uatName  = fields.find(f => f.referenceName === uatField)?.name  || 'Expected UAT';

  // ── Report calendar: count items per release day for the chosen metric ──────
  const report = useMemo(() => {
    const field = metric === 'prod' ? prodField : uatField;
    const map = new Map();   // 'YYYY-MM-DD' → [ "#id ABS-key" … ]
    for (const it of items) {
      const d = parseDate(field ? it.fields?.[field] : null);
      if (d.ts == null) continue;
      const arr = map.get(d.label) || [];
      arr.push(`#${it.id}${it.jiraKey ? ` · ${it.jiraKey}` : ''}${it.title ? ` — ${it.title}` : ''}`);
      map.set(d.label, arr);
    }
    if (map.size === 0) return { weeks: [], map, max: 0, total: 0 };
    const keys = [...map.keys()].sort();
    const weeks = buildWeeks(keys[0], keys[keys.length - 1]);
    const max = Math.max(...[...map.values()].map(a => a.length));
    const totalItems = [...map.values()].reduce((s, a) => s + a.length, 0);
    return { weeks, map, max, total: totalItems };
  }, [items, metric, prodField, uatField]);

  const levelOf = (n) => {
    if (!n) return 0;
    const m = report.max || 1;
    if (n >= m) return 4;
    if (n >= m * 0.66) return 3;
    if (n >= m * 0.33) return 2;
    return 1;
  };

  // A single editable date cell (label + native date input + status).
  function dateCell(it, which, d, ref) {
    const cellKey = `${it.id}:${which}`;
    const isSaving = saving.has(cellKey);
    const err = errs[cellKey];
    return (
      <div className={`rel-datecell rel-datecell-${which}`}>
        <span className="rel-datecell-label">{which === 'prod' ? 'PROD' : 'UAT'}</span>
        <input
          type="date"
          className={`input rel-date-input${d.ts != null ? ' filled' : ''}`}
          value={d.label}
          disabled={!ref || isSaving}
          onChange={e => setDate(it, which, e.target.value)}
        />
        {isSaving && <span className="spinner" style={{ width: 13, height: 13 }} />}
        {d.label && !isSaving && (
          <button type="button" className="rel-clear" title="Clear date" onClick={() => setDate(it, which, '')}>✕</button>
        )}
        {err && <span className="rel-cell-err" title={err}>⚠</span>}
      </div>
    );
  }

  function row(r) {
    const { it } = r;
    return (
      <div key={it.id} className="rel-row">
        <div className="rel-row-main">
          <span className={`rel-type rel-type-${typeTone(it.type)}`}>{it.type || '—'}</span>
          {it.url
            ? <a className="rel-id" href={it.url} target="_blank" rel="noreferrer">#{it.id}</a>
            : <span className="rel-id">#{it.id}</span>}
          {it.jiraKey ? (
            <a
              className="rel-jira"
              href={`https://dynamicalabs.atlassian.net/browse/${it.jiraKey}`}
              target="_blank" rel="noreferrer" title="Open in Jira"
            >{it.jiraKey}</a>
          ) : (
            <span className="rel-jira rel-jira-none">—</span>
          )}
          <span className="rel-row-title" title={it.title}>{it.title}</span>
        </div>
        <div className="rel-row-edit">
          {dateCell(it, 'uat',  r.uat,  uatField)}
          {dateCell(it, 'prod', r.prod, prodField)}
        </div>
      </div>
    );
  }

  function section(key, tone, title, rows, defaultOpen) {
    return (
      <details className={`rel-section rel-section-${tone}`} open={defaultOpen} key={key}>
        <summary className="rel-section-head">
          <span className="rel-section-title">{title}</span>
          <span className="rel-section-right">
            <span className="rel-section-count">{rows.length}</span>
            <Chevron />
          </span>
        </summary>
        <div className="rel-section-body">
          {rows.length === 0
            ? <div className="rel-section-empty">Nothing here.</div>
            : rows.map(row)}
        </div>
      </details>
    );
  }

  return (
    <div className="rel">
      <div className="rel-head">
        <h2 className="rel-title">Release</h2>
        <p className="rel-sub">
          Pick an ABS board, then set each item's Expected UAT / PROD release date. Items are
          grouped into collapsible sections — edits save straight back to the board.
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="rel-empty">No board-based projects are available to you.</div>
      ) : (
      <div className={`rel-grid${filtersOpen ? '' : ' rel-grid-collapsed'}`}>
        {/* ── Left: board + field selection (collapsible) ── */}
        <div className={`rel-panel rel-filters${filtersOpen ? '' : ' collapsed'}`}>
          <button
            type="button"
            className="rel-filters-toggle"
            onClick={() => setFiltersOpen(o => !o)}
            title={filtersOpen ? 'Collapse filters' : 'Expand filters'}
          >
            <svg className="rel-filters-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span className="rel-filters-label">Board &amp; fields</span>
          </button>

          {filtersOpen && (
            <div className="rel-filters-body">
              <label className="rel-label">Project</label>
              <select
                className="select"
                value={proj?.id ?? ''}
                onChange={e => setProj(projects.find(p => p.id === e.target.value))}
              >
                {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>

              <label className="rel-label" style={{ marginTop: 16 }}>Board</label>
              <select
                className="select"
                value={selectedBoard}
                onChange={e => setSelectedBoard(e.target.value)}
                disabled={boardsLoading || !boards.length}
              >
                <option value="">{boardsLoading ? 'Loading boards…' : '— Select board —'}</option>
                {boards.map(b => <option key={b.path} value={b.path}>{b.name}</option>)}
              </select>

              <button
                className="btn btn-primary rel-load"
                onClick={load}
                disabled={loading || !selectedBoard}
              >
                {loading ? <><span className="spinner" /> Loading…</> : (loaded ? 'Reload' : 'Load board')}
              </button>

              <div className="rel-divider" />

              <label className="rel-label">Expected PROD field</label>
              <select className="select" value={prodField} onChange={e => setProdField(e.target.value)}>
                <option value="">— none —</option>
                {candidateFields.map(f => {
                  const n = fieldFill.get(f.ref);
                  return <option key={f.ref} value={f.ref}>{f.name}{n ? ` · ${n} set` : ''}</option>;
                })}
              </select>

              <label className="rel-label" style={{ marginTop: 12 }}>Expected UAT field</label>
              <select className="select" value={uatField} onChange={e => setUatField(e.target.value)}>
                <option value="">— none —</option>
                {candidateFields.map(f => {
                  const n = fieldFill.get(f.ref);
                  return <option key={f.ref} value={f.ref}>{f.name}{n ? ` · ${n} set` : ''}</option>;
                })}
              </select>

              {error && <div className="rel-error">{error}</div>}
            </div>
          )}
        </div>

        {/* ── Right: collapsible sections ── */}
        <div className="rel-panel rel-listwrap">
          {!loaded && !loading && (
            <div className="rel-empty">Load a board to edit release dates.</div>
          )}
          {loading && <div className="rel-empty"><span className="spinner spinner-lg" /></div>}
          {loaded && !loading && items.length === 0 && (
            <div className="rel-empty">No work items on this board.</div>
          )}

          {loaded && !loading && items.length > 0 && (
            <>
              <div className="rel-toolbar">
                <input
                  className="input rel-search"
                  placeholder="Search by number or title…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                {query && <span className="rel-search-count">{total} / {items.length}</span>}
                <button type="button" className="btn btn-ghost rel-report-btn" onClick={() => setReportOpen(true)}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                    <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="1.8"/>
                    <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  </svg>
                  Report
                </button>
              </div>
              {query && total === 0 ? (
                <div className="rel-empty">Nothing matches “{query}”.</div>
              ) : (
                <>
                  {section('uat',  'uat',  `UAT — ${uatName}`,   uatRows,  true)}
                  {section('prod', 'prod', `PROD — ${prodName}`, prodRows, true)}
                  {section('none', 'none', 'Unmarked',           noneRows, false)}
                </>
              )}
            </>
          )}
        </div>
      </div>
      )}

      {reportOpen && createPortal(
        <div className="rel-modal-backdrop" onClick={() => setReportOpen(false)}>
          <div className={`rel-modal rel-cal-${metric}`} onClick={e => e.stopPropagation()}>
            <div className="rel-modal-head">
              <div>
                <h3 className="rel-modal-title">Release calendar</h3>
                <p className="rel-modal-sub">
                  {report.total} item{report.total === 1 ? '' : 's'} scheduled by {metric === 'prod' ? prodName : uatName}
                </p>
              </div>
              <div className="rel-modal-tools">
                <div className="rel-metric-toggle">
                  <button className={metric === 'uat'  ? 'active' : ''} onClick={() => setMetric('uat')}>UAT</button>
                  <button className={metric === 'prod' ? 'active' : ''} onClick={() => setMetric('prod')}>PROD</button>
                </div>
                <button className="rel-modal-close" onClick={() => setReportOpen(false)} aria-label="Close">✕</button>
              </div>
            </div>

            <div className="rel-modal-body">
              {report.weeks.length === 0 ? (
                <div className="rel-empty">No {metric === 'prod' ? 'PROD' : 'UAT'} release dates set.</div>
              ) : (
                <div className="rel-cal">
                  {/* Month labels aligned to week columns */}
                  <div className="rel-cal-monthrow">
                    <div className="rel-cal-daycol-spacer" />
                    {report.weeks.map((w, i) => {
                      const first = w[0];
                      const prev = i > 0 ? report.weeks[i - 1][0] : null;
                      const show = !prev || prev.getMonth() !== first.getMonth();
                      return (
                        <div key={i} className="rel-cal-monthcell">
                          {show ? `${MONTHS[first.getMonth()]}${first.getMonth() === 0 ? ` '${String(first.getFullYear()).slice(2)}` : ''}` : ''}
                        </div>
                      );
                    })}
                  </div>

                  <div className="rel-cal-body">
                    <div className="rel-cal-daycol">
                      {['', 'Mon', '', 'Wed', '', 'Fri', ''].map((l, i) => <span key={i}>{l}</span>)}
                    </div>
                    <div className="rel-cal-weeks">
                      {report.weeks.map((week, wi) => (
                        <div key={wi} className="rel-cal-week">
                          {week.map((day, di) => {
                            const k = keyOfDate(day);
                            const list = report.map.get(k) || [];
                            const lvl = levelOf(list.length);
                            return (
                              <div
                                key={di}
                                className={`rel-cal-cell lvl-${lvl}`}
                                title={list.length ? `${k} — ${list.length} item${list.length === 1 ? '' : 's'}\n${list.slice(0, 12).join('\n')}${list.length > 12 ? '\n…' : ''}` : k}
                              >
                                <span className="rel-cal-daynum">{day.getDate()}</span>
                                {list.length > 0 && <span className="rel-cal-count">{list.length}</span>}
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rel-cal-legend">
                    <span>Less</span>
                    {[0, 1, 2, 3, 4].map(l => <span key={l} className={`rel-cal-cell lvl-${l}`} />)}
                    <span>More</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
