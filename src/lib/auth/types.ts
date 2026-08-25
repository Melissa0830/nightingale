import type { Role } from "@/generated/prisma/client";

/**
 * Authenticated user identity extracted from JWT.
 * Always validated server-side; never trust client-supplied role or clinicId.
 *
 * patientId is only set for users with role=Patient, linking them to their
 * Patient record for RBAC. All other roles leave this undefined.
 */
export interface AuthUser {
  id: string;
  clinicId: string;
  role: Role;
  patientId?: string;
}
