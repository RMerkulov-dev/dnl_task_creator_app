import express from 'express';
import dotenv from 'dotenv';

dotenv.config();

const app = express();

// ─── Azure org registry ───────────────────────────────────────────────────────
function buildAzureTarget(raw) {
  if (!raw) return '';
  const clean = raw.trim().replace(/[,/\s]+$/, '');
  if (!clean) return '';
  if (clean.includes('dev.azure.com')) return clean;
  if (clean.startsWith('http')) return `https://dev.azure.com/${clean.replace(/^https?:\/\//, '')}`;
  return `https://dev.azure.com/${clean}`;
}

const AZURE_ORGS = {
  ht:   { target: buildAzureTarget(process.env.AZURE_DEVOPS_ORG_URL || process.env.AZURE_DEVOPS_ORG), pat: process.env.AZURE_DEVOPS_PAT },
  nsmg:        { target: buildAzureTarget(process.env.AZURE_NSMG_ORG_URL),        pat: process.env.AZURE_NSMG_PAT },
  nsmg_marker: { target: buildAzureTarget(process.env.AZURE_NSMG_MARKER_ORG_URL), pat: process.env.AZURE_NSMG_MARKER_PAT },
  abs:         { target: buildAzureTarget(process.env.AZURE_ABS_ORG_URL),         pat: process.env.AZURE_ABS_PAT },
};

const jiraEmail = process.env.JIRA_EMAIL      || '';
const jiraToken = process.env.JIRA_API_TOKEN  || '';
const jiraAuth  = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`;

// ─── Generic proxy ────────────────────────────────────────────────────────────
// Читаем сырое тело запроса (чтобы проксировать создание тасков POST/PATCH)
async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyTo(req, res, upstreamUrl, authHeader) {
  const isBody = !['GET', 'HEAD'].includes(req.method);
  const body = isBody ? await readBody(req) : undefined;

  const headers = { 
    'Authorization': authHeader, 
    'Accept': 'application/json' 
  };
  
  if (req.headers['content-type']) {
    headers['Content-Type'] = req.headers['content-type'];
  }

  try {
    // В Node.js 18+ fetch встроен по умолчанию, Vercel его поддерживает
    const upstream = await fetch(upstreamUrl, { 
      method: req.method, 
      headers, 
      body 
    });
    
    const text = await upstream.text();
    
    res.status(upstream.status)
       .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(text);
  } catch (err) {
    console.error(`[Proxy error] ${upstreamUrl}:`, err.message);
    res.status(503).json({ error: err.message });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Azure DevOps proxy
app.use('/api/azure-devops/:key', async (req, res) => {
  const key = req.params.key;
  const org = AZURE_ORGS[key];
  
  if (!org?.target) {
    return res.status(503).json({ error: `Azure org "${key}" is not configured in environment variables.` });
  }

  // Извлекаем точный путь с сохранением %20, используя req.originalUrl
  const prefix = `/api/azure-devops/${key}`;
  const suffix = req.originalUrl.substring(req.originalUrl.indexOf(prefix) + prefix.length);

  const auth = `Basic ${Buffer.from(`:${org.pat || ''}`).toString('base64')}`;
  await proxyTo(req, res, `${org.target}${suffix}`, auth);
});

// Binary Jira attachment download proxy (defined BEFORE the generic /api/jira catch-all)
app.get('/api/jira/attachment-binary/:cloudId/:attachmentId', async (req, res) => {
  const { cloudId, attachmentId } = req.params;
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/attachment/content/${attachmentId}`;
  try {
    const upstream = await fetch(url, {
      headers: { Authorization: jiraAuth, Accept: '*/*' },
      redirect: 'follow',
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Jira attachment fetch failed: ${upstream.status}` });
    }
    const buffer = await upstream.arrayBuffer();
    res
      .status(200)
      .set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream')
      .set('Content-Disposition', upstream.headers.get('content-disposition') || 'attachment')
      .send(Buffer.from(buffer));
  } catch (err) {
    console.error('[Attachment binary proxy error]:', err.message);
    res.status(503).json({ error: err.message });
  }
});

// Jira proxy
app.use('/api/jira', async (req, res) => {
  const prefix = `/api/jira`;
  const suffix = req.originalUrl.substring(req.originalUrl.indexOf(prefix) + prefix.length);

  await proxyTo(req, res, `https://api.atlassian.com${suffix}`, jiraAuth);
});

// Domain vocabulary prompt — helps Whisper recognise PM/DevOps terminology
const BASE_PROMPT =
  'Azure DevOps, Jira, Dynamica Labs, Hydrotec, NSMG, ABS, ' +
  'спринт, беклог, эпик, юзер стори, таска, баг, фикс, ' +
  'дедлайн, релиз, деплой, тестирование, интеграция, ' +
  'требования, функциональность, приоритет, оценка, ревью.';

// Voice transcription (OpenAI Whisper)
app.post('/api/transcribe', async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'OPENAI_API_KEY is not configured on the server.' });
  }

  const language    = req.query.language || '';
  const extraPrompt = req.query.prompt   || '';
  const prompt      = extraPrompt ? `${BASE_PROMPT} ${extraPrompt}` : BASE_PROMPT;
  const contentType = req.headers['content-type'] || 'audio/webm';
  const body        = await readBody(req);

  const formData = new FormData();
  formData.append('file',        new Blob([body], { type: contentType }), 'audio.webm');
  formData.append('model',       'whisper-1');
  formData.append('prompt',      prompt);
  formData.append('temperature', '0');
  if (language) formData.append('language', language);

  try {
    const upstream = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Transcribe error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Jira BA Agent ───────────────────────────────────────────────────────────

const JIRA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_jira',
      description: 'Search Jira issues using JQL. Use to find issues by project, assignee, sprint, status, type, labels, etc.',
      parameters: {
        type: 'object',
        properties: {
          jql:        { type: 'string',  description: 'JQL query, e.g. "project = NSMG AND sprint in openSprints()"' },
          maxResults: { type: 'integer', description: 'Max results to return (default 20, max 50)' },
        },
        required: ['jql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_issue',
      description: 'Get full details of a Jira issue by key (e.g. NSMG-1234)',
      parameters: {
        type: 'object',
        properties: {
          issueKey: { type: 'string', description: 'Jira issue key like NSMG-1234' },
        },
        required: ['issueKey'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_projects',
      description: 'List available Jira projects',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_sprints',
      description: 'List active and future sprints for a Jira project',
      parameters: {
        type: 'object',
        properties: {
          projectKey: { type: 'string', description: 'Jira project key like NSMG, ABS, HTH' },
        },
        required: ['projectKey'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_issue',
      description: 'Create a new Jira issue',
      parameters: {
        type: 'object',
        properties: {
          projectKey:  { type: 'string', description: 'Target project key' },
          summary:     { type: 'string', description: 'Issue title/summary' },
          issueType:   { type: 'string', description: 'Issue type: Story, Task, Bug, Epic, Sub-task' },
          description: { type: 'string', description: 'Plain text description' },
          priority:    { type: 'string', description: 'Highest, High, Medium, Low, Lowest' },
          labels:      { type: 'array', items: { type: 'string' } },
          parentKey:   { type: 'string', description: 'Parent issue key for child issues' },
        },
        required: ['projectKey', 'summary', 'issueType'],
      },
    },
  },
];

async function executeJiraTool(name, args, cloudId) {
  const base      = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
  const agileBase = `https://api.atlassian.com/ex/jira/${cloudId}/rest/agile/1.0`;
  const headers   = { Authorization: jiraAuth, Accept: 'application/json', 'Content-Type': 'application/json' };

  switch (name) {
    case 'search_jira': {
      const max = Math.min(args.maxResults || 20, 50);
      const res = await fetch(`${base}/search/jql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jql:        args.jql,
          maxResults: max,
          fields:     ['summary', 'status', 'assignee', 'priority', 'issuetype', 'parent', 'labels'],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessages?.join(', ') || `Jira error ${res.status}`);
      const issues = data.issues ?? [];
      return {
        returned: issues.length,
        isLast:   data.isLast ?? true,
        issues:   issues.map(i => ({
          key:      i.key,
          summary:  i.fields.summary,
          status:   i.fields.status?.name,
          type:     i.fields.issuetype?.name,
          assignee: i.fields.assignee?.displayName ?? 'Unassigned',
          priority: i.fields.priority?.name,
          parent:   i.fields.parent?.key ?? null,
        })),
      };
    }

    case 'get_issue': {
      const res  = await fetch(`${base}/issue/${encodeURIComponent(args.issueKey)}`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.errorMessages?.join(', ') || `${args.issueKey} not found`);
      const f = data.fields;
      function adfText(node) {
        if (!node) return '';
        if (node.type === 'text') return node.text || '';
        return (node.content ?? []).map(adfText).join('');
      }
      return {
        key:         data.key,
        summary:     f.summary,
        status:      f.status?.name,
        type:        f.issuetype?.name,
        assignee:    f.assignee?.displayName ?? 'Unassigned',
        priority:    f.priority?.name,
        labels:      f.labels ?? [],
        parent:      f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary } : null,
        description: adfText(f.description).substring(0, 800),
        created:     f.created,
        updated:     f.updated,
        url:         `https://dynamicalabs.atlassian.net/browse/${data.key}`,
      };
    }

    case 'list_projects': {
      const res  = await fetch(`${base}/project/search?maxResults=50&orderBy=name`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to list projects');
      return { projects: (data.values ?? []).map(p => ({ key: p.key, name: p.name })) };
    }

    case 'list_sprints': {
      const boardsRes  = await fetch(`${agileBase}/board?projectKeyOrId=${encodeURIComponent(args.projectKey)}&maxResults=5`, { headers });
      const boardsData = await boardsRes.json();
      if (!boardsData.values?.length) return { sprints: [] };
      const boardId    = boardsData.values[0].id;
      const sprintsRes  = await fetch(`${agileBase}/board/${boardId}/sprint?state=active,future&maxResults=20`, { headers });
      const sprintsData = await sprintsRes.json();
      return {
        sprints: (sprintsData.values ?? []).map(s => ({
          id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate,
        })),
      };
    }

    case 'create_issue': {
      const fields = {
        project:   { key: args.projectKey },
        summary:   args.summary,
        issuetype: { name: args.issueType },
      };
      if (args.description) fields.description = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description }] }] };
      if (args.priority)    fields.priority = { name: args.priority };
      if (args.labels?.length) fields.labels = args.labels;
      if (args.parentKey)   fields.parent = { key: args.parentKey };

      const res  = await fetch(`${base}/issue`, { method: 'POST', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (!res.ok) throw new Error(Object.values(data.errors ?? {}).join(', ') || data.errorMessages?.join(', ') || 'Create failed');
      return { key: data.key, url: `https://dynamicalabs.atlassian.net/browse/${data.key}` };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

app.post('/api/ba-agent', express.json({ limit: '50kb' }), async (req, res) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENAI_API_KEY not configured' });

  const { message, history = [], cloudId, userEmail } = req.body ?? {};
  if (!message) return res.status(400).json({ error: 'message is required' });

  const userCtx = userEmail
    ? `The current user's email in Jira is "${userEmail}". When the user says "me", "my tasks", "assigned to me" — use this email directly in JQL (e.g. assignee = "${userEmail}"). Never ask the user to provide their email or username.`
    : '';

  const systemPrompt =
    'You are a Jira Business Analyst assistant for Dynamica Labs. ' +
    'Help users query and manage Jira: find issues, check sprints, create tasks, summarise epics. ' +
    'Always use tools to retrieve live data — never invent issue keys or counts. ' +
    'Respond in the same language the user writes in (Russian, Ukrainian, or English). ' +
    'Format responses clearly: use bullet lists or numbered lists for multiple issues. ' +
    userCtx;

  const msgs = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-20),
    { role: 'user', content: message },
  ];

  const toolResults = [];

  try {
    for (let i = 0; i < 6; i++) {
      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: msgs, tools: JIRA_TOOLS, tool_choice: 'auto', temperature: 0.3, max_tokens: 2000 }),
      });
      const data = await upstream.json();
      if (!upstream.ok) throw new Error(data.error?.message || `OpenAI error ${upstream.status}`);

      const choice = data.choices[0];
      msgs.push(choice.message);

      if (choice.finish_reason !== 'tool_calls') {
        return res.json({ reply: choice.message.content, toolResults });
      }

      for (const tc of choice.message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(tc.function.arguments);
          result = await executeJiraTool(tc.function.name, args, cloudId);
          toolResults.push({ name: tc.function.name, args, result });
        } catch (err) {
          result = { error: err.message };
          toolResults.push({ name: tc.function.name, error: err.message });
        }
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
    }
    res.json({ reply: 'Превышен лимит шагов. Попробуйте переформулировать запрос.', toolResults });
  } catch (err) {
    console.error('[BA Agent error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    azure: Object.fromEntries(Object.entries(AZURE_ORGS).map(([k, v]) => [k, { target: v.target || null, hasPat: !!v.pat }])),
    jira: { hasToken: !!jiraToken }
  });
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`[Server] Running locally on http://localhost:${PORT}`);
  });
}

// Обязательно экспортируем app для бессерверной среды Vercel
export default app;