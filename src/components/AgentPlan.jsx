import { useState } from 'react';

// Format a single step's body: support **bold** and `code` inline.
function formatStepBody(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// Split the plan into structured steps. Each step has a number, an optional
// bold title (before " — " or ":"), and a body. Non-step lines fall through
// as plain paragraphs.
function parsePlan(plan) {
  const lines = (plan || '').split('\n').map(l => l.trim()).filter(Boolean);
  const blocks = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (!m) { blocks.push({ kind: 'text', text: line }); continue; }
    const rest = m[2];
    // Try "**Title** — body" or "**Title**: body"
    const titled = rest.match(/^\*\*(.+?)\*\*\s*[—\-:]\s*(.*)$/);
    if (titled) {
      blocks.push({ kind: 'step', num: m[1], title: titled[1], body: titled[2] });
    } else {
      blocks.push({ kind: 'step', num: m[1], title: null, body: rest });
    }
  }
  return blocks;
}

function PlanSteps({ plan }) {
  const blocks = parsePlan(plan);
  return (
    <ol className="agent-plan-steps">
      {blocks.map((b, i) => {
        if (b.kind === 'text') {
          return <li key={i} className="agent-plan-note" dangerouslySetInnerHTML={{ __html: formatStepBody(b.text) }} />;
        }
        return (
          <li key={i} className="agent-plan-step">
            <span className="agent-plan-step-num">{b.num}</span>
            <div className="agent-plan-step-content">
              {b.title && <span className="agent-plan-step-title">{b.title}</span>}
              <span
                className="agent-plan-step-body"
                dangerouslySetInnerHTML={{ __html: formatStepBody(b.body) }}
              />
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Rendered when the planner returns a plan that the user must approve before
 * the executor runs. The user can:
 *  - Approve & run as-is
 *  - Edit the plan in a textarea and run the edited version
 *  - Cancel (drops the request)
 *
 * `locked=true` disables interaction (used for historical plans already acted on).
 */
export default function AgentPlan({ plan, onApprove, onCancel, locked }) {
  const [editing, setEditing] = useState(false);
  const [draft,   setDraft]   = useState(plan);

  if (locked) {
    return (
      <div className="agent-plan locked">
        <div className="agent-plan-head">
          <span className="agent-plan-icon">📋</span>
          <span className="agent-plan-title">Plan</span>
        </div>
        <PlanSteps plan={plan} />
      </div>
    );
  }

  return (
    <div className="agent-plan">
      <div className="agent-plan-head">
        <span className="agent-plan-icon">📋</span>
        <span className="agent-plan-title">
          {editing ? 'Edit the plan' : 'Review the plan before I run it'}
        </span>
      </div>

      {editing ? (
        <textarea
          className="agent-plan-edit"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
        />
      ) : (
        <PlanSteps plan={plan} />
      )}

      <div className="agent-plan-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="agent-plan-btn ghost"
              onClick={() => { setDraft(plan); setEditing(false); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="agent-plan-btn primary"
              disabled={!draft.trim()}
              onClick={() => onApprove(draft.trim())}
            >
              Run with edits
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="agent-plan-btn ghost"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="agent-plan-btn"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className="agent-plan-btn primary"
              onClick={() => onApprove(plan)}
            >
              Approve & run
            </button>
          </>
        )}
      </div>
    </div>
  );
}
