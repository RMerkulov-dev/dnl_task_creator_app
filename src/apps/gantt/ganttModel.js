// Data model + helpers for the Gantt builder.
// A config is a plain JSON-serialisable object — that's what export/import moves around.

export const CONFIG_VERSION = 1;
export const STORAGE_KEY = 'gantt-config-v1';

export const TZ_PRESETS = [
  { id: 'kyiv',     label: 'KYIV',     abbr: 'EEST', offset: 3 },
  { id: 'london',   label: 'LONDON',   abbr: 'BST',  offset: 1 },
  { id: 'utc',      label: 'UTC',      abbr: 'UTC',  offset: 0 },
  { id: 'florida',  label: 'FLORIDA',  abbr: 'EDT',  offset: -4 },
  { id: 'central',  label: 'CENTRAL',  abbr: 'CDT',  offset: -5 },
  { id: 'mountain', label: 'MOUNTAIN', abbr: 'MDT',  offset: -6 },
  { id: 'pacific',  label: 'PACIFIC',  abbr: 'PDT',  offset: -7 },
  { id: 'hawaii',   label: 'HAWAII',   abbr: 'HST',  offset: -10 },
  { id: 'india',    label: 'INDIA',    abbr: 'IST',  offset: 5.5 },
];

export const PERSON_COLORS = [
  '#bd7a22', '#10908c', '#6a53d1', '#2c6bbd', '#cc4658',
  '#4a56ad', '#0e9f6e', '#b93aa8', '#64748b',
];

export const GATE_TAGS = ['GATE', 'DEP', 'RISK', 'NOTE'];

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

// "HH:MM" <-> decimal hours (9.5 = 09:30)
export function hToTime(h) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
}
export function timeToH(str) {
  const [hh, mm] = String(str || '0:0').split(':').map(Number);
  return (hh || 0) + (mm || 0) / 60;
}

// Format an hour (stored in schedule tz) as seen from another timezone.
export function fmtInTz(h, scheduleOffset, tzOffset) {
  const shifted = ((h - scheduleOffset + tzOffset) % 24 + 24) % 24;
  return hToTime(shifted);
}

export function tzTitle(tz) {
  const sign = tz.offset >= 0 ? '+' : '−';
  const abs = Math.abs(tz.offset);
  const off = abs % 1 === 0 ? abs : abs.toFixed(1);
  return `${tz.abbr} · UTC${sign}${off}`;
}

export function findTz(cfg, id) {
  return cfg.timezones.find(t => t.id === id) || cfg.timezones[0];
}

export function makePerson(i = 0) {
  return { id: uid(), name: 'New person', role: '', color: PERSON_COLORS[i % PERSON_COLORS.length] };
}

export function makeItem() {
  return { id: uid(), kind: 'bar', s: 10, e: 12, label: 'Task', external: false, risk: false };
}

export function makeRow(personId) {
  return { id: uid(), personId, gate: false, items: [makeItem()] };
}

export function makeDay(n = 1) {
  return {
    id: uid(),
    idx: `DAY ${n}`,
    date: 'New day',
    sub: '',
    standby: '',
    rows: [],
  };
}

export function emptyConfig() {
  const tzs = TZ_PRESETS.slice(0, 1).map(t => ({ ...t, enabled: true }));
  return {
    version: CONFIG_VERSION,
    mode: 'release-timeline',
    eyebrow: '',
    title: 'New release plan',
    chips: [],
    footer: '',
    dayStart: 9,
    dayEnd: 19,
    scheduleTz: 'kyiv',
    displayTz: 'kyiv',
    timezones: tzs,
    people: [],
    days: [makeDay(1)],
    gates: [],
  };
}

// Sample replicating the "Weekend Release — Case Entity Migration" plan.
export function sampleConfig() {
  const ion = uid(), nat = uid(), olha = uid(), ivan = uid(), vik = uid(), roman = uid(), client = uid(), nav = uid();
  return {
    version: CONFIG_VERSION,
    mode: 'release-timeline',
    eyebrow: 'NSMG · Case Entity Migration · Release Runbook',
    title: 'Weekend Release — Plan by People',
    chips: [
      { id: uid(), strong: 'Sat 11.07', text: 'migration + QA', deadline: false },
      { id: uid(), strong: 'Sun 12.07', text: 'go-live', deadline: false },
      { id: uid(), strong: '12.07', text: 'Hard deadline — D365 licenses expire', deadline: true },
    ],
    footer: 'Source: Release Planning Call — 08.07',
    dayStart: 9,
    dayEnd: 19.5,
    scheduleTz: 'kyiv',
    displayTz: 'kyiv',
    timezones: [
      { ...TZ_PRESETS[0], enabled: true },   // Kyiv
      { ...TZ_PRESETS[3], enabled: true },   // Florida
      { ...TZ_PRESETS[4], enabled: true },   // Central
      { ...TZ_PRESETS[7], enabled: true },   // Hawaii
    ],
    people: [
      { id: ion,    name: 'Ion',        role: 'Data migration',  color: '#bd7a22' },
      { id: nat,    name: 'Natalia',    role: 'QA',              color: '#10908c' },
      { id: olha,   name: 'Olha',       role: 'QA',              color: '#6a53d1' },
      { id: ivan,   name: 'Ivan',       role: 'Release / Dev',   color: '#2c6bbd' },
      { id: vik,    name: 'Viktor',     role: 'Flows / Adobe',   color: '#cc4658' },
      { id: roman,  name: 'Roman',      role: 'PM',              color: '#64748b' },
      { id: client, name: 'Go / No-Go', role: 'Client call',     color: '#4a56ad' },
      { id: nav,    name: 'Navigator',  role: 'External team',   color: '#bd7a22' },
    ],
    days: [
      {
        id: uid(), idx: 'DAY 1', date: 'Saturday · Jul 11',
        sub: 'Data migration + QA of the first delta (~40k cases)',
        standby: 'Oleh & Eugene — on call (high-level). Ivan & Viktor not needed on Saturday.',
        rows: [
          { id: uid(), personId: ion, gate: false, items: [
            { id: uid(), kind: 'bar', s: 9,  e: 11, label: 'Import all cases · 1-to-1 reconciliation', external: false, risk: false },
            { id: uid(), kind: 'bar', s: 11, e: 14, label: 'BPF migration', external: false, risk: false },
            { id: uid(), kind: 'bar', s: 15, e: 18, label: 'Related tables: SLA, Activities, Notes, Emails', external: false, risk: true },
          ]},
          { id: uid(), personId: nat, gate: false, items: [
            { id: uid(), kind: 'bar', s: 14, e: 18, label: 'Test cases + BPF · own sample of 40', external: false, risk: false },
          ]},
          { id: uid(), personId: olha, gate: false, items: [
            { id: uid(), kind: 'bar', s: 14, e: 18, label: 'Test cases + BPF · own sample of 40', external: false, risk: false },
          ]},
          { id: uid(), personId: roman, gate: false, items: [
            { id: uid(), kind: 'point', s: 17, e: 17, label: 'Navigator go/no-go — confirmation', external: false, risk: true },
          ]},
        ],
      },
      {
        id: uid(), idx: 'DAY 2', date: 'Sunday · Jul 12',
        sub: 'Go-live: final delta, customizations, switch',
        standby: 'Oleh — high-level + client call. Eugene — on call with a PC in case of failures.',
        rows: [
          { id: uid(), personId: nav, gate: true, items: [
            { id: uid(), kind: 'bar', s: 9, e: 11, label: 'Navigator switch → new entity · client', external: true, risk: true },
          ]},
          { id: uid(), personId: ion, gate: false, items: [
            { id: uid(), kind: 'bar', s: 9,  e: 13, label: 'Final weekend delta: cases + all tables', external: false, risk: false },
            { id: uid(), kind: 'bar', s: 13, e: 14, label: 'Power BI remap', external: false, risk: false },
          ]},
          { id: uid(), personId: ivan, gate: false, items: [
            { id: uid(), kind: 'bar', s: 9,  e: 11, label: 'Go-live release · 2 solutions', external: false, risk: false },
            { id: uid(), kind: 'bar', s: 13, e: 14, label: 'Enable / disable automations', external: false, risk: false },
            { id: uid(), kind: 'point', s: 17, e: 17, label: 'Redirection script ON', external: false, risk: false },
          ]},
          { id: uid(), personId: vik, gate: false, items: [
            { id: uid(), kind: 'bar', s: 13, e: 14, label: 'Adobe flow fix · disable old workflows', external: false, risk: false },
          ]},
          { id: uid(), personId: nat, gate: false, items: [
            { id: uid(), kind: 'bar', s: 9,  e: 14, label: 'Test related tables', external: false, risk: false },
            { id: uid(), kind: 'bar', s: 15, e: 17, label: 'Test final delta (~50 cases)', external: false, risk: false },
          ]},
          { id: uid(), personId: olha, gate: false, items: [
            { id: uid(), kind: 'bar', s: 9,  e: 14, label: 'Helps Natalia', external: false, risk: false },
            { id: uid(), kind: 'bar', s: 14, e: 17, label: 'Customizations · regression · Adobe Sign', external: false, risk: false },
          ]},
          { id: uid(), personId: client, gate: true, items: [
            { id: uid(), kind: 'bar', s: 17, e: 19.5, label: '★ Go/No-Go with client · Oleh, Roman, Vlada, Summit', external: false, risk: false },
          ]},
        ],
      },
    ],
    gates: [
      { id: uid(), tag: 'GATE', text: 'Navigator switch — client confirmation on Sat. No confirmation → customizations stay off (no-go).' },
      { id: uid(), tag: 'DEP',  text: 'Enable automations (Sun 13–14) only after Ion finishes the final delta.' },
      { id: uid(), tag: 'DEP',  text: 'Redirection script (17:00) only after Olha’s test.' },
      { id: uid(), tag: 'RISK', text: 'Ion works via the TransVestor VPN; fallback — own machine (slower).' },
    ],
  };
}

// Minimal shape check for imported JSON.
export function isValidConfig(obj) {
  return obj && typeof obj === 'object'
    && Array.isArray(obj.days)
    && Array.isArray(obj.people)
    && Array.isArray(obj.timezones)
    && typeof obj.dayStart === 'number'
    && typeof obj.dayEnd === 'number';
}

export function loadStoredConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidConfig(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function storeConfig(cfg) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch { /* quota — ignore */ }
}
