import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { redactPHI } from "@/lib/security/redact-phi";
import { getLlmAdapter, type SupportedSessionType } from "@/lib/ai/llm-adapter";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  AuditAction,
  EntryAuthorRole,
  EntryType,
  ProvenanceType,
} from "@/generated/prisma/client";

// sessionType -> (EntryType, ProvenanceType). sessionType values are exactly
// the SupportedSessionType / ProvenanceType literals, so this is the single
// source of truth for the ingestion mapping — no separate lookup needed.
const SESSION_TYPE_MAP: Record<
  SupportedSessionType,
  { entryType: EntryType; provenanceType: SupportedSessionType }
> = {
  doctor_consult: {
    entryType: EntryType.ai_doctor_consult_summary,
    provenanceType: ProvenanceType.doctor_consult,
  },
  nurse_consult: {
    entryType: EntryType.ai_nurse_consult_summary,
    provenanceType: ProvenanceType.nurse_consult,
  },
  patient_session: {
    entryType: EntryType.ai_patient_session_summary,
    provenanceType: ProvenanceType.patient_session,
  },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // AI Scribe ingestion represents a Staff/Clinician submitting a consult
    // transcript for the system to summarize. Patient-triggered ingestion
    // (e.g. from the patient's own AI session) is out of scope for this
    // prototype — see design review. Admin never authors content, same
    // blanket exclusion as POST /timeline.
    if (user.role !== "Staff" && user.role !== "Clinician") {
      throw new ApiError(403, "Forbidden");
    }

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
      sessionType?: unknown;
      sessionId?: unknown;
      rawText?: unknown;
    };

    if (
      typeof body.sessionType !== "string" ||
      !Object.prototype.hasOwnProperty.call(SESSION_TYPE_MAP, body.sessionType)
    ) {
      throw new ApiError(
        400,
        "sessionType must be one of: doctor_consult, nurse_consult, patient_session",
      );
    }
    if (typeof body.sessionId !== "string" || body.sessionId.trim().length === 0) {
      throw new ApiError(400, "sessionId is required");
    }
    if (typeof body.rawText !== "string" || body.rawText.trim().length === 0) {
      throw new ApiError(400, "rawText is required");
    }

    const sessionType = body.sessionType as SupportedSessionType;
    const sessionId = body.sessionId;
    const rawText = body.rawText;
    const { entryType, provenanceType } = SESSION_TYPE_MAP[sessionType];

    const { id } = await params;
    const patient = await prisma.patient.findUnique({
      where: { id },
      select: { id: true, clinicId: true, displayName: true },
    });
    if (!patient) {
      throw new ApiError(404, "Patient not found");
    }

    // Clinic scope uses DB-derived clinicId — never client-supplied. Patient
    // role is already rejected above, so this is a plain clinic-scope check.
    assertPatientAccess(user, patient);

    // knownNames scope: target patient's display name + every User.name in
    // the SAME clinic — never a cross-clinic search. This query only runs
    // after clinic authorization above. redactPHI itself stays pure/DB-free;
    // the DB lookup lives here, at the call site, not inside the gateway.
    const clinicUsers = await prisma.user.findMany({
      where: { clinicId: patient.clinicId },
      select: { name: true },
    });
    const knownNames = [patient.displayName, ...clinicUsers.map((u) => u.name)];

    // PHI boundary: only redactedText may cross into the adapter. rawText
    // must never reach the LLM adapter, logs, or persistence from this point on.
    const redactedText = redactPHI(rawText, knownNames);

    // Adapter call happens BEFORE the DB transaction opens — a transaction
    // must never sit open while waiting on an external/model call.
    const summary = await getLlmAdapter().summarize(redactedText, provenanceType);

    const created = await prisma.$transaction(async (tx) => {
      const entry = await tx.timelineEntry.create({
        data: {
          patientId: patient.id,
          authorRole: EntryAuthorRole.system,
          authorId: null,
          type: entryType,
          content: summary,
          sectionKey: "summary",
          provenanceType,
          provenanceId: sessionId,
        },
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

      await tx.aiScribedNote.create({
        data: {
          timelineEntryId: entry.id,
          sessionId,
          sourceType: provenanceType,
          redacted: true,
        },
      });

      // Audit only — no raw/redacted text, no summary content. No Version
      // row: version 1 is the live state itself, same create invariant as
      // POST /timeline (see src/app/api/timeline/route.ts).
      await tx.auditEvent.create({
        data: {
          clinicId: patient.clinicId,
          actorId: user.id,
          actorRole: user.role,
          patientId: patient.id,
          timelineEntryId: entry.id,
          versionId: null,
          action: AuditAction.note_created,
        },
      });

      return entry;
    });

    return Response.json(created, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
