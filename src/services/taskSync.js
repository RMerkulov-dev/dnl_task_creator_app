import { createWorkItem, updateWorkItem, getWorkItem } from './azureDevops.js';
import { createIssue, updateIssue, findIssueByEpicId, getJiraUrl } from './jira.js';

// ─── Step counting ────────────────────────────────────────────────────────────
// Centralised so Dashboard and SyncModal always agree on step count.

export function getCreateStepCount(project) {
  if (!project.jira) return 1;                       // Azure only
  if (!project.azure.jiraIdField) return 2;          // Azure + Jira (no link-back field)
  return 3;                                           // Azure + Jira + link-back
}

export function getEditStepCount(project) {
  return project.jira ? 2 : 1;
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
/**
 * @param {object} project  - from projects.js
 * @param {string} title
 * @param {string} description
 * @param {object} extras   - { iterationPath?, storyUrl?, areaPath? }
 * @param {function} onStep - (stepIndex, status, errorMsg, data) => void
 */
export async function createTask(project, title, description, extras = {}, onStep) {
  const { azure, jira } = project;

  // ── Step 0: Azure work item ──────────────────────────────────────────────
  onStep(0, 'pending');

  const fields = {
    'System.Title':       title,
    'System.Description': description,
  };
  if (extras.iterationPath) fields['System.IterationPath'] = extras.iterationPath;
  if (extras.areaPath)      fields['System.AreaPath']      = extras.areaPath;

  const relations = extras.storyUrl
    ? [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: extras.storyUrl, attributes: { comment: '' } }]
    : [];

  let item;
  try {
    item = await createWorkItem(azure.proxyKey, azure.project, azure.workItemType, fields, relations);
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }

  const itemId  = item.id;
  const itemUrl = item._links?.html?.href ?? `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
  onStep(0, 'done', null, { epicId: itemId, epicUrl: itemUrl });

  // If no Jira configured for this project — we're done
  if (!jira) return { epicId: itemId, epicUrl: itemUrl, jiraKey: null, jiraUrl: null };

  // ── Step 1: Jira issue ───────────────────────────────────────────────────
  onStep(1, 'pending');
  let jiraItem;
  try {
    jiraItem = await createIssue(
      jira.cloudId, jira.projectKey, jira.issueTypeId,
      title, description, itemId, itemUrl, jira.clientRequestIdField
    );
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  const jiraKey = jiraItem.key;
  const jiraUrl = getJiraUrl(jiraKey);
  onStep(1, 'done', null, { jiraKey, jiraUrl });

  if (!azure.jiraIdField) return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };

  // ── Step 2: Link back — set Jira key on the Azure work item ─────────────
  onStep(2, 'pending');
  try {
    await updateWorkItem(azure.proxyKey, azure.project, itemId, { [azure.jiraIdField]: jiraKey });
  } catch (err) {
    onStep(2, 'error', err.message);
    throw err;
  }
  onStep(2, 'done');

  return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
}

// ─── FETCH FOR EDIT ───────────────────────────────────────────────────────────
export async function fetchTaskForEdit(project, itemId) {
  const { azure } = project;
  const item = await getWorkItem(azure.proxyKey, azure.project, itemId);
  return {
    title:    item.fields?.['System.Title']       ?? '',
    description: (item.fields?.['System.Description'] ?? '').replace(/<[^>]+>/g, ''),
    jiraKey:  azure.jiraIdField ? (item.fields?.[azure.jiraIdField] ?? null) : null,
  };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────
export async function updateTask(project, itemId, title, description, jiraKey, onStep) {
  const { azure, jira } = project;

  // ── Step 0: Update Azure ─────────────────────────────────────────────────
  onStep(0, 'pending');
  try {
    await updateWorkItem(azure.proxyKey, azure.project, itemId, {
      'System.Title':       title,
      'System.Description': description,
    });
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }
  const itemUrl = `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
  onStep(0, 'done', null, { epicId: itemId, epicUrl: itemUrl });

  if (!jira) return { epicId: itemId, epicUrl: itemUrl, jiraKey: null, jiraUrl: null };

  // Resolve Jira key if not cached
  if (!jiraKey) {
    try {
      const found = await findIssueByEpicId(jira.cloudId, jira.projectKey, jira.clientRequestIdField, itemId);
      jiraKey = found?.key ?? null;
    } catch { /* non-fatal */ }
  }

  if (!jiraKey) {
    onStep(1, 'skipped');
    return { epicId: itemId, epicUrl: itemUrl, jiraKey: null, jiraUrl: null };
  }

  // ── Step 1: Update Jira ──────────────────────────────────────────────────
  onStep(1, 'pending');
  try {
    await updateIssue(jira.cloudId, jiraKey, title, description);
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  const jiraUrl = getJiraUrl(jiraKey);
  onStep(1, 'done', null, { jiraKey, jiraUrl });

  return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
}
