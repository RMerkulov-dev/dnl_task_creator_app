import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { put, get } from '@vercel/blob';
import { sendEmail } from './taskNotify.js';

// ─── Checklist ────────────────────────────────────────────────────────────────
// Weekly recurring per-user TODO plan: tasks assigned to weekdays (Mon..Sun),
// each with an email-notification bell. Once a day, at 11:00 Kyiv, the belled
// tasks for that weekday are collected into ONE digest email with the subject
// "MONDAY: TODO Checklist". Unbelled tasks are never emailed. The done
// checkbox (doneOn) is purely personal — shown only while doneOn == today
// (Kyiv), so it visually clears itself once the day passes; it never affects
// the digest.
//
// Storage mirrors quarterlyCalls.js (Vercel Blob when BLOB_READ_WRITE_TOKEN is
// set, local api/data/checklist.json otherwise/as mirror) but is PER-USER:
// one document holding { users: { <email>: { tasks, sentLog } } } — every
// logged-in user sees and edits only their own list (keyed by req.authEmail).
//
// Triggers: 15-min interval on the local dev server; on Vercel two crons
// (vercel.json, 08:00 & 09:00 UTC — one is always 11:00 Kyiv across DST) hit
// GET /api/checklist/cron (AUTH_EXEMPT, verified against CRON_SECRET). Both
// pass { atHour: 11 }; sentLog.lastDate dedupes ticks inside the hour.

const DATA_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'checklist.json');
const BLOB_PATH = 'checklist/db.json';
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// In-memory working copy (authoritative within one warm instance).
let cache = null;
let backend = 'file';
let loading = null;

function normalize(db) {
  if (!db || typeof db.users !== 'object' || db.users === null) return null;
  return db;
}

function loadLocal() {
  try {
    const db = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    if (db) return db;
  } catch { /* missing or corrupt — start empty */ }
  return { users: {} };
}

function saveLocal() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2));
    return true;
  } catch (err) {
    if (!useBlob()) console.warn('[Checklist] could not persist to disk:', err.message);
    return false;
  }
}

async function blobLoad() {
  const res = await get(BLOB_PATH, { access: 'private', useCache: false });
  if (!res || !res.stream) return null;
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
          cache = loadLocal();
          await blobSave();
          console.log('[Checklist] seeded Vercel Blob store');
        }
        return cache;
      } catch (err) {
        console.warn('[Checklist] Blob load failed, using local file:', err.message);
      }
    }
    backend = 'file';
    cache = loadLocal();
    saveLocal();
    return cache;
  })().finally(() => { loading = null; });
  return loading;
}

// Drop the warm in-memory copy and re-read the store. Every serverless
// instance keeps its own `cache` for its whole warm lifetime, so a sweep that
// trusted it could not see the "already sent today" stamp another instance had
// written — that is how four identical Friday digests went out inside one
// 11:00 window. Scheduled sweeps therefore always start from storage.
async function reload() {
  cache = null;
  return load();
}

async function save() {
  const localOk = saveLocal();
  if (useBlob()) {
    try {
      await blobSave();
      return true;
    } catch (err) {
      console.warn('[Checklist] Blob save failed:', err.message);
      return localOk;
    }
  }
  return localOk;
}

function userState(db, email) {
  if (!db.users[email]) db.users[email] = { tasks: [], sentLog: {} };
  if (!Array.isArray(db.users[email].tasks))   db.users[email].tasks = [];
  if (typeof db.users[email].sentLog !== 'object' || !db.users[email].sentLog) db.users[email].sentLog = {};
  return db.users[email];
}

// ─── Kyiv time helpers ────────────────────────────────────────────────────────
function kyivToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
}

function kyivHour() {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false,
  }).format(new Date()));
}

// 0=Monday … 6=Sunday, in Kyiv.
function kyivWeekdayIdx() {
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', weekday: 'long' }).format(new Date());
  return (DAY_NAMES.indexOf(name) + 7) % 7;
}

// ─── Digest email ─────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function buildDigestEmail(weekdayIdx, tasks) {
  const day = DAY_NAMES[weekdayIdx];
  const subject = `${day.toUpperCase()}: TODO Checklist`;
  const sorted = [...tasks].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const rows = sorted.map(t => `
    <tr>
      <td style="padding:8px 12px 8px 0;color:#9ca3af;font-size:14px;vertical-align:top;
                 font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">☐</td>
      <td style="padding:8px 0;color:#111827;font-size:14px;line-height:1.45;
                 font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(t.text)}</td>
    </tr>`).join('');

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
            &nbsp;·&nbsp;TODO Checklist</span>
        </td>
      </tr>
      <tr>
        <td style="padding:28px">
          <p style="margin:0 0 14px;color:#111827;font-size:19px;font-weight:700;
                    font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(day)} — ${sorted.length} task${sorted.length === 1 ? '' : 's'}</p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:1px solid #e5e7eb">
            ${rows}
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:14px 28px;background:#f9fafb;border-top:1px solid #e5e7eb">
          <p style="margin:0;color:#9ca3af;font-size:12px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
            Automated digest from the Checklist app (DNL Tasks Creator).</p>
        </td>
      </tr>
    </table>
  </td></tr>
</table>`;

  const text = [`${day} — TODO Checklist`, '', ...sorted.map(t => `[ ] ${t.text}`)].join('\n');
  return { subject, html, text };
}

// Today's belled tasks for a user (weekday in Kyiv).
function belledToday(u, weekdayIdx) {
  return u.tasks.filter(t => t.day === weekdayIdx && t.notify);
}

// ─── Reminder sweep ───────────────────────────────────────────────────────────
// One digest per user per day at 11:00 Kyiv: scheduled triggers pass
// { atHour: 11 } and are no-ops outside that hour; a manual sweep (no atHour)
// sends immediately. The 11:00 gate is a whole hour wide and several triggers
// can fire inside it (both Vercel crons, a cron retry, another warm instance,
// the local dev sweep), so sentLog.lastDate is the ONLY thing keeping it to one
// email — hence: re-read the store first (never the warm cache) and persist the
// stamp BEFORE sending, releasing it again if the send fails.
export async function checkChecklistReminders({ atHour = null, source = 'manual' } = {}) {
  if (atHour !== null && kyivHour() !== atHour) {
    return { due: 0, sent: 0, skipped: `outside ${atHour}:00 Kyiv window` };
  }
  const db = await reload();
  const today = kyivToday();
  const wd = kyivWeekdayIdx();
  let due = 0, sent = 0, blocked = 0;

  for (const [email, u] of Object.entries(db.users)) {
    const tasks = belledToday(u, wd);
    if (!tasks.length) continue;
    if (u.sentLog?.lastDate === today) continue;   // already sent today
    due++;

    // Claim the day first: a concurrent or later trigger re-reads the store,
    // sees today's stamp and skips. Sending first and stamping afterwards left
    // a window in which every extra trigger sent its own copy.
    const prev = u.sentLog;
    u.sentLog = { lastDate: today, sentAt: new Date().toISOString(), source };
    if (!(await save())) {
      // Nothing durable to dedupe against — skip rather than risk a repeat;
      // the next tick inside this hour retries.
      u.sentLog = prev;
      blocked++;
      console.warn(`[Checklist] storage unavailable — digest for ${email} skipped to avoid duplicates`);
      continue;
    }

    try {
      await sendEmail({ to: [email], ...buildDigestEmail(wd, tasks) });
      sent++;
      console.log(`[Checklist] digest sent to ${email} (${DAY_NAMES[wd]}, ${tasks.length} tasks, source=${source})`);
    } catch (err) {
      u.sentLog = prev;            // release the claim so a later tick retries
      await save();
      console.warn(`[Checklist] digest failed for ${email}:`, err.message);
      if (err.notConfigured) return { due, sent, error: 'SMTP is not configured' };
    }
  }
  return { due, sent, ...(blocked ? { blocked } : {}) };
}

// ─── Validation ───────────────────────────────────────────────────────────────
function sanitizeTask(body, existing = {}) {
  const day = body.day === undefined ? existing.day : Number(body.day);
  if (!Number.isInteger(day) || day < 0 || day > 6) return { error: 'day must be 0 (Monday) … 6 (Sunday)' };

  const text = body.text === undefined ? existing.text : String(body.text).trim();
  if (!text) return { error: 'text is required' };
  if (text.length > 300) return { error: 'text must be ≤ 300 characters' };

  const notify = body.notify === undefined ? (existing.notify ?? true) : Boolean(body.notify);

  let doneOn = body.doneOn === undefined ? (existing.doneOn ?? null) : body.doneOn;
  if (doneOn !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(doneOn))) return { error: 'doneOn must be YYYY-MM-DD or null' };

  return { task: { day, text, notify, doneOn } };
}

// ─── Routes ───────────────────────────────────────────────────────────────────
export function registerChecklistRoutes(app) {
  const json = express.json({ limit: '100kb' });
  const emailOf = req => String(req.authEmail || '').toLowerCase();

  app.get('/api/checklist', async (req, res) => {
    const db = await load();
    const u = userState(db, emailOf(req));
    res.json({ tasks: u.tasks, today: kyivToday(), weekday: kyivWeekdayIdx(), storage: backend });
  });

  app.post('/api/checklist/tasks', json, async (req, res) => {
    const db = await load();
    const u = userState(db, emailOf(req));
    const { task, error } = sanitizeTask(req.body ?? {});
    if (error) return res.status(400).json({ error });
    const now = new Date().toISOString();
    const record = { id: crypto.randomUUID(), ...task, createdAt: now, updatedAt: now };
    u.tasks.push(record);
    const persisted = await save();
    res.json({ task: record, persisted });
  });

  app.put('/api/checklist/tasks/:id', json, async (req, res) => {
    const db = await load();
    const u = userState(db, emailOf(req));
    const idx = u.tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Task not found' });
    const { task, error } = sanitizeTask(req.body ?? {}, u.tasks[idx]);
    if (error) return res.status(400).json({ error });
    u.tasks[idx] = { ...u.tasks[idx], ...task, updatedAt: new Date().toISOString() };
    const persisted = await save();
    res.json({ task: u.tasks[idx], persisted });
  });

  app.delete('/api/checklist/tasks/:id', async (req, res) => {
    const db = await load();
    const u = userState(db, emailOf(req));
    const before = u.tasks.length;
    u.tasks = u.tasks.filter(t => t.id !== req.params.id);
    if (u.tasks.length === before) return res.status(404).json({ error: 'Task not found' });
    const persisted = await save();
    res.json({ ok: true, persisted });
  });

  // Manual test send: emails today's belled digest to the requesting user
  // immediately, ignoring the time gate and sentLog (the scheduled sends are
  // unaffected).
  app.post('/api/checklist/send-now', async (req, res) => {
    const db = await load();
    const email = emailOf(req);
    const u = userState(db, email);
    const wd = kyivWeekdayIdx();
    const tasks = belledToday(u, wd);
    if (!tasks.length) return res.json({ sent: 0, reason: 'No belled tasks for today' });
    try {
      await sendEmail({ to: [email], ...buildDigestEmail(wd, tasks) });
      res.json({ sent: 1, tasks: tasks.length });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Vercel Cron entry point. vercel.json schedules it at 08:00 and 09:00 UTC —
  // exactly one of those is 11:00 in Kyiv year-round (EEST/EET), and the
  // atHour gate makes the other run a no-op. Exempt from the app-token
  // middleware (AUTH_EXEMPT in api/index.js); verified against CRON_SECRET.
  app.get('/api/checklist/cron', async (req, res) => {
    const secret = (process.env.CRON_SECRET || '').trim();
    if (!secret) return res.status(503).json({ error: 'CRON_SECRET is not configured' });
    const got = Buffer.from(req.headers.authorization || '');
    const want = Buffer.from(`Bearer ${secret}`);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const result = await checkChecklistReminders({ atHour: 11, source: 'cron' });
      console.log('[Checklist] cron sweep:', JSON.stringify(result));
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });
}
