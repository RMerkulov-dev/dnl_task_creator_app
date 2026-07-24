import { useState, useEffect, useMemo, useCallback } from 'react';

// ─── Checklist ────────────────────────────────────────────────────────────────
// Weekly recurring TODO plan, one column per weekday (Mon..Sun). Belled tasks
// are collected into a daily "MONDAY: TODO Checklist" digest email sent to the
// signed-in user at 11:00 Kyiv. Storage is per-user server-side
// (api/checklist.js) — every user has their own list. The done checkbox is a
// purely personal mark: it stamps doneOn = today and is shown only while
// doneOn == today, so it clears itself once the day passes; it affects nothing.

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// Date (YYYY-MM-DD) of weekday `i` (0=Mon) in the week containing `today`,
// where `weekday` is today's index. Pure string/date math, no timezones —
// `today` already comes from the server in Kyiv.
function weekDate(today, weekday, i) {
  const [y, m, d] = today.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + (i - weekday)));
  return dt.toISOString().slice(0, 10);
}

function prettyDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)));
}

function BellIcon({ off }) {
  return off ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8.6 8.6A6 6 0 0 1 18 12v3l1.5 2.5H9M6 12v3l-1.5 2.5H10" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M10 20a2 2 0 0 0 4 0M4 4l16 16" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 12a6 6 0 1 1 12 0v3l1.5 2.5h-15L6 15v-3z" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/>
    </svg>
  );
}

// One task row: view mode (checkbox, text, bell, delete) or edit mode
// (text input, bell toggle, save/delete).
function TaskRow({ task, today, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [text,    setText]    = useState(task.text);
  const [notify,  setNotify]  = useState(task.notify);
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (!editing) { setText(task.text); setNotify(task.notify); }
  }, [task, editing]);

  // Personal mark that clears itself once the day passes.
  const done = task.doneOn === today;

  async function run(patch, closeEdit = false) {
    setBusy(true); setError('');
    try {
      await onSave(task, patch);
      if (closeEdit) setEditing(false);
    } catch (e) { setError(e.message || 'Save failed'); }
    finally { setBusy(false); }
  }

  if (editing) {
    return (
      <div className="chk-task chk-task-edit">
        <input
          className="input chk-edit-text"
          value={text}
          disabled={busy}
          autoFocus
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && text.trim()) run({ text: text.trim(), notify }, true); if (e.key === 'Escape') setEditing(false); }}
        />
        <div className="chk-edit-row">
          <button
            type="button"
            className={`chk-bell${notify ? ' on' : ''}`}
            title={notify ? 'Email notification on — click to disable' : 'Email notification off — click to enable'}
            onClick={() => setNotify(n => !n)}
            disabled={busy}
          >
            <BellIcon off={!notify} />
          </button>
          <span className="chk-edit-spacer" />
          <button className="btn btn-danger chk-mini-btn" onClick={() => { if (confirm('Delete this task?')) onDelete(task); }} disabled={busy}>Delete</button>
          <button className="btn btn-ghost chk-mini-btn" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
          <button className="btn btn-primary chk-mini-btn" onClick={() => run({ text: text.trim(), notify }, true)} disabled={busy || !text.trim()}>
            {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Save'}
          </button>
        </div>
        {error && <p className="chk-err">⚠ {error}</p>}
      </div>
    );
  }

  return (
    <div className={`chk-task${done ? ' chk-done' : ''}`}>
      <input
        type="checkbox"
        className="chk-check"
        checked={done}
        disabled={busy}
        title={done ? 'Done — uncheck' : 'Mark done for today (clears tomorrow)'}
        onChange={() => run({ doneOn: done ? null : today })}
      />
      <button type="button" className="chk-text" onClick={() => setEditing(true)} title="Edit task">
        {task.text}
      </button>
      <button
        type="button"
        className={`chk-bell${task.notify ? ' on' : ''}`}
        title={task.notify ? 'In the daily email — click to exclude' : 'Not emailed — click to include'}
        disabled={busy}
        onClick={() => run({ notify: !task.notify })}
      >
        <BellIcon off={!task.notify} />
      </button>
      <button
        type="button"
        className="chk-del"
        title="Delete task"
        disabled={busy}
        onClick={() => { if (confirm('Delete this task?')) onDelete(task); }}
      >✕</button>
      {error && <p className="chk-err">⚠ {error}</p>}
    </div>
  );
}

// "+ Add task" composer at the bottom of a day column.
function AddTask({ day, onAdd }) {
  const [open, setOpen]     = useState(false);
  const [text, setText]     = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');

  async function submit() {
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      await onAdd({ day, text: text.trim(), notify });
      setText('');
      setOpen(false);
    } catch (e) { setError(e.message || 'Add failed'); }
    finally { setBusy(false); }
  }

  if (!open) {
    return <button type="button" className="chk-add-btn" onClick={() => setOpen(true)}>+ Add task</button>;
  }
  return (
    <div className="chk-task chk-task-edit">
      <input
        className="input chk-edit-text"
        placeholder="Task…"
        value={text}
        autoFocus
        disabled={busy}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); }}
      />
      <div className="chk-edit-row">
        <button
          type="button"
          className={`chk-bell${notify ? ' on' : ''}`}
          title={notify ? 'Included in the daily email' : 'Not emailed'}
          onClick={() => setNotify(n => !n)}
          disabled={busy}
        >
          <BellIcon off={!notify} />
        </button>
        <span className="chk-edit-spacer" />
        <button className="btn btn-ghost chk-mini-btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
        <button className="btn btn-primary chk-mini-btn" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? <span className="spinner" style={{ width: 12, height: 12 }} /> : 'Add'}
        </button>
      </div>
      {error && <p className="chk-err">⚠ {error}</p>}
    </div>
  );
}

export default function ChecklistApp() {
  const [tasks,   setTasks]   = useState(null);   // null = loading
  const [today,   setToday]   = useState('');
  const [weekday, setWeekday] = useState(0);
  const [error,   setError]   = useState('');
  const [sendMsg, setSendMsg] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/checklist')
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `Server error ${r.status}`);
        return data;
      })
      .then(d => {
        if (cancelled) return;
        setTasks(d.tasks ?? []);
        setToday(d.today);
        setWeekday(d.weekday ?? 0);
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load the checklist.'); });
    return () => { cancelled = true; };
  }, []);

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    return data;
  }

  const addTask = useCallback(async (draft) => {
    const { task } = await api('POST', '/api/checklist/tasks', draft);
    setTasks(prev => [...(prev ?? []), task]);
  }, []);

  const saveTask = useCallback(async (task, patch) => {
    const { task: updated } = await api('PUT', `/api/checklist/tasks/${task.id}`, patch);
    setTasks(prev => (prev ?? []).map(t => (t.id === task.id ? updated : t)));
  }, []);

  const deleteTask = useCallback(async (task) => {
    await api('DELETE', `/api/checklist/tasks/${task.id}`);
    setTasks(prev => (prev ?? []).filter(t => t.id !== task.id));
  }, []);

  async function sendNow() {
    setSending(true); setSendMsg('');
    try {
      const r = await api('POST', '/api/checklist/send-now');
      setSendMsg(r.sent ? `Sent ✓ (${r.tasks} task${r.tasks === 1 ? '' : 's'})` : (r.reason || 'Nothing to send'));
    } catch (e) { setSendMsg(`⚠ ${e.message}`); }
    finally {
      setSending(false);
      setTimeout(() => setSendMsg(''), 4000);
    }
  }

  const byDay = useMemo(() => {
    const map = Array.from({ length: 7 }, () => []);
    for (const t of tasks ?? []) {
      if (t.day >= 0 && t.day <= 6) map[t.day].push(t);
    }
    for (const list of map) {
      list.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }
    return map;
  }, [tasks]);

  return (
    <div className="chk-wrap">
      <div className="chk-head">
        <div>
          <h2 className="chk-title">Checklist</h2>
          <p className="chk-sub">
            Weekly TODO plan. Tasks with the bell are emailed to you daily at 11:00 (Kyiv) — subject “MONDAY: TODO Checklist”. The done mark is just for you and clears itself the next day.
          </p>
        </div>
        <div className="chk-head-actions">
          {sendMsg && <span className="chk-send-msg">{sendMsg}</span>}
          <button className="btn btn-ghost" onClick={sendNow} disabled={sending || !tasks}>
            {sending ? <span className="spinner" style={{ width: 14, height: 14 }} /> : "Send today's digest now"}
          </button>
        </div>
      </div>

      {error && <p className="chk-err chk-toperr">⚠ {error}</p>}

      {tasks === null && !error ? (
        <div className="chk-loading"><span className="spinner spinner-lg" /></div>
      ) : (
        <div className="chk-grid">
          {DAY_NAMES.map((name, i) => {
            const date = today ? weekDate(today, weekday, i) : '';
            const isToday = i === weekday;
            return (
              <section key={name} className={`chk-col${isToday ? ' chk-today' : ''}`}>
                <div className="chk-col-head">
                  <span className="chk-col-day">{name}</span>
                  <span className="chk-col-date">{date ? prettyDay(date) : ''}{isToday ? ' · today' : ''}</span>
                </div>
                <div className="chk-col-body">
                  {byDay[i].map(t => (
                    <TaskRow key={t.id} task={t} today={today} onSave={saveTask} onDelete={deleteTask} />
                  ))}
                  <AddTask day={i} onAdd={addTask} />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
