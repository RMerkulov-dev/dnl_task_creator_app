import { useState, useRef, useEffect, useCallback } from 'react';
import AgentClarification from '../../components/AgentClarification.jsx';
import AgentPlan from '../../components/AgentPlan.jsx';
import TasksFollowUp from './TasksFollowUp.jsx';

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

// Icon hints based on common verbs in MCP tool names. The Fathom MCP server
// owns the tool catalog now, so we don't pretend to know exact names — we
// just give the pill a plausible icon and a tidy human label.
function iconFor(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('summar'))                            return '✨';
  if (n.includes('transcript'))                        return '📝';
  if (n.includes('search') || n.includes('find'))      return '🔍';
  if (n.includes('list')   || n.includes('meeting') || n.includes('recording') || n.includes('call')) return '🎥';
  return '⚙️';
}

function describeResult(result) {
  if (!result || typeof result !== 'object') return '';
  if (typeof result.count === 'number') return `${result.count} item${result.count === 1 ? '' : 's'}`;
  if (typeof result.blocks === 'number' && result.blocks) return `${result.blocks} block${result.blocks === 1 ? '' : 's'}`;
  return '';
}

function ToolPills({ toolResults }) {
  if (!toolResults?.length) return null;
  return (
    <div className="ba-tool-pills">
      {toolResults.map((t, i) => {
        const isErr = !!t.error;
        const detail = isErr ? `Error: ${t.error}` : (describeResult(t.result) || 'done');
        return (
          <span key={i} className={`ba-tool-pill${isErr ? ' error' : ''}`}>
            {iconFor(t.name)} {t.name} — {detail}
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

function ChatMessage({ msg, isLast, onClarificationAnswer, onApprovePlan, onCancelPlan }) {
  if (msg.role === 'user') {
    return (
      <div className="ba-msg ba-msg-user">
        <p className="ba-msg-text">{msg.content}</p>
      </div>
    );
  }
  if (msg.role === 'error') {
    // Even when the server fails mid-flight, render whatever tool results
    // already came back so the user can see the partial work.
    return (
      <div className="ba-msg ba-msg-error">
        <ToolPills toolResults={msg.toolResults} />
        <p className="ba-msg-text">⚠ {msg.content || 'Unknown error'}</p>
      </div>
    );
  }
  if (msg.awaitingConfirmation) {
    const locked = msg.confirmed || msg.cancelled || !isLast;
    return (
      <div className="ba-msg ba-msg-assistant ba-msg-with-plan">
        <AgentPlan
          plan={msg.plan}
          onApprove={editedPlan => onApprovePlan(msg, editedPlan)}
          onCancel={() => onCancelPlan(msg)}
          locked={locked}
        />
        {msg.cancelled && <p className="ba-msg-text" style={{ opacity: 0.6 }}>Plan cancelled.</p>}
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
    secs < 3  ? 'Thinking…' :
    secs < 8  ? 'Searching Fathom meetings…' :
    secs < 20 ? 'Reading transcripts…' :
                'Still working — large transcripts, hang tight…';

  return (
    <div className="ba-msg ba-msg-assistant ba-thinking-rich">
      <div className="ba-thinking-row">
        <span className="ba-dot" /><span className="ba-dot" /><span className="ba-dot" />
        <span className="ba-thinking-hint">{hint}</span>
        <span className="ba-thinking-timer">{secs}s</span>
        {onCancel && secs >= 5 && (
          <button className="ba-thinking-cancel" onClick={onCancel} title="Cancel">
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Per-user Fathom MCP access token lives in localStorage. The token is obtained
// by opening /api/fathom/oauth/start in a popup; the popup posts the token back
// via window.postMessage. There's no server-side token store.
const FATHOM_TOKEN_KEY = 'fathom_oauth_token';

function readStoredFathomToken() {
  try { return localStorage.getItem(FATHOM_TOKEN_KEY) || ''; }
  catch { return ''; }
}

export default function FathomAgentApp({ user, allowedProjects, onLogout }) {
  const [tab,          setTab]          = useState('ask'); // 'ask' | 'tasks'
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState('');
  const [loading,      setLoading]      = useState(false);
  const [loadingStart, setLoadingStart] = useState(0);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error,        setError]        = useState('');
  const [fathomToken,  setFathomToken]  = useState(() => readStoredFathomToken());
  const [connecting,   setConnecting]   = useState(false);
  const [connectError, setConnectError] = useState('');
  // A token in localStorage only *looks* like a connection — it may have been
  // revoked or expired since. Verified on mount (below) so the Connect screen
  // appears the moment the app is opened, not after the first Load calls.
  const [checking,     setChecking]     = useState(() => !!readStoredFathomToken());
  const popupRef = useRef(null);

  function persistToken(token) {
    try {
      if (token) localStorage.setItem(FATHOM_TOKEN_KEY, token);
      else       localStorage.removeItem(FATHOM_TOKEN_KEY);
    } catch { /* private mode etc. */ }
    setFathomToken(token || '');
    // Clear failed pre-connect attempts so the user starts fresh.
    if (token) setMessages(prev => prev.filter(m => m.role !== 'error'));
  }

  function connectFathom() {
    setConnectError('');
    setConnecting(true);
    // Open BEFORE any await — Safari only honors window.open on a user gesture.
    const w = 520, h = 720;
    const left = Math.max(0, (window.screen.width  - w) / 2);
    const top  = Math.max(0, (window.screen.height - h) / 2);
    popupRef.current = window.open(
      '/api/fathom/oauth/start',
      'fathom-oauth',
      `width=${w},height=${h},left=${left},top=${top}`,
    );
    if (!popupRef.current) {
      setConnecting(false);
      setConnectError('Popup was blocked. Allow popups for this site and try again.');
      return;
    }
    // Watchdog: if the popup is closed before we receive a message, drop the
    // "connecting" state so the button is interactive again.
    const watchdog = setInterval(() => {
      if (popupRef.current && popupRef.current.closed) {
        clearInterval(watchdog);
        setConnecting(false);
      }
    }, 500);
  }

  // Listen for OAuth result. Two channels, because window.opener.postMessage
  // can be severed by Fathom's Cross-Origin-Opener-Policy: the popup writes to
  // localStorage as well, and the SPA picks it up via the 'storage' event
  // (which fires in *other* tabs/windows of the same origin).
  useEffect(() => {
    function applyResult(payload) {
      if (!payload) return;
      setConnecting(false);
      if (payload.ok && payload.accessToken) {
        persistToken(payload.accessToken);
        setConnectError('');
      } else if (payload.error) {
        setConnectError(payload.error);
      }
    }
    function onMessage(ev) {
      if (ev.origin !== window.location.origin) return;
      const { source, payload } = ev.data || {};
      if (source !== 'fathom-oauth' || !payload) return;
      applyResult(payload);
    }
    function onStorage(ev) {
      if (ev.key === 'fathom_oauth_result' && ev.newValue) {
        try { applyResult(JSON.parse(ev.newValue)?.payload); } catch { /* ignore */ }
      } else if (ev.key === FATHOM_TOKEN_KEY) {
        // Token slot changed in another tab (Connect or Disconnect elsewhere).
        setFathomToken(ev.newValue || '');
        if (ev.newValue) setConnecting(false);
      }
    }
    window.addEventListener('message', onMessage);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Validate the stored token as soon as the app opens (and whenever it
  // changes). A 401 wipes it, so the user lands straight on the Connect screen
  // with the reason; anything else (network, MCP hiccup) is reported without
  // discarding a token that may well be fine.
  useEffect(() => {
    if (!fathomToken) { setChecking(false); return; }
    let alive = true;
    setChecking(true);
    fetch('/api/fathom/session-check', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fathomToken }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!alive || res.ok) return;
        if (data.reconnect) {
          persistToken('');
          setConnectError(data.error || 'Fathom access expired. Please reconnect.');
        } else {
          setError(data.error || `Could not reach Fathom (${res.status}).`);
        }
      })
      .catch((e) => { if (alive) setError(e.message || 'Could not reach Fathom.'); })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, [fathomToken]); // eslint-disable-line

  const bottomRef   = useRef(null);
  const textareaRef = useRef(null);
  const mrRef       = useRef(null);
  const chunksRef   = useRef([]);
  const audioCtxRef = useRef(null);
  const abortRef    = useRef(null);

  const REQUEST_TIMEOUT_MS = 90_000;

  // Scroll the message list itself rather than scrollIntoView — that walks every
  // scrollable ancestor and drags the whole shell up with it.
  useEffect(() => {
    const list = bottomRef.current?.parentElement;
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
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

  // Build history payload for the backend. Plan-card messages are internal
  // scaffolding — they're injected via system message on confirmation, not
  // replayed as conversation, so we skip them here.
  function toHistoryPayload(prevMessages) {
    return prevMessages
      .filter(m => !m.awaitingConfirmation)
      .map(m => ({ role: m.role === 'error' ? 'assistant' : m.role, content: m.content || '' }));
  }

  async function sendToBackend(message, prevMessages, opts = {}) {
    setLoading(true);
    setLoadingStart(Date.now());

    const controller = new AbortController();
    abortRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS);

    try {
      const history = toHistoryPayload(prevMessages);
      const res  = await fetch('/api/fathom-agent', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          message,
          history,
          userEmail:   user,
          fathomToken: fathomToken || '',
          ...(opts.confirmedPlan ? { confirmedPlan: opts.confirmedPlan } : {}),
        }),
        signal:  controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 401 + reconnect = Fathom token died (or missing). Wipe it so the
        // Connect screen comes back; surface a clear message.
        if (data.reconnect) {
          persistToken('');
          setConnectError(data.error || 'Fathom access expired. Please reconnect.');
        }
        const msg = data.reconnect
          ? (data.error || 'Fathom access expired. Click "Connect Fathom" to authorize again.')
          : (data.error || `Server error ${res.status}`);
        const err = new Error(msg);
        err.toolResults = data.toolResults ?? [];
        throw err;
      }

      // Stage 1: planner returned a plan that needs user approval.
      if (data.stage === 'plan' && data.plan) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          plan: data.plan,
          awaitingConfirmation: true,
          confirmed: false,
          cancelled: false,
          toolResults: [],
        }]);
        return;
      }

      // Default: normal assistant turn (stage='done' or 'clarify').
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply || '',
        toolResults: data.toolResults ?? [],
        clarification: data.clarification || null,
      }]);
    } catch (err) {
      const msg = err.name === 'AbortError'
        ? (controller.signal.reason === 'timeout'
            ? `Request exceeded ${REQUEST_TIMEOUT_MS / 1000}s and was cancelled. Try narrowing your question.`
            : 'Request cancelled.')
        : (err.message || 'Unknown error');
      setMessages(prev => [...prev, {
        role: 'error',
        content: msg,
        toolResults: err.toolResults ?? [],
      }]);
    } finally {
      clearTimeout(timeoutId);
      abortRef.current = null;
      setLoading(false);
      setLoadingStart(0);
    }
  }

  // User clicked Approve (or Run after editing) on a plan card.
  // Re-send the original user query along with the (possibly edited) plan;
  // the backend skips the planner and goes straight to the executor.
  function approvePlan(planMsg, editedPlan) {
    if (loading) return;
    const idx = messages.indexOf(planMsg);
    if (idx < 0) return;
    let userIdx = idx - 1;
    while (userIdx >= 0 && messages[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;

    const originalText = messages[userIdx].content;
    const priorHistory = messages.slice(0, userIdx);

    setMessages(prev => prev.map(m => m === planMsg ? { ...m, confirmed: true } : m));
    sendToBackend(originalText, priorHistory, { confirmedPlan: editedPlan });
  }

  function cancelPlan(planMsg) {
    setMessages(prev => prev.map(m => m === planMsg ? { ...m, cancelled: true } : m));
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
      setError('No microphone access.');
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
      if (!res.ok) throw new Error(data.error || 'Transcription error');
      const text = (data.text || '').trim();
      if (text) setInput(prev => prev ? `${prev} ${text}` : text);
      else setError('Could not recognize speech.');
    } catch (e) {
      setError(e.message);
    } finally {
      setTranscribing(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  const canSend = input.trim().length > 0 && !loading && !!fathomToken;
  const micBusy = recording || transcribing;

  // The working UI waits for the token check — otherwise the user starts typing
  // (or hits Load calls) against a connection we already know is dead.
  const verifying   = !!fathomToken && checking;
  const isConnected = !!fathomToken && !checking;

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-logo"><img src={LOGO} alt="Dynamica Labs" /></div>
        <div className="header-sep" />
        <span className="header-title">Fathom Agent</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        {isConnected && (
          <button
            className="btn btn-ghost"
            onClick={() => { persistToken(''); setConnectError(''); }}
            style={{ marginLeft: 12 }}
            title="Forget Fathom token on this device"
          >
            Disconnect Fathom
          </button>
        )}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className={`ba-main${isConnected && tab === 'tasks' ? ' ba-main-wide' : ''}`}>
        {isConnected && (
          <div className="ba-tabs">
            <button
              className={`ba-tab${tab === 'ask' ? ' active' : ''}`}
              onClick={() => setTab('ask')}
            >
              Ask Fathom
            </button>
            <button
              className={`ba-tab${tab === 'tasks' ? ' active' : ''}`}
              onClick={() => setTab('tasks')}
            >
              Tasks Follow-up
            </button>
          </div>
        )}

        {verifying ? (
          <div className="ba-chat">
            <div className="ba-empty">
              <span className="spinner" style={{ width: 22, height: 22 }} />
              <p className="ba-empty-sub" style={{ marginTop: 12 }}>Checking your Fathom connection…</p>
            </div>
          </div>
        ) : !isConnected ? (
          <div className="ba-chat">
            <div className="ba-empty">
              <p className="ba-empty-title">Connect your Fathom account</p>
              <p className="ba-empty-sub">
                Fathom Agent reads your meetings through Fathom's official MCP server.<br/>
                Authorize once — your token stays on this device.
              </p>
              <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
                <button
                  className="btn"
                  onClick={connectFathom}
                  disabled={connecting}
                  style={{ minWidth: 220 }}
                >
                  {connecting ? 'Waiting for Fathom…' : 'Connect Fathom'}
                </button>
                {connectError && <p className="ba-input-error" style={{ maxWidth: 480, textAlign: 'center' }}>⚠ {connectError}</p>}
              </div>
            </div>
          </div>
        ) : tab === 'tasks' ? (
          <div className="tf-tab">
            <TasksFollowUp
              user={user}
              allowedProjects={allowedProjects}
              fathomToken={fathomToken}
              onReconnect={msg => { persistToken(''); setConnectError(msg || ''); setTab('ask'); }}
            />
          </div>
        ) : (
          <>
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
                  onApprovePlan={approvePlan}
                  onCancelPlan={cancelPlan}
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
                  disabled={loading || transcribing || !fathomToken}
                  title={recording ? 'Stop recording' : 'Voice input'}
                >
                  {transcribing
                    ? <span className="spinner" style={{ width: 16, height: 16 }} />
                    : recording ? <StopIcon /> : <MicIcon />}
                </button>

                <textarea
                  ref={textareaRef}
                  className="ba-textarea"
                  placeholder={fathomToken ? 'Ask anything about your Fathom meetings…' : 'Connect Fathom to start chatting…'}
                  value={input}
                  rows={1}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); }
                  }}
                  disabled={loading || micBusy || !fathomToken}
                />

                <button
                  className="ba-send-btn"
                  onClick={() => send(input)}
                  disabled={!canSend}
                  title="Send"
                >
                  <SendIcon />
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
