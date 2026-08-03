// ─── PM Brain — writer ────────────────────────────────────────────────────────
// The ONLY module that writes into the PM vault. Reading lives in pmBrain.js.
//
// Writes go through the **GitHub Contents API** to the vault's private mirror
// (`RMerkulov-dev/projects_wiki`), which is what makes this work from Vercel
// where no vault directory exists. obsidian-git pulls the commit into the local
// vault on its next interval (10 min), so a call saved from the phone shows up
// in Obsidian by itself.
//
// Two invariants:
//   1. **Never overwrite.** Every write is create-only (`PUT` without `sha`); a
//      409/422 from GitHub means the path already exists and we pick a new one.
//      A call transcript is append-only history — silently replacing a file the
//      user has edited by hand would be the worst failure mode here.
//   2. **Dedupe on the Fathom recording id, not the title.** The vault has
//      "ABS Bureau and Group Only - July 08 / 17 / 22 / 29" — titles repeat by
//      design. The ledger below is the memory of what has been archived.

import { envValue, redactSecrets } from './pmBrain.js';

const GH_API = 'https://api.github.com';

// Read LAZILY, never into a module-level const: `dotenv.config()` runs in the
// body of api/index.js, which executes AFTER every imported module has been
// evaluated. A `const GH_TOKEN = process.env.…` here is therefore always '' —
// that is exactly why the vault looked unwritable with the token sitting in .env.
// envValue() also guards against a multi-line paste: a value carrying the next
// line of a .env file cannot go into an Authorization header at all.
const ghRepo   = () => envValue('PM_BRAIN_REPO')   || 'RMerkulov-dev/projects_wiki';
const ghBranch = () => envValue('PM_BRAIN_BRANCH') || 'main';

/**
 * The PAT, checked BEFORE it reaches a header. `fetch()` reports an invalid
 * header value by quoting the value itself, so a malformed token has to be
 * rejected here — with a message that names the variable and never its content.
 */
function ghToken() {
  const token = envValue('PM_BRAIN_GITHUB_TOKEN') || envValue('GITHUB_TOKEN');
  if (!token) return '';
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('PM_BRAIN_GITHUB_TOKEN is not a valid header value (it contains a space, newline or non-ASCII character). Re-paste just the token, on one line.');
  }
  return token;
}

export const LEDGER_PATH = '00_DASHBOARD/.calls-synced.json';
export const INBOX_DIR   = '00_DASHBOARD/Calls Inbox';

export const canWriteVault = () => {
  try { return Boolean(ghToken()); } catch { return false; }
};

const ghHeaders = (accept = 'application/vnd.github+json') => ({
  Authorization: `Bearer ${ghToken()}`,
  Accept: accept,
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'dnl-tasks-creator',
  'Content-Type': 'application/json',
});

const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

async function ghGet(path) {
  const r = await fetch(
    `${GH_API}/repos/${ghRepo()}/contents/${encodePath(path)}?ref=${encodeURIComponent(ghBranch())}`,
    { headers: ghHeaders(), signal: AbortSignal.timeout(20_000) },
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(redactSecrets(`GitHub GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`));
  return r.json();     // { content (base64), sha, ... }
}

const b64decode = c => Buffer.from(String(c || ''), 'base64').toString('utf8');
const b64encode = t => Buffer.from(t, 'utf8').toString('base64');

/**
 * Create a file. Returns { path, commit } on success, or `{ exists: true }` when
 * the path is taken — the caller decides whether to suffix and retry.
 */
async function ghCreate(path, text, message) {
  const r = await fetch(`${GH_API}/repos/${ghRepo()}/contents/${encodePath(path)}`, {
    method: 'PUT',
    headers: ghHeaders(),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ message, content: b64encode(text), branch: ghBranch() }),
  });
  if (r.status === 409 || r.status === 422) return { exists: true };
  if (!r.ok) throw new Error(redactSecrets(`GitHub PUT ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`));
  const data = await r.json();
  return { path, commit: data.commit?.sha ?? null };
}

/** Update a file we own (the ledger), with an optimistic-concurrency retry. */
async function ghUpdate(path, mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await ghGet(path);
    const text = cur ? b64decode(cur.content) : null;
    const next = mutate(text);
    if (next === null) return { skipped: true };
    const r = await fetch(`${GH_API}/repos/${ghRepo()}/contents/${encodePath(path)}`, {
      method: 'PUT',
      headers: ghHeaders(),
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        message, content: b64encode(next), branch: ghBranch(),
        ...(cur?.sha ? { sha: cur.sha } : {}),
      }),
    });
    if (r.ok) return { path };
    // 409 = someone else committed between our read and write: re-read and redo.
    if (r.status !== 409 && r.status !== 422) {
      throw new Error(redactSecrets(`GitHub PUT ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`));
    }
  }
  throw new Error(`GitHub PUT ${path}: gave up after 3 conflicting attempts`);
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

/**
 * `{ calls: { <recordingId>: { path, title, date, savedAt, project, milestone } } }`
 * A single small JSON file is the cheapest reliable dedupe: the Contents API
 * cannot grep for a frontmatter id, and re-listing the whole tree per sweep just
 * to look for one call is wasteful.
 */
export async function readLedger() {
  const file = await ghGet(LEDGER_PATH);
  if (!file) return { calls: {} };
  try {
    const parsed = JSON.parse(b64decode(file.content));
    return parsed && typeof parsed.calls === 'object' ? parsed : { calls: {} };
  } catch {
    // A corrupt ledger must not make the sweep re-archive everything: fail loud.
    throw new Error(`${LEDGER_PATH} is not valid JSON — fix or delete it in the vault`);
  }
}

export async function ledgerAdd(entries) {
  if (!entries.length) return;
  await ghUpdate(LEDGER_PATH, (text) => {
    let db = { calls: {} };
    if (text) {
      try { db = JSON.parse(text); } catch { db = { calls: {} }; }
      if (!db.calls) db.calls = {};
    }
    for (const e of entries) db.calls[e.recordingId] = e;
    db.updatedAt = new Date().toISOString();
    return `${JSON.stringify(db, null, 2)}\n`;
  }, `calls: archived ${entries.length} call${entries.length === 1 ? '' : 's'}`);
}

// ─── Call file ────────────────────────────────────────────────────────────────

// Filename shape follows what is already in the vault: "<Title> - July 29".
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const safeName = s => String(s || 'Call')
  .replace(/[\\/:*?"<>|#[\]]/g, ' ')      // illegal in paths / Obsidian links
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 90) || 'Call';

export function callFileName(title, dateIso) {
  const d = dateIso ? new Date(dateIso) : null;
  const stamp = d && !Number.isNaN(d.getTime())
    ? ` - ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}`
    : '';
  return `${safeName(title)}${stamp}.md`;
}

const yamlStr = v => {
  const s = String(v ?? '');
  return /^[\w .@:/+-]*$/.test(s) && s.trim() === s ? s : JSON.stringify(s);
};

/**
 * The archived call file: a small readable head (frontmatter → summary → action
 * items) over the full transcript exactly as Fathom exports it. The head is what
 * makes the file usable — the transcripts in this vault run to 100 KB, and
 * scrolling one to find "what did we decide" is the actual pain.
 */
export function buildCallNote({
  title, dateIso, url, recordingId, project, milestone, kind,
  attendees = [], summary = '', actionItems = [], transcript = '',
  classifier = null,
}) {
  const fm = [
    '---',
    'type: call',
    `project: ${yamlStr(project || '')}`,
    `milestone: ${yamlStr(milestone || '')}`,
    `date: ${(dateIso || '').slice(0, 10)}`,
    `fathom_id: ${yamlStr(recordingId || '')}`,
    `fathom_url: ${yamlStr(url || '')}`,
    `kind: ${yamlStr(kind || '')}`,
    attendees.length ? `attendees:\n${attendees.map(a => `  - ${yamlStr(a)}`).join('\n')}` : 'attendees: []',
    'tags:',
    '  - call',
    `source: fathom-sync`,
    `synced: ${new Date().toISOString()}`,
    ...(classifier ? [`routing: ${yamlStr(classifier)}`] : []),
    '---',
    '',
  ].join('\n');

  const head = [
    `# ${title || 'Call'}`,
    '',
    ...(project ? [`> Project:: [[${project}]]`] : []),
    ...(milestone ? [`> Milestone:: [[${milestone}]]`] : []),
    ...(url ? [`> Recording:: [Fathom](${url})`] : []),
    ...(attendees.length ? [`> Attendees:: ${attendees.join(', ')}`] : []),
    '',
    '',
  ].join('\n');

  const summaryBlock = summary
    ? `## Summary\n\n${summary.trim()}\n\n`
    : '';

  const actionBlock = actionItems.length
    ? `## Action items\n\n${actionItems.map(a => `- [ ] ${a}`).join('\n')}\n\n`
    : '';

  const body = transcript?.trim()
    ? `## Transcript\n\n${transcript.trim()}\n`
    : '## Transcript\n\n_Fathom returned no transcript for this recording._\n';

  return `${fm}${head}${summaryBlock}${actionBlock}${body}`;
}

/**
 * Write one call note. `dir` is the folder it belongs in; a taken filename gets
 * ` (2)`, ` (3)`… rather than overwriting anything.
 */
export async function writeCallNote({ dir, fileName, text, commitMessage }) {
  const base = fileName.replace(/\.md$/, '');
  for (let n = 1; n <= 5; n++) {
    const name = n === 1 ? `${base}.md` : `${base} (${n}).md`;
    const res = await ghCreate(`${dir}/${name}`, text, commitMessage);
    if (!res.exists) return res;
  }
  throw new Error(`Could not find a free filename for "${base}" in ${dir}`);
}

/** Append one line to the Calls Inbox note for a call we could not route. */
export async function appendInboxLine(line) {
  const path = `${INBOX_DIR}/Inbox.md`;
  await ghUpdate(path, (text) => {
    const header = [
      '---',
      'type: calls-inbox',
      'tags:',
      '  - call',
      '---',
      '',
      '# Calls Inbox',
      '',
      '_Calls the sync could not route confidently. Move the linked note into the right',
      '`Milestones/<M>/Calls/` folder and delete the line._',
      '',
    ].join('\n');
    const body = text && text.includes('# Calls Inbox') ? text : header;
    return `${body.replace(/\s*$/, '')}\n${line}\n`;
  }, 'calls: inbox line');
  return path;
}

export const vaultTarget = () => ({ repo: ghRepo(), branch: ghBranch(), writable: canWriteVault() });
