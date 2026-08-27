import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { isPatientVisibleEntry } from "@/lib/auth/patient-filter";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  deriveAdaptivePriority,
  normalizeRiskReason,
} from "@/lib/highlights/derive-adaptive-priority";

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

    // ─── Feedback-Informed Adaptive Highlight Prioritization (Bonus) ──────
    // Read-time derivation only — nothing below is persisted, and no existing
    // field's meaning changes. `importance` stays the base importance.
    //
    // Aggregation scope: all NON-PENDING (accepted/rejected) Highlights in
    // the SAME CLINIC as this patient, grouped by normalized riskReason.
    // Clinic scope comes from patient.clinicId (DB-derived) — Clinic A
    // feedback can never reach Clinic B and vice versa. `pending` never
    // contributes to the threshold. Every persisted non-pending Highlight in
    // the clinic+bucket participates, including the current Highlight's own
    // feedback when it is accepted/rejected — a pending target is adjusted
    // purely by prior feedback on the same recurring pattern.
    const clinicFeedbackRows = await prisma.highlight.findMany({
      where: {
        feedback: { in: ["accepted", "rejected"] },
        patient: { clinicId: patient.clinicId },
      },
      select: { riskReason: true, feedback: true },
    });

    const bucketCounts = new Map<string, { accepted: number; rejected: number }>();
    for (const row of clinicFeedbackRows) {
      const key = normalizeRiskReason(row.riskReason);
      const bucket = bucketCounts.get(key) ?? { accepted: 0, rejected: 0 };
      if (row.feedback === "accepted") bucket.accepted += 1;
      else bucket.rejected += 1;
      bucketCounts.set(key, bucket);
    }

    const response = visibleHighlights.map((h) => {
      const content = h.entry.content;
      const occurrenceCount = countOccurrences(content, h.quotedText);

      const bucket = bucketCounts.get(normalizeRiskReason(h.riskReason)) ?? {
        accepted: 0,
        rejected: 0,
      };
      const adaptive = deriveAdaptivePriority({
        baseImportance: h.importance,
        acceptedCount: bucket.accepted,
        rejectedCount: bucket.rejected,
      });

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
        // Derived, non-persisted adaptive prioritization fields.
        acceptedCount: adaptive.acceptedCount,
        rejectedCount: adaptive.rejectedCount,
        feedbackCount: adaptive.feedbackCount,
        learnedAdjustment: adaptive.learnedAdjustment,
        effectiveImportance: adaptive.effectiveImportance,
      };
    });

    return Response.json(response);
  } catch (error) {
    return toErrorResponse(error);
  }
}
