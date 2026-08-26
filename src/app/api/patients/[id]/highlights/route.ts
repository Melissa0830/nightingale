import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { isPatientVisibleEntry } from "@/lib/auth/patient-filter";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";

// Exact, case-sensitive substring occurrence count — no normalization,
// no regex, no dependency. Mirrors the deliberate "quotedText string
// match, not offset tracking" provenance simplification.
function countOccurrences(content: string, quotedText: string): number {
  if (quotedText.length === 0) return 0;

  let count = 0;
  let position = 0;

  while (true) {
    const index = content.indexOf(quotedText, position);
    if (index === -1) break;

    count += 1;
    position = index + quotedText.length;
  }

  return count;
}

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
    // Patient 存取他人 patient 的 highlights -> 403
    assertPatientAccess(user, patient);

    const highlights = await prisma.highlight.findMany({
      where: { patientId: patient.id },
      select: {
        id: true,
        patientId: true,
        entryId: true,
        quotedText: true,
        riskReason: true,
        importance: true,
        feedback: true,
        createdAt: true,
        entry: {
          select: {
            type: true,
            content: true,
            provenanceType: true,
            provenanceId: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Reuse the same whitelist as the timeline routes. Filtering happens
    // BEFORE the response is built — an internal-entry highlight is fully
    // absent from the array (no placeholder, no redacted shell), and no
    // count/total field anywhere reveals how many were removed.
    const visibleHighlights =
      user.role === "Patient"
        ? highlights.filter((h) => isPatientVisibleEntry({ type: h.entry.type }))
        : highlights;

    const response = visibleHighlights.map((h) => {
      const content = h.entry.content;
      const occurrenceCount = countOccurrences(content, h.quotedText);

      return {
        id: h.id,
        patientId: h.patientId,
        entryId: h.entryId,
        quotedText: h.quotedText,
        riskReason: h.riskReason,
        importance: h.importance,
        feedback: h.feedback,
        createdAt: h.createdAt,
        quotedTextFound: occurrenceCount > 0,
        occurrenceCount,
        entryContent: content,
        entryProvenanceType: h.entry.provenanceType,
        entryProvenanceId: h.entry.provenanceId,
      };
    });

    return Response.json(response);
  } catch (error) {
    return toErrorResponse(error);
  }
}
