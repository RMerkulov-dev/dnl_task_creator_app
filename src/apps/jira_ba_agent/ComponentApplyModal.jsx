import { useState, useEffect, useMemo } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import { getProjectComponents, getChildIssues, addIssueComponent } from '../../services/jira.js';
import { SearchSelect } from '../jira_component/JiraComponentApp.jsx';

const CLOUD_ID  = PROJECT_LIST.find(p => p.jira)?.jira.cloudId ?? '';
const JIRA_BASE = 'https://dynamicalabs.atlassian.net/browse/';

// ─── Component-apply modal ────────────────────────────────────────────────────
// Bridges the BA agent's search results into the Component addon's bulk-apply
// flow: takes the issues the user selected in the results table, lets them pick
// a component (scoped to one Jira project — components are per-project) and
// applies it to each issue and, optionally, its child Epics. Reuses the same
// jira.js helpers and the `.jcomp-*` progress rows as the Component tab, so the
// behaviour (append-only component update) and the look are identical.
export default function ComponentApplyModal({ issues, onClose }) {
  // Group selected issues by project prefix (ABS-12 → ABS). A component only
  // exists inside one project, so the apply run is scoped to one group; issues
  // from other projects are listed as skipped rather than silently dropped.
  const byProject = useMemo(() => {
    const m = new Map();
    for (const i of issues) {
      const p = (i.key || '').split('-')[0];
      if (!p) continue;
      if (!m.has(p)) m.set(p, []);
      m.get(p).push(i);
    }
    return m;
  }, [issues]);

  const projectKeys = useMemo(
    () => [...byProject.keys()].sort((a, b) => byProject.get(b).length - byProject.get(a).length),
    [byProject],
  );

  const [projectKey,  setProjectKey]  = useState(projectKeys[0] || '');
  const [components,  setComponents]  = useState([]);
  const [componentIds, setComponentIds] = useState([]);
  const [compLoading, setCompLoading] = useState(false);
  const [withEpics,   setWithEpics]   = useState(true);
  const [rows,        setRows]        = useState(null);   // null until Apply pressed
  const [running,     setRunning]     = useState(false);
  const [error,       setError]       = useState('');

  const targetIssues  = byProject.get(projectKey) ?? [];
  const skippedCount  = issues.length - targetIssues.length;
  const componentNames = components.filter(c => componentIds.includes(c.value)).map(c => c.label);

  // Load the component catalogue whenever the target project changes.
  useEffect(() => {
    setComponents([]); setComponentIds([]);
    if (!projectKey) return;
    let cancelled = false;
    setCompLoading(true);
    getProjectComponents(CLOUD_ID, projectKey)
      .then(list => { if (!cancelled) setComponents(list.map(c => ({ value: String(c.id), label: c.name }))); })
      .catch(() => { if (!cancelled) setError(`Could not load components for ${projectKey}.`); })
      .finally(() => { if (!cancelled) setCompLoading(false); });
    return () => { cancelled = true; };
  }, [projectKey]);

  function patchRow(idx, patch) {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function patchTarget(idx, tKey, patch) {
    setRows(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      return { ...r, targets: r.targets.map(t => (t.key === tKey ? { ...t, ...patch } : t)) };
    }));
  }

  async function run() {
    if (!componentIds.length) { setError('Select at least one component first.'); return; }
    setError('');
    setRunning(true);

    const initial = targetIssues.map(i => ({
      key:     i.key,
      state:   'pending',
      targets: [{ key: i.key, type: 'Request', state: 'pending', error: '' }],
    }));
    setRows(initial);

    // Sequential, same as the Component tab — never hammer Jira.
    for (let idx = 0; idx < initial.length; idx++) {
      const row = initial[idx];
      patchRow(idx, { state: 'working' });

      let targets = [...row.targets];
      if (withEpics) {
        try {
          const children = await getChildIssues(CLOUD_ID, row.key);
          targets = [
            ...targets,
            ...children
              .filter(c => (c.fields?.issuetype?.name || '').toLowerCase() === 'epic')
              .map(c => ({ key: c.key, type: 'Epic', state: 'pending', error: '' })),
          ];
          patchRow(idx, { targets });
        } catch { /* non-fatal — still apply to the issue itself */ }
      }

      let anyError = false;
      for (const t of targets) {
        patchTarget(idx, t.key, { state: 'working' });
        const r = await addIssueComponent(CLOUD_ID, t.key, componentIds);
        if (r.ok) patchTarget(idx, t.key, { state: 'done' });
        else { anyError = true; patchTarget(idx, t.key, { state: 'error', error: r.error || 'Failed' }); }
      }
      patchRow(idx, { state: anyError ? 'error' : 'done' });
    }

    setRunning(false);
  }

  const progress = useMemo(() => {
    if (!rows) return null;
    let total = 0, done = 0, failed = 0;
    for (const r of rows) for (const t of r.targets) {
      total++;
      if (t.state === 'done') done++;
      else if (t.state === 'error') failed++;
    }
    return { total, done, failed, finished: !running && rows.length > 0 };
  }, [rows, running]);

  const stateDot = s => <span className={`jcomp-dot jcomp-dot-${s}`} aria-hidden />;

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget && !running) onClose?.(); }}>
      <div className="ba-comp-modal">
        <div className="ba-comp-head">
          <h3 className="ba-comp-title">Set component</h3>
          <button className="tcm-close" onClick={() => !running && onClose?.()} title="Close" aria-label="Close">✕</button>
        </div>
        <p className="ba-comp-sub">
          Applies one or more Jira components to {targetIssues.length} issue{targetIssues.length === 1 ? '' : 's'} from the
          search result{withEpics ? ' and their child Epics' : ''}. Existing components are kept (append, never overwrite).
        </p>

        {projectKeys.length > 1 && (
          <div className="ba-comp-field">
            <label className="ba-comp-label">Jira project</label>
            <div className="ba-comp-projects">
              {projectKeys.map(p => (
                <button
                  key={p}
                  type="button"
                  className={`tf-chip tf-group${p === projectKey ? ' active' : ''}`}
                  disabled={running || !!rows}
                  onClick={() => setProjectKey(p)}
                >
                  {p} <span className="tf-group-n">{byProject.get(p).length}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {skippedCount > 0 && (
          <p className="ba-comp-skip">
            ⚠ {skippedCount} selected issue{skippedCount === 1 ? '' : 's'} belong{skippedCount === 1 ? 's' : ''} to
            other projects and will be skipped (components are per-project).
          </p>
        )}

        <div className="ba-comp-field">
          <label className="ba-comp-label">
            Components in {projectKey || '—'}
            {componentIds.length > 0 && <span style={{ color: 'var(--text-3)' }}> ({componentIds.length} selected)</span>}
          </label>
          <SearchSelect
            multiple
            items={components}
            value={componentIds}
            onChange={setComponentIds}
            placeholder={compLoading ? 'Loading components…' : 'Select components…'}
            searchPlaceholder="Search components…"
            disabled={compLoading || running || !!rows}
          />
        </div>

        <label className="ba-comp-epics">
          <input
            type="checkbox"
            className="ba-issues-check"
            checked={withEpics}
            disabled={running || !!rows}
            onChange={e => setWithEpics(e.target.checked)}
          />
          Also apply to child Epics
        </label>

        {error && <p className="ba-input-error" style={{ marginTop: 10 }}>⚠ {error}</p>}

        {rows && (
          <ul className="jcomp-rows ba-comp-rows">
            {rows.map((row, i) => (
              <li key={row.key} className={`jcomp-row jcomp-row-${row.state}`} style={{ '--i': i }}>
                <div className="jcomp-row-head">
                  {stateDot(row.state)}
                  <span className="jcomp-row-token">{row.key}</span>
                </div>
                {row.targets.length > 0 && (
                  <ul className="jcomp-targets">
                    {row.targets.map((t, ti) => (
                      <li key={t.key} className="jcomp-target" style={{ '--i': ti }}>
                        {stateDot(t.state)}
                        <span className="jcomp-target-type">{t.type}</span>
                        <a className="jcomp-target-key" href={`${JIRA_BASE}${t.key}`} target="_blank" rel="noreferrer">{t.key}</a>
                        {t.error && <span className="jcomp-target-err">{t.error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="ba-comp-footer">
          {progress && (
            <span className="ba-comp-progress">
              {progress.done + progress.failed} / {progress.total}
              {progress.failed > 0 && <span style={{ color: 'var(--red)' }}> · {progress.failed} failed</span>}
            </span>
          )}
          <button className="btn btn-ghost" onClick={() => !running && onClose?.()} disabled={running}>
            {progress?.finished ? 'Close' : 'Cancel'}
          </button>
          {!rows && (
            <button className="btn btn-primary" onClick={run} disabled={running || !componentIds.length || !targetIssues.length}>
              {`Apply ${componentNames.length > 1
                ? `${componentNames.length} components`
                : (componentNames[0] ? `"${componentNames[0]}"` : '')} to ${targetIssues.length} issue${targetIssues.length === 1 ? '' : 's'}`.replace(/\s+/g, ' ')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
