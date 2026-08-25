import type { Role } from "@/generated/prisma/client";
import { ApiError } from "@/lib/errors";

type SectionOwnerRole = "Staff" | "Clinician";

/**
 * Canonical sectionKey → owning role mapping.
 *
 * Source of each decision:
 *   staff_note  → Staff     : explicit in brief RBAC table.
 *   plan        → Clinician : Nightingale prototype implementation decision.
 *   summary     → Clinician : Nightingale prototype implementation decision.
 *   medication  → Clinician : Nightingale prototype implementation decision.
 *
 * "plan", "summary", "medication" are NOT explicitly assigned in the brief.
 * They are assigned to Clinician here as the minimum reasonable default for
 * a clinical note system. This decision should be revisited if brief changes.
 *
 * Ownership is always determined by this mapping.
 * TimelineEntry.authorRole MUST NOT be used to infer section ownership.
 *
 * Fail-closed: unknown or null sectionKey → deny edit.
 */
const SECTION_OWNERSHIP: Readonly<Record<string, SectionOwnerRole>> = {
  staff_note: "Staff",
  plan: "Clinician",
  summary: "Clinician",
  medication: "Clinician",
};

/**
 * Returns true if the given role is the owner of the given section.
 * Unknown, null, or undefined sectionKey → false (fail closed).
 */
export function canEditSection(
  role: Role,
  sectionKey: string | null | undefined,
): boolean {
  if (!sectionKey) return false;
  const owner = SECTION_OWNERSHIP[sectionKey];
  if (!owner) return false;
  return role === owner;
}

/**
 * Throws ApiError 403 if the user's role cannot edit the given section.
 * Admin is not exempt — Admin is read-only for clinical sections.
 * Patient is not exempt — Patient cannot edit any section.
 */
export function assertSectionOwnership(
  role: Role,
  sectionKey: string | null | undefined,
): void {
  if (!canEditSection(role, sectionKey)) {
    throw new ApiError(
      403,
      `Role '${role}' cannot edit section '${sectionKey ?? "(none)"}'`,
    );
  }
}
