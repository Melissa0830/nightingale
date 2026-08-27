"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth-client";
import { useAuthIdentity } from "./AppShell";
import CommentsSection from "./CommentsSection";
import VersionHistory from "./VersionHistory";
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
// recomputed here. The adaptive* fields are the Bonus read-time
// derivation: importance stays the base importance, effectiveImportance =
// importance + learnedAdjustment, counts are same-clinic same-normalized-
// riskReason accept/reject totals. Nothing here is recomputed client-side.
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
  riskFloor: "critical" | "unrated";
  acceptedCount: number;
  rejectedCount: number;
  feedbackCount: number;
  reviewCount: number;
  acceptanceRate: number | null;
  learningStatus: "no_feedback" | "gathering_feedback" | "adaptive";
  learnedAdjustment: number;
  effectiveImportance: number;
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

// ─── Adaptive-priority presentation (v2) ────────────────────────────────
// Wording boundary: "adaptive priority" reflects accumulated clinician
// accept/reject feedback on a recurring risk-reason pattern in this clinic.
// It is never described as AI learning, clinical confidence, verification,
// or a change in clinical risk. riskFloor is shown separately and is
// authoritative.
function learningStatusLabel(status: Highlight["learningStatus"]): string {
  if (status === "adaptive") return "Adaptive";
  if (status === "gathering_feedback") return "Gathering feedback";
  return "No feedback";
}

function adaptivePriorityText(h: Highlight): string {
  if (h.learnedAdjustment > 0) return `${h.effectiveImportance} ↑`;
  if (h.learnedAdjustment < 0) return `${h.effectiveImportance} ↓`;
  return `${h.effectiveImportance}`;
}

function adjustmentText(adjustment: number): string {
  if (adjustment > 0) return `+${adjustment}`;
  return `${adjustment}`;
}

function feedbackEvidenceText(h: Highlight): string {
  if (h.reviewCount === 0) return "No clinician reviews yet";
  const reviews = `${h.reviewCount} clinician review${h.reviewCount === 1 ? "" : "s"}`;
  if (h.acceptanceRate === null) return reviews;
  return `${reviews} · ${Math.round(h.acceptanceRate * 100)}% accepted`;
}

function adaptiveExplanation(h: Highlight): string {
  if (h.learnedAdjustment > 0) {
    return "Priority increased based on recurring clinician feedback in this clinic.";
  }
  if (h.learnedAdjustment < 0) {
    return "Priority decreased based on recurring clinician feedback in this clinic.";
  }
  if (h.learningStatus === "gathering_feedback") {
    return "Minimum 3 reviewed examples required before adaptive adjustment.";
  }
  return "No clinician feedback recorded for this recurring pattern yet.";
}

// Route-confirmed section ownership (src/lib/auth/section-ownership.ts).
// Mirrored here for control visibility only — the backend remains
// authoritative and re-checks on every PUT/revert. Fail closed: unknown
// or null sectionKey → no owner → no edit/revert controls.
const SECTION_OWNER: Readonly<Record<string, "Staff" | "Clinician">> = {
  staff_note: "Staff",
  plan: "Clinician",
  summary: "Clinician",
  medication: "Clinician",
};

function roleCanEditSection(role: string, sectionKey: string | null): boolean {
  if (!sectionKey) return false;
  const owner = SECTION_OWNER[sectionKey];
  return owner !== undefined && role === owner;
}

// Top-level component only decides idle-vs-selected. The actual fetching
// component below is keyed by entryId, so selecting a different entry
// (or deselecting then reselecting) always mounts a fresh instance with
// its own fresh initial state — no manual "reset to idle" branch is
// needed inside an effect for that transition.
export default function ContextPanel({
  patientId,
  entryId,
  onEntryMutated,
}: {
  patientId: string;
  entryId: string | null;
  // Called after a successful edit/revert so the parent can refresh the
  // Timeline (which fetches its own list). No global event bus.
  onEntryMutated: () => void;
}) {
  if (!entryId) {
    return (
      <aside className={styles.panel} aria-label="Context">
        <h2 className={styles.title}>Context</h2>
        <p className={styles.state}>Select a timeline entry to inspect its context.</p>
      </aside>
    );
  }
  return (
    <ContextPanelDetail
      key={entryId}
      patientId={patientId}
      entryId={entryId}
      onEntryMutated={onEntryMutated}
    />
  );
}

function ContextPanelDetail({
  patientId,
  entryId,
  onEntryMutated,
}: {
  patientId: string;
  entryId: string;
  onEntryMutated: () => void;
}) {
  const identity = useAuthIdentity();
  const [entryStatus, setEntryStatus] = useState<EntryStatus>(() =>
    getToken() ? "loading" : "error",
  );
  const [entry, setEntry] = useState<EntryDetail | null>(null);
  const [highlightsStatus, setHighlightsStatus] = useState<HighlightsStatus>(() =>
    getToken() ? "loading" : "error",
  );
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  // Local refetch trigger. Bumped after a successful edit/revert so the
  // selected entry, its highlights, and the Version History list all
  // refresh — the smallest mechanism, scoped to this panel.
  const [localRefresh, setLocalRefresh] = useState(0);

  // Edit buffer state — kept local to this panel (or lifted no higher).
  // selectedEntryId stays owned by PatientDetailContent.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The versionNumber captured when edit mode was entered. Sent verbatim as
  // expectedVersion on Save — never refreshed just before the request, so a
  // stale write is genuinely detectable as a 409.
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "error">("idle");
  const [conflict, setConflict] = useState(false);

  // Highlight Accept/Reject mutation state — local to this panel, keyed by
  // the individual Highlight id so only the affected row disables/shows an
  // error. Feedback records a clinician's decision on the Highlight signal
  // only; it is never an approval of the underlying entry, and never touches
  // importance or riskFloor.
  const [updatingHighlightId, setUpdatingHighlightId] = useState<string | null>(null);
  const [feedbackErrorId, setFeedbackErrorId] = useState<string | null>(null);

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
  }, [entryId, patientId, localRefresh]);

  // All handlers below run only from user events, never an effect body.
  function startEdit(current: EntryDetail) {
    setDraft(current.content);
    setLoadedVersion(current.versionNumber);
    setConflict(false);
    setSaveState("idle");
    setIsEditing(true);
  }

  function cancelEdit() {
    setIsEditing(false);
    setDraft("");
    setConflict(false);
    setSaveState("idle");
  }

  async function handleSave() {
    const token = getToken();
    if (!token || loadedVersion === null || draft.trim().length === 0) return;
    setSaveState("saving");
    setConflict(false);
    try {
      const res = await fetch(`/api/timeline/${entryId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content: draft, expectedVersion: loadedVersion }),
      });
      if (res.status === 409) {
        // Stale write. The backend rejected it — nothing was merged, nothing
        // overwritten. Keep the draft and the stale loadedVersion; stay in
        // edit mode; wait for an explicit Reload latest.
        setConflict(true);
        setSaveState("idle");
        return;
      }
      if (!res.ok) {
        setSaveState("error");
        return;
      }
      setIsEditing(false);
      setDraft("");
      setSaveState("idle");
      setLocalRefresh((n) => n + 1);
      onEntryMutated();
    } catch {
      setSaveState("error");
    }
  }

  async function handleReloadLatest() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`/api/timeline/${entryId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        setSaveState("error");
        return;
      }
      const fresh = (await res.json()) as EntryDetail;
      setEntry(fresh);
      setDraft(fresh.content);
      setLoadedVersion(fresh.versionNumber);
      setConflict(false);
      setSaveState("idle");
      // Refresh highlights + Version History against the now-current entry.
      setLocalRefresh((n) => n + 1);
    } catch {
      setSaveState("error");
    }
  }

  // Clinician-only (PATCH /api/highlights/:id is 403 for every other role).
  // Non-optimistic: disable the row's controls, PATCH, then on success reuse
  // the Block 7 localRefresh mechanism to re-fetch the authorized Highlight
  // list and render canonical server state. On failure keep the previous
  // state and show a local error under that Highlight only.
  async function handleHighlightFeedback(
    highlightId: string,
    feedback: "accepted" | "rejected",
  ) {
    const token = getToken();
    if (!token) return;
    setUpdatingHighlightId(highlightId);
    setFeedbackErrorId(null);
    try {
      const res = await fetch(`/api/highlights/${highlightId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ feedback }),
      });
      if (!res.ok) {
        setFeedbackErrorId(highlightId);
        return;
      }
      setLocalRefresh((n) => n + 1);
    } catch {
      setFeedbackErrorId(highlightId);
    } finally {
      setUpdatingHighlightId(null);
    }
  }

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

  // Control visibility from auth identity + route-confirmed ownership only.
  // Admin is read-only for clinical sections (PUT/revert both 403 Admin), so
  // it never gets Edit/Revert — just inspection and history. Patient never
  // reaches this component at all (see patients/[id]/page.tsx).
  const canEdit =
    identity.role !== "Admin" && roleCanEditSection(identity.role, entry.sectionKey);

  // The one reachable Clinician-override case: a Clinician editing an entry
  // the backend will flag as a conflict (AI-scribed, or Patient/system
  // authored) that has ALREADY passed section ownership. For entries that
  // fail ownership first (e.g. sectionKey=null patient summaries) canEdit is
  // false, so no override wording is shown — matching route reachability.
  const isOverrideEntry =
    canEdit &&
    identity.role === "Clinician" &&
    (entry.type === "ai_doctor_consult_summary" ||
      entry.type === "ai_nurse_consult_summary" ||
      entry.authorRole === "Patient" ||
      entry.authorRole === "system");

  return (
    <aside className={styles.panel} aria-label="Context">
      <h2 className={styles.title}>Context</h2>
      <p className={styles.type}>{typeLabel(entry, classification)}</p>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Content</h3>
        {!isEditing && <p className={styles.content}>{entry.content}</p>}
        {!isEditing && canEdit && (
          <button type="button" className={styles.editButton} onClick={() => startEdit(entry)}>
            Edit
          </button>
        )}
        {isEditing && (
          <div className={styles.editor}>
            {isOverrideEntry && (
              <p className={styles.overrideNotice}>
                This entry is AI-scribed. Saving your edit replaces the current
                AI-scribed entry state and records a conflict event for clinician
                review. It does not mark the AI summary as verified.
              </p>
            )}
            <textarea
              className={styles.textarea}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              aria-label="Edit entry content"
            />
            {conflict && (
              <div className={styles.conflictBanner} role="alert">
                <p>This entry changed after you opened it.</p>
                <p>Your draft was not saved.</p>
                <button
                  type="button"
                  className={styles.reloadButton}
                  onClick={handleReloadLatest}
                >
                  Reload latest
                </button>
              </div>
            )}
            {saveState === "error" && (
              <p className={styles.error}>
                Unable to save. Check your connection and try again.
              </p>
            )}
            <div className={styles.editActions}>
              <button
                type="button"
                className={styles.saveButton}
                disabled={saveState === "saving" || draft.trim().length === 0}
                onClick={handleSave}
              >
                {saveState === "saving" ? "Saving…" : "Save"}
              </button>
              <button type="button" className={styles.cancelButton} onClick={cancelEdit}>
                Cancel
              </button>
            </div>
          </div>
        )}
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

                <dl className={styles.adaptiveList}>
                  <dt>Safety floor</dt>
                  <dd>{capitalize(h.riskFloor)}</dd>
                  <dt>Base importance</dt>
                  <dd>{h.importance}</dd>
                  <dt>Adaptive priority</dt>
                  <dd>{adaptivePriorityText(h)}</dd>
                  <dt>Learning status</dt>
                  <dd>{learningStatusLabel(h.learningStatus)}</dd>
                  <dt>Feedback evidence</dt>
                  <dd>{feedbackEvidenceText(h)}</dd>
                  <dt>Adjustment</dt>
                  <dd>{adjustmentText(h.learnedAdjustment)}</dd>
                </dl>
                <p className={styles.adaptiveNote}>{adaptiveExplanation(h)}</p>

                <div className={styles.feedbackLine}>
                  <span className={styles.meta}>Feedback: {capitalize(h.feedback)}</span>
                  {identity.role === "Clinician" && (
                    <>
                      {h.feedback !== "accepted" && (
                        <button
                          type="button"
                          className={styles.feedbackButton}
                          disabled={updatingHighlightId === h.id}
                          onClick={() => handleHighlightFeedback(h.id, "accepted")}
                        >
                          Accept
                        </button>
                      )}
                      {h.feedback !== "rejected" && (
                        <button
                          type="button"
                          className={styles.feedbackButton}
                          disabled={updatingHighlightId === h.id}
                          onClick={() => handleHighlightFeedback(h.id, "rejected")}
                        >
                          Reject
                        </button>
                      )}
                    </>
                  )}
                </div>
                {feedbackErrorId === h.id && (
                  <p className={styles.feedbackError}>Unable to update highlight feedback.</p>
                )}
                <p className={styles.meta}>{exactQuoteStatus(h)}</p>
                {hasProvenance && (
                  <p className={styles.meta}>Linked to the selected entry&apos;s source.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CommentsSection entryId={entryId} />

      <VersionHistory
        entryId={entryId}
        canRevert={canEdit}
        isOverrideEntry={isOverrideEntry}
        refreshKey={localRefresh}
        onReverted={() => {
          setLocalRefresh((n) => n + 1);
          onEntryMutated();
        }}
      />
    </aside>
  );
}
