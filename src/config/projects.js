// ─────────────────────────────────────────────────────────────────────────────
// Project configurations
// To add a new project, add an entry to PROJECTS below.
// ─────────────────────────────────────────────────────────────────────────────

export const PROJECTS = {
  HT: {
    id: 'HT',
    name: 'Hydrotec',
    label: 'HT — Hydrotec',
    color: '#3B82F6',
    azure: {
      project: import.meta.env.VITE_AZURE_HT_PROJECT || 'Hydrotec',
      workItemType: 'Epic',
      jiraIdField: 'Custom.JiraID',
    },
    jira: {
      cloudId:
        import.meta.env.VITE_JIRA_CLOUD_ID ||
        'ede50bd6-614f-4723-b64b-76ef4be362d5',
      projectKey: import.meta.env.VITE_JIRA_HT_PROJECT_KEY || 'HTH',
      issueTypeId: import.meta.env.VITE_JIRA_HT_ISSUE_TYPE_ID || '10035',
      clientRequestIdField:
        import.meta.env.VITE_JIRA_HT_CUSTOM_FIELD || 'customfield_10034',
    },
  },
};

export const PROJECT_LIST = Object.values(PROJECTS);
