import { authenticate } from "@/lib/auth/jwt";
import { assertClinicScope } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);
    const { id } = await params;

    // No Patient comment workflow — deny before any DB access.
    if (user.role === "Patient") {
      throw new ApiError(403, "Patients cannot access comments");
    }

    const entry = await prisma.timelineEntry.findUnique({
      where: { id },
      select: {
        id: true,
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

    // Staff / Clinician / Admin: enforce clinic scope.
    assertClinicScope(user, entry.patient.clinicId);

    const comments = await prisma.comment.findMany({
      where: { timelineEntryId: id },
      select: {
        id: true,
        timelineEntryId: true,
        authorId: true,
        content: true,
        resolved: true,
        assignedToId: true,
        mentions: true,
        parentId: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    return Response.json(comments);
  } catch (error) {
    return toErrorResponse(error);
  }
}
