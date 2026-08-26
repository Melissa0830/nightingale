import { authenticate } from "@/lib/auth/jwt";
import { assertClinicScope } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // Only Staff/Clinician process comments. Patient has no comment
    // workflow; Admin remains read-only across the prototype.
    if (user.role === "Patient" || user.role === "Admin") {
      throw new ApiError(403, "Forbidden");
    }

    const { id: commentId } = await params;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError(400, "Invalid request body");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "Invalid request body");
    }

    const body = raw as { resolved?: unknown; assignedToId?: unknown };

    // `in` (not `!== undefined`) so an explicit `assignedToId: null`
    // (unassign) is distinguished from the key being omitted entirely
    // (leave that field untouched).
    const hasResolved = "resolved" in body;
    const hasAssignedTo = "assignedToId" in body;

    if (!hasResolved && !hasAssignedTo) {
      throw new ApiError(
        400,
        "At least one of resolved or assignedToId is required",
      );
    }
    if (hasResolved && typeof body.resolved !== "boolean") {
      throw new ApiError(400, "resolved must be boolean");
    }
    if (
      hasAssignedTo &&
      body.assignedToId !== null &&
      typeof body.assignedToId !== "string"
    ) {
      throw new ApiError(400, "assignedToId must be a string or null");
    }

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        timelineEntry: {
          select: {
            patient: {
              select: { clinicId: true },
            },
          },
        },
      },
    });
    if (!comment) {
      throw new ApiError(404, "Comment not found");
    }

    const clinicId = comment.timelineEntry.patient.clinicId;

    // Clinic scope uses DB-derived clinicId — never client-supplied.
    assertClinicScope(user, clinicId);

    // assignedToId: must be a real user, same clinic, and a collaboration-
    // capable role (Staff/Clinician). One combined query — "doesn't exist",
    // "wrong clinic", and "wrong role" all collapse into the same 400, so
    // none of those facts about a third-party user leaks to the caller.
    let assignedToIdToSet: string | null | undefined;
    if (hasAssignedTo) {
      if (body.assignedToId === null) {
        assignedToIdToSet = null;
      } else {
        const assigneeId = body.assignedToId as string;
        const assignee = await prisma.user.findFirst({
          where: {
            id: assigneeId,
            clinicId,
            role: { in: [Role.Staff, Role.Clinician] },
          },
          select: { id: true },
        });
        if (!assignee) {
          throw new ApiError(400, "Invalid assignee");
        }
        assignedToIdToSet = assigneeId;
      }
    }

    const updated = await prisma.comment.update({
      where: { id: commentId },
      data: {
        ...(hasResolved ? { resolved: body.resolved as boolean } : {}),
        ...(hasAssignedTo ? { assignedToId: assignedToIdToSet } : {}),
      },
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
    });

    return Response.json(updated, { status: 200 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
