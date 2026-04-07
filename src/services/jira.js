const BASE = '/api/jira';

function jiraBase(cloudId) {
  return `${BASE}/ex/jira/${cloudId}/rest/api/3`;
}

function toAdf(text) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function toAdfWithLink(description, epicId, epicUrl) {
  return {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: description }] },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: `Azure DevOps Epic ID: ${epicId}`, marks: [{ type: 'strong' }] }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: epicUrl, marks: [{ type: 'link', attrs: { href: epicUrl } }] }],
      },
    ],
  };
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
    const msg = data.errors
      ? Object.values(data.errors).join('; ')
      : data.message || data.error || data.errorMessages?.[0];
    throw new Error(msg || `Jira error ${res.status}`);
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseJira(res, 'createIssue');
}

export async function updateIssue(cloudId, issueKey, summary, description) {
  const url = `${jiraBase(cloudId)}/issue/${issueKey}`;
  const body = { fields: { summary, description: toAdf(description) } };
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

export function getJiraUrl(issueKey) {
  return `https://dynamicalabs.atlassian.net/browse/${issueKey}`;
}
