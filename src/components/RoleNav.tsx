"use client";

import Link from "next/link";
import { useAuthIdentity } from "./AppShell";
import styles from "./RoleNav.module.css";

// Staff/Clinician/Admin get the demo patient selector; Patient goes
// directly to their own record (no browseable directory is offered to
// Patient — see src/app/patients/page.tsx for the server-enforced reason).
export default function RoleNav() {
  const identity = useAuthIdentity();
  const isPatient = identity.role === "Patient";
  const href = isPatient && identity.patientId ? `/patients/${identity.patientId}` : "/patients";
  const label = isPatient ? "My Care" : "Patients";

  return (
    <nav className={styles.nav} aria-label="Primary">
      <Link href={href} className={styles.item}>
        {label}
      </Link>
    </nav>
  );
}
