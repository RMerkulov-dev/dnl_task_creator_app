import { useState, useRef, useEffect, useCallback } from 'react';
import AgentClarification from '../../components/AgentClarification.jsx';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

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
  list_meetings:   { icon: '🎥', label: r => r?.returned != null ? `${r.returned} meeting${r.returned !== 1 ? 's' : ''}` : 'Listed meetings' },
  get_transcript:  { icon: '📝', label: r => r?.lines ? `Transcript (${r.lines.length} lines)` : 'Got transcript' },
  get_summary:     { icon: '✨', label: r => r?.template ? `Summary (${r.template})` : 'Got summary' },
  search_meetings: { icon: '🔍', label: r => r?.matched != null ? `Matched ${r.matched}` : 'Searched' },
};

function ToolPills({ toolResults }) {
  if (!toolResults?.length) return null;
  return (
    <div className="ba-tool-pills">
      {toolResults.map((t, i) => {
        const meta  = TOOL_META[t.name] ?? { icon: '⚙️', label: () => t.name };
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

// ─── Message rendering ────────────────────────────────────────────────────────

function formatInline(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code class="ba-inline-code">$1</code>')
    // Fathom share/call URLs → clickable
    .replace(/(https?:\/\/fathom\.video\/[^\s)]+)/g, '<a class="ba-issue-link" href="$1" target="_blank" rel="noreferrer">fathom ↗</a>');
}

function AssistantText({ text }) {
  const lines = text.split('\n');
  return (
    <div className="ba-msg-text">
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

function ChatMessage({ msg, isLast, onClarificationAnswer }) {
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
      {msg.clarification && (
        <AgentClarification
          clarification={msg.clarification}
          onAnswer={onClarificationAnswer}
          locked={!isLast}
        />
      )}
    </div>
  );
}

function ThinkingBubble({ startedAt, onCancel }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);

  const hint =
    secs < 3  ? 'Думаю…' :
    secs < 8  ? 'Ищу встречи в Fathom…' :
    secs < 20 ? 'Читаю транскрипты…' :
                'Всё ещё работаю — большие транскрипты, потерпите…';

  return (
    <div className="ba-msg ba-msg-assistant ba-thinking-rich">
      <div className="ba-thinking-row">
        <span className="ba-dot" /><span className="ba-dot" /><span className="ba-dot" />
        <span className="ba-thinking-hint">{hint}</span>
        <span className="ba-thinking-timer">{secs}s</span>
        {onCancel && secs >= 5 && (
          <button className="ba-thinking-cancel" onClick={onCancel} title="Прервать">
            Отмена
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function FathomAgentApp({ user, onLogout }) {
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState('');
  const [loading,      setLoading]      = useState(false);
  const [loadingStart, setLoadingStart] = useState(0);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error,        setError]        = useState('');

  const bottomRef   = useRef(null);
  const textareaRef = useRef(null);
  const mrRef       = useRef(null);
  const chunksRef   = useRef([]);
  const audioCtxRef = useRef(null);
  const abortRef    = useRef(null);

  const REQUEST_TIMEOUT_MS = 90_000;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [input]);

  const send = useCallback(async (text) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setInput('');
    setError('');

    const userMsg = { role: 'user', content: trimmed };
    // NOTE: pure updater (no side effects). StrictMode double-invokes the
    // updater in dev — calling sendToBackend inside would fire two HTTP requests.
    setMessages(prev => [...prev, userMsg]);
    sendToBackend(trimmed, messages);
  }, [loading, messages]); // eslint-disable-line

  async function sendToBackend(message, prevMessages) {
    setLoading(true);
    setLoadingStart(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

    try {
      const history = prevMessages.map(m => ({ role: m.role === 'error' ? 'assistant' : m.role, content: m.content }));
      const res  = await fetch('/api/fathom-agent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message, history, userEmail: user }),
        signal:  controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply,
        toolResults: data.toolResults ?? [],
        clarification: data.clarification || null,
      }]);
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? (controller.signal.reason === 'timeout'
            ? `Запрос превысил ${REQUEST_TIMEOUT_MS / 1000}s — прервано. Попробуйте уточнить вопрос.`
            : 'Запрос отменён.')
        : err.message;
      setMessages(prev => [...prev, { role: 'error', content: msg }]);
    } finally {
      clearTimeout(timeoutId);
      abortRef.current = null;
      setLoading(false);
      setLoadingStart(0);
    }
  }

  function cancelRequest() {
    abortRef.current?.abort('user');
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
        <span className="header-title">Fathom Agent</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className="ba-main">
        <div className="ba-chat">
          {messages.length === 0 && !loading && (
            <div className="ba-empty">
              <p className="ba-empty-title">Hi! I'm Fathom Agent.</p>
              <p className="ba-empty-sub">
                Ask about meetings and transcripts — by text or voice.<br/>
                For example: <em>"What did we discuss with the client last week?"</em>, <em>"Show the summary of the last call"</em>
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage
              key={i}
              msg={msg}
              isLast={i === messages.length - 1}
              onClarificationAnswer={answer => send(answer)}
            />
          ))}
          {loading && <ThinkingBubble startedAt={loadingStart} onCancel={cancelRequest} />}
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
              placeholder="Спроси что-нибудь о встречах в Fathom…"
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
