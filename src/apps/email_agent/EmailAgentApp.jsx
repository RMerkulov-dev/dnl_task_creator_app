import { useState, useRef, useEffect, useCallback } from 'react';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

const DEFAULT_INSTRUCTION = `# Email Assistant

A skill for transforming rough draft communications into polished, professional correspondence.

## Supported Formats

- Emails
- Slack messages
- Formal letters
- Any other professional written communication

## Rules

### 1. Translation
If the input is not in English, translate it to English first.

### 2. Greeting
- Always start the message body with "Hi [Name]".
- Never use "Dear".
- Use the specific name if the user has provided one. If no name is given, use "Hi [Name]" as a placeholder.

### 3. Signature
Never invent or append a signature, sign-off, name, or contact details. If the user's draft already contains a signature block, preserve it exactly as written. If it does not, the message ends at the last sentence of the body — do not add "Best regards", "Sincerely", "Thanks", a name, or an email at the end.

### 4. Formatting
- Keep paragraphs short and scannable.
- Do NOT use horizontal separators (---), section dividers, or markdown rules anywhere in the output.

### 5. Subject Line
- For emails: always invent a professional, relevant subject line. Output it as a single line starting with **Subject:** at the very top.
- For Slack messages: omit the subject line. Keep the message concise and direct.
- For formal letters: use a clear Re: line instead of a subject line if appropriate.

### 6. Tone
Professional, efficient, meticulous, and corporate. Avoid filler phrases, excessive hedging, and overly casual language.

### 7. Quality
Correct all grammar, spelling, punctuation, and structural issues.

## Output

Output ONLY the refined message. Do NOT add a "What changed" summary, change log, meta-commentary, or any explanation of edits. No introductions, no closing remarks from you — just the polished message ready to send.

### Email
**Subject:** [Generated Subject]

[Refined Email Body]

[Original Signature if present]

### Slack Message
[Refined Slack Message]

### Formal Letter
Re: [Topic if appropriate]

[Refined Letter Body]

[Original Signature if present]`;

const STORAGE_KEY = 'email-agent.instruction.v3';

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

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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
    <button
      className="ba-issues-copy-btn"
      onClick={copy}
      title="Copy refined message"
      style={{ marginTop: 8 }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

function ChatMessage({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="ba-msg ba-msg-user">
        <p className="ba-msg-text" style={{ ...EMAIL_TEXT_STYLE, whiteSpace: 'pre-wrap' }}>{msg.content}</p>
      </div>
    );
  }
  if (msg.role === 'error') {
    return (
      <div className="ba-msg ba-msg-error">
        <p className="ba-msg-text">⚠ {msg.content}</p>
      </div>
    );
  }
  return (
    <div className="ba-msg ba-msg-assistant">
      <AssistantText text={msg.content} />
      <CopyButton text={msg.content} />
    </div>
  );
}

function ThinkingBubble() {
  return (
    <div className="ba-msg ba-msg-assistant ba-thinking">
      <span className="ba-dot" /><span className="ba-dot" /><span className="ba-dot" />
    </div>
  );
}

// ─── Instruction Panel ────────────────────────────────────────────────────────

function InstructionPanel({ instruction, setInstruction, open, onToggle }) {
  const [draft, setDraft] = useState(instruction);

  useEffect(() => { setDraft(instruction); }, [instruction]);

  function save() {
    setInstruction(draft);
    onToggle(false);
  }

  function reset() {
    setDraft(DEFAULT_INSTRUCTION);
  }

  return (
    <div style={{
      borderBottom: '1px solid var(--border-1, rgba(255,255,255,0.08))',
      background: 'var(--bg-2, rgba(255,255,255,0.02))',
    }}>
      <button
        onClick={() => onToggle(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          width: '100%',
          background: 'transparent',
          border: 'none',
          color: 'var(--text-2, #aaa)',
          cursor: 'pointer',
          fontSize: 13,
          textAlign: 'left',
        }}
      >
        <GearIcon />
        <span>Instructions {open ? '▾' : '▸'}</span>
        <span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>
          {instruction === DEFAULT_INSTRUCTION ? 'default' : 'custom'}
        </span>
      </button>

      {open && (
        <div style={{ padding: '0 16px 16px 16px' }}>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Instructions for how the agent should refine your messages…"
            style={{
              width: '100%',
              minHeight: 200,
              maxHeight: 400,
              padding: 12,
              borderRadius: 8,
              border: '1px solid var(--border-1, rgba(255,255,255,0.1))',
              background: 'var(--bg-1, rgba(0,0,0,0.2))',
              color: 'var(--text-1, #fff)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={save}
              className="ba-send-btn"
              style={{ padding: '8px 16px', width: 'auto', fontSize: 13 }}
            >
              Save
            </button>
            <button
              onClick={reset}
              className="btn btn-ghost"
              style={{ padding: '8px 16px', fontSize: 13 }}
            >
              Reset to default
            </button>
            <button
              onClick={() => { setDraft(instruction); onToggle(false); }}
              className="btn btn-ghost"
              style={{ padding: '8px 16px', fontSize: 13, marginLeft: 'auto' }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EmailAgentApp({ user, onLogout }) {
  const [instruction, setInstructionState] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT_INSTRUCTION; }
    catch { return DEFAULT_INSTRUCTION; }
  });
  const [panelOpen,    setPanelOpen]    = useState(false);
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState('');
  const [loading,      setLoading]      = useState(false);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error,        setError]        = useState('');

  const bottomRef   = useRef(null);
  const textareaRef = useRef(null);
  const mrRef       = useRef(null);
  const chunksRef   = useRef([]);
  const audioCtxRef = useRef(null);

  function setInstruction(value) {
    setInstructionState(value);
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* noop */ }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }, [input]);

  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setInput('');
    setError('');

    const userMsg = { role: 'user', content: trimmed };
    setMessages(prev => [...prev, userMsg]);
    sendToBackend(trimmed);
  }, [loading, instruction]); // eslint-disable-line

  async function sendToBackend(message) {
    setLoading(true);
    try {
      const res  = await fetch('/api/email-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, instruction, userEmail: user }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'error', content: err.message }]);
    } finally {
      setLoading(false);
    }
  }

  // ─── Voice recording ─────────────────────────────────────────────────────

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

  const canSend = input.trim().length > 0 && !loading;
  const micBusy = recording || transcribing;

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

      <main className="ba-main">
        <InstructionPanel
          instruction={instruction}
          setInstruction={setInstruction}
          open={panelOpen}
          onToggle={setPanelOpen}
        />

        <div className="ba-chat">
          {messages.length === 0 && !loading && (
            <div className="ba-empty">
              <p className="ba-empty-title">Hi! I'm Email Agent.</p>
              <p className="ba-empty-sub">
                Paste your draft email, Slack message, or letter below and I'll polish it according to the instructions.<br/>
                Need a different style? <button
                  onClick={() => setPanelOpen(true)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--accent-1, #10b981)',
                    cursor: 'pointer',
                    padding: 0,
                    textDecoration: 'underline',
                    fontSize: 'inherit',
                  }}
                >Edit the instructions</button>.
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage key={i} msg={msg} />
          ))}
          {loading && <ThinkingBubble />}
          <div ref={bottomRef} />
        </div>

        <div className="ba-input-bar">
          {error && <p className="ba-input-error">⚠ {error}</p>}
          <div className="ba-input-row">
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

            <textarea
              ref={textareaRef}
              className="ba-textarea"
              placeholder="Paste your draft here… (Enter to send, Shift+Enter for newline)"
              value={input}
              rows={1}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
              }}
              disabled={loading || micBusy}
            />

            <button
              className="ba-send-btn"
              onClick={() => send(input)}
              disabled={!canSend}
              title="Refine"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
