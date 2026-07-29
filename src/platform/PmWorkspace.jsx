import { useState, useCallback, useRef, useEffect, Suspense } from 'react';
import { APP_COMPONENTS, PM_TABS } from './AppRegistry.js';
import { useSlidingPill } from './useSlidingPill.js';

function PaneLoader() {
  return (
    <div className="platform-app-loader">
      <div className="spinner spinner-lg" />
    </div>
  );
}

// ── PM workspace ──────────────────────────────────────────────────────────────
// Bundles the project-management tools under one sidebar entry. The segmented
// switcher owns a sticky row of its own at the top of the workspace — it used
// to float over the sub-app header's empty centre, which only cleared the
// tools' titles on very wide screens. Panes stay mounted once visited
// (display-toggled, not unmounted) so each tool keeps its state — form drafts,
// loaded boards, chat history — when you flip between them.
export default function PmWorkspace(props) {
  const [tab, setTab] = useState(PM_TABS[0].id);
  const [visited, setVisited] = useState(() => new Set([PM_TABS[0].id]));

  const select = useCallback((id) => {
    setTab(id);
    setVisited(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);

  // The filled pill is one element that moves/resizes to the selected tab
  // instead of the background jumping between buttons (see useSlidingPill).
  const { trackRef, setItemRef, box, ready, seq } = useSlidingPill(tab);

  // In a narrow window the track scrolls sideways instead of wrapping or being
  // clipped; keep the selected tab in view when it does.
  const scrollRef = useRef(null);
  const tabEls = useRef(new Map());
  const bindTab = (id) => {
    const setPillRef = setItemRef(id);
    return (el) => {
      setPillRef(el);
      if (el) tabEls.current.set(id, el); else tabEls.current.delete(id);
    };
  };
  useEffect(() => {
    const scroller = scrollRef.current;
    const el = tabEls.current.get(tab);
    if (!scroller || !el || scroller.scrollWidth <= scroller.clientWidth) return;
    el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [tab]);

  return (
    <div className="pm-workspace">
      <div className="pm-switcher-bar">
       <div className="pm-switcher-scroll" ref={scrollRef}>
        <div className="pm-switcher glass-panel" role="tablist" aria-label="PM tools" ref={trackRef}>
          {/* Refraction ring: the backdrop is displaced only near the rim, so the
              track bends the content behind it like a glass slab instead of just
              blurring it. Degrades to plain frosted glass where unsupported. */}
          <span className="glass-refract" aria-hidden="true" />
          <span
            className={`pm-switcher-pill${ready ? ' ready' : ''}`}
            aria-hidden="true"
            style={{ transform: `translateX(${box.left}px)`, width: box.width }}
          >
            <span key={seq} className={`glass-pill-fill${seq > 0 ? ' gel' : ''}`} />
          </span>
          {PM_TABS.map(t => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={t.id === tab}
              ref={bindTab(t.id)}
              className={`pm-tab${t.id === tab ? ' active' : ''}`}
              onClick={() => select(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
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
