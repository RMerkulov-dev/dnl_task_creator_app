import { useState, useEffect, useMemo, useCallback, useRef, useContext, createContext } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import {
  getAreaPaths, getIterations, getBoardWorkItems,
  getWorkItemStates, updateWorkItemState,
} from '../../services/azureDevops.js';
import {
  getIssuesStatusByKeys, getChildIssuesTree, getJiraUrl,
  getIssueKeysByAzureIds, getTransitions, transitionIssue,
} from '../../services/jira.js';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

const DEFAULT_EXCLUDED_STATES = new Set(['done', 'resolved', 'closed', 'cancelled', 'removed']);

// Jira status categories → chip colour bucket.
const STATUS_TONE = {
  new:           'todo',
  indeterminate: 'progress',
  done:          'done',
};

const toneFor = (cat) => STATUS_TONE[cat] || 'todo';

// Azure DevOps state categories → the same chip colour buckets as Jira.
const AZURE_STATE_TONE = {
  Proposed:   'todo',
  InProgress: 'progress',
  Resolved:   'progress',
  Completed:  'done',
  Removed:    'done',
};

// Run an async mapper over a list with bounded concurrency.
async function mapPool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

// ─── Build an Epic → child hierarchy from a flat work-item list ───────────────
function buildTree(items) {
  const byId = new Map(items.map(i => [i.id, i]));
  const childrenOf = new Map();
  const roots = [];
  for (const it of items) {
    if (it.parentId != null && byId.has(it.parentId)) {
      if (!childrenOf.has(it.parentId)) childrenOf.set(it.parentId, []);
      childrenOf.get(it.parentId).push(it);
    } else {
      roots.push(it);
    }
  }
  return { roots, childrenOf };
}

// Immutably patch a node's status inside a Jira descendant tree. Returns the same
// array reference when nothing changed so callers can bail out of re-renders.
function updateTreeStatus(nodes, key, status, statusCategory) {
  let changed = false;
  const out = nodes.map(n => {
    if (n.key === key) { changed = true; return { ...n, status, statusCategory }; }
    if (n.children?.length) {
      const c = updateTreeStatus(n.children, key, status, statusCategory);
      if (c !== n.children) { changed = true; return { ...n, children: c }; }
    }
    return n;
  });
  return changed ? out : nodes;
}

// Flatten a Jira descendant tree into a compact list for the AI snapshot.
function flattenJiraTree(nodes, out = []) {
  for (const n of nodes || []) {
    out.push({ key: n.key, type: n.type, status: n.status, category: n.statusCategory, assignee: n.assignee || null });
    if (n.children?.length) flattenJiraTree(n.children, out);
  }
  return out;
}

// Build the compact JSON the AI reasons over: one entry per Azure work item with
// its linked Jira request and that request's flattened descendants.
function buildStatsSnapshot(items, jira, jiraChildren) {
  return items.map(it => {
    const j = it.jiraKey ? jira.get(it.jiraKey) : null;
    return {
      azureId:      it.id,
      azureType:    it.type,
      azureTitle:   it.title,
      azureState:   it.state,
      jiraKey:      it.jiraKey || null,
      jiraFound:    !!j,
      jiraStatus:   j?.status ?? null,
      jiraCategory: j?.statusCategory ?? null,
      children:     j ? flattenJiraTree(jiraChildren.get(j.key) || []) : [],
    };
  });
}

// Build the plain-text list to copy from the Azure column, for the given rows.
// kind: 'id' (numbers) | 'title' | 'both'.
function collectAzureColumn(rows, kind) {
  return rows.map(it => {
    if (kind === 'id')    return String(it.id);
    if (kind === 'title') return it.title || `#${it.id}`;
    return `${it.id} — ${it.title || ''}`.trim();
  }).join('\n');
}

// Build the plain-text list to copy from the Jira column, for the given rows.
// kind: 'key' (ABS-123) | 'summary' | 'both' | 'allkeys' (request + descendants).
function collectJiraColumn(rows, jira, jiraChildren, kind) {
  const out = [];
  for (const it of rows) {
    if (!it.jiraKey) continue;
    const j = jira.get(it.jiraKey);
    if (!j) { if (kind === 'key' || kind === 'allkeys') out.push(it.jiraKey); continue; }
    if      (kind === 'summary') out.push(j.summary || j.key);
    else if (kind === 'both')    out.push(`${j.key} — ${j.summary || ''}`.trim());
    else {
      out.push(j.key);
      if (kind === 'allkeys') {
        for (const c of flattenJiraTree(jiraChildren.get(j.key) || [])) out.push(c.key);
      }
    }
  }
  return out.join('\n');
}

// Provides the bits an inline StatusChip needs without prop-drilling through the
// recursive tree: the Jira cloud id and the "status changed" callback.
const StatusEditCtx = createContext(null);

// Same idea for the Azure side: proxy/project, a cache of valid states per work-
// item type, a lazy loader, and the optimistic "state changed" callback.
const AzureEditCtx = createContext(null);

// ─── Anchored popover positioning ─────────────────────────────────────────────
// Keep a fixed-position menu glued to its trigger. Previously these menus closed
// on *any* scroll — but a capture-phase scroll listener also fires when the user
// scrolls *inside* a tall menu (the status list is scrollable), dismissing it
// mid-interaction. Instead we reposition the menu to follow its button, and
// ignore scroll events that originate within the menu itself.
function useAnchoredMenu(open, btnRef, menuRef, setPos) {
  useEffect(() => {
    if (!open) return;
    const reposition = (e) => {
      if (e?.type === 'scroll' && menuRef.current?.contains(e.target)) return;
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, btnRef, menuRef, setPos]);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function ChevronIcon({ dir = 'left' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      style={{ transform: dir === 'right' ? 'rotate(180deg)' : undefined }}>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

const SIDEBAR_KEY = 'su_sidebar_collapsed';

function CopyColIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

// Column-header "Copy" dropdown. `options` = [{ key, label, getText }]. Picking
// one copies its text to the clipboard and shows a brief confirmation. Used to
// grab all visible ids / keys / titles at once (e.g. to paste into an LLM).
function CopyMenu({ title, count, options }) {
  const [open,   setOpen]   = useState(false);
  const [copied, setCopied] = useState(false);
  const [pos,    setPos]    = useState(null);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);

  // Fixed positioning (computed from the button) so the menu isn't clipped by
  // the table's overflow:hidden. Reposition (don't close) on scroll/resize.
  useAnchoredMenu(open, btnRef, menuRef, setPos);

  function toggle() {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
  }

  async function pick(opt) {
    try { await navigator.clipboard.writeText(opt.getText()); } catch { /* noop */ }
    setOpen(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  }

  return (
    <span className="su-copycol">
      <button
        ref={btnRef}
        type="button"
        className={`su-copycol-btn${copied ? ' copied' : ''}`}
        onClick={toggle}
        title={title}
      >
        <CopyColIcon />
        {copied ? 'Copied' : 'Copy'}
      </button>
      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-copycol-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            <div className="su-copycol-head">{count} rows — copy what:</div>
            {options.map(opt => (
              <button key={opt.key} type="button" className="su-copycol-item" onClick={() => pick(opt)}>
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// Minimal, safe markdown for the AI answer: escape HTML, then **bold** and
// `code`. Bullet lines (- / •) render as a list. No raw HTML from the model.
function aiInline(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function AiAnswer({ text }) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const blocks = [];
  let bullets = null;
  for (const line of lines) {
    const m = line.match(/^[-*•]\s+(.*)$/);
    if (m) { (bullets ||= []).push(m[1]); continue; }
    if (bullets) { blocks.push({ type: 'ul', items: bullets }); bullets = null; }
    blocks.push({ type: 'p', text: line });
  }
  if (bullets) blocks.push({ type: 'ul', items: bullets });
  return (
    <div className="su-ai-answer-body">
      {blocks.map((b, i) => b.type === 'ul'
        ? <ul key={i} className="su-ai-list">{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: aiInline(it) }} />)}</ul>
        : <p key={i} dangerouslySetInnerHTML={{ __html: aiInline(b.text) }} />)}
    </div>
  );
}

// Map a Jira issue type to one of the existing type-colour chips.
function typeClass(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('epic')) return 'su-type-epic';
  if (t.includes('task') || t.includes('sub-task') || t.includes('subtask')) return 'su-type-task';
  return 'su-type-issue';
}

// ─── Inline-editable Jira status chip ─────────────────────────────────────────
// Click → lazy-load the issue's valid workflow transitions → apply one. Updates
// state optimistically (the workflow guarantees only valid targets are offered).
function StatusChip({ issueKey, status, statusCategory }) {
  const ctx = useContext(StatusEditCtx);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);
  const [open,        setOpen]        = useState(false);
  const [pos,         setPos]         = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [transitions, setTransitions] = useState(null);
  const [err,         setErr]         = useState('');

  const editable = !!ctx?.cloudId && !!issueKey;

  // Keep the fixed-position popover glued to its chip (reposition, don't close)
  // so scrolling the tall status list doesn't dismiss it.
  useAnchoredMenu(open, btnRef, menuRef, setPos);

  async function toggle(e) {
    e.stopPropagation();
    if (!editable) return;
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    setErr('');
    if (transitions == null) {
      setLoading(true);
      try {
        setTransitions(await getTransitions(ctx.cloudId, issueKey));
      } catch (e2) {
        setErr(e2.message || 'Failed to load transitions');
      } finally {
        setLoading(false);
      }
    }
  }

  async function apply(t) {
    setSaving(true);
    setErr('');
    try {
      await transitionIssue(ctx.cloudId, issueKey, t.id);
      ctx.onStatusChange(issueKey, t.to?.name ?? t.name, t.to?.statusCategory?.key ?? statusCategory);
      setOpen(false);
      setTransitions(null);   // available transitions change after a move — refetch next open
    } catch (e2) {
      setErr(e2.message || 'Transition failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="su-status-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`su-status su-status-${toneFor(statusCategory)}${editable ? ' su-status-editable' : ''}`}
        onClick={toggle}
        disabled={saving}
        title={editable ? 'Change status' : undefined}
      >
        {saving ? <span className="spinner" style={{ width: 10, height: 10 }} /> : (status || '—')}
        {editable && <span className="su-status-caret">▾</span>}
      </button>

      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-status-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            {loading && <div className="su-status-menu-item muted"><span className="spinner" style={{ width: 12, height: 12 }} /> Loading…</div>}
            {err && <div className="su-status-menu-item su-status-menu-err">⚠ {err}</div>}
            {!loading && !err && transitions?.length === 0 && (
              <div className="su-status-menu-item muted">No transitions available</div>
            )}
            {!loading && !err && transitions?.map(t => (
              <button key={t.id} type="button" className="su-status-menu-item" disabled={saving} onClick={() => apply(t)}>
                <span className="su-status-menu-name">{t.name}</span>
                {t.to?.name && t.to.name !== t.name && <span className="su-status-menu-to">→ {t.to.name}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// One line in the Jira column: type chip · key · summary · status · assignee.
// Laid out on a fixed grid so every line aligns in columns (no indentation drift).
function JiraLine({ issue, isRequest }) {
  return (
    <div className={`su-jira-line${isRequest ? ' su-jira-request' : ''}`}>
      <span className={`su-type ${typeClass(issue.type)}`} title={issue.type}>{issue.type || '—'}</span>
      <a className="su-jira-key" href={getJiraUrl(issue.key)} target="_blank" rel="noreferrer">
        {isRequest && <LinkIcon />} {issue.key}
      </a>
      <span className="su-child-title" title={issue.summary}>{issue.summary}</span>
      <StatusChip issueKey={issue.key} status={issue.status} statusCategory={issue.statusCategory} />
      <span className="su-assignee">{issue.assignee || 'Unassigned'}</span>
    </div>
  );
}

// Recursive Jira descendant tree — epics with their tasks, tasks with subtasks.
// Rendered flat (no extra indent); hierarchy is conveyed by the type colour.
function JiraTree({ nodes }) {
  if (!nodes?.length) return null;
  return nodes.map(n => (
    <div key={n.key} className="su-jira-subtree">
      <JiraLine issue={n} />
      <JiraTree nodes={n.children} />
    </div>
  ));
}

// ─── Inline-editable Azure DevOps state chip ──────────────────────────────────
// Mirrors the Jira StatusChip: click → lazy-load the valid states for this work-
// item type → PATCH System.State → optimistic UI update. Azure validates the
// move server-side, so an illegal transition surfaces as an error in the menu.
function AzureStateChip({ item }) {
  const ctx = useContext(AzureEditCtx);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);
  const [open,    setOpen]    = useState(false);
  const [pos,     setPos]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [states,  setStates]  = useState(null);
  const [err,     setErr]     = useState('');

  const editable = !!ctx?.editable;
  const cached   = ctx?.statesByType?.[item.type];
  const cat      = (cached || []).find(s => s.name === item.state)?.category;
  const tone     = AZURE_STATE_TONE[cat] || 'todo';

  useAnchoredMenu(open, btnRef, menuRef, setPos);

  async function toggle(e) {
    e.stopPropagation();
    if (!editable) return;
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    setErr('');
    if (states == null) {
      setLoading(true);
      try {
        setStates(await ctx.loadStates(item.type));
      } catch (e2) {
        setErr(e2.message || 'Failed to load states');
      } finally {
        setLoading(false);
      }
    }
  }

  async function apply(stateName) {
    if (stateName === item.state) { setOpen(false); return; }
    setSaving(true);
    setErr('');
    try {
      await updateWorkItemState(ctx.proxyKey, ctx.project, item.id, stateName);
      ctx.onStateChange(item.id, stateName);
      setOpen(false);
    } catch (e2) {
      setErr(e2.message || 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="su-status-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`su-status su-status-${tone}${editable ? ' su-status-editable' : ''}`}
        onClick={toggle}
        disabled={saving}
        title={editable ? 'Change Azure state' : undefined}
      >
        {saving ? <span className="spinner" style={{ width: 10, height: 10 }} /> : (item.state || '—')}
        {editable && <span className="su-status-caret">▾</span>}
      </button>

      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-status-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            {loading && <div className="su-status-menu-item muted"><span className="spinner" style={{ width: 12, height: 12 }} /> Loading…</div>}
            {err && <div className="su-status-menu-item su-status-menu-err">⚠ {err}</div>}
            {!loading && !err && states?.length === 0 && (
              <div className="su-status-menu-item muted">No states available</div>
            )}
            {!loading && !err && states?.map(s => (
              <button
                key={s.name}
                type="button"
                className={`su-status-menu-item${s.name === item.state ? ' active' : ''}`}
                disabled={saving}
                onClick={() => apply(s.name)}
              >
                {s.color && <span className="su-state-dot" style={{ background: `#${s.color}` }} />}
                <span className="su-status-menu-name">{s.name}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// ─── A single row: Azure work item ⟷ its Jira request (+ children) ─────────────
function WorkItemRow({ item, jira, jiraChildren, depth }) {
  const j = item.jiraKey ? jira.get(item.jiraKey) : null;
  const children = j ? (jiraChildren.get(j.key) ?? []) : [];

  return (
    <div className="su-row" style={{ paddingLeft: 16 + depth * 22 }}>
      {/* Left — Azure DevOps work item */}
      <div className="su-cell su-azure">
        <span className={`su-type su-type-${item.type.toLowerCase().replace(/\s+/g, '-')}`}>{item.type}</span>
        {item.url
          ? <a className="su-az-id su-az-link" href={item.url} target="_blank" rel="noreferrer" title="Open in Azure DevOps">#{item.id}</a>
          : <span className="su-az-id">#{item.id}</span>}
        <span className="su-title" title={item.title}>{item.title}</span>
        <AzureStateChip item={item} />
      </div>

      {/* Right — linked Jira request and all its children */}
      <div className="su-cell su-jira">
        {item.jiraKey ? (
          j ? (
            <div className="su-jira-block">
              <JiraLine issue={j} isRequest />
              <JiraTree nodes={children} />
            </div>
          ) : (
            <div className="su-jira-block">
              <span className="su-jira-key su-jira-missing">{item.jiraKey}</span>
              <span className="su-status su-status-none">Not found in Jira</span>
            </div>
          )
        ) : (
          <span className="su-status su-status-none">No Jira link</span>
        )}
      </div>
    </div>
  );
}

function TreeRows({ roots, childrenOf, jira, jiraChildren, depth = 0 }) {
  return roots.map(item => (
    <div key={item.id} className="su-tree-node">
      <WorkItemRow item={item} jira={jira} jiraChildren={jiraChildren} depth={depth} />
      {childrenOf.get(item.id)?.length > 0 && (
        <TreeRows roots={childrenOf.get(item.id)} childrenOf={childrenOf} jira={jira} jiraChildren={jiraChildren} depth={depth + 1} />
      )}
    </div>
  ));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function StatusUpdatesApp({ user, allowedProjects, onLogout }) {
  const projects = useMemo(() => (
    allowedProjects?.length
      ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
      : PROJECT_LIST
  ), [allowedProjects]);

  const [proj,          setProj]          = useState(projects[0]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });
  const [boards,        setBoards]        = useState([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [boardsLoading, setBoardsLoading] = useState(false);

  const [iterations,     setIterations]     = useState([]);
  const [selectedSprint, setSelectedSprint] = useState('');
  const [sprintsLoading, setSprintsLoading] = useState(false);

  const [items,        setItems]        = useState([]);
  const [jira,         setJira]         = useState(new Map());
  const [jiraChildren, setJiraChildren] = useState(new Map());
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [loaded,       setLoaded]       = useState(false);

  // Search + filter
  const [query,        setQuery]        = useState('');
  const [activeFilter, setActiveFilter] = useState('all');   // all | linked | missing | unlinked

  // Azure state editing: cache valid states per work-item type (per project)
  const [azStatesByType, setAzStatesByType] = useState({});

  // AI validation over the loaded snapshot
  const [aiQuery,     setAiQuery]     = useState('');
  const [aiLoading,   setAiLoading]   = useState(false);
  const [aiAnswer,    setAiAnswer]    = useState('');
  const [aiError,     setAiError]     = useState('');
  const [aiMatchIds,  setAiMatchIds]  = useState(null);      // Set<number> | null
  const [aiCopied,    setAiCopied]    = useState(false);
  const aiInputRef = useRef(null);

  const hasBoards  = !!proj?.features?.board;
  const hasSprints = !!proj?.features?.iteration;

  // ── Load boards (area paths) and/or sprints (iterations) on project change ──
  useEffect(() => {
    setBoards([]);
    setSelectedBoard('');
    setIterations([]);
    setSelectedSprint('');
    setItems([]);
    setJira(new Map());
    setJiraChildren(new Map());
    setLoaded(false);
    setError('');
    setQuery('');
    setActiveFilter('all');
    setAzStatesByType({});           // states differ per project process
    setAiAnswer(''); setAiError(''); setAiMatchIds(null); setAiQuery('');
    if (!proj) return;

    let cancelled = false;

    if (hasBoards) {
      setBoardsLoading(true);
      getAreaPaths(proj.azure.proxyKey, proj.azure.project)
        .then(all => {
          if (cancelled) return;
          const allow = proj.boardAllowList;
          setBoards(allow?.length ? all.filter(b => allow.includes(b.name)) : all);
        })
        .catch(e => !cancelled && setError(e.message))
        .finally(() => !cancelled && setBoardsLoading(false));
    }

    if (hasSprints) {
      setSprintsLoading(true);
      getIterations(proj.azure.proxyKey, proj.azure.project)
        .then(all => { if (!cancelled) setIterations(all); })
        .catch(e => !cancelled && setError(e.message))
        .finally(() => !cancelled && setSprintsLoading(false));
    }

    return () => { cancelled = true; };
  }, [proj, hasBoards, hasSprints]);

  // ── Load the board's work items + their Jira statuses ──────────────────────
  const load = useCallback(async () => {
    if (!proj) return;
    if (hasBoards && !selectedBoard) { setError('Select a board first.'); return; }
    setLoading(true);
    setError('');
    // A fresh dataset invalidates any prior AI answer/matches.
    setAiAnswer(''); setAiError(''); setAiMatchIds(null);
    try {
      const azItems = await getBoardWorkItems(
        proj.azure.proxyKey,
        proj.azure.project,
        proj.azure.jiraIdField,
        hasBoards ? selectedBoard : null,
        hasSprints ? (selectedSprint || null) : null,
      );
      // Hide Azure work items in terminal states (project-specific config or defaults).
      const excludedStates = proj.statusUpdates?.excludeStates
        ? new Set(proj.statusUpdates.excludeStates)
        : DEFAULT_EXCLUDED_STATES;
      const visible = azItems.filter(i => !excludedStates.has((i.state || '').trim().toLowerCase()));

      // Resolve the Jira link the way task creation does — by the Azure id stamped
      // on the Jira side (clientRequestIdField), which is reliable. Fall back to the
      // Azure-side field for any item the reverse lookup doesn't cover.
      const keyByAzureId = await getIssueKeysByAzureIds(
        proj.jira.cloudId,
        proj.jiraProjectOptions?.length ? proj.jiraProjectOptions : proj.jira.projectKey,
        proj.jira.clientRequestIdField,
        visible.map(i => i.id),
      );
      const linked = visible.map(i => ({
        ...i,
        jiraKey: keyByAzureId.get(String(i.id)) ?? i.jiraKey,
      }));

      const keys = linked.map(i => i.jiraKey).filter(Boolean);
      const jiraMap = await getIssuesStatusByKeys(proj.jira.cloudId, keys);

      // For each resolved request, pull all of its Jira children (status + assignee).
      const requestKeys = [...new Set(keys)].filter(k => jiraMap.has(k));
      const childEntries = await mapPool(requestKeys, 5, async (k) => [
        k, await getChildIssuesTree(proj.jira.cloudId, k),
      ]);

      setItems(linked);
      setJira(jiraMap);
      setJiraChildren(new Map(childEntries));
      setLoaded(true);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [proj, hasBoards, selectedBoard, hasSprints, selectedSprint]);

  // ── Optimistic status patch after an inline transition ─────────────────────
  const handleStatusChanged = useCallback((key, status, statusCategory) => {
    setJira(prev => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { ...next.get(key), status, statusCategory });
      return next;
    });
    setJiraChildren(prev => {
      let changed = false;
      const next = new Map();
      for (const [k, tree] of prev) {
        const upd = updateTreeStatus(tree, key, status, statusCategory);
        if (upd !== tree) changed = true;
        next.set(k, upd);
      }
      return changed ? next : prev;
    });
  }, []);

  const editCtx = useMemo(
    () => ({ cloudId: proj?.jira?.cloudId, onStatusChange: handleStatusChanged }),
    [proj, handleStatusChanged],
  );

  // ── Azure state editing: lazy-load + cache valid states per work-item type ──
  const loadAzStates = useCallback(async (type) => {
    if (azStatesByType[type]) return azStatesByType[type];
    const states = await getWorkItemStates(proj.azure.proxyKey, proj.azure.project, type);
    setAzStatesByType(prev => ({ ...prev, [type]: states }));
    return states;
  }, [proj, azStatesByType]);

  const handleAzStateChanged = useCallback((id, state) => {
    setItems(prev => prev.map(i => (i.id === id ? { ...i, state } : i)));
  }, []);

  const azEditCtx = useMemo(() => ({
    editable:     !!proj?.azure,
    proxyKey:     proj?.azure?.proxyKey,
    project:      proj?.azure?.project,
    statesByType: azStatesByType,
    loadStates:   loadAzStates,
    onStateChange: handleAzStateChanged,
  }), [proj, azStatesByType, loadAzStates, handleAzStateChanged]);

  // ── AI validation over the currently-loaded snapshot ───────────────────────
  const askAi = useCallback(async () => {
    const question = aiQuery.trim();
    if (!question || aiLoading) return;
    setAiLoading(true);
    setAiError('');
    setAiAnswer('');
    try {
      const snapshot = buildStatsSnapshot(items, jira, jiraChildren);
      const res = await fetch('/api/stats-query', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question, data: snapshot }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      setAiAnswer(data.answer || '');
      // Only switch the table into "AI match" mode when the model returned ids.
      setAiMatchIds(Array.isArray(data.matchAzureIds) && data.matchAzureIds.length
        ? new Set(data.matchAzureIds)
        : null);
    } catch (e) {
      setAiError(e.message || 'AI request failed.');
    } finally {
      setAiLoading(false);
    }
  }, [aiQuery, aiLoading, items, jira, jiraChildren]);

  const clearAiMatch = useCallback(() => setAiMatchIds(null), []);

  // ── Summary counts (always over the full set, not the filtered view) ───────
  const stats = useMemo(() => {
    let linked = 0, missing = 0, unlinked = 0;
    for (const it of items) {
      if (!it.jiraKey) unlinked++;
      else if (jira.has(it.jiraKey)) linked++;
      else missing++;
    }
    return { total: items.length, linked, missing, unlinked };
  }, [items, jira]);

  // ── Apply search + filter, then rebuild the tree from the surviving items ───
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(it => {
      // AI match, when active, takes precedence over the status filters.
      if (aiMatchIds) { if (!aiMatchIds.has(it.id)) return false; }
      else {
        if (activeFilter === 'linked'   && !(it.jiraKey && jira.has(it.jiraKey)))  return false;
        if (activeFilter === 'missing'  && !(it.jiraKey && !jira.has(it.jiraKey))) return false;
        if (activeFilter === 'unlinked' && it.jiraKey)                             return false;
      }
      if (!q) return true;
      const j = it.jiraKey ? jira.get(it.jiraKey) : null;
      const hay = [`#${it.id}`, it.title, it.state, it.jiraKey, j?.summary, j?.status]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, jira, query, activeFilter, aiMatchIds]);

  const { roots, childrenOf } = useMemo(() => buildTree(filteredItems), [filteredItems]);

  const isFiltering = !!query.trim() || activeFilter !== 'all' || !!aiMatchIds;
  const toggleFilter = (f) => setActiveFilter(prev => (prev === f ? 'all' : f));

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-logo"><img src={LOGO} alt="Dynamica Labs" /></div>
        <div className="header-sep" />
        <span className="header-title">Status Updates</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className="su-main">
        {/* ── Collapsed rail: just an expand handle ── */}
        {sidebarCollapsed && (
          <aside className="su-sidebar su-sidebar-collapsed">
            <button className="su-collapse-btn" onClick={toggleSidebar} title="Show panel" aria-label="Show panel">
              <ChevronIcon dir="right" />
            </button>
            <span className="su-collapsed-label">Source</span>
          </aside>
        )}

        {/* ── Left: board selection ── */}
        <aside className="su-sidebar" style={sidebarCollapsed ? { display: 'none' } : undefined}>
          <div className="su-side-head">
            <h2 className="su-side-title">Source</h2>
            <button className="su-collapse-btn" onClick={toggleSidebar} title="Collapse panel" aria-label="Collapse panel">
              <ChevronIcon dir="left" />
            </button>
          </div>

          <label className="field-label">Project</label>
          <select
            className="select"
            value={proj?.id ?? ''}
            onChange={e => setProj(projects.find(p => p.id === e.target.value))}
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>

          {hasBoards && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Board</label>
              <select
                className="select"
                value={selectedBoard}
                onChange={e => setSelectedBoard(e.target.value)}
                disabled={boardsLoading || !boards.length}
              >
                <option value="">{boardsLoading ? 'Loading boards…' : '— Select board —'}</option>
                {boards.map(b => <option key={b.path} value={b.path}>{b.name}</option>)}
              </select>
            </>
          )}

          {hasSprints && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Sprint</label>
              <select
                className="select"
                value={selectedSprint}
                onChange={e => setSelectedSprint(e.target.value)}
                disabled={sprintsLoading || !iterations.length}
              >
                <option value="">{sprintsLoading ? 'Loading sprints…' : '— All sprints —'}</option>
                {iterations.map(it => (
                  <option key={it.id} value={it.path}>
                    {it.name}{it.attributes?.timeFrame === 'current' ? ' • current' : ''}
                  </option>
                ))}
              </select>
            </>
          )}

          {!hasBoards && !hasSprints && (
            <p className="su-hint">This project has no boards — the whole project will be compared.</p>
          )}

          <button
            className="btn btn-primary su-load-btn"
            onClick={load}
            disabled={loading || (hasBoards && !selectedBoard)}
          >
            {loading
              ? <span className="spinner" style={{ width: 15, height: 15 }} />
              : <RefreshIcon />}
            {loading ? 'Comparing…' : loaded ? 'Refresh' : 'Compare with Jira'}
          </button>

          {loaded && (
            <div className="su-stats">
              <button
                className={`su-stat su-stat-btn${activeFilter === 'all' ? ' active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                <span className="su-stat-num">{stats.total}</span> work items
              </button>
              <button
                className={`su-stat su-stat-ok su-stat-btn${activeFilter === 'linked' ? ' active' : ''}`}
                onClick={() => toggleFilter('linked')}
              >
                <span className="su-stat-num">{stats.linked}</span> in Jira
              </button>
              {stats.missing > 0 && (
                <button
                  className={`su-stat su-stat-warn su-stat-btn${activeFilter === 'missing' ? ' active' : ''}`}
                  onClick={() => toggleFilter('missing')}
                >
                  <span className="su-stat-num">{stats.missing}</span> key not found
                </button>
              )}
              {stats.unlinked > 0 && (
                <button
                  className={`su-stat su-stat-muted su-stat-btn${activeFilter === 'unlinked' ? ' active' : ''}`}
                  onClick={() => toggleFilter('unlinked')}
                >
                  <span className="su-stat-num">{stats.unlinked}</span> no link
                </button>
              )}
            </div>
          )}
        </aside>

        {/* ── Right: comparison list ── */}
        <section className="su-results">
          {error && <p className="su-error">⚠ {error}</p>}

          {!loaded && !loading && !error && (
            <div className="su-empty">
              <p className="su-empty-title">Status Updates</p>
              <p className="su-empty-sub">
                Pick a board on the left, then compare its Azure DevOps work items
                with the linked Jira issues — statuses and assignees pulled live from Jira.
              </p>
            </div>
          )}

          {loading && (
            <div className="su-empty"><span className="spinner spinner-lg" /></div>
          )}

          {loaded && !loading && items.length > 0 && (
            <div className="su-toolbar">
              <div className="su-search-wrap">
                <span className="su-search-icon"><SearchIcon /></span>
                <input
                  className="input su-search"
                  placeholder="Search id, key, title, status…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                {query && (
                  <button className="su-search-clear" onClick={() => setQuery('')} title="Clear">✕</button>
                )}
              </div>
              {isFiltering && (
                <span className="su-result-count">{filteredItems.length} / {items.length}</span>
              )}
            </div>
          )}

          {/* ── AI validation over the loaded data ── */}
          {loaded && !loading && items.length > 0 && (
            <div className="su-ai">
              <div className="su-ai-bar">
                <span className="su-ai-icon">✨</span>
                <input
                  ref={aiInputRef}
                  className="input su-ai-input"
                  placeholder="Ask AI about the data: e.g. “all requests where every epic and task is done”"
                  value={aiQuery}
                  onChange={e => setAiQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && aiQuery.trim() && !aiLoading) { e.preventDefault(); askAi(); } }}
                  disabled={aiLoading}
                />
                <button
                  className="btn btn-primary su-ai-btn"
                  onClick={() => (aiQuery.trim() ? askAi() : aiInputRef.current?.focus())}
                  disabled={aiLoading}
                >
                  {aiLoading ? <span className="spinner" style={{ width: 13, height: 13 }} /> : 'Ask AI'}
                </button>
              </div>

              {aiError && <p className="su-error" style={{ marginTop: 8 }}>⚠ {aiError}</p>}

              {aiAnswer && !aiLoading && (
                <div className="su-ai-answer">
                  <div className="su-ai-answer-head">
                    <span className="su-ai-answer-title">AI answer</span>
                    <div className="su-ai-answer-tools">
                      <button
                        className="su-ai-tool"
                        onClick={() => { navigator.clipboard?.writeText(aiAnswer); setAiCopied(true); setTimeout(() => setAiCopied(false), 1500); }}
                        title="Copy answer"
                      >
                        {aiCopied ? '✓ Copied' : 'Copy'}
                      </button>
                      <button className="su-ai-tool" onClick={() => { setAiAnswer(''); setAiMatchIds(null); }} title="Dismiss answer">
                        ✕
                      </button>
                    </div>
                  </div>

                  <AiAnswer text={aiAnswer} />

                  {aiMatchIds && (
                    <div className="su-ai-match">
                      <span className="su-ai-match-count">
                        Table filtered: {aiMatchIds.size} match{aiMatchIds.size === 1 ? '' : 'es'}
                      </span>
                      <button className="su-ai-tool" onClick={clearAiMatch} title="Show all items">
                        Show all
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {loaded && !loading && items.length === 0 && (
            <div className="su-empty"><p className="su-empty-sub">No work items found for this board.</p></div>
          )}

          {loaded && !loading && items.length > 0 && filteredItems.length === 0 && (
            <div className="su-empty"><p className="su-empty-sub">Nothing matches your search or filter.</p></div>
          )}

          {loaded && !loading && filteredItems.length > 0 && (
            <StatusEditCtx.Provider value={editCtx}>
              <AzureEditCtx.Provider value={azEditCtx}>
                <div className="su-table">
                  <div className="su-table-head">
                    <span className="su-cell su-head-cell">
                      <span>Azure DevOps</span>
                      <CopyMenu
                        title="Copy Azure data for the visible rows"
                        count={filteredItems.length}
                        options={[
                          { key: 'id',    label: 'IDs (numbers)',   getText: () => collectAzureColumn(filteredItems, 'id') },
                          { key: 'title', label: 'Titles',          getText: () => collectAzureColumn(filteredItems, 'title') },
                          { key: 'both',  label: 'ID — Title',      getText: () => collectAzureColumn(filteredItems, 'both') },
                        ]}
                      />
                    </span>
                    <span className="su-cell su-head-cell">
                      <span>Jira</span>
                      <CopyMenu
                        title="Copy Jira data for the visible rows"
                        count={filteredItems.length}
                        options={[
                          { key: 'key',     label: 'Request keys (ABS-…)',       getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'key') },
                          { key: 'summary', label: 'Summaries',                  getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'summary') },
                          { key: 'both',    label: 'Key — Summary',              getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'both') },
                          { key: 'allkeys', label: 'All keys (with epics/tasks)', getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'allkeys') },
                        ]}
                      />
                    </span>
                  </div>
                  <div className="su-table-body">
                    <TreeRows roots={roots} childrenOf={childrenOf} jira={jira} jiraChildren={jiraChildren} />
                  </div>
                </div>
              </AzureEditCtx.Provider>
            </StatusEditCtx.Provider>
          )}
        </section>
      </main>
    </div>
  );
}
