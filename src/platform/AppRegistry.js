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
    id: 'quarterly-calls',
    name: 'Quarterly Calls',
    shortName: 'Calls',
    gradient: 'linear-gradient(135deg, #ec4899 0%, #f97316 100%)',
    glow: 'rgba(236, 72, 153, 0.5)',
    allowedEmails: ['roman.merkulov@dynamicalabs.com'],
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
  'fathom-agent':  lazy(() => import('../apps/fathom_agent/FathomAgentApp.jsx')),
  'email-agent':   lazy(() => import('../apps/email_agent/EmailAgentApp.jsx')),
  'status-updates': lazy(() => import('../apps/status_updates/StatusUpdatesApp.jsx')),
  'report':        lazy(() => import('../apps/report/ReportApp.jsx')),
  'gantt':         lazy(() => import('../apps/gantt/GanttApp.jsx')),
  'quarterly-calls': lazy(() => import('../apps/quarterly_calls/QuarterlyCallsApp.jsx')),
};
