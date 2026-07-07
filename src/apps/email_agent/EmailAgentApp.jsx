import { useState, useRef, useEffect, useCallback } from 'react';
import { SKILLS, DEFAULT_SKILL_ID, getSkillById } from './skills.js';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

// Per-skill instruction overrides and the active skill survive reloads.
const OVERRIDES_KEY     = 'email-agent.skill-overrides.v1';
const ACTIVE_SKILL_KEY  = 'email-agent.active-skill.v1';
// Pre-skills versions kept a single custom instruction here — migrate it into
// an override of the default skill so nobody loses their tuned prompt.
const LEGACY_KEY        = 'email-agent.instruction.v3';

function loadOverrides() {
  try {
    const stored = JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}');
    if (typeof stored === 'object' && stored !== null) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy && !stored[DEFAULT_SKILL_ID] && legacy.trim() && legacy !== getSkillById(DEFAULT_SKILL_ID).instruction) {
        stored[DEFAULT_SKILL_ID] = legacy;
      }
      return stored;
    }
  } catch { /* corrupted storage — start clean */ }
  return {};
}

function getBestMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="2" width="6" height="11" rx="3" fill="currentColor"/>
      <path d="M5 11a7 7 0 0014 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M12 18v4M9 22h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M22 2L11 13M22 2L15 22L11 13M22 2L2 9L11 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── Markdown-ish rendering ───────────────────────────────────────────────────

function formatInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="ba-inline-code">$1</code>');
}

const EMAIL_TEXT_STYLE = { fontFamily: 'Arial, sans-serif', fontSize: 12, lineHeight: 1.5 };

function AssistantText({ text }) {
  const lines = text.split('\n').filter(l => !/^\s*---+\s*$/.test(l));
  return (
    <div className="ba-msg-text" style={EMAIL_TEXT_STYLE}>
      {lines.map((line, i) => {
        if (!line.trim()) return <br key={i} />;

        const bulletMatch = line.match(/^[\s]*[-•*]\s+(.*)/);
        if (bulletMatch) return (
          <div key={i} className="ba-list-item">
            <span className="ba-bullet">·</span>
            <span dangerouslySetInnerHTML={{ __html: formatInline(bulletMatch[1]) }} />
          </div>
        );

        const numMatch = line.match(/^[\s]*(\d+)\.\s+(.*)/);
        if (numMatch) return (
          <div key={i} className="ba-list-item">
            <span className="ba-bullet">{numMatch[1]}.</span>
            <span dangerouslySetInnerHTML={{ __html: formatInline(numMatch[2]) }} />
          </div>
        );

        return <p key={i} dangerouslySetInnerHTML={{ __html: formatInline(line) }} />;
      })}
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }
  return (
    <button className="ba-issues-copy-btn" onClick={copy} title="Copy refined message">
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

// ─── Skill editor (accordion under the skills bar) ────────────────────────────

function SkillEditor({ skill, override, onSave, onReset, onClose }) {
  const [draft, setDraft] = useState(override ?? skill.instruction);

  useEffect(() => { setDraft(override ?? skill.instruction); }, [skill.id, override]); // eslint-disable-line

  return (
    <div className="ea-skill-editor">
      <p className="ea-skill-editor-hint">{skill.hint}</p>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder="Instructions for how the agent should refine your messages…"
      />
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          className="btn btn-primary"
          style={{ width: 'auto', padding: '8px 18px', fontSize: 12 }}
          onClick={() => { onSave(draft); onClose(); }}
        >
          Save
        </button>
        <button
          className="btn btn-ghost"
          style={{ padding: '8px 16px', fontSize: 13 }}
          onClick={() => { setDraft(skill.instruction); onReset(); }}
        >
          Reset to default
        </button>
        <button
          className="btn btn-ghost"
          style={{ padding: '8px 16px', fontSize: 13, marginLeft: 'auto' }}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Result card with feedback ────────────────────────────────────────────────

function ResultCard({ result, onFeedback }) {
  const voted = result.feedback != null;
  return (
    <div className="ea-result">
      <div className="ea-result-meta">
        <span>{result.skillName}</span>
        <span>·</span>
        <span>{result.time}</span>
      </div>
      {result.error
        ? <p className="ba-msg-text" style={{ color: '#ef4444' }}>⚠ {result.error}</p>
        : <AssistantText text={result.output} />}
      {!result.error && (
        <div className="ea-result-actions">
          <CopyButton text={result.output} />
          <span style={{ flex: 1 }} />
          <button
            className={`ea-fb-btn ${result.feedback === 'up' ? 'selected-up' : ''}`}
            disabled={voted}
            title="Good result"
            onClick={() => onFeedback(result.id, 'up')}
          >👍</button>
          <button
            className={`ea-fb-btn ${result.feedback === 'down' ? 'selected-down' : ''}`}
            disabled={voted}
            title="Bad result"
            onClick={() => onFeedback(result.id, 'down')}
          >👎</button>
          {voted && <span style={{ fontSize: 11, color: 'var(--text-3)' }}>Thanks!</span>}
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EmailAgentApp({ user, onLogout }) {
  const [overrides, setOverridesState] = useState(loadOverrides);
  const [activeSkillId, setActiveSkillIdState] = useState(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_SKILL_KEY);
      return SKILLS.some(s => s.id === saved) ? saved : DEFAULT_SKILL_ID;
    } catch { return DEFAULT_SKILL_ID; }
  });
  const [openSkillId,  setOpenSkillId]  = useState(null);
  const [input,        setInput]        = useState('');
  const [results,      setResults]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error,        setError]        = useState('');

  const mrRef       = useRef(null);
  const chunksRef   = useRef([]);
  const audioCtxRef = useRef(null);
  const resultIdRef = useRef(1);

  const activeSkill = getSkillById(activeSkillId);
  const effectiveInstruction = overrides[activeSkillId] ?? activeSkill.instruction;

  function setOverrides(next) {
    setOverridesState(next);
    try { localStorage.setItem(OVERRIDES_KEY, JSON.stringify(next)); } catch { /* noop */ }
  }

  function setActiveSkillId(id) {
    setActiveSkillIdState(id);
    try { localStorage.setItem(ACTIVE_SKILL_KEY, id); } catch { /* noop */ }
  }

  function handleSkillClick(id) {
    setActiveSkillId(id);
    // Name is always visible; the content shows only on click (accordion).
    setOpenSkillId(prev => (prev === id ? null : id));
  }

  function saveSkillOverride(id, text) {
    const builtin = getSkillById(id).instruction;
    const next = { ...overrides };
    if (!text.trim() || text === builtin) delete next[id];
    else next[id] = text;
    setOverrides(next);
  }

  function resetSkill(id) {
    const next = { ...overrides };
    delete next[id];
    setOverrides(next);
  }

  // ─── Refine ───────────────────────────────────────────────────────────────

  const send = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setError('');
    setLoading(true);
    const meta = {
      skillId:    activeSkillId,
      skillName:  activeSkill.name,
      customized: activeSkillId in overrides,
    };
    try {
      const res  = await fetch('/api/email-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, instruction: effectiveInstruction, userEmail: user }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setResults(prev => [{
        id:       resultIdRef.current++,
        input:    trimmed,
        output:   data.reply,
        error:    null,
        feedback: null,
        time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ...meta,
      }, ...prev]);
    } catch (err) {
      setResults(prev => [{
        id:       resultIdRef.current++,
        input:    trimmed,
        output:   '',
        error:    err.message,
        feedback: null,
        time:     new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ...meta,
      }, ...prev]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, effectiveInstruction, activeSkillId, activeSkill.name, overrides, user]);

  // ─── Feedback ─────────────────────────────────────────────────────────────

  function sendFeedback(resultId, rating) {
    const result = results.find(r => r.id === resultId);
    if (!result || result.feedback) return;
    setResults(prev => prev.map(r => r.id === resultId ? { ...r, feedback: rating } : r));
    // Fire-and-forget: the vote must never block the UI.
    fetch('/api/email-agent/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rating,
        input:      result.input,
        output:     result.output,
        skillId:    result.skillId,
        skillName:  result.skillName,
        customized: result.customized,
        userEmail:  user,
      }),
    }).catch(() => { /* noop */ });
  }

  // ─── Voice recording ──────────────────────────────────────────────────────

  function stopVisualizer() {
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
  }

  async function startRecording() {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
      });
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;

      const mimeType = getBestMimeType();
      const mr = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128_000 } : {});
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const type = mr.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        await transcribeBlob(blob, type);
      };
      mrRef.current = mr;
      mr.start();
      setRecording(true);
    } catch {
      setError('Нет доступа к микрофону.');
    }
  }

  function stopRecording() {
    if (mrRef.current?.state === 'recording') mrRef.current.stop();
    stopVisualizer();
    setRecording(false);
    setTranscribing(true);
  }

  async function transcribeBlob(blob, mimeType) {
    try {
      const res  = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': mimeType }, body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка расшифровки');
      const text = (data.text || '').trim();
      if (text) setInput(prev => prev ? `${prev} ${text}` : text);
      else setError('Не удалось распознать речь.');
    } catch (e) {
      setError(e.message);
    } finally {
      setTranscribing(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const canSend  = input.trim().length > 0 && !loading;
  const micBusy  = recording || transcribing;

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-logo"><img src={LOGO} alt="Dynamica Labs" /></div>
        <div className="header-sep" />
        <span className="header-title">Email Agent</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className="ea-main">
        {/* Skills bar: names always visible, content opens on click */}
        <div className="ea-skills">
          {SKILLS.map(s => (
            <button
              key={s.id}
              className={`ea-skill-pill ${s.id === activeSkillId ? 'active' : ''}`}
              onClick={() => handleSkillClick(s.id)}
              title={s.hint}
            >
              {s.name}
              {s.id in overrides && <span className="ea-custom-dot" title="Customized" />}
            </button>
          ))}
        </div>

        {openSkillId && (
          <SkillEditor
            skill={getSkillById(openSkillId)}
            override={overrides[openSkillId] ?? null}
            onSave={text => saveSkillOverride(openSkillId, text)}
            onReset={() => resetSkill(openSkillId)}
            onClose={() => setOpenSkillId(null)}
          />
        )}

        <div className="ea-split">
          {/* Left: draft input */}
          <div className="ea-pane">
            <div className="ea-pane-head">Draft</div>
            <textarea
              className="ea-draft"
              placeholder="Paste or dictate your draft here… (Cmd/Ctrl+Enter to refine)"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
              }}
              disabled={micBusy}
            />
            <div className="ea-controls">
              <button
                className={`ba-mic-btn${recording ? ' ba-mic-btn-stop' : ''}${transcribing ? ' ba-mic-btn-busy' : ''}`}
                onClick={recording ? stopRecording : startRecording}
                disabled={loading || transcribing}
                title={recording ? 'Остановить запись' : 'Голосовой ввод'}
              >
                {transcribing
                  ? <span className="spinner" style={{ width: 16, height: 16 }} />
                  : recording ? <StopIcon /> : <MicIcon />}
              </button>
              {error && <p className="ba-input-error" style={{ margin: 0 }}>⚠ {error}</p>}
              <span style={{ flex: 1 }} />
              <button
                className="btn btn-primary"
                style={{ width: 'auto', gap: 8, padding: '8px 18px', fontSize: 12 }}
                onClick={send}
                disabled={!canSend}
                title="Refine with the selected skill"
              >
                {loading
                  ? <span className="spinner" style={{ width: 16, height: 16 }} />
                  : <><SendIcon /> <span>Refine</span></>}
              </button>
            </div>
          </div>

          {/* Right: refined output */}
          <div className="ea-pane">
            <div className="ea-pane-head">Output — {activeSkill.name}</div>
            <div className="ea-output">
              {results.length === 0 && !loading && (
                <div className="ea-empty-out">
                  Pick a skill above, paste your draft on the left,<br />
                  and the polished version will appear here.<br />
                  Rate results 👍/👎 — the votes are collected to improve the prompts.
                </div>
              )}
              {loading && (
                <div className="ba-msg ba-msg-assistant ba-thinking">
                  <span className="ba-dot" /><span className="ba-dot" /><span className="ba-dot" />
                </div>
              )}
              {results.map(r => (
                <ResultCard key={r.id} result={r} onFeedback={sendFeedback} />
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
