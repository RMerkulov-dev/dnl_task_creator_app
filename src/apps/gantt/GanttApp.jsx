import { useState } from 'react';
import ReleaseTimelineBuilder from './ReleaseTimelineBuilder.jsx';

// Gantt-chart variants. The first one is live; new kinds of charts slot in here.
const MODES = [
  { id: 'release-timeline', name: 'Release Timeline & Resource Planning', available: true },
  { id: 'coming-soon', name: 'Coming soon…', available: false },
];

export default function GanttApp() {
  const [modeId, setModeId] = useState('release-timeline');

  return (
    <div className="gantt-app">
      <div className="gantt-app-header">
        <h1 className="gantt-app-title">Gantt</h1>
        <div className="gantt-mode-tabs" role="tablist">
          {MODES.map(m => (
            <button
              key={m.id}
              role="tab"
              aria-selected={m.id === modeId}
              className={`gantt-mode-tab${m.id === modeId ? ' active' : ''}`}
              disabled={!m.available}
              onClick={() => m.available && setModeId(m.id)}
            >
              {m.name}
            </button>
          ))}
        </div>
      </div>
      {modeId === 'release-timeline' && <ReleaseTimelineBuilder />}
    </div>
  );
}
