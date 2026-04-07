// ─────────────────────────────────────────────────────────────────────────────
// Project registry
//
// To add a new project:
//   1. Add an entry here
//   2. Add the corresponding AZURE_<KEY>_ORG_URL and AZURE_<KEY>_PAT to .env
//   3. Set feature flags: iteration, story, board
// ─────────────────────────────────────────────────────────────────────────────

export const PROJECTS = {

  // ── HT — Hydrotec ──────────────────────────────────────────────────────────
  HT: {
    id: 'HT',
    label: 'HT — Hydrotec',
    azure: {
      proxyKey:     'ht',                                          // matches server.js route key
      project:      import.meta.env.VITE_AZURE_HT_PROJECT  || 'Hydrotec',
      workItemType: 'Epic',
      jiraIdField:  'Custom.JiraID',                               // Azure field that stores Jira key
    },
    jira: {
      cloudId:              import.meta.env.VITE_JIRA_CLOUD_ID          || 'ede50bd6-614f-4723-b64b-76ef4be362d5',
      projectKey:           import.meta.env.VITE_JIRA_HT_PROJECT_KEY    || 'HTH',
      issueTypeId:          import.meta.env.VITE_JIRA_HT_ISSUE_TYPE_ID  || '10035',
      clientRequestIdField: import.meta.env.VITE_JIRA_HT_CUSTOM_FIELD   || 'customfield_10034',
    },
    features: { iteration: false, story: false, board: false },
  },

  // ── NSMG ───────────────────────────────────────────────────────────────────
  NSMG: {
    id: 'NSMG',
    label: 'NSMG — NSMG',
    azure: {
      proxyKey:     'nsmg',
      project:      import.meta.env.VITE_AZURE_NSMG_PROJECT       || 'NSMG',
      workItemType: 'Task',
      jiraIdField:  import.meta.env.VITE_NSMG_AZURE_JIRA_FIELD    || 'Custom.JiraLink',
    },
    jira: {
      cloudId:              import.meta.env.VITE_JIRA_CLOUD_ID           || 'ede50bd6-614f-4723-b64b-76ef4be362d5',
      projectKey:           import.meta.env.VITE_JIRA_NSMG_PROJECT_KEY   || 'NSMG',
      issueTypeId:          import.meta.env.VITE_JIRA_NSMG_ISSUE_TYPE_ID || '10035',
      clientRequestIdField: import.meta.env.VITE_JIRA_NSMG_CUSTOM_FIELD  || 'customfield_10034',
    },
    // Shows Sprint (Iteration) + Parent Story selectors on the form
    features: { iteration: true, story: true, board: false },
  },

  // ── ABS — Dynamics 365 ─────────────────────────────────────────────────────
  ABS: {
    id: 'ABS',
    label: 'ABS — Dynamics 365',
    azure: {
      proxyKey:     'abs',
      project:      import.meta.env.VITE_AZURE_ABS_PROJECT || 'ABS - Dynamics 365',
      workItemType: 'Epic',
      jiraIdField:  'Custom.JiraID',
    },
    jira: null,
    // Shows Board (Area Path) selector on the form
    features: { iteration: false, story: false, board: true },
  },

};

export const PROJECT_LIST = Object.values(PROJECTS);
