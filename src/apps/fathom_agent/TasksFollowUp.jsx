import { useState, useEffect, useCallback, useMemo } from 'react';
import TaskCreateModal from '../../components/TaskCreateModal.jsx';
import AddToParentModal, { CreateTargetChoice } from '../../components/AddToParentModal.jsx';
import SaveToVaultModal from './SaveToVaultModal.jsx';

// ─── Skill output parser ──────────────────────────────────────────────────────
// Turns the strict "Tasks Follow-Up" markdown into structured task objects so we
// can render one block per task with its own "Create Task" button. Tolerant of
// minor formatting drift; if nothing parses we fall back to showing raw text.
export function parseSkillOutput(md) {
  const empty = { analysis: '', tasks: [], urgent: '', backlog: '', hasStructure: false };
  if (!md) return empty;

  const analysis = (md.match(/\*\*\s*Cloud Skill Analysis\s*\*\*\s*([\s\S]*?)(?=\n\s*---|\n\s*\*\*\s*Task)/i)?.[1] || '').trim();

  const tasks = [];
  const taskRe = /\*\*\s*Task\s*#?\s*(\d+)\s*\*\*([\s\S]*?)(?=\*\*\s*Task\s*#?\s*\d+\s*\*\*|\*\*\s*Urgent Items|\*\*\s*Backlog Recommendations|$)/gi;
  let m;
  while ((m = taskRe.exec(md)) !== null) {
    const body = m[2];
    const field = label => {
      const re = new RegExp(`\\*\\*\\s*${label}\\s*:?\\s*\\*\\*\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|\\n\\s*---|$)`, 'i');
      return (body.match(re)?.[1] || '').trim();
    };
    const task = {
      n:           m[1],
      title:       field('Task Title'),
      description: field('Task Description'),
      priority:    field('Priority'),
      who:         field('Who'),
      link:        field('Fathom Link'),
    };
    if (task.title || task.description) tasks.push(task);
  }

  const urgent  = (md.match(/\*\*\s*Urgent Items Summary\s*\*\*\s*([\s\S]*?)(?=\*\*\s*Backlog Recommendations|\*\*\s*Task|$)/i)?.[1] || '').trim();
  const backlog = (md.match(/\*\*\s*Backlog Recommendations\s*\*\*\s*([\s\S]*?)$/i)?.[1] || '').trim();

  return { analysis, tasks, urgent, backlog, hasStructure: tasks.length > 0 };
}

export function priorityClass(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('urgent')) return 'tf-pri tf-pri-urgent';
  if (s.includes('high'))   return 'tf-pri tf-pri-high';
  if (s.includes('backlog')) return 'tf-pri tf-pri-backlog';
  return 'tf-pri tf-pri-medium';
}

// Render a "Fathom Link" field value that may be a markdown link, bare URL, or text.
function FathomLinkValue({ value }) {
  if (!value || /not provided/i.test(value)) return <span className="tf-task-dim">Not provided</span>;
  const mdLink = value.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (mdLink) return <a className="ba-issue-link" href={mdLink[2]} target="_blank" rel="noreferrer">{mdLink[1]} ↗</a>;
  const url = value.match(/https?:\/\/\S+/);
  if (url) return <a className="ba-issue-link" href={url[0]} target="_blank" rel="noreferrer">open ↗</a>;
  return <span>{value}</span>;
}

// ─── Tasks Follow-up tab ──────────────────────────────────────────────────────
//
// Layout: a compact controls bar on top (date range + My/Team scope + Load),
// then a two-column working area — call list on the left, skill picker + result
// on the right. Each column scrolls on its own so the page itself never scrolls.

function fmtDate(d) {
  // Local YYYY-MM-DD (what <input type="date"> expects/returns).
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Derive a short group label from a call title — the leading token before the
// first separator (period/colon/space), sans trailing punctuation. Titles here
// follow a "PREFIX. Rest" pattern (ABS, NSMG, WS, HT, ABS-DNL…), so this buckets
// them cleanly. Empty/odd titles fall back to "Other".
function callGroup(title) {
  const first = (title || '').trim().split(/[\s.:]+/)[0] || '';
  const g = first.replace(/[^A-Za-z0-9-]+$/, '').toUpperCase();
  return g || 'Other';
}

// Secondary label used to filter *within* a group: strip the leading group token
// (e.g. "ABS", "ABS-DNL") and its separator, then take the text up to the next
// period/colon. Works for both "ABS. Marketing migration. Weekly Call" →
// "Marketing migration" and period-less titles like "ABS Bureau and Group Only" →
// "Bureau and Group Only". Empty when nothing is left after the prefix.
function callSubGroup(title) {
  const t = (title || '').trim();
  if (!t) return '';
  const rest = t.replace(/^[A-Za-z0-9-]+\s*[.:]?\s*/, '');   // drop "ABS" / "ABS." / "ABS-DNL "
  return rest.split(/[.:]/)[0].trim();
}

const PRESETS = [
  { id: 'today', label: 'Today',     start: () => fmtDate(new Date()),  end: () => fmtDate(new Date()) },
  { id: '7d',    label: 'Last 7 days',  start: () => fmtDate(daysAgo(7)),  end: () => fmtDate(new Date()) },
  { id: '30d',   label: 'Last 30 days', start: () => fmtDate(daysAgo(30)), end: () => fmtDate(new Date()) },
];

export default function TasksFollowUp({ user, allowedProjects, fathomToken, onReconnect }) {
  const [startDate, setStartDate] = useState(() => fmtDate(daysAgo(7)));
  const [endDate,   setEndDate]   = useState(() => fmtDate(new Date()));
  const [scope,     setScope]     = useState('my'); // 'my' | 'team'

  const [calls,        setCalls]       = useState(null);   // null = not loaded yet
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [callsError,   setCallsError]  = useState('');
  const [selectedCall, setSelectedCall] = useState(null);
  // Archiving a call into the PM Brain vault (the copy-paste replacement).
  // The vault is private to its owner (PM_BRAIN_ALLOWED server-side), so the
  // affordance is hidden for everyone else rather than 403-ing on click.
  const [vaultCall,    setVaultCall]   = useState(null);   // call being saved
  const [vaultSaved,   setVaultSaved]  = useState({});     // id → ledger entry
  const [vaultAllowed, setVaultAllowed] = useState(false);

  // ── New / read / moved state (server-side, api/fathomSeen.js) ──
  // A call is NEW when it happened after the baseline and has not been marked
  // read or archived. The baseline is stamped by the server on first read, so
  // switching this on does not light up the whole account.
  // Multi-select for bulk actions (archive several calls into one folder,
  // mark several read). Kept as a Set of recording ids — the call objects come
  // from `calls`, so a stale id simply drops out after a reload.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [vaultBatch,  setVaultBatch]  = useState(null);   // calls being archived

  const [seen,        setSeen]        = useState(null);   // { id: {at, via} }
  const [baselineAt,  setBaselineAt]  = useState(null);
  const [newOnly,     setNewOnly]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/fathom/seen')
      .then(r => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSeen(d.seen ?? {});
        setBaselineAt(d.baselineAt ?? null);
      })
      .catch(() => { if (!cancelled) setSeen({}); });
    return () => { cancelled = true; };
  }, []);

  const isNew = useCallback((c) => {
    if (!baselineAt || !c?.id) return false;
    if (seen && seen[c.id]) return false;
    const t = c.date ? Date.parse(c.date) : NaN;
    return Number.isFinite(t) && t > Date.parse(baselineAt);
  }, [seen, baselineAt]);

  const markSeen = useCallback(async (ids, via = 'read') => {
    const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    if (!list.length) return;
    const at = new Date().toISOString();
    // Optimistic: the badge is a read-state, not a transaction.
    setSeen(prev => ({ ...(prev ?? {}), ...Object.fromEntries(list.map(id => [id, { at, via }])) }));
    try {
      await fetch('/api/fathom/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: list, via }),
      });
    } catch { /* keep the optimistic state; the next load re-syncs */ }
  }, []);

  const unmarkSeen = useCallback(async (id) => {
    setSeen((prev) => {
      const next = { ...(prev ?? {}) };
      delete next[id];
      return next;
    });
    try {
      await fetch('/api/fathom/seen', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
    } catch { /* noop */ }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/fathom/vault-status')
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled) setVaultAllowed(d?.allowed !== false); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Client-side filtering of the already-loaded calls.
  const [groupFilter, setGroupFilter] = useState('all'); // 'all' | a group label
  const [subFilter,   setSubFilter]   = useState('all'); // 'all' | a sub-group label (within the group)
  const [callSearch,  setCallSearch]  = useState('');
  // Collapsed by default: with 7 project chips plus a sub-row the block runs ~5
  // rows tall and pushes the call list off a laptop screen. The choice is
  // remembered, so opening it once keeps it open.
  const [filtersOpen, setFiltersOpen] = useState(() => {
    try { return localStorage.getItem('tf_filters_open') === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem('tf_filters_open', filtersOpen ? '1' : '0'); } catch { /* private mode */ }
  }, [filtersOpen]);

  const [skills,        setSkills]       = useState([]);
  const [selectedSkill, setSelectedSkill] = useState('');

  const [running,  setRunning]  = useState(false);
  const [result,   setResult]   = useState('');
  const [runError, setRunError] = useState('');
  const [copied,   setCopied]   = useState(false);
  const [exported, setExported] = useState(false);

  // Creating a task runs in two steps: choose the target (new request vs an
  // existing one), then the matching modal. `taskModal.mode` is null while the
  // choice is up, then 'new' | 'existing'.
  const [taskModal, setTaskModal] = useState(null);  // { task, mode }
  const [created,   setCreated]   = useState({});    // { [taskKey]: { jiraKey, jiraUrl, epicUrl } }
  const [details,   setDetails]   = useState({});    // { [taskKey]: { loading, text, error } } — per-task deep dives

  // Load the skill catalogue once.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/fathom/skills')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const list = d.skills ?? [];
        setSkills(list);
        if (list[0]) setSelectedSkill(list[0].id);
      })
      .catch(() => { /* dropdown stays empty; Run is disabled */ });
    return () => { cancelled = true; };
  }, []);

  function applyPreset(p) {
    setStartDate(p.start());
    setEndDate(p.end());
  }

  function handleAuthFailure(data) {
    if (data?.reconnect) onReconnect?.(data.error || 'Fathom access expired. Please reconnect.');
  }

  const loadCalls = useCallback(async () => {
    setLoadingCalls(true);
    setCallsError('');
    setCalls(null);
    setSelectedCall(null);
    setGroupFilter('all');
    setSubFilter('all');
    setCallSearch('');
    setResult('');
    setRunError('');
    try {
      const res = await fetch('/api/fathom/my-calls', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fathomToken, userEmail: user, startDate, endDate, scope }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        handleAuthFailure(data);
        throw new Error(data.error || `Server error ${res.status}`);
      }
      setCalls(data.meetings ?? []);
    } catch (e) {
      setCallsError(e.message || 'Could not load calls.');
    } finally {
      setLoadingCalls(false);
    }
  }, [fathomToken, user, startDate, endDate, scope]); // eslint-disable-line

  const runSkill = useCallback(async () => {
    if (!selectedCall || !selectedSkill) return;
    setRunning(true);
    setRunError('');
    setResult('');
    setCopied(false);
    setCreated({});
    setDetails({});
    try {
      const res = await fetch('/api/fathom/skill-run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          fathomToken,
          userEmail:   user,
          recordingId: selectedCall.id,
          callTitle:   selectedCall.title,
          callUrl:     selectedCall.url,
          skillId:     selectedSkill,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        handleAuthFailure(data);
        throw new Error(data.error || `Server error ${res.status}`);
      }
      setResult(data.reply || '');
    } catch (e) {
      setRunError(e.message || 'Skill run failed.');
    } finally {
      setRunning(false);
    }
  }, [selectedCall, selectedSkill, fathomToken, user]); // eslint-disable-line

  // Per-task deep dive: re-read the same call and pull out everything related
  // to this one task. The result lands on the task card and is appended to the
  // description when the task is created.
  const runDeepDive = useCallback(async (task) => {
    const key = taskKey(task);
    setDetails(prev => ({ ...prev, [key]: { ...prev[key], loading: true, error: '' } }));
    try {
      const res = await fetch('/api/fathom/task-deep-dive', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          fathomToken,
          userEmail:   user,
          recordingId: selectedCall?.id,
          callTitle:   selectedCall?.title,
          callUrl:     selectedCall?.url,
          task: { title: task.title, description: task.description, who: task.who },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        handleAuthFailure(data);
        throw new Error(data.error || `Server error ${res.status}`);
      }
      const text = cleanDeepDive(data.details);
      setDetails(prev => ({
        ...prev,
        [key]: { loading: false, text, error: text ? '' : 'The model returned nothing for this task.' },
      }));
    } catch (e) {
      setDetails(prev => ({ ...prev, [key]: { ...prev[key], loading: false, error: e.message || 'Deep dive failed.' } }));
    }
  }, [fathomToken, user, selectedCall]); // eslint-disable-line

  // Groups derived from the loaded calls (label → count), sorted by frequency.
  const groups = useMemo(() => {
    if (!calls) return [];
    const counts = new Map();
    for (const c of calls) {
      const g = callGroup(c.title);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [calls]);

  // Sub-groups (label → count) within the currently selected group. Empty unless
  // a specific group is picked and it contains at least two distinct sub-labels.
  const subGroups = useMemo(() => {
    if (!calls || groupFilter === 'all') return [];
    const counts = new Map();
    for (const c of calls) {
      if (callGroup(c.title) !== groupFilter) continue;
      const s = callSubGroup(c.title);
      if (!s) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [calls, groupFilter]);

  // Calls after applying the group chip + sub-group chip + free-text search.
  const filteredCalls = useMemo(() => {
    if (!calls) return calls;
    const q = callSearch.trim().toLowerCase();
    return calls.filter(c => {
      if (groupFilter !== 'all' && callGroup(c.title) !== groupFilter) return false;
      if (groupFilter !== 'all' && subFilter !== 'all' && callSubGroup(c.title) !== subFilter) return false;
      if (newOnly && !isNew(c)) return false;
      if (q) {
        const hay = `${c.title || ''} ${c.host || ''} ${(c.attendees || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [calls, groupFilter, subFilter, callSearch, newOnly, isNew]);

  const newCount = useMemo(() => (calls ?? []).filter(isNew).length, [calls, isNew]);

  const toggleSelect = useCallback((id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  // Selection is intentionally scoped to what is VISIBLE: "select all" after a
  // filter must not quietly pick up calls the user cannot see.
  const selectedCalls = useMemo(
    () => (calls ?? []).filter(c => selectedIds.has(c.id)),
    [calls, selectedIds],
  );
  const visibleIds = useMemo(() => (filteredCalls ?? []).map(c => c.id), [filteredCalls]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id));

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const every = visibleIds.length > 0 && visibleIds.every(id => next.has(id));
      for (const id of visibleIds) { if (every) next.delete(id); else next.add(id); }
      return next;
    });
  }, [visibleIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // A call that leaves the list (new range / scope) must not stay selected.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (!prev.size || !calls) return prev.size ? new Set() : prev;
      const alive = new Set((calls ?? []).map(c => c.id));
      const next = new Set([...prev].filter(id => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [calls]);

  // Selecting a group resets the sub-filter (its sub-labels are group-specific).
  function pickGroup(label) {
    setGroupFilter(prev => (prev === label ? 'all' : label));
    setSubFilter('all');
  }

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  const parsedResult = useMemo(() => parseSkillOutput(result), [result]);

  // Copy the parsed task list in an approval-friendly format: rich HTML table
  // (keeps formatting + clickable Fathom links when pasted into email/Slack)
  // with a plain-text fallback. The BA replies with the task numbers to create.
  async function exportTasks() {
    const { text, html } = buildApprovalExport(parsedResult, selectedCall);
    try {
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html':  new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    } catch {
      // A failed rich write must not leave stale clipboard content behind.
      try {
        await navigator.clipboard.writeText(text);
        setExported(true);
        setTimeout(() => setExported(false), 1500);
      } catch { /* clipboard blocked */ }
    }
  }

  return (
    <div className="tf-wrap">
      {/* ── Controls: date range + scope + load ── */}
      <section className="tf-controls">
        <div className="tf-scope" role="tablist" aria-label="Call scope">
          <button className={scope === 'my' ? 'active' : ''}   onClick={() => setScope('my')}>My Calls</button>
          <button className={scope === 'team' ? 'active' : ''} onClick={() => setScope('team')}>Team Calls</button>
        </div>

        <div className="tf-presets">
          {PRESETS.map(p => (
            <button key={p.id} className="tf-chip" onClick={() => applyPreset(p)}>{p.label}</button>
          ))}
        </div>

        <label className="tf-field">
          <span>From</span>
          <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} />
        </label>
        <label className="tf-field">
          <span>To</span>
          <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
        </label>

        <button className="btn tf-load-btn" onClick={loadCalls} disabled={loadingCalls || !startDate || !endDate}>
          {loadingCalls ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Load calls'}
        </button>
      </section>

      {callsError && <p className="ba-input-error tf-toperr">⚠ {callsError}</p>}

      {/* ── Two-column working area ── */}
      <div className="tf-grid">
        {/* Left: call list */}
        <section className="tf-col tf-col-calls">
          <div className="tf-col-head">
            <span className="tf-col-title">{scope === 'team' ? 'Team calls' : 'My calls'}</span>
            {calls !== null && calls.length > 0 && (
              <label className="tf-selall" title={allVisibleSelected ? 'Deselect all shown' : 'Select all shown'}>
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAllVisible} />
                <span>{allVisibleSelected ? 'none' : 'all'}</span>
              </label>
            )}
            {calls !== null && newCount > 0 && (
              <button
                type="button"
                className={`tf-newchip${newOnly ? ' active' : ''}`}
                onClick={() => setNewOnly(v => !v)}
                title={newOnly ? 'Show all calls' : 'Show only new calls'}
              >
                {newCount} new
              </button>
            )}
            {calls !== null && newCount > 0 && (
              <button
                type="button"
                className="tf-linkbtn tf-markall"
                onClick={() => markSeen((calls ?? []).filter(isNew).map(c => c.id), 'bulk')}
                title="Mark every new call as read"
              >
                mark all read
              </button>
            )}
            {calls !== null && (
              <span className="tf-count">
                {filteredCalls.length === calls.length ? calls.length : `${filteredCalls.length} / ${calls.length}`}
              </span>
            )}
          </div>

          {selectedCalls.length > 0 && (
            <div className="tf-bulkbar">
              <span className="tf-bulk-n">{selectedCalls.length} selected</span>
              {!allVisibleSelected && (
                <button type="button" className="tf-bulk-btn" onClick={toggleSelectAllVisible}>
                  select all {visibleIds.length}
                </button>
              )}
              {newCount > 0 && (
                <button type="button" className="tf-bulk-btn"
                  onClick={() => setSelectedIds(new Set((filteredCalls ?? []).filter(isNew).map(c => c.id)))}>
                  select new {(filteredCalls ?? []).filter(isNew).length}
                </button>
              )}
              {vaultAllowed && (
                <button type="button" className="tf-bulk-btn primary"
                  onClick={() => setVaultBatch(selectedCalls)}>
                  → Vault
                </button>
              )}
              <button type="button" className="tf-bulk-btn"
                onClick={() => { markSeen(selectedCalls.map(c => c.id), 'bulk'); clearSelection(); }}>
                Mark read
              </button>
              <button type="button" className="tf-linkbtn" onClick={clearSelection}>clear</button>
            </div>
          )}

          {calls !== null && calls.length > 0 && (
            <div className="tf-filterbar">
              <input
                className="tf-callsearch"
                type="text"
                placeholder="Filter by title, host or attendee…"
                value={callSearch}
                onChange={e => setCallSearch(e.target.value)}
              />

              {groups.length > 1 && (
                <div className="tf-filter-toprow">
                  <button
                    type="button"
                    className="tf-filter-toggle"
                    onClick={() => setFiltersOpen(o => !o)}
                    aria-expanded={filtersOpen}
                  >
                    <svg className={`tf-filter-chevron${filtersOpen ? ' open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Filters
                  </button>
                  {/* When collapsed, show what's active so it's not hidden state. */}
                  {!filtersOpen && (groupFilter !== 'all' || subFilter !== 'all') && (
                    <span className="tf-filter-active">
                      {groupFilter}{subFilter !== 'all' ? ` › ${subFilter}` : ''}
                      <button
                        type="button"
                        className="tf-filter-active-clear"
                        title="Clear filter"
                        onClick={() => { setGroupFilter('all'); setSubFilter('all'); }}
                      >✕</button>
                    </span>
                  )}
                </div>
              )}

              {filtersOpen && groups.length > 1 && (
                <div className="tf-groups">
                  <button
                    className={`tf-chip tf-group${groupFilter === 'all' ? ' active' : ''}`}
                    onClick={() => { setGroupFilter('all'); setSubFilter('all'); }}
                  >
                    All <span className="tf-group-n">{calls.length}</span>
                  </button>
                  {groups.map(g => (
                    <button
                      key={g.label}
                      className={`tf-chip tf-group${groupFilter === g.label ? ' active' : ''}`}
                      onClick={() => pickGroup(g.label)}
                    >
                      {g.label} <span className="tf-group-n">{g.count}</span>
                    </button>
                  ))}
                </div>
              )}

              {filtersOpen && subGroups.length > 1 && (
                <div className="tf-groups tf-subgroups">
                  <button
                    className={`tf-chip tf-group tf-subgroup${subFilter === 'all' ? ' active' : ''}`}
                    onClick={() => setSubFilter('all')}
                  >
                    All {groupFilter}
                  </button>
                  {subGroups.map(s => (
                    <button
                      key={s.label}
                      className={`tf-chip tf-group tf-subgroup${subFilter === s.label ? ' active' : ''}`}
                      onClick={() => setSubFilter(subFilter === s.label ? 'all' : s.label)}
                      title={s.label}
                    >
                      {s.label} <span className="tf-group-n">{s.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="tf-col-body">
            {calls === null ? (
              <p className="tf-empty">Pick a range and press <strong>Load calls</strong>.</p>
            ) : calls.length === 0 ? (
              <p className="tf-empty">No calls found in this range. Try a wider range or switch scope.</p>
            ) : filteredCalls.length === 0 ? (
              <p className="tf-empty">No calls match the current filter. <button type="button" className="tf-linkbtn" onClick={() => { setGroupFilter('all'); setSubFilter('all'); setCallSearch(''); }}>Clear filter</button></p>
            ) : (
              <ul className="tf-call-list">
                {filteredCalls.map((c, i) => {
                  const active = selectedCall && selectedCall.id === c.id;
                  const sub = [prettyDate(c.date), scope === 'team' ? c.host : null, c.attendees?.slice(0, 3).join(', ')]
                    .filter(Boolean).join(' · ');
                  const fresh = isNew(c);
                  const mark = seen?.[c.id];
                  return (
                    <li key={c.id || i} className={`tf-call-li${fresh ? ' fresh' : ''}${selectedIds.has(c.id) ? ' picked' : ''}`}>
                      <label className="tf-call-pick" title="Select for a bulk action"
                        onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(c.id)}
                          onChange={() => toggleSelect(c.id)}
                        />
                      </label>
                      <button
                        className={`tf-call${active ? ' active' : ''}`}
                        onClick={() => { setSelectedCall(c); setResult(''); setRunError(''); }}
                      >
                        <span className="tf-call-title">
                          {fresh && <span className="tf-new" title={`New since ${prettyDate(baselineAt)}`}>NEW</span>}
                          {c.title}
                        </span>
                        {sub && <span className="tf-call-meta">{sub}</span>}
                        {mark && (
                          <span className="tf-call-mark">
                            {mark.via === 'moved' ? '✓ moved to vault' : '✓ read'}
                            {mark.at ? ` · ${prettyDate(mark.at)}` : ''}
                          </span>
                        )}
                      </button>
                      {/* Row actions live INSIDE the card (pinned bottom-right);
                          as loose siblings they straddled its border. */}
                      <span className="tf-call-actions" onClick={e => e.stopPropagation()}>
                        {fresh ? (
                          <button
                            type="button"
                            className="tf-call-read"
                            title="Mark this call as read"
                            onClick={(e) => { e.stopPropagation(); markSeen(c.id, 'read'); }}
                          >
                            Mark read
                          </button>
                        ) : mark ? (
                          <button
                            type="button"
                            className="tf-call-read tf-call-unread"
                            title="Mark as new again"
                            onClick={(e) => { e.stopPropagation(); unmarkSeen(c.id); }}
                          >
                            Undo
                          </button>
                        ) : null}
                        {vaultAllowed && (
                          <button
                            type="button"
                            className={`tf-call-vault${vaultSaved[c.id] ? ' saved' : ''}`}
                            title={vaultSaved[c.id]
                              ? `In the vault: ${vaultSaved[c.id].path}`
                              : 'Save the transcript into the PM Brain vault'}
                            onClick={(e) => { e.stopPropagation(); setVaultCall(c); }}
                          >
                            {vaultSaved[c.id] ? '✓ Vault' : '→ Vault'}
                          </button>
                        )}
                      </span>
                      {c.url && (
                        <a
                          className="tf-call-open"
                          href={c.url}
                          target="_blank"
                          rel="noreferrer"
                          title="Open call in Fathom"
                          onClick={e => e.stopPropagation()}
                        >
                          Open ↗
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Right: skill + result */}
        <section className="tf-col tf-col-output">
          <div className="tf-col-head tf-skill-head">
            <select
              className="tf-select"
              value={selectedSkill}
              onChange={e => setSelectedSkill(e.target.value)}
              disabled={!skills.length}
            >
              {skills.length === 0 && <option value="">No skills available</option>}
              {skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="btn" onClick={runSkill} disabled={running || !selectedSkill || !selectedCall}>
              {running ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Run skill'}
            </button>
            {result && (
              <button className="btn btn-ghost" onClick={copyResult}>{copied ? 'Copied ✓' : 'Copy'}</button>
            )}
            {parsedResult.hasStructure && (
              <button className="btn btn-ghost" onClick={exportTasks} title="Copy the task list for approval — the reply tells you which task numbers to create">
                {exported ? 'Copied ✓' : 'Export tasks'}
              </button>
            )}
          </div>
          <div className="tf-col-body">
            {runError && <p className="ba-input-error">⚠ {runError}</p>}
            {!selectedCall ? (
              <p className="tf-empty">Select a call, then run a skill on its transcript.</p>
            ) : running && !result ? (
              <RunningHint />
            ) : result ? (
              <ResultView
                parsed={parsedResult}
                rawResult={result}
                created={created}
                details={details}
                onCreate={task => setTaskModal({ task, mode: null })}
                onDeepDive={runDeepDive}
              />
            ) : (
              <p className="tf-empty">
                Selected: <strong>{selectedCall.title}</strong>. Press <strong>Run skill</strong>.
              </p>
            )}
          </div>
        </section>
      </div>

      {taskModal && !taskModal.mode && (
        <CreateTargetChoice
          taskTitle={taskModal.task.title}
          onNew={() => setTaskModal(m => ({ ...m, mode: 'new' }))}
          onExisting={() => setTaskModal(m => ({ ...m, mode: 'existing' }))}
          onClose={() => setTaskModal(null)}
        />
      )}

      {taskModal?.mode === 'new' && (
        <TaskCreateModal
          user={user}
          allowedProjects={allowedProjects}
          callTitle={selectedCall?.title}
          initialTitle={taskModal.task.title}
          initialDescription={buildTaskDescription(taskModal.task, selectedCall, details[taskKey(taskModal.task)]?.text)}
          onClose={() => setTaskModal(null)}
          onCreated={res => setCreated(prev => ({ ...prev, [taskKey(taskModal.task)]: res }))}
        />
      )}

      {taskModal?.mode === 'existing' && (
        <AddToParentModal
          allowedProjects={allowedProjects}
          callTitle={selectedCall?.title}
          initialTitle={taskModal.task.title}
          initialDescription={buildTaskDescription(taskModal.task, selectedCall, details[taskKey(taskModal.task)]?.text)}
          onClose={() => setTaskModal(null)}
          onCreated={res => setCreated(prev => ({ ...prev, [taskKey(taskModal.task)]: res }))}
        />
      )}

      {(vaultCall || vaultBatch) && (
        <SaveToVaultModal
          calls={vaultBatch ?? [vaultCall]}
          fathomToken={fathomToken}
          onClose={() => { setVaultCall(null); setVaultBatch(null); }}
          onSaved={(entry) => {
            if (!entry?.recordingId) return;
            setVaultSaved(prev => ({ ...prev, [entry.recordingId]: entry }));
            // The server stamps this too (so it agrees on other devices); this
            // just keeps the badge from lagging behind the click.
            setSeen(prev => ({ ...(prev ?? {}), [entry.recordingId]: { at: new Date().toISOString(), via: 'moved' } }));
            setSelectedIds((prev) => {
              if (!prev.has(entry.recordingId)) return prev;
              const next = new Set(prev);
              next.delete(entry.recordingId);
              return next;
            });
          }}
        />
      )}
    </div>
  );
}

// Elapsed-time hint while a skill runs, so the UI doesn't look frozen.
function RunningHint() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setS(x => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const hint = s < 4 ? 'Reading the transcript…'
    : s < 12 ? 'Extracting tasks from the call…'
    : 'Almost there — large transcript, hang tight…';
  return <p className="tf-empty">{hint} <span style={{ opacity: 0.6 }}>{s}s</span></p>;
}

// Stable key for a parsed task (used to mark it "created").
export function taskKey(task) {
  return `${task.n}::${task.title}`;
}

// Resolve a usable Fathom URL from a task's "Fathom Link" field (markdown link,
// bare URL, or "Not provided"), falling back to the selected call's URL.
function resolveFathomLink(task, call) {
  const v = task.link || '';
  const md = v.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
  if (md) return md[1];
  const u = v.match(/https?:\/\/\S+/);
  if (u) return u[0];
  return call?.url || '';
}

// The deep-dive prompt asks for plain "Header:" sections, but models still slip
// in markdown emphasis/headings sometimes; strip those so the text reads clean
// both on the card and through textToHtml (which renders links, not markdown).
export function cleanDeepDive(text) {
  return String(text || '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*/g, '')
    .trim();
}

// Compose the task description that pre-fills the create form: the task body,
// the deep-dive details (when loaded), plus a Who / Priority / Fathom-link footer.
export function buildTaskDescription(task, call, deepDive) {
  const parts = [];
  if (task.description) parts.push(task.description.trim());
  if (deepDive) parts.push(`Details from call:\n${deepDive.trim()}`);
  const meta = [];
  if (task.who)      meta.push(`Who: ${task.who}`);
  if (task.priority) meta.push(`Priority: ${task.priority}`);
  const link = resolveFathomLink(task, call);
  if (link)          meta.push(`Fathom: ${link}`);
  if (meta.length) parts.push(meta.join('\n'));
  return parts.join('\n\n');
}

// ─── Approval export ──────────────────────────────────────────────────────────
// Renders the parsed tasks as a numbered list the user can paste into
// email/Slack for sign-off; the reviewer (BA) replies with the numbers of the
// tasks to create. Returns { text, html }: html is a table so hyperlinks and
// structure survive pasting into rich editors; text is the fallback.
export function buildApprovalExport(parsed, call) {
  const when  = call?.date ? prettyDate(call.date) : '';
  const title = `${call?.title || 'Untitled meeting'}${when ? ` — ${when}` : ''}`;
  const ask   = 'Please reply with the numbers of the tasks to create (e.g. "1, 3").';

  const lines = ['TASKS FOR APPROVAL', `Call: ${title}`];
  if (call?.url) lines.push(call.url);
  lines.push('');
  for (const t of parsed.tasks) {
    lines.push(`#${t.n}. ${t.title || '(no title)'}${t.priority ? ` [${t.priority}]` : ''}`);
    if (t.who) lines.push(`Who: ${t.who}`);
    if (t.description) lines.push(t.description);
    const link = resolveFathomLink(t, call);
    if (link) lines.push(`Fathom: ${link}`);
    lines.push('');
  }
  lines.push(ask);
  const text = lines.join('\n');

  const esc = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const br  = s => esc(s).replace(/\n/g, '<br>');
  const rows = parsed.tasks.map(t => {
    const link = resolveFathomLink(t, call);
    return `<tr>
<td style="padding:6px 10px;border:1px solid #ccc;text-align:center;white-space:nowrap"><b>#${esc(t.n)}</b></td>
<td style="padding:6px 10px;border:1px solid #ccc"><b>${esc(t.title || '(no title)')}</b></td>
<td style="padding:6px 10px;border:1px solid #ccc;white-space:nowrap">${esc(t.priority || '')}</td>
<td style="padding:6px 10px;border:1px solid #ccc;white-space:nowrap">${esc(t.who || '')}</td>
<td style="padding:6px 10px;border:1px solid #ccc">${br(t.description || '')}</td>
<td style="padding:6px 10px;border:1px solid #ccc">${link ? `<a href="${esc(link)}">Fathom ↗</a>` : ''}</td>
</tr>`;
  }).join('\n');
  const html =
    `<p><b>Tasks for approval</b><br>Call: ${call?.url ? `<a href="${esc(call.url)}">${esc(title)}</a>` : esc(title)}</p>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
<thead><tr>
<th style="padding:6px 10px;border:1px solid #ccc">#</th>
<th style="padding:6px 10px;border:1px solid #ccc;text-align:left">Task</th>
<th style="padding:6px 10px;border:1px solid #ccc">Priority</th>
<th style="padding:6px 10px;border:1px solid #ccc">Who</th>
<th style="padding:6px 10px;border:1px solid #ccc;text-align:left">Description</th>
<th style="padding:6px 10px;border:1px solid #ccc">Link</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
<p>${esc(ask)}</p>`;

  return { text, html };
}

// Tiny self-resetting copy button for a deep-dive block.
function DetailCopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="tf-linkbtn"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setOk(true);
          setTimeout(() => setOk(false), 1500);
        } catch { /* clipboard blocked */ }
      }}
    >
      {ok ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

// ─── Result view: one block per task + Create Task ────────────────────────────
function ResultView({ parsed, rawResult, created, details, onCreate, onDeepDive }) {
  if (!parsed.hasStructure) {
    // Non-conforming output (e.g. "No actionable tasks…") — show as-is.
    return <pre className="tf-result">{rawResult}</pre>;
  }
  return (
    <div className="tf-results">
      {parsed.analysis && <p className="tf-analysis">{parsed.analysis}</p>}

      {parsed.tasks.map((task, i) => {
        const key    = taskKey(task);
        const done   = created[key];
        const detail = details?.[key];
        return (
          <div className="tf-task" key={key + i}>
            <div className="tf-task-top">
              <span className="tf-task-n">Task #{task.n}</span>
              {task.priority && <span className={priorityClass(task.priority)}>{task.priority}</span>}
            </div>
            {task.title && <p className="tf-task-title">{task.title}</p>}
            {task.description && <p className="tf-task-desc">{task.description}</p>}
            <div className="tf-task-meta">
              {task.who && <span><strong>Who:</strong> {task.who}</span>}
              {task.link && <span><strong>Fathom:</strong> <FathomLinkValue value={task.link} /></span>}
            </div>
            {detail?.text && (
              <div className="tf-task-details">
                <div className="tf-task-details-head">
                  <span className="tf-task-details-title">Details from call</span>
                  <span className="tf-task-dim">included in Create Task</span>
                  <DetailCopyBtn text={detail.text} />
                </div>
                <pre className="tf-task-details-body">{detail.text}</pre>
              </div>
            )}
            {detail?.error && <p className="ba-input-error">⚠ {detail.error}</p>}
            <div className="tf-task-actions">
              {done ? (
                <span className="tf-task-created">
                  Created ✓
                  {done.jiraKey && done.jiraUrl && (
                    <> · <a className="ba-issue-link" href={done.jiraUrl} target="_blank" rel="noreferrer">{done.jiraKey} ↗</a></>
                  )}
                  {done.epicUrl && (
                    <> · <a className="ba-issue-link" href={done.epicUrl} target="_blank" rel="noreferrer">Azure ↗</a></>
                  )}
                </span>
              ) : (
                <button className="btn btn-primary tf-create-btn" onClick={() => onCreate(task)}>Create Task ↗</button>
              )}
              {!done && !detail?.text && (
                <button
                  className="btn btn-ghost tf-more-btn"
                  onClick={() => onDeepDive(task)}
                  disabled={detail?.loading}
                  title="Re-read the call and pull out everything related to this task"
                >
                  {detail?.loading
                    ? <><span className="spinner" style={{ width: 14, height: 14 }} /> Reading call…</>
                    : 'More…'}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {(parsed.urgent || parsed.backlog) && (
        <div className="tf-summaries">
          {parsed.urgent && (
            <div className="tf-summary">
              <p className="tf-summary-title">Urgent Items</p>
              <pre className="tf-summary-body">{parsed.urgent}</pre>
            </div>
          )}
          {parsed.backlog && (
            <div className="tf-summary">
              <p className="tf-summary-title">Backlog Recommendations</p>
              <pre className="tf-summary-body">{parsed.backlog}</pre>
            </div>
          )}
        </div>
      )}
      </div>
  );
}
