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
const ENTRY_LEARNING_RISKFLAG_ID = "synthetic-entry-learning-riskflag";
const ENTRY_LEARNING_B_FOLLOWUP_ID = "synthetic-entry-learning-b-followup";
// Block 8: promote synthetic-patient-learning into a complete case. These
// entries carry NO Highlights (deliberate — zero lexical-bucket and zero
// critical-trigger collision surface). Independent "intermittent fatigue"
// clinical story; not a copy of Patient A content.
const ENTRY_LEARNING_PATIENT_SUMMARY_ID = "synthetic-entry-learning-patient-summary";
const ENTRY_LEARNING_STAFF_NOTE_ID = "synthetic-entry-learning-staff-note";
const ENTRY_LEARNING_PLAN_ID = "synthetic-entry-learning-plan";
const ENTRY_LEARNING_AI_DOCTOR_ID = "synthetic-entry-learning-ai-doctor";
const ENTRY_LEARNING_AI_NURSE_ID = "synthetic-entry-learning-ai-nurse";
const ENTRY_LEARNING_AI_PATIENT_ID = "synthetic-entry-learning-ai-patient";
const SESSION_LEARNING_DOCTOR = "synthetic-session-learning-consult-001";
const SESSION_LEARNING_NURSE = "synthetic-session-learning-nurse-001";
const SESSION_LEARNING_PATIENT = "synthetic-session-learning-session-001";
// Bucket X (Clinic A) — normalizes to "persistent symptoms may require follow-up".
const HL_LEARN_X_A_ID = "synthetic-highlight-learning-x-a"; // accepted
const HL_LEARN_X_B_ID = "synthetic-highlight-learning-x-b"; // accepted
const HL_LEARN_X_C_ID = "synthetic-highlight-learning-x-c"; // accepted
const HL_LEARN_X_D_ID = "synthetic-highlight-learning-x-d"; // pending — POSITIVE demo target (+2)
const HL_LEARN_X_LEX_ID = "synthetic-highlight-learning-x-lex"; // pending — LEXICAL match demo (non-identical wording -> bucket X)
// Bucket Y (Clinic A, deliberately below threshold) — "medication review advised at next visit".
const HL_LEARN_Y_E_ID = "synthetic-highlight-learning-y-e"; // accepted
const HL_LEARN_Y_F_ID = "synthetic-highlight-learning-y-f"; // accepted
const HL_LEARN_Y_G_ID = "synthetic-highlight-learning-y-g"; // pending — GATHERING demo target (0)
// Deterministic critical riskFloor, no recurring pattern, adjustment 0 — proves
// a critical Highlight sorts before every unrated one regardless of adaptive score.
const HL_LEARN_CRITICAL_ID = "synthetic-highlight-learning-critical";
// Bucket Z (Clinic A) — "imaging finding likely incidental; no action needed". 3 rejected.
const HL_LEARN_Z_1_ID = "synthetic-highlight-learning-z-1"; // rejected
const HL_LEARN_Z_2_ID = "synthetic-highlight-learning-z-2"; // rejected
const HL_LEARN_Z_3_ID = "synthetic-highlight-learning-z-3"; // rejected
const HL_LEARN_Z_D_ID = "synthetic-highlight-learning-z-d"; // pending — NEGATIVE demo target (-2)
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
const RISK_REASON_Z_CANONICAL = "Imaging finding likely incidental; no action needed.";
const RISK_REASON_Z_LOWER = "imaging finding likely incidental no action needed";
const RISK_REASON_Z_SPACED = "Imaging  finding likely  incidental; no action needed.";

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
  ENTRY_LEARNING_RISKFLAG_ID,
  ENTRY_LEARNING_B_FOLLOWUP_ID,
  ENTRY_LEARNING_PATIENT_SUMMARY_ID,
  ENTRY_LEARNING_STAFF_NOTE_ID,
  ENTRY_LEARNING_PLAN_ID,
  ENTRY_LEARNING_AI_DOCTOR_ID,
  ENTRY_LEARNING_AI_NURSE_ID,
  ENTRY_LEARNING_AI_PATIENT_ID,
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

  // Scenario C longitudinal span — INTERMEDIATE period (Feb 2026).
  // These three entries are a mid-course review of prior encounters, so
  // they sit between the 2025 initial presentation and the Aug 2026
  // current consult. Only createdAt is set here; content is unchanged
  // because every one of these entries has linked adaptive Highlights and
  // Highlight provenance is anchored by exact quotedText substring match.
  const learningEntrySpecs = [
    {
      id: ENTRY_LEARNING_FOLLOWUP_ID,
      patientId: patientLearning.id,
      authorId: clinicianUserA.id,
      sectionKey: "plan",
      createdAt: new Date("2026-02-06T10:00:00.000Z"),
      content:
        "Longitudinal review across three prior encounters. Persistent cough noted at visit one. Persistent fatigue noted at visit two. Persistent dizziness reported at the most recent visit. Each was flagged for review.",
    },
    {
      id: ENTRY_LEARNING_MEDREVIEW_ID,
      patientId: patientLearning.id,
      authorId: clinicianUserA.id,
      sectionKey: "medication",
      createdAt: new Date("2026-02-06T10:15:00.000Z"),
      content:
        "Medication list reviewed. Two agents overdue for reassessment. A further agent is due for review at the next scheduled visit.",
    },
    {
      id: ENTRY_LEARNING_RISKFLAG_ID,
      patientId: patientLearning.id,
      authorId: clinicianUserA.id,
      sectionKey: "summary",
      createdAt: new Date("2026-02-06T10:30:00.000Z"),
      content:
        "Incidental imaging findings reviewed across prior scans. Small nodule noted, stable. Minor calcification, unchanged. Trace effusion, resolving. Each judged likely incidental with no action needed.",
    },
    {
      id: ENTRY_LEARNING_B_FOLLOWUP_ID,
      patientId: patientLearningB.id,
      authorId: clinicianUserB.id,
      sectionKey: "plan",
      // Clinic B isolation control — not part of Scenario C's narrative,
      // but pinned to a fixed date so the whole fixture is deterministic.
      createdAt: new Date("2026-02-06T10:00:00.000Z"),
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
      // Explicit, timezone-safe ISO instant. Set in both create and update
      // so the historical date survives repeated idempotent reseeds.
      createdAt: spec.createdAt,
    };
    await prisma.timelineEntry.upsert({
      where: { id: spec.id },
      create: { id: spec.id, ...shared },
      update: shared,
    });
  }

  // ─── Block 8: complete-case Core entries for the Learning Patient ──────
  // Independent "intermittent fatigue" story. Deliberately low-risk wording
  // (verified: classifyRiskFloor -> unrated for every string). No Highlights
  // on any of these — zero lexical-bucket and zero critical-trigger surface.
  // AI Scribe summaries are pre-written clean synthetic text (no PHI); the
  // redactPHI gateway is exercised at runtime by test_ai_scribe_ingestion.py.
  // Scenario C longitudinal span — HISTORICAL period (Apr 2025) and
  // RECENT period (Aug 2026). None of these six entries has a linked
  // Highlight, so createdAt is the only field being pinned here.
  //   2025-04-15  initial presentation: patient-reported fatigue + vitals
  //   2026-08-27  current consult, in clinical order:
  //               patient check-in -> nurse follow-up -> doctor consult -> plan
  const learningCoreEntrySpecs = [
    {
      id: ENTRY_LEARNING_PATIENT_SUMMARY_ID,
      authorRole: EntryAuthorRole.Patient,
      authorId: null as string | null,
      type: EntryType.patient_session_summary,
      sectionKey: null as string | null,
      provenanceType: ProvenanceType.none,
      provenanceId: null as string | null,
      createdAt: new Date("2025-04-15T09:00:00.000Z"),
      content:
        "Patient reports intermittent fatigue during daily activities over the past few weeks. Symptoms are stable today with no new concerns, and a routine follow-up is planned.",
    },
    {
      id: ENTRY_LEARNING_STAFF_NOTE_ID,
      authorRole: EntryAuthorRole.Staff,
      authorId: staffUserA.id,
      type: EntryType.staff_note,
      sectionKey: "staff_note",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      createdAt: new Date("2025-04-15T09:30:00.000Z"),
      content:
        "Vitals reviewed and within normal range. Patient comfortable at rest and ambulating without difficulty. Follow-up instructions confirmed and understood.",
    },
    {
      id: ENTRY_LEARNING_PLAN_ID,
      authorRole: EntryAuthorRole.Clinician,
      authorId: clinicianUserA.id,
      type: EntryType.clinician_note,
      sectionKey: "plan",
      provenanceType: ProvenanceType.none,
      provenanceId: null,
      createdAt: new Date("2026-08-27T10:00:00.000Z"),
      content:
        "Continue symptom monitoring and lifestyle measures. Review energy levels and sleep pattern at the scheduled follow-up appointment in four weeks.",
    },
    {
      id: ENTRY_LEARNING_AI_DOCTOR_ID,
      authorRole: EntryAuthorRole.system,
      authorId: null,
      type: EntryType.ai_doctor_consult_summary,
      sectionKey: "summary",
      provenanceType: ProvenanceType.doctor_consult,
      provenanceId: SESSION_LEARNING_DOCTOR,
      createdAt: new Date("2026-08-27T09:30:00.000Z"),
      content:
        "AI Scribe Summary (doctor_consult): post-consult review of intermittent fatigue; most likely related to a recent change in sleep pattern. Advised sleep hygiene measures and follow-up in four weeks.",
    },
    {
      id: ENTRY_LEARNING_AI_NURSE_ID,
      authorRole: EntryAuthorRole.system,
      authorId: null,
      type: EntryType.ai_nurse_consult_summary,
      sectionKey: "summary",
      provenanceType: ProvenanceType.nurse_consult,
      provenanceId: SESSION_LEARNING_NURSE,
      createdAt: new Date("2026-08-27T09:00:00.000Z"),
      content:
        "AI Scribe Summary (nurse_consult): nurse follow-up covering activity pacing, hydration, and rest planning. Patient understands the plan and will track daily energy levels before the next visit.",
    },
    {
      id: ENTRY_LEARNING_AI_PATIENT_ID,
      authorRole: EntryAuthorRole.system,
      authorId: null,
      type: EntryType.ai_patient_session_summary,
      sectionKey: "summary",
      provenanceType: ProvenanceType.patient_session,
      provenanceId: SESSION_LEARNING_PATIENT,
      createdAt: new Date("2026-08-27T08:30:00.000Z"),
      content:
        "AI Scribe Summary (patient_session): pre-visit check-in. Patient describes stable fatigue, no new symptoms, and confirms the upcoming appointment and current supportive measures.",
    },
  ];
  for (const spec of learningCoreEntrySpecs) {
    const shared = {
      patientId: patientLearning.id,
      authorRole: spec.authorRole,
      authorId: spec.authorId,
      type: spec.type,
      content: spec.content,
      sectionKey: spec.sectionKey,
      provenanceType: spec.provenanceType,
      provenanceId: spec.provenanceId,
      versionNumber: 1,
      // Explicit, timezone-safe ISO instant. Set in both create and update
      // so the historical date survives repeated idempotent reseeds.
      createdAt: spec.createdAt,
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
    // Non-identical wording ("respiratory" inserted) -> no exact bucket, but a
    // deterministic lexical match to bucket X (jaccard 5/6 ≈ 0.83).
    { id: HL_LEARN_X_LEX_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_FOLLOWUP_ID, quotedText: "Persistent dizziness reported at the most recent visit", riskReason: "Persistent respiratory symptoms may require follow-up.", feedback: "pending" as const },
    // Bucket Y — Clinic A — two accepted (below threshold), one pending control.
    { id: HL_LEARN_Y_E_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_MEDREVIEW_ID, quotedText: "Two agents overdue for reassessment", riskReason: RISK_REASON_Y, feedback: "accepted" as const },
    { id: HL_LEARN_Y_F_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_MEDREVIEW_ID, quotedText: "agent is due for review", riskReason: RISK_REASON_Y, feedback: "accepted" as const },
    { id: HL_LEARN_Y_G_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_MEDREVIEW_ID, quotedText: "Medication list reviewed", riskReason: RISK_REASON_Y, feedback: "pending" as const },
    // Bucket Z — Clinic A — three rejected, one pending target (NEGATIVE demo, -2).
    { id: HL_LEARN_Z_1_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_RISKFLAG_ID, quotedText: "Small nodule noted, stable", riskReason: RISK_REASON_Z_CANONICAL, feedback: "rejected" as const },
    { id: HL_LEARN_Z_2_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_RISKFLAG_ID, quotedText: "Minor calcification, unchanged", riskReason: RISK_REASON_Z_LOWER, feedback: "rejected" as const },
    { id: HL_LEARN_Z_3_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_RISKFLAG_ID, quotedText: "Trace effusion, resolving", riskReason: RISK_REASON_Z_SPACED, feedback: "rejected" as const },
    { id: HL_LEARN_Z_D_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_RISKFLAG_ID, quotedText: "Each judged likely incidental with no action needed", riskReason: RISK_REASON_Z_CANONICAL, feedback: "pending" as const },
    // Deterministic critical floor ("chest pain"), no recurring pattern -> adj 0.
    // Must still sort ahead of the +2 unrated bucket-X highlights.
    { id: HL_LEARN_CRITICAL_ID, patientId: patientLearning.id, entryId: ENTRY_LEARNING_RISKFLAG_ID, quotedText: "Chest pain on exertion noted this visit", riskReason: "Chest pain reported; escalate per protocol.", feedback: "pending" as const },
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
