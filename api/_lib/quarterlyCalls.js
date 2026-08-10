import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { put, get } from '@vercel/blob';
import { sendEmail } from './taskNotify.js';

// ─── Quarterly Calls ──────────────────────────────────────────────────────────
// Calendar of management calls with customers (ABS / NSMG / NSMG Marker).
// READ is open to every logged-in user (view-only calendar); WRITE (calls,
// projects, manual reminder sweep) is restricted to QC_ALLOWED — the UI hides
// the edit affordances for everyone else (GET returns `canEdit`), and the
// server re-checks here so the API can't be written to by other users.
//
// Storage (two backends, picked automatically):
//   • Vercel Blob — when BLOB_READ_WRITE_TOKEN is set (auto-injected once a
//     Blob store is attached to the Vercel project; the store must be created
//     as PRIVATE with the "add a read-write token env var" box checked).
//     One JSON document at a fixed pathname, readable only with the token.
//     Survives deploys/cold starts.
//   • Local file api/data/quarterly-calls.json (gitignored) — dev fallback,
//     also kept as a best-effort mirror when Blob is active.
// First load with an empty store seeds from the 2026 schedule spreadsheet.
//
// Reminders: checkQuarterlyCallReminders() emails QC_REMIND_TO once per call
// when it is ≤ 7 days away. Triggers: 30-min interval on the local dev server,
// frontend app load, and GET /api/quarterly-calls/cron — a Vercel Cron entry
// point (vercel.json) that is exempt from app auth and protected by
// CRON_SECRET instead, so reminders go out even when nobody opens the app.

const QC_ALLOWED = ['roman.merkulov@dynamicalabs.com'];

// Default project registry; the user can add more via POST …/projects.
const SEED_PROJECTS = [
  { id: 'ABS',         label: 'ABS',         color: '#34D399' },
  { id: 'NSMG',        label: 'NSMG',        color: '#00E5FF' },
  { id: 'NSMG_MARKER', label: 'NSMG Marker', color: '#A78BFA' },
];
const QC_STATUSES = ['scheduled', 'completed', 'cancelled'];

const DATA_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'quarterly-calls.json');

// Imported from "DNL+FW. Management call with a customer. Schedule.xlsx",
// sheet "2026" (ABS / NSMG / NSMG Marker rows only). Times are Kyiv.
const SEED_CALLS = [
  { id: 'seed-2026-01', project: 'ABS',         title: 'ABS. Quarterly Call',                          date: '2026-02-12', time: '15:30', status: 'completed' },
  { id: 'seed-2026-02', project: 'ABS',         title: 'ABS. Quarterly Call (Eathan)',                 date: '2026-03-03', time: '',      status: 'completed', notes: 'Из календарной сетки таблицы (3 марта).' },
  { id: 'seed-2026-03', project: 'NSMG_MARKER', title: 'NSMG Marker. Quarterly Call',                  date: '2026-03-04', time: '18:00', status: 'completed' },
  { id: 'seed-2026-04', project: 'ABS',         title: 'ABS. Quarterly Call (Timothy)',                date: '2026-03-05', time: '',      status: 'completed', notes: 'Из календарной сетки таблицы (5 марта).' },
  { id: 'seed-2026-05', project: 'NSMG',        title: 'NSMG Quarterly Goals and Blue Sky Thinking',   date: '2026-04-08', time: '18:00', status: 'completed', participants: 'Cara, David' },
  { id: 'seed-2026-06', project: 'NSMG',        title: 'NSMG Catch-Up with Cara',                      date: '2026-05-20', time: '18:00', status: 'completed', participants: 'Cara' },
  { id: 'seed-2026-07', project: 'ABS',         title: 'ABS. Quarterly Call',                          date: '2026-06-11', time: '19:00', status: 'completed',
    miroLink: 'https://miro.com/app/board/uXjVGCZfRQk=/?moveToWidget=3458764671467481884&cot=14' },
  { id: 'seed-2026-08', project: 'ABS',         title: 'ABS. Mid-Quarter Alignment',                   date: '2026-06-25', time: '19:00', status: 'completed' },
  { id: 'seed-2026-09', project: 'NSMG',        title: 'NSMG Catch-Up with Cara',                      date: '2026-07-01', time: '18:00', status: 'completed', participants: 'Cara' },
  { id: 'seed-2026-10', project: 'NSMG',        title: 'NSMG Catch-Up with Cara',                      date: '2026-08-12', time: '18:00', status: 'scheduled', participants: 'Cara' },
  { id: 'seed-2026-11', project: 'ABS',         title: 'ABS. Quarterly Call',                          date: '2026-08-13', time: '19:00', status: 'scheduled' },
  { id: 'seed-2026-12', project: 'NSMG',        title: 'NSMG Quarterly Goals and Blue Sky Thinking',   date: '2026-08-15', time: '18:00', status: 'scheduled', participants: 'Cara, David',
    notes: 'В таблице 15.08 (суббота); в календарной сетке звонок стоит 5 августа — проверить дату.' },
  { id: 'seed-2026-13', project: 'ABS',         title: 'ABS. Mid-Quarter Alignment',                   date: '2026-09-17', time: '19:00', status: 'scheduled' },
  { id: 'seed-2026-14', project: 'NSMG',        title: 'NSMG Catch-Up with Cara',                      date: '2026-09-23', time: '18:00', status: 'scheduled', participants: 'Cara' },
  { id: 'seed-2026-15', project: 'NSMG',        title: 'NSMG Quarterly Goals and Blue Sky Thinking',   date: '2026-10-14', time: '18:00', status: 'scheduled', participants: 'Cara, David' },
  { id: 'seed-2026-16', project: 'ABS',         title: 'ABS. Mid-Quarter Alignment',                   date: '2026-10-29', time: '19:00', status: 'scheduled' },
  { id: 'seed-2026-17', project: 'ABS',         title: 'ABS. Quarterly Call',                          date: '2026-11-12', time: '19:00', status: 'scheduled' },
  { id: 'seed-2026-18', project: 'NSMG',        title: 'NSMG Catch-Up with Cara',                      date: '2026-11-14', time: '18:00', status: 'scheduled', participants: 'Cara',
    notes: 'В таблице 14.11 — суббота; проверить дату.' },
  { id: 'seed-2026-19', project: 'ABS',         title: 'ABS. Mid-Quarter Alignment',                   date: '2026-12-10', time: '19:00', status: 'scheduled' },
  { id: 'seed-2026-20', project: 'NSMG',        title: 'NSMG Catch-Up with Cara',                      date: '2026-12-16', time: '18:00', status: 'scheduled', participants: 'Cara' },
].map(c => ({
  participants: '', summaryLink: '', miroLink: '', notes: '',
  reminderSentAt: null, reminder2SentAt: null,
  createdAt: '2026-07-23T00:00:00.000Z', updatedAt: '2026-07-23T00:00:00.000Z',
  ...c,
}));

// ─── Storage layer ────────────────────────────────────────────────────────────
const BLOB_PATH = 'quarterly-calls/db.json';
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

// In-memory working copy (authoritative within one warm instance).
let cache = null;
let backend = 'file';
let loading = null;

function normalize(db) {
  if (!db || !Array.isArray(db.calls)) return null;
  // Older data predates custom projects — backfill the registry.
  if (!Array.isArray(db.projects) || !db.projects.length) {
    db.projects = SEED_PROJECTS.map(p => ({ ...p }));
  }
  return db;
}

function loadLocal() {
  try {
    const db = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    if (db) return db;
  } catch { /* missing or corrupt — fall through to seed */ }
  return {
    projects: SEED_PROJECTS.map(p => ({ ...p })),
    calls: SEED_CALLS.map(c => ({ ...c })),
  };
}

function saveLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
    return true;
  } catch (err) {
    // Read-only FS on Vercel — expected there; Blob is the durable copy.
    if (!useBlob()) console.warn('[Quarterly calls] could not persist to disk:', err.message);
    return false;
  }
}

async function blobLoad() {
  // Private blob: readable only through the SDK with the read-write token.
  const res = await get(BLOB_PATH, { access: 'private', useCache: false });
  if (!res || !res.stream) return null; // not found — fresh store
  const text = await new Response(res.stream).text();
  return normalize(JSON.parse(text));
}

async function blobSave() {
  await put(BLOB_PATH, JSON.stringify(cache, null, 2), {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

async function load() {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    if (useBlob()) {
      try {
        const remote = await blobLoad();
        backend = 'blob';
        if (remote) {
          cache = remote;
        } else {
          // Empty store — migrate whatever exists locally (or the seed).
          cache = loadLocal();
          await blobSave();
          console.log('[Quarterly calls] seeded Vercel Blob store');
        }
        return cache;
      } catch (err) {
        console.warn('[Quarterly calls] Blob load failed, using local file:', err.message);
      }
    }
    backend = 'file';
    cache = loadLocal();
    saveLocal();
    return cache;
  })().finally(() => { loading = null; });
  return loading;
}

// Persist the working copy. Returns true when the durable backend accepted it.
async function save() {
  const localOk = saveLocal();
  if (useBlob()) {
    try {
      await blobSave();
      return true;
    } catch (err) {
      console.warn('[Quarterly calls] Blob save failed:', err.message);
      return localOk;
    }
  }
  return localOk;
}

// Date-only "today" in Kyiv, as YYYY-MM-DD (en-CA locale formats exactly that).
function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
}

function kyivHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false,
  }).format(new Date()));
}

function daysUntil(dateStr) {
  const [ty, tm, td] = kyivToday().split('-').map(Number);
  const [cy, cm, cd] = String(dateStr).split('-').map(Number);
  if (!cy || !cm || !cd) return NaN;
  return Math.round((Date.UTC(cy, cm - 1, cd) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function formatCallDate(call) {
  const [y, m, d] = call.date.split('-').map(Number);
  const day = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, d)));
  return call.time ? `${day}, ${call.time} (Kyiv)` : day;
}

function buildReminderEmail(call, days, projectName) {
  const project = projectName || call.project;
  const when = formatCallDate(call);
  const inDays = days === 7 ? 'in one week' : `in ${days} day${days === 1 ? '' : 's'}`;
  const subject = `QUARTERLY CALL Reminder - [${project}] ${call.title} — ${when}`;

  const row = (label, value) => value ? `
    <tr>
      <td style="padding:6px 16px 6px 0;color:#6b7280;font-size:13px;white-space:nowrap;
                 font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(label)}</td>
      <td style="padding:6px 0;color:#111827;font-size:13px;
                 font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${value}</td>
    </tr>` : '';
  const link = href => `<a href="${esc(href)}" style="color:#2563eb;text-decoration:none">${esc(href)}</a>`;

  const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0"
           style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
      <tr>
        <td style="background:#111827;padding:18px 28px">
          <span style="color:#ffffff;font-size:15px;font-weight:700;letter-spacing:.4px;
                       font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">DNL&nbsp;Tasks</span>
          <span style="color:#9ca3af;font-size:13px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
            &nbsp;·&nbsp;Upcoming management call</span>
        </td>
      </tr>
      <tr>
        <td style="padding:28px">
          <p style="margin:0 0 6px;color:#6b7280;font-size:13px;text-transform:uppercase;letter-spacing:.6px;
                    font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(project)}</p>
          <p style="margin:0 0 6px;color:#111827;font-size:19px;font-weight:700;line-height:1.35;
                    font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(call.title)}</p>
          <p style="margin:0 0 20px;color:#374151;font-size:14px;
                    font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">This call is ${esc(inDays)} — ${esc(when)}.</p>
          <table role="presentation" cellpadding="0" cellspacing="0"
                 style="border-top:1px solid #e5e7eb;padding-top:8px;width:100%">
            ${row('Participants', esc(call.participants))}
            ${row('Miro board', call.miroLink ? link(call.miroLink) : '')}
            ${row('Call summary', call.summaryLink ? link(call.summaryLink) : '')}
            ${row('Notes', esc(call.notes))}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 28px;background:#f9fafb;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#9ca3af;font-size:12px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
            Automated reminder from the Quarterly Calls app (DNL Tasks Creator).</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

  const text = [
    `Upcoming management call ${inDays}: ${call.title}`,
    `Project: ${project}`,
    `When: ${when}`,
    call.participants ? `Participants: ${call.participants}` : '',
    call.miroLink ? `Miro: ${call.miroLink}` : '',
    call.summaryLink ? `Summary: ${call.summaryLink}` : '',
    call.notes ? `Notes: ${call.notes}` : '',
  ].filter(Boolean).join('\n');

  return { subject, html, text };
}

function reminderRecipients() {
  const fromEnv = String(process.env.QC_REMIND_TO || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return fromEnv.length ? fromEnv : QC_ALLOWED;
}

// Two reminders per call, each sent once: a week ahead (marked in
// reminderSentAt, fires while 2 < days ≤ 7 so a missed exact 7-day mark still
// catches up) and 2 days ahead (reminder2SentAt, fires while 0 < days ≤ 2 —
// and it alone covers calls created closer than 3 days out, so the same day
// never gets both emails). Reminders go out at 13:00 Kyiv: scheduled triggers
// pass { atHour: 13 } and are no-ops outside that hour; a manual sweep
// (no atHour) sends immediately.
export async function checkQuarterlyCallReminders({ atHour = null } = {}) {
  if (atHour !== null && kyivHour() !== atHour) {
    return { due: 0, sent: 0, skipped: `outside ${atHour}:00 Kyiv window` };
  }
  const db = await load();
  const due = [];
  for (const call of db.calls) {
    if (call.status !== 'scheduled') continue;
    const d = daysUntil(call.date);
    if (d > 2 && d <= 7 && !call.reminderSentAt)  due.push({ call, d, mark: 'reminderSentAt' });
    else if (d > 0 && d <= 2 && !call.reminder2SentAt) due.push({ call, d, mark: 'reminder2SentAt' });
  }
  let sent = 0;
  for (const { call, d, mark } of due) {
    const projectName = db.projects.find(p => p.id === call.project)?.label || call.project;
    try {
      await sendEmail({ to: reminderRecipients(), ...buildReminderEmail(call, d, projectName) });
      call[mark] = new Date().toISOString();
      call.updatedAt = call[mark];
      sent++;
      console.log(`[Quarterly calls] ${mark === 'reminderSentAt' ? 'week' : '2-day'} reminder sent: "${call.title}" on ${call.date}`);
    } catch (err) {
      // Not configured / transient SMTP failure — leave the mark unset
      // so the next check retries.
      console.warn(`[Quarterly calls] reminder failed for "${call.title}":`, err.message);
      if (err.notConfigured) break;
    }
  }
  if (sent) await save();
  return { due: due.length, sent };
}

function sanitize(body, db, existing = {}) {
  const pick = (key, fallback = '') => {
    const v = body[key];
    return v === undefined ? (existing[key] ?? fallback) : String(v).trim();
  };
  const call = {
    title:        pick('title'),
    project:      pick('project', 'ABS'),
    date:         pick('date'),
    time:         pick('time'),
    participants: pick('participants'),
    summaryLink:  pick('summaryLink'),
    miroLink:     pick('miroLink'),
    notes:        pick('notes'),
    status:       pick('status', 'scheduled'),
  };
  if (!call.title) return { error: 'title is required' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(call.date) || Number.isNaN(daysUntil(call.date))) {
    return { error: 'date must be YYYY-MM-DD' };
  }
  if (call.time && !/^\d{2}:\d{2}$/.test(call.time)) return { error: 'time must be HH:MM' };
  const knownProjects = db.projects.map(p => p.id);
  if (!knownProjects.includes(call.project)) return { error: `project must be one of ${knownProjects.join(', ')}` };
  if (!QC_STATUSES.includes(call.status)) return { error: `status must be one of ${QC_STATUSES.join(', ')}` };
  return { call };
}

export function registerQuarterlyCallsRoutes(app) {
  const canEdit = req => QC_ALLOWED.includes(String(req.authEmail || '').toLowerCase());
  // Write guard: everyone logged in may READ the calendar; only QC_ALLOWED
  // may create/update/delete or trigger reminder sends.
  const guard = (req, res, next) => {
    if (canEdit(req)) return next();
    res.status(403).json({ error: 'Quarterly Calls is read-only for this account.' });
  };
  const json = express.json({ limit: '50kb' });

  app.get('/api/quarterly-calls', async (req, res) => {
    const db = await load();
    res.json({ calls: db.calls, projects: db.projects, today: kyivToday(), storage: backend, canEdit: canEdit(req) });
  });

  // ── Project registry ──
  app.post('/api/quarterly-calls/projects', guard, json, async (req, res) => {
    const label = String(req.body?.label ?? '').trim();
    const color = String(req.body?.color ?? '').trim() || '#F472B6';
    if (!label) return res.status(400).json({ error: 'label is required' });
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return res.status(400).json({ error: 'color must be a #rrggbb hex' });
    const id = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!id) return res.status(400).json({ error: 'label must contain letters or digits' });
    const db = await load();
    if (db.projects.some(p => p.id === id)) return res.status(409).json({ error: `Project "${label}" already exists` });
    const project = { id, label, color };
    db.projects.push(project);
    const persisted = await save();
    res.json({ project, persisted });
  });

  app.delete('/api/quarterly-calls/projects/:id', guard, async (req, res) => {
    const db = await load();
    const idx = db.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Project not found' });
    const used = db.calls.filter(c => c.project === req.params.id).length;
    if (used) return res.status(409).json({ error: `Project has ${used} call(s) — delete or move them first` });
    db.projects.splice(idx, 1);
    const persisted = await save();
    res.json({ ok: true, persisted });
  });

  app.post('/api/quarterly-calls', guard, json, async (req, res) => {
    const db = await load();
    const { call, error } = sanitize(req.body ?? {}, db);
    if (error) return res.status(400).json({ error });
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), ...call, reminderSentAt: null, reminder2SentAt: null, createdAt: now, updatedAt: now };
    db.calls.push(record);
    const persisted = await save();
    res.json({ call: record, persisted });
  });

  app.put('/api/quarterly-calls/:id', guard, json, async (req, res) => {
    const db = await load();
    const idx = db.calls.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Call not found' });
    const existing = db.calls[idx];
    const { call, error } = sanitize(req.body ?? {}, db, existing);
    if (error) return res.status(400).json({ error });
    // A moved date makes the old reminders stale — re-arm both.
    const moved = call.date !== existing.date;
    const reminderSentAt  = moved ? null : existing.reminderSentAt;
    const reminder2SentAt = moved ? null : existing.reminder2SentAt;
    db.calls[idx] = { ...existing, ...call, reminderSentAt, reminder2SentAt, updatedAt: new Date().toISOString() };
    const persisted = await save();
    res.json({ call: db.calls[idx], persisted });
  });

  app.delete('/api/quarterly-calls/:id', guard, async (req, res) => {
    const db = await load();
    const before = db.calls.length;
    db.calls = db.calls.filter(c => c.id !== req.params.id);
    if (db.calls.length === before) return res.status(404).json({ error: 'Call not found' });
    const persisted = await save();
    res.json({ ok: true, persisted });
  });

  // Manual reminder sweep — sends due reminders immediately (no 13:00 gate).
  app.post('/api/quarterly-calls/check-reminders', guard, async (req, res) => {
    try {
      res.json(await checkQuarterlyCallReminders());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Vercel Cron entry point. vercel.json schedules it at 10:00 and 11:00 UTC —
  // exactly one of those is 13:00 in Kyiv year-round (EEST/EET), and the
  // atHour gate makes the other run a no-op. Exempt from the app-token
  // middleware (see AUTH_EXEMPT in api/index.js) because Vercel sends its own
  // `Authorization: Bearer $CRON_SECRET` header; verified here instead.
  app.get('/api/quarterly-calls/cron', async (req, res) => {
    const secret = (process.env.CRON_SECRET || '').trim();
    if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
    const got = Buffer.from(req.headers.authorization || '');
    const want = Buffer.from(`Bearer ${secret}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await checkQuarterlyCallReminders({ atHour: 13 });
      console.log('[Quarterly calls] cron sweep:', JSON.stringify(result));
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
