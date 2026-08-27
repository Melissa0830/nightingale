import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  Role,
  EntryAuthorRole,
  EntryType,
  ProvenanceType,
} from "../src/generated/prisma/client";

// Fixed synthetic IDs so re-running this script upserts the same rows
// instead of creating duplicates. Never mutated outside this fixture set.
const CLINIC_A_ID = "synthetic-clinic-a";
const CLINIC_B_ID = "synthetic-clinic-b";
const PATIENT_A_ID = "synthetic-patient-a";
const PATIENT_B_ID = "synthetic-patient-b";
const USER_PATIENT_A_ID = "synthetic-user-patient-a";
const USER_STAFF_A_ID = "synthetic-user-staff-a";
const USER_CLINICIAN_A_ID = "synthetic-user-clinician-a";
const USER_ADMIN_A_ID = "synthetic-user-admin-a";
const USER_CLINICIAN_B_ID = "synthetic-user-clinician-b";
const ENTRY_PATIENT_SUMMARY_ID = "synthetic-entry-patient-summary";
const ENTRY_STAFF_NOTE_ID = "synthetic-entry-staff-note";
const ENTRY_PLAN_ID = "synthetic-entry-plan";
const ENTRY_MEDICATION_ID = "synthetic-entry-medication";
const ENTRY_AI_DOCTOR_SUMMARY_ID = "synthetic-entry-ai-doctor-summary";
const COMMENT_ROOT_ID = "synthetic-comment-plan-root";
const COMMENT_REPLY_ID = "synthetic-comment-plan-reply";
const HIGHLIGHT_AI_ID = "synthetic-highlight-ai-doctor-summary";
const HIGHLIGHT_PATIENT_ID = "synthetic-highlight-patient-summary";

// ─── Bonus: Feedback-Informed Adaptive Highlight Prioritization ───────────
// A fully isolated demonstration dataset. NOTHING here touches Patient A or
// its clinic-shared aggregates that overlap Patient A's riskReason buckets:
// the learning buckets ("persistent symptoms may require follow-up",
// "medication review advised at next visit") do not match either Patient A
// riskReason, so Patient A's derived adaptive values stay neutral (0).
const PATIENT_LEARNING_ID = "synthetic-patient-learning";
const PATIENT_LEARNING_B_ID = "synthetic-patient-learning-b";
const ENTRY_LEARNING_FOLLOWUP_ID = "synthetic-entry-learning-followup";
const ENTRY_LEARNING_MEDREVIEW_ID = "synthetic-entry-learning-medreview";
const ENTRY_LEARNING_B_FOLLOWUP_ID = "synthetic-entry-learning-b-followup";
// Bucket X (Clinic A) — normalizes to "persistent symptoms may require follow-up".
const HL_LEARN_X_A_ID = "synthetic-highlight-learning-x-a"; // accepted
const HL_LEARN_X_B_ID = "synthetic-highlight-learning-x-b"; // accepted
const HL_LEARN_X_C_ID = "synthetic-highlight-learning-x-c"; // accepted
const HL_LEARN_X_D_ID = "synthetic-highlight-learning-x-d"; // pending — demo target
// Bucket Y (Clinic A, deliberately below threshold) — "medication review advised at next visit".
const HL_LEARN_Y_E_ID = "synthetic-highlight-learning-y-e"; // accepted
const HL_LEARN_Y_F_ID = "synthetic-highlight-learning-y-f"; // accepted
const HL_LEARN_Y_G_ID = "synthetic-highlight-learning-y-g"; // pending — control target
// Bucket X in Clinic B — same normalized riskReason, opposite feedback.
const HL_LEARN_XB_1_ID = "synthetic-highlight-learning-xb-1"; // rejected
const HL_LEARN_XB_2_ID = "synthetic-highlight-learning-xb-2"; // rejected
const HL_LEARN_XB_3_ID = "synthetic-highlight-learning-xb-3"; // rejected
const HL_LEARN_XB_D_ID = "synthetic-highlight-learning-xb-d"; // pending — Clinic B target

// riskReason bucket source strings. Bucket X uses three surface forms that
// all NORMALIZE to the same key (case / trailing period / whitespace), to
// prove normalization is deterministic string folding, not exact-match.
const RISK_REASON_X_CANONICAL = "Persistent symptoms may require follow-up.";
const RISK_REASON_X_LOWER = "persistent symptoms may require follow-up";
const RISK_REASON_X_SPACED = "Persistent  symptoms may  require follow-up.";
const RISK_REASON_Y = "Medication review advised at next visit.";

// The synthetic TimelineEntry IDs whose test-generated Version/AuditEvent
// rows must be cleared before every reseed, so OCC/revision microtests can
// rerun against a clean baseline without hitting @@unique([timelineEntryId, versionNumber]).
const syntheticEntryIds = [
  ENTRY_PATIENT_SUMMARY_ID,
  ENTRY_STAFF_NOTE_ID,
  ENTRY_PLAN_ID,
  ENTRY_MEDICATION_ID,
  ENTRY_AI_DOCTOR_SUMMARY_ID,
  ENTRY_LEARNING_FOLLOWUP_ID,
  ENTRY_LEARNING_MEDREVIEW_ID,
  ENTRY_LEARNING_B_FOLLOWUP_ID,
];

// This script is executed standalone via `node prisma/seed.ts`, not through
// Next.js, so the "@/*" tsconfig path alias used in src/lib/prisma.ts is not
// resolvable here — the generated client is imported by relative path instead.
const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is not set. Aborting seed to avoid connecting to an unintended database."
  );
}

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });

async function main() {
  // ─── Reset test-generated rows for the synthetic fixture only ─────
  // AuditEvent first: it can reference Version via versionId, so it must be
  // cleared before the Version rows it points to.
  await prisma.auditEvent.deleteMany({
    where: { timelineEntryId: { in: syntheticEntryIds } },
  });
  await prisma.version.deleteMany({
    where: { timelineEntryId: { in: syntheticEntryIds } },
  });

  // ─── Clinics ──────────────────────────────────────────────
  const clinicA = await prisma.clinic.upsert({
    where: { id: CLINIC_A_ID },
    create: { id: CLINIC_A_ID, name: "Synthetic Clinic A" },
    update: { name: "Synthetic Clinic A" },
  });
  const clinicB = await prisma.clinic.upsert({
    where: { id: CLINIC_B_ID },
    create: { id: CLINIC_B_ID, name: "Synthetic Clinic B" },
    update: { name: "Synthetic Clinic B" },
  });

  // ─── Patients ─────────────────────────────────────────────
  const patientA = await prisma.patient.upsert({
    where: { id: PATIENT_A_ID },
    create: {
      id: PATIENT_A_ID,
      clinicId: clinicA.id,
      displayName: "Synthetic Patient A",
    },
    update: { clinicId: clinicA.id, displayName: "Synthetic Patient A" },
  });
  const patientB = await prisma.patient.upsert({
    where: { id: PATIENT_B_ID },
    create: {
      id: PATIENT_B_ID,
      clinicId: clinicB.id,
      displayName: "Synthetic Patient B",
    },
    update: { clinicId: clinicB.id, displayName: "Synthetic Patient B" },
  });

  // ─── Users: Clinic A ──────────────────────────────────────
  const patientUserA = await prisma.user.upsert({
    where: { id: USER_PATIENT_A_ID },
    create: {
      id: USER_PATIENT_A_ID,
      clinicId: clinicA.id,
      role: Role.Patient,
      email: "patient.a@clinic-a.test",
      name: "Synthetic Patient User A",
      patientId: patientA.id,
    },
    update: {
      clinicId: clinicA.id,
      role: Role.Patient,
      email: "patient.a@clinic-a.test",
      name: "Synthetic Patient User A",
      patientId: patientA.id,
    },
  });
  const staffUserA = await prisma.user.upsert({
    where: { id: USER_STAFF_A_ID },
    create: {
      id: USER_STAFF_A_ID,
      clinicId: clinicA.id,
      role: Role.Staff,
      email: "staff.a@clinic-a.test",
      name: "Synthetic Staff User A",
    },
    update: {
      clinicId: clinicA.id,
      role: Role.Staff,
      email: "staff.a@clinic-a.test",
      name: "Synthetic Staff User A",
    },
  });
  const clinicianUserA = await prisma.user.upsert({
    where: { id: USER_CLINICIAN_A_ID },
    create: {
      id: USER_CLINICIAN_A_ID,
      clinicId: clinicA.id,
      role: Role.Clinician,
      email: "clinician.a@clinic-a.test",
      name: "Synthetic Clinician User A",
    },
    update: {
      clinicId: clinicA.id,
      role: Role.Clinician,
      email: "clinician.a@clinic-a.test",
      name: "Synthetic Clinician User A",
    },
  });
  const adminUserA = await prisma.user.upsert({
    where: { id: USER_ADMIN_A_ID },
    create: {
      id: USER_ADMIN_A_ID,
      clinicId: clinicA.id,
      role: Role.Admin,
      email: "admin.a@clinic-a.test",
      name: "Synthetic Admin User A",
    },
    update: {
      clinicId: clinicA.id,
      role: Role.Admin,
      email: "admin.a@clinic-a.test",
      name: "Synthetic Admin User A",
    },
  });

  // ─── Users: Clinic B ──────────────────────────────────────
  const clinicianUserB = await prisma.user.upsert({
    where: { id: USER_CLINICIAN_B_ID },
    create: {
      id: USER_CLINICIAN_B_ID,
      clinicId: clinicB.id,
      role: Role.Clinician,
      email: "clinician.b@clinic-b.test",
      name: "Synthetic Clinician User B",
    },
    update: {
      clinicId: clinicB.id,
      role: Role.Clinician,
      email: "clinician.b@clinic-b.test",
      name: "Synthetic Clinician User B",
    },
  });

  // ─── TimelineEntries (all under Patient A) ─────────────────
  // update clauses reset every field explicitly, so re-running this script
  // restores a known baseline even after test suites mutate it.
  const entryPatientSummary = await prisma.timelineEntry.upsert({
    where: { id: ENTRY_PATIENT_SUMMARY_ID },
    create: {
      id: ENTRY_PATIENT_SUMMARY_ID,
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Patient,
      authorId: patientUserA.id,
      type: EntryType.patient_session_summary,
      content:
        "Patient reports mild headache for two days, no fever. Sleep and appetite normal.",
      sectionKey: null,
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
    update: {
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Patient,
      authorId: patientUserA.id,
      type: EntryType.patient_session_summary,
      content:
        "Patient reports mild headache for two days, no fever. Sleep and appetite normal.",
      sectionKey: null,
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
  });

  const entryStaffNote = await prisma.timelineEntry.upsert({
    where: { id: ENTRY_STAFF_NOTE_ID },
    create: {
      id: ENTRY_STAFF_NOTE_ID,
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Staff,
      authorId: staffUserA.id,
      type: EntryType.staff_note,
      content:
        "Checked vitals at 09:00. BP 118/76, HR 72. Patient comfortable, no acute distress.",
      sectionKey: "staff_note",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
    update: {
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Staff,
      authorId: staffUserA.id,
      type: EntryType.staff_note,
      content:
        "Checked vitals at 09:00. BP 118/76, HR 72. Patient comfortable, no acute distress.",
      sectionKey: "staff_note",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
  });

  const entryPlan = await prisma.timelineEntry.upsert({
    where: { id: ENTRY_PLAN_ID },
    create: {
      id: ENTRY_PLAN_ID,
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Clinician,
      authorId: clinicianUserA.id,
      type: EntryType.clinician_note,
      content:
        "Plan: continue current medication, follow-up in 2 weeks, monitor headache frequency.",
      sectionKey: "plan",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
    update: {
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Clinician,
      authorId: clinicianUserA.id,
      type: EntryType.clinician_note,
      content:
        "Plan: continue current medication, follow-up in 2 weeks, monitor headache frequency.",
      sectionKey: "plan",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
  });

  const entryMedication = await prisma.timelineEntry.upsert({
    where: { id: ENTRY_MEDICATION_ID },
    create: {
      id: ENTRY_MEDICATION_ID,
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Clinician,
      authorId: clinicianUserA.id,
      type: EntryType.clinician_note,
      content: "Medication: Paracetamol 500mg PRN for headache, max 3x/day.",
      sectionKey: "medication",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
    update: {
      patientId: patientA.id,
      authorRole: EntryAuthorRole.Clinician,
      authorId: clinicianUserA.id,
      type: EntryType.clinician_note,
      content: "Medication: Paracetamol 500mg PRN for headache, max 3x/day.",
      sectionKey: "medication",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    },
  });

  const entryAiDoctorSummary = await prisma.timelineEntry.upsert({
    where: { id: ENTRY_AI_DOCTOR_SUMMARY_ID },
    create: {
      id: ENTRY_AI_DOCTOR_SUMMARY_ID,
      patientId: patientA.id,
      authorRole: EntryAuthorRole.system,
      authorId: null,
      type: EntryType.ai_doctor_consult_summary,
      content:
        "AI summary: consult discussed persistent headache; recommended follow-up imaging if symptoms persist beyond 2 weeks.",
      sectionKey: "summary",
      provenanceType: ProvenanceType.doctor_consult,
      provenanceId: "synthetic-session-consult-001",
      versionNumber: 1,
    },
    update: {
      patientId: patientA.id,
      authorRole: EntryAuthorRole.system,
      authorId: null,
      type: EntryType.ai_doctor_consult_summary,
      content:
        "AI summary: consult discussed persistent headache; recommended follow-up imaging if symptoms persist beyond 2 weeks.",
      sectionKey: "summary",
      provenanceType: ProvenanceType.doctor_consult,
      provenanceId: "synthetic-session-consult-001",
      versionNumber: 1,
    },
  });

  // ─── Comments (on the "plan" entry) ────────────────────────
  const rootComment = await prisma.comment.upsert({
    where: { id: COMMENT_ROOT_ID },
    create: {
      id: COMMENT_ROOT_ID,
      timelineEntryId: entryPlan.id,
      authorId: clinicianUserA.id,
      content:
        "Discussed follow-up plan with patient by phone; confirmed 2-week review.",
      resolved: false,
      assignedToId: staffUserA.id,
      mentions: [staffUserA.id],
      parentId: null,
    },
    update: {
      timelineEntryId: entryPlan.id,
      authorId: clinicianUserA.id,
      content:
        "Discussed follow-up plan with patient by phone; confirmed 2-week review.",
      resolved: false,
      assignedToId: staffUserA.id,
      mentions: [staffUserA.id],
      parentId: null,
    },
  });

  await prisma.comment.upsert({
    where: { id: COMMENT_REPLY_ID },
    create: {
      id: COMMENT_REPLY_ID,
      timelineEntryId: entryPlan.id,
      authorId: staffUserA.id,
      content: "Follow-up appointment scheduled for two weeks from today.",
      resolved: false,
      assignedToId: null,
      mentions: [],
      parentId: rootComment.id,
    },
    update: {
      timelineEntryId: entryPlan.id,
      authorId: staffUserA.id,
      content: "Follow-up appointment scheduled for two weeks from today.",
      resolved: false,
      assignedToId: null,
      mentions: [],
      parentId: rootComment.id,
    },
  });

  // ─── Highlights (minimal, for provenance + importance tests) ─
  await prisma.highlight.upsert({
    where: { id: HIGHLIGHT_AI_ID },
    create: {
      id: HIGHLIGHT_AI_ID,
      patientId: patientA.id,
      entryId: entryAiDoctorSummary.id,
      quotedText:
        "recommended follow-up imaging if symptoms persist beyond 2 weeks",
      riskReason: "Delayed imaging could miss a worsening condition.",
      importance: 0,
      feedback: "pending",
    },
    update: {
      patientId: patientA.id,
      entryId: entryAiDoctorSummary.id,
      quotedText:
        "recommended follow-up imaging if symptoms persist beyond 2 weeks",
      riskReason: "Delayed imaging could miss a worsening condition.",
      importance: 0,
      feedback: "pending",
    },
  });

  await prisma.highlight.upsert({
    where: { id: HIGHLIGHT_PATIENT_ID },
    create: {
      id: HIGHLIGHT_PATIENT_ID,
      patientId: patientA.id,
      entryId: entryPatientSummary.id,
      quotedText: "mild headache for two days",
      riskReason: "Low-risk symptom; monitor only.",
      importance: 0,
      feedback: "pending",
    },
    update: {
      patientId: patientA.id,
      entryId: entryPatientSummary.id,
      quotedText: "mild headache for two days",
      riskReason: "Low-risk symptom; monitor only.",
      importance: 0,
      feedback: "pending",
    },
  });

  // ─── Bonus: isolated adaptive-prioritization learning fixture ──────────
  // Clinical-looking synthetic patients; NOT attached to Patient A. All
  // learning TimelineEntries are internal `clinician_note` types, so the
  // Patient role never sees them (patient-visible filter is unchanged).
  const patientLearning = await prisma.patient.upsert({
    where: { id: PATIENT_LEARNING_ID },
    create: {
      id: PATIENT_LEARNING_ID,
      clinicId: clinicA.id,
      displayName: "Synthetic Learning Patient",
    },
    update: { clinicId: clinicA.id, displayName: "Synthetic Learning Patient" },
  });
  const patientLearningB = await prisma.patient.upsert({
    where: { id: PATIENT_LEARNING_B_ID },
    create: {
      id: PATIENT_LEARNING_B_ID,
      clinicId: clinicB.id,
      displayName: "Synthetic Learning Patient B",
    },
    update: { clinicId: clinicB.id, displayName: "Synthetic Learning Patient B" },
  });

  const learningEntrySpecs = [
    {
      id: ENTRY_LEARNING_FOLLOWUP_ID,
      patientId: patientLearning.id,
      authorId: clinicianUserA.id,
      sectionKey: "plan",
      content:
        "Longitudinal review across three prior encounters. Persistent cough noted at visit one. Persistent fatigue noted at visit two. Persistent dizziness reported at the most recent visit. Each was flagged for review.",
    },
    {
      id: ENTRY_LEARNING_MEDREVIEW_ID,
      patientId: patientLearning.id,
      authorId: clinicianUserA.id,
      sectionKey: "medication",
      content:
        "Medication list reviewed. Two agents overdue for reassessment. A further agent is due for review at the next scheduled visit.",
    },
    {
      id: ENTRY_LEARNING_B_FOLLOWUP_ID,
      patientId: patientLearningB.id,
      authorId: clinicianUserB.id,
      sectionKey: "plan",
      content:
        "Prior clinicians recommended follow-up for persistent symptoms on three occasions; each resolved without intervention. A further persistent complaint is pending review.",
    },
  ];
  for (const spec of learningEntrySpecs) {
    const shared = {
      patientId: spec.patientId,
      authorRole: EntryAuthorRole.Clinician,
      authorId: spec.authorId,
      type: EntryType.clinician_note,
      content: spec.content,
      sectionKey: spec.sectionKey,
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      versionNumber: 1,
    };
    await prisma.timelineEntry.upsert({
      where: { id: spec.id },
      create: { id: spec.id, ...shared },
      update: shared,
    });
  }

  const learningHighlightSpecs = [
    // Bucket X — Clinic A — three accepted, one pending target. base importance 0.
    { id: HL_LEARN_X_A_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_FOLLOWUP_ID, quotedText: "Persistent cough noted at visit one", riskReason: RISK_REASON_X_CANONICAL, feedback: "accepted" as const },
    { id: HL_LEARN_X_B_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_FOLLOWUP_ID, quotedText: "Persistent fatigue noted at visit two", riskReason: RISK_REASON_X_LOWER, feedback: "accepted" as const },
    { id: HL_LEARN_X_C_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_FOLLOWUP_ID, quotedText: "Persistent dizziness reported at the most recent visit", riskReason: RISK_REASON_X_SPACED, feedback: "accepted" as const },
    { id: HL_LEARN_X_D_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_FOLLOWUP_ID, quotedText: "Each was flagged for review", riskReason: RISK_REASON_X_CANONICAL, feedback: "pending" as const },
    // Bucket Y — Clinic A — two accepted (below threshold), one pending control.
    { id: HL_LEARN_Y_E_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_MEDREVIEW_ID, quotedText: "Two agents overdue for reassessment", riskReason: RISK_REASON_Y, feedback: "accepted" as const },
    { id: HL_LEARN_Y_F_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_MEDREVIEW_ID, quotedText: "agent is due for review", riskReason: RISK_REASON_Y, feedback: "accepted" as const },
    { id: HL_LEARN_Y_G_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_MEDREVIEW_ID, quotedText: "Medication list reviewed", riskReason: RISK_REASON_Y, feedback: "pending" as const },
    // Bucket X — Clinic B — three rejected, one pending target. Same normalized
    // riskReason as Clinic A bucket X; must never influence Clinic A.
    { id: HL_LEARN_XB_1_ID, patientId: patientLearningB.id, entryId: ENTRY_LEARNING_B_FOLLOWUP_ID, quotedText: "recommended follow-up for persistent symptoms", riskReason: RISK_REASON_X_CANONICAL, feedback: "rejected" as const },
    { id: HL_LEARN_XB_2_ID, patientId: patientLearningB.id, entryId: ENTRY_LEARNING_B_FOLLOWUP_ID, quotedText: "each resolved without intervention", riskReason: RISK_REASON_X_LOWER, feedback: "rejected" as const },
    { id: HL_LEARN_XB_3_ID, patientId: patientLearningB.id, entryId: ENTRY_LEARNING_B_FOLLOWUP_ID, quotedText: "on three occasions", riskReason: RISK_REASON_X_SPACED, feedback: "rejected" as const },
    { id: HL_LEARN_XB_D_ID, patientId: patientLearningB.id, entryId: ENTRY_LEARNING_B_FOLLOWUP_ID, quotedText: "A further persistent complaint is pending review", riskReason: RISK_REASON_X_CANONICAL, feedback: "pending" as const },
  ];
  for (const spec of learningHighlightSpecs) {
    const shared = {
      patientId: spec.patientId,
      entryId: spec.entryId,
      quotedText: spec.quotedText,
      riskReason: spec.riskReason,
      importance: 0,
      feedback: spec.feedback,
    };
    await prisma.highlight.upsert({
      where: { id: spec.id },
      create: { id: spec.id, ...shared },
      update: shared,
    });
  }

  console.log("Synthetic seed complete (idempotent upsert, baseline reset).");
  console.log({
    clinics: [clinicA.id, clinicB.id],
    patients: [patientA.id, patientB.id, patientLearning.id, patientLearningB.id],
    users: [
      patientUserA.id,
      staffUserA.id,
      clinicianUserA.id,
      adminUserA.id,
      clinicianUserB.id,
    ],
    entries: [
      entryPatientSummary.id,
      entryStaffNote.id,
      entryPlan.id,
      entryMedication.id,
      entryAiDoctorSummary.id,
    ],
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
