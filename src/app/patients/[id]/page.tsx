"use client";

import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell, { useAuthIdentity } from "@/components/AppShell";
import PatientHeader, { type PatientSummary } from "@/components/PatientHeader";
import Glance from "@/components/Glance";
import Timeline from "@/components/Timeline";
import { getToken, clearToken } from "@/lib/auth-client";
import styles from "./patient-detail.module.css";

type Status = "loading" | "ok" | "notfound" | "forbidden" | "error";

export default function PatientDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AppShell>
      <PatientDetailContent patientId={id} />
    </AppShell>
  );
}

// GET /api/patients/:id is called directly here (not pre-wired to
// Glance/Timeline — those start in later blocks). 401/403/404 are
// rendered as distinct states, never silently collapsed or converted
// into fake patient content.
function PatientDetailContent({ patientId }: { patientId: string }) {
  const router = useRouter();
  const identity = useAuthIdentity();
  const [status, setStatus] = useState<Status>("loading");
  const [patient, setPatient] = useState<PatientSummary | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      router.replace("/login");
      return;
    }
    let cancelled = false;
    fetch(`/api/patients/${patientId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          clearToken();
          router.replace("/login");
          return;
        }
        if (res.status === 404) {
          setStatus("notfound");
          return;
        }
        if (res.status === 403) {
          setStatus("forbidden");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const data = (await res.json()) as PatientSummary;
        setPatient(data);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [patientId, router]);

  if (status === "loading") {
    return (
      <p className={styles.state} role="status">
        Loading patient…
      </p>
    );
  }
  if (status === "notfound") {
    return <p className={styles.state}>Patient record not found.</p>;
  }
  if (status === "forbidden") {
    return <p className={styles.state}>You do not have access to this patient record.</p>;
  }
  if (status === "error" || !patient) {
    return <p className={styles.state}>Something went wrong loading this patient.</p>;
  }

  // Glance is fetched only for non-Patient roles. Patient never sees it —
  // matching the server's own 403 for that role on this route (see
  // src/app/api/patients/[id]/glance/route.ts) — so no fetch is even
  // attempted here rather than fetching and hiding the result. Timeline
  // is the same component for every role — it reads identity internally
  // and presents itself accordingly (heading, empty-state wording, and
  // omitting versionNumber/provenance metadata for Patient rows).
  return (
    <div>
      <PatientHeader patient={patient} />
      {identity.role !== "Patient" && <Glance patientId={patientId} />}
      <Timeline patientId={patientId} />
    </div>
  );
}
