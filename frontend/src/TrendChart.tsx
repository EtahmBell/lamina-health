import { axisDate, formatTick, labDate, labUnit, valueTicks, type TrendSeries } from './clinicalTrends.ts'

/** Inset so edge readings and their labels stay inside the plot box. */
const INSET_X = 4
const INSET_Y = 6

/**
 * A small clinical trend chart: real readings only, with a numeric y axis, a
 * label at every measurement date, and the value printed at each point so the
 * chart is readable without hovering.
 *
 * The line and gridlines are SVG stretched to the plot box; every label is
 * positioned HTML so type stays the same size at any chart width.
 */
export function TrendChart({ series, domain, tone }: { series: TrendSeries; domain: [number, number]; tone: 'accent' | 'clinical' }) {
  const unit = labUnit(series.unit)
  const { lo, hi, step, ticks } = valueTicks(series.points.map((point) => point.value))
  const [start, end] = domain
  const width = end - start || 1
  const topFor = (value: number) => 100 - (INSET_Y + ((value - lo) / (hi - lo || 1)) * (100 - INSET_Y * 2))
  const leftFor = (date: string) =>
    INSET_X + ((new Date(`${date}T12:00:00`).getTime() - start) / width) * (100 - INSET_X * 2)
  const plotted = series.points.map((point, index) => ({
    ...point,
    left: leftFor(point.date),
    top: topFor(point.value),
    label: axisDate(point.date, index > 0 ? series.points[index - 1].date : undefined),
  }))
  const description = `${series.label} in ${unit}. ${series.points
    .map((point) => `${point.value} on ${labDate(point.date)}`)
    .join('; ')}. Axis ${formatTick(lo, step)} to ${formatTick(hi, step)}.`
  return <figure className={`trend-chart ${tone}`}>
    <figcaption>
      <strong>{series.label}</strong>
      <span>{unit}</span>
      <em>{series.points.length} readings</em>
    </figcaption>
    <div className="trend-chart-body">
      <div className="trend-chart-scale" aria-hidden="true">
        {ticks.map((tick) => <span key={tick} style={{ top: `${topFor(tick)}%` }}>{formatTick(tick, step)}</span>)}
      </div>
      <div className="trend-chart-plot" role="img" aria-label={description}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
          {ticks.map((tick) => <line
            key={tick}
            className={`trend-grid ${tick === lo ? 'baseline' : ''}`}
            x1="0" x2="100" y1={topFor(tick)} y2={topFor(tick)}
            vectorEffect="non-scaling-stroke"
          />)}
          <polyline className="trend-line" vectorEffect="non-scaling-stroke" points={plotted.map((point) => `${point.left},${point.top}`).join(' ')} />
        </svg>
        {plotted.map((point, index) => <span
          key={`dot-${index}`}
          className="trend-dot"
          style={{ left: `${point.left}%`, top: `${point.top}%` }}
          title={`${point.value} ${unit} · ${labDate(point.date)}`}
        />)}
        {plotted.map((point, index) => <span
          key={`value-${index}`}
          className={`trend-value ${point.top < 26 ? 'below' : 'above'}`}
          style={{ left: `${point.left}%`, top: `${point.top}%` }}
          aria-hidden="true"
        >{point.value}</span>)}
      </div>
    </div>
    <div className="trend-chart-axis" aria-hidden="true">
      {plotted.map((point, index) => <span key={`axis-${index}`} style={{ left: `${point.left}%` }}>{point.label}</span>)}
    </div>
  </figure>
}
