import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess } from "@/lib/auth/clinic-scope";
import { canEditSection } from "@/lib/auth/section-ownership";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  AuditAction,
  EntryType,
  ProvenanceType,
  type Role,
} from "@/generated/prisma/client";

// Role -> the single EntryType each role may create via this endpoint.
// AI/system-authored types (ai_doctor_consult_summary, ai_nurse_consult_summary,
// system_event) are intentionally excluded — that ingestion path belongs to the
// AI Scribe step and is not implemented yet. Admin has no entry here: Admin
// never authors clinical content and is rejected before this map is consulted.
const ROLE_CREATABLE_TYPE: Partial<Record<Role, EntryType>> = {
  Patient: EntryType.patient_session_summary,
  Staff: EntryType.staff_note,
  Clinician: EntryType.clinician_note,
};

const UNSUPPORTED_TYPES = new Set<string>([
  EntryType.ai_doctor_consult_summary,
  EntryType.ai_nurse_consult_summary,
  EntryType.system_event,
]);

export async function POST(request: Request): Promise<Response> {
  try {
    const user = authenticate(request);

    // Admin never authors clinical content — coarse gate, no body needed.
    if (user.role === "Admin") {
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
      content?: unknown;
      patientId?: unknown;
      type?: unknown;
      sectionKey?: unknown;
    };

    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      throw new ApiError(400, "content is required");
    }
    if (typeof body.patientId !== "string" || body.patientId.trim().length === 0) {
      throw new ApiError(400, "patientId is required");
    }
    if (typeof body.type !== "string" || body.type.trim().length === 0) {
      throw new ApiError(400, "type is required");
    }

    const requestedType = body.type;

    // Unsupported for any role — a capability gap, not a permission decision.
    if (UNSUPPORTED_TYPES.has(requestedType)) {
      throw new ApiError(
        400,
        `type '${requestedType}' is not creatable via this endpoint yet (AI Scribe ingestion is a separate, not-yet-implemented path)`,
      );
    }

    // Role -> type mismatch is a permission decision: the same type would
    // succeed for a different role, so this is 403, not 400.
    const allowedType = ROLE_CREATABLE_TYPE[user.role];
    if (!allowedType || requestedType !== allowedType) {
      throw new ApiError(
        403,
        `Role '${user.role}' cannot create entries of type '${requestedType}'`,
      );
    }

    // sectionKey: derived for Patient/Staff, client-specified (and verified
    // against the canonical ownership map) for Clinician — clinician_note
    // covers multiple sections (plan/summary/medication), so the role alone
    // cannot determine which one is intended.
    let sectionKey: string | null;
    if (user.role === "Clinician") {
      if (typeof body.sectionKey !== "string" || body.sectionKey.trim().length === 0) {
        throw new ApiError(400, "sectionKey is required for Clinician-authored entries");
      }
      if (!canEditSection(user.role, body.sectionKey)) {
        throw new ApiError(
          403,
          `Role 'Clinician' cannot edit section '${body.sectionKey}'`,
        );
      }
      sectionKey = body.sectionKey;
    } else if (user.role === "Staff") {
      sectionKey = "staff_note";
    } else {
      // Patient
      sectionKey = null;
    }

    const patient = await prisma.patient.findUnique({
      where: { id: body.patientId },
      select: { id: true, clinicId: true },
    });
    if (!patient) {
      throw new ApiError(404, "Patient not found");
    }

    // Clinic scope uses DB patient.clinicId — never client-supplied.
    // Patient-role identity check (own record only) is included here too.
    assertPatientAccess(user, patient);

    // authorRole/authorId come from the verified JWT — never from the
    // request body — so a caller cannot author content as someone else
    // or bypass RBAC by claiming a different role.
    const created = await prisma.$transaction(async (tx) => {
      const entry = await tx.timelineEntry.create({
        data: {
          patientId: patient.id,
          authorRole: user.role,
          authorId: user.id,
          type: allowedType,
          content: body.content as string,
          sectionKey,
          provenanceType: ProvenanceType.none,
          provenanceId: null,
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

      // Audit only — no raw content. No Version row: version 1 is the live
      // state itself, there is no prior content to snapshot on creation.
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
