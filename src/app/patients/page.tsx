"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AppShell, { useAuthIdentity } from "@/components/AppShell";
import styles from "./patients.module.css";

// No GET /api/patients (list) endpoint exists — confirmed by inspection,
// and none is being added here (Fixed Decision A). This is a demo-only
// navigation shim over the known seeded fixture IDs from prisma/seed.ts,
// not a real patient directory. The server (GET /api/patients/:id) remains
// the actual access-control boundary regardless of what this list shows.
const DEMO_PATIENTS: {
  id: string;
  clinicId: string;
  label: string;
  tag?: string;
}[] = [
  { id: "synthetic-patient-a", clinicId: "synthetic-clinic-a", label: "Synthetic Patient A" },
  { id: "synthetic-patient-b", clinicId: "synthetic-clinic-b", label: "Synthetic Patient B" },
  {
    id: "synthetic-patient-learning",
    clinicId: "synthetic-clinic-a",
    label: "Synthetic Learning Patient",
    tag: "Adaptive prioritization demo",
  },
];

export default function PatientsPage() {
  return (
    <AppShell>
      <PatientsSelector />
    </AppShell>
  );
}

function PatientsSelector() {
  const identity = useAuthIdentity();
  const router = useRouter();

  useEffect(() => {
    // Patient role must not see a browseable directory — send them straight
    // to their own record. Convenience redirect only; GET /api/patients/:id
    // would reject a Patient requesting anyone else's id regardless.
    if (identity.role === "Patient" && identity.patientId) {
      router.replace(`/patients/${identity.patientId}`);
    }
  }, [identity, router]);

  if (identity.role === "Patient") {
    return null;
  }

  // Clinic filtering here is convenience only — it reduces confusing
  // dead-end navigation to a demo patient the user's clinic can't access.
  // It is not a security boundary; the server enforces that independently.
  const visible = DEMO_PATIENTS.filter((p) => p.clinicId === identity.clinicId);

  return (
    <div>
      <h1 className={styles.title}>Patients</h1>
      <p className={styles.disclaimer}>
        Demo records for this prototype — not a production patient directory.
      </p>
      {visible.length === 0 ? (
        <p className={styles.empty}>No demo patients available for your clinic.</p>
      ) : (
        <ul className={styles.list}>
          {visible.map((p) => (
            <li key={p.id} className={styles.item}>
              <div>
                <p className={styles.name}>{p.label}</p>
                <p className={styles.tag}>{p.tag ?? "Demo record"}</p>
              </div>
              <Link href={`/patients/${p.id}`} className={styles.open}>
                Open patient
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
