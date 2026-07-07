import {
  getIssueFull,
  getProjectIssueTypes,
  getCreateMetaFields,
  getEditMetaFields,
  editIssueFieldsRaw,
  createRawIssue,
  addIssueLink,
  deleteIssue,
  bulkMoveIssues,
  getBulkTaskStatus,
  getTransitions,
  transitionIssue,
  getWorklogs,
  addWorklog,
  getJiraUrl,
  getBoardsForProject,
  getSprintsForBoard,
  getProjectStatuses,
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

// Cross-project hierarchy links reference issues in the source project and are
// invalid in the target — handled separately (parent is re-set per moved tree).
const HIERARCHY_FIELDS = new Set([
  'parent',
  'customfield_10014', // Epic Link — older Jira Cloud
  'customfield_10018', // Parent Link — newer hierarchy field
]);

// ADF media nodes carry attachment IDs from the source issue, which are
// invalid on the new issue. Jira rejects the create with
// "We don't recognise the format of a file you added or the data in it."
const ADF_MEDIA_TYPES = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline']);
function stripAdfMedia(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(stripAdfMedia).filter(n => n != null);
  if (ADF_MEDIA_TYPES.has(node.type)) return null;
  if (Array.isArray(node.content)) {
    return { ...node, content: node.content.map(stripAdfMedia).filter(n => n != null) };
  }
  return node;
}

function simplifyValue(key, value) {
  if (value === null || value === undefined) return undefined;
  if (key === 'assignee')  return value.accountId ? { accountId: value.accountId } : undefined;
  if (key === 'priority')  return value.id        ? { id: value.id }              : undefined;
  if (key === 'parent')    return value.key       ? { key: value.key }            : undefined;
  if (key === 'components' || key === 'fixVersions' || key === 'versions') {
    const ids = (Array.isArray(value) ? value : []).map(v => ({ id: v.id })).filter(v => v.id);
    return ids.length ? ids : undefined;
  }
  // Rich-text fields (description and ADF custom fields) — drop embedded
  // attachment references that point to the source issue.
  if (typeof value === 'object' && !Array.isArray(value) && value.type === 'doc' && Array.isArray(value.content)) {
    return stripAdfMedia(value);
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

// ─── Field recovery (post-create edit pass) ─────────────────────────────────────
// A cross-project create can only set fields on the target's *create* screen.
// Many filled fields (assignee, custom fields, components, versions, …) live on
// the edit screen instead and would otherwise be lost. After the issue exists we
// read its editmeta and set every remaining source field that is editable,
// remapping option/component/version values by name (their IDs differ per
// project). Fields Jira still rejects are dropped one-by-one and the edit is
// retried, so a single incompatible field never blocks the rest.

// Match source value(s) against an editmeta field's allowedValues by name/value
// and return the target-project IDs (option/component/version/select fields).
function matchAllowedValues(raw, allowedValues) {
  const index = new Map();
  for (const a of allowedValues) {
    if (a.value != null) index.set(String(a.value).toLowerCase(), a.id);
    if (a.name  != null) index.set(String(a.name).toLowerCase(),  a.id);
  }
  const resolve = (v) => {
    const k = (v && typeof v === 'object') ? (v.value ?? v.name ?? v.id) : v;
    if (k == null) return undefined;
    const id = index.get(String(k).toLowerCase());
    return id != null ? { id } : undefined;
  };
  if (Array.isArray(raw)) {
    const out = raw.map(resolve).filter(v => v !== undefined);
    return out.length ? out : undefined;
  }
  return resolve(raw);
}

// Normalize a source value for the target field using its editmeta schema.
function normalizeForMeta(key, raw, meta) {
  if (raw === null || raw === undefined) return undefined;
  const schema = meta?.schema ?? {};

  // User pickers — carry the account, never the display name / cached profile.
  if (schema.type === 'user') {
    return raw.accountId ? { accountId: raw.accountId } : undefined;
  }
  if (schema.type === 'array' && schema.items === 'user') {
    const users = (Array.isArray(raw) ? raw : [])
      .map(u => (u?.accountId ? { accountId: u.accountId } : null))
      .filter(Boolean);
    return users.length ? users : undefined;
  }

  // Option / component / version / select fields — remap IDs by name.
  if (Array.isArray(meta?.allowedValues) && meta.allowedValues.length) {
    return matchAllowedValues(raw, meta.allowedValues);
  }

  return simplifyValue(key, raw);
}

// Set every filled source field that is editable on the freshly created issue
// but was not already set during create. Best-effort: never throws.
async function recoverFields(cloudId, newKey, sourceFields, alreadySetKeys) {
  let editMeta;
  try {
    editMeta = await getEditMetaFields(cloudId, newKey);
  } catch {
    return; // editmeta unavailable — nothing we can safely recover
  }

  const skip = new Set([...EXCLUDE_FIELDS, ...HIERARCHY_FIELDS, ...alreadySetKeys]);
  skip.add('project'); skip.add('issuetype'); skip.add('summary');

  let fields = {};
  for (const [key, raw] of Object.entries(sourceFields)) {
    if (skip.has(key)) continue;
    const meta = editMeta[key];
    if (!meta) continue; // not editable on the target issue
    const value = normalizeForMeta(key, raw, meta);
    if (value !== undefined) fields[key] = value;
  }
  if (!Object.keys(fields).length) return;

  // PUT, then drop any field Jira rejects and retry until it goes through.
  for (let attempt = 0; attempt < 5 && Object.keys(fields).length; attempt++) {
    const res = await editIssueFieldsRaw(cloudId, newKey, fields);
    if (res.ok) return;
    const bad = Object.keys(res.errors ?? {});
    let removed = false;
    for (const b of bad) {
      if (b in fields) { delete fields[b]; removed = true; }
    }
    if (!removed) return; // error not tied to a specific field — give up quietly
  }
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

// Estimate fields exposed as editable inputs on the clone form.
const ESTIMATE_FIELD_NAMES = new Set(['developer estimate', 'qa estimate']);

export async function loadCloneFields(cloudId, projectKey, issueTypeId, sourceFields) {
  const meta           = await getCreateMetaFields(cloudId, projectKey, issueTypeId);
  const userFields     = [];
  const estimateFields = [];
  for (const [fieldId, fieldMeta] of Object.entries(meta)) {
    const schema = fieldMeta.schema ?? {};
    const name   = fieldMeta.name ?? fieldId;
    if (schema.type === 'user') {
      if (fieldId === 'reporter') continue;
      const raw = sourceFields[fieldId];
      userFields.push({
        id:      fieldId,
        name,
        current: raw?.accountId
          ? { accountId: raw.accountId, displayName: raw.displayName ?? raw.accountId }
          : null,
      });
    } else if (schema.type === 'number' && ESTIMATE_FIELD_NAMES.has(name.toLowerCase())) {
      const raw = sourceFields[fieldId];
      estimateFields.push({ id: fieldId, name, current: typeof raw === 'number' ? raw : null });
    }
  }
  return { userFields, estimateFields };
}

// Statuses offered for the clone. Primary source is the project's per-issue-type
// status list; if the token lacks the read:issue-status:jira scope for it, fall
// back to the statuses reachable via the source issue's transitions.
export async function loadStatusesForIssueType(cloudId, projectKey, issueTypeId, sourceIssueKey) {
  try {
    const all   = await getProjectStatuses(cloudId, projectKey);
    const entry = all.find(t => String(t.id) === String(issueTypeId));
    const statuses = entry?.statuses ?? [];
    if (statuses.length) return statuses.map(s => ({ id: s.id, name: s.name }));
  } catch { /* fall through to transitions */ }
  try {
    const transitions = await getTransitions(cloudId, sourceIssueKey);
    const seen = new Map();
    for (const t of transitions) {
      if (t.to?.name && !seen.has(t.to.name)) seen.set(t.to.name, { id: t.to.id, name: t.to.name });
    }
    return [...seen.values()];
  } catch {
    return [];
  }
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
export async function cloneInSameProject(cloudId, issue, { summaryOverride, fieldOverrides = {}, targetStatusName = null }, onStep) {
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
    // Recover any filled fields that weren't on the create screen. Overridden
    // fields are skipped too — the user's explicit choice (including a cleared
    // value) must not be undone by re-copying the source value.
    try { await recoverFields(cloudId, newKey, raw.fields, [...Object.keys(payload), ...Object.keys(fieldOverrides)]); } catch { /* best-effort */ }
    // Walk the workflow to the requested status (a new issue starts in the
    // workflow's initial status).
    if (targetStatusName) {
      try { await replicateStatus(cloudId, newKey, targetStatusName); } catch { /* best-effort */ }
    }
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

// ─── Cross-project move (native Bulk Move API) ──────────────────────────────────
// Jira's public REST API has no single-issue cross-project move, but the Bulk
// operations API does a real native move that preserves comments, attachments,
// worklogs, history and status — none of the clone+delete data loss. The op is
// asynchronous: we submit a batch and poll the task to completion.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Read a tree node's metadata regardless of whether it's a loaded root
// ({ source }) or a descendant ({ raw }).
function nodeMeta(node) {
  const fields = node.source?.raw?.fields ?? node.raw?.fields ?? {};
  return {
    key:           node.key,
    id:            node.source?.id ?? node.raw?.id ?? node.source?.raw?.id ?? null,
    issueTypeName: node.source?.issueTypeName ?? fields.issuetype?.name ?? '',
    isSubtask:     !!fields.issuetype?.subtask,
  };
}

// Flatten the move forest depth-first, tagging each node with its tree parent.
function flattenForest(roots) {
  const out = [];
  const walk = (node, parent) => {
    const m = nodeMeta(node);
    m.parentId  = parent?.id  ?? null;
    m.parentKey = parent?.key ?? null;
    m.parentInSet = !!parent;
    out.push(m);
    for (const child of node.children ?? []) walk(child, m);
  };
  for (const r of roots) walk(r, null);
  return out;
}

// Move a forest of issues (roots + descendants) to another project in one native
// bulk operation. `roots` are move-tree nodes. onProgress(percent, statusText)
// reports poll progress. Resolves to a Map<sourceKey, { newKey, newUrl }>.
// Issue IDs are stable across a move, so we resolve new keys by ID afterwards.
export async function bulkMoveForest(cloudId, roots, targetProjectKey, onProgress) {
  const flat = flattenForest(roots);
  if (!flat.length) return new Map();

  // Resolve target issue types by name (fall back to first standard type).
  const types = await getProjectIssueTypes(cloudId, targetProjectKey);
  if (!types.length) throw new Error(`No issue types found in project ${targetProjectKey}`);
  const byName = new Map(types.map(t => [t.name.toLowerCase(), t]));
  const firstStandard = types.find(t => !t.subtask) ?? types[0];
  const targetType = (name) => byName.get((name || '').toLowerCase()) ?? firstStandard;

  // Build targetToSourcesMapping. Subtasks whose parent is also in the move set
  // ride along automatically (inferSubtaskTypeDefault), so we don't list them —
  // listing every standard issue is enough and avoids cross-project parent refs.
  const mapping = {};
  const addToGroup = (key, idOrKey) => {
    if (!mapping[key]) {
      mapping[key] = {
        inferClassificationDefaults: true,
        inferFieldDefaults:          true,
        inferStatusDefaults:         true,
        inferSubtaskTypeDefault:     true,
        issueIdsOrKeys:              [],
      };
    }
    mapping[key].issueIdsOrKeys.push(String(idOrKey));
  };

  for (const m of flat) {
    if (m.isSubtask && m.parentInSet) continue; // moves with its parent
    const tt = targetType(m.issueTypeName);
    const ref = m.id ?? m.key;
    if (tt.subtask) {
      const parentRef = m.parentId ?? m.parentKey;
      if (!parentRef) continue; // a subtask with no parent can't be placed — skip
      addToGroup(`${targetProjectKey},${tt.id},${parentRef}`, ref);
    } else {
      addToGroup(`${targetProjectKey},${tt.id}`, ref);
    }
  }

  if (!Object.keys(mapping).length) throw new Error('Nothing to move after grouping issues.');

  // Submit the batch. A failure *here* means nothing has moved yet (endpoint
  // unavailable, no permission, bad mapping) — flag it so the caller can safely
  // fall back to clone+delete. A failure *after* submission is not flagged,
  // because the move may be partially applied and retrying would duplicate.
  let taskId;
  try {
    ({ taskId } = await bulkMoveIssues(cloudId, mapping, false));
  } catch (err) {
    err.bulkUnavailable = true;
    throw err;
  }
  if (!taskId) {
    const err = new Error('Bulk move did not return a task id.');
    err.bulkUnavailable = true;
    throw err;
  }

  // Poll until the task settles.
  const DONE = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DEAD']);
  let last;
  for (let i = 0; i < 600; i++) { // ~15 min ceiling at 1.5s intervals
    await sleep(1500);
    last = await getBulkTaskStatus(cloudId, taskId);
    onProgress?.(last.progressPercent ?? 0, last.status);
    if (DONE.has(last.status)) break;
  }
  if (!last || last.status !== 'COMPLETE') {
    const bad = last?.invalidOrInaccessibleIssueCount;
    throw new Error(
      `Bulk move ${last?.status ?? 'timed out'}` +
      (bad ? ` — ${bad} issue(s) invalid or inaccessible` : '')
    );
  }

  // Resolve the new key for every moved issue by its (stable) ID.
  const results = new Map();
  for (const m of flat) {
    try {
      const data = await getIssueFull(cloudId, m.id ?? m.key);
      results.set(m.key, { newKey: data.key, newUrl: getJiraUrl(data.key) });
    } catch {
      results.set(m.key, { newKey: null, newUrl: null });
    }
  }
  return results;
}

// ─── Legacy clone+delete move (fallback only) ───────────────────────────────────
// Used when the native Bulk Move API is unavailable. Creates a copy in the target
// project, best-effort migrates status/worklogs/fields, then deletes the source.
// Lossy compared to bulk move: comments, attachments and history are NOT carried.

// A freshly created issue starts in the workflow's initial status. Walk transitions
// greedily toward the source status (workflows differ between projects). Best-effort.
async function replicateStatus(cloudId, newKey, targetStatusName) {
  if (!targetStatusName) return;
  const wanted = targetStatusName.trim().toLowerCase();
  try {
    const current = await getIssueFull(cloudId, newKey);
    if (current.fields?.status?.name?.trim().toLowerCase() === wanted) return;
  } catch { /* fall through and try transitions anyway */ }

  const visited = new Set();
  for (let hops = 0; hops < 10; hops++) {
    const transitions = await getTransitions(cloudId, newKey);
    if (!transitions.length) return;
    const direct = transitions.find(t => t.to?.name?.trim().toLowerCase() === wanted);
    if (direct) { await transitionIssue(cloudId, newKey, direct.id); return; }
    const next = transitions.find(t => t.to?.name && !visited.has(t.to.name.trim().toLowerCase()));
    if (!next) return;
    visited.add(next.to.name.trim().toLowerCase());
    await transitionIssue(cloudId, newKey, next.id);
  }
}

// Worklogs live on the source issue and vanish when it is deleted. Re-create each
// on the new issue (the REST API records them under the *current* user, so the
// original author is preserved in the comment text).
function buildWorklogComment(originalComment, authorName, startedIso) {
  const date = startedIso ? startedIso.slice(0, 10) : '';
  const noteText = `Originally logged by ${authorName}${date ? ` on ${date}` : ''}`;
  const content = [
    { type: 'paragraph', content: [{ type: 'text', text: noteText, marks: [{ type: 'em' }] }] },
  ];
  if (originalComment && typeof originalComment === 'object' && Array.isArray(originalComment.content)) {
    content.push(...originalComment.content);
  } else if (typeof originalComment === 'string' && originalComment.trim()) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: originalComment }] });
  }
  return { type: 'doc', version: 1, content };
}

async function migrateWorklogs(cloudId, sourceKey, newKey) {
  let worklogs;
  try { worklogs = await getWorklogs(cloudId, sourceKey); } catch { return; }
  for (const w of worklogs) {
    if (!w.timeSpentSeconds) continue;
    const authorName = w.author?.displayName ?? w.author?.accountId ?? 'unknown user';
    try {
      await addWorklog(cloudId, newKey, {
        timeSpentSeconds: w.timeSpentSeconds,
        started:          w.started,
        comment:          buildWorklogComment(w.comment, authorName, w.started),
      });
    } catch { /* skip an entry Jira rejects, keep the rest */ }
  }
}

// Move a single issue via clone+delete. parentKey re-parents children after the
// parent has moved. Returns { newKey, newUrl, sourceDeleted }.
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
    // The source sprint belongs to the source board and is usually closed — Jira
    // rejects it on the target. Treat it as a cross-project field and drop it.
    const sprintInfo = findSprintField(raw.fields);
    const moveOverrides = {
      parent:            parentKey ? { key: parentKey } : undefined,
      customfield_10014: undefined, // Epic Link — older Jira Cloud
      customfield_10018: undefined, // Parent Link — newer hierarchy field
      components:        undefined, // component IDs are project-specific
      fixVersions:       undefined,
      versions:          undefined,
      ...(sprintInfo ? { [sprintInfo.fieldId]: undefined } : {}),
      ...fieldOverrides,
    };
    const payload = buildPayload(raw.fields, targetProjectKey, targetIssueTypeId, allowedFieldKeys, false, moveOverrides);
    const result  = await createRawIssue(cloudId, payload);
    newKey = result.key;
    newUrl = getJiraUrl(newKey);
    const recoverSkip = Object.keys(payload);
    if (sprintInfo && !(sprintInfo.fieldId in fieldOverrides)) recoverSkip.push(sprintInfo.fieldId);
    try { await recoverFields(cloudId, newKey, raw.fields, recoverSkip); } catch { /* best-effort */ }
    try { await replicateStatus(cloudId, newKey, raw.fields?.status?.name); } catch { /* best-effort */ }
    try { await migrateWorklogs(cloudId, sourceKey, newKey); } catch { /* best-effort */ }
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
