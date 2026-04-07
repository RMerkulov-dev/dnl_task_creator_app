import { useState } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import { createTask, updateTask, fetchTaskForEdit } from '../services/taskSync.js';
import SyncModal from './SyncModal.jsx';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

const EMPTY_STEPS = [];

export default function Dashboard({ user, expiresAt, onLogout }) {
  // Show remaining session time
  const hoursLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 3_600_000));

  const [project,     setProject]     = useState(PROJECT_LIST[0]);
  const [mode,        setMode]        = useState('create'); // 'create' | 'edit'
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [epicId,      setEpicId]      = useState('');
  const [jiraKey,     setJiraKey]     = useState(null);
  const [fetchingEpic, setFetchingEpic] = useState(false);
  const [fetchError,   setFetchError]   = useState('');

  const [syncing,  setSyncing]  = useState(false);
  const [steps,    setSteps]    = useState(EMPTY_STEPS);
  const [result,   setResult]   = useState(null);
  const [showModal, setShowModal] = useState(false);

  // ── helpers ──────────────────────────────────────────────────────────────
  function updateStep(index, status, error = null, data = null) {
    setSteps(prev => {
      const next = [...prev];
      next[index] = { status, error, data };
      return next;
    });
  }

  function resetForm() {
    setTitle('');
    setDescription('');
    setEpicId('');
    setJiraKey(null);
    setFetchError('');
  }

  function handleModeChange(m) {
    setMode(m);
    resetForm();
  }

  // ── look up Epic for Edit mode ────────────────────────────────────────────
  async function handleEpicLookup() {
    const id = epicId.trim();
    if (!id) return;
    setFetchingEpic(true);
    setFetchError('');
    try {
      const data = await fetchTaskForEdit(project, id);
      setTitle(data.title);
      setDescription(data.description);
      setJiraKey(data.jiraKey);
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setFetchingEpic(false);
    }
  }

  // ── submit ────────────────────────────────────────────────────────────────
  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;

    const stepCount = mode === 'create' ? 3 : 2;
    setSteps(Array(stepCount).fill({ status: 'idle' }));
    setResult(null);
    setSyncing(true);
    setShowModal(true);

    try {
      if (mode === 'create') {
        const res = await createTask(project, title.trim(), description.trim(), updateStep);
        setResult(res);
        resetForm();
      } else {
        const res = await updateTask(project, epicId.trim(), title.trim(), description.trim(), jiraKey, updateStep);
        setResult(res);
      }
    } catch {
      // steps already show the error
    } finally {
      setSyncing(false);
    }
  }

  // ── close modal ───────────────────────────────────────────────────────────
  function handleClose() {
    setShowModal(false);
    setSteps(EMPTY_STEPS);
    setResult(null);
  }

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
                ? 'Creates a linked Azure DevOps Epic + Jira Request'
                : 'Updates the existing Epic and linked Jira Request'}
            </p>
          </div>

          <form onSubmit={handleSubmit}>
            {/* Event mode */}
            <div className="field" style={{ marginBottom: 24 }}>
              <label className="field-label">Event</label>
              <div className="segment">
                <button
                  type="button"
                  className={`seg-btn ${mode === 'create' ? 'active' : ''}`}
                  onClick={() => handleModeChange('create')}
                >
                  Create
                </button>
                <button
                  type="button"
                  className={`seg-btn ${mode === 'edit' ? 'active' : ''}`}
                  onClick={() => handleModeChange('edit')}
                >
                  Edit
                </button>
              </div>
            </div>

            {/* Project */}
            <div className="field">
              <label className="field-label">Select Project</label>
              <select
                className="select"
                value={project.id}
                onChange={e => setProject(PROJECT_LIST.find(p => p.id === e.target.value))}
              >
                {PROJECT_LIST.map(p => (
                  <option key={p.id} value={p.id}>{p.label}</option>
                ))}
              </select>
            </div>

            {/* Epic ID (Edit only) */}
            {mode === 'edit' && (
              <div className="field">
                <label className="field-label">Azure DevOps Epic ID</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="number"
                    className="input"
                    placeholder="e.g. 154"
                    value={epicId}
                    onChange={e => { setEpicId(e.target.value); setFetchError(''); }}
                    style={{ flex: 1 }}
                    min={1}
                  />
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={handleEpicLookup}
                    disabled={!epicId.trim() || fetchingEpic}
                  >
                    {fetchingEpic ? <span className="spinner" /> : 'Load'}
                  </button>
                </div>
                {fetchError && <p className="error-msg">⚠ {fetchError}</p>}
              </div>
            )}

            {/* Title */}
            <div className="field">
              <label className="field-label">Task Title</label>
              <input
                type="text"
                className="input"
                placeholder="e.g. HT. Customer portal redesign"
                value={title}
                onChange={e => setTitle(e.target.value)}
                required
              />
            </div>

            {/* Description */}
            <div className="field" style={{ marginBottom: 28 }}>
              <label className="field-label">Description</label>
              <textarea
                className="textarea"
                placeholder="Describe the task in detail…"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className="btn btn-primary"
              disabled={!canSubmit || syncing}
            >
              {syncing ? (
                <>
                  <span className="spinner" style={{ borderTopColor:'#fff', borderColor:'rgba(255,255,255,0.25)' }} />
                  Syncing…
                </>
              ) : mode === 'create' ? (
                'Create Task ↗'
              ) : (
                'Save Changes ↗'
              )}
            </button>
          </form>
        </div>
      </main>

      {/* ── Progress Modal ── */}
      {showModal && (
        <SyncModal
          mode={mode}
          steps={steps}
          result={result}
          onClose={handleClose}
        />
      )}
    </div>
  );
}
