import { authenticate } from "@/lib/auth/jwt";
import { assertPatientAccess, assertClinicScope } from "@/lib/auth/clinic-scope";
import { assertSectionOwnership } from "@/lib/auth/section-ownership";
import { isPatientVisibleEntry } from "@/lib/auth/patient-filter";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import {
  AuditAction,
  EntryAuthorRole,
  EntryType,
  ProvenanceType,
} from "@/generated/prisma/client";

// Nightingale Write Invariant:
// Any server-side path that modifies TimelineEntry.content must:
//   1. Use a conditional update: WHERE id = X AND versionNumber = expectedVersion
//   2. count = 0 → rollback, no Version created, content unchanged
//   3. count = 1 → versionNumber + 1 (atomic with the update)
//   4. Version snapshot created ONLY after successful conditional claim
//   5. Stale writes must not leave a Version row or modify content
// Revert and any future clinical edits must follow the same invariant.
class StaleVersionError extends Error {
  constructor() {
    super("Stale version");
    this.name = "StaleVersionError";
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);
    const { id } = await params;

    const entry = await prisma.timelineEntry.findUnique({
      where: { id },
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

    // resource 存在但跨 clinic -> 403
    // Patient 存取他人 patient 的 entry -> 403
    assertPatientAccess(user, entry.patient);

    // Patient role: internal entries appear as 404 to avoid leaking existence
    if (user.role === "Patient" && !isPatientVisibleEntry(entry)) {
      throw new ApiError(404, "Timeline entry not found");
    }

    return Response.json({
      id: entry.id,
      patientId: entry.patientId,
      type: entry.type,
      content: entry.content,
      sectionKey: entry.sectionKey,
      authorRole: entry.authorRole,
      versionNumber: entry.versionNumber,
      provenanceType: entry.provenanceType,
      provenanceId: entry.provenanceId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // Patient and Admin cannot modify timeline entries.
    if (user.role === "Patient" || user.role === "Admin") {
      throw new ApiError(403, "Forbidden");
    }

    // Parse and validate request body.
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new ApiError(400, "Invalid request body");
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ApiError(400, "Invalid request body");
    }

    const body = raw as { content?: unknown; expectedVersion?: unknown };
    if (typeof body.content !== "string" || body.content.trim().length === 0) {
      throw new ApiError(400, "content is required");
    }
    if (
      typeof body.expectedVersion !== "number" ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 1
    ) {
      throw new ApiError(400, "expectedVersion must be a positive integer");
    }

    const newContent = body.content;
    const expectedVersion = body.expectedVersion;
    const { id } = await params;

    // Load entry for authorization and override detection.
    // sectionKey / type / authorRole come from DB — never from client.
    const entry = await prisma.timelineEntry.findUnique({
      where: { id },
      select: {
        id: true,
        patientId: true,
        content: true,
        versionNumber: true,
        sectionKey: true,
        type: true,
        authorRole: true,
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

    // Section ownership uses DB entry.sectionKey — never client-supplied.
    assertSectionOwnership(user.role, entry.sectionKey);

    // Clinician correction of AI/patient-provided content:
    // update succeeds normally, but also emits conflict_flagged audit.
    const isClinicianOverride =
      user.role === "Clinician" &&
      (entry.type === EntryType.ai_doctor_consult_summary ||
        entry.type === EntryType.ai_nurse_consult_summary ||
        entry.authorRole === EntryAuthorRole.Patient ||
        entry.authorRole === EntryAuthorRole.system);

    // ── Nightingale Write Invariant ──────────────────────────────────────────
    // Conditional update FIRST. Version snapshot only after successful claim.
    // count = 0 → rollback, no Version, content unchanged.
    // count = 1 → versionNumber + 1, then snapshot of replaced content.
    // ────────────────────────────────────────────────────────────────────────
    let updatedEntry: {
      id: string;
      content: string;
      versionNumber: number;
      updatedAt: Date;
    } | null = null;

    try {
      updatedEntry = await prisma.$transaction(async (tx) => {
        // STEP 1: Atomic conditional update — the single atomicity gate.
        // Only one concurrent writer at versionNumber = expectedVersion can succeed.
        const { count } = await tx.timelineEntry.updateMany({
          where: { id, versionNumber: expectedVersion },
          data: { content: newContent, versionNumber: { increment: 1 } },
        });

        if (count === 0) {
          // Stale write. Throw to trigger rollback. No Version is created.
          throw new StaleVersionError();
        }

        // STEP 2: count === 1 — we atomically claimed versionNumber = expectedVersion.
        // Snapshot the content we just replaced using the pre-transaction read.
        // Invariant: if count === 1, no concurrent writer has modified this entry
        // since our pre-tx read, because any such writer would have incremented
        // versionNumber past expectedVersion, causing count = 0.
        const snapshot = await tx.version.create({
          data: {
            timelineEntryId: id,
            content: entry.content,          // pre-update content (safe, see invariant)
            versionNumber: expectedVersion,  // version being replaced
            editorId: user.id,
          },
        });

        // STEP 3: note_updated AuditEvent. Metadata only — no raw content.
        await tx.auditEvent.create({
          data: {
            clinicId: entry.patient.clinicId,
            actorId: user.id,
            actorRole: user.role,
            patientId: entry.patientId,
            timelineEntryId: id,
            versionId: snapshot.id,
            action: AuditAction.note_updated,
          },
        });

        // STEP 4: Clinician correction — extra conflict_flagged in same transaction.
        if (isClinicianOverride) {
          await tx.auditEvent.create({
            data: {
              clinicId: entry.patient.clinicId,
              actorId: user.id,
              actorRole: user.role,
              patientId: entry.patientId,
              timelineEntryId: id,
              versionId: snapshot.id,
              action: AuditAction.conflict_flagged,
            },
          });

          // Visible system_event counterpart to the conflict_flagged audit
          // record above — the brief requires conflict flagging to appear
          // on the timeline itself, not only in the audit trail. Same
          // transaction: a failure here must roll back the whole write,
          // never leaving the clinical content changed without this record.
          await tx.timelineEntry.create({
            data: {
              patientId: entry.patientId,
              authorRole: EntryAuthorRole.system,
              authorId: null,
              type: EntryType.system_event,
              content: "Conflict flagged for clinician review",
              sectionKey: null,
              provenanceType: ProvenanceType.none,
              provenanceId: null,
            },
          });
        }

        // STEP 5: Fetch and return the updated entry.
        const result = await tx.timelineEntry.findUnique({
          where: { id },
          select: {
            id: true,
            content: true,
            versionNumber: true,
            updatedAt: true,
          },
        });
        if (!result) throw new Error("Unexpected: entry missing after successful update");
        return result;
      });
    } catch (err) {
      if (err instanceof StaleVersionError) {
        // Transaction rolled back: no Version created, content unchanged.
        // Conflict audit is best-effort — must not prevent the 409 response.
        try {
          await prisma.auditEvent.create({
            data: {
              clinicId: entry.patient.clinicId,
              actorId: user.id,
              actorRole: user.role,
              patientId: entry.patientId,
              timelineEntryId: id,
              versionId: null,
              action: AuditAction.conflict_flagged,
            },
          });
        } catch {
          // PHI-safe metadata logging only.
          console.error("Failed to persist stale conflict audit", {
            timelineEntryId: id,
            clinicId: entry.patient.clinicId,
          });
        }
        return Response.json(
          { error: "Conflict: entry has been modified" },
          { status: 409 },
        );
      }
      throw err;
    }

    return Response.json(updatedEntry);
  } catch (error) {
    return toErrorResponse(error);
  }
}
