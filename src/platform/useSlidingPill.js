import { useLayoutEffect, useRef, useState } from 'react';

// ── Sliding liquid-glass indicator ───────────────────────────────────────────
// Shared geometry for every "the selection moves instead of jumping" control
// (PM tab switcher, sidebar nav, theme toggle). Measures the active item inside
// its track and hands back:
//   trackRef   — put on the positioned track (must be position: relative)
//   setItemRef — ref callback per item key
//   box        — {left, top, width, height} in track-relative px
//   ready      — false until the first measurement; gates the CSS transition so
//                the pill doesn't fly in from 0,0 on mount
//   seq        — bumped whenever activeKey changes; key an element on it to
//                restart the gel squish animation
//
// Geometry comes from offsetLeft/offsetTop (not getBoundingClientRect) on
// purpose: those ignore transforms, so a running entry animation on the items
// can't be measured into a wrong resting position.
export function useSlidingPill(activeKey) {
  const trackRef = useRef(null);
  const itemRefs = useRef(new Map());
  const [box, setBox]     = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [ready, setReady] = useState(false);
  const [seq, setSeq]     = useState(0);
  const prevKey = useRef(activeKey);

  const setItemRef = (key) => (el) => {
    if (el) itemRefs.current.set(key, el);
    else itemRefs.current.delete(key);
  };

  useLayoutEffect(() => {
    if (prevKey.current !== activeKey) {
      prevKey.current = activeKey;
      setSeq(s => s + 1);
    }
  }, [activeKey]);

  useLayoutEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      const item  = itemRefs.current.get(activeKey);
      if (!track || !item || !item.offsetWidth) return;
      setBox({
        left:   item.offsetLeft,
        top:    item.offsetTop,
        width:  item.offsetWidth,
        height: item.offsetHeight,
      });
      setReady(true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (trackRef.current) ro.observe(trackRef.current);
    window.addEventListener('resize', measure);
    document.fonts?.ready?.then(measure).catch(() => {});
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [activeKey]);

  return { trackRef, setItemRef, box, ready, seq };
}
