import { getCreateStepCount, getEditStepCount } from '../services/taskSync.js';

// ─── Step definitions — derived from project config ───────────────────────────
function buildStepDefs(mode, project) {
  const type = project?.azure?.workItemType ?? 'Item';
  const hasJira = !!project?.jira;
  const hasLinkBack = !!project?.azure?.jiraIdField;

  if (mode === 'edit') {
    return [
      { label: `Updating Azure DevOps ${type}` },
      ...(hasJira ? [{ label: 'Updating Jira Request' }] : []),
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
export default function SyncModal({ mode, project, steps, result, onClose }) {
  const defs    = buildStepDefs(mode, project);
  const allDone = steps.length > 0 && steps.every(s => s?.status === 'done' || s?.status === 'skipped');
  const hasErr  = steps.some(s => s?.status === 'error');

  return (
    <div className="overlay">
      <div className="modal">
        <p className="modal-title">
          {hasErr ? '⚠ Sync Error' : allDone ? '✓ Sync Complete' : 'Syncing task…'}
        </p>

        <ul className="step-list">
          {defs.map((def, i) => {
            const s = steps[i] ?? {};
            return (
              <li className="step-item" key={def.label}>
                <StepIcon status={s.status} />
                <div className="step-body">
                  <p className="step-name">{def.label}</p>
                  {s.data?.epicId && (
                    <a className="step-link" href={s.data.epicUrl} target="_blank" rel="noreferrer">
                      #{s.data.epicId} ↗
                    </a>
                  )}
                  {s.data?.jiraKey && (
                    <a className="step-link" href={s.data.jiraUrl} target="_blank" rel="noreferrer">
                      {s.data.jiraKey} ↗
                    </a>
                  )}
                  {s.error && <p className="step-error">{s.error}</p>}
                </div>
              </li>
            );
          })}
        </ul>

        {allDone && result && (
          <div className="result-links">
            {result.epicUrl && (
              <div className="result-link-row">
                <span className="result-link-label">Azure DevOps</span>
                <a className="result-link-anchor" href={result.epicUrl} target="_blank" rel="noreferrer">
                  #{result.epicId} ↗
                </a>
              </div>
            )}
            {result.jiraUrl && (
              <div className="result-link-row">
                <span className="result-link-label">Jira</span>
                <a className="result-link-anchor" href={result.jiraUrl} target="_blank" rel="noreferrer">
                  {result.jiraKey} ↗
                </a>
              </div>
            )}
          </div>
        )}

        {(allDone || hasErr) && (
          <button className="btn btn-primary" onClick={onClose}>
            {hasErr ? 'Close' : 'Done'}
          </button>
        )}
      </div>
    </div>
  );
}
