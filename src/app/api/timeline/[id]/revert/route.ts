import { authenticate } from "@/lib/auth/jwt";
import { assertClinicScope } from "@/lib/auth/clinic-scope";
import { assertSectionOwnership } from "@/lib/auth/section-ownership";
import { ApiError, toErrorResponse } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { AuditAction, EntryAuthorRole, EntryType } from "@/generated/prisma/client";

// Nightingale Write Invariant (same invariant PUT follows — see
// src/app/api/timeline/[id]/route.ts):
//   1. Conditional update: WHERE id = X AND versionNumber = expectedVersion
//   2. count = 0 → rollback, no Version created, content unchanged
//   3. count = 1 → versionNumber + 1 (atomic with the update)
//   4. Version snapshot created ONLY after successful conditional claim
//   5. Stale writes must not leave a Version row or modify content
//
// Revert-specific: "revert to vN" never rewinds TimelineEntry.versionNumber
// back to N. The current live version (e.g. v4 = D) is archived as a new
// Version row FIRST, then the target's content (e.g. v1 = A) becomes the
// new live content, and versionNumber advances forward (4 -> 5). Version
// numbers are monotonically increasing; a revert is itself a new revision,
// not a rewind — this is required by the @@unique([timelineEntryId,
// versionNumber]) constraint and by the OCC model in general.
class StaleVersionError extends Error {
  constructor() {
    super("Stale version");
    this.name = "StaleVersionError";
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const user = authenticate(request);

    // Patient and Admin cannot modify timeline entries — identical gate to
    // PUT. Revert is just another way of writing `content`; no separate
    // revert-specific RBAC is invented.
    if (user.role === "Patient" || user.role === "Admin") {
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

    const body = raw as { targetVersion?: unknown; expectedVersion?: unknown };
    if (
      typeof body.targetVersion !== "number" ||
      !Number.isInteger(body.targetVersion) ||
      body.targetVersion < 1
    ) {
      throw new ApiError(400, "targetVersion must be a positive integer");
    }
    if (
      typeof body.expectedVersion !== "number" ||
      !Number.isInteger(body.expectedVersion) ||
      body.expectedVersion < 1
    ) {
      throw new ApiError(400, "expectedVersion must be a positive integer");
    }

    const targetVersion = body.targetVersion;
    const expectedVersion = body.expectedVersion;
    const { id } = await params;

    // Load entry for authorization and override detection — same fields
    // PUT loads, for the same reasons. sectionKey / type / authorRole come
    // from DB — never from client.
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
    // Identical to PUT: e.g. patient_session_summary has sectionKey=null,
    // which fails closed here for every role, so it can never be reverted.
    assertSectionOwnership(user.role, entry.sectionKey);

    // targetVersion must reference an existing Version row for THIS entry.
    // Combined-condition lookup on the compound unique key — cannot match
    // another entry's version row, and existence/entry-membership are not
    // distinguished in the error, so a caller cannot probe other entries'
    // version history via targetVersion.
    const targetVersionRow = await prisma.version.findUnique({
      where: {
        timelineEntryId_versionNumber: {
          timelineEntryId: entry.id,
          versionNumber: targetVersion,
        },
      },
    });
    if (!targetVersionRow) {
      throw new ApiError(400, "Invalid targetVersion");
    }

    // Clinician correction of AI/patient-provided content: only evaluated
    // AFTER section ownership already passed. Only reachable once a role
    // is already permitted to write this section (e.g. Clinician on a
    // Clinician-owned section carrying AI or patient-authored content) —
    // never reachable for sectionKey=null entries like patient_session_summary,
    // since assertSectionOwnership above already rejects those for every role.
    const isClinicianOverride =
      user.role === "Clinician" &&
      (entry.type === EntryType.ai_doctor_consult_summary ||
        entry.type === EntryType.ai_nurse_consult_summary ||
        entry.authorRole === EntryAuthorRole.Patient ||
        entry.authorRole === EntryAuthorRole.system);

    // ── Nightingale Write Invariant (revert variant) ──────────────────────
    // Conditional update FIRST. Version snapshot only after successful claim.
    // count = 0 → rollback, no Version, content unchanged.
    // count = 1 → versionNumber + 1, then snapshot of the replaced (pre-revert) content.
    // ───────────────────────────────────────────────────────────────────────
    let updatedEntry: {
      id: string;
      content: string;
      versionNumber: number;
      updatedAt: Date;
    } | null = null;

    try {
      updatedEntry = await prisma.$transaction(async (tx) => {
        // STEP 1: Atomic conditional update — the single atomicity gate.
        const { count } = await tx.timelineEntry.updateMany({
          where: { id, versionNumber: expectedVersion },
          data: {
            content: targetVersionRow.content,
            versionNumber: { increment: 1 },
          },
        });

        if (count === 0) {
          // Stale write. Throw to trigger rollback. No Version is created.
          throw new StaleVersionError();
        }

        // STEP 2: count === 1 — we atomically claimed versionNumber = expectedVersion.
        // Archive the pre-revert live content (e.g. v4 = D) as a new Version row.
        const archivedSnapshot = await tx.version.create({
          data: {
            timelineEntryId: id,
            content: entry.content,          // pre-revert content (safe, see invariant)
            versionNumber: expectedVersion,  // version being replaced
            editorId: user.id,
          },
        });

        // STEP 3: note_reverted AuditEvent.
        // Plan B semantics: versionId points to the TARGET version being
        // reverted TO (targetVersionRow), not the newly archived snapshot —
        // this makes "reverted to which version" directly queryable without
        // a schema change. This differs from note_updated's convention
        // (which points to what got replaced) — the two are different
        // actions with different natural referents.
        await tx.auditEvent.create({
          data: {
            clinicId: entry.patient.clinicId,
            actorId: user.id,
            actorRole: user.role,
            patientId: entry.patientId,
            timelineEntryId: id,
            versionId: targetVersionRow.id,
            action: AuditAction.note_reverted,
          },
        });

        // STEP 4: Clinician correction — extra conflict_flagged in same
        // transaction. Unlike note_reverted above, this keeps PUT's existing
        // convention: versionId points to what got overridden (the archived
        // pre-revert snapshot), not the target.
        if (isClinicianOverride) {
          await tx.auditEvent.create({
            data: {
              clinicId: entry.patient.clinicId,
              actorId: user.id,
              actorRole: user.role,
              patientId: entry.patientId,
              timelineEntryId: id,
              versionId: archivedSnapshot.id,
              action: AuditAction.conflict_flagged,
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
        if (!result) throw new Error("Unexpected: entry missing after successful revert");
        return result;
      });
    } catch (err) {
      if (err instanceof StaleVersionError) {
        // Transaction rolled back: no Version created, content unchanged,
        // no note_reverted written.
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
