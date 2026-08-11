import { createWorkItem, updateWorkItem, getWorkItem, uploadAttachment } from './azureDevops.js';
import { createIssue, updateIssue, findIssueByEpicId, getJiraUrl, uploadJiraAttachments, embedAttachmentImages, setJiraAzureId } from './jira.js';

// ─── Create targets (Azure / Jira / both) ─────────────────────────────────────
// The create forms expose a 3-way toggle — 'both' (the default on every load),
// 'azure', 'jira'. This is the ONE place that turns a choice into what actually
// happens, because the choice is not free: a project without Jira can only ever
// create in Azure, so 'jira' there must degrade instead of creating nothing.
export function resolveTargets(project, target = 'both') {
  const hasJira = !!project?.jira;
  if (target === 'azure')           return { azure: true,  jira: false };
  if (target === 'jira' && hasJira) return { azure: false, jira: true  };
  return { azure: true, jira: hasJira };
}

// ─── Image processing ────────────────────────────────────────────────────────
// Extracts base64 images from HTML, uploads them as Azure DevOps attachments,
// and replaces the src with hosted URLs so both Azure and Jira can display them.
// `toAzure: false` (Jira-only creation) skips the Azure upload but still names
// and collects the blobs — the ADF converter matches them by
// `data-jira-filename` against the Jira attachments, never by src.

async function processImages(html, proxyKey, project, toAzure = true) {
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
      // Tag the img so the Jira ADF converter can later map it to the matching
      // Jira attachment (uploaded under the same fileName) and embed it inline.
      img.setAttribute('data-jira-filename', fileName);
      if (toAzure) {
        const result = await uploadAttachment(proxyKey, project, fileName, blob);
        // Replace base64 with hosted Azure DevOps URL
        img.setAttribute('src', result.url);
        relations.push({ rel: 'AttachedFile', url: result.url, attributes: { comment: '' } });
      }
      files.push({ name: fileName, blob });
    } catch (err) {
      console.warn(`Image upload failed for ${fileName}:`, err.message);
      // Keep the base64 src as fallback
    }
  }

  return { html: doc.body.innerHTML, files, relations };
}

// ─── User-attached files (the editor's "Attach file" button) ──────────────────
// Uploads each file to Azure (returns an AttachedFile relation) and returns the
// blobs so they can also be pushed to Jira as attachments. Unlike images these
// are not embedded inline — they live in both systems' attachment panels.
// `toAzure: false` (Jira-only creation) hands the blobs straight to Jira.
async function uploadExtraAttachments(attachments, azure, toAzure = true) {
  const relations = [];
  const jiraFiles = [];
  for (const att of attachments || []) {
    const blob = att.file ?? att.blob;
    if (!blob) continue;
    const name = att.name || blob.name || `attachment-${Date.now()}`;
    if (!toAzure) { jiraFiles.push({ name, blob }); continue; }
    try {
      const result = await uploadAttachment(azure.proxyKey, azure.project, name, blob);
      relations.push({ rel: 'AttachedFile', url: result.url, attributes: { comment: '' } });
      jiraFiles.push({ name, blob });
    } catch (err) {
      console.warn(`Attachment upload failed for ${name}:`, err.message);
    }
  }
  return { relations, jiraFiles };
}

// Pushes image blobs + user-attached files to a Jira issue, then re-writes the
// description so only the images render inline (files stay as attachments).
// `link` appends the Azure link block (create flow) or is null (edit flow).
// Non-blocking: never throws — a Jira attachment hiccup shouldn't fail the sync.
async function pushJiraAttachments(jira, jiraKey, processedDesc, imageFiles, extraJiraFiles, link) {
  const allFiles = [...(imageFiles || []), ...(extraJiraFiles || [])];
  if (!allFiles.length) return;
  try {
    const uploaded   = await uploadJiraAttachments(jira.cloudId, jiraKey, allFiles);
    const imageNames = new Set((imageFiles || []).map(f => f.name));
    const imageUploads = uploaded.filter(u => imageNames.has(u.filename));
    await embedAttachmentImages(jira.cloudId, jiraKey, processedDesc, imageUploads, link);
  } catch (err) {
    console.warn('Jira attachment/embed failed:', err.message);
  }
}

// ─── Azure-id-in-title (feature `azureIdInTitle`, e.g. ABS) ───────────────────
// After the Azure work item is created, its #id is inserted into the task title
// right after the standard prefix — "ABS. QMP. Fix X" → "ABS. QMP. 1125. Fix X"
// — and that numbered title is what the Jira issue is created with.

// Known title prefixes, longest first (mirrors the Dashboard/TaskCreateModal
// prefix logic — keep in sync when a new prefix is added there).
const TITLE_PREFIXES = [
  'ABS. [WS]. Customer Service.', 'ABS. QMP.', 'ABS. MAM.', 'ABS. CM.',
  'ABSPO.', 'ABS.', 'HT.', 'NSMGM.', 'NSMGCM.', 'NSMG.',
];

export function insertIdAfterTitlePrefix(title, id) {
  const t = String(title || '').trim();
  let prefix = '';
  for (const p of TITLE_PREFIXES) {
    if (t.startsWith(p)) { prefix = p; break; }   // list is longest-first
  }
  if (prefix) {
    let rest = t.slice(prefix.length).trimStart();
    // The known prefix may be followed by extra short prefix tokens the user
    // typed ("ABS. PO. Test Name" — "PO." belongs to the prefix, not the name).
    let m;
    while ((m = rest.match(/^([A-Z][A-Za-z0-9[\]]{0,9}\.)\s+(\S[\s\S]*)$/))) {
      prefix = `${prefix} ${m[1]}`;
      rest = m[2];
    }
    return `${prefix} ${id}. ${rest}`;
  }
  // Unknown prefix: treat a leading run of short dot-terminated segments as the
  // prefix ("XX. YY. Test Name" → "XX. YY. <id>. Test Name").
  const m = t.match(/^((?:[^.\s][^.]{0,29}\.\s+)+)(\S[\s\S]*)$/);
  if (m) return `${m[1].trim()} ${id}. ${m[2]}`;
  // No prefix at all — the id leads.
  return `${id}. ${t}`;
}

// ─── Step counting ────────────────────────────────────────────────────────────
// Centralised so Dashboard and SyncModal always agree on step count.

export function getCreateStepCount(project, target = 'both') {
  const t = resolveTargets(project, target);
  if (!t.azure) return 1;                            // Jira only
  const titleStep = project.features?.azureIdInTitle ? 1 : 0;
  if (!t.jira) return 1 + titleStep;                 // Azure only
  if (!project.azure.jiraIdField) return 2 + titleStep; // Azure + Jira (no link-back field)
  return 3 + titleStep;                               // Azure + Jira + link-back
}

export function getEditStepCount(project, jiraKey) {
  if (!project.jira) return 1;                       // Azure only
  if (jiraKey) return 2;                              // Azure + Jira update
  if (!project.azure.jiraIdField) return 2;           // Azure + Jira create (no link-back)
  return 3;                                           // Azure + Jira create + link-back
}

// ─── Email notification ───────────────────────────────────────────────────────
// Fire-and-forget: a failed notification must never break task creation.
// Recipients are resolved server-side per project (api/taskNotify.js).
function notifyTaskCreated(project, title, result) {
  fetch('/api/notify/task-created', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId:   project.id,
      projectName: project.label,
      title,
      epicId:  result.epicId,
      epicUrl: result.epicUrl,
      jiraKey: result.jiraKey,
      jiraUrl: result.jiraUrl,
    }),
  }).then(async res => {
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.warn('[notifyTaskCreated]', body.error || `HTTP ${res.status}`);
    }
  }).catch(err => console.warn('[notifyTaskCreated]', err.message));
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
/**
 * @param {object} project  - from projects.js
 * @param {string} title
 * @param {string} description
 * @param {object} extras   - { iterationPath?, storyUrl?, areaPath?, target? }
 *                            target: 'both' (default) | 'azure' | 'jira'
 * @param {function} onStep - (stepIndex, status, errorMsg, data) => void
 */
export async function createTask(project, title, description, extras = {}, onStep) {
  const { azure } = project;
  // Allow runtime override of Jira project key (e.g. ABS/ABSPO selector)
  const jira = extras.jiraProjectKey && project.jira
    ? { ...project.jira, projectKey: extras.jiraProjectKey }
    : project.jira;
  // Which systems this run writes to (see resolveTargets).
  const targets = resolveTargets(project, extras.target);
  // Resume support: when a previous run already created the Azure item (and
  // possibly the Jira issue) but a later step failed, the caller passes the
  // ids back so a retry never creates duplicates.
  const resume = extras.resume || {};

  // Steps are numbered dynamically: a skipped target drops its steps entirely
  // and the azureIdInTitle feature inserts an extra "number the title" step
  // between the Azure create and the Jira create — hence the running counter
  // instead of fixed indices (getCreateStepCount and SyncModal's buildStepDefs
  // mirror this).
  let stepIdx = -1;

  // Upload embedded images as Azure DevOps attachments and replace data URIs
  const { html: processedDesc, files: imageFiles, relations: imageRelations } =
    await processImages(description, azure.proxyKey, azure.project, targets.azure);
  // Upload user-attached files (any type) as Azure + Jira attachments.
  const { relations: attachRelations, jiraFiles: extraJiraFiles } =
    await uploadExtraAttachments(extras.attachments, azure, targets.azure);

  let itemId = null, itemUrl = null;
  let finalTitle = title;

  if (targets.azure) {
    // ── Step: Azure work item ──────────────────────────────────────────────
    stepIdx++;
    onStep(stepIdx, 'pending');

    if (resume.epicId) {
      itemId  = resume.epicId;
      itemUrl = resume.epicUrl ?? `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
    } else {
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
        ...attachRelations,
      ];

      let item;
      try {
        item = await createWorkItem(azure.proxyKey, azure.project, azure.workItemType, fields, relations);
      } catch (err) {
        onStep(stepIdx, 'error', err.message);
        throw err;
      }
      itemId  = item.id;
      itemUrl = item._links?.html?.href ?? `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
    }
    onStep(stepIdx, 'done', null, { epicId: itemId, epicUrl: itemUrl });

    // ── Step (azureIdInTitle only): insert the Azure #id into the title ────
    // Recomputed from the original title, so a resumed retry never double-inserts.
    if (project.features?.azureIdInTitle) {
      stepIdx++;
      onStep(stepIdx, 'pending');
      finalTitle = insertIdAfterTitlePrefix(title, itemId);
      try {
        await updateWorkItem(azure.proxyKey, azure.project, itemId, { 'System.Title': finalTitle });
      } catch (err) {
        onStep(stepIdx, 'error', err.message);
        throw err;
      }
      onStep(stepIdx, 'done');
    }
  }

  // No Jira configured for this project, or the user chose "Azure only"
  if (!targets.jira) {
    const result = { epicId: itemId, epicUrl: itemUrl, jiraKey: null, jiraUrl: null };
    notifyTaskCreated(project, finalTitle, result);
    return result;
  }

  // ── Step: Jira issue (created with the numbered title) ───────────────────
  // itemId/itemUrl are null on a Jira-only run — createIssue then skips both
  // the Azure-id field and the Azure link block.
  stepIdx++;
  onStep(stepIdx, 'pending');
  let jiraKey;
  if (resume.jiraKey) {
    jiraKey = resume.jiraKey;
  } else {
    let jiraItem;
    try {
      jiraItem = await createIssue(
        jira.cloudId, jira.projectKey, jira.issueTypeId,
        finalTitle, processedDesc, itemId, itemUrl, jira.clientRequestIdField, extras.componentId
      );
    } catch (err) {
      onStep(stepIdx, 'error', err.message);
      throw err;
    }
    jiraKey = jiraItem.key;
  }
  const jiraUrl = getJiraUrl(jiraKey);

  if (!resume.jiraKey) {
    await pushJiraAttachments(
      jira, jiraKey, processedDesc, imageFiles, extraJiraFiles,
      itemId ? { epicId: itemId, epicUrl: itemUrl } : null
    );
  }

  onStep(stepIdx, 'done', null, { jiraKey, jiraUrl });

  if (!targets.azure || !azure.jiraIdField) {
    const result = { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
    notifyTaskCreated(project, finalTitle, result);
    return result;
  }

  // ── Step: Link back — set Jira key on the Azure work item ────────────────
  stepIdx++;
  onStep(stepIdx, 'pending');
  try {
    await updateWorkItem(azure.proxyKey, azure.project, itemId, { [azure.jiraIdField]: jiraKey });
  } catch (err) {
    onStep(stepIdx, 'error', err.message);
    throw err;
  }
  onStep(stepIdx, 'done');

  const result = { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
  notifyTaskCreated(project, finalTitle, result);
  return result;
}

// ─── FETCH FOR EDIT ───────────────────────────────────────────────────────────
export async function fetchTaskForEdit(project, itemId) {
  const { azure } = project;
  const item = await getWorkItem(azure.proxyKey, azure.project, itemId);
  const parentRel = item.relations?.find(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  return {
    title:         item.fields?.['System.Title']          ?? '',
    description:   item.fields?.['System.Description']    ?? '',
    iterationPath: item.fields?.['System.IterationPath']  ?? '',
    areaPath:      item.fields?.['System.AreaPath']       ?? '',
    parentUrl:     parentRel?.url                         ?? null,
    parentId:      parentRel?.url ? Number(parentRel.url.split('/').pop()) : null,
    jiraKey:       azure.jiraIdField ? (item.fields?.[azure.jiraIdField] ?? null) : null,
  };
}

// ─── CREATE AZURE FROM JIRA ───────────────────────────────────────────────────
/**
 * When a Jira issue exists but has no Azure counterpart:
 * create the Azure work item and link both systems.
 * Steps: 0=Create Azure, 1=Update Jira with Azure ID
 */
export async function createAzureFromJira(project, jiraKey, title, description, extras = {}, onStep) {
  const { azure, jira } = project;
  const jiraUrl = getJiraUrl(jiraKey);
  // Resume support — see createTask(): skip the Azure create on retry when a
  // previous attempt already made the work item.
  const resume = extras.resume || {};

  // ── Step 0: Create Azure work item ──────────────────────────────────────
  onStep(0, 'pending');

  const { html: processedDesc, files: imageFiles, relations: imageRelations } =
    await processImages(description, azure.proxyKey, azure.project);
  const { relations: attachRelations, jiraFiles: extraJiraFiles } =
    await uploadExtraAttachments(extras.attachments, azure);

  let itemId, itemUrl;
  if (resume.epicId) {
    itemId  = resume.epicId;
    itemUrl = resume.epicUrl ?? `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
  } else {
    const fields = {
      'System.Title':       title,
      'System.Description': processedDesc,
      ...(azure.jiraIdField          ? { [azure.jiraIdField]: jiraKey }          : {}),
      ...(extras.iterationPath       ? { 'System.IterationPath': extras.iterationPath } : {}),
      ...(extras.areaPath            ? { 'System.AreaPath':      extras.areaPath }      : {}),
    };

    const relations = [
      ...(extras.storyUrl
        ? [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: extras.storyUrl, attributes: { comment: '' } }]
        : []),
      ...(imageRelations || []),
      ...attachRelations,
    ];

    let item;
    try {
      item = await createWorkItem(azure.proxyKey, azure.project, azure.workItemType, fields, relations);
    } catch (err) {
      onStep(0, 'error', err.message);
      throw err;
    }
    itemId  = item.id;
    itemUrl = item._links?.html?.href ?? `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
  }
  onStep(0, 'done', null, { epicId: itemId, epicUrl: itemUrl });

  if (!jira) return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };

  // ── Step 1: Update Jira with Azure ID ───────────────────────────────────
  onStep(1, 'pending');
  try {
    await setJiraAzureId(jira.cloudId, jiraKey, jira.clientRequestIdField, itemId);
    await pushJiraAttachments(jira, jiraKey, processedDesc, imageFiles, extraJiraFiles, null);
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  onStep(1, 'done', null, { jiraKey, jiraUrl });

  return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
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
  const { relations: attachRelations, jiraFiles: extraJiraFiles } =
    await uploadExtraAttachments(extras.attachments, azure);

  try {
    // Newly attached files are linked in the same PATCH as the field updates.
    await updateWorkItem(azure.proxyKey, azure.project, itemId, {
      'System.Title':       title,
      'System.Description': processedDesc,
    }, attachRelations);
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }
  const itemUrl = `https://dev.azure.com/${azure.project}/_workitems/edit/${itemId}`;
  onStep(0, 'done', null, { epicId: itemId, epicUrl: itemUrl });

  if (!jira) return { epicId: itemId, epicUrl: itemUrl, jiraKey: null, jiraUrl: null };

  // Resolve Jira key if not cached — track whether we had to look it up so we
  // can re-link it on the Azure side (jiraIdField was empty).
  const hadJiraKeyInitially = !!jiraKey;
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

    await pushJiraAttachments(jira, jiraKey, processedDesc, imageFiles, extraJiraFiles, null);

    const jiraUrl = getJiraUrl(jiraKey);
    onStep(1, 'done', null, { jiraKey, jiraUrl });

    // ── Step 2: Link back if the Azure side wasn't already linked ─────────
    if (!hadJiraKeyInitially && azure.jiraIdField) {
      onStep(2, 'pending');
      try {
        await updateWorkItem(azure.proxyKey, azure.project, itemId, { [azure.jiraIdField]: jiraKey });
      } catch (err) {
        onStep(2, 'error', err.message);
        throw err;
      }
      onStep(2, 'done');
    }
    return { epicId: itemId, epicUrl: itemUrl, jiraKey, jiraUrl };
  }

  // ── Step 1: Create new Jira issue (none exists yet) ───────────────────
  onStep(1, 'pending');
  const numericId = Number(itemId);
  let jiraItem;
  try {
    jiraItem = await createIssue(
      jira.cloudId, jira.projectKey, jira.issueTypeId,
      title, processedDesc, numericId, itemUrl, jira.clientRequestIdField, extras.componentId
    );
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  const newJiraKey = jiraItem.key;
  const newJiraUrl = getJiraUrl(newJiraKey);

  await pushJiraAttachments(jira, newJiraKey, processedDesc, imageFiles, extraJiraFiles, { epicId: numericId, epicUrl: itemUrl });

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
