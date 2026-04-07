// Progress modal shown during Create / Edit operations

const CREATE_STEPS = [
  { label: 'Creating Azure DevOps Epic' },
  { label: 'Creating Jira Request' },
  { label: 'Linking records' },
];

const EDIT_STEPS = [
  { label: 'Updating Azure DevOps Epic' },
  { label: 'Updating Jira Request' },
];

function StepIcon({ status }) {
  if (status === 'pending') return <span className="step-icon pending"><span className="spinner" /></span>;
  if (status === 'done')    return <span className="step-icon done">✓</span>;
  if (status === 'error')   return <span className="step-icon error">✕</span>;
  if (status === 'skipped') return <span className="step-icon skipped">—</span>;
  return <span className="step-icon idle">·</span>;
}

export default function SyncModal({ mode, steps, result, onClose }) {
  const definitions = mode === 'edit' ? EDIT_STEPS : CREATE_STEPS;
  const allDone = steps.every(s => s.status === 'done' || s.status === 'skipped');
  const hasError = steps.some(s => s.status === 'error');

  return (
    <div className="overlay">
      <div className="modal">
        <p className="modal-title">
          {hasError ? '⚠ Sync Error' : allDone ? '✓ Sync Complete' : 'Syncing task…'}
        </p>

        <ul className="step-list">
          {definitions.map((def, i) => {
            const s = steps[i] ?? {};
            return (
              <li className="step-item" key={def.label}>
                <StepIcon status={s.status ?? 'idle'} />
                <div className="step-body">
                  <p className="step-name">{def.label}</p>
                  {s.data?.epicId && (
                    <a
                      className="step-link"
                      href={s.data.epicUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Epic #{s.data.epicId} ↗
                    </a>
                  )}
                  {s.data?.jiraKey && (
                    <a
                      className="step-link"
                      href={s.data.jiraUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
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
                <a
                  className="result-link-anchor"
                  href={result.epicUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Epic #{result.epicId} ↗
                </a>
              </div>
            )}
            {result.jiraUrl && (
              <div className="result-link-row">
                <span className="result-link-label">Jira</span>
                <a
                  className="result-link-anchor"
                  href={result.jiraUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {result.jiraKey} ↗
                </a>
              </div>
            )}
          </div>
        )}

        {(allDone || hasError) && (
          <button className="btn btn-primary" onClick={onClose}>
            {hasError ? 'Close' : 'Done'}
          </button>
        )}
      </div>
    </div>
  );
}
