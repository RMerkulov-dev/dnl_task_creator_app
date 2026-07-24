import { useState, useEffect, useRef } from 'react';
import { getWorkItem, getWorkItemStates, updateWorkItemState } from '../services/azureDevops.js';
import { getIssuesStatusByKeys, getTransitions, transitionIssue } from '../services/jira.js';

// Azure DevOps state categories → chip colour buckets (mirrors StatusUpdatesApp).
const AZURE_STATE_TONE = {
  Proposed: 'todo', InProgress: 'progress', Resolved: 'progress',
  Completed: 'done', Removed: 'done',
};
// Jira status categories → the same chip colour buckets.
const JIRA_STATUS_TONE = { new: 'todo', indeterminate: 'progress', done: 'done' };

// Close a fixed-position popover when the page scrolls/resizes so it never
// detaches from the chip it's anchored to.
function useCloseOnScroll(open, close) {
  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);
}

// ─── Step definitions — derived from project config ───────────────────────────
function buildStepDefs(mode, project, stepCount) {
  const type = project?.azure?.workItemType ?? 'Item';
  const hasJira = !!project?.jira;
  const hasLinkBack = !!project?.azure?.jiraIdField;

  if (mode === 'createFromJira') {
    return [
      { label: `Creating Azure DevOps ${type}` },
      ...(hasJira ? [{ label: 'Linking Jira Request' }] : []),
    ];
  }

  if (mode === 'edit') {
    const isNewJira = stepCount > 2;
    return [
      { label: `Updating Azure DevOps ${type}` },
      ...(hasJira ? [{ label: isNewJira ? 'Creating Jira Request' : 'Updating Jira Request' }] : []),
      ...(isNewJira && hasLinkBack ? [{ label: 'Linking records' }] : []),
    ];
  }
  return [
    { label: `Creating Azure DevOps ${type}` },
    ...(project?.features?.azureIdInTitle ? [{ label: 'Adding Azure ID to title' }] : []),
    ...(hasJira ? [{ label: 'Creating Jira Request' }] : []),
    ...(hasJira && hasLinkBack ? [{ label: 'Linking records' }] : []),
  ];
}

// ─── Sub-components ───────────────────────────────────────────────────────────
function StepIcon({ status }) {
  if (status === 'pending') return <span className="step-icon pending"><span className="spinner" /></span>;
  if (status === 'done')    return <span className="step-icon done">✓</span>;
  if (status === 'error')   return <span className="step-icon error">✕</span>;
  if (status === 'skipped') return <span className="step-icon skipped">—</span>;
  return <span className="step-icon idle">·</span>;
}

function ExternalLinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M15 3h6v6M10 14L21 3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

// ─── Inline-editable Azure DevOps state chip ──────────────────────────────────
// Loads the work item's current state + valid states for its type on mount, then
// lets the user pick a new state (PATCH System.State). Azure validates the move
// server-side, so an illegal transition surfaces as an error in the menu.
function AzureStatusInline({ azure, id }) {
  const btnRef = useRef(null);
  const [current, setCurrent] = useState(null);   // current state name (null = loading)
  const [states,  setStates]  = useState(null);
  const [initErr, setInitErr] = useState('');
  const [open,    setOpen]    = useState(false);
  const [pos,     setPos]     = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [err,     setErr]     = useState('');

  useCloseOnScroll(open, () => setOpen(false));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [item, list] = await Promise.all([
          getWorkItem(azure.proxyKey, azure.project, id),
          getWorkItemStates(azure.proxyKey, azure.project, azure.workItemType),
        ]);
        if (!alive) return;
        setCurrent(item.fields?.['System.State'] ?? '');
        setStates(list);
      } catch (e) {
        if (alive) setInitErr(e.message || 'Failed to load state');
      }
    })();
    return () => { alive = false; };
  }, [azure.proxyKey, azure.project, azure.workItemType, id]);

  const cat  = (states || []).find(s => s.name === current)?.category;
  const tone = AZURE_STATE_TONE[cat] || 'todo';
  const loading = current == null && !initErr;

  function toggle() {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    setErr('');
  }

  async function apply(name) {
    if (name === current) { setOpen(false); return; }
    setSaving(true); setErr('');
    try {
      await updateWorkItemState(azure.proxyKey, azure.project, id, name);
      setCurrent(name);
      setOpen(false);
    } catch (e) {
      setErr(e.message || 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sync-status-row">
      <span className="sync-status-label">Azure state</span>
      {initErr ? (
        <span className="su-status su-status-none" title={initErr}>Unavailable</span>
      ) : (
        <span className="su-status-wrap">
          <button
            ref={btnRef}
            type="button"
            className={`su-status su-status-${tone} su-status-editable`}
            onClick={toggle}
            disabled={loading || saving}
            title="Change Azure state"
          >
            {loading || saving ? <span className="spinner" style={{ width: 10, height: 10 }} /> : (current || '—')}
            {!loading && <span className="su-status-caret">▾</span>}
          </button>

          {open && (
            <>
              <div className="su-status-backdrop" onClick={() => setOpen(false)} />
              <div className="su-status-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
                {err && <div className="su-status-menu-item su-status-menu-err">⚠ {err}</div>}
                {(states || []).map(s => (
                  <button
                    key={s.name}
                    type="button"
                    className={`su-status-menu-item${s.name === current ? ' active' : ''}`}
                    disabled={saving}
                    onClick={() => apply(s.name)}
                  >
                    {s.color && <span className="su-state-dot" style={{ background: `#${s.color}` }} />}
                    <span className="su-status-menu-name">{s.name}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </span>
      )}
    </div>
  );
}

// ─── Inline-editable Jira status chip ─────────────────────────────────────────
// Loads the issue's current status on mount; on open lazy-loads its valid
// workflow transitions and applies the chosen one.
function JiraStatusInline({ cloudId, jiraKey }) {
  const btnRef = useRef(null);
  const [status,      setStatus]      = useState(null);   // current status name (null = loading)
  const [category,    setCategory]    = useState('');
  const [initErr,     setInitErr]     = useState('');
  const [transitions, setTransitions] = useState(null);
  const [loadingTr,   setLoadingTr]   = useState(false);
  const [open,        setOpen]        = useState(false);
  const [pos,         setPos]         = useState(null);
  const [saving,      setSaving]      = useState(false);
  const [err,         setErr]         = useState('');

  useCloseOnScroll(open, () => setOpen(false));

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const map = await getIssuesStatusByKeys(cloudId, [jiraKey]);
        if (!alive) return;
        const info = map.get(jiraKey);
        setStatus(info?.status ?? '');
        setCategory(info?.statusCategory ?? '');
      } catch (e) {
        if (alive) setInitErr(e.message || 'Failed to load status');
      }
    })();
    return () => { alive = false; };
  }, [cloudId, jiraKey]);

  const tone = JIRA_STATUS_TONE[category] || 'todo';
  const loading = status == null && !initErr;

  async function toggle() {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    setErr('');
    if (transitions == null) {
      setLoadingTr(true);
      try {
        setTransitions(await getTransitions(cloudId, jiraKey));
      } catch (e) {
        setErr(e.message || 'Failed to load transitions');
      } finally {
        setLoadingTr(false);
      }
    }
  }

  async function apply(t) {
    setSaving(true); setErr('');
    try {
      await transitionIssue(cloudId, jiraKey, t.id);
      setStatus(t.to?.name ?? t.name);
      setCategory(t.to?.statusCategory?.key ?? category);
      setOpen(false);
      setTransitions(null);   // available transitions change after a move — refetch next open
    } catch (e) {
      setErr(e.message || 'Transition failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="sync-status-row">
      <span className="sync-status-label">Jira status</span>
      {initErr ? (
        <span className="su-status su-status-none" title={initErr}>Unavailable</span>
      ) : (
        <span className="su-status-wrap">
          <button
            ref={btnRef}
            type="button"
            className={`su-status su-status-${tone} su-status-editable`}
            onClick={toggle}
            disabled={loading || saving}
            title="Change Jira status"
          >
            {loading || saving ? <span className="spinner" style={{ width: 10, height: 10 }} /> : (status || '—')}
            {!loading && <span className="su-status-caret">▾</span>}
          </button>

          {open && (
            <>
              <div className="su-status-backdrop" onClick={() => setOpen(false)} />
              <div className="su-status-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
                {loadingTr && <div className="su-status-menu-item muted"><span className="spinner" style={{ width: 12, height: 12 }} /> Loading…</div>}
                {err && <div className="su-status-menu-item su-status-menu-err">⚠ {err}</div>}
                {!loadingTr && !err && transitions?.length === 0 && (
                  <div className="su-status-menu-item muted">No transitions available</div>
                )}
                {!loadingTr && !err && transitions?.map(t => (
                  <button key={t.id} type="button" className="su-status-menu-item" disabled={saving} onClick={() => apply(t)}>
                    <span className="su-status-menu-name">{t.name}</span>
                    {t.to?.name && t.to.name !== t.name && <span className="su-status-menu-to">→ {t.to.name}</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </span>
      )}
    </div>
  );
}

// ─── Success panel shown when result is available ─────────────────────────────
function SuccessPanel({ project, result, onClose }) {
  const { epicId, epicUrl, jiraKey, jiraUrl } = result ?? {};
  const showStatus = (epicId && project?.azure) || (jiraKey && project?.jira);
  return (
    <div className="sync-success">
      <div className="sync-success-icon">✓</div>
      <p className="sync-success-title">Done!</p>

      <div className="sync-success-links">
        {epicUrl && (
          <a className="sync-link" href={epicUrl} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            Azure #{epicId}
          </a>
        )}
        {jiraKey && jiraUrl && (
          <a className="sync-link" href={jiraUrl} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            Jira {jiraKey}
          </a>
        )}
      </div>

      {showStatus && (
        <div className="sync-status-panel">
          {epicId && project?.azure && <AzureStatusInline azure={project.azure} id={epicId} />}
          {jiraKey && project?.jira && <JiraStatusInline cloudId={project.jira.cloudId} jiraKey={jiraKey} />}
        </div>
      )}

      <button className="btn btn-primary" style={{ marginTop: 20, width: '100%' }} onClick={onClose}>
        Close
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SyncModal({ mode, project, steps, result, onClose, onRetry }) {
  const defs   = buildStepDefs(mode, project, steps.length);
  const hasErr = steps.some(s => s?.status === 'error');
  const isDone = !!result && !hasErr;

  return (
    <div className="overlay">
      <div className="modal">

        {/* X close button — only when done or errored, not while syncing */}
        {(isDone || hasErr) && (
          <button className="modal-close-btn" onClick={onClose} title="Close">
            <CloseIcon />
          </button>
        )}

        {isDone ? (
          <SuccessPanel project={project} result={result} onClose={onClose} />
        ) : (
          <>
            <p className="modal-title">
              {hasErr ? '⚠ Sync Error' : 'Syncing task…'}
            </p>

            <ul className="step-list">
              {defs.map((def, i) => {
                const s = steps[i] ?? {};
                return (
                  <li className="step-item" key={def.label}>
                    <StepIcon status={s.status} />
                    <div className="step-body">
                      <p className="step-name">{def.label}</p>
                      {s.error && <p className="step-error">{s.error}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>

            {hasErr && (
              <div style={{ display: 'flex', gap: 8 }}>
                {onRetry && (
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={onRetry}>
                    Retry failed step
                  </button>
                )}
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={onClose}>Close</button>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
