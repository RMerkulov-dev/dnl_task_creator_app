import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import { getIterations, getStories, getAreaPaths, findWorkItemByJiraKey } from '../services/azureDevops.js';
import { createTask, updateTask, fetchTaskForEdit, createAzureFromJira, getCreateStepCount, getEditStepCount } from '../services/taskSync.js';
import { getJiraIssueByKey, getJiraUrl } from '../services/jira.js';
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
function getInitialProject(visible) {
  const saved = loadSaved();
  const lastId = saved._lastProject;
  if (lastId) {
    const found = visible.find(p => p.id === lastId);
    if (found) return found;
  }
  return visible[0];
}

export default function Dashboard({ user, allowedProjects, expiresAt, onLogout, theme, themeMode, setThemeMode }) {
  // null = all projects (System Admin); array = restricted list
  const visibleProjects = allowedProjects
    ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
    : PROJECT_LIST;
  const hoursLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000));

  // ── Core form state ───────────────────────────────────────────────────────
  const [proj,        setProj]        = useState(() => getInitialProject(visibleProjects));
  const [mode,        setMode]        = useState('create');
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');

  // ── Edit mode state ───────────────────────────────────────────────────────
  const [epicId,       setEpicId]       = useState('');
  const [jiraKey,      setJiraKey]      = useState(null);
  const [fetchingEpic, setFetchingEpic] = useState(false);
  const [fetchErr,     setFetchErr]     = useState('');
  const [idMode,         setIdMode]         = useState('azure'); // 'azure' | 'jira'
  const [createFromJira, setCreateFromJira] = useState(false);  // Jira-only item, create Azure on save

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

  // ── Reload stories when sprint selection changes (only for projects with storyIterationFilter) ──
  useEffect(() => {
    if (!proj.features.storyIterationFilter) return;
    if (!selectedIteration) return;
    let cancelled = false;
    getStories(proj.azure.proxyKey, proj.azure.project, selectedIteration)
      .then(all => { if (!cancelled) setStories(all); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedIteration]);

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
    setIdMode('azure');
    setCreateFromJira(false);
  }

  function handleModeChange(m) {
    setMode(m);
    resetForm();
  }

  function handleProjectChange(id) {
    const p = visibleProjects.find(p => p.id === id);
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

  // ── Apply loaded task data to selectors ───────────────────────────────────
  function applyLoadedExtras(data) {
    if (data.iterationPath) setSelectedIteration(data.iterationPath);
    if (data.areaPath)      setSelectedBoard(data.areaPath);
    if (data.parentId != null) {
      // Match parent story by ID (more reliable than URL)
      const match = stories.find(s => String(s.id) === String(data.parentId));
      if (match) setSelectedStory(match);
      else if (data.parentUrl) setSelectedStory({ id: data.parentId, title: `Story #${data.parentId}`, url: data.parentUrl });
    }
  }

  // ── Load Epic for Edit mode ───────────────────────────────────────────────
  async function handleEpicLookup() {
    const raw = epicId.trim();
    if (!raw) return;
    setFetchingEpic(true);
    setFetchErr('');
    try {
      if (idMode === 'jira' && proj.jira) {
        const jiraKeyUpper = raw.toUpperCase();
        let azureId = null;

        // Try Jira's custom field first (reverse link)
        try {
          const res = await getJiraIssueByKey(
            proj.jira.cloudId, jiraKeyUpper, proj.jira.clientRequestIdField
          );
          azureId = res.azureId;
          console.log('[Jira lookup] azureId from Jira field:', azureId, '| field:', proj.jira.clientRequestIdField);
        } catch (e) {
          console.warn('[Jira lookup] Jira field lookup failed:', e.message);
        }

        // Fallback: search Azure DevOps by jiraIdField (try key + full URL)
        if (!azureId && proj.azure.jiraIdField) {
          console.log('[Jira lookup] Trying Azure WIQL with field:', proj.azure.jiraIdField, 'value:', jiraKeyUpper);
          azureId = await findWorkItemByJiraKey(
            proj.azure.proxyKey, proj.azure.project, proj.azure.jiraIdField,
            jiraKeyUpper, getJiraUrl(jiraKeyUpper)
          );
          console.log('[Jira lookup] azureId from Azure WIQL:', azureId);
        }

        if (!azureId) {
          // No Azure item — load data from Jira and enter "create Azure" mode
          const jiraData = await getJiraIssueByKey(
            proj.jira.cloudId, jiraKeyUpper, proj.jira.clientRequestIdField
          );
          setTitle(jiraData.summary);
          setDescription(jiraData.description || '');
          setJiraKey(jiraKeyUpper);
          setEpicId('');
          setCreateFromJira(true);
          return;
        }
        setCreateFromJira(false);
        const resolvedId = String(azureId);
        setEpicId(resolvedId);
        const data = await fetchTaskForEdit(proj, resolvedId);
        setTitle(data.title);
        setDescription(data.description);
        setJiraKey(jiraKeyUpper);
        applyLoadedExtras(data);
      } else {
        const data = await fetchTaskForEdit(proj, raw);
        setTitle(data.title);
        setDescription(data.description);
        setJiraKey(data.jiraKey);
        applyLoadedExtras(data);
      }
    } catch (e) {
      setFetchErr(e.message);
    } finally {
      setFetchingEpic(false);
    }
  }

  // ── Submit ────────────────────────────────────────────────────────────────
  async function runSync() {
    const extras = {
      iterationPath:  selectedIteration || undefined,
      storyUrl:       selectedStory?.url || undefined,
      areaPath:       selectedBoard || undefined,
      jiraProjectKey: selectedJiraProj || undefined,
    };

    // createFromJira: Jira issue exists, Azure doesn't — create Azure + link back
    if (createFromJira) {
      setSteps(Array(proj.jira ? 2 : 1).fill({ status: 'idle' }));
      setResult(null);
      setSyncing(true);
      setShowModal(true);
      try {
        const res = await createAzureFromJira(proj, jiraKey, title.trim(), description.trim(), extras, updateStep);
        setCreateFromJira(false);
        setEpicId(String(res.epicId));
        setResult(res);
      } catch { /* errors shown in modal */ }
      finally { setSyncing(false); }
      return;
    }

    const count = mode === 'create'
      ? getCreateStepCount(proj)
      : getEditStepCount(proj, jiraKey);
    setSteps(Array(count).fill({ status: 'idle' }));
    setResult(null);
    setSyncing(true);
    setShowModal(true);

    try {
      let res;
      if (mode === 'create') {
        res = await createTask(proj, title.trim(), description.trim(), extras, updateStep);
        resetForm();
      } else {
        res = await updateTask(proj, epicId.trim(), title.trim(), description.trim(), jiraKey, updateStep, extras);
        // Keep jiraKey in sync — if Jira was just created, store the key so next save updates instead of creating
        if (res.jiraKey && res.jiraKey !== jiraKey) setJiraKey(res.jiraKey);
        if (res.epicId  && !epicId.trim())          setEpicId(String(res.epicId));
      }
      setResult(res);
    } catch { /* errors shown in modal */ }
    finally { setSyncing(false); }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    runSync();
  }

  function handleCloseModal() {
    setShowModal(false);
    setSteps([]);
    setResult(null);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const canSubmit = title.trim() && (mode === 'create' || epicId.trim() || createFromJira);
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
        {setThemeMode && (
          <div className="theme-toggle" role="group" aria-label="Theme" style={{ marginRight: 12 }}>
            <button
              type="button"
              className={`theme-toggle-opt ${themeMode === 'light' ? 'active' : ''}`}
              onClick={() => setThemeMode('light')}
              aria-label="Light theme"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </button>
            <button
              type="button"
              className={`theme-toggle-opt ${themeMode === 'scheduled' ? 'active' : ''}`}
              onClick={() => setThemeMode('scheduled')}
              aria-label="Scheduled theme (Kyiv time)"
              title="Auto: light after sunrise, dark after sunset (Kyiv)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
                <path d="M12 7v5l3 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              type="button"
              className={`theme-toggle-opt ${themeMode === 'dark' ? 'active' : ''}`}
              onClick={() => setThemeMode('dark')}
              aria-label="Dark theme"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M21 12.79A9 9 0 1111.21 3a7 7 0 009.79 9.79z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        )}
        {user && <span className="header-user" title={`Session expires in ~${hoursLeft}h`}>{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>
          Sign out
        </button>
      </header>

      {/* ── Main ── */}
      <main className="main">
        <div className="task-card">
          <div className="card-heading">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
              <div>
                <h2 className="card-title">
                  {mode === 'create' ? 'New Task' : 'Edit Task'}
                </h2>
                <p className="card-sub">
                  {mode === 'create'
                    ? `Creates Azure DevOps ${proj.azure.workItemType}${proj.jira ? ' + Jira Request' : ''}`
                    : `Updates the existing ${proj.azure.workItemType}${proj.jira ? ' and Jira Request' : ''}`}
                </p>
              </div>
              <div className="segment segment-sm">
                <button type="button" className={`seg-btn ${mode === 'create' ? 'active' : ''}`}
                  onClick={() => handleModeChange('create')}>Create</button>
                <button type="button" className={`seg-btn ${mode === 'edit' ? 'active' : ''}`}
                  onClick={() => handleModeChange('edit')}>Edit</button>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className="task-layout">

              {/* ── Left column: title + description + submit ── */}
              <div className="task-col-left">

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
                <div className="field" style={{ marginBottom: 28, flex: 1 }}>
                  <label className="field-label">Description</label>
                  <RichTextEditor
                    value={description}
                    onChange={setDescription}
                    placeholder="Describe the task in detail…"
                  />
                </div>

              </div>

              {/* ── Right column: filters ── */}
              <div className="task-col-right">

                {/* Submit */}
                <button type="submit" className="btn btn-primary"
                  style={{ marginBottom: 24 }}
                  disabled={!canSubmit || syncing}>
                  {syncing ? (
                    <>
                      <span className="spinner"
                        style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.25)' }} />
                      Syncing…
                    </>
                  ) : mode === 'create' ? 'Create Task ↗' : 'Save Changes ↗'}
                </button>

                {/* Project */}
                <div className="field">
                  <label className="field-label">Select Project</label>
                  <select className="select" value={proj.id}
                    onChange={e => handleProjectChange(e.target.value)}>
                    {visibleProjects.map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                </div>

                {/* Epic/Task ID — Edit mode only */}
                {mode === 'edit' && (
                  <div className="field">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <label className="field-label" style={{ margin: 0 }}>
                        {idMode === 'jira' ? 'Jira Issue Key' : `Azure DevOps ${proj.azure.workItemType} ID`}
                      </label>
                      {proj.jira && (
                        <div className="id-mode-toggle">
                          <button
                            type="button"
                            className={`id-mode-btn${idMode === 'azure' ? ' active' : ''}`}
                            onClick={() => { setIdMode('azure'); setEpicId(''); setFetchErr(''); }}
                          >Azure</button>
                          <button
                            type="button"
                            className={`id-mode-btn${idMode === 'jira' ? ' active' : ''}`}
                            onClick={() => { setIdMode('jira'); setEpicId(''); setFetchErr(''); }}
                          >Jira</button>
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        type="text"
                        className="input"
                        placeholder={idMode === 'jira' ? 'e.g. NSMG-8244' : 'e.g. 1154'}
                        value={epicId}
                        onChange={e => { setEpicId(e.target.value); setFetchErr(''); }}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && epicId.trim() && !fetchingEpic) {
                            e.preventDefault();
                            handleEpicLookup();
                          }
                        }}
                        style={{ flex: 1 }}
                      />
                      <button type="button" className="btn btn-ghost"
                        onClick={handleEpicLookup} disabled={!epicId.trim() || fetchingEpic}
                        style={{ flexShrink: 0 }}>
                        {fetchingEpic ? <span className="spinner" /> : 'Load'}
                      </button>
                    </div>
                    {fetchErr && <p className="error-msg">⚠ {fetchErr}</p>}
                    {createFromJira && (
                      <p className="create-from-jira-notice">
                        No Azure item found — a new one will be created and linked to {jiraKey}
                      </p>
                    )}
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

              </div>

            </div>
          </form>
        </div>
      </main>

      {showModal && (
        <SyncModal
          mode={createFromJira ? 'createFromJira' : mode}
          project={proj}
          steps={steps}
          result={result}
          onClose={handleCloseModal}
        />
      )}

    </div>
  );
}
