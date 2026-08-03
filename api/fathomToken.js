// ─── Fathom token store ───────────────────────────────────────────────────────
// Server-side persistence for the per-user Fathom MCP OAuth token.
//
// Why this exists: until now the access token lived ONLY in the browser's
// localStorage, so nothing unattended could reach Fathom. The daily
// `fathom-risk-review` job proved the cost of that — it has failed every run
// since 2026-07-24 ("Fathom MCP server is not connected") because the claude.ai
// Fathom connector needs an interactive OAuth handshake that a headless run
// cannot do. Anything scheduled (the call→vault sweep, and later the risk
// review) needs a token the SERVER owns and can refresh.
//
// Storage mirrors quarterlyCalls.js / checklistRoutes.js: Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set, else a local file (also kept as a best-effort
// mirror). One document: { users: { <email>: entry } }.
//
// A token entry is only as good as what Fathom hands back. If the token
// response carries a refresh_token we can keep the connection alive forever; if
// it does NOT (their OAuth may issue access tokens only), the entry expires and
// `status()` says so, so the UI can ask for one click instead of silently
// failing at 3 a.m.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { put, get } from '@vercel/blob';
import { pmBrainAllowed } from './pmBrain.js';

const DATA_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const DATA_FILE = path.join(DATA_DIR, 'fathom-tokens.json');
const BLOB_PATH = 'fathom/tokens.json';
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);

const FATHOM_OAUTH_TOKEN_URL = 'https://api.fathom.ai/mcp/oauth/token';

// Refresh this far before the stated expiry, so a sweep never starts with a
// token that dies mid-run.
const REFRESH_MARGIN_MS = 5 * 60_000;

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
    fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    if (!useBlob()) console.warn('[FathomToken] could not persist to disk:', err.message);
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
        const remote = await blobLoad();
        backend = 'blob';
        cache = remote ?? { users: {} };
      } catch (err) {
        console.warn('[FathomToken] blob load failed, falling back to file:', err.message);
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
    console.warn('[FathomToken] blob save failed:', err.message);
    return local;
  }
}

/** Drop the warm copy so the next read comes from storage. */
export async function reload() {
  cache = null;
  return load();
}

/**
 * Store what the OAuth callback got. `clientId` and `redirectUri` are part of
 * the entry because a refresh needs the exact same (dynamically registered)
 * client — without them a stored refresh_token is unusable.
 */
export async function saveFathomToken(email, tok, { clientId, redirectUri } = {}) {
  const key = emailOf(email);
  if (!key) return null;
  const db = await load();
  const prev = db.users[key] ?? {};
  const entry = {
    accessToken:  tok.access_token,
    // Fathom may omit refresh_token; keep any earlier one rather than losing it.
    refreshToken: tok.refresh_token || prev.refreshToken || null,
    scope:        tok.scope || prev.scope || 'mcp',
    clientId:     clientId || prev.clientId || null,
    redirectUri:  redirectUri || prev.redirectUri || null,
    expiresAt:    tok.expires_in ? Date.now() + Number(tok.expires_in) * 1000 : null,
    connectedAt:  prev.connectedAt || new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
  };
  db.users[key] = entry;
  await save();
  return entry;
}

async function refreshEntry(key, entry) {
  if (!entry.refreshToken || !entry.clientId) return null;
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: entry.refreshToken,
    client_id:     entry.clientId,
  });
  const r = await fetch(FATHOM_OAUTH_TOKEN_URL, {
    method:  'POST',
    signal:  AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body:    body.toString(),
  });
  const text = await r.text();
  if (!r.ok) {
    console.warn(`[FathomToken] refresh failed for ${key} (${r.status}): ${text.slice(0, 160)}`);
    // A refused refresh token is dead — mark it so `status()` asks for a reconnect
    // instead of retrying every sweep.
    const db = await load();
    if (db.users[key]) {
      db.users[key].refreshError = `${r.status}: ${text.slice(0, 120)}`;
      db.users[key].updatedAt = new Date().toISOString();
      await save();
    }
    return null;
  }
  let tok;
  try { tok = JSON.parse(text); } catch { return null; }
  if (!tok.access_token) return null;
  return saveFathomToken(key, tok, { clientId: entry.clientId, redirectUri: entry.redirectUri });
}

const isFresh = e => !!e?.accessToken && (!e.expiresAt || e.expiresAt - Date.now() > REFRESH_MARGIN_MS);

/**
 * A usable access token for one user, refreshing first when it is about to
 * expire. Returns null when there is nothing stored or the refresh failed.
 */
export async function getFathomToken(email) {
  const key = emailOf(email);
  const db = await load();
  let entry = db.users[key];
  if (!entry?.accessToken) return null;
  if (isFresh(entry)) return entry.accessToken;
  entry = await refreshEntry(key, entry);
  return entry?.accessToken ?? null;
}

/**
 * The token unattended jobs run as. `FATHOM_SYNC_EMAIL` pins it explicitly;
 * otherwise the most recently updated entry wins — with a single-PM vault that
 * is the right answer and needs no extra env var.
 */
export async function getSyncFathomToken() {
  const db = await load();
  // A pinned address must still be an owner — otherwise setting FATHOM_SYNC_EMAIL
  // would quietly bypass the PM_BRAIN_ALLOWED guard the routes enforce.
  const pinned = emailOf(process.env.FATHOM_SYNC_EMAIL);
  if (pinned) {
    if (!pmBrainAllowed(pinned)) {
      console.warn(`[FathomToken] FATHOM_SYNC_EMAIL=${pinned} is not in PM_BRAIN_ALLOWED — ignoring it.`);
    } else {
      return { email: pinned, token: await getFathomToken(pinned) };
    }
  }
  // Only an owner's token may drive the unattended sweep — otherwise a teammate
  // connecting Fathom would silently become the account whose calls get archived
  // into someone else's vault.
  const entries = Object.entries(db.users)
    .filter(([key]) => pmBrainAllowed(key))
    .sort((a, b) => String(b[1].updatedAt).localeCompare(String(a[1].updatedAt)));
  for (const [key] of entries) {
    const token = await getFathomToken(key);
    if (token) return { email: key, token };
  }
  return { email: null, token: null };
}

/** What the UI needs to explain the connection, without leaking the token. */
export async function fathomTokenStatus(email) {
  const db = await load();
  const key = emailOf(email);
  const entry = db.users[key];
  const users = Object.keys(db.users);
  return {
    backend,
    stored:      !!entry?.accessToken,
    refreshable: !!(entry?.refreshToken && entry?.clientId),
    expiresAt:   entry?.expiresAt ?? null,
    expired:     !!(entry?.expiresAt && entry.expiresAt <= Date.now()),
    connectedAt: entry?.connectedAt ?? null,
    updatedAt:   entry?.updatedAt ?? null,
    refreshError: entry?.refreshError ?? null,
    // Unattended jobs use whichever entry is freshest — surface that so it is
    // obvious the sweep has (or has not) got a token to work with.
    syncUsers:   users,
  };
}

export async function forgetFathomToken(email) {
  const key = emailOf(email);
  const db = await load();
  if (!db.users[key]) return false;
  delete db.users[key];
  await save();
  return true;
}
