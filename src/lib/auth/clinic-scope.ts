import { ApiError } from "@/lib/errors";
import type { AuthUser } from "./types";

/**
 * Central clinic-scope guard. Must be called on every protected request.
 * Applies to ALL roles including Admin — no cross-clinic exceptions.
 */
export function assertClinicScope(
  user: AuthUser,
  targetClinicId: string,
): void {
  if (user.clinicId !== targetClinicId) {
    throw new ApiError(403, "Cross-clinic access denied");
  }
}

/**
 * Patient access guard. Combines clinic-scope check with patient identity check.
 *
 * - Any non-Patient role with matching clinicId is allowed.
 * - A Patient-role user may only access their own Patient record.
 *   user.patientId is guaranteed to be set for role=Patient (enforced in JWT).
 */
export function assertPatientAccess(
  user: AuthUser,
  patient: { id: string; clinicId: string },
): void {
  assertClinicScope(user, patient.clinicId);
  if (user.role === "Patient" && user.patientId !== patient.id) {
    throw new ApiError(403, "Patient may only access own record");
  }
}
