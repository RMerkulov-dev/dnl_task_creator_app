const BASE = '/api/jira';

function jiraBase(cloudId) {
  return `${BASE}/ex/jira/${cloudId}/rest/api/3`;
}

// ─── HTML → ADF converter ────────────────────────────────────────────────────
// Converts TipTap HTML output to Atlassian Document Format for Jira API v3.
// Handles: headings, paragraphs, bold, italic, underline, links, images,
// ordered/unordered lists, code, blockquotes, text color.

// When a media map ({ fileName: attachmentId }) is supplied, <img> tags tagged
// with `data-jira-filename` are converted to inline ADF media nodes instead of
// being dropped. Module-scoped so we don't have to thread it through every
// converter helper; set for the duration of a single htmlToAdf() call.
let _mediaMap = null;

function htmlToAdf(html, mediaMap = null) {
  _mediaMap = mediaMap;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html || '', 'text/html');
    const content = sanitizeAdfNodes(convertNodes(doc.body.childNodes));
    return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
  } finally {
    _mediaMap = null;
  }
}

// ─── ADF sanitizer ───────────────────────────────────────────────────────────
// Jira answers 400 "The field value is not valid Atlassian Document Format (ADF)
// content." for ANY structural violation, with no hint which node is at fault.
// The converter below can produce several such shapes from real-world HTML
// (pasted email markup, unknown tags, empty containers), so nothing goes out
// before passing through here. The rules Jira enforces that we hit in practice:
//   - a doc/blockquote/listItem may only hold BLOCK nodes — a bare `text` node
//     at block level (what unknown tags like <table>/<font> used to produce)
//     invalidates the whole document;
//   - a `text` node must have a non-empty string (an empty <pre> produced one);
//   - bulletList/orderedList need ≥1 listItem, listItem/blockquote need ≥1 block;
//   - `textColor` must be #rrggbb, `link` needs an href, and the `code` mark
//     can't be combined with other formatting marks;
//   - a `mediaSingle` must wrap exactly one `media` node with an id.
// Anything unrecognised keeps its text (wrapped in a paragraph) instead of
// silently disappearing.

const ADF_INLINE_TYPES = new Set(['text', 'hardBreak', 'emoji', 'mention', 'inlineCard', 'status', 'date']);
const ADF_BLOCK_TYPES  = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote',
  'codeBlock', 'rule', 'mediaSingle', 'mediaGroup', 'panel',
]);
// Nodes a container may hold; anything else is degraded to a paragraph.
const ADF_CONTAINER_ALLOWED = {
  blockquote: new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaSingle']),
  listItem:   new Set(['paragraph', 'bulletList', 'orderedList', 'codeBlock', 'mediaSingle']),
};
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// The `code` mark is exclusive — Jira rejects it alongside strong/em/underline/…
const CODE_COMPATIBLE_MARKS = new Set(['code', 'link', 'annotation']);

function sanitizeAdfNodes(nodes, container = 'doc') {
  const out = [];
  const allowed = ADF_CONTAINER_ALLOWED[container];
  let inlineRun = [];

  const flushInlineRun = () => {
    if (!inlineRun.length) return;
    // Formatting whitespace between block tags carries no meaning — drop it
    // instead of turning it into a blank paragraph.
    const meaningful = inlineRun.some(n => n.type !== 'text' || n.text.trim());
    if (meaningful) out.push({ type: 'paragraph', content: inlineRun });
    inlineRun = [];
  };

  for (const raw of nodes || []) {
    if (!raw || typeof raw !== 'object') continue;

    // An inline node where a block was expected: collect the run and wrap it.
    if (ADF_INLINE_TYPES.has(raw.type)) {
      inlineRun.push(...sanitizeAdfInlines([raw]));
      continue;
    }
    flushInlineRun();

    let node = sanitizeAdfBlock(raw);
    if (!node) continue;
    if (allowed && !allowed.has(node.type)) {
      // e.g. a heading inside a blockquote — keep the words, lose the shape.
      const inlines = sanitizeAdfInlines(node.content);
      node = inlines.length ? { type: 'paragraph', content: inlines } : null;
      if (!node) continue;
    }
    out.push(node);
  }
  flushInlineRun();
  return out;
}

function sanitizeAdfBlock(node) {
  switch (node.type) {
    case 'paragraph':
      node.content = sanitizeAdfInlines(node.content);
      return node;

    case 'heading':
      node.attrs = { level: Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)) };
      node.content = sanitizeAdfInlines(node.content);
      return node;

    case 'codeBlock': {
      // Code holds plain text only — no marks, and never an empty text node.
      const text = (node.content || []).map(c => (typeof c?.text === 'string' ? c.text : '')).join('');
      node.content = text ? [{ type: 'text', text }] : [];
      return node;
    }

    case 'bulletList':
    case 'orderedList':
      node.content = (node.content || [])
        .filter(c => c?.type === 'listItem')
        .map(sanitizeAdfBlock)
        .filter(Boolean);
      return node.content.length ? node : null;

    case 'listItem': {
      const content = sanitizeAdfNodes(node.content, 'listItem');
      // A listItem must hold ≥1 block and may not open with a nested list.
      if (!content.length || content[0].type !== 'paragraph') {
        content.unshift({ type: 'paragraph', content: [] });
      }
      node.content = content;
      return node;
    }

    case 'blockquote':
      node.content = sanitizeAdfNodes(node.content, 'blockquote');
      return node.content.length ? node : null;

    case 'mediaSingle': {
      const media = (node.content || []).find(c => c?.type === 'media' && c.attrs?.id);
      if (!media) return null;
      node.content = [media];
      return node;
    }

    case 'rule':
      return { type: 'rule' };

    default: {
      if (Array.isArray(node.content)) node.content = sanitizeAdfNodes(node.content);
      if (ADF_BLOCK_TYPES.has(node.type)) return node;
      // Unknown node type — salvage its text rather than dropping it.
      const inlines = sanitizeAdfInlines(node.content);
      return inlines.length ? { type: 'paragraph', content: inlines } : null;
    }
  }
}

function sanitizeAdfInlines(nodes) {
  const out = [];
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') continue;

    if (node.type === 'text') {
      if (typeof node.text !== 'string' || !node.text.length) continue;
      const marks = sanitizeAdfMarks(node.marks);
      if (marks.length) node.marks = marks;
      else delete node.marks;
      out.push(node);
    } else if (ADF_INLINE_TYPES.has(node.type)) {
      out.push(node);
    } else if (Array.isArray(node.content)) {
      // A block node where an inline was expected — splice its text in.
      out.push(...sanitizeAdfInlines(node.content));
    }
  }
  return out;
}

function sanitizeAdfMarks(marks) {
  const out = [];
  const seen = new Set();
  for (const mark of marks || []) {
    if (!mark || typeof mark !== 'object' || typeof mark.type !== 'string') continue;
    if (seen.has(mark.type)) continue;                                  // no duplicates
    if (mark.type === 'link' && !mark.attrs?.href) continue;
    if (mark.type === 'textColor' && !HEX_COLOR_RE.test(mark.attrs?.color || '')) continue;
    seen.add(mark.type);
    out.push(mark);
  }
  return seen.has('code') ? out.filter(m => CODE_COMPATIBLE_MARKS.has(m.type)) : out;
}

function convertNodes(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Block context: whitespace between tags is markup formatting, not content.
      const text = node.textContent;
      if (text && text.trim()) result.push({ type: 'text', text });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const block = convertElement(node);
      if (block) {
        if (Array.isArray(block)) result.push(...block);
        else result.push(block);
      }
    }
  }
  return result;
}

function convertElement(el) {
  const tag = el.tagName.toLowerCase();

  // Block elements
  const heading = tag.match(/^h([1-6])$/);
  if (heading) return { type: 'heading', attrs: { level: Number(heading[1]) }, content: convertInline(el) };
  if (tag === 'p')  return { type: 'paragraph', content: convertInline(el) };
  // Stray inline content inside a quote is wrapped into a paragraph by the
  // sanitizer, so it survives instead of being filtered out.
  if (tag === 'blockquote') return { type: 'blockquote', content: convertNodes(el.childNodes) };
  if (tag === 'ul') return { type: 'bulletList', content: convertListItems(el) };
  if (tag === 'ol') return { type: 'orderedList', content: convertListItems(el) };
  if (tag === 'li') return convertListItem(el);
  if (tag === 'hr') return { type: 'rule' };
  if (tag === 'pre') {
    const code = el.querySelector('code');
    return { type: 'codeBlock', content: [{ type: 'text', text: (code || el).textContent }] };
  }
  if (tag === 'img') {
    // Images are uploaded as Jira attachments first; we can't embed the raw
    // src (base64 is rejected, Azure DevOps URLs require auth). _mediaMap maps
    // the file name to the attachment's Media Services UUID — referencing that
    // in a `type:file` media node renders the image inline, same as in Azure.
    // (collection MUST be present; an empty string is accepted.)
    const fileName = el.getAttribute('data-jira-filename');
    const mediaId = fileName && _mediaMap ? _mediaMap[fileName] : null;
    if (mediaId) {
      return {
        type: 'mediaSingle',
        attrs: { layout: 'center' },
        content: [
          { type: 'media', attrs: { type: 'file', id: String(mediaId), collection: '' } },
        ],
      };
    }
    return null;
  }
  if (tag === 'br') return null;

  // Treat div/span as wrapper
  if (tag === 'div' || tag === 'span') {
    const children = convertNodes(el.childNodes);
    return children.length ? children : null;
  }

  // Inline elements encountered at block level — wrap in paragraph
  if (['strong', 'b', 'em', 'i', 'u', 'a', 'code', 's'].includes(tag)) {
    return { type: 'paragraph', content: convertInline(el) };
  }

  // Fallback: recurse children
  const children = convertNodes(el.childNodes);
  return children.length ? children : null;
}

function convertListItems(el) {
  const items = [];
  for (const child of el.children) {
    if (child.tagName.toLowerCase() === 'li') items.push(convertListItem(child));
  }
  return items;
}

// A listItem is a block container: its text becomes a paragraph, and a nested
// <ul>/<ol> stays a nested list instead of being flattened into that paragraph.
function convertListItem(li) {
  const blocks = [];
  let inline = [];
  const flushInline = () => {
    if (inline.length) blocks.push({ type: 'paragraph', content: inline });
    inline = [];
  };

  for (const child of li.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) inline.push({ type: 'text', text: child.textContent });
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = child.tagName.toLowerCase();
    if (tag === 'ul' || tag === 'ol') {
      flushInline();
      blocks.push({ type: tag === 'ul' ? 'bulletList' : 'orderedList', content: convertListItems(child) });
    } else if (tag === 'p' || tag === 'div') {
      flushInline();
      blocks.push({ type: 'paragraph', content: convertInline(child) });
    } else {
      inline.push(...inlineElement(child));
    }
  }
  flushInline();
  return { type: 'listItem', content: blocks.length ? blocks : [{ type: 'paragraph', content: [] }] };
}

function convertInline(el) {
  const result = [];
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text) result.push({ type: 'text', text });
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const inlines = inlineElement(node);
      result.push(...inlines);
    }
  }
  return result;
}

function inlineElement(el, parentMarks = []) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'br') return [{ type: 'hardBreak' }];
  const marks = [...parentMarks];

  if (tag === 'strong' || tag === 'b') marks.push({ type: 'strong' });
  else if (tag === 'em' || tag === 'i') marks.push({ type: 'em' });
  else if (tag === 'u') marks.push({ type: 'underline' });
  else if (tag === 's') marks.push({ type: 'strike' });
  else if (tag === 'code') marks.push({ type: 'code' });
  else if (tag === 'a') {
    const href = safeHref(el.getAttribute('href'));
    if (href) marks.push({ type: 'link', attrs: { href } });
  } else if (tag === 'span') {
    const color = el.style?.color;
    if (color) marks.push({ type: 'textColor', attrs: { color: rgbToHex(color) } });
  }

  const result = [];
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent;
      if (text) {
        const node = { type: 'text', text };
        if (marks.length) node.marks = marks;
        result.push(node);
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      result.push(...inlineElement(child, marks));
    }
  }
  return result;
}

function rgbToHex(color) {
  if (color.startsWith('#')) return color;
  const m = color.match(/\d+/g);
  if (!m || m.length < 3) return color;
  return '#' + m.slice(0, 3).map(n => parseInt(n).toString(16).padStart(2, '0')).join('');
}

function toAdfWithLink(html, epicId, epicUrl, mediaMap = null) {
  const adf = htmlToAdf(html, mediaMap);
  // A Jira-only task (create target "Jira") has no Azure counterpart — there is
  // nothing to link to, and "Epic ID: null" must never land in a description.
  if (epicId == null || !epicUrl) return adf;
  // Append Azure DevOps link block
  adf.content.push(
    { type: 'paragraph', content: [{ type: 'text', text: `Azure DevOps Epic ID: ${epicId}`, marks: [{ type: 'strong' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: epicUrl, marks: [{ type: 'link', attrs: { href: epicUrl } }] }] }
  );
  return adf;
}

async function parseJira(res, label) {
  if (res.status === 204) return {};

  const text = await res.text();

  if (text.trimStart().startsWith('<')) {
    if (res.status === 503) {
      throw new Error('Proxy server not reachable — run "npm run dev" (not just "vite").');
    }
    throw new Error(
      `Jira returned HTML (status ${res.status}). ` +
      `Check that the proxy server is running and the API token is valid.`
    );
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`${label}: invalid response (status ${res.status})`);
  }

  if (!res.ok) {
    const errParts = [];
    if (data.errorMessages?.length) errParts.push(...data.errorMessages);
    if (data.errors && Object.keys(data.errors).length) errParts.push(Object.values(data.errors).join('; '));
    if (data.message) errParts.push(data.message);
    if (data.error) errParts.push(data.error);
    let msg = errParts.join(' | ') || `Jira error ${res.status}: ${text.substring(0, 300)}`;
    // INVALID_INPUT is Jira's generic payload rejection with no field-level
    // detail — explain what it usually means so the modal is actionable.
    if (/INVALID_INPUT/i.test(msg) && !(data.errors && Object.keys(data.errors).length)) {
      msg += ` — Jira couldn't store this content (HTTP ${res.status}). It usually means the description has formatting Jira rejects (e.g. an empty list or quote).`;
    }
    // Always log the raw response so the exact reason is inspectable in the console.
    console.error(`[${label}] Jira ${res.status} response:`, text);
    throw new Error(msg);
  }
  return data;
}

// ─── Child issues under an existing parent ────────────────────────────────────
// Jira's hierarchy in these projects is Request (level 2) → Epic (1) →
// Task/Story (0) → Sub-task (-1), and every level is linked through the `parent`
// field. A child may only sit exactly one level below its parent, so callers
// pick the type from the parent's hierarchyLevel (see getProjectIssueTypes,
// whose entries carry hierarchyLevel).
//
// Unlike createIssue() — the "new request" flow, which stamps the Azure work-item
// id — this creates a plain Jira issue with no Azure counterpart.
export async function createChildIssue(cloudId, projectKey, issueTypeId, parentKey, summary, descriptionHtml, { componentIds, fields } = {}) {
  const ids = (Array.isArray(componentIds) ? componentIds : [componentIds]).filter(Boolean);
  const body = {
    fields: {
      project:     { key: projectKey },
      issuetype:   { id: String(issueTypeId) },
      parent:      { key: parentKey },
      summary,
      description: htmlToAdf(descriptionHtml),
      ...(ids.length ? { components: ids.map(id => ({ id: String(id) })) } : {}),
      // Caller-supplied extras (assignee, priority, Developer/QA, estimates…),
      // already shaped for Jira and pre-filtered against the create screen.
      ...(fields || {}),
    },
  };
  const res = await fetch(`${jiraBase(cloudId)}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJira(res, 'createChildIssue');
}

/**
 * Statuses actually in use by one issue type in a project.
 *
 * There is no cheap authoritative list for us: `/project/{key}/statuses` and
 * `/statuses/search` both answer 401 "scope does not match" with our token, and
 * `/status` is the whole site. So harvest the distinct statuses off recent issues
 * of that type — the ones the team really uses, which is what a picker wants.
 * 4 pages × 100 issues covers every status in ABS (Backlog only shows up a few
 * pages in). Ordered new → in-progress → done.
 */
export async function getStatusesUsedByType(cloudId, projectKey, typeName, { pages = 4 } = {}) {
  const jql = `project = "${projectKey}" AND issuetype = "${typeName}" ORDER BY created DESC`;
  const seen = new Map();   // name → statusCategory key
  let nextPageToken = null;
  for (let page = 0; page < pages; page++) {
    const body = { jql, maxResults: 100, fields: ['status'], ...(nextPageToken ? { nextPageToken } : {}) };
    const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJira(res, 'getStatusesUsedByType');
    for (const issue of data.issues ?? []) {
      const s = issue.fields?.status;
      if (s?.name && !seen.has(s.name)) seen.set(s.name, s.statusCategory?.key || 'new');
    }
    nextPageToken = data.nextPageToken ?? null;
    if (!nextPageToken) break;
  }
  const rank = { new: 0, indeterminate: 1, done: 2 };
  return [...seen.entries()]
    .map(([name, category]) => ({ name, category }))
    .sort((a, b) => (rank[a.category] ?? 1) - (rank[b.category] ?? 1) || a.name.localeCompare(b.name));
}

// Active + future sprints across a project's scrum boards, deduped by id.
export async function getSprintOptions(cloudId, projectKey) {
  const boards = await getBoardsForProject(cloudId, projectKey);
  const scrum  = boards.filter(b => b.type === 'scrum');
  const lists  = await Promise.all(scrum.map(b =>
    getSprintsForBoard(cloudId, b.id).catch(() => [])
  ));
  const byId = new Map();
  for (const list of lists) {
    for (const s of list) if (!byId.has(s.id)) byId.set(s.id, { id: s.id, name: s.name, state: s.state });
  }
  // Active first — that's the one people mean by "the current sprint".
  return [...byId.values()].sort((a, b) =>
    (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1) || a.name.localeCompare(b.name));
}

/**
 * The Sprint field (gh-sprint) is written as a bare sprint id on some instances
 * and as an array on others, and Jira rejects the wrong shape with a 400. Set it
 * AFTER the create so a shape mismatch can never leave a duplicate issue behind.
 */
export async function setIssueSprint(cloudId, issueKey, sprintFieldId, sprintId) {
  const id = Number(sprintId);
  const first = await editIssueFieldsRaw(cloudId, issueKey, { [sprintFieldId]: id });
  if (first.ok) return first;
  const second = await editIssueFieldsRaw(cloudId, issueKey, { [sprintFieldId]: [id] });
  if (second.ok) return second;
  throw new Error(first.error || second.error || 'Could not set the sprint');
}

/**
 * Walk the workflow toward `statusName` (a fresh issue always starts in the
 * workflow's initial status, so the wanted status is often 1–2 transitions away).
 * Greedy with a hop cap and a visited set; returns true when it lands on it.
 */
export async function transitionIssueToStatus(cloudId, issueKey, statusName) {
  if (!statusName) return true;
  const wanted = statusName.trim().toLowerCase();
  try {
    const current = await getIssueFull(cloudId, issueKey);
    if (current.fields?.status?.name?.trim().toLowerCase() === wanted) return true;
  } catch { /* fall through and try transitions anyway */ }

  const visited = new Set();
  for (let hops = 0; hops < 8; hops++) {
    const transitions = await getTransitions(cloudId, issueKey);
    if (!transitions.length) return false;
    const direct = transitions.find(t => t.to?.name?.trim().toLowerCase() === wanted);
    if (direct) { await transitionIssue(cloudId, issueKey, direct.id); return true; }
    const next = transitions.find(t => t.to?.name && !visited.has(t.to.name.trim().toLowerCase()));
    if (!next) return false;
    visited.add(next.to.name.trim().toLowerCase());
    await transitionIssue(cloudId, issueKey, next.id);
  }
  return false;
}

/**
 * Search issues that can act as a parent (Requests / Epics) by key or summary.
 * An empty query lists the most recently updated candidates, so the picker is
 * useful before the user types anything.
 * @returns {Promise<Array<{key, summary, type, hierarchyLevel, status, components}>>}
 */
export async function searchParentCandidates(cloudId, projectKeys, query, { types = ['Request', 'Epic'], max = 30 } = {}) {
  const keys = (Array.isArray(projectKeys) ? projectKeys : [projectKeys]).filter(Boolean);
  // Quotes and backslashes would break out of the JQL string literal.
  const q = String(query || '').replace(/["\\]/g, ' ').trim();

  const clauses = [];
  if (keys.length) clauses.push(`project in (${keys.map(k => `"${k}"`).join(',')})`);
  clauses.push(`issuetype in (${types.map(t => `"${t}"`).join(',')})`);
  const asKey = q.toUpperCase().match(/^[A-Z][A-Z0-9]*-\d+$/);
  if (asKey)      clauses.push(`key = "${asKey[0]}"`);
  // A trailing wildcard only works on a single term; a phrase is matched as-is.
  else if (q)     clauses.push(`summary ~ "${/\s/.test(q) ? q : `${q}*`}"`);

  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`;
  const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: max, fields: ['summary', 'issuetype', 'status', 'components'] }),
  });
  const data = await parseJira(res, 'searchParentCandidates');
  return (data.issues ?? []).map(i => ({
    key:            i.key,
    summary:        i.fields?.summary || '',
    type:           i.fields?.issuetype?.name || '',
    hierarchyLevel: i.fields?.issuetype?.hierarchyLevel ?? null,
    status:         i.fields?.status?.name || '',
    components:     (i.fields?.components ?? []).map(c => ({ id: c.id, name: c.name })),
  }));
}

export async function createIssue(cloudId, projectKey, issueTypeId, summary, description, epicId, epicUrl, clientRequestIdField, componentId) {
  const url = `${jiraBase(cloudId)}/issue`;
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary,
      description: toAdfWithLink(description, epicId, epicUrl),
      // Jira-only creation passes no Azure id — the link field stays untouched
      // (sending null makes Jira reject the whole payload on a number field).
      ...(epicId != null && clientRequestIdField ? { [clientRequestIdField]: epicId } : {}),
      ...(componentId ? { components: [{ id: String(componentId) }] } : {}),
    },
  };
  console.log('[createIssue] body:', JSON.stringify(body, null, 2));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await parseJira(res, 'createIssue');
  console.log('[createIssue] response:', result);
  return result;
}

export async function updateIssue(cloudId, issueKey, summary, description) {
  const url = `${jiraBase(cloudId)}/issue/${issueKey}`;
  const body = { fields: { summary, description: htmlToAdf(description) } };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJira(res, 'updateIssue');
}

export async function findIssueByEpicId(cloudId, projectKey, clientRequestIdField, epicId) {
  const fieldId = clientRequestIdField.replace('customfield_', '');
  const jql = `project = "${projectKey}" AND cf[${fieldId}] = ${epicId}`;
  const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jql, maxResults: 1 }),
  });
  const data = await parseJira(res, 'findIssue');
  return data.issues?.[0] ?? null;
}

/**
 * Resolve Jira issue keys by the Azure work-item id stored on the Jira side
 * (clientRequestIdField, e.g. customfield_10034). This is the authoritative link
 * direction — createIssue() always stamps the Azure id on the Jira request,
 * whereas the Azure-side jiraIdField (Custom.JiraID / Custom.JiraLink) is often
 * left blank. Scoped to the given Jira project(s) so Azure ids from different
 * orgs (which reuse low numbers) can't collide across projects.
 *
 * @param {string|string[]} projectKeys - Jira project key(s) to scope the search
 * @returns {Promise<Map<string, string>>} Map<String(azureId), jiraKey>
 */
export async function getIssueKeysByAzureIds(cloudId, projectKeys, clientRequestIdField, azureIds) {
  const fieldId = clientRequestIdField.replace('customfield_', '');
  const ids = [...new Set((azureIds || []).map(Number).filter(Number.isFinite))];
  const out = new Map();
  if (!ids.length) return out;

  const keys = (Array.isArray(projectKeys) ? projectKeys : [projectKeys]).filter(Boolean);
  const projectClause = keys.length
    ? `project in (${keys.map(k => `"${k}"`).join(',')}) AND `
    : '';

  // Chunk the id list to keep each JQL query well under Jira's length limit;
  // the chunks are independent, so run them concurrently.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  await Promise.all(chunks.map(async (chunk) => {
    const jql = `${projectClause}cf[${fieldId}] in (${chunk.join(',')})`;
    const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, maxResults: 100, fields: [clientRequestIdField] }),
    });
    const data = await parseJira(res, 'getIssueKeysByAzureIds');
    for (const issue of data.issues ?? []) {
      const azureId = issue.fields?.[clientRequestIdField];
      if (azureId != null) out.set(String(azureId), issue.key);
    }
  }));
  return out;
}

/**
 * Upload file attachments to an existing Jira issue.
 * @param {string} cloudId
 * @param {string} issueKey - e.g. 'ABS-123'
 * @param {Array<{name: string, blob: Blob}>} files
 * @returns {Promise<Array<{id: string, filename: string}>>} created attachments
 */
export async function uploadJiraAttachments(cloudId, issueKey, files) {
  if (!files?.length) return [];
  const url = `${jiraBase(cloudId)}/issue/${issueKey}/attachments`;
  const created = [];
  for (const file of files) {
    const form = new FormData();
    form.append('file', file.blob, file.name);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Atlassian-Token': 'no-check' },
      body: form,
    });
    const data = await parseJira(res, 'uploadAttachment');
    // The attachments endpoint returns an array of the created attachment objects.
    if (Array.isArray(data)) created.push(...data);
  }
  return created;
}

// An ADF `media` node can't reference the REST attachment id — it needs the
// attachment's Atlassian Media Services file UUID. The server resolves it from
// the attachment content redirect. Returns null if it can't be resolved.
export async function resolveAttachmentMediaId(cloudId, attachmentId) {
  try {
    const res = await fetch(`/api/jira/attachment-media-id/${cloudId}/${attachmentId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.mediaId || null;
  } catch {
    return null;
  }
}

/**
 * Re-write an issue's description so the just-uploaded attachments render inline
 * as media nodes. Call after createIssue + uploadJiraAttachments.
 * @param {Array<{id: string, filename: string}>} uploaded - from uploadJiraAttachments
 * @param {{epicId: (string|number), epicUrl: string}|null} link - append Azure
 *        link block (create flow) or null (edit flow) to mirror the original ADF.
 */
export async function embedAttachmentImages(cloudId, issueKey, html, uploaded, link = null) {
  if (!uploaded?.length) return;

  // Resolve each attachment's media UUID; build a { fileName: mediaUuid } map.
  const entries = await Promise.all(uploaded.map(async (a) => {
    const mediaId = await resolveAttachmentMediaId(cloudId, a.id);
    return mediaId ? [a.filename, mediaId] : null;
  }));
  const mediaMap = Object.fromEntries(entries.filter(Boolean));
  if (!Object.keys(mediaMap).length) return;   // nothing resolved — leave description as-is

  const adf = link
    ? toAdfWithLink(html, link.epicId, link.epicUrl, mediaMap)
    : htmlToAdf(html, mediaMap);
  const url = `${jiraBase(cloudId)}/issue/${issueKey}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { description: adf } }),
  });
  return parseJira(res, 'embedAttachmentImages');
}

export async function getJiraIssueByKey(cloudId, issueKey, clientRequestIdField) {
  const url = `${jiraBase(cloudId)}/issue/${issueKey}?fields=summary,description,${clientRequestIdField}`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getJiraIssue');
  return {
    summary:     data.fields?.summary ?? '',
    description: adfToHtml(data.fields?.description),
    azureId:     data.fields?.[clientRequestIdField] ?? null,
  };
}

export async function setJiraAzureId(cloudId, issueKey, clientRequestIdField, azureId) {
  const url = `${jiraBase(cloudId)}/issue/${issueKey}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { [clientRequestIdField]: azureId } }),
  });
  return parseJira(res, 'setJiraAzureId');
}

export function getJiraUrl(issueKey) {
  return `https://dynamicalabs.atlassian.net/browse/${issueKey}`;
}

/**
 * Batch-fetch the current state of many Jira issues by key.
 * Returns a Map<key, { key, summary, status, statusCategory, assignee, type, priority }>.
 * Keys that don't exist (or aren't visible) are simply absent from the map.
 */
// Copy the optional analytics fields onto an issue row, but ONLY the ones the
// caller actually asked for — an absent key must stay absent rather than
// becoming a fake `null`/`[]`, so a consumer can tell "not requested" from
// "empty". Shared by getIssuesStatusByKeys and getChildIssuesTreesBulk; the
// camelCase names are what Project Status' metrics read.
const EXTRA_FIELD_MAP = {
  resolutiondate:            ['resolutionDate', v => v ?? null],
  updated:                   ['updated',        v => v ?? ''],
  statuscategorychangedate:  ['statusChanged',  v => v ?? ''],
  duedate:                   ['dueDate',        v => v ?? null],
  components:                ['components',     v => (v ?? []).map(c => c?.name).filter(Boolean)],
  labels:                    ['labels',         v => v ?? []],
};

function applyExtraFields(row, f, requested) {
  for (const name of requested) {
    const spec = EXTRA_FIELD_MAP[name];
    if (spec) row[spec[0]] = spec[1](f[name]);
    else if (f[name] !== undefined) row[name] = f[name];   // raw custom field
  }
  return row;
}

export async function getIssuesStatusByKeys(cloudId, keys, { fields: extraFields = [] } = {}) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  const out = new Map();
  if (!unique.length) return out;

  const fields = ['summary', 'status', 'assignee', 'issuetype', 'priority', ...extraFields];
  // JQL `key in (...)` — chunk to keep the query string well under Jira's
  // limit; the chunks are independent, so run them concurrently.
  const chunks = [];
  for (let i = 0; i < unique.length; i += 50) chunks.push(unique.slice(i, i + 50));
  await Promise.all(chunks.map(async (chunk) => {
    const jql = `key in (${chunk.join(',')})`;
    const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, maxResults: 100, fields }),
    });
    const data = await parseJira(res, 'getIssuesStatusByKeys');
    for (const issue of data.issues ?? []) {
      const f = issue.fields ?? {};
      out.set(issue.key, applyExtraFields({
        key:            issue.key,
        summary:        f.summary ?? '',
        status:         f.status?.name ?? '',
        statusCategory: f.status?.statusCategory?.key ?? '',  // 'new' | 'indeterminate' | 'done'
        assignee:       f.assignee?.displayName ?? null,
        type:           f.issuetype?.name ?? '',
        priority:       f.priority?.name ?? '',
      }, f, extraFields));
    }
  }));
  return out;
}

// ─── ADF → HTML converter ─────────────────────────────────────────────────────
// Converts Atlassian Document Format back to HTML for display in TipTap.

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Only allow safe link schemes. A `javascript:` href stored in a Jira
// description would otherwise become a live link once rendered in the editor.
function safeHref(href) {
  const h = String(href || '').trim();
  return /^(https?:|mailto:)/i.test(h) ? h : '';
}

function adfInline(node) {
  if (!node) return '';
  if (node.type !== 'text') return adfBlock(node);
  let text = escHtml(node.text || '');
  for (const mark of (node.marks || [])) {
    if (mark.type === 'strong')    text = `<strong>${text}</strong>`;
    else if (mark.type === 'em')   text = `<em>${text}</em>`;
    else if (mark.type === 'underline') text = `<u>${text}</u>`;
    else if (mark.type === 'strike')    text = `<s>${text}</s>`;
    else if (mark.type === 'code')      text = `<code>${text}</code>`;
    else if (mark.type === 'link') {
      const href = safeHref(mark.attrs?.href);
      if (href) text = `<a href="${escHtml(href).replace(/"/g, '&quot;')}">${text}</a>`;
    }
    else if (mark.type === 'textColor') text = `<span style="color:${escHtml(mark.attrs?.color || '')}">${text}</span>`;
  }
  return text;
}

function adfBlock(node) {
  if (!node) return '';
  const children = (content) => (content || []).map(adfBlock).join('');
  const inlines  = (content) => (content || []).map(adfInline).join('');

  switch (node.type) {
    case 'doc':         return children(node.content);
    case 'paragraph':   return `<p>${inlines(node.content)}</p>`;
    case 'heading':     return `<h${node.attrs?.level || 1}>${inlines(node.content)}</h${node.attrs?.level || 1}>`;
    case 'bulletList':  return `<ul>${children(node.content)}</ul>`;
    case 'orderedList': return `<ol>${children(node.content)}</ol>`;
    case 'listItem':    return `<li>${children(node.content)}</li>`;
    case 'blockquote':  return `<blockquote>${children(node.content)}</blockquote>`;
    case 'codeBlock':   return `<pre><code>${escHtml((node.content || []).map(n => n.text || '').join(''))}</code></pre>`;
    case 'text':        return adfInline(node);
    case 'hardBreak':   return '<br>';
    case 'rule':        return '<hr>';
    default:            return children(node.content);
  }
}

export function adfToHtml(adf) {
  if (!adf) return '';
  return adfBlock(adf);
}

// ─── Task Agent API ───────────────────────────────────────────────────────────

export async function getIssueFull(cloudId, issueKey) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}`;
  const res = await fetch(url);
  return parseJira(res, 'getIssueFull');
}

export async function getProjectIssueTypes(cloudId, projectKey) {
  const url = `${jiraBase(cloudId)}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getProjectIssueTypes');
  const arr = data.issueTypes ?? data.values ?? [];
  return Array.isArray(arr) ? arr : [];
}

export async function getCreateMetaFields(cloudId, projectKey, issueTypeId) {
  const url = `${jiraBase(cloudId)}/issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${issueTypeId}`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getCreateMetaFields');
  // Jira returns either a map { fieldId: meta } or a paginated array { fields: [...] }
  if (Array.isArray(data.fields)) {
    return Object.fromEntries(data.fields.map(f => [f.fieldId ?? f.key, f]));
  }
  return data.fields ?? {};
}

// Fields editable on an existing issue. Used after a cross-project create to
// recover fields that aren't on the target project's *create* screen but can
// still be set via edit (assignee, custom fields, components, versions, …).
export async function getEditMetaFields(cloudId, issueKey) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/editmeta`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getEditMetaFields');
  return data.fields ?? {};
}

// Edit an issue's fields, returning field-level errors instead of throwing so
// the caller can drop rejected fields and retry. Never throws on a Jira error.
export async function editIssueFieldsRaw(cloudId, issueKey, fields) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    return { ok: false, errors: {}, errorMessages: [err.message] };
  }
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (res.ok) return { ok: true };
  return { ok: false, errors: data.errors ?? {}, errorMessages: data.errorMessages ?? [] };
}

export async function getJiraProjects(cloudId) {
  const url = `${jiraBase(cloudId)}/project/search?maxResults=100&orderBy=name`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getJiraProjects');
  return data.values ?? [];
}

// Components defined on a Jira project — used to populate the "Component"
// selector on the create form. Returns [{ id, name, description }, ...].
export async function getProjectComponents(cloudId, projectKey) {
  const url = `${jiraBase(cloudId)}/project/${encodeURIComponent(projectKey)}/components`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getProjectComponents');
  // The non-paginated endpoint returns a bare array; guard for the paginated shape too.
  return Array.isArray(data) ? data : (data.values ?? []);
}

// Add a component to an existing issue WITHOUT removing the components already
// on it. Uses the ADF `update` verb (`add`) instead of overwriting the whole
// `components` field, so a request that already has other components keeps them.
// Never throws — returns { ok } or { ok:false, error } so a batch keeps going.
export async function addIssueComponent(cloudId, issueKey, componentIds) {
  const ids = (Array.isArray(componentIds) ? componentIds : [componentIds]).filter(Boolean);
  if (!ids.length) return { ok: false, error: 'No component selected' };
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: { components: ids.map(id => ({ add: { id: String(id) } })) } }),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (res.ok) return { ok: true };
  const parts = [];
  if (data.errorMessages?.length) parts.push(...data.errorMessages);
  if (data.errors && Object.keys(data.errors).length) parts.push(Object.values(data.errors).join('; '));
  return { ok: false, error: parts.join(' | ') || `HTTP ${res.status}` };
}

// Add labels to an existing issue WITHOUT dropping the ones already on it
// (additive `update` verb, same pattern as addIssueComponent). Used to re-assert
// labels a project automation rule strips off a freshly created issue.
// Never throws — returns { ok } or { ok:false, error }.
export async function addIssueLabels(cloudId, issueKey, labels) {
  const list = (Array.isArray(labels) ? labels : [labels]).filter(Boolean);
  if (!list.length) return { ok: false, error: 'No labels given' };
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: { labels: list.map(l => ({ add: String(l) })) } }),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (res.status === 204 || res.ok) return { ok: true };
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* non-JSON error body */ }
  const parts = [];
  if (data.errorMessages?.length) parts.push(...data.errorMessages);
  if (data.errors && Object.keys(data.errors).length) parts.push(Object.values(data.errors).join('; '));
  return { ok: false, error: parts.join(' | ') || `HTTP ${res.status}` };
}

// Generic enhanced-search that follows nextPageToken pagination and returns all
// matching issues (capped by maxTotal as a safety valve).
export async function searchIssuesPaged(cloudId, jql, fields, { maxTotal = 2000 } = {}) {
  const out = [];
  let nextPageToken = null;
  do {
    const body = { jql, maxResults: 100, fields, ...(nextPageToken ? { nextPageToken } : {}) };
    const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJira(res, 'searchIssuesPaged');
    out.push(...(data.issues ?? []));
    nextPageToken = data.nextPageToken ?? null;
  } while (nextPageToken && out.length < maxTotal);
  return out;
}

// Valid statuses per issue type in a project: [{ id, name, statuses: [...] }].
// Needs the read:issue-status:jira scope on granular tokens.
export async function getProjectStatuses(cloudId, projectKey) {
  const url = `${jiraBase(cloudId)}/project/${encodeURIComponent(projectKey)}/statuses`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getProjectStatuses');
  return Array.isArray(data) ? data : [];
}

export async function createRawIssue(cloudId, fields) {
  const url = `${jiraBase(cloudId)}/issue`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  return parseJira(res, 'createRawIssue');
}

// outwardKey "clones" inwardKey (inwardKey "is cloned by" outwardKey)
export async function addIssueLink(cloudId, outwardKey, inwardKey, linkTypeName = 'Clones') {
  const url = `${jiraBase(cloudId)}/issueLink`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: { name: linkTypeName },
      outwardIssue: { key: outwardKey },
      inwardIssue:  { key: inwardKey },
    }),
  });
  return parseJira(res, 'addIssueLink');
}

// Native cross-project move via Jira's Bulk operations API. Preserves comments,
// attachments, worklogs, history and status — unlike a clone+delete. Returns a
// { taskId } to poll with getBulkTaskStatus. `targetToSourcesMapping` keys are
// "<projectIdOrKey>,<issueTypeId>[,<parentIdOrKey>]" (parent only for subtasks).
export async function bulkMoveIssues(cloudId, targetToSourcesMapping, sendBulkNotification = false) {
  const url = `${jiraBase(cloudId)}/bulk/issues/move`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sendBulkNotification, targetToSourcesMapping }),
  });
  return parseJira(res, 'bulkMoveIssues');
}

// Poll a bulk operation. status ∈ ENQUEUED|RUNNING|COMPLETE|FAILED|CANCEL_REQUESTED|CANCELLED|DEAD.
export async function getBulkTaskStatus(cloudId, taskId) {
  const url = `${jiraBase(cloudId)}/bulk/queue/${encodeURIComponent(taskId)}`;
  const res = await fetch(url);
  return parseJira(res, 'getBulkTaskStatus');
}

// ─── Legacy clone+delete move helpers (fallback when Bulk Move is unavailable) ──

// All worklog entries on an issue (author, time spent, start date, comment).
export async function getWorklogs(cloudId, issueKey) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/worklog?maxResults=1000`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getWorklogs');
  return data.worklogs ?? [];
}

// Add a single worklog entry. `worklog` is the raw API body:
// { timeSpentSeconds, started, comment? } — comment must be ADF on API v3.
export async function addWorklog(cloudId, issueKey, worklog) {
  // adjustEstimate=leave keeps the remaining estimate untouched per entry.
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/worklog?adjustEstimate=leave`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(worklog),
  });
  return parseJira(res, 'addWorklog');
}

// Shape one raw ADF comment into { id, author, created, html }.
function mapComment(c) {
  return {
    id:      c.id,
    author:  c.author?.displayName || 'Unknown',
    created: c.created || null,
    html:    adfToHtml(c.body),
  };
}

// Comments on an issue, newest first, with the ADF body pre-rendered to HTML
// (via our own adfToHtml, so the markup is safe by construction).
// Returns [{ id, author, created, html }].
//
// **Read through the ISSUE endpoint, not `/issue/{key}/comment`.** With our
// API-token auth Atlassian answers the dedicated comment resource with
// `401 {"code":401,"message":"Unauthorized; scope does not match"}` while
// `GET /issue/{key}?fields=comment` returns the very same comment list — that
// 401 used to surface as a red error under every Jira card in the Azure-Jira
// tab. `?fields=comment` caps out at Jira's default page size, so the
// dedicated resource is still tried first for issues with long threads and
// only its failure falls back.
export async function getIssueComments(cloudId, issueKey) {
  const paged = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/comment?maxResults=100&orderBy=-created`;
  try {
    const data = await parseJira(await fetch(paged), 'getIssueComments');
    return (data.comments ?? []).map(mapComment);
  } catch {
    const url  = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}?fields=comment`;
    const data = await parseJira(await fetch(url), 'getIssueComments(field)');
    const list = data.fields?.comment?.comments ?? [];
    // The field variant comes back oldest-first.
    return list.map(mapComment).reverse();
  }
}

// Add a comment; `html` is TipTap-style HTML converted through the same
// HTML→ADF pass as descriptions. Mirrors the read path above: POST to the
// comment resource first, and if that is blocked (401 "scope does not match")
// add the comment through the issue-edit verb, which our token may use.
export async function addIssueComment(cloudId, issueKey, html) {
  const body = htmlToAdf(html);
  const url  = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/comment`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    return await parseJira(res, 'addIssueComment');
  } catch (err) {
    const res = await fetch(`${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ update: { comment: [{ add: { body } }] } }),
    });
    if (!res.ok) throw err;   // report the original failure, not the fallback's
    return parseJira(res, 'addIssueComment(update)');
  }
}

// Global priority list: [{ id, name, iconUrl }].
export async function getPriorities(cloudId) {
  const url = `${jiraBase(cloudId)}/priority`;
  const data = await parseJira(await fetch(url), 'getPriorities');
  return Array.isArray(data) ? data : (data.values ?? []);
}

// Available workflow transitions for an issue, each with the status it leads to.
export async function getTransitions(cloudId, issueKey) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/transitions`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getTransitions');
  return data.transitions ?? [];
}

export async function transitionIssue(cloudId, issueKey, transitionId) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}/transitions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  return parseJira(res, 'transitionIssue');
}

export async function deleteIssue(cloudId, issueKey) {
  const url = `${jiraBase(cloudId)}/issue/${encodeURIComponent(issueKey)}?deleteSubtasks=false`;
  const res = await fetch(url, { method: 'DELETE' });
  return parseJira(res, 'deleteIssue');
}

export async function downloadAttachmentBlob(cloudId, attachmentId) {
  const res = await fetch(`/api/jira/attachment-binary/${cloudId}/${attachmentId}`);
  if (!res.ok) throw new Error(`Attachment download failed: HTTP ${res.status}`);
  return res.blob();
}

export async function searchJiraUsers(cloudId, query) {
  const url = `${jiraBase(cloudId)}/user/search?query=${encodeURIComponent(query)}&maxResults=10`;
  const res  = await fetch(url);
  const data = await parseJira(res, 'searchJiraUsers');
  return Array.isArray(data) ? data : [];
}

function jiraAgile(cloudId) {
  return `${BASE}/ex/jira/${cloudId}/rest/agile/1.0`;
}

export async function getBoardsForProject(cloudId, projectKey) {
  const url = `${jiraAgile(cloudId)}/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=10`;
  const res  = await fetch(url);
  const data = await parseJira(res, 'getBoardsForProject');
  return data.values ?? [];
}

export async function getSprintsForBoard(cloudId, boardId) {
  const url = `${jiraAgile(cloudId)}/board/${boardId}/sprint?state=active,future&maxResults=50`;
  const res  = await fetch(url);
  const data = await parseJira(res, 'getSprintsForBoard');
  return data.values ?? [];
}

export async function getChildIssues(cloudId, issueKey) {
  const fields = ['summary', 'issuetype', 'priority', 'assignee', 'parent', 'labels', 'attachment'];
  const seen = new Set();
  const results = [];

  async function runSearch(jql) {
    try {
      const res  = await fetch(`${jiraBase(cloudId)}/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, maxResults: 100, fields }),
      });
      const data = await parseJira(res, 'getChildIssues');
      for (const issue of data.issues ?? []) {
        if (!seen.has(issue.key)) { seen.add(issue.key); results.push(issue); }
      }
    } catch { /* ignore failing JQL variant */ }
  }

  await runSearch(`parent = "${issueKey}" ORDER BY created ASC`);
  await runSearch(`"Epic Link" = "${issueKey}" ORDER BY created ASC`);
  return results;
}

/**
 * Children of a Jira request (subtasks + Epic children), normalised with their
 * current status — same shape as getIssuesStatusByKeys() values.
 * Returns [] on any failure so a single bad parent never breaks the batch.
 */
export async function getChildIssuesStatus(cloudId, parentKey) {
  const fields = ['summary', 'status', 'assignee', 'issuetype', 'priority'];
  const seen = new Map();

  async function runSearch(jql) {
    try {
      const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jql, maxResults: 100, fields }),
      });
      const data = await parseJira(res, 'getChildIssuesStatus');
      for (const issue of data.issues ?? []) {
        if (seen.has(issue.key)) continue;
        const f = issue.fields ?? {};
        seen.set(issue.key, {
          key:            issue.key,
          summary:        f.summary ?? '',
          status:         f.status?.name ?? '',
          statusCategory: f.status?.statusCategory?.key ?? '',
          assignee:       f.assignee?.displayName ?? null,
          type:           f.issuetype?.name ?? '',
          priority:       f.priority?.name ?? '',
        });
      }
    } catch { /* ignore failing JQL variant */ }
  }

  await runSearch(`parent = "${parentKey}" ORDER BY created ASC`);
  await runSearch(`"Epic Link" = "${parentKey}" ORDER BY created ASC`);
  return Array.from(seen.values());
}

/**
 * Full descendant tree of a Jira request: each node is an issue (same shape as
 * getChildIssuesStatus) plus a `children` array of the same. Recurses so epics
 * show their tasks, tasks show their subtasks, etc.
 * `_visited` guards against link cycles; `maxDepth` caps recursion.
 */
export async function getChildIssuesTree(cloudId, parentKey, maxDepth = 5, _visited = null) {
  const visited = _visited ?? new Set([parentKey]);
  const direct = await getChildIssuesStatus(cloudId, parentKey);
  const out = [];
  for (const child of direct) {
    if (visited.has(child.key)) continue;
    visited.add(child.key);
    const grandchildren = maxDepth > 1
      ? await getChildIssuesTree(cloudId, child.key, maxDepth - 1, visited)
      : [];
    out.push({ ...child, children: grandchildren });
  }
  return out;
}

/**
 * Descendant trees for MANY parents at once — same node shape as
 * getChildIssuesTree, returned as Map<parentKey, node[]>. Walks the hierarchy
 * level by level with bulk `parent in (...)` / `"Epic Link" in (...)` searches
 * (2 paginated queries per 50 parents per level) instead of 2 queries per tree
 * node, which makes a whole board load in a handful of round trips.
 * Children attach via the returned `parent` field (Jira Cloud populates it for
 * both subtasks and epic children); an issue whose parent isn't in the current
 * level is ignored, and a `visited` set guards against link cycles.
 *
 * `fields` adds analytics fields to every node (see EXTRA_FIELD_MAP) — Project
 * Status asks for resolutiondate/updated/statuscategorychangedate/components,
 * which is what makes burn-up, throughput and aging computable without any
 * changelog request. `onProgress({ depth, nodes })` fires after each level.
 */
export async function getChildIssuesTreesBulk(cloudId, parentKeys, maxDepth = 5, { fields: extraFields = [], onProgress } = {}) {
  const roots = [...new Set((parentKeys || []).filter(Boolean))];
  const out = new Map(roots.map(k => [k, []]));
  if (!roots.length) return out;

  const fields = ['summary', 'status', 'assignee', 'issuetype', 'priority', 'parent', 'created', ...extraFields];
  const clauses = [
    list => `parent in (${list})`,
    list => `"Epic Link" in (${list})`,   // legacy fallback; may not exist → ignored
  ];
  // A clause variant that Jira rejects (typically "Epic Link" — the field is
  // gone on modern Cloud sites) is rejected for EVERY chunk on EVERY level, so
  // remember it after the first failure instead of paying a doomed round trip
  // per chunk per level. On ABS this halves the query count of the deep levels.
  const deadClauses = new Set();

  // All children of the given parent keys: one paginated search per chunk×clause,
  // all in parallel. A failing clause variant is skipped, mirroring
  // getChildIssuesStatus.
  async function searchLevel(keys) {
    const found = [];
    const chunks = [];
    for (let i = 0; i < keys.length; i += 50) chunks.push(keys.slice(i, i + 50));
    await Promise.all(chunks.flatMap(chunk => clauses.map(async (clause, clauseIdx) => {
      if (deadClauses.has(clauseIdx)) return;
      const jql = `${clause(chunk.join(','))} ORDER BY created ASC`;
      try {
        let nextPageToken;
        do {
          const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jql, maxResults: 100, fields, nextPageToken }),
          });
          const data = await parseJira(res, 'getChildIssuesTreesBulk');
          found.push(...(data.issues ?? []));
          nextPageToken = data.nextPageToken;
        } while (nextPageToken);
      } catch {
        deadClauses.add(clauseIdx);   // ignore this JQL variant from here on
      }
    })));
    return found;
  }

  const visited = new Set(roots);
  const nodeByKey = new Map();
  let level = roots;
  for (let depth = 0; depth < maxDepth && level.length; depth++) {
    const levelSet = new Set(level);
    const issues = await searchLevel(level);
    const next = [];
    for (const issue of issues) {
      if (visited.has(issue.key)) continue;
      const parentKey = issue.fields?.parent?.key;
      if (!parentKey || !levelSet.has(parentKey)) continue;
      visited.add(issue.key);
      const f = issue.fields ?? {};
      const node = applyExtraFields({
        key:            issue.key,
        summary:        f.summary ?? '',
        status:         f.status?.name ?? '',
        statusCategory: f.status?.statusCategory?.key ?? '',
        assignee:       f.assignee?.displayName ?? null,
        type:           f.issuetype?.name ?? '',
        priority:       f.priority?.name ?? '',
        created:        f.created ?? '',
        parentKey,
        children:       [],
      }, f, extraFields);
      nodeByKey.set(issue.key, node);
      (out.get(parentKey) ?? nodeByKey.get(parentKey).children).push(node);
      next.push(issue.key);
    }
    level = next;
    onProgress?.({ depth: depth + 1, nodes: nodeByKey.size });
  }

  // Chunk/clause queries resolve in arbitrary order — restore per-parent
  // created-ASC sibling order (what the per-node version returned).
  const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));
  for (const list of out.values()) list.sort(byCreated);
  for (const node of nodeByKey.values()) node.children.sort(byCreated);

  return out;
}
