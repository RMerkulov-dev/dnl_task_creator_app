import { lazy } from 'react';

export const APP_REGISTRY = [
  {
    id: 'pm',
    name: 'PM',
    shortName: 'PM',
    gradient: 'linear-gradient(135deg, #5b63fe 0%, #8b5cf6 100%)',
    glow: 'rgba(91, 99, 254, 0.5)',
  },
  {
    id: 'voice',
    name: 'Voice',
    shortName: 'Voice',
    gradient: 'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
    glow: 'rgba(6, 182, 212, 0.5)',
  },
  {
    id: 'fathom-agent',
    name: 'Fathom Agent',
    shortName: 'Fathom',
    gradient: 'linear-gradient(135deg, #ef4444 0%, #f97316 100%)',
    glow: 'rgba(239, 68, 68, 0.5)',
  },
  {
    id: 'email-agent',
    name: 'Email Agent',
    shortName: 'Email',
    gradient: 'linear-gradient(135deg, #10b981 0%, #06b6d4 100%)',
    glow: 'rgba(16, 185, 129, 0.5)',
  },
  {
    // Id stays `project-status`: it is the sidebar key, the lazy-import key and
    // what a returning user has in localStorage — renaming it would only move the
    // churn somewhere invisible. The folder and the `.ps-*` CSS prefix keep the
    // old name for the same reason.
    id: 'project-status',
    name: 'Risks',
    shortName: 'Risks',
    gradient: 'linear-gradient(135deg, #6366f1 0%, #22c55e 100%)',
    glow: 'rgba(99, 102, 241, 0.5)',
    beta: true,
    // Owner-only, because EVERY tab here now reads the PM vault, and that vault is
    // restricted server-side to PM_BRAIN_ALLOWED. It used to open on the Azure
    // "Overview" tab, which any teammate could read — with that tab gone, a
    // teammate would land on nothing but a "PM Brain is private to the vault
    // owner" banner. Mirror of the server gate; keep the two in sync.
    allowedEmails: ['roman.merkulov@dynamicalabs.com'],
  },
  {
    id: 'report',
    name: 'Report',
    shortName: 'Report',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    glow: 'rgba(245, 158, 11, 0.5)',
  },
  {
    id: 'gantt',
    name: 'Gantt',
    shortName: 'Gantt',
    gradient: 'linear-gradient(135deg, #14b8a6 0%, #6366f1 100%)',
    glow: 'rgba(20, 184, 166, 0.5)',
    beta: true,
  },
  {
    id: 'checklist',
    name: 'Checklist',
    shortName: 'Checklist',
    gradient: 'linear-gradient(135deg, #22c55e 0%, #14b8a6 100%)',
    glow: 'rgba(34, 197, 94, 0.5)',
  },
  {
    id: 'quarterly-calls',
    name: 'Quarterly Calls',
    shortName: 'Calls',
    gradient: 'linear-gradient(135deg, #ec4899 0%, #f97316 100%)',
    glow: 'rgba(236, 72, 153, 0.5)',
    // Visible to everyone; editing is restricted server-side (QC_ALLOWED in
    // api/quarterlyCalls.js) and the UI goes view-only for other users.
  },
];

// The "PM" workspace bundles four project-management tools behind a single
// sidebar entry. They switch via a top segmented control and stay mounted so
// each keeps its state when you flip between them. Order matters here.
export const PM_TABS = [
  { id: 'task-creator',   name: 'Tasks' },
  { id: 'status-updates', name: 'Status' },
  { id: 'task-agent',     name: 'Jira Agent' },
  { id: 'jira-ba-agent',  name: 'BA Agent' },
  { id: 'component',      name: 'Component' },
  { id: 'iterations',     name: 'Iterations' },
  { id: 'release',        name: 'Release' },
  { id: 'azure-jira',     name: 'Azure-Jira' },
];

// Returns true when the user is allowed to see/use this app entry.
// Apps without `allowedEmails` are public; otherwise the email must be in the list.
export function isAppAllowedForUser(app, email) {
  if (!app.allowedEmails) return true;
  if (!email) return false;
  return app.allowedEmails.includes(email.toLowerCase());
}

// Lazy-load app components separately so AppRegistry stays JSON-serialisable.
// The four PM tools are still listed here — PmWorkspace renders them by id.
export const APP_COMPONENTS = {
  'pm':            lazy(() => import('./PmWorkspace.jsx')),
  'task-creator':  lazy(() => import('../components/Dashboard.jsx')),
  'voice':         lazy(() => import('../apps/voice/VoiceApp.jsx')),
  'task-agent':    lazy(() => import('../apps/task_agent/TaskAgentApp.jsx')),
  'jira-ba-agent': lazy(() => import('../apps/jira_ba_agent/JiraBaAgentApp.jsx')),
  'component':     lazy(() => import('../apps/jira_component/JiraComponentApp.jsx')),
  'iterations':    lazy(() => import('../apps/iterations/IterationsApp.jsx')),
  'release':       lazy(() => import('../apps/release/ReleaseApp.jsx')),
  'azure-jira':    lazy(() => import('../apps/azure_jira/AzureJiraApp.jsx')),
  'fathom-agent':  lazy(() => import('../apps/fathom_agent/FathomAgentApp.jsx')),
  'email-agent':   lazy(() => import('../apps/email_agent/EmailAgentApp.jsx')),
  'status-updates': lazy(() => import('../apps/status_updates/StatusUpdatesApp.jsx')),
  'project-status': lazy(() => import('../apps/project_status/ProjectStatusApp.jsx')),
  'report':        lazy(() => import('../apps/report/ReportApp.jsx')),
  'gantt':         lazy(() => import('../apps/gantt/GanttApp.jsx')),
  'quarterly-calls': lazy(() => import('../apps/quarterly_calls/QuarterlyCallsApp.jsx')),
  'checklist':     lazy(() => import('../apps/checklist/ChecklistApp.jsx')),
};
