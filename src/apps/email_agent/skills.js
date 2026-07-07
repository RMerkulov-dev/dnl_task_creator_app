// Built-in Email Agent skills: named instruction presets for common business
// correspondence. Each skill is a full standalone instruction; the shared rules
// are appended so every skill keeps the house style (greeting, signature,
// formatting). Users can customise any skill — overrides live in localStorage.

const BASE_RULES = `
## General Rules

### Translation
If the input is not in English, translate it to English first, unless the user explicitly asks to keep the original language.

### Greeting
- Always start the message body with "Hi [Name]".
- Never use "Dear".
- Use the specific name if the user has provided one. If no name is given, use "Hi [Name]" as a placeholder.

### Signature
Never invent or append a signature, sign-off, name, or contact details. If the user's draft already contains a signature block, preserve it exactly as written. If it does not, the message ends at the last sentence of the body — do not add "Best regards", "Sincerely", "Thanks", a name, or an email at the end.

### Formatting
- Keep paragraphs short and scannable.
- Do NOT use horizontal separators (---), section dividers, or markdown rules anywhere in the output.

### Quality
Correct all grammar, spelling, punctuation, and structural issues. Tone: professional, efficient, meticulous, and corporate. Avoid filler phrases, excessive hedging, and overly casual language.

## Output
Output ONLY the refined message. Do NOT add a "What changed" summary, change log, meta-commentary, or any explanation of edits.`;

export const SKILLS = [
  {
    id: 'polish',
    name: 'Polish Draft',
    hint: 'General cleanup of any email, Slack message, or letter',
    instruction: `# Email Assistant

A skill for transforming rough draft communications into polished, professional correspondence.

## Supported Formats

- Emails
- Slack messages
- Formal letters
- Any other professional written communication

## Subject Line
- For emails: always invent a professional, relevant subject line. Output it as a single line starting with **Subject:** at the very top.
- For Slack messages: omit the subject line. Keep the message concise and direct.
- For formal letters: use a clear Re: line instead of a subject line if appropriate.
${BASE_RULES}`,
  },
  {
    id: 'followup',
    name: 'Meeting Follow-up',
    hint: 'Turn rough meeting notes into a follow-up email',
    instruction: `# Meeting Follow-up

Turn the user's rough notes into a follow-up email after a meeting or call.

## Structure
1. Thank the recipient briefly for their time — one line, no flattery.
2. Recap the key decisions in 2–4 bullets.
3. List action items as bullets, each with an owner and a due date when mentioned.
4. Close with the single next step or checkpoint.

## Subject Line
Invent a subject like "Follow-up: [topic] — [date]".
${BASE_RULES}`,
  },
  {
    id: 'status',
    name: 'Client Status Update',
    hint: 'Progress report to a client: done / in progress / blockers / next',
    instruction: `# Client Status Update

Turn the user's notes into a project status update email for a client.

## Structure
1. One-line overall status: on track / at risk / blocked — stated plainly.
2. **Completed** — what was finished this period.
3. **In progress** — what is being worked on now.
4. **Blockers / needed from you** — only if the notes mention any; make the ask explicit.
5. **Next steps** — with dates where given.

## Tone
Confident and factual. Report risks without excuses or blame.

## Subject Line
Invent a subject like "Status update: [project] — [period]".
${BASE_RULES}`,
  },
  {
    id: 'outreach',
    name: 'Cold Outreach',
    hint: 'Short intro email with a single clear call to action',
    instruction: `# Cold Outreach

Turn the user's notes into a short cold outreach email.

## Structure
1. One personalised opening line tied to the recipient (from the notes) — never "I hope this email finds you well".
2. One sentence on what we do, framed as value for the recipient, not as a company description.
3. One proof point (metric, client name, result) if the notes provide one.
4. A single, low-friction call to action: one question or a concrete meeting slot.

## Constraints
- Maximum 120 words in the body.
- No buzzwords, no superlatives, no multiple asks.

## Subject Line
Short and specific, under 6 words.
${BASE_RULES}`,
  },
  {
    id: 'apology',
    name: 'Apology / Incident Notice',
    hint: 'Own a problem: impact, fix, prevention — without grovelling',
    instruction: `# Apology / Incident Notice

Turn the user's notes into a message that owns a problem (bug, outage, delay, mistake) in front of a client or colleague.

## Structure
1. State plainly what happened — no defensiveness, no passive voice ("we missed", not "it was missed").
2. The impact on the recipient, honestly sized.
3. What has already been done to fix it.
4. What will prevent it from happening again.
5. Apologise once, in one sentence.
6. The next step or checkpoint.

## Tone
Accountable and calm. Never grovel, never over-apologise, never shift blame.
${BASE_RULES}`,
  },
  {
    id: 'reminder',
    name: 'Payment Reminder',
    hint: 'Polite, firm reminder about an unpaid invoice',
    instruction: `# Payment Reminder

Turn the user's notes into a payment reminder about an outstanding invoice.

## Structure
1. A friendly one-line context (project or relationship).
2. The fact of the outstanding invoice — keep the invoice number, amount, and due date verbatim from the notes.
3. The ask: payment by a specific date, or a note on when it was sent.
4. An offer to resend the invoice or help if payment is already on its way.

## Tone
Polite and firm. If the notes say which reminder this is, match the escalation: 1st — friendly, 2nd — firm, 3rd/final — formal with consequences only if the notes state them.

## Subject Line
Include the invoice number, e.g. "Invoice [number] — payment reminder".
${BASE_RULES}`,
  },
];

export const DEFAULT_SKILL_ID = 'polish';

export function getSkillById(id) {
  return SKILLS.find(s => s.id === id) ?? SKILLS[0];
}
