import {
  getIssueFull,
  getProjectIssueTypes,
  getCreateMetaFields,
  createRawIssue,
  addIssueLink,
  deleteIssue,
  getJiraUrl,
  getBoardsForProject,
  getSprintsForBoard,
} from '../../services/jira.js';

// Fields that Jira manages automatically — never include in a create payload
const EXCLUDE_FIELDS = new Set([
  'statuscategorychangedate', 'created', 'updated', 'lastViewed',
  'status', 'resolution', 'resolutiondate', 'workratio',
  'votes', 'watches', 'comment', 'worklog', 'attachment',
  'subtasks', 'issuelinks',
  'progress', 'aggregateprogress',
  'timespent', 'timetracking', 'timeestimate', 'timeoriginalestimate',
  'aggregatetimespent', 'aggregatetimeestimate', 'aggregatetimeoriginalestimate',
  'creator', 'reporter',
]);

function simplifyValue(key, value) {
  if (value === null || value === undefined) return undefined;
  if (key === 'assignee')  return value.accountId ? { accountId: value.accountId } : undefined;
  if (key === 'priority')  return value.id        ? { id: value.id }              : undefined;
  if (key === 'parent')    return value.key       ? { key: value.key }            : undefined;
  if (key === 'components' || key === 'fixVersions' || key === 'versions') {
    const ids = (Array.isArray(value) ? value : []).map(v => ({ id: v.id })).filter(v => v.id);
    return ids.length ? ids : undefined;
  }
  // Sprint field returns [{id, name, state, boardId, ...}] — Jira create expects the numeric sprint ID
  if (Array.isArray(value) && value.length > 0 && typeof value[0]?.id === 'number' && 'state' in value[0]) {
    const active = value.find(s => s.state === 'active') ?? value[value.length - 1];
    return active.id;
  }
  // User picker (single) — { accountId, displayName, ... } → { accountId }
  if (!Array.isArray(value) && typeof value === 'object' && value?.accountId && !value?.key && !value?.id) {
    return { accountId: value.accountId };
  }
  // Multi-user picker — [{accountId, ...}] → [{accountId}]
  if (Array.isArray(value) && value.length > 0 && value[0]?.accountId) {
    return value.map(u => ({ accountId: u.accountId }));
  }
  if (Array.isArray(value) && value.length === 0) return undefined;
  return value;
}

function buildPayload(sourceFields, targetProjectKey, targetIssueTypeId, allowedFieldKeys, includeParent, overrides = {}, summaryOverride) {
  const allowed = new Set(allowedFieldKeys);
  const fields = {
    project:   { key: targetProjectKey },
    issuetype: { id: targetIssueTypeId },
    summary:   summaryOverride != null ? summaryOverride : (sourceFields.summary || ''),
  };

  for (const [key, raw] of Object.entries(sourceFields)) {
    if (EXCLUDE_FIELDS.has(key))                     continue;
    if (key === 'project' || key === 'issuetype' || key === 'summary') continue;
    if (!includeParent && key === 'parent')           continue;
    if (!allowed.has(key))                            continue;
    if (key in overrides)                             continue;

    const value = simplifyValue(key, raw);
    if (value !== undefined) fields[key] = value;
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) fields[key] = value;
    // undefined sentinel = suppress field entirely (used e.g. for "no sprint")
  }

  return fields;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function findSprintField(sourceFields) {
  for (const [fieldId, value] of Object.entries(sourceFields)) {
    if (Array.isArray(value) && value.length > 0 &&
        typeof value[0]?.id === 'number' && 'state' in value[0]) {
      const current = value.find(s => s.state === 'active') ?? value[value.length - 1];
      return { fieldId, current: { id: current.id, name: current.name, state: current.state } };
    }
  }
  return null;
}

export async function loadSprintsForProject(cloudId, projectKey) {
  const boards = await getBoardsForProject(cloudId, projectKey);
  console.log('[sprint] boards for', projectKey, boards.length, boards.map(b => ({ id: b.id, name: b.name, type: b.type })));
  if (!boards.length) return [];
  const seen = new Set();
  const all = [];
  for (const board of boards) {
    try {
      const sprints = await getSprintsForBoard(cloudId, board.id);
      for (const s of sprints) {
        if (!seen.has(s.id)) { seen.add(s.id); all.push(s); }
      }
    } catch (e) {
      console.warn('[sprint] board', board.id, 'failed:', e.message);
    }
  }
  return all;
}

export async function loadUserFields(cloudId, projectKey, issueTypeId, sourceFields) {
  const meta   = await getCreateMetaFields(cloudId, projectKey, issueTypeId);
  const result = [];
  for (const [fieldId, fieldMeta] of Object.entries(meta)) {
    if (fieldId === 'reporter') continue;
    const schema = fieldMeta.schema ?? {};
    if (schema.type !== 'user') continue;
    const raw = sourceFields[fieldId];
    result.push({
      id:      fieldId,
      name:    fieldMeta.name ?? fieldId,
      current: raw?.accountId
        ? { accountId: raw.accountId, displayName: raw.displayName ?? raw.accountId }
        : null,
    });
  }
  return result;
}

export async function loadIssue(cloudId, issueKey) {
  const data   = await getIssueFull(cloudId, issueKey);
  const fields = data.fields ?? {};
  return {
    key:           data.key,
    id:            data.id,
    summary:       fields.summary ?? '',
    projectKey:    fields.project?.key    ?? '',
    projectName:   fields.project?.name   ?? '',
    issueTypeName: fields.issuetype?.name ?? '',
    issueTypeId:   fields.issuetype?.id   ?? '',
    priority:      fields.priority?.name  ?? '',
    assignee:      fields.assignee?.displayName ?? null,
    parent:        fields.parent ? { key: fields.parent.key, summary: fields.parent.fields?.summary ?? '' } : null,
    labels:        fields.labels      ?? [],
    attachments:   (fields.attachment ?? []).map(a => ({ id: a.id, filename: a.filename, mimeType: a.mimeType })),
    raw:           data,
  };
}

// Clone into same project, keeping parent. Steps: 0 schema, 1 create, 2 add-link
export async function cloneInSameProject(cloudId, issue, { summaryOverride, fieldOverrides = {} }, onStep) {
  const { key: sourceKey, projectKey, issueTypeId, raw } = issue;

  onStep(0, 'pending');
  let allowedFieldKeys;
  try {
    const meta = await getCreateMetaFields(cloudId, projectKey, issueTypeId);
    allowedFieldKeys = Object.keys(meta);
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }
  onStep(0, 'done');

  onStep(1, 'pending');
  let newKey, newUrl;
  try {
    const payload = buildPayload(raw.fields, projectKey, issueTypeId, allowedFieldKeys, true, fieldOverrides, summaryOverride);
    const result  = await createRawIssue(cloudId, payload);
    newKey = result.key;
    newUrl = getJiraUrl(newKey);
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  onStep(1, 'done', null, { jiraKey: newKey, jiraUrl: newUrl });

  onStep(2, 'pending');
  try {
    await addIssueLink(cloudId, newKey, sourceKey, 'Clones');
    onStep(2, 'done');
  } catch {
    onStep(2, 'skipped');
  }

  return { newKey, newUrl };
}

// Move to a different project. Steps: 0 target info, 1 create, 2 link, 3 delete source
// parentKey: if provided, set parent to this key (used when moving children after parent move)
export async function moveToProject(cloudId, issue, targetProjectKey, { fieldOverrides = {}, parentKey = null }, onStep) {
  const { key: sourceKey, issueTypeName, raw } = issue;

  onStep(0, 'pending');
  let targetIssueTypeId, allowedFieldKeys;
  try {
    const issueTypes = await getProjectIssueTypes(cloudId, targetProjectKey);
    const matched    = issueTypes.find(t => t.name === issueTypeName) ?? issueTypes[0];
    if (!matched) throw new Error(`No issue types found in project ${targetProjectKey}`);
    targetIssueTypeId = matched.id;
    const meta = await getCreateMetaFields(cloudId, targetProjectKey, targetIssueTypeId);
    allowedFieldKeys = Object.keys(meta);
  } catch (err) {
    onStep(0, 'error', err.message);
    throw err;
  }
  onStep(0, 'done');

  onStep(1, 'pending');
  let newKey, newUrl;
  try {
    // Strip all cross-project fields: parent refs, project-specific IDs
    const moveOverrides = {
      parent:            parentKey ? { key: parentKey } : undefined,
      customfield_10014: undefined, // Epic Link — older Jira Cloud
      customfield_10018: undefined, // Parent Link — newer hierarchy field
      components:        undefined, // component IDs are project-specific
      fixVersions:       undefined,
      versions:          undefined,
      ...fieldOverrides,
    };
    const payload = buildPayload(raw.fields, targetProjectKey, targetIssueTypeId, allowedFieldKeys, false, moveOverrides);
    const result  = await createRawIssue(cloudId, payload);
    newKey = result.key;
    newUrl = getJiraUrl(newKey);
  } catch (err) {
    onStep(1, 'error', err.message);
    throw err;
  }
  onStep(1, 'done', null, { jiraKey: newKey, jiraUrl: newUrl });

  onStep(2, 'pending');
  try {
    await addIssueLink(cloudId, newKey, sourceKey, 'Clones');
    onStep(2, 'done');
  } catch {
    onStep(2, 'skipped');
  }

  onStep(3, 'pending');
  let sourceDeleted = false;
  try {
    await deleteIssue(cloudId, sourceKey);
    sourceDeleted = true;
    onStep(3, 'done');
  } catch (err) {
    onStep(3, 'error', err.message);
  }

  return { newKey, newUrl, sourceDeleted };
}
