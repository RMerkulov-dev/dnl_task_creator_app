import { useState, useCallback, useRef, useLayoutEffect, Suspense } from 'react';
import { APP_COMPONENTS, PM_TABS } from './AppRegistry.js';

function PaneLoader() {
  return (
    <div className="platform-app-loader">
      <div className="spinner spinner-lg" />
    </div>
  );
}

// ── PM workspace ──────────────────────────────────────────────────────────────
// Bundles the four project-management tools (Tasks, Status, Jira Agent, BA Agent)
// under one sidebar entry. A segmented switcher floats in the header's empty
// centre. Panes stay mounted once visited (display-toggled, not unmounted) so
// each tool keeps its state — form drafts, loaded boards, chat history — when
// you flip between them.
export default function PmWorkspace(props) {
  const [tab, setTab] = useState(PM_TABS[0].id);
  const [visited, setVisited] = useState(() => new Set([PM_TABS[0].id]));

  const select = useCallback((id) => {
    setTab(id);
    setVisited(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // ── Sliding active pill ───────────────────────────────────────────────────
  // The filled pill is one element that moves/resizes to the selected tab
  // instead of the background jumping between buttons. Geometry is measured
  // from the DOM (tab widths depend on the label + the responsive padding),
  // re-measured on resize/font swap. `ready` gates the transition so the pill
  // doesn't slide in from x=0 on the first paint.
  const trackRef = useRef(null);
  const tabRefs  = useRef(new Map());
  const [pill, setPill]   = useState({ left: 0, width: 0 });
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      const btn   = tabRefs.current.get(tab);
      if (!track || !btn) return;
      const t = track.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      if (!b.width) return;
      setPill({ left: b.left - t.left, width: b.width });
      setReady(true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (trackRef.current) ro.observe(trackRef.current);
    window.addEventListener('resize', measure);
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [tab]);

  return (
    <div className="pm-workspace">
      <div className="pm-switcher-bar">
        <div className="pm-switcher" role="tablist" aria-label="PM tools" ref={trackRef}>
          <span
            className={`pm-switcher-pill${ready ? ' ready' : ''}`}
            aria-hidden="true"
            style={{ transform: `translateX(${pill.left}px)`, width: pill.width }}
          />
          {PM_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              ref={el => { if (el) tabRefs.current.set(t.id, el); else tabRefs.current.delete(t.id); }}
              className={`pm-tab${t.id === tab ? ' active' : ''}`}
              onClick={() => select(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {PM_TABS.map(t => {
        if (!visited.has(t.id)) return null;   // mount lazily on first visit…
        const Comp = APP_COMPONENTS[t.id];
        return (
          <div
            key={t.id}
            className="pm-pane"
            style={{ display: t.id === tab ? 'block' : 'none' }}   // …then keep alive
          >
            <Suspense fallback={<PaneLoader />}>
              <Comp {...props} />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
}
