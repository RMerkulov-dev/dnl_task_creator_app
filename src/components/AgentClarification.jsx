import { useState } from 'react';

/**
 * Rendered when an agent calls the `ask_user` tool. Shows the question
 * with 2–4 clickable options. Clicking commits the selection back as a
 * new user turn via `onAnswer(text)`. `locked=true` disables interaction
 * (used for historical clarifications already answered).
 */
export default function AgentClarification({ clarification, onAnswer, locked }) {
  const { question, options, multiSelect } = clarification;
  const [selected, setSelected] = useState([]);

  function toggle(label) {
    if (locked) return;
    if (multiSelect) {
      setSelected(s => s.includes(label) ? s.filter(l => l !== label) : [...s, label]);
    } else {
      onAnswer(label);
    }
  }

  function submitMulti() {
    if (locked || !selected.length) return;
    onAnswer(selected.join(', '));
  }

  return (
    <div className={`agent-clar${locked ? ' locked' : ''}`}>
      <p className="agent-clar-q">{question}</p>
      <div className="agent-clar-opts">
        {options.map(opt => {
          const isOn = multiSelect && selected.includes(opt.label);
          return (
            <button
              key={opt.label}
              type="button"
              className={`agent-clar-chip${isOn ? ' on' : ''}`}
              disabled={locked}
              onClick={() => toggle(opt.label)}
              title={opt.description || ''}
            >
              <span className="agent-clar-chip-label">{opt.label}</span>
              {opt.description && <span className="agent-clar-chip-desc">{opt.description}</span>}
            </button>
          );
        })}
      </div>
      {multiSelect && !locked && (
        <button
          type="button"
          className="agent-clar-submit"
          disabled={!selected.length}
          onClick={submitMulti}
        >
          Отправить ({selected.length})
        </button>
      )}
    </div>
  );
}
