import { labDate, type TrendSeries } from './clinicalTrends.ts'

const TOP = 12
const BOTTOM = 88

/**
 * A small clinical-comprehension chart: one measurement, real readings only.
 * Charts sharing a `domain` land on identical x positions so they read as one
 * trajectory. Plain SVG for the line, positioned markers for the readings.
 */
export function TrendChart({ series, domain, tone }: { series: TrendSeries; domain: [number, number]; tone: 'accent' | 'clinical' }) {
  const values = series.points.map((point) => point.value)
  const low = Math.min(...values)
  const span = Math.max(...values) - low || 1
  const [start, end] = domain
  const width = end - start || 1
  const plotted = series.points.map((point) => ({
    ...point,
    x: ((new Date(`${point.date}T12:00:00`).getTime() - start) / width) * 100,
    y: BOTTOM - ((point.value - low) / span) * (BOTTOM - TOP),
  }))
  const first = series.points[0]
  const last = series.points[series.points.length - 1]
  const description = `${series.label} in ${series.unit}: ${series.points.map((point) => `${point.value} on ${labDate(point.date)}`).join('; ')}.`
  return <figure className={`trend-chart ${tone}`}>
    <figcaption>
      <strong>{series.label}</strong>
      <span>{series.unit}</span>
      <em>{first.value} → {last.value} · {series.points.length} readings</em>
    </figcaption>
    <div className="trend-chart-plot" role="img" aria-label={description}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line className="trend-baseline" x1="0" y1="96" x2="100" y2="96" vectorEffect="non-scaling-stroke" />
        <polyline className="trend-line" vectorEffect="non-scaling-stroke" points={plotted.map((point) => `${point.x},${point.y}`).join(' ')} />
      </svg>
      {plotted.map((point, index) => <span
        key={`${point.date}-${index}`}
        className="trend-dot"
        style={{ left: `${point.x}%`, top: `${point.y}%` }}
        title={`${point.value} ${series.unit} · ${labDate(point.date)}`}
      />)}
    </div>
    <div className="trend-chart-axis"><span>{labDate(first.date)}</span><span>{labDate(last.date)}</span></div>
  </figure>
}
