// ─── Project Status — chart primitives ────────────────────────────────────────
// Small, dependency-free charts (the platform has no chart library, and this is
// not the place to add one). Bars, stacks and meters are plain HTML — a div with
// a width in % is more robust and more responsive than SVG for those; only the
// weekly trend needs real geometry, so that one is SVG with a crosshair.
//
// Colour rules: magnitude (bar length already carries the value) uses ONE hue
// (`--ps-seq`); state uses the reserved status trio (`--ps-done` / `--ps-prog` /
// `--ps-todo`) which never doubles as a categorical series; the trend's two
// series use the validated categorical pair (`--ps-cat-1` / `--ps-cat-2`).
// Every series is labelled — colour is never the only carrier.

import { useState, useRef, useLayoutEffect, useCallback } from 'react';
import { DONE, PROGRESS, TODO } from './metrics.js';

export const BUCKET_VAR = {
  [DONE]:     'var(--ps-done)',
  [PROGRESS]: 'var(--ps-prog)',
  [TODO]:     'var(--ps-todo)',
};

const pct = (v, total) => (total ? Math.round((v / total) * 100) : 0);

// ─── Card + tooltip ───────────────────────────────────────────────────────────

export function ChartCard({ title, hint, note, children, wide }) {
  return (
    <section className={`ps-card${wide ? ' ps-card-wide' : ''}`}>
      <header className="ps-card-head">
        <h3 className="ps-card-title">{title}</h3>
        {hint && <span className="ps-card-hint">{hint}</span>}
      </header>
      {children}
      {note && <p className="ps-card-note">{note}</p>}
    </section>
  );
}

// One tooltip element per chart, positioned from the hovered mark's rect.
function useTip() {
  const [tip, setTip] = useState(null);   // { x, y, title, rows: [[label, value]] }
  const wrapRef = useRef(null);
  const show = useCallback((e, payload) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const w = wrap.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ ...payload, x: r.left - w.left + r.width / 2, y: r.top - w.top });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  return { tip, setTip, show, hide, wrapRef };
}

function Tip({ tip }) {
  if (!tip) return null;
  return (
    <div className="ps-tip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }} role="tooltip">
      {tip.title && <div className="ps-tip-title">{tip.title}</div>}
      {(tip.rows || []).map(([label, value], i) => (
        <div className="ps-tip-row" key={i}>
          <span className="ps-tip-l">{label}</span>
          <span className="ps-tip-v">{value}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Meter — one ratio against 100% ───────────────────────────────────────────

export function Meter({ value, tone = 'seq', height = 6, title }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <span className="ps-meter" style={{ height: `${height}px` }} title={title}>
      <span
        className="ps-meter-fill"
        style={{ width: `${v}%`, background: tone === 'seq' ? 'var(--ps-seq)' : BUCKET_VAR[tone] }}
      />
    </span>
  );
}

// ─── 100% stacked bar — part-to-whole over the three states ───────────────────

export function Stacked100({ segments, height = 14 }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const { tip, show, hide, wrapRef } = useTip();
  if (!total) return <p className="ps-none">no data</p>;
  return (
    <div className="ps-stack-wrap" ref={wrapRef}>
      <div className="ps-stack" style={{ height: `${height}px` }}>
        {segments.filter(s => s.value > 0).map(s => (
          <div
            key={s.key}
            className="ps-stack-seg"
            style={{ flexGrow: s.value, background: BUCKET_VAR[s.key] }}
            onMouseEnter={e => show(e, { title: s.label, rows: [['issues', s.value], ['share', `${pct(s.value, total)}%`]] })}
            onMouseLeave={hide}
          />
        ))}
      </div>
      <ul className="ps-legend">
        {segments.map(s => (
          <li key={s.key}>
            <i className="ps-legend-dot" style={{ background: BUCKET_VAR[s.key] }} />
            {s.label}
            <b>{s.value}</b>
            <span className="ps-legend-pct">{pct(s.value, total)}%</span>
          </li>
        ))}
      </ul>
      <Tip tip={tip} />
    </div>
  );
}

// ─── Horizontal bars — magnitude, one hue ─────────────────────────────────────

export function HBars({ rows, unit = '', onPick, activeLabel = null, max: maxOverride }) {
  const { tip, show, hide, wrapRef } = useTip();
  const total = rows.reduce((s, r) => s + r.value, 0);
  const max = maxOverride ?? Math.max(1, ...rows.map(r => r.value));
  if (!rows.length) return <p className="ps-none">no data</p>;
  return (
    <div className="ps-hbars" ref={wrapRef}>
      {rows.map(r => {
        const active = activeLabel === r.label;
        const Row = onPick && !r.rest ? 'button' : 'div';
        return (
          <Row
            key={r.label}
            type={onPick && !r.rest ? 'button' : undefined}
            className={`ps-hbar${active ? ' active' : ''}${onPick && !r.rest ? ' ps-hbar-btn' : ''}`}
            onClick={onPick && !r.rest ? () => onPick(active ? null : r.label) : undefined}
            onMouseEnter={e => show(e, { title: r.label, rows: [[unit || 'items', r.value], ['share', `${pct(r.value, total)}%`]] })}
            onMouseLeave={hide}
          >
            <span className="ps-hbar-l" title={r.label}>{r.label}</span>
            <span className="ps-hbar-track">
              <span
                className="ps-hbar-fill"
                style={{ width: r.value ? `${Math.max(1.5, (r.value / max) * 100)}%` : 0, background: r.color || 'var(--ps-seq)' }}
              />
            </span>
            <span className="ps-hbar-v">{r.value}</span>
          </Row>
        );
      })}
      <Tip tip={tip} />
    </div>
  );
}

// ─── Columns — a distribution; clicking one filters the table ─────────────────

export function Columns({ rows, height = 132, onPick, activeId = null, unit = 'items' }) {
  const { tip, show, hide, wrapRef } = useTip();
  const max = Math.max(1, ...rows.map(r => r.value));
  const total = rows.reduce((s, r) => s + r.value, 0);
  return (
    <div className="ps-cols-wrap" ref={wrapRef}>
      <div className="ps-cols" style={{ height: `${height}px` }}>
        {rows.map(r => {
          const active = activeId === r.id;
          return (
            <button
              type="button"
              key={r.id}
              className={`ps-col${active ? ' active' : ''}`}
              onClick={() => onPick?.(active ? null : r.id)}
              onMouseEnter={e => show(e, { title: r.label, rows: [[unit, r.value], ['share', `${pct(r.value, total)}%`]] })}
              onMouseLeave={hide}
              aria-pressed={active}
            >
              <span className="ps-col-v">{r.value || ''}</span>
              <span
                className="ps-col-bar"
                style={{ height: `${r.value ? Math.max(3, (r.value / max) * 100) : 0}%`, background: r.color || 'var(--ps-seq)' }}
              />
              <span className="ps-col-l">{r.label}</span>
            </button>
          );
        })}
      </div>
      <Tip tip={tip} />
    </div>
  );
}

// ─── Weekly trend — SVG lines with a crosshair ────────────────────────────────

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(240, entry.contentRect.width)));
    ro.observe(el);
    setW(Math.max(240, el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const niceTop = v => {
  if (v <= 4) return 4;
  const step = Math.pow(10, Math.floor(Math.log10(v))) / 2;
  return Math.ceil(v / step) * step;
};

/**
 * @param points  [{ t, ...values }] — one entry per week, ascending
 * @param series  [{ key, label, color, fill?: true }]
 * @param xLabel  ms → string
 */
export function TrendChart({ points, series, xLabel, height = 190, valueLabel = '' }) {
  const [ref, width] = useWidth();
  const [hoverIdx, setHoverIdx] = useState(null);
  // The right pad holds the direct labels ("created" / "closed") sitting AFTER
  // the last point — inside the plot they land on top of the lines and of each
  // other, which is exactly the label collision the anti-pattern list warns about.
  const labelW = Math.max(0, ...series.map(s => s.label.length)) * 5.6 + 10;
  const pad = { t: 14, r: 12 + labelW, b: 22, l: 34 };

  if (!points.length) return <p className="ps-none">no data</p>;

  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = height - pad.t - pad.b;
  const top = niceTop(Math.max(1, ...points.flatMap(p => series.map(s => p[s.key] ?? 0))));
  const x = i => pad.l + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = v => pad.t + innerH - (Math.min(v, top) / top) * innerH;

  const ticks = [0, 0.5, 1].map(f => Math.round(top * f));
  // Label every other week on a crowded axis so the dates never collide.
  const step = points.length > 10 ? Math.ceil(points.length / 8) : 1;

  const onMove = e => {
    const box = e.currentTarget.getBoundingClientRect();
    const rel = ((e.clientX - box.left) - pad.l) / innerW;
    setHoverIdx(Math.max(0, Math.min(points.length - 1, Math.round(rel * (points.length - 1)))));
  };

  const hp = hoverIdx === null ? null : points[hoverIdx];

  return (
    <div className="ps-trend" ref={ref}>
      <svg
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
      >
        {ticks.map(v => (
          <g key={v}>
            <line className="ps-gridline" x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} />
            <text className="ps-axis" x={pad.l - 6} y={y(v) + 3.5} textAnchor="end">{v}</text>
          </g>
        ))}

        {points.map((p, i) => (i % step === 0 || i === points.length - 1) && (
          <text className="ps-axis" key={p.t} x={x(i)} y={height - 6} textAnchor="middle">{xLabel(p.t)}</text>
        ))}

        {series.map(s => (
          <g key={s.key}>
            {s.fill && (
              <path
                className="ps-area"
                fill={s.color}
                d={`M ${x(0)} ${y(points[0][s.key] ?? 0)} ${points.map((p, i) => `L ${x(i)} ${y(p[s.key] ?? 0)}`).join(' ')} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`}
              />
            )}
            <path
              className="ps-line"
              stroke={s.color}
              d={`M ${points.map((p, i) => `${i ? 'L' : ''} ${x(i)} ${y(p[s.key] ?? 0)}`).join(' ')}`}
            />
            {/* Direct label at the last point — identity without reading the legend. */}
            <text
              className="ps-line-label"
              x={x(points.length - 1) + 6}
              y={(y(points[points.length - 1][s.key] ?? 0)) + 3.5}
              textAnchor="start"
            >
              {s.label}
            </text>
          </g>
        ))}

        {hp && (
          <g>
            <line className="ps-cross" x1={x(hoverIdx)} x2={x(hoverIdx)} y1={pad.t} y2={pad.t + innerH} />
            {series.map(s => (
              <circle key={s.key} className="ps-dot" cx={x(hoverIdx)} cy={y(hp[s.key] ?? 0)} r="4" fill={s.color} />
            ))}
          </g>
        )}
      </svg>

      {hp && (
        <div
          className="ps-tip ps-tip-trend"
          style={{ left: `${x(hoverIdx)}px`, top: `${pad.t}px` }}
          role="tooltip"
        >
          <div className="ps-tip-title">{xLabel(hp.t)}{valueLabel ? ` · ${valueLabel}` : ''}</div>
          {series.map(s => (
            <div className="ps-tip-row" key={s.key}>
              <span className="ps-tip-l"><i className="ps-legend-dot" style={{ background: s.color }} />{s.label}</span>
              <span className="ps-tip-v">{hp[s.key] ?? 0}</span>
            </div>
          ))}
        </div>
      )}

      {series.length > 1 && (
        <ul className="ps-legend">
          {series.map(s => (
            <li key={s.key}>
              <i className="ps-legend-dot" style={{ background: s.color }} />{s.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
