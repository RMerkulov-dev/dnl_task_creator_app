// ─── Fathom call read-state ───────────────────────────────────────────────────
// "Which calls have I already dealt with?" — per user, server-side.
//
// Three states a call can be in, in priority order:
//   • archived — its transcript is in the vault (the ledger in pmBrainWrite.js is
//     the authority; a successful vault-save also stamps it here as `moved`, so
//     the state survives on a device that cannot read the ledger);
//   • seen     — explicitly marked read here ("dealt with, not filed");
//   • new      — everything else that happened AFTER the baseline.
//
// **The baseline is the whole trick.** It is stamped the first time a user reads
// this state and means "everything that exists right now is old". Without it,
// turning the feature on would light up every call in the account as new.
//
// Server-side rather than localStorage (the pattern PM › Status uses for Azure
// comments) because this state has to agree across the laptop and the phone —
// a call filed from one must not still look new on the other.

import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { put, get } from '@vercel/blob';

const DATA_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const DATA_FILE = path.join(DATA_DIR, 'fathom-seen.json');
const BLOB_PATH = 'fathom/seen.json';
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

// Keep the map bounded: a call older than this is "old" by date anyway, so its
// individual mark carries no information.
const MAX_SEEN_PER_USER = 500;

let cache = null;
let backend = 'file';
let loading = null;

const emailOf = e => String(e || '').trim().toLowerCase();

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
    if (!useBlob()) console.warn('[FathomSeen] could not persist to disk:', err.message);
    return false;
  }
}

async function blobLoad() {
  const res = await get(BLOB_PATH, { access: 'private', useCache: false });
  if (!res || !res.stream) return null;
  const text = await new Response(res.stream).text();
  return normalize(JSON.parse(text));
}

async function load() {
  if (cache) return cache;
  if (loading) return loading;
  loading = (async () => {
    if (useBlob()) {
      try {
        cache = (await blobLoad()) ?? { users: {} };
        backend = 'blob';
      } catch (err) {
        console.warn('[FathomSeen] blob load failed, using file:', err.message);
        backend = 'file';
        cache = loadLocal();
      }
    } else {
      backend = 'file';
      cache = loadLocal();
    }
    return cache;
  })();
  try { return await loading; } finally { loading = null; }
}

async function save() {
  const local = saveLocal();
  if (!useBlob()) return local;
  try {
    await put(BLOB_PATH, JSON.stringify(cache, null, 2), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return true;
  } catch (err) {
    console.warn('[FathomSeen] blob save failed:', err.message);
    return local;
  }
}

function userState(db, email) {
  const key = emailOf(email);
  if (!db.users[key]) {
    db.users[key] = { baselineAt: null, seen: {} };
  }
  const u = db.users[key];
  if (!u.seen || typeof u.seen !== 'object') u.seen = {};
  return u;
}

// Drop the oldest marks once the map grows past the cap (insertion order is
// preserved by JS objects for string keys, which is good enough here).
function trim(u) {
  const ids = Object.keys(u.seen);
  if (ids.length <= MAX_SEEN_PER_USER) return;
  for (const id of ids.slice(0, ids.length - MAX_SEEN_PER_USER)) delete u.seen[id];
}

/**
 * Mark calls as dealt with. `via`: 'read' (manual) | 'moved' (archived to the
 * vault) | 'bulk'. Exported so vault-save can stamp it without an HTTP hop.
 */
export async function markFathomSeen(email, ids, via = 'read') {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  if (!list.length) return { marked: 0 };
  const db = await load();
  const u = userState(db, email);
  const at = new Date().toISOString();
  for (const id of list) u.seen[id] = { at, via };
  trim(u);
  await save();
  return { marked: list.length };
}

export async function unmarkFathomSeen(email, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean);
  const db = await load();
  const u = userState(db, email);
  let n = 0;
  for (const id of list) if (u.seen[id]) { delete u.seen[id]; n++; }
  if (n) await save();
  return { unmarked: n };
}

/**
 * The read-state for one user. Stamps the baseline on first use — that is what
 * makes "everything that exists today" old and tomorrow's calls new.
 */
export async function getFathomSeen(email, { stampBaseline = true } = {}) {
  const db = await load();
  const u = userState(db, email);
  let stamped = false;
  if (!u.baselineAt && stampBaseline) {
    u.baselineAt = new Date().toISOString();
    stamped = true;
    await save();
  }
  return {
    backend,
    baselineAt: u.baselineAt,
    baselineJustSet: stamped,
    seen: u.seen,
  };
}

/** Move the baseline (the "everything up to now is old" button). */
export async function resetFathomBaseline(email, when = null) {
  const db = await load();
  const u = userState(db, email);
  u.baselineAt = when || new Date().toISOString();
  await save();
  return { baselineAt: u.baselineAt };
}

export function registerFathomSeenRoutes(app) {
  const json = express.json({ limit: '100kb' });

  app.get('/api/fathom/seen', async (req, res) => {
    try { res.json(await getFathomSeen(req.authEmail)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/fathom/seen', json, async (req, res) => {
    try {
      const { ids, via } = req.body ?? {};
      res.json(await markFathomSeen(req.authEmail, ids, via === 'moved' ? 'moved' : (via || 'read')));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/fathom/seen', json, async (req, res) => {
    try { res.json(await unmarkFathomSeen(req.authEmail, req.body?.ids)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // "Treat everything as old from now on."
  app.post('/api/fathom/seen/baseline', json, async (req, res) => {
    try { res.json(await resetFathomBaseline(req.authEmail, req.body?.at)); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
}
