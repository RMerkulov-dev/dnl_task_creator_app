// ─── PM Brain — markdown parsers ──────────────────────────────────────────────
// Pure functions: text in, JSON out. No filesystem, no network — pmBrain.js owns
// the sources (local vault or the private GitHub mirror) and calls these.
//
// The vault is a human-maintained Obsidian vault, so every parser is written to
// degrade instead of throwing: a milestone with no frontmatter dates, an RBS
// table that is still the empty template row, a Timeline file named
// "Timeline — Vendor Report.md" — all of it has to come back as *something*.
// Shapes it reads (see the vault's own CLAUDE.md):
//   02_PROJECTS/<P>/Milestones/<M>/<M>.md   milestone hub (frontmatter + Goal + AC)
//   …/<M>/Timeline*.md                      | id | Epic | From | To | Deps |
//   …/<M>/TO DO.md                          ## Open / ## In progress / ## Done
//   …/<M>/Blockers.md                       ## Active / ## Resolved tables
//   …/<M>/Risks.md                          per-milestone dossier (Risk Matrix)
//   02_PROJECTS/<P>/RBS.md                  §3 register, one ### <Milestone> each
//   00_DASHBOARD/Risks/Risk Graph.md        canonical nodes + dated retrospective

// ─── Primitives ───────────────────────────────────────────────────────────────

// Obsidian syntax that must not reach the UI as-is.
export function cleanText(s) {
  return String(s ?? '')
    .replace(/^\s*(?:---+|\*\*\*+)\s*$/gm, '')          // horizontal rules
    .replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')          // _italics_
    .replace(/!\[\[[^\]]*\]\]/g, '')                    // embeds
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')       // [[target|alias]]
    .replace(/\[\[([^\]]+)\]\]/g, '$1')                  // [[target]]
    .replace(/`([^`]*)`/g, '$1')                          // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)#([a-zA-Z][\w/-]*)/g, '$1')           // #tags
    .replace(/\s+/g, ' ')
    .trim();
}

// Markdown links, kept separately so the UI can render them as real links
// (the Fathom links in the risk graph are the whole point of the retrospective).
export function extractLinks(s) {
  const out = [];
  const re = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(String(s ?? '')))) out.push({ label: m[1] || 'link', url: m[2] });
  return out;
}

// Two ways to get rid of a markdown link, both needed:
//   linkLabel — keep the label ("[SLA-01](#anchor)" is how the dossier writes ids);
//   dropLinks — remove it whole (a retro line's "[Fathom](url)" is already in
//               `links`, so leaving the bare word "Fathom" in the text is noise).
const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const linkLabel = s => String(s ?? '').replace(MD_LINK, '$1');
const dropLinks = s => String(s ?? '').replace(MD_LINK, '');

// Leading severity emoji in a table cell — `high`/`severity` already carry it.
const stripLead = s => String(s ?? '').replace(/^[\s🔴🟠🟡🟢🔵⚫⚠️]+/u, '');

const STRIP_BOM = s => String(s ?? '').replace(/^﻿/, '');

/**
 * YAML-ish frontmatter. Deliberately not a YAML parser: the vault uses flat
 * `key: value` plus `tags:` list items, and pulling a dependency in for that
 * would be the only reason this file needs one.
 */
export function parseFrontmatter(text) {
  const src = STRIP_BOM(text);
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  let listKey = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(raw);
    if (item && listKey) { (data[listKey] ||= []).push(item[1].trim()); continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const [, key, val] = kv;
    if (val === '') { listKey = key; data[key] = []; continue; }
    listKey = null;
    data[key] = val.replace(/^["']|["']$/g, '').trim();
  }
  return { data, body: src.slice(m[0].length) };
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The `## <name>` block, up to the next heading of the same or higher level.
export function section(body, name) {
  const re = new RegExp(`^##\\s+${escapeRe(name)}\\s*$`, 'im');
  const m = re.exec(body);
  if (!m) return '';
  const rest = body.slice(m.index + m[0].length);
  const end = /^#{1,2}\s+/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).trim();
}

const isRow = l => /^\s*\|/.test(l);
const isSep = l => /^\s*\|[\s:|-]+\|?\s*$/.test(l);

/**
 * The FIRST markdown table in a chunk of text: header cells + data rows as
 * arrays of strings. A table whose only data row is the empty template
 * (`|  |  |  |`) comes back as zero rows, which is what several RBS sections
 * still hold.
 */
export function parseTable(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const cells = l => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
  let head = -1;
  for (let i = 0; i < lines.length - 1; i++) {
    if (isRow(lines[i]) && !isSep(lines[i]) && isSep(lines[i + 1])) { head = i; break; }
  }
  if (head === -1) return { columns: [], rows: [] };
  const columns = cells(lines[head]);
  const rows = [];
  for (let i = head + 2; i < lines.length; i++) {
    if (!isRow(lines[i])) break;
    const r = cells(lines[i]);
    if (r.every(c => !c)) continue;                       // the empty template row
    rows.push(r);
  }
  return { columns, rows };
}

const cell = (row, idx) => (idx >= 0 && idx < row.length ? row[idx] : '');

// Column lookup by fuzzy header name, so a renamed "Last review" → "Reviewed"
// does not silently blank a field.
const colIdx = (columns, ...names) => {
  const norm = columns.map(c => c.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const wants = names.map(n => n.toLowerCase().replace(/[^a-z0-9]/g, ''));
  // Exact first, across ALL candidate names: a one-letter header ('P', 'I') must
  // never prefix-match a longer column ('I' grabbing 'ID' silently put the risk
  // id into the impact score).
  for (const want of wants) {
    const i = norm.indexOf(want);
    if (i !== -1) return i;
  }
  for (const want of wants) {
    if (want.length < 2) continue;
    const i = norm.findIndex(c => c.startsWith(want) || (c.length > 2 && want.startsWith(c)));
    if (i !== -1) return i;
  }
  return -1;
};

const num = v => {
  const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

const ISO_DATE = /(\d{4}-\d{2}-\d{2})/;
const firstDate = s => (ISO_DATE.exec(String(s ?? '')) || [])[1] || null;

// Score → band, using the vault's own mapping (RBS §2).
export function scoreBand(score) {
  if (score === null || score === undefined) return null;
  if (score >= 15) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}

const STATUS_MAP = [
  [/realis|realiz/i, 'realized'],
  [/mitigat/i,       'mitigating'],
  [/watch/i,         'watching'],
  [/clos|resolv/i,   'closed'],
  [/open/i,          'open'],
];
export const normStatus = s => (STATUS_MAP.find(([re]) => re.test(String(s ?? '')))?.[1] ?? 'open');

// ─── Milestone hub ────────────────────────────────────────────────────────────

// "- [ ] text" / "- [x] text" checkbox lists, with the vault's 🔴 priority mark
// and the "Owner — rest" prefix its TO DO files use.
export function parseChecklist(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*[-*]\s*\[( |x|X)\]\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    const high = /🔴/.test(raw);
    const rest = raw.replace(/^[🔴🟠🟡🟢⚠️]+\s*/u, '');
    const owner = /^([^—–-]{2,28})\s+[—–]\s+/.exec(rest);
    out.push({
      done: m[1].toLowerCase() === 'x',
      high,
      owner: owner ? owner[1].trim() : null,
      text: cleanText(owner ? rest.slice(owner[0].length) : rest),
      links: extractLinks(raw),
    });
  }
  return out;
}

// A section that is nothing but one italic line is the Milestone Hub template's
// own placeholder ("_What must be done by the end of this milestone._") — showing
// it as the goal makes every untouched milestone look documented.
const isPlaceholder = raw => /^_[^_]*_$/.test(String(raw ?? '').trim());

export function parseMilestoneHub(text) {
  const { data, body } = parseFrontmatter(text);
  const ac = parseChecklist(section(body, 'Acceptance criteria'));
  const goalRaw = isPlaceholder(section(body, 'Goal')) ? '' : section(body, 'Goal');
  return {
    status: (data.status || '').toLowerCase() || 'unknown',
    start:  firstDate(data.start),
    due:    firstDate(data.due),
    owner:  data.owner || null,
    goal:   cleanText(goalRaw).slice(0, 600),
    scope:  isPlaceholder(section(body, 'Scope')) ? '' : cleanText(section(body, 'Scope')).slice(0, 600),
    latestCall: cleanText(section(body, 'Latest call')).slice(0, 400),
    acceptance: { total: ac.length, done: ac.filter(x => x.done).length, items: ac },
  };
}

// ─── Timeline ─────────────────────────────────────────────────────────────────

/** `| id | Epic | From | To | Deps |` → epics + the derived window. */
export function parseTimeline(text) {
  const { body } = parseFrontmatter(text);
  // Cut the dataviewjs Gantt block: it contains its own pipe characters.
  const noCode = body.replace(/```[\s\S]*?```/g, '');
  const { columns, rows } = parseTable(noCode);
  const iId = colIdx(columns, 'id'), iName = colIdx(columns, 'epic', 'name');
  const iFrom = colIdx(columns, 'from', 'start'), iTo = colIdx(columns, 'to', 'end');
  const iDeps = colIdx(columns, 'deps');
  const epics = [];
  for (const r of rows) {
    const from = firstDate(cell(r, iFrom));
    if (!from) continue;
    const to = firstDate(cell(r, iTo)) || from;
    epics.push({
      id:   cell(r, iId) || `e${epics.length + 1}`,
      name: cleanText(cell(r, iName)),
      from, to,
      milestone: from === to,                             // renders as a diamond
      deps: cell(r, iDeps).split(',').map(s => s.trim()).filter(Boolean),
    });
  }
  const dates = epics.flatMap(e => [e.from, e.to]).sort();
  return { epics, start: dates[0] ?? null, due: dates[dates.length - 1] ?? null };
}

// ─── Blockers ─────────────────────────────────────────────────────────────────

function blockerRows(text, active) {
  const { columns, rows } = parseTable(text);
  const iN = colIdx(columns, '#'), iB = colIdx(columns, 'blocker');
  const iOwner = colIdx(columns, 'owner'), iSince = colIdx(columns, 'since');
  const iImpact = colIdx(columns, 'impact'), iNext = colIdx(columns, 'nextstep', 'next');
  const iResolved = colIdx(columns, 'resolved'), iHow = colIdx(columns, 'how');
  return rows.map(r => ({
    n:       cell(r, iN),
    active,
    high:    /🔴/.test(cell(r, iB)),
    text:    cleanText(stripLead(cell(r, iB))),
    owner:   cleanText(cell(r, iOwner)) || null,
    since:   firstDate(cell(r, iSince)),
    impact:  cleanText(cell(r, iImpact)),
    nextStep: cleanText(cell(r, iNext)),
    resolved: firstDate(cell(r, iResolved)),
    how:     cleanText(cell(r, iHow)),
  })).filter(b => b.text);
}

export function parseBlockers(text) {
  const { body } = parseFrontmatter(text);
  return [
    ...blockerRows(section(body, 'Active'), true),
    ...blockerRows(section(body, 'Resolved'), false),
  ];
}

// ─── TO DO ────────────────────────────────────────────────────────────────────

export function parseTodo(text) {
  const { body } = parseFrontmatter(text);
  const buckets = { open: 'Open', progress: 'In progress', done: 'Done' };
  const out = [];
  for (const [state, heading] of Object.entries(buckets)) {
    for (const item of parseChecklist(section(body, heading))) {
      out.push({ ...item, state: item.done && state === 'open' ? 'done' : state });
    }
  }
  return out;
}

// ─── RBS — the scored risk register (per project, sectioned per milestone) ─────

/**
 * §3 of `02_PROJECTS/<P>/RBS.md`: one `### <Milestone>` per section, each with a
 * `# | RBS | Risk | P | I | Score | Response | Owner | Status | Reviewed` table.
 * Returns a flat list of risks, each carrying its milestone.
 */
export function parseRbs(text, project) {
  const { data, body } = parseFrontmatter(text);
  // Everything after the "Risk Register" heading; if that heading was renamed,
  // fall back to the whole body (the ### sections are what actually matter).
  const regIdx = body.search(/^##\s+\d*\.?\s*Risk Register/im);
  const scope = regIdx === -1 ? body : body.slice(regIdx);
  const risks = [];
  const parts = scope.split(/^###\s+/m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const headline = (nl === -1 ? part : part.slice(0, nl)).trim();
    const milestone = cleanText(headline.replace(/\*\(.*?\)\*/g, '')).trim();
    const msStatus = (/\*\((.*?)\)\*/.exec(headline) || [])[1] || null;
    const { columns, rows } = parseTable(nl === -1 ? '' : part.slice(nl));
    const iId = colIdx(columns, '#', 'id'), iCat = colIdx(columns, 'rbs', 'category');
    const iRisk = colIdx(columns, 'risk'), iP = colIdx(columns, 'p'), iI = colIdx(columns, 'i');
    const iScore = colIdx(columns, 'score'), iResp = colIdx(columns, 'response');
    const iOwner = colIdx(columns, 'owner'), iStatus = colIdx(columns, 'status');
    const iRev = colIdx(columns, 'reviewed', 'lastreview');
    for (const r of rows) {
      const title = cleanText(linkLabel(cell(r, iRisk)));
      if (!title) continue;
      const p = num(cell(r, iP)), i = num(cell(r, iI));
      const score = num(cell(r, iScore)) ?? (p !== null && i !== null ? p * i : null);
      risks.push({
        source: 'rbs',
        project,
        milestone,
        milestoneStatus: msStatus,
        id: cleanText(linkLabel(cell(r, iId))) || null,
        category: cleanText(cell(r, iCat)) || null,
        title,
        p, i, score,
        band: scoreBand(score),
        response: cleanText(cell(r, iResp)) || null,
        owner: cleanText(cell(r, iOwner)) || null,
        status: normStatus(cell(r, iStatus)),
        statusRaw: cleanText(cell(r, iStatus)) || null,
        reviewed: firstDate(cell(r, iRev)),
      });
    }
  }
  return { lastReview: firstDate(data.last_review), nextReview: firstDate(data.next_review), risks };
}

// ─── Risk Graph — the canonical register with a dated retrospective ────────────

const SEVERITY = [[/🔴/, 'critical'], [/⚠️|⚠/, 'elevated'], [/🟡/, 'watch']];
const TREND = [[/✅|improv/i, 'improved'], [/❌|worsen/i, 'worsened'], [/➡️|unchanged/i, 'unchanged']];

/**
 * `00_DASHBOARD/Risks/Risk Graph.md` → one entry per `### <SLUG>-NN · Title`
 * node, with its retrospective lines (date + text + Fathom links) and the trend
 * of the LAST line — the whole reason the graph is kept by date.
 * `slugs` filters to the project's buckets (ABS also owns nothing else, but NSMG
 * owns NSMG + legacy Case-Migration nodes — see the vault's project map).
 */
export function parseRiskGraph(text, slugs = null) {
  const body = STRIP_BOM(text);
  const want = slugs?.length ? slugs.map(s => s.toUpperCase()) : null;
  const out = [];
  // Project sections are `## <Project>`; nodes are `### <SLUG>-NN · Title`.
  let currentProject = null;
  const chunks = body.split(/^(#{2,3})\s+/m);
  for (let k = 1; k < chunks.length; k += 2) {
    const level = chunks[k].length;
    const rest = chunks[k + 1] ?? '';
    const nl = rest.indexOf('\n');
    const heading = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    const bodyText = nl === -1 ? '' : rest.slice(nl + 1);
    if (level === 2) { currentProject = cleanText(heading); continue; }

    const idm = /^([A-Z][A-Z0-9]*)-(\d+)\s*[·:.\-]\s*(.*)$/.exec(heading.replace(/\^[\w-]+\s*$/, '').trim());
    if (!idm) continue;
    const slug = idm[1];
    if (want && !want.includes(slug)) continue;

    const meta = /\*\*Severity:\*\*(.*)$/im.exec(bodyText)?.[1] ?? '';
    const retro = [];
    for (const line of bodyText.split(/\r?\n/)) {
      const rm = /^\s*[-*]\s*(\d{4}-\d{2}-\d{2})\s*[—–-]?\s*(.*)$/.exec(line);
      if (!rm) continue;
      retro.push({
        date: rm[1],
        trend: TREND.find(([re]) => re.test(rm[2]))?.[1] ?? null,
        text: cleanText(dropLinks(rm[2])),
        links: extractLinks(rm[2]),
      });
    }
    const last = retro[retro.length - 1] ?? null;
    out.push({
      source: 'graph',
      id: `${slug}-${idm[2]}`,
      slug,
      section: currentProject,
      title: cleanText(idm[3]),
      severity: SEVERITY.find(([re]) => re.test(meta))?.[1] ?? null,
      // Order matters: "Resolving" must not be read as "Resolved" (it is still
      // open work), and neither must fall through to "active" — the graph really
      // uses all four words, and collapsing Resolving into active hid 6 nodes.
      status: /dormant/i.test(meta) ? 'dormant'
        : /resolving/i.test(meta) ? 'resolving'
        : /resolved/i.test(meta) ? 'resolved' : 'active',
      first: firstDate(/\*\*First:\*\*\s*([^\s*·]+)/i.exec(meta)?.[1] ?? '') || retro[0]?.date || null,
      last: firstDate(/\*\*Last:\*\*\s*([^\s*·]+)/i.exec(meta)?.[1] ?? '') || last?.date || null,
      trend: last?.trend ?? null,
      lastNote: last?.text ?? '',
      lastLinks: last?.links ?? [],
      retro,
      seen: retro.length,
    });
  }
  return out;
}

// ─── Per-milestone risk dossier ───────────────────────────────────────────────

/**
 * `Milestones/<M>/Risks.md` — the internal dossier. Only the Risk Matrix table
 * is read as data (the per-risk prose sections are returned raw for the detail
 * panel, since their shape varies per milestone).
 */
export function parseRiskDossier(text) {
  const { data, body } = parseFrontmatter(text);
  const matrix = parseTable(section(body, 'Risk Matrix'));
  const { columns, rows } = matrix;
  const iId = colIdx(columns, 'id'), iRisk = colIdx(columns, 'risk');
  const iCat = colIdx(columns, 'category'), iP = colIdx(columns, 'p'), iI = colIdx(columns, 'i');
  const iScore = colIdx(columns, 'score'), iBand = colIdx(columns, 'band');
  const iStatus = colIdx(columns, 'status'), iOwner = colIdx(columns, 'owner');
  const iRev = colIdx(columns, 'lastreview', 'reviewed');
  const risks = rows.map(r => {
    const p = num(cell(r, iP)), i = num(cell(r, iI));
    const score = num(cell(r, iScore)) ?? (p !== null && i !== null ? p * i : null);
    return {
      source: 'dossier',
      id: cleanText(linkLabel(cell(r, iId))) || null,
      title: cleanText(linkLabel(cell(r, iRisk))),
      category: cleanText(cell(r, iCat)) || null,
      p, i, score,
      band: scoreBand(score) ?? (cleanText(cell(r, iBand)).toLowerCase() || null),
      status: normStatus(cell(r, iStatus)),
      statusRaw: cleanText(cell(r, iStatus)) || null,
      owner: cleanText(cell(r, iOwner)) || null,
      reviewed: firstDate(cell(r, iRev)),
    };
  }).filter(r => r.title);
  return { owner: data.owner || null, lastReviewed: firstDate(data.last_reviewed), risks };
}
