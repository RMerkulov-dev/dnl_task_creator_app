import { lazy } from 'react';

export const APP_REGISTRY = [
  {
    id: 'task-creator',
    name: 'Task Creator',
    shortName: 'Tasks',
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
    id: 'task-agent',
    name: 'Jira Agent',
    shortName: 'Jira Agent',
    gradient: 'linear-gradient(135deg, #2684FF 0%, #0052CC 100%)',
    glow: 'rgba(38, 132, 255, 0.5)',
  },
  {
    id: 'jira-ba-agent',
    name: 'Jira BA Agent',
    shortName: 'BA Agent',
    gradient: 'linear-gradient(135deg, #7c3aed 0%, #5b63fe 100%)',
    glow: 'rgba(124, 58, 237, 0.5)',
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
    id: 'status-updates',
    name: 'Status Updates',
    shortName: 'Status',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #ef4444 100%)',
    glow: 'rgba(245, 158, 11, 0.5)',
  },
];

// Returns true when the user is allowed to see/use this app entry.
// Apps without `allowedEmails` are public; otherwise the email must be in the list.
export function isAppAllowedForUser(app, email) {
  if (!app.allowedEmails) return true;
  if (!email) return false;
  return app.allowedEmails.includes(email.toLowerCase());
}

// Lazy-load app components separately so AppRegistry stays JSON-serialisable
export const APP_COMPONENTS = {
  'task-creator':  lazy(() => import('../components/Dashboard.jsx')),
  'voice':         lazy(() => import('../apps/voice/VoiceApp.jsx')),
  'task-agent':    lazy(() => import('../apps/task_agent/TaskAgentApp.jsx')),
  'jira-ba-agent': lazy(() => import('../apps/jira_ba_agent/JiraBaAgentApp.jsx')),
  'fathom-agent':  lazy(() => import('../apps/fathom_agent/FathomAgentApp.jsx')),
  'email-agent':   lazy(() => import('../apps/email_agent/EmailAgentApp.jsx')),
  'status-updates': lazy(() => import('../apps/status_updates/StatusUpdatesApp.jsx')),
};
