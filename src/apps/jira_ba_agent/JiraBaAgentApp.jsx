import { useState, useRef, useEffect, useCallback } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';

const LOGO     = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';
const CLOUD_ID = PROJECT_LIST.find(p => p.jira)?.jira.cloudId ?? '';

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

// ─── Tool pills ───────────────────────────────────────────────────────────────

const TOOL_META = {
  search_jira:   { icon: '🔍', label: r => r?.returned != null ? `Found ${r.returned} issue${r.returned !== 1 ? 's' : ''}` : 'Searched Jira' },
  get_issue:     { icon: '📋', label: r => r?.key ? r.key : 'Got issue' },
  list_projects: { icon: '📁', label: r => r?.projects ? `${r.projects.length} projects` : 'Projects' },
  list_sprints:  { icon: '🗓️', label: r => r?.sprints ? `${r.sprints.length} sprints` : 'Sprints' },
  create_issue:  { icon: '✅', label: r => r?.key ? `Created ${r.key}` : 'Created issue' },
};

function ToolPills({ toolResults }) {
  if (!toolResults?.length) return null;
  return (
    <div className="ba-tool-pills">
      {toolResults.map((t, i) => {
        const meta = TOOL_META[t.name] ?? { icon: '⚙️', label: () => t.name };
        const isErr = !!t.error;
        return (
          <span key={i} className={`ba-tool-pill${isErr ? ' error' : ''}`}>
            {meta.icon} {isErr ? `Error: ${t.error}` : meta.label(t.result)}
          </span>
        );
      })}
    </div>
  );
}

// ─── Message bubble ───────────────────────────────────────────────────────────

function AssistantText({ text }) {
  // Render markdown-ish: **bold**, bullet lists, numbered lists, links
  const lines = text.split('\n');
  return (
    <div className="ba-msg-text">
      {lines.map((line, i) => {
        // Skip empty lines (render as spacing)
        if (!line.trim()) return <br key={i} />;

        // Bullet list
        const bulletMatch = line.match(/^[\s]*[-•*]\s+(.*)/);
        if (bulletMatch) return (
          <div key={i} className="ba-list-item">
            <span className="ba-bullet">·</span>
            <span dangerouslySetInnerHTML={{ __html: formatInline(bulletMatch[1]) }} />
          </div>
        );

        // Numbered list
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

function formatInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="ba-inline-code">$1</code>')
    // Issue keys like NSMG-1234 → links
    .replace(/\b([A-Z]{2,10}-\d+)\b/g, '<a class="ba-issue-link" href="https://dynamicalabs.atlassian.net/browse/$1" target="_blank" rel="noreferrer">$1 ↗</a>');
}

function ChatMessage({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="ba-msg ba-msg-user">
        <p className="ba-msg-text">{msg.content}</p>
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
      <ToolPills toolResults={msg.toolResults} />
      <AssistantText text={msg.content} />
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

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function JiraBaAgentApp({ user, onLogout }) {
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

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input]);

  // ─── Send message ────────────────────────────────────────────────────────

  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setInput('');
    setError('');

    const userMsg = { role: 'user', content: trimmed };
    setMessages(prev => {
      const next = [...prev, userMsg];
      sendToBackend(trimmed, next.slice(0, -1));
      return next;
    });
  }, [loading]); // eslint-disable-line

  async function sendToBackend(message, prevMessages) {
    setLoading(true);
    try {
      const history = prevMessages.map(m => ({ role: m.role === 'error' ? 'assistant' : m.role, content: m.content }));
      const res  = await fetch('/api/ba-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, cloudId: CLOUD_ID, userEmail: user }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply, toolResults: data.toolResults ?? [] }]);
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
        <span className="header-title">Jira BA Agent</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className="ba-main">

        {/* ── Chat area ── */}
        <div className="ba-chat">
          {messages.length === 0 && !loading && (
            <div className="ba-empty">
              <p className="ba-empty-title">Привет! Я Jira BA Agent.</p>
              <p className="ba-empty-sub">
                Спрашивай о задачах, спринтах, эпиках — текстом или голосом.<br/>
                Например: <em>«Какие задачи у Димы в текущем спринте NSMG?»</em>
              </p>
            </div>
          )}
          {messages.map((msg, i) => <ChatMessage key={i} msg={msg} />)}
          {loading && <ThinkingBubble />}
          <div ref={bottomRef} />
        </div>

        {/* ── Input bar ── */}
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
              placeholder="Спроси что-нибудь о Jira…"
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
              title="Отправить"
            >
              <SendIcon />
            </button>
          </div>
        </div>

      </main>
    </div>
  );
}
