import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Validated categorical slots (light surface) from the data-viz reference palette. */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'];
const GRID = '#e5e7eb';
const AXIS_TEXT = '#64748b';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toLocaleString('es-MX', { maximumFractionDigits: 1 })}K` : n.toLocaleString('es-MX');
}

function shortDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}/${m}`;
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), width - 70);
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg"
      style={{ left, top: y - 8 }}
    >
      {children}
    </div>
  );
}

const PAD = { top: 12, right: 12, bottom: 24, left: 36 };

/** Single-series column chart (daily counts). */
export function ColumnChart({ labels, values, color = SERIES[0], height = 200, unit }: { labels: string[]; values: number[]; color?: string; height?: number; unit: string }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...values));
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const band = innerW / Math.max(1, values.length);
  const barW = Math.min(24, Math.max(2, band - 2));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const every = Math.ceil(values.length / Math.max(1, Math.floor(innerW / 48)));
  return (
    <div ref={ref} className="relative">
      <svg width={width} height={height} role="img" aria-label={`Gráfica de ${unit} por día`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
              {compact(t)}
            </text>
          </g>
        ))}
        {values.map((v, i) => {
          const cx = PAD.left + band * i + band / 2;
          const top = y(v);
          const h = PAD.top + innerH - top;
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent" />
              {v > 0 && (
                <path
                  d={`M${cx - barW / 2},${PAD.top + innerH} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${PAD.top + innerH} Z`}
                  fill={color}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {i % every === 0 && (
                <text x={cx} y={height - 6} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                  {shortDay(labels[i])}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <Tooltip x={PAD.left + band * hover + band / 2} y={y(values[hover])} width={width}>
          <p className="font-medium text-slate-900">{new Date(`${labels[hover]}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })}</p>
          <p className="text-slate-600">
            {values[hover].toLocaleString('es-MX')} {unit}
          </p>
        </Tooltip>
      )}
    </div>
  );
}

/** Multi-series line chart with a crosshair tooltip and a legend. */
export function LineChart({ labels, series, height = 220 }: { labels: string[]; series: { name: string; values: number[]; color: string }[]; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const n = labels.length;
  const x = (i: number) => PAD.left + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1));
  const y = (v: number) => PAD.top + innerH - (v / max) * innerH;
  const ticks = [0, max / 2, max];
  const every = Math.ceil(n / Math.max(1, Math.floor(innerW / 48)));

  function onMove(e: React.MouseEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1)))));
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-slate-600">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
      <div ref={ref} className="relative">
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.name).join(' y ')}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} />
              <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
                {compact(t)}
              </text>
            </g>
          ))}
          {labels.map((l, i) =>
            i % every === 0 ? (
              <text key={l} x={x(i)} y={height - 6} textAnchor="middle" fontSize={11} fill={AXIS_TEXT}>
                {shortDay(l)}
              </text>
            ) : null,
          )}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="#94a3b8" strokeWidth={1} />}
          {series.map((s) => (
            <g key={s.name}>
              <path d={`M${s.values.map((v, i) => `${x(i)},${y(v)}`).join(' L')}`} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {hover !== null && <circle cx={x(hover)} cy={y(s.values[hover])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />}
            </g>
          ))}
          <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {hover !== null && (
          <Tooltip x={x(hover)} y={y(Math.max(...series.map((s) => s.values[hover])))} width={width}>
            <p className="mb-1 font-medium text-slate-900">
              {new Date(`${labels[hover]}T12:00:00`).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' })}
            </p>
            {series.map((s) => (
              <p key={s.name} className="flex items-center gap-2 text-slate-600">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}: <span className="font-medium text-slate-900">{s.values[hover].toLocaleString('es-MX')}</span>
              </p>
            ))}
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** Horizontal bars for a ranked list (one hue: magnitude). The optional dot carries identity. */
export function BarList({ items, color = SERIES[0], format = (v: number) => v.toLocaleString('es-MX') }: { items: { label: string; value: number; dot?: string; sub?: string }[]; color?: string; format?: (v: number) => string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="space-y-2.5">
      {items.map((it) => (
        <div key={it.label} className="group" title={`${it.label}: ${format(it.value)}${it.sub ? ` · ${it.sub}` : ''}`}>
          <div className="mb-1 flex items-center justify-between gap-2 text-sm">
            <span className="flex min-w-0 items-center gap-2 text-slate-700">
              {it.dot && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: it.dot }} />}
              <span className="truncate">{it.label}</span>
            </span>
            <span className="shrink-0 text-slate-900">
              <span className="font-medium">{format(it.value)}</span>
              {it.sub && <span className="ml-2 text-xs text-slate-500">{it.sub}</span>}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-100">
            <div className="h-2 rounded-full transition-all group-hover:opacity-80" style={{ width: `${(it.value / max) * 100}%`, background: color, minWidth: it.value > 0 ? 4 : 0 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
