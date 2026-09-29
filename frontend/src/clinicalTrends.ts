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
}
export type ClinicalTrends = {
  /** Only measurements with at least two distinct dates. Never interpolated. */
  series: TrendSeries[]
  /** Shared date domain (epoch ms) so stacked charts align on the same x positions. */
  domain: [number, number] | null
  /** Measurements without a genuine trend, shown as single values. */
  latest: LatestValue[]
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

export const labDate = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/**
 * Splits the supplied synthetic lab record into honest longitudinal series and
 * single values. A single measurement never becomes a chart.
 */
export function clinicalTrends(labs: LabObservation[]): ClinicalTrends {
  const byTest = new Map<LabObservation['test'], LabObservation[]>()
  for (const lab of labs) {
    const existing = byTest.get(lab.test)
    if (existing) existing.push(lab)
    else byTest.set(lab.test, [lab])
  }
  const series: TrendSeries[] = []
  const latest: LatestValue[] = []
  for (const test of DISPLAY_ORDER) {
    const observations = byTest.get(test)
    if (!observations?.length) continue
    const ordered = [...observations].sort((a, b) => a.date.localeCompare(b.date))
    const distinctDates = new Set(ordered.map((item) => item.date))
    if (distinctDates.size >= 2) {
      series.push({
        test,
        label: LAB_LABELS[test],
        unit: ordered[0].unit,
        points: ordered.map((item) => ({ date: item.date, value: item.value })),
      })
    } else {
      const last = ordered[ordered.length - 1]
      latest.push({ test, label: LAB_LABELS[test], value: last.value, unit: last.unit, date: last.date })
    }
  }
  const dates = series.flatMap((item) => item.points.map((point) => new Date(`${point.date}T12:00:00`).getTime()))
  const domain: [number, number] | null = dates.length ? [Math.min(...dates), Math.max(...dates)] : null
  return { series, domain, latest }
}
