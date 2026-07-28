import { useState, useEffect, useMemo, useCallback, useRef, useContext, createContext } from 'react';
import { PROJECT_LIST } from '../../config/projects.js';
import {
  getAreaPaths, getIterations, getBoardWorkItems,
  getWorkItemStates, updateWorkItemState, getWorkItemComments,
} from '../../services/azureDevops.js';
import {
  getIssuesStatusByKeys, getChildIssuesTreesBulk, getJiraUrl,
  getIssueKeysByAzureIds, getTransitions, transitionIssue,
} from '../../services/jira.js';

const LOGO = 'https://dynamicalabs.com/wp-content/uploads/2024/06/dynamica-white.svg';

const DEFAULT_EXCLUDED_STATES = new Set(['done', 'resolved', 'closed', 'cancelled', 'removed']);

// Jira status categories → chip colour bucket.
const STATUS_TONE = {
  new:           'todo',
  indeterminate: 'progress',
  done:          'done',
};

const toneFor = (cat) => STATUS_TONE[cat] || 'todo';

// "Closing" Azure states — moving an item here while it still has unread
// comments triggers the read-first guard.
const DONE_STATE_RE = /^(done|closed|resolved|completed)$/i;

// Azure DevOps state categories → the same chip colour buckets as Jira.
const AZURE_STATE_TONE = {
  Proposed:   'todo',
  InProgress: 'progress',
  Resolved:   'progress',
  Completed:  'done',
  Removed:    'done',
};

// Run an async mapper over a list with bounded concurrency.
async function mapPool(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

// ─── Build an Epic → child hierarchy from a flat work-item list ───────────────
function buildTree(items) {
  const byId = new Map(items.map(i => [i.id, i]));
  const childrenOf = new Map();
  const roots = [];
  for (const it of items) {
    if (it.parentId != null && byId.has(it.parentId)) {
      if (!childrenOf.has(it.parentId)) childrenOf.set(it.parentId, []);
      childrenOf.get(it.parentId).push(it);
    } else {
      roots.push(it);
    }
  }
  return { roots, childrenOf };
}

// Immutably patch a node's status inside a Jira descendant tree. Returns the same
// array reference when nothing changed so callers can bail out of re-renders.
function updateTreeStatus(nodes, key, status, statusCategory) {
  let changed = false;
  const out = nodes.map(n => {
    if (n.key === key) { changed = true; return { ...n, status, statusCategory }; }
    if (n.children?.length) {
      const c = updateTreeStatus(n.children, key, status, statusCategory);
      if (c !== n.children) { changed = true; return { ...n, children: c }; }
    }
    return n;
  });
  return changed ? out : nodes;
}

// ── Release-readiness pre-filters ────────────────────────────────────────────
// Evaluated per EPIC inside the request's Jira tree, over that epic's own tasks:
//   • maybe ready for UAT — the UAT task itself sits in "Release Ready" /
//     "UAT Release Ready" (no claim about STAGE);
//   • ready for UAT  — a STAGE task is Done while the UAT task is NOT Done yet,
//     i.e. the epic sits on stage and the UAT release is what's next;
//   • ready for PROD — a PROD task is "Approved for Prod".
// An Azure work item lands in a filter when ANY of its epics qualifies; the three
// are independent (an item can show up in several).
const UAT_READY_RE     = /^(?:uat\s+)?release\s*ready$/i;
const PROD_APPROVED_RE = /^approved\s+for\s+prod(uction)?\.?$/i;

// The env of a task is one of the leading short dot-segments of its summary:
// "ABS. STAGE. [WS]. Customer Service. Advantage Module value" → ABS, STAGE;
// "ABS. BA. DEV. [WS]. …" → ABS, BA, DEV. Scanning stops at the first segment
// that isn't a short all-letters token ("[WS]", free text), so an env word
// appearing later in the title can't be mistaken for the task's own env.
function envTokens(summary) {
  const out = [];
  for (const raw of String(summary || '').split('.')) {
    const seg = raw.trim();
    if (!seg) continue;
    if (!/^[a-z]{2,6}$/i.test(seg)) break;
    out.push(seg.toUpperCase());
  }
  return out;
}

const isEnv = (n, env) => envTokens(n.summary).includes(env);

const isDoneNode = n => n.statusCategory === 'done' || /^done$/i.test((n.status || '').trim());

// Flatten one epic's subtree (its tasks, and anything below them).
function collectTasks(nodes, out = []) {
  for (const n of nodes || []) {
    out.push(n);
    if (n.children?.length) collectTasks(n.children, out);
  }
  return out;
}

// The epics of a request tree. A tree with no epic at all is treated as one
// implicit group, so requests that hang tasks straight off the request still
// get evaluated.
function releaseGroups(tree) {
  const epics = [];
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (/epic/i.test(n.type || '')) epics.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(tree);
  return epics.length ? epics.map(e => collectTasks(e.children)) : [collectTasks(tree)];
}

// { uatMaybe, uat, prod } for one Azure item, from its Jira request's tree —
// plus `hits`: per stage, the Jira tasks that actually made the rule fire
// ({ key, why }), so an active pre-filter can highlight them in the tree.
const EMPTY_HITS = { uatMaybe: [], uat: [], prod: [] };

function releaseStagesOf(jiraKey, jira, jiraChildren) {
  const j = jiraKey ? jira.get(jiraKey) : null;
  if (!j) return { uatMaybe: false, uat: false, prod: false, hits: EMPTY_HITS };
  const hits = { uatMaybe: [], uat: [], prod: [] };
  let uatMaybe = false, uat = false, prod = false;
  for (const tasks of releaseGroups(jiraChildren.get(j.key))) {
    const stageDone = tasks.filter(n => isEnv(n, 'STAGE') && isDoneNode(n));
    const uatTasks  = tasks.filter(n => isEnv(n, 'UAT'));

    const uatReady = uatTasks.filter(n => UAT_READY_RE.test((n.status || '').trim()));
    if (uatReady.length) {
      uatMaybe = true;
      for (const n of uatReady) hits.uatMaybe.push({ key: n.key, why: `UAT task is "${n.status}"` });
    }

    const uatOpen = uatTasks.filter(n => !isDoneNode(n));
    if (stageDone.length && uatOpen.length) {
      uat = true;
      for (const n of stageDone) hits.uat.push({ key: n.key, why: 'STAGE task is Done' });
      for (const n of uatOpen)   hits.uat.push({ key: n.key, why: `UAT task is not Done yet ("${n.status}")` });
    }

    const prodApproved = tasks.filter(n => isEnv(n, 'PROD')
                                        && PROD_APPROVED_RE.test((n.status || '').trim()));
    if (prodApproved.length) {
      prod = true;
      for (const n of prodApproved) hits.prod.push({ key: n.key, why: `PROD task is "${n.status}"` });
    }
  }
  return { uatMaybe, uat, prod, hits };
}

// Release pre-filter id → the stage of `releaseStagesOf` it filters on.
const REL_FILTER_STAGE = {
  'rel-uat-maybe': 'uatMaybe',
  'rel-uat':       'uat',
  'rel-prod':      'prod',
};

// Flatten a Jira descendant tree into a compact list for the AI snapshot.
function flattenJiraTree(nodes, out = []) {
  for (const n of nodes || []) {
    out.push({ key: n.key, type: n.type, status: n.status, category: n.statusCategory, assignee: n.assignee || null });
    if (n.children?.length) flattenJiraTree(n.children, out);
  }
  return out;
}

// Build the compact JSON the AI reasons over: one entry per Azure work item with
// its linked Jira request and that request's flattened descendants.
function buildStatsSnapshot(items, jira, jiraChildren) {
  return items.map(it => {
    const j = it.jiraKey ? jira.get(it.jiraKey) : null;
    return {
      azureId:      it.id,
      azureType:    it.type,
      azureTitle:   it.title,
      azureState:   it.state,
      jiraKey:      it.jiraKey || null,
      jiraFound:    !!j,
      jiraStatus:   j?.status ?? null,
      jiraCategory: j?.statusCategory ?? null,
      children:     j ? flattenJiraTree(jiraChildren.get(j.key) || []) : [],
    };
  });
}

// Build the plain-text list to copy from the Azure column, for the given rows.
// kind: 'id' (numbers) | 'title' | 'both'.
function collectAzureColumn(rows, kind) {
  return rows.map(it => {
    if (kind === 'id')    return String(it.id);
    if (kind === 'title') return it.title || `#${it.id}`;
    return `${it.id} — ${it.title || ''}`.trim();
  }).join('\n');
}

// Build the plain-text list to copy from the Jira column, for the given rows.
// kind: 'key' (ABS-123) | 'summary' | 'both' | 'allkeys' (request + descendants).
function collectJiraColumn(rows, jira, jiraChildren, kind) {
  const out = [];
  for (const it of rows) {
    if (!it.jiraKey) continue;
    const j = jira.get(it.jiraKey);
    if (!j) { if (kind === 'key' || kind === 'allkeys') out.push(it.jiraKey); continue; }
    if      (kind === 'summary') out.push(j.summary || j.key);
    else if (kind === 'both')    out.push(`${j.key} — ${j.summary || ''}`.trim());
    else {
      out.push(j.key);
      if (kind === 'allkeys') {
        for (const c of flattenJiraTree(jiraChildren.get(j.key) || [])) out.push(c.key);
      }
    }
  }
  return out.join('\n');
}

// ─── Export the visible (filtered) view as a flat table ───────────────────────
// One row per Jira line, with its Azure work item's columns repeated so the
// sheet stays filterable/pivotable. Rows follow the on-screen tree order.
const EXPORT_COLUMNS = [
  'Azure ID', 'Azure Link', 'Azure Type', 'Azure Title', 'Azure State', 'Azure Assignee', 'Comments',
  'Jira Key', 'Jira Link', 'Jira Type', 'Jira Summary', 'Jira Status', 'Jira Assignee',
];

function buildExportRows(roots, childrenOf, jira, jiraChildren) {
  const rows = [];
  const walkJira = (azure, nodes) => {
    for (const n of nodes || []) {
      rows.push({ ...azure, jiraKey: n.key, jiraUrl: getJiraUrl(n.key), jiraType: n.type || '',
        jiraSummary: n.summary || '', jiraStatus: n.status || '', jiraAssignee: n.assignee || '' });
      walkJira(azure, n.children);
    }
  };
  const pushItem = (it) => {
    const azure = {
      azureId: it.id, azureUrl: it.url || '', azureType: it.type || '', azureTitle: it.title || '',
      azureState: it.state || '', azureAssignee: it.assignedTo || '', comments: commentCountOf(it) || 0,
    };
    const j = it.jiraKey ? jira.get(it.jiraKey) : null;
    if (!it.jiraKey) {
      rows.push({ ...azure, jiraKey: '', jiraUrl: '', jiraType: '', jiraSummary: '', jiraStatus: 'No Jira link', jiraAssignee: '' });
    } else if (!j) {
      rows.push({ ...azure, jiraKey: it.jiraKey, jiraUrl: getJiraUrl(it.jiraKey), jiraType: '', jiraSummary: '', jiraStatus: 'Not found in Jira', jiraAssignee: '' });
    } else {
      rows.push({ ...azure, jiraKey: j.key, jiraUrl: getJiraUrl(j.key), jiraType: j.type || '',
        jiraSummary: j.summary || '', jiraStatus: j.status || '', jiraAssignee: j.assignee || '' });
      walkJira(azure, jiraChildren.get(j.key));
    }
    for (const child of childrenOf.get(it.id) || []) pushItem(child);
  };
  roots.forEach(pushItem);
  return rows;
}

const exportCells = (r) => [
  r.azureId, r.azureUrl, r.azureType, r.azureTitle, r.azureState, r.azureAssignee, r.comments,
  r.jiraKey, r.jiraUrl, r.jiraType, r.jiraSummary, r.jiraStatus, r.jiraAssignee,
];

// A leading = or @ would make Excel treat the cell as a formula — neutralise it.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv(rows) {
  const lines = [EXPORT_COLUMNS, ...rows.map(exportCells)]
    .map(r => r.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n');   // BOM so Excel reads UTF-8 (cyrillic titles)
}

function exportTsv(rows) {
  const flat = v => String(v ?? '').replace(/[\t\n\r]+/g, ' ');
  return [EXPORT_COLUMNS, ...rows.map(exportCells)]
    .map(r => r.map(flat).join('\t')).join('\n');
}

// HTML table for the clipboard: pasting into Excel / Google Sheets keeps the
// Azure #id and Jira key cells as clickable hyperlinks.
function exportHtmlTable(rows) {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const link = (url, text) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));
  const head = ['Azure ID', 'Azure Type', 'Azure Title', 'Azure State', 'Azure Assignee', 'Comments',
    'Jira Key', 'Jira Type', 'Jira Summary', 'Jira Status', 'Jira Assignee'];
  const body = rows.map(r => `<tr><td>${[
    link(r.azureUrl, `#${r.azureId}`), esc(r.azureType), esc(r.azureTitle), esc(r.azureState),
    esc(r.azureAssignee), esc(r.comments),
    link(r.jiraUrl, r.jiraKey), esc(r.jiraType), esc(r.jiraSummary), esc(r.jiraStatus), esc(r.jiraAssignee),
  ].join('</td><td>')}</td></tr>`).join('');
  return `<table><thead><tr><th>${head.join('</th><th>')}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function downloadFile(name, mime, text) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// Copy rich HTML (clickable links) with a plain-text TSV fallback. If the rich
// write fails (Safari quirks, permissions), fall back to plain TSV rather than
// silently leaving the clipboard's PREVIOUS content in place.
async function copyRichTable(html, text) {
  if (navigator.clipboard?.write && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new window.ClipboardItem({
        'text/html':  new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return;
    } catch { /* fall through to plain text */ }
  }
  await navigator.clipboard.writeText(text);
}

// ─── Azure work-item comments: read-state store ──────────────────────────────
// Per-comment read state lives in localStorage (no backend) as a set of
// "itemId:commentId" strings, scoped per signed-in user so different people on
// the same machine don't share their "read" marks. Frontend-only, survives
// refresh — a comment is "unread" until its owner explicitly marks it read.
const READ_KEY_PREFIX = 'su_read_comments_v1';
const readKey = (user) => `${READ_KEY_PREFIX}:${user || 'anon'}`;

function loadReadSet(user) {
  try {
    const raw = localStorage.getItem(readKey(user));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveReadSet(user, set) {
  try { localStorage.setItem(readKey(user), JSON.stringify([...set])); } catch { /* noop */ }
}

const commentTag = (itemId, commentId) => `${itemId}:${commentId}`;

// How many of a work item's comments are already marked read (by counting the
// "itemId:" prefixed tags in the read set). Lets a card show its unread count
// without fetching comment bodies — unread = commentCount − readCount.
function readCountFor(readSet, itemId) {
  let n = 0;
  const prefix = `${itemId}:`;
  for (const tag of readSet) if (tag.startsWith(prefix)) n++;
  return n;
}

// The System.CommentCount field Azure stamps on every work item — cheap badge
// count with no extra request (getBoardWorkItems already pulls the full fields).
const commentCountOf = (item) => Number(item.fields?.['System.CommentCount']) || 0;

// Azure comment `text` is HTML. Render it as plain text (with line breaks
// preserved) to avoid injecting untrusted markup into the DOM.
function htmlToText(html) {
  if (!html) return '';
  const withBreaks = String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li)\s*>/gi, '\n');
  const el = document.createElement('div');
  el.innerHTML = withBreaks;
  return (el.textContent || el.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
}

function fmtCommentDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// Provides comments read-state + the "open comments" callback to the deep-nested
// Azure cell without prop-drilling through the recursive tree.
const CommentsCtx = createContext(null);

// Provides the bits an inline StatusChip needs without prop-drilling through the
// recursive tree: the Jira cloud id and the "status changed" callback.
const StatusEditCtx = createContext(null);

// Same idea for the Azure side: proxy/project, a cache of valid states per work-
// item type, a lazy loader, and the optimistic "state changed" callback.
const AzureEditCtx = createContext(null);

// While a release pre-filter is active: Map<jiraKey, why> of the tasks that made
// the rule fire, so JiraLine can highlight itself (null = no release filter).
const ReleaseHitsCtx = createContext(null);

// ─── Anchored popover positioning ─────────────────────────────────────────────
// Keep a fixed-position menu glued to its trigger. Previously these menus closed
// on *any* scroll — but a capture-phase scroll listener also fires when the user
// scrolls *inside* a tall menu (the status list is scrollable), dismissing it
// mid-interaction. Instead we reposition the menu to follow its button, and
// ignore scroll events that originate within the menu itself.
function useAnchoredMenu(open, btnRef, menuRef, setPos) {
  useEffect(() => {
    if (!open) return;
    const reposition = (e) => {
      if (e?.type === 'scroll' && menuRef.current?.contains(e.target)) return;
      const btn = btnRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      setPos({ top: r.bottom + 4, left: r.left });
    };
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, btnRef, menuRef, setPos]);
}

// ─── Icons ────────────────────────────────────────────────────────────────────
function RefreshIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M21 12a9 9 0 11-2.64-6.36M21 3v6h-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M10 13a5 5 0 007 0l3-3a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-3 3a5 5 0 007 7l1-1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M21 21l-4.3-4.3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

function ChevronIcon({ dir = 'left' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
      style={{ transform: dir === 'right' ? 'rotate(180deg)' : undefined }}>
      <path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

const SIDEBAR_KEY = 'su_sidebar_collapsed';

function CopyColIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  );
}

// Column-header "Copy" dropdown. `options` = [{ key, label, getText }]. Picking
// one copies its text to the clipboard and shows a brief confirmation. Used to
// grab all visible ids / keys / titles at once (e.g. to paste into an LLM).
function CopyMenu({ title, count, options }) {
  const [open,   setOpen]   = useState(false);
  const [copied, setCopied] = useState(false);
  const [pos,    setPos]    = useState(null);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);

  // Fixed positioning (computed from the button) so the menu isn't clipped by
  // the table's overflow:hidden. Reposition (don't close) on scroll/resize.
  useAnchoredMenu(open, btnRef, menuRef, setPos);

  function toggle() {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
  }

  async function pick(opt) {
    try { await navigator.clipboard.writeText(opt.getText()); } catch { /* noop */ }
    setOpen(false);
    setCopied(true);
    setTimeout(() => setCopied(false), 1300);
  }

  return (
    <span className="su-copycol">
      <button
        ref={btnRef}
        type="button"
        className={`su-copycol-btn${copied ? ' copied' : ''}`}
        onClick={toggle}
        title={title}
      >
        <CopyColIcon />
        {copied ? 'Copied' : 'Copy'}
      </button>
      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-copycol-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            <div className="su-copycol-head">{count} rows — copy what:</div>
            {options.map(opt => (
              <button key={opt.key} type="button" className="su-copycol-item" onClick={() => pick(opt)}>
                {opt.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// Toolbar "Export" dropdown — dumps the CURRENT view (filtered or not, in the
// on-screen tree order). `options` = [{ key, label, hint, run, done }]:
// run() returns the exported row count, done(n) builds the feedback label —
// showing the exact count so a filtered export is visibly filtered.
function ExportMenu({ count, total, options }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState('');
  const [pos,  setPos]  = useState(null);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);

  useAnchoredMenu(open, btnRef, menuRef, setPos);

  function toggle() {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
  }

  async function pick(opt) {
    let msg;
    try { msg = opt.done(await opt.run()); } catch { msg = '⚠ Failed'; }
    setOpen(false);
    setDone(msg);
    setTimeout(() => setDone(''), 2500);
  }

  return (
    <span className="su-copycol">
      <button
        ref={btnRef}
        type="button"
        className={`su-export-btn${done ? ' copied' : ''}`}
        onClick={toggle}
        title="Export the visible rows as a table"
      >
        <DownloadIcon />
        {done || 'Export'}
      </button>
      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-copycol-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            <div className="su-copycol-head">
              {count === total ? `${count} work items` : `${count} of ${total} work items (filtered view)`} — export as:
            </div>
            {options.map(opt => (
              <button key={opt.key} type="button" className="su-copycol-item" onClick={() => pick(opt)}>
                {opt.label}
                {opt.hint && <span className="su-export-hint">{opt.hint}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// Minimal, safe markdown for the AI answer: escape HTML, then **bold** and
// `code`. Bullet lines (- / •) render as a list. No raw HTML from the model.
function aiInline(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function AiAnswer({ text }) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const blocks = [];
  let bullets = null;
  for (const line of lines) {
    const m = line.match(/^[-*•]\s+(.*)$/);
    if (m) { (bullets ||= []).push(m[1]); continue; }
    if (bullets) { blocks.push({ type: 'ul', items: bullets }); bullets = null; }
    blocks.push({ type: 'p', text: line });
  }
  if (bullets) blocks.push({ type: 'ul', items: bullets });
  return (
    <div className="su-ai-answer-body">
      {blocks.map((b, i) => b.type === 'ul'
        ? <ul key={i} className="su-ai-list">{b.items.map((it, j) => <li key={j} dangerouslySetInnerHTML={{ __html: aiInline(it) }} />)}</ul>
        : <p key={i} dangerouslySetInnerHTML={{ __html: aiInline(b.text) }} />)}
    </div>
  );
}

// Map a Jira issue type to one of the existing type-colour chips.
function typeClass(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('epic')) return 'su-type-epic';
  if (t.includes('task') || t.includes('sub-task') || t.includes('subtask')) return 'su-type-task';
  return 'su-type-issue';
}

// ─── Inline-editable Jira status chip ─────────────────────────────────────────
// Click → lazy-load the issue's valid workflow transitions → apply one. Updates
// state optimistically (the workflow guarantees only valid targets are offered).
function StatusChip({ issueKey, status, statusCategory }) {
  const ctx = useContext(StatusEditCtx);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);
  const [open,        setOpen]        = useState(false);
  const [pos,         setPos]         = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [transitions, setTransitions] = useState(null);
  const [err,         setErr]         = useState('');

  const editable = !!ctx?.cloudId && !!issueKey;

  // Keep the fixed-position popover glued to its chip (reposition, don't close)
  // so scrolling the tall status list doesn't dismiss it.
  useAnchoredMenu(open, btnRef, menuRef, setPos);

  async function toggle(e) {
    e.stopPropagation();
    if (!editable) return;
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    setErr('');
    if (transitions == null) {
      setLoading(true);
      try {
        setTransitions(await getTransitions(ctx.cloudId, issueKey));
      } catch (e2) {
        setErr(e2.message || 'Failed to load transitions');
      } finally {
        setLoading(false);
      }
    }
  }

  async function apply(t) {
    setSaving(true);
    setErr('');
    try {
      await transitionIssue(ctx.cloudId, issueKey, t.id);
      ctx.onStatusChange(issueKey, t.to?.name ?? t.name, t.to?.statusCategory?.key ?? statusCategory);
      setOpen(false);
      setTransitions(null);   // available transitions change after a move — refetch next open
    } catch (e2) {
      setErr(e2.message || 'Transition failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="su-status-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`su-status su-status-${toneFor(statusCategory)}${editable ? ' su-status-editable' : ''}`}
        onClick={toggle}
        disabled={saving}
        title={editable ? 'Change status' : undefined}
      >
        {saving ? <span className="spinner" style={{ width: 10, height: 10 }} /> : (status || '—')}
        {editable && <span className="su-status-caret">▾</span>}
      </button>

      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-status-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            {loading && <div className="su-status-menu-item muted"><span className="spinner" style={{ width: 12, height: 12 }} /> Loading…</div>}
            {err && <div className="su-status-menu-item su-status-menu-err">⚠ {err}</div>}
            {!loading && !err && transitions?.length === 0 && (
              <div className="su-status-menu-item muted">No transitions available</div>
            )}
            {!loading && !err && transitions?.map(t => (
              <button key={t.id} type="button" className="su-status-menu-item" disabled={saving} onClick={() => apply(t)}>
                <span className="su-status-menu-name">{t.name}</span>
                {t.to?.name && t.to.name !== t.name && <span className="su-status-menu-to">→ {t.to.name}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}

// One line in the Jira column: type chip · key · summary · status · assignee.
// Laid out on a fixed grid so every line aligns in columns (no indentation drift).
function JiraLine({ issue, isRequest }) {
  // Highlighted when this very task is what made the active release rule fire.
  const why = useContext(ReleaseHitsCtx)?.get(issue.key);
  return (
    <div
      className={`su-jira-line${isRequest ? ' su-jira-request' : ''}${why ? ' su-jira-hit' : ''}`}
      title={why ? `Matches the active release filter — ${why}` : undefined}
    >
      <span className={`su-type ${typeClass(issue.type)}`} title={issue.type}>{issue.type || '—'}</span>
      <a className="su-jira-key" href={getJiraUrl(issue.key)} target="_blank" rel="noreferrer">
        {isRequest && <LinkIcon />} {issue.key}
      </a>
      <span className="su-child-title" title={issue.summary}>{issue.summary}</span>
      <StatusChip issueKey={issue.key} status={issue.status} statusCategory={issue.statusCategory} />
      <span className="su-assignee">{issue.assignee || 'Unassigned'}</span>
    </div>
  );
}

// Recursive Jira descendant tree — epics with their tasks, tasks with subtasks.
// Rendered flat (no extra indent); hierarchy is conveyed by the type colour.
function JiraTree({ nodes }) {
  if (!nodes?.length) return null;
  return nodes.map(n => (
    <div key={n.key} className="su-jira-subtree">
      <JiraLine issue={n} />
      <JiraTree nodes={n.children} />
    </div>
  ));
}

// ─── Inline-editable Azure DevOps state chip ──────────────────────────────────
// Mirrors the Jira StatusChip: click → lazy-load the valid states for this work-
// item type → PATCH System.State → optimistic UI update. Azure validates the
// move server-side, so an illegal transition surfaces as an error in the menu.
function AzureStateChip({ item }) {
  const ctx = useContext(AzureEditCtx);
  const commentsCtx = useContext(CommentsCtx);
  const btnRef  = useRef(null);
  const menuRef = useRef(null);
  const [open,    setOpen]    = useState(false);
  const [pos,     setPos]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [states,  setStates]  = useState(null);
  const [err,     setErr]     = useState('');
  const [guardState, setGuardState] = useState(null);   // pending Done-state awaiting confirmation

  const editable = !!ctx?.editable;
  const cached   = ctx?.statesByType?.[item.type];
  const cat      = (cached || []).find(s => s.name === item.state)?.category;
  const tone     = AZURE_STATE_TONE[cat] || 'todo';

  // Unread comments on this work item (0 when the comments context is absent).
  const unread = commentsCtx
    ? Math.max(0, commentCountOf(item) - readCountFor(commentsCtx.readSet, item.id))
    : 0;

  // A target state is "closing" when its name reads done/closed/… or its Azure
  // state category is Completed.
  const isDoneLike = (stateName) =>
    DONE_STATE_RE.test((stateName || '').trim()) ||
    (states || cached || []).find(s => s.name === stateName)?.category === 'Completed';

  useAnchoredMenu(open, btnRef, menuRef, setPos);

  async function toggle(e) {
    e.stopPropagation();
    if (!editable) return;
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: r.left });
    setOpen(true);
    setErr('');
    if (states == null) {
      setLoading(true);
      try {
        setStates(await ctx.loadStates(item.type));
      } catch (e2) {
        setErr(e2.message || 'Failed to load states');
      } finally {
        setLoading(false);
      }
    }
  }

  async function apply(stateName) {
    if (stateName === item.state) { setOpen(false); return; }
    // Read-first guard: block closing an item that still has unread comments.
    if (unread > 0 && isDoneLike(stateName)) {
      setOpen(false);
      setGuardState(stateName);
      return;
    }
    await doApply(stateName);
  }

  async function doApply(stateName) {
    setSaving(true);
    setErr('');
    try {
      await updateWorkItemState(ctx.proxyKey, ctx.project, item.id, stateName);
      ctx.onStateChange(item.id, stateName);
      setOpen(false);
      setGuardState(null);
    } catch (e2) {
      setErr(e2.message || 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="su-status-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`su-status su-status-${tone}${editable ? ' su-status-editable' : ''}`}
        onClick={toggle}
        disabled={saving}
        title={editable ? 'Change Azure state' : undefined}
      >
        {saving ? <span className="spinner" style={{ width: 10, height: 10 }} /> : (item.state || '—')}
        {editable && <span className="su-status-caret">▾</span>}
      </button>

      {open && (
        <>
          <div className="su-status-backdrop" onClick={() => setOpen(false)} />
          <div ref={menuRef} className="su-status-menu" style={pos ? { top: pos.top, left: pos.left } : undefined}>
            {loading && <div className="su-status-menu-item muted"><span className="spinner" style={{ width: 12, height: 12 }} /> Loading…</div>}
            {err && <div className="su-status-menu-item su-status-menu-err">⚠ {err}</div>}
            {!loading && !err && states?.length === 0 && (
              <div className="su-status-menu-item muted">No states available</div>
            )}
            {!loading && !err && states?.map(s => (
              <button
                key={s.name}
                type="button"
                className={`su-status-menu-item${s.name === item.state ? ' active' : ''}`}
                disabled={saving}
                onClick={() => apply(s.name)}
              >
                {s.color && <span className="su-state-dot" style={{ background: `#${s.color}` }} />}
                <span className="su-status-menu-name">{s.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {guardState && (
        <div className="rel-modal-backdrop" onClick={() => setGuardState(null)}>
          <div className="su-guard-modal" onClick={e => e.stopPropagation()}>
            <div className="su-guard-icon">🔔</div>
            <h3 className="su-guard-title">Please read the comments first</h3>
            <p className="su-guard-text">
              Work item <strong>#{item.id}</strong> has <strong>{unread}</strong> unread
              comment{unread === 1 ? '' : 's'}. Review them before moving it to
              “<strong>{guardState}</strong>” — closing an item with unfinished discussion may miss important feedback.
            </p>
            <div className="su-guard-actions">
              <button className="btn btn-ghost" onClick={() => setGuardState(null)}>Cancel</button>
              {commentsCtx && (
                <button
                  className="btn btn-primary"
                  onClick={() => { const it = item; setGuardState(null); commentsCtx.onOpen(it); }}
                >
                  Read comments
                </button>
              )}
            </div>
            <button className="su-guard-anyway" onClick={() => doApply(guardState)} disabled={saving}>
              {saving ? 'Changing…' : `Change to “${guardState}” anyway`}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Comment badge on an Azure work-item card ─────────────────────────────────
// Shows the comment count from System.CommentCount. When the item has comments
// the current user hasn't marked read yet, it turns into a 🔔 "new" badge with
// the unread count. Clicking opens the comments popup.
function CommentBadgeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CommentButton({ item }) {
  const ctx = useContext(CommentsCtx);
  if (!ctx) return null;
  const count = commentCountOf(item);
  if (count <= 0) return null;

  const unread = Math.max(0, count - readCountFor(ctx.readSet, item.id));
  const hasNew = unread > 0;

  return (
    <button
      type="button"
      className={`su-comment-badge${hasNew ? ' su-comment-new' : ''}`}
      onClick={(e) => { e.stopPropagation(); ctx.onOpen(item); }}
      title={hasNew ? `${unread} new comment${unread === 1 ? '' : 's'} (${count} total)` : `${count} comment${count === 1 ? '' : 's'}`}
    >
      {hasNew ? <BellIcon /> : <CommentBadgeIcon />}
      <span className="su-comment-count">{count}</span>
      {hasNew && <span className="su-comment-newdot">{unread}</span>}
    </button>
  );
}

// ─── Comments popup for a single Azure work item ──────────────────────────────
// Lazy-fetches the discussion on open. Each comment carries a "read" checkbox;
// ticking it records the comment id in the per-user read set (disabled once
// read). "Mark all read" ticks every loaded comment at once.
function CommentsModal({ item, onClose }) {
  const ctx = useContext(CommentsCtx);
  const [comments, setComments] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr('');
    getWorkItemComments(ctx.proxyKey, ctx.project, item.id)
      .then(list => { if (!cancelled) setComments(list); })
      .catch(e => { if (!cancelled) setErr(e.message || 'Failed to load comments'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ctx.proxyKey, ctx.project, item.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const unreadCount = comments
    ? comments.filter(c => !ctx.readSet.has(commentTag(item.id, c.id))).length
    : 0;

  return (
    <div className="rel-modal-backdrop" onClick={onClose}>
      <div className="su-comments-modal" onClick={e => e.stopPropagation()}>
        <div className="rel-modal-head">
          <div>
            <h3 className="rel-modal-title">Comments · #{item.id}</h3>
            <p className="rel-modal-sub" title={item.title}>{item.title}</p>
          </div>
          <div className="rel-modal-tools">
            {comments?.length > 0 && unreadCount > 0 && (
              <button
                className="btn btn-ghost su-comments-markall"
                onClick={() => ctx.markAllRead(item.id, comments.map(c => c.id))}
              >
                Mark all read
              </button>
            )}
            <button className="rel-modal-close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        <div className="rel-modal-body su-comments-body">
          {loading && <div className="su-empty"><span className="spinner spinner-lg" /></div>}
          {err && <p className="su-error">⚠ {err}</p>}
          {!loading && !err && comments?.length === 0 && (
            <p className="su-empty-sub">No comments on this work item.</p>
          )}
          {!loading && !err && comments?.map(c => {
            const read = ctx.readSet.has(commentTag(item.id, c.id));
            return (
              <div key={c.id} className={`su-comment${read ? ' su-comment-read' : ''}`}>
                <div className="su-comment-head">
                  <span className="su-comment-author">{c.author}</span>
                  <span className="su-comment-date">{fmtCommentDate(c.createdDate)}</span>
                  <label className={`su-comment-readtoggle${read ? ' checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={read}
                      disabled={read}
                      onChange={() => ctx.markRead(item.id, c.id)}
                    />
                    {read ? 'Read' : 'Mark read'}
                  </label>
                </div>
                <div className="su-comment-text">{htmlToText(c.text) || <span className="su-comment-empty">(no text)</span>}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── A single row: Azure work item ⟷ its Jira request (+ children) ─────────────
function WorkItemRow({ item, jira, jiraChildren, depth }) {
  const j = item.jiraKey ? jira.get(item.jiraKey) : null;
  const children = j ? (jiraChildren.get(j.key) ?? []) : [];

  return (
    <div className="su-row" style={{ paddingLeft: 16 + depth * 22 }}>
      {/* Left — Azure DevOps work item, stacked: meta · title · assignee */}
      <div className="su-cell su-azure">
        <div className="su-az-meta">
          <span className={`su-type su-type-${item.type.toLowerCase().replace(/\s+/g, '-')}`}>{item.type}</span>
          {item.url
            ? <a className="su-az-id su-az-link" href={item.url} target="_blank" rel="noreferrer" title="Open in Azure DevOps">#{item.id}</a>
            : <span className="su-az-id">#{item.id}</span>}
          <CommentButton item={item} />
          <AzureStateChip item={item} />
        </div>
        <span className="su-title" title={item.title}>{item.title}</span>
        <div className="su-az-who">
          <span className="su-assignee" title={item.assignedTo || 'Unassigned'}>
            {item.assignedTo || 'Unassigned'}
          </span>
        </div>
      </div>

      {/* Right — linked Jira request and all its children */}
      <div className="su-cell su-jira">
        {item.jiraKey ? (
          j ? (
            <div className="su-jira-block">
              <JiraLine issue={j} isRequest />
              <JiraTree nodes={children} />
            </div>
          ) : (
            <div className="su-jira-block">
              <span className="su-jira-key su-jira-missing">{item.jiraKey}</span>
              <span className="su-status su-status-none">Not found in Jira</span>
            </div>
          )
        ) : (
          <span className="su-status su-status-none">No Jira link</span>
        )}
      </div>
    </div>
  );
}

function TreeRows({ roots, childrenOf, jira, jiraChildren, depth = 0 }) {
  return roots.map(item => (
    <div key={item.id} className="su-tree-node">
      <WorkItemRow item={item} jira={jira} jiraChildren={jiraChildren} depth={depth} />
      {childrenOf.get(item.id)?.length > 0 && (
        <TreeRows roots={childrenOf.get(item.id)} childrenOf={childrenOf} jira={jira} jiraChildren={jiraChildren} depth={depth + 1} />
      )}
    </div>
  ));
}

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function StatusUpdatesApp({ user, allowedProjects, onLogout }) {
  const projects = useMemo(() => (
    allowedProjects?.length
      ? PROJECT_LIST.filter(p => allowedProjects.includes(p.id))
      : PROJECT_LIST
  ), [allowedProjects]);

  const [proj,          setProj]          = useState(projects[0]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem(SIDEBAR_KEY) === '1'; } catch { return false; }
  });
  const [boards,        setBoards]        = useState([]);
  const [selectedBoard, setSelectedBoard] = useState('');
  const [boardsLoading, setBoardsLoading] = useState(false);

  const [iterations,     setIterations]     = useState([]);
  const [selectedSprint, setSelectedSprint] = useState('');
  const [sprintsLoading, setSprintsLoading] = useState(false);

  const [items,        setItems]        = useState([]);
  const [jira,         setJira]         = useState(new Map());
  const [jiraChildren, setJiraChildren] = useState(new Map());
  const [loading,      setLoading]      = useState(false);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [error,        setError]        = useState('');
  const [loaded,       setLoaded]       = useState(false);
  // Monotonic load id — a stale load (older Refresh / previous project) checks
  // it before touching state so it can't clobber a newer load's results.
  const loadSeq = useRef(0);

  // Search + filter
  const [query,        setQuery]        = useState('');
  // all | linked | missing | unlinked | ready | unread | rel-uat | rel-prod
  const [activeFilter, setActiveFilter] = useState('all');
  const [azureStateFilter, setAzureStateFilter] = useState(''); // '' = all Azure states

  // Azure state editing: cache valid states per work-item type (per project)
  const [azStatesByType, setAzStatesByType] = useState({});

  // Azure comments: per-user read-state (localStorage) + the open popup target.
  const [readSet,       setReadSet]       = useState(() => loadReadSet(user));
  const [openComments,  setOpenComments]  = useState(null);   // work item | null
  useEffect(() => { setReadSet(loadReadSet(user)); }, [user]);

  const markRead = useCallback((itemId, commentId) => {
    setReadSet(prev => {
      const tag = commentTag(itemId, commentId);
      if (prev.has(tag)) return prev;
      const next = new Set(prev); next.add(tag);
      saveReadSet(user, next);
      return next;
    });
  }, [user]);

  const markAllRead = useCallback((itemId, commentIds) => {
    setReadSet(prev => {
      const next = new Set(prev);
      let changed = false;
      for (const id of commentIds) {
        const tag = commentTag(itemId, id);
        if (!next.has(tag)) { next.add(tag); changed = true; }
      }
      if (!changed) return prev;
      saveReadSet(user, next);
      return next;
    });
  }, [user]);

  const commentsCtx = useMemo(() => ({
    proxyKey: proj?.azure?.proxyKey,
    project:  proj?.azure?.project,
    readSet,
    onOpen:   setOpenComments,
    markRead,
    markAllRead,
  }), [proj, readSet, markRead, markAllRead]);

  // AI validation over the loaded snapshot
  const [aiQuery,     setAiQuery]     = useState('');
  const [aiLoading,   setAiLoading]   = useState(false);
  const [aiAnswer,    setAiAnswer]    = useState('');
  const [aiError,     setAiError]     = useState('');
  const [aiMatchIds,  setAiMatchIds]  = useState(null);      // Set<number> | null
  const [aiCopied,    setAiCopied]    = useState(false);
  const aiInputRef = useRef(null);

  const hasBoards  = !!proj?.features?.board;
  const hasSprints = !!proj?.features?.iteration;

  // ── Load boards (area paths) and/or sprints (iterations) on project change ──
  useEffect(() => {
    loadSeq.current++;               // invalidate any in-flight load
    setBoards([]);
    setSelectedBoard('');
    setIterations([]);
    setSelectedSprint('');
    setItems([]);
    setJira(new Map());
    setJiraChildren(new Map());
    setLoaded(false);
    setLoading(false);
    setChildrenLoading(false);
    setError('');
    setQuery('');
    setActiveFilter('all');
    setAzStatesByType({});           // states differ per project process
    setAiAnswer(''); setAiError(''); setAiMatchIds(null); setAiQuery('');
    if (!proj) return;

    let cancelled = false;

    if (hasBoards) {
      setBoardsLoading(true);
      getAreaPaths(proj.azure.proxyKey, proj.azure.project)
        .then(all => {
          if (cancelled) return;
          const allow = proj.boardAllowList;
          setBoards(allow?.length ? all.filter(b => allow.includes(b.name)) : all);
        })
        .catch(e => !cancelled && setError(e.message))
        .finally(() => !cancelled && setBoardsLoading(false));
    }

    if (hasSprints) {
      setSprintsLoading(true);
      getIterations(proj.azure.proxyKey, proj.azure.project)
        .then(all => { if (!cancelled) setIterations(all); })
        .catch(e => !cancelled && setError(e.message))
        .finally(() => !cancelled && setSprintsLoading(false));
    }

    return () => { cancelled = true; };
  }, [proj, hasBoards, hasSprints]);

  // ── Load the board's work items + their Jira statuses ──────────────────────
  const load = useCallback(async () => {
    if (!proj) return;
    if (hasBoards && !selectedBoard) { setError('Select a board first.'); return; }
    const seq = ++loadSeq.current;
    setLoading(true);
    setChildrenLoading(false);
    setError('');
    // A fresh dataset invalidates any prior AI answer/matches and stale filters.
    setAiAnswer(''); setAiError(''); setAiMatchIds(null); setAzureStateFilter('');
    try {
      const azItems = await getBoardWorkItems(
        proj.azure.proxyKey,
        proj.azure.project,
        proj.azure.jiraIdField,
        hasBoards ? selectedBoard : null,
        hasSprints ? (selectedSprint || null) : null,
      );
      // Hide Azure work items in terminal states (project-specific config or defaults).
      const excludedStates = proj.statusUpdates?.excludeStates
        ? new Set(proj.statusUpdates.excludeStates)
        : DEFAULT_EXCLUDED_STATES;
      const visible = azItems.filter(i => !excludedStates.has((i.state || '').trim().toLowerCase()));

      // Resolve the Jira link the way task creation does — by the Azure id stamped
      // on the Jira side (clientRequestIdField), which is reliable. Fall back to the
      // Azure-side field for any item the reverse lookup doesn't cover.
      const keyByAzureId = await getIssueKeysByAzureIds(
        proj.jira.cloudId,
        proj.jiraProjectOptions?.length ? proj.jiraProjectOptions : proj.jira.projectKey,
        proj.jira.clientRequestIdField,
        visible.map(i => i.id),
      );
      const linked = visible.map(i => ({
        ...i,
        jiraKey: keyByAzureId.get(String(i.id)) ?? i.jiraKey,
      }));

      const keys = linked.map(i => i.jiraKey).filter(Boolean);
      const jiraMap = await getIssuesStatusByKeys(proj.jira.cloudId, keys);
      if (seq !== loadSeq.current) return;

      // Phase 1 — show the table as soon as the requests' own statuses arrive.
      setItems(linked);
      setJira(jiraMap);
      setJiraChildren(new Map());
      setLoaded(true);
      setLoading(false);

      // Phase 2 — every request's Jira descendant tree in one bulk, level-by-
      // level fetch (a handful of round trips instead of two per tree node).
      const requestKeys = [...new Set(keys)].filter(k => jiraMap.has(k));
      if (requestKeys.length) {
        setChildrenLoading(true);
        try {
          const trees = await getChildIssuesTreesBulk(proj.jira.cloudId, requestKeys);
          if (seq === loadSeq.current) setJiraChildren(trees);
        } finally {
          if (seq === loadSeq.current) setChildrenLoading(false);
        }
      }
    } catch (e) {
      if (seq === loadSeq.current) setError(e.message || 'Failed to load.');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [proj, hasBoards, selectedBoard, hasSprints, selectedSprint]);

  // ── Optimistic status patch after an inline transition ─────────────────────
  const handleStatusChanged = useCallback((key, status, statusCategory) => {
    setJira(prev => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.set(key, { ...next.get(key), status, statusCategory });
      return next;
    });
    setJiraChildren(prev => {
      let changed = false;
      const next = new Map();
      for (const [k, tree] of prev) {
        const upd = updateTreeStatus(tree, key, status, statusCategory);
        if (upd !== tree) changed = true;
        next.set(k, upd);
      }
      return changed ? next : prev;
    });
  }, []);

  const editCtx = useMemo(
    () => ({ cloudId: proj?.jira?.cloudId, onStatusChange: handleStatusChanged }),
    [proj, handleStatusChanged],
  );

  // ── Azure state editing: lazy-load + cache valid states per work-item type ──
  const loadAzStates = useCallback(async (type) => {
    if (azStatesByType[type]) return azStatesByType[type];
    const states = await getWorkItemStates(proj.azure.proxyKey, proj.azure.project, type);
    setAzStatesByType(prev => ({ ...prev, [type]: states }));
    return states;
  }, [proj, azStatesByType]);

  const handleAzStateChanged = useCallback((id, state) => {
    setItems(prev => prev.map(i => (i.id === id ? { ...i, state } : i)));
  }, []);

  const azEditCtx = useMemo(() => ({
    editable:     !!proj?.azure,
    proxyKey:     proj?.azure?.proxyKey,
    project:      proj?.azure?.project,
    statesByType: azStatesByType,
    loadStates:   loadAzStates,
    onStateChange: handleAzStateChanged,
  }), [proj, azStatesByType, loadAzStates, handleAzStateChanged]);

  // ── AI validation over the currently-loaded snapshot ───────────────────────
  const askAi = useCallback(async () => {
    const question = aiQuery.trim();
    if (!question || aiLoading) return;
    setAiLoading(true);
    setAiError('');
    setAiAnswer('');
    try {
      const snapshot = buildStatsSnapshot(items, jira, jiraChildren);
      const res = await fetch('/api/stats-query', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ question, data: snapshot }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      setAiAnswer(data.answer || '');
      // Only switch the table into "AI match" mode when the model returned ids.
      setAiMatchIds(Array.isArray(data.matchAzureIds) && data.matchAzureIds.length
        ? new Set(data.matchAzureIds)
        : null);
    } catch (e) {
      setAiError(e.message || 'AI request failed.');
    } finally {
      setAiLoading(false);
    }
  }, [aiQuery, aiLoading, items, jira, jiraChildren]);

  const clearAiMatch = useCallback(() => setAiMatchIds(null), []);

  // A request that is still In Progress while every one of its Jira children is
  // already Done — a signal it can probably be closed.
  const isReadyToClose = useCallback((it) => {
    const j = it.jiraKey ? jira.get(it.jiraKey) : null;
    if (!j || j.statusCategory !== 'indeterminate') return false;
    const flat = [];
    const walk = (nodes) => { for (const n of nodes || []) { flat.push(n); walk(n.children); } };
    walk(jiraChildren.get(j.key));
    return flat.length > 0 && flat.every(n => n.statusCategory === 'done');
  }, [jira, jiraChildren]);

  // Per-epic release readiness of an item (see releaseStagesOf).
  const releaseStages = useCallback(
    (it) => releaseStagesOf(it.jiraKey, jira, jiraChildren),
    [jira, jiraChildren],
  );

  // ── Summary counts (always over the full set, not the filtered view) ───────
  const stats = useMemo(() => {
    let linked = 0, missing = 0, unlinked = 0, ready = 0, relUatMaybe = 0, relUat = 0, relProd = 0;
    for (const it of items) {
      if (!it.jiraKey) unlinked++;
      else if (jira.has(it.jiraKey)) linked++;
      else missing++;
      if (isReadyToClose(it)) ready++;
      const rel = releaseStages(it);
      if (rel.uatMaybe) relUatMaybe++;
      if (rel.uat)      relUat++;
      if (rel.prod)     relProd++;
    }
    return { total: items.length, linked, missing, unlinked, ready, relUatMaybe, relUat, relProd };
  }, [items, jira, isReadyToClose, releaseStages]);

  // Unread comments per item = System.CommentCount − comments already marked read.
  const itemUnread = useCallback(
    (it) => Math.max(0, commentCountOf(it) - readCountFor(readSet, it.id)),
    [readSet],
  );

  // Comment counters for the sidebar: how many items carry comments at all, and
  // how many have unread (new) ones for this user.
  const commentStats = useMemo(() => {
    let withComments = 0, unread = 0;
    for (const it of items) {
      if (commentCountOf(it) <= 0) continue;
      withComments++;
      if (itemUnread(it) > 0) unread++;
    }
    return { withComments, unread };
  }, [items, itemUnread]);

  // Bulk "mark everything read as of now": fetch every commented item's comment
  // ids and record them, so the unread/🔔 count resets and only future comments
  // count as new. Bounded concurrency keeps it gentle on the proxy.
  const [markingAll, setMarkingAll] = useState(false);
  const markAllReadNow = useCallback(async () => {
    const targets = items.filter(it => commentCountOf(it) > 0);
    if (!targets.length || markingAll) return;
    setMarkingAll(true);
    try {
      const entries = await mapPool(targets, 5, async (it) => {
        try {
          const list = await getWorkItemComments(proj.azure.proxyKey, proj.azure.project, it.id);
          return [it.id, list.map(c => c.id)];
        } catch { return [it.id, []]; }
      });
      setReadSet(prev => {
        const next = new Set(prev);
        for (const [itemId, ids] of entries) for (const cid of ids) next.add(commentTag(itemId, cid));
        saveReadSet(user, next);
        return next;
      });
    } finally {
      setMarkingAll(false);
    }
  }, [items, proj, user, markingAll]);

  // Distinct Azure work-item states present in the loaded set (+ counts), for
  // the status filter dropdown.
  const azureStates = useMemo(() => {
    const m = new Map();
    for (const it of items) {
      const s = (it.state || '').trim();
      if (!s) continue;
      m.set(s, (m.get(s) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);

  // ── Apply search + filter, then rebuild the tree from the surviving items ───
  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter(it => {
      // Azure state filter is independent — it narrows regardless of link/AI mode.
      if (azureStateFilter && (it.state || '').trim() !== azureStateFilter) return false;
      // AI match, when active, takes precedence over the status filters.
      if (aiMatchIds) { if (!aiMatchIds.has(it.id)) return false; }
      else {
        if (activeFilter === 'linked'   && !(it.jiraKey && jira.has(it.jiraKey)))  return false;
        if (activeFilter === 'missing'  && !(it.jiraKey && !jira.has(it.jiraKey))) return false;
        if (activeFilter === 'unlinked' && it.jiraKey)                             return false;
        if (activeFilter === 'ready'    && !isReadyToClose(it))                    return false;
        if (activeFilter === 'unread'   && itemUnread(it) <= 0)                    return false;
        if (activeFilter === 'rel-uat-maybe' && !releaseStages(it).uatMaybe)       return false;
        if (activeFilter === 'rel-uat'  && !releaseStages(it).uat)                 return false;
        if (activeFilter === 'rel-prod' && !releaseStages(it).prod)                return false;
      }
      if (!q) return true;
      const j = it.jiraKey ? jira.get(it.jiraKey) : null;
      const hay = [`#${it.id}`, it.title, it.state, it.assignedTo, it.jiraKey, j?.summary, j?.status]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [items, jira, query, activeFilter, azureStateFilter, aiMatchIds, isReadyToClose, itemUnread, releaseStages]);

  const { roots, childrenOf } = useMemo(() => buildTree(filteredItems), [filteredItems]);

  // With a release pre-filter on, collect the Jira tasks that made the rule fire
  // for the visible items — they get highlighted in the Jira column, so it is
  // obvious *why* a request is in the list. null → no highlighting.
  const releaseHits = useMemo(() => {
    const stage = REL_FILTER_STAGE[activeFilter];
    if (!stage || aiMatchIds) return null;
    const m = new Map();
    for (const it of filteredItems) {
      for (const h of releaseStages(it).hits[stage]) if (!m.has(h.key)) m.set(h.key, h.why);
    }
    return m.size ? m : null;
  }, [filteredItems, activeFilter, aiMatchIds, releaseStages]);

  const isFiltering = !!query.trim() || activeFilter !== 'all' || !!azureStateFilter || !!aiMatchIds;
  const toggleFilter = (f) => setActiveFilter(prev => (prev === f ? 'all' : f));

  // One way back to the unfiltered list, whatever narrowed it (chip, search,
  // Azure status, AI match).
  const clearFilters = useCallback(() => {
    setActiveFilter('all');
    setQuery('');
    setAzureStateFilter('');
    setAiMatchIds(null);
  }, []);

  // ── Export the current view (filtered or full) as a flat table ─────────────
  const exportBaseName = useCallback(() => {
    const board = hasBoards && selectedBoard ? selectedBoard.split(/[\\/]/).pop() : proj?.id || 'status';
    const date = new Date().toISOString().slice(0, 10);
    return `status_${board.replace(/[^\wЀ-ӿ-]+/g, '_')}_${date}`;
  }, [hasBoards, selectedBoard, proj]);

  const exportOptions = useMemo(() => {
    const rows = () => buildExportRows(roots, childrenOf, jira, jiraChildren);
    // A filtered export announces itself in the file name too.
    const filteredSuffix = filteredItems.length !== items.length
      ? `_filtered_${filteredItems.length}-of-${items.length}`
      : '';
    return [
      {
        key: 'csv', label: 'Download CSV', hint: 'link columns for Azure / Jira',
        done: n => `Saved ${n} rows ✓`,
        run: () => {
          const r = rows();
          downloadFile(`${exportBaseName()}${filteredSuffix}.csv`, 'text/csv;charset=utf-8', exportCsv(r));
          return r.length;
        },
      },
      {
        key: 'table', label: 'Copy table', hint: 'paste into Excel / Sheets — ids stay clickable',
        done: n => `Copied ${n} rows ✓`,
        run: async () => {
          const r = rows();
          await copyRichTable(exportHtmlTable(r), exportTsv(r));
          return r.length;
        },
      },
    ];
  }, [roots, childrenOf, jira, jiraChildren, exportBaseName, filteredItems.length, items.length]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  return (
    <div className="app-shell">
      <header className="header">
        <div className="header-logo"><img src={LOGO} alt="Dynamica Labs" /></div>
        <div className="header-sep" />
        <span className="header-title">Status Updates</span>
        <div className="header-spacer" />
        {user && <span className="header-user">{user}</span>}
        <button className="btn btn-ghost" onClick={onLogout} style={{ marginLeft: 12 }}>Sign out</button>
      </header>

      <main className="su-main">
        {/* ── Collapsed rail: just an expand handle ── */}
        {sidebarCollapsed && (
          <aside className="su-sidebar su-sidebar-collapsed">
            <button className="su-collapse-btn" onClick={toggleSidebar} title="Show panel" aria-label="Show panel">
              <ChevronIcon dir="right" />
            </button>
            <span className="su-collapsed-label">Source</span>
          </aside>
        )}

        {/* ── Left: board selection ── */}
        <aside className="su-sidebar" style={sidebarCollapsed ? { display: 'none' } : undefined}>
          <div className="su-side-head">
            <h2 className="su-side-title">Source</h2>
            <button className="su-collapse-btn" onClick={toggleSidebar} title="Collapse panel" aria-label="Collapse panel">
              <ChevronIcon dir="left" />
            </button>
          </div>

          <label className="field-label">Project</label>
          <select
            className="select"
            value={proj?.id ?? ''}
            onChange={e => setProj(projects.find(p => p.id === e.target.value))}
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>

          {hasBoards && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Board</label>
              <select
                className="select"
                value={selectedBoard}
                onChange={e => setSelectedBoard(e.target.value)}
                disabled={boardsLoading || !boards.length}
              >
                <option value="">{boardsLoading ? 'Loading boards…' : '— Select board —'}</option>
                {boards.map(b => <option key={b.path} value={b.path}>{b.name}</option>)}
              </select>
            </>
          )}

          {hasSprints && (
            <>
              <label className="field-label" style={{ marginTop: 16 }}>Sprint</label>
              <select
                className="select"
                value={selectedSprint}
                onChange={e => setSelectedSprint(e.target.value)}
                disabled={sprintsLoading || !iterations.length}
              >
                <option value="">{sprintsLoading ? 'Loading sprints…' : '— All sprints —'}</option>
                {iterations.map(it => (
                  <option key={it.id} value={it.path}>
                    {it.name}{it.attributes?.timeFrame === 'current' ? ' • current' : ''}
                  </option>
                ))}
              </select>
            </>
          )}

          {!hasBoards && !hasSprints && (
            <p className="su-hint">This project has no boards — the whole project will be compared.</p>
          )}

          <button
            className="btn btn-primary su-load-btn"
            onClick={load}
            disabled={loading || (hasBoards && !selectedBoard)}
          >
            {loading
              ? <span className="spinner" style={{ width: 15, height: 15 }} />
              : <RefreshIcon />}
            {loading ? 'Comparing…' : loaded ? 'Refresh' : 'Compare with Jira'}
          </button>

          {loaded && (
            <div className="su-stats">
              {/* Release pre-filters — per-epic STAGE/UAT/PROD task states. */}
              <div className="su-stats-release">
                <span className="su-stats-release-label">Release</span>
                <button
                  className={`su-stat su-stat-uat-maybe su-stat-btn${activeFilter === 'rel-uat-maybe' ? ' active' : ''}`}
                  onClick={() => toggleFilter('rel-uat-maybe')}
                  title={activeFilter === 'rel-uat-maybe'
                    ? 'Click to remove this filter'
                    : 'Epics whose UAT task is in Release Ready / UAT Release Ready — possibly ready for UAT'}
                >
                  <span className="su-stat-num">{stats.relUatMaybe}</span> maybe ready for UAT
                  {activeFilter === 'rel-uat-maybe' && <span className="su-stat-x">✕</span>}
                </button>
                <button
                  className={`su-stat su-stat-uat su-stat-btn${activeFilter === 'rel-uat' ? ' active' : ''}`}
                  onClick={() => toggleFilter('rel-uat')}
                  title={activeFilter === 'rel-uat'
                    ? 'Click to remove this filter'
                    : 'Epics whose STAGE task is Done while the UAT task is not Done yet — next UAT release'}
                >
                  <span className="su-stat-num">{stats.relUat}</span> ready for UAT
                  {activeFilter === 'rel-uat' && <span className="su-stat-x">✕</span>}
                </button>
                <button
                  className={`su-stat su-stat-prod su-stat-btn${activeFilter === 'rel-prod' ? ' active' : ''}`}
                  onClick={() => toggleFilter('rel-prod')}
                  title={activeFilter === 'rel-prod'
                    ? 'Click to remove this filter'
                    : 'Epics whose PROD task is "Approved for Prod" — next PROD release'}
                >
                  <span className="su-stat-num">{stats.relProd}</span> ready for PROD
                  {activeFilter === 'rel-prod' && <span className="su-stat-x">✕</span>}
                </button>
                {releaseHits && (
                  <span className={`su-hl-legend su-hl-${activeFilter}`}>
                    <span className="su-hl-swatch" />
                    {releaseHits.size} highlighted task{releaseHits.size === 1 ? '' : 's'} triggered the rule
                  </span>
                )}
                {activeFilter !== 'all' && (
                  <button className="su-show-all" onClick={clearFilters}>
                    ← Show all {stats.total} items
                  </button>
                )}
              </div>

              <button
                className={`su-stat su-stat-btn${activeFilter === 'all' ? ' active' : ''}`}
                onClick={() => setActiveFilter('all')}
              >
                <span className="su-stat-num">{stats.total}</span> work items
              </button>
              <button
                className={`su-stat su-stat-ok su-stat-btn${activeFilter === 'linked' ? ' active' : ''}`}
                onClick={() => toggleFilter('linked')}
              >
                <span className="su-stat-num">{stats.linked}</span> in Jira
              </button>
              {stats.ready > 0 && (
                <button
                  className={`su-stat su-stat-ready su-stat-btn${activeFilter === 'ready' ? ' active' : ''}`}
                  onClick={() => toggleFilter('ready')}
                  title="Request is In Progress while all its Jira children are Done"
                >
                  <span className="su-stat-num">{stats.ready}</span> ready to close
                </button>
              )}
              {stats.missing > 0 && (
                <button
                  className={`su-stat su-stat-warn su-stat-btn${activeFilter === 'missing' ? ' active' : ''}`}
                  onClick={() => toggleFilter('missing')}
                >
                  <span className="su-stat-num">{stats.missing}</span> key not found
                </button>
              )}
              {stats.unlinked > 0 && (
                <button
                  className={`su-stat su-stat-muted su-stat-btn${activeFilter === 'unlinked' ? ' active' : ''}`}
                  onClick={() => toggleFilter('unlinked')}
                >
                  <span className="su-stat-num">{stats.unlinked}</span> no link
                </button>
              )}
              {commentStats.withComments > 0 && (
                <button
                  className={`su-stat su-stat-comments su-stat-btn${activeFilter === 'unread' ? ' active' : ''}${commentStats.unread > 0 ? ' has-unread' : ''}`}
                  onClick={() => toggleFilter('unread')}
                  title="Items with unread (new) comments"
                >
                  <span className="su-stat-num">{commentStats.unread}</span> new comment{commentStats.unread === 1 ? '' : 's'}
                  <span className="su-stat-sub">of {commentStats.withComments} with comments</span>
                </button>
              )}
              {commentStats.unread > 0 && (
                <button
                  className="su-mark-all-read"
                  onClick={markAllReadNow}
                  disabled={markingAll}
                  title="Mark every current comment as read — new counts start from the next comments"
                >
                  {markingAll
                    ? <><span className="spinner" style={{ width: 12, height: 12 }} /> Marking…</>
                    : '✓ Mark all comments read'}
                </button>
              )}
            </div>
          )}
        </aside>

        {/* ── Right: comparison list ── */}
        <section className="su-results">
          {error && <p className="su-error">⚠ {error}</p>}

          {!loaded && !loading && !error && (
            <div className="su-empty">
              <p className="su-empty-title">Status Updates</p>
              <p className="su-empty-sub">
                Pick a board on the left, then compare its Azure DevOps work items
                with the linked Jira issues — statuses and assignees pulled live from Jira.
              </p>
            </div>
          )}

          {loading && (
            <div className="su-empty"><span className="spinner spinner-lg" /></div>
          )}

          {loaded && !loading && items.length > 0 && (
            <div className="su-toolbar">
              <div className="su-search-wrap">
                <span className="su-search-icon"><SearchIcon /></span>
                <input
                  className="input su-search"
                  placeholder="Search id, key, title, status…"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
                {query && (
                  <button className="su-search-clear" onClick={() => setQuery('')} title="Clear">✕</button>
                )}
              </div>
              {azureStates.length > 0 && (
                <select
                  className="select su-state-filter"
                  value={azureStateFilter}
                  onChange={e => setAzureStateFilter(e.target.value)}
                  title="Filter by Azure DevOps status"
                >
                  <option value="">All statuses</option>
                  {azureStates.map(([s, n]) => (
                    <option key={s} value={s}>{s} ({n})</option>
                  ))}
                </select>
              )}
              <ExportMenu count={filteredItems.length} total={items.length} options={exportOptions} />
              {childrenLoading && (
                <span className="su-children-loading" title="The table is ready — epic/task trees are still loading">
                  <span className="spinner" style={{ width: 12, height: 12 }} /> Loading Jira sub-items…
                </span>
              )}
              {isFiltering && (
                <button
                  className="su-clear-filters"
                  onClick={clearFilters}
                  title="Back to the full list — clears the chip filter, search, status and AI match"
                >
                  <span className="su-result-count">{filteredItems.length} / {items.length}</span>
                  ✕ Show all
                </button>
              )}
            </div>
          )}

          {/* ── AI validation over the loaded data ── */}
          {loaded && !loading && items.length > 0 && (
            <div className="su-ai">
              <div className="su-ai-bar">
                <span className="su-ai-icon">✨</span>
                <input
                  ref={aiInputRef}
                  className="input su-ai-input"
                  placeholder="Ask AI about the data: e.g. “all requests where every epic and task is done”"
                  value={aiQuery}
                  onChange={e => setAiQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && aiQuery.trim() && !aiLoading) { e.preventDefault(); askAi(); } }}
                  disabled={aiLoading}
                />
                <button
                  className="btn btn-primary su-ai-btn"
                  onClick={() => (aiQuery.trim() ? askAi() : aiInputRef.current?.focus())}
                  disabled={aiLoading}
                >
                  {aiLoading ? <span className="spinner" style={{ width: 13, height: 13 }} /> : 'Ask AI'}
                </button>
              </div>

              {aiError && <p className="su-error" style={{ marginTop: 8 }}>⚠ {aiError}</p>}

              {aiAnswer && !aiLoading && (
                <div className="su-ai-answer">
                  <div className="su-ai-answer-head">
                    <span className="su-ai-answer-title">AI answer</span>
                    <div className="su-ai-answer-tools">
                      <button
                        className="su-ai-tool"
                        onClick={() => { navigator.clipboard?.writeText(aiAnswer); setAiCopied(true); setTimeout(() => setAiCopied(false), 1500); }}
                        title="Copy answer"
                      >
                        {aiCopied ? '✓ Copied' : 'Copy'}
                      </button>
                      <button className="su-ai-tool" onClick={() => { setAiAnswer(''); setAiMatchIds(null); }} title="Dismiss answer">
                        ✕
                      </button>
                    </div>
                  </div>

                  <AiAnswer text={aiAnswer} />

                  {aiMatchIds && (
                    <div className="su-ai-match">
                      <span className="su-ai-match-count">
                        Table filtered: {aiMatchIds.size} match{aiMatchIds.size === 1 ? '' : 'es'}
                      </span>
                      <button className="su-ai-tool" onClick={clearAiMatch} title="Show all items">
                        Show all
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {loaded && !loading && items.length === 0 && (
            <div className="su-empty"><p className="su-empty-sub">No work items found for this board.</p></div>
          )}

          {loaded && !loading && items.length > 0 && filteredItems.length === 0 && (
            <div className="su-empty"><p className="su-empty-sub">Nothing matches your search or filter.</p></div>
          )}

          {loaded && !loading && filteredItems.length > 0 && (
            <StatusEditCtx.Provider value={editCtx}>
              <AzureEditCtx.Provider value={azEditCtx}>
              <CommentsCtx.Provider value={commentsCtx}>
              <ReleaseHitsCtx.Provider value={releaseHits}>
                <div className={`su-table${releaseHits ? ` su-hl su-hl-${activeFilter}` : ''}`}>
                  <div className="su-table-head">
                    <span className="su-cell su-head-cell">
                      <span>Azure DevOps</span>
                      <CopyMenu
                        title="Copy Azure data for the visible rows"
                        count={filteredItems.length}
                        options={[
                          { key: 'id',    label: 'IDs (numbers)',   getText: () => collectAzureColumn(filteredItems, 'id') },
                          { key: 'title', label: 'Titles',          getText: () => collectAzureColumn(filteredItems, 'title') },
                          { key: 'both',  label: 'ID — Title',      getText: () => collectAzureColumn(filteredItems, 'both') },
                        ]}
                      />
                    </span>
                    <span className="su-cell su-head-cell">
                      <span>Jira</span>
                      <CopyMenu
                        title="Copy Jira data for the visible rows"
                        count={filteredItems.length}
                        options={[
                          { key: 'key',     label: 'Request keys (ABS-…)',       getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'key') },
                          { key: 'summary', label: 'Summaries',                  getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'summary') },
                          { key: 'both',    label: 'Key — Summary',              getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'both') },
                          { key: 'allkeys', label: 'All keys (with epics/tasks)', getText: () => collectJiraColumn(filteredItems, jira, jiraChildren, 'allkeys') },
                        ]}
                      />
                    </span>
                  </div>
                  <div className="su-table-body">
                    <TreeRows roots={roots} childrenOf={childrenOf} jira={jira} jiraChildren={jiraChildren} />
                  </div>
                </div>
              </ReleaseHitsCtx.Provider>
              </CommentsCtx.Provider>
              </AzureEditCtx.Provider>
            </StatusEditCtx.Provider>
          )}
        </section>
      </main>

      {openComments && (
        <CommentsCtx.Provider value={commentsCtx}>
          <CommentsModal item={openComments} onClose={() => setOpenComments(null)} />
        </CommentsCtx.Provider>
      )}
    </div>
  );
}
