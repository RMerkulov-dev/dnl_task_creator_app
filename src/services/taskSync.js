import { createWorkItem, updateWorkItem, getWorkItem, uploadAttachment } from './azureDevops.js';
import { createIssue, updateIssue, findIssueByEpicId, getJiraUrl, uploadJiraAttachments } from './jira.js';

// ─── Image processing ────────────────────────────────────────────────────────
// Extracts base64 images from HTML, uploads them as Azure DevOps attachments,
// and replaces the src with hosted URLs so both Azure and Jira can display them.

async function processImages(html, proxyKey, project) {
  if (!html) return { html, files: [] };

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const imgs = doc.querySelectorAll('img[src^="data:"]');

  if (!imgs.length) return { html, files: [] };

  const files = [];       // { name, blob } — for Jira attachments
  const relations = [];   // Azure DevOps attachment relations

  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i];
    const dataUrl = img.getAttribute('src');
    const ext = dataUrl.match(/^data:image\/(\w+)/)?.[1] || 'png';
    const fileName = `image-${Date.now()}-${i + 1}.${ext}`;

    try {
      const blob = await (await fetch(dataUrl)).blob();
      const result = await uploadAttachment(proxyKey, project, fileName, blob);

      // Replace base64 with hosted Azure DevOps URL
      img.setAttribute('src', result.url);
      relations.push({ rel: 'AttachedFile', url: result.url, attributes: { comment: '' } });
      files.push({ name: fileName, blob });
    } catch (err) {
      console.warn(`Image upload failed for ${fileName}:`, err.message);
      // Keep the base64 src as fallback
    }
  }

  return { html: doc.body.innerHTML, files, relations };
}

// ─── Step counting ────────────────────────────────────────────────────────────
// Centralised so Dashboard and SyncModal always agree on step count.

export function getCreateStepCount(project) {
  if (!project.jira) return 1;                       // Azure only
  if (!project.azure.jiraIdField) return 2;          // Azure + Jira (no link-back field)
  return 3;                                           // Azure + Jira + link-back
}

export function getEditStepCount(project, jiraKey) {
  if (!project.jira) return 1;                       // Azure only
  if (jiraKey) return 2;                              // Azure + Jira update
  if (!project.azure.jiraIdField) return 2;           // Azure + Jira create (no link-back)
  return 3;                                           // Azure + Jira create + link-back
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
  const { azure } = project;
  // Allow runtime override of Jira project key (e.g. ABS/ABSPO selector)
  const jira = extras.jiraProjectKey && project.jira
    ? { ...project.jira, projectKey: extras.jiraProjectKey }
    : project.jira;

  // ── Step 0: Azure work item ──────────────────────────────────────────────
  onStep(0, 'pending');

  // Upload embedded images as Azure DevOps attachments and replace data URIs
  const { html: processedDesc, files: imageFiles, relations: imageRelations } =
    await processImages(description, azure.proxyKey, azure.project);

  const fields = {
    'System.Title':       title,
    'System.Description': processedDesc,
  };
  if (extras.iterationPath) fields['System.IterationPath'] = extras.iterationPath;
  if (extras.areaPath)      fields['System.AreaPath']      = extras.areaPath;

  const relations = [
    ...(extras.storyUrl
      ? [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: extras.storyUrl, attributes: { comment: '' } }]
      : []),
    ...(imageRelations || []),
  ];

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
      title, processedDesc, itemId, itemUrl, jira.clientRequestIdField
    );
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  const jiraKey = jiraItem.key;
  const jiraUrl = getJiraUrl(jiraKey);

  // Upload images as Jira attachments (non-blocking)
  if (imageFiles.length) {
    try { await uploadJiraAttachments(jira.cloudId, jiraKey, imageFiles); }
    catch (err) { console.warn('Jira attachment upload failed:', err.message); }
  }

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
    description: item.fields?.['System.Description'] ?? '',
    jiraKey:  azure.jiraIdField ? (item.fields?.[azure.jiraIdField] ?? null) : null,
  };
}

// ─── UPDATE ───────────────────────────────────────────────────────────────────
export async function updateTask(project, itemId, title, description, jiraKey, onStep, extras = {}) {
  const { azure } = project;
  // Allow runtime override of Jira project key (e.g. ABS/ABSPO selector)
  const jira = extras.jiraProjectKey && project.jira
    ? { ...project.jira, projectKey: extras.jiraProjectKey }
    : project.jira;

  // ── Step 0: Update Azure ─────────────────────────────────────────────────
  onStep(0, 'pending');

  // Upload embedded images as attachments
  const { html: processedDesc, files: imageFiles } =
    await processImages(description, azure.proxyKey, azure.project);

  try {
    await updateWorkItem(azure.proxyKey, azure.project, itemId, {
      'System.Title':       title,
      'System.Description': processedDesc,
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

  if (jiraKey) {
    // ── Step 1: Update existing Jira issue ────────────────────────────────
    onStep(1, 'pending');
    try {
      await updateIssue(jira.cloudId, jiraKey, title, processedDesc);
    } catch (err) {
      onStep(1, 'error', err.message);
      throw err;
    }

    if (imageFiles.length) {
      try { await uploadJiraAttachments(jira.cloudId, jiraKey, imageFiles); }
      catch (err) { console.warn('Jira attachment upload failed:', err.message); }
    }

    const jiraUrl = getJiraUrl(jiraKey);
    onStep(1, 'done', null, { jiraKey, jiraUrl });
    return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
  }

  // ── Step 1: Create new Jira issue (none exists yet) ───────────────────
  onStep(1, 'pending');
  const numericId = Number(itemId);
  let jiraItem;
  try {
    jiraItem = await createIssue(
      jira.cloudId, jira.projectKey, jira.issueTypeId,
      title, processedDesc, numericId, itemUrl, jira.clientRequestIdField
    );
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  const newJiraKey = jiraItem.key;
  const newJiraUrl = getJiraUrl(newJiraKey);

  if (imageFiles.length) {
    try { await uploadJiraAttachments(jira.cloudId, newJiraKey, imageFiles); }
    catch (err) { console.warn('Jira attachment upload failed:', err.message); }
  }

  onStep(1, 'done', null, { jiraKey: newJiraKey, jiraUrl: newJiraUrl });

  if (!azure.jiraIdField) return { epicId: itemId, epicUrl: itemUrl, jiraKey: newJiraKey, jiraUrl: newJiraUrl };

  // ── Step 2: Link back — set Jira key on the Azure work item ───────────
  onStep(2, 'pending');
  try {
    await updateWorkItem(azure.proxyKey, azure.project, itemId, { [azure.jiraIdField]: newJiraKey });
  } catch (err) {
    onStep(2, 'error', err.message);
    throw err;
  }
  onStep(2, 'done');

  return { epicId: itemId, epicUrl: itemUrl, jiraKey: newJiraKey, jiraUrl: newJiraUrl };
}
