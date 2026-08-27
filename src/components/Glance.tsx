"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth-client";
import styles from "./Glance.module.css";

// Mirrors GET /api/patients/:id/glance exactly (re-confirmed against the
// current route this block) — nothing here is inferred from an older
// report. riskFloor is runtime-derived (classifyRiskFloor), not a stored
// column; it is either "critical" or "unrated" and nothing else.
interface OpenAction {
  commentId: string;
  timelineEntryId: string;
  content: string;
  assignedToId: string | null;
  createdAt: string;
}
interface RiskHighlight {
  id: string;
  entryId: string;
  quotedText: string;
  riskReason: string;
  importance: number;
  feedback: string;
  riskFloor: "critical" | "unrated";
}
interface RecentChange {
  entryId: string;
  type: string;
  sectionKey: string | null;
  content: string;
  updatedAt: string;
}
interface GlanceData {
  patientId: string;
  displayName: string;
  openActions: OpenAction[];
  riskHighlights: RiskHighlight[];
  recentChanges: RecentChange[];
}

type Status = "loading" | "ok" | "forbidden" | "notfound" | "error";

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "Yesterday";
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Purely presentational label from already-returned sectionKey/type —
// formats real data, invents nothing. sectionKey is preferred (more
// specific); type is the fallback for the two sectionKey=null entry
// types (patient_session_summary, ai_patient_session_summary).
function describeEntry(entry: RecentChange): string {
  if (entry.sectionKey) {
    const readable = entry.sectionKey.replace(/_/g, " ");
    return `${readable.charAt(0).toUpperCase()}${readable.slice(1)} updated`;
  }
  if (entry.type === "ai_patient_session_summary") return "AI patient summary updated";
  if (entry.type === "patient_session_summary") return "Patient entry updated";
  return "Entry updated";
}

export default function Glance({
  patientId,
  // Monotonic integer owned by the patient workspace. It is bumped ONLY
  // after a server-confirmed mutation that changes Glance-derived data
  // (an unresolved comment created / resolved / reopened, or a Timeline
  // entry edited / reverted). Each bump re-runs the fetch effect below;
  // the previous run's cleanup sets its own `cancelled` flag first, so an
  // older in-flight response can never overwrite a newer one — this covers
  // both patient-switch and same-patient overlapping-refresh races without
  // an AbortController. Assignment-only, mention, Highlight-feedback, and
  // every read-only action never touch this key.
  refreshKey = 0,
}: {
  patientId: string;
  refreshKey?: number;
}) {
  // Lazy initializer, not a setState-in-effect: if there's no token at
  // mount, status starts (and stays) "error" without the effect ever
  // needing to set it. In practice Glance only renders inside AppShell,
  // which already confirmed a valid token before rendering children.
  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "error"));
  const [data, setData] = useState<GlanceData | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetch(`/api/patients/${patientId}/glance`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 403) {
          setStatus("forbidden");
          return;
        }
        if (res.status === 404) {
          setStatus("notfound");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as GlanceData;
        setData(json);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
    // patientId + refreshKey are both primitives — no unstable object/
    // callback in the dependency list, so this cannot loop.
  }, [patientId, refreshKey]);

  if (status === "loading") {
    return (
      <p className={styles.state} role="status">
        Loading Glance…
      </p>
    );
  }
  if (status === "forbidden") {
    return <p className={styles.state}>You do not have access to this patient&apos;s Glance.</p>;
  }
  if (status === "notfound") {
    return <p className={styles.state}>Glance is unavailable for this patient.</p>;
  }
  if (status === "error" || !data) {
    return <p className={styles.state}>Unable to load Glance.</p>;
  }

  const critical = data.riskHighlights.filter((h) => h.riskFloor === "critical");
  const otherHighlightsCount = data.riskHighlights.length - critical.length;
  const recentChanges = data.recentChanges.slice(0, 3);
  const openActions = data.openActions.slice(0, 4);
  const lastUpdate = data.recentChanges[0]?.updatedAt;

  return (
    <section className={styles.glance} aria-label="Glance">
      <h2 className={styles.title}>Glance</h2>
      <div className={styles.grid}>
        <div className={`${styles.block} ${styles.primary}`}>
          <h3 className={styles.blockTitle}>
            Critical Risks{critical.length > 0 ? ` · ${critical.length}` : ""}
          </h3>
          {critical.length === 0 ? (
            <p className={styles.empty}>No deterministic critical triggers matched.</p>
          ) : (
            <ul className={styles.riskList}>
              {critical.map((h) => (
                <li key={h.id} className={styles.riskItem}>
                  <span className={styles.riskLabel}>Critical</span>
                  <p className={styles.riskQuote}>&ldquo;{h.quotedText}&rdquo;</p>
                  <p className={styles.riskReason}>{h.riskReason}</p>
                </li>
              ))}
            </ul>
          )}
          {otherHighlightsCount > 0 && (
            <p className={styles.subnote}>Other highlights: {otherHighlightsCount}</p>
          )}
        </div>

        <div className={`${styles.block} ${styles.primary}`}>
          <h3 className={styles.blockTitle}>
            Open Actions{data.openActions.length > 0 ? ` · ${data.openActions.length}` : ""}
          </h3>
          <p className={styles.blockSubtitle}>Unresolved comments</p>
          {data.openActions.length === 0 ? (
            <p className={styles.empty}>No open actions.</p>
          ) : (
            <ul className={styles.actionList}>
              {openActions.map((a) => (
                <li key={a.commentId} className={styles.actionItem}>
                  {a.content}
                </li>
              ))}
            </ul>
          )}
          {data.openActions.length > openActions.length && (
            <p className={styles.subnote}>+{data.openActions.length - openActions.length} more</p>
          )}
        </div>

        <div className={styles.block}>
          <h3 className={styles.blockTitle}>Recent Changes</h3>
          <p className={styles.blockSubtitle}>By last edit time</p>
          {recentChanges.length === 0 ? (
            <p className={styles.empty}>No recent changes.</p>
          ) : (
            <ul className={styles.changeList}>
              {recentChanges.map((c) => (
                <li key={c.entryId} className={styles.changeItem}>
                  <span>{describeEntry(c)}</span>
                  <span className={styles.changeTime}>{formatRelative(c.updatedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.block}>
          <h3 className={styles.blockTitle}>Last Update</h3>
          <p className={styles.lastUpdate}>
            {lastUpdate ? formatRelative(lastUpdate) : "No recent updates"}
          </p>
        </div>
      </div>
    </section>
  );
}
