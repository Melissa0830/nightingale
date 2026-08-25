import { EntryType } from "@/generated/prisma/client";

/**
 * Entry types that Patient-role users are permitted to see.
 *
 * Patient NEVER sees:
 *   - internal comments (filtered at route level, not entry type level)
 *   - ai_doctor_consult_summary  (internal AI note)
 *   - ai_nurse_consult_summary   (internal AI note)
 *   - staff_note                 (internal clinical note)
 *   - clinician_note             (internal clinical note)
 *   - system_event               (internal audit/system record)
 *
 * Centralised here so filtering logic is never scattered across routes.
 * All timeline routes must use this helper when serving Patient-role requests.
 */
const PATIENT_VISIBLE_TYPES = new Set<string>([
  EntryType.patient_session_summary,
]);

/**
 * Returns true if a Patient-role user is permitted to see this entry.
 * Use this to filter timeline results and single-entry access for Patient users.
 */
export function isPatientVisibleEntry(entry: { type: string }): boolean {
  return PATIENT_VISIBLE_TYPES.has(entry.type);
}
