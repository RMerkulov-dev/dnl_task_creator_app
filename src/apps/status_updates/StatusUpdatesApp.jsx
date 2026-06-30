import { useState, useEffect, useMemo, useCallback } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getAreaPaths, getBoardWorkItems } from '../../services/azureDevops.js';
import { getIssuesStatusByKeys, getChildIssuesTree, getJiraUrl } from '../../services/jira.js';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

// Jira status categories → chip colour bucket.
const STATUS_TONE = {
  new:           'todo',
  indeterminate: 'progress',
  done:          'done',
};

const toneFor = (cat) => STATUS_TONE[cat] || 'todo';

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

// Map a Jira issue type to one of the existing type-colour chips.
function typeClass(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('epic')) return 'su-type-epic';
  if (t.includes('task') || t.includes('sub-task') || t.includes('subtask')) return 'su-type-task';
  return 'su-type-issue';
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
      <span className={`su-status su-status-${toneFor(issue.statusCategory)}`}>{issue.status || '—'}</span>
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

// ─── A single row: Azure work item ⟷ its Jira request (+ children) ─────────────
function WorkItemRow({ item, jira, jiraChildren, depth }) {
  const j = item.jiraKey ? jira.get(item.jiraKey) : null;
  const children = j ? (jiraChildren.get(j.key) ?? []) : [];

  return (
    <div className="su-row" style={{ paddingLeft: 16 + depth * 22 }}>
      {/* Left — Azure DevOps work item */}
      <div className="su-cell su-azure">
        <span className={`su-type su-type-${item.type.toLowerCase().replace(/\s+/g, '-')}`}>{item.type}</span>
        <span className="su-az-id">#{item.id}</span>
        <span className="su-title" title={item.title}>{item.title}</span>
        <span className="su-az-state">{item.state}</span>
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
  const [boards,        setBoards]        = useState([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [boardsLoading, setBoardsLoading] = useState(false);

  const [items,        setItems]        = useState([]);
  const [jira,         setJira]         = useState(new Map());
  const [jiraChildren, setJiraChildren] = useState(new Map());
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState('');
  const [loaded,       setLoaded]       = useState(false);

  const hasBoards = !!proj?.features?.board;

  // ── Load boards (area paths) when the project changes ──────────────────────
  useEffect(() => {
    setBoards([]);
    setSelectedBoard('');
    setItems([]);
    setJira(new Map());
    setJiraChildren(new Map());
    setLoaded(false);
    setError('');
    if (!proj || !hasBoards) return;

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
    return () => { cancelled = true; };
  }, [proj, hasBoards]);

  // ── Load the board's work items + their Jira statuses ──────────────────────
  const load = useCallback(async () => {
    if (!proj) return;
    if (hasBoards && !selectedBoard) { setError('Select a board first.'); return; }
    setLoading(true);
    setError('');
    try {
      const azItems = await getBoardWorkItems(
        proj.azure.proxyKey,
        proj.azure.project,
        proj.azure.jiraIdField,
        hasBoards ? selectedBoard : null,
      );
      // Hide Azure work items that are already Done.
      const visible = azItems.filter(i => (i.state || '').trim().toLowerCase() !== 'done');

      const keys = visible.map(i => i.jiraKey).filter(Boolean);
      const jiraMap = await getIssuesStatusByKeys(proj.jira.cloudId, keys);

      // For each resolved request, pull all of its Jira children (status + assignee).
      const requestKeys = [...new Set(keys)].filter(k => jiraMap.has(k));
      const childEntries = await mapPool(requestKeys, 5, async (k) => [
        k, await getChildIssuesTree(proj.jira.cloudId, k),
      ]);

      setItems(visible);
      setJira(jiraMap);
      setJiraChildren(new Map(childEntries));
      setLoaded(true);
    } catch (e) {
      setError(e.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [proj, hasBoards, selectedBoard]);

  const { roots, childrenOf } = useMemo(() => buildTree(items), [items]);

  // ── Summary counts ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    let linked = 0, missing = 0, unlinked = 0;
    for (const it of items) {
      if (!it.jiraKey) unlinked++;
      else if (jira.has(it.jiraKey)) linked++;
      else missing++;
    }
    return { total: items.length, linked, missing, unlinked };
  }, [items, jira]);

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
        {/* ── Left: board selection ── */}
        <aside className="su-sidebar">
          <h2 className="su-side-title">Source</h2>

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

          {!hasBoards && (
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
              <div className="su-stat"><span className="su-stat-num">{stats.total}</span> work items</div>
              <div className="su-stat su-stat-ok"><span className="su-stat-num">{stats.linked}</span> in Jira</div>
              {stats.missing > 0 && <div className="su-stat su-stat-warn"><span className="su-stat-num">{stats.missing}</span> key not found</div>}
              {stats.unlinked > 0 && <div className="su-stat su-stat-muted"><span className="su-stat-num">{stats.unlinked}</span> no link</div>}
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

          {loaded && !loading && items.length === 0 && (
            <div className="su-empty"><p className="su-empty-sub">No work items found for this board.</p></div>
          )}

          {loaded && !loading && items.length > 0 && (
            <div className="su-table">
              <div className="su-table-head">
                <span className="su-cell">Azure DevOps</span>
                <span className="su-cell">Jira</span>
              </div>
              <div className="su-table-body">
                <TreeRows roots={roots} childrenOf={childrenOf} jira={jira} jiraChildren={jiraChildren} />
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
