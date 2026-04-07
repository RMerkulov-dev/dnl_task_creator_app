// Debug endpoint — visit /api/health in the browser to verify env vars are set
export default function handler(req, res) {
  const vars = {
    AZURE_DEVOPS_ORG_URL:  process.env.AZURE_DEVOPS_ORG_URL  ? '✓ set' : '✗ missing',
    AZURE_DEVOPS_PAT:      process.env.AZURE_DEVOPS_PAT      ? '✓ set' : '✗ missing',
    AZURE_NSMG_ORG_URL:   process.env.AZURE_NSMG_ORG_URL    ? '✓ set' : '✗ missing',
    AZURE_NSMG_PAT:        process.env.AZURE_NSMG_PAT        ? '✓ set' : '✗ missing',
    AZURE_ABS_ORG_URL:    process.env.AZURE_ABS_ORG_URL      ? '✓ set' : '✗ missing',
    AZURE_ABS_PAT:         process.env.AZURE_ABS_PAT         ? '✓ set' : '✗ missing',
    JIRA_EMAIL:            process.env.JIRA_EMAIL            ? '✓ set' : '✗ missing',
    JIRA_API_TOKEN:        process.env.JIRA_API_TOKEN        ? '✓ set' : '✗ missing',
  };
  res.status(200).json({ ok: true, env: vars });
}
