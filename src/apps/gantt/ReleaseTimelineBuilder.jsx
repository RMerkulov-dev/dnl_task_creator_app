import { useEffect, useRef, useState } from 'react';
import {
  TZ_PRESETS, GATE_TAGS,
  uid, hToTime, timeToH, fmtInTz, tzTitle, findTz,
  makePerson, makeItem, makeRow, makeDay,
  emptyConfig, sampleConfig, isValidConfig, loadStoredConfig, storeConfig,
} from './ganttModel.js';

// ---------------------------------------------------------------- preview ---

function DayChart({ cfg, day, displayTz, onEditItem }) {
  const scheduleTz = findTz(cfg, cfg.scheduleTz);
  const span = Math.max(cfg.dayEnd - cfg.dayStart, 0.5);
  const pct = h => ((h - cfg.dayStart) / span) * 100;

  const ticks = [];
  for (let h = Math.ceil(cfg.dayStart); h <= Math.floor(cfg.dayEnd); h++) ticks.push(h);
  if (cfg.dayEnd % 1 !== 0) ticks.push(cfg.dayEnd);

  const fmt = h => fmtInTz(h, scheduleTz.offset, displayTz.offset);

  return (
    <section className="gantt-day">
      <div className="gantt-day-head">
        {day.idx && <span className="gantt-day-index">{day.idx}</span>}
        <span className="gantt-day-date">{day.date}</span>
        {day.sub && <span className="gantt-day-sub">{day.sub}</span>}
      </div>
      <div className="gantt-scroll">
        <div className="gantt-chart">
          {cfg.timezones.map(tz => (
            <div key={tz.id} className={`gantt-axis-row${tz.id === displayTz.id ? ' active' : ''}`}>
              <div className="gantt-axis-tz">
                <span className="gantt-axis-tz-name">{tz.label}</span>
                <span className="gantt-axis-tz-off">{tzTitle(tz)}</span>
              </div>
              <div className="gantt-axis-track">
                {ticks.map(h => (
                  <span key={h} className="gantt-tick" style={{ left: pct(h) + '%' }}>
                    {fmtInTz(h, scheduleTz.offset, tz.offset)}
                  </span>
                ))}
              </div>
            </div>
          ))}

          {day.rows.map(row => {
            const person = cfg.people.find(p => p.id === row.personId);
            if (!person) return null;
            return (
              <div
                key={row.id}
                className={`gantt-row${row.gate ? ' gate' : ''}`}
                style={{ '--rc': person.color }}
              >
                <div className="gantt-rname">
                  <span className="gantt-swatch" />
                  <div>
                    <span className="gantt-nm">{person.name}</span>
                    {person.role && <span className="gantt-rl">{person.role}</span>}
                  </div>
                </div>
                <div className="gantt-track">
                  {ticks.filter(h => h > cfg.dayStart && h < cfg.dayEnd).map(h => (
                    <span key={h} className="gantt-gl" style={{ left: pct(h) + '%' }} />
                  ))}
                  {row.items.map(it => {
                    if (it.kind === 'point') {
                      if (it.s < cfg.dayStart || it.s > cfg.dayEnd) return null;
                      const flip = pct(it.s) > 62;
                      return (
                        <div
                          key={it.id}
                          className={`gantt-point clickable${flip ? ' flip' : ''}${it.risk ? ' risk' : ''}`}
                          style={{ left: pct(it.s) + '%' }}
                          title="Click to edit"
                          onClick={() => onEditItem(day.id, row.id, it.id)}
                        >
                          <span className="gantt-dot" />
                          <span className="gantt-plabel">{it.risk ? '⚠ ' : ''}{fmt(it.s)} · {it.label}</span>
                        </div>
                      );
                    }
                    const s = Math.max(it.s, cfg.dayStart);
                    const e = Math.min(it.e, cfg.dayEnd);
                    if (e <= s) return null;
                    return (
                      <div
                        key={it.id}
                        className={`gantt-bar clickable${it.external ? ' external' : ''}${it.risk ? ' risk' : ''}`}
                        style={{ left: pct(s) + '%', width: (pct(e) - pct(s)) + '%' }}
                        title="Click to edit"
                        onClick={() => onEditItem(day.id, row.id, it.id)}
                      >
                        <span className="gantt-lbl">{it.risk ? '⚠ ' : ''}{it.label}</span>
                        <span className="gantt-dur">{fmt(it.s)}–{fmt(it.e)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {day.standby && (
        <div className="gantt-standby"><b>Standby</b><span>{day.standby}</span></div>
      )}
    </section>
  );
}

function Preview({ cfg, onPickDisplayTz, onEditItem }) {
  const displayTz = findTz(cfg, cfg.displayTz);
  // Show every defined resource in the legend so adding one is reflected
  // immediately, even before it has any tasks on the timeline.
  const legend = cfg.people;
  const hasRisk = cfg.days.some(d => d.rows.some(r => r.items.some(it => it.risk)));

  return (
    <div className="gantt-doc" id="gantt-print-area">
      <header className="gantt-masthead">
        {cfg.eyebrow && <p className="gantt-eyebrow">{cfg.eyebrow}</p>}
        <h1 className="gantt-title">{cfg.title}</h1>
        <div className="gantt-meta">
          {cfg.chips.map(c => (
            <span key={c.id} className={`gantt-chip${c.deadline ? ' deadline' : ''}`}>
              {c.strong && <strong>{c.strong}</strong>} {c.text}
            </span>
          ))}
          {cfg.timezones.length > 1 && (
            <span className="gantt-tz-switch">
              Time:
              {cfg.timezones.map(tz => (
                <button
                  key={tz.id}
                  type="button"
                  className={`gantt-tz-btn${tz.id === displayTz.id ? ' active' : ''}`}
                  onClick={() => onPickDisplayTz(tz.id)}
                  title={tzTitle(tz)}
                >
                  {tz.label}
                </button>
              ))}
            </span>
          )}
        </div>
      </header>

      {cfg.days.map(day => (
        <DayChart key={day.id} cfg={cfg} day={day} displayTz={displayTz} onEditItem={onEditItem} />
      ))}

      {(legend.length > 0 || cfg.gates.length > 0) && (
        <div className="gantt-foot">
          {legend.length > 0 && (
            <div className="gantt-card">
              <h3>Team</h3>
              {legend.map(p => (
                <div key={p.id} className="gantt-legend-item" style={{ '--rc': p.color }}>
                  <span className="gantt-legend-sw" />
                  <span>{p.name}</span>
                  <span className="gantt-legend-role">{p.role}</span>
                </div>
              ))}
              {hasRisk && (
                <div className="gantt-legend-item gantt-legend-risk">
                  <span className="gantt-legend-sw risk-sw">⚠</span>
                  <span>Risky step</span>
                </div>
              )}
            </div>
          )}
          {cfg.gates.length > 0 && (
            <div className="gantt-card">
              <h3>Key gates</h3>
              {cfg.gates.map(g => (
                <div key={g.id} className="gantt-gate-item">
                  <span className={`gantt-gate-tag tag-${g.tag.toLowerCase()}`}>{g.tag}</span>
                  <span className="gantt-gate-text">{g.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {cfg.footer && <footer className="gantt-src">{cfg.footer}</footer>}
    </div>
  );
}

// ----------------------------------------------------------------- editor ---

function TimeInput({ value, onChange }) {
  return (
    <input
      type="time"
      className="input gantt-time-input"
      step={900}
      value={hToTime(value)}
      onChange={e => e.target.value && onChange(timeToH(e.target.value))}
    />
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// "2026-07-11" -> "Sat 11.07" — the same short label the chips already use.
function chipDateFromISO(iso) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${WEEKDAYS[d.getDay()]} ${dd}.${mm}`;
}

function CalendarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6"/>
      <path d="M3.5 9.5h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  );
}

// Calendar button that opens the native date picker and writes back a
// formatted label. The text field stays editable for anything non-date.
function ChipDatePicker({ onPick }) {
  const ref = useRef(null);
  const open = () => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') el.showPicker();
    else el.click();
  };
  return (
    <span className="gantt-datepick">
      <button type="button" className="gantt-icon-btn" title="Pick a date" onClick={open}>
        <CalendarIcon />
      </button>
      <input
        ref={ref}
        type="date"
        className="gantt-date-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={e => { if (e.target.value) onPick(chipDateFromISO(e.target.value)); }}
      />
    </span>
  );
}

export default function ReleaseTimelineBuilder() {
  const [cfg, setCfg] = useState(() => loadStoredConfig() || sampleConfig());
  const [panelOpen, setPanelOpen] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState('');
  const [editing, setEditing] = useState(null); // { dayId, rowId, itemId }
  const [applied, setApplied] = useState(false);
  const fileRef = useRef(null);
  const exportInputRef = useRef(null);

  useEffect(() => { storeConfig(cfg); }, [cfg]);

  useEffect(() => {
    if (exportOpen && exportInputRef.current) {
      exportInputRef.current.focus();
      exportInputRef.current.select();
    }
  }, [exportOpen]);

  const patch = p => setCfg(c => ({ ...c, ...p }));
  const patchDay = (dayId, p) => setCfg(c => ({
    ...c,
    days: c.days.map(d => d.id === dayId ? { ...d, ...(typeof p === 'function' ? p(d) : p) } : d),
  }));
  const patchRow = (dayId, rowId, p) => patchDay(dayId, d => ({
    rows: d.rows.map(r => r.id === rowId ? { ...r, ...(typeof p === 'function' ? p(r) : p) } : r),
  }));
  const patchItem = (dayId, rowId, itemId, p) => patchRow(dayId, rowId, r => ({
    items: r.items.map(it => it.id === itemId ? { ...it, ...p } : it),
  }));

  // -- timezones
  const tzEnabled = id => cfg.timezones.some(t => t.id === id);
  const toggleTz = preset => {
    setCfg(c => {
      const has = c.timezones.some(t => t.id === preset.id);
      const timezones = has
        ? c.timezones.filter(t => t.id !== preset.id)
        : [...c.timezones, { ...preset, enabled: true }];
      if (timezones.length === 0) return c; // keep at least one
      const fix = tzId => timezones.some(t => t.id === tzId) ? tzId : timezones[0].id;
      return { ...c, timezones, scheduleTz: fix(c.scheduleTz), displayTz: fix(c.displayTz) };
    });
  };
  const [customTz, setCustomTz] = useState({ label: '', abbr: '', offset: 0 });
  const addCustomTz = () => {
    if (!customTz.label.trim()) return;
    setCfg(c => ({
      ...c,
      timezones: [...c.timezones, {
        id: uid(),
        label: customTz.label.trim().toUpperCase(),
        abbr: customTz.abbr.trim().toUpperCase() || 'UTC',
        offset: Number(customTz.offset) || 0,
        enabled: true,
      }],
    }));
    setCustomTz({ label: '', abbr: '', offset: 0 });
  };

  // -- people
  const addPerson = () => patch({ people: [...cfg.people, makePerson(cfg.people.length)] });
  const patchPerson = (id, p) => patch({ people: cfg.people.map(x => x.id === id ? { ...x, ...p } : x) });
  const removePerson = id => setCfg(c => ({
    ...c,
    people: c.people.filter(p => p.id !== id),
    days: c.days.map(d => ({ ...d, rows: d.rows.filter(r => r.personId !== id) })),
  }));

  // -- days / rows / items
  const addDay = () => patch({ days: [...cfg.days, makeDay(cfg.days.length + 1)] });
  const removeDay = id => patch({ days: cfg.days.filter(d => d.id !== id) });
  const duplicateDay = id => setCfg(c => {
    const src = c.days.find(d => d.id === id);
    if (!src) return c;
    const copy = {
      ...src, id: uid(), idx: `DAY ${c.days.length + 1}`,
      rows: src.rows.map(r => ({
        ...r, id: uid(),
        items: r.items.map(it => ({ ...it, id: uid() })),
      })),
    };
    const i = c.days.findIndex(d => d.id === id);
    const days = [...c.days];
    days.splice(i + 1, 0, copy);
    return { ...c, days };
  });
  const moveDay = (id, dir) => setCfg(c => {
    const i = c.days.findIndex(d => d.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= c.days.length) return c;
    const days = [...c.days];
    [days[i], days[j]] = [days[j], days[i]];
    return { ...c, days };
  });

  const addRow = dayId => {
    if (cfg.people.length === 0) { alert('Add people in the Team section first.'); return; }
    patchDay(dayId, d => ({ rows: [...d.rows, makeRow(cfg.people[0].id)] }));
  };
  const removeRow = (dayId, rowId) => patchDay(dayId, d => ({ rows: d.rows.filter(r => r.id !== rowId) }));
  const moveRow = (dayId, rowId, dir) => patchDay(dayId, d => {
    const i = d.rows.findIndex(r => r.id === rowId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= d.rows.length) return {};
    const rows = [...d.rows];
    [rows[i], rows[j]] = [rows[j], rows[i]];
    return { rows };
  });
  const addItem = (dayId, rowId) => patchRow(dayId, rowId, r => ({ items: [...r.items, makeItem()] }));
  const removeItem = (dayId, rowId, itemId) => patchRow(dayId, rowId, r => ({ items: r.items.filter(it => it.id !== itemId) }));

  // -- chips / gates
  const addChip = () => patch({ chips: [...cfg.chips, { id: uid(), strong: '', text: '', deadline: false }] });
  const patchChip = (id, p) => patch({ chips: cfg.chips.map(c => c.id === id ? { ...c, ...p } : c) });
  const removeChip = id => patch({ chips: cfg.chips.filter(c => c.id !== id) });
  const addGate = () => patch({ gates: [...cfg.gates, { id: uid(), tag: 'GATE', text: '' }] });
  const patchGate = (id, p) => patch({ gates: cfg.gates.map(g => g.id === id ? { ...g, ...p } : g) });
  const removeGate = id => patch({ gates: cfg.gates.filter(g => g.id !== id) });

  // -- import / export / pdf
  const defaultExportName = () => {
    const slug = (cfg.title || 'gantt').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `gantt-${slug || 'config'}`;
  };
  const openExport = () => {
    setExportName(defaultExportName());
    setExportOpen(true);
  };
  const doExport = () => {
    const name = (exportName.trim() || defaultExportName()).replace(/\.json$/i, '');
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExportOpen(false);
  };
  const importJson = e => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!isValidConfig(parsed)) throw new Error('shape');
        setCfg(parsed);
      } catch {
        alert('Import failed: the file doesn’t look like a Gantt configuration.');
      }
    };
    reader.readAsText(file);
  };
  const exportPdf = () => {
    document.body.classList.add('gantt-printing');
    window.addEventListener('afterprint', () => document.body.classList.remove('gantt-printing'), { once: true });
    setTimeout(() => window.print(), 60);
  };

  const loadSample = () => {
    if (confirm('Load the sample? Your current configuration will be replaced.')) setCfg(sampleConfig());
  };
  // Force a full re-apply + persist (config is already reactive & autosaved —
  // this is an explicit "commit" with visible confirmation).
  const applyAll = () => {
    setCfg(c => ({ ...c }));
    storeConfig(cfg);
    setApplied(true);
    setTimeout(() => setApplied(false), 1400);
  };
  const clearAll = () => {
    if (confirm('Clear All — delete the entire board (people, days, tasks)? This cannot be undone.')) {
      setCfg({ ...emptyConfig(), days: [] });
    }
  };

  // Resolve the bar/point currently being edited (null if none or if it was deleted).
  const editItem = (() => {
    if (!editing) return null;
    const day = cfg.days.find(d => d.id === editing.dayId);
    const row = day?.rows.find(r => r.id === editing.rowId);
    const item = row?.items.find(i => i.id === editing.itemId);
    if (!item) return null;
    const person = cfg.people.find(p => p.id === row.personId);
    return { day, row, item, person };
  })();

  return (
    <div className="gantt-builder">
      <div className="gantt-toolbar">
        <button
          className={`btn btn-ghost gantt-panel-toggle${panelOpen ? ' active' : ''}`}
          onClick={() => setPanelOpen(o => !o)}
          title={panelOpen ? 'Hide configuration panel' : 'Show configuration panel'}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6"/>
            <rect x="3" y="4" width="8" height="16" rx="2.5" fill="currentColor" opacity="0.9"/>
            {panelOpen
              ? <path d="M15.5 9.5 13 12l2.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              : <path d="M13 9.5 15.5 12 13 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>}
          </svg>
          {panelOpen ? 'Hide panel' : 'Configuration'}
        </button>
        <div style={{ flex: 1 }} />
        <div className="gantt-toolbar-actions">
          <button className="btn btn-ghost" onClick={loadSample}>Sample</button>
          <button className={`btn btn-ghost${applied ? ' gantt-applied' : ''}`} onClick={applyAll}>
            {applied ? 'Applied ✓' : 'Apply All'}
          </button>
          <button className="btn btn-ghost btn-danger" onClick={clearAll}>Clear All</button>
          <span className="gantt-toolbar-sep" />
          <button className="btn btn-ghost" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={importJson} />
          <button className="btn btn-ghost" onClick={openExport}>Export JSON</button>
          <button className="btn btn-primary" onClick={exportPdf}>Export PDF</button>
        </div>
      </div>

      <div className={`gantt-layout${panelOpen ? ' panel-open' : ''}`}>
        <div className="gantt-editor" aria-hidden={!panelOpen}>

          <details className="gantt-section" open>
            <summary>Header</summary>
            <div className="gantt-section-body">
              <label className="gantt-field">
                <span>Eyebrow</span>
                <input className="input" value={cfg.eyebrow} onChange={e => patch({ eyebrow: e.target.value })} placeholder="NSMG · Release Runbook" />
              </label>
              <label className="gantt-field">
                <span>Title</span>
                <input className="input" value={cfg.title} onChange={e => patch({ title: e.target.value })} />
              </label>
              <label className="gantt-field">
                <span>Footer note</span>
                <input className="input" value={cfg.footer} onChange={e => patch({ footer: e.target.value })} placeholder="Source: …" />
              </label>
              <div className="gantt-subhead">Header chips</div>
              {cfg.chips.map(c => (
                <div key={c.id} className="gantt-inline-row">
                  <input className="input" style={{ width: 90 }} value={c.strong} placeholder="Sat 11.07" onChange={e => patchChip(c.id, { strong: e.target.value })} />
                  <ChipDatePicker onPick={label => patchChip(c.id, { strong: label })} />
                  <input className="input" value={c.text} placeholder="text" onChange={e => patchChip(c.id, { text: e.target.value })} />
                  <label className="gantt-check" title="Red deadline chip">
                    <input type="checkbox" checked={c.deadline} onChange={e => patchChip(c.id, { deadline: e.target.checked })} />
                    <span>DL</span>
                  </label>
                  <button className="gantt-icon-btn" onClick={() => removeChip(c.id)} title="Remove">×</button>
                </div>
              ))}
              <button className="btn btn-ghost gantt-add-btn" onClick={addChip}>+ chip</button>
            </div>
          </details>

          <details className="gantt-section" open>
            <summary>Scale & timezones</summary>
            <div className="gantt-section-body">
              <div className="gantt-inline-row">
                <label className="gantt-field" style={{ flex: 1 }}>
                  <span>Day start</span>
                  <TimeInput value={cfg.dayStart} onChange={v => patch({ dayStart: v })} />
                </label>
                <label className="gantt-field" style={{ flex: 1 }}>
                  <span>Day end</span>
                  <TimeInput value={cfg.dayEnd} onChange={v => patch({ dayEnd: v })} />
                </label>
              </div>
              <label className="gantt-field">
                <span>Schedule is set in timezone</span>
                <select className="select" value={cfg.scheduleTz} onChange={e => patch({ scheduleTz: e.target.value })}>
                  {cfg.timezones.map(tz => <option key={tz.id} value={tz.id}>{tz.label} ({tzTitle(tz)})</option>)}
                </select>
              </label>
              <div className="gantt-subhead">Show timezones</div>
              <div className="gantt-tz-grid">
                {TZ_PRESETS.map(p => (
                  <label key={p.id} className="gantt-check">
                    <input type="checkbox" checked={tzEnabled(p.id)} onChange={() => toggleTz(p)} />
                    <span>{p.label} <em>{tzTitle(p)}</em></span>
                  </label>
                ))}
                {cfg.timezones.filter(t => !TZ_PRESETS.some(p => p.id === t.id)).map(t => (
                  <label key={t.id} className="gantt-check">
                    <input type="checkbox" checked onChange={() => toggleTz(t)} />
                    <span>{t.label} <em>{tzTitle(t)}</em></span>
                  </label>
                ))}
              </div>
              <div className="gantt-subhead">Custom timezone</div>
              <div className="gantt-inline-row">
                <input className="input" style={{ width: 90 }} placeholder="TOKYO" value={customTz.label} onChange={e => setCustomTz(s => ({ ...s, label: e.target.value }))} />
                <input className="input" style={{ width: 60 }} placeholder="JST" value={customTz.abbr} onChange={e => setCustomTz(s => ({ ...s, abbr: e.target.value }))} />
                <input className="input" style={{ width: 70 }} type="number" step="0.5" placeholder="UTC±" value={customTz.offset} onChange={e => setCustomTz(s => ({ ...s, offset: e.target.value }))} />
                <button className="btn btn-ghost" onClick={addCustomTz}>+</button>
              </div>
            </div>
          </details>

          <details className="gantt-section" open>
            <summary>Team</summary>
            <div className="gantt-section-body">
              {cfg.people.map(p => (
                <div key={p.id} className="gantt-inline-row">
                  <input type="color" className="gantt-color" value={p.color} onChange={e => patchPerson(p.id, { color: e.target.value })} title="Color" />
                  <input className="input" value={p.name} placeholder="Name" onChange={e => patchPerson(p.id, { name: e.target.value })} />
                  <input className="input" value={p.role} placeholder="Role" onChange={e => patchPerson(p.id, { role: e.target.value })} />
                  <button className="gantt-icon-btn" onClick={() => removePerson(p.id)} title="Remove (also removes their rows from all days)">×</button>
                </div>
              ))}
              <button className="btn btn-ghost gantt-add-btn" onClick={addPerson}>+ person</button>
            </div>
          </details>

          <details className="gantt-section" open>
            <summary>Days</summary>
            <div className="gantt-section-body">
              {cfg.days.map((day, di) => (
                <div key={day.id} className="gantt-day-editor">
                  <div className="gantt-inline-row gantt-day-editor-head">
                    <input className="input" style={{ width: 70 }} value={day.idx} placeholder="DAY 1" onChange={e => patchDay(day.id, { idx: e.target.value })} />
                    <input className="input" value={day.date} placeholder="Saturday · Jul 11" onChange={e => patchDay(day.id, { date: e.target.value })} />
                    <button className="gantt-icon-btn" disabled={di === 0} onClick={() => moveDay(day.id, -1)} title="Move up">↑</button>
                    <button className="gantt-icon-btn" disabled={di === cfg.days.length - 1} onClick={() => moveDay(day.id, 1)} title="Move down">↓</button>
                    <button className="gantt-icon-btn" onClick={() => duplicateDay(day.id)} title="Duplicate day">⧉</button>
                    <button className="gantt-icon-btn" onClick={() => removeDay(day.id)} title="Delete day">×</button>
                  </div>
                  <input className="input" value={day.sub} placeholder="Day subtitle" onChange={e => patchDay(day.id, { sub: e.target.value })} />
                  <input className="input" value={day.standby} placeholder="Standby (who is on call)" onChange={e => patchDay(day.id, { standby: e.target.value })} />

                  {day.rows.map((row, ri) => {
                    const person = cfg.people.find(p => p.id === row.personId);
                    return (
                      <div key={row.id} className="gantt-row-editor" style={{ '--rc': person?.color || 'var(--text-3)' }}>
                        <div className="gantt-inline-row">
                          <span className="gantt-swatch" />
                          <select className="select" value={row.personId} onChange={e => patchRow(day.id, row.id, { personId: e.target.value })}>
                            {cfg.people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                          <label className="gantt-check" title="Gate — highlighted row">
                            <input type="checkbox" checked={row.gate} onChange={e => patchRow(day.id, row.id, { gate: e.target.checked })} />
                            <span>Gate</span>
                          </label>
                          <button className="gantt-icon-btn" disabled={ri === 0} onClick={() => moveRow(day.id, row.id, -1)} title="Move up">↑</button>
                          <button className="gantt-icon-btn" disabled={ri === day.rows.length - 1} onClick={() => moveRow(day.id, row.id, 1)} title="Move down">↓</button>
                          <button className="gantt-icon-btn" onClick={() => removeRow(day.id, row.id)} title="Delete row">×</button>
                        </div>
                        {row.items.map(it => (
                          <div key={it.id} className="gantt-item-editor">
                            <div className="gantt-inline-row">
                              <select
                                className="select gantt-kind-select"
                                value={it.kind}
                                onChange={e => patchItem(day.id, row.id, it.id, { kind: e.target.value })}
                                title="Bar or milestone point"
                              >
                                <option value="bar">Bar</option>
                                <option value="point">Point</option>
                              </select>
                              <TimeInput value={it.s} onChange={v => patchItem(day.id, row.id, it.id, { s: v })} />
                              {it.kind === 'bar' && (
                                <TimeInput value={it.e} onChange={v => patchItem(day.id, row.id, it.id, { e: v })} />
                              )}
                              <button className="gantt-icon-btn" onClick={() => removeItem(day.id, row.id, it.id)} title="Delete task">×</button>
                            </div>
                            <div className="gantt-inline-row">
                              <input className="input" value={it.label} placeholder="What they do" onChange={e => patchItem(day.id, row.id, it.id, { label: e.target.value })} />
                              {it.kind === 'bar' && (
                                <label className="gantt-check" title="External team — hatched bar">
                                  <input type="checkbox" checked={it.external} onChange={e => patchItem(day.id, row.id, it.id, { external: e.target.checked })} />
                                  <span>External</span>
                                </label>
                              )}
                              <label className="gantt-check gantt-check-risk" title="Highlight as a risk">
                                <input type="checkbox" checked={it.risk} onChange={e => patchItem(day.id, row.id, it.id, { risk: e.target.checked })} />
                                <span>Risk</span>
                              </label>
                            </div>
                          </div>
                        ))}
                        <button className="btn btn-ghost gantt-add-btn" onClick={() => addItem(day.id, row.id)}>+ task</button>
                      </div>
                    );
                  })}
                  <button className="btn btn-ghost gantt-add-btn" onClick={() => addRow(day.id)}>+ row (person)</button>
                </div>
              ))}
              <button className="btn btn-ghost gantt-add-btn" onClick={addDay}>+ day</button>
            </div>
          </details>

          <details className="gantt-section">
            <summary>Gates & notes</summary>
            <div className="gantt-section-body">
              {cfg.gates.map(g => (
                <div key={g.id} className="gantt-inline-row">
                  <select className="select" style={{ width: 84 }} value={g.tag} onChange={e => patchGate(g.id, { tag: e.target.value })}>
                    {GATE_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  <input className="input" value={g.text} placeholder="Condition / dependency / risk" onChange={e => patchGate(g.id, { text: e.target.value })} />
                  <button className="gantt-icon-btn" onClick={() => removeGate(g.id)} title="Remove">×</button>
                </div>
              ))}
              <button className="btn btn-ghost gantt-add-btn" onClick={addGate}>+ gate</button>
            </div>
          </details>

        </div>

        {panelOpen && (
          <div className="gantt-panel-scrim" onClick={() => setPanelOpen(false)} aria-hidden="true" />
        )}

        <div className="gantt-preview">
          <Preview
            cfg={cfg}
            onPickDisplayTz={id => patch({ displayTz: id })}
            onEditItem={(dayId, rowId, itemId) => setEditing({ dayId, rowId, itemId })}
          />
        </div>
      </div>

      {editItem && (
        <div className="gantt-modal-scrim" onClick={() => setEditing(null)}>
          <div
            className="gantt-modal"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-label="Edit task"
            style={{ '--rc': editItem.person?.color || 'var(--accent-1)' }}
          >
            <h3 className="gantt-modal-title">
              <span className="gantt-modal-dot" />
              Edit {editItem.item.kind === 'point' ? 'milestone' : 'bar'}
              {editItem.person && <span className="gantt-modal-sub"> · {editItem.person.name}</span>}
            </h3>

            <label className="gantt-field">
              <span>Label</span>
              <input
                className="input"
                autoFocus
                value={editItem.item.label}
                onChange={e => patchItem(editing.dayId, editing.rowId, editing.itemId, { label: e.target.value })}
                onKeyDown={e => { if (e.key === 'Escape') setEditing(null); }}
              />
            </label>

            <div className="gantt-inline-row">
              <label className="gantt-field" style={{ flex: 1 }}>
                <span>Type</span>
                <select
                  className="select"
                  value={editItem.item.kind}
                  onChange={e => patchItem(editing.dayId, editing.rowId, editing.itemId, { kind: e.target.value })}
                >
                  <option value="bar">Bar</option>
                  <option value="point">Point</option>
                </select>
              </label>
              <label className="gantt-field">
                <span>Start</span>
                <TimeInput value={editItem.item.s} onChange={v => patchItem(editing.dayId, editing.rowId, editing.itemId, { s: v })} />
              </label>
              {editItem.item.kind === 'bar' && (
                <label className="gantt-field">
                  <span>End</span>
                  <TimeInput value={editItem.item.e} onChange={v => patchItem(editing.dayId, editing.rowId, editing.itemId, { e: v })} />
                </label>
              )}
            </div>

            <div className="gantt-inline-row" style={{ gap: 16 }}>
              {editItem.item.kind === 'bar' && (
                <label className="gantt-check" title="External team — hatched bar">
                  <input
                    type="checkbox"
                    checked={editItem.item.external}
                    onChange={e => patchItem(editing.dayId, editing.rowId, editing.itemId, { external: e.target.checked })}
                  />
                  <span>External</span>
                </label>
              )}
              <label className="gantt-check gantt-check-risk" title="Highlight as a risk">
                <input
                  type="checkbox"
                  checked={editItem.item.risk}
                  onChange={e => patchItem(editing.dayId, editing.rowId, editing.itemId, { risk: e.target.checked })}
                />
                <span>Risk</span>
              </label>
            </div>

            <div className="gantt-modal-actions">
              <button
                className="btn btn-danger"
                onClick={() => { removeItem(editing.dayId, editing.rowId, editing.itemId); setEditing(null); }}
              >
                Delete
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn btn-primary" onClick={() => setEditing(null)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {exportOpen && (
        <div className="gantt-modal-scrim" onClick={() => setExportOpen(false)}>
          <div className="gantt-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Export JSON">
            <h3 className="gantt-modal-title">Export configuration</h3>
            <label className="gantt-field">
              <span>File name</span>
              <div className="gantt-modal-name">
                <input
                  ref={exportInputRef}
                  className="input"
                  value={exportName}
                  onChange={e => setExportName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') doExport();
                    if (e.key === 'Escape') setExportOpen(false);
                  }}
                  placeholder={defaultExportName()}
                />
                <span className="gantt-modal-ext">.json</span>
              </div>
            </label>
            <div className="gantt-modal-actions">
              <button className="btn btn-ghost" onClick={() => setExportOpen(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={doExport}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
