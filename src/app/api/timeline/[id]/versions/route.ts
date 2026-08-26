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

    const entry = await prisma.timelineEntry.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        content: true,
        versionNumber: true,
        patient: {
          select: {
            id: true,
            clinicId: true,
          },
        },
      },
    });

    if (!entry) {
      throw new ApiError(404, "Timeline entry not found");
    }

    // resource 存在但跨 clinic -> 403
    // Patient 存取他人 patient 的 entry -> 403
    assertPatientAccess(user, entry.patient);

    // Patient role: internal entries appear as 404 to avoid leaking existence.
    if (user.role === "Patient" && !isPatientVisibleEntry(entry)) {
      throw new ApiError(404, "Timeline entry not found");
    }

    // Version table only holds HISTORICAL (superseded) snapshots. The
    // current live version never has a Version row — it exists only on
    // TimelineEntry — so it is reported separately, never mixed into
    // this array.
    const versions = await prisma.version.findMany({
      where: { timelineEntryId: id },
      select: {
        id: true,
        versionNumber: true,
        content: true,
        editorId: true,
        createdAt: true,
      },
      orderBy: { versionNumber: "asc" },
    });

    return Response.json({
      entryId: entry.id,
      currentVersionNumber: entry.versionNumber,
      currentContent: entry.content,
      versions,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
