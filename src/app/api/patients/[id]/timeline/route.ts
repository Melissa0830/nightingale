import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { isPatientVisibleEntry } from "@/lib/auth/patient-filter";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);
    const { id } = await params;

    const patient = await prisma.patient.findUnique({
      where: { id },
      select: { id: true, clinicId: true },
    });
    if (!patient) {
      throw new ApiError(404, "Patient not found");
    }

    // resource 存在但跨 clinic -> 403
    // Patient 存取他人 patient 的 timeline -> 403
    assertPatientAccess(user, patient);

    const entries = await prisma.timelineEntry.findMany({
      where: { patientId: patient.id },
      // Newest-first is the single source of truth for Timeline chronology
      // (matches Glance Recent Changes' reading direction). `id` ASC is a
      // deterministic tie-break for entries sharing an exact createdAt, so
      // the response order never depends on database insertion order.
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        patientId: true,
        type: true,
        content: true,
        sectionKey: true,
        authorRole: true,
        versionNumber: true,
        provenanceType: true,
        provenanceId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Reuse the same whitelist as the single-entry GET route — filtering
    // logic must not be reinvented per route (see patient-filter.ts).
    const visibleEntries =
      user.role === "Patient" ? entries.filter(isPatientVisibleEntry) : entries;

    return Response.json(visibleEntries);
  } catch (error) {
    return toErrorResponse(error);
  }
}
