// ─── Fathom → PM Brain vault sync ─────────────────────────────────────────────
// Turns "a call happened" into "the transcript is filed under the right
// milestone in the vault", which is the copy-paste this replaces.
//
// Deliberately does NOT go through Claude's Fathom MCP connector: that one needs
// an interactive OAuth handshake, which is why the daily `fathom-risk-review`
// job has failed every run since 2026-07-24. This path uses the app's own Fathom
// OAuth token (persisted server-side by fathomToken.js) and the app's own MCP
// client, so it works unattended — on Vercel too.
//
// Flow per sweep:
//   1. list meetings in the window (MCP fast path, no LLM)
//   2. drop anything already in the ledger (`00_DASHBOARD/.calls-synced.json`,
//      keyed by Fathom recording id — titles repeat, ids don't)
//   3. per new call: transcript (+ summary) → classify project / milestone /
//      Internal-External against the REAL milestone inventory → write the note
//   4. low confidence or no milestone match → write into `Calls Inbox/` and add
//      a line to its Inbox.md, never guess a folder
//
// Routes: POST /api/fathom/vault-save (one call, from the UI),
//         POST /api/fathom/vault-sync (manual sweep),
//         GET  /api/fathom/vault-sync/cron (Vercel Cron, CRON_SECRET).

import express from 'express';
import crypto from 'node:crypto';
import {
  VAULT_PROJECTS, loadPmBrainProject, requirePmBrainOwner, pmBrainAllowed, redactSecrets,
} from './pmBrain.js';
import {
  canWriteVault, vaultTarget, readLedger, ledgerAdd,
  buildCallNote, callFileName, writeCallNote, appendInboxLine, INBOX_DIR,
} from './pmBrainWrite.js';
import { getSyncFathomToken } from './fathomToken.js';
import { markFathomSeen } from './fathomSeen.js';

// How far back a sweep looks. A call that ends at 23:50 is picked up by the
// first sweep after midnight, so the window has to cross the day boundary.
const SWEEP_HOURS = 36;

// Confidence below this goes to the Inbox instead of a milestone folder.
const MIN_CONFIDENCE = 0.6;

const iso = ms => new Date(ms).toISOString();
const dayOf = s => String(s || '').slice(0, 10);

// ─── Milestone inventory for the classifier ──────────────────────────────────

/**
 * Every candidate folder the classifier may choose from, across all vault
 * projects: `{ project, milestone, status, goal }`. Built from the vault itself
 * (not a hardcoded list) so a milestone added in Obsidian is routable the same
 * day, with no code change.
 */
async function milestoneCatalogue() {
  // Distinct vault folders — ABS, NSMG, MARKER, HYDROTEC (NSMGCM shares NSMG).
  const seen = new Set();
  const projects = [];
  for (const [appId, map] of Object.entries(VAULT_PROJECTS)) {
    if (seen.has(map.dir)) continue;
    seen.add(map.dir);
    projects.push({ appId, dir: map.dir });
  }
  const out = [];
  for (const p of projects) {
    try {
      const data = await loadPmBrainProject(p.appId);
      if (!data.available) continue;
      for (const m of data.milestones) {
        out.push({
          project: data.vaultProject,
          milestone: m.name,
          status: m.status,
          goal: (m.goal || '').slice(0, 180),
          path: m.path,
          hasCalls: m.files.length > 0,
        });
      }
      // A project with no milestone folders (HYDROTEC) still takes calls at
      // project level.
      if (!data.milestones.length) {
        out.push({ project: data.vaultProject, milestone: null, status: 'project-level', goal: '', path: `02_PROJECTS/${data.vaultProject}` });
      }
    } catch (e) {
      console.warn('[vault-sync] catalogue failed for', p.dir, e.message);
    }
  }
  return out;
}

// ─── Classifier ───────────────────────────────────────────────────────────────

const OUR_DOMAIN = /dynamicalabs\.com/i;

/**
 * Which milestone folder does this call belong to? An LLM picks from the real
 * catalogue (never invents a path); the deterministic parts — Internal vs
 * External, and the "no idea" case — are decided in code.
 *
 * Internal/External is a fact, not a judgement: a call with only
 * @dynamicalabs.com attendees is Internal. That mirrors how the vault is
 * already organised (`Calls/Internal/` vs `Calls/External/`).
 */
function kindOf(meeting) {
  const people = [...(meeting.attendees ?? []), meeting.host ?? ''].filter(Boolean);
  if (!people.length) return 'Internal';
  const outside = people.filter(p => !OUR_DOMAIN.test(p));
  return outside.length ? 'External' : 'Internal';
}

async function classifyCall({ meeting, summary, transcript, catalogue, llm }) {
  const list = catalogue.map((c, i) =>
    `${i}. project=${c.project} | milestone=${c.milestone ?? '(project level)'} | status=${c.status}${c.goal ? ` | goal: ${c.goal}` : ''}`,
  ).join('\n');

  const attendees = (meeting.attendees ?? []).join(', ');
  // The transcript head is enough: the topic is established in the first minutes,
  // and sending 100 KB per call would dominate the cost of the whole sweep.
  const head = String(transcript || '').slice(0, 6000);

  const system =
    'You route a meeting recording to exactly one folder of a PM vault. '
    + 'Choose ONLY from the numbered candidates. Answer with JSON only: '
    + '{"index": <number|null>, "confidence": <0..1>, "why": "<short reason>"}. '
    + 'index=null when no candidate clearly fits (a sales call, an unrelated client, a company-wide meeting). '
    + 'Confidence is how sure you are that this specific milestone is the subject of the call — '
    + 'be strict: a call that merely mentions a milestone in passing is not about it.';

  const user =
    `Candidates:\n${list}\n\n`
    + `Meeting title: ${meeting.title}\n`
    + `Date: ${meeting.date}\n`
    + `Attendees: ${attendees || '(unknown)'}\n`
    + (summary ? `\nFathom summary:\n${summary.slice(0, 2500)}\n` : '')
    + (head ? `\nTranscript head:\n${head}\n` : '');

  let parsed = null;
  try {
    const text = await llm({
      model: process.env.OPENROUTER_ROUTER_MODEL || process.env.OPENROUTER_EXECUTOR_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      maxTokens: 700,
      temperature: 0,
    });
    const m = /\{[\s\S]*\}/.exec(text);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (e) {
    console.warn('[vault-sync] classifier failed:', e.message);   // → unrouted
  }

  const idx = Number.isInteger(parsed?.index) ? parsed.index : null;
  const pick = idx !== null && idx >= 0 && idx < catalogue.length ? catalogue[idx] : null;
  const confidence = Number(parsed?.confidence);
  return {
    target: pick,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    why: String(parsed?.why ?? '').slice(0, 200),
  };
}

// ─── Summary + action items ───────────────────────────────────────────────────

/**
 * A short head for the note. Uses Fathom's own summary when the MCP tool has
 * one (it is written by their model and matches what the user sees in the app);
 * otherwise asks the LLM for 3–6 bullets + action items over the transcript.
 */
async function buildHead({ summary, transcript, llm }) {
  if (summary && summary.trim().length > 120) {
    return { summary: summary.trim(), actionItems: [] };
  }
  if (!transcript?.trim()) return { summary: summary?.trim() ?? '', actionItems: [] };
  try {
    const text = await llm({
      model: process.env.OPENROUTER_EXECUTOR_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Summarise a meeting transcript for a PM vault. JSON only: '
            + '{"summary": "<3-6 sentences, decisions and current status first>", "actions": ["<owner — task>", …]}. '
            + 'Always English. No invented content.',
        },
        { role: 'user', content: String(transcript).slice(0, 60000) },
      ],
      maxTokens: 1400,
      temperature: 0.2,
    });
    const m = /\{[\s\S]*\}/.exec(text);
    const parsed = m ? JSON.parse(m[0]) : null;
    return {
      summary: String(parsed?.summary ?? '').trim(),
      actionItems: Array.isArray(parsed?.actions) ? parsed.actions.map(String).slice(0, 20) : [],
    };
  } catch (e) {
    console.warn('[vault-sync] summary failed:', e.message);
    return { summary: summary?.trim() ?? '', actionItems: [] };
  }
}

// ─── Archiving one call ───────────────────────────────────────────────────────

/**
 * Where a call goes: `<milestone path>/Calls[/<sub>]`.
 * `sub` is whatever the vault already uses for that milestone — the real folders
 * are a mix of `Internal`, `External`, `Client` and loose files directly in
 * `Calls/` (that last case is `sub === ''`), so the caller passes one rather than
 * this guessing a convention.
 */
function folderFor(target, sub) {
  if (!target) return INBOX_DIR;
  const base = target.milestone
    ? `02_PROJECTS/${target.project}/Milestones/${target.milestone}`
    : `02_PROJECTS/${target.project}`;
  const clean = String(sub ?? '').replace(/^\/+|\/+$/g, '');
  return clean ? `${base}/Calls/${clean}` : `${base}/Calls`;}

async function archiveOne({ meeting, deps, catalogue, forced }) {
  const { fathomToken, fetchFathomTranscript, fetchFathomSummary, llm } = deps;
  const toolResults = [];

  const { transcript } = await fetchFathomTranscript(fathomToken, meeting.id, meeting.url, toolResults);
  const fathomSummary = await fetchFathomSummary(fathomToken, meeting, toolResults);

  const kind = forced?.kind || kindOf(meeting);
  // The subfolder is what the user picked (may be '' = loose in Calls/); the
  // automatic sweep falls back to the Internal/External split.
  const sub = forced && 'folder' in forced ? forced.folder : kind;

  // A forced target (the UI's "Save to vault", where the user picked the
  // milestone) skips the classifier entirely — no point second-guessing a human.
  let routing = forced?.target
    ? { target: forced.target, confidence: 1, why: 'chosen in the UI' }
    : await classifyCall({ meeting, summary: fathomSummary, transcript, catalogue, llm });

  const routed = routing.target && routing.confidence >= MIN_CONFIDENCE;
  const target = routed ? routing.target : null;

  const { summary, actionItems } = await buildHead({ summary: fathomSummary, transcript, llm });

  const text = buildCallNote({
    title: meeting.title,
    dateIso: meeting.date,
    url: meeting.url,
    recordingId: meeting.id,
    project: target?.project ?? '',
    milestone: target?.milestone ?? '',
    kind,
    attendees: meeting.attendees ?? [],
    summary,
    actionItems,
    transcript,
    classifier: routed
      ? `auto (${routing.confidence.toFixed(2)}): ${routing.why}`
      : `unrouted (${routing.confidence.toFixed(2)}): ${routing.why || 'no confident match'}`,
  });

  const dir = folderFor(target, sub);
  const written = await writeCallNote({
    dir,
    fileName: callFileName(meeting.title, meeting.date),
    text,
    commitMessage: `calls: ${meeting.title} (${dayOf(meeting.date)})${target ? ` → ${target.project}/${target.milestone ?? 'project level'}` : ' → inbox'}`,
  });

  if (!routed) {
    await appendInboxLine(
      `- [ ] [[${written.path.replace(/^.*\//, '').replace(/\.md$/, '')}]] — ${dayOf(meeting.date)} · `
      + `${meeting.title} · [Fathom](${meeting.url}) · ${routing.why || 'no confident match'}`,
    );
  }

  return {
    recordingId: meeting.id,
    title: meeting.title,
    date: dayOf(meeting.date),
    path: written.path,
    project: target?.project ?? null,
    milestone: target?.milestone ?? null,
    kind,
    routed,
    confidence: routing.confidence,
    why: routing.why,
    savedAt: new Date().toISOString(),
    transcriptChars: (transcript || '').length,
  };
}

// ─── Sweep ────────────────────────────────────────────────────────────────────

/**
 * @param deps  the Fathom/LLM helpers from api/index.js (injected to avoid a
 *              circular import; index.js owns the MCP client).
 */
export async function sweepFathomCalls(deps, { hours = SWEEP_HOURS, limit = 8, dryRun = false } = {}) {
  if (!canWriteVault()) {
    return { ok: false, reason: 'PM_BRAIN_GITHUB_TOKEN is not set — nothing can be written to the vault.' };
  }
  const { token, email } = await getSyncFathomToken();
  if (!token) {
    return { ok: false, reason: 'No Fathom token stored on the server. Open Fathom Agent and press Connect once.' };
  }

  const now = Date.now();
  const createdAfter  = iso(now - hours * 3600_000);
  const createdBefore = iso(now);

  const toolResults = [];
  const { meetings } = await deps.listFathomMeetingsFast({
    fathomToken: token, userEmail: email, isTeam: false, createdAfter, createdBefore, toolResults,
  });
  if (!meetings) return { ok: false, reason: 'Fathom listing tool returned nothing.', toolResults };

  const ledger = await readLedger();
  const fresh = meetings.filter(m => m.id && !ledger.calls[m.id]);
  if (!fresh.length) {
    return { ok: true, window: { createdAfter, createdBefore }, seen: meetings.length, saved: [], skipped: meetings.length };
  }
  if (dryRun) {
    return { ok: true, dryRun: true, window: { createdAfter, createdBefore }, seen: meetings.length,
      candidates: fresh.map(m => ({ id: m.id, title: m.title, date: m.date })) };
  }

  const catalogue = await milestoneCatalogue();
  const saved = [];
  const failed = [];
  // Sequential on purpose: each call means a transcript fetch + two LLM calls +
  // GitHub commits, and the ledger write must not race itself.
  for (const meeting of fresh.slice(0, limit)) {
    try {
      saved.push(await archiveOne({ meeting, deps: { ...deps, fathomToken: token }, catalogue }));
    } catch (e) {
      console.warn('[vault-sync] failed for', meeting.title, e.message);
      failed.push({ id: meeting.id, title: meeting.title, error: e.message });
    }
  }
  // Ledger last: a call is only "done" once its note exists, so a crash mid-way
  // re-tries the same call on the next sweep instead of losing it.
  if (saved.length) await ledgerAdd(saved);
  // Same for the unattended sweep — it archives as the vault owner.
  if (saved.length && email) {
    await markFathomSeen(email, saved.map(s => s.recordingId), 'moved')
      .catch(e => console.warn('[vault-sync] could not mark seen:', e.message));
  }

  return {
    ok: true,
    window: { createdAfter, createdBefore },
    seen: meetings.length,
    skipped: meetings.length - fresh.length,
    saved,
    failed,
    truncated: fresh.length > limit ? fresh.length - limit : 0,
    vault: vaultTarget(),
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export function registerFathomVaultSyncRoutes(app, deps) {
  const json = express.json({ limit: '50kb' });

  // What the UI needs to show the "Save to vault" affordance honestly. Not
  // guarded, so a non-owner's UI can hide the button instead of erroring on it.
  app.get('/api/fathom/vault-status', async (req, res) => {
    if (!pmBrainAllowed(req.authEmail)) {
      return res.json({ allowed: false, writable: false, reason: 'PM Brain is private to the vault owner.' });
    }
    try {
      const { token, email } = await getSyncFathomToken();
      res.json({
        allowed: true,
        writable: canWriteVault(),
        vault: vaultTarget(),
        syncToken: { present: !!token, email },
        ledger: canWriteVault() ? Object.keys((await readLedger()).calls).length : 0,
      });
    } catch (e) {
      res.status(500).json({ error: redactSecrets(e.message) });
    }
  });

  // Save ONE call, optionally into a folder the user picked.
  // Body: { recordingId, title, date, url, attendees[], project?, milestone?, kind? }
  app.post('/api/fathom/vault-save', requirePmBrainOwner, json, async (req, res) => {
    const { recordingId, title, date, url, attendees, host, project, milestone, kind, folder, force } = req.body ?? {};
    if (!recordingId) return res.status(400).json({ error: 'recordingId is required' });
    if (!canWriteVault()) return res.status(503).json({ error: 'PM_BRAIN_GITHUB_TOKEN is not set.' });

    const fathomToken = await deps.resolveFathomToken(req);
    if (!fathomToken) return res.status(401).json({ error: 'Fathom is not connected.', reconnect: true });

    try {
      const ledger = await readLedger();
      const existing = ledger.calls[recordingId];
      if (existing && !force) return res.json({ already: true, entry: existing });

      const meeting = {
        id: String(recordingId),
        title: title || 'Call',
        date: date || new Date().toISOString(),
        url: url || '',
        attendees: Array.isArray(attendees) ? attendees : [],
        host: host || '',
      };
      const catalogue = await milestoneCatalogue();
      // `project` present = the user chose the destination in the UI; the
      // classifier is skipped entirely. `folder` may legitimately be '' (loose in
      // Calls/), hence the `in` check rather than a truthiness test.
      const forced = project
        ? {
            target: { project, milestone: milestone || null },
            ...(kind ? { kind } : {}),
            ...('folder' in (req.body ?? {}) ? { folder } : {}),
          }
        : (kind || 'folder' in (req.body ?? {}) ? { ...(kind ? { kind } : {}), ...('folder' in (req.body ?? {}) ? { folder } : {}) } : null);

      const entry = await archiveOne({
        meeting,
        deps: { ...deps, fathomToken },
        catalogue,
        forced,
      });
      await ledgerAdd([entry]);
      // A filed call is dealt with: clear its "new" badge everywhere, not just in
      // the browser that filed it.
      await markFathomSeen(req.authEmail, [entry.recordingId], 'moved')
        .catch(e => console.warn('[vault-save] could not mark seen:', e.message));
      res.json({ saved: entry });
    } catch (e) {
      // Redacted on BOTH paths: an upstream error can quote a header value.
      const safe = redactSecrets(e.message);
      console.error('[vault-save]', safe);
      res.status(e.reconnect ? 401 : 500).json({ error: safe, ...(e.reconnect ? { reconnect: true } : {}) });
    }
  });

  // Manual sweep from the UI (same code path as the cron).
  app.post('/api/fathom/vault-sync', requirePmBrainOwner, json, async (req, res) => {
    try {
      const { hours, limit, dryRun } = req.body ?? {};
      const result = await sweepFathomCalls(deps, {
        hours: Number(hours) || SWEEP_HOURS,
        limit: Number(limit) || 8,
        dryRun: !!dryRun,
      });
      res.status(result.ok ? 200 : 503).json(result);
    } catch (e) {
      const safe = redactSecrets(e.message);
      console.error('[vault-sync]', safe);
      res.status(500).json({ error: safe });
    }
  });

  // Vercel Cron entry point — in AUTH_EXEMPT, so it verifies CRON_SECRET itself
  // (same contract as the quarterly-calls / checklist crons).
  app.get('/api/fathom/vault-sync/cron', async (req, res) => {
    const secret = process.env.CRON_SECRET;
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${secret ?? ''}`);
    const ok = !!secret && auth.length === expected.length && crypto.timingSafeEqual(auth, expected);
    if (!ok) return res.status(401).json({ error: 'Unauthorized' });
    try {
      const result = await sweepFathomCalls(deps, {});
      console.log('[vault-sync cron]', JSON.stringify({
        saved: result.saved?.length ?? 0, skipped: result.skipped, reason: result.reason,
      }));
      res.json(result);
    } catch (e) {
      const safe = redactSecrets(e.message);
      console.error('[vault-sync cron]', safe);
      res.status(500).json({ error: safe });
    }
  });
}

// Test hooks — the classifier and the Internal/External rule are the two pieces
// worth exercising without touching Fathom or GitHub.
export const __test_classify = classifyCall;
export const __test_kindOf = kindOf;
export const __test_folderFor = folderFor;
