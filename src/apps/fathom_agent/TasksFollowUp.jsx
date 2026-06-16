import { useState, useEffect, useCallback } from 'react';
import TaskCreateModal from '../../components/TaskCreateModal.jsx';

// ─── Skill output parser ──────────────────────────────────────────────────────
// Turns the strict "Tasks Follow-Up" markdown into structured task objects so we
// can render one block per task with its own "Create Task" button. Tolerant of
// minor formatting drift; if nothing parses we fall back to showing raw text.
function parseSkillOutput(md) {
  const empty = { analysis: '', tasks: [], urgent: '', backlog: '', hasStructure: false };
  if (!md) return empty;

  const analysis = (md.match(/\*\*\s*Cloud Skill Analysis\s*\*\*\s*([\s\S]*?)(?=\n\s*---|\n\s*\*\*\s*Task)/i)?.[1] || '').trim();

  const tasks = [];
  const taskRe = /\*\*\s*Task\s*#?\s*(\d+)\s*\*\*([\s\S]*?)(?=\*\*\s*Task\s*#?\s*\d+\s*\*\*|\*\*\s*Urgent Items|\*\*\s*Backlog Recommendations|$)/gi;
  let m;
  while ((m = taskRe.exec(md)) !== null) {
    const body = m[2];
    const field = label => {
      const re = new RegExp(`\\*\\*\\s*${label}\\s*:?\\s*\\*\\*\\s*:?\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\*|\\n\\s*---|$)`, 'i');
      return (body.match(re)?.[1] || '').trim();
    };
    const task = {
      n:           m[1],
      title:       field('Task Title'),
      description: field('Task Description'),
      priority:    field('Priority'),
      who:         field('Who'),
      link:        field('Fathom Link'),
    };
    if (task.title || task.description) tasks.push(task);
  }

  const urgent  = (md.match(/\*\*\s*Urgent Items Summary\s*\*\*\s*([\s\S]*?)(?=\*\*\s*Backlog Recommendations|\*\*\s*Task|$)/i)?.[1] || '').trim();
  const backlog = (md.match(/\*\*\s*Backlog Recommendations\s*\*\*\s*([\s\S]*?)$/i)?.[1] || '').trim();

  return { analysis, tasks, urgent, backlog, hasStructure: tasks.length > 0 };
}

function priorityClass(p) {
  const s = (p || '').toLowerCase();
  if (s.includes('urgent')) return 'tf-pri tf-pri-urgent';
  if (s.includes('high'))   return 'tf-pri tf-pri-high';
  if (s.includes('backlog')) return 'tf-pri tf-pri-backlog';
  return 'tf-pri tf-pri-medium';
}

// Render a "Fathom Link" field value that may be a markdown link, bare URL, or text.
function FathomLinkValue({ value }) {
  if (!value || /not provided/i.test(value)) return <span className="tf-task-dim">Not provided</span>;
  const mdLink = value.match(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/);
  if (mdLink) return <a className="ba-issue-link" href={mdLink[2]} target="_blank" rel="noreferrer">{mdLink[1]} ↗</a>;
  const url = value.match(/https?:\/\/\S+/);
  if (url) return <a className="ba-issue-link" href={url[0]} target="_blank" rel="noreferrer">open ↗</a>;
  return <span>{value}</span>;
}

// ─── Tasks Follow-up tab ──────────────────────────────────────────────────────
//
// Layout: a compact controls bar on top (date range + My/Team scope + Load),
// then a two-column working area — call list on the left, skill picker + result
// on the right. Each column scrolls on its own so the page itself never scrolls.

function fmtDate(d) {
  // Local YYYY-MM-DD (what <input type="date"> expects/returns).
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const PRESETS = [
  { id: 'today', label: 'Today',     start: () => fmtDate(new Date()),  end: () => fmtDate(new Date()) },
  { id: '7d',    label: 'Last 7 days',  start: () => fmtDate(daysAgo(7)),  end: () => fmtDate(new Date()) },
  { id: '30d',   label: 'Last 30 days', start: () => fmtDate(daysAgo(30)), end: () => fmtDate(new Date()) },
];

export default function TasksFollowUp({ user, allowedProjects, fathomToken, onReconnect }) {
  const [startDate, setStartDate] = useState(() => fmtDate(daysAgo(7)));
  const [endDate,   setEndDate]   = useState(() => fmtDate(new Date()));
  const [scope,     setScope]     = useState('my'); // 'my' | 'team'

  const [calls,        setCalls]       = useState(null);   // null = not loaded yet
  const [loadingCalls, setLoadingCalls] = useState(false);
  const [callsError,   setCallsError]  = useState('');
  const [selectedCall, setSelectedCall] = useState(null);

  const [skills,        setSkills]       = useState([]);
  const [selectedSkill, setSelectedSkill] = useState('');

  const [running,  setRunning]  = useState(false);
  const [result,   setResult]   = useState('');
  const [runError, setRunError] = useState('');
  const [copied,   setCopied]   = useState(false);

  const [taskModal, setTaskModal] = useState(null);  // { task } being created
  const [created,   setCreated]   = useState({});    // { [taskKey]: { jiraKey, jiraUrl, epicUrl } }

  // Load the skill catalogue once.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/fathom/skills')
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        const list = d.skills ?? [];
        setSkills(list);
        if (list[0]) setSelectedSkill(list[0].id);
      })
      .catch(() => { /* dropdown stays empty; Run is disabled */ });
    return () => { cancelled = true; };
  }, []);

  function applyPreset(p) {
    setStartDate(p.start());
    setEndDate(p.end());
  }

  function handleAuthFailure(data) {
    if (data?.reconnect) onReconnect?.(data.error || 'Fathom access expired. Please reconnect.');
  }

  const loadCalls = useCallback(async () => {
    setLoadingCalls(true);
    setCallsError('');
    setCalls(null);
    setSelectedCall(null);
    setResult('');
    setRunError('');
    try {
      const res = await fetch('/api/fathom/my-calls', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ fathomToken, userEmail: user, startDate, endDate, scope }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        handleAuthFailure(data);
        throw new Error(data.error || `Server error ${res.status}`);
      }
      setCalls(data.meetings ?? []);
    } catch (e) {
      setCallsError(e.message || 'Could not load calls.');
    } finally {
      setLoadingCalls(false);
    }
  }, [fathomToken, user, startDate, endDate, scope]); // eslint-disable-line

  const runSkill = useCallback(async () => {
    if (!selectedCall || !selectedSkill) return;
    setRunning(true);
    setRunError('');
    setResult('');
    setCopied(false);
    setCreated({});
    try {
      const res = await fetch('/api/fathom/skill-run', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          fathomToken,
          userEmail:   user,
          recordingId: selectedCall.id,
          callTitle:   selectedCall.title,
          callUrl:     selectedCall.url,
          skillId:     selectedSkill,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        handleAuthFailure(data);
        throw new Error(data.error || `Server error ${res.status}`);
      }
      setResult(data.reply || '');
    } catch (e) {
      setRunError(e.message || 'Skill run failed.');
    } finally {
      setRunning(false);
    }
  }, [selectedCall, selectedSkill, fathomToken, user]); // eslint-disable-line

  async function copyResult() {
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  }

  return (
    <div className="tf-wrap">
      {/* ── Controls: date range + scope + load ── */}
      <section className="tf-controls">
        <div className="tf-scope" role="tablist" aria-label="Call scope">
          <button className={scope === 'my' ? 'active' : ''}   onClick={() => setScope('my')}>My Calls</button>
          <button className={scope === 'team' ? 'active' : ''} onClick={() => setScope('team')}>Team Calls</button>
        </div>

        <div className="tf-presets">
          {PRESETS.map(p => (
            <button key={p.id} className="tf-chip" onClick={() => applyPreset(p)}>{p.label}</button>
          ))}
        </div>

        <label className="tf-field">
          <span>From</span>
          <input type="date" value={startDate} max={endDate} onChange={e => setStartDate(e.target.value)} />
        </label>
        <label className="tf-field">
          <span>To</span>
          <input type="date" value={endDate} min={startDate} onChange={e => setEndDate(e.target.value)} />
        </label>

        <button className="btn tf-load-btn" onClick={loadCalls} disabled={loadingCalls || !startDate || !endDate}>
          {loadingCalls ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Load calls'}
        </button>
      </section>

      {callsError && <p className="ba-input-error tf-toperr">⚠ {callsError}</p>}

      {/* ── Two-column working area ── */}
      <div className="tf-grid">
        {/* Left: call list */}
        <section className="tf-col tf-col-calls">
          <div className="tf-col-head">
            <span className="tf-col-title">{scope === 'team' ? 'Team calls' : 'My calls'}</span>
            {calls !== null && <span className="tf-count">{calls.length}</span>}
          </div>
          <div className="tf-col-body">
            {calls === null ? (
              <p className="tf-empty">Pick a range and press <strong>Load calls</strong>.</p>
            ) : calls.length === 0 ? (
              <p className="tf-empty">No calls found in this range. Try a wider range or switch scope.</p>
            ) : (
              <ul className="tf-call-list">
                {calls.map((c, i) => {
                  const active = selectedCall && selectedCall.id === c.id;
                  const sub = [prettyDate(c.date), scope === 'team' ? c.host : null, c.attendees?.slice(0, 3).join(', ')]
                    .filter(Boolean).join(' · ');
                  return (
                    <li key={c.id || i}>
                      <button
                        className={`tf-call${active ? ' active' : ''}`}
                        onClick={() => { setSelectedCall(c); setResult(''); setRunError(''); }}
                      >
                        <span className="tf-call-title">{c.title}</span>
                        {sub && <span className="tf-call-meta">{sub}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {/* Right: skill + result */}
        <section className="tf-col tf-col-output">
          <div className="tf-col-head tf-skill-head">
            <select
              className="tf-select"
              value={selectedSkill}
              onChange={e => setSelectedSkill(e.target.value)}
              disabled={!skills.length}
            >
              {skills.length === 0 && <option value="">No skills available</option>}
              {skills.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="btn" onClick={runSkill} disabled={running || !selectedSkill || !selectedCall}>
              {running ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Run skill'}
            </button>
            {result && (
              <button className="btn btn-ghost" onClick={copyResult}>{copied ? 'Copied ✓' : 'Copy'}</button>
            )}
          </div>
          <div className="tf-col-body">
            {runError && <p className="ba-input-error">⚠ {runError}</p>}
            {!selectedCall ? (
              <p className="tf-empty">Select a call, then run a skill on its transcript.</p>
            ) : running && !result ? (
              <RunningHint />
            ) : result ? (
              <ResultView
                parsed={parseSkillOutput(result)}
                rawResult={result}
                created={created}
                onCreate={task => setTaskModal({ task })}
              />
            ) : (
              <p className="tf-empty">
                Selected: <strong>{selectedCall.title}</strong>. Press <strong>Run skill</strong>.
              </p>
            )}
          </div>
        </section>
      </div>

      {taskModal && (
        <TaskCreateModal
          user={user}
          allowedProjects={allowedProjects}
          callTitle={selectedCall?.title}
          initialTitle={taskModal.task.title}
          initialDescription={buildTaskDescription(taskModal.task, selectedCall)}
          onClose={() => setTaskModal(null)}
          onCreated={res => setCreated(prev => ({ ...prev, [taskKey(taskModal.task)]: res }))}
        />
      )}
    </div>
  );
}

// Elapsed-time hint while a skill runs, so the UI doesn't look frozen.
function RunningHint() {
  const [s, setS] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setS(x => x + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const hint = s < 4 ? 'Reading the transcript…'
    : s < 12 ? 'Extracting tasks from the call…'
    : 'Almost there — large transcript, hang tight…';
  return <p className="tf-empty">{hint} <span style={{ opacity: 0.6 }}>{s}s</span></p>;
}

// Stable key for a parsed task (used to mark it "created").
function taskKey(task) {
  return `${task.n}::${task.title}`;
}

// Resolve a usable Fathom URL from a task's "Fathom Link" field (markdown link,
// bare URL, or "Not provided"), falling back to the selected call's URL.
function resolveFathomLink(task, call) {
  const v = task.link || '';
  const md = v.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/);
  if (md) return md[1];
  const u = v.match(/https?:\/\/\S+/);
  if (u) return u[0];
  return call?.url || '';
}

// Compose the task description that pre-fills the create form: the task body
// plus a Who / Priority / Fathom-link footer.
function buildTaskDescription(task, call) {
  const parts = [];
  if (task.description) parts.push(task.description.trim());
  const meta = [];
  if (task.who)      meta.push(`Who: ${task.who}`);
  if (task.priority) meta.push(`Priority: ${task.priority}`);
  const link = resolveFathomLink(task, call);
  if (link)          meta.push(`Fathom: ${link}`);
  if (meta.length) parts.push(meta.join('\n'));
  return parts.join('\n\n');
}

// ─── Result view: one block per task + Create Task ────────────────────────────
function ResultView({ parsed, rawResult, created, onCreate }) {
  if (!parsed.hasStructure) {
    // Non-conforming output (e.g. "No actionable tasks…") — show as-is.
    return <pre className="tf-result">{rawResult}</pre>;
  }
  return (
    <div className="tf-results">
      {parsed.analysis && <p className="tf-analysis">{parsed.analysis}</p>}

      {parsed.tasks.map((task, i) => {
        const key = taskKey(task);
        const done = created[key];
        return (
          <div className="tf-task" key={key + i}>
            <div className="tf-task-top">
              <span className="tf-task-n">Task #{task.n}</span>
              {task.priority && <span className={priorityClass(task.priority)}>{task.priority}</span>}
            </div>
            {task.title && <p className="tf-task-title">{task.title}</p>}
            {task.description && <p className="tf-task-desc">{task.description}</p>}
            <div className="tf-task-meta">
              {task.who && <span><strong>Who:</strong> {task.who}</span>}
              {task.link && <span><strong>Fathom:</strong> <FathomLinkValue value={task.link} /></span>}
            </div>
            <div className="tf-task-actions">
              {done ? (
                <span className="tf-task-created">
                  Created ✓
                  {done.jiraKey && done.jiraUrl && (
                    <> · <a className="ba-issue-link" href={done.jiraUrl} target="_blank" rel="noreferrer">{done.jiraKey} ↗</a></>
                  )}
                  {done.epicUrl && (
                    <> · <a className="ba-issue-link" href={done.epicUrl} target="_blank" rel="noreferrer">Azure ↗</a></>
                  )}
                </span>
              ) : (
                <button className="btn btn-primary tf-create-btn" onClick={() => onCreate(task)}>Create Task ↗</button>
              )}
            </div>
          </div>
        );
      })}

      {(parsed.urgent || parsed.backlog) && (
        <div className="tf-summaries">
          {parsed.urgent && (
            <div className="tf-summary">
              <p className="tf-summary-title">Urgent Items</p>
              <pre className="tf-summary-body">{parsed.urgent}</pre>
            </div>
          )}
          {parsed.backlog && (
            <div className="tf-summary">
              <p className="tf-summary-title">Backlog Recommendations</p>
              <pre className="tf-summary-body">{parsed.backlog}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
