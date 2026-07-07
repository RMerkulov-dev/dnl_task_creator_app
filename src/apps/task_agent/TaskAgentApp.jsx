import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getJiraProjects, searchJiraUsers, getChildIssues, getProjectComponents } from '../../services/jira.js';
import { loadIssue, loadCloneFields, findSprintField, loadSprintsForProject, loadStatusesForIssueType, cloneInSameProject, bulkMoveForest, moveToProject } from './jiraAgent.js';

const LOGO     = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';
const CLOUD_ID = PROJECT_LIST.find(p => p.jira)?.jira.cloudId ?? '';

const CLONE_STEP_LABELS = [
  'Fetching create schema',
  'Creating clone',
  'Adding clone link',
];

// ─── UserPicker ───────────────────────────────────────────────────────────────

function UserPicker({ cloudId, label, value, onChange }) {
  const [isSearching, setIsSearching] = useState(false);
  const [query,       setQuery]       = useState('');
  const [results,     setResults]     = useState([]);
  const [busy,        setBusy]        = useState(false);

  useEffect(() => {
    if (!isSearching || query.trim().length < 2) { setResults([]); return; }
    setBusy(true);
    const timer = setTimeout(() => {
      searchJiraUsers(cloudId, query)
        .then(users => setResults(users))
        .catch(() => setResults([]))
        .finally(() => setBusy(false));
    }, 280);
    return () => clearTimeout(timer);
  }, [query, isSearching, cloudId]);

  function select(user) {
    onChange(user ? { accountId: user.accountId, displayName: user.displayName } : null);
    setIsSearching(false);
    setQuery('');
    setResults([]);
  }

  function cancel() {
    setIsSearching(false);
    setQuery('');
    setResults([]);
  }

  return (
    <div className="field">
      <label className="field-label">{label}</label>

      {!isSearching ? (
        <div className="user-picker-current">
          <button type="button" className="user-picker-name-btn" onClick={() => setIsSearching(true)}
            title="Click to change">
            {value?.displayName ?? <span style={{ color: 'var(--text-3)' }}>— Unassigned —</span>}
          </button>
          {value && (
            <button type="button" className="btn btn-ghost user-picker-btn"
              onClick={() => select(null)} title="Unassign">
              ✕
            </button>
          )}
        </div>
      ) : (
        <div className="user-picker-search">
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className="input"
              placeholder="Type a name to search…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
              style={{ flex: 1 }}
            />
            {busy && <span className="spinner" style={{ alignSelf: 'center', flexShrink: 0 }} />}
            <button type="button" className="btn btn-ghost" onClick={cancel}
              style={{ flexShrink: 0 }}>
              Cancel
            </button>
          </div>
          {results.length > 0 && (
            <ul className="user-picker-results">
              {results.map(u => (
                <li key={u.accountId}>
                  <button type="button" className="user-picker-result" onClick={() => select(u)}>
                    <span>{u.displayName}</span>
                    {u.emailAddress && (
                      <span className="user-picker-email">{u.emailAddress}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!busy && query.trim().length >= 2 && results.length === 0 && (
            <p style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-3)' }}>
              No users found
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── StepIcon ─────────────────────────────────────────────────────────────────

function StepIcon({ status }) {
  if (status === 'pending') return <span className="step-icon pending"><span className="spinner" /></span>;
  if (status === 'done')    return <span className="step-icon done">✓</span>;
  if (status === 'error')   return <span className="step-icon error">✕</span>;
  if (status === 'skipped') return <span className="step-icon skipped">—</span>;
  return <span className="step-icon idle">·</span>;
}

// ─── IssuePreview ─────────────────────────────────────────────────────────────

function IssuePreview({ issue }) {
  return (
    <div className="agent-preview">
      <p className="agent-preview-summary">{issue.summary}</p>
      <p className="agent-preview-meta">
        <span>{issue.projectKey}</span>
        <span className="agent-preview-dot">·</span>
        <span>{issue.issueTypeName}</span>
        {issue.priority && (
          <>
            <span className="agent-preview-dot">·</span>
            <span>{issue.priority}</span>
          </>
        )}
      </p>
      {issue.parent && (
        <div className="agent-preview-row">
          <span className="agent-preview-key">Parent</span>
          <span>{issue.parent.key}{issue.parent.summary ? ` — ${issue.parent.summary}` : ''}</span>
        </div>
      )}
      {issue.labels.length > 0 && (
        <div className="agent-preview-row">
          <span className="agent-preview-key">Labels</span>
          <span>{issue.labels.join(', ')}</span>
        </div>
      )}
    </div>
  );
}

// ─── ProjectPicker ────────────────────────────────────────────────────────────

function ProjectPicker({ projects, value, onChange, loading }) {
  const [isOpen,  setIsOpen]  = useState(false);
  const [query,   setQuery]   = useState('');

  const selected = projects.find(p => p.key === value) ?? null;
  const filtered = query.trim()
    ? projects.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.key.toLowerCase().includes(query.toLowerCase()))
    : projects;

  function select(key) {
    onChange(key);
    setIsOpen(false);
    setQuery('');
  }

  function close() { setIsOpen(false); setQuery(''); }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-2)', fontSize: 14, height: 40 }}>
        <span className="spinner" /> Loading projects…
      </div>
    );
  }

  return (
    <div className="project-picker">
      {!isOpen ? (
        <button type="button" className="project-picker-current" onClick={() => setIsOpen(true)}>
          {selected
            ? <span>{selected.name} <span style={{ color: 'var(--text-3)' }}>({selected.key})</span></span>
            : <span style={{ color: 'var(--text-3)' }}>— Select target project —</span>}
          <span className="project-picker-chevron">▾</span>
        </button>
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className="input"
              placeholder="Search projects…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') close(); }}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={close} style={{ flexShrink: 0 }}>
              Cancel
            </button>
          </div>
          <ul className="project-picker-results">
            {filtered.length === 0 && (
              <li style={{ padding: '9px 14px', fontSize: 13, color: 'var(--text-3)' }}>No projects found</li>
            )}
            {filtered.map(p => (
              <li key={p.key}>
                <button type="button" className="project-picker-result" onClick={() => select(p.key)}>
                  <span>{p.name}</span>
                  <span className="project-picker-key">{p.key}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Tree helpers (Move) ──────────────────────────────────────────────────────

function countDescendants(nodes) {
  if (!nodes?.length) return 0;
  let total = nodes.length;
  for (const n of nodes) total += countDescendants(n.children);
  return total;
}

function treeAllSettled(node) {
  if (node.status !== 'done' && node.status !== 'error') return false;
  return (node.children ?? []).every(treeAllSettled);
}

function treeAllOk(node) {
  if (node.status !== 'done') return false;
  return (node.children ?? []).every(treeAllOk);
}

function allInTreeDone(node) {
  return treeAllOk(node);
}

function issueTypeColor(name) {
  const n = (name ?? '').toLowerCase();
  if (n.includes('request')) return '#ff8c1a';
  if (n.includes('epic'))    return '#a371f7';
  if (n.includes('task'))    return '#3b9eff';
  return 'var(--text-3)';
}

function getNodeIssueTypeName(node) {
  return node.raw?.fields?.issuetype?.name
      ?? node.source?.issueTypeName
      ?? node.issueTypeName
      ?? '';
}

function TypeIcon({ name }) {
  const n = (name ?? '').toLowerCase();
  const color = issueTypeColor(name);
  const baseStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 14, height: 14,
    marginRight: 6,
    flexShrink: 0,
    verticalAlign: -2,
    borderRadius: 3,
  };

  if (n.includes('epic')) {
    return (
      <span title={name || 'Epic'} style={baseStyle}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="0" y="0" width="16" height="16" rx="3" fill={color} />
          <path d="M9.2 2.5L4.5 9.2h2.9l-.6 4.3 4.7-6.7H8.6l.6-4.3z" fill="#fff" />
        </svg>
      </span>
    );
  }

  if (n.includes('task') || n.includes('story') || n.includes('sub-task') || n.includes('subtask')) {
    return (
      <span title={name || 'Task'} style={baseStyle}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="1" y="1" width="14" height="14" rx="3" fill={color} />
          <path d="M4.5 8.2l2.4 2.4 4.6-5" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }

  if (n.includes('request') || n.includes('bug')) {
    return (
      <span title={name || 'Request'} style={baseStyle}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <rect x="1" y="1" width="14" height="14" rx="3" fill={color} />
          <rect x="7.1" y="3.6" width="1.8" height="5.4" rx="0.6" fill="#fff" />
          <rect x="7.1" y="10.4" width="1.8" height="2"   rx="0.6" fill="#fff" />
        </svg>
      </span>
    );
  }

  // Fallback: filled rounded square
  return (
    <span title={name || 'Unknown'} style={baseStyle}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <rect x="1" y="1" width="14" height="14" rx="3" fill={color} />
      </svg>
    </span>
  );
}

function PreviewTreeNode({ node, depth }) {
  const typeName = getNodeIssueTypeName(node);
  return (
    <li style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 2, marginLeft: depth * 14, listStyle: 'none' }}>
      <TypeIcon name={typeName} />
      <strong style={{ color: 'var(--text-1)' }}>{node.key}</strong>
      {node.summary ? <> — {node.summary}</> : null}
      {node.children?.length > 0 && (
        <ul style={{ margin: '2px 0 0', paddingLeft: 0 }}>
          {node.children.map(c => (
            <PreviewTreeNode key={c.key} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ConfirmTreeNode({ node, depth }) {
  const typeName = getNodeIssueTypeName(node);
  return (
    <li style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4, marginLeft: depth * 18, listStyle: 'none' }}>
      <TypeIcon name={typeName} />
      <strong style={{ color: 'var(--text-1)' }}>{node.key}</strong>
      {node.summary ? <> — {node.summary}</> : null}
      {node.children?.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 0 }}>
          {node.children.map(c => (
            <ConfirmTreeNode key={c.key} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function MoveResultNode({ node, depth }) {
  const status = node.status === 'idle'
    ? 'idle'
    : node.status === 'running' ? 'pending' : node.status;
  const isRoot = depth === 0;
  return (
    <li
      className={isRoot ? 'step-item' : undefined}
      style={isRoot
        ? undefined
        : { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4, marginLeft: depth * 18 }}
    >
      <StepIcon status={status} />
      <div className={isRoot ? 'step-body' : undefined}>
        {isRoot ? (
          <>
            <p className="step-name">{node.key}</p>
            {node.newKey && (
              <a className="step-link" href={node.newUrl} target="_blank" rel="noreferrer">
                → {node.newKey} ↗
              </a>
            )}
            {node.error && <p className="step-error">{node.error}</p>}
          </>
        ) : (
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {node.key}
            {node.newKey && (
              <> → <a className="step-link" href={node.newUrl} target="_blank" rel="noreferrer">
                {node.newKey} ↗
              </a></>
            )}
            {node.error && <span className="step-error"> {node.error}</span>}
          </span>
        )}
        {node.children?.length > 0 && (
          <ul style={{ listStyle: 'none', padding: isRoot ? '6px 0 0' : '4px 0 0', margin: 0 }}>
            {node.children.map(c => (
              <MoveResultNode key={c.key} node={c} depth={depth + 1} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

// ─── Shared issue list (Move) ─────────────────────────────────────────────────

function IssueList({ items, onKeyChange, onLoad, onRemove, onAdd, showChildren }) {
  return (
    <div className="field">
      <label className="field-label">Issue Keys</label>
      {items.map(item => (
        <div key={item.id} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="input"
              placeholder="e.g. NSMG-8244"
              value={item.key}
              onChange={e => onKeyChange(item.id, e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !item.loading) onLoad(item.id); }}
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-ghost"
              onClick={() => onLoad(item.id)}
              disabled={!item.key.trim() || item.loading}
              style={{ flexShrink: 0 }}
            >
              {item.loading ? <span className="spinner" /> : 'Load'}
            </button>
            {items.length > 1 && (
              <button
                className="btn btn-ghost"
                onClick={() => onRemove(item.id)}
                style={{ flexShrink: 0 }}
                title="Remove"
              >
                ×
              </button>
            )}
          </div>
          {item.source && (() => {
            const total = showChildren ? countDescendants(item.children) : 0;
            return (
              <div style={{ fontSize: 12, color: 'var(--text-2)', margin: '4px 0 0 2px' }}>
                <p style={{ margin: 0 }}>
                  ✓ <TypeIcon name={item.source.issueTypeName} />
                  <strong>{item.source.key}</strong> — {item.source.summary}
                  {showChildren && item.loadingChildren && (
                    <span style={{ color: 'var(--text-3)' }}> (loading descendants…)</span>
                  )}
                  {showChildren && !item.loadingChildren && total > 0 && (
                    <span style={{ color: 'var(--text-3)' }}> + {total} descendant{total !== 1 ? 's' : ''}</span>
                  )}
                </p>
                {showChildren && !item.loadingChildren && item.children?.length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {item.children.map(c => (
                      <PreviewTreeNode key={c.key} node={c} depth={0} />
                    ))}
                  </ul>
                )}
              </div>
            );
          })()}
          {item.loadErr && (
            <p className="error-msg" style={{ marginTop: 4 }}>⚠ {item.loadErr}</p>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={onAdd} style={{ marginTop: 4 }}>
        + Add Issue
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TaskAgentApp({ user, onLogout }) {
  const [mode, setMode] = useState('clone');

  // Clone state
  const [issueKey,      setIssueKey]      = useState('');
  const [source,        setSource]        = useState(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [loadErr,       setLoadErr]       = useState('');
  const [cloneSummary,  setCloneSummary]  = useState('');

  // Clone user pickers
  const [userFields,        setUserFields]        = useState([]);
  const [userSelections,    setUserSelections]     = useState({});
  const [loadingUserFields, setLoadingUserFields]  = useState(false);

  // Clone sprint picker
  const [sprintFieldId,    setSprintFieldId]    = useState(null);
  const [sourceSprint,     setSourceSprint]     = useState(null);
  const [availableSprints, setAvailableSprints] = useState([]);
  const [selectedSprint,   setSelectedSprint]   = useState(null);
  const [loadingSprints,   setLoadingSprints]   = useState(false);
  const [sprintLoadErr,    setSprintLoadErr]    = useState('');

  // Clone extra fields (status / labels / components / estimates)
  const [availableStatuses,   setAvailableStatuses]   = useState([]);
  const [selectedStatus,      setSelectedStatus]      = useState('');
  const [sourceStatus,        setSourceStatus]        = useState('');
  const [labelsInput,         setLabelsInput]         = useState('');
  const [availableComponents, setAvailableComponents] = useState([]);
  const [selectedComponents,  setSelectedComponents]  = useState([]);
  const [estimateFields,      setEstimateFields]      = useState([]);

  // Move state
  const moveIdRef = useRef(1);
  const [moveItems, setMoveItems] = useState([{ id: 0, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }]);

  // Shared
  const [targetProject,   setTargetProject]   = useState('');
  const [projects,        setProjects]        = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Operation
  const [running,      setRunning]      = useState(false);
  const [steps,        setSteps]        = useState([]);
  const [moveResults,  setMoveResults]  = useState([]);
  const [moveProgress, setMoveProgress] = useState(null);
  const [result,       setResult]       = useState(null);
  const [showProgress, setShowProgress] = useState(false);
  const [showConfirm,  setShowConfirm]  = useState(false);

  useEffect(() => {
    if (!CLOUD_ID) return;
    setLoadingProjects(true);
    getJiraProjects(CLOUD_ID)
      .then(list => setProjects(list))
      .catch(() => {})
      .finally(() => setLoadingProjects(false));
  }, []);

  const onStep = useCallback((i, status, error = null, data = null) => {
    setSteps(prev => {
      const next = [...prev];
      next[i] = { status, error, data };
      return next;
    });
  }, []);

  function resetSource() {
    setSource(null);
    setUserFields([]);
    setUserSelections({});
    setLoadErr('');
    setCloneSummary('');
    setSprintFieldId(null);
    setSourceSprint(null);
    setAvailableSprints([]);
    setSelectedSprint(null);
    setSprintLoadErr('');
    setAvailableStatuses([]);
    setSelectedStatus('');
    setSourceStatus('');
    setLabelsInput('');
    setAvailableComponents([]);
    setSelectedComponents([]);
    setEstimateFields([]);
  }

  function handleModeChange(m) {
    setMode(m);
    setIssueKey('');
    setTargetProject('');
    resetSource();
    setMoveItems([{ id: 0, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }]);
  }

  async function handleLoad() {
    const raw = issueKey.trim().toUpperCase();
    if (!raw) return;
    setLoadingSource(true);
    resetSource();
    try {
      const issue = await loadIssue(CLOUD_ID, raw);
      setSource(issue);
      setIssueKey(issue.key);
      setCloneSummary(issue.summary);

      const sprintInfo = findSprintField(issue.raw.fields);
      const detectedSprintFieldId = sprintInfo?.fieldId ?? 'customfield_10020';
      setSprintFieldId(detectedSprintFieldId);
      if (sprintInfo) {
        setSourceSprint(sprintInfo.current);
        setSelectedSprint(sprintInfo.current.id);
      }

      setLoadingSprints(true);
      setSprintLoadErr('');
      loadSprintsForProject(CLOUD_ID, issue.projectKey)
        .then(sprints => {
          console.log('[sprint] loaded', sprints.length, sprints);
          setAvailableSprints(sprints);
        })
        .catch(err => {
          console.error('[sprint] load failed:', err);
          setSprintLoadErr(err.message);
        })
        .finally(() => setLoadingSprints(false));

      setLoadingUserFields(true);
      loadCloneFields(CLOUD_ID, issue.projectKey, issue.issueTypeId, issue.raw.fields)
        .then(({ userFields, estimateFields }) => {
          setUserFields(userFields);
          const initial = {};
          for (const f of userFields) initial[f.id] = f.current;
          setUserSelections(initial);
          setEstimateFields(estimateFields.map(f => ({ ...f, value: f.current ?? '' })));
        })
        .catch(() => {})
        .finally(() => setLoadingUserFields(false));

      // Extra clone fields, prefilled from the source issue.
      const statusName = issue.raw.fields.status?.name ?? '';
      setSourceStatus(statusName);
      setSelectedStatus(statusName);
      loadStatusesForIssueType(CLOUD_ID, issue.projectKey, issue.issueTypeId, issue.key)
        .then(setAvailableStatuses)
        .catch(() => {});

      setLabelsInput((issue.labels ?? []).join(', '));
      setSelectedComponents((issue.raw.fields.components ?? []).map(c => ({ id: c.id, name: c.name })));
      getProjectComponents(CLOUD_ID, issue.projectKey)
        .then(setAvailableComponents)
        .catch(() => {});
    } catch (err) {
      setLoadErr(err.message);
    } finally {
      setLoadingSource(false);
    }
  }

  // ─── Move item helpers ────────────────────────────────────────────────────

  function addMoveItem() {
    const id = moveIdRef.current++;
    setMoveItems(prev => [...prev, { id, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }]);
  }

  function removeMoveItem(id) {
    setMoveItems(prev => prev.filter(m => m.id !== id));
  }

  function updateMoveItemKey(id, key) {
    setMoveItems(prev => prev.map(m => m.id === id ? { ...m, key, source: null, loadErr: '', children: [], loadingChildren: false } : m));
  }

  async function loadDescendantsTree(parentKey) {
    const childIssues = await getChildIssues(CLOUD_ID, parentKey);
    return Promise.all(childIssues.map(async ci => ({
      key: ci.key,
      summary: ci.fields?.summary ?? '',
      raw: ci,
      children: await loadDescendantsTree(ci.key),
    })));
  }

  async function loadMoveItem(id) {
    const item = moveItems.find(m => m.id === id);
    const raw  = item?.key.trim().toUpperCase();
    if (!raw) return;
    setMoveItems(prev => prev.map(m => m.id === id ? { ...m, loading: true, source: null, loadErr: '', children: [], loadingChildren: false } : m));
    try {
      const issue = await loadIssue(CLOUD_ID, raw);
      setMoveItems(prev => prev.map(m => m.id === id ? { ...m, key: issue.key, source: issue, loading: false, loadingChildren: true } : m));
      try {
        const children = await loadDescendantsTree(issue.key);
        setMoveItems(prev => prev.map(m => m.id === id ? { ...m, children, loadingChildren: false } : m));
      } catch {
        setMoveItems(prev => prev.map(m => m.id === id ? { ...m, loadingChildren: false } : m));
      }
    } catch (err) {
      setMoveItems(prev => prev.map(m => m.id === id ? { ...m, loadErr: err.message, loading: false } : m));
    }
  }

  // ─── Build field overrides (clone) ────────────────────────────────────────

  function buildFieldOverrides() {
    const overrides = {};
    for (const [fieldId, sel] of Object.entries(userSelections)) {
      overrides[fieldId] = sel ? { accountId: sel.accountId } : null;
    }
    if (sprintFieldId) {
      if (selectedSprint !== null) {
        overrides[sprintFieldId] = selectedSprint;
      } else if (sourceSprint) {
        overrides[sprintFieldId] = undefined;
      }
    }
    const labels = labelsInput.split(',').map(s => s.trim()).filter(Boolean);
    overrides.labels = labels.length ? labels : undefined;
    overrides.components = selectedComponents.length
      ? selectedComponents.map(c => ({ id: String(c.id) }))
      : undefined;
    for (const f of estimateFields) {
      const num = f.value === '' || f.value === null ? undefined : Number(f.value);
      overrides[f.id] = Number.isFinite(num) ? num : undefined;
    }
    return overrides;
  }

  // ─── Execute actions ──────────────────────────────────────────────────────

  async function executeClone() {
    setSteps(CLONE_STEP_LABELS.map(() => ({ status: 'idle' })));
    setResult(null);
    setRunning(true);
    setShowProgress(true);
    try {
      const res = await cloneInSameProject(
        CLOUD_ID, source,
        {
          summaryOverride:  cloneSummary || source.summary,
          fieldOverrides:   buildFieldOverrides(),
          targetStatusName: selectedStatus || null,
        },
        onStep,
      );
      setResult(res);
    } catch { /* step errors shown in modal */ }
    finally { setRunning(false); }
  }

  async function executeMove() {
    setShowConfirm(false);
    const loaded = moveItems.filter(m => m.source);

    function buildResultNode(node) {
      return {
        key: node.key,
        status: 'running',
        newKey: null,
        newUrl: null,
        error: null,
        children: (node.children ?? []).map(buildResultNode),
      };
    }
    setMoveResults(loaded.map(buildResultNode));
    setMoveProgress({ pct: 0, status: 'ENQUEUED' });
    setRunning(true);
    setShowProgress(true);

    // Apply a per-node transform across the whole result tree.
    const mapTree = (tree, fn) =>
      tree.map(n => ({ ...fn(n), children: mapTree(n.children ?? [], fn) }));

    try {
      // One native bulk move for the whole forest — Jira preserves comments,
      // attachments, worklogs, history and status. Issue IDs are stable, so new
      // keys are resolved by ID inside bulkMoveForest.
      const results = await bulkMoveForest(CLOUD_ID, loaded, targetProject, (pct, status) => {
        setMoveProgress({ pct, status });
      });
      setMoveResults(prev => mapTree(prev, n => {
        const r = results.get(n.key);
        return r?.newKey
          ? { ...n, status: 'done', newKey: r.newKey, newUrl: r.newUrl }
          : { ...n, status: 'error', error: 'Moved, but new key could not be resolved' };
      }));
    } catch (err) {
      // The Bulk Move API is unavailable (no permission / not on this plan / bad
      // mapping) and nothing was moved yet → fall back to legacy clone+delete.
      // Any other error means the move may be partially applied, so we surface it
      // rather than risk duplicating issues.
      if (err.bulkUnavailable) {
        setMoveProgress(null);
        await legacyMoveFallback(loaded);
      } else {
        setMoveResults(prev => mapTree(prev, n => ({ ...n, status: 'error', error: err.message })));
      }
    } finally {
      setMoveProgress(null);
      setRunning(false);
    }
  }

  // Legacy recursive clone+delete move (parent first, then re-parent children).
  // Lossy vs. native move (comments/attachments/history not carried) — used only
  // as a fallback when the Bulk Move API can't be used.
  async function legacyMoveFallback(loaded) {
    function patchNode(tree, key, patch) {
      return tree.map(n => {
        if (n.key === key) return { ...n, ...patch };
        if (n.children?.length) return { ...n, children: patchNode(n.children, key, patch) };
        return n;
      });
    }
    function markSubtreeFailed(tree, key) {
      return tree.map(n => {
        if (n.key === key) {
          const fail = (children) => children.map(c => ({
            ...c, status: 'error', error: 'Parent move failed', children: fail(c.children ?? []),
          }));
          return { ...n, children: fail(n.children ?? []) };
        }
        if (n.children?.length) return { ...n, children: markSubtreeFailed(n.children, key) };
        return n;
      });
    }

    async function moveSubtree(node, parentKey) {
      setMoveResults(prev => patchNode(prev, node.key, { status: 'running' }));
      let newKey = null;
      try {
        const issueToMove = node.source ?? await loadIssue(CLOUD_ID, node.key);
        const res = await moveToProject(
          CLOUD_ID, issueToMove, targetProject, { fieldOverrides: {}, parentKey }, () => {},
        );
        newKey = res.newKey;
        setMoveResults(prev => patchNode(prev, node.key, {
          status: 'done', newKey: res.newKey, newUrl: res.newUrl,
        }));
      } catch (err) {
        setMoveResults(prev => patchNode(prev, node.key, { status: 'error', error: err.message }));
        setMoveResults(prev => markSubtreeFailed(prev, node.key));
        return;
      }
      for (const child of node.children ?? []) {
        await moveSubtree(child, newKey);
      }
    }

    for (const root of loaded) {
      await moveSubtree(root, null);
    }
  }

  function handleAction() {
    if (mode === 'clone') executeClone();
    else setShowConfirm(true);
  }

  function handleCloseModal() {
    if (running) return;
    setShowProgress(false);
    if (mode === 'clone') {
      setSteps([]);
      setResult(null);
      if (result) { resetSource(); setIssueKey(''); }
    } else if (mode === 'move') {
      const rootDoneKeys = new Set(
        moveResults
          .filter(r => r.status === 'done' && allInTreeDone(r))
          .map(r => r.key),
      );
      setMoveResults([]);
      setMoveItems(prev => {
        const remaining = prev.filter(m => !rootDoneKeys.has(m.key));
        return remaining.length > 0
          ? remaining
          : [{ id: moveIdRef.current++, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }];
      });
    }
  }

  // ─── Derived state ────────────────────────────────────────────────────────

  const loadedMoveItems    = moveItems.filter(m => m.source);
  const anyLoadingChildren = moveItems.some(m => m.loadingChildren);

  const canRun = mode === 'clone'
    ? !!source && !running && !loadingUserFields && !loadingSprints
    : loadedMoveItems.length > 0 && !running && !!targetProject && !anyLoadingChildren;

  const allCloneDone = steps.length > 0 && steps.every(s => s?.status === 'done' || s?.status === 'skipped');
  const hasCloneErr  = steps.some(s => s?.status === 'error');
  const allMoveDone  = moveResults.length > 0 && moveResults.every(treeAllSettled);
  const allMoveOk    = moveResults.length > 0 && moveResults.every(treeAllOk);

  const modalTitle = mode === 'clone'
    ? running
      ? 'Cloning issue…'
      : result
        ? (hasCloneErr ? '✓ Cloned (with warnings)' : '✓ Cloned successfully')
        : '⚠ Error'
    : running
      ? `Moving to ${targetProject}…`
      : allMoveDone
        ? (allMoveOk ? '✓ Moved successfully' : '✓ Moved (with errors)')
        : 'Moving…';

  return (
    <div className="app-shell">

      {/* ── Header ── */}
      <header className="header">
        <div className="header-logo">
          <img src={LOGO} alt="Dynamica Labs" />
        </div>
        <div className="header-sep" />
        <span className="header-title">Jira Agent</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>
          Sign out
        </button>
      </header>

      {/* ── Main ── */}
      <main className="main">
        <div className="task-card" style={{ maxWidth: 680 }}>

          <div className="card-heading">
            <h2 className="card-title">
              {mode === 'clone' ? 'Clone Issue' : 'Move Issues'}
            </h2>
            <p className="card-sub">
              {mode === 'clone'
                ? 'Duplicate a Jira issue with all its fields into the same project'
                : 'Move one or more Jira issues (with children) to a different project'}
            </p>
          </div>

          {/* Operation toggle */}
          <div className="field" style={{ marginBottom: 24 }}>
            <label className="field-label">Operation</label>
            <div className="segment">
              <button type="button"
                className={`seg-btn ${mode === 'clone' ? 'active' : ''}`}
                onClick={() => handleModeChange('clone')}>
                Clone
              </button>
              <button type="button"
                className={`seg-btn ${mode === 'move' ? 'active' : ''}`}
                onClick={() => handleModeChange('move')}>
                Move
              </button>
            </div>
          </div>

          {/* ── Clone mode ── */}
          {mode === 'clone' && (
            <>
              <div className="field">
                <label className="field-label">Issue Key</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    className="input"
                    placeholder="e.g. NSMG-8244"
                    value={issueKey}
                    onChange={e => { setIssueKey(e.target.value); resetSource(); }}
                    onKeyDown={e => { if (e.key === 'Enter' && !loadingSource) handleLoad(); }}
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn-ghost"
                    onClick={handleLoad}
                    disabled={!issueKey.trim() || loadingSource}
                    style={{ flexShrink: 0 }}
                  >
                    {loadingSource ? <span className="spinner" /> : 'Load'}
                  </button>
                </div>
                {loadErr && <p className="error-msg">⚠ {loadErr}</p>}
              </div>

              {source && <IssuePreview issue={source} />}

              {source && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label className="field-label">Clone Name</label>
                  <input
                    className="input"
                    value={cloneSummary}
                    onChange={e => setCloneSummary(e.target.value)}
                    placeholder="Enter clone name…"
                  />
                </div>
              )}

              {source && (
                <div style={{ marginTop: 20 }}>
                  {loadingUserFields ? (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--text-3)', fontSize: 13 }}>
                      <span className="spinner" />
                      Loading people fields…
                    </div>
                  ) : userFields.length > 0 ? (
                    <>
                      <p className="field-label" style={{ marginBottom: 12 }}>People</p>
                      {userFields.map(f => (
                        <UserPicker
                          key={f.id}
                          cloudId={CLOUD_ID}
                          label={f.name}
                          value={userSelections[f.id] ?? null}
                          onChange={val => setUserSelections(prev => {
                            const next = { ...prev, [f.id]: val };
                            if (f.name === 'Assignee' || f.id === 'assignee') {
                              const devField = userFields.find(uf => uf.name === 'Developer');
                              if (devField) next[devField.id] = val;
                            }
                            return next;
                          })}
                        />
                      ))}
                    </>
                  ) : null}
                </div>
              )}

              {source && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label className="field-label">Sprint</label>
                  {loadingSprints ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13, height: 40 }}>
                      <span className="spinner" /> Loading sprints…
                    </div>
                  ) : sprintLoadErr ? (
                    <p style={{ fontSize: 13, color: 'var(--text-3)', padding: '10px 12px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', margin: 0 }}>
                      ⚠ Could not load sprints: {sprintLoadErr}
                    </p>
                  ) : (
                    <select
                      className="select"
                      value={selectedSprint ?? ''}
                      onChange={e => setSelectedSprint(e.target.value ? Number(e.target.value) : null)}
                    >
                      <option value="">— No sprint —</option>
                      {sourceSprint && !availableSprints.some(s => s.id === sourceSprint.id) && (
                        <option value={sourceSprint.id}>{sourceSprint.name} (current)</option>
                      )}
                      {availableSprints.length === 0 && (
                        <option disabled value="">No active sprints found</option>
                      )}
                      {availableSprints.map(s => (
                        <option key={s.id} value={s.id}>
                          {s.name}{s.state === 'active' ? ' ★' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              {source && availableStatuses.length > 0 && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label className="field-label">Status</label>
                  <select
                    className="select"
                    value={selectedStatus}
                    onChange={e => setSelectedStatus(e.target.value)}
                  >
                    {sourceStatus && !availableStatuses.some(s => s.name === sourceStatus) && (
                      <option value={sourceStatus}>{sourceStatus} (current)</option>
                    )}
                    {availableStatuses.map(s => (
                      <option key={s.id} value={s.name}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}

              {source && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label className="field-label">Labels</label>
                  <input
                    className="input"
                    value={labelsInput}
                    onChange={e => setLabelsInput(e.target.value)}
                    placeholder="label1, label2"
                  />
                </div>
              )}

              {source && (availableComponents.length > 0 || selectedComponents.length > 0) && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label className="field-label">Components</label>
                  {selectedComponents.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                      {selectedComponents.map(c => (
                        <span
                          key={c.id}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', fontSize: 13 }}
                        >
                          {c.name}
                          <button
                            type="button"
                            onClick={() => setSelectedComponents(prev => prev.filter(x => x.id !== c.id))}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, fontSize: 14, lineHeight: 1 }}
                            aria-label={`Remove ${c.name}`}
                          >×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  {availableComponents.some(c => !selectedComponents.some(x => x.id === c.id)) && (
                    <select
                      className="select"
                      value=""
                      onChange={e => {
                        const c = availableComponents.find(x => String(x.id) === e.target.value);
                        if (c) setSelectedComponents(prev => [...prev, { id: c.id, name: c.name }]);
                      }}
                    >
                      <option value="">+ Add component…</option>
                      {availableComponents
                        .filter(c => !selectedComponents.some(x => x.id === c.id))
                        .map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </div>
              )}

              {source && estimateFields.map(f => (
                <div className="field" style={{ marginTop: 16 }} key={f.id}>
                  <label className="field-label">{f.name}</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="0.5"
                    value={f.value}
                    onChange={e => setEstimateFields(prev => prev.map(x => x.id === f.id ? { ...x, value: e.target.value } : x))}
                    placeholder="—"
                  />
                </div>
              ))}

              {source && (
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 24, width: '100%' }}
                  disabled={!canRun}
                  onClick={handleAction}
                >
                  Clone Issue ↗
                </button>
              )}
            </>
          )}

          {/* ── Move mode ── */}
          {mode === 'move' && (
            <>
              <IssueList
                items={moveItems}
                onKeyChange={updateMoveItemKey}
                onLoad={loadMoveItem}
                onRemove={removeMoveItem}
                onAdd={addMoveItem}
                showChildren
              />

              {loadedMoveItems.length > 0 && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label className="field-label">Target Project</label>
                  <ProjectPicker
                    projects={projects}
                    value={targetProject}
                    onChange={setTargetProject}
                    loading={loadingProjects}
                  />
                </div>
              )}

              {loadedMoveItems.length > 0 && (
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 24, width: '100%' }}
                  disabled={!canRun}
                  onClick={handleAction}
                >
                  {targetProject
                    ? `Move ${loadedMoveItems.length} Issue${loadedMoveItems.length !== 1 ? 's' : ''} to ${targetProject} ↗`
                    : 'Move Issues ↗'}
                </button>
              )}
            </>
          )}

        </div>
      </main>

      {/* ── Confirmation modal (Move) ── */}
      {showConfirm && (
        <div className="overlay">
          <div className="modal">
            <p className="modal-title">Confirm Move</p>
            <p style={{ color: 'var(--text-2)', margin: '12px 0 8px', lineHeight: 1.6, fontSize: 14 }}>
              The following issue{loadedMoveItems.length !== 1 ? 's' : ''} will be moved to{' '}
              <strong style={{ color: 'var(--text-1)' }}>{targetProject}</strong> and{' '}
              <strong style={{ color: 'var(--red)' }}>permanently deleted</strong> from their current project{loadedMoveItems.length !== 1 ? 's' : ''}.
            </p>
            <ul style={{ margin: '0 0 20px', paddingLeft: 0 }}>
              {loadedMoveItems.map(m => (
                <ConfirmTreeNode
                  key={m.key}
                  node={{
                    key: m.key,
                    summary: m.source.summary,
                    issueTypeName: m.source.issueTypeName,
                    children: m.children,
                  }}
                  depth={0}
                />
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary" onClick={executeMove} style={{ flex: 1 }}>
                Yes, Move
              </button>
              <button className="btn btn-ghost" onClick={() => setShowConfirm(false)} style={{ flex: 1 }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Progress modal ── */}
      {showProgress && (
        <div className="overlay">
          <div className="modal">
            <p className="modal-title">{modalTitle}</p>

            {mode === 'clone' && (
              <>
                <ul className="step-list">
                  {CLONE_STEP_LABELS.map((label, i) => {
                    const s = steps[i] ?? {};
                    return (
                      <li key={label} className="step-item">
                        <StepIcon status={s.status} />
                        <div className="step-body">
                          <p className="step-name">{label}</p>
                          {s.data?.jiraKey && (
                            <a className="step-link" href={s.data.jiraUrl} target="_blank" rel="noreferrer">
                              {s.data.jiraKey} ↗
                            </a>
                          )}
                          {s.error && <p className="step-error">{s.error}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>

                {result && (
                  <div className="result-links" style={{ marginTop: 16 }}>
                    <div className="result-link-row">
                      <span className="result-link-label">Clone</span>
                      <a className="result-link-anchor" href={result.newUrl} target="_blank" rel="noreferrer">
                        {result.newKey} ↗
                      </a>
                    </div>
                  </div>
                )}

                {!running && (allCloneDone || hasCloneErr || result) && (
                  <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={handleCloseModal}>
                    {result ? 'Done' : 'Close'}
                  </button>
                )}
              </>
            )}

            {mode === 'move' && (
              <>
                {running && moveProgress && (
                  <p style={{ color: 'var(--text-2)', fontSize: 13, margin: '4px 0 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="spinner" />
                    Native move in progress… {moveProgress.pct}% ({moveProgress.status})
                  </p>
                )}
                <ul className="step-list" style={{ marginTop: 12 }}>
                  {moveResults.map(r => (
                    <MoveResultNode key={r.key} node={r} depth={0} />
                  ))}
                </ul>

                {!running && allMoveDone && (
                  <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={handleCloseModal}>
                    Done
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
