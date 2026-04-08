import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import { getIterations, getStories, getAreaPaths } from '../services/azureDevops.js';
import { createTask, updateTask, fetchTaskForEdit, getCreateStepCount, getEditStepCount } from '../services/taskSync.js';
import SyncModal from './SyncModal.jsx';
import RichTextEditor from './RichTextEditor.jsx';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

// ─── localStorage helpers ──────────────────────────────────────────────────
const LS_KEY = 'dnl-task-filters';

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}

function saveFilters(projId, filters) {
  const all = loadSaved();
  all[projId] = filters;
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

function getSavedFilters(projId) {
  return loadSaved()[projId] || {};
}

// ─── Restore selected project from localStorage ────────────────────────────
function getInitialProject() {
  const saved = loadSaved();
  const lastId = saved._lastProject;
  if (lastId) {
    const found = PROJECT_LIST.find(p => p.id === lastId);
    if (found) return found;
  }
  return PROJECT_LIST[0];
}

export default function Dashboard({ user, expiresAt, onLogout }) {
  const hoursLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000));

  // ── Core form state ───────────────────────────────────────────────────────
  const [proj,        setProj]        = useState(getInitialProject);
  const [mode,        setMode]        = useState('create');
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');

  // ── Edit mode state ───────────────────────────────────────────────────────
  const [epicId,       setEpicId]       = useState('');
  const [jiraKey,      setJiraKey]      = useState(null);
  const [fetchingEpic, setFetchingEpic] = useState(false);
  const [fetchErr,     setFetchErr]     = useState('');

  // ── Project-specific extras ───────────────────────────────────────────────
  const [iterations,         setIterations]         = useState([]);
  const [stories,            setStories]            = useState([]);
  const [boards,             setBoards]             = useState([]);
  const [selectedIteration,  setSelectedIteration]  = useState('');
  const [selectedStory,      setSelectedStory]      = useState(null);
  const [selectedBoard,      setSelectedBoard]      = useState('');
  const [selectedJiraProj,   setSelectedJiraProj]   = useState('');
  const [loadingExtras,      setLoadingExtras]      = useState(false);
  const [extrasErr,          setExtrasErr]          = useState('');

  // ── Sync state ────────────────────────────────────────────────────────────
  const [syncing,   setSyncing]   = useState(false);
  const [steps,     setSteps]     = useState([]);
  const [result,    setResult]    = useState(null);
  const [showModal, setShowModal] = useState(false);

  // Track latest project load to ignore stale responses
  const loadIdRef = useRef(0);

  // ── Load project-specific data when project changes ───────────────────────
  useEffect(() => {
    const { features, azure } = proj;
    const needsData = features.iteration || features.story || features.board;

    // Immediately clear old data to prevent artifacts
    setIterations([]);
    setStories([]);
    setBoards([]);
    setExtrasErr('');

    if (!needsData) {
      setLoadingExtras(false);
      return;
    }

    setLoadingExtras(true);
    const currentLoadId = ++loadIdRef.current;

    const loads = [];

    if (features.iteration) {
      loads.push(
        getIterations(azure.proxyKey, azure.project)
          .then(all => {
            if (loadIdRef.current !== currentLoadId) return;
            if (features.iterationFilter) {
              const filtered = all.filter(it =>
                it.attributes?.timeFrame === 'current' ||
                it.name.toLowerCase().includes('tasks for sprint placement')
              );
              setIterations(filtered.length ? filtered : all);
            } else {
              setIterations(all);
            }
          })
          .catch(e => {
            if (loadIdRef.current === currentLoadId) setExtrasErr(e.message);
          })
      );
    }
    if (features.story) {
      loads.push(
        getStories(azure.proxyKey, azure.project)
          .then(all => { if (loadIdRef.current === currentLoadId) setStories(all); })
          .catch(e => { if (loadIdRef.current === currentLoadId) setExtrasErr(e.message); })
      );
    }
    if (features.board) {
      loads.push(
        getAreaPaths(azure.proxyKey, azure.project)
          .then(all => {
            if (loadIdRef.current !== currentLoadId) return;
            const allowList = proj.boardAllowList;
            setBoards(allowList?.length ? all.filter(b => allowList.includes(b.name)) : all);
          })
          .catch(e => { if (loadIdRef.current === currentLoadId) setExtrasErr(e.message); })
      );
    }

    Promise.all(loads).finally(() => {
      if (loadIdRef.current === currentLoadId) setLoadingExtras(false);
    });
  }, [proj.id]);

  // ── Restore saved filters once extras are loaded ──────────────────────────
  useEffect(() => {
    if (loadingExtras) return;
    const saved = getSavedFilters(proj.id);

    if (saved.iteration && iterations.some(it => it.path === saved.iteration)) {
      setSelectedIteration(saved.iteration);
    }
    if (saved.story && stories.some(s => String(s.id) === saved.story)) {
      setSelectedStory(stories.find(s => String(s.id) === saved.story) ?? null);
    }
    if (saved.board && boards.some(b => b.path === saved.board)) {
      setSelectedBoard(saved.board);
    }
    if (saved.jiraProject) {
      setSelectedJiraProj(saved.jiraProject);
    }
  }, [loadingExtras, proj.id]);

  // ── Persist filter selections ─────────────────────────────────────────────
  useEffect(() => {
    saveFilters(proj.id, {
      iteration:   selectedIteration || undefined,
      story:       selectedStory ? String(selectedStory.id) : undefined,
      board:       selectedBoard || undefined,
      jiraProject: selectedJiraProj || undefined,
    });
  }, [proj.id, selectedIteration, selectedStory, selectedBoard, selectedJiraProj]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const updateStep = useCallback((i, status, error = null, data = null) => {
    setSteps(prev => { const n = [...prev]; n[i] = { status, error, data }; return n; });
  }, []);

  function resetForm() {
    setTitle('');
    setDescription('');
    setEpicId('');
    setJiraKey(null);
    setFetchErr('');
  }

  function handleModeChange(m) {
    setMode(m);
    resetForm();
  }

  function handleProjectChange(id) {
    const p = PROJECT_LIST.find(p => p.id === id);
    if (!p || p.id === proj.id) return;
    resetForm();
    // Reset filter selections before loading new project data
    setSelectedIteration('');
    setSelectedStory(null);
    setSelectedBoard('');
    setSelectedJiraProj('');
    setProj(p);
    // Save last selected project
    const all = loadSaved();
    all._lastProject = id;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  }

  // ── Load Epic for Edit mode ───────────────────────────────────────────────
  async function handleEpicLookup() {
    const id = epicId.trim();
    if (!id) return;
    setFetchingEpic(true);
    setFetchErr('');
    try {
      const data = await fetchTaskForEdit(proj, id);
      setTitle(data.title);
      setDescription(data.description);
      setJiraKey(data.jiraKey);
    } catch (e) {
      setFetchErr(e.message);
    } finally {
      setFetchingEpic(false);
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;

    const count = mode === 'create' ? getCreateStepCount(proj) : getEditStepCount(proj);
    setSteps(Array(count).fill({ status: 'idle' }));
    setResult(null);
    setSyncing(true);
    setShowModal(true);

    const extras = {
      iterationPath:  selectedIteration || undefined,
      storyUrl:       selectedStory?.url || undefined,
      areaPath:       selectedBoard || undefined,
      jiraProjectKey: selectedJiraProj || undefined,
    };

    try {
      let res;
      if (mode === 'create') {
        res = await createTask(proj, title.trim(), description.trim(), extras, updateStep);
        resetForm();
      } else {
        res = await updateTask(proj, epicId.trim(), title.trim(), description.trim(), jiraKey, updateStep);
      }
      setResult(res);
    } catch { /* errors shown in modal */ }
    finally { setSyncing(false); }
  }

  function handleCloseModal() {
    setShowModal(false);
    setSteps([]);
    setResult(null);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const canSubmit = title.trim() && (mode === 'create' || epicId.trim());
  const { features } = proj;
  const showExtrasSection = features.iteration || features.story || features.board || features.jiraProject;

  return (
    <div className="app-shell">

      {/* ── Header ── */}
      <header className="header">
        <div className="header-logo">
          <img src={LOGO} alt="Dynamica Labs" />
        </div>
        <div className="header-sep" />
        <span className="header-title">DNL Tasks Creator</span>
        <div className="header-spacer" />
        {user && <span className="header-user" title={`Session expires in ~${hoursLeft}h`}>{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>
          Sign out
        </button>
      </header>

      {/* ── Main ── */}
      <main className="main">
        <div className="task-card">
          <div className="card-heading">
            <h2 className="card-title">
              {mode === 'create' ? 'New Task' : 'Edit Task'}
            </h2>
            <p className="card-sub">
              {mode === 'create'
                ? `Creates Azure DevOps ${proj.azure.workItemType}${proj.jira ? ' + Jira Request' : ''}`
                : `Updates the existing ${proj.azure.workItemType}${proj.jira ? ' and Jira Request' : ''}`}
            </p>
          </div>

          <form onSubmit={handleSubmit}>

            {/* Event */}
            <div className="field" style={{ marginBottom: 24 }}>
              <label className="field-label">Event</label>
              <div className="segment">
                <button type="button" className={`seg-btn ${mode === 'create' ? 'active' : ''}`}
                  onClick={() => handleModeChange('create')}>Create</button>
                <button type="button" className={`seg-btn ${mode === 'edit' ? 'active' : ''}`}
                  onClick={() => handleModeChange('edit')}>Edit</button>
              </div>
            </div>

            {/* Project */}
            <div className="field">
              <label className="field-label">Select Project</label>
              <select className="select" value={proj.id}
                onChange={e => handleProjectChange(e.target.value)}>
                {PROJECT_LIST.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* Epic/Task ID — Edit mode only */}
            {mode === 'edit' && (
              <div className="field">
                <label className="field-label">Azure DevOps {proj.azure.workItemType} ID</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input type="number" className="input" placeholder="e.g. 154" min={1}
                    value={epicId}
                    onChange={e => { setEpicId(e.target.value); setFetchErr(''); }}
                    style={{ flex: 1 }} />
                  <button type="button" className="btn btn-ghost"
                    onClick={handleEpicLookup} disabled={!epicId.trim() || fetchingEpic}
                    style={{ flexShrink: 0 }}>
                    {fetchingEpic ? <span className="spinner" /> : 'Load'}
                  </button>
                </div>
                {fetchErr && <p className="error-msg">⚠ {fetchErr}</p>}
              </div>
            )}

            {/* ── Project extras: loader overlay while fetching ── */}
            {showExtrasSection && (
              <div className="extras-section">
                {loadingExtras && (
                  <div className="extras-loader">
                    <span className="spinner spinner-lg" />
                    <span className="extras-loader-text">Loading project data…</span>
                  </div>
                )}

                <div style={loadingExtras ? { opacity: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' } : undefined}>

                  {/* ── NSMG: Sprint (Iteration) ── */}
                  {features.iteration && iterations.length > 0 && (
                    <div className="field">
                      <label className="field-label">Sprint (Iteration)</label>
                      <select className="select" value={selectedIteration}
                        onChange={e => setSelectedIteration(e.target.value)}>
                        <option value="">— Select sprint —</option>
                        {iterations.map(it => (
                          <option key={it.id} value={it.path}>{it.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* ── NSMG: Parent Story ── */}
                  {features.story && stories.length > 0 && (
                    <div className="field">
                      <label className="field-label">Parent Story</label>
                      <select className="select"
                        value={selectedStory?.id ?? ''}
                        onChange={e => setSelectedStory(stories.find(s => String(s.id) === e.target.value) ?? null)}>
                        <option value="">— Select story (optional) —</option>
                        {stories.map(s => (
                          <option key={s.id} value={s.id}>{s.title}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* ── ABS: Board (Area Path) ── */}
                  {features.board && boards.length > 0 && (
                    <div className="field">
                      <label className="field-label">Board</label>
                      <select className="select" value={selectedBoard}
                        onChange={e => setSelectedBoard(e.target.value)}>
                        <option value="">— Select board —</option>
                        {boards.map(b => (
                          <option key={b.id} value={b.path}>{b.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* ── ABS: Jira Project ── */}
                  {features.jiraProject && (
                    <div className="field">
                      <label className="field-label">Jira Project</label>
                      <select className="select" value={selectedJiraProj}
                        onChange={e => setSelectedJiraProj(e.target.value)}>
                        <option value="">— Select Jira project —</option>
                        {(proj.jiraProjectOptions || []).map(key => (
                          <option key={key} value={key}>{key}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {extrasErr && <p className="error-msg" style={{ marginBottom: 8 }}>⚠ {extrasErr}</p>}
                </div>
              </div>
            )}

            {/* Title */}
            <div className="field">
              <label className="field-label">Task Title</label>
              <input type="text" className="input"
                placeholder={`e.g. ${proj.id}. Feature name`}
                value={title}
                onChange={e => setTitle(e.target.value)}
                required />
            </div>

            {/* Description */}
            <div className="field" style={{ marginBottom: 28 }}>
              <label className="field-label">Description</label>
              <RichTextEditor
                value={description}
                onChange={setDescription}
                placeholder="Describe the task in detail…"
              />
            </div>

            <button type="submit" className="btn btn-primary"
              disabled={!canSubmit || syncing}>
              {syncing ? (
                <>
                  <span className="spinner"
                    style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.25)' }} />
                  Syncing…
                </>
              ) : mode === 'create' ? 'Create Task ↗' : 'Save Changes ↗'}
            </button>

          </form>
        </div>
      </main>

      {showModal && (
        <SyncModal
          mode={mode}
          project={proj}
          steps={steps}
          result={result}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
