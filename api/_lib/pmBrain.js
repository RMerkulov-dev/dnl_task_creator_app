// ─── PM Brain — read-only bridge to the Obsidian PM vault ─────────────────────
// Feeds the Health app's Risks and Milestones tabs. Parsing lives in
// pmBrainParse.js; this file owns *where the markdown comes from* and the HTTP
// routes. It NEVER writes to the vault.
//
// Two sources, picked automatically (same shape as quarterlyCalls.js's
// Blob-or-local-file):
//   • `fs`     — a local vault directory (`PM_BRAIN_PATH`, default
//                `~/Vaults/PM Brain`). Read fresh on every request: the whole
//                vault is ~200 small files, so a cache would only serve stale
//                data while you edit in Obsidian.
//   • `github` — the vault's private git mirror (`PM_BRAIN_REPO`, default
//                `RMerkulov-dev/projects_wiki`) via the REST API with
//                `PM_BRAIN_GITHUB_TOKEN`. This is what makes the tabs work on
//                Vercel, where no vault directory exists. One recursive tree
//                call + one raw read per file, cached for GITHUB_TTL_MS.
// If neither is configured the routes answer 503 with `{ available: false }`
// and the UI shows a banner instead of an error.

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  parseMilestoneHub, parseTimeline, parseTodo, parseBlockers,
  parseRbs, parseRiskGraph, parseRiskDossier, parseFrontmatter,
} from './pmBrainParse.js';

const PROJECTS_DIR = '02_PROJECTS';
const RISKS_DIR    = '00_DASHBOARD/Risks';
const GRAPH_FILE   = `${RISKS_DIR}/Risk Graph.md`;
const GITHUB_TTL_MS = 5 * 60 * 1000;

/**
 * App project id → vault folder + the risk-graph slugs that belong to it.
 * The vault's own project map (`~/.claude/skills/fathom-risk-review/references/
 * project-map.md`) is the authority for the slugs: five buckets, ABS / NSMG /
 * NSMGCM / NSMGM / HYDROTEC, sharing one `<SLUG>-NN` id space.
 * NSMGCM lives inside the NSMG folder (its work is the "Case Entity Migration"
 * milestone), which is why two app projects map onto one vault folder.
 */
export const VAULT_PROJECTS = {
  ABS:         { dir: 'ABS',      slugs: ['ABS'] },
  NSMG:        { dir: 'NSMG',     slugs: ['NSMG'] },
  NSMG_MARKER: { dir: 'MARKER',   slugs: ['NSMGM'] },
  NSMGCM:      { dir: 'NSMG',     slugs: ['NSMGCM'] },
  HT:          { dir: 'HYDROTEC', slugs: ['HYDROTEC'] },
};

// ── Who may touch the vault ──────────────────────────────────────────────────
// The PM vault is one person's second brain: it holds internal risk scoring,
// client-sensitive blockers and meeting transcripts. Every other app here is
// team-wide, so this one is explicitly NOT: reading and writing are restricted to
// PM_BRAIN_ALLOWED (default: the vault owner), and every route answers 403 for
// anyone else. Same convention as QC_ALLOWED in quarterlyCalls.js.
const PM_BRAIN_ALLOWED = ['roman.merkulov@dynamicalabs.com'];

export function pmBrainAllowed(email) {
  const fromEnv = String(process.env.PM_BRAIN_ALLOWED || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const list = fromEnv.length ? fromEnv : PM_BRAIN_ALLOWED;
  return list.includes(String(email || '').trim().toLowerCase());
}

/** Express guard: 403 unless the signed-in user owns the vault. */
export function requirePmBrainOwner(req, res, next) {
  if (pmBrainAllowed(req.authEmail)) return next();
  res.status(403).json({
    available: false,
    forbidden: true,
    reason: 'PM Brain is private to the vault owner.',
  });
}

/**
 * An env value as a single clean line.
 *
 * Pasting a secret into a dashboard (or copying it out of `.env`) regularly drags
 * along the following lines. A multi-line value then blows up as
 * `Headers.append: "Bearer …\n# Optional overrides…" is an invalid header value`
 * — an error that says nothing about where it came from. Take the first
 * non-empty, non-comment line and strip quotes, so a sloppy paste still works and
 * says so once in the log.
 */
let envWarned = new Set();
export function envValue(name) {
  const raw = process.env[name];
  if (!raw) return '';
  const lines = String(raw).split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const first = lines.find(l => !l.startsWith('#')) ?? '';
  // Warn only about a genuinely multi-line value; stripping surrounding quotes is
  // routine and must not produce log noise.
  if (lines.length > 1 && !envWarned.has(name)) {
    envWarned.add(name);
    console.warn(`[env] ${name} spans ${lines.length} lines — using the first one. Re-paste it as a single value.`);
  }
  return first.replace(/^["']|["']$/g, '').trim();
}

/**
 * Strip secrets out of anything that may be shown to a user or logged.
 *
 * This is not paranoia: `fetch()` itself puts the offending HEADER VALUE into its
 * exception message (`Headers.append: "Bearer github_pat_…" is an invalid header
 * value`), and that message was being handed straight to the UI. Redact by
 * pattern AND by the live env values, so a future error path cannot leak them
 * either.
 */
const SECRET_ENV = ['PM_BRAIN_GITHUB_TOKEN', 'GITHUB_TOKEN', 'CRON_SECRET', 'JIRA_API_TOKEN'];
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9_]{10,}/g,
  /github_pat_[A-Za-z0-9_]{10,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const name of SECRET_ENV) {
    const raw = process.env[name];
    if (!raw) continue;
    for (const piece of String(raw).split(/[\r\n]+/).map(s => s.trim()).filter(s => s.length > 7)) {
      out = out.split(piece).join('<redacted>');
    }
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, m => (/^bearer/i.test(m) ? 'Bearer <redacted>' : '<redacted>'));
  return out;
}

const expandHome = p => (p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// Lazily, for the same reason as in pmBrainWrite.js: imported modules are
// evaluated before `dotenv.config()` runs in api/index.js, so anything read into
// a module-level const here would be undefined in the local dev server.
const vaultPath = () => expandHome(envValue('PM_BRAIN_PATH') || '~/Vaults/PM Brain');
const ghRepo    = () => envValue('PM_BRAIN_REPO')   || 'RMerkulov-dev/projects_wiki';
const ghBranch  = () => envValue('PM_BRAIN_BRANCH') || 'main';
const ghToken   = () => envValue('PM_BRAIN_GITHUB_TOKEN') || envValue('GITHUB_TOKEN');

// ─── Sources ──────────────────────────────────────────────────────────────────

const NotFound = Symbol('pm-brain-missing');

function fsSource() {
  const abs = p => path.join(vaultPath(), p);
  return {
    kind: 'fs',
    async listDirs(dir) {
      try {
        const entries = await fsp.readdir(abs(dir), { withFileTypes: true });
        return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
      } catch { return []; }
    },
    async listFiles(dir) {
      try {
        const entries = await fsp.readdir(abs(dir), { withFileTypes: true });
        return entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => e.name).sort();
      } catch { return []; }
    },
    // Every .md below `dir`, at any depth, as paths relative to `dir`.
    // Needed because call notes are nested 1–3 levels deep under `Calls/`
    // ("Calls/External/Weekly Calls/July 6-10/…md") — `listFiles` only sees the
    // top level, which is fine for a milestone hub and wrong for calls.
    async listTree(dir) {
      const out = [];
      const walk = async (rel) => {
        let entries;
        try { entries = await fsp.readdir(abs(rel), { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.')) continue;
          const next = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(next);
          else if (e.isFile() && e.name.endsWith('.md')) out.push(next.slice(dir.length + 1));
        }
      };
      await walk(dir);
      return out.sort();
    },
    async read(file) {
      try { return await fsp.readFile(abs(file), 'utf8'); } catch { return NotFound; }
    },
  };
}

// One recursive tree per TTL — the vault is small enough that paging never
// kicks in, and a per-file "does it exist" round trip would be 200 requests.
let treeCache = { at: 0, paths: null };

async function ghFetch(url, accept = 'application/vnd.github+json') {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dnl-tasks-creator',
    },
  });
  if (res.status === 404) return NotFound;
  if (!res.ok) throw new Error(`GitHub ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return res;
}

function githubSource() {
  const tree = async () => {
    if (treeCache.paths && Date.now() - treeCache.at < GITHUB_TTL_MS) return treeCache.paths;
    const res = await ghFetch(
      `https://api.github.com/repos/${ghRepo()}/git/trees/${encodeURIComponent(ghBranch())}?recursive=1`,
    );
    if (res === NotFound) throw new Error(`GitHub: repo or branch not found (${ghRepo()}@${ghBranch()})`);
    const data = await res.json();
    const paths = (data.tree || []).map(t => ({ path: t.path, type: t.type }));
    treeCache = { at: Date.now(), paths };
    return paths;
  };
  const fileCache = new Map();   // path → { at, text }
  return {
    kind: 'github',
    async listDirs(dir) {
      const prefix = `${dir}/`;
      const set = new Set();
      for (const t of await tree()) {
        if (!t.path.startsWith(prefix)) continue;
        const rest = t.path.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (rest.includes('/') || t.type === 'tree') set.add(seg);
      }
      return [...set].filter(n => n && !n.startsWith('.')).sort();
    },
    async listFiles(dir) {
      const prefix = `${dir}/`;
      return (await tree())
        .filter(t => t.type === 'blob' && t.path.startsWith(prefix)
          && !t.path.slice(prefix.length).includes('/') && t.path.endsWith('.md'))
        .map(t => t.path.slice(prefix.length))
        .sort();
    },
    // Recursive counterpart of listFiles — see the fs source for why.
    async listTree(dir) {
      const prefix = `${dir}/`;
      return (await tree())
        .filter(t => t.type === 'blob' && t.path.startsWith(prefix) && t.path.endsWith('.md'))
        .map(t => t.path.slice(prefix.length))
        .filter(p => !p.split('/').some(seg => seg.startsWith('.')))
        .sort();
    },
    async read(file) {
      const hit = fileCache.get(file);
      if (hit && Date.now() - hit.at < GITHUB_TTL_MS) return hit.text;
      const res = await ghFetch(
        `https://api.github.com/repos/${ghRepo()}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ghBranch())}`,
        'application/vnd.github.raw',
      );
      if (res === NotFound) return NotFound;
      const text = await res.text();
      fileCache.set(file, { at: Date.now(), text });
      return text;
    },
  };
}

let vaultPresent = null;         // cached fs probe: the path either exists or not
async function haveVaultDir() {
  if (vaultPresent !== null) return vaultPresent;
  try {
    const st = await fsp.stat(path.join(vaultPath(), PROJECTS_DIR));
    vaultPresent = st.isDirectory();
  } catch { vaultPresent = false; }
  return vaultPresent;
}

async function pickSource() {
  if (await haveVaultDir()) return fsSource();
  if (ghToken()) return githubSource();
  return null;
}

// ─── Assembling a project ─────────────────────────────────────────────────────

const countBy = (list, fn) => list.reduce((acc, x) => {
  const k = fn(x);
  if (k) acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

const read = async (src, file) => {
  const text = await src.read(file);
  return text === NotFound ? null : text;
};

/**
 * One milestone folder → everything the Milestones tab shows.
 * Every file below the hub is optional: `files` reports what actually exists so
 * the UI can say "no timeline yet" instead of implying an empty one.
 */
async function loadMilestone(src, dir, name) {
  const base = `${dir}/${name}`;
  const files = await src.listFiles(base);
  // Which `Calls/` subfolders already exist, so the "save a call" picker offers
  // the folders this milestone actually uses instead of inventing a convention.
  // '' means "loose in Calls/", which several milestones do.
  const callFolders = await src.listDirs(`${base}/Calls`);
  const callFiles = await src.listFiles(`${base}/Calls`);
  const hubFile = files.includes(`${name}.md`)
    ? `${name}.md`
    : files.find(f => f.replace(/\.md$/, '') === name) ?? null;
  // "Timeline.md", but MARKER/Vendor Report calls it "Timeline — Vendor Report.md".
  const tlFile = files.find(f => /^timeline/i.test(f)) ?? null;

  const [hubText, tlText, todoText, blockText, riskText] = await Promise.all([
    hubFile ? read(src, `${base}/${hubFile}`) : null,
    tlFile ? read(src, `${base}/${tlFile}`) : null,
    files.some(f => /^to ?do\.md$/i.test(f)) ? read(src, `${base}/TO DO.md`) : null,
    files.includes('Blockers.md') ? read(src, `${base}/Blockers.md`) : null,
    files.includes('Risks.md') ? read(src, `${base}/Risks.md`) : null,
  ]);

  const hub = hubText ? parseMilestoneHub(hubText) : null;
  const timeline = tlText ? parseTimeline(tlText) : { epics: [], start: null, due: null };
  const todos = todoText ? parseTodo(todoText) : [];
  const blockers = blockText ? parseBlockers(blockText) : [];
  const dossier = riskText ? parseRiskDossier(riskText) : null;

  return {
    name,
    path: base,
    files,
    callFolders: [...(callFiles.length ? [''] : []), ...callFolders],
    hasHub: !!hubText,
    status: hub?.status ?? 'unknown',
    // Frontmatter dates are missing on ~2/3 of the milestones, so the timeline
    // table is the fallback window (and usually the more accurate one).
    start: hub?.start ?? timeline.start,
    due:   hub?.due   ?? timeline.due,
    datesFrom: hub?.start || hub?.due ? 'frontmatter' : (timeline.start ? 'timeline' : null),
    owner: hub?.owner ?? dossier?.owner ?? null,
    goal: hub?.goal ?? '',
    scope: hub?.scope ?? '',
    latestCall: hub?.latestCall ?? '',
    acceptance: hub?.acceptance ?? { total: 0, done: 0, items: [] },
    timeline,
    todos,
    todoCounts: {
      open:     todos.filter(t => t.state === 'open').length,
      progress: todos.filter(t => t.state === 'progress').length,
      done:     todos.filter(t => t.state === 'done').length,
      high:     todos.filter(t => t.high && t.state !== 'done').length,
    },
    blockers,
    blockerCounts: {
      active:   blockers.filter(b => b.active).length,
      resolved: blockers.filter(b => !b.active).length,
      high:     blockers.filter(b => b.active && b.high).length,
    },
    dossier: dossier ? { owner: dossier.owner, lastReviewed: dossier.lastReviewed, risks: dossier.risks } : null,
  };
}

/** The whole payload for one app project. */
export async function loadPmBrainProject(projectId) {
  const src = await pickSource();
  if (!src) {
    return {
      available: false,
      source: null,
      reason: ghToken()
        ? `No vault at ${vaultPath()} and the GitHub mirror could not be used.`
        : `No vault directory at ${vaultPath()}. Set PM_BRAIN_PATH, or PM_BRAIN_GITHUB_TOKEN to read the private mirror.`,
    };
  }

  const map = VAULT_PROJECTS[projectId] ?? { dir: projectId, slugs: [projectId] };
  const projDir = `${PROJECTS_DIR}/${map.dir}`;
  const msDir = `${projDir}/Milestones`;

  const [msNames, projFiles] = await Promise.all([src.listDirs(msDir), src.listFiles(projDir)]);

  const milestones = (await Promise.all(msNames.map(n => loadMilestone(src, msDir, n))))
    // A folder with no hub AND no other markdown is a placeholder (NSMG/Storage
    // Capacity), not a milestone — keep it out of the counts.
    .filter(m => m.hasHub || m.files.length);

  // HYDROTEC has no Milestones folder at all: its TO DO / Blockers sit at
  // project level. Load them so the tab is not empty for that project.
  const [projTodoText, projBlockText, rbsText, graphText] = await Promise.all([
    projFiles.some(f => /^to ?do\.md$/i.test(f)) ? read(src, `${projDir}/TO DO.md`) : null,
    projFiles.includes('Blockers.md') ? read(src, `${projDir}/Blockers.md`) : null,
    projFiles.includes('RBS.md') ? read(src, `${projDir}/RBS.md`) : null,
    read(src, GRAPH_FILE),
  ]);

  const rbs = rbsText ? parseRbs(rbsText, map.dir) : { lastReview: null, nextReview: null, risks: [] };
  const graph = graphText ? parseRiskGraph(graphText, map.slugs) : [];

  // Attach each RBS row to its milestone (the register is sectioned by
  // milestone name, so this is an exact-name join, not a guess).
  const byMilestone = new Map();
  for (const r of rbs.risks) {
    const list = byMilestone.get(r.milestone) ?? [];
    list.push(r);
    byMilestone.set(r.milestone, list);
  }
  for (const m of milestones) {
    m.risks = byMilestone.get(m.name) ?? [];
    m.maxScore = m.risks.reduce((mx, r) => Math.max(mx, r.score ?? 0), 0) || null;
    m.riskCounts = countBy(m.risks, r => r.band);
  }
  // Register sections whose milestone folder is gone (renamed / archived).
  const orphanRisks = rbs.risks.filter(r => !milestones.some(m => m.name === r.milestone));

  return {
    available: true,
    source: src.kind,
    project: projectId,
    vaultProject: map.dir,
    slugs: map.slugs,
    loadedAt: new Date().toISOString(),
    milestones,
    rbs: { lastReview: rbs.lastReview, nextReview: rbs.nextReview, risks: rbs.risks },
    orphanRisks,
    graph,
    projectLevel: {
      todos: projTodoText ? parseTodo(projTodoText) : [],
      blockers: projBlockText ? parseBlockers(projBlockText) : [],
    },
    counts: {
      milestones: milestones.length,
      inProgress: milestones.filter(m => m.status === 'in-progress').length,
      onHold:     milestones.filter(m => m.status === 'on-hold').length,
      rbsRisks:   rbs.risks.length,
      graphNodes: graph.length,
      graphActive: graph.filter(n => n.status === 'active').length,
      activeBlockers: milestones.reduce((s, m) => s + m.blockerCounts.active, 0)
        + (projBlockText ? parseBlockers(projBlockText).filter(b => b.active).length : 0),
      openTodos: milestones.reduce((s, m) => s + m.todoCounts.open, 0),
    },
  };
}

// ─── Call notes (raw material for the risk engine) ────────────────────────────

/** App project id → its vault folder + risk-graph slugs, with a safe default. */
export const vaultProjectOf = projectId =>
  VAULT_PROJECTS[projectId] ?? { dir: projectId, slugs: [projectId] };

/** The live source, for modules that read the vault beyond one project payload. */
export const vaultSource = () => pickSource();

export const GRAPH_PATH = GRAPH_FILE;

/** One file, or null when it does not exist. Used by the risk engine. */
export async function readVaultFile(file) {
  const src = await pickSource();
  if (!src) return null;
  return read(src, file);
}

/**
 * Every archived call note of a project, grouped by milestone.
 *
 * **The milestone comes from the PATH, not from frontmatter.** Measured on the
 * real vault: 63 call notes live under `Milestones/<M>/Calls/**`, but only 17
 * carry a `milestone:` key and only 11 hold a full transcript — the folder is the
 * one attribution that is always there and always right.
 *
 * This deliberately reads NOTHING: on the GitHub source the recursive tree is
 * already cached, so listing is free, while reading 63 notes would be 63 API
 * calls. Dates and bodies come from `readCallNote` for the notes the engine
 * actually needs to process.
 */
export async function listMilestoneCalls(projectId) {
  const src = await pickSource();
  if (!src) return { available: false, calls: [] };

  const { dir } = vaultProjectOf(projectId);
  const projDir = `${PROJECTS_DIR}/${dir}`;
  const msDir = `${projDir}/Milestones`;
  const msNames = await src.listDirs(msDir);

  const calls = [];
  for (const name of msNames) {
    const base = `${msDir}/${name}/Calls`;
    for (const rel of await src.listTree(base)) {
      const segs = rel.split('/');
      calls.push({
        path: `${base}/${rel}`,
        milestone: name,
        folder: segs.slice(0, -1).join('/'),      // '' = loose in Calls/
        name: segs[segs.length - 1].replace(/\.md$/, ''),
      });
    }
  }
  return {
    available: true,
    source: src.kind,
    project: projectId,
    vaultProject: dir,
    milestones: msNames,        // every folder, incl. the ones with no calls yet
    calls,
  };
}

/**
 * One call note, with its frontmatter and the body split into "head" (summary,
 * topics, action items) and "transcript".
 *
 * The split matters for cost: a full transcript runs to 100 KB, while the head
 * is a few KB and already carries the decisions with Fathom timestamps. Only 11
 * of 63 notes have a `## Transcript` section at all, so `transcript` is usually
 * empty and `head` is the whole note.
 */
export async function readCallNote(file) {
  const text = await readVaultFile(file);
  if (text === null) return null;
  const { data, body } = parseFrontmatter(text);
  const cut = body.search(/^##\s+Transcript\s*$/im);
  const head = cut === -1 ? body : body.slice(0, cut);
  const transcript = cut === -1 ? '' : body.slice(cut).replace(/^##\s+Transcript\s*$/im, '').trim();
  // A note written by hand keeps its Fathom link in the body ("VIEW RECORDING"),
  // not in frontmatter — take whichever is present.
  const fathomId = /fathom\.video\/calls\/(\d+)/.exec(`${data.fathom_url ?? ''} ${body}`)?.[1] ?? null;
  return {
    path: file,
    date: /(\d{4}-\d{2}-\d{2})/.exec(String(data.date ?? ''))?.[1] ?? null,
    title: String(data.title ?? '').trim() || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || null,
    kind: String(data.kind ?? data.call_type ?? '').trim() || null,
    milestoneField: String(data.milestone ?? '').trim() || null,
    fathomId,
    fathomUrl: fathomId ? `https://fathom.video/calls/${fathomId}` : null,
    head: head.trim(),
    transcript,
    bytes: text.length,
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Read-only module: no express.json() body parser, because nothing here accepts
// a body — every route is a GET.
export function registerPmBrainRoutes(app) {
  // Which source is live, so the UI can explain itself before any project load.
  app.get('/api/pm-brain/status', requirePmBrainOwner, async (req, res) => {
    const src = await pickSource();
    res.json({
      available: !!src,
      source: src?.kind ?? null,
      vaultPath: src?.kind === 'fs' ? vaultPath() : null,
      repo: src?.kind === 'github' ? `${ghRepo()}@${ghBranch()}` : null,
      projects: Object.keys(VAULT_PROJECTS),
    });
  });

  app.get('/api/pm-brain/:project', requirePmBrainOwner, async (req, res) => {
    try {
      const data = await loadPmBrainProject(req.params.project);
      if (!data.available) return res.status(503).json(data);
      res.json(data);
    } catch (e) {
      console.warn('[pm-brain] load failed:', e?.message);
      res.status(500).json({ error: e?.message || 'PM Brain load failed' });
    }
  });
}
