"use client";

import { useEffect, useState } from "react";
import { useAuthIdentity } from "./AppShell";
import { getToken } from "@/lib/auth-client";
import styles from "./Timeline.module.css";

// Stable per-row DOM id so a provenance "Jump to source" can scroll the
// exact source entry into view — works for any row, in any Scenario C date
// group (groups are always rendered, never collapsed).
function rowDomId(entryId: string): string {
  return `timeline-row-${entryId}`;
}

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

interface TimelineProps {
  patientId: string;
  selectedEntryId: string | null;
  onSelectEntry: (id: string | null) => void;
  // Bumped by PatientDetailContent after a successful edit/revert in the
  // ContextPanel so this self-fetching list refetches. Optional: the Patient
  // view never mutates, so it omits this.
  refreshSignal?: number;
  // Bumped by PatientDetailContent when a provenance "Jump to source" action
  // asks for the currently-selected row to be scrolled into view. Separate
  // from selectedEntryId so re-jumping to the same entry still scrolls.
  revealSignal?: number;
}

export default function Timeline({
  patientId,
  selectedEntryId,
  onSelectEntry,
  refreshSignal,
  revealSignal,
}: TimelineProps) {
  const identity = useAuthIdentity();
  const isPatient = identity.role === "Patient";
  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "error"));
  const [entries, setEntries] = useState<TimelineEntry[]>([]);

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
  }, [patientId, refreshSignal]);

  // Provenance "Jump to source": scroll the selected row into view when the
  // reveal signal bumps. Read-only, purely presentational — no fetch, no
  // state change. `block: "nearest"` keeps the scroll minimal; the row is
  // reachable in any date group because groups are never collapsed.
  useEffect(() => {
    if (revealSignal === undefined || revealSignal === 0 || !selectedEntryId) return;
    if (status !== "ok") return;
    if (typeof document === "undefined") return;
    const el = document.getElementById(rowDomId(selectedEntryId));
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [revealSignal, selectedEntryId, status]);

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

  // The API already returns newest-first with an `id` ASC tie-break. This
  // re-sort applies the exact same rule defensively (so a day-group never
  // renders out of order if the payload arrives unsorted) — it is not a
  // reverse() and cannot flip the API's direction. Chronology has one
  // effective rule: createdAt DESC, then id ASC.
  const sorted = [...entries].sort((a, b) => {
    const byTime = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

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
                <li key={entry.id} id={rowDomId(entry.id)}>
                  <button
                    type="button"
                    className={`${styles.row} ${styles[`row_${classification.replace(/\s/g, "")}`]} ${
                      selected ? styles.rowSelected : ""
                    }`}
                    aria-pressed={selected}
                    onClick={() => onSelectEntry(selected ? null : entry.id)}
                  >
                    <span className={styles.time}>{timeLabel(entry.createdAt)}</span>
                    <span className={styles.dot} aria-hidden="true" />
                    <span className={styles.rowBody}>
                      <span className={styles.badgeRow}>
                        <span className={styles.badge}>
                          {badgeLabel(entry, classification)}
                        </span>
                        {!isPatient && (
                          <span className={styles.version}>v{entry.versionNumber}</span>
                        )}
                      </span>
                      <span className={styles.content}>{entry.content}</span>
                      {!isPatient &&
                        classification === "AI Scribe" &&
                        entry.provenanceType !== "none" && (
                          <span className={styles.meta}>Source: {entry.provenanceType}</span>
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
