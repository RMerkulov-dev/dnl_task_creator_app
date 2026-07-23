import { useState, useEffect, useMemo, useCallback } from 'react';

// Quarterly Calls — private calendar of management calls with customers.
// Views: Day / Week / Month / 3 Months / Year. Projects are user-defined
// (name + color) and the backend emails a reminder one week before each
// scheduled call.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const DOWS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const VIEWS = [
  { id: 'day',     label: 'Day' },
  { id: 'week',    label: 'Week' },
  { id: 'month',   label: 'Month' },
  { id: 'quarter', label: '3 Months' },
  { id: 'year',    label: 'Year' },
];

const PROJECT_COLORS = ['#34D399', '#00E5FF', '#A78BFA', '#F472B6', '#FBBF24',
  '#FB923C', '#60A5FA', '#F87171', '#A3E635', '#2DD4BF'];

const pad = n => String(n).padStart(2, '0');
const toIso = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fromIso = iso => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const addDays = (iso, n) => {
  const d = fromIso(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
const addMonths = (iso, n) => {
  const d = fromIso(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
};
const mondayOf = iso => {
  const d = fromIso(iso);
  return addDays(iso, -((d.getUTCDay() + 6) % 7));
};

function daysBetween(fromStr, toStr) {
  return Math.round((fromIso(toStr) - fromIso(fromStr)) / 86_400_000);
}

function formatIso(iso, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(fromIso(iso));
}

// Month grid cells, Monday-first, with leading/trailing days of adjacent months.
function buildMonthCells(y, m) {
  const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7;
  const out = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(Date.UTC(y, m, 1 - lead + i));
    out.push({ iso: toIso(d), day: d.getUTCDate(), outside: d.getUTCMonth() !== m });
  }
  return out[35].outside ? out.slice(0, 35) : out; // drop a fully-outside trailing week
}

const EMPTY_FORM = {
  title: '', project: '', date: '', time: '', participants: '',
  summaryLink: '', miroLink: '', notes: '', status: 'scheduled',
};

function useEscape(onClose) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function CallModal({ initial, projects, onSave, onDelete, onClose, saving }) {
  const isEdit = Boolean(initial.id);
  const [form, setForm] = useState({
    ...EMPTY_FORM, project: projects[0]?.id || '', ...initial,
  });
  const [error, setError] = useState('');
  const set = (key, value) => setForm(f => ({ ...f, [key]: value }));
  useEscape(onClose);

  const submit = async e => {
    e.preventDefault();
    if (!form.title.trim()) return setError('Title is required');
    if (!form.date) return setError('Date is required');
    setError('');
    try { await onSave(form); }
    catch (err) { setError(err.message); }
  };

  return (
    <div className="rel-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rel-modal qcal-modal">
        <div className="rel-modal-head">
          <div>
            <h3 className="rel-modal-title">{isEdit ? 'Edit call' : 'New call'}</h3>
            {isEdit && (
              <p className="rel-modal-sub">
                {initial.reminderSentAt
                  ? `Reminder emailed ${new Date(initial.reminderSentAt).toLocaleDateString('en-GB')}`
                  : 'Reminder will be emailed a week before the call (13:00 Kyiv)'}
              </p>
            )}
          </div>
          <div className="rel-modal-tools">
            <button className="rel-modal-close" onClick={onClose} title="Close">✕</button>
          </div>
        </div>
        <form className="rel-modal-body qcal-form" onSubmit={submit}>
          <label className="qcal-field qcal-field-wide">
            <span>Title</span>
            <input className="input" value={form.title} onChange={e => set('title', e.target.value)}
                   placeholder="e.g. ABS. Quarterly Call" autoFocus />
          </label>
          <label className="qcal-field">
            <span>Project</span>
            <select className="select" value={form.project} onChange={e => set('project', e.target.value)}>
              {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="qcal-field">
            <span>Status</span>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="scheduled">Scheduled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="qcal-field">
            <span>Date</span>
            <input className="input" type="date" value={form.date} onChange={e => set('date', e.target.value)} />
          </label>
          <label className="qcal-field">
            <span>Time (Kyiv)</span>
            <input className="input" type="time" value={form.time} onChange={e => set('time', e.target.value)} />
          </label>
          <label className="qcal-field qcal-field-wide">
            <span>Participants</span>
            <input className="input" value={form.participants} onChange={e => set('participants', e.target.value)}
                   placeholder="Who is on the call" />
          </label>
          <label className="qcal-field qcal-field-wide">
            <span>Miro / arrangements link</span>
            <input className="input" value={form.miroLink} onChange={e => set('miroLink', e.target.value)}
                   placeholder="https://miro.com/…" />
          </label>
          <label className="qcal-field qcal-field-wide">
            <span>Call summary link</span>
            <input className="input" value={form.summaryLink} onChange={e => set('summaryLink', e.target.value)}
                   placeholder="https://fathom.video/…" />
          </label>
          <label className="qcal-field qcal-field-wide">
            <span>Notes</span>
            <textarea className="input qcal-notes" rows={3} value={form.notes}
                      onChange={e => set('notes', e.target.value)} />
          </label>

          {error && <div className="qcal-form-error">{error}</div>}

          <div className="qcal-form-actions">
            {isEdit && (
              <button type="button" className="btn btn-danger" disabled={saving}
                      onClick={() => onDelete(initial.id)}>Delete</button>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : (isEdit ? 'Save' : 'Add call')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ProjectModal({ projects, callCounts, onCreate, onDeleteProject, onClose }) {
  const [label, setLabel] = useState('');
  const [color, setColor] = useState(PROJECT_COLORS[projects.length % PROJECT_COLORS.length]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEscape(onClose);

  const submit = async e => {
    e.preventDefault();
    if (!label.trim()) return setError('Project name is required');
    setError('');
    setBusy(true);
    try { await onCreate({ label: label.trim(), color }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="rel-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="rel-modal qcal-modal qcal-proj-modal">
        <div className="rel-modal-head">
          <div>
            <h3 className="rel-modal-title">Projects</h3>
            <p className="rel-modal-sub">Add a project to plan its calls on the calendar</p>
          </div>
          <div className="rel-modal-tools">
            <button className="rel-modal-close" onClick={onClose} title="Close">✕</button>
          </div>
        </div>
        <div className="rel-modal-body">
          <form className="qcal-proj-form" onSubmit={submit}>
            <input className="input" value={label} onChange={e => setLabel(e.target.value)}
                   placeholder="New project name" autoFocus />
            <div className="qcal-swatches">
              {PROJECT_COLORS.map(c => (
                <button key={c} type="button"
                        className={`qcal-swatch${color === c ? ' active' : ''}`}
                        style={{ background: c }}
                        onClick={() => setColor(c)}
                        title={c} />
              ))}
            </div>
            {error && <div className="qcal-form-error">{error}</div>}
            <div className="qcal-form-actions">
              <div style={{ flex: 1 }} />
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Adding…' : 'Add project'}
              </button>
            </div>
          </form>

          <div className="qcal-proj-list">
            {projects.map(p => (
              <div key={p.id} className="qcal-proj-row">
                <span className="qcal-up-dot" style={{ '--qcal-c': p.color }} />
                <span className="qcal-proj-name">{p.label}</span>
                <span className="qcal-proj-count">
                  {callCounts[p.id] ? `${callCounts[p.id]} call${callCounts[p.id] === 1 ? '' : 's'}` : 'no calls'}
                </span>
                <button type="button" className="qcal-proj-del"
                        title={callCounts[p.id] ? 'Delete or move its calls first' : 'Delete project'}
                        disabled={Boolean(callCounts[p.id])}
                        onClick={() => onDeleteProject(p.id)}>✕</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EventChip({ call, colorOf, onOpen }) {
  return (
    <button className={`qcal-ev qcal-ev-${call.status}`}
            style={{ '--qcal-c': colorOf(call.project) }}
            onClick={() => onOpen(call)}
            title={`${call.title}${call.time ? ` — ${call.time} Kyiv` : ''}`}>
      {call.time && <span className="qcal-ev-time">{call.time}</span>}
      <span className="qcal-ev-title">{call.title}</span>
    </button>
  );
}

function DayCell({ cell, today, byDate, colorOf, onOpen, onAdd }) {
  return (
    <div className={`qcal-cell${cell.outside ? ' outside' : ''}${cell.iso === today ? ' today' : ''}`}>
      <div className="qcal-cell-head">
        <button className="qcal-cell-add" title="Add call on this day" onClick={() => onAdd(cell.iso)}>+</button>
        <span className="qcal-daynum">{cell.day}</span>
      </div>
      {(byDate.get(cell.iso) || []).map(call => (
        <EventChip key={call.id} call={call} colorOf={colorOf} onOpen={onOpen} />
      ))}
    </div>
  );
}

// One month as a full grid — used by Month view and (compact) 3-months view.
function MonthGrid({ y, m, caption, compact, today, byDate, colorOf, onOpen, onAdd }) {
  const cells = useMemo(() => buildMonthCells(y, m), [y, m]);
  return (
    <div className={`qcal-cal${compact ? ' qcal-compact' : ''}`}>
      {caption && <div className="qcal-cal-caption">{caption}</div>}
      <div className="qcal-dows">{DOWS.map(d => <div key={d} className="qcal-dow">{d}</div>)}</div>
      <div className="qcal-grid">
        {cells.map(cell => (
          <DayCell key={cell.iso} cell={cell} today={today} byDate={byDate}
                   colorOf={colorOf} onOpen={onOpen} onAdd={onAdd} />
        ))}
      </div>
    </div>
  );
}

// Year view: 12 mini-months, calls shown as colored dots; a day click opens Day view.
function MiniMonth({ y, m, today, byDate, colorOf, onPickDay }) {
  const cells = useMemo(() => buildMonthCells(y, m), [y, m]);
  return (
    <div className="qcal-mini">
      <div className="qcal-mini-name">{MONTHS[m]}</div>
      <div className="qcal-mini-grid">
        {DOWS.map(d => <div key={d} className="qcal-mini-dow">{d[0]}</div>)}
        {cells.map(cell => {
          const dayCalls = cell.outside ? [] : (byDate.get(cell.iso) || []);
          return (
            <button key={cell.iso}
                    className={`qcal-mini-day${cell.outside ? ' outside' : ''}${cell.iso === today ? ' today' : ''}${dayCalls.length ? ' has-calls' : ''}`}
                    style={dayCalls.length ? { '--qcal-c': colorOf(dayCalls[0].project) } : undefined}
                    onClick={() => onPickDay(cell.iso)}
                    title={dayCalls.map(c => c.title).join('\n') || undefined}>
              <span className="qcal-mini-num">{cell.day}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DayView({ iso, today, byDate, colorOf, projectLabel, onOpen, onAdd }) {
  const list = byDate.get(iso) || [];
  return (
    <div className="qcal-dayview qcal-cal">
      {list.length === 0 && (
        <p className="qcal-side-empty">No calls on {formatIso(iso)}.</p>
      )}
      {list.map(call => (
        <button key={call.id} className={`qcal-day-row qcal-ev-${call.status}`}
                style={{ '--qcal-c': colorOf(call.project) }}
                onClick={() => onOpen(call)}>
          <span className="qcal-day-time">{call.time || '—'}</span>
          <span className="qcal-day-main">
            <span className="qcal-day-title">{call.title}</span>
            <span className="qcal-day-sub">
              {projectLabel(call.project)}
              {call.participants ? ` · ${call.participants}` : ''}
              {call.status !== 'scheduled' ? ` · ${call.status}` : ''}
            </span>
          </span>
          {call.reminderSentAt && <span className="qcal-up-mail" title="Reminder emailed">✉</span>}
        </button>
      ))}
      <div>
        <button className="btn btn-ghost qcal-add-btn" onClick={() => onAdd(iso)}>+ Add call on this day</button>
      </div>
    </div>
  );
}

export default function QuarterlyCallsApp() {
  const now = new Date();
  const initialToday = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const [calls, setCalls] = useState([]);
  const [projects, setProjects] = useState([]);
  const [today, setToday] = useState(initialToday);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [view, setView] = useState('month');
  const [anchor, setAnchor] = useState(initialToday);
  const [filter, setFilter] = useState('ALL');
  const [modal, setModal] = useState(null);        // call form values | null
  const [projModal, setProjModal] = useState(false);
  const [saving, setSaving] = useState(false);

  const projectById = useMemo(() => Object.fromEntries(projects.map(p => [p.id, p])), [projects]);
  const colorOf = useCallback(id => projectById[id]?.color || 'var(--text-3)', [projectById]);
  const labelOf = useCallback(id => projectById[id]?.label || id, [projectById]);

  const reload = useCallback(async () => {
    const res = await fetch('/api/quarterly-calls');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const data = await res.json();
    setCalls(data.calls || []);
    setProjects(data.projects || []);
    if (data.today) { setToday(data.today); setAnchor(a => a === initialToday ? data.today : a); }
  }, [initialToday]);

  useEffect(() => {
    (async () => {
      try {
        await reload();
        setLoadError('');
      } catch (err) {
        setLoadError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [reload]);

  const visible = useMemo(
    () => (filter === 'ALL' ? calls : calls.filter(c => c.project === filter)),
    [calls, filter],
  );

  const byDate = useMemo(() => {
    const map = new Map();
    for (const c of visible) {
      if (!map.has(c.date)) map.set(c.date, []);
      map.get(c.date).push(c);
    }
    for (const list of map.values()) list.sort((a, b) => (a.time || '99') < (b.time || '99') ? -1 : 1);
    return map;
  }, [visible]);

  const upcoming = useMemo(() =>
    visible
      .filter(c => c.status === 'scheduled' && daysBetween(today, c.date) >= 0)
      .sort((a, b) => a.date === b.date ? (a.time || '') < (b.time || '') ? -1 : 1 : a.date < b.date ? -1 : 1)
      .slice(0, 12),
  [visible, today]);

  const callCounts = useMemo(() => {
    const counts = {};
    for (const c of calls) counts[c.project] = (counts[c.project] || 0) + 1;
    return counts;
  }, [calls]);

  const anchorDate = fromIso(anchor);
  const aY = anchorDate.getUTCFullYear();
  const aM = anchorDate.getUTCMonth();

  const move = dir => setAnchor(a => {
    switch (view) {
      case 'day':     return addDays(a, dir);
      case 'week':    return addDays(a, dir * 7);
      case 'month':   return addMonths(a, dir);
      case 'quarter': return addMonths(a, dir * 3);
      case 'year':    return addMonths(a, dir * 12);
      default:        return a;
    }
  });

  const title = useMemo(() => {
    switch (view) {
      case 'day':   return formatIso(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      case 'week': {
        const mon = mondayOf(anchor), sun = addDays(mon, 6);
        return `${formatIso(mon, { day: 'numeric', month: 'short' })} – ${formatIso(sun, { day: 'numeric', month: 'short', year: 'numeric' })}`;
      }
      case 'month': return `${MONTHS[aM]} ${aY}`;
      case 'quarter': {
        const end = fromIso(addMonths(anchor, 2));
        const eY = end.getUTCFullYear(), eM = end.getUTCMonth();
        return aY === eY
          ? `${MONTHS[aM].slice(0, 3)} – ${MONTHS[eM].slice(0, 3)} ${aY}`
          : `${MONTHS[aM].slice(0, 3)} ${aY} – ${MONTHS[eM].slice(0, 3)} ${eY}`;
      }
      case 'year':  return String(aY);
      default:      return '';
    }
  }, [view, anchor, aY, aM]);

  const weekCells = useMemo(() => {
    const mon = mondayOf(anchor);
    return Array.from({ length: 7 }, (_, i) => {
      const iso = addDays(mon, i);
      return { iso, day: fromIso(iso).getUTCDate(), outside: false };
    });
  }, [anchor]);

  const openAdd = iso => setModal({ date: iso });
  const openCall = call => setModal(call);
  const pickDay = iso => { setAnchor(iso); setView('day'); };

  const api = async (url, options) => {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  };

  const saveCall = async form => {
    setSaving(true);
    try {
      const isEdit = Boolean(form.id);
      const data = await api(isEdit ? `/api/quarterly-calls/${form.id}` : '/api/quarterly-calls', {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      setCalls(prev => isEdit
        ? prev.map(c => (c.id === data.call.id ? data.call : c))
        : [...prev, data.call]);
      setModal(null);
    } finally {
      setSaving(false);
    }
  };

  const deleteCall = async id => {
    if (!window.confirm('Delete this call?')) return;
    setSaving(true);
    try {
      await api(`/api/quarterly-calls/${id}`, { method: 'DELETE' });
      setCalls(prev => prev.filter(c => c.id !== id));
      setModal(null);
    } catch (err) {
      window.alert(`Delete failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const createProject = async ({ label, color }) => {
    const data = await api('/api/quarterly-calls/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, color }),
    });
    setProjects(prev => [...prev, data.project]);
    setProjModal(false);
    // Jump straight into planning the first call of the new project.
    setModal({ date: today, project: data.project.id });
  };

  const deleteProject = async id => {
    if (!window.confirm('Delete this project?')) return;
    try {
      await api(`/api/quarterly-calls/projects/${id}`, { method: 'DELETE' });
      setProjects(prev => prev.filter(p => p.id !== id));
      if (filter === id) setFilter('ALL');
    } catch (err) {
      window.alert(`Delete failed: ${err.message}`);
    }
  };

  if (loading) {
    return <div className="platform-app-loader"><div className="spinner spinner-lg" /></div>;
  }

  return (
    <div className="qcal-app">
      <div className="qcal-toolbar">
        <div className="qcal-month-nav">
          <button className="btn btn-ghost qcal-nav-btn" onClick={() => move(-1)} title="Previous">‹</button>
          <button className="btn btn-ghost" onClick={() => setAnchor(today)}>Today</button>
          <button className="btn btn-ghost qcal-nav-btn" onClick={() => move(1)} title="Next">›</button>
          <h2 className="qcal-month-title">{title}</h2>
        </div>
        <div className="qcal-views" role="group" aria-label="Calendar view">
          {VIEWS.map(v => (
            <button key={v.id}
                    className={`qcal-view-btn${view === v.id ? ' active' : ''}`}
                    onClick={() => setView(v.id)}>{v.label}</button>
          ))}
        </div>
        <div className="qcal-filters">
          <button className={`qcal-filter-chip${filter === 'ALL' ? ' active' : ''}`}
                  onClick={() => setFilter('ALL')}>All</button>
          {projects.map(p => (
            <button key={p.id}
                    className={`qcal-filter-chip${filter === p.id ? ' active' : ''}`}
                    style={{ '--qcal-c': p.color }}
                    onClick={() => setFilter(p.id)}>{p.label}</button>
          ))}
          <button className="qcal-filter-chip qcal-chip-add" title="Add / manage projects"
                  onClick={() => setProjModal(true)}>+ Project</button>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost qcal-add-btn" onClick={() => openAdd(today)}>+ Add call</button>
      </div>

      {loadError && <div className="qcal-load-error">Failed to load calls: {loadError}</div>}

      <div className="qcal-layout">
        <div className="qcal-main">
          {view === 'day' && (
            <DayView iso={anchor} today={today} byDate={byDate} colorOf={colorOf}
                     projectLabel={labelOf} onOpen={openCall} onAdd={openAdd} />
          )}

          {view === 'week' && (
            <div className="qcal-cal qcal-weekview">
              <div className="qcal-dows">{DOWS.map(d => <div key={d} className="qcal-dow">{d}</div>)}</div>
              <div className="qcal-grid qcal-grid-week">
                {weekCells.map(cell => (
                  <DayCell key={cell.iso} cell={cell} today={today} byDate={byDate}
                           colorOf={colorOf} onOpen={openCall} onAdd={openAdd} />
                ))}
              </div>
            </div>
          )}

          {view === 'month' && (
            <MonthGrid y={aY} m={aM} today={today} byDate={byDate}
                       colorOf={colorOf} onOpen={openCall} onAdd={openAdd} />
          )}

          {view === 'quarter' && (
            <div className="qcal-quarter">
              {[0, 1, 2].map(off => {
                const d = fromIso(addMonths(anchor, off));
                return (
                  <MonthGrid key={off} y={d.getUTCFullYear()} m={d.getUTCMonth()}
                             caption={`${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`}
                             compact today={today} byDate={byDate}
                             colorOf={colorOf} onOpen={openCall} onAdd={openAdd} />
                );
              })}
            </div>
          )}

          {view === 'year' && (
            <div className="qcal-year">
              {Array.from({ length: 12 }, (_, m) => (
                <MiniMonth key={m} y={aY} m={m} today={today} byDate={byDate}
                           colorOf={colorOf} onPickDay={pickDay} />
              ))}
            </div>
          )}
        </div>

        <aside className="qcal-side">
          <h3 className="qcal-side-title">Upcoming</h3>
          {upcoming.length === 0 && <p className="qcal-side-empty">No scheduled calls ahead.</p>}
          {upcoming.map(call => {
            const d = daysBetween(today, call.date);
            return (
              <button key={call.id} className="qcal-up" onClick={() => openCall(call)}>
                <span className="qcal-up-dot" style={{ '--qcal-c': colorOf(call.project) }} />
                <span className="qcal-up-main">
                  <span className="qcal-up-title">{call.title}</span>
                  <span className="qcal-up-when">
                    {formatIso(call.date)}{call.time ? `, ${call.time}` : ''}
                    {call.participants ? ` · ${call.participants}` : ''}
                  </span>
                </span>
                <span className="qcal-up-meta">
                  <span className="qcal-up-days">{d === 0 ? 'today' : `in ${d}d`}</span>
                  {call.reminderSentAt && <span className="qcal-up-mail" title="Reminder emailed">✉</span>}
                </span>
              </button>
            );
          })}
          <p className="qcal-side-note">
            {projects.map(p => (
              <span key={p.id} className="qcal-legend-item">
                <span className="qcal-up-dot" style={{ '--qcal-c': p.color }} />{p.label}
              </span>
            ))}
          </p>
          <p className="qcal-side-note">An email reminder is sent one week before each scheduled call, at 13:00 Kyiv.</p>
        </aside>
      </div>

      {modal && (
        <CallModal
          initial={modal}
          projects={projects}
          saving={saving}
          onSave={saveCall}
          onDelete={deleteCall}
          onClose={() => setModal(null)}
        />
      )}
      {projModal && (
        <ProjectModal
          projects={projects}
          callCounts={callCounts}
          onCreate={createProject}
          onDeleteProject={deleteProject}
          onClose={() => setProjModal(false)}
        />
      )}
    </div>
  );
}
