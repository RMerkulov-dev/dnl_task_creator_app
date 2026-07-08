// Documentation AI (Beta) — platform port of the standalone document_agent_app
// frontend. Upload a screen recording → the backend extracts key frames,
// analyses them with a multimodal LLM via OpenRouter and assembles a PDF guide.
import { useCallback, useEffect, useRef, useState } from 'react';

const API = '/api/doc-agent';

async function apiJson(path, init) {
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) {
    let msg = `${r.status}`;
    try { msg = `${r.status}: ${(await r.json()).error}`; } catch { /* keep code */ }
    throw new Error(msg);
  }
  return r.json();
}

const ACCEPTED = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'];

function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const STATUS_LABELS = {
  queued: 'Queued', extracting: 'Extracting frames', analyzing: 'Analyzing',
  building_pdf: 'Building PDF', done: 'Done', failed: 'Failed',
};

// ─── Frame images (auth lives in the fetch patch, so <img src> can't be used
// directly — fetch as blob and cache object URLs per job/frame) ───────────────

const frameUrlCache = new Map(); // `${jobId}/${idx}` -> objectURL promise

function clearFrameCache() {
  for (const p of frameUrlCache.values()) {
    Promise.resolve(p).then(u => { if (u) URL.revokeObjectURL(u); }).catch(() => {});
  }
  frameUrlCache.clear();
}

function fetchFrameUrl(jobId, idx) {
  const key = `${jobId}/${idx}`;
  if (!frameUrlCache.has(key)) {
    frameUrlCache.set(key, fetch(`${API}/frames/${jobId}/${idx}`)
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(b => URL.createObjectURL(b))
      .catch(() => { frameUrlCache.delete(key); return null; }));
  }
  return frameUrlCache.get(key);
}

function FrameImg({ jobId, idx, className, alt }) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchFrameUrl(jobId, idx).then(u => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [jobId, idx]);
  if (!url) return <div className={`${className || ''} docai-frame-loading`}><span className="spinner" /></div>;
  return <img src={url} alt={alt} className={className} loading="lazy" />;
}

// ─── Small bits ───────────────────────────────────────────────────────────────

function Badge({ tone = 'neutral', children }) {
  return <span className={`docai-badge docai-badge-${tone}`}>{children}</span>;
}

function HealthBadges({ health, loading }) {
  if (loading) return <Badge tone="neutral">checking…</Badge>;
  if (!health) return <Badge tone="danger">backend offline</Badge>;
  return (
    <div className="docai-health">
      <Badge tone={health.ffmpeg ? 'success' : 'danger'}>{health.ffmpeg ? '✓' : '✕'} ffmpeg</Badge>
      <Badge tone={health.openrouter_key ? 'success' : 'danger'}>{health.openrouter_key ? '✓' : '✕'} API key</Badge>
      <Badge tone={health.smart_extraction ? 'accent' : 'neutral'}>✦ smart {health.smart_extraction ? 'on' : 'off'}</Badge>
    </div>
  );
}

function Slider({ label, value, valueLabel, min, max, step, hint, disabled, onChange }) {
  return (
    <div className="docai-field">
      <label className="docai-label">
        <span>{label}</span>
        <span className="docai-label-value">{valueLabel}</span>
      </label>
      <input
        type="range" min={min} max={max} step={step} value={value}
        disabled={disabled} onChange={onChange} className="docai-range"
      />
      {hint && <p className="docai-hint">{hint}</p>}
    </div>
  );
}

// ─── Upload dropzone ──────────────────────────────────────────────────────────

function DropZone({ file, onFile, disabled, maxVideoMb }) {
  const inputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback((files) => {
    if (!files || !files[0]) return;
    const f = files[0];
    const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
    if (!ACCEPTED.includes(ext)) {
      alert(`Unsupported format ${ext}. Allowed: ${ACCEPTED.join(', ')}`);
      return;
    }
    onFile(f);
  }, [onFile]);

  if (file) {
    return (
      <div className="docai-file-chip">
        <div className="docai-file-icon">🎬</div>
        <div className="docai-file-meta">
          <p className="docai-file-name">{file.name}</p>
          <p className="docai-hint">{formatBytes(file.size)}</p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => onFile(null)} disabled={disabled} aria-label="Remove file">✕</button>
      </div>
    );
  }

  return (
    <label
      className={`docai-dropzone${dragOver ? ' drag-over' : ''}${disabled ? ' disabled' : ''}`}
      onDragEnter={e => { e.preventDefault(); if (!disabled) setDragOver(true); }}
      onDragOver={e => e.preventDefault()}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        if (!disabled) handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef} type="file" accept={ACCEPTED.join(',')} disabled={disabled}
        style={{ display: 'none' }}
        onChange={e => handleFiles(e.target.files)}
      />
      <div className="docai-dropzone-icon">⇪</div>
      <p className="docai-dropzone-title">Drop a video here, or click to choose a file</p>
      <p className="docai-hint">{ACCEPTED.join(' · ')} · up to {maxVideoMb || 300} MB</p>
    </label>
  );
}

// ─── Prompt editor ────────────────────────────────────────────────────────────

function PromptEditor({ value, defaultValue, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const isModified = value.trim() !== defaultValue.trim();
  return (
    <div className="docai-prompt-editor">
      <button type="button" className="docai-prompt-toggle" onClick={() => setOpen(v => !v)}>
        <span className={`docai-chevron${open ? ' open' : ''}`}>▾</span>
        <span className="docai-prompt-toggle-text">
          <span className="docai-prompt-title">Master prompt</span>
          <span className="docai-hint">{isModified ? 'Modified — your version will be sent' : 'Using the preset prompt'}</span>
        </span>
        {isModified && <span className="docai-pill">modified</span>}
      </button>
      {open && (
        <div className="docai-prompt-body">
          <textarea
            className="input docai-prompt-textarea"
            value={value} rows={14} spellCheck={false} disabled={disabled}
            onChange={e => onChange(e.target.value)}
          />
          <div className="docai-prompt-footer">
            <span className="docai-hint">{value.length.toLocaleString('en-US')} characters</span>
            {isModified && (
              <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onChange(defaultValue)}>
                ↺ Reset
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analysis options form ────────────────────────────────────────────────────

function AnalysisOptions({ options, state, setState, disabled, showMaxFrames = true }) {
  const presetObj = options.presets.find(p => p.key === state.preset);

  useEffect(() => {
    if (!state.promptIsCustom && presetObj && state.customPrompt !== presetObj.prompt) {
      setState({ ...state, customPrompt: presetObj.prompt });
    }
  }, [presetObj, state, setState]);

  return (
    <div className="docai-options">
      <div className="docai-grid-2">
        <div className="docai-field">
          <label className="docai-label"><span>Model</span></label>
          <select
            className="select" value={state.model} disabled={disabled}
            onChange={e => setState({ ...state, model: e.target.value })}
          >
            {options.models.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}
          </select>
          <p className="docai-hint">{options.models.find(m => m.key === state.model)?.description}</p>
        </div>
        <div className="docai-field">
          <label className="docai-label"><span>Document type</span></label>
          <select
            className="select" value={state.preset} disabled={disabled}
            onChange={e => setState({ ...state, preset: e.target.value, promptIsCustom: false })}
          >
            {options.presets.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
          </select>
          <p className="docai-hint">{presetObj?.description}</p>
        </div>
      </div>

      <div className={showMaxFrames ? 'docai-grid-2' : ''}>
        {showMaxFrames && (
          <Slider
            label="Frame count" value={state.maxFrames} valueLabel={`${state.maxFrames}`}
            min={5} max={options.max_frames_hard_limit} step={1} disabled={disabled}
            hint="More frames = more detail, but slower and pricier"
            onChange={e => setState({ ...state, maxFrames: Number(e.target.value) })}
          />
        )}
        <Slider
          label="Document length" value={state.targetPages}
          valueLabel={`${state.targetPages} page${state.targetPages === 1 ? '' : 's'}`}
          min={1} max={10} step={1} disabled={disabled}
          hint="The model will try to match this length"
          onChange={e => setState({ ...state, targetPages: Number(e.target.value) })}
        />
      </div>

      <PromptEditor
        value={state.customPrompt}
        defaultValue={presetObj?.prompt ?? ''}
        disabled={disabled}
        onChange={v => setState({
          ...state,
          customPrompt: v,
          promptIsCustom: v.trim() !== (presetObj?.prompt ?? '').trim(),
        })}
      />

      <div className="docai-field">
        <label className="docai-label">
          <span>Additional instructions</span>
          {state.customInstructions.trim() && <span className="docai-pill">active</span>}
        </label>
        <textarea
          className="input docai-textarea" rows={4} spellCheck disabled={disabled}
          value={state.customInstructions}
          placeholder="e.g. Focus on the vendor-selection workflow. Skip the navigation steps. Add a Tip after each section explaining why."
          onChange={e => setState({ ...state, customInstructions: e.target.value })}
        />
        <p className="docai-hint">
          Appended to the master prompt as extra guidance. Use this to tweak style, focus, or output without rewriting the whole prompt.
        </p>
      </div>
    </div>
  );
}

// ─── Frame grid + lightbox ────────────────────────────────────────────────────

function FrameGrid({ jobId, indexes, pendingPlaceholder, onDelete, deletingIdx }) {
  const [viewerIdx, setViewerIdx] = useState(null);

  const close = useCallback(() => setViewerIdx(null), []);
  const step = useCallback((dir) => {
    setViewerIdx(cur => {
      if (cur === null) return cur;
      const pos = indexes.indexOf(cur);
      if (pos === -1) return cur;
      return indexes[(pos + dir + indexes.length) % indexes.length];
    });
  }, [indexes]);

  useEffect(() => {
    if (viewerIdx === null) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerIdx, close, step]);

  // If the viewed frame was deleted, jump to the nearest neighbour or close.
  useEffect(() => {
    if (viewerIdx === null || indexes.includes(viewerIdx)) return;
    if (!indexes.length) { close(); return; }
    const nearest = indexes.reduce((best, n) =>
      Math.abs(n - viewerIdx) < Math.abs(best - viewerIdx) ? n : best, indexes[0]);
    setViewerIdx(nearest);
  }, [indexes, viewerIdx, close]);

  return (
    <>
      <div className="docai-frame-grid">
        {indexes.map(idx => (
          <button key={idx} type="button" className="docai-frame-cell" onClick={() => setViewerIdx(idx)}>
            <FrameImg jobId={jobId} idx={idx} className="docai-frame-img" alt={`Frame ${idx}`} />
            <span className="docai-frame-num">#{idx}</span>
            {onDelete && (
              <span
                role="button"
                aria-label={`Delete frame ${idx}`}
                className={`docai-frame-delete${deletingIdx === idx ? ' busy' : ''}`}
                onClick={e => {
                  e.stopPropagation();
                  if (deletingIdx !== idx) onDelete(idx);
                }}
              >
                {deletingIdx === idx ? '…' : '🗑'}
              </span>
            )}
          </button>
        ))}
        {pendingPlaceholder && (
          <div className="docai-frame-cell docai-frame-pending"><span className="spinner" /></div>
        )}
      </div>

      {viewerIdx !== null && (
        <div className="docai-lightbox" role="dialog" aria-modal="true" onClick={close}>
          <div className="docai-lightbox-inner" onClick={e => e.stopPropagation()}>
            <div className="docai-lightbox-bar">
              <span className="docai-lightbox-counter">
                Frame #{viewerIdx} <span style={{ opacity: .5 }}>· {indexes.indexOf(viewerIdx) + 1} of {indexes.length}</span>
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {onDelete && (
                  <button
                    type="button" className="btn btn-danger" disabled={deletingIdx === viewerIdx}
                    onClick={() => onDelete(viewerIdx)}
                  >
                    {deletingIdx === viewerIdx ? 'Deleting…' : 'Delete'}
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={close}>✕ Close</button>
              </div>
            </div>
            <div className="docai-lightbox-stage">
              <button type="button" className="docai-lightbox-nav" aria-label="Previous" onClick={() => step(-1)}>‹</button>
              <FrameImg jobId={jobId} idx={viewerIdx} className="docai-lightbox-img" alt={`Frame ${viewerIdx}`} />
              <button type="button" className="docai-lightbox-nav" aria-label="Next" onClick={() => step(1)}>›</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ─── Settings dialog (brand fields; the OpenRouter key is platform-wide) ──────

function SettingsDialog({ open, onClose }) {
  const [settings, setSettings] = useState(null);
  const [brandName, setBrandName] = useState('');
  const [brandTagline, setBrandTagline] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    apiJson('/settings')
      .then(s => {
        setSettings(s);
        setBrandName(s.brand_name || '');
        setBrandTagline(s.brand_tagline || '');
      })
      .catch(e => setError(e.message));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await apiJson('/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brand_name: brandName, brand_tagline: brandTagline }),
      });
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="docai-lightbox" onClick={onClose}>
      <div className="docai-modal" onClick={e => e.stopPropagation()}>
        <div className="docai-modal-head">
          <h2>Settings</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>✕</button>
        </div>
        <div className="docai-field">
          <label className="docai-label">
            <span>OpenRouter API key</span>
            {settings && (
              <span className={settings.openrouter_key_set ? 'docai-ok' : 'docai-warn'}>
                {settings.openrouter_key_set ? '✓ configured' : '✕ not set'}
              </span>
            )}
          </label>
          <p className="docai-hint">
            Shared platform credential (OPENROUTER_API_KEY in the server .env). Used for Claude analysis and Gemini smart extraction.
          </p>
        </div>
        <div className="docai-field">
          <label className="docai-label"><span>Brand name (PDF footer)</span></label>
          <input className="input" value={brandName} onChange={e => setBrandName(e.target.value)} placeholder="e.g. Dynamica Labs" />
        </div>
        <div className="docai-field">
          <label className="docai-label"><span>Brand tagline</span></label>
          <input className="input" value={brandTagline} onChange={e => setBrandTagline(e.target.value)} placeholder="End-user guide" />
        </div>
        {error && <p className="docai-error">{error}</p>}
        <div className="docai-modal-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Progress / result panel ──────────────────────────────────────────────────

function statusTone(s) {
  if (s === 'done') return 'success';
  if (s === 'failed') return 'danger';
  return 'accent';
}

function ProgressPanel({ jobId, status, options, form, setForm, onReset }) {
  const isActive = status.status !== 'done' && status.status !== 'failed';
  const isDone = status.status === 'done';
  const allowEdit = !isActive;

  const [indexes, setIndexes] = useState([]);
  const [deletingIdx, setDeletingIdx] = useState(null);
  const [deleteError, setDeleteError] = useState('');
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenError, setRegenError] = useState('');
  const [downloading, setDownloading] = useState(false);

  const refreshFrames = useCallback(async () => {
    try {
      const data = await apiJson(`/frames/${jobId}`);
      setIndexes(data.indexes);
    } catch { /* transient */ }
  }, [jobId]);

  useEffect(() => {
    if (status.frame_count > 0) refreshFrames();
  }, [jobId, status.frame_count, status.status, refreshFrames]);

  const deleteFrame = async (idx) => {
    setDeleteError('');
    setDeletingIdx(idx);
    try {
      await apiJson(`/frames/${jobId}/${idx}`, { method: 'DELETE' });
      await refreshFrames();
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeletingIdx(null);
    }
  };

  const regenerate = async () => {
    setRegenBusy(true);
    setRegenError('');
    try {
      await apiJson(`/jobs/${jobId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: form.model,
          preset: form.promptIsCustom ? undefined : form.preset,
          custom_prompt: form.promptIsCustom ? form.customPrompt : undefined,
          custom_instructions: form.customInstructions || undefined,
          target_pages: form.targetPages,
        }),
      });
    } catch (e) {
      setRegenError(e.message);
    } finally {
      setRegenBusy(false);
    }
  };

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const r = await fetch(`${API}/result/${jobId}`);
      if (!r.ok) throw new Error(`${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `document-agent-${jobId.slice(0, 8)}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      alert(`PDF download failed: ${e.message}`);
    } finally {
      setDownloading(false);
    }
  };

  const openJson = async () => {
    try {
      const data = await apiJson(`/result/${jobId}/json`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) {
      alert(`JSON not ready: ${e.message}`);
    }
  };

  const modelName = options.models.find(m => m.key === status.model)?.name ?? status.model;
  const canRegenerate = indexes.length > 0 && allowEdit && !regenBusy;

  return (
    <section className="docai-card">
      <div className="docai-card-head">
        <span className="docai-step">3</span>
        <h2>Analysis</h2>
        <Badge tone={statusTone(status.status)}>
          {isActive && <span className="spinner docai-spinner-sm" />}
          {STATUS_LABELS[status.status] || status.status}
        </Badge>
      </div>

      <div className="docai-progress-meta">
        <span className="docai-hint">Model: <strong style={{ color: 'var(--text-1)' }}>{modelName}</strong></span>
        <span className="docai-hint">{status.progress}%</span>
      </div>
      <div className="docai-progress-track">
        <div className="docai-progress-fill" style={{ width: `${status.progress}%` }} />
      </div>
      {status.frame_count > 0 && (
        <p className="docai-hint" style={{ marginTop: 8 }}>
          Frames extracted: <strong style={{ color: 'var(--text-1)' }}>{status.frame_count}</strong>
        </p>
      )}
      {status.error && <div className="docai-error-box">{status.error}</div>}

      {isDone && (
        <div className="docai-result-row">
          <button type="button" className="btn btn-primary" onClick={downloadPdf} disabled={downloading}>
            {downloading ? 'Downloading…' : '⬇ Download PDF'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={openJson}>{'{ }'} Open JSON</button>
          <button type="button" className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={onReset}>New analysis</button>
        </div>
      )}

      {status.frame_count > 0 && (
        <div className="docai-frames-block">
          <p className="docai-section-label">Frames {indexes.length > 0 && <span>({indexes.length})</span>}</p>
          <FrameGrid
            jobId={jobId}
            indexes={indexes}
            pendingPlaceholder={isActive}
            onDelete={allowEdit ? deleteFrame : undefined}
            deletingIdx={deletingIdx}
          />
          {deleteError && <p className="docai-error">{deleteError}</p>}
          <p className="docai-hint" style={{ marginTop: 8 }}>
            {allowEdit
              ? 'Hover a frame to delete, or click to enlarge (←/→ to navigate).'
              : 'Click any frame to enlarge — delete becomes available once the run finishes.'}
          </p>
        </div>
      )}

      {allowEdit && (
        <div className="docai-refine">
          <p className="docai-section-label">Refine &amp; regenerate</p>
          <AnalysisOptions
            options={options} state={form} setState={setForm}
            disabled={regenBusy} showMaxFrames={false}
          />
          <div className="docai-actions">
            {regenError && <p className="docai-error">{regenError}</p>}
            <button type="button" className="btn btn-primary" disabled={!canRegenerate} onClick={regenerate}>
              {regenBusy ? 'Starting…' : '↻ Regenerate'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function DocumentAiApp() {
  const [health, setHealth] = useState(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [options, setOptions] = useState(null);
  const [optionsError, setOptionsError] = useState('');
  const [file, setFile] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [form, setForm] = useState(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    apiJson('/health').then(setHealth).catch(() => setHealth(null)).finally(() => setHealthLoading(false));
    apiJson('/options')
      .then(opts => {
        setOptions(opts);
        const preset = opts.presets.find(p => p.key === opts.default_preset) ?? opts.presets[0];
        setForm({
          model: opts.models[0]?.key ?? 'sonnet',
          preset: opts.default_preset,
          customPrompt: preset?.prompt ?? '',
          promptIsCustom: false,
          customInstructions: '',
          maxFrames: 30,
          targetPages: opts.default_target_pages || 3,
        });
      })
      .catch(e => setOptionsError(e.message));
    return clearFrameCache;
  }, []);

  // Poll job status while a job is running.
  useEffect(() => {
    if (!jobId) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const s = await apiJson(`/status/${jobId}`);
        if (!stop) setJobStatus(s);
      } catch { /* transient */ }
    };
    tick();
    const t = setInterval(() => {
      // Keep polling even when done==true only if a regenerate restarted the job.
      tick();
    }, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [jobId]);

  const isRunning = starting
    || (jobStatus && jobStatus.status !== 'done' && jobStatus.status !== 'failed');

  const startAnalysis = async () => {
    if (!file || !form) return;
    setStarting(true);
    setStartError('');
    try {
      const fd = new FormData();
      fd.append('video', file);
      fd.append('model', form.model);
      if (!form.promptIsCustom && form.preset) fd.append('preset', form.preset);
      if (form.promptIsCustom && form.customPrompt.trim()) fd.append('custom_prompt', form.customPrompt);
      if (form.customInstructions.trim()) fd.append('custom_instructions', form.customInstructions);
      fd.append('max_frames', String(form.maxFrames));
      fd.append('target_pages', String(form.targetPages));
      const data = await apiJson('/analyze', { method: 'POST', body: fd });
      clearFrameCache();
      setJobStatus(null);
      setJobId(data.job_id);
    } catch (e) {
      setStartError(e.message);
    } finally {
      setStarting(false);
    }
  };

  const reset = () => {
    setFile(null);
    setJobId(null);
    setJobStatus(null);
    setStartError('');
    clearFrameCache();
  };

  const canStart = !!file && !!form && !isRunning;

  return (
    <div className="docai-wrap">
      <header className="docai-header">
        <div className="docai-header-left">
          <div className="docai-logo">📄</div>
          <div>
            <h1 className="docai-title">Documentation AI <span className="docai-beta-inline">Beta</span></h1>
            <p className="docai-hint">Video → step-by-step PDF documentation</p>
          </div>
        </div>
        <div className="docai-header-right">
          <HealthBadges health={health} loading={healthLoading} />
          <button type="button" className="btn btn-ghost" title="Settings" onClick={() => setSettingsOpen(true)}>⚙</button>
        </div>
      </header>

      <section className="docai-card">
        <div className="docai-card-head">
          <span className="docai-step">1</span>
          <h2>Upload video</h2>
        </div>
        <DropZone file={file} onFile={setFile} disabled={!!isRunning} maxVideoMb={options?.max_video_mb} />
      </section>

      <section className="docai-card">
        <div className="docai-card-head">
          <span className="docai-step">2</span>
          <h2>Analysis options</h2>
        </div>
        {form && options ? (
          <AnalysisOptions options={options} state={form} setState={setForm} disabled={!!isRunning} />
        ) : (
          <p className="docai-hint">{optionsError ? `Failed to load options — ${optionsError}` : 'Loading…'}</p>
        )}
      </section>

      <div className="docai-actions">
        {startError && <p className="docai-error">{startError}</p>}
        <button type="button" className="btn btn-primary docai-start-btn" disabled={!canStart} onClick={startAnalysis}>
          {starting ? 'Starting…' : '▶ Start analysis'}
        </button>
      </div>

      {jobId && jobStatus && form && options && (
        <ProgressPanel
          jobId={jobId} status={jobStatus} options={options}
          form={form} setForm={setForm} onReset={reset}
        />
      )}

      <footer className="docai-footer docai-hint">
        Frames are extracted locally via ffmpeg and sent to OpenRouter (Claude Sonnet/Opus). The result is assembled into a PDF.
      </footer>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
