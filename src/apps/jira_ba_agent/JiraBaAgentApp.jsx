import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import AgentClarification from '../../components/AgentClarification.jsx';
import AgentPlan from '../../components/AgentPlan.jsx';
import ComponentApplyModal from './ComponentApplyModal.jsx';

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

// ─── Issues table (rendered from tool results) ────────────────────────────────

const JIRA_BASE = 'https://dynamicalabs.atlassian.net/browse/';

function collectIssues(toolResults) {
  if (!toolResults?.length) return [];
  const seen = new Map();
  for (const t of toolResults) {
    if (t.error || !t.result) continue;
    if (t.name === 'search_jira' && Array.isArray(t.result.issues)) {
      for (const i of t.result.issues) {
        if (i?.key && !seen.has(i.key)) seen.set(i.key, i);
      }
    }
    if (t.name === 'get_issue' && t.result.key) {
      if (!seen.has(t.result.key)) seen.set(t.result.key, t.result);
    }
  }
  return Array.from(seen.values());
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

function componentsLabel(i) {
  return Array.isArray(i.components) && i.components.length ? i.components.join(', ') : '';
}

function issuesToMarkdown(issues) {
  const header = '| Key | Summary | Status | Assignee | Priority | Type | Component |\n|---|---|---|---|---|---|---|';
  const rows = issues.map(i =>
    `| [${i.key}](${JIRA_BASE}${i.key}) | ${(i.summary ?? '').replace(/\|/g, '\\|')} | ${i.status ?? ''} | ${i.assignee ?? ''} | ${i.priority ?? ''} | ${i.type ?? ''} | ${componentsLabel(i).replace(/\|/g, '\\|')} |`
  );
  return [header, ...rows].join('\n');
}

function issuesToTSV(issues) {
  const header = ['Key', 'Summary', 'Status', 'Assignee', 'Priority', 'Type', 'Component'].join('\t');
  const rows = issues.map(i => [
    i.key, i.summary ?? '', i.status ?? '', i.assignee ?? '', i.priority ?? '', i.type ?? '', componentsLabel(i)
  ].map(c => String(c).replace(/\t/g, ' ').replace(/\n/g, ' ')).join('\t'));
  return [header, ...rows].join('\n');
}

// Status → colour tone. Prefers Jira's statusCategory (returned by the
// backend); falls back to a name heuristic for older messages without it.
function statusTone(i) {
  const cat = (i.statusCategory || '').toLowerCase();
  if (cat === 'done') return 'done';
  if (cat === 'indeterminate') return 'progress';
  if (cat === 'new') return 'todo';
  const s = (i.status || '').toLowerCase();
  if (/done|closed|resolved|cancel|complete/.test(s)) return 'done';
  if (/progress|review|test|develop|uat/.test(s))     return 'progress';
  return 'todo';
}

function priorityClass(p) {
  const s = (p || '').toLowerCase();
  if (s === 'highest' || s === 'high') return 'ba-pri-high';
  if (s === 'medium')                  return 'ba-pri-med';
  if (s === 'low' || s === 'lowest')   return 'ba-pri-low';
  return '';
}

function IssuesTable({ issues }) {
  const [copiedAll,  setCopiedAll]  = useState(false);
  const [copiedKey,  setCopiedKey]  = useState(null);
  // Selection feeds the "Set component" bulk action; everything starts checked.
  const [deselected, setDeselected] = useState(() => new Set());
  const [compModal,  setCompModal]  = useState(false);

  const selected = useMemo(() => issues.filter(i => !deselected.has(i.key)), [issues, deselected]);
  const allChecked = deselected.size === 0;

  function toggleKey(key) {
    setDeselected(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  }
  function toggleAll() {
    setDeselected(allChecked ? new Set(issues.map(i => i.key)) : new Set());
  }

  async function copyAll(format) {
    const text = format === 'tsv' ? issuesToTSV(issues) : issuesToMarkdown(issues);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(format);
      setTimeout(() => setCopiedAll(false), 1500);
    } catch { /* noop */ }
  }

  async function copyKey(key) {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1200);
    } catch { /* noop */ }
  }

  return (
    <div className="ba-issues-card">
      <div className="ba-issues-header">
        <span className="ba-issues-count">
          {issues.length} issue{issues.length !== 1 ? 's' : ''}
          {selected.length !== issues.length && <span className="ba-issues-selcount"> · {selected.length} selected</span>}
        </span>
        <div className="ba-issues-actions">
          <button className="ba-issues-copy-btn" onClick={() => copyAll('md')} title="Copy as Markdown table">
            {copiedAll === 'md' ? <CheckIcon /> : <CopyIcon />}
            <span>{copiedAll === 'md' ? 'Copied' : 'Markdown'}</span>
          </button>
          <button className="ba-issues-copy-btn" onClick={() => copyAll('tsv')} title="Copy as TSV (Excel/Sheets)">
            {copiedAll === 'tsv' ? <CheckIcon /> : <CopyIcon />}
            <span>{copiedAll === 'tsv' ? 'Copied' : 'TSV'}</span>
          </button>
          <button
            className="ba-issues-copy-btn ba-comp-btn"
            onClick={() => setCompModal(true)}
            disabled={!selected.length}
            title="Set a Jira component on the selected issues (and their child Epics)"
          >
            <span>Set component{selected.length ? ` (${selected.length})` : ''}</span>
          </button>
        </div>
      </div>
      <div className="ba-issues-scroll">
        <table className="ba-issues-table">
          <thead>
            <tr>
              <th className="ba-check-cell">
                <input
                  type="checkbox"
                  className="ba-issues-check"
                  checked={allChecked}
                  onChange={toggleAll}
                  title={allChecked ? 'Deselect all' : 'Select all'}
                />
              </th>
              <th>Key</th>
              <th>Summary</th>
              <th>Status</th>
              <th>Assignee</th>
              <th>Priority</th>
              <th>Type</th>
              <th>Component</th>
            </tr>
          </thead>
          <tbody>
            {issues.map(i => (
              <tr key={i.key}>
                <td className="ba-check-cell">
                  <input
                    type="checkbox"
                    className="ba-issues-check"
                    checked={!deselected.has(i.key)}
                    onChange={() => toggleKey(i.key)}
                  />
                </td>
                <td>
                  <button
                    className="ba-issues-key"
                    onClick={() => copyKey(i.key)}
                    title={`Copy ${i.key}`}
                  >
                    {copiedKey === i.key ? <CheckIcon /> : null}
                    {i.key}
                  </button>
                  <a className="ba-issues-key-link" href={`${JIRA_BASE}${i.key}`} target="_blank" rel="noreferrer" title="Open in Jira">↗</a>
                </td>
                <td className="ba-issues-summary">{i.summary}</td>
                <td><span className={`ba-issues-chip ba-chip-${statusTone(i)}`}>{i.status || '—'}</span></td>
                <td>{i.assignee || '—'}</td>
                <td className={priorityClass(i.priority)}>{i.priority || '—'}</td>
                <td>{i.type || '—'}</td>
                <td className="ba-issues-comps">
                  {Array.isArray(i.components) && i.components.length
                    ? i.components.map(c => <span key={c} className="ba-issues-chip ba-chip-comp">{c}</span>)
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {compModal && (
        <ComponentApplyModal issues={selected} onClose={() => setCompModal(false)} />
      )}
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
    // Even when the server fails mid-flight, render any partial tool results
    // so the user can still see what was done before the error.
    const issues = collectIssues(msg.toolResults);
    return (
      <div className={`ba-msg ba-msg-error${issues.length >= 2 ? ' ba-msg-wide' : ''}`}>
        <ToolPills toolResults={msg.toolResults} />
        {issues.length >= 2 && <IssuesTable issues={issues} />}
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
  const issues = collectIssues(msg.toolResults);
  const showTable = issues.length >= 2;
  return (
    <div className={`ba-msg ba-msg-assistant${showTable ? ' ba-msg-wide' : ''}`}>
      <ToolPills toolResults={msg.toolResults} />
      {showTable && <IssuesTable issues={issues} />}
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

// Elapsed-time thinking bubble (same pattern as the Fathom agent) so long
// planner/executor runs don't look frozen.
function ThinkingBubble({ startedAt }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(id);
  }, [startedAt]);

  const hint =
    secs < 3  ? 'Thinking…' :
    secs < 8  ? 'Querying Jira…' :
    secs < 20 ? 'Running JQL searches…' :
                'Still working — broad search, hang tight…';

  return (
    <div className="ba-msg ba-msg-assistant ba-thinking-rich">
      <div className="ba-thinking-row">
        <span className="ba-dot" /><span className="ba-dot" /><span className="ba-dot" />
        <span className="ba-thinking-hint">{hint}</span>
        <span className="ba-thinking-timer">{secs}s</span>
      </div>
    </div>
  );
}

// Clickable examples for the empty state — each sends itself as a message.
const SUGGESTIONS = [
  'My tasks in the current NSMG sprint',
  'Open ABS bugs created in the last 14 days',
  'Find requests about the commission module',
  'Status of the Seminar Registration feature',
];

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function JiraBaAgentApp({ user, onLogout }) {
  const [messages,     setMessages]     = useState([]);
  const [input,        setInput]        = useState('');
  const [loading,      setLoading]      = useState(false);
  const [recording,    setRecording]    = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error,        setError]        = useState('');

  const bottomRef    = useRef(null);
  const textareaRef  = useRef(null);
  const mrRef        = useRef(null);
  const chunksRef    = useRef([]);
  const audioCtxRef  = useRef(null);
  const loadStartRef = useRef(null);

  // Auto-scroll. Scroll the message list itself rather than scrollIntoView —
  // that walks every scrollable ancestor and drags the whole shell up with it.
  useEffect(() => {
    const list = bottomRef.current?.parentElement;
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
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
    // NOTE: pure updater (no side effects). StrictMode double-invokes the
    // updater in dev — calling sendToBackend inside would fire two HTTP requests.
    setMessages(prev => [...prev, userMsg]);
    sendToBackend(trimmed, messages);
  }, [loading, messages]); // eslint-disable-line

  // Plan-card messages are internal scaffolding — they're injected via system
  // prompt on confirmation, not replayed in conversation history.
  function toHistoryPayload(prevMessages) {
    return prevMessages
      .filter(m => !m.awaitingConfirmation)
      .map(m => ({ role: m.role === 'error' ? 'assistant' : m.role, content: m.content || '' }));
  }

  async function sendToBackend(message, prevMessages, opts = {}) {
    loadStartRef.current = Date.now();
    setLoading(true);
    try {
      const history = toHistoryPayload(prevMessages);
      const res  = await fetch('/api/ba-agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          history,
          cloudId: CLOUD_ID,
          userEmail: user,
          ...(opts.confirmedPlan ? { confirmedPlan: opts.confirmedPlan } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(data.error || `Server error ${res.status}`);
        e.toolResults = data.toolResults ?? [];
        throw e;
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

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply || '',
        toolResults: data.toolResults ?? [],
        clarification: data.clarification || null,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: err.message || 'Unknown error',
        toolResults: err.toolResults ?? [],
      }]);
    } finally {
      setLoading(false);
    }
  }

  // User approved (and possibly edited) a plan — re-send original query
  // with the confirmed plan so backend skips planner and runs executor.
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
              <p className="ba-empty-title">Hi! I'm Jira BA Agent.</p>
              <p className="ba-empty-sub">
                Ask about issues, sprints, epics — by text or voice. Found issues can be
                bulk-assigned a component right from the results table.
              </p>
              <div className="ba-suggest">
                {SUGGESTIONS.map(s => (
                  <button key={s} type="button" className="ba-suggest-chip" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
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
          {loading && <ThinkingBubble startedAt={loadStartRef.current} />}
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
              title={recording ? 'Stop recording' : 'Voice input'}
            >
              {transcribing
                ? <span className="spinner" style={{ width: 16, height: 16 }} />
                : recording ? <StopIcon /> : <MicIcon />}
            </button>

            <textarea
              ref={textareaRef}
              className="ba-textarea"
              placeholder="Ask anything about Jira…"
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
              title="Send"
            >
              <SendIcon />
            </button>
          </div>
        </div>

      </main>
    </div>
  );
}
