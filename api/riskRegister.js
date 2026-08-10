// ─── Risk register — the machine-owned store ──────────────────────────────────
// One JSON document per vault project folder:
//   00_DASHBOARD/Risks/.register-<DIR>.json
//
// Why a JSON document in the vault rather than markdown or app storage:
//   • the app is its SOLE writer, so it can be updated in place through
//     `updateVaultJson` without touching `Risk Graph.md`, which is written by
//     hand in Obsidian (see the create-only invariant in pmBrainWrite.js);
//   • it lives in the vault, so the risks travel with the vault's git history and
//     stay visible to whoever clones it — a generated markdown mirror renders the
//     same data for Obsidian, but parsing markdown back is fragile, so the JSON
//     is the source of truth and the mirror is one-way;
//   • one file per PROJECT FOLDER, not per app project: NSMG and NSMGCM share the
//     `NSMG` folder and share one `<SLUG>-NN` id space there, exactly as the
//     vault's own risk convention says they should.
//
// Ids continue the existing space (`ABS-31` after the graph's `ABS-30`) — the
// vault rule is "only forward": a risk keeps its id forever, and the milestone is
// a FIELD on it, never part of the id.

import { parseRiskGraph } from './pmBrainParse.js';
import {
  vaultProjectOf, readVaultFile, listMilestoneCalls, GRAPH_PATH,
} from './pmBrain.js';
import { readVaultJson, updateVaultJson, canWriteVault } from './pmBrainWrite.js';

const RISKS_DIR = '00_DASHBOARD/Risks';
export const REGISTER_VERSION = 1;

export const registerPath = projectId => `${RISKS_DIR}/.register-${vaultProjectOf(projectId).dir}.json`;

// ─── Status model ─────────────────────────────────────────────────────────────
// `active`/`resolving` are open work; `resolved` and `dormant` both drop out of
// the default list but mean different things — resolved has evidence, dormant is
// only silence. Keeping them apart is what stops "nobody mentioned it" from
// being reported as "we fixed it".
export const OPEN_STATUSES = ['active', 'resolving'];
export const isOpen = risk => OPEN_STATUSES.includes(effectiveStatus(risk));

/** A manual override always wins over whatever the engine last concluded. */
export const effectiveStatus = risk => risk?.override?.status || risk?.status || 'active';

const emptyDoc = projectId => ({
  version: REGISTER_VERSION,
  vaultProject: vaultProjectOf(projectId).dir,
  updatedAt: null,
  seededFrom: null,
  risks: {},
  ledger: {},
});

// ─── Load / save ──────────────────────────────────────────────────────────────

/**
 * The register document. Reads through the GitHub API when a write token exists
 * (read-after-write consistency — see readVaultJson) and falls back to the plain
 * vault read otherwise, so a local dev server with no PAT still shows the data.
 */
export async function loadRegister(projectId) {
  const path = registerPath(projectId);
  let doc = null;
  if (canWriteVault()) {
    doc = await readVaultJson(path);
  } else {
    const text = await readVaultFile(path);
    if (text) {
      try { doc = JSON.parse(text); } catch {
        throw new Error(`${path} is not valid JSON — fix or delete it in the vault`);
      }
    }
  }
  if (!doc) return emptyDoc(projectId);
  return { ...emptyDoc(projectId), ...doc, risks: doc.risks ?? {}, ledger: doc.ledger ?? {} };
}

/**
 * Read-modify-write. `mutate(doc)` may edit in place and must return the doc (or
 * null to abort). The sha check inside `updateVaultJson` retries on a concurrent
 * commit, which is what keeps two analyses of different milestones from losing
 * each other's risks.
 */
export async function saveRegister(projectId, mutate, message) {
  if (!canWriteVault()) {
    throw new Error('PM_BRAIN_GITHUB_TOKEN is not set — the risk register cannot be written.');
  }
  return updateVaultJson(registerPath(projectId), (cur) => {
    const doc = cur ? { ...emptyDoc(projectId), ...cur, risks: cur.risks ?? {}, ledger: cur.ledger ?? {} }
      : emptyDoc(projectId);
    const next = mutate(doc);
    if (next === null) return null;
    next.updatedAt = new Date().toISOString();
    return next;
  }, message);
}

// ─── Ids ──────────────────────────────────────────────────────────────────────

/**
 * The next free `<SLUG>-NN`, counted over the register AND over any id already
 * seen in the graph seed — never reuse a number, even for a risk that was later
 * deleted by hand.
 */
export function nextRiskId(doc, slug) {
  const want = String(slug).toUpperCase();
  let max = 0;
  for (const id of Object.keys(doc.risks ?? {})) {
    const m = new RegExp(`^${want}-(\\d+)$`).exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${want}-${String(max + 1).padStart(2, '0')}`;
}

// ─── Milestone attribution by name ────────────────────────────────────────────
// The graph's 69 nodes carry a project slug and NO milestone, and they cannot be
// joined to one through their call links: of 67 Fathom call ids in the graph and
// the 5 in archived notes, ZERO overlap (the graph predates the app's own call
// archiving). So a seeded node gets its milestone from its title, and the label
// records that it was a guess.

const STOP = new Set([
  'abs', 'nsmg', 'nsmgm', 'nsmgcm', 'marker', 'hydrotec', 'the', 'and', 'for', 'from',
  'with', 'not', 'new', 'only', 'ws', 'qg', 'module', 'review', 'risk', 'issue',
  'blocked', 'blocker', 'missing', 'process', 'client', 'team', 'project',
]);

const tokenize = s => String(s ?? '')
  .toLowerCase()
  .replace(/[.\-—–_|/\\()[\]]+/g, ' ')
  .replace(/[^a-z0-9 ]+/g, '')
  .split(/\s+/)
  .filter(w => w.length > 2 && !STOP.has(w));

/**
 * Best milestone for a risk title, or null.
 *
 * Deliberately NOT the rule used for milestone↔board matching (`every token of
 * the shorter side must appear`): a risk title is prose, not a name, so the
 * overlap is always partial ("Marketing forms migration blocked / scope
 * ambiguity" vs "Marketing Asset Migration" shares 2 of 3). The guard against
 * nonsense is instead: at least 2 shared identity tokens, and a single clear
 * winner — a tie means we cannot tell, so we say so.
 */
export function matchMilestoneByName(title, milestoneNames) {
  const want = tokenize(title);
  if (want.length < 2) return null;
  const scored = milestoneNames.map((name) => {
    const have = tokenize(name);
    const shared = have.filter(w => want.includes(w));
    return { name, score: shared.length, shared };
  }).filter(s => s.score >= 2).sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;   // ambiguous
  return { milestone: scored[0].name, matched: scored[0].shared };
}

// ─── Seeding from the canonical Risk Graph ────────────────────────────────────

const SEVERITY_TO_SCORE = { critical: { p: 4, i: 5 }, elevated: { p: 3, i: 3 }, watch: { p: 2, i: 2 } };

/**
 * Turn a parsed graph node into a register risk. The graph has no P/I scoring, so
 * the score is left NULL rather than invented — a made-up 12 would show up in the
 * P×I matrix as if someone had assessed it. Severity is what the graph does carry.
 */
function riskFromGraphNode(node, milestoneNames) {
  const guess = node.title ? matchMilestoneByName(node.title, milestoneNames) : null;
  return {
    id: node.id,
    slug: node.slug,
    milestone: guess?.milestone ?? null,
    milestoneFrom: guess ? 'auto-name' : null,
    milestoneMatched: guess?.matched ?? null,
    title: node.title,
    category: null,
    severity: node.severity ?? 'elevated',
    p: null, i: null, score: null, band: null,
    status: node.status ?? 'active',
    owner: null,
    first: node.first,
    last: node.last,
    trend: node.trend,
    graphId: node.id,
    origin: 'graph-seed',
    retro: node.retro.map(r => ({
      date: r.date,
      trend: r.trend,
      text: r.text,
      quote: null,
      source: {
        note: null,
        url: r.links?.[0]?.url ?? null,
      },
    })),
    resolution: node.status === 'resolved'
      ? { at: node.last, signals: ['graph'], evidence: ['Marked Resolved in Risk Graph.md'], by: 'seed' }
      : null,
    override: null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Import the canonical graph into the register, once. Existing risks are left
 * alone (`graphId` is the key), so re-running is safe and never overwrites work
 * the engine has since done on a node.
 */
export async function seedFromGraph(projectId, { force = false } = {}) {
  const { slugs } = vaultProjectOf(projectId);
  const graphText = await readVaultFile(GRAPH_PATH);
  if (!graphText) {
    return { ok: false, reason: `${GRAPH_PATH} not found in the vault.` };
  }
  const nodes = parseRiskGraph(graphText, slugs);
  // Match against EVERY milestone folder, not only the ones that already have
  // archived calls: 5 of ABS's 12 milestones have no call notes yet, and a risk
  // clearly belongs to one of them regardless.
  const { milestones: milestoneNames } = await listMilestoneCalls(projectId);

  let added = 0, skipped = 0, attributed = 0;
  await saveRegister(projectId, (doc) => {
    const haveGraphIds = new Set(Object.values(doc.risks).map(r => r.graphId).filter(Boolean));
    for (const node of nodes) {
      if (!force && (doc.risks[node.id] || haveGraphIds.has(node.id))) { skipped++; continue; }
      const risk = riskFromGraphNode(node, milestoneNames);
      if (risk.milestone) attributed++;
      doc.risks[node.id] = risk;
      added++;
    }
    if (!added) return null;
    doc.seededFrom = { file: GRAPH_PATH, at: new Date().toISOString(), nodes: nodes.length };
    return doc;
  }, `risks: seed ${added} node(s) from Risk Graph into ${vaultProjectOf(projectId).dir}`);

  return {
    ok: true,
    graphNodes: nodes.length,
    added,
    skipped,
    attributed,
    milestonesConsidered: milestoneNames.length,
  };
}

// ─── The payload the UI reads ─────────────────────────────────────────────────

/**
 * The register plus everything the Risks tab needs to render it without a second
 * request: the per-milestone call counts (how much raw material a milestone has),
 * and whether the register can be written at all.
 */
export async function loadRiskPayload(projectId) {
  const { dir, slugs } = vaultProjectOf(projectId);
  const [doc, callList] = await Promise.all([
    loadRegister(projectId),
    listMilestoneCalls(projectId),
  ]);

  if (!callList.available) {
    return { available: false, reason: 'No vault source configured (PM_BRAIN_PATH or PM_BRAIN_GITHUB_TOKEN).' };
  }

  // One project's slice: NSMG and NSMGCM share a register file, so filter by slug.
  const want = new Set(slugs.map(s => s.toUpperCase()));
  const risks = Object.values(doc.risks)
    .filter(r => want.has(String(r.slug ?? '').toUpperCase()))
    .map(r => ({ ...r, statusEffective: effectiveStatus(r), open: isOpen(r) }));

  const callsByMilestone = {};
  for (const c of callList.calls) {
    callsByMilestone[c.milestone] = (callsByMilestone[c.milestone] ?? 0) + 1;
  }

  return {
    available: true,
    project: projectId,
    vaultProject: dir,
    slugs,
    source: callList.source,
    // The register is read through the GitHub API whenever a token exists, so it
    // can genuinely differ from the source the vault FILES came from: right after
    // a write the local vault has no register at all until obsidian-git pulls.
    registerSource: canWriteVault() ? 'github' : callList.source,
    writable: canWriteVault(),
    registerPath: registerPath(projectId),
    seededFrom: doc.seededFrom,
    updatedAt: doc.updatedAt,
    loadedAt: new Date().toISOString(),
    risks,
    calls: { total: callList.calls.length, byMilestone: callsByMilestone },
    processed: Object.keys(doc.ledger).length,
    counts: {
      total:     risks.length,
      open:      risks.filter(r => r.open).length,
      active:    risks.filter(r => r.statusEffective === 'active').length,
      resolving: risks.filter(r => r.statusEffective === 'resolving').length,
      resolved:  risks.filter(r => r.statusEffective === 'resolved').length,
      dormant:   risks.filter(r => r.statusEffective === 'dormant').length,
      unattributed: risks.filter(r => !r.milestone).length,
    },
  };
}

// ─── Manual override ──────────────────────────────────────────────────────────

/**
 * The human's verdict on one risk. Stored separately from `status` on purpose: the
 * engine keeps updating its own conclusion underneath, and the override keeps
 * winning — so a wrongly auto-closed risk stays reopened even after the next run.
 * `status: null` clears it.
 */
export async function setRiskOverride(projectId, riskId, { status, why, by }) {
  const allowed = ['active', 'resolving', 'resolved', 'dormant', null];
  if (!allowed.includes(status)) {
    throw new Error(`Unknown status "${status}" — expected one of ${allowed.filter(Boolean).join(', ')}.`);
  }
  let updated = null;
  await saveRegister(projectId, (doc) => {
    const risk = doc.risks[riskId];
    if (!risk) throw new Error(`Risk ${riskId} is not in the register.`);
    risk.override = status
      ? { status, why: String(why ?? '').slice(0, 500) || null, by: by ?? null, at: new Date().toISOString() }
      : null;
    updated = { ...risk, statusEffective: effectiveStatus(risk), open: isOpen(risk) };
    return doc;
  }, `risks: ${riskId} → ${status ?? 'override cleared'}`);
  return updated;
}
