"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth-client";
import styles from "./ContextPanel.module.css";

// Mirrors GET /api/timeline/:id exactly (re-confirmed against the
// current route this block) — no authorId, no display/author name.
interface EntryDetail {
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

// Mirrors GET /api/patients/:id/highlights exactly (re-confirmed this
// block) — no riskFloor anywhere on this route; quotedTextFound/
// occurrenceCount are server-computed and used verbatim, never
// recomputed here.
interface Highlight {
  id: string;
  patientId: string;
  entryId: string;
  quotedText: string;
  riskReason: string;
  importance: number;
  feedback: string;
  createdAt: string;
  quotedTextFound: boolean;
  occurrenceCount: number;
  entryContent: string;
  entryProvenanceType: string;
  entryProvenanceId: string | null;
}

type EntryStatus = "loading" | "ok" | "forbidden" | "notfound" | "error";
type HighlightsStatus = "loading" | "ok" | "error";
type Classification = "Clinician" | "Staff" | "AI Scribe" | "Patient" | "System";

// Duplicated from Timeline.tsx deliberately — small, purely
// presentational helpers, not worth a shared module for ~10 lines each.
function classify(entry: EntryDetail): Classification {
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

const PROVENANCE_LABELS: Record<string, string> = {
  doctor_consult: "Doctor consult",
  nurse_consult: "Nurse consult",
  patient_session: "Patient session",
};

function sectionLabel(sectionKey: string | null): string | null {
  if (!sectionKey) return null;
  const readable = sectionKey.replace(/_/g, " ");
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`;
}

function typeLabel(entry: EntryDetail, classification: Classification): string {
  if (classification === "AI Scribe") {
    return AI_TYPE_LABELS[entry.type] ?? "AI Scribe";
  }
  const section = sectionLabel(entry.sectionKey);
  return section ? `${classification} · ${section}` : classification;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Same en-GB/24h convention as Timeline.tsx's formatters, applied fresh
// here (Timeline's own formatter is not touched again this block).
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

function exactQuoteStatus(h: Highlight): string {
  if (!h.quotedTextFound) return "Exact quote not found in current entry";
  if (h.occurrenceCount > 1) return `Exact quote found · ${h.occurrenceCount} occurrences`;
  return "Exact quote found";
}

// Top-level component only decides idle-vs-selected. The actual fetching
// component below is keyed by entryId, so selecting a different entry
// (or deselecting then reselecting) always mounts a fresh instance with
// its own fresh initial state — no manual "reset to idle" branch is
// needed inside an effect for that transition.
export default function ContextPanel({
  patientId,
  entryId,
}: {
  patientId: string;
  entryId: string | null;
}) {
  if (!entryId) {
    return (
      <aside className={styles.panel} aria-label="Context">
        <h2 className={styles.title}>Context</h2>
        <p className={styles.state}>Select a timeline entry to inspect its context.</p>
      </aside>
    );
  }
  return <ContextPanelDetail key={entryId} patientId={patientId} entryId={entryId} />;
}

function ContextPanelDetail({
  patientId,
  entryId,
}: {
  patientId: string;
  entryId: string;
}) {
  const [entryStatus, setEntryStatus] = useState<EntryStatus>(() =>
    getToken() ? "loading" : "error",
  );
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [highlightsStatus, setHighlightsStatus] = useState<HighlightsStatus>(() =>
    getToken() ? "loading" : "error",
  );
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;

    fetch(`/api/timeline/${entryId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          setEntryStatus("forbidden");
          return;
        }
        if (res.status === 404) {
          setEntryStatus("notfound");
          return;
        }
        if (!res.ok) {
          setEntryStatus("error");
          return;
        }
        const data = (await res.json()) as EntryDetail;
        setEntry(data);
        setEntryStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setEntryStatus("error");
      });

    // Patient-level Highlight GET — no entryId filter exists server-side,
    // so the authorized list is fetched once and filtered to this entry
    // client-side (a presentation subset of already-authorized data).
    fetch(`/api/patients/${patientId}/highlights`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setHighlightsStatus("error");
          return;
        }
        const data = (await res.json()) as Highlight[];
        setHighlights(data.filter((h) => h.entryId === entryId));
        setHighlightsStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setHighlightsStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [entryId, patientId]);

  if (entryStatus === "loading") {
    return (
      <aside className={styles.panel} aria-label="Context">
        <h2 className={styles.title}>Context</h2>
        <p className={styles.state} role="status">
          Loading context…
        </p>
      </aside>
    );
  }
  if (entryStatus === "forbidden") {
    return (
      <aside className={styles.panel} aria-label="Context">
        <h2 className={styles.title}>Context</h2>
        <p className={styles.state}>You do not have access to this entry.</p>
      </aside>
    );
  }
  if (entryStatus === "notfound") {
    return (
      <aside className={styles.panel} aria-label="Context">
        <h2 className={styles.title}>Context</h2>
        <p className={styles.state}>Entry not found.</p>
      </aside>
    );
  }
  if (entryStatus === "error" || !entry) {
    return (
      <aside className={styles.panel} aria-label="Context">
        <h2 className={styles.title}>Context</h2>
        <p className={styles.state}>Unable to load entry context.</p>
      </aside>
    );
  }

  const classification = classify(entry);
  const section = sectionLabel(entry.sectionKey);
  const hasProvenance = entry.provenanceType !== "none";

  return (
    <aside className={styles.panel} aria-label="Context">
      <h2 className={styles.title}>Context</h2>
      <p className={styles.type}>{typeLabel(entry, classification)}</p>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Content</h3>
        <p className={styles.content}>{entry.content}</p>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Metadata</h3>
        <dl className={styles.metaList}>
          {section && (
            <>
              <dt>Section</dt>
              <dd>{section}</dd>
            </>
          )}
          <dt>Author role</dt>
          <dd>{capitalize(entry.authorRole)}</dd>
          <dt>Version</dt>
          <dd>{entry.versionNumber}</dd>
          <dt>Created</dt>
          <dd>{formatDateTime(entry.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{formatDateTime(entry.updatedAt)}</dd>
        </dl>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Source</h3>
        {hasProvenance ? (
          <>
            <p className={styles.content}>
              {PROVENANCE_LABELS[entry.provenanceType] ?? entry.provenanceType}
            </p>
            {entry.provenanceId && (
              <p className={styles.meta}>Session ID: {entry.provenanceId}</p>
            )}
          </>
        ) : (
          <p className={styles.state}>No linked source metadata.</p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Highlights</h3>
        {highlightsStatus === "loading" && (
          <p className={styles.state} role="status">
            Loading highlights…
          </p>
        )}
        {highlightsStatus === "error" && (
          <p className={styles.state}>Unable to load highlights for this entry.</p>
        )}
        {highlightsStatus === "ok" && highlights.length === 0 && (
          <p className={styles.state}>No highlights linked to this entry.</p>
        )}
        {highlightsStatus === "ok" && highlights.length > 0 && (
          <ul className={styles.highlightList}>
            {highlights.map((h) => (
              <li key={h.id} className={styles.highlightItem}>
                <p className={styles.quote}>&ldquo;{h.quotedText}&rdquo;</p>
                <p className={styles.reason}>{h.riskReason}</p>
                <p className={styles.meta}>Importance: {h.importance}</p>
                <p className={styles.meta}>Highlight feedback: {capitalize(h.feedback)}</p>
                <p className={styles.meta}>{exactQuoteStatus(h)}</p>
                {hasProvenance && (
                  <p className={styles.meta}>Linked to the selected entry&apos;s source.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
