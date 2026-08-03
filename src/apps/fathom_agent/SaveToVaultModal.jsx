import { useEffect, useMemo, useState } from 'react';

// ─── Save Fathom calls into the PM Brain vault ─────────────────────────────────
// The primary way calls get archived: YOU pick one destination, the server writes
// a note per call (`POST /api/fathom/vault-save`) as commits to the vault's
// private git mirror, and obsidian-git pulls them into the local vault.
//
// Takes a LIST of calls — one row from the list, or a multi-selection. A batch
// shares the destination but keeps its own per-call frontmatter (`kind` is a fact
// about each call's attendees, not a choice), and is saved **sequentially**: each
// call means a transcript fetch, an LLM summary and two GitHub commits, and the
// shared ledger must not race itself. Progress is shown per call so a partial
// failure is visible instead of silently swallowing four of five.
//
// Everything offered here comes from the vault itself (`/api/pm-brain/:project`):
// the milestone list, and the `Calls/` subfolders each milestone actually uses —
// a real mix of Internal / External / Client / loose-in-Calls.

const VAULT_PROJECTS = [
  { id: 'ABS',         label: 'ABS' },
  { id: 'NSMG',        label: 'NSMG' },
  { id: 'NSMG_MARKER', label: 'MARKER' },
  { id: 'HT',          label: 'HYDROTEC' },
];

const OUR_DOMAIN = /dynamicalabs\.com/i;
const CUSTOM = '__custom__';
const ROOT = '';

const isInternal = call => {
  const people = [...(call.attendees ?? []), call.host ?? ''].filter(Boolean);
  return !people.length || people.every(p => OUR_DOMAIN.test(p));
};

const shortDate = d => (d ? String(d).slice(0, 10) : '');

export default function SaveToVaultModal({ calls, call, fathomToken, onClose, onSaved }) {
  // `call` (single) is still accepted so nothing else has to change.
  const batch = useMemo(() => (calls?.length ? calls : call ? [call] : []), [calls, call]);
  const many = batch.length > 1;
  const allInternal = batch.every(isInternal);
  const mixed = many && !allInternal && batch.some(isInternal);

  const [projectId, setProjectId] = useState('ABS');
  const [milestone, setMilestone] = useState('');
  const [folder,    setFolder]    = useState(() => (allInternal ? 'Internal' : 'External'));
  const [customFolder, setCustomFolder] = useState('');
  const [auto,      setAuto]      = useState(false);
  const [brain,     setBrain]     = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState('');
  const [status,    setStatus]    = useState(null);
  // id → { state: 'pending'|'saving'|'done'|'already'|'failed', path, why, error }
  const [rows,      setRows]      = useState({});
  const [finished,  setFinished]  = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/fathom/vault-status')
      .then(r => r.json())
      .then(d => !cancelled && setStatus(d))
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setBrain(null);
    setMilestone('');
    setError('');
    fetch(`/api/pm-brain/${projectId}`)
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.reason || d?.error || `PM Brain ${r.status}`);
        return d;
      })
      .then(d => { if (!cancelled) setBrain(d); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [projectId]);

  const milestones = useMemo(() => brain?.milestones ?? [], [brain]);
  const current = useMemo(
    () => milestones.find(m => m.name === milestone) ?? null,
    [milestones, milestone],
  );

  // Folders this milestone already uses, then the standard ones. Existing first,
  // so the habitual choice is on top.
  const folderOptions = useMemo(() => {
    const out = (current?.callFolders ?? []).map(f => ({ value: f, label: f || 'Calls/ (root)', existing: true }));
    for (const std of ['Internal', 'External']) {
      if (!out.some(o => o.value === std)) out.push({ value: std, label: std, existing: false });
    }
    if (!out.some(o => o.value === ROOT)) out.push({ value: ROOT, label: 'Calls/ (root)', existing: false });
    return out;
  }, [current]);

  useEffect(() => {
    if (folder === CUSTOM) return;
    if (!folderOptions.some(o => o.value === folder)) {
      const preferred = allInternal ? 'Internal' : 'External';
      setFolder(folderOptions.some(o => o.value === preferred) ? preferred : folderOptions[0]?.value ?? ROOT);
    }
  }, [folderOptions]);   // eslint-disable-line react-hooks/exhaustive-deps

  const chosenFolder = folder === CUSTOM ? customFolder.trim().replace(/^\/+|\/+$/g, '') : folder;

  const targetPath = useMemo(() => {
    if (auto) return 'chosen automatically — or Calls Inbox when unsure';
    const base = milestone
      ? `02_PROJECTS/${brain?.vaultProject ?? '…'}/Milestones/${milestone}`
      : `02_PROJECTS/${brain?.vaultProject ?? '…'}`;
    return `${base}/Calls${chosenFolder ? `/${chosenFolder}` : ''}/`;
  }, [auto, brain, milestone, chosenFolder]);

  async function saveOne(c) {
    const res = await fetch('/api/fathom/vault-save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The browser's token, so this works before (or without) the one-click
        // server-side connect; the server falls back to its stored token, which
        // is what the unattended sweep uses.
        fathomToken,
        recordingId: c.id,
        title:       c.title,
        date:        c.date,
        url:         c.url,
        attendees:   c.attendees ?? [],
        host:        c.host ?? '',
        // `kind` is the per-call Internal/External fact for the frontmatter;
        // `folder` is where the file physically goes ('' = loose in Calls/).
        kind: isInternal(c) ? 'Internal' : 'External',
        ...(auto ? {} : {
          project: brain?.vaultProject,
          milestone: milestone || null,
          folder: chosenFolder,
        }),
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `Save failed (${res.status})`);
    return data;
  }

  async function save() {
    setSaving(true);
    setError('');
    setRows(Object.fromEntries(batch.map(c => [c.id, { state: 'pending' }])));
    for (const c of batch) {
      setRows(prev => ({ ...prev, [c.id]: { state: 'saving' } }));
      try {
        const data = await saveOne(c);
        if (data.already) {
          setRows(prev => ({ ...prev, [c.id]: { state: 'already', path: data.entry?.path } }));
          onSaved?.({ ...data.entry, recordingId: c.id });
        } else {
          setRows(prev => ({ ...prev, [c.id]: { state: 'done', path: data.saved?.path, why: data.saved?.routed ? '' : (data.saved?.why || 'no confident match') } }));
          onSaved?.({ ...data.saved, recordingId: c.id });
        }
      } catch (e) {
        setRows(prev => ({ ...prev, [c.id]: { state: 'failed', error: e.message } }));
        // Keep going: one bad call must not block the rest of the batch.
      }
    }
    setSaving(false);
    setFinished(true);
  }

  const writable = status?.writable !== false;
  const canSave = writable && !saving && !finished
    && (auto || (!!brain && (folder !== CUSTOM || !!chosenFolder)));

  const done   = Object.values(rows).filter(r => r.state === 'done').length;
  const already = Object.values(rows).filter(r => r.state === 'already').length;
  const failed = Object.values(rows).filter(r => r.state === 'failed').length;

  const MARK = { pending: '·', saving: '…', done: '✓', already: '=', failed: '✕' };

  return (
    <div className="rel-modal-backdrop" onClick={saving ? undefined : onClose}>
      <div className="stv-modal" onClick={e => e.stopPropagation()}>
        <header className="stv-head">
          <h3>{many ? `Save ${batch.length} calls to PM Brain` : 'Save call to PM Brain'}</h3>
          <button type="button" className="azj-icon-btn" onClick={onClose} disabled={saving} title="Close">✕</button>
        </header>

        {finished ? (
          <div className="stv-done">
            <span className="stv-check">{failed ? '⚠' : '✓'}</span>
            <p className="stv-done-title">
              {failed
                ? `${done} saved, ${failed} failed`
                : many ? `${done} saved${already ? `, ${already} already there` : ''}` : (already ? 'Already in the vault' : 'Saved')}
            </p>
            <ul className="stv-rows">
              {batch.map(c => {
                const r = rows[c.id] ?? {};
                return (
                  <li key={c.id} className={`stv-row stv-row-${r.state ?? 'pending'}`}>
                    <span className="stv-row-mark">{MARK[r.state] ?? '·'}</span>
                    <span className="stv-row-title" title={c.title}>{c.title}</span>
                    <span className="stv-row-note" title={r.error || r.path || ''}>
                      {r.state === 'failed' ? r.error
                        : r.state === 'already' ? 'already archived'
                        : r.why ? `→ Calls Inbox (${r.why})`
                        : r.path ? r.path.replace(/^02_PROJECTS\//, '').replace(/\/[^/]+$/, '') : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="stv-hint">obsidian-git pulls the commits into your local vault within ~10 minutes.</p>
            <div className="stv-actions">
              <button type="button" className="btn btn-primary stv-btn" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="stv-body">
              {many ? (
                <div className="stv-batch">
                  <span className="stv-batch-head">{batch.length} calls selected</span>
                  <ul className="stv-rows">
                    {batch.map(c => {
                      const r = rows[c.id] ?? {};
                      return (
                        <li key={c.id} className={`stv-row stv-row-${r.state ?? 'idle'}`}>
                          <span className="stv-row-mark">{saving ? (MARK[r.state] ?? '·') : (isInternal(c) ? 'int' : 'ext')}</span>
                          <span className="stv-row-title" title={c.title}>{c.title}</span>
                          <span className="stv-row-note">{shortDate(c.date)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <p className="stv-call">
                  <b>{batch[0]?.title}</b>
                  <span>
                    {shortDate(batch[0]?.date)}
                    {batch[0]?.attendees?.length ? ` · ${batch[0].attendees.slice(0, 3).join(', ')}` : ''}
                    {` · ${allInternal ? 'internal' : 'external'}`}
                  </span>
                </p>
              )}

              {!writable && (
                <p className="stv-warn">
                  The server cannot write to the vault — <code>PM_BRAIN_GITHUB_TOKEN</code> is not set.
                </p>
              )}

              <div className="stv-grid">
                <label className="stv-field">
                  <span>Project</span>
                  <select className="select" value={projectId} disabled={saving || auto}
                    onChange={e => setProjectId(e.target.value)}>
                    {VAULT_PROJECTS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </label>

                <label className="stv-field">
                  <span>Milestone</span>
                  <select className="select" value={milestone} disabled={saving || loading || auto}
                    onChange={e => setMilestone(e.target.value)}>
                    <option value="">
                      {loading ? 'Loading…' : milestones.length ? '— project level —' : 'no milestones'}
                    </option>
                    {milestones.map(m => (
                      <option key={m.name} value={m.name}>
                        {m.name}{m.status === 'on-hold' ? ' (on hold)' : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="stv-field">
                  <span>Folder{many ? ' (for all selected)' : ''}</span>
                  <select className="select" value={folder} disabled={saving || auto}
                    onChange={e => setFolder(e.target.value)}>
                    {folderOptions.map(o => (
                      <option key={o.value || 'root'} value={o.value}>
                        {o.label}{o.existing ? ' ·' : ' (new)'}
                      </option>
                    ))}
                    <option value={CUSTOM}>Custom…</option>
                  </select>
                </label>

                {folder === CUSTOM && (
                  <label className="stv-field">
                    <span>Custom subfolder</span>
                    <input className="input" placeholder="e.g. Client" value={customFolder}
                      disabled={saving} onChange={e => setCustomFolder(e.target.value)} />
                  </label>
                )}
              </div>

              <p className="stv-target">→ {targetPath}</p>

              {mixed && !auto && (
                <p className="stv-hint">
                  The selection mixes internal and external calls — they all go into this one
                  folder; each note still records its own <code>kind</code>.
                </p>
              )}

              <label className="stv-check-row">
                <input type="checkbox" checked={auto} disabled={saving}
                  onChange={e => setAuto(e.target.checked)} />
                Let the classifier pick the milestone{many ? ' per call' : ' instead'}
              </label>

              {error && <p className="stv-err">⚠ {error}</p>}
            </div>

            <div className="stv-actions">
              {saving && <span className="stv-progress">saving {Object.values(rows).filter(r => r.state !== 'pending').length} / {batch.length}…</span>}
              <button type="button" className="btn btn-ghost stv-btn" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="button" className="btn btn-primary stv-btn" onClick={save} disabled={!canSave}>
                {saving ? <span className="spinner" /> : many ? `Save ${batch.length} calls` : 'Save to vault'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
