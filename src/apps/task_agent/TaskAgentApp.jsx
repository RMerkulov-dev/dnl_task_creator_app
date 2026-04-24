import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getJiraProjects, searchJiraUsers, getChildIssues, deleteIssue } from '../../services/jira.js';
import { loadIssue, loadUserFields, findSprintField, loadSprintsForProject, cloneInSameProject, moveToProject } from './jiraAgent.js';

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

// ─── Shared issue list (Move / Delete) ────────────────────────────────────────

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
          {item.source && (
            <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '4px 0 0 2px' }}>
              ✓ <strong>{item.source.key}</strong> — {item.source.summary}
              {showChildren && item.loadingChildren && (
                <span style={{ color: 'var(--text-3)' }}> (loading children…)</span>
              )}
              {showChildren && !item.loadingChildren && item.children?.length > 0 && (
                <span> + {item.children.length} child issue{item.children.length !== 1 ? 's' : ''}</span>
              )}
            </p>
          )}
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

  // Move state
  const moveIdRef = useRef(1);
  const [moveItems, setMoveItems] = useState([{ id: 0, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }]);

  // Delete state
  const deleteIdRef = useRef(1);
  const [deleteItems, setDeleteItems] = useState([{ id: 0, key: '', source: null, loadErr: '', loading: false }]);
  const [deleteResults, setDeleteResults] = useState([]);

  // Shared
  const [targetProject,   setTargetProject]   = useState('');
  const [projects,        setProjects]        = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);

  // Operation
  const [running,      setRunning]      = useState(false);
  const [steps,        setSteps]        = useState([]);
  const [moveResults,  setMoveResults]  = useState([]);
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
  }

  function handleModeChange(m) {
    setMode(m);
    setIssueKey('');
    setTargetProject('');
    resetSource();
    setMoveItems([{ id: 0, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }]);
    setDeleteItems([{ id: 0, key: '', source: null, loadErr: '', loading: false }]);
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
      loadUserFields(CLOUD_ID, issue.projectKey, issue.issueTypeId, issue.raw.fields)
        .then(fields => {
          setUserFields(fields);
          const initial = {};
          for (const f of fields) initial[f.id] = f.current;
          setUserSelections(initial);
        })
        .catch(() => {})
        .finally(() => setLoadingUserFields(false));
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

  async function loadMoveItem(id) {
    const item = moveItems.find(m => m.id === id);
    const raw  = item?.key.trim().toUpperCase();
    if (!raw) return;
    setMoveItems(prev => prev.map(m => m.id === id ? { ...m, loading: true, source: null, loadErr: '', children: [], loadingChildren: false } : m));
    try {
      const issue = await loadIssue(CLOUD_ID, raw);
      setMoveItems(prev => prev.map(m => m.id === id ? { ...m, key: issue.key, source: issue, loading: false, loadingChildren: true } : m));
      try {
        const childIssues = await getChildIssues(CLOUD_ID, issue.key);
        const children = childIssues.map(ci => ({ key: ci.key, summary: ci.fields?.summary ?? '', raw: ci }));
        setMoveItems(prev => prev.map(m => m.id === id ? { ...m, children, loadingChildren: false } : m));
      } catch {
        setMoveItems(prev => prev.map(m => m.id === id ? { ...m, loadingChildren: false } : m));
      }
    } catch (err) {
      setMoveItems(prev => prev.map(m => m.id === id ? { ...m, loadErr: err.message, loading: false } : m));
    }
  }

  // ─── Delete item helpers ──────────────────────────────────────────────────

  function addDeleteItem() {
    const id = deleteIdRef.current++;
    setDeleteItems(prev => [...prev, { id, key: '', source: null, loadErr: '', loading: false }]);
  }

  function removeDeleteItem(id) {
    setDeleteItems(prev => prev.filter(d => d.id !== id));
  }

  function updateDeleteItemKey(id, key) {
    setDeleteItems(prev => prev.map(d => d.id === id ? { ...d, key, source: null, loadErr: '' } : d));
  }

  async function loadDeleteItem(id) {
    const item = deleteItems.find(d => d.id === id);
    const raw  = item?.key.trim().toUpperCase();
    if (!raw) return;
    setDeleteItems(prev => prev.map(d => d.id === id ? { ...d, loading: true, source: null, loadErr: '' } : d));
    try {
      const issue = await loadIssue(CLOUD_ID, raw);
      setDeleteItems(prev => prev.map(d => d.id === id ? { ...d, key: issue.key, source: issue, loading: false } : d));
    } catch (err) {
      setDeleteItems(prev => prev.map(d => d.id === id ? { ...d, loadErr: err.message, loading: false } : d));
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
        { summaryOverride: cloneSummary || source.summary, fieldOverrides: buildFieldOverrides() },
        onStep,
      );
      setResult(res);
    } catch { /* step errors shown in modal */ }
    finally { setRunning(false); }
  }

  async function executeMove() {
    setShowConfirm(false);
    const loaded = moveItems.filter(m => m.source);
    setMoveResults(loaded.map(m => ({
      key: m.key, status: 'idle', newKey: null, newUrl: null, error: null,
      children: m.children.map(c => ({ key: c.key, summary: c.summary, status: 'idle', newKey: null, newUrl: null, error: null })),
    })));
    setRunning(true);
    setShowProgress(true);

    for (let i = 0; i < loaded.length; i++) {
      setMoveResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'running' } : r));
      let newParentKey = null;
      try {
        const res = await moveToProject(CLOUD_ID, loaded[i].source, targetProject, { fieldOverrides: {} }, () => {});
        newParentKey = res.newKey;
        setMoveResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'done', newKey: res.newKey, newUrl: res.newUrl } : r));
      } catch (err) {
        setMoveResults(prev => prev.map((r, idx) => idx === i
          ? { ...r, status: 'error', error: err.message, children: r.children.map(c => ({ ...c, status: 'error', error: 'Parent move failed' })) }
          : r));
        continue;
      }

      const childList = loaded[i].children;
      for (let j = 0; j < childList.length; j++) {
        setMoveResults(prev => prev.map((r, idx) => idx === i
          ? { ...r, children: r.children.map((c, ci) => ci === j ? { ...c, status: 'running' } : c) }
          : r));
        try {
          const childIssue = await loadIssue(CLOUD_ID, childList[j].key);
          const childRes   = await moveToProject(CLOUD_ID, childIssue, targetProject, { fieldOverrides: {}, parentKey: newParentKey }, () => {});
          setMoveResults(prev => prev.map((r, idx) => idx === i
            ? { ...r, children: r.children.map((c, ci) => ci === j ? { ...c, status: 'done', newKey: childRes.newKey, newUrl: childRes.newUrl } : c) }
            : r));
        } catch (err) {
          setMoveResults(prev => prev.map((r, idx) => idx === i
            ? { ...r, children: r.children.map((c, ci) => ci === j ? { ...c, status: 'error', error: err.message } : c) }
            : r));
        }
      }
    }
    setRunning(false);
  }

  async function executeDelete() {
    setShowConfirm(false);
    const loaded = deleteItems.filter(d => d.source);
    setDeleteResults(loaded.map(d => ({ key: d.key, summary: d.source.summary, status: 'idle', error: null })));
    setRunning(true);
    setShowProgress(true);

    for (let i = 0; i < loaded.length; i++) {
      setDeleteResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'running' } : r));
      try {
        await deleteIssue(CLOUD_ID, loaded[i].key);
        setDeleteResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'done' } : r));
      } catch (err) {
        setDeleteResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'error', error: err.message } : r));
      }
    }
    setRunning(false);
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
      const doneKeys = new Set(moveResults.filter(r => r.status === 'done').map(r => r.key));
      setMoveResults([]);
      setMoveItems(prev => {
        const remaining = prev.filter(m => !doneKeys.has(m.key));
        return remaining.length > 0
          ? remaining
          : [{ id: moveIdRef.current++, key: '', source: null, loadErr: '', loading: false, children: [], loadingChildren: false }];
      });
    } else {
      const doneKeys = new Set(deleteResults.filter(r => r.status === 'done').map(r => r.key));
      setDeleteResults([]);
      setDeleteItems(prev => {
        const remaining = prev.filter(d => !doneKeys.has(d.key));
        return remaining.length > 0
          ? remaining
          : [{ id: deleteIdRef.current++, key: '', source: null, loadErr: '', loading: false }];
      });
    }
  }

  // ─── Derived state ────────────────────────────────────────────────────────

  const loadedMoveItems    = moveItems.filter(m => m.source);
  const loadedDeleteItems  = deleteItems.filter(d => d.source);
  const anyLoadingChildren = moveItems.some(m => m.loadingChildren);

  const canRun = mode === 'clone'
    ? !!source && !running && !loadingUserFields && !loadingSprints
    : mode === 'move'
      ? loadedMoveItems.length > 0 && !running && !!targetProject && !anyLoadingChildren
      : loadedDeleteItems.length > 0 && !running;

  const allCloneDone = steps.length > 0 && steps.every(s => s?.status === 'done' || s?.status === 'skipped');
  const hasCloneErr  = steps.some(s => s?.status === 'error');
  const allMoveDone  = moveResults.length > 0 && moveResults.every(r =>
    (r.status === 'done' || r.status === 'error') &&
    r.children.every(c => c.status === 'done' || c.status === 'error'));
  const allDeleteDone = deleteResults.length > 0 && deleteResults.every(r => r.status === 'done' || r.status === 'error');

  const modalTitle = mode === 'clone'
    ? running
      ? 'Cloning issue…'
      : result
        ? (hasCloneErr ? '✓ Cloned (with warnings)' : '✓ Cloned successfully')
        : '⚠ Error'
    : mode === 'move'
      ? running
        ? `Moving to ${targetProject}…`
        : allMoveDone
          ? (moveResults.every(r => r.status === 'done') ? '✓ Moved successfully' : '✓ Moved (with errors)')
          : 'Moving…'
      : running
        ? 'Deleting issues…'
        : allDeleteDone
          ? (deleteResults.every(r => r.status === 'done') ? '✓ Deleted successfully' : '✓ Deleted (with errors)')
          : 'Deleting…';

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
              {mode === 'clone' ? 'Clone Issue' : mode === 'move' ? 'Move Issues' : 'Delete Issues'}
            </h2>
            <p className="card-sub">
              {mode === 'clone'
                ? 'Duplicate a Jira issue with all its fields into the same project'
                : mode === 'move'
                  ? 'Move one or more Jira issues (with children) to a different project'
                  : 'Permanently delete one or more Jira issues'}
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
              <button type="button"
                className={`seg-btn ${mode === 'delete' ? 'active' : ''}`}
                onClick={() => handleModeChange('delete')}>
                Delete
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

          {/* ── Delete mode ── */}
          {mode === 'delete' && (
            <>
              <IssueList
                items={deleteItems}
                onKeyChange={updateDeleteItemKey}
                onLoad={loadDeleteItem}
                onRemove={removeDeleteItem}
                onAdd={addDeleteItem}
                showChildren={false}
              />

              {loadedDeleteItems.length > 0 && (
                <button
                  className="btn btn-danger"
                  style={{ marginTop: 24, width: '100%' }}
                  disabled={!canRun}
                  onClick={handleAction}
                >
                  Delete {loadedDeleteItems.length} Issue{loadedDeleteItems.length !== 1 ? 's' : ''} ↗
                </button>
              )}
            </>
          )}

        </div>
      </main>

      {/* ── Confirmation modal (Move & Delete) ── */}
      {showConfirm && (
        <div className="overlay">
          <div className="modal">
            {mode === 'move' ? (
              <>
                <p className="modal-title">Confirm Move</p>
                <p style={{ color: 'var(--text-2)', margin: '12px 0 8px', lineHeight: 1.6, fontSize: 14 }}>
                  The following issue{loadedMoveItems.length !== 1 ? 's' : ''} will be moved to{' '}
                  <strong style={{ color: 'var(--text-1)' }}>{targetProject}</strong> and{' '}
                  <strong style={{ color: 'var(--red)' }}>permanently deleted</strong> from their current project{loadedMoveItems.length !== 1 ? 's' : ''}.
                </p>
                <ul style={{ margin: '0 0 20px', paddingLeft: 18 }}>
                  {loadedMoveItems.map(m => (
                    <li key={m.key} style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text-1)' }}>{m.key}</strong> — {m.source.summary}
                      {m.children.length > 0 && (
                        <span style={{ color: 'var(--text-3)' }}>
                          {' '}+ {m.children.length} child issue{m.children.length !== 1 ? 's' : ''}
                        </span>
                      )}
                    </li>
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
              </>
            ) : (
              <>
                <p className="modal-title">Confirm Delete</p>
                <p style={{ color: 'var(--text-2)', margin: '12px 0 8px', lineHeight: 1.6, fontSize: 14 }}>
                  The following {loadedDeleteItems.length} issue{loadedDeleteItems.length !== 1 ? 's' : ''} will be{' '}
                  <strong style={{ color: 'var(--red)' }}>permanently deleted</strong>. This cannot be undone.
                </p>
                <ul style={{ margin: '0 0 20px', paddingLeft: 18 }}>
                  {loadedDeleteItems.map(d => (
                    <li key={d.key} style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 4 }}>
                      <strong style={{ color: 'var(--text-1)' }}>{d.key}</strong> — {d.source.summary}
                    </li>
                  ))}
                </ul>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="btn btn-danger" onClick={executeDelete} style={{ flex: 1 }}>
                    Yes, Delete
                  </button>
                  <button className="btn btn-ghost" onClick={() => setShowConfirm(false)} style={{ flex: 1 }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
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
                <ul className="step-list" style={{ marginTop: 12 }}>
                  {moveResults.map(r => (
                    <li key={r.key} className="step-item">
                      <StepIcon status={
                        r.status === 'idle'    ? 'idle'    :
                        r.status === 'running' ? 'pending' :
                        r.status
                      } />
                      <div className="step-body">
                        <p className="step-name">{r.key}</p>
                        {r.newKey && (
                          <a className="step-link" href={r.newUrl} target="_blank" rel="noreferrer">
                            → {r.newKey} ↗
                          </a>
                        )}
                        {r.error && <p className="step-error">{r.error}</p>}
                        {r.children.length > 0 && (
                          <ul style={{ listStyle: 'none', padding: '6px 0 0', margin: 0 }}>
                            {r.children.map(c => (
                              <li key={c.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 }}>
                                <StepIcon status={c.status === 'running' ? 'pending' : c.status} />
                                <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
                                  {c.key}
                                  {c.newKey && (
                                    <> → <a className="step-link" href={c.newUrl} target="_blank" rel="noreferrer">
                                      {c.newKey} ↗
                                    </a></>
                                  )}
                                  {c.error && <span className="step-error"> {c.error}</span>}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>

                {!running && allMoveDone && (
                  <button className="btn btn-primary" style={{ marginTop: 20 }} onClick={handleCloseModal}>
                    Done
                  </button>
                )}
              </>
            )}

            {mode === 'delete' && (
              <>
                <ul className="step-list" style={{ marginTop: 12 }}>
                  {deleteResults.map(r => (
                    <li key={r.key} className="step-item">
                      <StepIcon status={r.status === 'running' ? 'pending' : r.status} />
                      <div className="step-body">
                        <p className="step-name">{r.key} — {r.summary}</p>
                        {r.error && <p className="step-error">{r.error}</p>}
                      </div>
                    </li>
                  ))}
                </ul>

                {!running && allDeleteDone && (
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
