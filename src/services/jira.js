const BASE = '/api/jira';

function jiraBase(cloudId) {
  return `${BASE}/ex/jira/${cloudId}/rest/api/3`;
}

// ─── HTML → ADF converter ────────────────────────────────────────────────────
// Converts TipTap HTML output to Atlassian Document Format for Jira API v3.
// Handles: headings, paragraphs, bold, italic, underline, links, images,
// ordered/unordered lists, code, blockquotes, text color.

function htmlToAdf(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || '', 'text/html');
  const content = convertNodes(doc.body.childNodes);
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
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
    // Images are uploaded as Jira attachments separately.
    // Don't embed in ADF — Azure DevOps URLs require auth and break in Jira.
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
    const href = el.getAttribute('href');
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

function toAdfWithLink(html, epicId, epicUrl) {
  const adf = htmlToAdf(html);
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
    const msg = errParts.join(' | ') || `Jira error ${res.status}: ${text.substring(0, 300)}`;
    throw new Error(msg);
  }
  return data;
}

export async function createIssue(cloudId, projectKey, issueTypeId, summary, description, epicId, epicUrl, clientRequestIdField) {
  const url = `${jiraBase(cloudId)}/issue`;
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { id: issueTypeId },
      summary,
      description: toAdfWithLink(description, epicId, epicUrl),
      [clientRequestIdField]: epicId,
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
  const jql = encodeURIComponent(`project = "${projectKey}" AND cf[${fieldId}] = ${epicId}`);
  const url = `${jiraBase(cloudId)}/search?jql=${jql}&maxResults=1`;
  const res = await fetch(url);
  const data = await parseJira(res, 'findIssue');
  return data.issues?.[0] ?? null;
}

/**
 * Upload file attachments to an existing Jira issue.
 * @param {string} cloudId
 * @param {string} issueKey - e.g. 'ABS-123'
 * @param {Array<{name: string, blob: Blob}>} files
 */
export async function uploadJiraAttachments(cloudId, issueKey, files) {
  if (!files?.length) return;
  const url = `${jiraBase(cloudId)}/issue/${issueKey}/attachments`;
  for (const file of files) {
    const form = new FormData();
    form.append('file', file.blob, file.name);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Atlassian-Token': 'no-check' },
      body: form,
    });
    await parseJira(res, 'uploadAttachment');
  }
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

// ─── ADF → HTML converter ─────────────────────────────────────────────────────
// Converts Atlassian Document Format back to HTML for display in TipTap.

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    else if (mark.type === 'link')      text = `<a href="${escHtml(mark.attrs?.href || '')}">${text}</a>`;
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

export async function getJiraProjects(cloudId) {
  const url = `${jiraBase(cloudId)}/project/search?maxResults=100&orderBy=name`;
  const res = await fetch(url);
  const data = await parseJira(res, 'getJiraProjects');
  return data.values ?? [];
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
  const fields = 'summary,issuetype,priority,assignee,parent,labels,attachment';
  const seen = new Set();
  const results = [];

  async function runSearch(jql) {
    try {
      const url = `${jiraBase(cloudId)}/search?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${fields}`;
      const res  = await fetch(url);
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
