import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import {
  getJiraProjects,
  getProjectComponents,
  getIssueKeysByAzureIds,
  getChildIssues,
  addIssueComponent,
} from '../../services/jira.js';

const CLOUD_ID = PROJECT_LIST.find(p => p.jira)?.jira.cloudId ?? '';

// Every project in the registry stores the Azure work-item id in the same Jira
// custom field, so a numeric id read off an Azure DevOps card is resolved to a
// Jira key through it. If a project ever uses a different field, add a lookup.
const CLIENT_REQUEST_FIELD = 'customfield_10034';

// ABS-123, NSMG-45 … a Jira key we can act on directly.
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
// A bare integer — treated as an Azure DevOps work-item id to map into Jira.
const AZURE_ID_RE = /^\d+$/;

// ─── Searchable select (same look as the Report / Task Agent project picker) ──

// `multiple: true` turns it into a Jira-style multi-select: `value` is an array
// of values, the closed state renders removable chips, and the open list keeps
// itself open while items are toggled (✓ marks the selected ones).
export function SearchSelect({ items, value, onChange, placeholder, searchPlaceholder = 'Search…', disabled = false, multiple = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const [query,  setQuery]  = useState('');

  const values   = multiple ? (Array.isArray(value) ? value : []) : [];
  const selected = multiple
    ? items.filter(i => values.includes(i.value))
    : (items.find(i => i.value === value) ?? null);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(i => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(q))
    : items;

  function select(v) {
    if (multiple) {
      onChange(values.includes(v) ? values.filter(x => x !== v) : [...values, v]);
      setQuery('');
      return;                       // stay open so several can be picked in a row
    }
    onChange(v); setIsOpen(false); setQuery('');
  }
  function close()    { setIsOpen(false); setQuery(''); }

  return (
    <div className="project-picker">
      {!isOpen ? (
        multiple ? (
          <div
            className="project-picker-current jcomp-multi"
            role="button"
            tabIndex={disabled ? -1 : 0}
            onClick={() => !disabled && setIsOpen(true)}
            onKeyDown={e => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setIsOpen(true); } }}
            style={disabled ? { opacity: .5, cursor: 'not-allowed' } : undefined}
          >
            {selected.length
              ? (
                <span className="jcomp-chips">
                  {selected.map(i => (
                    <span key={i.value} className="jcomp-chip">
                      {i.label}
                      <button
                        type="button"
                        className="jcomp-chip-x"
                        aria-label={`Remove ${i.label}`}
                        disabled={disabled}
                        onClick={e => { e.stopPropagation(); onChange(values.filter(x => x !== i.value)); }}
                      >×</button>
                    </span>
                  ))}
                </span>
              )
              : <span style={{ color: 'var(--text-3)' }}>{placeholder}</span>}
            <span className="project-picker-chevron">▾</span>
          </div>
        ) : (
          <button
            type="button"
            className="project-picker-current"
            onClick={() => setIsOpen(true)}
            disabled={disabled}
            style={disabled ? { opacity: .5, cursor: 'not-allowed' } : undefined}
          >
            {selected
              ? <span>{selected.label}{selected.hint ? <span style={{ color: 'var(--text-3)' }}> ({selected.hint})</span> : null}</span>
              : <span style={{ color: 'var(--text-3)' }}>{placeholder}</span>}
            <span className="project-picker-chevron">▾</span>
          </button>
        )
      ) : (
        <div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              autoFocus
              className="input"
              placeholder={searchPlaceholder}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') close();
                if (e.key === 'Enter' && filtered.length === 1) select(filtered[0].value);
              }}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={close} style={{ flexShrink: 0 }}>
              {multiple ? 'Done' : 'Cancel'}
            </button>
          </div>
          <ul className="project-picker-results">
            {filtered.length === 0 && (
              <li style={{ padding: '9px 14px', fontSize: 13, color: 'var(--text-3)' }}>Nothing found</li>
            )}
            {filtered.map(i => {
              const isSel = multiple && values.includes(i.value);
              return (
                <li key={i.value}>
                  <button
                    type="button"
                    className={`project-picker-result${isSel ? ' jcomp-multi-sel' : ''}`}
                    onClick={() => select(i.value)}
                  >
                    <span>{multiple && <span className="jcomp-multi-tick">{isSel ? '✓' : ''}</span>}{i.label}</span>
                    {i.hint && <span className="project-picker-key">{i.hint}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── Input parsing ────────────────────────────────────────────────────────────

// Split free text into candidate identifiers and classify each. Jira keys are
// upper-cased and used directly; bare integers become Azure ids to resolve.
// Dedupes while preserving first-seen order.
function parseTokens(text) {
  const seen = new Set();
  const out = [];
  for (const rawTok of String(text || '').split(/[^A-Za-z0-9-]+/)) {
    const tok = rawTok.trim();
    if (!tok) continue;
    let kind = null, key = null;
    if (JIRA_KEY_RE.test(tok.toUpperCase())) { kind = 'jira'; key = tok.toUpperCase(); }
    else if (AZURE_ID_RE.test(tok))          { kind = 'azure'; key = tok; }
    else continue;                            // ignore anything that isn't an id
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ token: key, kind });
  }
  return out;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function JiraComponentApp() {
  const [projects, setProjects]     = useState([]);
  const [projectKey, setProjectKey] = useState('');
  const [components, setComponents] = useState([]);
  const [componentIds, setComponentIds] = useState([]);
  const [compLoading, setCompLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);

  const [text, setText] = useState('');
  const [image, setImage] = useState(null);      // { dataUrl, name }
  const [extracting, setExtracting] = useState(false);

  const [rows, setRows] = useState([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);

  // Load Jira projects once.
  useEffect(() => {
    setProjectsLoading(true);
    getJiraProjects(CLOUD_ID)
      .then(list => setProjects(list.map(p => ({ value: p.key, label: p.name, hint: p.key }))))
      .catch(() => setError('Could not load Jira projects.'))
      .finally(() => setProjectsLoading(false));
  }, []);

  // Load components whenever the project changes.
  useEffect(() => {
    setComponents([]); setComponentIds([]);
    if (!projectKey) return;
    setCompLoading(true);
    getProjectComponents(CLOUD_ID, projectKey)
      .then(list => setComponents(list.map(c => ({ value: String(c.id), label: c.name, hint: '' }))))
      .catch(() => setError('Could not load components for this project.'))
      .finally(() => setCompLoading(false));
  }, [projectKey]);

  const tokens = useMemo(() => parseTokens(text), [text]);
  const componentNames = components.filter(c => componentIds.includes(c.value)).map(c => c.label);

  // Overall progress across every target (request + epics) for the progress bar.
  const progress = useMemo(() => {
    let total = 0, done = 0, failed = 0;
    for (const r of rows) for (const t of r.targets) {
      total++;
      if (t.state === 'done') done++;
      else if (t.state === 'error') failed++;
    }
    const settled = done + failed;
    return { total, done, failed, pct: total ? Math.round((settled / total) * 100) : 0 };
  }, [rows]);

  const readFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setImage({ dataUrl: reader.result, name: file.name || 'screenshot' });
    reader.readAsDataURL(file);
  }, []);

  const onPaste = useCallback((e) => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) { e.preventDefault(); readFile(item.getAsFile()); }
  }, [readFile]);

  async function extractFromImage() {
    if (!image) return;
    setExtracting(true); setError('');
    try {
      const res = await fetch('/api/component/extract-ids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: image.dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const found = (data.ids || []).join(' ');
      if (!found.trim()) { setError('No identifiers were found in the screenshot.'); return; }
      // Merge into the textarea so the user sees & can edit what was read.
      setText(prev => (prev.trim() ? `${prev.trim()} ${found}` : found));
    } catch (err) {
      setError(err.message);
    } finally {
      setExtracting(false);
    }
  }

  function patchRow(idx, patch) {
    setRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function patchTarget(rowIdx, tKey, patch) {
    setRows(prev => prev.map((r, i) => {
      if (i !== rowIdx) return r;
      return { ...r, targets: r.targets.map(t => (t.key === tKey ? { ...t, ...patch } : t)) };
    }));
  }

  async function run() {
    setError('');
    if (!projectKey)   { setError('Select a Jira project first.'); return; }
    if (!componentIds.length) { setError('Select at least one component first.'); return; }
    if (!tokens.length){ setError('Paste some Jira keys / Azure ids, or extract them from a screenshot.'); return; }

    setRunning(true);

    // Resolve Azure ids → Jira keys in one batched query, scoped to the project.
    const azureIds = tokens.filter(t => t.kind === 'azure').map(t => t.token);
    let azureMap = new Map();
    try {
      if (azureIds.length) {
        azureMap = await getIssueKeysByAzureIds(CLOUD_ID, projectKey, CLIENT_REQUEST_FIELD, azureIds);
      }
    } catch (err) {
      setError(`Azure id lookup failed: ${err.message}`);
      setRunning(false);
      return;
    }

    // Build the initial row set (one per input identifier).
    const initial = tokens.map(t => {
      const jiraKey = t.kind === 'jira' ? t.token : (azureMap.get(String(t.token)) ?? null);
      return {
        token:   t.token,
        kind:    t.kind,
        jiraKey,
        state:   jiraKey ? 'pending' : 'error',
        message: jiraKey ? '' : (t.kind === 'azure' ? 'No Jira request maps to this Azure id in this project.' : ''),
        targets: jiraKey ? [{ key: jiraKey, type: 'Request', state: 'pending', error: '' }] : [],
      };
    });
    setRows(initial);

    // Process each resolved request sequentially so we never hammer Jira.
    for (let i = 0; i < initial.length; i++) {
      const row = initial[i];
      if (!row.jiraKey) continue;
      patchRow(i, { state: 'working' });

      // Find the request's child epics.
      let epicTargets = [];
      try {
        const children = await getChildIssues(CLOUD_ID, row.jiraKey);
        epicTargets = children
          .filter(c => (c.fields?.issuetype?.name || '').toLowerCase() === 'epic')
          .map(c => ({ key: c.key, type: 'Epic', state: 'pending', error: '' }));
      } catch {
        // Non-fatal — still apply to the request itself.
      }
      const targets = [row.targets[0], ...epicTargets];
      patchRow(i, { targets });

      // Apply the component to the request and each child epic.
      let anyError = false;
      for (const t of targets) {
        patchTarget(i, t.key, { state: 'working' });
        const r = await addIssueComponent(CLOUD_ID, t.key, componentIds);
        if (r.ok) patchTarget(i, t.key, { state: 'done' });
        else { anyError = true; patchTarget(i, t.key, { state: 'error', error: r.error || 'Failed' }); }
      }
      patchRow(i, { state: anyError ? 'error' : 'done' });
    }

    setRunning(false);
  }

  const stateDot = (s) => (
    <span className={`jcomp-dot jcomp-dot-${s}`} aria-hidden />
  );

  return (
    <div className="jcomp">
      <div className="jcomp-head">
        <h2 className="jcomp-title">Component</h2>
        <p className="jcomp-sub">
          Set one or more Jira components on a batch of requests and their child epics — paste Jira keys
          / Azure DevOps ids, or drop a screenshot of the cards.
        </p>
      </div>

      <div className="jcomp-grid">
        {/* ── Left: configuration ── */}
        <div className="jcomp-panel">
          <label className="jcomp-label">Jira project</label>
          <SearchSelect
            items={projects}
            value={projectKey}
            onChange={setProjectKey}
            placeholder={projectsLoading ? 'Loading projects…' : 'Select project…'}
            searchPlaceholder="Search projects…"
            disabled={projectsLoading}
          />

          <label className="jcomp-label" style={{ marginTop: 16 }}>
            Components {componentIds.length > 0 && <span className="jcomp-muted">({componentIds.length} selected)</span>}
          </label>
          <SearchSelect
            multiple
            items={components}
            value={componentIds}
            onChange={setComponentIds}
            placeholder={compLoading ? 'Loading…' : (projectKey ? 'Select components…' : 'Pick a project first')}
            searchPlaceholder="Search components…"
            disabled={!projectKey || compLoading}
          />

          <label className="jcomp-label" style={{ marginTop: 16 }}>
            Identifiers <span className="jcomp-muted">({tokens.length} detected)</span>
          </label>
          <textarea
            className="input jcomp-textarea"
            placeholder="ABS-123, NSMG-45, 10842 …  (Jira keys or Azure ids, any separator)"
            value={text}
            onChange={e => setText(e.target.value)}
            onPaste={onPaste}
            rows={5}
          />

          <div
            className={`jcomp-drop${dragOver ? ' is-drag' : ''}${image ? ' has-image' : ''}`}
            onDragOver={e => { e.preventDefault(); }}
            onDragEnter={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={e => { e.preventDefault(); setDragOver(false); }}
            onDrop={e => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files?.[0]); }}
            onClick={() => fileRef.current?.click()}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={e => { readFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            {image ? (
              <div className="jcomp-thumbwrap">
                <img src={image.dataUrl} alt={image.name} className="jcomp-thumb" />
                <span className="jcomp-thumbname">{image.name}</span>
              </div>
            ) : (
              <span className="jcomp-muted">Drop, paste or click to add a screenshot of Azure DevOps / Jira cards</span>
            )}
          </div>

          <div className="jcomp-actions">
            {image && (
              <>
                <button type="button" className="btn btn-ghost" onClick={extractFromImage} disabled={extracting}>
                  {extracting ? <><span className="spinner" /> Reading…</> : 'Extract ids from image'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setImage(null)} disabled={extracting}>
                  Remove image
                </button>
              </>
            )}
            <button
              type="button"
              className={`btn btn-primary jcomp-run${running ? ' is-running' : ''}`}
              onClick={run}
              disabled={running || !projectKey || !componentIds.length || !tokens.length}
            >
              {running
                ? <><span className="spinner" /> Applying…</>
                : `Apply ${componentNames.length > 1
                    ? `${componentNames.length} components`
                    : (componentNames[0] ? `"${componentNames[0]}"` : '')} to ${tokens.length} item${tokens.length === 1 ? '' : 's'}`.replace(/\s+/g, ' ')}
            </button>
          </div>

          {progress.total > 0 && (
            <div className={`jcomp-progress${running ? ' is-running' : ''}`}>
              <div className="jcomp-progress-track">
                <div className="jcomp-progress-fill" style={{ width: `${progress.pct}%` }} />
              </div>
              <span className="jcomp-progress-label">
                {progress.done + progress.failed} / {progress.total}
                {progress.failed > 0 && <span className="jcomp-progress-failed"> · {progress.failed} failed</span>}
              </span>
            </div>
          )}

          {error && <div className="jcomp-error">{error}</div>}
        </div>

        {/* ── Right: results ── */}
        <div className="jcomp-panel jcomp-results">
          {rows.length === 0 ? (
            <div className="jcomp-empty">Results will appear here after you apply.</div>
          ) : (
            <ul className="jcomp-rows">
              {rows.map((row, i) => (
                <li key={row.token} className={`jcomp-row jcomp-row-${row.state}`} style={{ '--i': i }}>
                  <div className="jcomp-row-head">
                    {stateDot(row.state)}
                    <span className="jcomp-row-token">{row.token}</span>
                    {row.jiraKey && row.jiraKey !== row.token && (
                      <span className="jcomp-arrow">→ {row.jiraKey}</span>
                    )}
                    {row.message && <span className="jcomp-row-msg">{row.message}</span>}
                  </div>
                  {row.targets.length > 0 && (
                    <ul className="jcomp-targets">
                      {row.targets.map((t, ti) => (
                        <li key={t.key} className="jcomp-target" style={{ '--i': ti }}>
                          {stateDot(t.state)}
                          <span className="jcomp-target-type">{t.type}</span>
                          <a
                            className="jcomp-target-key"
                            href={`https://dynamicalabs.atlassian.net/browse/${t.key}`}
                            target="_blank"
                            rel="noreferrer"
                          >{t.key}</a>
                          {t.error && <span className="jcomp-target-err">{t.error}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
