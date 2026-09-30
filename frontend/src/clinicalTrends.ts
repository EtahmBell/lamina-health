import type { LabObservation } from './api.ts'

export type TrendPoint = { date: string; value: number }
export type TrendSeries = {
  test: LabObservation['test']
  label: string
  unit: string
  points: TrendPoint[]
}
export type LatestValue = {
  test: LabObservation['test']
  label: string
  value: number
  unit: string
  date: string
  /** True when this measurement also has a chart, so the two never contradict. */
  trended: boolean
}
export type ClinicalTrends = {
  /** Only measurements with at least two distinct dates. Never interpolated. */
  series: TrendSeries[]
  /** Shared date domain (epoch ms) so stacked charts align on the same x positions. */
  domain: [number, number] | null
  /** The most recent reading of every measurement present in the record. */
  latest: LatestValue[]
}
/** Chronological flowsheet of the record: one row per date, one column per measurement. */
export type Flowsheet = {
  dates: string[]
  columns: { test: LabObservation['test']; label: string; unit: string }[]
  rows: { date: string; cells: (number | null)[] }[]
}

const LAB_LABELS: Record<LabObservation['test'], string> = {
  creatinine: 'Creatinine',
  eGFR: 'eGFR',
  hemoglobin: 'Hemoglobin',
  ferritin: 'Ferritin',
  serum_iron: 'Serum iron',
  TIBC: 'TIBC',
  transferrin_saturation: 'Transferrin saturation',
  MCV: 'MCV',
  WBC: 'WBC',
  platelets: 'Platelets',
}

const DISPLAY_ORDER: LabObservation['test'][] = [
  'creatinine', 'eGFR', 'hemoglobin', 'ferritin', 'serum_iron',
  'TIBC', 'transferrin_saturation', 'MCV', 'WBC', 'platelets',
]

export const labLabel = (test: LabObservation['test']) => LAB_LABELS[test]

/** Typographic rendering of the recorded unit. The value itself is never changed. */
export const labUnit = (unit: string) => unit.replace('1.73m2', '1.73m²').replace('10*3/uL', '×10³/µL')

const asDate = (date: string) => new Date(`${date}T12:00:00`)

export const labDate = (date: string) =>
  asDate(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** Compact axis label; the year is shown only when it changes along the axis. */
export const axisDate = (date: string, previous?: string) => {
  const point = asDate(date)
  const short = point.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const previousYear = previous ? asDate(previous).getFullYear() : null
  return previousYear === point.getFullYear() ? short : `${short} '${String(point.getFullYear()).slice(-2)}`
}

const groupByTest = (labs: LabObservation[]) => {
  const byTest = new Map<LabObservation['test'], LabObservation[]>()
  for (const lab of labs) {
    const existing = byTest.get(lab.test)
    if (existing) existing.push(lab)
    else byTest.set(lab.test, [lab])
  }
  for (const observations of byTest.values()) observations.sort((a, b) => a.date.localeCompare(b.date))
  return byTest
}

/**
 * Splits the supplied synthetic lab record into honest longitudinal series and
 * the latest value of every measurement. A single measurement never becomes a chart.
 */
export function clinicalTrends(labs: LabObservation[]): ClinicalTrends {
  const byTest = groupByTest(labs)
  const series: TrendSeries[] = []
  const latest: LatestValue[] = []
  for (const test of DISPLAY_ORDER) {
    const observations = byTest.get(test)
    if (!observations?.length) continue
    const trended = new Set(observations.map((item) => item.date)).size >= 2
    if (trended) {
      series.push({
        test,
        label: LAB_LABELS[test],
        unit: observations[0].unit,
        points: observations.map((item) => ({ date: item.date, value: item.value })),
      })
    }
    const last = observations[observations.length - 1]
    latest.push({ test, label: LAB_LABELS[test], value: last.value, unit: last.unit, date: last.date, trended })
  }
  const dates = series.flatMap((item) => item.points.map((point) => asDate(point.date).getTime()))
  const domain: [number, number] | null = dates.length ? [Math.min(...dates), Math.max(...dates)] : null
  return { series, domain, latest }
}

export function labFlowsheet(labs: LabObservation[]): Flowsheet {
  const byTest = groupByTest(labs)
  const columns = DISPLAY_ORDER.filter((test) => byTest.get(test)?.length).map((test) => ({
    test,
    label: LAB_LABELS[test],
    unit: byTest.get(test)![0].unit,
  }))
  const dates = [...new Set(labs.map((lab) => lab.date))].sort()
  const rows = dates.map((date) => ({
    date,
    cells: columns.map(({ test }) => byTest.get(test)!.find((lab) => lab.date === date)?.value ?? null),
  }))
  return { dates, columns, rows }
}

const niceSteps = (span: number) => {
  const base = 10 ** (Math.floor(Math.log10(span)) - 1)
  const steps: number[] = []
  for (let power = base; power <= base * 10000; power *= 10) {
    for (const multiple of [1, 2, 2.5, 5]) steps.push(Number((power * multiple).toPrecision(12)))
  }
  return steps.sort((a, b) => a - b)
}

/**
 * Rounded axis bounds that contain every observed value. The scale is never
 * tightened around the data in a way that would exaggerate the change.
 */
export function valueTicks(values: number[], maxCount = 4): { lo: number; hi: number; step: number; ticks: number[] } {
  const low = Math.min(...values)
  const high = Math.max(...values)
  const span = high - low
  if (!(span > 0)) {
    const step = Math.abs(high) > 0 ? Number((Math.abs(high) / 4).toPrecision(2)) : 1
    return { lo: high - step, hi: high + step, step, ticks: [high - step, high, high + step] }
  }
  for (const step of niceSteps(span)) {
    const lo = Math.floor(low / step) * step
    const hi = Math.ceil(high / step) * step
    const count = Math.round((hi - lo) / step) + 1
    if (count <= maxCount) {
      const ticks = Array.from({ length: count }, (_, index) => Number((lo + index * step).toPrecision(12)))
      return { lo: ticks[0], hi: ticks[ticks.length - 1], step, ticks }
    }
  }
  return { lo: low, hi: high, step: span, ticks: [low, high] }
}

export const formatTick = (value: number, step: number) => {
  const decimals = Math.max(0, Math.min(3, -Math.floor(Math.log10(step))))
  return value.toFixed(decimals)
}
