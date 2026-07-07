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

// Jira's ADF validator rejects whole documents (HTTP 400 INVALID_INPUT) when
// they contain "empty" container nodes — a bulletList/orderedList with no
// listItems, a blockquote with no block children, or a listItem with no content.
// Rich descriptions occasionally produce these from the HTML→ADF pass, so we
// scrub them here before sending. Returns a cleaned array of nodes.
function sanitizeAdfNodes(nodes) {
  const out = [];
  for (const node of nodes || []) {
    const clean = sanitizeAdfNode(node);
    if (clean) out.push(clean);
  }
  return out;
}

function sanitizeAdfNode(node) {
  if (!node || typeof node !== 'object') return null;

  // Recurse into children first so emptiness is evaluated bottom-up.
  if (Array.isArray(node.content)) {
    node.content = sanitizeAdfNodes(node.content);
  }

  switch (node.type) {
    case 'bulletList':
    case 'orderedList':
      // Lists may only contain listItems and must contain at least one.
      node.content = (node.content || []).filter(c => c.type === 'listItem');
      return node.content.length ? node : null;

    case 'listItem':
      // A listItem must hold at least one block node.
      if (!node.content?.length) node.content = [{ type: 'paragraph', content: [] }];
      return node;

    case 'blockquote':
      // A blockquote must hold at least one block node.
      return node.content?.length ? node : null;

    default:
      return node;
  }
}

function convertNodes(nodes) {
  const result = [];
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent;
      if (text) result.push({ type: 'text', text });
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
  if (tag === 'h1') return { type: 'heading', attrs: { level: 1 }, content: convertInline(el) };
  if (tag === 'h2') return { type: 'heading', attrs: { level: 2 }, content: convertInline(el) };
  if (tag === 'h3') return { type: 'heading', attrs: { level: 3 }, content: convertInline(el) };
  if (tag === 'p')  return { type: 'paragraph', content: convertInline(el) };
  if (tag === 'blockquote') return { type: 'blockquote', content: convertNodes(el.childNodes).filter(n => n.type !== 'text') };
  if (tag === 'ul') return { type: 'bulletList', content: convertListItems(el) };
  if (tag === 'ol') return { type: 'orderedList', content: convertListItems(el) };
  if (tag === 'li') return { type: 'listItem', content: [{ type: 'paragraph', content: convertInline(el) }] };
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
    if (child.tagName.toLowerCase() === 'li') {
      items.push({ type: 'listItem', content: [{ type: 'paragraph', content: convertInline(child) }] });
    }
  }
  return items;
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

export async function createIssue(cloudId, projectKey, issueTypeId, summary, description, epicId, epicUrl, clientRequestIdField, componentId) {
  const url = `${jiraBase(cloudId)}/issue`;
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary,
      description: toAdfWithLink(description, epicId, epicUrl),
      [clientRequestIdField]: epicId,
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

  // Chunk the id list to keep each JQL query well under Jira's length limit.
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
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
  }
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
export async function getIssuesStatusByKeys(cloudId, keys) {
  const unique = [...new Set((keys || []).filter(Boolean))];
  const out = new Map();
  if (!unique.length) return out;

  const fields = ['summary', 'status', 'assignee', 'issuetype', 'priority'];
  // JQL `key in (...)` — chunk to keep the query string well under Jira's limit.
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const jql = `key in (${chunk.join(',')})`;
    const res = await fetch(`${jiraBase(cloudId)}/search/jql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, maxResults: 100, fields }),
    });
    const data = await parseJira(res, 'getIssuesStatusByKeys');
    for (const issue of data.issues ?? []) {
      const f = issue.fields ?? {};
      out.set(issue.key, {
        key:            issue.key,
        summary:        f.summary ?? '',
        status:         f.status?.name ?? '',
        statusCategory: f.status?.statusCategory?.key ?? '',  // 'new' | 'indeterminate' | 'done'
        assignee:       f.assignee?.displayName ?? null,
        type:           f.issuetype?.name ?? '',
        priority:       f.priority?.name ?? '',
      });
    }
  }
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
