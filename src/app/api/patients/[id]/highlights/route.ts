import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { classifyRiskFloor } from "@/lib/risk/classify-risk";
import {
  deriveAdaptivePriority,
  normalizeRiskReason,
} from "@/lib/highlights/derive-adaptive-priority";
import { orderHighlightsBySafetyThenPriority } from "@/lib/highlights/order-adaptive-highlights";
import {
  resolveRiskReasonBucket,
  tokenizeRiskReason,
  type LexicalBucket,
} from "@/lib/highlights/lexical-grouping";

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

    // Internal Highlights (risk flags, adaptive/feedback metadata, and the
    // linked internal entry content) are a clinical-workflow surface with no
    // legitimate Patient use — identical stance to Glance and internal
    // comments. Patient is rejected before any DB access at all, so the
    // endpoint cannot be used to enumerate internal Highlight existence.
    // This is stronger than metadata-stripping: a Patient retrieves nothing.
    if (user.role === "Patient") {
      throw new ApiError(403, "Forbidden");
    }

    const { id } = await params;

    const patient = await prisma.patient.findUnique({
      where: { id },
      select: { id: true, clinicId: true },
    });
    if (!patient) {
      throw new ApiError(404, "Patient not found");
    }

    // Resource exists but belongs to another clinic -> 403 (all roles,
    // including Admin). Patient role is already denied above, so this is
    // effectively a clinic-scope check for the remaining staff roles.
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
            content: true,
            provenanceType: true,
            provenanceId: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    function baseShape(h: (typeof highlights)[number]) {
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
    }

    // ─── Feedback-Informed Adaptive Highlight Prioritization ──────────────
    // Read-time derivation only — nothing below is persisted, and no existing
    // field's meaning changes. `importance` stays the base importance.
    //
    // Aggregation scope: all NON-PENDING (accepted/rejected) Highlights in
    // the SAME CLINIC as this patient. Clinic scope (patient.clinicId, DB-
    // derived) is applied to the query FIRST — Clinic A feedback can never
    // reach Clinic B and vice versa. `pending` never contributes.
    //
    // Grouping: exact normalized riskReason first; if a Highlight's reason
    // does not exactly match any existing same-clinic bucket, a deterministic
    // lexical-overlap fallback (see lexical-grouping.ts) may attach it to the
    // single best-matching bucket. This is a literal-token heuristic, never
    // semantic similarity.
    const clinicFeedbackRows = await prisma.highlight.findMany({
      where: {
        feedback: { in: ["accepted", "rejected"] },
        patient: { clinicId: patient.clinicId },
      },
      select: { id: true, riskReason: true, feedback: true, createdAt: true },
    });

    const grouped = new Map<
      string,
      {
        accepted: number;
        rejected: number;
        members: { id: string; createdAt: Date; riskReason: string }[];
      }
    >();
    for (const row of clinicFeedbackRows) {
      const key = normalizeRiskReason(row.riskReason);
      const g = grouped.get(key) ?? { accepted: 0, rejected: 0, members: [] };
      if (row.feedback === "accepted") g.accepted += 1;
      else g.rejected += 1;
      g.members.push({ id: row.id, createdAt: row.createdAt, riskReason: row.riskReason });
      grouped.set(key, g);
    }

    const bucketCounts = new Map<string, { accepted: number; rejected: number }>();
    const lexicalBuckets: LexicalBucket[] = [];
    for (const [key, g] of grouped) {
      bucketCounts.set(key, { accepted: g.accepted, rejected: g.rejected });
      // Deterministic representative: earliest createdAt, then id ASC.
      const representative = [...g.members].sort((a, b) => {
        const byTime = a.createdAt.getTime() - b.createdAt.getTime();
        if (byTime !== 0) return byTime;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })[0];
      lexicalBuckets.push({
        key,
        representativeId: representative.id,
        representativeRiskReason: representative.riskReason,
        tokenSet: tokenizeRiskReason(normalizeRiskReason(representative.riskReason)),
      });
    }

    const derived = highlights.map((h) => {
      const resolution = resolveRiskReasonBucket(
        normalizeRiskReason(h.riskReason),
        lexicalBuckets,
      );
      const bucket =
        resolution.matchedKey !== null
          ? bucketCounts.get(resolution.matchedKey) ?? { accepted: 0, rejected: 0 }
          : { accepted: 0, rejected: 0 };
      const adaptive = deriveAdaptivePriority({
        baseImportance: h.importance,
        acceptedCount: bucket.accepted,
        rejectedCount: bucket.rejected,
      });
      // riskFloor is the deterministic safety boundary, computed here purely
      // from quotedText + riskReason. Adaptive logic never feeds it.
      const riskFloor = classifyRiskFloor({
        quotedText: h.quotedText,
        riskReason: h.riskReason,
      });

      return {
        ...baseShape(h),
        riskFloor,
        acceptedCount: adaptive.acceptedCount,
        rejectedCount: adaptive.rejectedCount,
        feedbackCount: adaptive.feedbackCount,
        reviewCount: adaptive.reviewCount,
        acceptanceRate: adaptive.acceptanceRate,
        learningStatus: adaptive.learningStatus,
        learnedAdjustment: adaptive.learnedAdjustment,
        effectiveImportance: adaptive.effectiveImportance,
        // Grouping traceability (derived, not persisted).
        matchMethod: resolution.matchMethod,
        lexicalOverlapScore: resolution.lexicalOverlapScore,
        matchedPattern: resolution.matchedPattern,
        matchedBucketRepresentativeId: resolution.matchedBucketRepresentativeId,
      };
    });

    // Safety-first deterministic presentation order (not persisted):
    // riskFloor severity → effectiveImportance DESC → createdAt DESC → id ASC.
    return Response.json(orderHighlightsBySafetyThenPriority(derived));
  } catch (error) {
    return toErrorResponse(error);
  }
}
