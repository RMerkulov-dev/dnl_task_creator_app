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

// ─── Success panel shown when result is available ─────────────────────────────
function SuccessPanel({ result, onClose }) {
  const { epicId, epicUrl, jiraKey, jiraUrl } = result ?? {};
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

      <button className="btn btn-primary" style={{ marginTop: 20, width: '100%' }} onClick={onClose}>
        Close
      </button>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function SyncModal({ mode, project, steps, result, onClose }) {
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
          <SuccessPanel result={result} onClose={onClose} />
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
              <button className="btn btn-primary" onClick={onClose}>Close</button>
            )}
          </>
        )}

      </div>
    </div>
  );
}
