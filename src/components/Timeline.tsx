"use client";

import { useEffect, useState } from "react";
import { useAuthIdentity } from "./AppShell";
import { getToken } from "@/lib/auth-client";
import styles from "./Timeline.module.css";

// Mirrors GET /api/patients/:id/timeline exactly (re-confirmed against
// the current route this block): a plain array, no wrapper object, no
// authorId, no display name anywhere on this route.
interface TimelineEntry {
  id: string;
  patientId: string;
  type: string;
  content: string;
  sectionKey: string | null;
  authorRole: string;
  versionNumber: number;
  provenanceType: string;
  provenanceId: string | null;
  createdAt: string;
  updatedAt: string;
}

type Status = "loading" | "ok" | "error";
type Classification = "Clinician" | "Staff" | "AI Scribe" | "Patient" | "System";

// type first, authorRole second — an AI-scribed entry and a system_event
// can both carry authorRole=system, so authorRole alone cannot classify
// them. Never labels an AI Scribe row as System.
function classify(entry: TimelineEntry): Classification {
  if (entry.type === "system_event") return "System";
  if (entry.type.startsWith("ai_")) return "AI Scribe";
  if (entry.authorRole === "Clinician") return "Clinician";
  if (entry.authorRole === "Staff") return "Staff";
  if (entry.authorRole === "Patient") return "Patient";
  return "System";
}

const AI_TYPE_LABELS: Record<string, string> = {
  ai_doctor_consult_summary: "AI Scribe · Doctor Consult",
  ai_nurse_consult_summary: "AI Scribe · Nurse Consult",
  ai_patient_session_summary: "AI Scribe · Patient Session",
};

function sectionLabel(sectionKey: string | null): string | null {
  if (!sectionKey) return null;
  const readable = sectionKey.replace(/_/g, " ");
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`;
}

function badgeLabel(entry: TimelineEntry, classification: Classification): string {
  if (classification === "AI Scribe") {
    return AI_TYPE_LABELS[entry.type] ?? "AI Scribe";
  }
  const section = sectionLabel(entry.sectionKey);
  return section ? `${classification} · ${section}` : classification;
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function Timeline({ patientId }: { patientId: string }) {
  const identity = useAuthIdentity();
  const isPatient = identity.role === "Patient";
  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "error"));
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetch(`/api/patients/${patientId}/timeline`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as TimelineEntry[];
        setEntries(json);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const heading = isPatient ? "Your Timeline" : "Longitudinal Timeline";

  if (status === "loading") {
    return (
      <section className={styles.timeline}>
        <h2 className={styles.title}>{heading}</h2>
        <p className={styles.state} role="status">
          Loading timeline…
        </p>
      </section>
    );
  }
  if (status === "error") {
    return (
      <section className={styles.timeline}>
        <h2 className={styles.title}>{heading}</h2>
        <p className={styles.state}>Unable to load timeline.</p>
      </section>
    );
  }
  if (entries.length === 0) {
    return (
      <section className={styles.timeline}>
        <h2 className={styles.title}>{heading}</h2>
        <p className={styles.state}>
          {isPatient ? "No patient-visible timeline entries yet." : "No timeline entries yet."}
        </p>
      </section>
    );
  }

  // API returns createdAt ascending; reversed here for display only
  // (newest-first, day-grouped) — a presentational reorder, not a
  // filtering change.
  const sorted = [...entries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  const groups: { label: string; items: TimelineEntry[] }[] = [];
  for (const entry of sorted) {
    const label = dayLabel(entry.createdAt);
    const group = groups[groups.length - 1];
    if (group && group.label === label) {
      group.items.push(entry);
    } else {
      groups.push({ label, items: [entry] });
    }
  }

  return (
    <section className={styles.timeline}>
      <h2 className={styles.title}>{heading}</h2>
      {groups.map((group) => (
        <div key={group.label} className={styles.dayGroup}>
          <h3 className={styles.dayHeading}>{group.label}</h3>
          <ul className={styles.rows}>
            {group.items.map((entry) => {
              const classification = classify(entry);
              const selected = selectedEntryId === entry.id;
              // Patient rows stay limited to type/time/content — no
              // versionNumber or provenance metadata, even though the
              // server already restricts which entries a Patient sees.
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className={`${styles.row} ${styles[`row_${classification.replace(/\s/g, "")}`]} ${
                      selected ? styles.rowSelected : ""
                    }`}
                    aria-pressed={selected}
                    onClick={() => setSelectedEntryId(selected ? null : entry.id)}
                  >
                    <span className={styles.time}>{timeLabel(entry.createdAt)}</span>
                    <span className={styles.rowBody}>
                      <span className={styles.badge}>{badgeLabel(entry, classification)}</span>
                      <span className={styles.content}>{entry.content}</span>
                      {!isPatient && (
                        <span className={styles.meta}>
                          v{entry.versionNumber}
                          {classification === "AI Scribe" && entry.provenanceType !== "none"
                            ? ` · Source: ${entry.provenanceType}`
                            : ""}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}
