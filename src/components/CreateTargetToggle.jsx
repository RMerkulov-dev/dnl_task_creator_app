import { useEffect } from 'react';
import { resolveTargets } from '../services/taskSync.js';

// ─── Create target: toggle + confirmation ─────────────────────────────────────
//
// Where should a new task land — Azure DevOps, Jira, or both? "Both" is the
// default on every page load and is restored after every create, and the
// confirmation step below always names the resolved destination, so a run that
// writes to only one system can never happen unnoticed.
//
// Both pieces live here because they must agree on the same wording; Dashboard
// and TaskCreateModal each render both. CSS prefix `.tgt-*`.

export const TARGET_OPTIONS = [
  { id: 'both',  label: 'Azure + Jira' },
  { id: 'azure', label: 'Azure only'   },
  { id: 'jira',  label: 'Jira only'    },
];

// Short label for buttons ("Create in …").
export function targetLabel(project, target) {
  const t = resolveTargets(project, target);
  if (t.azure && t.jira) return 'Azure + Jira';
  if (t.azure)           return 'Azure only';
  return 'Jira only';
}

// Full sentence for the form's subtitle.
export function targetSummary(project, target) {
  const t = resolveTargets(project, target);
  const type = project?.azure?.workItemType ?? 'Item';
  if (t.azure && t.jira) return `Creates Azure DevOps ${type} + Jira Request`;
  if (t.azure)           return `Creates Azure DevOps ${type} only — no Jira Request`;
  return `Creates a Jira Request only — no Azure DevOps ${type}`;
}

export default function CreateTargetToggle({ project, value, onChange, disabled }) {
  // A project without Jira can only create in Azure — the toggle would be a
  // choice between one real option and two dead ones.
  if (!project?.jira) return null;
  const t = resolveTargets(project, value);

  return (
    <div className="field tgt-field">
      <label className="field-label">Create in</label>
      <div className="segment segment-sm tgt-segment" role="group" aria-label="Create in">
        {TARGET_OPTIONS.map(opt => (
          <button
            key={opt.id}
            type="button"
            className={`seg-btn ${value === opt.id ? 'active' : ''}`}
            aria-pressed={value === opt.id}
            disabled={disabled}
            onClick={() => onChange(opt.id)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {!(t.azure && t.jira) && (
        <p className="tgt-note">
          ⚠ {t.azure
            ? 'No Jira Request will be created.'
            : `No Azure DevOps ${project.azure.workItemType} will be created.`}
        </p>
      )}
    </div>
  );
}

// ─── Confirmation ─────────────────────────────────────────────────────────────
// Shown on every Create click (not on edits): the list of destinations is the
// reminder that the toggle above may still be on a single system from last time.
export function ConfirmCreateModal({ project, target, title, onConfirm, onCancel }) {
  const t = resolveTargets(project, target);
  const type = project?.azure?.workItemType ?? 'Item';
  const jiraKey = project?.jira?.projectKey ?? '';
  const single = !(t.azure && t.jira);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
      if (e.key === 'Enter')  { e.preventDefault(); onConfirm?.(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return (
    <div className="overlay tgt-confirm-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onCancel?.(); }}>
      <div className="tgt-confirm">
        <p className="tgt-confirm-title">Create this task in:</p>

        <ul className="tgt-confirm-list">
          <li className={`tgt-confirm-row${t.azure ? '' : ' off'}`}>
            <span className="tgt-confirm-mark">{t.azure ? '✓' : '✕'}</span>
            <span className="tgt-confirm-name">Azure DevOps {type}</span>
            <span className="tgt-confirm-meta">{project?.azure?.project}</span>
          </li>
          <li className={`tgt-confirm-row${t.jira ? '' : ' off'}`}>
            <span className="tgt-confirm-mark">{t.jira ? '✓' : '✕'}</span>
            <span className="tgt-confirm-name">Jira Request</span>
            <span className="tgt-confirm-meta">{t.jira ? jiraKey : '—'}</span>
          </li>
        </ul>

        {title && <p className="tgt-confirm-task" title={title}>{title}</p>}

        {single && (
          <p className="tgt-confirm-warn">
            ⚠ Only one system will be written to. The two records will not be linked.
          </p>
        )}

        <div className="tgt-confirm-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={onConfirm} autoFocus>
            Create in {targetLabel(project, target)} ↗
          </button>
        </div>
      </div>
    </div>
  );
}
