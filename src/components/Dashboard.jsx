import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import { getIterations, filterCurrentAndFutureIterations, getStories, getAreaPaths, findWorkItemByJiraKey } from '../services/azureDevops.js';
import { createTask, updateTask, fetchTaskForEdit, createAzureFromJira, getCreateStepCount, getEditStepCount } from '../services/taskSync.js';
import { getJiraIssueByKey, getJiraUrl, getProjectComponents } from '../services/jira.js';
import SyncModal from './SyncModal.jsx';
import ToastContainer from './Toast.jsx';
import RichTextEditor from './RichTextEditor.jsx';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

// ─── Default title prefixes ────────────────────────────────────────────────
const ALL_PREFIXES = new Set(['HT.', 'NSMGM.', 'NSMG.', 'NSMGCM.', 'ABS.', 'ABSPO.', 'ABS. [WS]. Customer Service.', 'ABS. QMP.', 'ABS. MAM.', 'ABS. CM.']);

function getDefaultTitlePrefix(projId, boardName, jiraProj) {
  if (projId === 'HT')          return 'HT.';
  if (projId === 'NSMG_MARKER') return 'NSMGM.';
  if (projId === 'NSMG')        return 'NSMG.';
  if (projId === 'NSMGCM')      return 'NSMGCM.';
  if (projId === 'ABS') {
    if (!boardName)                             return '';
    if (boardName.includes('Customer Service'))   return 'ABS. [WS]. Customer Service.';
    if (boardName.includes('Bureau'))             return 'ABS. QMP.';
    if (boardName.includes('Marketing'))          return 'ABS. MAM.';
    if (boardName.includes('Commission'))         return 'ABS. CM.';
    return jiraProj === 'ABSPO' ? 'ABSPO.' : 'ABS.';
  }
  return '';
}

// ─── Rich-text emptiness check ─────────────────────────────────────────────
// Tiptap leaves "<p></p>" / "<p><br></p>" when the editor is empty.
function isDescriptionEmpty(html) {
  if (!html) return true;
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
  return text.length === 0;
}

// ─── Story list cleanup ────────────────────────────────────────────────────
// Drops "Backlog Review" bucket stories and dedupes by title (keeps first occurrence).
function cleanStories(stories) {
  const seen = new Set();
  const out = [];
  for (const s of stories) {
    const t = (s.title || '').trim();
    if (t.toLowerCase() === 'backlog review') continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(s);
  }
  return out;
}

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

// ─── Draft autosave ─────────────────────────────────────────────────────────
// Keeps unsent title/description per project so an accidental refresh or a
// session expiry doesn't wipe half an hour of writing. Attachments are File
// objects and can't be serialised — they are intentionally not persisted.
const DRAFT_KEY = 'dnl-task-draft';

function loadDraft(projId) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY)) || {};
    return all[projId] || null;
  } catch { return null; }
}

function saveDraft(projId, draft) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAFT_KEY)) || {};
    if (draft) all[projId] = draft;
    else       delete all[projId];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(all));
  } catch { /* quota / private mode — drafts are best-effort */ }
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

export default function Dashboard({ user, allowedProjects, expiresAt, onLogout }) {
  // null = all projects (System Admin); array = restricted list
  const visibleProjects = allowedProjects
    ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
    : PROJECT_LIST;
  const hoursLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000));

  // ── Core form state ───────────────────────────────────────────────────────
  const [proj,        setProj]        = useState(() => getInitialProject(visibleProjects));
  const [mode,        setMode]        = useState('create');
  // Restore an unsent draft for the initial project (create mode starts empty otherwise)
  const [title,       setTitle]       = useState(() => loadDraft(getInitialProject(visibleProjects)?.id)?.title || '');
  const [description, setDescription] = useState(() => loadDraft(getInitialProject(visibleProjects)?.id)?.description || '');
  const [attachments, setAttachments] = useState([]);
  const [formError,   setFormError]   = useState('');

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
  const [components,         setComponents]         = useState([]);
  const [selectedComponent,  setSelectedComponent]  = useState('');
  const [loadingExtras,      setLoadingExtras]      = useState(false);
  const [extrasErr,          setExtrasErr]          = useState('');

  // Effective Jira project key drives which components to load: ABS lets the user
  // switch between ABS/ABSPO at runtime, other projects use their fixed key.
  const effectiveJiraKey = proj.jira ? (selectedJiraProj || proj.jira.projectKey) : null;

  // ── Sync state ────────────────────────────────────────────────────────────
  const [syncing,   setSyncing]   = useState(false);
  const [steps,     setSteps]     = useState([]);
  const [result,    setResult]    = useState(null);
  const [showModal, setShowModal] = useState(false);

  // ── Toast state ───────────────────────────────────────────────────────────
  const [toasts, setToasts] = useState([]);

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
              setIterations(filterCurrentAndFutureIterations(all));
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
          .then(all => { if (loadIdRef.current === currentLoadId) setStories(cleanStories(all)); })
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
      .then(async filtered => {
        if (cancelled) return;
        const cleanedFiltered = cleanStories(filtered);
        if (cleanedFiltered.length > 0) {
          setStories(cleanedFiltered);
          return;
        }
        // Fallback: sprint has no stories with child tasks — show all open stories
        // so the Parent Story selector doesn't disappear.
        try {
          const all = await getStories(proj.azure.proxyKey, proj.azure.project);
          if (!cancelled) setStories(cleanStories(all));
        } catch {
          if (!cancelled) setStories([]);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedIteration]);

  // ── Load Jira components for the effective project key ────────────────────
  useEffect(() => {
    if (!proj.features.component || !proj.jira || !effectiveJiraKey) {
      setComponents([]);
      setSelectedComponent('');
      return;
    }
    let cancelled = false;
    getProjectComponents(proj.jira.cloudId, effectiveJiraKey)
      .then(list => {
        if (cancelled) return;
        setComponents(list);
        // Drop a stale selection that doesn't exist in the new project's components.
        setSelectedComponent(prev => (list.some(c => String(c.id) === prev) ? prev : ''));
      })
      .catch(() => { if (!cancelled) setComponents([]); });
    return () => { cancelled = true; };
  }, [proj.id, effectiveJiraKey]);

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

  // ── Clear form error once the user fixes the missing field ───────────────
  useEffect(() => {
    if (!formError) return;
    if (title.trim() && !isDescriptionEmpty(description)) setFormError('');
  }, [title, description, formError]);

  // ── Persist filter selections ─────────────────────────────────────────────
  useEffect(() => {
    saveFilters(proj.id, {
      iteration:   selectedIteration || undefined,
      story:       selectedStory ? String(selectedStory.id) : undefined,
      board:       selectedBoard || undefined,
      jiraProject: selectedJiraProj || undefined,
    });
  }, [proj.id, selectedIteration, selectedStory, selectedBoard, selectedJiraProj]);

  // ── Draft autosave (create mode only, debounced) ──────────────────────────
  useEffect(() => {
    if (mode !== 'create') return;
    const id = setTimeout(() => {
      // A bare default prefix (or empty form) is not worth keeping as a draft.
      const meaningful = (title.trim() && !ALL_PREFIXES.has(title.trim())) || !isDescriptionEmpty(description);
      saveDraft(proj.id, meaningful ? { title, description, at: Date.now() } : null);
    }, 600);
    return () => clearTimeout(id);
  }, [proj.id, mode, title, description]);

  // ── Auto-set default title prefix when project / board / jira project changes
  useEffect(() => {
    if (mode !== 'create') return;
    const boardName = boards.find(b => b.path === selectedBoard)?.name ?? '';
    const prefix = getDefaultTitlePrefix(proj.id, boardName, selectedJiraProj);
    if (!prefix) return;
    setTitle(prev => (prev === '' || ALL_PREFIXES.has(prev.trim()) ? prefix : prev));
  }, [proj.id, selectedBoard, selectedJiraProj, mode, boards]);

  // result is passed directly to SyncModal — modal stays open until user closes it.

  function dismissToast(id) {
    setToasts(prev => prev.filter(t => t.id !== id));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const updateStep = useCallback((i, status, error = null, data = null) => {
    setSteps(prev => { const n = [...prev]; n[i] = { status, error, data }; return n; });
  }, []);

  function resetForm() {
    const boardName = boards.find(b => b.path === selectedBoard)?.name ?? '';
    const prefix = getDefaultTitlePrefix(proj.id, boardName, selectedJiraProj);
    setTitle(prefix || '');
    setDescription('');
    setAttachments([]);
    setEpicId('');
    setJiraKey(null);
    setFetchErr('');
    setIdMode('azure');
    setCreateFromJira(false);
    setFormError('');
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
    // Restore this project's unsent draft, if any (create mode after reset)
    const draft = loadDraft(p.id);
    if (draft) {
      if (draft.title)       setTitle(draft.title);
      if (draft.description) setDescription(draft.description);
    }
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
  // `resume` carries ids from a previous failed run ({ epicId, epicUrl, jiraKey })
  // so retrying skips the steps that already succeeded instead of duplicating them.
  async function runSync(resume = null) {
    const extras = {
      iterationPath:  selectedIteration || undefined,
      storyUrl:       selectedStory?.url || undefined,
      areaPath:       selectedBoard || undefined,
      jiraProjectKey: selectedJiraProj || undefined,
      componentId:    selectedComponent || undefined,
      attachments:    attachments.length ? attachments : undefined,
      resume:         resume || undefined,
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
        saveDraft(proj.id, null);   // task landed — the draft has served its purpose
      } else {
        // On retry, reuse the Jira key a previous run already created so we
        // update it instead of creating a second issue.
        const knownJiraKey = jiraKey || resume?.jiraKey || null;
        res = await updateTask(proj, epicId.trim(), title.trim(), description.trim(), knownJiraKey, updateStep, extras);
        // Keep jiraKey in sync — if Jira was just created, store the key so next save updates instead of creating
        if (res.jiraKey && res.jiraKey !== jiraKey) setJiraKey(res.jiraKey);
        if (res.epicId  && !epicId.trim())          setEpicId(String(res.epicId));
      }
      setResult(res);
    } catch { /* errors shown in modal */ }
    finally { setSyncing(false); }
  }

  // ── Retry after a failed step ─────────────────────────────────────────────
  // Collect ids from the steps that DID succeed (epicId / jiraKey live in the
  // step data recorded by updateStep) and re-run the sync with them, so the
  // retry picks up where the failure happened instead of duplicating work.
  function handleRetry() {
    const resume = steps.reduce(
      (acc, s) => (s?.status === 'done' && s.data ? { ...acc, ...s.data } : acc),
      {}
    );
    runSync(Object.keys(resume).length ? resume : null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) {
      setFormError('Title is required');
      return;
    }
    if (isDescriptionEmpty(description)) {
      setFormError('Description is required');
      return;
    }
    setFormError('');
    runSync();
  }

  function handleCloseModal() {
    setShowModal(false);
    setSteps([]);
    setResult(null);
    setSyncing(false);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const hasDescription = !isDescriptionEmpty(description);
  const canSubmit = title.trim() && hasDescription
    && (mode === 'create' || epicId.trim() || createFromJira);
  const { features } = proj;
  const showExtrasSection = features.iteration || features.story || features.board || features.jiraProject || features.component;

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
                    attachments={attachments}
                    onAttachmentsChange={setAttachments}
                    placeholder="Describe the task in detail…"
                  />
                </div>

              </div>

              {/* ── Right column: filters ── */}
              <div className="task-col-right">

                {/* Submit */}
                <button type="submit" className="btn btn-primary"
                  style={{
                    marginBottom: formError ? 8 : 24,
                    ...(canSubmit ? {} : { opacity: 0.32, cursor: 'not-allowed' }),
                  }}
                  aria-disabled={!canSubmit}
                  disabled={syncing}>
                  {syncing ? (
                    <>
                      <span className="spinner"
                        style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.25)' }} />
                      Syncing…
                    </>
                  ) : mode === 'create' ? 'Create Task ↗' : 'Save Changes ↗'}
                </button>
                {formError && (
                  <p className="error-msg" style={{ marginBottom: 24 }}>⚠ {formError}</p>
                )}

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
                            onChange={e => {
                              const board = e.target.value;
                              setSelectedBoard(board);
                              if (selectedJiraProj === 'ABSPO' && !proj.abspoBoards?.includes(board)) {
                                setSelectedJiraProj('');
                              }
                            }}>
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
                            {(proj.jiraProjectOptions || [])
                              .filter(key => key !== 'ABSPO' || proj.abspoBoards?.includes(selectedBoard))
                              .map(key => (
                                <option key={key} value={key}>{key}</option>
                              ))}
                          </select>
                        </div>
                      )}

                      {/* ── Jira Component ── */}
                      {features.component && components.length > 0 && (
                        <div className="field">
                          <label className="field-label">Jira Component</label>
                          <select className="select" value={selectedComponent}
                            onChange={e => setSelectedComponent(e.target.value)}>
                            <option value="">— No component —</option>
                            {components.map(c => (
                              <option key={c.id} value={c.id}>{c.name}</option>
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
          onRetry={handleRetry}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

    </div>
  );
}
