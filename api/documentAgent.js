// Documentation AI (Beta) — Node port of the standalone document_agent_app
// Python backend. Pipeline: video upload → ffmpeg frame extraction (smart
// transcript-driven with visual fallback) → multimodal LLM analysis through
// OpenRouter → PDF assembly (pdfkit). Mounted under /api/doc-agent/*.

import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ─── Config ───────────────────────────────────────────────────────────────────

// This module is imported before index.js gets a chance to call dotenv.config()
// (ES imports are hoisted), so load the .env here too — it's idempotent.
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const cfg = {
  get openrouterApiKey() { return process.env.OPENROUTER_API_KEY || ''; },
  appTitle: 'Documentation AI',
  appReferer: process.env.OPENROUTER_REFERER || 'https://task-creator.dynamicalabs.com',
  storageRoot: process.env.VERCEL
    ? '/tmp/doc_agent_storage'
    : path.resolve(__dirname, '../storage/doc_agent'),
  maxFramesHardLimit: Number(process.env.DOC_AGENT_MAX_FRAMES_HARD_LIMIT || 200),
  maxVideoMb: Number(process.env.DOC_AGENT_MAX_VIDEO_MB || 300),
  frameLongSide: Number(process.env.DOC_AGENT_FRAME_LONG_SIDE || 1280),
  sceneThreshold: Number(process.env.DOC_AGENT_SCENE_THRESHOLD || 0.30),
  smartExtraction: (process.env.DOC_AGENT_SMART_EXTRACTION || 'true') !== 'false',
  transcriptModel: process.env.DOC_AGENT_TRANSCRIPT_MODEL || 'anthropic/claude-sonnet-4.6',
  audioTranscribeModel: process.env.DOC_AGENT_AUDIO_MODEL || 'google/gemini-2.5-flash',
};

const uploadsDir = path.join(cfg.storageRoot, 'uploads');
const framesRoot = path.join(cfg.storageRoot, 'frames');
const outputDir  = path.join(cfg.storageRoot, 'output');
const jobsFile   = path.join(cfg.storageRoot, 'jobs.json');
const settingsFile = path.join(cfg.storageRoot, 'settings.json');
for (const d of [uploadsDir, framesRoot, outputDir]) fs.mkdirSync(d, { recursive: true });

// Brand settings persisted per-install (the Python app kept these in .env; the
// platform .env holds shared credentials, so these live in a sidecar file).
function loadSettings() {
  try { return { brand_name: '', brand_tagline: 'End-user guide', ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; }
  catch { return { brand_name: '', brand_tagline: 'End-user guide' }; }
}
function saveSettings(s) {
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}

// ─── Jobs store (JSON-file port of the SQLite registry) ───────────────────────

const jobs = new Map();
try {
  for (const [id, job] of Object.entries(JSON.parse(fs.readFileSync(jobsFile, 'utf8')))) jobs.set(id, job);
} catch { /* first run */ }

let persistTimer = null;
function persistJobs() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    fs.writeFile(jobsFile, JSON.stringify(Object.fromEntries(jobs)), () => {});
  }, 200);
}

function createJob(fields) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    status: 'queued', progress: 0, frame_count: 0,
    error: null, pdf_path: null, result: null,
    created_at: new Date().toISOString(),
    ...fields,
  });
  persistJobs();
  return id;
}

function updateJob(id, fields) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, fields);
  persistJobs();
}

// ─── Prompt presets (verbatim from services/prompts.py) ───────────────────────

const TECH_DOC = `You are a technical writer producing a polished end-user guide based on a screen recording of a user working with a software interface.

You receive frames from the video in chronological order (frame_index starts at 0). Output a single JSON object — no markdown wrapper, no commentary — matching this exact shape:

{
  "doc_title": "Short title in sentence case (e.g. \\"Setting Primary and Secondary Vendors\\")",
  "header_short": "Slightly longer descriptive header used in the page header (e.g. \\"Primary and Secondary Vendors on the Case Form\\")",
  "system_name": "The product or system shown in the video, including module/version if visible (e.g. \\"Dynamics 365 CRM Sales Connect\\"). Empty string if not identifiable.",
  "intro": "One or two sentences describing what the guide covers, written in the same tone as a professional end-user manual.",
  "sections": [
    {
      "title": "Section heading (e.g. \\"Method A. Case Details section\\" or \\"Save the Case\\" or \\"If the vendor is not in the list\\")",
      "body": "Optional introductory paragraph for the section. Empty string if not needed.",
      "steps": ["First imperative instruction.", "Second imperative instruction."],
      "figure": {
        "frame_index": 0,
        "caption": "Short caption describing what the screenshot shows (not what to do)."
      },
      "notes": ["Callout that belongs to this section. Begin with **Note:** when appropriate."]
    }
  ],
  "notes": [
    "Document-level callouts that do not belong to any single section."
  ]
}

REQUIREMENTS

1. LANGUAGE: Write ALL output in English, regardless of the UI language shown in the video. Do not translate UI element names that appear on screen — quote them verbatim and wrap them in **bold**.

2. STYLE: Match the tone of a professional end-user guide:
   - Concise, imperative steps starting with verbs ("Click", "Type", "Select", "Open").
   - Each step is 1-2 sentences.
   - Use **bold** (markdown) to highlight UI element names: button labels, field names, tabs, menu items, panel names.
   - Use *italic* for emphasis on states or values (e.g. *Saved*, *Unsaved*).

3. STRUCTURE:
   - Break the procedure into 1-8 SECTIONS. A section is a method, a stage, or a logically distinct cluster of steps.
   - Each section MAY have a \`body\` paragraph, a list of \`steps\`, and at most one \`figure\`.
   - For pure reference sections without steps (e.g. "If the vendor is not in the list"), put the explanation in \`body\` and leave \`steps\` as \`[]\`.
   - Include a \`figure\` for every section that has a visually meaningful frame to show. Aim for one figure per section when possible.

4. FIGURES:
   - \`frame_index\` MUST be a valid index into the supplied frames (0-based).
   - Captions describe what is visible in the screenshot, not the action to take.
   - Use as many figures as needed to make the guide visually clear — there are plenty of frames available.

5. NOTES:
   - Section-level \`notes\` belong to a specific section and render immediately after that section (after its figure). Use them for requirements or clarifications that belong to one method/stage.
   - Document-level \`notes\` (at the root) are for global callouts that apply across the whole guide. Prefer section-level notes when the note logically belongs to one section.
   - Keep each note to 1-3 sentences. Start with **Note:** if it is a clarification.

6. GROUNDING: Refer ONLY to what is actually visible in the frames. Do not invent UI elements, shortcuts, or behaviour. If a field name is partially obscured or unclear, omit it rather than guess.

7. OUTPUT: Return ONLY the JSON object. No prose before or after. No \`\`\`json fences.`;

const TRANSCRIPT = `You are a meticulous observer producing a chronological transcript of a screen recording.

You receive frames from the video in chronological order (frame_index starts at 0). Output a single JSON object matching this exact shape:

{
  "doc_title": "Transcript title (e.g. \\"Walkthrough of Vendor Selection on Case Form\\")",
  "header_short": "Brief header for the page header",
  "system_name": "Software / system shown (or empty string)",
  "intro": "One paragraph: what happens overall in the recording.",
  "sections": [
    {
      "title": "Chronological chunk title with approximate timestamp (e.g. \\"00:00-00:15 — Opening the case form\\")",
      "body": "Detailed description of what the user does and what the UI shows during this chunk.",
      "steps": [],
      "figure": { "frame_index": 0, "caption": "What the screenshot shows." },
      "notes": []
    }
  ],
  "notes": []
}

REQUIREMENTS:
1. LANGUAGE: Write ALL output in English. Quote UI element names verbatim, wrap them in **bold**.
2. CHRONOLOGY: Sections are TIME-ORDERED chunks of roughly equal duration (5-30 seconds each). Use 5-15 sections.
3. DESCRIPTIVE: \`body\` is narrative observation, not instructions. Describe what is visible, what changes, what the user clicks.
4. FIGURES: Include a figure in every section. \`frame_index\` MUST be a valid 0-based index.
5. GROUNDING: Only describe what is visible. Do not infer purposes.
6. OUTPUT: Return ONLY the JSON object.`;

const BUG_REPORT = `You are a QA engineer producing a bug/incident report from a screen recording.

You receive frames from the video in chronological order (frame_index starts at 0). Output a single JSON object matching this exact shape:

{
  "doc_title": "Concise bug summary (e.g. \\"Vendor dropdown does not filter results when typing\\")",
  "header_short": "Bug report header for the page header",
  "system_name": "Software / system shown",
  "intro": "One paragraph summary: what was attempted and what went wrong.",
  "sections": [
    { "title": "Environment", "body": "Software, browser, version visible in the frames.", "steps": [], "notes": [] },
    { "title": "Steps to Reproduce", "body": "", "steps": ["Step 1...", "Step 2..."], "figure": {"frame_index": 0, "caption": "..."} },
    { "title": "Expected Result", "body": "What should have happened.", "steps": [] },
    { "title": "Actual Result", "body": "What actually happened.", "steps": [], "figure": {"frame_index": 0, "caption": "Screenshot of the issue."} },
    { "title": "Additional Observations", "body": "Any other relevant detail.", "steps": [] }
  ],
  "notes": ["**Severity:** ...", "**Workaround:** ..."]
}

REQUIREMENTS:
1. LANGUAGE: English. UI element names in **bold**.
2. GROUNDING: Only what is visible. If unable to determine expected vs actual from the video alone, write what is most plausible and flag uncertainty.
3. FIGURES: Include figures in "Steps to Reproduce" and "Actual Result" sections at minimum.
4. OUTPUT: Return ONLY the JSON object.`;

const TUTORIAL = `You are a learning-content writer producing a tutorial-style guide from a screen recording.

You receive frames in chronological order (frame_index starts at 0). Output a single JSON object matching this exact shape:

{
  "doc_title": "Tutorial title (e.g. \\"How to Set Vendors on a Case in Dynamics 365\\")",
  "header_short": "Header for page chrome",
  "system_name": "Software shown",
  "intro": "Friendly one-paragraph intro: who this is for and what they'll learn.",
  "sections": [
    {
      "title": "Section title (e.g. \\"Before you start\\", \\"Step 1 — Open the case\\", \\"Why this matters\\")",
      "body": "Explanation including the *why*, not just the *what*. Provide context.",
      "steps": ["Concrete actions for the reader to perform."],
      "figure": { "frame_index": 0, "caption": "..." },
      "notes": ["**Tip:** ...", "**Note:** ..."]
    }
  ],
  "notes": []
}

REQUIREMENTS:
1. LANGUAGE: English. UI element names in **bold**.
2. STYLE: Friendly, instructional, with brief explanations of *why* each step exists.
3. STRUCTURE: 5-10 sections. Use tips and notes liberally to provide context.
4. FIGURES: A figure in nearly every step section.
5. OUTPUT: Return ONLY the JSON object.`;

const PRESETS = {
  technical_doc: {
    key: 'technical_doc', name: 'Technical Documentation',
    description: 'Polished end-user guide with sections, numbered steps, and figures.',
    prompt: TECH_DOC,
  },
  transcript: {
    key: 'transcript', name: 'Detailed Transcript',
    description: 'Chronological narrative of what happens on screen, chunk by chunk.',
    prompt: TRANSCRIPT,
  },
  bug_report: {
    key: 'bug_report', name: 'Bug Report',
    description: 'QA-style report: environment, steps to reproduce, expected vs actual.',
    prompt: BUG_REPORT,
  },
  tutorial: {
    key: 'tutorial', name: 'Tutorial',
    description: 'Friendly tutorial with explanations of why each step exists.',
    prompt: TUTORIAL,
  },
};
const DEFAULT_PRESET = 'technical_doc';

const USER_INSTRUCTION = 'Analyse the following frames extracted from a screen-recording in chronological order (frame_index = 0, 1, 2, ...). Produce the JSON document described in the system prompt.';

function buildSystemPrompt(presetKey, customPrompt, targetPages, customInstructions) {
  let base = (customPrompt && customPrompt.trim())
    ? customPrompt.trim()
    : (PRESETS[presetKey || DEFAULT_PRESET] || PRESETS[DEFAULT_PRESET]).prompt;
  if (targetPages && targetPages > 0) {
    base += `\n\nDOCUMENT LENGTH HINT: Aim for approximately ${targetPages} A4 page(s) `
      + 'of final output. Adjust the number of sections, depth of body text, and number '
      + 'of figures to roughly match this length.';
  }
  if (customInstructions && customInstructions.trim()) {
    base += '\n\nADDITIONAL INSTRUCTIONS FROM THE USER (apply these on top of the rules above):\n'
      + customInstructions.trim();
  }
  return base;
}

// ─── Models (port of services/openrouter.py) ──────────────────────────────────

const MODELS = {
  sonnet: {
    id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6',
    description: 'Anthropic. Fast and cheaper, good quality. Strong baseline.',
  },
  opus: {
    id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7',
    description: 'Anthropic. Maximum accuracy, slower and more expensive.',
  },
  gpt5: {
    id: 'openai/gpt-5', name: 'GPT-5',
    description: 'OpenAI. Latest flagship with strong reasoning and vision.',
  },
  gpt5_mini: {
    id: 'openai/gpt-5-mini', name: 'GPT-5 mini',
    description: 'OpenAI. Cheaper / faster variant of GPT-5. Good for iteration.',
  },
  gemini_pro: {
    id: 'google/gemini-2.5-pro', name: 'Gemini 2.5 Pro',
    description: 'Google. Large multimodal context, strong on UI screenshots.',
  },
  deepseek: {
    id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek v3.1',
    description: 'DeepSeek. Open-weights, very cheap. Vision support varies.',
  },
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function orHeaders() {
  return {
    'Authorization': `Bearer ${cfg.openrouterApiKey}`,
    'HTTP-Referer': cfg.appReferer,
    'X-Title': cfg.appTitle,
    'Content-Type': 'application/json',
  };
}

function extractJson(text) {
  let t = String(text).trim();
  const fenced = t.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced) t = fenced[1];
  try { return JSON.parse(t); }
  catch {
    const start = t.indexOf('{'), end = t.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('no JSON object found in model output');
  }
}

async function analyzeFrames(modelKey, framePaths, { customPrompt, preset, targetPages, customInstructions, transcriptText, actionsText }) {
  if (!MODELS[modelKey]) throw new Error(`Unknown model key: ${modelKey}`);
  if (!cfg.openrouterApiKey) throw new Error('OPENROUTER_API_KEY is not configured');
  if (!framePaths.length) throw new Error('No frames provided for analysis');

  const systemPrompt = buildSystemPrompt(preset, customPrompt, targetPages, customInstructions);
  const content = [{ type: 'text', text: USER_INSTRUCTION }];
  if (transcriptText && transcriptText.trim()) {
    content.push({
      type: 'text',
      text: 'Spoken-audio transcript of the same recording (timestamps in '
        + "seconds). Use it to disambiguate UI elements, follow the narrator's "
        + "intent, and capture rationale or tips you couldn't see from the "
        + 'frames alone. Do NOT copy the transcript verbatim — rewrite into '
        + 'the document format described in the system prompt.'
        + `\n\n--- TRANSCRIPT START ---\n${transcriptText.trim()}\n--- TRANSCRIPT END ---`,
    });
  }
  if (actionsText && actionsText.trim()) {
    content.push({ type: 'text', text: actionsText.trim() });
  }
  for (let i = 0; i < framePaths.length; i++) {
    const b64 = (await fsp.readFile(framePaths[i])).toString('base64');
    content.push({ type: 'text', text: `frame_index=${i}` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
  }

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: orHeaders(),
    body: JSON.stringify({
      model: MODELS[modelKey].id,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content },
      ],
      max_tokens: 12000,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(600_000),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}: ${bodyText.slice(0, 500)}`);
  const body = JSON.parse(bodyText);
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error(`Malformed OpenRouter response: ${bodyText.slice(0, 300)}`);
  try { return extractJson(text); }
  catch { throw new Error(`Model returned non-JSON content: ${text.slice(0, 500)}`); }
}

// ─── ffmpeg helpers (port of services/video.py) ───────────────────────────────

function run(cmd, args, { binaryOut = false } = {}) {
  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(cmd, args); }
    catch (e) { return resolve({ rc: -1, out: binaryOut ? Buffer.alloc(0) : '', err: String(e) }); }
    const out = [], err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('error', e => resolve({ rc: -1, out: binaryOut ? Buffer.alloc(0) : '', err: String(e) }));
    proc.on('close', rc => resolve({
      rc: rc ?? 0,
      out: binaryOut ? Buffer.concat(out) : Buffer.concat(out).toString(),
      err: Buffer.concat(err).toString(),
    }));
  });
}

let ffmpegOkCache = null;
async function ffmpegAvailable() {
  if (ffmpegOkCache !== null) return ffmpegOkCache;
  const [a, b] = await Promise.all([run('ffmpeg', ['-version']), run('ffprobe', ['-version'])]);
  ffmpegOkCache = a.rc === 0 && b.rc === 0;
  return ffmpegOkCache;
}

async function probeDuration(video) {
  const { rc, out, err } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', video,
  ]);
  if (rc !== 0) throw new Error(`ffprobe failed: ${err.trim()}`);
  const d = parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe returned non-numeric duration: ${out}`);
  return d;
}

function planForDuration(s) {
  if (s < 60)  return { fps: 1.0, useScene: false, defaultMaxFrames: 15, bucket: '<1min' };
  if (s < 180) return { fps: 0.5, useScene: false, defaultMaxFrames: 20, bucket: '1-3min' };
  if (s < 600) return { fps: 0.2, useScene: true,  defaultMaxFrames: 35, bucket: '3-10min' };
  return { fps: 0.1, useScene: true, defaultMaxFrames: 60, bucket: '10+min' };
}

function scaleExpr() {
  const s = cfg.frameLongSide;
  return `scale='if(gt(iw,ih),${s},-2)':'if(gt(iw,ih),-2,${s})'`;
}

async function listGlob(dir, prefix) {
  let names;
  try { names = await fsp.readdir(dir); } catch { return []; }
  return names.filter(n => n.startsWith(prefix) && n.endsWith('.jpg')).sort()
    .map(n => path.join(dir, n));
}

async function extractUniform(video, outDir, fps) {
  const pattern = path.join(outDir, 'uni_%05d.jpg');
  const { rc, err } = await run('ffmpeg', [
    '-y', '-i', video, '-vf', `fps=${fps.toFixed(4)},${scaleExpr()}`, '-q:v', '3', pattern,
  ]);
  const produced = await listGlob(outDir, 'uni_');
  if (rc !== 0 && !produced.length) {
    throw new Error(`ffmpeg uniform extraction failed: ${err.trim().slice(-400)}`);
  }
  return produced;
}

async function extractScene(video, outDir, threshold) {
  const pattern = path.join(outDir, 'scene_%05d.jpg');
  const { rc } = await run('ffmpeg', [
    '-y', '-i', video, '-vf', `select='gt(scene,${threshold})',${scaleExpr()}`,
    '-vsync', 'vfr', '-q:v', '3', pattern,
  ]);
  const produced = await listGlob(outDir, 'scene_');
  if (rc !== 0 && !produced.length) return [];
  return produced;
}

// Perceptual hash (port of imagehash.phash): 32x32 grayscale → 2D DCT-II →
// top-left 8x8 block compared against its median → 64-bit hash.
function dct1d(v) {
  const N = v.length, out = new Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += v[n] * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * N));
    out[k] = 2 * s;
  }
  return out;
}

async function phash(file) {
  const { rc, out } = await run('ffmpeg', [
    '-v', 'error', '-i', file, '-vf', 'scale=32:32', '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { binaryOut: true });
  if (rc !== 0 || out.length < 1024) return null;
  // rows → DCT along rows, then along columns (mirrors scipy axis=0 then axis=1)
  const m = [];
  for (let y = 0; y < 32; y++) m.push(Array.from(out.subarray(y * 32, y * 32 + 32)));
  const colT = [];
  for (let x = 0; x < 32; x++) colT.push(dct1d(m.map(row => row[x])));
  const full = [];
  for (let y = 0; y < 32; y++) full.push(dct1d(colT.map(col => col[y])));
  // full[y][x] — take 8x8 low-frequency block
  const low = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) low.push(full[y][x]);
  const sorted = [...low].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  const bits = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bits[i] = low[i] > median ? 1 : 0;
  return bits;
}

function hammingDist(a, b) {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
}

async function dedupFrames(frames, hammingThreshold = 2) {
  const kept = [], hashes = [];
  for (const f of frames) {
    const h = await phash(f);
    if (!h) continue;
    if (hashes.some(existing => hammingDist(h, existing) <= hammingThreshold)) continue;
    kept.push(f);
    hashes.push(h);
  }
  return kept;
}

function pruneToLimit(frames, limit) {
  if (frames.length <= limit) return frames;
  const step = frames.length / limit;
  return Array.from({ length: limit }, (_, i) => frames[Math.floor(i * step)]);
}

// ─── Smart (transcript-driven) extraction — port of smart_extract.py ─────────

async function extractAudio(videoPath, outDir) {
  const audioPath = path.join(outDir, 'audio.mp3');
  const { rc, err } = await run('ffmpeg', [
    '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', '-f', 'mp3', audioPath,
  ]);
  let size = 0;
  try { size = (await fsp.stat(audioPath)).size; } catch { /* missing */ }
  if (rc !== 0 || size < 1024) {
    const lines = err.trim().split('\n');
    throw new Error(`audio extraction failed: ${lines[lines.length - 1] || 'unknown ffmpeg error'}`);
  }
  return audioPath;
}

async function transcribe(audioPath) {
  if (!cfg.openrouterApiKey) throw new Error('OPENROUTER_API_KEY not configured');
  const stat = await fsp.stat(audioPath);
  const sizeMb = stat.size / 1024 / 1024;
  if (sizeMb > 18) throw new Error(`audio is ${sizeMb.toFixed(1)} MB; inline-base64 ceiling is ~18 MB`);
  const audioB64 = (await fsp.readFile(audioPath)).toString('base64');

  const system = 'You transcribe an audio recording of a screen walkthrough into a '
    + 'chronological list of timestamped speech segments. Output ONLY JSON, '
    + 'no prose, no markdown, in the exact shape: '
    + '{"segments": [{"start": float_seconds, "end": float_seconds, "text": "..."}]}.\n\n'
    + 'Rules:\n'
    + '- Segments are coherent utterances (typically 2-15 seconds each).\n'
    + '- Timestamps are in seconds from the start of the audio.\n'
    + "- Preserve the speaker's language; do not translate.\n"
    + '- If the audio is silent, return {"segments": []}.';

  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: orHeaders(),
    body: JSON.stringify({
      model: cfg.audioTranscribeModel,
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Transcribe this audio. Return JSON only.' },
            { type: 'input_audio', input_audio: { data: audioB64, format: 'mp3' } },
          ],
        },
      ],
      max_tokens: 8000,
      temperature: 0.0,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const bodyText = await resp.text();
  if (!resp.ok) throw new Error(`transcription HTTP ${resp.status}: ${bodyText.slice(0, 400)}`);
  const text = JSON.parse(bodyText)?.choices?.[0]?.message?.content ?? '';
  let data;
  try { data = extractJson(text); }
  catch (e) { throw new Error(`transcription returned non-JSON: ${e.message}`); }
  const segments = (data.segments || [])
    .filter(s => (s.text || '').trim())
    .map(s => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text).trim() }));
  if (!segments.length) throw new Error('transcription returned no speech segments');
  return segments;
}

function equalBuckets(segments, nChunks, durationS) {
  nChunks = Math.max(1, nChunks);
  let dur = durationS;
  if (dur <= 0 && segments.length) dur = Math.max(...segments.map(s => s.end));
  if (dur <= 0) dur = 1;
  const step = dur / nChunks;
  const chunks = [];
  for (let i = 0; i < nChunks; i++) {
    const start = i * step, end = Math.min(dur, (i + 1) * step);
    const textInBucket = segments
      .filter(s => s.end >= start && s.start <= end)
      .map(s => s.text).join(' ');
    const topic = (textInBucket.split('.')[0].slice(0, 70) || `Chunk ${i + 1}`).trim();
    chunks.push({ start, end, topic });
  }
  return chunks;
}

async function segmentIntoTopics(segments, nChunks, durationS) {
  nChunks = Math.max(1, nChunks);
  if (!cfg.openrouterApiKey || segments.length <= 1) return equalBuckets(segments, nChunks, durationS);

  const transcriptText = segments.map(s => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`).join('\n');
  const system = 'You split a timestamped transcript of a screen recording into a '
    + 'chronological list of topical chunks. Each chunk is a coherent '
    + 'sub-task or stage of the recording. Output only JSON in the exact '
    + 'shape: {"chunks": [{"start_s": float, "end_s": float, "topic": "short label"}]}.\n\n'
    + 'Rules:\n'
    + '- Produce EXACTLY N chunks (where N is given by the user).\n'
    + '- Chunks must be contiguous: chunks[0].start_s = 0, chunks[i].start_s = '
    + "chunks[i-1].end_s, last chunk ends at the recording's total duration.\n"
    + '- Pick boundaries where the topic / sub-task changes.\n'
    + '- Topic labels are short (3-7 words), in English.';
  const user = `N = ${nChunks}\nTotal duration (seconds) = ${durationS.toFixed(1)}\n\n`
    + `Transcript (start-end seconds in brackets):\n${transcriptText}\n\nReturn the JSON.`;

  let data;
  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: orHeaders(),
      body: JSON.stringify({
        model: cfg.transcriptModel,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        max_tokens: 2000,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const bodyText = await resp.text();
    if (!resp.ok) throw new Error(`transcript_model HTTP ${resp.status}: ${bodyText.slice(0, 200)}`);
    data = extractJson(JSON.parse(bodyText)?.choices?.[0]?.message?.content ?? '');
  } catch (e) {
    console.warn('[doc-agent] topic segmentation LLM failed (%s); using equal buckets', e.message);
    return equalBuckets(segments, nChunks, durationS);
  }

  let chunks = [];
  for (const c of data.chunks || []) {
    const start = Number(c.start_s), end = Number(c.end_s);
    const topic = String(c.topic || '').trim() || 'Untitled';
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) chunks.push({ start, end, topic });
  }
  if (chunks.length < 2) return equalBuckets(segments, nChunks, durationS);

  chunks.sort((a, b) => a.start - b.start);
  const lastEnd = chunks[chunks.length - 1].end;
  if (lastEnd > durationS * 1.05) {
    const scale = durationS / lastEnd;
    chunks = chunks.map(c => ({ start: c.start * scale, end: c.end * scale, topic: c.topic }));
  }
  if (chunks.length > nChunks) chunks = chunks.slice(0, nChunks);
  return chunks;
}

async function snipFrameAt(videoPath, timestampS, outPath) {
  const { rc } = await run('ffmpeg', [
    '-y', '-ss', Math.max(0, timestampS).toFixed(3), '-i', videoPath,
    '-frames:v', '1', '-vf', scaleExpr(), '-q:v', '3', outPath,
  ]);
  try { return rc === 0 && (await fsp.stat(outPath)).size > 0; }
  catch { return false; }
}

async function smartExtract(videoPath, outDir, cap, durationS) {
  if (!cfg.smartExtraction || !cfg.openrouterApiKey) return null;

  const info = {};
  let audioPath;
  try { audioPath = await extractAudio(videoPath, outDir); }
  catch (e) {
    console.warn('[doc-agent] smart: audio extract failed (%s); falling back', e.message);
    return null;
  }
  info.audio_size_kb = Math.round((await fsp.stat(audioPath)).size / 1024 * 10) / 10;

  let segments;
  try { segments = await transcribe(audioPath); }
  catch (e) {
    console.warn('[doc-agent] smart: transcription failed (%s); falling back', e.message);
    return null;
  }
  info.transcript_segments = segments.length;

  const chunks = await segmentIntoTopics(segments, cap, durationS);
  info.topic_chunks = chunks.length;

  await fsp.writeFile(path.join(outDir, 'transcript.json'), JSON.stringify({
    duration_s: durationS,
    segments,
    chunks: chunks.map(c => ({ start: c.start, end: c.end, topic: c.topic })),
  }, null, 2));

  const frames = [];
  for (let i = 0; i < chunks.length; i++) {
    const mid = (chunks[i].start + chunks[i].end) / 2;
    const target = path.join(outDir, `frame_${String(i).padStart(4, '0')}.jpg`);
    if (await snipFrameAt(videoPath, mid, target)) frames.push(target);
    else console.warn('[doc-agent] smart: failed to snip frame at %ss (chunk %d)', mid.toFixed(2), i);
  }
  if (!frames.length) {
    console.warn('[doc-agent] smart: produced 0 frames; falling back');
    return null;
  }
  info.smart = true;
  info.final_count = frames.length;
  return { frames, info };
}

// ─── Action (click) detection — Scribe-style frame selection ──────────────────
// Clicks are recovered from the video itself: a click almost always produces a
// burst of on-screen change (dropdown opens, dialog appears, page navigates).
// We scan a low-res grayscale stream for stable→burst transitions and snip the
// full-res frame just BEFORE each burst (the screen the user acted on), plus a
// "result" frame after large transitions (page changes). Frame count therefore
// equals the number of detected actions — no slider guessing needed.

const ACTION_FPS = 4;
const ACTION_W = 160, ACTION_H = 90;

async function actionDiffProfile(videoPath) {
  const { rc, out } = await run('ffmpeg', [
    '-v', 'error', '-i', videoPath,
    '-vf', `fps=${ACTION_FPS},scale=${ACTION_W}:${ACTION_H}`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { binaryOut: true });
  const frameBytes = ACTION_W * ACTION_H;
  if (rc !== 0 || out.length < frameBytes * 3) return null;
  const n = Math.floor(out.length / frameBytes);
  const diffs = new Float64Array(n); // diffs[i] = mean abs pixel delta frame i-1 → i
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * frameBytes, b = i * frameBytes;
    let sum = 0;
    for (let p = 0; p < frameBytes; p++) sum += Math.abs(out[b + p] - out[a + p]);
    diffs[i] = sum / frameBytes;
  }
  return diffs;
}

function detectActionEvents(diffs) {
  // Adaptive threshold above idle noise (cursor movement, caret blink). On
  // videos with continuous motion the baseline rises and few events fire —
  // the caller then falls back to the smart/visual pipelines.
  const sorted = [...diffs].slice(1).sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  const thr = Math.max(1.2, median * 5);
  const bigThr = Math.max(thr * 4, 12); // page-level transition

  const events = [];
  let i = 1;
  while (i < diffs.length) {
    if (diffs[i] > thr && diffs[i - 1] <= thr) {
      let j = i, magnitude = 0;
      // Follow the burst (allowing 1-sample dips) but cap the scan at 3s so a
      // playing animation can't swallow the whole timeline into one event.
      while (
        j < diffs.length && j - i < ACTION_FPS * 3
        && (diffs[j] > thr || (j + 1 < diffs.length && diffs[j + 1] > thr))
      ) {
        magnitude = Math.max(magnitude, diffs[j]);
        j++;
      }
      events.push({
        beforeT: Math.max(0, (i - 1) / ACTION_FPS),
        afterT: j / ACTION_FPS,
        magnitude,
        big: magnitude >= bigThr,
      });
      i = j + 1;
    } else i++;
  }

  // Merge bursts closer than 0.7s — double-clicks, dropdown open+select.
  const merged = [];
  for (const e of events) {
    const last = merged[merged.length - 1];
    if (last && e.beforeT - last.afterT < 0.7) {
      last.afterT = e.afterT;
      last.magnitude = Math.max(last.magnitude, e.magnitude);
      last.big = last.big || e.big;
    } else merged.push({ ...e });
  }
  return merged;
}

async function actionExtract(videoPath, outDir, cap, durationS) {
  const diffs = await actionDiffProfile(videoPath);
  if (!diffs) return null;
  const events = detectActionEvents(diffs);
  if (events.length < 2) {
    console.warn('[doc-agent] actions: only %d event(s) detected; falling back', events.length);
    return null;
  }

  let shots = [];
  if (events[0].beforeT > 1.5) shots.push({ t: 0.2, kind: 'initial', magnitude: Infinity });
  for (const e of events) {
    shots.push({ t: e.beforeT, kind: 'action', magnitude: e.magnitude });
    if (e.big) {
      shots.push({
        t: Math.min(e.afterT + 0.3, Math.max(0, durationS - 0.1)),
        kind: 'result',
        magnitude: e.magnitude * 0.9,
      });
    }
  }
  if (shots.length > cap) {
    shots.sort((a, b) => b.magnitude - a.magnitude);
    shots = shots.slice(0, cap);
  }
  shots.sort((a, b) => a.t - b.t);

  const candidates = [];
  for (let i = 0; i < shots.length; i++) {
    const target = path.join(outDir, `act_${String(i).padStart(4, '0')}.jpg`);
    if (await snipFrameAt(videoPath, shots[i].t, target)) {
      candidates.push({ p: target, shot: shots[i] });
    }
  }
  if (candidates.length < 2) {
    for (const c of candidates) await fsp.unlink(c.p).catch(() => {});
    return null;
  }

  // Drop near-identical shots (e.g. a dropdown that closed back to the same
  // screen) with the same pHash dedup the visual pipeline uses.
  const keptSet = new Set(await dedupFrames(candidates.map(c => c.p)));
  const final = candidates.filter(c => keptSet.has(c.p));
  for (const c of candidates) {
    if (!keptSet.has(c.p)) await fsp.unlink(c.p).catch(() => {});
  }

  const frames = [], framesMeta = [];
  for (let i = 0; i < final.length; i++) {
    const target = path.join(outDir, `frame_${String(i).padStart(4, '0')}.jpg`);
    await fsp.rename(final[i].p, target);
    frames.push(target);
    framesMeta.push({
      index: i,
      t: Math.round(final[i].shot.t * 10) / 10,
      kind: final[i].shot.kind,
    });
  }

  await fsp.writeFile(path.join(outDir, 'actions.json'), JSON.stringify({
    events_detected: events.length,
    frames: framesMeta,
  }, null, 2));

  // Best-effort transcript: frames come from action detection, but narration
  // (when present) still improves the analysis. Silent skip on no-audio.
  let transcriptSegments = 0;
  try {
    const audioPath = await extractAudio(videoPath, outDir);
    const segments = await transcribe(audioPath);
    await fsp.writeFile(path.join(outDir, 'transcript.json'), JSON.stringify({
      duration_s: durationS, segments, chunks: [],
    }, null, 2));
    transcriptSegments = segments.length;
  } catch { /* most recordings have no narration */ }

  return {
    frames,
    info: {
      events_detected: events.length,
      shots_planned: shots.length,
      transcript_segments: transcriptSegments,
      final_count: frames.length,
    },
  };
}

async function loadActions(framesDir) {
  try { return JSON.parse(await fsp.readFile(path.join(framesDir, 'actions.json'), 'utf8')); }
  catch { return null; }
}

function actionsSummaryForAnalysis(data) {
  const frames = data?.frames || [];
  if (!frames.length) return null;
  const lines = frames.map(f => `frame_index=${f.index} → ${Number(f.t).toFixed(1)}s (${f.kind})`);
  return 'Frames were captured automatically at the moments of detected user '
    + 'actions (bursts of on-screen change — typically clicks or page '
    + 'transitions). "initial" is the starting screen, "action" is the screen '
    + 'right before the user acted, "result" is the screen after a major '
    + 'transition settled. Frame → video timestamp map:\n'
    + lines.join('\n');
}

async function loadTranscript(framesDir) {
  try { return JSON.parse(await fsp.readFile(path.join(framesDir, 'transcript.json'), 'utf8')); }
  catch { return null; }
}

function transcriptSummaryForAnalysis(data) {
  const segments = data?.segments || [];
  if (!segments.length) return null;
  const lines = [];
  for (const s of segments) {
    const start = Number(s.start);
    if (Number.isFinite(start) && s.text) lines.push(`[${start.toFixed(1)}s] ${s.text}`);
  }
  return lines.length ? lines.join('\n') : null;
}

// ─── Frame extraction orchestrator (port of video.extract_frames) ─────────────

// mode: 'auto' (action detection → smart → visual), 'smart' (transcript-driven
// → visual), 'manual' (visual pipeline with the user-provided frame cap).
export async function extractFrames(videoPath, outDir, maxFrames, mode = 'auto') {
  await fsp.mkdir(outDir, { recursive: true });
  for (const f of await listGlob(outDir, '')) await fsp.unlink(f).catch(() => {});

  const duration = await probeDuration(videoPath);
  const plan = planForDuration(duration);
  let cap = (maxFrames && maxFrames > 0) ? maxFrames : plan.defaultMaxFrames;
  cap = Math.max(5, Math.min(cap, cfg.maxFramesHardLimit));

  if (mode === 'auto') {
    // Action count is organic — the cap only guards against noisy videos, so
    // give it more headroom than the duration-based default.
    const actionCap = (maxFrames && maxFrames > 0)
      ? cap
      : Math.min(cfg.maxFramesHardLimit, Math.max(plan.defaultMaxFrames * 2, 40));
    const actionResult = await actionExtract(videoPath, outDir, actionCap, duration);
    if (actionResult) {
      return {
        frames: actionResult.frames,
        info: {
          strategy: 'actions',
          duration_s: Math.round(duration * 100) / 100,
          cap_applied: actionCap,
          ...actionResult.info,
        },
      };
    }
    // Clean partial action artefacts before trying the next strategy.
    for (const f of await listGlob(outDir, '')) await fsp.unlink(f).catch(() => {});
    await fsp.unlink(path.join(outDir, 'actions.json')).catch(() => {});
    await fsp.unlink(path.join(outDir, 'transcript.json')).catch(() => {});
  }

  if (mode !== 'manual') {
    const smartResult = await smartExtract(videoPath, outDir, cap, duration);
    if (smartResult) {
      return {
        frames: smartResult.frames,
        info: { strategy: 'smart', duration_s: Math.round(duration * 100) / 100, cap_applied: cap, ...smartResult.info },
      };
    }
  }

  // Visual fallback: clean partial smart artefacts first.
  for (const f of await listGlob(outDir, '')) await fsp.unlink(f).catch(() => {});
  await fsp.unlink(path.join(outDir, 'transcript.json')).catch(() => {});

  let candidates = await extractUniform(videoPath, outDir, plan.fps);
  if (plan.useScene) {
    const scene = await extractScene(videoPath, outDir, cfg.sceneThreshold);
    candidates = [...candidates, ...scene].sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  }

  let deduped = await dedupFrames(candidates);
  if (deduped.length < Math.floor(Math.min(cap, candidates.length) / 2)) deduped = candidates;
  const final = pruneToLimit(deduped, cap);

  const renumbered = [];
  for (let i = 0; i < final.length; i++) {
    const target = path.join(outDir, `frame_${String(i).padStart(4, '0')}.jpg`);
    if (final[i] !== target) await fsp.rename(final[i], target);
    renumbered.push(target);
  }
  for (const stray of [...await listGlob(outDir, 'uni_'), ...await listGlob(outDir, 'scene_')]) {
    await fsp.unlink(stray).catch(() => {});
  }

  return {
    frames: renumbered,
    info: {
      strategy: 'visual',
      duration_s: Math.round(duration * 100) / 100,
      bucket: plan.bucket,
      fps_used: plan.fps,
      scene_detection: plan.useScene,
      candidates_total: candidates.length,
      after_dedup: deduped.length,
      final_count: renumbered.length,
      cap_applied: cap,
    },
  };
}

const FRAME_FILE_RE = /^frame_(\d+)\.jpg$/;

function listFrameFiles(jobId) {
  const dir = path.join(framesRoot, jobId);
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map(n => { const m = n.match(FRAME_FILE_RE); return m ? { idx: Number(m[1]), p: path.join(dir, n) } : null; })
    .filter(Boolean)
    .sort((a, b) => a.idx - b.idx)
    .map(x => x.p);
}

// ─── PDF builder (port of services/pdf_builder.py, reportlab → pdfkit) ────────

const CM = 28.3465;
const PAGE_W = 595.28, PAGE_H = 841.89; // A4
const MARGIN_L = 2 * CM, MARGIN_R = 2 * CM, MARGIN_TOP = 2.6 * CM, MARGIN_BOTTOM = 2 * CM;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const CONTENT_BOTTOM = PAGE_H - MARGIN_BOTTOM;

const NAVY = '#1F3864', NAVY_SOFT = '#2F5496', RULE = '#BFBFBF';
const TEXT_C = '#1F2937', MUTED = '#6B7280', NOTE_BG = '#EAF1FB', NOTE_BORDER = '#5B9BD5';

const F = 'Helvetica', FB = 'Helvetica-Bold', FI = 'Helvetica-Oblique', FBI = 'Helvetica-BoldOblique';

// Split markdown **bold** / *italic* into styled runs for pdfkit.
function inlineRuns(text, { baseFont = F, boldFont = FB, italicFont = FI } = {}) {
  const runs = [];
  const s = text == null ? '' : String(text);
  const re = /\*\*([\s\S]+?)\*\*|(?<!\*)\*(?!\*)([\s\S]+?)(?<!\*)\*(?!\*)/g;
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) runs.push({ text: s.slice(last, m.index), font: baseFont });
    if (m[1] !== undefined) runs.push({ text: m[1], font: boldFont });
    else runs.push({ text: m[2], font: italicFont });
    last = m.index + m[0].length;
  }
  if (last < s.length) runs.push({ text: s.slice(last), font: baseFont });
  return runs.filter(r => r.text);
}

function plainText(text) {
  return inlineRuns(text).map(r => r.text).join('');
}

// JPEG natural size (SOF marker scan) — pdfkit needs explicit fit boxes.
function jpegSize(file) {
  const buf = fs.readFileSync(file);
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return { w: 16, h: 9 };
}

export function buildPdf(outputPath, result, framePaths, settings) {
  return new Promise((resolve, reject) => {
    const headerTitle = String(result.header_short || result.doc_title || '').trim();
    const systemName = String(result.system_name || '').trim();
    const brand = (settings.brand_name || '').trim();
    const tagline = (settings.brand_tagline || '').trim();
    const footerLeft = brand && tagline ? `${brand} | ${tagline}` : (brand || tagline || '');

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_L, right: MARGIN_R },
      info: { Title: result.doc_title || 'End-user guide', Author: brand || 'Document Agent' },
      autoFirstPage: false,
    });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);

    let pageNo = 0;
    function paintChrome() {
      pageNo++;
      const y = doc.y, x = doc.x;
      // Zero the bottom margin while painting: pdfkit auto-adds a page when
      // text lands below maxY, and the footer lives in the margin area —
      // without this the pageAdded handler recurses forever.
      const oldBottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.save();
      doc.font(FB).fontSize(9).fillColor(NAVY);
      doc.text(headerTitle, MARGIN_L, 33, { width: CONTENT_W * 0.7, lineBreak: false });
      doc.text(systemName, MARGIN_L, 33, { width: CONTENT_W, align: 'right', lineBreak: false });
      doc.moveTo(MARGIN_L, 43.7).lineTo(PAGE_W - MARGIN_R, 43.7)
        .lineWidth(0.6).strokeColor(NAVY_SOFT).stroke();

      doc.font(F).fontSize(9).fillColor(MUTED);
      doc.text(footerLeft, MARGIN_L, 801, { width: CONTENT_W * 0.7, lineBreak: false });
      doc.text(`Page ${pageNo}`, MARGIN_L, 801, { width: CONTENT_W, align: 'right', lineBreak: false });
      doc.moveTo(MARGIN_L, 795.9).lineTo(PAGE_W - MARGIN_R, 795.9)
        .lineWidth(0.4).strokeColor(RULE).stroke();
      doc.restore();
      doc.page.margins.bottom = oldBottom;
      doc.x = x; doc.y = y;
    }
    doc.on('pageAdded', paintChrome);
    doc.addPage();
    doc.x = MARGIN_L;
    doc.y = MARGIN_TOP;

    const ensureSpace = (needed) => {
      if (doc.y + needed > CONTENT_BOTTOM) {
        doc.addPage();
        doc.x = MARGIN_L;
        doc.y = MARGIN_TOP;
      }
    };

    function styledText(text, { font = F, size = 11, color = TEXT_C, lineGap = 4.4, width = CONTENT_W, x = MARGIN_L, align = 'left', boldFont = FB, italicFont = FI } = {}) {
      const runs = inlineRuns(text, { baseFont: font, boldFont, italicFont });
      if (!runs.length) return;
      doc.fontSize(size).fillColor(color);
      for (let i = 0; i < runs.length; i++) {
        doc.font(runs[i].font);
        const opts = { width, lineGap, align, continued: i < runs.length - 1 };
        if (i === 0) doc.text(runs[i].text, x, doc.y, opts);
        else doc.text(runs[i].text, opts);
      }
    }

    function figure(framePath, caption, num) {
      let dims;
      try { dims = jpegSize(framePath); } catch { return; }
      const aspect = dims.w ? dims.h / dims.w : 0.5625;
      let w = CONTENT_W, h = w * aspect;
      const maxH = 10.5 * CM;
      if (h > maxH) { h = maxH; w = aspect ? h / aspect : CONTENT_W; }

      const capText = caption ? `Figure ${num}. ${plainText(caption)}` : `Figure ${num}.`;
      doc.font(FI).fontSize(9.5);
      const capH = doc.heightOfString(capText, { width: CONTENT_W, lineGap: 2.5 });
      ensureSpace(h + capH + 18);

      try {
        doc.image(framePath, MARGIN_L + (CONTENT_W - w) / 2, doc.y, { width: w, height: h });
      } catch { return; }
      doc.y += h + 4;
      doc.font(FI).fontSize(9.5).fillColor(MUTED)
        .text(capText, MARGIN_L, doc.y, { width: CONTENT_W, align: 'center', lineGap: 2.5 });
      doc.y += 10;
      doc.x = MARGIN_L;
    }

    function noteBlock(text) {
      const inner = plainText(text);
      doc.font(F).fontSize(10.5);
      const th = doc.heightOfString(inner, { width: CONTENT_W - 24, lineGap: 3.5 });
      const blockH = th + 20;
      ensureSpace(blockH + 6);
      const top = doc.y;
      doc.save();
      doc.rect(MARGIN_L, top, CONTENT_W, blockH).fill(NOTE_BG);
      doc.rect(MARGIN_L, top, 3, blockH).fill(NOTE_BORDER);
      doc.restore();
      doc.y = top + 10;
      styledText(text, { size: 10.5, lineGap: 3.5, width: CONTENT_W - 24, x: MARGIN_L + 12 });
      doc.y = top + blockH + 6;
      doc.x = MARGIN_L;
    }

    // Title + intro
    styledText(result.doc_title || 'End-user guide', { font: FB, size: 26, color: NAVY, lineGap: 6, boldFont: FB, italicFont: FBI });
    doc.y += 8;
    if (result.intro) {
      styledText(result.intro, { size: 11, lineGap: 4 });
      doc.y += 4;
    }
    doc.y += 4;
    doc.moveTo(MARGIN_L, doc.y).lineTo(PAGE_W - MARGIN_R, doc.y)
      .lineWidth(0.8).strokeColor(RULE).stroke();
    doc.y += 8;

    let figureCounter = 0;
    for (const section of result.sections || []) {
      const { title, body, steps = [], figure: fig, notes = [] } = section || {};
      if (title) {
        ensureSpace(40);
        doc.y += 14;
        styledText(title, { font: FB, size: 16, color: NAVY, lineGap: 6, italicFont: FBI });
        doc.y += 8;
      }
      if (body) {
        styledText(body, { size: 11, lineGap: 4.4 });
        doc.y += 6;
      }
      let stepNo = 0;
      for (const step of steps) {
        stepNo++;
        ensureSpace(20);
        styledText(`${stepNo}. ${step}`, { size: 11, lineGap: 4.4, width: CONTENT_W - 14, x: MARGIN_L + 14 });
        doc.y += 4;
        doc.x = MARGIN_L;
      }
      if (fig && typeof fig === 'object') {
        const idx = fig.frame_index;
        if (Number.isInteger(idx) && idx >= 0 && idx < framePaths.length) {
          figureCounter++;
          doc.y += 6;
          figure(framePaths[idx], fig.caption || '', figureCounter);
        }
      }
      for (const note of notes) {
        if (!note) continue;
        doc.y += 6;
        noteBlock(note);
      }
    }

    for (const note of result.notes || []) {
      if (!note) continue;
      doc.y += 6;
      noteBlock(note);
    }

    doc.end();
  });
}

// ─── Pipeline orchestrators (port of workers/pipeline.py) ─────────────────────

async function runPipeline(jobId, videoPath, modelKey, preset, customPrompt, maxFrames, targetPages, customInstructions, extractionMode) {
  try {
    updateJob(jobId, { status: 'extracting', progress: 10 });
    const framesDir = path.join(framesRoot, jobId);
    const { frames, info } = await extractFrames(videoPath, framesDir, maxFrames, extractionMode);
    if (!frames.length) throw new Error('No frames extracted from video');
    console.log('[doc-agent] extraction info for %s: %j', jobId, info);
    updateJob(jobId, { frame_count: frames.length, progress: 35, extraction_strategy: info.strategy });

    updateJob(jobId, { status: 'analyzing', progress: 45 });
    const transcript = await loadTranscript(framesDir);
    const transcriptText = transcriptSummaryForAnalysis(transcript);
    const actionsText = actionsSummaryForAnalysis(await loadActions(framesDir));
    const result = await analyzeFrames(modelKey, frames, {
      customPrompt, preset, targetPages, customInstructions, transcriptText, actionsText,
    });
    updateJob(jobId, { result, progress: 80 });

    updateJob(jobId, { status: 'building_pdf', progress: 85 });
    const pdfPath = path.join(outputDir, `${jobId}.pdf`);
    await buildPdf(pdfPath, result, frames, loadSettings());

    updateJob(jobId, { status: 'done', progress: 100, pdf_path: pdfPath });
  } catch (e) {
    console.error(`[doc-agent] pipeline failed for job ${jobId}:`, e);
    updateJob(jobId, { status: 'failed', error: `${e.name || 'Error'}: ${e.message}` });
  }
}

async function runRegenerate(jobId, modelKey, preset, customPrompt, customInstructions, targetPages) {
  try {
    const frames = listFrameFiles(jobId);
    if (!frames.length) throw new Error('No frames remain for this job. Restore or re-run extraction.');
    updateJob(jobId, {
      status: 'analyzing', progress: 30, error: null, model: modelKey,
      preset, custom_prompt: customPrompt, custom_instructions: customInstructions,
      target_pages: targetPages, frame_count: frames.length,
    });
    const transcript = await loadTranscript(path.join(framesRoot, jobId));
    const transcriptText = transcriptSummaryForAnalysis(transcript);
    const actionsText = actionsSummaryForAnalysis(await loadActions(path.join(framesRoot, jobId)));
    const result = await analyzeFrames(modelKey, frames, {
      customPrompt, preset, targetPages, customInstructions, transcriptText, actionsText,
    });
    updateJob(jobId, { result, progress: 80 });

    updateJob(jobId, { status: 'building_pdf', progress: 85 });
    const pdfPath = path.join(outputDir, `${jobId}.pdf`);
    await buildPdf(pdfPath, result, frames, loadSettings());

    updateJob(jobId, { status: 'done', progress: 100, pdf_path: pdfPath });
  } catch (e) {
    console.error(`[doc-agent] regenerate failed for job ${jobId}:`, e);
    updateJob(jobId, { status: 'failed', error: `${e.name || 'Error'}: ${e.message}` });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const ALLOWED_VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: cfg.maxVideoMb * 1024 * 1024 },
});

export function registerDocumentAgentRoutes(app) {
  const base = '/api/doc-agent';

  app.get(`${base}/health`, async (req, res) => {
    const ffmpegOk = await ffmpegAvailable();
    res.json({
      ok: true,
      ffmpeg: ffmpegOk,
      openrouter_key: !!cfg.openrouterApiKey,
      smart_extraction: cfg.smartExtraction && !!cfg.openrouterApiKey,
      models: Object.keys(MODELS),
    });
  });

  app.get(`${base}/options`, (req, res) => {
    res.json({
      models: Object.entries(MODELS).map(([key, v]) => ({ key, name: v.name, description: v.description })),
      presets: Object.values(PRESETS).map(p => ({ key: p.key, name: p.name, description: p.description, prompt: p.prompt })),
      default_preset: DEFAULT_PRESET,
      max_frames_hard_limit: cfg.maxFramesHardLimit,
      default_target_pages: 3,
      max_video_mb: cfg.maxVideoMb,
    });
  });

  app.get(`${base}/settings`, (req, res) => {
    const s = loadSettings();
    res.json({ openrouter_key_set: !!cfg.openrouterApiKey, brand_name: s.brand_name, brand_tagline: s.brand_tagline });
  });

  app.post(`${base}/settings`, express.json({ limit: '10kb' }), (req, res) => {
    const s = loadSettings();
    if (typeof req.body?.brand_name === 'string') s.brand_name = req.body.brand_name;
    if (typeof req.body?.brand_tagline === 'string') s.brand_tagline = req.body.brand_tagline;
    saveSettings(s);
    res.json({ openrouter_key_set: !!cfg.openrouterApiKey, brand_name: s.brand_name, brand_tagline: s.brand_tagline });
  });

  app.post(`${base}/analyze`, (req, res) => {
    upload.single('video')(req, res, async (err) => {
      if (err) {
        const tooBig = err.code === 'LIMIT_FILE_SIZE';
        return res.status(tooBig ? 413 : 400).json({
          error: tooBig ? `File exceeds ${cfg.maxVideoMb}MB limit` : String(err.message || err),
        });
      }
      try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No video file uploaded' });
        const model = req.body.model || 'sonnet';
        const preset = req.body.preset || null;
        const customPrompt = req.body.custom_prompt || null;
        const customInstructions = req.body.custom_instructions || null;
        const maxFrames = req.body.max_frames ? Number(req.body.max_frames) : null;
        const targetPages = req.body.target_pages ? Number(req.body.target_pages) : null;
        const extractionMode = req.body.extraction_mode || 'auto';

        const fail = (code, msg) => {
          fs.unlink(file.path, () => {});
          return res.status(code).json({ error: msg });
        };
        if (!MODELS[model]) return fail(400, `Unknown model '${model}'. Use one of: ${Object.keys(MODELS).join(', ')}`);
        if (preset && !PRESETS[preset]) return fail(400, `Unknown preset '${preset}'. Use one of: ${Object.keys(PRESETS).join(', ')}`);
        if (!['auto', 'smart', 'manual'].includes(extractionMode)) {
          return fail(400, `Unknown extraction_mode '${extractionMode}'. Use auto, smart or manual`);
        }
        if (maxFrames != null && (maxFrames < 5 || maxFrames > cfg.maxFramesHardLimit)) {
          return fail(400, `max_frames must be between 5 and ${cfg.maxFramesHardLimit}`);
        }
        if (targetPages != null && (targetPages < 1 || targetPages > 20)) {
          return fail(400, 'target_pages must be between 1 and 20');
        }
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (!ALLOWED_VIDEO_EXT.has(ext)) {
          return fail(400, `Unsupported file type '${ext}'. Allowed: ${[...ALLOWED_VIDEO_EXT].sort().join(', ')}`);
        }

        const jobId = createJob({
          model, preset, custom_prompt: customPrompt,
          custom_instructions: customInstructions, target_pages: targetPages,
          extraction_mode: extractionMode,
        });
        const dest = path.join(uploadsDir, `${jobId}${ext}`);
        await fsp.rename(file.path, dest);

        // Fire-and-forget background pipeline (FastAPI BackgroundTasks port).
        runPipeline(jobId, dest, model, preset, customPrompt, maxFrames, targetPages, customInstructions, extractionMode);
        res.json({ job_id: jobId, status: 'queued' });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
      }
    });
  });

  app.get(`${base}/status/:jobId`, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json({
      job_id: req.params.jobId,
      status: job.status,
      progress: job.progress,
      model: job.model,
      frame_count: job.frame_count,
      error: job.error ?? null,
      pdf_ready: !!job.pdf_path && job.status === 'done',
    });
  });

  app.get(`${base}/result/:jobId`, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'done' || !job.pdf_path) {
      return res.status(409).json({ error: `Job not ready (status: ${job.status})` });
    }
    if (!fs.existsSync(job.pdf_path)) return res.status(410).json({ error: 'PDF file missing on disk' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="document-agent-${req.params.jobId.slice(0, 8)}.pdf"`);
    fs.createReadStream(job.pdf_path).pipe(res);
  });

  app.get(`${base}/result/:jobId/json`, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (!job.result) return res.status(409).json({ error: 'Analysis result not ready' });
    res.json(job.result);
  });

  app.get(`${base}/frames/:jobId`, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const indexes = listFrameFiles(req.params.jobId)
      .map(p => Number(path.basename(p).match(FRAME_FILE_RE)[1]));
    res.json({ job_id: req.params.jobId, indexes });
  });

  app.get(`${base}/frames/:jobId/:idx`, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0) return res.status(404).json({ error: 'Frame not found' });
    const framePath = path.join(framesRoot, req.params.jobId, `frame_${String(idx).padStart(4, '0')}.jpg`);
    if (!fs.existsSync(framePath)) return res.status(404).json({ error: 'Frame not found' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(framePath).pipe(res);
  });

  app.delete(`${base}/frames/:jobId/:idx`, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const idx = Number(req.params.idx);
    const framePath = path.join(framesRoot, req.params.jobId, `frame_${String(idx).padStart(4, '0')}.jpg`);
    if (!Number.isInteger(idx) || idx < 0 || !fs.existsSync(framePath)) {
      return res.status(404).json({ error: 'Frame not found' });
    }
    fs.unlinkSync(framePath);
    const remaining = listFrameFiles(req.params.jobId).length;
    updateJob(req.params.jobId, { frame_count: remaining });
    res.json({ deleted: idx, remaining });
  });

  app.post(`${base}/jobs/:jobId/regenerate`, express.json({ limit: '200kb' }), (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (['queued', 'extracting', 'analyzing', 'building_pdf'].includes(job.status)) {
      return res.status(409).json({ error: `Job is still running (status: ${job.status})` });
    }
    const body = req.body || {};
    const effectiveModel = body.model || job.model;
    if (!MODELS[effectiveModel]) return res.status(400).json({ error: `Unknown model '${effectiveModel}'` });
    if (body.preset && !PRESETS[body.preset]) return res.status(400).json({ error: `Unknown preset '${body.preset}'` });
    const targetPages = body.target_pages != null ? Number(body.target_pages) : null;
    if (targetPages != null && (targetPages < 1 || targetPages > 20)) {
      return res.status(400).json({ error: 'target_pages must be between 1 and 20' });
    }
    if (!listFrameFiles(jobId).length) return res.status(409).json({ error: 'No frames remain to analyse' });

    runRegenerate(jobId, effectiveModel, body.preset || null, body.custom_prompt || null, body.custom_instructions || null, targetPages);
    res.json({ job_id: jobId, status: 'queued' });
  });

  app.delete(`${base}/jobs/:jobId`, (req, res) => {
    const jobId = req.params.jobId;
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    fs.rmSync(path.join(framesRoot, jobId), { recursive: true, force: true });
    for (const f of fs.readdirSync(uploadsDir).filter(n => n.startsWith(`${jobId}.`))) {
      fs.unlinkSync(path.join(uploadsDir, f));
    }
    fs.rmSync(path.join(outputDir, `${jobId}.pdf`), { force: true });
    jobs.delete(jobId);
    persistJobs();
    res.json({ deleted: jobId });
  });
}
