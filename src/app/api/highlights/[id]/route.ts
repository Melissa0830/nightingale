import { authenticate } from "@/lib/auth/jwt";
import { assertClinicScope } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // Strict Clinician-only: brief text is "Clinicians must be able to
    // accept/reject" — this is the clinical decision authority, not a
    // general Staff/Clinician collaboration action like comments.
    if (user.role !== "Clinician") {
      throw new ApiError(403, "Forbidden");
    }

    const { id: highlightId } = await params;

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError(400, "Invalid request body");
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "Invalid request body");
    }

    const body = raw as { feedback?: unknown };

    // "pending" is the initial state, not a valid client-requested
    // transition — only accepted/rejected are accepted here.
    if (body.feedback !== "accepted" && body.feedback !== "rejected") {
      throw new ApiError(400, "feedback must be 'accepted' or 'rejected'");
    }

    const highlight = await prisma.highlight.findUnique({
      where: { id: highlightId },
      select: {
        id: true,
        entry: {
          select: {
            patient: {
              select: { clinicId: true },
            },
          },
        },
      },
    });
    if (!highlight) {
      throw new ApiError(404, "Highlight not found");
    }

    // Clinic scope uses DB-derived clinicId — never client-supplied.
    assertClinicScope(user, highlight.entry.patient.clinicId);

    // Only feedback is written. importance / ranking are Self-Learning's
    // job, not this endpoint's — this call records the decision only.
    const updated = await prisma.highlight.update({
      where: { id: highlightId },
      data: { feedback: body.feedback },
      select: {
        id: true,
        patientId: true,
        entryId: true,
        quotedText: true,
        riskReason: true,
        importance: true,
        feedback: true,
        createdAt: true,
      },
    });

    return Response.json(updated);
  } catch (error) {
    return toErrorResponse(error);
  }
}
