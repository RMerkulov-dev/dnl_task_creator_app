import { useState, useEffect, useRef } from 'react';
import { PROJECT_LIST } from '../config/projects.js';
import {
  searchParentCandidates, getProjectIssueTypes, createChildIssue, getJiraUrl,
  getCreateMetaFields, getStatusesUsedByType, getSprintOptions, setIssueSprint,
  transitionIssueToStatus, searchJiraUsers,
} from '../services/jira.js';
import RichTextEditor from './RichTextEditor.jsx';
import { textToHtml } from './TaskCreateModal.jsx';

// ─── "Where should this task go?" ─────────────────────────────────────────────
//
// Creating a task from a call has two shapes:
//   • a NEW request      — Azure work item + new Jira request (TaskCreateModal,
//                          the original flow);
//   • an EXISTING request — just a Jira issue (Epic or Task) under a parent that
//                          already exists, no Azure counterpart.
// CreateTargetChoice asks which one; AddToParentModal (default export) runs the
// second. Jira's hierarchy here is Request (level 2) → Epic (1) → Task (0), and
// a child must sit exactly one level below its parent — so the type options are
// derived from the chosen parent, not offered blindly.

export function CreateTargetChoice({ taskTitle, onNew, onExisting, onClose }) {
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="ctc-modal">
        <div className="tcm-head">
          <h2 className="card-title" style={{ margin: 0 }}>Create task</h2>
          <button className="tcm-close" onClick={onClose} title="Close" aria-label="Close">✕</button>
        </div>
        <div className="ctc-body">
          {taskTitle && <p className="ctc-task">{taskTitle}</p>}
          <p className="ctc-q">Where should this task go?</p>

          <button className="ctc-opt" onClick={onNew}>
            <span className="ctc-opt-title">New request</span>
            <span className="ctc-opt-sub">
              Creates the Azure DevOps work item and a new linked Jira request — the standard flow.
            </span>
          </button>

          <button className="ctc-opt" onClick={onExisting}>
            <span className="ctc-opt-title">Add to an existing request</span>
            <span className="ctc-opt-sub">
              Pick a parent, then create an Epic or a Task inside it. Jira only — no Azure work item.
            </span>
          </button>
        </div>
        <div className="tcm-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isDescriptionEmpty(html) {
  return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, '').trim();
}

// "Epic" → "An Epic", "Request" → "A Request".
function withArticle(word) {
  return `${/^[aeiou]/i.test(word || '') ? 'An' : 'A'} ${word}`;
}

function statusTone(name) {
  const n = (name || '').toLowerCase();
  if (/done|closed|resolved|complete/.test(n)) return 'done';
  if (/progress|review|dev|test|uat/.test(n))  return 'prog';
  return 'todo';
}

// The two child kinds we offer, with the hierarchy level each one lives on and
// the extra fields the form exposes for each. An Epic is a container — status +
// who owns it is all that's worth filling in at creation time; a Task carries
// the whole planning set.
const CHILD_KINDS = [
  {
    key: 'epic', label: 'Epic', level: 1,
    match: t => t.hierarchyLevel === 1,
    fields: ['status', 'assignee'],
  },
  {
    key: 'task', label: 'Task', level: 0,
    match: t => t.hierarchyLevel === 0 && /^task$/i.test(t.name),
    fields: ['status', 'sprint', 'assignee', 'developer', 'qa', 'devEstimate', 'qaEstimate', 'priority'],
  },
];

// Which Jira field backs each form control. `status` has no create-screen field
// at all — a new issue lands in the workflow's initial status and is walked from
// there (transitionIssueToStatus), so it is not in this map.
// Custom fields are looked up by NAME, not by hardcoded customfield_*, so the
// same form works for any project whose create screen carries them.
const FIELD_SPECS = {
  sprint:      { name: 'Sprint',             label: 'Sprint' },
  assignee:    { id: 'assignee',             label: 'Assignee' },
  priority:    { id: 'priority',             label: 'Priority' },
  developer:   { name: 'Developer',          label: 'Developer' },
  qa:          { name: 'QA',                 label: 'QA' },
  devEstimate: { name: 'Developer Estimate', label: 'Developer Estimate' },
  qaEstimate:  { name: 'QA Estimate',        label: 'QA Estimate' },
};

// Resolve a spec against the create screen: returns the meta entry or null when
// the project doesn't put that field on the create screen (→ control hidden).
function metaFor(meta, spec) {
  if (!meta) return null;
  if (spec.id) return meta[spec.id] || null;
  return Object.values(meta).find(f => f?.name === spec.name) || null;
}

// A compact user picker: current value + a search popover (debounced).
function UserSelect({ cloudId, value, onChange, label }) {
  const [open,    setOpen]    = useState(false);
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [busy,    setBusy]    = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!open || query.trim().length < 2) { setResults([]); return; }
    const mySeq = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      searchJiraUsers(cloudId, query.trim())
        .then(list => { if (seq.current === mySeq) setResults(list.filter(u => u.accountType !== 'app')); })
        .catch(() => { if (seq.current === mySeq) setResults([]); })
        .finally(() => { if (seq.current === mySeq) setBusy(false); });
    }, 300);
    return () => clearTimeout(t);
  }, [open, query, cloudId]);

  return (
    <div className="atp-user">
      <button type="button" className="atp-user-btn" onClick={() => setOpen(o => !o)}>
        {value ? value.displayName : <span className="atp-dim-inline">Unassigned</span>}
        <span className="atp-user-caret">⌄</span>
      </button>
      {open && (
        <div className="atp-user-pop">
          <input
            className="input atp-user-input"
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query}
            autoFocus
            onChange={e => setQuery(e.target.value)}
          />
          {busy && <p className="atp-dim"><span className="spinner" style={{ width: 12, height: 12 }} /> Searching…</p>}
          <div className="atp-user-list">
            {results.map(u => (
              <button type="button" key={u.accountId} className="atp-user-opt"
                onClick={() => { onChange({ accountId: u.accountId, displayName: u.displayName }); setOpen(false); setQuery(''); }}>
                {u.displayName}
              </button>
            ))}
            {value && (
              <button type="button" className="atp-user-opt atp-user-clear"
                onClick={() => { onChange(null); setOpen(false); setQuery(''); }}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function AddToParentModal({ allowedProjects, callTitle, initialTitle, initialDescription, onClose, onCreated }) {
  // Jira-only flow — projects without a Jira side can't take part.
  const visibleProjects = (allowedProjects
    ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
    : PROJECT_LIST).filter(p => p.jira);

  const guessed = visibleProjects.find(p => (callTitle || '').toUpperCase().includes(p.id.replace('_', ' ')))
    || visibleProjects[0];

  const [proj, setProj] = useState(guessed);
  const [jiraProjKey, setJiraProjKey] = useState('');
  const effectiveJiraKey = jiraProjKey || proj?.jira?.projectKey || '';
  const cloudId = proj?.jira?.cloudId;

  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState('');
  const [parent,  setParent]  = useState(null);

  const [issueTypes, setIssueTypes] = useState([]);
  const [kind,       setKind]       = useState('epic');

  const [title,       setTitle]       = useState(initialTitle || '');
  const [description, setDescription] = useState(() => textToHtml(initialDescription || ''));

  // Extra fields (which ones are shown depends on the child kind — see CHILD_KINDS).
  const [meta,      setMeta]      = useState(null);   // create-screen fields
  const [statuses,  setStatuses]  = useState([]);
  const [sprints,   setSprints]   = useState([]);
  const [form,      setForm]      = useState({
    status: '', sprint: '', assignee: null, developer: null, qa: null,
    devEstimate: '', qaEstimate: '', priority: '',
  });
  const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const [creating, setCreating] = useState(false);
  const [error,    setError]    = useState('');
  const [warning,  setWarning]  = useState('');   // created, but a follow-up step failed
  const [result,   setResult]   = useState(null); // { jiraKey, jiraUrl }

  const seq = useRef(0);

  // ── Parent search (debounced; an empty query lists recent candidates) ──
  useEffect(() => {
    if (!cloudId || !effectiveJiraKey || parent) return;
    const mySeq = ++seq.current;
    setSearching(true); setSearchErr('');
    const t = setTimeout(() => {
      searchParentCandidates(cloudId, [effectiveJiraKey], query)
        .then(list => { if (seq.current === mySeq) setResults(list); })
        .catch(e => { if (seq.current === mySeq) { setResults([]); setSearchErr(e.message); } })
        .finally(() => { if (seq.current === mySeq) setSearching(false); });
    }, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [cloudId, effectiveJiraKey, query, parent]);

  // ── Issue types of the target project (for the Epic/Task ids + levels) ──
  useEffect(() => {
    if (!cloudId || !effectiveJiraKey) { setIssueTypes([]); return; }
    let cancelled = false;
    getProjectIssueTypes(cloudId, effectiveJiraKey)
      .then(list => { if (!cancelled) setIssueTypes(list); })
      .catch(() => { if (!cancelled) setIssueTypes([]); });
    return () => { cancelled = true; };
  }, [cloudId, effectiveJiraKey]);

  // Reset the selection when the target project changes — a parent from another
  // project can't take the child.
  function changeProject(id) {
    const p = visibleProjects.find(p => p.id === id);
    if (!p) return;
    setProj(p); setJiraProjKey(''); setParent(null); setResults([]); setQuery(''); setError('');
  }

  // A child may only be one level below its parent. The effective kind is
  // DERIVED rather than corrected in an effect — picking a parent that rules out
  // the current choice switches it in the same render, so a disabled option can
  // never be shown as the active one.
  const allowedKinds = parent?.hierarchyLevel != null
    ? CHILD_KINDS.filter(k => k.level === parent.hierarchyLevel - 1)
    : CHILD_KINDS;
  const activeKind = allowedKinds.some(k => k.key === kind) ? kind : allowedKinds[0]?.key;

  const chosenKind = CHILD_KINDS.find(k => k.key === activeKind);
  const issueType  = chosenKind ? issueTypes.find(chosenKind.match) : null;

  // ── Field metadata for the chosen type: create screen + status list + sprints ──
  useEffect(() => {
    if (!cloudId || !effectiveJiraKey || !issueType) { setMeta(null); setStatuses([]); return; }
    let cancelled = false;
    setMeta(null); setStatuses([]);
    getCreateMetaFields(cloudId, effectiveJiraKey, issueType.id)
      .then(m => { if (!cancelled) setMeta(m); })
      .catch(() => { if (!cancelled) setMeta({}); });
    // Statuses are harvested from real issues (no authoritative list — see
    // getStatusesUsedByType), so this is several JQL pages: load it lazily here
    // rather than blocking anything else.
    getStatusesUsedByType(cloudId, effectiveJiraKey, issueType.name)
      .then(list => { if (!cancelled) setStatuses(list); })
      .catch(() => { if (!cancelled) setStatuses([]); });
    return () => { cancelled = true; };
  }, [cloudId, effectiveJiraKey, issueType?.id]); // eslint-disable-line

  useEffect(() => {
    if (!cloudId || !effectiveJiraKey) { setSprints([]); return; }
    let cancelled = false;
    getSprintOptions(cloudId, effectiveJiraKey)
      .then(list => { if (!cancelled) setSprints(list); })
      .catch(() => { if (!cancelled) setSprints([]); });
    return () => { cancelled = true; };
  }, [cloudId, effectiveJiraKey]);

  // Only fields this kind asks for AND the project actually puts on the create
  // screen. `status` is always offered — it is applied by transition, not create.
  const shown = (chosenKind?.fields || []).filter(k =>
    k === 'status' || !!metaFor(meta, FIELD_SPECS[k]));
  const priorityMeta = metaFor(meta, FIELD_SPECS.priority);

  const canSubmit = !!parent && !!issueType
    && title.trim() && !isDescriptionEmpty(description) && !creating;

  async function submit(e) {
    e.preventDefault();
    if (!parent)   { setError('Pick a parent issue.'); return; }
    if (!issueType) { setError(`This project has no ${chosenKind?.label} issue type available.`); return; }
    if (!title.trim())                   { setError('Title is required'); return; }
    if (isDescriptionEmpty(description)) { setError('Description is required'); return; }

    setCreating(true); setError(''); setWarning('');

    // Build the create payload from the visible fields only, keyed by the ids the
    // create screen actually reports. Sprint is deliberately left out — its value
    // shape varies per instance, so it is set afterwards (see setIssueSprint).
    const fields = {};
    const idOf = (k) => metaFor(meta, FIELD_SPECS[k])?.fieldId;
    const put  = (k, value) => { const id = idOf(k); if (id && value != null) fields[id] = value; };
    if (shown.includes('assignee')  && form.assignee)  put('assignee',  { accountId: form.assignee.accountId });
    if (shown.includes('developer') && form.developer) put('developer', { accountId: form.developer.accountId });
    if (shown.includes('qa')        && form.qa)        put('qa',        { accountId: form.qa.accountId });
    if (shown.includes('priority')  && form.priority)  put('priority',  { id: String(form.priority) });
    if (shown.includes('devEstimate') && form.devEstimate !== '') put('devEstimate', Number(form.devEstimate));
    if (shown.includes('qaEstimate')  && form.qaEstimate  !== '') put('qaEstimate',  Number(form.qaEstimate));

    try {
      // Children of a request normally carry its component(s) — inherit them.
      const componentIds = (parent.components || []).map(c => c.id);
      const issue = await createChildIssue(
        cloudId, effectiveJiraKey, issueType.id, parent.key,
        title.trim(), description, { componentIds, fields },
      );
      const key = issue.key;

      // Post-create steps. The issue exists from here on, so a failure is a
      // warning on the success panel, never a thrown error that hides the key.
      const problems = [];
      const sprintId = shown.includes('sprint') ? form.sprint : '';
      if (sprintId) {
        try { await setIssueSprint(cloudId, key, idOf('sprint'), sprintId); }
        catch (e) { problems.push(`sprint (${e.message})`); }
      }
      if (form.status) {
        try {
          const landed = await transitionIssueToStatus(cloudId, key, form.status);
          if (!landed) problems.push(`status "${form.status}" (no transition path from the initial status)`);
        } catch (e) { problems.push(`status (${e.message})`); }
      }
      if (problems.length) setWarning(`Created, but could not set: ${problems.join('; ')}.`);

      const res = { jiraKey: key, jiraUrl: getJiraUrl(key), parentKey: parent.key };
      setResult(res);
      onCreated?.(res);
    } catch (err) {
      setError(err.message || 'Could not create the issue.');
    } finally {
      setCreating(false);
    }
  }

  // ── Success panel ──
  if (result) {
    return (
      <div className="overlay">
        <div className="atp-modal">
          <div className="tcm-head">
            <h2 className="card-title" style={{ margin: 0 }}>{chosenKind?.label} created</h2>
            <button className="tcm-close" onClick={onClose} title="Close" aria-label="Close">✕</button>
          </div>
          <div className="atp-body">
            <p className="atp-success">
              <a className="ba-issue-link" href={result.jiraUrl} target="_blank" rel="noreferrer">{result.jiraKey} ↗</a>
              {' '}created in{' '}
              <a className="ba-issue-link" href={getJiraUrl(result.parentKey)} target="_blank" rel="noreferrer">{result.parentKey} ↗</a>
            </p>
            {warning && <p className="atp-warning">⚠ {warning}</p>}
          </div>
          <div className="tcm-actions">
            <button type="button" className="btn btn-primary atp-btn" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !creating) onClose?.(); }}>
      <div className="atp-modal">
        <div className="tcm-head">
          <h2 className="card-title" style={{ margin: 0 }}>Add to an existing request</h2>
          <button className="tcm-close" onClick={() => !creating && onClose?.()} title="Close" aria-label="Close">✕</button>
        </div>

        <form className="atp-body" onSubmit={submit}>
          <div className="atp-row">
            <div className="field" style={{ flex: 1 }}>
              <label className="field-label">Project</label>
              <select className="select" value={proj?.id ?? ''} onChange={e => changeProject(e.target.value)}>
                {visibleProjects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
            {(proj?.jiraProjectOptions || []).length > 1 && (
              <div className="field" style={{ width: 160 }}>
                <label className="field-label">Jira project</label>
                <select className="select" value={effectiveJiraKey}
                  onChange={e => { setJiraProjKey(e.target.value); setParent(null); }}>
                  {proj.jiraProjectOptions.map(k => <option key={k} value={k}>{k}</option>)}
                </select>
              </div>
            )}
          </div>

          {/* ── Parent ── */}
          <div className="field">
            <label className="field-label">Parent</label>
            {parent ? (
              <div className="atp-parent">
                <span className="atp-type">{parent.type}</span>
                <a className="ba-issue-link" href={getJiraUrl(parent.key)} target="_blank" rel="noreferrer">{parent.key} ↗</a>
                <span className="atp-parent-sum">{parent.summary}</span>
                <span className={`atp-status atp-status-${statusTone(parent.status)}`}>{parent.status}</span>
                <button type="button" className="tf-linkbtn atp-change" onClick={() => { setParent(null); setResults([]); }}>
                  change
                </button>
              </div>
            ) : (
              <>
                <input
                  className="input"
                  placeholder="Search requests and epics by key or title…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                <div className="atp-results">
                  {searching && <p className="atp-dim"><span className="spinner" style={{ width: 12, height: 12 }} /> Searching…</p>}
                  {!searching && searchErr && <p className="error-msg">⚠ {searchErr}</p>}
                  {!searching && !searchErr && results.length === 0 && (
                    <p className="atp-dim">No requests or epics match.</p>
                  )}
                  {!searching && results.map(r => (
                    <button type="button" key={r.key} className="atp-result" onClick={() => setParent(r)}>
                      <span className="atp-type">{r.type}</span>
                      <span className="atp-result-key">{r.key}</span>
                      <span className="atp-result-sum">{r.summary}</span>
                      <span className={`atp-status atp-status-${statusTone(r.status)}`}>{r.status}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ── Child type ── */}
          <div className="field">
            <label className="field-label">Create as</label>
            <div className="atp-kinds">
              {CHILD_KINDS.map(k => {
                const ok = allowedKinds.some(a => a.key === k.key);
                return (
                  <button
                    type="button"
                    key={k.key}
                    className={`atp-kind${activeKind === k.key ? ' active' : ''}`}
                    onClick={() => ok && setKind(k.key)}
                    disabled={!ok}
                    title={ok ? '' : `${withArticle(k.label)} can't sit directly under ${withArticle(parent?.type || 'issue').toLowerCase()}`}
                  >
                    {k.label}
                  </button>
                );
              })}
            </div>
            {parent && (
              <p className="atp-hint">
                {allowedKinds.length
                  ? `${withArticle(parent.type)} takes ${allowedKinds.map(k => k.label).join(' / ')} children.`
                  : `${parent.type} issues can't take Epic or Task children.`}
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label">Title</label>
            <input className="input" value={title} onChange={e => setTitle(e.target.value)} required />
          </div>

          <div className="field">
            <label className="field-label">Description</label>
            <RichTextEditor value={description} onChange={setDescription} placeholder="Describe the task in detail…" />
          </div>

          {/* ── Fields, per child kind: an Epic gets status + assignee, a Task the
                whole planning set (only what the create screen actually has). ── */}
          {shown.length > 0 && (
            <div className="atp-fields">
              <p className="atp-fields-head">{chosenKind?.label} fields</p>
              <div className="atp-fields-grid">
                {shown.includes('status') && (
                  <label className="atp-f">
                    <span className="atp-f-label">Status</span>
                    <select className="select" value={form.status} onChange={e => setField('status', e.target.value)}>
                      <option value="">{statuses.length ? '— Workflow default —' : 'Loading…'}</option>
                      {statuses.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
                    </select>
                  </label>
                )}
                {shown.includes('sprint') && (
                  <label className="atp-f">
                    <span className="atp-f-label">Sprint</span>
                    <select className="select" value={form.sprint} onChange={e => setField('sprint', e.target.value)}>
                      <option value="">— None —</option>
                      {sprints.map(s => (
                        <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' (active)' : ''}</option>
                      ))}
                    </select>
                  </label>
                )}
                {shown.includes('assignee') && (
                  <label className="atp-f">
                    <span className="atp-f-label">Assignee</span>
                    <UserSelect cloudId={cloudId} label="Assignee" value={form.assignee}
                      onChange={u => setField('assignee', u)} />
                  </label>
                )}
                {shown.includes('developer') && (
                  <label className="atp-f">
                    <span className="atp-f-label">Developer</span>
                    <UserSelect cloudId={cloudId} label="Developer" value={form.developer}
                      onChange={u => setField('developer', u)} />
                  </label>
                )}
                {shown.includes('qa') && (
                  <label className="atp-f">
                    <span className="atp-f-label">QA</span>
                    <UserSelect cloudId={cloudId} label="QA" value={form.qa}
                      onChange={u => setField('qa', u)} />
                  </label>
                )}
                {shown.includes('devEstimate') && (
                  <label className="atp-f">
                    <span className="atp-f-label">Developer Estimate</span>
                    <input className="input" type="number" min="0" step="0.5" placeholder="hours"
                      value={form.devEstimate} onChange={e => setField('devEstimate', e.target.value)} />
                  </label>
                )}
                {shown.includes('qaEstimate') && (
                  <label className="atp-f">
                    <span className="atp-f-label">QA Estimate</span>
                    <input className="input" type="number" min="0" step="0.5" placeholder="hours"
                      value={form.qaEstimate} onChange={e => setField('qaEstimate', e.target.value)} />
                  </label>
                )}
                {shown.includes('priority') && (
                  <label className="atp-f">
                    <span className="atp-f-label">Priority</span>
                    <select className="select" value={form.priority} onChange={e => setField('priority', e.target.value)}>
                      <option value="">— Default —</option>
                      {(priorityMeta?.allowedValues || []).map(p => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            </div>
          )}

          {error && <p className="error-msg">⚠ {error}</p>}

          <div className="tcm-actions">
            <button type="button" className="btn btn-ghost" onClick={() => !creating && onClose?.()}>Cancel</button>
            <button type="submit" className="btn btn-primary atp-btn"
              style={canSubmit ? {} : { opacity: 0.32, cursor: 'not-allowed' }}
              aria-disabled={!canSubmit} disabled={creating}>
              {creating
                ? <><span className="spinner" style={{ borderTopColor: '#fff', borderColor: 'rgba(255,255,255,.25)' }} /> Creating…</>
                : `Create ${chosenKind?.label ?? 'issue'}${parent ? ` in ${parent.key}` : ''} ↗`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
