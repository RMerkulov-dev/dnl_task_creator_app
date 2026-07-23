import express from 'express';
import dotenv  from 'dotenv';
import crypto  from 'node:crypto';
import fs      from 'node:fs';
import { FOLLOWUP_SKILLS, listFollowupSkills } from './followupSkills.js';
import { registerTaskNotifyRoutes } from './taskNotify.js';
import { registerQuarterlyCallsRoutes, checkQuarterlyCallReminders } from './quarterlyCalls.js';

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
  nsmgcm:      { target: buildAzureTarget(process.env.AZURE_NSMG_ORG_URL),        pat: process.env.AZURE_NSMG_PAT },
  nsmg_marker: { target: buildAzureTarget(process.env.AZURE_NSMG_MARKER_ORG_URL), pat: process.env.AZURE_NSMG_MARKER_PAT },
  abs:         { target: buildAzureTarget(process.env.AZURE_ABS_ORG_URL),         pat: process.env.AZURE_ABS_PAT },
};

const jiraEmail = process.env.JIRA_EMAIL      || '';
const jiraToken = process.env.JIRA_API_TOKEN  || '';
const jiraAuth  = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`;

// ─── App authentication ───────────────────────────────────────────────────────
// The SPA "login" used to be a client-side password check, which left every
// /api route (including the raw Jira/Azure proxies with admin credentials)
// open to anyone who knew the deploy URL. Now /api/login validates credentials
// server-side and issues an HMAC-signed bearer token; the middleware below
// requires it on every /api route except login itself and the Fathom OAuth
// handshake (a popup redirect chain that cannot carry headers).
const APP_PASSWORD   = (process.env.APP_PASSWORD || process.env.VITE_APP_PASSWORD || '').trim();
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || process.env.VITE_ALLOWED_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const AUTH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
// Prefer an explicit secret; otherwise derive a stable one from existing
// long-lived secrets (same pattern as FATHOM_OAUTH_STATE_SECRET below).
const AUTH_TOKEN_SECRET = process.env.AUTH_TOKEN_SECRET
  ? Buffer.from(process.env.AUTH_TOKEN_SECRET)
  : crypto.createHash('sha256')
      .update(APP_PASSWORD || 'dev-app-auth')
      .update(jiraToken)
      .update(':app-auth-token')
      .digest();

function signAuthToken(email) {
  const body = b64url(JSON.stringify({ e: email, x: Date.now() + AUTH_TOKEN_TTL_MS }));
  const sig  = b64url(crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(body).digest());
  return `${body}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', AUTH_TOKEN_SECRET).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (!payload.e || !payload.x || Date.now() > payload.x) return null;
    return payload;
  } catch { return null; }
}

// quarterly-calls/cron is called by Vercel Cron with its own
// `Authorization: Bearer $CRON_SECRET` header — the route verifies that itself.
const AUTH_EXEMPT = [/^\/api\/login$/, /^\/api\/fathom\/oauth\//, /^\/api\/quarterly-calls\/cron$/];

app.use('/api', (req, res, next) => {
  const path = (req.originalUrl || '').split('?')[0];
  if (AUTH_EXEMPT.some(re => re.test(path))) return next();
  if (!APP_PASSWORD) {
    // Fail closed: an unset password must not silently reopen the API.
    return res.status(503).json({ error: 'Server auth is not configured — set APP_PASSWORD (or VITE_APP_PASSWORD) in the environment.' });
  }
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  const payload = m ? verifyAuthToken(m[1]) : null;
  if (!payload) {
    // X-Auth-Required lets the SPA distinguish "app session invalid" from
    // domain-level 401s (e.g. Fathom's reconnect flow) and force a re-login.
    return res.status(401).set('X-Auth-Required', '1').json({ error: 'Not authenticated. Please sign in again.' });
  }
  req.authEmail = payload.e;
  next();
});

// Best-effort brute-force throttle. In-memory, so per serverless instance —
// not bulletproof, but it turns an online guessing attack from free to slow.
const loginFailures = new Map(); // ip -> { count, resetAt }
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS    = 15 * 60_000;

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress || 'unknown';
}

app.post('/api/login', express.json({ limit: '2kb' }), (req, res) => {
  if (!APP_PASSWORD) {
    return res.status(503).json({ error: 'Server auth is not configured — set APP_PASSWORD in the environment.' });
  }
  const ip  = clientIp(req);
  const rec = loginFailures.get(ip);
  if (rec && Date.now() < rec.resetAt && rec.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const email    = String(req.body?.email    || '').trim().toLowerCase();
  const password = String(req.body?.password || '').trim();
  const fail = (code, msg) => {
    if (!rec || Date.now() > rec.resetAt) loginFailures.set(ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    else rec.count++;
    return res.status(401).json({ error: msg, code });
  };

  if (!ALLOWED_EMAILS.includes(email))  return fail('email',    'This email is not authorized to access the app.');
  if (password !== APP_PASSWORD)        return fail('password', 'Incorrect password.');

  loginFailures.delete(ip);
  res.json({ token: signAuthToken(email), email, expiresAt: Date.now() + AUTH_TOKEN_TTL_MS });
});

// ─── Task-created email notifications ────────────────────────────────────────
// Registered after the auth middleware above, so the route is protected.
registerTaskNotifyRoutes(app);

// ─── Quarterly Calls (private calendar + reminders) ──────────────────────────
registerQuarterlyCallsRoutes(app);

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

// `fetch failed` and similar undici errors are transient (DNS hiccup, TCP reset).
// Retry once before bubbling up; map to a human message for the chat UI.
function isTransientFetchError(err) {
  const m = err?.message || '';
  return m === 'fetch failed' || /ECONN(REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(m + (err?.cause?.code || ''));
}

function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Every upstream call goes through here so it gets a hard timeout (a hung
// Jira/OpenRouter connection must not pin the serverless function until the
// platform kills it) and transient network errors are retried — but ONLY for
// requests that are safe to repeat. A POST that creates a Jira issue must never
// be retried blindly: the first attempt may have landed even though the
// response was lost, and a retry would create a duplicate. Callers whose POSTs
// are side-effect-free (LLM calls, JQL search, read-only MCP tools) opt in via
// `retryNonIdempotent`.
async function fetchWithRetry(url, init = {}, { attempts = 2, retryNonIdempotent = false, timeoutMs = 30_000 } = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const max = (retryNonIdempotent || IDEMPOTENT_METHODS.has(method)) ? attempts : 1;
  let lastErr;
  for (let i = 0; i < max; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...init });
    } catch (err) {
      lastErr = err;
      if (!isTransientFetchError(err) || i === max - 1) throw err;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

function humaniseFetchError(err) {
  if (isTimeoutError(err)) {
    return 'The external service took too long to respond. Please try again.';
  }
  if (isTransientFetchError(err)) {
    return 'Could not reach external service (Jira / OpenRouter). Check your network and try again.';
  }
  return err.message;
}

// ─── OpenRouter (DeepSeek V4 Pro planner + V4 Flash executor) ────────────────

const OPENROUTER_URL      = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_PLANNER  = process.env.OPENROUTER_PLANNER_MODEL  || 'deepseek/deepseek-v4-pro';
const OPENROUTER_EXECUTOR = process.env.OPENROUTER_EXECUTOR_MODEL || 'deepseek/deepseek-v4-flash';
const OPENROUTER_REFERER  = process.env.OPENROUTER_REFERER        || 'https://task-creator.dynamicalabs.com';
const OPENROUTER_TITLE    = 'Dynamica Task Creator';

function openRouterHeaders(apiKey) {
  return {
    Authorization:  `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': OPENROUTER_REFERER,
    'X-Title':      OPENROUTER_TITLE,
  };
}

async function callOpenRouter(apiKey, body) {
  // Chat completions have no server-side side effects, so retrying a failed
  // POST is safe; reasoning models can take a while, hence the long timeout.
  const upstream = await fetchWithRetry(OPENROUTER_URL, {
    method:  'POST',
    headers: openRouterHeaders(apiKey),
    body:    JSON.stringify(body),
  }, { retryNonIdempotent: true, timeoutMs: 120_000 });
  const data = await upstream.json();
  if (!upstream.ok) throw new Error(data.error?.message || `OpenRouter error ${upstream.status}`);
  return data;
}

// V4 Flash / V4 Pro are reasoning models — when the budget is tight or the
// model never breaks out of the reasoning phase, `content` comes back null and
// the actual answer is in `reasoning`. Always prefer content; fall back so the
// caller never gets an empty string.
function extractReply(message) {
  return (message?.content || message?.reasoning || '').trim();
}

// Compact human-readable description of available tools (for the planner only).
function summariseTools(tools) {
  return tools.map(t => {
    const props = Object.entries(t.function.parameters?.properties || {})
      .map(([k, v]) => `${k}:${v.type || 'any'}`)
      .join(', ');
    return `- ${t.function.name}(${props}) — ${t.function.description}`;
  }).join('\n');
}

// Ask V4 Pro for a structured plan. The plan is shown to the user for
// approval/edits before any tool is called. Returns one of three modes:
//   - "plan":    a numbered execution plan the user can approve or revise
//   - "clarify": the planner needs the user to choose between options first
//   - "direct":  trivial request, no confirmation needed; executor runs immediately
async function buildPlan(apiKey, { domain, systemPrompt, tools, history, message }) {
  const plannerSystem =
    `You are a planning model for a ${domain} agent. The plan you produce is SHOWN TO THE USER for approval before any work runs. ` +
    'It must read like a clear, friendly summary of what you intend to do — not like a technical script.\n\n' +
    'Decide between three response modes:\n' +
    '1) "plan" — Write a step-by-step plan a non-technical user can read in a few seconds. RULES:\n' +
    '   • ALWAYS write the plan in ENGLISH, no matter what language the user used.\n' +
    '   • 2 to 5 steps. Each step on its own line, prefixed with "1.", "2.", … (a number, a period, a space).\n' +
    '   • Start each step with a short bold title using **markdown**, then a dash, then one human sentence describing it. ' +
    'Example: "1. **Find the meeting** — locate the most recent call with Ion about the Vendor Report."\n' +
    '   • Describe WHAT you will do and WHERE you will look in plain English (e.g. "in your Fathom meetings from the last 14 days", "across all known Jira projects"). ' +
    'NEVER mention internal function names, tool names, API endpoints, JQL strings, or parameter names. ' +
    'Say "search your meetings" instead of "call search_meetings(query=…)". Say "look in the NSMG project" instead of "project = NSMG".\n' +
    '   • Do not include preamble, conclusion, or commentary — just the numbered steps.\n' +
    '2) "clarify" — Use ONLY when information needed to plan is genuinely missing AND would change what you do (e.g. user mentions a feature without saying which project, or "my tasks" without any time scope). ' +
    'Provide 2-4 mutually exclusive options. The question and option labels MUST be in ENGLISH.\n' +
    '3) "direct" — Use ONLY for greetings, thanks, acknowledgements, or trivial questions that need no work at all.\n\n' +
    'OUTPUT FORMAT — respond with VALID JSON, ONLY the object, no markdown fences, no prose around it:\n' +
    '{\n' +
    '  "mode": "plan" | "clarify" | "direct",\n' +
    '  "plan": "1. **Title** — sentence.\\n2. **Title** — sentence." (when mode=plan, else empty string),\n' +
    '  "question": "…" (when mode=clarify, else empty string),\n' +
    '  "options": [{"label":"…","description":"…"}, …] (when mode=clarify, else empty array)\n' +
    '}\n\n' +
    `=== AGENT INSTRUCTIONS (for your reference; do NOT quote them in the plan) ===\n${systemPrompt}\n\n` +
    `=== CAPABILITIES YOU HAVE (for your reference; describe them in plain English in the plan, never by name) ===\n${tools && tools.length ? summariseTools(tools) : '(no tools — produce a writing plan: outline format, tone, structure)'}`;

  const data = await callOpenRouter(apiKey, {
    model:           OPENROUTER_PLANNER,
    messages: [
      { role: 'system', content: plannerSystem },
      ...history.slice(-10),
      { role: 'user',   content: message },
    ],
    response_format: { type: 'json_object' },
    temperature:     0.2,
    // V4 Pro reasons before emitting content. Keep budget generous so the
    // JSON object isn't truncated mid-output.
    max_tokens:      4000,
  });

  const raw = extractReply(data.choices?.[0]?.message);
  // The model usually emits clean JSON when response_format is set, but be
  // defensive: strip stray markdown fences and fall back to treating the
  // whole reply as a plan if JSON.parse fails.
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    const mode = ['plan', 'clarify', 'direct'].includes(parsed.mode) ? parsed.mode : 'plan';
    return {
      mode,
      plan:     typeof parsed.plan === 'string' ? parsed.plan.trim() : '',
      question: typeof parsed.question === 'string' ? parsed.question.trim() : '',
      options:  Array.isArray(parsed.options)
        ? parsed.options.filter(o => o && typeof o.label === 'string').slice(0, 4)
        : [],
    };
  } catch {
    return { mode: 'plan', plan: cleaned || raw, question: '', options: [] };
  }
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
  // Jira's attachment endpoint rejects uploads (403 XSRF) unless this header is
  // present. The client sets it; forward it through the proxy unchanged.
  if (req.headers['x-atlassian-token']) {
    headers['X-Atlassian-Token'] = req.headers['x-atlassian-token'];
  }

  try {
    // В Node.js 18+ fetch встроен по умолчанию, Vercel его поддерживает
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      body,
      signal: AbortSignal.timeout(30_000),
    });
    
    const text = await upstream.text();
    
    res.status(upstream.status)
       .set('Content-Type', upstream.headers.get('content-type') || 'application/json')
       .send(text);
  } catch (err) {
    // Transient network failures (offline org, DNS hiccup) get a quieter log —
    // they're expected when an Azure org is unreachable and only the client UI
    // needs to know via the 503.
    const quiet = isTransientFetchError(err);
    if (quiet) console.warn(`[Proxy unreachable] ${upstreamUrl}`);
    else       console.error(`[Proxy error] ${upstreamUrl}:`, err.message);
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
      signal: AbortSignal.timeout(60_000),
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

// Resolve an issue attachment's Atlassian Media Services file UUID (needed to
// embed it inline in a description as an ADF `media` node — the REST attachment
// id is NOT accepted there). The attachment content endpoint 30x-redirects to
// api.media.atlassian.com/file/<uuid>/binary; we read the UUID off that
// Location header server-side (the browser can't read cross-origin redirects).
// Defined BEFORE the generic /api/jira catch-all.
app.get('/api/jira/attachment-media-id/:cloudId/:attachmentId', async (req, res) => {
  const { cloudId, attachmentId } = req.params;
  const url = `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/attachment/content/${attachmentId}`;
  try {
    const upstream = await fetch(url, { headers: { Authorization: jiraAuth }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    const loc = upstream.headers.get('location') || '';
    const mediaId = loc.match(/\/file\/([0-9a-f-]+)\//)?.[1] || null;
    if (!mediaId) {
      return res.status(502).json({ error: `Could not resolve media id (upstream ${upstream.status})` });
    }
    res.json({ mediaId });
  } catch (err) {
    console.error('[Attachment media-id proxy error]:', err.message);
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

// Voice transcription (Groq Whisper — OpenAI-compatible endpoint)
app.post('/api/transcribe', async (req, res) => {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  const language    = req.query.language || '';
  const extraPrompt = req.query.prompt   || '';
  const prompt      = extraPrompt ? `${BASE_PROMPT} ${extraPrompt}` : BASE_PROMPT;
  const contentType = req.headers['content-type'] || 'audio/webm';
  const body        = await readBody(req);

  const formData = new FormData();
  formData.append('file',        new Blob([body], { type: contentType }), 'audio.webm');
  formData.append('model',       'whisper-large-v3-turbo');
  formData.append('prompt',      prompt);
  formData.append('temperature', '0');
  formData.append('response_format', 'json');
  if (language) formData.append('language', language);

  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: AbortSignal.timeout(120_000),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    console.error('[Transcribe error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Jira BA Agent ───────────────────────────────────────────────────────────

// Shared "ask the user" tool used by both Jira and Fathom agents.
// When the LLM emits this, the request handler short-circuits and returns
// a clarification payload that the UI renders as clickable options.
const ASK_USER_TOOL = {
  type: 'function',
  function: {
    name: 'ask_user',
    description:
      'Ask the user a clarifying question with 2–4 mutually exclusive options. ' +
      'Use ONLY when the request is genuinely ambiguous and the answer will significantly change which tools/parameters you call next (e.g. which project, which date range, summary vs transcript). ' +
      'Do NOT use for trivia, formatting preferences, or anything you can infer from context or solve by trying a sensible default first. ' +
      'Phrase the question in the same language the user wrote in. Call ask_user alone — never combine with other tool calls in the same turn.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The clarifying question to display to the user' },
        options:  {
          type: 'array',
          description: '2–4 distinct, mutually exclusive options. Keep labels short (1–5 words).',
          items: {
            type: 'object',
            properties: {
              label:       { type: 'string', description: 'The visible choice (short, imperative or noun)' },
              description: { type: 'string', description: 'Optional one-line explanation of what this option means' },
            },
            required: ['label'],
          },
          minItems: 2,
          maxItems: 4,
        },
        multiSelect: { type: 'boolean', description: 'Allow multiple options to be selected (default false)' },
      },
      required: ['question', 'options'],
    },
  },
};

// Chat history arrives from the browser and is spliced straight into the LLM
// prompt. Never trust roles from the client: a crafted request could inject
// `system` messages and override the agent's instructions, or `tool` messages
// to fake tool results. Only plain user/assistant text survives.
function sanitizeHistory(history, max = 20) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-max)
    .map(m => ({ role: m.role, content: m.content.slice(0, 20_000) }));
}

function findAskUserCall(toolCalls) {
  return (toolCalls || []).find(tc => tc.function?.name === 'ask_user');
}

function buildClarificationFromCall(tc) {
  try {
    const args = JSON.parse(tc.function.arguments || '{}');
    if (!args.question || !Array.isArray(args.options) || args.options.length < 2) return null;
    return {
      question:    args.question,
      options:     args.options.filter(o => o && o.label).slice(0, 4),
      multiSelect: !!args.multiSelect,
    };
  } catch {
    return null;
  }
}

const JIRA_TOOLS = [
  ASK_USER_TOOL,
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
      // POST, but read-only (JQL search) — safe to retry.
      const res = await fetchWithRetry(`${base}/search/jql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jql:        args.jql,
          maxResults: max,
          fields:     ['summary', 'status', 'assignee', 'priority', 'issuetype', 'parent', 'labels'],
        }),
      }, { retryNonIdempotent: true });
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
      const res  = await fetchWithRetry(`${base}/issue/${encodeURIComponent(args.issueKey)}`, { headers });
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
      const res  = await fetchWithRetry(`${base}/project/search?maxResults=50&orderBy=name`, { headers });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to list projects');
      return { projects: (data.values ?? []).map(p => ({ key: p.key, name: p.name })) };
    }

    case 'list_sprints': {
      const boardsRes  = await fetchWithRetry(`${agileBase}/board?projectKeyOrId=${encodeURIComponent(args.projectKey)}&maxResults=5`, { headers });
      const boardsData = await boardsRes.json();
      if (!boardsData.values?.length) return { sprints: [] };
      const boardId    = boardsData.values[0].id;
      const sprintsRes  = await fetchWithRetry(`${agileBase}/board/${boardId}/sprint?state=active,future&maxResults=20`, { headers });
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

      const res  = await fetchWithRetry(`${base}/issue`, { method: 'POST', headers, body: JSON.stringify({ fields }) });
      const data = await res.json();
      if (!res.ok) throw new Error(Object.values(data.errors ?? {}).join(', ') || data.errorMessages?.join(', ') || 'Create failed');
      return { key: data.key, url: `https://dynamicalabs.atlassian.net/browse/${data.key}` };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

app.post('/api/ba-agent', express.json({ limit: '50kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { message, cloudId, userEmail, confirmedPlan } = req.body ?? {};
  const history = sanitizeHistory(req.body?.history);
  if (!message) return res.status(400).json({ error: 'message is required' });

  const userCtx = userEmail
    ? `The current user's email in Jira is "${userEmail}". When the user says "me", "my tasks", "assigned to me" — use this email directly in JQL (e.g. assignee = "${userEmail}"). Never ask the user to provide their email or username.`
    : '';

  const systemPrompt =
    'You are a Jira Business Analyst assistant for Dynamica Labs. ' +
    'Help users query and manage Jira: find issues, check sprints, create tasks, summarise epics. ' +
    'Always use tools to retrieve live data — never invent issue keys or counts. ' +
    'Known Jira project keys: ABS, ABSPO, NSMG, NSMGM, HTH. These are the ONLY valid values for `project = ...` in JQL. ' +
    `Today is ${new Date().toISOString()}. ` +
    'Before doing real work, call ask_user when the request is genuinely ambiguous AND the answer changes which tools/parameters you would call. ' +
    'Good triggers: ' +
    '— user mentions a feature/module name without saying the project (offer ABS / NSMG / NSMGM / HTH / "search across all"); ' +
    '— "show me my tasks" without time range (offer "current sprint" / "last 7 days" / "all open"); ' +
    '— "what\'s the status of X" when X matches multiple issues (offer the top candidates); ' +
    '— creating an issue with under-specified fields (offer common defaults). ' +
    'Bad triggers: trivial follow-ups, formatting preferences, things you can solve by trying a sensible default first, anything inferrable from prior turns. Never ask more than one clarifying question in a row. ' +
    'JQL construction rules: ' +
    '(A) Use `project = KEY` ONLY when the user names a known project key (case-insensitive match against the list above) or its obvious nickname (e.g. "Hydrotec" → HTH, "Marker" → NSMGM). ' +
    '(B) If the user mentions any other term (a feature, module, component, epic name, e.g. "Comission module", "Seminar Registration", "Payment flow") — do NOT put it after `project = `. Instead, search across projects with `text ~ "term"` (covers summary, description, comments). ' +
    '(C) For date filters use absolute JQL like `created >= "2026-04-29"` or relative `created >= -14d`. ' +
    '(D) When search_jira returns 0, you MUST retry at least once with a broadened query before reporting "none found": drop the project filter, switch to `text ~ "..."`, try `labels = "..."` or `component = "..."`, or use OR across alternate spellings. Only after a broadened retry also returns 0 may you tell the user nothing was found. ' +
    '(E) If you are unsure what project a feature belongs to, call list_projects first. ' +
    'Respond in the same language the user writes in (Russian, Ukrainian, or English). ' +
    'Output rules: ' +
    '(1) When search_jira or multiple get_issue calls return 2 or more issues, the UI auto-renders them as a structured table — do NOT repeat each issue\'s fields in prose. Just give a one-line intro ("Here are 12 matching issues:") and add a brief insight/aggregate if useful (e.g. "8 of them are In Progress, all assigned to Dima"). ' +
    '(2) For a single issue, you may describe it in detail. ' +
    '(3) Use bullets only for items that are NOT issues (e.g. sprints, projects). ' +
    userCtx;

  const toolResults = [];

  try {
    // ── STAGE 1: produce a plan unless the user has already confirmed one ──
    let plan = '';
    if (confirmedPlan) {
      plan = String(confirmedPlan).trim();
    } else {
      const planResult = await buildPlan(apiKey, {
        domain:       'Jira Business Analyst',
        systemPrompt,
        tools:        JIRA_TOOLS,
        history,
        message,
      });

      if (planResult.mode === 'clarify' && planResult.question && planResult.options.length >= 2) {
        return res.json({
          stage:         'clarify',
          reply:         planResult.question,
          clarification: { question: planResult.question, options: planResult.options },
          toolResults:   [],
        });
      }

      if (planResult.mode === 'plan' && planResult.plan) {
        return res.json({
          stage:                'plan',
          plan:                 planResult.plan,
          awaitingConfirmation: true,
          toolResults:          [],
        });
      }

      // mode === 'direct' or empty plan → run executor without a plan notice
      plan = '';
    }

    // ── STAGE 2: execute with the (confirmed) plan injected as guidance ──
    const planNotice = plan
      ? `=== EXECUTION PLAN (approved by user) ===\n${plan}\n=== END PLAN ===\nFollow this plan. If a tool result shows the plan is wrong, adapt and explain in the reply. Your reply to the user must be in the user's language.`
      : '';

    const msgs = [
      { role: 'system', content: systemPrompt },
      ...(planNotice ? [{ role: 'system', content: planNotice }] : []),
      ...history.slice(-20),
      { role: 'user', content: message },
    ];

    for (let i = 0; i < 6; i++) {
      const data = await callOpenRouter(apiKey, {
        model:       OPENROUTER_EXECUTOR,
        messages:    msgs,
        tools:       JIRA_TOOLS,
        tool_choice: 'auto',
        temperature: 0.3,
        // V4 Flash spends tokens on reasoning before producing content/tool_calls.
        // Be generous so a final answer isn't truncated mid-thought.
        max_tokens:  4000,
      });

      const choice = data.choices[0];
      msgs.push(choice.message);

      if (choice.finish_reason !== 'tool_calls') {
        const reply = extractReply(choice.message)
          || 'The model returned an empty response. Below is the data we managed to retrieve.';
        return res.json({ stage: 'done', reply, toolResults });
      }

      const askCall = findAskUserCall(choice.message.tool_calls);
      if (askCall) {
        const clarification = buildClarificationFromCall(askCall);
        return res.json({
          stage:         'clarify',
          reply:         clarification?.question || 'Please clarify what exactly you need.',
          clarification,
          toolResults,
        });
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
    res.json({ stage: 'done', reply: 'Step limit reached. Try rephrasing your request.', toolResults });
  } catch (err) {
    console.error('[BA Agent error]', err.message);
    // Return any tool results we managed to collect before the failure, so the
    // UI can still show the work that was done.
    res.status(500).json({ error: humaniseFetchError(err), toolResults });
  }
});

// ─── Fathom Agent (via Fathom MCP server) ────────────────────────────────────
//
// We talk to Fathom through their official MCP server at https://api.fathom.ai/mcp
// (Streamable HTTP transport, OAuth 2.1 Bearer). Every signed-in user goes
// through their OWN OAuth handshake: the frontend opens /api/fathom/oauth/start
// in a popup, that walks them through Fathom's consent screen, and we send the
// resulting access_token back to the popup opener via window.postMessage. The
// frontend stores it in localStorage and includes it in every /api/fathom-agent
// call. On 401 from MCP, the agent returns reconnect:true so the UI can wipe
// the token and re-open the popup.
//
// Tools are discovered from the MCP server at runtime and cached at module
// scope (the catalogue is the same for all users; only the bearer differs).

const FATHOM_MCP_URL         = process.env.FATHOM_MCP_URL || 'https://api.fathom.ai/mcp';
const FATHOM_OAUTH_AUTHORIZE = 'https://fathom.video/mcp/oauth/authorize';
const FATHOM_OAUTH_TOKEN_URL = 'https://api.fathom.ai/mcp/oauth/token';
const FATHOM_OAUTH_REGISTER  = 'https://api.fathom.ai/mcp/oauth/register';
const MCP_PROTOCOL_VER       = '2025-06-18';

// HMAC secret used to sign the OAuth `state` parameter (which carries the PKCE
// verifier + DCR client_id across the redirect). Stable across requests on the
// same deploy — derived from an existing long-lived secret so we don't add a
// new required env var.
const FATHOM_OAUTH_STATE_SECRET = process.env.FATHOM_OAUTH_STATE_SECRET
  ? Buffer.from(process.env.FATHOM_OAUTH_STATE_SECRET)
  : crypto.createHash('sha256')
      .update((process.env.OPENROUTER_API_KEY || process.env.JIRA_API_TOKEN || 'dev-fathom-state'))
      .update(':fathom-oauth-state')
      .digest();

// DCR clients are cached by redirect_uri — registering once per deploy/origin
// is enough and avoids racing the registration endpoint on each connect.
const fathomDcrCache = new Map();

// MCP servers can answer either with application/json or text/event-stream.
// Pull the first JSON-RPC response object out of either form.
async function parseMcpResponse(r) {
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    const text = await r.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        const obj = JSON.parse(json);
        if (obj.jsonrpc) return obj;
      } catch { /* try next */ }
    }
    throw new Error('Fathom MCP returned an SSE stream without a JSON-RPC payload');
  }
  // Some servers reply 202 with empty body for notifications — guard against that.
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error(`Fathom MCP returned non-JSON body: ${text.slice(0, 200)}`); }
}

async function mcpRequest(token, method, params, { sessionId, isNotification } = {}) {
  if (!token) {
    const err = new Error('Fathom access token is missing. Click "Connect Fathom" to authorize.');
    err.reconnect = true;
    throw err;
  }
  const body = isNotification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: Date.now() + Math.floor(Math.random() * 1000), method, params };

  const headers = {
    'Content-Type':         'application/json',
    'Accept':               'application/json, text/event-stream',
    'Authorization':        `Bearer ${token}`,
    'MCP-Protocol-Version': MCP_PROTOCOL_VER,
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  // JSON-RPC over POST, but every Fathom MCP tool is read-only — safe to retry.
  const r = await fetchWithRetry(FATHOM_MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) },
    { retryNonIdempotent: true, timeoutMs: 60_000 });
  if (r.status === 401) {
    const err = new Error('Fathom MCP rejected your access token (401). Please reconnect Fathom.');
    err.reconnect = true;
    throw err;
  }
  const newSession = r.headers.get('mcp-session-id') || sessionId || null;
  if (isNotification) return { sessionId: newSession };

  const payload = await parseMcpResponse(r);
  if (!r.ok) {
    throw new Error(payload?.error?.message || `Fathom MCP HTTP ${r.status}`);
  }
  if (payload?.error) {
    throw new Error(payload.error.message || `Fathom MCP error ${payload.error.code}`);
  }
  return { result: payload?.result, sessionId: newSession };
}

async function mcpInitSession(token) {
  const { result, sessionId } = await mcpRequest(token, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VER,
    capabilities:    {},
    clientInfo:      { name: 'dnl-task-creator', version: '1.0' },
  });
  // Spec requires the client to send notifications/initialized after init.
  // Failure here shouldn't kill the request — some servers tolerate skipping it.
  try { await mcpRequest(token, 'notifications/initialized', {}, { sessionId, isNotification: true }); }
  catch (e) { console.warn('[Fathom MCP] initialized notification failed:', e.message); }
  return { sessionId, serverInfo: result };
}

async function mcpListTools(token, sessionId) {
  const { result } = await mcpRequest(token, 'tools/list', {}, { sessionId });
  return result?.tools ?? [];
}

async function mcpCallTool(token, sessionId, name, args) {
  const { result } = await mcpRequest(token, 'tools/call', { name, arguments: args ?? {} }, { sessionId });
  return result;
}

// Module-level cache for the discovered tool catalog. Fathom's tool list is
// effectively static between deploys, so re-listing on every request would
// just waste a round-trip.
let FATHOM_TOOLS_CACHE = null;     // [{ type:'function', function:{...} }]
let FATHOM_TOOLS_RAW   = null;     // raw MCP tool objects (for debugging)

function mcpToolToOpenAi(t) {
  // MCP `inputSchema` is already JSON Schema; OpenAI/OpenRouter accept the same shape.
  const params = t.inputSchema && typeof t.inputSchema === 'object'
    ? t.inputSchema
    : { type: 'object', properties: {} };
  return {
    type: 'function',
    function: {
      name:        t.name,
      description: t.description || '',
      parameters:  params,
    },
  };
}

async function ensureFathomTools(token, sessionId) {
  if (FATHOM_TOOLS_CACHE) return FATHOM_TOOLS_CACHE;
  const raw = await mcpListTools(token, sessionId);
  FATHOM_TOOLS_RAW   = raw;
  FATHOM_TOOLS_CACHE = [ASK_USER_TOOL, ...raw.map(mcpToolToOpenAi)];
  return FATHOM_TOOLS_CACHE;
}

// Reduce an MCP tool result to (a) a string for the LLM and (b) a compact
// summary for the UI's tool-pill row. We don't know Fathom's exact result
// shape, so keep it generic: concatenate text content blocks, count items
// if the result looks list-like.
function summariseMcpResult(name, result) {
  if (!result) return { text: '(empty)', summary: { kind: 'empty' } };
  const blocks = Array.isArray(result.content) ? result.content : [];
  const textParts = [];
  let structured;
  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
      // Many MCP servers JSON-encode structured results inside a text block;
      // try to lift that for nicer UI summaries.
      if (!structured && b.text.trim().startsWith('{')) {
        try { structured = JSON.parse(b.text); } catch { /* not JSON */ }
      }
    } else if (b) {
      textParts.push(JSON.stringify(b));
    }
  }
  const text = textParts.join('\n').trim() || '(no content)';

  const summary = { kind: 'mcp' };
  if (result.isError) summary.error = true;
  if (structured && typeof structured === 'object') {
    // Prefer a count-like field if present, otherwise fall back to a snippet.
    const arrKey = Object.keys(structured).find(k => Array.isArray(structured[k]));
    if (arrKey) summary.count = structured[arrKey].length;
  }
  if (!summary.count && blocks.length) summary.blocks = blocks.length;
  return { text, summary };
}

// ── OAuth helpers (PKCE state signing + DCR cache) ──────────────────────────

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function signState(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig  = b64url(crypto.createHmac('sha256', FATHOM_OAUTH_STATE_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verifyState(state) {
  if (!state || typeof state !== 'string' || !state.includes('.')) return null;
  const [body, sig] = state.split('.');
  const expected = b64url(crypto.createHmac('sha256', FATHOM_OAUTH_STATE_SECRET).update(body).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(b64urlDecode(body).toString('utf8')); }
  catch { return null; }
}
// Compute the *frontend* origin (where the popup was opened). This differs
// from req.host in dev because Vite (frontend) sits on :3000 and proxies /api
// requests to Express on :3001 with changeOrigin:true — so req.headers.host
// inside Express is "localhost:3001", not the page the user is actually on.
// Resolution order:
//   1) APP_ORIGIN env override (explicit, e.g. "https://task-creator…").
//   2) Referer header on /start — the popup was just opened from the SPA,
//      so the referer is the SPA's URL.
//   3) x-forwarded-host / host from the request (works when same-origin).
function getAppOrigin(req, { allowReferer = false } = {}) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/+$/, '');
  if (allowReferer) {
    const ref = req.headers.referer || req.headers.referrer;
    if (ref) {
      try { return new URL(ref).origin; } catch { /* ignore */ }
    }
  }
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}`;
}
async function getOrRegisterFathomClient(redirectUri) {
  if (fathomDcrCache.has(redirectUri)) return fathomDcrCache.get(redirectUri);
  const r = await fetch(FATHOM_OAUTH_REGISTER, {
    method:  'POST',
    signal:  AbortSignal.timeout(15_000),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body:    JSON.stringify({
      client_name:                'Dynamica Task Creator (Fathom MCP)',
      redirect_uris:              [redirectUri],
      grant_types:                ['authorization_code'],
      response_types:             ['code'],
      token_endpoint_auth_method: 'none',
      scope:                      'mcp',
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`Fathom DCR failed (${r.status}): ${txt.slice(0, 200)}`);
  }
  const client = await r.json();
  if (!client.client_id) throw new Error('Fathom DCR response missing client_id');
  fathomDcrCache.set(redirectUri, client);
  return client;
}

// Step 1: redirect the popup to Fathom's consent screen.
app.get('/api/fathom/oauth/start', async (req, res) => {
  try {
    const origin      = getAppOrigin(req, { allowReferer: true });
    const redirectUri = `${origin}/api/fathom/oauth/callback`;
    const client      = await getOrRegisterFathomClient(redirectUri);

    const verifier  = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    // Embed the resolved origin so the /callback handler can rebuild the
    // exact same redirect_uri (Fathom requires byte-equal match) and also
    // knows the target origin for window.postMessage.
    const state     = signState({ v: verifier, c: client.client_id, o: origin, t: Date.now() });

    const url = new URL(FATHOM_OAUTH_AUTHORIZE);
    url.searchParams.set('response_type',         'code');
    url.searchParams.set('client_id',             client.client_id);
    url.searchParams.set('redirect_uri',          redirectUri);
    url.searchParams.set('scope',                 'mcp');
    url.searchParams.set('state',                 state);
    url.searchParams.set('code_challenge',        challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    res.redirect(url.toString());
  } catch (err) {
    console.error('[Fathom OAuth start]', err.message);
    res.status(500).type('text/plain').send(`Fathom OAuth start failed: ${err.message}`);
  }
});

// Step 2: Fathom redirects back here with ?code=&state=. Exchange for a token
// and post it back to the popup opener.
app.get('/api/fathom/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // postMessage payload back to the opener; close popup either way.
  // `targetOrigin` is whatever /start resolved as the SPA origin — same as
  // the popup's own window.location.origin (since the popup was redirected
  // there from Fathom). Falling back to '*' as a safety net would defeat
  // the origin check on the listener; we keep it strict.
  function reply(payload, targetOrigin, statusCode = 200) {
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    const target = JSON.stringify(targetOrigin || '*');
    res.status(statusCode)
       .type('text/html; charset=utf-8')
       .send(
`<!doctype html><html><body style="font-family:system-ui;padding:24px;background:#0b0b14;color:#eaeaf2">
<script>
(function(){
  var payload = ${json};
  var target  = ${target};
  // Dual handoff:
  //   1) localStorage — survives COOP severing window.opener. Same-origin tabs
  //      receive a 'storage' event when this changes, which the SPA listens to.
  //   2) postMessage — fastest path when window.opener is still wired.
  try {
    if (payload.ok && payload.accessToken) {
      localStorage.setItem('fathom_oauth_token', payload.accessToken);
    }
    // Always write the full result with a fresh timestamp so the SPA can react
    // even if the token slot was already populated with the same value.
    localStorage.setItem('fathom_oauth_result', JSON.stringify({ payload: payload, at: Date.now() }));
  } catch(e){}
  try {
    if (window.opener) window.opener.postMessage({source:'fathom-oauth',payload:payload}, target);
  } catch(e){}
  document.body.innerHTML = payload.ok
    ? '<h2 style="margin:0 0 8px">Fathom connected</h2><p style="opacity:.7">You can close this tab.</p>'
    : '<h2 style="margin:0 0 8px">Fathom OAuth failed</h2><p style="opacity:.7">'+(payload.error||'unknown error')+'</p>';
  setTimeout(function(){ try { window.close(); } catch(e){} }, payload.ok ? 600 : 5000);
})();
</script>
</body></html>`);
  }

  // Pull the SPA origin out of the signed state so we can postMessage it back
  // even before we trust anything else from the request.
  const parsed = state ? verifyState(state) : null;
  const targetOrigin = parsed?.o || null;

  if (error)            return reply({ ok: false, error: `${error}${error_description ? `: ${error_description}` : ''}` }, targetOrigin, 400);
  if (!code || !state)  return reply({ ok: false, error: 'Missing code or state on callback' }, targetOrigin, 400);
  if (!parsed)          return reply({ ok: false, error: 'Invalid OAuth state (signature check failed)' }, targetOrigin, 400);
  if (Date.now() - parsed.t > 10 * 60_000)  return reply({ ok: false, error: 'OAuth state expired — please retry' }, targetOrigin, 400);

  try {
    const redirectUri = `${parsed.o}/api/fathom/oauth/callback`;
    const r = await fetch(FATHOM_OAUTH_TOKEN_URL, {
      method:  'POST',
      signal:  AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body:    new URLSearchParams({
        grant_type:    'authorization_code',
        code:          String(code),
        redirect_uri:  redirectUri,
        client_id:     parsed.c,
        code_verifier: parsed.v,
      }).toString(),
    });
    const text = await r.text();
    if (!r.ok) return reply({ ok: false, error: `Token exchange failed (${r.status}): ${text.slice(0, 200)}` }, targetOrigin, 400);
    let tok;
    try { tok = JSON.parse(text); }
    catch { return reply({ ok: false, error: 'Token endpoint returned non-JSON body' }, targetOrigin, 502); }
    if (!tok.access_token) return reply({ ok: false, error: 'Token response missing access_token' }, targetOrigin, 502);
    return reply({
      ok:           true,
      accessToken:  tok.access_token,
      refreshToken: tok.refresh_token || null,
      expiresIn:    tok.expires_in    || null,
    }, targetOrigin);
  } catch (err) {
    console.error('[Fathom OAuth callback]', err.message);
    return reply({ ok: false, error: err.message }, targetOrigin, 500);
  }
});

app.post('/api/fathom-agent', express.json({ limit: '50kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { message, userEmail, confirmedPlan, fathomToken } = req.body ?? {};
  const history = sanitizeHistory(req.body?.history);
  if (!message)      return res.status(400).json({ error: 'message is required' });
  if (!fathomToken)  return res.status(401).json({ error: 'Fathom is not connected. Click "Connect Fathom" to authorize.', reconnect: true });

  const nowIso  = new Date().toISOString();
  const userCtx = userEmail
    ? `The current user's email is "${userEmail}". If a tool offers a "recorded_by" / owner filter and the user says "my meetings" or "recorded by me", pass this email.`
    : '';

  const systemPrompt =
    'You are a Fathom meetings assistant for Dynamica Labs. ' +
    'Help users query their recorded calls: find meetings, read transcripts, summarise discussions, extract action items. ' +
    'You access Fathom through tools exposed by the official Fathom MCP server. Use ONLY those tools — never invent meeting titles, IDs, transcript content, or capabilities. ' +
    `Today is ${nowIso}. Convert relative dates ("last week", "yesterday") to absolute ISO 8601 timestamps when a tool accepts them. ` +
    'Before doing real work, call ask_user when the request is genuinely ambiguous AND the answer changes which tools/parameters you would call (e.g. multiple meetings match a vague title, undefined time scope). ' +
    'Never ask more than one clarifying question in a row, and never ask about anything you can resolve by trying a sensible default first. ' +
    'Workflow guidance: ' +
    '(1) Inspect the tool list before assuming what is available — names and arguments come from the MCP server, not from your priors. ' +
    '(2) When the user asks about a specific meeting, first find it via a listing/search tool to obtain its real identifier, THEN call the transcript/summary tool with that identifier. ' +
    '(3) NEVER give up after a single empty result. Broaden the time window or fall back to listing recent meetings, then read transcripts of the most plausible candidates. ' +
    '(4) When the user asks what a specific person said about a topic, attendees on a meeting are the key signal — pick meetings where that person is listed, then read the transcript. ' +
    'Respond in the same language the user writes in (Russian, Ukrainian, or English). When citing a meeting, include its title and Fathom URL. Use bullet lists for multiple items. ' +
    userCtx;

  const toolResults = [];

  try {
    // ── Open a fresh MCP session for this request and make sure tools are cached.
    const { sessionId } = await mcpInitSession(fathomToken);
    const tools = await ensureFathomTools(fathomToken, sessionId);

    // ── STAGE 1: produce a plan unless the user has already confirmed one ──
    let plan = '';
    if (confirmedPlan) {
      plan = String(confirmedPlan).trim();
    } else {
      const planResult = await buildPlan(apiKey, {
        domain:       'Fathom meetings',
        systemPrompt,
        tools,
        history,
        message,
      });

      if (planResult.mode === 'clarify' && planResult.question && planResult.options.length >= 2) {
        return res.json({
          stage:         'clarify',
          reply:         planResult.question,
          clarification: { question: planResult.question, options: planResult.options },
          toolResults:   [],
        });
      }

      if (planResult.mode === 'plan' && planResult.plan) {
        return res.json({
          stage:                'plan',
          plan:                 planResult.plan,
          awaitingConfirmation: true,
          toolResults:          [],
        });
      }

      // mode === 'direct' or empty plan → run executor without a plan notice
      plan = '';
    }

    // ── STAGE 2: execute with the (confirmed) plan injected as guidance ──
    const planNotice = plan
      ? `=== EXECUTION PLAN (approved by user) ===\n${plan}\n=== END PLAN ===\nFollow this plan. If a tool result shows the plan is wrong, adapt and explain in the reply. Your reply to the user must be in the user's language.`
      : '';

    const msgs = [
      { role: 'system', content: systemPrompt },
      ...(planNotice ? [{ role: 'system', content: planNotice }] : []),
      ...history.slice(-20),
      { role: 'user', content: message },
    ];

    for (let i = 0; i < 6; i++) {
      const data = await callOpenRouter(apiKey, {
        model:       OPENROUTER_EXECUTOR,
        messages:    msgs,
        tools,
        tool_choice: 'auto',
        temperature: 0.3,
        max_tokens:  4000,
      });

      const choice = data.choices[0];
      msgs.push(choice.message);

      if (choice.finish_reason !== 'tool_calls') {
        const reply = extractReply(choice.message)
          || 'The model returned an empty response. Below is the data we managed to retrieve.';
        return res.json({ stage: 'done', reply, toolResults });
      }

      const askCall = findAskUserCall(choice.message.tool_calls);
      if (askCall) {
        const clarification = buildClarificationFromCall(askCall);
        return res.json({
          stage:         'clarify',
          reply:         clarification?.question || 'Please clarify what exactly you need.',
          clarification,
          toolResults,
        });
      }

      for (const tc of choice.message.tool_calls) {
        const name = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments || '{}'); }
        catch { args = {}; }

        try {
          const raw     = await mcpCallTool(fathomToken, sessionId, name, args);
          const { text, summary } = summariseMcpResult(name, raw);
          toolResults.push({ name, args, result: summary });
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: text });
        } catch (err) {
          if (err.reconnect) throw err; // bubble up so the outer catch returns reconnect flag
          toolResults.push({ name, error: err.message });
          msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err.message }) });
        }
      }
    }
    res.json({ stage: 'done', reply: 'Step limit reached. Try rephrasing your request.', toolResults });
  } catch (err) {
    console.error('[Fathom Agent error]', err.message);
    const status = err.reconnect ? 401 : 500;
    res.status(status).json({
      error: humaniseFetchError(err),
      toolResults,
      ...(err.reconnect ? { reconnect: true } : {}),
    });
  }
});

// ─── Tasks Follow-up (calendar → pick call → run skill on transcript) ─────────
//
// These endpoints power the second tab. Unlike the chat agent they are
// deterministic from the UI's point of view: the user picks a date range and a
// call, then a skill. Under the hood we still let the executor model drive the
// Fathom MCP tools (the tool catalogue is discovered at runtime, so the model —
// which sees the real tool schemas — is the most reliable way to list meetings
// and pull a transcript without us hard-coding tool/argument names).

// Generic executor loop over the Fathom MCP tools. Mutates `messages` and
// `toolResults`. Returns { reply, askCall } — askCall is set if the model tried
// to ask the user a clarifying question (callers may ignore it).
async function runFathomExecutor({ apiKey, fathomToken, sessionId, tools, messages, toolResults, maxSteps = 6, maxTokens = 4000 }) {
  for (let i = 0; i < maxSteps; i++) {
    const data = await callOpenRouter(apiKey, {
      model:       OPENROUTER_EXECUTOR,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens:  maxTokens,
    });
    const choice = data.choices[0];
    messages.push(choice.message);

    if (choice.finish_reason !== 'tool_calls') {
      return { reply: extractReply(choice.message), askCall: null };
    }

    const askCall = findAskUserCall(choice.message.tool_calls);
    if (askCall) return { reply: null, askCall };

    for (const tc of choice.message.tool_calls) {
      const name = tc.function.name;
      let args;
      try { args = JSON.parse(tc.function.arguments || '{}'); }
      catch { args = {}; }
      try {
        const raw = await mcpCallTool(fathomToken, sessionId, name, args);
        const { text, summary } = summariseMcpResult(name, raw);
        toolResults.push({ name, args, result: summary });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: text });
      } catch (err) {
        if (err.reconnect) throw err;
        toolResults.push({ name, error: err.message });
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: err.message }) });
      }
    }
  }
  return { reply: 'Step limit reached while talking to Fathom.', askCall: null };
}

// Pull the first JSON value (object or array) out of a possibly chatty reply.
function extractJson(raw) {
  if (!raw) return null;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  // Find the outermost {...} or [...] in the text.
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  if (end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

// List the skills available on the Tasks Follow-up tab (no instruction text).
app.get('/api/fathom/skills', (req, res) => {
  res.json({ skills: listFollowupSkills() });
});

// Find a discovered Fathom MCP tool by purpose, resilient to exact naming.
function findFathomRawTool(kind) {
  const tools = FATHOM_TOOLS_RAW || [];
  const byName = n => tools.find(t => t.name === n);
  if (kind === 'list') {
    return byName('list_meetings')
      || tools.find(t => /list/i.test(t.name) && /(meeting|recording|call)/i.test(t.name) && !/search/i.test(t.name))
      || tools.find(t => /(meeting|recording)s?$/i.test(t.name) && !/transcript|summary|search|person/i.test(t.name));
  }
  if (kind === 'transcript') {
    return byName('get_meeting_transcript') || tools.find(t => /transcript/i.test(t.name));
  }
  return null;
}

// Pull a meetings array out of an MCP tool result (structured or JSON-in-text).
function meetingsFromMcp(raw) {
  const tryArr = v => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      for (const k of ['meetings', 'results', 'data', 'items', 'recordings']) {
        if (Array.isArray(v[k])) return v[k];
      }
      const a = Object.values(v).find(x => Array.isArray(x));
      if (a) return a;
    }
    return null;
  };
  if (raw?.structuredContent) {
    const a = tryArr(raw.structuredContent);
    if (a) return a;
  }
  const { text } = summariseMcpResult('list', raw);
  return tryArr(extractJson(text));
}

// Parse Fathom MCP's human-readable meeting listing. Each meeting is a line like:
//   - <title> | <YYYY-MM-DD> | id: <recording_id> | url: <url> | recorded by <name> | <attendees,…>
// Note: the `id:` value is the recording_id (used for transcripts) and differs
// from the numeric id inside the share url — we capture the `id:` one.
function parseMeetingsText(text) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const parts = line.slice(2).split('|').map(s => s.trim());
    if (!parts.length || !parts[0]) continue;
    const m = { title: parts[0], date: '', id: '', url: '', host: '', attendees: [] };
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      let mm;
      if      ((mm = p.match(/^id:\s*(.+)$/i)))          m.id   = mm[1].trim();
      else if ((mm = p.match(/^url:\s*(.+)$/i)))         m.url  = mm[1].trim();
      else if ((mm = p.match(/^recorded by\s+(.+)$/i)))  m.host = mm[1].trim();
      else if (/^\d{4}-\d{2}-\d{2}/.test(p))             m.date = p;
      else if (p)                                        m.attendees = p.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (m.id || m.url) out.push(m);
  }
  return out;
}

// Normalise one Fathom meeting object into the shape the UI expects.
function normalizeMeeting(m) {
  const inv = m.calendar_invitees || m.attendees || m.invitees || m.participants || [];
  const attendees = Array.isArray(inv)
    ? inv.map(x => typeof x === 'string' ? x : (x?.name || x?.email || '')).filter(Boolean)
    : [];
  const rb = m.recorded_by;
  const host = typeof rb === 'string' ? rb : (rb?.name || rb?.email || m.host || m.owner || '');
  return {
    id:        String(m.recording_id ?? m.id ?? ''),
    title:     String(m.title ?? m.name ?? 'Untitled meeting'),
    date:      m.created_at ?? m.recording_start_time ?? m.started_at ?? m.start_time ?? m.scheduled_start_time ?? m.date ?? '',
    url:       String(m.url ?? m.share_url ?? ''),
    host:      String(host || ''),
    attendees,
  };
}

// List the signed-in user's (or the team's) calls in a date range. Returns
// { meetings: [{ id, title, date, url, host, attendees }] }. `id` is the Fathom
// recording_id used later to fetch the transcript.
//
// Fast path: call the listing tool directly over MCP — no LLM. The model-driven
// loop is kept only as a fallback when the result can't be parsed deterministically.
app.post('/api/fathom/my-calls', express.json({ limit: '20kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { fathomToken, userEmail, startDate, endDate, scope } = req.body ?? {};
  if (!fathomToken) return res.status(401).json({ error: 'Fathom is not connected.', reconnect: true });
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate are required' });

  const isTeam        = scope === 'team';
  const createdAfter  = `${startDate}T00:00:00Z`;
  const createdBefore = `${endDate}T23:59:59Z`;

  const toolResults = [];
  try {
    const { sessionId } = await mcpInitSession(fathomToken);
    const tools = await ensureFathomTools(fathomToken, sessionId);

    // ── Fast path: direct MCP listing call, no LLM. ──
    const listTool = findFathomRawTool('list');
    if (listTool) {
      const props = listTool.inputSchema?.properties || {};
      const lo = Date.parse(createdAfter), hi = Date.parse(createdBefore);

      // max_pages per call: as many pages as the schema allows (Fathom rejects an
      // out-of-range value, which would error the whole call and return nothing).
      let maxPages = 10;
      if ('max_pages' in props) {
        const schemaMax = Number(props.max_pages?.maximum);
        if (Number.isFinite(schemaMax)) maxPages = schemaMax;
      }

      // Return EVERY call in the range, not just the first window. The tool paginates
      // internally up to max_pages; to reach further back we walk the window: after a
      // batch, re-query ending just before the oldest call we've seen and repeat until
      // the batch reaches the range start or stops yielding new meetings. Dedupe by id.
      try {
        const byId = new Map();          // id/url → normalized meeting (dedupe)
        let before = createdBefore;
        let ok = false;
        // Hard safety cap so a misbehaving cursor can never loop forever.
        for (let batch = 0; batch < 40; batch++) {
          const args = {};
          if ('created_after'  in props) args.created_after  = createdAfter;
          if ('created_before' in props) args.created_before = before;
          if ('max_pages'      in props) args.max_pages      = maxPages;
          if (!isTeam && userEmail && 'recorded_by' in props) args.recorded_by = [userEmail];

          const raw = await mcpCallTool(fathomToken, sessionId, listTool.name, args);
          const { text, summary } = summariseMcpResult(listTool.name, raw);
          toolResults.push({ name: listTool.name, args, result: summary });
          ok = true;

          const arr = (meetingsFromMcp(raw) || parseMeetingsText(text) || []).map(normalizeMeeting);
          let added = 0, oldest = Infinity;
          for (const m of arr) {
            if (!(m.id || m.url)) continue;
            const t = m.date ? Date.parse(m.date) : NaN;
            if (!isNaN(t)) {
              if (t < lo || t > hi) continue;   // outside the requested range
              if (t < oldest) oldest = t;
            }
            const key = m.id || m.url;
            if (!byId.has(key)) { byId.set(key, m); added++; }
          }

          // Stop when: nothing new came back, or the batch already reached the
          // range start, or the window can't shrink any further.
          if (added === 0 || oldest === Infinity || oldest <= lo) break;
          // End the next window AT the oldest we've seen (inclusive) so a call sharing
          // that exact second is never skipped; the 1-call overlap is deduped by id.
          const nextBefore = new Date(oldest).toISOString();
          if (nextBefore === before) break;
          before = nextBefore;
        }

        if (ok) {
          const clean = [...byId.values()]
            .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
          return res.json({ meetings: clean, toolResults });
        }
      } catch (err) {
        if (err.reconnect) throw err;
        toolResults.push({ name: listTool.name, error: err.message });
        // fall through to the LLM fallback only if the tool call itself failed
      }
    }

    // ── Fallback: let the model drive the tools (slower, resilient). ──
    const scopeCtx = isTeam
      ? `Return calls from the user's ENTIRE TEAM / workspace, not just their own. Do NOT restrict by owner / "recorded_by".`
      : `Return ONLY the signed-in user's OWN calls.${userEmail ? ` Their email is "${userEmail}"; use a "recorded_by" filter if available.` : ''}`;

    const systemPrompt =
      `You are a data-retrieval step. List ${isTeam ? 'the team\'s' : 'the signed-in user\'s'} Fathom calls between ${createdAfter} and ${createdBefore} and return them as JSON. ` +
      scopeCtx + ' Do NOT fetch transcripts. Respond with ONLY a JSON object, no prose:\n' +
      '{ "meetings": [ { "id": "<recording_id>", "title": "…", "date": "<ISO 8601>", "url": "…", "host": "<recorder name>", "attendees": ["name", …] } ] }\n' +
      'If none, return { "meetings": [] }. Never invent meetings.';

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `List the calls from ${startDate} to ${endDate}. JSON object only.` },
    ];
    const { reply } = await runFathomExecutor({ apiKey, fathomToken, sessionId, tools, messages, toolResults, maxSteps: 6 });
    const parsed = extractJson(reply) || {};
    const arr = Array.isArray(parsed.meetings) ? parsed.meetings : Array.isArray(parsed) ? parsed : [];
    const clean = arr.map(normalizeMeeting).filter(m => m.id || m.url);
    res.json({ meetings: clean, toolResults });
  } catch (err) {
    console.error('[Fathom my-calls error]', err.message);
    const status = err.reconnect ? 401 : 500;
    res.status(status).json({ error: humaniseFetchError(err), toolResults, ...(err.reconnect ? { reconnect: true } : {}) });
  }
});

// Run a skill against one call's transcript. Body: { fathomToken, recordingId,
// callTitle, callUrl, skillId, userEmail }. Returns { reply, toolResults }.
//
// Fast path: fetch the transcript directly over MCP, then a SINGLE LLM call
// applies the skill. The agentic loop is kept only as a fallback.
app.post('/api/fathom/skill-run', express.json({ limit: '20kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { fathomToken, recordingId, callTitle, callUrl, skillId, userEmail } = req.body ?? {};
  if (!fathomToken) return res.status(401).json({ error: 'Fathom is not connected.', reconnect: true });
  if (!recordingId) return res.status(400).json({ error: 'recordingId is required' });

  const skill = FOLLOWUP_SKILLS[skillId];
  if (!skill) return res.status(400).json({ error: `Unknown skill "${skillId}"` });

  const callLabel = `Call: "${callTitle || 'Untitled meeting'}"${callUrl ? ` (${callUrl})` : ''}`;

  const toolResults = [];
  try {
    const { sessionId } = await mcpInitSession(fathomToken);
    const tools = await ensureFathomTools(fathomToken, sessionId);

    // ── Fast path: pull the transcript directly. ──
    let transcript = '';
    const tTool = findFathomRawTool('transcript');
    if (tTool) {
      const props = tTool.inputSchema?.properties || {};
      const args = {};
      if ('recording_id' in props) {
        const n = Number(recordingId);
        args.recording_id = (Number.isFinite(n) && props.recording_id?.type === 'integer') ? n
          : Number.isFinite(n) ? n : String(recordingId);
      }
      if ('url' in props && callUrl) args.url = callUrl;
      try {
        const raw = await mcpCallTool(fathomToken, sessionId, tTool.name, args);
        const { text, summary } = summariseMcpResult(tTool.name, raw);
        toolResults.push({ name: tTool.name, args, result: summary });
        if (text && text !== '(no content)' && text !== '(empty)') transcript = text;
      } catch (err) {
        if (err.reconnect) throw err;
        toolResults.push({ name: tTool.name, error: err.message });
      }
    }

    if (transcript) {
      const systemPrompt =
        'You are processing a single Fathom call for the Tasks Follow-up tool. ' +
        'The full transcript is provided by the user below (it contains timestamped [MM:SS](url) deep links you may cite for the Fathom Link field). ' +
        'Read the ENTIRE transcript and perform the task in the SKILL INSTRUCTIONS using ONLY what the transcript contains. Never invent content. Output the skill\'s result only — no meta commentary. ' +
        (userEmail ? `The signed-in user's email is "${userEmail}". ` : '') +
        '\n\n=== SKILL INSTRUCTIONS ===\n' + skill.instructions + '\n=== END SKILL INSTRUCTIONS ===';

      // Run the skill over a given transcript body. Kept as a closure so we can
      // retry with a smaller slice only if the model rejects an over-long input.
      const runSkill = async (body, note = '') => {
        const data = await callOpenRouter(apiKey, {
          model:       OPENROUTER_EXECUTOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user',   content: `${callLabel}\n\n=== TRANSCRIPT${note} ===\n${body}` },
          ],
          temperature: 0.2,
          max_tokens:  4000,
          // Structured extraction, not deep reasoning — keep internal reasoning
          // minimal so it answers fast instead of "thinking" for tens of seconds.
          reasoning:   { effort: 'low' },
        });
        return extractReply(data.choices?.[0]?.message);
      };

      let reply;
      try {
        // Always send the FULL transcript, however large.
        reply = await runSkill(transcript);
      } catch (err) {
        // Only if the model literally can't fit it: retry on a safe-size slice
        // rather than failing the request outright.
        if (/context|maximum.*token|too many tokens|token limit|length/i.test(err.message || '')) {
          const SAFE = 280_000;
          reply = await runSkill(`${transcript.slice(0, SAFE)}\n…[transcript truncated to fit the model]…`, ' (truncated to fit)');
        } else {
          throw err;
        }
      }
      return res.json({ reply: reply || 'The model returned an empty response.', toolResults });
    }

    // ── Fallback: agentic loop drives the tools itself. ──
    const systemPrompt =
      'You are processing a single Fathom call for the Tasks Follow-up tool. ' +
      'STEP 1: Use the available tools to retrieve the FULL transcript of the specified call (use the meeting identifier from the user). ' +
      'STEP 2: Perform the task in the SKILL INSTRUCTIONS using only the transcript. Never invent content. Output the skill\'s result only. ' +
      (userEmail ? `The signed-in user's email is "${userEmail}". ` : '') +
      '\n\n=== SKILL INSTRUCTIONS ===\n' + skill.instructions + '\n=== END SKILL INSTRUCTIONS ===';
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: `${callLabel}. Meeting identifier: ${recordingId}.\n\nRetrieve this call's transcript and then run the skill on it.` },
    ];
    const { reply } = await runFathomExecutor({ apiKey, fathomToken, sessionId, tools, messages, toolResults, maxSteps: 6, maxTokens: 4000 });
    res.json({ reply: reply || 'The model returned an empty response.', toolResults });
  } catch (err) {
    console.error('[Fathom skill-run error]', err.message);
    const status = err.reconnect ? 401 : 500;
    res.status(status).json({ error: humaniseFetchError(err), toolResults, ...(err.reconnect ? { reconnect: true } : {}) });
  }
});

// ─── Extract tasks from dictated text (Voice tab) ─────────────────────────────
// Body: { text, userEmail }. Runs the same "Tasks Follow-up" skill used by the
// Fathom tab, but over arbitrary dictated text instead of a call transcript, and
// returns the identical structured markdown so the Voice tab can parse it into
// Create-Task blocks. A single LLM call — no MCP, no Fathom token required.
app.post('/api/extract-tasks', express.json({ limit: '50kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { text, userEmail } = req.body ?? {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });

  const skill = FOLLOWUP_SKILLS['tasks-follow-up'];

  const systemPrompt =
    'You are processing dictated notes for the Voice Tasks tool. ' +
    'The user dictated the text below — it is NOT a meeting transcript, so it has no timestamps and no Fathom deep links. ' +
    'Read it carefully and perform the task in the SKILL INSTRUCTIONS using ONLY what the text contains. Never invent content. ' +
    'For the "Fathom Link" field always output exactly "Not provided". Output the skill\'s result only — no meta commentary. ' +
    (userEmail ? `The signed-in user's email is "${userEmail}". ` : '') +
    '\n\n=== SKILL INSTRUCTIONS ===\n' + skill.instructions + '\n=== END SKILL INSTRUCTIONS ===';

  try {
    const data = await callOpenRouter(apiKey, {
      model:       OPENROUTER_EXECUTOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `=== DICTATED NOTES ===\n${String(text).trim()}` },
      ],
      temperature: 0.2,
      max_tokens:  4000,
      reasoning:   { effort: 'low' },
    });
    const reply = extractReply(data.choices?.[0]?.message);
    res.json({ reply: reply || 'The model returned an empty response.' });
  } catch (err) {
    console.error('[extract-tasks error]', err.message);
    res.status(500).json({ error: humaniseFetchError(err) });
  }
});

// ─── Translate dictated text to English (Voice tab) ───────────────────────────
// Body: { text, target? }. Translates arbitrary text to English (default) and
// returns { text }. A single LLM call — no MCP, no Fathom token. Verbatim
// meaning is preserved; product/people/technical names are kept as-is.
app.post('/api/translate', express.json({ limit: '50kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { text } = req.body ?? {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });

  const systemPrompt =
    'You are a professional translator. Translate the user\'s text into natural, fluent English. ' +
    'HARD RULES: ' +
    '(1) Output ONLY the translation — no preamble, no notes, no quotes around it, no "Translation:" prefix. ' +
    '(2) Preserve the original meaning, tone, and structure (keep line breaks and bullet points as they are). ' +
    '(3) Keep proper nouns, product names, project keys, people\'s names, URLs, and technical terms unchanged (e.g. Dynamica, NSMG, Jira, Azure DevOps, sprint names). ' +
    '(4) If the text is already in English, return it unchanged. ' +
    '(5) Do not add, remove, or summarise any content.';

  try {
    const data = await callOpenRouter(apiKey, {
      model:       OPENROUTER_EXECUTOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: String(text).trim() },
      ],
      temperature: 0.2,
      max_tokens:  4000,
      reasoning:   { effort: 'low' },
    });
    const reply = extractReply(data.choices?.[0]?.message);
    if (!reply) return res.status(502).json({ error: 'The model returned an empty translation.' });
    res.json({ text: reply });
  } catch (err) {
    console.error('[translate error]', err.message);
    res.status(500).json({ error: humaniseFetchError(err) });
  }
});

// ─── Extract issue IDs from a screenshot (PM › Component tab) ─────────────────
// Body: { image: "data:image/png;base64,…" }. Sends the screenshot to a vision
// model and returns { ids: [...] } — the raw tokens it reads off the cards
// (Azure DevOps work-item numbers and/or Jira keys like ABS-123). The client
// classifies and resolves them; here we only OCR. Uses a vision-capable model
// (deepseek executor is text-only), configurable via OPENROUTER_VISION_MODEL.
app.post('/api/component/extract-ids', express.json({ limit: '12mb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { image } = req.body ?? {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'image (data URL) is required' });
  }

  const visionModel = process.env.OPENROUTER_VISION_MODEL || 'google/gemini-2.5-flash';
  const systemPrompt =
    'You read identifiers off a screenshot of Azure DevOps or Jira cards/boards. ' +
    'Extract every issue identifier you can see: Azure DevOps work-item numbers (bare integers, often prefixed with # or shown as a card id) AND Jira keys (e.g. ABS-123, NSMG-45). ' +
    'Do NOT invent ids, do NOT include story-point values, sprint numbers, dates, avatars, or unrelated numbers — only work-item / card identifiers. ' +
    'Respond with VALID JSON ONLY, no markdown fences, no prose: {"ids": ["1234", "ABS-56", …]} in the order they appear.';

  try {
    const data = await callOpenRouter(apiKey, {
      model: visionModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: [
          { type: 'text', text: 'Extract all issue identifiers from this screenshot.' },
          { type: 'image_url', image_url: { url: image } },
        ] },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 2000,
    });
    const raw = extractReply(data.choices?.[0]?.message);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let ids = [];
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed.ids)) ids = parsed.ids.map(String);
    } catch { /* fall through with empty list */ }
    res.json({ ids });
  } catch (err) {
    console.error('[component/extract-ids error]', err.message);
    res.status(500).json({ error: humaniseFetchError(err) });
  }
});

// ─── Stats query (Status Updates tab) ─────────────────────────────────────────
// Body: { question, data }. `data` is a client-built snapshot of the already-
// fetched Azure work items and their linked Jira issues (+ descendant tree). The
// model answers questions over that snapshot ("list all requests where every
// epic and task is done") and returns the Azure ids that match, which the UI
// uses to filter the table. No live fetching — it reasons over what the user
// already pulled. Uses the stronger planner model for reliable aggregation.
app.post('/api/stats-query', express.json({ limit: '2mb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { question, data } = req.body ?? {};
  if (!question || !String(question).trim()) return res.status(400).json({ error: 'question is required' });
  if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });

  const systemPrompt =
    'You are a data analyst for a Dynamica Labs delivery dashboard. You are given a JSON snapshot (in the user message) of Azure DevOps work items and their linked Jira issues. ' +
    'Each entry has: azureId (number), azureType, azureTitle, azureState, jiraKey, jiraFound (bool), jiraStatus, jiraCategory, and children[] (the Jira request\'s descendant epics/tasks/subtasks, each with key, type, status, category, assignee). ' +
    'A "request" is one entry (an Azure work item and its linked Jira issue). Status CATEGORY values are: "new" = to-do, "indeterminate" = in progress, "done" = completed. Use category (not the free-text status name) when the user talks about done / in progress / not started. ' +
    'Answer the user\'s question using ONLY this snapshot. Never invent items, keys, or counts. If the data does not contain something, say so. ' +
    'Reply in the SAME language as the question. ' +
    'OUTPUT: respond with VALID JSON ONLY, no markdown fences, no prose around it:\n' +
    '{\n' +
    '  "answer": "<concise answer in markdown; use a short bullet list when listing items, each as **AZURE_ID** — title (JIRA_KEY)>",\n' +
    '  "matchAzureIds": [<azureId numbers of every entry that satisfies the question>]\n' +
    '}\n' +
    'matchAzureIds drives a table filter in the UI: include EXACTLY the azureIds the user asked to see (empty array if none match, or if the question is not about selecting items). Never include an azureId that is not in the snapshot.';

  try {
    const completion = await callOpenRouter(apiKey, {
      model:           OPENROUTER_PLANNER,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `QUESTION: ${String(question).trim()}\n\nSNAPSHOT (${data.length} work items):\n${JSON.stringify(data)}` },
      ],
      response_format: { type: 'json_object' },
      temperature:     0.1,
      max_tokens:      4000,
    });

    const raw = extractReply(completion.choices?.[0]?.message);
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch { return res.json({ answer: raw || 'No answer produced.', matchAzureIds: [] }); }

    const validIds = new Set(data.map(d => Number(d.azureId)).filter(Number.isFinite));
    const matchAzureIds = Array.isArray(parsed.matchAzureIds)
      ? [...new Set(parsed.matchAzureIds.map(Number).filter(n => validIds.has(n)))]
      : [];
    res.json({
      answer:        typeof parsed.answer === 'string' && parsed.answer.trim() ? parsed.answer.trim() : (raw || 'No answer produced.'),
      matchAzureIds,
    });
  } catch (err) {
    console.error('[stats-query error]', err.message);
    res.status(500).json({ error: humaniseFetchError(err) });
  }
});

// ─── Email Agent ─────────────────────────────────────────────────────────────

app.post('/api/email-agent', express.json({ limit: '50kb' }), async (req, res) => {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'OPENROUTER_API_KEY not configured' });

  const { message, instruction, userEmail } = req.body ?? {};
  if (!message)     return res.status(400).json({ error: 'message is required' });
  if (!instruction) return res.status(400).json({ error: 'instruction is required' });

  const systemPrompt =
    'You are an Email Agent. Your job is to take the user\'s rough draft of an email, Slack message, or letter and rewrite it as a polished version, following the user-provided STYLE INSTRUCTIONS below. ' +
    'HARD OUTPUT RULES (these override anything in the style instructions): ' +
    '(1) Output ONLY the final, ready-to-send message. ' +
    '(2) Do NOT include a "What changed" summary, change log, list of edits, or any meta-commentary about what you modified. ' +
    '(3) Do NOT include horizontal separators ("---"), markdown rules, or section dividers anywhere in the output. ' +
    '(4) Do NOT prefix the message with a translation note or any introduction from yourself. ' +
    '(5) Begin directly with the Subject line (for emails) or the greeting. ' +
    '(6) Do NOT add, invent, or append a signature, name, contact details, or sign-off block. If the user\'s draft did not include a signature, the message ends at the last sentence of the body — do not write "Roman Merkulov", emails, phone numbers, or "Best regards / Sincerely / Thanks" closing lines on the user\'s behalf. Only preserve a signature if the user explicitly included one in their draft. ' +
    'If the draft is ambiguous about format (email vs Slack vs letter), pick the most likely format based on length, presence of greeting/signature, and tone — do not ask the user. ' +
    'Preserve specific facts, names, dates, numbers, and links from the user\'s draft verbatim. Never invent recipients or details that were not in the draft. ' +
    '\n\n=== STYLE INSTRUCTIONS (provided by user) ===\n' +
    instruction +
    '\n=== END STYLE INSTRUCTIONS ===';

  try {
    const planResult = await buildPlan(apiKey, {
      domain:       'email rewriting',
      systemPrompt,
      tools:        [],
      history:      [],
      message,
    });
    // buildPlan returns { mode, plan, … }. Only a real "plan" is injected;
    // "direct"/"clarify" modes mean the rewrite needs no extra guidance.
    const planText = planResult.mode === 'plan' ? planResult.plan : '';

    const planNotice = planText
      ? `=== REWRITE PLAN (from planner, English — internal only) ===\n${planText}\n=== END PLAN ===\nApply this plan when rewriting. Still obey the HARD OUTPUT RULES above. The plan itself is in English for internal reasoning; the rewritten message must be in the same language as the user's draft.`
      : '';

    const msgs = [
      { role: 'system', content: systemPrompt },
      ...(planNotice ? [{ role: 'system', content: planNotice }] : []),
      { role: 'user',   content: message },
    ];

    const data = await callOpenRouter(apiKey, {
      model:       OPENROUTER_EXECUTOR,
      messages:    msgs,
      temperature: 0.4,
      // V4 Flash reasons before answering; keep budget generous so the
      // rewritten message isn't truncated.
      max_tokens:  4000,
    });
    res.json({ reply: extractReply(data.choices?.[0]?.message) });
  } catch (err) {
    console.error('[Email Agent error]', err.message);
    res.status(500).json({ error: humaniseFetchError(err) });
  }
});

// ─── Email Agent feedback ────────────────────────────────────────────────────
// Thumbs up/down on refined outputs, collected to improve the skill prompts.
// Appended as JSONL next to the API code when the FS is writable (local dev);
// on serverless deploys the write fails silently and the log line is the record.
const EMAIL_FEEDBACK_FILE = new URL('./email-agent-feedback.jsonl', import.meta.url);

app.post('/api/email-agent/feedback', express.json({ limit: '200kb' }), (req, res) => {
  const { rating, input, output, skillId, skillName, customized, userEmail } = req.body ?? {};
  if (rating !== 'up' && rating !== 'down') {
    return res.status(400).json({ error: 'rating must be "up" or "down"' });
  }
  const entry = {
    ts:         new Date().toISOString(),
    rating,
    skillId:    skillId   ?? null,
    skillName:  skillName ?? null,
    customized: !!customized,
    userEmail:  userEmail ?? null,
    input:      String(input  ?? '').slice(0, 8000),
    output:     String(output ?? '').slice(0, 8000),
  };
  console.log(`[Email Agent feedback] ${entry.rating} — ${entry.skillName ?? 'unknown skill'} (${entry.userEmail ?? 'anon'})`);
  try {
    fs.appendFileSync(EMAIL_FEEDBACK_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.warn('[Email Agent feedback] file write failed:', err.message);
  }
  res.json({ ok: true });
});

// Review collected feedback (for prompt-improvement analysis).
app.get('/api/email-agent/feedback', (req, res) => {
  try {
    const text = fs.readFileSync(EMAIL_FEEDBACK_FILE, 'utf8');
    const entries = text.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json({ count: entries.length, entries });
  } catch {
    res.json({ count: 0, entries: [] });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  // Report what /api/fathom/oauth/start would compute right now — this is the
  // single most common source of "redirect_uri points at a dead domain" bugs.
  const resolvedOrigin       = getAppOrigin(req, { allowReferer: false });
  const refererBackedOrigin  = getAppOrigin(req, { allowReferer: true });
  res.json({
    ok: true,
    azure:  Object.fromEntries(Object.entries(AZURE_ORGS).map(([k, v]) => [k, { target: v.target || null, hasPat: !!v.pat }])),
    jira:   { hasToken: !!jiraToken },
    fathom: {
      mcpUrl:   FATHOM_MCP_URL,
      authMode: 'per-user OAuth',
      // What redirect_uri will be sent to Fathom on /api/fathom/oauth/start.
      // If this points at a domain that doesn't resolve, the popup will fail
      // after authorization with DNS_PROBE_FINISHED_NXDOMAIN.
      resolvedRedirectOrigin:    resolvedOrigin,
      refererBackedOrigin,
      appOriginEnv:              process.env.APP_ORIGIN || null,
      seenHostHeader:            req.get('host')                  || null,
      seenXForwardedHostHeader:  req.headers['x-forwarded-host']  || null,
      seenXForwardedProtoHeader: req.headers['x-forwarded-proto'] || null,
    },
  });
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`[Server] Running locally on http://localhost:${PORT}`);
  });

  // Quarterly-call reminder sweep: every 30 minutes, but emails only go out
  // in the 13:00 Kyiv hour (reminderSentAt dedupes the two ticks inside it).
  // On Vercel this block never runs — Vercel Cron hits /api/quarterly-calls/cron.
  const sweep = () => checkQuarterlyCallReminders({ atHour: 13 })
    .catch(err => console.warn('[Quarterly calls] reminder sweep failed:', err.message));
  setTimeout(sweep, 15_000);
  setInterval(sweep, 30 * 60_000);
}

// Обязательно экспортируем app для бессерверной среды Vercel
export default app;