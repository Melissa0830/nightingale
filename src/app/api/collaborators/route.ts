import { authenticate } from "@/lib/auth/jwt";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/client";

// Internal collaboration directory for the comment workflow: the set of
// users who can be @mentioned in, or assigned to, an internal comment.
//
// This is intentionally "my clinic collaborators" — there is no patient or
// clinic id in the path. The clinic is taken from the verified JWT, so a
// caller only ever sees their own clinic and cross-clinic leakage is
// impossible by construction.
//
// Eligible set === exactly what POST /api/timeline/:id/comments and
// PATCH /api/comments/:id already accept as a mention / assignee:
// same-clinic users with role Staff or Clinician. Admin is read-only for
// comments and is never a valid assignee, so Admin is never listed (an
// Admin caller may still READ the list to resolve names on the read-only
// comments view). Patient has no comment workflow at all → 403.
export async function GET(request: Request): Promise<Response> {
  try {
    const user = authenticate(request);

    if (user.role === Role.Patient) {
      throw new ApiError(403, "Forbidden");
    }

    const collaborators = await prisma.user.findMany({
      where: {
        clinicId: user.clinicId,
        role: { in: [Role.Staff, Role.Clinician] },
      },
      // Minimum fields for selection + display only. No email, no
      // patientId, no auth material.
      select: { id: true, name: true, role: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });

    return Response.json(collaborators);
  } catch (error) {
    return toErrorResponse(error);
  }
}
