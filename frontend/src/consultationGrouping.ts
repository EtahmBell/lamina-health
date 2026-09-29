import type { ConsultationRecord } from './api.ts'
import { cleanName, patientInitials, patientName } from './demoIdentity.ts'

export type PatientConsultationGroup = {
  patientId: string
  patientLabel: string
  initials: string
  count: number
  latest: ConsultationRecord
  latestPhysician: string
  latestSpecialty: string
  records: ConsultationRecord[]
}

/**
 * Repeated demo consultations collapse into one row per patient. Derived entirely
 * from the existing consultation records; no new backend endpoint.
 */
export function groupConsultationsByPatient(records: ConsultationRecord[]): PatientConsultationGroup[] {
  const groups = new Map<string, ConsultationRecord[]>()
  for (const record of records) {
    const existing = groups.get(record.patient_id)
    if (existing) existing.push(record)
    else groups.set(record.patient_id, [record])
  }
  return [...groups.entries()]
    .map(([patientId, patientRecords]) => {
      const ordered = [...patientRecords].sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id - a.id)
      const latest = ordered[0]
      return {
        patientId,
        patientLabel: patientName(patientId),
        initials: patientInitials(patientId),
        count: ordered.length,
        latest,
        latestPhysician: cleanName(latest.result.recommended_physician.physician_name),
        latestSpecialty: latest.result.recommended_physician.specialty,
        records: ordered,
      }
    })
    .sort((a, b) => b.latest.completed_at.localeCompare(a.latest.completed_at))
}
