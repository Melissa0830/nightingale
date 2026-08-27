"use client";

import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth-client";
import { buildWordDiff, hasContentChanges } from "@/lib/diff/word-diff";
import styles from "./VersionHistory.module.css";

// Mirrors GET /api/timeline/:id/versions exactly (re-confirmed against the
// current route this block): the Version table holds only HISTORICAL
// (superseded) snapshots — the live version is reported separately via
// currentVersionNumber/currentContent and is never present in `versions`.
// v1 with no edits therefore returns `versions: []`.
interface VersionRow {
  id: string;
  versionNumber: number;
  content: string;
  editorId: string | null;
  createdAt: string;
}
interface VersionsResponse {
  entryId: string;
  currentVersionNumber: number;
  currentContent: string;
  versions: VersionRow[];
}

type Status = "loading" | "ok" | "error";

// Same en-GB/24h convention used elsewhere in the workspace.
function formatDateTime(iso: string): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${day} · ${time}`;
}

interface VersionHistoryProps {
  entryId: string;
  // True only where the backend PUT/revert route would actually permit this
  // role to write this section (route-confirmed ownership). Admin and
  // null-section entries never get Revert controls.
  canRevert: boolean;
  // True only for the reachable Clinician-override case: a Clinician editing
  // an entry the backend flags as a conflict (AI-scribed, or Patient/system
  // authored) AND that already passed section ownership. Used for wording
  // only — the backend detects override automatically, there is no flag.
  isOverrideEntry: boolean;
  // Bumped by the parent after a successful edit/revert so this list refetches.
  refreshKey: number;
  onReverted: () => void;
}

export default function VersionHistory({
  entryId,
  canRevert,
  isOverrideEntry,
  refreshKey,
  onReverted,
}: VersionHistoryProps) {
  const [status, setStatus] = useState<Status>(() => (getToken() ? "loading" : "error"));
  const [data, setData] = useState<VersionsResponse | null>(null);
  // Local-only refetch trigger for the explicit "Reload latest" action after
  // a revert conflict — kept separate from the parent's refreshKey.
  const [reloadNonce, setReloadNonce] = useState(0);
  const [confirmingVersion, setConfirmingVersion] = useState<number | null>(null);
  const [revertState, setRevertState] = useState<"idle" | "reverting" | "error">("idle");
  const [conflict, setConflict] = useState(false);
  // Which historical version is currently being compared to the live entry.
  // Read-only view state — comparing never calls the network (the snapshot
  // and current content are both already in `data`) and never mutates.
  const [comparingVersion, setComparingVersion] = useState<number | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    let cancelled = false;
    fetch(`/api/timeline/${entryId}/versions`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setStatus("error");
          return;
        }
        const json = (await res.json()) as VersionsResponse;
        setData(json);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [entryId, refreshKey, reloadNonce]);

  // Called only from an event handler (never an effect body) — a plain
  // async helper, not subject to the set-state-in-effect rule.
  async function handleConfirmRevert(targetVersion: number) {
    const token = getToken();
    if (!token || !data) return;
    setRevertState("reverting");
    setConflict(false);
    try {
      const res = await fetch(`/api/timeline/${entryId}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        // targetVersion is the historical versionNumber; expectedVersion is
        // the live version this history view was loaded against. OCC still
        // catches any write that lands between that load and this POST.
        body: JSON.stringify({
          targetVersion,
          expectedVersion: data.currentVersionNumber,
        }),
      });
      if (res.status === 409) {
        setConflict(true);
        setRevertState("idle");
        setConfirmingVersion(null);
        return;
      }
      if (!res.ok) {
        setRevertState("error");
        return;
      }
      setRevertState("idle");
      setConfirmingVersion(null);
      // Parent bumps refreshKey, which refetches this list too.
      onReverted();
    } catch {
      setRevertState("error");
    }
  }

  if (status === "loading") {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Version History</h3>
        <p className={styles.state} role="status">
          Loading version history…
        </p>
      </section>
    );
  }
  if (status === "error" || !data) {
    return (
      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Version History</h3>
        <p className={styles.state}>Unable to load version history.</p>
      </section>
    );
  }

  // Newest historical snapshot first. The live version is shown above the
  // list and is never synthesised into it.
  const history = [...data.versions].sort((a, b) => b.versionNumber - a.versionNumber);

  // Defensive: only honour the comparison selection if that historical
  // version is still present after the latest refetch. Historical versions
  // are immutable and monotonic, so this only clears on an entry switch —
  // but the derive keeps a stale number from ever rendering a broken box.
  const activeCompareVersion =
    comparingVersion !== null &&
    history.some((v) => v.versionNumber === comparingVersion)
      ? comparingVersion
      : null;

  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Version History</h3>

      <p className={styles.current}>Current · v{data.currentVersionNumber}</p>

      {conflict && (
        <div className={styles.conflictBanner} role="alert">
          <p>This entry changed after you opened it.</p>
          <p>Your revert was not applied.</p>
          <button
            type="button"
            className={styles.revertButton}
            onClick={() => {
              setConflict(false);
              setReloadNonce((n) => n + 1);
            }}
          >
            Reload latest
          </button>
        </div>
      )}

      {history.length === 0 ? (
        <p className={styles.state}>No previous versions.</p>
      ) : (
        <ul className={styles.list}>
          {history.map((v) => (
            <li key={v.id} className={styles.row}>
              <p className={styles.rowHead}>
                v{v.versionNumber} · {formatDateTime(v.createdAt)}
              </p>
              <p className={styles.preview}>{v.content}</p>
              {v.editorId && <p className={styles.meta}>Editor: {v.editorId}</p>}

              <button
                type="button"
                className={styles.compareButton}
                aria-expanded={activeCompareVersion === v.versionNumber}
                onClick={() =>
                  setComparingVersion((prev) =>
                    prev === v.versionNumber ? null : v.versionNumber,
                  )
                }
              >
                {activeCompareVersion === v.versionNumber
                  ? "Hide changes"
                  : `View changes since v${v.versionNumber}`}
              </button>

              {activeCompareVersion === v.versionNumber && (
                <VersionDiff
                  fromVersion={v.versionNumber}
                  currentVersionNumber={data.currentVersionNumber}
                  oldContent={v.content}
                  currentContent={data.currentContent}
                />
              )}

              {canRevert && confirmingVersion === v.versionNumber && (
                <div className={styles.confirmBox}>
                  <p className={styles.confirmText}>
                    Revert current entry to version {v.versionNumber}?
                  </p>
                  <p className={styles.confirmText}>
                    The current state will remain in version history.
                  </p>
                  {isOverrideEntry && (
                    <p className={styles.overrideNotice}>
                      Reverting this AI-scribed entry records a conflict event for
                      clinician review. It does not mark the AI summary as verified.
                    </p>
                  )}
                  <div className={styles.confirmActions}>
                    <button
                      type="button"
                      className={styles.cancelButton}
                      disabled={revertState === "reverting"}
                      onClick={() => setConfirmingVersion(null)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={styles.confirmButton}
                      disabled={revertState === "reverting"}
                      onClick={() => handleConfirmRevert(v.versionNumber)}
                    >
                      {revertState === "reverting" ? "Reverting…" : "Confirm revert"}
                    </button>
                  </div>
                </div>
              )}

              {canRevert && confirmingVersion !== v.versionNumber && (
                <button
                  type="button"
                  className={styles.revertButton}
                  onClick={() => {
                    setConflict(false);
                    setRevertState("idle");
                    setConfirmingVersion(v.versionNumber);
                  }}
                >
                  Revert to v{v.versionNumber}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {revertState === "error" && (
        <p className={styles.error}>Unable to revert. Check your connection and try again.</p>
      )}
    </section>
  );
}

// Read-only word-level comparison: the selected historical snapshot →
// the current live content. Direction is fixed (old → current): an <ins>
// run is text the current note has that the snapshot did not; a <del> run
// is text the snapshot had that the current note dropped. Colour is only a
// secondary cue — the <ins>/<del> elements and the visually-hidden
// "Added"/"Removed" labels carry the meaning on their own.
function VersionDiff({
  fromVersion,
  currentVersionNumber,
  oldContent,
  currentContent,
}: {
  fromVersion: number;
  currentVersionNumber: number;
  oldContent: string;
  currentContent: string;
}) {
  const parts = buildWordDiff(oldContent, currentContent);

  return (
    <div className={styles.diffBox}>
      <p className={styles.diffCaption}>
        Changes since v{fromVersion} → Current · v{currentVersionNumber}
      </p>
      {hasContentChanges(parts) ? (
        <p className={styles.diffText}>
          {parts.map((part, i) => {
            if (part.kind === "added") {
              return (
                <ins key={i} className={styles.diffAdded}>
                  <span className={styles.srOnly}>Added: </span>
                  {part.value}
                </ins>
              );
            }
            if (part.kind === "removed") {
              return (
                <del key={i} className={styles.diffRemoved}>
                  <span className={styles.srOnly}>Removed: </span>
                  {part.value}
                </del>
              );
            }
            return <span key={i}>{part.value}</span>;
          })}
        </p>
      ) : (
        <p className={styles.diffEmpty}>No content differences.</p>
      )}
    </div>
  );
}
