import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { PROJECT_LIST } from '../../config/projects.js';
import { getAreaPaths, getBoardWorkItems, getFields, setWorkItemField } from '../../services/azureDevops.js';

// The Release view is board-based: only projects that expose boards (area paths)
// qualify. ABS is the one today. Unlike the Status tab, every board is shown —
// the project's boardAllowList is intentionally ignored here.
const BOARD_PROJECTS = PROJECT_LIST.filter(p => p.features?.board);

// Finished work is irrelevant to a release plan — hide these terminal states everywhere.
const EXCLUDED_STATES = new Set(['done', 'closed', 'resolved', 'removed', 'cancelled', 'completed']);

// Per-field calendar exclusions: a "Testing in <phase>" state means that phase's
// milestone has already been reached, so the item shouldn't clutter that phase's
// chip on the Report timeline. Testing-in-Prod also implies UAT is long past.
const PROD_DONE_STATES = new Set(['testing in prod']);
const UAT_DONE_STATES  = new Set(['testing in uat', 'testing in prod']);

const MONTHS   = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const keyOfDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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
  return { ts: t, label: keyOfDate(d) };
}

function typeTone(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('epic')) return 'epic';
  if (t.includes('story')) return 'story';
  if (t.includes('bug')) return 'bug';
  return 'task';
}

// Whole Mon–Sun weeks covering a given month.
function monthDays(first) {
  const y = first.getFullYear(), m = first.getMonth();
  const start = new Date(y, m, 1);
  start.setDate(1 - ((start.getDay() + 6) % 7));         // back to Monday
  const last = new Date(y, m + 1, 0);
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - ((end.getDay() + 6) % 7)));  // forward to Sunday
  const days = [];
  const cur = new Date(start);
  while (cur <= end) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
  return days;
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

  const [mode, setMode]           = useState('report');  // 'edit' | 'report'
  const [calFilter, setCalFilter] = useState('all');     // 'all' | 'uat' | 'prod'
  const [focusKey, setFocusKey]   = useState(null);      // 'YYYY-M' of a month opened fullscreen

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
      .then(all => {
        if (cancelled) return;
        const allow = proj.boardAllowList;
        setBoards(allow?.length ? all.filter(b => allow.includes(b.name)) : all);
      })
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
        proj.azure.proxyKey, proj.azure.project, proj.azure.jiraIdField, selectedBoard, null,
      );
      setItems(list);
      setLoaded(true);
      setProdField(prev => refineField(list, candidateFields, 'prod', prev));
      setUatField(prev => refineField(list, candidateFields, 'uat', prev));
    } catch (e) {
      setError(e.message || 'Failed to load work items.');
    } finally {
      setLoading(false);
    }
  }, [proj, selectedBoard, candidateFields]);

  const fieldFill = useMemo(() => {
    const m = new Map();
    for (const c of candidateFields) m.set(c.ref, fillCount(items, c.ref));
    return m;
  }, [items, candidateFields]);

  // Hide finished work from both the edit lists and the calendar.
  const visibleItems = useMemo(
    () => items.filter(it => !EXCLUDED_STATES.has((it.state || '').trim().toLowerCase())),
    [items],
  );

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

  // ── Edit mode: 3 mutually-exclusive sections ───────────────────────────────
  const { uatRows, prodRows, noneRows } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = visibleItems
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
  }, [visibleItems, query, uatField, prodField]);

  const total = uatRows.length + prodRows.length + noneRows.length;
  const prodName = fields.find(f => f.referenceName === prodField)?.name || 'Expected PROD';
  const uatName  = fields.find(f => f.referenceName === uatField)?.name  || 'Expected UAT';

  // ── Report mode: events per day + the months to render ─────────────────────
  const calendar = useMemo(() => {
    const byDay = new Map();   // 'YYYY-MM-DD' → [{ kind, it }]
    const push = (key, kind, it) => { const a = byDay.get(key) || byDay.set(key, []).get(key); a.push({ kind, it }); };
    // One entry per item, no duplicates: use PROD (the final date) when set,
    // otherwise fall back to the UAT date.
    for (const it of visibleItems) {
      const state = (it.state || '').trim().toLowerCase();
      const u = parseDate(uatField  ? it.fields?.[uatField]  : null);
      const p = parseDate(prodField ? it.fields?.[prodField] : null);
      // Drop the item from a phase's chip once that phase's milestone is reached
      // (Testing in Prod/UAT) — a shipped release shouldn't clutter the timeline.
      if (p.ts != null) { if (!PROD_DONE_STATES.has(state)) push(p.label, 'prod', it); }
      else if (u.ts != null) { if (!UAT_DONE_STATES.has(state)) push(u.label, 'uat', it); }
    }
    if (byDay.size === 0) return { months: [], byDay };
    const keys = [...byDay.keys()].sort();
    const min = new Date(`${keys[0]}T00:00:00`);
    const max = new Date(`${keys[keys.length - 1]}T00:00:00`);
    const months = [];
    const cur = new Date(min.getFullYear(), min.getMonth(), 1);
    const end = new Date(max.getFullYear(), max.getMonth(), 1);
    while (cur <= end) { months.push(new Date(cur)); cur.setMonth(cur.getMonth() + 1); }
    return { months, byDay };
  }, [visibleItems, uatField, prodField]);

  const dayEvents = useCallback((key) => {
    const all = calendar.byDay.get(key) || [];
    return calFilter === 'all' ? all : all.filter(e => e.kind === calFilter);
  }, [calendar, calFilter]);

  function switchMode(m) { setMode(m); }

  // ── Edit-mode row helpers ──────────────────────────────────────────────────
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
            <a className="rel-jira" href={`https://dynamicalabs.atlassian.net/browse/${it.jiraKey}`} target="_blank" rel="noreferrer" title="Open in Jira">{it.jiraKey}</a>
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
            <svg className="rel-section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </span>
        </summary>
        <div className="rel-section-body">
          {rows.length === 0 ? <div className="rel-section-empty">Nothing here.</div> : rows.map(row)}
        </div>
      </details>
    );
  }

  // ── Report-mode month renderer ─────────────────────────────────────────────
  const todayKey = keyOfDate(new Date());
  function monthCard(first, focus = false) {
    const y = first.getFullYear(), m = first.getMonth();
    const mkey = `${y}-${m}`;
    const days = monthDays(first);
    // In fullscreen focus every event is shown; in the grid we cap to keep cells tidy.
    const cap = focus ? Infinity : 8;
    return (
      <div key={mkey} className={`rel-mon${focus ? ' rel-mon-focus' : ''}`}>
        {focus ? (
          <div className="rel-mon-head">
            <span className="rel-mon-name">{MONTHS[m]} {y}</span>
            <button type="button" className="rel-mon-btn" title="Close (Esc)" onClick={() => setFocusKey(null)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6L18 18M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
              <span>Close</span>
            </button>
          </div>
        ) : (
          // Whole header is the expand affordance — click anywhere on it to open
          // this month fullscreen.
          <button type="button" className="rel-mon-head rel-mon-head-btn" title="Click to expand this month" onClick={() => setFocusKey(mkey)}>
            <span className="rel-mon-name">{MONTHS[m]} {y}</span>
            <span className="rel-mon-expand">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 4H4V9M20 9V4H15M15 20H20V15M4 15V20H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span>Expand</span>
            </span>
          </button>
        )}
        <div className="rel-mon-dows">
          {WEEKDAYS.map(w => <div key={w} className="rel-mon-dow">{w}</div>)}
        </div>
        <div className="rel-mon-grid">
          {days.map((day, i) => {
            const key = keyOfDate(day);
            const evs = day.getMonth() === m ? dayEvents(key) : [];
            const outside = day.getMonth() !== m;
            const shown = evs.slice(0, cap);
            return (
              <div key={i} className={`rel-mon-cell${outside ? ' outside' : ''}${key === todayKey ? ' today' : ''}`}>
                <div className="rel-mon-daynum">{day.getDate()}</div>
                {shown.map((e, j) => (
                  <a
                    key={j}
                    className={`rel-ev rel-ev-${e.kind}`}
                    href={e.it.url || undefined}
                    target="_blank" rel="noreferrer"
                    title={`${e.kind.toUpperCase()} · #${e.it.id}${e.it.jiraKey ? ` · ${e.it.jiraKey}` : ''}\n${e.it.title || ''}`}
                  >
                    <span className="rel-ev-id">#{e.it.id}</span>
                    <span className="rel-ev-title">{e.it.title || `#${e.it.id}`}</span>
                  </a>
                ))}
                {evs.length > shown.length && <div className="rel-mon-more">+{evs.length - shown.length} more</div>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const focusMonth = useMemo(
    () => (focusKey ? calendar.months.find(first => `${first.getFullYear()}-${first.getMonth()}` === focusKey) : null),
    [focusKey, calendar.months],
  );

  // Esc closes the fullscreen month.
  useEffect(() => {
    if (!focusMonth) return;
    const onKey = (e) => { if (e.key === 'Escape') setFocusKey(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusMonth]);

  const ModeSwitch = (
    <div className="rel-modeswitch" role="tablist">
      <button role="tab" aria-selected={mode === 'edit'}   className={mode === 'edit'   ? 'active' : ''} onClick={() => switchMode('edit')}>Edit</button>
      <button role="tab" aria-selected={mode === 'report'} className={mode === 'report' ? 'active' : ''} onClick={() => switchMode('report')}>Report</button>
    </div>
  );

  return (
    <div className="rel">
      <div className="rel-head">
        <h2 className="rel-title">Release</h2>
        <p className="rel-sub">
          Pick an ABS board, then set each item's Expected UAT / PROD release date. Switch to
          Report for a full calendar of what ships when.
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="rel-empty">No board-based projects are available to you.</div>
      ) : (
      <>
        {/* ── Top: board + field selection ── */}
        <div className="rel-topbar">
          <div className="rel-field rel-field-proj">
            <label className="rel-label">Project</label>
            <select className="select" value={proj?.id ?? ''} onChange={e => setProj(projects.find(p => p.id === e.target.value))}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="rel-field rel-field-board">
            <label className="rel-label">Board</label>
            <select className="select" value={selectedBoard} onChange={e => setSelectedBoard(e.target.value)} disabled={boardsLoading || !boards.length}>
              <option value="">{boardsLoading ? 'Loading boards…' : '— Select board —'}</option>
              {boards.map(b => <option key={b.path} value={b.path}>{b.name}</option>)}
            </select>
          </div>
          <button className="btn btn-primary rel-load-top" onClick={load} disabled={loading || !selectedBoard}>
            {loading ? <><span className="spinner" /> …</> : (loaded ? 'Reload' : 'Load')}
          </button>

          <div className="rel-topbar-right">
            {loaded && items.length > 0 && mode === 'report' && (
              <div className="rel-metric-toggle rel-cal-mixed">
                <button className={calFilter === 'all'  ? 'active' : ''} onClick={() => setCalFilter('all')}>All</button>
                <button className={calFilter === 'uat'  ? 'active' : ''} onClick={() => setCalFilter('uat')}>UAT</button>
                <button className={calFilter === 'prod' ? 'active' : ''} onClick={() => setCalFilter('prod')}>PROD</button>
              </div>
            )}
            {ModeSwitch}
          </div>
        </div>
        {error && <div className="rel-error" style={{ marginBottom: 12 }}>{error}</div>}

        {/* ── Content: Edit sections or Report calendar ── */}
        <div className="rel-panel rel-listwrap rel-content">
          {!loaded && !loading && <div className="rel-empty">Load a board to edit release dates.</div>}
          {loading && <div className="rel-empty"><span className="spinner spinner-lg" /></div>}
          {loaded && !loading && items.length === 0 && <div className="rel-empty">No work items on this board.</div>}

          {loaded && !loading && items.length > 0 && (
            <>
              {mode === 'edit' && (
                <div className="rel-toolbar">
                  <input className="input rel-search" placeholder="Search by number or title…" value={query} onChange={e => setQuery(e.target.value)} />
                  {query && <span className="rel-search-count">{total} / {visibleItems.length}</span>}
                </div>
              )}

              {mode === 'edit' ? (
                query && total === 0 ? (
                  <div className="rel-empty">Nothing matches “{query}”.</div>
                ) : (
                  <>
                    {section('uat',  'uat',  `UAT — ${uatName}`,   uatRows,  true)}
                    {section('prod', 'prod', `PROD — ${prodName}`, prodRows, true)}
                    {section('none', 'none', 'Unmarked',           noneRows, false)}
                  </>
                )
              ) : (
                calendar.months.length === 0 ? (
                  <div className="rel-empty">No release dates set — add some in Edit mode.</div>
                ) : (
                  <div className="rel-cal2">
                    {calendar.months.map(first => monthCard(first))}
                  </div>
                )
              )}
            </>
          )}
        </div>
      </>
      )}

      {focusMonth && createPortal(
        <div className="rel-mon-overlay" onClick={() => setFocusKey(null)}>
          <div className="rel-mon-focus-wrap" onClick={e => e.stopPropagation()}>
            {monthCard(focusMonth, true)}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
