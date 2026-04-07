import { createWorkItem, updateWorkItem, getWorkItem, getEpicUrl } from './azureDevops.js';
import { createIssue, updateIssue, findIssueByEpicId, getJiraUrl } from './jira.js';

const AZURE_ORG = import.meta.env.VITE_AZURE_DEVOPS_ORG || 'your-org';

// ─── CREATE ──────────────────────────────────────────────────────────────────
// Follows the HT Tasks Creator skill logic:
//   1. Create Azure DevOps Epic
//   2. Create Jira Request (with Epic ID + URL in description)
//   3. Link back: update Epic with Jira issue key

export async function createTask(project, title, description, onStep) {
  const { azure, jira } = project;

  // Step 1 — Azure DevOps Epic
  onStep(0, 'pending');
  let epicItem;
  try {
    epicItem = await createWorkItem(azure.project, azure.workItemType, {
      'System.Title': title,
      'System.Description': description,
    });
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }
  const epicId = epicItem.id;
  const epicUrl = epicItem._links?.html?.href ?? getEpicUrl(AZURE_ORG, azure.project, epicId);
  onStep(0, 'done', null, { epicId, epicUrl });

  // Step 2 — Jira Request
  onStep(1, 'pending');
  let jiraItem;
  try {
    jiraItem = await createIssue(
      jira.cloudId,
      jira.projectKey,
      jira.issueTypeId,
      title,
      description,
      epicId,
      epicUrl,
      jira.clientRequestIdField
    );
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  const jiraKey = jiraItem.key;
  const jiraUrl = getJiraUrl(jiraKey);
  onStep(1, 'done', null, { jiraKey, jiraUrl });

  // Step 3 — Link back
  onStep(2, 'pending');
  try {
    await updateWorkItem(azure.project, epicId, {
      [azure.jiraIdField]: jiraKey,
    });
  } catch (err) {
    onStep(2, 'error', err.message);
    throw err;
  }
  onStep(2, 'done');

  return { epicId, epicUrl, jiraKey, jiraUrl };
}

// ─── EDIT ────────────────────────────────────────────────────────────────────
// Fetch existing task by Azure DevOps Epic ID, then update both systems.

export async function fetchTaskForEdit(project, epicId) {
  const { azure, jira } = project;
  const item = await getWorkItem(azure.project, epicId);
  const title = item.fields?.['System.Title'] ?? '';
  const descRaw = item.fields?.['System.Description'] ?? '';
  const jiraKey = item.fields?.[azure.jiraIdField] ?? null;

  // Strip HTML from Azure DevOps description (it stores HTML)
  const description = descRaw.replace(/<[^>]+>/g, '');

  return { title, description, jiraKey };
}

export async function updateTask(project, epicId, title, description, jiraKey, onStep) {
  const { azure, jira } = project;

  // Resolve Jira key if not already known
  if (!jiraKey) {
    try {
      const issue = await findIssueByEpicId(
        jira.cloudId,
        jira.projectKey,
        jira.clientRequestIdField,
        epicId
      );
      jiraKey = issue?.key ?? null;
    } catch {
      // Non-fatal — we'll still update Azure
    }
  }

  // Step 1 — Update Azure DevOps
  onStep(0, 'pending');
  try {
    await updateWorkItem(azure.project, epicId, {
      'System.Title': title,
      'System.Description': description,
    });
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }
  const epicUrl = getEpicUrl(AZURE_ORG, azure.project, epicId);
  onStep(0, 'done', null, { epicId, epicUrl });

  // Step 2 — Update Jira (if key exists)
  if (jiraKey) {
    onStep(1, 'pending');
    try {
      await updateIssue(jira.cloudId, jiraKey, title, description);
    } catch (err) {
      onStep(1, 'error', err.message);
      throw err;
    }
    const jiraUrl = getJiraUrl(jiraKey);
    onStep(1, 'done', null, { jiraKey, jiraUrl });
    return { epicId, epicUrl, jiraKey, jiraUrl };
  }

  // No Jira key — skip step 2 gracefully
  onStep(1, 'skipped');
  return { epicId, epicUrl, jiraKey: null, jiraUrl: null };
}
