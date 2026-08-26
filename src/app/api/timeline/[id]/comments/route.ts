import { authenticate } from "@/lib/auth/jwt";
import { assertClinicScope } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { Role } from "@/generated/prisma/client";

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // Only Staff/Clinician author comments. Patient has no comment
    // workflow; Admin remains read-only across the prototype.
    if (user.role === "Patient" || user.role === "Admin") {
      throw new ApiError(403, "Forbidden");
    }

    const { id: entryId } = await params;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError(400, "Invalid request body");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "Invalid request body");
    }

    const body = raw as {
      content?: unknown;
      parentId?: unknown;
      assignedToId?: unknown;
      mentions?: unknown;
    };

    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      throw new ApiError(400, "content is required");
    }
    if (body.parentId !== undefined && typeof body.parentId !== "string") {
      throw new ApiError(400, "parentId must be a string");
    }
    if (body.assignedToId !== undefined && typeof body.assignedToId !== "string") {
      throw new ApiError(400, "assignedToId must be a string");
    }
    if (
      body.mentions !== undefined &&
      (!Array.isArray(body.mentions) ||
        !body.mentions.every((m) => typeof m === "string"))
    ) {
      throw new ApiError(400, "mentions must be an array of strings");
    }

    const entry = await prisma.timelineEntry.findUnique({
      where: { id: entryId },
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

    // Clinic scope uses DB patient.clinicId — never client-supplied.
    assertClinicScope(user, entry.patient.clinicId);

    // parentId: must reference an existing comment on THIS entry. A single
    // combined-condition query — existence and entry-membership are not
    // distinguished in the error, so a caller can't probe which one failed.
    if (body.parentId !== undefined) {
      const parent = await prisma.comment.findFirst({
        where: { id: body.parentId, timelineEntryId: entryId },
        select: { id: true },
      });
      if (!parent) {
        throw new ApiError(400, "Invalid parentId");
      }
    }

    // assignedToId: must be a real user, same clinic, and a collaboration-
    // capable role (Staff/Clinician). One combined query — "doesn't exist",
    // "wrong clinic", and "wrong role" all collapse into the same 400, so
    // none of those facts about a third-party user leaks to the caller.
    if (body.assignedToId !== undefined) {
      const assignee = await prisma.user.findFirst({
        where: {
          id: body.assignedToId,
          clinicId: entry.patient.clinicId,
          role: { in: [Role.Staff, Role.Clinician] },
        },
        select: { id: true },
      });
      if (!assignee) {
        throw new ApiError(400, "Invalid assignee");
      }
    }

    // mentions: this endpoint only validates and stores IDs (API/storage
    // semantics). Free-text "@name" parsing into these IDs is a
    // Collaboration UI concern for a later step — not implemented here.
    // De-duplicated before validation AND before storage, so the same
    // user ID is never persisted twice in one comment's mentions array.
    let mentionIds: string[] = [];
    if (body.mentions !== undefined) {
      mentionIds = [...new Set(body.mentions as string[])];
      if (mentionIds.length > 0) {
        const validMentionUsers = await prisma.user.findMany({
          where: {
            id: { in: mentionIds },
            clinicId: entry.patient.clinicId,
            role: { in: [Role.Staff, Role.Clinician] },
          },
          select: { id: true },
        });
        if (validMentionUsers.length !== mentionIds.length) {
          throw new ApiError(400, "Invalid mention");
        }
      }
    }

    // authorId comes from the verified JWT — never from the request body —
    // and resolved always starts false; neither is client-controllable.
    const comment = await prisma.comment.create({
      data: {
        timelineEntryId: entryId,
        authorId: user.id,
        content: body.content,
        resolved: false,
        assignedToId:
          typeof body.assignedToId === "string" ? body.assignedToId : null,
        mentions: mentionIds,
        parentId: typeof body.parentId === "string" ? body.parentId : null,
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

    return Response.json(comment, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
