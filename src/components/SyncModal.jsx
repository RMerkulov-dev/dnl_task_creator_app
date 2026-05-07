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

// ─── Main component ───────────────────────────────────────────────────────────
export default function SyncModal({ mode, project, steps, onClose }) {
  const defs   = buildStepDefs(mode, project, steps.length);
  const hasErr = steps.some(s => s?.status === 'error');

  return (
    <div className="overlay">
      <div className="modal">
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
      </div>
    </div>
  );
}
