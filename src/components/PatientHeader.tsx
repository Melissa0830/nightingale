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

function formatCreatedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
    });
  } catch {
    return iso;
  }
}

export default function PatientHeader({ patient }: { patient: PatientSummary }) {
  return (
    <div className={styles.header}>
      <h1 className={styles.name}>{patient.displayName}</h1>
      <p className={styles.id}>Patient ID: {patient.id}</p>
      <p className={styles.meta}>Record created: {formatCreatedAt(patient.createdAt)}</p>
    </div>
  );
}
