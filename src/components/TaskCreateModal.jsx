import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import { getIterations, getStories, getAreaPaths } from '../services/azureDevops.js';
import { createTask, getCreateStepCount } from '../services/taskSync.js';
import { getProjectComponents } from '../services/jira.js';
import RichTextEditor from './RichTextEditor.jsx';
import SyncModal from './SyncModal.jsx';

// ─── Task Create Modal ────────────────────────────────────────────────────────
//
// A focused, create-only version of the Dashboard form, opened pre-filled from
// the Tasks Follow-up tab. Title + description arrive prefilled; the user only
// picks a project (and any project-specific extras) and hits Create. It reuses
// the exact same createTask() sync pipeline as the main Task Creator app.

function isDescriptionEmpty(html) {
  if (!html) return true;
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
  return text.length === 0;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Turn one line into HTML, converting markdown links [txt](url) and bare URLs
// into clickable anchors (so Fathom links land as real links in the description).
function inlineToHtml(line) {
  const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)]+)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(line)) !== null) {
    out += escapeHtml(line.slice(last, m.index));
    const text = m[2] ? m[1] : m[3];
    const href = m[2] ? m[2] : m[3];
    out += `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(text)}</a>`;
    last = re.lastIndex;
  }
  out += escapeHtml(line.slice(last));
  return out;
}

// Plain text (with newlines / bullet lines) → simple HTML for the editor.
export function textToHtml(text) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  return lines.map(l => `<p>${inlineToHtml(l)}</p>`).join('');
}

// ─── Title prefixes (mirrors the Task Creator dashboard) ──────────────────────
const ALL_PREFIXES = new Set([
  'HT.', 'NSMGM.', 'NSMG.', 'NSMGCM.', 'ABS.', 'ABSPO.',
  'ABS. [WS]. Customer Service.', 'ABS. QMP.', 'ABS. MAM.',
]);

function getDefaultTitlePrefix(projId, boardName, jiraProj) {
  if (projId === 'HT')          return 'HT.';
  if (projId === 'NSMG_MARKER') return 'NSMGM.';
  if (projId === 'NSMG')        return 'NSMG.';
  if (projId === 'NSMGCM')      return 'NSMGCM.';
  if (projId === 'ABS') {
    if (!boardName)                             return '';
    if (boardName.includes('Customer Service'))    return 'ABS. [WS]. Customer Service.';
    if (boardName.includes('Bureau'))              return 'ABS. QMP.';
    if (boardName.includes('Marketing'))           return 'ABS. MAM.';
    return jiraProj === 'ABSPO' ? 'ABSPO.' : 'ABS.';
  }
  return '';
}

// Strip any known prefix (and following space) from the front of a title.
function stripKnownPrefix(title) {
  const t = (title || '').trimStart();
  for (const p of ALL_PREFIXES) {
    if (t.startsWith(p)) return t.slice(p.length).trimStart();
  }
  return title || '';
}

// Guess the project from a call title (e.g. "NSMG. Architecture call" → NSMG,
// "Case Migration. Queue" → NSMGCM). Order matters: the more specific NSMG
// variants are checked before plain NSMG.
function guessProjectId(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('nsmgm') || t.includes('marker'))         return 'NSMG_MARKER';
  if (t.includes('nsmgcm') || t.includes('case migration')) return 'NSMGCM';
  if (t.includes('nsmg'))                                   return 'NSMG';
  if (t.includes('abs'))                                    return 'ABS';
  if (t.includes('hydrotec') || /\bht\b|ht\./.test(t))     return 'HT';
  return null;
}

function pickInitialProject(list, title) {
  const id = guessProjectId(title);
  return (id && list.find(p => p.id === id)) || list[0];
}

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

export default function TaskCreateModal({ user, allowedProjects, callTitle, initialTitle, initialDescription, onClose, onCreated }) {
  const visibleProjects = allowedProjects
    ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
    : PROJECT_LIST;

  // Pre-select the project inferred from the call title (e.g. "NSMG. …" → NSMG).
  const [proj,        setProj]        = useState(() => pickInitialProject(visibleProjects, callTitle));
  // Title is split into the base (the actual task title, prefix-free) and an
  // optional user override. The shown title = current project's prefix + base,
  // so changing the project re-applies the prefix dynamically.
  const baseTitle = stripKnownPrefix(initialTitle || '');
  const [customTitle, setCustomTitle] = useState(null);
  const [description, setDescription] = useState(() => textToHtml(initialDescription || ''));
  const [attachments, setAttachments] = useState([]);
  const [formError,   setFormError]   = useState('');

  const [iterations,        setIterations]        = useState([]);
  const [stories,           setStories]           = useState([]);
  const [boards,            setBoards]            = useState([]);
  const [selectedIteration, setSelectedIteration] = useState('');
  const [selectedStory,     setSelectedStory]     = useState(null);
  const [selectedBoard,     setSelectedBoard]     = useState('');
  const [selectedJiraProj,  setSelectedJiraProj]  = useState('');
  const [components,        setComponents]        = useState([]);
  const [selectedComponent, setSelectedComponent] = useState('');
  const [loadingExtras,     setLoadingExtras]     = useState(false);
  const [extrasErr,         setExtrasErr]         = useState('');

  // Effective Jira key: ABS switches ABS/ABSPO at runtime, others use a fixed key.
  const effectiveJiraKey = proj.jira ? (selectedJiraProj || proj.jira.projectKey) : null;

  const [syncing,  setSyncing]  = useState(false);
  const [steps,    setSteps]    = useState([]);
  const [showSync, setShowSync] = useState(false);
  const [result,   setResult]   = useState(null);

  const loadIdRef = useRef(0);

  // ── Dynamic title: project prefix + base task title ──────────────────────
  const boardName = boards.find(b => b.path === selectedBoard)?.name ?? '';
  const titlePrefix = getDefaultTitlePrefix(proj.id, boardName, selectedJiraProj);
  const title = customTitle != null
    ? customTitle
    : (titlePrefix ? `${titlePrefix} ${baseTitle}`.trim() : baseTitle);

  // ── Load project-specific data when project changes ──────────────────────
  useEffect(() => {
    const { features, azure } = proj;
    const needsData = features.iteration || features.story || features.board;

    setIterations([]); setStories([]); setBoards([]); setExtrasErr('');
    setSelectedIteration(''); setSelectedStory(null); setSelectedBoard(''); setSelectedJiraProj('');

    if (!needsData) { setLoadingExtras(false); return; }

    setLoadingExtras(true);
    const currentLoadId = ++loadIdRef.current;
    const loads = [];

    if (features.iteration) {
      loads.push(getIterations(azure.proxyKey, azure.project).then(all => {
        if (loadIdRef.current !== currentLoadId) return;
        if (features.iterationFilter) {
          const filtered = all.filter(it =>
            it.attributes?.timeFrame === 'current' ||
            it.name.toLowerCase().includes('tasks for sprint placement'));
          setIterations(filtered.length ? filtered : all);
        } else setIterations(all);
      }).catch(e => { if (loadIdRef.current === currentLoadId) setExtrasErr(e.message); }));
    }
    if (features.story) {
      loads.push(getStories(azure.proxyKey, azure.project)
        .then(all => { if (loadIdRef.current === currentLoadId) setStories(cleanStories(all)); })
        .catch(e => { if (loadIdRef.current === currentLoadId) setExtrasErr(e.message); }));
    }
    if (features.board) {
      loads.push(getAreaPaths(azure.proxyKey, azure.project).then(all => {
        if (loadIdRef.current !== currentLoadId) return;
        const allowList = proj.boardAllowList;
        setBoards(allowList?.length ? all.filter(b => allowList.includes(b.name)) : all);
      }).catch(e => { if (loadIdRef.current === currentLoadId) setExtrasErr(e.message); }));
    }

    Promise.all(loads).finally(() => {
      if (loadIdRef.current === currentLoadId) setLoadingExtras(false);
    });
  }, [proj.id]);

  // ── Reload stories when sprint changes (storyIterationFilter projects) ────
  useEffect(() => {
    if (!proj.features.storyIterationFilter || !selectedIteration) return;
    let cancelled = false;
    getStories(proj.azure.proxyKey, proj.azure.project, selectedIteration)
      .then(async filtered => {
        if (cancelled) return;
        const cleaned = cleanStories(filtered);
        if (cleaned.length) { setStories(cleaned); return; }
        try {
          const all = await getStories(proj.azure.proxyKey, proj.azure.project);
          if (!cancelled) setStories(cleanStories(all));
        } catch { if (!cancelled) setStories([]); }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selectedIteration]);

  // ── Load Jira components for the effective project key ────────────────────
  useEffect(() => {
    if (!proj.features.component || !proj.jira || !effectiveJiraKey) {
      setComponents([]); setSelectedComponent(''); return;
    }
    let cancelled = false;
    getProjectComponents(proj.jira.cloudId, effectiveJiraKey)
      .then(list => {
        if (cancelled) return;
        setComponents(list);
        setSelectedComponent(prev => (list.some(c => String(c.id) === prev) ? prev : ''));
      })
      .catch(() => { if (!cancelled) setComponents([]); });
    return () => { cancelled = true; };
  }, [proj.id, effectiveJiraKey]);

  // ── Notify parent + close on success ─────────────────────────────────────
  useEffect(() => {
    if (!result) return;
    onCreated?.(result);
    onClose?.();
  }, [result]); // eslint-disable-line

  const updateStep = useCallback((i, status, error = null, data = null) => {
    setSteps(prev => { const n = [...prev]; n[i] = { status, error, data }; return n; });
  }, []);

  function handleProjectChange(id) {
    const p = visibleProjects.find(p => p.id === id);
    if (p) setProj(p);
  }

  async function runSync() {
    const extras = {
      iterationPath:  selectedIteration || undefined,
      storyUrl:       selectedStory?.url || undefined,
      areaPath:       selectedBoard || undefined,
      jiraProjectKey: selectedJiraProj || undefined,
      componentId:    selectedComponent || undefined,
      attachments:    attachments.length ? attachments : undefined,
    };
    setSteps(Array(getCreateStepCount(proj)).fill({ status: 'idle' }));
    setResult(null);
    setSyncing(true);
    setShowSync(true);
    try {
      const res = await createTask(proj, title.trim(), description, extras, updateStep);
      setResult(res); // effect closes the modal + notifies parent
    } catch { /* errors shown in SyncModal */ }
    finally { setSyncing(false); }
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim())                 { setFormError('Title is required'); return; }
    if (isDescriptionEmpty(description)) { setFormError('Description is required'); return; }
    setFormError('');
    runSync();
  }

  const { features } = proj;
  const showExtras = features.iteration || features.story || features.board || features.jiraProject || features.component;
  const canSubmit  = title.trim() && !isDescriptionEmpty(description);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !syncing) onClose?.(); }}>
      <div className="tcm-modal">
        <div className="tcm-head">
          <h2 className="card-title" style={{ margin: 0 }}>Create Task</h2>
          <button className="tcm-close" onClick={() => !syncing && onClose?.()} title="Close" aria-label="Close">✕</button>
        </div>

        <form onSubmit={handleSubmit} className="tcm-body">
          <div className="field">
            <label className="field-label">Select Project</label>
            <select className="select" value={proj.id} onChange={e => handleProjectChange(e.target.value)}>
              {visibleProjects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>

          {showExtras && (
            <div className="extras-section">
              {loadingExtras && (
                <div className="extras-loader">
                  <span className="spinner spinner-lg" />
                  <span className="extras-loader-text">Loading project data…</span>
                </div>
              )}
              <div style={loadingExtras ? { opacity: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' } : undefined}>
                {features.iteration && iterations.length > 0 && (
                  <div className="field">
                    <label className="field-label">Sprint (Iteration)</label>
                    <select className="select" value={selectedIteration} onChange={e => setSelectedIteration(e.target.value)}>
                      <option value="">— Select sprint —</option>
                      {iterations.map(it => <option key={it.id} value={it.path}>{it.name}</option>)}
                    </select>
                  </div>
                )}
                {features.story && stories.length > 0 && (
                  <div className="field">
                    <label className="field-label">Parent Story</label>
                    <select className="select" value={selectedStory?.id ?? ''}
                      onChange={e => setSelectedStory(stories.find(s => String(s.id) === e.target.value) ?? null)}>
                      <option value="">— Select story (optional) —</option>
                      {stories.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}
                    </select>
                  </div>
                )}
                {features.board && boards.length > 0 && (
                  <div className="field">
                    <label className="field-label">Board</label>
                    <select className="select" value={selectedBoard}
                      onChange={e => {
                        const board = e.target.value;
                        setSelectedBoard(board);
                        if (selectedJiraProj === 'ABSPO' && !proj.abspoBoards?.includes(board)) setSelectedJiraProj('');
                      }}>
                      <option value="">— Select board —</option>
                      {boards.map(b => <option key={b.id} value={b.path}>{b.name}</option>)}
                    </select>
                  </div>
                )}
                {features.jiraProject && (
                  <div className="field">
                    <label className="field-label">Jira Project</label>
                    <select className="select" value={selectedJiraProj} onChange={e => setSelectedJiraProj(e.target.value)}>
                      <option value="">— Select Jira project —</option>
                      {(proj.jiraProjectOptions || [])
                        .filter(key => key !== 'ABSPO' || proj.abspoBoards?.includes(selectedBoard))
                        .map(key => <option key={key} value={key}>{key}</option>)}
                    </select>
                  </div>
                )}
                {features.component && components.length > 0 && (
                  <div className="field">
                    <label className="field-label">Jira Component</label>
                    <select className="select" value={selectedComponent} onChange={e => setSelectedComponent(e.target.value)}>
                      <option value="">— No component —</option>
                      {components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                )}
                {extrasErr && <p className="error-msg" style={{ marginBottom: 8 }}>⚠ {extrasErr}</p>}
              </div>
            </div>
          )}

          <div className="field">
            <label className="field-label">Task Title</label>
            <input type="text" className="input" value={title} onChange={e => setCustomTitle(e.target.value)} required />
          </div>

          <div className="field">
            <label className="field-label">Description</label>
            <RichTextEditor value={description} onChange={setDescription} attachments={attachments} onAttachmentsChange={setAttachments} placeholder="Describe the task in detail…" />
          </div>

          {formError && <p className="error-msg">⚠ {formError}</p>}

          <div className="tcm-actions">
            <button type="button" className="btn btn-ghost" onClick={() => !syncing && onClose?.()}>Cancel</button>
            <button type="submit" className="btn btn-primary"
              style={canSubmit ? {} : { opacity: 0.32, cursor: 'not-allowed' }}
              aria-disabled={!canSubmit} disabled={syncing}>
              {syncing
                ? <><span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.25)' }} /> Creating…</>
                : `Create in ${proj.azure.workItemType}${proj.jira ? ' + Jira' : ''} ↗`}
            </button>
          </div>
        </form>
      </div>

      {showSync && (
        <SyncModal
          mode="create"
          project={proj}
          steps={steps}
          onClose={() => { setShowSync(false); setSteps([]); }}
        />
      )}
    </div>
  );
}
