// ─── Tasks Follow-up skills registry ──────────────────────────────────────────
//
// Each skill is a self-contained instruction set that is applied to a single
// call's transcript on the "Tasks Follow-up" tab. The instructions are sent to
// the executor model as a system prompt; the model first retrieves the chosen
// call's transcript through the Fathom MCP tools, then performs the task the
// instructions describe.
//
// To add a skill: append an entry with a unique `id`, a human `name`/`description`
// (shown in the tab's dropdown), and the full `instructions` text.

// Everything between the backticks is sent to the model as the skill's system
// prompt. The transcript is fetched automatically from Fathom before this runs,
// so the "ask for a transcript" branch never triggers in this tool.
const PASTED_SKILL_INSTRUCTIONS = `# Tasks Follow-Up (Cloud Skill)

Converts call transcripts into structured, copy-paste-ready project tasks for Jira, Linear, or similar backlog tools.

---

## Input

A full transcript of a client meeting, support call, or workshop. The user may paste it directly or upload it as a file.

If no transcript is provided, ask: "Please paste the call transcript so I can extract the tasks."

---

## Your Job

1. Read the entire transcript carefully.
2. Extract all actionable points.
3. Split them into separate, independent tasks (never combine unrelated requests).
4. For every task, produce the exact output structure below.
5. Detect and label:
   - **Urgent items**: anything described as ASAP, high priority, or where the client expects immediate action.
   - **Backlog items**: future, nice-to-have, or non-urgent items.

If the transcript contains no actionable tasks, reply exactly:
> "No actionable tasks or requests were identified in the provided transcript."

---

## Output Format (strictly follow this)

Use Markdown. All headings must be bold. Every block starts on a new line. Separate tasks with ---.

**Cloud Skill Analysis**
[One short sentence summarizing the call.]

---

**Task #1**

**Task Title:** [Concise professional title, max 8-10 words]

**Task Description:** [2-4 sentences describing what needs to be done and why.]

**Priority:** Urgent / High / Medium / Backlog

**Who:** [Name of the person from the transcript who raised or requested this]

**Fathom Link:** [Timeline link to the moment in the Fathom recording, or "Not provided"]

---
(repeat block above for every task, incrementing the number)
---

**Urgent Items Summary**
- [bullet list of everything that needs immediate attention]

**Backlog Recommendations**
- [bullet list of items that should go to backlog]

---

## Rules

- Never combine unrelated requests into one task.
- Task titles must be short, professional, and sound like real Jira tickets (e.g. "Set Up Automated Compliance Report", "Fix Storage Quota Alert Threshold").
- Base everything only on the transcript. Do not add assumptions or invent context.
- Be precise, neutral, and business-like.
- Every task block must be fully self-contained and copy-paste ready.
- Priority levels: **Urgent** (ASAP / client waiting), **High** (important, near-term), **Medium** (standard backlog), **Backlog** (future / nice-to-have).

---

## Example Trigger Phrases

- "Here is the transcript from today's call with the client. Please extract tasks."
- "Turn this meeting transcript into Jira tickets."
- "What action items came out of this call?"
- "Create a backlog from this workshop recording."
- [User pastes a raw transcript with no instructions]`;

// System-prompt body for the per-task "deep dive" (`/api/fathom/task-deep-dive`):
// given the full transcript and ONE already-extracted task, pull out everything
// the call contains about that specific task. Output is deliberately markdown-
// lite (plain "Header:" lines + bullets, no ** or #) so it reads clean both on
// the task card and after textToHtml() into a Jira description.
export const DEEP_DIVE_INSTRUCTIONS = `# Task Deep Dive

You are given ONE task (title + short description) that was extracted from a call, plus the call's full transcript. Write a complete, developer-ready task specification from EVERY piece of information in the transcript that relates to this specific task.

## Rules

- The output is a TICKET SPEC for a developer who was NOT on the call — not meeting minutes. Describe the system and the required change, don't narrate the conversation ("Cara asked…", "Dima said…" is forbidden outside Open questions and References).
- Scan the WHOLE transcript: relevant details are often scattered across the call (a topic is raised, dropped, then picked up again later). Fold ALL passes over the topic into the spec.
- Use ONLY the transcript. No assumptions, no invented details, no generic filler. If the call doesn't say how something works, leave it out or put it under Open questions.
- Ignore everything unrelated to this task, even if important — other tasks have their own deep dives.
- Use the exact system/field/status/process names as spoken on the call.
- Names of people appear ONLY in Open questions (who should answer) and References (who said the quote).
- Where the transcript contains timestamped deep links, cite them exactly as they appear ([MM:SS](url)).
- Be exhaustive but not repetitive: every bullet must carry new information, never restate the title.
- Write in the language the call was held in (e.g. Russian call → Russian output), keeping product/technical terms as spoken.

## Output format

Plain text with "-" bullets. Use EXACTLY these section headers (a header line ending with ":"), in this order. OMIT any section that has nothing in the transcript — never write "N/A" or leave a section empty. Do NOT use markdown headings (#) or bold (**). No preamble, no closing remarks.

Where:
[The place the change/check applies: system, module, screen, entity, process, automation — as named on the call. 1-2 lines.]

What:
[What must be done, imperative and concrete: implement/fix/verify X so that Y. 1-3 sentences a developer can act on.]

Why:
[Business reason / trigger for the task as voiced on the call. 1-2 sentences.]

Current behavior:
- [how the system works today, per the call: triggers, conditions, statuses, flows]

Expected behavior:
- [what should happen after the change, or what exactly must be verified — concrete, testable statements]

Edge cases:
- [specific scenarios and corner cases voiced on the call, written as test-able cases]

Open questions:
- [things left undecided or flagged for clarification — and who should answer]

References:
- [Name]: "[verbatim or near-verbatim quote]" [MM:SS](url)`;

export const FOLLOWUP_SKILLS = {
  'tasks-follow-up': {
    id:          'tasks-follow-up',
    name:        'Tasks Follow-up',
    description: 'Analyse the call transcript and produce structured follow-up tasks.',
    instructions: PASTED_SKILL_INSTRUCTIONS,
  },
};

// Compact list for the frontend dropdown (no instruction text leaks to the client).
export function listFollowupSkills() {
  return Object.values(FOLLOWUP_SKILLS).map(({ id, name, description }) => ({ id, name, description }));
}
