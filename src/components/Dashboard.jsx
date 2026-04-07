import { useState, useEffect } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import { getIterations, getStories, getAreaPaths } from '../services/azureDevops.js';
import { createTask, updateTask, fetchTaskForEdit, getCreateStepCount, getEditStepCount } from '../services/taskSync.js';
import SyncModal from './SyncModal.jsx';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

export default function Dashboard({ user, expiresAt, onLogout }) {
  const hoursLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000));

  // ── Core form state ───────────────────────────────────────────────────────
  const [proj,        setProj]        = useState(PROJECT_LIST[0]);
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
  const [selectedStory,      setSelectedStory]      = useState(null);   // { id, title, url }
  const [selectedBoard,      setSelectedBoard]      = useState('');
  const [selectedJiraProj,   setSelectedJiraProj]   = useState('');
  const [loadingExtras,      setLoadingExtras]      = useState(false);
  const [extrasErr,          setExtrasErr]          = useState('');

  // ── Sync state ────────────────────────────────────────────────────────────
  const [syncing,   setSyncing]   = useState(false);
  const [steps,     setSteps]     = useState([]);
  const [result,    setResult]    = useState(null);
  const [showModal, setShowModal] = useState(false);

  // ── Load project-specific data when project changes ───────────────────────
  useEffect(() => {
    const { features, azure } = proj;
    if (!features.iteration && !features.story && !features.board) return;

    setIterations([]);
    setStories([]);
    setBoards([]);
    setSelectedIteration('');
    setSelectedStory(null);
    setSelectedBoard('');
    setSelectedJiraProj('');
    setExtrasErr('');
    setLoadingExtras(true);

    const loads = [];

    if (features.iteration) {
      loads.push(
        getIterations(azure.proxyKey, azure.project)
          .then(all => {
            if (features.iterationFilter) {
              // Keep only: current active sprint + "Tasks for Sprint Placement"
              const filtered = all.filter(it =>
                it.attributes?.timeFrame === 'current' ||
                it.name.toLowerCase().includes('tasks for sprint placement')
              );
              setIterations(filtered.length ? filtered : all);
            } else {
              setIterations(all);
            }
          })
          .catch(e => setExtrasErr(e.message))
      );
    }
    if (features.story) {
      loads.push(
        getStories(azure.proxyKey, azure.project)
          .then(setStories)
          .catch(e => setExtrasErr(e.message))
      );
    }
    if (features.board) {
      loads.push(
        getAreaPaths(azure.proxyKey, azure.project)
          .then(all => {
            const allowList = proj.boardAllowList;
            setBoards(allowList?.length ? all.filter(b => allowList.includes(b.name)) : all);
          })
          .catch(e => setExtrasErr(e.message))
      );
    }

    Promise.all(loads).finally(() => setLoadingExtras(false));
  }, [proj.id]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  function updateStep(i, status, error = null, data = null) {
    setSteps(prev => { const n = [...prev]; n[i] = { status, error, data }; return n; });
  }

  function resetForm() {
    setTitle('');
    setDescription('');
    setEpicId('');
    setJiraKey(null);
    setFetchErr('');
    setSelectedIteration('');
    setSelectedStory(null);
    setSelectedBoard('');
    setSelectedJiraProj('');
  }

  function handleModeChange(m) {
    setMode(m);
    resetForm();
  }

  function handleProjectChange(id) {
    const p = PROJECT_LIST.find(p => p.id === id);
    setProj(p);
    resetForm();
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

            {/* ── NSMG: Sprint (Iteration) ── */}
            {proj.features.iteration && (
              <div className="field">
                <label className="field-label">
                  Sprint (Iteration)
                  {loadingExtras && <span className="spinner" style={{ marginLeft: 8, width: 12, height: 12 }} />}
                </label>
                <select className="select" value={selectedIteration}
                  onChange={e => setSelectedIteration(e.target.value)}
                  disabled={loadingExtras || !iterations.length}>
                  <option value="">— Select sprint —</option>
                  {iterations.map(it => (
                    <option key={it.id} value={it.path}>{it.name}</option>
                  ))}
                </select>
                {extrasErr && <p className="error-msg">⚠ {extrasErr}</p>}
              </div>
            )}

            {/* ── NSMG: Parent Story ── */}
            {proj.features.story && (
              <div className="field">
                <label className="field-label">
                  Parent Story
                  {loadingExtras && <span className="spinner" style={{ marginLeft: 8, width: 12, height: 12 }} />}
                </label>
                <select className="select"
                  value={selectedStory?.id ?? ''}
                  onChange={e => setSelectedStory(stories.find(s => String(s.id) === e.target.value) ?? null)}
                  disabled={loadingExtras || !stories.length}>
                  <option value="">— Select story (optional) —</option>
                  {stories.map(s => (
                    <option key={s.id} value={s.id}>{s.title}</option>
                  ))}
                </select>
              </div>
            )}

            {/* ── ABS: Board (Area Path) ── */}
            {proj.features.board && (
              <div className="field">
                <label className="field-label">
                  Board
                  {loadingExtras && <span className="spinner" style={{ marginLeft: 8, width: 12, height: 12 }} />}
                </label>
                <select className="select" value={selectedBoard}
                  onChange={e => setSelectedBoard(e.target.value)}
                  disabled={loadingExtras || !boards.length}>
                  <option value="">— Select board —</option>
                  {boards.map(b => (
                    <option key={b.id} value={b.path}>{b.name}</option>
                  ))}
                </select>
                {extrasErr && <p className="error-msg">⚠ {extrasErr}</p>}
              </div>
            )}

            {/* ── ABS: Jira Project ── */}
            {proj.features.jiraProject && (
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
              <textarea className="textarea"
                placeholder="Describe the task in detail…"
                value={description}
                onChange={e => setDescription(e.target.value)} />
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
