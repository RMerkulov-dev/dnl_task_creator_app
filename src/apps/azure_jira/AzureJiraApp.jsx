import { useState, useEffect, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import {
  getWorkItem, getWorkItemStates, getWorkItemComments, addWorkItemComment,
  updateWorkItem, updateWorkItemState, resolveJiraFieldValue, extractJiraKey,
  workItemWebUrl,
} from '../../services/azureDevops.js';
import {
  getIssueFull, getIssueComments, addIssueComment, getTransitions,
  transitionIssue, updateIssue, editIssueFieldsRaw, getPriorities,
  searchJiraUsers, getIssueKeysByAzureIds, getJiraUrl, adfToHtml,
} from '../../services/jira.js';
import RichTextEditor from '../../components/RichTextEditor.jsx';

// ─── Azure-Jira tab ───────────────────────────────────────────────────────────
//
// Side-by-side editor for one Azure DevOps work item (left) and its linked Jira
// issue (right). Enter an Azure #id → the card loads with editable state /
// title / description / comments; the Jira key is resolved from the card's
// Jira field (falling back to the Jira-side Azure-id custom field) and the
// right panel loads the issue with editable status (workflow transitions),
// summary, description, priority, assignee and comments.

// ── small helpers ─────────────────────────────────────────────────────────────

function htmlToText(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li)\s*>/gi, '\n');
  const el = document.createElement('div');
  el.innerHTML = withBreaks;
  return (el.textContent || el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Plain textarea text → minimal HTML (per-line paragraphs) for comment bodies.
function textToParagraphs(text) {
  return String(text || '').split(/\r?\n/)
    .map(l => `<p>${escapeHtml(l)}</p>`)
    .join('');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Tone for the state/status chip dot. Azure categories: Proposed | InProgress |
// Resolved | Completed | Removed; Jira category keys: new | indeterminate | done.
function toneOf(category) {
  const c = (category || '').toLowerCase();
  if (c === 'done' || c === 'completed') return 'done';
  if (c === 'inprogress' || c === 'resolved' || c === 'indeterminate') return 'prog';
  return 'todo';
}

function isHtmlEmpty(html) {
  return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
}

// ── shared field widgets ──────────────────────────────────────────────────────

// A one-line editable text field: input + Save button that appears when dirty.
function EditableTitle({ value, onSave, disabled }) {
  const [draft,  setDraft]  = useState(value);
  const [busy,   setBusy]   = useState(false);
  const [error,  setError]  = useState('');
  useEffect(() => { setDraft(value); setError(''); }, [value]);
  const dirty = draft !== value;

  async function save() {
    if (!draft.trim()) { setError('Title cannot be empty'); return; }
    setBusy(true); setError('');
    try { await onSave(draft.trim()); }
    catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="azj-title-row">
      <input
        className="input azj-title-input"
        value={draft}
        disabled={disabled || busy}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (dirty) save(); } }}
      />
      {dirty && (
        <>
          <button className="btn btn-primary azj-mini-btn" onClick={save} disabled={busy}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Save'}
          </button>
          <button className="btn btn-ghost azj-mini-btn" onClick={() => { setDraft(value); setError(''); }} disabled={busy}>✕</button>
        </>
      )}
      {error && <span className="azj-err">⚠ {error}</span>}
    </div>
  );
}

// View / edit toggle around a rendered HTML description.
function DescriptionSection({ html, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(html);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  useEffect(() => { if (!editing) setDraft(html); }, [html, editing]);

  async function save() {
    setBusy(true); setError('');
    try {
      await onSave(draft);
      setEditing(false);
    } catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="azj-section">
      <div className="azj-section-head">
        <span className="azj-section-title">Description</span>
        {!editing && (
          <button className="btn btn-ghost azj-mini-btn" onClick={() => { setDraft(html); setEditing(true); }}>Edit</button>
        )}
      </div>
      {editing ? (
        <>
          <RichTextEditor value={draft} onChange={setDraft} placeholder="Description…" />
          <div className="azj-edit-actions">
            <button className="btn btn-ghost azj-mini-btn" onClick={() => { setEditing(false); setError(''); }} disabled={busy}>Cancel</button>
            <button className="btn btn-primary azj-mini-btn" onClick={save} disabled={busy}>
              {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Save description'}
            </button>
          </div>
          {error && <p className="azj-err">⚠ {error}</p>}
        </>
      ) : isHtmlEmpty(html) ? (
        <p className="azj-dim">No description.</p>
      ) : (
        <div className="azj-desc" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

// Comment composer + list. `renderBody(c)` renders one comment's body.
function CommentsSection({ comments, loading, error, onAdd, renderBody }) {
  const [draft, setDraft] = useState('');
  const [busy,  setBusy]  = useState(false);
  const [err,   setErr]   = useState('');

  async function submit() {
    if (!draft.trim()) return;
    setBusy(true); setErr('');
    try {
      await onAdd(draft);
      setDraft('');
    } catch (e) { setErr(e.message || 'Comment failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="azj-section">
      <div className="azj-section-head">
        <span className="azj-section-title">Comments{comments ? ` (${comments.length})` : ''}</span>
        {loading && <span className="spinner" style={{ width: 12, height: 12 }} />}
      </div>
      <div className="azj-comment-box">
        <textarea
          className="input azj-comment-input"
          rows={2}
          placeholder="Write a comment…"
          value={draft}
          disabled={busy}
          onChange={e => setDraft(e.target.value)}
        />
        <button className="btn btn-primary azj-mini-btn" onClick={submit} disabled={busy || !draft.trim()}>
          {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Comment'}
        </button>
      </div>
      {err && <p className="azj-err">⚠ {err}</p>}
      {error && <p className="azj-err">⚠ {error}</p>}
      {comments && comments.length === 0 && !loading && <p className="azj-dim">No comments yet.</p>}
      {comments && comments.map(c => (
        <div className="azj-comment" key={c.id}>
          <div className="azj-comment-meta">
            <strong>{c.author}</strong>
            <span>{fmtDate(c.created || c.createdDate)}</span>
          </div>
          {renderBody(c)}
        </div>
      ))}
    </div>
  );
}

// Select that saves on change with a spinner and inline error + revert.
function SavingSelect({ value, options, tone, onSave, placeholder }) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  async function change(next) {
    if (!next || next === value) return;
    setBusy(true); setError('');
    try { await onSave(next); }
    catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  return (
    <span className="azj-state">
      <span className={`azj-dot azj-dot-${tone}`} />
      <select className="select azj-state-select" value={value} disabled={busy} onChange={e => change(e.target.value)}>
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {busy && <span className="spinner" style={{ width: 12, height: 12 }} />}
      {error && <span className="azj-err" title={error}>⚠ {error}</span>}
    </span>
  );
}

// Jira assignee: current name + change popover with user search.
function AssigneePicker({ assignee, cloudId, onSet }) {
  const [open,    setOpen]    = useState(false);
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const seq = useRef(0);

  useEffect(() => {
    if (!open || query.trim().length < 2) { setResults([]); return; }
    const mySeq = ++seq.current;
    const t = setTimeout(() => {
      searchJiraUsers(cloudId, query.trim())
        .then(list => { if (seq.current === mySeq) setResults(list.filter(u => u.accountType !== 'app')); })
        .catch(() => { if (seq.current === mySeq) setResults([]); });
    }, 300);
    return () => clearTimeout(t);
  }, [open, query, cloudId]);

  async function pick(accountId) {
    setBusy(true); setError('');
    try {
      await onSet(accountId);
      setOpen(false); setQuery(''); setResults([]);
    } catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  return (
    <span className="azj-assignee">
      <span>{assignee || <span className="azj-dim">Unassigned</span>}</span>
      <button className="tf-linkbtn" onClick={() => { setOpen(o => !o); setError(''); }}>{open ? 'close' : 'change'}</button>
      {open && (
        <span className="azj-assignee-pop">
          <input
            className="input azj-assignee-input"
            placeholder="Search user…"
            value={query}
            autoFocus
            disabled={busy}
            onChange={e => setQuery(e.target.value)}
          />
          {busy && <span className="spinner" style={{ width: 12, height: 12 }} />}
          {(results.length > 0 || assignee) && (
            <span className="azj-assignee-list">
              {results.map(u => (
                <button key={u.accountId} className="azj-assignee-opt" onClick={() => pick(u.accountId)}>
                  {u.displayName}
                </button>
              ))}
              {assignee && (
                <button className="azj-assignee-opt azj-assignee-unassign" onClick={() => pick(null)}>Unassign</button>
              )}
            </span>
          )}
          {error && <span className="azj-err">⚠ {error}</span>}
        </span>
      )}
    </span>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export default function AzureJiraApp({ allowedProjects }) {
  const visibleProjects = allowedProjects
    ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
    : PROJECT_LIST;

  const [proj, setProj] = useState(visibleProjects[0]);

  // ── Azure panel state ──
  const [azInput,     setAzInput]     = useState('');
  const [azLoading,   setAzLoading]   = useState(false);
  const [azError,     setAzError]     = useState('');
  const [azItem,      setAzItem]      = useState(null);   // raw work item
  const [azStates,    setAzStates]    = useState([]);     // [{ name, category }]
  const [azComments,  setAzComments]  = useState(null);
  const [azCommentsLoading, setAzCommentsLoading] = useState(false);
  const [azCommentsError,   setAzCommentsError]   = useState('');

  // ── Jira panel state ──
  const [jrInput,      setJrInput]      = useState('');
  const [jrLoading,    setJrLoading]    = useState(false);
  const [jrError,      setJrError]      = useState('');
  const [jrIssue,      setJrIssue]      = useState(null); // raw issue (getIssueFull)
  const [jrTransitions, setJrTransitions] = useState([]);
  const [jrPriorities, setJrPriorities] = useState([]);
  const [jrComments,   setJrComments]   = useState(null);
  const [jrCommentsLoading, setJrCommentsLoading] = useState(false);
  const [jrCommentsError,   setJrCommentsError]   = useState('');
  const [jrLinkNote,   setJrLinkNote]   = useState('');   // how the key was resolved / not

  const azSeq = useRef(0);
  const jrSeq = useRef(0);

  const cloudId = proj.jira?.cloudId;

  // ── Jira load ──
  const loadJira = useCallback(async (key) => {
    const issueKey = (key || '').trim().toUpperCase();
    if (!issueKey) return;
    const mySeq = ++jrSeq.current;
    setJrInput(issueKey);
    setJrLoading(true); setJrError('');
    setJrIssue(null); setJrTransitions([]); setJrComments(null); setJrCommentsError('');
    try {
      const [issue, transitions] = await Promise.all([
        getIssueFull(cloudId, issueKey),
        getTransitions(cloudId, issueKey).catch(() => []),
      ]);
      if (jrSeq.current !== mySeq) return;
      setJrIssue(issue);
      setJrTransitions(transitions);
      setJrCommentsLoading(true);
      getIssueComments(cloudId, issueKey)
        .then(list => { if (jrSeq.current === mySeq) setJrComments(list); })
        .catch(e => { if (jrSeq.current === mySeq) setJrCommentsError(e.message); })
        .finally(() => { if (jrSeq.current === mySeq) setJrCommentsLoading(false); });
      if (!jrPriorities.length) {
        getPriorities(cloudId).then(setJrPriorities).catch(() => {});
      }
    } catch (e) {
      if (jrSeq.current !== mySeq) return;
      setJrError(e.message || 'Could not load the Jira issue.');
    } finally {
      if (jrSeq.current === mySeq) setJrLoading(false);
    }
  }, [cloudId, jrPriorities.length]); // eslint-disable-line

  // ── Azure load (+ Jira key resolution) ──
  const loadAzure = useCallback(async () => {
    const id = Number(String(azInput).match(/\d+/)?.[0]);
    if (!id) { setAzError('Enter a work item number.'); return; }
    const mySeq = ++azSeq.current;
    setAzLoading(true); setAzError('');
    setAzItem(null); setAzComments(null); setAzCommentsError('');
    setJrLinkNote('');
    try {
      const item = await getWorkItem(proj.azure.proxyKey, proj.azure.project, id);
      if (azSeq.current !== mySeq) return;
      setAzItem(item);

      const type = item.fields?.['System.WorkItemType'];
      getWorkItemStates(proj.azure.proxyKey, proj.azure.project, type)
        .then(list => { if (azSeq.current === mySeq) setAzStates(list); })
        .catch(() => { if (azSeq.current === mySeq) setAzStates([]); });

      setAzCommentsLoading(true);
      getWorkItemComments(proj.azure.proxyKey, proj.azure.project, id)
        .then(list => { if (azSeq.current === mySeq) setAzComments(list); })
        .catch(e => { if (azSeq.current === mySeq) setAzCommentsError(e.message); })
        .finally(() => { if (azSeq.current === mySeq) setAzCommentsLoading(false); });

      // Resolve the linked Jira issue: Azure-side Jira field first, then the
      // authoritative Jira-side Azure-id custom field.
      let jiraKey = extractJiraKey(resolveJiraFieldValue(item.fields, proj.azure.jiraIdField));
      if (!jiraKey && proj.jira) {
        try {
          const keys = proj.jiraProjectOptions || [proj.jira.projectKey];
          const map = await getIssueKeysByAzureIds(cloudId, keys, proj.jira.clientRequestIdField, [id]);
          jiraKey = map.get(String(id)) || null;
          if (jiraKey && azSeq.current === mySeq) setJrLinkNote('linked via Jira-side Azure ID');
        } catch { /* resolution is best-effort */ }
      }
      if (azSeq.current !== mySeq) return;
      if (jiraKey) {
        loadJira(jiraKey);
      } else {
        setJrLinkNote('No linked Jira issue found — enter a key manually.');
      }
    } catch (e) {
      if (azSeq.current !== mySeq) return;
      setAzError(e.message || 'Could not load the work item.');
    } finally {
      if (azSeq.current === mySeq) setAzLoading(false);
    }
  }, [azInput, proj, cloudId, loadJira]); // eslint-disable-line

  function handleProjectChange(id) {
    const p = visibleProjects.find(p => p.id === id);
    if (!p) return;
    setProj(p);
    azSeq.current++; jrSeq.current++;
    setAzItem(null); setAzComments(null); setAzError(''); setAzStates([]);
    setJrIssue(null); setJrComments(null); setJrError(''); setJrTransitions([]); setJrInput(''); setJrLinkNote('');
  }

  // ── Azure field saves ──
  const azF = azItem?.fields || {};
  const azId = azItem?.id;

  async function saveAzState(state) {
    await updateWorkItemState(proj.azure.proxyKey, proj.azure.project, azId, state);
    setAzItem(prev => prev && ({ ...prev, fields: { ...prev.fields, 'System.State': state } }));
  }
  async function saveAzTitle(title) {
    await updateWorkItem(proj.azure.proxyKey, proj.azure.project, azId, { 'System.Title': title });
    setAzItem(prev => prev && ({ ...prev, fields: { ...prev.fields, 'System.Title': title } }));
  }
  async function saveAzDescription(html) {
    await updateWorkItem(proj.azure.proxyKey, proj.azure.project, azId, { 'System.Description': html });
    setAzItem(prev => prev && ({ ...prev, fields: { ...prev.fields, 'System.Description': html } }));
  }
  async function addAzComment(text) {
    await addWorkItemComment(proj.azure.proxyKey, proj.azure.project, azId, textToParagraphs(text));
    const list = await getWorkItemComments(proj.azure.proxyKey, proj.azure.project, azId);
    setAzComments(list);
  }

  // ── Jira field saves ──
  const jrF = jrIssue?.fields || {};
  const jrKey = jrIssue?.key;

  async function saveJrTransition(transitionId) {
    const t = jrTransitions.find(t => String(t.id) === String(transitionId));
    await transitionIssue(cloudId, jrKey, transitionId);
    if (t?.to) {
      setJrIssue(prev => prev && ({ ...prev, fields: { ...prev.fields, status: t.to } }));
    }
    getTransitions(cloudId, jrKey).then(setJrTransitions).catch(() => {});
  }
  async function saveJrSummary(summary) {
    const r = await editIssueFieldsRaw(cloudId, jrKey, { summary });
    if (!r.ok) throw new Error([...(r.errorMessages || []), ...Object.values(r.errors || {})].join('; ') || 'Save failed');
    setJrIssue(prev => prev && ({ ...prev, fields: { ...prev.fields, summary } }));
  }
  async function saveJrDescription(html) {
    await updateIssue(cloudId, jrKey, jrF.summary ?? '', html);
    // Re-read so the stored ADF round-trips back through adfToHtml.
    const issue = await getIssueFull(cloudId, jrKey);
    setJrIssue(issue);
  }
  async function saveJrPriority(priorityId) {
    const r = await editIssueFieldsRaw(cloudId, jrKey, { priority: { id: String(priorityId) } });
    if (!r.ok) throw new Error([...(r.errorMessages || []), ...Object.values(r.errors || {})].join('; ') || 'Save failed');
    const p = jrPriorities.find(p => String(p.id) === String(priorityId));
    if (p) setJrIssue(prev => prev && ({ ...prev, fields: { ...prev.fields, priority: p } }));
  }
  async function saveJrAssignee(accountId) {
    const r = await editIssueFieldsRaw(cloudId, jrKey, { assignee: accountId ? { accountId } : null });
    if (!r.ok) throw new Error([...(r.errorMessages || []), ...Object.values(r.errors || {})].join('; ') || 'Save failed');
    const issue = await getIssueFull(cloudId, jrKey);
    setJrIssue(issue);
  }
  async function addJrComment(text) {
    await addIssueComment(cloudId, jrKey, textToParagraphs(text));
    const list = await getIssueComments(cloudId, jrKey);
    setJrComments(list);
  }

  const azWebUrl = azItem
    ? (azItem._links?.html?.href || workItemWebUrl(azItem.url, proj.azure.project))
    : null;
  const azStateCategory = azStates.find(s => s.name === azF['System.State'])?.category;

  return (
    <div className="azj-wrap">
      <div className="azj-grid">

        {/* ── Azure panel ── */}
        <section className="azj-panel">
          <div className="azj-panel-head">
            <span className="azj-panel-tag azj-tag-azure">Azure</span>
            <select className="select azj-proj-select" value={proj.id} onChange={e => handleProjectChange(e.target.value)}>
              {visibleProjects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <input
              className="input azj-id-input"
              placeholder="Work item #"
              value={azInput}
              onChange={e => setAzInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') loadAzure(); }}
            />
            <button className="btn" onClick={loadAzure} disabled={azLoading}>
              {azLoading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Load'}
            </button>
          </div>
          <div className="azj-panel-body">
            {azError && <p className="azj-err">⚠ {azError}</p>}
            {!azItem && !azError && !azLoading && (
              <p className="azj-dim azj-empty">Enter an Azure DevOps work item number and press Load.</p>
            )}
            {azItem && (
              <>
                <div className="azj-card-top">
                  {azWebUrl
                    ? <a className="ba-issue-link azj-key" href={azWebUrl} target="_blank" rel="noreferrer">#{azItem.id} ↗</a>
                    : <span className="azj-key">#{azItem.id}</span>}
                  <span className="azj-type">{azF['System.WorkItemType']}</span>
                  {azStates.length > 0 && (
                    <SavingSelect
                      value={azF['System.State'] || ''}
                      tone={toneOf(azStateCategory)}
                      options={azStates.map(s => ({ value: s.name, label: s.name }))}
                      onSave={saveAzState}
                    />
                  )}
                </div>
                <EditableTitle value={azF['System.Title'] || ''} onSave={saveAzTitle} />
                <div className="azj-meta">
                  <span><strong>Assigned:</strong> {azF['System.AssignedTo']?.displayName || <span className="azj-dim">Unassigned</span>}</span>
                  {azF['System.IterationPath'] && <span><strong>Iteration:</strong> {String(azF['System.IterationPath']).split('\\').pop()}</span>}
                  {azF['System.AreaPath'] && <span><strong>Area:</strong> {String(azF['System.AreaPath']).split('\\').pop()}</span>}
                </div>
                <DescriptionSection html={azF['System.Description'] || ''} onSave={saveAzDescription} />
                <CommentsSection
                  comments={azComments}
                  loading={azCommentsLoading}
                  error={azCommentsError}
                  onAdd={addAzComment}
                  renderBody={c => <p className="azj-comment-body">{htmlToText(c.text)}</p>}
                />
              </>
            )}
          </div>
        </section>

        {/* ── Jira panel ── */}
        <section className="azj-panel">
          <div className="azj-panel-head">
            <span className="azj-panel-tag azj-tag-jira">Jira</span>
            <input
              className="input azj-id-input azj-key-input"
              placeholder="e.g. ABS-123"
              value={jrInput}
              onChange={e => setJrInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') loadJira(jrInput); }}
            />
            <button className="btn" onClick={() => loadJira(jrInput)} disabled={jrLoading || !jrInput.trim()}>
              {jrLoading ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Load'}
            </button>
            {jrLinkNote && <span className="azj-dim azj-linknote">{jrLinkNote}</span>}
          </div>
          <div className="azj-panel-body">
            {jrError && <p className="azj-err">⚠ {jrError}</p>}
            {!jrIssue && !jrError && !jrLoading && (
              <p className="azj-dim azj-empty">Load an Azure item on the left — its linked Jira issue appears here. Or enter a key manually.</p>
            )}
            {jrIssue && (
              <>
                <div className="azj-card-top">
                  <a className="ba-issue-link azj-key" href={getJiraUrl(jrIssue.key)} target="_blank" rel="noreferrer">{jrIssue.key} ↗</a>
                  <span className="azj-type">{jrF.issuetype?.name}</span>
                  <SavingSelect
                    value=""
                    tone={toneOf(jrF.status?.statusCategory?.key)}
                    placeholder={jrF.status?.name || '—'}
                    options={jrTransitions.map(t => ({ value: String(t.id), label: `→ ${t.to?.name || t.name}` }))}
                    onSave={saveJrTransition}
                  />
                </div>
                <EditableTitle value={jrF.summary || ''} onSave={saveJrSummary} />
                <div className="azj-meta">
                  <span>
                    <strong>Assignee:</strong>{' '}
                    <AssigneePicker assignee={jrF.assignee?.displayName} cloudId={cloudId} onSet={saveJrAssignee} />
                  </span>
                  <span>
                    <strong>Priority:</strong>{' '}
                    {jrPriorities.length > 0 ? (
                      <SavingSelect
                        value={String(jrF.priority?.id ?? '')}
                        tone={toneOf('')}
                        options={jrPriorities.map(p => ({ value: String(p.id), label: p.name }))}
                        onSave={saveJrPriority}
                      />
                    ) : (jrF.priority?.name || '—')}
                  </span>
                  {jrF.reporter?.displayName && <span><strong>Reporter:</strong> {jrF.reporter.displayName}</span>}
                </div>
                <DescriptionSection html={adfToHtml(jrF.description)} onSave={saveJrDescription} />
                <CommentsSection
                  comments={jrComments}
                  loading={jrCommentsLoading}
                  error={jrCommentsError}
                  onAdd={addJrComment}
                  renderBody={c => <div className="azj-comment-body" dangerouslySetInnerHTML={{ __html: c.html }} />}
                />
              </>
            )}
          </div>
        </section>

      </div>
    </div>
  );
}
