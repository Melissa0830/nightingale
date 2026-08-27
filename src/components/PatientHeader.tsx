import styles from "./PatientHeader.module.css";

// Mirrors GET /api/patients/:id exactly — id, clinicId, displayName,
// createdAt, nothing else. clinicId is deliberately not rendered (not a
// clinical patient-header fact); DOB/age/gender/allergies/etc. are not in
// this type because the API does not return them.
export interface PatientSummary {
  id: string;
  displayName: string;
  createdAt: string;
}

// Explicit en-GB "27 Aug 2026" — matches the day/month/year convention used
// by Timeline, ContextPanel and VersionHistory. Never relies on the
// browser's default locale (which previously rendered "2026 8").
function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function PatientHeader({ patient }: { patient: PatientSummary }) {
  return (
    <div className={styles.header}>
      <h1 className={styles.name}>{patient.displayName}</h1>
      <div className={styles.metaRow}>
        <span className={styles.id}>Patient ID: {patient.id}</span>
        <span className={styles.meta}>
          Record created {formatCreatedAt(patient.createdAt)}
        </span>
      </div>
    </div>
  );
}
