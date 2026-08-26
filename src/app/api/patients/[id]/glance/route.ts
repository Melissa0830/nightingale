import { authenticate } from "@/lib/auth/jwt";
import { assertClinicScope } from "@/lib/auth/clinic-scope";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { EntryType } from "@/generated/prisma/client";
import { classifyRiskFloor } from "@/lib/risk/classify-risk";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // Glance View is a clinical workflow triage screen — assignments,
    // internal risk flags, unresolved comments. Patient has no legitimate
    // use for it (identical to Patient's blanket exclusion from comments),
    // so it is rejected before any DB access at all — not filtered like
    // the read routes that serve both Patient and staff roles.
    if (user.role === "Patient") {
      throw new ApiError(403, "Forbidden");
    }

    const { id } = await params;

    const patient = await prisma.patient.findUnique({
      where: { id },
      select: { id: true, clinicId: true, displayName: true },
    });
    if (!patient) {
      throw new ApiError(404, "Patient not found");
    }

    // Clinic scope uses DB-derived clinicId — never client-supplied.
    // Patient role is already excluded above, so this is a plain clinic-scope
    // check, not assertPatientAccess (there is no "Patient accessing their
    // own record" case left to handle here).
    assertClinicScope(user, patient.clinicId);

    // Authorization is fully settled above. Only now do the three
    // independent clinical-data reads run in parallel — never before
    // clinic scope is confirmed.
    const [openActionRows, highlightRows, recentEntryRows] = await Promise.all([
      // Open Actions: unresolved comments across the whole patient, via the
      // Comment -> TimelineEntry relation. No existing patient-scoped comment
      // query to reuse — GET /timeline/:id/comments is entry-scoped only.
      // No take limit: this is a clinical to-do list, not a preview.
      prisma.comment.findMany({
        where: {
          resolved: false,
          timelineEntry: { patientId: patient.id },
        },
        select: {
          id: true,
          timelineEntryId: true,
          content: true,
          assignedToId: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),

      // Risk Highlights: same query shape as GET /api/patients/:id/highlights,
      // but a leaner select — no entry join, no quotedTextFound/occurrenceCount/
      // entryContent (those are Provenance jump-to-source concerns, not needed
      // for a glance summary). No isCritical/severity/tier: importance is
      // currently always 0 (Self-Learning has not run) and riskReason is a
      // required field on every Highlight, so neither can support a reliable
      // criticality signal yet — the raw fields are returned as-is.
      prisma.highlight.findMany({
        where: { patientId: patient.id },
        select: {
          id: true,
          entryId: true,
          quotedText: true,
          riskReason: true,
          importance: true,
          feedback: true,
        },
        orderBy: { createdAt: "desc" },
      }),

      // Recent Changes: the 5 most recently updated TimelineEntry rows.
      // This is NOT semantic change detection, NOT a "BP increased"-style
      // summary, and NOT a version-diff result — diffing is an explicit
      // UI-layer concern (see the `diff` npm package decision), and no
      // summarization logic exists here or anywhere in this API.
      prisma.timelineEntry.findMany({
        where: {
          patientId: patient.id,
          type: { not: EntryType.system_event },
        },
        select: {
          id: true,
          type: true,
          sectionKey: true,
          content: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
      }),
    ]);

    return Response.json({
      patientId: patient.id,
      displayName: patient.displayName,
      openActions: openActionRows.map((c) => ({
        commentId: c.id,
        timelineEntryId: c.timelineEntryId,
        content: c.content,
        assignedToId: c.assignedToId,
        createdAt: c.createdAt,
      })),
      // riskFloor: deterministic, non-learned Core classification — see
      // src/lib/risk/classify-risk.ts. Computed only from quotedText/
      // riskReason already selected above; importance/feedback are never
      // inputs, so a future Self-Learning weighting can never downgrade a
      // deterministic "critical" result. Additive field only — no new
      // query, no rescan of TimelineEntry, O(returned highlights) cost.
      riskHighlights: highlightRows.map((h) => ({
        id: h.id,
        entryId: h.entryId,
        quotedText: h.quotedText,
        riskReason: h.riskReason,
        importance: h.importance,
        feedback: h.feedback,
        riskFloor: classifyRiskFloor({ quotedText: h.quotedText, riskReason: h.riskReason }),
      })),
      recentChanges: recentEntryRows.map((e) => ({
        entryId: e.id,
        type: e.type,
        sectionKey: e.sectionKey,
        content: e.content,
        updatedAt: e.updatedAt,
      })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
